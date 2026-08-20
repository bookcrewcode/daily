"use client";

// 🏋️ BODY — one instrument panel: momentum on top, the set log in the middle,
// the fuel gauge underneath. Rebuilt against the open-source pattern research:
//   · momentum-before-form (Flexify's inversion): trend + PR/plateau badges
//     and weekly muscle volume ABOVE the logging surface
//   · one-line set rows with ghosted last-session values, steppers, a one-tap
//     done pip that logs at the shown numbers and starts the rest timer
//     (Liftosaur / LiftLog patterns, re-implemented)
//   · plate math under barbell weights (Liftosaur)
//   · calories as a strip HERE, never a separate tab: gauge arc + personal
//     meal chips + raw-kcal quick add (OpenNutriTracker / Waistline patterns).
//     No macros ceremony, no barcodes, no weighing — any meal in seconds.
//
// Data model unchanged: workout_templates / lift_sets / meals / meal_favorites.
// All the v2 guards survive: seed-once split, read-error ≠ empty, midnight
// rollover, debounced numeric writes, write-then-celebrate.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, todayStr, dateStr, SPLIT, type LiftSet, type Meal } from "@/lib/supabase";
import ExercisePicker from "./ExercisePicker";
import { LIFT_SET_XP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { xpToast, sfx, buzz } from "@/lib/fx";
import { Card, Eyebrow, Num, ProgressCircle, Sparkline, Stepper } from "./ui";

type Template = { id: string; name: string; exercises: string[]; sort: number };
type Hist = { exercise: string; weight: number | null; reps: number | null; day: string; done: boolean };
type LibRow = { name: string; primary_muscles: string[] | null; equipment: string | null };

const REST_SECONDS = 90;

// PR-celebration dedupe survives remounts (Body unmounts on every tab switch)
const PR_FIRED_KEY = "daily.body.pr.fired";
function loadPrFired(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(PR_FIRED_KEY) ?? "[]") as string[]); }
  catch { return new Set(); }
}
function savePrFired(s: Set<string>) {
  try { sessionStorage.setItem(PR_FIRED_KEY, JSON.stringify([...s])); } catch { /* session-only nicety */ }
}

// 45-lb bar; standard plate pairs. "140 → 45 + 2.5 / side"
function plateMath(total: number): string | null {
  if (total < 55) return null;
  const perSide = (total - 45) / 2;
  if (perSide <= 0) return null;
  const plates: number[] = [];
  let left = perSide;
  for (const p of [45, 35, 25, 10, 5, 2.5]) {
    while (left >= p - 0.01) { plates.push(p); left -= p; }
  }
  if (plates.length === 0) return null;
  return `${plates.join(" + ")}${left > 0.01 ? " +~" : ""} / side`;
}

export default function Body({ uid }: { uid: string }) {
  const game = useGame();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [sets, setSets] = useState<LiftSet[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [hist, setHist] = useState<Hist[]>([]);
  const [weekSets, setWeekSets] = useState<Hist[]>([]);
  const [lib, setLib] = useState<Map<string, LibRow>>(new Map());
  const [prFlash, setPrFlash] = useState<string | null>(null);
  const [restUntil, setRestUntil] = useState<number | null>(null);
  const [restLeft, setRestLeft] = useState(0);
  const [managing, setManaging] = useState(false);
  const [chartFor, setChartFor] = useState<string | null>(null);
  const [newDay, setNewDay] = useState("");
  const [newEx, setNewEx] = useState<Record<string, string>>({});
  const [pickFor, setPickFor] = useState<string | null>(null);
  const prFired = useRef<Set<string> | null>(null);
  if (prFired.current === null) prFired.current = typeof window === "undefined" ? new Set() : loadPrFired();
  const [err, setErr] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const dayRef = useRef(todayStr());
  // debounce the numeric writes so stepper mashing / typing writes once —
  // each entry keeps its {id, patch} so unmount can FLUSH, not cancel
  const writeTimers = useRef<Map<string, { t: ReturnType<typeof setTimeout>; id: string; patch: Partial<LiftSet> }>>(new Map());
  // in-flight guards: a double-tap must never seed a workout or a set twice
  const startingRef = useRef<Set<string>>(new Set());
  const addingSetRef = useRef<Set<string>>(new Set());
  // fresh-rows mirror — async writers (the deferred done-pip, PR check) read
  // this instead of a render closure that a debounced edit already outdated
  const setsRef = useRef<LiftSet[]>([]);
  const commitSets = useCallback((updater: (s: LiftSet[]) => LiftSet[]) => {
    setsRef.current = updater(setsRef.current);
    setSets(setsRef.current);
  }, []);

  // ── fuel state ──────────────────────────────────────────────────────────
  const [meals, setMeals] = useState<Meal[]>([]);
  const [favorites, setFavorites] = useState<{ id: string; name: string; calories: number; protein: number | null; carbs: number | null; fat: number | null }[]>([]);
  const [recents, setRecents] = useState<{ name: string; calories: number; protein: number | null; carbs: number | null; fat: number | null; n: number }[]>([]);
  const [weekCal, setWeekCal] = useState<Map<string, number>>(new Map());
  const [calGoal, setCalGoal] = useState(2200);
  const [proGoal, setProGoal] = useState(160);
  const [fuelOpen, setFuelOpen] = useState(false);
  const [qKcal, setQKcal] = useState("");
  const [qName, setQName] = useState("");
  const [fuelErr, setFuelErr] = useState("");
  const loggingMeal = useRef(false);
  const [mealBusy, setMealBusy] = useState(false);
  const removingMeal = useRef<Set<string>>(new Set());
  const [removingMeals, setRemovingMeals] = useState<string[]>([]);

  const load = useCallback(async () => {
    const today = todayStr();
    const since7 = new Date(); since7.setDate(since7.getDate() - 6);
    const since14 = new Date(); since14.setDate(since14.getDate() - 14);
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6);
    const [tplQ, todayQ, histQ, mealsQ, favQ, recentQ, weekQ, wsetsQ, goalsQ] = await Promise.all([
      supabase.from("workout_templates").select("*").eq("user_id", uid).order("sort").order("created_at"),
      supabase.from("lift_sets").select("*").eq("user_id", uid).eq("day", today).order("slot"),
      supabase.from("lift_sets").select("exercise,weight,reps,day,done").eq("user_id", uid).lt("day", today).order("day", { ascending: false }).limit(2000),
      supabase.from("meals").select("*").eq("user_id", uid).eq("day", today).order("created_at"),
      supabase.from("meal_favorites").select("id,name,calories,protein,carbs,fat").eq("user_id", uid).order("created_at", { ascending: false }).limit(12),
      supabase.from("meals").select("name,calories,protein,carbs,fat").eq("user_id", uid).gte("day", dateStr(since14)).order("created_at", { ascending: false }).limit(200),
      supabase.from("meals").select("day,calories").eq("user_id", uid).gte("day", dateStr(since7)),
      supabase.from("lift_sets").select("exercise,weight,reps,day,done").eq("user_id", uid).gte("day", dateStr(weekAgo)),
      supabase.from("user_settings").select("calorie_goal,protein_goal").eq("user_id", uid).maybeSingle(),
    ]);
    // READ-ERROR GUARD: a failed templates read is NOT "no split" — never
    // re-seed or wipe. Keep prior state and say so.
    if (tplQ.error) { setStale(true); return; }
    const tpl = tplQ.data;

    // first run: seed the editable split from the hardcoded one — ONLY the
    // genuine first time (a "split_seeded" flag stops resurrection).
    const seededKey = `daily.lift.split_seeded.${uid}`;
    if ((tpl ?? []).length === 0 && !localStorage.getItem(seededKey)) {
      const seeded = SPLIT.map((w, i) => ({ user_id: uid, name: w.name, exercises: w.exercises, sort: i }));
      const { data: ins, error: insErr } = await supabase.from("workout_templates").insert(seeded).select();
      if (insErr) { setStale(true); return; }
      localStorage.setItem(seededKey, "1");
      setTemplates(((ins ?? []) as Template[]).map((t) => ({ ...t, exercises: (t.exercises as unknown as string[]) ?? [] })));
    } else {
      if ((tpl ?? []).length > 0) localStorage.setItem(seededKey, "1");
      setTemplates((tpl ?? []).map((t) => ({ ...t, exercises: (t.exercises as string[]) ?? [] })) as Template[]);
    }
    // never overwrite good state with [] on a transient read fail
    if (!todayQ.error) {
      const rows = (todayQ.data ?? []) as LiftSet[];
      commitSets(() => rows);
      if (rows.length) setActive((a) => a ?? rows[0].workout);
    }
    if (!histQ.error) setHist((histQ.data ?? []) as Hist[]);
    if (!wsetsQ.error) setWeekSets((wsetsQ.data ?? []) as Hist[]);
    if (!mealsQ.error) setMeals((mealsQ.data ?? []) as Meal[]);
    if (!favQ.error) setFavorites((favQ.data ?? []) as typeof favorites);
    if (!recentQ.error) {
      const byName = new Map<string, { name: string; calories: number; protein: number | null; carbs: number | null; fat: number | null; n: number }>();
      for (const m of (recentQ.data ?? []) as { name: string; calories: number; protein: number | null; carbs: number | null; fat: number | null }[]) {
        const k = m.name.trim().toLowerCase();
        if (!k) continue;
        const cur = byName.get(k);
        if (cur) cur.n++;
        else byName.set(k, { ...m, n: 1 });
      }
      setRecents([...byName.values()].sort((a, b) => b.n - a.n).slice(0, 12));
    }
    if (!weekQ.error) {
      const m = new Map<string, number>();
      for (const r of (weekQ.data ?? []) as { day: string; calories: number }[]) m.set(r.day, (m.get(r.day) ?? 0) + (r.calories ?? 0));
      setWeekCal(m);
    }
    if (!goalsQ.error && goalsQ.data) {
      setCalGoal((goalsQ.data.calorie_goal as number) || 2200);
      setProGoal((goalsQ.data.protein_goal as number) || 160);
    }
    // every failed read is admitted — zeros-with-no-warning is the house sin
    setStale(!!(todayQ.error || histQ.error || mealsQ.error || weekQ.error || wsetsQ.error || goalsQ.error || favQ.error || recentQ.error));

    // muscle/equipment metadata for the exercises he actually uses (873-row
    // library stays server-side; we fetch only the names in play)
    const names = [...new Set([
      ...((tpl ?? []) as Template[]).flatMap((t) => (t.exercises as unknown as string[]) ?? []),
      ...(((wsetsQ.data ?? []) as Hist[]).map((s) => s.exercise)),
    ])].filter(Boolean);
    if (names.length) {
      const { data: libRows, error: libErr } = await supabase.from("exercise_library")
        .select("name,primary_muscles,equipment").in("name", names);
      if (!libErr) {
        const m = new Map<string, LibRow>();
        for (const r of (libRows ?? []) as LibRow[]) m.set(r.name.toLowerCase(), r);
        setLib(m);
      }
    }
  }, [uid, commitSets]);
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

  // midnight rollover — same guard the other date-keyed cards carry
  useEffect(() => {
    const check = () => {
      const now = todayStr();
      if (now !== dayRef.current) {
        dayRef.current = now;
        commitSets(() => []); setActive(null); setRestUntil(null); setRestLeft(0);
        setMeals([]);
        prFired.current = new Set();
        load();
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    const id = setInterval(check, 30000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);

  // flush pending debounced writes — FIRE them, don't cancel them. Runs on
  // unmount (every tab switch) AND on pagehide/app-background: iOS suspends
  // timers without unmounting, then may kill the PWA, silently dropping a
  // typed weight the UI already showed as saved.
  useEffect(() => {
    const timers = writeTimers.current;
    const flush = () => {
      timers.forEach(({ t, id, patch }) => {
        clearTimeout(t);
        supabase.from("lift_sets").update(patch).eq("id", id).then(() => { }, () => { });
      });
      timers.clear();
    };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, []);

  // ── lifting derivations ─────────────────────────────────────────────────
  // "last session" = the most recent day with DONE sets for this exercise,
  // then that day's TOP set — never a warm-up row or an abandoned prefill.
  const prevOf = (ex: string) => {
    const done = hist.filter((h) => h.exercise === ex && h.done && h.weight != null);
    if (done.length === 0) return undefined;
    const day = done[0].day;                       // hist is day-DESC
    return done.filter((h) => h.day === day)
      .reduce((m, h) => (Number(h.weight) > Number(m.weight) ? h : m));
  };
  const bestOf = (ex: string) => hist.filter((h) => h.exercise === ex && h.done && h.weight != null)
    .reduce((m, h) => Math.max(m, Number(h.weight)), 0);

  function coach(ex: string): string | null {
    const p = prevOf(ex);
    if (!p || p.weight == null || p.reps == null) return null;
    return p.reps >= 10 ? `${p.weight + 5} × ${p.reps}` : `${p.weight} × ${p.reps + 1}`;
  }

  // momentum: per exercise, best-per-session series + trend badge
  const momentum = useMemo(() => {
    const byEx = new Map<string, Map<string, number>>();
    const lastDay = new Map<string, string>();
    for (const h of hist) {
      if (!h.done || h.weight == null) continue;
      const m = byEx.get(h.exercise) ?? new Map<string, number>();
      m.set(h.day, Math.max(m.get(h.day) ?? 0, Number(h.weight)));
      byEx.set(h.exercise, m);
      if ((lastDay.get(h.exercise) ?? "") < h.day) lastDay.set(h.exercise, h.day);
    }
    return [...byEx.entries()]
      .map(([ex, m]) => {
        const series = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, w]) => w);
        const last = series[series.length - 1];
        const prev = series[series.length - 2];
        const flat = series.length >= 3 && series.slice(-3).every((v) => v === last);
        return { ex, series: series.slice(-12), last, delta: prev != null ? last - prev : null, flat, day: lastDay.get(ex) ?? "" };
      })
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, 6);
  }, [hist]);

  // weekly volume by primary muscle (from the library metadata).
  // weekSets (a DB read) already contains today's rows — drop them and use the
  // live `sets` state for today instead, or every logged set counts twice.
  const muscleVolume = useMemo(() => {
    const today = todayStr();
    const vol = new Map<string, number>();
    const all = [...weekSets.filter((s) => s.day < today), ...sets.map((s) => ({ exercise: s.exercise, weight: s.weight, reps: s.reps, day: s.day, done: s.done }))];
    for (const s of all) {
      if (!s.done || !s.weight || !s.reps) continue;
      const muscle = lib.get(s.exercise.toLowerCase())?.primary_muscles?.[0] ?? "other";
      vol.set(muscle, (vol.get(muscle) ?? 0) + Number(s.weight) * Number(s.reps));
    }
    const rows = [...vol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = rows[0]?.[1] ?? 1;
    return rows.map(([m, v]) => ({ muscle: m, vol: v, pct: v / max }));
  }, [weekSets, sets, lib]);

  async function startWorkout(name: string) {
    setActive(name);
    // synchronous guard — the state check alone loses to a double-tap on a
    // slow gym connection and seeds the whole template twice
    if (startingRef.current.has(name)) return;
    if (setsRef.current.some((s) => s.workout === name)) return;
    const tpl = templates?.find((w) => w.name === name);
    if (!tpl || tpl.exercises.length === 0) return;
    startingRef.current.add(name);
    setErr(null);
    try {
      const rows = tpl.exercises.map((ex, i) => {
        const p = prevOf(ex);
        return {
          user_id: uid, day: todayStr(), workout: name, exercise: ex, slot: i * 100,
          weight: p?.weight ?? null, reps: p?.reps ?? null, done: false,
        };
      });
      const { data, error } = await supabase.from("lift_sets").insert(rows).select();
      if (error) { setErr("Couldn't start that workout — try again."); return; }
      if (data) commitSets((s) => [...s, ...(data as LiftSet[])]);
    } finally { startingRef.current.delete(name); }
  }

  // ＋ set = repeat-last-set (Flexify's fastest primitive): copy weight AND reps
  async function addSet(workout: string, exercise: string) {
    const k = `${workout}:${exercise}`;
    if (addingSetRef.current.has(k)) return;
    addingSetRef.current.add(k);
    setErr(null);
    try {
      const cur = setsRef.current;
      const maxSlot = Math.max(0, ...cur.filter((s) => s.workout === workout && s.exercise === exercise).map((s) => s.slot));
      const last = [...cur].filter((s) => s.workout === workout && s.exercise === exercise).pop();
      const { data, error } = await supabase.from("lift_sets").insert({
        user_id: uid, day: todayStr(), workout, exercise, slot: maxSlot + 1,
        weight: last?.weight ?? null, reps: last?.reps ?? null, done: false,
      }).select().single();
      if (error || !data) { setErr("Couldn't add a set — try again."); return; }
      commitSets((s) => [...s, data as LiftSet]); sfx.pop();
    } finally { addingSetRef.current.delete(k); }
  }

  async function removeSet(id: string) {
    setErr(null);
    const removed = setsRef.current.find((x) => x.id === id);
    commitSets((s) => s.filter((x) => x.id !== id));
    const { error } = await supabase.from("lift_sets").delete().eq("id", id);
    if (error && removed) { commitSets((s) => [...s, removed]); setErr("Couldn't remove that set — try again."); }
  }

  function maybePR(row: LiftSet, weight: number | null) {
    if (weight == null || weight <= 0) return;
    const b = bestOf(row.exercise);
    // keyed by weight too, so a fat-fingered value can't burn the day's one
    // celebration — the corrected number still gets its moment
    const key = `${row.exercise}:${todayStr()}:${weight}`;
    if (b > 0 && weight > b && !prFired.current!.has(key)) {
      prFired.current!.add(key);
      savePrFired(prFired.current!);
      setPrFlash(`PR — ${row.exercise}: ${weight} lb (was ${b})`);
      sfx.pr(); buzz([25, 40, 25]); burstConfetti("micro");
      setTimeout(() => setPrFlash(null), 3500);
    }
  }

  // done pip — write-then-celebrate. Both the set update AND the day flag must
  // land before any XP/sound/timer/PR fires; on failure BOTH revert (UI and
  // the lift_sets row — a half-landed pair must not diverge).
  async function update(id: string, patch: Partial<LiftSet>) {
    const prev = setsRef.current.find((x) => x.id === id);
    setErr(null);
    // revert restores ONLY the patched fields — a stepper edit committed while
    // these writes were in flight must survive the rollback
    const revert = () => {
      if (!prev) return;
      commitSets((s) => s.map((x) => {
        if (x.id !== id) return x;
        const r = { ...x } as Record<string, unknown>;
        for (const k of Object.keys(patch)) r[k] = (prev as unknown as Record<string, unknown>)[k];
        return r as unknown as LiftSet;
      }));
    };
    commitSets((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const { error } = await supabase.from("lift_sets").update(patch).eq("id", id);
    if (error) {
      revert();
      setErr("Couldn't save that set — try again.");
      return;
    }
    if (patch.done === true) {
      const { error: dErr } = await supabase.from("days").upsert({ user_id: uid, day: todayStr(), ws_lift: true }, { onConflict: "user_id,day" });
      if (dErr) {
        revert();
        supabase.from("lift_sets").update({ done: false }).eq("id", id).then(() => { }, () => { });
        setErr("Couldn't log that set — try again.");
        return;
      }
      xpToast(LIFT_SET_XP, "set");
      setRestUntil(Date.now() + REST_SECONDS * 1000);
      setRestLeft(REST_SECONDS);
      const fresh = setsRef.current.find((x) => x.id === id);
      if (fresh) maybePR(fresh, fresh.weight);
      game.refresh();
    }
  }

  // numeric edits: reflect immediately, debounce the write per set+field
  function updateField(id: string, patch: Partial<LiftSet>) {
    setErr(null);
    commitSets((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const key = `${id}:${Object.keys(patch).join(",")}`;
    const existing = writeTimers.current.get(key);
    if (existing) clearTimeout(existing.t);
    const t = setTimeout(async () => {
      writeTimers.current.delete(key);
      const { error } = await supabase.from("lift_sets").update(patch).eq("id", id);
      if (error) setErr("Couldn't save that number — try again.");
    }, 450);
    writeTimers.current.set(key, { t, id, patch });
  }

  // ── split editing ──────────────────────────────────────────────────
  async function saveExercises(t: Template, exercises: string[]) {
    setErr(null);
    const prevExercises = t.exercises;
    setTemplates((ts) => (ts ?? []).map((x) => (x.id === t.id ? { ...x, exercises } : x)));
    const { error } = await supabase.from("workout_templates").update({ exercises }).eq("id", t.id);
    if (error) {
      setTemplates((ts) => (ts ?? []).map((x) => (x.id === t.id ? { ...x, exercises: prevExercises } : x)));
      setErr("Couldn't save that change — try again.");
    }
  }
  async function addTemplate() {
    const name = newDay.trim();
    if (!name) return;
    setErr(null);
    const { data, error } = await supabase.from("workout_templates").insert({ user_id: uid, name, exercises: [], sort: (templates?.length ?? 0) }).select().single();
    if (error || !data) { setErr("Couldn't add that day — your text is still here."); return; }
    setNewDay("");
    setTemplates((ts) => [...(ts ?? []), { ...data, exercises: [] } as Template]);
  }
  async function dropTemplate(id: string) {
    if (!confirm("Remove this workout day from your split? (Past logs stay.)")) return;
    setErr(null);
    const prevTemplates = templates;
    setTemplates((ts) => (ts ?? []).filter((x) => x.id !== id));
    const { error } = await supabase.from("workout_templates").delete().eq("id", id);
    if (error) { setTemplates(prevTemplates); setErr("Couldn't remove that day — try again."); }
  }

  // ── fuel writes ─────────────────────────────────────────────────────────
  // keep days.calories/protein in sync for the advisor's context. Single-flight
  // with a trailing re-run: a log and a delete overlapping must not let the
  // earlier read's totals land last and bank a stale sum.
  const syncing = useRef(false);
  const syncQueued = useRef(false);
  async function syncDayTotals() {
    if (syncing.current) { syncQueued.current = true; return; }
    syncing.current = true;
    try {
      const day = todayStr();
      const { data, error: readErr } = await supabase.from("meals").select("calories,protein").eq("user_id", uid).eq("day", day);
      if (!readErr) {
        const c = (data ?? []).reduce((t, m) => t + (m.calories ?? 0), 0);
        const p = (data ?? []).reduce((t, m) => t + (m.protein ?? 0), 0);
        let e = (await supabase.from("days").upsert({ user_id: uid, day, calories: c, protein: p }, { onConflict: "user_id,day" })).error;
        if (e) e = (await supabase.from("days").upsert({ user_id: uid, day, calories: c, protein: p }, { onConflict: "user_id,day" })).error;
      }
    } catch { /* trailing rerun / next mutation re-syncs */ }
    finally {
      syncing.current = false;
      if (syncQueued.current) { syncQueued.current = false; void syncDayTotals(); }
    }
  }

  async function logMeal(name: string, kcal: number, protein?: number | null, carbs?: number | null, fat?: number | null) {
    if (loggingMeal.current) return;
    // zero is a real log (diet soda, black coffee) — only nonsense is refused
    if (!Number.isFinite(kcal) || Math.abs(kcal) > 6000) { setFuelErr("That number doesn't look right — meals live within ±6000."); return; }
    loggingMeal.current = true; setMealBusy(true); setFuelErr("");
    try {
      const day = todayStr();
      const { data, error } = await supabase.from("meals")
        .insert({ user_id: uid, day, name: (name || (kcal < 0 ? "burn" : "quick add")).slice(0, 80), calories: Math.round(kcal), protein: protein ?? 0, carbs: carbs ?? 0, fat: fat ?? 0 })
        .select().single();
      if (error || !data) { setFuelErr("Couldn't log that — try again."); return; }
      setMeals((ms) => [...ms, data as Meal]);
      setWeekCal((m) => new Map(m).set(day, (m.get(day) ?? 0) + Math.round(kcal)));
      setQKcal(""); setQName("");
      sfx.pop(); buzz(10);
      await syncDayTotals();
    } catch { setFuelErr("Couldn't reach the server — nothing logged."); }
    finally { loggingMeal.current = false; setMealBusy(false); }
  }

  async function deleteMeal(id: string) {
    if (removingMeal.current.has(id)) return;
    removingMeal.current.add(id); setRemovingMeals([...removingMeal.current]);
    try {
      const gone = meals.find((m) => m.id === id);
      const { error } = await supabase.from("meals").delete().eq("id", id);
      if (error) { setFuelErr("Couldn't remove that."); return; }
      setMeals((ms) => ms.filter((m) => m.id !== id));
      if (gone) setWeekCal((m) => new Map(m).set(gone.day, (m.get(gone.day) ?? 0) - (gone.calories ?? 0)));
      await syncDayTotals();
    } catch { setFuelErr("Couldn't reach the server — still logged."); }
    finally { removingMeal.current.delete(id); setRemovingMeals([...removingMeal.current]); }
  }

  // a failed FIRST load must offer a way back in — an eternal skeleton is a dead end
  if (templates === null) {
    return stale ? (
      <div className="pt-6">
        <button onClick={load} className="w-full rounded-xl bg-orange-500/15 text-orange-300 text-sm font-semibold py-3 active:scale-95">
          Couldn&apos;t load Body — tap to retry
        </button>
      </div>
    ) : <div className="pt-3"><div className="skeleton h-24 mt-4" /></div>;
  }

  const activeSets = active ? sets.filter((s) => s.workout === active) : [];
  const templateExercises = active ? (templates.find((t) => t.name === active)?.exercises ?? []) : [];
  const sessionOnly = activeSets.map((s) => s.exercise)
    .filter((e, i, a) => a.indexOf(e) === i)
    .filter((e) => !templateExercises.includes(e));
  const exercisesInSession = activeSets.length ? [...templateExercises, ...sessionOnly] : [];
  const volume = activeSets.filter((s) => s.done && s.weight && s.reps).reduce((v, s) => v + Number(s.weight) * Number(s.reps), 0);
  const doneCount = activeSets.filter((s) => s.done).length;

  const consumed = meals.reduce((t, m) => t + (m.calories ?? 0), 0);
  const protein = meals.reduce((t, m) => t + (m.protein ?? 0), 0);
  const remaining = calGoal - consumed;
  const chips = [
    ...favorites.map((f) => ({ key: `f${f.id}`, name: f.name, calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat })),
    ...recents.filter((r) => !favorites.some((f) => f.name.trim().toLowerCase() === r.name.trim().toLowerCase()))
      .map((r, i) => ({ key: `r${i}`, name: r.name, calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat })),
  ].slice(0, 12);

  const today = todayStr();
  const week7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    const day = dateStr(d);
    return { day, cal: day === today ? consumed : (weekCal.get(day) ?? 0) };
  });
  const weekAvg = Math.round(week7.reduce((t, d) => t + d.cal, 0) / 7);

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
    <div className="pt-3">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold leading-none">Body</h1>
        <button onClick={() => setManaging((v) => !v)} className="text-xs opacity-40 underline">{managing ? "done" : "edit split"}</button>
      </div>

      {prFlash && (
        <div className="mt-3 rounded-xl border border-[var(--gold)]/50 bg-[var(--gold)]/10 px-4 py-3" style={{ animation: "fadeSlide 0.25s ease" }}>
          <p className="text-sm font-bold text-[var(--gold)]">{prFlash}</p>
        </div>
      )}
      {(err || stale) && (
        <p className="text-xs text-orange-400 mt-2">{err ?? "Couldn't refresh — showing your last saved data."}</p>
      )}

      {/* ── momentum before form ── */}
      {momentum.length > 0 && (
        <>
          <Eyebrow className="mt-4 mb-2">Momentum</Eyebrow>
          <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1">
            {momentum.map((m) => (
              <button key={m.ex} onClick={() => setChartFor(m.ex)}
                className="shrink-0 w-36 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-2.5 text-left active:scale-[0.98]">
                <p className="text-[11px] font-semibold truncate">{m.ex}</p>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <p className="mono text-base font-bold">{m.last}<span className="text-[9px] text-[var(--text-4)]"> lb</span></p>
                  {m.delta != null && m.delta > 0 && <span className="text-[10px] mono text-[var(--ok)]">▲{m.delta}</span>}
                  {m.delta != null && m.delta < 0 && <span className="text-[10px] mono text-[var(--bad)]">▼{-m.delta}</span>}
                  {m.flat && <span className="text-[9px] text-[var(--warn)]">plateau</span>}
                </div>
                {m.series.length >= 2 && (
                  <Sparkline series={[{ values: m.series, color: m.flat ? "#fbbf24" : "#7c87f0", width: 1.8 }]} height={26} />
                )}
              </button>
            ))}
          </div>
        </>
      )}
      {muscleVolume.length > 0 && (
        <Card className="mt-2.5" padded={false}>
          <div className="p-3">
            <Eyebrow className="mb-2">This week · volume by muscle</Eyebrow>
            <div className="space-y-1.5">
              {muscleVolume.map((r) => (
                <div key={r.muscle} className="flex items-center gap-2">
                  <span className="text-[11px] capitalize w-20 shrink-0 opacity-75">{r.muscle}</span>
                  <div className="flex-1 h-2 rounded-full bg-white/[0.06] overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(4, r.pct * 100)}%`, background: "var(--neon)" }} />
                  </div>
                  <span className="mono text-[10px] opacity-50 w-14 text-right shrink-0">{(r.vol / 1000).toFixed(1)}k lb</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* ── the split / session ── */}
      <Eyebrow className="mt-5 mb-2">Session</Eyebrow>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-4 px-4">
        {templates.map((w) => (
          <div key={w.id} className="shrink-0 flex items-center gap-1">
            <button onClick={() => startWorkout(w.name)}
              className={`rounded-xl px-3.5 py-2.5 border text-sm font-semibold transition-colors ${active === w.name ? "bg-[var(--neon)]/15 border-[var(--neon)]/50 text-[var(--neon)]" : "bg-[var(--card)] border-[var(--border-1)] opacity-75"}`}>
              {w.name}
              {sets.some((s) => s.workout === w.name) && <span className="ml-1.5 text-[9px] text-[var(--ok)]">●</span>}
            </button>
            {managing && <button onClick={() => dropTemplate(w.id)} className="opacity-40 px-1 active:scale-90">✕</button>}
          </div>
        ))}
      </div>

      {managing && (
        <Card className="mt-2.5">
          {templates.map((w) => (
            <div key={w.id} className="mb-3">
              <p className="text-xs font-semibold opacity-70 mb-1">{w.name}</p>
              <div className="space-y-1">
                {w.exercises.map((ex, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm opacity-80">
                    <span className="flex-1">{ex}</span>
                    <button onClick={() => saveExercises(w, w.exercises.filter((_, j) => j !== i))} className="opacity-40 text-xs active:scale-90">✕</button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input value={newEx[w.id] ?? ""} onChange={(e) => setNewEx((m) => ({ ...m, [w.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter" && (newEx[w.id] ?? "").trim()) { saveExercises(w, [...w.exercises, newEx[w.id].trim()]); setNewEx((m) => ({ ...m, [w.id]: "" })); } }}
                    placeholder="type it + Enter" className="flex-1 min-w-0 rounded-lg bg-white/5 border border-[var(--border-1)] px-3 py-2 text-sm outline-none" />
                  <button onClick={() => setPickFor(w.id)} title="Search the exercise library"
                    className="shrink-0 px-3 rounded-lg bg-[var(--neon)]/20 border border-[var(--neon)]/40 text-sm font-semibold active:scale-95">🔎</button>
                </div>
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <input value={newDay} onChange={(e) => setNewDay(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTemplate()}
              placeholder="new workout day (e.g. Arms)" className="flex-1 min-w-0 rounded-xl bg-white/5 border border-[var(--border-1)] px-4 py-3 outline-none text-sm" />
            <button onClick={addTemplate} className="px-4 rounded-xl bg-white/10 font-bold active:scale-95">Add</button>
          </div>
        </Card>
      )}

      {active && exercisesInSession.length > 0 && (
        <>
          {doneCount > 0 && (
            <p className="mono text-xs opacity-60 mt-2.5">session volume <b className="text-[var(--neon)]">{volume.toLocaleString()} lb</b> · {doneCount} sets</p>
          )}
          <div className="space-y-2.5 mt-2.5">
            {exercisesInSession.map((ex) => {
              const exSets = activeSets.filter((s) => s.exercise === ex).sort((a, b) => a.slot - b.slot);
              const p = prevOf(ex);
              const target = coach(ex);
              const b = bestOf(ex);
              const isBarbell = lib.get(ex.toLowerCase())?.equipment === "barbell";
              return (
                <div key={ex} className="rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setChartFor(ex)} className="flex-1 min-w-0 text-left font-semibold text-sm truncate underline decoration-dotted decoration-white/25 underline-offset-4">{ex}</button>
                    {b > 0 && <span className="mono text-[10px] opacity-40 shrink-0">best {b}</span>}
                  </div>
                  {/* the ghost line — every row reads as "beat this" */}
                  <div className="mt-0.5 flex items-center gap-3 text-[11px] mono">
                    {p?.weight != null && <span className="opacity-40">last {p.weight}{p.reps != null ? `×${p.reps}` : ""}</span>}
                    {target && <span className="text-[var(--neon)] font-semibold">→ {target}</span>}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {exSets.map((r, si) => (
                      <div key={r.id} className="flex items-center gap-1.5">
                        <button onClick={() => {
                          // iOS Safari never blurs an input when a button is
                          // tapped — force the Stepper's pending draft to
                          // commit, give commitSets a beat, THEN log the set
                          (document.activeElement as HTMLElement | null)?.blur?.();
                          setTimeout(() => update(r.id, { done: !r.done }), 60);
                        }}
                          className={`w-9 h-9 shrink-0 rounded-lg grid place-items-center text-xs font-bold transition-colors ${r.done ? "bg-[var(--ok)] text-black pop-check" : "border border-white/25 active:scale-95"}`}>
                          {r.done ? "✓" : si + 1}
                        </button>
                        <Stepper value={r.weight} step={5} placeholder="lb" className="flex-1"
                          onCommit={(v) => updateField(r.id, { weight: v })} />
                        <span className="opacity-30 text-xs shrink-0">×</span>
                        <Stepper value={r.reps} step={1} placeholder="reps" className="flex-1"
                          onCommit={(v) => updateField(r.id, { reps: v })} />
                        {exSets.length > 1 && !r.done && (
                          <button onClick={() => removeSet(r.id)} className="opacity-30 text-xs px-1 active:scale-90 shrink-0">✕</button>
                        )}
                      </div>
                    ))}
                    {isBarbell && exSets[exSets.length - 1]?.weight != null && plateMath(Number(exSets[exSets.length - 1].weight)) && (
                      <p className="mono text-[10px] text-[var(--text-4)]">{plateMath(Number(exSets[exSets.length - 1].weight))}</p>
                    )}
                    <button onClick={() => addSet(active, ex)} className="w-full rounded-lg border border-dashed border-white/15 py-1.5 text-xs opacity-60 active:scale-95">＋ set (repeats last)</button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── fuel gauge — calories live HERE, not in a tab ── */}
      <Eyebrow className="mt-6 mb-2">Fuel</Eyebrow>
      <Card>
        <div className="flex items-center gap-4">
          <button onClick={() => setFuelOpen((v) => !v)} className="active:scale-95">
            <ProgressCircle pct={calGoal > 0 ? consumed / calGoal : 0} size={84} stroke={7}
              color={consumed > calGoal ? "var(--bad)" : "var(--neon)"}>
              <div className="text-center leading-none">
                <Num value={Math.abs(remaining)} className="text-lg font-bold" />
                <p className="text-[8px] text-[var(--text-4)] mt-0.5">{remaining >= 0 ? "left" : "over"}</p>
              </div>
            </ProgressCircle>
          </button>
          <div className="min-w-0 flex-1">
            <p className="mono text-sm"><Num value={consumed} className="font-bold" /> <span className="text-[var(--text-4)]">/ {calGoal} kcal</span></p>
            <p className="mono text-[11px] text-[var(--text-3)] mt-1">protein {protein}/{proGoal}g</p>
            <div className="flex gap-1.5 mt-2">
              <button onClick={() => setFuelOpen((v) => !v)}
                className="px-3 py-1.5 rounded-lg bg-[var(--neon)] text-black text-xs font-bold active:scale-95">＋ log</button>
            </div>
          </div>
          {/* 7 thin daily bars vs the week average — same grammar as the card's week */}
          <div className="flex items-end gap-1 h-14 shrink-0">
            {week7.map((d) => {
              const max = Math.max(calGoal * 1.3, ...week7.map((x) => x.cal), 1);
              return (
                <div key={d.day} className="w-2 rounded-sm"
                  style={{
                    height: `${Math.max(6, (d.cal / max) * 100)}%`,
                    background: d.day === today ? "var(--neon)" : d.cal > 0 ? "rgba(124,135,240,0.35)" : "rgba(255,255,255,0.07)",
                  }} title={`${d.day}: ${d.cal}`} />
              );
            })}
          </div>
        </div>

        {fuelOpen && (
          <div className="mt-3 pt-3 border-t border-[var(--border-1)]" style={{ animation: "fadeSlide 0.18s ease" }}>
            {chips.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-1 mb-2">
                {chips.map((c) => (
                  <button key={c.key} onClick={() => logMeal(c.name, c.calories, c.protein, c.carbs, c.fat)} disabled={mealBusy}
                    className="shrink-0 px-3 py-2 rounded-lg bg-[var(--raised)] border border-[var(--border-1)] text-xs active:scale-95 disabled:opacity-40">
                    {c.name} <span className="mono opacity-50">{c.calories}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-1.5">
              <input value={qName} onChange={(e) => setQName(e.target.value)} placeholder="what (optional)" disabled={mealBusy}
                className="flex-1 min-w-0 rounded-lg bg-black/25 px-3 py-2 outline-none text-sm" />
              <input value={qKcal} onChange={(e) => setQKcal(e.target.value)} type="number" inputMode="numeric" placeholder="kcal" disabled={mealBusy}
                onKeyDown={(e) => { if (e.key === "Enter" && qKcal.trim()) logMeal(qName, Number(qKcal)); }}
                className="w-20 shrink-0 rounded-lg bg-black/25 px-2.5 py-2 outline-none text-sm mono text-center" />
              <button onClick={() => logMeal(qName, Number(qKcal))} disabled={mealBusy || !qKcal.trim()}
                className="px-3.5 rounded-lg bg-[var(--neon)] text-black text-sm font-bold active:scale-95 disabled:opacity-40">{mealBusy ? "…" : "＋"}</button>
            </div>
            <p className="text-[9px] text-[var(--text-4)] mt-1.5">negative kcal = a burn (raises the budget) · no scales, no barcodes — close enough beats not logged</p>
            {meals.length > 0 && (
              <div className="mt-2.5 space-y-1">
                {meals.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 text-xs py-0.5">
                    <span className="flex-1 min-w-0 truncate opacity-75">{m.name}</span>
                    <span className="mono opacity-50 shrink-0">{m.calories} kcal{m.protein ? ` · P${m.protein}` : ""}</span>
                    <button onClick={() => deleteMeal(m.id)} disabled={removingMeals.includes(m.id)}
                      className="opacity-25 active:scale-90 disabled:opacity-10 shrink-0">✕</button>
                  </div>
                ))}
              </div>
            )}
            {weekAvg > 0 && <p className="mono text-[10px] text-[var(--text-4)] mt-2">7-day avg {weekAvg} kcal</p>}
          </div>
        )}
        {fuelErr && <p className="text-xs text-orange-400 mt-2">{fuelErr}</p>}
      </Card>

      {/* rest timer chip */}
      {restUntil !== null && restLeft > 0 && (
        <div className="fixed left-1/2 -translate-x-1/2 z-30 rounded-full bg-[var(--raised)] border border-[var(--border-3)] font-bold px-5 py-2.5 flex items-center gap-3"
          style={{ bottom: "max(6rem, calc(env(safe-area-inset-bottom) + 5.5rem))", animation: "fadeSlide 0.2s ease" }}>
          <span className="mono text-[var(--neon)]">rest {Math.floor(restLeft / 60)}:{String(restLeft % 60).padStart(2, "0")}</span>
          <button onClick={() => setRestUntil(null)} className="text-xs underline opacity-60">skip</button>
        </div>
      )}

      {/* progression chart */}
      {chartFor && (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm grid place-items-end md:place-items-center" onClick={() => setChartFor(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full md:max-w-md bg-[var(--card)] rounded-t-3xl md:rounded-3xl border-t md:border border-[var(--border-2)] p-5 pb-8" style={{ animation: "fadeSlide 0.2s ease" }}>
            <div className="flex items-center justify-between mb-1">
              <p className="font-bold">{chartFor}</p>
              <button onClick={() => setChartFor(null)} className="opacity-50 px-2 active:scale-90">✕</button>
            </div>
            {chartData.length >= 2 ? (
              <>
                <p className="text-xs opacity-50 mb-2 mono">best set per session · all-time best <b className="text-[var(--neon)]">{Math.max(...chartData.map(([, w]) => w))} lb</b></p>
                <Sparkline series={[{ values: chartData.map(([, w]) => w), color: "#7c87f0", width: 2 }]} height={72} />
                <div className="flex justify-between text-[10px] opacity-40 mt-1 mono">
                  <span>{chartData[0][0]}</span><span>{chartData[chartData.length - 1][0]}</span>
                </div>
                <div className="mt-3 space-y-1">
                  {chartData.slice(-5).reverse().map(([day, w]) => (
                    <p key={day} className="text-xs opacity-60 flex justify-between mono"><span>{day}</span><b>{w} lb</b></p>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm opacity-50 py-4">Not enough history yet — after two sessions with this exercise, the curve shows up here.</p>
            )}
          </div>
        </div>
      )}

      {pickFor && (() => {
        const t = (templates ?? []).find((x) => x.id === pickFor);
        if (!t) return null;
        return (
          <ExercisePicker
            existing={t.exercises}
            onClose={() => setPickFor(null)}
            onPick={(name) => {
              const cur = (templates ?? []).find((x) => x.id === pickFor);
              if (!cur || cur.exercises.includes(name)) return;
              saveExercises(cur, [...cur.exercises, name]);
            }}
          />
        );
      })()}
    </div>
  );
}
