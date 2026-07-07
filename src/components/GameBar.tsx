"use client";

import { useGameData } from "@/lib/useGameData";
import { Celebration } from "./ui";

export default function GameBar({ uid }: { uid: string }) {
  const game = useGameData(uid);
  if (game.loading) return null;
  const { level } = game;
  const toast = game.newlyUnlocked[0];

  return (
    <div className="mt-3">
      <div className="rounded-2xl bg-white/5 border border-white/10 px-4 py-3">
        <div className="flex items-center justify-between">
          <p className="font-bold text-sm">
            Lv.{level.level} <span className="text-[var(--neon)]">{level.title}</span>
          </p>
          {game.streak > 0 && <p className="text-xs opacity-60">🔥 {game.streak}-day streak</p>}
        </div>
        <div className="h-2 rounded-full bg-white/10 mt-2 overflow-hidden">
          <div className="h-full rounded-full bg-[var(--neon)] transition-[width] duration-500" style={{ width: `${Math.min(level.pct * 100, 100)}%` }} />
        </div>
        <p className="text-[10px] opacity-40 mt-1">{level.into.toLocaleString()} / {level.span.toLocaleString()} XP to Lv.{level.level + 1} · {level.totalXP.toLocaleString()} total</p>
      </div>

      {toast && (
        <Celebration emoji={toast.emoji} title={toast.name} subtitle={`+${toast.xp} XP`} onClose={game.dismissNew} />
      )}
    </div>
  );
}
