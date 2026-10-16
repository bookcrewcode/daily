// Every word the Overseer says that isn't written by a model. Plain, short,
// firm, never shaming, no emojis (spec "Lines this design keeps").
import type { Btn, DayItem } from "./types";

export const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const bare = (s: string) => clip(s).replace(/[.\s]+$/, "");
const sentence = (s: string) => {
  const t = clip(s).trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

const CODES = { done: "d", more: "m", onit: "o", stuck: "s", skip: "k", lock: "L", change: "C", nostakes: "N", yes: "y", no: "n" } as const;
export type Cb = { act: keyof typeof CODES; arg: string };
const BY_CODE = Object.fromEntries(Object.entries(CODES).map(([k, v]) => [v, k])) as Record<string, Cb["act"]>;

export const cb = (act: Cb["act"], arg: string) => `${CODES[act]}|${arg}`;

// Item ids can be long (the Plan chat derives them from time + text), but a
// Telegram button carries at most 64 bytes, and one bad button sinks the whole
// message. Item buttons carry a short hash of the id; the brain looks the item
// up on today's list by it.
export function keyOf(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
export const itemCb = (act: Cb["act"], id: string) => cb(act, keyOf(id));

export function parseCb(data: string): Cb | null {
  const i = data.indexOf("|");
  if (i < 1) return null;
  const act = BY_CODE[data.slice(0, i)];
  const arg = data.slice(i + 1);
  return act && arg ? { act, arg } : null;
}

export const LEARN_URL = "https://bookcrewcode.github.io/daily/?go=learn";

export const T = {
  start: (what: string, step: string) => `Now: ${bare(what)}.\nFirst step: ${sentence(step)}`,
  ping: (what: string) => `Check-in: ${bare(what)}. Where are you at?`,
  still: (what: string) => `Still on "${clip(what)}"? One tap is enough.`,
  shrink: (step: string) => `Just this: ${sentence(step)} Two minutes, then tap Done.`,
  countdown: (partner: string, n: number) => `15 minutes, then ${partner} gets line #${n}. Tap Done on the two-minute step to stop it.`,
  countdownStopped: () => "Stopped. That counts.",
  countdownOver: () => "Block's over, so stakes on this one are off.",
  stakesOff: (done: boolean) => (done ? "Done, so the stakes are off." : "That task is off today's list, so the stakes are off."),
  stakesUnchecked: () => "Couldn't check your list, so nothing was sent.",
  stakesUnwarned: () => "Stakes didn't go out: my warning never reached you.",
  notOnList: () => "That item isn't on today's list anymore.",
  stakesSent: (partner: string) => `Sent to ${partner}. Moving on.`,
  partner: (line: string) => `From Ben's accountability bot: ${line}`,
  moved: (what: string, where: string) => `Moved "${clip(what)}" ${where}.`,
  nothingLeft: () => "Nothing left for this block. Good.",
  capNotice: () => "Today's AI budget is used up. Buttons still work; I'll read your messages in the morning.",
  paused: () => "Paused. Send /resume to start again.",
  resumed: () => "Back on.",
  tooLateStakes: () => "Too late to turn stakes off today. They stay as set.",
  locked: (stakes: string[]) => (stakes.length ? `Locked. Stakes on: ${stakes.map((s) => clip(s, 60)).join("; ")}.` : "Locked. No stakes today."),
  change: () => "Tell me what to change.",
  top3Ask: () => "Reply with tomorrow's top 3, one per line.",
  top3Set: (n: number) => `Tomorrow's top ${n} is set.`,
  help: () => "Commands: /today, /done, /skip, /pause, /resume, /stakes off (before your first block).",
  linked: () => "Connected. This is where I'll reach you.",
  partnerWelcome: () => "You're set as Ben's accountability partner. If Ben stalls on a committed task, this bot may send you one short goofy message. Send /stop anytime to leave.",
  partnerJoined: (name: string) => `${name} joined as a stakes partner.`,
  partnerBye: () => "Done. You won't get any more messages.",
  partnerLeft: (name: string) => `${name} left the stakes list.`,
  defaultStep: () => "Open it and do the first two minutes.",
  confirm: (summary: string) => `${summary}?`,
  learn: () => "Your Learn round is ready. About 6 minutes.",
};

const b = (text: string, act: Cb["act"], arg: string): Btn => ({ text, data: cb(act, arg) });
const bi = (text: string, act: Cb["act"], id: string): Btn => ({ text, data: itemCb(act, id) });
export const startButtons = (id: string): Btn[][] => [[bi("On it", "onit", id), bi("Done", "done", id)], [bi("Stuck", "stuck", id), bi("Skip", "skip", id)]];
export const drillButtons = (id: string): Btn[][] => [[bi("Done", "done", id), bi("10 more min", "more", id)], [bi("Stuck", "stuck", id), bi("Skip", "skip", id)]];
export const shrinkButtons = (id: string): Btn[][] => [[bi("Done", "done", id), bi("Stuck", "stuck", id)]];
export const morningButtons = (day: string): Btn[][] => [[b("Lock it in", "lock", day)], [b("Change", "change", day)], [b("No stakes today", "nostakes", day)]];
export const confirmButtons = (pid: string): Btn[][] => [[b("Yes", "yes", pid), b("No", "no", pid)]];
export const learnButtons = (): Btn[][] => [[{ text: "Open Learn", url: LEARN_URL }]];

export function morningText(a: {
  wins: { start: string; end: string; what: string; step: string }[];
  floating: string[]; top3: string[]; calendar: string[]; stakes: string[]; note: string; stakesMissing: boolean; learnAt: string | null;
}): string {
  const L: string[] = ["Here's today."];
  if (a.note) L.push(a.note);
  L.push("");
  if (a.wins.length) {
    L.push("Drill blocks:");
    for (const w of a.wins) {
      L.push(`${w.start}-${w.end} ${clip(w.what, 80)}`);
      L.push(`  First step: ${clip(w.step, 100)}`);
    }
  } else L.push("No drill blocks today.");
  if (a.floating.length) L.push("", `Also on the list: ${a.floating.map((f) => clip(f, 60)).join("; ")}`);
  if (a.top3.length) L.push(`Top 3: ${a.top3.map((t) => clip(t, 60)).join("; ")}`);
  if (a.calendar.length) L.push(`Calendar: ${a.calendar.join("; ")}`);
  if (a.learnAt) L.push(`Learn round: about 6 minutes, reminder at ${a.learnAt}.`);
  if (a.stakes.length) L.push("", `Suggested stakes: ${a.stakes.map((s) => clip(s, 60)).join("; ")}`);
  else if (a.stakesMissing) L.push("", "Stakes are off until you add a line and a partner in the app.");
  return L.join("\n");
}

export function wrapText(a: { done: string[]; open: string[]; moved: string[]; pauses: string[]; note: string; learn: string | null }): string {
  const L: string[] = ["Day wrap."];
  if (a.note) L.push(a.note);
  L.push("", `Done (${a.done.length}): ${a.done.length ? a.done.map((x) => clip(x, 60)).join("; ") : "nothing checked off yet"}`);
  if (a.open.length) L.push(`Still open: ${a.open.map((x) => clip(x, 60)).join("; ")}`);
  if (a.moved.length) L.push(`Moved: ${a.moved.map((x) => clip(x, 60)).join("; ")}`);
  if (a.learn) L.push(`Learn round: ${a.learn}`);
  if (a.pauses.length) L.push(`Paused at: ${a.pauses.join(", ")}`);
  L.push("", T.top3Ask());
  return L.join("\n");
}

export function todayText(items: DayItem[]): string {
  if (!items.length) return "Today's list is empty.";
  return items.map((i) => `${i.time || "--:--"} ${i.done ? "[x]" : "[ ]"} ${clip(i.what, 80)}`).join("\n");
}
