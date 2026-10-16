import { describe, expect, it } from "vitest";
import { buildWindows, durationOf, firstWindowStart, floatingOf, nextWindowAfter, taskFor, windowAt } from "../src/core/agenda";
import { epochOf } from "../src/core/time";
import { blankPlan, DEFAULT_SETTINGS, type Block, type DayItem, type Settings } from "../src/core/types";

const S: Settings = { ...DEFAULT_SETTINGS };
const DAY = "2026-10-15";
const t = (hhmm: string) => epochOf(DAY, hhmm, S.tz);

const blocks: Block[] = [
  { id: "b1", label: "Precalc HW", location: "", kind: "study", start_t: "11:30", end_t: "13:00" },
  { id: "b2", label: "Precalculus", location: "Room 4", kind: "class", start_t: "10:00", end_t: "10:55" },
  { id: "b3", label: "Gym", location: "", kind: "gym", start_t: "18:00", end_t: "19:30" },
  { id: "b4", label: "Reading drill", location: "", kind: "drill", start_t: "13:00", end_t: "13:15" },
];
const items: DayItem[] = [
  { id: "a", time: "11:30", what: "Precalc HW", src: "block", block_id: "b1" },
  { id: "b", time: "10:00", what: "Precalculus · Room 4", src: "block", block_id: "b2" },
  { id: "c", time: "18:00", what: "Gym", src: "block", block_id: "b3" },
  { id: "d", time: "19:45", what: "LOCK-IN: Test review 1.5h", src: "plan" },
  { id: "e", time: "", what: "Email professor", src: "card" },
  { id: "f", time: "", what: "Finish essay", src: "goal", goal_id: "g1" },
  { id: "g", time: "13:00", what: "Reading drill", src: "block", block_id: "b4", done: true },
];

describe("agenda", () => {
  it("makes windows only for drill kinds, keeping finished ones so queued tasks can fill them", () => {
    expect(buildWindows(DAY, items, blocks, S).map((w) => [w.own, w.kind, w.start, w.end])).toEqual([
      ["a", "study", t("11:30"), t("13:00")],
      ["g", "drill", t("13:00"), t("13:15")],
      ["d", "study", t("19:45"), t("21:15")],
    ]);
  });
  it("keeps a moved block's length", () => {
    const moved = items.map((i) => (i.id === "a" ? { ...i, time: "14:00" } : i));
    const w = buildWindows(DAY, moved, blocks, S).find((x) => x.own === "a")!;
    expect([w.start, w.end]).toEqual([t("14:00"), t("15:30")]);
  });
  it("reads a duration from the item text", () => {
    expect(durationOf("LOCK-IN: review 1.5h")).toBe(90);
    expect(durationOf("Read 40 min")).toBe(40);
    expect(durationOf("Read")).toBe(60);
  });
  it("orders untimed open tasks: moved-later first, then top 3, then the rest", () => {
    expect(floatingOf(items, ["Finish essay"])).toEqual(["f", "e"]);
    expect(floatingOf(items, ["Finish essay"], ["e"])).toEqual(["e", "f"]);
  });
  it("finds the window at a moment and the task for it", () => {
    const w = buildWindows(DAY, items, blocks, S);
    expect(windowAt(w, t("12:00"))?.own).toBe("a");
    expect(windowAt(w, t("13:00"))?.own).toBe("g");
    expect(windowAt(w, t("17:00"))).toBeNull();
    expect(taskFor(windowAt(w, t("12:00"))!, items, ["f", "e"])?.id).toBe("a");
    expect(taskFor(windowAt(w, t("13:05"))!, items, ["f", "e"])?.id).toBe("f");
    expect(nextWindowAfter(w, t("13:20"))?.own).toBe("d");
  });
  it("gives the first block's start for the stakes cut-off", () => {
    expect(firstWindowStart({ ...blankPlan(DAY), items, blocks }, S)).toBe(t("11:30"));
    expect(firstWindowStart(blankPlan(DAY), S)).toBeNull();
  });
});
