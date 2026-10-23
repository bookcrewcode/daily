// Run: npx --yes tsx --test supabase/functions/alerts/items.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tickBlockItem, tickGoalItem, newItemId } from "./items.ts";
import type { Block, DayItem } from "./plan.ts";

const blocks: Block[] = [
  { id: "b-class", kind: "class", label: "Precalculus", location: "Conklin 349", start_t: "10:00", end_t: "10:55" },
  { id: "b-gym", kind: "gym", label: "Gym 1.5h", location: "", start_t: "17:00", end_t: "18:30" },
];
let n = 0;
const ids = () => `t${++n}`;

test("unseeded day: seeds the timetable like the Card, then ticks the block", () => {
  const mine: DayItem[] = [{ id: "a", time: "", what: "Call mom" }];
  const out = tickBlockItem(mine, false, blocks, "b-gym", 61_200, ids);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], mine[0]);
  assert.deepEqual(out[1], { id: "t1", time: "10:00", what: "Precalculus · Conklin 349", src: "block", block_id: "b-class" });
  assert.deepEqual(out[2], { id: "t2", time: "17:00", what: "Gym 1.5h", src: "block", block_id: "b-gym", done: true, at: 61_200 });
});

test("seeded day: only ticks, never re-adds a block Ben removed", () => {
  const list: DayItem[] = [{ id: "x", time: "17:00", what: "Gym 1.5h", src: "block", block_id: "b-gym" }];
  assert.deepEqual(tickBlockItem(list, true, blocks, "b-gym", 100, ids), [{ ...list[0], done: true, at: 100 }]);
  assert.deepEqual(tickBlockItem(list, true, blocks, "b-class", 100, ids), list);
});

test("newItemId matches the app's id shape", () => {
  assert.match(newItemId(), /^i[0-9a-z]+$/);
});

test("Done on a deadline ticks its goal item on today's list, and touches nothing else", () => {
  const list: DayItem[] = [
    { id: "g", time: "", what: "HW 5 Set 5", src: "goal", goal_id: "goal-1" },
    { id: "x", time: "17:00", what: "Gym 1.5h", src: "block", block_id: "b-gym" },
  ];
  assert.deepEqual(tickGoalItem(list, "goal-1", 500), [{ ...list[0], done: true, at: 500 }, list[1]]);
  assert.deepEqual(tickGoalItem(list, "goal-2", 500), list);
});
