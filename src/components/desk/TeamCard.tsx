"use client";

// One team's card in its tier: the frontier that decides, the crew every
// team shares, what its book is worth, how far it is from dying, and what it
// did today. Tapping it opens the whole team underneath — its book, its
// decisions, its crew and its curve.

import { Card } from "../ui";
import Team from "./Team";
import { Member, Note, TIER_COLOR, daysSince, onDay, pct1, tone } from "./LeagueBits";
import { fmtMoney, fmtPct, type DecisionRow, type Rating, type TeamRow } from "@/lib/desk/api";
import { deathLine, type LeagueSettings } from "@/lib/desk/league";
import type { Trade } from "@/lib/desk/types";
import type { LiveMarks } from "./DeskSpace";

const took = (d: DecisionRow) => d.outcome !== null && (d.outcome as Record<string, unknown>).taken === true;

export default function TeamCard({ uid, team, rank, live, settings, today, trades, decisions, ratings, expanded, onToggle }: {
  uid: string; team: TeamRow; rank: number; live: LiveMarks | null; settings: LeagueSettings; today: string;
  trades: Trade[]; decisions: DecisionRow[]; ratings: Rating[]; expanded: boolean; onToggle: () => void;
}) {
  const equity = live?.marks.find((m) => m.owner === `team:${team.id}`)?.equity ?? team.equity;
  const ret = team.start_equity > 0 ? (equity - team.start_equity) / team.start_equity : 0;
  const line = deathLine(team.start_equity, settings.death_pct);
  const away = equity > 0 ? (equity - line) / equity : 0;

  const mine = trades.filter((t) => t.owner === `team:${team.id}`);
  const dec = decisions.filter((d) => d.team_id === team.id && onDay(d.created_at, today));
  const reads = dec.filter((d) => d.kind === "candidate" || d.kind === "session");
  const taken = reads.filter(took).length;
  const passed = reads.length - taken;
  const closes = dec.filter((d) => d.kind === "close").length;
  const days = daysSince(team.formed_at, today);

  const passiveDays = Number(team.stats.passive_days) || 0;
  const rankScore = Number.isFinite(Number(team.stats.rank_score)) && team.stats.rank_score !== undefined ? Number(team.stats.rank_score) : ret * 100 - passiveDays * settings.passive_penalty_pct;

  return (
    <Card>
      <button onClick={onToggle} className="w-full text-left active:scale-[0.995]">
        <div className="flex items-baseline gap-2">
          <span className="mono text-[11px] font-bold w-4 shrink-0" style={{ color: TIER_COLOR[team.tier] }}>{rank}</span>
          <span className="text-[14px] font-bold flex-1 min-w-0 truncate">{team.name || "unnamed team"}</span>
          <span className="mono text-[14px] font-bold">{fmtMoney(equity)}</span>
          <span className="mono text-[12px] font-bold" style={{ color: tone(ret) }}>{fmtPct(ret)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mt-2 pl-6">
          <Member model={team.frontier} note="frontier · decides" />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 pl-6">
          {team.workers.map((m) => <Member key={m} model={m} note="crew" />)}
        </div>
        <Note className="mt-1 pl-6">The crew is shared by every team and researches every candidate once; only the frontier differs.</Note>

        <p className="mono text-[10px] text-[var(--text-3)] mt-2 pl-6 leading-relaxed">
          dies at {fmtMoney(line)} · {equity <= line ? "below the line" : `${pct1(away)} away`} · {mine.length} open · {days === 0 ? "formed today" : days === 1 ? "1 day alive" : `${days} days alive`}
        </p>
        <p className="mono text-[10px] text-[var(--text-4)] mt-0.5 pl-6">today: {taken} taken · {passed} passed · {closes} closed</p>
        {passiveDays > 0 && (
          <p className="mono text-[10px] mt-0.5 pl-6" style={{ color: "var(--warn)" }}>playing to survive: {passiveDays} passive day{passiveDays === 1 ? "" : "s"} · ranked at {rankScore >= 0 ? "+" : ""}{rankScore.toFixed(2)}% for the tiers</p>
        )}
        <Note className="mt-1 pl-6">
          {expanded ? "Tap to close." : "Tap for its book, its decisions, its crew and its curve."}
          {" "}Away is how far this book would have to fall from where it is now to hit the line.
        </Note>
      </button>
      {expanded && (
        <Team uid={uid} team={team} live={live} trades={mine} ratings={ratings} settings={settings} today={today} />
      )}
    </Card>
  );
}
