"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr, SUPABASE_URL, SUPABASE_ANON } from "@/lib/supabase";
import { focusXP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { xpToast, sfx, soundOn, setSoundOn } from "@/lib/fx";
import { SectionTitle, Card } from "./ui";

const TRANSCRIPT_FN = `${SUPABASE_URL}/functions/v1/transcript`;

// ── Focus timer — ultradian blocks that BANK: session row + XP + ws_work ──
const PRESETS = [25, 50, 90];

function FocusTimer() {
  const game = useGame();
  const [total, setTotal] = useState(50 * 60);
  const [left, setLeft] = useState(50 * 60);
  const [running, setRunning] = useState(false);
  const [todayStats, setTodayStats] = useState({ blocks: 0, minutes: 0 });
  const endAt = useRef<number | null>(null);

  const loadToday = useCallback(async () => {
    const { data } = await supabase.from("focus_sessions").select("minutes").eq("user_id", game.uid).eq("day", todayStr());
    const mins = (data ?? []).reduce((s, r) => s + r.minutes, 0);
    setTodayStats({ blocks: (data ?? []).length, minutes: mins });
  }, [game.uid]);
  useEffect(() => { loadToday(); }, [loadToday]);

  const complete = useCallback(async () => {
    const minutes = Math.round(total / 60);
    burstConfetti("big");
    sfx.fanfare();
    document.title = "⏰ Focus block done!";
    setTimeout(() => (document.title = "Daily"), 5000);

    const { error } = await supabase.from("focus_sessions").insert({ user_id: game.uid, day: todayStr(), minutes });
    if (!error) {
      xpToast(focusXP(minutes), `${minutes}-min block`);
      if (minutes >= 50) {
        await supabase.from("days").upsert({ user_id: game.uid, day: todayStr(), ws_work: true }, { onConflict: "user_id,day" });
      }
      loadToday();
      game.refresh();
    }
  }, [total, game, loadToday]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.round(((endAt.current ?? 0) - Date.now()) / 1000));
      setLeft(remaining);
      if (remaining === 0) {
        setRunning(false);
        complete();
      }
    }, 500);
    return () => clearInterval(id);
  }, [running, complete]);

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
            {p}m <span className="opacity-60 text-[10px]">+{focusXP(p)}xp</span>
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
      <p className="text-[10px] opacity-40 mt-2">
        {todayStats.blocks > 0
          ? <>Today: <span className="text-[var(--neon)] opacity-100 font-bold">{todayStats.blocks} block{todayStats.blocks > 1 ? "s" : ""} · {todayStats.minutes} min</span> · 50+ min banks the 💼 win</>
          : <>Finished blocks bank XP and count toward achievements. 50+ min auto-banks the 💼 work win.</>}
      </p>
    </Card>
  );
}

// ── Box breathing — 4-4-4-4, for the Consolidate step / general downshift ──
const PHASES = [
  { label: "Breathe in", scale: 1 },
  { label: "Hold", scale: 1 },
  { label: "Breathe out", scale: 0.55 },
  { label: "Hold", scale: 0.55 },
];

function Breathing() {
  const [on, setOn] = useState(false);
  const [phase, setPhase] = useState(0);
  const [cycles, setCycles] = useState(0);

  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => {
      setPhase((p) => {
        const next = (p + 1) % 4;
        if (next === 0) setCycles((c) => c + 1);
        return next;
      });
    }, 4000);
    return () => clearInterval(id);
  }, [on]);

  function toggle() {
    if (on) { setOn(false); setPhase(0); setCycles(0); }
    else { setOn(true); setPhase(0); }
  }

  return (
    <Card>
      <div className="flex items-center gap-4">
        <div className="relative w-24 h-24 shrink-0 grid place-items-center">
          <div className="absolute inset-0 rounded-full bg-[var(--neon)]/10 border border-[var(--neon)]/30"
            style={{ transform: `scale(${on ? PHASES[phase].scale : 0.75})`, transition: "transform 3.8s ease-in-out" }} />
          <span className="text-2xl relative">🫁</span>
        </div>
        <div className="flex-1">
          <p className="font-bold">{on ? PHASES[phase].label : "Box breathing"}</p>
          <p className="text-xs opacity-50 mt-0.5">
            {on ? `4s each side · ${cycles} cycle${cycles === 1 ? "" : "s"}` : "4-4-4-4 — the fastest legal downshift for your nervous system."}
          </p>
          <button onClick={toggle} className={`mt-2 px-4 py-2 rounded-xl text-sm font-bold active:scale-95 ${on ? "bg-white/10" : "bg-[var(--neon)] text-black"}`}>
            {on ? "Stop" : "Start"}
          </button>
        </div>
      </div>
    </Card>
  );
}

export default function Tools() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ title: string; text: string } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [sound, setSound] = useState(true);

  useEffect(() => { setSound(soundOn()); }, []);

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

      <SectionTitle>🫁 Breathe</SectionTitle>
      <Breathing />

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

      <SectionTitle>⚙️ Settings</SectionTitle>
      <Card padded={false} className="p-3">
        <button onClick={() => { const next = !sound; setSound(next); setSoundOn(next); if (next) sfx.coin(); }}
          className="flex items-center gap-3 w-full text-left">
          <span className="text-xl">{sound ? "🔊" : "🔇"}</span>
          <span className="flex-1 text-sm font-medium">Sound effects</span>
          <span className={`w-11 h-6 rounded-full p-0.5 transition ${sound ? "bg-[var(--neon)]" : "bg-white/15"}`}>
            <span className={`block w-5 h-5 rounded-full bg-white transition ${sound ? "translate-x-5" : ""}`} />
          </span>
        </button>
      </Card>
    </div>
  );
}
