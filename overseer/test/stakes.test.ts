import { describe, expect, it } from "vitest";
import { canStake, pickLine, pickPartner, stakesOffAllowed } from "../src/core/stakes";
import { blankPlan, type Line, type Partner } from "../src/core/types";

const DAY = "2026-10-15";
const plan = { ...blankPlan(DAY), stakes: ["a"] };
const lines: Line[] = [{ id: "l2", text: "two", used: 1 }, { id: "l1", text: "one", used: 0 }];
const partners: Partner[] = [
  { id: "p1", name: "Gavin", chat_id: 222, joined_at: "x", left_at: null, sent: 3 },
  { id: "p2", name: "Maya", chat_id: 333, joined_at: "x", left_at: null, sent: 1 },
  { id: "p3", name: "Left", chat_id: 444, joined_at: "x", left_at: "y", sent: 0 },
  { id: "p4", name: "Pending", chat_id: null, joined_at: null, left_at: null, sent: 0 },
];
const base = { plan, itemId: "a", day: DAY, sentDay: null, lines, partners };

describe("stakes", () => {
  it("only on a confirmed task, once a day, with a line and a joined partner", () => {
    expect(canStake(base)).toBe(true);
    expect(canStake({ ...base, itemId: "b" })).toBe(false);
    expect(canStake({ ...base, plan: { ...plan, stakes_off: true } })).toBe(false);
    expect(canStake({ ...base, sentDay: DAY })).toBe(false);
    expect(canStake({ ...base, lines: [] })).toBe(false);
    expect(canStake({ ...base, partners: partners.slice(2) })).toBe(false);
  });
  it("picks the least-used line and the partner sent to least", () => {
    expect(pickLine(lines)?.id).toBe("l1");
    expect(pickPartner(partners)?.name).toBe("Maya");
    expect(pickPartner(partners.slice(2))).toBeNull();
    expect(pickLine([])).toBeNull();
  });
  it("allows turning stakes off only before the first block starts", () => {
    expect(stakesOffAllowed(1000, 999)).toBe(true);
    expect(stakesOffAllowed(1000, 1000)).toBe(false);
    expect(stakesOffAllowed(null, 5)).toBe(true);
  });
});
