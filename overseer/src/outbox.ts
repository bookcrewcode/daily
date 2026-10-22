// What the agent does with each queued message. Pure, so it's tested
// (test/outbox.test.ts); agent.ts does the sending and the bookkeeping.
import type { Out } from "./core/brain";
import type { SettingsRow } from "./core/db";

// null = hold the message: without settings we know neither the chat nor dry run.
export function routeOf(o: Out, s: SettingsRow | null): { chat: number | null; dry: boolean } | null {
  if (!s) return null;
  return { chat: o.chat === "ben" ? s.chat_id : o.chat, dry: !o.force && s.dry_run };
}

// A 4xx other than 429 means Telegram will never take this message (a bad
// button, a blocked bot): drop it now. Anything else gets three tries.
export function afterSend(r: { ok: boolean; status: number } | "logged", tries: number): "delete" | "retry" | "drop" {
  if (r === "logged" || r.ok) return "delete";
  if (r.status >= 400 && r.status < 500 && r.status !== 429) return "drop";
  return tries >= 2 ? "drop" : "retry";
}
