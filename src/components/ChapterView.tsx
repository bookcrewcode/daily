"use client";

// 📖 A chapter — the leveled-learning flow that enforces Ben's rules:
// read a short chunk → instant multiple-choice check (constant quizzing WHILE
// learning) → next chunk → then a free-recall quiz, AI-graded, that must clear
// ≥70% to complete the chapter and advance the progress bar. Misses become weak
// spots the Tutor loops back in.

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { advisorCall, type NBChapter, type ChapterPack, type GradeResult } from "@/lib/notebook";
import { sfx, buzz } from "@/lib/fx";
import { Card } from "./ui";

type Phase = "intro" | "read" | "quiz" | "result";

export default function ChapterView({ uid, notebookId, chapter, onBack, onChanged }: {
  uid: string; notebookId: string; chapter: NBChapter; onBack: () => void; onChanged: () => void;
}) {
  const [pack, setPack] = useState<ChapterPack | null>(chapter.pack);
  const [phase, setPhase] = useState<Phase>("intro");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // reading
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);

  // quiz
  const [answers, setAnswers] = useState<string[]>([]);
  const [results, setResults] = useState<GradeResult[] | null>(null);
  const [score, setScore] = useState(0);

  const chunks = pack?.chunks ?? [];
  const recall = pack?.recall ?? [];

  // Log a retrieval rep (best-effort — never blocks the flow).
  function logRetrieval(question: string, got_it: boolean) {
    supabase.from("notebook_retrieval").insert({ user_id: uid, notebook_id: notebookId, chapter_id: chapter.id, question: question.slice(0, 400), got_it }).then(() => {});
  }

  async function startLearning() {
    setErr("");
    if (pack?.chunks?.length) { setPhase("read"); setStep(0); setPicked(null); return; }
    if (busy) return;
    setBusy(true);
    try {
      const json = await advisorCall<{ chunks?: ChapterPack["chunks"]; recall?: ChapterPack["recall"]; error?: string }>({
        advisor: "chapter-pack", topicId: notebookId, chapterTitle: chapter.title, chapterObjective: chapter.objective,
      });
      if (json.error || !json.chunks?.length) { setErr(json.error || "Couldn't build this chapter — make sure the notebook has sources, then try again."); return; }
      const built: ChapterPack = { chunks: json.chunks, recall: json.recall ?? [] };
      // write-first: cache the pack so reopening is instant and offline-safe
      const { error } = await supabase.from("notebook_chapters").update({ pack: built }).eq("id", chapter.id);
      if (error) { setErr("Built the chapter but couldn't save it — try again."); return; }
      setPack(built); setPhase("read"); setStep(0); setPicked(null);
    } catch {
      setErr("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  }

  function answerCheck(choiceIdx: number) {
    if (picked !== null) return;
    const check = chunks[step]?.check;
    if (!check) return;
    setPicked(choiceIdx);
    const right = choiceIdx === check.answer;
    if (right) { sfx.pop(); } else { buzz(20); }
    logRetrieval(check.q, right);
  }

  function nextChunk() {
    if (step + 1 < chunks.length) { setStep(step + 1); setPicked(null); }
    else { setPhase("quiz"); setAnswers(new Array(recall.length).fill("")); setResults(null); }
  }

  // A chapter whose pack came back with no recall questions still needs a way
  // to clear — mark it done directly rather than dead-ending on "no quiz".
  async function completeNoQuiz() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const { error } = await supabase.from("notebook_chapters").update({ status: "done", best_score: Math.max(chapter.best_score || 0, 100) }).eq("id", chapter.id);
      if (error) { setErr("Couldn't save your progress — try again."); return; }
      sfx.coin(); buzz(30); onChanged(); onBack();
    } catch {
      setErr("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitQuiz() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const items = recall.map((r, i) => ({ q: r.q, a: answers[i] ?? "", expected: r.expected }));
      const json = await advisorCall<{ results?: GradeResult[]; error?: string }>({ advisor: "grade", topicId: notebookId, items });
      if (json.error || !json.results?.length) { setErr(json.error || "Couldn't grade that — try again."); return; }
      const res = json.results.slice(0, recall.length);
      const avg = res.length ? Math.round(res.reduce((s, r) => s + r.score, 0) / res.length) : 0;
      const passed = avg >= 70;

      // THE meaningful write: chapter progress. Do it first; if it fails, bail
      // before logging so a retry can't double-log.
      const newBest = Math.max(chapter.best_score || 0, avg);
      const patch = passed ? { status: "done", best_score: newBest } : { best_score: newBest };
      const { error } = await supabase.from("notebook_chapters").update(patch).eq("id", chapter.id);
      if (error) { setErr("Scored it, but couldn't save your progress — submit again."); return; }

      // best-effort logging (attempt, retrieval reps, weak spots from misses)
      supabase.from("notebook_quiz_attempts").insert({ user_id: uid, notebook_id: notebookId, chapter_id: chapter.id, scope: "chapter", score: avg, total: res.length, detail: res }).then(() => {});
      res.forEach((r, i) => {
        logRetrieval(recall[i].q, r.correct);
        if (!r.correct && r.missed.trim()) {
          supabase.from("notebook_weak_spots").insert({ user_id: uid, notebook_id: notebookId, chapter_id: chapter.id, text: r.missed.slice(0, 300) }).then(() => {});
        }
      });

      setResults(res); setScore(avg); setPhase("result");
      if (passed) { sfx.coin(); buzz(30); } else { buzz(20); }
      onChanged();
    } catch {
      setErr("Couldn't reach the server — your answers are still here. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const cheq = chunks[step]?.check ?? null;

  return (
    <div>
      <button onClick={onBack} className="text-sm opacity-50 mb-2 active:scale-95">← {chapter.title}</button>

      {phase === "intro" && (
        <Card tone="neon">
          <p className="text-xs uppercase tracking-widest text-[var(--neon)] mb-1">Chapter {chapter.idx + 1}{chapter.status === "done" ? " · ✓ cleared" : ""}</p>
          <h2 className="text-xl font-bold">{chapter.title}</h2>
          {chapter.objective && <p className="text-sm opacity-70 mt-1"><b>You&apos;ll be able to:</b> {chapter.objective}</p>}
          {chapter.summary && <p className="text-sm opacity-60 mt-2">{chapter.summary}</p>}
          <button onClick={startLearning} disabled={busy}
            className="mt-4 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50">
            {busy ? "building your chapter…" : pack?.chunks?.length ? "▶ Start learning" : "✨ Build & start this chapter"}
          </button>
          {pack?.recall?.length ? (
            <button onClick={() => { setPhase("quiz"); setAnswers(new Array(recall.length).fill("")); setResults(null); }} className="mt-2 w-full rounded-xl bg-white/10 py-2.5 text-sm font-semibold active:scale-95">
              Skip to the quiz
            </button>
          ) : null}
          {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
        </Card>
      )}

      {phase === "read" && chunks.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-[var(--neon)] transition-all" style={{ width: `${((step + 1) / chunks.length) * 100}%` }} />
            </div>
            <span className="text-[10px] opacity-40">{step + 1}/{chunks.length}</span>
          </div>
          <Card>
            <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{chunks[step].teach}</p>
          </Card>

          {cheq ? (
            <Card tone="neon" className="mt-3">
              <p className="text-xs uppercase tracking-widest text-[var(--neon)] mb-2">⚡ Quick check</p>
              <p className="text-sm font-medium mb-2">{cheq.q}</p>
              <div className="space-y-1.5">
                {cheq.choices.map((c, i) => {
                  const isPicked = picked === i;
                  const isAnswer = i === cheq.answer;
                  const show = picked !== null;
                  return (
                    <button key={i} onClick={() => answerCheck(i)} disabled={picked !== null}
                      className={`w-full text-left rounded-lg px-3 py-2 text-sm transition border ${
                        show && isAnswer ? "bg-green-500/20 border-green-400/50"
                        : show && isPicked ? "bg-red-500/20 border-red-400/50"
                        : "bg-white/[0.03] border-white/10 active:scale-[0.99]"}`}>
                      {show && isAnswer ? "✓ " : show && isPicked ? "✗ " : ""}{c}
                    </button>
                  );
                })}
              </div>
              {picked !== null && cheq.explain && <p className="text-xs opacity-60 mt-2">{cheq.explain}</p>}
              {picked !== null && (
                <button onClick={nextChunk} className="mt-3 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">
                  {step + 1 < chunks.length ? "Next →" : "To the quiz →"}
                </button>
              )}
            </Card>
          ) : (
            <button onClick={nextChunk} className="mt-3 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">
              {step + 1 < chunks.length ? "Next →" : "To the quiz →"}
            </button>
          )}
        </div>
      )}

      {phase === "quiz" && (
        <Card>
          <p className="text-xs uppercase tracking-widest opacity-60 mb-1">📝 Recall quiz — no peeking</p>
          <p className="text-[11px] opacity-40 mb-3">Answer from memory. Graded generously on substance, not wording. 70%+ clears the chapter.</p>
          {recall.length === 0 ? (
            <div>
              <p className="text-sm opacity-60 mb-3">No recall questions came back for this chapter. Read it through, then mark it complete.</p>
              <button onClick={completeNoQuiz} disabled={busy} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50">
                {busy ? "saving…" : "Mark chapter complete"}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {recall.map((r, i) => (
                <div key={i}>
                  <p className="text-sm font-medium mb-1">{i + 1}. {r.q}</p>
                  <textarea value={answers[i] ?? ""} onChange={(e) => setAnswers((a) => { const n = [...a]; n[i] = e.target.value; return n; })} disabled={busy} rows={2}
                    placeholder="your answer…" className="w-full rounded-lg bg-black/30 px-3 py-2 outline-none text-sm resize-none" />
                </div>
              ))}
              <button onClick={submitQuiz} disabled={busy} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50">
                {busy ? "grading…" : "Submit for grading"}
              </button>
            </div>
          )}
          {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
        </Card>
      )}

      {phase === "result" && results && (
        <div>
          <Card tone={score >= 70 ? "neon" : undefined} className="text-center">
            <div className="text-4xl mb-1">{score >= 70 ? "🎉" : "💪"}</div>
            <p className="text-3xl font-extrabold">{score}%</p>
            <p className="text-sm opacity-70 mt-1">{score >= 70 ? "Chapter cleared — progress saved." : "Not quite 70% — re-read and run it again. That's the rep."}</p>
          </Card>
          <div className="space-y-2 mt-3">
            {results.map((r, i) => (
              <Card key={i} padded={false} className="p-3">
                <p className="text-sm font-medium">{recall[i]?.q}</p>
                <p className={`text-xs mt-1 ${r.correct ? "text-green-400" : "text-orange-400"}`}>{r.correct ? "✓" : "✗"} {r.score}% — {r.feedback}</p>
                {r.missed && <p className="text-xs opacity-50 mt-0.5">Missed: {r.missed}</p>}
              </Card>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            {score < 70 && <button onClick={() => { setStep(0); setPicked(null); setPhase("read"); }} className="flex-1 rounded-xl bg-white/10 py-2.5 text-sm font-semibold active:scale-95">Re-read</button>}
            <button onClick={() => { setPhase("quiz"); setResults(null); setAnswers(new Array(recall.length).fill("")); }} className="flex-1 rounded-xl bg-white/10 py-2.5 text-sm font-semibold active:scale-95">Retry quiz</button>
            <button onClick={onBack} className="flex-1 rounded-xl bg-[var(--neon)] text-black py-2.5 text-sm font-bold active:scale-95">Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
