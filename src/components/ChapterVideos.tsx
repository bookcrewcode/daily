"use client";

// 📺 CHAPTER VIDEOS — watch first, then get asked about it.
//
// This replaces the AI clip generator, which never produced a single finished
// video in weeks of trying. Ben's call, and the right one: real explainers from
// people who are good at this beat anything the app could generate.
//
// Two deliberate choices:
//  • Click to play. A chapter can carry five videos and loading five iframes on
//    open would make the page crawl; a thumbnail costs one small image, and the
//    embed only mounts when he actually wants it.
//  • youtube-nocookie.com, so opening a chapter doesn't hand YouTube a tracking
//    cookie for a video he hasn't watched.
//
// Every id here was verified against YouTube's oEmbed endpoint when the
// curriculum was authored, and the titles are YouTube's own — see lib/curriculum.

import { useState } from "react";
import type { ChapterVideo } from "@/lib/curriculum";
import { Card } from "./ui";

export default function ChapterVideos({ videos, compact }: { videos: ChapterVideo[]; compact?: boolean }) {
  const [playing, setPlaying] = useState<string | null>(null);
  const [open, setOpen] = useState(!compact);
  if (!videos?.length) return null;

  const list = (
    <div className="space-y-2.5">
      {videos.map((v) => (
        <div key={v.id}>
          {playing === v.id ? (
            <div className="rounded-xl overflow-hidden bg-black" style={{ aspectRatio: "16 / 9" }}>
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&rel=0&modestbranding=1`}
                title={v.title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                className="w-full h-full border-0"
              />
            </div>
          ) : (
            <button onClick={() => setPlaying(v.id)}
              aria-label={`Play ${v.title}`}
              className="w-full text-left rounded-xl overflow-hidden relative active:scale-[0.99] bg-black"
              style={{ aspectRatio: "16 / 9" }}>
              {/* hqdefault exists for every video; maxres does not */}
              <img src={`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`} alt=""
                loading="lazy" className="w-full h-full object-cover opacity-80" />
              <span className="absolute inset-0 grid place-items-center">
                <span className="w-14 h-14 rounded-full bg-black/60 border border-white/30 grid place-items-center text-white text-lg pl-1">
                  ▶
                </span>
              </span>
            </button>
          )}
          <p className="text-[13px] font-medium leading-snug mt-1.5">{v.title}</p>
          <p className="text-[11px] text-[var(--text-4)] mono">{v.channel}</p>
          {v.why && <p className="text-[12px] text-[var(--text-3)] leading-relaxed mt-1">{v.why}</p>}
        </div>
      ))}
    </div>
  );

  if (compact) {
    return (
      <div className="mt-2">
        <button onClick={() => setOpen((o) => !o)}
          className="mono text-[10px] text-[var(--neon)] active:scale-95">
          {open ? "▴ hide the videos" : `▾ ${videos.length} video${videos.length === 1 ? "" : "s"} for this chapter`}
        </button>
        {open && <div className="mt-2">{list}</div>}
      </div>
    );
  }

  return (
    <Card className="mt-3">
      <p className="text-[10px] uppercase tracking-widest text-[var(--neon)]/80 mb-1">Watch first</p>
      <p className="text-[12px] text-[var(--text-3)] leading-relaxed mb-3">
        Get the picture in your head before the app starts asking you things. These are
        picked for this chapter and ordered — the first one is the one to watch if you only watch one.
      </p>
      {list}
    </Card>
  );
}
