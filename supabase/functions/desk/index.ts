// desk — the jury. One stage per call, so no invocation runs long:
//   packet → round1 → round2 → judge (+ guardrails, orders, shadow trades)
// The cron fires every five minutes across the window and the app's button
// loops until `next` is false; a stage already done is never repeated.
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
type Call = { model: string; system: string; user: string; schema: { name: string; schema: J }; maxTokens: number };
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
    const t = setTimeout(() => ctl.abort(), 110_000);
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
  day: string; regime: string; briefing: Item[]; context: string[]; cards: Record<string, string>; cardObj: Record<string, TapeCard>;
  movers: string[]; calendar: string[]; universe_note: string; book: J; card: J | null; lessons: string[]; jurors: { juror: string; model: string }[];
  rules: Rules; sectors: Record<string, string>; validated: Record<string, { instrument: Instrument; venue: Venue; name: string; meta: InstrumentMeta; largeCap: boolean; sector: string }>;
};
const ETF_THEME: Record<string, string> = { XLE: "Energy", USO: "Energy", OIH: "Energy", XOP: "Energy", BNO: "Energy", TLT: "Rates", IEF: "Rates", TBT: "Rates", SHY: "Rates", GLD: "Metals", SLV: "Metals", GDX: "Metals", SPY: "Index", QQQ: "Index", IWM: "Index", DIA: "Index", VOO: "Index", XLF: "Financials", KRE: "Financials", SMH: "Semis", SOXX: "Semis", XLK: "Tech", XLV: "Health", XLU: "Utilities", XLP: "Staples", XLY: "Discretionary", UUP: "Dollar", IBIT: "crypto", FBTC: "crypto", BITO: "crypto", ETHA: "crypto", MCHI: "China", FXI: "China", EEM: "EM" };

async function buildPacket(uid: string, day: string, rules: Rules, acct: J, open: Trade[]): Promise<Packet | { error: string }> {
  const bR = await rest(`world_briefings?user_id=eq.${uid}&day=eq.${day}&select=lede,sections`);
  const brief = (bR.ok ? (bR.json as J[]) : [])[0];
  if (!brief) return { error: `No briefing for ${day} yet — the desk reads the news the briefing gathered. Build tonight's briefing on the Card first.` };
  const items: Item[] = [];
  for (const sec of (brief.sections as J[]) ?? []) {
    for (const it of (sec.items as J[]) ?? []) {
      const ex = ((it.exposure as J[]) ?? []).map((e) => ({ t: str(e.ticker, 8).toUpperCase(), d: str(e.dir, 10), n: str(e.note, 140) })).filter((e) => /^[A-Z][A-Z.\-]{0,5}$/.test(e.t));
      items.push({ i: items.length, section: str(sec.key, 20), headline: str(it.headline, 220), why: str(it.why, 600), thesis: str(it.thesis, 400), url: str(((it.sources as J[]) ?? [])[0]?.url, 400), exposure: ex.map((e) => `${e.t} (${e.d}: ${e.n})`).join("; "), tickers: ex.map((e) => e.t) });
    }
  }
  const tickers = [...new Set(items.flatMap((x) => x.tickers))];
  const wanted: { symbol: string; venue: Venue }[] = [...tickers.map((s) => ({ symbol: s, venue: "robinhood" as Venue })), ...open.map((t) => ({ symbol: t.symbol, venue: t.venue }))];
  const [ctx, snap, movers, cal, instR, cardR, lessonR] = await Promise.all([
    tape(uid, { mode: "context" }), tape(uid, { mode: "snapshot", symbols: wanted }), tape(uid, { mode: "movers" }, 40000), tape(uid, { mode: "calendar", days: 7, symbols: tickers }, 60000),
    rest("desk_instruments?select=base,max_leverage&state=eq.live&order=vol_24h_usd.desc&limit=1000"),
    rest(`desk_cards?user_id=eq.${uid}&select=card,review&order=week_start.desc&limit=1`),
    rest(`desk_lessons?user_id=eq.${uid}&status=eq.active&select=text&order=applied_count.desc&limit=10`),
  ]);
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
  return { day, regime: str(ctx.regime, 60), briefing: items, context, cards, cardObj, movers: moverLines, calendar, universe_note, book, card: cardRow ? (cardRow.card as J) : null, lessons, jurors: [], rules, sectors: {}, validated: {} };
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
  return `MARKET CONTEXT (regime: ${p.regime})\n${p.context.join("\n")}\n\nTONIGHT'S NEWS (cite by [index])\n${brief}\n\nTAPE CARDS (symbols the news touches and open positions)\n${cardLines || "(none)"}\n\nCRYPTO PERPS: TOP VOLUME AND MOVERS (24h)\n${p.movers.join("\n") || "(unavailable)"}\n\nCALENDAR (next 7 days)\n${p.calendar.join("\n") || "(nothing scheduled)"}\n\nTHE BOOK\nequity $${b.equity.toFixed(0)} · cash $${b.cash.toFixed(0)} · gross notional $${b.gross.toFixed(0)}${b.halted ? ` · HALTED: ${b.halt_reason}` : ""}\n${b.positions.length ? b.positions.join("\n") : "no open positions"}${card}${lessons}`;
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
async function saveOpinion(uid: string, sessionId: string, model: string, juror: string, round: string, res: Result, content: J): Promise<void> {
  await rest("desk_opinions", { method: "POST", body: JSON.stringify({ user_id: uid, session_id: sessionId, model, juror, round, content, raw: res.raw.slice(0, 4000), latency_ms: res.latency, cost_usd: res.cost, tokens_in: res.tokensIn, tokens_out: res.tokensOut, error: res.error }) });
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

/* ── the run ───────────────────────────────────────────────────────────── */
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

  /* stage: packet */
  if (stage === "packet") {
    const p = await buildPacket(uid, day, rules, acct, open);
    if ("error" in p) { await patchSession(sid, { status: "skipped", error: p.error }); return { session: { ...s, status: "skipped", error: p.error }, stage: "packet", next: false, error: p.error }; }
    const roster = (Array.isArray(acct.roster) ? (acct.roster as string[]) : []).filter((m) => /^[a-z0-9.-]+\/[a-z0-9.:_-]+$/i.test(m)).slice(0, 12);
    if (roster.length < 3) { await patchSession(sid, { status: "failed", error: "The roster needs at least three models." }); return { error: "The roster needs at least three models.", next: false }; }
    p.jurors = seededShuffle(roster, `${day}-${s.seq}`).map((model, i) => ({ juror: LETTERS[i], model }));
    const packet: J = { ...p, cardObj: undefined };
    const ok = await patchSession(sid, { packet, regime: p.regime, stage: "round1", status: isDry ? "dry" : "running" });
    if (!ok) return { error: "Couldn't save the packet.", next: false };
    return { session: { ...s, stage: "round1" }, stage: "round1", next: true, cost: 0 };
  }

  const p = s.packet as unknown as Packet;
  const cardsFromPacket = (): Record<string, TapeCard> => (p.cardObj as Record<string, TapeCard>) ?? {};
  const openSyms = open.map((t) => t.symbol);

  /* stage: round1 */
  if (stage === "round1") {
    const user = packetText(p);
    const system = r1System(p, openSyms);
    const results = await Promise.all(p.jurors.map(async (j) => ({ j, res: await callModel(key, { model: j.model, system, user, schema: R1_SCHEMA, maxTokens: 6000 }) })));
    let answered = 0, cost = 0;
    const cards = cardsFromPacket();
    const snapshotCards: Record<string, TapeCard> = {};
    for (const { j, res } of results) {
      cost += res.cost;
      const content: J = res.json ?? {};
      const props = Array.isArray(content.proposals) ? (content.proposals as J[]).slice(0, 3) : [];
      const out: J[] = [];
      for (let i = 0; i < props.length; i++) {
        const { plan, dropped } = normalizeProposal(props[i], { ...cards, ...snapshotCards });
        let drop = dropped;
        if (!drop && !cards[plan.symbol] && !snapshotCards[plan.symbol]) {
          const v = await tape(uid, { mode: "validate", symbol: plan.symbol, venue: plan.venue }, 30000);
          if (v.ok !== true) drop = str(v.error, 200) || "symbol did not validate";
          else {
            plan.instrument = v.instrument as Instrument; plan.venue = v.venue as Venue;
            p.validated[plan.symbol] = { instrument: plan.instrument, venue: plan.venue, name: str(v.name, 80), meta: (v.meta as InstrumentMeta), largeCap: v.largeCap === true, sector: str(v.sector, 40) };
            const snap = await tape(uid, { mode: "snapshot", symbols: [{ symbol: plan.symbol, venue: plan.venue }] }, 60000);
            const c = ((snap.cards as Record<string, TapeCard | { error: string }>) ?? {})[plan.symbol];
            if (c && "price" in c) { snapshotCards[plan.symbol] = c; plan.entry_ref = c.price; p.cards[plan.symbol] = cardLine(c); }
          }
        }
        out.push({ ...plan, what_would_prove_me_wrong: plan.falsifier, id: `${j.juror}${i + 1}`, ...(drop ? { dropped: drop } : {}) });
      }
      if (!res.error) answered++;
      await saveOpinion(uid, sid, j.model, j.juror, "1", res, { market_read: str(content.market_read, 900), no_trade: content.no_trade === true, no_trade_reason: str(content.no_trade_reason, 400), proposals: out });
    }
    const cardObj = { ...cards, ...snapshotCards };
    const patch: J = { packet: { ...p, cardObj }, cost_usd: num(s.cost_usd) + cost };
    if (answered < 3) { await patchSession(sid, { ...patch, status: isDry ? "dry" : "failed", stage: "round1", error: `Only ${answered} of ${p.jurors.length} jurors answered — not enough for a debate.` }); return { session: s, stage: "round1", next: false, error: `Only ${answered} jurors answered.` }; }
    await patchSession(sid, { ...patch, stage: "round2" });
    return { session: { ...s, stage: "round2" }, stage: "round2", next: true, cost };
  }

  /* shared: proposals from round 1 */
  const opR = await rest(`desk_opinions?session_id=eq.${sid}&select=model,juror,round,content,error&order=created_at.asc`);
  const ops = (opR.ok ? (opR.json as J[]) : []);
  const r1 = ops.filter((o) => o.round === "1");
  const live: { id: string; plan: Plan; juror: string; model: string }[] = [];
  for (const o of r1) for (const raw of ((o.content as J).proposals as J[]) ?? []) {
    if (raw.dropped) continue;
    live.push({ id: String(raw.id), juror: String(o.juror), model: String(o.model), plan: { ...(raw as unknown as Plan), falsifier: str(raw.what_would_prove_me_wrong ?? raw.falsifier, 400) } });
  }

  /* stage: round2 */
  if (stage === "round2") {
    const budget = num(acct.budget_usd_per_run, 1.5);
    const spent = num(s.cost_usd);
    let cost = 0;
    let ballots: Ballot[] = [];
    if (!live.length) {
      ballots = [];
    } else if (spent > 0.6 * budget) {
      ballots = p.jurors.map((j) => ({ juror: j.juror, model: j.model, stances: Object.fromEntries(live.filter((x) => x.juror === j.juror).map((x) => [x.id, { stance: "support" as const, confidence: x.plan.confidence }])) }));
      await patchSession(sid, { error: `Round 2 skipped: round 1 spent $${spent.toFixed(2)} of the $${budget.toFixed(2)} budget.` });
    } else {
      const system = `You are a juror reviewing the other jurors' proposals on a paper-trading desk. Labels are anonymous. For EVERY proposal listed, give your stance (support, oppose or abstain), your confidence 0-1 that its target is hit before its stop within its horizon, and in "counter" the strongest argument AGAINST it in one or two sentences, even for ones you support. Vote on the mechanism, the level and the size, not on tone. Then say in one line what would change your mind tonight. Return ONLY JSON matching the schema.`;
      const user = `MARKET CONTEXT (regime: ${p.regime})\n${p.context.join("\n")}\n\nTAPE CARDS\n${Object.values(p.cards).join("\n")}\n\nCALENDAR\n${p.calendar.join("\n") || "(nothing)"}\n\nPROPOSALS\n${proposalsText(live)}`;
      const results = await Promise.all(p.jurors.map(async (j) => ({ j, res: await callModel(key, { model: j.model, system, user, schema: R2_SCHEMA, maxTokens: 4000 }) })));
      const ids = new Set(live.map((x) => x.id));
      for (const { j, res } of results) {
        cost += res.cost;
        const raw = Array.isArray(res.json?.ballots) ? (res.json!.ballots as J[]) : [];
        const stances: Ballot["stances"] = {};
        const clean: J[] = [];
        for (const b of raw) {
          const id = str(b.proposal_id, 8).toUpperCase();
          if (!ids.has(id)) continue;
          const stance = b.stance === "oppose" ? "oppose" : b.stance === "abstain" ? "abstain" : "support";
          stances[id] = { stance, confidence: Math.min(0.99, Math.max(0.01, num(b.confidence, 0.5))) };
          clean.push({ proposal_id: id, stance, confidence: stances[id].confidence, counter: str(b.counter, 400) });
        }
        if (!res.error) ballots.push({ juror: j.juror, model: j.model, stances });
        await saveOpinion(uid, sid, j.model, j.juror, "2", res, { ballots: clean, change_my_mind: str(res.json?.change_my_mind, 300) });
      }
    }
    const ratR = await rest(`desk_ratings?user_id=eq.${uid}&select=model,elo,n_trades,calib`);
    const ratings = (ratR.ok ? (ratR.json as J[]) : []);
    const rated = ratings.filter((r) => num(r.n_trades) >= 10);
    const weights: Weight[] = rated.length
      ? p.jurors.map((j) => { const r = ratings.find((x) => x.model === j.model); return { model: j.model, weight: r && num(r.n_trades) >= 10 ? Math.max(0.25, (num(r.elo, 1500) - 1400) / 200) : 0.5, calib: (r?.calib as CalibBin[]) ?? [] }; })
      : equalWeights(p.jurors.map((j) => j.model)).map((w) => ({ ...w, calib: (ratings.find((x) => x.model === w.model)?.calib as CalibBin[]) ?? [] }));
    const votes = tally(live.map((x) => ({ id: x.id, plan: x.plan })), ballots, weights);
    await patchSession(sid, { votes, stage: "judge", cost_usd: num(s.cost_usd) + cost });
    return { session: { ...s, stage: "judge" }, stage: "judge", next: true, cost };
  }

  /* stage: judge */
  if (stage === "judge") {
    const votes = (s.votes as { proposal_id: string; score: number; voters: number; support: number; oppose: number; candidate: boolean; rr: number }[]) ?? [];
    const r2 = ops.filter((o) => o.round === "2");
    const ballotText = r2.map((o) => `Juror ${o.juror}: ${(((o.content as J).ballots as J[]) ?? []).map((b) => `${b.stance} ${b.proposal_id} (${(num(b.confidence) * 100).toFixed(0)}%): ${b.counter}`).join(" | ") || "no ballot"}`).join("\n");
    const tallyText = votes.map((v) => `[${v.proposal_id}] score ${v.score.toFixed(2)} · ${v.support} support / ${v.oppose} oppose of ${v.voters} · ${v.candidate ? "CANDIDATE" : "not a candidate"}`).join("\n");
    const judgeModel = /^[a-z0-9.-]+\/[a-z0-9.:_-]+$/i.test(String(acct.judge)) ? String(acct.judge) : "anthropic/claude-opus-5";
    const system = `You are the judge on a paper-trading desk. The jurors proposed and voted; code counted the votes; code will size every position. You may VETO a candidate or CUT it (size_multiplier below 1, or a lower leverage) with a stated reason. You may NOT add a trade or a symbol, and you may not take a proposal that is not a candidate. "take" means take it as sized by the rules.
Write for Ben, 19, learning markets: "narrative" = what the desk is doing tonight and why, in plain words (no advice framing, no hedging boilerplate); one "why_not" per proposal that is not being taken, naming the specific weakness; "lesson" = the one transferable thing tonight teaches, one paragraph. Return ONLY JSON matching the schema.`;
    const user = `${packetText(p).slice(0, 14000)}\n\nPROPOSALS\n${proposalsText(live) || "(none survived)"}\n\nBALLOTS\n${ballotText || "(round 2 skipped)"}\n\nTALLY\n${tallyText || "(nothing to tally)"}`;
    const res = await callModel(key, { model: judgeModel, system, user, schema: JUDGE_SCHEMA, maxTokens: 5000 });
    const jc: J = res.json ?? {};
    await saveOpinion(uid, sid, judgeModel, "J", "judge", res, { narrative: str(jc.narrative, 3000), decisions: Array.isArray(jc.decisions) ? jc.decisions : [], why_not: Array.isArray(jc.why_not) ? jc.why_not : [], lesson: str(jc.lesson, 1500) });
    const decisions = new Map<string, { action: string; size_multiplier: number; leverage: number; reason: string }>();
    for (const d of (Array.isArray(jc.decisions) ? (jc.decisions as J[]) : [])) decisions.set(str(d.proposal_id, 8).toUpperCase(), { action: str(d.action, 8), size_multiplier: Math.min(1, Math.max(0, num(d.size_multiplier, 1) || 1)), leverage: num(d.leverage, 0), reason: str(d.reason, 300) });

    const halted = !!acct.halted_until && String(acct.halted_until) >= day;
    const themeOf = (sym: string): string => {
      const v = p.validated?.[sym];
      if (ETF_THEME[sym]) return ETF_THEME[sym];
      if (/-USDT?$/.test(sym)) return "crypto";
      return v?.sector || p.sectors?.[sym] || "other";
    };
    const cards = cardsFromPacket();
    const taken: J[] = [];
    const whyNot: J[] = (Array.isArray(jc.why_not) ? (jc.why_not as J[]) : []).map((w) => ({ proposal_id: str(w.proposal_id, 8), reason: str(w.reason, 300) }));
    let newTonight = 0;
    const openNow: Trade[] = [...open];
    const dd = drawdownHalved(num(acct.peak_equity, 100000), num(acct.equity, 100000));
    for (const v of votes.filter((x) => x.candidate)) {
      const prop = live.find((x) => x.id === v.proposal_id);
      if (!prop) continue;
      const d = decisions.get(v.proposal_id);
      if (d?.action === "veto") { whyNot.push({ proposal_id: v.proposal_id, reason: `judge vetoed: ${d.reason}` }); continue; }
      const plan: Plan = { ...prop.plan };
      if (d?.action === "cut" && d.leverage > 0) plan.leverage = Math.min(plan.leverage, d.leverage);
      const val = p.validated?.[plan.symbol];
      const meta: InstrumentMeta = val?.meta ?? { max_leverage: plan.instrument === "crypto_perp" ? 20 : 1, contract_value: 1, lot_size: 1, tick_size: 0.01 };
      if (plan.instrument === "crypto_perp" && !val) {
        const vv = await tape(uid, { mode: "validate", symbol: plan.symbol, venue: "blofin" }, 30000);
        if (vv.ok === true) { Object.assign(meta, vv.meta as InstrumentMeta); p.validated[plan.symbol] = { instrument: "crypto_perp", venue: "blofin", name: str(vv.name, 80), meta: vv.meta as InstrumentMeta, largeCap: vv.largeCap === true, sector: "crypto" }; }
        else { whyNot.push({ proposal_id: v.proposal_id, reason: `guardrail: ${str(vv.error, 160)}` }); continue; }
      }
      const ctx: GuardCtx = { equity: num(acct.equity, 100000), rules, open: openNow, atr: cards[plan.symbol]?.atr14 ?? null, meta, halted, themeOf, drawdownHalved: dd, newTonight };
      const g = guardrail(plan, ctx);
      if (!g.ok || !g.sizing) { whyNot.push({ proposal_id: v.proposal_id, reason: `guardrail: ${g.reasons.join("; ")}` }); continue; }
      let qty = g.sizing.qty;
      if (d?.action === "cut" && d.size_multiplier < 1) qty = plan.instrument === "stock" || plan.instrument === "etf" ? Math.floor(qty * d.size_multiplier) : plan.instrument === "crypto_perp" ? Math.floor(qty * d.size_multiplier / meta.lot_size) * meta.lot_size : Math.round(qty * d.size_multiplier * 1e6) / 1e6;
      if (!(qty > 0)) { whyNot.push({ proposal_id: v.proposal_id, reason: "judge cut the size to nothing" }); continue; }
      const uv = g.sizing.unit === "contract" ? meta.contract_value : 1;
      const notional = qty * uv * g.plan.entry_ref;
      const row: J = {
        user_id: uid, owner: "desk", session_id: sid, proposal_id: v.proposal_id, venue: g.plan.venue, instrument: g.plan.instrument, symbol: g.plan.symbol,
        name: val?.name ?? cards[g.plan.symbol]?.name ?? g.plan.symbol, side: g.plan.side, status: "pending", template: g.plan.template, thesis: g.plan.thesis, catalyst: g.plan.catalyst,
        falsifier: g.plan.falsifier, confidence: g.plan.confidence, evidence: g.plan.evidence, regime: p.regime, decided_at: new Date().toISOString(),
        entry_ref: g.plan.entry_ref, stop: g.plan.stop, target: g.plan.target, horizon_days: g.plan.horizon_days, risk_pct: g.plan.risk_pct, leverage: g.sizing.leverage,
        qty, unit: g.sizing.unit, contract_value: uv, notional, margin: g.plan.instrument === "crypto_perp" ? notional / g.sizing.leverage : notional,
        liq_price: g.plan.instrument === "crypto_perp" ? liqPrice(g.plan.entry_ref, g.plan.side, g.sizing.leverage) : null,
        fill_rule: g.plan.instrument === "stock" || g.plan.instrument === "etf" ? "next_open" : "next_hour",
        slippage_bps: slippageBps(g.plan.instrument, g.plan.symbol, val?.largeCap ?? true, 0),
      };
      if (isDry) { taken.push({ proposal_id: v.proposal_id, symbol: g.plan.symbol, dry: true, qty, notional, reasons: g.reasons }); continue; }
      const ins = await rest("desk_trades", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
      const made = (ins.ok ? (ins.json as J[]) : [])[0];
      if (!made) { whyNot.push({ proposal_id: v.proposal_id, reason: "the order could not be written" }); continue; }
      taken.push({ trade_id: String(made.id), proposal_id: v.proposal_id, symbol: g.plan.symbol, reasons: g.reasons, judge: d?.action ?? "take" });
      openNow.push(made as unknown as Trade);
      newTonight++;
    }

    /* shadow trades: every juror's own top pick, on a fixed $100k book */
    const shadow: J[] = [];
    if (!isDry) {
      for (const j of p.jurors) {
        const mine = live.filter((x) => x.juror === j.juror);
        if (!mine.length) continue;
        const myBallot = r2.find((o) => o.juror === j.juror);
        const st = ((myBallot?.content as J)?.ballots as J[]) ?? [];
        const pick = mine.map((x) => ({ x, c: num(st.find((b) => b.proposal_id === x.id)?.confidence, x.plan.confidence) })).sort((a, b) => b.c - a.c)[0].x;
        const so = await rest(`desk_trades?user_id=eq.${uid}&owner=eq.${encodeURIComponent(j.model)}&status=in.(pending,open)&select=*`);
        const myOpen = (so.ok ? (so.json as J[]) : []).map((x) => x as unknown as Trade);
        const val = p.validated?.[pick.plan.symbol];
        const meta: InstrumentMeta = val?.meta ?? { max_leverage: pick.plan.instrument === "crypto_perp" ? 20 : 1, contract_value: 1, lot_size: 1, tick_size: 0.01 };
        const g = guardrail(pick.plan, { equity: SHADOW_START, rules, open: myOpen, atr: cards[pick.plan.symbol]?.atr14 ?? null, meta, halted: false, themeOf, drawdownHalved: false, newTonight: 0 });
        if (!g.ok || !g.sizing) { shadow.push({ model: j.model, symbol: pick.plan.symbol, skipped: g.reasons.join("; ") }); continue; }
        const uv = g.sizing.unit === "contract" ? meta.contract_value : 1;
        const notional = g.sizing.qty * uv * g.plan.entry_ref;
        const row: J = {
          user_id: uid, owner: j.model, session_id: sid, proposal_id: pick.id, venue: g.plan.venue, instrument: g.plan.instrument, symbol: g.plan.symbol,
          name: val?.name ?? cards[g.plan.symbol]?.name ?? g.plan.symbol, side: g.plan.side, status: "pending", template: g.plan.template, thesis: g.plan.thesis, catalyst: g.plan.catalyst,
          falsifier: g.plan.falsifier, confidence: g.plan.confidence, evidence: g.plan.evidence, regime: p.regime, decided_at: new Date().toISOString(),
          entry_ref: g.plan.entry_ref, stop: g.plan.stop, target: g.plan.target, horizon_days: g.plan.horizon_days, risk_pct: g.plan.risk_pct, leverage: g.sizing.leverage,
          qty: g.sizing.qty, unit: g.sizing.unit, contract_value: uv, notional, margin: g.plan.instrument === "crypto_perp" ? notional / g.sizing.leverage : notional,
          liq_price: g.plan.instrument === "crypto_perp" ? liqPrice(g.plan.entry_ref, g.plan.side, g.sizing.leverage) : null,
          fill_rule: g.plan.instrument === "stock" || g.plan.instrument === "etf" ? "next_open" : "next_hour",
          slippage_bps: slippageBps(g.plan.instrument, g.plan.symbol, val?.largeCap ?? true, 0),
        };
        const ins = await rest("desk_trades", { method: "POST", body: JSON.stringify(row) });
        shadow.push({ model: j.model, symbol: g.plan.symbol, ok: ins.ok });
      }
    }

    const failed = r1.filter((o) => o.error).map((o) => ({ model: String(o.model), error: str(o.error, 120) }));
    const dropped = r1.flatMap((o) => (((o.content as J).proposals as J[]) ?? []).filter((x) => x.dropped).map((x) => `${x.id} ${x.symbol}: ${x.dropped}`));
    const verdict: J = { narrative: str(jc.narrative, 3000) || (res.error ? `The judge did not answer (${res.error}); the tally stands on its own.` : ""), decisions: Array.isArray(jc.decisions) ? jc.decisions : [], why_not: whyNot, lesson: str(jc.lesson, 1500), taken, failed, dropped, shadow, judge_error: res.error };
    const cost = num(s.cost_usd) + res.cost;
    await patchSession(sid, { verdict, judge_model: judgeModel, status: isDry ? "dry" : "done", stage: "done", cost_usd: cost, packet: { ...p, cardObj: undefined } });
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
