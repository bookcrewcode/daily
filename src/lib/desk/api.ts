"use client";

// The Desk — client side of the edge functions and the tables. Thin on
// purpose: every loader returns { data, error } shaped results so a failed
// read can never render like an empty state (GRADING.md rule 2).

import { supabase, SUPABASE_URL, SUPABASE_ANON, todayStr } from "@/lib/supabase";
import type { PresetKey, Rules, Trade, TradeStatus } from "./types";
import type { Tally } from "./vote";
import type { CalibBin, CutRules, Standing } from "./stats";
import type { LeagueSettings, Tier } from "./league";

export const TAPE_FN = `${SUPABASE_URL}/functions/v1/tape`;
export const DESK_FN = `${SUPABASE_URL}/functions/v1/desk`;
export const SYNC_FN = `${SUPABASE_URL}/functions/v1/desk-sync`;
export const REVIEW_FN = `${SUPABASE_URL}/functions/v1/desk-review`;
export const FEED_FN = `${SUPABASE_URL}/functions/v1/desk-feed`;
export const LEAGUE_FN = `${SUPABASE_URL}/functions/v1/desk-league`;

export async function callFn<T = Record<string, unknown>>(url: string, body: Record<string, unknown>, timeoutMs = 150_000): Promise<T & { error?: string }> {
  const { data: s } = await supabase.auth.getSession();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${s.session?.access_token ?? ""}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await r.text();
    try { return JSON.parse(text) as T & { error?: string }; }
    catch { return { error: `The server answered with something unreadable (HTTP ${r.status}).` } as T & { error?: string }; }
  } catch (e) {
    return { error: e instanceof Error && e.name === "AbortError" ? "That took too long — the run may still be going; refresh in a minute." : "Couldn't reach the server — check your connection." } as T & { error?: string };
  } finally { clearTimeout(t); }
}

export type Account = {
  user_id: string; starting_equity: number; cash: number; equity: number; peak_equity: number;
  preset: PresetKey; rules: Partial<Rules>; halted_until: string | null; halt_reason: string;
  roster: string[]; judge: string; budget_usd_per_run: number; ladder: Record<string, unknown>; leverage_cap_override: number | null;
  sit_roster: string[]; sit_budget_usd: number; cooldown_hours: number; strategies_off: string[];
  bench: string[]; sit_bench: string[]; cut_rules: Partial<CutRules>;
  league: Partial<LeagueSettings>;
  learned_terms: string[]; // glossary ids Ben has tapped "got it" on; the parenthesis stops showing for these
};

const n = (v: unknown, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const nul = (v: unknown) => (v === null || v === undefined ? null : n(v));

function toAccount(row: Record<string, unknown>): Account {
  return {
    user_id: String(row.user_id), starting_equity: n(row.starting_equity, 100000), cash: n(row.cash, 100000), equity: n(row.equity, 100000),
    peak_equity: n(row.peak_equity, 100000), preset: (row.preset as PresetKey) ?? "aggressive", rules: (row.rules as Partial<Rules>) ?? {},
    halted_until: row.halted_until ? String(row.halted_until) : null, halt_reason: String(row.halt_reason ?? ""),
    roster: Array.isArray(row.roster) ? (row.roster as string[]) : [], judge: String(row.judge ?? ""), budget_usd_per_run: n(row.budget_usd_per_run, 1.5),
    ladder: (row.ladder as Record<string, unknown>) ?? {}, leverage_cap_override: nul(row.leverage_cap_override),
    sit_roster: Array.isArray(row.sit_roster) ? (row.sit_roster as string[]) : [], sit_budget_usd: n(row.sit_budget_usd, 3), cooldown_hours: n(row.cooldown_hours, 4),
    strategies_off: Array.isArray(row.strategies_off) ? (row.strategies_off as string[]) : [],
    bench: Array.isArray(row.bench) ? (row.bench as string[]) : [], sit_bench: Array.isArray(row.sit_bench) ? (row.sit_bench as string[]) : [],
    cut_rules: (row.cut_rules as Partial<CutRules>) ?? {},
    league: (row.league as Partial<LeagueSettings>) ?? {},
    learned_terms: Array.isArray(row.learned_terms) ? (row.learned_terms as unknown[]).map(String) : [],
  };
}

// Select, and only if the read succeeded and found nothing, create the row.
export async function ensureAccount(uid: string): Promise<{ account: Account | null; error: string }> {
  const { data, error } = await supabase.from("desk_accounts").select("*").eq("user_id", uid).maybeSingle();
  if (error) return { account: null, error: "Couldn't load the desk account." };
  if (data) return { account: toAccount(data as Record<string, unknown>), error: "" };
  const ins = await supabase.from("desk_accounts").insert({ user_id: uid }).select("*").maybeSingle();
  if (ins.error || !ins.data) return { account: null, error: "Couldn't open the desk account." };
  return { account: toAccount(ins.data as Record<string, unknown>), error: "" };
}

export function toTrade(x: Record<string, unknown>): Trade {
  return {
    id: String(x.id), owner: String(x.owner ?? "desk"), session_id: x.session_id ? String(x.session_id) : null, proposal_id: String(x.proposal_id ?? ""),
    source: (x.source as Trade["source"]) ?? "nightly", strategy: String(x.strategy ?? ""), timeframe: (x.timeframe as Trade["timeframe"]) ?? "swing",
    sit_id: x.sit_id ? String(x.sit_id) : null, horizon_hours: nul(x.horizon_hours), size_mult: n(x.size_mult, 1),
    venue: x.venue as Trade["venue"], instrument: x.instrument as Trade["instrument"], symbol: String(x.symbol), name: String(x.name ?? ""),
    side: x.side as Trade["side"], status: x.status as TradeStatus, template: n(x.template), thesis: String(x.thesis ?? ""),
    catalyst: String(x.catalyst ?? ""), falsifier: String(x.falsifier ?? ""), confidence: n(x.confidence, 0.5),
    evidence: Array.isArray(x.evidence) ? (x.evidence as number[]) : [], regime: String(x.regime ?? ""), decided_at: String(x.decided_at ?? ""),
    entry_ref: n(x.entry_ref), stop: n(x.stop), target: n(x.target), horizon_days: n(x.horizon_days, 10), risk_pct: n(x.risk_pct, 3),
    leverage: n(x.leverage, 1), qty: n(x.qty), unit: (x.unit as Trade["unit"]) ?? "share", contract_value: n(x.contract_value, 1),
    notional: n(x.notional), margin: n(x.margin), liq_price: nul(x.liq_price),
    entry_price: nul(x.entry_price), entry_at: x.entry_at ? String(x.entry_at) : null, fill_rule: String(x.fill_rule ?? ""), slippage_bps: n(x.slippage_bps),
    fees: n(x.fees), funding: n(x.funding), funding_at: x.funding_at ? String(x.funding_at) : null, checked_until: x.checked_until ? String(x.checked_until) : null,
    expires_on: x.expires_on ? String(x.expires_on) : null, exit_price: nul(x.exit_price), exit_at: x.exit_at ? String(x.exit_at) : null,
    exit_reason: (x.exit_reason as Trade["exit_reason"]) ?? null, ambiguous_bar: x.ambiguous_bar === true, pnl: nul(x.pnl), pnl_pct: nul(x.pnl_pct),
    r_multiple: nul(x.r_multiple), mae_r: nul(x.mae_r), mfe_r: nul(x.mfe_r), spy_entry: nul(x.spy_entry), spy_exit: nul(x.spy_exit),
    review: (x.review as Record<string, unknown> | null) ?? null,
    ticket: (x.ticket as Record<string, unknown> | null) ?? null, close_requested_at: x.close_requested_at ? String(x.close_requested_at) : null, close_reason: x.close_reason ? String(x.close_reason) : null,
  };
}

export async function loadTrades(uid: string, opts: { owner?: string; ownerLike?: string; status?: TradeStatus[]; limit?: number; sessionId?: string } = {}): Promise<{ trades: Trade[]; error: string }> {
  let q = supabase.from("desk_trades").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(opts.limit ?? 200);
  if (opts.owner) q = q.eq("owner", opts.owner);
  if (opts.ownerLike) q = q.like("owner", opts.ownerLike);
  if (opts.status?.length) q = q.in("status", opts.status);
  if (opts.sessionId) q = q.eq("session_id", opts.sessionId);
  const { data, error } = await q;
  if (error) return { trades: [], error: "Couldn't load the trades." };
  return { trades: ((data ?? []) as Record<string, unknown>[]).map(toTrade), error: "" };
}

export type EquityPoint = { day: string; equity: number; spy_close: number | null; pnl_day: number; gross_exposure: number };
export async function loadEquity(uid: string, owner = "desk"): Promise<{ curve: EquityPoint[]; error: string }> {
  const { data, error } = await supabase.from("desk_equity").select("day,equity,spy_close,pnl_day,gross_exposure").eq("user_id", uid).eq("owner", owner).order("day", { ascending: true }).limit(2000);
  if (error) return { curve: [], error: "Couldn't load the equity curve." };
  return { curve: ((data ?? []) as Record<string, unknown>[]).map((r) => ({ day: String(r.day), equity: n(r.equity), spy_close: nul(r.spy_close), pnl_day: n(r.pnl_day), gross_exposure: n(r.gross_exposure) })), error: "" };
}

export type Verdict = {
  narrative: string;
  decisions: { proposal_id: string; action: "take" | "veto" | "cut"; size_multiplier: number; leverage: number; reason: string }[];
  why_not: { proposal_id: string; reason: string }[];
  lesson: string;
  taken: { trade_id: string; proposal_id: string; symbol?: string }[];
  dropped?: string[];
};
export type SessionRow = {
  id: string; day: string; seq: number; status: string; stage: string; regime: string;
  packet: Record<string, unknown>; votes: Tally[]; verdict: Partial<Verdict>; judge_model: string;
  cost_usd: number; tokens_in: number; tokens_out: number; error: string; created_at: string;
};
export async function loadSessions(uid: string, limit = 14): Promise<{ sessions: SessionRow[]; error: string }> {
  const { data, error } = await supabase.from("desk_sessions").select("*").eq("user_id", uid).order("day", { ascending: false }).order("seq", { ascending: false }).limit(limit);
  if (error) return { sessions: [], error: "Couldn't load the desk's sessions." };
  return {
    sessions: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), day: String(r.day), seq: n(r.seq, 1), status: String(r.status), stage: String(r.stage), regime: String(r.regime ?? ""),
      packet: (r.packet as Record<string, unknown>) ?? {}, votes: Array.isArray(r.votes) ? (r.votes as Tally[]) : [], verdict: (r.verdict as Partial<Verdict>) ?? {},
      judge_model: String(r.judge_model ?? ""), cost_usd: n(r.cost_usd), tokens_in: n(r.tokens_in), tokens_out: n(r.tokens_out), error: String(r.error ?? ""), created_at: String(r.created_at),
    })),
    error: "",
  };
}

export type OpinionRow = { id: string; model: string; juror: string; round: string; content: Record<string, unknown>; latency_ms: number; cost_usd: number; error: string; created_at: string };
export async function loadOpinions(sessionId: string): Promise<{ opinions: OpinionRow[]; error: string }> {
  const { data, error } = await supabase.from("desk_opinions").select("id,model,juror,round,content,latency_ms,cost_usd,error,created_at").eq("session_id", sessionId).order("created_at", { ascending: true });
  if (error) return { opinions: [], error: "Couldn't load the debate." };
  return {
    opinions: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), model: String(r.model), juror: String(r.juror), round: String(r.round), content: (r.content as Record<string, unknown>) ?? {},
      latency_ms: n(r.latency_ms), cost_usd: n(r.cost_usd), error: String(r.error ?? ""), created_at: String(r.created_at),
    })),
    error: "",
  };
}

// Human names for model ids, and one colour per lab so a transcript reads at a glance.
const LABELS: Record<string, string> = {
  "anthropic/claude-sonnet-5": "Claude Sonnet 5", "anthropic/claude-opus-5": "Claude Opus 5", "anthropic/claude-haiku-4.5": "Claude Haiku 4.5", "anthropic/claude-fable-5.1": "Claude Fable 5.1",
  "openai/gpt-5.6-terra": "GPT-5.6 Terra", "openai/gpt-5.6-luna": "GPT-5.6 Luna", "openai/gpt-6-astra": "GPT-6 Astra",
  "google/gemini-3.8-flash": "Gemini 3.8 Flash", "google/gemini-3.5-flash-lite": "Gemini 3.5 Flash Lite", "google/gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "x-ai/grok-4.6": "Grok 4.6", "deepseek/deepseek-v4-pro-0813": "DeepSeek V4 Pro", "deepseek/deepseek-v4-flash-0731": "DeepSeek V4 Flash",
  "qwen/qwen3.8-max-0902": "Qwen 3.8 Max", "qwen/qwen3.8-flash": "Qwen 3.8 Flash", "moonshotai/kimi-k2.6": "Kimi K2.6", "moonshotai/kimi-k3": "Kimi K3",
  "mistralai/mistral-medium-3-5": "Mistral Medium 3.5", "z-ai/glm-5.3": "GLM 5.3", "minimax/minimax-m3": "MiniMax M3", "meta/muse-spark-1.3": "Meta Muse Spark",
};
export function modelLabel(id: string): string {
  if (id === "desk") return "The desk";
  return LABELS[id] ?? id.split("/").pop()?.replace(/[-_]/g, " ") ?? id;
}
const TONES: Record<string, string> = {
  anthropic: "#d97757", openai: "#10a37f", google: "#4285f4", "x-ai": "#e5e5e5", deepseek: "#4d6bfe", qwen: "#8b7cf6",
  moonshotai: "#f7b500", mistralai: "#ff7000", "z-ai": "#6c5ce7", minimax: "#ff5c8a", meta: "#0866ff", nvidia: "#76b900", perplexity: "#20808d",
};
export function labTone(id: string): string {
  return TONES[id.split("/")[0]] ?? "var(--text-3)";
}

export const fmtMoney = (v: number, digits = 0) => (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
export const fmtPct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
export const fmtPrice = (v: number) => (v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toPrecision(4));
export const fmtR = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

/* ── league, lessons, coach ─────────────────────────────────────────────── */
export type Rating = {
  model: string; elo: number; n_matches: number; n_trades: number; n_wins: number; sum_r: number;
  brier: number | null; brier_n: number; calib: CalibBin[]; n_abstain: number; n_sits: number; n_sit_right: number; updated_at: string;
  status: string; standing: Record<string, Standing & { as_of?: string }>; cut_at: string | null; cut_reason: string;
};
export async function loadRatings(uid: string): Promise<{ ratings: Rating[]; error: string }> {
  const { data, error } = await supabase.from("desk_ratings").select("*").eq("user_id", uid);
  if (error) return { ratings: [], error: "Couldn't load the ratings." };
  return {
    ratings: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      model: String(r.model), elo: n(r.elo, 1500), n_matches: n(r.n_matches), n_trades: n(r.n_trades), n_wins: n(r.n_wins), sum_r: n(r.sum_r),
      brier: n(r.brier_n) > 0 ? n(r.brier_sum) / n(r.brier_n) : null, brier_n: n(r.brier_n), calib: Array.isArray(r.calib) ? (r.calib as CalibBin[]) : [],
      n_abstain: n(r.n_abstain), n_sits: n(r.n_sits), n_sit_right: n(r.n_sit_right), updated_at: String(r.updated_at ?? ""),
      status: String(r.status ?? "active"), standing: (r.standing as Rating["standing"]) ?? {}, cut_at: r.cut_at ? String(r.cut_at) : null, cut_reason: String(r.cut_reason ?? ""),
    })),
    error: "",
  };
}

// Latest 4pm mark per owner (the desk and every shadow book).
export async function loadLatestEquity(uid: string): Promise<{ latest: Record<string, { day: string; equity: number }>; error: string }> {
  const { data, error } = await supabase.from("desk_equity").select("owner,day,equity").eq("user_id", uid).order("day", { ascending: false }).limit(400);
  if (error) return { latest: {}, error: "Couldn't load the shadow books." };
  const latest: Record<string, { day: string; equity: number }> = {};
  for (const r of (data ?? []) as Record<string, unknown>[]) { const o = String(r.owner); if (!latest[o]) latest[o] = { day: String(r.day), equity: n(r.equity) }; }
  return { latest, error: "" };
}

export type LessonStatus = "hidden" | "emerging" | "active";
export type Lesson = {
  id: string; text: string; scope: Record<string, unknown>; for_count: number; against_count: number; applied_count: number;
  status: LessonStatus; source_trade_ids: string[]; created_at: string; updated_at: string;
};
export async function loadLessons(uid: string): Promise<{ lessons: Lesson[]; error: string }> {
  const { data, error } = await supabase.from("desk_lessons").select("*").eq("user_id", uid).order("for_count", { ascending: false }).order("updated_at", { ascending: false }).limit(200);
  if (error) return { lessons: [], error: "Couldn't load the lessons." };
  return {
    lessons: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), text: String(r.text ?? ""), scope: (r.scope as Record<string, unknown>) ?? {}, for_count: n(r.for_count), against_count: n(r.against_count),
      applied_count: n(r.applied_count), status: (["hidden", "emerging", "active"].includes(String(r.status)) ? String(r.status) : "hidden") as LessonStatus,
      source_trade_ids: Array.isArray(r.source_trade_ids) ? (r.source_trade_ids as string[]) : [], created_at: String(r.created_at ?? ""), updated_at: String(r.updated_at ?? ""),
    })),
    error: "",
  };
}

export type CoachCell = { n: number; hit: number | null; mean_r: number | null; shrunk_r: number | null; profit_factor: number | null; t: number | null; label: string };
export type TradeSummary = { symbol: string; side: string; source: string; strategy: string; timeframe: string; r: number; pnl: number; exit: string; closed: string; quadrant: string; grade: string; lesson: string; why: string };
export type RosterChange = { seat: string; action: string; model: string; replaced_by: string; reason: string };
export type StandingRow = Standing & { model: string; seat: string };
export type CoachModel = CoachCell & { elo?: number; brier?: number | null; matches?: number; sits?: number; sit_right?: number | null; status?: string; standing?: string };
export type CoachCard = {
  day: string; week_start: string;
  card: {
    as_of?: string; desk?: Record<string, Record<string, CoachCell> | CoachCell>; models?: Record<string, CoachModel>; strategies?: Record<string, CoachCell>;
    strategy_rules?: Record<string, { size_mult?: number; benched_until?: string | null; label?: string }>; trades?: TradeSummary[]; open?: string[];
    sits_week?: { n: number; taken: number }; standing?: StandingRow[]; roster_changes?: RosterChange[];
  };
  review: string; created_at: string;
};
export async function loadCards(uid: string, limit = 7): Promise<{ cards: CoachCard[]; error: string }> {
  const { data, error } = await supabase.from("desk_cards").select("*").eq("user_id", uid).order("day", { ascending: false }).limit(limit);
  if (error) return { cards: [], error: "Couldn't load the reviews." };
  return {
    cards: ((data ?? []) as Record<string, unknown>[]).map((r) => ({ day: String(r.day ?? r.week_start), week_start: String(r.week_start), card: (r.card as CoachCard["card"]) ?? {}, review: String(r.review ?? ""), created_at: String(r.created_at ?? "") })),
    error: "",
  };
}
export type RosterLogRow = { id: string; at: string; seat: string; action: string; model: string; replaced_by: string; reason: string };
export async function loadRosterLog(uid: string, limit = 20): Promise<{ log: RosterLogRow[]; error: string }> {
  const { data, error } = await supabase.from("desk_roster_log").select("*").eq("user_id", uid).order("at", { ascending: false }).limit(limit);
  if (error) return { log: [], error: "Couldn't load the roster log." };
  return {
    log: ((data ?? []) as Record<string, unknown>[]).map((r) => ({ id: String(r.id), at: String(r.at ?? ""), seat: String(r.seat ?? ""), action: String(r.action ?? ""), model: String(r.model ?? ""), replaced_by: String(r.replaced_by ?? ""), reason: String(r.reason ?? "") })),
    error: "",
  };
}

/* ── settings ───────────────────────────────────────────────────────────── */
export type AccountPatch = { preset?: PresetKey; roster?: string[]; judge?: string; budget_usd_per_run?: number; leverage_cap_override?: number | null; rules?: Partial<Rules>; sit_roster?: string[]; sit_budget_usd?: number; cooldown_hours?: number; strategies_off?: string[]; bench?: string[]; sit_bench?: string[]; league?: Partial<LeagueSettings>; learned_terms?: string[] };
export async function updateAccount(uid: string, patch: AccountPatch): Promise<{ error: string }> {
  const { error } = await supabase.from("desk_accounts").update(patch).eq("user_id", uid);
  return { error: error ? "Couldn't save the desk settings." : "" };
}
export const MODEL_ID = /^[a-z0-9.-]+\/[a-z0-9.:_-]+$/i;

/* ── ask the desk: one persisted thread per session (topic_id is a uuid) ── */
export type ChatTurn = { role: "user" | "assistant"; content: string };
export async function loadDeskChat(uid: string, sessionId: string): Promise<{ turns: ChatTurn[]; error: string }> {
  const { data, error } = await supabase.from("chat_messages").select("role,content").eq("user_id", uid).eq("advisor", "desk").eq("topic_id", sessionId).order("created_at", { ascending: true }).limit(60);
  if (error) return { turns: [], error: "Couldn't load the thread." };
  return { turns: ((data ?? []) as Record<string, unknown>[]).map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: String(r.content ?? "") })), error: "" };
}
export async function saveDeskChat(uid: string, sessionId: string, role: ChatTurn["role"], content: string): Promise<{ error: string }> {
  const { error } = await supabase.from("chat_messages").insert({ user_id: uid, advisor: "desk", topic_id: sessionId, role, content });
  return { error: error ? "Couldn't save the thread." : "" };
}

/* ── the Card's one-line chip ───────────────────────────────────────────── */
export type DeskChip = { equity: number; start: number; day_pnl: number; open: number; pending: number; halted: boolean; tonight: string };
export async function loadDeskChip(uid: string): Promise<DeskChip | null> {
  const [a, t, s, e] = await Promise.all([
    supabase.from("desk_accounts").select("equity,starting_equity,halted_until").eq("user_id", uid).maybeSingle(),
    supabase.from("desk_trades").select("status").eq("user_id", uid).eq("owner", "desk").in("status", ["open", "pending"]),
    supabase.from("desk_sessions").select("day,status,stage").eq("user_id", uid).neq("status", "dry").order("day", { ascending: false }).order("seq", { ascending: false }).limit(1),
    supabase.from("desk_equity").select("day,pnl_day").eq("user_id", uid).eq("owner", "desk").order("day", { ascending: false }).limit(1),
  ]);
  if (a.error || !a.data) return null; // no account yet: no chip, not a fake zero
  const rows = (t.data ?? []) as { status: string }[];
  const sess = ((s.data ?? []) as { day: string; status: string; stage: string }[])[0];
  const today = todayStr();
  const last = ((e.data ?? []) as { day: string; pnl_day: number }[])[0];
  const tonight = !sess ? "no debate yet" : sess.day !== today ? `last debate ${sess.day.slice(5)}` : sess.status === "done" ? "tonight's debate is in" : sess.status === "running" ? "the jury is sitting" : sess.status === "skipped" ? "waiting for the briefing" : sess.status;
  return {
    equity: n(a.data.equity, 100000), start: n(a.data.starting_equity, 100000), day_pnl: last && last.day === today ? n(last.pnl_day) : 0,
    open: rows.filter((r) => r.status === "open").length, pending: rows.filter((r) => r.status === "pending").length,
    halted: !!a.data.halted_until && String(a.data.halted_until) >= today, tonight,
  };
}
export function deskChipText(c: DeskChip): string {
  const all = c.equity - c.start;
  const pos = c.open + c.pending ? `${c.open} open${c.pending ? ` · ${c.pending} queued` : ""}` : "flat";
  return `${fmtMoney(c.equity)} · ${all >= 0 ? "+" : "-"}${fmtMoney(Math.abs(all))} all time · ${pos}${c.halted ? " · halted" : ""} · ${c.tonight}`;
}

/* ── the feed ───────────────────────────────────────────────────────────── */
export type NewsItem = {
  id: string; link: string; title: string; source: string; published: string; summary: string;
  tickers: string[]; venue: string; category: string; impact: number; direction: string; horizon: string; why: string; tagged: boolean;
  plain: string; // one or two beginner's sentences on what happened and what it means for the price; empty on rows tagged before it existed
};
export async function loadNews(limit = 150, opts: { minImpact?: number; venue?: string; ticker?: string; sinceHours?: number } = {}): Promise<{ items: NewsItem[]; error: string }> {
  let q = supabase.from("desk_news").select("*").order("published", { ascending: false }).limit(limit);
  if (opts.minImpact) q = q.gte("impact", opts.minImpact);
  if (opts.venue) q = q.eq("venue", opts.venue);
  if (opts.ticker) q = q.contains("tickers", [opts.ticker]);
  if (opts.sinceHours) q = q.gte("published", new Date(Date.now() - opts.sinceHours * 3_600_000).toISOString());
  const { data, error } = await q;
  if (error) return { items: [], error: "Couldn't load the feed." };
  return {
    items: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), link: String(r.link), title: String(r.title ?? ""), source: String(r.source ?? ""), published: String(r.published ?? ""), summary: String(r.summary ?? ""),
      tickers: Array.isArray(r.tickers) ? (r.tickers as string[]) : [], venue: String(r.venue ?? "none"), category: String(r.category ?? "other"), impact: n(r.impact),
      direction: String(r.direction ?? "none"), horizon: String(r.horizon ?? "none"), why: String(r.why ?? ""), tagged: r.tagged === true,
      plain: String(r.plain ?? ""),
    })),
    error: "",
  };
}

/* ── setups and sits ────────────────────────────────────────────────────── */
export type SetupRow = {
  id: string; strategy: string; symbol: string; venue: string; instrument: string; side: string; timeframe: string;
  entry_ref: number; stop: number; target: number; leverage_hint: number; horizon_hours: number | null; horizon_days: number | null;
  score: number; reasons: { label: string; value: string; ok: boolean; core: boolean }[]; invalidation: string; card: Record<string, unknown>;
  status: string; sit_id: string | null; trade_id: string | null; shadow_trade_id: string | null; created_at: string; expires_at: string | null;
};
export async function loadSetups(uid: string, limit = 60, sinceHours = 48): Promise<{ setups: SetupRow[]; error: string }> {
  const { data, error } = await supabase.from("desk_setups").select("*").eq("user_id", uid).gte("created_at", new Date(Date.now() - sinceHours * 3_600_000).toISOString()).order("created_at", { ascending: false }).limit(limit);
  if (error) return { setups: [], error: "Couldn't load the setups." };
  return {
    setups: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), strategy: String(r.strategy), symbol: String(r.symbol), venue: String(r.venue), instrument: String(r.instrument), side: String(r.side), timeframe: String(r.timeframe ?? "swing"),
      entry_ref: n(r.entry_ref), stop: n(r.stop), target: n(r.target), leverage_hint: n(r.leverage_hint, 1), horizon_hours: nul(r.horizon_hours), horizon_days: nul(r.horizon_days),
      score: n(r.score), reasons: Array.isArray(r.reasons) ? (r.reasons as SetupRow["reasons"]) : [], invalidation: String(r.invalidation ?? ""), card: (r.card as Record<string, unknown>) ?? {},
      status: String(r.status ?? "new"), sit_id: r.sit_id ? String(r.sit_id) : null, trade_id: r.trade_id ? String(r.trade_id) : null, shadow_trade_id: r.shadow_trade_id ? String(r.shadow_trade_id) : null,
      created_at: String(r.created_at ?? ""), expires_at: r.expires_at ? String(r.expires_at) : null,
    })),
    error: "",
  };
}
export type SitRow = {
  id: string; setup_id: string | null; symbol: string; strategy: string; timeframe: string; status: string; brief: Record<string, unknown>;
  votes: { model: string; juror?: string; stance: string; confidence: number; side?: string; stop?: number; target?: number; leverage?: number; thesis?: string; what_would_prove_me_wrong?: string; tags?: string[]; error?: string }[];
  decision: Record<string, unknown>; trade_id: string | null; cost_usd: number; error: string; created_at: string; updated_at: string;
};
export async function loadSits(uid: string, limit = 60, sinceHours = 72): Promise<{ sits: SitRow[]; error: string }> {
  const { data, error } = await supabase.from("desk_sits").select("*").eq("user_id", uid).gte("created_at", new Date(Date.now() - sinceHours * 3_600_000).toISOString()).order("created_at", { ascending: false }).limit(limit);
  if (error) return { sits: [], error: "Couldn't load the sits." };
  return {
    sits: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), setup_id: r.setup_id ? String(r.setup_id) : null, symbol: String(r.symbol), strategy: String(r.strategy ?? ""), timeframe: String(r.timeframe ?? "swing"), status: String(r.status ?? ""),
      brief: (r.brief as Record<string, unknown>) ?? {}, votes: Array.isArray(r.votes) ? (r.votes as SitRow["votes"]) : [], decision: (r.decision as Record<string, unknown>) ?? {},
      trade_id: r.trade_id ? String(r.trade_id) : null, cost_usd: n(r.cost_usd), error: String(r.error ?? ""), created_at: String(r.created_at ?? ""), updated_at: String(r.updated_at ?? ""),
    })),
    error: "",
  };
}

/* ── strategy ratings: written by desk-review when a strategy's shadow trade closes ── */
export type StrategyRow = {
  id: string; enabled: boolean; size_mult: number; benched_until: string | null;
  stats: { n?: number; wins?: number; hit?: number | null; mean_r?: number; shrunk_r?: number; recent_r?: number; label?: string; as_of?: string }; updated_at: string;
};
export async function loadStrategies(uid: string): Promise<{ strategies: StrategyRow[]; error: string }> {
  const { data, error } = await supabase.from("desk_strategies").select("*").eq("user_id", uid);
  if (error) return { strategies: [], error: "Couldn't load the strategy ratings." };
  return {
    strategies: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), enabled: r.enabled !== false, size_mult: n(r.size_mult, 1), benched_until: r.benched_until ? String(r.benched_until) : null,
      stats: (r.stats as StrategyRow["stats"]) ?? {}, updated_at: String(r.updated_at ?? ""),
    })),
    error: "",
  };
}

/* ── the juries behind a trade: what each model said when it was taken ──── */
export type SitVotes = { votes: SitRow["votes"]; decision: Record<string, unknown> };
export async function loadSitVotes(ids: string[]): Promise<{ votes: Record<string, SitVotes>; error: string }> {
  if (!ids.length) return { votes: {}, error: "" };
  const { data, error } = await supabase.from("desk_sits").select("id,votes,decision").in("id", ids.slice(0, 200));
  if (error) return { votes: {}, error: "Couldn't load the juries." };
  const out: Record<string, SitVotes> = {};
  for (const r of (data ?? []) as Record<string, unknown>[]) out[String(r.id)] = { votes: Array.isArray(r.votes) ? (r.votes as SitRow["votes"]) : [], decision: (r.decision as Record<string, unknown>) ?? {} };
  return { votes: out, error: "" };
}

/* ── phase 7: the leagues ─────────────────────────────────────────────── */
// A team is one frontier that decides plus the crew every team shares. `combo` is the team's
// key (the frontier and which of its lives this is). `seniors` only exists on rows from before
// the crew was shared; nothing renders it.
export type TeamRow = {
  id: string; name: string; frontier: string; workers: string[]; seniors: string[]; combo: string; tier: Tier; status: "live" | "dead"; season: number;
  formed_at: string; died_at: string | null; death_reason: string; start_equity: number; equity: number; peak: number; return_pct: number; marked_at: string | null;
  stats: Record<string, unknown>;
};
function toTeam(x: Record<string, unknown>): TeamRow {
  return {
    id: String(x.id), name: String(x.name ?? ""), frontier: String(x.frontier ?? ""), workers: Array.isArray(x.workers) ? (x.workers as string[]) : [], seniors: Array.isArray(x.seniors) ? (x.seniors as string[]) : [],
    combo: String(x.combo ?? ""), tier: (x.tier as Tier) ?? "bronze", status: x.status === "dead" ? "dead" : "live", season: n(x.season, 1), formed_at: String(x.formed_at ?? ""),
    died_at: x.died_at ? String(x.died_at) : null, death_reason: String(x.death_reason ?? ""), start_equity: n(x.start_equity, 100000), equity: n(x.equity, 100000), peak: n(x.peak, 100000),
    return_pct: n(x.return_pct), marked_at: x.marked_at ? String(x.marked_at) : null, stats: (x.stats as Record<string, unknown>) ?? {},
  };
}
export async function loadTeams(uid: string, opts: { status?: "live" | "dead"; limit?: number } = {}): Promise<{ teams: TeamRow[]; error: string }> {
  let q = supabase.from("desk_teams").select("*").eq("user_id", uid).order("formed_at", { ascending: true }).limit(opts.limit ?? 200);
  if (opts.status) q = q.eq("status", opts.status);
  const { data, error } = await q;
  if (error) return { teams: [], error: "Couldn't load the teams." };
  return { teams: ((data ?? []) as Record<string, unknown>[]).map(toTeam), error: "" };
}

export type Ballot = {
  model: string; role: "worker" | "frontier"; stance: "take" | "pass"; confidence: number; thesis: string; wrong_if: string;
  stop: number | null; target: number | null; leverage: number | null; tags: string[]; checked: string[]; error: string; cost_usd: number; latency_ms: number;
};
export type TeamVerdict = { action: "take" | "pass" | "close" | "tighten" | "hold"; reason: string; risk_pct?: number; leverage?: number; stop?: number; target?: number; model: string; error?: string; acting?: boolean };
export type DecisionKind = "candidate" | "session" | "close";
// A headline as the league function keeps it inside a decision's brief (`headline_items`, `macro_items` on a
// candidate, `digest_items` on a session). Older rows only hold the one-line strings `headlines`, `macro`, `digest`.
export type BriefNewsItem = { title: string; plain: string; why: string; impact: number; direction: string; category: string; published: string; tickers: string[]; source?: string };
export type DecisionRow = {
  id: string; team_id: string; kind: DecisionKind; setup_id: string | null; symbol: string; strategy: string; timeframe: string; status: "launched" | "done" | "failed";
  brief: Record<string, unknown>; ballots: Ballot[]; verdict: TeamVerdict | null; outcome: Record<string, unknown> | null; cost_usd: number; created_at: string; updated_at: string;
};
function toBallot(b: Record<string, unknown>): Ballot {
  return {
    model: String(b.model ?? ""), role: b.role === "frontier" ? "frontier" : "worker", stance: b.stance === "take" ? "take" : "pass", confidence: n(b.confidence, 0.5),
    thesis: String(b.thesis ?? ""), wrong_if: String(b.wrong_if ?? b.what_would_prove_me_wrong ?? ""), stop: nul(b.stop), target: nul(b.target), leverage: nul(b.leverage),
    tags: Array.isArray(b.tags) ? (b.tags as string[]) : [], checked: Array.isArray(b.checked) ? (b.checked as string[]) : [], error: String(b.error ?? ""), cost_usd: n(b.cost_usd), latency_ms: n(b.latency_ms),
  };
}
function toDecision(x: Record<string, unknown>): DecisionRow {
  return {
    id: String(x.id), team_id: String(x.team_id), kind: (x.kind as DecisionKind) ?? "candidate", setup_id: x.setup_id ? String(x.setup_id) : null, symbol: String(x.symbol ?? ""),
    strategy: String(x.strategy ?? ""), timeframe: String(x.timeframe ?? ""), status: (x.status as DecisionRow["status"]) ?? "done", brief: (x.brief as Record<string, unknown>) ?? {},
    ballots: Array.isArray(x.ballots) ? (x.ballots as Record<string, unknown>[]).map(toBallot) : [], verdict: (x.verdict as TeamVerdict | null) ?? null,
    outcome: (x.outcome as Record<string, unknown> | null) ?? null, cost_usd: n(x.cost_usd), created_at: String(x.created_at ?? ""), updated_at: String(x.updated_at ?? ""),
  };
}
export async function loadDecisions(uid: string, opts: { teamId?: string; setupId?: string; kind?: DecisionKind; sinceHours?: number; limit?: number; symbol?: string } = {}): Promise<{ decisions: DecisionRow[]; error: string }> {
  let q = supabase.from("desk_decisions").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(opts.limit ?? 200);
  if (opts.teamId) q = q.eq("team_id", opts.teamId);
  if (opts.setupId) q = q.eq("setup_id", opts.setupId);
  if (opts.kind) q = q.eq("kind", opts.kind);
  if (opts.symbol) q = q.eq("symbol", opts.symbol);
  if (opts.sinceHours) q = q.gte("created_at", new Date(Date.now() - opts.sinceHours * 3_600_000).toISOString());
  const { data, error } = await q;
  if (error) return { decisions: [], error: "Couldn't load the decisions." };
  return { decisions: ((data ?? []) as Record<string, unknown>[]).map(toDecision), error: "" };
}

export type SeasonRow = { id: string; n: number; start_day: string; end_day: string; champion_team: string | null; status: "running" | "done" };
export async function loadSeasons(uid: string): Promise<{ seasons: SeasonRow[]; error: string }> {
  const { data, error } = await supabase.from("desk_seasons").select("*").eq("user_id", uid).order("n", { ascending: false }).limit(20);
  if (error) return { seasons: [], error: "Couldn't load the seasons." };
  return { seasons: ((data ?? []) as Record<string, unknown>[]).map((x) => ({ id: String(x.id), n: n(x.n, 1), start_day: String(x.start_day), end_day: String(x.end_day), champion_team: x.champion_team ? String(x.champion_team) : null, status: x.status === "done" ? "done" : "running" })), error: "" };
}
