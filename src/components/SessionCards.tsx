"use client";

// 🃏 SESSION CARDS — the renderers, lifted out of the old Run.tsx.
//
// Every "build it by tapping" interaction tracks INDICES, never label text.
// Tracking by value looks fine until the content repeats a word, and then the
// card silently becomes unsolvable with no way forward — the worst thing this
// app could do to someone who's already frustrated with it.
//
// Each card owns its working state and reports ONE answer through onAnswer;
// a double-tap guard makes sure it can never report twice. The parent decides
// what to say about the answer (explain, why_wrong, pretest copy).

import { useEffect, useRef, useState } from "react";
import { Rating, type Grade } from "ts-fsrs";
import { intervalPreview, type NBCard } from "@/lib/fsrs";
import { sfx, buzz } from "@/lib/fx";
import {
  shuffledIdx, type BlankCard, type ChoiceCard, type MatchCard, type OrderCard, type TeachCard as TeachSpec, type TeachClip, type WorkedCard as WorkedSpec,
} from "@/lib/session";
import Diagram from "./Diagram";

export type InteractiveCard = ChoiceCard | BlankCard | OrderCard | MatchCard;
export type AnswerDetail = { pick?: number; wrongStep?: number };
export const GUIDE_CHIPS = ["Explain it simpler", "Give me an example", "Why is that the answer?", "Just tell me"] as const;

// A miss is never red: green for the right answer, a warm tint for the pick.
const RIGHT = "bg-green-500/20 border-green-400/60";
const MISSED = "bg-orange-500/15 border-orange-400/50";
const IDLE = "bg-white/[0.04] border-white/12 active:scale-[0.99]";
const SPENT = "opacity-25 border-white/10";
const CHECK_BTN = "mt-4 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-3 active:scale-95";
// Nothing in Learn under 12 px or under 0.7 opacity — small grey text is the
// first thing that stops being read. Eyebrows are sentence-case verb phrases.
const Eyebrow = ({ children }: { children: string }) => <p className="text-[13px] opacity-80 mb-2">{children}</p>;

// The tap feedback keyframes, installed once into <head> the first time a
// choice list mounts — so the Today card's inline question gets them too,
// without a stylesheet edit: a 150 ms pop on the tapped row and a warm amber
// pulse on a miss (never red).
function ensureFxStyles() {
  if (typeof document === "undefined" || document.getElementById("learn-fx")) return;
  const st = document.createElement("style");
  st.id = "learn-fx";
  st.textContent = `@keyframes learnPop{0%{transform:scale(1)}40%{transform:scale(1.04)}100%{transform:scale(1)}}
@keyframes learnMiss{0%{box-shadow:0 0 0 0 rgba(251,146,60,.55)}100%{box-shadow:0 0 0 14px rgba(251,146,60,0)}}
.choice-pop{animation:learnPop .15s ease}
.choice-miss{animation:learnMiss .6s ease-out}`;
  document.head.appendChild(st);
}

// Choices as tappable rows; the answer is compared by ORIGINAL index, and
// `onPick` reports that index. With `seed` the rows come in a stored shuffled
// order (a re-ask gets a fresh one); without it, as written. `answer` and
// `pick` paint the result; `disabled` freezes the list (the Today card while
// the round opens).
export function ChoiceList({ choices, answer, seed, pick = null, onPick, disabled }: {
  choices: string[]; onPick: (k: number) => void; answer?: number; seed?: number; pick?: number | null; disabled?: boolean;
}) {
  useEffect(ensureFxStyles, []);
  const order = seed === undefined ? choices.map((_, k) => k) : shuffledIdx(choices.length, seed);
  const show = pick !== null;
  return (
    <div className="space-y-2">
      {order.map((k) => {
        const isA = answer !== undefined && k === answer, isP = pick === k;
        const fx = isP ? `choice-pop${isA ? "" : " choice-miss"}` : "";
        return (
          <button key={k} disabled={show || disabled} onClick={() => onPick(k)}
            className={`w-full text-left rounded-xl px-4 py-3 border transition ${show && isA ? RIGHT : show && isP ? MISSED : IDLE} ${fx}`}>
            <span className="text-[0.98rem]">{show && isA ? "✓ " : show && isP ? "→ " : ""}{choices[k]}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── "Didn't make sense" — one tap under any card or clip ────────────────────
export function NoSense({ onTap }: { onTap: () => void }) {
  const [noted, setNoted] = useState(false);
  if (noted) return <p className="text-[12px] opacity-70 mt-3">Noted — this gets rewritten next time.</p>;
  return (
    <button onClick={() => { setNoted(true); onTap(); }} className="text-[12px] opacity-70 mt-3 underline underline-offset-2 active:scale-95">
      Didn&apos;t make sense
    </button>
  );
}

// ─── mcq · scenario · blank · order · match ──────────────────────────────────
export function QuestionCard({ card, seed, onAnswer }: {
  card: InteractiveCard; seed: number; onAnswer: (ok: boolean, detail: AnswerDetail) => void;
}) {
  const [answered, setAnswered] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [slots, setSlots] = useState<(number | null)[]>(() => (card.kind === "blank" ? new Array(card.answer.length).fill(null) : [])); // blank: bank indices, holes allowed
  const [seq, setSeq] = useState<number[]>([]);                 // order: item indices
  const [leftSel, setLeftSel] = useState<number | null>(null);  // match: left index
  const [made, setMade] = useState<Record<number, number>>({}); // match: left index → right index
  const scoring = useRef(false);

  function settle(ok: boolean, detail: AnswerDetail = {}) {
    if (scoring.current) return;   // never report one card twice
    scoring.current = true;
    setAnswered(true);
    if (ok) { sfx.pop(); buzz(12); } else { sfx.miss(); buzz(25); }
    onAnswer(ok, detail);
  }

  // (excluding the other kinds narrows to ChoiceCard; matching on its union-typed kind would not)
  if (card.kind !== "blank" && card.kind !== "order" && card.kind !== "match") {
    return (
      <div>
        {card.hook && <p className="text-[12px] text-[var(--neon)] mb-2">{card.hook}</p>}
        {card.kind === "scenario" && card.situation && (
          <div className="rounded-2xl paper border p-3 mb-3">
            <Eyebrow>Picture this</Eyebrow>
            <p className="study-prose text-[1rem]">{card.situation}</p>
          </div>
        )}
        <p className="font-semibold text-[1.05rem] mb-3">{card.q || "What do you do?"}</p>
        <ChoiceList choices={card.choices} answer={card.answer} seed={seed} pick={pick}
          onPick={(k) => { if (scoring.current) return; setPick(k); settle(k === card.answer, { pick: k }); }} />
      </div>
    );
  }

  if (card.kind === "blank") {
    const parts = card.sentence.split("___");
    const order = shuffledIdx(card.bank.length, seed);
    const nextHole = slots.findIndex((s) => s === null);
    return (
      <div>
        <Eyebrow>Fill the blanks — tap a word to drop it into the next gap</Eyebrow>
        <p className="study-prose text-[1.08rem] leading-loose">
          {parts.map((segment, k) => (
            <span key={k}>
              {segment}
              {k < parts.length - 1 && (() => {
                const s = slots[k];
                const ok = answered && s !== null && card.bank[s] === card.answer[k];
                return (
                  // clearing a blank empties THAT blank — it never shifts the others
                  <button disabled={answered} onClick={() => setSlots((cur) => cur.map((v, z) => (z === k ? null : v)))}
                    className={`inline-block min-w-[5rem] mx-1 px-2 py-0.5 rounded-lg border-b-2 text-center align-baseline ${
                      answered ? (ok ? "border-green-400 text-green-300" : "border-orange-400 text-orange-300")
                      : s !== null ? "border-[var(--neon)] text-[var(--neon)]"
                      : k === nextHole ? "border-[var(--neon)]/60 opacity-70" : "border-white/25 opacity-40"}`}>
                    {s !== null ? card.bank[s] : "____"}
                  </button>
                );
              })()}
            </span>
          ))}
        </p>
        {answered && slots.some((s, k) => s === null || card.bank[s] !== card.answer[k]) && (
          <p className="text-sm mt-2 opacity-70">→ {card.answer.join(" · ")}</p>
        )}
        <div className="flex flex-wrap gap-2 mt-4">
          {order.map((bi) => {
            const used = slots.includes(bi);
            return (
              <button key={bi} disabled={answered || used || nextHole === -1}
                onClick={() => setSlots((cur) => { const n = [...cur]; const h = n.findIndex((v) => v === null); if (h >= 0) n[h] = bi; return n; })}
                className={`px-3 py-2 rounded-xl border text-sm ${used ? SPENT : "bg-white/[0.06] border-white/15 active:scale-95"}`}>
                {card.bank[bi]}
              </button>
            );
          })}
        </div>
        {!answered && nextHole === -1 && (
          <button onClick={() => settle(slots.every((s, k) => s !== null && card.bank[s] === card.answer[k]))} className={CHECK_BTN}>Check</button>
        )}
      </div>
    );
  }

  if (card.kind === "order") {
    const pool = shuffledIdx(card.items.length, seed).filter((idx) => !seq.includes(idx));
    return (
      <div>
        <Eyebrow>Put it in order — tap items in sequence, tap again to undo</Eyebrow>
        <p className="font-semibold text-[1.02rem] mb-3">{card.prompt}</p>
        <div className="space-y-1.5 mb-3">
          {seq.map((idx, k) => (
            <button key={`${idx}-${k}`} disabled={answered} onClick={() => setSeq((q) => q.filter((x) => x !== idx))}
              className={`w-full text-left rounded-xl px-3 py-2.5 border flex items-center gap-2 ${
                answered ? (idx === k ? RIGHT : MISSED) : "bg-[var(--neon)]/10 border-[var(--neon)]/35"}`}>
              <span className="text-xs opacity-70 w-4">{k + 1}</span><span className="text-sm">{card.items[idx]}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {pool.map((idx) => (
            <button key={idx} disabled={answered} onClick={() => setSeq((q) => [...q, idx])}
              className="px-3 py-2 rounded-xl bg-white/[0.06] border border-white/15 text-sm active:scale-95">{card.items[idx]}</button>
          ))}
        </div>
        {answered && !seq.every((idx, k) => idx === k) && (
          <p className="text-sm mt-3 opacity-70">→ {card.items.join(" → ")}</p>
        )}
        {!answered && seq.length === card.items.length && (
          // items arrive in the CORRECT order, so a right answer is seq === [0,1,2,…]
          <button onClick={() => settle(seq.every((idx, k) => idx === k))} className={CHECK_BTN}>Check</button>
        )}
      </div>
    );
  }

  // match — `pairs` is a const so the narrowed type survives into the closure
  const { pairs } = card;
  const rightOrder = shuffledIdx(pairs.length, seed);
  const usedRights = new Set(Object.values(made));
  function tapMatch(side: "l" | "r", idx: number) {
    if (answered || scoring.current) return;
    if (side === "l") { setLeftSel(idx); sfx.pop(); return; }
    if (leftSel === null) return;
    const nextMade = { ...made, [leftSel]: idx };
    setMade(nextMade); setLeftSel(null);
    if (Object.keys(nextMade).length === pairs.length) settle(pairs.every((_, li) => nextMade[li] === li));
    else sfx.pop();
  }
  return (
    <div>
      <Eyebrow>Match them up — tap one on the left, then its partner on the right</Eyebrow>
      <p className="font-semibold text-[1.02rem] mb-3">{card.prompt}</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          {card.pairs.map(([l], li) => {
            const paired = made[li] !== undefined;
            const ok = answered && made[li] === li;
            return (
              <button key={li} disabled={answered || paired} onClick={() => tapMatch("l", li)}
                className={`w-full rounded-xl px-3 py-2.5 border text-sm text-left ${
                  answered ? (ok ? RIGHT : MISSED)
                  : leftSel === li ? "bg-[var(--neon)] text-black border-transparent"
                  : paired ? "opacity-40 border-white/10" : "bg-white/[0.06] border-white/15 active:scale-95"}`}>
                {l}{paired && <span className="opacity-70"> → {card.pairs[made[li]][1]}</span>}
              </button>
            );
          })}
        </div>
        <div className="space-y-2">
          {rightOrder.map((ri) => (
            <button key={ri} disabled={answered || usedRights.has(ri) || leftSel === null} onClick={() => tapMatch("r", ri)}
              className={`w-full rounded-xl px-3 py-2.5 border text-sm text-left ${usedRights.has(ri) ? SPENT : "bg-white/[0.06] border-white/15 active:scale-95"}`}>
              {card.pairs[ri][1]}
            </button>
          ))}
        </div>
      </div>
      {answered && !card.pairs.every((_, li) => made[li] === li) && (
        <p className="text-sm mt-3 opacity-70">→ {card.pairs.map(([l, r]) => `${l} — ${r}`).join(" · ")}</p>
      )}
    </div>
  );
}

// ─── worked: a problem solved one step at a time ─────────────────────────────
// Steps reveal in order; the ones carrying `ask` stop and want a tap. The
// answer is "right" only if every asked step was — a slip anywhere counts.
export function WorkedCard({ card, seed, onAnswer }: {
  card: WorkedSpec; seed: number; onAnswer: (ok: boolean, detail: AnswerDetail) => void;
}) {
  const [shown, setShown] = useState(1);
  const [picks, setPicks] = useState<Record<number, number>>({});
  const [finished, setFinished] = useState(false);
  const reported = useRef(false);
  const cur = card.steps[shown - 1];
  const curDone = !cur?.ask || picks[shown - 1] !== undefined;

  function advance() {
    if (shown < card.steps.length) { setShown(shown + 1); sfx.pop(); return; }
    if (reported.current) return;   // never report one card twice
    reported.current = true;
    setFinished(true);
    const wrong = card.steps.findIndex((s, i) => s.ask && picks[i] !== s.ask.answer);
    if (wrong === -1) { sfx.pop(); buzz(12); } else { sfx.miss(); buzz(25); }
    onAnswer(wrong === -1, wrong === -1 ? {} : { wrongStep: wrong });
  }

  return (
    <div>
      <Eyebrow>Work it one step at a time</Eyebrow>
      <div className="rounded-2xl paper border p-3 mb-3">
        <p className="study-prose text-[1rem]">{card.problem}</p>
      </div>
      <div className="space-y-3">
        {card.steps.slice(0, shown).map((s, i) => (
          <div key={i} className="rise-in">
            <p className="text-sm"><span className="mono text-[12px] opacity-70 mr-2">step {i + 1}</span>{s.text}</p>
            {s.ask && (
              <div className="mt-2 pl-2 border-l-2 border-[var(--neon)]/40">
                <p className="text-[0.98rem] font-semibold mb-2">{s.ask.q}</p>
                <ChoiceList choices={s.ask.choices} answer={s.ask.answer} seed={seed + i * 31} pick={picks[i] ?? null}
                  onPick={(k) => { if (picks[i] !== undefined) return; setPicks((p) => ({ ...p, [i]: k })); if (k === s.ask?.answer) sfx.pop(); else { sfx.miss(); buzz(25); } }} />
              </div>
            )}
          </div>
        ))}
      </div>
      {curDone && !finished && (
        <button onClick={advance} className={CHECK_BTN}>{shown < card.steps.length ? "Next step →" : "That's the whole problem →"}</button>
      )}
    </div>
  );
}

// ─── clip: the same idea on a real video, before the words ───────────────────
// A thumbnail until tapped — an iframe on every teach card would make the round
// crawl — and youtube-nocookie, so an unwatched clip hands YouTube nothing.
// When the clip's time is up the iframe is unmounted: what is on screen then
// is the card's own words, never YouTube's grid of other videos.
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
export function Clip({ clip, onNoSense }: { clip: TeachClip; onNoSense?: () => void }) {
  const [playing, setPlaying] = useState(false);
  const [watched, setWatched] = useState(false);
  const len = Math.max(0, clip.end - clip.start);
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => { setPlaying(false); setWatched(true); }, (len + 1) * 1000);
    return () => clearTimeout(t);
  }, [playing, len]);
  return (
    <div className="mb-4">
      {playing ? (
        <div className="rounded-xl overflow-hidden bg-black" style={{ aspectRatio: "16 / 9" }}>
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${clip.id}?start=${clip.start}&end=${clip.end}&autoplay=1&rel=0&modestbranding=1&playsinline=1`}
            title={clip.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="w-full h-full border-0"
          />
        </div>
      ) : (
        <button onClick={() => { setPlaying(true); sfx.pop(); }}
          aria-label={`Play ${mmss(len)} of ${clip.title}`}
          className="w-full text-left rounded-xl overflow-hidden relative active:scale-[0.99] bg-black"
          style={{ aspectRatio: "16 / 9" }}>
          {/* hqdefault exists for every video; maxres does not. Plain <img>: the
              site is a static export (images.unoptimized), so next/image would
              add a wrapper and nothing else — same idiom as ChapterVideos. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`https://i.ytimg.com/vi/${clip.id}/hqdefault.jpg`} alt=""
            loading="lazy" className="w-full h-full object-cover opacity-80" />
          <span className="absolute inset-0 grid place-items-center">
            <span className="rounded-full bg-black/65 border border-white/30 px-4 py-2 text-white text-sm font-semibold">▶ {watched ? "Watch again" : "Watch this bit"} · {mmss(len)}</span>
          </span>
        </button>
      )}
      <p className="text-[13px] font-medium leading-snug mt-1.5">{clip.title} · <span className="mono text-[12px] text-[var(--text-3)]">{clip.channel}</span></p>
      <p className="text-[12px] text-[var(--text-3)] leading-relaxed mt-1">The same idea, explained on video — then the card below says it in plain words.</p>
      {onNoSense && <NoSense onTap={onNoSense} />}
    </div>
  );
}

// One sentence per line: a wall of prose is the thing that stops a tired
// eye; three short lines are not. Splits on sentence-ending punctuation
// followed by a space and a capital, digit or quote — an abbreviation like
// "e.g. this" stays whole.
export function sentencesOf(text: string): string[] {
  const out = text.trim().split(/(?<=[.!?…])\s+(?=["“(A-Z0-9])/).map((x) => x.trim()).filter(Boolean);
  return out.length ? out : [text];
}

// ─── teach: a clip if one was verified, the idea one sentence at a time, a diagram, the source line behind a tap, and a guide to ask ─────
export function TeachCard({ card, onAsk, onNoSense, onClipOff }: {
  card: TeachSpec; onAsk: (ask: string) => Promise<string>; onNoSense?: () => void; onClipOff?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<{ ask: string; reply: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [source, setSource] = useState(false);

  async function ask(q: string) {
    const clean = q.trim();
    if (busy || !clean) return;
    setBusy(true); setText(""); sfx.pop();
    const reply = await onAsk(clean);
    setThread((t) => [...t, { ask: clean, reply }]);
    setBusy(false);
  }

  return (
    <div>
      {card.clip && !card.clip_off && <Clip clip={card.clip} onNoSense={onClipOff} />}
      <div className="study-prose text-[1.06rem] space-y-2">
        {sentencesOf(card.text).map((line, i) => <p key={i}>{line}</p>)}
      </div>
      {card.diagram && <Diagram spec={card.diagram} />}
      {card.cite?.quote && (source ? (
        <p className="text-[12px] text-[var(--text-3)] italic mt-2 border-l-2 border-[var(--neon)]/40 pl-2">
          &ldquo;{card.cite.quote}&rdquo; — from your material
        </p>
      ) : (
        <button onClick={() => setSource(true)} className="text-[12px] opacity-70 mt-2 underline underline-offset-2 active:scale-95">See the source line</button>
      ))}
      <div className="flex items-center gap-4 mt-4">
        <button onClick={() => setOpen(true)} className="rounded-xl border border-[var(--neon)]/40 bg-[var(--neon)]/10 px-4 py-2.5 text-sm font-semibold text-[var(--neon)] active:scale-95">
          Ask the guide ▸
        </button>
        {onNoSense && <span className="-mt-3"><NoSense onTap={onNoSense} /></span>}
      </div>

      {open && (
        <div className="fixed inset-x-0 bottom-0 z-[60] max-h-[80vh] flex flex-col rounded-t-3xl border-t border-[var(--border-1)] bg-[var(--card)] shadow-2xl">
          <div className="px-4 pt-3 pb-2 flex items-start gap-3">
            <div className="flex-1">
              <p className="font-semibold">Learning Guide</p>
              <p className="text-[12px] text-[var(--text-3)] leading-snug">Asks before it tells. Tap &ldquo;Just tell me&rdquo; when you want the answer.</p>
            </div>
            <button onClick={() => setOpen(false)} className="text-sm opacity-70 active:scale-90 px-2">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 space-y-3">
            {thread.map((t, i) => (
              <div key={i}>
                <p className="text-[12px] text-[var(--neon)] mb-1">You: {t.ask}</p>
                <p className="study-prose text-[0.98rem]">{t.reply}</p>
              </div>
            ))}
            {busy && <p className="text-sm opacity-70">thinking…</p>}
          </div>
          <div className="px-4 pt-3 pb-5">
            <div className="flex flex-wrap gap-2">
              {GUIDE_CHIPS.map((c) => (
                <button key={c} disabled={busy} onClick={() => ask(c)}
                  className="px-3 py-2 rounded-xl bg-white/[0.06] border border-white/15 text-sm active:scale-95 disabled:opacity-50">{c}</button>
              ))}
            </div>
            {typing ? (
              <div className="flex gap-2 mt-3">
                <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") ask(text); }}
                  placeholder="Your own question (optional)" className="flex-1 rounded-xl bg-white/[0.06] border border-white/15 px-3 py-2 text-sm" />
                <button disabled={busy || !text.trim()} onClick={() => ask(text)}
                  className="rounded-xl bg-[var(--neon)] text-black px-4 text-sm font-bold active:scale-95 disabled:opacity-50">Ask</button>
              </div>
            ) : (
              <button onClick={() => setTyping(true)} className="mt-3 text-[12px] opacity-70 active:scale-95">or type your own question</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── review: a plain flashcard with three honest buttons ─────────────────────
// The interval under each button is the real one FSRS would schedule.
export function ReviewCard({ card, onRate }: { card: NBCard; onRate: (rating: Grade, ok: boolean) => void }) {
  const [flipped, setFlipped] = useState(false);
  const rated = useRef(false);
  const iv = intervalPreview(card);
  // "Missed" is warm orange, not red: a miss is the card doing its job. Its
  // time is the real one FSRS schedules — minutes, not "tomorrow".
  const buttons: { label: string; sub: string; rating: Grade; ok: boolean; hue: string }[] = [
    { label: "Missed", sub: iv.again ? `in ${iv.again}` : "again soon", rating: Rating.Again, ok: false, hue: "#fb923c" },
    { label: "Barely", sub: `in ${iv.hard || "a bit"}`, rating: Rating.Hard, ok: true, hue: "#fbbf24" },
    { label: "Got it", sub: `in ${iv.good || "a while"}`, rating: Rating.Good, ok: true, hue: "#38bdf8" },
  ];
  function rate(b: (typeof buttons)[number]) {
    if (rated.current) return;
    rated.current = true;
    if (b.ok) { sfx.pop(); buzz(12); } else { sfx.miss(); buzz(25); }
    onRate(b.rating, b.ok);
  }
  return (
    <div>
      <Eyebrow>Say how it felt — the time under each button is when it comes back</Eyebrow>
      <div className="rounded-2xl paper border p-4">
        <p className="study-prose text-[1.08rem]">{card.front}</p>
        {flipped && (
          <div className="mt-3 pt-3 border-t border-white/10 rise-in">
            <p className="study-prose text-[1rem]">{card.back}</p>
            {card.hint && <p className="text-[12px] text-[var(--text-3)] mt-2">{card.hint}</p>}
          </div>
        )}
      </div>
      {!flipped ? (
        <button onClick={() => { setFlipped(true); sfx.pop(); }} className={CHECK_BTN}>Show the answer</button>
      ) : (
        <div className="grid grid-cols-3 gap-2 mt-4">
          {buttons.map((b) => (
            <button key={b.label} onClick={() => rate(b)}
              className="rounded-xl border px-2 py-2.5 text-center active:scale-95"
              style={{ borderColor: `${b.hue}66`, background: `${b.hue}1a` }}>
              <span className="block text-sm font-bold" style={{ color: b.hue }}>{b.label}</span>
              <span className="block text-[12px] opacity-70 mono">{b.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
