// desk-sync — the Desk's ledger engine. Runs every 30 minutes, 24/7, and
// decides for itself what is due: fill queued orders once the real bar exists,
// check stops and targets on completed bars, charge perp funding, mark the
// book after the close, halt when the rules say so, and hand every closed
// trade to desk-review.
//
// The arithmetic lives in lib/ledger.ts and lib/rules.ts (copies of
// src/lib/desk, unit-tested there). This file is I/O and ordering only.
//
// verify_jwt=false at the gateway; callers checked here: Ben's JWT, the cron's
// vault secret (desk_cron_secret), or the service role from a sibling function.

import type { Bar, Instrument, PresetKey, Rules, Trade } from "./lib/types.ts";
import { unitValue } from "./lib/types.ts";
import { addDays, etDate, etParts, fundingTimesBetween, isNyseOpen, nextSessionDate, sessionBounds, weekStart } from "./lib/clock.ts";
import { bookEquity, closeTrade, entryCashDelta, entryFees, excursions, fillPrice, fundingCharge, scanBars, timeStopDue, unrealized } from "./lib/ledger.ts";
import { drawdownHalved, haltCheck, liqPrice, rulesFor } from "./lib/risk.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TAPE = `${SUPABASE_URL}/functions/v1/tape`;
const REVIEW = `${SUPABASE_URL}/functions/v1/desk-review`;
const SHADOW_START = 100000;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
type J = Record<string, unknown>;
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const nul = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : num(v));

async function rest(path: string, init?: RequestInit): Promise<{ ok: boolean; json: unknown; status: number; text: string }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...svcH, ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) console.error(`[desk-sync] rest ${r.status} ${path} ${text.slice(0, 200)}`);
  return { ok: r.ok, json, status: r.status, text };
}
async function secret(name: string): Promise<string> {
  const r = await rest("rpc/get_secret", { method: "POST", body: JSON.stringify({ secret_name: name }) });
  return r.ok && typeof r.json === "string" ? r.json : "";
}
async function tape(uid: string, body: J, ms = 60000): Promise<J> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(TAPE, { method: "POST", headers: svcH, body: JSON.stringify({ ...body, userId: uid }), signal: ctl.signal });
    return (await r.json()) as J;
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  finally { clearTimeout(t); }
}

function toTrade(x: J): Trade {
  return {
    id: String(x.id), owner: String(x.owner ?? "desk"), session_id: x.session_id ? String(x.session_id) : null, proposal_id: String(x.proposal_id ?? ""),
    venue: x.venue as Trade["venue"], instrument: x.instrument as Instrument, symbol: String(x.symbol), name: String(x.name ?? ""),
    side: x.side as Trade["side"], status: x.status as Trade["status"], template: num(x.template), thesis: String(x.thesis ?? ""),
    catalyst: String(x.catalyst ?? ""), falsifier: String(x.falsifier ?? ""), confidence: num(x.confidence, 0.5),
    evidence: Array.isArray(x.evidence) ? (x.evidence as number[]) : [], regime: String(x.regime ?? ""), decided_at: String(x.decided_at),
    entry_ref: num(x.entry_ref), stop: num(x.stop), target: num(x.target), horizon_days: num(x.horizon_days, 10), risk_pct: num(x.risk_pct, 3),
    leverage: num(x.leverage, 1), qty: num(x.qty), unit: (x.unit as Trade["unit"]) ?? "share", contract_value: num(x.contract_value, 1),
    notional: num(x.notional), margin: num(x.margin), liq_price: nul(x.liq_price),
    entry_price: nul(x.entry_price), entry_at: x.entry_at ? String(x.entry_at) : null, fill_rule: String(x.fill_rule ?? ""), slippage_bps: num(x.slippage_bps),
    fees: num(x.fees), funding: num(x.funding), funding_at: x.funding_at ? String(x.funding_at) : null, checked_until: x.checked_until ? String(x.checked_until) : null,
    expires_on: x.expires_on ? String(x.expires_on) : null, horizon_hours: nul(x.horizon_hours), timeframe: (x.timeframe as Trade["timeframe"]) ?? "swing", strategy: String(x.strategy ?? ""), source: (x.source as Trade["source"]) ?? "nightly", exit_price: nul(x.exit_price), exit_at: x.exit_at ? String(x.exit_at) : null,
    exit_reason: (x.exit_reason as Trade["exit_reason"]) ?? null, ambiguous_bar: x.ambiguous_bar === true, pnl: nul(x.pnl), pnl_pct: nul(x.pnl_pct),
    r_multiple: nul(x.r_multiple), mae_r: nul(x.mae_r), mfe_r: nul(x.mfe_r), spy_entry: nul(x.spy_entry), spy_exit: nul(x.spy_exit),
    review: (x.review as J | null) ?? null,
    close_requested_at: x.close_requested_at ? String(x.close_requested_at) : null, close_reason: x.close_reason ? String(x.close_reason) : null,
  };
}
const toBars = (j: J): Bar[] => (Array.isArray(j.bars) ? (j.bars as J[]).map((b) => ({ t: num(b.t), o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c), v: num(b.v) })) : []);

type Account = { user_id: string; starting_equity: number; cash: number; equity: number; peak_equity: number; preset: PresetKey; rules: Partial<Rules>; halted_until: string | null; halt_reason: string };
async function loadAccount(uid: string): Promise<Account | null> {
  let r = await rest(`desk_accounts?user_id=eq.${uid}&select=*`);
  let row = (r.ok ? (r.json as J[]) : [])[0];
  if (!row) {
    r = await rest("desk_accounts", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ user_id: uid }) });
    row = (r.ok ? (r.json as J[]) : [])[0];
  }
  if (!row) return null;
  return { user_id: uid, starting_equity: num(row.starting_equity, 100000), cash: num(row.cash, 100000), equity: num(row.equity, 100000), peak_equity: num(row.peak_equity, 100000), preset: (row.preset as PresetKey) ?? "aggressive", rules: (row.rules as Partial<Rules>) ?? {}, halted_until: row.halted_until ? String(row.halted_until) : null, halt_reason: String(row.halt_reason ?? "") };
}
async function loadTrades(uid: string, statuses: string[]): Promise<Trade[]> {
  const r = await rest(`desk_trades?user_id=eq.${uid}&status=in.(${statuses.join(",")})&select=*&order=created_at.asc&limit=2000`);
  return (r.ok ? (r.json as J[]) : []).map(toTrade);
}
async function patchTrade(id: string, patch: J): Promise<boolean> {
  const r = await rest(`desk_trades?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
  return r.ok;
}
const iso = (ms: number) => new Date(ms).toISOString();
const isStock = (i: Instrument) => i === "stock" || i === "etf";

async function settle(uid: string, tradeId: string): Promise<void> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 60000);
    await fetch(REVIEW, { method: "POST", headers: svcH, body: JSON.stringify({ mode: "settle", trade_id: tradeId, userId: uid }), signal: ctl.signal });
    clearTimeout(t);
  } catch (e) { console.error("[desk-sync] settle failed", e instanceof Error ? e.message : e); }
}

type SyncResult = { filled: string[]; closed: { id: string; symbol: string; owner: string; reason: string; pnl: number }[]; funded: number; marked: boolean; halted: boolean; errors: string[] };

async function sync(uid: string, force: { mark?: boolean } = {}): Promise<SyncResult | { error: string }> {
  const out: SyncResult = { filled: [], closed: [], funded: 0, marked: false, halted: false, errors: [] };
  const acct = await loadAccount(uid);
  if (!acct) return { error: "Couldn't load or create the desk account." };
  const rules = rulesFor(acct.preset, acct.rules);
  const nowMs = Date.now();
  const now = etParts(nowMs);
  const today = now.date;
  let cashDelta = 0;
  const trades = await loadTrades(uid, ["pending", "open"]);
  const quoteCache: Record<string, number> = {};
  async function quote(symbol: string, venue: string): Promise<number | null> {
    if (quoteCache[symbol]) return quoteCache[symbol];
    const q = await tape(uid, { mode: "quotes", symbols: [{ symbol, venue }] }, 30000);
    const p = num(((q.quotes as J)?.[symbol] as J)?.price, NaN);
    if (Number.isFinite(p)) { quoteCache[symbol] = p; return p; }
    return null;
  }

  /* ── fills ─────────────────────────────────────────────────────────── */
  for (const t of trades.filter((x) => x.status === "pending")) {
    try {
      const decidedMs = Date.parse(t.decided_at);
      let bar: Bar | undefined, gap = 0;
      if (isStock(t.instrument)) {
        // The first five-minute bar that opens at or after the decision, inside a session: a decision made at
        // 10:03 fills at the 10:05 bar; a decision made overnight fills at the 9:30 bar; the market never fills
        // at a price the jury already saw. Yahoo's daily bar is only the fallback (its open is stale for minutes).
        const d0 = etDate(decidedMs);
        const b0 = sessionBounds(d0);
        const fillDay = b0 && decidedMs < b0.closeMs - 5 * 60_000 ? d0 : nextSessionDate(d0);
        if (today < fillDay) continue;
        if (today > addDays(fillDay, 3)) { await patchTrade(t.id, { status: "cancelled", exit_reason: "cancelled", review: { note: `no bar to fill on ${fillDay} within two sessions` } }); continue; }
        const b = sessionBounds(fillDay);
        if (!b) continue;
        const after = Math.max(decidedMs, b.openMs);
        if (today === fillDay && nowMs < after + 60_000) continue;
        const intraday = toBars(await tape(uid, { mode: "bars", symbol: t.symbol, venue: t.venue, instrument: t.instrument, interval: "5m", range: fillDay === today ? "1d" : "5d" }));
        bar = intraday.find((x) => x.t >= after && x.t < b.closeMs);
        if (!bar && nowMs > after + 30 * 60_000) {
          const daily = toBars(await tape(uid, { mode: "bars", symbol: t.symbol, venue: t.venue, instrument: t.instrument, interval: "1d", range: "5d" }));
          bar = daily.find((x) => etDate(x.t) === fillDay);
        }
        if (!bar) continue;
        if (after === b.openMs) {
          const daily = toBars(await tape(uid, { mode: "bars", symbol: t.symbol, venue: t.venue, instrument: t.instrument, interval: "1d", range: "5d" }));
          const prev = daily.filter((x) => etDate(x.t) < fillDay).pop();
          gap = prev && prev.c > 0 ? bar.o / prev.c - 1 : 0;
        }
      } else {
        if (nowMs - decidedMs > 48 * 3_600_000) { await patchTrade(t.id, { status: "cancelled", exit_reason: "cancelled", review: { note: "no candle within 48 hours" } }); continue; }
        // the next five-minute candle after the decision (hourly if the decision is more than a day old)
        const stale = nowMs - decidedMs > 24 * 3_600_000;
        const bars = toBars(await tape(uid, { mode: "bars", symbol: t.symbol, venue: t.venue, instrument: t.instrument, interval: stale ? "1h" : "5m", limit: 300 }));
        bar = bars.find((x) => x.t > decidedMs);
        if (!bar) continue;
      }
      const bps = isStock(t.instrument) && Math.abs(gap) > 0.02 ? t.slippage_bps * 2 : t.slippage_bps;
      const entry_price = fillPrice(bar.o, t.side, bps, "enter");
      const uv = unitValue(t);
      const notional = t.qty * uv * entry_price;
      const margin = t.instrument === "crypto_perp" ? notional / Math.max(1, t.leverage) : notional;
      const fees = entryFees({ instrument: t.instrument, side: t.side, qty: t.qty, notional });
      const liq = t.instrument === "crypto_perp" ? liqPrice(entry_price, t.side, t.leverage) : null;
      const entryDay = isStock(t.instrument) ? etDate(bar.t) : "";
      const hours = t.horizon_hours ?? null;
      let expires_on: string;
      if (isStock(t.instrument)) {
        const close = sessionBounds(entryDay)?.closeMs ?? bar.t;
        expires_on = hours ? iso(Math.min(bar.t + hours * 3_600_000, close - 5 * 60_000)) : addDays(entryDay, t.horizon_days);
      } else expires_on = iso(bar.t + (hours ? hours * 3_600_000 : t.horizon_days * 86_400_000));
      const spy = await quote("SPY", "robinhood");
      const patch: J = {
        status: "open", entry_price, entry_at: iso(bar.t), notional, margin, fees, liq_price: liq, slippage_bps: bps,
        expires_on, checked_until: iso(bar.t), funding_at: t.instrument === "crypto_perp" ? iso(bar.t) : null, spy_entry: spy,
      };
      if (!(await patchTrade(t.id, patch))) { out.errors.push(`fill write failed for ${t.symbol}`); continue; }
      const filledTrade: Trade = { ...t, ...patch, status: "open", entry_price, notional, margin, fees } as Trade;
      if (t.owner === "desk") cashDelta += entryCashDelta(filledTrade);
      out.filled.push(`${t.owner === "desk" ? "" : "shadow "}${t.symbol} @ ${entry_price.toFixed(4)}`);
      Object.assign(t, filledTrade);
    } catch (e) { out.errors.push(`fill ${t.symbol}: ${e instanceof Error ? e.message : e}`); }
  }

  /* ── exits ─────────────────────────────────────────────────────────── */
  for (const t of trades.filter((x) => x.status === "open")) {
    try {
      const entryMs = Date.parse(t.entry_at ?? t.decided_at);
      const from = Math.max(entryMs, t.checked_until ? Date.parse(t.checked_until) : 0);
      let bars: Bar[] = [];
      let barMs = 5 * 60_000;
      if (isStock(t.instrument)) {
        const sess = sessionBounds(today);
        const inWindow = !!sess && nowMs >= sess.openMs + 6 * 60_000 && nowMs <= sess.closeMs + 15 * 60_000;
        if (!inWindow && !timeStopDue(t, nowMs, today)) continue;
        if (inWindow) {
          const range = etDate(from) < today ? "5d" : "1d";
          bars = toBars(await tape(uid, { mode: "bars", symbol: t.symbol, venue: t.venue, instrument: t.instrument, interval: "5m", range }));
        }
      } else if (nowMs - from > 24 * 3_600_000) {
        barMs = 3_600_000;
        const hours = Math.min(300, Math.ceil((nowMs - from) / 3_600_000) + 2);
        bars = toBars(await tape(uid, { mode: "bars", symbol: t.symbol, venue: t.venue, instrument: t.instrument, interval: "1h", limit: Math.max(3, hours) }));
      } else {
        const fives = Math.min(300, Math.ceil((nowMs - from) / 300_000) + 2);
        bars = toBars(await tape(uid, { mode: "bars", symbol: t.symbol, venue: t.venue, instrument: t.instrument, interval: "5m", limit: Math.max(3, fives) }));
      }
      const done = bars.filter((b) => b.t >= from && b.t + barMs <= nowMs);
      let exitPrice: number | null = null, reason: Trade["exit_reason"] = null, exitAt = nowMs, ambiguous = false;
      const ev = t.close_requested_at ? null : scanBars(t, done);
      if (t.close_requested_at) {
        // a frontier, or a dead team, asked for the exit: out at the next quote, no bar scan
        const q = await quote(t.symbol, t.venue);
        if (q !== null) { exitPrice = q; reason = "thesis_broke"; }
      } else if (ev) { exitPrice = ev.price; reason = ev.reason; exitAt = ev.t + barMs; ambiguous = ev.ambiguous; }
      else if (timeStopDue(t, nowMs, today)) {
        const q = await quote(t.symbol, t.venue);
        if (q !== null) { exitPrice = q; reason = "time"; }
      }
      const ex = excursions(t, done);
      if (exitPrice !== null && reason) {
        const bps = reason === "liquidated" ? 0 : t.slippage_bps;
        const c = closeTrade(t, exitPrice, bps, reason);
        const spy = await quote("SPY", "robinhood");
        const patch: J = {
          status: "closed", exit_price: c.exit_price, exit_at: iso(exitAt), exit_reason: reason, ambiguous_bar: ambiguous,
          pnl: c.pnl, pnl_pct: c.pnl_pct, r_multiple: c.r_multiple, mae_r: ex.mae_r, mfe_r: ex.mfe_r, fees: c.fees_total, spy_exit: spy,
          checked_until: iso(exitAt),
          ...(t.close_requested_at ? { review: { ...((t.review as J | null) ?? {}), closed_by: t.close_reason ?? "requested" } } : {}),
        };
        if (!(await patchTrade(t.id, patch))) { out.errors.push(`close write failed for ${t.symbol}`); continue; }
        if (t.owner === "desk") cashDelta += c.cash_delta;
        out.closed.push({ id: t.id, symbol: t.symbol, owner: t.owner, reason, pnl: c.pnl });
        Object.assign(t, patch, { status: "closed" });
        await settle(uid, t.id);
      } else if (done.length) {
        const last = done[done.length - 1];
        await patchTrade(t.id, { checked_until: iso(last.t + barMs), mae_r: ex.mae_r, mfe_r: ex.mfe_r });
        t.checked_until = iso(last.t + barMs); t.mae_r = ex.mae_r; t.mfe_r = ex.mfe_r;
      }
    } catch (e) { out.errors.push(`exit ${t.symbol}: ${e instanceof Error ? e.message : e}`); }
  }

  /* ── funding (perps) ───────────────────────────────────────────────── */
  const perps = trades.filter((x) => x.status === "open" && x.instrument === "crypto_perp");
  if (perps.length) {
    const rates = ((await tape(uid, { mode: "funding", symbols: [...new Set(perps.map((p) => p.symbol))] }, 30000)).rates ?? {}) as Record<string, number>;
    for (const t of perps) {
      const since = Date.parse(t.funding_at ?? t.entry_at ?? t.decided_at);
      const times = fundingTimesBetween(since, nowMs);
      const rate = rates[t.symbol];
      if (!times.length || typeof rate !== "number") continue;
      const charge = fundingCharge(t.notional, rate, t.side) * times.length;
      if (await patchTrade(t.id, { funding: t.funding + charge, funding_at: iso(times[times.length - 1]) })) {
        t.funding += charge; t.funding_at = iso(times[times.length - 1]);
        if (t.owner === "desk") cashDelta -= charge;
        out.funded++;
      }
    }
  }

  if (cashDelta !== 0) {
    const r = await rest(`desk_accounts?user_id=eq.${uid}`, { method: "PATCH", body: JSON.stringify({ cash: acct.cash + cashDelta, updated_at: new Date().toISOString() }) });
    if (!r.ok) out.errors.push("cash update failed"); else acct.cash += cashDelta;
  }

  /* ── marks ─────────────────────────────────────────────────────────── */
  const afterClose = now.hour > 16 || (now.hour === 16 && now.minute >= 5);
  if (afterClose || force.mark) {
    const have = await rest(`desk_equity?user_id=eq.${uid}&day=eq.${today}&owner=eq.desk&select=day`);
    if (force.mark || !((have.json as J[]) ?? []).length) {
      const res = await markAll(uid, acct, rules, trades, today, nowMs);
      out.marked = res.marked; out.halted = res.halted;
      out.errors.push(...res.errors);
    }
  }
  return out;
}

async function markAll(uid: string, acct: Account, rules: Rules, trades: Trade[], today: string, nowMs: number): Promise<{ marked: boolean; halted: boolean; errors: string[] }> {
  const errors: string[] = [];
  const closedR = await rest(`desk_trades?user_id=eq.${uid}&status=eq.closed&select=owner,pnl&limit=5000`);
  const closed = (closedR.ok ? (closedR.json as J[]) : []).map((x) => ({ owner: String(x.owner), pnl: num(x.pnl) }));
  const open = trades.filter((t) => t.status === "open");
  const owners = new Set<string>(["desk", ...closed.map((c) => c.owner), ...trades.map((t) => t.owner)]);
  const syms = [...new Set(open.map((t) => ({ symbol: t.symbol, venue: t.venue })).map((s) => JSON.stringify(s)))].map((s) => JSON.parse(s) as { symbol: string; venue: string });
  syms.push({ symbol: "SPY", venue: "robinhood" });
  const q = await tape(uid, { mode: "quotes", symbols: syms }, 60000);
  const quotes = (q.quotes ?? {}) as Record<string, J>;
  const marks: Record<string, number> = {};
  for (const [s, v] of Object.entries(quotes)) { const p = num(v.price, NaN); if (Number.isFinite(p)) marks[s] = p; }
  const spyClose = marks["SPY"] ?? null;
  let halted = false;
  for (const owner of owners) {
    const start = owner === "desk" ? acct.starting_equity : SHADOW_START;
    const eq = bookEquity(start, closed.filter((c) => c.owner === owner), open.filter((t) => t.owner === owner), marks);
    const prevR = await rest(`desk_equity?user_id=eq.${uid}&owner=eq.${encodeURIComponent(owner)}&day=lt.${today}&select=day,equity&order=day.desc&limit=1`);
    const prev = (prevR.ok ? (prevR.json as J[]) : [])[0];
    const prevEq = prev ? num(prev.equity) : start;
    const row = { user_id: uid, day: today, owner, equity: eq.equity, cash: owner === "desk" ? acct.cash : start + closed.filter((c) => c.owner === owner).reduce((a, c) => a + c.pnl, 0), market_value: eq.marketValue, gross_exposure: eq.equity > 0 ? eq.gross / eq.equity : 0, pnl_day: eq.equity - prevEq, spy_close: spyClose, marked_at: new Date(nowMs).toISOString() };
    const up = await rest("desk_equity?on_conflict=user_id,day,owner", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(row) });
    if (!up.ok) { errors.push(`equity row failed for ${owner}`); continue; }
    if (owner === "desk") {
      const wkR = await rest(`desk_equity?user_id=eq.${uid}&owner=eq.desk&day=lt.${weekStart(today)}&select=equity&order=day.desc&limit=1`);
      const wk = (wkR.ok ? (wkR.json as J[]) : [])[0];
      const h = haltCheck({ equity: eq.equity, equityYesterday: prev ? prevEq : null, equityWeekStart: wk ? num(wk.equity) : (prev ? acct.starting_equity : null), rules, today });
      const peak = Math.max(acct.peak_equity, eq.equity);
      const patch: J = { equity: eq.equity, peak_equity: peak, updated_at: new Date(nowMs).toISOString() };
      if (h.halt) { patch.halted_until = h.until; patch.halt_reason = h.reason; halted = true; }
      const a = await rest(`desk_accounts?user_id=eq.${uid}`, { method: "PATCH", body: JSON.stringify(patch) });
      if (!a.ok) errors.push("account equity update failed");
      if (drawdownHalved(peak, eq.equity)) console.log(`[desk-sync] drawdown ${((1 - eq.equity / peak) * 100).toFixed(1)}% — sizes halve until a new high`);
    }
  }
  return { marked: true, halted, errors };
}

async function quotesMode(uid: string): Promise<J> {
  const acct = await loadAccount(uid);
  if (!acct) return { error: "no account" };
  const trades = await loadTrades(uid, ["pending", "open"]);
  const open = trades.filter((t) => t.status === "open");
  const closedR = await rest(`desk_trades?user_id=eq.${uid}&status=eq.closed&select=owner,pnl&limit=5000`);
  const closed = (closedR.ok ? (closedR.json as J[]) : []).map((x) => ({ owner: String(x.owner), pnl: num(x.pnl) }));
  const syms = [...new Map(open.map((t) => [t.symbol, { symbol: t.symbol, venue: t.venue }])).values()];
  const q = syms.length ? await tape(uid, { mode: "quotes", symbols: syms }, 45000) : { quotes: {} };
  const quotes = (q.quotes ?? {}) as Record<string, J>;
  const marks: Record<string, number> = {};
  for (const [s, v] of Object.entries(quotes)) { const p = num(v.price, NaN); if (Number.isFinite(p)) marks[s] = p; }
  const owners = new Set<string>(["desk", ...trades.map((t) => t.owner), ...closed.map((c) => c.owner)]);
  const out = [...owners].map((owner) => {
    const start = owner === "desk" ? acct.starting_equity : SHADOW_START;
    const eq = bookEquity(start, closed.filter((c) => c.owner === owner), open.filter((t) => t.owner === owner), marks);
    const unreal = open.filter((t) => t.owner === owner).reduce((a, t) => a + unrealized(t, marks[t.symbol] ?? t.entry_price ?? t.entry_ref), 0);
    return { owner, equity: eq.equity, unrealized: unreal, gross: eq.gross, marketValue: eq.marketValue };
  });
  return { quotes, marks: out, at: Date.now() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const body = (await req.json().catch(() => ({}))) as J;
    const mode = String(body.mode ?? "sync");
    let uid = "";
    const cronSecret = String(body.cronSecret ?? "");
    if (cronSecret) { const want = await secret("desk_cron_secret"); if (want.length > 20 && want === cronSecret) uid = String(body.userId ?? ""); }
    if (!uid && token && SERVICE_KEY && token === SERVICE_KEY) uid = String(body.userId ?? "");
    if (!uid && token) {
      try { const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }); if (r.ok) uid = String((await r.json())?.id ?? ""); } catch { /* 401 below */ }
    }
    if (!/^[0-9a-f-]{36}$/i.test(uid)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

    if (mode === "sync") return ok(await sync(uid));
    if (mode === "mark") return ok(await sync(uid, { mark: true }));
    if (mode === "quotes") return ok(await quotesMode(uid));
    if (mode === "clock") { const now = Date.now(); return ok({ nowMs: now, etDate: etDate(now), nyseOpen: isNyseOpen(now) }); }
    return ok({ error: "Unknown mode." });
  } catch (e) {
    console.error("[desk-sync] fatal", e instanceof Error ? e.stack ?? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
