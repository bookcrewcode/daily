"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, WIN_KEYS, dateStr, type DayRow } from "@/lib/supabase";
import { Card, SectionTitle } from "./ui";

type Row = Pick<DayRow, "day" | "calories" | "bodyweight"> & Record<(typeof WIN_KEYS)[number], boolean>;

function monthLabel(d: Date) { return d.toLocaleDateString(undefined, { month: "long", year: "numeric" }); }

export default function HistoryCalendar({ uid }: { uid: string }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const [rows, setRows] = useState<Map<string, Row>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);

  const monthStart = useMemo(() => new Date(cursor.getFullYear(), cursor.getMonth(), 1), [cursor]);
  const monthEnd = useMemo(() => new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0), [cursor]);

  const load = useCallback(async () => {
    const { data } = await supabase.from("days").select("*").eq("user_id", uid)
      .gte("day", dateStr(monthStart)).lte("day", dateStr(monthEnd));
    setRows(new Map((data ?? []).map((r) => [r.day as string, r as Row])));
  }, [uid, monthStart, monthEnd]);
  useEffect(() => { load(); }, [load]);

  const firstWeekday = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();
  const cells: (Date | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => new Date(cursor.getFullYear(), cursor.getMonth(), i + 1))];

  const sel = selected ? rows.get(selected) : null;
  const isFuture = (d: Date) => d > new Date(new Date().toDateString());

  return (
    <div>
      <SectionTitle id="history">🗓️ History — look back</SectionTitle>
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))} className="px-3 py-1.5 rounded-lg bg-white/5 active:scale-90">‹</button>
        <p className="font-bold text-sm">{monthLabel(cursor)}</p>
        <button onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))} className="px-3 py-1.5 rounded-lg bg-white/5 active:scale-90">›</button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[10px] opacity-40 mb-1">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <div key={i} />;
          const ds = dateStr(d);
          const row = rows.get(ds);
          const score = row ? WIN_KEYS.reduce((s, k) => s + (row[k] ? 1 : 0), 0) : 0;
          const pct = score / WIN_KEYS.length;
          const future = isFuture(d);
          const isToday = ds === dateStr(new Date());
          return (
            <button key={ds} disabled={future} onClick={() => setSelected(ds)}
              className={`aspect-square rounded-lg text-[10px] font-semibold grid place-items-center transition ${future ? "opacity-10" : ""} ${isToday ? "ring-1 ring-[var(--neon)]" : ""}`}
              style={{ background: !future && score > 0 ? `rgba(57,255,20,${0.12 + pct * 0.55})` : "rgba(255,255,255,0.04)" }}>
              {d.getDate()}
            </button>
          );
        })}
      </div>

      {sel && (
        <Card className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <p className="font-bold text-sm">{new Date(selected! + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</p>
            <button onClick={() => setSelected(null)} className="opacity-40 active:scale-90">✕</button>
          </div>
          <p className="text-xs opacity-60">{WIN_KEYS.reduce((s, k) => s + (sel[k] ? 1 : 0), 0)}/{WIN_KEYS.length} wins · {sel.calories || 0} kcal{sel.bodyweight ? ` · ${sel.bodyweight} lb` : ""}</p>
        </Card>
      )}
      {selected && !sel && (
        <p className="text-xs opacity-30 mt-2">No data logged that day.</p>
      )}
    </div>
  );
}
