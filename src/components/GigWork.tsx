"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import { SectionTitle, Card, ProgressBar } from "./ui";

type Shift = { id: string; day: string; platform: string; hours: number; earnings: number };

const GOAL = 10_000;
const TARGET_RATE = 40;
const DEADLINE = new Date("2026-08-01T00:00:00");
const fmt = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function GigWork({ uid }: { uid: string }) {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [platform, setPlatform] = useState<"DoorDash" | "Uber Eats">("DoorDash");
  const [hours, setHours] = useState("");
  const [earnings, setEarnings] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase.from("gig_shifts").select("*").eq("user_id", uid).order("day", { ascending: false });
    setShifts((data ?? []) as Shift[]);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function log() {
    if (!hours && !earnings) return;
    const row = { user_id: uid, day: todayStr(), platform, hours: Number(hours) || 0, earnings: Number(earnings) || 0 };
    const { data } = await supabase.from("gig_shifts").insert(row).select().single();
    if (data) setShifts((s) => [data as Shift, ...s]);
    setHours(""); setEarnings("");
  }
  async function remove(id: string) {
    setShifts((s) => s.filter((x) => x.id !== id));
    await supabase.from("gig_shifts").delete().eq("id", id);
  }

  const totalEarnings = shifts.reduce((s, x) => s + x.earnings, 0);
  const totalHours = shifts.reduce((s, x) => s + x.hours, 0);
  const avgRate = totalHours > 0 ? totalEarnings / totalHours : 0;
  const pct = totalEarnings / GOAL;
  const daysLeft = Math.max(0, Math.round((DEADLINE.getTime() - Date.now()) / 86400000));
  const remaining = Math.max(0, GOAL - totalEarnings);
  const hoursNeeded = remaining / TARGET_RATE;
  const hoursPerDayNeeded = daysLeft > 0 ? hoursNeeded / daysLeft : hoursNeeded;

  return (
    <div>
      <SectionTitle>🚗 Gig Work — DoorDash / Uber Eats</SectionTitle>
      <Card tone="neon">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs uppercase tracking-widest opacity-60">Toward $10k by Aug 1</p>
          <p className="text-xs font-bold text-[var(--neon)]">{(pct * 100).toFixed(1)}%</p>
        </div>
        <p className="text-2xl font-extrabold mb-2">{fmt(totalEarnings)} <span className="opacity-40 text-sm font-normal">/ {fmt(GOAL)}</span></p>
        <ProgressBar pct={pct} />
        <div className="flex justify-between mt-3 text-xs opacity-70">
          <span>⏱️ {totalHours.toFixed(1)} hrs logged</span>
          <span>💵 {fmt(avgRate)}/hr avg <span className="opacity-50">(target {fmt(TARGET_RATE)})</span></span>
        </div>
        {remaining > 0 && (
          <p className="text-xs opacity-50 mt-2">{daysLeft} days left · need ~{hoursNeeded.toFixed(0)} more hrs at ${TARGET_RATE}/hr ({hoursPerDayNeeded.toFixed(1)} hrs/day)</p>
        )}
        {remaining === 0 && <p className="text-xs text-[var(--neon)] mt-2">🎉 Goal hit.</p>}
      </Card>

      <div className="mt-3 space-y-2">
        <div className="flex gap-2">
          <button onClick={() => setPlatform("DoorDash")} className={`flex-1 rounded-xl py-2.5 text-sm font-semibold ${platform === "DoorDash" ? "bg-[var(--neon)] text-black" : "bg-white/5"}`}>DoorDash</button>
          <button onClick={() => setPlatform("Uber Eats")} className={`flex-1 rounded-xl py-2.5 text-sm font-semibold ${platform === "Uber Eats" ? "bg-[var(--neon)] text-black" : "bg-white/5"}`}>Uber Eats</button>
        </div>
        <div className="flex gap-2">
          <input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" placeholder="hours"
            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 outline-none text-center" />
          <input value={earnings} onChange={(e) => setEarnings(e.target.value)} inputMode="decimal" placeholder="$ earned"
            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 outline-none text-center" />
          <button onClick={log} className="px-5 rounded-xl bg-white/10 font-bold active:scale-95">Log</button>
        </div>
      </div>

      {shifts.length > 0 && (
        <div className="space-y-1.5 mt-3">
          {shifts.slice(0, 8).map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm">
              <span className="flex-1">{s.platform} · {s.day}</span>
              <span className="opacity-70">{s.hours}h · {fmt(s.earnings)}</span>
              <button onClick={() => remove(s.id)} className="opacity-40 active:scale-90">✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
