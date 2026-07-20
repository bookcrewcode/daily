"use client";

// 🎙️ Audio overview — a two-host podcast about the notebook, generated from
// Ben's own sources and spoken ON-DEVICE with the Web Speech API (free, no
// keys). Two hosts are pitch-shifted so they're distinguishable even on a phone
// with a single system voice. The script is saved so it doesn't regenerate.
//
// Fixed player is portaled to <body> so a Card's backdrop-filter can't trap it.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import { advisorCall, type PodSegment } from "@/lib/notebook";
import { sfx } from "@/lib/fx";

type QItem = { text: string; seg: number; speaker: "A" | "B" };
type Status = "idle" | "playing" | "paused";

export default function Podcast({ uid, notebookId, chapterId = null, chapterTitle = "", onClose }: {
  uid: string; notebookId: string; chapterId?: string | null; chapterTitle?: string; onClose: () => void;
}) {
  const [segments, setSegments] = useState<PodSegment[]>([]);
  const [title, setTitle] = useState("Audio overview");
  const [loading, setLoading] = useState(true);
  const [gen, setGen] = useState(false);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [cur, setCur] = useState(-1);
  const [supported, setSupported] = useState(true);

  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const queueRef = useRef<QItem[]>([]);
  const stopRef = useRef(false);
  const statusRef = useRef<Status>("idle");
  const beatRef = useRef<number | null>(null);

  const setStat = (s: Status) => { statusRef.current = s; setStatus(s); };

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) { setSupported(false); return; }
    const loadVoices = () => { voicesRef.current = window.speechSynthesis.getVoices(); };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      // halt the onend/onerror chain — cancel() fires onerror, which would
      // otherwise speak the NEXT sentence even though we're unmounting (e.g. a
      // token expiry mid-episode drops the whole tree to the login screen).
      stopRef.current = true;
      try { window.speechSynthesis.onvoiceschanged = null; window.speechSynthesis.cancel(); } catch { /* noop */ }
      if (beatRef.current) clearInterval(beatRef.current);
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let query = supabase.from("notebook_audio").select("title,segments,chapter_id")
        .eq("user_id", uid).eq("notebook_id", notebookId).order("created_at", { ascending: false }).limit(1);
      query = chapterId ? query.eq("chapter_id", chapterId) : query.is("chapter_id", null);
      const { data, error } = await query;
      if (error) return; // keep whatever's shown
      const row = (data ?? [])[0] as { title: string; segments: PodSegment[] } | undefined;
      if (row?.segments?.length) { setSegments(row.segments); setTitle(row.title || "Audio overview"); }
    } catch { /* keep whatever's shown */ } finally { setLoading(false); }
  }, [uid, notebookId, chapterId]);
  useEffect(() => { load(); }, [load]);

  async function generate() {
    if (gen) return;
    stop();
    setGen(true); setErr("");
    try {
      const json = await advisorCall<{ title?: string; segments?: PodSegment[]; error?: string }>({ advisor: "podcast", topicId: notebookId, chapterTitle });
      if (json.error || !json.segments?.length) { setErr(json.error || "Couldn't write the episode — try again."); return; }
      // write-first: only swap the shown episode once the save lands
      const { error } = await supabase.from("notebook_audio").insert({ user_id: uid, notebook_id: notebookId, chapter_id: chapterId, title: json.title ?? "Audio overview", segments: json.segments });
      if (error) { setErr("Wrote the episode but couldn't save it — try again."); return; }
      setSegments(json.segments); setTitle(json.title ?? "Audio overview"); sfx.coin();
    } catch {
      setErr("Couldn't reach the server — try again.");
    } finally {
      setGen(false);
    }
  }

  function pickVoice(speaker: "A" | "B"): SpeechSynthesisVoice | null {
    const all = voicesRef.current;
    if (!all.length) return null;
    const en = all.filter((v) => /^en(-|_)/i.test(v.lang));
    const pool = en.length ? en : all;
    if (speaker === "A") return pool[0] ?? null;
    return pool.find((v) => v !== pool[0]) ?? pool[0] ?? null;
  }

  function buildQueue(): QItem[] {
    const q: QItem[] = [];
    segments.forEach((s, si) => {
      const parts = s.text.match(/[^.!?]+[.!?]*(\s+|$)/g) ?? [s.text]; // sentence-size to dodge the ~15s cutoff bug
      parts.forEach((p) => { const t = p.trim(); if (t) q.push({ text: t, seg: si, speaker: s.speaker === "B" ? "B" : "A" }); });
    });
    return q;
  }

  function speakAt(i: number) {
    const q = queueRef.current;
    if (i >= q.length) { stopBeat(); setStat("idle"); setCur(-1); return; }
    const item = q[i];
    setCur(item.seg);
    const u = new SpeechSynthesisUtterance(item.text);
    const v = pickVoice(item.speaker); if (v) u.voice = v;
    u.rate = 1.0;
    u.pitch = item.speaker === "B" ? 0.85 : 1.12;
    u.onend = () => { if (!stopRef.current) speakAt(i + 1); };
    u.onerror = () => { if (!stopRef.current) speakAt(i + 1); };
    try { window.speechSynthesis.speak(u); } catch { /* noop */ }
  }

  function startBeat() {
    if (beatRef.current) return;
    // Chrome silently pauses long synthesis; nudge it only while we intend to play.
    beatRef.current = window.setInterval(() => {
      try { if (statusRef.current === "playing") window.speechSynthesis.resume(); } catch { /* noop */ }
    }, 8000);
  }
  function stopBeat() { if (beatRef.current) { clearInterval(beatRef.current); beatRef.current = null; } }

  function play() {
    if (!supported || !segments.length) return;
    try { window.speechSynthesis.cancel(); } catch { /* noop */ }
    stopRef.current = false;
    queueRef.current = buildQueue();
    setStat("playing"); startBeat();
    speakAt(0);
  }
  function pause() { setStat("paused"); try { window.speechSynthesis.pause(); } catch { /* noop */ } }
  function resume() { setStat("playing"); try { window.speechSynthesis.resume(); } catch { /* noop */ } }
  function stop() { stopRef.current = true; try { window.speechSynthesis.cancel(); } catch { /* noop */ } stopBeat(); setStat("idle"); setCur(-1); }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end md:items-center md:justify-center" onClick={() => { stop(); onClose(); }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full md:max-w-lg bg-[var(--background)] rounded-t-3xl md:rounded-3xl border-t md:border border-white/10 p-4 pb-8 md:pb-4 max-h-[88vh] flex flex-col" style={{ animation: "fadeSlide 0.2s ease" }}>
        <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-3 md:hidden" />
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs uppercase tracking-widest opacity-60">🎙️ {chapterTitle ? "Chapter podcast" : "Notebook podcast"}</p>
          <button onClick={() => { stop(); onClose(); }} className="text-sm opacity-50 active:scale-90">✕</button>
        </div>

        {loading ? (
          <div className="skeleton h-24" />
        ) : segments.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-sm opacity-60 mb-4">A two-host audio overview of {chapterTitle ? `“${chapterTitle}”` : "this notebook"}, built from your sources — listen instead of scroll.</p>
            <button onClick={generate} disabled={gen} className="rounded-xl bg-[var(--neon)] text-black font-bold px-5 py-2.5 active:scale-95 disabled:opacity-50">
              {gen ? "writing the episode…" : "🎬 Generate episode"}
            </button>
          </div>
        ) : (
          <>
            <p className="font-bold text-lg leading-tight mb-1">{title}</p>
            <p className="text-[10px] opacity-40 mb-3">On-device voices · Host A ⇄ Host B · {segments.length} turns</p>

            <div className="flex items-center gap-2 mb-3">
              {status === "playing" ? (
                <button onClick={pause} className="rounded-full bg-[var(--neon)] text-black w-12 h-12 grid place-items-center text-lg active:scale-90">⏸</button>
              ) : status === "paused" ? (
                <button onClick={resume} className="rounded-full bg-[var(--neon)] text-black w-12 h-12 grid place-items-center text-lg active:scale-90">▶</button>
              ) : (
                <button onClick={play} disabled={gen} className="rounded-full bg-[var(--neon)] text-black w-12 h-12 grid place-items-center text-lg active:scale-90 disabled:opacity-40">▶</button>
              )}
              <button onClick={stop} disabled={status === "idle"} className="rounded-full bg-white/10 w-12 h-12 grid place-items-center text-lg active:scale-90 disabled:opacity-30">⏹</button>
              <div className="flex-1" />
              <button onClick={generate} disabled={gen} className="text-[11px] opacity-50 underline active:scale-95">{gen ? "…" : "regenerate"}</button>
            </div>

            {!supported && <p className="text-xs text-orange-300 mb-2">This browser can&apos;t speak here — read the transcript below.</p>}

            <div className="overflow-y-auto space-y-2 flex-1 -mx-1 px-1">
              {segments.map((s, i) => (
                <div key={i} className={`text-sm rounded-xl px-3 py-2 transition ${cur === i ? "bg-[var(--neon)]/20 ring-1 ring-[var(--neon)]/40" : s.speaker === "B" ? "bg-black/30" : "bg-white/[0.04]"}`}>
                  <span className="text-[10px] font-bold opacity-50 mr-1.5">{s.speaker === "B" ? "B" : "A"}</span>{s.text}
                </div>
              ))}
            </div>
          </>
        )}
        {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
      </div>
    </div>,
    document.body,
  );
}
