"use client";

// 📆 Monthly review — the month-scale layer of the assistant. Appears only
// in the closing days of a month (or the first days of the next), shows the
// month's actual numbers, asks exactly 3 questions, banks +60 XP once.

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import { useGame } from "@/lib/useGameData";
import { scoreOf, WIN_TOTAL } from "@/lib/gamification";
import { burstConfetti } from "@/lib/confetti";
import { xpToast, sfx } from "@/lib/fx";
import { Card } from "./ui";

const MONTH_REVIEW_XP = 60;

// last 3 days of a month → review THAT month; first 5 days → review the previous one
function targetMonth(): string | null {
  const now = new Date(todayStr() + "T00:00:00");
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (now.getDate() >= daysInMonth - 2) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  if (now.getDate() <= 5) {
    const p = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, "0")}`;
  }
  return null;
}

type Stats = { fullWins: number; trackedDays: number; avgWins: number; reps: number; focusMin: number; netDelta: number | null };

export default function MonthlyReview({ uid }: { uid: string }) {
  const game = useGame();
  const [month, setMonth] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [answers, setAnswers] = useState({ proud: "", stall: "", change: "" });
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    const m = targetMonth();
    if (!m) { setMonth(null); return; }
    const { data: existing } = await supabase.from("monthly_reviews").select("id").eq("user_id", uid).eq("month", m).maybeSingle();
    if (existing) { setMonth(null); return; }

    const from = `${m}-01`;
    const to = `${m}-31`;
    const [{ data: reps }, { data: focus }] = await Promise.all([
      supabase.from("engine_reps").select("day").eq("user_id", uid).gte("day", from).lte("day", to),
      supabase.from("focus_sessions").select("minutes").eq("user_id", uid).gte("day", from).lte("day", to),
    ]);
    const monthDays = game.days.filter((d) => d.day.startsWith(m));
    const scores = monthDays.map((d) => scoreOf(d));
    const nw = game.netWorthHistory.filter((r) => r.day.startsWith(m));
    setStats({
      fullWins: scores.filter((s) => s === WIN_TOTAL).length,
      trackedDays: monthDays.length,
      avgWins: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0,
      reps: (reps ?? []).length,
      focusMin: (focus ?? []).reduce((s, r) => s + r.minutes, 0),
      netDelta: nw.length >= 2 ? nw[nw.length - 1].value - nw[0].value : null,
    });
    setMonth(m);
  }, [uid, game.days, game.netWorthHistory]);
  useEffect(() => { load(); }, [load]);

  async function submit() {
    if (!month || !stats) return;
    setNote("");
    const { error } = await supabase.from("monthly_reviews").insert({ user_id: uid, month, answers, stats });
    if (error) {
      setNote("Couldn't save — your answers are still here. Try again.");
      return; // unique(user_id,month) also makes an accidental double-tap harmless
    }
    await game.bankQuestXP(`month_${month}`, MONTH_REVIEW_XP);
    burstConfetti("big");
    sfx.fanfare();
    xpToast(MONTH_REVIEW_XP, "month closed");
    setDone(true);
    game.refresh();
  }

  if (done) {
    return (
      <Card tone="neon" className="mt-3">
        <p className="text-sm font-bold">📆 Month closed. ✓</p>
        <p className="text-xs opacity-60 mt-1">Every rep in it is banked. New month, same identity — one vote at a time.</p>
      </Card>
    );
  }
  if (!month || !stats) return null;

  const pretty = new Date(month + "-01T00:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <Card tone="warn" className="mt-3">
      {!open ? (
        <div className="flex items-center gap-3">
          <span className="text-2xl">📆</span>
          <div className="flex-1">
            <p className="text-sm font-bold">Close out {pretty}</p>
            <p className="text-[10px] opacity-50">the month in numbers + 3 questions · +{MONTH_REVIEW_XP} XP</p>
          </div>
          <button onClick={() => setOpen(true)} className="px-4 py-2 rounded-xl bg-[var(--neon)] text-black text-sm font-bold active:scale-95">Start</button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-widest opacity-50">📆 {pretty} — the scoreboard</p>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-black/30 py-2">
              <p className="font-display font-extrabold text-lg text-[var(--neon)]">{stats.fullWins}</p>
              <p className="text-[9px] uppercase tracking-wider opacity-50">full-win days</p>
            </div>
            <div className="rounded-xl bg-black/30 py-2">
              <p className="font-display font-extrabold text-lg text-[var(--neon)]">{stats.reps}</p>
              <p className="text-[9px] uppercase tracking-wider opacity-50">votes cast</p>
            </div>
            <div className="rounded-xl bg-black/30 py-2">
              <p className="font-display font-extrabold text-lg text-[var(--neon)]">{stats.focusMin}</p>
              <p className="text-[9px] uppercase tracking-wider opacity-50">focus min</p>
            </div>
          </div>
          <p className="text-[10px] opacity-50">
            {stats.trackedDays} days tracked · avg {stats.avgWins}/11 wins
            {stats.netDelta != null && <> · net worth {stats.netDelta >= 0 ? "+" : "−"}${Math.abs(stats.netDelta).toLocaleString()}</>}
          </p>
          <p className="text-xs font-bold pt-1">1 · What are you proudest of this month?</p>
          <input value={answers.proud} onChange={(e) => setAnswers({ ...answers, proud: e.target.value })}
            className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" placeholder="one real thing" />
          <p className="text-xs font-bold">2 · What consistently didn&apos;t work?</p>
          <input value={answers.stall} onChange={(e) => setAnswers({ ...answers, stall: e.target.value })}
            className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" placeholder="pattern, not a bad day" />
          <p className="text-xs font-bold">3 · The ONE change for next month?</p>
          <input value={answers.change} onChange={(e) => setAnswers({ ...answers, change: e.target.value })}
            className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" placeholder="small enough to actually happen" />
          <button onClick={submit} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">Close the month · +{MONTH_REVIEW_XP} XP</button>
          {note && <p className="text-xs text-orange-400">{note}</p>}
        </div>
      )}
    </Card>
  );
}
