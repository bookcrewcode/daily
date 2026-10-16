// Run: npx --yes tsx --test supabase/functions/telegram/taps.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tapResult, pauseMs, pauseLabel } from "./taps.ts";

const KEY = "block:00000000-0000-4000-8000-000000000002:2026-10-16";
const NOW = Date.UTC(2026, 9, 16, 14, 30);

test("Starting keeps a Done button on the message, so the block can still be finished from Telegram", () => {
  const t = tapResult("s", KEY, NOW)!;
  assert.equal(t.state, "started");
  assert.deepEqual(t.keyboard, { inline_keyboard: [[{ text: "Done", callback_data: `d|${KEY}` }]] });
  assert.ok(new TextEncoder().encode(`d|${KEY}`).length <= 64);
});

test("Done, Skip and Snooze clear the buttons; Snooze comes back in 15 minutes", () => {
  assert.deepEqual(tapResult("d", KEY, NOW), { state: "done", label: "Done", snoozeUntil: null, keyboard: null });
  assert.deepEqual(tapResult("k", KEY, NOW), { state: "skipped", label: "Skipped today", snoozeUntil: null, keyboard: null });
  assert.deepEqual(tapResult("z", KEY, NOW), { state: "snoozed", label: "Snoozed 15 min", snoozeUntil: new Date(NOW + 15 * 60_000).toISOString(), keyboard: null });
  assert.equal(tapResult("x", KEY, NOW), null);
});

test("/pause reads minutes and hours; bare /pause is 2 hours", () => {
  assert.equal(pauseMs(""), 2 * 3_600_000);
  assert.equal(pauseMs("30m"), 30 * 60_000);
  assert.equal(pauseMs("45 min"), 45 * 60_000);
  assert.equal(pauseMs("2h"), 2 * 3_600_000);
  assert.equal(pauseMs("3"), 3 * 3_600_000);
  assert.equal(pauseMs("90m"), 90 * 60_000);
});

test("/pause refuses what it can't read or what's out of range, instead of guessing", () => {
  assert.equal(pauseMs("tomorrow"), null);
  assert.equal(pauseMs("2m"), null);   // under 5 minutes
  assert.equal(pauseMs("30h"), null);  // over 24 hours
  assert.equal(pauseMs("1.5h"), null);
});

test("pauseLabel says the length in plain words", () => {
  assert.equal(pauseLabel(30 * 60_000), "30 minutes");
  assert.equal(pauseLabel(3_600_000), "1 hour");
  assert.equal(pauseLabel(2 * 3_600_000), "2 hours");
  assert.equal(pauseLabel(90 * 60_000), "1 hour 30 minutes");
});
