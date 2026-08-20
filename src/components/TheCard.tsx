"use client";

// 🗂️ THE CARD — the Fall 2026 GAME as a timing instrument, not a checklist.
//
// Ben's design brief, in his own words: his ADHD runs on pressure and thrill —
// "the thrilling part will be completing the day as fast as possible." So v3
// borrows LiveSplit's grammar with HONEST clocks: every core part stamps the
// wall-clock moment it locked in, the day "closes" when core hits 5, and the
// only opponents are the PB stamps and yesterday's ghost. No fake timers.
//
// Scoring rules are unchanged from the paper spec (see lib/theGame.ts).
// Paper stays boss: per rule 6 the app only replaces the index card after
// matching it for 7 straight days. This screen exists to earn that.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import {
  type GameDayRow, type SplitKey, type Splits, SPLIT_KEYS,
  emptyDay, coreParts, coreCount, bonusCount, bonusBC, dayTotal,
  computeStreak, levelInfo, weekDays, weekBand, weekStart, repPace, trunkOfDay, seasonDay,
  addDays, diffDays, secOfDay, fmtClock, fmtDelta, fmtDur, partBests,
  SEASON_START, SEASON_END, SEASON_DAYS, REP_TARGET, WEEK_LABELS,
} from "@/lib/theGame";
import { burstConfetti } from "@/lib/confetti";
import { sfx, buzz } from "@/lib/fx";
import { Num, Eyebrow, SegRing, ProgressCircle } from "./ui";

type Rep = { id: string; who: string; place: string; note: string };
type Ev = { time: string; what: string };

const GD_COLS = "day,r_launch,r_shutdown,b,s,bonus_uber,bonus_trading,bonus_dev,bonus_chess,frozen,learn_line,splits";

// per-day celebration store (localStorage) — JSON now; old builds wrote "5t".
// A module-scope fallback keeps replays suppressed for the app session even
// when localStorage is unavailable (private mode / quota).
type FxStore = { c5: boolean; ten: boolean; gold: SplitKey[] };
const fxMem = new Map<string, FxStore>();
function readFx(day: string): FxStore {
  try {
    const raw = localStorage.getItem(`daily.card.fx.${day}`);
    if (raw == null) return fxMem.get(day) ?? { c5: false, ten: false, gold: [] };
    if (raw.startsWith("{")) return { c5: false, ten: false, gold: [], ...JSON.parse(raw) };
    return { c5: raw.includes("5"), ten: raw.includes("t"), gold: [] };
  } catch { return fxMem.get(day) ?? { c5: false, ten: false, gold: [] }; }
}
function writeFx(day: string, fx: FxStore) {
  fxMem.set(day, { ...fx });
  try { localStorage.setItem(`daily.card.fx.${day}`, JSON.stringify(fx)); } catch { /* fxMem covers the session */ }
}

export default function TheCard({ uid, onGoTab }: { uid: string; onGoTab: (t: string) => void }) {
  const [days, setDays] = useState<GameDayRow[]>([]);
  const [repDays, setRepDays] = useState<string[]>([]);        // one entry per rep (its day)
  const [todayReps, setTodayReps] = useState<Rep[]>([]);
  const [blocks, setBlocks] = useState<Ev[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [saving, setSaving] = useState("");
  const [err, setErr] = useState("");
  const [takeover, setTakeover] = useState(false);
  const [nowSec, setNowSec] = useState(() => secOfDay());

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
  const fxRef = useRef<{ day: string; fx: FxStore }>({ day: "", fx: { c5: false, ten: false, gold: [] } });
  const dayRef = useRef(todayStr());

  // Every write to `days` goes through commitDays so an in-flight async writer
  // can read the FRESH rows from daysRef — a render closure can be a whole
  // write cycle stale by the time a network call resolves.
  const daysRef = useRef<GameDayRow[]>([]);
  const commitDays = useCallback((updater: (ds: GameDayRow[]) => GameDayRow[]) => {
    daysRef.current = updater(daysRef.current);
    setDays(daysRef.current);
  }, []);

  const load = useCallback(async () => {
    const today = todayStr();
    try {
      const [gd, reps, tr, cb, ni] = await Promise.all([
        supabase.from("game_days").select(GD_COLS).eq("user_id", uid).gte("day", SEASON_START),
        supabase.from("bc_reps").select("day").eq("user_id", uid).gte("day", SEASON_START),
        supabase.from("bc_reps").select("id,who,place,note").eq("user_id", uid).eq("day", today).order("created_at"),
        supabase.from("class_blocks").select("label,location,start_t").eq("user_id", uid).eq("weekday", new Date().getDay()).order("start_t"),
        supabase.from("nights").select("items").eq("user_id", uid).eq("day", today).maybeSingle(),
      ]);
      // a failed read must never look like an empty card — the streak number
      // has to be trustworthy or the whole game is dead
      if (gd.error || reps.error || tr.error) { setLoadErr(true); setLoaded(true); return; }
      commitDays(() => ((gd.data ?? []) as GameDayRow[]).map((d) => ({ ...d, splits: d.splits ?? {} })));
      setRepDays(((reps.data ?? []) as { day: string }[]).map((r) => r.day));
      setTodayReps((tr.data ?? []) as Rep[]);
      const cls = (cb.error ? [] : ((cb.data ?? []) as { label: string; location: string; start_t: string }[]))
        .map((c) => ({ time: c.start_t, what: `${c.label}${c.location ? ` · ${c.location}` : ""}` }));
      const plan = (ni.error ? [] : ((ni.data?.items ?? []) as Ev[])).filter((x) => x?.what);
      setBlocks([...cls, ...plan].sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99")));
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid, commitDays]);
  useEffect(() => { load(); }, [load]);

  // midnight rollover: a card left open must flip to the new day.
  // The same interval keeps the live clock (pace line / countdowns) honest.
  useEffect(() => {
    const check = () => {
      setNowSec(secOfDay());
      const now = todayStr();
      if (now !== dayRef.current) {
        dayRef.current = now;
        setTodayReps([]); setRepOpen(false); setLearnOpen(false); setTakeover(false);
        setRWho(""); setRPlace(""); setRNote("");
        lineTouched.current = false; setLineDraft("");
        load();
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    const id = setInterval(check, 15000);
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
  const ydRow = rowsMap.get(addDays(today, -1));
  const repsToday = todayReps.length;
  const parts = coreParts(row, repsToday);
  const core = coreCount(row, repsToday);
  const bonus = bonusCount(row, repsToday);
  const total = dayTotal(row, repsToday);
  const streak = useMemo(() => computeStreak(rowsMap, repsByDay, today), [rowsMap, repsByDay, today]);
  const lvl = levelInfo(streak);
  const week = weekDays(today);
  const weekTotal = week.reduce((t, d) => {
    // a reps-only day has no game_days row — its points still count.
    // Off-season days never do (the strip renders them neutral; the header
    // must agree with it).
    if (diffDays(SEASON_START, d) < 1 || d > SEASON_END) return t;
    return t + dayTotal(rowsMap.get(d) ?? emptyDay(d), repsByDay.get(d) ?? 0);
  }, 0);
  const band = weekBand(weekTotal);
  const pace = repPace(repDays.length, today);
  const dayN = seasonDay(today);
  const hour = new Date().getHours();
  const nowT = `${String(hour).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`;
  const nextBlocks = blocks.filter((b) => b.time && b.time >= nowT).slice(0, 3);
  const weekLabel = WEEK_LABELS[weekStart(today)];

  // PBs exclude today (still in progress) and frozen days
  const pbs = useMemo(() => partBests(days, today), [days, today]);
  const closedSec = row.splits?.closed;

  // sync the learn draft once per day from the server value
  useEffect(() => {
    if (!lineTouched.current) setLineDraft(row.learn_line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.learn_line]);

  // celebrations — once per day each, only on the transition.
  // Confetti policy (v3): gold split = micro, card closed = small; that's it here.
  useEffect(() => {
    if (fxRef.current.day !== today) fxRef.current = { day: today, fx: readFx(today) };
    const fx = fxRef.current.fx;
    let changed = false;

    // gold splits: a stamp strictly earlier than the season PB for that part
    for (const k of SPLIT_KEYS) {
      const s = row.splits?.[k];
      const pb = pbs[k];
      if (typeof s === "number" && typeof pb === "number" && s < pb && !fx.gold.includes(k)) {
        fx.gold = [...fx.gold, k]; changed = true;
        burstConfetti("micro"); sfx.pr(); buzz(10);
      }
    }
    if (core === 5 && !fx.c5) {
      fx.c5 = true; changed = true;
      burstConfetti("small"); sfx.fanfare(); buzz([20, 30, 20]);
      setTakeover(true);
    }
    if (total >= 10 && !fx.ten) { fx.ten = true; changed = true; sfx.levelup(); }
    if (changed) writeFx(today, fx);
  }, [core, total, today, row.splits, pbs]);

  // takeover auto-dismisses — it's a moment, not a modal to manage
  useEffect(() => {
    if (!takeover) return;
    const t = setTimeout(() => setTakeover(false), 4000);
    return () => clearTimeout(t);
  }, [takeover]);

  // ── writes (write-first, guarded, honest) ─────────────────────────────────
  // Every write re-checks the wall clock against the day it is about to write.
  // In the 0-30s window after midnight (before the rollover interval fires) a
  // tap would otherwise land on YESTERDAY's row — silently rewriting history.
  function dayRolled(): boolean {
    if (todayStr() === today) return false;
    setErr("Midnight — the card just rolled to the new day. Tap again.");
    dayRef.current = todayStr();
    setTodayReps([]); setRepOpen(false); setLearnOpen(false); setTakeover(false);
    setRWho(""); setRPlace(""); setRNote("");
    lineTouched.current = false; setLineDraft("");
    load();
    return true;
  }

  // Stamp maintenance for a change to TODAY's row: a part that just locked in
  // gets the current wall clock; a part that un-locked loses its stamp (honest
  // data or no data). "closed" exists iff core is 5 right now.
  function withStamps(next: GameDayRow, reps: number): GameDayRow {
    const before = coreParts(row, reps);
    const after = coreParts(next, reps);
    const sp: Splits = { ...(next.splits ?? {}) };
    for (const k of SPLIT_KEYS) {
      if (!before[k] && after[k] && sp[k] == null) sp[k] = secOfDay();
      if (before[k] && !after[k]) delete sp[k];
    }
    if (coreCount(next, reps) === 5) { if (sp.closed == null) sp.closed = secOfDay(); }
    else delete sp.closed;
    return { ...next, splits: sp };
  }

  function upsertPayload(d: GameDayRow, day: string) {
    return {
      user_id: uid, day,
      r_launch: d.r_launch, r_shutdown: d.r_shutdown, b: d.b, s: d.s,
      bonus_uber: d.bonus_uber, bonus_trading: d.bonus_trading,
      bonus_dev: d.bonus_dev, bonus_chess: d.bonus_chess,
      frozen: d.frozen, learn_line: d.learn_line, splits: d.splits ?? {},
    };
  }

  async function patch(fields: Partial<GameDayRow>, key: string): Promise<boolean> {
    if (saving || dayRolled()) return false;
    setSaving(key); setErr("");
    try {
      const next = withStamps({ ...row, ...fields }, repsToday);
      const { error } = await supabase.from("game_days").upsert(upsertPayload(next, today), { onConflict: "user_id,day" });
      if (error) { setErr("Couldn't save that — try again."); return false; }
      commitDays((ds) => [...ds.filter((d) => d.day !== today), next]);
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
      const { error } = await supabase.from("game_days").upsert(upsertPayload(next, day), { onConflict: "user_id,day" });
      if (error) { setErr("Couldn't save that — try again."); return; }
      commitDays((ds) => [...ds.filter((d) => d.day !== day), next]);
      sfx.pop();
    } catch { setErr("Couldn't reach the server — nothing saved."); }
    finally { setSaving(""); }
  }

  // BC stamps ride a quiet secondary write (the rep insert is the scoring
  // truth; the stamp is telemetry). One retry, then let it go — the rep is
  // never blocked or rolled back over a stamp. THREE guards learned the hard
  // way: (1) `at` and `day` are captured at TAP time, so a rep whose insert
  // resolves after midnight can't stamp yesterday with a ~0:00 clock and
  // poison every season PB; (2) if the day rolled while the rep was in
  // flight, the stamp is dropped entirely; (3) the base row comes from
  // daysRef (fresh), never a render closure that a concurrent write outdated.
  async function stampAfterReps(nextReps: number, at: number, day: string) {
    // after a midnight roll, removals may still land (they only make the data
    // MORE honest) but fresh stamps never do
    const rolled = todayStr() !== day;
    const cur = daysRef.current.find((d) => d.day === day) ?? emptyDay(day);
    const sp: Splits = { ...(cur.splits ?? {}) };
    if (!rolled && nextReps >= 1 && sp.bc == null) sp.bc = at;
    if (nextReps === 0) delete sp.bc;
    if (coreCount(cur, nextReps) === 5) { if (!rolled && sp.closed == null) sp.closed = at; }
    else delete sp.closed;
    if (JSON.stringify(sp) === JSON.stringify(cur.splits ?? {})) return;
    const next = { ...cur, splits: sp };
    let e = (await supabase.from("game_days").upsert(upsertPayload(next, day), { onConflict: "user_id,day" })).error;
    if (e) e = (await supabase.from("game_days").upsert(upsertPayload(next, day), { onConflict: "user_id,day" })).error;
    if (!e) commitDays((ds) => [...ds.filter((d) => d.day !== day), next]);
  }

  async function addRep() {
    const who = rWho.trim();
    if (!who || saving || dayRolled()) return;
    const at = secOfDay();               // tap time, not resolve time
    setSaving("rep"); setErr("");
    try {
      const { data, error } = await supabase.from("bc_reps")
        .insert({ user_id: uid, day: today, who: who.slice(0, 120), place: rPlace.trim().slice(0, 120), note: rNote.trim().slice(0, 400) })
        .select("id,who,place,note").single();
      if (error || !data) { setErr("Couldn't log that rep — it's still here, try again."); return; }
      setRWho(""); setRPlace(""); setRNote("");
      sfx.coin(); buzz(15);
      // day rolled while the insert was in flight (locked phone at 23:59) —
      // the rep correctly lives on the tapped day, but it must NOT be appended
      // to the NEW day's local lists; resync from the DB instead
      if (todayStr() !== today) { load(); return; }
      const nextCount = todayReps.length + 1;
      setTodayReps((r) => [...r, data as Rep]);
      setRepDays((r) => [...r, today]);
      await stampAfterReps(nextCount, at, today);
    } catch { setErr("Couldn't reach the server — the rep is still here, try again."); }
    finally { setSaving(""); }
  }

  // deleteRep holds the SAME `saving` mutex as every other writer: its
  // follow-up stamp upsert writes the whole game_days row, so letting it run
  // concurrently with patch() silently reverted whichever write landed first.
  async function deleteRep(id: string) {
    if (saving || removingRep.current.has(id) || dayRolled()) return;
    removingRep.current.add(id);
    setRemovingIds([...removingRep.current]);
    setSaving("repdel");
    try {
      const { error } = await supabase.from("bc_reps").delete().eq("id", id);
      if (error) { setErr("Couldn't remove that rep."); return; }
      const nextCount = Math.max(0, todayReps.length - 1);
      setTodayReps((r) => r.filter((x) => x.id !== id));
      setRepDays((r) => { const i = r.indexOf(today); return i >= 0 ? [...r.slice(0, i), ...r.slice(i + 1)] : r; });
      await stampAfterReps(nextCount, secOfDay(), today);
    } catch { setErr("Couldn't reach the server — that rep is still logged."); }
    finally {
      setSaving("");
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
  const goldNow = fxRef.current.day === today ? fxRef.current.fx.gold : [];

  // stamp / ghost cell for a core row's subtitle
  function stampBits(k: SplitKey, done: boolean): React.ReactNode {
    const s = row.splits?.[k];
    if (done && typeof s === "number") {
      const pb = pbs[k];
      const isGold = goldNow.includes(k);
      return (
        <span className={`mono ${isGold ? "text-[var(--gold)] gold-flash font-semibold" : "opacity-60"}`}>
          {fmtClock(s)}
          {typeof pb === "number" && (
            <span className={s <= pb ? "text-[var(--ok)]" : "text-[var(--bad)]"}> {fmtDelta(s - pb)}</span>
          )}
          {isGold && " · best"}
        </span>
      );
    }
    const yd = ydRow?.splits?.[k];
    return typeof yd === "number" ? <span className="mono opacity-35">yd {fmtClock(yd)}</span> : null;
  }

  // the chase line — real clocks only
  const pbClose = pbs.closed;
  let chase: { text: string; cls: string } | null = null;
  if (!row.frozen) {
    if (typeof closedSec === "number") {
      const d = typeof pbClose === "number" ? closedSec - pbClose : null;
      chase = d !== null && d < 0
        ? { text: `Closed ${fmtClock(closedSec)} — new best (${fmtDelta(d)})`, cls: "text-[var(--gold)]" }
        : { text: `Closed ${fmtClock(closedSec)}${d !== null ? ` · PB ${fmtClock(pbClose!)} (${fmtDelta(d)})` : " — the season's first close sets the bar"}`, cls: "text-[var(--ok)]" };
    } else if (typeof pbClose === "number") {
      chase = nowSec < pbClose
        ? { text: `PB close ${fmtClock(pbClose)} · ${fmtDur(pbClose - nowSec)} to beat it`, cls: core >= 3 ? "text-[var(--text-2)]" : "text-[var(--text-3)]" }
        : { text: `PB close ${fmtClock(pbClose)} passed — closing still counts`, cls: "text-[var(--text-3)]" };
    } else if (inSeason) {
      chase = { text: "First close sets the season record", cls: "text-[var(--text-3)]" };
    }
  }

  return (
    <div className="pt-3">
      {/* header: the ring is the day */}
      <div className="relative">
        <div className="glow-hero" />
        <div className="relative flex items-center gap-4">
          <SegRing size={112} stroke={9} done={[parts.r, parts.b, parts.s, parts.bc, parts.l]} color="var(--ok)">
            <div className="text-center leading-none">
              <p className="font-bold text-[26px] mono">{core}<span className="text-[13px] text-[var(--text-4)]">/5</span></p>
              <p className="text-[9px] mono text-[var(--text-4)] mt-1">+{bonus} = {total}</p>
            </div>
          </SegRing>
          <div className="min-w-0 flex-1">
            <Eyebrow>{inSeason ? <>Day {dayN}/{SEASON_DAYS}{weekLabel ? ` · ${weekLabel}` : ""}</> : dayN < 1 ? "Pre-season" : "Season complete"}</Eyebrow>
            <div className="flex items-baseline gap-2 mt-1">
              <Num value={streak} className="text-[44px] font-bold leading-none tracking-tight" />
              <span className="text-xs text-[var(--text-3)]">day streak{lvl.name ? ` · ${lvl.name}` : ""}</span>
            </div>
            <p className="mono text-[11px] mt-1.5" style={{ color: band.hue }}>
              wk {band.name} {weekTotal}/70{lvl.next ? <span className="text-[var(--text-4)]"> · {lvl.next.togo}d to {lvl.next.name}</span> : null}
            </p>
          </div>
        </div>
        {chase && <p className={`relative mono text-[11px] mt-2.5 ${chase.cls}`}>{chase.text}</p>}
        {hour >= 21 && core < 3 && !row.frozen && (
          <p className="relative mono text-[11px] mt-1 text-[var(--bad)]">
            Streak dies at midnight — {fmtDur(86400 - nowSec)} left. Core ≥ 3 saves it.
          </p>
        )}
      </div>

      {row.frozen ? (
        <div className="mt-4 rounded-xl border border-sky-400/40 bg-sky-500/10 p-4 text-center">
          <p className="font-semibold">Freeze day — declared last night.</p>
          <p className="text-xs opacity-60 mt-1">Scores 0, streak survives. No audit, no guilt. Back tomorrow.</p>
        </div>
      ) : (
        <>
          {/* the five splits */}
          <div className="mt-4 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3.5">
            <div className="space-y-2">
              {/* R — two halves, both or no point */}
              <div className={`rounded-xl border px-3 py-2.5 transition-colors ${parts.r ? "bg-[var(--ok)]/[0.07] border-[var(--ok)]/30" : "bg-[var(--raised)] border-[var(--border-1)]"}`}>
                <div className="flex items-center gap-2">
                  <span className={`w-6 h-6 rounded-full grid place-items-center text-xs font-black shrink-0 ${parts.r ? "bg-[var(--ok)] text-black" : "bg-white/10"}`}>R</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Rituals</p>
                    <p className="text-[10px] text-[var(--text-3)]">{parts.r ? stampBits("r", true) : <>both or no point {stampBits("r", false)}</>}</p>
                  </div>
                  <button onClick={() => patch({ r_launch: !row.r_launch }, "rl")} disabled={!!saving}
                    className={`px-3 py-2 rounded-lg text-xs font-bold active:scale-95 disabled:opacity-50 ${row.r_launch ? "bg-[var(--ok)] text-black" : "bg-white/10"}`}>
                    Launch
                  </button>
                  <button onClick={() => patch({ r_shutdown: !row.r_shutdown }, "rs")} disabled={!!saving}
                    className={`px-3 py-2 rounded-lg text-xs font-bold active:scale-95 disabled:opacity-50 ${row.r_shutdown ? "bg-[var(--ok)] text-black" : "bg-white/10"}`}>
                    Shutdown
                  </button>
                </div>
              </div>

              {/* B and S — single taps */}
              {([["B", "Body", "b", row.b, parts.b, "gym day: train · rest day: clean eating + walk"], ["S", "School", "s", row.s, parts.s, "one 30-min block on the priority course"]] as const).map(([k, label, field, val, done, hint]) => (
                <button key={k} onClick={() => patch({ [field]: !val } as Partial<GameDayRow>, k)} disabled={!!saving}
                  className={`w-full rounded-xl border px-3 py-2.5 flex items-center gap-2 active:scale-[0.99] disabled:opacity-60 transition-colors ${done ? "bg-[var(--ok)]/[0.07] border-[var(--ok)]/30" : "bg-[var(--raised)] border-[var(--border-1)]"}`}>
                  <span className={`w-6 h-6 rounded-full grid place-items-center text-xs font-black shrink-0 ${done ? "bg-[var(--ok)] text-black" : "bg-white/10"}`}>{k}</span>
                  <div className="min-w-0 flex-1 text-left">
                    <p className="text-sm font-semibold">{label}</p>
                    <p className="text-[10px] text-[var(--text-3)]">{done ? stampBits(field as SplitKey, true) : <>{hint} {stampBits(field as SplitKey, false)}</>}</p>
                  </div>
                  {done && <span className="text-[var(--ok)] font-black">✓</span>}
                </button>
              ))}

              {/* BC — derived from the rep log. No log = didn't happen. */}
              <div className={`rounded-xl border px-3 py-2.5 transition-colors ${parts.bc ? "bg-[var(--ok)]/[0.07] border-[var(--ok)]/30" : "bg-[var(--raised)] border-[var(--border-1)]"}`}>
                <button onClick={() => setRepOpen((v) => !v)} className="w-full flex items-center gap-2 text-left">
                  <span className={`w-6 h-6 rounded-full grid place-items-center text-[10px] font-black shrink-0 ${parts.bc ? "bg-[var(--ok)] text-black" : "bg-white/10"}`}>BC</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">BookCrew {repsToday > 0 && <span className="mono text-xs opacity-60">· {repsToday} rep{repsToday === 1 ? "" : "s"}</span>}</p>
                    <p className="text-[10px] text-[var(--text-3)] truncate">
                      {parts.bc ? stampBits("bc", true) : <>one rep a stranger can see {stampBits("bc", false)}</>}
                    </p>
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
              <div className={`rounded-xl border px-3 py-2.5 transition-colors ${parts.l ? "bg-[var(--ok)]/[0.07] border-[var(--ok)]/30" : "bg-[var(--raised)] border-[var(--border-1)]"}`}>
                <button onClick={() => setLearnOpen((v) => !v)} className="w-full flex items-center gap-2 text-left">
                  <span className={`w-6 h-6 rounded-full grid place-items-center text-xs font-black shrink-0 ${parts.l ? "bg-[var(--ok)] text-black" : "bg-white/10"}`}>L</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Learn <span className="opacity-50 font-normal">· {trunkOfDay(today)}</span></p>
                    <p className="text-[10px] text-[var(--text-3)] truncate">
                      {parts.l ? <>{stampBits("l", true)} <span className="opacity-60">· {row.learn_line}</span></> : <>one leaf, one line in your own words {stampBits("l", false)}</>}
                    </p>
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
            {hour >= 17 && hour < 21 && core < 3 && (
              <p className="text-[11px] text-[var(--warn)] mt-3">
                MVD fallback: ~90 min. Rituals + any two others = the streak survives. Don&apos;t negotiate past that.
              </p>
            )}
          </div>

          {/* bonus chips */}
          <div className="mt-3 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3.5">
            <Eyebrow className="mb-2">Bonus · +{bonus} of 5 max</Eyebrow>
            <div className="flex flex-wrap gap-1.5">
              <span className={`px-3 py-2 rounded-lg text-xs font-semibold mono ${bonusBC(repsToday) > 0 ? "bg-[var(--neon)]/15 text-[var(--neon)] border border-[var(--neon)]/40" : "bg-white/5 opacity-45 border border-[var(--border-1)]"}`}>
                reps +{bonusBC(repsToday)}
              </span>
              {([["Uber", "bonus_uber", row.bonus_uber, repsToday === 0 && !row.bonus_uber, repsToday === 0 ? "Reps before rides — log the day's first BC rep first" : ""],
                 ["Rules 100%", "bonus_trading", row.bonus_trading, false, ""],
                 ["Shipped", "bonus_dev", row.bonus_dev, false, ""],
                 ["Chess", "bonus_chess", row.bonus_chess, false, ""]] as const).map(([label, field, val, dis, title]) => (
                <button key={field} onClick={() => patch({ [field]: !val } as Partial<GameDayRow>, field)} disabled={!!saving || dis} title={title}
                  className={`px-3 py-2 rounded-lg text-xs font-semibold active:scale-95 border disabled:opacity-35 ${val ? "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40" : "bg-white/5 border-[var(--border-1)]"}`}>
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-[var(--text-4)] mt-2">Uber only counts after the day&apos;s first rep · trading point is discipline, not P&amp;L · &quot;worked on&quot; ≠ shipped.</p>
          </div>
        </>
      )}

      {/* week strip + rep engine */}
      <div className="mt-3 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3.5">
        <div className="flex items-center justify-between mb-2">
          <Eyebrow>This week</Eyebrow>
          <p className="text-xs font-bold mono" style={{ color: band.hue }}>{band.name} · {weekTotal}/70</p>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {week.map((d) => {
            const r = rowsMap.get(d) ?? emptyDay(d);
            const t = dayTotal(r, repsByDay.get(d) ?? 0);
            const c = coreCount(r, repsByDay.get(d) ?? 0);
            const isToday = d === today;
            const future = d > today;
            // pre/post-season days can never score — never paint them as failures
            const off = diffDays(SEASON_START, d) < 1 || d > SEASON_END;
            // semantic trio: green = streak-safe (core ≥3), amber = partial, red = a past zero
            const col = r.frozen ? "#38bdf8" : c >= 3 ? "var(--ok)" : t > 0 ? "var(--warn)" : !future && !isToday ? "var(--bad)" : "var(--text-4)";
            return (
              <div key={d} className={`rounded-lg py-1.5 text-center border ${isToday ? "border-[var(--neon)]/50 bg-[var(--neon)]/10" : "border-[var(--border-1)] bg-white/[0.02]"} ${future || off ? "opacity-30" : ""}`}>
                <p className="text-[9px] opacity-45">{["S", "M", "T", "W", "T", "F", "S"][new Date(d + "T00:00:00").getDay()]}</p>
                {r.frozen && !off ? <p className="text-xs">❄️</p> : (
                  <p className="text-sm font-bold mono" style={{ color: future || off ? undefined : col }}>{future || off ? "·" : t}</p>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 mt-3 pt-3 border-t border-[var(--border-1)]">
          <ProgressCircle pct={pace.total / REP_TARGET} size={46} stroke={5}>
            <Num value={pace.total} className="text-[11px] font-bold" />
          </ProgressCircle>
          <div className="min-w-0">
            <Eyebrow>250-rep engine</Eyebrow>
            <p className="mono text-[11px] text-[var(--text-2)] mt-0.5">
              pace → ~{pace.projected}{pace.perDayNeeded > 0 ? ` · need ${pace.perDayNeeded.toFixed(1)}/day` : ""}
            </p>
          </div>
        </div>
        {/* freeze declare — tonight, for tomorrow, max one a week */}
        {!tomorrowFrozen && !frozenUsedInTomorrowWeek && (
          <button onClick={() => patchDay(tomorrow, { frozen: true }, "fz")} disabled={!!saving}
            className="text-[10px] opacity-40 underline mt-2.5 active:scale-95">Declare tomorrow a freeze day (exam · sick · travel)</button>
        )}
        {tomorrowFrozen && (
          <p className="text-[10px] opacity-50 mt-2.5">Tomorrow is frozen — streak survives, scores 0.{" "}
            <button onClick={() => patchDay(tomorrow, { frozen: false }, "fz")} disabled={!!saving} className="underline">undo</button>
          </p>
        )}
      </div>

      {/* next blocks — the 12:30 / 4:00 question: what's the next block? */}
      {nextBlocks.length > 0 && (
        <div className="mt-3 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3.5">
          <Eyebrow className="mb-1.5">Next block</Eyebrow>
          {nextBlocks.map((b, i) => (
            <div key={i} className="flex gap-3 text-sm py-0.5">
              <span className="mono text-xs opacity-45 w-11 shrink-0 pt-0.5">{b.time}</span>
              <span className="opacity-85">{b.what}</span>
            </div>
          ))}
        </div>
      )}

      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
      <p className="text-[10px] opacity-30 mt-3 text-center">Paper is boss until this matches the card 7 straight days. Score both at Shutdown.</p>

      {/* day-complete takeover — the moment, then back to life */}
      {takeover && (
        <div className="fixed inset-0 z-50 bg-black/90 grid place-items-center p-6" onClick={() => setTakeover(false)}>
          <div className="text-center" style={{ animation: "levelPop 0.5s ease" }}>
            <div className="flex justify-center">
              <SegRing size={140} stroke={10} done={[true, true, true, true, true]} color="var(--ok)">
                <span className="text-4xl font-bold mono">5</span>
              </SegRing>
            </div>
            <p className="text-2xl font-bold mt-4">Card closed{typeof closedSec === "number" ? <span className="mono"> — {fmtClock(closedSec)}</span> : ""}</p>
            {typeof closedSec === "number" && typeof pbClose === "number" && closedSec < pbClose && (
              <p className="text-[var(--gold)] font-semibold mt-1">New best close</p>
            )}
            <p className="mono text-xs text-[var(--text-3)] mt-3">
              streak {streak} · day {dayN}/{SEASON_DAYS}{lvl.next ? ` · ${lvl.next.name} in ${lvl.next.togo}d` : ""} · reps {pace.total}/{REP_TARGET}
            </p>
            <p className="text-[10px] text-[var(--text-4)] mt-5">tap anywhere</p>
          </div>
        </div>
      )}
    </div>
  );
}
