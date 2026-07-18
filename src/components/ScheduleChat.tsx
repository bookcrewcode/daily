"use client";

// 🗓️ Schedule chat — build and edit the day by TALKING, not tapping.
// "gym at 7, class 9 to 11, bookcrew after lunch, dinner with gf at 7" → blocks.
// "move gym to 8 and kill the 3pm" → revised blocks.
//
// The AI returns the FULL revised day; you see it as a preview diff and tap
// Apply. Nothing is written to your plan until you accept it — same rule as
// every other AI surface in this app.

import { useRef, useState } from "react";
import { supabase, ADVISOR_FN, SUPABASE_ANON, todayStr, type ScheduleItem } from "@/lib/supabase";
import { sfx } from "@/lib/fx";
import { Card } from "./ui";

type Msg = { role: "user" | "assistant"; content: string };

const EXAMPLES = [
  "gym 7am, class 9–11, bookcrew after lunch",
  "move the gym to 8 and cut the 3pm",
  "fill my afternoon with deep work",
];

export default function ScheduleChat({
  dayLabel, items, fixed, onApply,
}: {
  dayLabel: string;
  items: ScheduleItem[];
  fixed?: { time: string; what: string }[];
  onApply: (items: ScheduleItem[]) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [proposal, setProposal] = useState<ScheduleItem[] | null>(null);
  const [applying, setApplying] = useState(false);
  const history = useRef<Msg[]>([]);

  async function send(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || busy) return;
    setBusy(true); setErr(""); setNote("");
    try {
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(ADVISOR_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
        body: JSON.stringify({
          advisor: "schedule",
          message: msg,
          // send the CURRENT plan so edits ("move gym to 8") work on real state
          items: proposal ?? items,
          fixed: fixed ?? [],
          dayLabel,
          history: history.current.slice(-8),
          clientDay: todayStr(),
        }),
      });
      const json = await res.json();
      if (json.error || !Array.isArray(json.items)) {
        setErr(json.error || "Couldn't build that — try rephrasing.");
        return;
      }
      const turn: Msg[] = [
        { role: "user", content: msg },
        { role: "assistant", content: String(json.note || "updated the day") },
      ];
      history.current = [...history.current, ...turn].slice(-8);
      setProposal(json.items as ScheduleItem[]);
      setNote(json.note || "");
      setInput("");
      sfx.pop();
    } catch {
      setErr("Couldn't reach the scheduler — check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!proposal || applying) return;
    setApplying(true); setErr("");
    // write first — only clear the proposal once it actually landed
    const ok = await onApply(proposal);
    setApplying(false);
    if (!ok) { setErr("Couldn't save that schedule — it's still here, try again."); return; }
    sfx.coin();
    setProposal(null);
    setNote("Saved to your day. ✓");
    history.current = [];
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="mt-2 w-full rounded-xl border border-[var(--neon)]/40 text-[var(--neon)] font-semibold py-3 text-sm active:scale-95">
        💬 Plan {dayLabel} by chatting →
      </button>
    );
  }

  const changed = proposal !== null;

  return (
    <Card tone="neon" className="mt-2">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs uppercase tracking-widest text-[var(--neon)]">💬 Talk out {dayLabel}</p>
        <button onClick={() => { setOpen(false); setProposal(null); setNote(""); setErr(""); }}
          className="text-xs opacity-50 active:scale-90">close</button>
      </div>

      {!changed && (
        <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1">
          {EXAMPLES.map((e) => (
            <button key={e} onClick={() => send(e)} disabled={busy}
              className="shrink-0 text-[11px] px-3 py-1.5 rounded-full bg-white/5 border border-white/10 active:scale-95 disabled:opacity-50">
              {e}
            </button>
          ))}
        </div>
      )}

      {/* proposal preview — review before it touches the real plan */}
      {changed && (
        <div className="rounded-xl bg-black/30 p-3 mb-2">
          <p className="text-[10px] uppercase tracking-widest opacity-50 mb-1.5">proposed · {proposal.length} blocks</p>
          {proposal.length === 0 && <p className="text-sm opacity-50">(empty day)</p>}
          {proposal.map((it, i) => (
            <div key={i} className="flex gap-2 text-sm py-0.5">
              <span className="text-[var(--neon)] font-semibold tabular-nums w-12 shrink-0">{it.time || "—"}</span>
              <span className="flex-1">{it.what}</span>
            </div>
          ))}
          <div className="flex gap-2 mt-3">
            <button onClick={() => { setProposal(null); setNote(""); }}
              className="flex-1 rounded-lg bg-white/10 text-sm font-semibold py-2 active:scale-95">Discard</button>
            <button onClick={apply} disabled={applying}
              className="flex-1 rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-50">
              {applying ? "saving…" : "Apply to my day"}
            </button>
          </div>
        </div>
      )}

      {note && <p className="text-xs opacity-70 mb-2">{note}</p>}
      {err && <p className="text-xs text-orange-400 mb-2">{err}</p>}

      <div className="flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={busy ? "thinking…" : changed ? "tweak it — “move gym to 8”" : "say your day out loud…"}
          className="flex-1 min-w-0 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
        <button onClick={() => send()} disabled={busy}
          className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-40">↑</button>
      </div>
      <p className="text-[10px] opacity-40 mt-2">
        Nothing changes until you tap Apply.
        {(fixed?.length ?? 0) > 0 ? " It schedules around your fixed calendar events." : " Check it against your calendar before applying."}
      </p>
    </Card>
  );
}
