"use client";

import { useGame, NORTH_STAR } from "@/lib/useGameData";
import { ACHIEVEMENTS, CATEGORIES } from "@/lib/gamification";
import { SectionTitle, Card, ProgressBar, Sparkline } from "./ui";
import Rewards from "./Rewards";
import HistoryCalendar from "./HistoryCalendar";
import YearHeatmap from "./YearHeatmap";

const fmt = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

// 7-day trailing average — daily weight is noisy; the trend is the signal.
function rollingAvg(values: number[], window = 7): number[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

export default function NorthStar({ uid: _uid }: { uid: string }) {
  const game = useGame();
  if (game.loading) return null;

  const netPct = game.netWorth / NORTH_STAR.netWorthTarget;
  const w = game.latestBodyweight;
  const weightDelta = w != null ? w - NORTH_STAR.leanWeightTarget : null;
  const unlockedKeys = new Set(game.unlocked.map((a) => a.key));

  // bodyweight series (last 90 logged weigh-ins, oldest → newest)
  const weighIns = [...game.days]
    .filter((d) => d.bodyweight != null)
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-90);
  const weights = weighIns.map((d) => Number(d.bodyweight));
  const avg = rollingAvg(weights);
  // trend normalized to CALENDAR days — weigh-ins are sparse, so "7 entries
  // back" can span weeks and would overstate the weekly rate
  let lbsPerWeek: number | null = null;
  if (weighIns.length >= 4) {
    const lastMs = new Date(weighIns[weighIns.length - 1].day + "T00:00:00").getTime();
    let j = weighIns.length - 1;
    while (j > 0 && (lastMs - new Date(weighIns[j].day + "T00:00:00").getTime()) / 86400000 < 7) j--;
    const spanDays = (lastMs - new Date(weighIns[j].day + "T00:00:00").getTime()) / 86400000;
    if (spanDays >= 4) lbsPerWeek = (avg[avg.length - 1] - avg[j]) * (7 / spanDays);
  }

  // next money milestone
  const NET_MILESTONES: [string, number][] = [
    ["net_1k", 1_000], ["net_10k", 10_000], ["net_25k", 25_000], ["net_50k", 50_000],
    ["net_100k", 100_000], ["net_250k", 250_000], ["net_500k", 500_000], ["net_750k", 750_000],
    ["millionaire", 1_000_000],
  ];
  const nextNet = NET_MILESTONES
    .filter(([key, v]) => !unlockedKeys.has(key) && v > game.netWorth)
    .map(([key, v]) => ({ a: ACHIEVEMENTS.find((x) => x.key === key)!, threshold: v }))
    .sort((x, y) => x.threshold - y.threshold)[0];

  const nwValues = game.netWorthHistory.map((h) => h.value);

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
          {nwValues.length >= 2 && (
            <div className="mt-3">
              <Sparkline series={[{ values: nwValues, color: "#34d399" }]} height={48} />
              <p className="text-[10px] opacity-40 mt-1">net worth over time · daily snapshots</p>
            </div>
          )}
          {nextNet && (
            <p className="text-xs opacity-60 mt-2">
              Next: {nextNet.a.emoji} <b>{nextNet.a.name}</b> — {fmt(nextNet.threshold - game.netWorth)} away (+{nextNet.a.xp} XP)
            </p>
          )}
        </Card>

        <Card>
          <p className="text-xs uppercase tracking-widest opacity-60 mb-1">🏆 190 Lean</p>
          {w == null ? (
            <p className="text-sm opacity-60 mt-1">Log your weight on Today to start tracking this.</p>
          ) : (
            <>
              <p className="text-xl font-extrabold mb-1">
                {w} lb <span className="opacity-40 text-sm font-normal">/ {NORTH_STAR.leanWeightTarget} target</span>
              </p>
              {weights.length >= 2 && (
                <Sparkline
                  series={[
                    { values: weights, color: "rgba(255,255,255,0.35)", width: 1, opacity: 0.7 },
                    { values: avg, color: "#34d399", width: 2 },
                  ]}
                  goal={NORTH_STAR.leanWeightTarget}
                  height={56}
                />
              )}
              <p className="text-xs opacity-60 mt-1">
                {weightDelta === 0 ? "🎉 At target." : weightDelta! > 0 ? `${weightDelta!.toFixed(1)} lb to lose` : `${Math.abs(weightDelta!).toFixed(1)} lb to gain`}
                {lbsPerWeek != null && Math.abs(lbsPerWeek) > 0.05 && (
                  <span className={lbsPerWeek < 0 ? "text-[var(--neon)]" : "text-orange-300"}>
                    {" "}· {lbsPerWeek > 0 ? "+" : ""}{lbsPerWeek.toFixed(1)} lb/wk trend
                  </span>
                )}
              </p>
            </>
          )}
        </Card>
      </div>

      <HistoryCalendar uid={game.uid} />
      <YearHeatmap />

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

      <Rewards uid={game.uid} level={game.level.level} />
    </div>
  );
}
