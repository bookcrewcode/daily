// Portfolio — what the five-minute tick starts. Pure.
// The cron fires at two minutes past each five-minute mark; the feed runs on
// the quarter (minutes 2–4 past :00, :15, :30, :45). Weekly lots cost nothing,
// so pausing the AI does not stop them.

import { etParts, isTradingDay } from "../desk/clock";

export type TickPlan = { feed: boolean; lots: boolean; report: boolean };

export const FEED_FROM = 7 * 60;      // overnight news is picked up by the 07:02 run
export const FEED_UNTIL = 22 * 60;
export const REPORT_AT = 8 * 60 + 30; // 08:30 New York
export const REPORT_UNTIL = 16 * 60;  // a morning report is not written after the close
export const LOTS_FROM = 9 * 60 + 36; // the 09:30 bar is final
export const LOTS_UNTIL = 20 * 60;

export function tickPlan(nowMs: number, o: { paused: boolean; budgetLeft: boolean; reportDue: boolean }): TickPlan {
  const p = etParts(nowMs);
  const min = p.hour * 60 + p.minute;
  const trading = isTradingDay(p.date);
  const quarter = p.minute % 15 >= 2 && p.minute % 15 <= 4;
  const ai = !o.paused && o.budgetLeft;
  return {
    feed: ai && quarter && min >= FEED_FROM && min < FEED_UNTIL,
    lots: trading && min >= LOTS_FROM && min < LOTS_UNTIL,
    report: ai && trading && o.reportDue && min >= REPORT_AT && min < REPORT_UNTIL,
  };
}
