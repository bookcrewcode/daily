"use client";

// 🗂️ THE CARD — the Fall 2026 GAME, digitized exactly as the paper spec.
//
// Ben's design brief, in his own words: his ADHD runs on pressure and thrill,
// so the menial must be BUNDLED — "the thrilling part will be completing the
// day as fast as possible." This screen is that: the Core Five as five fast
// taps, bonus as chips, streak and week band always visible, and the day
// "closes" with a hit when core reaches 5. No forms except the BookCrew rep
// log — which is deliberate, because his rulebook says no log = didn't happen.
//
// Paper stays boss: per rule 6 the app only replaces the index card after
// matching it for 7 straight days. This screen exists to earn that.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import {
  type GameDayRow, emptyDay, coreParts, coreCount, bonusCount, bonusBC, dayTotal,
  computeStreak, levelInfo, weekDays, weekBand, repPace, trunkOfDay, seasonDay,
  addDays, SEASON_START, SEASON_DAYS, REP_TARGET,
} from "@/lib/theGame";
import { burstConfetti } from "@/lib/confetti";
import { sfx, buzz } from "@/lib/fx";

type Rep = { id: string; who: string; place: string; note: string };
type Ev = { time: string; what: string };

const CORE_META = [
  { key: "R", label: "Rituals", hint: "Launch + Shutdown — both or no point" },
  { key: "B", label: "Body", hint: "gym day: train · rest day: clean eating + walk" },
  { key: "S", label: "School", hint: "one 30-min block on the priority course" },
  { key: "BC", label: "BookCrew", hint: "one rep a stranger can see — log it" },
  { key: "L", label: "Learn", hint: "one leaf, one line in your own words" },
] as const;

export default function TheCard({ uid, onGoTab }: { uid: string; onGoTab: (t: string) => void }) {
  const [days, setDays] = useState<GameDayRow[]>([]);
  const [repDays, setRepDays] = useState<string[]>([]);        // one entry per rep (its day)
  const [todayReps, setTodayReps] = useState<Rep[]>([]);
  const [blocks, setBlocks] = useState<Ev[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [saving, setSaving] = useState("");
  const [err, setErr] = useState("");

  // expanders
  const [repOpen, setRepOpen] = useState(false);
  const [learnOpen, setLearnOpen] = useState(false);

  // rep form
  const [rWho, setRWho] = useState("");
  const [rPlace, setRPlace] = useState("");
  const [rNote, setRNote] = useState("");
  const removingRep = useRef<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<string[]>([]);

  // learn line draft
  const [lineDraft, setLineDraft] = useState("");
  const lineTouched = useRef(false);

  // persisted per-day so a tab switch (which remounts this component) can't
  // replay the confetti and cheapen the real moment
  const celebrated = useRef<{ day: string; core5: boolean; ten: boolean }>({ day: "", core5: false, ten: false });
  const dayRef = useRef(todayStr());

  const load = useCallback(async () => {
    const today = todayStr();
    try {
      const [gd, reps, tr, cb, ni] = await Promise.all([
        supabase.from("game_days").select("day,r_launch,r_shutdown,b,s,bonus_uber,bonus_trading,bonus_dev,bonus_chess,frozen,learn_line").eq("user_id", uid).gte("day", SEASON_START),
        supabase.from("bc_reps").select("day").eq("user_id", uid).gte("day", SEASON_START),
        supabase.from("bc_reps").select("id,who,place,note").eq("user_id", uid).eq("day", today).order("created_at"),
        supabase.from("class_blocks").select("label,location,start_t").eq("user_id", uid).eq("weekday", new Date().getDay()).order("start_t"),
        supabase.from("nights").select("items").eq("user_id", uid).eq("day", today).maybeSingle(),
      ]);
      // a failed read must never look like an empty card — the streak number
      // has to be trustworthy or the whole game is dead
      if (gd.error || reps.error || tr.error) { setLoadErr(true); setLoaded(true); return; }
      setDays((gd.data ?? []) as GameDayRow[]);
      setRepDays(((reps.data ?? []) as { day: string }[]).map((r) => r.day));
      setTodayReps((tr.data ?? []) as Rep[]);
      const cls = (cb.error ? [] : ((cb.data ?? []) as { label: string; location: string; start_t: string }[]))
        .map((c) => ({ time: c.start_t, what: `${c.label}${c.location ? ` · ${c.location}` : ""}` }));
      const plan = (ni.error ? [] : ((ni.data?.items ?? []) as Ev[])).filter((x) => x?.what);
      setBlocks([...cls, ...plan].sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99")));
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  // midnight rollover: a card left open must flip to the new day
  useEffect(() => {
    const check = () => {
      const now = todayStr();
      if (now !== dayRef.current) {
        dayRef.current = now;
        setTodayReps([]); setRepOpen(false); setLearnOpen(false);
        setRWho(""); setRPlace(""); setRNote("");
        lineTouched.current = false; setLineDraft("");
        load();
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    const id = setInterval(check, 30000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);

  const today = todayStr();
  const rowsMap = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const repsByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of repDays) m.set(d, (m.get(d) ?? 0) + 1);
    return m;
  }, [repDays]);
  const row = rowsMap.get(today) ?? emptyDay(today);
  const repsToday = todayReps.length;
  const parts = coreParts(row, repsToday);
  const core = coreCount(row, repsToday);
  const bonus = bonusCount(row, repsToday);
  const total = dayTotal(row, repsToday);
  const streak = useMemo(() => computeStreak(rowsMap, repsByDay, today), [rowsMap, repsByDay, today]);
  const lvl = levelInfo(streak);
  const week = weekDays(today);
  const weekTotal = week.reduce((t, d) => {
    // a reps-only day has no game_days row — its points still count
    return t + dayTotal(rowsMap.get(d) ?? emptyDay(d), repsByDay.get(d) ?? 0);
  }, 0);
  const band = weekBand(weekTotal);
  const pace = repPace(repDays.length, today);
  const dayN = seasonDay(today);
  const hour = new Date().getHours();
  const nowT = `${String(hour).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`;
  const nextBlocks = blocks.filter((b) => b.time && b.time >= nowT).slice(0, 3);

  // sync the learn draft once per day from the server value
  useEffect(() => {
    if (!lineTouched.current) setLineDraft(row.learn_line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.learn_line]);

  // celebrations — once per day each, only on the transition
  useEffect(() => {
    const lsKey = `daily.card.fx.${today}`;
    if (celebrated.current.day !== today) {
      const stored = (typeof localStorage !== "undefined" ? localStorage.getItem(lsKey) : "") ?? "";
      celebrated.current = { day: today, core5: stored.includes("5"), ten: stored.includes("t") };
    }
    const persist = () => { try { localStorage.setItem(lsKey, `${celebrated.current.core5 ? "5" : ""}${celebrated.current.ten ? "t" : ""}`); } catch { /* private mode */ } };
    if (core === 5 && !celebrated.current.core5) { celebrated.current.core5 = true; persist(); burstConfetti("small"); sfx.coin(); buzz([20, 30, 20]); }
    if (total >= 10 && !celebrated.current.ten) { celebrated.current.ten = true; persist(); burstConfetti("big"); sfx.levelup(); }
  }, [core, total, today]);

  // ── writes (write-first, guarded, honest) ─────────────────────────────────
  // Every write re-checks the wall clock against the day it is about to write.
  // In the 0-30s window after midnight (before the rollover interval fires) a
  // tap would otherwise land on YESTERDAY's row — silently rewriting history.
  function dayRolled(): boolean {
    if (todayStr() === today) return false;
    setErr("Midnight — the card just rolled to the new day. Tap again.");
    dayRef.current = todayStr();
    setTodayReps([]); setRepOpen(false); setLearnOpen(false);
    setRWho(""); setRPlace(""); setRNote("");
    lineTouched.current = false; setLineDraft("");
    load();
    return true;
  }

  async function patch(fields: Partial<GameDayRow>, key: string): Promise<boolean> {
    if (saving || dayRolled()) return false;
    setSaving(key); setErr("");
    try {
      const next = { ...row, ...fields };
      const { error } = await supabase.from("game_days").upsert({
        user_id: uid, day: today,
        r_launch: next.r_launch, r_shutdown: next.r_shutdown, b: next.b, s: next.s,
        bonus_uber: next.bonus_uber, bonus_trading: next.bonus_trading,
        bonus_dev: next.bonus_dev, bonus_chess: next.bonus_chess,
        frozen: next.frozen, learn_line: next.learn_line,
      }, { onConflict: "user_id,day" });
      if (error) { setErr("Couldn't save that — try again."); return false; }
      setDays((ds) => {
        const others = ds.filter((d) => d.day !== today);
        return [...others, next];
      });
      sfx.pop();
      return true;
    } catch { setErr("Couldn't reach the server — nothing saved."); return false; }
    finally { setSaving(""); }
  }

  async function patchDay(day: string, fields: Partial<GameDayRow>, key: string) {
    if (saving || dayRolled()) return;
    setSaving(key); setErr("");
    try {
      const base = rowsMap.get(day) ?? emptyDay(day);
      const next = { ...base, ...fields };
      const { error } = await supabase.from("game_days").upsert({
        user_id: uid, day,
        r_launch: next.r_launch, r_shutdown: next.r_shutdown, b: next.b, s: next.s,
        bonus_uber: next.bonus_uber, bonus_trading: next.bonus_trading,
        bonus_dev: next.bonus_dev, bonus_chess: next.bonus_chess,
        frozen: next.frozen, learn_line: next.learn_line,
      }, { onConflict: "user_id,day" });
      if (error) { setErr("Couldn't save that — try again."); return; }
      setDays((ds) => [...ds.filter((d) => d.day !== day), next]);
      sfx.pop();
    } catch { setErr("Couldn't reach the server — nothing saved."); }
    finally { setSaving(""); }
  }

  async function addRep() {
    const who = rWho.trim();
    if (!who || saving || dayRolled()) return;
    setSaving("rep"); setErr("");
    try {
      const { data, error } = await supabase.from("bc_reps")
        .insert({ user_id: uid, day: today, who: who.slice(0, 120), place: rPlace.trim().slice(0, 120), note: rNote.trim().slice(0, 400) })
        .select("id,who,place,note").single();
      if (error || !data) { setErr("Couldn't log that rep — it's still here, try again."); return; }
      setTodayReps((r) => [...r, data as Rep]);
      setRepDays((r) => [...r, today]);
      setRWho(""); setRPlace(""); setRNote("");
      sfx.coin(); buzz(15);
    } catch { setErr("Couldn't reach the server — the rep is still here, try again."); }
    finally { setSaving(""); }
  }

  async function deleteRep(id: string) {
    if (removingRep.current.has(id)) return;
    removingRep.current.add(id);
    setRemovingIds([...removingRep.current]);
    try {
      const { error } = await supabase.from("bc_reps").delete().eq("id", id);
      if (error) { setErr("Couldn't remove that rep."); return; }
      setTodayReps((r) => r.filter((x) => x.id !== id));
      setRepDays((r) => { const i = r.indexOf(today); return i >= 0 ? [...r.slice(0, i), ...r.slice(i + 1)] : r; });
    } catch { setErr("Couldn't reach the server — that rep is still logged."); }
    finally {
      removingRep.current.delete(id);
      setRemovingIds([...removingRep.current]);
    }
  }

  async function saveLine() {
    const line = lineDraft.trim().slice(0, 400);
    const ok = await patch({ learn_line: line }, "L");
    if (ok && line) setLearnOpen(false);   // a failed save keeps the editor (and the line) open
  }

  // 🎧 commute-audio days: one tap must actually SCORE the point, not just
  // fill the draft and let him believe it saved.
  async function saveAudio() {
    lineTouched.current = true;
    setLineDraft("🎧 commute audio");
    const ok = await patch({ learn_line: "🎧 commute audio" }, "L");
    if (ok) setLearnOpen(false);
  }

  // freeze: declared the NIGHT BEFORE, for tomorrow only, max one per week
  const tomorrow = addDays(today, 1);
  const tomorrowRow = rowsMap.get(tomorrow);
  const tomorrowFrozen = !!tomorrowRow?.frozen;
  const frozenUsedInTomorrowWeek = weekDays(tomorrow).some((d) => d !== tomorrow && rowsMap.get(d)?.frozen);

  if (!loaded) return <div className="pt-3"><div className="skeleton h-40 mt-2" /><div className="skeleton h-24 mt-3" /></div>;
  if (loadErr) return (
    <div className="pt-6">
      <button onClick={load} className="w-full rounded-xl bg-orange-500/15 text-orange-300 text-sm font-semibold py-3 active:scale-95">
        Couldn&apos;t load the card — tap to retry. (The streak number is never guessed.)
      </button>
    </div>
  );

  const inSeason = dayN >= 1 && dayN <= SEASON_DAYS;

  return (
    <div className="pt-3">
      {/* header: season day · streak · level */}
      <div className="flex items-end justify-between mb-3">
        <div>
          <h1 className="font-display text-2xl font-bold leading-none">The Card</h1>
          <p className="text-[11px] opacity-45 mt-1">
            {inSeason ? `Day ${dayN} of ${SEASON_DAYS}` : dayN < 1 ? "Pre-season" : "Season complete"} · wk {band.name.toLowerCase()} {weekTotal}/70
            {lvl.next ? ` · ${lvl.next.togo}d to ${lvl.next.name}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="font-display text-2xl font-black leading-none text-orange-300">🔥{streak}</p>
          <p className="text-[9px] uppercase tracking-widest opacity-40 mt-0.5">{lvl.name ?? "streak"}</p>
        </div>
      </div>

      {row.frozen ? (
        <div className="rounded-2xl border border-sky-400/40 bg-sky-500/10 p-4 text-center">
          <p className="font-semibold">Freeze day — declared last night.</p>
          <p className="text-xs opacity-60 mt-1">Scores 0, streak survives. No audit, no guilt. Back tomorrow.</p>
        </div>
      ) : (
        <>
          {/* today's score */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-baseline justify-between mb-3">
              <p className="text-[10px] uppercase tracking-[0.2em] opacity-45">Core five</p>
              <p className="font-display font-black text-xl tabular-nums">
                <span className={core >= 3 ? "text-[var(--neon)]" : ""}>{core}/5</span>
                <span className="text-sm opacity-50"> +{bonus} = {total}</span>
              </p>
            </div>

            <div className="space-y-2">
              {/* R — two halves, both or no point */}
              <div className={`rounded-xl border px-3 py-2.5 ${parts.r ? "bg-[var(--neon)]/10 border-[var(--neon)]/40" : "bg-white/[0.03] border-white/10"}`}>
                <div className="flex items-center gap-2">
                  <span className={`w-6 h-6 rounded-full grid place-items-center text-xs font-black shrink-0 ${parts.r ? "bg-[var(--neon)] text-black" : "bg-white/10"}`}>R</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Rituals</p>
                    <p className="text-[10px] opacity-45">both or no point</p>
                  </div>
                  <button onClick={() => patch({ r_launch: !row.r_launch }, "rl")} disabled={!!saving}
                    className={`px-3 py-2 rounded-lg text-xs font-bold active:scale-95 disabled:opacity-50 ${row.r_launch ? "bg-[var(--neon)] text-black" : "bg-white/10"}`}>
                    Launch
                  </button>
                  <button onClick={() => patch({ r_shutdown: !row.r_shutdown }, "rs")} disabled={!!saving}
                    className={`px-3 py-2 rounded-lg text-xs font-bold active:scale-95 disabled:opacity-50 ${row.r_shutdown ? "bg-[var(--neon)] text-black" : "bg-white/10"}`}>
                    Shutdown
                  </button>
                </div>
              </div>

              {/* B and S — single taps */}
              {([["B", "Body", "b", row.b, CORE_META[1].hint], ["S", "School", "s", row.s, CORE_META[2].hint]] as const).map(([k, label, field, val, hint]) => (
                <button key={k} onClick={() => patch({ [field]: !val } as Partial<GameDayRow>, k)} disabled={!!saving}
                  className={`w-full rounded-xl border px-3 py-2.5 flex items-center gap-2 active:scale-[0.99] disabled:opacity-60 ${val ? "bg-[var(--neon)]/10 border-[var(--neon)]/40" : "bg-white/[0.03] border-white/10"}`}>
                  <span className={`w-6 h-6 rounded-full grid place-items-center text-xs font-black shrink-0 ${val ? "bg-[var(--neon)] text-black" : "bg-white/10"}`}>{k}</span>
                  <div className="min-w-0 flex-1 text-left">
                    <p className="text-sm font-semibold">{label}</p>
                    <p className="text-[10px] opacity-45">{hint}</p>
                  </div>
                  {val && <span className="text-[var(--neon)] font-black">✓</span>}
                </button>
              ))}

              {/* BC — derived from the rep log. No log = didn't happen. */}
              <div className={`rounded-xl border px-3 py-2.5 ${parts.bc ? "bg-[var(--neon)]/10 border-[var(--neon)]/40" : "bg-white/[0.03] border-white/10"}`}>
                <button onClick={() => setRepOpen((v) => !v)} className="w-full flex items-center gap-2 text-left">
                  <span className={`w-6 h-6 rounded-full grid place-items-center text-[10px] font-black shrink-0 ${parts.bc ? "bg-[var(--neon)] text-black" : "bg-white/10"}`}>BC</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">BookCrew {repsToday > 0 && <span className="opacity-60">· {repsToday} rep{repsToday === 1 ? "" : "s"}</span>}</p>
                    <p className="text-[10px] opacity-45">{repsToday === 0 ? "one rep a stranger can see — log it" : `season: ${pace.total} of ${REP_TARGET} · pace → ~${pace.projected}`}</p>
                  </div>
                  <span className="text-xs opacity-50">{repOpen ? "▴" : "＋ rep"}</span>
                </button>
                {repOpen && (
                  <div className="mt-2.5 space-y-1.5">
                    {todayReps.map((r) => (
                      <div key={r.id} className="flex items-center gap-2 rounded-lg bg-black/25 px-2.5 py-1.5">
                        <p className="text-xs flex-1 min-w-0 truncate">{r.who}{r.place ? ` @ ${r.place}` : ""}{r.note ? ` — ${r.note}` : ""}</p>
                        <button onClick={() => deleteRep(r.id)} disabled={removingIds.includes(r.id)} className="opacity-30 text-xs active:scale-90 disabled:opacity-10">✕</button>
                      </div>
                    ))}
                    <div className="grid grid-cols-2 gap-1.5">
                      <input value={rWho} onChange={(e) => setRWho(e.target.value)} disabled={saving === "rep"} placeholder="who"
                        className="rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
                      <input value={rPlace} onChange={(e) => setRPlace(e.target.value)} disabled={saving === "rep"} placeholder="where"
                        className="rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
                    </div>
                    <input value={rNote} onChange={(e) => setRNote(e.target.value)} disabled={saving === "rep"}
                      onKeyDown={(e) => { if (e.key === "Enter") addRep(); }}
                      placeholder="what they said · next step" className="w-full rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
                    <button onClick={addRep} disabled={!!saving || !rWho.trim()}
                      className="w-full rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-40">
                      {saving === "rep" ? "logging…" : "Log the rep"}
                    </button>
                  </div>
                )}
              </div>

              {/* L — the one line in his own words IS the point */}
              <div className={`rounded-xl border px-3 py-2.5 ${parts.l ? "bg-[var(--neon)]/10 border-[var(--neon)]/40" : "bg-white/[0.03] border-white/10"}`}>
                <button onClick={() => setLearnOpen((v) => !v)} className="w-full flex items-center gap-2 text-left">
                  <span className={`w-6 h-6 rounded-full grid place-items-center text-xs font-black shrink-0 ${parts.l ? "bg-[var(--neon)] text-black" : "bg-white/10"}`}>L</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Learn <span className="opacity-50 font-normal">· {trunkOfDay(today)}</span></p>
                    <p className="text-[10px] opacity-45 truncate">{parts.l ? row.learn_line : "one leaf, one line in your own words"}</p>
                  </div>
                  <span className="text-xs opacity-50">{learnOpen ? "▴" : parts.l ? "edit" : "＋ line"}</span>
                </button>
                {learnOpen && (
                  <div className="mt-2.5">
                    <textarea value={lineDraft} onChange={(e) => { lineTouched.current = true; setLineDraft(e.target.value); }} rows={2} disabled={saving === "L"}
                      placeholder="the line that proves it stuck — your words, not the book's"
                      className="w-full rounded-lg bg-black/30 px-3 py-2 outline-none text-sm resize-none" />
                    <div className="flex gap-2 mt-1.5">
                      <button onClick={saveLine} disabled={!!saving} className="flex-1 rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-40">
                        {saving === "L" ? "saving…" : "Save the line"}
                      </button>
                      <button onClick={saveAudio} disabled={!!saving}
                        className="rounded-lg bg-white/10 text-xs font-semibold px-3 active:scale-95" title="NotebookLM audio on the commute counts on driving days — one tap scores it">🎧</button>
                    </div>
                    <button onClick={() => onGoTab("learning")} className="text-[10px] opacity-40 underline mt-1.5">open the study room →</button>
                  </div>
                )}
              </div>
            </div>

            {/* MVD net — evenings only, when the streak is actually at risk */}
            {hour >= 17 && core < 3 && (
              <p className="text-[11px] text-orange-300/90 mt-3">
                MVD fallback: ~90 min. Rituals + any two others = the streak survives. Don&apos;t negotiate past that.
              </p>
            )}
          </div>

          {/* bonus chips */}
          <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
            <p className="text-[10px] uppercase tracking-[0.2em] opacity-45 mb-2">Bonus · +{bonus} of 5 max</p>
            <div className="flex flex-wrap gap-1.5">
              <span className={`px-3 py-2 rounded-lg text-xs font-semibold ${bonusBC(repsToday) > 0 ? "bg-[var(--neon)]/15 text-[var(--neon)] border border-[var(--neon)]/40" : "bg-white/5 opacity-45 border border-white/10"}`}>
                reps +{bonusBC(repsToday)}
              </span>
              <button onClick={() => patch({ bonus_uber: !row.bonus_uber }, "bu")} disabled={!!saving || (repsToday === 0 && !row.bonus_uber)}
                title={repsToday === 0 ? "Reps before rides — log the day's first BC rep first" : ""}
                className={`px-3 py-2 rounded-lg text-xs font-semibold active:scale-95 border disabled:opacity-35 ${row.bonus_uber ? "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40" : "bg-white/5 border-white/10"}`}>
                Uber
              </button>
              <button onClick={() => patch({ bonus_trading: !row.bonus_trading }, "bt")} disabled={!!saving}
                className={`px-3 py-2 rounded-lg text-xs font-semibold active:scale-95 border ${row.bonus_trading ? "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40" : "bg-white/5 border-white/10"}`}>
                Rules 100%
              </button>
              <button onClick={() => patch({ bonus_dev: !row.bonus_dev }, "bd")} disabled={!!saving}
                className={`px-3 py-2 rounded-lg text-xs font-semibold active:scale-95 border ${row.bonus_dev ? "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40" : "bg-white/5 border-white/10"}`}>
                Shipped
              </button>
              <button onClick={() => patch({ bonus_chess: !row.bonus_chess }, "bx")} disabled={!!saving}
                className={`px-3 py-2 rounded-lg text-xs font-semibold active:scale-95 border ${row.bonus_chess ? "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40" : "bg-white/5 border-white/10"}`}>
                Chess
              </button>
            </div>
            <p className="text-[10px] opacity-35 mt-2">Uber only counts after the day&apos;s first rep · trading point is discipline, not P&amp;L · &quot;worked on&quot; ≠ shipped.</p>
          </div>
        </>
      )}

      {/* week strip */}
      <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-45">This week</p>
          <p className="text-xs font-bold" style={{ color: band.hue }}>{band.name} · {weekTotal}/70</p>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {week.map((d) => {
            const r = rowsMap.get(d) ?? emptyDay(d);
            const t = dayTotal(r, repsByDay.get(d) ?? 0);
            const c = coreCount(r, repsByDay.get(d) ?? 0);
            const isToday = d === today;
            const future = d > today;
            return (
              <div key={d} className={`rounded-lg py-1.5 text-center border ${isToday ? "border-[var(--neon)]/50 bg-[var(--neon)]/10" : "border-white/8 bg-white/[0.02]"} ${future ? "opacity-30" : ""}`}>
                <p className="text-[9px] opacity-45">{["S", "M", "T", "W", "T", "F", "S"][new Date(d + "T00:00:00").getDay()]}</p>
                {r.frozen ? <p className="text-xs">❄️</p> : (
                  <p className={`text-sm font-bold tabular-nums ${c >= 5 ? "text-[#34d399]" : c >= 3 ? "text-[var(--neon)]" : t > 0 ? "" : "opacity-25"}`}>{future ? "·" : t}</p>
                )}
              </div>
            );
          })}
        </div>
        {/* freeze declare — tonight, for tomorrow, max one a week */}
        {!tomorrowFrozen && !frozenUsedInTomorrowWeek && (
          <button onClick={() => patchDay(tomorrow, { frozen: true }, "fz")} disabled={!!saving}
            className="text-[10px] opacity-40 underline mt-2 active:scale-95">Declare tomorrow a freeze day (exam · sick · travel)</button>
        )}
        {tomorrowFrozen && (
          <p className="text-[10px] opacity-50 mt-2">Tomorrow is frozen — streak survives, scores 0.{" "}
            <button onClick={() => patchDay(tomorrow, { frozen: false }, "fz")} disabled={!!saving} className="underline">undo</button>
          </p>
        )}
      </div>

      {/* next blocks — the 12:30 / 4:00 question: what's the next block? */}
      {nextBlocks.length > 0 && (
        <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-45 mb-1.5">Next block</p>
          {nextBlocks.map((b, i) => (
            <div key={i} className="flex gap-3 text-sm py-0.5">
              <span className="tabular-nums opacity-45 w-11 shrink-0">{b.time}</span>
              <span className="opacity-85">{b.what}</span>
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
      <p className="text-[10px] opacity-30 mt-3 text-center">Paper is boss until this matches the card 7 straight days. Score both at Shutdown.</p>
    </div>
  );
}
