// 🔌 LEARN API — every side effect the session needs, in one place.
//
// Rules of the road (Ben's, non-negotiable): write first and check {error};
// a failed write gets honest copy, never a spinner that lies; a failed read
// returns null so the caller can show "retry" instead of "empty". Nothing in
// here throws — a study session must never die because a network call did.

import { Rating, type Grade } from "ts-fsrs";
import { supabase } from "./supabase";
import { advisorCall } from "./notebook";
import { emptyCardState, isDue, reviewCard, type NBCard } from "./fsrs";
import {
  addDays, buildSession, isColdNotebook, localDay, planFromRow, planOpener, scoreSession, stemOf, studyDay, PASS_PCT,
  type ChapterLite, type LearnHome, type LearnSettings, type NotebookLite, type PlanFirst, type RunCard, type SessionItem, type SessionPlan,
  type SessionResult, type SessionScore, type StudySessionRow, type TodayState,
} from "./session";

const CARD_COLS = "id,notebook_id,chapter_id,front,back,hint,suspended,due,stability,difficulty,elapsed_days,scheduled_days,learning_steps,reps,lapses,state,last_review";
const STEP_MS = 8000;         // no single finish step may hold the done screen longer than this
const SESSION_XP = 15;        // showing up
export const RIGHT_XP = 3;    // per first-try right answer (shown on the tap, banked once at the end)
const CHAPTER_DONE_XP = 40;   // once per chapter, when its retention check holds
const MAX_NEW_MISS_CARDS = 5;
const MAX_CHAPTER_MISSES = 12;
const VIDEOS_RETRY_MS = 24 * 3600_000;   // a failed video hunt is tried again after a day, not on every open
const WEEK_GOAL_DEFAULT = 4;
const NUDGE_TEXT_MAX = 140;

// ─── localStorage keys (templates — swap {uid} for the user id) ─────────────
export const PENDING_KEY = "learn:pending:{uid}";
export const PLAN_CACHE_KEY = "learn:plan:{uid}";
const keyFor = (tpl: string, uid: string) => tpl.replace("{uid}", uid);

// One summary, one writer (the Learn home after every reconcile), two readers:
// the Learn home's instant render and TheCard's Learn chip. `nb` is the picked
// notebook's title, for the "ECON 201 · 14 items" line. `first` is the
// opening question — stem, choices and answer — so the Today card can ask it
// before the network answers; a tap on it starts the round with that answer
// counted (Session's `initialResult`).
export type { PlanFirst };
export type PlanCache = { state: TodayState; why: string; count: number; minutes: number; at: string; deadline?: string; nb?: string; first?: PlanFirst };
export function cachePlan(uid: string, plan: SessionPlan, nb?: string, answered?: string[]): void {
  const d = plan.nextDeadline;
  const first = planOpener(plan, nb ?? "", answered ?? []);
  const summary: PlanCache = {
    state: plan.state, why: plan.why, count: plan.items.length, minutes: plan.minutes, at: new Date().toISOString(),
    ...(d ? { deadline: `${d.course || ""} ${d.kind} ${new Date(d.due_at).toLocaleDateString("en-US", { weekday: "short" })}`.trim() } : {}),
    ...(nb ? { nb } : {}),
    ...(first ? { first } : {}),
  };
  try { localStorage.setItem(keyFor(PLAN_CACHE_KEY, uid), JSON.stringify(summary)); } catch { /* storage full or private mode — the cache is a nicety */ }
}
export function readPlanCache(uid: string): PlanCache | null {
  try { const raw = localStorage.getItem(keyFor(PLAN_CACHE_KEY, uid)); return raw ? (JSON.parse(raw) as PlanCache) : null; } catch { return null; }
}

// Results that failed to reach the database wait here until the next flush.
type Pending = { id: string; results: SessionResult[]; pos: number; done?: boolean; stats?: Record<string, unknown>; at: number };
function readPending(uid: string): Pending[] {
  try { const raw = localStorage.getItem(keyFor(PENDING_KEY, uid)); return raw ? (JSON.parse(raw) as Pending[]) : []; } catch { return []; }
}
function writePending(uid: string, list: Pending[]) {
  try { localStorage.setItem(keyFor(PENDING_KEY, uid), JSON.stringify(list)); } catch { /* nothing more we can do offline */ }
}
function enqueue(uid: string, p: Pending) {
  // one entry per session — the newest snapshot supersedes the rest
  writePending(uid, [...readPending(uid).filter((x) => x.id !== p.id), p]);
}
async function writeSession(p: Pending): Promise<boolean> {
  const patch: Record<string, unknown> = { results: p.results, pos: p.pos };
  if (p.done) Object.assign(patch, { status: "done", stats: p.stats ?? null, finished_at: new Date(p.at).toISOString() });
  // only while the row is still open: a flush fired on the last answer must
  // never land on top of the finished row and reopen it with fewer results
  try { const { error } = await supabase.from("study_sessions").update(patch).eq("id", p.id).eq("status", "open"); return !error; } catch { return false; }
}
function forgetPending(uid: string, id: string) {
  writePending(uid, readPending(uid).filter((x) => x.id !== id));
}
// Rows the server already closed. A read failure returns none — the writes
// then go ahead as before rather than sitting in the queue forever.
async function doneIds(ids: string[]): Promise<Set<string>> {
  try {
    const { data } = await supabase.from("study_sessions").select("id,status").in("id", ids);
    return new Set(((data ?? []) as { id: string; status: string }[]).filter((r) => r.status === "done").map((r) => r.id));
  } catch { return new Set(); }
}
// Retry everything queued; whatever still fails stays queued. A snapshot of a
// row that is already done is dropped, never written — it would reopen a
// finished round with fewer answers. Returns how many synced.
export async function drainPending(uid: string): Promise<number> {
  const list = readPending(uid);
  if (!list.length) return 0;
  const done = await doneIds(list.map((p) => p.id));
  const left: Pending[] = [];
  for (const p of list) if (!done.has(p.id) && !(await writeSession(p))) left.push(p);
  writePending(uid, left);
  return list.length - left.length;
}
async function currentUid(): Promise<string | null> {
  try { const { data } = await supabase.auth.getSession(); return data.session?.user.id ?? null; } catch { return null; }
}
function withTimeout<T>(p: Promise<T>, fallback: T, ms = STEP_MS): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

// ─── Reads ──────────────────────────────────────────────────────────────────
export async function loadHome(uid: string, day: string): Promise<LearnHome | null> {
  if (!uid) return null;
  try {
    const { data, error } = await supabase.rpc("learn_home", { p_day: day });
    if (error || !data || typeof data !== "object") return null;
    const h = data as Partial<LearnHome>;
    return {
      notebooks: h.notebooks ?? [], chapters: h.chapters ?? [], due_cards: h.due_cards ?? [], due_count: h.due_count ?? 0,
      deadlines: h.deadlines ?? [], open_session: h.open_session ?? null, week_days: h.week_days ?? [], done_today: !!h.done_today,
      settings: h.settings ?? {}, source_counts: h.source_counts ?? {},
    };
  } catch { return null; }
}

export async function fetchRun(chapterId: string): Promise<RunCard[] | null> {
  try {
    const { data, error } = await supabase.from("notebook_chapters").select("run").eq("id", chapterId).maybeSingle();
    if (error || !data) return null;
    const run = (data as { run: unknown }).run;
    return Array.isArray(run) && run.length ? (run as RunCard[]) : null;
  } catch { return null; }
}

// `onNote` gets one honest line when the cards came back but their save did
// not — the caller shows it wherever it shows progress.
type RunOpts = { misses?: string[]; force?: boolean; onNote?: (note: string) => void };
async function readLearn(uid: string): Promise<LearnSettings> {
  const { data } = await supabase.from("user_settings").select("learn").eq("user_id", uid).maybeSingle();
  return ((data as { learn?: LearnSettings } | null)?.learn ?? {}) as LearnSettings;
}
// Read-modify-write of user_settings.learn (a jsonb blob): callers run these
// one after another, never side by side, or the second read would clobber
// the first write.
async function patchLearn(uid: string, patch: Partial<LearnSettings>): Promise<LearnSettings | null> {
  const learn = { ...(await readLearn(uid)), ...patch };
  const { error } = await supabase.from("user_settings").update({ learn }).eq("user_id", uid);
  return error ? null : learn;
}

// The videos step is worth one try a day: it costs ~30 s and, when the
// transcripts are not there, it fails the same way on every open.
async function videosDue(ch: ChapterLite): Promise<boolean> {
  if (ch.clips_ready) return false;
  let tried = ch.videos_tried_at;
  if (tried === undefined) {
    const { data } = await supabase.from("notebook_chapters").select("clips_ready,videos_tried_at").eq("id", ch.id).maybeSingle();
    const row = data as { clips_ready: boolean; videos_tried_at: string | null } | null;
    if (row?.clips_ready) return false;
    tried = row?.videos_tried_at ?? null;
  }
  return !tried || Date.now() - Date.parse(tried) > VIDEOS_RETRY_MS;
}

async function generateRun(nb: NotebookLite, ch: ChapterLite, opts: RunOpts): Promise<RunCard[] | null> {
  // Clips first: the lesson picks them from transcripts this call caches on
  // the chapter. If it fails the round simply carries no clips — never no round.
  if (await videosDue(ch)) {
    await advisorCall({
      advisor: "videos", topicId: nb.id, chapterId: ch.id, chapterTitle: ch.title, chapterObjective: ch.objective, chapterSummary: ch.summary,
      existing: ch.videos,
    });
  }
  const [{ count }, uid] = await Promise.all([
    supabase.from("notebook_chapters").select("id", { count: "exact", head: true }).eq("notebook_id", nb.id), currentUid(),
  ]);
  const interests = uid ? (await readLearn(uid)).interests ?? [] : [];
  const total = count ?? 0;
  const json = await advisorCall<{ cards?: RunCard[]; cached?: boolean }>({
    advisor: "lesson", topicId: nb.id, chapterId: ch.id, chapterTitle: ch.title, chapterObjective: ch.objective, chapterSummary: ch.summary,
    chapterPos: total > 0 ? Math.min(1, Math.max(0, ch.idx / total)) : 0,
    misses: opts.misses ?? ch.misses ?? [], fade: ch.fade ?? 0, quant: !!ch.quant, n: 12, force: !!opts.force,
    interests: interests.slice(0, 6),
    // a first-ever round opens on the clip or the teach card, not on a guess
    ...(isColdNotebook(nb, ch) ? { noPretest: true } : {}),
  });
  if (json.error || !Array.isArray(json.cards) || !json.cards.length) return null;
  // The function writes the run to the chapter itself; when that PATCH failed
  // the cards would be regenerated tomorrow (and differ). One more try from
  // here, then say so — the round still runs on what came back.
  if (json.cached === false) {
    const { error } = await supabase.from("notebook_chapters").update({ run: json.cards, run_at: new Date().toISOString() }).eq("id", ch.id);
    if (error) opts.onNote?.("Cards written but not saved — tomorrow may rewrite them.");
  }
  return json.cards;
}

// One generation per chapter at a time. The home's prefetch and NotebookView's
// cold start can ask for the same chapter seconds apart, and each would spend
// ~30s (and the videos step) writing it twice. Module-level so it outlives a
// tab switch. A `force` call starts its own — it exists to replace a run that
// just came back unusable — but later callers still join it.
const inflight = new Map<string, Promise<RunCard[] | null>>();

// The cached run if there is one; otherwise ask the learn function to write it
// (it caches the run on the chapter row itself). `force` skips the cache — use
// it when buildSession rejected a cached run as unusable.
export async function ensureRun(nb: NotebookLite, ch: ChapterLite, opts: RunOpts = {}): Promise<RunCard[] | null> {
  try {
    if (!opts.force) {
      const cached = await fetchRun(ch.id);
      if (cached) return cached;
      const running = inflight.get(ch.id);
      if (running) return await running;
    }
    const p = generateRun(nb, ch, opts).catch(() => null).finally(() => { if (inflight.get(ch.id) === p) inflight.delete(ch.id); });
    inflight.set(ch.id, p);
    return await p;
  } catch { return null; }
}

export async function buildChapters(uid: string, nb: NotebookLite, existingTitles: string[], replace: boolean): Promise<{ added: number; error?: string }> {
  try {
    const json = await advisorCall<{ trunk?: string; chapters?: Record<string, unknown>[] }>({
      advisor: "syllabus", topicId: nb.id, title: nb.title, subject: nb.course || nb.title, kind: nb.kind, existing: replace ? [] : existingTitles,
    });
    if (json.error) return { added: 0, error: json.error };
    if (!json.chapters?.length) return { added: 0, error: "No chapters came back — try again." };
    const { data, error } = await supabase.rpc("upsert_notebook_chapters", { p_notebook_id: nb.id, p_chapters: json.chapters, p_replace: replace });
    if (error) return { added: 0, error: "Built the chapters but couldn't save them — try again." };
    // the trunk is a one-line caption for the notebook; losing it costs nothing
    if (json.trunk) await supabase.from("notebooks").update({ trunk: json.trunk }).eq("id", nb.id).eq("user_id", uid);
    return { added: Number(data ?? 0) };
  } catch { return { added: 0, error: "Couldn't reach the server — check your connection and try again." }; }
}

// ─── Session rows ───────────────────────────────────────────────────────────
export async function startSession(uid: string, plan: SessionPlan): Promise<string | null> {
  const day = studyDay();
  const fields = {
    scope: plan.scope ?? "today", notebook_ids: plan.notebookIds, chapter_id: plan.chapterId, plan: plan.items, results: [], pos: 0,
  };
  try {
    const insert = () => supabase.from("study_sessions").insert({ user_id: uid, day, status: "open", ...fields }).select("id").single();
    const { data, error } = await insert();
    if (!error && data) return data.id as string;
    // One open session per day. A stale one with no answers takes on the new
    // plan (Ben just tapped Start). One WITH answers is a round he walked away
    // from: it is settled — scored, through the finish path — and the insert
    // tried once more. Its answers are never overwritten.
    if (error?.code === "23505") {
      const { data: open } = await supabase.from("study_sessions").select("*").eq("user_id", uid).eq("day", day).eq("status", "open").maybeSingle();
      if (!open) return null;
      const row = open as StudySessionRow;
      if (!Array.isArray(row.results) || !row.results.length) {
        const { error: e2 } = await supabase.from("study_sessions").update({ ...fields, started_at: new Date().toISOString() }).eq("id", row.id);
        return e2 ? null : row.id;
      }
      await settleOpenSession(uid, row);
      const { data: again, error: e3 } = await insert();
      if (!e3 && again) return again.id as string;
    }
    return null;
  } catch { return null; }
}

// Called every few answers and on close. A failure queues the snapshot locally;
// the next call (any session, any day) retries the queue first.
export async function flushResults(id: string, results: SessionResult[], pos: number): Promise<boolean> {
  const uid = await currentUid();
  if (uid) await drainPending(uid);
  if (!id) return false;
  const ok = await writeSession({ id, results, pos, at: Date.now() });
  if (!ok && uid) enqueue(uid, { id, results, pos, at: Date.now() });
  return ok;
}

// ─── Miss cards ─────────────────────────────────────────────────────────────
// The original card, minus the session bookkeeping — this is what gets stored
// in meta.item so the miss can be re-asked as itself.
const SESSION_KEYS = new Set(["id", "chapter_id", "notebook_id", "chapter_title", "pretest", "mixed", "retention", "reask"]);
function bareCard(item: SessionItem): RunCard | null {
  if (item.kind === "review" || item.kind === "teach") return null;
  return Object.fromEntries(Object.entries(item).filter(([k]) => !SESSION_KEYS.has(k))) as RunCard;
}
function answerText(card: RunCard): string {
  switch (card.kind) {
    case "mcq": case "scenario": return card.choices[card.answer] ?? "";
    case "blank": return card.answer.join(", ");
    case "order": return card.items.join(" → ");
    case "match": return card.pairs.map(([l, r]) => `${l} — ${r}`).join("; ");
    case "worked": return card.steps.map((s) => s.text).join(" ");
    case "teach": return "";
  }
}
// PostgREST ilike treats % and _ as wildcards; blank stems are full of ___.
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function selectMissCard(item: Extract<SessionItem, { chapter_id: string }>, front: string, fuzzy: boolean): Promise<NBCard | null> {
  let q = supabase.from("notebook_cards").select(CARD_COLS).eq("notebook_id", item.notebook_id).eq("chapter_id", item.chapter_id).eq("origin", "miss");
  q = fuzzy ? q.ilike("front", escapeLike(front)) : q.eq("front", front);
  const { data } = await q.limit(1).maybeSingle();
  return (data as NBCard | null) ?? null;
}

// How many NEW miss cards one round may still create. Shared by every
// recordMiss of that round: the check and the decrement sit between awaits, so
// parallel calls can't overspend it. A miss that already has a card always
// re-rates it, and every miss reaches chapter.misses — only creation is capped.
type NewCardBudget = { left: number };

// A wrong first attempt becomes (or re-rates) a review card, and the question
// is remembered on the chapter so the next lesson and retention check know.
export async function recordMiss(uid: string, item: SessionItem, wrongDetail?: string, budget: NewCardBudget = { left: 1 }): Promise<void> {
  try {
    const card = bareCard(item);
    if (!card || item.kind === "review" || item.kind === "teach") return;
    const front = stemOf(card).trim().slice(0, 600);
    if (!front) return;
    const now = new Date();
    const existing = await selectMissCard(item, front, false);
    if (existing) {
      await supabase.from("notebook_cards").update(reviewCard(existing, Rating.Again, now)).eq("id", existing.id);
    } else if (budget.left > 0) {
      budget.left--;
      const explain = "explain" in card ? card.explain : "";
      const row = {
        user_id: uid, notebook_id: item.notebook_id, chapter_id: item.chapter_id, origin: "miss",
        front, back: [answerText(card), explain].filter(Boolean).join(" — ").slice(0, 1200), hint: (wrongDetail ?? "").slice(0, 400),
        meta: { item: card, notebook_title: item.chapter_title }, ...reviewCard(emptyCardState(now), Rating.Again, now),
      };
      const { error } = await supabase.from("notebook_cards").insert(row);
      // 23505 = the unique index caught a case-insensitive duplicate: rate that one instead (nothing new was made)
      if (error?.code === "23505") {
        budget.left++;
        const dup = await selectMissCard(item, front, true);
        if (dup) await supabase.from("notebook_cards").update(reviewCard(dup, Rating.Again, now)).eq("id", dup.id);
      }
    }
    const { data: chRow } = await supabase.from("notebook_chapters").select("misses").eq("id", item.chapter_id).maybeSingle();
    const misses: string[] = Array.isArray(chRow?.misses) ? chRow.misses.map(String) : [];
    if (!misses.includes(front)) {
      await supabase.from("notebook_chapters").update({ misses: [...misses, front].slice(-MAX_CHAPTER_MISSES) }).eq("id", item.chapter_id);
    }
  } catch { /* a miss card is a bonus on top of the session result, never a blocker */ }
}

// ─── Reviews ────────────────────────────────────────────────────────────────
// Rate from the FRESH row, never from the plan snapshot: a card reviewed in the
// Cards tab since the plan was built is no longer due and must not be re-rated.
export async function rateReviewFresh(card: NBCard, rating: Grade): Promise<"rated" | "skipped" | "failed"> {
  try {
    const { data, error } = await supabase.from("notebook_cards").select(CARD_COLS).eq("id", card.id).maybeSingle();
    if (error) return "failed";
    const fresh = data as NBCard | null;
    if (!fresh || !isDue(fresh)) return "skipped";
    const { error: e2 } = await supabase.from("notebook_cards").update(reviewCard(fresh, rating)).eq("id", card.id);
    return e2 ? "failed" : "rated";
  } catch { return "failed"; }
}
export async function rateReview(card: NBCard, rating: Grade): Promise<boolean> {
  return (await rateReviewFresh(card, rating)) === "rated";
}

// ─── Finishing ──────────────────────────────────────────────────────────────
export type ChapterOutcome = { status: string; checkAt: string | null; becameDone: boolean };
const daysFrom = (now: Date, n: number) => new Date(now.getTime() + n * 86400000).toISOString();

async function applyChapterResult(chapterId: string, score: SessionScore, now: Date): Promise<ChapterOutcome | null> {
  const { data, error } = await supabase.from("notebook_chapters").select("status,best_score,attempts").eq("id", chapterId).maybeSingle();
  if (error || !data) return null;
  const c = data as { status: string; best_score: number; attempts: number };
  const patch: Record<string, unknown> = {};
  let status = c.status;
  let becameDone = false;
  if (score.retention.asked > 0) {
    // the check: two of three still right means it held
    const held = score.retention.right >= 2;
    status = held ? "done" : "active";
    becameDone = held && c.status !== "done";
    patch.retention_check_at = null;
  } else if (score.chapterAsked > 0) {
    const attempts = (c.attempts ?? 0) + 1;
    patch.attempts = attempts;
    patch.best_score = Math.max(c.best_score ?? 0, score.chapterPct);
    if (score.chapterPct >= PASS_PCT) {
      status = c.status === "done" ? "done" : "passed";
      patch.retention_check_at = daysFrom(now, score.chapterPct >= 90 ? 3 : 2);
    } else {
      // two misses in a row → rest it for three days (stored in retention_check_at as "come back at")
      status = attempts >= 2 ? "stuck" : "active";
      patch.retention_check_at = status === "stuck" ? daysFrom(now, 3) : null;
    }
  } else {
    return { status: c.status, checkAt: null, becameDone: false };
  }
  patch.status = status;
  const { error: e2 } = await supabase.from("notebook_chapters").update(patch).eq("id", chapterId);
  if (e2) return null;
  return { status, checkAt: (patch.retention_check_at as string | null) ?? null, becameDone };
}

async function closeSession(
  uid: string, id: string, plan: SessionPlan, results: SessionResult[], stats: Record<string, unknown>, now: Date, day: string,
): Promise<boolean> {
  const doneFields = { status: "done", stats, results, pos: plan.items.length, finished_at: now.toISOString(), day };
  if (id) {
    const { error } = await supabase.from("study_sessions").update(doneFields).eq("id", id);
    return !error;
  }
  // the row never got created at the start (offline then) — create it finished now
  const { error } = await supabase.from("study_sessions").insert({
    user_id: uid, scope: plan.scope ?? "today", notebook_ids: plan.notebookIds, chapter_id: plan.chapterId, plan: plan.items, ...doneFields,
  });
  return !error;
}

async function claimXp(uid: string, day: string, key: string, xp: number): Promise<"ok" | "already" | "failed"> {
  const { error } = await supabase.from("quest_claims").insert({ user_id: uid, day, quest_key: key, xp });
  if (!error) return "ok";
  return error.code === "23505" ? "already" : "failed";
}

function weekStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); // Monday
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
// The week so far: days studied, the goal he picked (3–6, default 4) and
// whether this is the most days he has ever done in a week. A new best is
// stored; the done screen says it. Never a streak, never a zero.
export type WeekProgress = { days: number; goal: number; best: number; isBest: boolean };
export const weekGoalOf = (learn: LearnSettings): number => Math.max(3, Math.min(6, Math.round(Number(learn.week_goal) || WEEK_GOAL_DEFAULT)));
async function bumpBestWeek(uid: string, now: Date): Promise<WeekProgress | null> {
  const { data, error } = await supabase.from("study_sessions").select("day").eq("user_id", uid).eq("status", "done").gte("day", weekStart(studyDay(now)));
  if (error) return null;
  const days = new Set((data ?? []).map((r) => (r as { day: string }).day)).size;
  const learn = await readLearn(uid);
  const prev = learn.best_week ?? 0;
  const isBest = days > prev && prev >= 2;
  if (days > prev) await patchLearn(uid, { best_week: days });
  return { days, goal: weekGoalOf(learn), best: Math.max(prev, days), isBest };
}

export type Finished = { xp: number; note: string; chapter: ChapterOutcome | null; week: WeekProgress | null };

// THE finish path. A tapped Finish, a quit during the retry slots and a stale
// row being settled all land here, so no way of ending a round can score
// differently from another. `day` is the study day the answers belong to —
// a settled row keeps its own, so its dot and XP land where they were earned.
// Order: chapter result → session done → miss cards → XP → last studied.
// Each step reports on its own and none may hold the done screen past 8s.
async function settle(
  uid: string, id: string, plan: SessionPlan, results: SessionResult[], score: SessionScore, day: string, now: Date,
): Promise<Finished> {
  const notes: string[] = [];
  let xp = 0;
  const step = <T,>(p: Promise<T>, fallback: T) => withTimeout(p, fallback);

  let chapter: ChapterOutcome | null = null;
  if (plan.chapterId) {
    chapter = await step(applyChapterResult(plan.chapterId, score, now), null);
    if (!chapter) notes.push("Couldn't save the chapter result — this round's score won't count. Your review cards are saved.");
  }

  const stats = {
    asked: score.asked, right: score.right, pct: score.pct, chapter_pct: score.chapterPct, misses: score.misses.length,
    sure_but_wrong: score.sureButWrong, retention: score.retention, retention_asked: score.retention.asked, retention_ok: score.retention.right,
    chapter_asked: score.chapterAsked, chapter_right: score.chapterRight, chapter_status: chapter?.status ?? null,
  };
  const closed = await step(closeSession(uid, id, plan, results, stats, now, day), false);
  if (closed) {
    // an older snapshot must never land on top of the finished row
    if (id) forgetPending(uid, id);
  } else {
    if (id) enqueue(uid, { id, results, pos: plan.items.length, done: true, stats, at: now.getTime() });
    notes.push(id ? "Saved locally — will sync next time." : "This round couldn't be saved — the reps still count for you.");
  }

  const budget: NewCardBudget = { left: MAX_NEW_MISS_CARDS };
  await step(Promise.all(score.misses.filter((m) => m.kind !== "review").map((m) => recordMiss(uid, m, undefined, budget))), []);

  // a quick feed pays per right answer only — showing up was already banked by the round
  const sessionXp = (plan.scope === "quick" ? 0 : SESSION_XP) + score.right * RIGHT_XP;
  const banked = sessionXp > 0 ? await step(claimXp(uid, day, `nb_sess_${id || now.getTime()}`, sessionXp), "failed") : "already";
  if (banked === "ok") xp += sessionXp;
  else if (banked === "failed") notes.push("Couldn't bank the XP this time.");
  if (chapter?.becameDone && plan.chapterId) {
    // one-time payout per chapter; the fixed day makes the unique key global
    if ((await step(claimXp(uid, "2000-01-01", `nb_ch_${plan.chapterId}`, CHAPTER_DONE_XP), "failed")) === "ok") xp += CHAPTER_DONE_XP;
  }

  await step(Promise.all(plan.notebookIds.map((nid) => supabase.from("notebooks").update({ last_studied_at: now.toISOString() }).eq("id", nid))), []);
  const week = await step(bumpBestWeek(uid, now), null);

  return { xp, note: notes.join(" · "), chapter, week };
}

export function finishSession(uid: string, id: string, plan: SessionPlan, results: SessionResult[], score: SessionScore): Promise<Finished> {
  const now = new Date();
  return settle(uid, id, plan, results, score, studyDay(now), now);
}

// A round Ben walked away from — quit in the retry slots, "Study this now"
// over an open round, a row left open for days — gets the credit it earned:
// scored and written by the same path as a normal finish, on its own day.
// No toast, no prefetch; the caller decides what to show.
export async function settleOpenSession(uid: string, row: StudySessionRow): Promise<void> {
  try {
    // Settle once. The home's reload and a Start over the same row can both
    // arrive here; whichever is second finds it closed and does nothing (a
    // second pass would count the chapter attempt twice).
    const { data: fresh } = await supabase.from("study_sessions").select("status").eq("id", row.id).maybeSingle();
    if (!fresh || (fresh as { status: string }).status !== "open") return;
    const plan = planFromRow(row);
    const results = Array.isArray(row.results) ? row.results : [];
    await settle(uid, row.id, plan, results, scoreSession(plan, results), localDay(row.day), new Date());
  } catch { /* the row stays open; the next reload settles it again */ }
}

// ─── Tomorrow ───────────────────────────────────────────────────────────────
// What tomorrow's session will open with, given today's home + cached runs.
export function predictNext(home: LearnHome, runs: Record<string, RunCard[]>, now: Date): { chapter: ChapterLite | null; cached: boolean } {
  const plan = buildSession(home, runs, { now: new Date(now.getTime() + 86400000), scope: "today" });
  const id = plan.prepare?.chapter?.id ?? plan.chapterId;
  const chapter = id ? home.chapters.find((c) => c.id === id) ?? null : null;
  return { chapter, cached: !!chapter && !plan.prepare };
}

// What tomorrow's round opens with, from its (now cached) run: the chapter
// and the first question's stem. Null when nothing is queued or the run is
// not there yet. The push notification and the feed's closing line read it.
export async function tomorrowOpener(home: LearnHome, now: Date): Promise<{ chapter: ChapterLite; nb: NotebookLite; stem: string } | null> {
  const { chapter } = predictNext(home, {}, now);
  const nb = chapter ? home.notebooks.find((n) => n.id === chapter.notebook_id) : null;
  if (!chapter || !nb) return null;
  const run = await fetchRun(chapter.id);
  if (!run) return null;
  const plan = buildSession(home, { [chapter.id]: run }, { now: new Date(now.getTime() + 86400000), scope: "today" });
  const first = planOpener(plan, nb.title);
  return first ? { chapter, nb, stem: first.stem.slice(0, NUDGE_TEXT_MAX) } : null;
}

// Write tomorrow's run now so the Today card never has to say "preparing",
// then leave the opening question in user_settings.learn.nudge — the push
// notification's body, so it can quote the real first question, never a nag.
// Resolves to tomorrow's opening stem (null when nothing is queued yet) so the
// done screen can show the open loop without a second read.
export async function prefetchNext(home: LearnHome, runs: Record<string, RunCard[]>, now: Date, onNote?: (note: string) => void): Promise<string | null> {
  const { chapter, cached } = predictNext(home, runs, now);
  if (chapter && !cached) {
    const nb = home.notebooks.find((n) => n.id === chapter.notebook_id);
    if (nb) await ensureRun(nb, chapter, { onNote });
  }
  try {
    const [opener, uid] = await Promise.all([tomorrowOpener(home, now), currentUid()]);
    if (!opener) return null;
    if (uid) await patchLearn(uid, { nudge: { day: addDays(studyDay(now), 1), text: opener.stem, chapter_id: opener.chapter.id, nb: opener.nb.title } });
    return opener.stem;
  } catch { return null; /* the nudge falls back to its generic line */ }
}

// ─── "Didn't make sense" ────────────────────────────────────────────────────
// One tap, no typing. A clip is switched off on its card for good (a patch to
// the cached run — his own row); any card's stem joins chapter.misses so the
// next regeneration rewrites it. Returns false only when nothing could be saved.
export async function noSense(what: { chapterId: string; stem: string; clipK?: number }): Promise<boolean> {
  const kind = what.clipK !== undefined ? "clip" : "card";
  console.log(`[learn] no-sense ${what.chapterId} ${kind}`);
  try {
    if (what.clipK !== undefined) {
      const run = await fetchRun(what.chapterId);
      const card = run?.[what.clipK];
      if (run && card && card.kind === "teach") {
        run[what.clipK] = { ...card, clip_off: true };
        const { error } = await supabase.from("notebook_chapters").update({ run }).eq("id", what.chapterId);
        if (error) return false;
      }
    }
    const front = what.stem.trim().slice(0, 600);
    if (!front) return kind === "clip";
    const { data, error } = await supabase.from("notebook_chapters").select("misses").eq("id", what.chapterId).maybeSingle();
    if (error) return false;
    const misses: string[] = Array.isArray(data?.misses) ? data.misses.map(String) : [];
    if (misses.includes(front)) return true;
    const { error: e2 } = await supabase.from("notebook_chapters").update({ misses: [...misses, front].slice(-MAX_CHAPTER_MISSES) }).eq("id", what.chapterId);
    return !e2;
  } catch { return false; }
}
