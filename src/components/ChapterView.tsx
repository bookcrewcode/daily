"use client";

// 📖 A chapter — leveled learning that follows Ben's rules, but now it teaches
// PROPERLY instead of flashing three sentences. Each chunk is a real passage
// (editorial serif, an example/analogy), and you can STEER it — "explain more",
// "give an example", "simpler", or ask anything — so it adapts to you instead
// of marching through a slideshow. Then instant checks while you read, and a
// free-recall quiz that clears the chapter at ≥70% and feeds spaced repetition.

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { advisorCall, type NBChapter, type ChapterPack, type GradeResult } from "@/lib/notebook";
import { sfx, buzz } from "@/lib/fx";
import { Card, Prose } from "./ui";
import ChapterClip from "./ChapterClip";
import ClipFeed from "./ClipFeed";

type Phase = "intro" | "read" | "quiz" | "result";
const STEERS = [
  { ask: "Explain this in more depth.", label: "🔍 Explain more" },
  { ask: "Give me a concrete example of this.", label: "💡 Example" },
  { ask: "Explain this more simply, like I'm new to it.", label: "🐣 Simpler" },
];

export default function ChapterView({ uid, notebookId, chapter, onBack, onChanged }: {
  uid: string; notebookId: string; chapter: NBChapter; onBack: () => void; onChanged: () => void;
}) {
  const [pack, setPack] = useState<ChapterPack | null>(chapter.pack);
  const [phase, setPhase] = useState<Phase>("intro");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);

  // steering (coach) — tagged with the chunk it was asked on, so a slow reply
  // can't land on a chunk you've already moved past
  const [coach, setCoach] = useState<{ step: number; q: string; a: string }[]>([]);
  const [feedOpen, setFeedOpen] = useState(false);
  const [coachBusy, setCoachBusy] = useState("");
  const [ask, setAsk] = useState("");

  const [answers, setAnswers] = useState<string[]>([]);
  const [results, setResults] = useState<GradeResult[] | null>(null);
  const [score, setScore] = useState(0);

  const chunks = pack?.chunks ?? [];
  const recall = pack?.recall ?? [];

  function logRetrieval(question: string, got_it: boolean) {
    supabase.from("notebook_retrieval").insert({ user_id: uid, notebook_id: notebookId, chapter_id: chapter.id, question: question.slice(0, 400), got_it }).then(() => {}, () => {});
  }

  async function startLearning() {
    setErr("");
    if (pack?.chunks?.length) { setPhase("read"); setStep(0); setPicked(null); setCoach([]); return; }
    if (busy) return;
    setBusy(true);
    try {
      const json = await advisorCall<{ chunks?: ChapterPack["chunks"]; recall?: ChapterPack["recall"]; error?: string }>({
        advisor: "chapter-pack", topicId: notebookId, chapterTitle: chapter.title, chapterObjective: chapter.objective,
      });
      if (json.error || !json.chunks?.length) { setErr(json.error || "Couldn't build this chapter — make sure the notebook has sources, then try again."); return; }
      const built: ChapterPack = { chunks: json.chunks, recall: json.recall ?? [] };
      const { error } = await supabase.from("notebook_chapters").update({ pack: built }).eq("id", chapter.id);
      if (error) { setErr("Built the chapter but couldn't save it — try again."); return; }
      setPack(built); setPhase("read"); setStep(0); setPicked(null); setCoach([]);
    } catch {
      setErr("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function askCoach(a: string, label: string) {
    if (coachBusy) return;
    const atStep = step;
    setCoachBusy(label);
    // advisorCall never throws (it wraps fetch) — it resolves to {text} or {error}
    const json = await advisorCall<{ text?: string; error?: string }>({ advisor: "coach", topicId: notebookId, ask: a, context: chunks[atStep]?.teach ?? "" });
    setCoach((c) => [...c, { step: atStep, q: label, a: json.text || json.error || "No response." }]);
    setCoachBusy("");
  }

  function answerCheck(choiceIdx: number) {
    if (picked !== null) return;
    const check = chunks[step]?.check;
    if (!check) return;
    setPicked(choiceIdx);
    const right = choiceIdx === check.answer;
    if (right) sfx.pop(); else buzz(20);
    logRetrieval(check.q, right);
  }

  function nextChunk() {
    setCoach([]); setAsk("");
    if (step + 1 < chunks.length) { setStep(step + 1); setPicked(null); }
    else { setPhase("quiz"); setAnswers(new Array(recall.length).fill("")); setResults(null); }
  }

  async function completeNoQuiz() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const { error } = await supabase.from("notebook_chapters").update({ status: "done", best_score: Math.max(chapter.best_score || 0, 100) }).eq("id", chapter.id);
      if (error) { setErr("Couldn't save your progress — try again."); return; }
      sfx.coin(); buzz(30); onChanged(); onBack();
    } catch { setErr("Couldn't reach the server — try again."); }
    finally { setBusy(false); }
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
      const newBest = Math.max(chapter.best_score || 0, avg);
      const { error } = await supabase.from("notebook_chapters").update(passed ? { status: "done", best_score: newBest } : { best_score: newBest }).eq("id", chapter.id);
      if (error) { setErr("Scored it, but couldn't save your progress — submit again."); return; }
      supabase.from("notebook_quiz_attempts").insert({ user_id: uid, notebook_id: notebookId, chapter_id: chapter.id, scope: "chapter", score: avg, total: res.length, detail: res }).then(() => {}, () => {});
      res.forEach((r, i) => {
        logRetrieval(recall[i].q, r.correct);
        if (!r.correct && r.missed.trim()) supabase.from("notebook_weak_spots").insert({ user_id: uid, notebook_id: notebookId, chapter_id: chapter.id, text: r.missed.slice(0, 300) }).then(() => {}, () => {});
      });
      setResults(res); setScore(avg); setPhase("result");
      if (passed) { sfx.coin(); buzz(30); } else buzz(20);
      onChanged();
    } catch { setErr("Couldn't reach the server — your answers are still here. Try again."); }
    finally { setBusy(false); }
  }

  const cheq = chunks[step]?.check ?? null;

  return (
    <div>
      <button onClick={onBack} className="text-sm opacity-50 mb-2 active:scale-95">← {chapter.title}</button>

      {phase === "intro" && (
        <Card tone="paper">
          <p className="text-[10px] uppercase tracking-widest text-[var(--neon)]/80 mb-1">Chapter {chapter.idx + 1}{chapter.status === "done" ? " · ✓ cleared" : ""}</p>
          <h2 className="font-display text-2xl font-bold leading-tight">{chapter.title}</h2>
          {chapter.objective && <p className="study-prose text-[1rem] mt-2"><b>You&apos;ll be able to:</b> {chapter.objective}</p>}
          {chapter.summary && <p className="study-prose text-[0.98rem] mt-2 opacity-90">{chapter.summary}</p>}
          <button onClick={startLearning} disabled={busy} className="mt-4 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50">
            {busy ? "building your chapter…" : pack?.chunks?.length ? "▶ Start learning" : "✨ Build & start this chapter"}
          </button>
          {pack?.recall?.length ? (
            <button onClick={() => { setPhase("quiz"); setAnswers(new Array(recall.length).fill("")); setResults(null); }} className="mt-2 w-full rounded-xl bg-white/10 py-2.5 text-sm font-semibold active:scale-95">Skip to the quiz</button>
          ) : null}
          {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
        </Card>
      )}

      {phase === "read" && chunks.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-[var(--neon)] transition-all" style={{ width: `${((step + 1) / chunks.length) * 100}%` }} />
            </div>
            <span className="text-[10px] opacity-40">{step + 1}/{chunks.length}</span>
          </div>

          <Card tone="paper" key={step} className="rise-in">
            <Prose text={chunks[step].teach} />
            {/* The citation — the reason to trust the sentence above. It's a
                verbatim quote from HIS source, so he can check the teaching
                against the material instead of taking the AI's word for it. */}
            {chunks[step].cite ? (
              <details className="mt-3 group">
                <summary className="mono text-[10px] text-[var(--text-4)] cursor-pointer list-none active:scale-[0.99]">
                  ▸ from {chunks[step].cite_source || "your sources"}
                </summary>
                <blockquote className="mt-2 border-l-2 border-[var(--neon)]/40 pl-3 text-[13px] italic text-[var(--text-2)] leading-relaxed">
                  &ldquo;{chunks[step].cite}&rdquo;
                </blockquote>
              </details>
            ) : null}
          </Card>

          {/* The clip for THIS beat — it follows the reading rather than living
              in a section of its own, and is keyed by (chapter, beat) so
              stepping through the chapter steps through the clips. */}
          <ChapterClip uid={uid} notebookId={notebookId} chapterId={chapter.id}
            beat={step} concept={chunks[step].teach.slice(0, 300)}
            onOpenFeed={() => setFeedOpen(true)} />

          {/* steer the teaching */}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {STEERS.map((s) => (
              <button key={s.label} onClick={() => askCoach(s.ask, s.label)} disabled={!!coachBusy}
                className="text-xs rounded-full bg-white/5 border border-white/10 px-3 py-1.5 active:scale-95 disabled:opacity-40">
                {coachBusy === s.label ? "…" : s.label}
              </button>
            ))}
          </div>
          {coach.filter((c) => c.step === step).map((c, i) => (
            <Card key={i} tone="neon" className="mt-2 rise-in">
              <p className="text-[10px] uppercase tracking-widest text-[var(--neon)]/70 mb-1">{c.q}</p>
              <Prose text={c.a} className="text-[1rem]" />
            </Card>
          ))}
          <div className="flex gap-2 mt-2">
            <input value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && ask.trim()) { askCoach(ask.trim(), `❓ ${ask.trim()}`); setAsk(""); } }}
              placeholder="ask anything about this…" className="flex-1 min-w-0 rounded-lg bg-black/30 px-3 py-2 outline-none text-sm" />
            <button onClick={() => { if (ask.trim()) { askCoach(ask.trim(), `❓ ${ask.trim()}`); setAsk(""); } }} disabled={!!coachBusy || !ask.trim()}
              className="px-3 rounded-lg bg-white/10 text-sm active:scale-95 disabled:opacity-40">↑</button>
          </div>

          {/* instant check */}
          {cheq ? (
            <Card className="mt-3">
              <p className="text-[10px] uppercase tracking-widest text-[var(--neon)]/80 mb-2">⚡ Quick check</p>
              <p className="text-sm font-medium mb-2">{cheq.q}</p>
              <div className="space-y-1.5">
                {cheq.choices.map((c, i) => {
                  const show = picked !== null;
                  const isAnswer = i === cheq.answer, isPicked = picked === i;
                  return (
                    <button key={i} onClick={() => answerCheck(i)} disabled={picked !== null}
                      className={`w-full text-left rounded-lg px-3 py-2 text-sm transition border ${show && isAnswer ? "bg-green-500/20 border-green-400/50" : show && isPicked ? "bg-red-500/20 border-red-400/50" : "bg-white/[0.03] border-white/10 active:scale-[0.99]"}`}>
                      {show && isAnswer ? "✓ " : show && isPicked ? "✗ " : ""}{c}
                    </button>
                  );
                })}
              </div>
              {picked !== null && cheq.explain && <p className="study-prose text-[0.95rem] mt-2 opacity-90">{cheq.explain}</p>}
              {picked !== null && (
                <button onClick={nextChunk} className="mt-3 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">{step + 1 < chunks.length ? "Next →" : "To the quiz →"}</button>
              )}
            </Card>
          ) : (
            <button onClick={nextChunk} className="mt-3 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">{step + 1 < chunks.length ? "Next →" : "To the quiz →"}</button>
          )}
        </div>
      )}

      {phase === "quiz" && (
        <Card>
          <p className="text-[10px] uppercase tracking-widest opacity-50 mb-1">📝 Recall quiz — no peeking</p>
          <p className="text-[11px] opacity-40 mb-3">Answer from memory. Graded on substance, not wording. 70%+ clears the chapter.</p>
          {recall.length === 0 ? (
            <div>
              <p className="text-sm opacity-60 mb-3">No recall questions came back for this chapter. Read it through, then mark it complete.</p>
              <button onClick={completeNoQuiz} disabled={busy} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50">{busy ? "saving…" : "Mark chapter complete"}</button>
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
              <button onClick={submitQuiz} disabled={busy} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50">{busy ? "grading…" : "Submit for grading"}</button>
            </div>
          )}
          {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
        </Card>
      )}

      {phase === "result" && results && (
        <div>
          <Card tone={score >= 70 ? "neon" : "default"} className="text-center">
            <div className="text-4xl mb-1">{score >= 70 ? "🎉" : "💪"}</div>
            <p className="font-display text-3xl font-black">{score}%</p>
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
            {score < 70 && <button onClick={() => { setStep(0); setPicked(null); setCoach([]); setPhase("read"); }} className="flex-1 rounded-xl bg-white/10 py-2.5 text-sm font-semibold active:scale-95">Re-read</button>}
            <button onClick={() => { setPhase("quiz"); setResults(null); setAnswers(new Array(recall.length).fill("")); }} className="flex-1 rounded-xl bg-white/10 py-2.5 text-sm font-semibold active:scale-95">Retry quiz</button>
            <button onClick={onBack} className="flex-1 rounded-xl bg-[var(--neon)] text-black py-2.5 text-sm font-bold active:scale-95">Done</button>
          </div>
        </div>
      )}
      {feedOpen && <ClipFeed uid={uid} chapterId={chapter.id} onClose={() => setFeedOpen(false)} />}
    </div>
  );
}
