"use client";

// 🎯 The ONE Thing — Theory of Constraints for your week.
// The app is a buffet: 11 habits, Engine rows, quests, goals, tools. Hormozi's
// discipline: at any moment ONE thing is the bottleneck, and effort spent
// anywhere else is nearly wasted. Each week you name that constraint and the
// single number that moves it; everything else is maintenance. The Overseer can
// diagnose it from your data, but you commit to it — it's your call, not the AI's.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, dateStr, ADVISOR_FN, SUPABASE_ANON, todayStr } from "@/lib/supabase";
import { Card } from "./ui";

type Constraint = {
  week_start: string; area: string; bottleneck: string; metric: string;
  target: number; baseline: number; notes: string;
};

const AREAS = [
  { key: "income", emoji: "💰", label: "Income" },
  { key: "body", emoji: "💪", label: "Body" },
  { key: "mind", emoji: "🧠", label: "Mind/School" },
  { key: "system", emoji: "⚙️", label: "System" },
];

function mondayOf(d = new Date()): string {
  const c = new Date(d);
  c.setDate(c.getDate() - ((c.getDay() + 6) % 7));
  return dateStr(c);
}

// `compact` = the read-only banner shown on Today; full editor otherwise (Plan).
// On Today, the empty-state routes to Plan (the canonical editor) via onGoTab.
export default function ConstraintCard({ uid, compact = false, onGoTab }: { uid: string; compact?: boolean; onGoTab?: (tab: string) => void }) {
  const [ws, setWs] = useState(mondayOf());
  const [c, setC] = useState<Constraint | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Constraint | null>(null);
  const [note, setNote] = useState("");
  const [diagnosing, setDiagnosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const wsRef = useRef(ws);
  wsRef.current = ws;

  const load = useCallback(async () => {
    const week = mondayOf();
    setWs(week);
    const { data, error } = await supabase.from("weekly_constraints")
      .select("week_start,area,bottleneck,metric,target,baseline,notes")
      .eq("user_id", uid).eq("week_start", week).maybeSingle();
    if (error) { setLoaded(true); return; } // don't blank on a transient read
    setC((data as Constraint) ?? null);
    setLoaded(true);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  // week rollover (Sunday→Monday) guard — re-anchor to the new week
  useEffect(() => {
    const check = () => { if (mondayOf() !== wsRef.current) load(); };
    const id = setInterval(check, 30000);
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  function startEdit() {
    setDraft(c ?? { week_start: ws, area: "income", bottleneck: "", metric: "", target: 0, baseline: 0, notes: "" });
    setNote("");
    setEditing(true);
  }

  async function save() {
    if (!draft || saving) return;
    if (!draft.bottleneck.trim()) { setNote("Name the bottleneck first."); return; }
    setSaving(true); setNote("");
    // WRITE-THEN-CELEBRATE: only apply + close on a clean upsert; keep the editor
    // open with the typed values on failure.
    const { error } = await supabase.from("weekly_constraints").upsert(
      { user_id: uid, week_start: ws, area: draft.area, bottleneck: draft.bottleneck.trim(),
        metric: draft.metric.trim(), target: Number(draft.target) || 0, baseline: Number(draft.baseline) || 0, notes: draft.notes.trim() },
      { onConflict: "user_id,week_start" },
    );
    setSaving(false);
    if (error) { setNote("Couldn't save — your text is still here. Try again."); return; }
    setC({ ...draft, week_start: ws });
    setEditing(false);
  }

  // let the Overseer name the constraint from live data — a suggestion the user
  // edits and commits, never an auto-write.
  async function diagnose() {
    if (diagnosing) return;
    setDiagnosing(true); setNote("");
    try {
      const { data: session } = await supabase.auth.getSession();
      const res = await fetch(ADVISOR_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${session.session?.access_token}` },
        body: JSON.stringify({ advisor: "constraint", clientDay: todayStr() }),
      });
      const json = await res.json();
      if (json.area || json.bottleneck || json.metric) {
        setDraft((d) => ({
          week_start: ws,
          area: json.area && AREAS.some((a) => a.key === json.area) ? json.area : (d?.area ?? "income"),
          bottleneck: json.bottleneck ?? d?.bottleneck ?? "",
          metric: json.metric ?? d?.metric ?? "",
          target: Number(json.target) || d?.target || 0,
          baseline: Number(json.baseline) || d?.baseline || 0,
          notes: json.why ?? d?.notes ?? "",
        }));
        if (!editing) setEditing(true);
      } else {
        setNote(json.error || "Couldn't diagnose right now — set it yourself.");
      }
    } catch {
      setNote("Couldn't reach the Overseer — set it yourself.");
    } finally {
      setDiagnosing(false);
    }
  }

  if (!loaded) return null;
  const areaMeta = AREAS.find((a) => a.key === c?.area);

  // ── compact banner (Today) ──
  if (compact) {
    if (!c) {
      // compact mode has no editor of its own — route to Plan's full editor
      return (
        <button onClick={() => onGoTab?.("plan")} className="w-full text-left mt-3">
          <Card tone="warn">
            <p className="text-sm font-bold">🎯 Name this week&apos;s ONE thing</p>
            <p className="text-xs opacity-60 mt-0.5">One constraint. Everything else is maintenance. Set it in 🧭 Plan →</p>
          </Card>
        </button>
      );
    }
    return (
      <div className="mt-3">
        <Card tone="neon">
          <p className="text-[10px] uppercase tracking-widest text-[var(--neon)]/80">🎯 This week&apos;s ONE thing · {areaMeta?.emoji} {areaMeta?.label}</p>
          <p className="font-bold mt-0.5">{c.bottleneck}</p>
          {c.metric && <p className="text-xs opacity-70 mt-0.5">Move the number: <b>{c.metric}</b>{c.target ? ` → ${c.target}` : ""}</p>}
          <p className="text-[10px] opacity-40 mt-1">Everything else is maintenance this week.</p>
        </Card>
      </div>
    );
  }

  // ── full editor (Plan) ──
  if (editing && draft) {
    return (
      <Card className="mt-3">
        <p className="text-xs uppercase tracking-widest opacity-50 mb-2">🎯 This week&apos;s constraint</p>
        <div className="flex gap-1.5 mb-2 overflow-x-auto">
          {AREAS.map((a) => (
            <button key={a.key} onClick={() => setDraft({ ...draft, area: a.key })}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold active:scale-95 ${draft.area === a.key ? "bg-[var(--neon)] text-black" : "bg-white/5"}`}>
              {a.emoji} {a.label}
            </button>
          ))}
        </div>
        <input value={draft.bottleneck} onChange={(e) => setDraft({ ...draft, bottleneck: e.target.value })}
          placeholder="the bottleneck — e.g. 'not enough demos booked'"
          className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm mb-2" />
        <input value={draft.metric} onChange={(e) => setDraft({ ...draft, metric: e.target.value })}
          placeholder="the ONE number to move — e.g. 'demos booked'"
          className="w-full rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm mb-2" />
        <div className="flex gap-2 mb-2">
          <input value={draft.baseline || ""} onChange={(e) => setDraft({ ...draft, baseline: Number(e.target.value) || 0 })} inputMode="numeric" placeholder="now"
            className="flex-1 min-w-0 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
          <span className="self-center opacity-40">→</span>
          <input value={draft.target || ""} onChange={(e) => setDraft({ ...draft, target: Number(e.target.value) || 0 })} inputMode="numeric" placeholder="target"
            className="flex-1 min-w-0 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
        </div>
        <div className="flex gap-2">
          <button onClick={diagnose} disabled={diagnosing} className="flex-1 rounded-xl bg-white/10 text-sm font-semibold py-2.5 active:scale-95 disabled:opacity-50">
            {diagnosing ? "diagnosing…" : "🔎 Overseer, pick it"}
          </button>
          <button onClick={save} disabled={saving} className="flex-1 rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95 disabled:opacity-50">
            {saving ? "…" : "Commit"}
          </button>
        </div>
        {note && <p className="text-xs text-orange-400 mt-2">{note}</p>}
      </Card>
    );
  }

  return (
    <Card tone={c ? "neon" : "default"} className="mt-3">
      {c ? (
        <>
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-[var(--neon)]/80">🎯 This week&apos;s ONE thing · {areaMeta?.emoji} {areaMeta?.label}</p>
              <p className="font-bold mt-0.5">{c.bottleneck}</p>
              {c.metric && <p className="text-xs opacity-70 mt-0.5">Move: <b>{c.metric}</b>{c.baseline || c.target ? ` · ${c.baseline} → ${c.target}` : ""}</p>}
              {c.notes && <p className="text-xs opacity-50 mt-1 italic">{c.notes}</p>}
            </div>
            <button onClick={startEdit} className="text-xs opacity-50 active:scale-90 shrink-0">edit</button>
          </div>
          <p className="text-[10px] opacity-40 mt-1.5">Protect this. Everything else is maintenance this week.</p>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <span className="text-2xl">🎯</span>
          <div className="flex-1">
            <p className="text-sm font-bold">Name this week&apos;s constraint</p>
            <p className="text-[10px] opacity-50">One bottleneck, one number. The rest is maintenance.</p>
          </div>
          <button onClick={startEdit} className="px-3 py-2 rounded-xl bg-[var(--neon)] text-black text-sm font-bold active:scale-95">Set</button>
        </div>
      )}
    </Card>
  );
}
