"use client";

import { useGameData } from "@/lib/useGameData";

export default function GameBar({ uid }: { uid: string }) {
  const game = useGameData(uid);
  if (game.loading) return null;
  const { level } = game;

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
          <div className="h-full rounded-full bg-[var(--neon)]" style={{ width: `${Math.min(level.pct * 100, 100)}%` }} />
        </div>
        <p className="text-[10px] opacity-40 mt-1">{level.into.toLocaleString()} / {level.span.toLocaleString()} XP to Lv.{level.level + 1} · {level.totalXP.toLocaleString()} total</p>
      </div>

      {game.newlyUnlocked.length > 0 && (
        <div className="mt-2 space-y-2">
          {game.newlyUnlocked.map((a) => (
            <div key={a.key} className="rounded-2xl bg-[var(--neon)]/15 border border-[var(--neon)]/50 px-4 py-3 flex items-center gap-3">
              <span className="text-2xl">{a.emoji}</span>
              <div className="flex-1">
                <p className="text-xs uppercase tracking-widest text-[var(--neon)]">Achievement unlocked</p>
                <p className="font-bold text-sm">{a.name} <span className="opacity-50 font-normal">+{a.xp} XP</span></p>
              </div>
              <button onClick={game.dismissNew} className="opacity-50 active:scale-90">✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
