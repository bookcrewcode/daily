"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, dateStr, type Meal } from "@/lib/supabase";
import { SectionTitle, Card, Ring, ProgressBar } from "./ui";

type CalorieSettings = { calorie_goal: number; protein_goal: number };
const DEFAULT_SETTINGS: CalorieSettings = { calorie_goal: 2200, protein_goal: 160 };

export default function Food({ uid }: { uid: string }) {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [recent, setRecent] = useState<Meal[]>([]);
  const [settings, setSettings] = useState<CalorieSettings>(DEFAULT_SETTINGS);
  const [editingGoals, setEditingGoals] = useState(false);
  const [name, setName] = useState("");
  const [cal, setCal] = useState("");
  const [pro, setPro] = useState("");
  const [week, setWeek] = useState<{ day: string; cal: number }[]>([]);

  const load = useCallback(async () => {
    const day = todayStr();
    const [{ data }, { data: settingsRow }, { data: hist }] = await Promise.all([
      supabase.from("meals").select("*").eq("user_id", uid).eq("day", day).order("created_at"),
      supabase.from("user_settings").select("calorie_goal,protein_goal").eq("user_id", uid).maybeSingle(),
      supabase.from("meals").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(200),
    ]);
    setMeals((data ?? []) as Meal[]);
    if (settingsRow) setSettings(settingsRow as CalorieSettings);

    // distinct recent meal names for one-tap re-logging
    const seen = new Set<string>();
    const uniq: Meal[] = [];
    for (const m of (hist ?? []) as Meal[]) {
      const key = m.name.toLowerCase();
      if (!seen.has(key)) { seen.add(key); uniq.push(m); }
      if (uniq.length >= 8) break;
    }
    setRecent(uniq);

    const since = new Date(); since.setDate(since.getDate() - 6);
    const { data: w } = await supabase.from("meals").select("day,calories").eq("user_id", uid).gte("day", dateStr(since));
    const totals = new Map<string, number>();
    (w ?? []).forEach((m: { day: string; calories: number }) => totals.set(m.day, (totals.get(m.day) ?? 0) + m.calories));
    const out: { day: string; cal: number }[] = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); out.push({ day: dateStr(d), cal: totals.get(dateStr(d)) ?? 0 }); }
    setWeek(out);
  }, [uid]);

  useEffect(() => { load(); }, [load]);

  async function addMeal(preset?: { name: string; calories: number; protein: number }) {
    const m = preset ?? { name: name || "Meal", calories: Number(cal) || 0, protein: Number(pro) || 0 };
    if (!preset && !name && !cal) return;
    const meal = { user_id: uid, day: todayStr(), ...m };
    const { data } = await supabase.from("meals").insert(meal).select().single();
    if (data) setMeals((x) => [...x, data as Meal]);
    setName(""); setCal(""); setPro("");
    syncDayTotals();
  }

  async function removeMeal(id: string) {
    setMeals((m) => m.filter((x) => x.id !== id));
    await supabase.from("meals").delete().eq("id", id);
    syncDayTotals();
  }

  async function saveGoals(calorie_goal: number, protein_goal: number) {
    setSettings({ calorie_goal, protein_goal });
    await supabase.from("user_settings").upsert({ user_id: uid, calorie_goal, protein_goal }, { onConflict: "user_id" });
    setEditingGoals(false);
  }

  // keep the Today quick-log totals in sync with logged meals
  async function syncDayTotals() {
    const { data } = await supabase.from("meals").select("calories,protein").eq("user_id", uid).eq("day", todayStr());
    const c = (data ?? []).reduce((s, m: { calories: number }) => s + m.calories, 0);
    const p = (data ?? []).reduce((s, m: { protein: number }) => s + m.protein, 0);
    await supabase.from("days").upsert({ user_id: uid, day: todayStr(), calories: c, protein: p }, { onConflict: "user_id,day" });
    load();
  }

  const totalCal = meals.reduce((s, m) => s + m.calories, 0);
  const totalPro = meals.reduce((s, m) => s + m.protein, 0);
  const maxCal = Math.max(2000, ...week.map((w) => w.cal));
  const calPct = settings.calorie_goal ? totalCal / settings.calorie_goal : 0;
  const proPct = settings.protein_goal ? totalPro / settings.protein_goal : 0;

  return (
    <div>
      <div className="flex items-center justify-between pt-3">
        <h1 className="text-2xl font-bold">🍎 Food</h1>
        <button onClick={() => setEditingGoals((v) => !v)} className="text-xs opacity-50 underline">edit goals</button>
      </div>

      {editingGoals && (
        <Card className="mt-3">
          <GoalEditor settings={settings} onSave={saveGoals} />
        </Card>
      )}

      <div className="flex items-center gap-4 mt-4">
        <Ring score={Math.min(totalCal, settings.calorie_goal)} total={settings.calorie_goal} />
        <div className="flex-1">
          <p className="text-3xl font-extrabold leading-none">{totalCal}<span className="text-base opacity-50"> / {settings.calorie_goal} kcal</span></p>
          <p className="text-sm opacity-60 mt-1">{totalCal >= settings.calorie_goal ? "Goal hit 🔥" : `${settings.calorie_goal - totalCal} kcal left`}</p>
        </div>
      </div>
      <div className="mt-3">
        <div className="flex justify-between text-xs opacity-60 mb-1"><span>💪 Protein</span><span>{totalPro} / {settings.protein_goal}g</span></div>
        <ProgressBar pct={proPct} tone="gold" />
      </div>
      <p className="text-[10px] opacity-30 mt-1">{Math.round(calPct * 100)}% of calorie goal</p>

      {recent.length > 0 && (
        <>
          <SectionTitle>Quick add — tap a recent meal</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {recent.map((m) => (
              <button key={m.id} onClick={() => addMeal({ name: m.name, calories: m.calories, protein: m.protein })}
                className="text-xs font-medium px-3 py-2 rounded-full bg-white/5 border border-white/10 active:scale-95">
                {m.name} <span className="opacity-40">· {m.calories}kcal</span>
              </button>
            ))}
          </div>
        </>
      )}

      <SectionTitle>Add a meal</SectionTitle>
      <div className="space-y-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="what did you eat?"
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
        <div className="flex gap-2">
          <input value={cal} onChange={(e) => setCal(e.target.value)} inputMode="numeric" placeholder="kcal"
            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none text-center" />
          <input value={pro} onChange={(e) => setPro(e.target.value)} inputMode="numeric" placeholder="protein g"
            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none text-center" />
          <button onClick={() => addMeal()} className="px-5 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">Add</button>
        </div>
      </div>

      <SectionTitle>Today&apos;s meals</SectionTitle>
      {meals.length === 0 && <p className="opacity-40 text-sm">Nothing logged yet.</p>}
      <div className="space-y-2">
        {meals.map((m) => (
          <div key={m.id} className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-4 py-3">
            <span className="flex-1 font-medium">{m.name}</span>
            <span className="text-sm opacity-70">{m.calories} kcal · {m.protein}g</span>
            <button onClick={() => removeMeal(m.id)} className="opacity-40 active:scale-90">✕</button>
          </div>
        ))}
      </div>

      <SectionTitle>Calories — last 7 days</SectionTitle>
      <div className="flex justify-between gap-1 items-end">
        {week.map((w) => (
          <div key={w.day} className="flex-1 flex flex-col items-center gap-1">
            <span className="text-[9px] opacity-50">{w.cal || ""}</span>
            <div className="w-full h-24 rounded-lg bg-white/5 flex items-end overflow-hidden">
              <div className="w-full rounded-lg bg-[var(--neon)]" style={{ height: `${Math.min((w.cal / maxCal) * 100, 100)}%` }} />
            </div>
            <span className="text-[10px] opacity-50">{new Date(w.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "narrow" })}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GoalEditor({ settings, onSave }: { settings: CalorieSettings; onSave: (cal: number, pro: number) => void }) {
  const [cal, setCal] = useState(String(settings.calorie_goal));
  const [pro, setPro] = useState(String(settings.protein_goal));
  return (
    <div>
      <p className="text-xs uppercase tracking-widest opacity-50 mb-2">Daily goals</p>
      <div className="flex gap-2">
        <input value={cal} onChange={(e) => setCal(e.target.value)} inputMode="numeric" placeholder="calorie goal"
          className="flex-1 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-center" />
        <input value={pro} onChange={(e) => setPro(e.target.value)} inputMode="numeric" placeholder="protein goal"
          className="flex-1 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-center" />
        <button onClick={() => onSave(Number(cal) || 2200, Number(pro) || 160)} className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">Save</button>
      </div>
    </div>
  );
}
