"use client";

// A team's book. What it is riding right now at live prices, then everything
// it has closed, newest first, with the exit said in words and the micro
// review that grades the thinking apart from the money. Every position and
// every closed trade can open its chart, and its ticket: the whole record of
// what the team was shown and what it decided.

import { useCallback, useEffect, useState } from "react";
import { Card } from "../ui";
import Chart from "./Chart";
import Ticket from "./Ticket";
import { MonoLabel, Note, signed, tone } from "./LeagueBits";
import { loadTrades, fmtMoney, fmtPct, fmtPrice, fmtR, type TeamRow } from "@/lib/desk/api";
import { unrealized } from "@/lib/desk/ledger";
import { STRATEGIES } from "@/lib/desk/scan";
import type { Trade } from "@/lib/desk/types";
import type { LiveMarks } from "./DeskSpace";

const EXIT: Record<string, string> = {
  stop: "stopped out", target: "hit the target", time: "the clock ran out", thesis_broke: "the frontier closed it",
  liquidated: "liquidated — the margin was gone", halt: "closed by the halt", cancelled: "never filled",
};
const QUADRANT: Record<string, string> = {
  earned: "earned it: good thinking, good outcome", bad_luck: "bad luck: good thinking, bad outcome",
  dumb_luck: "dumb luck: bad thinking, good outcome", deserved: "deserved it: bad thinking, bad outcome",
};
const INTERVAL: Record<string, "5m" | "15m" | "1h" | "4h" | "1d"> = { scalp: "15m", swing: "1h", position: "1d" };
const INSTR: Record<string, string> = { stock: "stock", etf: "ETF", crypto_spot: "spot", crypto_perp: "perp" };
const stratName = (id?: string) => (id ? STRATEGIES.find((s) => s.id === id)?.name ?? id : "");

function timeLeft(t: Trade, today: string): string {
  if (!t.expires_on) return "";
  const end = Date.parse(t.expires_on.length === 10 ? `${t.expires_on}T21:00:00Z` : t.expires_on);
  const now = Date.parse(`${today}T21:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(now)) return "";
  const d = Math.ceil((end - now) / 86_400_000);
  return d <= 0 ? "the clock is up" : d === 1 ? "1 day left on the clock" : `${d} days left on the clock`;
}

type Panel = "" | "chart" | "ticket";

export default function TeamBook({ uid, team, live, trades, today }: {
  uid: string; team: TeamRow; live: LiveMarks | null; trades: Trade[]; today: string;
}) {
  const [closed, setClosed] = useState<Trade[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [panel, setPanel] = useState<Record<string, Panel>>({});

  const load = useCallback(async () => {
    const r = await loadTrades(uid, { owner: `team:${team.id}`, status: ["closed"], limit: 100 });
    setErr(r.error);
    if (!r.error) setClosed(r.trades);
    setLoaded(true);
  }, [uid, team.id]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const toggle = (id: string, p: Panel) => setPanel((v) => ({ ...v, [id]: v[id] === p ? "" : p }));

  return (
    <div className="mt-3">
      <MonoLabel>Riding now</MonoLabel>
      {trades.length === 0 ? (
        <Note className="mt-1">Nothing open. The team only opens a position when its frontier says take, and it may hold none at all for days.</Note>
      ) : (
        <div className="mt-1.5 space-y-2">
          {trades.map((t) => {
            const mark = live?.quotes[t.symbol]?.price;
            const filled = t.status === "open" && t.entry_price !== null;
            const u = filled && mark ? unrealized(t, mark) : null;
            const base = t.instrument === "crypto_perp" ? t.margin : t.notional;
            const p = panel[t.id] ?? "";
            return (
              <div key={t.id} className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="mono text-[13px] font-bold">{t.symbol}</span>
                  <span className="mono text-[9px] uppercase tracking-wider text-[var(--text-4)]">
                    {t.side} · {INSTR[t.instrument]}{t.instrument === "crypto_perp" ? ` · ${t.leverage}x` : ""}{t.strategy ? ` · ${stratName(t.strategy)}` : ""}
                  </span>
                  <span className="flex-1" />
                  {u !== null ? (
                    <span className="mono text-[12px] font-bold" style={{ color: tone(u) }}>{signed(u)} <span className="text-[9px]">({fmtPct(base > 0 ? u / base : 0)})</span></span>
                  ) : (
                    <span className="mono text-[9px] text-[var(--warn)]">{t.status === "pending" ? "waiting for the fill" : "no live price"}</span>
                  )}
                </div>
                <p className="mono text-[10px] text-[var(--text-3)] mt-1">
                  entry {filled ? fmtPrice(t.entry_price as number) : `ref ${fmtPrice(t.entry_ref)}`} · <span style={{ color: "var(--bad)" }}>stop {fmtPrice(t.stop)}</span> · <span style={{ color: "var(--ok)" }}>target {fmtPrice(t.target)}</span>
                  {t.liq_price ? <> · <span className="text-[var(--warn)]">liq {fmtPrice(t.liq_price)}</span></> : null}
                  {mark ? ` · now ${fmtPrice(mark)}` : ""} · size {fmtMoney(t.notional)}
                </p>
                {timeLeft(t, today) ? <p className="mono text-[9px] text-[var(--text-4)] mt-0.5">{timeLeft(t, today)}</p> : null}
                {t.thesis && <p className="text-[11px] text-[var(--text-3)] mt-1 leading-snug">{t.thesis}</p>}
                <div className="flex items-center gap-3 mt-1.5">
                  <button onClick={() => toggle(t.id, "chart")} className="mono text-[10px] text-[var(--neon)] active:scale-95">{p === "chart" ? "hide the chart" : "chart"}</button>
                  {t.ticket ? <button onClick={() => toggle(t.id, "ticket")} className="mono text-[10px] text-[var(--neon)] active:scale-95">{p === "ticket" ? "hide the ticket" : "ticket"}</button> : null}
                  <span className="mono text-[9px] text-[var(--text-4)]">the ticket is everything that went into the trade</span>
                </div>
                {p === "chart" && (
                  <div className="mt-2 rise-in">
                    <Chart symbol={t.symbol} venue={t.venue} instrument={t.instrument} interval={INTERVAL[t.timeframe ?? "swing"] ?? "1h"}
                      levels={{ entry: t.entry_price ?? t.entry_ref, stop: t.stop, target: t.target, liq: t.liq_price }}
                      markers={t.entry_at ? [{ t: Date.parse(t.entry_at), kind: "entry", price: t.entry_price ?? t.entry_ref, label: `in at ${fmtPrice(t.entry_price ?? t.entry_ref)}` }] : []}
                      height={220} title={`${t.symbol} · the levels this team is holding`} />
                    <Note className="mt-1">The lines are the entry, the stop and the target the team set{t.liq_price ? ", and the price at which a perp would be liquidated" : ""}.</Note>
                  </div>
                )}
                {p === "ticket" && t.ticket ? <div className="mt-2 rise-in"><Ticket ticket={t.ticket} /></div> : null}
              </div>
            );
          })}
        </div>
      )}

      <MonoLabel className="mt-4">Closed</MonoLabel>
      {err && <button onClick={load} className="w-full mt-1 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2 active:scale-95">{err} — tap to retry</button>}
      {!loaded ? (
        <div className="skeleton h-16 mt-1.5" />
      ) : closed.length === 0 ? (
        <Note className="mt-1">Nothing closed yet. A trade closes when it hits its stop or its target, the clock runs out, or the frontier calls it off.</Note>
      ) : (
        <div className="mt-1.5 space-y-2">
          {closed.map((t) => {
            const review = t.review ?? {};
            const text = typeof review.text === "string" ? review.text : "";
            const grade = typeof review.grade === "string" ? review.grade : "";
            const quadrant = typeof review.quadrant === "string" ? review.quadrant : "";
            const lesson = typeof review.lesson === "string" ? review.lesson : "";
            const p = panel[t.id] ?? "";
            return (
              <div key={t.id} className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="mono text-[13px] font-bold">{t.symbol}</span>
                  <span className="mono text-[9px] uppercase tracking-wider text-[var(--text-4)]">{t.side}{t.instrument === "crypto_perp" ? ` ${t.leverage}x` : ""} · {EXIT[t.exit_reason ?? ""] ?? t.exit_reason ?? "closed"}</span>
                  <span className="flex-1" />
                  <span className="mono text-[12px] font-bold" style={{ color: tone(t.pnl ?? 0) }}>{signed(t.pnl ?? 0)}</span>
                  <span className="mono text-[10px]" style={{ color: tone(t.r_multiple ?? 0) }}>{fmtR(t.r_multiple ?? 0)}</span>
                </div>
                <p className="mono text-[10px] text-[var(--text-4)] mt-1">
                  in {t.entry_price !== null ? fmtPrice(t.entry_price) : "—"} · out {t.exit_price !== null ? fmtPrice(t.exit_price) : "—"}
                  {t.exit_at ? ` · ${new Date(t.exit_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
                  {t.strategy ? ` · ${stratName(t.strategy)}` : ""}
                </p>
                <Note className="mt-0.5">
                  R is the result in units of what the trade risked: {fmtR(t.r_multiple ?? 0)} means it {(t.r_multiple ?? 0) >= 0 ? "made" : "lost"} {Math.abs(t.r_multiple ?? 0).toFixed(2)} times the money that sat between its entry and its stop.
                </Note>
                {t.thesis && <p className="text-[11px] text-[var(--text-3)] mt-1 leading-snug">{t.thesis}</p>}
                {text ? (
                  <div className="mt-2 rounded-lg bg-black/20 border border-[var(--border-1)] p-2.5">
                    <MonoLabel>The review</MonoLabel>
                    <p className="text-[11.5px] leading-relaxed mt-1 whitespace-pre-wrap">{text}</p>
                    {grade || quadrant ? (
                      <p className="text-[10.5px] text-[var(--text-3)] mt-1.5 leading-snug">
                        {grade ? <>Process graded {grade}. </> : null}{quadrant ? QUADRANT[quadrant] ?? quadrant : ""}
                        {quadrant ? " — the money and the thinking are graded separately, because a good decision can still lose." : ""}
                      </p>
                    ) : null}
                    {lesson && <p className="text-[10.5px] text-[var(--text-2)] mt-1"><span className="text-[var(--text-4)]">Lesson: </span>{lesson}</p>}
                  </div>
                ) : null}
                <button onClick={() => toggle(t.id, "chart")} className="mono text-[10px] text-[var(--neon)] mt-1.5 active:scale-95">{p === "chart" ? "hide the chart" : "chart"}</button>
                {p === "chart" && (
                  <div className="mt-2 rise-in">
                    <Chart symbol={t.symbol} venue={t.venue} instrument={t.instrument} interval={INTERVAL[t.timeframe ?? "swing"] ?? "1h"}
                      levels={{ entry: t.entry_price ?? t.entry_ref, stop: t.stop, target: t.target, liq: t.liq_price }}
                      markers={[
                        ...(t.entry_at ? [{ t: Date.parse(t.entry_at), kind: "entry" as const, price: t.entry_price ?? t.entry_ref, label: `in at ${fmtPrice(t.entry_price ?? t.entry_ref)}` }] : []),
                        ...(t.exit_at ? [{ t: Date.parse(t.exit_at), kind: "exit" as const, price: t.exit_price ?? undefined, label: `${EXIT[t.exit_reason ?? ""] ?? "out"}${t.exit_price !== null ? ` at ${fmtPrice(t.exit_price)}` : ""}` }] : []),
                      ]}
                      height={220} title={`${t.symbol} · in and out`} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Card className="mt-3" tone="raised">
        <Note>Every book starts at {fmtMoney(team.start_equity)} of paper money and is marked with everyone else&apos;s. Fills, slippage, fees and funding are charged the same way on every team&apos;s trades, so the ranking is not an accident of accounting.</Note>
      </Card>
    </div>
  );
}
