import type { Bar, ExitReason, Instrument, Side, Trade } from "./types.ts";
import { isMajorCrypto, unitValue } from "./types.ts";
import { isNyseOpen } from "./clock.ts";
export const COSTS = {
  slip_bps: { stock_large: 5, stock_other: 15, crypto_major: 10, crypto_alt: 25, crypto_spot: 0 },
  spread_bps: { crypto_spot: 50 },
  perp_taker: 0.0006,
  sec_fee: 0.0000206,       // per $ sold, from 2026-04-04
  taf_per_share: 0.000195,  // FINRA TAF per share sold
  taf_cap: 9.79,
  maint_margin: 0.005,
  gap_doubling: 0.02,       // |gap| above this doubles stock slippage
};
export function slippageBps(instrument: Instrument, symbol: string, largeCap: boolean, gapPct: number): number {
  if (instrument === "crypto_spot") return COSTS.spread_bps.crypto_spot;
  if (instrument === "crypto_perp") return isMajorCrypto(symbol) ? COSTS.slip_bps.crypto_major : COSTS.slip_bps.crypto_alt;
  const base = largeCap ? COSTS.slip_bps.stock_large : COSTS.slip_bps.stock_other;
  return Math.abs(gapPct) > COSTS.gap_doubling ? base * 2 : base;
}
export function fillPrice(ref: number, side: Side, bps: number, action: "enter" | "exit"): number {
  const payUp = (side === "long") === (action === "enter");
  return payUp ? ref * (1 + bps / 10_000) : ref * (1 - bps / 10_000);
}
function sellSideFees(qty: number, notional: number): number {
  return notional * COSTS.sec_fee + Math.min(qty * COSTS.taf_per_share, COSTS.taf_cap);
}
export function entryFees(t: { instrument: Instrument; side: Side; qty: number; notional: number }): number {
  if (t.instrument === "crypto_perp") return t.notional * COSTS.perp_taker;
  if (t.instrument === "crypto_spot") return 0;
  return t.side === "short" ? sellSideFees(t.qty, t.notional) : 0;
}
export function exitFees(t: { instrument: Instrument; side: Side; qty: number; notional: number }): number {
  if (t.instrument === "crypto_perp") return t.notional * COSTS.perp_taker;
  if (t.instrument === "crypto_spot") return 0;
  return t.side === "long" ? sellSideFees(t.qty, t.notional) : 0;
}
export type ExitEvent = { reason: "stop" | "target" | "liquidated"; price: number; t: number; ambiguous: boolean };
export function scanBars(t: Pick<Trade, "side" | "stop" | "target" | "liq_price" | "instrument">, bars: Bar[]): ExitEvent | null {
  for (const b of bars) {
    if (t.side === "long") {
      if (t.liq_price !== null && t.liq_price > 0 && b.l <= t.liq_price) return { reason: "liquidated", price: t.liq_price, t: b.t, ambiguous: false };
      const stopHit = b.l <= t.stop, targetHit = b.h >= t.target;
      if (stopHit) return { reason: "stop", price: Math.min(b.o, t.stop), t: b.t, ambiguous: targetHit };
      if (targetHit) return { reason: "target", price: Math.max(b.o, t.target), t: b.t, ambiguous: false };
    } else {
      if (t.liq_price !== null && t.liq_price > 0 && b.h >= t.liq_price) return { reason: "liquidated", price: t.liq_price, t: b.t, ambiguous: false };
      const stopHit = b.h >= t.stop, targetHit = b.l <= t.target;
      if (stopHit) return { reason: "stop", price: Math.max(b.o, t.stop), t: b.t, ambiguous: targetHit };
      if (targetHit) return { reason: "target", price: Math.min(b.o, t.target), t: b.t, ambiguous: false };
    }
  }
  return null;
}
export function timeStopDue(t: Pick<Trade, "expires_on" | "instrument">, nowMs: number, nowEtDate: string): boolean {
  if (!t.expires_on) return false;
  if (t.instrument === "stock" || t.instrument === "etf") {
    if (t.expires_on.length === 10) return nowEtDate > t.expires_on && isNyseOpen(nowMs);
    const at = Date.parse(t.expires_on);
    return Number.isFinite(at) && nowMs >= at && isNyseOpen(nowMs);
  }
  const at = Date.parse(t.expires_on);
  return Number.isFinite(at) && nowMs >= at;
}
export function fundingCharge(notional: number, rate: number, side: Side): number {
  return notional * rate * (side === "long" ? 1 : -1);
}
export function unrealized(t: Pick<Trade, "side" | "qty" | "entry_price" | "unit" | "contract_value">, mark: number): number {
  const entry = t.entry_price ?? 0;
  return (mark - entry) * t.qty * unitValue(t) * (t.side === "long" ? 1 : -1);
}
export function positionValue(t: Trade, mark: number): number {
  if (t.instrument === "crypto_perp") return t.margin + unrealized(t, mark);
  const v = t.qty * mark;
  return t.side === "long" ? v : -v;
}
export type CloseResult = { exit_price: number; fees_total: number; pnl: number; pnl_pct: number; r_multiple: number; cash_delta: number };
export function closeTrade(t: Trade, exitRef: number, bps: number, reason: ExitReason): CloseResult {
  const liquidated = reason === "liquidated";
  const exit_price = liquidated ? (t.liq_price ?? exitRef) : fillPrice(exitRef, t.side, bps, "exit");
  const uv = unitValue(t);
  const exitNotional = t.qty * uv * exit_price;
  const fee = liquidated ? 0 : exitFees({ instrument: t.instrument, side: t.side, qty: t.qty, notional: exitNotional });
  const gross = unrealized(t, exit_price);
  const pnl = gross - t.fees - fee - t.funding;
  const denom = t.instrument === "crypto_perp" ? t.margin : t.notional;
  const entry = t.entry_price ?? t.entry_ref;
  const riskUsd = Math.abs(entry - t.stop) * t.qty * uv;
  let cash_delta: number;
  if (t.instrument === "crypto_perp") cash_delta = liquidated ? 0 : t.margin + gross - fee;
  else if (t.side === "long") cash_delta = exitNotional - fee;
  else cash_delta = -exitNotional - fee;
  return {
    exit_price, fees_total: t.fees + fee, pnl,
    pnl_pct: denom > 0 ? pnl / denom : 0,
    r_multiple: riskUsd > 0 ? pnl / riskUsd : 0,
    cash_delta,
  };
}
export function entryCashDelta(t: Trade): number {
  if (t.instrument === "crypto_perp") return -(t.margin + t.fees);
  if (t.side === "short") return t.notional - t.fees;
  return -(t.notional + t.fees);
}
export function bookEquity(startCash: number, closed: Pick<Trade, "pnl">[], open: Trade[], marks: Record<string, number>): { equity: number; marketValue: number; gross: number } {
  let equity = startCash;
  for (const c of closed) equity += c.pnl ?? 0;
  let marketValue = 0, gross = 0;
  for (const o of open) {
    if (o.status !== "open") continue;
    const mark = marks[o.symbol] ?? o.entry_price ?? o.entry_ref;
    equity += unrealized(o, mark) - o.fees - o.funding;
    marketValue += positionValue(o, mark);
    gross += o.notional;
  }
  return { equity, marketValue, gross };
}
export function excursions(t: Trade, bars: Bar[]): { mae_r: number; mfe_r: number } {
  const entry = t.entry_price ?? t.entry_ref;
  const risk = Math.abs(entry - t.stop);
  if (!(risk > 0) || !bars.length) return { mae_r: t.mae_r ?? 0, mfe_r: t.mfe_r ?? 0 };
  let worst = 0, best = 0;
  for (const b of bars) {
    const adverse = t.side === "long" ? b.l - entry : entry - b.h;
    const favorable = t.side === "long" ? b.h - entry : entry - b.l;
    worst = Math.min(worst, adverse);
    best = Math.max(best, favorable);
  }
  return { mae_r: Math.min(t.mae_r ?? 0, worst / risk), mfe_r: Math.max(t.mfe_r ?? 0, best / risk) };
}
