"use client";

// 🃏 Flashcards + spaced repetition (FSRS). Cards are built from your material;
// FSRS decides WHEN each one comes back so it actually sticks — the reason to
// return daily. A review session flips a card, you rate how it felt (Again/
// Hard/Good/Easy), and the schedule updates. This is the retention engine the
// old learning loop was missing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { advisorCall } from "@/lib/notebook";
import { emptyCardState, reviewCard, intervalPreview, isDue, RATINGS, type CardState, type NBCard as CardRow } from "@/lib/fsrs";
import { sfx, buzz } from "@/lib/fx";
import { Card } from "./ui";

const CARD_COLS = "id,notebook_id,chapter_id,front,back,hint,suspended,due,stability,difficulty,elapsed_days,scheduled_days,learning_steps,reps,lapses,state,last_review";
const SESSION_MAX = 30;

export default function Cards({ uid, notebookId }: { uid: string; notebookId: string }) {
  const [cards, setCards] = useState<CardRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"deck" | "review">("deck");

  // review-session state
  const [queue, setQueue] = useState<CardRow[]>([]);
  const [qi, setQi] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [done, setDone] = useState(0);
  const rating = useRef(false);

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.from("notebook_cards").select(CARD_COLS).eq("user_id", uid).eq("notebook_id", notebookId).order("due", { ascending: true });
      if (error) { setLoadErr(true); setLoaded(true); return; }
      setCards((data ?? []) as CardRow[]);
      setLoadErr(false); setLoaded(true);
    } catch { setLoadErr(true); setLoaded(true); }
  }, [uid, notebookId]);
  useEffect(() => { load(); }, [load]);

  // recompute "due" as wall-clock passes, so a long-open deck updates on its own
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 45000); return () => clearInterval(t); }, []);
  const dueCards = useMemo(() => cards.filter((c) => isDue(c)), [cards, tick]);

  async function generate() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const json = await advisorCall<{ cards?: { front: string; back: string; hint: string }[]; error?: string }>({ advisor: "flashcards", topicId: notebookId, n: 16 });
      if (json.error || !json.cards?.length) { setErr(json.error || "Couldn't make cards — try again."); return; }
      const now = new Date();
      const rows = json.cards.map((c) => ({ user_id: uid, notebook_id: notebookId, chapter_id: null, front: c.front, back: c.back, hint: c.hint || "", ...emptyCardState(now) }));
      const { error } = await supabase.from("notebook_cards").insert(rows);
      if (error) { setErr("Made the cards but couldn't save them — try again."); return; }
      sfx.coin();
      await load();
    } catch {
      setErr("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  }

  function startReview() {
    const q = cards.filter((c) => isDue(c)).slice(0, SESSION_MAX);
    if (!q.length) return;
    setQueue(q); setQi(0); setFlipped(false); setDone(0); setErr(""); setMode("review");
  }

  async function rate(gradeIdx: number) {
    if (rating.current) return;
    const cardRow = queue[qi];
    if (!cardRow) return;
    rating.current = true; setErr("");
    try {
      const next: CardState = reviewCard(cardRow, RATINGS[gradeIdx].rating);
      const { error } = await supabase.from("notebook_cards").update(next).eq("id", cardRow.id);
      if (error) { setErr("Couldn't save that rating — try again."); return; } // stay on card; it's still due
      if (RATINGS[gradeIdx].rating === 1) buzz(20); else sfx.pop();
      setDone((d) => d + 1);
      // advance
      if (qi + 1 < queue.length) { setQi(qi + 1); setFlipped(false); }
      else { setMode("deck"); await load(); }
    } catch {
      setErr("Couldn't reach the server — try again.");
    } finally {
      rating.current = false;
    }
  }

  async function removeCard(id: string) {
    const prev = cards;
    setCards((c) => c.filter((x) => x.id !== id));
    try {
      const { error } = await supabase.from("notebook_cards").delete().eq("id", id);
      if (error) { setCards(prev); setErr("Couldn't delete that card."); }
    } catch {
      setCards(prev); setErr("Couldn't reach the server — that card is still there.");
    }
  }

  if (!loaded) return <div className="skeleton h-32 mt-3" />;
  if (loadErr) return <button onClick={load} className="mt-3 w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">Couldn&apos;t load your cards — tap to retry</button>;

  // ── Review session ──────────────────────────────────────────────
  if (mode === "review") {
    const cardRow = queue[qi];
    // rate() always transitions to "deck" when the queue is exhausted, so a
    // missing card here can't normally happen; render nothing rather than
    // calling setState during render (an anti-pattern).
    if (!cardRow) return null;
    const previews = flipped ? intervalPreview(cardRow) : null;
    return (
      <div className="mt-3">
        <div className="flex items-center gap-2 mb-3">
          <button onClick={() => { setMode("deck"); load(); }} className="text-xs opacity-50 active:scale-95">← end session</button>
          <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full bg-[var(--neon)] transition-all" style={{ width: `${(done / queue.length) * 100}%` }} />
          </div>
          <span className="text-[10px] opacity-40">{done}/{queue.length}</span>
        </div>

        <button onClick={() => setFlipped((f) => !f)} className="w-full text-left" style={{ perspective: "1200px" }}>
          <div className={`flip-3d ${flipped ? "flipped" : ""}`} style={{ minHeight: "12rem" }}>
            <div className="flip-face">
              <Card tone="paper" className="min-h-[12rem] h-full grid place-items-center text-center">
                <div>
                  <p className="study-prose text-[1.15rem]">{cardRow.front}</p>
                  {cardRow.hint && <p className="text-xs opacity-50 mt-3">hint: {cardRow.hint}</p>}
                  <p className="text-[10px] uppercase tracking-widest opacity-40 mt-4">tap to flip</p>
                </div>
              </Card>
            </div>
            <div className="flip-face flip-back">
              <Card tone="neon" className="min-h-[12rem] h-full grid place-items-center text-center">
                <p className="study-prose text-[1.1rem]">{cardRow.back}</p>
              </Card>
            </div>
          </div>
        </button>

        {flipped ? (
          <div className="grid grid-cols-4 gap-1.5 mt-3">
            {RATINGS.map((r, i) => (
              <button key={r.key} onClick={() => rate(i)} disabled={rating.current}
                className="rounded-xl py-2.5 active:scale-95 disabled:opacity-50 flex flex-col items-center border"
                style={{ borderColor: `${r.hue}55`, background: `${r.hue}18` }}>
                <span className="text-sm font-bold" style={{ color: r.hue }}>{r.label}</span>
                <span className="text-[10px] opacity-50">{previews?.[r.key] ?? ""}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-center text-xs opacity-40 mt-3">Answer it in your head, then flip.</p>
        )}
        {err && <p className="text-xs text-orange-400 mt-2 text-center">{err}</p>}
      </div>
    );
  }

  // ── Deck view ───────────────────────────────────────────────────
  return (
    <div className="mt-3 space-y-3">
      <Card>
        <div className="flex items-center gap-4">
          <div className="text-center">
            <p className="font-display text-3xl font-black leading-none" style={{ color: dueCards.length ? "var(--neon)" : undefined }}>{dueCards.length}</p>
            <p className="text-[10px] uppercase tracking-widest opacity-40 mt-1">due now</p>
          </div>
          <div className="w-px self-stretch bg-white/10" />
          <div className="text-center">
            <p className="font-display text-3xl font-black leading-none opacity-70">{cards.length}</p>
            <p className="text-[10px] uppercase tracking-widest opacity-40 mt-1">total</p>
          </div>
          <div className="flex-1" />
          {dueCards.length > 0 ? (
            <button onClick={startReview} className="rounded-xl bg-[var(--neon)] text-black font-bold px-5 py-3 active:scale-95">Review →</button>
          ) : cards.length > 0 ? (
            <div className="text-right"><p className="text-2xl">✅</p><p className="text-[10px] opacity-50">all caught up</p></div>
          ) : null}
        </div>
      </Card>

      <div className="flex gap-2">
        <button onClick={generate} disabled={busy} className="flex-1 rounded-xl bg-white/10 py-2.5 text-sm font-semibold active:scale-95 disabled:opacity-50">
          {busy ? "writing cards…" : cards.length ? "+ 16 more cards" : "✨ Generate flashcards"}
        </button>
      </div>
      {err && <p className="text-xs text-orange-400">{err}</p>}

      {cards.length === 0 && !busy && (
        <p className="text-sm opacity-40">No cards yet — generate a set from your sources and FSRS handles the rest.</p>
      )}

      {cards.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-widest opacity-40">All cards · {cards.length}</p>
          {cards.map((c) => (
            <div key={c.id} className="rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{c.front}</p>
                <p className="text-xs opacity-40 truncate">{c.back}</p>
              </div>
              {isDue(c) ? <span className="text-[9px] text-[var(--neon)] shrink-0 mt-1">due</span> : null}
              <button onClick={() => removeCard(c.id)} className="opacity-30 text-xs shrink-0 active:scale-90">✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
