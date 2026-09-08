// tape — the Desk's market data and technicals. One door for every price the
// jury or the ledger ever sees, so a source that changes breaks in one place.
//
// Sources (all verified from inside Supabase's network on 2026-09-07):
//   stocks/ETFs/spot crypto  Yahoo Finance v8 chart (keyless; unofficial, so
//                            daily bars are cached in desk_bars and a failure
//                            is reported, never a silent zero)
//   crypto spot fallback     Coinbase Exchange public candles/ticker
//   crypto perpetuals        BloFin public market API (instruments, tickers,
//                            candles, funding) — what Ben actually trades
//   scheduled events         desk_calendar (seeded) + Nasdaq earnings calendar
//
// verify_jwt=false at the gateway; callers are checked here: Ben's JWT, the
// cron's own vault secret (desk_cron_secret), or the service role from a
// sibling function.

import type { Bar, Instrument, InstrumentMeta, TapeCard, Venue } from "./lib/types.ts";
import { baseOf, instrumentOf } from "./lib/types.ts";
import { etDate, etParts, isTradingDay, sessionBounds } from "./lib/clock.ts";
import { buildCard } from "./lib/ta.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};
const CONTEXT: { symbol: string; venue: Venue; instrument: Instrument }[] = [
  ...["SPY", "QQQ", "IWM", "TLT", "GLD", "USO", "XLE", "XLF", "SMH"].map((s) => ({ symbol: s, venue: "robinhood" as Venue, instrument: "etf" as Instrument })),
  { symbol: "^VIX", venue: "robinhood", instrument: "etf" },
  { symbol: "BTC-USD", venue: "robinhood", instrument: "crypto_spot" },
  { symbol: "ETH-USD", venue: "robinhood", instrument: "crypto_spot" },
];
const US_EXCHANGES = new Set(["NYQ", "NMS", "NGM", "NCM", "PCX", "ASE", "BTS", "NYS", "NAS", "CXI"]);

type J = Record<string, unknown>;
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

async function getJson(url: string, headers: Record<string, string> = {}, ms = 12000): Promise<{ ok: boolean; status: number; json: J | J[] | null; text: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { ...UA, ...headers }, signal: ctl.signal, redirect: "follow" });
    const text = await r.text();
    let json: J | J[] | null = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: r.ok, status: r.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: e instanceof Error ? e.message : String(e) };
  } finally { clearTimeout(t); }
}

async function rest(path: string, init?: RequestInit): Promise<{ ok: boolean; json: unknown; status: number }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...svcH, ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) console.error(`[tape] rest ${r.status} ${path} ${text.slice(0, 200)}`);
  return { ok: r.ok, json, status: r.status };
}

async function secret(name: string): Promise<string> {
  const r = await rest("rpc/get_secret", { method: "POST", body: JSON.stringify({ secret_name: name }) });
  return r.ok && typeof r.json === "string" ? r.json : "";
}

/* ── Yahoo ─────────────────────────────────────────────────────────────── */
type YMeta = { name: string; instrumentType: string; currency: string; exchange: string; price: number; volume: number; at: number };
async function yahooChart(symbol: string, range: string, interval: string): Promise<{ bars: Bar[]; meta: YMeta } | { error: string }> {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const r = await getJson(u);
  const res = ((r.json as J)?.chart as J)?.result as J[] | undefined;
  if (!r.ok || !res?.[0]) {
    const err = (((r.json as J)?.chart as J)?.error as J)?.description;
    return { error: typeof err === "string" ? err : `yahoo ${r.status || "unreachable"}` };
  }
  const c = res[0];
  const m = (c.meta ?? {}) as J;
  const ts = (c.timestamp ?? []) as number[];
  const q = (((c.indicators as J)?.quote as J[]) ?? [])[0] ?? {};
  const o = (q.open ?? []) as (number | null)[], h = (q.high ?? []) as (number | null)[], l = (q.low ?? []) as (number | null)[], cl = (q.close ?? []) as (number | null)[], v = (q.volume ?? []) as (number | null)[];
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (cl[i] == null || o[i] == null || h[i] == null || l[i] == null) continue;
    bars.push({ t: ts[i] * 1000, o: o[i] as number, h: h[i] as number, l: l[i] as number, c: cl[i] as number, v: (v[i] ?? 0) as number });
  }
  return {
    bars,
    meta: {
      name: String(m.longName ?? m.shortName ?? symbol), instrumentType: String(m.instrumentType ?? ""), currency: String(m.currency ?? ""),
      exchange: String(m.exchangeName ?? ""), price: num(m.regularMarketPrice), volume: num(m.regularMarketVolume), at: num(m.regularMarketTime) * 1000,
    },
  };
}
async function yahooSector(symbol: string): Promise<string> {
  const r = await getJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=6&newsCount=0`, {}, 8000);
  const qs = ((r.json as J)?.quotes ?? []) as J[];
  const hit = qs.find((x) => String(x.symbol) === symbol);
  return String(hit?.sector ?? hit?.sectorDisp ?? "");
}

/* ── Coinbase (spot) ───────────────────────────────────────────────────── */
async function coinbaseCandles(product: string, granularity: 3600 | 86400): Promise<Bar[]> {
  const r = await getJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=${granularity}`);
  if (!r.ok || !Array.isArray(r.json)) return [];
  return (r.json as unknown as number[][]).map((row) => ({ t: row[0] * 1000, l: row[1], h: row[2], o: row[3], c: row[4], v: row[5] })).sort((a, b) => a.t - b.t);
}
async function coinbaseTicker(product: string): Promise<{ price: number; at: number } | null> {
  const r = await getJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/ticker`, {}, 8000);
  const p = num((r.json as J)?.price);
  return r.ok && Number.isFinite(p) ? { price: p, at: Date.parse(String((r.json as J)?.time ?? "")) || Date.now() } : null;
}

/* ── BloFin (perps) ────────────────────────────────────────────────────── */
const BLO = "https://openapi.blofin.com/api/v1/market";
async function blofinCandles(instId: string, bar: "1H" | "1D", limit: number): Promise<Bar[]> {
  const r = await getJson(`${BLO}/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`);
  const rows = ((r.json as J)?.data ?? []) as string[][];
  if (!r.ok || !Array.isArray(rows)) return [];
  return rows.map((x) => ({ t: num(x[0]), o: num(x[1]), h: num(x[2]), l: num(x[3]), c: num(x[4]), v: num(x[6]) }))
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c)).sort((a, b) => a.t - b.t);
}
type Ticker = { last: number; bid: number; ask: number; open24h: number; vol24hUsd: number; at: number };
async function blofinTickers(): Promise<Record<string, Ticker>> {
  const r = await getJson(`${BLO}/tickers?instType=SWAP`);
  const out: Record<string, Ticker> = {};
  for (const x of (((r.json as J)?.data ?? []) as J[])) {
    const last = num(x.last);
    out[String(x.instId)] = { last, bid: num(x.bidPrice), ask: num(x.askPrice), open24h: num(x.open24h), vol24hUsd: num(x.volCurrency24h) * last, at: num(x.ts) };
  }
  return out;
}
type Inst = { inst_id: string; base: string; quote: string; max_leverage: number; contract_value: number; lot_size: number; tick_size: number; state: string };
async function blofinInstruments(): Promise<Inst[]> {
  const r = await getJson(`${BLO}/instruments?instType=SWAP`, {}, 15000);
  return (((r.json as J)?.data ?? []) as J[])
    .filter((x) => x.quoteCurrency === "USDT" && x.contractType === "linear" && x.state === "live")
    .map((x) => ({ inst_id: String(x.instId), base: String(x.baseCurrency), quote: "USDT", max_leverage: Math.max(1, Math.floor(num(x.maxLeverage)) || 1), contract_value: num(x.contractValue) || 1, lot_size: num(x.lotSize) || 1, tick_size: num(x.tickSize) || 0.01, state: "live" }));
}
async function blofinFunding(instId: string): Promise<number | null> {
  const r = await getJson(`${BLO}/funding-rate?instId=${encodeURIComponent(instId)}`, {}, 8000);
  const rate = num((((r.json as J)?.data ?? []) as J[])[0]?.fundingRate);
  return Number.isFinite(rate) ? rate : null;
}

/* ── Nasdaq earnings (best effort) ─────────────────────────────────────── */
async function nasdaqEarnings(date: string): Promise<{ symbol: string; time: string }[]> {
  const r = await getJson(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, {}, 8000);
  const rows = (((r.json as J)?.data as J)?.rows ?? []) as J[];
  return Array.isArray(rows) ? rows.map((x) => ({ symbol: String(x.symbol ?? "").toUpperCase(), time: String(x.time ?? "") })) : [];
}

/* ── instruments cache ─────────────────────────────────────────────────── */
async function instrumentRows(): Promise<Record<string, Inst & { vol_24h_usd: number; last: number | null }>> {
  const r = await rest("desk_instruments?select=*&limit=1000");
  const out: Record<string, Inst & { vol_24h_usd: number; last: number | null }> = {};
  for (const x of ((r.ok ? r.json : []) as J[])) out[String(x.inst_id)] = { inst_id: String(x.inst_id), base: String(x.base), quote: String(x.quote), max_leverage: num(x.max_leverage), contract_value: num(x.contract_value), lot_size: num(x.lot_size), tick_size: num(x.tick_size), state: String(x.state), vol_24h_usd: num(x.vol_24h_usd) || 0, last: x.last == null ? null : num(x.last) };
  return out;
}
async function refreshInstruments(): Promise<number> {
  const [list, tickers] = await Promise.all([blofinInstruments(), blofinTickers()]);
  if (!list.length) return 0;
  const rows = list.map((i) => ({ ...i, vol_24h_usd: tickers[i.inst_id]?.vol24hUsd || 0, last: tickers[i.inst_id]?.last ?? null, updated_at: new Date().toISOString() }));
  for (let i = 0; i < rows.length; i += 200) {
    const r = await rest("desk_instruments?on_conflict=inst_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows.slice(i, i + 200)) });
    if (!r.ok) return i;
  }
  return rows.length;
}

/* ── daily bars with cache ─────────────────────────────────────────────── */
const barDay = (t: number, instrument: Instrument) => (instrument === "stock" || instrument === "etf" ? etDate(t) : new Date(t).toISOString().slice(0, 10));

async function dailyBars(symbol: string, instrument: Instrument): Promise<{ bars: Bar[]; source: string; meta?: YMeta; error?: string }> {
  if (instrument === "crypto_perp") {
    const bars = await blofinCandles(symbol, "1D", 400);
    return bars.length ? { bars, source: "blofin" } : { bars: [], source: "blofin", error: `no daily candles for ${symbol}` };
  }
  const cachedR = await rest(`desk_bars?symbol=eq.${encodeURIComponent(symbol)}&select=day,o,h,l,c,v&order=day.asc&limit=400`);
  const cached = (cachedR.ok ? (cachedR.json as J[]) : []).map((x) => ({ day: String(x.day), o: num(x.o), h: num(x.h), l: num(x.l), c: num(x.c), v: num(x.v) }));
  const cold = cached.length < 200;
  const live = await yahooChart(symbol, cold ? "1y" : "5d", "1d");
  if ("error" in live) {
    if (instrument === "crypto_spot") {
      const cb = await coinbaseCandles(symbol, 86400);
      if (cb.length) return { bars: cb, source: "coinbase" };
    }
    if (cached.length >= 60) return { bars: cached.map((x) => ({ t: Date.parse(x.day + "T12:00:00Z"), o: x.o, h: x.h, l: x.l, c: x.c, v: x.v })), source: "cache-stale", error: live.error };
    return { bars: [], source: "yahoo", error: live.error };
  }
  const nowMs = Date.now();
  const today = instrument === "crypto_spot" ? new Date(nowMs).toISOString().slice(0, 10) : etDate(nowMs);
  const closeMs = sessionBounds(etDate(nowMs))?.closeMs ?? 0;
  const finalDay = (day: string) => day < today || (day === today && instrument !== "crypto_spot" && closeMs > 0 && nowMs > closeMs + 15 * 60_000);
  const liveByDay = new Map(live.bars.map((b) => [barDay(b.t, instrument), b]));
  const firstLive = live.bars.length ? barDay(live.bars[0].t, instrument) : today;
  const merged: Bar[] = cached.filter((x) => x.day < firstLive).map((x) => ({ t: Date.parse(x.day + "T12:00:00Z"), o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }));
  for (const [, b] of liveByDay) merged.push(b);
  merged.sort((a, b) => a.t - b.t);
  const toCache = live.bars.filter((b) => finalDay(barDay(b.t, instrument))).map((b) => ({ symbol, day: barDay(b.t, instrument), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, source: "yahoo" }));
  if (toCache.length) await rest("desk_bars?on_conflict=symbol,day", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(toCache) });
  return { bars: merged, source: cold ? "yahoo-1y" : "yahoo+cache", meta: live.meta };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

type Sym = { symbol: string; venue: Venue; instrument?: Instrument };
const normSym = (x: J): Sym | null => {
  const symbol = String(x.symbol ?? "").trim().toUpperCase();
  const venue = x.venue === "blofin" ? "blofin" : "robinhood";
  if (!/^[\^A-Z0-9.\-]{1,14}$/.test(symbol)) return null;
  return { symbol, venue, instrument: (x.instrument as Instrument | undefined) ?? instrumentOf(symbol, venue) };
};

async function snapshot(list: Sym[]): Promise<{ cards: Record<string, TapeCard | { error: string }>; spy: TapeCard | null }> {
  const spyR = await dailyBars("SPY", "etf");
  const spyBars = spyR.bars;
  const insts = list.some((s) => s.venue === "blofin") ? await instrumentRows() : {};
  const cards: Record<string, TapeCard | { error: string }> = {};
  await mapLimit(list, 6, async (s) => {
    const instrument = s.instrument ?? instrumentOf(s.symbol, s.venue);
    const r = await dailyBars(s.symbol, instrument);
    if (!r.bars.length) { cards[s.symbol] = { error: r.error ?? "no bars" }; return; }
    let extra: { funding?: number; vol24hUsd?: number; maxLeverage?: number } | undefined;
    let name = r.meta?.name ?? s.symbol;
    if (instrument === "crypto_perp") {
      const inst = insts[s.symbol];
      const funding = await blofinFunding(s.symbol);
      extra = { ...(funding !== null ? { funding } : {}), ...(inst ? { vol24hUsd: inst.vol_24h_usd, maxLeverage: inst.max_leverage } : {}) };
      name = `${baseOf(s.symbol)} perpetual (BloFin)`;
    }
    cards[s.symbol] = buildCard({ symbol: s.symbol, venue: s.venue, instrument, name, bars: r.bars, spyBars: s.symbol === "SPY" ? undefined : spyBars, extra });
  });
  const spy = spyBars.length ? buildCard({ symbol: "SPY", venue: "robinhood", instrument: "etf", name: "SPDR S&P 500", bars: spyBars }) : null;
  return { cards, spy };
}

function regimeOf(cards: Record<string, TapeCard | { error: string }>): string {
  const spy = cards["SPY"] as TapeCard | undefined, vix = cards["^VIX"] as TapeCard | undefined;
  const a = spy && "price" in spy && spy.sma200 !== null ? (spy.price >= spy.sma200 ? "spy_above_200" : "spy_below_200") : "spy_unknown";
  const b = vix && "price" in vix ? (vix.price < 15 ? "vix_low" : vix.price <= 25 ? "vix_mid" : "vix_high") : "vix_unknown";
  return `${a} · ${b}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, extra?: J) => ok({ error: m, ...(extra ?? {}) });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const body = (await req.json().catch(() => ({}))) as J;
    const mode = String(body.mode ?? "");

    let uid = "";
    const cronSecret = String(body.cronSecret ?? "");
    if (cronSecret) { const want = await secret("desk_cron_secret"); if (want.length > 20 && want === cronSecret) uid = String(body.userId ?? ""); }
    if (!uid && token && SERVICE_KEY && token === SERVICE_KEY) uid = String(body.userId ?? "service");
    if (!uid && token) {
      try { const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }); if (r.ok) uid = String((await r.json())?.id ?? ""); } catch { /* 401 below */ }
    }
    if (!uid) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

    if (mode === "snapshot") {
      const list = ((body.symbols ?? []) as J[]).map(normSym).filter((s): s is Sym => !!s).slice(0, 60);
      if (!list.length) return err("No symbols.");
      return ok(await snapshot(list));
    }
    if (mode === "context") {
      const { cards } = await snapshot(CONTEXT);
      return ok({ cards: CONTEXT.map((c) => cards[c.symbol]).filter((c) => c && "price" in c), regime: regimeOf(cards) });
    }
    if (mode === "movers") {
      let insts = await instrumentRows();
      if (!Object.keys(insts).length) { await refreshInstruments(); insts = await instrumentRows(); }
      const tickers = await blofinTickers();
      const rows = Object.values(insts).map((i) => {
        const t = tickers[i.inst_id];
        const last = t?.last ?? i.last ?? 0;
        return { inst_id: i.inst_id, last, change24h: t && t.open24h > 0 ? last / t.open24h - 1 : 0, vol24hUsd: t?.vol24hUsd ?? i.vol_24h_usd, maxLeverage: i.max_leverage };
      }).filter((r) => r.last > 0);
      const volume = [...rows].sort((a, b) => b.vol24hUsd - a.vol24hUsd).slice(0, 15);
      const movers = rows.filter((r) => r.vol24hUsd >= 5_000_000).sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 10);
      return ok({ volume, movers });
    }
    if (mode === "bars") {
      const s = normSym(body);
      if (!s) return err("Bad symbol.");
      const interval = String(body.interval ?? "1d");
      const instrument = s.instrument!;
      if (interval === "5m") {
        const r = await yahooChart(s.symbol, String(body.range ?? "1d"), "5m");
        return "error" in r ? err(r.error) : ok({ bars: r.bars, source: "yahoo" });
      }
      if (interval === "1h") {
        const bars = instrument === "crypto_perp" ? await blofinCandles(s.symbol, "1H", Math.min(300, Number(body.limit) || 48)) : instrument === "crypto_spot" ? await coinbaseCandles(s.symbol, 3600) : (await (async () => { const r = await yahooChart(s.symbol, "5d", "60m"); return "error" in r ? [] : r.bars; })());
        return bars.length ? ok({ bars, source: instrument === "crypto_perp" ? "blofin" : instrument === "crypto_spot" ? "coinbase" : "yahoo" }) : err(`no hourly bars for ${s.symbol}`);
      }
      const r = await dailyBars(s.symbol, instrument);
      return r.bars.length ? ok({ bars: r.bars, source: r.source, ...(r.error ? { warning: r.error } : {}) }) : err(r.error ?? "no bars");
    }
    if (mode === "quotes") {
      const list = ((body.symbols ?? []) as J[]).map(normSym).filter((s): s is Sym => !!s).slice(0, 80);
      const quotes: Record<string, { price: number; at: number; source: string } | { error: string }> = {};
      const perps = list.filter((s) => s.instrument === "crypto_perp");
      if (perps.length) {
        const t = await blofinTickers();
        for (const p of perps) quotes[p.symbol] = t[p.symbol] ? { price: t[p.symbol].last, at: t[p.symbol].at, source: "blofin" } : { error: "no ticker" };
      }
      await mapLimit(list.filter((s) => s.instrument !== "crypto_perp"), 8, async (s) => {
        const r = await yahooChart(s.symbol, "1d", "1d");
        if (!("error" in r) && Number.isFinite(r.meta.price)) { quotes[s.symbol] = { price: r.meta.price, at: r.meta.at || Date.now(), source: "yahoo" }; return; }
        if (s.instrument === "crypto_spot") { const cb = await coinbaseTicker(s.symbol); if (cb) { quotes[s.symbol] = { ...cb, source: "coinbase" }; return; } }
        quotes[s.symbol] = { error: "error" in r ? r.error : "no price" };
      });
      return ok({ quotes });
    }
    if (mode === "calendar") {
      const days = Math.min(30, Math.max(1, Number(body.days) || 7));
      const today = etDate(Date.now());
      const end = new Date(Date.parse(today + "T12:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
      const r = await rest(`desk_calendar?select=day,time_et,kind,label,symbol&day=gte.${today}&day=lte.${end}&order=day.asc`);
      const events = ((r.ok ? r.json : []) as J[]).map((x) => ({ day: String(x.day), time_et: String(x.time_et), kind: String(x.kind), label: String(x.label), symbol: String(x.symbol ?? "") }));
      const want = new Set(((body.symbols ?? []) as unknown[]).map((s) => String(s).toUpperCase()));
      if (want.size) {
        const dates: string[] = [];
        for (let d = today; d <= end && dates.length < 10; d = new Date(Date.parse(d + "T12:00:00Z") + 86_400_000).toISOString().slice(0, 10)) if (isTradingDay(d)) dates.push(d);
        const lists = await mapLimit(dates, 3, nasdaqEarnings);
        lists.forEach((rows, i) => rows.filter((x) => want.has(x.symbol)).forEach((x) => events.push({ day: dates[i], time_et: x.time.includes("pre") ? "07:00" : x.time.includes("after") ? "16:30" : "", kind: "earnings", label: `${x.symbol} earnings`, symbol: x.symbol })));
      }
      events.sort((a, b) => a.day.localeCompare(b.day) || a.time_et.localeCompare(b.time_et));
      return ok({ events, asOf: today });
    }
    if (mode === "validate") {
      const s = normSym(body);
      if (!s) return err("That is not a symbol.");
      if (s.venue === "blofin") {
        let insts = await instrumentRows();
        if (!insts[s.symbol]) { await refreshInstruments(); insts = await instrumentRows(); }
        const i = insts[s.symbol];
        if (!i) return ok({ ok: false, error: `${s.symbol} is not a live USDT perpetual on BloFin` });
        const meta: InstrumentMeta = { max_leverage: i.max_leverage, contract_value: i.contract_value, lot_size: i.lot_size, tick_size: i.tick_size };
        return ok({ ok: true, venue: "blofin", instrument: "crypto_perp", symbol: s.symbol, name: `${i.base} perpetual (BloFin)`, exchange: "BloFin", sector: "crypto", meta, largeCap: i.vol_24h_usd >= 50_000_000 });
      }
      if (s.instrument === "crypto_spot") {
        const cb = await coinbaseTicker(s.symbol);
        if (!cb) return ok({ ok: false, error: `${s.symbol} is not a Coinbase spot product` });
        return ok({ ok: true, venue: "robinhood", instrument: "crypto_spot", symbol: s.symbol, name: `${baseOf(s.symbol)} spot`, exchange: "Coinbase", sector: "crypto", meta: { max_leverage: 1, contract_value: 1, lot_size: 1, tick_size: 0.01 }, largeCap: true });
      }
      const r = await yahooChart(s.symbol, "5d", "1d");
      if ("error" in r) return ok({ ok: false, error: `${s.symbol}: ${r.error}` });
      const m = r.meta;
      const typeOk = m.instrumentType === "EQUITY" || m.instrumentType === "ETF";
      const exOk = US_EXCHANGES.has(m.exchange);
      if (!typeOk || m.currency !== "USD" || !exOk) return ok({ ok: false, error: `${s.symbol} is not a US-listed stock or ETF (${m.instrumentType || "?"}, ${m.exchange || "?"}, ${m.currency || "?"})` });
      const sector = m.instrumentType === "ETF" ? "etf" : await yahooSector(s.symbol);
      return ok({ ok: true, venue: "robinhood", instrument: m.instrumentType === "ETF" ? "etf" : "stock", symbol: s.symbol, name: m.name, exchange: m.exchange, sector, meta: { max_leverage: 1, contract_value: 1, lot_size: 1, tick_size: 0.01 }, largeCap: Number.isFinite(m.volume) && Number.isFinite(m.price) && m.volume * m.price >= 50_000_000 });
    }
    if (mode === "instruments") return ok({ count: await refreshInstruments() });
    if (mode === "funding") {
      const rates: Record<string, number> = {};
      await mapLimit(((body.symbols ?? []) as unknown[]).map(String).slice(0, 40), 6, async (s) => { const f = await blofinFunding(s); if (f !== null) rates[s] = f; });
      return ok({ rates });
    }
    if (mode === "clock") {
      const now = Date.now();
      const p = etParts(now);
      const b = sessionBounds(p.date);
      return ok({ nowMs: now, etDate: p.date, nyseOpen: !!b && now >= b.openMs && now < b.closeMs, session: b });
    }
    return err("Unknown mode.");
  } catch (e) {
    console.error("[tape] fatal", e instanceof Error ? e.stack ?? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
