"use client";

// 🎓 The Tutor, inside a notebook. Same chat_messages thread (advisor='tutor',
// keyed by notebook id) so the conversation persists. The advisor grounds every
// reply in this notebook's sources, chapters, weak spots and accuracy, and runs
// Ben's 3C protocol. Write-first; a failed read never wipes the thread, and a
// failed write never jams the composer.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import { advisorCall } from "@/lib/notebook";
import { Card } from "./ui";

type ChatMsg = { role: string; content: string };

export default function NotebookChat({ uid, notebookId }: { uid: string; notebookId: string }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollDown = () => setTimeout(() => scrollRef.current?.scrollTo(0, 1e9), 60);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("chat_messages").select("role,content")
        .eq("user_id", uid).eq("advisor", "tutor").eq("topic_id", notebookId)
        .order("created_at", { ascending: false }).limit(30);
      // A failed read must NOT render like an empty thread — that would also make
      // the history sent to the tutor silently empty.
      if (error) { setLoadErr(true); setLoaded(true); return; }
      setMsgs(((data ?? []) as ChatMsg[]).reverse());
      setLoadErr(false); setLoaded(true);
      scrollDown();
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid, notebookId]);
  useEffect(() => { load(); }, [load]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true); setNote("");
    try {
      // save FIRST — "sent" must mean saved; input stays put on failure
      const { error } = await supabase.from("chat_messages")
        .insert({ user_id: uid, advisor: "tutor", topic_id: notebookId, role: "user", content: text });
      if (error) { setNote("Couldn't save that — check your connection and try again."); return; }
      const history = msgs.slice(-14);
      setInput("");
      setMsgs((m) => [...m, { role: "user", content: text }]);
      scrollDown();
      const json = await advisorCall<{ text?: string; error?: string }>({ advisor: "tutor", message: text, history, topicId: notebookId, clientDay: todayStr() });
      const reply = json.text || json.error || "No response.";
      if (json.text) {
        const { error: aErr } = await supabase.from("chat_messages").insert({ user_id: uid, advisor: "tutor", topic_id: notebookId, role: "assistant", content: json.text });
        if (aErr) setNote("Heads up — that reply couldn't be saved to history, so it'll be gone if you leave.");
      }
      setMsgs((m) => [...m, { role: "assistant", content: reply }]);
      scrollDown();
    } catch {
      setNote("Couldn't reach the Tutor — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card tone="neon" className="mt-3" padded={false}>
      <div className="px-4 pt-3 pb-2">
        <p className="text-xs uppercase tracking-widest text-[var(--neon)]">🎓 Tutor — ask anything in this notebook</p>
      </div>
      <div ref={scrollRef} className="max-h-[45vh] overflow-y-auto px-4 space-y-2">
        {loadErr && (
          <button onClick={load} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">
            Couldn&apos;t load your conversation — tap to retry
          </button>
        )}
        {loaded && !loadErr && msgs.length === 0 && (
          <p className="text-xs opacity-50 pb-1">Ask anything about this notebook. The Tutor teaches from YOUR sources, runs your 3C protocol (trunk first, retrieval always), and already knows your chapters, weak spots, and accuracy.</p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`text-sm whitespace-pre-wrap rounded-xl px-3 py-2 ${m.role === "user" ? "bg-[var(--neon)]/15 ml-6" : "bg-black/30 mr-2"}`}>{m.content}</div>
        ))}
        {busy && <div className="skeleton h-10 mr-2" />}
      </div>
      <div className="flex gap-2 p-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={busy ? "tutor is thinking…" : "ask, answer, or say “quiz me”"}
          className="flex-1 min-w-0 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
        <button onClick={send} disabled={busy} className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-40">↑</button>
      </div>
      {note && <p className="text-xs text-orange-400 px-4 pb-3 -mt-1">{note}</p>}
    </Card>
  );
}
