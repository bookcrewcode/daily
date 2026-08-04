"use client";

// 🎮 THE RUN — learning as a game, not a worksheet.
//
// The old chapter flow was stale: a paragraph, one multiple choice, repeat.
// A run is 12-18 cards that never sit still — short teaching beats with real
// diagrams, then six different ways to actually DO something: multiple choice,
// fill the blanks, put things in order, match pairs, and real-life scenarios.
// A combo meter builds as you get things right, XP ticks up live, and the whole
// thing ends in a score screen with confetti. Everything is tappable — no typing
// mid-run, because typing on a phone kills momentum.

import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { supabase, todayStr } from "@/lib/supabase";
import { advisorCall } from "@/lib/notebook";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { sfx, buzz, xpToast } from "@/lib/fx";
import Diagram, { type DiagramSpec } from "./Diagram";

type Card =
  | { kind: "teach"; text: string; diagram: DiagramSpec | null }
  | { kind: "mcq" | "scenario"; q: string; situation: string; choices: string[]; answer: number; explain: string }
  | { kind: "blank"; sentence: string; bank: string[]; answer: string[]; explain: string }
  | { kind: "order"; prompt: string; items: string[]; explain: string }
  | { kind: "match"; prompt: string; pairs: [string, string][]; explain: string };

const CHAPTER_XP = 40;   // one-time, per chapter cleared
const STUDY_XP = 15;     // once a day, for showing up

// deterministic shuffle so a card doesn't re-scramble on every render
function shuffled<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
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
  chapter: { id: string; title: string; objective: string; best_score: number; status: string };
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

  // per-card working state
  const [pick, setPick] = useState<number | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [seq, setSeq] = useState<string[]>([]);
  const [leftSel, setLeftSel] = useState<string | null>(null);
  const [made, setMade] = useState<Record<string, string>>({});
  const banked = useRef(false);

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
    setI(0); setAnswered(false); setCombo(0); setBest(0); setRight(0); setAsked(0); setXp(0); setDone(false);
    resetCard();
  }

  function resetCard() {
    setAnswered(false); setCorrect(false);
    setPick(null); setSlots([]); setSeq([]); setLeftSel(null); setMade({});
  }

  function score(ok: boolean) {
    setAnswered(true); setCorrect(ok);
    setAsked((n) => n + 1);
    if (ok) {
      const c = combo + 1;
      setCombo(c); setBest((b) => Math.max(b, c));
      setRight((n) => n + 1);
      const gain = 5 + Math.min(10, (c - 1) * 2);   // combo pays, capped
      setXp((x) => x + gain);
      sfx.pop(); buzz(12);
      if (c === 3 || c === 5 || c === 8) burstConfetti("small");
    } else {
      setCombo(0);
      buzz(25);
    }
  }

  function next() {
    if (!cards) return;
    if (i + 1 < cards.length) { setI(i + 1); resetCard(); }
    else finish();
  }

  async function finish() {
    setDone(true);
    burstConfetti("big");
    sfx.levelup();
    if (banked.current) return;
    banked.current = true;
    const pct = asked ? Math.round((right / asked) * 100) : 100;
    // progress first — it's the meaningful write
    try {
      const patch = pct >= 70
        ? { status: "done", best_score: Math.max(chapter.best_score || 0, pct) }
        : { best_score: Math.max(chapter.best_score || 0, pct) };
      await supabase.from("notebook_chapters").update(patch).eq("id", chapter.id);
    } catch { /* the score screen still shows; progress retries next run */ }
    // XP: one-time per chapter (stable sentinel day so a retry can't double-pay)
    if (pct >= 70) {
      const { error } = await supabase.from("quest_claims")
        .insert({ user_id: uid, day: "2000-01-01", quest_key: `nb_ch_${chapter.id}`, xp: CHAPTER_XP });
      if (!error) { xpToast(CHAPTER_XP); game.refresh(); }
    }
    // showing up at all earns the daily study rep (unique constraint = once/day)
    await game.bankQuestXP("nb_study", STUDY_XP).catch(() => false);
    onCleared();
  }

  // ── card checkers ───────────────────────────────────────────────
  function checkBlank(c: Extract<Card, { kind: "blank" }>) {
    const ok = c.answer.length === slots.length && c.answer.every((a, k) => (slots[k] ?? "").toLowerCase() === a.toLowerCase());
    score(ok);
  }
  function checkOrder(c: Extract<Card, { kind: "order" }>) {
    score(seq.length === c.items.length && seq.every((s, k) => s === c.items[k]));
  }
  function tapMatch(c: Extract<Card, { kind: "match" }>, side: "l" | "r", val: string) {
    if (answered) return;
    if (side === "l") { setLeftSel(val); return; }
    if (!leftSel) return;
    const nextMade = { ...made, [leftSel]: val };
    setMade(nextMade); setLeftSel(null);
    if (Object.keys(nextMade).length === c.pairs.length) {
      score(c.pairs.every(([l, r]) => nextMade[l] === r));
    } else { sfx.pop(); }
  }

  const pct = asked ? Math.round((right / asked) * 100) : 0;
  const bodyIdx = useMemo(() => (cards ? Math.min(i + 1, cards.length) : 0), [i, cards]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-[var(--background)] flex flex-col">
      {/* header */}
      <div className="px-4 pt-4 pb-2 flex items-center gap-3">
        <button onClick={onClose} className="text-sm opacity-50 active:scale-90 shrink-0">✕</button>
        <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-[var(--neon)] transition-all duration-300" style={{ width: cards ? `${(bodyIdx / cards.length) * 100}%` : "0%" }} />
        </div>
        {combo >= 2 && <span className="text-xs font-bold text-orange-300 shrink-0 flame">🔥{combo}</span>}
        {xp > 0 && <span className="text-xs font-bold text-[var(--neon)] shrink-0 tabular-nums">+{xp}</span>}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {/* start screen */}
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

        {/* the run */}
        {cards && !done && card && (
          <div key={i} className="rise-in pt-2">
            {card.kind === "teach" && (
              <div>
                <p className="study-prose text-[1.06rem]">{card.text}</p>
                {card.diagram && <Diagram spec={card.diagram} />}
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
                    const show = answered;
                    const isA = k === card.answer, isP = pick === k;
                    return (
                      <button key={k} disabled={answered}
                        onClick={() => { setPick(k); score(k === card.answer); }}
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
              const bank = shuffled(card.bank, seed);
              return (
                <div>
                  <p className="text-[10px] uppercase tracking-widest opacity-45 mb-2">Fill the blanks</p>
                  <p className="study-prose text-[1.08rem] leading-loose">
                    {parts.map((seg, k) => (
                      <span key={k}>
                        {seg}
                        {k < parts.length - 1 && (
                          <button disabled={answered} onClick={() => setSlots((s) => s.filter((_, z) => z !== k))}
                            className={`inline-block min-w-[5rem] mx-1 px-2 py-0.5 rounded-lg border-b-2 text-center align-baseline ${
                              answered
                                ? (slots[k] ?? "").toLowerCase() === (card.answer[k] ?? "").toLowerCase() ? "border-green-400 text-green-300" : "border-red-400 text-red-300"
                                : slots[k] ? "border-[var(--neon)] text-[var(--neon)]" : "border-white/25 opacity-40"}`}>
                            {slots[k] ?? "____"}
                          </button>
                        )}
                      </span>
                    ))}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-4">
                    {bank.map((w) => {
                      const used = slots.includes(w);
                      return (
                        <button key={w} disabled={answered || used || slots.length >= card.answer.length}
                          onClick={() => setSlots((s) => [...s, w])}
                          className={`px-3 py-2 rounded-xl border text-sm ${used ? "opacity-25 border-white/10" : "bg-white/[0.06] border-white/15 active:scale-95"}`}>
                          {w}
                        </button>
                      );
                    })}
                  </div>
                  {!answered && slots.length === card.answer.length && (
                    <button onClick={() => checkBlank(card)} className="mt-4 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">Check</button>
                  )}
                </div>
              );
            })()}

            {card.kind === "order" && (() => {
              const pool = shuffled(card.items, seed).filter((x) => !seq.includes(x));
              return (
                <div>
                  <p className="text-[10px] uppercase tracking-widest opacity-45 mb-1">Put it in order</p>
                  <p className="font-semibold text-[1.02rem] mb-3">{card.prompt}</p>
                  <div className="space-y-1.5 mb-3">
                    {seq.map((s, k) => (
                      <button key={s} disabled={answered} onClick={() => setSeq((q) => q.filter((x) => x !== s))}
                        className={`w-full text-left rounded-xl px-3 py-2.5 border flex items-center gap-2 ${
                          answered ? (card.items[k] === s ? "bg-green-500/15 border-green-400/50" : "bg-red-500/15 border-red-400/50") : "bg-[var(--neon)]/10 border-[var(--neon)]/35"}`}>
                        <span className="text-xs opacity-50 w-4">{k + 1}</span><span className="text-sm">{s}</span>
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {pool.map((x) => (
                      <button key={x} disabled={answered} onClick={() => setSeq((q) => [...q, x])}
                        className="px-3 py-2 rounded-xl bg-white/[0.06] border border-white/15 text-sm active:scale-95">{x}</button>
                    ))}
                  </div>
                  {!answered && seq.length === card.items.length && (
                    <button onClick={() => checkOrder(card)} className="mt-4 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95">Check</button>
                  )}
                </div>
              );
            })()}

            {card.kind === "match" && (() => {
              const rights = shuffled(card.pairs.map((p) => p[1]), seed);
              return (
                <div>
                  <p className="text-[10px] uppercase tracking-widest opacity-45 mb-1">Match them up</p>
                  <p className="font-semibold text-[1.02rem] mb-3">{card.prompt}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      {card.pairs.map(([l]) => {
                        const done2 = made[l] !== undefined;
                        const ok = answered && made[l] === card.pairs.find((p) => p[0] === l)?.[1];
                        return (
                          <button key={l} disabled={answered || done2} onClick={() => tapMatch(card, "l", l)}
                            className={`w-full rounded-xl px-3 py-2.5 border text-sm text-left ${
                              answered ? (ok ? "bg-green-500/15 border-green-400/50" : "bg-red-500/15 border-red-400/50")
                              : leftSel === l ? "bg-[var(--neon)] text-black border-transparent"
                              : done2 ? "opacity-40 border-white/10" : "bg-white/[0.06] border-white/15 active:scale-95"}`}>
                            {l}{done2 && <span className="opacity-60"> → {made[l]}</span>}
                          </button>
                        );
                      })}
                    </div>
                    <div className="space-y-2">
                      {rights.map((r) => {
                        const used = Object.values(made).includes(r);
                        return (
                          <button key={r} disabled={answered || used || !leftSel} onClick={() => tapMatch(card, "r", r)}
                            className={`w-full rounded-xl px-3 py-2.5 border text-sm text-left ${used ? "opacity-25 border-white/10" : "bg-white/[0.06] border-white/15 active:scale-95"}`}>
                            {r}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {!answered && <p className="text-[11px] opacity-40 mt-3 text-center">tap one on the left, then its partner on the right</p>}
                </div>
              );
            })()}

            {/* feedback + advance */}
            {answered && "explain" in card && card.explain && (
              <div className={`mt-4 rounded-xl px-3 py-2.5 border ${correct ? "bg-green-500/10 border-green-400/30" : "bg-orange-500/10 border-orange-400/30"}`}>
                <p className="text-sm">{correct ? "✓ " : "→ "}{card.explain}</p>
              </div>
            )}
          </div>
        )}

        {/* score screen */}
        {done && (
          <div className="h-full grid place-items-center text-center">
            <div>
              <div className="text-6xl mb-2">{pct >= 70 ? "🏆" : "💪"}</div>
              <p className="font-display text-5xl font-black">{pct}%</p>
              <p className="text-sm opacity-70 mt-1">{right} of {asked} right{best >= 3 ? ` · best combo 🔥${best}` : ""}</p>
              <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-[var(--neon)]/15 border border-[var(--neon)]/40 px-4 py-2">
                <span className="text-[var(--neon)] font-bold">+{xp + (pct >= 70 ? CHAPTER_XP : 0)} XP</span>
              </div>
              <p className="study-prose text-[1rem] mt-4 max-w-xs mx-auto">
                {pct >= 70 ? "Chapter cleared. That's a rep for the person who finishes what he starts." : "Not cleared yet — run it again. The misses are where the learning actually is."}
              </p>
              <div className="flex gap-2 mt-6 justify-center">
                <button onClick={() => { banked.current = false; setCards(null); setDone(false); start(); }}
                  className="rounded-xl bg-white/10 px-5 py-3 text-sm font-semibold active:scale-95">Run it again</button>
                <button onClick={onClose} className="rounded-xl bg-[var(--neon)] text-black px-5 py-3 text-sm font-bold active:scale-95">Done</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* footer action */}
      {cards && !done && card && (card.kind === "teach" || answered) && (
        <div className="px-4 pb-6 pt-2">
          <button onClick={next} className="w-full rounded-2xl bg-[var(--neon)] text-black font-bold py-3.5 text-[1.05rem] active:scale-95">
            {i + 1 < cards.length ? "Continue →" : "Finish 🏁"}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
