"use client";

// Journal — every trade the desk took, as a lesson. At entry: the thesis and
// what each juror said. While it runs: where it stands at live prices. After
// it closes: what happened, why it happened, and whether the reasoning was
// sound apart from the money (the micro review, written from the tape, the
// headlines during the hold and the jury's own words). Every label explained.

import { useCallback, useEffect, useState } from "react";
import { Card, Pill } from "../ui";
import { loadTrades, loadSitVotes, callFn, REVIEW_FN, fmtMoney, fmtPct, fmtPrice, fmtR, modelLabel, labTone, type SitVotes } from "@/lib/desk/api";
import { unrealized } from "@/lib/desk/ledger";
import { STRATEGIES } from "@/lib/desk/scan";
import { templateName } from "@/lib/desk/playbook";
import type { Trade } from "@/lib/desk/types";
import type { LiveMarks } from "./DeskSpace";

type Filter = "all" | "running" | "closed";
const SOURCE: Record<string, string> = { sit: "intraday sit", nightly: "nightly jury", shadow: "shadow book" };
const TF: Record<string, string> = { scalp: "scalp · hours", swing: "swing · days", position: "position · weeks" };
const EXIT: Record<string, string> = { stop: "stopped out", target: "hit the target", time: "the clock ran out", thesis_broke: "the thesis broke", liquidated: "liquidated", halt: "halted", cancelled: "never filled" };
const QUADRANT: Record<string, string> = { earned: "earned it: good process, good outcome", bad_luck: "bad luck: good process, bad outcome", dumb_luck: "dumb luck: bad process, good outcome", deserved: "deserved: bad process, bad outcome" };
const stratName = (id?: string) => (id ? STRATEGIES.find((s) => s.id === id)?.name ?? id : "");
const tone = (v: number) => (v > 0 ? "var(--ok)" : v < 0 ? "var(--bad)" : "var(--text-3)");
const signed = (v: number, d = 0) => (v >= 0 ? "+" : "-") + fmtMoney(Math.abs(v), d);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const hoursBetween = (a: string | null, b: string | null) => (a && b ? (Date.parse(b) - Date.parse(a)) / 3_600_000 : null);
const asText = (v: unknown) => (typeof v === "string" ? v : "");

export default function Journal({ uid, live }: { uid: string; live: LiveMarks | null }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [juries, setJuries] = useState<Record<string, SitVotes>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewErr, setReviewErr] = useState("");

  const load = useCallback(async () => {
    const t = await loadTrades(uid, { owner: "desk", limit: 150 });
    setErr(t.error);
    if (!t.error) {
      setTrades(t.trades);
      const v = await loadSitVotes(t.trades.map((x) => x.sit_id).filter((x): x is string => !!x));
      if (!v.error) setJuries(v.votes);
    }
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function review(id: string, force: boolean) {
    if (busy) return;
    setBusy(id); setReviewErr("");
    const r = await callFn<{ review?: Record<string, unknown> }>(REVIEW_FN, { mode: "postmortem", trade_id: id, force }, 150_000);
    if (r.error) setReviewErr(r.error); else await load();
    setBusy(null);
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-14" /><div className="skeleton h-48 mt-3" /></div>;

  const kept = trades.filter((t) => t.status !== "cancelled");
  const shown = kept.filter((t) => filter === "all" ? true : filter === "running" ? t.status === "open" || t.status === "pending" : t.status === "closed");
  const closed = kept.filter((t) => t.status === "closed");
  const reviewed = closed.filter((t) => !!asText(t.review?.text)).length;

  return (
    <div className="pt-3">
      <Card>
        <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed">
          Every trade the desk took, newest first. Open one for the thesis it was taken on and what each juror said; once it closes, the micro review follows: what happened, why it happened, and whether the reasoning held apart from the money. The review is written at close from the tape, the headlines during the hold and the jury&apos;s own words, and its lesson is counted under Lessons.
        </p>
        <p className="mono text-[10px] text-[var(--text-4)] mt-2">{kept.length} trades · {closed.length} closed · {reviewed} reviewed</p>
      </Card>
      <div className="flex items-center gap-1.5 mt-3 overflow-x-auto no-scrollbar pb-1">
        {(["all", "running", "closed"] as Filter[]).map((f) => <Pill key={f} active={filter === f} onClick={() => setFilter(f)}>{f}</Pill>)}
      </div>
      {err && <button onClick={load} className="w-full mt-2 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">{err} — tap to retry</button>}
      {shown.length === 0 && <Card className="mt-2"><p className="text-[12px] text-[var(--text-3)] leading-relaxed">Nothing here yet. The first sit that wins its vote lands its trade here with the jury&apos;s reasoning attached.</p></Card>}
      <div className="mt-2 space-y-2">
        {shown.map((t) => (
          <Entry key={t.id} t={t} jury={t.sit_id ? juries[t.sit_id] : undefined} live={live} isOpen={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)}
            busy={busy === t.id} anyBusy={busy !== null} onReview={(force) => review(t.id, force)} err={open === t.id ? reviewErr : ""} />
        ))}
      </div>
    </div>
  );
}

function Entry({ t, jury, live, isOpen, onToggle, busy, anyBusy, onReview, err }: {
  t: Trade; jury?: SitVotes; live: LiveMarks | null; isOpen: boolean; onToggle: () => void; busy: boolean; anyBusy: boolean; onReview: (force: boolean) => void; err: string;
}) {
  const review = t.review ?? {};
  const text = asText(review.text), whatHappened = asText(review.what_happened), why = asText(review.why), verdict = asText(review.verdict), grade = asText(review.grade), quadrant = asText(review.quadrant), lesson = asText(review.lesson);
  const tags = Array.isArray(review.tags) ? (review.tags as string[]) : [];
  const running = t.status === "open" || t.status === "pending";
  const mark = live?.quotes[t.symbol]?.price;
  const filled = t.status === "open" && t.entry_price !== null;
  const u = filled && mark ? unrealized(t, mark) : null;
  const base = t.instrument === "crypto_perp" ? t.margin : t.notional;
  const held = hoursBetween(t.entry_at, t.exit_at);
  const votes = (jury?.votes ?? []).filter((v) => !v.error && v.stance);
  const ordered = [...votes.filter((v) => v.stance === "take"), ...votes.filter((v) => v.stance !== "take")];
  const status = t.status === "pending" ? "queued" : t.status === "open" ? "running" : "closed";
  return (
    <Card>
      <button onClick={onToggle} className="w-full text-left active:scale-[0.995]">
        <div className="flex items-baseline gap-2">
          <span className="mono text-sm font-bold">{t.symbol}</span>
          <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-4)] truncate">{t.side}{t.instrument === "crypto_perp" ? ` ${t.leverage}x` : ""} · {SOURCE[t.source ?? "nightly"]}{t.strategy ? ` · ${stratName(t.strategy)}` : t.template ? ` · ${templateName(t.template)}` : ""}</span>
          <span className="flex-1" />
          {t.status === "closed" ? (
            <span className="mono text-[12px] font-bold shrink-0" style={{ color: tone(t.pnl ?? 0) }}>{signed(t.pnl ?? 0)} <span className="text-[9px]">{fmtR(t.r_multiple ?? 0)}</span></span>
          ) : u !== null ? (
            <span className="mono text-[12px] font-bold shrink-0" style={{ color: tone(u) }}>{signed(u)} <span className="text-[9px]">({fmtPct(base > 0 ? u / base : 0)})</span></span>
          ) : (
            <span className="mono text-[10px] text-[var(--warn)] shrink-0">{status}</span>
          )}
        </div>
        <p className="mono text-[10px] text-[var(--text-4)] mt-1">
          {when(t.decided_at)} · {TF[t.timeframe ?? "swing"]}{t.horizon_hours ? ` · ${t.horizon_hours}h clock` : ` · ${t.horizon_days}d`}
          {t.status === "closed" ? ` · ${EXIT[t.exit_reason ?? ""] ?? t.exit_reason}${held !== null ? ` after ${held < 48 ? `${held.toFixed(1)}h` : `${(held / 24).toFixed(1)}d`}` : ""}${verdict ? ` · reasoning ${verdict}${grade ? ` · process ${grade}` : ""}` : " · not reviewed yet"}` : ` · ${status}`}
        </p>
        <p className="text-[11.5px] leading-snug mt-1.5 line-clamp-2">{t.thesis}</p>
      </button>
      {isOpen && (
        <div className="mt-2.5 pt-2.5 border-t border-[var(--border-1)] rise-in space-y-3">
          <div>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">Why it was taken</p>
            <p className="text-[12px] leading-relaxed">{t.thesis}</p>
            {t.catalyst && <p className="text-[11.5px] text-[var(--text-3)] mt-1 leading-snug"><span className="text-[var(--text-4)]">The setup:</span> {t.catalyst}</p>}
            <p className="text-[11.5px] text-[var(--text-3)] mt-1 leading-snug"><span className="text-[var(--text-4)]">Wrong if:</span> {t.falsifier}</p>
            <p className="mono text-[10px] text-[var(--text-4)] mt-1">ref {fmtPrice(t.entry_ref)} · stop {fmtPrice(t.stop)} · target {fmtPrice(t.target)} · {t.qty} {t.unit}{t.qty === 1 ? "" : "s"} · {fmtMoney(t.notional)} · risk {t.risk_pct}% · confidence {(t.confidence * 100).toFixed(0)}%</p>
            {ordered.length > 0 && (
              <div className="mt-2 space-y-1">
                <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">What the jury said</p>
                {ordered.map((v, i) => (
                  <p key={i} className="text-[11px] leading-snug flex items-start gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5" style={{ background: labTone(v.model) }} />
                    <span>
                      <span className="mono text-[9px]" style={{ color: v.stance === "take" ? "var(--ok)" : "var(--text-4)" }}>{v.stance} {(v.confidence * 100).toFixed(0)}%</span> <span className="text-[var(--text-3)]">{modelLabel(v.model)}:</span> {v.thesis}
                      {v.what_would_prove_me_wrong ? <span className="text-[var(--text-4)]"> Wrong if {v.what_would_prove_me_wrong}</span> : null}
                    </span>
                  </p>
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">{running ? "Where it stands" : "What happened"}</p>
            {running ? (
              <p className="mono text-[10.5px] text-[var(--text-2)] leading-relaxed">
                {filled ? `in at ${fmtPrice(t.entry_price as number)} ${when(t.entry_at)}` : `queued, ${t.fill_rule === "next_5m" ? "fills on the next 5-minute bar" : t.fill_rule === "next_hour" ? "fills on the next hourly candle" : "fills at the next open"}`}
                {mark ? ` · now ${fmtPrice(mark)}` : ""}{u !== null ? ` · ${signed(u)} open` : ""} · stop {fmtPrice(t.stop)} · target {fmtPrice(t.target)}{t.liq_price ? ` · liq ${fmtPrice(t.liq_price)}` : ""}
              </p>
            ) : (
              <>
                <p className="mono text-[10.5px] text-[var(--text-2)] leading-relaxed">
                  in {t.entry_price !== null ? fmtPrice(t.entry_price) : "—"} {when(t.entry_at)} → out {t.exit_price !== null ? fmtPrice(t.exit_price) : "—"} {when(t.exit_at)} · {EXIT[t.exit_reason ?? ""] ?? t.exit_reason}{t.ambiguous_bar ? " (both touched in one bar, stop assumed)" : ""}
                  <br />{signed(t.pnl ?? 0)} · {fmtR(t.r_multiple ?? 0)}{t.mae_r !== null ? ` · ${fmtR(t.mae_r)} against at worst, ${fmtR(t.mfe_r ?? 0)} for at best` : ""}{t.spy_entry && t.spy_exit ? ` · SPY ${fmtPct(t.spy_exit / t.spy_entry - 1)} over the same days` : ""} · fees {fmtMoney(t.fees, 2)}{t.instrument === "crypto_perp" ? ` · funding ${signed(-t.funding, 2)}` : ""}
                </p>
                {whatHappened && <p className="text-[12px] leading-relaxed mt-1.5">{whatHappened}</p>}
              </>
            )}
          </div>
          {!running && (
            <div>
              <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">Why it happened, and was the reasoning sound</p>
              {text ? (
                <div className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-3 space-y-1.5">
                  {why && <p className="text-[12px] leading-relaxed">{why}</p>}
                  <p className="mono text-[10px]" style={{ color: verdict === "held" ? "var(--ok)" : verdict === "broke" ? "var(--bad)" : "var(--warn)" }}>
                    reasoning {verdict || "unclear"}{grade ? ` · process ${grade}` : ""}{quadrant ? ` · ${QUADRANT[quadrant] ?? quadrant}` : ""}{tags.length ? ` · ${tags.join(", ")}` : ""}
                  </p>
                  <p className="text-[12px] leading-relaxed whitespace-pre-wrap">{text}</p>
                  {lesson && <p className="text-[11.5px] text-[var(--text-2)]"><span className="text-[var(--text-4)]">Lesson:</span> {lesson}</p>}
                  <button onClick={() => onReview(true)} disabled={anyBusy} className="mono text-[10px] text-[var(--text-4)] active:scale-95 disabled:opacity-50">{busy ? "rewriting…" : "rewrite the review"}</button>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <button onClick={() => onReview(false)} disabled={anyBusy} className="rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] text-xs font-semibold px-3 py-1.5 active:scale-95 disabled:opacity-50">{busy ? "Writing…" : "Write the review"}</button>
                  <span className="mono text-[9px] text-[var(--text-4)]">written at close by itself; this writes it now</span>
                </div>
              )}
              {err && <p className="text-[11px] text-orange-400 mt-1.5">{err}</p>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
