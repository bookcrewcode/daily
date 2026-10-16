// The model's tool list. Each tool acts on Ben's own data and logs an action
// with Undo. Removing anything and changing the Overseer's own rules return a
// pending request instead: Ben's Yes tap runs confirmPending().
import { firstWindowStart } from "./agenda";
import { addItem, checkItem, editItem, loadDay, moveItem, READ_FAIL, removeItem, setTop3, undoItem, WRITE_FAIL, type ToolCtx, type ToolOutcome } from "./dayops";
import type { SettingsRow } from "./db";
import type { ToolSpec } from "./llm";
import { CAL_HANDLERS } from "./caltools";
import { stakesOffAllowed } from "./stakes";
import { isHhmm } from "./time";
import { dayArg, dayOf, fn, S, str, type Handler } from "./toolkit";
import type { ActionRow, DayItem, Pending } from "./types";

// Same keys as WIN_KEYS in src/lib/supabase.ts (not imported: that file pulls in the browser client).
export const HABIT_KEYS = ["ws_meds", "ws_eat", "ws_lift", "ws_stretch", "ws_vocab", "ws_chinese", "ws_work", "ws_water", "ws_sleep", "ws_school", "ws_affirmations"];
const SETTING_KEYS = ["wake", "wrap", "ping_every_min", "ping_kinds", "cap_usd", "dry_run", "cheap_model", "smart_model"];

export function parseSetting(key: string, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (key) {
    case "wake":
    case "wrap":
      return isHhmm(raw) ? { ok: true, value: raw } : { ok: false, error: "Use HH:MM." };
    case "ping_every_min": {
      const n = Number(raw);
      return raw !== "" && Number.isInteger(n) && n >= 10 && n <= 120 ? { ok: true, value: n } : { ok: false, error: "Between 10 and 120 minutes." };
    }
    case "cap_usd": {
      const n = Number(raw);
      return raw !== "" && n >= 0 && n <= 5 ? { ok: true, value: n } : { ok: false, error: "Between 0 and 5 dollars." };
    }
    case "ping_kinds": {
      const k = raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      return k.length ? { ok: true, value: k } : { ok: false, error: "List at least one block kind." };
    }
    case "dry_run":
      return raw === "true" || raw === "false" ? { ok: true, value: raw === "true" } : { ok: false, error: "true or false." };
    case "cheap_model":
    case "smart_model":
      return /^[a-z0-9-]+\/[a-z0-9.:-]+$/i.test(raw) ? { ok: true, value: raw } : { ok: false, error: "Use an OpenRouter model id like provider/model." };
    default:
      return { ok: false, error: `Unknown setting ${key}.` };
  }
}

const undoVia = (a: ActionRow, ctx: ToolCtx) => undoItem(a.tool, a.before, a.after, ctx);
const listLine = (i: { id: string; time: string; done?: boolean; what: string }) => `${i.id} | ${i.time || "--:--"} | ${i.done ? "done" : "open"} | ${i.what}`;

const ITEM_HANDLERS: Record<string, Handler> = {
  list_day: {
    spec: fn("list_day", "Read a day's list with item ids.", { day: dayArg }),
    run: async (a, ctx) => {
      const items = await loadDay(ctx, dayOf(a.day, ctx));
      return items ? { ok: true, text: items.length ? items.map(listLine).join("\n") : "Empty." } : READ_FAIL;
    },
  },
  add_item: {
    spec: fn("add_item", "Add an item to a day's list.", { what: S, time: { type: "string", description: "HH:MM, or empty for untimed" }, day: dayArg }, ["what"]),
    run: (a, ctx) => addItem(ctx, dayOf(a.day, ctx), str(a.what), str(a.time)),
    undo: undoVia,
  },
  check_item: {
    spec: fn("check_item", "Mark an item done or not done.", { item_id: S, done: { type: "boolean" }, day: dayArg }, ["item_id", "done"]),
    run: (a, ctx) => checkItem(ctx, dayOf(a.day, ctx), str(a.item_id), a.done !== false),
    undo: undoVia,
  },
  edit_item: {
    spec: fn("edit_item", "Change an item's text or time (time empty = untimed).", { item_id: S, what: S, time: S, day: dayArg }, ["item_id"]),
    run: (a, ctx) => editItem(ctx, dayOf(a.day, ctx), str(a.item_id), {
      what: typeof a.what === "string" ? a.what : undefined,
      time: typeof a.time === "string" ? a.time.trim() : undefined,
    }),
    undo: undoVia,
  },
  move_item: {
    spec: fn("move_item", "Move an item to another day and/or time. time empty = untimed.", { item_id: S, from_day: dayArg, to_day: dayArg, time: S }, ["item_id", "to_day"]),
    run: (a, ctx) => moveItem(ctx, dayOf(a.from_day, ctx), str(a.item_id), dayOf(a.to_day, ctx), str(a.time)),
    undo: undoVia,
  },
  remove_item: {
    spec: fn("remove_item", "Remove an item from a day's list. Ben must confirm; this only asks.", { item_id: S, day: dayArg }, ["item_id"]),
    run: async (a, ctx, ids) => {
      const day = dayOf(a.day, ctx);
      const items = await loadDay(ctx, day);
      if (!items) return READ_FAIL;
      const it = items.find((i) => i.id === str(a.item_id));
      if (!it) return { ok: false, text: `No item ${str(a.item_id)} on ${day}.` };
      return { ok: true, text: "Asked Ben to confirm the removal.", pending: { id: ids(), tool: "remove_item", args: { day, item_id: it.id }, summary: `Remove "${it.what}" from ${day}` } };
    },
    confirm: (p, ctx) => removeItem(ctx, str(p.args.day), str(p.args.item_id)),
    undo: undoVia,
  },
  set_top3: {
    spec: fn("set_top3", "Set the top 3 priorities for a day.", { day: dayArg, items: { type: "array", items: S, maxItems: 3 } }, ["items"]),
    run: (a, ctx) => setTop3(ctx, dayOf(a.day, ctx), (Array.isArray(a.items) ? a.items : []).map(str).filter(Boolean).slice(0, 3)),
    undo: undoVia,
  },
  add_capture: {
    spec: fn("add_capture", "Save a quick note to Ben's inbox.", { text: S }, ["text"]),
    run: async (a, ctx) => {
      const t = str(a.text).slice(0, 500);
      if (!t) return { ok: false, text: "Nothing to save." };
      const id = await ctx.db.addCapture(t);
      if (!id) return WRITE_FAIL;
      const action_id = await ctx.db.logAction({ tool: "add_capture", summary: `Saved note "${t.slice(0, 60)}"`, before: null, after: { id } });
      return { ok: true, text: "Saved to the inbox.", action_id };
    },
    undo: (a, ctx) => ctx.db.deleteCapture((a.after as { id: string }).id),
  },
  list_captures: {
    spec: fn("list_captures", "Read Ben's unprocessed inbox notes with ids.", {}),
    run: async (_a, ctx) => {
      const c = await ctx.db.captures();
      return c ? { ok: true, text: c.length ? c.map((x) => `${x.id} | ${x.text}`).join("\n") : "Inbox is empty." } : READ_FAIL;
    },
  },
  capture_done: {
    spec: fn("capture_done", "Mark an inbox note processed, after turning it into a task or when it needs nothing.", { capture_id: S }, ["capture_id"]),
    run: async (a, ctx) => {
      const id = str(a.capture_id);
      const open = await ctx.db.captures();
      if (!open) return READ_FAIL;
      const note = open.find((x) => x.id === id);
      if (!note) return { ok: false, text: `No open note ${id}.` };
      if (!(await ctx.db.setCaptureDone(id, true))) return WRITE_FAIL;
      const action_id = await ctx.db.logAction({ tool: "capture_done", summary: `Processed note "${note.text.slice(0, 60)}"`, before: { id, done: false }, after: { id, done: true } });
      return { ok: true, text: "Marked processed.", action_id };
    },
    undo: (a, ctx) => ctx.db.setCaptureDone((a.before as { id: string }).id, false),
  },
  list_goals: {
    spec: fn("list_goals", "Read Ben's active goals and their steps with ids.", {}),
    run: async (_a, ctx) => {
      const g = await ctx.db.goals();
      if (!g) return READ_FAIL;
      const text = g.length
        ? g.map((x) => [`${x.id} | ${x.title}${x.due ? ` (due ${x.due})` : ""}`, ...x.steps.map((s) => `  ${s.id} | ${s.done ? "done" : "open"} | ${s.title}`)].join("\n")).join("\n")
        : "No active goals.";
      return { ok: true, text };
    },
  },
  add_step: {
    spec: fn("add_step", "Add a step to one of Ben's goals.", { goal_id: S, title: S }, ["goal_id", "title"]),
    run: async (a, ctx) => {
      const goal = str(a.goal_id);
      const title = str(a.title).slice(0, 200);
      if (!goal || !title) return { ok: false, text: "Need a goal id and a title." };
      const id = await ctx.db.addStep(goal, title);
      if (!id) return WRITE_FAIL;
      const action_id = await ctx.db.logAction({ tool: "add_step", summary: `Added step "${title}"`, before: null, after: { id } });
      return { ok: true, text: `Added step (id ${id}).`, action_id };
    },
    undo: (a, ctx) => ctx.db.deleteStep((a.after as { id: string }).id),
  },
  check_step: {
    spec: fn("check_step", "Mark a goal step done or not done.", { step_id: S, done: { type: "boolean" } }, ["step_id"]),
    run: async (a, ctx) => {
      const id = str(a.step_id);
      const done = a.done !== false;
      const goals = await ctx.db.goals();
      if (!goals) return READ_FAIL;
      const step = goals.flatMap((x) => x.steps).find((s) => s.id === id);
      if (!step) return { ok: false, text: `No step ${id}.` };
      if (!(await ctx.db.setStepDone(id, done))) return WRITE_FAIL;
      const action_id = await ctx.db.logAction({ tool: "check_step", summary: `${done ? "Checked off" : "Reopened"} step "${step.title}"`, before: { id, done: step.done }, after: { id, done } });
      return { ok: true, text: `${done ? "Done" : "Reopened"}: ${step.title}.`, action_id };
    },
    undo: (a, ctx) => {
      const b = a.before as { id: string; done: boolean };
      return ctx.db.setStepDone(b.id, b.done);
    },
  },
  report_habit: {
    spec: fn("report_habit", "Log one of Ben's daily habits for today.", { key: { type: "string", enum: HABIT_KEYS }, done: { type: "boolean" } }, ["key"]),
    run: async (a, ctx) => {
      const key = str(a.key);
      if (!HABIT_KEYS.includes(key)) return { ok: false, text: `Unknown habit ${key}.` };
      const val = a.done !== false;
      const h = await ctx.db.habits(ctx.plan.day);
      if (!h) return READ_FAIL;
      if (!(await ctx.db.setHabit(ctx.plan.day, key, val))) return WRITE_FAIL;
      const action_id = await ctx.db.logAction({ tool: "report_habit", summary: `${val ? "Logged" : "Unlogged"} ${key.slice(3)}`, before: { day: ctx.plan.day, key, val: !!h[key] }, after: { day: ctx.plan.day, key, val } });
      return { ok: true, text: `${val ? "Logged" : "Unlogged"} ${key.slice(3)}.`, action_id };
    },
    undo: (a, ctx) => {
      const b = a.before as { day: string; key: string; val: boolean };
      return ctx.db.setHabit(b.day, b.key, b.val);
    },
  },
  set_stakes: {
    // the one tool whose effect reaches another person, so Ben confirms it
    spec: fn("set_stakes", "Choose which of today's open items carry stakes (at most 2). Ben must confirm; this only asks. Only before the first drill block starts.", { item_ids: { type: "array", items: S, maxItems: 2 } }, ["item_ids"]),
    run: async (a, ctx, ids) => {
      if (!stakesOffAllowed(firstWindowStart(ctx.plan, ctx.s), ctx.now)) return { ok: false, text: "Too late to change stakes today." };
      const items = await loadDay(ctx, ctx.plan.day);
      if (!items) return READ_FAIL;
      const chosen = (Array.isArray(a.item_ids) ? a.item_ids : []).map(str)
        .map((id) => items.find((i) => i.id === id && !i.done)).filter((i): i is DayItem => !!i).slice(0, 2);
      if (!chosen.length) return { ok: false, text: "None of those are open on today's list." };
      return {
        ok: true, text: "Asked Ben to confirm the stakes.",
        pending: { id: ids(), tool: "set_stakes", args: { item_ids: chosen.map((i) => i.id) }, summary: `Put stakes on ${chosen.map((i) => `"${i.what}"`).join("; ")}` },
      };
    },
    confirm: async (p, ctx) => {
      if (!stakesOffAllowed(firstWindowStart(ctx.plan, ctx.s), ctx.now)) return { ok: false, text: "Too late to change stakes today." };
      const chosen = (Array.isArray(p.args.item_ids) ? p.args.item_ids : []).map(str);
      const before = { stakes: ctx.plan.stakes, stakes_off: ctx.plan.stakes_off };
      ctx.plan = { ...ctx.plan, stakes: chosen, stakes_off: false, locked: true };
      const action_id = await ctx.db.logAction({ tool: "set_stakes", summary: p.summary, before, after: { stakes: chosen } });
      return { ok: true, text: "Stakes set.", action_id };
    },
    undo: async (a, ctx) => {
      const b = a.before as { stakes: string[]; stakes_off?: boolean };
      ctx.plan = { ...ctx.plan, stakes: b.stakes, stakes_off: !!b.stakes_off };
      return true;
    },
  },
  change_setting: {
    spec: fn("change_setting", "Change one of the Overseer's own rules. Ben must confirm; this only asks.", { key: { type: "string", enum: SETTING_KEYS }, value: S }, ["key", "value"]),
    run: async (a, ctx, ids) => {
      const key = str(a.key);
      const v = parseSetting(key, str(a.value));
      if (!v.ok) return { ok: false, text: v.error };
      return { ok: true, text: "Asked Ben to confirm the change.", pending: { id: ids(), tool: "change_setting", args: { key, value: v.value }, summary: `Change ${key} to ${String(v.value)}` } };
    },
    confirm: async (p, ctx) => {
      const key = str(p.args.key);
      const before = (ctx.s as unknown as Record<string, unknown>)[key];
      if (!(await ctx.db.patchSettings({ [key]: p.args.value } as Partial<SettingsRow>))) return WRITE_FAIL;
      const action_id = await ctx.db.logAction({ tool: "change_setting", summary: p.summary, before: { key, value: before }, after: { key, value: p.args.value } });
      return { ok: true, text: `Changed ${key}.`, action_id };
    },
    undo: (a, ctx) => {
      const b = a.before as { key: string; value: unknown };
      return ctx.db.patchSettings({ [b.key]: b.value } as Partial<SettingsRow>);
    },
  },
};

function handlers(withCal: boolean): Record<string, Handler> {
  return withCal ? { ...ITEM_HANDLERS, ...CAL_HANDLERS } : ITEM_HANDLERS;
}

export const toolSpecs = (withCal: boolean): ToolSpec[] => Object.values(handlers(withCal)).map((h) => h.spec);

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolCtx, ids: () => string): Promise<ToolOutcome> {
  const h = handlers(!!ctx.cal)[name];
  if (!h) return { ok: false, text: `Unknown tool ${name}.` };
  try {
    return await h.run(args, ctx, ids);
  } catch (e) {
    console.error(`[tool] ${name}`, e instanceof Error ? e.message : e);
    return { ok: false, text: `Tool ${name} failed.` };
  }
}

export async function confirmPending(p: Pending, ctx: ToolCtx): Promise<ToolOutcome> {
  const h = handlers(true)[p.tool];
  return h?.confirm ? h.confirm(p, ctx) : { ok: false, text: "That can't be confirmed." };
}

export async function undoAction(a: ActionRow, ctx: ToolCtx): Promise<boolean> {
  const h = handlers(true)[a.tool];
  return h?.undo ? h.undo(a, ctx) : false;
}
