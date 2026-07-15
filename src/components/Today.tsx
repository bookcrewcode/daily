"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, WIN_KEYS, WATER_GOAL, todayStr, dateStr, type DayRow, type ScheduleItem, type Goal } from "@/lib/supabase";
import { HABIT_XP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { sfx, buzz } from "@/lib/fx";
import { parseTime, fmtMinutes } from "@/lib/calendar";
import { Ring, NumCard, SectionTitle, Card } from "./ui";
import Overseer from "./Overseer";
import GameBar from "./GameBar";
import CalendarCard from "./CalendarCard";
import Quests from "./Quests";
import WeatherStrip from "./WeatherStrip";

type WinKey = (typeof WIN_KEYS)[number];

const WINS: { key: WinKey; emoji: string; label: string; link?: string; linkLabel?: string }[] = [
  { key: "ws_meds", emoji: "💊", label: "Meds" },
  { key: "ws_eat", emoji: "🍽️", label: "Ate clean + logged" },
  { key: "ws_lift", emoji: "🏋️", label: "Lifts (or rest day)" },
  { key: "ws_stretch", emoji: "🧘", label: "Stretch 5 min", link: "https://www.youtube.com/watch?v=TTN7-Aw5G2s", linkLabel: "Play" },
  { key: "ws_sleep", emoji: "😴", label: "Slept 7+ hrs" },
  { key: "ws_vocab", emoji: "✍️", label: "Vocab word" },
  { key: "ws_chinese", emoji: "🐼", label: "Chinese", link: "https://www.duolingo.com/learn", linkLabel: "Duolingo" },
  { key: "ws_school", emoji: "📚", label: "School" },
  { key: "ws_affirmations", emoji: "💫", label: "Affirmations" },
  { key: "ws_work", emoji: "💼", label: "BookCrew / research" },
];

const EMPTY: DayRow = {
  day: todayStr(),
  ws_meds: false, ws_eat: false, ws_lift: false, ws_stretch: false,
  ws_vocab: false, ws_chinese: false, ws_work: false,
  ws_water: false, ws_sleep: false, ws_school: false, ws_affirmations: false,
  calories: 0, protein: 0, bodyweight: null, vocab_count: 0, water_cups: 0, vocab_reviews: 0,
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Late night, Ben 🌌";
  if (h < 12) return "Good morning, Ben 🌅";
  if (h < 17) return "Good afternoon, Ben ☀️";
  if (h < 21) return "Good evening, Ben 🌆";
  return "Wind down, Ben 🌙";
}

type Plan = { top3: string[]; items: ScheduleItem[] } | null;

export default function Today({ uid, onOpenAdvisor, onGoTab }: {
  uid: string;
  onOpenAdvisor?: (advisor: string) => void;
  onGoTab?: (tab: string) => void;
}) {
  const game = useGame();
  const [row, setRow] = useState<DayRow>({ ...EMPTY, day: todayStr() });
  const [history, setHistory] = useState<{ day: string; score: number }[]>([]);
  const [now, setNow] = useState("");
  const [plan, setPlan] = useState<Plan>(null);
  const [nextGoal, setNextGoal] = useState<Goal | null>(null);
  const [floats, setFloats] = useState<Record<string, number>>({});
  const [doneTop3, setDoneTop3] = useState<Set<number>>(new Set());
  const dayRef = useRef(todayStr());

  const load = useCallback(async () => {
    const day = todayStr();
    dayRef.current = day;
    const [{ data }, { data: nightRow }, { data: goals }] = await Promise.all([
      supabase.from("days").select("*").eq("user_id", uid).eq("day", day).maybeSingle(),
      supabase.from("nights").select("top3,items").eq("user_id", uid).eq("day", day).maybeSingle(),
      supabase.from("goals").select("*").eq("user_id", uid).eq("status", "active").not("due", "is", null).order("due").limit(1),
    ]);
    setRow(data ? { ...EMPTY, ...data, day } : { ...EMPTY, day });
    if (nightRow) {
      const top3 = ((nightRow.top3 as string[]) ?? []).filter((t) => t.trim());
      const items = ((nightRow.items as ScheduleItem[]) ?? []).filter((it) => it.what.trim());
      setPlan(top3.length || items.length ? { top3, items } : null);
    } else {
      setPlan(null);
    }
    setNextGoal((goals?.[0] as Goal) ?? null);

    const since = new Date(); since.setDate(since.getDate() - 6);
    const { data: hist } = await supabase.from("days").select("*").eq("user_id", uid).gte("day", dateStr(since)).order("day");
    const map = new Map((hist ?? []).map((r) => [r.day, r]));
    const out: { day: string; score: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const r = map.get(dateStr(d));
      out.push({ day: dateStr(d), score: r ? WIN_KEYS.reduce((s, k) => s + (r[k] ? 1 : 0), 0) : 0 });
    }
    setHistory(out);
  }, [uid]);

  useEffect(() => { load(); }, [load]);

  // clock + MIDNIGHT ROLLOVER GUARD: a PWA left open overnight must not write
  // wins onto yesterday's row. Re-load when the calendar date changes or the
  // app is resumed from the home screen.
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNow(d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) +
        " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
      if (todayStr() !== dayRef.current) { load(); game.refresh(); }
    };
    tick();
    const id = setInterval(tick, 30000);
    const onVisible = () => { if (document.visibilityState === "visible" && todayStr() !== dayRef.current) { load(); game.refresh(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function save(patch: Partial<DayRow>) {
    const next = { ...row, ...patch };
    setRow(next);
    await supabase.from("days").upsert({ user_id: uid, day: next.day, ...patch }, { onConflict: "user_id,day" });
    setHistory((h) => h.map((d) => d.day === next.day
      ? { ...d, score: WIN_KEYS.reduce((s, k) => s + (next[k] ? 1 : 0), 0) } : d));
    game.refresh();
  }

  function fireFloat(key: string) {
    setFloats((f) => ({ ...f, [key]: Date.now() }));
    setTimeout(() => setFloats((f) => { const { [key]: _drop, ...rest } = f; return rest; }), 950);
  }

  function toggleWin(key: WinKey, on: boolean) {
    save({ [key]: !on } as Partial<DayRow>);
    if (!on) {
      sfx.pop();
      buzz(15);
      fireFloat(key);
      const willBe = WIN_KEYS.reduce((s, k) => s + ((k === key ? true : row[k]) ? 1 : 0), 0);
      if (willBe === WIN_KEYS.length) setTimeout(() => { burstConfetti("big"); sfx.fanfare(); }, 150);
    }
  }

  async function setWater(cups: number) {
    const clamped = Math.max(0, Math.min(cups, 12));
    const hitGoal = clamped >= WATER_GOAL && !row.ws_water;
    if (cups > row.water_cups) { sfx.pop(); buzz(10); }
    const patch: Partial<DayRow> = { water_cups: clamped };
    if (hitGoal) {
      patch.ws_water = true;
      fireFloat("ws_water");
      const willBe = WIN_KEYS.reduce((s, k) => s + ((k === "ws_water" ? true : row[k]) ? 1 : 0), 0);
      if (willBe === WIN_KEYS.length) setTimeout(() => { burstConfetti("big"); sfx.fanfare(); }, 150);
    } else if (clamped < WATER_GOAL && row.ws_water) {
      // dropping back under 8 un-banks the win — same as unchecking any habit
      patch.ws_water = false;
    }
    await save(patch);
  }

  const score = WIN_KEYS.reduce((s, k) => s + (row[k] ? 1 : 0), 0);
  const due = nextGoal?.due ? Math.round((new Date(nextGoal.due + "T00:00:00").getTime() - new Date(todayStr() + "T00:00:00").getTime()) / 86400000) : null;

  return (
    <div>
      <div className="pt-3 pb-1">
        <p className="text-xs uppercase tracking-widest text-[var(--neon)]/70">{now}</p>
        <h1 className="text-2xl font-bold mt-1">{greeting()}</h1>
        <WeatherStrip dayOffset={0} />
      </div>

      <GameBar />
      <Overseer uid={uid} onOpenChat={onOpenAdvisor} />

      {nextGoal && due != null && due <= 7 && (
        <button onClick={() => onGoTab?.("goals")} className="mt-3 w-full text-left">
          <div className={`rounded-xl border px-3 py-2 flex items-center gap-2 text-sm ${due <= 1 ? "border-red-500/40 bg-red-500/10" : "border-orange-400/30 bg-orange-400/10"}`}>
            <span>⏳</span>
            <span className="flex-1 min-w-0 truncate font-medium">{nextGoal.title}</span>
            <span className={`shrink-0 text-xs font-bold ${due <= 1 ? "text-red-400" : "text-orange-300"}`}>
              {due < 0 ? `${-due}d overdue` : due === 0 ? "due today" : `${due}d left`}
            </span>
          </div>
        </button>
      )}

      {plan && (
        <Card tone="neon" className="mt-3">
          <p className="text-xs uppercase tracking-widest text-[var(--neon)]/80 mb-2">📋 Today&apos;s plan — set last night</p>
          {plan.top3.length > 0 && (
            <div className="space-y-1.5 mb-2">
              {plan.top3.map((t, i) => {
                const done = doneTop3.has(i);
                return (
                  <button key={i} onClick={() => setDoneTop3((s) => { const n = new Set(s); if (done) n.delete(i); else n.add(i); return n; })}
                    className="flex items-center gap-2.5 w-full text-left">
                    <span className={`w-5 h-5 shrink-0 rounded-full grid place-items-center text-[10px] font-bold ${done ? "bg-[var(--neon)] text-black pop-check" : "border border-[var(--neon)]/50 text-[var(--neon)]"}`}>
                      {done ? "✓" : i + 1}
                    </span>
                    <span className={`text-sm font-medium ${done ? "line-through opacity-40" : ""}`}>{t}</span>
                  </button>
                );
              })}
            </div>
          )}
          {plan.items.length > 0 && (
            <div className="space-y-0.5 pt-1 border-t border-[var(--neon)]/15">
              {plan.items.map((it, i) => {
                const mins = parseTime(it.time);
                return (
                  <p key={i} className="text-xs opacity-70">
                    <span className="text-[var(--neon)]/80 font-semibold tabular-nums mr-2">{mins !== null ? fmtMinutes(mins) : it.time}</span>
                    {it.what}
                  </p>
                );
              })}
            </div>
          )}
        </Card>
      )}

      <Quests refreshKey={row} />

      <div className="mt-3">
        <CalendarCard uid={uid} day={new Date()} title="Today · Google Calendar" />
      </div>

      <div className="flex items-center gap-3 my-4">
        <Ring score={score} total={WIN_KEYS.length} />
        <div>
          <p className="text-3xl font-extrabold leading-none">{score}<span className="text-base opacity-50">/{WIN_KEYS.length}</span></p>
          <p className="text-sm opacity-60">{score === WIN_KEYS.length ? "Day won. 🔥" : "Tap to bank a win."}</p>
        </div>
      </div>

      {/* Water — a counter, not a checkbox. 8 cups banks the win. */}
      <Card padded={false} tone={row.ws_water ? "neon" : "default"} className="p-3 relative mb-2">
        {floats.ws_water && <span className="xp-float">+{HABIT_XP.ws_water} XP</span>}
        <div className="flex items-center gap-2.5">
          <span className="text-xl shrink-0">💧</span>
          <div className="flex-1">
            <p className="text-sm font-medium leading-tight">Water {row.ws_water && "✓"}</p>
            <div className="flex gap-1 mt-1.5">
              {Array.from({ length: WATER_GOAL }, (_, i) => (
                <button key={i} onClick={() => setWater(i + 1 === row.water_cups ? i : i + 1)}
                  className={`h-5 flex-1 rounded transition active:scale-90 ${i < row.water_cups ? "bg-sky-400/80" : "bg-white/10"}`} />
              ))}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-lg font-extrabold tabular-nums leading-none">{row.water_cups}<span className="text-xs opacity-40">/{WATER_GOAL}</span></p>
            <button onClick={() => setWater(row.water_cups - 1)} className="text-[10px] opacity-40 underline mt-1">undo</button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2">
        {WINS.map((w) => {
          const on = row[w.key];
          return (
            <Card key={w.key} padded={false} tone={on ? "neon" : "default"} className="p-3 relative">
              {floats[w.key] && <span className="xp-float">+{HABIT_XP[w.key]} XP</span>}
              <button onClick={() => toggleWin(w.key, on)} className="flex items-center gap-2.5 w-full text-left">
                <span className="text-xl shrink-0">{w.emoji}</span>
                <span className="flex-1 text-sm font-medium leading-tight">{w.label}</span>
                <span className={`w-6 h-6 shrink-0 rounded-full grid place-items-center text-xs font-bold ${on ? "bg-[var(--neon)] text-black pop-check" : "border border-white/30"}`}>{on ? "✓" : ""}</span>
              </button>
              {w.link && (
                <a href={w.link} target="_blank" rel="noreferrer"
                  className="mt-2 inline-block text-[10px] font-semibold px-2.5 py-1 rounded-full bg-[var(--neon)]/20 text-[var(--neon)] active:scale-95">{w.linkLabel} ↗</a>
              )}
            </Card>
          );
        })}
      </div>

      <SectionTitle>Quick log</SectionTitle>
      <div className="grid grid-cols-3 gap-2">
        {/* calories/protein live in Food (single source of truth — meals) */}
        <button onClick={() => onGoTab?.("food")} className="text-left">
          <Card padded={false} className="p-3 h-full">
            <p className="text-xs opacity-60 mb-1">🔥 Calories</p>
            <p className="text-xl font-bold">{row.calories || 0}</p>
            <p className="text-[9px] text-[var(--neon)]/70 mt-0.5">log in Food →</p>
          </Card>
        </button>
        <button onClick={() => onGoTab?.("food")} className="text-left">
          <Card padded={false} className="p-3 h-full">
            <p className="text-xs opacity-60 mb-1">💪 Protein g</p>
            <p className="text-xl font-bold">{row.protein || 0}</p>
            <p className="text-[9px] text-[var(--neon)]/70 mt-0.5">log in Food →</p>
          </Card>
        </button>
        <NumCard label="⚖️ Weight lb" value={row.bodyweight ?? 0} onChange={(v) => save({ bodyweight: v })} step={1} decimals />
      </div>

      <SectionTitle>Last 7 days</SectionTitle>
      <div className="flex justify-between gap-1">
        {history.map((d) => {
          const pct = d.score / WIN_KEYS.length;
          const label = new Date(d.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "narrow" });
          return (
            <div key={d.day} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full h-20 rounded-lg bg-white/5 flex items-end overflow-hidden">
                <div className="w-full rounded-lg bg-[var(--neon)]" style={{ height: `${Math.max(pct * 100, d.score ? 8 : 0)}%`, opacity: 0.45 + pct * 0.55 }} />
              </div>
              <span className="text-[10px] opacity-50">{label}</span>
            </div>
          );
        })}
      </div>
      <p className="text-xs opacity-30 mt-2">Full history + trends → <span className="text-[var(--neon)]/70">Goals tab</span></p>
    </div>
  );
}
