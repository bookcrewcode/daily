"use client";

// Plan — two gears, deliberately different temperatures:
//
//   TODAY   plan the day by TALKING ("gym 7, class 9-11, bookcrew after lunch"),
//           then the real timeline (classes + planned blocks + Google Calendar
//           events), deadlines, inbox, semester.
//   SEASON  the game gear: the 119-day campaign map to Dec 15 (SeasonMap).
//
// Google Calendar is wired back in both directions: the private iCal feed
// reads into the timeline, and planned blocks push to Google Calendar with
// reminders via the OAuth editor (same idempotent replace-don't-stack contract
// the old Night screen proved out).

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import { diffDays, type DayItem, normalizeItems, sortItems, mergeItems, newItemId } from "@/lib/theGame";
import { mirrorCounts } from "@/lib/dayList";
import { fetchCalendarEvents, resolveBlocks, parseTime, type CalEvent } from "@/lib/calendar";
import { pushSchedule, acquireToken, everGranted, NeedsAuth } from "@/lib/gcal";
import { sfx, buzz } from "@/lib/fx";
import { Card, Eyebrow } from "./ui";
import Semester from "./Semester";
import ScheduleChat from "./ScheduleChat";
import SeasonMap from "./SeasonMap";
import LongGame from "./LongGame";
import CalendarLink from "./CalendarLink";

// The plan's blocks ARE the Card's checklist — same array, same objects.
type Ev = DayItem;
// Classes and calendar events are context, not checklist items: they are things
// that happen TO the day, so they are never scored and never carry a tick.
type Slot = { time: string; what: string };
type Goal = { id: string; title: string; due: string | null; status: string };
type Capture = { id: string; text: string };

const fmtNow = () => `${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`;

export default function PlanSpace({ uid }: { uid: string }) {
  const [mode, setMode] = useState<"today" | "goals" | "season">("today");
  const [items, setItems] = useState<Ev[]>([]);
  const [classes, setClasses] = useState<Slot[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [saving, setSaving] = useState("");
  const [err, setErr] = useState("");

  // calendar wiring
  const [icsUrl, setIcsUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [gcalIds, setGcalIds] = useState<string[]>([]);
  const [calEvents, setCalEvents] = useState<CalEvent[]>([]);
  const [calDay, setCalDay] = useState("");        // the day calEvents belong to
  const [calErr, setCalErr] = useState(false);
  // ticking clock — without it the "current block" indicator freezes at the
  // last render and the timeline lies after any idle stretch
  const [nowT, setNowT] = useState(() => fmtNow());
  const [pushMsg, setPushMsg] = useState("");
  const pushLock = useRef(false);
  const [pushing, setPushing] = useState(false);

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
      const [n, cb, g, c, us] = await Promise.all([
        supabase.from("nights").select("items,gcal_event_ids").eq("user_id", uid).eq("day", day).maybeSingle(),
        supabase.from("class_blocks").select("label,location,start_t").eq("user_id", uid).eq("weekday", new Date().getDay()).order("start_t"),
        supabase.from("goals").select("id,title,due,status").eq("user_id", uid).in("status", ["active"]).order("due", { ascending: true, nullsFirst: false }).order("title").limit(30),
        supabase.from("captures").select("id,text").eq("user_id", uid).eq("done", false).order("created_at", { ascending: false }).limit(30),
        supabase.from("user_settings").select("gcal_ics_url,gcal_client_id").eq("user_id", uid).maybeSingle(),
      ]);
      // a failed read must never render as "empty" — the first four feed core sections
      if (n.error || g.error || cb.error || c.error) { setLoadErr(true); setLoaded(true); return; }
      setItems(sortItems(normalizeItems(n.data?.items)));
      setGcalIds(((n.data?.gcal_event_ids ?? []) as string[]));
      setClasses(((cb.data ?? []) as { label: string; location: string; start_t: string }[])
        .map((x) => ({ time: x.start_t, what: `${x.label}${x.location ? ` · ${x.location}` : ""}` })));
      setGoals((g.data ?? []) as Goal[]);
      setCaptures((c.data ?? []) as Capture[]);
      // calendar settings are auxiliary — a failed read hides the feed, never the plan
      if (!us.error) {
        setIcsUrl((us.data?.gcal_ics_url as string) ?? "");
        setClientId((us.data?.gcal_client_id as string) ?? "");
      }
      dataDay.current = day;
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  // the private iCal feed → today's real calendar, merged into the timeline.
  // Recurring-series expansions stay hidden (classes already come from the
  // timetable — showing the series again would double every school day).
  useEffect(() => {
    if (!loaded || !icsUrl) return;
    const day = todayStr();
    if (calDay === day) return;
    let dead = false;
    (async () => {
      try {
        const evs = await fetchCalendarEvents(icsUrl, new Date());
        if (dead) return;
        setCalEvents(evs);   // repeating filtered at the TIMED derivation only —
        setCalDay(day); setCalErr(false);   // recurring all-day (rent, birthdays) still shows
      } catch { if (!dead) { setCalErr(true); setCalDay(day); } }
    })();
    return () => { dead = true; };
  }, [loaded, icsUrl, calDay]);

  // a thought captured from the global ＋ shows up here without a remount
  useEffect(() => {
    const onCap = () => load();
    window.addEventListener("daily:captured", onCap);
    return () => window.removeEventListener("daily:captured", onCap);
  }, [load]);

  // midnight rollover + the live clock (one interval covers both)
  useEffect(() => {
    const check = () => {
      setNowT(fmtNow());
      const now = todayStr();
      if (now !== dayRef.current) { dayRef.current = now; setCalDay(""); load(); }
    };
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    const id = setInterval(check, 30000);
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  // Every write goes through here so the plan and the Card can never disagree:
  // the list lands in nights.items, and its counts are mirrored into game_days,
  // which is what the streak, the week strip and the season map actually read.
  async function writeItems(next: Ev[], key: string) {
    if (saving) return false;
    const day = todayStr();
    if (day !== dataDay.current) { setErr("Midnight — the plan rolled over; refreshing."); load(); return false; }
    setSaving(key); setErr("");
    try {
      const sorted = sortItems(next);
      const { error } = await supabase.from("nights").upsert({ user_id: uid, day, items: sorted }, { onConflict: "user_id,day" });
      if (error) { setErr("Couldn't save the plan — try again."); return false; }
      setItems(sorted); sfx.pop();
      // a failed mirror is not worth losing the plan over — the Card reconciles
      // the counts the next time it loads
      await mirrorCounts(uid, day, sorted);
      return true;
    } catch { setErr("Couldn't reach the server — nothing saved."); return false; }
    finally { setSaving(""); }
  }

  async function addBlock() {
    const what = bWhat.trim();
    if (!what) return;
    const next = [...items, { id: newItemId(), time: bTime, what: what.slice(0, 120), src: "plan" as const }];
    const ok = await writeItems(next, "block");
    if (ok) { setBWhat(""); setBTime(""); }
  }

  async function removeBlock(i: number) {
    await writeItems(items.filter((_, k) => k !== i), `rm${i}`);
  }

  // Push today's planned blocks to Google Calendar — idempotent (replace, never
  // stack), and the returned ids are ALWAYS persisted: any old event whose
  // delete wasn't confirmed stays tracked so the next push can clean it up.
  // Drives both the manual "→ Google Cal" button and the chat's Apply, so the
  // idempotent replace-don't-stack contract has exactly one implementation.
  async function pushToCalendar(list?: Ev[]): Promise<{ ok: boolean; msg: string }> {
    const fail = (m: string) => { setPushMsg(m); return { ok: false, msg: m }; };
    if (pushLock.current) return { ok: false, msg: "Already pushing." };
    if (!clientId) return fail("Connect Google Calendar first (Legacy → Today has the one-time setup).");
    const day = todayStr();
    if (day !== dataDay.current) { setErr("Midnight — the plan rolled over; refreshing."); load(); return { ok: false, msg: "Day rolled over." }; }
    const source = (list ?? items).filter((x) => x?.what);
    const blocks = resolveBlocks(source, new Date());
    if (blocks.length === 0) return fail("Add times to the blocks first — untimed blocks can't become events.");
    pushLock.current = true; setPushing(true); setPushMsg("");
    try {
      // Re-read tracking from the DB right before pushing (same contract as
      // the proven Today/Night pushes): in-memory gcalIds can be a whole
      // desktop-push stale. Union with memory so a failed tracking write from
      // THIS session still self-heals.
      const idsRead = await supabase.from("nights").select("gcal_event_ids").eq("user_id", uid).eq("day", day).maybeSingle();
      if (idsRead.error) return fail("Couldn't check what's already on the calendar — nothing pushed. Try again.");
      const prevIds = [...new Set([...(((idsRead.data?.gcal_event_ids ?? []) as string[])), ...gcalIds])];
      let res = await pushSchedule(clientId, blocks, prevIds);
      if (res.needsAuth) {
        const t = await acquireToken(clientId, true);   // one interactive prompt, from this tap
        if (t) res = await pushSchedule(clientId, blocks, res.ids);
      }
      // THE INVARIANT: whatever pushSchedule returns describes reality on the
      // calendar, so it is tracked IMMEDIATELY — in memory first (an in-session
      // retry then self-heals even if the DB write below fails), then in the DB.
      setGcalIds(res.ids);
      // The tracking write deliberately does NOT touch `items` — a block added
      // while the push (or its OAuth popup) was in flight must survive.
      const { error } = await supabase.from("nights")
        .upsert({ user_id: uid, day, gcal_event_ids: res.ids }, { onConflict: "user_id,day" });
      if (error) return fail(`${res.created} on the calendar, but tracking didn't save. Push again from THIS screen to self-heal — after a reload, check Google Calendar first or you'll get duplicates.`);
      if (res.needsAuth) return fail(res.created > 0
        ? `Google needs a reconnect — ${res.created} of ${blocks.length} made it. Tap again and approve the popup (it replaces, won't duplicate).`
        : "Google needs a reconnect — tap again and approve the popup.");
      if (res.failed > 0 || res.kept > 0) return fail(`${res.created} on the calendar — ${res.failed > 0 ? `${res.failed} failed` : ""}${res.failed > 0 && res.kept > 0 ? ", " : ""}${res.kept > 0 ? `${res.kept} old couldn't be cleared (still tracked)` : ""}.`);
      const good = `${res.created} block${res.created === 1 ? "" : "s"} on Google Calendar, reminders set.`;
      setPushMsg(good);
      sfx.coin(); buzz(15);
      return { ok: true, msg: good };
    } catch (e) {
      return fail(e instanceof NeedsAuth ? "Google needs a reconnect — tap again." : "Couldn't reach Google Calendar — nothing changed there.");
    } finally { pushLock.current = false; setPushing(false); }
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

  // display/sort times canonicalized to 24h "HH:MM" — legacy Night rows carry
  // free text like "9:00" or "2:30" which lexically mis-sorts and can never
  // match the ticking clock. Writes still preserve the RAW strings.
  const canonTime = (t: string) => {
    const m = parseTime(t);
    return m === null ? t : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const planned = items.map((it, idx) => ({ time: canonTime(it?.time ?? ""), what: it?.what ?? "", idx })).filter((x) => x.what);
  // repeating TIMED series are hidden (classes already come from the timetable);
  // repeating all-day events (rent, birthdays) still earn their chip
  const calTimed = (calDay === todayStr() ? calEvents : []).filter((e) => !e.allDay && !e.repeating)
    .map((e) => {
      const d = new Date(e.start);
      return { time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, what: e.title, idx: -1 };
    });
  const calAllDay = (calDay === todayStr() ? calEvents : []).filter((e) => e.allDay);
  const timeline = [
    ...classes.map((c) => ({ ...c, kind: "class" as const, idx: -1 })),
    ...calTimed.map((c) => ({ ...c, kind: "cal" as const })),
    ...planned.map((p2) => ({ ...p2, kind: "plan" as const })),
  ].sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
  // the "current" block: the last timed entry that already started (nowT ticks)
  const currentIdx = timeline.reduce((cur, t, i) => (t.time && t.time <= nowT ? i : cur), -1);
  const daysTo = (due: string) => diffDays(todayStr(), due); // DST-proof (Math.round absorbs the ±1h)

  if (!loaded) return <div className="pt-3"><div className="skeleton h-24 mt-2" /><div className="skeleton h-24 mt-3" /></div>;
  if (loadErr) return <div className="pt-6"><button onClick={load} className="w-full rounded-xl bg-orange-500/15 text-orange-300 text-sm font-semibold py-3 active:scale-95">Couldn&apos;t load the plan — tap to retry</button></div>;

  return (
    <div className="pt-3">
      <div className="flex items-center justify-between mb-3">
        <h1 className="font-display text-2xl font-bold leading-none">Plan</h1>
        <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-[var(--border-1)]">
          {(["today", "goals", "season"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${mode === m ? "bg-[var(--neon)] text-black" : "opacity-55"}`}>
              {m === "today" ? "Today" : m === "goals" ? "Long game" : "Season"}
            </button>
          ))}
        </div>
      </div>

      {mode === "season" ? <SeasonMap uid={uid} /> : mode === "goals" ? <LongGame uid={uid} /> : (
        <>
          {/* Is the wire actually live? Proven with a real API read, not a flag. */}
          <CalendarLink clientId={clientId} />

          {/* Plan the day by talking. The AI returns the WHOLE revised day; it
              is shown as a preview and nothing is written until he taps Apply —
              and Apply can push straight to Google Calendar with reminders. */}
          <ScheduleChat
            dayLabel="today"
            items={items.filter((x) => x?.what).map((x) => ({ time: x.time, what: x.what }))}
            fixed={[
              ...classes.map((c) => ({ time: c.time, what: `${c.what} (class)` })),
              ...calTimed.map((c) => ({ time: c.time, what: `${c.what} (already on your calendar)` })),
            ]}
            onApply={(next) => writeItems(mergeItems(items, normalizeItems(next)), "chat")}
            onPush={clientId ? (next) => pushToCalendar(normalizeItems(next)) : undefined}
          />

          {/* TODAY — the shipping-tracker timeline */}
          <Card className="mt-3">
            <div className="flex items-center justify-between mb-2">
              <Eyebrow>Today</Eyebrow>
              {clientId ? (planned.length > 0 && (
                <button onClick={() => pushToCalendar()} disabled={pushing}
                  className="text-[10px] mono text-[var(--neon)] border border-[var(--neon)]/30 rounded-md px-2 py-1 active:scale-95 disabled:opacity-40">
                  {pushing ? "pushing…" : everGranted() ? "→ Google Cal" : "connect Google Cal"}
                </button>
              )) : (
                <span className="text-[10px] mono text-[var(--text-4)]">Google Cal not set up</span>
              )}
            </div>
            {calAllDay.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {calAllDay.map((e, i) => (
                  <span key={i} className="text-[10px] px-2 py-1 rounded-md bg-white/5 border border-[var(--border-1)] opacity-70">{e.title}</span>
                ))}
              </div>
            )}
            {timeline.length === 0 && <p className="text-sm opacity-40">Nothing planned yet — add the day&apos;s blocks below.</p>}
            <div className="space-y-0">
              {timeline.map((t, i) => {
                const past = !!t.time && t.time < nowT && i !== currentIdx;
                const current = i === currentIdx;
                return (
                  <div key={`${t.time}-${t.what}-${i}`}
                    className={`flex items-center gap-3 py-1.5 rounded-lg px-1.5 -mx-1.5 ${current ? "bg-[var(--raised)] border border-[var(--border-2)]" : ""}`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${current ? "bg-[var(--neon)] soft-pulse" : past ? "bg-[var(--ok)]" : "bg-white/20"}`} />
                    <span className={`mono text-xs w-11 shrink-0 ${past ? "opacity-30" : "opacity-50"}`}>{t.time || "—"}</span>
                    <span className={`text-sm flex-1 min-w-0 truncate ${past ? "opacity-35 line-through decoration-white/20" : t.kind !== "plan" ? "opacity-75" : ""}`}>
                      {t.what}
                      {t.kind === "class" && <span className="text-[9px] uppercase tracking-wider opacity-40 ml-2">class</span>}
                      {t.kind === "cal" && <span className="text-[9px] uppercase tracking-wider opacity-40 ml-2">cal</span>}
                    </span>
                    {t.kind === "plan" && (
                      <button onClick={() => removeBlock(t.idx)}
                        disabled={!!saving} className="opacity-25 text-xs active:scale-90 disabled:opacity-10">✕</button>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-1.5 mt-3">
              <input type="time" value={bTime} onChange={(e) => setBTime(e.target.value)} disabled={!!saving}
                className="rounded-lg bg-black/25 px-2.5 py-2 outline-none text-sm w-[6.4rem] shrink-0 mono" />
              <input value={bWhat} onChange={(e) => setBWhat(e.target.value)} disabled={!!saving}
                onKeyDown={(e) => { if (e.key === "Enter") addBlock(); }}
                placeholder="add a block…" className="flex-1 min-w-0 rounded-lg bg-black/25 px-3 py-2 outline-none text-sm" />
              <button onClick={addBlock} disabled={!!saving || !bWhat.trim()}
                className="px-3.5 rounded-lg bg-[var(--neon)] text-black text-sm font-bold active:scale-95 disabled:opacity-40">＋</button>
            </div>
            {calErr && <p className="text-[10px] text-orange-400/80 mt-2">Google Calendar feed didn&apos;t load — the plan above is still exact.</p>}
            {pushMsg && <p className="text-[10px] text-[var(--text-2)] mt-2">{pushMsg}</p>}
          </Card>

          {/* DEADLINES */}
          <Card className="mt-3">
            <Eyebrow className="mb-2">Deadlines — the dated thing wins</Eyebrow>
            {goals.length === 0 && <p className="text-sm opacity-40">Nothing dated. When the syllabi land Sept 1, every exam and paper goes here — and onto the season map.</p>}
            <div className="space-y-1.5">
              {goals.map((g) => {
                const d = g.due ? daysTo(g.due) : null;
                const toneCls = d !== null && d <= 3 ? "text-[var(--bad)]" : d !== null && d <= 7 ? "text-[var(--warn)]" : "opacity-45";
                return (
                  <div key={g.id} className="flex items-center gap-2.5 py-0.5">
                    <button onClick={() => completeGoal(g.id)} disabled={busyList.includes(g.id)}
                      className="w-5 h-5 rounded-md border border-white/25 shrink-0 active:scale-90 disabled:opacity-40 hover:border-[var(--ok)]" aria-label="done" />
                    <span className="text-sm flex-1 min-w-0 truncate">{g.title}</span>
                    {g.due && <span className={`text-[11px] mono shrink-0 ${toneCls}`}>{d === 0 ? "today" : d === 1 ? "tmrw" : d !== null && d < 0 ? `${-d}d late` : `${d}d`}</span>}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-1.5 mt-3">
              <input value={dTitle} onChange={(e) => setDTitle(e.target.value)} disabled={!!saving}
                onKeyDown={(e) => { if (e.key === "Enter") addDeadline(); }}
                placeholder="what has to happen…" className="flex-1 min-w-0 rounded-lg bg-black/25 px-3 py-2 outline-none text-sm" />
              <input type="date" value={dDue} onChange={(e) => setDDue(e.target.value)} disabled={!!saving}
                className="rounded-lg bg-black/25 px-2.5 py-2 outline-none text-sm w-[8.2rem] shrink-0 mono" />
              <button onClick={() => addDeadline()} disabled={!!saving || !dTitle.trim()}
                className="px-3.5 rounded-lg bg-[var(--neon)] text-black text-sm font-bold active:scale-95 disabled:opacity-40">＋</button>
            </div>
          </Card>

          {/* INBOX / parking lot */}
          {captures.length > 0 && (
            <Card className="mt-3">
              <Eyebrow className="mb-2">Inbox — park it or date it</Eyebrow>
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
        </>
      )}
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
    </div>
  );
}
