// Shared shapes for the Overseer. DayItem is the app's own type: the agent
// reads and writes the same nights.items list the Card checks off.
import type { DayItem } from "../../../src/lib/theGame";

export type { DayItem };

export type Block = { id: string; label: string; location: string; kind: string; start_t: string; end_t: string };

// A Telegram button: `data` comes back as a tap, `url` opens a link.
export type Btn = { text: string; data?: string; url?: string };

export type Settings = {
  tz: string;
  wake: string;           // "HH:MM" morning plan
  wrap: string;           // "HH:MM" evening wrap
  ping_kinds: string[];   // timetable kinds that get check-ins
  ping_every_min: number;
  cap_usd: number;
  cheap_model: string;
  smart_model: string;
  paused: boolean;
  dry_run: boolean;
  chat_id: number | null;
};

export const DEFAULT_SETTINGS: Settings = {
  tz: "America/New_York",
  wake: "07:30",
  wrap: "21:30",
  ping_kinds: ["study", "work", "read", "drill"],
  ping_every_min: 40,
  cap_usd: 1,
  cheap_model: "google/gemini-3.7-flash",
  smart_model: "anthropic/claude-sonnet-5",
  paused: false,
  dry_run: true,
  chat_id: null,
};

// A stretch of the day that gets check-ins: one timed item whose kind is a
// drill kind. `own` is that item; once it's done, queued untimed tasks fill
// the rest of the window.
export type Win = { key: string; label: string; kind: string; start: number; end: number; own: string };

export type Plan = {
  day: string;
  items: DayItem[];                 // cached nights.items, sorted
  blocks: Block[];                  // today's timetable
  top3: string[];
  refreshed_at: number;
  first_steps: Record<string, string>;
  suggested_stakes: string[];
  stakes: string[];
  stakes_off: boolean;
  locked: boolean;
  morning_sent: boolean;
  wrap_sent: boolean;
  bumped: string[];                 // moved "later today": first in line
  moved: { what: string; to: string }[];
  learn: { on: boolean; at: string } | null;
  learn_nudged: boolean;
};

export function blankPlan(day: string): Plan {
  return {
    day, items: [], blocks: [], top3: [], refreshed_at: 0, first_steps: {}, suggested_stakes: [], stakes: [],
    stakes_off: false, locked: false, morning_sent: false, wrap_sent: false, bumped: [], moved: [], learn: null, learn_nudged: false,
  };
}

// step counts follow-ups since the last message that wanted an answer.
export type Ladder = { win: string | null; task: string | null; step: 0 | 1 | 2 | 3 | 4; awaiting: boolean; next_at: number | null };
export const EMPTY_LADDER: Ladder = { win: null, task: null, step: 0, awaiting: false, next_at: null };

export type Countdown = { task: string; what: string; win: string; ends_at: number; fires_at: number; line_id: string; partner_id: string };

export type Pending = { id: string; tool: string; args: Record<string, unknown>; summary: string };

export type State = {
  plan: Plan | null;
  ladder: Ladder;
  countdown: Countdown | null;
  stakes_sent_day: string | null;
  convo: { role: "user" | "assistant"; content: string }[];
  pauses: number[];
  awaiting_top3_for: string | null;
  cap_notice_day: string | null;
  last_update_id: number;
  pending: Pending[];
};

export function initialState(): State {
  return {
    plan: null, ladder: EMPTY_LADDER, countdown: null, stakes_sent_day: null, convo: [], pauses: [],
    awaiting_top3_for: null, cap_notice_day: null, last_update_id: 0, pending: [],
  };
}

export type Line = { id: string; text: string; used: number };
export type Partner = { id: string; name: string; chat_id: number | null; joined_at: string | null; left_at: string | null; sent: number };
export type ActionRow = { id: string; tool: string; summary: string; before: unknown; after: unknown; undone_at: string | null };

// start/end: local "YYYY-MM-DDTHH:MM:SS" going in; Google's own strings coming back.
export type CalEvent = { id: string; title: string; start: string; end: string };
export interface CalPort {
  listDay(day: string, tz: string): Promise<CalEvent[] | null>;
  create(title: string, start: string, end: string, tz: string): Promise<CalEvent | null>;
  move(id: string, start: string, end: string, tz: string): Promise<CalEvent | null>;
  get(id: string): Promise<CalEvent | null>;
  remove(id: string): Promise<boolean>;
}
