"use client";

// This week vs last week — derived entirely from the game context, no fetches.
import { dateStr, WIN_KEYS } from "@/lib/supabase";
import { useGame } from "@/lib/useGameData";
import { Card, SectionTitle } from "./ui";

function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n); return dateStr(d);
}

export default function WeeklyRecap() {
  const game = useGame();
  if (game.loading) return null;

  const thisWeekKeys = new Set(Array.from({ length: 7 }, (_, i) => daysAgo(i)));
  const lastWeekKeys = new Set(Array.from({ length: 7 }, (_, i) => daysAgo(i + 7)));
  const thisWeek = game.days.filter((d) => thisWeekKeys.has(d.day));
  const lastWeek = game.days.filter((d) => lastWeekKeys.has(d.day));

  const wins = (rows: typeof thisWeek) => rows.reduce((s, d) => s + WIN_KEYS.reduce((x, k) => x + (d[k] ? 1 : 0), 0), 0);
  const liftDays = (rows: typeof thisWeek) => rows.filter((d) => d.ws_lift).length;
  const avgCal = (rows: typeof thisWeek) => {
    const withCal = rows.filter((d) => d.calories > 0);
    return withCal.length ? Math.round(withCal.reduce((s, d) => s + d.calories, 0) / withCal.length) : 0;
  };
  const weightDelta = () => {
    const weighed = [...thisWeek, ...lastWeek].filter((d) => d.bodyweight != null).sort((a, b) => a.day.localeCompare(b.day));
    if (weighed.length < 2) return null;
    return Number(weighed[weighed.length - 1].bodyweight) - Number(weighed[0].bodyweight);
  };

  const w = { now: wins(thisWeek), prev: wins(lastWeek) };
  const l = { now: liftDays(thisWeek), prev: liftDays(lastWeek) };
  const c = { now: avgCal(thisWeek), prev: avgCal(lastWeek) };
  const wd = weightDelta();

  const arrow = (now: number, prev: number, invert = false) => {
    if (now === prev) return <span className="opacity-40">→</span>;
    const up = now > prev;
    const good = invert ? !up : up;
    return <span className={good ? "text-[var(--neon)]" : "text-orange-400"}>{up ? "↑" : "↓"}</span>;
  };

  if (thisWeek.length === 0 && lastWeek.length === 0) return null;

  return (
    <div>
      <SectionTitle>📊 This week vs last</SectionTitle>
      <Card padded={false} className="p-3">
        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <p className="text-lg font-extrabold tabular-nums">{w.now} {arrow(w.now, w.prev)}</p>
            <p className="text-[10px] opacity-50">wins <span className="opacity-60">({w.prev} last)</span></p>
          </div>
          <div>
            <p className="text-lg font-extrabold tabular-nums">{l.now} {arrow(l.now, l.prev)}</p>
            <p className="text-[10px] opacity-50">lift days <span className="opacity-60">({l.prev})</span></p>
          </div>
          <div>
            <p className="text-lg font-extrabold tabular-nums">{c.now || "—"}</p>
            <p className="text-[10px] opacity-50">avg kcal <span className="opacity-60">({c.prev || "—"})</span></p>
          </div>
          <div>
            <p className={`text-lg font-extrabold tabular-nums ${wd != null && wd < 0 ? "text-[var(--neon)]" : ""}`}>
              {wd == null ? "—" : `${wd > 0 ? "+" : ""}${wd.toFixed(1)}`}
            </p>
            <p className="text-[10px] opacity-50">lb (2 wks)</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
