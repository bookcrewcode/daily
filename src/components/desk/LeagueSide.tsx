"use client";

// Everything around the tiers: the models waiting on the sideline, the teams
// that have already died, Ben's own desk, the rule-only strategy books that
// every team is measured against, and the log of who came and went.

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
  const seated = new Set<string>();
  for (const t of teams) if (t.status === "live") { seated.add(t.frontier); for (const w of t.workers) seated.add(w); }

  const pool = [...new Set([...settings.frontier_pool, ...settings.worker_pool])];
  const sideline = pool.filter((m) => !seated.has(m)).map((m) => ({
    model: m,
    role: settings.frontier_pool.includes(m) && settings.worker_pool.includes(m) ? "frontier or worker pool" : settings.frontier_pool.includes(m) ? "frontier pool" : "worker pool",
    standing: poolStanding(m, teamLikes),
    r: rated.get(m) ?? null,
  })).sort((a, b) => (b.standing ?? -999) - (a.standing ?? -999) || modelLabel(a.model).localeCompare(modelLabel(b.model)));

  const dead = teams.filter((t) => t.status === "dead").sort((a, b) => String(b.died_at ?? "").localeCompare(String(a.died_at ?? "")));
  const equityOf = (owner: string) => live?.marks.find((m) => m.owner === owner)?.equity ?? latest[owner]?.equity ?? SHADOW_START;

  return (
    <>
      <SectionTitle>The sideline</SectionTitle>
      <Card>
        <Note>
          Every model in the pools that is not on a live team right now. When a team dies, or a council kicks someone, the replacement comes from here. Pool standing is the mean percent return of the teams a model has been on, living or dead — a frontier&apos;s teams count in full, a worker&apos;s at half, because a worker only votes. A model that has never been on a team has no standing yet.
        </Note>
        {sideline.length === 0 ? (
          <Note className="mt-2">Nobody is sitting out: every model in both pools is on a live team.</Note>
        ) : (
          <div className="mt-2.5 space-y-1.5">
            {sideline.map((s) => (
              <div key={s.model} className="flex items-center gap-2 flex-wrap">
                <Member model={s.model} note={s.role} />
                <span className="mono text-[10.5px] font-semibold ml-auto" style={{ color: s.standing === null ? "var(--text-4)" : tone(s.standing) }}>
                  {s.standing === null ? "no standing yet" : `${s.standing >= 0 ? "+" : ""}${s.standing.toFixed(2)}%`}
                </span>
                <span className="mono text-[9px] text-[var(--text-4)] w-full pl-1">
                  elo {Math.round(s.r?.elo ?? 1500)} · {s.r?.n_sits ?? 0} scored votes{s.r && s.r.n_sits > 0 ? ` · right ${((s.r.n_sit_right / s.r.n_sits) * 100).toFixed(0)}%` : ""} · Brier {s.r?.brier === null || s.r?.brier === undefined ? "—" : s.r.brier.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <SectionTitle>The graveyard</SectionTitle>
      <Card>
        <Note>Every team that has died, newest first. A dead team&apos;s set of members can never be used again, so the graveyard is also the list of combinations that are gone for good.</Note>
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
                    {modelLabel(t.frontier)} with {t.workers.map(modelLabel).join(", ") || "no workers"}
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
        <Note>Every seat that changed hands, newest first: which team, what happened, who left and who came in.</Note>
        {log.length === 0 ? (
          <Note className="mt-2">Nothing has changed hands yet.</Note>
        ) : (
          <div className="mt-1.5">
            {log.map((x) => (
              <p key={x.id} className="text-[11px] leading-snug py-1.5 border-t border-[var(--border-1)]">
                <span className="mono text-[9px] text-[var(--text-4)]">{timeLabel(x.at)}</span>{" "}
                <span className="mono text-[9px] uppercase" style={{ color: x.action === "cut" || x.action === "kick" ? "var(--bad)" : x.action === "notice" ? "var(--warn)" : "var(--text-4)" }}>{x.action}</span>{" "}
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
