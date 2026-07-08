"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, dateStr, type Night as NightT, type ScheduleItem } from "@/lib/supabase";
import { useVoiceInput } from "@/lib/useVoiceInput";
import { SectionTitle, Card } from "./ui";
import { parseTime, fmtMinutes, resolveBlocks, gcalTemplateUrl, downloadIcs } from "@/lib/calendar";
import CalendarCard from "./CalendarCard";

function tomorrow() {
  const d = new Date(); d.setDate(d.getDate() + 1); return d;
}

export default function Night({ uid }: { uid: string }) {
  // ticks each minute so `day` rolls over correctly in a PWA left open overnight
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60000);
    const onVisible = () => setTick((t) => t + 1);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  const day = dateStr(tomorrow());
  const pretty = tomorrow().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const [n, setN] = useState<NightT>({ day, items: [], top3: ["", "", ""], notes: "", calendar_synced_at: null });
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteBase = useRef("");
  const voice = useVoiceInput((text) => {
    const combined = (noteBase.current ? noteBase.current.trimEnd() + " " : "") + text;
    persistRef.current({ ...nRef.current, notes: combined });
  });
  const nRef = useRef(n);
  nRef.current = n;
  const persistRef = useRef((next: NightT) => { void next; });

  const load = useCallback(async () => {
    const { data } = await supabase.from("nights").select("*").eq("user_id", uid).eq("day", day).maybeSingle();
    if (data) {
      setN({
        day,
        items: (data.items as ScheduleItem[]) ?? [],
        top3: ((data.top3 as string[]) ?? []).concat(["", "", ""]).slice(0, 3),
        notes: data.notes ?? "",
        calendar_synced_at: data.calendar_synced_at,
      });
    } else {
      // no plan for this target day yet — reset instead of carrying stale
      // state across a midnight rollover (which would silently copy
      // yesterday's plan onto the new day on the next keystroke)
      setN({ day, items: [], top3: ["", "", ""], notes: "", calendar_synced_at: null });
    }
  }, [uid, day]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Update UI instantly; write to the DB at most ~once per pause in typing.
  function persist(next: NightT) {
    setN(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await supabase.from("nights").upsert(
        { user_id: uid, day, items: next.items, top3: next.top3, notes: next.notes },
        { onConflict: "user_id,day" }
      );
      setSaved(true); setTimeout(() => setSaved(false), 1200);
    }, 600);
  }
  persistRef.current = persist;

  const setItem = (i: number, patch: Partial<ScheduleItem>) =>
    persist({ ...n, items: n.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) });
  const addItem = () => persist({ ...n, items: [...n.items, { time: "", what: "" }] });
  const delItem = (i: number) => persist({ ...n, items: n.items.filter((_, idx) => idx !== i) });
  const setTop = (i: number, v: string) => persist({ ...n, top3: n.top3.map((t, idx) => (idx === i ? v : t)) });

  const blocks = resolveBlocks(n.items, tomorrow());

  async function markSynced() {
    const at = new Date().toISOString();
    setN((x) => ({ ...x, calendar_synced_at: at }));
    await supabase.from("nights").upsert(
      { user_id: uid, day, items: n.items, top3: n.top3, notes: n.notes, calendar_synced_at: at },
      { onConflict: "user_id,day" }
    );
  }

  function pushAllIcs() {
    if (!blocks.length) return;
    downloadIcs(blocks, `plan-${day}.ics`);
    markSynced();
  }

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">🌙 Nightly Planner</h1>
      <p className="opacity-50 text-sm mt-1">
        Plan tomorrow — {pretty}. <span className={`text-[var(--neon)] transition-opacity ${saved ? "opacity-100" : "opacity-0"}`}>saved ✓</span>
      </p>

      <SectionTitle>Already on the calendar</SectionTitle>
      <CalendarCard uid={uid} day={tomorrow()} title={`Tomorrow · Google Calendar`} />

      <SectionTitle>Tomorrow&apos;s schedule</SectionTitle>
      <div className="space-y-2">
        {n.items.map((it, i) => {
          const mins = parseTime(it.time);
          return (
            <div key={i} className="flex gap-2 items-center">
              <div className="w-24 shrink-0">
                <input value={it.time} onChange={(e) => setItem(i, { time: e.target.value })} placeholder="9:00"
                  className="w-full rounded-xl bg-white/5 border border-white/10 px-2 py-3 outline-none text-center" />
                {it.time && (
                  <p className={`text-[9px] text-center mt-0.5 ${mins === null ? "text-orange-400" : "opacity-40"}`}>
                    {mins === null ? "time?" : fmtMinutes(mins)}
                  </p>
                )}
              </div>
              <input value={it.what} onChange={(e) => setItem(i, { what: e.target.value })} placeholder="what"
                className="flex-1 min-w-0 rounded-xl bg-white/5 border border-white/10 px-3 py-3 outline-none self-start" />
              <button onClick={() => delItem(i)} className="opacity-40 px-2 active:scale-90 self-start py-3">✕</button>
            </div>
          );
        })}
        <button onClick={addItem} className="w-full rounded-xl border border-dashed border-white/20 py-3 opacity-70 active:scale-95">+ Add time block</button>
      </div>

      {blocks.length > 0 && (
        <>
          <SectionTitle>Push to Google Calendar</SectionTitle>
          <Card>
            <div className="space-y-2">
              {blocks.map((b, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 min-w-0 truncate">
                    <span className="text-[var(--neon)]/80 font-semibold text-xs mr-2 tabular-nums">
                      {b.start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </span>
                    {b.what}
                  </span>
                  <a href={gcalTemplateUrl(b.what, b.start, b.end)} target="_blank" rel="noreferrer" onClick={markSynced}
                    className="shrink-0 text-[10px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--neon)]/20 text-[var(--neon)] active:scale-95">
                    + GCal ↗
                  </a>
                </div>
              ))}
            </div>
            <button onClick={pushAllIcs}
              className="mt-3 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">
              📅 Add all {blocks.length} to calendar (.ics)
            </button>
            <p className="text-[10px] opacity-40 mt-2">
              The .ics opens in your calendar app and imports every block at once. Single blocks: the ↗ buttons prefill Google Calendar directly.
              {n.calendar_synced_at && <span className="text-[var(--neon)]/70"> · last pushed {new Date(n.calendar_synced_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>}
            </p>
          </Card>
        </>
      )}

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
      <div className="relative mb-4">
        <textarea value={n.notes} onChange={(e) => persist({ ...n, notes: e.target.value })} rows={4}
          placeholder={voice.listening ? "listening… just talk" : "anything on your mind before bed…"}
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 pr-14 outline-none resize-none" />
        {voice.supported && (
          <button onClick={() => { noteBase.current = n.notes; voice.toggle(); }}
            className={`absolute right-2.5 top-2.5 w-10 h-10 rounded-xl grid place-items-center active:scale-90 ${voice.listening ? "bg-red-500 text-white animate-pulse" : "bg-white/10"}`}>
            🎤
          </button>
        )}
      </div>
    </div>
  );
}
