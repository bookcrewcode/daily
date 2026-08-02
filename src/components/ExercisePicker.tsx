"use client";

// 🔎 Exercise picker — search a real library of 873 exercises (seeded from
// free-exercise-db, Unlicense) by name, muscle, or equipment, see how to do it,
// and add it to a workout day. Beats typing exercise names from memory.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import { Card } from "./ui";

export type LibExercise = {
  id: string;
  name: string;
  level: string | null;
  mechanic: string | null;
  equipment: string | null;
  primary_muscles: string[];
  secondary_muscles: string[];
  category: string | null;
  instructions: string[];
};

const MUSCLES = ["chest", "lats", "middle back", "shoulders", "biceps", "triceps", "quadriceps", "hamstrings", "glutes", "calves", "abdominals", "forearms", "traps", "lower back"];
const EQUIP = ["barbell", "dumbbell", "cable", "machine", "body only", "kettlebells", "bands"];

export default function ExercisePicker({ onPick, onClose, existing = [] }: {
  onPick: (name: string) => void; onClose: () => void; existing?: string[];
}) {
  const [q, setQ] = useState("");
  const [muscle, setMuscle] = useState<string | null>(null);
  const [equip, setEquip] = useState<string | null>(null);
  const [rows, setRows] = useState<LibExercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const reqId = useRef(0);

  const search = useCallback(async () => {
    const mine = ++reqId.current;
    setLoading(true); setErr("");
    try {
      let query = supabase.from("exercise_library")
        .select("id,name,level,mechanic,equipment,primary_muscles,secondary_muscles,category,instructions")
        .order("name", { ascending: true }).limit(60);
      const term = q.trim();
      if (term) query = query.ilike("name", `%${term}%`);
      if (muscle) query = query.contains("primary_muscles", [muscle]);
      if (equip) query = query.eq("equipment", equip);
      const { data, error } = await query;
      if (mine !== reqId.current) return;  // a newer search already won
      if (error) { setErr("Couldn't search the library — try again."); setLoading(false); return; }
      setRows((data ?? []) as LibExercise[]);
      setLoading(false);
    } catch {
      if (mine !== reqId.current) return;
      setErr("Couldn't reach the server — try again.");
      setLoading(false);
    }
  }, [q, muscle, equip]);

  // debounce typing; filters apply immediately
  useEffect(() => {
    const t = setTimeout(search, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [search, q]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end md:items-center md:justify-center" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full md:max-w-lg bg-[var(--background)] rounded-t-3xl md:rounded-3xl border-t md:border border-white/10 p-4 pb-8 md:pb-4 max-h-[88vh] flex flex-col" style={{ animation: "fadeSlide 0.2s ease" }}>
        <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-3 md:hidden" />
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs uppercase tracking-widest opacity-60">🔎 Find an exercise</p>
          <button onClick={onClose} className="text-sm opacity-50 active:scale-90">✕</button>
        </div>

        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="search 873 exercises…"
          className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm mb-2" />

        <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-2">
          {MUSCLES.map((m) => (
            <button key={m} onClick={() => setMuscle(muscle === m ? null : m)}
              className={`shrink-0 px-2.5 py-1.5 rounded-full text-[11px] font-semibold ${muscle === m ? "bg-[var(--neon)] text-black" : "bg-white/5 opacity-70"}`}>{m}</button>
          ))}
        </div>
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-2">
          {EQUIP.map((e) => (
            <button key={e} onClick={() => setEquip(equip === e ? null : e)}
              className={`shrink-0 px-2.5 py-1.5 rounded-full text-[11px] font-semibold ${equip === e ? "bg-[var(--neon)] text-black" : "bg-white/5 opacity-70"}`}>{e}</button>
          ))}
        </div>

        <div className="overflow-y-auto flex-1 -mx-1 px-1 mt-1 space-y-1.5">
          {loading && <div className="skeleton h-16" />}
          {!loading && rows.length === 0 && !err && <p className="text-sm opacity-40 py-4 text-center">Nothing matched — try a different word or clear the filters.</p>}
          {rows.map((r) => {
            const already = existing.includes(r.name);
            return (
              <Card key={r.id} padded={false} className="p-3">
                <div className="flex items-start gap-2">
                  <button onClick={() => setOpen(open === r.id ? null : r.id)} className="min-w-0 flex-1 text-left">
                    <p className="text-sm font-semibold truncate">{r.name}</p>
                    <p className="text-[10px] opacity-50 truncate">
                      {r.primary_muscles.join(", ") || "—"}{r.equipment ? ` · ${r.equipment}` : ""}{r.level ? ` · ${r.level}` : ""}
                    </p>
                  </button>
                  <button onClick={() => { if (!already) onPick(r.name); }} disabled={already}
                    className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold active:scale-95 ${already ? "bg-white/5 opacity-40" : "bg-[var(--neon)] text-black"}`}>
                    {already ? "added" : "＋ add"}
                  </button>
                </div>
                {open === r.id && r.instructions.length > 0 && (
                  <ol className="mt-2 space-y-1 list-decimal list-inside">
                    {r.instructions.map((s, i) => <li key={i} className="text-xs opacity-70 leading-relaxed">{s}</li>)}
                  </ol>
                )}
              </Card>
            );
          })}
        </div>
        {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
      </div>
    </div>,
    document.body,
  );
}
