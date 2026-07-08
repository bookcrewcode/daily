"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr, SPLIT, type LiftSet } from "@/lib/supabase";
import { LIFT_SET_XP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { xpToast, sfx, buzz } from "@/lib/fx";
import { SectionTitle } from "./ui";

type Prev = { weight: number | null; reps: number | null; day: string };

// progressive-overload rule: beat last session. Hit target reps → add weight; else add a rep.
function coach(p: Prev | undefined): string | null {
  if (!p || p.weight == null || p.reps == null) return null;
  if (p.reps >= 10) return `🎯 ${p.weight + 5} lb × ${p.reps}`;
  return `🎯 ${p.weight} lb × ${p.reps + 1}`;
}

export default function Lifts({ uid }: { uid: string }) {
  const game = useGame();
  const [sets, setSets] = useState<LiftSet[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [prev, setPrev] = useState<Record<string, Prev>>({});
  const [best, setBest] = useState<Record<string, number>>({});
  const [prFlash, setPrFlash] = useState<string | null>(null);
  const prFired = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    const today = todayStr();
    const { data } = await supabase.from("lift_sets").select("*").eq("user_id", uid).eq("day", today).order("slot");
    const rows = (data ?? []) as LiftSet[];
    setSets(rows);
    if (rows.length && !active) setActive(rows[0].workout);

    // history: most recent prior entry per exercise (coach) + all-time best (PR detection)
    const { data: hist } = await supabase.from("lift_sets").select("exercise,weight,reps,day,done")
      .eq("user_id", uid).lt("day", today).order("day", { ascending: false });
    const map: Record<string, Prev> = {};
    const bestMap: Record<string, number> = {};
    (hist ?? []).forEach((h: Prev & { exercise: string; done: boolean }) => {
      if (!map[h.exercise] && h.weight != null) map[h.exercise] = { weight: h.weight, reps: h.reps, day: h.day };
      if (h.done && h.weight != null) bestMap[h.exercise] = Math.max(bestMap[h.exercise] ?? 0, Number(h.weight));
    });
    setPrev(map);
    setBest(bestMap);
  }, [uid, active]);
  useEffect(() => { load(); }, [load]);

  async function startWorkout(name: string) {
    setActive(name);
    if (sets.some((s) => s.workout === name)) return;
    const tpl = SPLIT.find((w) => w.name === name);
    if (!tpl) return;
    const rows = tpl.exercises.map((ex, i) => ({
      user_id: uid, day: todayStr(), workout: name, exercise: ex, slot: i,
      weight: null as number | null, reps: null as number | null, done: false,
    }));
    const { data } = await supabase.from("lift_sets").insert(rows).select();
    if (data) setSets((s) => [...s, ...(data as LiftSet[])]);
  }

  function maybePR(row: LiftSet, weight: number | null) {
    if (weight == null || weight <= 0) return;
    const b = best[row.exercise] ?? 0;
    const key = `${row.exercise}:${todayStr()}`;
    if (b > 0 && weight > b && !prFired.current.has(key)) {
      prFired.current.add(key);
      setBest((m) => ({ ...m, [row.exercise]: weight }));
      setPrFlash(`🏆 PR — ${row.exercise}: ${weight} lb (was ${b})`);
      sfx.pr();
      buzz([25, 40, 25]);
      burstConfetti("small");
      setTimeout(() => setPrFlash(null), 3500);
    }
  }

  async function update(id: string, patch: Partial<LiftSet>) {
    const row = sets.find((x) => x.id === id);
    setSets((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    await supabase.from("lift_sets").update(patch).eq("id", id);
    // banking the Lift win requires actually completing a set — unchecking must not bank it
    if (patch.done === true) {
      await supabase.from("days").upsert({ user_id: uid, day: todayStr(), ws_lift: true }, { onConflict: "user_id,day" });
      xpToast(LIFT_SET_XP, "set");
      if (row) maybePR(row, patch.weight !== undefined ? patch.weight : row.weight);
      game.refresh();
    }
  }

  const worked = Array.from(new Set(sets.map((s) => s.workout)));
  const rows = active ? sets.filter((s) => s.workout === active).sort((a, b) => a.slot - b.slot) : [];

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">🏋️ Lifts</h1>
      <p className="opacity-50 text-sm mt-1">Pick today&apos;s day. The 🎯 target = beat last session.</p>

      {prFlash && (
        <div className="mt-3 rounded-2xl border border-[#ffd54a]/50 bg-[#ffd54a]/10 px-4 py-3" style={{ animation: "fadeSlide 0.25s ease" }}>
          <p className="text-sm font-bold text-[#ffd54a]">{prFlash}</p>
        </div>
      )}

      <SectionTitle>Your split</SectionTitle>
      <div className="space-y-2">
        {SPLIT.map((w) => (
          <button key={w.name} onClick={() => startWorkout(w.name)}
            className={`w-full text-left rounded-xl px-4 py-3 border transition ${active === w.name ? "bg-[var(--neon)]/15 border-[var(--neon)]/60" : "bg-white/5 border-white/10"}`}>
            <span className="font-medium">{w.name}</span>
            {worked.includes(w.name) && <span className="ml-2 text-xs text-[var(--neon)]">● logged</span>}
          </button>
        ))}
      </div>

      {active && (
        <>
          <SectionTitle>{active}</SectionTitle>
          <div className="space-y-2">
            {rows.map((r) => {
              const p = prev[r.exercise];
              const target = coach(p);
              const b = best[r.exercise];
              return (
                <div key={r.id} className={`rounded-xl px-3 py-3 border ${r.done ? "bg-[var(--neon)]/10 border-[var(--neon)]/40" : "bg-white/5 border-white/10"}`}>
                  <div className="flex items-center gap-2">
                    <button onClick={() => update(r.id, { done: !r.done })}
                      className={`w-7 h-7 shrink-0 rounded-full grid place-items-center text-sm font-bold ${r.done ? "bg-[var(--neon)] text-black pop-check" : "border border-white/30"}`}>{r.done ? "✓" : ""}</button>
                    <span className="flex-1 font-medium text-sm">{r.exercise}</span>
                    {b != null && b > 0 && <span className="text-[10px] opacity-40 shrink-0">best {b}</span>}
                  </div>
                  <div className="pl-9 mt-1 flex items-center gap-3 text-[11px]">
                    {p?.weight != null && <span className="opacity-40">last {p.weight}×{p.reps}</span>}
                    {target && <span className="text-[var(--neon)] font-semibold">{target}</span>}
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
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
