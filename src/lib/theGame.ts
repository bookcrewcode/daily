// THE GAME — Fall 2026 Operating System. Pure scoring logic, no IO, so every
// number on the Card can be trusted absolutely.
//
// v43 changed WHAT is scored. It used to be five fixed categories (R/B/S/BC/L)
// that meant nothing to Ben six months after he wrote them down. Now the day
// is scored on THE DAY'S OWN CHECKLIST — the blocks he planned in the Plan
// chat, plus anything due today, plus whatever he adds on the Card. Planning
// and doing are the same object: the list lives in nights.items, and the Card
// checks it off.
//
//   Point   = one finished item. Bonus adds up to +4. Day caps at 10.
//   Won day = at least min(3, list length) items done, on a list of 1+.
//             (Three was the old bar and it stays the bar; a two-item day is
//             won by clearing it, so a light day can't be an automatic loss.)
//   Closed  = every item on today's list is done. That's the speedrun target.
//   Freeze  = declared the night before. Scores 0, streak survives.
//   Week bands out of 70: <25 Down · 25-39 Surviving · 40-54 Running · 55+ Compounding.

// Split stamps — seconds-of-local-day for the two moments that still mean
// something when the list changes shape daily: when the day STARTED (first item
// checked) and when it CLOSED (list cleared). Per-category PBs died with the
// fixed five — you can't hold a record for "item 3" when item 3 is a different
// thing every day.
export type SplitKey = "first" | "closed";
export type Splits = Partial<Record<SplitKey, number>>;
export const SPLIT_KEYS: SplitKey[] = ["first", "closed"];

// One line on the day's list. `id` is stable so checking an item off survives
// the Plan chat rewriting the schedule around it.
export type DayItem = {
  id: string;
  time: string;       // "HH:MM", or "" for an untimed to-do
  what: string;
  done?: boolean;
  at?: number;        // seconds-of-day it was checked
  src?: "plan" | "goal" | "card";
  goal_id?: string;   // set when the item IS a deadline, so checking it closes the goal
};

export type GameDayRow = {
  day: string;               // YYYY-MM-DD
  r_launch: boolean;
  r_shutdown: boolean;
  b: boolean;
  s: boolean;
  bonus_uber: boolean;
  bonus_trading: boolean;
  bonus_dev: boolean;
  bonus_chess: boolean;
  frozen: boolean;
  learn_line: string;
  splits: Splits;
  // the day's checklist result, written alongside every tick so the season map
  // and the streak never have to load every night row to score a day
  items_done: number;
  items_total: number;
};

export const SEASON_START = "2026-08-18"; // day 0; streak day 1 = Aug 19
export const SEASON_END = "2026-12-15";
export const SEASON_DAYS = 119;
// the season track counts DAYS WON, not BookCrew reps — the rep engine left
// the Card in v43 and a progress bar with nothing feeding it is a dead bar.
export const WIN_TARGET = SEASON_DAYS;

export function emptyDay(day: string): GameDayRow {
  return { day, r_launch: false, r_shutdown: false, b: false, s: false, bonus_uber: false, bonus_trading: false, bonus_dev: false, bonus_chess: false, frozen: false, learn_line: "", splits: {}, items_done: 0, items_total: 0 };
}

// ── the speedrun clock ──────────────────────────────────────────────────────
export const secOfDay = (d: Date = new Date()) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();

// 21:37-style; seconds-of-day → readable clock time
export function fmtClock(s: number): string {
  const h = Math.floor(s / 3600) % 24, m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}
// signed compact duration for deltas: −1:07 means 67 min EARLIER than PB.
// Total minutes FIRST, then split — rounding the remainder alone yields ":60".
export function fmtDelta(s: number): string {
  const sign = s < 0 ? "−" : "+";
  const t = Math.round(Math.abs(s) / 60);
  const h = Math.floor(t / 60), m = t % 60;
  return `${sign}${h}:${String(m).padStart(2, "0")}`;
}
export function fmtDur(s: number): string {
  const a = Math.max(0, s);
  const h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// Personal bests: the EARLIEST stamp per part across the season so far.
// Frozen days and the excluded day (today, still in progress) don't count —
// and neither do out-of-season days (day 0 / pre-season tinkering must never
// set a season record).
export function partBests(days: GameDayRow[], excludeDay: string): Splits {
  const best: Splits = {};
  for (const d of days) {
    const i = diffDays(SEASON_START, d.day);
    if (d.day === excludeDay || d.frozen || i < 1 || i > SEASON_DAYS) continue;
    const sp = d.splits ?? {};
    for (const k of SPLIT_KEYS) {
      const v = sp[k];
      if (typeof v === "number" && v > 0 && (best[k] === undefined || v < best[k]!)) best[k] = v;
    }
  }
  return best;
}

// ── season tiers (battle-pass track: 119 days, 5 tiers) ────────────────────
// Claimed at day-won counts. The old track was 250 BookCrew reps; when the rep
// row left the Card nothing fed it any more, so it now measures the thing the
// Card actually produces — days you won.
export const TIERS = [
  { at: 20, name: "Ignition" },
  { at: 40, name: "Momentum" },
  { at: 60, name: "Groove" },
  { at: 85, name: "Locked in" },
  { at: 119, name: "The Engine" },
] as const;

// Level-up dates on the calendar (streak thresholds → season map crowns).
export const LEVEL_DATES = [
  { days: 7, name: "Installed", date: "2026-08-25" },
  { days: 21, name: "Habit", date: "2026-09-08" },
  { days: 45, name: "Identity", date: "2026-10-02" },
  { days: 90, name: "Automatic", date: "2026-11-16" },
  { days: 119, name: "Season complete", date: "2026-12-15" },
] as const;

// Named weeks (Duolingo's own rationale: "Week 5" alone motivates nobody).
// Keyed by the week's Monday.
export const WEEK_LABELS: Record<string, string> = {
  "2026-08-17": "Install the loop",
  "2026-08-24": "Lock the rituals",
  "2026-08-31": "Syllabus week — capture every date",
  "2026-09-07": "21-day line · Habit",
  "2026-09-14": "First full-load week",
  "2026-09-21": "Front-load the study",
  "2026-09-28": "45-day line · Identity",
  "2026-10-05": "Midterm runway",
  "2026-10-12": "Midterms — hold the core",
  "2026-10-19": "Rebuild pace",
  "2026-10-26": "Compound week",
  "2026-11-02": "No-drift week",
  "2026-11-09": "Pre-Thanksgiving push",
  "2026-11-16": "90-day line · Automatic",
  "2026-11-23": "Thanksgiving — protect the core",
  "2026-11-30": "Finals runway",
  "2026-12-07": "Finals",
  "2026-12-14": "Close the season",
};

const MS = 86400000;
const at = (d: string) => new Date(d + "T00:00:00").getTime();
// Math.round absorbs the ±1h DST wobble (23h/24h and 25h/24h both round to 1).
export const diffDays = (a: string, b: string) => Math.round((at(b) - at(a)) / MS);
export function addDays(day: string, n: number): string {
  // Date components at NOON, not midnight-epoch millis: Nov 1 2026 is a
  // 25-hour day in America/New_York, and +86400000ms from its midnight lands
  // back on Nov 1 — which once made "tomorrow" equal "today" and let the
  // freeze button freeze the live day. Noon is immune to DST edges.
  const [y, m, dd] = day.split("-").map(Number);
  const d = new Date(y, (m ?? 1) - 1, (dd ?? 1) + n, 12);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "Day N of 119" — Aug 19 is day 1, Dec 15 is day 119.
export function seasonDay(today: string): number {
  return diffDays(SEASON_START, today);
}

// ── scoring ─────────────────────────────────────────────────────────────────
// The list is the score. `items_done`/`items_total` are written by the Card on
// every tick; everything downstream reads them, so a day scored on a phone in
// July still reads correctly on the season map today.

export const MAX_DAY_POINTS = 10;   // keeps the week band meaningful out of 70

// A light day must be winnable by clearing it; a heavy day still needs three.
export function winBar(itemsTotal: number): number {
  return Math.max(1, Math.min(3, itemsTotal));
}

export function listDone(d: GameDayRow): number {
  return Math.max(0, Math.min(d.items_done ?? 0, d.items_total ?? 0));
}

export function isStreakDay(d: GameDayRow): boolean {
  if (d.frozen) return false;                       // frozen days are SKIPPED, not counted
  const total = d.items_total ?? 0;
  return total >= 1 && listDone(d) >= winBar(total);
}

// The day closes when the list is empty of undone work — the speedrun target.
export function isClosed(d: GameDayRow): boolean {
  const total = d.items_total ?? 0;
  return total >= 1 && listDone(d) >= total;
}

export function bonusCount(d: GameDayRow): number {
  // chess is parked until March 1; its column stays for history but no longer scores
  const raw = (d.bonus_uber ? 1 : 0) + (d.bonus_trading ? 1 : 0) + (d.bonus_dev ? 1 : 0);
  return Math.min(3, raw);
}

export function dayTotal(d: GameDayRow): number {
  if (d.frozen) return 0;                            // freeze day scores 0, streak survives
  return Math.min(MAX_DAY_POINTS, listDone(d) + bonusCount(d));
}

// ── the day's list ──────────────────────────────────────────────────────────
// Items are stored raw in nights.items. Everything that reads them goes through
// normalizeItems so a row written by an older build (or by the plan function,
// which only knows {time, what}) can never crash the Card.
let idSeq = 0;
export function newItemId(): string {
  idSeq = (idSeq + 1) % 100000;
  return `i${Date.now().toString(36)}${idSeq.toString(36)}`;
}

export function normalizeItems(raw: unknown): DayItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => {
      const what = String(x.what ?? "").slice(0, 200);
      let id = String(x.id ?? "");
      // legacy rows have no id — derive a stable one from time+text so ticking
      // an item survives a reload instead of hopping to a different line
      if (!id) id = `l${String(x.time ?? "")}_${what}`.slice(0, 80);
      while (seen.has(id)) id = id + "_";
      seen.add(id);
      const t = String(x.time ?? "");
      return {
        id,
        time: /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : "",
        what,
        done: x.done === true,
        at: typeof x.at === "number" && x.at >= 0 ? x.at : undefined,
        src: x.src === "goal" || x.src === "card" ? x.src : "plan",
        goal_id: typeof x.goal_id === "string" && x.goal_id ? x.goal_id : undefined,
      } as DayItem;
    })
    .filter((i) => i.what.trim().length > 0)
    .slice(0, 60);
}

export function sortItems(items: DayItem[]): DayItem[] {
  // timed first in clock order, untimed after in the order they were added
  return [...items].sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
}

// The Plan chat returns a whole new schedule, not a diff. Re-applying it must
// NOT un-check work already finished — match on time+text and carry the tick
// across, so replanning the afternoon never resets the morning.
export function mergeItems(prev: DayItem[], next: DayItem[]): DayItem[] {
  const key = (i: DayItem) => `${i.time}|${i.what.trim().toLowerCase()}`;
  const done = new Map<string, DayItem>();
  for (const p of prev) if (p.done) done.set(key(p), p);
  return next.map((n) => {
    const hit = done.get(key(n));
    return hit ? { ...n, id: hit.id, done: true, at: hit.at } : n;
  });
}

export function countDone(items: DayItem[]): number {
  return items.reduce((t, i) => t + (i.done ? 1 : 0), 0);
}

// ── streak ──────────────────────────────────────────────────────────────────
// Walk backward from today. A won day counts; a frozen day is skipped (scores
// 0, streak survives); anything else breaks the chain. Today-in-progress never
// breaks it — it just doesn't count until the list clears its bar.
export function computeStreak(rows: Map<string, GameDayRow>, today: string): number {
  let streak = 0;
  let d = today;
  const rowOf = (day: string) => rows.get(day) ?? emptyDay(day);

  const t = rowOf(d);
  if (diffDays(SEASON_START, d) >= 1 && isStreakDay(t)) streak++;
  d = addDays(d, -1);
  while (diffDays(SEASON_START, d) >= 1) {
    const x = rowOf(d);
    if (x.frozen) { d = addDays(d, -1); continue; }
    if (isStreakDay(x)) { streak++; d = addDays(d, -1); continue; }
    break;
  }
  return streak;
}

// Every won day of the season so far — what the tier track measures.
export function daysWon(rows: GameDayRow[], today: string): number {
  let n = 0;
  for (const r of rows) {
    const i = diffDays(SEASON_START, r.day);
    if (i < 1 || i > SEASON_DAYS || r.day > today) continue;
    if (isStreakDay(r)) n++;
  }
  return n;
}

export const LEVELS = [
  { days: 7, name: "Installed" },
  { days: 21, name: "Habit" },
  { days: 45, name: "Identity" },
  { days: 90, name: "Automatic" },
  { days: 119, name: "Season complete" },
] as const;

export function levelInfo(streak: number): { name: string | null; next: { days: number; name: string; togo: number } | null } {
  let name: string | null = null;
  for (const l of LEVELS) if (streak >= l.days) name = l.name;
  const nxt = LEVELS.find((l) => streak < l.days);
  return { name, next: nxt ? { days: nxt.days, name: nxt.name, togo: nxt.days - streak } : null };
}

// ── weeks ───────────────────────────────────────────────────────────────────
// Card weeks run Monday → Sunday (new card written Sunday night).
export function weekStart(day: string): string {
  const dow = new Date(day + "T00:00:00").getDay(); // 0=Sun
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}
export function weekDays(day: string): string[] {
  const start = weekStart(day);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}
export function weekBand(total: number): { name: string; hue: string } {
  if (total >= 55) return { name: "Compounding", hue: "#34d399" };
  if (total >= 40) return { name: "Running", hue: "#7c87f0" };
  if (total >= 25) return { name: "Surviving", hue: "#fbbf24" };
  return { name: "Down", hue: "#f87171" };
}

// ── the season pace line ────────────────────────────────────────────────────
export function winPace(won: number, today: string): { total: number; projected: number; perWeekNeeded: number } {
  const elapsed = Math.max(1, Math.min(SEASON_DAYS, seasonDay(today)));
  const remainingDays = Math.max(1, SEASON_DAYS - elapsed);
  return {
    total: won,
    projected: Math.round((won / elapsed) * SEASON_DAYS),
    perWeekNeeded: Math.max(0, ((WIN_TARGET - won) / remainingDays) * 7),
  };
}

// L-lane trunk rotation: Mon/Thu · Tue/Fri · Wed/Sat · Sun synthesis.
export function trunkOfDay(day: string): string {
  const dow = new Date(day + "T00:00:00").getDay();
  if (dow === 1 || dow === 4) return "How I Work";
  if (dow === 2 || dow === 5) return "How the World Works";
  if (dow === 3 || dow === 6) return "How Other People Work";
  return "Synthesis — one page in your own words (or free)";
}
