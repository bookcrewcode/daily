"use client";

// TradeCard — one team's trade, told as a lesson. Why it was taken (the thesis), the
// trade drawn on the chart with its entry, stop and target, everything that went into
// it and why each piece mattered, what the crew said and what the frontier decided, the
// whole ticket, where it stands at live prices while it runs, what happened when it
// closed, and the micro review that judges the reasoning apart from the money. The
// collapsed row is one plain sentence and the opened card leads with the whole trade in
// short, both written by code from the record. Paper money, said plainly; every word of
// lingo explained until Ben has learned it.

import { useState } from "react";
import { Card } from "../ui";
import Chart from "./Chart";
import Ticket from "./Ticket";
import TradeInputs, { TeachBlock, teachOf } from "./TradeInputs";
import { Lingo, Term } from "./Term";
import { InShort, NewsList, newsOf, tradeInShort, tradeOneLine } from "./Plain";
import { fmtMoney, fmtPct, fmtPrice, fmtR, modelLabel, labTone, type DecisionRow, type TeamRow } from "@/lib/desk/api";
import { unrealized } from "@/lib/desk/ledger";
import { STRATEGIES } from "@/lib/desk/scan";
import { templateName } from "@/lib/desk/playbook";
import type { Tier } from "@/lib/desk/league";
import type { Trade } from "@/lib/desk/types";
import type { LiveMarks } from "./DeskSpace";

type Interval = "5m" | "15m" | "1h" | "4h" | "1d";

// Diamond, Gold, Bronze — the three leagues. The chip is the only place the
// tier is said, so it carries its own colour and its own word.
export const TIER_COLOR: Record<string, string> = { diamond: "#7dd3fc", gold: "#fbbf24", bronze: "#d97706" };
export function TierChip({ tier }: { tier?: Tier | string | null }) {
  const c = TIER_COLOR[String(tier ?? "")];
  if (!c) return null;
  return <span className="mono text-[8.5px] uppercase tracking-widest px-1.5 py-[1px] rounded shrink-0" style={{ color: c, background: `${c}22` }}>{tier}</span>;
}

const EXIT: Record<string, string> = { stop: "stopped out", target: "hit the target", time: "the clock ran out", thesis_broke: "the frontier closed it", liquidated: "liquidated", halt: "halted", cancelled: "never filled" };
const QUADRANT: Record<string, string> = { earned: "earned it: good process, good outcome", bad_luck: "bad luck: good process, bad outcome", dumb_luck: "dumb luck: bad process, good outcome", deserved: "deserved: bad process, bad outcome" };
const TF: Record<string, string> = { scalp: "scalp · hours", swing: "swing · days", position: "position · weeks" };
const STATUS: Record<string, string> = { pending: "queued", open: "running", closed: "closed", cancelled: "never filled" };
const FILL: Record<string, string> = { next_5m: "fills on the next 5-minute bar", next_hour: "fills on the next hourly candle" };

const stratName = (id?: string) => (id ? STRATEGIES.find((s) => s.id === id)?.name ?? id : "");
const tone = (v: number) => (v > 0 ? "var(--ok)" : v < 0 ? "var(--bad)" : "var(--text-3)");
const signed = (v: number, d = 0) => (v >= 0 ? "+" : "-") + fmtMoney(Math.abs(v), d);
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const hoursBetween = (a: string | null, b: string | null) => (a && b ? (Date.parse(b) - Date.parse(a)) / 3_600_000 : null);
const asText = (v: unknown) => (typeof v === "string" ? v : "");
const intervalFor = (tf?: string): Interval => (tf === "scalp" ? "15m" : tf === "position" ? "1d" : "1h");
const dur = (h: number) => (h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)} days`);
const away = (mark: number, level: number) => `${Math.abs(((level - mark) / mark) * 100).toFixed(1)}% ${level >= mark ? "above" : "below"} here`;

// When the trade runs out of time: the hours clock a scalp was given, the day
// it expires, or the days it was written for. Empty when nothing says.
function clockLeft(t: Trade, now: number): string {
  const start = Date.parse(t.entry_at ?? t.decided_at);
  let end: number | null = null;
  if (t.horizon_hours && Number.isFinite(start)) end = start + t.horizon_hours * 3_600_000;
  else if (t.expires_on) end = Date.parse(`${t.expires_on}T20:00:00Z`);
  else if (t.horizon_days && Number.isFinite(start)) end = start + t.horizon_days * 86_400_000;
  if (end === null || !Number.isFinite(end)) return "";
  const ms = end - now;
  return ms <= 0 ? "the clock is up: it closes at the next check" : `${dur(ms / 3_600_000)} left on the clock`;
}

export default function TradeCard({ trade: t, team, decision, live, now, busy, onReview }: {
  trade: Trade; team?: TeamRow | null; decision?: DecisionRow | null; live: LiveMarks | null; now: number; busy: boolean; onReview: (id: string, force: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [chart, setChart] = useState(true);
  const [whole, setWhole] = useState(false);

  const review = t.review ?? {};
  const text = asText(review.text), whatHappened = asText(review.what_happened), why = asText(review.why);
  const verdict = asText(review.verdict), grade = asText(review.grade), quadrant = asText(review.quadrant), lesson = asText(review.lesson);
  const tags = Array.isArray(review.tags) ? (review.tags as unknown[]).map(asText).filter(Boolean) : [];
  const teach = teachOf(t.review);

  const running = t.status === "open" || t.status === "pending";
  const cancelled = t.status === "cancelled";
  const nofillNote = asText((t.review ?? {}).note);
  const mark = live?.quotes[t.symbol]?.price;
  const filled = t.status === "open" && t.entry_price !== null;
  const u = filled && mark ? unrealized(t, mark) : null;
  const base = t.instrument === "crypto_perp" ? t.margin : t.notional;
  const held = hoursBetween(t.entry_at, t.exit_at);
  const name = t.strategy ? stratName(t.strategy) : t.template ? templateName(t.template) : "";
  const entry = t.entry_price ?? t.entry_ref;

  const ballots = decision?.ballots ?? [];
  const workers = ballots.filter((b) => b.role === "worker" && !b.error);
  const takes = workers.filter((b) => b.stance === "take").length;
  const ordered = [...workers.filter((b) => b.stance === "take"), ...workers.filter((b) => b.stance !== "take")];
  const frontierSaid = asText(decision?.verdict?.reason);
  // The row's sentence sits inside a button, so it stays plain text; the opened summary goes through Lingo.
  const rowLine = tradeOneLine(t, decision ?? null, team ?? null);
  const short = open ? tradeInShort(t, decision ?? null, team ?? null) : "";
  // The headlines that were on the brief when the team decided: the ones on this name and the macro stories for a
  // flagged setup, or everything the crew read at the session for a session idea. Explained, not just named.
  const news = open && decision ? (decision.kind === "session" ? newsOf(decision.brief, "digest") : [...newsOf(decision.brief, "headlines"), ...newsOf(decision.brief, "macro")]) : [];

  return (
    <Card>
      <button onClick={() => setOpen(!open)} className="w-full text-left active:scale-[0.995]">
        <div className="flex items-center gap-1.5">
          <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-3)] truncate">{team?.name || "a team"}</span>
          <TierChip tier={team?.tier} />
          <span className="flex-1" />
          <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] shrink-0">{STATUS[t.status] ?? t.status}</span>
        </div>
        <div className="flex items-baseline gap-2 mt-1">
          <span className="mono text-sm font-bold">{t.symbol}</span>
          <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-4)] truncate">{t.side}{t.instrument === "crypto_perp" ? ` · ${t.leverage}x` : ""}{name ? ` · ${name}` : ""}</span>
          <span className="flex-1" />
          {t.status === "closed" ? (
            <span className="mono text-[12px] font-bold shrink-0" style={{ color: tone(t.pnl ?? 0) }}>{signed(t.pnl ?? 0)} <span className="text-[9px]">{fmtR(t.r_multiple ?? 0)}</span></span>
          ) : u !== null ? (
            <span className="mono text-[12px] font-bold shrink-0" style={{ color: tone(u) }}>{signed(u)} <span className="text-[9px]">({fmtPct(base > 0 ? u / base : 0)})</span></span>
          ) : null}
        </div>
        <p className="mono text-[10px] text-[var(--text-4)] mt-1">
          {when(t.decided_at)} · {TF[t.timeframe ?? "swing"] ?? t.timeframe}
          {t.status === "closed"
            ? ` · ${EXIT[t.exit_reason ?? ""] ?? t.exit_reason}${held !== null ? ` after ${dur(held)}` : ""}${verdict ? ` · reasoning ${verdict}${grade ? ` · process ${grade}` : ""}` : " · not reviewed yet"}`
            : cancelled ? " · never filled, so it never became a position"
            : ` · ${clockLeft(t, now) || (STATUS[t.status] ?? t.status)}`}
        </p>
        {!open && <p className="text-[11.5px] leading-snug mt-1.5 line-clamp-3">{rowLine}</p>}
      </button>

      {open && (
        <div className="mt-2.5 pt-2.5 border-t border-[var(--border-1)] rise-in space-y-3">
          <InShort text={short} />
          <div>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">Why it was taken</p>
            <p className="text-[12px] leading-relaxed"><Lingo text={t.thesis} /></p>
            {t.catalyst && <p className="text-[11.5px] text-[var(--text-3)] mt-1 leading-snug"><span className="text-[var(--text-4)]">The setup:</span> <Lingo text={t.catalyst} /></p>}
            {t.falsifier && <p className="text-[11.5px] text-[var(--text-3)] mt-1 leading-snug"><span className="text-[var(--text-4)]">Wrong if:</span> <Lingo text={t.falsifier} /></p>}
            <p className="mono text-[10px] text-[var(--text-4)] mt-1.5">
              {t.side === "long" ? <Term id="long">long</Term> : <Term id="short">short</Term>} · {t.qty} {t.unit}{t.qty === 1 ? "" : "s"} · {fmtMoney(t.notional)} position · <Term id="confidence">confidence</Term> {(t.confidence * 100).toFixed(0)}%
            </p>
          </div>

          {news.length > 0 && (
            <div>
              <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">The news behind it</p>
              <p className="text-[10px] text-[var(--text-4)] leading-relaxed">
                {decision?.kind === "session" ? "Everything the crew read at the session before it proposed this." : "The tagged headlines on this name and the big macro stories on the brief when the crew read the setup."} Under each one: what happened in plain words, then how strong it is and which way it points.
              </p>
              <NewsList items={news} foldAfter={2} foldLabel="headlines" />
            </div>
          )}

          <div>
            <div className="flex items-center gap-2">
              <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">The trade on the chart</p>
              <button onClick={() => setChart(!chart)} className="mono text-[10px] text-[var(--neon)] active:scale-95">{chart ? "hide the chart" : "show the chart"}</button>
            </div>
            {chart && (
              <div className="mt-1.5 rise-in">
                <Chart symbol={t.symbol} venue={t.venue} instrument={t.instrument} interval={intervalFor(t.timeframe)} height={230}
                  title={`${t.symbol} · ${t.side}${name ? ` · ${name}` : ""}`}
                  levels={{ entry: t.entry_price ?? t.entry_ref, stop: t.stop, target: t.target, liq: t.liq_price }}
                  markers={[
                    ...(t.entry_at ? [{ t: Date.parse(t.entry_at), kind: "entry" as const, price: t.entry_price ?? undefined, label: `in ${fmtPrice(entry)}`, color: "var(--neon)" }] : []),
                    ...(t.exit_at ? [{ t: Date.parse(t.exit_at), kind: "exit" as const, price: t.exit_price ?? undefined, label: `out ${fmtPrice(t.exit_price ?? entry)}`, color: tone(t.pnl ?? 0) }] : []),
                  ]} />
                <p className="text-[10px] text-[var(--text-4)] mt-1 leading-relaxed">The lines are the entry, the stop and the target the team wrote before it knew anything; the arrows are where it actually got in and out.</p>
              </div>
            )}
          </div>

          <TradeInputs trade={t} ticket={t.ticket ?? null} decision={decision ?? null} />

          {ordered.length > 0 && (
            <div className="space-y-1">
              <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">What the crew said · {takes} of {workers.length} workers voted to take it</p>
              {ordered.map((b, i) => (
                <p key={i} className="text-[11px] leading-snug flex items-start gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5" style={{ background: labTone(b.model) }} />
                  <span>
                    <span className="mono text-[9px]" style={{ color: b.stance === "take" ? "var(--ok)" : "var(--text-4)" }}>{b.stance} {(b.confidence * 100).toFixed(0)}%</span> <span className="text-[var(--text-3)]">{modelLabel(b.model)}:</span> <Lingo text={b.thesis} />
                    {b.wrong_if ? <span className="text-[var(--text-4)]"> Wrong if <Lingo text={b.wrong_if} /></span> : null}
                  </span>
                </p>
              ))}
              <p className="text-[10px] text-[var(--text-4)] leading-relaxed">The crew is the same four cheap models for every team. Each read the same brief once and voted take or pass with a confidence from 0 to 100 percent. The vote does not decide anything: the frontier does.</p>
            </div>
          )}
          {(frontierSaid || decision?.verdict) && (
            <p className="text-[11.5px] leading-snug">
              <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">The frontier{team?.frontier ? ` · ${modelLabel(team.frontier)}` : ""}: </span>
              <span className="mono text-[10px]" style={{ color: "var(--neon)" }}>{decision?.verdict?.action ?? "take"}</span> <Lingo text={frontierSaid} />
              {decision?.verdict?.acting ? <span className="text-[var(--warn)]"> A stand-in decided because the frontier did not answer in time.</span> : null}
            </p>
          )}

          {t.ticket && (
            <div>
              <div className="flex items-center gap-2">
                <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">The ticket</p>
                <button onClick={() => setWhole(!whole)} className="mono text-[10px] text-[var(--neon)] active:scale-95">{whole ? "hide the whole ticket" : "show the whole ticket"}</button>
              </div>
              <p className="text-[10px] text-[var(--text-4)] leading-relaxed">The record the desk wrote the moment it took the trade: the brief, the numbers, the rules it was checked against and the book before and after.</p>
              {whole && <div className="mt-1.5 rise-in"><Ticket ticket={t.ticket} /></div>}
            </div>
          )}

          <div>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">{running ? "Where it stands" : cancelled ? "It never filled" : "What happened"}</p>
            {running ? (
              <>
                <p className="mono text-[10.5px] text-[var(--text-2)] leading-relaxed">
                  {filled ? `in at ${fmtPrice(t.entry_price as number)} ${when(t.entry_at)}` : `queued — ${FILL[t.fill_rule] ?? "fills at the next open"}`}
                  {mark ? ` · now ${fmtPrice(mark)}` : ""}{u !== null ? ` · ${signed(u)} open${base > 0 ? ` (${fmtPct(u / base)})` : ""}` : ""}
                  <br />stop {fmtPrice(t.stop)}{mark ? `, ${away(mark, t.stop)}` : ""} · target {fmtPrice(t.target)}{mark ? `, ${away(mark, t.target)}` : ""}{t.liq_price ? ` · liquidation ${fmtPrice(t.liq_price)}` : ""}
                  {clockLeft(t, now) ? <><br />{clockLeft(t, now)}</> : null}
                </p>
                <p className="text-[10px] text-[var(--text-4)] mt-1 leading-relaxed">Open profit is what it would be worth if it closed at the price above; nothing is banked until it closes. {t.liq_price ? "Liquidation is where the borrowed money runs out and the position is closed for you, whatever the thesis says. " : ""}When the clock runs out the trade closes at the next price, win or lose.</p>
              </>
            ) : cancelled ? (
              <>
                <p className="mono text-[10.5px] text-[var(--text-2)] leading-relaxed">queued {when(t.decided_at)} at {fmtPrice(t.entry_ref)} · no price ever came to fill it{nofillNote ? ` · ${nofillNote}` : ""}</p>
                <p className="text-[10px] text-[var(--text-4)] mt-1 leading-relaxed">An order that never fills costs nothing and teaches something anyway: the team wanted this price and the market never offered it. There is no review, because there is no trade to review.</p>
              </>
            ) : (
              <>
                <p className="mono text-[10.5px] text-[var(--text-2)] leading-relaxed">
                  in {t.entry_price !== null ? fmtPrice(t.entry_price) : "—"} {when(t.entry_at)} → out {t.exit_price !== null ? fmtPrice(t.exit_price) : "—"} {when(t.exit_at)} · {EXIT[t.exit_reason ?? ""] ?? t.exit_reason}{t.ambiguous_bar ? " (both touched in one bar, the stop is assumed)" : ""}{t.close_reason ? ` — ${t.close_reason}` : ""}
                  <br />{signed(t.pnl ?? 0)} · {fmtR(t.r_multiple ?? 0)}{t.mae_r !== null ? ` · ${fmtR(t.mae_r)} against at worst, ${fmtR(t.mfe_r ?? 0)} for at best` : ""}{t.spy_entry && t.spy_exit ? ` · the S&P moved ${fmtPct(t.spy_exit / t.spy_entry - 1)} over the same time` : ""} · fees {fmtMoney(t.fees, 2)}{t.instrument === "crypto_perp" ? ` · funding ${signed(-t.funding, 2)}` : ""}
                </p>
                <p className="text-[10px] text-[var(--text-4)] mt-1 leading-relaxed">
                  <Term id="rmult">R</Term> is profit or loss in units of the risk taken: 1R is the distance from entry to stop, {fmtMoney(Math.abs(entry - t.stop) * t.qty * (t.unit === "contract" ? t.contract_value : 1))} here. <Term id="excursion">Against at worst and for at best</Term> are how far the trade went the wrong way and the right way while it was open. A trade that went 2R for before closing at 0.3R had the profit and gave it back.
                </p>
                {whatHappened && <p className="text-[12px] leading-relaxed mt-1.5"><Lingo text={whatHappened} /></p>}
              </>
            )}
          </div>

          {!running && !cancelled && (
            <div>
              <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">Why it happened, and was the reasoning sound</p>
              {text ? (
                <div className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-3 space-y-1.5">
                  {why && <p className="text-[12px] leading-relaxed"><Lingo text={why} /></p>}
                  <p className="mono text-[10px]" style={{ color: verdict === "held" ? "var(--ok)" : verdict === "broke" ? "var(--bad)" : "var(--warn)" }}>
                    reasoning {verdict || "unclear"}{grade ? ` · process ${grade}` : ""}{tags.length ? ` · ${tags.join(", ")}` : ""}
                  </p>
                  {quadrant && <p className="text-[11px] text-[var(--text-3)] leading-snug">{QUADRANT[quadrant] ?? quadrant}</p>}
                  <p className="text-[12px] leading-relaxed whitespace-pre-wrap"><Lingo text={text} /></p>
                  {lesson && <p className="text-[11.5px] text-[var(--text-2)]"><span className="text-[var(--text-4)]">Lesson:</span> <Lingo text={lesson} /></p>}
                  <p className="text-[10px] text-[var(--text-4)] leading-relaxed">Reasoning held or broke is about the thinking, not the money: a sound idea can lose and a sloppy one can win. <Term id="process">Process</Term> is the grade for how the trade was run. The <Term id="quadrant">quadrant</Term> puts the two together.</p>
                  {teach && <div className="pt-1.5 border-t border-[var(--border-1)]"><TeachBlock teach={teach} /></div>}
                  <button onClick={() => onReview(t.id, true)} disabled={busy} className="mono text-[10px] text-[var(--text-4)] active:scale-95 disabled:opacity-50">{busy ? "rewriting…" : "rewrite the review"}</button>
                </div>
              ) : (
                <div className="flex items-center gap-3 flex-wrap">
                  <button onClick={() => onReview(t.id, false)} disabled={busy} className="rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] text-xs font-semibold px-3 py-1.5 active:scale-95 disabled:opacity-50">{busy ? "Writing…" : "Write the review"}</button>
                  <span className="mono text-[9px] text-[var(--text-4)]">written at close by itself; this writes it now</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
