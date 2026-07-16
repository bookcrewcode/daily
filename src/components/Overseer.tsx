"use client";

// The Overseer strip — one message, picked for the moment. Research-tuned:
// morning = gain-framing + yesterday's intention (implementation intentions
// have real ADHD evidence); evening = the streak/loss frame lives in the
// UrgencyCard, so here we stay on patterns and momentum. Never leads with
// failure — RSD-safe by design.

import { useEffect, useState } from "react";
import { supabase, WIN_KEYS, todayStr, dateStr } from "@/lib/supabase";
import { useGame } from "@/lib/useGameData";

const LABEL: Record<string, string> = {
  ws_meds: "Meds", ws_water: "Water", ws_eat: "Clean eating", ws_lift: "Lifts",
  ws_stretch: "Stretching", ws_sleep: "Sleep", ws_vocab: "Vocab", ws_chinese: "Chinese",
  ws_school: "School", ws_affirmations: "Affirmations", ws_work: "BookCrew / work",
};

export default function Overseer({ uid, onOpenChat }: { uid: string; onOpenChat?: (advisor: string) => void }) {
  const game = useGame();
  const [msg, setMsg] = useState<{ head: string; body: string; tone: "warn" | "good" } | null>(null);

  useEffect(() => {
    (async () => {
      const since = new Date(); since.setDate(since.getDate() - 6);
      const [{ data, error }, { data: todayPlan }] = await Promise.all([
        supabase.from("days").select("*").eq("user_id", uid).gte("day", dateStr(since)),
        supabase.from("nights").select("top3").eq("user_id", uid).eq("day", todayStr()).maybeSingle(),
      ]);
      // read-error guard: a transient failure must not be read as "no wins" —
      // empty rows would fabricate a false "zero taps yet" nudge. Keep whatever
      // message is already on screen and bail rather than treat null as truth.
      if (error) return;
      const rows = data ?? [];
      const today = rows.find((r) => r.day === todayStr());
      const hour = new Date().getHours();
      const todayScore = today ? WIN_KEYS.reduce((s, k) => s + (today[k] ? 1 : 0), 0) : 0;
      const top3 = ((todayPlan?.top3 as string[]) ?? []).filter((t) => t?.trim());

      // weakest habit this week
      const counts: Record<string, number> = {};
      WIN_KEYS.forEach((k) => (counts[k] = rows.reduce((s, r) => s + (r[k] ? 1 : 0), 0)));
      const weakest = [...WIN_KEYS].sort((a, b) => counts[a] - counts[b])[0];
      const weakCount = counts[weakest];

      // MORNING: yesterday-you left instructions. Honor them.
      if (hour < 12 && top3.length > 0 && todayScore < 3) {
        setMsg({
          head: "👁️ Overseer",
          body: `Last night you chose: “${top3[0]}”. Don't decide anything — just do its first 2 minutes. Deciding is the trap; starting is the win.`,
          tone: "good",
        });
        return;
      }
      // stalled afternoon — smallest possible re-entry
      if (hour >= 15 && hour < 19 && todayScore === 0) {
        setMsg({ head: "👁️ Overseer", body: "Zero taps yet today — that's not failure, that's a blocked start. Break the seal with the easiest toggle on this screen. One tap. Momentum follows action, not the other way around.", tone: "warn" });
        return;
      }
      // strong day — bank the identity, not just the points. After 7pm the
      // UrgencyCard owns the "streak on the line" story; don't contradict it.
      if (todayScore >= Math.ceil(WIN_KEYS.length * 0.7) && (hour < 19 || todayScore === WIN_KEYS.length)) {
        setMsg({ head: "👁️ Overseer", body: `${todayScore}/${WIN_KEYS.length} today. This is what consistent looks like — remember this feeling tomorrow morning.`, tone: "good" });
        return;
      }
      // recurring weak link — pattern, not character
      if (weakCount <= 2 && rows.length >= 3) {
        setMsg({ head: "👁️ Overseer", body: `${LABEL[weakest] ?? weakest} keeps slipping — ${weakCount}/7 days this week. That's a pattern, not a flaw. Do it FIRST tomorrow, before anything gets a vote.`, tone: "warn" });
        return;
      }
      setMsg(null);
    })();
    // todayXP moves with every habit tap, so the message re-evaluates as the
    // day changes — a "zero taps yet" nudge must not outlive its truth
  }, [uid, game.streak.streak, game.todayXP]);

  if (!msg) return null;
  const warn = msg.tone === "warn";
  return (
    <div className={`mt-3 rounded-2xl p-4 border ${warn ? "bg-orange-500/10 border-orange-500/40" : "bg-[var(--neon)]/10 border-[var(--neon)]/40"}`}>
      <p className={`text-xs uppercase tracking-widest mb-1 ${warn ? "text-orange-400" : "text-[var(--neon)]"}`}>{msg.head}</p>
      <p className="text-sm font-medium leading-snug">{msg.body}</p>
      {onOpenChat && (
        <button onClick={() => onOpenChat("overseer")}
          className={`mt-2 text-xs font-semibold ${warn ? "text-orange-300" : "text-[var(--neon)]"} underline underline-offset-2`}>
          Talk it through →
        </button>
      )}
    </div>
  );
}
