"use client";

// 🧠 Models — which brain does which job.
//
// Ben's rule, in his words: "anything easy and basic to do, like uploading the
// schedule, should be a low-ass model, but... I'm trying to understand
// something or I'm asking a question, I should be able to use a more advanced
// model." So there are exactly two tiers and he owns both:
//
//   FAST   mechanical work — parsing his schedule, pulling a vocab word,
//          summarizing a transcript, reading a food photo, the daily briefing.
//   SMART  thinking work — chapters, exams, study guides, the podcast, the Run,
//          grading his recall, flashcards, mind maps, in-chapter coaching,
//          and every question he asks the coach.
//
// Choices live in user_settings.ai_models and are read by the advisor once per
// request. Only the OpenRouter path uses them (an sk-ant- key routes to
// Anthropic's own models); a bad id silently falls back rather than taking the
// AI layer down.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { sfx } from "@/lib/fx";
import { Card, Eyebrow } from "./ui";

type Tier = "fast" | "smart" | "image" | "voice";
type Opt = { id: string; label: string; note: string; vision: boolean };

// Prices are $/million tokens (in → out), read from the live OpenRouter model
// list on 2026-08-20. They drift — the "custom" slot exists so a new model is
// never gated behind a rebuild.
const FAST_OPTS: Opt[] = [
  { id: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", note: "$0.10 → $0.40 · reads photos", vision: true },
  { id: "qwen/qwen3.7-flash", label: "Qwen 3.7 Flash", note: "$0.03 → $0.13 · cheapest, reads photos", vision: true },
  { id: "openai/gpt-5-nano", label: "GPT-5 Nano", note: "$0.05 → $0.40 · reads photos", vision: true },
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", note: "$0.25 → $1.50 · sharper, reads photos", vision: true },
];
const SMART_OPTS: Opt[] = [
  { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", note: "$0.38 → $1.88 · good value", vision: true },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash", note: "$1.50 → $9.00 · stronger", vision: true },
  { id: "x-ai/grok-4.6", label: "Grok 4.6", note: "$2.00 → $6.00 · strong, cheaper output", vision: true },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", note: "$2.00 → $10.00 · best at teaching", vision: true },
  { id: "openai/gpt-5.2", label: "GPT-5.2", note: "$1.75 → $14.00 · strong reasoning", vision: true },
];
// Clip stills + narration. Verified against the live OpenRouter catalog
// (image: /api/v1/images, speech: /api/v1/audio/speech) on 2026-08-20.
const IMAGE_OPTS: Opt[] = [
  { id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", note: "cheapest per still", vision: false },
  { id: "google/gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image", note: "sharper, a bit pricier", vision: false },
  { id: "openai/gpt-5-image-mini", label: "GPT-5 Image Mini", note: "different look, good with people", vision: false },
  { id: "google/gemini-3-pro-image", label: "Gemini 3 Pro Image", note: "best quality, costs the most", vision: false },
];
const VOICE_OPTS: Opt[] = [
  { id: "deepgram/aura-2", label: "Aura 2", note: "natural narrator — the default", vision: false },
  { id: "hexgrad/kokoro-82m", label: "Kokoro", note: "nearly free", vision: false },
  { id: "minimax/speech-2.8-hd", label: "MiniMax Speech HD", note: "most expressive", vision: false },
  { id: "microsoft/mai-voice-2", label: "MAI Voice 2", note: "clean and neutral", vision: false },
];
const DEFAULTS: Record<Tier, string> = {
  fast: "google/gemini-2.5-flash-lite",
  smart: "google/gemini-3.7-flash",
  image: "google/gemini-2.5-flash-image",
  voice: "deepgram/aura-2",
};
const okId = (v: string) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(v) && v.length <= 100;

const USES: Record<Tier, string> = {
  fast: "Schedule parsing · vocab · transcripts · food photos · briefing · affirmations",
  smart: "Chapters · exams · study guides · podcast · the Run · grading · flashcards · mind maps · coaching · every question you ask",
  image: "The stills in your clips — one per scene",
  voice: "The narration in your clips",
};
const TIER_LABEL: Record<Tier, string> = {
  fast: "Fast — the menial stuff",
  smart: "Smart — learning & questions",
  image: "Clip stills",
  voice: "Clip narration",
};
const OPTS: Record<Tier, Opt[]> = { fast: FAST_OPTS, smart: SMART_OPTS, image: IMAGE_OPTS, voice: VOICE_OPTS };

export default function AIModels() {
  const [models, setModels] = useState<Record<Tier, string>>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [custom, setCustom] = useState<Record<Tier, string>>({ fast: "", smart: "", image: "", voice: "" });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const saving = useRef(false);
  const [busy, setBusy] = useState<Tier | "">("");

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("user_settings").select("ai_models").maybeSingle();
      // a failed read must not present defaults as "your choices"
      if (error) { setLoadErr(true); setLoaded(true); return; }
      const m = (data?.ai_models ?? {}) as Partial<Record<Tier, string>>;
      const next = { ...DEFAULTS };
      (Object.keys(DEFAULTS) as Tier[]).forEach((k) => { if (m[k] && okId(m[k]!)) next[k] = m[k]!; });
      setModels(next);
      setCustom({
        fast: OPTS.fast.some((o) => o.id === next.fast) ? "" : next.fast,
        smart: OPTS.smart.some((o) => o.id === next.smart) ? "" : next.smart,
        image: OPTS.image.some((o) => o.id === next.image) ? "" : next.image,
        voice: OPTS.voice.some((o) => o.id === next.voice) ? "" : next.voice,
      });
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function pick(tier: Tier, id: string) {
    if (saving.current || !okId(id)) { if (!okId(id)) setErr("That doesn't look like a model id — it's always provider/name."); return; }
    saving.current = true; setBusy(tier); setErr(""); setMsg("");
    const prev = models;
    const next = { ...models, [tier]: id };
    setModels(next);                                   // optimistic, reverted on failure
    try {
      const { data: u } = await supabase.auth.getUser();
      const uid = u.user?.id;
      if (!uid) { setModels(prev); setErr("Signed out — sign back in and try again."); return; }
      const { error } = await supabase.from("user_settings")
        .upsert({ user_id: uid, ai_models: next }, { onConflict: "user_id" });
      if (error) { setModels(prev); setErr("Couldn't save that — still on the old model."); return; }
      sfx.pop();
      setMsg(`${TIER_LABEL[tier]} now runs on ${id}.`);
    } catch { setModels(prev); setErr("Couldn't reach the server — nothing changed."); }
    finally { saving.current = false; setBusy(""); }
  }

  if (!loaded) return <div className="skeleton h-28 mt-3" />;

  return (
    <Card className="mt-3">
      <div className="flex items-baseline justify-between">
        <Eyebrow>Models</Eyebrow>
        <span className="mono text-[9px] text-[var(--text-4)]">$ per million tokens</span>
      </div>
      {loadErr ? (
        <button onClick={load} className="w-full mt-2 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">
          Couldn&apos;t load your choices — tap to retry
        </button>
      ) : (
        <>
          {(["fast", "smart", "image", "voice"] as Tier[]).map((tier) => {
            const opts = OPTS[tier];
            const isCustom = !opts.some((o) => o.id === models[tier]);
            return (
              <div key={tier} className="mt-3.5 first:mt-2.5">
                <p className="text-sm font-semibold">
                  {TIER_LABEL[tier]}
                  {busy === tier && <span className="mono text-[10px] text-[var(--text-4)] ml-2">saving…</span>}
                </p>
                <p className="text-[10px] text-[var(--text-3)] mt-0.5 leading-relaxed">{USES[tier]}</p>
                <div className="mt-2 space-y-1">
                  {opts.map((o) => {
                    const on = models[tier] === o.id;
                    return (
                      <button key={o.id} onClick={() => pick(tier, o.id)} disabled={!!busy}
                        className={`w-full text-left rounded-lg border px-3 py-2 flex items-center gap-2 active:scale-[0.99] disabled:opacity-50 transition-colors ${on ? "border-[var(--neon)]/50 bg-[var(--neon)]/10" : "border-[var(--border-1)] bg-[var(--raised)]"}`}>
                        <span className={`w-3.5 h-3.5 rounded-full border shrink-0 ${on ? "border-[var(--neon)] bg-[var(--neon)]" : "border-white/25"}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-medium truncate">{o.label}</span>
                          <span className="block mono text-[10px] text-[var(--text-4)]">{o.note}</span>
                        </span>
                      </button>
                    );
                  })}
                  <div className="flex gap-1.5 pt-0.5">
                    <input value={custom[tier]} onChange={(e) => setCustom((c) => ({ ...c, [tier]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter" && custom[tier].trim()) pick(tier, custom[tier].trim()); }}
                      placeholder="or any model id — provider/name"
                      className={`flex-1 min-w-0 rounded-lg bg-black/25 px-3 py-2 outline-none text-xs mono border ${isCustom ? "border-[var(--neon)]/40" : "border-transparent"}`} />
                    <button onClick={() => pick(tier, custom[tier].trim())} disabled={!!busy || !custom[tier].trim()}
                      className="px-3 rounded-lg bg-white/10 text-xs font-bold active:scale-95 disabled:opacity-30">set</button>
                  </div>
                </div>
              </div>
            );
          })}
          <p className="text-[10px] text-[var(--text-4)] mt-3 leading-relaxed">
            Anything with a photo in it (snap-a-meal) needs a Fast model that reads images. Browse every model and its live price at openrouter.ai/models — paste any id above. These apply to an OpenRouter key; an Anthropic key uses Anthropic&apos;s own models.
          </p>
        </>
      )}
      {msg && <p className="text-[11px] text-[var(--ok)] mt-2">{msg}</p>}
      {err && <p className="text-[11px] text-orange-400 mt-2">{err}</p>}
    </Card>
  );
}
