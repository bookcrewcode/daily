"use client";

// 📖 Study Guide — the thing you actually read to understand a notebook. A rich,
// AI-built overview grounded in your sources: the one root truth, the big ideas
// taught properly, key terms, the misconceptions to avoid, and why it matters.
// Rendered on a warm "paper" surface in an editorial serif — this is where the
// app slows down. Cached on the notebook so it's instant next time.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { advisorCall, type StudyGuide as Guide } from "@/lib/notebook";
import { sfx } from "@/lib/fx";
import { Card, Prose } from "./ui";

export default function StudyGuide({ uid, notebookId, title }: { uid: string; notebookId: string; title: string }) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [openTerm, setOpenTerm] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("notebooks").select("study_guide").eq("id", notebookId).maybeSingle();
      if (error) { setLoadErr(true); setLoaded(true); return; }
      setGuide((data?.study_guide ?? null) as Guide | null);
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [notebookId]);
  useEffect(() => { load(); }, [load]);

  async function generate() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const json = await advisorCall<{ guide?: Guide; error?: string }>({ advisor: "study-guide", topicId: notebookId, title });
      if (json.error || !json.guide) { setErr(json.error || "Couldn't build the study guide — try again."); return; }
      // write-first: cache on the notebook, then show
      const { error } = await supabase.from("notebooks").update({ study_guide: json.guide }).eq("id", notebookId);
      if (error) { setErr("Built it but couldn't save it — try again."); return; }
      setGuide(json.guide); sfx.coin();
    } catch {
      setErr("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <div className="skeleton h-40 mt-3" />;

  if (loadErr) {
    return <button onClick={load} className="mt-3 w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">Couldn&apos;t load the study guide — tap to retry</button>;
  }

  if (!guide) {
    return (
      <Card tone="paper" className="mt-3 text-center">
        <div className="text-3xl mb-2">📖</div>
        <p className="study-prose text-[1rem] mb-4">A clear overview of this whole notebook — the one root truth, the big ideas taught properly, the terms, and the traps. Built from your sources.</p>
        <button onClick={generate} disabled={busy} className="rounded-xl bg-[var(--neon)] text-black font-bold px-5 py-2.5 active:scale-95 disabled:opacity-50">
          {busy ? "writing your guide…" : "✨ Build the study guide"}
        </button>
        {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
      </Card>
    );
  }

  return (
    <div className="mt-3 space-y-3 rise-in">
      {/* TL;DR + trunk */}
      <Card tone="paper">
        <p className="text-[10px] uppercase tracking-widest opacity-40 mb-1.5">The gist</p>
        <Prose text={guide.tldr} />
        {guide.trunk && (
          <div className="mt-3 pt-3 border-t border-[var(--paper-border)]">
            <p className="text-[10px] uppercase tracking-widest text-[var(--neon)]/80 mb-1">🌳 The one root truth</p>
            <p className="study-prose italic text-[1.02rem]">{guide.trunk}</p>
          </div>
        )}
      </Card>

      {/* Big ideas */}
      {guide.big_ideas.length > 0 && (
        <div className="space-y-2.5">
          {guide.big_ideas.map((b, i) => (
            <Card key={i} tone="paper">
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="font-display text-sm text-[var(--neon)] font-bold">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="font-display font-bold text-[1.05rem] leading-tight">{b.title}</h3>
              </div>
              <Prose text={b.point} />
            </Card>
          ))}
        </div>
      )}

      {/* Key terms — tap to reveal */}
      {guide.key_terms.length > 0 && (
        <Card>
          <p className="text-[10px] uppercase tracking-widest opacity-40 mb-2">Key terms · tap to test yourself</p>
          <div className="space-y-1">
            {guide.key_terms.map((t, i) => (
              <button key={i} onClick={() => setOpenTerm(openTerm === i ? null : i)} className="w-full text-left rounded-lg px-2.5 py-2 hover:bg-white/5 transition-colors">
                <p className="text-sm font-semibold">{t.term}</p>
                {openTerm === i && <p className="study-prose text-[0.95rem] mt-1 rise-in">{t.definition}</p>}
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Misconceptions */}
      {guide.misconceptions.length > 0 && (
        <Card tone="warn">
          <p className="text-[10px] uppercase tracking-widest text-orange-300/90 mb-2">⚠️ Don&apos;t get tripped up</p>
          <ul className="space-y-1.5">
            {guide.misconceptions.map((m, i) => <li key={i} className="study-prose text-[0.98rem]">{m}</li>)}
          </ul>
        </Card>
      )}

      {/* So what */}
      {guide.so_what && (
        <Card tone="neon">
          <p className="text-[10px] uppercase tracking-widest text-[var(--neon)]/80 mb-1">Why it matters</p>
          <Prose text={guide.so_what} />
        </Card>
      )}

      <button onClick={generate} disabled={busy} className="w-full text-[11px] opacity-40 underline py-1 active:scale-95">
        {busy ? "rebuilding…" : "rebuild the study guide"}
      </button>
      {err && <p className="text-xs text-orange-400">{err}</p>}
    </div>
  );
}
