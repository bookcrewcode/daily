"use client";

// 📗 Learn — the home screen. One card that says what today is and one button
// that starts it; the notebooks live underneath as a library, not as the front
// door. The old screen led with a rotating "trunk of the day" line, which meant
// nothing on a Tuesday with an econ quiz on Friday. Now the picker decides
// (deadlines first, then what's gone stale) and the card explains its choice.
//
// Render order: cached plan summary instantly (localStorage) → learn_home RPC →
// buildSession → reconcile. The card is never blank and never a spinner.
//
// v50: the card leads with today's FIRST QUESTION, choices and all — the round
// starts on the tap that answers it, not on a Start button. A question pulls;
// "14 items · ~6 min" is a chore.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Rating } from "ts-fsrs";
import { supabase } from "@/lib/supabase";
import { useAIStatus } from "@/lib/aiStatus";
import { weekDays } from "@/lib/theGame";
import {
  buildSession, studyDay, linkedDeadlines, orderChapters, estimateMinutes, needsSettling, hashSeed,
  type SessionPlan, type SessionItem, type SessionResult, type LearnHome, type LearnSettings, type ChapterLite, type NotebookLite, type DeadlineLite, type RunCard,
} from "@/lib/session";
import { loadHome, fetchRun, ensureRun, buildChapters, prefetchNext, cachePlan, readPlanCache, settleOpenSession, type PlanCache } from "@/lib/learnApi";
import { patchLearn } from "@/lib/push";
import { sfx } from "@/lib/fx";
import { Card, SectionTitle, ProgressCircle } from "./ui";
import LearnBoundary from "./LearnBoundary";
import NotebookView from "./NotebookView";
import Session from "./Session";
import { ChoiceList } from "./SessionCards";
import ClassesCard from "./ClassesCard";
import RemindRow from "./RemindRow";

// What the home remembers between visits so the card can render before the
// network answers lives in learnApi (PLAN_CACHE_KEY): written here after every
// reconcile, read here for the instant render and by TheCard's Learn chip.
// `first` is the question the card leads with — cached so it paints offline.
type FirstQ = NonNullable<PlanCache["first"]>;

// user_settings.learn as the home reads it. The v50 fields (week goal, anchor,
// interests, reminder) ride along the same jsonb; LearnSettings is the planner's type.
type HomeLearn = LearnSettings & { week_goal?: number; interests?: string[]; nudge_on?: boolean; nudge_at?: string };

// What today's finished rounds banked and how the month's retention checks
// went, read from study_sessions.stats. null = the read failed (lines hidden,
// never faked as zeros).
type TodayStats = { chapterAsked: number; chapterRight: number; asked: number; right: number; misses: number; retentionAsked: number; retentionRight: number };
type MonthStats = { held: number; checks: number; today: TodayStats | null };

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short" });

// Runs (the cards for a chapter) keyed by chapter id, shared by the home,
// NotebookView and the prefetch. Module-level on purpose: it outlives a tab
// switch, so the run written on the Done screen is still here tomorrow morning
// without a refetch. A rebuilt notebook gets new chapter ids, so stale entries
// are never served.
const runCache: Record<string, RunCard[]> = {};
const daysUntil = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);

// `autostart` counts notification taps (page.tsx): each new value opens the
// round once, if the plan is ready to run.
export default function Notebooks({ uid, autostart, onGoFix }: { uid: string; autostart?: number; onGoFix?: () => void }) {
  return (
    <LearnBoundary>
      <LearnHomeScreen uid={uid} autostart={autostart ?? 0} onGoFix={onGoFix} />
    </LearnBoundary>
  );
}

function LearnHomeScreen({ uid, autostart, onGoFix }: { uid: string; autostart: number; onGoFix?: () => void }) {
  const ai = useAIStatus();
  const aiOff = ai === "off";
  const [cache, setCache] = useState<PlanCache | null>(() => (typeof window === "undefined" ? null : readPlanCache(uid)));
  const [home, setHome] = useState<LearnHome | null>(null);
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [month, setMonth] = useState<MonthStats | null>(null);
  const [homeErr, setHomeErr] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [prepErr, setPrepErr] = useState("");
  const [progress, setProgress] = useState("");        // the ONE progress line for build/prepare
  const [progressAt, setProgressAt] = useState(0);     // when the cards started being written — drives the stage line
  const [tomorrow, setTomorrow] = useState("");        // small "preparing tomorrow" line, never on the button
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [session, setSession] = useState<SessionPlan | null>(null);
  // the answer given on the card, handed to the Session so it counts as item 1
  const [initial, setInitial] = useState<SessionResult | null>(null);
  // a choice tapped while the plan was still loading — kept until it lands
  const [pick, setPick] = useState<{ id: string; k: number } | null>(null);
  const paintedAt = useRef(0);   // when the question first painted — the first answer's timing
  const autoHandled = useRef(0);
  const runs = runCache;
  const busy = useRef(false);
  // Chapters we already asked the AI to write this visit. If the plan still says
  // "preparing" for one of them, something upstream rejected the cards — show
  // the retry line instead of spending another 30s on a loop.
  const attempted = useRef<Set<string>>(new Set());

  const nbOf = useCallback((h: LearnHome | null, id: string | null | undefined): NotebookLite | null =>
    (h && id) ? h.notebooks.find((n) => n.id === id) ?? null : null, []);

  // Build the plan from a home; if the picked chapter's run is cached
  // server-side but not in memory yet, fetch it once and rebuild — otherwise a
  // notebook with a perfectly good run would show "writing cards" every visit.
  const reconcile = useCallback(async (h: LearnHome): Promise<SessionPlan> => {
    const opts = { now: new Date(), scope: "today" as const, aiOff };
    let p = buildSession(h, runs, opts);
    const ch = p.prepare?.chapter;
    if (p.state === "preparing" && ch && ch.has_run && !runs[ch.id]) {
      const cards = await fetchRun(ch.id);
      if (cards?.length) { runs[ch.id] = cards; p = buildSession(h, runs, opts); }
    }
    setPlan(p);
    // a resumed round's opener is the next item he has NOT answered yet
    const answered = p.state === "resume" ? (h.open_session?.results ?? []).map((r) => r.id) : undefined;
    cachePlan(uid, p, nbOf(h, p.notebookId ?? p.prepare?.notebookId)?.title ?? "", answered);
    // one writer (cachePlan) picks the first question; the card reads it back
    // rather than deriving it a second way
    setCache(readPlanCache(uid));
    return p;
  }, [aiOff, uid, nbOf, runs]);

  const reload = useCallback(async (): Promise<LearnHome | null> => {
    const [h, m] = await Promise.all([loadHome(uid, studyDay(new Date())), loadMonthStats(uid, studyDay(new Date()))]);
    setMonth(m);
    if (!h) { setHomeErr(true); setLoaded(true); return null; }
    // An open session past its last item, or one left open for three days, is
    // a finished round whose finish write never landed. Settle it — score,
    // chapter result, cards, XP, the same path as a normal finish — so the
    // answers in it still count, and the day's one open-row slot is free for
    // a fresh plan. Never flipped to 'done' bare: that would throw them away.
    // needsSettling is the same rule buildSession uses to refuse a resume, so
    // the planner and this repair can never disagree about a row.
    const os = h.open_session;
    if (os && os.status === "open" && needsSettling(os, studyDay(new Date()))) {
      h.open_session = null;
      await settleOpenSession(uid, os);
    }
    setHome(h); setHomeErr(false); setLoaded(true);
    await reconcile(h);
    return h;
  }, [uid, reconcile]);
  // deferred a microtask: the load's setState lands after its awaits, never
  // synchronously inside the effect body
  useEffect(() => { Promise.resolve().then(reload); }, [reload]);
  useEffect(() => { paintedAt.current = Date.now(); }, []);

  // Write the cards for a chapter and re-plan. `has_run` false means the AI
  // is about to spend ~30s, so say so; true means a quick re-read. `force`
  // (the retry tap) rewrites even when a run is cached — the cached one was
  // the thing buildSession just rejected.
  const prepare = useCallback(async (h: LearnHome, nb: NotebookLite, ch: ChapterLite, force = false) => {
    if (busy.current) return;
    if (attempted.current.has(ch.id) && !force) { setPrepErr(`Today's cards from ${nb.title} didn't come out usable. Tap to write them again.`); return; }
    attempted.current.add(ch.id);
    // A run already in memory for a chapter the plan still calls "preparing"
    // is one buildSession rejected — re-reading it would loop forever, so
    // rewrite it (the learn function skips its cache when `force` is set).
    const rewrite = force || !!runs[ch.id];
    busy.current = true; setPrepErr("");
    setProgress(ch.has_run && !rewrite ? "checking…" : preparingCopy(nb, ch, !!runs[ch.id]));
    setProgressAt(Date.now());
    try {
      // onNote: the cards came back but the server couldn't keep them — shown
      // on the small "tomorrow" line, since the round itself is fine to run
      const cards = await ensureRun(nb, ch, { ...(rewrite ? { force: true } : {}), onNote: setTomorrow });
      if (!cards?.length) { setPrepErr(`Couldn't write today's cards from ${nb.title}. Tap to try again.`); return; }
      runs[ch.id] = cards;
      await reconcile(h);
    } finally { busy.current = false; setProgress(""); setProgressAt(0); }
  }, [reconcile, runs]);

  // 'preparing' is rare (prefetch keeps runs cached) but when it shows it runs
  // itself — no button to tap first. Not while a notebook is open: its cold
  // start / "Study this now" owns the writing then, and a second writer here
  // would generate the same chapter twice.
  useEffect(() => {
    if (selected || !home || !plan || plan.state !== "preparing" || !plan.prepare?.chapter || progress || prepErr) return;
    const nb = nbOf(home, plan.prepare.notebookId);
    if (nb) prepare(home, nb, plan.prepare.chapter);
  }, [selected, home, plan, progress, prepErr, nbOf, prepare]);

  // Coming back to the tab: the run may have landed while we were away
  // (another device, the background prefetch). Re-read before regenerating —
  // reload() refreshes has_run and reconcile() then fetches the run instead of
  // asking the AI again.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible" || busy.current || plan?.state !== "preparing") return;
      setPrepErr(""); attempted.current.clear(); reload();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [plan?.state, reload]);

  // Tomorrow's chapter gets written now, while nothing is waiting on it.
  useEffect(() => {
    if (!home || !plan || plan.state === "ai-off" || plan.state === "preparing" || plan.state === "needs-chapters") return;
    const next = buildSession(home, runs, { now: new Date(Date.now() + 86400000), scope: "today", aiOff });
    if (next.prepare?.reason !== "no-run" || !next.prepare.chapter || next.prepare.chapter.has_run) return;
    let alive = true;
    const title = next.prepare.chapter.title;
    Promise.resolve().then(() => { if (alive) setTomorrow(`preparing tomorrow · ${title}`); return prefetchNext(home, runs, new Date()); })
      .finally(() => { if (alive) setTomorrow(""); });
    return () => { alive = false; };
  // runs only when the plan settles; re-running on every render would re-fire the prefetch
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.state, plan?.chapterId]);

  async function buildThenPrepare(nb: NotebookLite) {
    if (busy.current) return;
    busy.current = true; setPrepErr("");
    setProgress(`Building chapters for ${nb.title}… about 20 seconds`);
    try {
      const r = await buildChapters(uid, nb, [], false);
      if (r.error || r.added === 0) { setPrepErr(r.error || `Couldn't build chapters for ${nb.title} — try again.`); return; }
      const h = await loadHome(uid, studyDay(new Date()));
      if (!h) { setPrepErr("Chapters saved, but the screen couldn't refresh — switch tabs and come back."); return; }
      setHome(h);
      const first = orderChapters(nb, h.chapters)[0];
      if (first) {
        setProgress(`Chapters ready · writing chapter 1: ${first.title}… about 30 seconds`);
        const cards = await ensureRun(nb, first);
        if (cards?.length) runs[first.id] = cards;
      }
      await reconcile(h);
    } finally { busy.current = false; setProgress(""); }
  }

  const today = studyDay(new Date());
  const learn = (home?.settings ?? {}) as HomeLearn;
  // yesterday's cached question would be a stale promise — only today's paints
  const first: FirstQ | null = cache?.first && studyDay(new Date(cache.at)) === today ? cache.first : null;
  const eyebrow = learn.anchor ? `${learn.anchor}? One question.` : `Answer to start · ${first?.notebook ?? cache?.nb ?? ""}`;

  function openSession(p: SessionPlan) {
    if (p.items.length) setSession(p);
  }

  // The tap on a choice IS the start: the answer rides into the Session as
  // its first result. Only the plan knows which choice is right (the cache
  // carries the question, never the answer), so a tap before the plan lands
  // waits for it; a plan that no longer has that question just shows itself.
  function startWithAnswer(p: SessionPlan, id: string, k: number): boolean {
    if (session) return true;
    const it = p.items.find((x) => x.id === id);
    const card = it?.kind === "review" ? it.item : it;
    const answer = card && (card.kind === "mcq" || card.kind === "scenario") ? card.answer : null;
    if (!it || answer === null) return false;
    const ok = k === answer;
    setInitial({ id, ok, attempt: 1, ms: Date.now() - paintedAt.current, ...(it.kind === "review" ? { rating: ok ? Rating.Good : Rating.Again } : {}) });
    openSession(p);
    return true;
  }
  function answerFirst(k: number) {
    if (!first) return;
    if (plan && loaded) startWithAnswer(plan, first.id, k);
    else setPick({ id: first.id, k });
  }
  useEffect(() => {
    if (!pick || !plan || !loaded) return;
    Promise.resolve().then(() => { startWithAnswer(plan, pick.id, pick.k); setPick(null); });
  // startWithAnswer is a plain closure; the effect keys on the pick and the plan landing
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick, plan, loaded]);

  // A notification tap: the round starts on its own when there is one to run.
  // Any other state (preparing, nothing pasted) shows the card as usual.
  useEffect(() => {
    if (!autostart || autostart === autoHandled.current || !plan) return;
    autoHandled.current = autostart;
    if ((plan.state === "ready" || plan.state === "resume") && plan.items.length) Promise.resolve().then(() => setSession(plan));
  }, [autostart, plan]);

  // The plan's due cards as a round of their own, for the days the chapter
  // isn't ready (nothing pasted, no chapters, cards still being written) but
  // the reviews are. No chapter, no deadline pace: only what's actually in it.
  function reviewsOnly(p: SessionPlan): SessionPlan {
    const items = p.items.filter((it): it is Extract<SessionItem, { kind: "review" }> => it.kind === "review");
    const notebookIds = [...new Set(items.map((it) => it.card.notebook_id))];
    return {
      ...p, state: "ready", items, why: `Reviews only — ${items.length} cards`, chapterId: null,
      notebookIds, notebookId: notebookIds[0] ?? null, minutes: estimateMinutes(items.length), prepare: undefined, nextDeadline: null,
    };
  }

  // ── open notebook / session take over the screen ─────────────────────
  const openNb = nbOf(home, selected);
  if (session && home) {
    return (
      // onFinished fires BEFORE the done screen: the Session stays mounted (it
      // shows XP, what comes back, and writes tomorrow's run itself); the home
      // refreshes once Ben taps Done — reloading here would also start a second
      // prefetch of the same chapter next to the Session's own.
      <Session uid={uid} plan={session} resume={session.state === "resume" ? home.open_session : null} home={home} runs={runs}
        initialResult={initial ?? undefined}
        onClose={() => {
          // a failed chapter's run is REWRITTEN on the done screen — the copy in
          // memory would otherwise serve the old cards tomorrow if the app stays open
          if (session.chapterId) delete runCache[session.chapterId];
          setSession(null); setInitial(null); reload();
        }}
        onFinished={() => { /* done screen owns this moment; see above */ }} />
    );
  }
  if (openNb && home) {
    return <NotebookView uid={uid} notebook={openNb} home={home} runs={runs} aiOff={aiOff}
      onBack={() => { setSelected(null); reload(); }} onChanged={reload} />;
  }

  const todayNb = plan ? nbOf(home, plan.notebookId ?? plan.prepare?.notebookId) : null;
  const ready = loaded && !!home && !homeErr && !!plan;
  const remindable = ready && plan!.state !== "no-notebooks" && plan!.state !== "no-sources" && plan!.state !== "ai-off";

  return (
    <div>
      <h1 className="font-display text-2xl font-bold pt-3">Learn</h1>
      <WeekStrip today={today} days={home?.week_days ?? []} best={learn.best_week} goal={learn.week_goal} />
      {month && month.checks > 0 && (
        // what held, never what didn't: the checks are the honest measure of learning
        <p className="text-[11px] opacity-60 mt-1">Held: {month.held} of {month.checks} check{month.checks === 1 ? "" : "s"} this month</p>
      )}

      {/* ── Today ─────────────────────────────────────────────────── */}
      <Card tone="neon" className="mt-3">
        {!loaded ? (
          first && (cache?.state === "ready" || cache?.state === "resume") ? (
            // first paint, from the cache, offline: the question is already answerable
            <>
              <FirstQuestion first={first} eyebrow={eyebrow} waiting={!!pick} onAnswer={answerFirst} />
              {!pick && <p className="text-[11px] opacity-50 mt-2">checking…</p>}
            </>
          ) : cache ? (
            <>
              <p className="text-[10px] uppercase tracking-[0.2em] opacity-45">Today</p>
              <p className="font-semibold mt-0.5">{cacheLine(cache)}</p>
              <p className="text-[11px] opacity-50 mt-1">checking…</p>
            </>
          ) : (
            <div className="skeleton h-14" />
          )
        ) : homeErr || !home || !plan ? (
          <button onClick={reload} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">
            Couldn&apos;t load today&apos;s plan — tap to retry
          </button>
        ) : (
          <TodayCard plan={plan} home={home} nb={todayNb} first={first} eyebrow={eyebrow} todayStats={month?.today ?? null}
            progress={progress} progressAt={progressAt} prepErr={prepErr} tomorrow={tomorrow}
            onAnswer={answerFirst}
            onStart={() => openSession(plan)}
            onReviews={() => openSession(reviewsOnly(plan))}
            onNewNotebook={() => setCreating(true)}
            onOpen={(id) => setSelected(id)}
            onBuild={(nb) => buildThenPrepare(nb)}
            onRetry={() => { if (plan.prepare?.chapter && todayNb) prepare(home, todayNb, plan.prepare.chapter, true); }}
            onGoFix={onGoFix} />
        )}
        {remindable && <RemindRow uid={uid} nudgeOn={!!learn.nudge_on} nudgeAt={learn.nudge_at} onChanged={reload} />}
      </Card>

      {ready && <Tune uid={uid} learn={learn} onChanged={reload} />}

      {/* ── Library ───────────────────────────────────────────────── */}
      <SectionTitle>Your notebooks</SectionTitle>
      {!loaded ? (
        <div className="skeleton h-16" />
      ) : homeErr || !home ? (
        <button onClick={reload} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">Couldn&apos;t load your notebooks — tap to retry</button>
      ) : home.notebooks.length === 0 ? (
        <p className="opacity-40 text-sm">No notebooks yet — start one below. One name is all it needs.</p>
      ) : (
        <div className="space-y-2">
          {home.notebooks.map((n) => <LibraryCard key={n.id} nb={n} home={home} onOpen={() => setSelected(n.id)} />)}
        </div>
      )}

      {!creating ? (
        <button onClick={() => setCreating(true)} className="mt-4 w-full rounded-xl border border-dashed border-white/20 py-3 opacity-70 active:scale-95">+ New notebook</button>
      ) : (
        <NewNotebook uid={uid} onCancel={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            const h = await reload();
            if (h) setSelected(id);
          }} />
      )}

      {loaded && home && !homeErr && (
        <div className="mt-4">
          <ClassesCard uid={uid} notebooks={home.notebooks.map((n) => ({ id: n.id, title: n.title, course: n.course, course_key: n.course_key }))} onChanged={() => { reload(); }} />
        </div>
      )}

      <SectionTitle>How this works</SectionTitle>
      <div className="text-[12px] text-[var(--text-3)] leading-relaxed space-y-1">
        <p><b className="text-[var(--text-2)]">Review</b> — cards about to fade come first.</p>
        <p><b className="text-[var(--text-2)]">One chapter</b> — a short explanation, then questions you tap.</p>
        <p><b className="text-[var(--text-2)]">Wrong costs nothing</b> — it comes back in this round and again in a few days.</p>
      </div>
    </div>
  );
}

function cacheLine(c: PlanCache): string {
  if (c.state === "ready" || c.state === "resume") return `${c.nb ? c.nb + " · " : ""}${c.count} items · ~${c.minutes} min`;
  if (c.state === "done-today") return "Done for today ✓";
  return c.why || "Getting today ready";
}

// The wait is honest about what it is doing: a chapter with no videos yet has
// to find one and read its transcript before a card can carry a clip.
function preparingCopy(nb: NotebookLite, ch: ChapterLite, rewriting: boolean): string {
  if (!ch.clips_ready) return `Finding a real video and writing the cards from ${nb.title}… about a minute`;
  return `${rewriting ? "Rewriting" : "Writing"} today's cards from ${nb.title}… about 30 seconds`;
}

// Today's banked numbers and the month's retention checks, from the stats
// each finish writes. Rows carry `retention_asked/retention_ok` (v50) or the
// older `retention: {asked, right}`; both are read so old rounds still count.
async function loadMonthStats(uid: string, today: string): Promise<MonthStats | null> {
  try {
    const { data, error } = await supabase.from("study_sessions").select("day,scope,stats").eq("user_id", uid).eq("status", "done")
      .gte("day", `${today.slice(0, 8)}01`).order("finished_at", { ascending: true });
    if (error) return null;
    const rows = (data ?? []) as { day: string; scope: string; stats: Record<string, unknown> | null }[];
    const num = (s: Record<string, unknown>, k: string) => Number(s[k]) || 0;
    const ret = (s: Record<string, unknown>) => {
      const r = (s.retention ?? {}) as { asked?: number; right?: number };
      return { asked: Number(s.retention_asked ?? r.asked) || 0, right: Number(s.retention_ok ?? r.right) || 0 };
    };
    let held = 0, checks = 0;
    let todayStats: TodayStats | null = null;
    for (const row of rows) {
      const s = row.stats ?? {};
      const r = ret(s);
      held += r.right; checks += r.asked;
      // the quick feed never scores a chapter; the headline is about the round
      if (row.day === today && row.scope !== "quick") {
        todayStats = {
          chapterAsked: num(s, "chapter_asked"), chapterRight: num(s, "chapter_right"), asked: num(s, "asked"), right: num(s, "right"),
          misses: num(s, "misses"), retentionAsked: r.asked, retentionRight: r.right,
        };
      }
    }
    return { held, checks, today: todayStats };
  } catch { return null; }
}

// Leads with what banked — a count he earned — never a verdict on the day.
function bankedLine(s: TodayStats | null): string {
  if (!s) return "Done for today ✓";
  if (s.retentionAsked > 0) return `Check: ${s.retentionRight} of ${s.retentionAsked} held`;
  const back = s.misses ? `${s.misses} come${s.misses === 1 ? "s" : ""} back tomorrow` : "nothing comes back";
  if (s.chapterAsked > 0) return `Chapter: ${s.chapterRight} of ${s.chapterAsked} first try · ${back}`;
  if (s.asked > 0) return `Reviewed ${s.asked} · ${s.right} still there · ${back}`;
  return "Done for today ✓";
}

// ── The week, as seven dots ───────────────────────────────────────────
function WeekStrip({ today, days, best, goal }: { today: string; days: string[]; best?: number; goal?: number }) {
  const week = weekDays(today);
  const done = new Set(days);
  const count = week.filter((d) => done.has(d)).length;
  // "2 of 4" only once a day is lit — before that the goal would read as 0 of 4
  const line = count === 0 ? (best && best > 0 ? `Best week ${best}` : "Mon → Sun")
    : !goal ? `${count} ${count === 1 ? "day" : "days"} this week`
    : count >= goal ? `${count} of ${goal} — week done ✓` : `${count} of ${goal} this week`;
  return (
    <div className="flex items-center gap-3 mt-2">
      <div className="flex gap-1.5">
        {week.map((d, i) => {
          const hit = done.has(d);
          const isToday = d === today;
          return (
            <span key={d} className={`w-2.5 h-2.5 rounded-full ${hit ? "bg-[var(--neon)]" : isToday ? "bg-white/25 ring-1 ring-white/40" : "bg-white/10"}`}
              aria-label={`${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]}${hit ? " · studied" : ""}`} />
          );
        })}
      </div>
      {/* Never "0 of 7": before the first round of the week the dots stand alone. */}
      <p className="text-[11px] opacity-50">{line}</p>
    </div>
  );
}

// ── The first question, answerable on the card ────────────────────────
// The choices are SessionCards' own rows, so the tap feels like the round it
// starts. No pick state here: the Session shows the outcome, one screen later.
function FirstQuestion({ first, eyebrow, waiting, onAnswer }: { first: FirstQ; eyebrow: string; waiting: boolean; onAnswer: (k: number) => void }) {
  return (
    <>
      <p className="text-[11px] uppercase tracking-[0.18em] opacity-70">{eyebrow}</p>
      {first.situation && <p className="study-prose text-[0.95rem] mt-1.5 opacity-90">{first.situation}</p>}
      <p className="font-semibold text-[1.05rem] mt-1 mb-3">{first.stem}</p>
      {first.choices && first.choices.length > 0 && (
        // no answer here on purpose: the cache carries the question, never the key
        <ChoiceList choices={first.choices} seed={hashSeed(first.id)} disabled={waiting} onPick={onAnswer} />
      )}
      {waiting && <p className="text-[12px] opacity-70 mt-2">opening…</p>}
    </>
  );
}

// The three steps a fresh chapter goes through, the likely current one lit.
// Elapsed time is the only signal the function call gives back, so this is a
// hint about where it probably is, in the words of what is being done.
const STAGES = ["finding videos", "reading transcripts", "writing cards"];
function Stages({ since, videos }: { since: number; videos: boolean }) {
  const [s, setS] = useState(0);   // seconds elapsed, sampled by the interval (render stays pure)
  useEffect(() => { const t = setInterval(() => setS((Date.now() - since) / 1000), 5000); return () => clearInterval(t); }, [since]);
  const at = !videos ? 2 : s < 25 ? 0 : s < 45 ? 1 : 2;
  return (
    <p className="text-[11px] mt-1">
      {STAGES.map((w, i) => (
        <span key={w}>
          {i > 0 && <span className="opacity-70"> → </span>}
          <span className={i === at ? "text-[var(--neon)] font-semibold" : "opacity-70"}>{w}</span>
        </span>
      ))}
    </p>
  );
}

// ── The one card ──────────────────────────────────────────────────────
function TodayCard({ plan, home, nb, first, eyebrow, todayStats, progress, progressAt, prepErr, tomorrow, onAnswer, onStart, onReviews, onNewNotebook, onOpen, onBuild, onRetry, onGoFix }: {
  plan: SessionPlan; home: LearnHome; nb: NotebookLite | null; first: FirstQ | null; eyebrow: string; todayStats: TodayStats | null;
  progress: string; progressAt: number; prepErr: string; tomorrow: string;
  onAnswer: (k: number) => void; onStart: () => void; onReviews: () => void; onNewNotebook: () => void; onOpen: (id: string) => void;
  onBuild: (nb: NotebookLite) => void; onRetry: () => void; onGoFix?: () => void;
}) {
  const label = <p className="text-[10px] uppercase tracking-[0.2em] opacity-45">Today</p>;

  // When the chapter isn't ready but due cards are, the reviews don't have to
  // wait on the AI — a second button starts them on their own. While the cards
  // are being written it is THE thing to do, so it wears the primary colour.
  const reviews = plan.items.filter((it) => it.kind === "review").length;
  const canReview = reviews > 0 && (plan.state === "no-sources" || plan.state === "needs-chapters" || plan.state === "preparing");
  const reviewsBtn = canReview ? <Btn onClick={onReviews} dim={plan.state !== "preparing"}>Do the {reviews} review{reviews === 1 ? "" : "s"} now</Btn> : null;
  const chapter = plan.prepare?.chapter ?? null;

  // The question leads whenever the plan can run and the question is one of
  // its own (a resumed round may already have answered it). A flashcard first
  // (no choices) shows its front and keeps the button — a tap can't answer it.
  const answeredIds = new Set((home.open_session?.results ?? []).map((r) => r.id));
  const question = first && plan.items.some((it) => it.id === first.id) && !answeredIds.has(first.id) ? first : null;
  const tappable = !!question?.choices?.length;
  const summary = `${plan.items.length} items · ~${plan.minutes} min${plan.why ? ` · ${plan.why}` : ""}`;

  // A build or prepare in flight: one line, the steps under it, nothing else moving.
  if (progress) return <>{label}<p className="font-semibold mt-0.5">{nb?.title ?? "Getting ready"}</p><p className="text-[12px] opacity-60 mt-1">{progress}</p>
    {progressAt > 0 && chapter && <Stages since={progressAt} videos={!chapter.clips_ready} />}{reviewsBtn}</>;

  switch (plan.state) {
    case "ai-off":
      return <>{label}<p className="font-semibold mt-0.5">AI is off — chapters and cards need a key</p>
        <p className="text-[11px] opacity-55 mt-1">Reviewing cards you already have still works from a notebook.</p>
        {onGoFix && <Btn onClick={onGoFix}>Turn it on</Btn>}</>;
    case "no-notebooks":
      return <>{label}<p className="font-semibold mt-0.5">Start a notebook — paste anything you&apos;re learning and I&apos;ll build the first round</p>
        <Btn onClick={onNewNotebook}>+ New notebook</Btn></>;
    case "no-sources": {
      const target = nb ?? home.notebooks[0];
      return <>{label}<p className="font-semibold mt-0.5">Paste something into {target?.title ?? "a notebook"} to get started</p>
        <p className="text-[11px] opacity-55 mt-1">Notes, a PDF, a YouTube link — chapters get built from whatever you give it.</p>
        {target && <Btn onClick={() => onOpen(target.id)}>Open {target.title}</Btn>}
        {reviewsBtn}</>;
    }
    case "needs-chapters": {
      const n = nb ? home.source_counts[nb.id] ?? 0 : 0;
      return <>{label}<p className="font-semibold mt-0.5">{nb?.title} has {n} {n === 1 ? "source" : "sources"} but no chapters yet</p>
        {prepErr ? <p className="text-xs text-orange-300 mt-1">{prepErr}</p> : null}
        {nb && <Btn onClick={() => onBuild(nb)}>Build chapters (about 20s)</Btn>}
        {reviewsBtn}</>;
    }
    case "preparing":
      return <>{label}<p className="font-semibold mt-0.5">{nb?.title ?? "Today"}</p>
        {prepErr
          ? <button onClick={onRetry} className="mt-2 w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95 text-left px-3">{prepErr}</button>
          : <p className="text-[12px] opacity-60 mt-1">{nb && chapter ? preparingCopy(nb, chapter, false) : "Writing today's cards… about 30 seconds"}</p>}
        {reviewsBtn}</>;
    case "resume": {
      const os = home.open_session as { plan?: unknown[]; pos?: number } | null;
      const left = Math.max(0, (Array.isArray(os?.plan) ? os!.plan!.length : plan.items.length) - (os?.pos ?? 0));
      if (question) return <>
        <FirstQuestion first={question} eyebrow={eyebrow} waiting={false} onAnswer={onAnswer} />
        <p className="text-[11px] opacity-55 mt-3">Picking up where you left off · {left} left{nb ? ` · ${nb.title}` : ""}</p>
        {!tappable && <Btn onClick={onStart}>Continue</Btn>}</>;
      return <>{label}<p className="font-semibold mt-0.5">Pick up where you left off · {left} left</p>
        {nb && <p className="text-[11px] opacity-55 mt-1">{nb.title}</p>}
        <Btn onClick={onStart}>Continue</Btn></>;
    }
    case "done-today": {
      // also the "all caught up" state: no chapter left to learn and nothing
      // to review, whether or not a round happened today
      const studied = home.done_today;
      const optional = "Another round is optional — reviews you do now still count.";
      if (question) return <>
        <p className="text-[11px] opacity-55">{studied ? bankedLine(todayStats) : "All caught up ✓"}</p>
        <div className="mt-2"><FirstQuestion first={question} eyebrow={`One more, if you like · ${question.notebook}`} waiting={false} onAnswer={onAnswer} /></div>
        <p className="text-[11px] opacity-55 mt-3">{summary} · {optional}</p>
        {tomorrow && <p className="text-[11px] opacity-40 mt-1">{tomorrow}</p>}
        {!tappable && <Btn onClick={onStart} dim>One more round · {plan.items.length} items</Btn>}</>;
      return <>{label}<p className="font-semibold mt-0.5">{studied ? bankedLine(todayStats) : "All caught up ✓"}</p>
        <p className="text-[11px] opacity-55 mt-1">
          {plan.items.length > 0 ? optional
            : studied ? "Nothing more is waiting. Tomorrow's round is set up from what you missed."
            : plan.why || "Nothing is waiting — add sources to a notebook, or start a new one."}
        </p>
        {tomorrow && <p className="text-[11px] opacity-40 mt-1">{tomorrow}</p>}
        {plan.items.length > 0
          ? <Btn onClick={onStart} dim>One more round · {plan.items.length} items</Btn>
          : <Btn onClick={onNewNotebook} dim>+ New notebook</Btn>}</>;
    }
    case "ready":
    default: {
      const dl = plan.nextDeadline ?? (nb ? linkedDeadlines(nb, home.deadlines)[0] ?? null : null);
      // the question first; the count and the reason move under it. A round
      // that opens on a flashcard (no choices) keeps the Start button.
      return <>
        {question
          ? <FirstQuestion first={question} eyebrow={eyebrow} waiting={false} onAnswer={onAnswer} />
          : <>{label}<p className="font-semibold mt-0.5">Today · {nb?.title ?? "Review"}</p></>}
        <p className={`text-[11px] opacity-55 ${question ? "mt-3" : "mt-1"}`}>{summary}</p>
        {dl && <UrgencyLine d={dl} />}
        {tomorrow && <p className="text-[11px] opacity-40 mt-1">{tomorrow}</p>}
        {!tappable && <Btn onClick={onStart}>Start</Btn>}</>;
    }
  }
}

// ── Tune: week goal · anchor · interests — one picker each, once ──────
// Three settings the round is shaped by. Each is asked once, then folds into
// one line; nothing here needs typing (a text field for an interest is optional).
const GOALS = [3, 4, 5, 6];
const ANCHORS = ["Waiting for an order", "Between classes", "In bed", "After a drop"];
const NO_ANCHOR = "no anchor";
const SEED_INTERESTS = ["DoorDash and Uber Eats driving around New Brunswick", "BookCrew, my business", "RegimeBot, my paper-trading bot", "chess"];
const SUGGESTED_INTERESTS = ["Rutgers", "Basketball", "Cooking", "Cars", "Money and investing", "Gym and lifting", "Music", "Video games", "Poker", "Fantasy football"];
const MAX_INTERESTS = 6;
// the seed is written once per visit; a second attempt waits for the next open
let seededInterests = false;

function Tune({ uid, learn, onChanged }: { uid: string; learn: HomeLearn; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const needGoal = learn.week_goal == null;
  const needAnchor = learn.anchor === undefined;   // "" = he chose no anchor
  const interests = learn.interests ?? SEED_INTERESTS;

  async function save(key: string, patch: Record<string, unknown>) {
    if (busy) return;
    setBusy(key); setErr("");
    const { error } = await patchLearn(uid, patch);
    setBusy("");
    if (error) { setErr(error); return; }
    sfx.pop();
    onChanged();
  }

  // Ben's four interests, seeded once so the first lesson is already set in his world.
  useEffect(() => {
    if (learn.interests !== undefined || seededInterests) return;
    seededInterests = true;
    patchLearn(uid, { interests: SEED_INTERESTS }).then(({ error }) => { if (error) setErr(error); else onChanged(); });
  // runs once per visit; onChanged is the home's reload
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learn.interests, uid]);

  const chip = (label: string, on: boolean, onClick: () => void, key = label) => (
    <button key={key} onClick={onClick} disabled={!!busy}
      className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold border active:scale-95 disabled:opacity-40 ${on ? "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40" : "bg-white/5 border-[var(--border-1)]"}`}>
      {label}
    </button>
  );
  const ask = "text-[12px] text-[var(--text-2)] font-semibold";
  const addable = SUGGESTED_INTERESTS.filter((s) => !interests.includes(s));
  const addInterest = (s: string) => {
    const v = s.trim().slice(0, 80);
    if (!v || interests.includes(v) || interests.length >= MAX_INTERESTS) return;
    setAdding(false); setTyped("");
    save("interests", { interests: [...interests, v] });
  };

  if (!needGoal && !needAnchor && !open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-2 w-full text-left text-[11px] opacity-60 active:scale-[0.99]">
        Tune · {learn.week_goal} days a week · {learn.anchor || NO_ANCHOR} · {interests.length} interest{interests.length === 1 ? "" : "s"} ▾
      </button>
    );
  }
  return (
    <Card className="mt-2 space-y-3">
      <div>
        <p className={ask}>How many days this week feels right?</p>
        <p className="text-[11px] opacity-55">The dots up top count toward it. Pick what a normal week can carry, not a heroic one.</p>
        <div className="flex gap-1.5 mt-2">{GOALS.map((g) => chip(String(g), learn.week_goal === g, () => save("goal", { week_goal: g })))}</div>
      </div>
      <div>
        <p className={ask}>When does a round fit?</p>
        <p className="text-[11px] opacity-55">The card asks its first question there — &ldquo;Between classes? One question.&rdquo;</p>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {ANCHORS.map((a) => chip(a, learn.anchor === a, () => save("anchor", { anchor: a })))}
          {chip(NO_ANCHOR, learn.anchor === "", () => save("anchor", { anchor: "" }))}
        </div>
      </div>
      <div>
        <p className={ask}>Your interests — at least one card a round is set in one of them</p>
        <p className="text-[11px] opacity-55">Tap one to drop it · up to {MAX_INTERESTS}.</p>
        <div className="flex flex-wrap gap-1.5 mt-2">
          {interests.map((s) => chip(`${s} ✕`, true, () => save("interests", { interests: interests.filter((x) => x !== s) }), s))}
          {interests.length < MAX_INTERESTS && chip(adding ? "close" : "+", false, () => setAdding((a) => !a), "+")}
        </div>
        {adding && (
          <div className="mt-2">
            <div className="flex flex-wrap gap-1.5">{addable.map((s) => chip(s, false, () => addInterest(s)))}</div>
            <div className="flex gap-1.5 mt-2">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addInterest(typed)}
                placeholder="or type one (optional)" className="flex-1 min-w-0 rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
              <button onClick={() => addInterest(typed)} disabled={!typed.trim() || !!busy}
                className="rounded-lg bg-[var(--neon)] text-black text-sm font-bold px-3 active:scale-95 disabled:opacity-40">add</button>
            </div>
          </div>
        )}
      </div>
      {err && <p className="text-xs text-orange-300">{err}</p>}
      {!needGoal && !needAnchor && <button onClick={() => setOpen(false)} className="text-[11px] opacity-60 underline active:scale-95">done ▴</button>}
    </Card>
  );
}

// The one button. `dim` is for the optional action (one more round), so the
// primary colour always means "the thing to do".
function Btn({ onClick, children, dim }: { onClick: () => void; children: ReactNode; dim?: boolean }) {
  return <button onClick={onClick} className={`mt-3 w-full rounded-xl py-3 font-bold active:scale-95 ${dim ? "bg-white/10" : "bg-[var(--neon)] text-black"}`}>{children}</button>;
}

// One line, only when a linked deadline is inside a week — the reason this
// notebook came first. "start by" is the deadline's lead date, not the due date.
function UrgencyLine({ d }: { d: DeadlineLite }) {
  const n = daysUntil(d.due_at);
  if (n > 7 || n < 0) return null;
  const when = n === 0 ? "today" : n === 1 ? "tomorrow" : `${dayLabel(d.due_at)} · ${n} days`;
  return <p className="text-[11px] text-[var(--neon)] mt-1">{d.course || "Class"} {d.kind} {when}{d.start_by ? ` — start by ${dayLabel(d.start_by)}` : ""}</p>;
}

// ── Library card: ring fills as chapters are done ─────────────────────
function LibraryCard({ nb, home, onOpen }: { nb: NotebookLite; home: LearnHome; onOpen: () => void }) {
  const chs = home.chapters.filter((c) => c.notebook_id === nb.id);
  const total = chs.length;
  const done = chs.filter((c) => c.status === "done").length;
  const passed = chs.filter((c) => c.status === "passed").length;
  const best = chs.reduce((m, c) => Math.max(m, c.best_score || 0), 0);
  const review = home.due_cards.filter((c) => c.notebook_id === nb.id).length;
  // a passed chapter is half a fill: it counts once the check holds
  const fill = total ? (done + passed * 0.5) / total : 0;
  return (
    <button onClick={onOpen} className="w-full text-left">
      <Card padded={false} className="p-3.5">
        <div className="flex items-center gap-3">
          <ProgressCircle pct={fill} size={44} stroke={4}>
            <span className="text-lg">{nb.emoji || "📓"}</span>
          </ProgressCircle>
          <div className="min-w-0 flex-1">
            <p className="font-bold truncate">
              {nb.title}
              {nb.course && <span className="ml-2 text-[9px] uppercase tracking-wider text-[var(--text-3)] font-semibold">{nb.course}</span>}
            </p>
            <p className="text-[11px] opacity-55 truncate">
              {total === 0
                ? (home.source_counts[nb.id] ? "sources in, no chapters yet" : "empty — paste something in")
                : `${done} of ${total} chapters${passed ? ` · ${passed} passed` : ""}${best ? ` · best ${best}%` : ""}`}
            </p>
          </div>
          {review > 0 && <span className="text-[10px] font-semibold text-[var(--neon)] shrink-0">{review} to review</span>}
        </div>
      </Card>
    </button>
  );
}

// ── Cold start: one field ─────────────────────────────────────────────
const EMOJI_BY_WORD: [RegExp, string][] = [
  [/econ|finance|market|account/i, "📈"], [/calc|math|algebra|stat/i, "📐"], [/bio|anatomy|genet/i, "🧬"],
  [/chem/i, "🧪"], [/physic|astro/i, "⚛️"], [/hist|polit|gov/i, "🏛️"], [/psych|neuro|brain/i, "🧠"],
  [/cs|comput|program|code|software|data/i, "💻"], [/law|legal|ethic/i, "⚖️"], [/writ|english|lit|essay/i, "✍️"],
  [/spanish|french|chinese|language|lang/i, "🗣️"], [/business|market|manage/i, "💼"], [/music|guitar|piano/i, "🎸"],
];
function autoEmoji(title: string, course: string): string {
  const s = `${title} ${course}`;
  return EMOJI_BY_WORD.find(([re]) => re.test(s))?.[1] ?? "📓";
}

function NewNotebook({ uid, onCreated, onCancel }: { uid: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [course, setCourse] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // a course code is what makes it a class — nothing else to pick
  const kind = course.trim() ? "class" : "personal";

  async function create() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true); setErr("");
    try {
      const { data, error } = await supabase.from("notebooks")
        .insert({ user_id: uid, title: t.slice(0, 160), course: course.trim().slice(0, 40), kind, emoji: autoEmoji(t, course) })
        .select("id").single();
      if (error || !data) { setErr("Couldn't create that — try again."); setBusy(false); return; }
      sfx.coin();
      onCreated((data as { id: string }).id);
    } catch { setErr("Couldn't reach the server — try again."); setBusy(false); }
  }

  return (
    <Card className="mt-4">
      <p className="text-xs uppercase tracking-widest opacity-60 mb-2">New notebook</p>
      <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} autoFocus placeholder="name it (e.g. Econ 201, Options trading)"
        onKeyDown={(e) => e.key === "Enter" && create()}
        className="w-full rounded-lg bg-black/30 px-3 py-2.5 outline-none text-sm mb-2" />
      <input value={course} onChange={(e) => setCourse(e.target.value)} disabled={busy} placeholder="course code, if it's a class (optional — e.g. ECON 201)"
        onKeyDown={(e) => e.key === "Enter" && create()}
        className="w-full rounded-lg bg-black/30 px-3 py-2.5 outline-none text-sm mb-1" />
      <p className="text-[11px] opacity-50 mb-3">
        {kind === "class" ? "Class — chapters by week, jump anywhere. Canvas deadlines with this code link here." : "Personal — one chapter at a time."}
      </p>
      <div className="flex gap-2">
        <button onClick={onCancel} disabled={busy} className="flex-1 rounded-xl bg-white/10 py-2.5 text-sm font-semibold active:scale-95 disabled:opacity-40">Cancel</button>
        <button onClick={create} disabled={busy || !title.trim()} className="flex-1 rounded-xl bg-[var(--neon)] text-black py-2.5 text-sm font-bold active:scale-95 disabled:opacity-40">
          {busy ? "creating…" : `Create ${autoEmoji(title, course)}`}
        </button>
      </div>
      {!title.trim() && !busy && <p className="text-[11px] opacity-40 mt-2">A name is all it needs — paste your material on the next screen.</p>}
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
    </Card>
  );
}
