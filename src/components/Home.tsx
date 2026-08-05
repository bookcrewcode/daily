"use client";

// 🏠 HOME — the front door.
//
// The old app opened on a checklist: twelve tabs of trackers that all ASKED for
// something and gave nothing back. Nobody opens work for fun. This gives first.
//
// Four zones, in order of what actually matters:
//   1. RIGHT NOW    — one directive, why it matters, the 2-minute version
//   2. TODAY        — the day laid out, not a form to fill in
//   3. DUE          — spaced repetition, the thing that makes learning stick
//   4. MOVING       — proof it's working, before it asks anything of you
// Then one row of one-tap logging, so capture costs nothing.
//
// Everything here works WITHOUT the AI key. The front door must never be dark.

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, WIN_KEYS, type DayRow } from "@/lib/supabase";
import { pickAction, type Signal, type Action } from "@/lib/nextAction";
import { useGame } from "@/lib/useGameData";
import { isDue } from "@/lib/fsrs";
import { sfx, buzz } from "@/lib/fx";
import { Sparkline } from "./ui";

type Ev = { time: string; what: string };

export default function Home({ uid, onGoTab }: { uid: string; onGoTab: (t: string) => void }) {
  const game = useGame();
  const [action, setAction] = useState<Action | null>(null);
  const [today, setToday] = useState<DayRow | null>(null);
  const [plan, setPlan] = useState<Ev[]>([]);
  const [top3, setTop3] = useState<string[]>([]);
  const [due, setDue] = useState(0);
  const [weights, setWeights] = useState<number[]>([]);
  const [mastery, setMastery] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [net, setNet] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState("");

  const load = useCallback(async () => {
    const day = todayStr();
    try {
      const [d, n, cards, chs, ws, as, goals, rows, reps, cons] = await Promise.all([
        supabase.from("days").select("*").eq("user_id", uid).eq("day", day).maybeSingle(),
        supabase.from("nights").select("items,top3").eq("user_id", uid).eq("day", day).maybeSingle(),
        supabase.from("notebook_cards").select("due,suspended").eq("user_id", uid),
        supabase.from("notebook_chapters").select("status").eq("user_id", uid),
        supabase.from("days").select("day,bodyweight").eq("user_id", uid).not("bodyweight", "is", null).order("day", { ascending: false }).limit(30),
        supabase.from("assets").select("kind,value").eq("user_id", uid),
        supabase.from("goals").select("title,due,status").eq("user_id", uid).eq("status", "active").not("due", "is", null).order("due").limit(5),
        supabase.from("engine_rows").select("id,name,rep,min_version").eq("user_id", uid).eq("archived", false),
        supabase.from("engine_reps").select("row_id").eq("user_id", uid).eq("day", day),
        supabase.from("weekly_constraints").select("bottleneck").eq("user_id", uid).order("week_start", { ascending: false }).limit(1),
      ]);

      const dayRow = (d.data ?? null) as DayRow | null;
      setToday(dayRow);
      setPlan(((n.data?.items ?? []) as Ev[]).filter((x) => x?.what));
      setTop3(((n.data?.top3 ?? []) as string[]).filter(Boolean));

      const dueCount = ((cards.data ?? []) as { due: string; suspended: boolean }[]).filter((c) => isDue(c)).length;
      setDue(dueCount);

      const chapters = (chs.data ?? []) as { status: string }[];
      setMastery({ done: chapters.filter((c) => c.status === "done").length, total: chapters.length });

      setWeights(((ws.data ?? []) as { bodyweight: number }[]).map((r) => Number(r.bodyweight)).reverse());

      const assets = (as.data ?? []) as { kind: string; value: number }[];
      setNet(assets.length ? assets.reduce((t, a) => t + (a.kind === "liability" ? -Number(a.value) : Number(a.value)), 0) : null);

      // ── build the signal for "right now" ──
      const winsToday = dayRow ? WIN_KEYS.filter((k) => (dayRow as unknown as Record<string, boolean>)[k]).length : 0;
      const g = ((goals.data ?? []) as { title: string; due: string }[])[0];
      const days = g ? Math.ceil((new Date(g.due + "T00:00:00").getTime() - new Date(day + "T00:00:00").getTime()) / 86400000) : 0;
      const voted = new Set(((reps.data ?? []) as { row_id: string }[]).map((r) => r.row_id));
      const cold = ((rows.data ?? []) as { id: string; name: string; rep: string; min_version: string }[]).find((r) => !voted.has(r.id));

      const signal: Signal = {
        streakAtRisk: winsToday === 0,
        winsToday,
        dueCards: dueCount,
        urgentGoal: g ? { title: g.title, days } : null,
        coldRow: cold ? { name: cold.name, rep: cold.rep, minVersion: cold.min_version } : null,
        constraint: ((cons.data ?? []) as { bottleneck: string }[])[0]?.bottleneck ?? "",
        unloggedMeds: !dayRow?.ws_meds,
        hour: new Date().getHours(),
      };
      setAction(pickAction(signal));
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  // one-tap logging — capture must cost nothing
  async function tapWin(key: string, label: string) {
    if (saving) return;
    setSaving(key);
    const day = todayStr();
    const cur = (today as unknown as Record<string, boolean> | null)?.[key] ?? false;
    const { error } = await supabase.from("days").upsert({ user_id: uid, day, [key]: !cur }, { onConflict: "user_id,day" });
    setSaving("");
    if (error) return;
    if (!cur) { sfx.pop(); buzz(12); }
    await load();
    game.refresh();
  }

  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Still up" : hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
  const winsToday = today ? WIN_KEYS.filter((k) => (today as unknown as Record<string, boolean>)[k]).length : 0;
  const now = `${String(hour).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`;
  const upcoming = plan.filter((p) => p.time && p.time >= now).slice(0, 3);
  const shown = upcoming.length ? upcoming : plan.slice(-2);

  const QUICK: { key: string; icon: string; label: string }[] = [
    { key: "ws_meds", icon: "💊", label: "Meds" },
    { key: "ws_eat", icon: "🍎", label: "Ate" },
    { key: "ws_water", icon: "💧", label: "Water" },
    { key: "ws_lift", icon: "🏋️", label: "Lift" },
  ];

  const toneRing = action?.tone === "urgent" ? "border-orange-400/50 bg-orange-500/[0.07]"
    : action?.tone === "calm" ? "border-white/10 bg-white/[0.03]"
    : "border-[var(--neon)]/40 bg-[var(--neon)]/[0.07]";

  return (
    <div className="pt-3">
      {/* greeting + streak */}
      <div className="flex items-end justify-between mb-3">
        <div>
          <h1 className="font-display text-2xl font-bold leading-none">{greeting}, Ben</h1>
          <p className="text-[11px] opacity-45 mt-1">{winsToday}/{WIN_KEYS.length} wins today · level {game.level.level}</p>
        </div>
        {game.streak.streak > 0 && (
          <div className="text-right">
            <p className="font-display text-2xl font-black leading-none text-orange-300">🔥{game.streak.streak}</p>
            <p className="text-[9px] uppercase tracking-widest opacity-40 mt-0.5">day streak</p>
          </div>
        )}
      </div>

      {/* 1 — RIGHT NOW */}
      {!loaded ? (
        <div className="skeleton h-32" />
      ) : action && (
        <div className={`rounded-2xl border p-4 ${toneRing}`}>
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-45 mb-1.5">Right now</p>
          <p className="font-display text-xl font-bold leading-tight">{action.title}</p>
          <p className="text-sm opacity-65 mt-1">{action.why}</p>
          <div className="flex items-center gap-2 mt-3">
            <button onClick={() => onGoTab(action.tab)}
              className="flex-1 rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">
              {action.key === "review" ? "Review →" : action.key === "clear" ? "Go learn →" : "Start →"}
            </button>
          </div>
          <p className="text-[11px] opacity-45 mt-2 leading-relaxed">
            <span className="opacity-70">Stalling?</span> {action.micro}
          </p>
        </div>
      )}

      {/* 2 — TODAY */}
      {(shown.length > 0 || top3.length > 0) && (
        <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-[10px] uppercase tracking-[0.2em] opacity-45 mb-2">Today</p>
          {top3.length > 0 && (
            <div className="space-y-1 mb-2">
              {top3.map((t, k) => (
                <p key={k} className="text-sm"><span className="text-[var(--neon)] font-bold mr-1.5">{k + 1}</span>{t}</p>
              ))}
            </div>
          )}
          {shown.map((p, k) => (
            <div key={k} className="flex gap-3 text-sm py-0.5">
              <span className="tabular-nums opacity-45 w-11 shrink-0">{p.time || "—"}</span>
              <span className="opacity-85">{p.what}</span>
            </div>
          ))}
          <button onClick={() => onGoTab("plan")} className="text-[11px] opacity-45 underline mt-2">the whole day →</button>
        </div>
      )}

      {/* 3 — DUE (retention, front and centre) */}
      <button onClick={() => onGoTab("learning")}
        className="mt-3 w-full text-left rounded-2xl border border-white/10 bg-white/[0.03] p-4 active:scale-[0.99]">
        <p className="text-[10px] uppercase tracking-[0.2em] opacity-45 mb-1.5">Retention</p>
        {due > 0 ? (
          <div className="flex items-center gap-3">
            <p className="font-display text-3xl font-black text-[var(--neon)] leading-none">{due}</p>
            <div className="min-w-0">
              <p className="text-sm font-semibold">cards ready</p>
              <p className="text-[11px] opacity-50">~{Math.max(1, Math.round(due * 0.25))} min · this is what makes it stick</p>
            </div>
          </div>
        ) : (
          <p className="text-sm opacity-55">Nothing due — {mastery.total > 0 ? "you're on top of it." : "add a notebook and start."}</p>
        )}
      </button>

      {/* 4 — MOVING (proof, before it asks anything) */}
      <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <p className="text-[10px] uppercase tracking-[0.2em] opacity-45 mb-2.5">Moving</p>
        <div className="space-y-3">
          {weights.length >= 2 && (
            <div className="flex items-center gap-3">
              <div className="w-20 shrink-0">
                <p className="font-display text-lg font-bold leading-none">{weights[weights.length - 1]}<span className="text-[10px] opacity-40 ml-0.5">lb</span></p>
                <p className="text-[9px] uppercase tracking-widest opacity-40 mt-0.5">body</p>
              </div>
              <div className="flex-1 min-w-0"><Sparkline series={[{ values: weights, color: "#a78bfa" }]} goal={190} height={34} /></div>
            </div>
          )}
          {mastery.total > 0 && (
            <div className="flex items-center gap-3">
              <div className="w-20 shrink-0">
                <p className="font-display text-lg font-bold leading-none">{mastery.done}<span className="opacity-40">/{mastery.total}</span></p>
                <p className="text-[9px] uppercase tracking-widest opacity-40 mt-0.5">mastery</p>
              </div>
              <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full bg-[var(--neon)]" style={{ width: `${(mastery.done / mastery.total) * 100}%` }} />
              </div>
            </div>
          )}
          {net !== null && (
            <div className="flex items-center gap-3">
              <div className="w-20 shrink-0">
                <p className="font-display text-lg font-bold leading-none">${Math.round(net / 1000)}<span className="text-[10px] opacity-40">k</span></p>
                <p className="text-[9px] uppercase tracking-widest opacity-40 mt-0.5">net worth</p>
              </div>
              <button onClick={() => onGoTab("money")} className="text-[11px] opacity-45 underline">open →</button>
            </div>
          )}
          {weights.length < 2 && mastery.total === 0 && net === null && (
            <p className="text-sm opacity-45">Log a few days and your progress shows up here.</p>
          )}
        </div>
      </div>

      {/* one-tap logging */}
      <div className="grid grid-cols-4 gap-2 mt-3">
        {QUICK.map((q) => {
          const on = (today as unknown as Record<string, boolean> | null)?.[q.key] ?? false;
          return (
            <button key={q.key} onClick={() => tapWin(q.key, q.label)} disabled={!!saving}
              className={`rounded-xl border py-3 active:scale-95 transition disabled:opacity-60 ${on ? "bg-[var(--neon)]/15 border-[var(--neon)]/40" : "bg-white/[0.03] border-white/10"}`}>
              <div className="text-xl leading-none">{q.icon}</div>
              <div className={`text-[10px] mt-1 font-semibold ${on ? "text-[var(--neon)]" : "opacity-50"}`}>{on ? "done" : q.label}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
