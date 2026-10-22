import { test } from "node:test";
import assert from "node:assert/strict";
import { tickPlan } from "./tick";

const at = (iso: string) => Date.parse(iso);
const go = { paused: false, budgetLeft: true, reportDue: true };

test("08:32 on a trading day: the feed's quarter and the report; lots wait for 09:36", () => {
  assert.deepEqual(tickPlan(at("2026-10-15T12:32:00Z"), go), { feed: true, lots: false, report: true });
});

test("before 08:30 no report; off the quarter no feed", () => {
  assert.deepEqual(tickPlan(at("2026-10-15T12:29:00Z"), go), { feed: false, lots: false, report: false });
});

test("Saturday: the feed only", () => {
  assert.deepEqual(tickPlan(at("2026-10-17T12:32:00Z"), go), { feed: true, lots: false, report: false });
});

test("paused: weekly lots still recorded, no AI", () => {
  assert.deepEqual(tickPlan(at("2026-10-15T13:47:00Z"), { ...go, paused: true }), { feed: false, lots: true, report: false });
});

test("budget used up: no feed, no report", () => {
  assert.deepEqual(tickPlan(at("2026-10-15T12:32:00Z"), { ...go, budgetLeft: false }), { feed: false, lots: false, report: false });
});

test("the feed sleeps before 07:00; a morning report is not written after the close", () => {
  assert.equal(tickPlan(at("2026-10-15T10:47:00Z"), go).feed, false);
  assert.deepEqual(tickPlan(at("2026-10-15T20:02:00Z"), go), { feed: true, lots: true, report: false });
});
