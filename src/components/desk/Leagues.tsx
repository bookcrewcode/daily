"use client";

// The leagues. Nine teams of five models, three tiers, one book each, and a
// season that ends with a champion the desk then copies. Everything on this
// screen is paper money and every word that could be jargon is explained
// where it sits, because the point is to learn how any of this works.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow, SectionTitle } from "../ui";
import TeamCard from "./TeamCard";
import LeagueSide from "./LeagueSide";
import LeagueSettings from "./LeagueSettings";
import { Note, TIER_COLOR, TIER_LABEL, dayLabel, daysSince, onDay, tierMeaning } from "./LeagueBits";
import {
  loadTeams, loadSeasons, loadDecisions, loadCouncils, loadTrades, loadRatings, loadStrategies, loadRosterLog, loadLatestEquity,
  callFn, LEAGUE_FN, fmtMoney, type Account, type CouncilRow, type DecisionRow, type EquityPoint, type Rating, type RosterLogRow,
  type SeasonRow, type StrategyRow, type TeamRow,
} from "@/lib/desk/api";
import { leagueSettings, TIERS, type TeamLike, type Tier } from "@/lib/desk/league";
import type { Trade } from "@/lib/desk/types";
import type { LiveMarks } from "./DeskSpace";

export default function Leagues({ uid, account, live, curve, today, onChanged }: {
  uid: string; account: Account; live: LiveMarks | null; curve: EquityPoint[]; today: string; onChanged: () => void;
}) {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [seasons, setSeasons] = useState<SeasonRow[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [councils, setCouncils] = useState<CouncilRow[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [ratings, setRatings] = useState<Rating[]>([]);
  const [strategies, setStrategies] = useState<StrategyRow[]>([]);
  const [log, setLog] = useState<RosterLogRow[]>([]);
  const [latest, setLatest] = useState<Record<string, { day: string; equity: number }>>({});
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [openTeam, setOpenTeam] = useState<string | null>(null);
  const [forming, setForming] = useState(false);
  const [formNote, setFormNote] = useState("");

  const load = useCallback(async () => {
    const [t, s, d, c, tr, r, g, l, e] = await Promise.all([
      loadTeams(uid),
      loadSeasons(uid),
      loadDecisions(uid, { sinceHours: 24, limit: 500 }),
      loadCouncils(uid, { limit: 40 }),
      loadTrades(uid, { ownerLike: "team:%", status: ["pending", "open"], limit: 500 }),
      loadRatings(uid),
      loadStrategies(uid),
      loadRosterLog(uid, 40),
      loadLatestEquity(uid),
    ]);
    setErr(t.error || s.error || d.error || c.error || tr.error || r.error || g.error || l.error || e.error);
    if (!t.error) setTeams(t.teams);
    if (!s.error) setSeasons(s.seasons);
    if (!d.error) setDecisions(d.decisions);
    if (!c.error) setCouncils(c.councils);
    if (!tr.error) setTrades(tr.trades);
    if (!r.error) setRatings(r.ratings);
    if (!g.error) setStrategies(g.strategies);
    if (!l.error) setLog(l.log);
    if (!e.error) setLatest(e.latest);
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function form() {
    if (forming) return;
    setForming(true); setFormNote("");
    const r = await callFn<Record<string, unknown>>(LEAGUE_FN, { mode: "form" }, 120_000);
    if (r.error) setFormNote(r.error);
    else {
      setFormNote("The teams are formed. Their first candidates come at the next five-minute tick.");
      await load();
      onChanged();
    }
    setForming(false);
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-32" /><div className="skeleton h-24 mt-3" /><div className="skeleton h-48 mt-3" /></div>;

  const settings = leagueSettings(account.league);
  const equityOf = (t: TeamRow) => live?.marks.find((m) => m.owner === `team:${t.id}`)?.equity ?? t.equity;
  const retOf = (t: TeamRow) => (t.start_equity > 0 ? (equityOf(t) - t.start_equity) / t.start_equity : 0);
  // Pool standing is worked out from percent returns; feed it the same live numbers this screen shows.
  const teamLikes: TeamLike[] = teams.map((t) => ({ id: t.id, frontier: t.frontier, workers: t.workers, status: t.status, return_pct: retOf(t) * 100, formed_at: t.formed_at }));

  const liveTeams = teams.filter((t) => t.status === "live");
  const running = seasons.find((s) => s.status === "running") ?? seasons[0] ?? null;
  const seasonDay = running ? Math.min(settings.season_days, daysSince(running.start_day, today) + 1) : 0;
  const champSeason = seasons.find((s) => s.champion_team);
  const champion = champSeason ? teams.find((t) => t.id === champSeason.champion_team) ?? null : null;
  const spentToday = decisions.filter((d) => onDay(d.created_at, today)).reduce((a, d) => a + d.cost_usd, 0);
  const readToday = decisions.filter((d) => onDay(d.created_at, today)).length;

  return (
    <div className="pt-3">
      {err && <button onClick={load} className="w-full mb-2 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">{err} — tap to retry</button>}

      {/* ── the rules, up front ─────────────────────────────────────── */}
      <Card>
        <Eyebrow className="mb-1.5">How the leagues work</Eyebrow>
        <div className="text-[11.5px] text-[var(--text-2)] leading-relaxed space-y-2">
          <p>
            Three leagues — Diamond, Gold and Bronze — with {settings.teams_per_tier} team{settings.teams_per_tier === 1 ? "" : "s"} in each. A team is one frontier model, which decides and barely does any of the brute work, and {settings.workers_per_team} worker models, which read every candidate, research it and vote take or pass. Every team has its own {fmtMoney(100000)} paper book.
          </p>
          <p>
            A team dies the moment its book touches {settings.death_pct}% below its start — {fmtMoney(100000 * (1 - settings.death_pct / 100))} — at any tick, not just at the close. Every day at the 16:06 New York cut the live teams are ranked by percent return: the top {settings.teams_per_tier} are Diamond, the next {settings.teams_per_tier} are Gold, the rest are Bronze, and the worst team in Bronze, if it has been alive at least a day, dies and is replaced by a new combination of models. No two teams, living or dead, may ever share the same set of members. It is a competition, and survival alone ranks nothing: a team that takes fewer than {settings.min_takes_day} trades in a day and keeps less than {settings.min_heat_pct}% of its book at risk is playing to survive; every such day docks {settings.passive_penalty_pct}% from its ranked return, it cannot climb that day, and it is cut before any active team.
          </p>
          <p>
            Each team is ruled by an oligarchy: the frontier and its two senior workers. Once a day the three of them vote on whether to kick a member. Two votes of the three remove someone, at most one member a day, and the replacement is pulled off the sideline.
          </p>
          <p>
            A season is {settings.season_days} days. At the last daily cut the team on top is the champion, and Ben&apos;s own desk mirrors it from then on. The news feed is shared by every team, so nobody wins on better information. The strategy books at the bottom are rule-only shadow books with no models in them at all: they are the baseline every team has to beat.
          </p>
          <p className="text-[var(--text-3)]">
            Percent return means the change in a team&apos;s book since the day that team was formed. Paper money throughout: there is no broker key anywhere in this app.
          </p>
        </div>
      </Card>

      {/* ── the season ──────────────────────────────────────────────── */}
      <Card className="mt-3">
        {running ? (
          <>
            <p className="text-[13px] font-semibold">
              Season {running.n} · day {seasonDay} of {settings.season_days} · started {dayLabel(running.start_day)}
            </p>
            <Note className="mt-1">The cut on {dayLabel(running.end_day)} crowns the champion. Until then every daily cut just re-sorts the tiers and kills the bottom of Bronze.</Note>
          </>
        ) : (
          <p className="text-[13px] font-semibold">No season has started yet.</p>
        )}
        {champion ? (
          <p className="text-[11.5px] text-[var(--text-2)] mt-2 leading-relaxed">
            <span className="mono text-[9px] uppercase tracking-widest text-[var(--neon)]">champion</span>{" "}
            {champion.name} took season {champSeason?.n}. The desk mirrors it: every trade that team opens, the desk opens too.
          </p>
        ) : (
          <Note className="mt-2">No champion yet, so the desk is taking nothing new. It starts mirroring the winner the moment a season ends.</Note>
        )}
        {settings.budget_usd_day > 0 && (
          <p className="mono text-[10px] text-[var(--text-4)] mt-2">
            today: {fmtMoney(spentToday, 2)} of {fmtMoney(settings.budget_usd_day, 0)} spent on model calls · {readToday} decision{readToday === 1 ? "" : "s"}
          </p>
        )}
        {liveTeams.length === 0 && (
          <div className="mt-3 pt-3 border-t border-[var(--border-1)]">
            <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed">
              No teams are alive. Forming deals {settings.teams_per_tier * 3} teams out of the pools: each frontier gets {settings.workers_per_team} workers, the sets are spread so no worker sits on every team, and every set is checked against every team that has ever existed so no combination repeats. Each one opens a fresh {fmtMoney(100000)} book.
            </p>
            <button onClick={form} disabled={forming} className="mt-2.5 rounded-lg bg-[var(--neon)] text-black text-xs font-bold px-4 py-2 active:scale-95 disabled:opacity-40">
              {forming ? "Forming…" : "Form the teams"}
            </button>
            {formNote && <p className="text-[11px] text-[var(--text-3)] mt-2">{formNote}</p>}
          </div>
        )}
      </Card>

      {/* ── the three tiers ─────────────────────────────────────────── */}
      {TIERS.map((tier: Tier) => {
        const rows = liveTeams.filter((t) => t.tier === tier).sort((a, b) => retOf(b) - retOf(a));
        return (
          <div key={tier}>
            <div className="flex items-baseline gap-2">
              <SectionTitle>{TIER_LABEL[tier]}</SectionTitle>
              <span className="mono text-[9px] uppercase tracking-widest" style={{ color: TIER_COLOR[tier] }}>
                {rows.length} team{rows.length === 1 ? "" : "s"}
              </span>
            </div>
            <Note className="px-1 mb-2">{tierMeaning(tier, settings.teams_per_tier)}</Note>
            {rows.length === 0 ? (
              <Card><Note>Nothing in this tier right now.</Note></Card>
            ) : (
              <div className="space-y-2">
                {rows.map((t, i) => (
                  <TeamCard key={t.id} uid={uid} team={t} rank={i + 1} live={live} settings={settings} today={today}
                    trades={trades} decisions={decisions} councils={councils} ratings={ratings}
                    expanded={openTeam === t.id} onToggle={() => setOpenTeam(openTeam === t.id ? null : t.id)} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <LeagueSide uid={uid} account={account} curve={curve} live={live} today={today} onChanged={onChanged}
        teams={teams} teamLikes={teamLikes} ratings={ratings} settings={settings} strategies={strategies} log={log} latest={latest} />

      <LeagueSettings key={JSON.stringify(account.league)} uid={uid} account={account} onSaved={() => { load(); onChanged(); }} />
    </div>
  );
}
