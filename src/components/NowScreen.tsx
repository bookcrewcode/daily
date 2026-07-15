"use client";

// 🔒 The NOW screen — Hick's law taken literally: one task, full screen,
// nothing else exists. A shrinking timer supplies the urgency lever safely;
// finishing banks a real focus session (XP + the 💼 win at 50+ min).
// Leaving early is a "step out", never a failure — RSD-safe by design.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase, todayStr } from "@/lib/supabase";
import { focusXP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { xpToast, sfx, buzz } from "@/lib/fx";

export default function NowScreen({ task, starter, minutes = 25, onClose }: {
  task: string;
  starter?: string;
  minutes?: number;
  onClose: () => void;
}) {
  const game = useGame();
  const [left, setLeft] = useState(minutes * 60);
  const [total, setTotal] = useState(minutes * 60);
  const [running, setRunning] = useState(true);
  const [done, setDone] = useState(false);
  const [bankError, setBankError] = useState(false);
  const [saving, setSaving] = useState(false);
  const endAt = useRef(Date.now() + minutes * 60 * 1000);
  // honest minutes: only time spent RUNNING counts — pauses and a phone
  // locked in a drawer must not bank as focus (or falsely flip the 💼 win)
  const activeMs = useRef(0);
  const lastResume = useRef(Date.now());
  const banked = useRef(false);

  useEffect(() => {
    if (!running || done) return;
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.round((endAt.current - Date.now()) / 1000));
      setLeft(remaining);
      if (remaining === 0) finish();
    }, 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, done]);

  function pause() {
    activeMs.current += Date.now() - lastResume.current;
    setRunning(false);
  }
  function resume() {
    lastResume.current = Date.now();
    endAt.current = Date.now() + left * 1000;
    setRunning(true);
  }

  async function finish() {
    if (banked.current || saving) return;
    setSaving(true);
    const runningNow = running;
    if (runningNow) activeMs.current += Date.now() - lastResume.current;
    setRunning(false);
    // capped at the timer's length: a session abandoned with the phone locked
    // banks at most what the timer was set to, never hours of wall clock
    const workedMin = Math.min(Math.max(5, Math.round(activeMs.current / 60000)), Math.ceil(total / 60));

    // write FIRST, celebrate second — "Banked." must be literally true
    const { error } = await supabase.from("focus_sessions").insert({ user_id: game.uid, day: todayStr(), minutes: workedMin });
    setSaving(false);
    if (error) {
      setBankError(true);
      if (runningNow) lastResume.current = Date.now(); // keep the clock honest for retry
      setRunning(runningNow);
      return;
    }
    banked.current = true;
    setBankError(false);
    setDone(true);
    burstConfetti("big");
    sfx.fanfare();
    buzz([30, 40, 60]);
    xpToast(focusXP(workedMin), `${workedMin} min locked in`);
    if (workedMin >= 50) {
      await supabase.from("days").upsert({ user_id: game.uid, day: todayStr(), ws_work: true }, { onConflict: "user_id,day" });
    }
    game.refresh();
  }

  function addFive() {
    setTotal((t) => t + 5 * 60);
    if (running) {
      endAt.current += 5 * 60 * 1000;
      setLeft(Math.max(0, Math.round((endAt.current - Date.now()) / 1000)));
    } else {
      setLeft((l) => l + 5 * 60); // paused: adjust the frozen clock, not the stale deadline
    }
    sfx.pop();
  }

  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  const pct = total ? left / total : 0;

  // portal to <body>: ancestors with backdrop-filter (every Card) become the
  // containing block for fixed children, which would trap "fullscreen" inside
  // the card that launched it
  return createPortal(
    <div className="fixed inset-0 z-50 bg-[var(--background)] flex flex-col items-center justify-center px-8 text-center">
      {!done ? (
        <>
          <p className="text-[10px] uppercase tracking-[0.3em] opacity-40 mb-6">nothing else exists</p>
          <h1 className="text-3xl font-black leading-tight mb-3">{task}</h1>
          {starter && <p className="text-sm text-[var(--neon)] mb-6">▶ {starter}</p>}

          {/* shrinking bar — time made physical */}
          <div className="w-full max-w-xs h-3 rounded-full bg-white/10 overflow-hidden mb-3">
            <div className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${pct * 100}%`, background: "linear-gradient(90deg,#a78bfa,#818cf8)" }} />
          </div>
          <p className="text-6xl font-extrabold tabular-nums tracking-tight mb-10">{mm}:{ss}</p>

          <div className="flex flex-col gap-3 w-full max-w-xs">
            <button onClick={() => finish()} disabled={saving} className="rounded-2xl bg-[var(--neon)] text-black font-bold py-4 text-lg glow-neon active:scale-95 disabled:opacity-60">
              {saving ? "Banking…" : "✓ Done — bank it"}
            </button>
            {bankError && <p className="text-xs text-orange-400">Couldn&apos;t save the session — nothing lost. Check connection and tap again.</p>}
            <div className="flex gap-2">
              {running ? (
                <button onClick={pause} className="flex-1 rounded-xl bg-white/10 py-3 font-semibold active:scale-95">Pause</button>
              ) : (
                <button onClick={resume} className="flex-1 rounded-xl bg-white/10 py-3 font-semibold active:scale-95">Resume</button>
              )}
              <button onClick={addFive} className="flex-1 rounded-xl bg-white/10 py-3 font-semibold active:scale-95">+5 min</button>
            </div>
            <button onClick={onClose} className="text-xs opacity-40 underline mt-2">step out — no penalty, it&apos;ll be here</button>
          </div>
        </>
      ) : (
        <div style={{ animation: "levelPop 0.5s ease" }}>
          <p className="text-6xl mb-4">🔓</p>
          <h1 className="text-2xl font-black mb-2">Locked in. Banked.</h1>
          <p className="text-sm opacity-60 mb-8">That&apos;s a vote for someone who executes.</p>
          <button onClick={onClose} className="px-8 py-3 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95">Back to the day</button>
        </div>
      )}
    </div>,
    document.body,
  );
}
