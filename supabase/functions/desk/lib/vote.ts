// The Desk — the deterministic tally. Pure. The jurors argue; code counts.
import type { Plan } from "./types.ts";
import { calibratedConfidence, type CalibBin } from "./stats.ts";

export type Ballot = { juror: string; model: string; stances: Record<string, { stance: "support" | "oppose" | "abstain"; confidence: number }> };
export type Weight = { model: string; weight: number; calib: CalibBin[] };
export type Tally = { proposal_id: string; score: number; voters: number; support: number; oppose: number; candidate: boolean; rr: number };

export function equalWeights(models: string[]): Weight[] {
  return models.map((m) => ({ model: m, weight: 1, calib: [] }));
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5);

export function tally(proposals: { id: string; plan: Plan }[], ballots: Ballot[], weights: Weight[], minVoters = 3): Tally[] {
  const w = new Map(weights.map((x) => [x.model, x]));
  const totalW = weights.reduce((a, x) => a + x.weight, 0);
  const out: Tally[] = proposals.map(({ id, plan }) => {
    let score = 0, voters = 0, support = 0, oppose = 0;
    for (const b of ballots) {
      const st = b.stances?.[id];
      if (!st) continue;
      voters++;
      const wt = w.get(b.model);
      const weight = wt?.weight ?? 1;
      const conf = calibratedConfidence(clamp01(st.confidence), wt?.calib ?? []);
      if (st.stance === "support") { score += conf * weight; support++; }
      else if (st.stance === "oppose") { score -= conf * weight; oppose++; }
    }
    const dist = Math.abs(plan.entry_ref - plan.stop);
    const rr = dist > 0 ? Math.abs(plan.target - plan.entry_ref) / dist : 0;
    return { proposal_id: id, score, voters, support, oppose, candidate: score >= 0.5 * totalW && voters >= minVoters, rr };
  });
  return out.sort((a, b) => b.score - a.score || b.rr - a.rr);
}
