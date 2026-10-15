// Alerts edge function — sends the Telegram alerts.
//
// CALLERS (all must carry {cronSecret} = vault alerts_cron_secret):
//  - pg_cron every 5 minutes: plan and send what's due for each linked user.
//  - the telegram function: {mode:"today", userId} for /today, and
//    {mode:"done", userId, key} when Ben taps Done.
//  - by hand: {dryRun:true, userId} returns what would go out, sends nothing.
//
// Every message's alert_log row is CLAIMED before the send (insert, or flip a
// snoozed/failed row), so two overlapping ticks can never send the same thing.
// A failed read ends the tick: a failed read is never an empty list.
// verify_jwt=false at the gateway; the cron secret is checked here.

import {
  planAlerts, readSettings, localClock, addSteps,
  type Alert, type Block, type DayItem, type Deadline, type LogRow,
} from "./plan.ts";
import { tickBlockItem, newItemId } from "./items.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SVC = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const OR_BASE = "https://openrouter.ai/api/v1";
const D_FAST = "google/gemini-2.5-flash-lite";

type C = Record<string, unknown>;
type SettingsRow = { user_id: string; telegram: C | null; ai_models: C | null };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const enc = encodeURIComponent;

async function secretOf(name: string): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, { method: "POST", headers: SVC, body: JSON.stringify({ secret_name: name }) });
    return r.ok ? ((await r.json()) as string | null) ?? "" : "";
  } catch { return ""; }
}

async function get<T>(q: string): Promise<T[] | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: SVC });
    if (!r.ok) { console.error(`[alerts] read ${q.split("?")[0]} ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
    return (await r.json()) as T[];
  } catch (e) { console.error(`[alerts] read ${q.split("?")[0]}`, e instanceof Error ? e.message : e); return null; }
}

// POST/PATCH as the service role. null = failed; [] = nothing matched/inserted.
async function rest(method: "POST" | "PATCH", q: string, body: unknown, prefer = "return=representation"): Promise<C[] | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { method, headers: { ...SVC, Prefer: prefer }, body: JSON.stringify(body) });
    if (!r.ok) { console.error(`[alerts] ${method} ${q.split("?")[0]} ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
    const t = await r.text();
    return t ? (JSON.parse(t) as C[]) : [];
  } catch (e) { console.error(`[alerts] ${method} ${q.split("?")[0]}`, e instanceof Error ? e.message : e); return null; }
}

async function tg(token: string, method: string, body: C): Promise<{ ok: boolean; status: number; result?: C }> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    return { ok: !!d.ok, status: r.status, result: d.result };
  } catch { return { ok: false, status: 0 }; }
}

const keyboard = (a: Alert) => ({
  inline_keyboard: a.buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))),
});

// One cheap model call per morning: a first physical step for each top-3 item.
// Any failure means no steps — the plan still goes out.
async function firstSteps(top3: string[], aiModels: C | null): Promise<string[]> {
  if (!top3.length) return [];
  const key = await secretOf("anthropic_api_key");
  if (!key) return [];
  const sys = "For each task the user lists, write the first small physical step, under 2 minutes, that gets it started, like \"Open MyMathLab and read problem 1\". Reply with exactly one line per task, in the same order, at most 12 words each, no numbering, nothing else.";
  const user = top3.map((t, i) => `${i + 1}. ${t}`).join("\n");
  try {
    let text = "";
    if (key.startsWith("sk-or-")) {
      const m = aiModels?.fast;
      const model = typeof m === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(m) ? m : D_FAST;
      const r = await fetch(`${OR_BASE}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
      });
      if (!r.ok) { console.error(`[alerts] steps ${r.status}`); return []; }
      text = String((await r.json())?.choices?.[0]?.message?.content ?? "");
    } else {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 300, system: sys, messages: [{ role: "user", content: user }] }),
      });
      if (!r.ok) { console.error(`[alerts] steps ${r.status}`); return []; }
      const d = await r.json();
      text = (d.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    }
    return text.split("\n").map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean).slice(0, top3.length);
  } catch (e) { console.error("[alerts] steps", e instanceof Error ? e.message : e); return []; }
}

async function tickUser(u: SettingsRow, token: string, opts: { dryRun: boolean; today: boolean }): Promise<C> {
  const s0 = readSettings(u.telegram);
  const s = opts.dryRun && s0.chat_id === null ? { ...s0, chat_id: 0 } : s0;
  if (s.chat_id === null) return { skipped: "not linked" };
  const now = new Date();
  const c = localClock(now, s.tz);
  const uid = u.user_id;
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const [blocks, nights, deadlines, log] = await Promise.all([
    get<Block>(`class_blocks?select=id,label,kind,location,start_t,end_t&user_id=eq.${uid}&weekday=eq.${c.weekday}&order=start_t`),
    get<{ items: unknown; top3: unknown }>(`nights?select=items,top3&user_id=eq.${uid}&day=eq.${c.day}`),
    get<Deadline>(`deadlines?select=id,title,course,kind,due_at,start_by,goal_id&user_id=eq.${uid}&done=eq.false&due_at=gte.${enc(since)}&order=due_at`),
    get<LogRow>(`alert_log?select=key,kind,state,snooze_until,tries,updated_at,meta&user_id=eq.${uid}&or=(day.eq.${c.day},state.eq.held)`),
  ]);
  if (!blocks || !nights || !deadlines || !log) return { skipped: "a read failed" };
  const night = nights[0];
  const input = {
    now, settings: s, deadlines, log,
    blocks: blocks.map((b) => ({ ...b, kind: b.kind ?? "class", location: b.location ?? "" })),
    items: Array.isArray(night?.items) ? (night.items as DayItem[]) : [],
    top3: Array.isArray(night?.top3) ? (night.top3 as string[]) : [],
  };

  let alerts = planAlerts(input);
  if (opts.today) {
    // /today: the plan as of right now, never quiet, never deduped against the morning one
    const hh = `${String(Math.floor(c.min / 60)).padStart(2, "0")}:${String(c.min % 60).padStart(2, "0")}`;
    const p = planAlerts({
      ...input,
      settings: { ...s, morning_at: hh, paused_until: null, quiet: { ...s.quiet, night: ["00:00", "00:00"] } },
      log: input.log.filter((r) => !r.key.startsWith("plan:")),
    }).find((a) => a.kind === "plan");
    alerts = p ? [{ ...p, key: `today:${c.day}:${c.min}`, absorbs: [] }] : [];
  }
  if (opts.dryRun) {
    return { day: c.day, min: c.min, alerts: alerts.map((a) => ({ key: a.key, kind: a.kind, action: a.action, silent: a.silent, text: a.text })) };
  }

  let sent = 0, held = 0;
  for (const a of alerts) {
    const existing = log.find((r) => r.key === a.key);
    const state = a.action === "hold" ? "held" : "sent";
    const stamp = new Date().toISOString();
    // claim the row first; only the tick that wins the write sends
    const claimed = existing
      ? await rest("PATCH", `alert_log?user_id=eq.${uid}&key=eq.${enc(a.key)}&state=eq.${existing.state}`,
          { state, snooze_until: null, updated_at: stamp, meta: { text: a.text } })
      : await rest("POST", "alert_log?on_conflict=user_id,key",
          { user_id: uid, key: a.key, kind: a.kind, day: c.day, ref_id: a.refId, state, meta: { text: a.text } },
          "return=representation,resolution=ignore-duplicates");
    if (!claimed || claimed.length === 0) continue;
    if (a.action === "hold") { held++; continue; }

    let text = a.text;
    if (a.kind === "plan" && a.top3.length) text = addSteps(text, a.top3, await firstSteps(a.top3, u.ai_models));
    const r = await tg(token, "sendMessage", {
      chat_id: s.chat_id, text, reply_markup: keyboard(a), disable_notification: a.silent,
      link_preview_options: { is_disabled: true },
    });
    const row = `alert_log?user_id=eq.${uid}&key=eq.${enc(a.key)}`;
    if (r.ok) {
      sent++;
      await rest("PATCH", row, { tg_message_id: r.result?.message_id ?? null, meta: { text } }, "return=minimal");
      if (a.absorbs.length) {
        const keys = a.absorbs.map((k) => enc(`"${k}"`)).join(",");
        await rest("PATCH", `alert_log?user_id=eq.${uid}&state=eq.held&key=in.(${keys})`, { state: "sent", updated_at: stamp }, "return=minimal");
      }
    } else if (r.status === 403) {
      // the bot was blocked or the chat is gone: stop, and let the app say "connect again"
      await rest("PATCH", row, { state: "failed", updated_at: stamp }, "return=minimal");
      await rest("PATCH", `user_settings?user_id=eq.${uid}`, { telegram: { ...(u.telegram ?? {}), chat_id: null, blocked: true } }, "return=minimal");
      return { day: c.day, min: c.min, sent, held, blocked: true };
    } else {
      await rest("PATCH", row, { state: r.status === 429 ? "held" : "failed", tries: (existing?.tries ?? 0) + 1, updated_at: stamp }, "return=minimal");
    }
  }
  return { day: c.day, min: c.min, sent, held };
}

// Done from a Telegram button: tick the block on today's Card, or close the deadline.
async function applyDone(uid: string, key: string, tz: string): Promise<C> {
  const [kind, ref, day] = key.split(":");
  if (!isUuid(ref ?? "")) return { error: "bad key" };
  const stamp = new Date().toISOString();
  if (kind === "block") {
    const c = localClock(new Date(), tz);
    if (day !== c.day) return { ok: true, note: "a past day; only the alert is marked" };
    const [blocks, nights] = await Promise.all([
      get<Block>(`class_blocks?select=id,label,kind,location,start_t,end_t&user_id=eq.${uid}&weekday=eq.${c.weekday}&order=start_t`),
      get<{ items: unknown; blocks_seeded: boolean | null }>(`nights?select=items,blocks_seeded&user_id=eq.${uid}&day=eq.${c.day}`),
    ]);
    if (!blocks || !nights) return { error: "read failed" };
    const n = nights[0];
    const items = tickBlockItem(Array.isArray(n?.items) ? (n.items as DayItem[]) : [], !!n?.blocks_seeded,
      blocks.map((b) => ({ ...b, kind: b.kind ?? "class", location: b.location ?? "" })), ref, c.min * 60, newItemId);
    const w = await rest("POST", "nights?on_conflict=user_id,day", { user_id: uid, day: c.day, items, blocks_seeded: true },
      "return=minimal,resolution=merge-duplicates");
    return w ? { ok: true } : { error: "write failed" };
  }
  if (kind === "due_eve") {
    const rows = await rest("PATCH", `deadlines?user_id=eq.${uid}&id=eq.${ref}`, { done: true, updated_at: stamp });
    if (!rows) return { error: "write failed" };
    const goal = rows[0]?.goal_id;
    if (typeof goal === "string") await rest("PATCH", `goals?user_id=eq.${uid}&id=eq.${goal}`, { status: "done", updated_at: stamp }, "return=minimal");
    return { ok: true };
  }
  return { error: "bad key" };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = (await req.json().catch(() => ({}))) as C;
  const want = await secretOf("alerts_cron_secret");
  if (!want || body.cronSecret !== want) return json({ error: "unauthorized" }, 401);
  const mode = typeof body.mode === "string" ? body.mode : "tick";
  const userId = typeof body.userId === "string" && isUuid(body.userId) ? body.userId : "";
  const dryRun = body.dryRun === true;
  if ((mode === "today" || mode === "done" || dryRun) && !userId) return json({ error: "userId required" });

  const filter = userId ? `user_id=eq.${userId}` : "telegram->>chat_id=not.is.null";
  const users = await get<SettingsRow>(`user_settings?select=user_id,telegram,ai_models&${filter}`);
  if (!users) return json({ error: "couldn't read settings" }, 500);

  if (mode === "done") {
    const u = users[0];
    if (!u) return json({ error: "no such user" });
    return json(await applyDone(u.user_id, String(body.key ?? ""), readSettings(u.telegram).tz));
  }

  const token = await secretOf("telegram_bot_token");
  if (!token && !dryRun) return json({ skipped: "no bot token yet" });
  const results: C[] = [];
  for (const u of users) {
    results.push({ user: u.user_id.slice(0, 8), ...(await tickUser(u, token, { dryRun, today: mode === "today" })) });
  }
  return json({ results });
});
