// The Desk — NYSE calendar and New York time math. Pure.
// Holidays and early closes come from the published NYSE calendar; a wrong
// date here is a one-line fix, not a model problem.

export const NYSE_HOLIDAYS: string[] = [
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
];
export const NYSE_EARLY_CLOSE: string[] = ["2026-11-27", "2026-12-24", "2027-11-26"];

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
});
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function etParts(ms: number): { date: string; hour: number; minute: number; dow: number } {
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    dow: DOW[get("weekday")] ?? 0,
  };
}

export function etDate(ms: number): string { return etParts(ms).date; }

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = ymd(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function isTradingDay(date: string): boolean {
  const [y, m, d] = ymd(date);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow >= 1 && dow <= 5 && !NYSE_HOLIDAYS.includes(date);
}

// UTC offset of New York on a date, in ms (negative). Derived from what the
// formatter says the hour is at noon UTC, so DST is never hand-computed.
function etOffsetMs(date: string): number {
  const [y, m, d] = ymd(date);
  const noon = Date.UTC(y, m - 1, d, 12);
  return (etParts(noon).hour - 12) * 3_600_000;
}

export function sessionBounds(date: string): { openMs: number; closeMs: number } | null {
  if (!isTradingDay(date)) return null;
  const [y, m, d] = ymd(date);
  const off = etOffsetMs(date);
  const closeHour = NYSE_EARLY_CLOSE.includes(date) ? 13 : 16;
  return { openMs: Date.UTC(y, m - 1, d, 9, 30) - off, closeMs: Date.UTC(y, m - 1, d, closeHour, 0) - off };
}

export function isNyseOpen(ms: number): boolean {
  const b = sessionBounds(etDate(ms));
  return !!b && ms >= b.openMs && ms < b.closeMs;
}

export function nextSessionDate(fromDate: string): string {
  let d = addDays(fromDate, 1);
  for (let i = 0; i < 14 && !isTradingDay(d); i++) d = addDays(d, 1);
  return d;
}

// The first trading day whose open comes after the decision.
export function sessionDateForFill(decidedMs: number): string {
  const d = etDate(decidedMs);
  const b = sessionBounds(d);
  if (b && decidedMs < b.openMs) return d;
  return nextSessionDate(d);
}

export function nextHourMs(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000 + 3_600_000;
}

// BloFin funding settles every 8 hours at 00:00, 08:00 and 16:00 UTC.
export function fundingTimesBetween(fromMs: number, toMs: number): number[] {
  const H8 = 8 * 3_600_000;
  const out: number[] = [];
  for (let t = Math.floor(fromMs / H8) * H8 + H8; t <= toMs; t += H8) out.push(t);
  return out;
}

export function weekStart(date: string): string {
  const [y, m, d] = ymd(date);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}
