"use client";

// 📓 An open notebook — the whole learning surface for one subject:
// progress bar, the AI-built chapters (sequentially unlocked = leveled), the
// podcast + major-exam tools, the source library, and the grounded Tutor chat.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { advisorCall, notebookProgress, type Notebook, type NBChapter } from "@/lib/notebook";
import { sfx } from "@/lib/fx";
import { Card } from "./ui";
import NotebookSources from "./NotebookSources";
import NotebookChat from "./NotebookChat";
import ChapterView from "./ChapterView";
import Podcast from "./Podcast";
import MajorTest from "./MajorTest";

export default function NotebookView({ uid, notebook, onBack }: {
  uid: string; notebook: Notebook; onBack: () => void;
}) {
  const [chapters, setChapters] = useState<NBChapter[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [openChapter, setOpenChapter] = useState<string | null>(null);
  const [gen, setGen] = useState(false);
  const [err, setErr] = useState("");
  const [trunk, setTrunk] = useState(notebook.trunk);
  const [podcast, setPodcast] = useState(false);
  const [exam, setExam] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("notebook_chapters")
        .select("id,notebook_id,idx,title,objective,summary,pack,status,best_score,created_at")
        .eq("user_id", uid).eq("notebook_id", notebook.id).order("idx", { ascending: true });
      if (error) { setLoadErr(true); setLoaded(true); return; }
      setChapters((data ?? []) as NBChapter[]);
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid, notebook.id]);
  useEffect(() => { load(); }, [load]);

  // Design (and optionally rebuild) the chapters. Everything after setGen(true)
  // is inside try/catch/finally so a rejected write (offline) can't jam the
  // button forever, and the syllabus is designed + validated BEFORE any delete
  // so a design failure never touches existing chapters.
  async function buildChapters(replace: boolean) {
    if (gen) return;
    if (replace && !confirm("Rebuild the chapters from your current sources? This clears your chapter progress and starts the levels over.")) return;
    setGen(true); setErr("");
    try {
      const json = await advisorCall<{ trunk?: string; chapters?: { title: string; objective: string; summary: string }[]; error?: string }>({
        advisor: "syllabus", topicId: notebook.id, title: notebook.title, subject: notebook.subject,
      });
      if (json.error || !json.chapters?.length) { setErr(json.error || "Couldn't design chapters — add a source first, then try again."); return; }
      if (replace) {
        const { error: delErr } = await supabase.from("notebook_chapters").delete().eq("notebook_id", notebook.id);
        if (delErr) { setErr("Couldn't clear the old chapters — try again."); return; }
      }
      const rows = json.chapters.map((c, i) => ({ user_id: uid, notebook_id: notebook.id, idx: i, title: c.title, objective: c.objective, summary: c.summary, status: "active" }));
      const { error } = await supabase.from("notebook_chapters").insert(rows);
      // if a rebuild deleted the old chapters but this insert failed, re-read so
      // the UI shows the real (now-empty) state instead of the deleted list
      if (error) { if (replace) await load(); setErr("Couldn't save the chapters — tap Build to try again."); return; }
      if (json.trunk && !trunk) {
        const { error: tErr } = await supabase.from("notebooks").update({ trunk: json.trunk }).eq("id", notebook.id);
        if (!tErr) setTrunk(json.trunk);
      }
      sfx.coin();
      await load();
    } catch {
      setErr("Couldn't reach the server — try again.");
    } finally {
      setGen(false);
    }
  }

  const prog = notebookProgress(chapters);
  const openCh = chapters.find((c) => c.id === openChapter) ?? null;

  if (openCh) {
    return (
      <div>
        <ChapterView key={openCh.id} uid={uid} notebookId={notebook.id} chapter={openCh}
          onBack={() => { setOpenChapter(null); load(); }} onChanged={load} />
      </div>
    );
  }

  return (
    <div>
      <button onClick={onBack} className="text-sm opacity-50 mb-2 active:scale-95">← Notebooks</button>

      <div className="flex items-start gap-3">
        <span className="text-3xl">{notebook.emoji || "📓"}</span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold leading-tight">{notebook.title}</h1>
          {notebook.subject && <p className="text-sm opacity-60 mt-0.5">{notebook.subject}</p>}
        </div>
      </div>
      {trunk && <p className="text-xs opacity-50 mt-2">🌳 <b>The one root truth:</b> {trunk}</p>}

      {/* progress */}
      {chapters.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs opacity-60 mb-1">
            <span>{prog.done}/{prog.total} chapters</span><span>{prog.pct}%</span>
          </div>
          <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full bg-[var(--neon)] transition-all" style={{ width: `${prog.pct}%` }} />
          </div>
        </div>
      )}

      {/* tools */}
      <div className="grid grid-cols-2 gap-2 mt-4">
        <button onClick={() => setPodcast(true)} className="rounded-xl bg-white/5 border border-white/10 py-3 active:scale-95">
          <div className="text-xl">🎙️</div><div className="text-xs font-semibold mt-0.5">Podcast</div>
        </button>
        <button onClick={() => setExam(true)} className="rounded-xl bg-white/5 border border-white/10 py-3 active:scale-95">
          <div className="text-xl">📝</div><div className="text-xs font-semibold mt-0.5">Major exam</div>
        </button>
      </div>

      {/* chapters */}
      <div className="mt-5">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs uppercase tracking-widest opacity-60">📗 Chapters</p>
          {chapters.length > 0 && <button onClick={() => buildChapters(true)} disabled={gen} className="text-[10px] opacity-40 underline">rebuild</button>}
        </div>

        {!loaded ? (
          <div className="skeleton h-16" />
        ) : loadErr ? (
          <button onClick={load} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">Couldn&apos;t load chapters — tap to retry</button>
        ) : chapters.length === 0 ? (
          <Card tone="neon" className="text-center">
            <p className="text-sm opacity-70 mb-3">Add your material below, then let me break it into a leveled course — trunk first, easy to hard.</p>
            <button onClick={() => buildChapters(false)} disabled={gen} className="rounded-xl bg-[var(--neon)] text-black font-bold px-5 py-2.5 active:scale-95 disabled:opacity-50">
              {gen ? "designing your chapters…" : "✨ Build my chapters"}
            </button>
            {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
          </Card>
        ) : (
          <div className="space-y-2">
            {chapters.map((c, i) => {
              const unlocked = i === 0 || chapters[i - 1].status === "done" || c.status === "done";
              return (
                <button key={c.id} disabled={!unlocked} onClick={() => unlocked && setOpenChapter(c.id)} className="w-full text-left disabled:opacity-40">
                  <Card padded={false} className="p-3.5">
                    <div className="flex items-center gap-3">
                      <div className={`w-7 h-7 rounded-full grid place-items-center text-sm shrink-0 ${c.status === "done" ? "bg-[var(--neon)] text-black font-bold" : unlocked ? "bg-white/10" : "bg-white/5"}`}>
                        {c.status === "done" ? "✓" : unlocked ? i + 1 : "🔒"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm truncate">{c.title}</p>
                        {c.objective && <p className="text-[11px] opacity-50 truncate">{c.objective}</p>}
                      </div>
                      {c.status === "done" && c.best_score > 0 && <span className="text-[10px] opacity-50 shrink-0">{c.best_score}%</span>}
                    </div>
                  </Card>
                </button>
              );
            })}
            {err && <p className="text-xs text-orange-400 mt-1">{err}</p>}
          </div>
        )}
      </div>

      <NotebookSources uid={uid} notebookId={notebook.id} />
      <NotebookChat uid={uid} notebookId={notebook.id} />

      {podcast && <Podcast uid={uid} notebookId={notebook.id} onClose={() => setPodcast(false)} />}
      {exam && <MajorTest uid={uid} notebookId={notebook.id} onClose={() => setExam(false)} />}
    </div>
  );
}
