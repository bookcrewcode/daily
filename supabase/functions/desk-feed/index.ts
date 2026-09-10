// desk-feed — the news funnel. Every fifteen minutes: pull the feeds, keep
// what is new, tag it with a cheap model (tickers, category, impact,
// direction, horizon, one line on why it matters, and a plain-words line on
// what happened and what it means for the price), store it in desk_news.
// The scan turns high-impact tagged items into triggers; the app shows the
// stream. Shared table, no user column: the service role writes, signed-in
// users read.
//
// verify_jwt=false; callers checked here: the cron's vault secret, the
// service role (the tick), or a signed-in user's JWT (the refresh button).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ENV_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OR = "https://openrouter.ai/api/v1/chat/completions";
const TAGGER = "deepseek/deepseek-v4-flash-0731";
const TAGGER_FALLBACK = "google/gemini-3.5-flash-lite";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" };
type J = Record<string, unknown>;
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v: unknown, max = 2000): string => String(v ?? "").slice(0, max);

// Verified reachable from inside Supabase on 2026-09-08. SEC EDGAR wants a declared user agent (later).
const FEEDS: { name: string; url: string }[] = [
  { name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { name: "CNBC Finance", url: "https://www.cnbc.com/id/10000664/device/rss/rss.html" },
  { name: "CNBC Economy", url: "https://www.cnbc.com/id/20910258/device/rss/rss.html" },
  { name: "MarketWatch", url: "https://feeds.marketwatch.com/marketwatch/topstories/" },
  { name: "MarketWatch Pulse", url: "https://feeds.marketwatch.com/marketwatch/marketpulse/" },
  { name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "Reuters", url: "https://news.google.com/rss/search?q=site:reuters.com+(markets+OR+stocks+OR+fed+OR+oil+OR+bitcoin+OR+earnings)&hl=en-US&gl=US&ceid=US:en" },
  { name: "Google Business", url: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en" },
  { name: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { name: "PR Newswire", url: "https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss" },
  { name: "WSJ Markets", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml" },
  { name: "Investing.com", url: "https://www.investing.com/rss/news_25.rss" },
  { name: "Seeking Alpha", url: "https://seekingalpha.com/market_currents.xml" },
];

async function rest(path: string, init?: RequestInit): Promise<{ ok: boolean; json: unknown; status: number }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...svcH, ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) console.error(`[desk-feed] rest ${r.status} ${path} ${text.slice(0, 200)}`);
  return { ok: r.ok, json, status: r.status };
}
async function secret(name: string): Promise<string> {
  const r = await rest("rpc/get_secret", { method: "POST", body: JSON.stringify({ secret_name: name }) });
  return r.ok && typeof r.json === "string" ? r.json : "";
}
async function getText(url: string, ms = 12000): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal, redirect: "follow" });
    return r.ok ? await r.text() : "";
  } catch { return ""; } finally { clearTimeout(t); }
}
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/* ── parsing (RSS 2.0 and Atom, no dependencies) ───────────────────────── */
const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
const strip = (s: string) => decode(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
function tagOf(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}
function normLink(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|yptr|ref$|src$|siteid$)/i.test(k)) x.searchParams.delete(k);
    return x.toString().slice(0, 500);
  } catch { return u.trim().slice(0, 500); }
}
type Item = { title: string; link: string; source: string; published: string; summary: string };
function parseFeed(xml: string, source: string, nowMs: number): Item[] {
  const items: Item[] = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.split(isAtom ? /<entry[\s>]/i : /<item[\s>]/i).slice(1);
  for (const b of blocks) {
    let title = strip(tagOf(b, "title"));
    let link = "";
    if (isAtom) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? decode(m[1]) : ""; }
    else { link = strip(tagOf(b, "link")) || strip(tagOf(b, "guid")); }
    const dateStr = strip(tagOf(b, "pubDate") || tagOf(b, "published") || tagOf(b, "updated") || tagOf(b, "dc:date"));
    const published = Date.parse(dateStr);
    let src = source;
    // Google News titles end with " - Publisher"
    const gm = title.match(/^(.*)\s[-–]\s([A-Za-z0-9.&' ]{2,40})$/);
    if (gm && /news\.google\.com/.test(link)) { title = gm[1].trim(); src = gm[2].trim(); }
    const summary = strip(tagOf(b, "description") || tagOf(b, "summary") || tagOf(b, "content:encoded") || tagOf(b, "content")).slice(0, 300);
    if (!title || !link || !/^https?:/i.test(link)) continue;
    if (Number.isFinite(published) && nowMs - published > 48 * 3_600_000) continue; // no backfill of old items
    items.push({ title: title.slice(0, 220), link: normLink(link), source: src.slice(0, 40), published: Number.isFinite(published) ? new Date(published).toISOString() : new Date(nowMs).toISOString(), summary });
  }
  return items;
}
const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);

/* ── tagging ───────────────────────────────────────────────────────────── */
const TAG_SCHEMA = {
  name: "tags", strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["items"],
    properties: {
      items: {
        type: "array", items: {
          type: "object", additionalProperties: false,
          required: ["i", "tickers", "venue", "category", "impact", "direction", "horizon", "why", "plain"],
          properties: {
            i: { type: "integer" },
            tickers: { type: "array", items: { type: "string" } },
            venue: { type: "string", enum: ["stock", "crypto", "macro", "none"] },
            category: { type: "string", enum: ["macro", "earnings", "guidance", "deal", "regulation", "geopolitics", "crypto", "company", "other"] },
            impact: { type: "integer" },
            direction: { type: "string", enum: ["bullish", "bearish", "mixed", "none"] },
            horizon: { type: "string", enum: ["scalp", "swing", "position", "none"] },
            why: { type: "string" },
            plain: { type: "string" },
          },
        },
      },
    },
  },
};
const TAG_SYSTEM = `You tag financial headlines for a paper-trading desk that trades US stocks and ETFs (Robinhood) and crypto perpetuals (BloFin). For each item return: tickers (up to 4; US tickers in uppercase like NVDA, SPY; for crypto the base coin like BTC, ETH, SOL; empty if none is directly affected), venue (stock | crypto | macro | none), category, impact 1-5 (5 = likely to move an index or a major coin over 1% today; 4 = moves a specific stock or coin materially today; 3 = relevant context for a position; 2 = minor; 1 = noise, opinion, evergreen or promotional), direction for the named tickers (bullish | bearish | mixed | none), horizon over which the effect plays out (scalp = hours, swing = days, position = weeks, none), and "why" in at most 25 words: the mechanism from the story to a price (revenue, costs, rates, flows, supply), not a restatement of the headline. Then "plain": for Ben, 19, a beginner who reads only this, one or two short sentences (at most 45 words) on what actually happened and what it means for the price of the names it touches, in plain words; any piece of trading lingo gets a parenthesis with its meaning. Be stingy with 4 and 5. Return ONLY JSON matching the schema.`;

async function tagItems(key: string, rows: J[]): Promise<{ tags: Map<number, J>; cost: number; model: string; error: string }> {
  const list = rows.map((r, i) => `${i}. [${r.source}] ${r.title}${r.summary ? ` — ${String(r.summary).slice(0, 160)}` : ""}`).join("\n");
  const call = async (model: string) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 90_000);
    try {
      const r = await fetch(OR, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://bookcrewcode.github.io/daily/", "X-Title": "Daily Desk" },
        body: JSON.stringify({ model, messages: [{ role: "system", content: TAG_SYSTEM }, { role: "user", content: list }], max_tokens: 16000, reasoning: { effort: "low", exclude: true }, response_format: { type: "json_schema", json_schema: TAG_SCHEMA }, provider: { require_parameters: true } }),
      });
      const d = (await r.json().catch(() => null)) as J | null;
      const content = String((((d?.choices as J[]) ?? [])[0]?.message as J)?.content ?? "");
      const cost = num((d?.usage as J)?.cost);
      if (!r.ok || !content) return { json: null as J | null, cost, error: `HTTP ${r.status}` };
      try { return { json: JSON.parse(content) as J, cost, error: "" }; } catch { return { json: null, cost, error: "unparseable" }; }
    } catch (e) { return { json: null, cost: 0, error: e instanceof Error ? e.message : String(e) }; }
    finally { clearTimeout(t); }
  };
  let model = TAGGER;
  let res = await call(model);
  if (!res.json) { model = TAGGER_FALLBACK; const r2 = await call(model); res = { ...r2, cost: res.cost + r2.cost }; }
  const tags = new Map<number, J>();
  for (const it of (Array.isArray(res.json?.items) ? (res.json!.items as J[]) : [])) tags.set(Math.floor(num(it.i, -1)), it);
  return { tags, cost: res.cost, model, error: res.json ? "" : res.error };
}

/* ── the run ───────────────────────────────────────────────────────────── */
async function ingest(): Promise<J> {
  const t0 = Date.now();
  const xmls = await mapLimit(FEEDS, 8, async (f) => ({ f, xml: await getText(f.url) }));
  const parsed: Item[] = [];
  const perSource: Record<string, number> = {};
  for (const { f, xml } of xmls) { const items = xml ? parseFeed(xml, f.name, t0) : []; perSource[f.name] = items.length; parsed.push(...items); }

  // dedupe against what is already stored (recent links and titles) and within this batch
  const recentR = await rest("desk_news?select=link,title&order=published.desc&limit=1500");
  const recent = recentR.ok ? (recentR.json as J[]) : [];
  const seenLinks = new Set(recent.map((r) => String(r.link)));
  const seenTitles = new Set(recent.map((r) => titleKey(String(r.title))));
  const fresh: Item[] = [];
  for (const it of parsed) {
    const tk = titleKey(it.title);
    if (seenLinks.has(it.link) || seenTitles.has(tk) || tk.length < 12) continue;
    seenLinks.add(it.link); seenTitles.add(tk);
    fresh.push(it);
  }
  fresh.sort((a, b) => b.published.localeCompare(a.published));
  let inserted = 0;
  for (let i = 0; i < fresh.length; i += 100) {
    const r = await rest("desk_news?on_conflict=link", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify(fresh.slice(i, i + 100)) });
    if (r.ok) inserted += Math.min(100, fresh.length - i);
  }

  // tag the newest untagged items (this batch plus any left over from a failed run)
  const key = (await secret("anthropic_api_key")) || ENV_KEY;
  const untR = await rest("desk_news?tagged=eq.false&select=link,title,source,summary&order=published.desc&limit=60");
  const untagged = untR.ok ? (untR.json as J[]) : [];
  let tagged = 0, cost = 0, model = "", tagError = "";
  if (key && untagged.length) {
    const res = await tagItems(key, untagged);
    cost = res.cost; model = res.model; tagError = res.error;
    const rows = untagged.map((r, i) => {
      const t = res.tags.get(i);
      if (!t) return null;
      const tickers = (Array.isArray(t.tickers) ? t.tickers : []).map((x) => str(x, 12).toUpperCase().replace(/[^A-Z0-9.\-]/g, "")).filter((x) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(x)).slice(0, 4);
      return {
        link: r.link, title: r.title, tagged: true, tickers, venue: str(t.venue, 10) || "none", category: str(t.category, 20) || "other",
        impact: Math.max(1, Math.min(5, Math.round(num(t.impact, 1)))), direction: str(t.direction, 10) || "none", horizon: str(t.horizon, 10) || "none", why: str(t.why, 200), plain: str(t.plain, 400),
      };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    if (rows.length) {
      const up = await rest("desk_news?on_conflict=link", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows) });
      if (up.ok) tagged = rows.length;
    }
  }
  // retention: thirty days
  await rest(`desk_news?published=lt.${new Date(t0 - 30 * 86_400_000).toISOString()}`, { method: "DELETE" });
  return { fetched: parsed.length, per_source: perSource, new: fresh.length, inserted, untagged: untagged.length, tagged, cost, model, tag_error: tagError, ms: Date.now() - t0 };
}

/* ── the plain line for headlines tagged before it existed ─────────────── */
const PLAIN_SCHEMA = { name: "plain", strict: true, schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["i", "plain"], properties: { i: { type: "integer" }, plain: { type: "string" } } } } } } };
const PLAIN_SYSTEM = `For each financial headline, write "plain" for Ben, 19, a beginner who reads only this: one or two short sentences (at most 45 words) on what actually happened and what it means for the price of the names it touches, in plain words; any piece of trading lingo gets a parenthesis with its meaning. Return ONLY JSON matching the schema.`;
async function backfillPlain(body: J): Promise<J> {
  const t0 = Date.now();
  const key = (await secret("anthropic_api_key")) || ENV_KEY;
  if (!key) return { error: "no key" };
  const hours = Math.max(1, Math.min(240, num(body.hours, 48)));
  const minImpact = Math.max(1, Math.min(5, num(body.min_impact, 3)));
  const r = await rest(`desk_news?tagged=eq.true&plain=is.null&impact=gte.${minImpact}&published=gte.${new Date(t0 - hours * 3_600_000).toISOString()}&select=link,title,source,summary,why&order=published.desc&limit=${Math.max(1, Math.min(300, num(body.limit, 200)))}`);
  const todo = r.ok ? (r.json as J[]) : [];
  let written = 0, cost = 0, error = "";
  for (let i = 0; i < todo.length && Date.now() - t0 < 120_000; i += 50) {
    const batch = todo.slice(i, i + 50);
    const list = batch.map((x, k) => `${k}. [${x.source}] ${x.title}${x.summary ? ` — ${String(x.summary).slice(0, 160)}` : ""}${x.why ? ` (why it matters: ${x.why})` : ""}`).join("\n");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 80_000);
    try {
      const res = await fetch(OR, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://bookcrewcode.github.io/daily/", "X-Title": "Daily Desk" },
        body: JSON.stringify({ model: TAGGER_FALLBACK, messages: [{ role: "system", content: PLAIN_SYSTEM }, { role: "user", content: list }], max_tokens: 12000, reasoning: { effort: "low", exclude: true }, response_format: { type: "json_schema", json_schema: PLAIN_SCHEMA }, provider: { require_parameters: true } }) });
      const d = (await res.json().catch(() => null)) as J | null;
      cost += num((d?.usage as J)?.cost);
      const content = String((((d?.choices as J[]) ?? [])[0]?.message as J)?.content ?? "");
      const j = content ? (JSON.parse(content) as J) : null;
      const rows = (Array.isArray(j?.items) ? (j!.items as J[]) : []).map((it) => { const x = batch[Math.floor(num(it.i, -1))]; return x && str(it.plain) ? { link: x.link, title: x.title, plain: str(it.plain, 400) } : null; }).filter((x): x is NonNullable<typeof x> => !!x);
      if (rows.length) { const up = await rest("desk_news?on_conflict=link", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows) }); if (up.ok) written += rows.length; }
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { clearTimeout(t); }
  }
  return { todo: todo.length, written, cost, error, ms: Date.now() - t0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const body = (await req.json().catch(() => ({}))) as J;
    let uid = "";
    const cronSecret = String(body.cronSecret ?? "");
    if (cronSecret) { const want = await secret("desk_cron_secret"); if (want.length > 20 && want === cronSecret) uid = String(body.userId ?? "cron"); }
    if (!uid && token && SERVICE_KEY && token === SERVICE_KEY) uid = "service";
    if (!uid && token) {
      try { const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }); if (r.ok) uid = String((await r.json())?.id ?? ""); } catch { /* 401 below */ }
    }
    if (!uid) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const mode = String(body.mode ?? "ingest");
    if (mode === "ingest") return ok(await ingest());
    if (mode === "plain") return ok(await backfillPlain(body));
    return ok({ error: "Unknown mode." });
  } catch (e) {
    console.error("[desk-feed] fatal", e instanceof Error ? e.stack ?? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
