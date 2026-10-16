// Stakes (spec section 4): only on a task Ben confirmed in the morning, at
// most once a day, only with a line he wrote and a friend who opted in.
import type { Line, Partner, Plan } from "./types";

export const COUNTDOWN_MIN = 15;

export const activePartners = (ps: Partner[]): Partner[] =>
  ps.filter((p) => p.chat_id !== null && !!p.joined_at && !p.left_at);

export function canStake(a: { plan: Plan; itemId: string; day: string; sentDay: string | null; lines: Line[]; partners: Partner[] }): boolean {
  return !a.plan.stakes_off
    && a.plan.stakes.includes(a.itemId)
    && a.sentDay !== a.day
    && a.lines.length > 0
    && activePartners(a.partners).length > 0;
}

export function pickLine(lines: Line[]): Line | null {
  return [...lines].sort((a, b) => a.used - b.used || a.id.localeCompare(b.id))[0] ?? null;
}

export function pickPartner(ps: Partner[]): Partner | null {
  return [...activePartners(ps)].sort((a, b) => a.sent - b.sent || a.name.localeCompare(b.name))[0] ?? null;
}

export function stakesOffAllowed(firstStart: number | null, now: number): boolean {
  return firstStart === null || now < firstStart;
}
