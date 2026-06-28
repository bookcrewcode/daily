"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, dateStr, type Night as NightT, type ScheduleItem } from "@/lib/supabase";
import { SectionTitle } from "./ui";

function tomorrow() {
  const d = new Date(); d.setDate(d.getDate() + 1); return d;
}

export default function Night({ uid }: { uid: string }) {
  const day = dateStr(tomorrow());
  const pretty = tomorrow().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const [n, setN] = useState<NightT>({ day, items: [], top3: ["", "", ""], notes: "", calendar_synced_at: null });
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("nights").select("*").eq("user_id", uid).eq("day", day).maybeSingle();
    if (data) setN({
      day,
      items: (data.items as ScheduleItem[]) ?? [],
      top3: ((data.top3 as string[]) ?? []).concat(["", "", ""]).slice(0, 3),
      notes: data.notes ?? "",
      calendar_synced_at: data.calendar_synced_at,
    });
  }, [uid, day]);

  useEffect(() => { load(); }, [load]);

  async function persist(next: NightT) {
    setN(next);
    await supabase.from("nights").upsert(
      { user_id: uid, day, items: next.items, top3: next.top3, notes: next.notes },
      { onConflict: "user_id,day" }
    );
    setSaved(true); setTimeout(() => setSaved(false), 1200);
  }

  const setItem = (i: number, patch: Partial<ScheduleItem>) =>
    persist({ ...n, items: n.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) });
  const addItem = () => persist({ ...n, items: [...n.items, { time: "", what: "" }] });
  const delItem = (i: number) => persist({ ...n, items: n.items.filter((_, idx) => idx !== i) });
  const setTop = (i: number, v: string) => persist({ ...n, top3: n.top3.map((t, idx) => (idx === i ? v : t)) });

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">🌙 Nightly Planner</h1>
      <p className="opacity-50 text-sm mt-1">Plan tomorrow — {pretty}. {saved && <span className="text-[var(--neon)]">saved ✓</span>}</p>

      <SectionTitle>Tomorrow&apos;s schedule</SectionTitle>
      <div className="space-y-2">
        {n.items.map((it, i) => (
          <div key={i} className="flex gap-2">
            <input value={it.time} onChange={(e) => setItem(i, { time: e.target.value })} placeholder="9:00"
              className="w-20 rounded-xl bg-white/5 border border-white/10 px-3 py-3 outline-none text-center" />
            <input value={it.what} onChange={(e) => setItem(i, { what: e.target.value })} placeholder="what"
              className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-3 outline-none" />
            <button onClick={() => delItem(i)} className="opacity-40 px-2 active:scale-90">✕</button>
          </div>
        ))}
        <button onClick={addItem} className="w-full rounded-xl border border-dashed border-white/20 py-3 opacity-70 active:scale-95">+ Add time block</button>
      </div>

      <SectionTitle>Top 3 for tomorrow</SectionTitle>
      <div className="space-y-2">
        {n.top3.map((t, i) => (
          <div key={i} className="flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-4 py-3">
            <span className="text-[var(--neon)] font-bold">{i + 1}</span>
            <input value={t} onChange={(e) => setTop(i, e.target.value)} placeholder="…"
              className="flex-1 bg-transparent outline-none" />
          </div>
        ))}
      </div>

      <SectionTitle>Brain dump / notes</SectionTitle>
      <textarea value={n.notes} onChange={(e) => persist({ ...n, notes: e.target.value })} rows={4} placeholder="anything on your mind before bed…"
        className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none resize-none" />

      <SectionTitle>Push to calendar</SectionTitle>
      <button
        onClick={() => alert("Calendar sync is being wired up — ask Claude to finish the Google connection and this button will push your schedule straight to your calendar.")}
        className="w-full rounded-xl bg-white/10 border border-white/15 py-3 font-semibold active:scale-95">
        📅 Sync schedule to Google Calendar
      </button>
      <p className="text-xs opacity-40 mt-2 mb-4">Setup pending — one Google sign-in permission to go.</p>
    </div>
  );
}
