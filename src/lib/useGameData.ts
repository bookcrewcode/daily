"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import {
  ACHIEVEMENTS, NORTH_STAR, achievementBonusXP, baseXP, computeUnlocked,
  currentFullStreak, levelFromXP, type Achievement, type GameData,
} from "./gamification";

export type GameState = {
  loading: boolean;
  level: { level: number; title: string; into: number; span: number; pct: number; totalXP: number };
  streak: number;
  netWorth: number;
  latestBodyweight: number | null;
  unlocked: Achievement[];
  locked: Achievement[];
  newlyUnlocked: Achievement[];
  dismissNew: () => void;
  refresh: () => void;
};

export function useGameData(uid: string): GameState {
  const [loading, setLoading] = useState(true);
  const [game, setGame] = useState<GameData>({ days: [], mealsCount: 0, liftSetsDoneCount: 0, goalsDoneCount: 0, netWorth: 0 });
  const [unlockedKeys, setUnlockedKeys] = useState<Set<string>>(new Set());
  const [newlyUnlocked, setNewlyUnlocked] = useState<Achievement[]>([]);

  const load = useCallback(async () => {
    const [{ data: days }, { count: mealsCount }, { count: liftSetsDoneCount }, { count: goalsDoneCount }, { data: assets }, { data: existing }] =
      await Promise.all([
        supabase.from("days").select("day,ws_meds,ws_eat,ws_lift,ws_stretch,ws_vocab,ws_chinese,ws_work,bodyweight").eq("user_id", uid),
        supabase.from("meals").select("id", { count: "exact", head: true }).eq("user_id", uid),
        supabase.from("lift_sets").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("done", true),
        supabase.from("goals").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("status", "done"),
        supabase.from("assets").select("kind,value").eq("user_id", uid),
        supabase.from("user_achievements").select("key").eq("user_id", uid),
      ]);

    const netWorth = (assets ?? []).reduce((s, a) => s + (a.kind === "asset" ? Number(a.value) : -Number(a.value)), 0);
    const g: GameData = {
      days: (days ?? []) as GameData["days"],
      mealsCount: mealsCount ?? 0,
      liftSetsDoneCount: liftSetsDoneCount ?? 0,
      goalsDoneCount: goalsDoneCount ?? 0,
      netWorth,
    };
    setGame(g);

    const already = new Set((existing ?? []).map((r) => r.key as string));
    const nowUnlocked = computeUnlocked(g);
    const fresh = nowUnlocked.filter((a) => !already.has(a.key));
    if (fresh.length) {
      await supabase.from("user_achievements").insert(fresh.map((a) => ({ user_id: uid, key: a.key })));
      setNewlyUnlocked(fresh);
    }
    setUnlockedKeys(new Set(nowUnlocked.map((a) => a.key)));
    setLoading(false);
  }, [uid]);

  useEffect(() => { load(); }, [load]);

  const totalXP = baseXP(game) + achievementBonusXP(unlockedKeys);
  const latestBodyweight = [...game.days]
    .filter((d) => d.bodyweight != null)
    .sort((a, b) => a.day.localeCompare(b.day))
    .pop()?.bodyweight ?? null;

  return {
    loading,
    level: levelFromXP(totalXP),
    streak: currentFullStreak(game.days),
    netWorth: game.netWorth,
    latestBodyweight: latestBodyweight != null ? Number(latestBodyweight) : null,
    unlocked: ACHIEVEMENTS.filter((a) => unlockedKeys.has(a.key)),
    locked: ACHIEVEMENTS.filter((a) => !unlockedKeys.has(a.key)),
    newlyUnlocked,
    dismissNew: () => setNewlyUnlocked([]),
    refresh: load,
  };
}

export { NORTH_STAR };
