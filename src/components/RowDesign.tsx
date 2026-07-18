"use client";

// 🔧 Row design — the "discipline is design, not willpower" layer.
//
// The premise (Atomic Habits / behavioral neuroscience): your brain is built to
// conserve energy and take the path of least resistance. Fighting that with
// willpower loses, because fatigue always wins eventually. So instead of trying
// harder, you redesign the path:
//
//   ANCHOR      habit stacking — "After I <existing habit>, I <rep>". Borrows a
//               cue that already fires automatically, so you skip the hardest
//               part: starting.
//   2-MIN       the smallest version that still counts. Momentum beats intent.
//   FRICTION    the ONE environment change that makes the right action easier
//               than the wrong one (choice architecture).
//
// And when a row stalls, that is a DESIGN failure, never a character failure —
// the redesign flow says so explicitly and diagnoses which of the Four Laws
// (obvious / attractive / easy / satisfying) is broken.

import { useState } from "react";
import { supabase, ADVISOR_FN, SUPABASE_ANON, todayStr } from "@/lib/supabase";
import { sfx } from "@/lib/fx";

export type DesignRow = {
  id: string; emoji: string; name: string; rep: string; identity: string;
  anchor?: string; min_version?: string; friction?: string;
};

const LAW_LABEL: Record<string, string> = {
  obvious: "not obvious enough — no cue",
  attractive: "not attractive enough — no pull",
  easy: "not easy enough — too much friction",
  satisfying: "not satisfying enough — no felt payoff",
};

export default function RowDesign({
  row, recentReps, onSaved, onClose,
}: {
  row: DesignRow;
  recentReps: number;
  onSaved: (patch: { anchor: string; min_version: string; friction: string }) => void;
  onClose: () => void;
}) {
  const [anchor, setAnchor] = useState(row.anchor ?? "");
  const [minV, setMinV] = useState(row.min_version ?? "");
  const [friction, setFriction] = useState(row.friction ?? "");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [law, setLaw] = useState("");

  async function save() {
    if (saving) return;
    setSaving(true); setNote("");
    const patch = { anchor: anchor.trim(), min_version: minV.trim(), friction: friction.trim() };
    // write first — only close on a confirmed save, keep the typed design on failure
    const { error } = await supabase.from("engine_rows").update(patch).eq("id", row.id);
    setSaving(false);
    if (error) { setNote("Couldn't save — your design is still here. Try again."); return; }
    sfx.pop();
    onSaved(patch);
    onClose();
  }

  // Ask the engineer to diagnose it. Lands in the fields as a SUGGESTION.
  async function redesign() {
    if (busy) return;
    setBusy(true); setNote("");
    try {
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(ADVISOR_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
        body: JSON.stringify({
          advisor: "habit-design", clientDay: todayStr(),
          rowName: row.name, rowRep: row.rep, rowIdentity: row.identity,
          recentReps, anchor,
        }),
      });
      const json = await res.json();
      if (json.error) { setNote(json.error); return; }
      if (json.anchor) setAnchor(json.anchor);
      if (json.min_version) setMinV(json.min_version);
      if (json.friction) setFriction(json.friction);
      if (json.law) setLaw(json.law);
      if (json.why) setNote(json.why);
    } catch {
      setNote("Couldn't reach the engineer — design it yourself below.");
    } finally {
      setBusy(false);
    }
  }

  const stalling = recentReps <= 2;

  return (
    <div className="mt-2 rounded-xl bg-black/30 p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-widest opacity-50">🔧 design · {row.emoji} {row.name}</p>
        <button onClick={onClose} className="text-xs opacity-50 active:scale-90">done</button>
      </div>

      {stalling && (
        <p className="text-xs text-orange-300 mb-2">
          {recentReps}/7 this week. That&apos;s a <b>design</b> problem, not a you problem — your brain takes the
          cheapest path by default. Make this one cheaper than skipping it.
        </p>
      )}

      <label className="block text-[10px] uppercase tracking-widest opacity-50 mb-1">Anchor — stack it on something automatic</label>
      <input value={anchor} onChange={(e) => setAnchor(e.target.value)}
        placeholder="After I make coffee…"
        className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm mb-2" />

      <label className="block text-[10px] uppercase tracking-widest opacity-50 mb-1">2-minute version — the floor on bad days</label>
      <input value={minV} onChange={(e) => setMinV(e.target.value)}
        placeholder="just put the shoes on"
        className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm mb-2" />

      <label className="block text-[10px] uppercase tracking-widest opacity-50 mb-1">Friction fix — the one thing you set up</label>
      <input value={friction} onChange={(e) => setFriction(e.target.value)}
        placeholder="shoes by the door tonight"
        className="w-full rounded-lg bg-black/40 px-3 py-2 outline-none text-sm mb-2" />

      {law && <p className="text-[10px] text-[var(--neon)]/80 mb-1">broken law: {LAW_LABEL[law] ?? law}</p>}
      {note && <p className="text-xs opacity-70 mb-2">{note}</p>}

      <div className="flex gap-2">
        <button onClick={redesign} disabled={busy}
          className="flex-1 rounded-lg bg-white/10 text-xs font-semibold py-2 active:scale-95 disabled:opacity-50">
          {busy ? "diagnosing…" : "🔎 Redesign it for me"}
        </button>
        <button onClick={save} disabled={saving}
          className="flex-1 rounded-lg bg-[var(--neon)] text-black text-xs font-bold py-2 active:scale-95 disabled:opacity-50">
          {saving ? "…" : "Save design"}
        </button>
      </div>
    </div>
  );
}
