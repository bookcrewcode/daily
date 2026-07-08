// Calendar edge function — fetches a private "secret address" iCal feed
// (Google Calendar → Settings → your calendar → Secret address in iCal format)
// server-side, because calendar.google.com sends no CORS headers so the
// browser can't read it directly. Parses VEVENTs (including recurring ones)
// and returns the occurrences inside the requested window as UTC ISO strings.
//
// verify_jwt is false at the gateway (so CORS preflight works); we validate
// the Supabase JWT manually like the advisor function does.

import ICAL from "npm:ical.js@2.1.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function getUser(token: string) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  return r.ok ? await r.json() : null;
}

type Ev = { title: string; start: string; end: string; allDay: boolean };

function parseEvents(icsText: string, fromMs: number, toMs: number, day: string): Ev[] {
  const comp = new ICAL.Component(ICAL.parse(icsText));

  // Register VTIMEZONEs so TZID-qualified times convert to real instants.
  for (const vtz of comp.getAllSubcomponents("vtimezone")) {
    const tz = new ICAL.Timezone(vtz);
    if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz.tzid, tz);
  }

  const out: Ev[] = [];
  const push = (title: string, start: ICAL.Time, end: ICAL.Time | null) => {
    if (start.isDate) {
      // All-day events are dates, not instants — match them against the
      // requested local calendar day, or they leak into neighboring days.
      const s = start.toString().slice(0, 10);
      const e = end ? end.toString().slice(0, 10) : s; // iCal DTEND is exclusive
      const inRange = day ? (day >= s && (day < e || s === e)) : true;
      if (!inRange) return;
      out.push({ title: title || "(untitled)", start: s, end: e, allDay: true });
      return;
    }
    const s = start.toJSDate().getTime();
    const e = end ? end.toJSDate().getTime() : s + 3600_000;
    if (e <= fromMs || s >= toMs) return;
    out.push({
      title: title || "(untitled)",
      start: new Date(s).toISOString(),
      end: new Date(e).toISOString(),
      allDay: false,
    });
  };

  for (const ve of comp.getAllSubcomponents("vevent")) {
    try {
      const ev = new ICAL.Event(ve);
      if (!ev.startDate) continue;
      if (ev.isRecurring()) {
        const iter = ev.iterator();
        let next: ICAL.Time | null;
        let guard = 0;
        while ((next = iter.next()) && guard++ < 2000) {
          if (next.toJSDate().getTime() >= toMs) break;
          const occ = ev.getOccurrenceDetails(next);
          push(ev.summary, occ.startDate, occ.endDate);
        }
      } else {
        push(ev.summary, ev.startDate, ev.endDate);
      }
    } catch {
      // one malformed event shouldn't sink the whole feed
    }
  }

  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const user = await getUser(token);
    if (!user?.id) return json({ error: "unauthorized" }, 401);

    const { icsUrl = "", from = "", to = "", day = "" } = await req.json();

    let u: URL;
    try {
      u = new URL(String(icsUrl));
    } catch {
      return json({ error: "That doesn't look like a valid URL." });
    }
    if (u.protocol !== "https:") return json({ error: "The calendar address must start with https://" });
    if (/^(\d|\[|localhost)/i.test(u.hostname)) return json({ error: "That host isn't allowed." });

    const fromMs = Date.parse(String(from));
    const toMs = Date.parse(String(to));
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs - fromMs > 45 * 86400_000) {
      return json({ error: "Bad date range." });
    }

    const r = await fetch(u.toString(), { headers: { "User-Agent": "daily-app-calendar-sync/1.0" } });
    if (!r.ok) {
      return json({ error: `Couldn't fetch the calendar (HTTP ${r.status}). Double-check the secret iCal address.` });
    }
    const text = await r.text();
    if (!text.includes("BEGIN:VCALENDAR")) {
      return json({ error: "That URL didn't return a calendar (.ics) file. Use the 'Secret address in iCal format' from Google Calendar settings." });
    }

    return json({ events: parseEvents(text, fromMs, toMs, String(day)) });
  } catch (e) {
    return json({ error: String(e) });
  }
});
