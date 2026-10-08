import { test } from "node:test";
import assert from "node:assert/strict";
import { brier, calibration, findBuzzwords, drillDone, toScore, asPrediction, influenceTally, isLate, type Entry } from "./reading";

const e = (kind: Entry["kind"], day: string, data: Record<string, unknown> = {}): Entry =>
  ({ id: Math.random().toString(36), book_id: null, kind, day, data, created_at: "" });

test("brier: perfect, coin-flip, confident miss", () => {
  assert.equal(brier([]), null);
  assert.equal((brier([{ outcome: "a", confidence: 99, deadline: "", result: true }]) ?? -1).toFixed(4), "0.0001");
  assert.equal(brier([{ outcome: "a", confidence: 50, deadline: "", result: false }]), 0.25);
  assert.equal((brier([{ outcome: "a", confidence: 90, deadline: "", result: false }]) ?? -1).toFixed(2), "0.81");
  // unscored predictions don't count
  assert.equal(brier([{ outcome: "a", confidence: 90, deadline: "", result: null }]), null);
});

test("calibration folds sub-50 calls onto the other side", () => {
  const rows = calibration([
    { outcome: "a", confidence: 30, deadline: "", result: false },  // = 70% it won't, and it didn't → hit
    { outcome: "b", confidence: 70, deadline: "", result: false },  // 70%, miss
  ]);
  assert.deepEqual(rows, [{ band: "70–79%", said: 70, hit: 50, n: 2 }]);
});

test("buzzwords are whole words, case-insensitive", () => {
  assert.deepEqual(findBuzzwords("Banks use LEVERAGE to lend more"), ["leverage"]);
  assert.deepEqual(findBuzzwords("they borrowed a lot so wins and losses got bigger"), []);
  assert.deepEqual(findBuzzwords("bondsman"), []);
});

test("drillDone: daily, weekly, predict-by-scoring", () => {
  const today = "2026-10-08", wk = "2026-10-05";
  assert.equal(drillDone("apply", [e("apply", "2026-10-07")], today, wk), false);
  assert.equal(drillDone("apply", [e("apply", today)], today, wk), true);
  assert.equal(drillDone("layers", [e("layers", "2026-10-05")], today, wk), true);
  assert.equal(drillDone("layers", [e("layers", "2026-10-04")], today, wk), false);
  assert.equal(drillDone("predict", [e("predict", "2026-09-01", { scored_on: today })], today, wk), true);
});

test("toScore: only past-deadline, unscored", () => {
  const list = [
    e("predict", "2026-09-01", { outcome: "x", confidence: 60, deadline: "2026-09-30" }),
    e("predict", "2026-09-01", { outcome: "y", confidence: 60, deadline: "2026-10-30" }),
    e("predict", "2026-09-01", { outcome: "z", confidence: 60, deadline: "2026-09-30", result: true }),
  ].map((x) => ({ e: x, p: asPrediction(x) }));
  assert.deepEqual(toScore(list, "2026-10-01").map((x) => x.p.outcome), ["x"]);
});

test("asPrediction clamps confidence", () => {
  assert.equal(asPrediction(e("predict", "d", { confidence: 140 })).confidence, 99);
  assert.equal(asPrediction(e("predict", "d", { confidence: -3 })).confidence, 1);
});

test("influence tally and late hours", () => {
  const t = influenceTally([e("apply", "d", { principle: "liking", worked: "yes" }), e("apply", "d", { principle: "liking", worked: "no" })]);
  assert.deepEqual(t.find((r) => r.key === "liking")?.n, 2);
  assert.deepEqual(t.find((r) => r.key === "liking")?.worked, 1);
  assert.equal(isLate(21), true); assert.equal(isLate(8), false); assert.equal(isLate(3), true);
});
