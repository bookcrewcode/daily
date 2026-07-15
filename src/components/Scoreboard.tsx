"use client";

// ⚙️ THE ENGINE — Ben's own framework, running as software.
//
// The gym worked because it handed him four things for free: visible
// progress, fast feedback, an identity, and a payoff every session.
// Everything else stalls because it ships with none of them. Each row here
// installs all four onto one part of life:
//   see it   → streak + this-week dots, always on the Today screen
//   feel it  → the check-off is the hit (sfx + XP + vote float), daily
//   own it   → every rep is a VOTE for "I'm someone who …"
//   enjoy it → votes stack visibly; the weekly Mirror shows the pile
// One rule, his words: measure REPS, not outcomes.

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, dateStr } from "@/lib/supabase";
import { REP_XP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { xpToast, sfx, buzz } from "@/lib/fx";
import { Card } from "./ui";

export type EngineRow = { id: string; emoji: string; name: string; rep: string; identity: string; archived: boolean; sort: number };
type RepDay = { row_id: string; day: string };

const SUGGESTED: Omit<EngineRow, "id" | "archived" | "sort">[] = [
  { emoji: "📦", name: "BookCrew", rep: "Ship one concrete thing — a section, a fix, one outreach", identity: "I'm a founder who ships, not just plans" },
  { emoji: "📚", name: "School", rep: "One 45-min focused block (use the Tools timer)", identity: "I do the work even when it's boring" },
  { emoji: "🏋️", name: "Body", rep: "Session done — the engine that already runs", identity: "I'm someone who trains" },
  { emoji: "🧠", name: "My system", rep: "Capture the day + process one inbox item", identity: "I run my life from a system, not my memory" },
];

function rowStreak(days: Set<string>): number {
  let streak = 0;
  const cursor = new Date();
  // today not done yet doesn't break the chain — start from yesterday then
  if (!days.has(dateStr(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dateStr(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export default function Scoreboard({ uid }: { uid: string }) {
  const game = useGame();
  const [rows, setRows] = useState<EngineRow[] | null>(null);
  const [reps, setReps] = useState<RepDay[]>([]);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [why, setWhy] = useState(false);
  const [draft, setDraft] = useState({ emoji: "⚙️", name: "", rep: "", identity: "" });

  const load = useCallback(async () => {
    const since = new Date(); since.setDate(since.getDate() - 120);
    const [{ data: r }, { data: rp }] = await Promise.all([
      supabase.from("engine_rows").select("*").eq("user_id", uid).eq("archived", false).order("sort").order("created_at"),
      supabase.from("engine_reps").select("row_id,day").eq("user_id", uid).gte("day", dateStr(since)),
    ]);
    setRows((r ?? []) as EngineRow[]);
    setReps((rp ?? []) as RepDay[]);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  const today = todayStr();
  const byRow = new Map<string, Set<string>>();
  for (const r of reps) {
    if (!byRow.has(r.row_id)) byRow.set(r.row_id, new Set());
    byRow.get(r.row_id)!.add(r.day);
  }

  async function toggleRep(row: EngineRow) {
    const days = byRow.get(row.id) ?? new Set<string>();
    if (days.has(today)) {
      // undo — honest scoreboards allow corrections
      setReps((x) => x.filter((r) => !(r.row_id === row.id && r.day === today)));
      await supabase.from("engine_reps").delete().eq("user_id", uid).eq("row_id", row.id).eq("day", today);
      game.refresh();
      return;
    }
    setReps((x) => [...x, { row_id: row.id, day: today }]);
    const { error } = await supabase.from("engine_reps").insert({ user_id: uid, row_id: row.id, day: today });
    if (error) {
      setReps((x) => x.filter((r) => !(r.row_id === row.id && r.day === today)));
      return;
    }
    sfx.pop(); buzz(15);
    xpToast(REP_XP, `vote: ${row.identity.replace(/^i'?m (someone who )?/i, "")}`.slice(0, 44));
    game.refresh();
  }

  async function addRow(preset?: typeof SUGGESTED[number]) {
    const d = preset ?? draft;
    if (!d.name.trim() || !d.rep.trim() || !d.identity.trim()) return;
    const { error } = await supabase.from("engine_rows").insert({
      user_id: uid, emoji: d.emoji || "⚙️", name: d.name.trim(), rep: d.rep.trim(), identity: d.identity.trim(),
      sort: (rows?.length ?? 0),
    });
    if (!error) {
      setDraft({ emoji: "⚙️", name: "", rep: "", identity: "" });
      setAdding(false);
      sfx.coin();
      load();
    }
  }

  async function archiveRow(id: string) {
    setRows((r) => (r ?? []).filter((x) => x.id !== id));
    await supabase.from("engine_rows").update({ archived: true }).eq("id", id);
    game.refresh();
  }

  if (rows === null) return <div className="skeleton h-20 mt-3" />;

  // last 7 days, oldest → newest, for the week dots
  const week: string[] = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); week.push(dateStr(d)); }

  return (
    <Card className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs uppercase tracking-widest opacity-60">⚙️ The Engine — today&apos;s reps</p>
        <div className="flex gap-3">
          <button onClick={() => setWhy((v) => !v)} className="text-xs opacity-30 underline">why this works</button>
          {rows.length > 0 && <button onClick={() => setManaging((v) => !v)} className="text-xs opacity-30 underline">{managing ? "done" : "edit"}</button>}
        </div>
      </div>

      {why && (
        <div className="rounded-xl bg-white/5 border border-white/10 p-3 mb-2 text-xs leading-relaxed" style={{ animation: "fadeSlide 0.2s ease" }}>
          <p className="font-bold mb-1">The gym handed you four things for free. Every row installs them on purpose:</p>
          <p>👁 <b>See it</b> — streak + week dots, right here, every day.</p>
          <p>⚡ <b>Feel it fast</b> — the check-off is the hit. Daily, not someday.</p>
          <p>🪞 <b>Own it</b> — every rep is a vote for who you&apos;re becoming.</p>
          <p>🎁 <b>Enjoy it</b> — votes stack; Sunday&apos;s Mirror shows the pile.</p>
          <p className="opacity-60 mt-1">If a row stalls, one of these four is missing. That&apos;s the diagnosis — every time. And the rule: <b>reps, not outcomes.</b></p>
        </div>
      )}

      {rows.length === 0 && !adding && (
        <div className="text-center py-2">
          <p className="text-sm opacity-70 mb-1">Every part of your life becomes a row: a daily rep, a streak you can see, an identity it votes for.</p>
          <p className="text-[10px] opacity-40 mb-3">Start with ONE. The gym already runs — that&apos;s your proof the engine works.</p>
          <div className="flex flex-wrap gap-1.5 justify-center mb-3">
            {SUGGESTED.map((s) => (
              <button key={s.name} onClick={() => addRow(s)}
                className="text-xs font-semibold px-3 py-2 rounded-full bg-[var(--neon)]/15 text-[var(--neon)] active:scale-95">
                {s.emoji} {s.name}
              </button>
            ))}
          </div>
          <button onClick={() => setAdding(true)} className="text-xs opacity-50 underline">or build your own row</button>
        </div>
      )}

      <div className="space-y-2">
        {rows.map((row) => {
          const days = byRow.get(row.id) ?? new Set<string>();
          const done = days.has(today);
          const streak = rowStreak(days);
          const weekCount = week.filter((d) => days.has(d)).length;
          return (
            <div key={row.id} className={`rounded-xl border p-2.5 ${done ? "border-[var(--neon)]/40 bg-[var(--neon)]/10" : "border-white/10 bg-white/[0.03]"}`}>
              <div className="flex items-center gap-2.5">
                <button onClick={() => toggleRep(row)}
                  className={`w-9 h-9 shrink-0 rounded-xl grid place-items-center text-base font-bold transition active:scale-90 ${done ? "bg-[var(--neon)] text-black pop-check" : "border-2 border-white/25"}`}>
                  {done ? "✓" : row.emoji}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-bold truncate">{row.name}</p>
                    {streak > 0 && <span className="text-[10px] font-bold shrink-0">🔥{streak}</span>}
                    <span className="text-[10px] opacity-40 shrink-0">{weekCount}/7 wk</span>
                  </div>
                  <p className={`text-xs leading-tight truncate ${done ? "opacity-40 line-through" : "opacity-60"}`}>{row.rep}</p>
                  <p className="text-[10px] italic text-[var(--neon)]/60 truncate">🗳 {row.identity}</p>
                </div>
                <div className="flex gap-[3px] shrink-0">
                  {week.map((d) => (
                    <span key={d} className={`w-[7px] h-[18px] rounded-sm ${days.has(d) ? "bg-[var(--neon)]/80" : d === today ? "bg-white/15" : "bg-white/[0.07]"}`} />
                  ))}
                </div>
                {managing && (
                  <button onClick={() => archiveRow(row.id)} className="shrink-0 opacity-40 text-xs px-1 active:scale-90">✕</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {rows.length > 0 && !adding && (
        <button onClick={() => setAdding(true)} className="mt-2 text-[10px] opacity-40 underline">+ add a row (one at a time — that&apos;s the rule)</button>
      )}

      {adding && (
        <div className="mt-3 pt-3 border-t border-white/10 space-y-2" style={{ animation: "fadeSlide 0.2s ease" }}>
          <p className="text-xs uppercase tracking-widest opacity-50">New row — if you can&apos;t answer these, the goal is too vague (and that&apos;s WHY it stalls)</p>
          <div className="flex gap-2">
            <input value={draft.emoji} onChange={(e) => setDraft({ ...draft, emoji: e.target.value.slice(0, 4) })}
              className="w-14 rounded-xl bg-black/30 px-2 py-3 outline-none text-center" />
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="the goal (short name)"
              className="flex-1 min-w-0 rounded-xl bg-black/30 px-4 py-3 outline-none" />
          </div>
          <input value={draft.rep} onChange={(e) => setDraft({ ...draft, rep: e.target.value })}
            placeholder='the REP — smallest action you can do today ("open the doc, write one sentence")'
            className="w-full rounded-xl bg-black/30 px-4 py-3 outline-none text-sm" />
          <input value={draft.identity} onChange={(e) => setDraft({ ...draft, identity: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addRow()}
            placeholder='the IDENTITY — "I&apos;m someone who …"'
            className="w-full rounded-xl bg-black/30 px-4 py-3 outline-none text-sm" />
          <div className="flex gap-2">
            <button onClick={() => setAdding(false)} className="flex-1 rounded-xl bg-white/10 py-2.5 active:scale-95">Cancel</button>
            <button onClick={() => addRow()} className="flex-1 rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">Add row · +{REP_XP} XP per rep</button>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <p className="text-[9px] opacity-30 mt-2 text-center">reps, not outcomes — you don&apos;t have to feel successful to check the box, you just have to have shown up</p>
      )}
    </Card>
  );
}
