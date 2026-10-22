// Mirror of TheCard.tsx's once-a-day seeding, so whichever opens the day
// first (the Card or the Overseer's morning) builds the same list:
// the weekday timetable joins once (blocks_seeded), deadlines due join
// additively, and a failed read never seeds or wipes anything.
import { newItemId, normalizeItems, type DayItem } from "../../../src/lib/theGame";
import type { Block } from "./types";

export function seedDay(
  raw: unknown,
  blocksSeeded: boolean,
  blocks: Block[] | null,
  goalsDue: { id: string; title: string }[] | null,
): { items: DayItem[]; blocks_seeded: boolean; changed: boolean } {
  let items = normalizeItems(raw);
  let seeded = blocksSeeded;
  let changed = false;
  if (blocks && !blocksSeeded) {
    const have = new Set(items.map((i) => i.block_id).filter(Boolean));
    const add: DayItem[] = blocks
      .filter((c) => !have.has(c.id))
      .map((c) => ({
        id: newItemId(),
        time: c.start_t,
        what: `${c.label}${(c.kind ?? "class") === "class" && c.location ? ` · ${c.location}` : ""}`.slice(0, 200),
        src: "block" as const,
        block_id: c.id,
      }));
    items = [...items, ...add];
    seeded = true;
    changed = true;
  }
  if (goalsDue) {
    const have = new Set(items.map((i) => i.goal_id).filter(Boolean));
    const add: DayItem[] = goalsDue
      .filter((g) => !have.has(g.id))
      .map((g) => ({ id: newItemId(), time: "", what: g.title.slice(0, 200), src: "goal" as const, goal_id: g.id }));
    if (add.length) {
      items = [...items, ...add];
      changed = true;
    }
  }
  return { items, blocks_seeded: seeded, changed };
}
