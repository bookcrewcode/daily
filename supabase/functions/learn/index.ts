// Learn edge function — the teaching half of the notebook: syllabus · lesson ·
// coach · tutor · grade. (exam / flashcards / mindmap / study-guide / podcast
// live in `studio`, so each file stays small enough to redeploy by paste.)
//
// WHY THIS EXISTS: generation used to fail silently inside the 100KB `advisor`
// monolith — OpenRouter requires max_tokens to EXCEED the reasoning budget, so
// a thinking model handed a small ceiling returned nothing. Every call here
// disables reasoning, budgets generously, retries once with more room, and
// LOGS the upstream failure so a silent failure can never happen again.
//
// GROUNDING: prompts see an OUTLINE of every source plus the passages that
// match the chapter (RPCs notebook_outline / search_chunks, run with the
// user's own token so RLS applies). Passages are numbered [1]..[n] in the
// prompt; replies are mapped back to [chunk:<uuid>] here, and a number the
// model invents is simply dropped.
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

// Models sometimes wrap JSON in prose. Every reply here is an object, so the
// outermost {...} goes first; [...] is only a fallback.
function parseJson<T>(raw: string, tag: string): T {
  const s = strip(raw);
  try { return JSON.parse(s) as T; } catch { /* try harder */ }
  for (const [o, c] of [["{", "}"], ["[", "]"]]) {
    const a = s.indexOf(o), b = s.lastIndexOf(c);
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)) as T; } catch { /* next shape */ } }
  }
  console.error(`[learn:${tag}] unparseable: ${s.slice(0, 300)}`);
  throw new Error(`BADJSON:${s.slice(0, 120)}`);
}

// ── his material: outline + retrieval over the chunk RPCs (user token → RLS) ──
type C = Record<string, unknown>;
type Chunk = { id: string; text: string };
const S = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown, n: number) => arr(v).map((x) => S(x, n)).filter(Boolean);
const hdr = (token: string) => ({ apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function rpc<T>(token: string, fn: string, args: C): Promise<T | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: hdr(token), body: JSON.stringify(args) });
    if (!r.ok) { console.error(`[learn] rpc ${fn} ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
    return await r.json() as T;
  } catch (e) { console.error(`[learn] rpc ${fn}`, e instanceof Error ? e.message : e); return null; }
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

// Passages numbered [1]..[n]; the caller keeps `chunks` to map numbers back.
async function retrieve(token: string, nbId: string, query: string, limit = 24, pos: number | null = null): Promise<{ text: string; chunks: Chunk[]; failed: boolean }> {
  type Row = { id: string; source_title: string; heading: string | null; page_no: number | null; text: string };
  const args: C = { p_notebook_id: nbId, p_query: query.slice(0, 400), p_limit: limit };
  if (pos != null && Number.isFinite(pos)) args.p_pos = Math.max(0, Math.min(1, pos));
  const rows = await rpc<Row[]>(token, "search_chunks", args);
  if (!rows) return { text: "", chunks: [], failed: true };
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
// hasn't run yet still gets its raw text (no passage numbers to cite).
async function material(token: string, nbId: string, query: string, limit = 24, pos: number | null = null): Promise<{ text: string; chunks: Chunk[]; sources: number; failed: boolean }> {
  const o = await outline(token, nbId);
  if (o.failed) return { text: "", chunks: [], sources: 0, failed: true };
  if (!o.sources) return { text: "(no sources in this notebook yet)", chunks: [], sources: 0, failed: false };
  if (!o.chunks) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/notebook_sources?notebook_id=eq.${nbId}&select=title,content&order=created_at.desc&limit=20`, { headers: hdr(token) });
      if (!r.ok) return { text: "", chunks: [], sources: o.sources, failed: true };
      const raw = ((await r.json()) as { title: string; content: string }[]).map((s) => `--- "${S(s.title, 120)}" ---\n${s.content ?? ""}`).join("\n\n").slice(0, 30000);
      return { text: `NOTE: these sources aren't indexed into passages yet, so here is the raw text (nothing to cite by number).\n\n${raw}`, chunks: [], sources: o.sources, failed: false };
    } catch { return { text: "", chunks: [], sources: o.sources, failed: true }; }
  }
  const r = query ? await retrieve(token, nbId, query, limit, pos) : { text: "", chunks: [], failed: false };
  if (r.failed) return { text: "", chunks: [], sources: o.sources, failed: true };
  return { text: `OUTLINE OF HIS SOURCES:\n${o.text}${r.text ? `\n\nPASSAGES (cite by number):\n${r.text}` : ""}`, chunks: r.chunks, sources: o.sources, failed: false };
}

const CITE_RULE = "Cite passages by their number exactly as given, like [3]; never invent a number.";
// Ben's bar: no word he must already know
const PLAIN = "PLAIN WORDS: write for a smart 15-year-old with zero prior knowledge; the FIRST time any technical word appears, put its meaning in parentheses right after it, like \"marginal cost (the extra cost of making one more unit)\" — never use a term you haven't defined this way.";
// no card shows passage numbers, so "[3]" is noise; V = a visible string, capped and cleaned
const noCites = (s: string) => s.replace(/\s*\[(?:chunk:)?\d{1,3}(?:\s*,\s*\d{1,3})*\]/g, "");
const V = (v: unknown, n: number) => noCites(S(v, n)).trim();
const vstrs = (v: unknown, n: number) => arr(v).map((x) => V(x, n)).filter(Boolean);

// "[3]" / "[chunk:3]" / "[2, 5]" → "[chunk:<uuid>]"; unknown numbers vanish.
function mapCites(text: string, chunks: Chunk[]): { text: string; used: string[] } {
  const used = new Set<string>();
  const out = text.replace(/\[(?:chunk:)?(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, (_m, list: string) => {
    const ids = list.split(",").map((n) => chunks[Number(n.trim()) - 1]?.id).filter(Boolean) as string[];
    ids.forEach((id) => used.add(id));
    return ids.map((id) => `[chunk:${id}]`).join("");
  });
  return { text: out, used: [...used] };
}

// A teach card's quote must really be in the passage it points at.
function citeOf(v: unknown, chunks: Chunk[]): { chunk_id: string; quote: string } | null {
  const c = v as C | undefined;
  const n = Number(String(c?.n ?? c?.chunk_id ?? c?.chunk ?? "").replace(/\D/g, ""));
  const quote = S(c?.quote, 300);
  const ch = chunks[n - 1];
  if (!ch || !quote) return null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(ch.text).includes(norm(quote)) ? { chunk_id: ch.id, quote } : null;
}

// ── clips: a window survives ONLY if its own cues contain the quote — a doubtful clip is worse than none ──
type Seg = { s: number; d: number; text: string };
type Video = { id: string; title: string; channel: string; duration_s: number; segments: Seg[] };
const pad = (n: number) => String(n).padStart(2, "0");
const mmss = (t: number) => { const s = Math.max(0, Math.floor(t)); return `${s >= 3600 ? `${Math.floor(s / 3600)}:` : ""}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; };
// "02:10" / "1:02:10" / seconds → integer seconds, else NaN
const secs = (v: unknown): number => {
  const s = String(v ?? "").trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.floor(Number(s));
  const p = s.split(":");
  return [2, 3].includes(p.length) ? Math.floor(p.reduce((a, x) => a * 60 + Number(x), 0)) : NaN;
};
// case / punctuation / whitespace-insensitive; apostrophes vanish so "don't" = "dont"
const normQ = (s: string) => s.toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();

function clipOf(raw: unknown, videos: Video[]): { id: string; title: string; channel: string; start: number; end: number } | null {
  const c = raw as C | undefined;
  const v = videos[Math.floor(Number(c?.v)) - 1];
  const start = secs(c?.start);
  let end = secs(c?.end);
  if (!v || !(start >= 0 && start < end && end <= v.duration_s + 5)) return null;
  if (end - start < 30) end = start + 30;
  if (end > v.duration_s + 5 || end - start > 150) return null;
  const quote = normQ(S(c?.quote, 400));
  if (quote.split(" ").length < 6) return null;
  // ±15s for cue drift; word boundaries
  const heard = normQ(v.segments.filter((g) => g.s >= start - 15 && g.s <= end + 15).map((g) => g.text).join(" "));
  return ` ${heard} `.includes(` ${quote} `) ? { id: v.id, title: v.title, channel: v.channel, start, end } : null;
}

// "[V1 @ 02:10] words…" per ~25s window, capped at 9,000 chars
function timedBlock(v: Video, n: number): string {
  const lines = [`[V${n}] "${v.title}" (${v.channel}, ${mmss(v.duration_s)} long)`];
  let at = -1, words: string[] = [];
  const flush = () => { if (words.length) lines.push(`[V${n} @ ${mmss(at)}] ${words.join(" ")}`); words = []; };
  for (const g of v.segments) { if (at < 0 || g.s - at >= 25) { flush(); at = g.s; } words.push(g.text); }
  flush();
  let out = "";
  for (const l of lines) { if (out.length + l.length > 9000) break; out += `${l}\n`; }
  return out;
}

// ── lesson validator: every shape the renderer relies on, enforced here ──
const DIAGRAMS = ["flow", "compare", "cycle", "stack"];
const isQ = (c: C) => c.kind !== "teach";

function askOf(v: unknown): { q: string; choices: string[]; answer: number } | null {
  const a = v as C | undefined;
  // an empty choice rejects the card; dropping it would shift the answer
  const choices = arr(a?.choices).map((x) => V(x, 200)).slice(0, 4);
  const answer = Math.floor(Number(a?.answer));
  if (choices.length < 3 || choices.some((x) => !x) || !Number.isFinite(answer) || answer < 0 || answer >= choices.length) return null;
  return { q: V(a?.q, 300), choices, answer };
}

function cleanCard(c: C, fade: number, chunks: Chunk[], videos: Video[]): C | null {
  const kind = String(c?.kind ?? "");
  const explain = V(c.explain, 300);
  const pre = Number.isInteger(Number(c.pretest_of)) ? Number(c.pretest_of) : -1;
  if (kind === "teach") {
    const text = V(c.text, 900);
    if (!text) return null;
    // plain-words check: an acronym with no "(…)" is probably undefined — log only
    if (/\b[A-Z]{2,}\b/.test(text) && !text.includes("(")) console.error(`[learn:lesson] undefined acronym? "${text.slice(0, 80)}"`);
    const d = c.diagram as C | undefined;
    const nodes = arr(d?.nodes ?? d?.items).map((n) => {
      const o = (typeof n === "string" ? { label: n } : n ?? {}) as C;
      const note = V(o.note, 80);
      return { label: V(o.label, 60), ...(note ? { note } : {}) };
    }).filter((n) => n.label).slice(0, 6);
    const diagram = d && DIAGRAMS.includes(String(d.kind)) && nodes.length >= 2 ? { kind: String(d.kind), title: V(d.title, 80), nodes } : null;
    const cite = citeOf(c.cite, chunks);
    const clip = clipOf(c.clip, videos);
    return { kind, text, diagram, ...(cite ? { cite } : {}), ...(clip ? { clip } : {}) };
  }
  if (kind === "mcq" || kind === "scenario") {
    const a = askOf(c);
    if (!a || !a.q) return null;
    const why_wrong = arr(c.why_wrong).map((w) => V(w, 200)).slice(0, a.choices.length);
    while (why_wrong.length < a.choices.length) why_wrong.push("");
    return { kind, q: a.q, situation: kind === "scenario" ? V(c.situation, 400) : "", choices: a.choices, answer: a.answer, explain, why_wrong, pretest_of: pre };
  }
  if (kind === "blank") {
    const sentence = V(c.sentence ?? c.prompt, 400);
    const answer = vstrs(c.answer, 60);
    if (!answer.length || answer.length > 4 || (sentence.match(/___/g) ?? []).length !== answer.length) return null;
    // the bank must hold every answer as many times as the sentence needs it
    const need = new Map<string, number>();
    answer.forEach((a) => need.set(a, (need.get(a) ?? 0) + 1));
    const have = new Map<string, number>();
    const bank: string[] = [];
    for (const b of vstrs(c.bank, 60)) {
      const k = have.get(b) ?? 0;
      if (!need.has(b)) bank.push(b);
      else if (k < need.get(b)!) { have.set(b, k + 1); bank.push(b); }
    }
    need.forEach((n, a) => { for (let k = have.get(a) ?? 0; k < n; k++) bank.push(a); });
    for (let i = bank.length - 1; i >= 0 && bank.length > answer.length + 3; i--) if (!need.has(bank[i])) bank.splice(i, 1);
    return { kind, sentence, bank, answer, explain, pretest_of: pre };
  }
  if (kind === "order") {
    const items = vstrs(c.items, 120).slice(0, 6);
    // duplicates make the tap-to-build interaction unsolvable
    if (items.length < 3 || new Set(items).size !== items.length) return null;
    return { kind, prompt: V(c.prompt, 300), items, explain, pretest_of: pre };
  }
  if (kind === "match") {
    const pairs = arr(c.pairs).map((p) => {
      const o = (Array.isArray(p) ? { left: p[0], right: p[1] } : p ?? {}) as C;
      return [V(o.left, 100), V(o.right, 100)] as [string, string];
    }).filter((p) => p[0] && p[1]).slice(0, 4);
    if (pairs.length < 3 || new Set(pairs.map((p) => p[0])).size !== pairs.length || new Set(pairs.map((p) => p[1])).size !== pairs.length) return null;
    return { kind, prompt: V(c.prompt, 300), pairs, explain, pretest_of: pre };
  }
  if (kind === "worked") {
    const problem = V(c.problem, 500);
    const steps = arr(c.steps).map((s) => ({ text: V((s as C)?.text, 400), ask: askOf((s as C)?.ask) })).filter((s) => s.text).slice(0, 5);
    const last = steps.length - 1;
    if (!problem || steps.length < 3 || (!steps[last].ask && !steps[last - 1].ask)) return null;
    // fade = how much he does himself: 0 → only the final asked step, 1 → the
    // last two, 2 → every step
    const from = fade >= 2 ? 0 : fade === 1 ? last - 1 : steps[last].ask ? last : last - 1;
    const out = steps.map((s, i) => (s.ask && i >= from ? { text: s.text, ask: s.ask } : { text: s.text }));
    return { kind, problem, steps: out, explain, pretest_of: pre };
  }
  return null;
}

// Raw model cards → a run the renderer can trust. `ok` = hard invariants
// (regenerate if false); `soft` = the quant "≥2 worked" ask; `clips` = "kept/proposed" for the log.
function assemble(raw: unknown[], n: number, fade: number, quant: boolean, chunks: Chunk[], videos: Video[]): { cards: C[]; ok: boolean; soft: boolean; clips: string } {
  const kept = raw.map((c, i) => ({ c: cleanCard((c ?? {}) as C, fade, chunks, videos), i })).filter((x) => x.c) as { c: C; i: number }[];
  const proposed = raw.filter((c) => (c as C)?.kind === "teach" && (c as C)?.clip).length;
  // pretest: the first question aimed at the first teach card, else the first question
  const t0 = kept.find((x) => !isQ(x.c))?.i;
  let pi = kept.findIndex((x) => isQ(x.c) && x.c.pretest_of === t0);
  if (pi < 0) pi = kept.findIndex((x) => isQ(x.c));
  if (pi < 0) return { cards: [], ok: false, soft: false, clips: `0/${proposed}` };
  const [p] = kept.splice(pi, 1);
  p.c.pretest = true;
  const rest = [p.c, ...kept.map((x) => x.c)];
  rest.forEach((c) => delete c.pretest_of);
  // never two teach cards in a row: pull the next question forward
  const seq: C[] = [];
  while (rest.length) {
    let j = 0;
    if (seq.length && !isQ(seq[seq.length - 1]) && !isQ(rest[0])) { j = rest.findIndex(isQ); if (j < 0) break; }
    seq.push(rest.splice(j, 1)[0]);
  }
  // trim to n by whole teach+question groups from the end, never inside one
  const groups: C[][] = [];
  for (const c of seq) { if (!isQ(c) || !groups.length) groups.push([c]); else groups[groups.length - 1].push(c); }
  const total = () => groups.reduce((s, g) => s + g.length, 0);
  const qs = (g: C[]) => g.filter(isQ).length;
  while (groups.length > 1 && total() > n) {
    if (groups.reduce((s, g) => s + qs(g), 0) - qs(groups[groups.length - 1]) < 7) break;
    groups.pop();
  }
  const cards = groups.flat();
  const teachAlone = cards.some((c, i) => !isQ(c) && (i === cards.length - 1 || !isQ(cards[i + 1])));
  return { cards, ok: !teachAlone && qs(cards) >= 7, soft: !quant || cards.filter((c) => c.kind === "worked").length >= 2, clips: `${cards.filter((c) => c.clip).length}/${proposed}` };
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
    const M = await models(token);
    if (["syllabus", "lesson", "coach", "tutor"].includes(mode) && !nbId) return err("Which notebook?");
    const READ_FAIL = "Couldn't read your sources just now — try again in a moment.";
    const NO_SOURCES = "Add sources to this notebook first — everything here is built from your own material.";

    // ── syllabus: design the chapters from the outline ───────────────────
    if (mode === "syllabus") {
      const title = S(body.title, 120) || "this notebook";
      const kind = body.kind === "class" ? "class" : "personal";
      const existing = strs(body.existing, 90);
      const m = await material(token, nbId, "");
      if (m.failed) return err(READ_FAIL);
      if (!m.sources) return err(NO_SOURCES);
      const sys = `You design the chapters of Ben's notebook "${title}" from an outline of HIS OWN sources. He has ADHD: concrete titles, one clear objective each.

KIND: ${kind === "class" ? "class — 8 to 16 chapters organised by week/topic in the order the course teaches them (use the source weeks and headings); set \"week\" when the sources say it" : "personal — 5 to 8 chapters, trunk first: chapter 1 is the root idea everything hangs on, each later chapter depends only on earlier ones"}.
- title: 2-6 words, concrete, no numbering. objective: ONE sentence starting with a verb — what he'll be able to DO. summary: one sentence on what it covers.
- ${PLAIN} Titles in plain words; the objective explains any technical word it uses.
- quant: true when the objective involves computing, deriving, solving or graphing.
- trunk: one sentence — the root idea of the whole notebook.
- Cover what is actually IN his material; never invent topics it doesn't support.${existing.length ? `\n- These chapters already exist — never reuse or rephrase them: ${existing.map((t) => `"${t}"`).join(", ")}` : ""}

Return ONLY JSON: {"trunk":"…","chapters":[{"title":"…","objective":"…","summary":"…","week":3,"quant":false}]}

HIS MATERIAL:
${m.text}`;
      try {
        const raw = await ask(M.smart, sys, [{ role: "user", content: "Design the chapters." }], 5000, key, "syllabus");
        const p = parseJson<{ trunk?: string; chapters?: C[] }>(raw, "syllabus");
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

    // ── lesson: the run — tappable cards, validated, cached on the chapter ──
    if (mode === "lesson") {
      const ct = S(body.chapterTitle, 120), co = S(body.chapterObjective, 240), cs = S(body.chapterSummary, 300);
      const chapterId = isUuid(String(body.chapterId ?? "")) ? String(body.chapterId) : "";
      const misses = strs(body.misses, 200).slice(0, 12);
      const fade = Math.max(0, Math.min(2, Math.floor(Number(body.fade) || 0)));
      const quant = body.quant === true;
      const n = Math.max(8, Math.min(16, Math.floor(Number(body.n) || 12)));
      const pos = Number.isFinite(Number(body.chapterPos)) ? Number(body.chapterPos) : null;
      if (!ct) return err("Which chapter?");

      // double-tap protection: a run written in the last 3 minutes is the run
      if (chapterId && body.force !== true) {
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/notebook_chapters?id=eq.${chapterId}&select=run,run_at`, { headers: hdr(token) });
          const row = r.ok ? ((await r.json()) as { run: unknown; run_at: string | null }[])[0] : null;
          if (row && Array.isArray(row.run) && row.run.length && row.run_at && Date.now() - Date.parse(row.run_at) < 3 * 60_000) return ok({ cards: row.run, cached: true });
        } catch { /* fall through to generating */ }
      }

      const m = await material(token, nbId, `${ct} ${co}`, 24, pos);
      if (m.failed) return err(READ_FAIL);
      if (!m.sources) return err(NO_SOURCES);

      // ≥10 cues, ≤4 videos; a failed read = no clips, the run still renders
      let videos: Video[] = [];
      if (chapterId) {
        try {
          const get = async (q: string) => { const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: hdr(token) }); if (!r.ok) console.error(`[learn:lesson] read ${q.split("?")[0]} ${r.status}`); return r.ok ? ((await r.json()) as C[]) : []; };
          const ids = arr((await get(`notebook_chapters?id=eq.${chapterId}&select=videos`))[0]?.videos).map((v) => String((v as C)?.id ?? "")).filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id));
          const rows = ids.length ? await get(`video_transcripts?video_id=in.(${ids.join(",")})&select=video_id,title,channel,duration_s,segments`) : [];
          videos = ids.map((id) => rows.find((r) => r.video_id === id)).filter((r): r is C => !!r).map((r) => {
            const segments = (arr(r.segments) as Seg[]).filter((g) => Number.isFinite(g?.s) && typeof g?.text === "string");
            const last = segments[segments.length - 1];
            return { id: String(r.video_id), title: S(r.title, 160), channel: S(r.channel, 80), duration_s: Number(r.duration_s) || (last ? Math.ceil(last.s + (last.d || 0)) : 0), segments };
          }).filter((v) => v.segments.length >= 10).slice(0, 4);
        } catch (e) { console.error("[learn:lesson] videos", e instanceof Error ? e.message : e); }
      }

      const fadeLine = fade >= 2 ? "put an \"ask\" on EVERY step" : fade === 1 ? "put an \"ask\" on the last two steps" : "put an \"ask\" on the final step only";
      const sys = `Build an interactive RUN for Ben on this chapter — a game, not a worksheet. He taps; he never types. He has ADHD: vivid, concrete, tight text for a phone screen.

CHAPTER: "${ct}"
OBJECTIVE: ${co}${cs ? `\nCOVERS: ${cs}` : ""}${misses.length ? `\n\nHE MISSED THESE LAST TIME — re-teach each one and ask it again in a NEW form:\n${misses.map((x) => `- ${x}`).join("\n")}` : ""}

WORDS — this matters more than anything else:
- Write for a smart 15-year-old who has NEVER seen this topic. Assume zero prior knowledge.
- Short sentences. One idea per card. Say the everyday version first, then the precise word.
- The FIRST time any technical word appears in a card, put its meaning in parentheses right after it, like "marginal cost (the extra cost of making one more unit)". Never use a term you have not defined this way. If a term needs a second sentence, use it.
- Every teach card has a concrete example from ordinary life (a sandwich shop, a phone bill, a gym, a car), not an abstract one.
- Questions and their "explain" lines follow the same rules — no unexplained term in a question.

SHAPE OF THE RUN
- Exactly ${n} cards: at least 7 question cards, the rest teach cards. Never two teach cards in a row — every teach card is followed by at least one question about it, and the LAST card is a question.
- Card 0 is a teach card. Every question card carries "pretest_of": the 0-based index in this array of the teach card that answers it.
- Mix the question kinds; never the same kind twice in a row.${quant ? "\n- This is a quantitative chapter: include at least 2 \"worked\" cards." : ""}

CARD KINDS (exact JSON)
teach    {"kind":"teach","text":"one vivid idea, 3-5 short sentences","diagram":{"kind":"flow|compare|cycle|stack","title":"…","nodes":[{"label":"…","note":"optional"}]} or null,"cite":{"n":3,"quote":"10-25 words copied VERBATIM from passage [3]"}${videos.length ? ",\"clip\":{…} (see CLIP RULE; else omit)" : ""}}
mcq      {"kind":"mcq","q":"…","choices":["3 or 4 strings"],"answer":0,"explain":"why the right one is right","why_wrong":["one line per choice, '' for the right one"],"pretest_of":0}
scenario {"kind":"scenario","situation":"a real moment from HIS life — Rutgers classes, driving gigs, his business","q":"…","choices":["3 or 4"],"answer":0,"explain":"…","why_wrong":["…"],"pretest_of":0}
blank    {"kind":"blank","sentence":"one ___ per answer","bank":["the answers plus 2-3 distractors"],"answer":["word"],"explain":"…","pretest_of":0}
order    {"kind":"order","prompt":"…","items":["3-6 steps in the CORRECT order, all distinct"],"explain":"…","pretest_of":0}
match    {"kind":"match","prompt":"…","pairs":[["left","right"]],"explain":"…","pretest_of":0}   (3-4 pairs; lefts distinct, rights distinct)
worked   {"kind":"worked","problem":"…","steps":[{"text":"…","ask":{"q":"…","choices":["3 or 4"],"answer":0}}],"explain":"…","pretest_of":0}   (3-5 steps; ${fadeLine})

RULES
- One right answer per choice list, wrong ones plausible. "explain" is one sentence he'd remember. Omit "cite" rather than invent a quote.
- Ground everything in his material. ${CITE_RULE}

Return ONLY JSON: {"cards":[…]}

HIS MATERIAL:
${m.text}
${videos.length ? `
VIDEOS — timed transcripts of real explainers for this chapter:
${videos.map((v, i) => timedBlock(v, i + 1)).join("")}
CLIP RULE: on a teach card, if one of these videos explains the SAME idea as the card, add
"clip": {"v": 1, "start": "02:10", "end": "03:25", "quote": "8-20 words copied verbatim from the transcript inside that window"}.
The clip must run 30–150 seconds, start where that explanation starts, and cover only that idea. If no video segment teaches exactly this card's idea, OMIT clip — a wrong clip is worse than none. Never invent timestamps.
` : ""}
(${CITE_RULE})`;
      try {
        const gen = async (budget: number) => {
          const raw = await ask(M.smart, sys, [{ role: "user", content: "Build the run." }], budget, key, "lesson");
          return assemble(arr(parseJson<{ cards?: unknown[] }>(raw, "lesson").cards), n, fade, quant, m.chunks, videos);
        };
        let r = await gen(10000);
        if (!r.ok || !r.soft) {
          console.error(`[learn:lesson] first pass ${r.ok ? "short on worked cards" : "broke an invariant"} — regenerating`);
          const r2 = await gen(20000);
          if (r2.ok) r = r2;
          else if (!r.ok) return err("That run came back too thin twice — try again in a minute.");
        }
        console.error(`[learn:lesson] clips kept ${r.clips}`);
        // cache on the chapter so today's and tomorrow's rounds are instant
        let cached = false;
        if (chapterId) {
          try {
            const p = await fetch(`${SUPABASE_URL}/rest/v1/notebook_chapters?id=eq.${chapterId}&select=id`, {
              method: "PATCH", headers: { ...hdr(token), Prefer: "return=representation" },
              body: JSON.stringify({ run: r.cards, run_at: new Date().toISOString() }),
            });
            cached = p.ok && ((await p.json()) as unknown[]).length > 0;
            if (!cached) console.error(`[learn:lesson] run cache PATCH ${p.status}`);
          } catch (e) { console.error("[learn:lesson] run cache", e instanceof Error ? e.message : e); }
        }
        return ok({ cards: r.cards, cached });
      } catch (e) { return err(friendly(e, "Couldn't build the run — try again.")); }
    }

    // ── coach: the Learning Guide on ONE card (chips + "Just tell me") ────
    if (mode === "coach") {
      const ctx = S(body.context, 1200);
      const askText = S(body.ask, 600) || "Explain this a bit more.";
      const ct = S(body.chapterTitle, 120);
      const tellMe = /just tell me/i.test(askText);
      const m = await material(token, nbId, `${ct} ${ctx.slice(0, 200)}`, 8);
      if (m.failed) return err(READ_FAIL);
      const sys = `You are Ben's Learning Guide, helping him through ONE point he's on right now${ct ? ` in the chapter "${ct}"` : ""}. He has ADHD — concrete, warm, plain words, under 120 words. Speak to him directly; no headings, no bullet lists.

HE IS ON THIS CARD:
"""${ctx}"""

HOW YOU HELP
- Find the stuck point. Ask ONE question per reply, never more.
- On a first ask, don't hand over the whole answer: give the smallest hint that unblocks him plus the one question that gets him the rest.
- "Explain it simpler" → one plainer restatement and a concrete example from his life (Rutgers classes, driving gigs, his business), then a question. "Give me an example" → one worked example, then ask him for the next one. "Why is that the answer?" → the reason in two sentences, then a question that checks he could spot it next time.
- ${tellMe ? "HE SAID \"JUST TELL ME\": give the answer plainly and completely, then ONE quick check question." : "If he says \"just tell me\", give the answer plainly, then one check question."}
- ${PLAIN}
- Ground in his material below; if you go past it, say so in a few words. ${CITE_RULE}

HIS MATERIAL:
${m.text}

(${CITE_RULE})`;
      try {
        const text = await ask(M.smart, sys, [{ role: "user", content: askText }], 1500, key, "coach");
        // the coach sheet shows plain prose — passage numbers are for the model
        return ok({ text: noCites(text).trim() });
      } catch (e) { return err(friendly(e, "Couldn't help with that right now — try again.")); }
    }

    // ── tutor: notebook chat — asks before it tells, cites by passage ─────
    if (mode === "tutor") {
      const message = S(body.message, 4000);
      if (!message) return err("Ask something.");
      const ct = S(body.chapterTitle, 120);
      const history = (arr(body.history) as C[]).slice(-8)
        .filter((h) => (h?.role === "user" || h?.role === "assistant") && typeof h.content === "string")
        .map((h) => ({ role: String(h.role), content: String(h.content).slice(0, 4000) }));
      const [m, chRows] = await Promise.all([
        material(token, nbId, `${message.slice(0, 300)} ${ct}`, 16),
        fetch(`${SUPABASE_URL}/rest/v1/notebook_chapters?notebook_id=eq.${nbId}&select=title,status,best_score,misses&order=idx`, { headers: hdr(token) })
          .then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<{ title: string; status: string; best_score: number; misses: unknown }[]>,
      ]);
      if (m.failed) return err(READ_FAIL);
      const chapters = chRows.map((c) => `- ${c.title} (${c.status}${c.best_score ? `, best ${c.best_score}%` : ""})`).join("\n");
      const misses = [...new Set(chRows.flatMap((c) => strs(c.misses, 200)))].slice(-12);
      const sys = `You are Ben's Learning Guide for this notebook${ct ? ` (he's working on "${ct}")` : ""} — you ask before you tell. He has ADHD: short, concrete, warm, no lecturing. Under 160 words.

HOW A TURN GOES
1. Silently classify his last message first: irrelevant / question / incorrect attempt / correct attempt.
2. irrelevant → one friendly line back to the topic, then one question. question → the smallest useful piece of the answer, then ONE question that gets him the rest. incorrect → name what's right in it, point at the one thing that's off, ask one question; after two wrong attempts on the same point, reveal the answer plainly and ask one check question. correct → confirm in a few words, then one question a step deeper.
3. ONE question per turn, then wait. Every reply ends with a question.
4. Teach on a PARALLEL example — never solve a problem he is being graded on; walk a look-alike instead.
5. Hint ladder: hint → bigger hint → the missing piece. If he has asked three times without trying, zoom out and ask which part of the hint is the sticking point.
6. "Just tell me" (any wording) is the escape hatch: give the answer plainly, then one check question.
7. ${CITE_RULE} If something isn't in his material, say so in a few words before using general knowledge.
8. ${PLAIN}

TWO EXAMPLES OF THE TONE
Ben: what's the difference between elastic and inelastic demand
Guide: Good place to start. Elastic means the quantity people buy swings a lot when the price moves; inelastic means it barely budges [2]. Quick one from your driving shifts: if gas jumps 20% at the pump, do you buy a lot less, or about the same?
Ben: about the same I guess
Guide: Right — so your gas demand is inelastic: price moved a lot, quantity barely moved [2]. What do you think makes something inelastic: how much you like it, or how many substitutes you have?

CHAPTERS IN THIS NOTEBOOK:
${chapters || "(none yet)"}
${misses.length ? `\nTHINGS HE HAS MISSED RECENTLY:\n${misses.map((x) => `- ${x}`).join("\n")}\n` : ""}
HIS MATERIAL:
${m.text}

(${CITE_RULE})`;
      const msgs = [...history, { role: "user", content: message }];
      while (msgs.length && msgs[0].role !== "user") msgs.shift();
      try {
        const raw = await ask(M.smart, sys, msgs, 2000, key, "tutor");
        const { text, used } = mapCites(raw, m.chunks);
        return ok({ text, used });
      } catch (e) { return err(friendly(e, "Couldn't answer that right now — try again.")); }
    }

    // ── grade: judge free recall generously, on substance ─────────────────
    if (mode === "grade") {
      const items = arr(body.items).slice(0, 12);
      if (!items.length) return err("Nothing to grade.");
      const sys = `You grade Ben's free-recall answers. Grade on SUBSTANCE, not wording — if he has the idea, he gets it. Be generous but honest; 70 or above counts as correct.

For each item return: score 0-100, correct (score >= 70), feedback (one warm sentence — what he got right, then the gap), missed (the key thing he left out, or "").

Return ONLY JSON: {"results":[{"score":0,"correct":false,"feedback":"…","missed":"…"}]}
Return exactly ${items.length} results, in order.`;
      try {
        const raw = await ask(M.smart, sys, [{ role: "user", content: JSON.stringify(items) }], 3000, key, "grade");
        const p = parseJson<{ results?: C[] }>(raw, "grade");
        const results = arr(p.results).slice(0, items.length).map((r) => {
          const score = Math.max(0, Math.min(100, Math.round(Number((r as C)?.score) || 0)));
          return { score, correct: score >= 70, feedback: S((r as C)?.feedback, 400), missed: S((r as C)?.missed, 300) };
        });
        // score -1 = not graded; clients leave it out of averages
        while (results.length < items.length) results.push({ score: -1, correct: false, feedback: "Not graded — try again", missed: "" });
        return ok({ results });
      } catch (e) { return err(friendly(e, "Couldn't grade that — try again.")); }
    }

    return err(`Unknown mode "${mode}".`);
  } catch (e) {
    console.error("[learn] fatal", e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
