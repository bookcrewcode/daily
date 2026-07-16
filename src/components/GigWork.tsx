"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, dateStr } from "@/lib/supabase";
import { GIG_XP_PER_DOLLARS } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { xpToast } from "@/lib/fx";
import { SectionTitle, Card, ProgressBar } from "./ui";

type Shift = { id: string; day: string; platform: string; hours: number; earnings: number };

const TARGET_RATE = 40;
const fmt = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function GigWork({ uid }: { uid: string }) {
  const game = useGame();
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [platform, setPlatform] = useState<"DoorDash" | "Uber Eats">("DoorDash");
  const [hours, setHours] = useState("");
  const [earnings, setEarnings] = useState("");
  const [goal, setGoal] = useState(10000);
  const [deadline, setDeadline] = useState("2026-08-01");
  const [editingGoal, setEditingGoal] = useState(false);
  const [offline, setOffline] = useState(false);      // last read failed — showing prior data
  const [logError, setLogError] = useState(false);
  const [removeError, setRemoveError] = useState(false);
  const [goalError, setGoalError] = useState(false);

  const load = useCallback(async () => {
    const [{ data, error }, { data: settings, error: sErr }] = await Promise.all([
      supabase.from("gig_shifts").select("*").eq("user_id", uid).order("day", { ascending: false }),
      supabase.from("user_settings").select("gig_goal,gig_deadline").eq("user_id", uid).maybeSingle(),
    ]);
    // READ-ERROR GUARD: a transient read must not render a fabricated "$0 / $10,000"
    // and then let a later write overwrite real rows. Keep prior state and flag it.
    if (error || sErr) { setOffline(true); return; }
    setOffline(false);
    setShifts((data ?? []) as Shift[]);
    if (settings) {
      setGoal(settings.gig_goal ?? 10000);
      setDeadline(settings.gig_deadline ?? "2026-08-01");
    }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function log() {
    if (!hours && !earnings) return;
    const row = { user_id: uid, day: todayStr(), platform, hours: Number(hours) || 0, earnings: Number(earnings) || 0 };
    const { data, error } = await supabase.from("gig_shifts").insert(row).select().single();
    if (error || !data) { setLogError(true); return; } // keep hours/earnings in the inputs — nothing lost
    setLogError(false);
    setShifts((s) => [data as Shift, ...s]);
    const xp = Math.floor(row.earnings / GIG_XP_PER_DOLLARS);
    if (xp > 0) xpToast(xp, "hustle");
    game.refresh();
    setHours(""); setEarnings("");
  }
  async function remove(id: string) {
    const prev = shifts;
    setShifts((s) => s.filter((x) => x.id !== id));
    const { error } = await supabase.from("gig_shifts").delete().eq("id", id);
    if (error) { setShifts(prev); setRemoveError(true); return; }
    setRemoveError(false);
    game.refresh();
  }
  async function saveGoal(g: number, d: string) {
    const prevGoal = goal, prevDeadline = deadline;
    setGoal(g); setDeadline(d);
    const { error } = await supabase.from("user_settings").upsert({ user_id: uid, gig_goal: g, gig_deadline: d }, { onConflict: "user_id" });
    if (error) {
      // roll back so the displayed goal matches what's actually stored; keep the
      // editor open so the user can retry with their values still in place.
      setGoal(prevGoal); setDeadline(prevDeadline);
      setGoalError(true);
      return;
    }
    setGoalError(false);
    setEditingGoal(false);
  }

  const totalEarnings = shifts.reduce((s, x) => s + Number(x.earnings), 0);
  const totalHours = shifts.reduce((s, x) => s + Number(x.hours), 0);
  const avgRate = totalHours > 0 ? totalEarnings / totalHours : 0;
  const pct = goal > 0 ? totalEarnings / goal : 0;
  const daysLeft = Math.max(0, Math.round((new Date(deadline + "T00:00:00").getTime() - new Date(todayStr() + "T00:00:00").getTime()) / 86400000));
  const remaining = Math.max(0, goal - totalEarnings);
  const hoursNeeded = remaining / TARGET_RATE;
  const hoursPerDayNeeded = daysLeft > 0 ? hoursNeeded / daysLeft : hoursNeeded;

  // last 4 weeks (Mon–Sun buckets ending this week)
  const weeks: { label: string; total: number }[] = [];
  for (let w = 3; w >= 0; w--) {
    const end = new Date(); end.setDate(end.getDate() + ((7 - end.getDay()) % 7) - 7 * w); // this week's Sunday (Sunday maps to itself) minus w weeks
    const start = new Date(end); start.setDate(start.getDate() - 6);
    const total = shifts
      .filter((s) => s.day >= dateStr(start) && s.day <= dateStr(end))
      .reduce((sum, s) => sum + Number(s.earnings), 0);
    weeks.push({ label: w === 0 ? "this wk" : `-${w}wk`, total });
  }
  const maxWeek = Math.max(1, ...weeks.map((w) => w.total));

  // per-platform $/hr
  const platformStats = ["DoorDash", "Uber Eats"].map((p) => {
    const rows = shifts.filter((s) => s.platform === p);
    const e = rows.reduce((s, x) => s + Number(x.earnings), 0);
    const h = rows.reduce((s, x) => s + Number(x.hours), 0);
    return { p, rate: h > 0 ? e / h : null };
  }).filter((x) => x.rate != null);

  return (
    <div>
      <SectionTitle>🚗 Gig Work — DoorDash / Uber Eats</SectionTitle>
      <Card tone="neon">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs uppercase tracking-widest opacity-60">
            Toward {fmt(goal)} by {new Date(deadline + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </p>
          <div className="flex items-center gap-2">
            <p className="text-xs font-bold text-[var(--neon)]">{(pct * 100).toFixed(1)}%</p>
            <button onClick={() => setEditingGoal((v) => !v)} className="text-[10px] opacity-40 underline">edit</button>
          </div>
        </div>
        {editingGoal && <GoalEditor goal={goal} deadline={deadline} onSave={saveGoal} />}
        {goalError && <p className="text-xs text-orange-400 mb-1">Couldn&apos;t save the goal — try again.</p>}
        <p className="text-2xl font-extrabold mb-2">{fmt(totalEarnings)} <span className="opacity-40 text-sm font-normal">/ {fmt(goal)}</span></p>
        <ProgressBar pct={pct} />
        <div className="flex justify-between mt-3 text-xs opacity-70">
          <span>⏱️ {totalHours.toFixed(1)} hrs logged</span>
          <span>💵 {fmt(avgRate)}/hr avg <span className="opacity-50">(target {fmt(TARGET_RATE)})</span></span>
        </div>
        {platformStats.length === 2 && (
          <p className="text-xs opacity-60 mt-1.5">
            {platformStats.map((x, i) => (
              <span key={x.p}>{i > 0 && " · "}{x.p}: <b className={x.rate === Math.max(...platformStats.map((y) => y.rate!)) ? "text-[var(--neon)]" : ""}>{fmt(x.rate!)}/hr</b></span>
            ))}
            <span className="opacity-50"> — steer hours to the winner</span>
          </p>
        )}
        {remaining > 0 && daysLeft > 0 && (
          <p className="text-xs opacity-50 mt-2">{daysLeft} days left · ~{hoursNeeded.toFixed(0)} hrs at ${TARGET_RATE}/hr ({hoursPerDayNeeded.toFixed(1)} hrs/day)</p>
        )}
        {remaining === 0 && <p className="text-xs text-[var(--neon)] mt-2">🎉 Goal hit. Raise it?</p>}
      </Card>
      {offline && <p className="text-xs text-orange-400 mt-2">Couldn&apos;t refresh — showing your last saved data.</p>}

      {shifts.length > 0 && (
        <div className="flex gap-2 mt-3 items-end">
          {weeks.map((w) => (
            <div key={w.label} className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[9px] opacity-50">{w.total ? fmt(w.total) : ""}</span>
              <div className="w-full h-14 rounded-lg bg-white/5 flex items-end overflow-hidden">
                <div className="w-full rounded-lg bg-[var(--neon)]/70" style={{ height: `${(w.total / maxWeek) * 100}%` }} />
              </div>
              <span className="text-[10px] opacity-50">{w.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 space-y-2">
        <div className="flex gap-2">
          <button onClick={() => setPlatform("DoorDash")} className={`flex-1 rounded-xl py-2.5 text-sm font-semibold ${platform === "DoorDash" ? "bg-[var(--neon)] text-black" : "bg-white/5"}`}>DoorDash</button>
          <button onClick={() => setPlatform("Uber Eats")} className={`flex-1 rounded-xl py-2.5 text-sm font-semibold ${platform === "Uber Eats" ? "bg-[var(--neon)] text-black" : "bg-white/5"}`}>Uber Eats</button>
        </div>
        <div className="flex gap-2">
          <input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" placeholder="hours"
            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 outline-none text-center" />
          <input value={earnings} onChange={(e) => setEarnings(e.target.value)} inputMode="decimal" placeholder="$ earned"
            onKeyDown={(e) => e.key === "Enter" && log()}
            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 outline-none text-center" />
          <button onClick={log} className="px-5 rounded-xl bg-white/10 font-bold active:scale-95">Log</button>
        </div>
        <p className="text-[10px] opacity-40">Every $10 earned = 1 XP. The hustle counts.</p>
        {logError && <p className="text-xs text-orange-400">Couldn&apos;t log that shift — your hours and earnings are still here. Try again.</p>}
      </div>

      {shifts.length > 0 && (
        <div className="space-y-1.5 mt-3">
          {shifts.slice(0, 8).map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm">
              <span className="flex-1">{s.platform} · {s.day}</span>
              <span className="opacity-70">{s.hours}h · {fmt(Number(s.earnings))}</span>
              <button onClick={() => remove(s.id)} className="opacity-40 active:scale-90">✕</button>
            </div>
          ))}
        </div>
      )}
      {removeError && <p className="text-xs text-orange-400 mt-2">Couldn&apos;t remove that shift — try again.</p>}
    </div>
  );
}

function GoalEditor({ goal, deadline, onSave }: { goal: number; deadline: string; onSave: (g: number, d: string) => void }) {
  const [g, setG] = useState(String(goal));
  const [d, setD] = useState(deadline);
  return (
    <div className="flex gap-2 my-2">
      <input value={g} onChange={(e) => setG(e.target.value)} inputMode="numeric" placeholder="goal $"
        className="flex-1 rounded-xl bg-black/30 px-3 py-2 outline-none text-center text-sm" />
      <input value={d} onChange={(e) => setD(e.target.value)} type="date"
        className="flex-1 rounded-xl bg-black/30 px-2 py-2 outline-none text-sm" />
      <button onClick={() => onSave(Number(g) || goal, d || deadline)} className="px-3 rounded-xl bg-[var(--neon)] text-black text-sm font-bold active:scale-95">Save</button>
    </div>
  );
}
