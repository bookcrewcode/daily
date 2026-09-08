// 📐 SESSION PLANNER — pure. No React, no supabase, no clock other than the one
// passed in. Everything here is a function of (home, cached runs, options), so
// the same inputs always give the same plan and every rule can be unit-tested.
//
// The one thing this file decides: what Ben studies today, in what order, and
// what "done" means for it. The side effects live in learnApi.ts.

import { retrievability, type NBCard } from "./fsrs";

// ─── Card shapes (mirror the lesson validator in the learn edge function) ────
export type RunDiagram = { kind: "flow" | "compare" | "cycle" | "stack"; title?: string; nodes: { label: string; note?: string }[] };
// A clip is a start/end window (seconds) of a real YouTube video, verified
// server-side against its transcript — a teach card gets none rather than a doubtful one.
export type TeachClip = { id: string; title: string; channel: string; start: number; end: number };
// clip_off: Ben said the clip made no sense — it stays off this card for good.
export type TeachCard = { kind: "teach"; text: string; diagram: RunDiagram | null; cite?: { chunk_id: string; quote: string }; clip?: TeachClip; clip_off?: boolean };
// hook: a ≤24-char tag when the card is set in one of his interests ("From your driving").
export type ChoiceCard = { kind: "mcq" | "scenario"; q: string; situation: string; choices: string[]; answer: number; explain: string; why_wrong?: string[]; hook?: string };
export type BlankCard = { kind: "blank"; sentence: string; bank: string[]; answer: string[]; explain: string };
export type OrderCard = { kind: "order"; prompt: string; items: string[]; explain: string };
export type MatchCard = { kind: "match"; prompt: string; pairs: [string, string][]; explain: string };
export type WorkedStep = { text: string; ask?: { q: string; choices: string[]; answer: number } };
export type WorkedCard = { kind: "worked"; problem: string; steps: WorkedStep[]; explain: string };
export type RunCard = (TeachCard | ChoiceCard | BlankCard | OrderCard | MatchCard | WorkedCard) & { pretest?: boolean; pretest_of?: number };
export type QuestionCard = Exclude<RunCard, { kind: "teach" }>;

// ─── What learn_home returns ────────────────────────────────────────────────
export type ChapterLite = {
  id: string; notebook_id: string; idx: number; title: string; objective: string; summary: string;
  status: string; best_score: number; week: number | null; due: string | null;
  has_run: boolean; run_at: string | null; retention_check_at: string | null; attempts: number; fade: number; quant: boolean;
  videos: { id: string; title: string; channel: string; why: string }[]; misses: string[]; clips_ready: boolean;
  videos_tried_at?: string | null;   // last failed video hunt; ensureRun retries at most once a day
};
export type NotebookLite = { id: string; title: string; emoji: string; course: string; course_key: string | null; kind: string; last_studied_at: string | null };
export type DeadlineLite = {
  id: string; course: string; course_key: string | null; title: string; kind: string; due_at: string; start_by: string | null;
  notebook_id: string | null; done: boolean;
};
// A due card row carries its origin and meta so a missed interactive card can be
// re-asked as itself instead of as a flat flashcard.
export type DueCard = NBCard & { origin?: string; meta?: { item?: RunCard; notebook_title?: string } | null };
export type LearnSettings = {
  session_cap?: number; review_cap?: number; best_week?: number; week_goal?: number; anchor?: string; interests?: string[];
  nudge_on?: boolean; nudge_at?: string; tz?: string; nudge_sent_day?: string;
  nudge?: { day: string; text: string; chapter_id: string; nb: string };
};
export type LearnHome = {
  notebooks: NotebookLite[]; chapters: ChapterLite[]; due_cards: DueCard[]; due_count: number;
  deadlines: DeadlineLite[]; open_session: StudySessionRow | null; week_days: string[]; done_today: boolean;
  settings: LearnSettings; source_counts: Record<string, number>;
};

// ─── The plan ───────────────────────────────────────────────────────────────
export type SessionItem =
  | { id: string; kind: "review"; card: DueCard; card_id: string; item?: RunCard }
  | (RunCard & {
      id: string; kind: RunCard["kind"]; chapter_id: string; notebook_id: string; chapter_title: string;
      pretest?: boolean; mixed?: boolean; retention?: boolean; reask?: boolean;
      // quick feed only: the short clip shown above this question, and the run index of the teach card it came from
      feedClip?: { clip: TeachClip; k: number };
    });
export type SessionResult = { id: string; ok: boolean; attempt: 1 | 2; ms: number; rating?: number; skipped?: boolean };
export type SessionScope = "today" | "chapter" | "quick";
export type StudySessionRow = {
  id: string; user_id: string; day: string; scope: SessionScope; status: "open" | "done";
  notebook_ids: string[]; chapter_id: string | null; plan: SessionItem[]; results: SessionResult[]; pos: number;
  stats: Record<string, unknown> | null; started_at: string; finished_at: string | null;
};
export type TodayState = "no-notebooks" | "no-sources" | "needs-chapters" | "preparing" | "ready" | "resume" | "done-today" | "ai-off";
export type SessionPlan = {
  state: TodayState; items: SessionItem[]; retrySlots: number; why: string; notebookIds: string[];
  chapterId: string | null; notebookId: string | null; minutes: number; scope?: SessionScope;
  prepare?: { notebookId: string; chapter: ChapterLite | null; reason: "no-chapters" | "no-run" };
  nextDeadline?: DeadlineLite | null;
};
export type SessionScore = {
  asked: number; right: number; pct: number; chapterPct: number; misses: SessionItem[]; sureButWrong: number;
  chapterAsked: number; chapterRight: number; retention: { asked: number; right: number };
};

export const RETRY_SLOTS = 4;
export const NEW_BLOCK = 10;
export const PASS_PCT = 80;
export const SESSION_CAP = 12;
export const REVIEW_FLOOR = 4;
const MIN_QUESTIONS = 7;
const MIXED_POSITIONS = [4, 8, 12];
// Two reviews open the round (a warm-up, not a wall); the rest are woven into
// the chapter block so the new idea arrives within a minute of tapping Start.
const OPENERS = 2;
const REVIEW_POSITIONS = [3, 6, 9, 12, 15, 18];
const MIXED_COUNT = 3;
const RETENTION_COUNT = 3;
export const SECONDS_PER_ITEM = 25;
const TARGET_R = 0.6;              // the recall probability a review is most worth doing at
const FEED_CLIP_MAX_S = 75;        // a quick-feed clip is a bite, not a lecture

// ─── Dates (local, because "today" is the day Ben is living in) ─────────────
const pad = (n: number) => String(n).padStart(2, "0");
export function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseDay(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
// The local calendar date of a timestamp (or a date string, passed through).
export function localDay(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : dateStr(new Date(iso));
}
// Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` is past.
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / 86400000);
}
export function addDays(day: string, n: number): string {
  const d = parseDay(day); d.setDate(d.getDate() + n); return dateStr(d);
}

// A late night counts as the same study day: 00:00–03:59 belongs to yesterday,
// so finishing at 1am still lights yesterday's dot instead of spending today's.
export function studyDay(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  if (d.getHours() < 4) d.setDate(d.getDate() - 1);
  return dateStr(d);
}

// Same normalisation as the SQL course_key(): uppercase, drop the section
// suffix, keep letters and digits. "ECON 201-01", "Econ 201" → ECON201;
// "01:220:102:01" → 01220102.
export function courseKey(s: string): string {
  const up = (s || "").toUpperCase().trim().replace(/\s+/g, " ");
  const noSection = up.replace(/(?:\s*[-:]\s*|\s+(?:SEC|SECTION)\s*)\d{1,2}$/, "");
  return noSection.replace(/[^A-Z0-9]/g, "");
}

// ─── Deadlines → urgency ────────────────────────────────────────────────────
const KIND_W: Record<string, number> = { exam: 1, quiz: 0.8, assignment: 0.6 };
const kindW = (k: string) => KIND_W[k] ?? 0.3;

export function linkedDeadlines(nb: NotebookLite, deadlines: DeadlineLite[]): DeadlineLite[] {
  return deadlines
    .filter((d) => !d.done && (d.notebook_id === nb.id || (!!nb.course_key && d.course_key === nb.course_key)))
    .sort((a, b) => a.due_at.localeCompare(b.due_at));
}

// kindW × pace. pace is the larger of "how close is start_by" and "chapters
// left per day until it's due" — either one alone can make a notebook urgent.
export function urgency(nb: NotebookLite, deadlines: DeadlineLite[], chaptersLeft: number, today: string): number {
  let best = 0;
  for (const d of linkedDeadlines(nb, deadlines)) {
    const dueDay = localDay(d.due_at);
    const toStart = daysBetween(today, d.start_by ? localDay(d.start_by) : dueDay);
    const toDue = daysBetween(today, dueDay);
    const startPace = toStart <= 0 ? 1 : Math.max(0, 1 - toStart / 7);
    const workPace = Math.min(1, chaptersLeft / Math.max(1, toDue));
    best = Math.max(best, kindW(d.kind) * Math.max(startPace, workPace));
  }
  return best;
}

// ─── Chapters ───────────────────────────────────────────────────────────────
// Class notebooks read by week (unknown weeks last); personal ones by idx.
export function orderChapters(nb: NotebookLite, chapters: ChapterLite[]): ChapterLite[] {
  const mine = chapters.filter((c) => c.notebook_id === nb.id);
  return mine.sort((a, b) => {
    if (nb.kind === "class") {
      const aw = a.week ?? Number.POSITIVE_INFINITY, bw = b.week ?? Number.POSITIVE_INFINITY;
      if (aw !== bw) return aw - bw;
    }
    return a.idx - b.idx;
  });
}

function retentionDue(c: ChapterLite, today: string): boolean {
  return c.status === "passed" && !!c.retention_check_at && localDay(c.retention_check_at) <= today;
}
// A stuck chapter rests for three days; finishSession stores "come back at" in
// retention_check_at so the rest needs no extra column.
function resting(c: ChapterLite, today: string): boolean {
  return c.status === "stuck" && !!c.retention_check_at && localDay(c.retention_check_at) > today;
}
function workable(c: ChapterLite, today: string): boolean {
  return c.status === "active" || (c.status === "stuck" && !resting(c, today));
}
// Chapters still to be learned (passed = learned, waiting on its check).
export function chaptersLeft(nb: NotebookLite, chapters: ChapterLite[]): number {
  return chapters.filter((c) => c.notebook_id === nb.id && (c.status === "active" || c.status === "stuck")).length;
}

// Which week the semester is "at": the week of the chapter whose due date is
// nearest the anchor (the next linked deadline, else today). Null when the
// syllabus carries no dates — then plain order wins.
function targetWeek(mine: ChapterLite[], linked: DeadlineLite[], today: string): number | null {
  const dated = mine.filter((c) => c.due && c.week !== null);
  if (!dated.length) return null;
  const anchor = linked[0] ? localDay(linked[0].due_at) : today;
  let best = dated[0], bestD = Number.POSITIVE_INFINITY;
  for (const c of dated) {
    const d = Math.abs(daysBetween(localDay(c.due as string), anchor));
    if (d < bestD) { bestD = d; best = c; }
  }
  return best.week;
}

export function pickChapter(nb: NotebookLite, chapters: ChapterLite[], deadlines: DeadlineLite[], today: string): ChapterLite | null {
  const mine = orderChapters(nb, chapters);
  const checks = mine.filter((c) => retentionDue(c, today))
    .sort((a, b) => (a.retention_check_at as string).localeCompare(b.retention_check_at as string));
  if (checks.length) return checks[0];
  const open = mine.filter((c) => workable(c, today));
  if (!open.length) return null;
  if (nb.kind !== "class") return open[0];
  const target = targetWeek(mine, linkedDeadlines(nb, deadlines), today);
  if (target === null) return open[0];
  let best = open[0], bestD = Number.POSITIVE_INFINITY;
  for (const c of open) {
    const d = c.week === null ? Number.POSITIVE_INFINITY : Math.abs(c.week - target);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// ─── Notebook choice ────────────────────────────────────────────────────────
// Notebooks that can be studied right now outrank ones that need a build,
// which outrank empty ones, which outrank finished ones. Within a tier the
// weighted score decides; a tie goes to whichever has waited longest.
function tierOf(home: LearnHome, nb: NotebookLite, today: string): number {
  const mine = home.chapters.filter((c) => c.notebook_id === nb.id);
  if (mine.length) return pickChapter(nb, home.chapters, home.deadlines, today) ? 3 : 0;
  return (home.source_counts?.[nb.id] ?? 0) > 0 ? 2 : 1;
}

// A notebook mid-story: its next chapter was already attempted (it comes back
// rewritten) or a chapter is passed and waiting on its check. Unfinished
// business pulls harder than a stale notebook — unless a deadline somewhere
// is pressing.
function midStory(nb: NotebookLite, home: LearnHome, today: string): boolean {
  const mine = home.chapters.filter((c) => c.notebook_id === nb.id);
  if (mine.some((c) => c.status === "passed" && !!c.retention_check_at)) return true;
  const next = pickChapter(nb, home.chapters, home.deadlines, today);
  return !!next && next.status === "active" && next.attempts > 0;
}
const STICKY = 0.5;
const STICKY_MAX_URGENCY = 0.3;

export function pickNotebook(home: LearnHome, today: string): NotebookLite | null {
  if (!home.notebooks.length) return null;
  const totalDue = home.due_cards.length;
  const urgencies = home.notebooks.map((nb) => urgency(nb, home.deadlines, chaptersLeft(nb, home.chapters), today));
  const calm = Math.max(0, ...urgencies) <= STICKY_MAX_URGENCY;
  const scored = home.notebooks.map((nb, i) => {
    const mine = home.chapters.filter((c) => c.notebook_id === nb.id);
    const left = chaptersLeft(nb, home.chapters);
    const staleness = nb.last_studied_at ? Math.min(1, Math.max(0, daysBetween(localDay(nb.last_studied_at), today)) / 4) : 0.5;
    const backlog = mine.length ? left / mine.length : 0;
    const dueShare = totalDue ? home.due_cards.filter((c) => c.notebook_id === nb.id).length / totalDue : 0;
    const sticky = calm && midStory(nb, home, today) ? STICKY : 0;
    const score = 0.45 * urgencies[i] + 0.25 * staleness + 0.2 * backlog + 0.1 * dueShare + sticky;
    return { nb, tier: tierOf(home, nb, today), score };
  });
  scored.sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier;
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
    const al = a.nb.last_studied_at ?? "", bl = b.nb.last_studied_at ?? "";
    if (al !== bl) return al.localeCompare(bl);
    return a.nb.id.localeCompare(b.nb.id);
  });
  return scored[0].nb;
}

// ─── Run trimming ───────────────────────────────────────────────────────────
const isQuestion = (c: RunCard) => c.kind !== "teach";
const questionCount = (cards: RunCard[]) => cards.filter(isQuestion).length;

// Trim to about `n` cards by dropping whole teach+question groups from the end,
// never inside a group and never below the invariants the run relies on. A run
// that fails the invariants even untrimmed is unusable → [] (caller regenerates).
export function prepareRun(cards: RunCard[], n: number): RunCard[] {
  if (!Array.isArray(cards) || !cards.length) return [];
  const groups: RunCard[][] = [];
  for (const c of cards) {
    if (c.kind === "teach" || !groups.length) groups.push([c]);
    else groups[groups.length - 1].push(c);
  }
  const flat = () => groups.flat();
  const canDrop = () => groups.length > 1 && questionCount(groups.slice(0, -1).flat()) >= MIN_QUESTIONS;
  while (flat().length > n && canDrop()) groups.pop();
  const out = flat();
  for (let i = 0; i < out.length; i++) {
    if (out[i].kind === "teach" && (i + 1 >= out.length || out[i + 1].kind === "teach")) return [];
  }
  return questionCount(out) >= MIN_QUESTIONS ? out : [];
}

// ─── Deterministic shuffle ──────────────────────────────────────────────────
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 233280 || 1;
}
// Shuffle of INDICES, stable for a seed — the renderers track indices, never
// label text, so repeated words can never make a card unsolvable.
export function shuffledIdx(n: number, seed: number): number[] {
  const a = Array.from({ length: n }, (_, k) => k);
  let s = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const stemOf = (c: RunCard): string => {
  switch (c.kind) {
    case "teach": return c.text;
    case "mcq": case "scenario": return c.q;
    case "blank": return c.sentence;
    case "order": case "match": return c.prompt;
    case "worked": return c.problem;
  }
};

// ─── Building the session ───────────────────────────────────────────────────
export function estimateMinutes(n: number): number {
  return Math.ceil((n * SECONDS_PER_ITEM) / 60);
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const reviewItemId = (cardId: string) => `rv:${cardId}`;

type ChapterItem = Extract<SessionItem, { chapter_id: string }>;
function chapterItem(ch: ChapterLite, card: RunCard, k: number, prefix: string, tag?: "mixed" | "retention"): ChapterItem {
  return {
    ...card, id: `${prefix}:${ch.id}:${k}`, chapter_id: ch.id, notebook_id: ch.notebook_id, chapter_title: ch.title,
    ...(tag ? { [tag]: true } : {}),
  };
}

// Which reviews matter most: a card just forgotten (FSRS "relearning" — the
// one he was sure about and got wrong) first, then the ones nearest the 60%
// recall sweet spot, then the longest overdue. Deterministic: ties by id.
const RELEARNING = 3;
export function reviewOrder(cards: DueCard[], now: Date): DueCard[] {
  const key = (c: DueCard) => [c.state === RELEARNING ? 0 : 1, Math.abs(retrievability(c, now) - TARGET_R)] as const;
  return [...cards].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || a.due.localeCompare(b.due) || a.id.localeCompare(b.id);
  });
}
const asReviewItem = (card: DueCard): SessionItem => {
  const item = card.origin === "miss" && card.meta?.item && card.meta.item.kind !== "teach" ? card.meta.item : undefined;
  return { id: reviewItemId(card.id), kind: "review" as const, card, card_id: card.id, item };
};

function reviewBlock(home: LearnHome, answered: Set<string>, now: Date): SessionItem[] {
  const due = reviewOrder(home.due_cards.filter((c) => !c.suspended && !answered.has(reviewItemId(c.id))), now);
  const lower = home.settings?.review_cap ?? REVIEW_FLOOR;
  const cap = clamp(home.due_count, lower, Math.max(lower, 8));
  // round-robin by notebook so one heavy deck can't crowd the others out
  const byNb = new Map<string, DueCard[]>();
  for (const c of due) byNb.set(c.notebook_id, [...(byNb.get(c.notebook_id) ?? []), c]);
  const queues = [...byNb.values()];
  const out: DueCard[] = [];
  for (let i = 0; out.length < cap && queues.some((q) => q.length); i++) {
    const q = queues[i % queues.length];
    if (q.length) out.push(q.shift() as DueCard);
  }
  return out.map(asReviewItem);
}

// Questions from a cached run that Ben did NOT miss last time — the honest
// test of whether a chapter held. Falls back to all questions if he missed them all.
function questionsNotMissed(run: RunCard[], misses: string[]): { card: RunCard; k: number }[] {
  const all = run.map((card, k) => ({ card, k })).filter(({ card }) => isQuestion(card));
  const missed = new Set(misses.map((m) => m.trim().toLowerCase()));
  const fresh = all.filter(({ card }) => !missed.has(stemOf(card).trim().toLowerCase()));
  return fresh.length ? fresh : all;
}
function pickSome<T>(pool: T[], n: number, seed: number): T[] {
  return shuffledIdx(pool.length, seed).slice(0, n).map((i) => pool[i]);
}

// Three questions from chapters Ben already passed, weakest first, spread
// through the new block so old material keeps getting touched.
function mixedItems(nb: NotebookLite, chapters: ChapterLite[], runs: Record<string, RunCard[]>, current: ChapterLite, seed: number): ChapterItem[] {
  const pool = chapters
    .filter((c) => c.notebook_id === nb.id && c.id !== current.id && (c.status === "passed" || c.status === "done") && Array.isArray(runs[c.id]) && runs[c.id].length)
    .sort((a, b) => a.best_score - b.best_score || a.idx - b.idx);
  const out: ChapterItem[] = [];
  const cursors = pool.map((c) => pickSome(runs[c.id].map((card, k) => ({ card, k })).filter(({ card }) => isQuestion(card)), MIXED_COUNT, seed + c.idx));
  // one question per chapter per round, weakest chapter first
  while (out.length < MIXED_COUNT && cursors.some((q) => q.length)) {
    cursors.forEach((q, i) => {
      const next = out.length < MIXED_COUNT ? q.shift() : undefined;
      if (next) out.push(chapterItem(pool[i], next.card, next.k, "mx", "mixed"));
    });
  }
  return out;
}
// Drop extras into the block at fixed positions: never before the first
// teach card (the pretest stays glued to it) and never straight after a teach
// card (its own question comes first) — the slot moves one down instead.
// Extras that find no slot are appended when `keep` is set (a due review is
// owed) and dropped otherwise (a mixed question is a bonus).
function weaveInto<T extends SessionItem>(block: T[], extras: T[], positions: number[], keep = false): T[] {
  const firstTeach = block.findIndex((c) => c.kind === "teach");
  const out = [...block];
  let inserted = 0;
  for (let p of positions) {
    if (inserted >= extras.length) break;
    if (p > out.length || (firstTeach >= 0 && p <= firstTeach)) continue;
    if (out[p - 1]?.kind === "teach") p++;
    if (p > out.length) continue;
    out.splice(p, 0, extras[inserted++]);
  }
  return keep ? [...out, ...extras.slice(inserted)] : out;
}

// A chapter question that is also a due review card would be asked twice in
// one round; the review (scheduled, rated) wins. A teach card keeps at least
// one question so it never dangles; the pretest is never dropped.
function dedupeAgainstReviews(block: ChapterItem[], reviews: SessionItem[]): ChapterItem[] {
  const fronts = new Set(reviews.map((r) => (r.kind === "review" ? r.card.front : "")).map((f) => f.trim().toLowerCase()).filter(Boolean));
  if (!fronts.size) return block;
  const out: ChapterItem[] = [];
  for (let i = 0; i < block.length; i++) {
    const it = block[i];
    const dup = it.kind !== "teach" && !it.pretest && fronts.has(stemOf(it).trim().toLowerCase());
    if (!dup) { out.push(it); continue; }
    // keep it when it is the last question of its teach group
    const prevTeach = out.length && out[out.length - 1].kind === "teach";
    const nextIsQuestion = i + 1 < block.length && block[i + 1].kind !== "teach";
    if (prevTeach && !nextIsQuestion) out.push(it);
  }
  return out;
}

function weekday(day: string): string {
  return parseDay(day).toLocaleDateString("en-US", { weekday: "short" });
}
function shortDate(day: string): string {
  return parseDay(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
// Never a day count: a deadline gets its date, a lapse gets no number at all —
// "N days ago" reads as a nag, and this line is the first thing he sees.
function whyFor(nb: NotebookLite, next: DeadlineLite | null, left: number, today: string): string {
  if (next) {
    const dueDay = localDay(next.due_at);
    const days = daysBetween(today, dueDay);
    const when = days <= 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? weekday(dueDay) : shortDate(dueDay);
    return `${nb.course || nb.title} ${next.kind} ${when} · ${left} chapter${left === 1 ? "" : "s"} left`;
  }
  if (!nb.last_studied_at) return `${nb.title} — first round`;
  if (daysBetween(localDay(nb.last_studied_at), today) >= 2) return `${nb.title} — picking it back up`;
  return `${nb.title} — next in order`;
}

// ─── Open rows ──────────────────────────────────────────────────────────────
const RESUME_DAYS = 3;
// An open row that can't be picked up: its main block is complete (only the
// retry slots were left when he quit) or it's too old to resume. Either way it
// holds real answers and must be SETTLED — scored through the finish path —
// never flipped to done bare or overwritten by a new start.
export function needsSettling(row: StudySessionRow, today: string): boolean {
  const len = Array.isArray(row.plan) ? row.plan.length : 0;
  return row.pos >= len || daysBetween(localDay(row.day), today) > RESUME_DAYS;
}
// The plan a stored row was walking, rebuilt so scoreSession and the finish
// path see exactly what a live Session would have handed them.
export function planFromRow(row: StudySessionRow): SessionPlan {
  const items = Array.isArray(row.plan) ? row.plan : [];
  return {
    state: "ready", items, retrySlots: RETRY_SLOTS, why: "", notebookIds: row.notebook_ids ?? [], chapterId: row.chapter_id,
    notebookId: row.notebook_ids?.[0] ?? null, minutes: estimateMinutes(items.length), scope: row.scope ?? "today", nextDeadline: null,
  };
}

export function buildSession(
  home: LearnHome, runs: Record<string, RunCard[]>,
  opts: { now: Date; scope: "today" | "chapter"; chapterId?: string; aiOff?: boolean; answeredIds?: string[] },
): SessionPlan {
  const today = studyDay(opts.now);
  const answered = new Set(opts.answeredIds ?? []);
  const seed = hashSeed(`${today}:${opts.chapterId ?? ""}`);
  const mk = (state: TodayState, items: SessionItem[], why: string, extra: Partial<SessionPlan> = {}): SessionPlan => ({
    state, items, retrySlots: RETRY_SLOTS, why, notebookIds: [], chapterId: null, notebookId: null,
    minutes: estimateMinutes(items.length), scope: opts.scope, nextDeadline: null, ...extra,
  });
  const forToday = opts.scope === "today";

  if (!home.notebooks.length) return mk("no-notebooks", [], "Start a notebook — paste anything you're learning and I'll build the first round.");

  // An open session from the last three days wins: pick it up rather than plan
  // a new one over it. Past its last item (or older) it is finished, not
  // resumable — the home settles it through the finish path.
  // A quick-feed row left open is not today's round — startSession settles it
  // on the way in (the one-open-row index), so it is never resumed here.
  const open = home.open_session;
  if (forToday && open && open.status === "open" && open.scope !== "quick" && Array.isArray(open.plan) && !needsSettling(open, today)) {
    const left = open.plan.length - open.pos;
    return mk("resume", open.plan, `Pick up where you left off · ${left} left`, {
      notebookIds: open.notebook_ids ?? [], chapterId: open.chapter_id, notebookId: open.notebook_ids?.[0] ?? null,
      minutes: estimateMinutes(left),
    });
  }

  const reviews = forToday ? reviewBlock(home, answered, opts.now) : [];

  // which notebook, which chapter
  let nb: NotebookLite | null = null;
  let chosen: ChapterLite | null = null;
  if (!forToday && opts.chapterId) {
    chosen = home.chapters.find((c) => c.id === opts.chapterId) ?? null;
    nb = chosen ? home.notebooks.find((n) => n.id === chosen?.notebook_id) ?? null : null;
    if (!nb || !chosen) return mk("no-notebooks", [], "That chapter isn't here any more — pick another.");
  } else {
    nb = pickNotebook(home, today);
    if (!nb) return mk("no-notebooks", [], "Start a notebook to get a first round.");
  }
  const mine = orderChapters(nb, home.chapters);
  const linked = linkedDeadlines(nb, home.deadlines);
  const nextDeadline = linked[0] ?? null;
  const left = chaptersLeft(nb, home.chapters);
  const base: Partial<SessionPlan> = { notebookIds: [nb.id], notebookId: nb.id, nextDeadline };
  const needsAi = (state: TodayState) => (opts.aiOff ? "ai-off" : state);
  const doneState = (): TodayState => (forToday && home.done_today ? "done-today" : "ready");

  if (!mine.length) {
    if ((home.source_counts?.[nb.id] ?? 0) === 0) return mk("no-sources", reviews, `Paste something into ${nb.title} to get started`, base);
    return mk(needsAi("needs-chapters"), reviews, `${nb.title} has sources but no chapters yet`, {
      ...base, prepare: { notebookId: nb.id, chapter: null, reason: "no-chapters" },
    });
  }
  if (!chosen) chosen = pickChapter(nb, home.chapters, home.deadlines, today);
  if (!chosen) {
    // nothing left to learn here; the reviews are still worth doing
    const why = reviews.length ? `${reviews.length} to review · ${nb.title} is all caught up` : `${nb.title} is all caught up — add sources or a notebook`;
    return mk(reviews.length ? doneState() : "done-today", reviews, why, base);
  }

  const run = runs[chosen.id];
  const withChapter = { ...base, chapterId: chosen.id };
  if (!Array.isArray(run) || !run.length) {
    return mk(needsAi("preparing"), reviews, `Writing today's cards from ${nb.title}…`, {
      ...withChapter, prepare: { notebookId: nb.id, chapter: chosen, reason: "no-run" },
    });
  }

  let block: ChapterItem[];
  if (retentionDue(chosen, today)) {
    block = pickSome(questionsNotMissed(run, chosen.misses ?? []), RETENTION_COUNT, seed)
      .map(({ card, k }) => chapterItem(chosen as ChapterLite, card, k, "rt", "retention"));
  } else {
    const cards = prepareRun(run, NEW_BLOCK);
    if (!cards.length) {
      return mk(needsAi("preparing"), reviews, `Rewriting today's cards from ${nb.title}…`, {
        ...withChapter, prepare: { notebookId: nb.id, chapter: chosen, reason: "no-run" },
      });
    }
    block = dedupeAgainstReviews(cards.map((card, k) => chapterItem(chosen as ChapterLite, card, k, "ch")), reviews);
    block = weaveInto(block, mixedItems(nb, home.chapters, runs, chosen, seed), MIXED_POSITIONS);
  }
  block = block.filter((it) => !answered.has(it.id));

  // session_cap bounds the whole thing: mixed questions go first, then the
  // review block shrinks — but never below the review floor.
  const cap = home.settings?.session_cap ?? SESSION_CAP;
  let reviewList = reviews;
  while (block.length + reviewList.length > cap && block.some((b) => b.mixed)) {
    const last = block.map((b) => !!b.mixed).lastIndexOf(true);
    block.splice(last, 1);
  }
  const floor = home.settings?.review_cap ?? REVIEW_FLOOR;
  if (block.length + reviewList.length > cap) reviewList = reviewList.slice(0, Math.max(floor, cap - block.length));

  // two reviews open, the rest ride inside the chapter block
  const items: SessionItem[] = [...reviewList.slice(0, OPENERS), ...weaveInto<SessionItem>(block, reviewList.slice(OPENERS), REVIEW_POSITIONS, true)];
  const why = retentionDue(chosen, today)
    ? `Quick check on "${chosen.title}" — does it still hold?`
    : whyFor(nb, nextDeadline, left, today);
  return mk(doneState(), items, why, withChapter);
}

// First attempts only. pct counts every question Ben was actually being
// tested on (chapter + reviews); chapterPct is the chapter alone and decides
// pass/not-yet. Pretest, mixed and retention items never count against him.
export function scoreSession(plan: SessionPlan, results: SessionResult[]): SessionScore {
  const byId = new Map(plan.items.map((it) => [it.id, it]));
  let asked = 0, right = 0, cAsked = 0, cRight = 0, sureButWrong = 0;
  const retention = { asked: 0, right: 0 };
  const misses: SessionItem[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    // a resumed session can answer the same item twice; only the first counts
    if (r.attempt !== 1 || r.skipped || seen.has(r.id)) continue;
    seen.add(r.id);
    const it = byId.get(r.id);
    if (!it || it.kind === "teach") continue;
    if (it.kind === "review") {
      asked++;
      if (r.ok) right++; else { misses.push(it); if (r.ms < 4000) sureButWrong++; }
      continue;
    }
    if (it.retention) { retention.asked++; if (r.ok) retention.right++; else misses.push(it); continue; }
    if (it.pretest) continue;
    if (it.mixed) { if (!r.ok) misses.push(it); continue; }
    asked++; cAsked++;
    if (r.ok) { right++; cRight++; } else { misses.push(it); if (r.ms < 4000) sureButWrong++; }
  }
  const pctOf = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  return { asked, right, pct: pctOf(right, asked), chapterPct: pctOf(cRight, cAsked), chapterAsked: cAsked, chapterRight: cRight, misses, sureButWrong, retention };
}

// A notebook Ben has never finished a round in, on a chapter never attempted:
// the run is requested without a pretest so the round opens on the clip or
// the teach card, not on a question about something he has never seen.
export function isColdNotebook(nb: NotebookLite, ch: ChapterLite): boolean {
  return (ch.attempts ?? 0) === 0 && !nb.last_studied_at;
}

// ─── The quick feed ─────────────────────────────────────────────────────────
// What he opens when bored: every due card, then short clips (≤75 s) from any
// chapter with cards written, each paired with the question that follows it.
// Feed items are tagged `mixed` so a chapter never passes or fails from here,
// while a miss still records. Round-robin by notebook; same order all day.
export function buildQuickFeed(
  home: LearnHome, runs: Record<string, RunCard[]>, opts: { now: Date; max?: number; answeredIds?: string[] },
): SessionPlan {
  const max = opts.max ?? 20;
  const today = studyDay(opts.now);
  const answered = new Set(opts.answeredIds ?? []);
  const seed = hashSeed(`quick:${today}`);
  const reviews = reviewOrder(home.due_cards.filter((c) => !c.suspended && !answered.has(reviewItemId(c.id))), opts.now).map(asReviewItem);

  const byNb = new Map<string, ChapterItem[]>();
  for (const ch of home.chapters) {
    const run = runs[ch.id];
    if (ch.status === "stuck" || !Array.isArray(run) || !run.length) continue;
    const pairs: ChapterItem[] = [];
    run.forEach((card, k) => {
      const q = run[k + 1];
      if (card.kind !== "teach" || !card.clip || card.clip_off || !q || q.kind === "teach") return;
      if (card.clip.end - card.clip.start > FEED_CLIP_MAX_S) return;
      const item = chapterItem(ch, q, k + 1, "qf", "mixed");
      if (!answered.has(item.id)) pairs.push({ ...item, feedClip: { clip: card.clip, k } });
    });
    if (pairs.length) byNb.set(ch.notebook_id, [...(byNb.get(ch.notebook_id) ?? []), ...pickSome(pairs, pairs.length, seed + ch.idx)]);
  }
  const queues = [...byNb.values()];
  const clips: ChapterItem[] = [];
  for (let i = 0; queues.some((q) => q.length); i++) {
    const q = queues[i % queues.length];
    if (q.length) clips.push(q.shift() as ChapterItem);
  }
  const items: SessionItem[] = [...reviews, ...clips].slice(0, max);
  const notebookIds = [...new Set(items.map((it) => (it.kind === "review" ? it.card.notebook_id : it.notebook_id)))];
  return {
    state: items.length ? "ready" : "done-today", items, retrySlots: 0, why: items.length ? `${items.length} quick ones` : "Nothing quick left today",
    notebookIds, chapterId: null, notebookId: notebookIds[0] ?? null, minutes: estimateMinutes(items.length), scope: "quick", nextDeadline: null,
  };
}

// ─── The opener: what the Today card shows before anything else ────────────
export type PlanFirst = {
  id: string; kind: "mcq" | "scenario" | "review"; stem: string; situation?: string; choices?: string[]; answer?: number; notebook: string;
};
// items[0] when it is a choice question; else the first choice question in the
// chapter block; else the first review flashcard's front with no choices.
// `answered` (a resumed round's result ids) is skipped, so the Today card asks
// the next open item rather than one he already answered.
export function planOpener(plan: SessionPlan, notebookTitle: string, answered: readonly string[] = []): PlanFirst | null {
  const nbOf = (it: SessionItem) => (it.kind === "review" ? it.card.meta?.notebook_title || notebookTitle : notebookTitle);
  const choice = (it: SessionItem): PlanFirst | null => {
    const c = it.kind === "review" ? it.item : it;
    if (!c || (c.kind !== "mcq" && c.kind !== "scenario")) return null;
    return { id: it.id, kind: c.kind, stem: c.q, ...(c.situation ? { situation: c.situation } : {}), choices: c.choices, answer: c.answer, notebook: nbOf(it) };
  };
  const skip = new Set(answered);
  const items = skip.size ? plan.items.filter((it) => !skip.has(it.id)) : plan.items;
  const first = items[0];
  if (!first) return null;
  const opener = choice(first) ?? items.map(choice).find((x) => x !== null) ?? null;
  if (opener) return opener;
  const rv = items.find((it) => it.kind === "review");
  return rv && rv.kind === "review" ? { id: rv.id, kind: "review", stem: rv.card.front, notebook: nbOf(rv) } : null;
}
