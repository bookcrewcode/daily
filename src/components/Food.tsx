"use client";

// 🍎 Food 2.0 — full macros (kcal/P/C/F), ⭐ favorites, copy-yesterday,
// browse/edit any day, 📸 vision logging, USDA search, weekly trend.
// Single source of truth stays the meals table; days.calories/protein mirror it.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr, dateStr, ADVISOR_FN, SUPABASE_ANON, type Meal } from "@/lib/supabase";
import { MEAL_XP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { xpToast, sfx } from "@/lib/fx";
import { SectionTitle, Card, Ring, ProgressBar } from "./ui";
import FoodSearch from "./FoodSearch";

type Goals = { calorie_goal: number; protein_goal: number; carb_goal: number; fat_goal: number };
const DEFAULT_GOALS: Goals = { calorie_goal: 2200, protein_goal: 160, carb_goal: 250, fat_goal: 70 };
type Fav = { id: string; name: string; calories: number; protein: number; carbs: number; fat: number };
type Snap = { name: string; calories: number; protein: number; carbs: number; fat: number; confidence: string; note?: string };
type NewMeal = { name: string; calories: number; protein: number; carbs?: number; fat?: number };

// downscale to ~900px JPEG so the upload stays small and vision stays cheap
async function fileToB64(file: File): Promise<{ b64: string; mediaType: string }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return { b64: canvas.toDataURL("image/jpeg", 0.8).split(",")[1], mediaType: "image/jpeg" };
}

export default function Food({ uid }: { uid: string }) {
  const game = useGame();
  const [viewDay, setViewDay] = useState(todayStr());
  const [meals, setMeals] = useState<Meal[]>([]);
  const [favs, setFavs] = useState<Fav[]>([]);
  const [goals, setGoals] = useState<Goals>(DEFAULT_GOALS);
  const [editingGoals, setEditingGoals] = useState(false);
  const [manual, setManual] = useState({ name: "", cal: "", pro: "", carb: "", fat: "" });
  const [manualOpen, setManualOpen] = useState(false);
  const [week, setWeek] = useState<{ day: string; cal: number }[]>([]);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);
  const [snapError, setSnapError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const isToday = viewDay === todayStr();

  const load = useCallback(async () => {
    const [{ data }, { data: settingsRow }, { data: favRows }] = await Promise.all([
      supabase.from("meals").select("*").eq("user_id", uid).eq("day", viewDay).order("created_at"),
      supabase.from("user_settings").select("calorie_goal,protein_goal,carb_goal,fat_goal").eq("user_id", uid).maybeSingle(),
      supabase.from("meal_favorites").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(12),
    ]);
    setMeals((data ?? []) as Meal[]);
    if (settingsRow) setGoals({ ...DEFAULT_GOALS, ...settingsRow });
    setFavs((favRows ?? []) as Fav[]);

    const since = new Date(); since.setDate(since.getDate() - 6);
    const { data: w } = await supabase.from("meals").select("day,calories").eq("user_id", uid).gte("day", dateStr(since));
    const totals = new Map<string, number>();
    (w ?? []).forEach((m: { day: string; calories: number }) => totals.set(m.day, (totals.get(m.day) ?? 0) + m.calories));
    const out: { day: string; cal: number }[] = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); out.push({ day: dateStr(d), cal: totals.get(dateStr(d)) ?? 0 }); }
    setWeek(out);
  }, [uid, viewDay]);
  useEffect(() => { load(); }, [load]);

  // midnight rollover guard — resumed PWAs must not log meals onto yesterday
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setViewDay((d) => (d === todayStr() ? d : d)); // keep explicit browsing
      load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  async function syncDayTotals(day: string) {
    const { data } = await supabase.from("meals").select("calories,protein").eq("user_id", uid).eq("day", day);
    const c = (data ?? []).reduce((s, m: { calories: number }) => s + m.calories, 0);
    const p = (data ?? []).reduce((s, m: { protein: number }) => s + m.protein, 0);
    await supabase.from("days").upsert({ user_id: uid, day, calories: c, protein: p }, { onConflict: "user_id,day" });
    load();
    game.refresh();
  }

  async function addMeal(m: NewMeal): Promise<boolean> {
    const meal = { user_id: uid, day: viewDay, name: m.name || "Meal", calories: m.calories || 0, protein: m.protein || 0, carbs: m.carbs || 0, fat: m.fat || 0 };
    const { data, error } = await supabase.from("meals").insert(meal).select().single();
    if (error || !data) return false;
    setMeals((x) => [...x, data as Meal]);
    if (isToday) xpToast(MEAL_XP, "meal");
    syncDayTotals(viewDay);
    return true;
  }

  async function addManual() {
    const ok = await addMeal({ name: manual.name, calories: Number(manual.cal) || 0, protein: Number(manual.pro) || 0, carbs: Number(manual.carb) || 0, fat: Number(manual.fat) || 0 });
    if (ok) setManual({ name: "", cal: "", pro: "", carb: "", fat: "" });
  }

  async function removeMeal(id: string) {
    setMeals((m) => m.filter((x) => x.id !== id));
    await supabase.from("meals").delete().eq("id", id);
    syncDayTotals(viewDay);
  }

  // ⭐ favorites: save once, one-tap forever
  async function toggleFav(m: Meal) {
    const existing = favs.find((f) => f.name.toLowerCase() === m.name.toLowerCase());
    if (existing) {
      setFavs((f) => f.filter((x) => x.id !== existing.id));
      await supabase.from("meal_favorites").delete().eq("id", existing.id);
    } else {
      const { data } = await supabase.from("meal_favorites").insert({
        user_id: uid, name: m.name, calories: m.calories, protein: m.protein, carbs: m.carbs ?? 0, fat: m.fat ?? 0,
      }).select().single();
      if (data) { setFavs((f) => [data as Fav, ...f]); sfx.coin(); }
    }
  }

  async function copyYesterday() {
    const y = new Date(viewDay + "T00:00:00"); y.setDate(y.getDate() - 1);
    const { data } = await supabase.from("meals").select("name,calories,protein,carbs,fat").eq("user_id", uid).eq("day", dateStr(y));
    if (!data?.length) { setSnapError("Nothing logged yesterday to copy."); setTimeout(() => setSnapError(""), 2500); return; }
    const rows = data.map((m) => ({ user_id: uid, day: viewDay, ...m }));
    const { error } = await supabase.from("meals").insert(rows);
    if (!error) { sfx.coin(); syncDayTotals(viewDay); }
  }

  async function snapMeal(file: File) {
    setSnapBusy(true); setSnapError(""); setSnap(null);
    try {
      let b64: string, mediaType: string;
      try {
        ({ b64, mediaType } = await fileToB64(file));
      } catch {
        setSnapError("Couldn't read that image format — take the photo with the camera button instead.");
        return;
      }
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(ADVISOR_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
        body: JSON.stringify({ advisor: "food-vision", image: b64, mediaType }),
      });
      const json = await res.json();
      if (json.error) setSnapError(json.error);
      else setSnap({ name: json.name ?? "Meal", calories: Number(json.calories) || 0, protein: Number(json.protein) || 0, carbs: Number(json.carbs) || 0, fat: Number(json.fat) || 0, confidence: json.confidence ?? "medium", note: json.note });
    } catch {
      setSnapError("Couldn't analyze the photo — check your connection.");
    } finally {
      setSnapBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function shiftDay(delta: number) {
    const d = new Date(viewDay + "T00:00:00");
    d.setDate(d.getDate() + delta);
    if (dateStr(d) > todayStr()) return;
    setViewDay(dateStr(d));
  }

  const t = {
    cal: meals.reduce((s, m) => s + m.calories, 0),
    pro: meals.reduce((s, m) => s + m.protein, 0),
    carb: meals.reduce((s, m) => s + (m.carbs ?? 0), 0),
    fat: meals.reduce((s, m) => s + (m.fat ?? 0), 0),
  };
  const maxCal = Math.max(2000, ...week.map((w) => w.cal));

  return (
    <div>
      <div className="flex items-center justify-between pt-3">
        <h1 className="text-2xl font-bold">🍎 Food</h1>
        <button onClick={() => setEditingGoals((v) => !v)} className="text-xs opacity-50 underline">goals</button>
      </div>

      {/* day browser */}
      <div className="flex items-center justify-between mt-2">
        <button onClick={() => shiftDay(-1)} className="px-3 py-1.5 rounded-lg bg-white/5 active:scale-90">‹</button>
        <button onClick={() => setViewDay(todayStr())} className="text-sm font-semibold">
          {isToday ? "Today" : new Date(viewDay + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
          {!isToday && <span className="text-[10px] text-[var(--neon)] ml-1.5">→ today</span>}
        </button>
        <button onClick={() => shiftDay(1)} disabled={isToday} className="px-3 py-1.5 rounded-lg bg-white/5 active:scale-90 disabled:opacity-20">›</button>
      </div>

      {editingGoals && (
        <Card className="mt-3">
          <GoalEditor goals={goals} onSave={async (g) => {
            setGoals(g); setEditingGoals(false);
            await supabase.from("user_settings").upsert({ user_id: uid, ...g }, { onConflict: "user_id" });
          }} />
        </Card>
      )}

      {/* macro dashboard */}
      <div className="flex items-center gap-4 mt-3">
        <Ring score={Math.min(t.cal, goals.calorie_goal)} total={goals.calorie_goal} />
        <div className="flex-1">
          <p className="text-3xl font-extrabold leading-none font-display">{t.cal}<span className="text-base opacity-50"> / {goals.calorie_goal}</span></p>
          <p className="text-sm opacity-60 mt-1">{t.cal >= goals.calorie_goal ? "Calorie goal hit 🔥" : `${goals.calorie_goal - t.cal} kcal left`}</p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {([["💪 Protein", t.pro, goals.protein_goal, "gold"], ["🌾 Carbs", t.carb, goals.carb_goal, "neon"], ["🥑 Fat", t.fat, goals.fat_goal, "neon"]] as [string, number, number, "neon" | "gold"][]).map(([label, val, goal, tone]) => (
          <div key={label}>
            <div className="flex justify-between text-xs opacity-60 mb-1"><span>{label}</span><span>{val} / {goal}g</span></div>
            <ProgressBar pct={goal ? val / goal : 0} tone={tone} />
          </div>
        ))}
      </div>

      {/* one-tap logging */}
      {(favs.length > 0 || true) && (
        <>
          <SectionTitle>⭐ One tap</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {favs.map((f) => (
              <button key={f.id} onClick={() => addMeal(f)}
                className="text-xs font-medium px-3 py-2 rounded-full bg-[var(--neon)]/10 border border-[var(--neon)]/30 active:scale-95">
                ⭐ {f.name} <span className="opacity-40">· {f.calories}</span>
              </button>
            ))}
            <button onClick={copyYesterday} className="text-xs font-medium px-3 py-2 rounded-full bg-white/5 border border-white/10 active:scale-95">
              📋 copy yesterday
            </button>
          </div>
          {favs.length === 0 && <p className="text-[10px] opacity-40 mt-1.5">star a logged meal below and it lives here forever</p>}
        </>
      )}

      <SectionTitle>📸 Snap it</SectionTitle>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) snapMeal(f); }} />
      {!snap && (
        <button onClick={() => fileRef.current?.click()} disabled={snapBusy}
          className="w-full rounded-xl border border-dashed border-[var(--neon)]/40 bg-[var(--neon)]/5 py-3.5 font-semibold text-[var(--neon)] active:scale-95 disabled:opacity-50">
          {snapBusy ? "🔎 Reading your plate…" : "📸 Photo of your food → instant macros"}
        </button>
      )}
      {snapError && <p className="text-xs text-orange-400 mt-2">{snapError}</p>}
      {snap && (
        <Card tone="neon" className="mt-2">
          <p className="text-sm font-bold">{snap.name} <span className="text-[10px] font-normal opacity-50">· {snap.confidence} confidence</span></p>
          {snap.note && <p className="text-[10px] opacity-50 mt-0.5">{snap.note}</p>}
          <div className="grid grid-cols-4 gap-1.5 mt-2">
            {([["kcal", "calories"], ["P", "protein"], ["C", "carbs"], ["F", "fat"]] as [string, keyof Snap][]).map(([lbl, key]) => (
              <label key={lbl} className="flex flex-col items-center rounded-lg bg-black/30 px-1 py-1.5">
                <input type="number" inputMode="numeric" value={(snap[key] as number) || ""}
                  onChange={(e) => setSnap({ ...snap, [key]: Number(e.target.value) || 0 })}
                  className="w-full bg-transparent outline-none text-center font-bold text-sm" />
                <span className="text-[9px] opacity-40">{lbl}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => setSnap(null)} className="flex-1 rounded-xl bg-white/10 py-2.5 active:scale-95">Discard</button>
            <button onClick={async () => {
                const ok = await addMeal(snap);
                if (ok) setSnap(null);
                else setSnapError("Couldn't save — your estimate is still here. Try again.");
              }}
              className="flex-1 rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">Add to log</button>
          </div>
        </Card>
      )}

      <SectionTitle>Search a food</SectionTitle>
      <FoodSearch onAdd={(name, calories, protein, carbs, fat) => addMeal({ name, calories, protein, carbs, fat })} />

      {!manualOpen ? (
        <button onClick={() => setManualOpen(true)} className="mt-3 text-xs text-[var(--neon)]/70 underline underline-offset-2">
          Can&apos;t find it? Add manually
        </button>
      ) : (
        <div className="space-y-2 mt-3">
          <input value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} placeholder="what did you eat?"
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
          <div className="grid grid-cols-5 gap-1.5">
            {([["kcal", "cal"], ["P g", "pro"], ["C g", "carb"], ["F g", "fat"]] as [string, keyof typeof manual][]).map(([ph, key]) => (
              <input key={key} value={manual[key]} onChange={(e) => setManual({ ...manual, [key]: e.target.value })}
                inputMode="numeric" placeholder={ph}
                className="rounded-xl bg-white/5 border border-white/10 px-2 py-3 outline-none text-center text-sm" />
            ))}
            <button onClick={addManual} className="rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">＋</button>
          </div>
        </div>
      )}

      <SectionTitle>{isToday ? "Today's meals" : "Meals that day"}</SectionTitle>
      {meals.length === 0 && <p className="opacity-40 text-sm">Nothing logged{isToday ? " yet" : ""}.</p>}
      <div className="space-y-2">
        {meals.map((m) => {
          const isFav = favs.some((f) => f.name.toLowerCase() === m.name.toLowerCase());
          return (
            <div key={m.id} className="flex items-center gap-2.5 rounded-xl bg-white/5 border border-white/10 px-3 py-3">
              <button onClick={() => toggleFav(m)} className={`shrink-0 text-lg active:scale-90 ${isFav ? "" : "opacity-25"}`}>⭐</button>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{m.name}</p>
                <p className="text-[10px] opacity-50">{m.calories} kcal · P{m.protein} C{m.carbs ?? 0} F{m.fat ?? 0}</p>
              </div>
              <button onClick={() => removeMeal(m.id)} className="opacity-40 active:scale-90 shrink-0">✕</button>
            </div>
          );
        })}
      </div>

      <SectionTitle>Calories — last 7 days</SectionTitle>
      <div className="flex justify-between gap-1 items-end">
        {week.map((w) => (
          <button key={w.day} onClick={() => setViewDay(w.day)} className="flex-1 flex flex-col items-center gap-1">
            <span className="text-[9px] opacity-50">{w.cal || ""}</span>
            <div className={`w-full h-24 rounded-lg bg-white/5 flex items-end overflow-hidden ${w.day === viewDay ? "ring-1 ring-[var(--neon)]" : ""}`}>
              <div className="w-full rounded-lg bg-[var(--neon)]" style={{ height: `${Math.min((w.cal / maxCal) * 100, 100)}%`, opacity: 0.7 }} />
            </div>
            <span className="text-[10px] opacity-50">{new Date(w.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "narrow" })}</span>
          </button>
        ))}
      </div>
      <p className="text-[10px] opacity-30 mt-1.5 mb-4">tap a bar to view or edit that day</p>
    </div>
  );
}

function GoalEditor({ goals, onSave }: { goals: Goals; onSave: (g: Goals) => void }) {
  const [g, setG] = useState({ cal: String(goals.calorie_goal), pro: String(goals.protein_goal), carb: String(goals.carb_goal), fat: String(goals.fat_goal) });
  return (
    <div>
      <p className="text-xs uppercase tracking-widest opacity-50 mb-2">Daily goals — kcal / protein / carbs / fat</p>
      <div className="grid grid-cols-5 gap-1.5">
        {([["kcal", "cal"], ["P", "pro"], ["C", "carb"], ["F", "fat"]] as [string, keyof typeof g][]).map(([ph, key]) => (
          <input key={key} value={g[key]} onChange={(e) => setG({ ...g, [key]: e.target.value })} inputMode="numeric" placeholder={ph}
            className="rounded-xl bg-black/30 px-2 py-2.5 outline-none text-center text-sm" />
        ))}
        <button onClick={() => onSave({ calorie_goal: Number(g.cal) || 2200, protein_goal: Number(g.pro) || 160, carb_goal: Number(g.carb) || 250, fat_goal: Number(g.fat) || 70 })}
          className="rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">✓</button>
      </div>
    </div>
  );
}
