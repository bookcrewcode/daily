"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, type Goal } from "@/lib/supabase";
import { GOAL_DONE_XP, GOAL_STEP_XP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { xpToast } from "@/lib/fx";
import { SectionTitle, Pill } from "./ui";
import NorthStar from "./NorthStar";
import WeeklyRecap from "./WeeklyRecap";

const JUMPS = [
  { id: "top", label: "🎯 Goals" },
  { id: "history", label: "🗓️ History" },
  { id: "northstar", label: "🌟 North Star" },
  { id: "achievements", label: "🏆 Achievements" },
  { id: "rewards", label: "🎁 Rewards" },
];

type Step = { id: string; goal_id: string; title: string; done: boolean; sort: number };

function daysUntil(due: string | null): number | null {
  if (!due) return null;
  const d = new Date(due + "T00:00:00");
  const now = new Date(todayStr() + "T00:00:00");
  return Math.round((d.getTime() - now.getTime()) / 86400000);
}

function urgency(g: Goal): { rank: number; badge: string; color: string } {
  const du = daysUntil(g.due);
  if (du !== null && du < 0) return { rank: 0, badge: `${-du}d overdue`, color: "text-red-400" };
  if (du !== null && du <= 2) return { rank: 1, badge: du === 0 ? "today" : `${du}d`, color: "text-orange-400" };
  if (du !== null && du <= 7) return { rank: 2, badge: `${du}d`, color: "text-yellow-400" };
  return { rank: 3 + g.priority, badge: g.due ? `${du}d` : "someday", color: "opacity-50" };
}

export default function Goals({ uid }: { uid: string }) {
  const game = useGame();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [newStep, setNewStep] = useState("");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState(2);

  const load = useCallback(async () => {
    const [{ data: gs }, { data: st }] = await Promise.all([
      supabase.from("goals").select("*").eq("user_id", uid).eq("status", "active"),
      supabase.from("goal_steps").select("id,goal_id,title,done,sort").eq("user_id", uid).order("sort"),
    ]);
    setGoals((gs ?? []) as Goal[]);
    setSteps((st ?? []) as Step[]);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!title.trim()) return;
    const g = { user_id: uid, title: title.trim(), due: due || null, priority, status: "active" };
    const { data } = await supabase.from("goals").insert(g).select().single();
    if (data) {
      setGoals((x) => [...x, data as Goal]);
      setOpen((data as Goal).id); // open the pathway right away — first step is the point
    }
    setTitle(""); setDue(""); setPriority(2);
  }

  async function complete(id: string) {
    const { error } = await supabase.from("goals").update({ status: "done" }).eq("id", id);
    if (error) return;
    setGoals((x) => x.filter((g) => g.id !== id));
    // the single biggest per-action reward in the app — make it FELT
    xpToast(GOAL_DONE_XP, "goal crushed");
    burstConfetti("small");
    game.refresh();
  }

  async function remove(id: string) {
    const { error } = await supabase.from("goals").delete().eq("id", id);
    if (error) return;
    setGoals((x) => x.filter((g) => g.id !== id));
    setSteps((x) => x.filter((s) => s.goal_id !== id));
  }

  async function addStep(goalId: string) {
    const t = newStep.trim();
    if (!t) return;
    const maxSort = Math.max(0, ...steps.filter((s) => s.goal_id === goalId).map((s) => s.sort));
    const { data, error } = await supabase.from("goal_steps")
      .insert({ user_id: uid, goal_id: goalId, title: t, sort: maxSort + 1 })
      .select("id,goal_id,title,done,sort").single();
    if (error || !data) return;
    setSteps((x) => [...x, data as Step]);
    setNewStep("");
  }

  async function toggleStep(s: Step) {
    const next = !s.done;
    const { error } = await supabase.from("goal_steps").update({ done: next }).eq("id", s.id);
    if (error) return;
    setSteps((x) => x.map((st) => (st.id === s.id ? { ...st, done: next } : st)));
    if (next) {
      // unique (user_id, day, quest_key) means re-checking the same day won't double-pay
      const banked = await game.bankQuestXP(`gstep_${s.id}`, GOAL_STEP_XP);
      if (banked) xpToast(GOAL_STEP_XP, "step done");
    }
  }

  async function removeStep(id: string) {
    const { error } = await supabase.from("goal_steps").delete().eq("id", id);
    if (error) return;
    setSteps((x) => x.filter((s) => s.id !== id));
  }

  const sorted = [...goals].sort((a, b) => {
    const ua = urgency(a), ub = urgency(b);
    if (ua.rank !== ub.rank) return ua.rank - ub.rank;
    return (daysUntil(a.due) ?? 9999) - (daysUntil(b.due) ?? 9999);
  });
  const urgent = sorted.filter((g) => urgency(g).rank <= 1);

  return (
    <div id="top">
      <h1 className="text-2xl font-bold pt-3">🎯 Goals</h1>
      <div className="flex gap-1.5 overflow-x-auto mt-3 pb-1 -mx-4 px-4">
        {JUMPS.map((j) => (
          <Pill key={j.id} active={false} onClick={() => document.getElementById(j.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            {j.label}
          </Pill>
        ))}
      </div>
      {urgent.length > 0 && (
        <div className="mt-3 rounded-2xl bg-red-500/10 border border-red-500/40 p-4">
          <p className="text-xs uppercase tracking-widest text-red-400 mb-1">🔥 Urgent — handle today</p>
          {urgent.map((g) => <p key={g.id} className="font-medium">{g.title} <span className={urgency(g).color}>· {urgency(g).badge}</span></p>)}
        </div>
      )}

      <SectionTitle>Add a goal</SectionTitle>
      <div className="space-y-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="what's the goal?"
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
        <div className="flex gap-2">
          <input value={due} onChange={(e) => setDue(e.target.value)} type="date"
            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-3 outline-none" />
          <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}
            className="rounded-xl bg-white/5 border border-white/10 px-3 py-3 outline-none">
            <option value={1}>High</option><option value={2}>Med</option><option value={3}>Low</option>
          </select>
          <button onClick={add} className="px-5 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">Add</button>
        </div>
      </div>

      <SectionTitle>Active — most urgent first</SectionTitle>
      {sorted.length === 0 && <p className="opacity-40 text-sm">No goals yet. Add one above.</p>}
      <div className="space-y-2">
        {sorted.map((g) => {
          const u = urgency(g);
          const gSteps = steps.filter((s) => s.goal_id === g.id);
          const doneCount = gSteps.filter((s) => s.done).length;
          const nextStep = gSteps.find((s) => !s.done);
          const isOpen = open === g.id;
          const pct = gSteps.length ? Math.round((doneCount / gSteps.length) * 100) : 0;
          return (
            <div key={g.id} className="rounded-xl bg-white/5 border border-white/10 overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3">
                <button onClick={() => complete(g.id)} title="complete goal"
                  className="w-7 h-7 shrink-0 rounded-full border border-white/30 active:scale-90" />
                <button className="flex-1 text-left" onClick={() => setOpen(isOpen ? null : g.id)}>
                  <p className="font-medium">{g.title}</p>
                  <p className={`text-xs ${u.color}`}>
                    {u.badge}{g.priority === 1 ? " · high" : ""}
                    {gSteps.length > 0 && <span className="opacity-70"> · {doneCount}/{gSteps.length} steps</span>}
                  </p>
                  {!isOpen && nextStep && (
                    <p className="text-xs mt-0.5 text-[var(--neon)]">→ next: {nextStep.title}</p>
                  )}
                </button>
                <span className={`text-xs opacity-40 transition-transform ${isOpen ? "rotate-90" : ""}`}>▶</span>
                <button onClick={() => remove(g.id)} className="opacity-40 active:scale-90">✕</button>
              </div>

              {gSteps.length > 0 && (
                <div className="h-1 bg-white/5">
                  <div className="h-full bg-[var(--neon)] transition-all" style={{ width: `${pct}%` }} />
                </div>
              )}

              {isOpen && (
                <div className="px-4 pb-3 pt-2 border-t border-white/5 space-y-1.5">
                  {gSteps.length === 0 && (
                    <p className="text-xs opacity-50">Break it down. What&apos;s the first physical action? (+{GOAL_STEP_XP} XP per step)</p>
                  )}
                  {gSteps.map((s) => {
                    const isNext = s.id === nextStep?.id;
                    return (
                      <div key={s.id} className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 ${isNext ? "bg-[var(--neon-dim)]" : ""}`}>
                        <button onClick={() => toggleStep(s)}
                          className={`w-5 h-5 shrink-0 rounded-full border flex items-center justify-center text-[10px] active:scale-90 ${s.done ? "bg-[var(--neon)] border-[var(--neon)] text-black" : "border-white/30"}`}>
                          {s.done ? "✓" : ""}
                        </button>
                        <p className={`flex-1 text-sm ${s.done ? "line-through opacity-40" : isNext ? "font-semibold" : ""}`}>
                          {s.title}{isNext && <span className="text-[var(--neon)] text-xs font-bold"> ← do this</span>}
                        </p>
                        <button onClick={() => removeStep(s.id)} className="opacity-30 text-xs active:scale-90">✕</button>
                      </div>
                    );
                  })}
                  <div className="flex gap-2 pt-1">
                    <input value={isOpen ? newStep : ""} onChange={(e) => setNewStep(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addStep(g.id)}
                      placeholder="add a step…"
                      className="flex-1 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm outline-none" />
                    <button onClick={() => addStep(g.id)} className="px-3 rounded-lg bg-white/10 text-sm font-semibold active:scale-95">+</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <WeeklyRecap />

      <NorthStar uid={uid} />
    </div>
  );
}
