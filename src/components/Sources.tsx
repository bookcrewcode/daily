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

import { useCallback, useEffect, useState } from "react";
import { supabase, SUPABASE_URL, SUPABASE_ANON } from "@/lib/supabase";
import { sfx } from "@/lib/fx";
import { Card } from "./ui";

const TRANSCRIPT_FN = `${SUPABASE_URL}/functions/v1/transcript`;

export type Source = { id: string; kind: string; title: string; url: string; content: string };

const KIND_ICON: Record<string, string> = { youtube: "🎥", link: "🔗", note: "📝" };

function isYouTube(s: string) {
  return /(?:youtube\.com|youtu\.be)/i.test(s.trim());
}

export default function Sources({ uid, topicId, onChanged }: {
  uid: string; topicId: string; onChanged?: (sources: Source[]) => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("learning_sources")
      .select("id,kind,title,url,content").eq("user_id", uid).eq("topic_id", topicId)
      .order("created_at", { ascending: false });
    if (error) { setLoaded(true); return; } // keep what's on screen
    const list = (data ?? []) as Source[];
    setSources(list);
    setLoaded(true);
    onChanged?.(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, topicId]);
  useEffect(() => { load(); }, [load]);

  async function addSource() {
    const raw = input.trim();
    if (!raw || busy) return;
    setBusy(true); setErr(""); setNote("");

    let kind = "note";
    let content = raw;
    let url = "";
    let name = title.trim();

    if (isYouTube(raw)) {
      kind = "youtube";
      url = raw;
      setNote("Pulling the transcript…");
      try {
        const { data: session } = await supabase.auth.getSession();
        const res = await fetch(TRANSCRIPT_FN, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
          body: JSON.stringify({ url: raw }),
        });
        const json = await res.json();
        if (json.error || !json.text) {
          setBusy(false); setNote("");
          setErr(json.error || "Couldn't pull that transcript — paste the text instead.");
          return;
        }
        content = json.text;
        if (!name) name = json.title || "YouTube video";
      } catch {
        setBusy(false); setNote("");
        setErr("Couldn't reach the transcript service — paste the text instead.");
        return;
      }
    } else if (/^https?:\/\//i.test(raw) && raw.length < 300) {
      // a bare link with no text: store it as a reference, but say plainly that
      // the tutor can't read the page (no server-side fetcher for arbitrary sites)
      kind = "link";
      url = raw;
      content = "";
      if (!name) name = raw.replace(/^https?:\/\//, "").slice(0, 60);
    }

    if (!name) name = content.slice(0, 50).replace(/\s+/g, " ").trim() || "Note";

    // write first — the pasted text stays put if the insert fails
    const { error } = await supabase.from("learning_sources").insert({
      user_id: uid, topic_id: topicId, kind, title: name.slice(0, 200), url, content: content.slice(0, 200000),
    });
    setBusy(false); setNote("");
    if (error) { setErr("Couldn't save that source — it's still here, try again."); return; }
    setInput(""); setTitle(""); setAdding(false);
    sfx.coin();
    load();
  }

  async function remove(id: string) {
    const prev = sources;
    setSources((s) => s.filter((x) => x.id !== id));
    const { error } = await supabase.from("learning_sources").delete().eq("id", id);
    if (error) { setSources(prev); setErr("Couldn't remove that source."); return; }
    load();
  }

  if (!loaded) return null;

  const grounded = sources.filter((s) => s.content.trim().length > 0).length;

  return (
    <Card className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs uppercase tracking-widest opacity-60">📚 Sources · {sources.length}</p>
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
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="title (optional)"
            className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm mb-1.5" />
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={4}
            placeholder="paste notes / a transcript / an article — or a YouTube link to auto-pull its transcript"
            className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm resize-none" />
          <button onClick={addSource} disabled={busy || !input.trim()}
            className="mt-2 w-full rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-40">
            {busy ? (note || "adding…") : "Add source"}
          </button>
          {note && !busy && <p className="text-xs opacity-60 mt-1">{note}</p>}
        </div>
      )}

      {sources.length === 0 && !adding && (
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
              <button onClick={() => remove(s.id)} className="opacity-30 text-xs shrink-0 active:scale-90">✕</button>
            </div>
            {open === s.id && s.content && (
              <p className="text-xs opacity-60 mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap">{s.content.slice(0, 4000)}</p>
            )}
          </div>
        ))}
      </div>
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
    </Card>
  );
}
