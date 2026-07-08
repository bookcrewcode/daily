"use client";

// Google Calendar integration, two directions:
//  READ  — the `calendar` edge function fetches the private "secret address"
//          iCal feed (browser can't: no CORS on calendar.google.com).
//  WRITE — no OAuth needed: prefilled calendar.google.com/render TEMPLATE
//          links per event, plus a bulk .ics download that any calendar imports.

import { supabase, SUPABASE_URL, SUPABASE_ANON, dateStr, type ScheduleItem } from "./supabase";

export const CALENDAR_FN = `${SUPABASE_URL}/functions/v1/calendar`;

export type CalEvent = { title: string; start: string; end: string; allDay: boolean };

export async function fetchCalendarEvents(icsUrl: string, day: Date): Promise<CalEvent[]> {
  const from = new Date(day); from.setHours(0, 0, 0, 0);
  const to = new Date(day); to.setHours(23, 59, 59, 999);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(CALENDAR_FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ icsUrl, from: from.toISOString(), to: to.toISOString(), day: dateStr(day) }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return (json.events ?? []) as CalEvent[];
}

// "9", "9:30", "9am", "2:15pm", "14:30" → minutes since midnight (or null).
export function parseTime(raw: string): number | null {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am?|pm?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  if (m[3]?.startsWith("p") && h < 12) h += 12;
  if (m[3]?.startsWith("a") && h === 12) h = 0;
  // bare small hours like "2" or "3:30" on a day planner almost always mean afternoon
  if (!m[3] && h >= 1 && h <= 6) h += 12;
  return h * 60 + min;
}

export function fmtMinutes(mins: number): string {
  const h24 = Math.floor(mins / 60), m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""}${h24 < 12 ? "am" : "pm"}`;
}

// Resolve a planned schedule into concrete [start,end] blocks for a given day.
// End = next item's start when it's later the same day, else +1 hour.
export function resolveBlocks(items: ScheduleItem[], day: Date): { what: string; start: Date; end: Date }[] {
  const timed = items
    .map((it) => ({ what: it.what.trim(), mins: parseTime(it.time) }))
    .filter((x): x is { what: string; mins: number } => x.mins !== null && !!x.what)
    .sort((a, b) => a.mins - b.mins);
  return timed.map((x, i) => {
    const start = new Date(day); start.setHours(0, x.mins, 0, 0);
    const nextMins = timed[i + 1]?.mins;
    const endMins = nextMins != null && nextMins > x.mins ? Math.min(nextMins, x.mins + 240) : x.mins + 60;
    const end = new Date(day); end.setHours(0, endMins, 0, 0);
    return { what: x.what, start, end };
  });
}

const gstamp = (d: Date) =>
  `${dateStr(d).replace(/-/g, "")}T${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}00`;

// Prefilled Google Calendar "create event" link — works signed-in on web + mobile app.
export function gcalTemplateUrl(title: string, start: Date, end: Date): string {
  const p = new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${gstamp(start)}/${gstamp(end)}` });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

// Bulk import: one .ics with every block (floating local time).
export function downloadIcs(blocks: { what: string; start: Date; end: Date }[], filename: string) {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/[,;]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Daily//Night Planner//EN",
    ...blocks.flatMap((b, i) => [
      "BEGIN:VEVENT",
      `UID:daily-${dateStr(b.start)}-${i}@bookcrewcode.github.io`,
      `DTSTART:${gstamp(b.start)}`,
      `DTEND:${gstamp(b.end)}`,
      `SUMMARY:${esc(b.what)}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
