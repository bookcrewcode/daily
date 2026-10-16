// Calendar tools. Creating and moving act right away (with Undo); deleting
// asks Ben first.
import { WRITE_FAIL, type ToolOutcome } from "./dayops";
import { isHhmm, minutesBetween } from "./time";
import { dayArg, dayOf, fn, S, str, type Handler } from "./toolkit";
import type { CalEvent } from "./types";

const NO_CAL: ToolOutcome = { ok: false, text: "Google Calendar isn't connected." };
const CAL_READ_FAIL: ToolOutcome = { ok: false, text: "Couldn't read the calendar right now." };
const local = (day: string, hhmm: string) => `${day}T${hhmm}:00`;
const hhmmOf = (iso: string) => (iso.length > 10 ? iso.slice(11, 16) : "all day");
const timeArg = { type: "string", description: "HH:MM" };

function span(a: Record<string, unknown>): { start: string; end: string } | null {
  const start = str(a.start);
  const end = str(a.end);
  return isHhmm(start) && isHhmm(end) && minutesBetween(start, end) > 0 ? { start, end } : null;
}
const BAD_SPAN: ToolOutcome = { ok: false, text: "Start and end must be HH:MM, with the end after the start." };

export const CAL_HANDLERS: Record<string, Handler> = {
  calendar_list: {
    spec: fn("calendar_list", "Read Google Calendar events for a day, with ids.", { day: dayArg }),
    run: async (a, ctx) => {
      if (!ctx.cal) return NO_CAL;
      const evs = await ctx.cal.listDay(dayOf(a.day, ctx), ctx.s.tz);
      if (!evs) return CAL_READ_FAIL;
      return { ok: true, text: evs.length ? evs.map((e) => `${e.id} | ${hhmmOf(e.start)}-${hhmmOf(e.end)} | ${e.title}`).join("\n") : "No events." };
    },
  },
  calendar_create: {
    spec: fn("calendar_create", "Add an event to Google Calendar.", { title: S, day: dayArg, start: timeArg, end: timeArg }, ["title", "start", "end"]),
    run: async (a, ctx) => {
      if (!ctx.cal) return NO_CAL;
      const t = span(a);
      if (!t) return BAD_SPAN;
      const title = str(a.title).slice(0, 200);
      if (!title) return { ok: false, text: "Need a title." };
      const day = dayOf(a.day, ctx);
      const ev = await ctx.cal.create(title, local(day, t.start), local(day, t.end), ctx.s.tz);
      if (!ev) return WRITE_FAIL;
      const action_id = await ctx.db.logAction({ tool: "calendar_create", summary: `Added "${title}" to the calendar (${day} ${t.start})`, before: null, after: { event_id: ev.id } });
      return { ok: true, text: `Added "${title}" at ${t.start}.`, action_id };
    },
    undo: async (a, ctx) => !!ctx.cal && ctx.cal.remove((a.after as { event_id: string }).event_id),
  },
  calendar_move: {
    spec: fn("calendar_move", "Move a Google Calendar event.", { event_id: S, day: dayArg, start: timeArg, end: timeArg }, ["event_id", "start", "end"]),
    run: async (a, ctx) => {
      if (!ctx.cal) return NO_CAL;
      const t = span(a);
      if (!t) return BAD_SPAN;
      const before = await ctx.cal.get(str(a.event_id));
      if (!before) return { ok: false, text: `No event ${str(a.event_id)}.` };
      const day = dayOf(a.day, ctx);
      const ev = await ctx.cal.move(before.id, local(day, t.start), local(day, t.end), ctx.s.tz);
      if (!ev) return WRITE_FAIL;
      const action_id = await ctx.db.logAction({ tool: "calendar_move", summary: `Moved "${before.title}" to ${day} ${t.start}`, before: { event_id: before.id, start: before.start, end: before.end }, after: { event_id: ev.id, start: ev.start, end: ev.end } });
      return { ok: true, text: `Moved "${before.title}" to ${t.start}.`, action_id };
    },
    undo: async (a, ctx) => {
      const b = a.before as { event_id: string; start: string; end: string };
      return !!ctx.cal && (await ctx.cal.move(b.event_id, b.start.slice(0, 19), b.end.slice(0, 19), ctx.s.tz)) !== null;
    },
  },
  calendar_delete: {
    spec: fn("calendar_delete", "Delete a Google Calendar event. Ben must confirm; this only asks.", { event_id: S }, ["event_id"]),
    run: async (a, ctx, ids) => {
      if (!ctx.cal) return NO_CAL;
      const ev = await ctx.cal.get(str(a.event_id));
      if (!ev) return { ok: false, text: `No event ${str(a.event_id)}.` };
      return { ok: true, text: "Asked Ben to confirm.", pending: { id: ids(), tool: "calendar_delete", args: { event_id: ev.id }, summary: `Delete "${ev.title}" from the calendar` } };
    },
    confirm: async (p, ctx) => {
      if (!ctx.cal) return NO_CAL;
      const ev = await ctx.cal.get(str(p.args.event_id));
      if (!ev) return { ok: false, text: "That event is already gone." };
      if (!(await ctx.cal.remove(ev.id))) return WRITE_FAIL;
      const action_id = await ctx.db.logAction({ tool: "calendar_delete", summary: p.summary, before: { event: ev }, after: null });
      return { ok: true, text: `Deleted "${ev.title}".`, action_id };
    },
    undo: async (a, ctx) => {
      const e = (a.before as { event: CalEvent }).event;
      return !!ctx.cal && (await ctx.cal.create(e.title, e.start.slice(0, 19), e.end.slice(0, 19), ctx.s.tz)) !== null;
    },
  },
};
