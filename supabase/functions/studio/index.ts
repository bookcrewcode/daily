// Studio edge function — the notebook's study tools: exam · flashcards ·
// mindmap · study-guide · podcast. The teaching modes (syllabus / lesson /
// coach / tutor / grade) live in `learn`; the two files share the same helpers,
// copied rather than imported, because deploy pastes ONE file.
//
// GROUNDING: every prompt sees an OUTLINE of all his sources plus passages
// pulled from two regions of the material (RPCs notebook_outline /
// search_chunks, run with the user's token so RLS applies). Passage numbers
// are for the model's reference only — none of these outputs show citations,
// so any [n] marker is stripped before parsing.
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
        console.error(`[studio:${tag}] upstream ${r.status} model=${model} body=${raw.slice(0, 400)}`);
        throw new Error(`HTTP_${r.status}:${raw.slice(0, 200)}`);
      }
      const d = JSON.parse(raw);
      const text = String(d?.choices?.[0]?.message?.content ?? "");
      if (!text.trim()) {
        console.error(`[studio:${tag}] empty content model=${model} finish=${d?.choices?.[0]?.finish_reason} usage=${JSON.stringify(d?.usage ?? {})}`);
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
    if (!r.ok) { console.error(`[studio:${tag}] anthropic ${r.status} ${raw.slice(0, 300)}`); throw new Error(`HTTP_${r.status}`); }
    const d = JSON.parse(raw);
    const t = (d.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    if (!t.trim()) throw new Error("EMPTY");
    return t;
  };
  try { return await once(maxTokens, true); }
  catch (e) {
    const m = e instanceof Error ? e.message : "";
    // a 4xx often means the reasoning field itself was rejected — drop it
    if (m.startsWith("HTTP_4")) { console.error(`[studio:${tag}] retrying without reasoning field`); return await once(maxTokens, false); }
    if (m === "EMPTY") { console.error(`[studio:${tag}] retrying with ${maxTokens * 2} tokens`); return await once(maxTokens * 2, false); }
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
  console.error(`[studio:${tag}] unparseable: ${s.slice(0, 300)}`);
  throw new Error(`BADJSON:${s.slice(0, 120)}`);
}

// ── his material: outline + retrieval over the chunk RPCs (user token → RLS) ──
type C = Record<string, unknown>;
type Chunk = { id: string; text: string };
const S = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const hdr = (token: string) => ({ apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function rpc<T>(token: string, fn: string, args: C): Promise<T | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: hdr(token), body: JSON.stringify(args) });
    if (!r.ok) { console.error(`[studio] rpc ${fn} ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
    return await r.json() as T;
  } catch (e) { console.error(`[studio] rpc ${fn}`, e instanceof Error ? e.message : e); return null; }
}

// One line per source, every source survives; headings get half the budget,
// the opening fills the rest.
async function outline(token: string, nbId: string): Promise<{ text: string; sources: number; chunks: number; failed: boolean }> {
  type Row = { title: string; kind: string; week: number | null; page_count: number; chunk_count: number; headings: string[] | null; opening: string | null };
  const rows = await rpc<Row[]>(token, "notebook_outline", { p_notebook_id: nbId });
  if (!rows) return { text: "", sources: 0, chunks: 0, failed: true };
  const per = Math.floor(24000 / Math.max(1, rows.length));
  const lines = rows.map((s) => {
    const head = `SOURCE: "${S(s.title, 120)}" (${s.kind}${s.week != null ? `, week ${s.week}` : ""}${s.page_count ? `, ${s.page_count} pages` : ""}, ${s.chunk_count} passages)`;
    let left = Math.max(0, per - head.length);
    const hs = (s.headings ?? []).map((h) => S(h, 80)).filter(Boolean).join(" | ").slice(0, Math.floor(left / 2));
    left -= hs.length;
    const op = S(s.opening, Math.max(0, left - 20));
    return head + (hs ? `\n  headings: ${hs}` : "") + (op ? `\n  opens: ${op}` : "");
  });
  return { text: lines.join("\n"), sources: rows.length, chunks: rows.reduce((n, s) => n + (s.chunk_count || 0), 0), failed: false };
}

// Passages numbered [1]..[n]. Whole-notebook tools pass two positions so the
// padding comes from two regions of the material instead of just the start.
async function retrieve(token: string, nbId: string, query: string, limit = 24, positions: (number | null)[] = [null]): Promise<{ text: string; chunks: Chunk[]; failed: boolean }> {
  type Row = { id: string; source_title: string; heading: string | null; page_no: number | null; text: string };
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const pos of positions) {
    const args: C = { p_notebook_id: nbId, p_query: query.slice(0, 400), p_limit: Math.ceil(limit / positions.length) };
    if (pos != null) args.p_pos = Math.max(0, Math.min(1, pos));
    const got = await rpc<Row[]>(token, "search_chunks", args);
    if (!got) return { text: "", chunks: [], failed: true };
    for (const r of got) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
  }
  const chunks: Chunk[] = [], parts: string[] = [];
  let budget = 36000;
  for (const r of rows) {
    if (budget < 300) break;
    const text = String(r.text ?? "").slice(0, Math.min(1500, budget));
    budget -= text.length + 80;
    chunks.push({ id: r.id, text });
    parts.push(`[${chunks.length}] ("${S(r.source_title, 80)}"${r.page_no ? ` · p.${r.page_no}` : ""}${r.heading ? ` · ${S(r.heading, 80)}` : ""})\n${text}`);
  }
  return { text: parts.join("\n\n"), chunks, failed: false };
}

// Everything a prompt needs about the notebook. A notebook whose chunker
// hasn't run yet still gets its raw text.
async function material(token: string, nbId: string, query: string, limit = 24, positions: (number | null)[] = [null]): Promise<{ text: string; sources: number; failed: boolean }> {
  const o = await outline(token, nbId);
  if (o.failed) return { text: "", sources: 0, failed: true };
  if (!o.sources) return { text: "(no sources in this notebook yet)", sources: 0, failed: false };
  if (!o.chunks) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/notebook_sources?notebook_id=eq.${nbId}&select=title,content&order=created_at.desc&limit=20`, { headers: hdr(token) });
      if (!r.ok) return { text: "", sources: o.sources, failed: true };
      const raw = ((await r.json()) as { title: string; content: string }[]).map((s) => `--- "${S(s.title, 120)}" ---\n${s.content ?? ""}`).join("\n\n").slice(0, 30000);
      return { text: `NOTE: these sources aren't indexed into passages yet, so here is the raw text.\n\n${raw}`, sources: o.sources, failed: false };
    } catch { return { text: "", sources: o.sources, failed: true }; }
  }
  const r = await retrieve(token, nbId, query, limit, positions);
  if (r.failed) return { text: "", sources: o.sources, failed: true };
  return { text: `OUTLINE OF HIS SOURCES:\n${o.text}${r.text ? `\n\nPASSAGES:\n${r.text}` : ""}`, sources: o.sources, failed: false };
}

const CITE_RULE = "Use ONLY facts the outline and numbered passages support; never invent a fact, a number or a passage.";
// Ben's bar: nothing he has to already know to read it
const PLAIN = "PLAIN WORDS: write for a smart 15-year-old with zero prior knowledge; the FIRST time any technical word appears, put its meaning in parentheses right after it, like \"marginal cost (the extra cost of making one more unit)\" — never use a term you haven't defined this way.";
const SPREAD = [0.25, 0.75];
// none of these outputs show citations, so a stray "[3]" is noise to the reader
const noCites = (s: string) => s.replace(/\s*\[(?:chunk:)?\d{1,3}(?:\s*,\s*\d{1,3})*\]/g, "");
// models sometimes hand back an object where a string was asked for — show
// its words, never "[object Object]"
const label = (v: unknown, n: number) => { const o = v as C | null; return S(typeof o === "object" && o ? o.label ?? o.title ?? o.text ?? o.name : v, n); };
const misLine = (v: unknown) => {
  const o = v as C | null;
  if (typeof o !== "object" || !o) return S(v, 300);
  const wrong = S(o.wrong ?? o.misconception ?? o.belief ?? o.myth, 200), right = S(o.correction ?? o.right ?? o.fix ?? o.truth, 200);
  return wrong && right ? `${wrong} → ${right}` : wrong || right;
};

// YouTube ids straight from a model are unreliable; oEmbed is the cheap,
// unauthenticated "does this video exist, and is it the one claimed" check.
type Cand = { id: string; title: string; channel: string; why: string };
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "what", "your", "they", "them", "then", "than", "when", "there", "their", "have", "will", "were", "into", "about", "over", "more", "most", "some", "only", "also", "just", "like", "very", "which", "while", "where", "every", "each", "both", "been", "does", "part", "video"]);
const sig = (s: string) => new Set(s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
const cands = (v: unknown): Cand[] => {
  const seen = new Set<string>();
  return (arr(v) as C[]).flatMap((x) => {
    const id = String(x?.id ?? "").trim().match(/(?:v=|youtu\.be\/|^)([A-Za-z0-9_-]{11})(?:[&?#]|$)/)?.[1] ?? "";
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, title: S(x.title, 160), channel: S(x.channel, 80), why: S(x.why, 240) }];
  });
};
async function verify(c: Cand): Promise<{ v: Cand | null; reached: boolean }> {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${c.id}&format=json`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { v: null, reached: true };
    const j = (await r.json()) as { title?: unknown; author_name?: unknown };
    const title = S(j.title, 160), channel = S(j.author_name, 80);
    if (!title) return { v: null, reached: true };
    const want = sig(c.title);
    const shared = [...sig(title)].filter((w) => want.has(w)).length;
    const same = shared >= 2 || (!!channel && channel.toLowerCase() === c.channel.toLowerCase());
    // YouTube's own title/channel, never the model's
    return { v: same ? { id: c.id, title, channel, why: c.why } : null, reached: true };
  } catch { return { v: null, reached: false }; }
}

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
    if (!["exam", "flashcards", "mindmap", "study-guide", "podcast", "videos"].includes(mode)) return err(`Unknown mode "${mode}".`);
    if (!nbId) return err("Which notebook?");
    const M = await models(token);
    const title = S(body.title, 120) || "this notebook";

    // Every tool is grounded in his material; a failed read is reported, never
    // dressed up as "no sources".
    const ground = async (query: string, positions: (number | null)[]) => {
      const m = await material(token, nbId, query, 24, positions);
      if (m.failed) return { text: "", error: "Couldn't read your sources just now — try again in a moment." };
      if (!m.sources) return { text: "", error: "Add sources to this notebook first — everything here is built from your own material." };
      return { text: m.text, error: "" };
    };
    const run = async <T,>(sys: string, user: string, budget: number, tag: string) => parseJson<T>(noCites(await ask(M.smart, sys, [{ role: "user", content: user }], budget, key, tag)), tag);

    // ── videos: real explainers for one chapter, verified against YouTube,
    // transcripts cached so `learn` can cut clips from them ──────────────
    if (mode === "videos") {
      const chapterId = isUuid(String(body.chapterId ?? "")) ? String(body.chapterId) : "";
      const ct = S(body.chapterTitle, 120), co = S(body.chapterObjective, 240), cs = S(body.chapterSummary, 300);
      if (!chapterId || !ct) return err("Which chapter?");
      const suggest = async (): Promise<Cand[]> => {
        const sys = `Suggest up to 8 REAL YouTube videos that teach EXACTLY this idea to a complete beginner — chapter "${ct}": ${co}${cs ? ` (${cs})` : ""}. Prefer well-known teaching channels: 3Blue1Brown, Khan Academy, CrashCourse, Professor Leonard, Veritasium, MinutePhysics, Marginal Revolution University, The Organic Chemistry Tutor, Kurzgesagt, TED-Ed. Only videos you are confident exist, with their exact title and channel name; "why" is one plain sentence on what the video explains.

Return ONLY JSON: {"videos":[{"id":"the 11-character YouTube id","title":"…","channel":"…","why":"…"}]}`;
        return cands((await run<{ videos?: unknown }>(sys, "Suggest the videos.", 2000, "videos")).videos).slice(0, 8);
      };
      const check = async (list: Cand[]) => {
        const rs = await Promise.all(list.map(verify));
        return { kept: rs.map((r) => r.v).filter((v): v is Cand => !!v).slice(0, 4), reached: !list.length || rs.some((r) => r.reached) };
      };
      try {
        const existing = cands(body.existing);
        let list = existing, fromModel = false;
        if (!list.length) { list = await suggest(); fromModel = true; }
        let { kept, reached } = await check(list);
        // hand-picked ids YouTube no longer serves → ask the model rather than save nothing
        if (!kept.length && reached && !fromModel) { list = await suggest(); ({ kept, reached } = await check(list)); }
        if (!reached) return err("Couldn't reach YouTube to check the videos — try again in a moment.");
        console.error(`[studio:videos] kept ${kept.length}/${list.length} for "${ct}"`);

        // transcripts: reuse the shared cache; fetch what's missing (or failed
        // more than a week ago) through the transcript function as this user
        let withTranscripts = 0;
        if (kept.length) {
          type TRow = { video_id: string; segments: unknown; error: string | null; fetched_at: string | null };
          const tr = await fetch(`${SUPABASE_URL}/rest/v1/video_transcripts?video_id=in.(${kept.map((v) => v.id).join(",")})&select=video_id,segments,error,fetched_at`, { headers: hdr(token) });
          if (!tr.ok) console.error(`[studio:videos] transcript cache read ${tr.status}`);
          const rows = tr.ok ? ((await tr.json()) as TRow[]) : [];
          const stale = (r: TRow | undefined) => !r || (!arr(r.segments).length && (!r.error || !r.fetched_at || Date.now() - Date.parse(r.fetched_at) > 7 * 86400_000));
          const pass = { Authorization: req.headers.get("Authorization") ?? "", apikey: req.headers.get("apikey") ?? ANON, "Content-Type": "application/json" };
          const got = await Promise.all(kept.map(async (v) => {
            const row = rows.find((r) => r.video_id === v.id);
            if (!stale(row)) return arr(row?.segments).length > 0;
            let segments: unknown[] = [], error = "";
            try {
              const r = await fetch(`${SUPABASE_URL}/functions/v1/transcript`, { method: "POST", headers: pass, body: JSON.stringify({ url: v.id }), signal: AbortSignal.timeout(25_000) });
              const j = r.ok ? ((await r.json()) as { segments?: unknown; error?: unknown }) : { error: `HTTP ${r.status}` };
              segments = arr(j.segments);
              error = segments.length ? "" : S(j.error, 300) || "no captions";
            } catch (e) { error = e instanceof Error && e.name === "TimeoutError" ? "timed out after 25s" : "transcript request failed"; }
            const last = segments[segments.length - 1] as { s?: number; d?: number } | undefined;
            try {
              const up = await fetch(`${SUPABASE_URL}/rest/v1/video_transcripts?on_conflict=video_id`, {
                method: "POST", headers: { ...hdr(token), Prefer: "resolution=merge-duplicates,return=minimal" },
                body: JSON.stringify({ video_id: v.id, title: v.title, channel: v.channel, duration_s: Math.round(Number(last?.s ?? 0) + Number(last?.d ?? 0)), segments, error, fetched_at: new Date().toISOString() }),
              });
              if (!up.ok) { console.error(`[studio:videos] transcript cache write ${up.status} ${(await up.text()).slice(0, 200)}`); return false; }
            } catch (e) { console.error("[studio:videos] transcript cache write", e instanceof Error ? e.message : e); return false; }
            return segments.length > 0;
          }));
          withTranscripts = got.filter(Boolean).length;
        }

        // clips_ready even when transcripts failed — a lesson simply attaches no
        // clip from that video. Nothing verified never wipes hand-picked videos.
        const p = await fetch(`${SUPABASE_URL}/rest/v1/notebook_chapters?id=eq.${chapterId}&select=id`, {
          method: "PATCH", headers: { ...hdr(token), Prefer: "return=representation" },
          body: JSON.stringify({ videos: kept.length ? kept : existing, clips_ready: true }),
        });
        if (!p.ok || !((await p.json()) as unknown[]).length) {
          console.error(`[studio:videos] chapter PATCH ${p.status}`);
          return err("Found the videos but couldn't save them to the chapter — try again.");
        }
        return ok({ videos: kept, withTranscripts, ready: true });
      } catch (e) { return err(friendly(e, "Couldn't find videos for this chapter — try again.")); }
    }

    // ── exam: whole-notebook free recall ─────────────────────────────────
    if (mode === "exam") {
      const n = Math.max(4, Math.min(10, Number(body.n) || 8));
      const focus = S(body.focus, 200);
      const g = await ground(focus, focus ? [null] : SPREAD);
      if (g.error) return err(g.error);
      const sys = `Write a ${n}-question free-recall exam over Ben's material${focus ? ` focused on "${focus}"` : ""}. Open-ended, answered from memory in a few sentences. Spread across the WHOLE body of material, mixing recall with "why does this matter" reasoning. No multiple choice. ${PLAIN} ${CITE_RULE}

Return ONLY JSON: {"questions":[{"q":"…","expected":"what a correct answer must contain"}]}

HIS MATERIAL:
${g.text}

(${CITE_RULE})`;
      try {
        const p = await run<{ questions?: C[] }>(sys, "Write the exam.", 4000, "exam");
        const questions = arr(p.questions).filter((q) => typeof (q as C)?.q === "string").slice(0, n).map((q) => ({
          q: S((q as C).q, 400), expected: S((q as C).expected, 600),
        }));
        if (!questions.length) return err("Couldn't write the exam — try again.");
        return ok({ questions });
      } catch (e) { return err(friendly(e, "Couldn't write the exam — try again.")); }
    }

    // ── flashcards: whole notebook, one chapter, or a focus ──────────────
    if (mode === "flashcards") {
      const n = Math.max(8, Math.min(24, Number(body.n) || 16));
      const chapterId = isUuid(String(body.chapterId ?? "")) ? String(body.chapterId) : "";
      let focus = S(body.focus, 200);
      if (chapterId && !focus) {
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/notebook_chapters?id=eq.${chapterId}&select=title,objective`, { headers: hdr(token) });
          const ch = r.ok ? ((await r.json()) as { title: string; objective: string }[])[0] : null;
          if (ch) focus = `${ch.title} ${ch.objective ?? ""}`.trim().slice(0, 200);
        } catch { /* fall back to the whole notebook */ }
      }
      const g = await ground(focus, focus ? [null] : SPREAD);
      if (g.error) return err(g.error);
      const sys = `Write ${n} flashcards from Ben's material${focus ? ` about "${focus}"` : ""}. Proven card rules: ONE fact per card, front is a real question (never "X?"), back is short enough to say out loud, no card that can be answered by pattern-matching the wording. "hint" is a nudge, or "". ${PLAIN} ${CITE_RULE}

Return ONLY JSON: {"cards":[{"front":"…","back":"…","hint":"…"}]}

HIS MATERIAL:
${g.text}

(${CITE_RULE})`;
      try {
        const p = await run<{ cards?: C[] }>(sys, "Write the flashcards.", 5000, "cards");
        const cards = arr(p.cards).filter((c) => typeof (c as C)?.front === "string" && typeof (c as C)?.back === "string").slice(0, n).map((c) => ({
          front: S((c as C).front, 300), back: S((c as C).back, 500), hint: S((c as C).hint, 200),
        }));
        if (!cards.length) return err("Couldn't write the cards — try again.");
        return ok({ cards });
      } catch (e) { return err(friendly(e, "Couldn't write the cards — try again.")); }
    }

    // ── mindmap ──────────────────────────────────────────────────────────
    if (mode === "mindmap") {
      const g = await ground(title, SPREAD);
      if (g.error) return err(g.error);
      const sys = `Map Ben's material as a tree: the ROOT idea, 3-6 branches, 2-5 leaves each. Short labels (2-6 words). The shape should show how the ideas actually depend on each other, not just categories. ${CITE_RULE}

Return ONLY JSON: {"root":"…","branches":[{"label":"…","children":["…"]}]}

HIS MATERIAL (notebook: ${title}):
${g.text}

(${CITE_RULE})`;
      try {
        const p = await run<{ root?: string; branches?: C[] }>(sys, "Build the map.", 3000, "map");
        const branches = arr(p.branches).filter((b) => (b as C)?.label).slice(0, 6).map((b) => ({
          label: S((b as C).label, 80),
          children: arr((b as C).children).map((c) => label(c, 80)).filter(Boolean).slice(0, 6),
        }));
        if (!branches.length) return err("Couldn't build the map — try again.");
        return ok({ root: S(p.root, 90) || title, branches });
      } catch (e) { return err(friendly(e, "Couldn't build the map — try again.")); }
    }

    // ── study guide ──────────────────────────────────────────────────────
    if (mode === "study-guide") {
      const g = await ground(title, SPREAD);
      if (g.error) return err(g.error);
      const sys = `You are writing a genuinely useful STUDY GUIDE for Ben's notebook "${title}", from his OWN material — the thing he reads before an exam. He has ADHD and learns by first principles (trunk before leaves), the vital 20%, and analogies anchored to what he already knows. Clear, concrete, zero filler.
- tldr: 3-4 sentences, the whole notebook compressed in plain language.
- trunk: the ONE root idea everything else hangs off, one sentence.
- big_ideas: 5-7 {title, point} — point is 3-5 sentences that actually TEACH it, with a concrete example or analogy.
- key_terms: 6-12 {term, definition} — definitions in plain language.
- misconceptions: 2-4 lines, each "a common wrong belief → the correction".
- so_what: 2-3 sentences on why it matters and how to use it.
${PLAIN}
${CITE_RULE}

Return ONLY JSON with exactly those keys.

HIS MATERIAL:
${g.text}

(${CITE_RULE})`;
      try {
        const g2 = await run<C>(sys, "Write the study guide.", 6000, "guide");
        const list = (k: string) => arr(g2[k]) as C[];
        const guide = {
          tldr: S(g2.tldr, 1400),
          trunk: S(g2.trunk, 500),
          big_ideas: list("big_ideas").slice(0, 8).map((b) => ({ title: S(b.title, 120), point: S(b.point, 900) })),
          key_terms: list("key_terms").slice(0, 12).map((t) => ({ term: S(t.term, 80), definition: S(t.definition, 400) })),
          misconceptions: arr(g2.misconceptions).map(misLine).filter(Boolean).slice(0, 6),
          so_what: S(g2.so_what, 900),
        };
        if (!guide.big_ideas.length) return err("Couldn't build the study guide — try again.");
        return ok({ guide });
      } catch (e) { return err(friendly(e, "Couldn't build the study guide — try again.")); }
    }

    // ── podcast: two-host audio overview, rendered on-device ─────────────
    if (mode === "podcast") {
      const focus = S(body.chapterTitle, 200);
      const g = await ground(focus, focus ? [null] : SPREAD);
      if (g.error) return err(g.error);
      const sys = `Write a two-host audio-overview podcast (like NotebookLM's) teaching Ben's material${focus ? ` focused on: "${focus}"` : ""}. Two hosts: A (warm, curious, asks the questions a smart beginner would) and B (clear, explains well, uses analogies). Natural SPOKEN conversation — contractions, short turns, a little back-and-forth, no stage directions or sound cues. Teach the real substance from the material below, trunk first, the vital 20%. 18-34 turns total. ${PLAIN} ${CITE_RULE}

Return ONLY JSON: {"title":"short episode title","segments":[{"speaker":"A","text":"what they say"}]}

HIS MATERIAL:
${g.text}

(${CITE_RULE})`;
      try {
        const p = await run<{ title?: string; segments?: C[] }>(sys, "Write the episode.", 6000, "podcast");
        const segments = arr(p.segments).slice(0, 60)
          .map((s) => ({ speaker: (s as C)?.speaker === "B" ? "B" : "A", text: S((s as C)?.text, 1200) }))
          .filter((s) => s.text);
        if (segments.length < 2) return err("Couldn't write the episode — try again.");
        return ok({ title: S(p.title, 160) || "Audio overview", segments });
      } catch (e) { return err(friendly(e, "Couldn't write the episode right now — try again.")); }
    }

    return err(`Unknown mode "${mode}".`);
  } catch (e) {
    console.error("[studio] fatal", e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
