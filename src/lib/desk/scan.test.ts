import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSymbol, ema, rsi, weeklyCloses, momentum12_1, percentile, type ScanInput } from "./scan";
import type { Bar } from "./types";

// A synthetic daily series: a steady uptrend with a dip into the 20-day EMA at the end.
function trendBars(n = 320, dipDays = 6, up = 1.0025, down = 0.992): Bar[] {
  const bars: Bar[] = [];
  let p = 100;
  const t0 = Date.UTC(2025, 8, 1, 13, 30);
  for (let i = 0; i < n; i++) {
    const trendUp = i < n - dipDays;
    p = p * (trendUp ? up : down);
    const o = p / 1.002, h = p * 1.006, l = p * 0.994;
    bars.push({ t: t0 + i * 86_400_000, o, h, l, c: p, v: 1_000_000 });
  }
  // the last day closes up (the dip is being bought)
  const last = bars[bars.length - 1]; const prev = bars[bars.length - 2];
  last.c = prev.c * 1.003; last.h = Math.max(last.h, last.c * 1.002); last.l = Math.min(last.l, last.c * 0.995);
  return bars;
}
function input(daily: Bar[], extra: Partial<ScanInput> = {}): ScanInput {
  return { symbol: "TEST", venue: "robinhood", instrument: "stock", nowMs: daily[daily.length - 1].t + 86_400_000, daily, ...extra };
}

test("indicators: ema, rsi, weekly closes, momentum, percentile", () => {
  assert.equal(ema([1, 1, 1, 1], 3).at(-1), 1);
  assert.ok((rsi([1, 2, 3, 4, 5, 6], 2) ?? 0) > 90);
  const bars = trendBars(60);
  assert.ok(weeklyCloses(bars).length >= 8 && weeklyCloses(bars).length <= 10);
  assert.ok((momentum12_1(trendBars(320).map((b) => b.c)) ?? 0) > 0.3);
  assert.equal(percentile(5, [1, 2, 3, 4, 6, 7, 8, 9, 10, 11]), 0.4);
});

test("trend pullback fires on a dip into the EMA20 inside an uptrend, with sane levels", () => {
  const daily = trendBars();
  const setups = scanSymbol(input(daily), new Set(["trend-pullback"]));
  const s = setups.find((x) => x.strategy === "trend-pullback" && x.side === "long");
  assert.ok(s, "expected a long trend-pullback setup");
  assert.ok(s.stop < s.entry_ref && s.target > s.entry_ref);
  assert.ok((s.target - s.entry_ref) / (s.entry_ref - s.stop) >= 1.9);
  assert.ok(s.reasons.filter((r) => r.core).every((r) => r.ok));
  assert.equal(s.timeframe, "swing");
});

test("no setups on a flat, choppy series and none for a short history", () => {
  const flat: Bar[] = Array.from({ length: 260 }, (_, i) => ({ t: Date.UTC(2025, 8, 1) + i * 86_400_000, o: 100, h: 100.5, l: 99.5, c: 100 + (i % 2 ? 0.2 : -0.2), v: 1_000_000 }));
  assert.equal(scanSymbol(input(flat)).length, 0);
  assert.equal(scanSymbol(input(trendBars(30))).length, 0);
});

test("funding extreme fade shorts a crowded perp at a 20-day high", () => {
  const daily = trendBars(120, 0);
  const s = scanSymbol(input(daily, { venue: "blofin", instrument: "crypto_perp", funding: 0.0015, maxLeverage: 50 }), new Set(["funding-extreme-fade"]))[0];
  assert.ok(s, "expected a fade setup");
  assert.equal(s.side, "short");
  assert.ok(s.stop > s.entry_ref && s.target < s.entry_ref);
  assert.equal(s.leverage_hint, 3);
});
