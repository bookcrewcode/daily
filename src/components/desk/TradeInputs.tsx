"use client";

// TradeInputs — "What went into this trade": one row per thing the trade used, its value
// with units, and one plain sentence on why it mattered for this trade, built from the
// ticket the desk wrote when it took the trade and the decision the team made. Every word
// of lingo is explained once on the panel until Ben has learned it. Teach renders the
// review's own list of inputs and terms. Paper money throughout.

import type { ReactNode } from "react";
import { fmtMoney, fmtPrice, modelLabel, type DecisionRow } from "@/lib/desk/api";
import { STRATEGIES } from "@/lib/desk/scan";
import type { Trade } from "@/lib/desk/types";
import { Term, lingo } from "./Term";
import { count, has, list, num, pct, rec, spct, str, TF, units } from "./Ticket";

const HOLD: Record<string, string> = { scalp: "A scalp is meant to be over in hours.", swing: "A swing trade runs for days.", position: "A position trade runs for weeks." };
const ACTION: Record<string, string> = { take: "take it", pass: "pass", close: "close it", tighten: "tighten it", hold: "hold" };
const money2 = (v: number) => fmtMoney(v, 2);
const px = (v: number) => `$${fmtPrice(v)}`;

export default function TradeInputs({ trade: t, ticket, decision }: { trade: Trade; ticket: Record<string, unknown> | null; decision: DecisionRow | null }) {
  // One `seen` for the whole panel: each term is explained the first time it appears, whether in a name or a sentence.
  const seen = new Set<string>();
  const term = (id: string, label: string) => { seen.add(id); return <Term id={id}>{label}</Term>; };
  const say = (text: string) => lingo(text, seen);

  const k = rec(ticket);
  const symbol = str(k.symbol) || t.symbol;
  const perp = t.instrument === "crypto_perp";
  const unitVal = t.unit === "contract" ? t.contract_value : 1;
  const entryRef = num(k.entry_ref) ?? t.entry_ref;
  const stop = num(k.stop) ?? t.stop, target = num(k.target) ?? t.target;
  const stopDist = Math.abs(entryRef - stop), targetDist = Math.abs(target - entryRef);
  const stopPct = num(k.stop_dist_pct) ?? (entryRef > 0 ? (stopDist / entryRef) * 100 : null);
  const targetPct = num(k.target_dist_pct) ?? (entryRef > 0 ? (targetDist / entryRef) * 100 : null);
  const rr = num(k.rr) ?? (stopDist > 0 ? targetDist / stopDist : null);
  const stopAtr = num(k.stop_dist_atr);
  const riskPct = num(k.risk_pct) ?? t.risk_pct;
  const qty = num(k.qty) ?? t.qty, unit = str(k.unit) || t.unit;
  const riskUsd = num(k.risk_usd) ?? stopDist * qty * unitVal;
  const notional = num(k.notional) ?? t.notional, leverage = num(k.leverage) ?? t.leverage, margin = num(k.margin) ?? t.margin;
  const liq = num(k.liq_price) ?? t.liq_price, liqBuf = num(k.liq_buffer_pct);
  const fundingRate = num(k.funding_rate), fundingEst = num(k.funding_est);
  const fees = num(k.fees_est), slipBps = num(k.slippage_bps) ?? t.slippage_bps;
  const horizon = str(k.horizon) || (t.horizon_hours ? `${t.horizon_hours} hours` : t.horizon_days ? `${t.horizon_days} days` : "");
  const expires = str(k.expires) || t.expires_on || "";
  const equity = num(k.equity), deathLine = num(k.death_line), toDeath = num(k.distance_to_death_pct);
  const before = rec(k.exposure_before), after = rec(k.exposure_after);
  const price = rec(k.price_check);

  // The setup as the strategy saw it, and the crew and frontier as the ticket recorded them (the decision fills any gap).
  const setup = rec(rec(decision?.brief).setup);
  const reasons = list(setup.reasons).map(rec).map((r) => ({ label: str(r.label), value: str(r.value), ok: r.ok === true, core: r.core === true }));
  const ordered = [...reasons.filter((r) => r.core), ...reasons.filter((r) => !r.core)];
  const rawScore = num(setup.score);
  const score = rawScore === null ? null : rawScore <= 1 ? rawScore * 100 : rawScore;
  const sid = t.strategy || str(setup.strategy) || decision?.strategy || "";
  const sdef = STRATEGIES.find((s) => s.id === sid);
  const crewBallots = (decision?.ballots ?? []).filter((b) => b.role === "worker" && !b.error);
  const w = rec(k.workers);
  const take = num(w.take) ?? crewBallots.filter((b) => b.stance === "take").length;
  const answered = num(w.answered) ?? crewBallots.length;
  const wScore = num(w.score) ?? (crewBallots.length ? crewBallots.reduce((a, b) => a + (b.stance === "take" ? 1 : -1) * b.confidence, 0) : null);
  const f = rec(k.frontier);
  const fModel = str(f.model) || decision?.verdict?.model || "";
  const fReason = str(f.reason) || decision?.verdict?.reason || "";
  const fAction = decision?.verdict?.action ?? "take";
  const acting = f.acting === true || decision?.verdict?.acting === true;
  const askedRisk = num(f.risk_pct_asked) ?? decision?.verdict?.risk_pct ?? null;
  const askedLev = num(f.leverage_asked) ?? decision?.verdict?.leverage ?? null;
  const priceRef = num(price.ref), priceNow = num(price.now), progress = num(price.progress_pct);
  const heatB = num(before.heat), heatA = num(after.heat), posB = num(before.positions), posA = num(after.positions), grossB = num(before.gross), grossA = num(after.gross);
  const fillGap = t.entry_price !== null && entryRef > 0 ? ((t.entry_price - entryRef) / entryRef) * 100 : null;
  const fillWorse = fillGap !== null && (t.side === "long" ? fillGap > 0 : fillGap < 0);
  const breakEven = has(rr) && rr > 0 ? 100 / (1 + rr) : null;
  const room = has(equity) && has(deathLine) ? equity - deathLine : null;

  return (
    <div>
      <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">What went into this trade</p>
      <p className="text-[10.5px] text-[var(--text-3)] leading-snug mt-0.5 mb-1">
        Every input the trade used, its value, and why it mattered here. All of it is paper money; the prices are real.
      </p>

      {(sdef || sid) && (
        <Input name={term("strategy", "The strategy")} value={[sdef?.name ?? sid, TF[t.timeframe ?? ""] ?? t.timeframe ?? ""].filter(Boolean).join(" · ")}
          why={say(`${sdef?.what ?? "A coded rule flagged this setup."} ${HOLD[t.timeframe ?? ""] ?? ""} Every check below had to hold before the crew was even asked.`)}>
          {ordered.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {ordered.map((r, i) => (
                <p key={i} className="text-[11px] leading-snug">
                  <span className="mono text-[9px]" style={{ color: r.ok ? "var(--ok)" : "var(--bad)" }}>{r.ok ? "held" : "failed"}</span>{" "}
                  <span className="text-[var(--text-2)]">{say(r.label)}</span>{r.value ? <span className="mono text-[10px] text-[var(--text-4)]"> {r.value}</span> : null}
                  {r.core ? null : <span className="mono text-[8px] text-[var(--text-4)]"> · confirmation</span>}
                </p>
              ))}
              <p className="text-[10px] text-[var(--text-4)] leading-snug">A core check must hold or there is no setup; a confirmation check adds to the score but cannot block it.</p>
            </div>
          )}
        </Input>
      )}

      {has(score) && (
        <Input name={term("confluence", "Confluence score")} value={pct(score, 0)}
          why={say("How many of the strategy's checks lined up. A frontier is only asked about a candidate when at least one worker said take or this is 60% or more.")} />
      )}

      {t.regime && (
        <Input name={term("regime", "Regime")} value={t.regime}
          why={say("The market's mood when the setup was flagged. A trend-following rule wants trending; a snap-back rule wants stretched and choppy; risk-off days break both.")} />
      )}

      <Input name={term("entry", "Entry")} value={`${px(entryRef)}${t.entry_price !== null ? ` · filled at ${px(t.entry_price)}` : ""}`}
        why={fillGap !== null && Math.abs(fillGap) >= 0.005
          ? say(`The plan was written at ${px(entryRef)}. The order actually got in at ${px(t.entry_price as number)}, ${Math.abs(fillGap).toFixed(2)}% ${fillWorse ? "worse" : "better"} than the plan: that gap is slippage, and it is the desk's cost, not the market's.`)
          : say(`The plan was written at ${px(entryRef)}; the stop and the target are measured from here. The order fills at the next price the tape gives, never at a price the team wished for.`)} />

      <Input name={term("stop", "Stop")} tone="var(--bad)" value={`${px(stop)}${has(stopPct) ? ` · ${pct(stopPct)} away` : ""}${has(stopAtr) ? ` · ${stopAtr.toFixed(1)} ATR` : ""}`}
        why={say(`If ${symbol} gets here the idea is wrong and the trade closes for about ${fmtMoney(riskUsd)} of paper.${has(stopAtr) ? ` The stop sits ${stopAtr.toFixed(1)} ATR from the entry, ${stopAtr.toFixed(1)} typical moves, so ordinary noise should not touch it.` : ""}`)} />

      <Input name={term("target", "Target")} tone="var(--ok)" value={`${px(target)}${has(targetPct) ? ` · ${pct(targetPct)} away` : ""}${has(rr) ? ` · ${rr.toFixed(1)} to 1` : ""}`}
        why={say(`Where the trade takes its profit.${has(rr) && breakEven !== null ? ` At ${rr.toFixed(1)} to 1 reward-to-risk a win pays ${rr.toFixed(1)} times what the stop loses, so it only has to be right more than ${breakEven.toFixed(0)}% of the time to come out ahead.` : ""}`)} />

      <Input name={term("risk", "Risk on this trade")} value={`${pct(riskPct)} of the book · ${fmtMoney(riskUsd)}`}
        why={say(`The share of the team's ${has(equity) ? `${fmtMoney(equity)} ` : ""}paper book lost if the stop is hit. The size is worked back from it: ${fmtMoney(riskUsd)} divided by the ${money2(stopDist * unitVal)} each ${unit} loses at the stop gives ${count(qty)} ${units(unit, qty)}. No model picks a size.`)} />

      <Input name={term("notional", "Notional")} value={`${fmtMoney(notional)} · ${count(qty)} ${units(unit, qty)}`}
        why={perp
          ? say(`The full size of the position. Only the margin is put up as cash; the rest is borrowed, which is what the leverage means.`)
          : say(`The full size of the position, and for a stock also the cash it ties up: ${count(qty)} ${units(unit, qty)} at about ${px(entryRef)}.`)} />

      {(perp || leverage > 1) && (
        <Input name={term("leverage", "Leverage")} value={`${count(leverage)}x`}
          why={say(`The position is ${count(leverage)} times the cash put up, so every 1% move in ${symbol} is ${count(leverage)}% on that cash. It makes the win and the loss bigger; it does not change the odds.`)} />
      )}

      {perp && (
        <Input name={term("margin", "Margin")} value={fmtMoney(margin)}
          why={say(`The cash actually put up. The other ${fmtMoney(Math.max(0, notional - margin))} is borrowed from the exchange, which is why there is a liquidation price.`)} />
      )}

      {has(liq) && (
        <Input name={term("liq", "Liquidation price")} tone="var(--warn)" value={`${px(liq)}${has(liqBuf) ? ` · ${pct(liqBuf, 0)} past the stop` : ""}`}
          why={say(`If ${symbol} reaches it the exchange closes the position because the cash put up is gone.${has(liqBuf) ? ` It sits ${pct(liqBuf, 0)} beyond the stop, so the stop fires first; the desk refuses any trade where it would not.` : ""}`)} />
      )}

      {perp && has(fundingRate) && (
        <Input name={term("funding", "Funding")} value={`${spct(fundingRate, 3)} per 8 hours${has(fundingEst) && fundingEst !== 0 ? ` · about ${money2(Math.abs(fundingEst))} over the hold` : ""}`}
          why={say(`Longs and shorts pay each other this every eight hours to keep the perp near the coin's real price. ${fundingRate > 0 ? "Positive, so the longs pay" : fundingRate < 0 ? "Negative, so the shorts pay" : "Zero, so nobody pays"}${has(fundingEst) && fundingEst !== 0 ? `: this ${t.side} ${fundingEst > 0 ? "pays" : "collects"} about ${money2(Math.abs(fundingEst))} over the horizon, which ${fundingEst > 0 ? "comes off" : "adds to"} the result` : ""}.`)} />
      )}

      {(has(fees) || has(slipBps)) && (
        <Input name={term("fees", "Fees and slippage")} value={[has(fees) ? `${money2(fees)} in and out` : "", has(slipBps) ? `${count(slipBps)} bps` : ""].filter(Boolean).join(" · ")}
          why={say(`Both come off the paper book as they would for real.${has(slipBps) ? ` Slippage is the gap allowed between the price asked for and the price got: ${count(slipBps)} basis points is ${pct(slipBps / 100, 2)}, about ${money2((notional * slipBps) / 10000)} on this size.` : ""} The target has to cover the costs before the trade is even flat.`)} />
      )}

      {(horizon || expires) && (
        <Input name={term("horizon", "Horizon")} value={[horizon, expires ? `closed no later than ${expires}` : ""].filter(Boolean).join(" · ")}
          why={say("The time stop. When it runs out the trade closes at the next price whatever it is doing, so a wrong idea cannot quietly become a long hold.")} />
      )}

      {answered > 0 && (
        <Input name={term("crew", "The crew's vote")} value={`${take} of ${answered} said take${has(wScore) ? ` · score ${wScore >= 0 ? "+" : ""}${wScore.toFixed(2)}` : ""}`}
          why={say("Each worker read the same brief once and voted take or pass with a confidence. The score adds each take's confidence and subtracts each pass's, so +1.20 means the takes were surer and more numerous than the passes. The vote informs the frontier; it does not decide.")} />
      )}

      {fModel && (
        <Input name={term("frontier", "The frontier")} value={`${modelLabel(fModel)} · ${ACTION[fAction] ?? fAction}${has(askedRisk) && askedRisk > 0 ? ` · asked ${pct(askedRisk)}` : ""}${has(askedLev) && askedLev > 1 ? ` at ${count(askedLev)}x` : ""}`}
          why={<>
            {fReason ? <>{say(fReason)}{" "}</> : null}
            {acting ? <span className="text-[var(--warn)]">A stand-in decided because the frontier did not answer in time. </span> : null}
            {has(askedRisk) && askedRisk > 0 ? say(`It asked to risk ${pct(askedRisk)}${has(askedLev) && askedLev > 1 ? ` at ${count(askedLev)}x` : ""}; the code gave it ${pct(riskPct)}${leverage > 1 ? ` at ${count(leverage)}x` : ""}. A frontier may ask for less than the rules allow, never more, and the code sets the number.`) : null}
          </>} />
      )}

      {has(priceRef) && has(priceNow) && (
        <Input name="The price check" value={`${px(priceRef)} when flagged → ${px(priceNow)} when taken${has(progress) ? ` · ${pct(progress, 0)} of the way to the target` : ""}`}
          why={say(`The desk looks at the price once more before it takes a setup.${has(progress) ? ` Between the flag and the take ${symbol} had already gone ${pct(progress, 0)} of the way to the target; too far along and the desk passes, because the easy part of the move is gone.` : ""}`)} />
      )}

      {(has(heatB) || has(heatA)) && (
        <Input name={term("heat", "Heat, before and after")} value={`${has(heatB) ? fmtMoney(heatB) : "—"} → ${has(heatA) ? fmtMoney(heatA) : "—"}`}
          why={say(`What the team's book would lose if every open stop hit at once${has(posB) && has(posA) ? `: ${count(posB)} open position${posB === 1 ? "" : "s"} before this trade, ${count(posA)} after` : ""}.${has(grossB) && has(grossA) ? ` Gross exposure went from ${fmtMoney(grossB)} to ${fmtMoney(grossA)}.` : ""} The desk caps heat so one bad day cannot kill the team.`)} />
      )}

      {has(deathLine) && (
        <Input name={term("death", "Death line")} value={`${fmtMoney(deathLine)}${has(toDeath) ? ` · ${spct(toDeath)} away` : ""}`}
          why={say(`The team dies if its book touches it.${room !== null && room > 0 && riskUsd > 0 ? ` This trade's risk is ${((riskUsd / room) * 100).toFixed(0)}% of the distance to it: ${Math.max(1, Math.floor(room / riskUsd))} such loss${Math.floor(room / riskUsd) === 1 ? "" : "es"} in a row would end the team.` : ""}`)} />
      )}

      {k.mirrored_to_desk === true && (
        <Input name={term("desk", "The desk")} value="mirrored" why="This team is the champion, so the desk copied the trade onto Ben's own book as well." />
      )}
    </div>
  );
}

function Input({ name, value, why, tone, children }: { name: ReactNode; value?: string; why: ReactNode; tone?: string; children?: ReactNode }) {
  return (
    <div className="py-1.5 border-t border-[var(--border-1)]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[11.5px] font-semibold leading-snug">{name}</span>
        {value ? <span className="mono text-[11px] leading-snug ml-auto text-right" style={tone ? { color: tone } : undefined}>{value}</span> : null}
      </div>
      <p className="text-[10.5px] text-[var(--text-4)] leading-snug mt-0.5">{why}</p>
      {children}
    </div>
  );
}

/* ── the review's own teaching: what it says the trade used, and the words it leaned on ── */
export type Teach = { inputs: { name: string; value: string; meaning: string; why: string }[]; terms: { term: string; meaning: string }[] };

export function teachOf(review: Record<string, unknown> | null | undefined): Teach | null {
  const r = rec(rec(review).teach);
  const inputs = list(r.inputs).map(rec).map((x) => ({ name: str(x.name), value: str(x.value), meaning: str(x.meaning), why: str(x.why) })).filter((x) => x.name);
  const terms = list(r.terms).map(rec).map((x) => ({ term: str(x.term), meaning: str(x.meaning) })).filter((x) => x.term && x.meaning);
  return inputs.length || terms.length ? { inputs, terms } : null;
}

export function TeachBlock({ teach }: { teach: Teach }) {
  return (
    <div className="space-y-2">
      {teach.inputs.length > 0 && (
        <div>
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">What the review says this trade used</p>
          {teach.inputs.map((x, i) => (
            <div key={i} className="py-1.5 border-t border-[var(--border-1)]">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[11.5px] font-semibold leading-snug">{x.name}{x.meaning ? <span className="text-[var(--text-4)] font-normal"> ({x.meaning})</span> : null}</span>
                {x.value ? <span className="mono text-[11px] leading-snug ml-auto text-right">{x.value}</span> : null}
              </div>
              {x.why ? <p className="text-[10.5px] text-[var(--text-4)] leading-snug mt-0.5">{x.why}</p> : null}
            </div>
          ))}
        </div>
      )}
      {teach.terms.length > 0 && (
        <div>
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-0.5">Words in this review</p>
          {teach.terms.map((x, i) => (
            <p key={i} className="text-[11px] leading-snug py-0.5"><span className="font-semibold">{x.term}</span><span className="text-[var(--text-4)]">: {x.meaning}</span></p>
          ))}
        </div>
      )}
    </div>
  );
}
