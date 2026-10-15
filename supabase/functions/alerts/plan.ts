// Telegram alerts planner — pure. Given the clock and today's data it decides
// what to send now, what to hold for later, and what a bundle delivers.
// No I/O here: index.ts loads the data, runs planAlerts, then claims a log
// row per message and sends it.
// Tests: npx --yes tsx --test supabase/functions/alerts/plan.test.ts

export type Block = { id: string; label: string; kind: string; location: string; start_t: string; end_t: string };
export type DayItem = { id: string; time: string; what: string; done?: boolean; at?: number; src?: string; block_id?: string; goal_id?: string };
export type Deadline = { id: string; title: string; course: string; kind: string; due_at: string; start_by: string | null; goal_id: string | null };
export type AlertKind = "plan" | "block" | "nudge" | "due_eve" | "bundle";
export type LogState = "held" | "sent" | "started" | "done" | "snoozed" | "skipped" | "failed";
export type LogRow = {
  key: string; kind: AlertKind; state: LogState; snooze_until: string | null;
  tries: number; updated_at: string; meta: { text?: string } | null;
};
export type Settings = {
  chat_id: number | null; morning_at: string; tz: string;
  quiet: { class: boolean; gym: boolean; night: [string, string] };
  drive_silent: boolean; paused_until: string | null; cap: number;
};
export type Btn = { text: string; data?: string; url?: string };
export type Alert = {
  key: string; kind: AlertKind; refId: string | null; text: string; buttons: Btn[][];
  silent: boolean; action: "send" | "hold"; absorbs: string[]; top3: string[];
};
export type Clock = { day: string; min: number; weekday: number };
export type Input = {
  now: Date; settings: Settings; blocks: Block[]; items: DayItem[]; top3: string[];
  deadlines: Deadline[]; log: LogRow[];   // today's rows plus any still-held rows
};

export const APP_URL = "https://bookcrewcode.github.io/daily/";
export const NUDGE_AFTER = 15;     // minutes into a block before the one nudge
export const SNOOZE_MIN = 15;
export const STALE_MIN = 60;       // a trigger older than this never fires
export const PLAN_STALE_MIN = 240;
export const DUE_EVE_AT = "18:00";
export const BUNDLE_GAP_MIN = 60;
export const MAX_TRIES = 3;
const MAX_LIST = 12;

export const DEFAULT_SETTINGS: Settings = {
  chat_id: null, morning_at: "07:45", tz: "America/New_York",
  quiet: { class: true, gym: true, night: ["22:00", "07:30"] },
  drive_silent: true, paused_until: null, cap: 10,
};

// user_settings.telegram can be partial or from an older shape; fill the gaps.
export function readSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const q = (r.quiet && typeof r.quiet === "object" ? r.quiet : {}) as Record<string, unknown>;
  const hhmm = (v: unknown, d: string) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : d);
  const night: [string, string] = Array.isArray(q.night) && q.night.length === 2
    ? [hhmm(q.night[0], "22:00"), hhmm(q.night[1], "07:30")]
    : DEFAULT_SETTINGS.quiet.night;
  return {
    chat_id: typeof r.chat_id === "number" ? r.chat_id : null,
    morning_at: hhmm(r.morning_at, DEFAULT_SETTINGS.morning_at),
    tz: typeof r.tz === "string" && r.tz ? r.tz : DEFAULT_SETTINGS.tz,
    quiet: { class: q.class !== false, gym: q.gym !== false, night },
    drive_silent: r.drive_silent !== false,
    paused_until: typeof r.paused_until === "string" ? r.paused_until : null,
    cap: typeof r.cap === "number" && r.cap > 0 ? r.cap : DEFAULT_SETTINGS.cap,
  };
}

export const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Wall-clock day, minute-of-day and weekday in `tz` — DST-safe via Intl.
export function localClock(now: Date, tz: string): Clock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    min: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: WD.indexOf(get("weekday")),
  };
}
export const localDay = (iso: string, tz: string): string => localClock(new Date(iso), tz).day;

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86_400_000);
}
export function prettyDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MONTHS[m - 1]} ${d}`;
}

// "21:640:114:07 PRECALCULUS" → "Precalculus"; "Fall 2026 (21:512:368:01)" → "".
export function shortCourse(course: string): string {
  const t = course
    .replace(/\b\d{2}:\d{3}:\d{3}(?::\d{2})?\b/g, "")
    .replace(/^\s*(fall|spring|summer|winter)\s+\d{4}\s*\(\s*\)\s*$/i, "")
    .replace(/\bintro to\s+/i, "")
    .trim();
  return t ? t.toLowerCase().replace(/\b[a-z]/g, (x) => x.toUpperCase()) : "";
}
const courseTag = (course: string) => { const s = shortCourse(course); return s ? ` (${s})` : ""; };

// Which quiet window covers `min`. A block's own ping and nudge are never
// held by that same block (`except`) — "Gym now" is the point of the gym block.
export function quietAt(min: number, s: Settings, blocks: Block[], except: string | null = null): "night" | "class" | "gym" | null {
  const [ns, ne] = s.quiet.night.map(toMin);
  if (ns > ne ? (min >= ns || min < ne) : (min >= ns && min < ne)) return "night";
  for (const b of blocks) {
    if (b.id === except) continue;
    const quiet = (b.kind === "class" && s.quiet.class) || (b.kind === "gym" && s.quiet.gym);
    if (quiet && min >= toMin(b.start_t) && min < toMin(b.end_t)) return b.kind as "class" | "gym";
  }
  return null;
}
const driving = (min: number, blocks: Block[]) =>
  blocks.some((b) => b.kind === "drive" && min >= toMin(b.start_t) && min < toMin(b.end_t));

const btn = (text: string, code: "s" | "d" | "z" | "k", key: string): Btn => ({ text, data: `${code}|${key}` });
const firstLine = (r: LogRow) => (r.meta?.text ?? r.key).split("\n")[0];
function heldLines(rows: LogRow[]): string[] {
  const lines = rows.slice(0, MAX_LIST).map((r) => `- ${firstLine(r)}`);
  return rows.length > MAX_LIST ? [...lines, `…and ${rows.length - MAX_LIST} more`] : lines;
}

export function pickTop3(inp: Input, c: Clock): string[] {
  const own = inp.top3.map((t) => String(t ?? "").trim()).filter(Boolean);
  if (own.length) return own.slice(0, 3);
  const tz = inp.settings.tz;
  const started = inp.deadlines
    .filter((d) => d.start_by !== null && d.start_by <= c.day && localDay(d.due_at, tz) >= c.day)
    .sort((a, b) => a.due_at.localeCompare(b.due_at))
    .map((d) => `${d.title}${courseTag(d.course)}, due ${prettyDay(localDay(d.due_at, tz))}`);
  const done = new Set(inp.items.filter((i) => i.done && i.block_id).map((i) => i.block_id));
  const blocks = inp.blocks
    .filter((b) => b.kind !== "class" && toMin(b.end_t) > c.min && !done.has(b.id))
    .sort((a, b) => toMin(a.start_t) - toMin(b.start_t))
    .map((b) => `${b.label} at ${b.start_t}`);
  return [...started, ...blocks].slice(0, 3);
}

export function planText(inp: Input, c: Clock, top3: string[], held: LogRow[]): string {
  const tz = inp.settings.tz;
  const L: string[] = [`Today · ${prettyDay(c.day)}`];
  if (top3.length) { L.push("", "Top 3"); top3.forEach((t, i) => L.push(`${i + 1}. ${t}`)); }
  else L.push("", "Nothing scheduled. A free day.");
  const dueToday = inp.deadlines.filter((d) => localDay(d.due_at, tz) === c.day);
  if (dueToday.length) { L.push("", "Due today"); dueToday.forEach((d) => L.push(`- ${d.title}${courseTag(d.course)}`)); }
  const startToday = inp.deadlines.filter((d) => d.start_by === c.day && localDay(d.due_at, tz) !== c.day);
  if (startToday.length) {
    L.push("", "Start today");
    startToday.forEach((d) => L.push(`- ${d.title}${courseTag(d.course)}, due ${prettyDay(localDay(d.due_at, tz))}`));
  }
  const exams = inp.deadlines
    .filter((d) => d.kind === "exam")
    .map((d) => ({ d, n: daysBetween(c.day, localDay(d.due_at, tz)) }))
    .filter((x) => x.n >= 1 && x.n <= 14);
  if (exams.length) {
    L.push("", "Coming up");
    exams.forEach(({ d, n }) => L.push(`- ${d.title}${courseTag(d.course)}: ${n === 1 ? "tomorrow" : `in ${n} days`}`));
  }
  if (held.length) L.push("", "Held for you", ...heldLines(held));
  return L.join("\n");
}

export function addSteps(text: string, top3: string[], steps: string[]): string {
  let out = text;
  top3.forEach((t, i) => {
    const step = (steps[i] ?? "").trim();
    if (step) out = out.replace(`${i + 1}. ${t}`, `${i + 1}. ${t}\n   First step: ${step}`);
  });
  return out;
}

export function planAlerts(inp: Input): Alert[] {
  const s = inp.settings;
  if (s.chat_id === null) return [];
  if (s.paused_until && new Date(s.paused_until) > inp.now) return [];
  const c = localClock(inp.now, s.tz);
  const byKey = new Map(inp.log.map((r) => [r.key, r] as const));
  const silent = s.drive_silent && driving(c.min, inp.blocks);
  const fresh = (t: number, stale = STALE_MIN) => c.min >= t && c.min - t <= stale;
  // a logged key goes again only when its snooze ran out or its send failed
  const retry = (r: LogRow | undefined) => !!r && (
    (r.state === "snoozed" && !!r.snooze_until && new Date(r.snooze_until) <= inp.now) ||
    (r.state === "failed" && r.tries < MAX_TRIES));
  const doneBlocks = new Set(inp.items.filter((i) => i.done && i.block_id).map((i) => i.block_id as string));
  const held = inp.log.filter((r) => r.state === "held");
  const base = { silent, absorbs: [] as string[], top3: [] as string[] };
  const out: Alert[] = [];

  // 1. the morning plan — waits out the night; never held by a class or the gym
  const planKey = `plan:${c.day}`;
  const planRow = byKey.get(planKey);
  if ((!planRow || retry(planRow)) && fresh(toMin(s.morning_at), PLAN_STALE_MIN) && quietAt(c.min, s, inp.blocks) !== "night") {
    const top3 = pickTop3(inp, c);
    out.push({ ...base, key: planKey, kind: "plan", refId: null, text: planText(inp, c, top3, held),
      buttons: [[{ text: "Open Daily", url: APP_URL }]], action: "send", absorbs: held.map((r) => r.key), top3 });
  }

  // 2. a ping when each non-class block starts, or when its snooze runs out
  for (const b of inp.blocks) {
    if (b.kind === "class" || doneBlocks.has(b.id)) continue;
    const key = `block:${b.id}:${c.day}`;
    const r = byKey.get(key);
    if (r ? !retry(r) : !fresh(toMin(b.start_t))) continue;
    if (c.min >= toMin(b.end_t)) continue;
    out.push({ ...base, key, kind: "block", refId: b.id, text: `${b.label}\nNow · ${b.start_t}–${b.end_t}`,
      buttons: [[btn("Starting", "s", key), btn("Done", "d", key), btn("Snooze 15m", "z", key)]],
      action: quietAt(c.min, s, inp.blocks, b.id) ? "hold" : "send" });
  }

  // 3. one nudge, 15 minutes in, when nothing was tapped and nothing ticked
  for (const b of inp.blocks) {
    if (b.kind === "class" || doneBlocks.has(b.id)) continue;
    const bkey = `block:${b.id}:${c.day}`;
    const nkey = `nudge:${b.id}:${c.day}`;
    if (byKey.get(bkey)?.state !== "sent" || byKey.has(nkey)) continue;
    const t = toMin(b.start_t);
    if (c.min < t + NUDGE_AFTER || c.min >= toMin(b.end_t)) continue;
    if (quietAt(c.min, s, inp.blocks, b.id)) continue; // a nudge only matters now; it is never held
    out.push({ ...base, key: nkey, kind: "nudge", refId: b.id, text: `${b.label}\nStarted ${c.min - t} min ago. Still on?`,
      buttons: [[btn("Starting", "s", bkey), btn("Done", "d", bkey), btn("Skip today", "k", bkey)]], action: "send" });
  }

  // 4. 6pm the evening before the LOCAL due day
  if (fresh(toMin(DUE_EVE_AT))) {
    const tomorrow = addDays(c.day, 1);
    for (const d of inp.deadlines) {
      const key = `due_eve:${d.id}`;
      if (localDay(d.due_at, s.tz) !== tomorrow) continue;
      if (byKey.has(key) && !retry(byKey.get(key))) continue;
      out.push({ ...base, key, kind: "due_eve", refId: d.id, text: `Due tomorrow: ${d.title}${courseTag(d.course)}`,
        buttons: [[btn("Done", "d", key), { text: "Open Daily", url: APP_URL }]],
        action: quietAt(c.min, s, inp.blocks) ? "hold" : "send" });
    }
  }

  // 5. the cap: past it, pings wait for a bundle and nudges are dropped
  let used = inp.log.filter((r) => (r.kind === "block" || r.kind === "nudge" || r.kind === "due_eve")
    && (r.state === "sent" || r.state === "started" || r.state === "done" || r.state === "snoozed" || r.state === "skipped")).length;
  const capped: Alert[] = [];
  for (const a of out) {
    if (a.kind === "plan" || a.action !== "send" || byKey.has(a.key)) { capped.push(a); continue; }
    if (used < s.cap) { used++; capped.push(a); continue; }
    if (a.kind !== "nudge") capped.push({ ...a, action: "hold" });
  }

  // 6. one bundle delivers what was held, once nothing is quiet, after the plan, at most hourly
  const planGoing = capped.some((a) => a.kind === "plan");
  const planDone = (!!planRow && planRow.state !== "held") || c.min > toMin(s.morning_at) + PLAN_STALE_MIN;
  const lastBundle = inp.log.filter((r) => r.kind === "bundle").map((r) => Date.parse(r.updated_at)).sort((x, y) => y - x)[0];
  const gapOk = lastBundle === undefined || (inp.now.getTime() - lastBundle) / 60_000 >= BUNDLE_GAP_MIN;
  if (held.length && !planGoing && planDone && !quietAt(c.min, s, inp.blocks) && gapOk) {
    capped.push({ ...base, key: `bundle:${c.day}:${c.min}`, kind: "bundle", refId: null,
      text: ["While you were busy", ...heldLines(held)].join("\n"),
      buttons: [[{ text: "Open Daily", url: APP_URL }]], action: "send", absorbs: held.map((r) => r.key) });
  }
  return capped;
}
