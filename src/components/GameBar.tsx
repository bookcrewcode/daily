"use client";

import { useGameData } from "@/lib/useGameData";
import { Celebration } from "./ui";

export default function GameBar({ uid }: { uid: string }) {
  const game = useGameData(uid);
  if (game.loading) return <div className="skeleton h-[74px] mt-3" />;
  const { level } = game;
  const toast = game.newlyUnlocked[0];
  const nearLevelUp = level.pct >= 0.85;

  return (
    <div className="mt-3">
      <div className={`rounded-2xl bg-white/5 border px-4 py-3 ${nearLevelUp ? "border-[var(--neon)]/50 glow-neon" : "border-white/10"}`}>
        <div className="flex items-center justify-between">
          <p className="font-bold text-sm">
            Lv.{level.level} <span className="text-[var(--neon)] text-glow">{level.title}</span>
          </p>
          {game.streak > 0 && (
            <p className="text-xs font-semibold">
              <span className="flame">🔥</span> {game.streak}-day streak
            </p>
          )}
        </div>
        <div className="h-2 rounded-full bg-white/10 mt-2 overflow-hidden">
          <div className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${Math.min(level.pct * 100, 100)}%`, background: "linear-gradient(90deg,#34d399,#2dd4bf)" }} />
        </div>
        <p className="text-[10px] opacity-40 mt-1">
          {level.into.toLocaleString()} / {level.span.toLocaleString()} XP to Lv.{level.level + 1} · {level.totalXP.toLocaleString()} total
          {nearLevelUp && <span className="text-[var(--neon)] opacity-100"> · almost there ⚡</span>}
        </p>
      </div>

      {toast && (
        <Celebration emoji={toast.emoji} title={toast.name} subtitle={`+${toast.xp} XP`} onClose={game.dismissNew} />
      )}
    </div>
  );
}
