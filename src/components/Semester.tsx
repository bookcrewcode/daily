"use client";

// 📅 Semester — the term the app paces itself against, plus the weekly class
// timetable it knows by heart. Set classes ONCE; every day the front door and
// the day view already know where he has to be — no more re-typing "class
// 9-11" into a plan every night. This is the day-to-day logistics layer for
// the run to Dec 15.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import { sfx } from "@/lib/fx";
import { Card } from "./ui";

export type ClassBlock = { id: string; weekday: number; label: string; location: string; start_t: string; end_t: string };
export type SemesterInfo = { title: string; start: string; end: string };

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday-first

export default function Semester({ uid }: { uid: string }) {
  const [sem, setSem] = useState<SemesterInfo | null>(null);
  const [blocks, setBlocks] = useState<ClassBlock[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // semester draft (prefilled toward his real target: end of first semester)
  const [dTitle, setDTitle] = useState("Fall 2026");
  const [dStart, setDStart] = useState(todayStr());
  const [dEnd, setDEnd] = useState("2026-12-15");

  // add-a-class form
  const [adding, setAdding] = useState(false);
  const [fDay, setFDay] = useState(1);
  const [fLabel, setFLabel] = useState("");
  const [fLoc, setFLoc] = useState("");
  const [fStart, setFStart] = useState("");
  const [fEnd, setFEnd] = useState("");

  // load() re-syncs the draft fields from the DB — but never while the edit
  // form is OPEN, or an unrelated class add/remove would silently wipe unsaved
  // keystrokes. A ref, not state: load's closure only ever sees the ref.
  const editingRef = useRef(false);
  const removing = useRef<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const [{ data: us, error: usErr }, { data: cb, error: cbErr }] = await Promise.all([
        supabase.from("user_settings").select("semester").eq("user_id", uid).maybeSingle(),
        supabase.from("class_blocks").select("id,weekday,label,location,start_t,end_t").eq("user_id", uid).order("weekday").order("start_t"),
      ]);
      // a failed read must never render as "no semester / no classes"
      if (usErr || cbErr) { setLoadErr(true); setLoaded(true); return; }
      const raw = (us?.semester ?? null) as Partial<SemesterInfo> | null;
      const info = raw && raw.start && raw.end ? { title: raw.title || "Semester", start: raw.start, end: raw.end } : null;
      setSem(info);
      if (info && !editingRef.current) { setDTitle(info.title); setDStart(info.start); setDEnd(info.end); }
      setBlocks((cb ?? []) as ClassBlock[]);
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function saveSemester() {
    if (busy) return;
    if (!dStart || !dEnd || dEnd <= dStart) { setErr("The end date has to come after the start."); return; }
    setBusy(true); setErr("");
    try {
      const semester = { title: dTitle.trim().slice(0, 60) || "Semester", start: dStart, end: dEnd };
      const { error } = await supabase.from("user_settings").upsert({ user_id: uid, semester }, { onConflict: "user_id" });
      if (error) { setErr("Couldn't save the semester — try again."); return; }
      setSem(semester); setEditing(false); editingRef.current = false; sfx.pop();
    } catch { setErr("Couldn't reach the server — nothing was saved."); }
    finally { setBusy(false); }
  }

  async function addBlock() {
    if (busy) return;
    const label = fLabel.trim();
    if (!label || !fStart) { setErr("A class needs at least a name and a start time."); return; }
    setBusy(true); setErr("");
    try {
      const { error } = await supabase.from("class_blocks").insert({
        user_id: uid, weekday: fDay, label: label.slice(0, 120), location: fLoc.trim().slice(0, 120), start_t: fStart, end_t: fEnd || "",
      });
      if (error) { setErr("Couldn't add that class — it's still here, try again."); return; }
      setFLabel(""); setFLoc(""); setFStart(""); setFEnd("");
      sfx.pop();
      await load();
    } catch { setErr("Couldn't reach the server — nothing was saved."); }
    finally { setBusy(false); }
  }

  async function removeBlock(id: string) {
    if (removing.current.has(id)) return;
    removing.current.add(id);
    setRemovingIds([...removing.current]);
    setErr("");
    try {
      const { error } = await supabase.from("class_blocks").delete().eq("id", id);
      if (error) setErr("Couldn't remove that class.");
      await load(); // re-read ground truth either way
    } catch {
      setErr("Couldn't reach the server — that class is still there.");
      await load();
    } finally {
      removing.current.delete(id);
      setRemovingIds([...removing.current]);
    }
  }

  // pacing chip
  let pace = "";
  if (sem) {
    const ms = 86400000;
    const t0 = new Date(todayStr() + "T00:00:00").getTime();
    const s0 = new Date(sem.start + "T00:00:00").getTime();
    const e0 = new Date(sem.end + "T00:00:00").getTime();
    if (t0 >= s0 && t0 <= e0) {
      const wk = Math.floor((t0 - s0) / (7 * ms)) + 1;
      const tot = Math.max(wk, Math.ceil(((e0 - s0) / ms + 1) / 7));
      const dl = Math.round((e0 - t0) / ms);
      pace = `week ${wk} of ${tot} · ${dl} day${dl === 1 ? "" : "s"} left`;
    } else if (t0 < s0) { const su = Math.round((s0 - t0) / ms); pace = `starts in ${su} day${su === 1 ? "" : "s"}`; }
    else pace = "finished";
  }

  if (!loaded) return <div className="skeleton h-20 mt-4" />;
  if (loadErr) return <button onClick={load} className="mt-4 w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">Couldn&apos;t load your semester — tap to retry</button>;

  return (
    <Card className="mt-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-widest opacity-60">📅 Semester</p>
          <p className="text-[11px] opacity-50 mt-0.5 truncate">
            {sem ? `${sem.title} · ${pace}` : "Not set — the app can't pace the term yet"}
          </p>
        </div>
        <button onClick={() => { setEditing((v) => { editingRef.current = !v; return !v; }); setErr(""); }} className="shrink-0 px-3 py-2 rounded-lg bg-white/10 text-xs font-semibold active:scale-95">
          {editing ? "cancel" : sem ? "Edit" : "Set it up"}
        </button>
      </div>

      {editing && (
        <div className="mt-3 space-y-2">
          <input value={dTitle} onChange={(e) => setDTitle(e.target.value)} disabled={busy} placeholder="Fall 2026"
            className="w-full rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[10px] opacity-50">starts
              <input type="date" value={dStart} onChange={(e) => setDStart(e.target.value)} disabled={busy}
                className="mt-1 w-full rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
            </label>
            <label className="text-[10px] opacity-50">ends
              <input type="date" value={dEnd} onChange={(e) => setDEnd(e.target.value)} disabled={busy}
                className="mt-1 w-full rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
            </label>
          </div>
          <button onClick={saveSemester} disabled={busy} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95 disabled:opacity-50">
            {busy ? "saving…" : "Save semester"}
          </button>
        </div>
      )}

      {/* weekly timetable */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[10px] uppercase tracking-widest opacity-45">Class timetable · set once, known every day</p>
          <button onClick={() => { setAdding((v) => !v); setErr(""); }} className="text-xs text-[var(--neon)] font-semibold active:scale-95">
            {adding ? "cancel" : "+ class"}
          </button>
        </div>

        {adding && (
          <div className="rounded-xl bg-black/30 p-2.5 mb-2 space-y-1.5">
            <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
              {WEEK_ORDER.map((d) => (
                <button key={d} onClick={() => setFDay(d)} disabled={busy}
                  className={`shrink-0 px-2.5 py-1.5 rounded-full text-[11px] font-semibold ${fDay === d ? "bg-[var(--neon)] text-black" : "bg-white/5 opacity-70"}`}>
                  {DAY_NAMES[d].slice(0, 3)}
                </button>
              ))}
            </div>
            <input value={fLabel} onChange={(e) => setFLabel(e.target.value)} disabled={busy} placeholder="class (e.g. Microeconomics)"
              className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm" />
            <input value={fLoc} onChange={(e) => setFLoc(e.target.value)} disabled={busy} placeholder="where (optional)"
              className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm" />
            <div className="grid grid-cols-2 gap-1.5">
              <label className="text-[10px] opacity-50">starts
                <input type="time" value={fStart} onChange={(e) => setFStart(e.target.value)} disabled={busy}
                  className="mt-1 w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm" />
              </label>
              <label className="text-[10px] opacity-50">ends
                <input type="time" value={fEnd} onChange={(e) => setFEnd(e.target.value)} disabled={busy}
                  className="mt-1 w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm" />
              </label>
            </div>
            <button onClick={addBlock} disabled={busy || !fLabel.trim() || !fStart}
              className="w-full rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-40">
              {busy ? "adding…" : "Add class"}
            </button>
          </div>
        )}

        {blocks.length === 0 && !adding ? (
          <p className="text-sm opacity-40">No classes yet — add your weekly schedule once and every day already knows it.</p>
        ) : (
          <div className="space-y-2">
            {WEEK_ORDER.filter((d) => blocks.some((b) => b.weekday === d)).map((d) => (
              <div key={d}>
                <p className="text-[10px] uppercase tracking-widest opacity-40 mb-1">{DAY_NAMES[d]}</p>
                {blocks.filter((b) => b.weekday === d).map((b) => (
                  <div key={b.id} className="flex items-center gap-2 rounded-lg bg-white/[0.03] border border-white/10 px-2.5 py-2 mb-1">
                    <span className="tabular-nums text-xs opacity-55 shrink-0 w-[5.5rem]">{b.start_t}{b.end_t ? `–${b.end_t}` : ""}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{b.label}</p>
                      {b.location && <p className="text-[10px] opacity-40 truncate">{b.location}</p>}
                    </div>
                    <button onClick={() => removeBlock(b.id)} disabled={removingIds.includes(b.id)}
                      className="opacity-30 text-xs shrink-0 active:scale-90 disabled:opacity-10">✕</button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
    </Card>
  );
}
