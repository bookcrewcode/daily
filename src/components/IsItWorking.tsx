"use client";

// 📈 Is it working? — the lead→lag proof.
// Get-rich and get-lean are the two hardest goals because the payoff is years
// out (Value Equation: huge Time Delay). The fix isn't more willpower — it's
// making the compound VISIBLE: your reps this month → the projected date you hit
// 190 and $1M, and exactly what to change to pull that date closer.

import { useCallback, useEffect, useState } from "react";
import { supabase, todayStr, dateStr } from "@/lib/supabase";
import { useGame } from "@/lib/useGameData";
import { SectionTitle, Card } from "./ui";

const LEAN_TARGET = 190;
const MILLION = 1_000_000;

function monthAgo(): string {
  const d = new Date(); d.setDate(d.getDate() - 30); return dateStr(d);
}

// linear-fit slope (units/day) of a small day-series, least squares on day index
function slopePerDay(points: { day: string; value: number }[]): number | null {
  if (points.length < 2) return null;
  const t0 = new Date(points[0].day + "T00:00:00").getTime();
  const xs = points.map((p) => (new Date(p.day + "T00:00:00").getTime() - t0) / 86400000);
  const ys = points.map((p) => p.value);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? null : num / den;
}

function fmtDate(daysOut: number): string {
  const d = new Date(); d.setDate(d.getDate() + Math.round(daysOut));
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
function fmtSpan(days: number): string {
  if (days <= 0) return "already there";
  const y = days / 365;
  return y < 1 ? `${Math.round(days / 30)} months` : `${y.toFixed(1)} years`;
}

export default function IsItWorking({ uid }: { uid: string }) {
  const game = useGame();
  const [bw, setBw] = useState<{ day: string; value: number }[]>([]);
  const [reps, setReps] = useState<{ liftDays: number; eatDays: number; tracked: number }>({ liftDays: 0, eatDays: 0, tracked: 0 });
  const [income, setIncome] = useState<{ weekRev: number; anyLogged: boolean }>({ weekRev: 0, anyLogged: false });
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    const since = monthAgo();
    const weekAgo = dateStr(new Date(Date.now() - 6 * 86400000));
    const [{ data: days, error: dErr }, { data: inc, error: iErr }] = await Promise.all([
      supabase.from("days").select("day,bodyweight,ws_lift,ws_eat").eq("user_id", uid).gte("day", since).order("day"),
      supabase.from("income_activities").select("day,kind,value").eq("user_id", uid).gte("day", weekAgo),
    ]);
    if (dErr) { setOffline(true); return; } // keep prior on a blip
    setOffline(false);
    const rows = days ?? [];
    setBw(rows.filter((r) => r.bodyweight != null).map((r) => ({ day: r.day as string, value: Number(r.bodyweight) })));
    setReps({
      liftDays: rows.filter((r) => r.ws_lift).length,
      eatDays: rows.filter((r) => r.ws_eat).length,
      tracked: rows.length,
    });
    if (!iErr) {
      const closes = (inc ?? []).filter((r) => r.kind === "close");
      setIncome({ weekRev: closes.reduce((s, r) => s + Number(r.value), 0), anyLogged: (inc ?? []).length > 0 });
    }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  // ── BODY projection: bodyweight trend → date to 190 ──
  const latest = bw.length ? bw[bw.length - 1].value : game.latestBodyweight;
  const bwSlope = slopePerDay(bw); // lb/day
  const liftPct = reps.tracked ? Math.round((reps.liftDays / reps.tracked) * 100) : 0;
  const eatPct = reps.tracked ? Math.round((reps.eatDays / reps.tracked) * 100) : 0;
  let bodyLine: React.ReactNode;
  if (latest == null) {
    bodyLine = <span className="opacity-60">Log your bodyweight a few times to project your date to {LEAN_TARGET}.</span>;
  } else if (bwSlope == null || Math.abs(bwSlope) < 0.002) {
    bodyLine = <>At <b>{latest} lb</b>, weight is basically flat. To move toward {LEAN_TARGET}, the lever is consistency: lift {liftPct}% / eat-clean {eatPct}% of days — push the lower one.</>;
  } else {
    const daysTo = (LEAN_TARGET - latest) / bwSlope;
    bodyLine = daysTo > 0 && daysTo < 3650
      ? <>At your current trend you reach <b className="text-[var(--neon)]">{LEAN_TARGET} lb around {fmtDate(daysTo)}</b> ({fmtSpan(daysTo)}). Lift {liftPct}% · eat {eatPct}% of days — raise the weak one and that date moves in.</>
      : <>Trend is heading the wrong way or too slow. The reps that fix it: lift ({liftPct}%) and eat-clean ({eatPct}%) — pick the lower and protect it this week.</>;
  }

  // ── MONEY projection: weekly revenue run-rate → date to $1M ──
  const start = Math.max(0, game.netWorth);
  const perYear = income.weekRev * 52;
  const daysToMillion = perYear > 0 ? ((MILLION - start) / perYear) * 365 : null;
  let moneyLine: React.ReactNode;
  if (start >= MILLION) {
    moneyLine = <>You&apos;re past $1M (${start.toLocaleString()}). Pick the next number and keep the reps up.</>;
  } else if (!income.anyLogged) {
    moneyLine = <span className="opacity-60">Log income reps in the Income Engine — your first close projects a date to $1M and every sale pulls it closer.</span>;
  } else if (daysToMillion == null || daysToMillion <= 0) {
    moneyLine = <>You&apos;re at ${start.toLocaleString()}. No revenue booked this week — the $1M line only moves when you sell. This week&apos;s reps are the lead measure.</>;
  } else if (daysToMillion >= 36500) {
    // upper-range guard (mirrors the body side): a tiny weekly run-rate projects
    // absurd century dates / overflows Date. Show the lever instead of a fake date.
    moneyLine = <>At ${income.weekRev.toLocaleString()}/wk that&apos;s many decades out — too slow to plan around. The lever is bigger weekly revenue: double it and the date jumps in hard.</>;
  } else {
    moneyLine = <>At ${income.weekRev.toLocaleString()}/wk (${perYear.toLocaleString()}/yr) on top of ${start.toLocaleString()}, you hit <b className="text-[var(--neon)]">$1M around {fmtDate(daysToMillion)}</b> ({fmtSpan(daysToMillion)}). Double weekly revenue → roughly halve the wait.</>;
  }

  return (
    <div>
      <SectionTitle>📈 Is it working?</SectionTitle>
      {offline && <p className="text-xs text-orange-400 mb-2">Showing last-loaded data — couldn&apos;t refresh.</p>}
      <p className="text-xs opacity-50 mb-2 -mt-1">Your reps, projected onto the two north stars. The point is to see the compound before it arrives.</p>

      <Card tone="neon">
        <p className="text-[10px] uppercase tracking-widest text-[var(--neon)]/80 mb-1">💪 Body → {LEAN_TARGET} lb</p>
        <p className="text-sm leading-relaxed">{bodyLine}</p>
      </Card>

      <Card tone="neon" className="mt-2">
        <p className="text-[10px] uppercase tracking-widest text-[var(--neon)]/80 mb-1">💰 Money → $1M</p>
        <p className="text-sm leading-relaxed">{moneyLine}</p>
      </Card>

      <p className="text-[10px] opacity-40 mt-2">Projections are straight-line from your recent trend — not a promise, a mirror. Change the reps, refresh, watch the date move.</p>
    </div>
  );
}
