"use client";

// Plain — the desk in short sentences, written by code alone. Every decision and every
// trade gets a summary built from what the row already holds: the setup, the strategy's
// own definition, the crew's ballots, the frontier's verdict, what the desk did with it
// and, for a trade, where it stands or how it ended. inShort and tradeInShort are the
// three-or-four-sentence versions an opened card leads with; oneLine and tradeOneLine are
// the single sentences the journal rows show, so the list itself reads as plain English.
// The headline pieces the cards share live here too: a headline, what actually happened,
// and one small line of impact, direction and tickers. Paper money on every line; every
// word of lingo in an opened card goes through Lingo and is explained until learned.

import { useState } from "react";
import { Lingo } from "./Term";
import { fmtMoney, fmtPrice, fmtR, modelLabel, type Ballot, type BriefNewsItem, type DecisionRow, type TeamRow, type TeamVerdict } from "@/lib/desk/api";
import { shortModel } from "@/lib/desk/league";
import { STRATEGIES } from "@/lib/desk/scan";
import type { Trade } from "@/lib/desk/types";

/* ── reading the free-form json ────────────────────────────────────────── */
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => { const x = Number(v); return typeof v !== "boolean" && v !== null && v !== "" && v !== undefined && Number.isFinite(x) ? x : null; };
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const has = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/* ── words for numbers and prices ──────────────────────────────────────── */
// A price in prose: the app's precision with the dead zeros gone, so $2.440 reads $2.44 and $310.00 reads $310.
function px(v: number): string {
  const s = fmtPrice(v);
  if (v >= 1000 || v < 1) return `$${s}`;
  if (/\.0+$/.test(s)) return `$${s.replace(/\.0+$/, "")}`;
  return `$${s.replace(/(\.\d\d)0+$/, "$1")}`;
}
const signedMoney = (v: number) => `${v >= 0 ? "+" : "-"}${fmtMoney(Math.abs(v))}`;
const count = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 4 });
const trim = (v: number) => String(Number(v.toFixed(2)));
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const word = (n: number) => (n >= 0 && n < WORDS.length ? WORDS[n] : String(n));
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// A model's sentence usually opens with a capital that should drop when it follows a colon. Only common openers are
// lowered, so a name, a ticker or a proper noun at the front ("Astra", "NVDA", "Iran") keeps its capital.
const STARTERS = new Set(["the", "a", "an", "it", "its", "this", "that", "these", "those", "there", "here", "we", "no", "not", "too", "most", "all", "both", "one", "two", "three", "four", "price", "volume", "funding", "stop", "target", "risk", "entry", "trend", "breakout", "momentum", "setup", "crew", "team", "book", "holding", "cut", "take", "pass", "buy", "sell", "oil", "rates", "nothing", "everything", "with", "without", "after", "before", "strong", "weak", "clean", "good", "bad", "solid", "tight", "wide", "high", "low"]);
function lower(s: string): string {
  const first = s.match(/^[A-Z][a-z]*/)?.[0];
  return first && STARTERS.has(first.toLowerCase()) ? s[0].toLowerCase() + s.slice(1) : s;
}
const units = (qty: number, unit: string) => `${count(qty)} ${unit || "unit"}${Math.abs(qty) === 1 ? "" : "s"}`;
function dur(h: number): string {
  if (h < 1) { const m = Math.max(1, Math.round(h * 60)); return `${m} minute${m === 1 ? "" : "s"}`; }
  if (h < 48) { const n = Number(h.toFixed(1)); return `${n} hour${n === 1 ? "" : "s"}`; }
  const d = Number((h / 24).toFixed(1));
  return `${d} day${d === 1 ? "" : "s"}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-24" or an ISO stamp → "Sep 24", read off the string with no clock involved. */
function monthDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : iso.slice(0, 10);
}

/** A model's reason as one clause: whitespace squashed, clipped at a sentence end near the limit, no trailing full stop (the caller adds it). */
export function clause(text: string, max = 180): string {
  const t = text.replace(/\s+/g, " ").trim().replace(/[.!;,\s]+$/, "");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  if (end > max * 0.4) return cut.slice(0, end);
  const sp = cut.lastIndexOf(" ");
  return `${cut.slice(0, sp > 0 ? sp : max)}…`;
}

/* ── the setup in words ────────────────────────────────────────────────── */
const INSTRUMENT_PHRASE: Record<string, string> = { stock: "a stock", etf: "an ETF", crypto_spot: "spot crypto", crypto_perp: "a crypto perpetual" };
function instrumentPhrase(instrument: string, symbol: string): string {
  return INSTRUMENT_PHRASE[instrument] ?? (/-USDT?$/.test(symbol) ? "a crypto perpetual" : "a stock");
}
// "for a breakout", "for crypto momentum": the strategy's name with its article.
const FOR: Record<string, string> = {
  "trend-pullback": "a trend pullback", breakout: "a breakout", "rsi2-reversion": "an RSI(2) reversion", "crypto-momentum": "crypto momentum",
  "attention-spike": "an attention spike", "opening-range-break": "an opening range break", "funding-extreme-fade": "a funding extreme fade", "weekly-trend-position": "a weekly trend position",
};
// What the setup means right now, per strategy and side, in the words a beginner reads.
const GLOSS: Record<string, { long: string; short: string }> = {
  "trend-pullback": { long: "it is in an uptrend and just dipped to its 20-day average, the kind of dip that usually gets bought", short: "it is in a downtrend and just bounced to its 20-day average, the kind of bounce that usually gets sold" },
  breakout: { long: "it just closed above every price of the last month on heavy volume", short: "it just closed below every price of the last month on heavy volume" },
  "rsi2-reversion": { long: "two days of hard selling inside a long-term uptrend, which usually snaps back", short: "two days of hard buying inside a long-term downtrend, which usually snaps back" },
  "crypto-momentum": { long: "its 4-hour and daily trends both point up, it pulled back for an hour, and funding is calm", short: "its 4-hour and daily trends both point down, it bounced for an hour, and funding is calm" },
  "attention-spike": { long: "a fresh high-impact headline brought volume and a real move up in the last two hours", short: "a fresh high-impact headline brought volume and a real move down in the last two hours" },
  "opening-range-break": { long: "it broke above the first half hour's high on volume, with the daily trend behind it", short: "it broke below the first half hour's low on volume, with the daily trend behind it" },
  "funding-extreme-fade": { long: "funding is extreme with the price at a 20-day low, so the crowd is paying to stay short and usually gets squeezed", short: "funding is extreme with the price at a 20-day high, so the crowd is paying to stay long and usually gets squeezed" },
  "weekly-trend-position": { long: "it is among the strongest names of the last year and its weekly trend is up", short: "it is among the weakest names of the last year and its weekly trend is down" },
};
function strategyPhrase(id: string, name: string): string {
  return FOR[id] ?? (name ? lower(name) : id);
}
function setupGloss(id: string, side: string, fallbackWhat: string): string {
  const g = GLOSS[id];
  if (g) return side === "short" ? g.short : g.long;
  return fallbackWhat ? lower(clause(fallbackWhat, 140)) : "";
}
/** "The scan flagged NEAR-USDT, a crypto perpetual, for a breakout: it just closed above every price of the last month." */
function scanSentence(symbol: string, instrument: string, side: string, strategyId: string, strategyName: string, what: string): string {
  const def = STRATEGIES.find((s) => s.id === strategyId);
  const name = strategyName || def?.name || strategyId;
  const gloss = setupGloss(strategyId, side, what || def?.what || "");
  return `The scan flagged ${symbol || "a setup"}, ${instrumentPhrase(instrument, symbol)}, for ${strategyPhrase(strategyId, name)}${gloss ? `: ${gloss}` : ""}.`;
}

/* ── the crew's vote in one sentence ───────────────────────────────────── */
const TAG_CLAUSE: Record<string, string> = {
  chase: "called it a chase", extended: "called it extended", "no-catalyst": "saw no catalyst", "event-risk": "flagged event risk", crowded: "called it crowded",
  "thin-volume": "saw thin volume", "counter-trend": "called it counter-trend", clean: "called it a clean setup", "strong-confluence": "saw strong confluence",
};
function topTag(bs: Ballot[]): { tag: string; n: number } | null {
  const counts = new Map<string, number>();
  for (const b of bs) for (const t of new Set(b.tags.map((x) => x.toLowerCase().trim()))) if (TAG_CLAUSE[t]) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best: { tag: string; n: number } | null = null;
  for (const [tag, n] of counts) if (!best || n > best.n) best = { tag, n };
  return best;
}
/** "All four crew members said pass; two of them called it a chase." Empty when there were no workers on the decision. */
function crewSentence(workers: Ballot[], deciding: boolean): string {
  if (workers.length === 0) return deciding ? "The crew is still voting." : "";
  const answered = workers.filter((b) => !b.error);
  if (answered.length === 0) return deciding ? "The crew is still voting." : "Nobody on the crew answered in time.";
  const takes = answered.filter((b) => b.stance === "take"), passes = answered.filter((b) => b.stance === "pass");
  const n = answered.length;
  const one = n === 1;
  let s = takes.length === 0
    ? (one ? "The one crew member who answered said pass" : `All ${word(n)} crew members said pass`)
    : passes.length === 0
      ? (one ? "The one crew member who answered said take" : `All ${word(n)} crew members said take`)
      : `${cap(word(takes.length))} of ${word(n)} crew members said take`;
  const split = takes.length > 0 && passes.length > 0;
  const side = takes.length === 0 ? passes : passes.length === 0 ? takes : takes.length > passes.length ? takes : passes;
  const stance = side === takes ? "take" : "pass";
  const tag = topTag(side);
  if (tag) {
    const does = TAG_CLAUSE[tag.tag];
    if (!split) s += side.length === 1 || tag.n === side.length ? ` and ${does}` : `; ${word(tag.n)} of them ${does}`;
    else if (side.length === 1) s += `; the one who said ${stance} ${does}`;
    else s += `; ${tag.n === side.length ? `all ${word(tag.n)}` : word(tag.n)} of those who said ${stance} ${does}`;
  }
  return `${s}.`;
}
/** The row's shorter form: "all four passed", "three of four said take", "nobody answered". */
function crewShort(workers: Ballot[]): string {
  const answered = workers.filter((b) => !b.error);
  if (!workers.length) return "";
  if (!answered.length) return "nobody on the crew answered";
  const takes = answered.filter((b) => b.stance === "take").length;
  if (takes === 0) return answered.length === 1 ? "the one worker who answered passed" : `all ${word(answered.length)} on the crew passed`;
  if (takes === answered.length) return answered.length === 1 ? "the one worker who answered said take" : `all ${word(answered.length)} on the crew said take`;
  return `${word(takes)} of ${word(answered.length)} on the crew said take`;
}

/* ── the frontier and what the desk did ────────────────────────────────── */
/** "Astra, the frontier," or the stand-in that decided for it. */
function frontierWho(verdict: TeamVerdict | null, team?: TeamRow | null): string {
  const lead = team?.frontier ? shortModel(team.frontier) : "";
  if (verdict?.acting) return `${shortModel(verdict.model)}, standing in for ${lead || "the frontier"} because it did not answer in time,`;
  const name = lead || (verdict?.model ? shortModel(verdict.model) : "");
  return name ? `${name}, the frontier,` : "The frontier";
}
function frontierShort(verdict: TeamVerdict | null, team?: TeamRow | null): string {
  if (verdict?.acting) return `${shortModel(verdict.model)} (standing in)`;
  const id = team?.frontier || verdict?.model || "";
  return id ? shortModel(id) : "the frontier";
}
function stake(verdict: TeamVerdict): string {
  const bits = [has(verdict.risk_pct) && verdict.risk_pct > 0 ? `${trim(verdict.risk_pct)}% of the book at risk` : "", has(verdict.leverage) && verdict.leverage > 1 ? `${trim(verdict.leverage)}x leverage` : ""].filter(Boolean);
  return bits.length ? ` with ${bits.join(" and ")}` : "";
}
/** The pass reasons the desk writes, in words. */
const PASS_WORDS: Record<string, string> = {
  "already held": "the team already holds it", "most of the move is gone": "most of the move was already gone by the time it could act",
  "the price is through the stop": "the price had already gone through the stop", "budget spent": "the day's model budget was spent",
  "no worker answered": "no worker answered", "every worker passed": "every worker passed", "no time for the frontier": "there was no time left to ask the frontier",
  "no answer in time": "nobody answered in time", "the team died": "the team had died", "two takes a session": "two takes a session is the limit", "no proposals": "nobody on the crew had an idea",
};
const passWords = (reason: string) => PASS_WORDS[reason] ?? lower(clause(reason, 160));

type Order = { side: string; qty: number; unit: string; price: number; stop: number; target: number; rr: number | null };
function orderOf(ticket: unknown): Order | null {
  const k = rec(ticket);
  const qty = num(k.qty), price = num(k.entry_ref), stop = num(k.stop), target = num(k.target);
  if (!has(qty) || !has(price) || !has(stop) || !has(target)) return null;
  const rr = num(k.rr) ?? (Math.abs(price - stop) > 0 ? Math.abs(target - price) / Math.abs(price - stop) : null);
  return { side: str(k.side), qty, unit: str(k.unit), price, stop, target, rr };
}
const rrWords = (rr: number | null) => (has(rr) && rr > 0 ? `, about ${rr.toFixed(1)} to 1 reward to risk` : "");
/** "The desk bought 120 contracts at $2.44 with a stop at $2.26 and a target at $2.90, about 2.5 to 1 reward to risk." */
function orderSentence(o: Order, queued: boolean): string {
  const verb = queued ? (o.side === "short" ? "queued an order to sell short" : "queued an order to buy") : o.side === "short" ? "sold short" : "bought";
  return `The desk ${verb} ${units(o.qty, o.unit)} ${queued ? "near" : "at"} ${px(o.price)} with a stop at ${px(o.stop)} and a target at ${px(o.target)}${rrWords(o.rr)}.`;
}
const orderShort = (o: Order) => `${units(o.qty, o.unit)} at ${px(o.price)}, stop ${px(o.stop)}, target ${px(o.target)}`;

/* ── pieces of a decision ──────────────────────────────────────────────── */
type Parts = {
  d: DecisionRow; brief: Record<string, unknown>; setup: Record<string, unknown>; proposal: Record<string, unknown>; outcome: Record<string, unknown>;
  verdict: TeamVerdict | null; workers: Ballot[]; deciding: boolean; failed: boolean; taken: boolean; symbol: string; side: string; strategyId: string;
};
function parts(d: DecisionRow): Parts {
  const brief = rec(d.brief), setup = rec(brief.setup), proposal = rec(brief.proposal), outcome = rec(d.outcome);
  const state = String(d.status);
  const symbol = d.symbol || str(setup.symbol) || str(proposal.symbol) || str(rec(brief.trade).symbol);
  const side = d.kind === "close" ? str(rec(brief.trade).side) : d.kind === "session" || d.kind === "own" ? str(proposal.side) : str(setup.side);
  return {
    d, brief, setup, proposal, outcome, verdict: d.verdict, workers: d.ballots.filter((b) => b.role === "worker"),
    deciding: state === "launched" || state === "queued", failed: state === "failed", taken: outcome.taken === true, symbol, side, strategyId: d.strategy || str(setup.strategy),
  };
}
/** The session's time from its key: "2026-09-09 21:30" → "the 21:30 session"; a forced one → "the session run by hand at 01:22". */
function sessionName(brief: Record<string, unknown>): string {
  const key = str(brief.session_key).trim();
  const rest = key.split(" ").slice(1).join(" ");
  if (!rest) return "the session";
  if (/manual/i.test(rest)) { const t = rest.replace(/manual/i, "").trim(); return t ? `the session run by hand at ${t}` : "the session run by hand"; }
  return `the ${rest} session`;
}
function digestCount(brief: Record<string, unknown>): number {
  return Math.max(list(brief.digest_items).length, list(brief.digest).length);
}
/** For a candidate or session: the frontier's sentence and what the desk did with it, in order. */
function frontierAndOutcome(p: Parts, team?: TeamRow | null): string[] {
  const { verdict, outcome, taken, deciding, workers } = p;
  const out: string[] = [];
  const by = str(outcome.by), passReason = str(outcome.pass_reason);
  if (!verdict) {
    if (deciding) out.push(workers.some((b) => !b.error) ? "The frontier has not answered yet." : "");
    else if (p.failed) out.push("Nobody decided, so there was no trade.");
    else if (by === "workers" || passReason === "every worker passed" || passReason === "no worker answered") out.push("The frontier was not asked.", "No trade.");
    else if (passReason === "no time for the frontier") out.push("There was no time left to ask the frontier.", "No trade.");
    else if (passReason) out.push(`${cap(passWords(passReason))}.`, "No trade.");
    else out.push("The frontier was not asked.", "No trade.");
    return out.filter(Boolean);
  }
  const who = frontierWho(verdict, team);
  const reason = str(verdict.reason);
  if (verdict.error && !verdict.acting) out.push(`${who} did not answer in time, which counts as a pass.`);
  else if (verdict.action === "take") out.push(`${who} took it${stake(verdict)}${reason ? `: ${lower(clause(reason))}` : ""}.`);
  else out.push(`${who} ${verdict.action === "hold" ? "held" : "passed"}${reason && !verdict.error ? `: ${lower(clause(reason))}` : ""}.`);
  if (taken) {
    const o = orderOf(outcome.ticket);
    out.push(o ? orderSentence(o, false) : "The desk placed the order.");
  } else if (verdict.action === "take" && !deciding) {
    out.push(`The desk still passed${passReason ? `: ${passWords(passReason)}` : ""}.`);
  } else if (!deciding) out.push("No trade.");
  return out;
}

/* ── the summaries ─────────────────────────────────────────────────────── */
/** Three or four plain sentences on one decision, for the top of an opened card. */
export function inShort(decision: DecisionRow, team?: TeamRow | null): string {
  const p = parts(decision);
  const { d, brief, setup, proposal, outcome, verdict, workers, deciding, symbol, side, strategyId } = p;
  const s: string[] = [];
  if (d.kind === "candidate") {
    s.push(scanSentence(symbol, str(setup.instrument), side, strategyId, str(rec(brief.strategy).name), str(rec(brief.strategy).what)));
    if (p.failed && !workers.some((b) => !b.error)) s.push("The crew did not answer in time, so nobody decided.", "No trade.");
    else { s.push(crewSentence(workers, deciding)); s.push(...frontierAndOutcome(p, team)); }
    return s.filter(Boolean).join(" ");
  }
  if (d.kind === "session") {
    const note = str(brief.note);
    const when = sessionName(brief);
    if (/^no session/i.test(note)) return `There was no ${when.replace(/^the /, "")}: ${lower(clause(note.replace(/^no session:?\s*/i, ""), 120)) || "the day's model budget was spent"}. No trade.`;
    const n = digestCount(brief);
    const read = n ? `the crew read ${n === 1 ? "one headline" : `${n} headlines`}` : "the crew read the feed";
    if (!str(proposal.symbol) && !symbol) {
      s.push(`At ${when} ${read} and nobody had an idea that held up.`);
      const reason = str(verdict?.reason);
      if (reason) s.push(`${frontierWho(verdict, team)} noted: ${lower(clause(reason))}.`);
      s.push("No trade.");
      return s.join(" ");
    }
    const model = str(proposal.model);
    const because = str(proposal.catalyst) || str(proposal.thesis);
    s.push(`At ${when} ${read} and ${model ? modelLabel(model) : "one crew member"} proposed one trade: ${symbol}, ${instrumentPhrase(str(proposal.instrument) || str(setup.instrument), symbol)}, ${side || "long"}${because ? `, because ${lower(clause(because, 150))}` : ""}.`);
    s.push(...frontierAndOutcome(p, team));
    return s.filter(Boolean).join(" ");
  }
  if (d.kind === "own") {
    // the frontier's own idea: no crew vote; the frontier brought it and the desk placed it or refused it
    const who = frontierWho(verdict, team);
    const play = str(proposal.strategy_name) || strategyId.replace(/^own:/, "").replace(/-/g, " ");
    const because = str(proposal.catalyst) || str(proposal.thesis);
    const what = [symbol, instrumentPhrase(str(proposal.instrument), symbol), side || "long"].filter(Boolean).join(", ");
    s.push(`At ${sessionName(brief)} ${who} ran its own playbook${play ? `, "${play}"` : ""}: ${what}${because ? `, because ${lower(clause(because, 150))}` : ""}.`);
    const passReason = str(outcome.pass_reason);
    if (p.taken) { const o = orderOf(outcome.ticket); s.push(o ? orderSentence(o, false) : "The desk placed the order."); }
    else if (deciding) s.push("The desk is placing it.");
    else s.push(`The desk refused it${passReason ? `: ${passWords(passReason)}` : ""}.`, "No trade.");
    return s.filter(Boolean).join(" ");
  }
  // a close: the frontier acting on a position it already holds
  const trade = rec(brief.trade);
  const entry = num(trade.entry_price), unreal = num(trade.unrealized);
  const who = frontierWho(verdict, team);
  const reason = str(verdict?.reason);
  const tail = reason ? `: ${lower(clause(reason))}` : "";
  if (verdict?.action === "tighten") {
    const oldStop = num(trade.stop), oldTarget = num(trade.target);
    const newStop = num(outcome.stop) ?? num(verdict.stop), newTarget = num(outcome.target) ?? num(verdict.target);
    const moved = [
      has(oldStop) && has(newStop) && newStop !== oldStop ? `the stop on ${symbol} from ${px(oldStop)} to ${px(newStop)}` : "",
      has(oldTarget) && has(newTarget) && newTarget !== oldTarget ? `the target${has(oldStop) && has(newStop) && newStop !== oldStop ? "" : ` on ${symbol}`} from ${px(oldTarget)} to ${px(newTarget)}` : "",
    ].filter(Boolean);
    s.push(`${who} tightened ${moved.length ? moved.join(" and ") : `the levels on ${symbol}`}${tail}.`);
    s.push("The trade keeps running with the new levels; a stop can only ever move closer, never further away.");
    return s.join(" ");
  }
  const standing = has(unreal) ? `, ${signedMoney(unreal)} on paper at the time` : "";
  s.push(`${who} asked to close ${symbol}${side ? `, ${side}` : ""}${has(entry) ? ` from ${px(entry)}` : ""}${standing}${tail}.`);
  s.push(outcome.requested === true ? "The desk closes it at the next real price, not at a price anyone wished for." : "Nothing was changed on the book.");
  return s.join(" ");
}

/** One plain sentence for a journal row. The symbol is left out because the row's header already shows it. */
export function oneLine(decision: DecisionRow, team?: TeamRow | null): string {
  const p = parts(decision);
  const { d, brief, proposal, outcome, verdict, workers, deciding, symbol } = p;
  const passReason = str(outcome.pass_reason);
  const name = frontierShort(verdict, team);
  const reason = str(verdict?.reason);
  const said = (fallback: string) => (reason ? lower(clause(reason, 140)) : fallback);
  const frontierBit = (): string => {
    if (!verdict) {
      if (deciding) return workers.some((b) => !b.error) ? "waiting for the frontier" : "";
      if (p.failed) return "nobody decided";
      if (passReason === "no time for the frontier") return "no time left to ask the frontier";
      if (str(outcome.by) === "workers" || !passReason || passReason === "every worker passed" || passReason === "no worker answered") return "the frontier was not asked";
      return passWords(passReason);
    }
    if (verdict.error && !verdict.acting) return `${name} did not answer, which counts as a pass`;
    if (verdict.action === "take") {
      const o = orderOf(outcome.ticket);
      if (p.taken) return `${name} took it${o ? `: ${orderShort(o)}` : ""}${has(verdict.risk_pct) && verdict.risk_pct > 0 ? `, ${trim(verdict.risk_pct)}% at risk` : ""}`;
      if (deciding) return `${name} said take`;
      return `${name} said take but the desk passed${passReason ? `: ${passWords(passReason)}` : ""}`;
    }
    return `${name} ${verdict.action === "hold" ? "held" : "passed"}${verdict.error ? "" : `: ${said("no reason given")}`}`;
  };
  if (d.kind === "candidate") {
    if (p.failed && !workers.some((b) => !b.error)) return "The crew did not answer in time; no trade.";
    const crew = crewShort(workers) || (deciding ? "the crew is still voting" : "");
    const f = frontierBit();
    return cap([crew, f].filter(Boolean).join("; ")) + ".";
  }
  if (d.kind === "session") {
    const note = str(brief.note);
    const when = sessionName(brief).replace(/^the /, "");
    if (/^no session/i.test(note)) return `No ${when}: ${lower(clause(note.replace(/^no session:?\s*/i, ""), 100)) || "the day's model budget was spent"}.`;
    if (!str(proposal.symbol) && !symbol) return `${cap(when)}: nobody on the crew had an idea that held up${reason ? `; ${name} noted: ${lower(clause(reason, 120))}` : ""}.`;
    const model = str(proposal.model);
    return `${cap(when)}: ${model ? modelLabel(model) : "the crew"} proposed ${symbol} ${p.side || "long"}; ${frontierBit() || "no verdict"}.`;
  }
  if (d.kind === "own") {
    const when = sessionName(brief).replace(/^the /, "");
    const play = str(proposal.strategy_name) || p.strategyId.replace(/^own:/, "").replace(/-/g, " ");
    return `${cap(when)}, its own playbook${play ? ` "${play}"` : ""} on ${symbol} ${p.side || "long"}: ${frontierBit() || `${name} brought it`}.`;
  }
  const trade = rec(brief.trade);
  if (verdict?.action === "tighten") {
    const oldStop = num(trade.stop), newStop = num(outcome.stop) ?? num(verdict.stop);
    const oldTarget = num(trade.target), newTarget = num(outcome.target) ?? num(verdict.target);
    const moved = [has(oldStop) && has(newStop) && newStop !== oldStop ? `the stop from ${px(oldStop)} to ${px(newStop)}` : "", has(oldTarget) && has(newTarget) && newTarget !== oldTarget ? `the target from ${px(oldTarget)} to ${px(newTarget)}` : ""].filter(Boolean);
    return `${name} tightened ${moved.join(" and ") || "the levels"}${reason ? `: ${lower(clause(reason, 120))}` : ""}.`;
  }
  const unreal = num(trade.unrealized);
  return `${name} asked to close it${has(unreal) ? ` at ${signedMoney(unreal)} on paper` : ""}${reason ? `: ${lower(clause(reason, 120))}` : ""}.`;
}

/* ── trades ────────────────────────────────────────────────────────────── */
const EXIT_WORDS: Record<string, string> = { stop: "was stopped out", target: "hit its target", time: "ran out of time and was closed", thesis_broke: "was closed early by the frontier", liquidated: "was liquidated", halt: "was closed by the desk's daily loss halt" };
const FILL_WORDS: Record<string, string> = { next_5m: "fills on the next 5-minute bar", next_hour: "fills on the next hourly candle" };
const REVIEW_WORDS: Record<string, string> = { held: "held", broke: "broke", unclear: "was unclear" };
const QUADRANT_WORDS: Record<string, string> = { earned: "earned it, good process and a good outcome", bad_luck: "bad luck, good process and a bad outcome", dumb_luck: "dumb luck, bad process and a good outcome", deserved: "deserved, bad process and a bad outcome" };
const hoursBetween = (a: string | null, b: string | null) => { if (!a || !b) return null; const h = (Date.parse(b) - Date.parse(a)) / 3_600_000; return Number.isFinite(h) ? h : null; };
const unitValue = (t: Trade) => (t.unit === "contract" ? t.contract_value : 1);
/** One R in dollars: the loss the stop would have taken. Read back from the result when there is one, so a tightened stop cannot skew it. */
function oneR(t: Trade): number {
  if (has(t.pnl) && has(t.r_multiple) && t.r_multiple !== 0) return Math.abs(t.pnl / t.r_multiple);
  return Math.abs((t.entry_price ?? t.entry_ref) - t.stop) * t.qty * unitValue(t);
}
function tradeOrder(t: Trade): Order {
  const k = rec(t.ticket);
  const price = t.entry_price ?? t.entry_ref;
  const rr = num(k.rr) ?? (Math.abs(t.entry_ref - t.stop) > 0 ? Math.abs(t.target - t.entry_ref) / Math.abs(t.entry_ref - t.stop) : null);
  return { side: t.side, qty: t.qty, unit: t.unit, price, stop: t.stop, target: t.target, rr };
}
const closeWords = (t: Trade) => EXIT_WORDS[t.exit_reason ?? ""] ?? "closed";
/** The frontier's reason for an early close, without the "the frontier closed it:" prefix the desk writes. */
function closeBecause(t: Trade): string {
  if (t.exit_reason !== "thesis_broke") return "";
  const why = (t.close_reason ?? "").replace(/^the (frontier|champion) closed it:?\s*/i, "").trim();
  return why ? `, because ${lower(clause(why, 120))}` : "";
}
/** "It hit its target at $2.90 after 1.8 days: +$312, or +1.8R (one R is what the stop would have lost, $173)." */
function resultSentence(t: Trade): string {
  const held = hoursBetween(t.entry_at, t.exit_at);
  const pnl = t.pnl ?? 0, r = t.r_multiple ?? 0;
  const review = rec(t.review);
  const verdict = str(review.verdict), quadrant = str(review.quadrant);
  const judged = verdict ? `; the review says the reasoning ${REVIEW_WORDS[verdict] ?? verdict}${QUADRANT_WORDS[quadrant] ? ` (${QUADRANT_WORDS[quadrant]})` : ""}` : "";
  return `It ${closeWords(t)}${has(t.exit_price) ? ` at ${px(t.exit_price)}` : ""}${held !== null && held > 0 ? ` after ${dur(held)}` : ""}${closeBecause(t)}: ${signedMoney(pnl)}, or ${fmtR(r)} (one R is what the stop would have lost, ${fmtMoney(oneR(t))})${judged}.`;
}
function stateSentence(t: Trade): string {
  if (t.status === "pending") return `It is queued and ${FILL_WORDS[t.fill_rule] ?? "fills at the next price"}; nothing is risked until it fills.`;
  if (t.status === "open") {
    const clock = t.horizon_hours ? ` and closes when its ${t.horizon_hours}-hour clock runs out if neither level is hit` : t.expires_on ? ` and closes by ${monthDay(t.expires_on)} at the latest if neither level is hit` : "";
    return `It is still running${clock}; nothing is banked until it closes.`;
  }
  if (t.status === "cancelled") return "The price the team wanted never came, so the order never filled: no trade, and nothing was risked.";
  return resultSentence(t);
}

/** Three or four plain sentences on one trade, for the top of an opened trade card. */
export function tradeInShort(trade: Trade, decision?: DecisionRow | null, team?: TeamRow | null): string {
  const t = trade;
  const s: string[] = [];
  const p = decision ? parts(decision) : null;
  const sid = t.strategy || p?.strategyId || "";
  const def = STRATEGIES.find((x) => x.id === sid);
  if (p && p.d.kind === "own") {
    const because = str(p.proposal.catalyst) || str(p.proposal.thesis) || t.catalyst || t.thesis;
    const play = str(p.proposal.strategy_name) || sid.replace(/^own:/, "").replace(/-/g, " ");
    s.push(`At ${sessionName(p.brief)} ${frontierWho(p.verdict, team)} ran its own playbook${play ? `, "${play}"` : ""}: ${t.symbol}, ${instrumentPhrase(t.instrument, t.symbol)}, ${t.side}${because ? `, because ${lower(clause(because, 150))}` : ""}.`);
  } else if (p && p.d.kind === "session") {
    const model = str(p.proposal.model);
    const because = str(p.proposal.catalyst) || str(p.proposal.thesis) || t.catalyst || t.thesis;
    s.push(`At ${sessionName(p.brief)} ${model ? modelLabel(model) : "a crew member"} proposed ${t.symbol}, ${instrumentPhrase(t.instrument, t.symbol)}, ${t.side}${because ? `, because ${lower(clause(because, 150))}` : ""}.`);
  } else if (sid.startsWith("own:")) {
    const why = t.catalyst || t.thesis;
    s.push(`The frontier went ${t.side} ${t.symbol}, ${instrumentPhrase(t.instrument, t.symbol)}, on its own playbook, "${sid.slice(4).replace(/-/g, " ")}"${why ? `, because ${lower(clause(why, 150))}` : ""}.`);
  } else if (sid || def) {
    s.push(scanSentence(t.symbol, t.instrument, t.side, sid, p ? str(rec(p.brief.strategy).name) : "", p ? str(rec(p.brief.strategy).what) : ""));
  } else {
    const why = t.catalyst || t.thesis;
    s.push(`The team went ${t.side} ${t.symbol}, ${instrumentPhrase(t.instrument, t.symbol)}${why ? `, because ${lower(clause(why, 150))}` : ""}.`);
  }
  const verdict = p?.verdict ?? null;
  // The crew's count and the frontier's stake in one sentence, so the whole trade stays at four.
  const crew = p && p.d.kind === "candidate" ? crewShort(p.workers) : "";
  const who = p ? frontierWho(verdict, team) : team?.frontier ? `${shortModel(team.frontier)}, the frontier,` : "The frontier";
  const risk = verdict && has(verdict.risk_pct) && verdict.risk_pct > 0 ? stake(verdict) : t.risk_pct > 0 ? ` with ${trim(t.risk_pct)}% of the book at risk${t.leverage > 1 ? ` and ${trim(t.leverage)}x leverage` : ""}` : "";
  s.push(crew ? `${cap(crew)} and ${who.replace(/^The frontier/, "the frontier")} took it${risk}.` : `${who} took it${risk}.`);
  if (t.status !== "cancelled") s.push(orderSentence(tradeOrder(t), t.status === "pending"));
  else s.push(`The desk queued an order to ${t.side === "short" ? "sell short" : "buy"} ${units(t.qty, t.unit)} near ${px(t.entry_ref)}.`);
  s.push(stateSentence(t));
  return s.join(" ");
}

/** One plain sentence for a trade row in the journal. */
export function tradeOneLine(trade: Trade, decision?: DecisionRow | null, team?: TeamRow | null): string {
  const t = trade;
  const p = decision ? parts(decision) : null;
  const o = tradeOrder(t);
  const name = frontierShort(p?.verdict ?? null, team);
  const crew = p && p.d.kind === "candidate" ? crewShort(p.workers) : "";
  const risk = t.risk_pct > 0 ? `, ${trim(t.risk_pct)}% at risk` : "";
  const head = `${crew ? `${cap(crew)}; ` : ""}${crew ? name : cap(name)} took it: ${orderShort(o)}${risk}`;
  let state: string;
  if (t.status === "pending") state = `queued, ${FILL_WORDS[t.fill_rule] ?? "fills at the next price"}`;
  else if (t.status === "open") state = "still running";
  else if (t.status === "cancelled") state = "never filled, so nothing was risked";
  else state = `${closeWords(t)} for ${signedMoney(t.pnl ?? 0)} (${fmtR(t.r_multiple ?? 0)})${closeBecause(t)}`;
  return `${head}; ${state}.`;
}

/* ── the "In short" block the opened cards lead with ───────────────────── */
export function InShort({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] px-2.5 py-2">
      <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">In short</p>
      <p className="text-[12px] leading-relaxed mt-0.5"><Lingo text={text} /></p>
    </div>
  );
}

/* ── headlines: the items the brief keeps, or the old one-line strings ──── */
/** Impact 1 to 5 as words. */
export const impactWords = (n: number) => (n >= 5 ? "can move the whole market today" : n === 4 ? "moves this name today" : n === 3 ? "context" : "minor");
export const directionTone = (d: string) => (d === "bullish" ? "var(--ok)" : d === "bearish" ? "var(--bad)" : d === "mixed" ? "var(--warn)" : "var(--text-4)");

function toItem(v: unknown): BriefNewsItem | null {
  const r = rec(v);
  const title = str(r.title).trim();
  if (!title) return null;
  return {
    title, plain: str(r.plain).trim(), why: str(r.why).trim(), impact: num(r.impact) ?? 0, direction: str(r.direction) || "none", category: str(r.category),
    published: str(r.published), tickers: list(r.tickers).map(String).filter(Boolean), source: str(r.source) || undefined,
  };
}
// The line the league function wrote before the items existed:
//   "Title (impact 4, bullish, macro: why)"  or  "[3] Title (stock, impact 4, bullish, earnings: why · NVDA AMD)"
const OLD_LINE = /^(?:\[\d+\]\s*)?(.*?)\s\((?:(?:stock|crypto|macro|none),\s)?impact\s(\d),\s([a-z]+),\s([a-z]+)(?::\s(.*?))?(?:\s·\s([A-Z0-9\-. ]+))?\)$/;
export function parseOldLine(line: string): BriefNewsItem {
  const m = OLD_LINE.exec(line.trim());
  if (!m) return { title: line.trim(), plain: "", why: "", impact: 0, direction: "none", category: "", published: "", tickers: [] };
  return { title: m[1], plain: "", why: (m[5] ?? "").trim(), impact: Number(m[2]), direction: m[3], category: m[4], published: "", tickers: (m[6] ?? "").split(/\s+/).filter(Boolean) };
}
/** The headlines under a key of the brief: `${key}_items` when the league kept them, else the old `${key}` strings parsed back into the same shape. */
export function newsOf(brief: Record<string, unknown> | null | undefined, key: "headlines" | "macro" | "digest"): BriefNewsItem[] {
  const b = rec(brief);
  const items = list(b[`${key.replace(/s$/, "")}_items`]).map(toItem).filter((x): x is BriefNewsItem => !!x);
  if (items.length) return items;
  return list(b[key]).map(String).filter((s) => s.trim()).map(parseOldLine);
}

/** A list of headlines: the title, what happened in plain words (the mechanism as a smaller line when it says something else), and one mono line of impact, direction and tickers. Long lists fold after a few. */
export function NewsList({ items, foldAfter = 3, foldLabel = "headlines" }: { items: BriefNewsItem[]; foldAfter?: number; foldLabel?: string }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all || items.length <= foldAfter + 1 ? items : items.slice(0, foldAfter);
  const hidden = items.length - shown.length;
  return (
    <div>
      {shown.map((x, i) => {
        const main = x.plain || x.why;
        const mechanism = x.plain && x.why && x.why.trim() !== x.plain.trim() ? x.why : "";
        const meta = [
          x.impact > 0 ? `impact ${x.impact}, ${impactWords(x.impact)}` : "",
          x.source ? x.source : "",
        ].filter(Boolean);
        return (
          <div key={i} className={`py-1.5 ${i === 0 ? "" : "border-t border-[var(--border-1)]"}`}>
            <p className="text-[11.5px] font-semibold leading-snug">{x.title}</p>
            {main && <p className="text-[11.5px] text-[var(--text-2)] leading-snug mt-0.5"><Lingo text={main} /></p>}
            {mechanism && <p className="text-[10.5px] text-[var(--text-4)] leading-snug mt-0.5">How it moves the price: {mechanism}</p>}
            {(meta.length > 0 || x.direction !== "none" || x.tickers.length > 0) && (
              <p className="mono text-[9px] text-[var(--text-4)] mt-0.5">
                {meta.join(" · ")}
                {x.direction && x.direction !== "none" ? <>{meta.length ? " · " : ""}<span style={{ color: directionTone(x.direction) }}>{x.direction}</span></> : null}
                {x.tickers.length ? ` · ${x.tickers.join(" ")}` : ""}
              </p>
            )}
          </div>
        );
      })}
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)} className="mono text-[10px] text-[var(--neon)] mt-0.5 active:scale-95">show all {items.length} {foldLabel}</button>
      )}
      {all && items.length > foldAfter + 1 && (
        <button type="button" onClick={() => setAll(false)} className="mono text-[10px] text-[var(--neon)] mt-0.5 active:scale-95">show fewer</button>
      )}
    </div>
  );
}
