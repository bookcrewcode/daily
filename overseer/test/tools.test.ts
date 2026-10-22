import { describe, expect, it } from "vitest";
import type { ToolCtx } from "../src/core/dayops";
import { epochOf } from "../src/core/time";
import { confirmPending, parseSetting, runTool, toolSpecs, undoAction } from "../src/core/tools";
import { blankPlan, DEFAULT_SETTINGS } from "../src/core/types";
import { FakeDb } from "./fakes";

const DAY = "2026-10-15";
const TOMORROW = "2026-10-16";

function setup(hhmm = "10:00") {
  const db = new FakeDb();
  db.nights.set(DAY, {
    items: [
      { id: "i1", time: "11:30", what: "Precalc HW", src: "block", block_id: "b1" },
      { id: "i2", time: "", what: "Finish essay", src: "goal", goal_id: "g1" },
    ],
    blocks_seeded: true,
    top3: ["Old one"],
  });
  db.goalList = [{ id: "g1", title: "Finish essay", due: DAY, status: "active", steps: [{ id: "s1", title: "Outline", done: false }] }];
  const ctx: ToolCtx = {
    db, cal: null, s: { ...DEFAULT_SETTINGS }, now: epochOf(DAY, hhmm, DEFAULT_SETTINGS.tz),
    plan: { ...blankPlan(DAY), items: db.items(DAY), blocks: [{ id: "b1", label: "Precalc HW", location: "", kind: "study", start_t: "11:30", end_t: "13:00" }] },
  };
  let n = 0;
  const ids = () => `p${++n}`;
  const last = () => [...db.actions.values()].at(-1)!;
  return { db, ctx, ids, last };
}

describe("day-list tools", () => {
  it("add_item adds to the list, mirrors the score counts, and undo removes it", async () => {
    const { db, ctx, ids, last } = setup();
    expect((await runTool("add_item", { what: "Call dentist", time: "16:00" }, ctx, ids)).ok).toBe(true);
    expect(db.items(DAY).map((i) => [i.time, i.what])).toEqual([["11:30", "Precalc HW"], ["16:00", "Call dentist"], ["", "Finish essay"]]);
    expect(db.game.get(DAY)).toEqual({ done: 0, total: 3 });
    expect(ctx.plan.items).toHaveLength(3);
    expect(await undoAction(last(), ctx)).toBe(true);
    expect(db.items(DAY).map((i) => i.what)).toEqual(["Precalc HW", "Finish essay"]);
  });
  it("check_item stamps the tap time, closes a deadline's goal, and undo reopens both", async () => {
    const { db, ctx, ids, last } = setup();
    await runTool("check_item", { item_id: "i2", done: true }, ctx, ids);
    const it = db.items(DAY).find((i) => i.id === "i2")!;
    expect([it.done, it.at]).toEqual([true, 10 * 3600]);
    expect(db.goalList[0].status).toBe("done");
    await undoAction(last(), ctx);
    expect(db.items(DAY).find((i) => i.id === "i2")?.done).toBe(false);
    expect(db.goalList[0].status).toBe("active");
  });
  it("move_item to tomorrow takes it off today as a plain untimed item, and undo brings it back", async () => {
    const { db, ctx, ids, last } = setup();
    await runTool("move_item", { item_id: "i1", to_day: "tomorrow", time: "" }, ctx, ids);
    expect(db.items(DAY).map((i) => i.id)).toEqual(["i2"]);
    const moved = db.items(TOMORROW)[0];
    expect([moved.what, moved.time, moved.src, moved.block_id]).toEqual(["Precalc HW", "", "plan", undefined]);
    await undoAction(last(), ctx);
    expect(db.items(DAY).map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(db.items(TOMORROW)).toEqual([]);
  });
  it("edit_item changes text and time, and undo restores them", async () => {
    const { db, ctx, ids, last } = setup();
    await runTool("edit_item", { item_id: "i1", what: "Precalc HW set 4", time: "12:00" }, ctx, ids);
    expect(db.items(DAY)[0]).toMatchObject({ what: "Precalc HW set 4", time: "12:00" });
    await undoAction(last(), ctx);
    expect(db.items(DAY)[0]).toMatchObject({ what: "Precalc HW", time: "11:30" });
  });
  it("remove_item only asks; Yes removes; undo restores", async () => {
    const { db, ctx, ids, last } = setup();
    const r = await runTool("remove_item", { item_id: "i1" }, ctx, ids);
    expect(r.pending).toEqual({ id: "p1", tool: "remove_item", args: { day: DAY, item_id: "i1" }, summary: `Remove "Precalc HW" from ${DAY}` });
    expect(db.items(DAY)).toHaveLength(2);
    expect((await confirmPending(r.pending!, ctx)).text).toBe('Removed "Precalc HW".');
    expect(db.items(DAY).map((i) => i.id)).toEqual(["i2"]);
    await undoAction(last(), ctx);
    expect(db.items(DAY).map((i) => i.id)).toEqual(["i1", "i2"]);
  });
  it("set_top3 sets a day's priorities and undo restores the old ones", async () => {
    const { db, ctx, ids, last } = setup();
    await runTool("set_top3", { day: "tomorrow", items: ["Essay", "Gym", "Call mom", "extra"] }, ctx, ids);
    expect(db.nights.get(TOMORROW)?.top3).toEqual(["Essay", "Gym", "Call mom"]);
    await runTool("set_top3", { items: ["New"] }, ctx, ids);
    expect(ctx.plan.top3).toEqual(["New"]);
    await undoAction(last(), ctx);
    expect(db.nights.get(DAY)?.top3).toEqual(["Old one"]);
  });
  it("never writes when the list can't be read", async () => {
    const { db, ctx, ids } = setup();
    db.failDay = true;
    const before = JSON.stringify(db.nights.get(DAY));
    expect((await runTool("add_item", { what: "x" }, ctx, ids)).text).toBe("Couldn't read the list right now. Nothing changed.");
    expect(JSON.stringify(db.nights.get(DAY))).toBe(before);
  });
});

describe("other tools", () => {
  it("add_capture, add_step, check_step and report_habit all undo", async () => {
    const { db, ctx, ids, last } = setup();
    await runTool("add_capture", { text: "Buy stamps" }, ctx, ids);
    expect([...db.captureRows.values()].map((c) => c.text)).toEqual(["Buy stamps"]);
    await undoAction(last(), ctx);
    expect(db.captureRows.size).toBe(0);
    await runTool("add_step", { goal_id: "g1", title: "Draft intro" }, ctx, ids);
    expect(db.goalList[0].steps.map((s) => s.title)).toEqual(["Outline", "Draft intro"]);
    await undoAction(last(), ctx);
    expect(db.goalList[0].steps.map((s) => s.title)).toEqual(["Outline"]);
    await runTool("check_step", { step_id: "s1", done: true }, ctx, ids);
    expect(db.goalList[0].steps[0].done).toBe(true);
    await undoAction(last(), ctx);
    expect(db.goalList[0].steps[0].done).toBe(false);
    await runTool("report_habit", { key: "ws_meds" }, ctx, ids);
    expect(db.habitRows.get(DAY)).toEqual({ ws_meds: true });
    await undoAction(last(), ctx);
    expect(db.habitRows.get(DAY)).toEqual({ ws_meds: false });
    expect((await runTool("report_habit", { key: "ws_fly" }, ctx, ids)).ok).toBe(false);
  });
  it("processes inbox notes, with undo", async () => {
    const { db, ctx, ids, last } = setup();
    const id = (await db.addCapture("Email the professor"))!;
    expect((await runTool("list_captures", {}, ctx, ids)).text).toBe(`${id} | Email the professor`);
    await runTool("capture_done", { capture_id: id }, ctx, ids);
    expect((await runTool("list_captures", {}, ctx, ids)).text).toBe("Inbox is empty.");
    await undoAction(last(), ctx);
    expect(db.captureRows.get(id)?.done).toBe(false);
  });
  it("set_stakes asks first, works before the first block, and is refused after", async () => {
    const early = setup("10:00");
    const r = await runTool("set_stakes", { item_ids: ["i1", "nope"] }, early.ctx, early.ids);
    expect(r.pending?.summary).toBe('Put stakes on "Precalc HW"');
    expect(early.ctx.plan.stakes).toEqual([]);
    await confirmPending(r.pending!, early.ctx);
    expect([early.ctx.plan.stakes, early.ctx.plan.locked, early.ctx.plan.stakes_off]).toEqual([["i1"], true, false]);
    await undoAction(early.last(), early.ctx);
    expect(early.ctx.plan.stakes).toEqual([]);
    expect((await runTool("set_stakes", { item_ids: ["nope"] }, early.ctx, early.ids)).ok).toBe(false);
    const late = setup("11:31");
    expect((await runTool("set_stakes", { item_ids: ["i1"] }, late.ctx, late.ids)).text).toBe("Too late to change stakes today.");
  });
  it("change_setting asks first, applies on Yes, and undo puts it back", async () => {
    const { db, ctx, ids, last } = setup();
    const r = await runTool("change_setting", { key: "ping_every_min", value: "30" }, ctx, ids);
    expect(r.pending?.summary).toBe("Change ping_every_min to 30");
    expect(db.set.ping_every_min).toBe(40);
    await confirmPending(r.pending!, ctx);
    expect(db.set.ping_every_min).toBe(30);
    await undoAction(last(), ctx);
    expect(db.set.ping_every_min).toBe(40);
  });
  it("validates settings", () => {
    expect(parseSetting("wake", "7:30")).toEqual({ ok: false, error: "Use HH:MM." });
    expect(parseSetting("wake", "07:30")).toEqual({ ok: true, value: "07:30" });
    expect(parseSetting("ping_every_min", "5").ok).toBe(false);
    expect(parseSetting("cap_usd", "").ok).toBe(false);
    expect(parseSetting("cap_usd", "2.5")).toEqual({ ok: true, value: 2.5 });
    expect(parseSetting("ping_kinds", "study, Work")).toEqual({ ok: true, value: ["study", "work"] });
    expect(parseSetting("chat_id", "1").ok).toBe(false);
  });
  it("fails softly on unknown tools", async () => {
    const { ctx, ids } = setup();
    expect(await runTool("format_disk", {}, ctx, ids)).toEqual({ ok: false, text: "Unknown tool format_disk." });
  });
  it("offers exactly the item tools when the calendar is not connected", () => {
    expect(toolSpecs(false).map((t) => t.function.name)).toEqual([
      "list_day", "add_item", "check_item", "edit_item", "move_item", "remove_item", "set_top3",
      "add_capture", "list_captures", "capture_done", "list_goals", "add_step", "check_step", "report_habit", "set_stakes", "change_setting",
    ]);
  });
});
