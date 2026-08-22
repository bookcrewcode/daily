"use client";

// 🎬 Clips — short narrated explainers built from a notebook's own sources.
//
// Ben's ask: 15-60s videos per idea that play alongside the reading, in the
// faceless-explainer format (AI stills, slow pans, a real voice, captions) —
// and good enough to post. Generation is THREE server stages so nothing times
// out and the UI can show real progress instead of a spinner:
//
//   1. script  → storyboard grounded in his material   (text model)
//   2. images  → one still per scene, stored privately (image model)
//   3. voice   → one narration mp3 + scene timings     (speech model)
//
// A clip is usable the moment stage 3 lands; a failure at any stage leaves the
// row in the DB with what it has, so a retry resumes instead of restarting
// (stage 2 skips scenes that already have a stored image — no double billing).

import { supabase, SUPABASE_ANON, CLIPS_FN } from "./supabase";

// One call into the clips edge function. Mirrors advisorCall's contract: the
// resolved value is either the payload or { error }, and a network rejection
// becomes a synthetic { error } so no caller needs its own try/catch to be safe.
async function clipCall<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T & { error?: string }> {
  try {
    const { data: session } = await supabase.auth.getSession();
    const res = await fetch(CLIPS_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T & { error?: string };
  } catch {
    return { error: "Couldn't reach the server — check your connection and try again." } as T & { error?: string };
  }
}

export type ClipScene = {
  narration: string;
  caption: string;
  image_prompt: string;
  image_path: string | null;
  seconds: number;       // share of total duration (0-1) after voicing
};

export type Clip = {
  id: string;
  notebook_id: string;
  chapter_id: string | null;
  concept: string;
  title: string;
  hook: string;
  scenes: ClipScene[];
  audio_path: string | null;
  seconds: number;
  status: "scripted" | "imaging" | "imaged" | "voicing" | "ready" | "failed";
  err: string | null;
  posted: boolean;
  cost_usd: number;
  created_at: string;
};

export type GenProgress = { stage: "script" | "images" | "voice" | "done"; done: number; total: number; note: string };

// Signed URLs for the private bucket. Batched, and tolerant: a single missing
// object must not blank the whole clip.
export async function signClip(clip: Clip): Promise<{ images: (string | null)[]; audio: string | null }> {
  const paths = clip.scenes.map((s) => s.image_path).filter((p): p is string => !!p);
  let images: (string | null)[] = clip.scenes.map(() => null);
  if (paths.length) {
    const { data } = await supabase.storage.from("clips").createSignedUrls(paths, 60 * 60 * 6);
    const byPath = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
    images = clip.scenes.map((s) => (s.image_path ? byPath.get(s.image_path) ?? null : null));
  }
  let audio: string | null = null;
  if (clip.audio_path) {
    const { data } = await supabase.storage.from("clips").createSignedUrl(clip.audio_path, 60 * 60 * 6);
    audio = data?.signedUrl ?? null;
  }
  return { images, audio };
}

// Full pipeline. onStep fires between stages so the caller can narrate honestly.
export async function generateClip(
  args: { notebookId: string; chapterId?: string | null; concept?: string; seconds?: number; voice?: string },
  onStep: (p: GenProgress) => void,
): Promise<{ clip?: Clip; error?: string }> {
  onStep({ stage: "script", done: 0, total: 1, note: "Writing the script from your sources…" });
  const scripted = await clipCall<{ clip: Clip }>({
    stage: "script",
    notebookId: args.notebookId,
    chapterId: args.chapterId ?? null,
    concept: args.concept ?? "",
    seconds: args.seconds ?? 40,
  });
  if (scripted.error || !scripted.clip) return { error: scripted.error ?? "Couldn't write the script." };

  let clip = normalize(scripted.clip);
  const total = clip.scenes.length;

  for (let i = 0; i < total; i++) {
    onStep({ stage: "images", done: i, total, note: `Rendering scene ${i + 1} of ${total}…` });
    const shot = await clipCall<{ clip?: Clip; path?: string }>({ stage: "image", clipId: clip.id, scene: i });
    if (shot.error) {
      // keep whatever landed — the row survives and a retry resumes here
      return { clip, error: `Scene ${i + 1} failed: ${shot.error}` };
    }
    if (shot.clip) clip = normalize(shot.clip);
  }

  onStep({ stage: "voice", done: total, total, note: "Recording the narration…" });
  const voiced = await clipCall<{ clip: Clip }>({ stage: "voice", clipId: clip.id, voice: args.voice ?? "alloy" });
  if (voiced.error || !voiced.clip) return { clip, error: voiced.error ?? "Couldn't record the narration." };

  clip = normalize(voiced.clip);
  onStep({ stage: "done", done: total, total, note: "Ready." });
  return { clip };
}

// Resume a half-built clip (any missing image, then voice if absent).
export async function finishClip(clip: Clip, onStep: (p: GenProgress) => void, voice = "alloy"): Promise<{ clip: Clip; error?: string }> {
  let cur = clip;
  const total = cur.scenes.length;
  for (let i = 0; i < total; i++) {
    if (cur.scenes[i]?.image_path) continue;
    onStep({ stage: "images", done: i, total, note: `Rendering scene ${i + 1} of ${total}…` });
    const shot = await clipCall<{ clip?: Clip }>({ stage: "image", clipId: cur.id, scene: i });
    if (shot.error) return { clip: cur, error: shot.error };
    if (shot.clip) cur = normalize(shot.clip);
  }
  if (!cur.audio_path) {
    onStep({ stage: "voice", done: total, total, note: "Recording the narration…" });
    const voiced = await clipCall<{ clip?: Clip }>({ stage: "voice", clipId: cur.id, voice });
    if (voiced.error) return { clip: cur, error: voiced.error };
    if (voiced.clip) cur = normalize(voiced.clip);
  }
  onStep({ stage: "done", done: total, total, note: "Ready." });
  return { clip: cur };
}

// The server stores scenes as jsonb; guarantee the shape the player expects.
export function normalize(row: Clip): Clip {
  const scenes = (Array.isArray(row.scenes) ? row.scenes : []).map((s) => ({
    narration: String(s?.narration ?? ""),
    caption: String(s?.caption ?? ""),
    image_prompt: String(s?.image_prompt ?? ""),
    image_path: s?.image_path ?? null,
    seconds: Number(s?.seconds ?? 0) || 0,
  }));
  return { ...row, scenes, cost_usd: Number(row.cost_usd ?? 0) || 0 };
}

// Scene boundaries in SECONDS, given the audio's real duration. The server
// stores each scene's share of the words; the audio element is the truth.
export function sceneTimings(clip: Clip, duration: number): { start: number; end: number }[] {
  const shares = clip.scenes.map((s) => (s.seconds > 0 ? s.seconds : 1 / Math.max(1, clip.scenes.length)));
  const sum = shares.reduce((t, v) => t + v, 0) || 1;
  let acc = 0;
  return shares.map((share) => {
    const start = (acc / sum) * duration;
    acc += share;
    return { start, end: (acc / sum) * duration };
  });
}

export async function listClips(uid: string, notebookId?: string): Promise<{ clips: Clip[]; error?: boolean }> {
  let q = supabase.from("notebook_clips").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(60);
  if (notebookId) q = q.eq("notebook_id", notebookId);
  try {
    const { data, error } = await q;
    if (error) return { clips: [], error: true };
    return { clips: ((data ?? []) as Clip[]).map(normalize) };
  } catch { return { clips: [], error: true }; }
}

// Deleting a clip must take its stored objects with it, or the bucket fills up
// with orphans nothing references.
export async function deleteClip(clip: Clip): Promise<boolean> {
  const paths = [...clip.scenes.map((s) => s.image_path).filter((p): p is string => !!p)];
  if (clip.audio_path) paths.push(clip.audio_path);
  try {
    if (paths.length) await supabase.storage.from("clips").remove(paths);
    const { error } = await supabase.from("notebook_clips").delete().eq("id", clip.id);
    return !error;
  } catch { return false; }
}
