// Unit tests for the pure session planner.
// Run: npx --yes tsx --test src/lib/session.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { retrievability } from "./fsrs";
import {
  studyDay, courseKey, urgency, pickNotebook, pickChapter, prepareRun, buildSession, scoreSession, estimateMinutes, needsSettling, planFromRow,
  buildQuickFeed, isColdNotebook, planOpener, reviewOrder,
  RETRY_SLOTS,
  type ChapterLite, type DeadlineLite, type DueCard, type LearnHome, type NotebookLite, type RunCard, type SessionResult, type StudySessionRow,
  type TeachCard,
} from "./session";

// ─── fixtures ───────────────────────────────────────────────────────────────
const NOW = new Date(2026, 8, 2, 10, 0, 0); // Wed Sep 2 2026, 10:00 local
const TODAY = "2026-09-02";
const iso = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();

const nb = (o: Partial<NotebookLite> = {}): NotebookLite => ({
  id: "nb1", title: "Econ", emoji: "📈", course: "ECON 201", course_key: "ECON201", kind: "personal", last_studied_at: null, ...o,
});
const ch = (o: Partial<ChapterLite> = {}): ChapterLite => ({
  id: "c1", notebook_id: "nb1", idx: 0, title: "Supply", objective: "o", summary: "s", status: "active", best_score: 0,
  week: null, due: null, has_run: true, run_at: null, retention_check_at: null, attempts: 0, fade: 0, quant: false, videos: [], misses: [],
  clips_ready: false, ...o,
});
const dl = (o: Partial<DeadlineLite> = {}): DeadlineLite => ({
  id: "d1", course: "ECON 201", course_key: "ECON201", title: "Midterm", kind: "exam", due_at: iso(2026, 9, 9), start_by: "2026-09-02",
  notebook_id: null, done: false, ...o,
});
const card = (id: string, notebook_id = "nb1", due = iso(2026, 9, 1), extra: Partial<DueCard> = {}): DueCard => ({
  id, notebook_id, chapter_id: null, front: `Q ${id}`, back: "A", hint: "", suspended: false, due, stability: 1, difficulty: 5,
  elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, state: 2, last_review: null, ...extra,
});
const mcq = (q: string, pretest = false): RunCard => ({ kind: "mcq", q, situation: "", choices: ["a", "b", "c"], answer: 0, explain: "e", pretest });
const teach = (text: string): RunCard => ({ kind: "teach", text, diagram: null });
// pretest, then teach groups of the given sizes
const run = (...groupSizes: number[]): RunCard[] => {
  const out: RunCard[] = [mcq("pre", true)];
  groupSizes.forEach((n, g) => { out.push(teach(`T${g}`)); for (let i = 0; i < n; i++) out.push(mcq(`q${g}.${i}`)); });
  return out;
};
const GOOD_RUN = run(3, 3, 2); // 12 cards, 9 questions
const home = (o: Partial<LearnHome> = {}): LearnHome => ({
  notebooks: [nb()], chapters: [ch()], due_cards: [], due_count: 0, deadlines: [], open_session: null, week_days: [],
  done_today: false, settings: {}, source_counts: { nb1: 2 }, ...o,
});
const build = (h: LearnHome, runs: Record<string, RunCard[]> = { c1: GOOD_RUN }, extra = {}) =>
  buildSession(h, runs, { now: NOW, scope: "today", ...extra });

// ─── studyDay ───────────────────────────────────────────────────────────────
test("studyDay rolls over at 4am, not midnight", () => {
  assert.equal(studyDay(new Date(2026, 8, 2, 3, 59)), "2026-09-01");
  assert.equal(studyDay(new Date(2026, 8, 2, 4, 0)), "2026-09-02");
  assert.equal(studyDay(new Date(2026, 8, 2, 23, 30)), "2026-09-02");
  assert.equal(studyDay(new Date(2026, 0, 1, 1, 0)), "2025-12-31");
});

// ─── courseKey ──────────────────────────────────────────────────────────────
test("courseKey matches the SQL normalisation", () => {
  assert.equal(courseKey("ECON 201-01"), "ECON201");
  assert.equal(courseKey("Econ 201"), "ECON201");
  assert.equal(courseKey("econ201"), "ECON201");
  assert.equal(courseKey("01:220:102:01"), "01220102");
  assert.equal(courseKey("  MATH 151 "), "MATH151");
  assert.equal(courseKey(""), "");
});

// ─── urgency ────────────────────────────────────────────────────────────────
test("urgency = kind weight × pace", () => {
  // exam, start_by already here → pace 1 → 1.0
  assert.equal(urgency(nb(), [dl()], 4, TODAY), 1);
  // quiz due in 10 days, start_by in 8 days, 5 chapters left: max(0, min(1, 5/10)) → 0.8 × 0.5
  const quiz = dl({ kind: "quiz", due_at: iso(2026, 9, 12), start_by: "2026-09-10" });
  assert.ok(Math.abs(urgency(nb(), [quiz], 5, TODAY) - 0.4) < 1e-9);
  // start_by in 3 days: 1 − 3/7 beats 0 chapters left
  const hw = dl({ kind: "assignment", due_at: iso(2026, 9, 12), start_by: "2026-09-05" });
  assert.ok(Math.abs(urgency(nb(), [hw], 0, TODAY) - 0.6 * (1 - 3 / 7)) < 1e-9);
  // unlinked (other course, no notebook_id) → 0; linked by notebook_id counts
  assert.equal(urgency(nb(), [dl({ course_key: "MATH151" })], 4, TODAY), 0);
  assert.equal(urgency(nb(), [dl({ course_key: "MATH151", notebook_id: "nb1", kind: "other" })], 4, TODAY), 0.3);
  // done deadlines never count
  assert.equal(urgency(nb(), [dl({ done: true })], 4, TODAY), 0);
});

// ─── pickNotebook ───────────────────────────────────────────────────────────
test("pickNotebook: urgency wins, ties go to the least recently studied", () => {
  const a = nb({ id: "a", title: "A", course_key: "AAA", last_studied_at: iso(2026, 9, 1) });
  const b = nb({ id: "b", title: "B", course_key: "BBB", last_studied_at: iso(2026, 8, 30) });
  const h = home({ notebooks: [a, b], chapters: [ch({ id: "ca", notebook_id: "a" }), ch({ id: "cb", notebook_id: "b" })], source_counts: { a: 1, b: 1 } });
  // b is staler → b
  assert.equal(pickNotebook(h, TODAY)?.id, "b");
  // an exam on A flips it
  assert.equal(pickNotebook({ ...h, deadlines: [dl({ course_key: "AAA" })] }, TODAY)?.id, "a");
  // exact tie: never studied beats studied
  const c = nb({ id: "c", title: "C", course_key: "CCC", last_studied_at: null });
  const d = nb({ id: "d", title: "D", course_key: "DDD", last_studied_at: null });
  const tie = home({ notebooks: [d, c], chapters: [ch({ id: "cc", notebook_id: "c" }), ch({ id: "cd", notebook_id: "d" })], source_counts: { c: 1, d: 1 } });
  assert.equal(pickNotebook(tie, TODAY)?.id, "c"); // same score → id order, deterministic
  // a notebook that can be studied outranks one that still needs chapters, even if that one is stale
  const empty = nb({ id: "e", title: "E", course_key: "EEE", last_studied_at: null });
  assert.equal(pickNotebook(home({ notebooks: [empty, a], chapters: [ch({ id: "ca", notebook_id: "a" })], source_counts: { e: 3, a: 1 } }), TODAY)?.id, "a");
});

// ─── pickChapter ────────────────────────────────────────────────────────────
test("pickChapter personal: retention checks first, then first open in idx order, resting stuck skipped", () => {
  const chapters = [
    ch({ id: "c0", idx: 0, status: "done" }),
    ch({ id: "c1", idx: 1, status: "stuck", retention_check_at: iso(2026, 9, 4) }), // resting until the 4th
    ch({ id: "c2", idx: 2, status: "passed", retention_check_at: iso(2026, 9, 5) }), // check not due yet
    ch({ id: "c3", idx: 3, status: "active" }),
  ];
  assert.equal(pickChapter(nb(), chapters, [], TODAY)?.id, "c3");
  const due = chapters.map((c) => (c.id === "c2" ? { ...c, retention_check_at: iso(2026, 9, 2, 8) } : c));
  assert.equal(pickChapter(nb(), due, [], TODAY)?.id, "c2");
  // once the rest is over, the stuck chapter is back in rotation first (idx order)
  assert.equal(pickChapter(nb(), chapters, [], "2026-09-04")?.id, "c1");
  // everything done/passed → null
  assert.equal(pickChapter(nb(), [ch({ status: "done" }), ch({ id: "x", status: "passed", retention_check_at: iso(2026, 9, 9) })], [], TODAY), null);
});

test("pickChapter class: chapter nearest the linked deadline's week, weeks ordered, nulls last", () => {
  const cls = nb({ kind: "class" });
  const chapters = [
    ch({ id: "w3", idx: 2, week: 3, due: "2026-09-15" }),
    ch({ id: "w1", idx: 0, week: 1, due: "2026-09-01" }),
    ch({ id: "w2", idx: 1, week: 2, due: "2026-09-08" }),
    ch({ id: "wn", idx: 3, week: null }),
  ];
  // exam on Sep 9 → nearest dated chapter is week 2 → the week-2 chapter
  assert.equal(pickChapter(cls, chapters, [dl()], TODAY)?.id, "w2");
  // no deadline → "current week" from today (Sep 2 → week 1)
  assert.equal(pickChapter(cls, chapters, [], TODAY)?.id, "w1");
  // week-2 done → nearest remaining to week 2 is week 1 (|1−2| = |3−2|, earlier wins)
  const w2done = chapters.map((c) => (c.id === "w2" ? { ...c, status: "done" } : c));
  assert.equal(pickChapter(cls, w2done, [dl()], TODAY)?.id, "w1");
  // retention check due beats everything
  const rc = chapters.map((c) => (c.id === "w3" ? { ...c, status: "passed", retention_check_at: iso(2026, 9, 1) } : c));
  assert.equal(pickChapter(cls, rc, [dl()], TODAY)?.id, "w3");
});

// ─── prepareRun ─────────────────────────────────────────────────────────────
test("prepareRun trims whole groups from the end and keeps the invariants", () => {
  const out = prepareRun(GOOD_RUN, 10);
  assert.equal(out.length, 9);                       // dropped the last [T q q] group
  assert.equal(out[0].pretest, true);
  assert.equal(out[out.length - 1].kind, "mcq");
  assert.deepEqual(out, GOOD_RUN.slice(0, 9));
  // can't trim below 7 questions: a 12-card run with 3-question groups… dropping any group leaves 6 → stays whole
  const tight = run(2, 2, 2, 2);                    // 13 cards, 9 q; dropping a group → 7 q ok → 10 cards
  assert.equal(prepareRun(tight, 10).length, 10);
  const tighter = run(3, 3);                        // 9 cards, 7 q — nothing can go
  assert.equal(prepareRun(tighter, 5).length, 9);
  // invariants: a teach with no question after it, or < 7 questions → []
  assert.deepEqual(prepareRun([...run(3, 3), teach("dangling")], 20), []);
  assert.deepEqual(prepareRun(run(2, 2), 20), []);
  assert.deepEqual(prepareRun([], 10), []);
  // never two teach cards in a row
  assert.deepEqual(prepareRun([mcq("p", true), teach("a"), teach("b"), ...Array.from({ length: 7 }, (_, i) => mcq(`q${i}`))], 20), []);
});

// ─── buildSession states ────────────────────────────────────────────────────
test("buildSession: every TodayState", () => {
  assert.equal(build(home({ notebooks: [] })).state, "no-notebooks");
  assert.equal(build(home({ chapters: [], source_counts: {} })).state, "no-sources");
  const needs = build(home({ chapters: [], source_counts: { nb1: 3 } }));
  assert.equal(needs.state, "needs-chapters");
  assert.deepEqual(needs.prepare, { notebookId: "nb1", chapter: null, reason: "no-chapters" });
  const prep = build(home(), {});
  assert.equal(prep.state, "preparing");
  assert.equal(prep.prepare?.reason, "no-run");
  assert.equal(prep.prepare?.chapter?.id, "c1");
  assert.equal(build(home(), {}, { aiOff: true }).state, "ai-off");
  assert.equal(build(home({ chapters: [], source_counts: { nb1: 3 } }), {}, { aiOff: true }).state, "ai-off");
  // ai-off never blocks a cached run
  assert.equal(build(home(), { c1: GOOD_RUN }, { aiOff: true }).state, "ready");
  const ready = build(home());
  assert.equal(ready.state, "ready");
  assert.equal(ready.chapterId, "c1");
  assert.equal(ready.notebookId, "nb1");
  assert.equal(ready.retrySlots, 4);
  assert.equal(ready.items.length, 9);
  assert.equal(ready.items[0].kind, "mcq");
  assert.equal((ready.items[0] as { pretest?: boolean }).pretest, true);
  assert.equal(ready.minutes, estimateMinutes(9));
  assert.equal(build(home({ done_today: true })).state, "done-today");
  // done-today still carries the items so "one more round" has something to run
  assert.equal(build(home({ done_today: true })).items.length, 9);
  // an open session resumes at pos; one past its end is ignored (treated as done)
  const openRow = { id: "s1", user_id: "u", day: TODAY, scope: "today" as const, status: "open" as const, notebook_ids: ["nb1"], chapter_id: "c1",
    plan: ready.items, results: [], pos: 3, stats: null, started_at: iso(2026, 9, 2, 9), finished_at: null };
  const resume = build(home({ open_session: openRow }));
  assert.equal(resume.state, "resume");
  assert.equal(resume.items.length, 9);
  assert.equal(resume.why, "Pick up where you left off · 6 left");
  assert.equal(build(home({ open_session: { ...openRow, pos: 9 } })).state, "ready");
  // a run that fails the invariants → preparing (caller regenerates with force)
  assert.equal(build(home(), { c1: run(2, 2) }).state, "preparing");
  // all chapters done, nothing due → done-today; reviews only → ready
  assert.equal(build(home({ chapters: [ch({ status: "done" })] })).state, "done-today");
  assert.equal(build(home({ chapters: [ch({ status: "done" })], due_cards: [card("k1")], due_count: 1 })).state, "ready");
});

test("buildSession: review block cap, round-robin, nearest the 60% sweet spot first, answered excluded", () => {
  const cards = Array.from({ length: 20 }, (_, i) => card(`k${i}`, i % 2 ? "nb2" : "nb1", iso(2026, 8, 1 + i)));
  // session_cap lifted so this test sees the review cap alone
  const h = home({ notebooks: [nb(), nb({ id: "nb2", title: "Bio", course_key: "BIO" })], due_cards: cards, due_count: 20, settings: { session_cap: 30 } });
  const plan = build(h);
  const reviews = plan.items.filter((it) => it.kind === "review");
  assert.equal(reviews.length, 8);                                  // clamp(20, 4, 8)
  const dist = (c: DueCard) => Math.abs(retrievability(c, NOW) - 0.6);
  const best = [...cards].sort((a, b) => dist(a) - dist(b))[0];
  assert.equal(reviews[0].id, `rv:${best.id}`);                      // the card most worth reviewing opens
  assert.notEqual((reviews[1] as { card: DueCard }).card.notebook_id, best.notebook_id); // then the other notebook
  assert.equal(reviews.filter((r) => r.kind === "review" && r.card.notebook_id === "nb2").length, 4);
  assert.ok(plan.items.findIndex((it) => it.kind === "review") < plan.items.findIndex((it) => it.kind !== "review"));
  // two reviews open the round; the rest are woven into the chapter block, none lost
  assert.ok(plan.items[0].kind === "review" && plan.items[1].kind === "review" && plan.items[2].kind !== "review");
  // a relearning card (just forgotten) jumps the queue
  const lapsed = card("lp", "nb1", iso(2026, 9, 1), { state: 3, lapses: 1, last_review: iso(2026, 9, 1) });
  assert.equal(build({ ...h, due_cards: [...cards, lapsed] }).items[0].id, "rv:lp");
  // few due → all of them
  assert.equal(build(home({ due_cards: cards.slice(0, 2), due_count: 2 })).items.filter((it) => it.kind === "review").length, 2);
  // answered ids drop out
  const again = build(h, { c1: GOOD_RUN }, { answeredIds: ["rv:k0", "rv:k1"] });
  assert.ok(!again.items.some((it) => it.id === "rv:k0" || it.id === "rv:k1"));
  // a missed interactive card comes back as itself
  const miss = card("m1", "nb1", iso(2026, 8, 1), { origin: "miss", meta: { item: mcq("orig") } });
  const withMiss = build(home({ due_cards: [miss], due_count: 1 }));
  const rv = withMiss.items[0];
  assert.equal(rv.kind, "review");
  assert.equal(rv.kind === "review" && rv.item?.kind, "mcq");
  assert.equal(rv.kind === "review" && rv.card_id, "m1");
});

test("buildSession: session cap trims mixed first, then reviews down to the floor", () => {
  const cards = Array.from({ length: 10 }, (_, i) => card(`k${i}`, "nb1", iso(2026, 8, 1 + i)));
  const passed = ch({ id: "c2", idx: 1, status: "passed", best_score: 85, retention_check_at: iso(2026, 9, 9) });
  const h = home({ chapters: [ch(), passed], due_cards: cards, due_count: 10, settings: { session_cap: 16 } });
  const plan = build(h, { c1: GOOD_RUN, c2: run(3, 3, 3) });
  assert.ok(plan.items.length <= 16, `got ${plan.items.length}`);
  assert.equal(plan.items.filter((it) => it.kind === "review").length, 7); // 16 − 9 chapter items; mixed all trimmed
  assert.equal(plan.items.filter((it) => it.kind !== "review" && (it as { mixed?: boolean }).mixed).length, 0);
  // the default cap is 12: 9 chapter items leave 3, the floor lifts it to 4
  const dflt = build({ ...h, settings: {} }, { c1: GOOD_RUN, c2: run(3, 3, 3) });
  assert.equal(dflt.items.length, 13);
  assert.equal(dflt.items.filter((it) => it.kind === "review").length, 4);
  // a bigger cap lets the mixed questions in, spaced out, after the first teach card
  const roomy = build({ ...h, settings: { session_cap: 30 } }, { c1: GOOD_RUN, c2: run(3, 3, 3) });
  const block = roomy.items.filter((it) => it.kind !== "review") as { mixed?: boolean; kind: string; chapter_id: string }[];
  const mixedAt = block.map((b, i) => (b.mixed ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(mixedAt, [4, 8]);                                // positions 4/8 fit in a 9-card block; 12 doesn't
  assert.ok(mixedAt.every((i) => i > block.findIndex((b) => b.kind === "teach")));
  assert.ok(block.filter((b) => b.mixed).every((b) => b.chapter_id === "c2"));
  // review floor: with 12 chapter items the cap of 16 leaves 4 reviews, not 0
  const big = build({ ...h, settings: { session_cap: 12 } }, { c1: GOOD_RUN });
  assert.equal(big.items.filter((it) => it.kind === "review").length, 4);
});

test("buildSession: retention check → 3 questions not in misses, tagged", () => {
  const rc = ch({ status: "passed", retention_check_at: iso(2026, 9, 1), misses: ["q0.0", "q0.1"] });
  const plan = build(home({ chapters: [rc] }));
  assert.equal(plan.state, "ready");
  const block = plan.items.filter((it) => it.kind !== "review") as ({ retention?: boolean; kind: string } & { q?: string })[];
  assert.equal(block.length, 3);
  assert.ok(block.every((b) => b.retention && b.kind !== "teach"));
  assert.ok(block.every((b) => b.q !== "q0.0" && b.q !== "q0.1" && b.q !== "pre"));
  assert.match(plan.why, /still hold/);
  // deterministic for the same day
  assert.deepEqual(build(home({ chapters: [rc] })).items.map((i) => i.id), plan.items.map((i) => i.id));
  // no cached run → preparing
  assert.equal(build(home({ chapters: [rc] }), {}).state, "preparing");
});

test("buildSession: chapter scope ignores reviews and the open session", () => {
  const cards = [card("k1")];
  const plan = buildSession(home({ due_cards: cards, due_count: 1, done_today: true }), { c1: GOOD_RUN }, { now: NOW, scope: "chapter", chapterId: "c1" });
  assert.equal(plan.state, "ready");
  assert.ok(!plan.items.some((it) => it.kind === "review"));
  assert.equal(plan.items.length, 9);
  // pace line data rides along
  const withDl = build(home({ deadlines: [dl()] }));
  assert.equal(withDl.nextDeadline?.id, "d1");
  assert.match(withDl.why, /ECON 201 exam/);
});

// ─── scoreSession ───────────────────────────────────────────────────────────
test("scoreSession: first attempts only; pretest/mixed/retention never count against pct", () => {
  const passed = ch({ id: "c2", idx: 1, status: "passed", best_score: 50, retention_check_at: iso(2026, 9, 9) });
  const plan = build({ ...home({ chapters: [ch(), passed], due_cards: [card("k1")], due_count: 1 }), settings: { session_cap: 30 } }, { c1: GOOD_RUN, c2: run(3, 3, 3) });
  const ids = plan.items.map((it) => it.id);
  const chapterQs = plan.items.filter((it) => it.kind === "mcq" && !(it as { pretest?: boolean }).pretest && !(it as { mixed?: boolean }).mixed);
  assert.equal(chapterQs.length, 6);                                     // 9-card block: pretest + 2 teach + 6 questions
  const r = (id: string, ok: boolean, extra: Partial<SessionResult> = {}): SessionResult => ({ id, ok, attempt: 1, ms: 6000, ...extra });
  const results: SessionResult[] = [
    r("rv:k1", true),
    r(ids.find((i) => i.startsWith("ch:c1:0")) as string, false),         // pretest wrong: free
    ...chapterQs.map((q, i) => r(q.id, i !== 0, i === 0 ? { ms: 1500 } : {})),  // 5 of 6, one fast miss
    ...plan.items.filter((it) => (it as { mixed?: boolean }).mixed).map((it) => r(it.id, false)),
    r(chapterQs[0].id, true, { attempt: 2 }),                              // re-ask never counts
  ];
  const s = scoreSession(plan, results);
  assert.equal(s.asked, 7);                     // 6 chapter + 1 review
  assert.equal(s.right, 6);
  assert.equal(s.pct, 86);
  assert.equal(s.chapterAsked, 6);
  assert.equal(s.chapterPct, 83);
  assert.equal(s.sureButWrong, 1);
  // misses: the chapter miss + the two mixed misses (pretest excluded)
  assert.equal(s.misses.length, 3);
  assert.ok(!s.misses.some((m) => (m as { pretest?: boolean }).pretest));
  assert.deepEqual(s.retention, { asked: 0, right: 0 });
  // a duplicate first attempt (answered again after a resume) and a skipped review don't count
  const dup = scoreSession(plan, [...results, r(chapterQs[1].id, false), r("rv:k1", false, { skipped: true })]);
  assert.equal(dup.asked, s.asked);
  assert.equal(dup.right, s.right);
  // empty
  assert.deepEqual(scoreSession(plan, []).pct, 0);
});

test("scoreSession: retention items tallied separately", () => {
  const rc = ch({ status: "passed", retention_check_at: iso(2026, 9, 1) });
  const plan = build(home({ chapters: [rc] }));
  const results = plan.items.map((it, i) => ({ id: it.id, ok: i !== 1, attempt: 1 as const, ms: 5000 }));
  const s = scoreSession(plan, results);
  assert.deepEqual(s.retention, { asked: 3, right: 2 });
  assert.equal(s.chapterAsked, 0);
  assert.equal(s.misses.length, 1);
});

test("estimateMinutes", () => {
  assert.equal(estimateMinutes(0), 0);
  assert.equal(estimateMinutes(9), 4);
  assert.equal(estimateMinutes(16), 7);
});

// ─── why line: never a day count ────────────────────────────────────────────
test("why never counts days — not for a lapse, not for a far deadline", () => {
  const whys = [
    build(home({ notebooks: [nb({ last_studied_at: iso(2026, 8, 20) })] })).why,          // opened 13 days ago
    build(home({ notebooks: [nb({ last_studied_at: iso(2026, 9, 1) })] })).why,           // yesterday
    build(home({ notebooks: [nb({ last_studied_at: null })] })).why,
    build(home({ deadlines: [dl({ due_at: iso(2026, 9, 25) })] })).why,                   // exam 23 days out
    build(home({ deadlines: [dl({ due_at: iso(2026, 9, 4) })] })).why,                    // this week → weekday
    build(home({ deadlines: [dl({ due_at: iso(2026, 9, 3) })] })).why,                    // tomorrow
  ];
  for (const w of whys) assert.doesNotMatch(w, /\d+ days/, w);
  assert.equal(whys[0], "Econ — picking it back up");
  assert.equal(whys[1], "Econ — next in order");
  assert.equal(whys[2], "Econ — first round");
  assert.match(whys[3], /^ECON 201 exam Sep 25 · /);
  assert.match(whys[4], /^ECON 201 exam Fri · /);
  assert.match(whys[5], /^ECON 201 exam tomorrow · /);
});

// ─── clips ──────────────────────────────────────────────────────────────────
test("a teach card with a verified clip is a valid card and survives prepareRun", () => {
  const clipped: TeachCard = {
    kind: "teach", text: "Marginal cost (the extra cost of one more unit)…", diagram: null,
    clip: { id: "dQw4w9WgXcQ", title: "Marginal cost explained", channel: "Khan Academy", start: 130, end: 205 },
  };
  const cards: RunCard[] = [mcq("pre", true), clipped, ...Array.from({ length: 7 }, (_, i) => mcq(`q${i}`))];
  const out = prepareRun(cards, 20);
  assert.equal(out.length, 9);
  const t = out[1];
  assert.ok(t.kind === "teach" && t.clip?.id === "dQw4w9WgXcQ" && t.clip.end - t.clip.start === 75);
  // a card without a clip is still fine — the field is optional
  assert.equal(prepareRun([mcq("pre", true), teach("plain"), ...Array.from({ length: 7 }, (_, i) => mcq(`q${i}`))], 20).length, 9);
});

// ─── open rows: resume vs settle ────────────────────────────────────────────
const row = (o: Partial<StudySessionRow> = {}): StudySessionRow => ({
  id: "s1", user_id: "u", day: TODAY, scope: "today", status: "open", notebook_ids: ["nb1"], chapter_id: "c1",
  plan: build(home()).items, results: [], pos: 3, stats: null, started_at: iso(2026, 9, 2, 9), finished_at: null, ...o,
});

test("needsSettling: main block complete, or too old to resume", () => {
  assert.equal(needsSettling(row(), TODAY), false);
  assert.equal(needsSettling(row({ pos: 9 }), TODAY), true);                  // quit in the retry slots (pos runs over the full queue)
  assert.equal(needsSettling(row({ pos: 11 }), TODAY), true);
  assert.equal(needsSettling(row({ day: "2026-08-30" }), TODAY), false);      // 3 days: still resumable
  assert.equal(needsSettling(row({ day: "2026-08-29" }), TODAY), true);       // 4 days: settle it
  assert.equal(needsSettling(row({ plan: [] as StudySessionRow["plan"], pos: 0 }), TODAY), true);
});

test("buildSession resumes a fresh open row, never one that needs settling", () => {
  assert.equal(build(home({ open_session: row() })).state, "resume");
  assert.equal(build(home({ open_session: row({ day: "2026-08-31" }) })).state, "resume");
  assert.equal(build(home({ open_session: row({ pos: 9 }) })).state, "ready");
  assert.equal(build(home({ open_session: row({ day: "2026-08-20" }) })).state, "ready");
});

test("planFromRow rebuilds the plan a settled row is scored against", () => {
  const r = row({ pos: 10, results: [{ id: "x", ok: true, attempt: 1, ms: 5000 }] });
  const p = planFromRow(r);
  assert.equal(p.items.length, 9);
  assert.equal(p.chapterId, "c1");
  assert.equal(p.notebookId, "nb1");
  assert.deepEqual(p.notebookIds, ["nb1"]);
  assert.equal(p.scope, "today");
  assert.equal(p.retrySlots, RETRY_SLOTS);
  assert.equal(p.minutes, estimateMinutes(9));
  // scored exactly like the live round: first attempts, pretest free
  const ids = p.items.map((it) => it.id);
  const qs = p.items.filter((it) => it.kind === "mcq" && !(it as { pretest?: boolean }).pretest);
  const results: SessionResult[] = [
    { id: ids[0], ok: false, attempt: 1, ms: 3000 },
    ...qs.map((q, i) => ({ id: q.id, ok: i > 0, attempt: 1 as const, ms: 6000 })),
    { id: qs[0].id, ok: true, attempt: 2, ms: 4000 },
  ];
  const s = scoreSession(p, results);
  assert.equal(s.chapterAsked, qs.length);
  assert.equal(s.chapterRight, qs.length - 1);
  assert.equal(s.misses.length, 1);
  // a row with a broken plan scores to nothing instead of throwing
  const empty = planFromRow(row({ plan: null as unknown as StudySessionRow["plan"], notebook_ids: null as unknown as string[] }));
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.notebookIds, []);
  assert.equal(empty.notebookId, null);
  assert.equal(scoreSession(empty, [{ id: "x", ok: true, attempt: 1, ms: 1 }]).asked, 0);
});

// ─── v50: opener, weaving, cold start, sticky notebook ──────────────────────
test("the pretest is always followed by its teach card within 1 item, whatever is woven in", () => {
  const cards = Array.from({ length: 12 }, (_, i) => card(`k${i}`, i % 2 ? "nb2" : "nb1", iso(2026, 8, 1 + i)));
  const passed = ch({ id: "c2", idx: 1, status: "passed", best_score: 50, retention_check_at: iso(2026, 9, 9) });
  for (const due of [0, 1, 2, 3, 5, 8, 12]) {
    const h = home({
      notebooks: [nb(), nb({ id: "nb2", title: "Bio", course_key: "BIO" })], chapters: [ch(), passed],
      due_cards: cards.slice(0, due), due_count: due, settings: { session_cap: 30 },
    });
    const plan = build(h, { c1: GOOD_RUN, c2: run(3, 3, 3) });
    const pre = plan.items.findIndex((it) => (it as { pretest?: boolean }).pretest);
    assert.ok(pre >= 0, `due=${due}: no pretest`);
    assert.equal(plan.items[pre + 1].kind, "teach", `due=${due}: pretest not glued to its teach card`);
    // no review is ever sandwiched between a teach card and its first question
    plan.items.forEach((it, i) => { if (it.kind === "teach") assert.notEqual(plan.items[i + 1]?.kind, "review", `due=${due}: review right after a teach card`); });
    // at most two reviews open the round; every due card that made the cut is still in the plan
    const firstBlock = plan.items.findIndex((it) => it.kind !== "review");
    assert.ok(firstBlock <= 2, `due=${due}: ${firstBlock} reviews before the block`);
    assert.equal(plan.items.filter((it) => it.kind === "review").length, Math.min(due, 8));
  }
});

test("a chapter question that is also a due review card is asked once, as the review", () => {
  const dup = card("d1", "nb1", iso(2026, 9, 1), { front: "q0.1" });
  const plan = build(home({ due_cards: [dup], due_count: 1 }));
  const qs = plan.items.filter((it) => it.kind === "mcq").map((it) => (it as { q: string }).q);
  assert.ok(!qs.includes("q0.1"));
  assert.ok(plan.items.some((it) => it.id === "rv:d1"));
  // the teach card before it still has its other questions
  assert.equal(plan.items.filter((it) => it.kind === "teach").length, 2);
});

test("isColdNotebook: never-studied notebook on a never-attempted chapter only", () => {
  assert.equal(isColdNotebook(nb({ last_studied_at: null }), ch({ attempts: 0 })), true);
  assert.equal(isColdNotebook(nb({ last_studied_at: null }), ch({ attempts: 1 })), false);
  assert.equal(isColdNotebook(nb({ last_studied_at: iso(2026, 9, 1) }), ch({ attempts: 0 })), false);
});

test("pickNotebook sticks with a chapter mid-story unless a deadline presses", () => {
  const a = nb({ id: "a", title: "A", course_key: "AAA", last_studied_at: iso(2026, 9, 1) });   // studied yesterday, chapter failed once
  const b = nb({ id: "b", title: "B", course_key: "BBB", last_studied_at: iso(2026, 8, 25) });  // stale
  const h = home({
    notebooks: [a, b], source_counts: { a: 1, b: 1 },
    chapters: [ch({ id: "ca", notebook_id: "a", attempts: 1 }), ch({ id: "cb", notebook_id: "b" })],
  });
  assert.equal(pickNotebook(h, TODAY)?.id, "a");
  // a passed chapter waiting on its check sticks too
  const waiting = { ...h, chapters: [ch({ id: "ca", notebook_id: "a", status: "passed", retention_check_at: iso(2026, 9, 5) }), ch({ id: "ca2", notebook_id: "a", idx: 1 }), ch({ id: "cb", notebook_id: "b" })] };
  assert.equal(pickNotebook(waiting, TODAY)?.id, "a");
  // nothing mid-story → staleness wins as before
  assert.equal(pickNotebook({ ...h, chapters: [ch({ id: "ca", notebook_id: "a" }), ch({ id: "cb", notebook_id: "b" })] }, TODAY)?.id, "b");
  // an exam on B inside its lead window beats the sticky bonus
  assert.equal(pickNotebook({ ...h, deadlines: [dl({ course_key: "BBB" })] }, TODAY)?.id, "b");
});

test("reviewOrder: relearning first, then nearest 60% recall, then due, then id", () => {
  const fresh = card("f", "nb1", iso(2026, 9, 1), { state: 2, stability: 30, last_review: iso(2026, 9, 1) });   // ≈ 1.0 recall
  const sweet = card("s", "nb1", iso(2026, 9, 1), { state: 2, stability: 4, last_review: iso(2026, 8, 26) });    // near the sweet spot
  const lapsed = card("l", "nb1", iso(2026, 9, 2), { state: 3, lapses: 1, last_review: iso(2026, 9, 2, 9) });
  const order = reviewOrder([fresh, sweet, lapsed], NOW).map((c) => c.id);
  assert.deepEqual(order, ["l", "s", "f"]);
  assert.ok(Math.abs(retrievability(sweet, NOW) - 0.6) < Math.abs(retrievability(fresh, NOW) - 0.6));
});

// ─── quick feed ─────────────────────────────────────────────────────────────
const clipTeach = (text: string, len: number, off = false): RunCard =>
  ({ kind: "teach", text, diagram: null, clip: { id: "dQw4w9WgXcQ", title: "t", channel: "c", start: 10, end: 10 + len }, ...(off ? { clip_off: true } : {}) });
const FEED_RUN: RunCard[] = [
  mcq("pre", true), clipTeach("short", 60), mcq("q0"), mcq("q0b"), clipTeach("long", 120), mcq("q1"), teach("plain"), mcq("q2"),
  clipTeach("off", 40, true), mcq("q3"), clipTeach("dangling", 30),
];

test("buildQuickFeed: due cards, then short clips paired with their question, tagged mixed, capped, no stuck chapters", () => {
  const cards = [card("k1"), card("k2", "nb2")];
  const h = home({
    notebooks: [nb(), nb({ id: "nb2", title: "Bio", course_key: "BIO" })], due_cards: cards, due_count: 2,
    chapters: [ch(), ch({ id: "c2", notebook_id: "nb2", status: "passed" }), ch({ id: "c3", notebook_id: "nb1", idx: 1, status: "stuck" })],
  });
  const feed = buildQuickFeed(h, { c1: FEED_RUN, c2: FEED_RUN, c3: FEED_RUN }, { now: NOW });
  assert.equal(feed.scope, "quick");
  assert.equal(feed.chapterId, null);
  assert.equal(feed.retrySlots, 0);
  assert.equal(feed.items.filter((it) => it.kind === "review").length, 2);
  const pairs = feed.items.filter((it) => it.kind !== "review") as ({ mixed?: boolean; feedClip?: { clip: { end: number; start: number }; k: number }; chapter_id: string; q?: string })[];
  // one pair per short (≤75 s), not-switched-off clip that has a question after it: "short" only, from c1 and c2
  assert.equal(pairs.length, 2);
  assert.ok(pairs.every((p) => p.mixed && p.feedClip && p.feedClip.clip.end - p.feedClip.clip.start <= 75 && p.q === "q0" && p.feedClip.k === 1));
  assert.deepEqual(pairs.map((p) => p.chapter_id).sort(), ["c1", "c2"]);
  assert.ok(!pairs.some((p) => p.chapter_id === "c3"));
  // reviews come first; the cap and the answered filter hold; same order all day
  assert.ok(feed.items[0].kind === "review");
  assert.equal(buildQuickFeed(h, { c1: FEED_RUN, c2: FEED_RUN }, { now: NOW, max: 3 }).items.length, 3);
  const again = buildQuickFeed(h, { c1: FEED_RUN, c2: FEED_RUN }, { now: NOW, answeredIds: ["rv:k1", pairs[0].chapter_id === "c1" ? "qf:c1:2" : "qf:c2:2"] });
  assert.equal(again.items.length, 2);
  assert.deepEqual(buildQuickFeed(h, { c1: FEED_RUN, c2: FEED_RUN }, { now: NOW }).items.map((i) => i.id), feed.items.map((i) => i.id));
  // nothing → done-today, never a crash
  assert.equal(buildQuickFeed(home({ chapters: [] }), {}, { now: NOW }).state, "done-today");
});

test("a quick-feed row left open is never resumed as today's round", () => {
  const quick = row({ scope: "quick", pos: 1, results: [{ id: "x", ok: true, attempt: 1, ms: 1 }] });
  assert.equal(build(home({ open_session: quick })).state, "ready");
});

// ─── the opener ─────────────────────────────────────────────────────────────
test("planOpener: the first choice question, else a flashcard front with no choices", () => {
  const plan = build(home());
  const first = planOpener(plan, "Econ");
  assert.ok(first && first.kind === "mcq" && first.stem === "pre" && first.choices?.length === 3 && first.answer === 0 && first.notebook === "Econ");
  assert.equal(first?.id, plan.items[0].id);
  // reviews open the round: a plain flashcard first → the first mcq in the block is the opener
  const withRv = build(home({ due_cards: [card("k1")], due_count: 1 }));
  assert.equal(planOpener(withRv, "Econ")?.kind, "mcq");
  // an interactive miss card up front is a choice question in its own right
  const miss = card("m1", "nb1", iso(2026, 8, 1), { origin: "miss", meta: { item: mcq("orig"), notebook_title: "Bio" } });
  const o = planOpener(build(home({ due_cards: [miss], due_count: 1 })), "Econ");
  assert.ok(o && o.id === "rv:m1" && o.stem === "orig" && o.notebook === "Bio");
  // flashcards only → the front, no choices
  const fc = planOpener(build(home({ chapters: [ch({ status: "done" })], due_cards: [card("k1")], due_count: 1 })), "Econ");
  assert.ok(fc && fc.kind === "review" && fc.stem === "Q k1" && fc.choices === undefined);
  assert.equal(planOpener({ ...plan, items: [] }, "Econ"), null);
});

// ─── copy: nothing that reads as a verdict or a nag ─────────────────────────
test("Learn copy never says almost / so close / failed / behind / missed a day", () => {
  const banned = /(^|[\s"'`(—·])(almost|so close|failed|behind|missed a day)\b/i;
  const files = ["session.ts", "learnApi.ts", "../components/Session.tsx", "../components/SessionCards.tsx"];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    // every single-line string or template literal with at least three words = copy; ${…} expressions are not words
    const literals = [...src.matchAll(/"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n]|\\.)*)`/g)].map((m) => (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, " "));
    for (const lit of literals) {
      if (lit.trim().split(/\s+/).length < 3) continue;
      assert.doesNotMatch(lit, banned, `${f}: ${lit}`);
    }
  }
  // the why line, for the states the planner writes itself
  for (const w of [build(home()).why, build(home({ notebooks: [nb({ last_studied_at: iso(2026, 8, 20) })] })).why]) assert.doesNotMatch(w, banned);
});
