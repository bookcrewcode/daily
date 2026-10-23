// Unit tests for the Telegram alerts planner.
// Run: npx --yes tsx --test supabase/functions/alerts/plan.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planAlerts, localClock, localDay, quietAt, readSettings, shortCourse, addSteps, pickTop3,
  DEFAULT_SETTINGS,
  type Alert, type AlertKind, type Block, type Deadline, type Input, type LogRow, type LogState, type Settings,
} from "./plan.ts";

// ─── fixtures: Ben's real Friday, Oct 16 2026 (EDT, UTC-4) ─────────────────
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const B = (n: number, kind: string, label: string, start_t: string, end_t: string): Block =>
  ({ id: U(n), kind, label, location: "", start_t, end_t });
const FRI: Block[] = [
  B(1, "class", "Intro to Econ-Macro", "08:30", "09:50"),
  B(2, "gym", "Gym 1.5h", "10:15", "11:45"),
  B(3, "read", "Read 40 min", "12:00", "12:40"),
  B(4, "drill", "Reading drill 15 min", "12:40", "12:55"),
  B(5, "drive", "Drive", "13:00", "22:00"),
];
const edt = (y: number, mo: number, d: number, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h + 4, m));
};
const fri = (hhmm: string) => edt(2026, 10, 16, hhmm);
const SET: Settings = { ...DEFAULT_SETTINGS, chat_id: 42 };
const row = (key: string, kind: AlertKind, state: LogState, extra: Partial<LogRow> = {}): LogRow =>
  ({ key, kind, state, snooze_until: null, tries: 0, updated_at: "2026-10-16T04:00:00Z", meta: null, ...extra });
const PLANNED = [row("plan:2026-10-16", "plan", "sent")];
const input = (now: Date, over: Partial<Input> = {}): Input =>
  ({ now, settings: SET, blocks: FRI, items: [], top3: [], deadlines: [], log: PLANNED, ...over });
const DL = (n: number, title: string, due_at: string, start_by: string | null, kind = "assignment", course = "21:640:114:07 PRECALCULUS"): Deadline =>
  ({ id: U(100 + n), title, course, kind, due_at, start_by, goal_id: null });
const TEST1 = DL(1, "In-Class Test #1 (midterm exam, 20%)", "2026-10-23T03:59:00Z", "2026-10-15", "exam", "Fall 2026 (21:512:368:01)");
const HW5 = DL(2, "HW 5 Set 5", "2026-10-26T03:59:00Z", "2026-10-22");
const kinds = (as: Alert[]) => as.map((a) => `${a.kind}:${a.action}`);
const blockKey = (n: number, day = "2026-10-16") => `block:${U(n)}:${day}`;

test("localClock reads New York wall time, across the DST change", () => {
  assert.deepEqual(localClock(fri("07:45"), "America/New_York"), { day: "2026-10-16", min: 465, weekday: 5 });
  // Sun Nov 1 2026, clocks fall back at 2am: 14:00Z is 09:00 EST
  assert.deepEqual(localClock(new Date("2026-11-01T14:00:00Z"), "America/New_York"), { day: "2026-11-01", min: 540, weekday: 0 });
});

test("a Canvas 23:59 deadline stored as 03:59Z belongs to the earlier local day", () => {
  assert.equal(localDay("2026-10-26T03:59:00Z", "America/New_York"), "2026-10-25");
});

test("quietAt: night wraps midnight; class and gym are quiet; a block is never quiet for its own ping", () => {
  assert.equal(quietAt(23 * 60, SET, FRI), "night");
  assert.equal(quietAt(7 * 60 + 29, SET, FRI), "night");
  assert.equal(quietAt(7 * 60 + 30, SET, FRI), null);
  assert.equal(quietAt(9 * 60, SET, FRI), "class");
  assert.equal(quietAt(10 * 60 + 30, SET, FRI), "gym");
  assert.equal(quietAt(10 * 60 + 30, SET, FRI, U(2)), null);
});

test("nothing at all when the chat isn't linked or alerts are paused", () => {
  assert.deepEqual(planAlerts(input(fri("10:15"), { settings: DEFAULT_SETTINGS })), []);
  assert.deepEqual(planAlerts(input(fri("10:15"), { settings: { ...SET, paused_until: fri("12:00").toISOString() } })), []);
});

test("morning plan at 7:45: started deadlines first, then the day's blocks; a countdown to the exam", () => {
  const as = planAlerts(input(fri("07:45"), { deadlines: [TEST1, HW5], log: [] }));
  const plan = as.find((a) => a.kind === "plan")!;
  assert.equal(plan.key, "plan:2026-10-16");
  assert.equal(plan.action, "send");
  assert.deepEqual(plan.top3, ["In-Class Test #1 (midterm exam, 20%), due Thu Oct 22", "Gym 1.5h at 10:15", "Read 40 min at 12:00"]);
  assert.match(plan.text, /Coming up\n- In-Class Test #1 \(midterm exam, 20%\): in 6 days/);
  assert.ok(!plan.text.includes("Macro"), "classes are not plan items");
});

test("the plan uses Ben's own top 3 when he set one, sends once, and waits out the night", () => {
  const own = planAlerts(input(fri("07:45"), { top3: ["Finish HW 5", "", "Call mom"], log: [] })).find((a) => a.kind === "plan")!;
  assert.deepEqual(own.top3, ["Finish HW 5", "Call mom"]);
  assert.equal(planAlerts(input(fri("08:00"))).filter((a) => a.kind === "plan").length, 0);
  const early = { ...SET, morning_at: "07:00" };
  assert.equal(planAlerts(input(fri("07:10"), { settings: early, log: [] })).filter((a) => a.kind === "plan").length, 0);
  assert.equal(planAlerts(input(fri("07:30"), { settings: early, log: [] })).filter((a) => a.kind === "plan").length, 1);
});

test("a block pings at its start, the gym included; classes never ping", () => {
  const as = planAlerts(input(fri("10:15")));
  assert.deepEqual(kinds(as), ["block:send"]);
  assert.equal(as[0].key, blockKey(2));
  assert.equal(as[0].text, "Gym 1.5h\nNow · 10:15–11:45");
  assert.equal(planAlerts(input(fri("08:30"))).filter((a) => a.kind === "block").length, 0);
});

test("a block already ticked in the app gets no ping, no nudge, and stays out of the top 3", () => {
  const items = [{ id: "i1", time: "10:15", what: "Gym 1.5h", done: true, block_id: U(2) }];
  assert.deepEqual(planAlerts(input(fri("10:15"), { items })), []);
  assert.deepEqual(planAlerts(input(fri("10:30"), { items, log: [...PLANNED, row(blockKey(2), "block", "sent")] })), []);
  const top = pickTop3(input(fri("07:45"), { items }), localClock(fri("07:45"), SET.tz));
  assert.ok(!top.some((t) => t.startsWith("Gym")));
});

test("a ping that starts inside another block's quiet window is held", () => {
  const blocks = [B(1, "class", "Precalculus", "10:00", "10:55"), B(9, "study", "Flashcards", "10:30", "11:00")];
  assert.deepEqual(kinds(planAlerts(input(fri("10:30"), { blocks }))), ["block:hold"]);
});

test("a start more than an hour old never pings", () => {
  assert.deepEqual(planAlerts(input(fri("11:20"))), []);
});

test("one nudge 15 minutes in when nothing was tapped — never twice, never after a tap or the block's end", () => {
  const sent = [...PLANNED, row(blockKey(2), "block", "sent")];
  const n = planAlerts(input(fri("10:30"), { log: sent }));
  assert.deepEqual(kinds(n), ["nudge:send"]);
  assert.equal(n[0].text, "Gym 1.5h\nStarted 15 min ago. Still on?");
  assert.ok(n[0].buttons[0].every((b) => b.data?.endsWith(blockKey(2))), "nudge buttons act on the block's row");
  assert.deepEqual(planAlerts(input(fri("10:35"), { log: [...sent, row(`nudge:${U(2)}:2026-10-16`, "nudge", "sent")] })), []);
  assert.deepEqual(planAlerts(input(fri("10:30"), { log: [...PLANNED, row(blockKey(2), "block", "started")] })), []);
  assert.deepEqual(planAlerts(input(fri("10:29"), { log: sent })), []);
  assert.deepEqual(planAlerts(input(fri("11:50"), { log: sent })), []);
});

test("snooze: the same key pings again once the snooze runs out", () => {
  const z = [...PLANNED, row(blockKey(2), "block", "snoozed", { snooze_until: fri("10:30").toISOString() })];
  assert.deepEqual(planAlerts(input(fri("10:25"), { log: z })), []);
  const again = planAlerts(input(fri("10:30"), { log: z }));
  assert.deepEqual(kinds(again), ["block:send"]);
  assert.equal(again[0].key, blockKey(2));
});

test("6pm the evening before: uses the local due day, rings silently on a drive, holds at the gym", () => {
  const sat = [B(6, "drive", "Drive", "10:30", "20:30")];
  const eve = planAlerts(input(edt(2026, 10, 24, "18:00"), { blocks: sat, deadlines: [HW5], log: [row("plan:2026-10-24", "plan", "sent")] }));
  assert.deepEqual(kinds(eve), ["due_eve:send"]);
  assert.equal(eve[0].text, "Due tomorrow: HW 5 Set 5 (Precalculus)");
  assert.equal(eve[0].silent, true);
  assert.deepEqual(planAlerts(input(edt(2026, 10, 25, "18:00"), { blocks: [], deadlines: [HW5], log: [row("plan:2026-10-25", "plan", "sent")] })), []);
  const mon = [B(7, "gym", "Gym 1.5h", "18:00", "19:30")];
  const quiz = DL(3, "Quiz 4", "2026-10-21T03:59:00Z", "2026-10-19", "quiz");
  const gym = planAlerts(input(edt(2026, 10, 19, "18:00"), { blocks: mon, deadlines: [quiz], log: [row("plan:2026-10-19", "plan", "sent")] }));
  assert.deepEqual(kinds(gym).sort(), ["block:send", "due_eve:hold"]);
});

test("over the cap: pings wait for a bundle and nudges are dropped", () => {
  const busy = Array.from({ length: 10 }, (_, i) => row(`block:x${i}:2026-10-16`, "block", "sent"));
  assert.deepEqual(kinds(planAlerts(input(fri("10:15"), { log: [...PLANNED, ...busy] }))), ["block:hold"]);
  assert.deepEqual(planAlerts(input(fri("10:30"), { log: [...PLANNED, ...busy.slice(0, 9), row(blockKey(2), "block", "sent")] })), []);
});

test("held items arrive as one bundle once nothing is quiet — after the plan, at most hourly", () => {
  const heldRead = row(blockKey(3), "block", "held", { meta: { text: "Read 40 min\nNow · 12:00–12:40" } });
  const b = planAlerts(input(fri("12:10"), { log: [...PLANNED, heldRead] }));
  assert.deepEqual(kinds(b), ["bundle:send"]);
  assert.equal(b[0].text, "While you were busy\n- Read 40 min");
  assert.deepEqual(b[0].absorbs, [blockKey(3)]);
  assert.deepEqual(planAlerts(input(fri("09:00"), { log: [...PLANNED, heldRead] })).filter((a) => a.kind === "bundle"), []);
  const recent = row("bundle:2026-10-16:700", "bundle", "sent", { updated_at: fri("11:40").toISOString() });
  assert.deepEqual(planAlerts(input(fri("12:10"), { log: [...PLANNED, heldRead, recent] })).filter((a) => a.kind === "bundle"), []);
});

test("the morning plan absorbs what was held overnight", () => {
  const held = row("due_eve:abc", "due_eve", "held", { meta: { text: "Due tomorrow: Quiz 4" } });
  const p = planAlerts(input(fri("07:45"), { log: [held] })).find((a) => a.kind === "plan")!;
  assert.deepEqual(p.absorbs, ["due_eve:abc"]);
  assert.match(p.text, /Held for you\n- Due tomorrow: Quiz 4/);
});

test("long held lists are trimmed so a message stays far under Telegram's 4096-char limit", () => {
  const many = Array.from({ length: 20 }, (_, i) => row(`due_eve:${i}`, "due_eve", "held", { meta: { text: `Item ${i}` } }));
  const b = planAlerts(input(fri("12:10"), { log: [...PLANNED, ...many] })).find((a) => a.kind === "bundle")!;
  assert.equal(b.absorbs.length, 20);
  assert.match(b.text, /…and 8 more$/);
});

test("button data fits Telegram's 64-byte callback limit", () => {
  const as = [...planAlerts(input(fri("10:15"))), ...planAlerts(input(fri("10:30"), { log: [...PLANNED, row(blockKey(2), "block", "sent")] }))];
  assert.ok(as.length >= 2);
  for (const a of as) for (const r of a.buttons) for (const b of r) {
    if (b.data) assert.ok(new TextEncoder().encode(b.data).length <= 64, b.data);
  }
});

test("DST end day: a 9:00 block pings at 9:00 EST, not an hour off", () => {
  const sun = [B(8, "read", "Read 40 min", "09:00", "09:40")];
  const log = [row("plan:2026-11-01", "plan", "sent")];
  assert.deepEqual(kinds(planAlerts(input(new Date("2026-11-01T14:00:00Z"), { blocks: sun, log }))), ["block:send"]);
  assert.deepEqual(planAlerts(input(new Date("2026-11-01T13:00:00Z"), { blocks: sun, log })), []);
});

test("addSteps puts a first step under each top-3 line and skips missing ones", () => {
  assert.equal(addSteps("Today\n\nTop 3\n1. A\n2. B", ["A", "B"], ["Open it", ""]), "Today\n\nTop 3\n1. A\n   First step: Open it\n2. B");
});

test("readSettings fills gaps with the defaults", () => {
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  const s = readSettings({ chat_id: 7, quiet: { gym: false } });
  assert.equal(s.chat_id, 7);
  assert.equal(s.quiet.gym, false);
  assert.equal(s.quiet.class, true);
});

test("shortCourse turns Canvas codes into a plain name, or nothing", () => {
  assert.equal(shortCourse("21:640:114:07 PRECALCULUS"), "Precalculus");
  assert.equal(shortCourse("21:220:102:03 INTRO TO ECON-MACRO"), "Econ-Macro");
  assert.equal(shortCourse("Fall 2026 (21:512:368:01)"), "");
});
