// Trader edge function — the news-driven PAPER trading agent.
//
// Ben's ask: "a paper trade based off of the news, then the agent makes a
// thesis and makes a trade... it teaches me based on the news, and then I could
// watch this agent make live trades and learn from that."
//
// So the unit of work here is not a fill, it is a CLAIM THAT CAN BE GRADED.
// Every trade stores the headline that caused it, what the agent thinks will
// happen, and the specific thing that would prove it wrong. When the position
// closes, the agent is made to mark its own homework against that falsifier.
// A trade you cannot grade afterwards teaches nothing.
//
// ── PAPER ONLY, AND STRUCTURALLY SO ────────────────────────────────────────
// TRADE_BASE below is a constant. There is no setting, no request field and no
// environment variable that can point this at live money — changing it requires
// editing and redeploying this file. On top of that, the key-storing RPC
// refuses any key id beginning "AK" (Alpaca live), and this function re-checks
// the "PK" paper prefix before it will send a single order. Two independent
// locks, because "it was only supposed to be paper" is a bad sentence to say
// about real money.
//
// verify_jwt=false at the gateway; the JWT is validated here by hand.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ENV_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Hardcoded. See the header comment — this is a lock, not a default.
const TRADE_BASE = "https://paper-api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";

const OR_BASE = "https://openrouter.ai/api/v1";
const isOR = (k: string) => k.startsWith("sk-or-");
const okModel = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(v) && v.length <= 100;
const D_SMART = "google/gemini-3.7-flash";

type Cfg = {
  enabled: boolean; dry: boolean;
  per_trade_pct: number; max_open: number;
  hold_days: number; stop_pct: number; take_pct: number;
  allow_short: boolean;
};
const DEFAULTS: Cfg = {
  enabled: false, dry: true,
  per_trade_pct: 2, max_open: 6,
  hold_days: 5, stop_pct: 8, take_pct: 12,
  allow_short: false,
};
function readCfg(raw: unknown): Cfg {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    enabled: r.enabled === true,
    dry: r.dry !== false,                                   // dry unless explicitly turned off
    per_trade_pct: num(r.per_trade_pct, DEFAULTS.per_trade_pct, 0.25, 10),
    max_open: num(r.max_open, DEFAULTS.max_open, 1, 20),
    hold_days: num(r.hold_days, DEFAULTS.hold_days, 1, 30),
    stop_pct: num(r.stop_pct, DEFAULTS.stop_pct, 2, 50),
    take_pct: num(r.take_pct, DEFAULTS.take_pct, 2, 100),
    allow_short: r.allow_short === true,
  };
}

async function secret(name: string): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ secret_name: name }),
    });
    if (r.ok) return ((await r.json()) as string | null) ?? "";
  } catch { /* fall through */ }
  return "";
}

type Alp = { key: string; sec: string };
async function alpacaCreds(): Promise<Alp | null> {
  const [key, sec] = await Promise.all([secret("alpaca_paper_key"), secret("alpaca_paper_secret")]);
  if (!key || !sec) return null;
  // second lock: a live key never gets used here even if one reached the vault
  if (!/^PK/.test(key)) return null;
  return { key, sec };
}
const alpH = (a: Alp) => ({ "APCA-API-KEY-ID": a.key, "APCA-API-SECRET-KEY": a.sec, "Content-Type": "application/json" });

async function alpaca(a: Alp, path: string, init?: RequestInit, base = TRADE_BASE) {
  const r = await fetch(`${base}${path}`, { ...init, headers: { ...alpH(a), ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  if (!r.ok) console.error(`[trader] alpaca ${r.status} ${path} ${text.slice(0, 300)}`);
  return { ok: r.ok, status: r.status, json, text };
}

/* ── the model ───────────────────────────────────────────────────────────── */
// The retry ladder this codebase learned the hard way, twice.
//
// (1) Some routed models now REFUSE reasoning:{effort:"none"} outright -
//     "Reasoning is mandatory for this endpoint and cannot be disabled" - a
//     hard 400. So a 4xx retries with the reasoning field omitted entirely,
//     letting the provider do whatever it insists on.
// (2) When reasoning IS forced on, it eats the token budget, and a thinking
//     model handed a small ceiling burns the lot deliberating and returns
//     EMPTY content with finish_reason "length". So every retry also doubles
//     the ceiling rather than asking the same impossible question again.
// One SPY read, used at fill and at close, so each trade carries its own
// like-for-like benchmark window.
async function spyPrice(a: Alp): Promise<number | null> {
  const s = await alpaca(a, "/v2/stocks/bars/latest?symbols=SPY&feed=iex", undefined, DATA_BASE);
  if (!s.ok) return null;
  const bar = (s.json as { bars?: Record<string, { c?: number }> })?.bars?.SPY;
  return bar && Number.isFinite(Number(bar.c)) ? Number(bar.c) : null;
}

async function ask(model: string, key: string, sys: string, user: string, budget: number): Promise<string> {
  const once = async (b: number, withReasoning: boolean): Promise<string> => {
    const body: Record<string, unknown> = {
      model, max_tokens: b,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
    };
    if (withReasoning && isOR(key)) body.reasoning = { effort: "none", exclude: true };
    const url = isOR(key) ? `${OR_BASE}/chat/completions` : "https://api.anthropic.com/v1/messages";
    const headers = isOR(key)
      ? { "Content-Type": "application/json", Authorization: `Bearer ${key}` }
      : { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
    const payload = isOR(key) ? body
      : { model: "claude-opus-4-8", max_tokens: b, system: sys, messages: [{ role: "user", content: user }] };
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    const raw = await r.text();
    if (!r.ok) { console.error(`[trader] model ${r.status} ${raw.slice(0, 300)}`); throw new Error(`HTTP_${r.status}`); }
    const d = JSON.parse(raw);
    const text = isOR(key)
      ? String(d?.choices?.[0]?.message?.content ?? "")
      : (d.content ?? []).filter((x: { type: string }) => x.type === "text").map((x: { text: string }) => x.text).join("");
    if (!text.trim()) { console.error(`[trader] empty finish=${d?.choices?.[0]?.finish_reason} usage=${JSON.stringify(d?.usage ?? {})}`); throw new Error("EMPTY"); }
    return text;
  };
  try { return await once(budget, true); }
  catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m.startsWith("HTTP_4") || m === "EMPTY") return await once(budget * 2, false);
    throw e;
  }
}
function parseJson<T>(raw: string): T | null {
  const s = raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "");
  try { return JSON.parse(s) as T; } catch { /* try to salvage */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) as T; } catch { /* give up */ } }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string, extra?: Record<string, unknown>) =>
    new Response(JSON.stringify({ error: m, ...(extra ?? {}) }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const body = await req.json().catch(() => ({}));
    const mode = String(body.mode ?? "status");

    // Browser (his JWT) or the scheduled job (its own narrow vault secret).
    let uid = "";
    const cronSecret = String(body.cronSecret ?? "");
    let cronOk = false;
    if (cronSecret) {
      const want = await secret("trader_cron_secret");
      cronOk = want.length > 20 && want === cronSecret;
    }
    if (cronOk) {
      uid = String(body.userId ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(uid)) return err("Scheduled call must name a userId.");
    } else {
      try {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
        if (r.ok) uid = (await r.json())?.id ?? "";
      } catch { /* falls through */ }
      if (!uid) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day ?? "")) ? String(body.day) : new Date().toISOString().slice(0, 10);

    // config
    let cfg = DEFAULTS;
    let model = D_SMART;
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?user_id=eq.${uid}&select=trader,ai_models`, { headers: svcH });
      if (r.ok) {
        const row = (await r.json())?.[0] ?? {};
        cfg = readCfg(row.trader);
        if (okModel(row.ai_models?.smart)) model = row.ai_models.smart;
      }
    } catch { /* defaults stand */ }
    // A caller may override the knobs, but ONE direction only: the request can
    // force a dry run, it can never switch one off. Whether this agent is
    // allowed to send orders at all is a stored setting Ben changes deliberately,
    // not something a request body decides.
    if (body.cfg) {
      const wanted = readCfg(body.cfg);
      cfg = { ...wanted, dry: cfg.dry || wanted.dry };
    }

    const creds = await alpacaCreds();

    /* ── STATUS ─────────────────────────────────────────────────────────── */
    if (mode === "status") {
      if (!creds) return ok({ connected: false, cfg, paper: true });
      const [acct, pos] = await Promise.all([
        alpaca(creds, "/v2/account"),
        alpaca(creds, "/v2/positions"),
      ]);
      if (!acct.ok) return ok({ connected: false, cfg, paper: true, alpacaError: `Alpaca refused the keys (HTTP ${acct.status}).` });
      const a = acct.json as Record<string, unknown>;
      return ok({
        connected: true, paper: true, cfg,
        account: {
          equity: Number(a.equity ?? 0), last_equity: Number(a.last_equity ?? 0),
          cash: Number(a.cash ?? 0), buying_power: Number(a.buying_power ?? 0),
          status: String(a.status ?? ""), trading_blocked: a.trading_blocked === true,
        },
        positions: (pos.ok && Array.isArray(pos.json) ? pos.json : []).map((p: Record<string, unknown>) => ({
          symbol: String(p.symbol), qty: Number(p.qty), side: String(p.side),
          avg_entry_price: Number(p.avg_entry_price), current_price: Number(p.current_price),
          market_value: Number(p.market_value), unrealized_pl: Number(p.unrealized_pl),
          unrealized_plpc: Number(p.unrealized_plpc),
        })),
      });
    }

    /* ── RUN: read tonight's briefing, decide, place paper orders ────────── */
    if (mode === "run") {
      // A scheduled run only happens if he switched the agent on. Tapping the
      // button in the app is explicit intent and always runs.
      if (cronOk && !cfg.enabled) return ok({ placed: [], skipped: "The agent is switched off, so the scheduled run did nothing." });
      const bRes = await fetch(`${SUPABASE_URL}/rest/v1/world_briefings?user_id=eq.${uid}&day=eq.${day}&select=*`, { headers: svcH });
      if (!bRes.ok) return err("Couldn't read tonight's briefing.");
      const brief = (await bRes.json())?.[0];
      if (!brief) return err("No briefing for that day yet — build the briefing first, then the agent has something to trade on.");

      // Candidates come only from the briefing's own exposure lists, so the
      // agent can never trade a name that no story tonight actually touched.
      type Cand = { symbol: string; dir: string; note: string; headline: string; thesis: string; url: string };
      const cands: Cand[] = [];
      for (const sec of (brief.sections ?? []) as Record<string, unknown>[]) {
        for (const it of (sec.items ?? []) as Record<string, unknown>[]) {
          for (const e of (it.exposure ?? []) as Record<string, unknown>[]) {
            const sym = String(e.ticker ?? "").toUpperCase();
            if (!/^[A-Z][A-Z.\-]{0,5}$/.test(sym)) continue;
            const dir = String(e.dir ?? "mixed");
            if (dir !== "tailwind" && dir !== "headwind") continue;
            if (dir === "headwind" && !cfg.allow_short) continue;
            cands.push({
              symbol: sym, dir, note: String(e.note ?? ""),
              headline: String(it.headline ?? ""), thesis: String(it.thesis ?? ""),
              url: String(((it.sources ?? []) as Record<string, unknown>[])[0]?.url ?? ""),
            });
          }
        }
      }
      if (!cands.length) return err("Nothing in tonight's briefing had a tradable name attached.", { candidates: 0 });

      // don't stack the same symbol
      const openRes = await fetch(`${SUPABASE_URL}/rest/v1/agent_trades?user_id=eq.${uid}&status=in.(open,pending)&select=symbol`, { headers: svcH });
      const openSyms = new Set(((openRes.ok ? await openRes.json() : []) as { symbol: string }[]).map((r) => r.symbol));
      const fresh = cands.filter((c) => !openSyms.has(c.symbol));
      if (!fresh.length) return err("Every name tonight is already an open position.", { candidates: cands.length });

      const key = await secret("anthropic_api_key") || ENV_KEY;
      if (!key) return err("No AI key set — the agent needs one to write its thesis.");

      const sys = `You are a paper-trading research agent. You are given tonight's news items and the listed companies each one touches. Choose the few positions with the clearest CAUSAL link between the story and the company's revenue, costs or regulation.

HARD RULES
- Choose at most ${Math.max(1, Math.min(4, cfg.max_open))} names. Fewer is better. If nothing has a clear mechanism, return an empty list - sitting out is a valid answer and a good one.
- Only symbols from the candidate list. Never invent one.
- "thesis": one sentence on the MECHANISM - what in this story reaches that company's money, and over roughly what horizon (days, not years).
- "falsifier": one sentence naming the specific observable that would show you were wrong. It must be checkable, not "if sentiment shifts".
- "conviction": 1, 2 or 3. Reserve 3 for a direct, already-announced effect on a company's own economics. Most things are 1.
- Reject anything where the link is "this is broadly good for tech" or similar. Sector vibes are not a mechanism.

Return ONLY JSON:
{"picks":[{"symbol":"XYZ","side":"buy","thesis":"...","falsifier":"...","conviction":2}]}`;

      const user = "Candidates:\n" + fresh.map((c, i) =>
        `[${i}] ${c.symbol} (${c.dir}) - ${c.note}\n    story: ${c.headline}\n    briefing read: ${c.thesis}`).join("\n");

      let picks: { symbol: string; side: string; thesis: string; falsifier: string; conviction: number }[] = [];
      try {
        const raw = await ask(model, key, sys, user, 6000);
        const parsed = parseJson<{ picks?: typeof picks }>(raw);
        picks = Array.isArray(parsed?.picks) ? parsed!.picks! : [];
      } catch (e) {
        return err(`The agent couldn't produce a thesis (${e instanceof Error ? e.message : "model error"}).`);
      }

      const bySym = new Map(fresh.map((c) => [c.symbol, c]));
      const chosen = picks
        .filter((p) => bySym.has(String(p.symbol).toUpperCase()))
        .slice(0, cfg.max_open)
        .map((p) => {
          const c = bySym.get(String(p.symbol).toUpperCase())!;
          return {
            symbol: c.symbol,
            side: c.dir === "headwind" ? "sell" : "buy",
            thesis: String(p.thesis ?? "").slice(0, 400),
            falsifier: String(p.falsifier ?? "").slice(0, 400),
            conviction: Math.min(3, Math.max(1, Number(p.conviction) || 1)),
            headline: c.headline, url: c.url,
          };
        });

      if (!chosen.length) return ok({ placed: [], skipped: "The agent looked and chose to sit this one out.", candidates: fresh.length });

      // sizing needs equity; in dry mode assume the paper default so the preview is still real
      let equity = 100000;
      if (creds) {
        const acct = await alpaca(creds, "/v2/account");
        if (acct.ok) equity = Number((acct.json as Record<string, unknown>).equity ?? equity);
      }
      const notional = Math.max(1, Math.round((equity * cfg.per_trade_pct) / 100));

      const placed: Record<string, unknown>[] = [];
      for (const t of chosen) {
        const row: Record<string, unknown> = {
          user_id: uid, day, symbol: t.symbol, side: t.side, notional,
          headline: t.headline, source_url: t.url, thesis: t.thesis,
          falsifier: t.falsifier, conviction: t.conviction,
        };

        if (cfg.dry || !creds) {
          row.status = "dry";
          row.reject_reason = creds ? "dry run - no order sent" : "no Alpaca keys connected yet";
        } else {
          const o = await alpaca(creds, "/v2/orders", {
            method: "POST",
            body: JSON.stringify({
              symbol: t.symbol, notional: String(notional), side: t.side,
              type: "market", time_in_force: "day",
              client_order_id: `news-${day}-${t.symbol}-${Date.now().toString(36)}`.slice(0, 128),
            }),
          });
          if (o.ok) {
            const j = o.json as Record<string, unknown>;
            row.status = "pending";
            row.order_id = String(j.id ?? "");
          } else {
            row.status = "rejected";
            // Alpaca's own message, not a paraphrase — he needs the real reason
            row.reject_reason = String((o.json as Record<string, unknown>)?.message ?? o.text).slice(0, 300);
          }
        }
        const ins = await fetch(`${SUPABASE_URL}/rest/v1/agent_trades`, {
          method: "POST", headers: { ...svcH, Prefer: "return=representation" }, body: JSON.stringify(row),
        });
        if (ins.ok) placed.push(((await ins.json()) as Record<string, unknown>[])[0]);
        else console.error(`[trader] insert failed ${ins.status} ${(await ins.text()).slice(0, 200)}`);
      }
      return ok({ placed, dry: cfg.dry || !creds, notional, candidates: fresh.length });
    }

    /* ── SYNC: fills, exit rules, grading, and the benchmark mark ────────── */
    if (mode === "sync") {
      if (!creds) return err("Connect Alpaca first — there is nothing to sync.");
      const [acctR, posR, tradesR] = await Promise.all([
        alpaca(creds, "/v2/account"),
        alpaca(creds, "/v2/positions"),
        fetch(`${SUPABASE_URL}/rest/v1/agent_trades?user_id=eq.${uid}&status=in.(pending,open)&select=*`, { headers: svcH }),
      ]);
      if (!acctR.ok) return err(`Alpaca refused the keys (HTTP ${acctR.status}).`);
      const positions = (posR.ok && Array.isArray(posR.json) ? posR.json : []) as Record<string, unknown>[];
      const posBySym = new Map(positions.map((p) => [String(p.symbol), p]));
      const trades = (tradesR.ok ? await tradesR.json() : []) as Record<string, unknown>[];

      const closed: Record<string, unknown>[] = [];
      const opened: string[] = [];

      for (const t of trades) {
        const sym = String(t.symbol);
        const p = posBySym.get(sym);

        // A pending order that produced a position is now open — record the fill.
        if (t.status === "pending") {
          if (!p) {
            // still unfilled (market closed, or the order was cancelled)
            if (t.order_id) {
              const o = await alpaca(creds, `/v2/orders/${t.order_id}`);
              const st = String((o.json as Record<string, unknown>)?.status ?? "");
              if (["canceled", "expired", "rejected"].includes(st)) {
                await fetch(`${SUPABASE_URL}/rest/v1/agent_trades?id=eq.${t.id}`, {
                  method: "PATCH", headers: svcH,
                  body: JSON.stringify({ status: "rejected", reject_reason: `order ${st}` }),
                });
              }
            }
            continue;
          }
          await fetch(`${SUPABASE_URL}/rest/v1/agent_trades?id=eq.${t.id}`, {
            method: "PATCH", headers: svcH,
            body: JSON.stringify({
              status: "open", entry_price: Number(p.avg_entry_price),
              // The position may already include another bot's shares on a
              // shared account. Record what THIS trade bought - notional at the
              // fill price - not the whole position.
              qty: Math.min(Math.abs(Number(p.qty)), Number(t.notional) / Math.max(0.01, Number(p.avg_entry_price))),
              entry_at: new Date().toISOString(),
              spy_entry: await spyPrice(creds),
            }),
          });
          opened.push(sym);
          continue;
        }

        // open → does an exit rule fire?
        if (!p) continue;                       // closed outside the agent; leave it alone
        const plpc = Number(p.unrealized_plpc) * 100;
        const heldDays = t.entry_at
          ? Math.floor((Date.now() - new Date(String(t.entry_at)).getTime()) / 86400000) : 0;

        let reason = "";
        if (plpc <= -cfg.stop_pct) reason = `stop loss at ${plpc.toFixed(1)}%`;
        else if (plpc >= cfg.take_pct) reason = `take profit at ${plpc.toFixed(1)}%`;
        else if (heldDays >= cfg.hold_days) reason = `time stop after ${heldDays} days`;
        if (!reason) continue;

        // close with an opposing market order for the whole position
        // Close ONLY what this agent opened. RegimeBot (or anything else) may
        // hold the same symbol in the same account, and Alpaca merges them into
        // a single position - dumping all of it would close someone else's trade.
        const held = Math.abs(Number(p.qty));
        const mine = Number(t.qty ?? 0) > 0 ? Number(t.qty) : held;
        const qty = Math.min(held, mine);
        if (!(qty > 0)) continue;
        const closeSide = String(p.side) === "long" ? "sell" : "buy";
        const c = await alpaca(creds, "/v2/orders", {
          method: "POST",
          body: JSON.stringify({
            symbol: sym, qty: String(qty), side: closeSide, type: "market", time_in_force: "day",
            client_order_id: `close-${sym}-${Date.now().toString(36)}`.slice(0, 128),
          }),
        });
        if (!c.ok) { console.error(`[trader] close failed ${sym}`); continue; }

        const exit = Number(p.current_price);
        const entry = Number(t.entry_price ?? p.avg_entry_price);
        // Derived from OUR quantity and OUR entry, so a merged position cannot
        // credit this agent with another bot's gains.
        const dir = String(p.side) === "long" ? 1 : -1;
        const pnl = (exit - entry) * qty * dir;
        const spyNow = await spyPrice(creds);

        // The agent marks its own homework against the falsifier it wrote at
        // entry — which is the entire point of the exercise.
        let verdict = "unclear", lesson = "";
        try {
          const aiKey = await secret("anthropic_api_key") || ENV_KEY;
          if (aiKey) {
            const raw = await ask(model, aiKey,
              `You are grading a closed paper trade against the claim made when it was opened. Be blunt. A profitable trade for the wrong reason is NOT a vindicated thesis, and a losing trade can still have had a sound thesis. Return ONLY JSON: {"verdict":"held|broke|unclear","lesson":"one sentence, what this actually teaches"}`,
              `Symbol ${sym} (${t.side}). Entry ${entry}, exit ${exit}, P/L ${pnl.toFixed(2)} (${plpc.toFixed(1)}%). Closed because: ${reason}.\nHeadline: ${t.headline}\nThesis: ${t.thesis}\nFalsifier: ${t.falsifier}`,
              2000);
            const g = parseJson<{ verdict?: string; lesson?: string }>(raw);
            if (g && ["held", "broke", "unclear"].includes(String(g.verdict))) verdict = String(g.verdict);
            if (g?.lesson) lesson = String(g.lesson).slice(0, 300);
          }
        } catch { /* an ungraded close is still a close */ }

        await fetch(`${SUPABASE_URL}/rest/v1/agent_trades?id=eq.${t.id}`, {
          method: "PATCH", headers: svcH,
          body: JSON.stringify({
            status: "closed", exit_price: exit, exit_at: new Date().toISOString(),
            exit_reason: reason, pnl, pnl_pct: plpc, verdict, lesson, spy_exit: spyNow,
          }),
        });
        closed.push({ symbol: sym, pnl, plpc, reason, verdict });
      }

      // Mark against the benchmark, using today's numbers rather than
      // re-deriving them later from whatever the API happens to return then.
      const a = acctR.json as Record<string, unknown>;
      let spy: number | null = null;
      const s = await alpaca(creds, "/v2/stocks/bars/latest?symbols=SPY&feed=iex", undefined, DATA_BASE);
      if (s.ok) {
        const bar = (s.json as { bars?: Record<string, { c?: number }> })?.bars?.SPY;
        if (bar && Number.isFinite(Number(bar.c))) spy = Number(bar.c);
      }
      await fetch(`${SUPABASE_URL}/rest/v1/agent_equity?on_conflict=user_id,day`, {
        method: "POST", headers: { ...svcH, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ user_id: uid, day, equity: Number(a.equity ?? 0), spy_close: spy }),
      });

      return ok({ opened, closed, equity: Number(a.equity ?? 0), spy });
    }

    return err("Unknown mode.");
  } catch (e) {
    console.error("[trader] fatal", e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
