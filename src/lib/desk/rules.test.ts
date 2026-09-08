import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, sizePosition, guardrail, liqPrice, haltCheck, ladderState, drawdownHalved } from "./rules";
import type { Plan, Trade, InstrumentMeta } from "./types";

const stockPlan = (over: Partial<Plan> = {}): Plan => ({
  venue: "robinhood", instrument: "stock", symbol: "AAPL", side: "long", leverage: 1, template: 1,
  thesis: "t", catalyst: "c", falsifier: "f", confidence: 0.6, entry_ref: 100, stop: 95, target: 110,
  horizon_days: 10, risk_pct: 3, evidence: [0], key_risks: [], crosses_event: false, ...over,
});
const perpPlan = (over: Partial<Plan> = {}): Plan => stockPlan({ venue: "blofin", instrument: "crypto_perp", symbol: "BTC-USDT", entry_ref: 80000, stop: 78400, target: 84000, leverage: 10, ...over });
const shareMeta: InstrumentMeta = { max_leverage: 1, contract_value: 1, lot_size: 1, tick_size: 0.01 };
const btcMeta: InstrumentMeta = { max_leverage: 150, contract_value: 0.001, lot_size: 1, tick_size: 0.1 };

test("sizing a stock from risk: 3% of 100k with a $5 stop = 600 shares", () => {
  const s = sizePosition(stockPlan(), 100000, PRESETS.aggressive, shareMeta);
  assert.equal(s.qty, 600);
  assert.equal(s.unit, "share");
  assert.equal(s.notional, 60000);
  assert.equal(s.leverage, 1);
  assert.equal(s.risk_usd, 3000);
});

test("notional cap binds: a 1% stop would want 300% of equity", () => {
  const s = sizePosition(stockPlan({ stop: 99 }), 100000, PRESETS.aggressive, shareMeta);
  assert.equal(s.notional, 100000);
  assert.equal(s.qty, 1000);
  assert.ok(s.capped_by.includes("max_notional"));
});

test("perp sizing rounds to contracts, caps notional, margin = notional / leverage", () => {
  // aggressive: 3% risk with a 2% stop wants 150% notional, capped at 100% of equity
  const a = sizePosition(perpPlan(), 100000, PRESETS.aggressive, btcMeta);
  assert.equal(a.qty, 1250);
  assert.equal(a.unit, "contract");
  assert.equal(a.notional, 100000);
  assert.equal(a.margin, 10000);
  assert.ok(a.capped_by.includes("max_notional"));
  // very aggressive allows 200%: 3000 / 1600 = 1.875 BTC = 1875 contracts of 0.001
  const v = sizePosition(perpPlan(), 100000, PRESETS.very_aggressive, btcMeta);
  assert.equal(v.qty, 1875);
  assert.equal(v.notional, 1875 * 0.001 * 80000);
  assert.equal(v.leverage, 10);
  assert.equal(v.margin, v.notional / 10);
});

test("leverage is capped by the preset and the instrument", () => {
  const s = sizePosition(perpPlan({ leverage: 50 }), 100000, PRESETS.aggressive, btcMeta);
  assert.equal(s.leverage, 10);
  assert.ok(s.capped_by.includes("leverage"));
});

test("liquidation price and the guardrail buffer", () => {
  assert.ok(Math.abs(liqPrice(100, "long", 10) - 90.5) < 1e-9);
  assert.ok(Math.abs(liqPrice(100, "short", 10) - 109.5) < 1e-9);
  const g = guardrail(perpPlan({ leverage: 50, stop: 78400 }), {
    equity: 100000, rules: PRESETS.very_aggressive, open: [], atr: 1200, meta: btcMeta, halted: false,
    themeOf: () => "crypto", drawdownHalved: false, newTonight: 0,
  });
  assert.equal(g.ok, true, g.reasons.join(","));
  assert.ok(g.sizing!.leverage <= 25);
  const liq = liqPrice(80000, "long", g.sizing!.leverage);
  assert.ok(80000 - liq >= 1600 * 1.2 - 1e-6);
});

test("a tight stop at high leverage gets the leverage cut until the liquidation buffer holds", () => {
  // 0.5% stop at 25x: liq is 3.5% away → fine. 0.5% stop at 100x on a 200x instrument: liq 0.5% away → must cut
  const wide: InstrumentMeta = { max_leverage: 200, contract_value: 0.001, lot_size: 1, tick_size: 0.1 };
  const rules = { ...PRESETS.very_aggressive, max_leverage: 100 };
  const g = guardrail(perpPlan({ leverage: 100, stop: 79600, target: 81000 }), {
    equity: 100000, rules, open: [], atr: 200, meta: wide, halted: false, themeOf: () => "crypto", drawdownHalved: false, newTonight: 0,
  });
  assert.equal(g.ok, true, g.reasons.join(","));
  assert.ok(g.sizing!.leverage < 100);
  assert.ok(80000 - liqPrice(80000, "long", g.sizing!.leverage) >= 400 * 1.2 - 1e-6);
  assert.ok(g.reasons.some((r) => /leverage/.test(r)));
});

test("guardrail rejects wrong-side stops, thin reward, duplicates, halts and caps", () => {
  const base = { equity: 100000, rules: PRESETS.aggressive, open: [] as Trade[], atr: 2, meta: shareMeta, halted: false, themeOf: () => "tech", drawdownHalved: false, newTonight: 0 };
  assert.equal(guardrail(stockPlan({ stop: 105 }), base).ok, false);
  assert.equal(guardrail(stockPlan({ target: 104 }), base).ok, false); // rr 0.8
  assert.equal(guardrail(stockPlan({ stop: 99.5 }), base).ok, false); // 0.5 < 0.5×atr(2)=1
  assert.equal(guardrail(stockPlan(), { ...base, halted: true }).ok, false);
  assert.equal(guardrail(stockPlan(), { ...base, rules: { ...PRESETS.aggressive, max_new_per_night: 2 }, newTonight: 2 }).ok, false);
  const open = { symbol: "AAPL", notional: 10000, risk_pct: 3, entry_price: 100, stop: 95, qty: 100, unit: "share", contract_value: 1, status: "open" } as unknown as Trade;
  assert.equal(guardrail(stockPlan(), { ...base, open: [open] }).ok, false);
  const ok = guardrail(stockPlan(), base);
  assert.equal(ok.ok, true);
  assert.equal(ok.sizing!.qty, 600);
});

test("theme cap, gross cap and heat cap", () => {
  const mkOpen = (symbol: string, notional: number, risk: number): Trade =>
    ({ symbol, notional, entry_price: 100, stop: 100 - risk / 100, qty: 100, unit: "share", contract_value: 1, status: "open" } as unknown as Trade);
  // the mechanism, with the caps pinned: the presets themselves moved in phase 5
  const base = { equity: 100000, rules: { ...PRESETS.aggressive, gross_cap_pct: 200, heat_cap_pct: 12, max_per_theme: 2 }, atr: 2, meta: shareMeta, halted: false, themeOf: (s: string) => (s === "AAPL" || s === "MSFT" || s === "NVDA" ? "tech" : "other"), drawdownHalved: false, newTonight: 0 };
  assert.equal(guardrail(stockPlan(), { ...base, open: [mkOpen("MSFT", 1000, 100), mkOpen("NVDA", 1000, 100)] }).ok, false); // 2 tech already
  assert.equal(guardrail(stockPlan(), { ...base, open: [mkOpen("XOM", 150000, 100)] }).ok, false); // 150k + 60k > 200k gross
  assert.equal(guardrail(stockPlan(), { ...base, open: [mkOpen("XOM", 1000, 10000)] }).ok, false); // heat 10000 + 3000 > 12000
  assert.equal(guardrail(stockPlan(), { ...base, open: [mkOpen("XOM", 1000, 100)] }).ok, true);
});

test("halts: a −6% day halts the next session; ladder needs 20 positive trades", () => {
  const h = haltCheck({ equity: 93000, equityYesterday: 100000, equityWeekStart: 100000, rules: PRESETS.aggressive, today: "2026-09-08" });
  assert.equal(h.halt, true);
  assert.equal(h.until, "2026-09-09");
  assert.equal(haltCheck({ equity: 99000, equityYesterday: 100000, equityWeekStart: 100000, rules: PRESETS.aggressive, today: "2026-09-08" }).halt, false);
  const w = haltCheck({ equity: 87000, equityYesterday: 88000, equityWeekStart: 100000, rules: PRESETS.aggressive, today: "2026-09-10" });
  assert.equal(w.halt, true);
  assert.equal(w.until, "2026-09-17");
  assert.equal(ladderState(Array.from({ length: 19 }, () => ({ r_multiple: 1 }))).unlocked, false);
  assert.equal(ladderState(Array.from({ length: 20 }, () => ({ r_multiple: 0.2 }))).unlocked, true);
  assert.equal(drawdownHalved(100000, 89000), true);
  assert.equal(drawdownHalved(100000, 95000), false);
});
