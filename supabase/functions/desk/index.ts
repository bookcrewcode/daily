// desk — the jury. The gateway cuts any invocation at 150s, so no call ever
// waits on a model: a stage LAUNCHES one child invocation per juror (mode
// "juror", one model call each, ≤125s) and the next tick COLLECTS their
// opinion rows. packet → round1 → round2 → judge (+ guardrails, orders,
// shadow trades). The cron fires every five minutes across the window and
// the app's button polls every 15s; a stage already done is never repeated.
// A silent juror is relaunched once after four minutes, then given up on.
//
// The models propose and argue. Code counts the votes (lib/vote.ts) and code
// sizes every position (lib/rules.ts). The judge can veto or cut, never add.
//
// verify_jwt=false at the gateway; callers checked here: Ben's JWT, the cron's
// vault secret (desk_cron_secret), or the service role.

import type { Instrument, InstrumentMeta, Plan, PresetKey, Rules, TapeCard, Trade, Venue } from "./lib/types.ts";
import { instrumentOf, isMajorCrypto } from "./lib/types.ts";
import { etDate } from "./lib/clock.ts";
import { drawdownHalved, liqPrice, rulesFor } from "./lib/risk.ts";
import { guardrail, type GuardCtx } from "./lib/rules.ts";
import { equalWeights, tally, type Ballot, type Weight } from "./lib/vote.ts";
import { ORGANISING_RULE, playbookForPrompt, templateName } from "./lib/playbook.ts";
import { cardLine } from "./lib/ta.ts";
import { slippageBps } from "./lib/ledger.ts";
import type { CalibBin } from "./lib/stats.ts";
import { STRATEGIES } from "./lib/scan.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ENV_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const TAPE = `${SUPABASE_URL}/functions/v1/tape`;
const OR = "https://openrouter.ai/api/v1/chat/completions";
const SHADOW_START = 100000;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
type J = Record<string, unknown>;
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v: unknown, max = 2000): string => String(v ?? "").slice(0, max);

async function rest(path: string, init?: RequestInit): Promise<{ ok: boolean; json: unknown; status: number }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...svcH, ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) console.error(`[desk] rest ${r.status} ${path} ${text.slice(0, 200)}`);
  return { ok: r.ok, json, status: r.status };
}
async function secret(name: string): Promise<string> {
  const r = await rest("rpc/get_secret", { method: "POST", body: JSON.stringify({ secret_name: name }) });
  return r.ok && typeof r.json === "string" ? r.json : "";
}
async function tape(uid: string, body: J, ms = 90000): Promise<J> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(TAPE, { method: "POST", headers: svcH, body: JSON.stringify({ ...body, userId: uid }), signal: ctl.signal });
    return (await r.json()) as J;
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  finally { clearTimeout(t); }
}

/* ── OpenRouter ────────────────────────────────────────────────────────── */
type Call = { model: string; system: string; user: string; schema: { name: string; schema: J }; maxTokens: number; deadline?: number };
type Result = { json: J | null; raw: string; cost: number; tokensIn: number; tokensOut: number; latency: number; error: string };
function parseJson(raw: string): J | null {
  const s = raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "");
  try { return JSON.parse(s) as J; } catch { /* salvage */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) as J; } catch { /* give up */ } }
  return null;
}
async function callModel(key: string, c: Call): Promise<Result> {
  const t0 = Date.now();
  let totalCost = 0, tokensIn = 0, tokensOut = 0;
  const once = async (o: { schema: boolean; reasoning: boolean; maxTokens: number }) => {
    const system = o.schema ? c.system : `${c.system}\n\nReturn ONLY a JSON object matching this JSON Schema, no prose:\n${JSON.stringify(c.schema.schema)}`;
    const body: J = { model: c.model, messages: [{ role: "system", content: system }, { role: "user", content: c.user }], max_tokens: o.maxTokens };
    if (o.reasoning) body.reasoning = { effort: "low", exclude: true };
    if (o.schema) { body.response_format = { type: "json_schema", json_schema: { name: c.schema.name, strict: true, schema: c.schema.schema } }; body.provider = { require_parameters: true }; }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.max(5_000, Math.min(110_000, (c.deadline ?? Infinity) - Date.now())));
    try {
      const r = await fetch(OR, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://bookcrewcode.github.io/daily/", "X-Title": "Daily Desk" }, body: JSON.stringify(body), signal: ctl.signal });
      const text = await r.text();
      let d: J | null = null;
      try { d = JSON.parse(text) as J; } catch { /* keep text */ }
      const usage = (d?.usage ?? {}) as J;
      totalCost += num(usage.cost); tokensIn += num(usage.prompt_tokens); tokensOut += num(usage.completion_tokens);
      const content = String((((d?.choices as J[]) ?? [])[0]?.message as J)?.content ?? "");
      return { status: r.status, text, content };
    } catch (e) { return { status: 0, text: e instanceof Error ? e.message : String(e), content: "" }; }
    finally { clearTimeout(t); }
  };
  let o = { schema: true, reasoning: true, maxTokens: c.maxTokens };
  let last = { status: 0, text: "", content: "" };
  for (let i = 0; i < 4; i++) {
    last = await once(o);
    if (last.status === 200 && last.content.trim()) {
      const json = parseJson(last.content);
      return { json, raw: last.content.slice(0, 4000), cost: totalCost, tokensIn, tokensOut, latency: Date.now() - t0, error: json ? "" : "unparseable answer" };
    }
    if (last.status === 402) return { json: null, raw: "", cost: totalCost, tokensIn, tokensOut, latency: Date.now() - t0, error: "OpenRouter credits are out" };
    if (c.deadline && c.deadline - Date.now() < 15_000) break; // no time left for another attempt
    const msg = last.text.slice(0, 300);
    if (o.schema && (last.status === 503 || (last.status === 400 && /response_format|json_schema|structured|schema/i.test(msg)))) { o = { ...o, schema: false }; continue; }
    if (o.reasoning && last.status >= 400 && last.status < 500 && /reasoning/i.test(msg)) { o = { ...o, reasoning: false }; continue; }
    if (last.status === 200 && !last.content.trim() && o.maxTokens < c.maxTokens * 4) { o = { ...o, maxTokens: o.maxTokens * 2 }; continue; }
    if (last.status === 0 || last.status >= 500) { if (i === 0) continue; }
    break;
  }
  return { json: null, raw: last.text.slice(0, 1000), cost: totalCost, tokensIn, tokensOut, latency: Date.now() - t0, error: last.status ? `HTTP ${last.status}: ${last.text.slice(0, 160)}` : `network: ${last.text.slice(0, 120)}` };
}

/* ── schemas ───────────────────────────────────────────────────────────── */
const PROPOSAL = {
  type: "object", additionalProperties: false,
  required: ["venue", "instrument", "symbol", "side", "leverage", "template", "thesis", "catalyst", "what_would_prove_me_wrong", "entry_ref", "stop", "target", "horizon_days", "risk_pct", "confidence", "evidence", "key_risks", "crosses_event"],
  properties: {
    venue: { type: "string", enum: ["robinhood", "blofin"] }, instrument: { type: "string", enum: ["stock", "etf", "crypto_spot", "crypto_perp"] },
    symbol: { type: "string" }, side: { type: "string", enum: ["long", "short"] }, leverage: { type: "number" }, template: { type: "integer" },
    thesis: { type: "string" }, catalyst: { type: "string" }, what_would_prove_me_wrong: { type: "string" },
    entry_ref: { type: "number" }, stop: { type: "number" }, target: { type: "number" }, horizon_days: { type: "integer" }, risk_pct: { type: "number" },
    confidence: { type: "number" }, evidence: { type: "array", items: { type: "integer" } }, key_risks: { type: "array", items: { type: "string" } }, crosses_event: { type: "boolean" },
  },
};
const R1_SCHEMA = { name: "proposals", schema: { type: "object", additionalProperties: false, required: ["market_read", "no_trade", "no_trade_reason", "proposals"], properties: { market_read: { type: "string" }, no_trade: { type: "boolean" }, no_trade_reason: { type: "string" }, proposals: { type: "array", items: PROPOSAL } } } };
const R2_SCHEMA = { name: "ballots", schema: { type: "object", additionalProperties: false, required: ["ballots", "change_my_mind"], properties: { ballots: { type: "array", items: { type: "object", additionalProperties: false, required: ["proposal_id", "stance", "confidence", "counter"], properties: { proposal_id: { type: "string" }, stance: { type: "string", enum: ["support", "oppose", "abstain"] }, confidence: { type: "number" }, counter: { type: "string" } } } }, change_my_mind: { type: "string" } } } };
const JUDGE_SCHEMA = { name: "verdict", schema: { type: "object", additionalProperties: false, required: ["narrative", "decisions", "why_not", "lesson"], properties: { narrative: { type: "string" }, decisions: { type: "array", items: { type: "object", additionalProperties: false, required: ["proposal_id", "action", "size_multiplier", "leverage", "reason"], properties: { proposal_id: { type: "string" }, action: { type: "string", enum: ["take", "veto", "cut"] }, size_multiplier: { type: "number" }, leverage: { type: "number" }, reason: { type: "string" } } } }, why_not: { type: "array", items: { type: "object", additionalProperties: false, required: ["proposal_id", "reason"], properties: { proposal_id: { type: "string" }, reason: { type: "string" } } } }, lesson: { type: "string" } } } };

/* ── packet ────────────────────────────────────────────────────────────── */
type Item = { i: number; section: string; headline: string; why: string; thesis: string; url: string; exposure: string; tickers: string[] };
type Packet = {
  launched?: Record<string, Record<string, { at: number; n: number }>>;
  day: string; regime: string; briefing: Item[]; context: string[]; cards: Record<string, string>; cardObj: Record<string, TapeCard>;
  movers: string[]; calendar: string[]; universe_note: string; book: J; card: J | null; lessons: string[]; jurors: { juror: string; model: string }[];
  rules: Rules; sectors: Record<string, string>; validated: Record<string, { instrument: Instrument; venue: Venue; name: string; meta: InstrumentMeta; largeCap: boolean; sector: string }>;
  setups?: string[]; // phase 5: what the technical scan has on the table tonight
};
const ETF_THEME: Record<string, string> = { XLE: "Energy", USO: "Energy", OIH: "Energy", XOP: "Energy", BNO: "Energy", TLT: "Rates", IEF: "Rates", TBT: "Rates", SHY: "Rates", GLD: "Metals", SLV: "Metals", GDX: "Metals", SPY: "Index", QQQ: "Index", IWM: "Index", DIA: "Index", VOO: "Index", XLF: "Financials", KRE: "Financials", SMH: "Semis", SOXX: "Semis", XLK: "Tech", XLV: "Health", XLU: "Utilities", XLP: "Staples", XLY: "Discretionary", UUP: "Dollar", IBIT: "crypto", FBTC: "crypto", BITO: "crypto", ETHA: "crypto", MCHI: "China", FXI: "China", EEM: "EM" };

async function buildPacket(uid: string, day: string, rules: Rules, acct: J, open: Trade[]): Promise<Packet | { error: string }> {
  const bR = await rest(`world_briefings?user_id=eq.${uid}&day=eq.${day}&select=lede,sections`);
  const brief = (bR.ok ? (bR.json as J[]) : [])[0];
  const items: Item[] = [];
  for (const sec of ((brief?.sections as J[]) ?? [])) {
    for (const it of (sec.items as J[]) ?? []) {
      const ex = ((it.exposure as J[]) ?? []).map((e) => ({ t: str(e.ticker, 8).toUpperCase(), d: str(e.dir, 10), n: str(e.note, 140) })).filter((e) => /^[A-Z][A-Z.\-]{0,5}$/.test(e.t));
      items.push({ i: items.length, section: str(sec.key, 20), headline: str(it.headline, 220), why: str(it.why, 600), thesis: str(it.thesis, 400), url: str(((it.sources as J[]) ?? [])[0]?.url, 400), exposure: ex.map((e) => `${e.t} (${e.d}: ${e.n})`).join("; "), tickers: ex.map((e) => e.t) });
    }
  }
  // The feed: the strongest tagged headlines of the last 24 hours, so the nightly jury reads what the sits read.
  // With no briefing at all the feed is the whole packet; with one it adds what the briefing missed.
  const feedR = await rest(`desk_news?tagged=eq.true&impact=gte.3&published=gte.${new Date(Date.now() - 24 * 3_600_000).toISOString()}&select=title,link,tickers,venue,category,impact,direction,horizon,why&order=impact.desc,published.desc&limit=${brief ? 25 : 45}`);
  const seen = new Set(items.map((x) => x.headline.toLowerCase().slice(0, 60)));
  const perpWanted: { symbol: string; venue: Venue }[] = [];
  for (const n of (feedR.ok ? (feedR.json as J[]) : [])) {
    const headline = str(n.title, 220);
    const k = headline.toLowerCase().slice(0, 60);
    if (!headline || seen.has(k)) continue;
    seen.add(k);
    const tickers = (Array.isArray(n.tickers) ? (n.tickers as unknown[]) : []).map((t) => String(t).toUpperCase()).filter((t) => /^[A-Z][A-Z.\-]{0,6}$/.test(t)).slice(0, 6);
    if (n.venue === "crypto") for (const t of tickers) perpWanted.push({ symbol: `${t}-USDT`, venue: "blofin" });
    items.push({ i: items.length, section: `feed · ${str(n.category, 20)} · impact ${num(n.impact)}/5`, headline, why: str(n.why, 600), thesis: `${str(n.direction, 10)} for ${str(n.horizon, 10) === "scalp" ? "hours" : str(n.horizon, 10) === "position" ? "weeks" : "days"}`, url: str(n.link, 400), exposure: tickers.join(", "), tickers: n.venue === "crypto" ? [] : tickers });
  }
  if (!items.length) return { error: `Nothing to read for ${day}: no briefing and an empty feed. Pull the feed, or build the briefing on the Card, then run again.` };
  const tickers = [...new Set(items.flatMap((x) => x.tickers))];
  const wanted: { symbol: string; venue: Venue }[] = [...tickers.map((s) => ({ symbol: s, venue: "robinhood" as Venue })), ...open.map((t) => ({ symbol: t.symbol, venue: t.venue })), ...perpWanted].slice(0, 60);
  const [ctx, snap, movers, cal, instR, cardR, lessonR, setR] = await Promise.all([
    tape(uid, { mode: "context" }), tape(uid, { mode: "snapshot", symbols: wanted }), tape(uid, { mode: "movers" }, 40000), tape(uid, { mode: "calendar", days: 7, symbols: tickers }, 60000),
    rest("desk_instruments?select=base,max_leverage&state=eq.live&order=vol_24h_usd.desc&limit=1000"),
    rest(`desk_cards?user_id=eq.${uid}&select=card,review&order=week_start.desc&limit=1`),
    rest(`desk_lessons?user_id=eq.${uid}&status=eq.active&select=text&order=applied_count.desc&limit=10`),
    rest(`desk_setups?user_id=eq.${uid}&expires_at=gte.${new Date().toISOString()}&timeframe=in.(swing,position)&status=in.(new,held,sit,passed)&select=strategy,symbol,side,timeframe,entry_ref,stop,target,score,status&order=score.desc,created_at.desc&limit=25`),
  ]);
  const SETUP_STATUS: Record<string, string> = { new: "fresh, no jury yet", held: "already on the book", sit: "a sit is running", passed: "the sit jury passed on it" };
  const setups = (setR.ok ? (setR.json as J[]) : []).map((s) => `${s.symbol} ${s.side} · ${s.strategy} (${s.timeframe}) · ref ${num(s.entry_ref)} stop ${num(s.stop)} target ${num(s.target)} · confluence ${(num(s.score) * 100).toFixed(0)}% · ${SETUP_STATUS[String(s.status)] ?? String(s.status)}`);
  const cardObj: Record<string, TapeCard> = {};
  const cards: Record<string, string> = {};
  for (const c of ((ctx.cards as TapeCard[]) ?? [])) { cardObj[c.symbol] = c; }
  for (const [s, c] of Object.entries((snap.cards as Record<string, TapeCard | { error: string }>) ?? {})) if ("price" in c) cardObj[s] = c;
  for (const [s, c] of Object.entries(cardObj)) cards[s] = cardLine(c);
  const context = ((ctx.cards as TapeCard[]) ?? []).map(cardLine);
  const mv = movers as { volume?: J[]; movers?: J[] };
  const moverLines = [
    ...((mv.volume ?? []).slice(0, 15).map((m) => `${m.inst_id} $${num(m.last)} 24h ${(num(m.change24h) * 100).toFixed(1)}% vol $${(num(m.vol24hUsd) / 1e6).toFixed(0)}M maxlev ${m.maxLeverage}x`)),
    ...((mv.movers ?? []).slice(0, 10).map((m) => `${m.inst_id} $${num(m.last)} 24h ${(num(m.change24h) * 100).toFixed(1)}% (mover)`)),
  ];
  const calendar = (((cal.events as J[]) ?? []).map((e) => `${rel(String(e.day), day)}${e.time_et ? ` ${e.time_et} ET` : ""}: ${e.label}`));
  const bases = (instR.ok ? (instR.json as J[]) : []).map((x) => String(x.base));
  const universe_note = `${bases.length} USDT-margined perpetuals on BloFin (write them as BASE-USDT, e.g. SOL-USDT): ${bases.join(" ")}`;
  const cardRow = (cardR.ok ? (cardR.json as J[]) : [])[0] ?? null;
  const lessons = (lessonR.ok ? (lessonR.json as J[]) : []).map((l) => String(l.text));
  const book = {
    equity: num(acct.equity), cash: num(acct.cash), halted: !!acct.halted_until && String(acct.halted_until) >= day, halt_reason: str(acct.halt_reason, 200),
    gross: open.reduce((a, t) => a + t.notional, 0),
    positions: open.map((t) => `${t.symbol} ${t.side}${t.instrument === "crypto_perp" ? ` ${t.leverage}x` : ""} ${t.status} entry ${t.entry_price ?? t.entry_ref} stop ${t.stop} target ${t.target} notional $${t.notional.toFixed(0)}${t.expires_on ? ` until ${t.expires_on.slice(0, 10)}` : ""}`),
  };
  return { day, regime: str(ctx.regime, 60), briefing: items, context, cards, cardObj, movers: moverLines, calendar, universe_note, book, card: cardRow ? (cardRow.card as J) : null, lessons, jurors: [], rules, sectors: {}, validated: {}, setups };
}

function rel(d: string, today: string): string {
  const n = Math.round((Date.parse(d + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 86_400_000);
  const dow = new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return n === 0 ? "today" : n === 1 ? `tomorrow (${dow})` : n > 1 ? `in ${n} days (${dow})` : `${-n} days ago`;
}

function packetText(p: Packet): string {
  const brief = p.briefing.map((it) => `[${it.i}] (${it.section}) ${it.headline}\n    why: ${it.why}\n    read: ${it.thesis}${it.exposure ? `\n    exposure: ${it.exposure}` : ""}`).join("\n");
  const cardLines = Object.entries(p.cards).filter(([s]) => !p.context.some((c) => c.startsWith(s + " "))).map(([, l]) => l).join("\n");
  const b = p.book as { equity: number; cash: number; halted: boolean; halt_reason: string; gross: number; positions: string[] };
  const card = p.card ? `\n\nYOUR TRACK RECORD (measured, shrunk toward zero for small samples)\n${JSON.stringify(p.card).slice(0, 3000)}` : "\n\nYOUR TRACK RECORD: no closed trades yet. Every proposal tonight is scored later.";
  const lessons = p.lessons.length ? `\n\nACTIVE LESSONS (earned, not assumed)\n${p.lessons.map((l) => `- ${l}`).join("\n")}` : "";
  const setups = `\n\nSETUPS FROM THE TECHNICAL SCAN (coded rules on the daily and weekly tape; candidates for you too)\n${(p.setups ?? []).join("\n") || "(nothing on the table)"}`;
  return `MARKET CONTEXT (regime: ${p.regime})\n${p.context.join("\n")}\n\nTONIGHT'S NEWS (cite by [index])\n${brief}\n\nTAPE CARDS (symbols the news touches and open positions)\n${cardLines || "(none)"}\n\nCRYPTO PERPS: TOP VOLUME AND MOVERS (24h)\n${p.movers.join("\n") || "(unavailable)"}${setups}\n\nCALENDAR (next 7 days)\n${p.calendar.join("\n") || "(nothing scheduled)"}\n\nTHE BOOK\nequity $${b.equity.toFixed(0)} · cash $${b.cash.toFixed(0)} · gross notional $${b.gross.toFixed(0)}${b.halted ? ` · HALTED: ${b.halt_reason}` : ""}\n${b.positions.length ? b.positions.join("\n") : "no open positions"}${card}${lessons}`;
}

function r1System(p: Packet, openSyms: string[]): string {
  const r = p.rules;
  return `You are one juror on a paper-trading desk run by Ben, 19, who is learning markets by watching you. Tonight you read the news and the tape and propose the best trades, or none.
Paper money, real prices. Your proposals are scored later against what actually happened, and your stated confidence is scored for calibration, so say what you believe, not what sounds decisive.

WHAT YOU MAY TRADE: any US-listed stock or ETF on Robinhood (long or short); Robinhood crypto spot (long only, symbols like BTC-USD); any of these perpetuals on BloFin, long or short, leverage up to ${r.max_leverage}x: ${p.universe_note}
RULES THE DESK ENFORCES (propose inside them): risk per trade ≤ ${r.risk_pct}% of equity, measured as the distance from entry to your stop; reward:risk ≥ ${r.min_rr}; stop at least ${r.min_stop_atr}×ATR from entry; notional per position ≤ ${r.max_notional_pct}% of equity; at most ${r.max_new_per_night} new positions tonight; nothing already open (${openSyms.join(", ") || "none"}); a perp's stop must sit well inside its liquidation price.
THE ORGANISING RULE: ${ORGANISING_RULE}
THE PLAYBOOK (name the template number you are using; 0 if none fits):
${playbookForPrompt()}

HOW TO PROPOSE
- 0 to 3 proposals. "no_trade": true with a reason is a respected answer and is scored as one: when nothing has a clear mechanism from a story to a price, say so.
- Cite evidence by [index] from the news list. A proposal with no evidence index is a guess.
- The technical scan's setups are candidates too: take one when the news and the tape agree with it, at its levels or tighter, and say which check convinced you. A setup with no story behind it is still a guess.
- entry_ref is the current price on the tape card (or your best read of it for a symbol without a card). Stops and targets are prices, not percentages.
- confidence is your probability, 0 to 1, that the target is hit before the stop within the horizon. Calibration is tracked per model.
- "what_would_prove_me_wrong" must be observable within days: a price, a data print, a headline.
- If a trade crosses a scheduled event in the calendar, set crosses_event true and say why that is acceptable.
- Prefer the mechanism over the vibe: what in the story reaches revenue, costs, rates, flows or supply, and over what horizon.
Return ONLY JSON matching the schema.`;
}

function proposalsText(props: { id: string; plan: Plan; juror: string }[]): string {
  return props.map(({ id, plan: p }) => `[${id}] ${p.symbol} ${p.side}${p.instrument === "crypto_perp" ? ` ${p.leverage}x` : ""} (${p.venue}) ref ${p.entry_ref} stop ${p.stop} target ${p.target} · ${p.horizon_days}d · risk ${p.risk_pct}% · conf ${(p.confidence * 100).toFixed(0)}% · template ${p.template ? `${p.template} ${templateName(p.template)}` : "none"}${p.crosses_event ? " · crosses an event" : ""}\n    thesis: ${p.thesis}\n    catalyst: ${p.catalyst}\n    wrong if: ${p.falsifier}\n    risks: ${p.key_risks.join("; ")}`).join("\n");
}

/* ── session helpers ───────────────────────────────────────────────────── */
async function patchSession(id: string, patch: J): Promise<boolean> {
  const r = await rest(`desk_sessions?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
  return r.ok;
}
async function saveOpinion(uid: string, sessionId: string, model: string, juror: string, round: string, res: Result, content: J, sitId?: string): Promise<void> {
  await rest("desk_opinions", { method: "POST", body: JSON.stringify({ user_id: uid, session_id: sessionId || null, sit_id: sitId ?? null, model, juror, round, content, raw: res.raw.slice(0, 4000), latency_ms: res.latency, cost_usd: res.cost, tokens_in: res.tokensIn, tokens_out: res.tokensOut, error: res.error }) });
}
function seededShuffle<T>(arr: T[], seed: string): T[] {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; const j = h % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const LETTERS = "ABCDEFGHIJKLMNOP";

function normalizeProposal(raw: J, cards: Record<string, TapeCard>): { plan: Plan; dropped: string } {
  const venue: Venue = raw.venue === "blofin" ? "blofin" : "robinhood";
  let symbol = str(raw.symbol, 20).toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9.\-^]/g, "");
  if (venue === "blofin") { if (!symbol.includes("-")) symbol = `${symbol}-USDT`; symbol = symbol.replace(/-(USD|USDC|PERP)$/, "-USDT"); }
  const instrument: Instrument = venue === "blofin" ? "crypto_perp" : (raw.instrument === "crypto_spot" || /-USD$/.test(symbol)) ? "crypto_spot" : raw.instrument === "etf" ? "etf" : "stock";
  const side = raw.side === "short" ? "short" : "long";
  const card = cards[symbol];
  const plan: Plan = {
    venue, instrument, symbol, side, leverage: instrument === "crypto_perp" ? Math.max(1, num(raw.leverage, 1)) : 1,
    template: Math.max(0, Math.min(12, Math.floor(num(raw.template, 0)))), thesis: str(raw.thesis, 700), catalyst: str(raw.catalyst, 300), falsifier: str(raw.what_would_prove_me_wrong, 400),
    confidence: Math.min(0.99, Math.max(0.01, num(raw.confidence, 0.5))), entry_ref: card ? card.price : num(raw.entry_ref), stop: num(raw.stop), target: num(raw.target),
    horizon_days: Math.max(1, Math.min(60, Math.floor(num(raw.horizon_days, 10)))), risk_pct: num(raw.risk_pct, 3),
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).map((n) => Math.floor(num(n, -1))).filter((n) => n >= 0).slice(0, 8),
    key_risks: (Array.isArray(raw.key_risks) ? raw.key_risks : []).map((s) => str(s, 160)).slice(0, 5), crosses_event: raw.crosses_event === true,
  };
  let dropped = "";
  if (!symbol || !/^[\^A-Z0-9.\-]{1,14}$/.test(symbol)) dropped = "no usable symbol";
  else if (!(plan.entry_ref > 0) || !(plan.stop > 0) || !(plan.target > 0)) dropped = "missing prices";
  else if (side === "long" ? !(plan.stop < plan.entry_ref && plan.target > plan.entry_ref) : !(plan.stop > plan.entry_ref && plan.target < plan.entry_ref)) dropped = "stop or target on the wrong side of entry";
  else if (instrument === "crypto_spot" && side === "short") dropped = "spot crypto cannot be shorted; propose the BloFin perp";
  return { plan, dropped };
}

/* ── proposals that survived round 1 ──────────────────────────────────── */
type Live = { id: string; juror: string; model: string; plan: Plan };
function liveFrom(r1: J[]): Live[] {
  const live: Live[] = [];
  for (const o of r1) for (const raw of (((o.content as J)?.proposals as J[]) ?? [])) {
    if (raw.dropped) continue;
    live.push({ id: String(raw.id), juror: String(o.juror), model: String(o.model), plan: { ...(raw as unknown as Plan), falsifier: str(raw.what_would_prove_me_wrong ?? raw.falsifier, 400) } });
  }
  return live;
}
const JUDGE_FALLBACK = "anthropic/claude-opus-5";
const judgeModelOf = (acct: J) => /^[a-z0-9.-]+\/[a-z0-9.:_-]+$/i.test(String(acct.judge)) ? String(acct.judge) : JUDGE_FALLBACK;
const R2_SYSTEM = `You are a juror reviewing the other jurors' proposals on a paper-trading desk. Labels are anonymous. For EVERY proposal listed, give your stance (support, oppose or abstain), your confidence 0-1 that its target is hit before its stop within its horizon, and in "counter" the strongest argument AGAINST it in one or two sentences, even for ones you support. Vote on the mechanism, the level and the size, not on tone. Then say in one line what would change your mind tonight. Return ONLY JSON matching the schema.`;
const JUDGE_SYSTEM = `You are the judge on a paper-trading desk. The jurors proposed and voted; code counted the votes; code will size every position. You may VETO a candidate or CUT it (size_multiplier below 1, or a lower leverage) with a stated reason. You may NOT add a trade or a symbol, and you may not take a proposal that is not a candidate. "take" means take it as sized by the rules.
Write for Ben, 19, learning markets: "narrative" = what the desk is doing tonight and why, in plain words (no advice framing, no hedging boilerplate); one "why_not" per proposal that is not being taken, naming the specific weakness; "lesson" = the one transferable thing tonight teaches, one paragraph. Return ONLY JSON matching the schema.`;

/* ── children: one model call per invocation ──────────────────────────── */
const SELF = `${SUPABASE_URL}/functions/v1/desk`;
type Launched = Record<string, Record<string, { at: number; n: number }>>;

// Fire one invocation per job. The caller answers its own request now and
// collects the opinion rows on its next tick; EdgeRuntime.waitUntil keeps
// this isolate alive until the children have answered.
async function launch(uid: string, sid: string, jobs: { juror: string; round: string }[]): Promise<void> {
  const calls = jobs.map((j) => fetch(SELF, { method: "POST", headers: svcH, body: JSON.stringify({ mode: "juror", userId: uid, session_id: sid, juror: j.juror, round: j.round }) })
    .then((r) => r.text()).catch((e) => console.error("[desk] launch", j.round, j.juror, e instanceof Error ? e.message : e)));
  const all = Promise.allSettled(calls);
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(all);
  else await new Promise((r) => setTimeout(r, 1500)); // give the requests time to leave
}
function mark(p: J, round: string, jurors: string[]): void {
  const launched = ((p.launched as Launched) ?? {});
  const r = launched[round] ?? {};
  const now = Date.now();
  for (const j of jurors) r[j] = { at: now, n: (r[j]?.n ?? 0) + 1 };
  launched[round] = r;
  p.launched = launched;
}
const EMPTY: Record<string, J> = { "1": { market_read: "", no_trade: false, no_trade_reason: "", proposals: [] }, "2": { ballots: [], change_my_mind: "" }, judge: { narrative: "", decisions: [], why_not: [], lesson: "" } };
// Who still owes an answer for a round. Silent for four minutes: relaunch once. Silent again: give up, with a row that says so.
async function collect(uid: string, sid: string, p: J, ops: J[], round: string, wanted: { juror: string; model: string }[]): Promise<{ complete: boolean; missing: string[]; gaveUp: boolean }> {
  const have = new Set(ops.filter((o) => o.round === round).map((o) => String(o.juror)));
  const launched = ((p.launched as Launched) ?? {})[round] ?? {};
  const now = Date.now();
  const missing = wanted.filter((j) => !have.has(j.juror));
  if (!missing.length) return { complete: true, missing: [], gaveUp: false };
  const stale = (j: { juror: string }) => { const l = launched[j.juror]; return !l || now - l.at > 240_000; };
  const relaunch = missing.filter((j) => stale(j) && (launched[j.juror]?.n ?? 0) < 2);
  const gaveUp = missing.filter((j) => stale(j) && (launched[j.juror]?.n ?? 0) >= 2);
  for (const j of gaveUp) await saveOpinion(uid, sid, j.model, j.juror, round, { json: null, raw: "", cost: 0, tokensIn: 0, tokensOut: 0, latency: 0, error: "no answer within the time allowed (two tries)" }, EMPTY[round]);
  if (relaunch.length) { mark(p, round, relaunch.map((j) => j.juror)); await launch(uid, sid, relaunch.map((j) => ({ juror: j.juror, round }))); }
  const still = missing.filter((j) => !gaveUp.includes(j));
  return { complete: still.length === 0, missing: still.map((j) => j.juror), gaveUp: gaveUp.length > 0 };
}
async function loadOps(sid: string): Promise<J[]> {
  const r = await rest(`desk_opinions?session_id=eq.${sid}&select=model,juror,round,content,error,cost_usd&order=created_at.asc`);
  return r.ok ? (r.json as J[]) : [];
}
const costOf = (ops: J[]) => ops.reduce((a, o) => a + num(o.cost_usd), 0);

// The child: one juror, one round, one model call, one opinion row.
async function jurorJob(uid: string, body: J): Promise<J> {
  if (String(body.round) === "sit") return await sitBallot(uid, body);
  const sid = str(body.session_id, 64), juror = str(body.juror, 2).toUpperCase(), round = str(body.round, 8);
  if (!/^[0-9a-f-]{36}$/i.test(sid) || !juror || !["1", "2", "judge"].includes(round)) return { error: "bad job" };
  const sR = await rest(`desk_sessions?id=eq.${sid}&user_id=eq.${uid}&select=*`);
  const s = (sR.ok ? (sR.json as J[]) : [])[0];
  if (!s) return { error: "no session" };
  const p = s.packet as unknown as Packet;
  const dup = await rest(`desk_opinions?session_id=eq.${sid}&round=eq.${round}&juror=eq.${juror}&select=id&limit=1`);
  if (dup.ok && (dup.json as J[]).length) return { ok: true, skipped: "already answered" };
  const key = (await secret("anthropic_api_key")) || ENV_KEY;
  if (!key) return { error: "no key" };
  const deadline = Date.now() + 125_000;
  const ops = round === "1" ? [] : await loadOps(sid);
  const live = liveFrom(ops.filter((o) => o.round === "1"));

  if (round === "judge") {
    const aR = await rest(`desk_accounts?user_id=eq.${uid}&select=judge`);
    const judgeModel = judgeModelOf((aR.ok ? (aR.json as J[]) : [])[0] ?? {});
    const votes = (Array.isArray(s.votes) ? s.votes : []) as J[];
    const r2 = ops.filter((o) => o.round === "2");
    const ballotText = r2.map((o) => `Juror ${o.juror}: ${((((o.content as J)?.ballots as J[]) ?? []).map((b) => `${b.stance} ${b.proposal_id} (${(num(b.confidence) * 100).toFixed(0)}%): ${b.counter}`).join(" | ")) || "no ballot"}`).join("\n");
    const tallyText = votes.map((v) => `[${v.proposal_id}] score ${num(v.score).toFixed(2)} · ${v.support} support / ${v.oppose} oppose of ${v.voters} · ${v.candidate ? "CANDIDATE" : "not a candidate"}`).join("\n");
    const user = `${packetText(p).slice(0, 14000)}\n\nPROPOSALS\n${proposalsText(live) || "(none survived)"}\n\nBALLOTS\n${ballotText || "(round 2 skipped)"}\n\nTALLY\n${tallyText || "(nothing to tally)"}`;
    const res = await callModel(key, { model: judgeModel, system: JUDGE_SYSTEM, user, schema: JUDGE_SCHEMA, maxTokens: 5000, deadline });
    const jc: J = res.json ?? {};
    await saveOpinion(uid, sid, judgeModel, "J", "judge", res, { narrative: str(jc.narrative, 3000), decisions: Array.isArray(jc.decisions) ? jc.decisions : [], why_not: Array.isArray(jc.why_not) ? jc.why_not : [], lesson: str(jc.lesson, 1500) });
    return { ok: !res.error, error: res.error, latency: res.latency };
  }

  const j = p.jurors.find((x) => x.juror === juror);
  if (!j) return { error: "no such juror" };
  if (round === "1") {
    const openR = await rest(`desk_trades?user_id=eq.${uid}&owner=eq.desk&status=in.(pending,open)&select=symbol`);
    const openSyms = (openR.ok ? (openR.json as J[]) : []).map((x) => String(x.symbol));
    const res = await callModel(key, { model: j.model, system: r1System(p, openSyms), user: packetText(p), schema: R1_SCHEMA, maxTokens: 6000, deadline });
    const content: J = res.json ?? {};
    const props = Array.isArray(content.proposals) ? (content.proposals as J[]).slice(0, 3) : [];
    const cards = ((p.cardObj as Record<string, TapeCard>) ?? {});
    const val: J = {};
    const newCards: Record<string, TapeCard> = {};
    const norm = props.map((raw, i) => ({ i, ...normalizeProposal(raw, cards) }));
    // Validate every proposed symbol (name, sector, lot sizes, leverage) and fetch a card for the ones the packet lacks; in parallel, so a slow symbol costs seconds, not minutes.
    await Promise.all(norm.map(async (n) => {
      if (n.dropped) return;
      const sym = n.plan.symbol;
      if (p.validated[sym] || val[sym]) return;
      const v = await tape(uid, { mode: "validate", symbol: sym, venue: n.plan.venue }, 20000);
      if (v.ok !== true) { n.dropped = str(v.error, 200) || "symbol did not validate"; return; }
      n.plan.instrument = v.instrument as Instrument; n.plan.venue = v.venue as Venue;
      val[sym] = { instrument: n.plan.instrument, venue: n.plan.venue, name: str(v.name, 80), meta: v.meta as InstrumentMeta, largeCap: v.largeCap === true, sector: str(v.sector, 40) };
      if (!cards[sym]) {
        const snap = await tape(uid, { mode: "snapshot", symbols: [{ symbol: sym, venue: n.plan.venue }] }, 30000);
        const c = ((snap.cards as Record<string, TapeCard | { error: string }>) ?? {})[sym];
        if (c && "price" in c) { newCards[sym] = c; n.plan.entry_ref = c.price; }
      }
    }));
    const out = norm.map((n) => ({ ...n.plan, what_would_prove_me_wrong: n.plan.falsifier, id: `${juror}${n.i + 1}`, ...(n.dropped ? { dropped: n.dropped } : {}) }));
    await saveOpinion(uid, sid, j.model, juror, "1", res, { market_read: str(content.market_read, 900), no_trade: content.no_trade === true, no_trade_reason: str(content.no_trade_reason, 400), proposals: out, _val: val, _cards: newCards });
    return { ok: !res.error, error: res.error, latency: res.latency, proposals: out.length };
  }

  // round 2
  const user = `MARKET CONTEXT (regime: ${p.regime})\n${p.context.join("\n")}\n\nTAPE CARDS\n${Object.values(p.cards).join("\n")}\n\nCALENDAR\n${p.calendar.join("\n") || "(nothing)"}\n\nPROPOSALS\n${proposalsText(live)}`;
  const res = await callModel(key, { model: j.model, system: R2_SYSTEM, user, schema: R2_SCHEMA, maxTokens: 4000, deadline });
  const ids = new Set(live.map((x) => x.id));
  const raw = Array.isArray(res.json?.ballots) ? (res.json!.ballots as J[]) : [];
  const clean: J[] = [];
  for (const b of raw) {
    const id = str(b.proposal_id, 8).toUpperCase();
    if (!ids.has(id)) continue;
    const stance = b.stance === "oppose" ? "oppose" : b.stance === "abstain" ? "abstain" : "support";
    clean.push({ proposal_id: id, stance, confidence: Math.min(0.99, Math.max(0.01, num(b.confidence, 0.5))), counter: str(b.counter, 400) });
  }
  await saveOpinion(uid, sid, j.model, juror, "2", res, { ballots: clean, change_my_mind: str(res.json?.change_my_mind, 300) });
  return { ok: !res.error, error: res.error, latency: res.latency, ballots: clean.length };
}


/* ── sits: a jury before every trade ──────────────────────────────────── */
const SIT_SCHEMA = { name: "ballot", schema: { type: "object", additionalProperties: false, required: ["stance", "confidence", "side", "stop", "target", "leverage", "thesis", "what_would_prove_me_wrong", "tags"], properties: {
  stance: { type: "string", enum: ["take", "pass"] }, confidence: { type: "number" }, side: { type: "string", enum: ["long", "short"] }, stop: { type: "number" }, target: { type: "number" }, leverage: { type: "number" },
  thesis: { type: "string" }, what_would_prove_me_wrong: { type: "string" }, tags: { type: "array", items: { type: "string" } } } } };
const SIT_SYSTEM = `You are one of three fast jurors on a paper-trading desk run by Ben, 19, who is learning markets by watching you. A coded strategy has flagged a setup. Decide whether the desk should take it now: "take" or "pass", with your confidence 0-1 that the target is hit before the stop within the horizon. Your confidence is scored for calibration later, so say what you believe.
Judge the mechanism (does the reason for the move hold up?), the level (is the entry good here, or has the move already happened?), the timing (an event or headline that changes it), and the size of the risk. Read the headlines: quantitative, cash-flow news drifts; qualitative or anticipated news fades. You may tighten the stop or target and lower the leverage; you may not widen the stop, and you may not change the symbol. Give a thesis in at most 60 words and one observable thing that would prove you wrong. Tags from: chase, extended, no-catalyst, event-risk, crowded, thin-volume, counter-trend, clean, strong-confluence. Write in English. Return ONLY JSON matching the schema.`;
type SitBrief = { setup: J; strategy: J; headlines: string[]; macro: string[]; book: J; rules: J; regime: string };
function sitBriefText(b: SitBrief): string {
  const s = b.setup as { symbol: string; venue: string; instrument: string; side: string; timeframe: string; entry_ref: number; stop: number; target: number; leverage_hint: number; horizon_hours: number | null; horizon_days: number | null; score: number; reasons: { label: string; value: string; ok: boolean; core: boolean }[]; invalidation: string; card: J };
  const st = b.strategy as { name?: string; what?: string; why?: string; fails?: string };
  const rr = Math.abs(s.target - s.entry_ref) / Math.abs(s.entry_ref - s.stop);
  const lines = [
    `SETUP: ${s.symbol} ${s.side} (${s.venue}, ${s.instrument}) · ${s.timeframe} · horizon ${s.horizon_hours ? `${s.horizon_hours} hours` : `${s.horizon_days} days`}${s.instrument === "crypto_perp" ? ` · leverage hint ${s.leverage_hint}x` : ""}`,
    `LEVELS: entry ${s.entry_ref} · stop ${s.stop} · target ${s.target} · reward:risk ${rr.toFixed(2)} · confluence score ${(s.score * 100).toFixed(0)}%`,
    `STRATEGY: ${st.name ?? ""} — ${st.what ?? ""} Why it might work: ${st.why ?? ""} When it fails: ${st.fails ?? ""}`,
    `CHECKS (core must all hold; the rest are confirmations):`,
    ...s.reasons.map((r) => `  [${r.ok ? "ok" : "no"}] ${r.core ? "core" : "confirm"} · ${r.label}: ${r.value}`),
    `INVALIDATION: ${s.invalidation}`,
    `TAPE: ${Object.entries(s.card ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k} ${typeof v === "number" ? (Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(4)) : v}`).join(" · ")}`,
    `REGIME: ${b.regime}`,
    `HEADLINES ON ${s.symbol} (last 24h): ${b.headlines.length ? "" : "none"}`, ...b.headlines.map((h) => `  - ${h}`),
    `MACRO (last 24h): ${b.macro.length ? "" : "quiet"}`, ...b.macro.map((h) => `  - ${h}`),
    `THE BOOK: ${JSON.stringify(b.book)}`,
    `RULES: ${JSON.stringify(b.rules)}`,
  ];
  return lines.join("\n");
}
async function sitBallot(uid: string, body: J): Promise<J> {
  const sitId = str(body.sit_id, 64), juror = str(body.juror, 2).toUpperCase();
  if (!/^[0-9a-f-]{36}$/i.test(sitId) || !juror) return { error: "bad job" };
  const [sR, aR] = await Promise.all([rest(`desk_sits?id=eq.${sitId}&user_id=eq.${uid}&select=*`), rest(`desk_accounts?user_id=eq.${uid}&select=sit_roster`)]);
  const sit = (sR.ok ? (sR.json as J[]) : [])[0];
  if (!sit) return { error: "no sit" };
  const roster = ((aR.ok ? (aR.json as J[]) : [])[0]?.sit_roster as string[]) ?? [];
  const model = roster[LETTERS.indexOf(juror)];
  if (!model) return { error: "no such juror" };
  const dup = await rest(`desk_opinions?sit_id=eq.${sitId}&round=eq.sit&juror=eq.${juror}&select=id&limit=1`);
  if (dup.ok && (dup.json as J[]).length) return { ok: true, skipped: "already answered" };
  const key = (await secret("anthropic_api_key")) || ENV_KEY;
  if (!key) return { error: "no key" };
  const res = await callModel(key, { model, system: SIT_SYSTEM, user: sitBriefText(sit.brief as SitBrief), schema: SIT_SCHEMA, maxTokens: 1500, deadline: Date.now() + 100_000 });
  const j: J = res.json ?? {};
  const content = {
    stance: j.stance === "take" ? "take" : "pass", confidence: Math.min(0.99, Math.max(0.01, num(j.confidence, 0.5))), side: j.side === "short" ? "short" : "long",
    stop: num(j.stop), target: num(j.target), leverage: num(j.leverage, 1), thesis: str(j.thesis, 500), what_would_prove_me_wrong: str(j.what_would_prove_me_wrong, 300),
    tags: (Array.isArray(j.tags) ? j.tags : []).map((t) => str(t, 24)).slice(0, 5),
  };
  await saveOpinion(uid, "", model, juror, "sit", res, res.json ? content : {}, sitId);
  return { ok: !res.error, error: res.error, latency: res.latency, stance: content.stance };
}

// The tick calls this every five minutes: open juries for new setups, then settle the juries that have answered.
async function collectSits(uid: string): Promise<J> {
  const t0 = Date.now();
  const aR = await rest(`desk_accounts?user_id=eq.${uid}&select=*`);
  const acct = (aR.ok ? (aR.json as J[]) : [])[0];
  if (!acct) return { error: "no account" };
  const rules = rulesFor((acct.preset as PresetKey) ?? "aggressive", (acct.rules as Partial<Rules>) ?? {});
  const roster = (Array.isArray(acct.sit_roster) ? (acct.sit_roster as string[]) : []).filter((m) => /^[a-z0-9.-]+\/[a-z0-9.:_-]+$/i.test(m)).slice(0, 5);
  const jurors = roster.map((model, i) => ({ juror: LETTERS[i], model }));
  const day = etDate(t0);
  const halted = !!acct.halted_until && String(acct.halted_until) >= day;
  const out: J = { opened: 0, settled: 0, taken: 0, passed: 0, waiting: 0, skipped: [] as string[] };
  const skipped = out.skipped as string[];
  const openR = await rest(`desk_trades?user_id=eq.${uid}&owner=eq.desk&status=in.(pending,open)&select=*`);
  const open = (openR.ok ? (openR.json as J[]) : []).map((x) => x as unknown as Trade);
  const openSyms = new Set(open.map((t) => t.symbol));

  /* 1. settle the juries that have answered */
  const lR = await rest(`desk_sits?user_id=eq.${uid}&status=eq.launched&select=*&order=created_at.asc&limit=20`);
  const live = lR.ok ? (lR.json as J[]) : [];
  const ratR = await rest(`desk_ratings?user_id=eq.${uid}&select=model,elo,n_trades,n_sits,calib`);
  const ratings = ratR.ok ? (ratR.json as J[]) : [];
  // A juror's vote carries its Elo once it has a record: ten shadow trades or twenty scored sits.
  const hasRecord = (r: J | undefined) => !!r && (num(r.n_trades) >= 10 || num(r.n_sits) >= 20);
  const rated = ratings.some(hasRecord);
  const weightOf = (m: string) => { const r = ratings.find((x) => x.model === m); return !rated ? 1 : hasRecord(r) ? Math.max(0.25, (num(r!.elo, 1500) - 1400) / 200) : 0.5; };
  const stratR = await rest(`desk_strategies?user_id=eq.${uid}&select=id,enabled,size_mult,benched_until`);
  const strats = stratR.ok ? (stratR.json as J[]) : [];
  const quoteCache: Record<string, number> = {};
  const quote = async (symbol: string, venue: string) => {
    if (quoteCache[symbol]) return quoteCache[symbol];
    const q = await tape(uid, { mode: "quotes", symbols: [{ symbol, venue }] }, 20000);
    const p = num(((q.quotes as J)?.[symbol] as J)?.price, NaN);
    if (Number.isFinite(p)) quoteCache[symbol] = p;
    return Number.isFinite(p) ? p : null;
  };
  for (const sit of live) {
    const sid = String(sit.id);
    const setup = (sit.brief as J)?.setup as J | undefined;
    if (!setup) { await rest(`desk_sits?id=eq.${sid}`, { method: "PATCH", body: JSON.stringify({ status: "failed", error: "no setup in the brief", updated_at: iso(t0) }) }); continue; }
    const oR = await rest(`desk_opinions?sit_id=eq.${sid}&round=eq.sit&select=model,juror,content,error,cost_usd&order=created_at.asc`);
    const ops = oR.ok ? (oR.json as J[]) : [];
    const launched = (sit.launched as Record<string, { at: number; n: number }>) ?? {};
    const missing = jurors.filter((j) => !ops.some((o) => o.juror === j.juror));
    if (missing.length) {
      const stale = missing.filter((j) => !launched[j.juror] || t0 - launched[j.juror].at > 240_000);
      const retry = stale.filter((j) => (launched[j.juror]?.n ?? 0) < 2);
      const gaveUp = stale.filter((j) => (launched[j.juror]?.n ?? 0) >= 2);
      for (const j of gaveUp) await saveOpinion(uid, "", j.model, j.juror, "sit", { json: null, raw: "", cost: 0, tokensIn: 0, tokensOut: 0, latency: 0, error: "no answer within the time allowed (two tries)" }, {}, sid);
      if (retry.length) {
        for (const j of retry) launched[j.juror] = { at: t0, n: (launched[j.juror]?.n ?? 0) + 1 };
        await rest(`desk_sits?id=eq.${sid}`, { method: "PATCH", body: JSON.stringify({ launched, updated_at: iso(t0) }) });
        await launchSit(uid, sid, retry.map((j) => j.juror));
      }
      if (missing.length > gaveUp.length) { (out.waiting as number)++; continue; }
    }
    // everyone answered (or was given up on): tally
    const ops2 = missing.length ? (await rest(`desk_opinions?sit_id=eq.${sid}&round=eq.sit&select=model,juror,content,error,cost_usd&order=created_at.asc`)).json as J[] ?? ops : ops;
    const votes = ops2.map((o) => ({ model: String(o.model), juror: String(o.juror), error: str(o.error, 120), ...((o.content as J) ?? {}) })) as (J & { model: string; stance?: string; confidence?: number; stop?: number; target?: number; leverage?: number; thesis?: string; side?: string })[];
    const answered = votes.filter((v) => !v.error && v.stance);
    const takers = answered.filter((v) => v.stance === "take");
    const score = answered.reduce((a, v) => a + (v.stance === "take" ? 1 : -1) * num(v.confidence, 0.5) * weightOf(v.model), 0);
    const cost = ops2.reduce((a, o) => a + num(o.cost_usd), 0);
    const majority = answered.length >= 2 && takers.length >= Math.ceil(answered.length / 2 + 0.01) && score > 0;
    const decision: J = { take: majority, score, answered: answered.length, takers: takers.length, reasons: [] as string[] };
    const reasons = decision.reasons as string[];
    let tradeId: string | null = null;
    if (!majority) reasons.push(answered.length < 2 ? "fewer than two jurors answered" : `${takers.length} of ${answered.length} voted take (weighted score ${score.toFixed(2)})`);
    else if (halted) reasons.push("the account is halted");
    else if (openSyms.has(String(setup.symbol))) reasons.push(`${setup.symbol} is already on the book`);
    else {
      // the price now, not the price at the scan
      const px = await quote(String(setup.symbol), String(setup.venue));
      const side = String(setup.side) === "short" ? "short" : "long";
      const entry0 = num(setup.entry_ref), stop0 = num(setup.stop), target0 = num(setup.target);
      const entry = px ?? entry0;
      const dir = side === "long" ? 1 : -1;
      const risk0 = Math.abs(entry0 - stop0);
      const progress = ((entry - entry0) * dir) / Math.max(1e-9, Math.abs(target0 - entry0));
      if ((stop0 - entry) * dir >= 0) reasons.push(`the price (${entry}) is already through the stop (${stop0})`);
      else if (progress > 0.5) reasons.push(`the price has already made ${(progress * 100).toFixed(0)}% of the move to the target since the scan`);
      else {
        // takers may tighten: the median of their stops and targets, only if on the right side and not wider
        const med = (xs: number[]) => { const a = xs.filter((x) => x > 0).sort((p, q) => p - q); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
        const tStop = med(takers.map((v) => num(v.stop)));
        const tTarget = med(takers.map((v) => num(v.target)));
        const stop = tStop !== null && (tStop - entry) * dir < 0 && Math.abs(entry - tStop) <= Math.abs(entry - stop0) ? tStop : stop0;
        const target = tTarget !== null && (tTarget - entry) * dir > 0 && Math.abs(tTarget - entry) <= Math.abs(target0 - entry) ? tTarget : target0;
        const levHint = num(setup.leverage_hint, 1);
        const tLev = takers.map((v) => num(v.leverage)).filter((x) => x >= 1);
        const leverage = tLev.length ? Math.min(levHint, ...tLev) : levHint;
        const strat = strats.find((x) => x.id === setup.strategy);
        const benched = strat && (strat.enabled === false || (strat.benched_until && String(strat.benched_until) >= day));
        const sizeMult = strat ? Math.max(0.25, Math.min(2, num(strat.size_mult, 1))) : 1;
        if (benched) reasons.push(`strategy ${setup.strategy} is benched`);
        else {
          const best = [...takers].sort((a, b) => num(b.confidence) - num(a.confidence))[0];
          const def = STRATEGIES.find((x) => x.id === setup.strategy);
          const plan: Plan = {
            venue: String(setup.venue) as Venue, instrument: String(setup.instrument) as Instrument, symbol: String(setup.symbol), side, leverage, template: 0,
            thesis: str(best?.thesis, 700) || str(setup.invalidation, 300), catalyst: def?.what ?? "", falsifier: str(best?.what_would_prove_me_wrong, 400) || str(setup.invalidation, 400),
            confidence: takers.reduce((a, v) => a + num(v.confidence, 0.5), 0) / Math.max(1, takers.length), entry_ref: entry, stop, target,
            horizon_days: num(setup.horizon_days) || Math.max(1, Math.ceil(num(setup.horizon_hours, 24) / 24)), risk_pct: rules.risk_pct * sizeMult, evidence: [], key_risks: [], crosses_event: false,
            timeframe: String(setup.timeframe) as Plan["timeframe"], horizon_hours: setup.horizon_hours === null || setup.horizon_hours === undefined ? undefined : num(setup.horizon_hours), strategy: String(setup.strategy),
          };
          let meta: InstrumentMeta = { max_leverage: plan.instrument === "crypto_perp" ? 20 : 1, contract_value: 1, lot_size: 1, tick_size: 0.01 };
          let name = plan.symbol, largeCap = true, sector = "";
          const v = await tape(uid, { mode: "validate", symbol: plan.symbol, venue: plan.venue }, 20000);
          if (v.ok === true) { meta = v.meta as InstrumentMeta; name = str(v.name, 80); largeCap = v.largeCap === true; sector = str(v.sector, 40); }
          const themeOf = (sym: string) => ETF_THEME[sym] ? ETF_THEME[sym] : /-USDT?$/.test(sym) ? "crypto" : sector || "other";
          const g = guardrail(plan, { equity: num(acct.equity, 100000), rules: { ...rules, risk_pct: rules.risk_pct * Math.max(1, sizeMult) }, open, atr: num((setup.card as J)?.atr) || null, meta, halted, themeOf, drawdownHalved: drawdownHalved(num(acct.peak_equity, 100000), num(acct.equity, 100000)), newTonight: 0 });
          if (!g.ok || !g.sizing) reasons.push(`guardrail: ${g.reasons.join("; ")}`);
          else {
            const uv = g.sizing.unit === "contract" ? meta.contract_value : 1;
            const notional = g.sizing.qty * uv * g.plan.entry_ref;
            const row = {
              user_id: uid, owner: "desk", session_id: null, sit_id: sid, proposal_id: sid, source: "sit", strategy: plan.strategy, timeframe: plan.timeframe, horizon_hours: plan.horizon_hours ?? null, size_mult: sizeMult,
              venue: g.plan.venue, instrument: g.plan.instrument, symbol: g.plan.symbol, name, side: g.plan.side, status: "pending", template: 0,
              thesis: g.plan.thesis, catalyst: g.plan.catalyst, falsifier: g.plan.falsifier, confidence: g.plan.confidence, evidence: [], regime: str((setup.card as J)?.regime, 60), decided_at: iso(t0),
              entry_ref: g.plan.entry_ref, stop: g.plan.stop, target: g.plan.target, horizon_days: g.plan.horizon_days, risk_pct: g.plan.risk_pct, leverage: g.sizing.leverage, qty: g.sizing.qty, unit: g.sizing.unit, contract_value: uv,
              notional, margin: g.plan.instrument === "crypto_perp" ? notional / g.sizing.leverage : notional, liq_price: g.plan.instrument === "crypto_perp" ? liqPrice(g.plan.entry_ref, g.plan.side, g.sizing.leverage) : null,
              fill_rule: "next_5m", slippage_bps: slippageBps(g.plan.instrument, g.plan.symbol, largeCap, 0),
            };
            const ins = await rest("desk_trades", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
            const made = (ins.ok ? (ins.json as J[]) : [])[0];
            if (!made) reasons.push("the order could not be written");
            else { tradeId = String(made.id); open.push(made as unknown as Trade); openSyms.add(plan.symbol); reasons.push(...g.reasons); decision.sized = { qty: g.sizing.qty, unit: g.sizing.unit, notional, leverage: g.sizing.leverage, entry: g.plan.entry_ref, stop: g.plan.stop, target: g.plan.target }; }
          }
        }
      }
    }
    const taken = !!tradeId;
    decision.taken = taken;
    await rest(`desk_sits?id=eq.${sid}`, { method: "PATCH", body: JSON.stringify({ status: "done", votes, decision, trade_id: tradeId, cost_usd: cost, updated_at: iso(t0) }) });
    if (sit.setup_id) await rest(`desk_setups?id=eq.${sit.setup_id}`, { method: "PATCH", body: JSON.stringify({ status: taken ? "taken" : "passed", trade_id: tradeId }) });
    (out.settled as number)++;
    if (taken) (out.taken as number)++; else (out.passed as number)++;
  }

  /* 2. open juries for new setups, inside the day's budget */
  if (jurors.length < 3) { skipped.push("the sit jury needs three models"); return { ...out, ms: Date.now() - t0 }; }
  const dayStart = new Date(`${day}T04:00:00Z`).toISOString(); // roughly midnight New York
  const costR = await rest(`desk_opinions?user_id=eq.${uid}&round=eq.sit&created_at=gte.${dayStart}&select=cost_usd`);
  const spent = (costR.ok ? (costR.json as J[]) : []).reduce((a, o) => a + num(o.cost_usd), 0);
  const budget = num(acct.sit_budget_usd, 3);
  out.spent_today = Number(spent.toFixed(3));
  if (spent >= budget) { skipped.push(`today's sit budget ($${budget}) is spent`); return { ...out, ms: Date.now() - t0 }; }
  if (halted) { skipped.push("the account is halted"); return { ...out, ms: Date.now() - t0 }; }
  const nR = await rest(`desk_setups?user_id=eq.${uid}&status=eq.new&expires_at=gte.${iso(t0)}&select=*&order=score.desc,created_at.desc&limit=12`);
  const fresh = nR.ok ? (nR.json as J[]) : [];
  const inFlight = new Set(live.map((s) => String(s.symbol)));
  const cooldownMs = num(acct.cooldown_hours, 4) * 3_600_000;
  const recentR = await rest(`desk_sits?user_id=eq.${uid}&created_at=gte.${iso(t0 - cooldownMs)}&select=symbol,decision`);
  const cooled = new Set((recentR.ok ? (recentR.json as J[]) : []).filter((x) => (x.decision as J)?.take === false).map((x) => String(x.symbol)));
  const [newsR] = await Promise.all([rest(`desk_news?tagged=eq.true&published=gte.${iso(t0 - 24 * 3_600_000)}&select=title,tickers,impact,direction,category,why,published,venue&order=impact.desc,published.desc&limit=300`)]);
  const news = newsR.ok ? (newsR.json as J[]) : [];
  let opened = 0;
  for (const su of fresh) {
    if (opened >= 6) break;
    const sym = String(su.symbol);
    if (openSyms.has(sym)) { await rest(`desk_setups?id=eq.${su.id}`, { method: "PATCH", body: JSON.stringify({ status: "held" }) }); continue; }
    if (inFlight.has(sym)) continue;
    if (cooled.has(sym)) { await rest(`desk_setups?id=eq.${su.id}`, { method: "PATCH", body: JSON.stringify({ status: "cooled" }) }); continue; }
    if (open.length + opened >= rules.max_open) { skipped.push(`${rules.max_open} positions already open`); break; }
    const base = sym.split("-")[0];
    const mine = news.filter((n) => (Array.isArray(n.tickers) ? (n.tickers as string[]) : []).some((t) => t === sym || t === base)).slice(0, 6);
    const macro = news.filter((n) => n.venue === "macro" && num(n.impact) >= 4).slice(0, 5);
    const line = (n: J) => `${str(n.title, 110)} (impact ${n.impact}, ${n.direction}, ${n.category}${n.why ? `: ${str(n.why, 120)}` : ""})`;
    const def = STRATEGIES.find((x) => x.id === su.strategy);
    const brief: SitBrief = {
      setup: { symbol: sym, venue: su.venue, instrument: su.instrument, side: su.side, timeframe: su.timeframe, entry_ref: num(su.entry_ref), stop: num(su.stop), target: num(su.target), leverage_hint: num(su.leverage_hint, 1), horizon_hours: su.horizon_hours ?? null, horizon_days: su.horizon_days ?? null, score: num(su.score), reasons: su.reasons ?? [], invalidation: str(su.invalidation, 300), card: su.card ?? {}, strategy: su.strategy },
      strategy: def ? { name: def.name, what: def.what, why: def.why, fails: def.fails } : { name: String(su.strategy) },
      headlines: mine.map(line), macro: macro.map(line),
      book: { equity: num(acct.equity), open: open.map((t) => `${t.symbol} ${t.side} ${t.status}`), preset: acct.preset },
      rules: { risk_pct: rules.risk_pct, min_rr: rules.min_rr, max_leverage: rules.max_leverage, max_open: rules.max_open }, regime: str((su.card as J)?.regime, 60),
    };
    const launched: Record<string, { at: number; n: number }> = {};
    for (const j of jurors) launched[j.juror] = { at: t0, n: 1 };
    const ins = await rest("desk_sits", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ user_id: uid, setup_id: su.id, symbol: sym, strategy: su.strategy, timeframe: su.timeframe, status: "launched", brief, launched }) });
    const made = (ins.ok ? (ins.json as J[]) : [])[0];
    if (!made) { skipped.push(`${sym}: could not open the sit`); continue; }
    await rest(`desk_setups?id=eq.${su.id}`, { method: "PATCH", body: JSON.stringify({ status: "sit", sit_id: made.id }) });
    await launchSit(uid, String(made.id), jurors.map((j) => j.juror));
    inFlight.add(sym);
    opened++;
  }
  out.opened = opened;
  return { ...out, ms: Date.now() - t0 };
}
async function launchSit(uid: string, sitId: string, jurors: string[]): Promise<void> {
  const calls = jurors.map((juror) => fetch(SELF, { method: "POST", headers: svcH, body: JSON.stringify({ mode: "juror", round: "sit", userId: uid, sit_id: sitId, juror }) }).then((r) => r.text()).catch((e) => console.error("[desk] launch sit", juror, e instanceof Error ? e.message : e)));
  const all = Promise.allSettled(calls);
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(all); else await new Promise((r) => setTimeout(r, 1500));
}
const iso = (ms: number) => new Date(ms).toISOString();

/* ── the run: one stage per call ──────────────────────────────────────── */
async function run(uid: string, body: J): Promise<J> {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day ?? "")) ? String(body.day) : etDate(Date.now());
  const force = body.force === true, dry = body.dry === true;
  const aR = await rest(`desk_accounts?user_id=eq.${uid}&select=*`);
  let acct = (aR.ok ? (aR.json as J[]) : [])[0];
  if (!acct) { const c = await rest("desk_accounts", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ user_id: uid }) }); acct = (c.ok ? (c.json as J[]) : [])[0]; }
  if (!acct) return { error: "Couldn't open the desk account." };
  const rules = rulesFor((acct.preset as PresetKey) ?? "aggressive", (acct.rules as Partial<Rules>) ?? {});
  const key = (await secret("anthropic_api_key")) || ENV_KEY;
  if (!key || !key.startsWith("sk-or-")) return { error: "The desk needs an OpenRouter key (sk-or-…) in Settings → AI key." };

  const sR = await rest(`desk_sessions?user_id=eq.${uid}&day=eq.${day}&select=*&order=seq.desc&limit=1`);
  let s = (sR.ok ? (sR.json as J[]) : [])[0];
  // A dry session keeps status "dry" through every stage; it is finished only at stage "done".
  const finished = (row: J) => row.status === "done" || row.status === "failed" || (row.status === "dry" && row.stage === "done");
  if (s && finished(s) && !force) return { session: s, stage: s.stage, next: false, cost: num(s.cost_usd) };
  if (!s || (finished(s) && force)) {
    const seq = s ? num(s.seq) + 1 : 1;
    const c = await rest("desk_sessions", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ user_id: uid, day, seq, status: dry ? "dry" : "running", stage: "packet" }) });
    s = (c.ok ? (c.json as J[]) : [])[0];
    if (!s) return { error: "Couldn't start a session." };
  }
  const sid = String(s.id);
  const stage = String(s.stage);
  const isDry = String(s.status) === "dry";
  const openR = await rest(`desk_trades?user_id=eq.${uid}&owner=eq.desk&status=in.(pending,open)&select=*`);
  const open = (openR.ok ? (openR.json as J[]) : []).map((x) => x as unknown as Trade);
  const waiting = (st: string, missing: string[]) => ({ session: { ...s, stage: st }, stage: st, next: true, waiting: true, pending: missing, cost: num(s.cost_usd) });

  /* stage: packet → launch round 1 */
  if (stage === "packet") {
    const built = await buildPacket(uid, day, rules, acct, open);
    if ("error" in built) { await patchSession(sid, { status: "skipped", error: built.error }); return { session: { ...s, status: "skipped", error: built.error }, stage: "packet", next: false, error: built.error }; }
    const roster = (Array.isArray(acct.roster) ? (acct.roster as string[]) : []).filter((m) => /^[a-z0-9.-]+\/[a-z0-9.:_-]+$/i.test(m)).slice(0, 12);
    if (roster.length < 3) { await patchSession(sid, { status: "failed", error: "The roster needs at least three models." }); return { error: "The roster needs at least three models.", next: false }; }
    built.jurors = seededShuffle(roster, `${day}-${s.seq}`).map((model, i) => ({ juror: LETTERS[i], model }));
    const packet = built as unknown as J;
    mark(packet, "1", built.jurors.map((j) => j.juror));
    const ok = await patchSession(sid, { packet, regime: built.regime, stage: "round1", status: isDry ? "dry" : "running", error: "" });
    if (!ok) return { error: "Couldn't save the packet.", next: false };
    await launch(uid, sid, built.jurors.map((j) => ({ juror: j.juror, round: "1" })));
    return waiting("round1", built.jurors.map((j) => j.juror));
  }

  const p = s.packet as J;
  const jurors = ((p.jurors as { juror: string; model: string }[]) ?? []);
  let ops = await loadOps(sid);
  const budget = num(acct.budget_usd_per_run, 1.5);

  /* stage: round1 → collect proposals, launch round 2 */
  if (stage === "round1") {
    const c = await collect(uid, sid, p, ops, "1", jurors);
    if (!c.complete) { await patchSession(sid, { packet: p }); return waiting("round1", c.missing); }
    if (c.gaveUp) ops = await loadOps(sid);
    const r1 = ops.filter((o) => o.round === "1");
    const validated = (p.validated as J) ?? {};
    const cardObj = ((p.cardObj as Record<string, TapeCard>) ?? {});
    const cards = (p.cards as Record<string, string>) ?? {};
    for (const o of r1) {
      const content = (o.content as J) ?? {};
      Object.assign(validated, (content._val as J) ?? {});
      for (const [sym, card] of Object.entries(((content._cards as Record<string, TapeCard>) ?? {}))) { cardObj[sym] = card; cards[sym] = cardLine(card); }
    }
    p.validated = validated; p.cardObj = cardObj; p.cards = cards;
    const answered = r1.filter((o) => !o.error).length;
    const cost = costOf(ops);
    if (answered < 3) {
      const error = `Only ${answered} of ${jurors.length} jurors answered — not enough for a debate.`;
      await patchSession(sid, { packet: p, cost_usd: cost, status: isDry ? "dry" : "failed", error });
      return { session: { ...s, error }, stage: "round1", next: false, error };
    }
    const live = liveFrom(r1);
    if (live.length && cost <= 0.6 * budget) {
      mark(p, "2", jurors.map((j) => j.juror));
      await patchSession(sid, { packet: p, stage: "round2", cost_usd: cost });
      await launch(uid, sid, jurors.map((j) => ({ juror: j.juror, round: "2" })));
      return waiting("round2", jurors.map((j) => j.juror));
    }
    await patchSession(sid, { packet: p, stage: "round2", cost_usd: cost, error: live.length ? `Round 2 skipped: round 1 spent $${cost.toFixed(2)} of the $${budget.toFixed(2)} budget.` : "" });
    return { session: { ...s, stage: "round2" }, stage: "round2", next: true, cost };
  }

  const r1 = ops.filter((o) => o.round === "1");
  const live = liveFrom(r1);
  const cards = ((p.cardObj as Record<string, TapeCard>) ?? {});
  const validated = (p.validated as Record<string, { instrument: Instrument; venue: Venue; name: string; meta: InstrumentMeta; largeCap: boolean; sector: string }>) ?? {};
  const judgeModel = judgeModelOf(acct);

  /* stage: round2 → collect ballots, tally, launch the judge */
  if (stage === "round2") {
    const launched2 = !!((p.launched as Launched) ?? {})["2"];
    let ballots: Ballot[] = [];
    if (launched2) {
      const c = await collect(uid, sid, p, ops, "2", jurors);
      if (!c.complete) { await patchSession(sid, { packet: p }); return waiting("round2", c.missing); }
      if (c.gaveUp) ops = await loadOps(sid);
      for (const o of ops.filter((x) => x.round === "2")) {
        if (o.error) continue;
        const stances: Ballot["stances"] = {};
        for (const b of ((((o.content as J)?.ballots as J[]) ?? []))) stances[String(b.proposal_id)] = { stance: b.stance as "support" | "oppose" | "abstain", confidence: num(b.confidence, 0.5) };
        ballots.push({ juror: String(o.juror), model: String(o.model), stances });
      }
    } else if (live.length) {
      // Budget said no to a second round: every juror backs its own proposals at its stated confidence.
      ballots = jurors.map((j) => ({ juror: j.juror, model: j.model, stances: Object.fromEntries(live.filter((x) => x.juror === j.juror).map((x) => [x.id, { stance: "support" as const, confidence: x.plan.confidence }])) }));
    }
    const ratR = await rest(`desk_ratings?user_id=eq.${uid}&select=model,elo,n_trades,calib`);
    const ratings = ratR.ok ? (ratR.json as J[]) : [];
    const rated = ratings.filter((r) => num(r.n_trades) >= 10).length > 0;
    const weights: Weight[] = rated
      ? jurors.map((j) => { const r = ratings.find((x) => x.model === j.model); return { model: j.model, weight: r && num(r.n_trades) >= 10 ? Math.max(0.25, (num(r.elo, 1500) - 1400) / 200) : 0.5, calib: (r?.calib as CalibBin[]) ?? [] }; })
      : equalWeights(jurors.map((j) => j.model)).map((w) => ({ ...w, calib: (ratings.find((x) => x.model === w.model)?.calib as CalibBin[]) ?? [] }));
    const votes = tally(live.map((x) => ({ id: x.id, plan: x.plan })), ballots, weights);
    mark(p, "judge", ["J"]);
    await patchSession(sid, { packet: p, votes, stage: "judge", cost_usd: costOf(ops) });
    await launch(uid, sid, [{ juror: "J", round: "judge" }]);
    return waiting("judge", ["J"]);
  }

  /* stage: judge → collect the verdict, apply the guardrails, write the orders */
  if (stage === "judge") {
    const c = await collect(uid, sid, p, ops, "judge", [{ juror: "J", model: judgeModel }]);
    if (!c.complete) { await patchSession(sid, { packet: p }); return waiting("judge", ["J"]); }
    if (c.gaveUp) ops = await loadOps(sid);
    const jo = ops.find((o) => o.round === "judge");
    const jc: J = (jo?.content as J) ?? {};
    const judgeError = String(jo?.error ?? "the judge never answered");
    const votes = (Array.isArray(s.votes) ? s.votes : []) as { proposal_id: string; candidate: boolean }[];
    const decisions = new Map<string, { action: string; size_multiplier: number; leverage: number; reason: string }>();
    for (const d of (Array.isArray(jc.decisions) ? (jc.decisions as J[]) : [])) decisions.set(str(d.proposal_id, 8).toUpperCase(), { action: str(d.action, 8), size_multiplier: Math.min(1, Math.max(0, num(d.size_multiplier, 1) || 1)), leverage: num(d.leverage, 0), reason: str(d.reason, 300) });
    const halted = !!acct.halted_until && String(acct.halted_until) >= day;
    const themeOf = (sym: string) => { const v = validated[sym]; return ETF_THEME[sym] ? ETF_THEME[sym] : /-USDT?$/.test(sym) ? "crypto" : v?.sector || ((p.sectors as J)?.[sym] as string) || "other"; };
    const taken: J[] = [];
    const whyNot: { proposal_id: string; reason: string }[] = (Array.isArray(jc.why_not) ? (jc.why_not as J[]) : []).map((w) => ({ proposal_id: str(w.proposal_id, 8), reason: str(w.reason, 300) }));
    let newTonight = 0;
    const openNow: Trade[] = [...open];
    const dd = drawdownHalved(num(acct.peak_equity, 100000), num(acct.equity, 100000));
    const rowFor = (owner: string, proposalId: string, g: { plan: Plan; sizing: { qty: number; unit: Trade["unit"]; leverage: number } }, qty: number, meta: InstrumentMeta, val: { name: string; largeCap: boolean } | undefined) => {
      const uv = g.sizing.unit === "contract" ? meta.contract_value : 1;
      const notional = qty * uv * g.plan.entry_ref;
      return {
        user_id: uid, owner, session_id: sid, proposal_id: proposalId, venue: g.plan.venue, instrument: g.plan.instrument, symbol: g.plan.symbol, name: val?.name ?? cards[g.plan.symbol]?.name ?? g.plan.symbol,
        side: g.plan.side, status: "pending", template: g.plan.template, thesis: g.plan.thesis, catalyst: g.plan.catalyst, falsifier: g.plan.falsifier, confidence: g.plan.confidence, evidence: g.plan.evidence,
        regime: p.regime, decided_at: new Date().toISOString(), entry_ref: g.plan.entry_ref, stop: g.plan.stop, target: g.plan.target, horizon_days: g.plan.horizon_days, risk_pct: g.plan.risk_pct,
        leverage: g.sizing.leverage, qty, unit: g.sizing.unit, contract_value: uv, notional, margin: g.plan.instrument === "crypto_perp" ? notional / g.sizing.leverage : notional,
        liq_price: g.plan.instrument === "crypto_perp" ? liqPrice(g.plan.entry_ref, g.plan.side, g.sizing.leverage) : null,
        fill_rule: g.plan.instrument === "stock" || g.plan.instrument === "etf" ? "next_open" : "next_hour", slippage_bps: slippageBps(g.plan.instrument, g.plan.symbol, val?.largeCap ?? true, 0),
      };
    };
    const metaFor = async (plan: Plan): Promise<{ meta: InstrumentMeta; val: typeof validated[string] | undefined; error: string }> => {
      const val = validated[plan.symbol];
      const meta: InstrumentMeta = val?.meta ?? { max_leverage: plan.instrument === "crypto_perp" ? 20 : 1, contract_value: 1, lot_size: 1, tick_size: 0.01 };
      if (plan.instrument === "crypto_perp" && !val) {
        const vv = await tape(uid, { mode: "validate", symbol: plan.symbol, venue: "blofin" }, 30000);
        if (vv.ok !== true) return { meta, val, error: str(vv.error, 160) || "could not validate the perp" };
        Object.assign(meta, vv.meta as InstrumentMeta);
        validated[plan.symbol] = { instrument: "crypto_perp", venue: "blofin", name: str(vv.name, 80), meta: vv.meta as InstrumentMeta, largeCap: vv.largeCap === true, sector: "crypto" };
        return { meta, val: validated[plan.symbol], error: "" };
      }
      return { meta, val, error: "" };
    };

    for (const v of votes.filter((x) => x.candidate)) {
      const prop = live.find((x) => x.id === v.proposal_id);
      if (!prop) continue;
      const d = decisions.get(v.proposal_id);
      if (d?.action === "veto") { whyNot.push({ proposal_id: v.proposal_id, reason: `judge vetoed: ${d.reason}` }); continue; }
      const plan: Plan = { ...prop.plan };
      if (d?.action === "cut" && d.leverage > 0) plan.leverage = Math.min(plan.leverage, d.leverage);
      const m = await metaFor(plan);
      if (m.error) { whyNot.push({ proposal_id: v.proposal_id, reason: `guardrail: ${m.error}` }); continue; }
      const ctx: GuardCtx = { equity: num(acct.equity, 100000), rules, open: openNow, atr: cards[plan.symbol]?.atr14 ?? null, meta: m.meta, halted, themeOf, drawdownHalved: dd, newTonight };
      const g = guardrail(plan, ctx);
      if (!g.ok || !g.sizing) { whyNot.push({ proposal_id: v.proposal_id, reason: `guardrail: ${g.reasons.join("; ")}` }); continue; }
      let qty = g.sizing.qty;
      if (d?.action === "cut" && d.size_multiplier < 1) {
        qty = plan.instrument === "stock" || plan.instrument === "etf" ? Math.floor(qty * d.size_multiplier) : plan.instrument === "crypto_perp" ? Math.floor((qty * d.size_multiplier) / m.meta.lot_size) * m.meta.lot_size : Math.round(qty * d.size_multiplier * 1e6) / 1e6;
        if (!(qty > 0)) { whyNot.push({ proposal_id: v.proposal_id, reason: "judge cut the size to nothing" }); continue; }
      }
      const row = rowFor("desk", v.proposal_id, { plan: g.plan, sizing: g.sizing }, qty, m.meta, m.val);
      if (isDry) { taken.push({ proposal_id: v.proposal_id, symbol: g.plan.symbol, dry: true, qty, notional: row.notional, reasons: g.reasons }); continue; }
      const ins = await rest("desk_trades", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
      const made = (ins.ok ? (ins.json as J[]) : [])[0];
      if (!made) { whyNot.push({ proposal_id: v.proposal_id, reason: "the order could not be written" }); continue; }
      taken.push({ trade_id: String(made.id), proposal_id: v.proposal_id, symbol: g.plan.symbol, reasons: g.reasons, judge: d?.action ?? "take" });
      openNow.push(made as unknown as Trade);
      newTonight++;
    }

    // Shadow books: each juror's highest-confidence surviving proposal, sized by the same rules on its own $100k.
    const shadow: J[] = [];
    const r2 = ops.filter((o) => o.round === "2");
    if (!isDry) for (const j of jurors) {
      const mine = live.filter((x) => x.juror === j.juror);
      if (!mine.length) continue;
      const st = ((r2.find((o) => o.juror === j.juror)?.content as J)?.ballots as J[]) ?? [];
      const pick = mine.map((x) => ({ x, c: num(st.find((b) => b.proposal_id === x.id)?.confidence, x.plan.confidence) })).sort((a, b) => b.c - a.c)[0].x;
      const so = await rest(`desk_trades?user_id=eq.${uid}&owner=eq.${encodeURIComponent(j.model)}&status=in.(pending,open)&select=*`);
      const myOpen = (so.ok ? (so.json as J[]) : []).map((x) => x as unknown as Trade);
      const m = await metaFor(pick.plan);
      if (m.error) { shadow.push({ model: j.model, symbol: pick.plan.symbol, skipped: m.error }); continue; }
      const g = guardrail(pick.plan, { equity: SHADOW_START, rules, open: myOpen, atr: cards[pick.plan.symbol]?.atr14 ?? null, meta: m.meta, halted: false, themeOf, drawdownHalved: false, newTonight: 0 });
      if (!g.ok || !g.sizing) { shadow.push({ model: j.model, symbol: pick.plan.symbol, skipped: g.reasons.join("; ") }); continue; }
      const ins = await rest("desk_trades", { method: "POST", body: JSON.stringify(rowFor(j.model, pick.id, { plan: g.plan, sizing: g.sizing }, g.sizing.qty, m.meta, m.val)) });
      shadow.push({ model: j.model, symbol: g.plan.symbol, ok: ins.ok });
    }

    const failed = r1.filter((o) => o.error).map((o) => ({ model: String(o.model), error: str(o.error, 120) }));
    const dropped = r1.flatMap((o) => ((((o.content as J)?.proposals as J[]) ?? []).filter((x) => x.dropped).map((x) => `${x.id} ${x.symbol}: ${x.dropped}`)));
    const verdict = {
      narrative: str(jc.narrative, 3000) || (jo?.error ? `The judge did not answer (${judgeError}); the tally stands on its own.` : ""),
      decisions: Array.isArray(jc.decisions) ? jc.decisions : [], why_not: whyNot, lesson: str(jc.lesson, 1500), taken, failed, dropped, shadow, judge_error: jo?.error ?? "",
    };
    const cost = costOf(ops);
    await patchSession(sid, { verdict, judge_model: judgeModel, status: isDry ? "dry" : "done", stage: "done", cost_usd: cost, packet: { ...p, validated, cardObj: undefined } });
    return { session: { ...s, status: isDry ? "dry" : "done", stage: "done", verdict }, stage: "done", next: false, cost };
  }

  return { session: s, stage, next: false, cost: num(s.cost_usd) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const body = (await req.json().catch(() => ({}))) as J;
    const mode = String(body.mode ?? "status");
    let uid = "";
    const cronSecret = String(body.cronSecret ?? "");
    if (cronSecret) { const want = await secret("desk_cron_secret"); if (want.length > 20 && want === cronSecret) uid = String(body.userId ?? ""); }
    if (!uid && token && SERVICE_KEY && token === SERVICE_KEY) uid = String(body.userId ?? "");
    if (!uid && token) {
      try { const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }); if (r.ok) uid = String((await r.json())?.id ?? ""); } catch { /* 401 below */ }
    }
    if (!/^[0-9a-f-]{36}$/i.test(uid)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    if (mode === "run") return ok(await run(uid, body));
    if (mode === "collect") { if (token !== SERVICE_KEY && !body.cronSecret) return ok({ error: "the tick collects" }); return ok(await collectSits(uid)); }
    if (mode === "juror") { if (token !== SERVICE_KEY) return ok({ error: "jurors are launched by the desk itself" }); return ok(await jurorJob(uid, body)); }
    if (mode === "status") {
      const [a, sR] = await Promise.all([rest(`desk_accounts?user_id=eq.${uid}&select=*`), rest(`desk_sessions?user_id=eq.${uid}&select=id,day,seq,status,stage,cost_usd,error&order=day.desc,seq.desc&limit=1`)]);
      return ok({ account: (a.json as J[])?.[0] ?? null, latest: (sR.json as J[])?.[0] ?? null });
    }
    return ok({ error: "Unknown mode." });
  } catch (e) {
    console.error("[desk] fatal", e instanceof Error ? e.stack ?? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
