"use client";

import { useGameData, NORTH_STAR } from "@/lib/useGameData";
import { SectionTitle } from "./ui";

const fmt = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
      <div className="h-full rounded-full bg-[var(--neon)]" style={{ width: `${Math.min(Math.max(pct * 100, 2), 100)}%` }} />
    </div>
  );
}

export default function NorthStar({ uid }: { uid: string }) {
  const game = useGameData(uid);
  if (game.loading) return null;

  const netPct = game.netWorth / NORTH_STAR.netWorthTarget;
  const w = game.latestBodyweight;
  const weightDelta = w != null ? w - NORTH_STAR.leanWeightTarget : null;

  return (
    <div>
      <SectionTitle>The long game — years, not days</SectionTitle>

      <div className="space-y-3">
        <div className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs uppercase tracking-widest opacity-60">👑 Millionaire</p>
            <p className="text-xs font-bold text-[var(--neon)]">{(netPct * 100).toFixed(1)}%</p>
          </div>
          <p className="text-xl font-extrabold mb-2">{fmt(game.netWorth)} <span className="opacity-40 text-sm font-normal">/ {fmt(NORTH_STAR.netWorthTarget)}</span></p>
          <Bar pct={netPct} />
        </div>

        <div className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs uppercase tracking-widest opacity-60">🏆 190 Lean</p>
          </div>
          {w == null ? (
            <p className="text-sm opacity-60 mt-1">Log your weight on Today to start tracking this.</p>
          ) : (
            <>
              <p className="text-xl font-extrabold mb-2">
                {w} lb <span className="opacity-40 text-sm font-normal">/ {NORTH_STAR.leanWeightTarget} target</span>
              </p>
              <p className="text-xs opacity-60">
                {weightDelta === 0 ? "🎉 At target." : weightDelta! > 0 ? `${weightDelta!.toFixed(1)} lb to lose` : `${Math.abs(weightDelta!).toFixed(1)} lb to gain`}
              </p>
            </>
          )}
        </div>
      </div>

      <SectionTitle>🏆 Achievements · {game.unlocked.length}/{game.unlocked.length + game.locked.length}</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        {game.unlocked.map((a) => (
          <div key={a.key} className="rounded-xl bg-[var(--neon)]/10 border border-[var(--neon)]/40 p-3">
            <p className="text-xl">{a.emoji}</p>
            <p className="text-sm font-bold leading-tight mt-1">{a.name}</p>
            <p className="text-[10px] opacity-50 mt-0.5">+{a.xp} XP</p>
          </div>
        ))}
        {game.locked.map((a) => (
          <div key={a.key} className="rounded-xl bg-white/5 border border-white/10 p-3 opacity-40">
            <p className="text-xl grayscale">{a.emoji}</p>
            <p className="text-sm font-bold leading-tight mt-1">{a.name}</p>
            <p className="text-[10px] opacity-70 mt-0.5">{a.desc || `+${a.xp} XP`}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
