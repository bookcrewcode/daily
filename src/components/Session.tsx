"use client";

// 🎮 SESSION — today's round: two reviews, then one chapter with the rest of
// the reviews woven in, then the retries. Fullscreen, tap-only, honest about
// what saved and what didn't. The same component walks the quick feed (scope
// 'quick'): one clip-and-question per screen, no chapter, no retries.
//
// The plan comes in already decided (session.ts). This component's job is to
// walk it: keep the working state per item, buffer results and flush them
// every few answers, re-ask misses in the retry slots, and finish in the order
// that keeps the done screen truthful — the reward lands on the last tap, the
// writes catch up behind it (chapter → session → misses → XP).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Rating, type Grade } from "ts-fsrs";
import { advisorCall } from "@/lib/notebook";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { sfx, unlockAudio, xpToast } from "@/lib/fx";
import {
  addDays, buildQuickFeed, chaptersLeft, daysBetween, hashSeed, localDay, scoreSession, stemOf, studyDay, PASS_PCT, SECONDS_PER_ITEM,
  type ChapterLite, type LearnHome, type SessionItem, type SessionPlan, type SessionResult, type SessionScore, type StudySessionRow, type RunCard,
} from "@/lib/session";
import {
  ensureRun, fetchRun, finishSession, flushResults, noSense, predictNext, prefetchNext, rateReviewFresh, startSession, tomorrowOpener, RIGHT_XP,
  type ChapterOutcome, type WeekProgress,
} from "@/lib/learnApi";
import { Clip, NoSense, QuestionCard, ReviewCard, TeachCard, WorkedCard, type AnswerDetail } from "./SessionCards";
import ChapterVideos from "./ChapterVideos";

type ChapterItem = Extract<SessionItem, { chapter_id: string }>;
type ReviewItem = Extract<SessionItem, { kind: "review" }>;
type Phase = "run" | "done";
// tomorrow: undefined while it is still being lined up, null when nothing is queued
type Tomorrow = { chapter: ChapterLite | null; run: RunCard[] | null; note?: string; feedRuns?: Record<string, RunCard[]>; opener?: string | null };
type Done = {
  score: SessionScore; xp: number | null; note: string; chapter: ChapterOutcome | null; week: WeekProgress | null;
  tomorrow: Tomorrow | null | undefined; home: LearnHome; opener?: string | null;
};

const FLUSH_EVERY = 3;
const IDEA_TOAST_MS = 1500;
const PAUSE_MS = 1000;
const FAST_MS = 4000;
const ENCORE_MAX = 3;
const ENCORE_SIZE = 5;
const SWIPE_PX = 60;
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const isChapterItem = (it: SessionItem): it is ChapterItem => it.kind !== "review";
// wall clock for answer timing — only ever called from tap handlers, never during render
const now = () => Date.now();
const weekdayOf = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
const shortDate = (day: string) => `${weekdayOf(day)} ${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
// Misses that come back: the re-ask id is the original id with a suffix so
// scoring can tie attempt 2 to attempt 1.
const reaskOf = (it: SessionItem): SessionItem => ({ ...it, id: `${it.id}#2`, ...(isChapterItem(it) ? { reask: true, pretest: false } : {}) });
const canReask = (it: SessionItem) => (isChapterItem(it) ? it.kind !== "teach" && !it.pretest : !!it.item);
const runIndexOf = (it: ChapterItem) => Number(it.id.replace(/#2$/, "").split(":").pop());
// A first-try right answer that counts toward the score: a review, or a chapter
// question that is not a pretest, a mixed one or a retention probe.
const scores = (it: SessionItem) => it.kind === "review" || (!it.pretest && !it.mixed && !it.retention);
// "~3 min left" instead of "5/16": a count is a wall, a minute is a promise.
function timeLeft(left: number): string {
  if (left <= 1) return "last one";
  const secs = left * SECONDS_PER_ITEM;
  return secs < 60 ? "under a minute" : `~${Math.ceil(secs / 60)} min left`;
}
// The bar in pieces: the opening reviews, then one piece per teach group.
function segmentsOf(items: SessionItem[]): { start: number; end: number }[] {
  const starts = new Set<number>([0]);
  const firstBlock = items.findIndex((it) => it.kind !== "review");
  if (firstBlock > 0) starts.add(firstBlock);
  items.forEach((it, i) => { if (it.kind === "teach") starts.add(i); });
  const s = [...starts].sort((a, b) => a - b);
  return s.map((start, i) => ({ start, end: s[i + 1] ?? items.length })).filter((x) => x.end > x.start);
}
const encoreKey = (uid: string) => `learn:encores:${uid}:${studyDay()}`;
function encoresUsed(uid: string): number {
  try { return Number(localStorage.getItem(encoreKey(uid)) ?? 0) || 0; } catch { return 0; }
}
// The home as the database now sees it, so tomorrow's prediction doesn't pick
// today's chapter again and the quick feed skips what was just reviewed.
function patchHome(home: LearnHome, chapterId: string | null, outcome: ChapterOutcome | null, answered: Set<string>): LearnHome {
  return {
    ...home, done_today: true, open_session: null,
    chapters: home.chapters.map((c) => (c.id === chapterId && outcome ? { ...c, status: outcome.status, retention_check_at: outcome.checkAt, has_run: true } : c)),
    due_cards: home.due_cards.filter((c) => !answered.has(`rv:${c.id}`)),
  };
}
// An answer given on the Today card (initialResult) or stored on a resumed row
// is never asked again: the cursor steps over items that already have a first attempt.
function skipAnswered(queue: SessionItem[], results: SessionResult[], from: number): number {
  let p = from;
  while (queue[p] && !queue[p].id.endsWith("#2") && results.some((r) => r.attempt === 1 && r.id === queue[p].id)) p++;
  return p;
}
function retriesFrom(items: SessionItem[], results: SessionResult[], slots: number): SessionItem[] {
  return results.filter((r) => r.attempt === 1 && !r.ok && !results.some((x) => x.id === r.id && x.attempt === 2))
    .map((r) => items.find((it) => it.id === r.id)).filter((it): it is SessionItem => !!it && canReask(it))
    .slice(0, slots).map(reaskOf);
}

export default function Session({ uid, plan, resume, home, runs = {}, initialResult, onClose, onFinished }: {
  uid: string; plan: SessionPlan; resume?: StudySessionRow | null; home: LearnHome; runs?: Record<string, RunCard[]>;
  // the answer already given on the Today card: counted, its effects fired, its item skipped
  initialResult?: SessionResult;
  onClose: () => void; onFinished: (score: SessionScore) => void;
}) {
  const game = useGame();
  const [active, setActive] = useState<SessionPlan>(() =>
    resume && Array.isArray(resume.plan) && resume.plan.length
      ? { ...plan, items: resume.plan, chapterId: resume.chapter_id, notebookIds: resume.notebook_ids ?? plan.notebookIds }
      : plan);
  const [sessionId, setSessionId] = useState<string>(resume?.id ?? "");
  const [init] = useState(() => {
    const items = resume?.plan?.length ? resume.plan : plan.items;
    const seeded = initialResult && items.some((it) => it.id === initialResult.id) ? initialResult : null;
    // a resumed row keeps its stored answers; the Today-card answer joins them
    // when its item is still open (Notebooks only asks an item not yet in results)
    const stored = resume?.results?.length ? resume.results : [];
    const results = seeded && !stored.some((r) => r.id === seeded.id) ? [...stored, seeded] : stored;
    const retries = retriesFrom(items, results, plan.retrySlots);
    const pos = skipAnswered([...items, ...retries], results, Math.min(resume?.pos ?? 0, items.length));
    return { results, retries, pos, seeded };
  });
  const [results, setResults] = useState<SessionResult[]>(init.results);
  const [retries, setRetries] = useState<SessionItem[]>(init.retries);
  const [pos, setPos] = useState(init.pos);
  const [phase, setPhase] = useState<Phase>("run");
  const [answered, setAnswered] = useState(false);
  const [correct, setCorrect] = useState(false);
  const [detail, setDetail] = useState<AnswerDetail>({});
  const [combo, setCombo] = useState(init.seeded?.ok ? 1 : 0);
  const [done, setDone] = useState<Done | null>(null);
  const [tomorrowLate, setTomorrowLate] = useState<Tomorrow | null>(null);
  const [reviewNotes, setReviewNotes] = useState({ skipped: 0, failed: 0 });
  const [ideaToast, setIdeaToast] = useState("");
  const [pausing, setPausing] = useState(false);
  const [comebackId, setComebackId] = useState<string | null>(null);   // the ONE miss that gets the "comes back" line
  const [encores, setEncores] = useState(() => encoresUsed(uid));
  const startedAt = useRef(0);
  const banked = useRef(false);
  const unlocked = useRef(false);
  const touchY = useRef<number | null>(null);
  // every id answered in this sitting, across encores — the quick feed never repeats one
  const [sitting, setSitting] = useState<string[]>([]);
  // The session row's start: "inflight" while startSession is running (it can
  // take seconds — a 23505 settles the old row first), "failed" once it has
  // come back empty and may be retried, "gaveup" after the retry also failed.
  // Only a COMPLETED failure retries: a second call during the first would
  // settle the same open row twice (its chapter attempts counted twice).
  const starting = useRef<"inflight" | "failed" | "gaveup">("inflight");

  const items = active.items;
  const queue = [...items, ...retries];
  const item = queue[pos];
  const feed = active.scope === "quick";
  const chapterItem = item && isChapterItem(item) ? item : null;
  const chapterMeta = chapterItem ? home.chapters.find((c) => c.id === chapterItem.chapter_id) : null;
  // stored permutation: stable for this item in this plan, fresh for a re-ask
  // and for a chapter's next attempt — a repeat never comes in the same order
  const seed = item ? hashSeed(`${uid}:${active.chapterId ?? ""}:${item.id}:${chapterMeta?.attempts ?? 0}`) : 1;

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

  // the Today-card answer gets the same feedback a tap in here would have
  useEffect(() => {
    if (!init.seeded) return;
    if (init.seeded.ok) xpToast(RIGHT_XP); else sfx.miss();
  }, [init.seeded]);

  // iPhone on silent: the first tap plays a silent clip so the tones after it are heard
  function firstTap() {
    if (unlocked.current) return;
    unlocked.current = true;
    unlockAudio();
  }

  function record(ok: boolean, extra: Partial<SessionResult> = {}) {
    if (!item || answered) return;
    const ms = now() - startedAt.current;
    const attempt: 1 | 2 = item.id.endsWith("#2") ? 2 : 1;
    const r: SessionResult = { id: item.id.replace(/#2$/, ""), ok, attempt, ms, ...extra };
    const next = [...results, r];
    setResults(next);
    setAnswered(true); setCorrect(ok);
    if (ok) { const c = combo + 1; setCombo(c); if (c === 3 || c === 5 || c === 8) burstConfetti("small"); } else setCombo(0);
    // the reward on the tap; the total is banked once, at the end
    if (ok && attempt === 1 && scores(item)) xpToast(RIGHT_XP);
    // a wrong first attempt earns one more look, in a retry slot at the end
    if (!ok && attempt === 1 && canReask(item) && retries.length < active.retrySlots) {
      setRetries([...retries, reaskOf(item)]);
      if (comebackId === null) setComebackId(item.id);
    }
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
    const json = await advisorCall<{ text?: string }>({
      advisor: "coach", topicId: it.notebook_id, context: text, ask, chapterTitle: it.chapter_title, interests: home.settings.interests ?? [],
    });
    if (json.error) return `Couldn't reach the guide right now — ${json.error}`;
    return json.text?.trim() || "The guide had nothing to add here — try another chip.";
  }

  function next() {
    const p = skipAnswered(queue, results, pos + 1);
    if (p >= queue.length) { finish(); return; }
    // the last question of a teach group: say which idea just landed, briefly
    if (!feed && pos < items.length && (p >= items.length || items[p].kind === "teach")) {
      const ideas = items.filter((it) => it.kind === "teach").length;
      const done = items.slice(0, pos + 1).filter((it) => it.kind === "teach").length;
      if (ideas >= 2 && done >= 1) {
        setIdeaToast(`Idea ${done} of ${ideas} done · ${timeLeft(queue.length - p)}`);
        setTimeout(() => setIdeaToast(""), IDEA_TOAST_MS);
      }
    }
    setPos(p); setAnswered(false); setCorrect(false); setDetail({});
  }

  async function finish() {
    // Guard the finish tap hard: a second tap must never reach a path that
    // resets the screen. The done screen shows NOW — score, confetti, sound —
    // and the writes catch up behind it; "saving your round…" is never what
    // follows the last tap.
    if (banked.current || phase !== "run") return;
    banked.current = true;
    const score = scoreSession(active, results);
    const passed = score.retention.asked ? score.retention.right >= 2 : score.chapterPct >= PASS_PCT;
    setDone({ score, xp: null, note: "", chapter: null, week: null, tomorrow: undefined, home });
    setPhase("done");
    burstConfetti(passed && score.chapterAsked + score.retention.asked > 0 ? "big" : "small");
    if (passed) sfx.levelup(); else sfx.fanfare();

    const fin = await finishSession(uid, sessionId, active, results, score);
    onFinished(score);
    setSitting((s) => [...s, ...results.map((r) => r.id)]);
    const patched = patchHome(home, active.chapterId, fin.chapter, new Set(results.map((r) => r.id)));
    if (fin.xp > 0) xpToast(fin.xp);
    game.refresh();
    if (feed) {
      const op = await tomorrowOpener(patched, new Date());
      setDone((d) => d && { ...d, xp: fin.xp, note: fin.note, chapter: fin.chapter, week: fin.week, home: patched, tomorrow: null, opener: op?.stem ?? null });
      return;
    }
    // tomorrow's run: written now so the Today card never has to say
    // "preparing". The prediction is synchronous, so a slow write still shows
    // as "being written" — never as "nothing queued" while it's in flight.
    const predicted = predictNext(patched, {}, new Date()).chapter;
    setDone((d) => d && {
      ...d, xp: fin.xp, note: fin.note, chapter: fin.chapter, week: fin.week, home: patched,
      tomorrow: predicted ? { chapter: predicted, run: null } : null,
    });
    // A chapter that didn't pass comes back REWRITTEN around today's misses —
    // not the same cards in the same order. Stuck chapters get it too, so the
    // rewrite is ready when the rest ends.
    const ch = home.chapters.find((c) => c.id === active.chapterId);
    const nb = ch && home.notebooks.find((n) => n.id === ch.notebook_id);
    const failed = !!fin.chapter && score.chapterAsked > 0 && score.chapterPct < PASS_PCT && (fin.chapter.status === "active" || fin.chapter.status === "stuck");
    const notes: string[] = [];
    const onNote = (n: string) => notes.push(n);
    (async (): Promise<Tomorrow> => {
      if (failed && ch && nb) {
        const todayMisses = score.misses.filter((m): m is ChapterItem => isChapterItem(m) && !m.mixed && !m.retention).map((m) => stemOf(m));
        await ensureRun(nb, ch, { force: true, misses: [...new Set([...(ch.misses ?? []), ...todayMisses])].slice(-12), onNote });
      }
      const opener = await prefetchNext(patched, {}, new Date(), onNote);
      const [run, mine] = await Promise.all([predicted ? fetchRun(predicted.id) : null, active.chapterId ? fetchRun(active.chapterId) : null]);
      const feedRuns = { ...runs, ...(predicted && run ? { [predicted.id]: run } : {}), ...(active.chapterId && mine ? { [active.chapterId]: mine } : {}) };
      return { chapter: predicted, run, note: notes.join(" · "), feedRuns, opener };
    })().then(setTomorrowLate);
  }

  // a resumed session past its last item is done — repair it by finishing
  useEffect(() => { if (phase === "run" && items.length && pos >= queue.length) finish(); }, [pos]); // eslint-disable-line react-hooks/exhaustive-deps

  // A few more = the quick feed: due cards and short clips with their
  // question, never a second chapter. Three encores a day, then the button
  // itself says stop. Ids answered this sitting (in either id form) are out.
  function encore(): SessionPlan | null {
    if (!done || encores >= ENCORE_MAX) return null;
    const t = tomorrowLate ?? done.tomorrow;
    const answeredIds = sitting.flatMap((id) => [id, id.replace(/^(ch|mx|rt):/, "qf:")]);
    const p = buildQuickFeed(done.home, t?.feedRuns ?? runs, { now: new Date(), max: ENCORE_SIZE, answeredIds });
    return p.items.length ? p : null;
  }
  function oneMore() {
    const p = encore();
    if (!p) return;
    const used = encores + 1;
    setEncores(used);
    try { localStorage.setItem(encoreKey(uid), String(used)); } catch { /* the cap is a courtesy; the session still runs */ }
    banked.current = false;
    setActive(p); setSessionId(""); setResults([]); setRetries([]); setPos(0);
    setAnswered(false); setCorrect(false); setDetail({}); setCombo(0); setDone(null); setTomorrowLate(null);
    setReviewNotes({ skipped: 0, failed: 0 }); setComebackId(null);
    setPhase("run");
  }

  function close() {
    if (phase !== "run") { onClose(); return; }
    const at = answered ? pos + 1 : pos;
    // The main block done means the round counts: a quit in the retry slots
    // finishes it — scored and written by the same path as tapping Finish —
    // and the done screen says what happened. Earlier than that, the resume
    // lands on the next unanswered item, and the screen says so for a second.
    if (items.length && at >= items.length) { finish(); return; }
    if (sessionId && results.length) flushResults(sessionId, results, at);
    setPausing(true);
    setTimeout(onClose, PAUSE_MS);
  }

  if (typeof document === "undefined") return null;
  const encorePlan = phase === "done" ? encore() : null;
  const mainDone = Math.min(pos, items.length);
  const segments = segmentsOf(items);
  const explain = chapterItem && "explain" in chapterItem ? chapterItem.explain : "";
  const whyWrong = chapterItem && (chapterItem.kind === "mcq" || chapterItem.kind === "scenario") && detail.pick !== undefined
    ? chapterItem.why_wrong?.[detail.pick] : undefined;
  const badge = chapterItem?.pretest ? (answered ? "✓ Locked in — the card after this shows why." : "Guess first. Wrong guesses help you remember — nothing counts yet.")
    : item?.id.endsWith("#2") ? "Second try — you've seen this answer once now."
    : chapterItem?.retention ? "Quick check — from a chapter you passed."
    : chapterItem?.mixed && !feed ? `From "${chapterItem.chapter_title}" — keeping it warm.`
    : item?.kind === "review" && item.item ? "Came back from a miss — same card, as itself." : "";
  const flagChapter = chapterItem ? () => noSense({ chapterId: chapterItem.chapter_id, stem: stemOf(chapterItem) }) : null;
  const flagReview = item?.kind === "review" && item.card.chapter_id ? () => noSense({ chapterId: item.card.chapter_id as string, stem: item.card.front }) : null;
  const nextLabel = pos + 1 >= queue.length && skipAnswered(queue, results, pos + 1) >= queue.length ? "Finish 🏁"
    : chapterItem?.pretest ? "Show me why →" : "Continue →";

  return createPortal(
    <div className="fixed inset-0 z-50 bg-[var(--background)] flex flex-col" onPointerDownCapture={firstTap}>
      <div className="px-4 pt-4 pb-2 flex items-center gap-3">
        {phase === "run" && <button onClick={close} className="text-sm opacity-70 active:scale-90 shrink-0">Pause</button>}
        {/* progress = the reviews, then a piece per idea, plus dimmed retry slots that collapse if never filled */}
        <div className="flex-1 flex items-center gap-1">
          <div className="flex-1 flex gap-0.5">
            {segments.map((sg) => (
              <div key={sg.start} className="h-2 rounded-full bg-white/10 overflow-hidden" style={{ flex: sg.end - sg.start }}>
                <div className="h-full bg-[var(--neon)] transition-all duration-300"
                  style={{ width: `${Math.max(0, Math.min(1, (mainDone - sg.start) / (sg.end - sg.start))) * 100}%` }} />
              </div>
            ))}
          </div>
          {phase !== "done" && Array.from({ length: active.retrySlots }, (_, k) => {
            const filled = k < retries.length, cleared = pos >= items.length + k + 1;
            return <span key={k} className={`h-2 w-2 rounded-full ${cleared ? "bg-[var(--neon)]" : filled ? "bg-[var(--neon)]/45" : "bg-white/10"}`} />;
          })}
        </div>
        {combo >= 2 && <span className="text-xs font-bold text-orange-300 shrink-0 flame">🔥{combo}</span>}
        {phase === "run" && <span className="text-[12px] opacity-70 shrink-0 tabular-nums">{timeLeft(queue.length - pos)}</span>}
      </div>

      {ideaToast && (
        <div className="fixed top-14 inset-x-0 z-[55] flex justify-center pointer-events-none">
          <span className="rise-in rounded-full bg-[var(--card)] border border-[var(--neon)]/40 px-4 py-1.5 text-[13px] font-semibold text-[var(--neon)]">{ideaToast}</span>
        </div>
      )}

      <div className={`flex-1 overflow-y-auto px-4 pb-4 ${feed ? "snap-y snap-mandatory" : ""}`}
        onTouchStart={(e) => { touchY.current = e.touches[0]?.clientY ?? null; }}
        onTouchEnd={(e) => {
          // the feed: a swipe up after answering is the same as Continue
          const y0 = touchY.current, y1 = e.changedTouches[0]?.clientY;
          touchY.current = null;
          if (feed && answered && phase === "run" && y0 !== null && y1 !== undefined && y0 - y1 > SWIPE_PX) next();
        }}>
        {pausing && (
          <div className="h-full grid place-items-center text-center"><p className="text-sm opacity-80">Saved — pick up here later</p></div>
        )}
        {phase === "run" && item && !pausing && (
          <div key={item.id} className={`rise-in pt-2 ${feed ? "snap-start min-h-full flex flex-col justify-center" : ""}`}>
            {badge && <p className="text-[14px] text-[var(--neon)] mb-3">{badge}</p>}

            {chapterItem?.feedClip && (
              <Clip clip={chapterItem.feedClip.clip}
                onNoSense={() => noSense({ chapterId: chapterItem.chapter_id, stem: stemOf(chapterItem), clipK: chapterItem.feedClip?.k })} />
            )}

            {item.kind === "review" && (item.item
              ? (item.item.kind === "worked"
                ? <WorkedCard card={item.item} seed={seed} onAnswer={(ok, d) => onInteractiveReview(item, ok, d)} />
                : item.item.kind !== "teach" && <QuestionCard card={item.item} seed={seed} onAnswer={(ok, d) => onInteractiveReview(item, ok, d)} />)
              : <ReviewCard card={item.card} onRate={(rating, ok) => rateReview(item, rating, ok)} />)}

            {chapterItem?.kind === "teach" && (
              <TeachCard card={chapterItem} onAsk={(ask) => askGuide(chapterItem, chapterItem.text, ask)}
                onNoSense={flagChapter ?? undefined}
                onClipOff={() => noSense({ chapterId: chapterItem.chapter_id, stem: chapterItem.text, clipK: runIndexOf(chapterItem) })} />
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
            {answered && chapterItem && !chapterItem.pretest && (explain || whyWrong) && (
              <div className={`mt-4 rounded-xl px-3 py-2.5 border ${correct ? "bg-green-500/10 border-green-400/30" : "bg-orange-500/10 border-orange-400/30"}`}>
                {!correct && whyWrong && <p className="text-sm mb-1">→ {whyWrong}</p>}
                {explain && <p className="text-sm">{correct ? "✓ " : "→ "}{explain}</p>}
                {!correct && comebackId === chapterItem.id && retries.some((r) => r.id === `${chapterItem.id}#2`) && (
                  <p className="text-[12px] opacity-70 mt-1">comes back at the end ↑</p>
                )}
              </div>
            )}
            {answered && item.kind !== "teach" && (flagChapter ?? flagReview) && <NoSense onTap={(flagChapter ?? flagReview) as () => void} />}
          </div>
        )}

        {phase === "done" && done && (feed
          ? <FeedDone done={done} encore={encorePlan} encoresLeft={ENCORE_MAX - encores} onDone={onClose} onOneMore={oneMore} />
          : <DoneScreen done={done} tomorrowLate={tomorrowLate} encore={encorePlan} encoresLeft={ENCORE_MAX - encores} reviewNotes={reviewNotes}
              home={home} plan={active} onDone={onClose} onOneMore={oneMore} />)}
      </div>

      {phase === "run" && item && !pausing && (item.kind === "teach" || answered) && (
        <div className="px-4 pb-6 pt-2">
          <button onClick={next} className="w-full rounded-2xl bg-[var(--neon)] text-black font-bold py-3.5 text-[1.05rem] active:scale-95">
            {nextLabel}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

// ─── shared done-screen bits ─────────────────────────────────────────────────
function XpPill({ xp }: { xp: number | null }) {
  if (xp === null) return <span className="skeleton inline-flex items-center px-3 py-1.5 text-sm font-bold opacity-70">+… XP</span>;
  if (xp <= 0) return null;
  return <span className="inline-flex items-center rounded-full bg-[var(--neon)]/15 border border-[var(--neon)]/40 px-3 py-1.5 text-[var(--neon)] font-bold text-sm">+{xp} XP</span>;
}
// The open loop: tomorrow's first question, hung on the moment he picked for
// it (learn.anchor) — "Next order wait: …" — or plain "Tomorrow opens with".
function openLoopLead(anchor: string | undefined): string {
  switch (anchor) {
    case "Waiting for an order": return "Next order wait:";
    case "Between classes": return "Between classes tomorrow:";
    case "In bed": return "In bed tonight:";
    case "After a drop": return "After your next drop:";
    default: return "Tomorrow opens with:";
  }
}

// "3 of 4 this week" — the goal he picked, never a streak, never a zero.
function weekLine(w: WeekProgress | null): string {
  if (!w) return "";
  const base = w.days >= w.goal ? `${w.days} of ${w.goal} — week done ✓` : `${w.days} of ${w.goal} this week`;
  return w.isBest ? `${base} · best week yet` : base;
}
function EncoreButton({ encore, encoresLeft, fallback, onOneMore }: { encore: SessionPlan | null; encoresLeft: number; fallback: string; onOneMore: () => void }) {
  const label = encore ? `A few more · ${encore.items.length} quick ones` : encoresLeft <= 0 ? "That's plenty for today — see you tomorrow" : fallback;
  return (
    <button onClick={onOneMore} disabled={!encore} className="rounded-xl bg-white/10 px-4 py-3 text-sm font-semibold active:scale-95 disabled:opacity-70">
      {label}
    </button>
  );
}

// ─── the done screen: what happened, what comes back, what's next ───────────
function DoneScreen({ done, tomorrowLate, encore, encoresLeft, reviewNotes, home, plan, onDone, onOneMore }: {
  done: Done; tomorrowLate: Tomorrow | null; encore: SessionPlan | null; encoresLeft: number; reviewNotes: { skipped: number; failed: number }; home: LearnHome;
  plan: SessionPlan; onDone: () => void; onOneMore: () => void;
}) {
  const { score, chapter } = done;
  const today = studyDay();
  const tomorrow = addDays(today, 1);
  const chapterMeta = home.chapters.find((c) => c.id === plan.chapterId);
  const chapterTitle = chapterMeta?.title ?? "this chapter";
  const passed = score.chapterPct >= PASS_PCT;

  let headline = "";
  let rewritten = "";
  if (score.retention.asked) {
    headline = score.retention.right >= 2
      ? `Check passed — "${chapterTitle}" is done ✓`
      : `Check didn't hold — "${chapterTitle}" goes back in rotation. That's how this works.`;
  } else if (score.chapterAsked) {
    headline = `Right first try: ${score.chapterRight} of ${score.chapterAsked}`;
    if (passed) headline += ` · chapter passed for now — check comes back ${chapter?.checkAt ? weekdayOf(localDay(chapter.checkAt)) : "in a couple of days"}`;
    else rewritten = "Tomorrow: your misses come back first, then the chapter again, rewritten.";
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
  const tomorrowLine = t === undefined ? "Lining up tomorrow…"
    : t?.chapter && t.run ? "Tomorrow is ready ✓" : t?.chapter ? "Tomorrow's round is being written" : "Nothing queued for tomorrow yet — add sources or a notebook";
  const week = weekLine(done.week);

  return (
    <div className="h-full grid place-items-center text-center">
      <div className="max-w-sm w-full">
        <div className="text-5xl mb-2">{score.retention.asked ? (score.retention.right >= 2 ? "🏆" : "🔁") : passed && score.chapterAsked ? "🏆" : "💪"}</div>
        <p className="study-prose text-[1.05rem]">{headline}</p>
        {rewritten && <p className="text-sm opacity-80 mt-2">{rewritten}</p>}
        {stems.length > 0 && (
          <p className="text-sm opacity-70 mt-3">Missed today → back on {shortDate(tomorrow)}: {stems.join(" · ")}</p>
        )}
        {pace && <p className="text-sm opacity-70 mt-3">{pace}</p>}
        <div className="mt-4 flex items-center justify-center gap-3">
          <XpPill xp={done.xp} />
          <span className="inline-flex items-center gap-1.5">
            {WEEK.map((d, i) => {
              const day = addDays(monday, i);
              return <span key={d} className={`h-2.5 w-2.5 rounded-full ${lit.has(day) ? "bg-[var(--neon)]" : "bg-white/12"} ${day === today ? "ring-2 ring-[var(--neon)]/40" : ""}`} />;
            })}
          </span>
        </div>
        {week && <p className="text-[12px] opacity-70 mt-2">{week}</p>}
        {(reviewNotes.skipped > 0 || reviewNotes.failed > 0) && (
          <p className="text-[12px] opacity-70 mt-3">
            {reviewNotes.skipped > 0 && `${reviewNotes.skipped} already reviewed elsewhere`}
            {reviewNotes.skipped > 0 && reviewNotes.failed > 0 && " · "}
            {reviewNotes.failed > 0 && `${reviewNotes.failed} review${reviewNotes.failed === 1 ? "" : "s"} didn't save — they'll come back`}
          </p>
        )}
        {done.note && <p className="text-xs text-orange-300 mt-3">{done.note}</p>}
        <p className="text-[12px] opacity-70 mt-3">{tomorrowLine}{t?.note ? ` · ${t.note}` : ""}</p>
        {t?.opener && <p className="text-sm opacity-80 mt-3">{openLoopLead(done.home.settings.anchor)} &ldquo;{t.opener}&rdquo;</p>}
        <div className="flex gap-2 mt-6 justify-center">
          <EncoreButton encore={encore} encoresLeft={encoresLeft} fallback="Nothing quick left today" onOneMore={onOneMore} />
          <button onClick={onDone} className="rounded-xl bg-[var(--neon)] text-black px-5 py-3 text-sm font-bold active:scale-95">Done</button>
        </div>
        {/* the chapter's full videos moved here from the teach card: the round stays on its own words, the deep dive waits at the end */}
        {!!chapterMeta?.videos?.length && (
          <div className="text-left mt-6">
            <ChapterVideos videos={chapterMeta.videos} compact label="Go deeper: the full videos for this chapter" />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── the feed's end: the stopping cue, and what tomorrow opens with ─────────
function FeedDone({ done, encore, encoresLeft, onDone, onOneMore }: {
  done: Done; encore: SessionPlan | null; encoresLeft: number; onDone: () => void; onOneMore: () => void;
}) {
  const { score } = done;
  return (
    <div className="h-full grid place-items-center text-center">
      <div className="max-w-sm w-full">
        <div className="text-5xl mb-2">✓</div>
        <p className="study-prose text-[1.05rem]">That&apos;s the stack for today ✓</p>
        {score.asked > 0 && <p className="text-sm opacity-70 mt-2">{score.right} of {score.asked} right first try</p>}
        <div className="mt-4 flex items-center justify-center gap-3"><XpPill xp={done.xp} /></div>
        {done.note && <p className="text-xs text-orange-300 mt-3">{done.note}</p>}
        {done.opener && <p className="text-sm opacity-80 mt-4">{openLoopLead(done.home.settings.anchor)} &ldquo;{done.opener}&rdquo;</p>}
        {done.opener === null && <p className="text-[12px] opacity-70 mt-4">Tomorrow&apos;s round is being written</p>}
        <div className="flex gap-2 mt-6 justify-center">
          <EncoreButton encore={encore} encoresLeft={encoresLeft} fallback="That's everything quick for today" onOneMore={onOneMore} />
          <button onClick={onDone} className="rounded-xl bg-[var(--neon)] text-black px-5 py-3 text-sm font-bold active:scale-95">Done</button>
        </div>
      </div>
    </div>
  );
}
