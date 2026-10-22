// Edits to the shared day list (nights.items). Every edit reads the list
// fresh, writes it sorted, mirrors the score counts, and logs an action with
// what it was before and after, which is what Undo replays.
import { countDone, newItemId, normalizeItems, sortItems, type DayItem } from "../../../src/lib/theGame";
import type { Db } from "./db";
import { isHhmm, secOfDayIn } from "./time";
import type { CalPort, Pending, Plan, Settings } from "./types";

export type ToolCtx = { db: Db; cal: CalPort | null; s: Settings; now: number; plan: Plan };
export type ToolOutcome = { ok: boolean; text: string; action_id?: string | null; pending?: Pending };

export const READ_FAIL: ToolOutcome = { ok: false, text: "Couldn't read the list right now. Nothing changed." };
export const WRITE_FAIL: ToolOutcome = { ok: false, text: "Couldn't save the change. Nothing changed." };
const notFound = (id: string, day: string): ToolOutcome => ({ ok: false, text: `No item ${id} on ${day}.` });

type ItemRef = { day: string; item: DayItem };

const replace = (items: DayItem[], it: DayItem) => (items.some((x) => x.id === it.id) ? items.map((x) => (x.id === it.id ? it : x)) : [...items, it]);
const without = (items: DayItem[], id: string) => items.filter((x) => x.id !== id);

export async function loadDay(ctx: ToolCtx, day: string): Promise<DayItem[] | null> {
  const row = await ctx.db.day(day);
  if (row === null) return null;
  return row === "none" ? [] : normalizeItems(row.items);
}

export async function writeDay(ctx: ToolCtx, day: string, items: DayItem[]): Promise<boolean> {
  const sorted = sortItems(items);
  if (!(await ctx.db.saveItems(day, sorted))) return false;
  await ctx.db.mirrorCounts(day, countDone(sorted), sorted.length);
  if (ctx.plan.day === day) ctx.plan = { ...ctx.plan, items: sorted };
  return true;
}

export async function addItem(ctx: ToolCtx, day: string, what: string, time: string): Promise<ToolOutcome> {
  const text = what.trim().slice(0, 200);
  if (!text) return { ok: false, text: "Nothing to add." };
  const items = await loadDay(ctx, day);
  if (!items) return READ_FAIL;
  const it: DayItem = { id: newItemId(), time: isHhmm(time) ? time : "", what: text, done: false, src: "plan" };
  if (!(await writeDay(ctx, day, [...items, it]))) return WRITE_FAIL;
  const action_id = await ctx.db.logAction({ tool: "add_item", summary: `Added "${text}"${it.time ? ` at ${it.time}` : ""} (${day})`, before: null, after: { day, item: it } });
  return { ok: true, text: `Added "${text}" (id ${it.id}).`, action_id };
}

export async function checkItem(ctx: ToolCtx, day: string, id: string, done: boolean): Promise<ToolOutcome> {
  const items = await loadDay(ctx, day);
  if (!items) return READ_FAIL;
  const it = items.find((x) => x.id === id);
  if (!it) return notFound(id, day);
  const next: DayItem = { ...it, done, at: done ? secOfDayIn(ctx.now, ctx.s.tz) : undefined };
  if (!(await writeDay(ctx, day, replace(items, next)))) return WRITE_FAIL;
  if (it.goal_id) await ctx.db.setGoalDone(it.goal_id, done);
  const action_id = await ctx.db.logAction({ tool: "check_item", summary: `${done ? "Checked off" : "Reopened"} "${it.what}"`, before: { day, item: it }, after: { day, item: next } });
  return { ok: true, text: `${done ? "Done" : "Reopened"}: ${it.what}.`, action_id };
}

export async function editItem(ctx: ToolCtx, day: string, id: string, patch: { what?: string; time?: string }): Promise<ToolOutcome> {
  const items = await loadDay(ctx, day);
  if (!items) return READ_FAIL;
  const it = items.find((x) => x.id === id);
  if (!it) return notFound(id, day);
  const what = patch.what !== undefined ? patch.what.trim().slice(0, 200) : it.what;
  if (!what) return { ok: false, text: "The item needs some text." };
  const time = patch.time === undefined ? it.time : patch.time === "" ? "" : isHhmm(patch.time) ? patch.time : it.time;
  const next: DayItem = { ...it, what, time };
  if (!(await writeDay(ctx, day, replace(items, next)))) return WRITE_FAIL;
  const action_id = await ctx.db.logAction({ tool: "edit_item", summary: `Changed "${it.what}"`, before: { day, item: it }, after: { day, item: next } });
  return { ok: true, text: `Updated: ${what}${time ? ` at ${time}` : ""}.`, action_id };
}

// time: "" makes it untimed, "HH:MM" sets it, anything else keeps it.
export async function moveItem(ctx: ToolCtx, fromDay: string, id: string, toDay: string, time: string): Promise<ToolOutcome> {
  const items = await loadDay(ctx, fromDay);
  if (!items) return READ_FAIL;
  const it = items.find((x) => x.id === id);
  if (!it) return notFound(id, fromDay);
  const moved: DayItem = { ...it, time: time === "" ? "" : isHhmm(time) ? time : it.time, done: false, at: undefined };
  if (toDay === fromDay) {
    if (!(await writeDay(ctx, fromDay, replace(items, moved)))) return WRITE_FAIL;
    const action_id = await ctx.db.logAction({ tool: "move_item", summary: `Moved "${it.what}"${moved.time ? ` to ${moved.time}` : " to later today"}`, before: { day: fromDay, item: it }, after: { day: toDay, item: moved } });
    return { ok: true, text: `Moved "${it.what}".`, action_id };
  }
  const target = await loadDay(ctx, toDay);
  if (!target) return READ_FAIL;
  const { block_id: _block, ...rest } = moved;
  const copy: DayItem = { ...rest, id: newItemId(), src: "plan" };
  if (!(await writeDay(ctx, toDay, [...target, copy]))) return WRITE_FAIL;
  if (!(await writeDay(ctx, fromDay, without(items, id)))) {
    await writeDay(ctx, toDay, target);
    return WRITE_FAIL;
  }
  const action_id = await ctx.db.logAction({ tool: "move_item", summary: `Moved "${it.what}" to ${toDay}`, before: { day: fromDay, item: it }, after: { day: toDay, item: copy } });
  return { ok: true, text: `Moved "${it.what}" to ${toDay}.`, action_id };
}

export async function removeItem(ctx: ToolCtx, day: string, id: string): Promise<ToolOutcome> {
  const items = await loadDay(ctx, day);
  if (!items) return READ_FAIL;
  const index = items.findIndex((x) => x.id === id);
  if (index < 0) return notFound(id, day);
  const it = items[index];
  if (!(await writeDay(ctx, day, without(items, id)))) return WRITE_FAIL;
  const action_id = await ctx.db.logAction({ tool: "remove_item", summary: `Removed "${it.what}" (${day})`, before: { day, item: it, index }, after: null });
  return { ok: true, text: `Removed "${it.what}".`, action_id };
}

export async function setTop3(ctx: ToolCtx, day: string, top3: string[]): Promise<ToolOutcome> {
  const row = await ctx.db.day(day);
  if (row === null) return READ_FAIL;
  const before = row === "none" ? [] : row.top3;
  const clean = top3.map((t) => t.trim().slice(0, 200)).filter(Boolean).slice(0, 3);
  if (!(await ctx.db.setTop3(day, clean))) return WRITE_FAIL;
  if (ctx.plan.day === day) ctx.plan = { ...ctx.plan, top3: clean };
  const action_id = await ctx.db.logAction({ tool: "set_top3", summary: `Top 3 for ${day}: ${clean.join("; ")}`, before: { day, top3: before }, after: { day, top3: clean } });
  return { ok: true, text: `Top 3 set for ${day}.`, action_id };
}

export async function undoItem(tool: string, before: unknown, after: unknown, ctx: ToolCtx): Promise<boolean> {
  const b = before as (ItemRef & { index?: number; top3?: string[] }) | null;
  const a = after as ItemRef | null;
  if (tool === "set_top3") return !!b && ctx.db.setTop3(b.day, b.top3 ?? []);
  if (tool === "add_item" && a) {
    const items = await loadDay(ctx, a.day);
    return !!items && writeDay(ctx, a.day, without(items, a.item.id));
  }
  if ((tool === "check_item" || tool === "edit_item") && b) {
    const items = await loadDay(ctx, b.day);
    if (!items || !(await writeDay(ctx, b.day, replace(items, b.item)))) return false;
    if (tool === "check_item" && b.item.goal_id) await ctx.db.setGoalDone(b.item.goal_id, !!b.item.done);
    return true;
  }
  if (tool === "move_item" && a && b) {
    if (a.day !== b.day) {
      const t = await loadDay(ctx, a.day);
      if (!t || !(await writeDay(ctx, a.day, without(t, a.item.id)))) return false;
    }
    const f = await loadDay(ctx, b.day);
    return !!f && writeDay(ctx, b.day, replace(f, b.item));
  }
  if (tool === "remove_item" && b) {
    const f = await loadDay(ctx, b.day);
    if (!f) return false;
    const next = [...f];
    next.splice(Math.min(b.index ?? next.length, next.length), 0, b.item);
    return writeDay(ctx, b.day, next);
  }
  return false;
}
