// Deadlines edge function — syncs Ben's Canvas calendar feed into `deadlines`.
// Thin on purpose: fetch + parse here (the browser can't read the feed — no
// CORS), upsert the rows with the USER's token so RLS applies, then hand the
// deadline⇄goal bookkeeping to the mirror_deadline_goals RPC.
//
// Only source 'canvas' rows are ever written here. Manual and syllabus
// deadlines belong to the client and are never touched.
//
// verify_jwt=false at the gateway; the JWT is validated here by hand.

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
const hdr = (token: string) => ({ apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function getUser(token: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

type Kind = "assignment" | "quiz" | "exam" | "discussion" | "reading" | "other";
type Row = { user_id: string; source: "canvas"; uid: string; course: string; title: string; kind: Kind; due_at: string; start_by: string; url: string; updated_at: string };

function kindOf(title: string): Kind {
  const t = title.toLowerCase();
  if (/\b(midterm|final|exam)\b/.test(t)) return "exam";
  if (/\bquiz/.test(t)) return "quiz";
  if (/\bdiscussion\b/.test(t)) return "discussion";
  if (/\breading\b/.test(t)) return "reading";
  if (/\b(problem set|homework|assignment|essay|paper|project|hw)\b/.test(t)) return "assignment";
  return "other";
}

// How many days before the due date he should START — the goal lands on that day.
function leadDays(kind: Kind, title: string): number {
  if (kind === "exam") return 7;
  if (kind === "assignment") return /\b(essay|paper|project)\b/i.test(title) ? 5 : 3;
  if (kind === "quiz" || kind === "other") return 2;
  return 1;
}

// YYYY-MM-DD as seen on HIS clock, not the server's.
const localDate = (ms: number, tz: string) => new Date(ms).toLocaleDateString("en-CA", { timeZone: tz });
const shiftDays = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);

// Offset of `tz` from UTC at a given instant — needed to turn an all-day
// (date-only) Canvas event into a real instant at the end of HIS day.
function tzOffsetMs(ms: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

function parseFeed(ics: string, userId: string, tz: string, today: string): Row[] {
  const comp = new ICAL.Component(ICAL.parse(ics));
  for (const vtz of comp.getAllSubcomponents("vtimezone")) {
    const z = new ICAL.Timezone(vtz);
    if (z.tzid && !ICAL.TimezoneService.has(z.tzid)) ICAL.TimezoneService.register(z.tzid, z);
  }
  const minMs = Date.parse(`${shiftDays(today, -14)}T00:00:00Z`) - 86400_000;
  const maxMs = Date.parse(`${shiftDays(today, 200)}T00:00:00Z`) + 86400_000;
  const now = new Date().toISOString();
  const out: Row[] = [];
  for (const ve of comp.getAllSubcomponents("vevent")) {
    try {
      // Canvas feeds are flat — one VEVENT per assignment, no recurrence
      const ev = new ICAL.Event(ve);
      if (!ev.startDate) continue;
      let dueMs: number;
      if (ev.startDate.isDate) {
        // date-only = "due that day": treat it as 23:59 on his clock
        const day = ev.startDate.toString().slice(0, 10);
        const guess = Date.parse(`${day}T23:59:00Z`);
        dueMs = guess - tzOffsetMs(guess, tz);
      } else dueMs = ev.startDate.toJSDate().getTime();
      if (!Number.isFinite(dueMs) || dueMs < minMs || dueMs > maxMs) continue;
      const summary = String(ev.summary ?? "").trim();
      // Canvas writes "Problem Set 3 [ECON 201-01]" — the bracketed tail is the course
      const m = summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
      const title = (m ? m[1] : summary).trim().slice(0, 200) || "(untitled)";
      const course = (m ? m[2] : "").trim().slice(0, 80);
      const kind = kindOf(title);
      const evUid = String(ve.getFirstPropertyValue("uid") ?? "").trim() || `${summary}|${dueMs}`;
      out.push({
        user_id: userId, source: "canvas", uid: evUid.slice(0, 200), course, title, kind,
        due_at: new Date(dueMs).toISOString(),
        start_by: shiftDays(localDate(dueMs, tz), -leadDays(kind, title)),
        url: String(ve.getFirstPropertyValue("url") ?? "").slice(0, 500),
        updated_at: now,
      });
    } catch { /* one malformed event shouldn't sink the whole feed */ }
  }
  return out;
}

type DL = { id: string; course: string; course_key: string | null; title: string; kind: Kind; due_at: string; start_by: string; notebook_id: string | null; done: boolean; url: string; source: string };

// What the Classes card shows: courses rolled up from undone deadlines, the
// next 20 undone ones, and how many have no course at all (`unfiled` — they
// are never a nameless "course" row). A failed read is an error, never an
// empty list.
async function summary(token: string): Promise<{ courses: unknown[]; deadlines: DL[]; unfiled: number } | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/deadlines?done=eq.false&select=id,course,course_key,title,kind,due_at,start_by,notebook_id,done,url,source&order=due_at.asc&limit=300`, { headers: hdr(token) });
  if (!r.ok) return null;
  const rows = (await r.json()) as DL[];
  const nowIso = new Date().toISOString();
  const upcoming = rows.filter((d) => d.due_at >= nowIso);
  const courses = new Map<string, { course: string; course_key: string | null; count: number; next_due: string; notebook_id: string | null }>();
  let unfiled = 0;
  for (const d of upcoming) {
    const k = d.course_key || d.course || "";
    if (!k) { unfiled++; continue; }
    const c = courses.get(k);
    if (c) { c.count++; c.notebook_id ??= d.notebook_id; }
    else courses.set(k, { course: d.course, course_key: d.course_key, count: 1, next_due: d.due_at, notebook_id: d.notebook_id });
  }
  return { courses: [...courses.values()], deadlines: upcoming.slice(0, 20), unfiled };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const user = await getUser(token);
    if (!user?.id) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const mode = String(body.mode ?? "status");
    // a bad zone name would throw inside Intl — fall back to his home zone
    let tz = typeof body.tz === "string" && body.tz.length < 64 ? body.tz : "America/New_York";
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = "America/New_York"; }
    let today = String(body.today ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) today = localDate(Date.now(), tz);

    const sr = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?select=canvas_ics_url`, { headers: hdr(token) });
    if (!sr.ok) return json({ error: "Couldn't read your settings just now — try again in a moment." });
    const icsUrl = String(((await sr.json()) as { canvas_ics_url?: string }[])[0]?.canvas_ics_url ?? "").trim();

    if (mode === "status") {
      const s = await summary(token);
      if (!s) return json({ error: "Couldn't read your deadlines just now — try again in a moment." });
      return json({ connected: !!icsUrl, ...s });
    }
    if (mode !== "sync") return json({ error: `Unknown mode "${mode}".` });
    if (!icsUrl) return json({ error: "No Canvas calendar link saved yet — paste it in the Classes card first." });

    let u: URL;
    try { u = new URL(icsUrl); } catch { return json({ error: "The saved Canvas link isn't a valid URL — paste it again." }); }
    if (u.protocol !== "https:") return json({ error: "The Canvas link must start with https://" });
    if (/^(\d|\[|localhost)/i.test(u.hostname)) return json({ error: "That host isn't allowed." });

    // no redirects: an expired feed link bounces to a login page, which would
    // otherwise read as "not a calendar" — say what actually happened
    const r = await fetch(u.toString(), { headers: { "User-Agent": "daily-app-deadlines-sync/1.0" }, redirect: "manual" });
    if (r.status >= 300 && r.status < 400) return json({ error: "The Canvas link redirected instead of returning the calendar — the feed link has probably expired. Open Canvas → Calendar → Calendar Feed and paste a fresh link." });
    if (!r.ok) return json({ error: `Couldn't fetch the Canvas feed (HTTP ${r.status}) — open Canvas → Calendar → Calendar Feed and paste the link again.` });
    const text = await r.text();
    if (!text.includes("BEGIN:VCALENDAR")) return json({ error: "That link didn't return a calendar (.ics) file — use the Calendar Feed link from Canvas." });

    // one row per uid, last wins: Postgres refuses an upsert that hits the
    // same key twice in one statement, and Canvas feeds do repeat a uid
    const rows = [...new Map(parseFeed(text, user.id, tz, today).map((row) => [row.uid, row])).values()];
    if (rows.length) {
      // write-first: one upsert keyed on (user_id, source, uid); `done`,
      // notebook_id and goal_id are left out so a re-sync never resets them
      const up = await fetch(`${SUPABASE_URL}/rest/v1/deadlines?on_conflict=user_id,source,uid`, {
        method: "POST", headers: { ...hdr(token), Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows),
      });
      if (!up.ok) {
        console.error(`[deadlines] upsert ${up.status} ${(await up.text()).slice(0, 300)}`);
        return json({ error: "Read the feed but couldn't save the deadlines — try again in a moment." });
      }
    }

    // goals ⇄ deadlines: link notebooks, create/refresh/close goals — all in SQL
    let counts: Record<string, unknown> = { synced: rows.length };
    const mr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/mirror_deadline_goals`, { method: "POST", headers: hdr(token), body: JSON.stringify({ p_tz: tz }) });
    if (mr.ok) counts = { ...counts, ...((await mr.json()) as Record<string, unknown>) };
    else {
      console.error(`[deadlines] mirror ${mr.status} ${(await mr.text()).slice(0, 300)}`);
      counts.mirror_error = "Deadlines saved, but the goals didn't update — sync again in a moment.";
    }

    const s = await summary(token);
    if (!s) return json({ error: "Deadlines saved, but couldn't read them back — reopen the Classes card.", counts });
    return json({ connected: true, ...s, counts });
  } catch (e) {
    console.error("[deadlines] fatal", e instanceof Error ? e.message : e);
    return json({ error: "Something broke on the way — try again." });
  }
});
