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

const EXPORT_TABLES = [
  "days", "meals", "lift_sets", "nights", "goals", "assets", "subscriptions",
  "vocab", "user_achievements", "quest_claims", "focus_sessions",
  "net_worth_snapshots", "gig_shifts", "affirmations", "learning_topics",
  "learning_sessions", "learning_retrieval", "learning_weak_spots",
  "claimed_rewards", "user_settings", "captures", "weekly_plans", "ai_memories", "chat_messages",
  "engine_rows", "engine_reps", "goal_steps", "meal_favorites", "workout_templates", "countdowns",
];

// ── Soundscape — brown/pink noise straight from WebAudio, loops forever ──
// ADHD focus staple: steady broadband noise masks the distracting spikes.
function makeNoiseBuffer(ctx: AudioContext, kind: "brown" | "pink"): AudioBuffer {
  const len = ctx.sampleRate * 5;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  if (kind === "brown") {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
  } else {
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.18;
    }
  }
  return buf;
}

function Soundscape() {
  const [playing, setPlaying] = useState<"" | "brown" | "pink">("");
  const [volume, setVolume] = useState(0.5);
  const ctxRef = useRef<AudioContext | null>(null);
  const srcRef = useRef<AudioBufferSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  const stop = useCallback(() => {
    try { srcRef.current?.stop(); } catch { /* already stopped */ }
    srcRef.current = null;
    setPlaying("");
  }, []);

  function play(kind: "brown" | "pink") {
    if (playing === kind) { stop(); return; }
    try { srcRef.current?.stop(); } catch { /* switching */ }
    const ctx = ctxRef.current ?? new AudioContext();
    ctxRef.current = ctx;
    if (ctx.state === "suspended") ctx.resume();
    const gain = gainRef.current ?? ctx.createGain();
    if (!gainRef.current) { gain.connect(ctx.destination); gainRef.current = gain; }
    gain.gain.value = volume * 0.4;
    const src = ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(ctx, kind);
    src.loop = true;
    src.connect(gain);
    src.start();
    srcRef.current = src;
    setPlaying(kind);
  }

  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = volume * 0.4;
  }, [volume]);
  // stop cleanly when the tab unmounts — no ghost noise
  useEffect(() => () => { try { srcRef.current?.stop(); } catch { /* fine */ } ctxRef.current?.close(); }, []);

  return (
    <Card tone={playing ? "neon" : "default"}>
      <div className="flex gap-2">
        <button onClick={() => play("brown")}
          className={`flex-1 rounded-xl py-3 font-semibold text-sm active:scale-95 ${playing === "brown" ? "bg-[var(--neon)] text-black" : "bg-white/5"}`}>
          🟤 Brown noise {playing === "brown" ? "· on" : ""}
        </button>
        <button onClick={() => play("pink")}
          className={`flex-1 rounded-xl py-3 font-semibold text-sm active:scale-95 ${playing === "pink" ? "bg-[var(--neon)] text-black" : "bg-white/5"}`}>
          🌸 Pink noise {playing === "pink" ? "· on" : ""}
        </button>
      </div>
      <div className="flex items-center gap-3 mt-3">
        <span className="text-xs opacity-50">vol</span>
        <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))}
          className="flex-1 accent-[var(--neon)]" />
      </div>
      <p className="text-[10px] opacity-40 mt-2">Generated on-device, loops forever, zero data. Pair it with a focus block.</p>
    </Card>
  );
}

// ── Decision wheel — for the "I can't pick so I pick nothing" spiral ──
function DecisionWheel() {
  const [optsText, setOptsText] = useState("");
  const [spinning, setSpinning] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [winner, setWinner] = useState<string | null>(null);

  const opts = optsText.split("\n").map((s) => s.trim()).filter(Boolean);

  function spin() {
    if (opts.length < 2 || spinning) return;
    setSpinning(true); setWinner(null);
    const target = Math.floor(Math.random() * opts.length);
    // ease-out: fast cycling that slows into the pick — the anticipation IS the fun
    let i = 0;
    const totalSteps = opts.length * 3 + target + 1;
    const tick = (step: number) => {
      setHighlight(i % opts.length);
      i++;
      if (step >= totalSteps) {
        setSpinning(false);
        setWinner(opts[target]);
        setHighlight(target);
        sfx.coin();
        return;
      }
      setTimeout(() => tick(step + 1), 40 + Math.pow(step / totalSteps, 2) * 260);
    };
    tick(0);
  }

  return (
    <Card>
      <textarea value={optsText} onChange={(e) => { setOptsText(e.target.value); setWinner(null); setHighlight(-1); }}
        rows={3} placeholder={"one option per line…\ngym now\ngym after dinner"}
        className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none resize-none text-sm" />
      {opts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {opts.map((o, i) => (
            <span key={i} className={`text-xs px-3 py-1.5 rounded-full border transition ${i === highlight ? "bg-[var(--neon)] text-black border-[var(--neon)] font-bold" : "bg-white/5 border-white/10"}`}>
              {o}
            </span>
          ))}
        </div>
      )}
      <button onClick={spin} disabled={opts.length < 2 || spinning}
        className="mt-3 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-40">
        {spinning ? "…" : winner ? `→ ${winner} — go.` : "🎡 Decide for me"}
      </button>
      <p className="text-[10px] opacity-40 mt-2">Deciding costs more dopamine than doing. Outsource the pick, keep the action.</p>
    </Card>
  );
}

// ── Countdowns — deadlines you can SEE get closer (now/not-now needs a number) ──
type Countdown = { id: string; emoji: string; name: string; date: string };

function Countdowns() {
  const game = useGame();
  const [items, setItems] = useState<Countdown[]>([]);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("countdowns").select("id,emoji,name,date").eq("user_id", game.uid).order("date");
    setItems((data ?? []) as Countdown[]);
  }, [game.uid]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!name.trim() || !date) return;
    const { data, error } = await supabase.from("countdowns")
      .insert({ user_id: game.uid, name: name.trim(), date })
      .select("id,emoji,name,date").single();
    if (error || !data) return;
    setItems((x) => [...x, data as Countdown].sort((a, b) => a.date.localeCompare(b.date)));
    setName(""); setDate(""); setAdding(false);
  }
  async function remove(id: string) {
    const { error } = await supabase.from("countdowns").delete().eq("id", id);
    if (!error) setItems((x) => x.filter((c) => c.id !== id));
  }

  const now = new Date(todayStr() + "T00:00:00").getTime();

  return (
    <Card>
      {items.length === 0 && !adding && <p className="text-sm opacity-40">Nothing counting down. Exams, trips, deadlines — future-you sees them coming.</p>}
      <div className="space-y-2">
        {items.map((c) => {
          const days = Math.round((new Date(c.date + "T00:00:00").getTime() - now) / 86400000);
          const urgent = days >= 0 && days <= 7;
          return (
            <div key={c.id} className="flex items-center gap-3">
              <span className="text-xl">{c.emoji}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{c.name}</p>
                <p className="text-[10px] opacity-40">{new Date(c.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</p>
              </div>
              <span className={`font-display font-extrabold tabular-nums ${days < 0 ? "opacity-40 line-through" : urgent ? "text-orange-400 text-lg" : "text-[var(--neon)]"}`}>
                {days < 0 ? "past" : days === 0 ? "TODAY" : `${days}d`}
              </span>
              <button onClick={() => remove(c.id)} className="opacity-30 text-xs active:scale-90">✕</button>
            </div>
          );
        })}
      </div>
      {adding ? (
        <div className="flex gap-2 mt-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="what's coming?"
            className="flex-1 min-w-0 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="w-32 rounded-xl bg-black/30 px-2 py-2.5 outline-none text-sm" />
          <button onClick={add} className="px-3 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">✓</button>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="mt-3 w-full rounded-xl border border-dashed border-white/20 py-2.5 text-sm opacity-70 active:scale-95">+ Add a countdown</button>
      )}
    </Card>
  );
}

export default function Tools() {
  const game = useGame();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ title: string; text: string } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [sound, setSound] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { setSound(soundOn()); }, []);

  // Your data is YOURS — one tap dumps every table to a JSON file.
  async function exportAll() {
    if (exporting) return;
    setExporting(true);
    try {
      const dump: Record<string, unknown> = { exported_at: new Date().toISOString(), app: "daily" };
      await Promise.all(EXPORT_TABLES.map(async (t) => {
        const { data } = await supabase.from(t).select("*").eq("user_id", game.uid);
        dump[t] = data ?? [];
      }));
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `daily-export-${todayStr()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      sfx.coin();
    } finally {
      setExporting(false);
    }
  }

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

      <SectionTitle>🎧 Soundscape</SectionTitle>
      <Soundscape />

      <SectionTitle>⏳ Countdowns</SectionTitle>
      <Countdowns />

      <SectionTitle>🎡 Decision wheel</SectionTitle>
      <DecisionWheel />

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

      <SectionTitle>💾 Your data</SectionTitle>
      <Card padded={false} className="p-3">
        <button onClick={exportAll} disabled={exporting} className="flex items-center gap-3 w-full text-left disabled:opacity-50">
          <span className="text-xl">📦</span>
          <span className="flex-1">
            <span className="block text-sm font-medium">{exporting ? "Exporting…" : "Export everything as JSON"}</span>
            <span className="block text-[10px] opacity-40">every habit, meal, lift, quest, and dollar — yours to keep</span>
          </span>
        </button>
      </Card>

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
