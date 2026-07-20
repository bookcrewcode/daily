"use client";

// 📚 Sources for a notebook — notes, a YouTube link (auto-transcript), a bare
// link, or a PDF (extracted server-side). The Tutor teaches grounded in these,
// and the chapters/quizzes/podcast are all built from them.
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

const KIND_ICON: Record<string, string> = { youtube: "🎥", link: "🔗", note: "📝", pdf: "📄" };
const MAX_CONTENT = 200000;
const MAX_PDF_B64 = 9_000_000; // ~6.7 MB file

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const firstUrl = (s: string) => s.match(URL_RE)?.[0] ?? "";
const isOnlyUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());
const isYouTube = (s: string) => /(?:youtube\.com|youtu\.be)/i.test(s);

function fileToB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file); // data:...;base64,XXXX — the function strips the prefix
  });
}

export default function NotebookSources({ uid, notebookId, onCount }: {
  uid: string; notebookId: string; onCount?: (n: number) => void;
}) {
  const [sources, setSources] = useState<NBSource[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [warn, setWarn] = useState("");
  const [err, setErr] = useState("");
  const removing = useRef<Set<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("notebook_sources")
        .select("id,notebook_id,kind,title,url,content,created_at").eq("user_id", uid).eq("notebook_id", notebookId)
        .order("created_at", { ascending: false });
      if (error) { setLoadErr(true); setLoaded(true); return false; }
      const list = (data ?? []) as NBSource[];
      setSources(list);
      setLoadErr(false);
      setLoaded(true);
      onCount?.(list.length);
      return true;
    } catch {
      setLoadErr(true); setLoaded(true); return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, notebookId]);
  useEffect(() => { load(); }, [load]);

  // Shared insert path — write first, then refresh + report honestly.
  async function insertSource(kind: string, name: string, url: string, content: string) {
    const full = content.length;
    const stored = content.slice(0, MAX_CONTENT);
    const { error } = await supabase.from("notebook_sources").insert({
      user_id: uid, notebook_id: notebookId, kind, title: name.slice(0, 200), url, content: stored,
    });
    if (error) { setErr("Couldn't save that source — it's still here, try again."); return false; }
    setInput(""); setTitle(""); setAdding(false);
    sfx.coin();
    if (full > MAX_CONTENT) setWarn(`Saved, but it was ${Math.round(full / 1000)}k characters and only the first ${MAX_CONTENT / 1000}k fit — split it if the tail matters.`);
    const ok = await load();
    if (!ok) setErr("Saved — but the list couldn't refresh. Reopen this notebook to see it.");
    return true;
  }

  async function addSource() {
    const raw = input.trim();
    if (!raw || busy) return;
    setBusy(true); setErr(""); setNote(""); setWarn("");
    const url = firstUrl(raw);
    const onlyUrl = isOnlyUrl(raw);
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
        await insertSource("youtube", name || json.title || "YouTube video", url, content);
      } else if (onlyUrl) {
        await insertSource("link", name || url.replace(/^https?:\/\//, "").slice(0, 60), url, "");
      } else {
        if (!name) name = raw.slice(0, 50).replace(/\s+/g, " ").trim() || "Note";
        await insertSource("note", name, url, raw);
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
      await insertSource("pdf", name, "", json.text);
    } catch {
      setErr("Couldn't read that PDF — try again, or paste the text.");
    } finally {
      setBusy(false); setNote("");
      if (fileRef.current) fileRef.current.value = "";
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

  if (!loaded) return null;
  const grounded = sources.filter((s) => s.content.trim().length > 0).length;

  return (
    <Card className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs uppercase tracking-widest opacity-60">📚 Sources · {loadErr ? "?" : sources.length}</p>
        <button onClick={() => setAdding((v) => !v)} className="text-xs text-[var(--neon)] font-semibold active:scale-95">{adding ? "cancel" : "+ add"}</button>
      </div>
      <p className="text-[10px] opacity-40 mb-2">
        {grounded > 0
          ? `Chapters, quizzes, the podcast and the Tutor all learn from these ${grounded} source${grounded === 1 ? "" : "s"} — your material.`
          : "Add notes, a YouTube link, or a PDF. Everything in this notebook is then built from YOUR material, not the internet."}
      </p>

      {adding && (
        <div className="rounded-xl bg-black/30 p-2.5 mb-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} placeholder="title (optional)"
            className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm mb-1.5" />
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
          {note && <p className="text-xs opacity-60 mt-1">{note}</p>}
        </div>
      )}

      {loadErr && (
        <button onClick={() => load()} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 mb-2 active:scale-95">
          Couldn&apos;t load your sources — tap to retry
        </button>
      )}
      {!loadErr && sources.length === 0 && !adding && (
        <p className="text-sm opacity-40">No sources yet — add one and this notebook comes alive.</p>
      )}

      <div className="space-y-1.5">
        {sources.map((s) => (
          <div key={s.id} className="rounded-lg bg-white/[0.03] border border-white/10 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className="shrink-0">{KIND_ICON[s.kind] ?? "📄"}</span>
              <button onClick={() => setOpen(open === s.id ? null : s.id)} className="flex-1 min-w-0 text-left">
                <p className="text-sm truncate">{s.title}</p>
                <p className="text-[10px] opacity-40">{s.content ? `${Math.round(s.content.length / 1000)}k chars · readable` : "link only — the Tutor can't read this page"}</p>
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
