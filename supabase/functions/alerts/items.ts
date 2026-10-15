// Ticking a timetable block from a Telegram button, exactly the way the Card
// does it. If the Card hasn't seeded today's blocks yet (Ben hasn't opened the
// app today), seed them first with the same DayItem shape TheCard.tsx writes
// (src "block", block_id, label + location for classes), then tick.
// Tests: npx --yes tsx --test supabase/functions/alerts/items.test.ts

import type { Block, DayItem } from "./plan.ts";

let seq = 0;
// same format as newItemId() in src/lib/theGame.ts
export function newItemId(): string {
  seq = (seq + 1) % 100000;
  return `i${Date.now().toString(36)}${seq.toString(36)}`;
}

export function tickBlockItem(items: DayItem[], seeded: boolean, blocks: Block[], blockId: string, atSec: number, newId: () => string = newItemId): DayItem[] {
  let list = items.slice();
  if (!seeded) {
    const have = new Set(list.map((i) => i.block_id).filter(Boolean));
    list = [...list, ...blocks.filter((b) => !have.has(b.id)).map((b): DayItem => ({
      id: newId(), time: b.start_t,
      what: `${b.label}${(b.kind ?? "class") === "class" && b.location ? ` · ${b.location}` : ""}`.slice(0, 200),
      src: "block", block_id: b.id,
    }))];
  }
  return list.map((i) => (i.block_id === blockId ? { ...i, done: true, at: atSec } : i));
}
