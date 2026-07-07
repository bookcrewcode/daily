"use client";

import { useGameData, NORTH_STAR } from "@/lib/useGameData";
import { CATEGORIES } from "@/lib/gamification";
import { SectionTitle, Card, ProgressBar } from "./ui";
import Rewards from "./Rewards";
import HistoryCalendar from "./HistoryCalendar";

const fmt = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function NorthStar({ uid }: { uid: string }) {
  const game = useGameData(uid);
  if (game.loading) return null;

  const netPct = game.netWorth / NORTH_STAR.netWorthTarget;
  const w = game.latestBodyweight;
  const weightDelta = w != null ? w - NORTH_STAR.leanWeightTarget : null;
  const unlockedKeys = new Set(game.unlocked.map((a) => a.key));

  return (
    <div>
      <SectionTitle id="northstar">The long game — years, not days</SectionTitle>

      <div className="space-y-3">
        <Card>
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs uppercase tracking-widest opacity-60">👑 Millionaire</p>
            <p className="text-xs font-bold text-[var(--neon)]">{(netPct * 100).toFixed(1)}%</p>
          </div>
          <p className="text-xl font-extrabold mb-2">{fmt(game.netWorth)} <span className="opacity-40 text-sm font-normal">/ {fmt(NORTH_STAR.netWorthTarget)}</span></p>
          <ProgressBar pct={netPct} />
        </Card>

        <Card>
          <p className="text-xs uppercase tracking-widest opacity-60 mb-1">🏆 190 Lean</p>
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
        </Card>
      </div>

      <HistoryCalendar uid={uid} />

      <SectionTitle id="achievements">🏆 Achievements · {game.unlocked.length}/{game.unlocked.length + game.locked.length}</SectionTitle>
      <div className="space-y-4">
        {CATEGORIES.map((cat) => {
          const items = cat.keys.map((k) => [...game.unlocked, ...game.locked].find((a) => a.key === k)).filter(Boolean);
          const unlockedCount = items.filter((a) => a && unlockedKeys.has(a.key)).length;
          return (
            <div key={cat.key}>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-semibold opacity-70">{cat.emoji} {cat.label}</p>
                <p className="text-[10px] opacity-40">{unlockedCount}/{items.length}</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {items.map((a) => {
                  if (!a) return null;
                  const isUnlocked = unlockedKeys.has(a.key);
                  return (
                    <Card key={a.key} padded={false} className={`p-3 ${isUnlocked ? "bg-[var(--neon)]/10 border-[var(--neon)]/40" : "bg-white/5 border-white/10 opacity-40"}`}>
                      <p className="text-xl">{a.emoji}</p>
                      <p className="text-sm font-bold leading-tight mt-1">{a.name}</p>
                      <p className="text-[10px] opacity-50 mt-0.5">{isUnlocked ? `+${a.xp} XP` : (a.desc || `+${a.xp} XP`)}</p>
                    </Card>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <Rewards uid={uid} level={game.level.level} />
    </div>
  );
}
