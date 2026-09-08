import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, rsi14, atr14, realizedVol20, pctChange, buildCard, cardLine } from "./ta";
import type { Bar } from "./types";

const mk = (closes: number[]): Bar[] => closes.map((c, i) => ({ t: 1_700_000_000_000 + i * 86_400_000, o: c * 0.99, h: c * 1.01, l: c * 0.98, c, v: 1000 + i }));

test("sma and pctChange", () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1, 2], 3), null);
  assert.ok(Math.abs(pctChange([100, 110, 121], 2) - 0.21) < 1e-9);
});

test("rsi14 is 100 on a pure uptrend and ~50 on a flat series", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi14(up), 100);
  const flat = Array.from({ length: 30 }, () => 100);
  assert.equal(rsi14(flat), 50);
  assert.equal(rsi14([1, 2, 3]), null);
});

test("atr14 on constant 3% ranges is 3% of price", () => {
  const bars = mk(Array.from({ length: 40 }, () => 100));
  const a = atr14(bars)!;
  assert.ok(Math.abs(a - 3) < 0.05, `atr ${a}`);
});

test("realizedVol20 of a flat series is 0", () => {
  assert.equal(realizedVol20(Array.from({ length: 25 }, () => 100)), 0);
});

test("buildCard trend and 52-week distances", () => {
  const closes = Array.from({ length: 260 }, (_, i) => 100 + i * 0.5); // rising
  const card = buildCard({ symbol: "AAPL", venue: "robinhood", instrument: "stock", name: "Apple", bars: mk(closes) });
  assert.equal(card.trend, "up");
  assert.equal(card.bars, 260);
  assert.ok(card.pctFromHi52 <= 0 && card.pctFromHi52 > -0.02);
  assert.ok(card.sma200! < card.price);
  assert.ok(cardLine(card).startsWith("AAPL "));
});

test("buildCard survives a short history", () => {
  const card = buildCard({ symbol: "NEW-USDT", venue: "blofin", instrument: "crypto_perp", name: "NEW", bars: mk([1, 1.1, 1.2]) });
  assert.equal(card.sma20, null);
  assert.equal(card.trend, "mixed");
});
