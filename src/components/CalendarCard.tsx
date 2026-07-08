"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fetchCalendarEvents, type CalEvent } from "@/lib/calendar";
import { Card } from "./ui";

function fmtRange(ev: CalEvent): string {
  if (ev.allDay) return "All day";
  const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  return `${new Date(ev.start).toLocaleTimeString(undefined, opts)}–${new Date(ev.end).toLocaleTimeString(undefined, opts)}`;
}

export default function CalendarCard({ uid, day, title }: { uid: string; day: Date; title: string }) {
  const [icsUrl, setIcsUrl] = useState<string | null>(null); // null = still loading settings
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const dayKey = day.toDateString();

  useEffect(() => {
    supabase.from("user_settings").select("gcal_ics_url").eq("user_id", uid).maybeSingle()
      .then(({ data }) => setIcsUrl(data?.gcal_ics_url ?? ""));
  }, [uid]);

  const loadEvents = useCallback(async (url: string) => {
    setBusy(true); setError("");
    try {
      setEvents(await fetchCalendarEvents(url, new Date(dayKey)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your calendar.");
      setEvents(null);
    } finally {
      setBusy(false);
    }
  }, [dayKey]);

  useEffect(() => { if (icsUrl) loadEvents(icsUrl); }, [icsUrl, loadEvents]);

  async function saveUrl() {
    const url = draft.trim();
    if (!url) return;
    setIcsUrl(url); setEditing(false); setDraft("");
    await supabase.from("user_settings").upsert({ user_id: uid, gcal_ics_url: url }, { onConflict: "user_id" });
  }

  if (icsUrl === null) return <div className="skeleton h-16" />;

  // Not connected yet → one-time setup
  if (!icsUrl || editing) {
    return (
      <Card>
        <p className="text-xs uppercase tracking-widest opacity-60 mb-1">📅 {title}</p>
        <p className="text-sm opacity-70 leading-snug">
          Connect Google Calendar once: <b>calendar.google.com → ⚙️ Settings → your calendar → Integrate calendar →
          copy “Secret address in iCal format”</b> and paste it here. Read-only, stays private to you.
        </p>
        <div className="flex gap-2 mt-3">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
            className="flex-1 min-w-0 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
          <button onClick={saveUrl} className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">Connect</button>
        </div>
        {editing && <button onClick={() => setEditing(false)} className="text-xs opacity-40 underline mt-2">cancel</button>}
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs uppercase tracking-widest opacity-60">📅 {title}</p>
        <div className="flex gap-3">
          <button onClick={() => loadEvents(icsUrl)} className={`text-xs opacity-50 active:scale-90 ${busy ? "animate-spin" : ""}`}>↻</button>
          <button onClick={() => { setEditing(true); setDraft(icsUrl); }} className="text-xs opacity-30 underline">edit</button>
        </div>
      </div>

      {busy && events === null && <div className="space-y-1.5"><div className="skeleton h-5" /><div className="skeleton h-5 w-2/3" /></div>}
      {error && <p className="text-xs text-orange-400">{error}</p>}
      {events && events.length === 0 && !error && <p className="text-sm opacity-40">Nothing on the calendar — open day. 🙌</p>}
      {events && events.length > 0 && (
        <div className="space-y-1.5">
          {events.map((ev, i) => (
            <div key={i} className="flex items-baseline gap-2 text-sm">
              <span className="shrink-0 w-[7.5rem] text-xs font-semibold text-[var(--neon)]/80 tabular-nums">{fmtRange(ev)}</span>
              <span className="min-w-0 truncate font-medium">{ev.title}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
