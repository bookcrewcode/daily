"use client";

import { useRef, useState } from "react";
import { supabase, ADVISOR_FN, SUPABASE_ANON } from "@/lib/supabase";

type Msg = { role: "user" | "assistant"; content: string };

const ADVISORS = [
  { key: "board", emoji: "🏛️", name: "The Board" },
  { key: "hormozi", emoji: "🔨", name: "Hormozi" },
  { key: "rubin", emoji: "🎛️", name: "Rubin" },
  { key: "naval", emoji: "🧭", name: "Naval" },
  { key: "overseer", emoji: "👁️", name: "Overseer" },
];

export default function Board({ onClose, initialAdvisor }: { onClose: () => void; initialAdvisor?: string }) {
  const [advisor, setAdvisor] = useState(initialAdvisor ?? "overseer");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput(""); setBusy(true);
    const next = [...msgs, { role: "user" as const, content: text }];
    setMsgs(next);
    setTimeout(() => scrollRef.current?.scrollTo(0, 1e9), 50);

    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(ADVISOR_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ advisor, message: text, history: msgs.slice(-8) }),
      });
      const json = await res.json();
      setMsgs([...next, { role: "assistant", content: json.text || json.error || "No response." }]);
    } catch {
      setMsgs([...next, { role: "assistant", content: "Couldn't reach the Board. Check your connection." }]);
    } finally {
      setBusy(false);
      setTimeout(() => scrollRef.current?.scrollTo(0, 1e9), 50);
    }
  }

  const active = ADVISORS.find((a) => a.key === advisor)!;

  return (
    <div className="fixed inset-0 z-30 bg-[var(--background)] flex flex-col max-w-md mx-auto">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <span className="text-xl">{active.emoji}</span>
        <h1 className="font-bold flex-1">{active.name}</h1>
        <button onClick={onClose} className="opacity-60 text-lg px-2">✕</button>
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
        {msgs.length === 0 && (
          <div className="opacity-50 text-sm mt-6 text-center">
            Ask {active.name} anything. They read your live data before answering.<br /><br />
            <span className="text-xs">Try: &ldquo;Should I raise BookCrew&apos;s price?&rdquo; · &ldquo;Am I slipping this week?&rdquo;</span>
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

      <div className="p-3 border-t border-white/10 flex gap-2" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        <input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()} placeholder={`Ask ${active.name}…`}
          className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
        <button onClick={send} disabled={busy} className="px-5 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-50">↑</button>
      </div>
    </div>
  );
}
