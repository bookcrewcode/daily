"use client";

// Journal — everything the leagues did, on the record. Decisions: every
// candidate the teams read, every session and every close, with the reason a
// team passed sitting next to the reason another took it. Trades: the ones
// that became real positions, each on its chart, with everything it used and
// why, the crew's ballots, where it stands or what happened, and its micro
// review. Every row is one plain sentence written by code from the record, and every
// opened entry leads with the whole thing in short. Paper money on every line; every
// label explained where it sits.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow, Pill, Segmented } from "../ui";
import DecisionCard from "./DecisionCard";
import { oneLine } from "./Plain";
import TradeCard, { TIER_COLOR, TierChip } from "./TradeCard";
import { loadTeams, loadDecisions, loadTrades, callFn, REVIEW_FN, type DecisionRow, type TeamRow } from "@/lib/desk/api";
import { strategyName } from "@/lib/desk/scan";
import type { Trade } from "@/lib/desk/types";
import type { LiveMarks } from "./DeskSpace";

type View = "decisions" | "trades";
type Kind = "all" | "taken" | "passed" | "closes" | "sessions";
type TradeFilter = "all" | "running" | "closed";

const KINDS: Kind[] = ["all", "taken", "passed", "closes", "sessions"];
const KIND_HELP: Record<Kind, string> = {
  all: "Everything the teams were asked and answered in the last three days, newest first.",
  taken: "The decisions that became a real paper position.",
  passed: "The candidates, session ideas and own-playbook ideas a team looked at and did not act on. The reason is recorded either way.",
  closes: "A frontier asking to close a position early, before its stop, target or clock.",
  sessions: "The scheduled reviews, three times a trading day: a team's open positions, the crew's new ideas, and the trades the frontier came up with on its own.",
};
const TF: Record<string, string> = { scalp: "scalp · hours", swing: "swing · days", position: "position · weeks" };
const stratName = (id?: string) => (id ? strategyName(id) : "");
const asText = (v: unknown) => (typeof v === "string" ? v : "");
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const fmtRr = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

// What became of a decision. The column is written by the league function, so
// read it defensively: taken or not, who or what passed it, and — once the
// setup has played out — how the rule alone would have done.
type Outcome = { taken: boolean; by: string; result: { r: number | null; won: boolean | null } | null };
function outcomeOf(d: DecisionRow): Outcome {
  const o = (d.outcome ?? {}) as Record<string, unknown>;
  const raw = o.result;
  const res = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const rn = res ? Number(res.r) : NaN;
  const r = Number.isFinite(rn) ? rn : null;
  const won = res ? (typeof res.won === "boolean" ? res.won : r === null ? null : r > 0) : null;
  const reasons = Array.isArray(o.reasons) ? (o.reasons as unknown[]).map(asText).filter((s) => s.length > 0) : [];
  const by = [o.by, o.reason, o.pass_reason, o.why, reasons[0]].map(asText).find((s) => s.length > 0) ?? "";
  return { taken: o.taken === true, by, result: res ? { r, won } : null };
}
function ruleLine(r: { r: number | null; won: boolean | null }): string {
  if (r.won === true) return `the rule won${r.r === null ? "" : ` ${fmtRr(r.r)}`}`;
  if (r.won === false) return `the rule lost${r.r === null ? "" : ` ${fmtRr(r.r)}`}`;
  return "";
}
// The brief is free-form json; the side may sit at the top or inside the setup.
function briefStr(b: Record<string, unknown>, key: string): string {
  const v = b[key];
  if (typeof v === "string") return v;
  const setup = b.setup;
  if (setup && typeof setup === "object" && !Array.isArray(setup)) {
    const w = (setup as Record<string, unknown>)[key];
    if (typeof w === "string") return w;
  }
  return "";
}

export default function Journal({ uid, live }: { uid: string; live: LiveMarks | null }) {
  const [view, setView] = useState<View>("decisions");
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [now, setNow] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [teamSel, setTeamSel] = useState("all");
  const [byCandidate, setByCandidate] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tradeFilter, setTradeFilter] = useState<TradeFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewErr, setReviewErr] = useState("");

  const load = useCallback(async () => {
    const [tm, dc, tr] = await Promise.all([
      loadTeams(uid),
      loadDecisions(uid, { sinceHours: 72, limit: 400 }),
      loadTrades(uid, { ownerLike: "team:%", limit: 200 }),
    ]);
    if (!tm.error) setTeams(tm.teams);
    if (!dc.error) setDecisions(dc.decisions);
    if (!tr.error) setTrades(tr.trades);
    setErr(tm.error || dc.error || tr.error);
    setNow(Date.now());
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function review(id: string, force: boolean) {
    if (busy) return;
    setBusy(id); setReviewErr("");
    const r = await callFn<{ review?: Record<string, unknown> }>(REVIEW_FN, { mode: "postmortem", trade_id: id, force }, 150_000);
    if (r.error) setReviewErr(r.error); else await load();
    setBusy(null);
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-14" /><div className="skeleton h-48 mt-3" /></div>;

  const teamById = new Map(teams.map((t) => [t.id, t]));
  const decisionById = new Map(decisions.map((d) => [d.id, d]));
  const teamOf = (owner: string) => teamById.get(owner.replace(/^team:/, "")) ?? null;

  const matchesKind = (d: DecisionRow) => {
    const o = outcomeOf(d);
    if (kind === "taken") return o.taken;
    if (kind === "passed") return d.kind !== "close" && !o.taken;
    if (kind === "closes") return d.kind === "close";
    if (kind === "sessions") return d.kind === "session" || d.kind === "own";
    return true;
  };
  const shownDecisions = decisions.filter((d) => matchesKind(d) && (teamSel === "all" || d.team_id === teamSel));
  const takenCount = decisions.filter((d) => outcomeOf(d).taken).length;
  const passedCount = decisions.filter((d) => d.kind !== "close" && !outcomeOf(d).taken).length;
  const liveTeams = teams.filter((t) => t.status === "live").length;

  // One card per candidate: the same setup, every team that read it, side by side.
  const groups: { setup: string; rows: DecisionRow[] }[] = [];
  if (byCandidate) {
    const index = new Map<string, number>();
    for (const d of shownDecisions) {
      if (d.kind !== "candidate" || !d.setup_id) continue;
      const at = index.get(d.setup_id);
      if (at === undefined) { index.set(d.setup_id, groups.length); groups.push({ setup: d.setup_id, rows: [d] }); }
      else groups[at].rows.push(d);
    }
  }

  const shownTrades = trades.filter((t) => (tradeFilter === "all" ? true : tradeFilter === "running" ? t.status === "open" || t.status === "pending" : t.status === "closed"));
  const closedTrades = trades.filter((t) => t.status === "closed");
  const neverFilled = trades.filter((t) => t.status === "cancelled").length;
  const reviewed = closedTrades.filter((t) => !!asText(t.review?.text)).length;

  return (
    <div className="pt-3">
      <Segmented value={view} onChange={setView} options={[{ key: "decisions", label: "Decisions" }, { key: "trades", label: "Trades" }]} />

      {err && <button onClick={load} className="w-full mt-3 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">{err} — tap to retry</button>}

      {view === "decisions" ? (
        <>
          <Card className="mt-3">
            <Eyebrow>Every decision, on the record</Eyebrow>
            <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed mt-1.5">
              A decision is one moment a team was asked something and answered in writing. The crew, the same four cheap worker models for every team, reads the brief once and votes; the frontier model that leads each team decides for itself. Nothing here is real money.
            </p>
            <ul className="text-[11.5px] text-[var(--text-2)] leading-relaxed mt-2 space-y-1">
              <li><span className="mono text-[10px] text-[var(--neon)]">candidate</span> — a setup the scan found, put to every team: take it or pass.</li>
              <li><span className="mono text-[10px] text-[var(--neon)]">session</span> — a scheduled look at the positions the team already holds and the crew&apos;s new ideas, three times a trading day.</li>
              <li><span className="mono text-[10px] text-[var(--neon)]">close</span> — the frontier asking to end a position early, before its stop, target or clock.</li>
            </ul>
            <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed mt-2">
              A pass is written down with its reason, exactly like a take. The trades a team refused teach as much as the ones it made. Each row is the decision in one plain sentence; open it for the whole thing in short, then the record underneath.
            </p>
            <p className="mono text-[10px] text-[var(--text-4)] mt-2">{decisions.length} decisions in the last 3 days · {takenCount} taken · {passedCount} passed · {liveTeams} teams alive</p>
          </Card>

          <div className="flex items-center gap-1.5 mt-3 overflow-x-auto no-scrollbar pb-1">
            {KINDS.map((k) => <Pill key={k} active={kind === k} onClick={() => setKind(k)}>{k}</Pill>)}
          </div>
          <p className="text-[10px] text-[var(--text-4)] leading-relaxed mt-0.5">{KIND_HELP[kind]}</p>

          {teams.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 mt-2 overflow-x-auto no-scrollbar pb-1">
                <Pill active={teamSel === "all"} onClick={() => setTeamSel("all")}>all teams</Pill>
                {teams.map((tm) => (
                  <Pill key={tm.id} active={teamSel === tm.id} onClick={() => setTeamSel(tm.id)}>
                    <span className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: TIER_COLOR[tm.tier] ?? "var(--text-4)" }} />
                      {tm.name}{tm.status === "dead" ? " (dead)" : ""}
                    </span>
                  </Pill>
                ))}
              </div>
              <p className="text-[10px] text-[var(--text-4)] leading-relaxed mt-0.5">A team is one frontier model that decides; every team shares the same crew of four workers that read and vote. The dot is its league: Diamond, Gold or Bronze.</p>
            </>
          )}

          <div className="flex items-center gap-1.5 mt-2">
            <Pill active={byCandidate} onClick={() => { setByCandidate(!byCandidate); setOpenId(null); }}>By candidate</Pill>
            <span className="text-[10px] text-[var(--text-4)] leading-snug">One card per setup, with every team that read it beside each other.</span>
          </div>

          {byCandidate ? (
            groups.length === 0 ? (
              <Card className="mt-2"><p className="text-[12px] text-[var(--text-3)] leading-relaxed">No candidates here. By candidate only groups the setups the scan put to the teams; switch the filter above back to all, taken or passed to see them.</p></Card>
            ) : (
              <div className="mt-2 space-y-2">
                {groups.map((g) => {
                  const first = g.rows[0];
                  const side = briefStr(first.brief, "side");
                  return (
                    <Card key={g.setup}>
                      <div className="flex items-baseline gap-2">
                        <span className="mono text-sm font-bold">{first.symbol || "the setup"}</span>
                        <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-4)] truncate">{side}{first.strategy ? ` · ${stratName(first.strategy)}` : ""}{first.timeframe ? ` · ${TF[first.timeframe] ?? first.timeframe}` : ""}</span>
                        <span className="flex-1" />
                        <span className="mono text-[9px] text-[var(--text-4)] shrink-0">{when(first.created_at)}</span>
                      </div>
                      <p className="text-[10px] text-[var(--text-4)] leading-relaxed mt-1">{g.rows.length} team{g.rows.length === 1 ? "" : "s"} read this one. Tap a team to see its whole decision.</p>
                      {g.rows.map((d) => {
                        const team = teamById.get(d.team_id) ?? null;
                        const o = outcomeOf(d);
                        return (
                          <div key={d.id} className="border-t border-[var(--border-1)] mt-1.5 pt-1.5">
                            <button onClick={() => setOpenId(openId === d.id ? null : d.id)} className="w-full text-left active:scale-[0.995]">
                              <div className="flex items-center gap-1.5">
                                <span className="mono text-[11px] font-semibold truncate">{team?.name || "a team"}</span>
                                <TierChip tier={team?.tier} />
                                <span className="flex-1" />
                                <span className="mono text-[9.5px] shrink-0" style={{ color: o.taken ? "var(--ok)" : "var(--text-4)" }}>{o.taken ? "taken" : o.by ? `passed: ${o.by}` : "passed"}</span>
                              </div>
                              <p className="text-[11px] text-[var(--text-2)] leading-snug mt-0.5 line-clamp-3">{oneLine(d, team)}</p>
                              {o.result && ruleLine(o.result) && (
                                <p className="mono text-[10px] mt-0.5" style={{ color: o.result.won ? "var(--ok)" : "var(--bad)" }}>{ruleLine(o.result)}</p>
                              )}
                            </button>
                            {openId === d.id && <div className="mt-1.5 rise-in"><DecisionCard decision={d} team={team} expanded onToggle={() => setOpenId(null)} /></div>}
                          </div>
                        );
                      })}
                      <p className="text-[10px] text-[var(--text-4)] leading-relaxed mt-1.5">Each line is how the shared crew voted, once, for every team, and what that team&apos;s frontier did with the vote; each frontier still decides alone. The rule line is what the strategy would have done with no team at all, so a pass that dodged a loss reads as plainly as a take that won.</p>
                    </Card>
                  );
                })}
              </div>
            )
          ) : shownDecisions.length === 0 ? (
            <Card className="mt-2"><p className="text-[12px] text-[var(--text-3)] leading-relaxed">Nothing here yet. The teams write a decision every time the scan hands them a candidate inside trading hours, at every session and at every close.</p></Card>
          ) : (
            <div className="mt-2 space-y-2">
              {shownDecisions.map((d) => (
                <DecisionCard key={d.id} decision={d} team={teamById.get(d.team_id) ?? null} showTeam expanded={openId === d.id} onToggle={() => setOpenId(openId === d.id ? null : d.id)} />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <Card className="mt-3">
            <Eyebrow>The trades the teams took</Eyebrow>
            <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed mt-1.5">
              Every decision that became a real position, newest first. Open one for the trade on its chart, everything that went into it and why each piece mattered, what the crew said and what the frontier decided; while it runs, where it stands at live prices; once it closes, what happened and whether the reasoning held apart from the money. Paper money only — that is the point of the first hundred trades.
            </p>
            <p className="mono text-[10px] text-[var(--text-4)] mt-2">{trades.length} trades · {closedTrades.length} closed · {reviewed} reviewed{neverFilled ? ` · ${neverFilled} never filled` : ""}</p>
          </Card>

          <div className="flex items-center gap-1.5 mt-3 overflow-x-auto no-scrollbar pb-1">
            {(["all", "running", "closed"] as TradeFilter[]).map((f) => <Pill key={f} active={tradeFilter === f} onClick={() => setTradeFilter(f)}>{f}</Pill>)}
          </div>
          <p className="text-[10px] text-[var(--text-4)] leading-relaxed mt-0.5">Running means queued or already open; closed means finished and counted. All also shows the orders that never filled, because the price the team wanted never came.</p>

          {reviewErr && <p className="text-[11px] text-orange-400 mt-2">{reviewErr}</p>}

          {shownTrades.length === 0 ? (
            <Card className="mt-2"><p className="text-[12px] text-[var(--text-3)] leading-relaxed">Nothing here yet. The first candidate a frontier decides to take lands its trade here with the whole team&apos;s reasoning attached.</p></Card>
          ) : (
            <div className="mt-2 space-y-2">
              {shownTrades.map((t) => (
                <TradeCard key={t.id} trade={t} team={teamOf(t.owner)} decision={decisionById.get(t.proposal_id) ?? null} live={live} now={now} busy={busy === t.id} onReview={review} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
