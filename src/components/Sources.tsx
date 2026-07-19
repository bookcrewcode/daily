"use client";

// 📚 Sources — the NotebookLM half of the Learning Hub.
//
// NotebookLM itself can't be embedded (notebooklm.google.com sends
// X-Frame-Options: DENY and has no public API), so the valuable part is built
// natively instead: put YOUR material into a topic, and the Tutor answers
// grounded in it — with the 3C protocol already applied on top, which NotebookLM
// doesn't know about.
//
// A YouTube link is pulled through the existing transcript edge function, so a
// video becomes a readable, searchable source in one paste.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, SUPABASE_URL, SUPABASE_ANON } from "@/lib/supabase";
import { sfx } from "@/lib/fx";
import { Card } from "./ui";

const TRANSCRIPT_FN = `${SUPABASE_URL}/functions/v1/transcript`;

export type Source = { id: string; kind: string; title: string; url: string; content: string };

const KIND_ICON: Record<string, string> = { youtube: "🎥", link: "🔗", note: "📝" };

// Postgres column cap. Anything past this genuinely cannot be stored, so the
// user gets told rather than losing the tail silently.
const MAX_CONTENT = 200000;

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const firstUrl = (s: string) => s.match(URL_RE)?.[0] ?? "";
// "the whole paste is nothing but a link" — NOT "the paste starts with a link",
// which would throw away everything he typed after it.
const isOnlyUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());
const isYouTube = (s: string) => /(?:youtube\.com|youtu\.be)/i.test(s);

export default function Sources({ uid, topicId, onChanged }: {
  uid: string; topicId: string; onChanged?: (sources: Source[]) => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
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

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("learning_sources")
        .select("id,kind,title,url,content").eq("user_id", uid).eq("topic_id", topicId)
        .order("created_at", { ascending: false });
      // A failed read must never masquerade as "you have no sources" — that would
      // make an empty list indistinguishable from a broken one.
      if (error) { setLoadErr(true); setLoaded(true); return false; }
      const list = (data ?? []) as Source[];
      setSources(list);
      setLoadErr(false);
      setLoaded(true);
      onChanged?.(list);
      return true;
    } catch {
      setLoadErr(true); setLoaded(true); return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, topicId]);
  useEffect(() => { load(); }, [load]);

  async function addSource() {
    const raw = input.trim();
    if (!raw || busy) return;
    setBusy(true); setErr(""); setNote(""); setWarn("");

    const url = firstUrl(raw);
    const onlyUrl = isOnlyUrl(raw);
    let kind = "note";
    let content = raw;
    let srcUrl = "";
    let name = title.trim();

    try {
      if (url && isYouTube(url)) {
        kind = "youtube";
        srcUrl = url;
        setNote("Pulling the transcript…");
        const { data: session } = await supabase.auth.getSession();
        const res = await fetch(TRANSCRIPT_FN, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
          body: JSON.stringify({ url }),
        });
        const json = await res.json();
        if (json.error || !json.text) {
          setErr(json.error || "Couldn't pull that transcript — paste the text instead.");
          return;
        }
        // anything he typed alongside the link is HIS thinking — keep it, on top
        const myNote = onlyUrl ? "" : raw.replace(url, " ").replace(/\s+/g, " ").trim();
        content = myNote ? `MY NOTE: ${myNote}\n\n--- TRANSCRIPT ---\n${json.text}` : json.text;
        if (!name) name = json.title || "YouTube video";
      } else if (onlyUrl) {
        // a paste that is ONLY a link: store it as a reference, and say plainly
        // that the tutor can't read the page (no server-side fetcher for
        // arbitrary sites)
        kind = "link";
        srcUrl = url;
        content = "";
        if (!name) name = url.replace(/^https?:\/\//, "").slice(0, 60);
      } else {
        // text — possibly with a link inside it. Keep every character.
        kind = "note";
        content = raw;
        srcUrl = url;
      }

      if (!name) name = content.slice(0, 50).replace(/\s+/g, " ").trim() || "Note";

      const full = content.length;
      const stored = content.slice(0, MAX_CONTENT);

      // write first — the pasted text stays put if the insert fails
      const { error } = await supabase.from("learning_sources").insert({
        user_id: uid, topic_id: topicId, kind, title: name.slice(0, 200), url: srcUrl, content: stored,
      });
      if (error) { setErr("Couldn't save that source — it's still here, try again."); return; }

      setInput(""); setTitle(""); setAdding(false);
      sfx.coin();
      if (full > MAX_CONTENT) {
        setWarn(`Saved, but it was ${Math.round(full / 1000)}k characters and only the first ${MAX_CONTENT / 1000}k fit — the tail was cut. Split it into two sources if the end matters.`);
      }
      // the row is saved; if the refresh read fails, say so rather than leaving
      // him staring at a list that never grew
      const ok = await load();
      if (!ok) setErr("Saved — but the list couldn't refresh. Reopen this topic to see it.");
    } catch {
      setErr("Couldn't reach the server — nothing was saved, your text is still here.");
    } finally {
      setBusy(false);
      setNote("");
    }
  }

  async function remove(id: string) {
    if (removing.current.has(id)) return;
    removing.current.add(id);
    setRemovingIds([...removing.current]);
    setErr("");
    try {
      const { error } = await supabase.from("learning_sources").delete().eq("id", id);
      // Don't restore a stale snapshot — re-read ground truth either way, so a
      // second delete in flight can't resurrect the row it already removed.
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
        <button onClick={() => setAdding((v) => !v)} className="text-xs text-[var(--neon)] font-semibold active:scale-95">
          {adding ? "cancel" : "+ add"}
        </button>
      </div>
      <p className="text-[10px] opacity-40 mb-2">
        {grounded > 0
          ? `The Tutor answers from these ${grounded} source${grounded === 1 ? "" : "s"} — your material, your protocol.`
          : "Paste notes, a YouTube link, or a doc. The Tutor then teaches from YOUR material, not the internet."}
      </p>

      {adding && (
        <div className="rounded-xl bg-black/30 p-2.5 mb-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} placeholder="title (optional)"
            className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm mb-1.5" />
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={4} disabled={busy}
            placeholder="paste notes / a transcript / an article — or a YouTube link to auto-pull its transcript"
            className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm resize-none" />
          <button onClick={addSource} disabled={busy || !input.trim()}
            className="mt-2 w-full rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-40">
            {busy ? (note || "adding…") : "Add source"}
          </button>
        </div>
      )}

      {loadErr && (
        <button onClick={() => load()} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 mb-2 active:scale-95">
          Couldn&apos;t load your sources — tap to retry
        </button>
      )}

      {!loadErr && sources.length === 0 && !adding && (
        <p className="text-sm opacity-40">No sources yet — add one and the Tutor stops guessing.</p>
      )}

      <div className="space-y-1.5">
        {sources.map((s) => (
          <div key={s.id} className="rounded-lg bg-white/[0.03] border border-white/10 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className="shrink-0">{KIND_ICON[s.kind] ?? "📄"}</span>
              <button onClick={() => setOpen(open === s.id ? null : s.id)} className="flex-1 min-w-0 text-left">
                <p className="text-sm truncate">{s.title}</p>
                <p className="text-[10px] opacity-40">
                  {s.content ? `${Math.round(s.content.length / 1000)}k chars · readable` : "link only — the Tutor can't read this page"}
                </p>
              </button>
              {s.url && (
                <a href={s.url} target="_blank" rel="noreferrer" className="text-[10px] opacity-40 shrink-0">↗</a>
              )}
              <button onClick={() => remove(s.id)} disabled={removingIds.includes(s.id)}
                className="opacity-30 text-xs shrink-0 active:scale-90 disabled:opacity-10">✕</button>
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
