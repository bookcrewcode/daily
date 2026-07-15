"use client";

// 🔒 The NOW screen — Hick's law taken literally: one task, full screen,
// nothing else exists. A shrinking timer supplies the urgency lever safely;
// finishing banks a real focus session (XP + the 💼 win at 50+ min).
// Leaving early is a "step out", never a failure — RSD-safe by design.

import { useEffect, useRef, useState } from "react";
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
  const endAt = useRef(Date.now() + minutes * 60 * 1000);
  const startedAt = useRef(Date.now());
  const banked = useRef(false);

  useEffect(() => {
    if (!running || done) return;
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.round((endAt.current - Date.now()) / 1000));
      setLeft(remaining);
      if (remaining === 0) finish(true);
    }, 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, done]);

  async function finish(timerEnded = false) {
    if (banked.current) return;
    banked.current = true;
    setDone(true);
    setRunning(false);
    const workedMin = Math.max(5, Math.round((Date.now() - startedAt.current) / 60000));
    burstConfetti("big");
    sfx.fanfare();
    buzz([30, 40, 60]);
    const { error } = await supabase.from("focus_sessions").insert({ user_id: game.uid, day: todayStr(), minutes: workedMin });
    if (!error) {
      xpToast(focusXP(workedMin), `${workedMin} min locked in`);
      if (workedMin >= 50) {
        await supabase.from("days").upsert({ user_id: game.uid, day: todayStr(), ws_work: true }, { onConflict: "user_id,day" });
      }
      game.refresh();
    }
    void timerEnded;
  }

  function addFive() {
    endAt.current += 5 * 60 * 1000;
    setTotal((t) => t + 5 * 60);
    setLeft(Math.max(0, Math.round((endAt.current - Date.now()) / 1000)));
    sfx.pop();
  }

  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  const pct = total ? left / total : 0;

  return (
    <div className="fixed inset-0 z-50 bg-[var(--background)] flex flex-col items-center justify-center px-8 text-center">
      {!done ? (
        <>
          <p className="text-[10px] uppercase tracking-[0.3em] opacity-40 mb-6">nothing else exists</p>
          <h1 className="text-3xl font-black leading-tight mb-3">{task}</h1>
          {starter && <p className="text-sm text-[var(--neon)] mb-6">▶ {starter}</p>}

          {/* shrinking bar — time made physical */}
          <div className="w-full max-w-xs h-3 rounded-full bg-white/10 overflow-hidden mb-3">
            <div className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${pct * 100}%`, background: "linear-gradient(90deg,#34d399,#2dd4bf)" }} />
          </div>
          <p className="text-6xl font-extrabold tabular-nums tracking-tight mb-10">{mm}:{ss}</p>

          <div className="flex flex-col gap-3 w-full max-w-xs">
            <button onClick={() => finish()} className="rounded-2xl bg-[var(--neon)] text-black font-bold py-4 text-lg glow-neon active:scale-95">
              ✓ Done — bank it
            </button>
            <div className="flex gap-2">
              {running ? (
                <button onClick={() => setRunning(false)} className="flex-1 rounded-xl bg-white/10 py-3 font-semibold active:scale-95">Pause</button>
              ) : (
                <button onClick={() => { endAt.current = Date.now() + left * 1000; setRunning(true); }} className="flex-1 rounded-xl bg-white/10 py-3 font-semibold active:scale-95">Resume</button>
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
    </div>
  );
}
