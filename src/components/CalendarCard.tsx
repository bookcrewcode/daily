"use client";

// Calendar on Today/Night. Two modes:
//  EDIT mode (Google OAuth client ID connected) — live events from the
//    Calendar API + a full day editor (add/move/delete syncs to GCal).
//  READ mode (secret iCal address) — view-only fallback, zero setup.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fetchCalendarEvents, type CalEvent } from "@/lib/calendar";
import { listDay, acquireToken, everGranted, NeedsAuth, type GEvent } from "@/lib/gcal";
import { Card } from "./ui";
import CalendarEditor from "./CalendarEditor";

function fmtT(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

type Row = { title: string; time: string; repeating?: boolean };

export default function CalendarCard({ uid, day, title }: { uid: string; day: Date; title: string }) {
  const [settings, setSettings] = useState<{ ics: string; clientId: string } | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [mode, setMode] = useState<"api" | "ics" | "none">("none");
  const [needsConnect, setNeedsConnect] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [draftIcs, setDraftIcs] = useState("");
  const [draftClient, setDraftClient] = useState("");
  // Standing weekly series turn every day into the same wallpaper. Hiding them
  // keeps each day's card specific to THAT day. Device-local, reversible.
  const [hideRepeats, setHideRepeats] = useState(false);
  useEffect(() => {
    try { setHideRepeats(localStorage.getItem("daily.cal.hideRepeats") === "1"); } catch { /* storage blocked */ }
  }, []);
  function toggleRepeats() {
    setHideRepeats((v) => {
      const next = !v;
      try { localStorage.setItem("daily.cal.hideRepeats", next ? "1" : "0"); } catch { /* storage blocked */ }
      return next;
    });
  }

  const dayKey = day.toDateString();

  const loadSettings = useCallback(async () => {
    const { data } = await supabase.from("user_settings").select("gcal_ics_url,gcal_client_id").eq("user_id", uid).maybeSingle();
    setSettings({ ics: data?.gcal_ics_url ?? "", clientId: data?.gcal_client_id ?? "" });
  }, [uid]);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  const loadEvents = useCallback(async () => {
    if (!settings) return;
    setBusy(true); setError(""); setNeedsConnect(false);
    try {
      if (settings.clientId && everGranted()) {
        try {
          const evs: GEvent[] = await listDay(settings.clientId, new Date(dayKey));
          setRows(evs.map((e) => ({
            title: e.summary ?? "(untitled)",
            time: e.start.dateTime ? `${fmtT(e.start.dateTime)}–${e.end.dateTime ? fmtT(e.end.dateTime) : ""}` : "All day",
          })));
          setMode("api");
          return;
        } catch (e) {
          // ANY api failure falls through to the ICS fallback when configured —
          // that's the whole point of keeping the secret address around
          if (e instanceof NeedsAuth) setNeedsConnect(true);
          else if (!settings.ics) throw e;
        }
      } else if (settings.clientId) {
        setNeedsConnect(true);
      }
      if (settings.ics) {
        const evs: CalEvent[] = await fetchCalendarEvents(settings.ics, new Date(dayKey));
        setRows(evs.map((e) => ({
          title: e.title,
          time: e.allDay ? "All day" : `${fmtT(e.start)}–${fmtT(e.end)}`,
          repeating: e.repeating,
        })));
        setMode("ics");
      } else if (!settings.clientId) {
        setMode("none");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your calendar.");
    } finally {
      setBusy(false);
    }
  }, [settings, dayKey]);
  useEffect(() => { loadEvents(); }, [loadEvents]);

  async function connect() {
    if (!settings?.clientId) return;
    setError("");
    const t = await acquireToken(settings.clientId, true);
    if (t) loadEvents();
    else setError("Google didn't grant access — check the Client ID and that you added yourself as a test user.");
  }

  async function saveSetup() {
    const ics = draftIcs.trim(), clientId = draftClient.trim();
    const patch: Record<string, string> = {};
    if (ics !== settings?.ics) patch.gcal_ics_url = ics;
    if (clientId !== settings?.clientId) patch.gcal_client_id = clientId;
    if (Object.keys(patch).length) {
      await supabase.from("user_settings").upsert({ user_id: uid, ...patch }, { onConflict: "user_id" });
    }
    setSetupOpen(false); setDraftIcs(""); setDraftClient("");
    loadSettings();
  }

  if (!settings) return <div className="skeleton h-16" />;

  // Recurring series are "wallpaper" — same blocks every single day. Filter
  // them out so the card shows what's actually specific to THIS day.
  const repeatCount = (rows ?? []).filter((r) => r.repeating).length;
  const shown = hideRepeats ? (rows ?? []).filter((r) => !r.repeating) : (rows ?? []);
  const hiddenCount = (rows ?? []).length - shown.length;

  const nothingConfigured = !settings.ics && !settings.clientId;

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs uppercase tracking-widest opacity-60">📅 {title}</p>
        <div className="flex items-center gap-3">
          {mode === "api" && (
            <button onClick={() => setEditorOpen(true)}
              className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-[var(--neon)]/20 text-[var(--neon)] active:scale-95">
              ✏️ Edit
            </button>
          )}
          <button onClick={loadEvents} className={`text-xs opacity-50 active:scale-90 ${busy ? "animate-spin" : ""}`}>↻</button>
          <button onClick={() => { setSetupOpen((v) => !v); setDraftIcs(settings.ics); setDraftClient(settings.clientId); }}
            className="text-xs opacity-30 underline">setup</button>
        </div>
      </div>

      {needsConnect && settings.clientId && (
        <button onClick={connect}
          className="w-full mb-2 rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">
          🔗 Connect Google Calendar {mode === "ics" ? "(enables editing)" : ""}
        </button>
      )}

      {busy && rows === null && <div className="space-y-1.5"><div className="skeleton h-5" /><div className="skeleton h-5 w-2/3" /></div>}
      {error && <p className="text-xs text-orange-400 mb-1">{error}</p>}
      {rows && shown.length === 0 && !error && (
        <p className="text-sm opacity-40">
          {hiddenCount > 0
            ? `Nothing one-off today — ${hiddenCount} repeating ${hiddenCount === 1 ? "event" : "events"} hidden. 🙌`
            : "Nothing on the calendar — open day. 🙌"}
        </p>
      )}
      {rows && shown.length > 0 && (
        <div className="space-y-1.5">
          {shown.map((r, i) => (
            <div key={i} className="flex items-baseline gap-2 text-sm">
              <span className="shrink-0 w-[7.5rem] text-xs font-semibold text-[var(--neon)]/80 tabular-nums">{r.time}</span>
              <span className="min-w-0 truncate font-medium">{r.title}</span>
              {r.repeating && <span className="shrink-0 text-[9px] opacity-30">↻</span>}
            </div>
          ))}
        </div>
      )}
      {rows && repeatCount > 0 && (
        <button onClick={toggleRepeats} className="mt-2 text-[10px] opacity-40 underline">
          {hideRepeats ? `show ${repeatCount} repeating ↻` : `hide ${repeatCount} repeating ↻`}
        </button>
      )}
      {mode === "api" && rows && (
        <button onClick={() => setEditorOpen(true)} className="mt-2 text-[10px] opacity-40 underline">+ add / move something</button>
      )}
      {nothingConfigured && !setupOpen && (
        <button onClick={() => { setSetupOpen(true); setDraftIcs(""); setDraftClient(""); }} className="text-sm text-[var(--neon)] font-semibold">
          Connect your Google Calendar →
        </button>
      )}

      {setupOpen && (
        <div className="mt-3 pt-3 border-t border-white/10 space-y-3" style={{ animation: "fadeSlide 0.2s ease" }}>
          <div>
            <p className="text-xs font-bold mb-1">✏️ Full editing (recommended) — paste an OAuth Client ID</p>
            <p className="text-[11px] opacity-60 leading-snug mb-2">
              One-time, ~3 min: <b>console.cloud.google.com</b> → new project → enable <b>Google Calendar API</b> →
              OAuth consent screen (External, add yourself as test user) → Credentials → Create <b>OAuth client ID</b> →
              Web application → add authorized JavaScript origin <b>https://bookcrewcode.github.io</b> → copy the ID ending in
              <b> .apps.googleusercontent.com</b>.
            </p>
            <input value={draftClient} onChange={(e) => setDraftClient(e.target.value)} placeholder="…apps.googleusercontent.com"
              className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
          </div>
          <div>
            <p className="text-xs font-bold mb-1">👀 View-only fallback — secret iCal address</p>
            <p className="text-[11px] opacity-60 leading-snug mb-2">
              calendar.google.com → ⚙️ Settings → your calendar → Integrate calendar → “Secret address in iCal format”.
            </p>
            <input value={draftIcs} onChange={(e) => setDraftIcs(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
              className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setSetupOpen(false)} className="flex-1 rounded-xl bg-white/10 py-2.5 active:scale-95">Cancel</button>
            <button onClick={saveSetup} className="flex-1 rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">Save</button>
          </div>
        </div>
      )}

      {editorOpen && settings.clientId && (
        <CalendarEditor clientId={settings.clientId} initialDay={day} onClose={() => setEditorOpen(false)} onChanged={loadEvents} />
      )}
    </Card>
  );
}
