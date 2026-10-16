import { describe, expect, it } from "vitest";
import { onAnswer, onTick, startTask } from "../src/core/ladder";
import { EMPTY_LADDER } from "../src/core/types";

const MIN = 60_000;
const T0 = 1_800_000_000_000;

describe("ladder", () => {
  it("counts the block-start message as the first check-in", () => {
    expect(startTask("w1", "a", T0)).toEqual({ win: "w1", task: "a", step: 0, awaiting: true, next_at: T0 + 20 * MIN });
  });
  it("walks the silence ladder: 20 min, 10, shrink after 10, escalate after 10", () => {
    let l = startTask("w1", "a", T0);
    expect(onTick(l, T0 + 19 * MIN, 40).effect).toEqual({ kind: "none" });
    let r = onTick(l, T0 + 20 * MIN, 40);
    expect(r.effect).toEqual({ kind: "ping", step: 1 });
    l = r.ladder;
    r = onTick(l, T0 + 30 * MIN, 40);
    expect(r.effect).toEqual({ kind: "ping", step: 2 });
    l = r.ladder;
    r = onTick(l, T0 + 40 * MIN, 40);
    expect(r.effect).toEqual({ kind: "shrink" });
    l = r.ladder;
    r = onTick(l, T0 + 50 * MIN, 40);
    expect(r.effect).toEqual({ kind: "escalate" });
    expect(r.ladder.next_at).toBeNull();
    expect(onTick(r.ladder, T0 + 90 * MIN, 40).effect).toEqual({ kind: "none" });
  });
  it("after an answer, the next check-in is a regular one that restarts the ladder", () => {
    const l = onAnswer(startTask("w1", "a", T0), T0 + 5 * MIN, 40, "message");
    expect([l.awaiting, l.step, l.next_at]).toEqual([false, 0, T0 + 45 * MIN]);
    const r = onTick(l, T0 + 45 * MIN, 40);
    expect(r.effect).toEqual({ kind: "ping", step: 0 });
    expect(r.ladder).toMatchObject({ awaiting: true, step: 0, next_at: T0 + 65 * MIN });
  });
  it("10 more min and Stuck bring the next check-in to ten minutes", () => {
    expect(onAnswer(startTask("w1", "a", T0), T0, 40, "more").next_at).toBe(T0 + 10 * MIN);
    expect(onAnswer(startTask("w1", "a", T0), T0, 40, "stuck").next_at).toBe(T0 + 10 * MIN);
  });
  it("an idle ladder never fires", () => {
    expect(onTick(EMPTY_LADDER, T0, 40).effect).toEqual({ kind: "none" });
  });
});
