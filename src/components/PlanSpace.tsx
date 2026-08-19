"use client";

// Plan — the day-to-day logistics space, rebuilt clean.
//
// Four flat sections, no AI required, nothing choppy:
//   TODAY      the real timeline: timetable classes + planned blocks, one list
//   DEADLINES  the dated things that must happen (THE GAME: "the thing with a
//              date on it wins") — add in two taps, check off when shipped
//   INBOX      the parking lot: captured thoughts become deadlines or leave
//   SEMESTER   term dates + the weekly class timetable (set once)

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import { diffDays } from "@/lib/theGame";
import { sfx, buzz } from "@/lib/fx";
import { Card } from "./ui";
import Semester from "./Semester";

type Ev = { time: string; what: string };
type Goal = { id: string; title: string; due: string | null; status: string };
type Capture = { id: string; text: string };

export default function PlanSpace({ uid }: { uid: string }) {
  const [items, setItems] = useState<Ev[]>([]);
  const [classes, setClasses] = useState<Ev[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [saving, setSaving] = useState("");
  const [err, setErr] = useState("");

  // add-block form
  const [bTime, setBTime] = useState("");
  const [bWhat, setBWhat] = useState("");
  // add-deadline form
  const [dTitle, setDTitle] = useState("");
  const [dDue, setDDue] = useState("");
  const busyIds = useRef<Set<string>>(new Set());
  const [busyList, setBusyList] = useState<string[]>([]);
  const dayRef = useRef(todayStr());
  // the day the on-screen data belongs to — stamped when load() RESOLVES, so a
  // post-midnight tap can never write yesterday's array onto today's row
  const dataDay = useRef("");
  const addingRef = useRef(false);

  const load = useCallback(async () => {
    const day = todayStr();
    try {
      const [n, cb, g, c] = await Promise.all([
        supabase.from("nights").select("items").eq("user_id", uid).eq("day", day).maybeSingle(),
        supabase.from("class_blocks").select("label,location,start_t").eq("user_id", uid).eq("weekday", new Date().getDay()).order("start_t"),
        supabase.from("goals").select("id,title,due,status").eq("user_id", uid).in("status", ["active"]).order("due", { ascending: true, nullsFirst: false }).order("title").limit(30),
        supabase.from("captures").select("id,text").eq("user_id", uid).eq("done", false).order("created_at", { ascending: false }).limit(30),
      ]);
      // a failed read must never render as "empty" — ALL four feed core sections
      if (n.error || g.error || cb.error || c.error) { setLoadErr(true); setLoaded(true); return; }
      setItems(((n.data?.items ?? []) as Ev[]));   // RAW — display filters, writes preserve
      setClasses(((cb.data ?? []) as { label: string; location: string; start_t: string }[])
        .map((x) => ({ time: x.start_t, what: `${x.label}${x.location ? ` · ${x.location}` : ""}` })));
      setGoals((g.data ?? []) as Goal[]);
      setCaptures((c.data ?? []) as Capture[]);
      dataDay.current = day;
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  // a thought captured from the global ＋ shows up here without a remount
  useEffect(() => {
    const onCap = () => load();
    window.addEventListener("daily:captured", onCap);
    return () => window.removeEventListener("daily:captured", onCap);
  }, [load]);

  // midnight rollover — same guard as the card
  useEffect(() => {
    const check = () => { const now = todayStr(); if (now !== dayRef.current) { dayRef.current = now; load(); } };
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    const id = setInterval(check, 30000);
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  async function writeItems(next: Ev[], key: string) {
    if (saving) return false;
    const day = todayStr();
    if (day !== dataDay.current) { setErr("Midnight — the plan rolled over; refreshing."); load(); return false; }
    setSaving(key); setErr("");
    try {
      const { error } = await supabase.from("nights").upsert({ user_id: uid, day, items: next }, { onConflict: "user_id,day" });
      if (error) { setErr("Couldn't save the plan — try again."); return false; }
      setItems(next); sfx.pop();
      return true;
    } catch { setErr("Couldn't reach the server — nothing saved."); return false; }
    finally { setSaving(""); }
  }

  async function addBlock() {
    const what = bWhat.trim();
    if (!what) return;
    const next = [...items, { time: bTime, what: what.slice(0, 120) }]
      .sort((a, b) => ((a?.time || "99:99")).localeCompare(b?.time || "99:99"));
    const ok = await writeItems(next, "block");
    if (ok) { setBWhat(""); setBTime(""); }
  }

  async function removeBlock(i: number) {
    await writeItems(items.filter((_, k) => k !== i), `rm${i}`);
  }

  const goalSort = (a: Goal, b: Goal) => ((a.due ?? "9999") + a.title).localeCompare((b.due ?? "9999") + b.title);

  async function addDeadline(prefill?: { text: string; captureId?: string }) {
    const title = (prefill?.text ?? dTitle).trim();
    if (!title || saving || addingRef.current) return;
    addingRef.current = true;              // synchronous — a double-tap can't race the state flag
    setSaving("goal"); setErr("");
    try {
      const { data, error } = await supabase.from("goals")
        .insert({ user_id: uid, title: title.slice(0, 200), why: "", due: (prefill ? null : dDue) || null, priority: 0, status: "active" })
        .select("id,title,due,status").single();
      if (error || !data) { setErr("Couldn't add that — it's still here, try again."); return; }
      setGoals((gs) => [...gs, data as Goal].sort(goalSort));
      if (!prefill) { setDTitle(""); setDDue(""); sfx.pop(); buzz(12); return; }

      // promote: the goal EXISTS now, so the capture leaves the inbox locally no
      // matter what — a re-tap must never mint a duplicate deadline.
      setCaptures((cs) => cs.filter((x) => x.id !== prefill.captureId));
      let cErr = (await supabase.from("captures").update({ done: true }).eq("id", prefill.captureId)).error;
      if (cErr) cErr = (await supabase.from("captures").update({ done: true }).eq("id", prefill.captureId)).error; // one quiet retry
      if (cErr) {
        // honest partial: deadline landed, archive didn't — no celebration
        setErr("Deadline added — but the inbox couldn't be cleared. If it reappears, ✕ it (it's already a deadline).");
        return;
      }
      sfx.pop(); buzz(12);
    } catch { setErr("Couldn't reach the server — nothing saved."); }
    finally { setSaving(""); addingRef.current = false; }
  }

  async function completeGoal(id: string) {
    if (busyIds.current.has(id)) return;
    busyIds.current.add(id); setBusyList([...busyIds.current]);
    try {
      const { error } = await supabase.from("goals").update({ status: "done" }).eq("id", id);
      if (error) { setErr("Couldn't check that off — try again."); return; }
      setGoals((gs) => gs.filter((x) => x.id !== id));
      sfx.coin(); buzz(15);
    } catch { setErr("Couldn't reach the server — still open."); }
    finally { busyIds.current.delete(id); setBusyList([...busyIds.current]); }
  }

  async function archiveCapture(id: string) {
    if (busyIds.current.has(id)) return;
    busyIds.current.add(id); setBusyList([...busyIds.current]);
    try {
      const { error } = await supabase.from("captures").update({ done: true }).eq("id", id);
      if (error) { setErr("Couldn't clear that."); return; }
      setCaptures((cs) => cs.filter((x) => x.id !== id));
    } catch { setErr("Couldn't reach the server."); }
    finally { busyIds.current.delete(id); setBusyList([...busyIds.current]); }
  }

  const planned = items.map((it, idx) => ({ time: it?.time ?? "", what: it?.what ?? "", idx })).filter((x) => x.what);
  const timeline = [...classes.map((c) => ({ ...c, cls: true as const, idx: -1 })), ...planned.map((p2) => ({ ...p2, cls: false as const }))]
    .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
  const daysTo = (due: string) => diffDays(todayStr(), due); // DST-proof (Math.round absorbs the ±1h)

  if (!loaded) return <div className="pt-3"><div className="skeleton h-24 mt-2" /><div className="skeleton h-24 mt-3" /></div>;
  if (loadErr) return <div className="pt-6"><button onClick={load} className="w-full rounded-xl bg-orange-500/15 text-orange-300 text-sm font-semibold py-3 active:scale-95">Couldn&apos;t load the plan — tap to retry</button></div>;

  return (
    <div className="pt-3">
      <h1 className="font-display text-2xl font-bold leading-none mb-4">Plan</h1>

      {/* TODAY */}
      <Card>
        <p className="text-[10px] uppercase tracking-[0.2em] opacity-45 mb-2">Today</p>
        {timeline.length === 0 && <p className="text-sm opacity-40">Nothing planned yet — add the day&apos;s blocks below.</p>}
        <div className="space-y-1">
          {timeline.map((t, i) => (
            <div key={`${t.time}-${t.what}-${i}`} className="flex items-center gap-3 py-1 group">
              <span className="tabular-nums text-xs opacity-45 w-11 shrink-0">{t.time || "—"}</span>
              <span className={`text-sm flex-1 min-w-0 truncate ${t.cls ? "opacity-70" : ""}`}>{t.what}{t.cls && <span className="text-[9px] uppercase tracking-wider opacity-40 ml-2">class</span>}</span>
              {!t.cls && (
                <button onClick={() => removeBlock(t.idx)}
                  disabled={!!saving} className="opacity-25 text-xs active:scale-90 disabled:opacity-10">✕</button>
              )}
            </div>
          ))}
        </div>
        <div className="flex gap-1.5 mt-3">
          <input type="time" value={bTime} onChange={(e) => setBTime(e.target.value)} disabled={!!saving}
            className="rounded-lg bg-black/25 px-2.5 py-2 outline-none text-sm w-[6.4rem] shrink-0" />
          <input value={bWhat} onChange={(e) => setBWhat(e.target.value)} disabled={!!saving}
            onKeyDown={(e) => { if (e.key === "Enter") addBlock(); }}
            placeholder="add a block…" className="flex-1 min-w-0 rounded-lg bg-black/25 px-3 py-2 outline-none text-sm" />
          <button onClick={addBlock} disabled={!!saving || !bWhat.trim()}
            className="px-3.5 rounded-lg bg-[var(--neon)] text-black text-sm font-bold active:scale-95 disabled:opacity-40">＋</button>
        </div>
      </Card>

      {/* DEADLINES */}
      <Card className="mt-3">
        <p className="text-[10px] uppercase tracking-[0.2em] opacity-45 mb-2">Deadlines — the dated thing wins</p>
        {goals.length === 0 && <p className="text-sm opacity-40">Nothing dated. When the syllabi land Sept 1, every exam and paper goes here.</p>}
        <div className="space-y-1.5">
          {goals.map((g) => {
            const d = g.due ? daysTo(g.due) : null;
            const toneCls = d !== null && d <= 3 ? "text-orange-300" : d !== null && d <= 7 ? "text-[var(--neon)]" : "opacity-45";
            return (
              <div key={g.id} className="flex items-center gap-2.5 py-0.5">
                <button onClick={() => completeGoal(g.id)} disabled={busyList.includes(g.id)}
                  className="w-5 h-5 rounded-md border border-white/25 shrink-0 active:scale-90 disabled:opacity-40 hover:border-[var(--neon)]" aria-label="done" />
                <span className="text-sm flex-1 min-w-0 truncate">{g.title}</span>
                {g.due && <span className={`text-[11px] tabular-nums shrink-0 ${toneCls}`}>{d === 0 ? "today" : d === 1 ? "tmrw" : d !== null && d < 0 ? `${-d}d late` : `${d}d`}</span>}
              </div>
            );
          })}
        </div>
        <div className="flex gap-1.5 mt-3">
          <input value={dTitle} onChange={(e) => setDTitle(e.target.value)} disabled={!!saving}
            onKeyDown={(e) => { if (e.key === "Enter") addDeadline(); }}
            placeholder="what has to happen…" className="flex-1 min-w-0 rounded-lg bg-black/25 px-3 py-2 outline-none text-sm" />
          <input type="date" value={dDue} onChange={(e) => setDDue(e.target.value)} disabled={!!saving}
            className="rounded-lg bg-black/25 px-2.5 py-2 outline-none text-sm w-[8.2rem] shrink-0" />
          <button onClick={() => addDeadline()} disabled={!!saving || !dTitle.trim()}
            className="px-3.5 rounded-lg bg-[var(--neon)] text-black text-sm font-bold active:scale-95 disabled:opacity-40">＋</button>
        </div>
      </Card>

      {/* INBOX / parking lot */}
      {captures.length > 0 && (
        <Card className="mt-3">
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-45 mb-2">Inbox — park it or date it</p>
          <div className="space-y-1.5">
            {captures.map((c) => (
              <div key={c.id} className="flex items-center gap-2 py-0.5">
                <span className="text-sm flex-1 min-w-0 truncate opacity-80">{c.text}</span>
                <button onClick={() => addDeadline({ text: c.text, captureId: c.id })} disabled={!!saving || busyList.includes(c.id)}
                  className="text-[11px] font-semibold text-[var(--neon)] shrink-0 active:scale-95 disabled:opacity-40">→ deadline</button>
                <button onClick={() => archiveCapture(c.id)} disabled={busyList.includes(c.id)}
                  className="opacity-25 text-xs shrink-0 active:scale-90 disabled:opacity-10">✕</button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Semester uid={uid} />
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
    </div>
  );
}
