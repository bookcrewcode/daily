import type { Trade } from "./types.ts";
export type TradeStats = {
  n: number; wins: number; winRate: number | null; avgWin: number | null; avgLoss: number | null; payoff: number | null;
  profitFactor: number | null; expectancyR: number | null; expectancyUsd: number | null; avgHoldDays: number | null;
  tStat: number | null; sqn: number | null;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sampleSd = (xs: number[]) => {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
export function tradeStats(trades: Pick<Trade, "pnl" | "r_multiple" | "entry_at" | "exit_at">[]): TradeStats {
  const closed = trades.filter((t) => typeof t.pnl === "number" && Number.isFinite(t.pnl));
  const pnls = closed.map((t) => t.pnl as number);
  const rs = closed.map((t) => t.r_multiple).filter((r): r is number => typeof r === "number" && Number.isFinite(r));
  const winsArr = pnls.filter((p) => p > 0), lossArr = pnls.filter((p) => p < 0);
  const grossWin = winsArr.reduce((a, b) => a + b, 0), grossLoss = -lossArr.reduce((a, b) => a + b, 0);
  const holds = closed
    .filter((t) => t.entry_at && t.exit_at)
    .map((t) => (Date.parse(t.exit_at!) - Date.parse(t.entry_at!)) / 86_400_000)
    .filter((d) => Number.isFinite(d));
  const avgWin = mean(winsArr), avgLoss = lossArr.length ? grossLoss / lossArr.length : null;
  const t = tstat(rs);
  const sdR = sampleSd(rs);
  return {
    n: closed.length, wins: winsArr.length,
    winRate: closed.length ? winsArr.length / closed.length : null,
    avgWin, avgLoss,
    payoff: avgWin !== null && avgLoss !== null && avgLoss > 0 ? avgWin / avgLoss : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancyR: mean(rs), expectancyUsd: mean(pnls), avgHoldDays: mean(holds),
    tStat: t, sqn: rs.length >= 2 && sdR !== null && sdR > 0 ? (Math.sqrt(rs.length) * mean(rs)!) / sdR : null,
  };
}
export type CurveStats = { totalReturn: number; maxDrawdown: number; ddDays: number; sharpeDaily: number | null; sharpeAnnual: number | null; days: number };
export function curveStats(equity: number[], periodsPerYear = 252): CurveStats {
  if (equity.length < 2) return { totalReturn: 0, maxDrawdown: 0, ddDays: 0, sharpeDaily: null, sharpeAnnual: null, days: equity.length };
  let peak = equity[0], mdd = 0, run = 0, longest = 0;
  for (const e of equity) {
    if (e >= peak) { peak = e; run = 0; } else { run++; longest = Math.max(longest, run); mdd = Math.max(mdd, (peak - e) / peak); }
  }
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1);
  const sd = sampleSd(rets);
  const sharpeDaily = sd !== null && sd > 0 ? mean(rets)! / sd : null;
  return {
    totalReturn: equity[0] > 0 ? equity[equity.length - 1] / equity[0] - 1 : 0,
    maxDrawdown: mdd, ddDays: longest, sharpeDaily,
    sharpeAnnual: sharpeDaily === null ? null : sharpeDaily * Math.sqrt(periodsPerYear),
    days: equity.length,
  };
}
export function brier(preds: { p: number; won: boolean }[]): number | null {
  if (!preds.length) return null;
  return preds.reduce((a, x) => a + (x.p - (x.won ? 1 : 0)) ** 2, 0) / preds.length;
}
export const CALIB_BINS = ["<0.5", "0.5-0.6", "0.6-0.7", "0.7-0.8", "0.8-0.9", "0.9-1.0"];
export function binOf(p: number): string {
  if (p < 0.5) return "<0.5";
  if (p < 0.6) return "0.5-0.6";
  if (p < 0.7) return "0.6-0.7";
  if (p < 0.8) return "0.7-0.8";
  if (p < 0.9) return "0.8-0.9";
  return "0.9-1.0";
}
export type CalibBin = { bin: string; n: number; hit: number | null };
export function calibration(preds: { p: number; won: boolean }[]): CalibBin[] {
  const acc = new Map<string, { n: number; w: number }>();
  for (const b of CALIB_BINS) acc.set(b, { n: 0, w: 0 });
  for (const x of preds) { const a = acc.get(binOf(x.p))!; a.n++; if (x.won) a.w++; }
  return CALIB_BINS.map((b) => { const a = acc.get(b)!; return { bin: b, n: a.n, hit: a.n ? a.w / a.n : null }; });
}
export function calibratedConfidence(p: number, calib: CalibBin[], minN = 20): number {
  const b = calib.find((x) => x.bin === binOf(p));
  if (!b || !b.n || b.hit === null) return p;
  return p * (minN / (b.n + minN)) + b.hit * (b.n / (b.n + minN));
}
export function eloUpdate(ra: number, rb: number, scoreA: 0 | 0.5 | 1, k: number): { ra: number; rb: number } {
  const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  return { ra: ra + k * (scoreA - ea), rb: rb + k * ((1 - scoreA) - (1 - ea)) };
}
export function eloK(nMatches: number): number { return nMatches < 30 ? 32 : 16; }
export function shrink(m: number, n: number, priorMean = 0, priorN = 20): number {
  return (n * m + priorN * priorMean) / (n + priorN);
}
export function tstat(values: number[]): number | null {
  if (values.length < 3) return null;
  const sd = sampleSd(values);
  if (sd === null || sd === 0) return null;
  return mean(values)! / (sd / Math.sqrt(values.length));
}
export function tradesToDetect(hitRate: number, base = 0.5, z = 1.96): number {
  const diff = Math.abs(hitRate - base);
  if (!(diff > 0)) return Infinity;
  return Math.ceil(((z * Math.sqrt(base * (1 - base))) / diff) ** 2);
}
/* ── the standard: perform or be replaced ──────────────────────────────── */
export type CutRules = {
  min_trades: number;    // scored shadow trades before a nightly juror is judged
  min_sits: number;      // scored sit ballots before a sit juror is judged
  max_loss_pct: number;  // shadow book this far below its start → cut
  min_r: number;         // shrunk mean R per trade at or below this → cut
  max_brier: number;     // Brier at or above this → cut (0.25 is a coin flip)
  min_elo: number;       // Elo at or below this → cut
  min_sit_right: number; // share of sit ballots on the right side, at or below this → cut
};
export const DEFAULT_CUT_RULES: CutRules = { min_trades: 12, min_sits: 30, max_loss_pct: 10, min_r: -0.15, max_brier: 0.3, min_elo: 1440, min_sit_right: 0.4 };
export type StandingInput = {
  seat: "nightly" | "sit"; elo: number; n_trades: number; sum_r: number; brier_sum: number; brier_n: number;
  n_sits: number; n_sit_right: number; equity: number | null; start?: number;
};
export type Standing = { label: "fresh" | "meeting the standard" | "on notice" | "cut"; reasons: string[]; sample: number; needed: number };
export function standingOf(x: StandingInput, rules: CutRules = DEFAULT_CUT_RULES): Standing {
  const nightly = x.seat === "nightly";
  const sample = nightly ? x.n_trades : x.n_sits;
  const needed = nightly ? rules.min_trades : rules.min_sits;
  if (sample < needed) return { label: "fresh", reasons: [`${sample} of ${needed} scored ${nightly ? "trades" : "sits"} before the standard applies`], sample, needed };
  const cut: string[] = [], notice: string[] = [];
  const test = (v: number | null, cutAt: number, noticeAt: number, worseIsHigher: boolean, text: (v: number) => string) => {
    if (v === null || !Number.isFinite(v)) return;
    const bad = worseIsHigher ? v >= cutAt : v <= cutAt;
    const warn = worseIsHigher ? v >= noticeAt : v <= noticeAt;
    if (bad) cut.push(text(v)); else if (warn) notice.push(text(v));
  };
  if (nightly) {
    const start = x.start ?? 100000;
    const loss = x.equity === null ? null : (1 - x.equity / start) * 100;
    test(loss, rules.max_loss_pct, rules.max_loss_pct / 2, true, (v) => `book ${v.toFixed(1)}% below its start`);
    const meanR = x.n_trades ? shrink(x.sum_r / x.n_trades, x.n_trades) : null;
    test(meanR, rules.min_r, rules.min_r / 2, false, (v) => `shrunk R ${v.toFixed(2)} per trade`);
  } else {
    const right = x.n_sits ? x.n_sit_right / x.n_sits : null;
    test(right, rules.min_sit_right, (rules.min_sit_right + 0.5) / 2, false, (v) => `right on ${(v * 100).toFixed(0)}% of its sits`);
  }
  const brier = x.brier_n > 0 ? x.brier_sum / x.brier_n : null;
  test(brier, rules.max_brier, (rules.max_brier + 0.25) / 2, true, (v) => `Brier ${v.toFixed(2)} (0.25 is a coin flip)`);
  test(x.elo, rules.min_elo, (rules.min_elo + 1500) / 2, false, (v) => `Elo ${Math.round(v)}`);
  if (cut.length) return { label: "cut", reasons: cut, sample, needed };
  if (notice.length) return { label: "on notice", reasons: notice, sample, needed };
  return { label: "meeting the standard", reasons: [], sample, needed };
}
