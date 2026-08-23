// Plan edge function — Ben builds his day by TALKING.
//
// "gym 7, class 9-11, bookcrew after lunch" → blocks. "move gym to 8 and cut
// the 3pm" → the revised day. It always returns the COMPLETE schedule, never a
// diff, so the client can preview it and write only on Apply.
//
// Split out of `advisor` for the same reason clips were: small functions are
// safe to redeploy. It also carries the reasoning fix the big chat function is
// still missing — a thinking model given a 1200-token ceiling burns the whole
// budget deliberating and returns nothing, which is exactly the bug that broke
// clip scripts.
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

const OR_BASE = "https://openrouter.ai/api/v1";
const isOpenRouter = (k: string) => k.startsWith("sk-or-");
const okModelId = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(v) && v.length <= 100;
// Scheduling is mechanical, not deep thinking — it rides the FAST tier.
const DEFAULT_FAST = "google/gemini-2.5-flash-lite";

let cachedKey = "";
let cachedAt = 0;
async function apiKey(): Promise<string> {
  if (cachedKey && Date.now() - cachedAt < 60_000) return cachedKey;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ secret_name: "anthropic_api_key" }),
    });
    if (r.ok) {
      const v = ((await r.json()) as string | null) ?? "";
      if (v) { cachedKey = v; cachedAt = Date.now(); return v; }
    }
  } catch { /* fall through */ }
  return ENV_KEY || cachedKey;
}

async function getUser(token: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Just enough of his real life to schedule against: what's dated and what the
// week is supposed to be about. A failed read is silently skipped — a missing
// goal list must never block him from planning his day.
async function planContext(token: string, day: string): Promise<string> {
  const h = { apikey: ANON, Authorization: `Bearer ${token}` };
  const q = async (p: string) => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: h });
      return r.ok ? await r.json() : [];
    } catch { return []; }
  };
  const monday = (() => {
    const d = new Date(day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  })();
  const [goals, constraint] = await Promise.all([
    q(`goals?status=eq.active&select=title,due&order=due.asc.nullslast&limit=12`),
    q(`weekly_constraints?week_start=eq.${monday}&select=area,bottleneck,metric,target`),
  ]);
  const gl = (goals as { title: string; due: string | null }[])
    .map((g) => `${g.title}${g.due ? ` (due ${g.due})` : ""}`).join(" · ");
  const c = (constraint as { area: string; bottleneck: string }[])[0];
  return [
    gl ? `HIS DATED WORK: ${gl}` : "",
    c ? `THIS WEEK'S ONE CONSTRAINT: ${c.area} — ${c.bottleneck}. If he leaves open space, suggest putting this there.` : "",
  ].filter(Boolean).join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string) => new Response(JSON.stringify({ error: m }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const user = await getUser(token);
    if (!user?.id) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

    const key = await apiKey();
    if (!key) return err("No AI key set — open Settings → AI key and paste your OpenRouter key.");

    const body = await req.json();
    const message = String(body.message ?? "").slice(0, 2000);
    if (!message.trim()) return err("Say what you want the day to look like.");
    const current = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
    const fixed = Array.isArray(body.fixed) ? body.fixed.slice(0, 40) : [];
    const dayLabel = String(body.dayLabel ?? "the day").slice(0, 40);
    const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    const clientDay = /^\d{4}-\d{2}-\d{2}$/.test(String(body.clientDay ?? "")) ? String(body.clientDay) : new Date().toISOString().slice(0, 10);

    let model = DEFAULT_FAST;
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?select=ai_models`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const m = (await r.json())?.[0]?.ai_models ?? {};
        if (okModelId(m.fast)) model = m.fast;
      }
    } catch { /* default stands */ }

    const ctx = await planContext(token, clientDay);
    const sys = `You are Ben's scheduler inside his life app. He talks; you return his day as structured blocks. He has ADHD — protect ONE deep-work block, keep the day realistic, don't over-pack it, and leave buffer between things.

RULES:
- Return the COMPLETE revised schedule for ${dayLabel}, not just the change. Keep every existing block he didn't ask to change, with its original time and wording.
- Times are 24h "HH:MM" strings. Order the list chronologically.
- Respect fixed commitments (listed below) — schedule around them, never on top of them, and do NOT repeat them in your output.
- If he's vague ("gym in the morning"), pick a sensible concrete time rather than asking.
- Keep block labels short and concrete (2-5 words), the way he'd write them.
- If he asks to remove something, drop it from the list.
- "note" is ONE short sentence about what you changed or a call you made. No preamble, no lists.

CURRENT BLOCKS for ${dayLabel}: ${current.length ? JSON.stringify(current) : "(empty — building it fresh)"}
FIXED COMMITMENTS (do not move, schedule around, do not repeat): ${fixed.length ? JSON.stringify(fixed) : "(none)"}
${ctx}

Reply ONLY valid JSON, no fences:
{"items": [{"time": "HH:MM", "what": "short label"}], "note": "one short sentence"}`;

    const msgs = [...history, { role: "user", content: message }];
    while (msgs.length && (msgs[0] as { role: string }).role !== "user") msgs.shift();

    async function call(maxTokens: number): Promise<string> {
      if (isOpenRouter(key)) {
        // reasoning OFF + real headroom: a thinking model handed a small ceiling
        // spends it all deliberating and returns empty content.
        const r = await fetch(`${OR_BASE}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model, max_tokens: maxTokens,
            reasoning: { effort: "none", exclude: true },
            messages: [{ role: "system", content: sys }, ...msgs],
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error?.message ?? "AI error");
        const t = String(d?.choices?.[0]?.message?.content ?? "");
        if (d?.choices?.[0]?.finish_reason === "length" && !t.trim()) throw new Error("TOOLONG");
        return t;
      }
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, system: sys, messages: msgs }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error?.message ?? "AI error");
      if (d?.stop_reason === "max_tokens") throw new Error("TOOLONG");
      return (d.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    }

    try {
      let raw = "";
      try { raw = await call(4000); }
      catch (e) { if (e instanceof Error && e.message === "TOOLONG") raw = await call(8000); else throw e; }

      const parsed = JSON.parse(raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, ""));
      const items = (Array.isArray(parsed?.items) ? parsed.items : [])
        .filter((it: { time?: string; what?: string }) => it && typeof it.what === "string" && it.what.trim())
        .map((it: { time?: string; what?: string }) => ({
          time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(it.time ?? "")) ? String(it.time) : "",
          what: String(it.what).slice(0, 120),
        }))
        .sort((a: { time: string }, b: { time: string }) => (a.time || "99:99").localeCompare(b.time || "99:99"))
        .slice(0, 40);
      if (!items.length) return err("That came back empty — try naming a couple of blocks.");
      return ok({ items, note: String(parsed?.note ?? "").slice(0, 240) });
    } catch (e) {
      const m = e instanceof Error ? e.message : "";
      return err(m === "TOOLONG"
        ? `${model} returned nothing usable twice — switch the Fast model in Settings and try again.`
        : (m || "Couldn't build that — try rephrasing."));
    }
  } catch {
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
