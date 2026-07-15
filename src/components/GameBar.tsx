"use client";

import { useGame } from "@/lib/useGameData";

export default function GameBar() {
  const game = useGame();
  if (game.loading) return <div className="skeleton h-[84px] mt-3" />;
  const { level, streak } = game;
  const nearLevelUp = level.pct >= 0.85;

  return (
    <div className="mt-3">
      <div className={`rounded-2xl bg-white/5 border px-4 py-3 ${nearLevelUp ? "border-[var(--neon)]/50 glow-neon" : "border-white/10"}`}>
        <div className="flex items-center justify-between">
          <p className="font-bold text-sm">
            Lv.{level.level} <span className="text-[var(--neon)] text-glow">{level.title}</span>
            {game.todayXP > 0 && (
              <span className="ml-2 text-[10px] font-extrabold text-[var(--neon)] bg-[var(--neon)]/10 border border-[var(--neon)]/30 rounded-full px-2 py-0.5">
                ⚡ +{game.todayXP} today
              </span>
            )}
          </p>
          {streak.streak > 0 && (
            <p className="text-xs font-semibold flex items-center gap-1">
              <span className={`flame ${streak.perfect ? "flame-gold" : ""}`}>🔥</span>
              {streak.streak}d
              <span className="opacity-60 tracking-tighter" title="Streak shields — a missed day uses one instead of breaking the chain">
                {"🛡".repeat(streak.shields)}
              </span>
            </p>
          )}
        </div>
        <div className="h-2 rounded-full bg-white/10 mt-2 overflow-hidden">
          <div className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${Math.min(level.pct * 100, 100)}%`, background: "linear-gradient(90deg,#a78bfa,#818cf8)" }} />
        </div>
        <p className="text-[10px] opacity-40 mt-1">
          {level.into.toLocaleString()} / {level.span.toLocaleString()} XP to Lv.{level.level + 1} · {level.totalXP.toLocaleString()} total
          {nearLevelUp && <span className="text-[var(--neon)] opacity-100"> · almost there ⚡</span>}
        </p>
        {streak.shieldSpentRecently && (
          <p className="text-[10px] text-sky-300/80 mt-1">🛡 A shield saved your streak — it regenerates after 7 full days.</p>
        )}
      </div>
    </div>
  );
}
