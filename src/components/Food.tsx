"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, dateStr, type Meal } from "@/lib/supabase";
import { SectionTitle } from "./ui";

export default function Food({ uid }: { uid: string }) {
  const [meals, setMeals] = useState<Meal[]>([]);
  const [name, setName] = useState("");
  const [cal, setCal] = useState("");
  const [pro, setPro] = useState("");
  const [week, setWeek] = useState<{ day: string; cal: number }[]>([]);

  const load = useCallback(async () => {
    const day = todayStr();
    const { data } = await supabase.from("meals").select("*").eq("user_id", uid).eq("day", day).order("created_at");
    setMeals((data ?? []) as Meal[]);

    const since = new Date(); since.setDate(since.getDate() - 6);
    const { data: w } = await supabase.from("meals").select("day,calories").eq("user_id", uid).gte("day", dateStr(since));
    const totals = new Map<string, number>();
    (w ?? []).forEach((m: { day: string; calories: number }) => totals.set(m.day, (totals.get(m.day) ?? 0) + m.calories));
    const out: { day: string; cal: number }[] = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); out.push({ day: dateStr(d), cal: totals.get(dateStr(d)) ?? 0 }); }
    setWeek(out);
  }, [uid]);

  useEffect(() => { load(); }, [load]);

  async function addMeal() {
    if (!name && !cal) return;
    const meal = { user_id: uid, day: todayStr(), name: name || "Meal", calories: Number(cal) || 0, protein: Number(pro) || 0 };
    const { data } = await supabase.from("meals").insert(meal).select().single();
    if (data) setMeals((m) => [...m, data as Meal]);
    setName(""); setCal(""); setPro("");
    syncDayTotals();
  }

  async function removeMeal(id: string) {
    setMeals((m) => m.filter((x) => x.id !== id));
    await supabase.from("meals").delete().eq("id", id);
    syncDayTotals();
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

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">🍎 Food</h1>

      <div className="grid grid-cols-2 gap-2 mt-4">
        <div className="rounded-2xl bg-[var(--neon)]/10 border border-[var(--neon)]/40 p-4">
          <p className="text-3xl font-extrabold">{totalCal}</p><p className="text-xs opacity-60">calories today</p>
        </div>
        <div className="rounded-2xl bg-white/5 border border-white/10 p-4">
          <p className="text-3xl font-extrabold">{totalPro}<span className="text-base opacity-50">g</span></p><p className="text-xs opacity-60">protein today</p>
        </div>
      </div>

      <SectionTitle>Add a meal</SectionTitle>
      <div className="space-y-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="what did you eat?"
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
        <div className="flex gap-2">
          <input value={cal} onChange={(e) => setCal(e.target.value)} inputMode="numeric" placeholder="kcal"
            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none text-center" />
          <input value={pro} onChange={(e) => setPro(e.target.value)} inputMode="numeric" placeholder="protein g"
            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none text-center" />
          <button onClick={addMeal} className="px-5 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">Add</button>
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
