"use client";

// 🕸️ Mind Map — the notebook's concept structure at a glance: the trunk at the
// top, main branches, a few leaves each. Built from your sources, cached on the
// notebook. A vertical connected tree (reads cleanly on a phone, unlike a
// radial that overflows).

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { advisorCall, type MindMap as MM } from "@/lib/notebook";
import { sfx } from "@/lib/fx";
import { Card } from "./ui";

export default function MindMap({ uid, notebookId, title }: { uid: string; notebookId: string; title: string }) {
  const [map, setMap] = useState<MM | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("notebooks").select("mindmap").eq("id", notebookId).maybeSingle();
      if (error) { setLoadErr(true); setLoaded(true); return; }
      setMap((data?.mindmap ?? null) as MM | null);
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [notebookId]);
  useEffect(() => { load(); }, [load]);

  async function generate() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const json = await advisorCall<{ root?: string; branches?: MM["branches"]; error?: string }>({ advisor: "mindmap", topicId: notebookId, title });
      if (json.error || !json.branches?.length) { setErr(json.error || "Couldn't build the mind map — try again."); return; }
      const built: MM = { root: json.root || title, branches: json.branches };
      const { error } = await supabase.from("notebooks").update({ mindmap: built }).eq("id", notebookId);
      if (error) { setErr("Built it but couldn't save it — try again."); return; }
      setMap(built); sfx.coin();
    } catch {
      setErr("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <div className="skeleton h-40 mt-3" />;
  if (loadErr) return <button onClick={load} className="mt-3 w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">Couldn&apos;t load the mind map — tap to retry</button>;

  if (!map) {
    return (
      <Card className="mt-3 text-center">
        <div className="text-3xl mb-2">🕸️</div>
        <p className="text-sm opacity-60 mb-4">See how it all connects — the trunk, the branches, the leaves — built from your sources.</p>
        <button onClick={generate} disabled={busy} className="rounded-xl bg-[var(--neon)] text-black font-bold px-5 py-2.5 active:scale-95 disabled:opacity-50">
          {busy ? "mapping…" : "✨ Build the mind map"}
        </button>
        {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
      </Card>
    );
  }

  return (
    <div className="mt-3 rise-in">
      <Card tone="paper" padded={false} className="p-4 overflow-hidden">
        {/* root */}
        <div className="flex justify-center mb-1">
          <span className="rounded-full bg-[var(--neon)] text-black font-display font-bold text-sm px-4 py-1.5 text-center">{map.root}</span>
        </div>

        <div className="space-y-4 mt-3">
          {map.branches.map((b, i) => (
            <div key={i} className="relative pl-4">
              {/* branch node */}
              <div className="flex items-center gap-2">
                <span className="absolute left-0 top-2 w-2 h-2 rounded-full bg-[var(--neon)]" />
                <span className="absolute left-[3px] top-3 bottom-0 w-px bg-white/10" />
                <p className="font-display font-bold text-[0.98rem]">{b.label}</p>
              </div>
              {/* leaves */}
              {b.children.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2 ml-1">
                  {b.children.map((c, j) => (
                    <span key={j} className="rounded-lg bg-white/[0.05] border border-white/10 text-xs px-2.5 py-1">{c}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
      <button onClick={generate} disabled={busy} className="w-full text-[11px] opacity-40 underline py-1 mt-2 active:scale-95">
        {busy ? "rebuilding…" : "rebuild the mind map"}
      </button>
      {err && <p className="text-xs text-orange-400">{err}</p>}
    </div>
  );
}
