"use client";

// Lessons — what the desk has learned, the weekly coach card, and the
// playbook the jurors are handed. A lesson is counted, not asserted: a
// post-mortem proposes one, and it only becomes a rule the jurors see once
// it has been sighted five times and outnumbers its contradictions 3:1.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow, SectionTitle } from "../ui";
import { callFn, REVIEW_FN, loadLessons, loadCards, fmtMoney, modelLabel, labTone, type Lesson, type CoachCard, type CoachCell } from "@/lib/desk/api";
import { PLAYBOOK, ORGANISING_RULE, templateName } from "@/lib/desk/playbook";
import { sfx, buzz } from "@/lib/fx";

const STATUS: Record<Lesson["status"], { label: string; note: string; color: string }> = {
  active: { label: "a rule", note: "seen five times and at least three times as often as it was contradicted; the jurors read it every night", color: "var(--ok)" },
  emerging: { label: "emerging", note: "seen three or four times; one more sighting or two and it becomes a rule", color: "var(--warn)" },
  hidden: { label: "sighted", note: "seen once or twice; not yet shown to the jurors", color: "var(--text-4)" },
};
const GROUP_LABEL: Record<string, string> = { template: "By playbook template", instrument: "By instrument", regime: "By market regime", exit: "By how the trade ended" };
const EXIT: Record<string, string> = { stop: "stopped out", target: "hit target", time: "time stop", thesis_broke: "thesis broke", liquidated: "liquidated", halt: "halted", cancelled: "never filled" };

export default function Lessons({ uid }: { uid: string }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [cards, setCards] = useState<CoachCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [coachErr, setCoachErr] = useState("");
  const [openTpl, setOpenTpl] = useState<number | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(async () => {
    const [l, c] = await Promise.all([loadLessons(uid), loadCards(uid, 4)]);
    setErr(l.error || c.error);
    if (!l.error) setLessons(l.lessons);
    if (!c.error) setCards(c.cards);
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function writeReview() {
    if (busy) return;
    setBusy(true); setCoachErr("");
    const r = await callFn<{ ok?: boolean; cost?: number; review?: string }>(REVIEW_FN, { mode: "coach" }, 150_000);
    if (r.error) setCoachErr(r.error);
    else { await load(); sfx.coin(); buzz(10); }
    setBusy(false);
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-24" /><div className="skeleton h-40 mt-3" /></div>;

  const active = lessons.filter((l) => l.status === "active");
  const emerging = lessons.filter((l) => l.status === "emerging");
  const hidden = lessons.filter((l) => l.status === "hidden");
  const latest = cards[0] ?? null;
  const desk = (latest?.card.desk ?? {}) as Record<string, Record<string, CoachCell> | CoachCell>;
  const overall = desk.overall as CoachCell | undefined;
  const models = latest?.card.models ?? {};

  return (
    <div className="pt-3">
      {err && <p className="text-[11px] text-orange-400 mb-2">{err}</p>}

      {/* ── lessons ────────────────────────────────────────────────── */}
      <Card>
        <Eyebrow className="mb-1.5">What the desk has learned</Eyebrow>
        {lessons.length === 0 ? (
          <p className="text-[12px] text-[var(--text-3)] leading-relaxed">Nothing yet. Every closed trade gets a post-mortem that proposes one transferable rule (&ldquo;when X, do Y&rdquo;). Rules that keep showing up are counted here, and the ones that earn it are read to the jurors each night.</p>
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

      {/* ── weekly coach ───────────────────────────────────────────── */}
      <SectionTitle>The weekly coach</SectionTitle>
      <Card>
        {latest ? (
          <>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">Week of {latest.week_start}{latest.card.as_of ? ` · as of ${latest.card.as_of}` : ""}</p>
            <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap mt-1.5">{latest.review}</p>
            {overall && overall.n > 0 && (
              <p className="mono text-[10px] text-[var(--text-4)] mt-2">{overall.n} closed · win {overall.hit === null ? "—" : `${(overall.hit * 100).toFixed(0)}%`} · R {fmtCell(overall.shrunk_r)} · profit factor {overall.profit_factor === null ? "—" : overall.profit_factor.toFixed(2)} · {overall.label}</p>
            )}
            {(["template", "instrument", "regime", "exit"] as const).map((g) => {
              const cells = desk[g] as Record<string, CoachCell> | undefined;
              const entries = Object.entries(cells ?? {}).filter(([, c]) => c && c.n > 0).sort((a, b) => b[1].n - a[1].n);
              if (!entries.length) return null;
              return (
                <div key={g} className="mt-3">
                  <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">{GROUP_LABEL[g]}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10.5px]">
                      <thead><tr className="text-[var(--text-4)] mono text-[8px] uppercase tracking-wider"><th className="text-left font-normal pb-1">cell</th><th className="text-right font-normal pb-1">n</th><th className="text-right font-normal pb-1">win</th><th className="text-right font-normal pb-1">R</th><th className="text-right font-normal pb-1">read</th></tr></thead>
                      <tbody>
                        {entries.map(([k, c]) => (
                          <tr key={k} className="border-t border-[var(--border-1)]">
                            <td className="py-1 pr-2">{g === "template" ? (Number(k) ? templateName(Number(k)) : "no template") : g === "exit" ? (EXIT[k] ?? k) : k}</td>
                            <td className="py-1 text-right mono">{c.n}</td>
                            <td className="py-1 text-right mono">{c.hit === null ? "—" : `${(c.hit * 100).toFixed(0)}%`}</td>
                            <td className="py-1 text-right mono" style={{ color: (c.shrunk_r ?? 0) > 0 ? "var(--ok)" : (c.shrunk_r ?? 0) < 0 ? "var(--bad)" : "var(--text-3)" }}>{fmtCell(c.shrunk_r)}</td>
                            <td className="py-1 text-right text-[var(--text-4)]">{c.label}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
            {Object.keys(models).length > 0 && (
              <div className="mt-3">
                <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">By juror</p>
                {Object.entries(models).sort((a, b) => (b[1].elo ?? 1500) - (a[1].elo ?? 1500)).map(([m, c]) => (
                  <p key={m} className="text-[10.5px] py-1 border-t border-[var(--border-1)] flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: labTone(m) }} />
                    <span className="flex-1 min-w-0 truncate">{modelLabel(m)}</span>
                    <span className="mono text-[var(--text-4)]">{Math.round(c.elo ?? 1500)} elo · {c.n} · {c.hit === null || c.hit === undefined ? "—" : `${(c.hit * 100).toFixed(0)}%`} · R {fmtCell(c.shrunk_r)} · Brier {c.brier === null || c.brier === undefined ? "—" : c.brier.toFixed(2)}</span>
                  </p>
                ))}
              </div>
            )}
            <p className="text-[10px] text-[var(--text-4)] mt-2.5 leading-relaxed">
              &ldquo;R&rdquo; is mean profit per unit of risk, shrunk toward zero for small samples. The read column says how much to believe a cell: too few to trust, emerging, a rule, strong. The coach writes every Monday; the button rewrites it now.
            </p>
          </>
        ) : (
          <p className="text-[12px] text-[var(--text-3)] leading-relaxed">No coach card yet. Every Monday the coach reads the closed trades by template, instrument, regime and exit, and writes about 200 words on what is working, what is not, and what is still too thin to judge.</p>
        )}
        <div className="flex items-center gap-3 mt-3">
          <button onClick={writeReview} disabled={busy} className="rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] text-xs font-semibold px-3 py-2 active:scale-95 disabled:opacity-50">
            {busy ? "Writing…" : latest ? "Rewrite this week's review" : "Write the first review"}
          </button>
          <span className="mono text-[9px] text-[var(--text-4)]">one model call, about {fmtMoney(0.02, 2)}</span>
        </div>
        {coachErr && <p className="text-[11px] text-orange-400 mt-2">{coachErr}</p>}
      </Card>

      {/* ── playbook ──────────────────────────────────────────────── */}
      <SectionTitle>The playbook</SectionTitle>
      <Card>
        <Eyebrow className="mb-1.5">The organising rule</Eyebrow>
        <p className="text-[12.5px] leading-relaxed">{ORGANISING_RULE}</p>
        <p className="text-[10.5px] text-[var(--text-4)] mt-2 leading-relaxed">Twelve templates below, each with the trigger that qualifies it, the direction, the horizon, and what proves it wrong. The evidence grade says how well the pattern has held up in published studies: strong, medium, weak, folklore, or practitioner lore. Jurors name the template they are using; template 0 means none fits.</p>
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
  const bits = [tpl ? templateName(tpl) : "", typeof scope.instrument === "string" ? String(scope.instrument).replace("_", " ") : ""].filter(Boolean);
  return (
    <Card className="mt-2">
      <p className="text-[12.5px] leading-relaxed">{l.text}</p>
      <p className="mono text-[10px] mt-1.5"><span style={{ color: s.color }}>{s.label}</span><span className="text-[var(--text-4)]"> · seen {l.for_count}× · against {l.against_count}× · applied {l.applied_count}×{bits.length ? ` · ${bits.join(" · ")}` : ""}</span></p>
      <p className="text-[10px] text-[var(--text-4)] mt-0.5 leading-snug">{s.note}.</p>
    </Card>
  );
}

const fmtCell = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
