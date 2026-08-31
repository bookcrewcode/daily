"use client";

// 🎮 THE RUN — learning as a game, not a worksheet.
//
// Short teaching beats with real diagrams, then six ways to actually DO
// something: multiple choice, fill-the-blanks, put-in-order, match pairs, and
// real-life scenarios. Combo meter, live XP, sound, haptics, score screen.
// Everything is tappable — typing on a phone kills momentum.
//
// Every "build it by tapping" interaction tracks INDICES, never label text.
// Tracking by value looks fine until the content repeats a word, and then the
// card silently becomes unsolvable with no way forward — the worst thing this
// app could do to someone who's already frustrated with it.

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import { advisorCall } from "@/lib/notebook";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { sfx, buzz, xpToast } from "@/lib/fx";
import Diagram, { type DiagramSpec } from "./Diagram";
import ChapterVideos from "./ChapterVideos";

type Card =
  | { kind: "teach"; text: string; diagram: DiagramSpec | null }
  | { kind: "mcq" | "scenario"; q: string; situation: string; choices: string[]; answer: number; explain: string }
  | { kind: "blank"; sentence: string; bank: string[]; answer: string[]; explain: string }
  | { kind: "order"; prompt: string; items: string[]; explain: string }
  | { kind: "match"; prompt: string; pairs: [string, string][]; explain: string };

const CHAPTER_XP = 40;
const STUDY_XP = 15;
const PASS = 70;

// deterministic shuffle of INDICES, stable for a given seed
function shuffledIdx(n: number, seed: number): number[] {
  const a = Array.from({ length: n }, (_, k) => k);
  let s = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function Run({ uid, notebookId, chapter, onClose, onCleared }: {
  uid: string; notebookId: string;
  // videos ride along so the run can surface the chapter's explainers inline;
  // optional because older callers pass a chapter row without them
  chapter: { id: string; title: string; objective: string; best_score: number; status: string;
             videos?: import("@/lib/curriculum").ChapterVideo[] };
  onClose: () => void; onCleared: () => void;
}) {
  const game = useGame();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [i, setI] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [answered, setAnswered] = useState(false);
  const [correct, setCorrect] = useState(false);
  const [combo, setCombo] = useState(0);
  const [best, setBest] = useState(0);
  const [right, setRight] = useState(0);
  const [asked, setAsked] = useState(0);
  const [xp, setXp] = useState(0);
  const [done, setDone] = useState(false);
  const [finishing, setFinishing] = useState(false);

  // final, settled results — computed once in finish() so the score screen and
  // the database can never disagree about what happened
  const [result, setResult] = useState<{ pct: number; bankedXp: number; note: string; saveFailed: boolean } | null>(null);

  // per-card working state (all index-based)
  const [pick, setPick] = useState<number | null>(null);
  const [slots, setSlots] = useState<(number | null)[]>([]);   // blank: bank indices, fixed length, holes allowed
  const [seq, setSeq] = useState<number[]>([]);                 // order: item indices
  const [leftSel, setLeftSel] = useState<number | null>(null);  // match: left index
  const [made, setMade] = useState<Record<number, number>>({}); // match: left index → right index
  const scoring = useRef(false);
  const banked = useRef(false);
  // best_score as the DB now knows it — props go stale across repeat runs in
  // one sitting, and comparing against a stale value can DOWNGRADE a good score
  const bestScoreRef = useRef(chapter.best_score || 0);

  const card = cards?.[i];
  const seed = i + 7;

  async function start() {
    if (loading) return;
    setLoading(true); setErr("");
    const json = await advisorCall<{ cards?: Card[]; error?: string }>({
      advisor: "lesson", topicId: notebookId, chapterTitle: chapter.title, chapterObjective: chapter.objective,
    });
    setLoading(false);
    if (json.error || !json.cards?.length) { setErr(json.error || "Couldn't build the run — try again."); return; }
    setCards(json.cards);
    setI(0); setCombo(0); setBest(0); setRight(0); setAsked(0); setXp(0);
    setDone(false); setResult(null);
    resetCard(json.cards[0]);
  }

  function resetCard(c?: Card) {
    setAnswered(false); setCorrect(false);
    setPick(null); setSeq([]); setLeftSel(null); setMade({});
    setSlots(c && c.kind === "blank" ? new Array(c.answer.length).fill(null) : []);
    scoring.current = false;
  }

  function score(ok: boolean) {
    if (scoring.current) return;   // guard: never double-count one card
    scoring.current = true;
    setAnswered(true); setCorrect(ok);
    setAsked((n) => n + 1);
    if (ok) {
      const c = combo + 1;
      setCombo(c); setBest((b) => Math.max(b, c));
      setRight((n) => n + 1);
      setXp((x) => x + 5 + Math.min(10, (c - 1) * 2));
      sfx.pop(); buzz(12);
      if (c === 3 || c === 5 || c === 8) burstConfetti("small");
    } else {
      setCombo(0);
      buzz(25);
    }
  }

  function next() {
    if (!cards) return;
    if (i + 1 < cards.length) { const n = i + 1; setI(n); resetCard(cards[n]); }
    else finish();
  }

  async function finish() {
    // Guard the payout tap hard: it awaits three network calls, so an impatient
    // second tap must never reach a path that sets done without a result — that
    // would blank the screen at the exact moment the score should appear.
    if (banked.current || finishing) return;
    banked.current = true;
    setFinishing(true);
    // ONE source of truth for the score — asked/right have settled because
    // finishing is a separate tap after the last answer
    const pct = asked ? Math.round((right / asked) * 100) : 0;
    const passed = pct >= PASS && asked > 0;
    let bankedXp = 0;
    let note = "";
    let saveFailed = false;

    // 1) progress — the meaningful write. Check {error}; supabase-js resolves it.
    try {
      const patch = passed
        ? { status: "done", best_score: Math.max(bestScoreRef.current, pct) }
        : { best_score: Math.max(bestScoreRef.current, pct) };
      const { error } = await supabase.from("notebook_chapters").update(patch).eq("id", chapter.id);
      if (error) saveFailed = true;
      else bestScoreRef.current = Math.max(bestScoreRef.current, pct);
    } catch { saveFailed = true; }

    // 2) XP — only claim what actually lands. The unique constraint means a
    // chapter pays once ever, so a repeat run honestly earns nothing here.
    if (passed) {
      const amount = CHAPTER_XP + xp;
      try {
        const { error } = await supabase.from("quest_claims")
          .insert({ user_id: uid, day: "2000-01-01", quest_key: `nb_ch_${chapter.id}`, xp: amount });
        if (!error) { bankedXp += amount; xpToast(amount); }
        // 23505 = already claimed (the honest, expected case on a repeat run).
        // Anything else genuinely failed and must not be dressed up as success.
        else if (error.code === "23505") note = "Already earned for this chapter — the reps still count.";
        else note = "Couldn't bank the XP for this one — your progress saved though.";
      } catch {
        note = "Couldn't bank the XP for this one — your progress saved though.";
      }
    }
    // 3) showing up at all: once a day
    try {
      const ok = await game.bankQuestXP("nb_study", STUDY_XP);
      if (ok) bankedXp += STUDY_XP;
    } catch { /* daily rep is best-effort */ }

    game.refresh();
    setResult({ pct, bankedXp, note, saveFailed });
    setDone(true);
    setFinishing(false);
    burstConfetti("big");
    sfx.levelup();
    onCleared();
  }

  // ── checkers (index-based) ──────────────────────────────────────
  function checkBlank(c: Extract<Card, { kind: "blank" }>) {
    score(slots.every((s, k) => s !== null && c.bank[s] === c.answer[k]));
  }
  function checkOrder(c: Extract<Card, { kind: "order" }>) {
    // items arrive in the CORRECT order, so a right answer is seq === [0,1,2,…]
    score(seq.length === c.items.length && seq.every((idx, k) => idx === k));
  }
  function tapMatch(c: Extract<Card, { kind: "match" }>, side: "l" | "r", idx: number) {
    if (answered || scoring.current) return;
    if (side === "l") { setLeftSel(idx); sfx.pop(); return; }
    if (leftSel === null) return;
    const nextMade = { ...made, [leftSel]: idx };
    setMade(nextMade); setLeftSel(null);
    if (Object.keys(nextMade).length === c.pairs.length) {
      score(c.pairs.every((_, li) => nextMade[li] === li));
    } else sfx.pop();
  }

  if (typeof document === "undefined") return null;
  const shown = cards ? Math.min(i + 1, cards.length) : 0;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-[var(--background)] flex flex-col">
      <div className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={onClose} className="text-sm opacity-50 active:scale-90 shrink-0">✕</button>
        <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-[var(--neon)] transition-all duration-300" style={{ width: cards ? `${(shown / cards.length) * 100}%` : "0%" }} />
        </div>
        {combo >= 2 && <span className="text-xs font-bold text-orange-300 shrink-0 flame">🔥{combo}</span>}
        {xp > 0 && <span className="text-xs font-bold text-[var(--neon)] shrink-0 tabular-nums">+{xp}</span>}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {!cards && !done && (
          <div className="h-full grid place-items-center text-center">
            <div>
              <div className="text-5xl mb-3">🎮</div>
              <h2 className="font-display text-2xl font-bold">{chapter.title}</h2>
              {chapter.objective && <p className="study-prose text-[1rem] mt-2 max-w-sm mx-auto">{chapter.objective}</p>}
              <button onClick={start} disabled={loading}
                className="mt-6 rounded-2xl bg-[var(--neon)] text-black font-bold px-8 py-3.5 text-lg active:scale-95 disabled:opacity-50">
                {loading ? "building your run…" : "Start the run →"}
              </button>
              <p className="text-[11px] opacity-40 mt-3">12–18 cards · tap, don&apos;t type · combo pays extra XP</p>
              {err && <p className="text-xs text-orange-400 mt-3 max-w-xs mx-auto">{err}</p>}
            </div>
          </div>
        )}

        {cards && !done && card && (
          <div key={i} className="rise-in pt-2">
            {card.kind === "teach" && (
              <div>
                <p className="study-prose text-[1.06rem]">{card.text}</p>
                {card.diagram && <Diagram spec={card.diagram} />}
                {/* The chapter's videos, collapsed — if a card doesn't land,
                    the explainer for it is one tap away. */}
                <ChapterVideos videos={chapter.videos ?? []} compact />
              </div>
            )}

            {(card.kind === "mcq" || card.kind === "scenario") && (
              <div>
                {card.kind === "scenario" && card.situation && (
                  <div className="rounded-2xl paper border p-3 mb-3">
                    <p className="text-[10px] uppercase tracking-widest opacity-45 mb-1">Situation</p>
                    <p className="study-prose text-[1rem]">{card.situation}</p>
                  </div>
                )}
                <p className="font-semibold text-[1.05rem] mb-3">{card.q || "What do you do?"}</p>
                <div className="space-y-2">
                  {card.choices.map((ch, k) => {
                    const show = answered, isA = k === card.answer, isP = pick === k;
                    return (
                      <button key={k} disabled={answered}
                        onClick={() => { if (scoring.current) return; setPick(k); score(k === card.answer); }}
                        className={`w-full text-left rounded-xl px-4 py-3 border transition ${
                          show && isA ? "bg-green-500/20 border-green-400/60"
                          : show && isP ? "bg-red-500/20 border-red-400/60"
                          : "bg-white/[0.04] border-white/12 active:scale-[0.99]"}`}>
                        <span className="text-[0.98rem]">{show && isA ? "✓ " : show && isP ? "✗ " : ""}{ch}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {card.kind === "blank" && (() => {
              const parts = card.sentence.split("___");
              const order = shuffledIdx(card.bank.length, seed);
              const nextHole = slots.findIndex((s) => s === null);
              return (
                <div>
                  <p className="text-[10px] uppercase tracking-widest opacity-45 mb-2">Fill the blanks</p>
                  <p className="study-prose text-[1.08rem] leading-loose">
                    {parts.map((segment, k) => (
                      <span key={k}>
                        {segment}
                        {k < parts.length - 1 && (() => {
                          const s = slots[k];
                          const ok = answered && s !== null && card.bank[s] === card.answer[k];
                          return (
                            // clearing a blank empties THAT blank — it never shifts
                            // the other answers around underneath the user
                            <button disabled={answered} onClick={() => setSlots((cur) => cur.map((v, z) => (z === k ? null : v)))}
                              className={`inline-block min-w-[5rem] mx-1 px-2 py-0.5 rounded-lg border-b-2 text-center align-baseline ${
                                answered ? (ok ? "border-green-400 text-green-300" : "border-red-400 text-red-300")
                                : s !== null ? "border-[var(--neon)] text-[var(--neon)]"
                                : k === nextHole ? "border-[var(--neon)]/60 opacity-70" : "border-white/25 opacity-40"}`}>
                              {s !== null ? card.bank[s] : "____"}
                            </button>
                          );
                        })()}
                      </span>
                    ))}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-4">
                    {order.map((bi) => {
                      const used = slots.includes(bi);
                      return (
                        <button key={bi} disabled={answered || used || nextHole === -1}
                          onClick={() => setSlots((cur) => { const n = [...cur]; const h = n.findIndex((v) => v === null); if (h >= 0) n[h] = bi; return n; })}
                          className={`px-3 py-2 rounded-xl border text-sm ${used ? "opacity-25 border-white/10" : "bg-white/[0.06] border-white/15 active:scale-95"}`}>
                          {card.bank[bi]}
                        </button>
                      );
                    })}
                  </div>
                  {!answered && nextHole === -1 && (
                    <button onClick={() => checkBlank(card)} className="mt-4 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">Check</button>
                  )}
                </div>
              );
            })()}

            {card.kind === "order" && (() => {
              const pool = shuffledIdx(card.items.length, seed).filter((idx) => !seq.includes(idx));
              return (
                <div>
                  <p className="text-[10px] uppercase tracking-widest opacity-45 mb-1">Put it in order</p>
                  <p className="font-semibold text-[1.02rem] mb-3">{card.prompt}</p>
                  <div className="space-y-1.5 mb-3">
                    {seq.map((idx, k) => (
                      <button key={`${idx}-${k}`} disabled={answered} onClick={() => setSeq((q) => q.filter((x) => x !== idx))}
                        className={`w-full text-left rounded-xl px-3 py-2.5 border flex items-center gap-2 ${
                          answered ? (idx === k ? "bg-green-500/15 border-green-400/50" : "bg-red-500/15 border-red-400/50") : "bg-[var(--neon)]/10 border-[var(--neon)]/35"}`}>
                        <span className="text-xs opacity-50 w-4">{k + 1}</span><span className="text-sm">{card.items[idx]}</span>
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {pool.map((idx) => (
                      <button key={idx} disabled={answered} onClick={() => setSeq((q) => [...q, idx])}
                        className="px-3 py-2 rounded-xl bg-white/[0.06] border border-white/15 text-sm active:scale-95">{card.items[idx]}</button>
                    ))}
                  </div>
                  {!answered && seq.length === card.items.length && (
                    <button onClick={() => checkOrder(card)} className="mt-4 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">Check</button>
                  )}
                </div>
              );
            })()}

            {card.kind === "match" && (() => {
              const rightOrder = shuffledIdx(card.pairs.length, seed);
              const usedRights = new Set(Object.values(made));
              return (
                <div>
                  <p className="text-[10px] uppercase tracking-widest opacity-45 mb-1">Match them up</p>
                  <p className="font-semibold text-[1.02rem] mb-3">{card.prompt}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      {card.pairs.map(([l], li) => {
                        const paired = made[li] !== undefined;
                        const ok = answered && made[li] === li;
                        return (
                          <button key={li} disabled={answered || paired} onClick={() => tapMatch(card, "l", li)}
                            className={`w-full rounded-xl px-3 py-2.5 border text-sm text-left ${
                              answered ? (ok ? "bg-green-500/15 border-green-400/50" : "bg-red-500/15 border-red-400/50")
                              : leftSel === li ? "bg-[var(--neon)] text-black border-transparent"
                              : paired ? "opacity-40 border-white/10" : "bg-white/[0.06] border-white/15 active:scale-95"}`}>
                            {l}{paired && <span className="opacity-60"> → {card.pairs[made[li]][1]}</span>}
                          </button>
                        );
                      })}
                    </div>
                    <div className="space-y-2">
                      {rightOrder.map((ri) => (
                        <button key={ri} disabled={answered || usedRights.has(ri) || leftSel === null} onClick={() => tapMatch(card, "r", ri)}
                          className={`w-full rounded-xl px-3 py-2.5 border text-sm text-left ${usedRights.has(ri) ? "opacity-25 border-white/10" : "bg-white/[0.06] border-white/15 active:scale-95"}`}>
                          {card.pairs[ri][1]}
                        </button>
                      ))}
                    </div>
                  </div>
                  {!answered && <p className="text-[11px] opacity-40 mt-3 text-center">tap one on the left, then its partner on the right</p>}
                </div>
              );
            })()}

            {answered && "explain" in card && card.explain && (
              <div className={`mt-4 rounded-xl px-3 py-2.5 border ${correct ? "bg-green-500/10 border-green-400/30" : "bg-orange-500/10 border-orange-400/30"}`}>
                <p className="text-sm">{correct ? "✓ " : "→ "}{card.explain}</p>
              </div>
            )}
          </div>
        )}

        {done && result && (
          <div className="h-full grid place-items-center text-center">
            <div>
              <div className="text-6xl mb-2">{result.pct >= PASS ? "🏆" : "💪"}</div>
              <p className="font-display text-5xl font-black">{result.pct}%</p>
              <p className="text-sm opacity-70 mt-1">{right} of {asked} right{best >= 3 ? ` · best combo 🔥${best}` : ""}</p>
              {result.bankedXp > 0 && (
                <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-[var(--neon)]/15 border border-[var(--neon)]/40 px-4 py-2">
                  <span className="text-[var(--neon)] font-bold">+{result.bankedXp} XP</span>
                </div>
              )}
              {result.note && <p className="text-xs opacity-50 mt-3">{result.note}</p>}
              {result.saveFailed && <p className="text-xs text-orange-400 mt-3 max-w-xs mx-auto">Couldn&apos;t save your progress — check your connection and run it again.</p>}
              <p className="study-prose text-[1rem] mt-4 max-w-xs mx-auto">
                {result.pct >= PASS ? "Chapter cleared. That's a rep for the person who finishes what he starts." : "Not cleared yet — run it again. The misses are where the learning actually is."}
              </p>
              <div className="flex gap-2 mt-6 justify-center">
                <button onClick={() => { banked.current = false; setFinishing(false); setCards(null); setDone(false); setResult(null); start(); }}
                  className="rounded-xl bg-white/10 px-5 py-3 text-sm font-semibold active:scale-95">Run it again</button>
                <button onClick={onClose} className="rounded-xl bg-[var(--neon)] text-black px-5 py-3 text-sm font-bold active:scale-95">Done</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {cards && !done && card && (card.kind === "teach" || answered) && (
        <div className="px-4 pb-6 pt-2">
          <button onClick={next} disabled={finishing}
            className="w-full rounded-2xl bg-[var(--neon)] text-black font-bold py-3.5 text-[1.05rem] active:scale-95 disabled:opacity-60">
            {finishing ? "saving your run…" : i + 1 < cards.length ? "Continue →" : "Finish 🏁"}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
