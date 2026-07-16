"use client";

// Single source of game truth for the whole app. One provider at the root:
// achievements toast on ANY tab (they used to be swallowed outside Today),
// level-ups get a real moment, and data isn't double-fetched by parallel hooks.

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase, todayStr, WIN_KEYS, type DayRow } from "./supabase";
import {
  ACHIEVEMENTS, HABIT_XP, MEAL_XP, LIFT_SET_XP, NORTH_STAR, VOCAB_REVIEW_XP,
  achievementBonusXP, baseXP, computeStreak, computeUnlocked, countPRs, focusXP,
  levelFromXP, scoreOf, WIN_TOTAL, GIG_XP_PER_DOLLARS, REP_XP,
  type Achievement, type GameData, type StreakData,
} from "./gamification";

export type GameDayRow = GameData["days"][number] & { calories: number; protein: number; vocab_reviews: number };

export type GameState = {
  loading: boolean;
  refreshError: boolean; // last load() couldn't reach the DB — state is stale, not empty
  uid: string;
  level: { level: number; title: string; into: number; span: number; pct: number; totalXP: number };
  streak: StreakData;
  netWorth: number;
  netWorthHistory: { day: string; value: number }[];
  latestBodyweight: number | null;
  days: GameDayRow[];
  todayXP: number;
  unlocked: Achievement[];
  locked: Achievement[];
  newlyUnlocked: Achievement[];
  dismissNew: () => void;
  levelUp: { level: number; title: string } | null;
  dismissLevelUp: () => void;
  todaysQuestClaims: Set<string>;
  bankQuestXP: (key: string, xp: number) => Promise<boolean>;
  refresh: () => void;
};

const GameContext = createContext<GameState | null>(null);

const DAY_COLS = "day,ws_meds,ws_eat,ws_lift,ws_stretch,ws_vocab,ws_chinese,ws_work,ws_water,ws_sleep,ws_school,ws_affirmations,bodyweight,water_cups,calories,protein,vocab_reviews";

// Supabase caps a single response at 1000 rows. For row-returning selects whose
// FULL history drives XP/streak/PRs (multi-year app), page through .range()
// until a short page arrives — otherwise derived XP silently stops at row 1000.
async function fetchAll<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ data: T[]; error: unknown }> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await makeQuery(from, from + 999);
    if (error) return { data: all, error };
    const page = data ?? [];
    all.push(...page);
    if (page.length < 1000) break;
    from += 1000;
  }
  return { data: all, error: null };
}

export function GameProvider({ uid, children }: { uid: string; children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [game, setGame] = useState<GameData>({
    days: [], mealsCount: 0, liftSetsDoneCount: 0, goalsDoneCount: 0, netWorth: 0,
    questXP: 0, questClaimCount: 0, gigEarnings: 0, focusMinutesList: [],
    vocabReviews: 0, vocabWordCount: 0, learningSessionsCount: 0, prCount: 0,
    engineRepsCount: 0, maxRowRepCount: 0,
  });
  const [days, setDays] = useState<GameDayRow[]>([]);
  const [unlockedKeys, setUnlockedKeys] = useState<Set<string>>(new Set());
  const [newlyUnlocked, setNewlyUnlocked] = useState<Achievement[]>([]);
  const [levelUp, setLevelUp] = useState<{ level: number; title: string } | null>(null);
  const [lastSeenLevel, setLastSeenLevel] = useState<number | null>(null);
  const [netWorthHistory, setNetWorthHistory] = useState<{ day: string; value: number }[]>([]);
  const [todayExtras, setTodayExtras] = useState({ meals: 0, sets: 0, questXP: 0, gig: 0, focusXP: 0, reps: 0 });
  const [todaysQuestClaims, setTodaysQuestClaims] = useState<Set<string>>(new Set());
  const [refreshError, setRefreshError] = useState(false);

  const load = useCallback(async () => {
    const today = todayStr();
    const [
      { data: dayRows, error: daysErr }, { count: mealsCount }, { count: mealsToday },
      { count: liftSetsDoneCount }, { data: liftHistory }, { count: setsToday },
      { count: goalsDoneCount }, { data: assets }, { data: existing, error: achErr },
      { data: questRows }, { data: gigRows }, { data: focusRows },
      { data: vocabRows }, { count: learningSessionsCount },
      { data: settingsRow, error: settingsErr }, { data: nwHistory }, { data: engineReps },
    ] = await Promise.all([
      fetchAll((from, to) => supabase.from("days").select(DAY_COLS).eq("user_id", uid).range(from, to)),
      supabase.from("meals").select("id", { count: "exact", head: true }).eq("user_id", uid),
      supabase.from("meals").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("day", today),
      supabase.from("lift_sets").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("done", true),
      fetchAll((from, to) => supabase.from("lift_sets").select("exercise,weight,day,done").eq("user_id", uid).eq("done", true).range(from, to)),
      supabase.from("lift_sets").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("done", true).eq("day", today),
      supabase.from("goals").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("status", "done"),
      supabase.from("assets").select("kind,value").eq("user_id", uid),
      supabase.from("user_achievements").select("key").eq("user_id", uid),
      fetchAll((from, to) => supabase.from("quest_claims").select("day,quest_key,xp").eq("user_id", uid).range(from, to)),
      fetchAll((from, to) => supabase.from("gig_shifts").select("day,earnings").eq("user_id", uid).range(from, to)),
      fetchAll((from, to) => supabase.from("focus_sessions").select("day,minutes").eq("user_id", uid).range(from, to)),
      fetchAll((from, to) => supabase.from("vocab").select("seen").eq("user_id", uid).range(from, to)),
      supabase.from("learning_sessions").select("id", { count: "exact", head: true }).eq("user_id", uid),
      supabase.from("user_settings").select("last_seen_level").eq("user_id", uid).maybeSingle(),
      fetchAll((from, to) => supabase.from("net_worth_snapshots").select("day,value").eq("user_id", uid).order("day").range(from, to)),
      fetchAll((from, to) => supabase.from("engine_reps").select("row_id,day").eq("user_id", uid).range(from, to)),
    ]);

    // READ-ERROR GUARD: 'days' and 'user_achievements' are load-bearing. A failed
    // read yields an empty array that is a NETWORK BLIP, not "no data" — writing it
    // to state would flash streak 0 / a collapsed level and re-toast months-old
    // achievements (and let last_seen_level be reset as if first-run). Keep the
    // prior good state, flag it, and bail so the next interval/refresh recovers.
    if (daysErr || achErr) {
      setRefreshError(true);
      setLoading(false);
      return;
    }
    setRefreshError(false);

    const netWorth = (assets ?? []).reduce((s, a) => s + (a.kind === "asset" ? Number(a.value) : -Number(a.value)), 0);
    const questXP = (questRows ?? []).reduce((s, q) => s + q.xp, 0);
    const gigEarnings = (gigRows ?? []).reduce((s, r) => s + Number(r.earnings), 0);
    const focusMinutesList = (focusRows ?? []).map((r) => r.minutes as number);
    const rows = (dayRows ?? []) as GameDayRow[];

    const g: GameData = {
      days: rows,
      mealsCount: mealsCount ?? 0,
      liftSetsDoneCount: liftSetsDoneCount ?? 0,
      goalsDoneCount: goalsDoneCount ?? 0,
      netWorth,
      questXP,
      // chest/sweep/weekly-review bonus rows bank XP but aren't daily quests —
      // don't let them inflate the quests_10/50/200 achievement counters
      questClaimCount: (questRows ?? []).filter((q) => q.quest_key !== "sweep" && q.quest_key !== "weekly_review" && q.quest_key !== "moneyrep" && !String(q.quest_key).startsWith("chest_") && !String(q.quest_key).startsWith("boss_") && !String(q.quest_key).startsWith("gstep_") && !String(q.quest_key).startsWith("month_")).length,
      gigEarnings,
      focusMinutesList,
      vocabReviews: (vocabRows ?? []).reduce((s, v) => s + (v.seen ?? 0), 0),
      vocabWordCount: (vocabRows ?? []).length,
      learningSessionsCount: learningSessionsCount ?? 0,
      prCount: countPRs((liftHistory ?? []).map((r) => ({ ...r, weight: r.weight == null ? null : Number(r.weight), done: true }))),
      engineRepsCount: (engineReps ?? []).length,
      maxRowRepCount: Math.max(0, ...Object.values(
        (engineReps ?? []).reduce<Record<string, number>>((acc, r) => {
          acc[r.row_id] = (acc[r.row_id] ?? 0) + 1;
          return acc;
        }, {}),
      )),
    };
    setGame(g);
    setDays(rows);
    setNetWorthHistory((nwHistory ?? []).map((r) => ({ day: r.day as string, value: Number(r.value) })));

    setTodayExtras({
      meals: mealsToday ?? 0,
      sets: setsToday ?? 0,
      questXP: (questRows ?? []).filter((q) => q.day === today).reduce((s, q) => s + q.xp, 0),
      gig: (gigRows ?? []).filter((r) => r.day === today).reduce((s, r) => s + Number(r.earnings), 0),
      focusXP: (focusRows ?? []).filter((r) => r.day === today).reduce((s, r) => s + focusXP(r.minutes), 0),
      reps: (engineReps ?? []).filter((r) => r.day === today).length,
    });
    setTodaysQuestClaims(new Set((questRows ?? []).filter((q) => q.day === today).map((q) => q.quest_key as string)));

    // bank fresh achievements (unique index makes double-insert harmless)
    const already = new Set((existing ?? []).map((r) => r.key as string));
    const nowUnlocked = computeUnlocked(g);
    const fresh = nowUnlocked.filter((a) => !already.has(a.key));
    if (fresh.length) {
      const { error: bankErr } = await supabase.from("user_achievements").upsert(
        fresh.map((a) => ({ user_id: uid, key: a.key })),
        { onConflict: "user_id,key", ignoreDuplicates: true },
      );
      // WRITE-THEN-CELEBRATE: only fire the unlock toast once the bank landed —
      // otherwise a later shield-burn can re-lock a volatile achievement whose
      // row never saved, and we'd have celebrated "+XP" that isn't banked.
      if (!bankErr) setNewlyUnlocked(fresh);
    }
    const allKeys = new Set([...already, ...nowUnlocked.map((a) => a.key)]);
    setUnlockedKeys(allKeys);

    // level-up detection against the last level the user has SEEN celebrated.
    // Only trust last_seen_level when its read actually succeeded — a failed
    // settings read reads as seen=0, which would wrongly re-baseline (stomping
    // the real value) or fire a phantom level-up. Skip the block on error.
    const totalXP = baseXP(g) + achievementBonusXP(allKeys);
    const lvl = levelFromXP(totalXP);
    if (!settingsErr) {
      const seen = settingsRow?.last_seen_level ?? 0;
      setLastSeenLevel(seen);
      if (seen === 0) {
        const { error: baselineErr } = await supabase.from("user_settings").upsert({ user_id: uid, last_seen_level: lvl.level }, { onConflict: "user_id" });
        if (!baselineErr) setLastSeenLevel(lvl.level);
      } else if (lvl.level > seen) {
        setLevelUp({ level: lvl.level, title: lvl.title });
      }
    }

    // daily net-worth snapshot (idempotent — one row per day, updated in place)
    if ((assets ?? []).length > 0) {
      await supabase.from("net_worth_snapshots").upsert(
        { user_id: uid, day: today, value: netWorth },
        { onConflict: "user_id,day" },
      );
    }

    setLoading(false);
  }, [uid]);

  useEffect(() => { load(); }, [load]);

  // midnight rollover: the app left open on a non-Today tab must not keep
  // yesterday's todaysQuestClaims / today-scoped XP once the calendar day flips.
  // Re-run load() (which recomputes all day-scoped state) when todayStr() changes.
  const loadedDay = useRef(todayStr());
  useEffect(() => {
    const check = () => {
      const now = todayStr();
      if (now !== loadedDay.current) { loadedDay.current = now; load(); }
    };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    const id = setInterval(check, 30000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);

  const dismissLevelUp = useCallback(async () => {
    if (!levelUp) return;
    const lv = levelUp.level;
    setLevelUp(null);
    setLastSeenLevel(lv);
    await supabase.from("user_settings").upsert({ user_id: uid, last_seen_level: lv }, { onConflict: "user_id" });
  }, [levelUp, uid]);

  const bankQuestXP = useCallback(async (key: string, xp: number): Promise<boolean> => {
    const { error } = await supabase.from("quest_claims").insert({ user_id: uid, day: todayStr(), quest_key: key, xp });
    if (error) return false;
    setTodaysQuestClaims((s) => new Set(s).add(key));
    setGame((g) => ({ ...g, questXP: g.questXP + xp, questClaimCount: g.questClaimCount + 1 }));
    setTodayExtras((t) => ({ ...t, questXP: t.questXP + xp }));
    return true;
  }, [uid]);

  const totalXP = baseXP(game) + achievementBonusXP(unlockedKeys);
  const level = levelFromXP(totalXP);
  const streak = useMemo(() => computeStreak(game.days), [game.days]);

  // watch for level crossings caused by in-session refreshes
  useEffect(() => {
    if (!loading && lastSeenLevel != null && lastSeenLevel > 0 && level.level > lastSeenLevel && !levelUp) {
      setLevelUp({ level: level.level, title: level.title });
    }
  }, [level.level, lastSeenLevel, loading, levelUp, level.title]);

  const latestBodyweight = [...game.days]
    .filter((d) => d.bodyweight != null)
    .sort((a, b) => a.day.localeCompare(b.day))
    .pop()?.bodyweight ?? null;

  const todayRow = days.find((d) => d.day === todayStr());
  let todayXP = 0;
  if (todayRow) {
    for (const k of WIN_KEYS) if (todayRow[k]) todayXP += HABIT_XP[k];
    if (todayRow.bodyweight != null) todayXP += 5;
    if (scoreOf(todayRow) === WIN_TOTAL) todayXP += Math.min(10 * streak.streak, 100);
    todayXP += (todayRow.vocab_reviews ?? 0) * VOCAB_REVIEW_XP;
  }
  todayXP += todayExtras.meals * MEAL_XP + todayExtras.sets * LIFT_SET_XP + todayExtras.questXP
    + Math.floor(todayExtras.gig / GIG_XP_PER_DOLLARS) + todayExtras.focusXP + todayExtras.reps * REP_XP;

  const value: GameState = {
    loading,
    refreshError,
    uid,
    level,
    streak,
    netWorth: game.netWorth,
    netWorthHistory,
    latestBodyweight: latestBodyweight != null ? Number(latestBodyweight) : null,
    days,
    todayXP,
    unlocked: ACHIEVEMENTS.filter((a) => unlockedKeys.has(a.key)),
    locked: ACHIEVEMENTS.filter((a) => !unlockedKeys.has(a.key)),
    newlyUnlocked,
    dismissNew: () => setNewlyUnlocked([]),
    levelUp,
    dismissLevelUp,
    todaysQuestClaims,
    bankQuestXP,
    refresh: load,
  };

  return createElement(GameContext.Provider, { value }, children);
}

export function useGame(): GameState {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error("useGame must be used inside <GameProvider>");
  return ctx;
}

export { NORTH_STAR };

// legacy per-component hook shim — prefer useGame()
export function useGameData(_uid: string): GameState {
  return useGame();
}

export type { DayRow };
