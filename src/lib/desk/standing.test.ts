import { test } from "node:test";
import assert from "node:assert/strict";
import { standingOf, DEFAULT_CUT_RULES } from "./stats";

const base = { elo: 1500, n_trades: 0, sum_r: 0, brier_sum: 0, brier_n: 0, n_sits: 0, n_sit_right: 0, equity: null as number | null };

test("a juror is fresh until it has the sample, however its book looks", () => {
  const s = standingOf({ ...base, seat: "nightly", n_trades: 5, equity: 80000 });
  assert.equal(s.label, "fresh");
  assert.equal(s.needed, DEFAULT_CUT_RULES.min_trades);
});

test("a nightly juror is cut when its book is 10% down after the sample", () => {
  const s = standingOf({ ...base, seat: "nightly", n_trades: 12, equity: 89000 });
  assert.equal(s.label, "cut");
  assert.match(s.reasons[0], /below its start/);
});

test("half the loss is a notice, not a cut", () => {
  const s = standingOf({ ...base, seat: "nightly", n_trades: 12, equity: 94000 });
  assert.equal(s.label, "on notice");
});

test("a sit juror is cut on a coin-flip Brier or a losing side rate", () => {
  const brier = standingOf({ ...base, seat: "sit", n_sits: 30, n_sit_right: 20, brier_sum: 9.3, brier_n: 30 });
  assert.equal(brier.label, "cut");
  const wrong = standingOf({ ...base, seat: "sit", n_sits: 30, n_sit_right: 11, brier_sum: 6, brier_n: 30 });
  assert.equal(wrong.label, "cut");
  assert.match(wrong.reasons[0], /right on 37%/);
});

test("a juror clearing every bar is meeting the standard", () => {
  const s = standingOf({ ...base, seat: "nightly", n_trades: 20, sum_r: 6, brier_sum: 4, brier_n: 20, equity: 104000, elo: 1520 });
  assert.equal(s.label, "meeting the standard");
  assert.deepEqual(s.reasons, []);
});

test("a low Elo cuts either seat", () => {
  const s = standingOf({ ...base, seat: "sit", n_sits: 40, n_sit_right: 24, brier_sum: 8, brier_n: 40, elo: 1430 });
  assert.equal(s.label, "cut");
  assert.match(s.reasons[0], /Elo 1430/);
});
