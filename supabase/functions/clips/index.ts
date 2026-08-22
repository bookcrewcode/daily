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
  if (isOpenRouter(key)) {
    // reasoning OFF: this is a short structured-JSON job, and OpenRouter requires
    // max_tokens to exceed the reasoning budget — a thinking model would
    // otherwise burn the whole allowance before writing a single word and come
    // back finish_reason "length" with empty content.
    const r = await fetch(`${OR_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        reasoning: { effort: "none", exclude: true },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message ?? "AI error");
    const text = String(data?.choices?.[0]?.message?.content ?? "");
    // Only a truncation that actually cost us the payload is fatal. A model that
    // stopped at the cap but still returned parseable content is fine.
    if (data?.choices?.[0]?.finish_reason === "length" && !text.trim()) throw new Error("TOOLONG");
    return text;
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-opus-4-8", max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message ?? "AI error");
  if (data?.stop_reason === "max_tokens") throw new Error("TOOLONG");
  return (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
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
        // 6000, not 2000: a reasoning model needs headroom above its thinking
        // budget. If it still comes back empty, retry once with more room
        // rather than telling him to shorten a clip that was never too long.
        let raw = "";
        try {
          raw = await callText(MODELS.smart, sys, ask, 6000, key);
        } catch (first) {
          if (first instanceof Error && first.message === "TOOLONG") raw = await callText(MODELS.smart, sys, ask, 12000, key);
          else throw first;
        }
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
        return err(m === "TOOLONG"
          ? `${MODELS.smart} returned nothing usable twice — switch the Smart model in Settings and try again.`
          : (m || "Couldn't write that clip — try again."));
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
        if (!r.ok) return err(data?.error?.message ?? "The image model refused that scene.");
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
          let m = "The voice model refused that script.";
          try { m = (await r.json())?.error?.message ?? m; } catch { /* success path is raw bytes */ }
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
