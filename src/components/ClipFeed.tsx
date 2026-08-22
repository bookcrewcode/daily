"use client";

// The swipe feed — every finished clip in this chapter, vertical and
// autoplaying, one idea per swipe. Reached from the reading ("play all"), not
// from a tab of its own: it's the same material he's already working through,
// just in the format that survives a low-focus evening.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { type Clip, normalize } from "@/lib/clips";
import ClipPlayer, { exportClip } from "./Clip";
import { sfx } from "@/lib/fx";

export default function ClipFeed({ uid, chapterId, onClose }: { uid: string; chapterId: string; onClose: () => void }) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [active, setActive] = useState(0);
  const [note, setNote] = useState("");
  const [pct, setPct] = useState(0);
  const [exporting, setExporting] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("notebook_clips")
        .select("*").eq("user_id", uid).eq("chapter_id", chapterId).eq("status", "ready")
        .order("beat", { ascending: true, nullsFirst: false }).order("created_at");
      if (error) { setLoadErr(true); setLoaded(true); return; }
      setClips(((data ?? []) as Clip[]).map(normalize));
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid, chapterId]);
  useEffect(() => { load(); }, [load]);

  // only the clip on screen is allowed to play — never two voices at once
  useEffect(() => {
    const root = scroller.current;
    if (!root || !clips.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio > 0.6) {
            const i = Number((e.target as HTMLElement).dataset.i);
            if (!Number.isNaN(i)) setActive(i);
          }
        }
      },
      { root, threshold: [0.6] },
    );
    items.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [clips.length]);

  function next() {
    const n = active + 1;
    if (n < clips.length) items.current[n]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function save() {
    const c = clips[active];
    if (!c || exporting) return;
    setExporting(true); setPct(0); setNote("Rendering in real time — keep this open…");
    const r = await exportClip(c, setPct);
    setExporting(false);
    if (r.error || !r.blob) { setNote(r.error ?? "Couldn't export that one."); return; }
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${c.title.replace(/[^\w\s-]/g, "").trim().slice(0, 60) || "clip"}.${r.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setNote("Saved to your downloads.");
    sfx.coin();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <button onClick={onClose} className="absolute top-3 right-3 z-10 w-9 h-9 rounded-full bg-black/60 border border-white/20 text-white active:scale-90">✕</button>
      {clips.length > 0 && (
        <button onClick={save} disabled={exporting}
          className="absolute top-3 left-3 z-10 rounded-full bg-black/60 border border-white/20 text-white text-[11px] font-semibold px-3 py-2 active:scale-95 disabled:opacity-50">
          {exporting ? `saving ${Math.round(pct * 100)}%` : "save this one"}
        </button>
      )}

      {!loaded && <div className="h-full grid place-items-center"><p className="text-white/40 text-sm">Loading…</p></div>}
      {loaded && loadErr && (
        <div className="h-full grid place-items-center px-8">
          <button onClick={load} className="text-orange-300 text-sm underline">Couldn&apos;t load the clips — tap to retry</button>
        </div>
      )}
      {loaded && !loadErr && clips.length === 0 && (
        <div className="h-full grid place-items-center px-8 text-center">
          <p className="text-white/60 text-sm">No finished clips in this chapter yet — make one from a teaching point and it shows up here.</p>
        </div>
      )}

      <div ref={scroller} className="h-full overflow-y-auto no-scrollbar" style={{ scrollSnapType: "y mandatory" }}>
        {clips.map((c, i) => (
          <div key={c.id} data-i={i} ref={(el) => { items.current[i] = el; }}
            className="h-full w-full flex items-center justify-center" style={{ scrollSnapAlign: "start", scrollSnapStop: "always" }}>
            <div className="w-full max-w-md">
              <ClipPlayer clip={c} active={i === active} autoPlay onEnded={next} />
              <p className="text-white/60 text-[11px] mono text-center mt-2 px-4">
                {i + 1} / {clips.length} · swipe for the next idea
              </p>
            </div>
          </div>
        ))}
      </div>

      {note && (
        <p className="absolute bottom-4 left-4 right-4 text-center text-[11px] text-white/80 bg-black/70 rounded-lg py-2 px-3">{note}</p>
      )}
    </div>
  );
}
