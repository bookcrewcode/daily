// The Desk — the technical scan: eight strategies as code. Pure, so the app
// can show exactly why a setup exists and the edge function can run it.
// Each strategy returns a setup card or nothing. Core checks must all pass;
// confirmations only move the score. Every check is written down with its
// numbers, because the point is that Ben learns to read them.
import type { Bar, Instrument, Side, Timeframe, Venue } from "./types";
import { sma, pctChange } from "./ta";

export type Reason = { label: string; value: string; ok: boolean; core: boolean };
export type Setup = {
  strategy: string; symbol: string; venue: Venue; instrument: Instrument; side: Side; timeframe: Timeframe;
  entry_ref: number; stop: number; target: number; leverage_hint: number; horizon_hours: number | null; horizon_days: number | null;
  score: number; reasons: Reason[]; invalidation: string;
  atr: number | null;                              // daily ATR, for the guardrail's stop check
  snapshot: Record<string, number | string | null>; // the numbers the jury reads
};
export type NewsHint = { impact: number; direction: string; category: string; at: number; title: string };
export type ScanInput = {
  symbol: string; venue: Venue; instrument: Instrument; nowMs: number;
  daily: Bar[];                       // oldest → newest
  todayPartial?: boolean;             // the last daily bar is still forming (crypto during the day, stocks in session)
  hourly?: Bar[]; fourHour?: Bar[]; fiveMin?: Bar[];
  spyDaily?: Bar[]; funding?: number | null; riskOn?: boolean | null;
  session?: { openMs: number; closeMs: number } | null;  // stocks: today's session bounds
  news?: NewsHint[]; momentumRank?: number | null;      // 0..1 percentile of 12-1 momentum inside the universe
  maxLeverage?: number;
};

/* ── indicators ────────────────────────────────────────────────────────── */
export function ema(values: number[], n: number): number[] {
  if (!values.length) return [];
  const k = 2 / (n + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}
export function rsi(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  if (g === 0 && l === 0) return 50;
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
export function atr(bars: Bar[], n: number): number | null {
  if (bars.length < n + 1) return null;
  const tr = (i: number) => { const b = bars[i], pc = bars[i - 1].c; return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)); };
  let a = 0;
  for (let i = 1; i <= n; i++) a += tr(i);
  a /= n;
  for (let i = n + 1; i < bars.length; i++) a = (a * (n - 1) + tr(i)) / n;
  return a;
}
// One close per ISO week (Monday-based), oldest → newest.
export function weeklyCloses(daily: Bar[]): number[] {
  const out: number[] = [];
  let week = "";
  for (const b of daily) {
    const d = new Date(b.t);
    const day = (d.getUTCDay() + 6) % 7; // Monday = 0
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
    if (monday === week) out[out.length - 1] = b.c; else { out.push(b.c); week = monday; }
  }
  return out;
}
// Twelve-month momentum skipping the last month (Jegadeesh–Titman); six-month fallback when the history is short.
export function momentum12_1(closes: number[]): number | null {
  const n = closes.length;
  if (n >= 253 && closes[n - 253] > 0) return closes[n - 22] / closes[n - 253] - 1;
  if (n >= 127 && closes[n - 127] > 0) return closes[n - 22] / closes[n - 127] - 1;
  return null;
}
const hi = (bars: Bar[]) => bars.reduce((a, b) => Math.max(a, b.h), -Infinity);
const lo = (bars: Bar[]) => bars.reduce((a, b) => Math.min(a, b.l), Infinity);
const px = (v: number) => (v >= 1000 ? v.toFixed(1) : v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toPrecision(4));
const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

/* ── what the jurors and Ben read about each strategy ──────────────────── */
export type StrategyDef = { id: string; name: string; timeframe: Timeframe; venues: ("stocks" | "perps")[]; what: string; why: string; fails: string; rules: string[]; leverage: number };
export const STRATEGIES: StrategyDef[] = [
  { id: "trend-pullback", name: "Trend pullback", timeframe: "swing", venues: ["stocks", "perps"], leverage: 3,
    what: "Buy a dip inside an uptrend (or sell a bounce inside a downtrend).",
    why: "Trends persist more often than they reverse, and a pullback to the 20-day average puts the stop where the trend itself would be wrong, so the risk is small and defined.",
    fails: "When the pullback is actually the start of a reversal: watch for the 50-day turning down, or the pullback closing below the 20-day on rising volume.",
    rules: ["close above the 50-day average, which is above the 200-day, and the 50-day is rising (weekly trend agrees)", "price within one ATR of the 20-day EMA, RSI(14) between 35 and 55: a pause, not a collapse", "today closed up: the dip is being bought", "stop under the low of the last three days minus half an ATR; target twice the risk or the 20-day high"] },
  { id: "breakout", name: "Breakout", timeframe: "swing", venues: ["stocks", "perps"], leverage: 3,
    what: "Buy a new 20-day high (or sell a new 20-day low) when volume confirms it.",
    why: "A close above every price of the last month with heavy volume means real demand absorbed all the supply at the old ceiling; the drift that follows is one of the better documented effects.",
    fails: "Breakouts fail when they come after a long run (too extended), on light volume, or straight into an event. False breakouts reverse fast, which is why the stop sits just under the old ceiling.",
    rules: ["today's close is the highest close of the last 21 days", "volume at least 1.5 times the 20-day average", "not extended: close less than three ATRs above the 20-day average", "weekly trend agrees", "stop one ATR below the breakout level; target 2.5 times the risk"] },
  { id: "rsi2-reversion", name: "RSI(2) reversion", timeframe: "swing", venues: ["stocks", "perps"], leverage: 2,
    what: "Buy a two-day washout inside a long-term uptrend; hold a few days.",
    why: "Short-term selling in a stock that is above its 200-day average is usually noise (a downgrade, a bad day) that snaps back. Connors' RSI(2) below 10 has been a reliable flag for that in US stocks for decades.",
    fails: "When the washout is the first day of a real break: the 200-day is a slow filter. Keep the time stop honest, five days and out.",
    rules: ["close above the 200-day average", "RSI(2) below 10", "stop two ATRs below; target 1.5 times the risk; out after five days regardless"] },
  { id: "crypto-momentum", name: "Crypto momentum", timeframe: "swing", venues: ["perps"], leverage: 4,
    what: "Ride a perp whose 4-hour and daily trends agree, entered on an hourly pullback, while funding is calm.",
    why: "Crypto trends are strong and fast, and funding tells you whether the crowd is already leaning in. A calm funding rate means the move is not crowded yet; the hourly pullback gives a nearby stop.",
    fails: "Weekend liquidity, exchange headlines and macro risk-off days break crypto trends without warning. Funding over 0.05% per eight hours means the trade is popular, which is when it stops working.",
    rules: ["4-hour EMA21 above EMA55 with price above EMA21", "daily close above the 20-day, which is above the 50-day", "funding between −0.05% and +0.05% per eight hours", "hourly price within one hourly ATR of the hourly EMA21: the pullback", "stop under the lowest low of the last twelve 4-hour bars minus half an ATR; target twice the risk; three days"] },
  { id: "attention-spike", name: "Attention spike", timeframe: "scalp", venues: ["stocks", "perps"], leverage: 3,
    what: "Trade the hours after a headline that brought volume and a move.",
    why: "Attention brings flow for hours. Quantitative news (earnings, guidance, a deal) tends to keep drifting in its direction; qualitative news (a rumour, a quote, a threat) tends to fade. The jury picks the side; the size and the clock are fixed.",
    fails: "Chasing a spike that already went most of the way. The stop beyond the spike bar keeps a wrong-way fade cheap, and the six-hour clock stops it turning into a hold.",
    rules: ["a tagged headline on the symbol in the last two hours with impact 4 or 5", "volume in the last 30 minutes at least three times normal", "an intraday move of at least 1.5 daily ATRs", "stop beyond the spike bar by one 5-minute ATR; target 1.5 times the risk; out in six hours or at the close"] },
  { id: "opening-range-break", name: "Opening range break", timeframe: "scalp", venues: ["stocks"], leverage: 1,
    what: "After 10:00, buy a break above the first half hour's high (or sell a break below its low) in the direction of the daily trend.",
    why: "The first thirty minutes are the day's auction: overnight orders meet the open. A break out of that range with volume, in the direction of the bigger trend, tends to run into the afternoon.",
    fails: "Chop days, when the range breaks both ways. The stop at the range midpoint and the flat-by-the-close rule keep those small.",
    rules: ["between 10:00 and 15:00 New York time", "last 5-minute close beyond the first 30 minutes' high (up) or low (down)", "the 5-minute volume at least 1.5 times the opening bars' average", "daily trend agrees", "stop at the midpoint of the opening range; target twice the risk; flat at the close"] },
  { id: "funding-extreme-fade", name: "Funding extreme fade", timeframe: "swing", venues: ["perps"], leverage: 3,
    what: "Fade a perp whose funding rate says one side is crowded and paying to stay in, at a 20-day extreme.",
    why: "Funding above 0.1% per eight hours is an annualised cost of more than 100% to hold the popular side. That is unstable: the crowd is either right quickly or gets squeezed. At a 20-day high, the squeeze usually comes first.",
    fails: "In a true mania, funding can stay extreme for weeks. The 1.5-ATR stop is the admission that this is a mean-reversion bet against a trend.",
    rules: ["funding at or above +0.10% per eight hours with price at a 20-day high → short; at or below −0.10% with price at a 20-day low → long", "stop 1.5 daily ATRs away; target twice the risk; three days"] },
  { id: "weekly-trend-position", name: "Weekly trend position", timeframe: "position", venues: ["stocks", "perps"], leverage: 2,
    what: "Hold the strongest names in the universe for weeks, with the 10-week average as the trend's own stop.",
    why: "Twelve-month momentum (skipping the last month) is the most persistent anomaly in the literature: what went up keeps going up for months. Weekly averages filter the daily noise and give a wide stop that only trips when the trend is over.",
    fails: "Momentum crashes: after a sharp sell-off the strongest names fall hardest as the market rotates. The 40-day horizon and the wide stop are the only defence; size it for that.",
    rules: ["12-month momentum in the top tenth of the universe (bottom tenth for shorts)", "10-week average above the 40-week (weekly trend up) and price above the 10-week", "stop at the 10-week average minus 2.5 daily ATRs; target three times the risk; forty days"] },
];
export function strategyDef(id: string): StrategyDef | undefined { return STRATEGIES.find((s) => s.id === id); }
/** The name to show for a strategy id: a coded strategy's name, or a frontier's own playbook ("own:news-momentum" reads "own playbook: news momentum"). */
export function strategyName(id: string): string {
  if (id.startsWith("own:")) return `own playbook: ${id.slice(4).replace(/-/g, " ")}`;
  return STRATEGIES.find((s) => s.id === id)?.name ?? id;
}

/* ── the scan ──────────────────────────────────────────────────────────── */
type Ctx = {
  inp: ScanInput; d: Bar[]; closes: number[]; price: number; prevClose: number; last: Bar;
  sma20: number | null; sma50: number | null; sma200: number | null; sma50ago: number | null; ema20: number | null;
  rsi14: number | null; rsi2: number | null; atrD: number | null; hi20: number; lo20: number; volRatio: number | null;
  weeklyUp: boolean | null; weeklyDown: boolean | null; w10: number | null; w40: number | null;
  rs20: number | null; mom: number | null; dailyUp: boolean; dailyDown: boolean; isPerp: boolean;
};
function context(inp: ScanInput): Ctx | null {
  const d = inp.todayPartial ? inp.daily.slice(0, -1) : inp.daily;
  if (d.length < 60) return null;
  const closes = d.map((b) => b.c);
  const last = d[d.length - 1];
  const intraday = inp.fiveMin?.length ? inp.fiveMin[inp.fiveMin.length - 1].c : inp.hourly?.length ? inp.hourly[inp.hourly.length - 1].c : null;
  const price = inp.todayPartial && intraday ? intraday : inp.todayPartial ? inp.daily[inp.daily.length - 1].c : last.c;
  const prevClose = last.c;
  const sma20 = sma(closes, 20), sma50 = sma(closes, 50), sma200 = sma(closes, 200);
  const sma50ago = closes.length >= 55 ? sma(closes.slice(0, -5), 50) : null;
  const e20 = ema(closes, 20); const ema20 = e20.length ? e20[e20.length - 1] : null;
  const atrD = atr(d, 14);
  const vols = d.map((b) => b.v); const v20 = sma(vols, 20);
  // the weekly trend: 10-week vs 40-week averages; young listings (under 40 weeks) use 20 weeks as the long side
  const wc = weeklyCloses(d); const w10 = sma(wc, 10), w40 = wc.length >= 40 ? sma(wc, 40) : wc.length >= 20 ? sma(wc, 20) : null;
  const spy = inp.spyDaily?.map((b) => b.c) ?? [];
  const rs20 = spy.length > 20 && closes.length > 20 ? pctChange(closes, 20) - pctChange(spy, 20) : null;
  const dailyUp = sma50 !== null && sma200 !== null && sma50ago !== null && price > sma50 && sma50 > sma200 && sma50 > sma50ago;
  const dailyDown = sma50 !== null && sma200 !== null && sma50ago !== null && price < sma50 && sma50 < sma200 && sma50 < sma50ago;
  return {
    inp, d, closes, price, prevClose, last, sma20, sma50, sma200, sma50ago, ema20, rsi14: rsi(closes, 14), rsi2: rsi(closes, 2), atrD,
    hi20: hi(d.slice(-20)), lo20: lo(d.slice(-20)), volRatio: v20 !== null && v20 > 0 ? last.v / v20 : null,
    weeklyUp: w10 !== null && w40 !== null ? w10 > w40 && price > w10 : null, weeklyDown: w10 !== null && w40 !== null ? w10 < w40 && price < w10 : null, w10, w40,
    rs20, mom: momentum12_1(closes), dailyUp, dailyDown, isPerp: inp.instrument === "crypto_perp",
  };
}
const R = (label: string, value: string, ok: boolean, core = true): Reason => ({ label, value, ok, core });
function newsAgree(c: Ctx, side: Side, hours = 48, minImpact = 3): { ok: boolean; value: string } {
  const want = side === "long" ? "bullish" : "bearish";
  const hit = (c.inp.news ?? []).filter((n) => n.impact >= minImpact && c.inp.nowMs - n.at <= hours * 3_600_000).find((n) => n.direction === want);
  return hit ? { ok: true, value: `"${hit.title.slice(0, 60)}" (impact ${hit.impact}, ${want})` } : { ok: false, value: "no tagged headline agrees" };
}
function confirmations(c: Ctx, side: Side, extra: Reason[] = []): Reason[] {
  const out: Reason[] = [...extra];
  if (c.rs20 !== null) out.push(R("Relative strength vs SPY", `20-day ${pct(c.rs20)} vs the index`, side === "long" ? c.rs20 > 0 : c.rs20 < 0, false));
  if (c.volRatio !== null) out.push(R("Volume", `${c.volRatio.toFixed(1)}× the 20-day average`, c.volRatio >= 1.2, false));
  const n = newsAgree(c, side); out.push(R("News agrees", n.value, n.ok, false));
  if (c.isPerp && c.inp.riskOn !== null && c.inp.riskOn !== undefined) out.push(R("Risk appetite", c.inp.riskOn ? "risk-on (SPY above its 200-day, VIX not high)" : "risk-off", side === "long" ? c.inp.riskOn : !c.inp.riskOn, false));
  return out;
}
function make(c: Ctx, strategy: string, side: Side, stop: number, target: number, reasons: Reason[], invalidation: string, horizon: { hours?: number; days?: number }): Setup | null {
  const def = strategyDef(strategy)!;
  const entry = c.price;
  const dist = Math.abs(entry - stop);
  if (!(entry > 0) || !(dist > 0) || (side === "long" ? !(stop < entry && target > entry) : !(stop > entry && target < entry))) return null;
  if (c.atrD !== null && dist < 0.3 * c.atrD) return null; // a stop tighter than that is noise
  const core = reasons.filter((r) => r.core);
  if (core.some((r) => !r.ok)) return null;
  const conf = reasons.filter((r) => !r.core);
  const score = conf.length ? conf.filter((r) => r.ok).length / conf.length : 0.5;
  return {
    strategy, symbol: c.inp.symbol, venue: c.inp.venue, instrument: c.inp.instrument, side, timeframe: def.timeframe,
    entry_ref: entry, stop, target, leverage_hint: c.isPerp ? Math.min(def.leverage, c.inp.maxLeverage ?? def.leverage) : 1,
    horizon_hours: horizon.hours ?? null, horizon_days: horizon.days ?? null, score, reasons, invalidation, atr: c.atrD,
    snapshot: { price: c.price, prev_close: c.prevClose, sma20: c.sma20, sma50: c.sma50, sma200: c.sma200, ema20: c.ema20, rsi14: c.rsi14, rsi2: c.rsi2, atr: c.atrD, hi20: c.hi20, lo20: c.lo20, vol_ratio: c.volRatio, week10: c.w10, week40: c.w40, rs20: c.rs20, momentum_12_1: c.mom, funding: c.inp.funding ?? null, weekly_trend: c.weeklyUp ? "up" : c.weeklyDown ? "down" : "mixed", daily_trend: c.dailyUp ? "up" : c.dailyDown ? "down" : "mixed" },
  };
}

function trendPullback(c: Ctx, side: Side): Setup | null {
  if (c.ema20 === null || c.atrD === null || c.rsi14 === null || c.sma50 === null || c.sma200 === null) return null;
  const long = side === "long";
  const nearEma = Math.abs(c.price - c.ema20) <= c.atrD;
  const closedWith = long ? c.last.c > c.d[c.d.length - 2].c : c.last.c < c.d[c.d.length - 2].c;
  const reasons = [
    R(long ? "Daily trend up" : "Daily trend down", `close ${px(c.price)} ${long ? ">" : "<"} 50-day ${px(c.sma50)} ${long ? ">" : "<"} 200-day ${px(c.sma200)}, 50-day ${long ? "rising" : "falling"}`, long ? c.dailyUp : c.dailyDown),
    R("Weekly trend agrees", c.w10 !== null && c.w40 !== null ? `10-week ${px(c.w10)} vs 40-week ${px(c.w40)}` : "not enough weeks", long ? c.weeklyUp === true : c.weeklyDown === true),
    R("Pullback to the 20-day EMA", `price ${px(c.price)}, EMA20 ${px(c.ema20)}, gap ${(Math.abs(c.price - c.ema20) / c.atrD).toFixed(2)} ATR`, nearEma),
    R("RSI(14) in the pause zone", `${c.rsi14.toFixed(0)} (${long ? "35–55" : "45–65"})`, long ? c.rsi14 >= 35 && c.rsi14 <= 55 : c.rsi14 >= 45 && c.rsi14 <= 65),
    R(long ? "Today closed up" : "Today closed down", `${px(c.d[c.d.length - 2].c)} → ${px(c.last.c)}`, closedWith),
  ];
  const last3 = c.d.slice(-3);
  const stop = long ? lo(last3) - 0.5 * c.atrD : hi(last3) + 0.5 * c.atrD;
  const risk = Math.abs(c.price - stop);
  const target = long ? Math.max(c.price + 2 * risk, c.hi20) : Math.min(c.price - 2 * risk, c.lo20);
  return make(c, "trend-pullback", side, stop, target, [...reasons, ...confirmations(c, side)], long ? `a close below ${px(stop)} (the trend's own low)` : `a close above ${px(stop)}`, { days: 10 });
}
function breakout(c: Ctx, side: Side): Setup | null {
  if (c.atrD === null || c.sma20 === null || c.volRatio === null || c.d.length < 22) return null;
  const long = side === "long";
  const prior = c.closes.slice(-21, -1);
  const level = long ? Math.max(...prior) : Math.min(...prior);
  const isNew = long ? c.last.c > level : c.last.c < level;
  const extended = long ? c.price - c.sma20 : c.sma20 - c.price;
  const reasons = [
    R(long ? "New 20-day closing high" : "New 20-day closing low", `close ${px(c.last.c)} vs the prior 20-day ${long ? "high" : "low"} ${px(level)}`, isNew),
    R("Volume confirms", `${c.volRatio.toFixed(1)}× the 20-day average (need 1.5×)`, c.volRatio >= 1.5),
    R("Not extended", `${(extended / c.atrD).toFixed(1)} ATR from the 20-day average (limit 3)`, extended < 3 * c.atrD),
    R("Weekly trend agrees", c.w10 !== null && c.w40 !== null ? `10-week ${px(c.w10)} vs 40-week ${px(c.w40)}` : "not enough weeks", long ? c.weeklyUp === true : c.weeklyDown === true),
  ];
  const stop = long ? level - c.atrD : level + c.atrD;
  const risk = Math.abs(c.price - stop);
  const target = long ? c.price + 2.5 * risk : c.price - 2.5 * risk;
  return make(c, "breakout", side, stop, target, [...reasons, ...confirmations(c, side)], `a close back ${long ? "below" : "above"} ${px(level)}, the old ${long ? "ceiling" : "floor"}`, { days: 15 });
}
function rsi2Reversion(c: Ctx, side: Side): Setup | null {
  if (c.atrD === null || c.sma200 === null || c.rsi2 === null) return null;
  const long = side === "long";
  const reasons = [
    R(long ? "Long-term uptrend" : "Long-term downtrend", `close ${px(c.price)} ${long ? ">" : "<"} 200-day ${px(c.sma200)}`, long ? c.price > c.sma200 : c.price < c.sma200),
    R(long ? "Two-day washout" : "Two-day blow-off", `RSI(2) = ${c.rsi2.toFixed(0)} (${long ? "below 10" : "above 90"})`, long ? c.rsi2 < 10 : c.rsi2 > 90),
  ];
  const stop = long ? c.price - 2 * c.atrD : c.price + 2 * c.atrD;
  const risk = 2 * c.atrD;
  const target = long ? c.price + 1.5 * risk : c.price - 1.5 * risk;
  return make(c, "rsi2-reversion", side, stop, target, [...reasons, ...confirmations(c, side)], "five days pass without the snap-back, or the 200-day gives way", { days: 5 });
}
function cryptoMomentum(c: Ctx, side: Side): Setup | null {
  if (!c.isPerp || !c.inp.fourHour || c.inp.fourHour.length < 60 || !c.inp.hourly || c.inp.hourly.length < 30 || c.sma20 === null || c.sma50 === null) return null;
  const long = side === "long";
  const h4 = c.inp.fourHour, h1 = c.inp.hourly;
  const h4c = h4.map((b) => b.c); const e21 = ema(h4c, 21), e55 = ema(h4c, 55);
  const l4 = h4c[h4c.length - 1], E21 = e21[e21.length - 1], E55 = e55[e55.length - 1];
  const h1c = h1.map((b) => b.c); const e21h = ema(h1c, 21); const E21h = e21h[e21h.length - 1]; const atrH = atr(h1, 14) ?? 0;
  const f = c.inp.funding ?? null;
  const reasons = [
    R(long ? "4-hour trend up" : "4-hour trend down", `EMA21 ${px(E21)} vs EMA55 ${px(E55)}, price ${px(l4)}`, long ? E21 > E55 && l4 > E21 : E21 < E55 && l4 < E21),
    R(long ? "Daily trend up" : "Daily trend down", `close ${px(c.price)}, 20-day ${px(c.sma20)}, 50-day ${px(c.sma50)}`, long ? c.price > c.sma20 && c.sma20 > c.sma50 : c.price < c.sma20 && c.sma20 < c.sma50),
    R("Funding calm", f === null ? "no funding rate" : `${(f * 100).toFixed(3)}% per 8h (want −0.05% to +0.05%)`, f !== null && Math.abs(f) <= 0.0005),
    R("Hourly pullback to EMA21", atrH > 0 ? `price ${px(c.price)}, hourly EMA21 ${px(E21h)}, ${(Math.abs(c.price - E21h) / atrH).toFixed(2)} hourly ATR` : "no hourly ATR", atrH > 0 && Math.abs(c.price - E21h) <= atrH),
  ];
  const a4 = atr(h4, 14) ?? 0;
  const last12 = h4.slice(-12);
  const stop = long ? lo(last12) - 0.5 * a4 : hi(last12) + 0.5 * a4;
  const risk = Math.abs(c.price - stop);
  const target = long ? c.price + 2 * risk : c.price - 2 * risk;
  return make(c, "crypto-momentum", side, stop, target, [...reasons, ...confirmations(c, side)], `a 4-hour close ${long ? "below" : "above"} ${px(stop)} or funding past ±0.1%`, { hours: 72 });
}
function attentionSpike(c: Ctx): Setup | null {
  const fm = c.inp.fiveMin;
  if (!fm || fm.length < 12 || c.atrD === null) return null;
  const spike = (c.inp.news ?? []).filter((n) => n.impact >= 4 && c.inp.nowMs - n.at <= 2 * 3_600_000).sort((a, b) => b.impact - a.impact)[0];
  const last6 = fm.slice(-6);
  const vol30 = last6.reduce((a, b) => a + b.v, 0);
  const v20 = sma(c.d.map((b) => b.v), 20) ?? 0;
  const normal30 = v20 / (c.isPerp ? 48 : 13);
  const move = c.price / c.prevClose - 1;
  const moveAtr = Math.abs(c.price - c.prevClose) / c.atrD;
  const side: Side = spike && spike.direction === "bearish" ? "short" : spike && spike.direction === "bullish" ? "long" : move >= 0 ? "long" : "short";
  if (side === "short" && !c.isPerp && c.inp.instrument === "crypto_spot") return null;
  const quantitative = spike ? ["earnings", "guidance", "deal", "macro"].includes(spike.category) : false;
  const reasons = [
    R("Fresh high-impact headline", spike ? `"${spike.title.slice(0, 70)}" (impact ${spike.impact}, ${spike.direction}, ${Math.round((c.inp.nowMs - spike.at) / 60_000)}m ago)` : "none in the last two hours", !!spike),
    R("Volume surge", normal30 > 0 ? `${(vol30 / normal30).toFixed(1)}× the normal half hour` : "no volume baseline", normal30 > 0 && vol30 >= 3 * normal30),
    R("Real move", `${pct(move)} today = ${moveAtr.toFixed(1)} daily ATRs`, moveAtr >= 1.5),
    R("News type", quantitative ? "quantitative (drift): trade with the move" : "qualitative (fade risk): the jury decides the side", true, false),
  ];
  const a5 = atr(fm, 12) ?? c.atrD / 10;
  const stop = side === "long" ? lo(last6) - a5 : hi(last6) + a5;
  const risk = Math.abs(c.price - stop);
  const target = side === "long" ? c.price + 1.5 * risk : c.price - 1.5 * risk;
  return make(c, "attention-spike", side, stop, target, [...reasons, ...confirmations(c, side)], "the spike bar's extreme is taken out, or six hours pass", { hours: 6 });
}
function openingRangeBreak(c: Ctx, side: Side): Setup | null {
  const fm = c.inp.fiveMin, s = c.inp.session;
  if (!fm || !s || c.isPerp || c.inp.instrument === "crypto_spot") return null;
  const now = c.inp.nowMs;
  if (now < s.openMs + 30 * 60_000 || now > s.closeMs - 60 * 60_000) return null;
  const opening = fm.filter((b) => b.t >= s.openMs && b.t < s.openMs + 30 * 60_000);
  if (opening.length < 5) return null;
  const orHigh = hi(opening), orLow = lo(opening);
  const lastBar = fm[fm.length - 1];
  const avgOpenVol = opening.reduce((a, b) => a + b.v, 0) / opening.length;
  const long = side === "long";
  const reasons = [
    R(long ? "Break above the opening range" : "Break below the opening range", `last close ${px(lastBar.c)} vs range ${px(orLow)}–${px(orHigh)}`, long ? lastBar.c > orHigh : lastBar.c < orLow),
    R("Volume on the break", avgOpenVol > 0 ? `${(lastBar.v / avgOpenVol).toFixed(1)}× the opening bars' average` : "no volume", avgOpenVol > 0 && lastBar.v >= 1.5 * avgOpenVol),
    R(long ? "Daily trend up" : "Daily trend down", c.sma50 !== null && c.sma200 !== null ? `50-day ${px(c.sma50)}, 200-day ${px(c.sma200)}` : "not enough history", long ? c.dailyUp : c.dailyDown),
  ];
  const stop = (orHigh + orLow) / 2;
  const risk = Math.abs(c.price - stop);
  const target = long ? c.price + 2 * risk : c.price - 2 * risk;
  return make(c, "opening-range-break", side, stop, target, [...reasons, ...confirmations(c, side)], "back inside the opening range, or the close", { hours: 6 });
}
function fundingFade(c: Ctx): Setup | null {
  const f = c.inp.funding ?? null;
  if (!c.isPerp || f === null || c.atrD === null) return null;
  const side: Side = f >= 0.001 ? "short" : f <= -0.001 ? "long" : "long";
  const atExtreme = side === "short" ? c.price >= 0.98 * c.hi20 : c.price <= 1.02 * c.lo20;
  const reasons = [
    R("Funding extreme", `${(f * 100).toFixed(3)}% per 8h (need beyond ±0.10%)`, Math.abs(f) >= 0.001),
    R(side === "short" ? "At a 20-day high" : "At a 20-day low", `price ${px(c.price)} vs ${side === "short" ? px(c.hi20) : px(c.lo20)}`, atExtreme),
  ];
  const stop = side === "long" ? c.price - 1.5 * c.atrD : c.price + 1.5 * c.atrD;
  const risk = 1.5 * c.atrD;
  const target = side === "long" ? c.price + 2 * risk : c.price - 2 * risk;
  return make(c, "funding-extreme-fade", side, stop, target, [...reasons, ...confirmations(c, side)], "funding normalises without the price turning, or the stop", { hours: 72 });
}
function weeklyPosition(c: Ctx, side: Side): Setup | null {
  if (c.atrD === null || c.sma50 === null || c.mom === null || c.inp.momentumRank === null || c.inp.momentumRank === undefined) return null;
  const long = side === "long";
  const rank = c.inp.momentumRank;
  const reasons = [
    R(long ? "Top-decile momentum" : "Bottom-decile momentum", `12-1 return ${pct(c.mom)}, rank ${(rank * 100).toFixed(0)}th percentile of the universe`, long ? rank >= 0.9 : rank <= 0.1),
    R(long ? "Weekly trend up" : "Weekly trend down", c.w10 !== null && c.w40 !== null ? `10-week ${px(c.w10)} vs 40-week ${px(c.w40)}` : "not enough weeks", long ? c.weeklyUp === true : c.weeklyDown === true),
    R(long ? "Above the 10-week average" : "Below the 10-week average", `price ${px(c.price)} vs ${px(c.sma50)}`, long ? c.price > c.sma50 : c.price < c.sma50),
  ];
  const stop = long ? c.sma50 - 2.5 * c.atrD : c.sma50 + 2.5 * c.atrD;
  const risk = Math.abs(c.price - stop);
  const target = long ? c.price + 3 * risk : c.price - 3 * risk;
  return make(c, "weekly-trend-position", side, stop, target, [...reasons, ...confirmations(c, side)], "a weekly close through the 10-week average", { days: 40 });
}

export function scanSymbol(inp: ScanInput, enabled?: Set<string>): Setup[] {
  const c = context(inp);
  if (!c) return [];
  const on = (id: string) => !enabled || enabled.has(id);
  const canShort = inp.instrument !== "crypto_spot";
  const out: (Setup | null)[] = [];
  if (on("trend-pullback")) { out.push(trendPullback(c, "long")); if (canShort) out.push(trendPullback(c, "short")); }
  if (on("breakout")) { out.push(breakout(c, "long")); if (canShort) out.push(breakout(c, "short")); }
  if (on("rsi2-reversion")) { out.push(rsi2Reversion(c, "long")); if (canShort) out.push(rsi2Reversion(c, "short")); }
  if (on("crypto-momentum") && c.isPerp) { out.push(cryptoMomentum(c, "long")); out.push(cryptoMomentum(c, "short")); }
  if (on("attention-spike")) out.push(attentionSpike(c));
  if (on("opening-range-break")) { out.push(openingRangeBreak(c, "long")); out.push(openingRangeBreak(c, "short")); }
  if (on("funding-extreme-fade") && c.isPerp) out.push(fundingFade(c));
  if (on("weekly-trend-position")) { out.push(weeklyPosition(c, "long")); if (canShort) out.push(weeklyPosition(c, "short")); }
  return out.filter((s): s is Setup => !!s);
}

// Momentum percentile of one value inside a universe (0 = weakest, 1 = strongest).
export function percentile(value: number, universe: number[]): number {
  if (!universe.length) return 0.5;
  const below = universe.filter((x) => x < value).length;
  return below / universe.length;
}
