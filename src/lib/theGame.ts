// THE GAME — Fall 2026 Operating System. Pure scoring logic, straight from the
// rulebook (v1.0, Aug 18 → Dec 15 2026). No IO here: every rule is a small,
// testable function so the numbers on the card can be trusted absolutely.
//
//   Core Five: R (Launch AND Shutdown) · B · S · BC (≥1 logged rep) · L (a line
//   written in his own words). 1 point each.
//   Bonus: extra BC reps (max +2) · Uber (only after the day's first rep) ·
//   trading rules 100% · dev ship · rated chess — summed, CAPPED at +5.
//   Streak day = core ≥ 3. Freeze day scores 0 but the streak survives.
//   Week bands: <25 Down · 25–39 Surviving · 40–54 Running · 55+ Compounding.

// Split stamps — seconds-of-local-day when each core part locked in (and when
// the card "closed", i.e. core hit 5). The speedrun layer: honest wall-clock
// times, no fake timers. PB = the earliest historical stamp per part.
export type SplitKey = "r" | "b" | "s" | "bc" | "l";
export type Splits = Partial<Record<SplitKey | "closed", number>>;
export const SPLIT_KEYS: SplitKey[] = ["r", "b", "s", "bc", "l"];

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
};

export const SEASON_START = "2026-08-18"; // day 0; streak day 1 = Aug 19
export const SEASON_END = "2026-12-15";
export const SEASON_DAYS = 119;
export const REP_TARGET = 250;

export function emptyDay(day: string): GameDayRow {
  return { day, r_launch: false, r_shutdown: false, b: false, s: false, bonus_uber: false, bonus_trading: false, bonus_dev: false, bonus_chess: false, frozen: false, learn_line: "", splits: {} };
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
    for (const k of [...SPLIT_KEYS, "closed"] as (SplitKey | "closed")[]) {
      const v = sp[k];
      if (typeof v === "number" && v > 0 && (best[k] === undefined || v < best[k]!)) best[k] = v;
    }
  }
  return best;
}

// ── season tiers (battle-pass track: 250 reps = season XP, 5 tiers) ─────────
export const TIERS = [
  { at: 50, name: "Ignition" },
  { at: 100, name: "Momentum" },
  { at: 150, name: "Pipeline" },
  { at: 200, name: "Closer" },
  { at: 250, name: "The Engine" },
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
  "2026-09-21": "Front-load the reps",
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
export function coreParts(d: GameDayRow, repsToday: number) {
  return {
    r: d.r_launch && d.r_shutdown,
    b: d.b,
    s: d.s,
    bc: repsToday >= 1,
    l: d.learn_line.trim().length > 0,
  };
}
export function coreCount(d: GameDayRow, repsToday: number): number {
  const p = coreParts(d, repsToday);
  return (p.r ? 1 : 0) + (p.b ? 1 : 0) + (p.s ? 1 : 0) + (p.bc ? 1 : 0) + (p.l ? 1 : 0);
}
export function bonusBC(repsToday: number): number {
  return Math.min(2, Math.max(0, repsToday - 1));
}
export function bonusCount(d: GameDayRow, repsToday: number): number {
  // "Reps before rides" is a SCORING rule, not just a button state: an Uber
  // check with zero logged reps is worth nothing, even if it's still ticked
  // because the day's only rep was deleted after the fact.
  const raw = bonusBC(repsToday)
    + (d.bonus_uber && repsToday >= 1 ? 1 : 0) + (d.bonus_trading ? 1 : 0)
    + (d.bonus_dev ? 1 : 0) + (d.bonus_chess ? 1 : 0);
  return Math.min(5, raw); // §2: bonus max +5/day — the table can sum to 6
}
export function dayTotal(d: GameDayRow, repsToday: number): number {
  if (d.frozen) return 0; // freeze day scores 0 (streak survives elsewhere)
  return coreCount(d, repsToday) + bonusCount(d, repsToday);
}

// ── streak ──────────────────────────────────────────────────────────────────
// Walk backward from today. Rules: core ≥ 3 counts; a frozen day is skipped
// (scores 0, streak survives); an undeclared miss breaks. Today-in-progress
// never breaks the streak — it just doesn't count until it reaches 3.
export function computeStreak(rows: Map<string, GameDayRow>, repsByDay: Map<string, number>, today: string): number {
  let streak = 0;
  let d = today;
  const scoreOf = (day: string) => {
    // a reps-only day has no game_days row yet — the reps still count
    const row = rows.get(day) ?? emptyDay(day);
    return { frozen: row.frozen, core: coreCount(row, repsByDay.get(day) ?? 0) };
  };
  // today: count if already a streak day (and in season); never break on it
  const t = scoreOf(d);
  if (diffDays(SEASON_START, d) >= 1 && !t.frozen && t.core >= 3) streak++;
  d = addDays(d, -1);
  // never walk past the season start
  while (diffDays(SEASON_START, d) >= 1) {
    const x = scoreOf(d);
    if (x.frozen) { d = addDays(d, -1); continue; }
    if (x.core >= 3) { streak++; d = addDays(d, -1); continue; }
    break;
  }
  return streak;
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

// ── the 250-rep engine ──────────────────────────────────────────────────────
export function repPace(totalReps: number, today: string): { total: number; projected: number; perDayNeeded: number } {
  const elapsed = Math.max(1, seasonDay(today));
  const remainingDays = Math.max(1, SEASON_DAYS - elapsed);
  return {
    total: totalReps,
    projected: Math.round((totalReps / elapsed) * SEASON_DAYS),
    perDayNeeded: Math.max(0, (REP_TARGET - totalReps) / remainingDays),
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
