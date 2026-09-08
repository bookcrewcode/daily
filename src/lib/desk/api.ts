"use client";

// The Desk — client side of the edge functions and the tables. Thin on
// purpose: every loader returns { data, error } shaped results so a failed
// read can never render like an empty state (GRADING.md rule 2).

import { supabase, SUPABASE_URL, SUPABASE_ANON } from "@/lib/supabase";
import type { PresetKey, Rules, Trade, TradeStatus } from "./types";
import type { Tally } from "./vote";

export const TAPE_FN = `${SUPABASE_URL}/functions/v1/tape`;
export const DESK_FN = `${SUPABASE_URL}/functions/v1/desk`;
export const SYNC_FN = `${SUPABASE_URL}/functions/v1/desk-sync`;
export const REVIEW_FN = `${SUPABASE_URL}/functions/v1/desk-review`;

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
  };
}

export async function loadTrades(uid: string, opts: { owner?: string; status?: TradeStatus[]; limit?: number; sessionId?: string } = {}): Promise<{ trades: Trade[]; error: string }> {
  let q = supabase.from("desk_trades").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(opts.limit ?? 200);
  if (opts.owner) q = q.eq("owner", opts.owner);
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
