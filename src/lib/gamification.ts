// The game layer: XP, levels, achievements — all DERIVED from real logged
// data (days/meals/lift_sets/goals/assets). No separate mutable XP counter
// that can drift from reality. Only `user_achievements` is persisted, so a
// milestone bonus (e.g. hitting $100k net worth) stays banked even if net
// worth later dips, and so we can detect + celebrate NEW unlocks.

import { WIN_KEYS, todayStr, dateStr, type DayRow } from "./supabase";

// ── The two long games ──────────────────────────────────────────────
// Defaults — easy to change here if the real targets differ.
export const NORTH_STAR = {
  netWorthTarget: 1_000_000,
  leanWeightTarget: 190,
};

// ── XP per action (mirrors the Obsidian vault's XP conventions) ────
const HABIT_XP: Record<(typeof WIN_KEYS)[number], number> = {
  ws_lift: 20,
  ws_chinese: 10,
  ws_work: 10,
  ws_eat: 10,
  ws_meds: 5,
  ws_stretch: 5,
  ws_vocab: 5,
};
const MEAL_XP = 3;
const LIFT_SET_XP = 2;
const GOAL_DONE_XP = 50;
const BODYWEIGHT_LOG_XP = 5;

export type GameData = {
  days: (Pick<DayRow, "day" | "ws_meds" | "ws_eat" | "ws_lift" | "ws_stretch" | "ws_vocab" | "ws_chinese" | "ws_work" | "bodyweight">)[];
  mealsCount: number;
  liftSetsDoneCount: number;
  goalsDoneCount: number;
  netWorth: number;
};

export function scoreOf(d: Record<string, unknown>): number {
  return WIN_KEYS.reduce((s, k) => s + (d[k] ? 1 : 0), 0);
}

export function baseXP(g: GameData): number {
  let xp = 0;
  for (const d of g.days) {
    for (const k of WIN_KEYS) if (d[k]) xp += HABIT_XP[k];
    if (d.bodyweight != null) xp += BODYWEIGHT_LOG_XP;
  }
  xp += g.mealsCount * MEAL_XP;
  xp += g.liftSetsDoneCount * LIFT_SET_XP;
  xp += g.goalsDoneCount * GOAL_DONE_XP;
  return xp;
}

// Current streak of full 7/7 "won" days, counting backward from today.
// Today doesn't have to be complete yet to keep yesterday's streak alive.
export function currentFullStreak(days: GameData["days"]): number {
  const map = new Map(days.map((d) => [d.day, d]));
  let streak = 0;
  const cursor = new Date(todayStr() + "T00:00:00");
  let first = true;
  for (;;) {
    const ds = dateStr(cursor);
    const row = map.get(ds);
    const won = !!row && scoreOf(row) === 7;
    if (first && ds === todayStr() && !won) {
      first = false;
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    first = false;
    if (!won) break;
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// ── Levels — a multi-year curve on purpose. This is not a 30-day app. ──
// Cumulative XP to REACH level L: 50 * (L-1) * L
const TITLES: { min: number; name: string }[] = [
  { min: 1, name: "Spark" },
  { min: 5, name: "Builder" },
  { min: 10, name: "Operator" },
  { min: 15, name: "Strategist" },
  { min: 20, name: "Architect" },
  { min: 25, name: "Polymath" },
  { min: 30, name: "Legend" },
  { min: 40, name: "Titan" },
  { min: 50, name: "Mythic" },
];

function cumXpForLevel(level: number): number {
  return 50 * (level - 1) * level;
}

export function levelFromXP(totalXP: number) {
  let level = 1;
  while (cumXpForLevel(level + 1) <= totalXP) level++;
  const floor = cumXpForLevel(level);
  const span = cumXpForLevel(level + 1) - floor;
  const into = totalXP - floor;
  const title = [...TITLES].reverse().find((t) => level >= t.min)?.name ?? "Spark";
  return { level, title, into, span, pct: span ? into / span : 0, totalXP };
}

// ── Achievements — hardcoded catalog, evaluated against live data ──────
export type Achievement = {
  key: string;
  emoji: string;
  name: string;
  desc: string;
  xp: number;
  check: (g: GameData) => boolean;
};

const daysWith = (g: GameData, pred: (d: GameData["days"][number]) => boolean) =>
  g.days.filter(pred).length;

export const ACHIEVEMENTS: Achievement[] = [
  // ── Getting started ──
  { key: "first_day", emoji: "🌱", name: "First Win", desc: "Log your first day", xp: 10,
    check: (g) => g.days.length >= 1 },
  { key: "perfect_day", emoji: "✅", name: "Perfect Day", desc: "First 7/7 Win Stack day", xp: 25,
    check: (g) => g.days.some((d) => scoreOf(d) === 7) },
  { key: "on_scale", emoji: "⚖️", name: "On the Scale", desc: "Log your bodyweight for the first time", xp: 25,
    check: (g) => g.days.some((d) => d.bodyweight != null) },
  { key: "first_goal", emoji: "🎯", name: "First Goal Crushed", desc: "Complete your first goal", xp: 25,
    check: (g) => g.goalsDoneCount >= 1 },

  // ── Streaks (the real game) ──
  { key: "streak_3", emoji: "🔥", name: "On Fire", desc: "3-day full win streak", xp: 50,
    check: (g) => currentFullStreak(g.days) >= 3 },
  { key: "streak_14", emoji: "🔥", name: "Two Weeks Strong", desc: "14-day full win streak", xp: 200,
    check: (g) => currentFullStreak(g.days) >= 14 },
  { key: "streak_30", emoji: "🔥", name: "Iron Habit", desc: "30-day full win streak", xp: 500,
    check: (g) => currentFullStreak(g.days) >= 30 },
  { key: "streak_90", emoji: "🔥", name: "The Unbreakable", desc: "90-day full win streak", xp: 1000,
    check: (g) => currentFullStreak(g.days) >= 90 },
  { key: "streak_365", emoji: "👑", name: "Year One", desc: "365-day full win streak", xp: 5000,
    check: (g) => currentFullStreak(g.days) >= 365 },

  // ── Volume / mastery ──
  { key: "days_50", emoji: "📅", name: "50 Logged Days", desc: "50 total days logged", xp: 100,
    check: (g) => g.days.length >= 50 },
  { key: "days_100", emoji: "📅", name: "100 Logged Days", desc: "100 total days logged", xp: 250,
    check: (g) => g.days.length >= 100 },
  { key: "lift_30", emoji: "🏋️", name: "Iron Body", desc: "30 lift days logged", xp: 150,
    check: (g) => daysWith(g, (d) => d.ws_lift) >= 30 },
  { key: "chinese_30", emoji: "🐼", name: "Fluent Grind", desc: "30 Chinese days logged", xp: 100,
    check: (g) => daysWith(g, (d) => d.ws_chinese) >= 30 },
  { key: "vocab_50", emoji: "✍️", name: "Wordsmith", desc: "50 vocab days logged", xp: 100,
    check: (g) => daysWith(g, (d) => d.ws_vocab) >= 50 },
  { key: "meals_100", emoji: "🍎", name: "Century of Meals", desc: "100 meals logged", xp: 100,
    check: (g) => g.mealsCount >= 100 },
  { key: "sets_500", emoji: "💪", name: "Iron Volume", desc: "500 lift sets completed", xp: 250,
    check: (g) => g.liftSetsDoneCount >= 500 },
  { key: "goals_10", emoji: "🏁", name: "Goal Machine", desc: "10 goals completed", xp: 200,
    check: (g) => g.goalsDoneCount >= 10 },

  // ── The 190-lean north star ──
  { key: "lean_190", emoji: "🏆", name: "190 Lean", desc: "Reach your target bodyweight", xp: 1000,
    check: (g) => {
      const last = [...g.days].filter((d) => d.bodyweight != null).sort((a, b) => a.day.localeCompare(b.day)).pop();
      return !!last && last.bodyweight != null && Math.abs(Number(last.bodyweight) - NORTH_STAR.leanWeightTarget) <= 1;
    } },

  // ── The millionaire north star ──
  { key: "net_1k", emoji: "💵", name: "First $1,000", desc: "Net worth crosses $1,000", xp: 50, check: (g) => g.netWorth >= 1_000 },
  { key: "net_10k", emoji: "💵", name: "$10,000 Net Worth", desc: "", xp: 150, check: (g) => g.netWorth >= 10_000 },
  { key: "net_25k", emoji: "💵", name: "$25,000 Net Worth", desc: "", xp: 250, check: (g) => g.netWorth >= 25_000 },
  { key: "net_50k", emoji: "💰", name: "$50,000 Net Worth", desc: "", xp: 400, check: (g) => g.netWorth >= 50_000 },
  { key: "net_100k", emoji: "💰", name: "$100,000 Net Worth", desc: "", xp: 750, check: (g) => g.netWorth >= 100_000 },
  { key: "net_250k", emoji: "💰", name: "Quarter Million", desc: "", xp: 1500, check: (g) => g.netWorth >= 250_000 },
  { key: "net_500k", emoji: "🏦", name: "Half Million", desc: "", xp: 3000, check: (g) => g.netWorth >= 500_000 },
  { key: "net_750k", emoji: "🏦", name: "$750,000 Net Worth", desc: "", xp: 4000, check: (g) => g.netWorth >= 750_000 },
  { key: "millionaire", emoji: "👑", name: "MILLIONAIRE", desc: "Net worth hits $1,000,000", xp: 10000,
    check: (g) => g.netWorth >= NORTH_STAR.netWorthTarget },
];

export function achievementBonusXP(unlockedKeys: Set<string>): number {
  return ACHIEVEMENTS.filter((a) => unlockedKeys.has(a.key)).reduce((s, a) => s + a.xp, 0);
}

export function computeUnlocked(g: GameData): Achievement[] {
  return ACHIEVEMENTS.filter((a) => a.check(g));
}
