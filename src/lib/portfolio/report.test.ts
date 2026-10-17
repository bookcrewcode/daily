import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORT_SYSTEM, parseReport, reportDue, reportPrompt, type ReportInput } from "./report";

const input: ReportInput = {
  day: "2026-10-16",
  holdings: [{ symbol: "SPCX", name: "Space Exploration Technologies Corp.", price: 146.7, ret1d: 0.012, ret5d: -0.034, shares: 7.73, value: 1134, gainPct: 0.031 }],
  news: [],
  macro: [],
  events: [{ day: "2026-10-28", time_et: "14:00", kind: "fomc", label: "FOMC decision", symbol: "" }],
  market: [{ label: "S&P 500", level: 6850.12, change: 0.004, unit: "pct" }, { label: "10-year Treasury yield", level: 4.21, change: -0.03, unit: "pts" }],
};

test("the prompt carries the numbers, says none for empty sections, and gives the yield in points", () => {
  const p = reportPrompt(input);
  assert.ok(p.includes("SPCX (Space Exploration Technologies Corp.): $146.70, +1.2% yesterday, -3.4% over 5 days; he holds 7.73 shares worth $1134, +3.1% against what he paid."));
  assert.ok(p.includes("S&P 500: 6850.12, +0.4% yesterday."));
  assert.ok(p.includes("10-year Treasury yield: 4.21%, -0.03 points yesterday."));
  assert.ok(p.includes("NEWS ON HIS HOLDINGS (last 24 hours, most important first)\nnone"));
  assert.ok(p.includes("2026-10-28 14:00 ET: FOMC decision"));
});

test("the system prompt has no blank lines (the lib copy would drop them)", () => {
  assert.ok(!/\n\s*\n/.test(REPORT_SYSTEM));
});

test("a good answer is kept; unknown and repeated holdings are dropped; watch stops at three", () => {
  const raw = JSON.stringify({
    summary: "SPCX rose 1.2% yesterday after a launch contract; the wider market was flat.",
    watch: ["a", "b", "c", "d"],
    per_holding: [{ symbol: "spcx", line: "Up on the contract." }, { symbol: "TSLA", line: "Not held." }, { symbol: "SPCX", line: "Duplicate." }],
  });
  const out = parseReport(raw, ["SPCX"])!;
  assert.equal(out.summary.startsWith("SPCX rose"), true);
  assert.deepEqual(out.watch, ["a", "b", "c"]);
  assert.deepEqual(out.per_holding, [{ symbol: "SPCX", line: "Up on the contract." }]);
});

test("an answer in the wrong shape is refused", () => {
  assert.equal(parseReport("not json", ["SPCX"]), null);
  assert.equal(parseReport(JSON.stringify({ summary: "short" }), ["SPCX"]), null);
  assert.equal(parseReport(42, ["SPCX"]), null);
  assert.equal(parseReport(null, ["SPCX"]), null);
});

test("a report is due when missing or failed, waits while running, and stops after three tries", () => {
  const now = Date.parse("2026-10-16T12:40:00Z");
  assert.equal(reportDue(now, null), true);
  assert.equal(reportDue(now, { status: "done", tries: 1, updated_at: "2026-10-16T12:31:00Z" }), false);
  assert.equal(reportDue(now, { status: "failed", tries: 1, updated_at: "2026-10-16T12:31:00Z" }), true);
  assert.equal(reportDue(now, { status: "failed", tries: 3, updated_at: "2026-10-16T12:31:00Z" }), false);
  assert.equal(reportDue(now, { status: "running", tries: 1, updated_at: "2026-10-16T12:38:00Z" }), false);
  assert.equal(reportDue(now, { status: "running", tries: 1, updated_at: "2026-10-16T12:34:00Z" }), true);
});
