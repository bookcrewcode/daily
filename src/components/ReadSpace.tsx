"use client";

// Read — the reading plan as its own space.
//
//   Five books, one at a time, in order (Bryson runs alongside as audio).
//   40 minutes a day at a desk with a pen, never at night or in bed: time,
//   not pages. After the reading, the current book's ONE drill, which is how
//   it sticks: Influence = use one principle on real life within 24h and log
//   it; Ascent of Money = explain the chapter in <5 plain bullets; Super-
//   forecasting = the prediction journal (runs forever, scored on the 1st);
//   Behave = one real behavior down every layer, weekly; Bryson = swipe file.
//
// The day's read + drill slots come from the weekly timetable (class_blocks
// kind read/drill) so Plan, the Card and this screen agree on the times.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import { addDays, weekStart } from "@/lib/theGame";
import {
  type Book, type Session, type Entry, type Drill, type Prediction,
  DRILLS, PRINCIPLES, LAYERS, SLOT_MINUTES, INFLUENCE_TARGET,
  findBuzzwords, asPrediction, brier, calibration, toScore, influenceTally, drillDone, isLate,
} from "@/lib/reading";
import { sfx, buzz } from "@/lib/fx";
import { Card, Eyebrow, ProgressCircle } from "./ui";

const TIMER_KEY = "daily.read.timer";
type Slot = { kind: string; start_t: string; end_t: string; weekday: number };

const input = "w-full rounded-lg bg-black/25 px-3 py-2 outline-none text-sm";
const btn = "rounded-lg bg-[var(--neon)] text-black text-sm font-bold px-3.5 py-2 active:scale-95 disabled:opacity-40";
const ghost = "rounded-lg bg-white/[0.06] border border-[var(--border-1)] text-xs font-semibold px-3 py-2 active:scale-95 disabled:opacity-40";

function readTimer(): { start: number; bookId: string } | null {
  try { const v = JSON.parse(localStorage.getItem(TIMER_KEY) ?? "null"); return v && typeof v.start === "number" ? v : null; } catch { return null; }
}
function writeTimer(v: { start: number; bookId: string } | null) {
  try { if (v) localStorage.setItem(TIMER_KEY, JSON.stringify(v)); else localStorage.removeItem(TIMER_KEY); } catch { /* private mode: the timer just won't survive a reload */ }
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default function ReadSpace({ uid }: { uid: string }) {
  const [books, setBooks] = useState<Book[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState("");
  const busy = useRef(false);

  // ticking clock for the timer + "is it late" (never Date.now() in render)
  const [now, setNow] = useState(0);
  const [timer, setTimer] = useState<{ start: number; bookId: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const since = addDays(todayStr(), -400);
      const [b, s, e, cb] = await Promise.all([
        supabase.from("reading_books").select("id,ord,title,author,drill,status,started_on,finished_on").eq("user_id", uid).order("ord"),
        supabase.from("reading_sessions").select("id,book_id,day,minutes").eq("user_id", uid).gte("day", since).order("day", { ascending: false }),
        supabase.from("reading_entries").select("id,book_id,kind,day,data,created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(1000),
        supabase.from("class_blocks").select("kind,start_t,end_t,weekday").eq("user_id", uid).in("kind", ["read", "drill"]),
      ]);
      if (b.error || s.error || e.error) { setLoadErr(true); setLoaded(true); return; }
      setBooks((b.data ?? []) as Book[]);
      setSessions((s.data ?? []) as Session[]);
      setEntries((e.data ?? []) as Entry[]);
      setSlots(cb.error ? [] : ((cb.data ?? []) as Slot[]));
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  useEffect(() => {
    Promise.resolve().then(() => { setTimer(readTimer()); setNow(Date.now()); });
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const today = todayStr();
  const active = books.find((b) => b.status === "active") ?? null;
  const parallel = books.find((b) => b.status === "parallel") ?? null;
  const nextUp = books.filter((b) => b.status === "queued").sort((a, b) => a.ord - b.ord)[0] ?? null;
  const minutesToday = sessions.filter((s) => s.day === today).reduce((t, s) => t + s.minutes, 0);
  const wk = weekStart(today);
  const drill: Drill | null = active?.drill ?? null;
  const drillToday = drill ? drillDone(drill, entries, today, wk) : false;
  const hour = now ? new Date(now).getHours() : 12;
  const late = now ? isLate(hour) : false;

  const dow = now ? new Date(now).getDay() : new Date().getDay();
  const slotFor = (kind: string, day: number) => slots.find((s) => s.kind === kind && s.weekday === day);
  const readSlot = slotFor("read", dow);
  const drillSlot = slotFor("drill", dow);
  const tomorrowRead = slotFor("read", (dow + 1) % 7);

  const elapsed = timer && now ? Math.max(0, (now - timer.start) / 1000) : 0;

  async function guarded(tag: string, fn: () => Promise<boolean>) {
    if (busy.current) return false;
    busy.current = true; setSaving(tag); setErr("");
    try { return await fn(); }
    catch { setErr("Couldn't save — check the connection and try again. Nothing you typed was cleared."); return false; }
    finally { busy.current = false; setSaving(""); }
  }

  async function logMinutes(min: number, bookId: string | null) {
    const m = Math.round(min);
    if (m < 1) { setErr("Less than a minute — nothing to log yet."); return false; }
    return guarded("session", async () => {
      const { data, error } = await supabase.from("reading_sessions")
        .insert({ user_id: uid, book_id: bookId, day: todayStr(), minutes: Math.min(600, m) })
        .select("id,book_id,day,minutes").single();
      if (error || !data) { setErr("Couldn't log the session — try again."); return false; }
      setSessions((s) => [data as Session, ...s]);
      if (minutesToday + m >= SLOT_MINUTES && minutesToday < SLOT_MINUTES) { sfx.coin(); buzz([10, 40, 10]); }
      return true;
    });
  }

  function startTimer() {
    if (!active) return;
    const v = { start: Date.now(), bookId: active.id };
    writeTimer(v); setTimer(v); setNow(Date.now()); sfx.pop();
  }
  async function stopTimer() {
    if (!timer) return;
    const ok = await logMinutes(elapsed / 60, timer.bookId);
    if (ok) { writeTimer(null); setTimer(null); }
  }
  function cancelTimer() { writeTimer(null); setTimer(null); }

  async function addEntry(kind: Drill, data: Record<string, unknown>, bookId: string | null) {
    return guarded(kind, async () => {
      const { data: row, error } = await supabase.from("reading_entries")
        .insert({ user_id: uid, book_id: bookId, kind, day: todayStr(), data })
        .select("id,book_id,kind,day,data,created_at").single();
      if (error || !row) { setErr("Couldn't save that — try again. What you typed is still there."); return false; }
      setEntries((es) => [row as Entry, ...es]);
      sfx.pop(); buzz(12);
      return true;
    });
  }

  async function scorePrediction(e: Entry, happened: boolean) {
    return guarded("score", async () => {
      const data = { ...e.data, result: happened, scored_on: todayStr() };
      const { error } = await supabase.from("reading_entries").update({ data, updated_at: new Date().toISOString() }).eq("id", e.id);
      if (error) { setErr("Couldn't save the score — try again."); return false; }
      setEntries((es) => es.map((x) => (x.id === e.id ? { ...x, data } : x)));
      return true;
    });
  }

  // finishing a book: active → done, next in line → active. Two writes, so
  // re-read the truth afterwards instead of trusting local state.
  const [confirmFinish, setConfirmFinish] = useState(false);
  async function finishBook() {
    if (!active) return;
    if (!confirmFinish) { setConfirmFinish(true); return; }
    setConfirmFinish(false);
    await guarded("finish", async () => {
      const d = todayStr();
      const a = await supabase.from("reading_books").update({ status: "done", finished_on: d }).eq("id", active.id);
      if (a.error) { setErr("Couldn't mark it finished — try again."); return false; }
      if (nextUp) {
        const n = await supabase.from("reading_books").update({ status: "active", started_on: d }).eq("id", nextUp.id);
        if (n.error) setErr(`Marked finished, but couldn't start ${nextUp.title}. Reload and tap it again.`);
      }
      sfx.fanfare(); buzz([20, 60, 20, 60, 40]);
      return true;
    });
    load();
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-24 mt-2" /><div className="skeleton h-40 mt-3" /></div>;
  if (loadErr) return <div className="pt-6"><button onClick={load} className="w-full rounded-xl bg-orange-500/15 text-orange-300 text-sm font-semibold py-3 active:scale-95">Couldn&apos;t load your reading — tap to retry</button></div>;

  const predictions = entries.filter((e) => e.kind === "predict").map((e) => ({ e, p: asPrediction(e) }));

  return (
    <div className="pt-3 pb-4">
      <div className="flex items-end justify-between mb-3">
        <h1 className="font-display text-2xl font-bold leading-none">Read</h1>
        <p className="text-[11px] mono opacity-50">{minutesToday}/{SLOT_MINUTES} min today · drill {drillToday ? "done" : "open"}</p>
      </div>

      {/* TODAY */}
      <Card tone={minutesToday >= SLOT_MINUTES && drillToday ? "neon" : "default"}>
        <Eyebrow className="mb-2">Today</Eyebrow>
        {active ? (
          <>
            <p className="text-xs opacity-50">Book {active.ord} of {books.length} · {active.author}</p>
            <p className="text-lg font-semibold leading-snug">{active.title}</p>
            <p className="text-[11px] opacity-50 mt-1">
              {readSlot ? `Read slot ${readSlot.start_t}–${readSlot.end_t}` : "No read slot today"}
              {drillSlot ? ` · drill ${drillSlot.start_t}–${drillSlot.end_t}` : ""}
            </p>

            <div className="flex items-center gap-4 mt-3">
              <ProgressCircle pct={(minutesToday + elapsed / 60) / SLOT_MINUTES} size={76} stroke={6}>
                <span className="mono text-sm">{timer ? mmss(elapsed) : `${minutesToday}m`}</span>
              </ProgressCircle>
              <div className="flex-1 min-w-0 space-y-2">
                {!timer ? (
                  <button onClick={startTimer} className={`${btn} w-full`}>Start 40 minutes</button>
                ) : (
                  <div className="flex gap-1.5">
                    <button onClick={stopTimer} disabled={!!saving} className={`${btn} flex-1`}>{saving === "session" ? "logging…" : `Done — log ${Math.max(1, Math.round(elapsed / 60))} min`}</button>
                    <button onClick={cancelTimer} disabled={!!saving} className={ghost}>cancel</button>
                  </div>
                )}
                <ManualMinutes onLog={(m) => logMinutes(m, active.id)} disabled={!!saving || !!timer} />
              </div>
            </div>
            <p className="text-[11px] opacity-45 mt-2.5">Desk or table, pen in hand. Time, not pages.</p>
            {late && (
              <p className="text-[11px] text-[var(--warn)] mt-1.5">
                It&apos;s late. The plan says not at night and not in bed, because you won&apos;t focus.
                {tomorrowRead ? ` Tomorrow's slot is ${tomorrowRead.start_t}.` : ""} If you already read today, log it anyway.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm opacity-60">All five done. The prediction journal and the swipe file keep running below.</p>
        )}
      </Card>

      {/* THE DRILL for the active book */}
      {active && drill && (
        <Card className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <Eyebrow>After reading: {DRILLS[drill].name}</Eyebrow>
            <span className={`text-[10px] mono ${drillToday ? "text-[var(--ok)]" : "opacity-45"}`}>
              {drillToday ? (DRILLS[drill].cadence === "weekly" ? "done this week" : "done today") : DRILLS[drill].cadence === "weekly" ? "this week" : "today"}
            </span>
          </div>
          <p className="text-[12px] opacity-60 mb-3 leading-relaxed">{DRILLS[drill].rule}</p>
          {drill === "apply" && <ApplyDrill entries={entries} saving={saving} onSave={(d) => addEntry("apply", d, active.id)} />}
          {drill === "feynman" && <FeynmanDrill entries={entries} saving={saving} onSave={(d) => addEntry("feynman", d, active.id)} />}
          {drill === "predict" && <p className="text-[12px] opacity-60">Use the journal below. Log a new prediction or score an old one to clear today.</p>}
          {drill === "layers" && <LayersDrill entries={entries} saving={saving} onSave={(d) => addEntry("layers", d, active.id)} />}
          {drill === "swipe" && <p className="text-[12px] opacity-60">Use the swipe file below.</p>}

          <div className="mt-4 pt-3 border-t border-[var(--border-1)] flex items-center justify-between gap-2">
            <p className="text-[11px] opacity-45 min-w-0">{nextUp ? `Next: ${nextUp.title}` : "This is the last book in the plan."}</p>
            <button onClick={finishBook} disabled={!!saving} className={ghost}>
              {confirmFinish ? "Tap again to confirm" : "Finished this book"}
            </button>
          </div>
        </Card>
      )}

      {/* PREDICTION JOURNAL — permanent */}
      <PredictionJournal list={predictions} today={today} saving={saving}
        bookId={books.find((b) => b.drill === "predict")?.id ?? null}
        onAdd={(d, bookId) => addEntry("predict", d, bookId)} onScore={scorePrediction} />

      {/* SWIPE FILE — Bryson runs in parallel as audio */}
      <SwipeFile entries={entries.filter((e) => e.kind === "swipe")} saving={saving} book={parallel}
        onAdd={(d) => addEntry("swipe", d, parallel?.id ?? null)} />

      {/* THE SHELF */}
      <Card className="mt-3">
        <Eyebrow className="mb-2">The five, in order</Eyebrow>
        <div className="space-y-1.5">
          {books.map((b) => {
            const mins = sessions.filter((s) => s.book_id === b.id).reduce((t, s) => t + s.minutes, 0);
            return (
              <div key={b.id} className="flex items-center gap-2.5 text-sm">
                <span className="mono text-xs opacity-40 w-4">{b.ord}</span>
                <span className={`flex-1 min-w-0 truncate ${b.status === "done" ? "opacity-40 line-through decoration-white/20" : ""}`}>{b.title}</span>
                <span className="text-[10px] mono opacity-50 shrink-0">
                  {b.status === "active" ? "reading" : b.status === "parallel" ? "audio, alongside" : b.status === "done" ? `done ${b.finished_on ?? ""}` : "queued"}
                  {mins > 0 ? ` · ${Math.round(mins / 6) / 10}h` : ""}
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      <DrillLogs entries={entries} />

      {err && <p className="text-xs text-orange-400 mt-3">{err}</p>}
    </div>
  );
}

function ManualMinutes({ onLog, disabled }: { onLog: (m: number) => Promise<boolean>; disabled: boolean }) {
  const [v, setV] = useState("");
  return (
    <div className="flex gap-1.5">
      <input inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, "").slice(0, 3))} disabled={disabled}
        placeholder="or type minutes read" className={`${input} py-1.5 text-xs`} />
      <button disabled={disabled || !v} onClick={async () => { if (await onLog(Number(v))) setV(""); }} className={ghost}>log</button>
    </div>
  );
}

// ── Influence ─────────────────────────────────────────────────────────────
function ApplyDrill({ entries, saving, onSave }: { entries: Entry[]; saving: string; onSave: (d: Record<string, unknown>) => Promise<boolean> }) {
  const [principle, setPrinciple] = useState("");
  const [tried, setTried] = useState("");
  const [worked, setWorked] = useState<"yes" | "partly" | "no" | "">("");
  const n = entries.filter((e) => e.kind === "apply").length;
  const pr = PRINCIPLES.find((p) => p.key === principle);
  async function save() {
    if (!principle || !tried.trim() || !worked) return;
    if (await onSave({ principle, tried: tried.trim().slice(0, 400), worked })) { setTried(""); setWorked(""); setPrinciple(""); }
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] mono opacity-55">{n}/{INFLUENCE_TARGET} attempts logged</p>
      <div className="flex flex-wrap gap-1.5">
        {PRINCIPLES.map((p) => (
          <button key={p.key} onClick={() => setPrinciple(p.key)}
            className={`text-[11px] px-2.5 py-1.5 rounded-lg border ${principle === p.key ? "bg-[var(--neon)] text-black border-transparent font-semibold" : "border-[var(--border-1)] opacity-70"}`}>{p.name}</button>
        ))}
      </div>
      {pr && <p className="text-[11px] opacity-55">{pr.name} (meaning: {pr.meaning})</p>}
      <textarea value={tried} onChange={(e) => setTried(e.target.value)} rows={2} placeholder="What I tried, on a situation that was already happening…" className={input} />
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] opacity-50 mr-1">Did it work?</span>
        {(["yes", "partly", "no"] as const).map((w) => (
          <button key={w} onClick={() => setWorked(w)}
            className={`text-[11px] px-2.5 py-1.5 rounded-lg border ${worked === w ? "bg-white/15 border-white/30 font-semibold" : "border-[var(--border-1)] opacity-60"}`}>{w}</button>
        ))}
        <button onClick={save} disabled={!!saving || !principle || !tried.trim() || !worked} className={`${btn} ml-auto py-1.5`}>{saving === "apply" ? "saving…" : "Log it"}</button>
      </div>
      {(!principle || !tried.trim() || !worked) && <p className="text-[10px] opacity-40">Pick a principle, write what you tried, and say whether it worked.</p>}
    </div>
  );
}

// ── Ascent of Money ───────────────────────────────────────────────────────
function FeynmanDrill({ entries, saving, onSave }: { entries: Entry[]; saving: string; onSave: (d: Record<string, unknown>) => Promise<boolean> }) {
  const [chapter, setChapter] = useState("");
  const [bullets, setBullets] = useState(["", "", "", "", ""]);
  const filled = bullets.map((b) => b.trim()).filter(Boolean);
  const buzzed = findBuzzwords(filled.join(" "));
  const n = entries.filter((e) => e.kind === "feynman").length;
  async function save() {
    if (!chapter.trim() || !filled.length) return;
    if (await onSave({ chapter: chapter.trim().slice(0, 120), bullets: filled.map((b) => b.slice(0, 300)), buzzwords: buzzed })) {
      setChapter(""); setBullets(["", "", "", "", ""]);
    }
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] mono opacity-55">{n} chapter{n === 1 ? "" : "s"} explained</p>
      <input value={chapter} onChange={(e) => setChapter(e.target.value)} placeholder="Chapter (e.g. 2: bonds)" className={input} />
      {bullets.map((b, i) => (
        <input key={i} value={b} onChange={(e) => setBullets((bs) => bs.map((x, j) => (j === i ? e.target.value : x)))}
          placeholder={i === 0 ? "How it works, like you're telling a 12-year-old…" : `bullet ${i + 1} (optional)`} className={input} />
      ))}
      {buzzed.length > 0 && (
        <p className="text-[11px] text-[var(--warn)]">
          Buzzword check: {buzzed.join(", ")}. Can you say it without {buzzed.length === 1 ? "that word" : "those words"}? If not, reread before moving on.
        </p>
      )}
      <button onClick={save} disabled={!!saving || !chapter.trim() || !filled.length} className={`${btn} w-full`}>{saving === "feynman" ? "saving…" : "Save the page (goes to How the World Works)"}</button>
    </div>
  );
}

// ── Behave ────────────────────────────────────────────────────────────────
function LayersDrill({ entries, saving, onSave }: { entries: Entry[]; saving: string; onSave: (d: Record<string, unknown>) => Promise<boolean> }) {
  const [behavior, setBehavior] = useState("");
  const [depth, setDepth] = useState(3);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const n = entries.filter((e) => e.kind === "layers").length;
  const shown = LAYERS.slice(0, depth);
  async function save() {
    if (!behavior.trim()) return;
    const layers = shown.map((l) => ({ key: l.key, text: (notes[l.key] ?? "").trim().slice(0, 600) })).filter((l) => l.text);
    if (!layers.length) return;
    if (await onSave({ behavior: behavior.trim().slice(0, 300), layers })) { setBehavior(""); setNotes({}); }
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] mono opacity-55">{n} behavior{n === 1 ? "" : "s"} drilled</p>
      <textarea value={behavior} onChange={(e) => setBehavior(e.target.value)} rows={2} placeholder="One real behavior you actually saw this week…" className={input} />
      <div className="flex items-center gap-2 text-[11px]">
        <span className="opacity-50">Layers read so far:</span>
        <button onClick={() => setDepth((d) => Math.max(1, d - 1))} className={ghost}>−</button>
        <span className="mono">{depth}</span>
        <button onClick={() => setDepth((d) => Math.min(LAYERS.length, d + 1))} className={ghost}>+</button>
      </div>
      {shown.map((l) => (
        <div key={l.key}>
          <p className="text-[11px] opacity-60">{l.name} <span className="opacity-60">({l.meaning})</span></p>
          <textarea value={notes[l.key] ?? ""} onChange={(e) => setNotes((m) => ({ ...m, [l.key]: e.target.value }))} rows={2} className={input} />
        </div>
      ))}
      <button onClick={save} disabled={!!saving || !behavior.trim()} className={`${btn} w-full`}>{saving === "layers" ? "saving…" : "Save the drill"}</button>
    </div>
  );
}

// ── Superforecasting (permanent) ─────────────────────────────────────────
function PredictionJournal({ list, today, saving, bookId, onAdd, onScore }: {
  list: { e: Entry; p: Prediction }[]; today: string; saving: string; bookId: string | null;
  onAdd: (d: Record<string, unknown>, bookId: string | null) => Promise<boolean>;
  onScore: (e: Entry, happened: boolean) => Promise<boolean>;
}) {
  const [outcome, setOutcome] = useState("");
  const [conf, setConf] = useState("");
  const [deadline, setDeadline] = useState("");
  const due = toScore(list, today);
  const open = list.filter(({ p }) => p.result == null && !(p.deadline && p.deadline < today));
  const scored = list.filter(({ p }) => typeof p.result === "boolean");
  const ps = list.map((x) => x.p);
  const b = brier(ps);
  const cal = calibration(ps);
  const isFirst = today.endsWith("-01");
  const c = Number(conf);
  const ok = outcome.trim() && conf && c >= 1 && c <= 99 && deadline && deadline >= today;
  async function add() {
    if (!ok) return;
    if (await onAdd({ outcome: outcome.trim().slice(0, 300), confidence: c, deadline, result: null }, bookId)) { setOutcome(""); setConf(""); setDeadline(""); }
  }
  return (
    <Card className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <Eyebrow>Prediction journal</Eyebrow>
        <span className="text-[10px] mono opacity-50">{list.length} made · {scored.length} scored</span>
      </div>
      <p className="text-[12px] opacity-60 mb-3 leading-relaxed">Starts before you open Superforecasting and never stops. Three lines each: the exact outcome, how sure you are (percent), a deadline. Scored on the 1st of every month.</p>

      {due.length > 0 && (
        <div className={`rounded-lg p-2.5 mb-3 ${isFirst ? "bg-[var(--neon)]/10 border border-[var(--neon)]/30" : "bg-white/[0.03] border border-[var(--border-1)]"}`}>
          <p className="text-[11px] font-semibold mb-1.5">{isFirst ? "Scoring day. " : ""}{due.length} past the deadline. Did it happen?</p>
          {due.map(({ e, p }) => (
            <div key={e.id} className="flex items-center gap-2 py-1">
              <span className="text-[12px] flex-1 min-w-0">{p.outcome} <span className="mono opacity-50">{p.confidence}% · by {p.deadline}</span></span>
              <button onClick={() => onScore(e, true)} disabled={!!saving} className={ghost}>happened</button>
              <button onClick={() => onScore(e, false)} disabled={!!saving} className={ghost}>didn&apos;t</button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5">
        <input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Exact outcome (e.g. I score 85+ on Precalc A2)" className={input} />
        <div className="flex gap-1.5">
          <input inputMode="numeric" value={conf} onChange={(e) => setConf(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="% sure" className={`${input} w-24`} />
          <input type="date" value={deadline} min={today} onChange={(e) => setDeadline(e.target.value)} className={`${input} flex-1`} />
          <button onClick={add} disabled={!!saving || !ok} className={btn}>{saving === "predict" ? "…" : "Add"}</button>
        </div>
        {!ok && (outcome || conf || deadline) && <p className="text-[10px] opacity-45">Needs all three: the outcome, a percent from 1 to 99, and a deadline today or later.</p>}
      </div>

      {open.length > 0 && (
        <div className="mt-3 space-y-1">
          <p className="text-[10px] uppercase tracking-widest opacity-40">Open</p>
          {open.slice(0, 12).map(({ e, p }) => (
            <div key={e.id} className="flex items-center gap-2 text-[12px]">
              <span className="flex-1 min-w-0 truncate">{p.outcome}</span>
              <span className="mono opacity-50 shrink-0">{p.confidence}% · {p.deadline}</span>
              <button onClick={() => onScore(e, true)} disabled={!!saving} className="text-[10px] opacity-50 underline">early yes</button>
            </div>
          ))}
        </div>
      )}

      {b !== null && (
        <div className="mt-3 pt-3 border-t border-[var(--border-1)]">
          <p className="text-[12px]"><span className="mono">Brier {b.toFixed(3)}</span> <span className="opacity-55">(how far your confidence was from what happened: 0 is perfect, 0.25 is what saying 50% on everything gets you, lower is better)</span></p>
          {cal.length > 0 && (
            <div className="mt-2 space-y-0.5">
              <p className="text-[10px] opacity-45">Calibration (when you said this sure, how often it actually happened):</p>
              {cal.map((r) => (
                <p key={r.band} className="text-[11px] mono opacity-70">{r.band}: said {r.said}%, happened {r.hit}% · {r.n}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Bryson ────────────────────────────────────────────────────────────────
function SwipeFile({ entries, saving, book, onAdd }: { entries: Entry[]; saving: string; book: Book | null; onAdd: (d: Record<string, unknown>) => Promise<boolean> }) {
  const [sentence, setSentence] = useState("");
  const [about, setAbout] = useState("");
  const [showAll, setShowAll] = useState(false);
  async function add() {
    if (!sentence.trim()) return;
    if (await onAdd({ sentence: sentence.trim().slice(0, 600), about: about.trim().slice(0, 200) })) { setSentence(""); setAbout(""); }
  }
  const shown = showAll ? entries : entries.slice(0, 5);
  return (
    <Card className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <Eyebrow>Swipe file{book ? ` · ${book.author}` : ""}</Eyebrow>
        <span className="text-[10px] mono opacity-50">{entries.length} saved</span>
      </div>
      <p className="text-[12px] opacity-60 mb-3 leading-relaxed">Bryson runs alongside as audio, in the car or at the gym. When a sentence makes something huge sound simple, save it and what it was explaining. Reread this before anything you have to write or say that matters.</p>
      <textarea value={sentence} onChange={(e) => setSentence(e.target.value)} rows={2} placeholder="The sentence…" className={input} />
      <div className="flex gap-1.5 mt-1.5">
        <input value={about} onChange={(e) => setAbout(e.target.value)} placeholder="What it was explaining" className={`${input} flex-1`} />
        <button onClick={add} disabled={!!saving || !sentence.trim()} className={btn}>{saving === "swipe" ? "…" : "Save"}</button>
      </div>
      {shown.length > 0 && (
        <div className="mt-3 space-y-2">
          {shown.map((e) => (
            <div key={e.id} className="border-l-2 border-[var(--neon)]/40 pl-2.5">
              <p className="text-[13px] leading-snug">{String(e.data.sentence ?? "")}</p>
              {e.data.about ? <p className="text-[10px] opacity-45 mt-0.5">on {String(e.data.about)}</p> : null}
            </div>
          ))}
          {entries.length > 5 && <button onClick={() => setShowAll((v) => !v)} className="text-[11px] opacity-50 underline">{showAll ? "show fewer" : `show all ${entries.length}`}</button>}
        </div>
      )}
    </Card>
  );
}

// ── what the drills add up to ─────────────────────────────────────────────
function DrillLogs({ entries }: { entries: Entry[] }) {
  const apply = entries.filter((e) => e.kind === "apply");
  const feyn = entries.filter((e) => e.kind === "feynman");
  const layers = entries.filter((e) => e.kind === "layers");
  const tally = influenceTally(entries).filter((r) => r.n > 0).sort((a, b) => b.worked / b.n - a.worked / a.n);
  if (!apply.length && !feyn.length && !layers.length) return null;
  return (
    <Card className="mt-3">
      <Eyebrow className="mb-2">What the drills add up to</Eyebrow>
      {tally.length > 0 && (
        <div className="mb-3">
          <p className="text-[11px] opacity-55 mb-1">Influence: which levers work on real people</p>
          {tally.map((r) => (
            <div key={r.key} className="flex items-center gap-2 text-[12px] py-0.5">
              <span className="flex-1">{r.name}</span>
              <span className="mono opacity-60">{r.worked} worked{r.partly ? ` · ${r.partly} partly` : ""} / {r.n}</span>
            </div>
          ))}
          <div className="mt-1.5 space-y-0.5">
            {apply.slice(0, 5).map((e) => (
              <p key={e.id} className="text-[11px] opacity-55 truncate">{e.day} · {PRINCIPLES.find((p) => p.key === e.data.principle)?.name ?? ""}: {String(e.data.tried ?? "")} ({String(e.data.worked ?? "")})</p>
            ))}
          </div>
        </div>
      )}
      {feyn.length > 0 && (
        <div className="mb-3">
          <p className="text-[11px] opacity-55 mb-1">How the World Works (your Feynman pages)</p>
          {feyn.slice(0, 6).map((e) => (
            <div key={e.id} className="mb-1.5">
              <p className="text-[12px] font-semibold">{String(e.data.chapter ?? "")}</p>
              {((e.data.bullets as string[]) ?? []).map((b, i) => <p key={i} className="text-[11px] opacity-70">· {b}</p>)}
            </div>
          ))}
        </div>
      )}
      {layers.length > 0 && (
        <div>
          <p className="text-[11px] opacity-55 mb-1">Layer drills</p>
          {layers.slice(0, 4).map((e) => (
            <div key={e.id} className="mb-1.5">
              <p className="text-[12px] font-semibold">{String(e.data.behavior ?? "")}</p>
              {((e.data.layers as { key: string; text: string }[]) ?? []).map((l) => (
                <p key={l.key} className="text-[11px] opacity-70">{LAYERS.find((x) => x.key === l.key)?.name}: {l.text}</p>
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
