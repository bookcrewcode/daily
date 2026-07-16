"use client";

// Full-screen day editor for Google Calendar. Tap an empty slot to add,
// tap an event to edit — retitle, retime (±15m nudges move the whole
// block), stretch/shrink, delete. Every change writes straight to GCal.
//
// Cross-midnight safety: all math is relative to the DISPLAYED day's
// midnight, and events whose endpoints fall on other days render (clamped)
// but are NOT editable here — re-anchoring them onto one day would silently
// corrupt the real calendar (an 8h overnighter becoming a 15-min block).

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { dateStr } from "@/lib/supabase";
import { listDay, createEvent, patchEvent, deleteEvent, acquireToken, NeedsAuth, type GEvent } from "@/lib/gcal";
import { sfx, buzz } from "@/lib/fx";

const START_H = 6, END_H = 23;          // visible window
const HOUR_PX = 56;

type Draft = {
  id: string | null;                     // null = new event
  title: string;
  startMins: number;                     // minutes since displayed-day midnight
  endMins: number;
};

const fmtT = (mins: number) => {
  const m = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
};
const toHHMM = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const fromHHMM = (v: string): number | null => {
  const m = v.match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
// wall-clock day-relative minutes (NOT elapsed ms — that shifts an hour on
// DST days): calendar-day offset × 1440 + local time of day
const relMins = (iso: string, day: Date) => {
  const d = new Date(iso);
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
     new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()) / 86400000,
  );
  return dayDiff * 1440 + d.getHours() * 60 + d.getMinutes();
};
const atMins = (day: Date, mins: number) => { const d = new Date(day); d.setHours(0, mins, 0, 0); return d; };
const spansDays = (ev: GEvent, day: Date) =>
  relMins(ev.start.dateTime!, day) < 0 || relMins(ev.end.dateTime!, day) > 24 * 60;

export default function CalendarEditor({ clientId, initialDay, onClose, onChanged }: {
  clientId: string;
  initialDay: Date;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [day, setDay] = useState(new Date(initialDay));
  const [events, setEvents] = useState<GEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const dayKey = dateStr(day);
  const isToday = dayKey === dateStr(new Date());

  const load = useCallback(async () => {
    setLoading(true); setError(""); setNeedsAuth(false);
    try {
      setEvents(await listDay(clientId, new Date(dayKey + "T12:00:00")));
    } catch (e) {
      if (e instanceof NeedsAuth) setNeedsAuth(true);
      else setError(e instanceof Error ? e.message : "Couldn't load the calendar.");
    } finally {
      setLoading(false);
    }
  }, [clientId, dayKey]);

  useEffect(() => { load(); }, [load]);

  async function reconnect() {
    const t = await acquireToken(clientId, true);
    if (t) load();
    else setError("Google didn't grant access — try again.");
  }

  function shiftDay(delta: number) {
    setDay((d) => { const n = new Date(d); n.setDate(n.getDate() + delta); return n; });
  }

  function tapGrid(e: React.MouseEvent) {
    if (draft || !gridRef.current) return;
    const rect = gridRef.current.getBoundingClientRect();
    const mins = START_H * 60 + Math.floor(((e.clientY - rect.top) / HOUR_PX) * 60);
    const snapped = Math.round(mins / 30) * 30;
    setDraft({ id: null, title: "", startMins: snapped, endMins: Math.min(snapped + 60, 24 * 60 - 5) });
  }

  function openEvent(ev: GEvent) {
    if (!ev.start.dateTime || !ev.end.dateTime) return; // all-day: not editable here
    if (spansDays(ev, day)) {
      setError("That event spans days — edit it in Google Calendar directly.");
      setTimeout(() => setError(""), 3500);
      return;
    }
    setDraft({ id: ev.id, title: ev.summary ?? "", startMins: relMins(ev.start.dateTime, day), endMins: relMins(ev.end.dateTime, day) });
  }

  function nudge(d: Draft, deltaStart: number, deltaEnd: number): Draft {
    let s = d.startMins + deltaStart, en = d.endMins + deltaEnd;
    s = Math.max(0, Math.min(s, 24 * 60 - 15));
    en = Math.max(s + 15, Math.min(en, 24 * 60));
    return { ...d, startMins: s, endMins: en };
  }

  async function saveDraft() {
    if (!draft || busy) return;
    const title = draft.title.trim() || "(untitled)";
    setBusy(true); setError("");
    try {
      if (draft.id) {
        await patchEvent(clientId, draft.id, { summary: title, start: atMins(day, draft.startMins), end: atMins(day, draft.endMins) });
      } else {
        await createEvent(clientId, title, atMins(day, draft.startMins), atMins(day, draft.endMins));
      }
      sfx.pop(); buzz(15);
      setDraft(null);
      await load();
      onChanged?.();
    } catch (e) {
      if (e instanceof NeedsAuth) setNeedsAuth(true);
      setError(e instanceof Error && e.message !== "needs-auth" ? e.message : "");
    } finally {
      setBusy(false);
    }
  }

  async function removeDraft() {
    if (!draft?.id || busy) return;
    setBusy(true); setError("");
    try {
      await deleteEvent(clientId, draft.id);
      buzz(20);
      setDraft(null);
      await load();
      onChanged?.();
    } catch (e) {
      if (e instanceof NeedsAuth) setNeedsAuth(true);
      setError(e instanceof Error && e.message !== "needs-auth" ? e.message : "");
    } finally {
      setBusy(false);
    }
  }

  const timed = events.filter((e) => e.start.dateTime && e.end.dateTime);
  const allDay = events.filter((e) => e.start.date);
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();

  // Portal to <body>: this <div> is fixed inset-0, but any ancestor with a
  // backdrop-filter (CalendarCard's <Card>) becomes the containing block for
  // fixed children, which would trap the "fullscreen" editor inside the card.
  return createPortal(
    <div className="fixed inset-0 z-40 bg-[var(--background)] flex flex-col max-w-md mx-auto md:max-w-2xl">
      {/* header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <button onClick={() => shiftDay(-1)} className="px-3 py-1.5 rounded-lg bg-white/5 active:scale-90">‹</button>
        <button onClick={() => setDay(new Date())} className="flex-1 text-center">
          <p className="font-bold text-sm">{day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
          <p className="text-[10px] opacity-40">{isToday ? "today · " : ""}tap a slot to add · tap an event to edit</p>
        </button>
        <button onClick={() => shiftDay(1)} className="px-3 py-1.5 rounded-lg bg-white/5 active:scale-90">›</button>
        <button onClick={onClose} className="opacity-60 text-lg px-2 active:scale-90">✕</button>
      </div>

      {needsAuth && (
        <div className="m-4 rounded-2xl border border-[var(--neon)]/40 bg-[var(--neon)]/10 p-4 text-center">
          <p className="text-sm font-medium mb-2">Google needs a quick re-connect to edit your calendar.</p>
          <button onClick={reconnect} className="px-5 py-2.5 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">🔗 Connect Google Calendar</button>
        </div>
      )}
      {error && <p className="mx-4 mt-2 text-xs text-orange-400">{error}</p>}

      {/* all-day strip */}
      {allDay.length > 0 && (
        <div className="px-4 py-2 border-b border-white/10 flex flex-wrap gap-1.5">
          {allDay.map((e) => (
            <span key={e.id} className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-white/10">{e.summary ?? "(untitled)"}</span>
          ))}
        </div>
      )}

      {/* day grid */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-4 space-y-2"><div className="skeleton h-10" /><div className="skeleton h-10 w-2/3" /></div>
        ) : (
          <div className="flex px-2 py-3">
            <div className="w-12 shrink-0 relative" style={{ height: (END_H - START_H) * HOUR_PX }}>
              {Array.from({ length: END_H - START_H }, (_, i) => (
                <span key={i} className="absolute right-2 text-[10px] opacity-35 -translate-y-1/2" style={{ top: i * HOUR_PX }}>
                  {fmtT((START_H + i) * 60)}
                </span>
              ))}
            </div>
            <div ref={gridRef} onClick={tapGrid} className="flex-1 relative rounded-xl bg-white/[0.03]" style={{ height: (END_H - START_H) * HOUR_PX }}>
              {Array.from({ length: END_H - START_H }, (_, i) => (
                <div key={i} className="absolute left-0 right-0 border-t border-white/[0.06]" style={{ top: i * HOUR_PX }} />
              ))}
              {isToday && nowMins >= START_H * 60 && nowMins <= END_H * 60 && (
                <div className="absolute left-0 right-0 z-10 pointer-events-none" style={{ top: ((nowMins - START_H * 60) / 60) * HOUR_PX }}>
                  <div className="h-[2px] bg-red-400/80" />
                  <div className="w-2 h-2 rounded-full bg-red-400 -mt-[5px]" />
                </div>
              )}
              {timed.map((ev) => {
                // day-relative endpoints; clamp into the visible window without
                // ever re-anchoring the underlying instants
                const sRel = relMins(ev.start.dateTime!, day);
                const enRel = relMins(ev.end.dateTime!, day);
                if (enRel <= 0 || sRel >= 24 * 60) return null; // other days entirely
                let s = Math.max(sRel, START_H * 60);
                let en = Math.min(enRel, END_H * 60);
                if (en <= s) {
                  // real event outside the 6am–11pm window (early flight, late
                  // night) — pin a visible sliver instead of silently hiding it,
                  // or a just-created 11pm event would "vanish" and invite dupes
                  if (sRel >= END_H * 60) { s = END_H * 60 - 26 / (HOUR_PX / 60); en = END_H * 60; }
                  else { s = START_H * 60; en = START_H * 60 + 26 / (HOUR_PX / 60); }
                }
                const cross = spansDays(ev, day);
                const top = ((s - START_H * 60) / 60) * HOUR_PX;
                const height = Math.max(((en - s) / 60) * HOUR_PX, 26);
                return (
                  <button key={ev.id} onClick={(e) => { e.stopPropagation(); openEvent(ev); }}
                    className={`absolute left-1 right-1 rounded-lg border px-2 py-1 text-left overflow-hidden active:scale-[0.99] ${cross ? "border-sky-400/40 bg-sky-400/10" : "border-[var(--neon)]/50 bg-[var(--neon)]/15"}`}
                    style={{ top, height }}>
                    <p className="text-xs font-bold leading-tight truncate">{cross ? "↔ " : ""}{ev.summary ?? "(untitled)"}</p>
                    <p className="text-[10px] opacity-60">{fmtT(sRel)}–{fmtT(enRel)}{cross ? " · spans days" : ""}</p>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* edit sheet */}
      {draft && (
        <div className="border-t border-white/10 bg-[var(--background)] p-4 pb-6" style={{ animation: "fadeSlide 0.2s ease" }}>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs uppercase tracking-widest opacity-50">{draft.id ? "Edit event" : "New event"}</p>
            <button onClick={() => setDraft(null)} className="opacity-40 active:scale-90">✕</button>
          </div>
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && saveDraft()} placeholder="what's happening?" autoFocus={!draft.id}
            className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none mb-2" />
          <div className="flex items-center gap-2 mb-2">
            <input type="time" value={toHHMM(draft.startMins)}
              onChange={(e) => { const v = fromHHMM(e.target.value); if (v != null) setDraft(nudge({ ...draft, startMins: v }, 0, 0)); }}
              className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 outline-none text-center" />
            <span className="opacity-40">→</span>
            <input type="time" value={toHHMM(draft.endMins)}
              onChange={(e) => { const v = fromHHMM(e.target.value); if (v != null) setDraft(nudge({ ...draft, endMins: v }, 0, 0)); }}
              className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 outline-none text-center" />
          </div>
          <div className="flex gap-2 mb-3 text-xs">
            <button onClick={() => setDraft(nudge(draft, -15, -15))} className="flex-1 rounded-lg bg-white/10 py-2 font-semibold active:scale-95">◂ move 15m</button>
            <button onClick={() => setDraft(nudge(draft, 15, 15))} className="flex-1 rounded-lg bg-white/10 py-2 font-semibold active:scale-95">move 15m ▸</button>
            <button onClick={() => setDraft(nudge(draft, 0, -15))} className="flex-1 rounded-lg bg-white/10 py-2 font-semibold active:scale-95">− shorter</button>
            <button onClick={() => setDraft(nudge(draft, 0, 15))} className="flex-1 rounded-lg bg-white/10 py-2 font-semibold active:scale-95">longer +</button>
          </div>
          <div className="flex gap-2">
            {draft.id && (
              <button onClick={removeDraft} disabled={busy}
                className="px-4 rounded-xl bg-red-500/15 border border-red-500/40 text-red-300 font-bold py-3 active:scale-95 disabled:opacity-40">
                Delete
              </button>
            )}
            <button onClick={saveDraft} disabled={busy}
              className="flex-1 rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-40">
              {busy ? "…" : draft.id ? `Save · ${fmtT(draft.startMins)}–${fmtT(draft.endMins)}` : `Add · ${fmtT(draft.startMins)}–${fmtT(draft.endMins)}`}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

// Push a batch of planned blocks straight into Google Calendar (Night tab).
// Continues past individual failures; returns how many actually landed.
export async function pushBlocks(clientId: string, blocks: { what: string; start: Date; end: Date }[]): Promise<number> {
  let created = 0;
  for (const b of blocks) {
    try {
      await createEvent(clientId, b.what, b.start, b.end);
      created++;
    } catch (e) {
      if (e instanceof NeedsAuth) throw e; // auth problems affect every block — surface immediately
      // otherwise keep going; partial push is better than none
    }
  }
  return created;
}
