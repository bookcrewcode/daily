// The day's list is shared: the Plan chat writes it, the Card checks it off.
// Both live in nights.items — but the SCORE (streak, week strip, season map)
// reads game_days.items_done/items_total, so whoever changes the list has to
// mirror the counts or today's cell disagrees with today's ring.
//
// Kept out of theGame.ts on purpose: that file stays pure scoring with no IO.

import { supabase } from "./supabase";
import { type DayItem, type Splits, countDone } from "./theGame";

// Honest stamps for a list that just changed shape: the first tick starts the
// clock, clearing the list stops it, and un-checking work gives the stamp back
// rather than keeping a lie on the record.
export function splitsFor(base: Splits, items: DayItem[], at: number): Splits {
  const sp: Splits = { ...(base ?? {}) };
  const done = countDone(items);
  const total = items.length;
  // Prefer the items' own tap stamps over "now": reconciling a list at 6pm must
  // not backdate the morning's first tick to 6pm and poison the season record.
  const stamps = items.filter((i) => i.done && typeof i.at === "number").map((i) => i.at as number);
  if (done >= 1) { if (sp.first == null) sp.first = stamps.length ? Math.min(...stamps) : at; }
  else delete sp.first;
  if (total >= 1 && done >= total) {
    if (sp.closed == null) sp.closed = stamps.length === total ? Math.max(...stamps) : at;
  } else delete sp.closed;
  return sp;
}

// Partial upsert: PostgREST only writes the columns present in the payload, so
// this can never clobber the bonus chips, the freeze flag, or the learn line.
export async function mirrorCounts(uid: string, day: string, items: DayItem[]): Promise<boolean> {
  const { error } = await supabase.from("game_days").upsert(
    { user_id: uid, day, items_done: countDone(items), items_total: items.length },
    { onConflict: "user_id,day" },
  );
  return !error;
}
