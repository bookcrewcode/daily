// The Card's one line about reading: minutes against the 40-minute slot and
// whether the active book's drill is done. A failed read returns null (no
// chip), never a fake "0 min".
import { supabase, todayStr } from "@/lib/supabase";
import { weekStart } from "@/lib/theGame";
import { drillDone, DRILLS, SLOT_MINUTES, type Drill, type Entry } from "@/lib/reading";

export type ReadChip = { title: string; minutes: number; drill: Drill; drillName: string; drillOk: boolean };

export async function loadReadChip(uid: string): Promise<ReadChip | null> {
  const today = todayStr();
  const wk = weekStart(today);
  const [b, s, e] = await Promise.all([
    supabase.from("reading_books").select("id,title,drill").eq("user_id", uid).eq("status", "active").maybeSingle(),
    supabase.from("reading_sessions").select("minutes").eq("user_id", uid).eq("day", today),
    supabase.from("reading_entries").select("id,book_id,kind,day,data,created_at").eq("user_id", uid).gte("day", wk < today ? wk : today).limit(500),
  ]);
  if (b.error || s.error || e.error || !b.data) return null;
  const drill = b.data.drill as Drill;
  // predictions can be cleared by scoring an old one today, so the drill check
  // needs those too — fetch them separately only when that's the drill
  let entries = (e.data ?? []) as Entry[];
  if (drill === "predict") {
    const p = await supabase.from("reading_entries").select("id,book_id,kind,day,data,created_at").eq("user_id", uid).eq("kind", "predict").limit(1000);
    if (p.error) return null;
    entries = (p.data ?? []) as Entry[];
  }
  return {
    title: String(b.data.title),
    minutes: ((s.data ?? []) as { minutes: number }[]).reduce((t, r) => t + r.minutes, 0),
    drill, drillName: DRILLS[drill].name, drillOk: drillDone(drill, entries, today, wk),
  };
}

export const readChipText = (c: ReadChip) =>
  `${Math.min(c.minutes, 999)}/${SLOT_MINUTES} min · ${c.drillOk ? "drill done" : "drill open"} · ${c.title.split(":")[0]}`;
