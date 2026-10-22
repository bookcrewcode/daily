import { describe, expect, it } from "vitest";
import { rebase, type DayItem } from "../../src/lib/theGame";

describe("Card saves on top of the freshest list", () => {
  const stale: DayItem[] = [
    { id: "a", time: "11:30", what: "Precalc HW", done: false },
    { id: "b", time: "18:00", what: "Gym", done: false },
  ];
  it("keeps a Done that arrived from Telegram while the Card was open", () => {
    const fresh = [{ id: "a", time: "11:30", what: "Precalc HW", done: true, at: 41000 }, { id: "b", time: "18:00", what: "Gym" }];
    const next = rebase(fresh, stale, (items) => items.map((x) => (x.id === "b" ? { ...x, done: true } : x)));
    expect(next.map((x) => [x.id, x.done])).toEqual([["a", true], ["b", true]]);
  });
  it("does not bring back an item the Overseer moved away", () => {
    const fresh = [{ id: "b", time: "18:00", what: "Gym" }];
    expect(rebase(fresh, stale, (items) => items).map((x) => x.id)).toEqual(["b"]);
  });
  it("falls back to what the Card has when the fresh read failed", () => {
    expect(rebase(null, stale, (items) => items.filter((x) => x.id !== "a")).map((x) => x.id)).toEqual(["b"]);
  });
});
