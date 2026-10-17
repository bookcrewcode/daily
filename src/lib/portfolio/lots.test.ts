import { test } from "node:test";
import assert from "node:assert/strict";
import { holdingsOf, type Lot, type LotKind } from "./lots";

let seq = 0;
const lot = (symbol: string, shares: number, price: number, day: string, kind: LotKind = "manual", extra: Partial<Lot> = {}): Lot => {
  seq++;
  return { id: `l${seq}`, symbol, shares, price, day, kind, assumed: false, note: "", created_at: new Date(Date.UTC(2026, 9, 16, 12) + seq * 1000).toISOString(), ...extra };
};
const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("buys add up at average cost; value, gain, today and weight come from the quote", () => {
  const { holdings, totals } = holdingsOf(
    [lot("SPCX", 5, 140, "2026-10-12", "start"), lot("SPCX", 2.726653, 146.7, "2026-10-14", "weekly", { assumed: true })],
    { SPCX: { price: 150, prevClose: 147, name: "Space Exploration Technologies Corp." } },
  );
  assert.equal(holdings.length, 1);
  const h = holdings[0];
  close(h.shares, 7.726653);
  close(h.cost, 700 + 2.726653 * 146.7);
  close(h.avgCost, (700 + 2.726653 * 146.7) / 7.726653);
  close(h.value, 7.726653 * 150);
  close(h.gain, 7.726653 * 150 - (700 + 2.726653 * 146.7));
  close(h.dayChange, 7.726653 * 3);
  close(h.weight, 1);
  assert.equal(h.assumedLots, 1);
  assert.equal(h.name, "Space Exploration Technologies Corp.");
  close(totals.value, 7.726653 * 150);
  assert.deepEqual(totals.missing, []);
});

test("a sale comes out at average cost and books the realized gain", () => {
  const { holdings } = holdingsOf(
    [lot("RKLB", 10, 100, "2026-10-01"), lot("RKLB", 10, 200, "2026-10-02"), lot("RKLB", -5, 180, "2026-10-03")],
    { RKLB: { price: 190, prevClose: null } },
  );
  close(holdings[0].shares, 15);
  close(holdings[0].cost, 2250);
  close(holdings[0].avgCost, 150);
  close(holdings[0].realized, 150);
  assert.equal(holdings[0].dayChange, null);
});

test("typed Robinhood numbers replace everything entered before them", () => {
  const { holdings } = holdingsOf(
    [lot("SPCX", 2, 100, "2026-10-07", "weekly", { assumed: true }), lot("SPCX", 10, 120, "2026-10-08", "start"), lot("SPCX", 1, 130, "2026-10-09", "weekly", { assumed: true })],
    { SPCX: { price: 130, prevClose: 130 } },
  );
  close(holdings[0].shares, 11);
  close(holdings[0].cost, 1330);
  assert.equal(holdings[0].assumedLots, 1);
});

test("on the same day, the order the entries were made decides", () => {
  const weeklyFirst = holdingsOf([lot("SPCX", 1, 146, "2026-10-14", "weekly"), lot("SPCX", 8, 140, "2026-10-14", "start")], { SPCX: { price: 150, prevClose: 150 } });
  close(weeklyFirst.holdings[0].shares, 8);
  close(weeklyFirst.holdings[0].cost, 1120);
  const startFirst = holdingsOf([lot("SPCX", 8, 140, "2026-10-14", "start"), lot("SPCX", 1, 146, "2026-10-14", "weekly")], { SPCX: { price: 150, prevClose: 150 } });
  close(startFirst.holdings[0].shares, 9);
  close(startFirst.holdings[0].cost, 1266);
});

test("a missing price leaves the holding out of the totals and names it", () => {
  const { holdings, totals } = holdingsOf(
    [lot("SPCX", 2, 100, "2026-10-01", "start"), lot("RKLB", 10, 50, "2026-10-01", "start")],
    { SPCX: { price: 110, prevClose: 100 } },
  );
  assert.equal(holdings[0].symbol, "SPCX");
  close(holdings[0].weight, 1);
  const rklb = holdings.find((h) => h.symbol === "RKLB")!;
  assert.equal(rklb.value, null);
  assert.equal(rklb.weight, null);
  close(totals.value, 220);
  close(totals.cost, 200);
  close(totals.gain, 20);
  close(totals.dayChange, 20);
  assert.deepEqual(totals.missing, ["RKLB"]);
});

test("selling everything closes the holding; selling more than held stops at zero", () => {
  const { holdings, totals } = holdingsOf([lot("ASTS", 3, 10, "2026-10-01"), lot("ASTS", -5, 12, "2026-10-02")], { ASTS: { price: 12, prevClose: 12 } });
  assert.equal(holdings.length, 0);
  close(totals.realized, 6);
});

test("symbols merge whatever their case", () => {
  const { holdings } = holdingsOf([lot("spcx", 1, 100, "2026-10-01"), lot("SPCX", 1, 120, "2026-10-02")], { SPCX: { price: 110, prevClose: 110 } });
  assert.equal(holdings.length, 1);
  close(holdings[0].shares, 2);
});
