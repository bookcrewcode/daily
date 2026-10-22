// Wall-clock math for Ben's timezone. Workers run in UTC, so every "09:00"
// on the list has to be turned into a real instant with the zone's offset on
// that day (DST included).

export const DAY_MS = 86_400_000;

// Offset of `tz` from UTC at instant `ms`, in ms (EDT = -4h).
export function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export type Local = { day: string; weekday: number; hhmm: string };

export function localOf(ms: number, tz: string): Local {
  const d = new Date(ms + tzOffsetMs(ms, tz));
  const iso = d.toISOString();
  return { day: iso.slice(0, 10), weekday: d.getUTCDay(), hhmm: iso.slice(11, 16) };
}

// Instant of wall time `hhmm` on `day` in `tz`. The second pass settles DST edges.
export function epochOf(day: string, hhmm: string, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

// Noon-based so a 23- or 25-hour day can never land on the same date.
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

export const isHhmm = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function secOfDayIn(ms: number, tz: string): number {
  const t = ms + tzOffsetMs(ms, tz);
  return Math.floor((((t % DAY_MS) + DAY_MS) % DAY_MS) / 1000);
}

export function minutesBetween(a: string, b: string): number {
  if (!isHhmm(a) || !isHhmm(b)) return 0;
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return Math.max(0, m(b) - m(a));
}
