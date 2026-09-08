import { test } from "node:test";
import assert from "node:assert/strict";
import { instrumentOf, venueOf, isMajorCrypto, baseOf, unitValue } from "./types";

test("instrumentOf classifies by venue and shape", () => {
  assert.equal(instrumentOf("BTC-USDT", "blofin"), "crypto_perp");
  assert.equal(instrumentOf("BTC-USD", "robinhood"), "crypto_spot");
  assert.equal(instrumentOf("AAPL", "robinhood"), "stock");
  assert.equal(instrumentOf("SPY", "robinhood", "ETF"), "etf");
});

test("venueOf maps instruments to venues", () => {
  assert.equal(venueOf("crypto_perp"), "blofin");
  assert.equal(venueOf("stock"), "robinhood");
  assert.equal(venueOf("crypto_spot"), "robinhood");
});

test("majors and bases", () => {
  assert.equal(isMajorCrypto("BTC-USDT"), true);
  assert.equal(isMajorCrypto("SOL-USD"), true);
  assert.equal(isMajorCrypto("DOGE-USDT"), false);
  assert.equal(baseOf("ETH-USDT"), "ETH");
  assert.equal(baseOf("AAPL"), "AAPL");
});

test("unitValue is 1 except for contracts", () => {
  assert.equal(unitValue({ unit: "share", contract_value: 1 }), 1);
  assert.equal(unitValue({ unit: "contract", contract_value: 0.001 }), 0.001);
});
