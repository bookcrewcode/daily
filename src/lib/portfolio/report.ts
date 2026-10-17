// Portfolio — the morning report. Pure: the prompt, the answer's shape, the
// check on what the model sent back, and when a report is due.
// The numbers on screen come from the data, never from the model; the model
// only writes the plain-words summary, what to watch, and a line per holding.
// No blank lines inside template strings: the edge function's lib copy drops them.

import { addDays, etParts, isTradingDay, sessionBounds } from "../desk/clock";

export type ReportHolding = { symbol: string; name: string; price: number; ret1d: number; ret5d: number; shares: number; value: number; gainPct: number | null };
export type ReportNews = { symbols: string[]; title: string; plain: string; impact: number; direction: string; source: string; link: string; published: string };
export type ReportEvent = { day: string; time_et: string; kind: string; label: string; symbol: string };
export type ReportMarket = { label: string; level: number; change: number; unit: "pct" | "pts" };
export type ReportInput = { day: string; holdings: ReportHolding[]; news: ReportNews[]; macro: ReportNews[]; events: ReportEvent[]; market: ReportMarket[] };
export type ReportOut = { summary: string; watch: string[]; per_holding: { symbol: string; line: string }[] };
export type ReportRow = { status: "running" | "done" | "failed"; tries: number; updated_at: string };

export const REPORT_MODEL = "google/gemini-3.8-flash";
export const REPORT_FALLBACK = "google/gemini-3.5-flash-lite";
export const REPORT_ESTIMATE_USD = 0.03; // held back from the day's budget before a report call
export const MAX_TRIES = 3;

export const REPORT_SYSTEM = `You write Ben's morning report on his own stock portfolio. Ben is 19 and new to investing; he holds for years and buys every week, so he wants to understand what is happening, not to trade on it. Use ONLY the data given: never invent a price, a headline, a date or a number. Do not tell him to buy or sell anything. Write in plain words; any piece of market lingo gets a parenthesis with its meaning, for example "guidance (the company's own forecast)". No emojis.
Return JSON with:
- summary: at most 150 words. Start with how his holdings did and why, using the news given; then one or two sentences on the market backdrop.
- watch: one to three short items for today or the coming days, each tied to a dated event or a news item from the data.
- per_holding: one line per holding (at most 30 words) on what moved it or what is coming for it; if nothing in the data explains a move, say the move had no news behind it.`;

export const REPORT_SCHEMA = {
  name: "report", strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["summary", "watch", "per_holding"],
    properties: {
      summary: { type: "string" },
      watch: { type: "array", items: { type: "string" } },
      per_holding: { type: "array", items: { type: "object", additionalProperties: false, required: ["symbol", "line"], properties: { symbol: { type: "string" }, line: { type: "string" } } } },
    },
  },
};

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

export function reportPrompt(x: ReportInput): string {
  const lines: string[] = [`Date: ${x.day} (New York).`, "", "HOLDINGS"];
  for (const h of x.holdings) lines.push(`${h.symbol} (${h.name}): $${h.price.toFixed(2)}, ${pct(h.ret1d)} yesterday, ${pct(h.ret5d)} over 5 days; he holds ${h.shares} shares worth $${h.value.toFixed(0)}${h.gainPct === null ? "" : `, ${pct(h.gainPct)} against what he paid`}.`);
  lines.push("", "MARKET");
  for (const m of x.market) lines.push(`${m.label}: ${m.unit === "pts" ? `${m.level.toFixed(2)}%, ${m.change >= 0 ? "+" : ""}${m.change.toFixed(2)} points` : `${m.level.toFixed(2)}, ${pct(m.change)}`} yesterday.`);
  lines.push("", "NEWS ON HIS HOLDINGS (last 24 hours, most important first)");
  if (!x.news.length) lines.push("none");
  for (const n of x.news) lines.push(`[${n.symbols.join(", ")}] ${n.title} (${n.source}, impact ${n.impact} of 5, ${n.direction}). ${n.plain}`);
  lines.push("", "BIG ECONOMY AND MARKET NEWS (last 24 hours)");
  if (!x.macro.length) lines.push("none");
  for (const n of x.macro) lines.push(`${n.title} (${n.source}, impact ${n.impact} of 5). ${n.plain}`);
  lines.push("", "EVENTS IN THE NEXT TWO WEEKS");
  if (!x.events.length) lines.push("none");
  for (const e of x.events) lines.push(`${e.day}${e.time_et ? ` ${e.time_et} ET` : ""}: ${e.label}`);
  return lines.join("\n");
}

const clip = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function parseReport(raw: unknown, symbols: string[]): ReportOut | null {
  let j: unknown = raw;
  if (typeof raw === "string") { try { j = JSON.parse(raw); } catch { return null; } }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const summary = clip(o.summary, 1500);
  if (summary.length < 20) return null;
  const watch = (Array.isArray(o.watch) ? o.watch : []).map((w) => clip(w, 240)).filter(Boolean).slice(0, 3);
  const want = new Set(symbols.map((s) => s.toUpperCase()));
  const seen = new Set<string>();
  const per_holding: ReportOut["per_holding"] = [];
  for (const p of Array.isArray(o.per_holding) ? o.per_holding : []) {
    const r = (p ?? {}) as Record<string, unknown>;
    const symbol = clip(r.symbol, 14).toUpperCase();
    const line = clip(r.line, 300);
    if (!want.has(symbol) || seen.has(symbol) || !line) continue;
    seen.add(symbol);
    per_holding.push({ symbol, line });
  }
  return { summary, watch, per_holding };
}

export function reportDue(nowMs: number, row: ReportRow | null, staleMs = 5 * 60_000): boolean {
  if (!row) return true;
  if (row.tries >= MAX_TRIES) return false;
  if (row.status === "failed") return true;
  if (row.status === "running") return nowMs - Date.parse(row.updated_at) > staleMs;
  return false;
}

// A tagged headline (a desk_news row) as report news: it belongs to every holding it names,
// and a crypto holding like BTC-USD matches its coin, BTC.
export function toNews(r: Record<string, unknown>, held: string[]): ReportNews {
  const tickers = Array.isArray(r.tickers) ? (r.tickers as unknown[]).map(String) : [];
  const n = (v: unknown, d: number) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  return {
    symbols: held.filter((s) => tickers.includes(s) || (s.endsWith("-USD") && tickers.includes(s.slice(0, -4)))),
    title: String(r.title ?? "").slice(0, 220), plain: String(r.plain ?? "").slice(0, 400), impact: n(r.impact, 1),
    direction: String(r.direction ?? "none"), source: String(r.source ?? ""), link: String(r.link ?? ""), published: String(r.published ?? ""),
  };
}

// The news on Ben's holdings, matched here rather than in the query (desk_news.tickers is jsonb):
// rows come most important first; each holding gets at most perSymbol headlines, max in all.
export function pickNews(rows: Record<string, unknown>[], held: string[], perSymbol = 4, max = 12): ReportNews[] {
  const count = new Map<string, number>();
  const out: ReportNews[] = [];
  for (const r of rows) {
    const x = toNews(r, held);
    if (!x.symbols.length || x.symbols.every((s) => (count.get(s) ?? 0) >= perSymbol)) continue;
    x.symbols.forEach((s) => count.set(s, (count.get(s) ?? 0) + 1));
    out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

// Where the report's news starts: the close of the last session before today, or 24 hours back
// if that is earlier, so a Monday report covers the weekend.
export function newsSinceMs(nowMs: number): number {
  let d = addDays(etParts(nowMs).date, -1);
  for (let i = 0; i < 10 && !isTradingDay(d); i++) d = addDays(d, -1);
  const dayBack = nowMs - 24 * 3_600_000;
  return Math.min(dayBack, sessionBounds(d)?.closeMs ?? dayBack);
}
