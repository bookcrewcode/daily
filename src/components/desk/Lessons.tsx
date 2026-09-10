"use client";

// Lessons — what the desk has learned, and the playbook the jurors are handed.
// A lesson is counted, not asserted: a micro review proposes one, and it only
// becomes a rule the jurors see once it has been sighted five times and
// outnumbers its contradictions 3:1. The macro review lives under its own view.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow, SectionTitle } from "../ui";
import { loadLessons, type Lesson } from "@/lib/desk/api";
import { PLAYBOOK, ORGANISING_RULE, templateName } from "@/lib/desk/playbook";
import { strategyName } from "@/lib/desk/scan";

const STATUS: Record<Lesson["status"], { label: string; note: string; color: string }> = {
  active: { label: "a rule", note: "seen five times and at least three times as often as it was contradicted; the jurors read it every night", color: "var(--ok)" },
  emerging: { label: "emerging", note: "seen three or four times; one more sighting or two and it becomes a rule", color: "var(--warn)" },
  hidden: { label: "sighted", note: "seen once or twice; not yet shown to the jurors", color: "var(--text-4)" },
};

export default function Lessons({ uid }: { uid: string }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [openTpl, setOpenTpl] = useState<number | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(async () => {
    const l = await loadLessons(uid);
    setErr(l.error);
    if (!l.error) setLessons(l.lessons);
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  if (!loaded) return <div className="pt-3"><div className="skeleton h-24" /><div className="skeleton h-40 mt-3" /></div>;

  const active = lessons.filter((l) => l.status === "active");
  const emerging = lessons.filter((l) => l.status === "emerging");
  const hidden = lessons.filter((l) => l.status === "hidden");

  return (
    <div className="pt-3">
      {err && <button onClick={load} className="w-full mb-2 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">{err} — tap to retry</button>}

      <Card>
        <Eyebrow className="mb-1.5">What the desk has learned</Eyebrow>
        {lessons.length === 0 ? (
          <p className="text-[12px] text-[var(--text-3)] leading-relaxed">Nothing yet. Every closed trade gets a micro review that proposes one transferable rule (&ldquo;when X, do Y&rdquo;). Rules that keep showing up are counted here, and the ones that earn it are read to the jurors each night.</p>
        ) : (
          <p className="text-[11.5px] text-[var(--text-3)] leading-relaxed">{active.length} rule{active.length === 1 ? "" : "s"} in force, {emerging.length} emerging, {hidden.length} sighted once or twice. A rule is counted, not assumed: it needs five sightings and a 3:1 margin over contradictions.</p>
        )}
      </Card>
      {[...active, ...emerging].map((l) => <LessonCard key={l.id} l={l} />)}
      {hidden.length > 0 && (
        <button onClick={() => setShowHidden((v) => !v)} className="mono text-[10px] text-[var(--text-4)] mt-2 active:scale-95">
          {showHidden ? "hide" : "show"} the {hidden.length} sighted once or twice
        </button>
      )}
      {showHidden && hidden.map((l) => <LessonCard key={l.id} l={l} />)}

      <SectionTitle>The playbook</SectionTitle>
      <Card>
        <Eyebrow className="mb-1.5">The organising rule</Eyebrow>
        <p className="text-[12.5px] leading-relaxed">{ORGANISING_RULE}</p>
        <p className="text-[10.5px] text-[var(--text-4)] mt-2 leading-relaxed">Twelve templates below, each with the trigger that qualifies it, the direction, the horizon, and what proves it wrong. The evidence grade says how well the pattern has held up in published studies: strong, medium, weak, folklore, or practitioner lore. Nightly jurors name the template they are using; template 0 means none fits. The eight coded strategies the scan runs are under Strategies.</p>
      </Card>
      <div className="mt-2 space-y-1.5">
        {PLAYBOOK.map((t) => {
          const isOpen = openTpl === t.id;
          return (
            <Card key={t.id}>
              <button onClick={() => setOpenTpl(isOpen ? null : t.id)} className="w-full text-left active:scale-[0.995] flex items-baseline gap-2">
                <span className="mono text-[10px] text-[var(--text-4)] w-4 shrink-0">{t.id}</span>
                <span className="text-[12.5px] font-semibold flex-1">{t.name}</span>
                <span className="mono text-[9px] uppercase tracking-widest" style={{ color: t.evidence === "strong" ? "var(--ok)" : t.evidence === "medium" ? "var(--warn)" : "var(--text-4)" }}>{t.evidence}</span>
              </button>
              {isOpen && (
                <div className="mt-2 pt-2 border-t border-[var(--border-1)] rise-in text-[11.5px] leading-relaxed space-y-1">
                  <p><span className="text-[var(--text-4)]">Trigger:</span> {t.trigger}</p>
                  <p><span className="text-[var(--text-4)]">Direction:</span> {t.direction}</p>
                  <p><span className="text-[var(--text-4)]">Horizon:</span> {t.horizon}</p>
                  <p><span className="text-[var(--text-4)]">Wrong if:</span> {t.invalidation}</p>
                  <p><span className="text-[var(--text-4)]">Size:</span> {t.sizeHint === "small" ? "smallest allowed; the evidence is thin" : "normal"}</p>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function LessonCard({ l }: { l: Lesson }) {
  const s = STATUS[l.status];
  const scope = l.scope ?? {};
  const tpl = Number(scope.template);
  const strategy = typeof scope.strategy === "string" && scope.strategy ? strategyName(String(scope.strategy)) : "";
  const bits = [tpl ? templateName(tpl) : "", strategy, typeof scope.timeframe === "string" ? String(scope.timeframe) : "", typeof scope.instrument === "string" ? String(scope.instrument).replace("_", " ") : ""].filter(Boolean);
  return (
    <Card className="mt-2">
      <p className="text-[12.5px] leading-relaxed">{l.text}</p>
      <p className="mono text-[10px] mt-1.5"><span style={{ color: s.color }}>{s.label}</span><span className="text-[var(--text-4)]"> · seen {l.for_count}× · against {l.against_count}× · applied {l.applied_count}×{bits.length ? ` · ${bits.join(" · ")}` : ""}</span></p>
      <p className="text-[10px] text-[var(--text-4)] mt-0.5 leading-snug">{s.note}.</p>
    </Card>
  );
}
