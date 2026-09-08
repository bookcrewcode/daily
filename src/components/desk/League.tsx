"use client";

// The League — the jurors against each other. Every model runs a shadow
// book: $100k, its own top pick each night, sized by the same rules as the
// desk. Elo comes from head-to-head matches (opposite sides of the same
// symbol, or a trade against a juror who abstained on it); Brier scores the
// stated confidence against what happened. Thin samples say so on screen.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow, SectionTitle } from "../ui";
import { loadRatings, loadTrades, loadLatestEquity, fmtMoney, fmtPct, fmtPrice, modelLabel, labTone, type Account, type Rating } from "@/lib/desk/api";
import { shrink, CALIB_BINS } from "@/lib/desk/stats";
import type { Trade } from "@/lib/desk/types";
import type { LiveMarks } from "./DeskSpace";

const SHADOW_START = 100000;
const tone = (v: number) => (v > 0 ? "var(--ok)" : v < 0 ? "var(--bad)" : "var(--text-3)");

type Row = { model: string; r: Rating | null; equity: number; onRoster: boolean; riding: Trade[] };

export default function League({ uid, account, live }: { uid: string; account: Account; live: LiveMarks | null }) {
  const [ratings, setRatings] = useState<Rating[]>([]);
  const [open, setOpen] = useState<Trade[]>([]);
  const [eq, setEq] = useState<Record<string, { day: string; equity: number }>>({});
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, t, e] = await Promise.all([loadRatings(uid), loadTrades(uid, { status: ["pending", "open"], limit: 200 }), loadLatestEquity(uid)]);
    setErr(r.error || t.error || e.error);
    if (!r.error) setRatings(r.ratings);
    if (!t.error) setOpen(t.trades.filter((x) => x.owner !== "desk"));
    if (!e.error) setEq(e.latest);
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  if (!loaded) return <div className="pt-3"><div className="skeleton h-20" /><div className="skeleton h-48 mt-3" /></div>;

  const roster = account.roster;
  const rated = new Map(ratings.map((r) => [r.model, r]));
  const anyRated = ratings.some((r) => r.n_trades >= 10);
  const weightOf = (m: string) => { const r = rated.get(m); if (!anyRated) return 1; return r && r.n_trades >= 10 ? Math.max(0.25, (r.elo - 1400) / 200) : 0.5; };
  const equityOf = (m: string) => live?.marks.find((x) => x.owner === m)?.equity ?? eq[m]?.equity ?? SHADOW_START;
  const models = [...new Set([...roster, ...ratings.map((r) => r.model)])];
  const rows: Row[] = models
    .map((m) => ({ model: m, r: rated.get(m) ?? null, equity: equityOf(m), onRoster: roster.includes(m), riding: open.filter((t) => t.owner === m) }))
    .sort((a, b) => (b.r?.elo ?? 1500) - (a.r?.elo ?? 1500) || b.equity - a.equity || modelLabel(a.model).localeCompare(modelLabel(b.model)));
  const closedTotal = ratings.reduce((a, r) => a + r.n_trades, 0);

  return (
    <div className="pt-3">
      {err && <p className="text-[11px] text-orange-400 mb-2">{err}</p>}
      <Card>
        <Eyebrow className="mb-1.5">Standings</Eyebrow>
        <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed">
          {rows.length} models, each with a {fmtMoney(SHADOW_START)} shadow book that takes its own top pick every night under the desk&apos;s rules. Ranked by Elo, then by shadow equity.
          {closedTotal < 20 ? ` ${closedTotal} scored trades so far: nothing here means much before about 20 per model.` : ""}
          {live ? " Shadow equity is live." : " Shadow equity is the last 4pm mark."}
        </p>
      </Card>

      <div className="mt-3 space-y-2">
        {rows.map((row, i) => {
          const r = row.r;
          const n = r?.n_trades ?? 0;
          const hit = r && n > 0 ? r.n_wins / n : null;
          const meanR = r && n > 0 ? shrink(r.sum_r / n, n) : null;
          const isOpen = expanded === row.model;
          const pnl = row.equity - SHADOW_START;
          return (
            <Card key={row.model} className={row.onRoster ? "" : "opacity-60"}>
              <button onClick={() => setExpanded(isOpen ? null : row.model)} className="w-full text-left active:scale-[0.995]">
                <div className="flex items-center gap-2">
                  <span className="mono text-[11px] text-[var(--text-4)] w-4 shrink-0">{i + 1}</span>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: labTone(row.model) }} />
                  <span className="text-[13px] font-semibold flex-1 min-w-0 truncate">
                    {modelLabel(row.model)}{!row.onRoster && <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] ml-2">retired</span>}
                  </span>
                  <span className="mono text-[14px] font-bold">{Math.round(r?.elo ?? 1500)}</span>
                  <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">elo</span>
                </div>
                <div className="flex items-baseline gap-3 mt-1.5 pl-6">
                  <span className="mono text-[12px] font-semibold" style={{ color: tone(pnl) }}>{fmtMoney(row.equity)} <span className="text-[10px]">({fmtPct(pnl / SHADOW_START)})</span></span>
                  <span className="mono text-[10px] text-[var(--text-4)]">
                    {n} scored · win {hit === null ? "—" : `${(hit * 100).toFixed(0)}%`} · R {meanR === null ? "—" : `${meanR >= 0 ? "+" : ""}${meanR.toFixed(2)}`} · Brier {r?.brier === null || r?.brier === undefined ? "—" : r.brier.toFixed(2)}
                  </span>
                </div>
                {row.riding.map((t) => (
                  <p key={t.id} className="mono text-[10px] text-[var(--text-3)] mt-1 pl-6">
                    riding {t.symbol} {t.side}{t.instrument === "crypto_perp" ? ` ${t.leverage}x` : ""} · {t.status === "pending" ? "waiting for the fill" : `in at ${fmtPrice(t.entry_price ?? t.entry_ref)}`} · stop {fmtPrice(t.stop)} · target {fmtPrice(t.target)}
                  </p>
                ))}
              </button>
              {isOpen && (
                <div className="mt-2.5 pt-2.5 border-t border-[var(--border-1)] rise-in">
                  <div className="grid grid-cols-3 gap-2">
                    <Mini label="Matches" value={String(r?.n_matches ?? 0)} note="Head-to-head Elo matches so far." />
                    <Mini label="Abstained" value={String(r?.n_abstain ?? 0)} note="Nights it voted abstain on a trade that was then taken." />
                    <Mini label="Vote weight" value={weightOf(row.model).toFixed(2)} note={anyRated ? "From Elo once a model has 10 scored trades; 0.5 before." : "Equal until any model has 10 scored trades."} />
                  </div>
                  <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-3 mb-1">Calibration · said vs happened</p>
                  <div className="grid grid-cols-6 gap-1">
                    {CALIB_BINS.map((b) => {
                      const c = r?.calib.find((x) => x.bin === b);
                      return (
                        <div key={b} className="rounded-md bg-[var(--raised)] border border-[var(--border-1)] px-1 py-1.5 text-center">
                          <p className="mono text-[8px] text-[var(--text-4)]">{b}</p>
                          <p className="mono text-[11px] font-semibold mt-0.5">{c && c.n > 0 && c.hit !== null ? `${(c.hit * 100).toFixed(0)}%` : "—"}</p>
                          <p className="mono text-[8px] text-[var(--text-4)]">{c?.n ?? 0}</p>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">
                    Each column is a band of stated confidence; the big number is how often those trades actually hit, the small one how many there were. A calibrated model reads like a diagonal. {n < 20 ? "Too few to trust yet." : ""}
                  </p>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <SectionTitle>How the League scores</SectionTitle>
      <Card>
        <ul className="text-[11.5px] text-[var(--text-2)] leading-relaxed space-y-1.5 list-disc pl-4">
          <li><b>Shadow book</b>: every night each juror&apos;s highest-confidence proposal is filled, sized and exited by the same ledger as the desk, in its own {fmtMoney(SHADOW_START)} account. The desk only takes what the room voted through; the shadow books show what each model would have done alone.</li>
          <li><b>Elo</b> starts at 1500. Two jurors on opposite sides of the same symbol play a match when both trades close; the better R wins. A juror who abstained plays the trade it abstained on: it wins if the trade lost. K is 32 for the first 30 matches, then 16.</li>
          <li><b>Brier</b> is the average squared gap between stated confidence and the outcome (1 for a target hit, 0 for a stop). 0 is perfect, 0.25 is a coin flip with no idea, above 0.25 is worse than saying 50% every time.</li>
          <li><b>R</b> is profit in units of the risk taken: +2R means the trade made twice what it risked. The mean shown is shrunk toward zero for small samples, so a lucky first week reads as roughly zero, not as genius.</li>
          <li><b>Vote weight</b> is what a juror&apos;s support or opposition counts for in the tally. Equal for everyone until a model has 10 scored trades; then a 1600 Elo counts 1.0, a 1500 counts 0.5, and nothing goes below 0.25.</li>
          <li>Ratings only move when a trade closes, so this page changes slowly on purpose.</li>
        </ul>
        <button onClick={load} className="mono text-[10px] text-[var(--neon)] mt-3 active:scale-95">refresh</button>
      </Card>
    </div>
  );
}

function Mini({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-2">
      <p className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)]">{label}</p>
      <p className="mono text-[15px] font-bold leading-tight mt-0.5">{value}</p>
      <p className="text-[9px] text-[var(--text-4)] mt-0.5 leading-snug">{note}</p>
    </div>
  );
}
