// Studio edge function — the notebook's study tools: exam · flashcards ·
// mindmap · study-guide · podcast · syllabus · grade, plus `videos` (real
// explainers for a chapter) and `prep` (the cron job that writes runs ahead
// of time). The round itself (lesson / coach / tutor) lives in `learn`; the
// helpers are copied, not imported, because deploy pastes ONE file (≤ 44 KB).
//
// GROUNDING: every prompt sees an OUTLINE of all his sources plus passages
// from two regions of the material (RPCs notebook_outline / search_chunks,
// run with the user's token so RLS applies). No output here shows citations,
// so any [n] marker is stripped before parsing.
//
// SERVICE MODE: pg_cron calls `prep` with {secret, userId}; the secret is
// checked against the vault, every call then runs with the service key and
// the RPCs are scoped by p_user_id. `prep` calls `learn` the same way.
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

// vault secrets via the service-role-only get_secret RPC, cached a minute; a
// missing secret is "" and can never match a caller's
const sc = new Map<string, { v: string; at: number }>();
async function secretOf(name: string): Promise<string> {
  const c = sc.get(name);
  if (c && Date.now() - c.at < 60_000) return c.v;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ secret_name: name }),
    });
    if (r.ok) { const v = ((await r.json()) as string | null) ?? ""; if (v) { sc.set(name, { v, at: Date.now() }); return v; } }
  } catch { /* fall through */ }
  return c?.v ?? "";
}
const apiKey = async () => (await secretOf("anthropic_api_key")) || ENV_KEY;

async function getUser(token: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function models(token: string, uid: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?select=ai_models&user_id=eq.${uid}`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    if (!r.ok) return { smart: D_SMART, fast: D_FAST };
    const m = (await r.json())?.[0]?.ai_models ?? {};
    return { smart: okModel(m.smart) ? m.smart : D_SMART, fast: okModel(m.fast) ? m.fast : D_FAST };
  } catch { return { smart: D_SMART, fast: D_FAST }; }
}

// ONE call path for every mode. A small thinking allowance on top of the
// answer budget (OpenRouter needs max_tokens to EXCEED it), one retry with
// more room, and every upstream failure logged with its real body.
const THINK = 1024;
async function ask(model: string, sys: string, msgs: { role: string; content: unknown }[], maxTokens: number, key: string, tag: string): Promise<string> {
  const once = async (budget: number, reasoning: Record<string, unknown>): Promise<string> => {
    if (isOR(key)) {
      const r = await fetch(`${OR_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: budget + THINK, reasoning: { ...reasoning, exclude: true }, messages: [{ role: "system", content: sys }, ...msgs] }),
      });
      const raw = await r.text();
      if (!r.ok) {
        console.error(`[studio:${tag}] upstream ${r.status} model=${model} body=${raw.slice(0, 400)}`);
        throw new Error(`HTTP_${r.status}:${raw.slice(0, 200)}`);
      }
      const d = JSON.parse(raw);
      const text = String(d?.choices?.[0]?.message?.content ?? "");
      const u = d?.usage ?? {};
      if (!text.trim()) {
        console.error(`[studio:${tag}] empty content model=${model} finish=${d?.choices?.[0]?.finish_reason} usage=${JSON.stringify(u)}`);
        throw new Error("EMPTY");
      }
      console.error(`[studio:${tag}] usage prompt=${u.prompt_tokens ?? "?"} completion=${u.completion_tokens ?? "?"} reasoning=${u.completion_tokens_details?.reasoning_tokens ?? 0}`);
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
    console.error(`[studio:${tag}] usage prompt=${d.usage?.input_tokens ?? "?"} completion=${d.usage?.output_tokens ?? "?"}`);
    return t;
  };
  const think = { max_tokens: THINK };
  try { return await once(maxTokens, think); }
  catch (e) {
    const m = e instanceof Error ? e.message : "";
    // a 4xx usually means this model refuses a token-counted thinking budget —
    // ask for low effort instead; the field itself is never dropped
    if (m.startsWith("HTTP_4")) { console.error(`[studio:${tag}] retrying with effort=low`); return await once(maxTokens, { effort: "low" }); }
    if (m === "EMPTY") { console.error(`[studio:${tag}] retrying with ${maxTokens * 2} tokens`); return await once(maxTokens * 2, think); }
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
const strs = (v: unknown, n: number) => arr(v).map((x) => S(x, n)).filter(Boolean);
const hdr = (token: string) => ({ apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

// `uid` is set only in service mode: the RPCs then scope to that user themselves
async function rpc<T>(token: string, fn: string, args: C, uid = ""): Promise<T | null> {
  try {
    if (uid) args.p_user_id = uid;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: hdr(token), body: JSON.stringify(args) });
    if (!r.ok) { console.error(`[studio] rpc ${fn} ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
    return await r.json() as T;
  } catch (e) { console.error(`[studio] rpc ${fn}`, e instanceof Error ? e.message : e); return null; }
}

// One line per source, every source survives; headings get half the budget,
// the opening fills the rest.
async function outline(token: string, nbId: string, uid = ""): Promise<{ text: string; sources: number; chunks: number; failed: boolean }> {
  type Row = { title: string; kind: string; week: number | null; page_count: number; chunk_count: number; headings: string[] | null; opening: string | null };
  const rows = await rpc<Row[]>(token, "notebook_outline", { p_notebook_id: nbId }, uid);
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
async function retrieve(token: string, nbId: string, query: string, limit = 24, positions: (number | null)[] = [null], uid = ""): Promise<{ text: string; chunks: Chunk[]; failed: boolean }> {
  type Row = { id: string; source_title: string; heading: string | null; page_no: number | null; text: string };
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const pos of positions) {
    const args: C = { p_notebook_id: nbId, p_query: query.slice(0, 400), p_limit: Math.ceil(limit / positions.length) };
    if (pos != null) args.p_pos = Math.max(0, Math.min(1, pos));
    const got = await rpc<Row[]>(token, "search_chunks", args, uid);
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
// hasn't run yet still gets its raw text. limit 0 = the outline alone.
async function material(token: string, nbId: string, query: string, limit = 24, positions: (number | null)[] = [null], uid = ""): Promise<{ text: string; sources: number; failed: boolean }> {
  const o = await outline(token, nbId, uid);
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
  const r = limit > 0 ? await retrieve(token, nbId, query, limit, positions, uid) : { text: "", failed: false };
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
    if (!r.ok) { console.error(`[studio:videos] rejected ${c.id} "${c.title}": oEmbed ${r.status}`); return { v: null, reached: true }; }
    const j = (await r.json()) as { title?: unknown; author_name?: unknown };
    const title = S(j.title, 160), channel = S(j.author_name, 80);
    const want = sig(c.title);
    const shared = [...sig(title)].filter((w) => want.has(w)).length;
    const same = !!title && (shared >= 2 || (!!channel && channel.toLowerCase() === c.channel.toLowerCase()));
    // a retitled or mistaken id shows up here, with what YouTube actually serves
    if (!same) console.error(`[studio:videos] rejected ${c.id}: model said "${c.title}" (${c.channel}), YouTube says "${title}" (${channel})`);
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
    if (m === "EMPTY") return "The model came back empty — tap to try again.";
    if (m.startsWith("HTTP_402") || m.includes("credit")) return "Your OpenRouter credits are out — top up and try again.";
    if (m.startsWith("HTTP_401")) return "OpenRouter rejected the key — re-paste it in Settings → AI key.";
    if (m.startsWith("HTTP_")) return `The model provider errored (${m.slice(0, 60)}) — try again.`;
    return m || fallback;
  };

  try {
    const body = await req.json();
    // service mode: {secret, userId} from pg_cron / prep → act as that user with the service key
    const svc = typeof body.secret === "string" && body.secret && isUuid(String(body.userId ?? "")) && body.secret === await secretOf("learn_prep_secret") ? String(body.userId) : "";
    const token = svc ? SERVICE_KEY : (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const user = svc ? { id: svc } : await getUser(token);
    if (!user?.id) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const key = await apiKey();
    if (!key) return err("No AI key set — open Settings → AI key and paste your OpenRouter key.");

    const mode = String(body.advisor ?? body.mode ?? "");
    const nbId = isUuid(String(body.topicId ?? "")) ? String(body.topicId) : "";
    if (!["exam", "flashcards", "mindmap", "study-guide", "podcast", "videos", "syllabus", "grade", "prep"].includes(mode)) return err(`Unknown mode "${mode}".`);
    // grade judges answers it is handed; prep walks every notebook
    if (!nbId && mode !== "grade" && mode !== "prep") return err("Which notebook?");
    const M = await models(token, user.id);
    const title = S(body.title, 120) || "this notebook";

    // Every tool is grounded in his material; a failed read is reported, never
    // dressed up as "no sources".
    const ground = async (query: string, positions: (number | null)[], limit = 24) => {
      const m = await material(token, nbId, query, limit, positions, svc);
      if (m.failed) return { text: "", error: "Couldn't read your sources just now — try again in a moment." };
      if (!m.sources) return { text: "", error: "Add sources to this notebook first — everything here is built from your own material." };
      return { text: m.text, error: "" };
    };
    const run = async <T,>(sys: string, user: string, budget: number, tag: string) => parseJson<T>(noCites(await ask(M.smart, sys, [{ role: "user", content: user }], budget, key, tag)), tag);

    // ── videos for one chapter: model candidates → verified against YouTube →
    // transcripts cached so `learn` can cut clips → chapter row updated.
    // Shared by the `videos` mode and `prep`.
    type Ch = { id: string; title: string; objective: string; summary: string; videos: unknown };
    const findVideos = async (ch: Ch): Promise<{ videos: Cand[]; withTranscripts: number; ready: boolean; error: string }> => {
      const fail = (error: string) => ({ videos: [] as Cand[], withTranscripts: 0, ready: false, error });
      const suggest = async (): Promise<Cand[]> => {
        const sys = `Suggest up to 8 REAL YouTube videos that teach EXACTLY this idea to a complete beginner — chapter "${ch.title}": ${ch.objective}${ch.summary ? ` (${ch.summary})` : ""}. Prefer these channels in order: 3Blue1Brown, Veritasium, Kurzgesagt, TED-Ed, CrashCourse, Stated Clearly, Marginal Revolution University, Khan Academy, TED. Only videos you are confident exist, with their exact title and channel name; "why" is one plain sentence on what the video explains.

Return ONLY JSON: {"videos":[{"id":"the 11-character YouTube id","title":"…","channel":"…","why":"…"}]}`;
        return cands((await run<{ videos?: unknown }>(sys, "Suggest the videos.", 3000, "videos")).videos).slice(0, 8);
      };
      const check = async (list: Cand[]) => {
        const rs = await Promise.all(list.map(verify));
        return { kept: rs.map((r) => r.v).filter((v): v is Cand => !!v).slice(0, 4), reached: !list.length || rs.some((r) => r.reached) };
      };
      try {
        const existing = cands(ch.videos);
        let list = existing, fromModel = false;
        if (!list.length) { list = await suggest(); fromModel = true; }
        let { kept, reached } = await check(list);
        // hand-picked ids YouTube no longer serves → ask the model rather than save nothing
        if (!kept.length && reached && !fromModel) { list = await suggest(); ({ kept, reached } = await check(list)); }
        if (!reached) return fail("Couldn't reach YouTube to check the videos — try again in a moment.");
        console.error(`[studio:videos] kept ${kept.length}/${list.length} for "${ch.title}"`);

        // transcripts: reuse the shared cache; fetch what's missing (or failed
        // more than a day ago) through the transcript function as this user
        let withTranscripts = 0, ready = false;
        if (kept.length) {
          type TRow = { video_id: string; segments: unknown; error: string | null; fetched_at: string | null };
          const tr = await fetch(`${SUPABASE_URL}/rest/v1/video_transcripts?video_id=in.(${kept.map((v) => v.id).join(",")})&select=video_id,segments,error,fetched_at`, { headers: hdr(token) });
          if (!tr.ok) console.error(`[studio:videos] transcript cache read ${tr.status}`);
          const rows = tr.ok ? ((await tr.json()) as TRow[]) : [];
          const stale = (r: TRow | undefined) => !r || (!arr(r.segments).length && (!r.error || !r.fetched_at || Date.now() - Date.parse(r.fetched_at) > 86400_000));
          const pass = { Authorization: `Bearer ${token}`, apikey: svc ? SERVICE_KEY : req.headers.get("apikey") ?? ANON, "Content-Type": "application/json" };
          // cue count per kept video (0 = no usable transcript)
          const cues = await Promise.all(kept.map(async (v): Promise<number> => {
            const row = rows.find((r) => r.video_id === v.id);
            if (!stale(row)) return arr(row?.segments).length;
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
              if (!up.ok) { console.error(`[studio:videos] transcript cache write ${up.status} ${(await up.text()).slice(0, 200)}`); return 0; }
            } catch (e) { console.error("[studio:videos] transcript cache write", e instanceof Error ? e.message : e); return 0; }
            return segments.length;
          }));
          withTranscripts = cues.filter((n) => n > 0).length;
          // a clip needs a real transcript: ≥10 cues on at least one video
          ready = cues.some((n) => n >= 10);
        }

        // clips_ready only with a usable transcript; otherwise videos_tried_at
        // lets the client retry this step once a day. Nothing verified never
        // wipes hand-picked videos.
        const p = await fetch(`${SUPABASE_URL}/rest/v1/notebook_chapters?id=eq.${ch.id}&select=id`, {
          method: "PATCH", headers: { ...hdr(token), Prefer: "return=representation" },
          body: JSON.stringify({ videos: kept.length ? kept : existing, clips_ready: ready, ...(ready ? {} : { videos_tried_at: new Date().toISOString() }) }),
        });
        if (!p.ok || !((await p.json()) as unknown[]).length) {
          console.error(`[studio:videos] chapter PATCH ${p.status}`);
          return fail("Found the videos but couldn't save them to the chapter — try again.");
        }
        return { videos: kept, withTranscripts, ready, error: "" };
      } catch (e) { return fail(friendly(e, "Couldn't find videos for this chapter — try again.")); }
    };

    if (mode === "videos") {
      const chapterId = isUuid(String(body.chapterId ?? "")) ? String(body.chapterId) : "";
      const ct = S(body.chapterTitle, 120);
      if (!chapterId || !ct) return err("Which chapter?");
      const v = await findVideos({ id: chapterId, title: ct, objective: S(body.chapterObjective, 240), summary: S(body.chapterSummary, 300), videos: body.existing });
      return v.error ? err(v.error) : ok({ videos: v.videos, withTranscripts: v.withTranscripts, ready: v.ready });
    }

    // ── prep: the nightly job — write the next runs so every notebook opens
    // instantly. Sequential, ≤150s a chapter, honest per-chapter errors. ──
    if (mode === "prep") {
      if (!svc) return err("Prep runs from the nightly job only.");
      const max = Math.max(1, Math.min(10, Math.floor(Number(body.max) || 3)));
      const get = async <T,>(q: string): Promise<T[] | null> => {
        try { const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: hdr(token) }); if (!r.ok) console.error(`[studio:prep] read ${q.split("?")[0]} ${r.status}`); return r.ok ? (await r.json()) as T[] : null; } catch { return null; }
      };
      const nbs = await get<{ id: string }>(`notebooks?select=id&user_id=eq.${svc}&archived=eq.false&order=created_at.asc`);
      if (!nbs) return err("Couldn't read the notebooks — try again.");
      if (!nbs.length) return ok({ done: [], remaining: 0 });
      const inNb = `notebook_id=in.(${nbs.map((n) => n.id).join(",")})`;
      type Row = { id: string; notebook_id: string; idx: number; title: string; objective: string; summary: string; fade: number; quant: boolean; attempts: number; clips_ready: boolean; videos: unknown; run_at: string | null };
      // a chapter is CLAIMED (run_at stamped) before it's built, so a parallel
      // pass, or the next 6h of passes after a failed build, leave it alone;
      // refresh: runs older than 21 days count as missing
      const iso = (ago: number) => new Date(Date.now() - ago).toISOString();
      const unclaimed = `or(run_at.is.null,run_at.lt.${iso(6 * 3600_000)})`;
      const due = body.refresh === true ? `or=(and(run.is.null,${unclaimed}),run_at.lt.${iso(21 * 86400_000)})` : `run=is.null&${unclaimed.replace("or(", "or=(")}`;
      const [list, all, st, done] = await Promise.all([
        get<Row>(`notebook_chapters?select=id,notebook_id,idx,title,objective,summary,fade,quant,attempts,clips_ready,videos,run_at&${inNb}&${due}`),
        get<{ notebook_id: string }>(`notebook_chapters?select=notebook_id&${inNb}`),
        get<{ learn: C | null }>(`user_settings?select=learn&user_id=eq.${svc}`),
        get<{ notebook_ids: string[] | null }>(`study_sessions?select=notebook_ids&user_id=eq.${svc}&status=eq.done`),
      ]);
      if (!list || !all || !done) return err("Couldn't read the chapters — try again.");
      const interests = strs(st?.[0]?.learn?.interests, 80).slice(0, 6);
      // a notebook he has never finished a round in opens on the teach card, not a pretest
      const studied = new Set(done.flatMap((s) => s.notebook_ids ?? []));
      const order = new Map(nbs.map((n, i) => [n.id, i]));
      // never-tried first, in notebook order; anything claimed before goes to the back
      const at = (r: Row) => (r.run_at ? Date.parse(r.run_at) : 0);
      list.sort((a, b) => at(a) - at(b) || (order.get(a.notebook_id)! - order.get(b.notebook_id)!) || a.idx - b.idx);
      const out: C[] = [];
      for (const ch of list.slice(0, max)) {
        const t0 = Date.now();
        const row: C = { chapter_id: ch.id, title: ch.title, clips: "0/0", ms: 0 };
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/notebook_chapters?id=eq.${ch.id}`, { method: "PATCH", headers: { ...hdr(token), Prefer: "return=minimal" }, body: JSON.stringify({ run_at: new Date().toISOString() }) });
          if (!ch.clips_ready) { const v = await findVideos(ch); if (v.error) console.error(`[studio:prep] videos "${ch.title}": ${v.error}`); }
          const left = 150_000 - (Date.now() - t0);
          if (left < 5000) throw new Error("finding videos used the whole 150s");
          const r = await fetch(`${SUPABASE_URL}/functions/v1/learn`, {
            method: "POST", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(left),
            body: JSON.stringify({
              secret: body.secret, userId: svc, advisor: "lesson", force: true, topicId: ch.notebook_id, chapterId: ch.id, chapterTitle: ch.title, chapterObjective: ch.objective, chapterSummary: ch.summary,
              chapterPos: Math.min(1, ch.idx / Math.max(1, all.filter((c) => c.notebook_id === ch.notebook_id).length)), fade: ch.fade ?? 0, quant: !!ch.quant, n: 12,
              interests, noPretest: !ch.attempts && !studied.has(ch.notebook_id),
            }),
          });
          const j = r.ok ? (await r.json()) as { cards?: unknown; error?: string; cached?: boolean } : { error: `learn answered HTTP ${r.status}` };
          const cards = arr(j.cards) as C[];
          if (j.error || !cards.length) throw new Error(j.error || "no cards came back");
          row.clips = `${cards.filter((c) => c.clip).length}/${cards.filter((c) => c.kind === "teach").length}`;
          if (j.cached === false) row.error = "cards built but not saved to the chapter";
        } catch (e) { row.error = e instanceof Error && e.name === "TimeoutError" ? "timed out after 150s" : e instanceof Error ? e.message : "failed"; }
        row.ms = Date.now() - t0;
        console.error(`[studio:prep] "${ch.title}" clips=${row.clips} ms=${row.ms}${row.error ? ` error=${row.error}` : ""}`);
        out.push(row);
      }
      // remaining is re-read, not inferred; null says the count itself failed
      const left = await get<{ id: string }>(`notebook_chapters?select=id&${inNb}&run=is.null`);
      return ok({ done: out, remaining: left ? left.length : null });
    }

    // ── syllabus: design the chapters from the outline
    if (mode === "syllabus") {
      const kind = body.kind === "class" ? "class" : "personal";
      const existing = strs(body.existing, 90);
      const g = await ground("", [null], 0);
      if (g.error) return err(g.error);
      const sys = `You design the chapters of Ben's notebook "${title}" from an outline of HIS OWN sources. He has ADHD: concrete titles, one clear objective each.

KIND: ${kind === "class" ? "class — 8 to 16 chapters organised by week/topic in the order the course teaches them (use the source weeks and headings); set \"week\" when the sources say it" : "personal — 5 to 8 chapters, trunk first: chapter 1 is the root idea everything hangs on, each later chapter depends only on earlier ones"}.
- title: 2-6 words, concrete, no numbering. objective: ONE sentence starting with a verb — what he'll be able to DO. summary: one sentence on what it covers.
- ${PLAIN} Titles in plain words; the objective explains any technical word it uses.
- quant: true when the objective involves computing, deriving, solving or graphing.
- trunk: one sentence — the root idea of the whole notebook.
- Cover what is actually IN his material; never invent topics it doesn't support.${existing.length ? `\n- These chapters already exist — never reuse or rephrase them: ${existing.map((t) => `"${t}"`).join(", ")}` : ""}

Return ONLY JSON: {"trunk":"…","chapters":[{"title":"…","objective":"…","summary":"…","week":3,"quant":false}]}

HIS MATERIAL:
${g.text}`;
      try {
        const p = await run<{ trunk?: string; chapters?: C[] }>(sys, "Design the chapters.", 5000, "syllabus");
        const seen = new Set(existing.map((t) => t.toLowerCase()));
        const chapters: C[] = [];
        for (const c of arr(p.chapters) as C[]) {
          const t = S(c?.title, 90);
          if (!t || seen.has(t.toLowerCase())) continue;
          seen.add(t.toLowerCase());
          const week = Number(c.week);
          chapters.push({
            title: t, objective: S(c.objective, 220), summary: S(c.summary, 300), quant: c.quant === true,
            ...(Number.isInteger(week) && week > 0 && week < 40 ? { week } : {}),
          });
        }
        if (chapters.length < 2) return err("That came back too thin — try again.");
        return ok({ trunk: S(p.trunk, 300), chapters: chapters.slice(0, kind === "class" ? 16 : 8) });
      } catch (e) { return err(friendly(e, "Couldn't design the chapters — try again.")); }
    }

    // ── grade: judge free recall generously, on substance
    if (mode === "grade") {
      const items = arr(body.items).slice(0, 12);
      if (!items.length) return err("Nothing to grade.");
      const sys = `You grade Ben's free-recall answers. Grade on SUBSTANCE, not wording — if he has the idea, he gets it. Be generous but honest; 70 or above counts as correct.

For each item return: score 0-100, correct (score >= 70), feedback (one warm sentence — what he got right, then the gap), missed (the key thing he left out, or "").

Return ONLY JSON: {"results":[{"score":0,"correct":false,"feedback":"…","missed":"…"}]}
Return exactly ${items.length} results, in order.`;
      try {
        const p = await run<{ results?: C[] }>(sys, JSON.stringify(items), 3000, "grade");
        const results = arr(p.results).slice(0, items.length).map((r) => {
          const score = Math.max(0, Math.min(100, Math.round(Number((r as C)?.score) || 0)));
          return { score, correct: score >= 70, feedback: S((r as C)?.feedback, 400), missed: S((r as C)?.missed, 300) };
        });
        // score -1 = not graded; clients leave it out of averages
        while (results.length < items.length) results.push({ score: -1, correct: false, feedback: "Not graded — try again", missed: "" });
        return ok({ results });
      } catch (e) { return err(friendly(e, "Couldn't grade that — try again.")); }
    }

    // ── exam: whole-notebook free recall
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

    // ── flashcards: whole notebook, one chapter, or a focus
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

    // ── mindmap
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

    // ── study guide
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

    // ── podcast: two-host audio overview, rendered on-device
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
