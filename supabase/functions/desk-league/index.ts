// desk-league — the leagues. Nine teams (three Diamond, three Gold, three
// Bronze): each one frontier model that decides, all of them served by the
// same crew of four cheap worker models that do the brute work once per
// candidate, each team with its own $100k paper book. Every candidate the scan
// flags inside the trading hours goes to the crew once (desk_research) and
// then to every live frontier at once: the frontier decides, code sizes and
// writes the trade with a ticket. Three sessions a day the crew proposes from
// the feed and every frontier reviews its own book. A team dies 5% below its
// start and its frontier comes straight back with a new life and a fresh book;
// the daily ranking at 16:06 ET marks passive days, sets the tiers and crowns
// the season's champion.
//
// Every stage that needs more than one model call is a child invocation
// (mode decide / session_all) launched by the tick and left to finish on its
// own: the gateway cuts any invocation at 150s.
//
// verify_jwt=false; auth: the cron's vault secret, the service role, or a
// user JWT (for the buttons in the app).

import { etParts, etDate, addDays } from "./lib/clock.ts";
import { rulesFor, liqPrice } from "./lib/risk.ts";
import { guardrail, type GuardCtx } from "./lib/rules.ts";
import { bookEquity, unrealized, slippageBps, entryFees } from "./lib/ledger.ts";
import { STRATEGIES, ema, rsi } from "./lib/scan.ts";
import { leagueSettings, draftTeams, rankTiers, teamName, teamKey, deathLine, sessionDue, inHours, isPassive, rankScore, type LeagueSettings, type TeamLike, type Tier } from "./lib/league.ts";
import type { Trade, Plan, InstrumentMeta, Instrument, Venue, Bar, Rules } from "./lib/types.ts";

type J = Record<string, unknown>;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ENV_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const TAPE = `${SUPABASE_URL}/functions/v1/tape`;
const SELF = `${SUPABASE_URL}/functions/v1/desk-league`;
const OR = "https://openrouter.ai/api/v1/chat/completions";
const START = 100000;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const nul = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : num(v));
const str = (v: unknown, max = 2000): string => String(v ?? "").slice(0, max);
const iso = (ms: number) => new Date(ms).toISOString();
const round = (v: number, d = 2) => Number(v.toFixed(d));

async function rest(path: string, init?: RequestInit): Promise<{ ok: boolean; json: unknown; status: number }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...svcH, ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) console.error(`[desk-league] rest ${r.status} ${path} ${text.slice(0, 200)}`);
  return { ok: r.ok, json, status: r.status };
}
const rows = (r: { ok: boolean; json: unknown }): J[] => (r.ok && Array.isArray(r.json) ? (r.json as J[]) : []);
async function secret(name: string): Promise<string> {
  const r = await rest("rpc/get_secret", { method: "POST", body: JSON.stringify({ secret_name: name }) });
  return r.ok && typeof r.json === "string" ? r.json : "";
}
async function tape(uid: string, body: J, ms = 60000): Promise<J> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return (await (await fetch(TAPE, { method: "POST", headers: svcH, body: JSON.stringify({ ...body, userId: uid }), signal: ctl.signal })).json()) as J; }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  finally { clearTimeout(t); }
}
function launch(body: J): void {
  const p = fetch(SELF, { method: "POST", headers: svcH, body: JSON.stringify(body) }).then((r) => r.text()).catch((e) => console.error("[desk-league] launch", body.mode, e instanceof Error ? e.message : e));
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
}
async function log(uid: string, seat: string, action: string, model: string, replacedBy: string, reason: string): Promise<void> {
  await rest("desk_roster_log", { method: "POST", body: JSON.stringify({ user_id: uid, at: new Date().toISOString(), seat: seat.slice(0, 80), action, model: model.slice(0, 120), replaced_by: replacedBy.slice(0, 120), reason: reason.slice(0, 400) }) });
}

/* ── model calls ──────────────────────────────────────────────────────── */
type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: J[]; tool_call_id?: string };
type Schema = { name: string; schema: J };
type Res = { json: J | null; raw: string; cost: number; tokensIn: number; tokensOut: number; latency: number; error: string };
function parseJson(raw: string): J | null {
  const s = raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "");
  try { return JSON.parse(s) as J; } catch { /* fall through */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) as J; } catch { /* no */ } }
  return null;
}
async function chat(key: string, body: J, deadline: number): Promise<{ status: number; data: J | null; text: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.max(5000, Math.min(110_000, deadline - Date.now())));
  try {
    const r = await fetch(OR, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://bookcrewcode.github.io/daily/", "X-Title": "Daily Desk" }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    let data: J | null = null;
    try { data = JSON.parse(text) as J; } catch { /* not json */ }
    return { status: r.status, data, text };
  } catch (e) { return { status: 0, data: null, text: e instanceof Error ? e.message : String(e) }; }
  finally { clearTimeout(t); }
}
const usageOf = (d: J | null) => { const u = (d?.usage as J) ?? {}; return { cost: num(u.cost), tin: num(u.prompt_tokens), tout: num(u.completion_tokens) }; };
const messageOf = (d: J | null): J => ((((d?.choices as J[]) ?? [])[0]?.message as J) ?? {});

type Reasoning = "off" | "low" | "none";
/** What a call sends for reasoning: off (none at all: hidden thinking ate whole answer budgets), low (the frontiers), none (the field left out when a provider refuses to be told). */
const reasoningBody = (r: Reasoning): J | null => (r === "off" ? { enabled: false } : r === "low" ? { effort: "low", exclude: true } : null);
const stepDown = (r: Reasoning): Reasoning => (r === "off" ? "low" : "none"); // a provider that will not switch reasoning off gets it capped low; one that rejects that gets no instruction
/** Workers run without reasoning, except the models measured to do worse that way (GLM refuses to disable it; Qwen Max goes silent). */
const LOW_ONLY = new Set(["z-ai/glm-5.3", "qwen/qwen3.8-max-0902"]);
const workerReasoning = (model: string): Reasoning => (LOW_ONLY.has(model) ? "low" : "off");

/** One structured answer: json_schema strict when the provider can, plain JSON otherwise; a retry on the first network or 5xx failure. */
async function callModel(key: string, c: { model: string; system: string; user?: string; messages?: Msg[]; schema: Schema; maxTokens: number; deadline: number; reasoning?: Reasoning }): Promise<Res> {
  const t0 = Date.now();
  let cost = 0, tokensIn = 0, tokensOut = 0;
  let opts = { schema: true, reasoning: (c.reasoning ?? "low") as Reasoning, maxTokens: c.maxTokens };
  let last = { status: 0, data: null as J | null, text: "" };
  for (let i = 0; i < 4; i++) {
    const system = opts.schema ? c.system : `${c.system}\n\nReturn ONLY a JSON object matching this JSON Schema, no prose:\n${JSON.stringify(c.schema.schema)}`;
    const messages: Msg[] = c.messages ? [{ role: "system", content: system }, ...c.messages.filter((m) => m.role !== "system")] : [{ role: "system", content: system }, { role: "user", content: c.user ?? "" }];
    const body: J = { model: c.model, messages, max_tokens: opts.maxTokens };
    const rb = reasoningBody(opts.reasoning); if (rb) body.reasoning = rb;
    if (opts.schema) { body.response_format = { type: "json_schema", json_schema: { name: c.schema.name, strict: true, schema: c.schema.schema } }; body.provider = { require_parameters: true }; }
    last = await chat(key, body, c.deadline);
    const u = usageOf(last.data); cost += u.cost; tokensIn += u.tin; tokensOut += u.tout;
    const content = String(messageOf(last.data).content ?? "");
    if (last.status === 200 && content.trim()) {
      const json = parseJson(content);
      return { json, raw: content.slice(0, 4000), cost, tokensIn, tokensOut, latency: Date.now() - t0, error: json ? "" : "unparseable answer" };
    }
    if (last.status === 402) return { json: null, raw: "", cost, tokensIn, tokensOut, latency: Date.now() - t0, error: "OpenRouter credits are out" };
    if (c.deadline - Date.now() < 15_000) break;
    const msg = last.text.slice(0, 300);
    if (opts.schema && (last.status === 503 || (last.status === 400 && /response_format|json_schema|structured|schema/i.test(msg)) || last.status === 404)) { opts = { ...opts, schema: false }; continue; }
    if (opts.reasoning !== "none" && last.status >= 400 && last.status < 500 && /reasoning/i.test(msg)) { opts = { ...opts, reasoning: stepDown(opts.reasoning) }; continue; }
    if (last.status === 200 && !content.trim() && opts.maxTokens < c.maxTokens * 4) { opts = { ...opts, maxTokens: opts.maxTokens * 2 }; continue; }
    if (!((last.status === 0 || last.status >= 500) && i === 0)) break;
  }
  return { json: null, raw: last.text.slice(0, 1000), cost, tokensIn, tokensOut, latency: Date.now() - t0, error: last.status ? `HTTP ${last.status}: ${last.text.slice(0, 160)}` : `network: ${last.text.slice(0, 120)}` };
}

type Tool = { name: string; description: string; parameters: J; run: (args: J) => Promise<string> };
/** A worker that may look things up: tool rounds (at most maxCalls), then one structured answer. Models without tool support fall back to the plain call. */
async function agentLoop(key: string, c: { model: string; system: string; user: string; schema: Schema; tools: Tool[]; maxCalls: number; maxTokens: number; deadline: number; reasoning?: Reasoning }): Promise<Res & { checked: string[] }> {
  const t0 = Date.now();
  const checked: string[] = [];
  let cost = 0, tokensIn = 0, tokensOut = 0;
  const messages: Msg[] = [{ role: "system", content: `${c.system}\n\nYou may call the tools first (at most ${c.maxCalls} call${c.maxCalls === 1 ? "" : "s"}; answer straight away if the brief is enough). When you are done looking, answer with ONLY a JSON object matching this schema, no prose:\n${JSON.stringify(c.schema.schema)}` }, { role: "user", content: c.user }];
  const tools = c.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  let mode: Reasoning = c.reasoning ?? "low";
  let noTools = c.tools.length === 0 || c.maxCalls <= 0;
  for (let round = 0; round <= c.maxCalls && !noTools; round++) {
    if (c.deadline - Date.now() < 12_000) break;
    const body: J = { model: c.model, messages, max_tokens: c.maxTokens, tools, tool_choice: round < c.maxCalls ? "auto" : "none" };
    const rb = reasoningBody(mode); if (rb) body.reasoning = rb;
    const r = await chat(key, body, c.deadline);
    const u = usageOf(r.data); cost += u.cost; tokensIn += u.tin; tokensOut += u.tout;
    if (r.status === 402) return { json: null, raw: "", cost, tokensIn, tokensOut, latency: Date.now() - t0, error: "OpenRouter credits are out", checked };
    if (r.status !== 200) {
      if (r.status === 404 || (r.status === 400 && /tool/i.test(r.text))) { noTools = true; break; }
      if (/reasoning/i.test(r.text) && r.status < 500 && mode !== "none") { mode = stepDown(mode); round--; continue; } // the same round again, one step down
      break;
    }
    const m = messageOf(r.data);
    const calls = Array.isArray(m.tool_calls) ? (m.tool_calls as J[]) : [];
    if (!calls.length) {
      const content = String(m.content ?? "");
      const json = parseJson(content);
      if (json) return { json, raw: content.slice(0, 4000), cost, tokensIn, tokensOut, latency: Date.now() - t0, error: "", checked };
      break;
    }
    messages.push({ role: "assistant", content: String(m.content ?? ""), tool_calls: calls });
    for (const call of calls.slice(0, 3)) {
      const fn = (call.function as J) ?? {};
      const name = String(fn.name ?? "");
      let args: J = {};
      try { args = JSON.parse(String(fn.arguments ?? "{}")) as J; } catch { args = {}; }
      const tool = c.tools.find((t) => t.name === name);
      let out = "";
      try { out = tool ? await tool.run(args) : `no tool named ${name}`; } catch (e) { out = `the look-up failed: ${e instanceof Error ? e.message : String(e)}`; }
      checked.push(`${name}${Object.keys(args).length ? " " + JSON.stringify(args).slice(0, 60) : ""}`);
      messages.push({ role: "tool", tool_call_id: String(call.id ?? ""), content: out.slice(0, 6000) });
    }
  }
  // the structured answer, with whatever was looked up still in the thread; a provider that rejects the tool thread gets a plain summary instead
  let final = await callModel(key, { model: c.model, system: c.system, messages: [...messages.filter((m) => m.role !== "system"), { role: "user", content: "Answer now with ONLY the JSON." }], schema: c.schema, maxTokens: c.maxTokens, deadline: c.deadline, reasoning: mode });
  if (!final.json && c.deadline - Date.now() > 12_000) {
    const looked = messages.filter((m) => m.role === "tool").map((m, i) => `LOOK-UP ${i + 1} (${checked[i] ?? ""})\n${m.content}`).join("\n\n");
    const again = await callModel(key, { model: c.model, system: c.system, user: `${c.user}${looked ? `\n\nWHAT YOU LOOKED UP\n${looked}` : ""}\n\nAnswer now with ONLY the JSON.`, schema: c.schema, maxTokens: c.maxTokens, deadline: c.deadline, reasoning: mode });
    final = { ...again, cost: again.cost + final.cost, tokensIn: again.tokensIn + final.tokensIn, tokensOut: again.tokensOut + final.tokensOut };
  }
  return { ...final, cost: final.cost + cost, tokensIn: final.tokensIn + tokensIn, tokensOut: final.tokensOut + tokensOut, latency: Date.now() - t0, checked };
}
async function saveOpinion(uid: string, decisionId: string | null, model: string, juror: string, round: string, res: Res, content: J, researchId: string | null = null): Promise<void> {
  await rest("desk_opinions", { method: "POST", body: JSON.stringify({ user_id: uid, session_id: null, sit_id: null, decision_id: decisionId, research_id: researchId, model, juror, round, content, raw: res.raw.slice(0, 4000), latency_ms: res.latency, cost_usd: res.cost, tokens_in: res.tokensIn, tokens_out: res.tokensOut, error: res.error }) });
}

/* ── schemas and prompts ──────────────────────────────────────────────── */
const BALLOT_SCHEMA: Schema = { name: "ballot", schema: { type: "object", additionalProperties: false, required: ["stance", "confidence", "stop", "target", "leverage", "thesis", "wrong_if", "tags"], properties: {
  stance: { type: "string", enum: ["take", "pass"] }, confidence: { type: "number" }, stop: { type: "number" }, target: { type: "number" }, leverage: { type: "number" },
  thesis: { type: "string" }, wrong_if: { type: "string" }, tags: { type: "array", items: { type: "string" } } } } };
const FRONTIER_SCHEMA: Schema = { name: "frontier", schema: { type: "object", additionalProperties: false, required: ["decisions", "note"], properties: {
  decisions: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "action", "reason", "risk_pct", "leverage", "stop", "target"], properties: {
    id: { type: "string" }, action: { type: "string", enum: ["take", "pass"] }, reason: { type: "string" }, risk_pct: { type: "number" }, leverage: { type: "number" }, stop: { type: "number" }, target: { type: "number" } } } },
  note: { type: "string" } } } };
const PROPOSE_SCHEMA: Schema = { name: "idea", schema: { type: "object", additionalProperties: false, required: ["has_idea", "reason", "symbol", "venue", "side", "thesis", "catalyst", "wrong_if", "stop", "target", "horizon_days", "leverage", "confidence", "evidence"], properties: {
  has_idea: { type: "boolean" }, reason: { type: "string" }, symbol: { type: "string" }, venue: { type: "string", enum: ["robinhood", "blofin"] }, side: { type: "string", enum: ["long", "short"] },
  thesis: { type: "string" }, catalyst: { type: "string" }, wrong_if: { type: "string" }, stop: { type: "number" }, target: { type: "number" }, horizon_days: { type: "integer" }, leverage: { type: "number" }, confidence: { type: "number" }, evidence: { type: "array", items: { type: "string" } } } } };
const SESSION_SCHEMA: Schema = { name: "session", schema: { type: "object", additionalProperties: false, required: ["positions", "takes", "note"], properties: {
  positions: { type: "array", items: { type: "object", additionalProperties: false, required: ["trade_id", "action", "reason", "stop", "target"], properties: { trade_id: { type: "string" }, action: { type: "string", enum: ["hold", "close", "tighten"] }, reason: { type: "string" }, stop: { type: "number" }, target: { type: "number" } } } },
  takes: { type: "array", items: { type: "object", additionalProperties: false, required: ["proposal", "action", "reason", "risk_pct", "leverage"], properties: { proposal: { type: "integer" }, action: { type: "string", enum: ["take", "pass"] }, reason: { type: "string" }, risk_pct: { type: "number" }, leverage: { type: "number" } } } },
  note: { type: "string" } } } };
const TF_WORDS: Record<string, string> = { scalp: "hours", swing: "days", position: "weeks" };
const COMPETITION = (s: LeagueSettings) => `THIS IS A COMPETITION. The objective is to make as much as possible. The tiers rank by percent return and survival alone ranks nothing: a team that takes fewer than ${s.min_takes_day} trades in a day AND keeps less than ${s.min_heat_pct}% of its book at risk in open positions is "playing to survive"; every such day docks ${s.passive_penalty_pct}% from its ranked return and it cannot climb that day. Risk what the death line allows, size for it, and get paid for being right.`;
function bookText(b: BookState): string {
  return `THE TEAM'S BOOK: paper equity $${b.equity.toFixed(0)} (${b.return_pct >= 0 ? "+" : ""}${b.return_pct.toFixed(2)}% since the start${b.passive_days ? `; ranked at ${b.rank_score >= 0 ? "+" : ""}${b.rank_score.toFixed(2)}% after ${b.passive_days} passive day${b.passive_days === 1 ? "" : "s"}` : ""}) · the team DIES at $${b.death_line.toFixed(0)}, ${b.distance_pct.toFixed(2)}% away · open risk ${b.heat_pct.toFixed(1)}% of the book · today so far: ${b.takes_day} take${b.takes_day === 1 ? "" : "s"} · open: ${b.open.length ? b.open.join("; ") : "nothing"}`;
}
/** The crew researches once for every team, so it sees no team's book: the setup, the strategy, its record, the tape and the news. */
function crewSystem(s: LeagueSettings): string {
  const n = s.research === "light" ? s.worker_lookups : 0;
  return `You are on the research crew of a paper-trading tournament run by Ben, 19, who is learning markets by watching it. Nine frontier models each run a team and decide; you do the brute work once and every frontier reads your ballot. A coded strategy has flagged a setup. Check the mechanism (does the reason for the move hold up?), the level (is the entry good here, or has the move already happened?), the timing (an event or headline that changes it) and the size of the risk.${n ? ` You may make at most ${n} look-up${n === 1 ? "" : "s"} first (candles at another interval, the funding rate, a news search, the strategy's record). Quality over quantity: look only when the answer would change your vote, and look up the one thing that decides it.` : " There are no look-ups: vote on the brief."}
Vote "take" or "pass" with your confidence 0-1 that the target is hit before the stop within the horizon. Your vote and your confidence are scored against what the strategy's own rule-only book does with this exact setup, so passing on winners costs you as much as taking losers. Say what you believe, once, briefly.
You may tighten the stop or target and lower the leverage; you may not widen the stop or change the symbol (return the setup's own numbers when you change nothing). Thesis in at most 40 words built on the one fact that decides it; "wrong_if" is one observable thing. Tags from: chase, extended, no-catalyst, event-risk, crowded, thin-volume, counter-trend, clean, strong-confluence.
Write in English. Return ONLY JSON matching the schema.`;
}
function frontierSystem(team: TeamRow, b: BookState, s: LeagueSettings): string {
  return `You are the frontier of team "${team.name}" in the ${team.tier} league of a paper-trading tournament run by Ben, 19, who is learning markets by watching you. Nine teams compete, one frontier each, all served by the same research crew; the top three by ranked return are Diamond, the next three Gold, the rest Bronze; any team ${s.death_pct}% below its start dies on the spot and its frontier starts again with a fresh book and a death on its record. The crew did the brute work and voted; you decide, and only your decisions set your team apart.
${COMPETITION(s)}
For every candidate below, answer take or pass with a specific reason (one or two sentences: the mechanism, the level, the record, or what the crew missed). For a take, set risk_pct: the share of the book one stop costs, between 0.5 and ${s.risk_max_pct}. The death line is ${s.death_pct}% below the start, so risk_pct is how many wrong trades in a row you can survive; a team that never risks anything never makes anything. Set leverage for a perp between 1 and the setup's hint (never above it); return 1 for stocks. You may tighten the stop or target; return the setup's numbers to keep them. Passing everything is also a decision and it is judged as playing to survive. Take the candidates whose mechanism, level and record agree, size them to make as much as the death line allows, and say why.
${bookText(b)}
Write in English. Return ONLY JSON matching the schema.`;
}
const PROPOSE_SYSTEM = (s: LeagueSettings) => `You are on the research crew of a paper-trading tournament run by Ben, 19, who is learning markets by watching it; nine frontier models each run a team and every one of them will read your proposal. ${COMPETITION(s)} This is a session: read the news since the last session and the tape, and propose at most ONE trade for the frontiers, or say you have none and why. A proposal needs a mechanism from a story to a price, a current-price entry, a stop, a target, a horizon in days, leverage for a perp (1 for stocks), and the headlines it rests on ("evidence": short quotes of the headline lines). Symbols: any US stock or ETF on Robinhood (venue robinhood), or a BloFin perpetual written BASE-USDT (venue blofin). Quality over quantity: one idea you would put your own money on, or none. Write in English. Return ONLY JSON matching the schema.`;
const SESSION_SYSTEM = (team: TeamRow, b: BookState, s: LeagueSettings) => `You are the frontier of team "${team.name}" (${team.tier} league) in a paper-trading tournament run by Ben, 19, who is learning markets by watching you. ${COMPETITION(s)} A session: first review every open position with fresh prices and headlines and answer hold, close or tighten (a tighter stop or target only; never wider) with a reason. Then judge the crew's proposals, which every frontier is judging at the same time: take or pass each with a reason; for a take set risk_pct (0.5 to ${s.risk_max_pct}) and leverage (1 to the venue's limit for a perp; 1 for stocks). At most two takes. The team dies ${s.death_pct}% below its start. Write in English. Return ONLY JSON matching the schema.
${bookText(b)}`;

type TeamRow = { id: string; name: string; frontier: string; workers: string[]; seniors: string[]; combo: string; tier: Tier; status: "live" | "dead"; season: number; formed_at: string; start_equity: number; equity: number; peak: number; return_pct: number; stats: J };
type BookState = { equity: number; return_pct: number; death_line: number; distance_pct: number; open: string[]; openTrades: Trade[]; closedPnl: number; heat_pct: number; takes_day: number; passive_days: number; rank_score: number; funding?: Record<string, number>; regime?: string };
const toTeam = (x: J): TeamRow => ({ id: String(x.id), name: String(x.name ?? ""), frontier: String(x.frontier ?? ""), workers: Array.isArray(x.workers) ? (x.workers as string[]) : [], seniors: Array.isArray(x.seniors) ? (x.seniors as string[]) : [], combo: String(x.combo ?? ""), tier: (x.tier as Tier) ?? "bronze", status: x.status === "dead" ? "dead" : "live", season: num(x.season, 1), formed_at: String(x.formed_at ?? ""), start_equity: num(x.start_equity, START), equity: num(x.equity, START), peak: num(x.peak, START), return_pct: num(x.return_pct), stats: (x.stats as J) ?? {} });
const teamLike = (t: TeamRow): TeamLike => ({ id: t.id, frontier: t.frontier, workers: t.workers, status: t.status, return_pct: t.return_pct, formed_at: t.formed_at, score: typeof t.stats.rank_score === "number" ? (t.stats.rank_score as number) : undefined });
const heatOf = (open: Trade[], equity: number) => (equity > 0 ? open.filter((t) => t.status === "open").reduce((a, o) => a + Math.abs((o.entry_price ?? o.entry_ref) - o.stop) * o.qty * (o.unit === "contract" ? o.contract_value : 1), 0) / equity * 100 : 0);
function toTrade(x: J): Trade {
  return {
    id: String(x.id), owner: String(x.owner ?? "desk"), session_id: null, proposal_id: String(x.proposal_id ?? ""), source: (x.source as Trade["source"]) ?? "league", strategy: String(x.strategy ?? ""), timeframe: (x.timeframe as Trade["timeframe"]) ?? "swing",
    sit_id: null, horizon_hours: nul(x.horizon_hours), size_mult: 1, venue: x.venue as Venue, instrument: x.instrument as Instrument, symbol: String(x.symbol), name: String(x.name ?? ""), side: x.side as Trade["side"], status: x.status as Trade["status"],
    template: 0, thesis: String(x.thesis ?? ""), catalyst: String(x.catalyst ?? ""), falsifier: String(x.falsifier ?? ""), confidence: num(x.confidence, 0.5), evidence: [], regime: String(x.regime ?? ""), decided_at: String(x.decided_at ?? ""),
    entry_ref: num(x.entry_ref), stop: num(x.stop), target: num(x.target), horizon_days: num(x.horizon_days, 10), risk_pct: num(x.risk_pct, 2), leverage: num(x.leverage, 1), qty: num(x.qty), unit: (x.unit as Trade["unit"]) ?? "share", contract_value: num(x.contract_value, 1),
    notional: num(x.notional), margin: num(x.margin), liq_price: nul(x.liq_price), entry_price: nul(x.entry_price), entry_at: x.entry_at ? String(x.entry_at) : null, fill_rule: String(x.fill_rule ?? ""), slippage_bps: num(x.slippage_bps),
    fees: num(x.fees), funding: num(x.funding), funding_at: null, checked_until: null, expires_on: x.expires_on ? String(x.expires_on) : null, exit_price: nul(x.exit_price), exit_at: x.exit_at ? String(x.exit_at) : null, exit_reason: (x.exit_reason as Trade["exit_reason"]) ?? null,
    ambiguous_bar: false, pnl: nul(x.pnl), pnl_pct: nul(x.pnl_pct), r_multiple: nul(x.r_multiple), mae_r: nul(x.mae_r), mfe_r: nul(x.mfe_r), spy_entry: null, spy_exit: null, review: (x.review as J) ?? null, ticket: (x.ticket as J) ?? null,
  };
}
const TRADE_COLS = "id,owner,proposal_id,source,strategy,timeframe,horizon_hours,venue,instrument,symbol,name,side,status,thesis,catalyst,falsifier,confidence,regime,decided_at,entry_ref,stop,target,horizon_days,risk_pct,leverage,qty,unit,contract_value,notional,margin,liq_price,entry_price,entry_at,fill_rule,slippage_bps,fees,funding,expires_on,exit_price,exit_at,exit_reason,pnl,pnl_pct,r_multiple,mae_r,mfe_r,review,ticket";
async function loadAccount(uid: string): Promise<J | null> { return rows(await rest(`desk_accounts?user_id=eq.${uid}&select=*`))[0] ?? null; }
async function loadTeams(uid: string): Promise<TeamRow[]> { return rows(await rest(`desk_teams?user_id=eq.${uid}&select=*&order=formed_at.asc`)).map(toTeam); }
async function loadTeam(uid: string, id: string): Promise<TeamRow | null> { const r = rows(await rest(`desk_teams?id=eq.${id}&user_id=eq.${uid}&select=*`))[0]; return r ? toTeam(r) : null; }
async function teamTrades(uid: string, teamId: string, statuses: string): Promise<Trade[]> { return rows(await rest(`desk_trades?user_id=eq.${uid}&owner=eq.${encodeURIComponent(`team:${teamId}`)}&status=in.(${statuses})&select=${TRADE_COLS}&order=created_at.asc&limit=1000`)).map(toTrade); }
async function quotesFor(uid: string, list: { symbol: string; venue: string }[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const seen = new Map<string, { symbol: string; venue: string }>();
  for (const s of list) if (!seen.has(s.symbol)) seen.set(s.symbol, s);
  const all = [...seen.values()];
  for (let i = 0; i < all.length; i += 60) {
    const q = await tape(uid, { mode: "quotes", symbols: all.slice(i, i + 60) }, 40000);
    for (const [sym, v] of Object.entries((q.quotes as Record<string, J>) ?? {})) { const p = num((v as J).price, NaN); if (Number.isFinite(p)) out[sym] = p; }
  }
  return out;
}
async function bookState(uid: string, team: TeamRow, s: LeagueSettings, marks?: Record<string, number>): Promise<BookState> {
  const trades = await teamTrades(uid, team.id, "pending,open,closed");
  const open = trades.filter((t) => t.status === "open" || t.status === "pending");
  const closed = trades.filter((t) => t.status === "closed");
  const mk = marks ?? (open.length ? await quotesFor(uid, open.map((t) => ({ symbol: t.symbol, venue: t.venue }))) : {});
  const eq = bookEquity(team.start_equity, closed, open, mk);
  const dl = deathLine(team.start_equity, s.death_pct);
  const openLines = open.map((t) => `${t.symbol} ${t.side}${t.instrument === "crypto_perp" ? ` ${t.leverage}x` : ""} ${t.status}${t.entry_price ? ` in at ${t.entry_price}` : ""} stop ${t.stop} target ${t.target}${mk[t.symbol] && t.status === "open" ? ` now ${mk[t.symbol]} (${unrealized(t, mk[t.symbol]) >= 0 ? "+" : ""}$${unrealized(t, mk[t.symbol]).toFixed(0)})` : ""}`);
  const dayStart = Date.now() - 24 * 3_600_000;
  const takesDay = trades.filter((t) => Date.parse(t.decided_at) >= dayStart && t.status !== "cancelled").length;
  const ret = (eq.equity / team.start_equity - 1) * 100;
  const passiveDays = num(team.stats.passive_days);
  return { equity: eq.equity, return_pct: ret, death_line: dl, distance_pct: (eq.equity - dl) / team.start_equity * 100, open: openLines, openTrades: open, closedPnl: closed.reduce((a, t) => a + (t.pnl ?? 0), 0), heat_pct: heatOf(open, eq.equity), takes_day: takesDay, passive_days: passiveDays, rank_score: rankScore(ret, passiveDays, s) };
}
async function bumpStats(teamId: string, delta: Record<string, number>): Promise<void> {
  const t = rows(await rest(`desk_teams?id=eq.${teamId}&select=stats`))[0];
  const stats = ((t?.stats as J) ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(delta)) stats[k] = num(stats[k]) + v;
  await rest(`desk_teams?id=eq.${teamId}`, { method: "PATCH", body: JSON.stringify({ stats }) });
}
async function currentSeason(uid: string, s: LeagueSettings, today: string): Promise<J> {
  const running = rows(await rest(`desk_seasons?user_id=eq.${uid}&status=eq.running&select=*&order=n.desc&limit=1`))[0];
  if (running) return running;
  const last = rows(await rest(`desk_seasons?user_id=eq.${uid}&select=n&order=n.desc&limit=1`))[0];
  const n = num(last?.n) + 1;
  const made = rows(await rest("desk_seasons", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ user_id: uid, n, start_day: today, end_day: addDays(today, s.season_days), status: "running" }) }))[0];
  return made ?? { n, start_day: today, end_day: addDays(today, s.season_days) };
}
async function championId(uid: string): Promise<string | null> {
  const done = rows(await rest(`desk_seasons?user_id=eq.${uid}&status=eq.done&champion_team=not.is.null&select=champion_team&order=n.desc&limit=1`))[0];
  return done?.champion_team ? String(done.champion_team) : null;
}
async function spentToday(uid: string, day: string): Promise<number> {
  const r = rows(await rest(`desk_opinions?user_id=eq.${uid}&created_at=gte.${day}T04:00:00Z&select=cost_usd&limit=5000`));
  return r.reduce((a, o) => a + num(o.cost_usd), 0);
}
async function insertTeam(uid: string, s: LeagueSettings, all: TeamRow[], frontier: string, tier: Tier, season: number, why: string): Promise<TeamRow | null> {
  const ordinal = all.filter((t) => t.frontier === frontier).length + 1;
  const name = teamName(frontier, ordinal);
  const made = rows(await rest("desk_teams", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ user_id: uid, name, frontier, workers: s.worker_pool, seniors: [], combo: teamKey(frontier, ordinal), tier, status: "live", season, start_equity: START, equity: START, peak: START, return_pct: 0, stats: {} }) }))[0];
  if (!made) return null;
  await log(uid, name, "formed", frontier, "", why);
  const row = toTeam(made);
  all.push(row);
  return row;
}
/** A team dies: its orders are cancelled, its positions closed at the next quote, and its frontier comes straight back with a new life, a fresh book and a death on its record, in Bronze until the next ranking. */
async function dieTeam(uid: string, s: LeagueSettings, all: TeamRow[], team: TeamRow, reason: string, season: number): Promise<{ replacement: TeamRow | null }> {
  await rest(`desk_teams?id=eq.${team.id}`, { method: "PATCH", body: JSON.stringify({ status: "dead", died_at: new Date().toISOString(), death_reason: reason.slice(0, 300) }) });
  team.status = "dead";
  const open = await teamTrades(uid, team.id, "pending,open");
  for (const t of open) {
    if (t.status === "pending") await rest(`desk_trades?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled", exit_reason: "cancelled", review: { note: `the team died: ${reason}` } }) });
    else await rest(`desk_trades?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ close_requested_at: new Date().toISOString(), close_reason: `the team died: ${reason}` }) });
  }
  await log(uid, team.name, "died", team.frontier, "", reason);
  const made = await insertTeam(uid, s, all, team.frontier, "bronze", season, `${team.name} died (${reason}); a new life on a fresh book`);
  return { replacement: made };
}
/** Every live team's equity at live marks; a team at or below its death line dies here and a replacement forms. */
async function markTeams(uid: string, s: LeagueSettings, all: TeamRow[], season: number): Promise<{ marked: number; died: string[] }> {
  const live = all.filter((t) => t.status === "live");
  if (!live.length) return { marked: 0, died: [] };
  const trades = rows(await rest(`desk_trades?user_id=eq.${uid}&owner=like.team:*&status=in.(pending,open,closed)&select=${TRADE_COLS}&limit=5000`)).map(toTrade);
  const open = trades.filter((t) => t.status === "open");
  const marks = open.length ? await quotesFor(uid, open.map((t) => ({ symbol: t.symbol, venue: t.venue }))) : {};
  const died: string[] = [];
  let marked = 0;
  for (const team of live) {
    const mine = trades.filter((t) => t.owner === `team:${team.id}`);
    const eq = bookEquity(team.start_equity, mine.filter((t) => t.status === "closed"), mine.filter((t) => t.status === "open" || t.status === "pending"), marks);
    const ret = (eq.equity / team.start_equity - 1) * 100;
    const peak = Math.max(team.peak, eq.equity);
    await rest(`desk_teams?id=eq.${team.id}`, { method: "PATCH", body: JSON.stringify({ equity: round(eq.equity, 2), peak: round(peak, 2), return_pct: round(ret, 4), marked_at: new Date().toISOString() }) });
    team.equity = eq.equity; team.peak = peak; team.return_pct = ret;
    marked++;
    if (eq.equity <= deathLine(team.start_equity, s.death_pct)) {
      const reason = `the book fell to $${eq.equity.toFixed(0)}, ${((1 - eq.equity / team.start_equity) * 100).toFixed(2)}% below its start (the line is ${s.death_pct}%)`;
      await dieTeam(uid, s, all, team, reason, season);
      died.push(team.name);
    }
  }
  return { marked, died };
}

/* ── the candidate brief (shared by every team) ───────────────────────── */
async function candidateBrief(uid: string, su: J, news: J[]): Promise<J> {
  const sym = String(su.symbol), base = sym.split("-")[0];
  const line = (n: J) => `${str(n.title, 110)} (impact ${n.impact}, ${n.direction}, ${n.category}${n.why ? `: ${str(n.why, 120)}` : ""})`;
  const mine = news.filter((n) => (Array.isArray(n.tickers) ? (n.tickers as string[]) : []).some((t) => t === sym || t === base)).slice(0, 6);
  const macro = news.filter((n) => n.venue === "macro" && num(n.impact) >= 4).slice(0, 5);
  const def = STRATEGIES.find((x) => x.id === su.strategy);
  const stR = rows(await rest(`desk_strategies?user_id=eq.${uid}&id=eq.${encodeURIComponent(String(su.strategy))}&select=stats,size_mult,benched_until`))[0];
  const shadow = rows(await rest(`desk_trades?user_id=eq.${uid}&owner=eq.${encodeURIComponent(`strat:${su.strategy}`)}&status=eq.closed&select=symbol,exit_reason,r_multiple,exit_at&order=exit_at.desc&limit=10`));
  const stats = (stR?.stats as J) ?? {};
  const record = `${def?.name ?? su.strategy}: ${num(stats.n) ? `${stats.n} closed in its own rule-only book, hit rate ${(num(stats.hit) * 100).toFixed(0)}%, mean ${num(stats.mean_r) >= 0 ? "+" : ""}${num(stats.mean_r).toFixed(2)}R (shrunk ${num(stats.shrunk_r) >= 0 ? "+" : ""}${num(stats.shrunk_r).toFixed(2)}R), ${str(stats.label, 30)}` : "no closed trades in its own book yet"}${shadow.length ? `. Last results: ${shadow.map((x) => `${x.symbol} ${x.exit_reason} ${num(x.r_multiple) >= 0 ? "+" : ""}${num(x.r_multiple).toFixed(2)}R`).join(", ")}` : ""}`;
  return {
    setup: { symbol: sym, venue: su.venue, instrument: su.instrument, side: su.side, timeframe: su.timeframe, entry_ref: num(su.entry_ref), stop: num(su.stop), target: num(su.target), leverage_hint: num(su.leverage_hint, 1), horizon_hours: su.horizon_hours ?? null, horizon_days: su.horizon_days ?? null, score: num(su.score), reasons: su.reasons ?? [], invalidation: str(su.invalidation, 300), card: su.card ?? {}, strategy: su.strategy },
    strategy: def ? { name: def.name, what: def.what, why: def.why, fails: def.fails } : { name: String(su.strategy) },
    headlines: mine.map(line), macro: macro.map(line), regime: str((su.card as J)?.regime, 60), record,
  };
}
function briefText(b: J, book: BookState | null, rules: Rules): string {
  const s = b.setup as J;
  const rr = Math.abs(num(s.target) - num(s.entry_ref)) / Math.max(1e-9, Math.abs(num(s.entry_ref) - num(s.stop)));
  const st = (b.strategy as J) ?? {};
  const reasons = Array.isArray(s.reasons) ? (s.reasons as J[]) : [];
  return [
    `SETUP: ${s.symbol} ${s.side} (${s.venue}, ${s.instrument}) · ${s.timeframe} (${TF_WORDS[String(s.timeframe)] ?? "days"}) · horizon ${s.horizon_hours ? `${s.horizon_hours} hours` : `${s.horizon_days} days`}${s.instrument === "crypto_perp" ? ` · leverage hint ${s.leverage_hint}x` : ""}`,
    `LEVELS: entry ${s.entry_ref} · stop ${s.stop} · target ${s.target} · reward:risk ${rr.toFixed(2)} · confluence score ${(num(s.score) * 100).toFixed(0)}%`,
    `STRATEGY: ${st.name ?? ""} — ${st.what ?? ""} Why it might work: ${st.why ?? ""} When it fails: ${st.fails ?? ""}`,
    `THE STRATEGY'S RECORD: ${b.record}`,
    "CHECKS (core must all hold; the rest are confirmations):",
    ...reasons.map((r) => `  [${r.ok ? "ok" : "no"}] ${r.core ? "core" : "confirm"} · ${r.label}: ${r.value}`),
    `INVALIDATION: ${s.invalidation}`,
    `TAPE: ${Object.entries((s.card as J) ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k} ${typeof v === "number" ? (Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(4)) : v}`).join(" · ")}`,
    `REGIME: ${b.regime}`,
    `HEADLINES ON ${s.symbol} (last 24h): ${(b.headlines as string[]).length ? "" : "none"}`, ...(b.headlines as string[]).map((h) => `  - ${h}`),
    `MACRO (last 24h): ${(b.macro as string[]).length ? "" : "quiet"}`, ...(b.macro as string[]).map((h) => `  - ${h}`),
    ...(book ? [bookText(book)] : []),
    `RULES: risk per trade up to ${rules.risk_pct}% · reward:risk at least ${rules.min_rr} · perps up to ${rules.max_leverage}x · at most ${rules.max_open} open`,
  ].join("\n");
}

/* ── research tools for the workers ───────────────────────────────────── */
type BarCache = Record<string, Record<string, Bar[]>>; // symbol → interval → bars
const toBars = (j: J): Bar[] => (Array.isArray(j.bars) ? (j.bars as J[]).map((b) => ({ t: num(b.t), o: num(b.o), h: num(b.h), l: num(b.l), c: num(b.c), v: num(b.v) })) : []);
function intervalsFor(timeframe: string, instrument: string): string[] {
  if (timeframe === "scalp") return ["5m", "1h"];
  if (timeframe === "position") return ["1d", instrument === "crypto_perp" ? "4h" : "1h"];
  return instrument === "crypto_perp" ? ["1h", "4h", "1d"] : ["1h", "1d"];
}
async function prefetchBars(uid: string, wants: { symbol: string; venue: string; instrument: string; timeframe: string }[]): Promise<BarCache> {
  const cache: BarCache = {};
  const jobs: { symbol: string; venue: string; instrument: string; interval: string }[] = [];
  for (const w of wants) for (const iv of intervalsFor(w.timeframe, w.instrument)) if (!jobs.some((j) => j.symbol === w.symbol && j.interval === iv)) jobs.push({ symbol: w.symbol, venue: w.venue, instrument: w.instrument, interval: iv });
  let i = 0;
  const run = async () => { while (i < jobs.length) { const j = jobs[i++]; const r = await tape(uid, { mode: "bars", symbol: j.symbol, venue: j.venue, instrument: j.instrument, interval: j.interval, limit: 120, range: j.interval === "5m" ? "5d" : undefined }, 30000); (cache[j.symbol] ??= {})[j.interval] = toBars(r); } };
  await Promise.all([run(), run()]);
  return cache;
}
function barsSummary(bars: Bar[], count: number): string {
  if (!bars.length) return "no candles at that interval";
  const closes = bars.map((b) => b.c);
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  const r14 = rsi(closes, 14);
  const last = bars.slice(-Math.max(5, Math.min(60, count)));
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(2) : v.toPrecision(5));
  return [`${bars.length} candles on file; the last ${last.length}, oldest first (time UTC, open high low close volume):`, ...last.map((b) => `${new Date(b.t).toISOString().slice(5, 16).replace("T", " ")} ${fmt(b.o)} ${fmt(b.h)} ${fmt(b.l)} ${fmt(b.c)} ${Math.round(b.v)}`),
    `EMA20 ${e20.length ? fmt(e20[e20.length - 1]) : "n/a"} · EMA50 ${e50.length ? fmt(e50[e50.length - 1]) : "n/a"} · RSI14 ${r14 === null ? "n/a" : r14.toFixed(0)} · last close ${fmt(closes[closes.length - 1])}`].join("\n");
}
async function newsSearch(query: string, feed: J[]): Promise<string> {
  const q = query.trim().slice(0, 80);
  const lines: string[] = [];
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:3d")}&hl=en-US&gl=US&ceid=US:en`, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (Daily Desk)" } });
    clearTimeout(t);
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8);
    for (const m of items) {
      const title = (m[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] ?? "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
      const date = m[1].match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] ?? "";
      if (title) lines.push(`- ${title}${date ? ` (${new Date(date).toISOString().slice(0, 16).replace("T", " ")}Z)` : ""}`);
    }
  } catch (e) { lines.push(`(news search failed: ${e instanceof Error ? e.message : String(e)})`); }
  const ql = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const mine = feed.filter((n) => { const t = String(n.title ?? "").toLowerCase(); return ql.some((w) => t.includes(w)); }).slice(0, 6);
  if (mine.length) lines.push("From the desk's own tagged feed:", ...mine.map((n) => `- ${str(n.title, 110)} (impact ${n.impact}, ${n.direction})`));
  return lines.length ? lines.join("\n") : "nothing found";
}
function toolsFor(uid: string, setup: J, cache: BarCache, feed: J[], funding: Record<string, number>, record: string, book: BookState | null): Tool[] {
  const sym = String(setup.symbol), venue = String(setup.venue), instrument = String(setup.instrument);
  return [
    { name: "bars", description: "Recent candles for this symbol at an interval (5m, 1h, 4h, 1d), oldest first, with EMA20, EMA50 and RSI14 of the closes.", parameters: { type: "object", properties: { interval: { type: "string", enum: ["5m", "1h", "4h", "1d"] }, count: { type: "integer", minimum: 5, maximum: 60 } }, required: ["interval"], additionalProperties: false },
      run: async (a) => { const iv = String(a.interval ?? "1h"); let bars = cache[sym]?.[iv]; if (!bars) { bars = toBars(await tape(uid, { mode: "bars", symbol: sym, venue, instrument, interval: iv, limit: 120, range: iv === "5m" ? "5d" : undefined }, 25000)); (cache[sym] ??= {})[iv] = bars; } return barsSummary(bars, num(a.count, 30)); } },
    { name: "news", description: "Search the news of the last three days for a query (a company, a coin, a theme) and the desk's own tagged feed.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      run: (a) => newsSearch(String(a.query ?? sym), feed) },
    { name: "funding", description: "For a perpetual: the funding rate now (per eight hours) and what it means.", parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async () => { const r = funding[sym]; return typeof r === "number" ? `${sym} funding ${(r * 100).toFixed(4)}% per eight hours (${r > 0.0005 ? "longs are paying: the long side is crowded" : r < -0.0005 ? "shorts are paying: the short side is crowded" : "calm"}); annualised about ${(r * 3 * 365 * 100).toFixed(0)}%` : `${sym} is not a perp, or no funding rate on file`; } },
    { name: "record", description: "The strategy's record in its own rule-only book and this team's book right now.", parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async () => (book ? `${record}\n${bookText(book)}` : record) },
  ];
}

/* ── workers vote, the frontier decides, code executes ────────────────── */
type Ballot = { model: string; role: "worker" | "frontier"; stance: "take" | "pass"; confidence: number; thesis: string; wrong_if: string; stop: number | null; target: number | null; leverage: number | null; tags: string[]; checked: string[]; error: string; cost_usd: number; latency_ms: number };
async function crewBallot(uid: string, key: string, model: string, researchId: string, brief: J, rules: Rules, s: LeagueSettings, tools: Tool[], deadline: number): Promise<Ballot> {
  const system = crewSystem(s);
  const user = briefText(brief, null, rules);
  const res = s.research === "light" && s.worker_lookups > 0
    ? await agentLoop(key, { model, system, user, schema: BALLOT_SCHEMA, tools, maxCalls: s.worker_lookups, maxTokens: 2500, deadline, reasoning: workerReasoning(model) })
    : { ...(await callModel(key, { model, system, user, schema: BALLOT_SCHEMA, maxTokens: 2500, deadline, reasoning: workerReasoning(model) })), checked: [] as string[] };
  const j = res.json ?? {};
  const ballot: Ballot = {
    model, role: "worker", stance: j.stance === "take" ? "take" : "pass", confidence: Math.min(0.99, Math.max(0.01, num(j.confidence, 0.5))),
    thesis: str(j.thesis, 500), wrong_if: str(j.wrong_if, 300), stop: nul(j.stop), target: nul(j.target), leverage: nul(j.leverage),
    tags: (Array.isArray(j.tags) ? (j.tags as unknown[]) : []).map((t) => str(t, 24)).slice(0, 5), checked: res.checked, error: res.error, cost_usd: res.cost, latency_ms: res.latency,
  };
  await saveOpinion(uid, null, model, "worker", "worker", res, res.json ? { ...ballot } : {}, researchId);
  return ballot;
}
type Verdict = { action: "take" | "pass"; reason: string; risk_pct: number; leverage: number; stop: number | null; target: number | null; model: string; error?: string; acting?: boolean };
async function frontierDecide(uid: string, key: string, team: TeamRow, model: string, acting: boolean, items: { decisionId: string; brief: J; ballots: Ballot[] }[], book: BookState, rules: Rules, s: LeagueSettings, deadline: number): Promise<Record<string, Verdict>> {
  const user = items.map((it, i) => {
    const b = it.brief.setup as J;
    const votes = it.ballots.map((v) => v.error ? `  ${v.model}: no answer` : `  ${v.model}: ${v.stance} at ${(v.confidence * 100).toFixed(0)}% — ${v.thesis}${v.wrong_if ? ` (wrong if: ${v.wrong_if})` : ""}${v.stop && v.stop !== num(b.stop) ? ` · stop ${v.stop}` : ""}${v.target && v.target !== num(b.target) ? ` · target ${v.target}` : ""}${v.checked.length ? ` · looked at ${v.checked.join(", ")}` : ""}`).join("\n");
    return `CANDIDATE ${i + 1} (id ${it.decisionId})\n${briefText(it.brief, book, rules)}\nTHE WORKERS' BALLOTS\n${votes}`;
  }).join("\n\n");
  const res = await callModel(key, { model, system: frontierSystem(team, book, s), user, schema: FRONTIER_SCHEMA, maxTokens: 2500, deadline, reasoning: acting ? workerReasoning(model) : "low" });
  const out: Record<string, Verdict> = {};
  const list = Array.isArray(res.json?.decisions) ? (res.json!.decisions as J[]) : [];
  for (const d of list) {
    const id = str(d.id, 64);
    const it = items.find((x) => x.decisionId === id) ?? items[Math.max(0, num(String(id).replace(/\D/g, ""), 1) - 1)];
    if (!it) continue;
    out[it.decisionId] = { action: d.action === "take" ? "take" : "pass", reason: str(d.reason, 500), risk_pct: Math.min(s.risk_max_pct, Math.max(0.5, num(d.risk_pct, 1))), leverage: Math.max(1, num(d.leverage, 1)), stop: nul(d.stop), target: nul(d.target), model, acting };
  }
  for (const it of items) if (!out[it.decisionId]) out[it.decisionId] = { action: "pass", reason: res.error ? `the frontier did not answer (${res.error})` : "the frontier gave no verdict on this one", risk_pct: 0, leverage: 1, stop: null, target: null, model, error: res.error || "no verdict", acting };
  await saveOpinion(uid, items[0]?.decisionId ?? null, model, acting ? "acting" : "frontier", "frontier", res, res.json ? { decisions: list.slice(0, 8), note: str(res.json?.note, 600) } : {});
  return out;
}
const ETF_THEME: Record<string, string> = { XLE: "Energy", USO: "Energy", OIH: "Energy", XOP: "Energy", TLT: "Rates", IEF: "Rates", GLD: "Metals", SLV: "Metals", GDX: "Metals", SPY: "Index", QQQ: "Index", IWM: "Index", DIA: "Index", XLF: "Financials", KRE: "Financials", SMH: "Semis", SOXX: "Semis", XLK: "Tech", XLV: "Health", XLU: "Utilities", XLP: "Staples", XLY: "Discretionary", UUP: "Dollar", IBIT: "crypto", FBTC: "crypto", BITO: "crypto", ETHA: "crypto" };
type Exec = { taken: boolean; trade_id?: string; reasons: string[]; ticket?: J; pass_reason?: string; by: "workers" | "frontier" | "budget" | "guardrail" | "price" };
/** The take: the price now, the guardrail, the trade row with its ticket. */
async function execute(uid: string, acct: J, team: TeamRow, decisionId: string, kind: "candidate" | "session", plan0: Plan, verdict: Verdict, ballots: Ballot[], book: BookState, rules: Rules, s: LeagueSettings, atr: number | null, quoteNow: number | null, champion: boolean, t0: number): Promise<Exec> {
  const dir = plan0.side === "long" ? 1 : -1;
  const entry0 = plan0.entry_ref, stop0 = plan0.stop, target0 = plan0.target;
  const entry = quoteNow ?? entry0;
  const progress = ((entry - entry0) * dir) / Math.max(1e-9, Math.abs(target0 - entry0));
  if ((stop0 - entry) * dir >= 0) return { taken: false, reasons: [`the price (${entry}) is already through the stop (${stop0})`], pass_reason: "the price is through the stop", by: "price" };
  if (kind === "candidate" && progress > 0.5) return { taken: false, reasons: [`the price has already made ${(progress * 100).toFixed(0)}% of the move to the target since the scan`], pass_reason: "most of the move is gone", by: "price" };
  // tighter only
  const stop = verdict.stop !== null && verdict.stop > 0 && (verdict.stop - entry) * dir < 0 && Math.abs(entry - verdict.stop) <= Math.abs(entry - stop0) ? verdict.stop : stop0;
  const target = verdict.target !== null && verdict.target > 0 && (verdict.target - entry) * dir > 0 && Math.abs(verdict.target - entry) <= Math.abs(target0 - entry) ? verdict.target : target0;
  const leverage = plan0.instrument === "crypto_perp" ? Math.max(1, Math.min(plan0.leverage > 0 ? plan0.leverage : 1, verdict.leverage)) : 1;
  const plan: Plan = { ...plan0, entry_ref: entry, stop, target, leverage, risk_pct: verdict.risk_pct, confidence: ballots.filter((b) => b.stance === "take").reduce((a, b) => a + b.confidence, 0) / Math.max(1, ballots.filter((b) => b.stance === "take").length) || 0.5 };
  let meta: InstrumentMeta = { max_leverage: plan.instrument === "crypto_perp" ? 20 : 1, contract_value: 1, lot_size: 1, tick_size: 0.01 };
  let name = plan.symbol, largeCap = true, sector = "";
  const v = await tape(uid, { mode: "validate", symbol: plan.symbol, venue: plan.venue }, 20000);
  if (v.ok === true) { meta = v.meta as InstrumentMeta; name = str(v.name, 80); largeCap = v.largeCap === true; sector = str(v.sector, 40); }
  const themeOf = (sym: string) => ETF_THEME[sym] ? ETF_THEME[sym] : /-USDT?$/.test(sym) ? "crypto" : sector || "other";
  const live = book.openTrades;
  const ctx: GuardCtx = { equity: book.equity, rules: { ...rules, risk_pct: s.risk_max_pct }, open: live, atr, meta, halted: false, themeOf, drawdownHalved: false, newTonight: 0 };
  const g = guardrail(plan, ctx);
  const checks = [
    { name: "stop on the right side", pass: (plan.stop - plan.entry_ref) * dir < 0, detail: `stop ${plan.stop} against entry ${plan.entry_ref}` },
    { name: "reward to risk", pass: Math.abs(plan.target - plan.entry_ref) / Math.max(1e-9, Math.abs(plan.entry_ref - plan.stop)) >= rules.min_rr, detail: `${(Math.abs(plan.target - plan.entry_ref) / Math.max(1e-9, Math.abs(plan.entry_ref - plan.stop))).toFixed(2)} against a floor of ${rules.min_rr}` },
    { name: "stop wide enough", pass: !(atr && Math.abs(plan.entry_ref - plan.stop) < rules.min_stop_atr * atr), detail: atr ? `${(Math.abs(plan.entry_ref - plan.stop) / atr).toFixed(2)} ATR; the floor is ${rules.min_stop_atr}` : "no ATR on file" },
    { name: "one position per symbol", pass: !live.some((o) => o.symbol === plan.symbol), detail: live.some((o) => o.symbol === plan.symbol) ? `${plan.symbol} is already on the book` : "not held" },
    { name: "room on the book", pass: live.length < rules.max_open, detail: `${live.length} open of ${rules.max_open}` },
    { name: "stop inside the liquidation price", pass: g.ok || !/liquidation/.test(g.reasons.join(" ")), detail: g.reasons.find((r) => /leverage cut/.test(r)) ?? (plan.instrument === "crypto_perp" ? "holds at the leverage chosen" : "not a perp") },
    { name: "size above zero", pass: g.ok, detail: g.ok ? `${g.sizing!.qty} ${g.sizing!.unit}` : g.reasons.join("; ") },
  ];
  if (!g.ok || !g.sizing) return { taken: false, reasons: [`guardrail: ${g.reasons.join("; ")}`], pass_reason: g.reasons.join("; "), by: "guardrail", ticket: { checks } };
  const uv = g.sizing.unit === "contract" ? meta.contract_value : 1;
  const notional = g.sizing.qty * uv * g.plan.entry_ref;
  const margin = g.plan.instrument === "crypto_perp" ? notional / g.sizing.leverage : notional;
  const liq = g.plan.instrument === "crypto_perp" ? liqPrice(g.plan.entry_ref, g.plan.side, g.sizing.leverage) : null;
  const fundingRate = book.funding?.[plan.symbol] ?? null;
  const holdHours = plan.horizon_hours ?? plan.horizon_days * 24;
  const fees = entryFees({ instrument: g.plan.instrument, side: g.plan.side, qty: g.sizing.qty, notional }) * 2;
  const heat = (ts: Trade[]) => ts.reduce((a, o) => a + Math.abs((o.entry_price ?? o.entry_ref) - o.stop) * o.qty * (o.unit === "contract" ? o.contract_value : 1), 0);
  const gross = (ts: Trade[]) => ts.reduce((a, o) => a + o.notional, 0);
  const takers = ballots.filter((b) => b.stance === "take" && !b.error), answered = ballots.filter((b) => !b.error);
  const ticket: J = {
    at: iso(t0), team: team.name, kind, symbol: plan.symbol, venue: plan.venue, instrument: plan.instrument, side: plan.side, strategy: plan.strategy ?? "", timeframe: plan.timeframe ?? "swing",
    equity: round(book.equity), death_line: round(book.death_line), distance_to_death_pct: round(book.distance_pct),
    risk_pct: round(g.plan.risk_pct), risk_usd: round(g.sizing.risk_usd), entry_ref: g.plan.entry_ref, stop: g.plan.stop, target: g.plan.target,
    stop_dist_pct: round(Math.abs(g.plan.entry_ref - g.plan.stop) / g.plan.entry_ref * 100), stop_dist_atr: atr ? round(Math.abs(g.plan.entry_ref - g.plan.stop) / atr) : null,
    target_dist_pct: round(Math.abs(g.plan.target - g.plan.entry_ref) / g.plan.entry_ref * 100), rr: round(Math.abs(g.plan.target - g.plan.entry_ref) / Math.abs(g.plan.entry_ref - g.plan.stop)),
    qty: g.sizing.qty, unit: g.sizing.unit, contract_value: uv, notional: round(notional), leverage: g.sizing.leverage, margin: round(margin), liq_price: liq === null ? null : round(liq, 6),
    liq_buffer_pct: liq === null ? null : round((Math.abs(g.plan.entry_ref - liq) / Math.abs(g.plan.entry_ref - g.plan.stop) - 1) * 100),
    fees_est: round(fees), funding_rate: fundingRate, funding_est: fundingRate === null ? null : round(notional * fundingRate * (holdHours / 8) * (plan.side === "long" ? 1 : -1)), slippage_bps: slippageBps(g.plan.instrument, g.plan.symbol, largeCap, 0),
    horizon: plan.horizon_hours ? `${plan.horizon_hours} hours` : `${plan.horizon_days} days`, expires: plan.horizon_hours ? iso(t0 + plan.horizon_hours * 3_600_000) : addDays(etDate(t0), plan.horizon_days),
    checks, exposure_before: { positions: live.length, gross: round(gross(live)), heat: round(heat(live)) },
    exposure_after: { positions: live.length + 1, gross: round(gross(live) + notional), heat: round(heat(live) + g.sizing.risk_usd) },
    workers: { take: takers.length, pass: answered.length - takers.length, answered: answered.length, score: round(answered.reduce((a, b) => a + (b.stance === "take" ? 1 : -1) * b.confidence, 0)) },
    frontier: { model: verdict.model, risk_pct_asked: verdict.risk_pct, leverage_asked: verdict.leverage, reason: verdict.reason, acting: verdict.acting === true },
    price_check: { ref: entry0, now: entry, progress_pct: round(progress * 100) }, mirrored_to_desk: false,
  };
  const row: J = {
    user_id: uid, owner: `team:${team.id}`, session_id: null, sit_id: null, proposal_id: decisionId, source: "league", strategy: plan.strategy ?? "", timeframe: plan.timeframe ?? "swing", horizon_hours: plan.horizon_hours ?? null, size_mult: 1,
    venue: g.plan.venue, instrument: g.plan.instrument, symbol: g.plan.symbol, name, side: g.plan.side, status: "pending", template: 0, thesis: plan.thesis, catalyst: plan.catalyst, falsifier: plan.falsifier, confidence: plan.confidence, evidence: [],
    regime: str((book as unknown as J).regime, 60), decided_at: iso(t0), entry_ref: g.plan.entry_ref, stop: g.plan.stop, target: g.plan.target, horizon_days: g.plan.horizon_days, risk_pct: g.plan.risk_pct,
    leverage: g.sizing.leverage, qty: g.sizing.qty, unit: g.sizing.unit, contract_value: uv, notional, margin, liq_price: liq, fill_rule: g.plan.instrument === "stock" || g.plan.instrument === "etf" ? "next_5m" : "next_5m", slippage_bps: slippageBps(g.plan.instrument, g.plan.symbol, largeCap, 0), ticket,
  };
  const ins = rows(await rest("desk_trades", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) }))[0];
  if (!ins) return { taken: false, reasons: ["the order could not be written"], pass_reason: "the order could not be written", by: "guardrail", ticket };
  book.openTrades.push(toTrade(ins));
  const reasons = [...g.reasons];
  if (champion) {
    const m = await mirrorToDesk(uid, acct, team, decisionId, g.plan, meta, largeCap, atr, t0);
    reasons.push(m);
    ticket.mirrored_to_desk = /mirrored/.test(m);
    await rest(`desk_trades?id=eq.${ins.id}`, { method: "PATCH", body: JSON.stringify({ ticket }) });
  }
  return { taken: true, trade_id: String(ins.id), reasons, ticket, by: "frontier" };
}
/** The champion's take, copied to Ben's desk at the desk's size under the desk's rules. */
async function mirrorToDesk(uid: string, acct: J, team: TeamRow, decisionId: string, plan: Plan, meta: InstrumentMeta, largeCap: boolean, atr: number | null, t0: number): Promise<string> {
  const rules = rulesFor((acct.preset as Rules extends never ? never : "no_limits") ?? "aggressive", (acct.rules as Partial<Rules>) ?? {});
  const open = rows(await rest(`desk_trades?user_id=eq.${uid}&owner=eq.desk&status=in.(pending,open)&select=${TRADE_COLS}`)).map(toTrade);
  const g = guardrail({ ...plan }, { equity: num(acct.equity, START), rules, open, atr, meta, halted: !!acct.halted_until && String(acct.halted_until) >= etDate(t0), themeOf: (sym) => (/-USDT?$/.test(sym) ? "crypto" : "other"), drawdownHalved: false, newTonight: 0 });
  if (!g.ok || !g.sizing) return `not mirrored to the desk: ${g.reasons.join("; ")}`;
  const uv = g.sizing.unit === "contract" ? meta.contract_value : 1;
  const notional = g.sizing.qty * uv * g.plan.entry_ref;
  const row: J = {
    user_id: uid, owner: "desk", session_id: null, sit_id: null, proposal_id: decisionId, source: "league", strategy: plan.strategy ?? "", timeframe: plan.timeframe ?? "swing", horizon_hours: plan.horizon_hours ?? null, size_mult: 1,
    venue: g.plan.venue, instrument: g.plan.instrument, symbol: g.plan.symbol, name: plan.symbol, side: g.plan.side, status: "pending", template: 0, thesis: `Mirrored from ${team.name}, the champion. ${plan.thesis}`.slice(0, 700), catalyst: plan.catalyst, falsifier: plan.falsifier, confidence: plan.confidence, evidence: [],
    regime: "", decided_at: iso(t0), entry_ref: g.plan.entry_ref, stop: g.plan.stop, target: g.plan.target, horizon_days: g.plan.horizon_days, risk_pct: g.plan.risk_pct,
    leverage: g.sizing.leverage, qty: g.sizing.qty, unit: g.sizing.unit, contract_value: uv, notional, margin: g.plan.instrument === "crypto_perp" ? notional / g.sizing.leverage : notional,
    liq_price: g.plan.instrument === "crypto_perp" ? liqPrice(g.plan.entry_ref, g.plan.side, g.sizing.leverage) : null, fill_rule: "next_5m", slippage_bps: slippageBps(g.plan.instrument, g.plan.symbol, largeCap, 0),
  };
  const ins = await rest("desk_trades", { method: "POST", body: JSON.stringify(row) });
  return ins.ok ? "mirrored to the desk" : "not mirrored to the desk: the order could not be written";
}
function planFromSetup(setup: J, brief: J): Plan {
  const def = STRATEGIES.find((x) => x.id === setup.strategy);
  const best = "";
  return {
    venue: String(setup.venue) as Venue, instrument: String(setup.instrument) as Instrument, symbol: String(setup.symbol), side: String(setup.side) === "short" ? "short" : "long", leverage: num(setup.leverage_hint, 1), template: 0,
    thesis: best || str(setup.invalidation, 300), catalyst: def?.what ?? "", falsifier: str(setup.invalidation, 400), confidence: 0.5, entry_ref: num(setup.entry_ref), stop: num(setup.stop), target: num(setup.target),
    horizon_days: num(setup.horizon_days) || Math.max(1, Math.ceil(num(setup.horizon_hours, 24) / 24)), risk_pct: 1, evidence: [], key_risks: [], crosses_event: false,
    timeframe: String(setup.timeframe) as Plan["timeframe"], horizon_hours: setup.horizon_hours === null || setup.horizon_hours === undefined ? undefined : num(setup.horizon_hours), strategy: String(setup.strategy),
  } as Plan & { regime?: string } & { brief?: J } as Plan;
}

/* ── the tick: marks, deaths, dispatch ────────────────────────────────── */
/** One quote per open symbol across every team, so nine books mark off one tape call. */
async function marksForAll(uid: string): Promise<Record<string, number>> {
  const open = rows(await rest(`desk_trades?user_id=eq.${uid}&owner=like.team:*&status=eq.open&select=symbol,venue&limit=2000`)).map((t) => ({ symbol: String(t.symbol), venue: String(t.venue) }));
  return open.length ? quotesFor(uid, open) : {};
}

/* ── the tick's cycle: marks, deaths, new candidates inside the hours, one child per batch ── */
async function cycle(uid: string, body: J): Promise<J> {
  const t0 = Date.now();
  const acct = await loadAccount(uid);
  if (!acct) return { error: "no account" };
  const s = leagueSettings(acct.league as Partial<LeagueSettings>);
  const all = await loadTeams(uid);
  const live = () => all.filter((t) => t.status === "live");
  if (!live().length) return { note: "no live teams; form them first", ms: Date.now() - t0 };
  const today = etDate(t0);
  const now = etParts(t0);
  const season = await currentSeason(uid, s, today);
  const marks = await markTeams(uid, s, all, num(season.n, 1));
  const out: J = { marked: marks.marked, died: marks.died, relaunched: 0, failed: 0, queued: 0, launched: 0, skipped: [] as string[] };
  // a stale batch: launched more than four minutes ago and still not done → one relaunch, then failed
  const stale = rows(await rest(`desk_research?user_id=eq.${uid}&status=eq.launched&updated_at=lt.${iso(t0 - 240_000)}&select=id,launched&limit=50`));
  const relaunch: string[] = [];
  for (const r of stale) {
    const l = (r.launched as J) ?? {};
    if (num(l.n) < 2) { relaunch.push(String(r.id)); await rest(`desk_research?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify({ launched: { at: t0, n: num(l.n) + 1 }, updated_at: iso(t0) }) }); (out.relaunched as number)++; }
    else {
      await rest(`desk_research?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify({ status: "failed", updated_at: iso(t0) }) });
      await rest(`desk_decisions?research_id=eq.${r.id}&status=in.(queued,launched)`, { method: "PATCH", body: JSON.stringify({ status: "failed", outcome: { taken: false, reasons: ["the crew did not answer in time (two tries)"], pass_reason: "no answer in time", by: "failed" }, updated_at: iso(t0) }) });
      (out.failed as number)++;
    }
  }
  if (relaunch.length) launch({ mode: "decide", userId: uid, research_ids: relaunch });
  // new candidates: every fresh setup whose venue is open goes to the crew once and to every live team
  const fresh = rows(await rest(`desk_setups?user_id=eq.${uid}&status=eq.new&expires_at=gte.${iso(t0)}&select=*&order=score.desc,created_at.desc&limit=30`)).filter((su) => inHours(String(su.venue), now.hour, now.minute, s)).slice(0, 10);
  if (fresh.length) {
    const news = rows(await rest(`desk_news?tagged=eq.true&published=gte.${iso(t0 - 24 * 3_600_000)}&select=title,tickers,impact,direction,category,why,published,venue&order=impact.desc,published.desc&limit=300`));
    for (const su of fresh) {
      const brief = await candidateBrief(uid, su, news);
      const rs = rows(await rest("desk_research", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ user_id: uid, setup_id: su.id, symbol: su.symbol, strategy: su.strategy, timeframe: su.timeframe, status: "queued", brief }) }))[0];
      if (!rs) continue;
      const batch = live().map((t) => ({ user_id: uid, team_id: t.id, kind: "candidate", setup_id: su.id, research_id: rs.id, symbol: su.symbol, strategy: su.strategy, timeframe: su.timeframe, status: "queued", brief, ballots: [], launched: {} }));
      const ins = await rest("desk_decisions", { method: "POST", body: JSON.stringify(batch) });
      if (ins.ok) { (out.queued as number) += batch.length; await rest(`desk_setups?id=eq.${su.id}`, { method: "PATCH", body: JSON.stringify({ status: "league" }) }); }
    }
  }
  // dispatch: up to eight queued setups per tick, one child for the whole batch (the crew once, every frontier at once)
  const spent = await spentToday(uid, today);
  out.spent_today = round(spent, 3);
  const queued = rows(await rest(`desk_research?user_id=eq.${uid}&status=eq.queued&select=id&order=created_at.asc&limit=8`)).map((r) => String(r.id));
  if (queued.length) {
    const list = queued.join(",");
    if (spent >= s.budget_usd_day) {
      await rest(`desk_research?id=in.(${list})`, { method: "PATCH", body: JSON.stringify({ status: "done", updated_at: iso(t0) }) });
      await rest(`desk_decisions?research_id=in.(${list})&status=eq.queued`, { method: "PATCH", body: JSON.stringify({ status: "done", outcome: { taken: false, reasons: [`today's league budget ($${s.budget_usd_day}) is spent`], pass_reason: "budget spent", by: "budget" }, updated_at: iso(t0) }) });
      (out.skipped as string[]).push(`${queued.length} candidates: budget spent`);
    } else {
      await rest(`desk_research?id=in.(${list})`, { method: "PATCH", body: JSON.stringify({ status: "launched", launched: { at: t0, n: 1 }, updated_at: iso(t0) }) });
      await rest(`desk_decisions?research_id=in.(${list})&status=eq.queued`, { method: "PATCH", body: JSON.stringify({ status: "launched", launched: { at: t0, n: 1 }, updated_at: iso(t0) }) });
      launch({ mode: "decide", userId: uid, research_ids: queued });
      out.launched = queued.length;
    }
  }
  if (body.dispatch_only !== true) {
    const due = sessionDue(now.hour, now.minute, s.session_times);
    if (due && (inHours("robinhood", now.hour, now.minute, s) || inHours("blofin", now.hour, now.minute, s))) launch({ mode: "session", userId: uid, time: due });
    if (now.hour * 60 + now.minute >= 16 * 60 + 6) launch({ mode: "rank", userId: uid });
  }
  out.ms = Date.now() - t0;
  return out;
}

/* ── child: one batch of setups; the crew once, then every frontier at once ── */
async function decide(uid: string, body: J): Promise<J> {
  const t0 = Date.now(), deadline = t0 + 125_000; // the gateway cuts at 150s: the crew gets 50s, a frontier 40s, a stand-in 25s, execution the rest
  const ids = (Array.isArray(body.research_ids) ? (body.research_ids as unknown[]) : []).map((x) => str(x, 64)).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 8);
  if (!ids.length) return { ok: true, note: "nothing to decide" };
  const acct = await loadAccount(uid);
  if (!acct) return { error: "no account" };
  const s = leagueSettings(acct.league as Partial<LeagueSettings>);
  const key = (await secret("anthropic_api_key")) || ENV_KEY;
  if (!key) return { error: "no key" };
  const list = ids.join(",");
  const research = rows(await rest(`desk_research?user_id=eq.${uid}&id=in.(${list})&status=eq.launched&select=*`));
  if (!research.length) return { ok: true, note: "nothing launched" };
  const rules = rulesFor(String(acct.preset ?? "aggressive") as "no_limits", (acct.rules as Partial<Rules>) ?? {});
  const teams = (await loadTeams(uid)).filter((t) => t.status === "live");
  const decisions = rows(await rest(`desk_decisions?user_id=eq.${uid}&research_id=in.(${list})&status=in.(queued,launched)&select=*`));
  const patchResearch = (id: string, patch: J) => rest(`desk_research?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
  const finish = (id: string, patch: J) => rest(`desk_decisions?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
  // the crew, once per setup, all at once; a ballot already paid for on an earlier try is reused, not re-asked
  const wants = research.map((r) => { const st = ((r.brief as J).setup as J) ?? {}; return { symbol: String(st.symbol), venue: String(st.venue), instrument: String(st.instrument), timeframe: String(st.timeframe) }; });
  const [cache, fundR, feed] = await Promise.all([
    s.research === "light" && s.worker_lookups > 0 ? prefetchBars(uid, wants) : Promise.resolve({} as BarCache),
    wants.some((w) => w.instrument === "crypto_perp") ? tape(uid, { mode: "funding", symbols: [...new Set(wants.filter((w) => w.instrument === "crypto_perp").map((w) => w.symbol))] }, 20000) : Promise.resolve({} as J),
    Promise.resolve(rows(await rest(`desk_news?tagged=eq.true&published=gte.${iso(t0 - 48 * 3_600_000)}&select=title,tickers,impact,direction,category,why,published,venue&order=published.desc&limit=400`))),
  ]);
  const funding = ((fundR.rates as Record<string, number>) ?? {});
  const prior = rows(await rest(`desk_opinions?research_id=in.(${list})&round=eq.worker&error=eq.&select=research_id,model,content`));
  type Job = { r: J; ballots: Ballot[] };
  const jobs: Job[] = research.map((r) => ({ r, ballots: [] }));
  await Promise.all(jobs.flatMap((job) => {
    const brief = job.r.brief as J, setup = brief.setup as J;
    const tools = toolsFor(uid, setup, cache, feed, funding, String(brief.record ?? ""), null);
    return s.worker_pool.map(async (model) => {
      const had = prior.find((o) => String(o.research_id) === String(job.r.id) && o.model === model && (o.content as J)?.stance);
      const b = had ? ({ ...(had.content as J), model, role: "worker", error: "", cost_usd: 0 } as Ballot) : await crewBallot(uid, key, model, String(job.r.id), brief, rules, s, tools, t0 + 50_000);
      job.ballots.push(b);
    });
  }));
  // the ballots go on the record, on the research row and on every team's decision, before a frontier is asked
  const crewCost = (job: Job) => job.ballots.reduce((a, b) => a + b.cost_usd, 0);
  await Promise.all(jobs.flatMap((job) => [
    patchResearch(String(job.r.id), { ballots: job.ballots, cost_usd: round(crewCost(job), 5) }),
    rest(`desk_decisions?research_id=eq.${job.r.id}&status=in.(queued,launched)`, { method: "PATCH", body: JSON.stringify({ ballots: job.ballots, updated_at: new Date().toISOString() }) }),
  ]));
  // a candidate reaches the frontiers when someone on the crew liked it, or when the scan's own confluence is strong
  const liked = (job: Job) => job.ballots.some((b) => b.stance === "take" && !b.error) || num(((job.r.brief as J).setup as J)?.score) >= 0.6;
  const symbolOf = (job: Job) => String(((job.r.brief as J).setup as J)?.symbol ?? "");
  const champion = await championId(uid);
  const marks = await marksForAll(uid);
  // every frontier at once, each over the liked candidates it does not already hold
  const rounds = await Promise.all(teams.map(async (team) => {
    const mine = decisions.filter((d) => String(d.team_id) === team.id);
    if (!mine.length) return null;
    const book = await bookState(uid, team, s, marks);
    (book as unknown as J).funding = funding;
    const openSyms = new Set(book.openTrades.map((t) => t.symbol));
    const decisionOf = (job: Job) => mine.find((d) => String(d.research_id) === String(job.r.id));
    const items = jobs.filter((job) => liked(job) && !openSyms.has(symbolOf(job)) && decisionOf(job)).map((job) => ({ decisionId: String(decisionOf(job)!.id), brief: job.r.brief as J, ballots: job.ballots }));
    const verdicts: Record<string, Verdict> = {};
    if (items.length && deadline - Date.now() > 30_000) {
      Object.assign(verdicts, await frontierDecide(uid, key, team, team.frontier, false, items, book, rules, s, Math.min(deadline - 35_000, Date.now() + 40_000)));
      const silent = items.filter((it) => verdicts[it.decisionId]?.error);
      if (silent.length && deadline - Date.now() > 15_000) {
        // the stand-in: the crew member that answered this batch fastest, reasoning off so it fits the time left
        const lat: Record<string, number[]> = {};
        for (const j of jobs) for (const b of j.ballots) if (!b.error) (lat[b.model] ??= []).push(b.latency_ms);
        const mean = (m: string) => lat[m].reduce((a, v) => a + v, 0) / lat[m].length;
        const standIn = s.worker_pool.filter((m) => lat[m]?.length).sort((a, b) => mean(a) - mean(b))[0];
        if (standIn) {
          const acting = await frontierDecide(uid, key, team, standIn, true, silent, book, rules, s, Math.min(deadline - 10_000, Date.now() + 25_000));
          for (const [id, v] of Object.entries(acting)) if (!v.error) verdicts[id] = v;
        }
      }
    }
    return { team, book, mine, verdicts, openSyms };
  }));
  // one quote per symbol any frontier wants, then every team executes its takes
  const wanted = new Set<string>();
  for (const rd of rounds) if (rd) for (const d of rd.mine) { const v = rd.verdicts[String(d.id)]; if (v && v.action === "take") wanted.add(String(d.symbol)); }
  const quotes = wanted.size ? await quotesFor(uid, jobs.filter((job) => wanted.has(symbolOf(job))).map((job) => ({ symbol: symbolOf(job), venue: String(((job.r.brief as J).setup as J).venue) }))) : {};
  const out: J = { teams: [] as J[], ms: 0 };
  await Promise.all(rounds.map(async (rd) => {
    if (!rd) return;
    const { team, book, mine, verdicts, openSyms } = rd;
    const stats = { decisions: 0, takes: 0, passes: 0 };
    for (const d of mine) {
      const job = jobs.find((j) => String(j.r.id) === String(d.research_id));
      if (!job) continue;
      const brief = job.r.brief as J, setup = brief.setup as J, symbol = symbolOf(job);
      const ballots: J[] = job.ballots.map((b) => ({ ...b }));
      const verdict: Verdict | null = verdicts[String(d.id)] ?? null;
      let outcome: Exec;
      if (!verdict && openSyms.has(symbol)) outcome = { taken: false, reasons: [`${symbol} is already on the team's book`], pass_reason: "already held", by: "guardrail" };
      else if (!liked(job)) outcome = { taken: false, reasons: [job.ballots.every((b) => b.error) ? "no one on the crew answered" : `${job.ballots.filter((b) => b.stance === "pass" && !b.error).length} of ${job.ballots.filter((b) => !b.error).length} on the crew said pass and the confluence was weak; the frontier was not asked`], pass_reason: job.ballots.every((b) => b.error) ? "no worker answered" : "every worker passed", by: "workers" };
      else if (!verdict) outcome = { taken: false, reasons: ["the frontier could not be consulted in time"], pass_reason: "no time for the frontier", by: "frontier" };
      else if (verdict.action !== "take") outcome = { taken: false, reasons: [verdict.reason], pass_reason: verdict.reason, by: "frontier" };
      else {
        const plan = planFromSetup(setup, brief);
        const best = [...job.ballots].filter((b) => b.stance === "take" && !b.error).sort((a, b) => b.confidence - a.confidence)[0];
        plan.thesis = str(best?.thesis, 700) || plan.thesis; plan.falsifier = str(best?.wrong_if, 400) || plan.falsifier;
        (book as unknown as J).regime = brief.regime;
        outcome = await execute(uid, acct, team, String(d.id), "candidate", plan, verdict, job.ballots, book, rules, s, num((setup.card as J)?.atr) || null, quotes[symbol] ?? null, champion === team.id, Date.now());
        if (outcome.taken) openSyms.add(symbol);
      }
      if (verdict) ballots.push({ model: verdict.model, role: "frontier", stance: verdict.action, confidence: verdict.action === "take" ? 0.6 : 0.4, thesis: verdict.reason, wrong_if: "", stop: verdict.stop, target: verdict.target, leverage: verdict.leverage, tags: [], checked: [], error: verdict.error ?? "", cost_usd: 0, latency_ms: 0 });
      await finish(String(d.id), { status: "done", ballots, verdict: verdict ? { ...verdict } : null, outcome, cost_usd: round(crewCost(job) / Math.max(1, teams.length), 5) });
      stats.decisions++; if (outcome.taken) stats.takes++; else stats.passes++;
    }
    await bumpStats(team.id, stats);
    (out.teams as J[]).push({ team: team.name, decided: stats.decisions, taken: stats.takes });
  }));
  // decisions of teams that died on the way, and the research rows
  const liveIds = new Set(teams.map((t) => t.id));
  for (const d of decisions) if (!liveIds.has(String(d.team_id))) await finish(String(d.id), { status: "done", outcome: { taken: false, reasons: ["the team is dead"], pass_reason: "the team died", by: "guardrail" } });
  await Promise.all(jobs.map((job) => patchResearch(String(job.r.id), { status: "done" })));
  out.ms = Date.now() - t0;
  return out;
}

/* ── sessions: the crew proposes once, every frontier reviews its own book ── */
async function session(uid: string, body: J): Promise<J> {
  const t0 = Date.now();
  const acct = await loadAccount(uid);
  if (!acct) return { error: "no account" };
  const s = leagueSettings(acct.league as Partial<LeagueSettings>);
  const today = etDate(t0);
  const time = body.force === true ? `manual ${iso(t0).slice(11, 16)}` : str(body.time, 8) || sessionDue(etParts(t0).hour, etParts(t0).minute, s.session_times) || "";
  if (!time) return { note: "no session due" };
  const keyOf = `${today} ${time}`;
  const held = rows(await rest(`desk_decisions?user_id=eq.${uid}&kind=eq.session&created_at=gte.${today}T04:00:00Z&select=brief&limit=300`)).some((d) => ((d.brief as J)?.session_key) === keyOf);
  if (held) return { session: keyOf, note: "already held" };
  launch({ mode: "session_all", userId: uid, session_key: keyOf });
  return { session: keyOf, launched: 1, ms: Date.now() - t0 };
}
async function sessionAll(uid: string, body: J): Promise<J> {
  const t0 = Date.now(), deadline = t0 + 125_000;
  const acct = await loadAccount(uid);
  if (!acct) return { error: "no account" };
  const s = leagueSettings(acct.league as Partial<LeagueSettings>);
  const key = (await secret("anthropic_api_key")) || ENV_KEY;
  if (!key) return { error: "no key" };
  const sessionKey = str(body.session_key, 40) || `${etDate(t0)} manual`;
  const today = etDate(t0);
  const teams = (await loadTeams(uid)).filter((t) => t.status === "live");
  if (!teams.length) return { note: "no live teams" };
  if (await spentToday(uid, today) >= s.budget_usd_day) {
    await rest("desk_decisions", { method: "POST", body: JSON.stringify(teams.map((team) => ({ user_id: uid, team_id: team.id, kind: "session", symbol: "", status: "done", brief: { session_key: sessionKey, note: "no session: today's league budget is spent" }, ballots: [], outcome: { taken: false, reasons: ["budget spent"], pass_reason: "budget spent", by: "budget" } }))) });
    return { note: "budget" };
  }
  const rules = rulesFor(String(acct.preset ?? "aggressive") as "no_limits", (acct.rules as Partial<Rules>) ?? {});
  const [newsR, ctx, movers] = await Promise.all([
    rest(`desk_news?tagged=eq.true&impact=gte.3&published=gte.${iso(t0 - 9 * 3_600_000)}&select=title,tickers,impact,direction,category,why,published,venue&order=impact.desc,published.desc&limit=30`),
    tape(uid, { mode: "context" }, 40000), tape(uid, { mode: "movers" }, 30000),
  ]);
  const news = rows(newsR);
  const digest = news.map((n, i) => `[${i}] ${str(n.title, 120)} (${n.venue}, impact ${n.impact}, ${n.direction}, ${n.category}${n.why ? `: ${str(n.why, 140)}` : ""}${Array.isArray(n.tickers) && (n.tickers as string[]).length ? ` · ${(n.tickers as string[]).slice(0, 4).join(" ")}` : ""})`);
  const context = `REGIME: ${str(ctx.regime, 60)}\n${((ctx.cards as J[]) ?? []).map((c) => `${c.symbol} $${num(c.price).toFixed(2)} 1d ${(num(c.ret1d) * 100).toFixed(1)}% 5d ${(num(c.ret5d) * 100).toFixed(1)}% trend ${c.trend} rsi ${num(c.rsi14).toFixed(0)}`).join("\n")}\nPERPS TOP VOLUME: ${((movers.volume as J[]) ?? []).slice(0, 12).map((m) => `${m.inst_id} $${num(m.last)} 24h ${(num(m.change24h) * 100).toFixed(1)}%`).join(" · ")}`;
  const setups = rows(await rest(`desk_setups?user_id=eq.${uid}&expires_at=gte.${iso(t0)}&created_at=gte.${iso(t0 - 24 * 3_600_000)}&select=strategy,symbol,side,timeframe,entry_ref,stop,target,score&order=score.desc&limit=12`)).map((x) => `${x.symbol} ${x.side} · ${x.strategy} (${x.timeframe}) ref ${num(x.entry_ref)} stop ${num(x.stop)} target ${num(x.target)} · confluence ${(num(x.score) * 100).toFixed(0)}%`);
  const user = `NEWS SINCE THE LAST SESSION (cite by [index])\n${digest.join("\n") || "(quiet)"}\n\nTAPE\n${context}\n\nSETUPS THE SCAN HAS ON THE TABLE (candidates already go to the teams; propose something else, or one of these at a better level)\n${setups.join("\n") || "(none)"}`;
  // the crew proposes once, all at once
  const ideas = await Promise.all(s.worker_pool.map(async (model) => {
    const res = await callModel(key, { model, system: PROPOSE_SYSTEM(s), user, schema: PROPOSE_SCHEMA, maxTokens: 2500, deadline: Math.min(deadline - 65_000, t0 + 45_000), reasoning: workerReasoning(model) });
    const j = res.json ?? {};
    const symbol = str(j.symbol, 20).toUpperCase().replace(/\s+/g, "");
    const venue = j.venue === "blofin" ? "blofin" : "robinhood";
    const sym = venue === "blofin" ? (symbol.includes("-") ? symbol.replace(/-(USD|USDC|PERP)$/, "-USDT") : `${symbol}-USDT`) : symbol;
    const idea = j.has_idea === true && sym ? { model, symbol: sym, venue, side: j.side === "short" ? "short" : "long", thesis: str(j.thesis, 600), catalyst: str(j.catalyst, 300), wrong_if: str(j.wrong_if, 300), stop: num(j.stop), target: num(j.target), horizon_days: Math.max(1, Math.min(60, Math.floor(num(j.horizon_days, 5)))), leverage: Math.max(1, num(j.leverage, 1)), confidence: Math.min(0.99, Math.max(0.01, num(j.confidence, 0.5))), evidence: (Array.isArray(j.evidence) ? (j.evidence as unknown[]) : []).map((e) => str(e, 160)).slice(0, 4), reason: "" } : null;
    await saveOpinion(uid, null, model, "worker", "propose", res, res.json ? { has_idea: j.has_idea === true, symbol: sym, reason: str(j.reason, 300) } : {});
    return { model, idea, reason: str(j.reason, 300), error: res.error, cost: res.cost };
  }));
  // validate the proposals' symbols and read a price
  const proposals: (NonNullable<(typeof ideas)[number]["idea"]> & { entry_ref: number; instrument: Instrument; meta: InstrumentMeta; largeCap: boolean; atr: number | null })[] = [];
  for (const it of ideas) {
    if (!it.idea) continue;
    const v = await tape(uid, { mode: "validate", symbol: it.idea.symbol, venue: it.idea.venue }, 20000);
    if (v.ok !== true) { it.reason = `${it.idea.symbol}: ${str(v.error, 120) || "did not validate"}`; it.idea = null; continue; }
    const snap = await tape(uid, { mode: "snapshot", symbols: [{ symbol: it.idea.symbol, venue: String(v.venue) }] }, 30000);
    const card = ((snap.cards as Record<string, J>) ?? {})[it.idea.symbol];
    const price = card && "price" in card ? num(card.price) : 0;
    if (!(price > 0)) { it.reason = `${it.idea.symbol}: no price on the tape`; it.idea = null; continue; }
    const dir = it.idea.side === "long" ? 1 : -1;
    if (!((it.idea.stop - price) * dir < 0 && (it.idea.target - price) * dir > 0)) { it.reason = `${it.idea.symbol}: stop or target on the wrong side of the price ${price}`; it.idea = null; continue; }
    if (proposals.some((p) => p.symbol === it.idea!.symbol)) { it.reason = `${it.idea.symbol}: another crew member already proposed it`; it.idea = null; continue; }
    proposals.push({ ...it.idea, venue: String(v.venue) as Venue, entry_ref: price, instrument: String(v.instrument) as Instrument, meta: v.meta as InstrumentMeta, largeCap: v.largeCap === true, atr: card ? nul(card.atr14) : null });
  }
  const workerCost = ideas.reduce((a, x) => a + x.cost, 0);
  const propText = proposals.map((p, i) => `PROPOSAL ${i} (from ${p.model}): ${p.symbol} ${p.side}${p.instrument === "crypto_perp" ? ` ${p.leverage}x` : ""} (${p.venue}) price ${p.entry_ref} stop ${p.stop} target ${p.target} · ${p.horizon_days}d · conf ${(p.confidence * 100).toFixed(0)}%\n    thesis: ${p.thesis}\n    catalyst: ${p.catalyst}\n    wrong if: ${p.wrong_if}\n    evidence: ${p.evidence.join(" | ")}`);
  const noIdea = `(no one on the crew had one${ideas.some((x) => x.reason) ? ": " + ideas.map((x) => `${x.model}: ${x.reason || x.error || "no idea"}`).join("; ") : ""})`;
  const champion = await championId(uid);
  const marks = await marksForAll(uid);
  // every frontier at once: its own book and positions, the same proposals
  const results = await Promise.all(teams.map(async (team) => {
    const book = await bookState(uid, team, s, marks);
    const openSyms = new Set(book.openTrades.map((t) => t.symbol));
    const positions = book.openTrades.filter((t) => t.status === "open").map((t) => { const m = marks[t.symbol] ?? t.entry_price ?? t.entry_ref; const u = unrealized(t, m); return `trade ${t.id}: ${t.symbol} ${t.side}${t.instrument === "crypto_perp" ? ` ${t.leverage}x` : ""} in at ${t.entry_price} now ${m} (${u >= 0 ? "+" : ""}$${u.toFixed(0)}, ${((u / Math.max(1, t.margin)) * 100).toFixed(1)}% of margin) stop ${t.stop} target ${t.target} · ${t.strategy || "session idea"} · until ${t.expires_on ?? "?"}\n    thesis: ${str(t.thesis, 240)}`; });
    const fUser = `${digest.length ? `NEWS SINCE THE LAST SESSION\n${digest.slice(0, 20).join("\n")}\n\n` : ""}TAPE\n${context}\n\nOPEN POSITIONS\n${positions.join("\n") || "(none)"}\n\nPROPOSALS\n${propText.join("\n") || noIdea}\n\n${bookText(book)}`;
    const fRes = await callModel(key, { model: team.frontier, system: SESSION_SYSTEM(team, book, s), user: fUser, schema: SESSION_SCHEMA, maxTokens: 2500, deadline: Math.min(deadline - 20_000, Date.now() + 50_000) });
    const fj = fRes.json ?? {};
    await saveOpinion(uid, null, team.frontier, "frontier", "review", fRes, fRes.json ? { positions: fj.positions, takes: fj.takes, note: str(fj.note, 600) } : {});
    const out: J = { team: team.name, proposals: proposals.length, closes: 0, tightened: 0, taken: 0, error: fRes.error };
    // positions
    for (const p of Array.isArray(fj.positions) ? (fj.positions as J[]) : []) {
      const t = book.openTrades.find((x) => x.id === str(p.trade_id, 64) && x.status === "open");
      if (!t || p.action === "hold") continue;
      const dir = t.side === "long" ? 1 : -1;
      const m = marks[t.symbol] ?? t.entry_price ?? t.entry_ref;
      if (p.action === "close") {
        await rest(`desk_trades?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ close_requested_at: new Date().toISOString(), close_reason: `the frontier closed it: ${str(p.reason, 300)}` }) });
        const mirror = rows(await rest(`desk_trades?user_id=eq.${uid}&owner=eq.desk&proposal_id=eq.${t.proposal_id}&status=eq.open&select=id`))[0];
        if (mirror) await rest(`desk_trades?id=eq.${mirror.id}`, { method: "PATCH", body: JSON.stringify({ close_requested_at: new Date().toISOString(), close_reason: `the champion closed it: ${str(p.reason, 300)}` }) });
        await rest("desk_decisions", { method: "POST", body: JSON.stringify({ user_id: uid, team_id: team.id, kind: "close", symbol: t.symbol, strategy: t.strategy ?? "", timeframe: t.timeframe ?? "", status: "done", brief: { session_key: sessionKey, trade: { id: t.id, symbol: t.symbol, side: t.side, entry_price: t.entry_price, stop: t.stop, target: t.target, unrealized: round(unrealized(t, m)), pnl_pct: round((unrealized(t, m) / Math.max(1, t.margin)) * 100) } }, ballots: [], verdict: { action: "close", reason: str(p.reason, 400), model: team.frontier }, outcome: { requested: true } }) });
        (out.closes as number)++;
      } else if (p.action === "tighten") {
        const stop = num(p.stop) > 0 && (num(p.stop) - m) * dir < 0 && Math.abs(m - num(p.stop)) < Math.abs(m - t.stop) ? num(p.stop) : t.stop;
        const target = num(p.target) > 0 && (num(p.target) - m) * dir > 0 && Math.abs(num(p.target) - m) < Math.abs(t.target - m) ? num(p.target) : t.target;
        if (stop === t.stop && target === t.target) continue;
        await rest(`desk_trades?id=eq.${t.id}`, { method: "PATCH", body: JSON.stringify({ stop, target }) });
        await rest("desk_decisions", { method: "POST", body: JSON.stringify({ user_id: uid, team_id: team.id, kind: "close", symbol: t.symbol, strategy: t.strategy ?? "", timeframe: t.timeframe ?? "", status: "done", brief: { session_key: sessionKey, trade: { id: t.id, symbol: t.symbol, side: t.side, entry_price: t.entry_price, stop: t.stop, target: t.target, unrealized: round(unrealized(t, m)), pnl_pct: round((unrealized(t, m) / Math.max(1, t.margin)) * 100) } }, ballots: [], verdict: { action: "tighten", reason: str(p.reason, 400), stop, target, model: team.frontier }, outcome: { stop, target } }) });
        (out.tightened as number)++;
      }
    }
    // proposals
    const takes = new Map<number, J>();
    for (const t of Array.isArray(fj.takes) ? (fj.takes as J[]) : []) takes.set(Math.floor(num(t.proposal, -1)), t);
    let taken = 0;
    const stats = { decisions: 0, takes: 0, passes: 0, sessions: 1 };
    if (!proposals.length) {
      await rest("desk_decisions", { method: "POST", body: JSON.stringify({ user_id: uid, team_id: team.id, kind: "session", symbol: "", status: "done", brief: { session_key: sessionKey, note: "no proposals", workers: ideas.map((x) => ({ model: x.model, reason: x.reason || x.error || "no idea" })), digest: digest.slice(0, 12) }, ballots: [], verdict: fRes.json ? { action: "pass", reason: str(fj.note, 500), model: team.frontier } : null, outcome: { taken: false, reasons: [str(fj.note, 300) || "no one on the crew had an idea"], pass_reason: "no proposals", by: "workers" }, cost_usd: round(workerCost / teams.length + fRes.cost, 5) }) });
      stats.decisions++; stats.passes++;
    }
    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i];
      const t = takes.get(i);
      const verdict: Verdict = t ? { action: t.action === "take" ? "take" : "pass", reason: str(t.reason, 500), risk_pct: Math.min(s.risk_max_pct, Math.max(0.5, num(t.risk_pct, 1))), leverage: Math.max(1, num(t.leverage, 1)), stop: null, target: null, model: team.frontier, error: fRes.error || undefined } : { action: "pass", reason: fRes.error ? `the frontier did not answer (${fRes.error})` : "the frontier gave no verdict", risk_pct: 0, leverage: 1, stop: null, target: null, model: team.frontier, error: fRes.error || "no verdict" };
      const ballot: Ballot = { model: p.model, role: "worker", stance: "take", confidence: p.confidence, thesis: p.thesis, wrong_if: p.wrong_if, stop: p.stop, target: p.target, leverage: p.leverage, tags: [], checked: [], error: "", cost_usd: 0, latency_ms: 0 };
      const made = rows(await rest("desk_decisions", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ user_id: uid, team_id: team.id, kind: "session", symbol: p.symbol, strategy: "", timeframe: p.horizon_days <= 1 ? "scalp" : p.horizon_days <= 10 ? "swing" : "position", status: "launched", brief: { session_key: sessionKey, proposal: { ...p, meta: undefined }, digest: digest.slice(0, 12) }, ballots: [ballot], verdict, launched: { at: t0, n: 1 } }) }))[0];
      if (!made) continue;
      let outcome: Exec;
      if (openSyms.has(p.symbol)) outcome = { taken: false, reasons: [`${p.symbol} is already on the team's book`], pass_reason: "already held", by: "guardrail" };
      else if (verdict.action !== "take" || taken >= 2) outcome = { taken: false, reasons: [taken >= 2 ? "two takes a session is the limit" : verdict.reason], pass_reason: taken >= 2 ? "two takes a session" : verdict.reason, by: "frontier" };
      else {
        const plan: Plan = { venue: p.venue as Venue, instrument: p.instrument, symbol: p.symbol, side: p.side as "long" | "short", leverage: p.leverage, template: 0, thesis: p.thesis, catalyst: p.catalyst, falsifier: p.wrong_if, confidence: p.confidence, entry_ref: p.entry_ref, stop: p.stop, target: p.target, horizon_days: p.horizon_days, risk_pct: verdict.risk_pct, evidence: [], key_risks: [], crosses_event: false, timeframe: p.horizon_days <= 1 ? "scalp" : p.horizon_days <= 10 ? "swing" : "position", strategy: "" };
        (book as unknown as J).regime = str(ctx.regime, 60);
        outcome = await execute(uid, acct, team, String(made.id), "session", plan, verdict, [ballot], book, rules, s, p.atr, p.entry_ref, champion === team.id, Date.now());
        if (outcome.taken) { taken++; openSyms.add(p.symbol); }
      }
      await rest(`desk_decisions?id=eq.${made.id}`, { method: "PATCH", body: JSON.stringify({ status: "done", ballots: [ballot, { model: team.frontier, role: "frontier", stance: verdict.action, confidence: verdict.action === "take" ? 0.6 : 0.4, thesis: verdict.reason, wrong_if: "", stop: null, target: null, leverage: verdict.leverage, tags: [], checked: [], error: verdict.error ?? "", cost_usd: 0, latency_ms: 0 }], outcome, cost_usd: round((workerCost / teams.length + fRes.cost) / Math.max(1, proposals.length), 5), updated_at: new Date().toISOString() }) });
      stats.decisions++; if (outcome.taken) stats.takes++; else stats.passes++;
    }
    out.taken = taken;
    await bumpStats(team.id, { ...stats, closes: num(out.closes) });
    return out;
  }));
  return { session: sessionKey, proposals: proposals.length, teams: results, ms: Date.now() - t0 };
}

/* ── the daily ranking at 16:06 ET: passive days, the tiers, the season ── */
async function rank(uid: string, body: J): Promise<J> {
  const t0 = Date.now();
  const acct = await loadAccount(uid);
  if (!acct) return { error: "no account" };
  const s = leagueSettings(acct.league as Partial<LeagueSettings>);
  const today = etDate(t0), now = etParts(t0);
  const force = body.force === true;
  if (!force && now.hour * 60 + now.minute < 16 * 60 + 6) return { note: "the ranking is at 16:06 ET" };
  const ranToday = rows(await rest(`desk_roster_log?user_id=eq.${uid}&action=eq.rank&at=gte.${today}T04:00:00Z&select=id&limit=1`)).length > 0;
  if (!force && ranToday) return { note: "the ranking already ran today" };
  const all = await loadTeams(uid);
  if (!all.some((t) => t.status === "live")) return { note: "no live teams" };
  const season = await currentSeason(uid, s, today);
  const marks = await markTeams(uid, s, all, num(season.n, 1));
  const out: J = { day: today, died: marks.died, moved: [] as string[], champion: "", passive: [] as string[] };
  // playing to survive: too few takes today and too little at risk → a passive day against the team, docked from its ranked return
  const dayStart = Date.parse(`${today}T04:00:00Z`);
  const takesR = rows(await rest(`desk_trades?user_id=eq.${uid}&owner=like.team:*&decided_at=gte.${iso(t0 - 24 * 3_600_000)}&status=neq.cancelled&select=owner`));
  const openAll = rows(await rest(`desk_trades?user_id=eq.${uid}&owner=like.team:*&status=eq.open&select=${TRADE_COLS}&limit=2000`)).map(toTrade);
  for (const team of all.filter((t) => t.status === "live")) {
    const takes = takesR.filter((x) => x.owner === `team:${team.id}`).length;
    const heat = heatOf(openAll.filter((x) => x.owner === `team:${team.id}`), team.equity);
    const old = Date.parse(team.formed_at) < dayStart;
    let passiveDays = num(team.stats.passive_days);
    if (!ranToday && old && isPassive(takes, heat, s)) { // a passive day is judged once a day; a forced re-rank only re-sorts the tiers
      passiveDays++;
      await log(uid, team.name, "passive", team.frontier, "", `playing to survive: ${takes} take${takes === 1 ? "" : "s"} today and ${heat.toFixed(1)}% of the book at risk; ${s.passive_penalty_pct}% docked from the ranked return (${passiveDays} passive day${passiveDays === 1 ? "" : "s"})`);
      (out.passive as string[]).push(team.name);
    }
    const score = rankScore(team.return_pct, passiveDays, s);
    team.stats = { ...team.stats, passive_days: passiveDays, rank_score: round(score, 4), takes_day: takes, heat_pct: round(heat) };
    await rest(`desk_teams?id=eq.${team.id}`, { method: "PATCH", body: JSON.stringify({ stats: team.stats }) });
  }
  // tiers by the ranked return
  const ranked = rankTiers(all.map(teamLike), s.teams_per_tier);
  for (const r of ranked) {
    const team = all.find((t) => t.id === r.id)!;
    if (team.tier === r.tier) continue;
    const up = ["bronze", "gold", "diamond"].indexOf(r.tier) > ["bronze", "gold", "diamond"].indexOf(team.tier);
    await rest(`desk_teams?id=eq.${team.id}`, { method: "PATCH", body: JSON.stringify({ tier: r.tier }) });
    await log(uid, team.name, up ? "promoted" : "relegated", team.frontier, "", `${team.tier} to ${r.tier} at ${team.return_pct >= 0 ? "+" : ""}${team.return_pct.toFixed(2)}%`);
    (out.moved as string[]).push(`${team.name}: ${team.tier} to ${r.tier}`);
    team.tier = r.tier;
  }
  // the season
  if (today >= String(season.end_day)) {
    const top = rankTiers(all.map(teamLike), s.teams_per_tier)[0];
    const champ = top ? all.find((t) => t.id === top.id) : undefined;
    await rest(`desk_seasons?id=eq.${season.id}`, { method: "PATCH", body: JSON.stringify({ status: "done", champion_team: champ?.id ?? null }) });
    if (champ) { await log(uid, champ.name, "champion", champ.frontier, "", `season ${season.n}: ${champ.return_pct >= 0 ? "+" : ""}${champ.return_pct.toFixed(2)}%; the desk mirrors this team now`); out.champion = champ.name; }
    await rest("desk_seasons", { method: "POST", body: JSON.stringify({ user_id: uid, n: num(season.n) + 1, start_day: addDays(today, 1), end_day: addDays(today, 1 + s.season_days), status: "running" }) });
  }
  await log(uid, "the leagues", "rank", "", "", `daily ranking ran: ${(out.moved as string[]).length} moved${(out.passive as string[]).length ? `; passive: ${(out.passive as string[]).join(", ")}` : ""}${marks.died.length ? `; died: ${marks.died.join(", ")}` : ""}${out.champion ? `; champion ${out.champion}` : ""}`);
  out.ms = Date.now() - t0;
  return out;
}

async function form(uid: string): Promise<J> {
  const acct = await loadAccount(uid);
  if (!acct) return { error: "no account" };
  const s = leagueSettings(acct.league as Partial<LeagueSettings>);
  const all = await loadTeams(uid);
  if (all.some((t) => t.status === "live")) return { note: "teams already exist", live: all.filter((t) => t.status === "live").length };
  const today = etDate(Date.now());
  const season = await currentSeason(uid, s, today);
  const made: string[] = [];
  for (const d of draftTeams(s)) {
    const t = await insertTeam(uid, s, all, d.frontier, d.tier, num(season.n, 1), "the opening draft");
    if (t) made.push(`${t.name} (${d.tier})`);
  }
  return { formed: made, season: season.n };
}

/** Kills a live team by hand (a frontier that cannot answer, a model gone from OpenRouter): it dies with the reason given and its frontier gets a new life. */
async function retire(uid: string, body: J): Promise<J> {
  const acct = await loadAccount(uid);
  if (!acct) return { error: "no account" };
  const s = leagueSettings(acct.league as Partial<LeagueSettings>);
  const all = await loadTeams(uid);
  const team = all.find((t) => t.id === str(body.team_id, 64) && t.status === "live");
  if (!team) return { error: "no live team" };
  const season = await currentSeason(uid, s, etDate(Date.now()));
  const r = await dieTeam(uid, s, all, team, str(body.reason, 300) || "retired by hand", num(season.n, 1));
  return { retired: team.name, replacement: r.replacement ? { name: r.replacement.name, frontier: r.replacement.frontier, tier: r.replacement.tier } : null };
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
    const isService = !!token && !!SERVICE_KEY && token === SERVICE_KEY;
    if (!uid && isService) uid = String(body.userId ?? "");
    if (!uid && token) { try { const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }); if (r.ok) uid = String((await r.json())?.id ?? ""); } catch { /* 401 below */ } }
    if (!/^[0-9a-f-]{36}$/i.test(uid)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const internal = isService || !!cronSecret;
    if (mode === "form") return ok(await form(uid));
    if (mode === "retire") return ok(internal ? await retire(uid, body) : { error: "the desk retires teams" });
    if (mode === "cycle") return ok(internal ? await cycle(uid, body) : { error: "the tick runs the cycle" });
    if (mode === "decide") return ok(internal ? await decide(uid, body) : { error: "children are launched by the desk" });
    if (mode === "session") return ok(await session(uid, body));
    if (mode === "session_all") return ok(internal ? await sessionAll(uid, body) : { error: "children are launched by the desk" });
    if (mode === "rank" || mode === "council") return ok(await rank(uid, body));
    if (mode === "status") {
      const teams = await loadTeams(uid);
      return ok({ live: teams.filter((t) => t.status === "live").map((t) => ({ name: t.name, tier: t.tier, return_pct: t.return_pct })), dead: teams.filter((t) => t.status === "dead").length });
    }
    return ok({ error: "Unknown mode." });
  } catch (e) {
    console.error("[desk-league] fatal", e instanceof Error ? e.stack ?? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way; try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
