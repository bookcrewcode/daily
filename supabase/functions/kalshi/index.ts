// Kalshi hub edge function — powers the in-app "Markets" section.
// Two actions, BOTH safe — no Kalshi trading key ever touches the cloud:
//   scan -> aggregate Kalshi's PUBLIC trades feed into a live liquidity map
//   chat -> Claude copilot grounded in the live scan + the project's real research
// verify_jwt is false at the gateway; we validate the Supabase JWT manually so
// CORS preflight works and only logged-in users can call it. Mirrors advisor.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ENV_ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Anthropic key lives encrypted in Supabase Vault, read via the service-role
// get_secret RPC (same as advisor). Cached for the life of the isolate.
let cachedKey = "";
async function anthropicKey(): Promise<string> {
  if (ENV_ANTHROPIC_KEY) return ENV_ANTHROPIC_KEY;
  if (cachedKey) return cachedKey;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ secret_name: "anthropic_api_key" }),
    });
    if (r.ok) cachedKey = ((await r.json()) as string | null) ?? "";
  } catch { /* caller reports "not configured" */ }
  return cachedKey;
}

async function getUser(token: string) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return await r.json();
}

// --------------------------------------------------------------------------
// Scanner — public Kalshi trades -> liquidity map (stateless snapshot).
// --------------------------------------------------------------------------
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

function categorize(series: string): string {
  const s = (series || "").toUpperCase();
  const has = (...subs: string[]) => subs.some((x) => s.includes(x));
  if (has("HIGH", "LOW", "RAIN", "TEMP", "SNOW", "WEATHER")) return "Weather";
  if (has("MENTION", "TRUMPSAY", "TWEETS")) return "Mentions";
  if (has("BTC", "ETH", "SOL", "XRP", "DOGE", "CRYPTO", "BITCOIN", "ETHEREUM")) return "Crypto";
  if (has("GAME", "SPORT", "NBA", "NFL", "MLB", "NHL", "SOCCER", "TENNIS", "UFC",
          "CRICKET", "GOLF", "WNBA", "MATCH", "ATP", "WTA", "ITF", "PGA",
          "NEXTTEAM", "MVE", "NASCAR", "BOXING", "FIGHT")) return "Sports";
  if (has("FED", "CPI", "GDP", "JOBS", "RATE", "INFLATION", "RECESSION", "PPI")) return "Economics";
  if (has("ELECTION", "SENATE", "HOUSE", "PRES", "POLL", "GOV")) return "Politics";
  return "Other";
}

async function scan() {
  const seen = new Set<string>();
  const byMarket: Record<string, [number, number]> = {};
  const byCat: Record<string, number> = {};
  const whales: Array<Record<string, unknown>> = [];
  let cursor = "";
  let total = 0;
  for (let p = 0; p < 4; p++) {
    const u = new URL(`${KALSHI}/markets/trades`);
    u.searchParams.set("limit", "1000");
    if (cursor) u.searchParams.set("cursor", cursor);
    const r = await fetch(u.toString(), { headers: { "User-Agent": "kalshi-hub/1.0" } });
    if (!r.ok) break;
    const d = await r.json();
    const trades = d.trades || [];
    cursor = d.cursor || "";
    let newHere = 0;
    for (const t of trades) {
      const id = t.trade_id;
      if (!id || seen.has(id)) continue;
      seen.add(id); newHere++; total++;
      const ticker: string = t.ticker || "";
      const series = ticker.split("-")[0];
      const cat = categorize(series);
      const count = parseFloat(t.count_fp || t.count || "0");
      const side = t.taker_side || "yes";
      const price = parseFloat((side === "yes" ? t.yes_price_dollars : t.no_price_dollars) || "0");
      const usd = count * price;
      if (!byMarket[ticker]) byMarket[ticker] = [0, 0];
      byMarket[ticker][0] += usd; byMarket[ticker][1] += 1;
      byCat[cat] = (byCat[cat] || 0) + usd;
      if (usd >= 1000) {
        whales.push({ ticker, series, category: cat, usd: Math.round(usd),
          time: t.created_time, link: `https://kalshi.com/markets/${series.toLowerCase()}` });
      }
    }
    if (newHere === 0 || !cursor) break;
  }
  const top_markets = Object.entries(byMarket)
    .sort((a, b) => b[1][0] - a[1][0]).slice(0, 15)
    .map(([ticker, v]) => ({ ticker, usd: Math.round(v[0]), trades: v[1],
      category: categorize(ticker.split("-")[0]),
      link: `https://kalshi.com/markets/${ticker.split("-")[0].toLowerCase()}` }));
  const by_category = Object.entries(byCat).sort((a, b) => b[1] - a[1])
    .map(([category, usd]) => ({ category, usd: Math.round(usd) }));
  whales.sort((a, b) => ((a.time as string) < (b.time as string) ? 1 : -1));
  return { total, top_markets, by_category, whales: whales.slice(0, 30), ts: Date.now() };
}

// --------------------------------------------------------------------------
// Chat copilot.
// --------------------------------------------------------------------------
const PROJECT_CONTEXT = `PROJECT REALITY (be honest, never hype — real money is at stake):
Rigorous research has KILLED the fast-crypto 15-min sniper (0/175 exploitable edges, a sub-second
race retail loses), perps (leverage can blow past the $75 stop into a debt), and the mention-market
"buy the cheap word" thesis (reproduced -14% to -34% ROI — a cheap price is informative, not lazy).
The only two leads with any pulse: (1) a bias-corrected WEATHER model on ILLIQUID long-tail markets,
and (2) a fragile mention-FADE — BOTH still need a $0 backtest before a cent is funded.
Ben has ~$300 on Kalshi, a $75 hard stop, and paper-mode-first discipline. Nothing is funded yet —
this is research mode. The one live edge-agnostic tool is the liquidity scanner (where real money trades).`;

async function chat(message: string, history: Array<{ role: string; content: string }>, scanData: {
  by_category?: Array<{ category: string; usd: number }>;
  top_markets?: Array<{ ticker: string; usd: number }>;
} | null) {
  const key = await anthropicKey();
  if (!key) return "(AI key not configured in Supabase Vault — add anthropic_api_key.)";
  const catline = (scanData?.by_category || []).map((c) => `${c.category} $${c.usd.toLocaleString()}`).join(", ");
  const topline = (scanData?.top_markets || []).slice(0, 6).map((m) => `${m.ticker} $${m.usd.toLocaleString()}`).join("; ");
  const system = `You are the copilot inside the Kalshi "Markets" section of Ben's personal daily app.
He talks to you to understand what's liquid, what the research says, and how to plan — like a sharp,
honest trading partner. Be concise and concrete.

LIVE LIQUIDITY (recent turnover by category): ${catline || "warming up"}
TOP MARKETS RIGHT NOW: ${topline || "warming up"}

${PROJECT_CONTEXT}

Hard rule: you CANNOT place, cancel, or promise real-money trades from here — trading stays gated on
Ben's own machine behind paper mode and a kill switch. If asked to trade, explain what you'd do, the
edge/fees/risk, and how to paper-test it — never claim you executed anything.`;
  const msgs = [...(history || []).slice(-12), { role: "user", content: message }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 900, system, messages: msgs }),
  });
  if (!r.ok) return `[chat error ${r.status}] ${(await r.text()).slice(0, 200)}`;
  const d = await r.json();
  return (d.content || []).filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text).join("") || "(no reply)";
}

// --------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = (req.headers.get("authorization") || "").replace("Bearer ", "");
    const user = token ? await getUser(token) : null;
    if (!user) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "scan";
    if (action === "scan") return json(await scan());
    if (action === "chat") return json({ reply: await chat(body.message || "", body.history || [], body.scan || null) });
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
