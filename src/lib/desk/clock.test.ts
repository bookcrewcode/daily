import { test } from "node:test";
import assert from "node:assert/strict";
import { etDate, isTradingDay, sessionBounds, isNyseOpen, nextSessionDate, sessionDateForFill, fundingTimesBetween, nextHourMs, weekStart, addDays } from "./clock";

const ms = (iso: string) => Date.parse(iso);

test("Labor Day 2026 is not a trading day; the day after is", () => {
  assert.equal(isTradingDay("2026-09-07"), false);
  assert.equal(isTradingDay("2026-09-08"), true);
  assert.equal(isTradingDay("2026-09-12"), false); // Saturday
});

test("session bounds are 9:30–16:00 ET, 13:00 on early-close days", () => {
  const b = sessionBounds("2026-09-08")!;
  assert.equal(b.openMs, ms("2026-09-08T13:30:00Z")); // EDT
  assert.equal(b.closeMs, ms("2026-09-08T20:00:00Z"));
  const e = sessionBounds("2026-11-27")!;
  assert.equal(e.closeMs, ms("2026-11-27T18:00:00Z")); // EST, 13:00
  assert.equal(sessionBounds("2026-09-07"), null);
});

test("isNyseOpen respects the session", () => {
  assert.equal(isNyseOpen(ms("2026-09-08T13:29:00Z")), false);
  assert.equal(isNyseOpen(ms("2026-09-08T13:31:00Z")), true);
  assert.equal(isNyseOpen(ms("2026-09-08T20:01:00Z")), false);
});

test("a decision Monday night (holiday) fills Tuesday; Friday night fills Monday", () => {
  assert.equal(sessionDateForFill(ms("2026-09-08T01:30:00Z")), "2026-09-08"); // 21:30 ET Mon Sep 7
  assert.equal(sessionDateForFill(ms("2026-09-12T01:30:00Z")), "2026-09-14"); // 21:30 ET Fri Sep 11
  assert.equal(sessionDateForFill(ms("2026-09-08T14:00:00Z")), "2026-09-09"); // decided after Tuesday's open
  assert.equal(nextSessionDate("2026-09-04"), "2026-09-08");
});

test("etDate uses New York, funding marks every 8h UTC, hours roll", () => {
  assert.equal(etDate(ms("2026-09-08T01:30:00Z")), "2026-09-07");
  assert.deepEqual(fundingTimesBetween(ms("2026-09-08T07:59:00Z"), ms("2026-09-08T16:00:00Z")), [ms("2026-09-08T08:00:00Z"), ms("2026-09-08T16:00:00Z")]);
  assert.equal(nextHourMs(ms("2026-09-08T07:59:00Z")), ms("2026-09-08T08:00:00Z"));
  assert.equal(nextHourMs(ms("2026-09-08T08:00:00Z")), ms("2026-09-08T09:00:00Z"));
  assert.equal(weekStart("2026-09-10"), "2026-09-07");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
});
