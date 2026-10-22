import { describe, expect, it } from "vitest";
import { seedDay } from "../src/core/seed";
import type { Block } from "../src/core/types";

const blocks: Block[] = [
  { id: "b1", label: "Precalculus", location: "Room 4", kind: "class", start_t: "10:00", end_t: "10:55" },
  { id: "b2", label: "Gym", location: "Home", kind: "gym", start_t: "18:00", end_t: "" },
];

describe("seedDay", () => {
  it("adds today's timetable once, in the Card's format", () => {
    const r = seedDay([{ id: "x", time: "09:00", what: "Coffee" }], false, blocks, []);
    expect(r.changed).toBe(true);
    expect(r.blocks_seeded).toBe(true);
    expect(r.items.map((i) => [i.time, i.what, i.src, i.block_id])).toEqual([
      ["09:00", "Coffee", "plan", undefined],
      ["10:00", "Precalculus · Room 4", "block", "b1"],
      ["18:00", "Gym", "block", "b2"],
    ]);
  });
  it("never seeds twice, and never when the timetable read failed", () => {
    expect(seedDay([], true, blocks, []).changed).toBe(false);
    const failed = seedDay([], false, null, []);
    expect([failed.changed, failed.blocks_seeded]).toEqual([false, false]);
  });
  it("skips blocks already on the list", () => {
    const r = seedDay([{ id: "x", time: "10:00", what: "Precalculus", src: "block", block_id: "b1" }], false, blocks, []);
    expect(r.items.map((i) => i.block_id)).toEqual(["b1", "b2"]);
  });
  it("adds deadlines due today that aren't on the list yet", () => {
    const r = seedDay([{ id: "x", time: "", what: "Essay", src: "goal", goal_id: "g1" }], true, [], [
      { id: "g1", title: "Essay" },
      { id: "g2", title: "Lab report" },
    ]);
    expect(r.items.map((i) => i.goal_id)).toEqual(["g1", "g2"]);
    expect(r.changed).toBe(true);
  });
});
