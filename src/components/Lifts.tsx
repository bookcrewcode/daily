"use client";

// 🏋️ Lifts 2.0 — a real gym logger:
// - your split lives in the DB and is fully editable (days, exercises)
// - multiple sets per exercise (+ set), grouped, with per-set done checks
// - rest timer chip auto-starts when you finish a set (90s, skippable)
// - tap an exercise name → progression chart (best set per session) + PRs
// - session volume total; ws_lift banks only when a set is actually done

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr, SPLIT, type LiftSet } from "@/lib/supabase";
import { LIFT_SET_XP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { xpToast, sfx, buzz } from "@/lib/fx";
import { SectionTitle, Sparkline } from "./ui";

type Template = { id: string; name: string; exercises: string[]; sort: number };
type Hist = { exercise: string; weight: number | null; reps: number | null; day: string; done: boolean };

const REST_SECONDS = 90;

export default function Lifts({ uid }: { uid: string }) {
  const game = useGame();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [sets, setSets] = useState<LiftSet[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [hist, setHist] = useState<Hist[]>([]);
  const [prFlash, setPrFlash] = useState<string | null>(null);
  const [restUntil, setRestUntil] = useState<number | null>(null);
  const [restLeft, setRestLeft] = useState(0);
  const [managing, setManaging] = useState(false);
  const [chartFor, setChartFor] = useState<string | null>(null);
  const [newDay, setNewDay] = useState("");
  const [newEx, setNewEx] = useState<Record<string, string>>({});
  const prFired = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    const today = todayStr();
    const [{ data: tpl }, { data: todaySets }, { data: history }] = await Promise.all([
      supabase.from("workout_templates").select("*").eq("user_id", uid).order("sort").order("created_at"),
      supabase.from("lift_sets").select("*").eq("user_id", uid).eq("day", today).order("slot"),
      supabase.from("lift_sets").select("exercise,weight,reps,day,done").eq("user_id", uid).lt("day", today).order("day", { ascending: false }).limit(2000),
    ]);
    // first run: seed the editable split from the hardcoded one
    if ((tpl ?? []).length === 0) {
      const seeded = SPLIT.map((w, i) => ({ user_id: uid, name: w.name, exercises: w.exercises, sort: i }));
      const { data: ins } = await supabase.from("workout_templates").insert(seeded).select();
      setTemplates(((ins ?? []) as Template[]).map((t) => ({ ...t, exercises: (t.exercises as unknown as string[]) ?? [] })));
    } else {
      setTemplates((tpl ?? []).map((t) => ({ ...t, exercises: (t.exercises as string[]) ?? [] })) as Template[]);
    }
    const rows = (todaySets ?? []) as LiftSet[];
    setSets(rows);
    if (rows.length) setActive((a) => a ?? rows[0].workout);
    setHist((history ?? []) as Hist[]);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  // rest timer tick
  useEffect(() => {
    if (restUntil === null) return;
    const id = setInterval(() => {
      const left = Math.max(0, Math.round((restUntil - Date.now()) / 1000));
      setRestLeft(left);
      if (left === 0) {
        setRestUntil(null);
        sfx.coin(); buzz([20, 30, 20]);
      }
    }, 250);
    return () => clearInterval(id);
  }, [restUntil]);

  // per-exercise: last session (coach) + all-time best (PR line)
  const prevOf = (ex: string) => hist.find((h) => h.exercise === ex && h.weight != null);
  const bestOf = (ex: string) => hist.filter((h) => h.exercise === ex && h.done && h.weight != null)
    .reduce((m, h) => Math.max(m, Number(h.weight)), 0);

  function coach(ex: string): string | null {
    const p = prevOf(ex);
    if (!p || p.weight == null || p.reps == null) return null;
    return p.reps >= 10 ? `🎯 ${p.weight + 5} lb × ${p.reps}` : `🎯 ${p.weight} lb × ${p.reps + 1}`;
  }

  async function startWorkout(name: string) {
    setActive(name);
    if (sets.some((s) => s.workout === name)) return;
    const tpl = templates?.find((w) => w.name === name);
    if (!tpl || tpl.exercises.length === 0) return;
    const rows = tpl.exercises.map((ex, i) => ({
      user_id: uid, day: todayStr(), workout: name, exercise: ex, slot: i * 100,
      weight: null as number | null, reps: null as number | null, done: false,
    }));
    const { data } = await supabase.from("lift_sets").insert(rows).select();
    if (data) setSets((s) => [...s, ...(data as LiftSet[])]);
  }

  async function addSet(workout: string, exercise: string) {
    const maxSlot = Math.max(0, ...sets.filter((s) => s.workout === workout && s.exercise === exercise).map((s) => s.slot));
    const last = [...sets].filter((s) => s.workout === workout && s.exercise === exercise).pop();
    const { data } = await supabase.from("lift_sets").insert({
      user_id: uid, day: todayStr(), workout, exercise, slot: maxSlot + 1,
      weight: last?.weight ?? null, reps: null, done: false,
    }).select().single();
    if (data) { setSets((s) => [...s, data as LiftSet]); sfx.pop(); }
  }

  async function removeSet(id: string) {
    setSets((s) => s.filter((x) => x.id !== id));
    await supabase.from("lift_sets").delete().eq("id", id);
  }

  function maybePR(row: LiftSet, weight: number | null) {
    if (weight == null || weight <= 0) return;
    const b = bestOf(row.exercise);
    const key = `${row.exercise}:${todayStr()}`;
    if (b > 0 && weight > b && !prFired.current.has(key)) {
      prFired.current.add(key);
      setPrFlash(`🏆 PR — ${row.exercise}: ${weight} lb (was ${b})`);
      sfx.pr(); buzz([25, 40, 25]); burstConfetti("small");
      setTimeout(() => setPrFlash(null), 3500);
    }
  }

  async function update(id: string, patch: Partial<LiftSet>) {
    const row = sets.find((x) => x.id === id);
    setSets((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    await supabase.from("lift_sets").update(patch).eq("id", id);
    if (patch.done === true) {
      await supabase.from("days").upsert({ user_id: uid, day: todayStr(), ws_lift: true }, { onConflict: "user_id,day" });
      xpToast(LIFT_SET_XP, "set");
      setRestUntil(Date.now() + REST_SECONDS * 1000);
      setRestLeft(REST_SECONDS);
      if (row) maybePR(row, patch.weight !== undefined ? patch.weight : row.weight);
      game.refresh();
    }
  }

  // ── split editing ──────────────────────────────────────────────────
  async function saveExercises(t: Template, exercises: string[]) {
    setTemplates((ts) => (ts ?? []).map((x) => (x.id === t.id ? { ...x, exercises } : x)));
    await supabase.from("workout_templates").update({ exercises }).eq("id", t.id);
  }
  async function addTemplate() {
    const name = newDay.trim();
    if (!name) return;
    setNewDay("");
    const { data } = await supabase.from("workout_templates").insert({ user_id: uid, name, exercises: [], sort: (templates?.length ?? 0) }).select().single();
    if (data) setTemplates((ts) => [...(ts ?? []), { ...data, exercises: [] } as Template]);
  }
  async function dropTemplate(id: string) {
    if (!confirm("Remove this workout day from your split? (Past logs stay.)")) return;
    setTemplates((ts) => (ts ?? []).filter((x) => x.id !== id));
    await supabase.from("workout_templates").delete().eq("id", id);
  }

  if (templates === null) return <div className="pt-3"><div className="skeleton h-24 mt-4" /></div>;

  const activeSets = active ? sets.filter((s) => s.workout === active) : [];
  const templateExercises = active ? (templates.find((t) => t.name === active)?.exercises ?? []) : [];
  const sessionOnly = activeSets.map((s) => s.exercise)
    .filter((e, i, a) => a.indexOf(e) === i)
    .filter((e) => !templateExercises.includes(e));
  const exercisesInSession = activeSets.length ? [...templateExercises.filter((e) => activeSets.some((s) => s.exercise === e)), ...sessionOnly] : [];
  const volume = activeSets.filter((s) => s.done && s.weight && s.reps).reduce((v, s) => v + Number(s.weight) * Number(s.reps), 0);
  const doneCount = activeSets.filter((s) => s.done).length;

  // progression data for the chart modal
  const chartData = chartFor
    ? Object.entries(
        hist.filter((h) => h.exercise === chartFor && h.done && h.weight != null)
          .reduce<Record<string, number>>((acc, h) => {
            acc[h.day] = Math.max(acc[h.day] ?? 0, Number(h.weight));
            return acc;
          }, {}),
      ).sort((a, b) => a[0].localeCompare(b[0])).slice(-20)
    : [];

  return (
    <div>
      <div className="flex items-center justify-between pt-3">
        <h1 className="text-2xl font-bold">🏋️ Lifts</h1>
        <button onClick={() => setManaging((v) => !v)} className="text-xs opacity-40 underline">{managing ? "done" : "edit split"}</button>
      </div>
      <p className="opacity-50 text-sm mt-1">Beat last session. Tap an exercise name for its chart.</p>

      {prFlash && (
        <div className="mt-3 rounded-2xl border border-[#ffd54a]/50 bg-[#ffd54a]/10 px-4 py-3" style={{ animation: "fadeSlide 0.25s ease" }}>
          <p className="text-sm font-bold text-[#ffd54a]">{prFlash}</p>
        </div>
      )}

      <SectionTitle>Your split</SectionTitle>
      <div className="space-y-2">
        {templates.map((w) => (
          <div key={w.id}>
            <div className="flex items-center gap-2">
              <button onClick={() => startWorkout(w.name)}
                className={`flex-1 text-left rounded-xl px-4 py-3 border transition ${active === w.name ? "bg-[var(--neon)]/15 border-[var(--neon)]/60" : "bg-white/5 border-white/10"}`}>
                <span className="font-medium">{w.name}</span>
                <span className="ml-2 text-[10px] opacity-40">{w.exercises.length} exercises</span>
                {sets.some((s) => s.workout === w.name) && <span className="ml-2 text-xs text-[var(--neon)]">● live</span>}
              </button>
              {managing && <button onClick={() => dropTemplate(w.id)} className="opacity-40 px-2 active:scale-90">✕</button>}
            </div>
            {managing && (
              <div className="ml-3 mt-1.5 mb-2 space-y-1">
                {w.exercises.map((ex, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm opacity-80">
                    <span className="flex-1">{ex}</span>
                    <button onClick={() => saveExercises(w, w.exercises.filter((_, j) => j !== i))} className="opacity-40 text-xs active:scale-90">✕</button>
                  </div>
                ))}
                <input value={newEx[w.id] ?? ""} onChange={(e) => setNewEx((m) => ({ ...m, [w.id]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter" && (newEx[w.id] ?? "").trim()) { saveExercises(w, [...w.exercises, newEx[w.id].trim()]); setNewEx((m) => ({ ...m, [w.id]: "" })); } }}
                  placeholder="add exercise + Enter" className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm outline-none" />
              </div>
            )}
          </div>
        ))}
        {managing && (
          <div className="flex gap-2">
            <input value={newDay} onChange={(e) => setNewDay(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTemplate()}
              placeholder="new workout day (e.g. Day 4 — Arms)" className="flex-1 min-w-0 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none text-sm" />
            <button onClick={addTemplate} className="px-4 rounded-xl bg-white/10 font-bold active:scale-95">Add</button>
          </div>
        )}
      </div>

      {active && exercisesInSession.length > 0 && (
        <>
          <SectionTitle>{active}</SectionTitle>
          {doneCount > 0 && (
            <p className="text-xs opacity-50 mb-2">📦 session volume: <b className="text-[var(--neon)]">{volume.toLocaleString()} lb</b> · {doneCount} sets done</p>
          )}
          <div className="space-y-3">
            {exercisesInSession.map((ex) => {
              const exSets = activeSets.filter((s) => s.exercise === ex).sort((a, b) => a.slot - b.slot);
              const p = prevOf(ex);
              const target = coach(ex);
              const b = bestOf(ex);
              return (
                <div key={ex} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setChartFor(ex)} className="flex-1 text-left font-semibold text-sm underline decoration-dotted decoration-white/25 underline-offset-4">{ex}</button>
                    {b > 0 && <span className="text-[10px] opacity-40 shrink-0">best {b} lb</span>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-3 text-[11px]">
                    {p?.weight != null && <span className="opacity-40">last {p.weight}×{p.reps}</span>}
                    {target && <span className="text-[var(--neon)] font-semibold">{target}</span>}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {exSets.map((r, si) => (
                      <div key={r.id} className="flex items-center gap-2">
                        <button onClick={() => update(r.id, { done: !r.done })}
                          className={`w-8 h-8 shrink-0 rounded-lg grid place-items-center text-xs font-bold ${r.done ? "bg-[var(--neon)] text-black pop-check" : "border border-white/25"}`}>
                          {r.done ? "✓" : si + 1}
                        </button>
                        <label className="flex-1 flex items-center gap-1 rounded-lg bg-black/30 px-2.5 py-1.5">
                          <input type="number" inputMode="decimal" value={r.weight ?? ""} placeholder="lb"
                            onChange={(e) => update(r.id, { weight: e.target.value === "" ? null : Number(e.target.value) })}
                            className="w-full bg-transparent outline-none text-center font-bold text-sm" />
                          <span className="text-[10px] opacity-40">lb</span>
                        </label>
                        <span className="opacity-30 text-xs">×</span>
                        <label className="flex-1 flex items-center gap-1 rounded-lg bg-black/30 px-2.5 py-1.5">
                          <input type="number" inputMode="numeric" value={r.reps ?? ""} placeholder="reps"
                            onChange={(e) => update(r.id, { reps: e.target.value === "" ? null : Number(e.target.value) })}
                            className="w-full bg-transparent outline-none text-center font-bold text-sm" />
                          <span className="text-[10px] opacity-40">r</span>
                        </label>
                        {exSets.length > 1 && !r.done && (
                          <button onClick={() => removeSet(r.id)} className="opacity-30 text-xs px-1 active:scale-90">✕</button>
                        )}
                      </div>
                    ))}
                    <button onClick={() => addSet(active, ex)} className="w-full rounded-lg border border-dashed border-white/15 py-1.5 text-xs opacity-60 active:scale-95">＋ set</button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* rest timer chip */}
      {restUntil !== null && restLeft > 0 && (
        <div className="fixed left-1/2 -translate-x-1/2 z-30 rounded-full bg-[var(--neon)] text-black font-bold px-5 py-2.5 shadow-lg flex items-center gap-3"
          style={{ bottom: "max(6rem, calc(env(safe-area-inset-bottom) + 5.5rem))", animation: "fadeSlide 0.2s ease" }}>
          <span className="tabular-nums">😮‍💨 rest {Math.floor(restLeft / 60)}:{String(restLeft % 60).padStart(2, "0")}</span>
          <button onClick={() => setRestUntil(null)} className="text-xs underline">skip</button>
        </div>
      )}

      {/* progression chart */}
      {chartFor && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm grid place-items-end md:place-items-center" onClick={() => setChartFor(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full md:max-w-md bg-[var(--background)] rounded-t-3xl md:rounded-3xl border-t md:border border-white/10 p-5 pb-8" style={{ animation: "fadeSlide 0.2s ease" }}>
            <div className="flex items-center justify-between mb-1">
              <p className="font-bold">{chartFor}</p>
              <button onClick={() => setChartFor(null)} className="opacity-50 px-2 active:scale-90">✕</button>
            </div>
            {chartData.length >= 2 ? (
              <>
                <p className="text-xs opacity-50 mb-2">best set per session · last {chartData.length} sessions · all-time best <b className="text-[var(--neon)]">{Math.max(...chartData.map(([, w]) => w))} lb</b></p>
                <Sparkline series={[{ values: chartData.map(([, w]) => w), color: "#a78bfa", width: 2 }]} height={72} />
                <div className="flex justify-between text-[10px] opacity-40 mt-1">
                  <span>{chartData[0][0]}</span><span>{chartData[chartData.length - 1][0]}</span>
                </div>
                <div className="mt-3 space-y-1">
                  {chartData.slice(-5).reverse().map(([day, w]) => (
                    <p key={day} className="text-xs opacity-60 flex justify-between"><span>{day}</span><b>{w} lb</b></p>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm opacity-50 py-4">Not enough history yet — after two sessions with this exercise, the curve shows up here.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
