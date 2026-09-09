"use client";

// One team, opened up. Four ways to read it: its Book (what it is riding and
// everything it has closed), its Decisions (every candidate it read and what
// it said), its Council (who is on it, how each member is scoring, and every
// daily vote to kick one of them) and its Curve (the book's money over time,
// against the line where the team dies).

import { useCallback, useEffect, useState } from "react";
import { Segmented, Sparkline } from "../ui";
import TeamBook from "./TeamBook";
import TeamDecisions from "./TeamDecisions";
import { Member, MonoLabel, Note, dayLabel, tone } from "./LeagueBits";
import { loadEquity, fmtMoney, fmtPct, modelLabel, type CouncilRow, type EquityPoint, type Rating, type TeamRow } from "@/lib/desk/api";
import { deathLine, type LeagueSettings } from "@/lib/desk/league";
import type { Trade } from "@/lib/desk/types";
import type { LiveMarks } from "./DeskSpace";

type View = "book" | "decisions" | "council" | "curve";

export default function Team({ uid, team, live, trades, ratings, councils, settings, today }: {
  uid: string; team: TeamRow; live: LiveMarks | null; trades: Trade[]; ratings: Rating[]; councils: CouncilRow[]; settings: LeagueSettings; today: string;
}) {
  const [view, setView] = useState<View>("book");
  return (
    <div className="mt-3 pt-3 border-t border-[var(--border-1)] rise-in">
      <Segmented value={view} onChange={setView} options={[
        { key: "book", label: "Book" }, { key: "decisions", label: "Decisions" }, { key: "council", label: "Council" }, { key: "curve", label: "Curve" },
      ]} />
      <div key={view} className="tab-enter">
        {view === "book" && <TeamBook uid={uid} team={team} live={live} trades={trades} today={today} />}
        {view === "decisions" && <TeamDecisions uid={uid} team={team} />}
        {view === "council" && <TeamCouncil team={team} ratings={ratings} councils={councils} />}
        {view === "curve" && <TeamCurve uid={uid} team={team} settings={settings} live={live} />}
      </div>
    </div>
  );
}

/* ── who is on the team, how they score, and every vote to remove one ───── */

function TeamCouncil({ team, ratings, councils }: { team: TeamRow; ratings: Rating[]; councils: CouncilRow[] }) {
  const rated = new Map(ratings.map((r) => [r.model, r]));
  const seniors = team.workers.filter((w) => team.seniors.includes(w));
  const juniors = team.workers.filter((w) => !team.seniors.includes(w));
  const rows = councils.filter((c) => c.team_id === team.id);

  return (
    <div className="mt-3">
      <MonoLabel>The oligarchy</MonoLabel>
      <Note className="mt-1">
        Three of the five rule the team: the frontier and its two senior workers. Once a day they each say keep or kick about every other member. Two of the three votes remove someone, at most one member a day, and the replacement is pulled off the sideline. Nobody else on the team gets a say.
      </Note>

      <div className="mt-2.5 space-y-1.5">
        <MemberRow model={team.frontier} role="frontier" duty="Decides. It reads the workers&apos; votes and says take, pass, close or hold, and it sits on the council." r={rated.get(team.frontier) ?? null} />
        {seniors.map((m) => <MemberRow key={m} model={m} role="senior worker" duty="Reads every candidate, researches it and votes — and sits on the council." r={rated.get(m) ?? null} />)}
        {juniors.map((m) => <MemberRow key={m} model={m} role="worker" duty="Reads every candidate, researches it and votes. No council seat." r={rated.get(m) ?? null} />)}
      </div>
      <Note className="mt-2">
        Elo starts at 1500 for everyone and moves only when models on opposite sides of the same call are proved right or wrong against each other — above 1500 is a record of being right when someone else was wrong. Scored votes are the take-or-pass votes that have since been settled by what the setup actually did. Brier is the average squared gap between the confidence a model stated and what happened: 0 is perfect, 0.25 is what you get for saying fifty-fifty every time, above that is worse than guessing.
      </Note>

      <MonoLabel className="mt-4">Every council so far</MonoLabel>
      {rows.length === 0 ? (
        <Note className="mt-1">No council has sat yet. The first is at the daily cut.</Note>
      ) : (
        <div className="mt-1.5 space-y-2">
          {rows.map((c) => (
            <div key={c.id} className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-2.5">
              <div className="flex items-baseline gap-2">
                <span className="mono text-[10px] text-[var(--text-4)]">{dayLabel(c.day)}</span>
                <span className="text-[12px] font-semibold">
                  {c.kicked ? <>Kicked {modelLabel(c.kicked)}{c.replaced_by ? <> · in came {modelLabel(c.replaced_by)}</> : null}</> : "Nobody was kicked"}
                </span>
              </div>
              {c.reason && <p className="text-[11px] text-[var(--text-3)] mt-1 leading-snug">{c.reason}</p>}
              {c.votes.map((v, i) => (
                <div key={`${c.id}-${i}`} className="mt-1.5 pt-1.5 border-t border-[var(--border-1)]">
                  <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">{modelLabel(v.model)} · {v.role}</p>
                  {v.error ? <p className="text-[10.5px] text-orange-400 mt-0.5">It did not answer: {v.error}</p> : null}
                  {(v.votes ?? []).map((x, j) => (
                    <p key={j} className="text-[10.5px] leading-snug mt-0.5">
                      <span className="mono text-[9px] uppercase" style={{ color: x.vote === "kick" ? "var(--bad)" : "var(--ok)" }}>{x.vote}</span>{" "}
                      <span className="font-semibold">{modelLabel(x.member)}</span>
                      {x.reason ? <span className="text-[var(--text-3)]"> — {x.reason}</span> : null}
                    </p>
                  ))}
                </div>
              ))}
              <p className="mono text-[9px] text-[var(--text-4)] mt-1.5">the vote cost {fmtMoney(c.cost_usd, 2)} in model calls</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MemberRow({ model, role, duty, r }: { model: string; role: string; duty: string; r: Rating | null }) {
  const votes = r?.n_sits ?? 0;
  const right = r && votes > 0 ? r.n_sit_right / votes : null;
  return (
    <div className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <Member model={model} note={role} />
        <span className="mono text-[12px] font-bold ml-auto">{Math.round(r?.elo ?? 1500)}</span>
        <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">elo</span>
      </div>
      <p className="mono text-[10px] text-[var(--text-4)] mt-1">
        {votes} scored vote{votes === 1 ? "" : "s"} · right {right === null ? "—" : `${(right * 100).toFixed(0)}%`} · Brier {r?.brier === null || r?.brier === undefined ? "—" : r.brier.toFixed(2)}
      </p>
      <p className="text-[10px] text-[var(--text-4)] mt-0.5 leading-snug">{duty}</p>
      {votes > 0 && votes < 20 ? <p className="text-[10px] text-[var(--warn)] mt-0.5 leading-snug">Too few votes for any of this to mean much yet; about twenty before it does.</p> : null}
    </div>
  );
}

/* ── the book's money over time, and the line it dies on ────────────────── */

function TeamCurve({ uid, team, settings, live }: { uid: string; team: TeamRow; settings: LeagueSettings; live: LiveMarks | null }) {
  const [curve, setCurve] = useState<EquityPoint[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const r = await loadEquity(uid, `team:${team.id}`);
    setErr(r.error);
    if (!r.error) setCurve(r.curve);
    setLoaded(true);
  }, [uid, team.id]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const line = deathLine(team.start_equity, settings.death_pct);
  const equityNow = live?.marks.find((m) => m.owner === `team:${team.id}`)?.equity ?? team.equity;
  const ret = team.start_equity > 0 ? (equityNow - team.start_equity) / team.start_equity : 0;

  return (
    <div className="mt-3">
      {err && <button onClick={load} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">{err} — tap to retry</button>}
      {!loaded ? (
        <div className="skeleton h-16" />
      ) : curve.length >= 2 ? (
        <Sparkline series={[{ values: curve.map((p) => p.equity), color: "var(--neon)", width: 1.8 }]} goal={line} height={64} />
      ) : (
        <Note>The curve starts after the team&apos;s second 4pm mark. Right now the book is at {fmtMoney(equityNow)}.</Note>
      )}
      <Note className="mt-2">
        The dashed line is where this team dies: {fmtMoney(line)}, which is {settings.death_pct}% below the {fmtMoney(team.start_equity)} it started with. It is checked at every five-minute tick, not only at the close, so a team can die in the middle of an afternoon.
      </Note>
      <div className="grid grid-cols-3 gap-2 mt-2.5">
        <Cell label="Now" value={fmtMoney(equityNow)} />
        <Cell label="Return" value={fmtPct(ret)} color={tone(ret)} />
        <Cell label="Best it has been" value={fmtMoney(team.peak)} />
      </div>
      <Note className="mt-1.5">Return is the book&apos;s change since the day the team was formed, not since the season started — a team formed yesterday is judged on yesterday.</Note>
    </div>
  );
}

function Cell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-2">
      <p className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)]">{label}</p>
      <p className="mono text-[14px] font-bold leading-tight mt-0.5" style={color ? { color } : undefined}>{value}</p>
    </div>
  );
}
