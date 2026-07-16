"use client";

// The AI board — now with a real memory system:
// - Every thread PERSISTS (chat_messages): close the app, come back, it's there.
// - The coach REMEMBERS (ai_memories): after each exchange a background job
//   extracts durable facts; they're injected into every future conversation
//   as dated facts, and fully visible/editable here (🧠) — invisible memory
//   that can't be corrected is how users lose trust in the whole app.
// - Tutor sessions close the loop: 📝 Recap extracts chunks / weak spots /
//   retrieval results from the conversation into the Learning system, with a
//   review-before-save preview (AI output never auto-enters your data).

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, ADVISOR_FN, SUPABASE_ANON, todayStr } from "@/lib/supabase";
import { useVoiceInput } from "@/lib/useVoiceInput";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { sfx } from "@/lib/fx";

type Msg = { role: "user" | "assistant"; content: string };
type Recap = { chunks: string[]; weak_spots: string[]; retrieval: { question: string; got_it: boolean }[] };
type Memory = { id: string; content: string; category: string; created_at: string };

const ADVISORS = [
  { key: "board", emoji: "🏛️", name: "The Board" },
  { key: "hormozi", emoji: "🔨", name: "Hormozi" },
  { key: "rubin", emoji: "🎛️", name: "Rubin" },
  { key: "naval", emoji: "🧭", name: "Naval" },
  { key: "overseer", emoji: "👁️", name: "Overseer" },
  { key: "tutor", emoji: "🎓", name: "Tutor" },
];

async function callAdvisor(body: Record<string, unknown>) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(ADVISOR_FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    // clientDay lets the edge fn resolve "today" in Ben's local time, and is
    // injected here so every advisor call carries it — no caller can forget it
    body: JSON.stringify({ clientDay: todayStr(), ...body }),
  });
  return await res.json();
}

export default function Board({ onClose, initialAdvisor, topicId }: { onClose: () => void; initialAdvisor?: string; topicId?: string }) {
  const game = useGame();
  const [advisor, setAdvisor] = useState(initialAdvisor ?? "overseer");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loadingThread, setLoadingThread] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [memOpen, setMemOpen] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [recap, setRecap] = useState<Recap | null>(null);
  const [recapBusy, setRecapBusy] = useState(false);
  const [recapDrop, setRecapDrop] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [sendErr, setSendErr] = useState(false);
  const [memErr, setMemErr] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const voice = useVoiceInput((text) => setInput(text));
  // guards against a reply landing after the user switched advisor tabs
  const advisorRef = useRef(advisor);
  advisorRef.current = advisor;

  // tutor threads are per learning topic; everything else is per advisor
  const threadTopic = advisor === "tutor" ? (topicId ?? null) : null;

  const loadThread = useCallback(async () => {
    const forAdvisor = advisor;
    setLoadingThread(true);
    let q = supabase.from("chat_messages").select("role,content").eq("user_id", game.uid).eq("advisor", advisor)
      .order("created_at", { ascending: false }).limit(40);
    q = threadTopic ? q.eq("topic_id", threadTopic) : q.is("topic_id", null);
    const { data, error: readErr } = await q;
    // a fetch that resolves after Ben switched advisor tabs must NOT paint its
    // history under the new tab (and get shipped as that advisor's context)
    if (advisorRef.current !== forAdvisor) return;
    // a transient read failure isn't "no messages" — keep whatever's on screen
    // rather than blanking a real thread that a later send would then overwrite
    if (readErr) { setLoadingThread(false); return; }
    setMsgs(((data ?? []) as Msg[]).reverse());
    setLoadingThread(false);
    setTimeout(() => scrollRef.current?.scrollTo(0, 1e9), 60);
  }, [game.uid, advisor, threadTopic]);

  useEffect(() => { loadThread(); }, [loadThread]);

  async function persistMsg(role: "user" | "assistant", content: string) {
    // supabase-js resolves DB errors instead of throwing — return it so the
    // caller can decide whether a dropped write is safe to ignore
    const { error } = await supabase.from("chat_messages").insert({ user_id: game.uid, advisor, topic_id: threadTopic, role, content });
    return error;
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const forAdvisor = advisor;
    const prev = msgs;
    setSendErr(false);
    setInput(""); setBusy(true);
    const next = [...msgs, { role: "user" as const, content: text }];
    setMsgs(next);
    setTimeout(() => scrollRef.current?.scrollTo(0, 1e9), 50);

    // persist the user's message BEFORE calling the advisor — a silently
    // dropped insert leaves a thread that only looks persisted, so on failure
    // put the text back in the box, drop the optimistic bubble, and stop
    const perr = await persistMsg("user", text);
    if (perr) {
      setMsgs(prev);
      setInput(text);
      setSendErr(true);
      setBusy(false);
      return;
    }

    try {
      const json = await callAdvisor({ advisor: forAdvisor, message: text, history: prev.slice(-14), topicId });
      const reply = json.text || json.error || "No response.";
      if (json.text) void persistMsg("assistant", json.text);
      // if Ben switched tabs mid-flight, don't paint this thread over the new one
      if (advisorRef.current === forAdvisor) setMsgs([...next, { role: "assistant", content: reply }]);
    } catch {
      if (advisorRef.current === forAdvisor) setMsgs([...next, { role: "assistant", content: "Couldn't reach the Board. Check your connection." }]);
    } finally {
      setBusy(false);
      setTimeout(() => scrollRef.current?.scrollTo(0, 1e9), 50);
    }
  }

  async function clearThread() {
    if (!confirm("Clear this conversation? (What the coach has learned about you stays in 🧠 memory.)")) return;
    setMsgs([]);
    let q = supabase.from("chat_messages").delete().eq("user_id", game.uid).eq("advisor", advisor);
    q = threadTopic ? q.eq("topic_id", threadTopic) : q.is("topic_id", null);
    await q;
  }

  async function openMemories() {
    setMemOpen(true);
    setMemErr("");
    const { data } = await supabase.from("ai_memories").select("*").eq("user_id", game.uid).order("created_at", { ascending: false }).limit(100);
    setMemories((data ?? []) as Memory[]);
  }
  async function deleteMemory(id: string) {
    const removed = memories.find((x) => x.id === id);
    setMemErr("");
    setMemories((m) => m.filter((x) => x.id !== id));
    const { error } = await supabase.from("ai_memories").delete().eq("id", id);
    // a memory that reads as deleted but is still steering every future chat is
    // the exact trust-breaker this viewer exists to prevent — roll it back
    if (error && removed) {
      setMemories((m) => [...m, removed].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));
      setMemErr("Couldn't delete that memory — it's back in the list. Try again.");
    }
  }

  async function buildRecap() {
    if (recapBusy || !topicId) return;
    setRecapBusy(true);
    try {
      const json = await callAdvisor({ advisor: "session-recap", topicId });
      if (json.error) {
        setMsgs((m) => [...m, { role: "assistant", content: `📝 ${json.error}` }]);
      } else {
        setRecap({ chunks: json.chunks ?? [], weak_spots: json.weak_spots ?? [], retrieval: json.retrieval ?? [] });
        setRecapDrop(new Set());
      }
    } finally {
      setRecapBusy(false);
    }
  }

  async function saveRecap() {
    if (!recap || !topicId || recapBusy) return;
    setRecapBusy(true);
    try {
      const keep = <T,>(items: T[], prefix: string) => items.filter((_, i) => !recapDrop.has(`${prefix}${i}`));
      const chunks = keep(recap.chunks, "c");
      const weakSpots = keep(recap.weak_spots, "w");
      const retrieval = keep(recap.retrieval, "r");
      // These tables have no unique constraint, so a blind retry would DUPLICATE
      // every row that already saved. Each write carries a keepOnFail that puts
      // only the un-saved item back into the preview, so retry writes just those.
      const remainingChunks: string[] = [];
      const remainingWeak: string[] = [];
      const remainingRetrieval: Recap["retrieval"] = [];
      const writes: { p: PromiseLike<{ error: unknown }>; keepOnFail: () => void }[] = [];
      if (chunks.length) {
        writes.push({
          p: supabase.from("learning_sessions").insert({
            user_id: game.uid, topic_id: topicId, day: todayStr(),
            chunks: chunks.map((c) => ({ note: c })), brain_dump: "",
          }),
          keepOnFail: () => { remainingChunks.push(...chunks); },
        });
      }
      for (const w of weakSpots) writes.push({
        p: supabase.from("learning_weak_spots").insert({ user_id: game.uid, topic_id: topicId, text: w }),
        keepOnFail: () => { remainingWeak.push(w); },
      });
      for (const r of retrieval) writes.push({
        p: supabase.from("learning_retrieval").insert({ user_id: game.uid, topic_id: topicId, question: r.question, got_it: !!r.got_it }),
        keepOnFail: () => { remainingRetrieval.push(r); },
      });
      // supabase-js resolves errors instead of throwing — celebrating a failed
      // save would be the exact trust-breaker this preview flow exists to avoid
      const results = await Promise.all(writes.map((w) => w.p));
      results.forEach((res, i) => { if (res?.error) writes[i].keepOnFail(); });
      const failed = remainingChunks.length + remainingWeak.length + remainingRetrieval.length;
      if (failed > 0) {
        // rebuild the preview with ONLY what didn't save — the successes are
        // already in the Learning hub and must not be written a second time
        setRecap({ chunks: remainingChunks, weak_spots: remainingWeak, retrieval: remainingRetrieval });
        setRecapDrop(new Set());
        setError(`${failed} item(s) couldn't be saved — the rest are in your Learning hub. Tap Save to retry just these.`);
        return;
      }
      setRecap(null);
      setError("");
      burstConfetti("small");
      sfx.fanfare();
      game.refresh();
      setMsgs((m) => [...m, { role: "assistant", content: "📝 Session saved into your Learning hub — chunks, weak spots, and retrieval log. Sleep locks it in. 😴" }]);
      setTimeout(() => scrollRef.current?.scrollTo(0, 1e9), 50);
    } finally {
      setRecapBusy(false);
    }
  }

  const active = ADVISORS.find((a) => a.key === advisor)!;

  return (
    <div className="fixed inset-0 z-30 bg-[var(--background)] flex flex-col max-w-md mx-auto">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <span className="text-xl">{active.emoji}</span>
        <h1 className="font-bold flex-1">{active.name}</h1>
        {advisor === "tutor" && topicId && (
          <button onClick={buildRecap} disabled={recapBusy}
            className="text-[10px] font-bold px-2.5 py-1.5 rounded-full bg-[var(--neon)]/20 text-[var(--neon)] active:scale-95 disabled:opacity-40">
            {recapBusy ? "…" : "📝 Recap & save"}
          </button>
        )}
        <button onClick={openMemories} className="opacity-60 text-lg px-1 active:scale-90" title="What the coach remembers">🧠</button>
        <button onClick={clearThread} className="opacity-40 text-sm px-1 active:scale-90" title="Clear conversation">🗑</button>
        <button onClick={onClose} className="opacity-60 text-lg px-2 active:scale-90">✕</button>
      </div>

      <div className="flex gap-1 px-3 py-2 overflow-x-auto border-b border-white/10">
        {ADVISORS.map((a) => (
          <button key={a.key} onClick={() => setAdvisor(a.key)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${advisor === a.key ? "bg-[var(--neon)] text-black" : "bg-white/5"}`}>
            {a.emoji} {a.name}
          </button>
        ))}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loadingThread && <div className="space-y-2 mt-4"><div className="skeleton h-8" /><div className="skeleton h-8 w-2/3" /></div>}
        {!loadingThread && msgs.length === 0 && (
          <div className="opacity-50 text-sm mt-6 text-center">
            Ask {active.name} anything. They read your live data + everything they remember about you before answering.<br /><br />
            <span className="text-xs">Try: &ldquo;What should I focus on right now?&rdquo; · &ldquo;Am I slipping this week?&rdquo;</span>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div className={`inline-block rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap text-left ${m.role === "user" ? "bg-[var(--neon)]/20" : "bg-white/5 border border-white/10"}`}>
              {m.content}
            </div>
          </div>
        ))}
        {busy && <div className="opacity-50 text-sm">{active.name} is thinking…</div>}
      </div>

      {sendErr && <p className="px-4 pt-2 text-xs text-orange-400">Couldn&apos;t send — your message is back in the box. Try again.</p>}

      <div className="p-3 border-t border-white/10 flex gap-2" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()} placeholder={voice.listening ? "listening…" : `Ask ${active.name}…`}
          className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
        {voice.supported && (
          <button onClick={voice.toggle}
            className={`w-12 rounded-xl font-bold active:scale-95 ${voice.listening ? "bg-red-500 text-white animate-pulse" : "bg-white/10"}`}>
            🎤
          </button>
        )}
        <button onClick={send} disabled={busy} className="px-5 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-50">↑</button>
      </div>

      {/* 🧠 memory viewer — visible, editable, deletable */}
      {memOpen && (
        <div className="absolute inset-0 z-10 bg-[var(--background)] flex flex-col" style={{ animation: "fadeSlide 0.2s ease" }}>
          <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
            <span className="text-xl">🧠</span>
            <div className="flex-1">
              <h2 className="font-bold">What the coach remembers</h2>
              <p className="text-[10px] opacity-40">extracted automatically after conversations · shared by every advisor · delete anything wrong</p>
            </div>
            <button onClick={() => setMemOpen(false)} className="opacity-60 text-lg px-2 active:scale-90">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
            {memErr && <p className="text-xs text-orange-400">{memErr}</p>}
            {memories.length === 0 && <p className="opacity-40 text-sm text-center mt-8">Nothing yet — memories appear as you talk to the coaches.</p>}
            {memories.map((m) => (
              <div key={m.id} className="flex items-start gap-2 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{m.content}</p>
                  <p className="text-[10px] opacity-40 mt-0.5">{m.category} · {String(m.created_at).slice(0, 10)}</p>
                </div>
                <button onClick={() => deleteMemory(m.id)} className="opacity-40 active:scale-90 px-1">✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 📝 recap preview — review-then-save, never auto-saved */}
      {recap && (
        <div className="absolute inset-0 z-10 bg-black/70 backdrop-blur-sm grid place-items-end" onClick={() => setRecap(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-h-[85%] overflow-y-auto bg-[var(--background)] rounded-t-3xl border-t border-white/10 p-4 pb-8" style={{ animation: "fadeSlide 0.2s ease" }}>
            <p className="font-bold mb-1">📝 Session recap — uncheck anything wrong, then save</p>
            <p className="text-[10px] opacity-40 mb-3">This writes into your Learning hub: chunks → session log, weak spots → loop-back list, retrieval → accuracy tracking.</p>
            {([["c", "🗜️ Chunks", recap.chunks.map(String)], ["w", "⚠️ Weak spots", recap.weak_spots.map(String)], ["r", "🔁 Retrieval", recap.retrieval.map((r) => `${r.got_it ? "✓" : "✗"} ${r.question}`)]] as [string, string, string[]][]).map(([prefix, label, items]) => items.length > 0 && (
              <div key={prefix} className="mb-3">
                <p className="text-xs uppercase tracking-widest opacity-50 mb-1.5">{label}</p>
                <div className="space-y-1.5">
                  {items.map((item, i) => {
                    const k = `${prefix}${i}`;
                    const dropped = recapDrop.has(k);
                    return (
                      <button key={k} onClick={() => setRecapDrop((s) => { const n = new Set(s); if (dropped) n.delete(k); else n.add(k); return n; })}
                        className={`flex items-start gap-2 w-full text-left rounded-lg px-2.5 py-2 border ${dropped ? "opacity-30 border-white/10 line-through" : "border-[var(--neon)]/30 bg-[var(--neon)]/5"}`}>
                        <span className="text-xs mt-0.5">{dropped ? "☐" : "☑"}</span>
                        <span className="text-sm flex-1">{item}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {error && <p className="text-xs text-orange-400 mt-2">{error}</p>}
            <div className="flex gap-2 mt-4">
              <button onClick={() => { setRecap(null); setError(""); }} className="flex-1 rounded-xl bg-white/10 py-3 active:scale-95">Cancel</button>
              <button onClick={saveRecap} disabled={recapBusy} className="flex-1 rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50">
                {recapBusy ? "Saving…" : "Save to Learning"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
