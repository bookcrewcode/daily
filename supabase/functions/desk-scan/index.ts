// desk-scan — the technical engine. Every fifteen minutes (from the tick):
// crypto perps get the full scan on live BloFin bars; stocks get the scalp
// strategies in session on candidates' 5-minute bars, and the swing and
// position strategies once a day after the close on completed daily bars.
// Every setup is written to desk_setups (the sit collector opens a jury for
// it) and traded by its strategy's own shadow book, so the raw rule and the
// juried version can be compared. No model is called here.
//
// verify_jwt=false; callers checked here: the cron's vault secret, the
// service role (the tick), or a signed-in user's JWT (a manual scan).

import type { Bar, Instrument, InstrumentMeta, Plan, PresetKey, Rules, Trade, Venue } from "./lib/types.ts";
import { etDate, sessionBounds } from "./lib/clock.ts";
import { rulesFor, liqPrice } from "./lib/risk.ts";
import { guardrail } from "./lib/rules.ts";
import { slippageBps } from "./lib/ledger.ts";
import { scanSymbol, momentum12_1, percentile, STRATEGIES, type NewsHint, type ScanInput, type Setup } from "./lib/scan.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TAPE = `${SUPABASE_URL}/functions/v1/tape`;
const SHADOW_START = 100000;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
type J = Record<string, unknown>;
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v: unknown, max = 2000): string => String(v ?? "").slice(0, max);

async function rest(path: string, init?: RequestInit): Promise<{ ok: boolean; json: unknown; status: number }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...svcH, ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) console.error(`[desk-scan] rest ${r.status} ${path} ${text.slice(0, 200)}`);
  return { ok: r.ok, json, status: r.status };
}
async function secret(name: string): Promise<string> {
  const r = await rest("rpc/get_secret", { method: "POST", body: JSON.stringify({ secret_name: name }) });
  return r.ok && typeof r.json === "string" ? r.json : "";
}
async function tape(uid: string, body: J, ms = 30000): Promise<J> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(TAPE, { method: "POST", headers: svcH, body: JSON.stringify({ ...body, userId: uid }), signal: ctl.signal });
    return (await r.json()) as J;
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  finally { clearTimeout(t); }
}
const toBars = (j: J): Bar[] => (Array.isArray(j.bars) ? (j.bars as J[]).map((b) => ({ t: num(b.t), o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c), v: num(b.v) })) : []);
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
const iso = (ms: number) => new Date(ms).toISOString();

/* ── daily bars for stocks: the cache first, the tape (Yahoo) when the cache is cold or stale ── */
async function cachedDaily(symbol: string): Promise<Bar[]> {
  const r = await rest(`desk_bars?symbol=eq.${encodeURIComponent(symbol)}&select=day,o,h,l,c,v&order=day.desc&limit=330`);
  const rows = (r.ok ? (r.json as J[]) : []).reverse();
  return rows.map((x) => ({ t: Date.parse(`${x.day}T12:00:00Z`), o: num(x.o), h: num(x.h), l: num(x.l), c: num(x.c), v: num(x.v) }));
}
async function stockDaily(uid: string, symbol: string, instrument: Instrument, lastSession: string, refresh: boolean): Promise<Bar[]> {
  const cached = await cachedDaily(symbol);
  const lastDay = cached.length ? new Date(cached[cached.length - 1].t).toISOString().slice(0, 10) : "";
  if (!refresh && cached.length >= 200) return cached;
  if (cached.length >= 200 && lastDay >= lastSession) return cached;
  // the tape merges cache + live and fills the cache; its bars carry Yahoo timestamps (13:30 UTC)
  const live = toBars(await tape(uid, { mode: "bars", symbol, venue: "robinhood", instrument, interval: "1d", range: "5d" }, 25000));
  return live.length >= 60 ? live : cached;
}

/* ── setups: persist, dedupe, shadow-trade ─────────────────────────────── */
type Guard = { openSymbols: Set<string>; cooled: Set<string>; recent: Set<string>; shadowOpen: Set<string> };
function expiresAt(s: Setup, nowMs: number): string {
  return iso(nowMs + (s.timeframe === "scalp" ? 2 : s.timeframe === "swing" ? 24 : 72) * 3_600_000);
}
async function persist(uid: string, setups: Setup[], g: Guard, rules: Rules, metas: Record<string, InstrumentMeta>, nowMs: number, regime: string): Promise<{ written: number; shadow: number; skipped: string[] }> {
  let written = 0, shadow = 0;
  const skipped: string[] = [];
  for (const s of setups) {
    const key = `${s.strategy}|${s.symbol}|${s.side}`;
    if (g.recent.has(key)) { skipped.push(`${key}: already on the table`); continue; }
    const status = g.openSymbols.has(s.symbol) ? "held" : g.cooled.has(s.symbol) ? "cooled" : "new";
    const row = {
      user_id: uid, strategy: s.strategy, symbol: s.symbol, venue: s.venue, instrument: s.instrument, side: s.side, timeframe: s.timeframe,
      entry_ref: s.entry_ref, stop: s.stop, target: s.target, leverage_hint: s.leverage_hint, horizon_hours: s.horizon_hours, horizon_days: s.horizon_days,
      score: s.score, reasons: s.reasons, invalidation: s.invalidation, card: { ...s.snapshot, atr: s.atr, regime }, status, expires_at: expiresAt(s, nowMs),
    };
    const ins = await rest("desk_setups", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
    const made = (ins.ok ? (ins.json as J[]) : [])[0];
    if (!made) { skipped.push(`${key}: could not write`); continue; }
    written++;
    g.recent.add(key);
    // the strategy's own shadow book takes every setup it produces (no jury): the raw rule's record
    const owner = `strat:${s.strategy}`;
    if (g.shadowOpen.has(`${owner}|${s.symbol}`)) continue;
    const meta = metas[s.symbol] ?? { max_leverage: s.instrument === "crypto_perp" ? 20 : 1, contract_value: 1, lot_size: 1, tick_size: 0.01 };
    const plan: Plan = {
      venue: s.venue, instrument: s.instrument, symbol: s.symbol, side: s.side, leverage: s.leverage_hint, template: 0,
      thesis: s.reasons.filter((r) => r.core && r.ok).map((r) => `${r.label}: ${r.value}`).join("; ").slice(0, 700), catalyst: STRATEGIES.find((x) => x.id === s.strategy)?.what ?? "",
      falsifier: s.invalidation, confidence: 0.5, entry_ref: s.entry_ref, stop: s.stop, target: s.target,
      horizon_days: s.horizon_days ?? Math.max(1, Math.ceil((s.horizon_hours ?? 24) / 24)), risk_pct: rules.risk_pct, evidence: [], key_risks: [], crosses_event: false,
      timeframe: s.timeframe, horizon_hours: s.horizon_hours ?? undefined, strategy: s.strategy,
    };
    const gr = guardrail(plan, { equity: SHADOW_START, rules: { ...rules, max_open: 99, max_per_theme: 99, gross_cap_pct: 5000, heat_cap_pct: 5000 }, open: [], atr: s.atr, meta, halted: false, themeOf: () => "any", drawdownHalved: false, newTonight: 0 });
    if (!gr.ok || !gr.sizing) { skipped.push(`${key} shadow: ${gr.reasons.join("; ")}`); continue; }
    const uv = gr.sizing.unit === "contract" ? meta.contract_value : 1;
    const notional = gr.sizing.qty * uv * gr.plan.entry_ref;
    const trade = {
      user_id: uid, owner, session_id: null, proposal_id: String(made.id), source: "shadow", strategy: s.strategy, timeframe: s.timeframe, horizon_hours: s.horizon_hours,
      venue: s.venue, instrument: s.instrument, symbol: s.symbol, name: s.symbol, side: s.side, status: "pending", template: 0,
      thesis: plan.thesis, catalyst: plan.catalyst, falsifier: plan.falsifier, confidence: 0.5, evidence: [], regime, decided_at: iso(nowMs),
      entry_ref: gr.plan.entry_ref, stop: gr.plan.stop, target: gr.plan.target, horizon_days: plan.horizon_days, risk_pct: plan.risk_pct,
      leverage: gr.sizing.leverage, qty: gr.sizing.qty, unit: gr.sizing.unit, contract_value: uv, notional,
      margin: s.instrument === "crypto_perp" ? notional / gr.sizing.leverage : notional,
      liq_price: s.instrument === "crypto_perp" ? liqPrice(gr.plan.entry_ref, s.side, gr.sizing.leverage) : null,
      fill_rule: "next_5m", slippage_bps: slippageBps(s.instrument, s.symbol, true, 0),
    };
    const t = await rest("desk_trades", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(trade) });
    const tr = (t.ok ? (t.json as J[]) : [])[0];
    if (tr) { shadow++; g.shadowOpen.add(`${owner}|${s.symbol}`); await rest(`desk_setups?id=eq.${made.id}`, { method: "PATCH", body: JSON.stringify({ shadow_trade_id: tr.id }) }); }
  }
  return { written, shadow, skipped };
}

/* ── the scan ──────────────────────────────────────────────────────────── */
async function scan(uid: string, body: J): Promise<J> {
  const t0 = Date.now();
  const part = String(body.part ?? "all");
  const force = body.force === true;
  const aR = await rest(`desk_accounts?user_id=eq.${uid}&select=*`);
  const acct = (aR.ok ? (aR.json as J[]) : [])[0];
  if (!acct) return { error: "no account" };
  const rules = rulesFor((acct.preset as PresetKey) ?? "aggressive", (acct.rules as Partial<Rules>) ?? {});
  const off = new Set((Array.isArray(acct.strategies_off) ? (acct.strategies_off as string[]) : []));
  const enabledAll = new Set(STRATEGIES.map((s) => s.id).filter((id) => !off.has(id)));
  const cooldownMs = num(acct.cooldown_hours, 4) * 3_600_000;
  const state = ((acct.scan_state as J) ?? {}) as J;
  const today = etDate(t0);
  const session = sessionBounds(today);

  // guards: what is already on the book, cooling down, or already on the table
  const [openR, sitR, setR, shR] = await Promise.all([
    rest(`desk_trades?user_id=eq.${uid}&owner=eq.desk&status=in.(pending,open)&select=symbol`),
    rest(`desk_sits?user_id=eq.${uid}&created_at=gte.${iso(t0 - cooldownMs)}&select=symbol`),
    rest(`desk_setups?user_id=eq.${uid}&expires_at=gte.${iso(t0)}&select=strategy,symbol,side`),
    rest(`desk_trades?user_id=eq.${uid}&owner=like.strat:*&status=in.(pending,open)&select=owner,symbol`),
  ]);
  const g: Guard = {
    openSymbols: new Set((openR.ok ? (openR.json as J[]) : []).map((x) => String(x.symbol))),
    cooled: new Set((sitR.ok ? (sitR.json as J[]) : []).map((x) => String(x.symbol))),
    recent: new Set((setR.ok ? (setR.json as J[]) : []).map((x) => `${x.strategy}|${x.symbol}|${x.side}`)),
    shadowOpen: new Set((shR.ok ? (shR.json as J[]) : []).map((x) => `${x.owner}|${x.symbol}`)),
  };

  // context: regime, SPY, the last two days of tagged news by ticker
  const [ctx, newsR] = await Promise.all([
    tape(uid, { mode: "context" }, 40000),
    rest(`desk_news?tagged=eq.true&impact=gte.3&published=gte.${iso(t0 - 48 * 3_600_000)}&select=title,tickers,impact,direction,category,published&order=published.desc&limit=400`),
  ]);
  const regime = str(ctx.regime, 60);
  const riskOn = regime.includes("spy_above_200") && !regime.includes("vix_high");
  const spyDaily = await cachedDaily("SPY");
  const news: Record<string, NewsHint[]> = {};
  for (const n of (newsR.ok ? (newsR.json as J[]) : [])) {
    for (const tk of (Array.isArray(n.tickers) ? (n.tickers as string[]) : [])) {
      const hint: NewsHint = { impact: num(n.impact), direction: str(n.direction, 10), category: str(n.category, 20), at: Date.parse(String(n.published)), title: str(n.title, 120) };
      for (const key of [tk, `${tk}-USDT`, `${tk}-USD`]) (news[key] ??= []).push(hint);
    }
  }
  const out: J = { part, regime, at: iso(t0), crypto: null, stocks: null };

  /* crypto: the top perps by volume, every run, all strategies */
  if (part === "all" || part === "crypto") {
    const iR = await rest("desk_instruments?state=eq.live&select=inst_id,max_leverage,contract_value,lot_size,tick_size,vol_24h_usd,updated_at&order=vol_24h_usd.desc&limit=40");
    let insts = iR.ok ? (iR.json as J[]) : [];
    const newest = insts.reduce((a, x) => Math.max(a, Date.parse(String(x.updated_at ?? 0)) || 0), 0);
    if (!insts.length || t0 - newest > 6 * 3_600_000) { await tape(uid, { mode: "instruments" }, 40000); const r2 = await rest("desk_instruments?state=eq.live&select=inst_id,max_leverage,contract_value,lot_size,tick_size,vol_24h_usd,updated_at&order=vol_24h_usd.desc&limit=40"); insts = r2.ok ? (r2.json as J[]) : insts; }
    // coins the feed is talking about join the list
    const mentioned = Object.keys(news).filter((k) => k.endsWith("-USDT"));
    const extra = mentioned.filter((m) => !insts.some((i) => i.inst_id === m)).slice(0, 10);
    if (extra.length) { const r3 = await rest(`desk_instruments?state=eq.live&inst_id=in.(${extra.join(",")})&select=inst_id,max_leverage,contract_value,lot_size,tick_size,vol_24h_usd`); insts = [...insts, ...(r3.ok ? (r3.json as J[]) : [])]; }
    const symbols = insts.map((i) => String(i.inst_id));
    const metas: Record<string, InstrumentMeta> = {};
    for (const i of insts) metas[String(i.inst_id)] = { max_leverage: num(i.max_leverage, 20), contract_value: num(i.contract_value, 1), lot_size: num(i.lot_size, 1), tick_size: num(i.tick_size, 0.01) };
    const fund = (await tape(uid, { mode: "funding", symbols }, 30000)).rates as Record<string, number> | undefined;
    const errors: string[] = [];
    // bars for twelve perps per tape call (the gateway throttles a burst of single-symbol calls)
    const chunks: string[][] = [];
    for (let i = 0; i < symbols.length; i += 12) chunks.push(symbols.slice(i, i + 12));
    const bag: Record<string, Record<string, Bar[]>> = {};
    await mapLimit(chunks, 2, async (chunk) => {
      const r = await tape(uid, { mode: "perp_bars", symbols: chunk, intervals: ["1D", "4H", "1H", "5m"] }, 60000);
      if (r.error) { errors.push(`bars: ${str(r.error, 80)}`); return; }
      for (const [sym, ivs] of Object.entries((r.bars as Record<string, Record<string, J[]>>) ?? {})) bag[sym] = Object.fromEntries(Object.entries(ivs).map(([iv, bars]) => [iv, toBars({ bars })]));
    });
    const data = symbols.map((sym) => {
      const b = bag[sym];
      const daily = b?.["1D"] ?? [];
      if (daily.length < 60) { errors.push(`${sym}: short history`); return null; }
      return { sym, daily, h4: b["4H"] ?? [], h1: b["1H"] ?? [], m5: b["5m"] ?? [] };
    });
    const moms = data.filter((x): x is NonNullable<typeof x> => !!x).map((x) => momentum12_1(x.daily.map((b) => b.c))).filter((m): m is number => m !== null);
    const setups: Setup[] = [];
    for (const x of data) {
      if (!x) continue;
      const mom = momentum12_1(x.daily.map((b) => b.c));
      const inp: ScanInput = {
        symbol: x.sym, venue: "blofin", instrument: "crypto_perp", nowMs: t0, daily: x.daily, todayPartial: true, hourly: x.h1, fourHour: x.h4, fiveMin: x.m5,
        spyDaily, funding: fund?.[x.sym] ?? null, riskOn, news: news[x.sym] ?? [], momentumRank: mom === null ? null : percentile(mom, moms), maxLeverage: metas[x.sym]?.max_leverage,
      };
      setups.push(...scanSymbol(inp, enabledAll));
    }
    const p = await persist(uid, setups, g, rules, metas, t0, regime);
    out.crypto = { scanned: data.filter(Boolean).length, setups: setups.length, ...p, errors: errors.slice(0, 10) };
  }

  /* stocks: scalps in session on candidates; swing and position once a day after the close */
  if (part === "all" || part === "stocks") {
    const wR = await rest(`desk_watchlist?user_id=eq.${uid}&select=symbol&limit=300`);
    const watch = (wR.ok ? (wR.json as J[]) : []).map((x) => String(x.symbol));
    const mentionedStocks = Object.keys(news).filter((k) => !k.includes("-") && /^[A-Z][A-Z.]{0,5}$/.test(k) && !watch.includes(k)).slice(0, 25);
    const universe = [...watch, ...mentionedStocks];
    const inSession = !!session && t0 >= session.openMs + 31 * 60_000 && t0 <= session.closeMs - 30 * 60_000;
    const afterClose = !!session && t0 >= session.closeMs + 20 * 60_000;
    const lastSession = afterClose ? today : (() => { let d = today; for (let i = 0; i < 7; i++) { const prev = new Date(Date.parse(d + "T12:00:00Z") - 86_400_000).toISOString().slice(0, 10); if (sessionBounds(prev)) return prev; d = prev; } return today; })();
    const dailyDue = force || (afterClose && state.daily_scan_day !== today) || (!state.daily_scan_day && !inSession);
    const scalps = new Set([...enabledAll].filter((id) => id === "attention-spike" || id === "opening-range-break"));
    const swings = new Set([...enabledAll].filter((id) => !scalps.has(id)));
    const res: J = { in_session: inSession, daily_pass: dailyDue, scanned: 0, setups: 0 };
    const setups: Setup[] = [];
    const errors: string[] = [];
    if (dailyDue) {
      const bars = await mapLimit(universe, 6, async (sym) => ({ sym, daily: await stockDaily(uid, sym, "stock", lastSession, true) }));
      const good = bars.filter((b) => b.daily.length >= 200);
      const moms = good.map((b) => momentum12_1(b.daily.map((x) => x.c))).filter((m): m is number => m !== null);
      for (const b of good) {
        const mom = momentum12_1(b.daily.map((x) => x.c));
        const inp: ScanInput = { symbol: b.sym, venue: "robinhood", instrument: "stock", nowMs: t0, daily: b.daily, todayPartial: false, spyDaily, riskOn, news: news[b.sym] ?? [], momentumRank: mom === null ? null : percentile(mom, moms), session };
        setups.push(...scanSymbol(inp, swings));
      }
      res.scanned = good.length;
      if (bars.length - good.length) errors.push(`${bars.length - good.length} symbols without enough history`);
      await rest(`desk_accounts?user_id=eq.${uid}`, { method: "PATCH", body: JSON.stringify({ scan_state: { ...state, daily_scan_day: today, daily_scan_at: iso(t0), daily_setups: setups.length } }) });
    }
    if (inSession && scalps.size) {
      const orb = ["SPY", "QQQ", "IWM", "DIA", "XLE", "XLF", "XLK", "SMH", "TLT", "GLD", "USO", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AVGO", "JPM", "LLY", "XOM", "COST", "NFLX", "AMD", "CRM", "ORCL", "COIN", "MSTR", "PLTR", "HOOD"];
      const hot = Object.entries(news).filter(([k, v]) => !k.includes("-") && v.some((n) => n.impact >= 4 && t0 - n.at <= 2 * 3_600_000)).map(([k]) => k);
      const candidates = [...new Set([...orb, ...hot])].filter((s) => universe.includes(s) || hot.includes(s)).slice(0, 60);
      const rows = await mapLimit(candidates, 6, async (sym) => {
        const [daily, m5] = await Promise.all([cachedDaily(sym), tape(uid, { mode: "bars", symbol: sym, venue: "robinhood", instrument: "stock", interval: "5m", range: "1d" }, 20000)]);
        return { sym, daily, m5: toBars(m5) };
      });
      for (const r of rows) {
        if (r.daily.length < 60 || r.m5.length < 6) continue;
        const inp: ScanInput = { symbol: r.sym, venue: "robinhood", instrument: "stock", nowMs: t0, daily: r.daily, todayPartial: false, fiveMin: r.m5, spyDaily, riskOn, news: news[r.sym] ?? [], session };
        setups.push(...scanSymbol(inp, scalps));
      }
      res.candidates = rows.length;
    }
    const p = setups.length ? await persist(uid, setups, g, rules, {}, t0, regime) : { written: 0, shadow: 0, skipped: [] };
    out.stocks = { ...res, setups: setups.length, ...p, errors: errors.slice(0, 5) };
  }
  out.ms = Date.now() - t0;
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const body = (await req.json().catch(() => ({}))) as J;
    let uid = "";
    const cronSecret = String(body.cronSecret ?? "");
    if (cronSecret) { const want = await secret("desk_cron_secret"); if (want.length > 20 && want === cronSecret) uid = String(body.userId ?? ""); }
    if (!uid && token && SERVICE_KEY && token === SERVICE_KEY) uid = String(body.userId ?? "");
    if (!uid && token) {
      try { const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }); if (r.ok) uid = String((await r.json())?.id ?? ""); } catch { /* 401 below */ }
    }
    if (!/^[0-9a-f-]{36}$/i.test(uid)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const mode = String(body.mode ?? "scan");
    if (mode === "scan") return ok(await scan(uid, body));
    if (mode === "strategies") return ok({ strategies: STRATEGIES });
    return ok({ error: "Unknown mode." });
  } catch (e) {
    console.error("[desk-scan] fatal", e instanceof Error ? e.stack ?? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
