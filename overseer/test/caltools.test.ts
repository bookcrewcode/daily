import { describe, expect, it } from "vitest";
import type { ToolCtx } from "../src/core/dayops";
import { epochOf } from "../src/core/time";
import { confirmPending, runTool, toolSpecs, undoAction } from "../src/core/tools";
import { blankPlan, DEFAULT_SETTINGS, type CalEvent, type CalPort } from "../src/core/types";
import { FakeDb } from "./fakes";

const DAY = "2026-10-15";

class FakeCal implements CalPort {
  events = new Map<string, CalEvent>();
  private n = 0;
  async listDay() { return [...this.events.values()]; }
  async create(title: string, start: string, end: string) {
    const e = { id: `e${++this.n}`, title, start, end };
    this.events.set(e.id, e);
    return e;
  }
  async move(id: string, start: string, end: string) {
    const e = this.events.get(id);
    if (!e) return null;
    const m = { ...e, start, end };
    this.events.set(id, m);
    return m;
  }
  async get(id: string) { return this.events.get(id) ?? null; }
  async remove(id: string) { return this.events.delete(id); }
}

function setup() {
  const db = new FakeDb();
  const cal = new FakeCal();
  const ctx: ToolCtx = { db, cal, s: { ...DEFAULT_SETTINGS }, now: epochOf(DAY, "10:00", DEFAULT_SETTINGS.tz), plan: blankPlan(DAY) };
  let n = 0;
  return { db, cal, ctx, ids: () => `p${++n}`, last: () => [...db.actions.values()].at(-1)! };
}

describe("calendar tools", () => {
  it("creates an event and undo removes it", async () => {
    const { cal, ctx, ids, last } = setup();
    expect((await runTool("calendar_create", { title: "Dentist", day: "today", start: "15:00", end: "16:00" }, ctx, ids)).ok).toBe(true);
    expect([...cal.events.values()]).toEqual([{ id: "e1", title: "Dentist", start: `${DAY}T15:00:00`, end: `${DAY}T16:00:00` }]);
    expect(await undoAction(last(), ctx)).toBe(true);
    expect(cal.events.size).toBe(0);
  });
  it("moves an event and undo moves it back", async () => {
    const { cal, ctx, ids, last } = setup();
    await cal.create("Gym", `${DAY}T18:00:00`, `${DAY}T19:00:00`);
    await runTool("calendar_move", { event_id: "e1", day: "today", start: "17:00", end: "18:00" }, ctx, ids);
    expect(cal.events.get("e1")?.start).toBe(`${DAY}T17:00:00`);
    await undoAction(last(), ctx);
    expect(cal.events.get("e1")?.start).toBe(`${DAY}T18:00:00`);
  });
  it("asks before deleting; Yes deletes; undo puts it back", async () => {
    const { cal, ctx, ids, last } = setup();
    await cal.create("Gym", `${DAY}T18:00:00`, `${DAY}T19:00:00`);
    const r = await runTool("calendar_delete", { event_id: "e1" }, ctx, ids);
    expect(r.pending?.summary).toBe('Delete "Gym" from the calendar');
    expect(cal.events.size).toBe(1);
    await confirmPending(r.pending!, ctx);
    expect(cal.events.size).toBe(0);
    await undoAction(last(), ctx);
    expect([...cal.events.values()].map((e) => e.title)).toEqual(["Gym"]);
  });
  it("rejects an end before the start", async () => {
    const { ctx, ids } = setup();
    expect((await runTool("calendar_create", { title: "x", start: "16:00", end: "15:00" }, ctx, ids)).ok).toBe(false);
  });
  it("offers calendar tools only when Google is connected", async () => {
    expect(toolSpecs(false).map((t) => t.function.name)).not.toContain("calendar_list");
    expect(toolSpecs(true).map((t) => t.function.name)).toEqual(expect.arrayContaining(["calendar_list", "calendar_create", "calendar_move", "calendar_delete"]));
    const { ctx, ids } = setup();
    expect((await runTool("calendar_list", {}, { ...ctx, cal: null }, ids)).text).toBe("Unknown tool calendar_list.");
  });
});
