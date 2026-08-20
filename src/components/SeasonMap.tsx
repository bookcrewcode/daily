"use client";

// 🗺️ THE SEASON MAP — the visible roadmap from Aug 18 to Dec 15.
//
// One serpentine path of 119 day-nodes (the Duolingo unit-map pattern —
// layout math from the MIT clones, restyled graphite), with:
//   · a 17-week contribution heatmap on top (the permanent record),
//   · a battle-pass rep track (250 reps = season XP, 5 claimable tiers —
//     never auto-claimed: the deliberate tap IS the payoff),
//   · deadlines injected as hexagon "boss" nodes at their date,
//   · the 5 level-up dates as crown landmarks,
//   · TODAY as the only large node, pulsing, showing the live core ring.
//
// The map answers exactly one question — "what's next?" — so it is one linear
// path, no branches. Day-to-day logistics stay in the Today tab (boring on
// purpose); this screen exists for the long game.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, todayStr } from "@/lib/supabase";
import {
  type GameDayRow, emptyDay, coreCount, coreParts, dayTotal, addDays, diffDays, seasonDay,
  SEASON_START, SEASON_DAYS, REP_TARGET, TIERS, LEVEL_DATES, WEEK_LABELS,
} from "@/lib/theGame";
import { burstConfetti } from "@/lib/confetti";
import { sfx, buzz } from "@/lib/fx";
import { Eyebrow, Num } from "./ui";

type BossGoal = { id: string; title: string; due: string; stepsDone: number; stepsTotal: number };

const GD_COLS = "day,r_launch,r_shutdown,b,s,bonus_uber,bonus_trading,bonus_dev,bonus_chess,frozen,learn_line,splits";

// ── path geometry (sanidhyy/duolingo-clone parameterization) ────────────────
const VB_W = 360;
const ROW_H = 26;
const TOP_PAD = 28;
const CYCLE = [0, 1, 2, 1, 0, -1, -2, -1]; // indentation levels, cycleLength 8
const STEP = 26;                            // px per indentation level
const xOf = (i: number) => VB_W / 2 + CYCLE[(i - 1) % 8] * STEP;
const yOf = (i: number) => TOP_PAD + (i - 1) * ROW_H;
const MAP_H = TOP_PAD + (SEASON_DAYS - 1) * ROW_H + 40;

const MONDAYS = Object.keys(WEEK_LABELS).sort();

export default function SeasonMap({ uid }: { uid: string }) {
  const [days, setDays] = useState<GameDayRow[]>([]);
  const [repDays, setRepDays] = useState<string[]>([]);
  const [bosses, setBosses] = useState<BossGoal[]>([]);
  const [tiers, setTiers] = useState<number[]>([]);
  // a failed season_tiers read must NEVER leave a [] baseline — claiming on
  // top of it would overwrite (erase) earlier claims in the DB
  const [tiersLoaded, setTiersLoaded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [softErr, setSoftErr] = useState(false);   // bosses/tiers read failed — map still works
  const [claimErr, setClaimErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const claiming = useRef(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [gd, reps, gl, st] = await Promise.all([
        supabase.from("game_days").select(GD_COLS).eq("user_id", uid).gte("day", SEASON_START),
        supabase.from("bc_reps").select("day").eq("user_id", uid).gte("day", SEASON_START),
        supabase.from("goals").select("id,title,due").eq("user_id", uid).eq("status", "active").not("due", "is", null).gte("due", SEASON_START).lte("due", "2026-12-15"),
        supabase.from("user_settings").select("season_tiers").eq("user_id", uid).maybeSingle(),
      ]);
      // the map's spine (days + reps) must be trustworthy or not shown at all
      if (gd.error || reps.error) { setLoadErr(true); setLoaded(true); return; }
      setDays(((gd.data ?? []) as GameDayRow[]).map((d) => ({ ...d, splits: d.splits ?? {} })));
      setRepDays(((reps.data ?? []) as { day: string }[]).map((r) => r.day));
      let soft = false;
      // tiers and goals fail independently — one bad read never blanks the other
      if (st.error) soft = true;
      else {
        setTiers(Array.isArray(st.data?.season_tiers) ? (st.data!.season_tiers as number[]) : []);
        setTiersLoaded(true);
      }
      if (gl.error) soft = true;
      else {
        const goals = (gl.data ?? []) as { id: string; title: string; due: string }[];
        let steps: { goal_id: string; done: boolean }[] = [];
        if (goals.length) {
          const gs = await supabase.from("goal_steps").select("goal_id,done").in("goal_id", goals.map((g) => g.id));
          if (gs.error) soft = true;   // failed steps read ≠ "no steps"
          else steps = (gs.data ?? []) as typeof steps;
        }
        setBosses(goals.map((g) => {
          const mine = steps.filter((s) => s.goal_id === g.id);
          return { id: g.id, title: g.title, due: g.due!, stepsDone: mine.filter((s) => s.done).length, stepsTotal: mine.length };
        }));
      }
      setSoftErr(soft);
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  const today = todayStr();
  const todayI = seasonDay(today);
  const rowsMap = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const repsByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of repDays) m.set(d, (m.get(d) ?? 0) + 1);
    return m;
  }, [repDays]);
  const totalReps = repDays.length;

  const scoreOf = useCallback((day: string) => {
    const r = rowsMap.get(day) ?? emptyDay(day);
    const reps = repsByDay.get(day) ?? 0;
    return { row: r, reps, core: coreCount(r, reps), total: dayTotal(r, reps) };
  }, [rowsMap, repsByDay]);

  // fog starts past the NEXT level landmark — the map reveals itself in arcs
  const nextLevelI = LEVEL_DATES.find((l) => l.days >= Math.max(1, todayI))?.days ?? SEASON_DAYS;

  const bossByDay = useMemo(() => {
    const m = new Map<string, BossGoal[]>();
    for (const b of bosses) m.set(b.due, [...(m.get(b.due) ?? []), b]);
    return m;
  }, [bosses]);

  async function claimTier(at: number) {
    if (claiming.current || !tiersLoaded) return;   // never write over an unread baseline
    claiming.current = true; setClaimBusy(true); setClaimErr("");
    try {
      // read-merge-write: another device may have claimed a tier since this
      // screen loaded — a whole-array overwrite would erase that claim
      const cur = await supabase.from("user_settings").select("season_tiers").eq("user_id", uid).maybeSingle();
      if (cur.error) { setClaimErr("Couldn't check earlier claims — tap again."); return; }
      const base = Array.isArray(cur.data?.season_tiers) ? (cur.data!.season_tiers as number[]) : [];
      const next = [...new Set([...base, ...tiers, at])].sort((a, b) => a - b);
      const { error } = await supabase.from("user_settings").upsert({ user_id: uid, season_tiers: next }, { onConflict: "user_id" });
      if (error) { setClaimErr("Claim didn't save — tap it again."); return; }
      setTiers(next);
      burstConfetti("big"); sfx.levelup(); buzz([25, 40, 25]);
    } catch { setClaimErr("Couldn't reach the server — the claim didn't save."); }
    finally { claiming.current = false; setClaimBusy(false); }
  }

  function jumpToToday() {
    const el = wrapRef.current;
    if (!el || todayI < 1) return;
    const rect = el.getBoundingClientRect();
    const scale = rect.width / VB_W;
    const y = window.scrollY + rect.top + yOf(Math.min(todayI, SEASON_DAYS)) * scale - window.innerHeight / 2;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }

  if (!loaded) return <div className="pt-2"><div className="skeleton h-24 mt-2" /><div className="skeleton h-64 mt-3" /></div>;
  if (loadErr) return (
    <div className="pt-4">
      <button onClick={load} className="w-full rounded-xl bg-orange-500/15 text-orange-300 text-sm font-semibold py-3 active:scale-95">
        Couldn&apos;t load the season — tap to retry.
      </button>
    </div>
  );

  const pathPts = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => `${xOf(from + k)},${yOf(from + k)}`).join(" ");
  const doneUpto = Math.min(Math.max(todayI, 0), SEASON_DAYS);

  const heatColor = (day: string, i: number): string => {
    if (i > Math.max(0, todayI)) return "rgba(255,255,255,0.03)";
    const s = scoreOf(day);
    if (s.row.frozen) return "rgba(56,189,248,0.35)";
    if (s.total >= 10) return "rgba(124,135,240,0.95)";
    if (s.total >= 7) return "rgba(124,135,240,0.62)";
    if (s.total >= 4) return "rgba(124,135,240,0.38)";
    if (s.total >= 1) return "rgba(124,135,240,0.18)";
    return "rgba(255,255,255,0.05)";
  };

  const selInfo = sel ? scoreOf(sel) : null;
  const selBosses = sel ? (bossByDay.get(sel) ?? []) : [];
  const levelDays = new Set<string>(LEVEL_DATES.map((l) => l.date));

  return (
    <div className="pt-2 pb-4">
      {/* header */}
      <div className="flex items-end justify-between">
        <div>
          <Eyebrow>The season · Aug 18 → Dec 15</Eyebrow>
          <p className="mono text-sm text-[var(--text-2)] mt-1">
            {todayI >= 1 && todayI <= SEASON_DAYS ? <>Day {todayI}/{SEASON_DAYS} · {SEASON_DAYS - todayI} left</> : todayI < 1 ? "Pre-season" : "Complete"}
          </p>
        </div>
        <button onClick={jumpToToday} className="text-[11px] mono text-[var(--neon)] border border-[var(--neon)]/30 rounded-lg px-2.5 py-1.5 active:scale-95">↓ today</button>
      </div>

      {/* the permanent record — 17 weeks × 7 days */}
      <div className="mt-3 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3">
        <div className="grid gap-[3px]" style={{ gridTemplateRows: "repeat(7, 1fr)", gridTemplateColumns: `repeat(${MONDAYS.length}, 1fr)`, gridAutoFlow: "column" }}>
          {MONDAYS.flatMap((mon) =>
            Array.from({ length: 7 }, (_, d) => {
              const day = addDays(mon, d);
              const i = diffDays(SEASON_START, day);
              if (i < 1 || i > SEASON_DAYS) return <div key={day} className="aspect-square rounded-[2px]" />;
              const isToday = day === today;
              const isLevel = levelDays.has(day);
              return (
                <button key={day} onClick={() => setSel(day)}
                  className="aspect-square rounded-[2px]"
                  style={{
                    background: heatColor(day, i),
                    boxShadow: isToday ? "0 0 0 1.5px var(--neon)" : isLevel ? "0 0 0 1px var(--gold)" : undefined,
                  }} aria-label={day} />
              );
            })
          )}
        </div>
        <p className="text-[9px] text-[var(--text-4)] mt-2 mono">every day of the season · intensity = points · gold ring = level date</p>
      </div>

      {/* battle-pass rep track */}
      <div className="mt-3 rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3.5">
        <div className="flex items-baseline justify-between">
          <Eyebrow>Rep track</Eyebrow>
          <p className="mono text-xs text-[var(--text-2)]"><Num value={totalReps} className="font-bold text-[var(--foreground)]" />/{REP_TARGET}</p>
        </div>
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden mt-2">
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(100, (totalReps / REP_TARGET) * 100)}%`, background: "var(--neon)" }} />
        </div>
        <div className="grid grid-cols-5 gap-1.5 mt-2.5">
          {TIERS.map((t) => {
            const claimed = tiers.includes(t.at);
            const claimable = tiersLoaded && totalReps >= t.at && !claimed;
            return (
              <button key={t.at} onClick={() => claimable && claimTier(t.at)} disabled={!claimable || claimBusy}
                className={`rounded-lg border px-1 py-2 text-center transition-colors ${
                  claimed ? "border-[var(--neon)]/40 bg-[var(--neon)]/10"
                  : claimable ? "border-[var(--gold)] bg-[var(--gold)]/10 active:scale-95"
                  : "border-[var(--border-1)] bg-white/[0.02] opacity-45"}`}>
                <p className={`mono text-[11px] font-bold ${claimed ? "text-[var(--neon)]" : claimable ? "text-[var(--gold)]" : ""}`}>
                  {claimed ? "✓" : claimable ? "●" : t.at}
                </p>
                <p className="text-[8px] uppercase tracking-wider mt-0.5 opacity-70">{t.name}</p>
                {claimable && <p className="text-[8px] text-[var(--gold)] soft-pulse mt-0.5">claim</p>}
              </button>
            );
          })}
        </div>
        {claimErr && <p className="text-[10px] text-orange-400 mt-2">{claimErr}</p>}
      </div>

      {softErr && <p className="text-[10px] text-orange-400/80 mt-2">Deadlines/tiers couldn&apos;t refresh — the path below is still exact.</p>}

      {/* the path */}
      <div ref={wrapRef} className="relative mt-3">
        <svg viewBox={`0 0 ${VB_W} ${MAP_H}`} width="100%" style={{ display: "block" }}>
          {/* connectors: hairline for the whole season, indigo repaint up to today */}
          <polyline points={pathPts(1, SEASON_DAYS)} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="2" />
          {doneUpto >= 2 && <polyline points={pathPts(1, doneUpto)} fill="none" stroke="rgba(124,135,240,0.45)" strokeWidth="2" />}

          {/* week labels at each Monday */}
          {MONDAYS.map((mon, wi) => {
            const i = Math.max(1, diffDays(SEASON_START, mon));
            if (i > SEASON_DAYS) return null;
            return (
              <text key={mon} x={6} y={yOf(i) + 3} fontSize="8.5" fill="var(--text-4)"
                style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.08em" }}>
                WK {wi + 1} · {WEEK_LABELS[mon].toUpperCase()}
              </text>
            );
          })}

          {/* day nodes */}
          {Array.from({ length: SEASON_DAYS }, (_, k) => {
            const i = k + 1;
            const day = addDays(SEASON_START, i);
            const x = xOf(i), y = yOf(i);
            const isToday = day === today;
            const past = day < today;
            const fogged = i > nextLevelI && !isToday;
            const dayBosses = bossByDay.get(day) ?? [];
            const isLevel = levelDays.has(day);
            const s = past || isToday ? scoreOf(day) : null;

            let node: React.ReactNode;
            if (isToday) {
              const c = s!.core;
              const r = 15, circ = 2 * Math.PI * r;
              const b0 = dayBosses[0];
              const labelLeft = x > VB_W / 2;
              node = (
                <g>
                  <g className="soft-pulse">
                    <circle cx={x} cy={y} r={19} fill="var(--canvas)" stroke="var(--border-2)" strokeWidth="1" />
                    <circle cx={x} cy={y} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3.5" />
                    <circle cx={x} cy={y} r={r} fill="none" stroke="var(--ok)" strokeWidth="3.5" strokeLinecap="round"
                      strokeDasharray={`${(c / 5) * circ} ${circ}`} transform={`rotate(-90 ${x} ${y})`} />
                    <circle cx={x} cy={y} r={6} fill="var(--neon)" />
                    {/* on season day 1 the caption would clip above the viewBox — drop it below */}
                    <text x={x} y={i === 1 ? y + 32 : y - 26} fontSize="8" fill="var(--text-3)" textAnchor="middle"
                      style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.15em" }}>TODAY</text>
                  </g>
                  {/* a deadline DUE today must not vanish behind the today node */}
                  {b0 && (
                    <text x={labelLeft ? x - 24 : x + 24} y={y + 3} fontSize="8.5" fill="var(--bad)"
                      textAnchor={labelLeft ? "end" : "start"} style={{ fontFamily: "var(--font-mono)" }}>
                      ⬡ {b0.title.length > 14 ? b0.title.slice(0, 13) + "…" : b0.title}{dayBosses.length > 1 ? ` +${dayBosses.length - 1}` : ""} — due today
                    </text>
                  )}
                </g>
              );
            } else if (dayBosses.length > 0) {
              // boss hexagon — a deadline breaking the dot rhythm
              const b = dayBosses[0];
              const d2 = diffDays(today, day);
              const urgent = d2 >= 0 && d2 <= 7;
              const hp = b.stepsTotal > 0 ? b.stepsDone / b.stepsTotal : null;
              const hex = Array.from({ length: 6 }, (_, h) => {
                const a = (Math.PI / 3) * h - Math.PI / 2;
                return `${x + 10 * Math.cos(a)},${y + 10 * Math.sin(a)}`;
              }).join(" ");
              const labelLeft = x > VB_W / 2;
              const lx = labelLeft ? x - 16 : x + 16;
              node = (
                <g opacity={past && !isToday ? 0.5 : 1}>
                  <polygon points={hex} fill="var(--card)" stroke={urgent ? "var(--bad)" : "var(--warn)"} strokeWidth="1.5" />
                  <text x={x} y={y + 3} fontSize="8" textAnchor="middle" fill={urgent ? "var(--bad)" : "var(--warn)"} style={{ fontFamily: "var(--font-mono)" }}>!</text>
                  <text x={lx} y={y - 1} fontSize="8.5" fill="var(--text-2)" textAnchor={labelLeft ? "end" : "start"} style={{ fontFamily: "var(--font-mono)" }}>
                    {b.title.length > 18 ? b.title.slice(0, 17) + "…" : b.title}{dayBosses.length > 1 ? ` +${dayBosses.length - 1}` : ""}
                  </text>
                  <text x={lx} y={y + 9} fontSize="8" fill={urgent ? "var(--bad)" : "var(--text-4)"} textAnchor={labelLeft ? "end" : "start"} style={{ fontFamily: "var(--font-mono)" }}>
                    {d2 >= 0 ? `${d2}d out` : `${-d2}d past`}
                  </text>
                  {hp !== null && (
                    <g>
                      <rect x={labelLeft ? lx - 44 : lx} y={y + 13} width="44" height="3" rx="1.5" fill="rgba(255,255,255,0.1)" />
                      <rect x={labelLeft ? lx - 44 : lx} y={y + 13} width={44 * hp} height="3" rx="1.5" fill="var(--warn)" />
                    </g>
                  )}
                </g>
              );
            } else if (isLevel) {
              const reached = day <= today;
              const name = LEVEL_DATES.find((l) => l.date === day)?.name ?? "";
              node = (
                <g>
                  <rect x={x - 8} y={y - 8} width="16" height="16" rx="3" transform={`rotate(45 ${x} ${y})`}
                    fill={reached ? "var(--gold)" : "var(--canvas)"} stroke="var(--gold)" strokeWidth="1.5" />
                  <text x={x} y={y + 20} fontSize="8" fill="var(--gold)" textAnchor="middle" style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.08em" }}>
                    {name.toUpperCase()}
                  </text>
                </g>
              );
            } else if (past) {
              const col = s!.row.frozen ? "#38bdf8" : s!.core >= 3 ? "var(--neon)" : s!.total > 0 ? "rgba(251,191,36,0.55)" : "none";
              node = col === "none"
                ? <circle cx={x} cy={y} r={5.5} fill="none" stroke="rgba(248,113,113,0.4)" strokeWidth="1.5" />
                : <circle cx={x} cy={y} r={5.5} fill={col} />;
            } else {
              node = <circle cx={x} cy={y} r={5.5} fill="none" stroke="var(--border-2)" strokeWidth="1.5" />;
            }

            return (
              <g key={day} opacity={fogged ? 0.4 : 1}>
                {node}
                {/* generous invisible hit target */}
                <circle cx={x} cy={y} r={13} fill="transparent" onClick={() => setSel(day)} style={{ cursor: "pointer" }} />
              </g>
            );
          })}
        </svg>
      </div>

      {/* day detail — a tapped node answers "what happened / what's there" */}
      {sel && selInfo && (
        <div className="fixed left-3 right-3 z-20 rounded-xl border border-[var(--border-2)] bg-[var(--raised)] p-3.5"
          style={{ bottom: "max(5.5rem, calc(env(safe-area-inset-bottom) + 5rem))", animation: "fadeSlide 0.18s ease" }}>
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">
              {new Date(sel + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              <span className="mono text-[10px] text-[var(--text-4)] ml-2">day {diffDays(SEASON_START, sel)}/{SEASON_DAYS}</span>
            </p>
            <button onClick={() => setSel(null)} className="opacity-40 px-2 active:scale-90">✕</button>
          </div>
          {sel <= today ? (
            selInfo.row.frozen ? <p className="text-xs text-sky-300 mt-1.5">Freeze day — scored 0, streak survived.</p> : (
              <div className="flex items-center gap-3 mt-2">
                <p className="mono text-lg font-bold">{selInfo.total}<span className="text-[10px] text-[var(--text-4)]"> pts</span></p>
                <div className="flex gap-1">
                  {(["r", "b", "s", "bc", "l"] as const).map((k) => {
                    const on = coreParts(selInfo.row, selInfo.reps)[k];
                    return <span key={k} className={`w-5 h-5 rounded grid place-items-center text-[9px] font-black uppercase ${on ? "bg-[var(--ok)] text-black" : "bg-white/5 text-[var(--text-4)]"}`}>{k}</span>;
                  })}
                </div>
                {selInfo.reps > 0 && <p className="mono text-[10px] text-[var(--text-3)]">{selInfo.reps} rep{selInfo.reps === 1 ? "" : "s"}</p>}
              </div>
            )
          ) : <p className="text-xs text-[var(--text-3)] mt-1.5">{diffDays(today, sel)} days out.</p>}
          {selBosses.map((b) => (
            <p key={b.id} className="text-xs mt-1.5 text-[var(--warn)]">
              ⬡ {b.title}{b.stepsTotal > 0 ? <span className="mono"> · {b.stepsDone}/{b.stepsTotal} steps</span> : ""}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
