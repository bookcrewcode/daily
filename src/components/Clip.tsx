"use client";

// 🎬 Clip player — stills with a slow Ken Burns push, burned-in captions, and
// the narration track driving everything. The audio element is the clock: scene
// boundaries are derived from its REAL duration, so a voice that runs long or
// short can never desync the images from the words.
//
// Export writes an actual video file (canvas capture + the narration track
// muxed in) so a clip he likes can go straight to a channel.

import { useCallback, useEffect, useRef, useState } from "react";
import { type Clip, sceneTimings, signClip } from "@/lib/clips";

type Props = {
  clip: Clip;
  autoPlay?: boolean;
  active?: boolean;          // feed: only the on-screen clip may play
  onEnded?: () => void;
  compact?: boolean;
};

export default function ClipPlayer({ clip, autoPlay = false, active = true, onEnded, compact = false }: Props) {
  const [images, setImages] = useState<(string | null)[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [signErr, setSignErr] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // sign the private objects (6h URLs, re-signed on remount)
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const { images: im, audio } = await signClip(clip);
        if (dead) return;
        setImages(im); setAudioUrl(audio); setSignErr(false); setReady(true);
      } catch { if (!dead) { setSignErr(true); setReady(true); } }
    })();
    return () => { dead = true; };
  }, [clip]);

  // the feed pauses whatever scrolls away — never two voices at once
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!active) { a.pause(); setPlaying(false); return; }
    if (autoPlay && ready && audioUrl) {
      a.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); // autoplay may be blocked; the tap-to-play overlay covers it
    }
  }, [active, autoPlay, ready, audioUrl]);

  const times = dur > 0 ? sceneTimings(clip, dur) : [];
  const idx = Math.max(0, times.findIndex((x) => t >= x.start && t < x.end));
  const scene = clip.scenes[idx] ?? clip.scenes[0];
  const span = times[idx] ? Math.max(0.001, times[idx].end - times[idx].start) : 1;
  const within = times[idx] ? (t - times[idx].start) / span : 0;   // 0-1 through this scene, drives the push

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) { a.play().then(() => setPlaying(true)).catch(() => { }); }
    else { a.pause(); setPlaying(false); }
  }

  if (!ready) return <div className={`skeleton w-full ${compact ? "aspect-video" : "aspect-[9/16]"} rounded-xl`} />;

  return (
    <div className={`relative w-full ${compact ? "aspect-video" : "aspect-[9/16]"} rounded-xl overflow-hidden bg-black select-none`}
      onClick={toggle}>
      {/* stills — only the current one is painted, pushed slowly for life */}
      {clip.scenes.map((s, i) => {
        const url = images[i];
        const on = i === idx;
        return (
          <div key={i} className="absolute inset-0" style={{ opacity: on ? 1 : 0, transition: "opacity 420ms ease" }}>
            {url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt={s.caption || s.narration.slice(0, 60)} draggable={false}
                className="absolute inset-0 w-full h-full object-cover"
                style={{
                  transform: on ? `scale(${1.06 + within * 0.09}) translate3d(${(i % 2 ? -1 : 1) * within * 1.6}%, ${-within * 1.2}%, 0)` : "scale(1.06)",
                  transition: "transform 120ms linear",
                }} />
            ) : (
              <div className="absolute inset-0 grid place-items-center bg-[var(--raised)]">
                <p className="text-xs text-[var(--text-4)] px-6 text-center">{s.caption || "scene"}</p>
              </div>
            )}
          </div>
        );
      })}

      {/* legibility floor + captions */}
      <div className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/85 to-transparent pointer-events-none" />
      <div className="absolute inset-x-0 bottom-0 p-4 pointer-events-none">
        {scene?.caption && (
          <p className="text-white font-bold leading-tight drop-shadow-lg" style={{ fontSize: compact ? "1rem" : "1.35rem" }}>
            {scene.caption}
          </p>
        )}
        {!compact && scene?.narration && (
          <p className="text-white/85 text-[13px] leading-snug mt-1.5 drop-shadow line-clamp-3">{scene.narration}</p>
        )}
      </div>

      {/* scene progress — one segment per scene, the film-strip read */}
      <div className="absolute top-0 inset-x-0 flex gap-1 p-2 pointer-events-none">
        {clip.scenes.map((_, i) => (
          <div key={i} className="h-[3px] flex-1 rounded-full bg-white/25 overflow-hidden">
            <div className="h-full bg-white" style={{ width: i < idx ? "100%" : i === idx ? `${Math.min(100, within * 100)}%` : "0%" }} />
          </div>
        ))}
      </div>

      {/* tap-to-play — also the recovery when autoplay is blocked */}
      {!playing && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="w-14 h-14 rounded-full bg-black/55 border border-white/25 grid place-items-center">
            <span className="text-white text-xl ml-0.5">▶</span>
          </div>
        </div>
      )}

      {signErr && (
        <p className="absolute top-3 left-3 right-3 text-[11px] text-orange-300 bg-black/70 rounded px-2 py-1">
          Couldn&apos;t load this clip&apos;s media — tap to retry from the notebook.
        </p>
      )}

      {audioUrl && (
        <audio ref={audioRef} src={audioUrl} preload="auto"
          onLoadedMetadata={(e) => setDur((e.target as HTMLAudioElement).duration || 0)}
          onTimeUpdate={(e) => setT((e.target as HTMLAudioElement).currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); onEnded?.(); }} />
      )}
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────
// Renders the clip to a real video file: a canvas painted frame-by-frame with
// the same pans and captions, with the narration piped in as a live audio
// track. Runs in real time (a 40s clip takes 40s) because MediaRecorder
// records a live stream — so the UI must say so rather than look hung.
export async function exportClip(
  clip: Clip,
  onProgress: (pct: number) => void,
): Promise<{ blob?: Blob; ext?: string; error?: string }> {
  if (typeof window === "undefined") return { error: "Not available here." };
  if (typeof MediaRecorder === "undefined") return { error: "This browser can't record video — try Chrome on a desktop." };

  const { images, audio } = await signClip(clip);
  if (!audio) return { error: "This clip has no narration yet." };
  if (!images.some(Boolean)) return { error: "This clip has no images yet." };

  // load every still first — a half-loaded image would export as a black frame
  const bitmaps: (HTMLImageElement | null)[] = await Promise.all(
    images.map((url) => new Promise<HTMLImageElement | null>((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    })),
  );

  const W = 1080, H = 1920;                      // vertical, the format he's posting
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { error: "Couldn't open a canvas to render into." };

  const el = new Audio();
  el.src = audio;
  el.crossOrigin = "anonymous";
  await new Promise<void>((res) => { el.onloadedmetadata = () => res(); el.onerror = () => res(); });
  const duration = el.duration || clip.seconds || 30;
  const times = sceneTimings(clip, duration);

  // route the narration through WebAudio so it can be BOTH heard-free and muxed
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ac = new AC();
  const src = ac.createMediaElementSource(el);
  const dest = ac.createMediaStreamDestination();
  src.connect(dest);                              // recorded, intentionally NOT connected to speakers

  const stream = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));

  const mime = ["video/mp4;codecs=avc1,mp4a.40.2", "video/webm;codecs=vp9,opus", "video/webm"]
    .find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  if (!mime) { ac.close(); return { error: "This browser has no video encoder available." }; }

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  const wrap = (text: string, maxW: number): string[] => {
    const words = text.split(/\s+/); const lines: string[] = []; let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  };

  let raf = 0;
  const draw = () => {
    const now = el.currentTime;
    const i = Math.max(0, times.findIndex((x) => now >= x.start && now < x.end));
    const scene = clip.scenes[i];
    const span = times[i] ? Math.max(0.001, times[i].end - times[i].start) : 1;
    const within = times[i] ? (now - times[i].start) / span : 0;

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const img = bitmaps[i];
    if (img) {
      const scale = (1.06 + within * 0.09) * Math.max(W / img.width, H / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      const dx = (W - dw) / 2 + (i % 2 ? -1 : 1) * within * W * 0.016;
      const dy = (H - dh) / 2 - within * H * 0.012;
      ctx.drawImage(img, dx, dy, dw, dh);
    }
    // caption block
    const g = ctx.createLinearGradient(0, H * 0.6, 0, H);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.86)");
    ctx.fillStyle = g; ctx.fillRect(0, H * 0.6, W, H * 0.4);
    if (scene?.caption) {
      ctx.font = "700 74px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "#fff"; ctx.textBaseline = "bottom";
      const lines = wrap(scene.caption, W - 120);
      lines.forEach((ln, k) => ctx.fillText(ln, 60, H - 210 + (k - lines.length + 1) * 84));
    }
    if (scene?.narration) {
      ctx.font = "500 40px system-ui, -apple-system, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      const lines = wrap(scene.narration, W - 120).slice(0, 3);
      lines.forEach((ln, k) => ctx.fillText(ln, 60, H - 90 + (k - lines.length + 1) * 50));
    }
    onProgress(Math.min(0.99, now / duration));
    raf = requestAnimationFrame(draw);
  };

  return new Promise((resolve) => {
    rec.onstop = () => {
      cancelAnimationFrame(raf);
      ac.close().catch(() => { });
      onProgress(1);
      const blob = new Blob(chunks, { type: mime.split(";")[0] });
      resolve({ blob, ext: mime.startsWith("video/mp4") ? "mp4" : "webm" });
    };
    el.onended = () => { try { rec.stop(); } catch { /* already stopped */ } };
    rec.start(250);
    raf = requestAnimationFrame(draw);
    el.play().catch(() => {
      cancelAnimationFrame(raf);
      try { rec.stop(); } catch { /* nothing recorded */ }
      ac.close().catch(() => { });
      resolve({ error: "The browser blocked playback — tap the clip once, then export." });
    });
  });
}
