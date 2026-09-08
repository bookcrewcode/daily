"use client";

// 🎮 SESSION — today's round: spaced reviews, then one chapter, then the
// retries. Fullscreen, tap-only, honest about what saved and what didn't.
//
// The plan comes in already decided (session.ts). This component's job is to
// walk it: keep the working state per item, buffer results and flush them
// every few answers, re-ask misses in the retry slots, and finish in the order
// that keeps the done screen truthful (chapter → session → misses → XP).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Rating, type Grade } from "ts-fsrs";
import { advisorCall } from "@/lib/notebook";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { sfx, xpToast } from "@/lib/fx";
import {
  addDays, buildSession, chaptersLeft, daysBetween, hashSeed, localDay, scoreSession, stemOf, studyDay, PASS_PCT, RETRY_SLOTS,
  type ChapterLite, type LearnHome, type SessionItem, type SessionPlan, type SessionResult, type SessionScore, type StudySessionRow, type RunCard,
} from "@/lib/session";
import { fetchRun, finishSession, flushResults, predictNext, prefetchNext, rateReviewFresh, startSession, type ChapterOutcome } from "@/lib/learnApi";
import { QuestionCard, ReviewCard, TeachCard, WorkedCard, type AnswerDetail } from "./SessionCards";

type ChapterItem = Extract<SessionItem, { chapter_id: string }>;
type ReviewItem = Extract<SessionItem, { kind: "review" }>;
type Phase = "run" | "finishing" | "done";
type Done = {
  score: SessionScore; xp: number; note: string; chapter: ChapterOutcome | null;
  tomorrow: { chapter: ChapterLite | null; run: RunCard[] | null } | null; home: LearnHome;
};

const FLUSH_EVERY = 3;
const PREFETCH_WAIT_MS = 8000;
const FAST_MS = 4000;
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const isChapterItem = (it: SessionItem): it is ChapterItem => it.kind !== "review";
// wall clock for answer timing — only ever called from tap handlers, never during render
const now = () => Date.now();
const weekdayOf = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
const shortDate = (day: string) => `${weekdayOf(day)} ${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); }); });
}
// Misses that come back: the re-ask id is the original id with a suffix so
// scoring can tie attempt 2 to attempt 1.
const reaskOf = (it: SessionItem): SessionItem => ({ ...it, id: `${it.id}#2`, ...(isChapterItem(it) ? { reask: true, pretest: false } : {}) });
const canReask = (it: SessionItem) => (isChapterItem(it) ? it.kind !== "teach" && !it.pretest : !!it.item);
// The home as the database now sees it, so tomorrow's prediction doesn't pick
// today's chapter again and "one more round" skips what was just reviewed.
function patchHome(home: LearnHome, chapterId: string | null, outcome: ChapterOutcome | null, answered: Set<string>): LearnHome {
  return {
    ...home, done_today: true, open_session: null,
    chapters: home.chapters.map((c) => (c.id === chapterId && outcome ? { ...c, status: outcome.status, retention_check_at: outcome.checkAt, has_run: true } : c)),
    due_cards: home.due_cards.filter((c) => !answered.has(`rv:${c.id}`)),
  };
}

export default function Session({ uid, plan, resume, home, onClose, onFinished }: {
  uid: string; plan: SessionPlan; resume?: StudySessionRow | null; home: LearnHome;
  onClose: () => void; onFinished: (score: SessionScore) => void;
}) {
  const game = useGame();
  const [active, setActive] = useState<SessionPlan>(() =>
    resume && Array.isArray(resume.plan) && resume.plan.length
      ? { ...plan, items: resume.plan, chapterId: resume.chapter_id, notebookIds: resume.notebook_ids ?? plan.notebookIds }
      : plan);
  const [sessionId, setSessionId] = useState<string>(resume?.id ?? "");
  const [results, setResults] = useState<SessionResult[]>(() => (resume?.results ?? []));
  const [retries, setRetries] = useState<SessionItem[]>(() => {
    // rebuild the retry slots from what was already answered wrong once
    const rs = resume?.results ?? [];
    const items = resume?.plan ?? [];
    return rs.filter((r) => r.attempt === 1 && !r.ok && !rs.some((x) => x.id === r.id && x.attempt === 2))
      .map((r) => items.find((it) => it.id === r.id)).filter((it): it is SessionItem => !!it && canReask(it))
      .slice(0, RETRY_SLOTS).map(reaskOf);
  });
  const [pos, setPos] = useState(() => Math.min(resume?.pos ?? 0, resume?.plan?.length ?? 0));
  const [phase, setPhase] = useState<Phase>("run");
  const [answered, setAnswered] = useState(false);
  const [correct, setCorrect] = useState(false);
  const [detail, setDetail] = useState<AnswerDetail>({});
  const [combo, setCombo] = useState(0);
  const [done, setDone] = useState<Done | null>(null);
  const [tomorrowLate, setTomorrowLate] = useState<Done["tomorrow"]>(null);
  const [reviewNotes, setReviewNotes] = useState({ skipped: 0, failed: 0 });
  const startedAt = useRef(0);
  const banked = useRef(false);
  // The session row's start: "inflight" while startSession is running (it can
  // take seconds — a 23505 settles the old row first), "failed" once it has
  // come back empty and may be retried, "gaveup" after the retry also failed.
  // Only a COMPLETED failure retries: a second call during the first would
  // settle the same open row twice (its chapter attempts counted twice).
  const starting = useRef<"inflight" | "failed" | "gaveup">("inflight");

  const items = active.items;
  const queue = [...items, ...retries];
  const item = queue[pos];
  // stored permutation: stable for this item in this plan (a re-ask gets a fresh one)
  const seed = item ? hashSeed(`${uid}:${active.chapterId ?? ""}:${item.id}`) : 1;

  // the session row — resume reuses its id, a fresh plan gets a new one
  useEffect(() => {
    if (sessionId) return;
    let alive = true;
    starting.current = "inflight";
    startSession(uid, active).then((id) => { if (!alive) return; if (id) setSessionId(id); else starting.current = "failed"; });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => { startedAt.current = now(); }, [pos]);

  function record(ok: boolean, extra: Partial<SessionResult> = {}) {
    if (!item || answered) return;
    const ms = now() - startedAt.current;
    const attempt: 1 | 2 = item.id.endsWith("#2") ? 2 : 1;
    const r: SessionResult = { id: item.id.replace(/#2$/, ""), ok, attempt, ms, ...extra };
    const next = [...results, r];
    setResults(next);
    setAnswered(true); setCorrect(ok);
    if (ok) { const c = combo + 1; setCombo(c); if (c === 3 || c === 5 || c === 8) burstConfetti("small"); } else setCombo(0);
    // a wrong first attempt earns one more look, in a retry slot at the end
    if (!ok && attempt === 1 && canReask(item) && retries.length < RETRY_SLOTS) setRetries([...retries, reaskOf(item)]);
    // The row never got created (offline at Start): one more try now that
    // there is something to save. After that the answers stay in memory and
    // the done screen says so.
    if (!sessionId && starting.current === "failed") {
      starting.current = "inflight";
      startSession(uid, active).then((id) => { if (id) setSessionId(id); else starting.current = "gaveup"; });
    }
    // pos runs over the FULL queue (retries included), so a quit in the retry
    // slots is stored as "main block complete", never as an item to redo
    if (next.length % FLUSH_EVERY === 0 && sessionId) flushResults(sessionId, next, pos + 1);
    return r;
  }

  // reviews: rate the FRESH row; a card reviewed elsewhere since is skipped.
  // A second look (retry slot) is practice — the card was already rated once.
  async function rateReview(rv: ReviewItem, rating: Grade, ok: boolean) {
    const r = record(ok, { rating });
    if (!r || r.attempt === 2) return;
    const outcome = await rateReviewFresh(rv.card, rating);
    if (outcome === "skipped") {
      setResults((rs) => rs.map((x) => (x.id === r.id && x.attempt === r.attempt ? { ...x, skipped: true } : x)));
      setReviewNotes((n) => ({ ...n, skipped: n.skipped + 1 }));
    } else if (outcome === "failed") setReviewNotes((n) => ({ ...n, failed: n.failed + 1 }));
  }
  function onInteractiveReview(rv: ReviewItem, ok: boolean, d: AnswerDetail) {
    setDetail(d);
    const fast = now() - startedAt.current < FAST_MS;
    rateReview(rv, ok ? (rv.card.reps >= 3 && fast ? Rating.Easy : Rating.Good) : Rating.Again, ok);
  }

  async function askGuide(it: ChapterItem, text: string, ask: string): Promise<string> {
    const json = await advisorCall<{ text?: string }>({ advisor: "coach", topicId: it.notebook_id, context: text, ask, chapterTitle: it.chapter_title });
    if (json.error) return `Couldn't reach the guide right now — ${json.error}`;
    return json.text?.trim() || "The guide had nothing to add here — try another chip.";
  }

  function next() {
    if (pos + 1 < queue.length) { setPos(pos + 1); setAnswered(false); setCorrect(false); setDetail({}); }
    else finish();
  }

  async function finish() {
    // Guard the finish tap hard: it awaits several network calls, and a second
    // tap must never reach a path that blanks the screen before the result.
    if (banked.current || phase !== "run") return;
    banked.current = true;
    setPhase("finishing");
    const score = scoreSession(active, results);
    const fin = await finishSession(uid, sessionId, active, results, score);
    onFinished(score);
    const answeredIds = new Set(results.map((r) => r.id));
    const patched = patchHome(home, active.chapterId, fin.chapter, answeredIds);
    // tomorrow's run: written now so the Today card never has to say
    // "preparing". The prediction is synchronous, so a slow write still shows
    // as "being written" — never as "nothing queued" while it's in flight.
    const predicted = predictNext(patched, {}, new Date()).chapter;
    const tomorrowP = (async () => {
      await prefetchNext(patched, {}, new Date());
      return { chapter: predicted, run: predicted ? await fetchRun(predicted.id) : null };
    })();
    const tomorrow = (await withTimeout(tomorrowP, PREFETCH_WAIT_MS)) ?? (predicted ? { chapter: predicted, run: null } : null);
    if (predicted && !tomorrow?.run) tomorrowP.then(setTomorrowLate);
    game.refresh();
    if (fin.xp > 0) xpToast(fin.xp);
    const passed = score.retention.asked ? score.retention.right >= 2 : score.chapterPct >= PASS_PCT;
    burstConfetti(passed && score.chapterAsked + score.retention.asked > 0 ? "big" : "small");
    if (passed) sfx.levelup(); else sfx.fanfare();
    setDone({ score, xp: fin.xp, note: fin.note, chapter: fin.chapter, tomorrow, home: patched });
    setPhase("done");
  }

  // a resumed session past its last item is done — repair it by finishing
  useEffect(() => { if (phase === "run" && items.length && pos >= queue.length) finish(); }, [pos]); // eslint-disable-line react-hooks/exhaustive-deps

  // One more round = the reviews still due + the NEXT chapter, if its run is
  // written. The chapter just studied is off the table: its cards minutes
  // later teach nothing and would re-score it. Null when there's nothing to run.
  function encore(): SessionPlan | null {
    if (!done) return null;
    const t = tomorrowLate ?? done.tomorrow;
    const runs = t?.chapter && t.run ? { [t.chapter.id]: t.run } : {};
    const h = { ...done.home, chapters: done.home.chapters.filter((c) => c.id !== active.chapterId) };
    const p = buildSession(h, runs, { now: new Date(), scope: "today", answeredIds: results.map((r) => r.id) });
    return p.items.length ? p : null;
  }
  function oneMore() {
    const p = encore();
    if (!p) return;
    banked.current = false;
    setActive(p); setSessionId(""); setResults([]); setRetries([]); setPos(0);
    setAnswered(false); setCorrect(false); setDetail({}); setCombo(0); setDone(null); setTomorrowLate(null);
    setReviewNotes({ skipped: 0, failed: 0 });
    setPhase("run");
  }

  function close() {
    const at = answered ? pos + 1 : pos;
    // The main block done means the round counts: a quit in the retry slots
    // finishes it — scored and written by the same path as tapping Finish —
    // and the done screen says what happened. Earlier than that, the resume
    // lands on the next unanswered item.
    if (phase === "run" && items.length && at >= items.length) { finish(); return; }
    if (sessionId && results.length && phase === "run") flushResults(sessionId, results, at);
    onClose();
  }

  if (typeof document === "undefined") return null;
  const encorePlan = phase === "done" ? encore() : null;
  const mainDone = Math.min(pos, items.length);
  const chapterItem = item && isChapterItem(item) ? item : null;
  const chapterMeta = chapterItem ? home.chapters.find((c) => c.id === chapterItem.chapter_id) : null;
  const explain = chapterItem && "explain" in chapterItem ? chapterItem.explain : "";
  const whyWrong = chapterItem && (chapterItem.kind === "mcq" || chapterItem.kind === "scenario") && detail.pick !== undefined
    ? chapterItem.why_wrong?.[detail.pick] : undefined;
  const badge = chapterItem?.pretest ? "Take a guess — a wrong guess costs nothing."
    : item?.id.endsWith("#2") ? "Second look — same question, fresh eyes."
    : chapterItem?.retention ? "Quick check — from a chapter you passed."
    : chapterItem?.mixed ? `From "${chapterItem.chapter_title}" — keeping it warm.`
    : item?.kind === "review" && item.item ? "Came back from a miss — same card, as itself." : "";

  return createPortal(
    <div className="fixed inset-0 z-50 bg-[var(--background)] flex flex-col">
      <div className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={close} className="text-sm opacity-50 active:scale-90 shrink-0">✕</button>
        {/* progress = the plan plus four dimmed retry slots; slots that never fill collapse at the end */}
        <div className="flex-1 flex items-center gap-1">
          <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full bg-[var(--neon)] transition-all duration-300" style={{ width: items.length ? `${(mainDone / items.length) * 100}%` : "0%" }} />
          </div>
          {phase !== "done" && Array.from({ length: RETRY_SLOTS }, (_, k) => {
            const filled = k < retries.length, cleared = pos >= items.length + k + 1;
            return <span key={k} className={`h-2 w-2 rounded-full ${cleared ? "bg-[var(--neon)]" : filled ? "bg-[var(--neon)]/45" : "bg-white/10"}`} />;
          })}
        </div>
        {combo >= 2 && <span className="text-xs font-bold text-orange-300 shrink-0 flame">🔥{combo}</span>}
        <span className="text-[11px] opacity-40 shrink-0 tabular-nums">{Math.min(pos + 1, queue.length)}/{queue.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {phase === "run" && item && (
          <div key={item.id} className="rise-in pt-2">
            {badge && <p className="text-[11px] text-[var(--neon)] mb-3">{badge}</p>}

            {item.kind === "review" && (item.item
              ? (item.item.kind === "worked"
                ? <WorkedCard card={item.item} seed={seed} onAnswer={(ok, d) => onInteractiveReview(item, ok, d)} />
                : item.item.kind !== "teach" && <QuestionCard card={item.item} seed={seed} onAnswer={(ok, d) => onInteractiveReview(item, ok, d)} />)
              : <ReviewCard card={item.card} onRate={(rating, ok) => rateReview(item, rating, ok)} />)}

            {chapterItem?.kind === "teach" && (
              <TeachCard card={chapterItem} videos={chapterMeta?.videos ?? []} onAsk={(ask) => askGuide(chapterItem, chapterItem.text, ask)} />
            )}
            {chapterItem?.kind === "worked" && (
              <WorkedCard card={chapterItem} seed={seed} onAnswer={(ok, d) => { setDetail(d); record(ok); }} />
            )}
            {chapterItem && chapterItem.kind !== "teach" && chapterItem.kind !== "worked" && (
              <QuestionCard card={chapterItem} seed={seed} onAnswer={(ok, d) => { setDetail(d); record(ok); }} />
            )}

            {answered && item.kind === "review" && item.item && (
              <div className={`mt-4 rounded-xl px-3 py-2.5 border ${correct ? "bg-green-500/10 border-green-400/30" : "bg-orange-500/10 border-orange-400/30"}`}>
                <p className="text-sm">{correct ? "✓ " : "→ "}{"explain" in item.item && item.item.explain ? item.item.explain : item.card.back}</p>
              </div>
            )}
            {answered && chapterItem && chapterItem.pretest && (
              <div className="mt-4 rounded-xl px-3 py-2.5 border bg-[var(--neon)]/10 border-[var(--neon)]/30">
                <p className="text-sm">{correct ? "✓ Good instinct. " : ""}You&apos;ll see why in a moment.</p>
              </div>
            )}
            {answered && chapterItem && !chapterItem.pretest && (explain || whyWrong) && (
              <div className={`mt-4 rounded-xl px-3 py-2.5 border ${correct ? "bg-green-500/10 border-green-400/30" : "bg-orange-500/10 border-orange-400/30"}`}>
                {!correct && whyWrong && <p className="text-sm mb-1">→ {whyWrong}</p>}
                {explain && <p className="text-sm">{correct ? "✓ " : "→ "}{explain}</p>}
                {!correct && chapterItem.reask === undefined && retries.some((r) => r.id === `${chapterItem.id}#2`) && (
                  <p className="text-[11px] opacity-50 mt-1">This one comes back at the end.</p>
                )}
              </div>
            )}
          </div>
        )}

        {phase === "finishing" && (
          <div className="h-full grid place-items-center text-center"><p className="text-sm opacity-60">saving your round…</p></div>
        )}

        {phase === "done" && done && (
          <DoneScreen done={done} tomorrowLate={tomorrowLate} encore={encorePlan} reviewNotes={reviewNotes} home={home} plan={active} onDone={onClose} onOneMore={oneMore} />
        )}
      </div>

      {phase === "run" && item && (item.kind === "teach" || answered) && (
        <div className="px-4 pb-6 pt-2">
          <button onClick={next} className="w-full rounded-2xl bg-[var(--neon)] text-black font-bold py-3.5 text-[1.05rem] active:scale-95">
            {pos + 1 < queue.length ? "Continue →" : "Finish 🏁"}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ─── the done screen: what happened, what comes back, what's next ───────────
function DoneScreen({ done, tomorrowLate, encore, reviewNotes, home, plan, onDone, onOneMore }: {
  done: Done; tomorrowLate: Done["tomorrow"]; encore: SessionPlan | null; reviewNotes: { skipped: number; failed: number }; home: LearnHome;
  plan: SessionPlan; onDone: () => void; onOneMore: () => void;
}) {
  const { score, chapter } = done;
  const today = studyDay();
  const tomorrow = addDays(today, 1);
  const chapterTitle = home.chapters.find((c) => c.id === plan.chapterId)?.title ?? "this chapter";
  const chapterMisses = score.misses.filter((m) => m.kind !== "review" && !(m as ChapterItem).mixed && !(m as ChapterItem).retention).length;
  const passed = score.chapterPct >= PASS_PCT;

  let headline = "";
  if (score.retention.asked) {
    headline = score.retention.right >= 2
      ? `Check passed — "${chapterTitle}" is done ✓`
      : `Check didn't hold — "${chapterTitle}" goes back in rotation. That's how this works.`;
  } else if (score.chapterAsked) {
    headline = `Right first try: ${score.chapterRight} of ${score.chapterAsked}`;
    headline += passed
      ? ` · chapter passed for now — check comes back ${chapter?.checkAt ? weekdayOf(localDay(chapter.checkAt)) : "in a couple of days"}`
      : ` · Not yet — ${chapterMisses} come back tomorrow. That's how this works.`;
  } else if (score.asked) {
    headline = `Reviewed ${score.asked} · ${score.right} still there`;
  } else {
    headline = "Round done.";
  }

  const stems = score.misses.map((m) => (m.kind === "review" ? m.card.front : stemOf(m as RunCard))).slice(0, 3)
    .map((s) => (s.length > 48 ? `${s.slice(0, 46)}…` : s));
  const nextDl = plan.nextDeadline;
  const nb = home.notebooks.find((n) => n.id === plan.notebookId);
  let pace = "";
  if (nextDl && nb) {
    const days = daysBetween(today, localDay(nextDl.due_at));
    const left = chaptersLeft(nb, done.home.chapters);
    const perDay = Math.max(1, Math.ceil(left / Math.max(1, days)));
    const when = days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    pace = `${nextDl.course || nb.title} ${nextDl.kind} ${when} · ${left} chapter${left === 1 ? "" : "s"} left · ${perDay} a day keeps you on track`;
  }
  const lit = new Set([...home.week_days, today]);
  const monday = addDays(today, -((new Date(`${today}T12:00:00`).getDay() + 6) % 7));
  const t = tomorrowLate ?? done.tomorrow;
  const canMore = !!encore;

  return (
    <div className="h-full grid place-items-center text-center">
      <div className="max-w-sm w-full">
        <div className="text-5xl mb-2">{score.retention.asked ? (score.retention.right >= 2 ? "🏆" : "🔁") : passed && score.chapterAsked ? "🏆" : "💪"}</div>
        <p className="study-prose text-[1.05rem]">{headline}</p>
        {stems.length > 0 && (
          <p className="text-sm opacity-70 mt-3">Missed today → back on {shortDate(tomorrow)}: {stems.join(" · ")}</p>
        )}
        {pace && <p className="text-sm opacity-70 mt-3">{pace}</p>}
        <div className="mt-4 flex items-center justify-center gap-3">
          {done.xp > 0 && (
            <span className="inline-flex items-center rounded-full bg-[var(--neon)]/15 border border-[var(--neon)]/40 px-3 py-1.5 text-[var(--neon)] font-bold text-sm">+{done.xp} XP</span>
          )}
          <span className="inline-flex items-center gap-1.5">
            {WEEK.map((d, i) => {
              const day = addDays(monday, i);
              return <span key={d} className={`h-2.5 w-2.5 rounded-full ${lit.has(day) ? "bg-[var(--neon)]" : "bg-white/12"} ${day === today ? "ring-2 ring-[var(--neon)]/40" : ""}`} />;
            })}
          </span>
        </div>
        {(reviewNotes.skipped > 0 || reviewNotes.failed > 0) && (
          <p className="text-[12px] opacity-50 mt-3">
            {reviewNotes.skipped > 0 && `${reviewNotes.skipped} already reviewed elsewhere`}
            {reviewNotes.skipped > 0 && reviewNotes.failed > 0 && " · "}
            {reviewNotes.failed > 0 && `${reviewNotes.failed} review${reviewNotes.failed === 1 ? "" : "s"} didn't save — they'll come back`}
          </p>
        )}
        {done.note && <p className="text-xs text-orange-300 mt-3">{done.note}</p>}
        <p className="text-[12px] opacity-50 mt-3">{t?.chapter && t.run ? "Tomorrow is ready ✓" : t?.chapter ? "Tomorrow's round is being written" : "Nothing queued for tomorrow yet — add sources or a notebook"}</p>
        <div className="flex gap-2 mt-6 justify-center">
          <button onClick={onOneMore} disabled={!canMore}
            className="rounded-xl bg-white/10 px-4 py-3 text-sm font-semibold active:scale-95 disabled:opacity-40">
            {canMore ? `One more round · ${encore.items.length} items` : t?.chapter && !t.run ? "Tomorrow's round is being written" : "Nothing more today"}
          </button>
          <button onClick={onDone} className="rounded-xl bg-[var(--neon)] text-black px-5 py-3 text-sm font-bold active:scale-95">Done</button>
        </div>
      </div>
    </div>
  );
}
