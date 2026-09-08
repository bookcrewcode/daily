"use client";

// 📗 Learn — the home screen. One card that says what today is and one button
// that starts it; the notebooks live underneath as a library, not as the front
// door. The old screen led with a rotating "trunk of the day" line, which meant
// nothing on a Tuesday with an econ quiz on Friday. Now the picker decides
// (deadlines first, then what's gone stale) and the card explains its choice.
//
// Render order: cached plan summary instantly (localStorage) → learn_home RPC →
// buildSession → reconcile. The card is never blank and never a spinner.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import { useAIStatus } from "@/lib/aiStatus";
import { weekDays } from "@/lib/theGame";
import {
  buildSession, studyDay, linkedDeadlines, orderChapters, estimateMinutes, needsSettling,
  type SessionPlan, type SessionItem, type LearnHome, type ChapterLite, type NotebookLite, type DeadlineLite, type RunCard,
} from "@/lib/session";
import { loadHome, fetchRun, ensureRun, buildChapters, prefetchNext, cachePlan, readPlanCache, settleOpenSession, type PlanCache } from "@/lib/learnApi";
import { sfx } from "@/lib/fx";
import { Card, SectionTitle, ProgressCircle } from "./ui";
import LearnBoundary from "./LearnBoundary";
import NotebookView from "./NotebookView";
import Session from "./Session";
import ClassesCard from "./ClassesCard";

// What the home remembers between visits so the card can render before the
// network answers lives in learnApi (PLAN_CACHE_KEY): written here after every
// reconcile, read here for the instant render and by TheCard's Learn chip.

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short" });

// Runs (the cards for a chapter) keyed by chapter id, shared by the home,
// NotebookView and the prefetch. Module-level on purpose: it outlives a tab
// switch, so the run written on the Done screen is still here tomorrow morning
// without a refetch. A rebuilt notebook gets new chapter ids, so stale entries
// are never served.
const runCache: Record<string, RunCard[]> = {};
const daysUntil = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);

export default function Notebooks({ uid, onGoFix }: { uid: string; onGoFix?: () => void }) {
  return (
    <LearnBoundary>
      <LearnHomeScreen uid={uid} onGoFix={onGoFix} />
    </LearnBoundary>
  );
}

function LearnHomeScreen({ uid, onGoFix }: { uid: string; onGoFix?: () => void }) {
  const ai = useAIStatus();
  const aiOff = ai === "off";
  const [cache] = useState<PlanCache | null>(() => (typeof window === "undefined" ? null : readPlanCache(uid)));
  const [home, setHome] = useState<LearnHome | null>(null);
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [homeErr, setHomeErr] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [prepErr, setPrepErr] = useState("");
  const [progress, setProgress] = useState("");        // the ONE progress line for build/prepare
  const [tomorrow, setTomorrow] = useState("");        // small "preparing tomorrow" line, never on the button
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [session, setSession] = useState<SessionPlan | null>(null);
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
    cachePlan(uid, p, nbOf(h, p.notebookId ?? p.prepare?.notebookId)?.title ?? "");
    return p;
  }, [aiOff, uid, nbOf, runs]);

  const reload = useCallback(async (): Promise<LearnHome | null> => {
    const h = await loadHome(uid, studyDay(new Date()));
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
    setProgress(ch.has_run && !rewrite ? "checking…" : `${runs[ch.id] ? "Rewriting" : "Writing"} today's cards from ${nb.title}… about 30 seconds`);
    try {
      const cards = await ensureRun(nb, ch, rewrite ? { force: true } : undefined);
      if (!cards?.length) { setPrepErr(`Couldn't write today's cards from ${nb.title}. Tap to try again.`); return; }
      runs[ch.id] = cards;
      await reconcile(h);
    } finally { busy.current = false; setProgress(""); }
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

  function openSession(p: SessionPlan) {
    if (p.items.length) setSession(p);
  }

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
      <Session uid={uid} plan={session} resume={session.state === "resume" ? home.open_session : null} home={home}
        onClose={() => { setSession(null); reload(); }}
        onFinished={() => { /* done screen owns this moment; see above */ }} />
    );
  }
  if (openNb && home) {
    return <NotebookView uid={uid} notebook={openNb} home={home} runs={runs} aiOff={aiOff}
      onBack={() => { setSelected(null); reload(); }} onChanged={reload} />;
  }

  const today = studyDay(new Date());
  const todayNb = plan ? nbOf(home, plan.notebookId ?? plan.prepare?.notebookId) : null;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold pt-3">Learn</h1>
      <WeekStrip today={today} days={home?.week_days ?? []} best={home?.settings?.best_week} />

      {/* ── Today ─────────────────────────────────────────────────── */}
      <Card tone="neon" className="mt-3">
        {!loaded ? (
          cache ? (
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
          <TodayCard plan={plan} home={home} nb={todayNb} progress={progress} prepErr={prepErr} tomorrow={tomorrow}
            onStart={() => openSession(plan)}
            onReviews={() => openSession(reviewsOnly(plan))}
            onNewNotebook={() => setCreating(true)}
            onOpen={(id) => setSelected(id)}
            onBuild={(nb) => buildThenPrepare(nb)}
            onRetry={() => { if (plan.prepare?.chapter && todayNb) prepare(home, todayNb, plan.prepare.chapter, true); }}
            onGoFix={onGoFix} />
        )}
      </Card>

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
      <p className="text-[12px] text-[var(--text-3)] leading-relaxed">
        Each day is one short round. It starts with <b>review</b> — cards from earlier rounds that are about to fade, so a few
        minutes keeps them — then one chapter: a short explanation, then questions you tap through. A wrong answer costs nothing;
        it just comes back later in the round and again in a few days. A chapter is <b>passed</b> when you get 80% right on the
        first try, and <b>done</b> when a quick check two or three days later still holds. The card above picks the notebook:
        a class with a deadline coming up goes first, then whatever you haven&apos;t touched longest — the line under the title
        says why.
      </p>
    </div>
  );
}

function cacheLine(c: PlanCache): string {
  if (c.state === "ready" || c.state === "resume") return `${c.nb ? c.nb + " · " : ""}${c.count} items · ~${c.minutes} min`;
  if (c.state === "done-today") return "Done for today ✓";
  return c.why || "Getting today ready";
}

// ── The week, as seven dots ───────────────────────────────────────────
function WeekStrip({ today, days, best }: { today: string; days: string[]; best?: number }) {
  const week = weekDays(today);
  const done = new Set(days);
  const count = week.filter((d) => done.has(d)).length;
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
      <p className="text-[11px] opacity-50">
        {count > 0 ? `${count} ${count === 1 ? "day" : "days"} this week` : best && best > 0 ? `Best week ${best}` : "Mon → Sun"}
      </p>
    </div>
  );
}

// ── The one card ──────────────────────────────────────────────────────
function TodayCard({ plan, home, nb, progress, prepErr, tomorrow, onStart, onReviews, onNewNotebook, onOpen, onBuild, onRetry, onGoFix }: {
  plan: SessionPlan; home: LearnHome; nb: NotebookLite | null; progress: string; prepErr: string; tomorrow: string;
  onStart: () => void; onReviews: () => void; onNewNotebook: () => void; onOpen: (id: string) => void; onBuild: (nb: NotebookLite) => void;
  onRetry: () => void; onGoFix?: () => void;
}) {
  const label = <p className="text-[10px] uppercase tracking-[0.2em] opacity-45">Today</p>;

  // When the chapter isn't ready but due cards are, the reviews don't have to
  // wait on the AI — a second, dimmer button starts them on their own.
  const reviews = plan.items.filter((it) => it.kind === "review").length;
  const canReview = reviews > 0 && (plan.state === "no-sources" || plan.state === "needs-chapters" || plan.state === "preparing");
  const reviewsBtn = canReview ? <Btn onClick={onReviews} dim>Do the {reviews} review{reviews === 1 ? "" : "s"} now</Btn> : null;

  // A build or prepare in flight: one line, nothing else moving.
  if (progress) return <>{label}<p className="font-semibold mt-0.5">{nb?.title ?? "Getting ready"}</p><p className="text-[12px] opacity-60 mt-1">{progress}</p>{reviewsBtn}</>;

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
          : <p className="text-[12px] opacity-60 mt-1">Writing today&apos;s cards from {nb?.title ?? "your notebook"}… about 30 seconds</p>}
        {reviewsBtn}</>;
    case "resume": {
      const os = home.open_session as { plan?: unknown[]; pos?: number } | null;
      const left = Math.max(0, (Array.isArray(os?.plan) ? os!.plan!.length : plan.items.length) - (os?.pos ?? 0));
      return <>{label}<p className="font-semibold mt-0.5">Pick up where you left off · {left} left</p>
        {nb && <p className="text-[11px] opacity-55 mt-1">{nb.title}</p>}
        <Btn onClick={onStart}>Continue</Btn></>;
    }
    case "done-today": {
      // also the "all caught up" state: no chapter left to learn and nothing
      // to review, whether or not a round happened today
      const studied = home.done_today;
      return <>{label}<p className="font-semibold mt-0.5">{studied ? "Done for today ✓" : "All caught up ✓"}</p>
        <p className="text-[11px] opacity-55 mt-1">
          {plan.items.length > 0 ? "Another round is optional — reviews you do now still count."
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
      return <>{label}
        <p className="font-semibold mt-0.5">Today · {nb?.title ?? "Review"} · {plan.items.length} items · ~{plan.minutes} min</p>
        {plan.why && <p className="text-[11px] opacity-55 mt-1">{plan.why}</p>}
        {dl && <UrgencyLine d={dl} />}
        {tomorrow && <p className="text-[11px] opacity-40 mt-1">{tomorrow}</p>}
        <Btn onClick={onStart}>Start</Btn></>;
    }
  }
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
