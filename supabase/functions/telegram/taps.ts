// What a Telegram button tap does, and what /pause means. Pure, so it's tested:
// npx --yes tsx --test supabase/functions/telegram/taps.test.ts

export type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
export type Tap = {
  state: "started" | "snoozed" | "skipped" | "done";
  label: string;
  snoozeUntil: string | null;
  keyboard: Keyboard | null; // null = the message loses its buttons
};

export const SNOOZE_MS = 15 * 60_000;

// Starting keeps one Done button so the block can still be finished from
// Telegram; every other tap is final for that message.
export function tapResult(code: string, key: string, nowMs: number): Tap | null {
  switch (code) {
    case "s": return { state: "started", label: "Starting", snoozeUntil: null, keyboard: { inline_keyboard: [[{ text: "Done", callback_data: `d|${key}` }]] } };
    case "z": return { state: "snoozed", label: "Snoozed 15 min", snoozeUntil: new Date(nowMs + SNOOZE_MS).toISOString(), keyboard: null };
    case "k": return { state: "skipped", label: "Skipped today", snoozeUntil: null, keyboard: null };
    case "d": return { state: "done", label: "Done", snoozeUntil: null, keyboard: null };
    default: return null;
  }
}

// "/pause" = 2 hours; "/pause 30m", "/pause 45 min", "/pause 2h", "/pause 3" (hours).
// 5 minutes to 24 hours; anything else is null, so the bot asks instead of guessing.
export function pauseMs(arg: string): number | null {
  const a = arg.trim().toLowerCase();
  if (!a) return 2 * 3_600_000;
  const m = a.match(/^(\d{1,4})\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)?$/);
  if (!m) return null;
  const ms = m[2]?.startsWith("m") ? Number(m[1]) * 60_000 : Number(m[1]) * 3_600_000;
  return ms >= 5 * 60_000 && ms <= 24 * 3_600_000 ? ms : null;
}

export function pauseLabel(ms: number): string {
  const total = Math.round(ms / 60_000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const hours = h ? `${h} hour${h === 1 ? "" : "s"}` : "";
  const mins = m ? `${m} minute${m === 1 ? "" : "s"}` : "";
  return [hours, mins].filter(Boolean).join(" ");
}
