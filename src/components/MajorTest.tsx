"use client";

// 📝 The major exam — a whole-notebook free-recall test, the "big test alongside
// the podcast" Ben asked for. Fresh questions each sitting (an exam should be),
// AI-graded on substance, feeding weak spots. Portaled to <body>.

import { useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import { advisorCall, type RecallQ, type GradeResult } from "@/lib/notebook";
import { sfx, buzz } from "@/lib/fx";

type Phase = "intro" | "taking" | "result";

export default function MajorTest({ uid, notebookId, onClose, onChanged }: {
  uid: string; notebookId: string; onClose: () => void; onChanged?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [questions, setQuestions] = useState<RecallQ[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [results, setResults] = useState<GradeResult[] | null>(null);
  const [score, setScore] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function start() {
    if (busy) return;
    setBusy(true); setErr("");
    const json = await advisorCall<{ questions?: RecallQ[]; error?: string }>({ advisor: "exam", topicId: notebookId, n: 8 });
    if (json.error || !json.questions?.length) { setBusy(false); setErr(json.error || "Couldn't build the exam — add sources and try again."); return; }
    setQuestions(json.questions);
    setAnswers(new Array(json.questions.length).fill(""));
    setResults(null);
    setBusy(false);
    setPhase("taking");
  }

  async function submit() {
    if (busy) return;
    setBusy(true); setErr("");
    const items = questions.map((q, i) => ({ q: q.q, a: answers[i] ?? "", expected: q.expected }));
    const json = await advisorCall<{ results?: GradeResult[]; error?: string }>({ advisor: "grade", topicId: notebookId, items });
    if (json.error || !json.results?.length) { setBusy(false); setErr(json.error || "Couldn't grade the exam — try again."); return; }
    const res = json.results.slice(0, questions.length);
    const avg = res.length ? Math.round(res.reduce((s, r) => s + r.score, 0) / res.length) : 0;

    // meaningful write: the attempt record. If it fails, bail before logging.
    const { error } = await supabase.from("notebook_quiz_attempts").insert({ user_id: uid, notebook_id: notebookId, chapter_id: null, scope: "exam", score: avg, total: res.length, detail: res });
    if (error) { setBusy(false); setErr("Graded it, but couldn't save the result — submit again."); return; }

    // best-effort: reps + weak spots
    res.forEach((r, i) => {
      supabase.from("notebook_retrieval").insert({ user_id: uid, notebook_id: notebookId, chapter_id: null, question: questions[i].q.slice(0, 400), got_it: r.correct }).then(() => {});
      if (!r.correct && r.missed.trim()) supabase.from("notebook_weak_spots").insert({ user_id: uid, notebook_id: notebookId, chapter_id: null, text: r.missed.slice(0, 300) }).then(() => {});
    });

    setResults(res); setScore(avg); setBusy(false); setPhase("result");
    if (avg >= 70) { sfx.coin(); buzz(30); } else buzz(20);
    onChanged?.();
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end md:items-center md:justify-center" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full md:max-w-lg bg-[var(--background)] rounded-t-3xl md:rounded-3xl border-t md:border border-white/10 p-4 pb-8 md:pb-4 max-h-[90vh] overflow-y-auto" style={{ animation: "fadeSlide 0.2s ease" }}>
        <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-3 md:hidden" />
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs uppercase tracking-widest opacity-60">📝 Major exam</p>
          <button onClick={onClose} className="text-sm opacity-50 active:scale-90">✕</button>
        </div>

        {phase === "intro" && (
          <div className="text-center py-6">
            <div className="text-4xl mb-2">🎓</div>
            <p className="text-sm opacity-70 mb-4">A free-recall test across the whole notebook — the real check on whether it stuck. Fresh questions every time, graded on substance.</p>
            <button onClick={start} disabled={busy} className="rounded-xl bg-[var(--neon)] text-black font-bold px-5 py-2.5 active:scale-95 disabled:opacity-50">
              {busy ? "writing your exam…" : "Start the exam"}
            </button>
          </div>
        )}

        {phase === "taking" && (
          <div className="space-y-3">
            <p className="text-[11px] opacity-40">Answer from memory. {questions.length} questions.</p>
            {questions.map((q, i) => (
              <div key={i}>
                <p className="text-sm font-medium mb-1">{i + 1}. {q.q}</p>
                <textarea value={answers[i] ?? ""} onChange={(e) => setAnswers((a) => { const n = [...a]; n[i] = e.target.value; return n; })} disabled={busy} rows={2}
                  placeholder="your answer…" className="w-full rounded-lg bg-black/30 px-3 py-2 outline-none text-sm resize-none" />
              </div>
            ))}
            <button onClick={submit} disabled={busy} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95 disabled:opacity-50">
              {busy ? "grading…" : "Submit exam"}
            </button>
          </div>
        )}

        {phase === "result" && results && (
          <div>
            <div className="text-center py-3">
              <div className="text-4xl mb-1">{score >= 70 ? "🎉" : "💪"}</div>
              <p className="text-3xl font-extrabold">{score}%</p>
              <p className="text-sm opacity-70 mt-1">{score >= 70 ? "Strong — it's sticking." : "Below 70% — the misses are now weak spots the Tutor will loop back."}</p>
            </div>
            <div className="space-y-2 mt-1">
              {results.map((r, i) => (
                <div key={i} className="rounded-xl bg-white/[0.03] border border-white/10 p-3">
                  <p className="text-sm font-medium">{questions[i]?.q}</p>
                  <p className={`text-xs mt-1 ${r.correct ? "text-green-400" : "text-orange-400"}`}>{r.correct ? "✓" : "✗"} {r.score}% — {r.feedback}</p>
                  {r.missed && <p className="text-xs opacity-50 mt-0.5">Missed: {r.missed}</p>}
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={start} disabled={busy} className="flex-1 rounded-xl bg-white/10 py-2.5 text-sm font-semibold active:scale-95 disabled:opacity-50">Retake (new questions)</button>
              <button onClick={onClose} className="flex-1 rounded-xl bg-[var(--neon)] text-black py-2.5 text-sm font-bold active:scale-95">Done</button>
            </div>
          </div>
        )}
        {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}
      </div>
    </div>,
    document.body,
  );
}
