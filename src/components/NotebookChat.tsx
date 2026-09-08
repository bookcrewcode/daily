"use client";

// 🎓 The Learning Guide, inside a notebook. Same chat_messages thread
// (advisor='tutor', keyed by notebook id) so the conversation persists. It asks
// before it tells — one question per turn, hints before answers — and honours
// "just tell me" as the escape hatch. Replies cite passages as [chunk:<id>];
// those render as numbered chips that open the passage, so "where did that
// come from" is one tap, never a search through Sources.
// Write-first; a failed read never wipes the thread, a failed write never jams
// the composer.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { supabase, todayStr } from "@/lib/supabase";
import { advisorCall } from "@/lib/notebook";
import { Card } from "./ui";

type ChatMsg = { role: string; content: string };
const CHUNK_RE = /\[chunk:([0-9a-f-]{8,})\]/gi;

// "[chunk:id]" → [1] chips, numbered by first appearance within the message.
function renderWithChips(text: string, onChip: (id: string) => void): ReactNode[] {
  const order: string[] = [];
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(CHUNK_RE)) {
    const id = m[1];
    let n = order.indexOf(id);
    if (n < 0) { order.push(id); n = order.length - 1; }
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(
      <button key={`${m.index}-${id}`} onClick={() => onChip(id)}
        className="inline-grid place-items-center align-baseline mx-0.5 min-w-[1.25rem] h-5 px-1 rounded-md bg-[var(--neon)]/20 text-[var(--neon)] text-[10px] font-bold active:scale-90">
        {n + 1}
      </button>,
    );
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function NotebookChat({ uid, notebookId, chapterTitle, interests }: { uid: string; notebookId: string; chapterTitle?: string; interests?: string[] }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [passage, setPassage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollDown = () => setTimeout(() => scrollRef.current?.scrollTo(0, 1e9), 60);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("chat_messages").select("role,content")
        .eq("user_id", uid).eq("advisor", "tutor").eq("topic_id", notebookId)
        .order("created_at", { ascending: false }).limit(30);
      // A failed read must NOT render like an empty thread — that would also make
      // the history sent to the guide silently empty.
      if (error) { setLoadErr(true); setLoaded(true); return; }
      setMsgs(((data ?? []) as ChatMsg[]).reverse());
      setLoadErr(false); setLoaded(true);
      scrollDown();
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid, notebookId]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function send(preset?: string) {
    const text = (preset ?? input).trim();
    if (!text || busy) return;
    setBusy(true); setNote("");
    try {
      // save FIRST — "sent" must mean saved; input stays put on failure
      const { error } = await supabase.from("chat_messages")
        .insert({ user_id: uid, advisor: "tutor", topic_id: notebookId, role: "user", content: text });
      if (error) { setNote("Couldn't save that — check your connection and try again."); return; }
      const history = msgs.slice(-14);
      if (!preset) setInput("");
      setMsgs((m) => [...m, { role: "user", content: text }]);
      scrollDown();
      const json = await advisorCall<{ text?: string; error?: string }>({
        advisor: "tutor", message: text, history, topicId: notebookId, chapterTitle: chapterTitle ?? "", clientDay: todayStr(),
        interests: (interests ?? []).slice(0, 6),
      });
      const reply = json.text || json.error || "No response.";
      if (json.text) {
        const { error: aErr } = await supabase.from("chat_messages").insert({ user_id: uid, advisor: "tutor", topic_id: notebookId, role: "assistant", content: json.text });
        if (aErr) setNote("Heads up — that reply couldn't be saved to history, so it'll be gone if you leave.");
      }
      setMsgs((m) => [...m, { role: "assistant", content: reply }]);
      scrollDown();
    } catch {
      setNote("Couldn't reach the guide — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card tone="neon" className="mt-3" padded={false}>
      <div className="px-4 pt-3 pb-2">
        <p className="text-xs uppercase tracking-widest text-[var(--neon)]">🎓 Learning Guide</p>
        <p className="text-[11px] opacity-60 mt-0.5">Asks before it tells. Say &lsquo;just tell me&rsquo; when you want the answer.</p>
      </div>
      <div ref={scrollRef} className="max-h-[45vh] overflow-y-auto px-4 space-y-2">
        {loadErr && (
          <button onClick={load} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">
            Couldn&apos;t load your conversation — tap to retry
          </button>
        )}
        {loaded && !loadErr && msgs.length === 0 && (
          <p className="text-xs opacity-50 pb-1">Ask anything in this notebook. The guide answers from your sources and knows which chapters you&apos;ve missed. Numbered chips in a reply open the passage it came from.</p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`text-sm whitespace-pre-wrap rounded-xl px-3 py-2 ${m.role === "user" ? "bg-[var(--neon)]/15 ml-6" : "bg-black/30 mr-2"}`}>
            {m.role === "assistant" ? renderWithChips(m.content, setPassage) : m.content}
          </div>
        ))}
        {busy && <div className="skeleton h-10 mr-2" />}
      </div>
      <div className="flex gap-2 px-3 pt-3">
        <button onClick={() => send("Just tell me")} disabled={busy || !msgs.length}
          className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold active:scale-95 disabled:opacity-30">Just tell me</button>
        <button onClick={() => send("Quiz me on this")} disabled={busy}
          className="rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold active:scale-95 disabled:opacity-30">Quiz me</button>
      </div>
      <div className="flex gap-2 p-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={busy ? "guide is thinking…" : "ask, answer, or say “just tell me”"}
          className="flex-1 min-w-0 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
        <button onClick={() => send()} disabled={busy} className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-40">↑</button>
      </div>
      {note && <p className="text-xs text-orange-400 px-4 pb-3 -mt-1">{note}</p>}
      {passage && <PassageSheet id={passage} onClose={() => setPassage(null)} />}
    </Card>
  );
}

// The passage behind a chip. Read on open (never cached from the reply — the
// id is the only thing the model was allowed to write; the text is ours).
type Chunk = { id: string; source_id: string; heading: string; page_no: number | null; text: string };

function PassageSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const [chunk, setChunk] = useState<Chunk | null>(null);
  const [source, setSource] = useState("");
  const [state, setState] = useState<"loading" | "ok" | "err" | "gone">("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const { data, error } = await supabase.from("notebook_chunks").select("id,source_id,heading,page_no,text").eq("id", id).maybeSingle();
      if (error) { setState("err"); return; }
      if (!data) { setState("gone"); return; }
      const c = data as Chunk;
      setChunk(c); setState("ok");
      // the source title is a nicety — a failure here just leaves it blank
      const { data: s } = await supabase.from("notebook_sources").select("title").eq("id", c.source_id).maybeSingle();
      if (s) setSource((s as { title: string }).title);
    } catch { setState("err"); }
  }, [id]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end md:items-center md:justify-center" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full md:max-w-lg bg-[var(--background)] rounded-t-3xl md:rounded-3xl border-t md:border border-white/10 p-4 pb-8 md:pb-4 max-h-[80vh] overflow-y-auto" style={{ animation: "fadeSlide 0.2s ease" }}>
        <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-3 md:hidden" />
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs uppercase tracking-widest opacity-60">📚 From your sources</p>
          <button onClick={onClose} className="text-sm opacity-50 active:scale-90">✕</button>
        </div>
        {state === "loading" && <div className="skeleton h-24" />}
        {state === "err" && <button onClick={load} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">Couldn&apos;t load that passage — tap to retry</button>}
        {state === "gone" && <p className="text-sm opacity-60">That passage isn&apos;t in this notebook any more — its source was removed or re-indexed.</p>}
        {state === "ok" && chunk && (
          <>
            <p className="text-[11px] opacity-55 mb-2">
              {source || "Source"}{chunk.page_no != null ? ` · p.${chunk.page_no}` : ""}{chunk.heading ? ` · ${chunk.heading}` : ""}
            </p>
            <p className="study-prose text-[0.98rem] whitespace-pre-wrap">{chunk.text}</p>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
