"use client";

// 📓 Notebooks — the new Learning section. A NotebookLM-style notebook per
// subject: your sources, an AI-built leveled course, quizzes, a podcast, and a
// grounded tutor, each saving its own context. This replaces the old topic Hub.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { type Notebook } from "@/lib/notebook";
import { sfx } from "@/lib/fx";
import { SectionTitle, Card } from "./ui";
import NotebookView from "./NotebookView";

const EMOJI = ["📓", "📗", "📘", "📙", "🧠", "💻", "🧪", "🎸", "🗣️", "📈", "⚖️", "🩺"];

export default function Notebooks({ uid }: { uid: string }) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [agg, setAgg] = useState<Record<string, { done: number; total: number }>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("notebooks")
        .select("id,title,subject,why,emoji,trunk,archived,created_at")
        .eq("user_id", uid).eq("archived", false).order("created_at", { ascending: false });
      if (error) { setLoadErr(true); setLoaded(true); return; }
      setNotebooks((data ?? []) as Notebook[]);
      setLoadErr(false); setLoaded(true);
      // per-notebook progress (one grouped read; failure just hides the bars)
      const { data: chs, error: cErr } = await supabase.from("notebook_chapters").select("notebook_id,status").eq("user_id", uid);
      if (!cErr && chs) {
        const m: Record<string, { done: number; total: number }> = {};
        for (const c of chs as { notebook_id: string; status: string }[]) {
          const e = (m[c.notebook_id] ??= { done: 0, total: 0 });
          e.total++; if (c.status === "done") e.done++;
        }
        setAgg(m);
      }
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  const openNb = notebooks.find((n) => n.id === selected) ?? null;
  if (openNb) return <NotebookView uid={uid} notebook={openNb} onBack={() => { setSelected(null); load(); }} />;

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">📓 Notebooks</h1>
      <p className="opacity-50 text-sm mt-1">Your NotebookLM — one notebook per subject. Add your sources, get a leveled course with quizzes, a podcast, and a tutor that teaches from YOUR material.</p>

      <SectionTitle>Your notebooks</SectionTitle>
      {!loaded ? (
        <div className="skeleton h-16" />
      ) : loadErr ? (
        <button onClick={load} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">Couldn&apos;t load your notebooks — tap to retry</button>
      ) : notebooks.length === 0 ? (
        <p className="opacity-40 text-sm">No notebooks yet — start one below and spend your time learning instead of scrolling.</p>
      ) : (
        <div className="space-y-2">
          {notebooks.map((n) => {
            const a = agg[n.id];
            const pct = a && a.total ? Math.round((a.done / a.total) * 100) : 0;
            return (
              <button key={n.id} onClick={() => setSelected(n.id)} className="w-full text-left">
                <Card padded={false} className="p-3.5">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl shrink-0">{n.emoji || "📓"}</span>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold truncate">{n.title}</p>
                      {n.subject && <p className="text-xs opacity-50 truncate">{n.subject}</p>}
                      {a && a.total > 0 && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div className="h-full bg-[var(--neon)]" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-[10px] opacity-40">{a.done}/{a.total}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              </button>
            );
          })}
        </div>
      )}

      {!creating ? (
        <button onClick={() => setCreating(true)} className="mt-4 w-full rounded-xl border border-dashed border-white/20 py-3 opacity-70 active:scale-95">+ New notebook</button>
      ) : (
        <NewNotebook uid={uid} onDone={(id) => { setCreating(false); load(); if (id) setSelected(id); }} onCancel={() => setCreating(false)} />
      )}
    </div>
  );
}

function NewNotebook({ uid, onDone, onCancel }: { uid: string; onDone: (id?: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [why, setWhy] = useState("");
  const [emoji, setEmoji] = useState("📓");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function create() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true); setErr("");
    try {
      // write-first; return the row so we can open it straight away
      const { data, error } = await supabase.from("notebooks")
        .insert({ user_id: uid, title: t.slice(0, 160), subject: subject.trim().slice(0, 300), why: why.trim().slice(0, 500), emoji })
        .select("id").single();
      if (error || !data) { setErr("Couldn't create that — try again."); setBusy(false); return; }
      sfx.coin();
      onDone((data as { id: string }).id);
    } catch {
      setErr("Couldn't reach the server — try again.");
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4">
      <p className="text-xs uppercase tracking-widest opacity-60 mb-2">New notebook</p>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {EMOJI.map((e) => (
          <button key={e} onClick={() => setEmoji(e)} className={`w-9 h-9 rounded-lg text-lg grid place-items-center ${emoji === e ? "bg-[var(--neon)]/20 ring-1 ring-[var(--neon)]/50" : "bg-white/5"}`}>{e}</button>
        ))}
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} placeholder="what are you learning? (e.g. Options trading)"
        className="w-full rounded-lg bg-black/30 px-3 py-2.5 outline-none text-sm mb-2" />
      <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={busy} placeholder="what does mastery look like? (optional)"
        className="w-full rounded-lg bg-black/30 px-3 py-2.5 outline-none text-sm mb-2" />
      <input value={why} onChange={(e) => setWhy(e.target.value)} disabled={busy} placeholder="why do you want it? (optional)"
        className="w-full rounded-lg bg-black/30 px-3 py-2.5 outline-none text-sm mb-2" />
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 rounded-xl bg-white/10 py-2.5 text-sm font-semibold active:scale-95">Cancel</button>
        <button onClick={create} disabled={busy || !title.trim()} className="flex-1 rounded-xl bg-[var(--neon)] text-black py-2.5 text-sm font-bold active:scale-95 disabled:opacity-40">
          {busy ? "creating…" : "Create"}
        </button>
      </div>
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
    </Card>
  );
}
