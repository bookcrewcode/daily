// Clips edge function — short narrated explainers built from a notebook's own
// sources. Split out from `advisor` on purpose: clip generation is long-running
// media work (image models, speech synthesis, Storage writes) and has no
// business sharing an isolate with the chat path.
//
// verify_jwt is false at the gateway; the Supabase JWT is validated here by
// hand so CORS preflight works and only the signed-in owner can generate.
//
// Three stages, one call each, so nothing times out and the UI can show honest
// progress. A failure leaves the row with whatever landed, so a retry RESUMES:
// stage 2 skips scenes that already have a stored image, which means a retry
// never pays for the same still twice.
//
//   script → storyboard grounded in HIS sources        (text model)
//   image  → ONE still per call, POST /api/v1/images    (image model)
//   voice  → one narration mp3 + per-scene timings,
//            POST /api/v1/audio/speech                  (speech model)

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
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const stripFences = (s: string) => s.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "");

// Same vault-wins rule as the advisor: the in-app key screen writes the vault,
// so a replaced key must take effect even with a stale env var present.
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

// His tier choices (Settings → Models). A junk or missing row falls back
// silently — a settings problem must never take clips offline.
const DEFAULTS = {
  smart: "google/gemini-3.7-flash",
  image: "google/gemini-2.5-flash-image",
  voice: "deepgram/aura-2",
};
const okModelId = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(v) && v.length <= 100;
async function userModels(token: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/user_settings?select=ai_models`, {
      headers: { apikey: ANON, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { ...DEFAULTS };
    const m = (await r.json())?.[0]?.ai_models ?? {};
    return {
      smart: okModelId(m.smart) ? m.smart : DEFAULTS.smart,
      image: okModelId(m.image) ? m.image : DEFAULTS.image,
      voice: okModelId(m.voice) ? m.voice : DEFAULTS.voice,
    };
  } catch { return { ...DEFAULTS }; }
}

// Grounding: the notebook's own material, budgeted so ONE big pasted document
// still contributes most of itself.
async function readSources(token: string, notebookId: string): Promise<{ block: string; count: number; failed: boolean }> {
  if (!isUuid(notebookId)) return { block: "", count: 0, failed: false };
  const h = { apikey: ANON, Authorization: `Bearer ${token}` };
  let failed = false;
  let rows: { title: string; kind: string; content: string }[] = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/notebook_sources?notebook_id=eq.${notebookId}&select=title,kind,content&order=created_at.desc&limit=20`, { headers: h });
    if (!r.ok) failed = true; else rows = await r.json();
  } catch { failed = true; }
  const srcRows = rows.filter((x) => (x.content ?? "").trim());
  const TOTAL = 120000, MIN_SLICE = 500;
  const per = Math.min(100000, Math.max(8000, Math.floor(TOTAL / Math.max(1, srcRows.length))));
  let budget = TOTAL;
  const blocks: string[] = [];
  for (const src of srcRows) {
    if (budget < MIN_SLICE) break;
    const slice = src.content.slice(0, Math.min(per, budget));
    budget -= slice.length;
    const cut = slice.length < src.content.length ? "\n[…source truncated for length…]" : "";
    blocks.push(`--- SOURCE: "${src.title}" (${src.kind}) ---\n${slice}${cut}`);
  }
  return { block: blocks.join("\n\n"), count: blocks.length, failed };
}

async function callText(model: string, system: string, user: string, maxTokens: number, key: string): Promise<string> {
  const once = async (budget: number, withReasoning: boolean): Promise<string> => {
    if (isOpenRouter(key)) {
      const b: Record<string, unknown> = {
        model, max_tokens: budget,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      };
      // Some models reject effort:"none"; a 4xx makes us retry without the field
      // rather than failing his request over a parameter he never chose.
      if (withReasoning) b.reasoning = { effort: "none", exclude: true };
      const r = await fetch(`${OR_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(b),
      });
      const raw = await r.text();
      if (!r.ok) {
        console.error(`[clips:script] upstream ${r.status} model=${model} body=${raw.slice(0, 400)}`);
        throw new Error(`HTTP_${r.status}:${raw.slice(0, 160)}`);
      }
      const d = JSON.parse(raw);
      const text = String(d?.choices?.[0]?.message?.content ?? "");
      if (!text.trim()) {
        console.error(`[clips:script] empty model=${model} finish=${d?.choices?.[0]?.finish_reason} usage=${JSON.stringify(d?.usage ?? {})}`);
        throw new Error("EMPTY");
      }
      return text;
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: budget, system, messages: [{ role: "user", content: user }] }),
    });
    const raw = await r.text();
    if (!r.ok) { console.error(`[clips:script] anthropic ${r.status} ${raw.slice(0, 300)}`); throw new Error(`HTTP_${r.status}`); }
    const d = JSON.parse(raw);
    const t = (d.content ?? []).filter((b2: { type: string }) => b2.type === "text").map((b2: { text: string }) => b2.text).join("");
    if (!t.trim()) throw new Error("EMPTY");
    return t;
  };
  try { return await once(maxTokens, true); }
  catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m.startsWith("HTTP_4")) { console.error("[clips:script] retrying without reasoning field"); return await once(maxTokens, false); }
    if (m === "EMPTY") { console.error("[clips:script] retrying with more room"); return await once(maxTokens * 2, false); }
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (obj: unknown) => new Response(JSON.stringify(obj), { headers: { ...cors, "Content-Type": "application/json" } });
  const err = (m: string) => new Response(JSON.stringify({ error: m }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const user = await getUser(token);
    if (!user?.id) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });

    const key = await apiKey();
    if (!key) return err("No AI key set — open Settings → AI key and paste your OpenRouter key.");

    const body = await req.json();
    const stage = String(body.stage ?? "");
    const MODELS = await userModels(token);

    const restH = { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const readClip = async (id: string) => {
      if (!isUuid(id)) return null;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/notebook_clips?id=eq.${id}&select=*`, { headers: restH });
      if (!r.ok) return null;
      return ((await r.json()) as Record<string, unknown>[])[0] ?? null;
    };
    const patchClip = async (id: string, patch: Record<string, unknown>) => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/notebook_clips?id=eq.${id}`, {
        method: "PATCH", headers: { ...restH, Prefer: "return=representation" }, body: JSON.stringify(patch),
      });
      if (!r.ok) return null;
      return ((await r.json()) as Record<string, unknown>[])[0] ?? null;
    };
    // Storage writes use the service role, so the uid path prefix is the only
    // thing keeping one user's objects out of another's — enforced HERE.
    const putObject = async (path: string, bytes: Uint8Array, contentType: string) => {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/clips/${path}`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": contentType, "x-upsert": "true" },
        body: new Blob([bytes as unknown as BlobPart], { type: contentType }),
      });
      return r.ok;
    };

    if (stage !== "script" && !isOpenRouter(key)) {
      return err("Clips need an OpenRouter key — the image and speech endpoints are OpenRouter's.");
    }

    // ── 1. script ────────────────────────────────────────────────────────
    if (stage === "script") {
      const notebookId = isUuid(String(body.notebookId ?? "")) ? String(body.notebookId) : "";
      if (!notebookId) return err("Which notebook?");
      const chapterId = isUuid(String(body.chapterId ?? "")) ? String(body.chapterId) : null;
      const concept = String(body.concept ?? "").slice(0, 400);
      const beat = Number.isFinite(Number(body.beat)) && Number(body.beat) >= 0 ? Math.min(99, Math.floor(Number(body.beat))) : null;
      const secs = Math.min(60, Math.max(15, Number(body.seconds) || 40));
      const { block, count, failed } = await readSources(token, notebookId);
      if (failed) return err("Couldn't read your sources just now — try again in a moment.");
      if (!count) return err("Add sources to this notebook first — clips are built from your own material.");

      const words = Math.round(secs * 2.6);              // ~2.6 words/sec of narration
      const scenes = Math.max(3, Math.min(8, Math.round(secs / 7)));
      const sys = `You write SHORT narrated explainer videos for Ben, from HIS OWN study material.

RULES
- Total narration about ${words} words across EXACTLY ${scenes} scenes. Never exceed it.
- Open with a hook that creates a real question in the first six words. No "in this video", no greeting, no throat-clearing.
- ONE idea per scene, spoken plainly, like explaining to a sharp friend. Short sentences. Define any jargon in the same breath.
- Ground every claim in his material below. Anything beyond it must be widely-accepted background, and say so in passing.
- Ben has ADHD: concrete images, real examples, momentum. Boring is failure.
- End on a line that lands — a consequence, a reframe, or a question worth sitting with. Never "in conclusion".
- image_prompt: describe a STILL PHOTOGRAPH for that scene — subject, setting, lighting, mood, composition. Cinematic and specific. No text or letters in the image, no charts, no logos, no watermarks, no real public figures. Keep one consistent visual style across all scenes.
- caption: 3-7 words of on-screen text.

Return ONLY JSON:
{"title":"…","hook":"…","scenes":[{"narration":"…","caption":"…","image_prompt":"…"}]}

HIS MATERIAL:
${block.slice(0, 60000)}`;
      const ask = concept
        ? `Make the clip about: ${concept}`
        : "Pick the single most interesting idea in this material and make the clip about it.";
      try {
        const raw = await callText(MODELS.smart, sys, ask, 6000, key);
        const parsed = JSON.parse(stripFences(raw)) as {
          title?: string; hook?: string;
          scenes?: { narration?: string; caption?: string; image_prompt?: string }[];
        };
        const clean = (parsed.scenes ?? [])
          .filter((x) => x && typeof x.narration === "string" && x.narration.trim())
          .slice(0, 8)
          .map((x) => ({
            narration: String(x.narration).trim().slice(0, 400),
            caption: String(x.caption ?? "").trim().slice(0, 60),
            image_prompt: String(x.image_prompt ?? "").trim().slice(0, 600),
            image_path: null as string | null,
            seconds: 0,
          }));
        if (clean.length < 2) return err("That came back too thin — try again.");
        const ins = await fetch(`${SUPABASE_URL}/rest/v1/notebook_clips`, {
          method: "POST", headers: { ...restH, Prefer: "return=representation" },
          body: JSON.stringify({
            user_id: user.id, notebook_id: notebookId, chapter_id: chapterId,
            concept, title: String(parsed.title ?? concept ?? "Clip").slice(0, 120),
            hook: String(parsed.hook ?? "").slice(0, 300),
            scenes: clean, seconds: secs, status: "scripted", beat,
          }),
        });
        if (!ins.ok) return err("Wrote the script but couldn't save it — try again.");
        return ok({ clip: ((await ins.json()) as Record<string, unknown>[])[0] });
      } catch (e) {
        const m = e instanceof Error ? e.message : "";
        if (m === "EMPTY") return err(`${MODELS.smart} returned nothing twice — switch the Smart model in Settings and try again.`);
        if (m.startsWith("HTTP_402") || m.includes("credit")) return err("Your OpenRouter credits are out — top up and try again.");
        if (m.startsWith("HTTP_401")) return err("OpenRouter rejected the key — re-paste it in Settings → AI key.");
        if (m.startsWith("HTTP_")) return err(`The model provider errored (${m.slice(0, 70)}) — try again.`);
        return err(m || "Couldn't write that clip — try again.");
      }
    }

    // ── 2. one still ─────────────────────────────────────────────────────
    if (stage === "image") {
      const clipId = String(body.clipId ?? "");
      const i = Math.max(0, Math.min(7, Number(body.scene) || 0));
      const row = await readClip(clipId);
      if (!row) return err("That clip is gone.");
      const scenes = (row.scenes ?? []) as { image_prompt: string; image_path: string | null }[];
      if (!scenes[i]) return err("No such scene.");
      if (scenes[i].image_path) return ok({ path: scenes[i].image_path, skipped: true, clip: row });
      const style = "Cinematic still photograph, natural lighting, shallow depth of field, muted filmic color grade. No text, no letters, no watermark, no logos.";
      try {
        const r = await fetch(`${OR_BASE}/images`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: MODELS.image, prompt: `${scenes[i].image_prompt}. ${style}` }),
        });
        const data = await r.json();
        if (!r.ok) {
          console.error(`[clips:image] upstream ${r.status} model=${MODELS.image} body=${JSON.stringify(data).slice(0, 400)}`);
          return err(data?.error?.message ?? `The image model errored (HTTP ${r.status}).`);
        }
        const b64 = data?.data?.[0]?.b64_json;
        if (!b64) return err("No image came back for that scene.");
        const media = String(data?.data?.[0]?.media_type ?? "image/png");
        const ext = media.includes("jpeg") ? "jpg" : media.includes("webp") ? "webp" : "png";
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const path = `${user.id}/${clipId}/${i}.${ext}`;
        if (!(await putObject(path, bytes, media))) return err("Made the image but couldn't store it — try again.");
        const next = scenes.map((s, k) => (k === i ? { ...s, image_path: path } : s));
        const spent = Number(data?.usage?.cost ?? 0) || 0;
        const saved = await patchClip(clipId, {
          scenes: next,
          cost_usd: Number(row.cost_usd ?? 0) + spent,
          status: next.every((s) => s.image_path) ? "imaged" : "imaging",
        });
        if (!saved) return err("Stored the image but couldn't record it — try again.");
        return ok({ path, cost: spent, clip: saved });
      } catch (e) {
        return err(e instanceof Error && e.message ? e.message : "Couldn't render that scene — try again.");
      }
    }

    // ── 3. narration ─────────────────────────────────────────────────────
    if (stage === "voice") {
      const clipId = String(body.clipId ?? "");
      const row = await readClip(clipId);
      if (!row) return err("That clip is gone.");
      const scenes = (row.scenes ?? []) as { narration: string; seconds: number }[];
      const script = scenes.map((s) => s.narration).join(" ");
      if (!script.trim()) return err("This clip has no narration.");
      try {
        const r = await fetch(`${OR_BASE}/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: MODELS.voice, input: script,
            voice: String(body.voice ?? "alloy"), response_format: "mp3",
          }),
        });
        if (!r.ok) {
          let m = `The voice model errored (HTTP ${r.status}).`;
          try { const j = await r.json(); m = j?.error?.message ?? m; console.error(`[clips:voice] upstream ${r.status} model=${MODELS.voice} body=${JSON.stringify(j).slice(0, 400)}`); }
          catch { console.error(`[clips:voice] upstream ${r.status} model=${MODELS.voice} (non-JSON body)`); }
          return err(m);
        }
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length < 1000) return err("The narration came back empty — try again.");
        const path = `${user.id}/${clipId}/voice.mp3`;
        if (!(await putObject(path, bytes, "audio/mpeg"))) return err("Made the narration but couldn't store it — try again.");
        // Each scene holds for its share of the words; the client refines this
        // against the audio element's real duration.
        const totalWords = scenes.reduce((t, s) => t + s.narration.split(/\s+/).length, 0) || 1;
        const timed = scenes.map((s) => ({ ...s, seconds: s.narration.split(/\s+/).length / totalWords }));
        const saved = await patchClip(clipId, { audio_path: path, scenes: timed, status: "ready" });
        if (!saved) return err("Stored the narration but couldn't record it — try again.");
        return ok({ path, clip: saved });
      } catch (e) {
        return err(e instanceof Error && e.message ? e.message : "Couldn't record the narration — try again.");
      }
    }

    return err("Unknown stage.");
  } catch {
    return new Response(JSON.stringify({ error: "Something broke on the way — try again." }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
