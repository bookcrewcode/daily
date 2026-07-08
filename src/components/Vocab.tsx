"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr, ADVISOR_FN, SUPABASE_ANON, type VocabWord } from "@/lib/supabase";
import { VOCAB_REVIEW_XP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { xpToast, sfx } from "@/lib/fx";
import { SectionTitle, Card } from "./ui";

export default function Vocab({ uid }: { uid: string }) {
  const game = useGame();
  const [words, setWords] = useState<VocabWord[]>([]);
  const [word, setWord] = useState("");
  const [def, setDef] = useState("");
  const [sentence, setSentence] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [quiz, setQuiz] = useState<VocabWord | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const reviewsToday = useRef<number | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.from("vocab").select("*").eq("user_id", uid).order("added", { ascending: false });
    setWords((data ?? []) as VocabWord[]);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!word.trim()) return;
    const row = { user_id: uid, word: word.trim(), definition: def.trim(), sentence: sentence.trim(), mnemonic: mnemonic.trim(), added: todayStr() };
    const { data } = await supabase.from("vocab").insert(row).select().single();
    if (data) setWords((w) => [data as VocabWord, ...w]);
    const addedToday = words.filter((w) => w.added === todayStr()).length + 1;
    await supabase.from("days").upsert(
      { user_id: uid, day: todayStr(), ws_vocab: true, vocab_count: addedToday },
      { onConflict: "user_id,day" },
    );
    setWord(""); setDef(""); setSentence(""); setMnemonic(""); setExpanded(false);
    game.refresh();
  }
  async function remove(id: string) {
    setWords((w) => w.filter((x) => x.id !== id));
    await supabase.from("vocab").delete().eq("id", id);
  }

  // Spaced-ish repetition: words you missed come back first, then the ones
  // you've seen least. Random tiebreak keeps it from feeling like a fixed loop.
  function startQuiz() {
    if (words.length === 0) return;
    const ranked = [...words].sort((a, b) => {
      const aScore = (a.missed ?? 0) * 3 - (a.seen ?? 0) + Math.random() * 2;
      const bScore = (b.missed ?? 0) * 3 - (b.seen ?? 0) + Math.random() * 2;
      return bScore - aScore;
    });
    const pool = ranked.slice(0, Math.min(5, ranked.length));
    setQuiz(pool[Math.floor(Math.random() * pool.length)]);
    setShowAnswer(false);
  }

  async function answer(gotIt: boolean) {
    if (!quiz) return;
    const patch = { seen: (quiz.seen ?? 0) + 1, missed: (quiz.missed ?? 0) + (gotIt ? 0 : 1) };
    setWords((w) => w.map((x) => (x.id === quiz.id ? { ...x, ...patch } : x)));
    await supabase.from("vocab").update(patch).eq("id", quiz.id);
    // per-day review counter feeds the "⚡ +N today" badge (session-safe via ref)
    if (reviewsToday.current == null) {
      reviewsToday.current = game.days.find((d) => d.day === todayStr())?.vocab_reviews ?? 0;
    }
    reviewsToday.current += 1;
    await supabase.from("days").upsert(
      { user_id: uid, day: todayStr(), vocab_reviews: reviewsToday.current },
      { onConflict: "user_id,day" },
    );
    if (gotIt) sfx.pop();
    xpToast(VOCAB_REVIEW_XP, gotIt ? "recalled" : "reviewed");
    game.refresh();
    startQuiz();
  }

  async function generateWord() {
    if (generating) return;
    setGenerating(true); setGenError("");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(ADVISOR_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ advisor: "vocab-gen", known: words.map((w) => w.word) }),
      });
      const json = await res.json();
      if (json.error) { setGenError(json.error); return; }
      setWord(json.word ?? ""); setDef(json.definition ?? ""); setSentence(json.sentence ?? ""); setMnemonic(json.mnemonic ?? "");
      setExpanded(true);
    } catch {
      setGenError("Couldn't generate a word — check your connection.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">✍️ Vocab</h1>
      <p className="opacity-50 text-sm mt-1">{words.length} word{words.length === 1 ? "" : "s"} banked · your own vocabulary, practiced right here.</p>

      {quiz && (
        <Card tone="neon" className="mt-4">
          <p className="text-xs uppercase tracking-widest text-[var(--neon)]/70 mb-2">Quick quiz</p>
          <p className="text-2xl font-extrabold">{quiz.word}</p>
          {showAnswer ? (
            <>
              <p className="text-sm mt-2">{quiz.definition || "(no definition saved)"}</p>
              {quiz.sentence && <p className="text-sm opacity-60 italic mt-1">&ldquo;{quiz.sentence}&rdquo;</p>}
              <div className="flex gap-2 mt-3">
                <button onClick={() => answer(true)} className="flex-1 rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95">✓ Knew it</button>
                <button onClick={() => answer(false)} className="flex-1 rounded-xl bg-white/10 font-semibold py-2.5 active:scale-95">✗ Missed it</button>
                <button onClick={() => setQuiz(null)} className="px-3 rounded-xl bg-white/5 opacity-60 active:scale-95">Done</button>
              </div>
              {(quiz.seen ?? 0) > 0 && (
                <p className="text-[10px] opacity-40 mt-2">seen {quiz.seen}× · missed {quiz.missed}×</p>
              )}
            </>
          ) : (
            <button onClick={() => setShowAnswer(true)} className="mt-3 w-full rounded-xl bg-white/10 py-2.5 font-semibold active:scale-95">Reveal meaning</button>
          )}
        </Card>
      )}

      {!quiz && (
        <button onClick={startQuiz} disabled={words.length === 0}
          className="mt-4 w-full rounded-xl border border-dashed border-white/20 py-3 opacity-70 active:scale-95 disabled:opacity-30">
          🎲 Quiz me — missed words come back first · +{VOCAB_REVIEW_XP} XP each
        </button>
      )}

      <SectionTitle>Add a word</SectionTitle>
      <button onClick={generateWord} disabled={generating}
        className="w-full rounded-xl border border-dashed border-white/20 py-3 opacity-70 active:scale-95 disabled:opacity-30 mb-2">
        {generating ? "…generating" : "✨ Generate a word for me"}
      </button>
      {genError && <p className="text-xs opacity-50 mb-2">{genError}</p>}
      <div className="space-y-2">
        <input value={word} onChange={(e) => setWord(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="the word"
          className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
        {!expanded ? (
          <button onClick={() => setExpanded(true)} className="text-xs text-[var(--neon)]/70 underline underline-offset-2">+ definition, sentence, mnemonic (optional)</button>
        ) : (
          <>
            <input value={def} onChange={(e) => setDef(e.target.value)} placeholder="what it means"
              className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
            <input value={sentence} onChange={(e) => setSentence(e.target.value)} placeholder="use it in a sentence"
              className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
            <input value={mnemonic} onChange={(e) => setMnemonic(e.target.value)} placeholder="memory trick (optional)"
              className="w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none" />
          </>
        )}
        <button onClick={add} className="w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">Add word · +5 XP</button>
      </div>

      <SectionTitle>Your bank</SectionTitle>
      {words.length === 0 && <p className="opacity-40 text-sm">No words yet — add your first above.</p>}
      <div className="space-y-2">
        {words.map((w) => (
          <Card key={w.id} padded={false} className="p-3">
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <p className="font-bold">{w.word}</p>
                {w.definition && <p className="text-sm opacity-70 mt-0.5">{w.definition}</p>}
                {w.sentence && <p className="text-xs opacity-40 italic mt-1">&ldquo;{w.sentence}&rdquo;</p>}
              </div>
              <button onClick={() => remove(w.id)} className="opacity-40 active:scale-90 px-1">✕</button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
