"use client";

// ⚡ Quick habit — add a designed micro-habit in ONE line.
//
// The video's whole thesis is "make the right behavior easy," but the old add
// flow asked for 4 fields, and the anchor / 2-min floor / friction fix lived
// behind a SECOND trip into 🔧. Seven inputs to create one tiny habit is exactly
// the friction the method says to delete.
//
// Now: type "after coffee → 10 pushups" (or tap a starter) and you get a fully
// designed row — anchor, rep, 2-minute floor, identity — in one action.
//
// Habit stacking's three rules from the transcript are enforced by the shape of
// the input itself: SHORT (the floor is auto-derived), SPECIFIC (you name a real
// cue), IMMEDIATE (the form is literally "after X → Y").

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { sfx } from "@/lib/fx";

// Proven <2-minute starters, each already anchored to something that fires on
// its own. Tapping one is a single action — no blank page, no decisions.
export const STARTERS: { emoji: string; name: string; anchor: string; rep: string; min: string; identity: string }[] = [
  { emoji: "💪", name: "Pushups", anchor: "After I brush my teeth", rep: "10 pushups", min: "2 pushups", identity: "I'm someone who trains every day" },
  { emoji: "📖", name: "Read", anchor: "After I get into bed", rep: "Read 2 pages", min: "Read one paragraph", identity: "I'm someone who reads" },
  { emoji: "🧘", name: "Stretch", anchor: "After I close the laptop", rep: "Stretch 5 min", min: "One hamstring stretch", identity: "I'm someone who takes care of my body" },
  { emoji: "💧", name: "Water", anchor: "After I wake up", rep: "Drink a full glass", min: "One sip", identity: "I'm someone who hydrates first" },
  { emoji: "📝", name: "Write", anchor: "After I make coffee", rep: "Write one paragraph", min: "Open the doc, one sentence", identity: "I'm someone who ships" },
  { emoji: "🧹", name: "Reset space", anchor: "Before I leave a room", rep: "Put 3 things away", min: "Put one thing away", identity: "I'm someone whose space works for him" },
];

// "after coffee → 10 pushups" / "after coffee, 10 pushups" / "10 pushups"
export function parseHabit(input: string): { anchor: string; rep: string } {
  const raw = input.trim();
  const arrow = raw.split(/\s*(?:→|->|=>|,\s*then|\bthen\b)\s*/i);
  if (arrow.length >= 2 && arrow[0] && arrow[1]) {
    return { anchor: normalizeAnchor(arrow[0]), rep: arrow.slice(1).join(" ").trim() };
  }
  // "after X, Y" with only a comma
  const m = raw.match(/^\s*after\s+([^,]+),\s*(.+)$/i);
  if (m) return { anchor: normalizeAnchor(m[1]), rep: m[2].trim() };
  return { anchor: "", rep: raw };
}

function normalizeAnchor(s: string): string {
  const t = s.trim().replace(/^after\s+i\s+/i, "").replace(/^after\s+/i, "").replace(/[.,]+$/, "");
  return t ? `After I ${t}` : "";
}

// A floor you can't refuse: shrink a number, else just "start it".
function deriveFloor(rep: string): string {
  const n = rep.match(/^(\d+)\s+(.*)$/);
  if (n) {
    const small = Math.max(1, Math.round(Number(n[1]) / 5));
    return `${small} ${n[2]}`;
  }
  const mins = rep.match(/(\d+)\s*(min|minute)/i);
  if (mins) return rep.replace(/(\d+)\s*(min|minute)/i, "1 min");
  return `Just start ${rep.replace(/^(do|go|read|write)\s+/i, "").slice(0, 40)} for 2 minutes`;
}

export default function QuickHabit({ uid, sortStart, onAdded }: {
  uid: string; sortStart: number; onAdded: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showStarters, setShowStarters] = useState(false);

  async function add(row: { emoji: string; name: string; anchor: string; rep: string; min: string; identity: string }) {
    if (busy) return;
    setBusy(true); setErr("");
    // write first — the input stays put if it doesn't land
    const { error } = await supabase.from("engine_rows").insert({
      user_id: uid, emoji: row.emoji, name: row.name, rep: row.rep,
      identity: row.identity, anchor: row.anchor, min_version: row.min, sort: sortStart,
    });
    setBusy(false);
    if (error) { setErr("Couldn't add that — it's still here, try again."); return; }
    setText("");
    setShowStarters(false);
    sfx.coin();
    onAdded();
  }

  async function addTyped() {
    const { anchor, rep } = parseHabit(text);
    if (!rep.trim()) return;
    const name = rep.length > 22 ? rep.slice(0, 22).trim() + "…" : rep;
    await add({
      emoji: "⚡",
      name,
      anchor,
      rep: rep.trim(),
      min: deriveFloor(rep.trim()),
      identity: `I'm someone who does ${name.toLowerCase()}`,
    });
  }

  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTyped()}
          placeholder="after coffee → 10 pushups"
          className="flex-1 min-w-0 rounded-xl bg-black/30 border border-white/10 px-3 py-2.5 outline-none text-sm" />
        <button onClick={addTyped} disabled={busy || !text.trim()}
          className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-40">＋</button>
      </div>
      <div className="flex items-center gap-3 mt-1.5">
        <button onClick={() => setShowStarters((v) => !v)} className="text-[10px] opacity-50 underline">
          {showStarters ? "hide starters" : "or pick a 2-minute starter"}
        </button>
        <span className="text-[10px] opacity-30">one line · cue → action</span>
      </div>
      {showStarters && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {STARTERS.map((s) => (
            <button key={s.name} onClick={() => add(s)} disabled={busy}
              className="text-[11px] px-2.5 py-1.5 rounded-full bg-white/5 border border-white/10 active:scale-95 disabled:opacity-50">
              {s.emoji} {s.rep} <span className="opacity-40">· {s.anchor.replace("After I ", "after ")}</span>
            </button>
          ))}
        </div>
      )}
      {err && <p className="text-xs text-orange-400 mt-1">{err}</p>}
    </div>
  );
}
