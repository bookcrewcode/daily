import type { PresetKey, Rules, Side, Trade } from "./types.ts";
import { addDays, nextSessionDate } from "./clock.ts";
export const PRESETS: Record<PresetKey, Rules> = {
  aggressive:      { risk_pct: 3,   max_notional_pct: 100, max_open: 10, gross_cap_pct: 500,  max_leverage: 10,  daily_halt_pct: 6,   weekly_pause_pct: 12,  heat_cap_pct: 30,   max_new_per_night: 99,  min_rr: 1.5, min_stop_atr: 0.5, liq_buffer: 0.2, max_per_theme: 3 },
  very_aggressive: { risk_pct: 5,   max_notional_pct: 200, max_open: 10, gross_cap_pct: 800,  max_leverage: 25,  daily_halt_pct: 8,   weekly_pause_pct: 15,  heat_cap_pct: 50,   max_new_per_night: 99,  min_rr: 1.5, min_stop_atr: 0.5, liq_buffer: 0.2, max_per_theme: 4 },
  moderate:        { risk_pct: 1.5, max_notional_pct: 25,  max_open: 5,  gross_cap_pct: 100,  max_leverage: 3,   daily_halt_pct: 4,   weekly_pause_pct: 8,   heat_cap_pct: 6,    max_new_per_night: 2,   min_rr: 1.5, min_stop_atr: 0.5, liq_buffer: 0.2, max_per_theme: 2 },
  no_limits:       { risk_pct: 5,   max_notional_pct: 300, max_open: 20, gross_cap_pct: 1000, max_leverage: 100, daily_halt_pct: 100, weekly_pause_pct: 100, heat_cap_pct: 1000, max_new_per_night: 999, min_rr: 1.2, min_stop_atr: 0.3, liq_buffer: 0.1, max_per_theme: 99 },
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
export function liqPrice(entry: number, side: Side, leverage: number, mm = 0.005): number {
  const move = 1 / Math.max(1, leverage) - mm;
  return side === "long" ? entry * (1 - move) : entry * (1 + move);
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
