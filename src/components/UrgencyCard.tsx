"use client";

// 🔥 Right now — the urgency surface. Research basis (Barkley, Dodson):
// ADHD time has two zones, Now and Not-Now; deadlines only motivate once
// they're IN the Now. This card pulls the truly-urgent into Now — and when
// everything screams at once, Hick's law says show ONE bolded thing, so the
// panic button picks for you and hands you a 2-minute starter.

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, dateStr, WIN_KEYS, type DayRow, type Goal } from "@/lib/supabase";
import { useGame } from "@/lib/useGameData";
import { sfx, buzz } from "@/lib/fx";
import { Card } from "./ui";

const HABIT_LABEL: Record<string, string> = {
  ws_meds: "💊 meds", ws_water: "💧 water", ws_eat: "🍽️ eat clean", ws_lift: "🏋️ lift",
  ws_stretch: "🧘 stretch", ws_sleep: "😴 sleep", ws_vocab: "✍️ vocab", ws_chinese: "🐼 chinese",
  ws_school: "📚 school", ws_affirmations: "💫 affirmations", ws_work: "💼 work",
};

type Item = {
  key: string;
  icon: string;
  text: string;
  sub?: string;
  starter: string;  // the 2-minute first move — starters beat titles for task initiation
  tab?: string;
  weight: number;   // higher = more urgent
};

export default function UrgencyCard({ todayRow, onGoTab }: { todayRow: DayRow; onGoTab?: (tab: string) => void }) {
  const game = useGame();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [tomorrowPlanned, setTomorrowPlanned] = useState(true);
  const [picked, setPicked] = useState<Item | null>(null);

  // re-pull goals/plan when the app resurfaces — a PWA left open overnight
  // must not warn about the wrong "tomorrow"
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    const horizon = new Date(); horizon.setDate(horizon.getDate() + 2);
    const tmrw = new Date(); tmrw.setDate(tmrw.getDate() + 1);
    const [{ data: g }, { data: n }] = await Promise.all([
      supabase.from("goals").select("*").eq("user_id", game.uid).eq("status", "active").not("due", "is", null).lte("due", dateStr(horizon)).order("due").limit(4),
      supabase.from("nights").select("top3,items").eq("user_id", game.uid).eq("day", dateStr(tmrw)).maybeSingle(),
    ]);
    setGoals((g ?? []) as Goal[]);
    const top3 = ((n?.top3 as string[]) ?? []).filter((t) => t?.trim());
    const items = ((n?.items as { what: string }[]) ?? []).filter((i) => i.what?.trim());
    setTomorrowPlanned(top3.length > 0 || items.length > 0);
  }, [game.uid]);
  useEffect(() => { load(); }, [load]);

  const hour = new Date().getHours();
  const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
  const hoursLeft = Math.max(0, (midnight.getTime() - Date.now()) / 3600000);

  const items: Item[] = [];

  // deadlines entering the Now zone
  for (const g of goals) {
    const dl = Math.round((new Date(g.due + "T00:00:00").getTime() - new Date(todayStr() + "T00:00:00").getTime()) / 86400000);
    items.push({
      key: `goal-${g.id}`, icon: dl < 0 ? "🚨" : "⏳",
      text: g.title,
      sub: dl < 0 ? `${-dl}d overdue — it's not going away` : dl === 0 ? "due TODAY" : `due in ${dl}d`,
      starter: "Open it and do literally 2 minutes. Momentum does the rest.",
      tab: "goals",
      weight: 100 - dl * 10,
    });
  }

  // streak on the line tonight (evening loss-framing — but never shame)
  const score = WIN_KEYS.reduce((s, k) => s + (todayRow[k] ? 1 : 0), 0);
  const missing = WIN_KEYS.filter((k) => !todayRow[k]);
  if (hour >= 19 && game.streak.streak > 0 && score < WIN_KEYS.length) {
    const easiest = missing.slice(0, 3).map((k) => HABIT_LABEL[k]).join(" · ");
    items.push({
      key: "streak", icon: "🔥",
      text: `Your ${game.streak.streak}-day streak is on the line`,
      sub: `${missing.length} wins left · ${hoursLeft.toFixed(1)}h until midnight${game.streak.shields > 0 ? ` · ${"🛡".repeat(game.streak.shields)} backup` : " · NO shields left"}`,
      starter: `Fastest first: ${easiest}. Two of those take 5 minutes total.`,
      weight: 90 - missing.length * 2 + (game.streak.shields === 0 ? 15 : 0),
    });
  }

  // tomorrow unplanned late at night → tomorrow starts foggy
  if (hour >= 21 && !tomorrowPlanned) {
    items.push({
      key: "plan-tomorrow", icon: "🌙",
      text: "Tomorrow has no plan yet",
      sub: "2 minutes now saves the whole morning",
      starter: "Open Night and write just the Top 1. That's enough.",
      tab: "night",
      weight: 55,
    });
  }

  if (items.length === 0) return null;
  items.sort((a, b) => b.weight - a.weight);
  const [top, ...rest] = items;

  function panic() {
    sfx.pop(); buzz([20, 30, 20]);
    setPicked(top);
  }

  return (
    <Card className="mt-3 border-orange-400/40 bg-orange-400/[0.07]">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs uppercase tracking-widest text-orange-300/90">🔥 Right now</p>
        {items.length > 1 && !picked && (
          <button onClick={panic} className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-orange-400/20 text-orange-200 active:scale-95">
            😵 overwhelmed? pick for me
          </button>
        )}
      </div>

      {picked ? (
        <div style={{ animation: "fadeSlide 0.25s ease" }}>
          <p className="text-[10px] uppercase tracking-widest opacity-50 mb-1">just this one — nothing else exists</p>
          <p className="font-bold">{picked.icon} {picked.text}</p>
          <p className="text-sm text-[var(--neon)] mt-1.5">▶ {picked.starter}</p>
          <div className="flex gap-2 mt-3">
            {picked.tab && (
              <button onClick={() => onGoTab?.(picked.tab!)} className="flex-1 rounded-xl bg-[var(--neon)] text-black text-sm font-bold py-2.5 active:scale-95">Take me there</button>
            )}
            <button onClick={() => setPicked(null)} className="px-4 rounded-xl bg-white/10 text-sm py-2.5 active:scale-95">back</button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <button onClick={() => top.tab ? onGoTab?.(top.tab) : setPicked(top)} className="w-full text-left">
            <p className="font-bold leading-snug">{top.icon} {top.text}</p>
            {top.sub && <p className="text-xs opacity-70 mt-0.5">{top.sub}</p>}
          </button>
          {rest.slice(0, 2).map((it) => (
            <button key={it.key} onClick={() => it.tab ? onGoTab?.(it.tab) : setPicked(it)} className="w-full text-left opacity-45">
              <p className="text-sm leading-snug">{it.icon} {it.text} {it.sub && <span className="text-xs opacity-70">· {it.sub}</span>}</p>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}
