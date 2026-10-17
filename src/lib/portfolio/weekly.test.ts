import { test } from "node:test";
import assert from "node:assert/strict";
import { buyDateForWeek, dueWeeklyLots, etMidnightMs, firstFiveMinutePrice, sharesFor } from "./weekly";
import type { Bar } from "../desk/types";

const ms = (iso: string) => Date.parse(iso);
const bar = (iso: string, c: number): Bar => ({ t: ms(iso), o: c, h: c, l: c, c, v: 1 });
const SPCX = [{ symbol: "SPCX", usd: 400 }];

test("the buy day is that week's weekday, or the next trading day after a holiday", () => {
  assert.equal(buyDateForWeek("2026-10-12", 3), "2026-10-14");
  assert.equal(buyDateForWeek("2026-11-23", 4), "2026-11-27"); // Thanksgiving Thursday moves to Friday
  assert.equal(buyDateForWeek("2026-12-21", 5), "2026-12-28"); // Christmas Friday moves to next Monday
});

test("a buy day's lot is due once the 9:30 bar is final, and only once", () => {
  const s = { recurring: SPCX, buyDow: 3, since: "2026-10-14" };
  const have = [{ symbol: "SPCX", day: "2026-10-14" }];
  assert.deepEqual(dueWeeklyLots(ms("2026-10-21T13:35:00Z"), s, have), []);
  assert.deepEqual(dueWeeklyLots(ms("2026-10-21T13:37:00Z"), s, have), [{ symbol: "SPCX", usd: 400, day: "2026-10-21" }]);
  assert.deepEqual(dueWeeklyLots(ms("2026-10-21T13:37:00Z"), s, [...have, { symbol: "SPCX", day: "2026-10-21" }]), []);
});

test("a missed buy day is caught up, but never before the weekly buy was set up", () => {
  const now = ms("2026-10-21T13:37:00Z");
  assert.deepEqual(dueWeeklyLots(now, { recurring: SPCX, buyDow: 3, since: "2026-10-14" }, []).map((d) => d.day), ["2026-10-14", "2026-10-21"]);
  assert.deepEqual(dueWeeklyLots(now, { recurring: SPCX, buyDow: 3, since: "2026-10-16" }, []).map((d) => d.day), ["2026-10-21"]);
  assert.deepEqual(dueWeeklyLots(now, { recurring: SPCX, buyDow: 3, since: "2026-09-01" }, []).map((d) => d.day), ["2026-10-07", "2026-10-14", "2026-10-21"]);
});

test("nothing is due without a start date, a ticker or an amount", () => {
  const now = ms("2026-10-21T13:37:00Z");
  assert.deepEqual(dueWeeklyLots(now, { recurring: SPCX, buyDow: 3, since: null }, []), []);
  assert.deepEqual(dueWeeklyLots(now, { recurring: [], buyDow: 3, since: "2026-10-21" }, []), []);
  assert.deepEqual(dueWeeklyLots(now, { recurring: [{ symbol: "SPCX", usd: 0 }], buyDow: 3, since: "2026-10-21" }, []), []);
});

test("a holiday buy day is recorded on the next trading day; tickers match whatever their case", () => {
  const s = { recurring: [{ symbol: "spcx", usd: 400 }], buyDow: 4, since: "2026-11-20" };
  assert.deepEqual(dueWeeklyLots(ms("2026-11-27T14:37:00Z"), s, []), [{ symbol: "SPCX", usd: 400, day: "2026-11-27" }]);
  assert.deepEqual(dueWeeklyLots(ms("2026-11-27T14:37:00Z"), s, [{ symbol: "SPCX", day: "2026-11-27" }]), []);
});

test("the 9:35 price is the close of the bar that opens at 9:30 New York time", () => {
  assert.equal(firstFiveMinutePrice([bar("2026-10-14T13:25:00Z", 1), bar("2026-10-14T13:30:00Z", 146.5), bar("2026-10-14T13:35:00Z", 147)], "2026-10-14"), 146.5);
  assert.equal(firstFiveMinutePrice([bar("2026-11-04T13:30:00Z", 1), bar("2026-11-04T14:30:00Z", 150)], "2026-11-04"), 150); // EST
  assert.equal(firstFiveMinutePrice([bar("2026-11-26T14:30:00Z", 150)], "2026-11-26"), null); // holiday
  assert.equal(firstFiveMinutePrice([bar("2026-10-14T13:45:00Z", 150)], "2026-10-14"), null);
});

test("shares are cut to six decimals, like Robinhood's fractional shares", () => {
  assert.equal(sharesFor(400, 146.7), 2.726653);
  assert.equal(sharesFor(400, 0), 0);
  assert.equal(sharesFor(-5, 10), 0);
});

test("midnight in New York, in both daylight and standard time", () => {
  assert.equal(etMidnightMs("2026-10-16"), ms("2026-10-16T04:00:00Z"));
  assert.equal(etMidnightMs("2026-12-01"), ms("2026-12-01T05:00:00Z"));
});
