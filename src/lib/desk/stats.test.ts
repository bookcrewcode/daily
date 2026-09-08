import { test } from "node:test";
import assert from "node:assert/strict";
import { tradeStats, curveStats, brier, calibration, calibratedConfidence, eloUpdate, eloK, shrink, tstat, tradesToDetect } from "./stats";

test("tradeStats basics", () => {
  const s = tradeStats([
    { pnl: 300, r_multiple: 1, entry_at: "2026-09-01T13:30:00Z", exit_at: "2026-09-03T13:30:00Z" },
    { pnl: -100, r_multiple: -1, entry_at: "2026-09-01T13:30:00Z", exit_at: "2026-09-02T13:30:00Z" },
    { pnl: 200, r_multiple: 0.5, entry_at: "2026-09-01T13:30:00Z", exit_at: "2026-09-04T13:30:00Z" },
  ]);
  assert.equal(s.n, 3);
  assert.equal(s.wins, 2);
  assert.ok(Math.abs(s.winRate! - 2 / 3) < 1e-9);
  assert.equal(s.profitFactor, 5);
  assert.ok(Math.abs(s.expectancyR! - 0.5 / 3) < 1e-9);
  assert.ok(Math.abs(s.avgHoldDays! - 2) < 1e-9);
  assert.equal(tradeStats([]).winRate, null);
});

test("curveStats drawdown and sharpe", () => {
  const c = curveStats([100, 110, 99, 120]);
  assert.ok(Math.abs(c.totalReturn - 0.2) < 1e-9);
  assert.ok(Math.abs(c.maxDrawdown - 0.1) < 1e-9);
  assert.equal(c.ddDays, 1);
  assert.equal(curveStats([100, 100, 100]).sharpeDaily, null); // zero variance
  assert.ok(c.sharpeDaily! > 0);
});

test("brier, calibration bins and shrinking confidence", () => {
  const preds = [{ p: 0.9, won: false }, { p: 0.9, won: true }, { p: 0.6, won: true }];
  assert.ok(Math.abs(brier(preds)! - ((0.81 + 0.01 + 0.16) / 3)) < 1e-9);
  const bins = calibration(preds);
  const b9 = bins.find((b) => b.bin === "0.9-1.0")!;
  assert.equal(b9.n, 2);
  assert.equal(b9.hit, 0.5);
  assert.equal(calibratedConfidence(0.95, bins), 0.95 * (20 / 22) + 0.5 * (2 / 22));
  assert.equal(calibratedConfidence(0.65, []), 0.65);
  assert.equal(brier([]), null);
});

test("elo, K schedule, shrinkage, t-stat, sample size", () => {
  const r = eloUpdate(1500, 1500, 1, 32);
  assert.equal(r.ra, 1516);
  assert.equal(r.rb, 1484);
  assert.equal(eloK(10), 32);
  assert.equal(eloK(30), 16);
  assert.equal(shrink(1, 20), 0.5);
  assert.ok(Math.abs(tstat([1, 1, 1, 1, 3])! - (1.4 / (Math.sqrt(0.8) / Math.sqrt(5)))) < 1e-9);
  assert.equal(tstat([1, 2]), null);
  assert.equal(tradesToDetect(0.6), Math.ceil((1.96 * 0.5 / 0.1) ** 2));
});
