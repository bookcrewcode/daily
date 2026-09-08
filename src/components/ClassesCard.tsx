"use client";

// 🎓 CLASSES — Canvas deadlines, one private link, no typing after that.
//
// Canvas publishes every course's due dates as a calendar feed. Ben pastes that
// link once (stored in user_settings.canvas_ics_url, like gcal_ics_url); the
// `deadlines` edge function fetches and parses it, and the mirror_deadline_goals
// RPC turns each deadline into a goal that lands on the daily list when it's
// time to start. This card shows the state of that pipe and lets him link a
// course to its notebook, add a deadline by hand, or mark one done.
//
// Every write is write-first and checks {error}; a failed read shows a retry,
// never an empty card.

import { useCallback, useEffect, useState } from "react";
import { supabase, SUPABASE_ANON, DEADLINES_FN, todayStr, dateStr } from "@/lib/supabase";
import { sfx } from "@/lib/fx";
import { Card, Eyebrow } from "./ui";

// ── deadline helpers (also used by the manifest import in NotebookSources) ──
// The same rules the edge function uses for Canvas rows, so a syllabus or
// manual deadline gets the same "start by" as a synced one.
export type DeadlineKind = "assignment" | "quiz" | "exam" | "discussion" | "reading" | "other";

export function deadlineKind(title: string, fallback: DeadlineKind = "other"): DeadlineKind {
  const t = title.toLowerCase();
  if (/\b(midterm|final|exam)\b/.test(t)) return "exam";
  if (/\bquiz/.test(t)) return "quiz";
  if (/\bdiscussion\b/.test(t)) return "discussion";
  if (/\breading\b/.test(t)) return "reading";
  if (/\b(problem set|homework|assignment|essay|paper|project|hw)\b/.test(t)) return "assignment";
  return fallback;
}

// days of lead time before the due date: exam 7 · essay/paper/project 5 ·
// assignment 3 · quiz 2 · discussion 1 · reading 1 · other 2
export function leadDays(kind: DeadlineKind, title: string): number {
  if (kind === "exam") return 7;
  if (kind === "assignment") return /\b(essay|paper|project)\b/i.test(title) ? 5 : 3;
  if (kind === "quiz") return 2;
  if (kind === "discussion" || kind === "reading") return 1;
  return 2;
}

// A date-only deadline ("due 2026-09-14") is due at the END of that local day.
// Noon-based arithmetic so DST edges can't shift the day (see theGame.addDays).
export function dueAtFromDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 0).toISOString();
}
export function startByFor(date: string, kind: DeadlineKind, title: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return dateStr(new Date(y, m - 1, d - leadDays(kind, title), 12));
}
export function phoneTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"; } catch { return "America/New_York"; }
}

export type MirrorCounts = { created: number; updated: number; expired: number; linked: number };
// Deadlines ⇄ goals is one SQL function; every client-side deadline writer
// calls it after writing. null = the RPC failed (caller says so on screen).
export async function mirrorGoals(): Promise<MirrorCounts | null> {
  try {
    const { data, error } = await supabase.rpc("mirror_deadline_goals", { p_tz: phoneTz() });
    if (error || !data) return null;
    const d = data as Partial<MirrorCounts>;
    return { created: d.created ?? 0, updated: d.updated ?? 0, expired: d.expired ?? 0, linked: d.linked ?? 0 };
  } catch { return null; }
}

// ── the card ────────────────────────────────────────────────────────────────
type DeadlineRow = {
  id: string; source: string; course: string; course_key: string | null; title: string; kind: DeadlineKind;
  due_at: string; start_by: string | null; url: string; notebook_id: string | null; done: boolean;
};
type NotebookLite = { id: string; title: string; course: string; course_key: string | null };
type CourseRow = { course: string; course_key: string; count: number; next: DeadlineRow; notebook_id: string | null };

const DL_COLS = "id,source,course,course_key,title,kind,due_at,start_by,url,notebook_id,done";
const DAY_MS = 86400000;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const fmtDay = (iso: string) => { const d = new Date(iso); return `${WD[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`; };
const fmtDate = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return fmtDay(new Date(y, m - 1, d, 12).toISOString()); };
// "ECON 201-01" → "ECON": enough to recognise a course on one line
const shortCourse = (c: string) => (c.match(/[A-Za-z]{2,}/)?.[0] ?? c).toUpperCase();

export default function ClassesCard({ uid, notebooks, onChanged }: {
  uid: string; notebooks: NotebookLite[]; onChanged?: () => void;
}) {
  const [icsUrl, setIcsUrl] = useState<string | null>(null);   // null = not loaded yet
  const [deadlines, setDeadlines] = useState<DeadlineRow[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  const [busy, setBusy] = useState("");            // which action is in flight
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [pickFor, setPickFor] = useState<string | null>(null);   // course_key being linked
  const [mTitle, setMTitle] = useState("");
  const [mCourse, setMCourse] = useState("");
  const [mDate, setMDate] = useState("");
  const [manualOpen, setManualOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const since = new Date(Date.now() - DAY_MS).toISOString();
      const [us, dl] = await Promise.all([
        supabase.from("user_settings").select("canvas_ics_url").eq("user_id", uid).maybeSingle(),
        supabase.from("deadlines").select(DL_COLS).eq("user_id", uid).eq("done", false).gte("due_at", since)
          .order("due_at", { ascending: true }).limit(80),
      ]);
      if (us.error || dl.error) { setLoadErr(true); return; }
      setIcsUrl(((us.data as { canvas_ics_url?: string } | null)?.canvas_ics_url ?? "").trim());
      setDeadlines((dl.data ?? []) as DeadlineRow[]);
      setLoadErr(false);
    } catch { setLoadErr(true); }
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function sync(): Promise<boolean> {
    setBusy("sync"); setErr(""); setMsg("");
    try {
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(DEADLINES_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
        body: JSON.stringify({ mode: "sync", tz: phoneTz(), today: todayStr() }),
      });
      const json = await res.json();
      if (json.error) { setErr(json.error); return false; }
      const n = Array.isArray(json.courses) ? json.courses.length : 0;
      // the function answers {connected, courses, deadlines, unfiled, counts:{synced, created, updated, expired, linked, mirror_error?}}
      // — `unfiled` = upcoming deadlines with no course, no longer rolled up as a nameless course
      const counts = (json.counts ?? {}) as { synced?: number; created?: number; mirror_error?: string };
      const created = Number(counts.created) || 0;
      const synced = Number(counts.synced) || 0;
      const unfiled = Number(json.unfiled) || 0;
      setMsg(`Synced · ${synced} in the feed · ${n} course${n === 1 ? "" : "s"}${created ? ` · ${created} new on your list` : ""}${unfiled ? ` · ${unfiled} without a course` : ""}`);
      if (counts.mirror_error) setErr(counts.mirror_error);
      sfx.coin();
      await load();
      onChanged?.();
      return true;
    } catch { setErr("Couldn't reach the server — nothing changed. Try again."); return false; }
    finally { setBusy(""); }
  }

  async function saveUrl() {
    const u = draft.trim();
    if (!/^https:\/\/\S+$/i.test(u)) { setErr("The link has to start with https:// — copy it straight from Canvas."); return; }
    if (busy) return;
    setBusy("save"); setErr(""); setMsg("");
    try {
      const { error } = await supabase.from("user_settings").upsert({ user_id: uid, canvas_ics_url: u }, { onConflict: "user_id" });
      if (error) { setErr("Couldn't save the link — it's still here, try again."); return; }
      setIcsUrl(u); setDraft(""); setEditingUrl(false);
    } catch { setErr("Couldn't reach the server — the link is still here, try again."); return; }
    finally { setBusy(""); }
    await sync();
  }

  // Point every deadline of a course at one notebook, creating it if asked.
  async function linkCourse(courseKey: string, course: string, notebookId: string | "new") {
    if (busy) return;
    setBusy(`link_${courseKey}`); setErr(""); setMsg("");
    try {
      let nbId = notebookId;
      if (nbId === "new") {
        const { data, error } = await supabase.from("notebooks")
          .insert({ user_id: uid, title: course, subject: "", why: "", emoji: "📘", course, kind: "class" })
          .select("id").single();
        if (error || !data) { setErr("Couldn't create that notebook — try again."); return; }
        nbId = (data as { id: string }).id;
      }
      const { error } = await supabase.from("deadlines").update({ notebook_id: nbId }).eq("user_id", uid).eq("course_key", courseKey);
      if (error) { setErr(nbId === notebookId ? "Couldn't link that course — try again." : "Notebook created, but linking it didn't save — pick it from the list."); }
      else { setMsg(`${course} → notebook linked`); sfx.pop(); }
      setPickFor(null);
      await load();
      onChanged?.();
    } catch { setErr("Couldn't reach the server — nothing changed."); }
    finally { setBusy(""); }
  }

  async function addManual() {
    const title = mTitle.trim();
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(mDate) || busy) return;
    setBusy("manual"); setErr(""); setMsg("");
    try {
      const kind = deadlineKind(title);
      const { error } = await supabase.from("deadlines").insert({
        user_id: uid, source: "manual", uid: crypto.randomUUID(), course: mCourse.trim(), title: title.slice(0, 200), kind,
        due_at: dueAtFromDate(mDate), start_by: startByFor(mDate, kind, title), url: "", done: false,
      });
      if (error) { setErr("Couldn't save that deadline — it's still here, try again."); return; }
      setMTitle(""); setMDate(""); setManualOpen(false);
      sfx.coin();
      const m = await mirrorGoals();
      setMsg(m ? `Added · start by ${fmtDate(startByFor(mDate, kind, title))}${m.created ? " · on your list" : ""}` : "Added — but it couldn't reach your daily list yet. Tap Sync to retry.");
      await load();
      onChanged?.();
    } catch { setErr("Couldn't reach the server — nothing saved."); }
    finally { setBusy(""); }
  }

  async function markDone(d: DeadlineRow) {
    if (busy) return;
    setBusy(`done_${d.id}`); setErr(""); setMsg("");
    try {
      const { error } = await supabase.from("deadlines").update({ done: true }).eq("id", d.id);
      if (error) { setErr("Couldn't mark that done — try again."); return; }
      sfx.coin();
      const m = await mirrorGoals();
      if (!m) setMsg("Marked done — its line on the daily list will clear on the next sync.");
      await load();
      onChanged?.();
    } catch { setErr("Couldn't reach the server — nothing changed."); }
    finally { setBusy(""); }
  }

  if (icsUrl === null && !loadErr) return <div className="skeleton h-12 mt-3" />;
  if (loadErr) return (
    <button onClick={load} className="w-full mt-3 rounded-xl bg-orange-500/15 text-orange-300 text-xs font-semibold py-3 active:scale-95">
      Couldn&apos;t load your classes — tap to retry
    </button>
  );

  const connected = !!icsUrl;
  const rows = deadlines ?? [];
  const today = todayStr();
  const courses: CourseRow[] = [];
  for (const d of rows) {
    if (!d.course_key) continue;
    const c = courses.find((x) => x.course_key === d.course_key);
    if (c) { c.count++; if (!c.notebook_id && d.notebook_id) c.notebook_id = d.notebook_id; }
    else courses.push({ course: d.course, course_key: d.course_key, count: 1, next: d,
      notebook_id: d.notebook_id ?? notebooks.find((n) => n.course_key === d.course_key)?.id ?? null });
  }
  const next = rows[0];
  const nextLine = next ? `next: ${next.course ? shortCourse(next.course) + " " : ""}${next.kind} ${fmtDay(next.due_at)}` : "nothing due";
  const nbTitle = (id: string | null) => notebooks.find((n) => n.id === id)?.title ?? null;
  const syncBtn = (
    <button onClick={sync} disabled={!!busy}
      className="rounded-lg bg-white/10 text-[11px] font-semibold px-2.5 py-1.5 active:scale-95 disabled:opacity-50 shrink-0">
      {busy === "sync" ? "syncing…" : "Sync"}
    </button>
  );

  return (
    <Card className="mt-3" padded={false}>
      {/* one-line row: the state of the pipe, always */}
      <div className="px-4 py-3 flex items-center gap-2.5">
        <button onClick={() => setOpen((v) => !v)} className="flex-1 min-w-0 text-left flex items-center gap-2.5 active:scale-[0.99]">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: connected ? "var(--ok)" : "var(--text-4)" }} />
          <p className="text-[12px] flex-1 min-w-0 truncate text-[var(--text-2)]">
            {connected
              ? `${courses.length} course${courses.length === 1 ? "" : "s"} · ${nextLine}`
              : "Connect Canvas deadlines (2 min — easier on a laptop)"}
          </p>
        </button>
        {connected && !open && syncBtn}
        <button onClick={() => setOpen((v) => !v)} aria-label={open ? "Collapse classes" : "Expand classes"} className="text-[10px] opacity-35 px-1 active:scale-90">{open ? "▴" : "▾"}</button>
      </div>

      {open && (
        <div className="px-4 pb-4">
          {(!connected || editingUrl) && (
            <div className="rounded-xl bg-black/30 p-3 mb-3">
              <p className="text-[11px] text-[var(--text-2)] leading-relaxed">
                In Canvas: <b>Calendar</b> (left sidebar) → <b>Calendar Feed</b> (bottom right) → copy the link that starts with https://.
                It&apos;s a private link to your due dates only — paste it here and every course&apos;s deadlines come in, with a &quot;start by&quot; day
                that lands on your daily list.
              </p>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!!busy} inputMode="url"
                placeholder="https://rutgers.instructure.com/feeds/calendars/…"
                className="w-full mt-2 rounded-lg bg-black/40 px-3 py-2 outline-none text-xs mono" />
              <div className="flex gap-2 mt-2">
                <button onClick={saveUrl} disabled={!!busy || !draft.trim()}
                  className="flex-1 rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-40">
                  {busy === "save" ? "saving…" : busy === "sync" ? "syncing…" : "Save and sync"}
                </button>
                {editingUrl && (
                  <button onClick={() => { setEditingUrl(false); setDraft(""); }} className="rounded-lg bg-white/10 text-sm font-semibold px-3 active:scale-95">cancel</button>
                )}
              </div>
            </div>
          )}

          {connected && !editingUrl && (
            <div className="flex items-center gap-2 mb-3">
              <p className="text-[10px] text-[var(--text-4)] flex-1 min-w-0 truncate">Feed saved · {icsUrl.replace(/^https:\/\//, "").slice(0, 40)}…</p>
              <button onClick={() => { setEditingUrl(true); setDraft(icsUrl); }} className="text-[10px] underline opacity-50 active:scale-95">change link</button>
              {syncBtn}
            </div>
          )}

          {/* courses ↔ notebooks */}
          {courses.length > 0 && (
            <div className="mb-3">
              <Eyebrow className="mb-1.5">Courses · {courses.length}</Eyebrow>
              <div className="space-y-1.5">
                {courses.map((c) => {
                  const linked = nbTitle(c.notebook_id);
                  return (
                    <div key={c.course_key} className="rounded-lg bg-white/[0.03] border border-white/10 px-2.5 py-2">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm truncate">{c.course}</p>
                          <p className="text-[10px] opacity-45">
                            {c.count} due · next {fmtDay(c.next.due_at)}{linked ? ` · Notebook: ${linked}` : ""}
                          </p>
                        </div>
                        {linked ? (
                          <button onClick={() => setPickFor(pickFor === c.course_key ? null : c.course_key)} className="text-[10px] underline opacity-40 active:scale-95">change</button>
                        ) : (
                          <div className="flex gap-1.5 shrink-0">
                            <button onClick={() => linkCourse(c.course_key, c.course, "new")} disabled={!!busy}
                              className="rounded-lg bg-[var(--neon)] text-black text-[11px] font-bold px-2.5 py-1.5 active:scale-95 disabled:opacity-40">
                              {busy === `link_${c.course_key}` ? "…" : "create one"}
                            </button>
                            {notebooks.length > 0 && (
                              <button onClick={() => setPickFor(pickFor === c.course_key ? null : c.course_key)}
                                className="rounded-lg bg-white/10 text-[11px] font-semibold px-2.5 py-1.5 active:scale-95">pick</button>
                            )}
                          </div>
                        )}
                      </div>
                      {!linked && pickFor !== c.course_key && (
                        <p className="text-[10px] text-[var(--warn)] mt-1">No notebook for {c.course} — its deadlines can&apos;t steer what you study until one is linked.</p>
                      )}
                      {pickFor === c.course_key && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {notebooks.map((n) => (
                            <button key={n.id} onClick={() => linkCourse(c.course_key, c.course, n.id)} disabled={!!busy}
                              className="rounded-full bg-white/10 text-[11px] px-2.5 py-1 active:scale-95 disabled:opacity-40">{n.title}</button>
                          ))}
                          {notebooks.length === 0 && <p className="text-[10px] opacity-45">No notebooks yet — tap &quot;create one&quot; instead.</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* next 6 deadlines */}
          <Eyebrow className="mb-1.5">Coming up</Eyebrow>
          {rows.length === 0 ? (
            <p className="text-sm opacity-40 mb-1">
              {connected ? "Nothing due in the feed yet — tap Sync after Canvas updates, or add one below." : "Connect the feed above, or add a deadline by hand below."}
            </p>
          ) : (
            <div className="space-y-1.5">
              {rows.slice(0, 6).map((d) => {
                const startNow = !!d.start_by && d.start_by <= today;
                return (
                  <div key={d.id} className="flex items-center gap-2 rounded-lg bg-white/[0.03] border border-white/10 px-2.5 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{d.course ? `${shortCourse(d.course)} · ` : ""}{d.title}</p>
                      <p className="text-[10px] opacity-45">
                        {d.kind} · due {fmtDay(d.due_at)}
                        {d.start_by && <span className={startNow ? " text-[var(--warn)]" : ""}> · {startNow ? "start now" : `start by ${fmtDate(d.start_by)}`}</span>}
                        {d.source !== "canvas" && <span> · {d.source === "manual" ? "added by hand" : "from syllabus"}</span>}
                      </p>
                    </div>
                    {d.url && <a href={d.url} target="_blank" rel="noreferrer" className="text-[10px] opacity-40 shrink-0">↗</a>}
                    <button onClick={() => markDone(d)} disabled={!!busy} aria-label={`Mark ${d.title} done`}
                      className="w-7 h-7 rounded-lg bg-white/10 grid place-items-center text-xs shrink-0 active:scale-90 disabled:opacity-40">
                      {busy === `done_${d.id}` ? "…" : "✓"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">
            Start by = the day to begin so it&apos;s ready in time: exam 7 days ahead, essay/paper/project 5, assignment 3, quiz 2, reading or discussion 1.
            On that day it appears on your daily list. ✓ marks it finished.
          </p>

          {/* manual add */}
          {manualOpen ? (
            <div className="rounded-xl bg-black/30 p-2.5 mt-3">
              <input value={mTitle} onChange={(e) => setMTitle(e.target.value)} disabled={!!busy} placeholder="what's due (e.g. Problem Set 3)"
                className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm mb-1.5" />
              <div className="flex gap-1.5">
                <input value={mCourse} onChange={(e) => setMCourse(e.target.value)} disabled={!!busy} placeholder="course (optional)" list="classes-card-courses"
                  className="flex-1 min-w-0 rounded-lg bg-black/40 px-3 py-2 outline-none text-sm" />
                <datalist id="classes-card-courses">{courses.map((c) => <option key={c.course_key} value={c.course} />)}</datalist>
                <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} disabled={!!busy}
                  className="rounded-lg bg-black/40 px-2 py-2 outline-none text-sm mono" />
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={addManual} disabled={!!busy || !mTitle.trim() || !mDate}
                  className="flex-1 rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-40">
                  {busy === "manual" ? "saving…" : "Add deadline"}
                </button>
                <button onClick={() => setManualOpen(false)} className="rounded-lg bg-white/10 text-sm font-semibold px-3 active:scale-95">cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setManualOpen(true)} className="mono text-[10px] text-[var(--neon)] mt-2.5 active:scale-95">＋ add a deadline by hand</button>
          )}

          {msg && <p className="text-xs text-[var(--ok)] mt-2">{msg}</p>}
          {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
        </div>
      )}
    </Card>
  );
}
