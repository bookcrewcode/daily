"use client";

// 📓 An open notebook — the whole learning surface for one subject, organized
// like NotebookLM's studio: Sources you feed it, a Study Guide to read, leveled
// Chapters (the mastery spine), spaced-repetition Cards, a Mind Map, and a
// grounded Chat — plus the podcast and exam tools.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { advisorCall, notebookProgress, type Notebook, type NBChapter } from "@/lib/notebook";
import { sfx } from "@/lib/fx";
import { Card, Segmented } from "./ui";
import NotebookSources from "./NotebookSources";
import NotebookChat from "./NotebookChat";
import ChapterView from "./ChapterView";
import Run from "./Run";
import Podcast from "./Podcast";
import MajorTest from "./MajorTest";
import StudyGuide from "./StudyGuide";
import Cards from "./Cards";
import MindMap from "./MindMap";
import Clips from "./Clips";

type Section = "sources" | "guide" | "learn" | "clips" | "cards" | "map" | "chat";
const SECTIONS: { key: Section; label: string; icon: string }[] = [
  { key: "sources", label: "Sources", icon: "📚" },
  { key: "guide", label: "Guide", icon: "📖" },
  { key: "learn", label: "Learn", icon: "📗" },
  { key: "clips", label: "Clips", icon: "🎬" },
  { key: "cards", label: "Cards", icon: "🃏" },
  { key: "map", label: "Map", icon: "🕸️" },
  { key: "chat", label: "Chat", icon: "🎓" },
];

export default function NotebookView({ uid, notebook, onBack }: { uid: string; notebook: Notebook; onBack: () => void }) {
  const [section, setSection] = useState<Section>("learn");
  const [chapters, setChapters] = useState<NBChapter[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [openChapter, setOpenChapter] = useState<string | null>(null);
  const [gen, setGen] = useState(false);
  const [err, setErr] = useState("");
  const [trunk, setTrunk] = useState(notebook.trunk);
  const [podcast, setPodcast] = useState(false);
  const [exam, setExam] = useState(false);
  const [runCh, setRunCh] = useState<NBChapter | null>(null);

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

  async function buildChapters(replace: boolean) {
    if (gen) return;
    if (replace && !confirm("Rebuild the chapters from your current sources? This clears your chapter progress and starts the levels over.")) return;
    setGen(true); setErr("");
    try {
      const json = await advisorCall<{ trunk?: string; chapters?: { title: string; objective: string; summary: string }[]; error?: string }>({
        advisor: "syllabus", topicId: notebook.id, title: notebook.title, subject: notebook.subject,
      });
      if (json.error || !json.chapters?.length) { setErr(json.error || "Couldn't design chapters — add a source first, then try again."); return; }
      // ATOMIC replace: the RPC deletes old + inserts new in ONE transaction, so
      // a failure can never leave the notebook with zero chapters (no data-loss
      // window between a delete and a separate insert).
      const { error } = await supabase.rpc("rebuild_notebook_chapters", {
        p_notebook_id: notebook.id,
        p_chapters: json.chapters.map((c) => ({ title: c.title, objective: c.objective, summary: c.summary })),
      });
      if (error) { await load(); setErr("Couldn't save the chapters — try again (your old chapters are untouched)."); return; }
      if (json.trunk && !trunk) {
        const { error: tErr } = await supabase.from("notebooks").update({ trunk: json.trunk }).eq("id", notebook.id);
        if (!tErr) setTrunk(json.trunk);
      }
      sfx.coin();
      await load();
    } catch { setErr("Couldn't reach the server — try again."); }
    finally { setGen(false); }
  }

  const prog = notebookProgress(chapters);
  const openCh = chapters.find((c) => c.id === openChapter) ?? null;

  if (openCh) {
    return <ChapterView key={openCh.id} uid={uid} notebookId={notebook.id} chapter={openCh} onBack={() => { setOpenChapter(null); load(); }} onChanged={load} />;
  }

  return (
    <div>
      <button onClick={onBack} className="text-sm opacity-50 mb-2 active:scale-95">← Notebooks</button>

      <div className="flex items-start gap-3">
        <span className="text-3xl">{notebook.emoji || "📓"}</span>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-bold leading-tight">{notebook.title}</h1>
          {notebook.subject && <p className="text-sm opacity-60 mt-0.5">{notebook.subject}</p>}
        </div>
        {prog.total > 0 && (
          <div className="text-right shrink-0">
            <p className="font-display text-lg font-black text-[var(--neon)] leading-none">{prog.pct}%</p>
            <p className="text-[9px] uppercase tracking-widest opacity-40">mastered</p>
          </div>
        )}
      </div>
      {trunk && <p className="study-prose text-[0.95rem] mt-2 italic opacity-90">🌳 {trunk}</p>}

      {/* tools */}
      <div className="grid grid-cols-2 gap-2 mt-4">
        <button onClick={() => setPodcast(true)} className="rounded-xl bg-white/5 border border-white/10 py-2.5 active:scale-95 flex items-center justify-center gap-2">
          <span className="text-lg">🎙️</span><span className="text-xs font-semibold">Podcast</span>
        </button>
        <button onClick={() => setExam(true)} className="rounded-xl bg-white/5 border border-white/10 py-2.5 active:scale-95 flex items-center justify-center gap-2">
          <span className="text-lg">📝</span><span className="text-xs font-semibold">Major exam</span>
        </button>
      </div>

      <div className="mt-4">
        <Segmented value={section} onChange={setSection} options={SECTIONS} />
      </div>

      {section === "sources" && <NotebookSources uid={uid} notebookId={notebook.id} />}
      {section === "guide" && <StudyGuide uid={uid} notebookId={notebook.id} title={notebook.title} />}
      {section === "clips" && <Clips uid={uid} notebookId={notebook.id} />}
      {section === "cards" && <Cards uid={uid} notebookId={notebook.id} />}
      {section === "map" && <MindMap uid={uid} notebookId={notebook.id} title={notebook.title} />}
      {section === "chat" && <NotebookChat uid={uid} notebookId={notebook.id} />}

      {section === "learn" && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] uppercase tracking-widest opacity-40">📗 Chapters{prog.total > 0 ? ` · ${prog.done}/${prog.total}` : ""}</p>
            {chapters.length > 0 && <button onClick={() => buildChapters(true)} disabled={gen} className="text-[10px] opacity-40 underline">rebuild</button>}
          </div>

          {!loaded ? (
            <div className="skeleton h-20" />
          ) : loadErr ? (
            <button onClick={load} className="w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">Couldn&apos;t load chapters — tap to retry</button>
          ) : chapters.length === 0 ? (
            <Card tone="paper" className="text-center">
              <div className="text-3xl mb-2">📗</div>
              <p className="study-prose text-[1rem] mb-3">Add your material in <b>Sources</b>, then let me break it into a leveled course — trunk first, easy to hard.</p>
              <button onClick={() => buildChapters(false)} disabled={gen} className="rounded-xl bg-[var(--neon)] text-black font-bold px-5 py-2.5 active:scale-95 disabled:opacity-50">
                {gen ? "designing your chapters…" : "✨ Build my chapters"}
              </button>
              {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
            </Card>
          ) : (
            // mastery spine — the thread the chapters hang off, filling as you clear them
            <div className="relative pl-8 overflow-hidden">
              <div className="absolute left-3 top-3 bottom-3 w-[3px] spine-track rounded-full" />
              <div className="absolute left-3 top-3 w-[3px] spine-fill rounded-full transition-all duration-500" style={{ height: `calc(${prog.pct} * (100% - 1.5rem) / 100)` }} />
              <div className="space-y-2">
                {chapters.map((c, i) => {
                  const unlocked = i === 0 || chapters[i - 1].status === "done" || c.status === "done";
                  const doneCh = c.status === "done";
                  return (
                    <div key={c.id} className="relative">
                      <span className={`absolute -left-[1.55rem] top-3.5 w-6 h-6 rounded-full grid place-items-center text-xs font-bold z-10 border-2 border-[var(--background)] ${doneCh ? "bg-[var(--neon)] text-black" : unlocked ? "bg-white/15" : "bg-white/[0.06] opacity-60"}`}>
                        {doneCh ? "✓" : unlocked ? i + 1 : "🔒"}
                      </span>
                      <button disabled={!unlocked} onClick={() => unlocked && setRunCh(c)} className="w-full text-left disabled:opacity-40">
                        <Card tone="paper" padded={false} className={`p-3.5 ${doneCh ? "opacity-75" : ""}`}>
                          <div className="flex items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold text-sm truncate">{c.title}</p>
                              {c.objective && <p className="text-[11px] opacity-55 truncate">{c.objective}</p>}
                            </div>
                            {doneCh && c.best_score > 0 && <span className="text-[10px] opacity-55 shrink-0">{c.best_score}%</span>}
                          </div>
                        </Card>
                      </button>
                    </div>
                  );
                })}
              </div>
              {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
            </div>
          )}
        </div>
      )}

      {runCh && (
        <Run uid={uid} notebookId={notebook.id} chapter={runCh}
          onClose={() => { setRunCh(null); load(); }} onCleared={load} />
      )}
      {podcast && <Podcast uid={uid} notebookId={notebook.id} onClose={() => setPodcast(false)} />}
      {exam && <MajorTest uid={uid} notebookId={notebook.id} onClose={() => setExam(false)} />}
    </div>
  );
}
