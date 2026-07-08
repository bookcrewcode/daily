"use client";

// Daily quests — Duolingo-style rotating objectives (their Daily Quests launch
// drove ~25% DAU growth). 3 per day, deterministically picked from the date so
// every device agrees without storing anything. Progress is DERIVED from real
// logged data; claiming banks the bonus XP in quest_claims (like achievements),
// so it stays earned even if the underlying data later changes.

import { supabase, todayStr, dateStr, WIN_KEYS, WATER_GOAL, type DayRow } from "./supabase";

export type QuestCtx = {
  day: DayRow | null;
  mealsToday: number;
  setsDoneToday: number;
  vocabAddedToday: number;
  gigShiftsToday: number;
  focusToday: number; // sessions
  affirmMorning: boolean;
  affirmNight: boolean;
  learningSessionsToday: number;
  tomorrowTop3Filled: number;
  proteinGoal: number;
};

export type Quest = {
  key: string;
  emoji: string;
  label: string;
  xp: number;
  progress: (c: QuestCtx) => { done: boolean; now: number; total: number };
};

const winScore = (d: DayRow | null) => (d ? WIN_KEYS.reduce((s, k) => s + (d[k] ? 1 : 0), 0) : 0);

export const QUEST_POOL: Quest[] = [
  { key: "hydrate", emoji: "💧", label: `Drink ${WATER_GOAL} cups of water`, xp: 25,
    progress: (c) => ({ done: (c.day?.water_cups ?? 0) >= WATER_GOAL, now: Math.min(c.day?.water_cups ?? 0, WATER_GOAL), total: WATER_GOAL }) },
  { key: "protein", emoji: "💪", label: "Hit your protein goal", xp: 30,
    progress: (c) => ({ done: (c.day?.protein ?? 0) >= c.proteinGoal, now: Math.min(c.day?.protein ?? 0, c.proteinGoal), total: c.proteinGoal }) },
  { key: "meals3", emoji: "🍽️", label: "Log 3 meals", xp: 20,
    progress: (c) => ({ done: c.mealsToday >= 3, now: Math.min(c.mealsToday, 3), total: 3 }) },
  { key: "iron", emoji: "🏋️", label: "Complete 4 lift sets", xp: 30,
    progress: (c) => ({ done: c.setsDoneToday >= 4, now: Math.min(c.setsDoneToday, 4), total: 4 }) },
  { key: "wordsmith", emoji: "✍️", label: "Bank a new vocab word", xp: 20,
    progress: (c) => ({ done: c.vocabAddedToday >= 1, now: Math.min(c.vocabAddedToday, 1), total: 1 }) },
  { key: "hustle", emoji: "🚗", label: "Log a gig shift", xp: 30,
    progress: (c) => ({ done: c.gigShiftsToday >= 1, now: Math.min(c.gigShiftsToday, 1), total: 1 }) },
  { key: "deepwork", emoji: "⏱️", label: "Finish a focus block", xp: 30,
    progress: (c) => ({ done: c.focusToday >= 1, now: Math.min(c.focusToday, 1), total: 1 }) },
  { key: "scholar", emoji: "🌳", label: "Save a learning session", xp: 30,
    progress: (c) => ({ done: c.learningSessionsToday >= 1, now: Math.min(c.learningSessionsToday, 1), total: 1 }) },
  { key: "frames", emoji: "💫", label: "Morning + night affirmations", xp: 25,
    progress: (c) => ({ done: c.affirmMorning && c.affirmNight, now: (c.affirmMorning ? 1 : 0) + (c.affirmNight ? 1 : 0), total: 2 }) },
  { key: "bank8", emoji: "✅", label: "Bank 8 wins today", xp: 35,
    progress: (c) => ({ done: winScore(c.day) >= 8, now: Math.min(winScore(c.day), 8), total: 8 }) },
  { key: "weighin", emoji: "⚖️", label: "Log your bodyweight", xp: 15,
    progress: (c) => ({ done: c.day?.bodyweight != null, now: c.day?.bodyweight != null ? 1 : 0, total: 1 }) },
  { key: "planner", emoji: "🌙", label: "Set tomorrow's Top 3 tonight", xp: 20,
    progress: (c) => ({ done: c.tomorrowTop3Filled >= 3, now: Math.min(c.tomorrowTop3Filled, 3), total: 3 }) },
];

export const SWEEP_XP = 25; // auto-bonus for claiming all 3 in a day
export const CHEST_CHANCE = 0.25; // surprise drop on claim (variable reward — the over-justification loophole)
export const chestXP = () => 10 + Math.floor(Math.random() * 41); // 10–50

// mulberry32 — deterministic per-date PRNG so the same 3 quests appear everywhere
function seeded(seedStr: string): () => number {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function questsForDay(day: string): Quest[] {
  const rand = seeded("daily-quests-" + day);
  const pool = [...QUEST_POOL];
  const picked: Quest[] = [];
  while (picked.length < 3 && pool.length) {
    picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return picked;
}

export async function loadQuestCtx(uid: string, proteinGoal: number): Promise<QuestCtx> {
  const day = todayStr();
  const tmrw = new Date(); tmrw.setDate(tmrw.getDate() + 1);
  const [dayRow, meals, sets, vocab, gig, focus, affirm, learn, night] = await Promise.all([
    supabase.from("days").select("*").eq("user_id", uid).eq("day", day).maybeSingle(),
    supabase.from("meals").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("day", day),
    supabase.from("lift_sets").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("day", day).eq("done", true),
    supabase.from("vocab").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("added", day),
    supabase.from("gig_shifts").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("day", day),
    supabase.from("focus_sessions").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("day", day),
    supabase.from("affirmations").select("period").eq("user_id", uid).eq("day", day),
    supabase.from("learning_sessions").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("day", day),
    supabase.from("nights").select("top3").eq("user_id", uid).eq("day", dateStr(tmrw)).maybeSingle(),
  ]);
  const periods = new Set((affirm.data ?? []).map((a) => a.period as string));
  return {
    day: (dayRow.data as DayRow | null) ?? null,
    mealsToday: meals.count ?? 0,
    setsDoneToday: sets.count ?? 0,
    vocabAddedToday: vocab.count ?? 0,
    gigShiftsToday: gig.count ?? 0,
    focusToday: focus.count ?? 0,
    affirmMorning: periods.has("morning"),
    affirmNight: periods.has("night"),
    learningSessionsToday: learn.count ?? 0,
    tomorrowTop3Filled: ((night.data?.top3 as string[]) ?? []).filter((t) => t?.trim()).length,
    proteinGoal,
  };
}
