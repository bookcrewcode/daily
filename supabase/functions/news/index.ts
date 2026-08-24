// News edge function — the nightly world briefing.
//
// Ben's ask: "economics, finance, crypto, world conflicts, science
// breakthroughs, basically everything you'd think in the news that I should
// stay up to date with — no garbage."
//
// HOW THE "NO GARBAGE" PART IS ENFORCED, structurally rather than by asking
// nicely: the model never works from memory. It is handed today's headlines
// pulled live from a fixed list of primary and reputable outlets, and is told
// to synthesize ONLY from them. No celebrity, no sports, no outrage cycle, no
// "this could change everything" — the prompt bans the genres and the feed list
// keeps them out in the first place. Every item carries its real source links,
// so nothing has to be taken on faith.
//
// Every feed URL below was fetched and confirmed to return items on
// 2026-08-23. A feed that fails is REPORTED in the briefing, never silently
// dropped — a thin briefing must be visibly thin, not quietly wrong.
//
// verify_jwt=false at the gateway; the JWT is validated here by hand. It also
// accepts a service-role call so the nightly cron can generate it while he
// sleeps.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ENV_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OR_BASE = "https://openrouter.ai/api/v1";
const isOR = (k: string) => k.startsWith("sk-or-");
const okModel = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(v) && v.length <= 100;
const D_SMART = "google/gemini-3.7-flash";

// Curated on purpose. Primary sources (the Fed) and outlets that report rather
// than react. Weighted toward what Ben actually needs to track: rates and the
// economy, crypto, conflicts, and real science.
const FEEDS: { url: string; label: string; beat: string }[] = [
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", label: "BBC World", beat: "world" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", label: "NYT World", beat: "world" },
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml", label: "BBC Business", beat: "econ" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", label: "CNBC", beat: "econ" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", label: "MarketWatch", beat: "econ" },
  { url: "https://www.economist.com/finance-and-economics/rss.xml", label: "Economist Finance", beat: "econ" },
  { url: "https://www.federalreserve.gov/feeds/press_all.xml", label: "Federal Reserve", beat: "econ" },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", label: "CoinDesk", beat: "crypto" },
  { url: "https://www.theblock.co/rss.xml", label: "The Block", beat: "crypto" },
  { url: "https://www.nature.com/nature.rss", label: "Nature", beat: "science" },
  { url: "https://feeds.arstechnica.com/arstechnica/science", label: "Ars Technica Science", beat: "science" },
  { url: "https://phys.org/rss-feed/breaking/", label: "Phys.org", beat: "science" },
  { url: "https://www.quantamagazine.org/feed/", label: "Quanta", beat: "science" },
  { url: "https://hnrss.org/frontpage?points=200", label: "Hacker News (200+)", beat: "tech" },
];

let ck = "", ca = 0;
async function apiKey(): Promise<string> {
  if (ck && Date.now() - ca < 60_000) return ck;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ secret_name: "anthropic_api_key" }),
    });
    if (r.ok) { const v = ((await r.json()) as string | null) ?? ""; if (v) { ck = v; ca = Date.now(); return v; } }
  } catch { /* fall through */ }
  return ENV_KEY || ck;
}

const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const tag = (xml: string, name: string): string => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
};
// Atom puts the link in an attribute rather than the element body.
const linkOf = (xml: string): string => {
  const rss = xml.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim() && !rss[1].includes("<")) return decode(rss[1]);
  const atom = xml.match(/<link[^>]*href=["']([^"']+)["']/i);
  return atom ? atom[1] : "";
};

type Head = { title: string; url: string; when: string; summary: string; source: string; beat: string };

// One feed, bounded: a slow or hostile feed can never hold up the briefing.
async function pullFeed(f: { url: string; label: string; beat: string }, perFeed: number): Promise<{ heads: Head[]; ok: boolean }> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    const r = await fetch(f.url, {
      signal: ctl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DailyBriefing/1.0)", Accept: "application/rss+xml, application/xml, text/xml, */*" },
      redirect: "follow",
    });
    clearTimeout(t);
    if (!r.ok) { console.error(`[news] feed ${f.label} HTTP ${r.status}`); return { heads: [], ok: false }; }
    const xml = await r.text();
    const blocks = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1, perFeed + 1);
    const heads = blocks.map((b) => ({
      title: tag(b, "title").slice(0, 220),
      url: linkOf(b).slice(0, 400),
      when: (tag(b, "pubDate") || tag(b, "updated") || tag(b, "published")).slice(0, 40),
      summary: (tag(b, "description") || tag(b, "summary") || tag(b, "content")).slice(0, 380),
      source: f.label,
      beat: f.beat,
    })).filter((h) => h.title);
    if (!heads.length) { console.error(`[news] feed ${f.label} parsed 0 items`); return { heads: [], ok: false }; }
    return { heads, ok: true };
  } catch (e) {
    console.error(`[news] feed ${f.label} threw ${e instanceof Error ? e.message : e}`);
    return { heads: [], ok: false };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string) => new Response(JSON.stringify({ error: m }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const body = await req.json().catch(() => ({}));

    // Two callers: Ben's browser (his JWT) and the nightly cron (service role,
    // which must name the user it is generating for).
    let uid = "";
    // The nightly cron carries its own narrow secret (vault: news_cron_secret)
    // rather than the service role key — a scheduled job should hold the
    // smallest credential that does its work, and this one can only ask for a
    // briefing. Compared against the vault value, never a hardcoded string.
    const cronSecret = String(body.cronSecret ?? "");
    let cronOk = false;
    if (cronSecret) {
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, {
          method: "POST",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ secret_name: "news_cron_secret" }),
        });
        if (r.ok) {
          const want = ((await r.json()) as string | null) ?? "";
          cronOk = want.length > 20 && want === cronSecret;
        }
      } catch { /* falls through to the JWT path */ }
    }
    if (cronOk || (token && token === SERVICE_KEY)) {
      uid = String(body.userId ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(uid)) return err("Scheduled call must name a userId.");
    } else {
      try {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
        if (r.ok) uid = (await r.json())?.id ?? "";
      } catch { /* falls through to 401 */ }
      if (!uid) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const key = await apiKey();
    if (!key) return err("No AI key set — open Settings → AI key and paste your OpenRouter key.");

    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day ?? "")) ? String(body.day) : new Date().toISOString().slice(0, 10);
    const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

    // Already have tonight's? Never pay twice for the same day.
    if (!body.force) {
      const ex = await fetch(`${SUPABASE_URL}/rest/v1/world_briefings?user_id=eq.${uid}&day=eq.${day}&select=*`, { headers: svcH });
      if (ex.ok) {
        const rows = await ex.json();
        if (rows?.[0]) return ok({ briefing: rows[0], cached: true });
      }
    }

    // Pull every feed at once; the slowest one sets the pace, not the sum.
    const pulled = await Promise.all(FEEDS.map((f) => pullFeed(f, 12)));
    const heads = pulled.flatMap((p) => p.heads);
    const failed = FEEDS.filter((_, i) => !pulled[i].ok).map((f) => f.label);
    if (heads.length < 10) return err(`Only ${heads.length} headlines came back from ${FEEDS.length} feeds — the news sources are unreachable right now. Try again in a bit.`);

    let model = D_SMART;
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?select=ai_models`, { headers: svcH });
      if (r.ok) { const m = (await r.json())?.[0]?.ai_models ?? {}; if (okModel(m.smart)) model = m.smart; }
    } catch { /* default stands */ }

    // Numbered so the model can cite by index instead of inventing URLs.
    const feedBlock = heads.map((h, i) =>
      `[${i}] (${h.beat} · ${h.source}${h.when ? ` · ${h.when}` : ""}) ${h.title}${h.summary ? ` — ${h.summary}` : ""}`
    ).join("\n");

    const sys = `You write Ben's nightly world briefing. He is 19, in college, trades crypto and equities with real money, and runs a small software business. He wants to be genuinely well-informed, not entertained.

WHAT GOES IN — only what still matters in a week:
- ECONOMY & MARKETS: rates, inflation, jobs, central banks, earnings that move a whole sector, anything that changes the cost of money.
- CRYPTO: regulation, institutional flows, protocol/security events, real structural moves. NOT price chatter or "X could hit $Y".
- WORLD: conflicts, elections, treaties, sanctions, energy — with enough context that a headline means something.
- SCIENCE & TECH: results that actually replicate or ship. Real breakthroughs, not press releases.

WHAT IS BANNED — this is the whole point:
- Celebrity, royals, sports, viral clips, culture-war outrage, crime stories with no policy consequence.
- Speculation dressed as news, "could/might/may soon", anonymous-source rumor, anything whose only content is a prediction.
- Two items about the same event. Merge them.
- Hype adjectives: game-changing, shocking, unprecedented, historic. State what happened.

HOW TO WRITE IT
- "headline": what happened, factually, in under 14 words. No clickbait, no question marks.
- "why": TWO sentences maximum — what it actually means and what changes because of it. Assume he's smart and knows nothing about this story. If it touches rates, crypto, or his money, say so plainly.
- "sources": the [index] numbers you used for that item, most relevant first. Use ONLY indices from the list. Never invent a source or a URL.
- "exposure": up to 4 listed companies or ETFs whose BUSINESS is genuinely exposed to this specific story, most exposed first. Each is {"name","ticker","dir","note"}:
    * Only large, liquid, well-known listings. No micro caps, no private companies, no "rumoured to IPO".
    * "ticker": the primary US listing symbol, uppercase. If you are not certain of the symbol, use "" rather than guessing one.
    * "dir": "tailwind" | "headwind" | "mixed" - the direction this story points for that business.
    * "note": at most 14 words on the MECHANISM. What in this story reaches their revenue, costs or regulation? Not "sentiment".
    * If nothing listed is meaningfully exposed, return []. Most world and science items should be empty. Do not reach for a name.
- "thesis": your own read of the story, 2 sentences maximum. First sentence: what you actually think this means, beyond restating it. Second sentence: the specific thing that would prove you WRONG. This is the only field where you may go past the headlines.
    * Never recommend a trade. No buy, sell, hold, "accumulate", price targets, position sizes, or timing calls. You are explaining what is exposed and why, not telling him what to do with it.
- Cover only what is IN the headlines below. If a beat has nothing real tonight, give it fewer items or omit the section — a short honest briefing beats a padded one.
- 3-5 items per section, 4 sections max. Order sections by what matters most tonight.
- "lede": one sentence — the single most important thing that happened today.
- "watch": one sentence — the specific thing to watch for tomorrow.

Return ONLY JSON:
{"lede":"…","sections":[{"key":"econ|crypto|world|science|tech","title":"…","items":[{"headline":"…","why":"…","sources":[0,4],"exposure":[{"name":"…","ticker":"…","dir":"tailwind|headwind|mixed","note":"…"}],"thesis":"…"}]}],"watch":"…"}

TONIGHT'S HEADLINES (${day}):
${feedBlock}`;

    async function call(budget: number, withReasoning: boolean): Promise<string> {
      const b: Record<string, unknown> = {
        model, max_tokens: budget,
        messages: [{ role: "system", content: sys }, { role: "user", content: "Write tonight's briefing." }],
      };
      if (withReasoning && isOR(key)) b.reasoning = { effort: "none", exclude: true };
      const url = isOR(key) ? `${OR_BASE}/chat/completions` : "https://api.anthropic.com/v1/messages";
      const headers = isOR(key)
        ? { "Content-Type": "application/json", Authorization: `Bearer ${key}` }
        : { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
      const payload = isOR(key) ? b : { model: "claude-opus-4-8", max_tokens: budget, system: sys, messages: [{ role: "user", content: "Write tonight's briefing." }] };
      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      const raw = await r.text();
      if (!r.ok) { console.error(`[news] upstream ${r.status} model=${model} ${raw.slice(0, 400)}`); throw new Error(`HTTP_${r.status}`); }
      const d = JSON.parse(raw);
      const text = isOR(key)
        ? String(d?.choices?.[0]?.message?.content ?? "")
        : (d.content ?? []).filter((x: { type: string }) => x.type === "text").map((x: { text: string }) => x.text).join("");
      if (!text.trim()) { console.error(`[news] empty finish=${d?.choices?.[0]?.finish_reason} usage=${JSON.stringify(d?.usage ?? {})}`); throw new Error("EMPTY"); }
      return text;
    }

    let raw = "";
    try { raw = await call(12000, true); }
    catch (e) {
      const m = e instanceof Error ? e.message : "";
      if (m.startsWith("HTTP_402")) return err("Your OpenRouter credits are out — top up and try again.");
      else if (m.startsWith("HTTP_4")) raw = await call(12000, false);
      else if (m === "EMPTY") raw = await call(22000, false);
      else return err("The model provider errored — try again.");
    }

    let parsed: { lede?: string; sections?: Record<string, unknown>[]; watch?: string };
    try {
      const s = raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "");
      parsed = JSON.parse(s);
    } catch {
      const s = raw.trim();
      const a = s.indexOf("{"), b2 = s.lastIndexOf("}");
      if (a < 0 || b2 <= a) { console.error(`[news] unparseable: ${s.slice(0, 300)}`); return err("The briefing came back unreadable — try again."); }
      try { parsed = JSON.parse(s.slice(a, b2 + 1)); } catch { return err("The briefing came back unreadable — try again."); }
    }

    // Resolve cited indices into REAL links. An index the model invented simply
    // drops out — a fabricated source is worse than no source.
    const DIRS = new Set(["tailwind", "headwind", "mixed"]);
    const sections = (parsed.sections ?? []).slice(0, 5).map((sec) => {
      const items = (Array.isArray(sec.items) ? sec.items as Record<string, unknown>[] : []).slice(0, 6).map((it) => {
        const idx = (Array.isArray(it.sources) ? it.sources : []).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < heads.length).slice(0, 3);
        // Exposure is the model's read, not a data feed, so it is bounded hard:
        // a ticker that is not shaped like a real symbol is dropped rather than
        // shown, and an unknown direction falls back to "mixed" instead of
        // implying a call the model did not make.
        const exposure = (Array.isArray(it.exposure) ? it.exposure as Record<string, unknown>[] : [])
          .slice(0, 4)
          .map((e) => {
            const t = String(e.ticker ?? "").trim().toUpperCase();
            return {
              name: String(e.name ?? "").slice(0, 60),
              ticker: /^[A-Z][A-Z.\-]{0,5}$/.test(t) ? t : "",
              dir: DIRS.has(String(e.dir)) ? String(e.dir) : "mixed",
              note: String(e.note ?? "").slice(0, 140),
            };
          })
          .filter((e) => e.name);
        return {
          headline: String(it.headline ?? "").slice(0, 220),
          why: String(it.why ?? "").slice(0, 600),
          sources: idx.map((n) => ({ title: heads[n].source, url: heads[n].url })),
          exposure,
          thesis: String(it.thesis ?? "").slice(0, 400),
        };
      }).filter((it) => it.headline);
      return { key: String(sec.key ?? "").slice(0, 20), title: String(sec.title ?? "").slice(0, 80), items };
    }).filter((sec) => sec.items.length);

    if (!sections.length) return err("The briefing came back empty — try again.");

    const row = {
      user_id: uid, day,
      lede: String(parsed.lede ?? "").slice(0, 400),
      sections, watch: String(parsed.watch ?? "").slice(0, 400),
      sources_used: heads.length, feeds_failed: failed,
    };
    const up = await fetch(`${SUPABASE_URL}/rest/v1/world_briefings?on_conflict=user_id,day`, {
      method: "POST",
      headers: { ...svcH, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row),
    });
    if (!up.ok) {
      console.error(`[news] upsert ${up.status} ${(await up.text()).slice(0, 300)}`);
      return ok({ briefing: { ...row, id: "", created_at: new Date().toISOString(), cost_usd: 0 }, unsaved: true });
    }
    return ok({ briefing: ((await up.json()) as Record<string, unknown>[])[0] });
  } catch (e) {
    console.error("[news] fatal", e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
