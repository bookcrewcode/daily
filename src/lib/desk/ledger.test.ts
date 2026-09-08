import { test } from "node:test";
import assert from "node:assert/strict";
import { slippageBps, fillPrice, entryFees, exitFees, scanBars, fundingCharge, unrealized, closeTrade, entryCashDelta, bookEquity, excursions, timeStopDue } from "./ledger";
import type { Trade, Bar } from "./types";

const bar = (o: number, h: number, l: number, c: number, t = 0): Bar => ({ t, o, h, l, c, v: 1 });
const trade = (over: Partial<Trade>): Trade => ({
  id: "t1", owner: "desk", session_id: null, proposal_id: "A1", venue: "robinhood", instrument: "stock", symbol: "AAPL", name: "Apple",
  side: "long", status: "open", template: 1, thesis: "", catalyst: "", falsifier: "", confidence: 0.6, evidence: [], regime: "",
  decided_at: "2026-09-07T01:30:00Z", entry_ref: 100, stop: 95, target: 110, horizon_days: 10, risk_pct: 3, leverage: 1, qty: 600,
  unit: "share", contract_value: 1, notional: 60000, margin: 60000, liq_price: null, entry_price: 100, entry_at: "2026-09-08T13:30:00Z",
  fill_rule: "next_open", slippage_bps: 5, fees: 0, funding: 0, funding_at: null, checked_until: null, expires_on: "2026-09-18",
  exit_price: null, exit_at: null, exit_reason: null, ambiguous_bar: false, pnl: null, pnl_pct: null, r_multiple: null, mae_r: null, mfe_r: null,
  spy_entry: null, spy_exit: null, review: null, ...over,
});

test("slippage and fill prices go against the trader", () => {
  assert.equal(slippageBps("stock", "AAPL", true, 0), 5);
  assert.equal(slippageBps("stock", "AAPL", true, 0.03), 10);
  assert.equal(slippageBps("stock", "XYZ", false, 0), 15);
  assert.equal(slippageBps("crypto_perp", "DOGE-USDT", false, 0), 25);
  assert.equal(slippageBps("crypto_perp", "BTC-USDT", false, 0), 10);
  assert.equal(slippageBps("crypto_spot", "BTC-USD", true, 0), 50);
  assert.ok(Math.abs(fillPrice(100, "long", 5, "enter") - 100.05) < 1e-9);
  assert.ok(Math.abs(fillPrice(100, "short", 5, "enter") - 99.95) < 1e-9);
  assert.ok(Math.abs(fillPrice(100, "long", 5, "exit") - 99.95) < 1e-9);
  assert.ok(Math.abs(fillPrice(100, "short", 5, "exit") - 100.05) < 1e-9);
});

test("fees: stocks pay SEC + TAF on sells only; perps pay taker both ways", () => {
  assert.equal(entryFees({ instrument: "stock", side: "long", qty: 600, notional: 60000 }), 0);
  const shortEntry = entryFees({ instrument: "stock", side: "short", qty: 600, notional: 60000 });
  assert.ok(Math.abs(shortEntry - (60000 * 0.0000206 + 600 * 0.000195)) < 1e-9);
  const bigSell = exitFees({ instrument: "stock", side: "long", qty: 100000, notional: 1000000 });
  assert.ok(Math.abs(bigSell - (1000000 * 0.0000206 + 9.79)) < 1e-9); // TAF capped
  assert.equal(exitFees({ instrument: "stock", side: "short", qty: 600, notional: 60000 }), 0); // buying to cover
  assert.ok(Math.abs(entryFees({ instrument: "crypto_perp", side: "long", qty: 1000, notional: 80000 }) - 48) < 1e-9);
  assert.equal(entryFees({ instrument: "crypto_spot", side: "long", qty: 1, notional: 80000 }), 0);
});

test("scanBars: gap through the stop fills at the gap, both-touched is a stop and ambiguous", () => {
  const t = trade({});
  assert.deepEqual(scanBars(t, [bar(101, 102, 100, 101)]), null);
  assert.deepEqual(scanBars(t, [bar(93, 96, 92, 95, 7)]), { reason: "stop", price: 93, t: 7, ambiguous: false });
  assert.deepEqual(scanBars(t, [bar(100, 111, 94, 100, 9)]), { reason: "stop", price: 95, t: 9, ambiguous: true });
  assert.deepEqual(scanBars(t, [bar(100, 112, 99, 111, 3)]), { reason: "target", price: 110, t: 3, ambiguous: false });
  assert.deepEqual(scanBars(t, [bar(101, 102, 100, 101, 1), bar(100, 112, 99, 111, 3)]), { reason: "target", price: 110, t: 3, ambiguous: false });
  const s = trade({ side: "short", stop: 105, target: 90 });
  assert.deepEqual(scanBars(s, [bar(107, 108, 106, 107, 1)]), { reason: "stop", price: 107, t: 1, ambiguous: false });
  assert.deepEqual(scanBars(s, [bar(100, 101, 89, 90, 2)]), { reason: "target", price: 90, t: 2, ambiguous: false });
  const p = trade({ instrument: "crypto_perp", liq_price: 92, stop: 95 });
  assert.deepEqual(scanBars(p, [bar(96, 97, 91, 93, 2)]), { reason: "liquidated", price: 92, t: 2, ambiguous: false });
});

test("time stops: stocks wait for an open session after expiry, crypto uses the timestamp", () => {
  const stock = trade({ expires_on: "2026-09-08" });
  assert.equal(timeStopDue(stock, Date.parse("2026-09-09T14:00:00Z"), "2026-09-09"), true); // Wed 10:00 ET
  assert.equal(timeStopDue(stock, Date.parse("2026-09-09T12:00:00Z"), "2026-09-09"), false); // before the open
  assert.equal(timeStopDue(stock, Date.parse("2026-09-08T14:00:00Z"), "2026-09-08"), false); // expiry day itself
  const perp = trade({ instrument: "crypto_perp", expires_on: "2026-09-10T13:00:00.000Z" });
  assert.equal(timeStopDue(perp, Date.parse("2026-09-10T12:59:00Z"), "2026-09-10"), false);
  assert.equal(timeStopDue(perp, Date.parse("2026-09-10T13:00:00Z"), "2026-09-10"), true);
});

test("funding sign and unrealized", () => {
  assert.ok(Math.abs(fundingCharge(80000, 0.0001, "long") - 8) < 1e-9);
  assert.ok(Math.abs(fundingCharge(80000, 0.0001, "short") + 8) < 1e-9);
  assert.equal(unrealized({ side: "short", qty: 100, entry_price: 100, unit: "share", contract_value: 1 }, 90), 1000);
  assert.equal(unrealized({ side: "long", qty: 1875, entry_price: 80000, unit: "contract", contract_value: 0.001 }, 81000), 1875);
});

test("closing a long stock at the target: pnl, R, pnl%, cash", () => {
  const t = trade({ fees: 0 });
  const r = closeTrade(t, 110, 5, "target");
  assert.ok(Math.abs(r.exit_price - 109.945) < 1e-9);
  const gross = (109.945 - 100) * 600;
  const fees = 600 * 109.945 * 0.0000206 + 600 * 0.000195;
  assert.ok(Math.abs(r.pnl - (gross - fees)) < 1e-6);
  assert.ok(Math.abs(r.r_multiple - r.pnl / 3000) < 1e-9);
  assert.ok(Math.abs(r.pnl_pct - r.pnl / 60000) < 1e-9);
  assert.ok(Math.abs(r.cash_delta - (600 * 109.945 - fees)) < 1e-6);
});

test("closing a short stock at the stop", () => {
  const t = trade({ side: "short", stop: 105, target: 90, fees: 1.36 });
  const r = closeTrade(t, 105, 5, "stop");
  assert.ok(Math.abs(r.exit_price - 105.0525) < 1e-9);
  const gross = (100 - 105.0525) * 600;
  assert.ok(Math.abs(r.pnl - (gross - 1.36)) < 1e-6); // no fee on the cover
  assert.ok(Math.abs(r.cash_delta - (-600 * 105.0525)) < 1e-6);
  assert.ok(r.r_multiple < -1 && r.r_multiple > -1.02);
});

test("a liquidated perp returns no margin; a target perp returns margin + gross − fee", () => {
  const t = trade({ instrument: "crypto_perp", venue: "blofin", symbol: "BTC-USDT", unit: "contract", contract_value: 0.001, qty: 1875, notional: 150000, margin: 15000, leverage: 10, entry_price: 80000, stop: 78400, target: 84000, liq_price: 72400, fees: 90, funding: 12 });
  const r = closeTrade(t, 72400, 10, "liquidated");
  assert.equal(r.exit_price, 72400);
  assert.equal(r.cash_delta, 0);
  assert.ok(r.pnl < -14000);
  const w = closeTrade(t, 84000, 10, "target");
  assert.ok(Math.abs(w.exit_price - 83916) < 1e-9);
  const gross = (83916 - 80000) * 1.875;
  const fee = 1.875 * 83916 * 0.0006;
  assert.ok(Math.abs(w.pnl - (gross - 90 - fee - 12)) < 1e-6);
  assert.ok(Math.abs(w.cash_delta - (15000 + gross - fee)) < 1e-6);
  assert.ok(Math.abs(w.pnl_pct - w.pnl / 15000) < 1e-9);
});

test("entry cash deltas and book equity", () => {
  assert.equal(entryCashDelta(trade({})), -60000);
  assert.equal(entryCashDelta(trade({ side: "short", fees: 1.36 })), 60000 - 1.36);
  const perp = trade({ instrument: "crypto_perp", margin: 15000, fees: 90 });
  assert.equal(entryCashDelta(perp), -15090);
  const eq = bookEquity(100000, [{ pnl: 500 }, { pnl: -200 }], [trade({ fees: 0 })], { AAPL: 102 });
  assert.equal(eq.equity, 100000 + 300 + 1200);
  assert.equal(eq.gross, 60000);
  assert.equal(eq.marketValue, 61200);
  const missing = bookEquity(100000, [], [trade({ fees: 0 })], {});
  assert.equal(missing.equity, 100000); // no mark → unrealized 0
});

test("excursions in R", () => {
  const ex = excursions(trade({}), [bar(100, 104, 98, 103), bar(103, 106, 101, 105)]);
  assert.ok(Math.abs(ex.mae_r - (-2 / 5)) < 1e-9);
  assert.ok(Math.abs(ex.mfe_r - (6 / 5)) < 1e-9);
  const sh = excursions(trade({ side: "short", stop: 105 }), [bar(100, 104, 98, 103)]);
  assert.ok(Math.abs(sh.mae_r - (-4 / 5)) < 1e-9);
  assert.ok(Math.abs(sh.mfe_r - (2 / 5)) < 1e-9);
});
