// The Desk — risk rules. Pure. "Conviction requests, risk disposes": the
// models propose, this file decides the size, and nothing here can be talked
// out of a limit by a prompt.
import type { InstrumentMeta, Plan, PresetKey, Rules, Side, Trade } from "./types";
import { unitValue } from "./types";
import { addDays, nextSessionDate } from "./clock";

export type GuardCtx = {
  equity: number; rules: Rules; open: Trade[]; atr: number | null; meta: InstrumentMeta; halted: boolean;
  themeOf: (symbol: string) => string; drawdownHalved: boolean; newTonight: number;
};

export const PRESETS: Record<PresetKey, Rules> = {
  aggressive:      { risk_pct: 3,   max_notional_pct: 100, max_open: 4, gross_cap_pct: 200, max_leverage: 10, daily_halt_pct: 6, weekly_pause_pct: 12, heat_cap_pct: 12, max_new_per_night: 2, min_rr: 1.5, min_stop_atr: 0.5, liq_buffer: 0.2 },
  very_aggressive: { risk_pct: 5,   max_notional_pct: 200, max_open: 4, gross_cap_pct: 400, max_leverage: 25, daily_halt_pct: 8, weekly_pause_pct: 15, heat_cap_pct: 15, max_new_per_night: 2, min_rr: 1.5, min_stop_atr: 0.5, liq_buffer: 0.2 },
  moderate:        { risk_pct: 1.5, max_notional_pct: 25,  max_open: 5, gross_cap_pct: 100, max_leverage: 3,  daily_halt_pct: 4, weekly_pause_pct: 8,  heat_cap_pct: 6,  max_new_per_night: 2, min_rr: 1.5, min_stop_atr: 0.5, liq_buffer: 0.2 },
};

export function rulesFor(preset: PresetKey, overrides?: Partial<Rules>): Rules {
  const base = { ...(PRESETS[preset] ?? PRESETS.aggressive) };
  if (overrides) {
    for (const k of Object.keys(base) as (keyof Rules)[]) {
      const v = overrides[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) base[k] = v;
    }
  }
  return base;
}

export type Sizing = { qty: number; unit: Trade["unit"]; notional: number; margin: number; leverage: number; risk_usd: number; capped_by: string[] };

const ZERO: Sizing = { qty: 0, unit: "share", notional: 0, margin: 0, leverage: 1, risk_usd: 0, capped_by: ["invalid"] };

export function sizePosition(plan: Plan, equity: number, rules: Rules, meta: InstrumentMeta, opts?: { drawdownHalved?: boolean }): Sizing {
  const entry = plan.entry_ref;
  const dist = Math.abs(entry - plan.stop);
  if (!(entry > 0) || !(dist > 0) || !(equity > 0)) return ZERO;
  const riskPct = Math.min(plan.risk_pct > 0 ? plan.risk_pct : rules.risk_pct, rules.risk_pct);
  let riskUsd = (equity * riskPct) / 100;
  if (opts?.drawdownHalved) riskUsd /= 2;
  let units = riskUsd / dist;
  const capped: string[] = [];
  const maxNotional = (equity * rules.max_notional_pct) / 100;
  if (units * entry > maxNotional) { units = maxNotional / entry; capped.push("max_notional"); }

  if (plan.instrument === "crypto_perp") {
    const wanted = plan.leverage > 0 ? plan.leverage : 1;
    let lev = Math.min(wanted, rules.max_leverage, meta.max_leverage > 0 ? meta.max_leverage : 1);
    if (lev < wanted) capped.push("leverage");
    lev = Math.max(1, lev);
    const cv = meta.contract_value > 0 ? meta.contract_value : 1;
    const lot = meta.lot_size > 0 ? meta.lot_size : 1;
    const contracts = Math.floor(units / cv / lot) * lot;
    const notional = contracts * cv * entry;
    return { qty: contracts, unit: "contract", notional, margin: notional / lev, leverage: lev, risk_usd: contracts * cv * dist, capped_by: capped };
  }
  if (plan.instrument === "crypto_spot") {
    const q = Math.round(units * 1e6) / 1e6;
    const notional = q * entry;
    return { qty: q, unit: "coin", notional, margin: notional, leverage: 1, risk_usd: q * dist, capped_by: capped };
  }
  const shares = Math.floor(units);
  const notional = shares * entry;
  return { qty: shares, unit: "share", notional, margin: notional, leverage: 1, risk_usd: shares * dist, capped_by: capped };
}

export function liqPrice(entry: number, side: Side, leverage: number, mm = 0.005): number {
  const move = 1 / Math.max(1, leverage) - mm;
  return side === "long" ? entry * (1 - move) : entry * (1 + move);
}

export type GuardResult = { ok: boolean; plan: Plan; sizing: Sizing | null; reasons: string[] };

function openRisk(t: Trade): number {
  const entry = t.entry_price ?? t.entry_ref;
  return Math.abs(entry - t.stop) * t.qty * unitValue(t);
}

export function guardrail(plan: Plan, ctx: GuardCtx): GuardResult {
  const fail = (why: string): GuardResult => ({ ok: false, plan, sizing: null, reasons: [why] });
  const { rules } = ctx;
  if (ctx.halted) return fail("the account is halted; nothing new is queued");
  const dir = plan.side === "long" ? 1 : -1;
  if (!(plan.entry_ref > 0) || !(plan.stop > 0) || !(plan.target > 0)) return fail("entry, stop and target must be positive prices");
  if ((plan.stop - plan.entry_ref) * dir >= 0) return fail("stop is on the wrong side of entry");
  if ((plan.target - plan.entry_ref) * dir <= 0) return fail("target is on the wrong side of entry");
  const dist = Math.abs(plan.entry_ref - plan.stop);
  const rr = Math.abs(plan.target - plan.entry_ref) / dist;
  if (rr < rules.min_rr) return fail(`reward:risk ${rr.toFixed(2)} is below ${rules.min_rr}`);
  if (ctx.atr !== null && ctx.atr > 0 && dist < rules.min_stop_atr * ctx.atr) return fail(`stop is inside ${rules.min_stop_atr} ATR of entry`);
  const live = ctx.open.filter((o) => o.status === "open" || o.status === "pending");
  if (live.some((o) => o.symbol === plan.symbol)) return fail(`${plan.symbol} is already open`);
  if (ctx.newTonight >= rules.max_new_per_night) return fail(`already ${rules.max_new_per_night} new positions tonight`);
  if (live.length >= rules.max_open) return fail(`already ${rules.max_open} positions open`);
  const theme = ctx.themeOf(plan.symbol);
  if (live.filter((o) => ctx.themeOf(o.symbol) === theme).length >= 2) return fail(`two positions already ride the "${theme}" theme`);

  const reasons: string[] = [];
  const p: Plan = { ...plan };
  if (p.risk_pct > rules.risk_pct) { p.risk_pct = rules.risk_pct; reasons.push(`risk clipped to ${rules.risk_pct}%`); }
  if (p.instrument === "crypto_perp") {
    const start = Math.min(p.leverage > 0 ? p.leverage : 1, rules.max_leverage, ctx.meta.max_leverage > 0 ? ctx.meta.max_leverage : 1);
    let lev = Math.max(1, start);
    while (lev > 1 && Math.abs(p.entry_ref - liqPrice(p.entry_ref, p.side, lev)) < dist * (1 + rules.liq_buffer)) lev = Math.ceil(lev) - 1;
    if (lev < (p.leverage > 0 ? p.leverage : 1)) reasons.push(`leverage cut to ${lev}x so the stop sits inside the liquidation price`);
    p.leverage = lev;
  } else {
    p.leverage = 1;
  }
  const sizing = sizePosition(p, ctx.equity, rules, ctx.meta, { drawdownHalved: ctx.drawdownHalved });
  if (!(sizing.qty > 0)) return fail("size rounds to zero");
  if (sizing.capped_by.includes("max_notional")) reasons.push(`notional capped at ${rules.max_notional_pct}% of equity`);
  if (ctx.drawdownHalved) reasons.push("size halved: the book is more than 10% below its peak");
  const gross = live.reduce((a, o) => a + (o.notional ?? 0), 0) + sizing.notional;
  if (gross > (ctx.equity * rules.gross_cap_pct) / 100) return fail(`gross exposure would reach ${((gross / ctx.equity) * 100).toFixed(0)}% of equity (cap ${rules.gross_cap_pct}%)`);
  const heat = live.reduce((a, o) => a + openRisk(o), 0) + sizing.risk_usd;
  if (heat > (ctx.equity * rules.heat_cap_pct) / 100) return fail(`open risk would reach ${((heat / ctx.equity) * 100).toFixed(1)}% of equity (heat cap ${rules.heat_cap_pct}%)`);
  return { ok: true, plan: p, sizing, reasons };
}

export function haltCheck(input: { equity: number; equityYesterday: number | null; equityWeekStart: number | null; rules: Rules; today: string }): { halt: boolean; until: string; reason: string } {
  const { equity, rules, today } = input;
  if (input.equityWeekStart && input.equityWeekStart > 0 && equity / input.equityWeekStart - 1 <= -rules.weekly_pause_pct / 100) {
    return { halt: true, until: addDays(today, 7), reason: `down ${((1 - equity / input.equityWeekStart) * 100).toFixed(1)}% on the week — paused a week; the coach reviews before it resumes` };
  }
  if (input.equityYesterday && input.equityYesterday > 0 && equity / input.equityYesterday - 1 <= -rules.daily_halt_pct / 100) {
    return { halt: true, until: nextSessionDate(today), reason: `down ${((1 - equity / input.equityYesterday) * 100).toFixed(1)}% today — no new entries next session` };
  }
  return { halt: false, until: "", reason: "" };
}

export function drawdownHalved(peakEquity: number, equity: number): boolean {
  return peakEquity > 0 && equity <= 0.9 * peakEquity;
}

export function ladderState(closedDeskTrades: Pick<Trade, "r_multiple">[]): { unlocked: boolean; n: number; expectancy: number | null } {
  const rs = closedDeskTrades.map((t) => t.r_multiple).filter((r): r is number => typeof r === "number" && Number.isFinite(r));
  const last = rs.slice(-20);
  const exp = last.length ? last.reduce((a, b) => a + b, 0) / last.length : null;
  return { unlocked: rs.length >= 20 && exp !== null && exp > 0, n: rs.length, expectancy: exp };
}
