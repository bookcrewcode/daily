// Learn edge function — everything the notebook needs to teach, in one small
// service that can actually be redeployed.
//
// WHY THIS EXISTS: 14 of Ben's 15 chapters had no content. Generation was
// failing silently inside the 100KB `advisor` monolith, which carries a fatal
// bug for thinking models — OpenRouter requires max_tokens to EXCEED the
// reasoning budget, so a model handed a small ceiling spends it all
// deliberating and returns finish_reason "length" with empty content. Every
// call here disables reasoning, budgets generously, retries once with more
// room, and LOGS the upstream failure so a silent failure can never happen
// again.
//
// WHAT IT BORROWS FROM NOTEBOOKLM: answers are grounded in HIS sources, and
// every teaching beat carries a CITATION — a verbatim quote from the source it
// came from. That is the thing that makes NotebookLM trustworthy, and the
// thing this app was missing.
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
const isOR = (k: string) => k.startsWith("sk-or-");
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const strip = (s: string) => s.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "");
const okModel = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(v) && v.length <= 100;
const D_SMART = "google/gemini-3.7-flash";
const D_FAST = "google/gemini-2.5-flash-lite";

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

async function getUser(token: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function models(token: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?select=ai_models`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    if (!r.ok) return { smart: D_SMART, fast: D_FAST };
    const m = (await r.json())?.[0]?.ai_models ?? {};
    return { smart: okModel(m.smart) ? m.smart : D_SMART, fast: okModel(m.fast) ? m.fast : D_FAST };
  } catch { return { smart: D_SMART, fast: D_FAST }; }
}

// His own material. Budgeted so ONE big pasted document still contributes most
// of itself. A failed read is reported, never rendered as "he has no sources".
async function readSources(token: string, id: string): Promise<{ block: string; count: number; failed: boolean }> {
  if (!isUuid(id)) return { block: "", count: 0, failed: false };
  const h = { apikey: ANON, Authorization: `Bearer ${token}` };
  let failed = false;
  let rows: { title: string; kind: string; content: string }[] = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/notebook_sources?notebook_id=eq.${id}&select=title,kind,content&order=created_at.desc&limit=20`, { headers: h });
    if (!r.ok) failed = true; else rows = await r.json();
  } catch { failed = true; }
  const src = rows.filter((x) => (x.content ?? "").trim());
  const TOTAL = 140000, MIN = 500;
  const per = Math.min(120000, Math.max(8000, Math.floor(TOTAL / Math.max(1, src.length))));
  let budget = TOTAL;
  const blocks: string[] = [];
  for (const s of src) {
    if (budget < MIN) break;
    const slice = s.content.slice(0, Math.min(per, budget));
    budget -= slice.length;
    blocks.push(`--- SOURCE: "${s.title}" (${s.kind}) ---\n${slice}${slice.length < s.content.length ? "\n[…truncated…]" : ""}`);
  }
  return { block: blocks.join("\n\n"), count: blocks.length, failed };
}

// ONE call path for every mode. Reasoning off, generous budget, one retry with
// more room, and every upstream failure logged with its real body.
async function ask(model: string, sys: string, msgs: { role: string; content: unknown }[], maxTokens: number, key: string, tag: string): Promise<string> {
  const once = async (budget: number, withReasoning: boolean): Promise<string> => {
    if (isOR(key)) {
      const body: Record<string, unknown> = {
        model, max_tokens: budget,
        messages: [{ role: "system", content: sys }, ...msgs],
      };
      // Some models reject effort:"none" outright; when that happens we retry
      // without the field rather than failing the user's request.
      if (withReasoning) body.reasoning = { effort: "none", exclude: true };
      const r = await fetch(`${OR_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const raw = await r.text();
      if (!r.ok) {
        console.error(`[learn:${tag}] upstream ${r.status} model=${model} body=${raw.slice(0, 400)}`);
        throw new Error(`HTTP_${r.status}:${raw.slice(0, 200)}`);
      }
      const d = JSON.parse(raw);
      const text = String(d?.choices?.[0]?.message?.content ?? "");
      if (!text.trim()) {
        console.error(`[learn:${tag}] empty content model=${model} finish=${d?.choices?.[0]?.finish_reason} usage=${JSON.stringify(d?.usage ?? {})}`);
        throw new Error("EMPTY");
      }
      return text;
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: budget, system: sys, messages: msgs }),
    });
    const raw = await r.text();
    if (!r.ok) { console.error(`[learn:${tag}] anthropic ${r.status} ${raw.slice(0, 300)}`); throw new Error(`HTTP_${r.status}`); }
    const d = JSON.parse(raw);
    const t = (d.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    if (!t.trim()) throw new Error("EMPTY");
    return t;
  };
  try { return await once(maxTokens, true); }
  catch (e) {
    const m = e instanceof Error ? e.message : "";
    // a 4xx often means the reasoning field itself was rejected — drop it
    if (m.startsWith("HTTP_4")) { console.error(`[learn:${tag}] retrying without reasoning field`); return await once(maxTokens, false); }
    if (m === "EMPTY") { console.error(`[learn:${tag}] retrying with ${maxTokens * 2} tokens`); return await once(maxTokens * 2, false); }
    throw e;
  }
}

// Models sometimes wrap JSON in prose. Take the outermost {...} or [...].
function parseJson<T>(raw: string, tag: string): T {
  const s = strip(raw);
  try { return JSON.parse(s) as T; } catch { /* try harder */ }
  const first = Math.min(...[s.indexOf("{"), s.indexOf("[")].filter((i) => i >= 0));
  const last = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (Number.isFinite(first) && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)) as T; } catch { /* fall through */ }
  }
  console.error(`[learn:${tag}] unparseable: ${s.slice(0, 300)}`);
  throw new Error(`BADJSON:${s.slice(0, 120)}`);
}

const GROUND = (block: string, count: number, failed: boolean) =>
  failed
    ? "(his source material could not be read this turn — say so briefly and help from general knowledge; do NOT claim he has no sources)"
    : count ? block : "(no sources in this notebook yet)";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string) => new Response(JSON.stringify({ error: m }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  const friendly = (e: unknown, fallback: string) => {
    const m = e instanceof Error ? e.message : "";
    if (m.startsWith("BADJSON")) return `The model returned something unparseable — try again. (${m.slice(8, 90)})`;
    if (m === "EMPTY") return "The model returned nothing twice — switch the Smart model in Settings and try again.";
    if (m.startsWith("HTTP_402") || m.includes("credit")) return "Your OpenRouter credits are out — top up and try again.";
    if (m.startsWith("HTTP_401")) return "OpenRouter rejected the key — re-paste it in Settings → AI key.";
    if (m.startsWith("HTTP_")) return `The model provider errored (${m.slice(0, 60)}) — try again.`;
    return m || fallback;
  };

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const user = await getUser(token);
    if (!user?.id) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const key = await apiKey();
    if (!key) return err("No AI key set — open Settings → AI key and paste your OpenRouter key.");

    const body = await req.json();
    const mode = String(body.advisor ?? body.mode ?? "");
    const nbId = isUuid(String(body.topicId ?? "")) ? String(body.topicId) : "";
    const M = await models(token);

    // Every notebook mode is grounded in his material.
    const needsSources = ["syllabus", "chapter-pack", "lesson", "exam", "flashcards", "mindmap", "study-guide", "coach", "tutor"].includes(mode);
    let block = "", count = 0, failed = false;
    if (needsSources) {
      if (!nbId) return err("Which notebook?");
      ({ block, count, failed } = await readSources(token, nbId));
      if (failed) return err("Couldn't read your sources just now — try again in a moment.");
      if (!count && mode !== "coach" && mode !== "tutor") return err("Add sources to this notebook first — everything here is built from your own material.");
    }
    const material = GROUND(block, count, failed);

    // ── syllabus: design the chapters ─────────────────────────────────────
    if (mode === "syllabus") {
      const title = String(body.title ?? "this notebook").slice(0, 120);
      const sys = `You design a leveled syllabus for Ben from HIS OWN material. Trunk before leaves: chapter 1 is the root idea everything else hangs on, and each later chapter depends only on earlier ones.

RULES
- 5 to 8 chapters. Fewer, deeper beats many shallow ones.
- title: 2-6 words, concrete, no numbering.
- objective: ONE sentence starting with a verb — what he'll be able to DO.
- summary: one sentence on what it covers.
- Cover what is actually IN his material. Do not invent topics it doesn't support.

Return ONLY JSON: {"chapters":[{"title":"…","objective":"…","summary":"…"}]}

HIS MATERIAL (notebook: ${title}):
${material}`;
      try {
        const raw = await ask(M.smart, sys, [{ role: "user", content: "Design the chapters." }], 4000, key, "syllabus");
        const p = parseJson<{ chapters?: { title?: string; objective?: string; summary?: string }[] }>(raw, "syllabus");
        const chapters = (p.chapters ?? []).filter((c) => c?.title).slice(0, 8).map((c) => ({
          title: String(c.title).slice(0, 90),
          objective: String(c.objective ?? "").slice(0, 220),
          summary: String(c.summary ?? "").slice(0, 300),
        }));
        if (chapters.length < 2) return err("That came back too thin — try again.");
        return ok({ chapters });
      } catch (e) { return err(friendly(e, "Couldn't design the chapters — try again.")); }
    }

    // ── chapter-pack: the reading, WITH citations ─────────────────────────
    if (mode === "chapter-pack") {
      const ct = String(body.chapterTitle ?? "").slice(0, 120);
      const co = String(body.chapterObjective ?? "").slice(0, 240);
      const sys = `You write ONE chapter of a course for Ben, from HIS OWN material. He has ADHD: concrete, vivid, momentum. Teaching that bores him has failed.

CHAPTER: "${ct}"
OBJECTIVE: ${co}

RULES
- 5 to 7 "chunks". Each chunk teaches ONE idea in a paragraph or two, with a concrete example or analogy. Plain language. No throat-clearing, no "in this chapter".
- Every chunk carries a CITATION: "cite" is a VERBATIM quote (10-30 words) copied exactly from his material that this chunk rests on, and "cite_source" is that source's title. If a chunk genuinely rests on general background rather than his material, set cite to "" — never invent a quote.
- Each chunk has a "check": one multiple-choice question testing UNDERSTANDING, not recall of wording. 4 choices, exactly one right, "answer" is the 0-based index, "explain" is one sentence on why.
- Then 3 "recall" questions: open-ended, answered from memory in a sentence or two. "expected" is what a correct answer must contain.

Return ONLY JSON:
{"chunks":[{"teach":"…","cite":"…","cite_source":"…","check":{"q":"…","choices":["…","…","…","…"],"answer":0,"explain":"…"}}],"recall":[{"q":"…","expected":"…"}]}

HIS MATERIAL:
${material}`;
      try {
        const raw = await ask(M.smart, sys, [{ role: "user", content: "Write the chapter." }], 9000, key, "pack");
        const p = parseJson<{ chunks?: Record<string, unknown>[]; recall?: Record<string, unknown>[] }>(raw, "pack");
        const chunks = (p.chunks ?? []).filter((c) => typeof c?.teach === "string" && String(c.teach).trim()).slice(0, 8).map((c) => {
          const ch = c.check as Record<string, unknown> | undefined;
          const choices = Array.isArray(ch?.choices) ? (ch!.choices as unknown[]).map((x) => String(x)).filter((x) => x.trim()).slice(0, 4) : [];
          const ansRaw = Number(ch?.answer);
          const check = choices.length >= 2 && Number.isFinite(ansRaw) && ansRaw >= 0 && ansRaw < choices.length
            ? { q: String(ch?.q ?? "").slice(0, 300), choices, answer: Math.floor(ansRaw), explain: String(ch?.explain ?? "").slice(0, 300) }
            : null;
          return {
            teach: String(c.teach).slice(0, 2600),
            cite: String(c.cite ?? "").slice(0, 300),
            cite_source: String(c.cite_source ?? "").slice(0, 120),
            check,
          };
        });
        const recall = (p.recall ?? []).filter((r) => typeof r?.q === "string").slice(0, 5).map((r) => ({
          q: String(r.q).slice(0, 300), expected: String(r.expected ?? "").slice(0, 500),
        }));
        if (chunks.length < 2) return err("That chapter came back too thin — try again.");
        return ok({ pack: { chunks, recall } });
      } catch (e) { return err(friendly(e, "Couldn't build that chapter — try again.")); }
    }

    // ── coach: the Learning Guide (Socratic, never just the answer) ───────
    if (mode === "coach") {
      const ctx = String(body.context ?? "").slice(0, 1200);
      const askText = String(body.ask ?? "Explain this a bit more.").slice(0, 600);
      const sys = `You are Ben's learning guide, helping him through ONE point he's on right now. He has ADHD — concrete, warm, brief (under 140 words), plain language, an example if it helps.

He is currently on this teaching point:
"""${ctx}"""

Answer his request directly. If he asks you to simply hand over an answer he could reason to, give him the smallest hint that unblocks him and one question that gets him the rest — the struggle is where the learning happens. Ground in his material below when relevant; if you go past it, say so in a few words.

HIS MATERIAL:
${material}`;
      try {
        const text = await ask(M.smart, sys, [{ role: "user", content: askText }], 1500, key, "coach");
        return ok({ text });
      } catch (e) { return err(friendly(e, "Couldn't help with that right now — try again.")); }
    }

    // ── grade: judge free recall generously, on substance ─────────────────
    if (mode === "grade") {
      const items = Array.isArray(body.items) ? body.items.slice(0, 12) : [];
      if (!items.length) return err("Nothing to grade.");
      const sys = `You grade Ben's free-recall answers. Grade on SUBSTANCE, not wording — if he has the idea, he gets it. Be generous but honest; 70 or above counts as correct.

For each item return: score 0-100, correct (score >= 70), feedback (one warm sentence — what he got right, then the gap), missed (the key thing he left out, or "").

Return ONLY JSON: {"results":[{"score":0,"correct":false,"feedback":"…","missed":"…"}]}
Return exactly ${items.length} results, in order.`;
      try {
        const raw = await ask(M.smart, sys, [{ role: "user", content: JSON.stringify(items) }], 3000, key, "grade");
        const p = parseJson<{ results?: Record<string, unknown>[] }>(raw, "grade");
        const results = (p.results ?? []).slice(0, items.length).map((r) => {
          const score = Math.max(0, Math.min(100, Math.round(Number(r?.score) || 0)));
          return { score, correct: score >= 70, feedback: String(r?.feedback ?? "").slice(0, 400), missed: String(r?.missed ?? "").slice(0, 300) };
        });
        while (results.length < items.length) results.push({ score: 0, correct: false, feedback: "Couldn't grade this one — try again.", missed: "" });
        return ok({ results });
      } catch (e) { return err(friendly(e, "Couldn't grade that — try again.")); }
    }

    // ── exam: whole-notebook free recall ─────────────────────────────────
    if (mode === "exam") {
      const n = Math.max(4, Math.min(10, Number(body.n) || 8));
      const sys = `Write a ${n}-question free-recall exam over Ben's material. Open-ended, answered from memory in a few sentences. Spread across the WHOLE body of material, mixing recall with "why does this matter" reasoning. No multiple choice.

Return ONLY JSON: {"questions":[{"q":"…","expected":"…"}]}

HIS MATERIAL:
${material}`;
      try {
        const raw = await ask(M.smart, sys, [{ role: "user", content: "Write the exam." }], 4000, key, "exam");
        const p = parseJson<{ questions?: Record<string, unknown>[] }>(raw, "exam");
        const questions = (p.questions ?? []).filter((q) => typeof q?.q === "string").slice(0, n).map((q) => ({
          q: String(q.q).slice(0, 400), expected: String(q.expected ?? "").slice(0, 600),
        }));
        if (!questions.length) return err("Couldn't write the exam — try again.");
        return ok({ questions });
      } catch (e) { return err(friendly(e, "Couldn't write the exam — try again.")); }
    }

    // ── flashcards ───────────────────────────────────────────────────────
    if (mode === "flashcards") {
      const n = Math.max(8, Math.min(24, Number(body.n) || 16));
      const sys = `Write ${n} flashcards from Ben's material. Proven card rules: ONE fact per card, front is a real question (never "X?"), back is short enough to say out loud, no card that can be answered by pattern-matching the wording. "hint" is a nudge, or "".

Return ONLY JSON: {"cards":[{"front":"…","back":"…","hint":"…"}]}

HIS MATERIAL:
${material}`;
      try {
        const raw = await ask(M.smart, sys, [{ role: "user", content: "Write the flashcards." }], 5000, key, "cards");
        const p = parseJson<{ cards?: Record<string, unknown>[] }>(raw, "cards");
        const cards = (p.cards ?? []).filter((c) => typeof c?.front === "string" && typeof c?.back === "string").slice(0, n).map((c) => ({
          front: String(c.front).slice(0, 300), back: String(c.back).slice(0, 500), hint: String(c.hint ?? "").slice(0, 200),
        }));
        if (!cards.length) return err("Couldn't write the cards — try again.");
        return ok({ cards });
      } catch (e) { return err(friendly(e, "Couldn't write the cards — try again.")); }
    }

    // ── mindmap ──────────────────────────────────────────────────────────
    if (mode === "mindmap") {
      const title = String(body.title ?? "this notebook").slice(0, 120);
      const sys = `Map Ben's material as a tree: the ROOT idea, 3-6 branches, 2-5 leaves each. Short labels (2-6 words). The shape should show how the ideas actually depend on each other, not just categories.

Return ONLY JSON: {"root":"…","branches":[{"label":"…","children":["…"]}]}

HIS MATERIAL (notebook: ${title}):
${material}`;
      try {
        const raw = await ask(M.smart, sys, [{ role: "user", content: "Build the map." }], 3000, key, "map");
        const p = parseJson<{ root?: string; branches?: { label?: string; children?: unknown[] }[] }>(raw, "map");
        const branches = (p.branches ?? []).filter((b) => b?.label).slice(0, 6).map((b) => ({
          label: String(b.label).slice(0, 80),
          children: (Array.isArray(b.children) ? b.children : []).map((c) => String(c).slice(0, 80)).slice(0, 6),
        }));
        if (!branches.length) return err("Couldn't build the map — try again.");
        return ok({ root: String(p.root ?? title).slice(0, 90), branches });
      } catch (e) { return err(friendly(e, "Couldn't build the map — try again.")); }
    }

    // ── study guide ──────────────────────────────────────────────────────
    if (mode === "study-guide") {
      const title = String(body.title ?? "this notebook").slice(0, 120);
      const sys = `Write a study guide over Ben's material — the thing he reads before an exam.
- tldr: 2-3 sentences, the whole notebook compressed.
- trunk: the ONE root idea everything else hangs off.
- big_ideas: 4-7 {title, point} — point is 1-2 sentences.
- key_terms: 5-10 {term, definition} — definitions in plain language.
- misconceptions: 3-5 things people get wrong about this material.
- so_what: one paragraph on why this changes how he acts.

Return ONLY JSON with exactly those keys.

HIS MATERIAL (notebook: ${title}):
${material}`;
      try {
        const raw = await ask(M.smart, sys, [{ role: "user", content: "Write the study guide." }], 6000, key, "guide");
        const g = parseJson<Record<string, unknown>>(raw, "guide");
        const arr = (k: string) => (Array.isArray(g[k]) ? g[k] as Record<string, unknown>[] : []);
        const guide = {
          tldr: String(g.tldr ?? "").slice(0, 900),
          trunk: String(g.trunk ?? "").slice(0, 500),
          big_ideas: arr("big_ideas").slice(0, 8).map((b) => ({ title: String(b.title ?? "").slice(0, 120), point: String(b.point ?? "").slice(0, 600) })),
          key_terms: arr("key_terms").slice(0, 12).map((t) => ({ term: String(t.term ?? "").slice(0, 80), definition: String(t.definition ?? "").slice(0, 400) })),
          misconceptions: (Array.isArray(g.misconceptions) ? g.misconceptions : []).map((m) => String(m).slice(0, 300)).slice(0, 6),
          so_what: String(g.so_what ?? "").slice(0, 900),
        };
        if (!guide.big_ideas.length) return err("Couldn't build the study guide — try again.");
        return ok({ guide });
      } catch (e) { return err(friendly(e, "Couldn't build the study guide — try again.")); }
    }

    // ── lesson: the Run (tappable cards, never two the same in a row) ────
    if (mode === "lesson") {
      const ct = String(body.chapterTitle ?? "").slice(0, 120);
      const co = String(body.chapterObjective ?? "").slice(0, 240);
      const sys = `Build an interactive RUN for Ben on this chapter — a game, not a worksheet. He taps; he never types.

CHAPTER: "${ct}"
OBJECTIVE: ${co}

12-16 cards, alternating teaching and doing, NEVER two of the same kind in a row. Kinds:
- {"kind":"teach","text":"one vivid idea, 2-4 sentences","diagram":{"kind":"flow|compare|cycle|stack","title":"…","items":["…"]}}   (diagram optional but preferred)
- {"kind":"mcq","q":"…","choices":["…","…","…","…"],"answer":0,"explain":"…"}
- {"kind":"blank","prompt":"sentence with ___ for each gap","answer":["word","word"],"explain":"…"}
- {"kind":"order","prompt":"…","items":["step","step","step"],"explain":"…"}   (items in CORRECT order; all distinct)
- {"kind":"match","prompt":"…","pairs":[{"left":"…","right":"…"}],"explain":"…"}   (3-4 pairs; all lefts distinct, all rights distinct)
- {"kind":"scenario","situation":"a real situation from HIS life — school, training, his business","q":"…","choices":["…","…","…","…"],"answer":0,"explain":"…"}

Rules: every choice list has exactly one right answer and plausible wrong ones. Keep text tight — this is played on a phone. Ground it all in his material.

Return ONLY JSON: {"cards":[…]}

HIS MATERIAL:
${material}`;
      try {
        const raw = await ask(M.smart, sys, [{ role: "user", content: "Build the run." }], 10000, key, "lesson");
        const p = parseJson<{ cards?: Record<string, unknown>[] }>(raw, "lesson");
        const out: Record<string, unknown>[] = [];
        for (const c of (p.cards ?? [])) {
          const kind = String(c?.kind ?? "");
          const choices = Array.isArray(c?.choices) ? (c.choices as unknown[]).map(String).filter((x) => x.trim()) : [];
          const ansOk = () => { const a = Number(c?.answer); return Number.isFinite(a) && a >= 0 && a < choices.length; };
          if (kind === "teach" && String(c?.text ?? "").trim()) {
            const d = c.diagram as Record<string, unknown> | undefined;
            const items = Array.isArray(d?.items) ? (d!.items as unknown[]).map(String).filter((x) => x.trim()).slice(0, 6) : [];
            out.push({
              kind, text: String(c.text).slice(0, 900),
              diagram: d && ["flow", "compare", "cycle", "stack"].includes(String(d.kind)) && items.length >= 2
                ? { kind: String(d.kind), title: String(d.title ?? "").slice(0, 80), items } : null,
            });
          } else if ((kind === "mcq" || kind === "scenario") && choices.length >= 2 && ansOk()) {
            out.push({
              kind, q: String(c.q ?? "").slice(0, 300), situation: String(c.situation ?? "").slice(0, 400),
              choices: choices.slice(0, 4), answer: Math.floor(Number(c.answer)), explain: String(c.explain ?? "").slice(0, 300),
            });
          } else if (kind === "blank") {
            const answer = Array.isArray(c?.answer) ? (c.answer as unknown[]).map(String).filter((x) => x.trim()) : [];
            const prompt = String(c?.prompt ?? "");
            if (answer.length && (prompt.match(/___/g) ?? []).length === answer.length) {
              out.push({ kind, prompt: prompt.slice(0, 400), answer, explain: String(c.explain ?? "").slice(0, 300) });
            }
          } else if (kind === "order") {
            const items = Array.isArray(c?.items) ? (c.items as unknown[]).map(String).filter((x) => x.trim()) : [];
            // duplicates make the tap-to-build interaction unsolvable
            if (items.length >= 3 && new Set(items).size === items.length) {
              out.push({ kind, prompt: String(c.prompt ?? "").slice(0, 300), items: items.slice(0, 6), explain: String(c.explain ?? "").slice(0, 300) });
            }
          } else if (kind === "match") {
            const pairs = (Array.isArray(c?.pairs) ? c.pairs as Record<string, unknown>[] : [])
              .map((p2) => ({ left: String(p2?.left ?? ""), right: String(p2?.right ?? "") }))
              .filter((p2) => p2.left.trim() && p2.right.trim()).slice(0, 4);
            const lefts = new Set(pairs.map((p2) => p2.left)), rights = new Set(pairs.map((p2) => p2.right));
            if (pairs.length >= 3 && lefts.size === pairs.length && rights.size === pairs.length) {
              out.push({ kind, prompt: String(c.prompt ?? "").slice(0, 300), pairs, explain: String(c.explain ?? "").slice(0, 300) });
            }
          }
        }
        // never two of the same kind back to back
        const cards: Record<string, unknown>[] = [];
        for (const c of out) {
          if (cards.length && cards[cards.length - 1].kind === c.kind) {
            const swap = out.findIndex((x) => !cards.includes(x) && x.kind !== c.kind);
            if (swap >= 0) { cards.push(out[swap]); }
          }
          if (!cards.includes(c)) cards.push(c);
        }
        if (cards.length < 6) return err("That run came back too thin — try again.");
        return ok({ cards: cards.slice(0, 18) });
      } catch (e) { return err(friendly(e, "Couldn't build the run — try again.")); }
    }

    // ── tutor: notebook chat, grounded + Socratic ────────────────────────
    if (mode === "tutor") {
      const message = String(body.message ?? "").slice(0, 4000);
      if (!message.trim()) return err("Ask something.");
      const history = (Array.isArray(body.history) ? body.history : []).slice(-8) as { role: string; content: unknown }[];
      const sys = `You are Ben's tutor for this notebook. He has ADHD — short, scannable, concrete, no lecturing.

HOW YOU TEACH
- Answer from HIS material below and SAY which source a claim came from when it matters. If something isn't in his material, say so plainly before answering from general knowledge.
- Compress: the 20% that gives 80%. Anchor new ideas to something he already knows.
- Don't hand over answers he could reach himself — give the smallest hint plus one question that gets him the rest.
- End with ONE retrieval question about what you just covered.
- Under 200 words unless he explicitly asks for depth.

HIS MATERIAL:
${material}`;
      const msgs = [...history, { role: "user", content: message }];
      while (msgs.length && msgs[0].role !== "user") msgs.shift();
      try {
        const text = await ask(M.smart, sys, msgs, 2000, key, "tutor");
        return ok({ text });
      } catch (e) { return err(friendly(e, "Couldn't answer that right now — try again.")); }
    }

    return err(`Unknown mode "${mode}".`);
  } catch (e) {
    console.error("[learn] fatal", e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
