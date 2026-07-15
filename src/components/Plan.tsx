"use client";

// 🧭 Plan — the "everything out of your head" tab. Research basis:
// - Zeigarnik effect: open loops eat working memory until they're captured
//   WITH a next step — so every inbox item gets a one-tap destination.
// - GTD collapses for ADHD at capture friction and the weekly review — so
//   capture is one box + one button, and the review is exactly 3 questions.
// - 3 priorities max per week. Not 10. The constraint is the feature.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, dateStr, todayStr, type Goal } from "@/lib/supabase";
import { useVoiceInput } from "@/lib/useVoiceInput";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { xpToast, sfx, buzz } from "@/lib/fx";
import { SectionTitle, Card } from "./ui";

type Capture = { id: string; text: string; done: boolean; created_at: string };
type WeekPlan = { id?: string; week_start: string; priorities: string[]; notes: string; reviewed_at: string | null };

function mondayOf(d = new Date()): string {
  const c = new Date(d);
  c.setDate(c.getDate() - ((c.getDay() + 6) % 7));
  return dateStr(c);
}
function tomorrowStr(): string {
  const d = new Date(); d.setDate(d.getDate() + 1); return dateStr(d);
}

export default function Plan({ uid, onGoTab }: { uid: string; onGoTab?: (tab: string) => void }) {
  const game = useGame();
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [captureText, setCaptureText] = useState("");
  const [week, setWeek] = useState<WeekPlan>({ week_start: mondayOf(), priorities: ["", "", ""], notes: "", reviewed_at: null });
  const [dueThisWeek, setDueThisWeek] = useState<Goal[]>([]);
  const [someday, setSomeday] = useState<Goal[]>([]);
  const [somedayText, setSomedayText] = useState("");
  const [review, setReview] = useState<{ win: string; drag: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [captureError, setCaptureError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triaging = useRef(false);
  const captureVoice = useVoiceInput((text) => setCaptureText(text));
  // week key rolls over correctly in a PWA left open across Sunday midnight
  const [, setTick] = useState(0);
  useEffect(() => {
    const onVisible = () => setTick((t) => t + 1);
    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(onVisible, 60000);
    return () => { document.removeEventListener("visibilitychange", onVisible); clearInterval(id); };
  }, []);

  const ws = mondayOf();

  const load = useCallback(async () => {
    const weekEnd = new Date(ws + "T00:00:00"); weekEnd.setDate(weekEnd.getDate() + 6);
    const [{ data: caps }, { data: wp }, { data: due }, { data: sd }] = await Promise.all([
      supabase.from("captures").select("*").eq("user_id", uid).eq("done", false).order("created_at", { ascending: false }).limit(50),
      supabase.from("weekly_plans").select("*").eq("user_id", uid).eq("week_start", ws).maybeSingle(),
      supabase.from("goals").select("*").eq("user_id", uid).eq("status", "active").gte("due", todayStr()).lte("due", dateStr(weekEnd)).order("due"),
      supabase.from("goals").select("*").eq("user_id", uid).eq("status", "someday").order("created_at", { ascending: false }),
    ]);
    setCaptures((caps ?? []) as Capture[]);
    if (wp) {
      setWeek({
        id: wp.id, week_start: ws,
        priorities: ((wp.priorities as string[]) ?? []).concat(["", "", ""]).slice(0, 3),
        notes: wp.notes ?? "", reviewed_at: wp.reviewed_at,
      });
    } else {
      setWeek({ week_start: ws, priorities: ["", "", ""], notes: "", reviewed_at: null });
    }
    setDueThisWeek((due ?? []) as Goal[]);
    setSomeday((sd ?? []) as Goal[]);
  }, [uid, ws]);
  useEffect(() => { load(); }, [load]);

  // ── capture: one box, zero decisions — but "captured" must mean SAVED ──
  async function capture() {
    const text = captureText.trim();
    if (!text) return;
    setCaptureError(false);
    const { data, error } = await supabase.from("captures").insert({ user_id: uid, text }).select().single();
    if (error || !data) {
      setCaptureError(true); // text stays put — nothing lost
      return;
    }
    setCaptureText("");
    sfx.pop(); buzz(10);
    setCaptures((c) => [data as Capture, ...c]);
  }

  // every inbox item leaves with a NEXT STEP attached. Serialized — the
  // tomorrow-plan path is a read-modify-write on nights.items, and two
  // concurrent triages would drop one item.
  async function triage(fn: () => Promise<void>) {
    if (triaging.current) return;
    triaging.current = true;
    try { await fn(); } finally { triaging.current = false; }
  }
  const toGoal = (c: Capture) => triage(async () => {
    const { error } = await supabase.from("goals").insert({ user_id: uid, title: c.text, priority: 2, status: "active" });
    if (!error) await dismiss(c, "🎯 now a goal");
  });
  const toTomorrow = (c: Capture) => triage(async () => {
    const day = tomorrowStr();
    const { data } = await supabase.from("nights").select("items,top3,notes").eq("user_id", uid).eq("day", day).maybeSingle();
    const items = [...(((data?.items as { time: string; what: string }[]) ?? [])), { time: "", what: c.text }];
    const { error } = await supabase.from("nights").upsert(
      { user_id: uid, day, items, top3: (data?.top3 as string[]) ?? ["", "", ""], notes: data?.notes ?? "" },
      { onConflict: "user_id,day" },
    );
    if (!error) await dismiss(c, "🌙 on tomorrow's plan");
  });
  const toSomeday = (c: Capture) => triage(async () => {
    const { error } = await supabase.from("goals").insert({ user_id: uid, title: c.text, priority: 3, status: "someday" });
    if (!error) await dismiss(c, "🌠 parked in someday");
  });
  async function dismiss(c: Capture, note?: string) {
    setCaptures((x) => x.filter((y) => y.id !== c.id));
    await supabase.from("captures").update({ done: true }).eq("id", c.id);
    if (note) { sfx.coin(); }
    load();
  }

  // ── weekly plan: 3 priorities, debounced saves ──────────────────────
  function persistWeek(next: WeekPlan) {
    setWeek(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await supabase.from("weekly_plans").upsert(
        { user_id: uid, week_start: ws, priorities: next.priorities, notes: next.notes, reviewed_at: next.reviewed_at },
        { onConflict: "user_id,week_start" },
      );
      setSaved(true); setTimeout(() => setSaved(false), 1200);
    }, 600);
  }

  // ── someday / aspirations ───────────────────────────────────────────
  async function addSomeday() {
    const t = somedayText.trim();
    if (!t) return;
    setSomedayText("");
    const { data } = await supabase.from("goals").insert({ user_id: uid, title: t, priority: 3, status: "someday" }).select().single();
    if (data) setSomeday((s) => [data as Goal, ...s]);
  }
  async function promote(g: Goal) {
    setSomeday((s) => s.filter((x) => x.id !== g.id));
    await supabase.from("goals").update({ status: "active" }).eq("id", g.id);
    xpToast(5, "made real");
    load();
  }
  async function dropSomeday(id: string) {
    setSomeday((s) => s.filter((x) => x.id !== id));
    await supabase.from("goals").delete().eq("id", id);
  }

  // ── weekly review: exactly 3 questions, banked XP ───────────────────
  const reviewDue = !week.reviewed_at || (Date.now() - new Date(week.reviewed_at).getTime()) > 6 * 86400000;
  async function finishReview() {
    if (!review) return;
    const stamp = new Date().toISOString();
    const noteAdd = `— Review ${todayStr()} —\nWin: ${review.win || "(none written)"}\nDragged: ${review.drag || "(none written)"}`;
    const next = { ...week, notes: week.notes ? `${week.notes}\n\n${noteAdd}` : noteAdd, reviewed_at: stamp };
    // write the review DIRECTLY — a debounce timer dies if the PWA is
    // backgrounded right after the tap, and review answers must not be lost
    setWeek(next);
    const { error } = await supabase.from("weekly_plans").upsert(
      { user_id: uid, week_start: ws, priorities: next.priorities, notes: next.notes, reviewed_at: stamp },
      { onConflict: "user_id,week_start" },
    );
    if (error) return; // keep the review form open — answers not lost
    setReview(null);
    await game.bankQuestXP("weekly_review", 40);
    burstConfetti("small");
    sfx.fanfare();
    xpToast(40, "weekly review");
    game.refresh();
  }

  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const weekLabel = `${new Date(ws + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${(() => { const e = new Date(ws + "T00:00:00"); e.setDate(e.getDate() + 6); return e.toLocaleDateString(undefined, { month: "short", day: "numeric" }); })()}`;
  const dayIdx = (new Date().getDay() + 6) % 7;

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">🧭 Plan</h1>
      <p className="opacity-50 text-sm mt-1">
        Everything out of your head, into the system. <span className={`text-[var(--neon)] transition-opacity ${saved ? "opacity-100" : "opacity-0"}`}>saved ✓</span>
      </p>

      {/* capture — the always-there box */}
      <Card tone="neon" className="mt-4">
        <p className="text-xs uppercase tracking-widest text-[var(--neon)]/80 mb-2">✍️ Get it out of your head</p>
        <div className="flex gap-2">
          <input value={captureText} onChange={(e) => setCaptureText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && capture()}
            placeholder={captureVoice.listening ? "listening…" : "thought, worry, task, idea — anything"}
            className="flex-1 min-w-0 rounded-xl bg-black/30 px-4 py-3 outline-none" />
          {captureVoice.supported && (
            <button onClick={captureVoice.toggle}
              className={`w-12 rounded-xl font-bold active:scale-95 ${captureVoice.listening ? "bg-red-500 text-white animate-pulse" : "bg-white/10"}`}>🎤</button>
          )}
          <button onClick={capture} className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">＋</button>
        </div>
        {captureError && <p className="text-xs text-orange-400 mt-2">Couldn&apos;t save — your text is still here. Try again.</p>}
        <p className="text-[10px] opacity-40 mt-2">Captured = off your mind. Sort it below whenever — each item leaves with a next step.</p>
      </Card>

      {/* inbox */}
      {captures.length > 0 && (
        <>
          <SectionTitle>📥 Inbox · {captures.length}</SectionTitle>
          <div className="space-y-2">
            {captures.map((c) => (
              <Card key={c.id} padded={false} className="p-3">
                <p className="text-sm font-medium mb-2">{c.text}</p>
                <div className="flex gap-1.5 text-[10px] font-bold">
                  <button onClick={() => toGoal(c)} className="flex-1 py-1.5 rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] active:scale-95">🎯 Goal</button>
                  <button onClick={() => toTomorrow(c)} className="flex-1 py-1.5 rounded-lg bg-white/10 active:scale-95">🌙 Tomorrow</button>
                  <button onClick={() => toSomeday(c)} className="flex-1 py-1.5 rounded-lg bg-white/10 active:scale-95">🌠 Someday</button>
                  <button onClick={() => dismiss(c)} className="px-3 py-1.5 rounded-lg bg-white/5 opacity-60 active:scale-95">✓</button>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* this week */}
      <SectionTitle>🗓️ This week · {weekLabel}</SectionTitle>
      <div className="flex gap-1 mb-2">
        {days.map((d, i) => (
          <span key={d} className={`flex-1 text-center text-[10px] py-1 rounded ${i === dayIdx ? "bg-[var(--neon)]/20 text-[var(--neon)] font-bold" : i < dayIdx ? "opacity-30" : "opacity-60"}`}>{d}</span>
        ))}
      </div>
      <Card>
        <p className="text-xs uppercase tracking-widest opacity-50 mb-2">The 3 that matter — protect these</p>
        <div className="space-y-2">
          {week.priorities.map((p, i) => (
            <div key={i} className="flex items-center gap-2 rounded-xl bg-black/30 px-4 py-3">
              <span className="text-[var(--neon)] font-bold">{i + 1}</span>
              <input value={p} onChange={(e) => persistWeek({ ...week, priorities: week.priorities.map((x, idx) => idx === i ? e.target.value : x) })}
                placeholder={i === 0 ? "if only ONE thing happens this week…" : "…"}
                className="flex-1 bg-transparent outline-none" />
            </div>
          ))}
        </div>
        {dueThisWeek.length > 0 && (
          <div className="mt-3 pt-3 border-t border-white/10">
            <p className="text-[10px] uppercase tracking-widest opacity-40 mb-1.5">⏳ due this week</p>
            {dueThisWeek.map((g) => {
              const dl = Math.round((new Date(g.due + "T00:00:00").getTime() - new Date(todayStr() + "T00:00:00").getTime()) / 86400000);
              return (
                <button key={g.id} onClick={() => onGoTab?.("goals")} className="flex items-center gap-2 w-full text-left text-sm py-1">
                  <span className="flex-1 min-w-0 truncate">{g.title}</span>
                  <span className={`text-xs font-bold shrink-0 ${dl <= 1 ? "text-red-400" : "text-orange-300"}`}>{dl === 0 ? "today" : `${dl}d`}</span>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {/* weekly review — 3 questions, that's it */}
      {reviewDue && (
        <Card tone="warn" className="mt-3">
          {!review ? (
            <div className="flex items-center gap-3">
              <span className="text-2xl">🪞</span>
              <div className="flex-1">
                <p className="text-sm font-bold">Weekly review — 2 minutes, 3 questions</p>
                <p className="text-[10px] opacity-50">closes the week's open loops · +40 XP</p>
              </div>
              <button onClick={() => setReview({ win: "", drag: "" })} className="px-4 py-2 rounded-xl bg-[var(--neon)] text-black text-sm font-bold active:scale-95">Start</button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-bold">1 · What's one win from this week?</p>
              <input value={review.win} onChange={(e) => setReview({ ...review, win: e.target.value })}
                className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" placeholder="anything counts" />
              <p className="text-xs font-bold">2 · What dragged you down?</p>
              <input value={review.drag} onChange={(e) => setReview({ ...review, drag: e.target.value })}
                className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" placeholder="name it, don't judge it" />
              <p className="text-xs font-bold">3 · Set next week&apos;s 3 priorities above ☝️ then —</p>
              <button onClick={finishReview} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">Done · +40 XP</button>
            </div>
          )}
        </Card>
      )}

      {/* notes / thoughts for the week */}
      <SectionTitle>🧠 Week notes — thoughts, plans, worries</SectionTitle>
      <textarea value={week.notes} onChange={(e) => persistWeek({ ...week, notes: e.target.value })} rows={5}
        placeholder="whatever's swirling — school, work, money, gf, travel… writing it here means you don't have to hold it"
        className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none resize-none" />

      {/* someday / aspirations */}
      <SectionTitle>🌠 Someday — aspirations, trips, big swings</SectionTitle>
      <div className="flex gap-2 mb-2">
        <input value={somedayText} onChange={(e) => setSomedayText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addSomeday()}
          placeholder="learn to surf · tokyo trip · start the next thing"
          className="flex-1 min-w-0 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
        <button onClick={addSomeday} className="px-4 rounded-xl bg-white/10 font-bold active:scale-95">Add</button>
      </div>
      <div className="space-y-1.5 mb-4">
        {someday.length === 0 && <p className="opacity-30 text-xs">Dreams parked here stay alive without weighing on today.</p>}
        {someday.map((g) => (
          <div key={g.id} className="flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 text-sm">
            <span className="flex-1 min-w-0 truncate">{g.title}</span>
            <button onClick={() => promote(g)} className="shrink-0 text-[10px] font-bold px-2.5 py-1 rounded-full bg-[var(--neon)]/20 text-[var(--neon)] active:scale-95">make it real →</button>
            <button onClick={() => dropSomeday(g.id)} className="opacity-40 active:scale-90">✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}
