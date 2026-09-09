import { test } from "node:test";
import assert from "node:assert/strict";
import { tally, equalWeights } from "./vote";
import { PLAYBOOK, playbookForPrompt, templateName } from "./playbook";
import type { Plan } from "./types";

const plan = (symbol: string): Plan => ({ venue: "robinhood", instrument: "stock", symbol, side: "long", leverage: 1, template: 1, thesis: "", catalyst: "", falsifier: "", confidence: 0.6, entry_ref: 100, stop: 95, target: 110, horizon_days: 5, risk_pct: 3, evidence: [], key_risks: [], crosses_event: false });

test("tally ranks by weighted calibrated support and marks candidates", () => {
  const props = [{ id: "A1", plan: plan("AAPL") }, { id: "B1", plan: plan("XOM") }];
  const w = equalWeights(["m1", "m2", "m3"]);
  const ballots = [
    { juror: "A", model: "m1", stances: { A1: { stance: "support", confidence: 0.8 }, B1: { stance: "oppose", confidence: 0.6 } } },
    { juror: "B", model: "m2", stances: { A1: { stance: "support", confidence: 0.7 }, B1: { stance: "support", confidence: 0.9 } } },
    { juror: "C", model: "m3", stances: { A1: { stance: "abstain", confidence: 0.5 }, B1: { stance: "support", confidence: 0.6 } } },
  ] as const;
  const t = tally(props, ballots as never, w);
  assert.equal(t[0].proposal_id, "A1");
  assert.ok(Math.abs(t[0].score - 1.5) < 1e-9);
  assert.equal(t[0].candidate, true); // 1.5 ≥ 0.5 × 3
  assert.equal(t[1].proposal_id, "B1");
  assert.ok(Math.abs(t[1].score - 0.9) < 1e-9);
  assert.equal(t[1].candidate, false);
  assert.equal(t[0].voters, 3);
  assert.equal(t[0].support, 2);
  assert.equal(t[1].oppose, 1);
  assert.equal(t[0].rr, 2);
});

test("a proposal with too few voters is never a candidate", () => {
  const props = [{ id: "A1", plan: plan("AAPL") }];
  const w = equalWeights(["m1", "m2", "m3"]);
  const t = tally(props, [{ juror: "A", model: "m1", stances: { A1: { stance: "support", confidence: 1 } } }], w);
  assert.equal(t[0].candidate, false);
});

test("playbook has 12 templates and renders", () => {
  assert.equal(PLAYBOOK.length, 12);
  assert.ok(playbookForPrompt().includes("1."));
  assert.equal(templateName(7), "Merger-arb spread on a friendly cash deal");
  assert.equal(templateName(99), "no template");
});

test("silent jurors do not count as opposition: the candidate bar is half the weight of the jurors who voted", () => {
  const props = [{ id: "A1", plan: plan("AAPL") }, { id: "B1", plan: plan("XOM") }];
  const w = equalWeights(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
  const six = ["m1", "m2", "m3", "m4", "m5", "m6"];
  const ballots = six.map((m, i) => ({ juror: "ABCDEF"[i], model: m, stances: { A1: { stance: "support", confidence: 0.7 }, B1: { stance: i < 2 ? "support" : "oppose", confidence: 0.9 } } }));
  const t = tally(props, ballots as never, w);
  assert.equal(t[0].proposal_id, "A1");
  assert.ok(Math.abs(t[0].score - 4.2) < 1e-9);
  assert.equal(t[0].candidate, true); // 4.2 ≥ 0.5 × 6 voters, not 0.5 × 9 seats
  assert.equal(t[1].proposal_id, "B1");
  assert.equal(t[1].candidate, false); // 2 of 6 at 0.9 = −1.8
});
