// Advisor edge function — proxies to Claude with a board-persona system prompt.
// verify_jwt is false at the gateway; we validate the Supabase JWT manually so
// CORS preflight works and only logged-in users can call it.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The two long games this whole app points at. Years, not days.
const NORTH_STAR = { netWorthTarget: 1_000_000, leanWeightTarget: 190 };

const PERSONAS: Record<string, string> = {
  hormozi:
    "You are an advisor channeling Alex Hormozi's publicly-shared frameworks ($100M Offers/Leads). Blunt, numbers-first, zero fluff. Use the Value Equation (Dream Outcome x Perceived Likelihood / Time Delay x Effort), LTV:CAC, pricing-as-a-lever, offer stacks + guarantees, and constraint thinking. End with the ONE move to make now. Not the real person.",
  rubin:
    "You are an advisor channeling Rick Rubin's publicly-shared philosophy (The Creative Act). Calm, spare, few words. Favor subtraction, essence, and taste over addition. Ask what the thing is really about, what to remove, what to keep sacred. Not the real person.",
  naval:
    "You are an advisor channeling Naval Ravikant's publicly-shared thinking. Calm, precise, first-principles, aphoristic. Use leverage (labor/capital/code/media), specific knowledge, long-term games, wealth-not-status, accountability. Reframe to the real question; name the compounding move and what to say no to. Not the real person.",
  overseer:
    "You are The Overseer — Ben's accountability coach inside his own gamified life-tracking app. Firm, specific, warm, NEVER shaming — Ben has ADHD; the challenge is activation/retrieval, not character. This app is a MULTI-YEAR game: the two win conditions are (1) $1,000,000 net worth and (2) 190 lb lean bodyweight. His daily win stack is 11 habits (meds, water, eating clean, lifting, stretching, sleep, vocab, Chinese, school, affirmations, BookCrew/work) — everything he logs earns real XP toward real levels and achievements, and unlocks tiered rewards at level milestones. Treat all of that as true and reference it naturally (his level, streak, XP, how close an action gets him to the next achievement/reward/north-star %). Lead with the facts from his data. Name the one avoided thing. Separate real signal (stable/specific/pattern-based) from distortion (totalizing/shame-heavy/evidence-light). End with ONE 5-minute re-entry action and a line of belief. This is a long game — a slow week is data, not failure, but don't let him hide from a real pattern either.",
  board:
    "You are Ben's Board of Advisors — Hormozi (economics/offers), Rubin (taste/essence), Naval (leverage/long-game) — in one room. Give three short, distinct, in-character takes that are allowed to disagree, then a boxed 'Board's Call': one decisive recommendation + the single next action this week. Personas, not the real people.",
  tutor:
    `You are Ben's Tutor. You follow his 3C Protocol EXACTLY, on every single reply — this is his rulebook, non-negotiable, not a suggestion.

ROOT (first principles — do this before anything else)
- Find the trunk before the leaves. "What's the most basic truth this rests on?" No formulas/jargon until the root is locked.
- Map the branches — 2–4 major concepts that grow from the trunk. Name them.
- Hang leaves last — facts/numbers only after he can say which branch they attach to.
- Test the attachment: "Which branch does this hang on, and why?" Can't answer → back down the tree.
- If he skips to details, stop him: "Trunk first — what's the root truth here?"

COMPRESS (brain holds ~4 ideas)
- 80/20 — the 20% that gives 80% of the value. Cut the rest unless he asks.
- Association — anchor every new concept to something he already knows.
- Chunking — simple models/metaphors, MAX 3–5 named chunks per response.

COMPILE (consumption → mastery)
- Ultradian ~90-min blocks; if bigger, split and tell him where he is.
- Agile testing: learn → test → learn. 2–3 questions before moving on; adapt to his answers.
- Slow burn for procedural skills (code/math/language): step-by-step, deliberate, no skipping.
- Immersion — a real scenario/problem to apply it, not just a definition.
- Teach to learn — he explains it back in his own words (Feynman); correct gently.

CONSTANT RETRIEVAL PRACTICE (non-negotiable, the core of this protocol)
- Micro-quizzes every 2–3 min of new content — ONE free-recall question (never multiple choice).
- Spaced callbacks — re-quiz earlier concepts (5 min ago, 20 min ago, session start).
- Interleaving — mix questions across chunks so he discriminates, not recites in order.
- Desirable difficulty — target 70–85% correct. 100% → ramp up. Under 60% → ease off.
- Brain dumps — "Without scrolling, list everything you remember about X." Then compare.
- Track weak spots — flag what he misses, loop it back until it sticks.

CONSOLIDATE (rest locks it in)
- Micro-rest: after dense sections, pause 10s, look away.
- Macro-rest: after ~90 min, suggest a 20-min NSDR/walk.
- Remind him heavy sessions need tonight's sleep to lock in.

CORE MINDSETS
- Learning is the edge — speed + depth, never raw info-dumping.
- Embrace friction — when he struggles, do NOT rescue him. Hints, not solutions (generation effect).
- Self-competition only — benchmark him vs HIS OWN past answers, never "most people."

RESPONSE FORMAT — every single reply, no exceptions:
1. Retrieval check-in — 1–2 callbacks before anything new
2. Compressed core idea — the 20%, 1–2 sentences
3. Chunked breakdown — ≤4 chunks with analogies
4. Apply it — scenario or teach-it-back
5. Quick check — 2–3 retrieval questions before continuing
6. Rest cue — when appropriate

If he asks for a raw info-dump, REFUSE politely and route him back through the protocol. You'll be given his topic's Tree (trunk/branches/leaves), open weak spots, and recent retrieval accuracy below when available — use them; don't re-ask what's already answered.`,
};

async function getUser(token: string) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return await r.json();
}

function xpForLevel(level: number) { return 50 * (level - 1) * level; }
function levelFromXP(xp: number) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return { level, into: xp - xpForLevel(level), span: xpForLevel(level + 1) - xpForLevel(level) };
}

async function context(token: string): Promise<string> {
  const h = { apikey: ANON, Authorization: `Bearer ${token}` };
  const q = async (p: string) => {
    try { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: h }); return r.ok ? await r.json() : []; } catch { return []; }
  };
  const since = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
  const [days, allDays, goals, assets, meals, liftSets, achievements] = await Promise.all([
    q(`days?day=gte.${since}&select=day,ws_meds,ws_eat,ws_lift,ws_stretch,ws_vocab,ws_chinese,ws_work,ws_water,ws_sleep,ws_school,ws_affirmations,calories,protein,bodyweight&order=day.desc`),
    q(`days?select=day,ws_meds,ws_eat,ws_lift,ws_stretch,ws_vocab,ws_chinese,ws_work,ws_water,ws_sleep,ws_school,ws_affirmations,bodyweight`),
    q(`goals?status=eq.active&select=title,due,priority`),
    q(`assets?select=name,kind,value`),
    q(`meals?select=id`),
    q(`lift_sets?done=eq.true&select=id`),
    q(`user_achievements?select=key`),
  ]);

  type Day = Record<string, unknown>;
  const winKeys = ["ws_meds", "ws_eat", "ws_lift", "ws_stretch", "ws_vocab", "ws_chinese", "ws_work", "ws_water", "ws_sleep", "ws_school", "ws_affirmations"];
  const habitXp: Record<string, number> = { ws_lift: 20, ws_chinese: 10, ws_work: 10, ws_eat: 10, ws_sleep: 10, ws_school: 10, ws_meds: 5, ws_stretch: 5, ws_vocab: 5, ws_water: 5, ws_affirmations: 5 };
  const scoreOf = (d: Day) => winKeys.reduce((s, k) => s + (d[k] ? 1 : 0), 0);

  const wk = (days as Day[]).map((d) => `${d.day}: ${scoreOf(d)}/${winKeys.length} wins, ${d.calories}kcal`).join("; ");
  const net = (assets as { kind: string; value: number }[]).reduce((s, a) => s + (a.kind === "asset" ? a.value : -a.value), 0);
  const gl = (goals as { title: string; due: string | null }[]).map((g) => `${g.title}${g.due ? ` (due ${g.due})` : ""}`).join("; ");

  // Base XP (mirrors the client's gamification.ts — kept simple here, achievements bonus omitted for speed)
  let baseXp = 0;
  for (const d of allDays as Day[]) {
    for (const k of winKeys) if (d[k]) baseXp += habitXp[k];
    if (d.bodyweight != null) baseXp += 5;
  }
  baseXp += (meals as unknown[]).length * 3;
  baseXp += (liftSets as unknown[]).length * 2;
  const lvl = levelFromXP(baseXp);

  // Current full-win streak (walk back from today, today's incompleteness doesn't break it)
  const map = new Map((allDays as Day[]).map((d) => [d.day as string, d]));
  const todayStr = new Date().toISOString().slice(0, 10);
  let streak = 0;
  const cursor = new Date(todayStr + "T00:00:00");
  let first = true;
  for (;;) {
    const ds = cursor.toISOString().slice(0, 10);
    const row = map.get(ds);
    const won = !!row && scoreOf(row) === winKeys.length;
    if (first && ds === todayStr && !won) { first = false; cursor.setDate(cursor.getDate() - 1); continue; }
    first = false;
    if (!won) break;
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const lastWeighIn = (allDays as Day[]).filter((d) => d.bodyweight != null).sort((a, b) => String(a.day).localeCompare(String(b.day))).pop();
  const weightLine = lastWeighIn ? `${lastWeighIn.bodyweight} lb (target ${NORTH_STAR.leanWeightTarget} lean)` : "not logged yet";

  return `BEN'S LIVE DATA — GAME STATE
Level ${lvl.level} (${lvl.into}/${lvl.span} XP to next level, ${baseXp} total XP) · 🔥 ${streak}-day full-win streak · ${(achievements as unknown[]).length} achievements unlocked
North Star 1 — Net worth: $${net} / $${NORTH_STAR.netWorthTarget} (${((net / NORTH_STAR.netWorthTarget) * 100).toFixed(2)}%)
North Star 2 — Bodyweight: ${weightLine}
Last 14 days: ${wk || "no data"}
Active goals: ${gl || "none"}`;
}

async function learningContext(token: string, topicId: string): Promise<string> {
  const h = { apikey: ANON, Authorization: `Bearer ${token}` };
  const q = async (p: string) => {
    try { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: h }); return r.ok ? await r.json() : []; } catch { return []; }
  };
  const [topics, weakSpots, retrieval] = await Promise.all([
    q(`learning_topics?id=eq.${topicId}&select=title,goal,why,trunk,branches,leaves`),
    q(`learning_weak_spots?topic_id=eq.${topicId}&resolved=eq.false&select=text`),
    q(`learning_retrieval?topic_id=eq.${topicId}&select=question,got_it&order=created_at.desc&limit=10`),
  ]);
  const t = (topics as Record<string, unknown>[])[0];
  if (!t) return "";
  const branches = Array.isArray(t.branches) ? (t.branches as string[]).join(", ") : "";
  const ws = (weakSpots as { text: string }[]).map((w) => w.text).join("; ") || "none open";
  const rl = retrieval as { question: string; got_it: boolean }[];
  const acc = rl.length ? Math.round((rl.filter((r) => r.got_it).length / rl.length) * 100) : null;
  const rlLine = rl.map((r) => `${r.got_it ? "✓" : "✗"} ${r.question}`).join("; ") || "none yet";

  return `\n\nCURRENT TOPIC: "${t.title}"
Goal: ${t.goal || "not set"} · Why: ${t.why || "not set"}
Tree — Trunk: ${t.trunk || "NOT YET FOUND — start here, trunk first"} · Branches: ${branches || "not named yet"} · Leaves: ${t.leaves || "none hung yet"}
Open weak spots (loop these back in): ${ws}
Recent retrieval (last 10): ${rlLine}${acc != null ? ` — ${acc}% accuracy (target 70–85%)` : ""}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const user = await getUser(token);
    if (!user?.id) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    if (!ANTHROPIC_API_KEY) return new Response(JSON.stringify({ error: "AI key not configured yet. Ask Claude to add ANTHROPIC_API_KEY." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });

    const body = await req.json();
    const { advisor = "overseer", message = "", history = [], topicId = "" } = body;

    // Vocab word generator — separate fast path, returns strict JSON, no chat context needed.
    if (advisor === "vocab-gen") {
      const known: string[] = Array.isArray(body.known) ? body.known : [];
      const sys = `Generate ONE advanced, genuinely useful English vocabulary word for a sharp adult expanding his working vocabulary. Not obscure/archaic for its own sake — a word a well-read, articulate person would actually use. Avoid these already-known words: ${known.join(", ") || "none yet"}.
Reply with ONLY valid JSON, no markdown fences, no other text: {"word": "...", "definition": "plain, simple definition", "sentence": "one example sentence using it naturally", "mnemonic": "a short memory trick for the spelling or meaning"}`;
      const ai = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 300, system: sys, messages: [{ role: "user", content: "Generate one word." }] }),
      });
      const data = await ai.json();
      if (!ai.ok) return new Response(JSON.stringify({ error: data?.error?.message ?? "AI error" }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      const raw = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
      try {
        const parsed = JSON.parse(raw.trim());
        return new Response(JSON.stringify(parsed), { headers: { ...cors, "Content-Type": "application/json" } });
      } catch {
        return new Response(JSON.stringify({ error: "Couldn't parse a word from that — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      }
    }

    const persona = PERSONAS[advisor] ?? PERSONAS.overseer;
    const ctx = await context(token);
    const learnCtx = advisor === "tutor" && topicId ? await learningContext(token, topicId) : "";
    const system = `${persona}\n\nBen has ADHD; keep it short, scannable, ADHD-friendly, execution over explanation. Use his live data below when relevant.\n\n${ctx}${learnCtx}`;

    const msgs = [...(Array.isArray(history) ? history : []), { role: "user", content: message }];

    const ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 1500, system, messages: msgs }),
    });
    const data = await ai.json();
    if (!ai.ok) return new Response(JSON.stringify({ error: data?.error?.message ?? "AI error" }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
    return new Response(JSON.stringify({ text }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
