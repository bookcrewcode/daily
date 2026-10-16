// The silence ladder (spec section 2). A message that wants an answer sets
// `awaiting`. Silence then means: ping again after 20 min, again after 10,
// shrink the task after 10 more, and after a final 10 escalate (stakes
// countdown or move the task). Any tap or message resets it.
import type { Ladder } from "./types";

const MIN = 60_000;

export type LadderEffect = { kind: "none" } | { kind: "ping"; step: 0 | 1 | 2 } | { kind: "shrink" } | { kind: "escalate" };

export function startTask(win: string, task: string, now: number): Ladder {
  return { win, task, step: 0, awaiting: true, next_at: now + 20 * MIN };
}

export function onTick(l: Ladder, now: number, everyMin: number): { ladder: Ladder; effect: LadderEffect } {
  if (!l.task || l.next_at === null || now < l.next_at) return { ladder: l, effect: { kind: "none" } };
  if (!l.awaiting) return { ladder: { ...l, awaiting: true, step: 0, next_at: now + 20 * MIN }, effect: { kind: "ping", step: 0 } };
  if (l.step === 0) return { ladder: { ...l, step: 1, next_at: now + 10 * MIN }, effect: { kind: "ping", step: 1 } };
  if (l.step === 1) return { ladder: { ...l, step: 2, next_at: now + 10 * MIN }, effect: { kind: "ping", step: 2 } };
  if (l.step === 2) return { ladder: { ...l, step: 3, next_at: now + 10 * MIN }, effect: { kind: "shrink" } };
  void everyMin;
  return { ladder: { ...l, step: 4, next_at: null }, effect: { kind: "escalate" } };
}

export function onAnswer(l: Ladder, now: number, everyMin: number, kind: "more" | "stuck" | "message"): Ladder {
  const wait = kind === "message" ? everyMin : 10;
  return { ...l, step: 0, awaiting: false, next_at: now + wait * MIN };
}
