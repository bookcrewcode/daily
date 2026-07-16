"use client";

// 🧲 Offer Builder — the Value Equation for what you sell.
// Hormozi: Value = (Dream Outcome × Perceived Likelihood) / (Time Delay × Effort).
// Grow the top two, shrink the bottom two, and the offer sells itself. This lets
// Ben score BookCrew's offer on each lever, see the value score, and get told
// the single weakest lever to fix next — the same constraint-thinking, applied
// to the offer instead of the week.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useGame } from "@/lib/useGameData";
import { Card } from "./ui";

type Offer = {
  name: string;
  dream: number;       // dream outcome (1-5, higher = bigger)
  likelihood: number;  // perceived likelihood of success (1-5, higher = more believable)
  speed: number;       // time delay (1-5, higher = FASTER payoff)
  ease: number;        // effort & sacrifice (1-5, higher = EASIER)
  guarantee: string;
  price: string;
};

const EMPTY: Offer = { name: "", dream: 3, likelihood: 3, speed: 3, ease: 3, guarantee: "", price: "" };

const LEVERS: { key: keyof Offer; label: string; hi: string; lo: string; grow: string }[] = [
  { key: "dream", label: "Dream outcome", hi: "life-changing", lo: "nice-to-have", grow: "sell a bigger transformation — the after-state they crave, not the feature" },
  { key: "likelihood", label: "Perceived likelihood", hi: "obviously works", lo: "unproven", grow: "add proof: case studies, testimonials, a demo, a guarantee — make success believable" },
  { key: "speed", label: "Speed to result", hi: "fast", lo: "slow", grow: "shorten time-to-first-win — a quick early result they can see" },
  { key: "ease", label: "Ease (low effort)", hi: "done-for-them", lo: "lots of work", grow: "remove steps and effort — do more of it for them" },
];

export default function OfferBuilder() {
  const game = useGame();
  const uid = game.uid;
  const [offer, setOffer] = useState<Offer>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("user_settings").select("offer").eq("user_id", uid).maybeSingle();
    if (error) { setLoaded(true); return; }
    const o = (data?.offer ?? {}) as Partial<Offer>;
    setOffer({ ...EMPTY, ...o });
    setLoaded(true);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  function set<K extends keyof Offer>(k: K, v: Offer[K]) {
    setOffer((o) => ({ ...o, [k]: v }));
    setDirty(true);
    setNote("");
  }

  async function save() {
    if (saving) return;
    setSaving(true); setNote("");
    const { error } = await supabase.from("user_settings").upsert({ user_id: uid, offer }, { onConflict: "user_id" });
    setSaving(false);
    if (error) { setNote("Couldn't save — your offer is still here. Try again."); return; }
    setDirty(false);
  }

  if (!loaded) return null;

  // value score: numerator up, denominator down. Normalized to ~0-100.
  const score = Math.round(((offer.dream * offer.likelihood) / (( (6 - offer.speed) * (6 - offer.ease) ))) * (100 / 25));
  const weakest = LEVERS.reduce((w, l) => (offer[l.key] as number) < (offer[w.key] as number) ? l : w, LEVERS[0]);

  return (
    <Card>
      <input value={offer.name} onChange={(e) => set("name", e.target.value)} placeholder="what you sell (e.g. BookCrew)"
        className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm mb-3" />

      {LEVERS.map((l) => (
        <div key={l.key} className="mb-3">
          <div className="flex justify-between text-xs mb-1">
            <span className="font-semibold">{l.label}</span>
            <span className="opacity-40">{l.lo} → {l.hi}</span>
          </div>
          <div className="flex gap-1.5">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} onClick={() => set(l.key, n as never)}
                className={`flex-1 h-8 rounded-lg text-xs font-bold active:scale-95 ${(offer[l.key] as number) >= n ? "bg-[var(--neon)] text-black" : "bg-white/5"}`}>
                {n}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="flex gap-2 mb-3">
        <input value={offer.price} onChange={(e) => set("price", e.target.value)} placeholder="price"
          className="w-28 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
        <input value={offer.guarantee} onChange={(e) => set("guarantee", e.target.value)} placeholder="guarantee (kills risk)"
          className="flex-1 min-w-0 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
      </div>

      <div className="rounded-xl bg-black/30 p-3 text-center">
        <p className="font-display font-extrabold text-3xl text-[var(--neon)]">{score}</p>
        <p className="text-[10px] uppercase tracking-widest opacity-50">value score</p>
        <p className="text-xs mt-2 text-left">
          Weakest lever: <b>{weakest.label}</b>. {weakest.grow}.
        </p>
        {!offer.guarantee.trim() && <p className="text-[11px] mt-1 text-left opacity-70">No guarantee yet — a strong one spikes perceived likelihood more than almost anything.</p>}
      </div>

      <button onClick={save} disabled={!dirty || saving}
        className="mt-3 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95 disabled:opacity-40">
        {saving ? "…" : dirty ? "Save offer" : "Saved ✓"}
      </button>
      {note && <p className="text-xs text-orange-400 mt-2">{note}</p>}
      <p className="text-[10px] opacity-40 mt-2">Score = (dream × likelihood) ÷ (delay × effort), Hormozi&apos;s Value Equation. Fix the weakest lever, not all four.</p>
    </Card>
  );
}
