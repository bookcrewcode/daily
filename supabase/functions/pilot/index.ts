// pilot — the portfolio copilot's server side. Build step 1: the weekly lot
// and the morning report. Modes:
//   tick    the five-minute cron: starts the feed, records due weekly lots, starts the report
//   feed    runs desk-feed's ingest and books its model cost to pf_spend
//   lots    records Robinhood's weekly buy as an assumed lot (idempotent)
//   report  writes today's morning report (also the app's "Write it now")
// It never places, changes or cancels an order and holds no broker credentials.
//
// verify_jwt=false; callers checked here: the cron's vault secret, the service
// role (the tick launching its own children), or a signed-in user's JWT, which
// may only ask for the report.

import { addDays, etParts } from "./lib/clock.ts";
import type { Bar } from "./lib/types.ts";
import { holdingsOf, type Lot, type LotKind, type Quote } from "./lib/lots.ts";
import { dueWeeklyLots, etMidnightMs, firstFiveMinutePrice, sharesFor, type Recurring } from "./lib/weekly.ts";
import { MAX_TRIES, REPORT_ESTIMATE_USD, REPORT_FALLBACK, REPORT_MODEL, REPORT_SCHEMA, REPORT_SYSTEM, parseReport, pickNews, reportDue, reportPrompt, toNews, type ReportEvent, type ReportInput, type ReportMarket, type ReportRow } from "./lib/report.ts";
import { tickPlan } from "./lib/tick.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OR = "https://openrouter.ai/api/v1/chat/completions";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
type J = Record<string, unknown>;
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const SYM = /^[\^A-Z0-9.\-]{1,14}$/;

// The market backdrop in the report: the two big indexes, bitcoin, and the 10-year yield (in percentage points).
const MARKET: { symbol: string; label: string; unit: "pct" | "pts" }[] = [
  { symbol: "^GSPC", label: "S&P 500", unit: "pct" },
  { symbol: "^IXIC", label: "Nasdaq", unit: "pct" },
  { symbol: "BTC-USD", label: "Bitcoin", unit: "pct" },
  { symbol: "^TNX", label: "10-year Treasury yield", unit: "pts" },
];

async function rest(path: string, init?: RequestInit): Promise<{ ok: boolean; json: unknown; status: number }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...svcH, ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) console.error(`[pilot] rest ${r.status} ${path.slice(0, 80)} ${text.slice(0, 200)}`);
  return { ok: r.ok, json, status: r.status };
}
async function secret(name: string): Promise<string> {
  const r = await rest("rpc/get_secret", { method: "POST", body: JSON.stringify({ secret_name: name }) });
  return r.ok && typeof r.json === "string" ? r.json : "";
}
async function call(fn: string, body: J, ms: number): Promise<J> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: "POST", headers: svcH, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    try { return JSON.parse(text) as J; } catch { return { error: `${fn}: HTTP ${r.status} ${text.slice(0, 120)}` }; }
  } catch (e) { return { error: `${fn}: ${e instanceof Error ? e.message : String(e)}` }; }
  finally { clearTimeout(t); }
}
// Fire and keep the isolate alive until the child answers, without waiting for it.
function launch(fn: string, body: J): void {
  const p = fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: "POST", headers: svcH, body: JSON.stringify(body) }).then((r) => r.text()).catch((e) => console.error("[pilot] launch", fn, e instanceof Error ? e.message : e));
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
}

/* ── settings and spend ─────────────────────────────────────────────────── */
type Settings = { recurring: Recurring[]; buyDow: number; since: string | null; cap: number; model: string; paused: boolean };
async function settingsOf(uid: string): Promise<Settings> {
  const r = await rest(`pf_settings?user_id=eq.${uid}&select=*`);
  const row = ((r.ok && Array.isArray(r.json) ? (r.json as J[])[0] : null) ?? {}) as J;
  return {
    recurring: (Array.isArray(row.recurring) ? (row.recurring as J[]) : []).map((x) => ({ symbol: String(x.symbol ?? "").toUpperCase(), usd: num(x.usd) })).filter((x) => SYM.test(x.symbol) && x.usd > 0),
    buyDow: num(row.buy_dow, 3),
    since: row.recurring_since ? String(row.recurring_since) : null,
    cap: num(row.cap_usd_day, 1),
    model: String(row.report_model ?? "") || REPORT_MODEL,
    paused: row.paused === true,
  };
}
// null when the sum can't be read: callers treat that as no budget left.
async function spentToday(uid: string, nowMs: number): Promise<number | null> {
  const r = await rest("rpc/pf_spend_since", { method: "POST", body: JSON.stringify({ p_user: uid, p_since: new Date(etMidnightMs(etParts(nowMs).date)).toISOString() }) });
  const v = Number(r.json);
  return r.ok && Number.isFinite(v) ? v : null;
}
async function book(uid: string, kind: string, model: string, cost: number): Promise<void> {
  if (cost > 0) await rest("pf_spend", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: uid, kind, model, cost_usd: cost }) });
}
// undefined when the read failed, null when there is no report yet today.
async function reportRow(uid: string, day: string): Promise<ReportRow | null | undefined> {
  const r = await rest(`pf_reports?user_id=eq.${uid}&day=eq.${day}&select=status,tries,updated_at`);
  if (!r.ok || !Array.isArray(r.json)) return undefined;
  const row = (r.json as J[])[0];
  return row ? { status: row.status as ReportRow["status"], tries: num(row.tries), updated_at: String(row.updated_at) } : null;
}
function toLot(r: J): Lot {
  return { id: String(r.id), symbol: String(r.symbol), shares: num(r.shares), price: num(r.price), day: String(r.day), kind: (r.kind as LotKind) ?? "manual", assumed: r.assumed === true, note: String(r.note ?? ""), created_at: String(r.created_at ?? "") };
}

/* ── tick ───────────────────────────────────────────────────────────────── */
async function tick(uid: string, body: J): Promise<J> {
  const now = Date.now();
  const day = etParts(now).date;
  const s = await settingsOf(uid);
  const spent = await spentToday(uid, now);
  const row = await reportRow(uid, day);
  const budgetLeft = spent !== null && spent + REPORT_ESTIMATE_USD <= s.cap;
  const plan = tickPlan(now, { paused: s.paused, budgetLeft, reportDue: row !== undefined && reportDue(now, row) });
  const out: J = { at: new Date(now).toISOString(), plan, spent };
  if (plan.feed || (body.feed === true && budgetLeft)) { launch("pilot", { mode: "feed", userId: uid }); out.feed = "launched"; }
  if (plan.lots || body.lots === true) out.lots = await recordLots(uid, s, now);
  if (plan.report) { launch("pilot", { mode: "report", userId: uid }); out.report = "launched"; }
  return out;
}

/* ── feed ───────────────────────────────────────────────────────────────── */
async function feed(uid: string): Promise<J> {
  const r = await call("desk-feed", { mode: "ingest", userId: uid }, 130_000);
  await book(uid, "feed", String(r.model ?? ""), num(r.cost));
  return r;
}

/* ── weekly lots ────────────────────────────────────────────────────────── */
async function recordLots(uid: string, s: Settings, now: number): Promise<J> {
  if (!s.recurring.length || !s.since) return { due: 0 };
  const today = etParts(now).date;
  const ex = await rest(`pf_lots?user_id=eq.${uid}&kind=eq.weekly&day=gte.${addDays(today, -15)}&select=symbol,day`);
  if (!ex.ok || !Array.isArray(ex.json)) return { error: "Couldn't read the recorded weekly buys." };
  const due = dueWeeklyLots(now, { recurring: s.recurring, buyDow: s.buyDow, since: s.since }, (ex.json as J[]).map((x) => ({ symbol: String(x.symbol), day: String(x.day) })));
  if (!due.length) return { due: 0 };
  const bars = new Map<string, Bar[]>();
  const written: J[] = [];
  const waiting: string[] = [];
  for (const d of due) {
    if (!bars.has(d.symbol)) {
      const r = await call("tape", { mode: "bars", symbol: d.symbol, interval: "5m", range: "1mo", userId: uid }, 30_000);
      bars.set(d.symbol, Array.isArray(r.bars) ? (r.bars as Bar[]) : []);
    }
    const price = firstFiveMinutePrice(bars.get(d.symbol) ?? [], d.day);
    const shares = price ? sharesFor(d.usd, price) : 0;
    if (!price || shares <= 0) { waiting.push(`${d.symbol} ${d.day}`); continue; } // retried by the next tick
    const ins = await rest("pf_lots", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, symbol: d.symbol, shares, price, day: d.day, kind: "weekly", assumed: true, note: `Robinhood weekly buy of $${d.usd}, assumed at the 9:35 price.` }),
    });
    if (ins.ok || ins.status === 409) written.push({ symbol: d.symbol, day: d.day, price, shares });
  }
  return { due: due.length, written, waiting };
}

/* ── the morning report ─────────────────────────────────────────────────── */
async function ask(key: string, model: string, prompt: string): Promise<{ out: string; cost: number; error: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 50_000);
  try {
    const r = await fetch(OR, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://bookcrewcode.github.io/daily/", "X-Title": "Daily Portfolio" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: REPORT_SYSTEM }, { role: "user", content: prompt }], max_tokens: 4000, reasoning: { effort: "low", exclude: true }, response_format: { type: "json_schema", json_schema: REPORT_SCHEMA }, provider: { require_parameters: true } }),
    });
    const d = (await r.json().catch(() => null)) as J | null;
    const content = String((((d?.choices as J[]) ?? [])[0]?.message as J)?.content ?? "");
    return { out: r.ok ? content : "", cost: num((d?.usage as J)?.cost), error: r.ok ? (content ? "" : "empty answer") : `HTTP ${r.status}` };
  } catch (e) { return { out: "", cost: 0, error: e instanceof Error ? e.message : String(e) }; }
  finally { clearTimeout(t); }
}
async function fail(uid: string, day: string, error: string, extra: J = {}): Promise<J> {
  await rest(`pf_reports?user_id=eq.${uid}&day=eq.${day}`, { method: "PATCH", body: JSON.stringify({ status: "failed", error, updated_at: new Date().toISOString(), ...extra }) });
  return { error };
}

async function writeReport(uid: string, fromApp: boolean): Promise<J> {
  const t0 = Date.now();
  const day = etParts(t0).date;
  const s = await settingsOf(uid);
  if (s.paused) return { error: "The copilot is paused in Settings." };
  const row = await reportRow(uid, day);
  if (row === undefined) return { error: "Couldn't read today's report." };
  if (row && row.tries >= MAX_TRIES) return { error: "Today's report has already been tried three times. It tries again tomorrow." };
  if (row?.status === "running" && t0 - Date.parse(row.updated_at) < 5 * 60_000) return { error: "The report is being written right now. Check back in a minute." };
  if (row?.status === "done" && !fromApp) return { skipped: "already written" };

  // claim today's row (one per day; the tries count stops runaway retries)
  const claim = await rest("pf_reports?on_conflict=user_id,day", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: uid, day, status: "running", tries: (row?.tries ?? 0) + 1, error: "", updated_at: new Date().toISOString() }),
  });
  if (!claim.ok) return { error: "Couldn't start the report." };

  const spent = await spentToday(uid, t0);
  if (spent === null || spent + REPORT_ESTIMATE_USD > s.cap) return await fail(uid, day, "Today's AI budget is used up, so no report was written. It resets at midnight New York time.");

  const lotsR = await rest(`pf_lots?user_id=eq.${uid}&select=id,symbol,shares,price,day,kind,assumed,note,created_at&order=day.asc&limit=2000`);
  if (!lotsR.ok || !Array.isArray(lotsR.json)) return await fail(uid, day, "Couldn't read your holdings.");
  const lots = (lotsR.json as J[]).map(toLot);
  const symbols = [...new Set(lots.map((l) => l.symbol.toUpperCase()))];
  if (!symbols.length) return await fail(uid, day, "There are no holdings yet. Add them on the Holdings page first.");

  const snap = await call("tape", { mode: "snapshot", symbols: [...symbols, ...MARKET.map((m) => m.symbol)].map((symbol) => ({ symbol })), userId: uid }, 40_000);
  const cards = ((snap.cards ?? {}) as Record<string, J>);
  const quotes: Record<string, Quote> = {};
  for (const [k, c] of Object.entries(cards)) {
    const price = Number(c?.price);
    if (Number.isFinite(price) && price > 0) quotes[k] = { price, prevClose: num(c.prevClose, NaN) || null, name: String(c.name ?? k) };
  }
  const held = holdingsOf(lots, quotes).holdings.filter((h) => h.price !== null && h.value !== null);
  if (!held.length) return await fail(uid, day, "No prices came back for your holdings, so the report waits for the next try.");
  const syms = held.map((h) => h.symbol);

  const since = new Date(t0 - 24 * 3_600_000).toISOString();
  // desk_news.tickers is jsonb, so the day's tagged headlines are matched to the holdings in code (pickNews)
  const newsR = await rest(`desk_news?tagged=eq.true&impact=gte.2&published=gte.${since}&select=title,plain,impact,direction,source,link,published,tickers&order=impact.desc,published.desc&limit=500`);
  const macroR = await rest(`desk_news?tagged=eq.true&impact=gte.4&venue=eq.macro&published=gte.${since}&select=title,plain,impact,direction,source,link,published,tickers&order=impact.desc,published.desc&limit=5`);
  if (!newsR.ok || !macroR.ok) return await fail(uid, day, "Couldn't read the news.");
  const news = pickNews(newsR.json as J[], syms);
  const macro = (macroR.json as J[]).map((r) => toNews(r, []));

  const cal = await call("tape", { mode: "calendar", days: 14, symbols: syms, userId: uid }, 20_000);
  if (!Array.isArray(cal.events)) return await fail(uid, day, "Couldn't read the events calendar.");
  const events: ReportEvent[] = (cal.events as J[]).map((e) => ({ day: String(e.day), time_et: String(e.time_et ?? ""), kind: String(e.kind ?? ""), label: String(e.label ?? ""), symbol: String(e.symbol ?? "") }))
    .filter((e) => !e.symbol || syms.includes(e.symbol)).slice(0, 12);

  const market: ReportMarket[] = MARKET.flatMap((m) => {
    const c = cards[m.symbol];
    const level = Number(c?.price);
    if (!c || !Number.isFinite(level)) return [];
    const change = m.unit === "pts" ? level - num(c.prevClose, level) : num(c.ret1d);
    return [{ label: m.label, level, change, unit: m.unit }];
  });

  const input: ReportInput = {
    day,
    holdings: held.map((h) => ({ symbol: h.symbol, name: h.name, price: h.price as number, ret1d: num(cards[h.symbol]?.ret1d), ret5d: num(cards[h.symbol]?.ret5d), shares: Math.round(h.shares * 1e6) / 1e6, value: h.value as number, gainPct: h.gainPct })),
    news, macro, events, market,
  };

  const key = await secret("anthropic_api_key");
  if (!key) return await fail(uid, day, "The AI key is missing.", { input });
  const prompt = reportPrompt(input);
  let model = s.model;
  let res = await ask(key, model, prompt);
  let cost = res.cost;
  let out = res.out ? parseReport(res.out, syms) : null;
  if (!out && Date.now() - t0 < 80_000) {
    model = REPORT_FALLBACK;
    res = await ask(key, model, prompt);
    cost += res.cost;
    out = res.out ? parseReport(res.out, syms) : null;
  }
  await book(uid, "report", model, cost);
  if (!out) return await fail(uid, day, `The AI's answer couldn't be read (${res.error || "wrong shape"}).`, { input, model, cost_usd: cost });
  await rest(`pf_reports?user_id=eq.${uid}&day=eq.${day}`, { method: "PATCH", body: JSON.stringify({ status: "done", input, output: out, model, cost_usd: cost, error: "", updated_at: new Date().toISOString() }) });
  return { ok: true, day, model, cost, holdings: held.length, news: news.length, events: events.length, ms: Date.now() - t0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const body = (await req.json().catch(() => ({}))) as J;
    let uid = "";
    let fromApp = false;
    const cronSecret = String(body.cronSecret ?? "");
    if (cronSecret) { const want = await secret("desk_cron_secret"); if (want.length > 20 && want === cronSecret) uid = String(body.userId ?? ""); }
    if (!uid && token && SERVICE_KEY && token === SERVICE_KEY) uid = String(body.userId ?? "");
    if (!uid && token) {
      try {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
        if (r.ok) { uid = String((await r.json())?.id ?? ""); fromApp = true; }
      } catch { /* 401 below */ }
    }
    if (!/^[0-9a-f-]{36}$/i.test(uid)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const mode = String(body.mode ?? "");
    if (fromApp && mode !== "report") return ok({ error: "The app can only ask for the report." });
    if (mode === "tick") return ok(await tick(uid, body));
    if (mode === "feed") return ok(await feed(uid));
    if (mode === "lots") return ok(await recordLots(uid, await settingsOf(uid), Date.now()));
    if (mode === "report") return ok(await writeReport(uid, fromApp));
    return ok({ error: "Unknown mode." });
  } catch (e) {
    console.error("[pilot] fatal", e instanceof Error ? e.stack ?? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way. Try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
