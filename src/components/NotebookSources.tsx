"use client";

// 📚 Sources for a notebook — notes, a YouTube link (auto-transcript), a bare
// link, a PDF (extracted server-side, page-marked), or a whole class manifest
// (one JSON block from a Canvas audit: lectures + readings + due dates).
// The database chunks every source into passages on insert (trigger); this
// component only writes content and shows what got indexed.
//
// Carries forward every guard the old Sources learned the hard way: write
// first, check {error}, a failed read never reads as "empty", try/catch/finally
// so a rejected fetch can't jam a button, and whole-string URL detection so a
// paste with commentary keeps the commentary.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, SUPABASE_ANON } from "@/lib/supabase";
import { type NBSource, PDF_FN, TRANSCRIPT_FN } from "@/lib/notebook";
import { sfx } from "@/lib/fx";
import { Card } from "./ui";
import { deadlineKind, dueAtFromDate, startByFor, mirrorGoals } from "./ClassesCard";

const KIND_ICON: Record<string, string> = { youtube: "🎥", link: "🔗", note: "📝", pdf: "📄" };
const MAX_CONTENT = 200000;
const MAX_PDF_B64 = 9_000_000; // ~6.7 MB file
const MANIFEST_SCHEMA = "daily.class-manifest/1";
// manifest kinds that carry material worth teaching from (a 'deadline' is a date only)
const LEARNING_KINDS = new Set(["syllabus", "lecture", "reading", "problem_set", "past_exam", "rubric"]);

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const firstUrl = (s: string) => s.match(URL_RE)?.[0] ?? "";
const isOnlyUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());
const isYouTube = (s: string) => /(?:youtube\.com|youtu\.be)/i.test(s);
const isIsoDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const weekOf = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
};

type SourceRow = NBSource;
type SourceExtra = { week?: number | null; page_count?: number; meta?: Record<string, unknown> };

type ManifestItem = { kind: string; title: string; week?: number; date?: string; text?: string; url?: string; points?: number };
type Manifest = { schema: string; course: string; term?: string; items: ManifestItem[] };

// Stable id for a syllabus deadline so re-importing the same manifest updates
// rows instead of duplicating them. FNV-1a 32-bit over "course|title|date",
// lower-cased with whitespace collapsed, so a retyped title still matches.
// Documented in docs/class-manifest.md — change both or neither.
export function manifestUid(course: string, title: string, date: string): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const s = `${norm(course)}|${norm(title)}|${date.trim()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `syl-${h.toString(16).padStart(8, "0")}`;
}

function parseManifest(raw: string): { manifest: Manifest } | { problem: string } {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return { problem: "That isn't valid JSON — copy the whole block, including the outer { }." }; }
  const m = j as Partial<Manifest>;
  if (!m || typeof m !== "object") return { problem: "Expected a JSON object at the top level." };
  if (m.schema !== MANIFEST_SCHEMA) return { problem: `Expected "schema": "${MANIFEST_SCHEMA}" — this looks like something else.` };
  if (typeof m.course !== "string" || !m.course.trim()) return { problem: 'The manifest needs a "course" (e.g. "ECON 201").' };
  if (!Array.isArray(m.items)) return { problem: 'The manifest needs an "items" list.' };
  const items = m.items.filter((i): i is ManifestItem => !!i && typeof i === "object" && typeof i.title === "string" && !!i.title.trim() && typeof i.kind === "string");
  if (!items.length) return { problem: "No items with a title and a kind — nothing to import." };
  return { manifest: { schema: m.schema, course: m.course.trim(), term: m.term, items } };
}

function fileToB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file); // data:...;base64,XXXX — the function strips the prefix
  });
}

export default function NotebookSources({ uid, notebookId, onCount, onFirstSource, startOpen }: {
  uid: string; notebookId: string; onCount?: (n: number) => void;
  // fired once, after the first successful insert into an empty notebook, so
  // NotebookView can chain the cold-start chapter build
  onFirstSource?: () => void;
  // open the paste box on mount — for the notebook the Today card sent him to paste into
  startOpen?: boolean;
}) {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const sourcesRef = useRef<SourceRow[]>([]);          // fresh count for the first-source hook
  // passages per source_id; null = the count read failed (never shown as 0)
  const [chunkCounts, setChunkCounts] = useState<Record<string, number> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(!!startOpen);
  const [input, setInput] = useState("");
  const [title, setTitle] = useState("");
  const [week, setWeek] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [warn, setWarn] = useState("");
  const [err, setErr] = useState("");
  const removing = useRef<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  // manifest import
  const [manifestOpen, setManifestOpen] = useState(false);
  const [manifestRaw, setManifestRaw] = useState("");
  const [manifestMsg, setManifestMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const [src, ch] = await Promise.all([
        supabase.from("notebook_sources")
          .select("id,notebook_id,kind,title,url,content,created_at,week,page_count,meta").eq("user_id", uid).eq("notebook_id", notebookId)
          .order("created_at", { ascending: false }),
        // one read of every chunk's source_id, grouped here — PostgREST has no
        // GROUP BY without server-side aggregates enabled
        supabase.from("notebook_chunks").select("source_id").eq("user_id", uid).eq("notebook_id", notebookId).range(0, 4999),
      ]);
      if (src.error) { setLoadErr(true); setLoaded(true); return false; }
      const list = (src.data ?? []) as SourceRow[];
      sourcesRef.current = list;
      setSources(list);
      if (ch.error) setChunkCounts(null);
      else {
        const counts: Record<string, number> = {};
        for (const row of (ch.data ?? []) as { source_id: string }[]) counts[row.source_id] = (counts[row.source_id] ?? 0) + 1;
        setChunkCounts(counts);
      }
      setLoadErr(false);
      setLoaded(true);
      onCount?.(list.length);
      return true;
    } catch {
      setLoadErr(true); setLoaded(true); return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, notebookId]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  // After any successful write: refresh, then tell the parent if this notebook
  // just went from nothing to something.
  async function afterInsert(wasEmpty: boolean) {
    const ok = await load();
    if (!ok) setErr("Saved — but the list couldn't refresh. Reopen this notebook to see it.");
    if (wasEmpty) onFirstSource?.();
  }

  // Shared insert path — write first, then refresh + report honestly.
  async function insertSource(kind: string, name: string, url: string, content: string, extra: SourceExtra = {}) {
    const full = content.length;
    const stored = content.slice(0, MAX_CONTENT);
    const wasEmpty = sourcesRef.current.length === 0;
    const { error } = await supabase.from("notebook_sources").insert({
      user_id: uid, notebook_id: notebookId, kind, title: name.slice(0, 200), url, content: stored,
      week: extra.week ?? null, page_count: extra.page_count ?? 0, meta: extra.meta ?? {},
    });
    if (error) { setErr("Couldn't save that source — it's still here, try again."); return false; }
    setInput(""); setTitle(""); setWeek(""); setAdding(false);
    sfx.coin();
    if (full > MAX_CONTENT) setWarn(`Saved, but it was ${Math.round(full / 1000)}k characters and only the first ${MAX_CONTENT / 1000}k fit — split it if the tail matters.`);
    await afterInsert(wasEmpty);
    return true;
  }

  async function addSource() {
    const raw = input.trim();
    if (!raw || busy) return;
    setBusy(true); setErr(""); setNote(""); setWarn("");
    const url = firstUrl(raw);
    const onlyUrl = isOnlyUrl(raw);
    const wk = weekOf(week);
    let name = title.trim();
    try {
      if (url && isYouTube(url)) {
        setNote("Pulling the transcript…");
        const { data: session } = await supabase.auth.getSession();
        const res = await fetch(TRANSCRIPT_FN, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
          body: JSON.stringify({ url }),
        });
        const json = await res.json();
        if (json.error || !json.text) { setErr(json.error || "Couldn't pull that transcript — paste the text instead."); return; }
        const myNote = onlyUrl ? "" : raw.replace(url, " ").replace(/\s+/g, " ").trim();
        const content = myNote ? `MY NOTE: ${myNote}\n\n--- TRANSCRIPT ---\n${json.text}` : json.text;
        await insertSource("youtube", name || json.title || "YouTube video", url, content, { week: wk });
      } else if (onlyUrl) {
        await insertSource("link", name || url.replace(/^https?:\/\//, "").slice(0, 60), url, "", { week: wk });
      } else {
        if (!name) name = raw.slice(0, 50).replace(/\s+/g, " ").trim() || "Note";
        await insertSource("note", name, url, raw, { week: wk });
      }
    } catch {
      setErr("Couldn't reach the server — nothing was saved, your text is still here.");
    } finally {
      setBusy(false); setNote("");
    }
  }

  async function addPdf(file: File) {
    if (busy) return;
    setBusy(true); setErr(""); setNote(""); setWarn("");
    try {
      if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) { setErr("That's not a PDF — pick a .pdf file."); return; }
      setNote("Reading the PDF…");
      const b64 = await fileToB64(file);
      if (b64.length > MAX_PDF_B64) { setErr("That PDF is too big to read here — split it or paste the key pages as text."); return; }
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(PDF_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
        body: JSON.stringify({ pdf: b64, name: file.name }),
      });
      const json = await res.json();
      if (json.error || !json.text) { setErr(json.error || "Couldn't read that PDF — paste the text instead."); return; }
      const name = title.trim() || file.name.replace(/\.pdf$/i, "").slice(0, 120);
      await insertSource("pdf", name, "", json.text, { week: weekOf(week), page_count: Number(json.pages) || 0 });
    } catch {
      setErr("Couldn't read that PDF — try again, or paste the text.");
    } finally {
      setBusy(false); setNote("");
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // One paste → sources + deadlines + goals. Sources first (the material is
  // the point); deadlines second; each step reports on its own so a partial
  // import is never described as a full one.
  async function importManifest() {
    const raw = manifestRaw.trim();
    if (!raw || busy) return;
    const parsed = parseManifest(raw);
    if ("problem" in parsed) { setManifestMsg(parsed.problem); return; }
    const { manifest } = parsed;
    setBusy(true); setErr(""); setManifestMsg("");
    const wasEmpty = sourcesRef.current.length === 0;
    try {
      const learn = manifest.items.filter((i) => LEARNING_KINDS.has(i.kind) && ((i.text ?? "").trim() || i.url));
      const dated = manifest.items.filter((i) => isIsoDay(i.date));
      if (!learn.length && !dated.length) { setManifestMsg("Nothing importable — items need text or a url to become a source, or a date to become a deadline."); return; }
      const parts: string[] = [];

      if (learn.length) {
        setNote(`Saving ${learn.length} source${learn.length === 1 ? "" : "s"}…`);
        const rows = learn.map((i) => {
          const text = (i.text ?? "").trim();
          return {
            user_id: uid, notebook_id: notebookId, kind: text ? "note" : "link",
            title: i.title.trim().slice(0, 200), url: i.url ?? "", content: text.slice(0, MAX_CONTENT),
            week: weekOf(i.week), page_count: 0, meta: { kind: i.kind, week: weekOf(i.week) },
          };
        });
        const { error } = await supabase.from("notebook_sources").insert(rows);
        if (error) { setManifestMsg("Couldn't save the sources — nothing was imported, the JSON is still here."); return; }
        parts.push(`${rows.length} source${rows.length === 1 ? "" : "s"}`);
      }

      if (dated.length) {
        setNote(`Saving ${dated.length} deadline${dated.length === 1 ? "" : "s"}…`);
        // no `done` in the payload: a re-import must never reopen a deadline he already ticked off
        const rows = dated.map((i) => {
          const date = i.date as string;
          const fallback = i.kind === "reading" ? "reading" : i.kind === "problem_set" ? "assignment" : "other";
          const kind = deadlineKind(i.title, fallback);
          return {
            user_id: uid, source: "syllabus", uid: manifestUid(manifest.course, i.title, date),
            course: manifest.course, title: i.title.trim().slice(0, 200), kind,
            due_at: dueAtFromDate(date), start_by: startByFor(date, kind, i.title),
            url: i.url ?? "", points: typeof i.points === "number" ? i.points : null, notebook_id: notebookId,
          };
        });
        const { error } = await supabase.from("deadlines").upsert(rows, { onConflict: "user_id,source,uid" });
        if (error) {
          parts.push("deadlines didn't save — paste again to retry just those");
        } else {
          parts.push(`${rows.length} deadline${rows.length === 1 ? "" : "s"}`);
          const mirrored = await mirrorGoals();
          parts.push(mirrored ? `${mirrored.created} on your list` : "goals not made yet — the Classes card can retry");
        }
      }

      // A notebook with no course code can't link to Canvas deadlines by
      // course_key; the manifest knows the code, so fill it in if it's blank.
      await supabase.from("notebooks").update({ course: manifest.course, kind: "class" })
        .eq("id", notebookId).eq("user_id", uid).eq("course", "");

      setManifestMsg(`Imported · ${parts.join(" · ")}`);
      setManifestRaw("");
      sfx.coin();
      if (learn.length) await afterInsert(wasEmpty);
    } catch {
      setManifestMsg("Couldn't reach the server — nothing was imported, the JSON is still here.");
    } finally {
      setBusy(false); setNote("");
    }
  }

  async function remove(id: string) {
    if (removing.current.has(id)) return;
    removing.current.add(id);
    setRemovingIds([...removing.current]);
    setErr("");
    try {
      const { error } = await supabase.from("notebook_sources").delete().eq("id", id);
      if (error) setErr("Couldn't remove that source.");
      await load();
    } catch {
      setErr("Couldn't reach the server — that source is still there.");
      await load();
    } finally {
      removing.current.delete(id);
      setRemovingIds([...removing.current]);
    }
  }

  function statusLine(s: SourceRow): string {
    if (!s.content) return "link only — the Tutor can't read this page";
    const bits: string[] = [];
    const n = chunkCounts?.[s.id];
    if (chunkCounts === null) bits.push(`${Math.round(s.content.length / 1000)}k chars · readable`);
    else if (!n) bits.push("saved · no passages found — the text may be too short");
    else bits.push(`indexed · ${n} passage${n === 1 ? "" : "s"}`);
    if (s.page_count > 0) bits.push(`${s.page_count} page${s.page_count === 1 ? "" : "s"}`);
    if (s.week) bits.push(`week ${s.week}`);
    const mk = s.meta?.kind;
    if (typeof mk === "string" && mk) bits.push(mk.replace("_", " "));
    return bits.join(" · ");
  }

  if (!loaded) return null;
  const grounded = sources.filter((s) => s.content.trim().length > 0).length;

  return (
    <Card className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs uppercase tracking-widest opacity-60">📚 Sources · {loadErr ? "?" : sources.length}</p>
        <button onClick={() => { setAdding((v) => !v); setManifestOpen(false); }} className="text-xs text-[var(--neon)] font-semibold active:scale-95">{adding ? "cancel" : "+ add"}</button>
      </div>
      <p className="text-[10px] opacity-40 mb-1">
        {grounded > 0
          ? `Chapters, quizzes, the podcast and the Tutor all learn from these ${grounded} source${grounded === 1 ? "" : "s"} — your material. "Passages" are the ~1,400-character pieces the Guide searches when it teaches.`
          : "Add notes, a YouTube link, or a PDF. Everything in this notebook is then built from YOUR material, not the internet."}
      </p>
      <button onClick={() => { setManifestOpen((v) => !v); setAdding(false); }} className="text-[10px] text-[var(--neon)] underline mb-2 active:scale-95">
        {manifestOpen ? "close manifest import" : "Import class manifest"}
      </button>

      {adding && (
        <div className="rounded-xl bg-black/30 p-2.5 mb-2">
          <div className="flex gap-1.5 mb-1.5">
            <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} placeholder="title (optional)"
              className="flex-1 min-w-0 rounded-lg bg-black/40 px-3 py-2 outline-none text-sm" />
            <input value={week} onChange={(e) => setWeek(e.target.value)} disabled={busy} placeholder="week" inputMode="numeric"
              className="w-16 rounded-lg bg-black/40 px-2 py-2 outline-none text-sm mono text-center" />
          </div>
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={4} disabled={busy}
            placeholder="paste notes / a transcript / an article — or a YouTube link to auto-pull its transcript"
            className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm resize-none" />
          <div className="flex gap-2 mt-2">
            <button onClick={addSource} disabled={busy || !input.trim()}
              className="flex-1 rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-40">
              {busy ? (note || "adding…") : "Add source"}
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={busy}
              className="rounded-lg bg-white/10 text-sm font-semibold px-3 py-2 active:scale-95 disabled:opacity-40">📄 PDF</button>
          </div>
          <input ref={fileRef} type="file" accept="application/pdf" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) addPdf(f); }} />
          <p className="text-[10px] opacity-40 mt-1.5">Week = the class week this belongs to (1–20, optional). Class notebooks order chapters by it.</p>
          {note && <p className="text-xs opacity-60 mt-1">{note}</p>}
        </div>
      )}

      {manifestOpen && (
        <div className="rounded-xl bg-black/30 p-2.5 mb-2">
          <p className="text-[11px] text-[var(--text-2)] leading-relaxed mb-1.5">
            A class manifest is one JSON block listing a course&apos;s lectures, readings and due dates. Get one by running the audit prompt
            in <span className="mono">docs/class-manifest.md</span> with Claude in Chrome on Canvas, then paste it here.
            Lectures and readings become sources; anything with a date becomes a deadline and lands on your daily list when it&apos;s time to start.
          </p>
          <textarea value={manifestRaw} onChange={(e) => setManifestRaw(e.target.value)} rows={5} disabled={busy}
            placeholder='{"schema":"daily.class-manifest/1","course":"ECON 201","items":[…]}'
            className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-xs mono resize-none" />
          <button onClick={importManifest} disabled={busy || !manifestRaw.trim()}
            className="w-full mt-2 rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-40">
            {busy ? (note || "importing…") : "Import"}
          </button>
          {manifestMsg && <p className={`text-xs mt-1.5 ${manifestMsg.startsWith("Imported") ? "text-[var(--ok)]" : "text-orange-300"}`}>{manifestMsg}</p>}
        </div>
      )}

      {loadErr && (
        <button onClick={() => load()} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 mb-2 active:scale-95">
          Couldn&apos;t load your sources — tap to retry
        </button>
      )}
      {!loadErr && sources.length === 0 && !adding && !manifestOpen && (
        <p className="text-sm opacity-40">No sources yet — add one and this notebook comes alive.</p>
      )}

      <div className="space-y-1.5">
        {sources.map((s) => (
          <div key={s.id} className="rounded-lg bg-white/[0.03] border border-white/10 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className="shrink-0">{KIND_ICON[s.kind] ?? "📄"}</span>
              <button onClick={() => setOpen(open === s.id ? null : s.id)} className="flex-1 min-w-0 text-left">
                <p className="text-sm truncate">{s.title}</p>
                <p className="text-[10px] opacity-40">{statusLine(s)}</p>
              </button>
              {s.url && <a href={s.url} target="_blank" rel="noreferrer" className="text-[10px] opacity-40 shrink-0">↗</a>}
              <button onClick={() => remove(s.id)} disabled={removingIds.includes(s.id)} className="opacity-30 text-xs shrink-0 active:scale-90 disabled:opacity-10">✕</button>
            </div>
            {open === s.id && s.content && (
              <p className="text-xs opacity-60 mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap">{s.content.slice(0, 4000)}</p>
            )}
          </div>
        ))}
      </div>
      {warn && <p className="text-xs text-orange-300 mt-2">{warn}</p>}
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
    </Card>
  );
}
