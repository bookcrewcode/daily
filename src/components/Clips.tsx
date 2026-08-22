"use client";

// 🎬 Clips — the notebook's video shelf, plus the swipeable feed.
//
// Two ways in, because they serve different moods:
//   SHELF  deliberate — make a clip about a specific idea, see what it cost,
//          export the good ones.
//   FEED   thumb-through — vertical, autoplaying, one idea per swipe. This is
//          the ADHD half: 60 seconds of his own material with zero decisions.

import { useCallback, useEffect, useRef, useState } from "react";
import { type Clip, type GenProgress, generateClip, finishClip, listClips, deleteClip, signClip } from "@/lib/clips";
import ClipPlayer, { exportClip } from "./Clip";
import { Card, Eyebrow } from "./ui";
import { sfx, buzz } from "@/lib/fx";

export default function Clips({ uid, notebookId, chapterId, concept, compactHeader }: {
  uid: string; notebookId: string; chapterId?: string | null; concept?: string; compactHeader?: boolean;
}) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [gen, setGen] = useState<GenProgress | null>(null);
  const [err, setErr] = useState("");
  const [topic, setTopic] = useState(concept ?? "");
  const [secs, setSecs] = useState(40);
  const [feedAt, setFeedAt] = useState<number | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    const r = await listClips(uid, notebookId);
    if (r.error) { setLoadErr(true); setLoaded(true); return; }
    setClips(r.clips); setLoadErr(false); setLoaded(true);
  }, [uid, notebookId]);
  useEffect(() => { load(); }, [load]);

  async function make() {
    if (busy.current) return;
    busy.current = true; setErr(""); setGen({ stage: "script", done: 0, total: 1, note: "Starting…" });
    try {
      const r = await generateClip(
        { notebookId, chapterId: chapterId ?? null, concept: topic.trim(), seconds: secs },
        (p) => setGen(p),
      );
      if (r.clip) setClips((cs) => [r.clip!, ...cs.filter((c) => c.id !== r.clip!.id)]);
      if (r.error) { setErr(r.error); return; }
      sfx.coin(); buzz(15);
      setTopic("");
    } finally { busy.current = false; setGen(null); }
  }

  async function resume(c: Clip) {
    if (busy.current) return;
    busy.current = true; setErr(""); setGen({ stage: "images", done: 0, total: c.scenes.length, note: "Picking up where it stopped…" });
    try {
      const r = await finishClip(c, (p) => setGen(p));
      setClips((cs) => cs.map((x) => (x.id === r.clip.id ? r.clip : x)));
      if (r.error) setErr(r.error);
      else { sfx.coin(); buzz(15); }
    } finally { busy.current = false; setGen(null); }
  }

  async function remove(c: Clip) {
    if (!confirm(`Delete "${c.title}"? The images and narration go too.`)) return;
    const ok = await deleteClip(c);
    if (!ok) { setErr("Couldn't delete that one — try again."); return; }
    setClips((cs) => cs.filter((x) => x.id !== c.id));
  }

  const ready = clips.filter((c) => c.status === "ready");
  const spent = clips.reduce((t, c) => t + c.cost_usd, 0);

  return (
    <div>
      <div className="flex items-baseline justify-between mt-1">
        <Eyebrow>{compactHeader ? "Clips" : "Clips — watch what you're learning"}</Eyebrow>
        {ready.length > 0 && (
          <button onClick={() => setFeedAt(0)} className="text-[11px] font-semibold text-[var(--neon)] active:scale-95">
            ▶ feed ({ready.length})
          </button>
        )}
      </div>

      {/* make one */}
      <Card className="mt-2">
        <div className="flex gap-1.5">
          <input value={topic} onChange={(e) => setTopic(e.target.value)} disabled={!!gen}
            onKeyDown={(e) => { if (e.key === "Enter" && !gen) make(); }}
            placeholder={concept ? "this point (or type another idea)" : "an idea from this notebook — blank picks the best one"}
            className="flex-1 min-w-0 rounded-lg bg-black/25 px-3 py-2 outline-none text-sm" />
          <select value={secs} onChange={(e) => setSecs(Number(e.target.value))} disabled={!!gen}
            className="rounded-lg bg-black/25 px-2 py-2 outline-none text-xs mono shrink-0">
            <option value={20}>20s</option>
            <option value={40}>40s</option>
            <option value={60}>60s</option>
          </select>
          <button onClick={make} disabled={!!gen}
            className="px-3.5 rounded-lg bg-[var(--neon)] text-black text-sm font-bold active:scale-95 disabled:opacity-40">
            {gen ? "…" : "make"}
          </button>
        </div>
        {gen && (
          <div className="mt-2.5">
            <p className="mono text-[11px] text-[var(--text-2)]">{gen.note}</p>
            <div className="h-1 rounded-full bg-white/10 overflow-hidden mt-1.5">
              <div className="h-full bg-[var(--neon)] transition-[width] duration-300"
                style={{ width: `${gen.stage === "script" ? 8 : gen.stage === "done" ? 100 : 8 + (gen.done / Math.max(1, gen.total)) * 78 + (gen.stage === "voice" ? 10 : 0)}%` }} />
            </div>
            <p className="text-[10px] text-[var(--text-4)] mt-1">Images render one at a time — a 40s clip takes about a minute.</p>
          </div>
        )}
        {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
        {spent > 0 && !gen && (
          <p className="mono text-[10px] text-[var(--text-4)] mt-2">{clips.length} clip{clips.length === 1 ? "" : "s"} · ${spent.toFixed(3)} spent here</p>
        )}
      </Card>

      {/* the shelf */}
      {!loaded && <div className="skeleton h-28 mt-3" />}
      {loadErr && (
        <button onClick={load} className="w-full mt-3 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">
          Couldn&apos;t load your clips — tap to retry
        </button>
      )}
      {loaded && !loadErr && clips.length > 0 && (
        <div className="grid grid-cols-2 gap-2 mt-3">
          {clips.map((c, i) => (
            <ClipTile key={c.id} clip={c} onOpen={() => c.status === "ready" ? setFeedAt(ready.findIndex((r) => r.id === c.id)) : resume(c)}
              onDelete={() => remove(c)} busy={!!gen} index={i} />
          ))}
        </div>
      )}

      {feedAt !== null && ready.length > 0 && (
        <ClipFeed clips={ready} startAt={Math.max(0, feedAt)} onClose={() => setFeedAt(null)} />
      )}
    </div>
  );
}

function ClipTile({ clip, onOpen, onDelete, busy }: { clip: Clip; onOpen: () => void; onDelete: () => void; busy: boolean; index: number }) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [pct, setPct] = useState(0);
  const [note, setNote] = useState("");

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const { images } = await signClip(clip);
        if (!dead) setThumb(images.find(Boolean) ?? null);
      } catch { /* tile just stays dark */ }
    })();
    return () => { dead = true; };
  }, [clip]);

  async function save() {
    if (exporting) return;
    setExporting(true); setPct(0); setNote("Rendering in real time — leave this open…");
    const r = await exportClip(clip, setPct);
    setExporting(false);
    if (r.error || !r.blob) { setNote(r.error ?? "Couldn't export that one."); return; }
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${clip.title.replace(/[^\w\s-]/g, "").trim().slice(0, 60) || "clip"}.${r.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setNote("Saved to your downloads.");
    sfx.coin();
  }

  const done = clip.status === "ready";
  const shot = clip.scenes.filter((s) => s.image_path).length;

  return (
    <div className="rounded-xl border border-[var(--border-1)] bg-[var(--card)] overflow-hidden">
      <button onClick={onOpen} disabled={busy} className="block w-full aspect-[9/16] relative bg-black active:scale-[0.99] disabled:opacity-60">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : <div className="absolute inset-0 bg-[var(--raised)]" />}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-2">
          <p className="text-white text-[11px] font-semibold leading-tight line-clamp-2 text-left">{clip.title}</p>
        </div>
        {!done && (
          <div className="absolute inset-0 grid place-items-center bg-black/60">
            <p className="mono text-[10px] text-white text-center px-2">
              {clip.status === "failed" ? "failed" : `${shot}/${clip.scenes.length} scenes`}<br />
              <span className="text-[var(--neon)]">tap to finish</span>
            </p>
          </div>
        )}
      </button>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <span className="mono text-[9px] text-[var(--text-4)] flex-1 truncate">
          {done ? `${clip.scenes.length} scenes · $${clip.cost_usd.toFixed(3)}` : clip.status}
        </span>
        {done && (
          <button onClick={save} disabled={exporting} className="text-[10px] font-semibold text-[var(--neon)] active:scale-95 disabled:opacity-40">
            {exporting ? `${Math.round(pct * 100)}%` : "save"}
          </button>
        )}
        <button onClick={onDelete} className="text-[10px] opacity-30 active:scale-90">✕</button>
      </div>
      {note && <p className="text-[9px] text-[var(--text-3)] px-2 pb-1.5 leading-tight">{note}</p>}
    </div>
  );
}

// Vertical snap feed — only the clip on screen plays, and it advances itself.
function ClipFeed({ clips, startAt, onClose }: { clips: Clip[]; startAt: number; onClose: () => void }) {
  const [active, setActive] = useState(startAt);
  const scroller = useRef<HTMLDivElement | null>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    items.current[startAt]?.scrollIntoView({ block: "start" });
  }, [startAt]);

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
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

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <button onClick={onClose} className="absolute top-3 right-3 z-10 w-9 h-9 rounded-full bg-black/60 border border-white/20 text-white active:scale-90">✕</button>
      <div ref={scroller} className="h-full overflow-y-auto no-scrollbar" style={{ scrollSnapType: "y mandatory" }}>
        {clips.map((c, i) => (
          <div key={c.id} data-i={i} ref={(el) => { items.current[i] = el; }}
            className="h-full w-full flex items-center justify-center" style={{ scrollSnapAlign: "start", scrollSnapStop: "always" }}>
            <div className="w-full max-w-md">
              <ClipPlayer clip={c} active={i === active} autoPlay onEnded={next} />
              <p className="text-white/60 text-[11px] mono text-center mt-2 px-4">{i + 1} / {clips.length} · swipe for the next idea</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
