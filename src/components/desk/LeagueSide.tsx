"use client";

// Everything around the tiers: the crew every team shares and how each of its
// models is scoring, the frontier pool and each frontier's standing, the teams
// that have already died, Ben's own desk, the rule-only strategy books that
// every team is measured against, and the log of teams formed and lost.

import { Card, SectionTitle } from "../ui";
import Book from "./Book";
import { Member, Note, dayLabel, timeLabel, tone } from "./LeagueBits";
import { fmtMoney, fmtPct, modelLabel, type Account, type EquityPoint, type Rating, type RosterLogRow, type StrategyRow, type TeamRow } from "@/lib/desk/api";
import { poolStanding, type LeagueSettings, type TeamLike } from "@/lib/desk/league";
import { STRATEGIES } from "@/lib/desk/scan";
import type { LiveMarks } from "./DeskSpace";

const SHADOW_START = 100000;

export default function LeagueSide({ uid, account, curve, live, today, onChanged, teams, teamLikes, ratings, settings, strategies, log, latest }: {
  uid: string; account: Account; curve: EquityPoint[]; live: LiveMarks | null; today: string; onChanged: () => void;
  teams: TeamRow[]; teamLikes: TeamLike[]; ratings: Rating[]; settings: LeagueSettings; strategies: StrategyRow[]; log: RosterLogRow[];
  latest: Record<string, { day: string; equity: number }>;
}) {
  const rated = new Map(ratings.map((r) => [r.model, r]));
  const record = (m: string) => {
    const r = rated.get(m);
    const votes = r?.n_sits ?? 0;
    return `elo ${Math.round(r?.elo ?? 1500)} · ${votes} scored vote${votes === 1 ? "" : "s"}${r && votes > 0 ? ` · right ${((r.n_sit_right / votes) * 100).toFixed(0)}%` : ""} · Brier ${r?.brier === null || r?.brier === undefined ? "—" : r.brier.toFixed(2)}`;
  };

  // The crew as the live teams actually carry it; the settings until a team exists.
  const liveTeams = teams.filter((t) => t.status === "live");
  const crew = liveTeams[0]?.workers.length ? liveTeams[0].workers : settings.worker_pool;
  const frontiers = settings.frontier_pool.map((m) => ({
    model: m,
    leads: liveTeams.filter((t) => t.frontier === m).map((t) => t.name).filter(Boolean),
    lives: teams.filter((t) => t.frontier === m).length,
    standing: poolStanding(m, teamLikes),
  })).sort((a, b) => (b.standing ?? -999) - (a.standing ?? -999) || modelLabel(a.model).localeCompare(modelLabel(b.model)));

  const dead = teams.filter((t) => t.status === "dead").sort((a, b) => String(b.died_at ?? "").localeCompare(String(a.died_at ?? "")));
  const equityOf = (owner: string) => live?.marks.find((m) => m.owner === owner)?.equity ?? latest[owner]?.equity ?? SHADOW_START;

  return (
    <>
      <SectionTitle>The crew</SectionTitle>
      <Card>
        <Note>
          The same {crew.length} cheap models research every candidate once, for every team, and vote take or pass; only the frontier differs between teams. Elo starts at 1500 and rises when a worker is right where others were wrong. Scored votes are the votes that have since played out, and right is how often the side it voted for paid. Brier is how honest its confidence was: 0 is perfect, 0.25 is coin-flipping.
        </Note>
        <div className="mt-2.5 space-y-1.5">
          {crew.map((m) => (
            <div key={m} className="flex items-center gap-2 flex-wrap">
              <Member model={m} note="crew" />
              <span className="mono text-[9px] text-[var(--text-4)] w-full pl-1">{record(m)}</span>
            </div>
          ))}
        </div>
      </Card>

      <SectionTitle>The frontier pool</SectionTitle>
      <Card>
        <Note>
          Every strong model that leads a team, and how it is doing across every team it has led. Standing is the mean ranked return of those teams, living or dead; a frontier that has never led a team has no standing yet. Lives is how many teams it has led: a frontier whose team dies comes straight back with a new one.
        </Note>
        <div className="mt-2.5 space-y-1.5">
          {frontiers.map((f) => (
            <div key={f.model} className="flex items-center gap-2 flex-wrap">
              <Member model={f.model} note={f.leads.length ? `leads ${f.leads.join(", ")}` : "no team right now"} />
              <span className="mono text-[10.5px] font-semibold ml-auto" style={{ color: f.standing === null ? "var(--text-4)" : tone(f.standing) }}>
                {f.standing === null ? "no standing yet" : `${f.standing >= 0 ? "+" : ""}${f.standing.toFixed(2)}%`}
              </span>
              <span className="mono text-[9px] text-[var(--text-4)] w-full pl-1">{f.lives} {f.lives === 1 ? "life" : "lives"} · {record(f.model)}</span>
            </div>
          ))}
        </div>
      </Card>

      <SectionTitle>The graveyard</SectionTitle>
      <Card>
        <Note>Every team that has died, newest first. A dead team keeps its record, and its frontier comes straight back with a new life: a fresh {fmtMoney(SHADOW_START)} book and the next numeral after its name.</Note>
        {dead.length === 0 ? (
          <Note className="mt-2">Nobody has died yet.</Note>
        ) : (
          <div className="mt-2.5 space-y-2">
            {dead.map((t) => {
              const ret = t.start_equity > 0 ? (t.equity - t.start_equity) / t.start_equity : 0;
              return (
                <div key={t.id} className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12.5px] font-bold flex-1 min-w-0 truncate">{t.name || "unnamed team"}</span>
                    <span className="mono text-[11px] font-bold" style={{ color: tone(ret) }}>{fmtPct(ret)}</span>
                    <span className="mono text-[9px] text-[var(--text-4)]">{t.died_at ? dayLabel(t.died_at) : ""}</span>
                  </div>
                  <p className="text-[10.5px] text-[var(--text-3)] mt-1 leading-snug">
                    {modelLabel(t.frontier)} decided, on the shared crew.
                  </p>
                  <p className="text-[10.5px] text-[var(--text-4)] mt-0.5 leading-snug">
                    Finished at {fmtMoney(t.equity)}. {t.death_reason || "No reason was recorded."}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <SectionTitle>Your desk</SectionTitle>
      <Note className="px-1">
        Ben&apos;s own {fmtMoney(account.starting_equity)}. It takes nothing new until a champion exists, then mirrors the champion team trade for trade.
      </Note>
      <Book uid={uid} account={account} curve={curve} live={live} today={today} onRefresh={onChanged} />

      <SectionTitle>Strategy books</SectionTitle>
      <Card>
        <Note>
          Each coded strategy runs its own {fmtMoney(SHADOW_START)} book with no models in it at all: every setup the rule flags is taken at its own levels, every time. That is the baseline. A team only earns its keep by beating the rule it is reading. Twenty closed trades and a positive shrunk R earn a strategy more size; a losing rule sits a week on the bench and stops flagging setups.
        </Note>
        <div className="mt-2.5 space-y-1.5">
          {STRATEGIES.map((s) => {
            const st = strategies.find((x) => x.id === s.id);
            const equity = equityOf(`strat:${s.id}`);
            const pnl = equity - SHADOW_START;
            const stats = st?.stats ?? {};
            return (
              <div key={s.id} className="flex items-baseline gap-2 text-[11.5px]">
                <span className="font-semibold flex-1 min-w-0 truncate">{s.name}</span>
                <span className="mono text-[10px] text-[var(--text-4)] shrink-0">
                  {stats.n ?? 0} closed{stats.n && stats.shrunk_r !== undefined ? ` · R ${stats.shrunk_r >= 0 ? "+" : ""}${stats.shrunk_r.toFixed(2)}` : ""}
                  {st && st.size_mult !== 1 ? ` · size ×${st.size_mult}` : ""}{st?.benched_until ? ` · benched to ${st.benched_until.slice(5)}` : ""}
                </span>
                <span className="mono text-[11px] font-semibold shrink-0" style={{ color: tone(pnl) }}>{fmtMoney(equity)}</span>
              </div>
            );
          })}
        </div>
        <Note className="mt-2">Closed is how many of that rule&apos;s trades have finished. R is the average result per trade in units of what it risked, pulled toward zero while the sample is small so a lucky first week does not read as skill. Size is how much of a normal position the rule is currently allowed.</Note>
      </Card>

      <SectionTitle>The log</SectionTitle>
      <Card>
        <Note>Every team that was formed, died or came back, newest first: which team, what happened, and why.</Note>
        {log.length === 0 ? (
          <Note className="mt-2">Nothing has happened yet.</Note>
        ) : (
          <div className="mt-1.5">
            {log.map((x) => (
              // Rows from before the crew was shared may still carry the old actions; they are coloured, not renamed.
              <p key={x.id} className="text-[11px] leading-snug py-1.5 border-t border-[var(--border-1)]">
                <span className="mono text-[9px] text-[var(--text-4)]">{timeLabel(x.at)}</span>{" "}
                <span className="mono text-[9px] uppercase" style={{ color: ["cut", "died", "dead", "kick"].includes(x.action) ? "var(--bad)" : x.action === "notice" ? "var(--warn)" : "var(--text-4)" }}>{x.action}</span>{" "}
                <span className="font-semibold">{x.model ? modelLabel(x.model) : "—"}</span>
                {x.seat ? <span className="text-[var(--text-4)]"> ({x.seat})</span> : null}
                {x.replaced_by ? <> → {modelLabel(x.replaced_by)}</> : null}
                {x.reason ? <span className="text-[var(--text-3)]">: {x.reason}</span> : null}
              </p>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
