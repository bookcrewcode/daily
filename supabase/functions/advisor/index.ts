// Advisor edge function — proxies to Claude with a board-persona system prompt.
// verify_jwt is false at the gateway; we validate the Supabase JWT manually so
// CORS preflight works and only logged-in users can call it.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ENV_ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

// The Anthropic key lives encrypted in Supabase Vault, read via the
// service-role-only get_secret() RPC. An ANTHROPIC_API_KEY env var, if
// ever set, takes precedence. Cached for the life of the isolate.
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
  } catch {
    // fall through — caller reports "not configured"
  }
  return cachedKey;
}

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
    "You are The Overseer — Ben's accountability coach inside his own gamified life-tracking app. Firm, specific, warm, NEVER shaming — Ben has ADHD; the challenge is activation/retrieval, not character. This app is a MULTI-YEAR game: the two win conditions are (1) $1,000,000 net worth and (2) 190 lb lean bodyweight. His daily win stack is 11 habits (meds, water, eating clean, lifting, stretching, sleep, vocab, Chinese, school, affirmations, BookCrew/work) — everything he logs earns real XP toward real levels and achievements, and unlocks tiered rewards at level milestones. The app also runs 3 rotating daily quests (bonus XP for claiming), streak SHIELDS (a missed day consumes one instead of resetting — never shame a shielded miss; frame it as the system working), streak-bonus XP that compounds with the chain, and XP for gig shifts ($10 = 1 XP), focus blocks, and vocab reviews. THE ENGINE is Ben's own core framework, built from his gym insight: every life area is a row with a daily REP that casts a VOTE for an identity ('I'm someone who ships'). The gym worked because it gave him four dials for free — see it (visible progress), feel it fast (tight feedback), own it (identity), enjoy it (payoff) — and rows install those on purpose. Speak this language: celebrate votes cast, measure reps not outcomes, and when something stalls, diagnose WHICH dial is missing rather than questioning his character. Treat all of that as true and reference it naturally (his level, streak, XP, how close an action gets him to the next achievement/reward/north-star %). Lead with the facts from his data. Name the one avoided thing. Separate real signal (stable/specific/pattern-based) from distortion (totalizing/shame-heavy/evidence-light). End with ONE 5-minute re-entry action and a line of belief. This is a long game — a slow week is data, not failure, but don't let him hide from a real pattern either.",
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

async function context(token: string, clientDay?: string): Promise<string> {
  const h = { apikey: ANON, Authorization: `Bearer ${token}` };
  // Track tables whose read failed so we never present a transient outage as
  // "streak 0 / no data" fact — a failed read must not masquerade as empty state.
  const failed = new Set<string>();
  const q = async (p: string) => {
    const table = p.split("?")[0];
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: h });
      if (!r.ok) { failed.add(table); return []; }
      return await r.json();
    } catch { failed.add(table); return []; }
  };
  // Exact row count via PostgREST count=exact. The client uses count:'exact';
  // .length of a plain select caps at PostgREST's max-rows (1000) and silently
  // undercounts XP once meals/sets/reps grow past it.
  const countOf = async (p: string): Promise<number> => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
        headers: { ...h, Prefer: "count=exact", Range: "0-0", "Range-Unit": "items" },
      });
      if (!r.ok) return 0;
      const total = (r.headers.get("content-range") ?? "").split("/")[1];
      return total && total !== "*" ? parseInt(total, 10) : 0;
    } catch { return 0; }
  };

  // Anchor "today" to the client's LOCAL date (every DB day key is local time).
  // Only fall back to the isolate's UTC date when clientDay is absent/malformed —
  // an evening call in a US timezone must not treat the in-progress local day as
  // a finished miss (burned shield / broken streak). Validated to YYYY-MM-DD so
  // it can't inject into the date-filtered query strings below.
  const safeDay = clientDay && /^\d{4}-\d{2}-\d{2}$/.test(clientDay) ? clientDay : "";
  const today = safeDay || new Date().toISOString().slice(0, 10);
  const anchor = new Date(today + "T00:00:00Z");
  const sliceBack = (ms: number) => new Date(anchor.getTime() - ms).toISOString().slice(0, 10);
  const since = sliceBack(13 * 86400000);
  const weekCut = sliceBack(7 * 86400000);

  const [days, allDays, goals, goalsDoneCount, assets, mealsCount, liftSetsDoneCount, achievements, questClaims, gigShifts, focusSessions, vocabRows, memories, captures, weekly, engRows, engRepsCount, engRepsRecent] = await Promise.all([
    q(`days?day=gte.${since}&select=day,ws_meds,ws_eat,ws_lift,ws_stretch,ws_vocab,ws_chinese,ws_work,ws_water,ws_sleep,ws_school,ws_affirmations,calories,protein,bodyweight&order=day.desc`),
    q(`days?select=day,ws_meds,ws_eat,ws_lift,ws_stretch,ws_vocab,ws_chinese,ws_work,ws_water,ws_sleep,ws_school,ws_affirmations,bodyweight`),
    q(`goals?status=eq.active&select=title,due,priority`),
    countOf(`goals?status=eq.done&select=id`),
    q(`assets?select=name,kind,value`),
    countOf(`meals?select=id`),
    countOf(`lift_sets?done=eq.true&select=id`),
    q(`user_achievements?select=key`),
    q(`quest_claims?select=day,quest_key,xp`),
    q(`gig_shifts?select=earnings`),
    q(`focus_sessions?select=minutes`),
    q(`vocab?select=seen`),
    q(`ai_memories?select=content,category,created_at&order=created_at.desc&limit=40`),
    q(`captures?done=eq.false&select=text&order=created_at.desc&limit=10`),
    q(`weekly_plans?select=week_start,priorities&order=week_start.desc&limit=1`),
    q(`engine_rows?archived=eq.false&select=id,emoji,name,rep,identity`),
    countOf(`engine_reps?select=row_id`),
    q(`engine_reps?day=gte.${weekCut}&select=row_id,day&order=day.desc`),
  ]);
  const daysUnavailable = failed.has("days");

  // Income + constraint — the Hormozi layer: the coach must see the lead measures
  // on the $1M (this week's revenue activities) and the week's binding constraint.
  const mondayISO = (() => { const d = new Date(anchor); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
  const [incomeWeek, constraintRow] = await Promise.all([
    q(`income_activities?day=gte.${mondayISO}&select=kind,qty,value`),
    q(`weekly_constraints?week_start=eq.${mondayISO}&select=area,bottleneck,metric,target,baseline`),
  ]);
  const incRows = incomeWeek as { kind: string; qty: number; value: number }[];
  const incCount = (k: string) => incRows.filter((r) => r.kind === k).reduce((s, r) => s + (r.qty || 0), 0);
  const weekRevenue = incRows.filter((r) => r.kind === "close").reduce((s, r) => s + Number(r.value || 0), 0);
  const moneyRepToday = (questClaims as { quest_key: string; day: string }[]).some((r) => r.quest_key === "moneyrep" && r.day === today);
  const incomeLine = incRows.length || weekRevenue
    ? `\nINCOME ENGINE (this week's lead measures on the $1M — outreach ${incCount("outreach")}, replies ${incCount("reply")}, demos ${incCount("demo")}, proposals ${incCount("proposal")}, closes ${incCount("close")}, affiliates ${incCount("affiliate")}; $${weekRevenue} booked; money rep today: ${moneyRepToday ? "✓ done" : "— not yet"}). Coach the LEADING activities, not just the balance — income is the lever on the $1M.`
    : "\nINCOME ENGINE: no revenue activities logged this week yet — the $1M line only moves when he sells. Nudge ONE revenue action.";
  const con = (constraintRow as { area: string; bottleneck: string; metric: string; target: number; baseline: number }[])[0];
  const constraintLine = con && con.bottleneck
    ? `\nTHIS WEEK'S ONE THING (his declared binding constraint — everything else is maintenance; hold him to it): [${con.area}] ${con.bottleneck}${con.metric ? ` · move "${con.metric}" ${con.baseline} → ${con.target}` : ""}.`
    : "\nTHIS WEEK'S ONE THING: not set yet — if a clear bottleneck exists in his data, name it and tell him to commit to one.";

  type Day = Record<string, unknown>;
  const winKeys = ["ws_meds", "ws_eat", "ws_lift", "ws_stretch", "ws_vocab", "ws_chinese", "ws_work", "ws_water", "ws_sleep", "ws_school", "ws_affirmations"];
  const habitXp: Record<string, number> = { ws_lift: 20, ws_chinese: 10, ws_work: 10, ws_eat: 10, ws_sleep: 10, ws_school: 10, ws_meds: 5, ws_stretch: 5, ws_vocab: 5, ws_water: 5, ws_affirmations: 5 };
  const scoreOf = (d: Day) => winKeys.reduce((s, k) => s + (d[k] ? 1 : 0), 0);

  const wk = (days as Day[]).map((d) => `${d.day}: ${scoreOf(d)}/${winKeys.length} wins, ${d.calories}kcal`).join("; ");
  const net = (assets as { kind: string; value: number }[]).reduce((s, a) => s + (a.kind === "asset" ? a.value : -a.value), 0);
  const gl = (goals as { title: string; due: string | null }[]).map((g) => `${g.title}${g.due ? ` (due ${g.due})` : ""}`).join("; ");

  // Streak with shields + streak-bonus XP (mirrors client computeStreak):
  // a missed day consumes a shield (2 max, regen 1 per 7 full-win days) before
  // breaking the chain; each full-win day banks min(10 × chain-day, 100) bonus XP.
  const map = new Map((allDays as Day[]).map((d) => [d.day as string, d]));
  const todayStr = today; // client-local anchor (see above), never the isolate's UTC date
  const sortedDays = (allDays as Day[]).map((d) => d.day as string).sort();
  let streak = 0, shields = 2, sinceRegen = 0, streakBonus = 0;
  if (sortedDays.length) {
    const cursor = new Date(sortedDays[0] + "T00:00:00");
    for (;;) {
      const ds = cursor.toISOString().slice(0, 10);
      const row = map.get(ds);
      const won = !!row && scoreOf(row) === winKeys.length;
      const isToday = ds === todayStr;
      if (won) {
        streak++;
        streakBonus += Math.min(10 * streak, 100);
        sinceRegen++;
        if (sinceRegen >= 7 && shields < 2) { shields++; sinceRegen = 0; }
      } else if (!isToday && streak > 0) {
        if (shields > 0) shields--;
        else { streak = 0; sinceRegen = 0; }
      }
      if (isToday || ds > todayStr) break;
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // Base XP (mirrors the client's gamification.ts — achievements bonus omitted).
  // meals/sets/goals-done/reps use exact count=exact totals (not capped .length)
  // so they agree with the client past 1000 rows, and goal-completion XP (50 per
  // done goal) is now included — the client counts it and we previously did not.
  let baseXp = streakBonus;
  for (const d of allDays as Day[]) {
    for (const k of winKeys) if (d[k]) baseXp += habitXp[k];
    if (d.bodyweight != null) baseXp += 5;
  }
  baseXp += (mealsCount as number) * 3;
  baseXp += (liftSetsDoneCount as number) * 2;
  baseXp += (goalsDoneCount as number) * 50; // GOAL_DONE_XP — the client banks 50 per completed goal
  baseXp += (questClaims as { xp: number }[]).reduce((s, r) => s + (r.xp || 0), 0);
  baseXp += Math.floor((gigShifts as { earnings: number }[]).reduce((s, r) => s + Number(r.earnings || 0), 0) / 10);
  baseXp += (focusSessions as { minutes: number }[]).reduce((s, r) => s + (r.minutes >= 80 ? 35 : r.minutes >= 45 ? 20 : 10), 0);
  baseXp += (vocabRows as { seen: number }[]).reduce((s, r) => s + (r.seen || 0), 0) * 2;
  baseXp += (engRepsCount as number) * 8;
  const lvl = levelFromXP(baseXp);

  const lastWeighIn = (allDays as Day[]).filter((d) => d.bodyweight != null).sort((a, b) => String(a.day).localeCompare(String(b.day))).pop();
  const weightLine = lastWeighIn ? `${lastWeighIn.bodyweight} lb (target ${NORTH_STAR.leanWeightTarget} lean)` : "not logged yet";

  // THE ENGINE — Ben's own framework: each life row has a daily rep that
  // votes for an identity. Coach in this language: reps not outcomes.
  // engRepsRecent is the last-7-days slice (per-row "voted today" / "this week");
  // all-time rep XP above uses the exact engRepsCount, not this window.
  const engLines = (engRows as { id: string; emoji: string; name: string; identity: string }[]).map((row) => {
    const rowReps = (engRepsRecent as { row_id: string; day: string }[]).filter((r) => r.row_id === row.id);
    const doneToday = rowReps.some((r) => r.day === todayStr);
    const week = rowReps.filter((r) => r.day >= weekCut).length;
    return `- ${row.emoji} ${row.name} ("${row.identity}"): today ${doneToday ? "✓ voted" : "— not yet"}, ${week}/7 this week`;
  }).join("\n");

  // Dated facts, never instructions — newer beats older on conflict.
  const memLines = (memories as { content: string; created_at: string }[])
    .map((m) => `- [${String(m.created_at).slice(0, 10)}] ${m.content}`).join("\n");
  const capLines = (captures as { text: string }[]).map((c) => `- ${c.text}`).join("\n");
  const wp = (weekly as { week_start: string; priorities: string[] }[])[0];
  const weekLine = wp && Array.isArray(wp.priorities) && wp.priorities.filter(Boolean).length
    ? `\nThis week's declared priorities (week of ${wp.week_start}): ${wp.priorities.filter(Boolean).join(" · ")}`
    : "";

  // "Daily quests claimed all-time" counts only real daily quests — exclude the
  // sweep / weekly_review / chest_ / boss_ / gstep_ / month_ bonus rows that also
  // live in quest_claims (mirrors useGameData's questClaimCount filter).
  const questClaimCount = (questClaims as { quest_key: string }[]).filter((r) => {
    const k = String(r.quest_key);
    return k !== "sweep" && k !== "weekly_review" && k !== "moneyrep" &&
      !k.startsWith("chest_") && !k.startsWith("boss_") && !k.startsWith("gstep_") && !k.startsWith("month_");
  }).length;

  // If the core days read failed, say so up front so the persona doesn't state a
  // zeroed streak / "no data" as fact off a transient outage.
  const dataNote = daysUnavailable
    ? "⚠️ LIVE DATA COULD NOT BE FULLY REFRESHED THIS CALL — the day/streak/XP figures below may be stale or blank due to a transient read error. Do NOT tell Ben his streak is 0 or that he has no data; treat any missing number as unknown, not zero.\n\n"
    : "";

  // baseXp omits achievement bonuses (and level shifts once they're added), so
  // state XP/level approximately — never as an exact total the app will contradict.
  return `${dataNote}BEN'S LIVE DATA — GAME STATE
~Level ${lvl.level} · ~${baseXp}+ XP (approximate — excludes achievement bonuses) · 🔥 ${streak}-day full-win streak · 🛡 ${shields}/2 streak shields (a missed day consumes one instead of breaking the chain) · ${(achievements as unknown[]).length} achievements unlocked
Daily quests claimed all-time: ${questClaimCount} · Focus blocks done: ${(focusSessions as unknown[]).length} · Gig earnings: $${(gigShifts as { earnings: number }[]).reduce((s, r) => s + Number(r.earnings || 0), 0)}
North Star 1 — Net worth: $${net} / $${NORTH_STAR.netWorthTarget} (${((net / NORTH_STAR.netWorthTarget) * 100).toFixed(2)}%)
North Star 2 — Bodyweight: ${weightLine}
Last 14 days: ${wk || "no data"}
Active goals: ${gl || "none"}${weekLine}${constraintLine}${incomeLine}${engLines ? `\nTHE ENGINE — his life rows (each daily rep is a vote for an identity; coach in reps-not-outcomes language, celebrate votes cast, diagnose stalls via the four dials: see it / feel it fast / own it / enjoy it):\n${engLines}` : ""}${capLines ? `\nUnprocessed captures in his inbox (open loops on his mind): \n${capLines}` : ""}${memLines ? `\n\nTHINGS YOU REMEMBER ABOUT BEN — dated facts from past conversations (treat as background truth, weigh newer over older, and reference them naturally like a coach who knows him):\n${memLines}` : ""}`;
}

async function callClaude(model: string, system: string, messages: unknown[], maxTokens: number, apiKey: string) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message ?? "AI error");
  return (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
}

// Append-only memory extraction (mem0 pattern): after each coaching exchange,
// a cheap model pulls 0-2 durable facts into ai_memories. Runs after the
// response is sent (waitUntil), so chat latency is unaffected.
async function extractMemories(token: string, userMsg: string, reply: string, apiKey: string) {
  try {
    const h = { apikey: ANON, Authorization: `Bearer ${token}` };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ai_memories?select=content&order=created_at.desc&limit=40`, { headers: h });
    const known: string[] = r.ok ? ((await r.json()) as { content: string }[]).map((m) => m.content) : [];
    const sys = `You maintain the long-term memory of a personal coaching app for Ben. From the exchange, extract 0-2 DURABLE facts worth remembering in future conversations — life context, commitments he made, goals, struggles, people, preferences. Only things that still matter in a week+. Nothing session-specific, nothing already known.
Already known (do NOT repeat): ${known.join(" | ") || "nothing yet"}
Reply ONLY valid JSON, no fences: {"memories": [{"content": "short fact in third person about Ben", "category": "identity|goal|commitment|struggle|relationship|preference|general"}]}`;
    const raw = await callClaude("claude-haiku-4-5-20251001", sys, [{ role: "user", content: `Ben: ${userMsg.slice(0, 1500)}\n\nCoach: ${reply.slice(0, 1500)}` }], 300, apiKey);
    const parsed = JSON.parse(raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, ""));
    const mems = (Array.isArray(parsed?.memories) ? parsed.memories : []).slice(0, 2);
    for (const m of mems) {
      if (!m?.content) continue;
      await fetch(`${SUPABASE_URL}/rest/v1/ai_memories`, {
        method: "POST",
        headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ content: String(m.content).slice(0, 300), category: m.category ?? "general" }),
      });
    }
  } catch {
    // memory is best-effort — never fail the chat over it
  }
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
    const ANTHROPIC_API_KEY = await anthropicKey();
    if (!ANTHROPIC_API_KEY) return new Response(JSON.stringify({ error: "AI key not configured yet. Ask Claude to add ANTHROPIC_API_KEY." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });

    const body = await req.json();
    const { advisor = "overseer", message = "", history = [], topicId = "", clientDay = "" } = body;

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

    // ☀️ Morning briefing — one short generated brief per day, cached client-side.
    if (advisor === "briefing") {
      const ctx = await context(token, clientDay || undefined);
      const sys = `You are The Overseer writing Ben's MORNING BRIEFING inside his life app. Ben has ADHD — the briefing's job is to collapse the fog into ONE clear picture in under 15 seconds of reading.
Write 4-6 SHORT lines, no headers, no preamble, no markdown syntax except emoji:
1. One-line greeting with the streak/shield state (never shame).
2. THE ONE THING today — pick it decisively from his week priorities, urgent goals, or an unvoted Engine row. Name its 2-minute starter.
3. One line on today's quests or an Engine row worth hitting early.
4. Optional: one relevant callback from what you remember about him.
5. Close with one line of fire — belief, not pressure.
Use his live data below. Be specific with numbers. Total under 90 words.\n\n${ctx}`;
      try {
        const text = await callClaude("claude-opus-4-8", sys, [{ role: "user", content: "Write today's briefing." }], 400, ANTHROPIC_API_KEY);
        return new Response(JSON.stringify({ text }), { headers: { ...cors, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Couldn't write the briefing." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      }
    }

    // 📸 Snap-a-meal — vision estimate of calories/protein from a photo.
    if (advisor === "food-vision") {
      const image = String(body.image ?? "");        // base64, no data: prefix
      const mediaType = String(body.mediaType ?? "image/jpeg");
      if (!image || image.length > 1_800_000) {
        return new Response(JSON.stringify({ error: "Image missing or too large — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      }
      const sys = `You estimate nutrition from a food photo for a personal tracker. Be practical: assume a normal serving of what's visible. Reply ONLY valid JSON, no fences:
{"name": "short dish name", "calories": integer (total kcal, best estimate), "protein": integer (grams), "carbs": integer (grams), "fat": integer (grams), "confidence": "high|medium|low", "note": "one short line on what you assumed"}`;
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001", max_tokens: 250, system: sys,
            messages: [{ role: "user", content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
              { type: "text", text: "Estimate this meal." },
            ] }],
          }),
        });
        const data = await r.json();
        if (!r.ok) return new Response(JSON.stringify({ error: data?.error?.message ?? "Vision error" }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
        const raw = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
        const parsed = JSON.parse(raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, ""));
        return new Response(JSON.stringify(parsed), { headers: { ...cors, "Content-Type": "application/json" } });
      } catch {
        return new Response(JSON.stringify({ error: "Couldn't read that photo — try a clearer shot." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      }
    }

    // ✨ Affirmation draft — grounded in his Engine identities and recent
    // entries. It lands in the textarea for Ben to edit; saving is his rep.
    if (advisor === "affirm-gen") {
      const period = body.period === "night" ? "night" : "morning";
      const h = { apikey: ANON, Authorization: `Bearer ${token}` };
      const q = async (p: string) => {
        try { const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: h }); return r.ok ? await r.json() : []; } catch { return []; }
      };
      const [rows, recent] = await Promise.all([
        q(`engine_rows?archived=eq.false&select=emoji,name,identity`),
        q(`affirmations?select=text&order=created_at.desc&limit=8`),
      ]);
      const ids = (rows as { identity: string }[]).map((r) => r.identity).filter(Boolean).join("; ");
      const past = (recent as { text: string }[]).map((r) => r.text).join(" | ");
      const sys = `Write ONE first-person ${period} affirmation for Ben (he has ADHD; identity-based habits are his engine). ${period === "morning" ? "Morning: set the frame for the day — present tense, active, specific." : "Night: lock in pride from today — reflective, warm, earned."} 1-3 sentences, under 40 words, no quotes, no markdown — his own voice, not a motivational poster. Ground it in his declared identities${ids ? `: ${ids}` : ""}. Do not repeat these recent ones: ${past || "none yet"}. Reply with ONLY the affirmation text.`;
      try {
        const text = await callClaude("claude-opus-4-8", sys, [{ role: "user", content: `Write the ${period} affirmation.` }], 150, ANTHROPIC_API_KEY);
        return new Response(JSON.stringify({ text: text.trim() }), { headers: { ...cors, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Couldn't write one — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      }
    }

    // 🗓️ Schedule chat — build/edit a day's schedule by talking, not tapping.
    // Takes the CURRENT blocks + what Ben said, returns the FULL revised day as
    // structured JSON. The client shows it as a preview he applies — the AI
    // never writes to his plan directly.
    if (advisor === "schedule") {
      const current = Array.isArray(body.items) ? body.items : [];
      const dayLabel = String(body.dayLabel ?? "the day");
      const fixed = Array.isArray(body.fixed) ? body.fixed : []; // calendar events he can't move
      const ctx = await context(token, clientDay || undefined);
      const sys = `You are Ben's scheduler inside his life app. He talks; you return his day as structured blocks. He has ADHD — protect ONE deep-work block, keep the day realistic, don't over-pack it, and leave buffer between things.

RULES:
- Return the COMPLETE revised schedule for ${dayLabel}, not just the change. Keep every existing block he didn't ask to change, with its original time and wording.
- Times are 24h "HH:MM" strings. Order the list chronologically.
- Respect fixed calendar commitments (listed below) — schedule around them, never on top of them.
- If he's vague ("gym in the morning"), pick a sensible concrete time rather than asking.
- Keep block labels short and concrete (2-5 words), the way he'd write them.
- If he asks to remove something, drop it from the list.
- Anchor to his real life from the data below (his weekly priorities, the week's ONE thing, urgent goals) — if he leaves space, suggest putting the constraint work there.
- "note" is ONE short sentence to him about what you changed or a scheduling call you made. No preamble, no lists.

CURRENT BLOCKS for ${dayLabel}: ${current.length ? JSON.stringify(current) : "(empty — building it fresh)"}
FIXED CALENDAR COMMITMENTS (do not move, schedule around): ${fixed.length ? JSON.stringify(fixed) : "(none)"}

Reply ONLY valid JSON, no fences:
{"items": [{"time": "HH:MM", "what": "short label"}], "note": "one short sentence"}

${ctx}`;
      try {
        const msgs = [...(Array.isArray(history) ? history : []), { role: "user", content: message }];
        while (msgs.length && (msgs[0] as { role: string }).role !== "user") msgs.shift();
        const raw = await callClaude("claude-opus-4-8", sys, msgs, 1200, ANTHROPIC_API_KEY);
        const parsed = JSON.parse(raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, ""));
        const items = (Array.isArray(parsed?.items) ? parsed.items : [])
          .filter((it: { time?: string; what?: string }) => it && typeof it.what === "string" && it.what.trim())
          .map((it: { time?: string; what?: string }) => ({
            time: /^\d{1,2}:\d{2}$/.test(String(it.time ?? "")) ? String(it.time) : "",
            what: String(it.what).slice(0, 120),
          }))
          .slice(0, 24);
        return new Response(JSON.stringify({ items, note: String(parsed?.note ?? "").slice(0, 300) }), { headers: { ...cors, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Couldn't build that schedule — try rephrasing." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      }
    }

    // 🎯 Constraint diagnosis — the Overseer names the week's binding constraint
    // from live data. Returns structured JSON the client drops into the editor
    // for Ben to edit and commit; never an auto-write.
    if (advisor === "constraint") {
      const ctx = await context(token, clientDay || undefined);
      const sys = `You are The Overseer applying Theory of Constraints to Ben's week. From his live data below, identify the SINGLE binding constraint — the one bottleneck that, if moved, most advances his $1M net worth or 190 lb goals. Everything else is maintenance. Prefer income when net worth is flat and revenue activity is low (you can't cut your way to $1M). Reply ONLY valid JSON, no fences:
{"area": "income|body|mind|system", "bottleneck": "the one bottleneck in plain words, <12 words", "metric": "the ONE number to move", "baseline": integer (where it is now, best estimate or 0), "target": integer (a realistic 1-week target), "why": "one short sentence on why this is the constraint"}\n\n${ctx}`;
      try {
        const raw = await callClaude("claude-opus-4-8", sys, [{ role: "user", content: "Name this week's constraint." }], 300, ANTHROPIC_API_KEY);
        const parsed = JSON.parse(raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, ""));
        return new Response(JSON.stringify(parsed), { headers: { ...cors, "Content-Type": "application/json" } });
      } catch {
        return new Response(JSON.stringify({ error: "Couldn't diagnose it — set it yourself." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      }
    }

    // Learning ↔ Tutor pairing: turn a tutoring conversation into structured
    // review data (chunks / weak spots / retrieval log). Client shows a
    // review-then-save preview — AI output never auto-enters the system.
    if (advisor === "session-recap") {
      if (!topicId) return new Response(JSON.stringify({ error: "No topic given." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      const h = { apikey: ANON, Authorization: `Bearer ${token}` };
      // "session" = the last 12 hours of tutoring; falls back to the last 40
      // messages if today was quiet. Keep the NEWEST content when truncating.
      const sessionStart = new Date(Date.now() - 12 * 3600_000).toISOString();
      let r = await fetch(`${SUPABASE_URL}/rest/v1/chat_messages?advisor=eq.tutor&topic_id=eq.${topicId}&created_at=gte.${sessionStart}&select=role,content&order=created_at.desc&limit=40`, { headers: h });
      let rows = r.ok ? ((await r.json()) as { role: string; content: string }[]) : [];
      if (rows.length === 0) {
        r = await fetch(`${SUPABASE_URL}/rest/v1/chat_messages?advisor=eq.tutor&topic_id=eq.${topicId}&select=role,content&order=created_at.desc&limit=40`, { headers: h });
        rows = r.ok ? ((await r.json()) as { role: string; content: string }[]) : [];
      }
      const transcript = rows.reverse().map((m) => `${m.role === "user" ? "BEN" : "TUTOR"}: ${m.content}`).join("\n\n").slice(-24000);
      if (!transcript) return new Response(JSON.stringify({ error: "No tutor conversation for this topic yet — talk to the Tutor first." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      const sys = `Extract a structured recap of this tutoring session between Ben and his AI tutor. Be faithful to what actually happened — no inventing. Reply ONLY valid JSON, no fences:
{"chunks": ["core idea in plain words", ...max 4], "weak_spots": ["specific thing Ben struggled with", ...max 3, empty if none], "retrieval": [{"question": "a retrieval question the tutor asked", "got_it": true|false}, ...max 8, empty if none]}`;
      try {
        const raw = await callClaude("claude-haiku-4-5-20251001", sys, [{ role: "user", content: transcript }], 700, ANTHROPIC_API_KEY);
        const parsed = JSON.parse(raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, ""));
        return new Response(JSON.stringify(parsed), { headers: { ...cors, "Content-Type": "application/json" } });
      } catch {
        return new Response(JSON.stringify({ error: "Couldn't build a recap from that session — try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      }
    }

    const persona = PERSONAS[advisor] ?? PERSONAS.overseer;
    const ctx = await context(token, clientDay || undefined);
    const learnCtx = advisor === "tutor" && topicId ? await learningContext(token, topicId) : "";
    const system = `${persona}\n\nBen has ADHD; keep it short, scannable, ADHD-friendly, execution over explanation. Use his live data below when relevant.\n\n${ctx}${learnCtx}`;

    const msgs = [...(Array.isArray(history) ? history : []), { role: "user", content: message }];
    // history sanitation: a failed past exchange can leave an orphaned user row,
    // which after windowing makes history START with an assistant turn — the
    // Anthropic API 400s on that, bricking the thread. Trim to first user turn.
    while (msgs.length && (msgs[0] as { role: string }).role !== "user") msgs.shift();

    const ai = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: 1500, system, messages: msgs }),
    });
    const data = await ai.json();
    if (!ai.ok) return new Response(JSON.stringify({ error: data?.error?.message ?? "AI error" }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    const text = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");

    // remember what matters from this exchange — after the response ships
    const extraction = extractMemories(token, String(message), text, ANTHROPIC_API_KEY);
    const er = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (er?.waitUntil) er.waitUntil(extraction); else extraction.catch(() => {});

    return new Response(JSON.stringify({ text }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
