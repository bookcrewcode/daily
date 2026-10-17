// Portfolio — the weekly Robinhood buy. Pure.
// Ben's recurring investment runs in Robinhood itself; the app only records it,
// as an "assumed" lot at the close of the first five-minute bar after the open
// (09:30–09:35 ET), which he can correct when Robinhood's fill differs.
// A buy day that is a market holiday moves to the next trading day.

import { addDays, etParts, isTradingDay, nextSessionDate, sessionBounds, weekStart } from "../desk/clock";
import type { Bar } from "../desk/types";

export type Recurring = { symbol: string; usd: number };
export type WeeklySettings = { recurring: Recurring[]; buyDow: number; since: string | null };
export type DueLot = { symbol: string; usd: number; day: string };

export const FIRST_BAR_MS = 5 * 60_000;
export const SETTLE_MS = 6 * 60_000; // the 09:30 bar is final by 09:36

export function buyDateForWeek(monday: string, buyDow: number): string {
  const d = addDays(monday, Math.min(5, Math.max(1, Math.round(buyDow))) - 1);
  return isTradingDay(d) ? d : nextSessionDate(d);
}

// Every weekly lot that should exist by now and doesn't: the buy days from
// lookbackDays ago through today, on or after the day the weekly buy was set up.
export function dueWeeklyLots(nowMs: number, s: WeeklySettings, existing: { symbol: string; day: string }[], lookbackDays = 14): DueLot[] {
  if (!s.since || !s.recurring.length) return [];
  const today = etParts(nowMs).date;
  const from = addDays(today, -lookbackDays);
  const have = new Set(existing.map((e) => `${e.symbol.toUpperCase()}|${e.day}`));
  const days = new Set<string>();
  for (let w = weekStart(from); w <= today; w = addDays(w, 7)) days.add(buyDateForWeek(w, s.buyDow));
  const out: DueLot[] = [];
  for (const day of [...days].sort()) {
    if (day < s.since || day < from || day > today) continue;
    const b = sessionBounds(day);
    if (!b || nowMs < b.openMs + SETTLE_MS) continue;
    for (const r of s.recurring) {
      const symbol = r.symbol.toUpperCase();
      if (!(r.usd > 0) || have.has(`${symbol}|${day}`)) continue;
      out.push({ symbol, usd: r.usd, day });
    }
  }
  return out;
}

export function firstFiveMinutePrice(bars: Bar[], day: string): number | null {
  const b = sessionBounds(day);
  if (!b) return null;
  const first = bars.find((x) => x.t >= b.openMs && x.t < b.openMs + FIRST_BAR_MS);
  return first && first.c > 0 ? first.c : null;
}

export function sharesFor(usd: number, price: number): number {
  if (!(usd > 0) || !(price > 0)) return 0;
  return Math.floor((usd / price) * 1e6) / 1e6;
}

// Midnight in New York on a date, as epoch ms (where "spent today" starts).
export function etMidnightMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const off = (etParts(Date.UTC(y, m - 1, d, 12)).hour - 12) * 3_600_000;
  return Date.UTC(y, m - 1, d) - off;
}

// The first buy day the app records, for a weekly buy saved now: today until today's 09:30 bar
// is final, then tomorrow (a buy made earlier today is already in the numbers Ben typed).
export function recurringSinceFor(nowMs: number): string {
  const today = etParts(nowMs).date;
  const b = sessionBounds(today);
  return b && nowMs >= b.openMs + SETTLE_MS ? addDays(today, 1) : today;
}
