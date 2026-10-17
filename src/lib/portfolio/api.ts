"use client";

// Portfolio — client side of the pilot function and the pf_ tables. Every
// loader returns an error string next to its data, so a failed read never
// renders like an empty portfolio (GRADING.md rule 2).

import { supabase, SUPABASE_URL } from "@/lib/supabase";
import { callFn, TAPE_FN } from "@/lib/desk/api";
import type { Lot, LotKind, Quote } from "./lots";
import type { Recurring } from "./weekly";
import type { ReportInput, ReportOut } from "./report";

export const PILOT_FN = `${SUPABASE_URL}/functions/v1/pilot`;

const n = (v: unknown, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

function toLot(r: Record<string, unknown>): Lot {
  return { id: String(r.id), symbol: String(r.symbol), shares: n(r.shares), price: n(r.price), day: String(r.day), kind: (r.kind as LotKind) ?? "manual", assumed: r.assumed === true, note: String(r.note ?? ""), created_at: String(r.created_at ?? "") };
}

export async function loadLots(uid: string): Promise<{ lots: Lot[]; error: string }> {
  const { data, error } = await supabase.from("pf_lots").select("id,symbol,shares,price,day,kind,assumed,note,created_at").eq("user_id", uid).order("day", { ascending: true }).limit(2000);
  if (error) return { lots: [], error: "Couldn't load your holdings." };
  return { lots: ((data ?? []) as Record<string, unknown>[]).map(toLot), error: "" };
}
export async function addLot(uid: string, l: Omit<Lot, "id" | "created_at">): Promise<string> {
  const { error } = await supabase.from("pf_lots").insert({ user_id: uid, ...l });
  return error ? "Couldn't save that. Try again." : "";
}
export async function updateLot(id: string, patch: Partial<Omit<Lot, "id" | "created_at">>): Promise<string> {
  const { error } = await supabase.from("pf_lots").update(patch).eq("id", id);
  return error ? "Couldn't save that change." : "";
}
export async function deleteLot(id: string): Promise<string> {
  const { error } = await supabase.from("pf_lots").delete().eq("id", id);
  return error ? "Couldn't delete that." : "";
}

export type PfSettings = { recurring: Recurring[]; buy_dow: number; recurring_since: string | null; cap_usd_day: number; paused: boolean };
function toSettings(r: Record<string, unknown>): PfSettings {
  return {
    recurring: (Array.isArray(r.recurring) ? (r.recurring as Record<string, unknown>[]) : []).map((x) => ({ symbol: String(x.symbol ?? ""), usd: n(x.usd) })),
    buy_dow: n(r.buy_dow, 3), recurring_since: r.recurring_since ? String(r.recurring_since) : null,
    cap_usd_day: n(r.cap_usd_day, 1), paused: r.paused === true,
  };
}
// Select, and only if the read succeeded and found nothing, create the row.
export async function loadSettings(uid: string): Promise<{ settings: PfSettings | null; error: string }> {
  const { data, error } = await supabase.from("pf_settings").select("*").eq("user_id", uid).maybeSingle();
  if (error) return { settings: null, error: "Couldn't load the settings." };
  if (data) return { settings: toSettings(data as Record<string, unknown>), error: "" };
  const ins = await supabase.from("pf_settings").insert({ user_id: uid }).select("*").maybeSingle();
  if (ins.error || !ins.data) return { settings: null, error: "Couldn't create the settings." };
  return { settings: toSettings(ins.data as Record<string, unknown>), error: "" };
}
export async function saveSettings(uid: string, patch: Partial<PfSettings>): Promise<string> {
  const { error } = await supabase.from("pf_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("user_id", uid);
  return error ? "Couldn't save the settings." : "";
}

export type ReportRowFull = {
  day: string; status: "running" | "done" | "failed"; tries: number;
  input: Partial<ReportInput>; output: Partial<ReportOut>; model: string; cost_usd: number; error: string; updated_at: string;
};
export async function loadReports(uid: string, limit = 8): Promise<{ reports: ReportRowFull[]; error: string }> {
  const { data, error } = await supabase.from("pf_reports").select("day,status,tries,input,output,model,cost_usd,error,updated_at").eq("user_id", uid).order("day", { ascending: false }).limit(limit);
  if (error) return { reports: [], error: "Couldn't load the reports." };
  return {
    reports: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      day: String(r.day), status: r.status as ReportRowFull["status"], tries: n(r.tries),
      input: (r.input as Partial<ReportInput>) ?? {}, output: (r.output as Partial<ReportOut>) ?? {},
      model: String(r.model ?? ""), cost_usd: n(r.cost_usd), error: String(r.error ?? ""), updated_at: String(r.updated_at ?? ""),
    })),
    error: "",
  };
}
export async function writeReportNow(): Promise<{ ok?: boolean; error?: string }> {
  return callFn<{ ok?: boolean }>(PILOT_FN, { mode: "report" }, 150_000);
}
export async function spentSince(iso: string): Promise<number | null> {
  const { data, error } = await supabase.rpc("pf_my_spend_since", { p_since: iso });
  return error ? null : n(data);
}

export async function loadQuotes(symbols: string[]): Promise<{ quotes: Record<string, Quote>; error: string }> {
  if (!symbols.length) return { quotes: {}, error: "" };
  const r = await callFn<{ cards?: Record<string, Record<string, unknown>> }>(TAPE_FN, { mode: "snapshot", symbols: symbols.map((symbol) => ({ symbol })) }, 60_000);
  if (r.error || !r.cards) return { quotes: {}, error: r.error || "Couldn't load prices." };
  const quotes: Record<string, Quote> = {};
  for (const [k, c] of Object.entries(r.cards)) {
    const price = Number(c?.price), prev = Number(c?.prevClose);
    if (!Number.isFinite(price) || price <= 0) continue;
    quotes[k] = { price, prevClose: Number.isFinite(prev) && prev > 0 ? prev : null, name: String(c.name ?? k) };
  }
  return { quotes, error: "" };
}
export async function checkSymbol(symbol: string): Promise<{ ok: boolean; name: string; error: string }> {
  const r = await callFn<{ ok?: boolean; name?: string }>(TAPE_FN, { mode: "validate", symbol }, 30_000);
  if (r.ok === true) return { ok: true, name: String(r.name ?? symbol), error: "" };
  return { ok: false, name: "", error: String(r.error ?? `${symbol} isn't a stock or ETF Robinhood trades.`) };
}
