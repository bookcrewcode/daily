"use client";

// GitHub-style year heatmap — the "progress you can feel" artifact. Every
// green cell is a day that happened; the wall of green is the point.
import { useMemo } from "react";
import { dateStr } from "@/lib/supabase";
import { useGame } from "@/lib/useGameData";
import { scoreOf, WIN_TOTAL } from "@/lib/gamification";
import { SectionTitle } from "./ui";

const WEEKS = 26; // ~6 months fits nicely; scrollable anyway

export default function YearHeatmap() {
  const game = useGame();

  const { cells, monthMarks } = useMemo(() => {
    const byDay = new Map(game.days.map((d) => [d.day, scoreOf(d)]));
    // columns = weeks, rows = Sun..Sat, ending at today's week
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + (6 - end.getDay())); // end of this week
    const start = new Date(end);
    start.setDate(start.getDate() - WEEKS * 7 + 1);

    const cols: { day: string; score: number | null; future: boolean }[][] = [];
    const marks: { col: number; label: string }[] = [];
    const cursor = new Date(start);
    let lastMonth = -1;
    for (let w = 0; w < WEEKS; w++) {
      const col: { day: string; score: number | null; future: boolean }[] = [];
      for (let d = 0; d < 7; d++) {
        const ds = dateStr(cursor);
        const future = cursor > today;
        col.push({ day: ds, score: byDay.get(ds) ?? null, future });
        if (cursor.getDate() <= 7 && cursor.getMonth() !== lastMonth && d === 0) {
          lastMonth = cursor.getMonth();
          marks.push({ col: w, label: cursor.toLocaleDateString(undefined, { month: "short" }) });
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      cols.push(col);
    }
    return { cells: cols, monthMarks: marks };
  }, [game.days]);

  if (game.loading) return null;

  return (
    <div>
      <SectionTitle>🟩 The wall — every day you showed up</SectionTitle>
      <div className="overflow-x-auto -mx-4 px-4 pb-1" style={{ direction: "rtl" }}>
        <div style={{ direction: "ltr" }} className="inline-block">
          <div className="flex gap-[3px] mb-1 text-[9px] opacity-40" style={{ paddingLeft: 0 }}>
            {cells.map((_, w) => {
              const mark = monthMarks.find((m) => m.col === w);
              return <div key={w} className="w-[13px] shrink-0">{mark?.label ?? ""}</div>;
            })}
          </div>
          <div className="flex gap-[3px]">
            {cells.map((col, w) => (
              <div key={w} className="flex flex-col gap-[3px]">
                {col.map((c) => {
                  const pct = c.score != null ? c.score / WIN_TOTAL : 0;
                  return (
                    <div key={c.day} title={`${c.day}: ${c.score ?? 0}/${WIN_TOTAL}`}
                      className="w-[13px] h-[13px] rounded-[3px]"
                      style={{
                        background: c.future ? "transparent"
                          : c.score == null ? "rgba(255,255,255,0.06)"
                          : `rgba(167,139,250,${0.15 + pct * 0.85})`,
                        outline: pct >= 1 ? "1px solid rgba(251,191,36,0.6)" : undefined,
                      }} />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="text-[10px] opacity-40 mt-1.5">gold ring = perfect day (11/11) · darker green = more wins</p>
    </div>
  );
}
