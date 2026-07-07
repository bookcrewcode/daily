"use client";

import { useEffect, useState } from "react";
import { supabase, WIN_KEYS, todayStr, dateStr } from "@/lib/supabase";

const LABEL: Record<string, string> = {
  ws_meds: "Meds + water", ws_eat: "Clean eating", ws_lift: "Lifts",
  ws_stretch: "Stretching", ws_vocab: "Vocab", ws_chinese: "Chinese", ws_work: "BookCrew / work",
};

export default function Overseer({ uid, onOpenChat }: { uid: string; onOpenChat?: (advisor: string) => void }) {
  const [msg, setMsg] = useState<{ head: string; body: string; tone: "warn" | "good" } | null>(null);

  useEffect(() => {
    (async () => {
      const since = new Date(); since.setDate(since.getDate() - 6);
      const { data } = await supabase.from("days").select("*").eq("user_id", uid).gte("day", dateStr(since));
      const rows = data ?? [];
      const today = rows.find((r) => r.day === todayStr());

      // count hits per win over the window
      const counts: Record<string, number> = {};
      WIN_KEYS.forEach((k) => (counts[k] = rows.reduce((s, r) => s + (r[k] ? 1 : 0), 0)));
      const weakest = [...WIN_KEYS].sort((a, b) => counts[a] - counts[b])[0];
      const weakCount = counts[weakest];

      // urgent goals
      const { data: goals } = await supabase.from("goals").select("due").eq("user_id", uid).eq("status", "active");
      const now = new Date(todayStr() + "T00:00:00");
      const urgent = (goals ?? []).filter((g) => g.due && new Date(g.due + "T00:00:00").getTime() <= now.getTime() + 2 * 86400000).length;

      const hour = new Date().getHours();
      const todayScore = today ? WIN_KEYS.reduce((s, k) => s + (today[k] ? 1 : 0), 0) : 0;

      if (urgent > 0) {
        setMsg({ head: "👁️ Overseer", body: `${urgent} goal${urgent > 1 ? "s" : ""} due in ≤2 days. That's the fire — hit Goals and move one now.`, tone: "warn" });
      } else if (weakCount <= 2 && rows.length >= 3) {
        setMsg({ head: "👁️ Overseer", body: `${LABEL[weakest]} is your weak link — only ${weakCount}/7 this week. Don't negotiate it. Do it today.`, tone: "warn" });
      } else if (hour >= 15 && todayScore === 0) {
        setMsg({ head: "👁️ Overseer", body: "It's past 3pm and zero wins banked. Pick the easiest toggle and break the seal — momentum follows action.", tone: "warn" });
      } else if (todayScore >= 6) {
        setMsg({ head: "👁️ Overseer", body: `${todayScore}/7 today. That's the standard. Keep the chain alive.`, tone: "good" });
      } else {
        setMsg(null);
      }
    })();
  }, [uid]);

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
