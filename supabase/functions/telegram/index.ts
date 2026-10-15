// Telegram edge function — the alerts bot's webhook, plus the app's calls.
//
// TWO KINDS OF CALLER:
//  - Telegram, carrying X-Telegram-Bot-Api-Secret-Token (vault
//    telegram_webhook_secret): button taps, /start <code>, /today, /pause,
//    /resume. Only the linked chat is ever acted on.
//  - The app, with Ben's JWT and {mode}: "connect" registers the webhook and
//    returns a one-time Start link; "test" sends one message; "pause"/"resume".
//
// Done taps and /today go through the alerts function, which owns all
// day/time logic. verify_jwt=false at the gateway; both callers are checked here.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SVC = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const OWNER = "f0e1e204-aa54-4a45-bbb5-99c83114fecb"; // the same single owner set_ai_key allows
const HELP = "Commands:\n/today shows today's plan\n/pause 2h stops alerts for 2 hours (1-24)\n/resume turns them back on";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
type C = Record<string, unknown>;
type UserRow = { user_id: string; telegram: C };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const S = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const enc = encodeURIComponent;

const sc = new Map<string, { v: string; at: number }>();
async function secretOf(name: string): Promise<string> {
  const c = sc.get(name);
  if (c && Date.now() - c.at < 60_000) return c.v;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, { method: "POST", headers: SVC, body: JSON.stringify({ secret_name: name }) });
    const v = r.ok ? ((await r.json()) as string | null) ?? "" : "";
    if (v) sc.set(name, { v, at: Date.now() });
    return v;
  } catch { return ""; }
}

async function get<T>(q: string): Promise<T[] | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: SVC });
    if (!r.ok) { console.error(`[telegram] read ${q.split("?")[0]} ${r.status}`); return null; }
    return (await r.json()) as T[];
  } catch { return null; }
}
async function patch(q: string, body: C): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { method: "PATCH", headers: { ...SVC, Prefer: "return=minimal" }, body: JSON.stringify(body) });
    if (!r.ok) console.error(`[telegram] patch ${q.split("?")[0]} ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.ok;
  } catch { return false; }
}
const setTelegram = (u: UserRow, change: C) =>
  patch(`user_settings?user_id=eq.${u.user_id}`, { telegram: { ...(u.telegram ?? {}), ...change } });

async function tg(method: string, body: C): Promise<{ ok: boolean; result?: C }> {
  const token = await secretOf("telegram_bot_token");
  if (!token) return { ok: false };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) console.error(`[telegram] ${method} ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
    return { ok: !!d.ok, result: d.result };
  } catch { return { ok: false }; }
}
const send = async (chat: unknown, text: string) => (await tg("sendMessage", { chat_id: chat, text })).ok;
const answer = (id: unknown, text: string) => tg("answerCallbackQuery", { callback_query_id: id, text });

async function callAlerts(body: C): Promise<C> {
  const cronSecret = await secretOf("alerts_cron_secret");
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/alerts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, cronSecret }) });
    return (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as C;
  } catch { return { error: "unreachable" }; }
}

async function userByChat(chat: unknown): Promise<UserRow | null> {
  if (typeof chat !== "number") return null;
  const rows = await get<UserRow>(`user_settings?select=user_id,telegram&telegram->>chat_id=eq.${chat}`);
  return rows?.[0] ? { ...rows[0], telegram: rows[0].telegram ?? {} } : null;
}

// ── Telegram → us ───────────────────────────────────────────────────────────
async function onButton(cq: C) {
  const data = S(cq.data, 64);
  const code = data.slice(0, 1);
  const key = data.slice(2);
  const msg = cq.message as C | undefined;
  const chat = (msg?.chat as C | undefined)?.id;
  const u = await userByChat(chat);
  if (!u || !key) { await answer(cq.id, "This chat isn't linked to Daily."); return; }
  const stamp = new Date().toISOString();
  const change: C = { updated_at: stamp };
  let label = "";
  if (code === "s") { change.state = "started"; label = "Starting"; }
  else if (code === "z") { change.state = "snoozed"; change.snooze_until = new Date(Date.now() + 15 * 60_000).toISOString(); label = "Snoozed 15 min"; }
  else if (code === "k") { change.state = "skipped"; label = "Skipped today"; }
  else if (code === "d") { change.state = "done"; label = "Done"; }
  else { await answer(cq.id, "That button is out of date."); return; }
  if (code === "d") {
    const r = await callAlerts({ mode: "done", userId: u.user_id, key });
    if (r.error) { await answer(cq.id, "Couldn't tick it in Daily. Try again."); return; }
  }
  const ok = await patch(`alert_log?user_id=eq.${u.user_id}&key=eq.${enc(key)}`, change);
  await answer(cq.id, ok ? label : "Couldn't save that. Try again.");
  // editing without reply_markup removes the buttons, so a tap can't be repeated
  if (ok && msg) await tg("editMessageText", { chat_id: chat, message_id: msg.message_id, text: `${S(msg.text, 3800)}\n\n${label}` });
}

async function onMessage(m: C) {
  const chat = (m.chat as C | undefined)?.id;
  const text = S(m.text, 200);
  if (chat === undefined || !text.startsWith("/")) return;
  const [cmd, arg = ""] = text.split(/\s+/, 2);

  if (cmd === "/start") {
    const code = arg.replace(/[^a-z0-9]/gi, "");
    const rows = code ? await get<UserRow>(`user_settings?select=user_id,telegram&telegram->>link_code=eq.${code}`) : [];
    const u = rows?.[0];
    const exp = u ? Date.parse(String(u.telegram?.link_code_exp ?? "")) : NaN;
    if (!u || !(exp > Date.now())) {
      await send(chat, "That Start link has expired or isn't valid. In Daily, open Settings, Telegram alerts, and get a new link.");
      return;
    }
    await setTelegram(u, { chat_id: chat, linked_at: new Date().toISOString(), link_code: null, link_code_exp: null, blocked: false });
    await send(chat, `Connected. Your plan arrives at 7:45 each morning.\n\n${HELP}`);
    return;
  }

  const u = await userByChat(chat);
  if (!u) return; // strangers get nothing
  if (cmd === "/today") {
    const r = await callAlerts({ mode: "today", userId: u.user_id });
    if (r.error) await send(chat, "Couldn't build today's plan just now. Try again in a minute.");
    return;
  }
  if (cmd === "/pause") {
    const h = Math.min(24, Math.max(1, parseInt(arg, 10) || 2));
    await setTelegram(u, { paused_until: new Date(Date.now() + h * 3_600_000).toISOString() });
    await send(chat, `Paused for ${h} hour${h === 1 ? "" : "s"}. /resume turns alerts back on.`);
    return;
  }
  if (cmd === "/resume") {
    await setTelegram(u, { paused_until: null });
    await send(chat, "Alerts are back on.");
    return;
  }
  await send(chat, HELP);
}

async function webhook(req: Request, given: string): Promise<Response> {
  const want = await secretOf("telegram_webhook_secret");
  if (!want || given !== want) return json({ error: "unauthorized" }, 401);
  const update = (await req.json().catch(() => ({}))) as C;
  try {
    if (update.callback_query) await onButton(update.callback_query as C);
    else if (update.message) await onMessage(update.message as C);
  } catch (e) { console.error("[telegram] update", e instanceof Error ? e.message : e); }
  return json({ ok: true }); // always 200, or Telegram retries the same update
}

// ── the app → us ────────────────────────────────────────────────────────────
async function getUser(token: string): Promise<{ id?: string } | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function fromApp(req: Request): Promise<Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const user = jwt ? await getUser(jwt) : null;
  if (!user?.id) return json({ error: "Sign in again." }, 401);
  if (user.id !== OWNER) return json({ error: "Not permitted." }, 403);
  const body = (await req.json().catch(() => ({}))) as C;
  const rows = await get<UserRow>(`user_settings?select=user_id,telegram&user_id=eq.${user.id}`);
  if (!rows?.[0]) return json({ error: "Couldn't read your settings. Try again." });
  const u: UserRow = { ...rows[0], telegram: rows[0].telegram ?? {} };
  const mode = S(body.mode, 20);

  if (mode === "connect") {
    const token = await secretOf("telegram_bot_token");
    if (!token) return json({ error: "Save the token first." });
    const me = await tg("getMe", {});
    if (!me.ok) return json({ error: "Telegram didn't accept that token. Copy it again from BotFather (/mybots, your bot, API Token)." });
    const hook = await tg("setWebhook", {
      url: `${SUPABASE_URL}/functions/v1/telegram`, secret_token: await secretOf("telegram_webhook_secret"),
      allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
    });
    if (!hook.ok) return json({ error: "Telegram wouldn't register the bot with the server. Try again in a minute." });
    const username = S(me.result?.username, 64);
    const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
    const code = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % 32]).join("");
    const ok = await setTelegram(u, { bot_username: username, link_code: code, link_code_exp: new Date(Date.now() + 10 * 60_000).toISOString() });
    if (!ok) return json({ error: "Couldn't save the Start link. Try again." });
    return json({ bot_username: username, link: `https://t.me/${username}?start=${code}` });
  }
  if (mode === "test") {
    const chat = u.telegram.chat_id;
    if (typeof chat !== "number") return json({ error: "Tap Start in Telegram first." });
    return json((await send(chat, "Alerts are connected. Your plan arrives at 7:45.")) ? { ok: true } : { error: "Telegram didn't take the message. The bot may be blocked." });
  }
  if (mode === "pause") {
    const until = S(body.until, 40);
    if (!(Date.parse(until) > Date.now())) return json({ error: "Pick a time in the future." });
    return json((await setTelegram(u, { paused_until: until })) ? { ok: true } : { error: "Couldn't pause. Try again." });
  }
  if (mode === "resume") {
    return json((await setTelegram(u, { paused_until: null })) ? { ok: true } : { error: "Couldn't resume. Try again." });
  }
  return json({ error: `Unknown mode "${mode}".` });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const hook = req.headers.get("x-telegram-bot-api-secret-token");
  return hook !== null ? await webhook(req, hook) : await fromApp(req);
});
