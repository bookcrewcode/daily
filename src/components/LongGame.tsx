"use client";

// 🎯 LONG GAME — the third gear in Plan, between the day and the season.
//
// Ben asked for "a longterm goal planning section ... plus a option to add new
// with date of when im trying to achieve it by". The date is the whole point:
// a goal with a target date lands on the Card's checklist ON that date, so a
// deadline can't quietly pass while the day-to-day rolls on. That's the loop —
// long game sets the date, the Card makes you face it.
//
// The tables already existed (goals + goal_steps, same ones the legacy Goals
// tab writes) and were completely empty. XP stays identical to that screen:
// finished goals are COUNTED (goalsDoneCount, so no double-pay is possible) and
// steps bank once ever through the gstep_<id> sentinel key.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr, type Goal } from "@/lib/supabase";
import { GOAL_DONE_XP, GOAL_STEP_XP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { xpToast, sfx, buzz } from "@/lib/fx";
import { SEASON_END } from "@/lib/theGame";
import { Card, Eyebrow, ProgressBar } from "./ui";

type Step = { id: string; goal_id: string; title: string; done: boolean; sort: number };

// Titles only — the app has no business inventing what Ben's deadline is. He
// taps one, it fills the form, he sets the date himself. The season starter is
// the one exception: Dec 15 is a real, already-fixed date.
const STARTERS: { title: string; due?: string }[] = [
  { title: "Finish the season", due: SEASON_END },
  { title: "Hit 190 lbs" },
  { title: "New project with Gavin, Thay and Oliver" },
];

function daysUntil(due: string | null): number | null {
  if (!due) return null;
  const d = new Date(due + "T00:00:00");
  const now = new Date(todayStr() + "T00:00:00");
  return Math.round((d.getTime() - now.getTime()) / 86400000);
}

function countdown(due: string | null): { text: string; color: string } {
  const du = daysUntil(due);
  if (du === null) return { text: "no date yet", color: "var(--text-4)" };
  if (du < 0) return { text: `${-du}d overdue`, color: "var(--bad)" };
  if (du === 0) return { text: "due today", color: "var(--bad)" };
  if (du <= 7) return { text: `${du}d left`, color: "var(--warn)" };
  if (du <= 30) return { text: `${du}d left`, color: "var(--text-2)" };
  const weeks = Math.round(du / 7);
  return { text: weeks <= 26 ? `${weeks}w left` : `${Math.round(du / 30)}mo left`, color: "var(--text-3)" };
}

const fmtDate = (d: string) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export default function LongGame({ uid }: { uid: string }) {
  const game = useGame();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const busy = useRef<Set<string>>(new Set());
  const [busyList, setBusyList] = useState<string[]>([]);

  // add-goal form
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [why, setWhy] = useState("");
  const [adding, setAdding] = useState(false);
  const [newStep, setNewStep] = useState("");

  const lock = (k: string, on: boolean) => {
    if (on) busy.current.add(k); else busy.current.delete(k);
    setBusyList([...busy.current]);
  };
  const isBusy = (k: string) => busyList.includes(k);

  const load = useCallback(async () => {
    const [g, st] = await Promise.all([
      supabase.from("goals").select("id,title,why,due,priority,status").eq("user_id", uid).eq("status", "active"),
      supabase.from("goal_steps").select("id,goal_id,title,done,sort").eq("user_id", uid).order("sort"),
    ]);
    // A transient read failure must NOT render as "no goals yet" — that empty
    // state invites a duplicate re-add of everything he already has.
    if (g.error || st.error) { setLoadErr(true); setLoaded(true); return; }
    setGoals((g.data ?? []) as Goal[]);
    setSteps((st.data ?? []) as Step[]);
    setLoadErr(false); setLoaded(true);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  // a PWA left open overnight must recompute every countdown for the new day
  const loadedDay = useRef(todayStr());
  useEffect(() => {
    const check = () => {
      if (todayStr() !== loadedDay.current) { loadedDay.current = todayStr(); load(); }
    };
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    const id = setInterval(check, 60000);
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  async function add() {
    const t = title.trim();
    if (!t || adding) return;
    setAdding(true); setErr("");
    try {
      const { data, error } = await supabase.from("goals")
        .insert({ user_id: uid, title: t.slice(0, 200), why: why.trim().slice(0, 400), due: due || null, priority: 2, status: "active" })
        .select("id,title,why,due,priority,status").single();
      // nothing typed is lost on a failure — the form keeps every field
      if (error || !data) { setErr("Couldn't save that goal — try again."); return; }
      setGoals((x) => [...x, data as Goal]);
      setOpen((data as Goal).id);      // open the roadmap immediately — step one is the point
      setTitle(""); setDue(""); setWhy("");
      sfx.pop(); buzz(12);
    } catch { setErr("Couldn't reach the server — nothing saved."); }
    finally { setAdding(false); }
  }

  async function setDueDate(g: Goal, next: string) {
    if (isBusy(g.id)) return;
    lock(g.id, true); setErr("");
    try {
      const { error } = await supabase.from("goals").update({ due: next || null }).eq("id", g.id);
      if (error) { setErr("Couldn't change that date — try again."); return; }
      setGoals((x) => x.map((y) => (y.id === g.id ? { ...y, due: next || null } : y)));
    } catch { setErr("Couldn't reach the server — the date didn't change."); }
    finally { lock(g.id, false); }
  }

  async function complete(g: Goal) {
    if (isBusy(g.id)) return;
    lock(g.id, true); setErr("");
    try {
      const { error } = await supabase.from("goals").update({ status: "done" }).eq("id", g.id);
      if (error) { setErr("Couldn't close that goal — try again."); return; }
      setGoals((x) => x.filter((y) => y.id !== g.id));
      // the single biggest per-action reward in the app — make it FELT.
      // XP is derived from the COUNT of done goals, so this can't double-pay.
      xpToast(GOAL_DONE_XP, "goal crushed");
      burstConfetti("small"); sfx.fanfare(); buzz([20, 30, 20]);
      game.refresh();
    } catch { setErr("Couldn't reach the server — nothing changed."); }
    finally { lock(g.id, false); }
  }

  async function remove(g: Goal) {
    if (isBusy(g.id)) return;
    if (!confirm(`Delete "${g.title}" and all its steps? This can't be undone.`)) return;
    lock(g.id, true); setErr("");
    try {
      const { error } = await supabase.from("goals").delete().eq("id", g.id);
      if (error) { setErr("Couldn't delete that goal."); return; }
      setGoals((x) => x.filter((y) => y.id !== g.id));
      setSteps((x) => x.filter((s) => s.goal_id !== g.id));
    } catch { setErr("Couldn't reach the server — nothing deleted."); }
    finally { lock(g.id, false); }
  }

  async function addStep(goalId: string) {
    const t = newStep.trim();
    if (!t || isBusy(`s_${goalId}`)) return;
    lock(`s_${goalId}`, true); setErr("");
    try {
      const maxSort = Math.max(0, ...steps.filter((s) => s.goal_id === goalId).map((s) => s.sort));
      const { data, error } = await supabase.from("goal_steps")
        .insert({ user_id: uid, goal_id: goalId, title: t.slice(0, 200), sort: maxSort + 1 })
        .select("id,goal_id,title,done,sort").single();
      if (error || !data) { setErr("Couldn't add that step — it's still typed, try again."); return; }
      setSteps((x) => [...x, data as Step]);
      setNewStep(""); sfx.pop();
    } catch { setErr("Couldn't reach the server — the step is still typed."); }
    finally { lock(`s_${goalId}`, false); }
  }

  async function toggleStep(s: Step) {
    if (isBusy(s.id)) return;
    lock(s.id, true); setErr("");
    try {
      const next = !s.done;
      const { error } = await supabase.from("goal_steps").update({ done: next }).eq("id", s.id);
      if (error) { setErr("Couldn't save that step."); return; }
      setSteps((x) => x.map((st) => (st.id === s.id ? { ...st, done: next } : st)));
      if (next) {
        sfx.coin(); buzz(10);
        // Fixed-day sentinel: the unique (user_id, day, quest_key) key lets
        // gstep_<id> be claimed AT MOST once ever, so re-checking a step on a
        // later day can't slip past it and pay twice.
        const { error: bankErr } = await supabase.from("quest_claims")
          .insert({ user_id: uid, day: "2000-01-01", quest_key: `gstep_${s.id}`, xp: GOAL_STEP_XP });
        if (!bankErr) { xpToast(GOAL_STEP_XP, "step done"); game.refresh(); }
      }
    } catch { setErr("Couldn't reach the server — the step didn't save."); }
    finally { lock(s.id, false); }
  }

  async function removeStep(id: string) {
    if (isBusy(id)) return;
    lock(id, true);
    try {
      const { error } = await supabase.from("goal_steps").delete().eq("id", id);
      if (error) { setErr("Couldn't remove that step."); return; }
      setSteps((x) => x.filter((s) => s.id !== id));
    } catch { setErr("Couldn't reach the server — the step is still there."); }
    finally { lock(id, false); }
  }

  if (!loaded) return <div className="pt-2"><div className="skeleton h-24 mt-2" /><div className="skeleton h-40 mt-3" /></div>;
  if (loadErr) return (
    <div className="pt-4">
      <button onClick={load} className="w-full rounded-xl bg-orange-500/15 text-orange-300 text-sm font-semibold py-3 active:scale-95">
        Couldn&apos;t load your goals — tap to retry.
      </button>
    </div>
  );

  // dated goals first, soonest first; undated ones sink to the bottom where
  // they read as what they are — wishes, not plans
  const sorted = [...goals].sort((a, b) => (daysUntil(a.due) ?? 99999) - (daysUntil(b.due) ?? 99999));
  const dated = sorted.filter((g) => g.due).length;

  return (
    <div className="pt-2 pb-4">
      <div className="flex items-end justify-between">
        <div>
          <Eyebrow>The long game</Eyebrow>
          <p className="mono text-sm text-[var(--text-2)] mt-1">
            {goals.length === 0 ? "nothing set yet" : `${goals.length} open · ${dated} with a date`}
          </p>
        </div>
      </div>

      {goals.length > 0 && (
        <p className="text-[11px] text-[var(--text-3)] mt-2 leading-relaxed">
          A goal with a target date shows up on the Card&apos;s checklist that morning — so the date has teeth.
        </p>
      )}

      {/* the goals themselves */}
      <div className="mt-3 space-y-2">
        {sorted.map((g) => {
          const mine = steps.filter((s) => s.goal_id === g.id).sort((a, b) => a.sort - b.sort);
          const doneN = mine.filter((s) => s.done).length;
          const cd = countdown(g.due);
          const isOpen = open === g.id;
          const nextStep = mine.find((s) => !s.done);
          return (
            <Card key={g.id} className={isBusy(g.id) ? "opacity-60" : ""}>
              <button onClick={() => { setNewStep(""); setOpen(isOpen ? null : g.id); }} className="w-full text-left active:scale-[0.995]">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm leading-snug">{g.title}</p>
                    <p className="mono text-[10px] mt-1" style={{ color: cd.color }}>
                      {g.due ? `${fmtDate(g.due)} · ${cd.text}` : cd.text}
                      {mine.length > 0 && <span className="text-[var(--text-4)]"> · {doneN}/{mine.length} steps</span>}
                    </p>
                  </div>
                  <span className="text-xs opacity-40 pt-0.5">{isOpen ? "▴" : "▾"}</span>
                </div>
                {mine.length > 0 && <div className="mt-2"><ProgressBar pct={doneN / mine.length} /></div>}
                {!isOpen && nextStep && (
                  <p className="text-[11px] text-[var(--text-3)] mt-1.5 truncate">next → {nextStep.title}</p>
                )}
                {!isOpen && mine.length === 0 && (
                  <p className="text-[11px] text-[var(--warn)] mt-1.5">no roadmap yet — open it and write step one</p>
                )}
              </button>

              {isOpen && (
                <div className="mt-3 pt-3 border-t border-[var(--border-1)] space-y-2 rise-in">
                  {g.why && <p className="text-[11px] text-[var(--text-3)] italic">{g.why}</p>}

                  <div className="space-y-1.5">
                    {mine.map((s) => (
                      <div key={s.id} className="flex items-center gap-2">
                        <button onClick={() => toggleStep(s)} disabled={isBusy(s.id)}
                          aria-label={s.done ? `Uncheck ${s.title}` : `Check off ${s.title}`}
                          className={`w-6 h-6 rounded-md grid place-items-center shrink-0 text-[11px] font-black active:scale-90 disabled:opacity-40 ${
                            s.done ? "bg-[var(--ok)] text-black" : "bg-white/10 text-transparent"}`}>✓</button>
                        <p className={`text-xs flex-1 min-w-0 ${s.done ? "line-through opacity-40" : ""}`}>{s.title}</p>
                        <button onClick={() => removeStep(s.id)} disabled={isBusy(s.id)}
                          aria-label={`Remove ${s.title}`}
                          className="opacity-25 text-xs px-1 active:scale-90 disabled:opacity-10">✕</button>
                      </div>
                    ))}
                  </div>

                  <div className="flex gap-1.5">
                    <input value={newStep} onChange={(e) => setNewStep(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addStep(g.id); }}
                      placeholder="the next concrete step" disabled={isBusy(`s_${g.id}`)}
                      className="flex-1 min-w-0 rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
                    <button onClick={() => addStep(g.id)} disabled={isBusy(`s_${g.id}`) || !newStep.trim()}
                      className="rounded-lg bg-white/10 text-xs font-semibold px-3 active:scale-95 disabled:opacity-40">add</button>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <label className="text-[10px] text-[var(--text-4)]">by</label>
                    <input type="date" value={g.due ?? ""} onChange={(e) => setDueDate(g, e.target.value)} disabled={isBusy(g.id)}
                      className="rounded-lg bg-black/30 px-2.5 py-1.5 outline-none text-xs mono" />
                    <div className="flex-1" />
                    <button onClick={() => complete(g)} disabled={isBusy(g.id)}
                      className="rounded-lg bg-[var(--ok)] text-black text-xs font-bold px-3 py-1.5 active:scale-95 disabled:opacity-40">done</button>
                    <button onClick={() => remove(g)} disabled={isBusy(g.id)}
                      className="text-[10px] opacity-35 underline px-1 active:scale-95">delete</button>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* add a goal — the date field is the whole point of this screen */}
      <Card className="mt-3">
        <Eyebrow className="mb-2">Add a goal</Eyebrow>
        <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={adding}
          placeholder="what you're actually trying to achieve"
          className="w-full rounded-lg bg-black/30 px-3 py-2.5 outline-none text-sm" />
        <div className="flex items-center gap-2 mt-1.5">
          <label className="text-[11px] text-[var(--text-3)] shrink-0">by when</label>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} disabled={adding}
            className="flex-1 min-w-0 rounded-lg bg-black/30 px-3 py-2 outline-none text-sm mono" />
        </div>
        <input value={why} onChange={(e) => setWhy(e.target.value)} disabled={adding}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder="why it matters (optional)"
          className="w-full rounded-lg bg-black/30 px-3 py-2 outline-none text-sm mt-1.5" />
        <button onClick={add} disabled={adding || !title.trim()}
          className="w-full mt-2 rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2.5 active:scale-95 disabled:opacity-40">
          {adding ? "saving…" : "Add the goal"}
        </button>
        {!due && title.trim() && (
          <p className="text-[10px] text-[var(--warn)] mt-1.5">No date means it never reaches the Card. Set one.</p>
        )}

        {goals.length === 0 && (
          <div className="mt-3 pt-3 border-t border-[var(--border-1)]">
            <p className="text-[10px] text-[var(--text-4)] mb-1.5">Starters — these fill the form, you set the date:</p>
            <div className="flex flex-wrap gap-1.5">
              {STARTERS.map((st) => (
                <button key={st.title} onClick={() => { setTitle(st.title); if (st.due) setDue(st.due); }}
                  className="px-2.5 py-1.5 rounded-lg bg-white/5 border border-[var(--border-1)] text-[11px] active:scale-95">
                  {st.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
    </div>
  );
}
