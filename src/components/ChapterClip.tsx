"use client";

// 🎬 The clip that follows the reading.
//
// Ben's correction, verbatim: "it shouldn't be its own section. It should just
// be something that is following along with the chapter I'm on and like where
// I'm at." So there is no shelf, no topic box, no duration dropdown here — this
// component knows which chapter and which teaching beat he is on, shows the
// clip for THAT beat if it exists, and otherwise offers one button to make it.
//
// Clips are keyed by (chapter_id, beat), so moving through the chapter moves
// through the clips, and coming back to a beat replays the one already paid for.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { type Clip, type GenProgress, generateClip, finishClip, normalize } from "@/lib/clips";
import ClipPlayer from "./Clip";
import { sfx, buzz } from "@/lib/fx";

export default function ChapterClip({ uid, notebookId, chapterId, beat, concept, onOpenFeed }: {
  uid: string; notebookId: string; chapterId: string; beat: number; concept: string;
  onOpenFeed?: () => void;
}) {
  const [clip, setClip] = useState<Clip | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [gen, setGen] = useState<GenProgress | null>(null);
  const [err, setErr] = useState("");
  const busy = useRef(false);

  const load = useCallback(async () => {
    setLoaded(false);
    try {
      const { data, error } = await supabase.from("notebook_clips")
        .select("*").eq("user_id", uid).eq("chapter_id", chapterId).eq("beat", beat)
        .order("created_at", { ascending: false }).limit(1);
      // a failed read must not look like "no clip yet" and tempt a second pay
      if (error) { setLoadErr(true); setLoaded(true); return; }
      const row = (data ?? [])[0];
      setClip(row ? normalize(row as Clip) : null);
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid, chapterId, beat]);
  useEffect(() => { load(); }, [load]);

  async function make() {
    if (busy.current) return;
    busy.current = true; setErr(""); setGen({ stage: "script", done: 0, total: 1, note: "Writing it from your sources…" });
    try {
      const r = await generateClip(
        { notebookId, chapterId, concept, seconds: 30, beat },
        (p) => setGen(p),
      );
      if (r.clip) setClip(r.clip);
      if (r.error) { setErr(r.error); return; }
      sfx.coin(); buzz(15);
    } finally { busy.current = false; setGen(null); }
  }

  async function resume() {
    if (busy.current || !clip) return;
    busy.current = true; setErr(""); setGen({ stage: "images", done: 0, total: clip.scenes.length, note: "Picking up where it stopped…" });
    try {
      const r = await finishClip(clip, (p) => setGen(p));
      setClip(r.clip);
      if (r.error) setErr(r.error);
      else { sfx.coin(); buzz(15); }
    } finally { busy.current = false; setGen(null); }
  }

  if (!loaded) return <div className="skeleton h-9 mt-2" />;

  // the good state: a finished clip for exactly this point
  if (clip?.status === "ready") {
    return (
      <div className="mt-2.5 rise-in">
        <ClipPlayer clip={clip} compact />
        <div className="flex items-center gap-2 mt-1">
          <span className="mono text-[9px] text-[var(--text-4)] flex-1 truncate">{clip.title}</span>
          {onOpenFeed && (
            <button onClick={onOpenFeed} className="text-[10px] font-semibold text-[var(--neon)] active:scale-95">play all →</button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2.5">
      {gen ? (
        <div>
          <p className="mono text-[11px] text-[var(--text-2)]">{gen.note}</p>
          <div className="h-1 rounded-full bg-white/10 overflow-hidden mt-1.5">
            <div className="h-full bg-[var(--neon)] transition-[width] duration-300"
              style={{ width: `${gen.stage === "script" ? 8 : gen.stage === "done" ? 100 : 8 + (gen.done / Math.max(1, gen.total)) * 78 + (gen.stage === "voice" ? 10 : 0)}%` }} />
          </div>
          <p className="text-[10px] text-[var(--text-4)] mt-1">About a minute — the stills render one at a time.</p>
        </div>
      ) : loadErr ? (
        <button onClick={load} className="text-xs rounded-full bg-orange-500/15 border border-orange-500/30 text-orange-300 px-3 py-1.5 active:scale-95">
          Couldn&apos;t check for a clip — tap to retry
        </button>
      ) : clip ? (
        <button onClick={resume}
          className="text-xs rounded-full bg-[var(--warn)]/12 border border-[var(--warn)]/30 text-[var(--warn)] px-3 py-1.5 active:scale-95">
          🎬 finish this clip ({clip.scenes.filter((s) => s.image_path).length}/{clip.scenes.length} scenes done)
        </button>
      ) : (
        <button onClick={make}
          className="text-xs rounded-full bg-[var(--neon)]/12 border border-[var(--neon)]/30 text-[var(--neon)] px-3 py-1.5 active:scale-95">
          🎬 watch this point
        </button>
      )}
      {err && <p className="text-[11px] text-orange-400 mt-1.5">{err}</p>}
    </div>
  );
}
