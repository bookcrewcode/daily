"use client";

// Term — the desk's glossary. Every trading word is followed by its plain meaning in
// parentheses until Ben taps "got it"; learned terms live on the account row and in a
// small store here, so every parenthesis on every screen disappears at once.

import { useSyncExternalStore, type ReactNode } from "react";
import { updateAccount } from "@/lib/desk/api";

export type GlossaryEntry = {
  label: string;      // how the word is written when Term is used without children
  aliases?: string[]; // other spellings Lingo should recognise in running text
  meaning: string;    // one plain sentence, no jargon inside it
  auto?: false;       // set when the word is too common in plain English for Lingo to wrap on its own
};

/* ── the glossary, one place to edit ─────────────────────────────────────── */
export const GLOSSARY: Record<string, GlossaryEntry> = {
  rsi: { label: "RSI", aliases: ["relative strength index", "RSI(14)", "RSI14"], meaning: "relative strength index: a 0 to 100 gauge of how stretched the recent moves are; under 30 is washed out, over 70 is stretched" },
  rsi2: { label: "RSI(2)", aliases: ["RSI2", "two-day RSI"], meaning: "the relative strength index over just two days instead of fourteen, so it swings hard; under 10 means two days of heavy selling" },
  ema: { label: "EMA", aliases: ["exponential moving average", "EMA21", "EMA55", "20-day EMA", "hourly EMA21"], meaning: "exponential moving average: the average price of the last N bars, weighted to the newest, so it turns faster than a plain average" },
  ma20: { label: "20-day average", aliases: ["20-day moving average", "SMA20", "20-day SMA"], meaning: "the average closing price of the last 20 days; price above it means the trend is up over the last month" },
  ma50: { label: "50-day average", aliases: ["50-day", "SMA50", "50-day moving average"], meaning: "the average closing price of the last 50 days; price above it means the trend is up over the last two or three months" },
  ma200: { label: "200-day average", aliases: ["200-day", "SMA200", "200-day moving average"], meaning: "the average closing price of the last 200 days, about a year of trading; price above it means the long-term trend is up" },
  wk10: { label: "10-week average", aliases: ["10-week"], meaning: "the average weekly closing price of the last 10 weeks; a slow trend line that ignores daily noise" },
  wk40: { label: "40-week average", aliases: ["40-week"], meaning: "the average weekly closing price of the last 40 weeks, most of a year; the 10-week above it means the long trend is up" },
  atr: { label: "ATR", aliases: ["average true range", "ATRs", "ATR14"], meaning: "average true range: the size of a typical bar's move, used to set stops that survive normal noise" },
  perp: { label: "perp", aliases: ["perpetual", "perps", "perpetual future", "perpetual futures", "perpetual swap"], meaning: "a crypto futures contract with no expiry that tracks the coin's price and can be traded up or down with borrowed money" },
  funding: { label: "funding", aliases: ["funding rate", "funding rates"], meaning: "the fee longs and shorts pay each other every eight hours on a perp to keep it near the coin's real price; positive means longs pay" },
  leverage: { label: "leverage", aliases: ["leveraged"], meaning: "borrowing to hold a position bigger than the cash put up; 4x means a 1% move is 4% on the cash put up" },
  margin: { label: "margin", meaning: "the cash actually put up for a position held with borrowed money" },
  notional: { label: "notional", meaning: "the full size of the position: the cash put up multiplied by the leverage" },
  liq: { label: "liquidation price", aliases: ["liquidation", "liquidated", "liq"], meaning: "the price at which the exchange closes a leveraged position because the cash put up is gone" },
  stop: { label: "stop", aliases: ["stop loss", "stop-loss", "stopped out"], meaning: "the price at which the trade is closed for a loss because the idea is wrong" },
  target: { label: "target", meaning: "the price at which the trade takes its profit" },
  rr: { label: "reward-to-risk", aliases: ["R:R", "reward to risk", "reward/risk", "risk-reward", "risk/reward"], meaning: "target distance divided by stop distance; 2 means the win is twice the loss" },
  rmult: { label: "R multiple", aliases: ["R-multiple", "R multiples"], meaning: "the profit or loss measured in units of the risk taken; +2R won twice what the stop would have lost" },
  risk: { label: "risk per trade", aliases: ["risk on this trade", "risk on the trade"], meaning: "the share of the book lost if the stop is hit; the size is worked back from it" },
  heat: { label: "heat", aliases: ["open risk"], meaning: "the share of the book that would be lost if every open position hit its stop" },
  death: { label: "death line", meaning: "the book value at which a team dies, 5% below where it started" },
  ranked: { label: "ranked return", aliases: ["rank score"], meaning: "percent return minus a penalty for each passive day" },
  passive: { label: "passive day", aliases: ["passive days"], meaning: "a day with fewer than the minimum takes and less than the minimum at risk: playing to survive, which is penalised" },
  slippage: { label: "slippage", meaning: "the difference between the price you wanted and the price you got" },
  bps: { label: "basis points", aliases: ["bps", "basis point"], meaning: "hundredths of a percent; 25 bps is 0.25%" },
  fees: { label: "fees", meaning: "what the exchange charges to get in and out, taken off the book as real fees would be" },
  confluence: { label: "confluence score", aliases: ["confluence"], meaning: "how many of a strategy's checks lined up, as a percent" },
  regime: { label: "regime", meaning: "the market's overall mood: risk-on, risk-off, trending or choppy" },
  riskon: { label: "risk-on", meaning: "a mood where money chases return and the riskier things rise" },
  riskoff: { label: "risk-off", meaning: "a mood where money hides and the riskier things fall" },
  drawdown: { label: "drawdown", meaning: "the drop from the highest point of the book to now" },
  shadow: { label: "shadow book", aliases: ["rule-only book", "strategy book", "strategy books", "shadow books"], meaning: "the strategy's own $100,000 paper book that takes every setup mechanically; the benchmark the teams are measured against" },
  candidate: { label: "candidate", aliases: ["candidates"], meaning: "a setup the scan found and sent to the teams" },
  ballot: { label: "ballot", aliases: ["ballots"], meaning: "a worker's vote on a candidate, with its confidence and its reasoning" },
  verdict: { label: "verdict", aliases: ["verdicts"], meaning: "the frontier's decision on a candidate: take or pass" },
  ticket: { label: "ticket", meaning: "the full record of what went into an order, written the moment it was taken" },
  horizon: { label: "horizon", aliases: ["time stop"], meaning: "how long the trade is allowed to run before it is closed regardless of where the price is" },
  fill: { label: "fill", aliases: ["filled", "fill price"], meaning: "the price the order actually got" },
  excursion: { label: "excursion", aliases: ["MAE", "MFE", "against at worst", "for at best"], meaning: "how far the trade went against you (MAE) and for you (MFE) while it was open" },
  brier: { label: "Brier score", aliases: ["Brier"], meaning: "how well a model's confidence matched what happened; 0 is perfect, 0.25 is coin-flipping" },
  elo: { label: "Elo", meaning: "a rating that rises when a model beats the others' calls; everyone starts at 1500" },
  hit: { label: "hit rate", aliases: ["win rate"], meaning: "the share of trades that won" },
  meanr: { label: "mean R", meaning: "the average profit or loss across trades, in units of the risk taken on each" },
  shrunkr: { label: "shrunk R", meaning: "mean R pulled toward zero when there are few trades, so a lucky streak does not look like skill" },
  pf: { label: "profit factor", aliases: ["PF"], meaning: "everything won divided by everything lost; above 1 makes money" },
  momentum: { label: "momentum", meaning: "the tendency of what went up to keep going up for a while" },
  pullback: { label: "pullback", aliases: ["pullbacks"], meaning: "a dip inside an uptrend" },
  breakout: { label: "breakout", aliases: ["breakouts"], meaning: "a move above every recent high" },
  meanrev: { label: "mean reversion", aliases: ["mean-reversion"], meaning: "a snap back toward the average after a stretched move" },
  squeeze: { label: "squeeze", aliases: ["squeezed", "short squeeze"], meaning: "a fast move that forces the crowded side to close at a loss, which pushes the price further still" },
  trend: { label: "trend", aliases: ["uptrend", "downtrend", "trending"], meaning: "the direction prices have mostly moved over a period; an uptrend makes higher highs and higher lows" },
  volume: { label: "volume", meaning: "how much traded; heavy volume means real demand or supply" },
  candle: { label: "candle", aliases: ["bar", "candles", "bars", "candlestick"], meaning: "one period's open, high, low and close, drawn as one shape" },
  tick: { label: "tick", meaning: "the desk's five-minute heartbeat, when it checks prices, fills and stops" },
  session: { label: "session", aliases: ["sessions"], meaning: "one of the three daily reviews where the crew proposes ideas and each frontier reviews its positions" },
  frontier: { label: "frontier", aliases: ["frontiers", "frontier model"], meaning: "the strong model that decides for a team" },
  crew: { label: "crew", aliases: ["worker", "workers"], meaning: "the cheap models that research every candidate and vote; every team shares the same four" },
  tier: { label: "tier", aliases: ["tiers"], meaning: "Diamond, Gold or Bronze, by ranked return" },
  season: { label: "season", aliases: ["seasons"], meaning: "fourteen days; the top team at the end is the champion and the desk mirrors it" },
  champion: { label: "champion", meaning: "the top team at the end of a season; the desk copies its trades from then on" },
  desk: { label: "the desk", meaning: "Ben's own $100,000 paper book, which mirrors the champion; also the name of the whole system" },
  strategy: { label: "strategy", aliases: ["strategies"], meaning: "a fixed set of checks in code that flags a setup and sets its stop, target and clock" },
  setup: { label: "setup", aliases: ["setups"], meaning: "a moment where a strategy's checks line up on one symbol; the thing the scan flags" },
  scan: { label: "scan", meaning: "the code that runs every strategy's checks over the watchlist every fifteen minutes and flags setups" },
  watchlist: { label: "watchlist", meaning: "the fixed list of stocks and coins the scan reads" },
  entry: { label: "entry", aliases: ["entry price", "entry reference"], meaning: "the price the trade gets in at; until the order fills it is the plan's reference price" },
  equity: { label: "equity", meaning: "what the book is worth right now: cash plus open positions at today's prices" },
  unrealised: { label: "unrealised", aliases: ["unrealized", "open profit"], meaning: "profit or loss on paper that is not banked until the position closes" },
  gross: { label: "gross exposure", aliases: ["gross notional"], meaning: "the size of everything open added up, longs and shorts alike" },
  confidence: { label: "confidence", meaning: "how sure a model says it is that the target is hit before the stop, from 0 to 100 percent" },
  quadrant: { label: "quadrant", meaning: "process against outcome: earned, bad luck, dumb luck or deserved" },
  paper: { label: "paper money", aliases: ["paper trading", "paper book"], meaning: "not real money: the prices are real, the cash is imagined" },
  long: { label: "long", meaning: "a bet the price goes up: buy first, sell later", auto: false },
  short: { label: "short", meaning: "a bet the price goes down: sell first, buy back later", auto: false },
  book: { label: "book", meaning: "an account: the cash and the positions in it", auto: false },
  spot: { label: "spot price", aliases: ["spot crypto"], meaning: "the plain coin bought and held, as opposed to a contract on it" },
  contract: { label: "contract", meaning: "one unit of a perpetual future, worth a fixed amount of the coin", auto: false },
  process: { label: "process", meaning: "how well the trade was run, judged apart from how it turned out", auto: false },
};

/* ── the store: what Ben has learned, shared by every Term on the screen ─── */
const KEY = "desk_learned_terms";
const EMPTY: ReadonlySet<string> = new Set<string>();
const listeners = new Set<() => void>();
const pending = new Set<string>(); // marked here but not yet confirmed saved on the account
let owner = "";
let learned: ReadonlySet<string> = readLocal();

function readLocal(): ReadonlySet<string> {
  try {
    if (typeof window === "undefined") return EMPTY;
    const raw = window.localStorage.getItem(KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String).filter((id) => id in GLOSSARY) : []);
  } catch { return EMPTY; }
}
function writeLocal(s: ReadonlySet<string>) {
  try { window.localStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* private mode or no storage: the account row still has it */ }
}
function set(next: ReadonlySet<string>) {
  learned = next;
  writeLocal(next);
  for (const l of listeners) l();
}
async function persist() {
  if (!owner) return;
  const sent = [...learned];
  const r = await updateAccount(owner, { learned_terms: sent });
  if (!r.error) for (const id of sent) pending.delete(id);
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const getSnapshot = () => learned;
const getServerSnapshot = () => EMPTY;

/** The set of learned ids; every Term re-renders when it changes. */
export function useLearned(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
/** Called when the account row loads: the row is the record, plus anything marked here that has not saved yet. */
export function seedLearned(uid: string, terms: string[]) {
  owner = uid;
  const next = new Set([...terms.filter((id) => id in GLOSSARY), ...pending]);
  const same = next.size === learned.size && [...next].every((id) => learned.has(id));
  if (!same) set(next);
  if ([...pending].some((id) => !terms.includes(id))) void persist();
}
/** Ben tapped "got it": the parenthesis goes at once, the row saves in the background. */
export function markLearned(id: string) {
  if (!(id in GLOSSARY) || learned.has(id)) return;
  pending.add(id);
  set(new Set([...learned, id]));
  void persist();
}
/** Bring every meaning back. */
export function resetLearned() {
  pending.clear();
  set(EMPTY);
  if (owner) void updateAccount(owner, { learned_terms: [] });
}

/* ── one term: the word, its meaning until learned, and the button ───────── */
export function Term({ id, children }: { id: string; children?: ReactNode }) {
  const known = useLearned();
  const g = GLOSSARY[id];
  const label = children ?? g?.label ?? id;
  if (!g || known.has(id)) return <>{label}</>;
  return (
    <span>
      {label}
      <span className="text-[var(--text-4)] font-normal"> ({g.meaning})</span>{" "}
      <button type="button" onClick={() => markLearned(id)} aria-label={`Got it: ${g.label}`}
        className="inline-flex items-center align-middle min-h-7 -my-1 px-1.5 rounded mono text-[9px] uppercase tracking-wider text-[var(--neon)] bg-[var(--neon)]/10 active:scale-95">
        got it
      </button>
    </span>
  );
}

/* ── Lingo: wrap the first occurrence of each known term in running text ─── */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Every spelling Lingo may wrap, longest first so "stop loss" beats "stop" and "RSI(2)" beats "RSI". */
function autoAliases(): { alias: string; id: string }[] {
  const out: { alias: string; id: string }[] = [];
  const taken = new Set<string>();
  for (const [id, g] of Object.entries(GLOSSARY)) {
    if (g.auto === false) continue;
    for (const alias of [g.label, ...(g.aliases ?? [])]) {
      const k = alias.toLowerCase();
      if (taken.has(k)) continue;
      taken.add(k);
      out.push({ alias, id });
    }
  }
  return out.sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));
}
const AUTO = autoAliases();
const BY_ALIAS = new Map(AUTO.map((a) => [a.alias.toLowerCase(), a.id]));
// A term must stand on its own: no letter or digit right before or after it. The leading
// group stands in for a look-behind, which the build target does not have.
const LINGO_SRC = `(^|[^A-Za-z0-9])(${AUTO.map((a) => escapeRe(a.alias)).join("|")})(?![A-Za-z0-9])`;

/** The pieces of a string with the first mention of each term wrapped in a Term. `seen` carries across calls so a whole panel explains each word once. */
export function lingo(text: string, seen: Set<string>, keyBase = ""): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(LINGO_SRC, "gi");
  let last = 0, k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[1].length;
    const word = m[2];
    const id = BY_ALIAS.get(word.toLowerCase());
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (start > last) out.push(text.slice(last, start));
    out.push(<Term key={`${keyBase}t${k++}`} id={id}>{word}</Term>);
    last = start + word.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Lingo({ text }: { text: string }) {
  return <>{lingo(text ?? "", new Set<string>())}</>;
}

/* ── LingoProse: the study-prose look with **bold** kept and every term explained once ── */
function inline(line: string, seen: Set<string>, keyBase: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0, i = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) parts.push(...lingo(line.slice(last, m.index), seen, `${keyBase}-${i++}`));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("**")) parts.push(<strong key={key}>{lingo(tok.slice(2, -2), seen, `${key}b`)}</strong>);
    else if (tok.startsWith("`")) parts.push(<code key={key} className="px-1 rounded bg-white/10 text-[0.88em] font-mono">{tok.slice(1, -1)}</code>);
    else parts.push(<em key={key}>{lingo(tok.slice(1, -1), seen, `${key}e`)}</em>);
    last = m.index + tok.length;
  }
  if (last < line.length) parts.push(...lingo(line.slice(last), seen, `${keyBase}-${i++}`));
  return parts;
}

export function LingoProse({ text, className = "" }: { text: string; className?: string }) {
  const seen = new Set<string>();
  const paras = (text ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className={`study-prose ${className}`}>
      {paras.map((p, i) => {
        if (/^#{1,3}\s/.test(p)) return <h3 key={i}>{p.replace(/^#{1,3}\s+/, "")}</h3>;
        const lines = p.split(/\n/);
        return (
          <p key={i}>
            {lines.map((line, j) => (
              <span key={j}>{inline(line, seen, `p${i}-${j}`)}{j < lines.length - 1 ? <br /> : null}</span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
