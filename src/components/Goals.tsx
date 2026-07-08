"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, type Goal } from "@/lib/supabase";
import { SectionTitle, Pill } from "./ui";
import NorthStar from "./NorthStar";

const JUMPS = [
  { id: "top", label: "🎯 Goals" },
  { id: "history", label: "🗓️ History" },
  { id: "northstar", label: "🌟 North Star" },
  { id: "achievements", label: "🏆 Achievements" },
  { id: "rewards", label: "🎁 Rewards" },
];

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
  const [goals, setGoals] = useState<Goal[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState(2);

  const load = useCallback(async () => {
    const { data } = await supabase.from("goals").select("*").eq("user_id", uid).eq("status", "active");
    setGoals((data ?? []) as Goal[]);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!title.trim()) return;
    const g = { user_id: uid, title: title.trim(), due: due || null, priority, status: "active" };
    const { data } = await supabase.from("goals").insert(g).select().single();
    if (data) setGoals((x) => [...x, data as Goal]);
    setTitle(""); setDue(""); setPriority(2);
  }
  async function complete(id: string) {
    setGoals((x) => x.filter((g) => g.id !== id));
    await supabase.from("goals").update({ status: "done" }).eq("id", id);
  }
  async function remove(id: string) {
    setGoals((x) => x.filter((g) => g.id !== id));
    await supabase.from("goals").delete().eq("id", id);
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
          return (
            <div key={g.id} className="flex items-center gap-3 rounded-xl bg-white/5 border border-white/10 px-4 py-3">
              <button onClick={() => complete(g.id)} className="w-7 h-7 shrink-0 rounded-full border border-white/30 active:scale-90" />
              <div className="flex-1">
                <p className="font-medium">{g.title}</p>
                <p className={`text-xs ${u.color}`}>{u.badge}{g.priority === 1 ? " · high" : ""}</p>
              </div>
              <button onClick={() => remove(g.id)} className="opacity-40 active:scale-90">✕</button>
            </div>
          );
        })}
      </div>

      <NorthStar uid={uid} />
    </div>
  );
}
