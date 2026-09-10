"use client";

// DecisionCard — one decision by one team, opened up. A team is a frontier model that
// decides on top of the crew every team shares; this card is the whole record of a
// single call: what was put in front of them, how each worker voted, what the frontier
// decided, and what the desk actually did with paper money. Three kinds share the card
// — a flagged setup, a session idea, and a close — and each one says in a line what it
// is. Every word of lingo is explained until Ben has learned it.

import { useEffect, useState } from "react";
import { Card } from "../ui";
import Ticket from "./Ticket";
import { Lingo } from "./Term";
import { fmtMoney, fmtPct, fmtPrice, fmtR, labTone, modelLabel, type Ballot, type DecisionRow, type TeamRow } from "@/lib/desk/api";
import type { Tier } from "@/lib/desk/league";
import { STRATEGIES } from "@/lib/desk/scan";

/* ── the shapes the desk writes into brief and outcome ─────────────────── */
type Reason = { label?: string; value?: string; ok?: boolean; core?: boolean };
type Setup = {
  symbol?: string; venue?: string; instrument?: string; side?: string; timeframe?: string;
  entry_ref?: number; stop?: number; target?: number; leverage_hint?: number; horizon_hours?: number; horizon_days?: number;
  score?: number; reasons?: Reason[]; invalidation?: string; strategy?: string;
};
type Proposal = {
  symbol?: string; venue?: string; side?: string; thesis?: string; catalyst?: string; wrong_if?: string;
  stop?: number; target?: number; horizon_days?: number; leverage?: number; confidence?: number; evidence?: string[]; model?: string;
};
type CloseTrade = { id?: string; symbol?: string; side?: string; entry_price?: number; stop?: number; target?: number; unrealized?: number; pnl_pct?: number };
type Brief = {
  setup?: Setup;
  strategy?: { name?: string; what?: string; why?: string; fails?: string };
  headlines?: string[]; macro?: string[];
  book?: { equity?: number; return_pct?: number; death_line?: number; distance_pct?: number; open?: string[] };
  regime?: string; record?: string;
  proposal?: Proposal; digest?: string[];
  trade?: CloseTrade; position_note?: string;
};
type Outcome = {
  taken?: boolean; trade_id?: string; reasons?: string[]; ticket?: Record<string, unknown>; pass_reason?: string;
  by?: string; result?: { won?: boolean; r?: number };
  requested?: boolean; stop?: number; target?: number; reason?: string;
};

/* ── words for the codes ───────────────────────────────────────────────── */
const TF: Record<string, string> = { scalp: "scalp · hours", swing: "swing · days", position: "position · weeks" };
const KIND_LABEL: Record<string, string> = { candidate: "candidate", session: "session idea", close: "close" };
const KIND_NOTE: Record<string, string> = {
  candidate: "A candidate is a setup the scan flagged; the crew votes once for every team, and each frontier decides for its own.",
  session: "A session idea is one the crew brought out of the news feed at a session; every frontier judged the same idea for its own team.",
  close: "A close is the frontier acting on a position the team already holds: closing it, or tightening its levels.",
};
const ACTION: Record<string, string> = { take: "take it", pass: "pass", close: "close it", tighten: "tighten it", hold: "hold" };
const BY: Record<string, string> = {
  workers: "the crew", frontier: "the frontier", budget: "the day's model budget",
  guardrail: "a desk rule", price: "the price check", hours: "the trading hours",
};
const TIER_NAME: Record<Tier, string> = { diamond: "Diamond", gold: "Gold", bronze: "Bronze" };
const TIER_COLOR: Record<Tier, string> = { diamond: "#7dd3fc", gold: "#fbbf24", bronze: "#d97706" };

const stratName = (id: string) => STRATEGIES.find((s) => s.id === id)?.name ?? id;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const has = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const px = (v: number | null | undefined) => (has(v) ? `$${fmtPrice(v)}` : "");

function ago(iso: string, now: number): string {
  const m = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!now || !Number.isFinite(m)) return "";
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/* ── the card ──────────────────────────────────────────────────────────── */
export default function DecisionCard({ decision, team, expanded, onToggle, showTeam }: {
  decision: DecisionRow; team?: TeamRow | null; expanded: boolean; onToggle: () => void; showTeam?: boolean;
}) {
  const [now, setNow] = useState(0);
  const [showTicket, setShowTicket] = useState(false);
  // The clock is read once, after mount, never during render, so a static build
  // and the phone that opens it agree. Deferred by a microtask because a bare
  // setState in an effect body is a lint error here.
  useEffect(() => { Promise.resolve().then(() => setNow(Date.now())); }, []);

  const d = decision;
  const brief = d.brief as Brief;
  const outcome = (d.outcome ?? {}) as Outcome;
  const verdict = d.verdict;
  const workers = d.ballots.filter((b) => b.role === "worker");
  const frontierBallot = d.ballots.find((b) => b.role === "frontier") ?? null;
  const answered = workers.filter((b) => !b.error).length;
  const takers = workers.filter((b) => !b.error && b.stance === "take").length;
  const setup = brief.setup ?? {};
  const proposal = brief.proposal ?? {};
  const state = String(d.status);
  const deciding = state === "launched" || state === "queued";
  const taken = outcome.taken === true;

  const status = deciding
    ? { text: "deciding", color: "var(--neon)" }
    : state === "failed"
      ? { text: "failed", color: "var(--bad)" }
      : d.kind === "close"
        ? (verdict?.action === "tighten" ? { text: "tightened", color: "var(--warn)" } : { text: "closed", color: "var(--bad)" })
        : taken ? { text: "taken", color: "var(--ok)" } : { text: "passed", color: "var(--text-4)" };

  const side = d.kind === "close" ? str(brief.trade?.side) : d.kind === "session" ? str(proposal.side) : str(setup.side);
  const strategyId = d.strategy || str(setup.strategy);
  const headBits = [
    side,
    d.kind === "candidate" && strategyId ? stratName(strategyId) : "",
    d.timeframe ? (TF[d.timeframe] ?? d.timeframe) : "",
  ].filter(Boolean).join(" · ");

  const summary: string[] = [];
  if (workers.length > 0) summary.push(`${takers} of ${answered || workers.length} said take`);
  if (verdict) summary.push(`${modelLabel(verdict.model)}: ${ACTION[verdict.action] ?? verdict.action}`);
  if (!taken && !deciding && d.kind !== "close" && str(outcome.by)) summary.push(`passed by ${BY[str(outcome.by)] ?? str(outcome.by)}`);
  const reasonLine = str(verdict?.reason) || str(outcome.pass_reason) || str(outcome.reason);
  const ticket = outcome.ticket ?? null;

  return (
    <Card>
      <button onClick={onToggle} className="w-full text-left active:scale-[0.995]">
        <div className="flex items-baseline gap-2">
          <span className="mono text-sm font-bold">{d.symbol || "—"}</span>
          {headBits && <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-4)] min-w-0 truncate">{headBits}</span>}
          <span className="flex-1" />
          <span className="mono text-[10px] font-semibold shrink-0" style={{ color: status.color }}>{status.text}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">{KIND_LABEL[d.kind] ?? d.kind}</span>
          {now > 0 && <span className="mono text-[9px] text-[var(--text-4)]">· {ago(d.created_at, now)}</span>}
          {showTeam && team && (
            <>
              <span className="mono text-[9px] text-[var(--text-4)]">· {team.name}</span>
              <span className="mono text-[8.5px] uppercase tracking-wider rounded px-1.5 py-0.5 border"
                style={{ color: TIER_COLOR[team.tier], borderColor: TIER_COLOR[team.tier] }}>
                {TIER_NAME[team.tier] ?? team.tier}
              </span>
            </>
          )}
        </div>
        {summary.length > 0 && <p className="text-[11.5px] text-[var(--text-2)] mt-1 leading-snug">{summary.join(" · ")}</p>}
        {reasonLine && <p className="text-[11px] text-[var(--text-3)] mt-0.5 leading-snug">{reasonLine}</p>}
      </button>

      {expanded && (
        <div className="mt-2.5 pt-2.5 border-t border-[var(--border-1)] rise-in space-y-3">
          <p className="text-[11px] text-[var(--text-3)] leading-snug">{KIND_NOTE[d.kind] ?? "One decision by one team."}</p>

          {d.kind === "candidate" && (
            <>
              <Block title="The setup" note="What the coded strategy saw. The core checks must all hold; the rest are confirmation.">
                {(setup.reasons ?? []).length === 0 && <Muted>The setup&apos;s checks were not kept with this decision.</Muted>}
                {[...(setup.reasons ?? []).filter((r) => r.core), ...(setup.reasons ?? []).filter((r) => !r.core)].map((r, i) => (
                  <p key={i} className="text-[11px] leading-snug">
                    <span className="mono text-[9px]" style={{ color: r.ok ? "var(--ok)" : "var(--bad)" }}>{r.ok ? "ok" : "no"}</span>{" "}
                    <span className="text-[var(--text-2)]"><Lingo text={str(r.label)} /></span> <span className="text-[var(--text-4)]">{r.value}</span>
                    {r.core ? null : <span className="mono text-[8px] text-[var(--text-4)]"> · confirmation</span>}
                  </p>
                ))}
                {(has(setup.entry_ref) || has(setup.stop) || has(setup.target)) && (
                  <p className="mono text-[10px] text-[var(--text-4)] mt-1">
                    {[px(setup.entry_ref) && `ref ${px(setup.entry_ref)}`, px(setup.stop) && `stop ${px(setup.stop)}`, px(setup.target) && `target ${px(setup.target)}`].filter(Boolean).join(" · ")}
                  </p>
                )}
                {str(setup.invalidation) && <p className="text-[11px] text-[var(--text-3)] mt-1"><span className="text-[var(--text-4)]">Wrong if:</span> <Lingo text={str(setup.invalidation)} /></p>}
                {str(brief.strategy?.what) && <p className="text-[11px] text-[var(--text-3)] mt-1">{brief.strategy?.name ? `${brief.strategy.name}: ` : ""}<Lingo text={str(brief.strategy?.what)} /></p>}
              </Block>

              <Block title="The crew" note="The same four cheap models for every team. Each reads the setup with the day's headlines, may look one thing up, and votes take or pass with a confidence that the target is hit before the stop. A worker may tighten the stop or target, never widen them.">
                {workers.length === 0 && <Muted>{deciding ? "Still coming in. Each worker answers in its own call, usually inside a minute." : "No worker ballots were kept."}</Muted>}
                <div className="space-y-1.5">{workers.map((b, i) => <BallotBox key={i} b={b} />)}</div>
              </Block>

              <FrontierBlock verdict={verdict} ballot={frontierBallot} deciding={deciding} />
              <OutcomeBlock outcome={outcome} taken={taken} ticket={ticket} showTicket={showTicket} onTicket={() => setShowTicket(!showTicket)} />
            </>
          )}

          {d.kind === "session" && (
            <>
              <Block title="The idea" note="A worker in the crew read the feed on its own and brought this. Nothing is sized until the frontier agrees.">
                <p className="mono text-[10px] text-[var(--text-4)]">
                  {[str(proposal.symbol) || d.symbol, str(proposal.side), str(proposal.venue), str(proposal.model) && modelLabel(str(proposal.model)),
                    has(proposal.confidence) ? `${(proposal.confidence * 100).toFixed(0)}% sure` : ""].filter(Boolean).join(" · ")}
                </p>
                {str(proposal.thesis) && <p className="text-[11.5px] leading-snug mt-1"><Lingo text={str(proposal.thesis)} /></p>}
                {str(proposal.catalyst) && <p className="text-[11px] text-[var(--text-3)] mt-0.5"><span className="text-[var(--text-4)]">What moves it:</span> <Lingo text={str(proposal.catalyst)} /></p>}
                {str(proposal.wrong_if) && <p className="text-[11px] text-[var(--text-3)] mt-0.5"><span className="text-[var(--text-4)]">Wrong if:</span> <Lingo text={str(proposal.wrong_if)} /></p>}
                <p className="mono text-[10px] text-[var(--text-4)] mt-1">
                  {[px(proposal.stop) && `stop ${px(proposal.stop)}`, px(proposal.target) && `target ${px(proposal.target)}`,
                    has(proposal.horizon_days) ? `${proposal.horizon_days} days` : "", has(proposal.leverage) && proposal.leverage > 1 ? `${proposal.leverage}x` : ""].filter(Boolean).join(" · ")}
                </p>
                {(proposal.evidence ?? []).length > 0 && (
                  <div className="mt-1.5">
                    <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-0.5">What it leaned on</p>
                    {(proposal.evidence ?? []).map((e, i) => <p key={i} className="text-[11px] text-[var(--text-3)] leading-snug">{e}</p>)}
                  </div>
                )}
                <p className="mono text-[9px] text-[var(--text-4)] mt-1.5">read {(brief.digest ?? []).length} headlines from the feed first</p>
                {workers.length > 0 && <div className="space-y-1.5 mt-2">{workers.map((b, i) => <BallotBox key={i} b={b} />)}</div>}
              </Block>
              <FrontierBlock verdict={verdict} ballot={frontierBallot} deciding={deciding} />
              <OutcomeBlock outcome={outcome} taken={taken} ticket={ticket} showTicket={showTicket} onTicket={() => setShowTicket(!showTicket)} />
            </>
          )}

          {d.kind === "close" && (
            <>
              <Block title="The position" note="A trade the team already has on. Unrealised means on paper and not yet banked; it moves until the trade is shut.">
                <p className="mono text-[10.5px] text-[var(--text-2)]">
                  {[str(brief.trade?.symbol) || d.symbol, str(brief.trade?.side), px(brief.trade?.entry_price) && `in at ${px(brief.trade?.entry_price)}`,
                    px(brief.trade?.stop) && `stop ${px(brief.trade?.stop)}`, px(brief.trade?.target) && `target ${px(brief.trade?.target)}`].filter(Boolean).join(" · ")}
                </p>
                {(has(brief.trade?.unrealized) || has(brief.trade?.pnl_pct)) && (
                  <p className="mono text-[10.5px] mt-0.5" style={{ color: (brief.trade?.unrealized ?? brief.trade?.pnl_pct ?? 0) >= 0 ? "var(--ok)" : "var(--bad)" }}>
                    {[has(brief.trade?.unrealized) ? `${brief.trade.unrealized >= 0 ? "+" : "-"}${fmtMoney(Math.abs(brief.trade.unrealized))} paper, not banked` : "",
                      has(brief.trade?.pnl_pct) ? fmtPct(brief.trade.pnl_pct) : ""].filter(Boolean).join(" · ")}
                  </p>
                )}
                {str(brief.position_note) && <p className="text-[11.5px] text-[var(--text-2)] leading-snug mt-1"><Lingo text={str(brief.position_note)} /></p>}
              </Block>
              <FrontierBlock verdict={verdict} ballot={frontierBallot} deciding={deciding} />
              <Block title="What the desk did" note="The frontier asks; the desk carries it out at the next real price, never at a price it wished for.">
                {outcome.requested === true && <p className="text-[11.5px] text-[var(--text-2)] leading-snug">The close is queued. It goes through at the next price the tape gives.</p>}
                {(has(outcome.stop) || has(outcome.target)) && (
                  <p className="mono text-[10.5px] text-[var(--text-2)]">
                    new levels: {[px(outcome.stop) && `stop ${px(outcome.stop)}`, px(outcome.target) && `target ${px(outcome.target)}`].filter(Boolean).join(" · ")}
                  </p>
                )}
                {!outcome.requested && !has(outcome.stop) && !has(outcome.target) && <Muted>Nothing was changed.</Muted>}
              </Block>
            </>
          )}

          <p className="mono text-[9px] text-[var(--text-4)]">{fmtMoney(d.cost_usd, 3)} of model calls</p>
        </div>
      )}
    </Card>
  );
}

/* ── pieces ────────────────────────────────────────────────────────────── */
function Block({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">{title}</p>
      {note && <p className="text-[11px] text-[var(--text-3)] leading-snug mt-0.5 mb-1.5">{note}</p>}
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-[var(--text-3)] leading-snug">{children}</p>;
}

function BallotBox({ b }: { b: Ballot }) {
  const tight = [
    has(b.stop) ? `stop ${fmtPrice(b.stop)}` : "",
    has(b.target) ? `target ${fmtPrice(b.target)}` : "",
    has(b.leverage) ? `${b.leverage}x` : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="rounded-lg bg-black/30 border border-[var(--border-1)] px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: labTone(b.model) }} />
        <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-3)] flex-1 min-w-0 truncate">{modelLabel(b.model)}</span>
        <span className="mono text-[9px] text-[var(--text-4)] shrink-0">{b.role === "frontier" ? "leads the team" : "crew"}</span>
        {b.error
          ? <span className="mono text-[10px] text-orange-400 shrink-0">no answer</span>
          : <span className="mono text-[10px] font-semibold shrink-0" style={{ color: b.stance === "take" ? "var(--ok)" : "var(--text-4)" }}>{b.stance} · {(b.confidence * 100).toFixed(0)}%</span>}
      </div>
      {b.error ? <p className="text-[10.5px] text-orange-400 mt-1 leading-snug">{b.error}</p> : (
        <>
          {b.thesis && <p className="text-[11.5px] leading-snug mt-1"><Lingo text={b.thesis} /></p>}
          {b.wrong_if && <p className="text-[11px] text-[var(--text-3)] mt-0.5 leading-snug"><span className="text-[var(--text-4)]">Wrong if:</span> <Lingo text={b.wrong_if} /></p>}
          {tight && <p className="mono text-[9px] text-[var(--text-4)] mt-1">it would use {tight}</p>}
          {b.tags.length > 0 && <p className="mono text-[9px] text-[var(--text-4)] mt-0.5">tags: {b.tags.join(", ")}</p>}
          {b.checked.length > 0 && <p className="text-[10.5px] text-[var(--text-4)] mt-0.5 leading-snug">Looked at: {b.checked.join(", ")}</p>}
        </>
      )}
    </div>
  );
}

function FrontierBlock({ verdict, ballot, deciding }: { verdict: DecisionRow["verdict"]; ballot: Ballot | null; deciding: boolean }) {
  if (!verdict && !ballot) {
    return (
      <Block title="The frontier" note="The frontier is the strong model that leads the team. It reads the ballots and decides; the desk works out the size from its risk number and the rules.">
        <Muted>{deciding ? "Not asked yet." : "The frontier was never asked: no worker said take and the setup scored too low, so there was nothing to decide."}</Muted>
      </Block>
    );
  }
  const asked = verdict ? [
    has(verdict.risk_pct) ? `asked to risk ${verdict.risk_pct.toFixed(1)}% of the book` : "",
    has(verdict.leverage) ? `${verdict.leverage}x` : "",
    has(verdict.stop) ? `stop ${fmtPrice(verdict.stop)}` : "",
    has(verdict.target) ? `target ${fmtPrice(verdict.target)}` : "",
  ].filter(Boolean).join(" · ") : "";
  return (
    <Block title="The frontier" note="The frontier is the strong model that leads the team. It reads the ballots and decides; the desk works out the size from its risk number and the rules, so no model ever picks its own size.">
      {verdict && (
        <>
          <p className="text-[11.5px] text-[var(--text-2)] leading-snug">
            <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-3)]">{modelLabel(verdict.model)}</span>{" "}
            said <span className="font-semibold">{ACTION[verdict.action] ?? verdict.action}</span>.
          </p>
          {verdict.reason && <p className="text-[11.5px] leading-snug mt-1"><Lingo text={verdict.reason} /></p>}
          {asked && <p className="mono text-[9px] text-[var(--text-4)] mt-1">{asked}</p>}
          {verdict.acting && <p className="text-[11px] text-[var(--warn)] mt-1 leading-snug">A stand-in decided because the frontier did not answer in time.</p>}
          {verdict.error && <p className="text-[11px] text-orange-400 mt-1 leading-snug">{verdict.error}</p>}
        </>
      )}
      {ballot && <div className="mt-1.5"><BallotBox b={ballot} /></div>}
    </Block>
  );
}

function OutcomeBlock({ outcome, taken, ticket, showTicket, onTicket }: {
  outcome: Outcome; taken: boolean; ticket: Record<string, unknown> | null; showTicket: boolean; onTicket: () => void;
}) {
  const result = outcome.result;
  return (
    <Block title="The outcome" note="What the desk actually did, and why. A team can want a trade and still not get it: the budget, a rule, the trading hours, or the price moving first will stop it.">
      {(outcome.reasons ?? []).map((r, i) => <p key={i} className="text-[11px] text-[var(--text-3)] leading-snug">{r}</p>)}
      {!taken && str(outcome.pass_reason) && <p className="text-[11.5px] text-[var(--text-2)] leading-snug mt-0.5"><Lingo text={str(outcome.pass_reason)} /></p>}
      {taken && ticket && (
        <div className="mt-1.5">
          <Ticket ticket={ticket} compact />
          <button onClick={onTicket} className="mono text-[10px] text-[var(--neon)] mt-1.5 active:scale-95">
            {showTicket ? "Hide the ticket" : "Show the whole ticket"}
          </button>
          {showTicket && <div className="mt-2 rise-in"><Ticket ticket={ticket} /></div>}
        </div>
      )}
      {result && has(result.r) && (
        <p className="text-[11.5px] text-[var(--text-3)] leading-snug mt-1.5">
          <span style={{ color: result.won ? "var(--ok)" : "var(--bad)" }}>{"The strategy's own book "}{result.won ? "won" : "lost"} this setup at {fmtR(result.r)}.</span>{" "}
          {"That book takes every setup the strategy flags, whatever the team decided, and it is what the ballots are scored against."}
        </p>
      )}
    </Block>
  );
}
