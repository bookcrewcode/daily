"use client";

// 🗂️ THE CARD — today's list, and how fast you clear it.
//
// v43 replaced the five fixed categories (R/B/S/BC/L) with the day's REAL
// checklist. Ben's words: "it should just be a checkoff list every day of
// everything that I need to do for that day. So it should pair in hand with
// the day-to-day planning." So the list is not a second copy of the plan — it
// IS the plan. Both this screen and the Plan chat read and write the same
// nights.items array, and deadlines falling due today are pulled onto it.
//
// The game survives, scored on the list instead of the categories:
//   point   = one finished item (bonus adds up to +4, day caps at 10)
//   won day = at least min(3, list length) done — so a light day is won by
//             clearing it, and a heavy day still needs three
//   closed  = list cleared. That's the clock worth racing, and the only PB
//             that still means anything now that the items change daily.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import {
  type GameDayRow, type DayItem, type Splits,
  emptyDay, dayTotal, bonusCount, isStreakDay, winBar,
  normalizeItems, sortItems, countDone, newItemId,
  computeStreak, daysWon, winPace, levelInfo, weekDays, weekBand, weekStart, seasonDay,
  addDays, diffDays, secOfDay, fmtClock, fmtDelta, fmtDur, partBests,
  SEASON_START, SEASON_END, SEASON_DAYS, WIN_TARGET, WEEK_LABELS,
} from "@/lib/theGame";
import { splitsFor } from "@/lib/dayList";
import { burstConfetti } from "@/lib/confetti";
import { sfx, buzz } from "@/lib/fx";
import { Num, Eyebrow, SegRing, ProgressCircle } from "./ui";
import WorldBriefing from "./WorldBriefing";

type Gig = { id: string; platform: string; hours: number; earnings: number };
type Ev = { time: string; what: string };
type GoalDue = { id: string; title: string };

const GD_COLS = "day,r_launch,r_shutdown,b,s,bonus_uber,bonus_trading,bonus_dev,bonus_chess,frozen,learn_line,splits,items_done,items_total";

// per-day celebration store (localStorage) — a tab switch remounts this
// component and must never replay the confetti and cheapen the real moment.
type FxStore = { closed: boolean; ten: boolean; gold: boolean };
const fxMem = new Map<string, FxStore>();
function readFx(day: string): FxStore {
  const empty = { closed: false, ten: false, gold: false };
  try {
    const raw = localStorage.getItem(`daily.card.fx.${day}`);
    if (raw == null) return fxMem.get(day) ?? empty;
    if (raw.startsWith("{")) return { ...empty, ...JSON.parse(raw) };
    return empty;
  } catch { return fxMem.get(day) ?? empty; }
}
function writeFx(day: string, fx: FxStore) {
  fxMem.set(day, { ...fx });
  try { localStorage.setItem(`daily.card.fx.${day}`, JSON.stringify(fx)); } catch { /* fxMem covers the session */ }
}

export default function TheCard({ uid, onGoTab }: { uid: string; onGoTab: (t: string) => void }) {
  const [days, setDays] = useState<GameDayRow[]>([]);
  const [items, setItems] = useState<DayItem[]>([]);
  const [blocks, setBlocks] = useState<Ev[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [saving, setSaving] = useState("");
  const [err, setErr] = useState("");
  const [takeover, setTakeover] = useState(false);
  const [nowSec, setNowSec] = useState(() => secOfDay());

  // add-an-item form
  const [addOpen, setAddOpen] = useState(false);
  const [aTime, setATime] = useState("");
  const [aWhat, setAWhat] = useState("");

  // driving shifts — the bonus chip logs REAL money, not a mystery checkbox
  const [todayGigs, setTodayGigs] = useState<Gig[]>([]);
  const [gigOpen, setGigOpen] = useState(false);
  const [gigSaving, setGigSaving] = useState(false);
  const [gPlatform, setGPlatform] = useState<"DoorDash" | "Uber Eats">("DoorDash");
  const [gHours, setGHours] = useState("");
  const [gEarn, setGEarn] = useState("");

  const fxRef = useRef<{ day: string; fx: FxStore }>({ day: "", fx: { closed: false, ten: false, gold: false } });
  const dayRef = useRef(todayStr());
  const pulledGoals = useRef("");   // the day whose due-goals were already pulled in

  // Every write to `days` goes through commitDays so an in-flight async writer
  // can read the FRESH rows from daysRef — a render closure can be a whole
  // write cycle stale by the time a network call resolves.
  const daysRef = useRef<GameDayRow[]>([]);
  const commitDays = useCallback((updater: (ds: GameDayRow[]) => GameDayRow[]) => {
    daysRef.current = updater(daysRef.current);
    setDays(daysRef.current);
  }, []);
  const itemsRef = useRef<DayItem[]>([]);
  const commitItems = useCallback((next: DayItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const load = useCallback(async () => {
    const today = todayStr();
    try {
      const [gd, ni, gl, cb, gg] = await Promise.all([
        supabase.from("game_days").select(GD_COLS).eq("user_id", uid).gte("day", SEASON_START),
        supabase.from("nights").select("items").eq("user_id", uid).eq("day", today).maybeSingle(),
        supabase.from("goals").select("id,title").eq("user_id", uid).eq("status", "active").eq("due", today),
        supabase.from("class_blocks").select("label,location,start_t").eq("user_id", uid).eq("weekday", new Date().getDay()).order("start_t"),
        supabase.from("gig_shifts").select("id,platform,hours,earnings").eq("user_id", uid).eq("day", today).order("created_at"),
      ]);
      // a failed read must never look like an empty card — the streak number
      // has to be trustworthy or the whole game is dead
      if (gd.error || ni.error) { setLoadErr(true); setLoaded(true); return; }
      commitDays(() => ((gd.data ?? []) as GameDayRow[]).map((d) => ({
        ...d, splits: d.splits ?? {}, items_done: d.items_done ?? 0, items_total: d.items_total ?? 0,
      })));

      let list = normalizeItems(ni.data?.items);
      // Deadlines due today join the list for real (not as a decoration), so
      // checking one both scores the day and closes the goal. Materialised once
      // per day and only ever ADDITIVE — a goal read failure just means no
      // deadlines today, never a wiped list.
      if (!gl.error && pulledGoals.current !== today) {
        const have = new Set(list.map((i) => i.goal_id).filter(Boolean));
        const missing = ((gl.data ?? []) as GoalDue[])
          .filter((g) => !have.has(g.id))
          .map((g) => ({ id: newItemId(), time: "", what: g.title.slice(0, 200), src: "goal" as const, goal_id: g.id }));
        if (missing.length) {
          const merged = [...list, ...missing];
          const { error } = await supabase.from("nights")
            .upsert({ user_id: uid, day: today, items: merged }, { onConflict: "user_id,day" });
          if (!error) list = merged;
        }
        pulledGoals.current = today;
      }
      const listNow = sortItems(list);
      commitItems(listNow);

      // Self-heal. The Plan chat can rewrite the day while the Card is closed,
      // and its mirror write can fail. Where game_days disagrees with the list
      // that actually exists, the LIST wins — the week strip and the season map
      // must never contradict the ring the user is looking at.
      const cur = daysRef.current.find((d) => d.day === today) ?? emptyDay(today);
      const nDone = countDone(listNow);
      if (cur.items_done !== nDone || cur.items_total !== listNow.length) {
        const fixed = {
          ...cur, items_done: nDone, items_total: listNow.length,
          splits: splitsFor(cur.splits ?? {}, listNow, secOfDay()),
        };
        const { error } = await supabase.from("game_days").upsert({
          user_id: uid, day: today,
          r_launch: fixed.r_launch, r_shutdown: fixed.r_shutdown, b: fixed.b, s: fixed.s,
          bonus_uber: fixed.bonus_uber, bonus_trading: fixed.bonus_trading,
          bonus_dev: fixed.bonus_dev, bonus_chess: fixed.bonus_chess,
          frozen: fixed.frozen, learn_line: fixed.learn_line, splits: fixed.splits,
          items_done: fixed.items_done, items_total: fixed.items_total,
        }, { onConflict: "user_id,day" });
        if (!error) commitDays((ds) => [...ds.filter((d) => d.day !== today), fixed]);
      }

      const cls = (cb.error ? [] : ((cb.data ?? []) as { label: string; location: string; start_t: string }[]))
        .map((c) => ({ time: c.start_t, what: `${c.label}${c.location ? ` · ${c.location}` : ""}` }));
      setBlocks(cls.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99")));
      setTodayGigs(gg.error ? [] : ((gg.data ?? []) as Gig[]));
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid, commitDays, commitItems]);
  useEffect(() => { load(); }, [load]);

  // midnight rollover: a card left open must flip to the new day.
  // The same interval keeps the live clock (countdowns) honest.
  useEffect(() => {
    const check = () => {
      setNowSec(secOfDay());
      const now = todayStr();
      if (now !== dayRef.current) {
        dayRef.current = now;
        commitItems([]); setAddOpen(false); setATime(""); setAWhat("");
        setTodayGigs([]); setGigOpen(false); setGHours(""); setGEarn("");
        setTakeover(false);
        pulledGoals.current = "";
        load();
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    const id = setInterval(check, 15000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [load, commitItems]);

  const today = todayStr();
  const rowsMap = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const row = rowsMap.get(today) ?? emptyDay(today);
  const total = items.length;
  const done = countDone(items);
  const bar = winBar(total);
  const closed = total >= 1 && done >= total;
  const bonus = bonusCount(row);
  const points = row.frozen ? 0 : Math.min(10, done + bonus);
  const gigEarned = todayGigs.reduce((t, g) => t + (Number(g.earnings) || 0), 0);
  const gigHours = todayGigs.reduce((t, g) => t + (Number(g.hours) || 0), 0);

  const streak = useMemo(() => computeStreak(rowsMap, today), [rowsMap, today]);
  const won = useMemo(() => daysWon(days, today), [days, today]);
  const pace = winPace(won, today);
  const lvl = levelInfo(streak);
  const week = weekDays(today);
  const weekTotal = week.reduce((t, d) => {
    if (diffDays(SEASON_START, d) < 1 || d > SEASON_END) return t;
    return t + dayTotal(rowsMap.get(d) ?? emptyDay(d));
  }, 0);
  const band = weekBand(weekTotal);
  const dayN = seasonDay(today);
  const hour = new Date().getHours();
  const nowT = `${String(hour).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`;
  const nextBlocks = blocks.filter((b) => b.time && b.time >= nowT).slice(0, 3);
  const weekLabel = WEEK_LABELS[weekStart(today)];

  // PBs exclude today (still in progress) and frozen days
  const pbs = useMemo(() => partBests(days, today), [days, today]);
  const closedSec = row.splits?.closed;
  const pbClose = pbs.closed;

  // celebrations — once per day each, only on the transition
  useEffect(() => {
    if (fxRef.current.day !== today) fxRef.current = { day: today, fx: readFx(today) };
    const fx = fxRef.current.fx;
    let changed = false;
    if (closed && !fx.closed) {
      fx.closed = true; changed = true;
      burstConfetti("small"); sfx.fanfare(); buzz([20, 30, 20]);
      setTakeover(true);
    }
    if (typeof closedSec === "number" && typeof pbClose === "number" && closedSec < pbClose && !fx.gold) {
      fx.gold = true; changed = true;
      burstConfetti("micro"); sfx.pr(); buzz(10);
    }
    if (points >= 10 && !fx.ten) { fx.ten = true; changed = true; sfx.levelup(); }
    if (changed) writeFx(today, fx);
  }, [closed, points, today, closedSec, pbClose]);

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
    commitItems([]); setAddOpen(false); setATime(""); setAWhat("");
    setTakeover(false);
    pulledGoals.current = "";
    load();
    return true;
  }

  function upsertPayload(d: GameDayRow, day: string) {
    return {
      user_id: uid, day,
      r_launch: d.r_launch, r_shutdown: d.r_shutdown, b: d.b, s: d.s,
      bonus_uber: d.bonus_uber, bonus_trading: d.bonus_trading,
      bonus_dev: d.bonus_dev, bonus_chess: d.bonus_chess,
      frozen: d.frozen, learn_line: d.learn_line, splits: d.splits ?? {},
      items_done: d.items_done ?? 0, items_total: d.items_total ?? 0,
    };
  }

  // The list is the score, so the list and the score are written together.
  // nights.items goes first (it's the shared source of truth with the Plan
  // chat); game_days carries the counts so the season map and the streak never
  // have to load every night row to know whether a day was won.
  async function saveList(next: DayItem[], key: string, at: number): Promise<boolean> {
    if (saving || dayRolled()) return false;
    setSaving(key); setErr("");
    try {
      const sorted = sortItems(next);
      const { error } = await supabase.from("nights")
        .upsert({ user_id: uid, day: today, items: sorted }, { onConflict: "user_id,day" });
      if (error) { setErr("Couldn't save the list — try again."); return false; }
      commitItems(sorted);

      const nDone = countDone(sorted);
      const nTotal = sorted.length;
      const base = daysRef.current.find((d) => d.day === today) ?? emptyDay(today);
      const sp: Splits = splitsFor(base.splits ?? {}, sorted, at);

      const nextRow = { ...base, items_done: nDone, items_total: nTotal, splits: sp };
      const { error: e2 } = await supabase.from("game_days")
        .upsert(upsertPayload(nextRow, today), { onConflict: "user_id,day" });
      if (e2) { setErr("The list saved, but the score didn't — tap again."); return false; }
      commitDays((ds) => [...ds.filter((d) => d.day !== today), nextRow]);
      return true;
    } catch { setErr("Couldn't reach the server — nothing saved."); return false; }
    finally { setSaving(""); }
  }

  async function toggleItem(it: DayItem) {
    const at = secOfDay();                       // tap time, never resolve time
    const nextDone = !it.done;
    const next = itemsRef.current.map((x) => x.id === it.id
      ? { ...x, done: nextDone, at: nextDone ? at : undefined }
      : x);
    const ok = await saveList(next, `t_${it.id}`, at);
    if (!ok) return;
    if (nextDone) { sfx.coin(); buzz(12); } else sfx.pop();
    // a deadline checked off the list is a goal finished — close it for real,
    // but never let that secondary write undo the tick that already landed
    if (it.goal_id) {
      await supabase.from("goals")
        .update({ status: nextDone ? "done" : "active", updated_at: new Date().toISOString() })
        .eq("id", it.goal_id);
    }
  }

  async function addItem() {
    const what = aWhat.trim();
    if (!what || saving) return;
    const t = aTime.trim();
    const item: DayItem = {
      id: newItemId(),
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : "",
      what: what.slice(0, 200),
      src: "card",
    };
    const ok = await saveList([...itemsRef.current, item], "add", secOfDay());
    if (ok) { setAWhat(""); setATime(""); sfx.pop(); }
  }

  async function removeItem(id: string) {
    if (saving) return;
    await saveList(itemsRef.current.filter((x) => x.id !== id), `x_${id}`, secOfDay());
  }

  async function patch(fields: Partial<GameDayRow>, key: string): Promise<boolean> {
    if (saving || dayRolled()) return false;
    setSaving(key); setErr("");
    try {
      const base = daysRef.current.find((d) => d.day === today) ?? emptyDay(today);
      const next = { ...base, ...fields };
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

  // A driving shift is MONEY first and a game point second. It always records,
  // whether or not it has earned the point yet — the old chip was `disabled`
  // with a hover-only `title`, which on a phone is a dead control that never
  // explains itself.
  async function logGig() {
    const h = Number(gHours) || 0;
    const e = Number(gEarn) || 0;
    if ((!h && !e) || saving || gigSaving || dayRolled()) return;
    setGigSaving(true); setErr("");
    try {
      const { data, error } = await supabase.from("gig_shifts")
        .insert({ user_id: uid, day: today, platform: gPlatform, hours: h, earnings: e })
        .select("id,platform,hours,earnings").single();
      if (error || !data) { setErr("Couldn't log that shift — the numbers are still here, try again."); return; }
      setGHours(""); setGEarn("");
      sfx.coin(); buzz(15);
      if (todayStr() !== today) { load(); return; }   // rolled mid-flight
      setTodayGigs((g) => [...g, data as Gig]);
    } catch { setErr("Couldn't reach the server — the shift is still here, try again."); return; }
    finally { setGigSaving(false); }
    if (!row.bonus_uber) await patch({ bonus_uber: true }, "gig");
  }

  async function deleteGig(id: string) {
    if (saving || gigSaving || dayRolled()) return;
    setGigSaving(true);
    try {
      const { error } = await supabase.from("gig_shifts").delete().eq("id", id);
      if (error) { setErr("Couldn't remove that shift."); return; }
      const left = todayGigs.filter((x) => x.id !== id);
      setTodayGigs(left);
      // last shift gone = the day didn't involve driving; the point goes with it
      if (left.length === 0 && row.bonus_uber) { setGigSaving(false); await patch({ bonus_uber: false }, "gig"); return; }
    } catch { setErr("Couldn't reach the server — that shift is still logged."); }
    finally { setGigSaving(false); }
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

  // the chase line — real clocks only
  let chase: { text: string; cls: string } | null = null;
  if (!row.frozen) {
    if (typeof closedSec === "number") {
      const d = typeof pbClose === "number" ? closedSec - pbClose : null;
      chase = d !== null && d < 0
        ? { text: `Cleared ${fmtClock(closedSec)} — new best (${fmtDelta(d)})`, cls: "text-[var(--gold)]" }
        : { text: `Cleared ${fmtClock(closedSec)}${d !== null ? ` · best ${fmtClock(pbClose!)} (${fmtDelta(d)})` : " — the season's first clear sets the bar"}`, cls: "text-[var(--ok)]" };
    } else if (typeof pbClose === "number" && total > 0) {
      chase = nowSec < pbClose
        ? { text: `Best clear ${fmtClock(pbClose)} · ${fmtDur(pbClose - nowSec)} to beat it`, cls: done >= bar ? "text-[var(--text-2)]" : "text-[var(--text-3)]" }
        : { text: `Best clear ${fmtClock(pbClose)} passed — clearing still counts`, cls: "text-[var(--text-3)]" };
    } else if (inSeason && total > 0) {
      chase = { text: "First cleared list sets the season record", cls: "text-[var(--text-3)]" };
    }
  }

  return (
    <div className="pt-3">
      {/* header: the ring is the list */}
      <div className="relative">
        <div className="glow-hero" />
        <div className="relative flex items-center gap-4">
          <SegRing size={112} stroke={total > 8 ? 7 : 9}
            done={total > 0 ? items.map((i) => !!i.done) : [false]}
            color={done >= bar && total > 0 ? "var(--ok)" : "var(--neon)"}>
            <div className="text-center leading-none">
              <p className="font-bold text-[26px] mono">{done}<span className="text-[13px] text-[var(--text-4)]">/{total}</span></p>
              <p className="text-[9px] mono text-[var(--text-4)] mt-1">{bonus > 0 ? `+${bonus} = ${points}` : `${points} pt${points === 1 ? "" : "s"}`}</p>
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
        {hour >= 21 && total > 0 && done < bar && !row.frozen && (
          <p className="relative mono text-[11px] mt-1 text-[var(--bad)]">
            Streak dies at midnight — {fmtDur(86400 - nowSec)} left. {bar - done} more off the list saves it.
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
          {/* TODAY'S LIST — the same array the Plan chat writes */}
          <div className="mt-4 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3.5">
            <div className="flex items-baseline justify-between mb-2">
              <Eyebrow>Today&apos;s list</Eyebrow>
              {total > 0 && (
                <p className="mono text-[10px]" style={{ color: done >= bar ? "var(--ok)" : "var(--text-4)" }}>
                  {done >= bar ? "streak safe" : `${bar - done} more for the streak`}
                </p>
              )}
            </div>

            {total === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border-2)] bg-[var(--raised)] px-3 py-4 text-center">
                <p className="text-sm text-[var(--text-2)]">Nothing on today yet.</p>
                <p className="text-[11px] text-[var(--text-3)] mt-1">Talk the day out in Plan and it lands here — or add a line below.</p>
                <button onClick={() => onGoTab("plan")}
                  className="mt-2.5 rounded-lg bg-[var(--neon)] text-black text-sm font-bold px-4 py-2 active:scale-95">
                  Plan today →
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                {items.map((it) => (
                  <div key={it.id}
                    className={`group rounded-xl border px-2.5 py-2.5 flex items-center gap-2.5 transition-colors ${
                      it.done ? "bg-[var(--ok)]/[0.07] border-[var(--ok)]/30" : "bg-[var(--raised)] border-[var(--border-1)]"}`}>
                    <button onClick={() => toggleItem(it)} disabled={!!saving}
                      aria-label={it.done ? `Uncheck ${it.what}` : `Check off ${it.what}`}
                      className={`w-7 h-7 rounded-lg grid place-items-center shrink-0 text-sm font-black active:scale-90 disabled:opacity-50 ${
                        it.done ? "bg-[var(--ok)] text-black" : "bg-white/10 text-transparent"}`}>
                      ✓
                    </button>
                    <button onClick={() => toggleItem(it)} disabled={!!saving} className="min-w-0 flex-1 text-left active:scale-[0.99] disabled:opacity-60">
                      <p className={`text-sm leading-snug ${it.done ? "line-through opacity-45" : "font-medium"}`}>
                        {it.what}
                      </p>
                      <p className="text-[10px] text-[var(--text-4)] mono mt-0.5">
                        {it.time || "anytime"}
                        {it.src === "goal" && <span className="text-[var(--warn)]"> · deadline</span>}
                        {it.done && typeof it.at === "number" && <span className="opacity-70"> · done {fmtClock(it.at)}</span>}
                      </p>
                    </button>
                    <button onClick={() => removeItem(it.id)} disabled={!!saving}
                      aria-label={`Remove ${it.what}`}
                      className="opacity-25 text-xs px-1 active:scale-90 disabled:opacity-10">✕</button>
                  </div>
                ))}
              </div>
            )}

            {addOpen ? (
              <div className="mt-2 flex gap-1.5">
                <input value={aTime} onChange={(e) => setATime(e.target.value)} disabled={!!saving}
                  placeholder="09:00" inputMode="numeric"
                  className="w-20 rounded-lg bg-black/30 px-2.5 py-2 outline-none text-sm mono" />
                <input value={aWhat} onChange={(e) => setAWhat(e.target.value)} disabled={!!saving} autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") addItem(); }}
                  placeholder="what needs doing"
                  className="flex-1 min-w-0 rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
                <button onClick={addItem} disabled={!!saving || !aWhat.trim()}
                  className="rounded-lg bg-[var(--neon)] text-black text-sm font-bold px-3 active:scale-95 disabled:opacity-40">
                  {saving === "add" ? "…" : "add"}
                </button>
              </div>
            ) : (
              <button onClick={() => setAddOpen(true)} className="mono text-[10px] text-[var(--neon)] mt-2 active:scale-95">＋ add a line</button>
            )}

            {total > 0 && (
              <div className="flex items-center gap-3 mt-2.5 pt-2.5 border-t border-[var(--border-1)]">
                <button onClick={() => onGoTab("plan")} className="mono text-[10px] text-[var(--text-4)] underline active:scale-95">
                  replan the day →
                </button>
                {hour >= 17 && hour < 21 && done < bar && (
                  <p className="text-[10px] text-[var(--warn)]">
                    {bar - done} left for the streak. Pick the smallest ones.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Bonus — things that aren't on the list but still count */}
          <div className="mt-3 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3.5">
            <Eyebrow className="mb-2">Bonus · +{bonus} of 4 max</Eyebrow>
            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => setGigOpen((v) => !v)}
                className={`px-3 py-2 rounded-lg text-xs font-semibold active:scale-95 border ${row.bonus_uber ? "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40" : "bg-white/5 border-[var(--border-1)]"}`}>
                Drove{gigEarned > 0 ? <span className="mono opacity-75"> · ${Math.round(gigEarned)}</span> : null} <span className="opacity-45">{gigOpen ? "▴" : "＋"}</span>
              </button>

              {([["Traded my rules", "bonus_trading", row.bonus_trading],
                 ["Shipped code", "bonus_dev", row.bonus_dev],
                 ["Rated chess", "bonus_chess", row.bonus_chess]] as const).map(([label, field, val]) => (
                <button key={field} onClick={() => patch({ [field]: !val } as Partial<GameDayRow>, field)} disabled={!!saving}
                  className={`px-3 py-2 rounded-lg text-xs font-semibold active:scale-95 border disabled:opacity-35 ${val ? "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40" : "bg-white/5 border-[var(--border-1)]"}`}>
                  {label}
                </button>
              ))}
            </div>

            {gigOpen && (
              <div className="mt-2.5 space-y-1.5 rise-in">
                {todayGigs.map((g) => (
                  <div key={g.id} className="flex items-center gap-2 rounded-lg bg-black/25 px-2.5 py-1.5">
                    <p className="text-xs flex-1 min-w-0 truncate mono">{g.platform} · {g.hours}h · ${Math.round(g.earnings)}</p>
                    <button onClick={() => deleteGig(g.id)} disabled={gigSaving} className="opacity-30 text-xs active:scale-90 disabled:opacity-10">✕</button>
                  </div>
                ))}
                <div className="flex gap-1.5">
                  {(["DoorDash", "Uber Eats"] as const).map((pf) => (
                    <button key={pf} onClick={() => setGPlatform(pf)}
                      className={`flex-1 rounded-lg py-2 text-xs font-semibold active:scale-95 border ${gPlatform === pf ? "bg-white/15 border-[var(--border-2)]" : "bg-black/30 border-[var(--border-1)] opacity-55"}`}>
                      {pf}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <input value={gHours} onChange={(e) => setGHours(e.target.value)} disabled={gigSaving}
                    inputMode="decimal" placeholder="hours" className="rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
                  <input value={gEarn} onChange={(e) => setGEarn(e.target.value)} disabled={gigSaving}
                    inputMode="decimal" placeholder="$ earned"
                    onKeyDown={(e) => { if (e.key === "Enter") logGig(); }}
                    className="rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
                </div>
                <button onClick={logGig} disabled={gigSaving || (!gHours && !gEarn)}
                  className="w-full rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-40">
                  {gigSaving ? "logging…" : "Log the shift"}
                </button>
                {gigEarned > 0 && (
                  <p className="mono text-[10px] text-[var(--text-4)]">
                    today ${Math.round(gigEarned)}{gigHours > 0 ? ` · ${gigHours}h · $${(gigEarned / gigHours).toFixed(0)}/hr` : ""} · also counts toward the gig goal
                  </p>
                )}
              </div>
            )}

            <details className="mt-2.5">
              <summary className="text-[10px] text-[var(--text-4)] cursor-pointer list-none active:scale-95">what counts for each of these ▾</summary>
              <div className="mt-1.5 space-y-1 text-[10px] text-[var(--text-3)] leading-relaxed">
                <p><b>Drove</b> — any DoorDash / Uber Eats shift. Records the real hours and dollars, and feeds the gig goal in Hustle.</p>
                <p><b>Traded my rules</b> — you followed your trading rules 100%. Discipline, not profit: a losing day by the rules scores, a winning day off the rules doesn&apos;t.</p>
                <p><b>Shipped code</b> — something is live that wasn&apos;t live this morning. &quot;Worked on it&quot; isn&apos;t shipped.</p>
                <p><b>Rated chess</b> — at least one rated game. Win or lose.</p>
              </div>
            </details>
          </div>

          {/* the whole scoring model, one tap away — no more guessing at it */}
          <details className="mt-3 rounded-xl border border-[var(--border-1)] bg-[var(--card)] px-3.5 py-3">
            <summary className="text-[11px] font-semibold text-[var(--text-2)] cursor-pointer list-none active:scale-[0.99]">How the day scores ▾</summary>
            <div className="mt-2 space-y-1.5 text-[11px] text-[var(--text-3)] leading-relaxed">
              <p><b className="text-[var(--text-2)]">The list</b> — whatever you planned in the Plan chat, plus anything due today, plus lines you add here. One point each.</p>
              <p><b className="text-[var(--text-2)]">Bonus</b> — up to +4 for things that were never on the list. The day caps at 10 points.</p>
              <p><b className="text-[var(--text-2)]">The streak</b> — lives on <b>{"min(3, list length)"}</b> items done. A three-item day is won by clearing it; a twelve-item day still only needs three. Bonus doesn&apos;t count toward it.</p>
              <p><b className="text-[var(--text-2)]">Cleared</b> — every line ticked. That stamps the clock, and beating your earliest-ever clear is the record worth chasing.</p>
              <p><b className="text-[var(--text-2)]">Freeze</b> — declared the night before, one a week. Scores 0, streak survives. Declaring is allowed; disappearing without declaring is what breaks you.</p>
              <p><b className="text-[var(--text-2)]">The week</b> — out of 70. Under 25 Down · 25–39 Surviving · 40–54 Running · 55+ Compounding.</p>
            </div>
          </details>
        </>
      )}

      {/* week strip + season pace */}
      <div className="mt-3 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3.5">
        <div className="flex items-center justify-between mb-2">
          <Eyebrow>This week</Eyebrow>
          <p className="text-xs font-bold mono" style={{ color: band.hue }}>{band.name} · {weekTotal}/70</p>
        </div>
        <div className="grid grid-cols-7 gap-1">
          {week.map((d) => {
            const r = rowsMap.get(d) ?? emptyDay(d);
            const t = dayTotal(r);
            const isToday = d === today;
            const future = d > today;
            // pre/post-season days can never score — never paint them as failures
            const off = diffDays(SEASON_START, d) < 1 || d > SEASON_END;
            // semantic trio: green = won, amber = partial, red = a past zero
            const col = r.frozen ? "#38bdf8" : isStreakDay(r) ? "var(--ok)" : t > 0 ? "var(--warn)" : !future && !isToday ? "var(--bad)" : "var(--text-4)";
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
          <ProgressCircle pct={pace.total / WIN_TARGET} size={46} stroke={5}>
            <Num value={pace.total} className="text-[11px] font-bold" />
          </ProgressCircle>
          <div className="min-w-0">
            <Eyebrow>Days won · {pace.total}/{WIN_TARGET}</Eyebrow>
            <p className="mono text-[11px] text-[var(--text-2)] mt-0.5">
              pace → ~{pace.projected} of {SEASON_DAYS}{pace.perWeekNeeded > 0 ? ` · need ${pace.perWeekNeeded.toFixed(1)}/wk` : ""}
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

      {/* class timetable context — not scored, just "what's next" */}
      {nextBlocks.length > 0 && (
        <div className="mt-3 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3.5">
          <Eyebrow className="mb-1.5">Next class</Eyebrow>
          {nextBlocks.map((b, i) => (
            <div key={i} className="flex gap-3 text-sm py-0.5">
              <span className="mono text-xs opacity-45 w-11 shrink-0 pt-0.5">{b.time}</span>
              <span className="opacity-85">{b.what}</span>
            </div>
          ))}
        </div>
      )}

      {/* the world, once a day, after the day's own work is on the board */}
      <WorldBriefing uid={uid} />

      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}

      {/* list-cleared takeover — the moment, then back to life */}
      {takeover && (
        <div className="fixed inset-0 z-50 bg-black/90 grid place-items-center p-6" onClick={() => setTakeover(false)}>
          <div className="text-center" style={{ animation: "levelPop 0.5s ease" }}>
            <div className="flex justify-center">
              <SegRing size={140} stroke={10} done={items.map(() => true)} color="var(--ok)">
                <span className="text-4xl font-bold mono">{total}</span>
              </SegRing>
            </div>
            <p className="text-2xl font-bold mt-4">List cleared{typeof closedSec === "number" ? <span className="mono"> — {fmtClock(closedSec)}</span> : ""}</p>
            {typeof closedSec === "number" && typeof pbClose === "number" && closedSec < pbClose && (
              <p className="text-[var(--gold)] font-semibold mt-1">New best clear</p>
            )}
            <p className="mono text-xs text-[var(--text-3)] mt-3">
              streak {streak} · day {dayN}/{SEASON_DAYS}{lvl.next ? ` · ${lvl.next.name} in ${lvl.next.togo}d` : ""} · {pace.total} days won
            </p>
            <p className="text-[10px] text-[var(--text-4)] mt-5">tap anywhere</p>
          </div>
        </div>
      )}
    </div>
  );
}
