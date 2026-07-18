"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, dateStr, type Night as NightT, type ScheduleItem } from "@/lib/supabase";
import { useVoiceInput } from "@/lib/useVoiceInput";
import { acquireToken, pushSchedule, pushAllDay, NeedsAuth } from "@/lib/gcal";
import { burstConfetti } from "@/lib/confetti";
import { SectionTitle, Card } from "./ui";
import { parseTime, fmtMinutes, resolveBlocks, gcalTemplateUrl, downloadIcs } from "@/lib/calendar";
import CalendarCard from "./CalendarCard";
import ScheduleChat from "./ScheduleChat";
import StageTomorrow from "./StageTomorrow";
import WeatherStrip from "./WeatherStrip";

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
  const [saveError, setSaveError] = useState(false);
  const [clientId, setClientId] = useState("");
  const [pushState, setPushState] = useState<"idle" | "pushing" | "done" | "error">("idle");
  const [pushNote, setPushNote] = useState("");
  const [top3State, setTop3State] = useState<"idle" | "pushing" | "done" | "error">("idle");
  const [top3Note, setTop3Note] = useState("");
  // ONE lock for every calendar-writing path (manual push, chat push, Top 3).
  // Two concurrent pushes each read the same prior id list, both create a full
  // set, and the last write-back orphans the other set on the real calendar.
  const pushLock = useRef(false);
  const [pushBusy, setPushBusy] = useState(false);
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
    const { data, error } = await supabase.from("nights").select("*").eq("user_id", uid).eq("day", day).maybeSingle();
    // Read failed (transient/offline): keep whatever's already on screen. Never
    // treat "read failed" as "no plan exists" — resetting to empty here would
    // let the next keystroke's persist() upsert the empty plan over the real row.
    if (error) return;
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
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      // A type-then-switch-tabs burst leaves a pending debounced write. Flush
      // the latest plan (via the ref, not a stale closure) so it isn't dropped.
      const cur = nRef.current;
      void supabase.from("nights").upsert(
        { user_id: uid, day, items: cur.items, top3: cur.top3, notes: cur.notes },
        { onConflict: "user_id,day" }
      );
    }
  }, [uid, day]);
  useEffect(() => {
    supabase.from("user_settings").select("gcal_client_id").eq("user_id", uid).maybeSingle()
      .then(({ data }) => setClientId(data?.gcal_client_id ?? ""));
  }, [uid]);

  // Update UI instantly; write to the DB at most ~once per pause in typing.
  function persist(next: NightT) {
    setN(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const { error } = await supabase.from("nights").upsert(
        { user_id: uid, day, items: next.items, top3: next.top3, notes: next.notes },
        { onConflict: "user_id,day" }
      );
      // supabase-js resolves {error} instead of throwing: only claim "saved ✓"
      // on a real success. On failure the typed plan stays on screen (it's in
      // `n`), and a small inline note appears instead of a false confirmation.
      if (error) { setSaveError(true); return; }
      setSaveError(false);
      setSaved(true); setTimeout(() => setSaved(false), 1200);
    }, 600);
  }
  persistRef.current = persist;

  // Schedule chat applies a whole revised day. Write it DIRECTLY (not through
  // the debounced persist — a backgrounded PWA would drop that timer) and only
  // report success once it actually landed.
  async function applySchedule(items: ScheduleItem[]): Promise<boolean> {
    // Disarm the pending debounce FIRST — synchronously, before the await.
    // Clearing it afterwards is too late: a 600ms timer armed by a manual edit
    // can fire during this round trip and write stale items over the new ones.
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const cur = nRef.current;
    const { error } = await supabase.from("nights").upsert(
      { user_id: uid, day, items, top3: cur.top3, notes: cur.notes },
      { onConflict: "user_id,day" },
    );
    if (error) return false;
    setN((x) => ({ ...x, items }));
    setSaveError(false);
    setSaved(true); setTimeout(() => setSaved(false), 1200);
    return true;
  }

  // Push TOMORROW's chat-built schedule to Google Calendar with reminders,
  // replacing whatever this app put there before (ids stored on the nights row).
  async function pushTomorrowToCalendar(items: ScheduleItem[]): Promise<{ ok: boolean; msg: string }> {
    if (!clientId) return { ok: false, msg: "Connect Google Calendar in the calendar card above first." };
    if (pushLock.current) return { ok: false, msg: "Another calendar push is still running — give it a second." };
    const blocks = resolveBlocks(items, tomorrow());
    if (!blocks.length) return { ok: false, msg: "No timed blocks to push — add times like 07:00." };
    pushLock.current = true; setPushBusy(true);
    try {
      const token = (await acquireToken(clientId, false)) ?? (await acquireToken(clientId, true));
      if (!token) return { ok: false, msg: "Google didn't grant access — tap again to authorize." };
      const { data: row, error: readErr } = await supabase.from("nights").select("gcal_event_ids").eq("user_id", uid).eq("day", day).maybeSingle();
      // a failed read looks like "no previous events" and would duplicate the day
      if (readErr) return { ok: false, msg: "Couldn't check existing calendar events — try again." };
      const prev = Array.isArray(row?.gcal_event_ids) ? (row!.gcal_event_ids as string[]) : [];
      const res = await pushSchedule(clientId, blocks, prev);
      // recording the ids is what lets the NEXT push replace instead of duplicate
      const { error: idErr } = await supabase.from("nights")
        .update({ gcal_event_ids: res.ids, ...(res.failed === 0 && !res.needsAuth && res.kept === 0 ? { calendar_synced_at: new Date().toISOString() } : {}) })
        .eq("user_id", uid).eq("day", day);
      if (idErr) {
        return { ok: false, msg: `${res.created} event${res.created === 1 ? "" : "s"} landed, but I couldn't record them here — check your calendar before pushing again or you'll get duplicates.` };
      }
      if (res.failed === 0 && !res.needsAuth && res.kept === 0) setN((x) => ({ ...x, calendar_synced_at: new Date().toISOString() }));
      if (res.needsAuth) return { ok: false, msg: `Google needs you to reconnect — ${res.created} of ${blocks.length} made it. Reconnect and push again (it replaces, won't duplicate).` };
      if (res.failed > 0) return { ok: false, msg: `Only ${res.created} of ${blocks.length} landed — push again to retry (it replaces, won't duplicate).` };
      if (res.kept > 0) {
        return { ok: false, msg: `📅 ${res.created} added, but ${res.kept} old event${res.kept === 1 ? "" : "s"} couldn't be removed — still tracked, so the next push cleans them up.` };
      }
      return { ok: true, msg: `📅 ${res.created} block${res.created === 1 ? "" : "s"} on tomorrow's calendar with 10-min reminders${res.removed ? ` (replaced ${res.removed})` : ""}.` };
    } catch (e) {
      if (e instanceof NeedsAuth) return { ok: false, msg: "Google needs you to reconnect — tap to authorize." };
      return { ok: false, msg: "Calendar push failed — your plan is saved. Try again." };
    } finally {
      pushLock.current = false; setPushBusy(false);
    }
  }

  const setItem = (i: number, patch: Partial<ScheduleItem>) =>
    persist({ ...n, items: n.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) });
  const addItem = () => persist({ ...n, items: [...n.items, { time: "", what: "" }] });
  const delItem = (i: number) => persist({ ...n, items: n.items.filter((_, idx) => idx !== i) });
  const setTop = (i: number, v: string) => persist({ ...n, top3: n.top3.map((t, idx) => (idx === i ? v : t)) });

  const blocks = resolveBlocks(n.items, tomorrow());

  async function markSynced() {
    const at = new Date().toISOString();
    setN((x) => ({ ...x, calendar_synced_at: at }));
    // A push takes multiple seconds; the user may have edited items/top3/notes
    // meanwhile. Read the FRESHEST plan from the ref (not this render's stale
    // closure) so recording the sync time can't clobber those edits, and check
    // {error} — supabase-js resolves it rather than throwing.
    const cur = nRef.current;
    const { error } = await supabase.from("nights").upsert(
      { user_id: uid, day, items: cur.items, top3: cur.top3, notes: cur.notes, calendar_synced_at: at },
      { onConflict: "user_id,day" }
    );
    if (error) return; // events already landed on the calendar; only the timestamp failed to persist
  }

  function pushAllIcs() {
    if (!blocks.length) return;
    downloadIcs(blocks, `plan-${day}.ics`);
    markSynced();
  }

  // Direct API push — one tap, events land in Google Calendar instantly.
  // Honesty rule: only claim success when EVERY block landed; a partial push
  // says exactly what happened (blind retries would duplicate events).
  async function pushAllApi() {
    if (!blocks.length || !clientId || pushState === "pushing") return;
    if (pushLock.current) { setPushNote("Another calendar push is still running — give it a second."); return; }
    pushLock.current = true; setPushBusy(true);
    setPushState("pushing"); setPushNote("");
    try {
      const t = (await acquireToken(clientId, false)) ?? (await acquireToken(clientId, true));
      if (!t) { setPushState("error"); setPushNote("Google didn't grant access."); return; }
      const { data: prevRow, error: readErr } = await supabase.from("nights").select("gcal_event_ids").eq("user_id", uid).eq("day", day).maybeSingle();
      if (readErr) { setPushState("error"); setPushNote("Couldn't check existing calendar events — try again."); return; }
      const prevIds = Array.isArray(prevRow?.gcal_event_ids) ? (prevRow!.gcal_event_ids as string[]) : [];
      // freshest items (nRef), never this render's closure — a chat-apply may
      // have just landed a new plan while this button was still on screen
      const liveBlocks = resolveBlocks(nRef.current.items, tomorrow());
      const pushed = await pushSchedule(clientId, liveBlocks, prevIds);
      // recording ids is what makes the next push replace instead of duplicate
      const { error: idErr } = await supabase.from("nights").update({ gcal_event_ids: pushed.ids }).eq("user_id", uid).eq("day", day);
      if (idErr) {
        setPushState("error");
        setPushNote(`${pushed.created} event(s) landed, but I couldn't record them here — check Google Calendar before pushing again or you'll get duplicates.`);
        return;
      }
      const created = pushed.created;
      if (pushed.kept > 0) {
        setPushState("error");
        setPushNote(`${created} added, but ${pushed.kept} old event(s) couldn't be removed — still tracked, so the next push cleans them up.`);
      } else if (pushed.needsAuth) {
        setPushState("error");
        setPushNote(`Google needs you to reconnect — ${created} of ${liveBlocks.length} made it. Reconnect and push again (it replaces, won't duplicate).`);
      } else if (created === liveBlocks.length) {
        burstConfetti("small");
        markSynced();
        setPushState("done");
        setTimeout(() => setPushState("idle"), 4000);
      } else if (created > 0) {
        setPushState("error");
        setPushNote(`Only ${created} of ${liveBlocks.length} made it — push again to retry (it replaces, won't duplicate).`);
      } else {
        setPushState("error");
        setPushNote("Nothing was pushed — check your connection and try again.");
      }
    } catch {
      setPushState("error");
      setPushNote("Push interrupted — check Google Calendar to see what landed before retrying.");
    } finally {
      pushLock.current = false; setPushBusy(false);
    }
  }

  // Top 3 land as all-day events pinned to the top of tomorrow in Google
  // Calendar. Same honesty rule as pushAllApi: report exactly what landed.
  async function pushTop3() {
    const filled = n.top3.map((t) => t.trim()).filter(Boolean);
    if (!filled.length || !clientId || top3State === "pushing") return;
    if (pushLock.current) { setTop3Note("Another calendar push is still running — give it a second."); return; }
    pushLock.current = true; setPushBusy(true);
    setTop3State("pushing"); setTop3Note("");
    try {
      const t = (await acquireToken(clientId, false)) ?? (await acquireToken(clientId, true));
      if (!t) { setTop3State("error"); setTop3Note("Google didn't grant access."); return; }
      const { data: prevRow, error: readErr } = await supabase.from("nights").select("gcal_top3_event_ids").eq("user_id", uid).eq("day", day).maybeSingle();
      if (readErr) { setTop3State("error"); setTop3Note("Couldn't check existing Top-3 events — try again."); return; }
      const prevIds = Array.isArray(prevRow?.gcal_top3_event_ids) ? (prevRow!.gcal_top3_event_ids as string[]) : [];
      // delete-then-create, like the blocks push: re-pinning must REPLACE the
      // previous all-day events, never stack a second set on the real calendar
      // freshest Top-3 text (nRef), not this render's closure
      const live = nRef.current.top3.map((t) => t.trim()).filter(Boolean);
      const pushed = await pushAllDay(clientId, live.map((f, i) => `★ ${i + 1}. ${f}`), day, prevIds);
      const { error: idErr } = await supabase.from("nights").update({ gcal_top3_event_ids: pushed.ids }).eq("user_id", uid).eq("day", day);
      if (idErr) {
        setTop3State("error");
        setTop3Note(`${pushed.created} pinned, but I couldn't record them here — check Google Calendar before pinning again or you'll get duplicates.`);
        return;
      }
      const created = pushed.created;
      if (pushed.kept > 0) {
        setTop3State("error");
        setTop3Note(`${created} pinned, but ${pushed.kept} old one(s) couldn't be removed — still tracked, so the next pin cleans them up.`);
      } else if (pushed.needsAuth) {
        setTop3State("error");
        setTop3Note(`Google needs you to reconnect — ${created} of ${live.length} made it. Reconnect and pin again (it replaces, won't duplicate).`);
      } else if (created === live.length) {
        burstConfetti("small");
        markSynced();
        setTop3State("done");
        setTimeout(() => setTop3State("idle"), 4000);
      } else if (created > 0) {
        setTop3State("error");
        setTop3Note(`Only ${created} of ${live.length} landed — pin again to retry (it replaces, won't duplicate).`);
      } else {
        setTop3State("error");
        setTop3Note("Nothing was pushed — check your connection and try again.");
      }
    } catch {
      setTop3State("error");
      setTop3Note("Push interrupted — check Google Calendar to see what landed before retrying.");
    } finally {
      pushLock.current = false; setPushBusy(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">🌙 Nightly Planner</h1>
      <p className="opacity-50 text-sm mt-1">
        Plan tomorrow — {pretty}. <span className={`text-[var(--neon)] transition-opacity ${saved ? "opacity-100" : "opacity-0"}`}>saved ✓</span>
      </p>
      {saveError && <p className="text-xs text-orange-400 mt-1">Couldn&apos;t save — your plan stays on screen; keep editing to retry.</p>}
      <p className="mt-0.5"><WeatherStrip dayOffset={1} /></p>

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
        <ScheduleChat dayLabel="tomorrow" items={n.items} onApply={applySchedule} onPush={pushTomorrowToCalendar} />
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
            {clientId ? (
              <button onClick={pushAllApi} disabled={pushState === "pushing" || pushBusy}
                className="mt-3 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50">
                {pushState === "pushing" ? "Pushing…" : pushState === "done" ? "✓ All on your calendar" : pushState === "error" ? "Didn't finish — see note" : `⚡ Push all ${blocks.length} to Google Calendar`}
              </button>
            ) : (
              <button onClick={pushAllIcs}
                className="mt-3 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">
                📅 Add all {blocks.length} to calendar (.ics)
              </button>
            )}
            {pushNote && <p className="text-xs text-orange-400 mt-2">{pushNote}</p>}
            <p className="text-[10px] opacity-40 mt-2">
              {clientId
                ? "Writes each block straight into Google Calendar. Edit or move them afterwards with ✏️ Edit on the calendar card."
                : "The .ics opens in your calendar app and imports every block at once. Connect editing in the calendar card's setup for one-tap direct push."}
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
        {clientId && n.top3.some((t) => t.trim()) && (
          <>
            <button onClick={pushTop3} disabled={top3State === "pushing" || pushBusy}
              className="w-full rounded-xl border border-[var(--neon)]/40 text-[var(--neon)] font-semibold py-2.5 text-sm active:scale-95 disabled:opacity-50">
              {top3State === "pushing" ? "Pushing…" : top3State === "done" ? "✓ On your calendar" : top3State === "error" ? "Didn't finish — see note" : "★ Pin Top 3 to Google Calendar (all-day)"}
            </button>
            {top3Note && <p className="text-xs text-orange-400">{top3Note}</p>}
          </>
        )}
      </div>

      <StageTomorrow uid={uid} />

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
