// The day's drill windows, read straight off the shared day list: every timed
// item whose kind gets check-ins is a window from its time for the block's
// length (or the length written in its text, else an hour).
import { epochOf, minutesBetween } from "./time";
import type { Block, DayItem, Plan, Settings, Win } from "./types";

const MIN = 60_000;

export function durationOf(what: string): number {
  const h = what.match(/(\d+(?:\.\d+)?)\s*h\b/i);
  if (h) return Math.round(Number(h[1]) * 60);
  const m = what.match(/(\d+)\s*min/i);
  return m ? Number(m[1]) : 60;
}

export function buildWindows(day: string, items: DayItem[], blocks: Block[], s: Settings): Win[] {
  const byId = new Map(blocks.map((b) => [b.id, b] as const));
  const wins: Win[] = [];
  for (const it of items) {
    if (!it.time) continue;
    const b = it.block_id ? byId.get(it.block_id) : undefined;
    const kind = b ? b.kind || "class" : it.src === "plan" ? "study" : "task";
    if (!s.ping_kinds.includes(kind)) continue;
    const blockLen = b ? minutesBetween(b.start_t, b.end_t) : 0;
    const start = epochOf(day, it.time, s.tz);
    const len = blockLen > 0 ? blockLen : durationOf(it.what);
    wins.push({ key: `w_${it.id}`, label: it.what, kind, start, end: start + len * MIN, own: it.id });
  }
  return wins.sort((a, b) => a.start - b.start);
}

// Untimed open tasks in the order they should run.
export function floatingOf(items: DayItem[], top3: string[], bumped: string[] = []): string[] {
  const key = (s: string) => s.trim().toLowerCase();
  const rank = (i: DayItem) => {
    const b = bumped.indexOf(i.id);
    if (b >= 0) return b;
    const t = top3.findIndex((x) => key(x) === key(i.what));
    return t >= 0 ? 100 + t : 1000;
  };
  return items
    .filter((i) => !i.done && !i.time)
    .map((i, n) => ({ i, n }))
    .sort((a, b) => rank(a.i) - rank(b.i) || a.n - b.n)
    .map((x) => x.i.id);
}

export function windowAt(wins: Win[], now: number): Win | null {
  return wins.find((w) => now >= w.start && now < w.end) ?? null;
}

export function taskFor(win: Win, items: DayItem[], floating: string[]): DayItem | null {
  const open = new Map(items.filter((i) => !i.done).map((i) => [i.id, i] as const));
  if (open.has(win.own)) return open.get(win.own)!;
  for (const id of floating) if (open.has(id)) return open.get(id)!;
  return null;
}

export function nextWindowAfter(wins: Win[], t: number): Win | null {
  return wins.find((w) => w.start > t) ?? null;
}

export function firstWindowStart(p: Plan, s: Settings): number | null {
  const w = buildWindows(p.day, p.items, p.blocks, s);
  return w.length ? w[0].start : null;
}
