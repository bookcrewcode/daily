"use client";

// Every decision this team has made, newest first. A candidate is a setup the
// scan flagged and the shared crew read; a session is the frontier's own
// review of what it already holds and of the crew's ideas; a close is the
// frontier calling a position off.

import { useCallback, useEffect, useState } from "react";
import { Pill } from "../ui";
import DecisionCard from "./DecisionCard";
import { Note } from "./LeagueBits";
import { loadDecisions, type DecisionRow, type TeamRow } from "@/lib/desk/api";

type Filter = "all" | "taken" | "passed" | "closes" | "sessions";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" }, { key: "taken", label: "Taken" }, { key: "passed", label: "Passed" },
  { key: "closes", label: "Closes" }, { key: "sessions", label: "Sessions" },
];

const MEANING: Record<Filter, string> = {
  all: "Everything the team has decided, newest first.",
  taken: "The candidates where the frontier said take, and a position was opened.",
  passed: "The candidates the team read and left alone. Most of them are these.",
  closes: "Positions the frontier decided to close before the stop or the target got there.",
  sessions: "The scheduled reviews, where the frontier looks over everything it holds and the crew's new ideas.",
};

const took = (d: DecisionRow) => d.outcome !== null && (d.outcome as Record<string, unknown>).taken === true;

export default function TeamDecisions({ uid, team }: { uid: string; team: TeamRow }) {
  const [rows, setRows] = useState<DecisionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await loadDecisions(uid, { teamId: team.id, limit: 150 });
    setErr(r.error);
    if (!r.error) setRows(r.decisions);
    setLoaded(true);
  }, [uid, team.id]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const shown = rows.filter((d) => {
    if (filter === "all") return true;
    if (filter === "taken") return (d.kind === "candidate" || d.kind === "session") && took(d);
    if (filter === "passed") return (d.kind === "candidate" || d.kind === "session") && !took(d);
    if (filter === "closes") return d.kind === "close";
    return d.kind === "session";
  });

  return (
    <div className="mt-3">
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
        {FILTERS.map((f) => <Pill key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</Pill>)}
      </div>
      <Note className="mt-1.5">{MEANING[filter]} {shown.length} of {rows.length} shown.</Note>
      {err && <button onClick={load} className="w-full mt-2 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">{err} — tap to retry</button>}
      {!loaded ? (
        <div className="skeleton h-24 mt-2" />
      ) : shown.length === 0 ? (
        <Note className="mt-2">Nothing here yet.</Note>
      ) : (
        <div className="mt-2 space-y-2">
          {shown.map((d) => (
            <DecisionCard key={d.id} decision={d} team={team} expanded={open === d.id} onToggle={() => setOpen(open === d.id ? null : d.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
