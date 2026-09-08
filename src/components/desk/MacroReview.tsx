"use client";

// Macro review — the daily read across every trade, strategy and juror: what
// is working, what is not, what the trades teach, how to proceed. Written each
// morning from the measured record (and on demand here), after the standard
// has been applied to every seat, so a cut juror shows up in the same breath
// as the number that cut it. Every label is explained where it sits.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow } from "../ui";
import { callFn, REVIEW_FN, loadCards, fmtMoney, fmtR, modelLabel, labTone, type CoachCard, type CoachCell } from "@/lib/desk/api";
import { STRATEGIES } from "@/lib/desk/scan";
import { sfx, buzz } from "@/lib/fx";

const GROUP: Record<string, string> = { timeframe: "By timeframe", source: "By source", exit: "By how the trade ended" };
const EXIT: Record<string, string> = { stop: "stopped out", target: "hit target", time: "time stop", thesis_broke: "thesis broke", liquidated: "liquidated", halt: "halted", cancelled: "never filled" };
const stratName = (id: string) => STRATEGIES.find((s) => s.id === id)?.name ?? id;
const fmtCell = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(0)}%`);
const toneOf = (v: number | null | undefined) => ((v ?? 0) > 0 ? "var(--ok)" : (v ?? 0) < 0 ? "var(--bad)" : "var(--text-3)");
const dayLabel = (day: string, o: Intl.DateTimeFormatOptions) => new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", ...o });

export default function MacroReview({ uid, onChanged }: { uid: string; onChanged: () => void }) {
  const [cards, setCards] = useState<CoachCard[]>([]);
  const [sel, setSel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const c = await loadCards(uid, 10);
    setErr(c.error);
    if (!c.error) { setCards(c.cards); setSel((cur) => (cur && c.cards.some((x) => x.day === cur) ? cur : (c.cards[0]?.day ?? ""))); }
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function write() {
    if (busy) return;
    setBusy(true); setNote("");
    const r = await callFn<{ ok?: boolean; cost?: number; roster_changes?: number }>(REVIEW_FN, { mode: "coach" }, 150_000);
    if (r.error) setNote(r.error);
    else {
      const n = r.roster_changes ?? 0;
      setNote(`Written for ${fmtMoney(r.cost ?? 0, 3)}${n ? `, ${n} roster change${n === 1 ? "" : "s"}` : ""}.`);
      sfx.coin(); buzz(10);
      await load(); onChanged();
    }
    setBusy(false);
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-14" /><div className="skeleton h-56 mt-3" /></div>;
  const card = cards.find((c) => c.day === sel) ?? cards[0] ?? null;
  const c = card?.card ?? {};
  const desk = (c.desk ?? {}) as Record<string, Record<string, CoachCell> | CoachCell>;
  const overall = desk.overall as CoachCell | undefined;
  const byStrategy = (desk.strategy as Record<string, CoachCell> | undefined) ?? {};
  const strategies = c.strategies ?? {};
  const rules = c.strategy_rules ?? {};
  const models = c.models ?? {};
  const changes = c.roster_changes ?? [];
  const trades = c.trades ?? [];

  return (
    <div className="pt-3">
      <Card>
        <div className="flex items-baseline justify-between">
          <Eyebrow>The macro review</Eyebrow>
          <span className="mono text-[10px] text-[var(--text-4)]">daily at 1:05am ET</span>
        </div>
        <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed mt-1.5">
          Every morning a model reads the whole record, not one trade: the desk&apos;s closed trades by strategy, timeframe and source, each strategy&apos;s own book against the jury&apos;s version of it, every juror&apos;s Elo, Brier and sit record with its standing, and the last trades with their micro reviews. It writes what is working, what is not, what the trades teach, and how to proceed. First it applies the standard: a juror below it is cut and the bench fills the seat.
        </p>
        <div className="flex items-center gap-3 mt-2.5">
          <button onClick={write} disabled={busy} className="rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] text-xs font-semibold px-3 py-2 active:scale-95 disabled:opacity-50">{busy ? "Reading the record…" : card ? "Write today's review now" : "Write the first review"}</button>
          <span className="mono text-[9px] text-[var(--text-4)]">one model call, about {fmtMoney(0.05, 2)}</span>
        </div>
        {(note || err) && <p className={`text-[11px] mt-2 ${err ? "text-orange-400" : "text-[var(--text-3)]"}`}>{err || note}</p>}
      </Card>

      {cards.length > 1 && (
        <div className="flex gap-1.5 mt-3 overflow-x-auto no-scrollbar pb-1">
          {cards.map((x) => (
            <button key={x.day} onClick={() => setSel(x.day)} className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-semibold transition ${x.day === card?.day ? "bg-[var(--neon)] text-black" : "bg-white/5 opacity-70"}`}>
              {dayLabel(x.day, { month: "short", day: "numeric" })}
            </button>
          ))}
        </div>
      )}

      {!card ? (
        <Card className="mt-3"><p className="text-[12px] text-[var(--text-3)] leading-relaxed">No review yet. The first one writes itself at 1:05am ET, or press the button.</p></Card>
      ) : (
        <>
          <Card className="mt-3" tone="neon">
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">{dayLabel(card.day, { weekday: "long", month: "long", day: "numeric" })}</p>
            <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap mt-1.5">{card.review}</p>
            {overall && overall.n > 0 && (
              <p className="mono text-[10px] text-[var(--text-4)] mt-2">{overall.n} closed · win {pct(overall.hit)} · R {fmtCell(overall.shrunk_r)} · profit factor {overall.profit_factor === null ? "—" : overall.profit_factor.toFixed(2)} · {overall.label}{c.sits_week ? ` · ${c.sits_week.taken} of ${c.sits_week.n} sits taken this week` : ""}</p>
            )}
          </Card>

          {changes.length > 0 && (
            <Card className="mt-2.5" tone="warn">
              <Eyebrow className="mb-1.5">Roster changes today</Eyebrow>
              {changes.map((ch, i) => (
                <p key={i} className="text-[11.5px] leading-snug mt-1">
                  <span className="mono text-[10px] uppercase" style={{ color: ch.action === "cut" ? "var(--bad)" : "var(--warn)" }}>{ch.action}</span> <span className="font-semibold">{modelLabel(ch.model)}</span> <span className="text-[var(--text-4)]">({ch.seat} jury)</span>
                  {ch.replaced_by ? <> → <span className="font-semibold">{modelLabel(ch.replaced_by)}</span> takes the seat</> : null}
                  <span className="text-[var(--text-3)]">: {ch.reason}</span>
                </p>
              ))}
            </Card>
          )}

          {(Object.keys(strategies).length > 0 || Object.keys(byStrategy).length > 0) && (
            <Card className="mt-2.5">
              <Eyebrow className="mb-1">Strategies · the rule alone vs with the jury</Eyebrow>
              <div className="overflow-x-auto">
                <table className="w-full text-[10.5px]">
                  <thead><tr className="text-[var(--text-4)] mono text-[8px] uppercase tracking-wider"><th className="text-left font-normal pb-1">strategy</th><th className="text-right font-normal pb-1">rule n</th><th className="text-right font-normal pb-1">rule R</th><th className="text-right font-normal pb-1">jury n</th><th className="text-right font-normal pb-1">jury R</th><th className="text-right font-normal pb-1">size</th></tr></thead>
                  <tbody>
                    {STRATEGIES.map((s) => {
                      const rule = strategies[s.id], jury = byStrategy[s.id], rr = rules[s.id];
                      if (!rule && !jury) return null;
                      return (
                        <tr key={s.id} className="border-t border-[var(--border-1)]">
                          <td className="py-1 pr-2">{s.name}</td>
                          <td className="py-1 text-right mono">{rule?.n ?? 0}</td>
                          <td className="py-1 text-right mono" style={{ color: toneOf(rule?.shrunk_r) }}>{fmtCell(rule?.shrunk_r)}</td>
                          <td className="py-1 text-right mono">{jury?.n ?? 0}</td>
                          <td className="py-1 text-right mono" style={{ color: toneOf(jury?.shrunk_r) }}>{fmtCell(jury?.shrunk_r)}</td>
                          <td className="py-1 text-right mono text-[var(--text-4)]">{rr?.benched_until ? "benched" : `×${rr?.size_mult ?? 1}`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">Rule = the strategy&apos;s own shadow book, every setup taken with no jury. Jury = the desk&apos;s trades from the same rule after a sit. The gap between the two R columns is what the jury adds or costs. R is mean profit per unit of risk, shrunk toward zero for small samples; size is what the rule has earned.</p>
            </Card>
          )}

          {(["timeframe", "source", "exit"] as const).map((g) => {
            const cells = desk[g] as Record<string, CoachCell> | undefined;
            const entries = Object.entries(cells ?? {}).filter(([, x]) => x && x.n > 0).sort((a, b) => b[1].n - a[1].n);
            if (!entries.length) return null;
            return (
              <Card key={g} className="mt-2.5">
                <Eyebrow className="mb-1">{GROUP[g]}</Eyebrow>
                {entries.map(([k, x]) => (
                  <p key={k} className="text-[10.5px] py-1 border-t border-[var(--border-1)] flex items-baseline gap-2">
                    <span className="flex-1">{g === "exit" ? (EXIT[k] ?? k) : g === "source" ? (k === "sit" ? "intraday sits" : "nightly jury") : k}</span>
                    <span className="mono text-[var(--text-4)]">{x.n} · win {pct(x.hit)} · R <span style={{ color: toneOf(x.shrunk_r) }}>{fmtCell(x.shrunk_r)}</span> · {x.label}</span>
                  </p>
                ))}
              </Card>
            );
          })}

          {Object.keys(models).length > 0 && (
            <Card className="mt-2.5">
              <Eyebrow className="mb-1">By juror · with standing</Eyebrow>
              {Object.entries(models).sort((a, b) => (b[1].elo ?? 1500) - (a[1].elo ?? 1500)).map(([m, x]) => (
                <div key={m} className="py-1.5 border-t border-[var(--border-1)]">
                  <p className="text-[10.5px] flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: labTone(m) }} />
                    <span className="flex-1 min-w-0 truncate">{modelLabel(m)}{x.status === "cut" ? <span className="mono text-[9px] text-[var(--bad)] ml-1.5">cut</span> : null}</span>
                    <span className="mono text-[var(--text-4)]">{Math.round(x.elo ?? 1500)} elo · {x.n} trades · R {fmtCell(x.shrunk_r)} · Brier {x.brier === null || x.brier === undefined ? "—" : x.brier.toFixed(2)}{x.sits ? ` · ${x.sits} sits, right ${pct(x.sit_right)}` : ""}</span>
                  </p>
                  {x.standing && <p className="text-[10px] text-[var(--text-4)] mt-0.5 pl-3 leading-snug">{x.standing}</p>}
                </div>
              ))}
            </Card>
          )}

          {trades.length > 0 && (
            <Card className="mt-2.5">
              <Eyebrow className="mb-1">The trades the review read</Eyebrow>
              {trades.map((t, i) => (
                <p key={i} className="text-[10.5px] py-1 border-t border-[var(--border-1)] flex items-baseline gap-2">
                  <span className="mono font-semibold">{t.symbol}</span>
                  <span className="text-[var(--text-3)] flex-1 min-w-0 truncate">{t.side} · {t.strategy ? stratName(t.strategy) : t.source === "sit" ? "sit" : "nightly"} · {EXIT[t.exit] ?? t.exit}{t.quadrant ? ` · ${t.quadrant.replace("_", " ")}` : ""}</span>
                  <span className="mono" style={{ color: toneOf(t.r) }}>{fmtR(t.r)}</span>
                </p>
              ))}
              <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">The last trades, newest first, with the quadrant its micro review gave it. Open any of them under Journal.</p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
