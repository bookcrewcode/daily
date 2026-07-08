"use client";

import { useEffect, useRef, useState } from "react";
import { supabase, SUPABASE_URL, SUPABASE_ANON } from "@/lib/supabase";
import { SectionTitle, Card } from "./ui";
import { burstConfetti } from "@/lib/confetti";

const TRANSCRIPT_FN = `${SUPABASE_URL}/functions/v1/transcript`;

// ── Focus timer — ultradian blocks, pairs with the Learning tab ──────
const PRESETS = [25, 50, 90];

function FocusTimer() {
  const [total, setTotal] = useState(50 * 60);
  const [left, setLeft] = useState(50 * 60);
  const [running, setRunning] = useState(false);
  const endAt = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.round(((endAt.current ?? 0) - Date.now()) / 1000));
      setLeft(remaining);
      if (remaining === 0) {
        setRunning(false);
        burstConfetti("big");
        document.title = "⏰ Focus block done!";
        setTimeout(() => (document.title = "Daily"), 5000);
      }
    }, 500);
    return () => clearInterval(id);
  }, [running]);

  function start() {
    endAt.current = Date.now() + left * 1000;
    setRunning(true);
  }
  function reset(mins?: number) {
    const secs = (mins ?? total / 60) * 60;
    setRunning(false);
    setTotal(secs);
    setLeft(secs);
  }

  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  const pct = total ? 1 - left / total : 0;

  return (
    <Card tone={running ? "neon" : "default"}>
      <div className="flex gap-2 mb-3">
        {PRESETS.map((p) => (
          <button key={p} onClick={() => reset(p)}
            className={`flex-1 rounded-xl py-2 text-sm font-semibold active:scale-95 ${total === p * 60 ? "bg-[var(--neon)] text-black" : "bg-white/5"}`}>
            {p}m
          </button>
        ))}
      </div>
      <p className="text-center text-5xl font-extrabold tabular-nums tracking-tight my-2">{mm}:{ss}</p>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden mb-3">
        <div className="h-full rounded-full bg-[var(--neon)] transition-[width] duration-500" style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="flex gap-2">
        {running ? (
          <button onClick={() => setRunning(false)} className="flex-1 rounded-xl bg-white/10 font-bold py-3 active:scale-95">Pause</button>
        ) : (
          <button onClick={start} disabled={left === 0} className="flex-1 rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-40">
            {left === total ? "Start focus block" : "Resume"}
          </button>
        )}
        <button onClick={() => reset()} className="px-5 rounded-xl bg-white/10 font-bold active:scale-95">↺</button>
      </div>
      <p className="text-[10px] opacity-40 mt-2">90 min = one ultradian cycle. Then take a real 20-min break — that&apos;s where it consolidates.</p>
    </Card>
  );
}

export default function Tools() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ title: string; text: string } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function getTranscript() {
    if (!url.trim() || busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(TRANSCRIPT_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: url.trim() }),
      });
      const json = await res.json();
      if (json.error) setError(json.error);
      else setResult(json);
    } catch {
      setError("Couldn't reach the transcript service.");
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!result) return;
    navigator.clipboard.writeText(result.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">🛠️ Tools</h1>
      <p className="opacity-50 text-sm mt-1">Utilities that don&apos;t need their own app.</p>

      <SectionTitle>⏱️ Focus timer</SectionTitle>
      <FocusTimer />

      <SectionTitle>📺 YouTube transcript</SectionTitle>
      <p className="text-xs opacity-40 mb-2">Free, no login needed — pulls the video&apos;s own caption track.</p>
      <div className="flex gap-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && getTranscript()}
          placeholder="paste a YouTube link"
          className="flex-1 rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
        <button onClick={getTranscript} disabled={busy} className="px-5 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-50">
          {busy ? "…" : "Get"}
        </button>
      </div>

      {error && <Card tone="warn" className="mt-3"><p className="text-sm">{error}</p></Card>}

      {result && (
        <Card className="mt-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="font-bold text-sm flex-1">{result.title}</p>
            <button onClick={copy} className="text-xs font-semibold px-3 py-1.5 rounded-full bg-[var(--neon)]/20 text-[var(--neon)] shrink-0 active:scale-95">
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <p className="text-sm opacity-70 whitespace-pre-wrap max-h-80 overflow-y-auto leading-relaxed">{result.text}</p>
        </Card>
      )}

      <SectionTitle>📸 Instagram transcript</SectionTitle>
      <Card className="opacity-70">
        <p className="text-sm">
          No free, reliable option exists for this one — Instagram doesn&apos;t expose captions like YouTube does. Every real option
          (even the open-source ones) has to download the reel and pay for Whisper/AssemblyAI transcription per minute, and scrapers
          break constantly against Instagram&apos;s terms.
        </p>
        <p className="text-xs opacity-50 mt-2">Want it anyway? Say so and I&apos;ll wire a paid-API version (few cents per reel) — just didn&apos;t want to ship something flaky.</p>
      </Card>
    </div>
  );
}
