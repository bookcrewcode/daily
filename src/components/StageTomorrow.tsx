"use client";

// 🎒 Stage tomorrow — the pre-commitment step.
//
// "Disciplined" people aren't stronger in the morning; they made the decision
// the night before and removed the friction while motivation was still cheap.
// This lists every Engine row's friction fix and lets Ben tick them off tonight,
// so tomorrow the right action is already the path of least resistance.
//
// staged_on is stamped per row for the day being staged, so the list resets
// each night and shows what's already set up.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, dateStr } from "@/lib/supabase";
import { sfx } from "@/lib/fx";
import { SectionTitle, Card } from "./ui";

type Row = { id: string; emoji: string; name: string; friction: string; staged_on: string | null };

export default function StageTomorrow({ uid }: { uid: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState("");

  // the day being staged FOR (tomorrow), recomputed live so a PWA open across
  // midnight stages the right day
  const targetDay = () => { const d = new Date(); d.setDate(d.getDate() + 1); return dateStr(d); };
  const [day, setDay] = useState(targetDay());
  const dayRef = useRef(day);
  dayRef.current = day;

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("engine_rows")
      .select("id,emoji,name,friction,staged_on").eq("user_id", uid).eq("archived", false).order("sort");
    if (error) { setLoaded(true); return; } // keep whatever's on screen
    setRows(((data ?? []) as Row[]).filter((r) => (r.friction ?? "").trim()));
    setLoaded(true);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  // rollover guard — re-anchor "tomorrow" when the calendar day flips
  useEffect(() => {
    const check = () => {
      const t = targetDay();
      if (t !== dayRef.current) { setDay(t); load(); }
    };
    const id = setInterval(check, 30000);
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  async function toggle(r: Row) {
    if (busyId) return;
    setBusyId(r.id);
    setNote("");
    const staged = r.staged_on === day;
    const next = staged ? null : day;
    // write first — only reflect it locally once the DB confirms
    const { error } = await supabase.from("engine_rows").update({ staged_on: next }).eq("id", r.id);
    setBusyId("");
    if (error) { setNote("Couldn't save that — try again."); return; }
    setRows((x) => x.map((row) => (row.id === r.id ? { ...row, staged_on: next } : row)));
    if (!staged) sfx.pop();
  }

  if (!loaded || rows.length === 0) return null;

  const doneCount = rows.filter((r) => r.staged_on === day).length;
  const allSet = doneCount === rows.length;

  return (
    <>
      <SectionTitle>🎒 Stage tomorrow</SectionTitle>
      <Card tone={allSet ? "neon" : "default"}>
        <p className="text-xs opacity-60 mb-2">
          {allSet
            ? "Everything's set up. Tomorrow-you just has to show up."
            : "Set these up tonight — tomorrow the right move should be easier than skipping it."}
        </p>
        <div className="space-y-1.5">
          {rows.map((r) => {
            const staged = r.staged_on === day;
            return (
              <button key={r.id} onClick={() => toggle(r)} disabled={busyId === r.id}
                className="flex items-center gap-2.5 w-full text-left active:scale-[0.99] disabled:opacity-50">
                <span className={`w-5 h-5 shrink-0 rounded-md grid place-items-center text-[10px] font-bold ${staged ? "bg-[var(--neon)] text-black" : "border border-white/25"}`}>
                  {staged ? "✓" : ""}
                </span>
                <span className="text-sm shrink-0">{r.emoji}</span>
                <span className={`flex-1 min-w-0 text-sm ${staged ? "line-through opacity-40" : ""}`}>{r.friction}</span>
              </button>
            );
          })}
        </div>
        <p className="text-[10px] opacity-40 mt-2">{doneCount}/{rows.length} staged · set these in 🔧 on each Engine row</p>
        {note && <p className="text-xs text-orange-400 mt-1">{note}</p>}
      </Card>
    </>
  );
}
