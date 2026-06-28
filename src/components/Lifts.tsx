"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, SPLIT, type LiftSet } from "@/lib/supabase";
import { SectionTitle } from "./ui";

export default function Lifts({ uid }: { uid: string }) {
  const [sets, setSets] = useState<LiftSet[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.from("lift_sets").select("*").eq("user_id", uid).eq("day", todayStr()).order("slot");
    const rows = (data ?? []) as LiftSet[];
    setSets(rows);
    if (rows.length && !active) setActive(rows[0].workout);
  }, [uid, active]);

  useEffect(() => { load(); }, [load]);

  async function startWorkout(name: string) {
    setActive(name);
    const existing = sets.filter((s) => s.workout === name);
    if (existing.length) return;
    const tpl = SPLIT.find((w) => w.name === name);
    if (!tpl) return;
    const rows = tpl.exercises.map((ex, i) => ({
      user_id: uid, day: todayStr(), workout: name, exercise: ex, slot: i,
      weight: null as number | null, reps: null as number | null, done: false,
    }));
    const { data } = await supabase.from("lift_sets").insert(rows).select();
    if (data) setSets((s) => [...s, ...(data as LiftSet[])]);
  }

  async function update(id: string, patch: Partial<LiftSet>) {
    setSets((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    await supabase.from("lift_sets").update(patch).eq("id", id);
    if ("done" in patch) {
      // if any set done today, mark the Win-Stack lift toggle
      await supabase.from("days").upsert({ user_id: uid, day: todayStr(), ws_lift: true }, { onConflict: "user_id,day" });
    }
  }

  const workedToday = Array.from(new Set(sets.map((s) => s.workout)));
  const rows = active ? sets.filter((s) => s.workout === active).sort((a, b) => a.slot - b.slot) : [];

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">🏋️ Lifts</h1>
      <p className="opacity-50 text-sm mt-1">Pick today&apos;s day. Tap a field, log your real numbers.</p>

      <SectionTitle>Your split</SectionTitle>
      <div className="grid grid-cols-1 gap-2">
        {SPLIT.map((w) => {
          const done = workedToday.includes(w.name);
          const isActive = active === w.name;
          return (
            <button key={w.name} onClick={() => startWorkout(w.name)}
              className={`text-left rounded-xl px-4 py-3 border transition ${isActive ? "bg-[var(--neon)]/15 border-[var(--neon)]/60" : "bg-white/5 border-white/10"}`}>
              <span className="font-medium">{w.name}</span>
              {done && <span className="ml-2 text-xs text-[var(--neon)]">● logged</span>}
            </button>
          );
        })}
      </div>

      {active && (
        <>
          <SectionTitle>{active}</SectionTitle>
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className={`rounded-xl px-3 py-3 border ${r.done ? "bg-[var(--neon)]/10 border-[var(--neon)]/40" : "bg-white/5 border-white/10"}`}>
                <div className="flex items-center gap-2">
                  <button onClick={() => update(r.id, { done: !r.done })}
                    className={`w-7 h-7 shrink-0 rounded-full grid place-items-center text-sm font-bold ${r.done ? "bg-[var(--neon)] text-black" : "border border-white/30"}`}>{r.done ? "✓" : ""}</button>
                  <span className="flex-1 font-medium text-sm">{r.exercise}</span>
                </div>
                <div className="flex gap-2 mt-2 pl-9">
                  <label className="flex-1 flex items-center gap-1 rounded-lg bg-black/30 px-3 py-2">
                    <input type="number" inputMode="decimal" value={r.weight ?? ""} placeholder="weight"
                      onChange={(e) => update(r.id, { weight: e.target.value === "" ? null : Number(e.target.value) })}
                      className="w-full bg-transparent outline-none text-center font-bold" />
                    <span className="text-xs opacity-40">lb</span>
                  </label>
                  <label className="flex-1 flex items-center gap-1 rounded-lg bg-black/30 px-3 py-2">
                    <input type="number" inputMode="numeric" value={r.reps ?? ""} placeholder="reps"
                      onChange={(e) => update(r.id, { reps: e.target.value === "" ? null : Number(e.target.value) })}
                      className="w-full bg-transparent outline-none text-center font-bold" />
                    <span className="text-xs opacity-40">reps</span>
                  </label>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
