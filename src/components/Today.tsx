"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, WIN_KEYS, todayStr, dateStr, type DayRow } from "@/lib/supabase";
import { Ring, NumCard, SectionTitle, Card } from "./ui";
import Overseer from "./Overseer";
import GameBar from "./GameBar";

type WinKey = (typeof WIN_KEYS)[number];

const WINS: { key: WinKey; emoji: string; label: string; link?: string; linkLabel?: string }[] = [
  { key: "ws_meds", emoji: "💊", label: "Meds" },
  { key: "ws_water", emoji: "💧", label: "Water" },
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
  calories: 0, protein: 0, bodyweight: null, vocab_count: 0,
};

export default function Today({ uid, onOpenAdvisor }: { uid: string; onOpenAdvisor?: (advisor: string) => void }) {
  const [row, setRow] = useState<DayRow>(EMPTY);
  const [history, setHistory] = useState<{ day: string; score: number }[]>([]);
  const [now, setNow] = useState("");

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNow(d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) +
        " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    const day = todayStr();
    const { data } = await supabase.from("days").select("*").eq("user_id", uid).eq("day", day).maybeSingle();
    setRow(data ? { ...EMPTY, ...data, day } : { ...EMPTY, day });

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

  async function save(patch: Partial<DayRow>) {
    const next = { ...row, ...patch };
    setRow(next);
    await supabase.from("days").upsert({ user_id: uid, day: next.day, ...patch }, { onConflict: "user_id,day" });
    setHistory((h) => h.map((d) => d.day === next.day
      ? { ...d, score: WIN_KEYS.reduce((s, k) => s + (next[k] ? 1 : 0), 0) } : d));
  }

  const score = WIN_KEYS.reduce((s, k) => s + (row[k] ? 1 : 0), 0);

  return (
    <div>
      <div className="pt-3 pb-1">
        <p className="text-xs uppercase tracking-widest text-[var(--neon)]/70">{now}</p>
        <h1 className="text-2xl font-bold mt-1">Daily Win Stack</h1>
      </div>

      <GameBar uid={uid} />
      <Overseer uid={uid} onOpenChat={onOpenAdvisor} />

      <div className="flex items-center gap-3 my-4">
        <Ring score={score} total={WINS.length} />
        <div>
          <p className="text-3xl font-extrabold leading-none">{score}<span className="text-base opacity-50">/{WINS.length}</span></p>
          <p className="text-sm opacity-60">{score === WINS.length ? "Day won. 🔥" : "Tap to bank a win."}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {WINS.map((w) => {
          const on = row[w.key];
          return (
            <Card key={w.key} padded={false} tone={on ? "neon" : "default"} className="p-3">
              <button onClick={() => save({ [w.key]: !on } as Partial<DayRow>)} className="flex items-center gap-2.5 w-full text-left">
                <span className="text-xl shrink-0">{w.emoji}</span>
                <span className="flex-1 text-sm font-medium leading-tight">{w.label}</span>
                <span className={`w-6 h-6 shrink-0 rounded-full grid place-items-center text-xs font-bold ${on ? "bg-[var(--neon)] text-black" : "border border-white/30"}`}>{on ? "✓" : ""}</span>
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
        <NumCard label="🔥 Calories" value={row.calories} onChange={(v) => save({ calories: v })} step={50} />
        <NumCard label="💪 Protein g" value={row.protein} onChange={(v) => save({ protein: v })} step={5} />
        <NumCard label="⚖️ Weight lb" value={row.bodyweight ?? 0} onChange={(v) => save({ bodyweight: v })} step={1} decimals />
      </div>

      <SectionTitle>Last 7 days</SectionTitle>
      <div className="flex justify-between gap-1">
        {history.map((d) => {
          const pct = d.score / WINS.length;
          const label = new Date(d.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "narrow" });
          return (
            <div key={d.day} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full h-20 rounded-lg bg-white/5 flex items-end overflow-hidden">
                <div className="w-full rounded-lg bg-[var(--neon)]" style={{ height: `${Math.max(pct * 100, d.score ? 8 : 0)}%` }} />
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
