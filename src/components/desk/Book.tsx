"use client";

// The Book — the ledger. Open positions at live prices, the equity curve
// against SPY, the numbers that say whether any of this works, and every
// closed trade with the post-mortem that grades the reasoning apart from
// the money. Every label is explained where it sits.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow, SectionTitle, Sparkline } from "../ui";
import { loadTrades, callFn, REVIEW_FN, fmtMoney, fmtPct, fmtPrice, fmtR, type Account, type EquityPoint } from "@/lib/desk/api";
import { unrealized, COSTS } from "@/lib/desk/ledger";
import { tradeStats, curveStats, tradesToDetect } from "@/lib/desk/stats";
import { templateName } from "@/lib/desk/playbook";
import { STRATEGIES } from "@/lib/desk/scan";
import type { Trade } from "@/lib/desk/types";
import type { LiveMarks } from "./DeskSpace";

const VENUE: Record<string, string> = { robinhood: "Robinhood", blofin: "BloFin" };
const INSTR: Record<string, string> = { stock: "stock", etf: "ETF", crypto_spot: "spot", crypto_perp: "perp" };
const QUADRANT: Record<string, string> = { earned: "earned it: good process, good outcome", bad_luck: "bad luck: good process, bad outcome", dumb_luck: "dumb luck: bad process, good outcome", deserved: "deserved: bad process, bad outcome" };
const EXIT: Record<string, string> = { stop: "stopped out", target: "hit target", time: "time stop", thesis_broke: "thesis broke", liquidated: "liquidated", halt: "halted", cancelled: "never filled" };
const SOURCE: Record<string, string> = { sit: "from a sit", nightly: "from the nightly jury", shadow: "shadow book" };
const TF: Record<string, string> = { scalp: "scalp · hours", swing: "swing · days", position: "position · weeks" };
const stratName = (id: string) => STRATEGIES.find((s) => s.id === id)?.name ?? id;
const tone = (v: number) => (v > 0 ? "var(--ok)" : v < 0 ? "var(--bad)" : "var(--text-3)");
const signed = (v: number, d = 0) => (v >= 0 ? "+" : "-") + fmtMoney(Math.abs(v), d);

function daysLeft(t: Trade, today: string): string {
  if (!t.expires_on) return "";
  const end = t.expires_on.length === 10 ? Date.parse(t.expires_on + "T21:00:00Z") : Date.parse(t.expires_on);
  const now = Date.parse(today + "T21:00:00Z");
  const d = Math.ceil((end - now) / 86_400_000);
  return d <= 0 ? "time stop due" : `${d}d left`;
}

export default function Book({ uid, account, curve, live, today, onRefresh }: {
  uid: string; account: Account; curve: EquityPoint[]; live: LiveMarks | null; today: string; onRefresh: () => void;
}) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [pmBusy, setPmBusy] = useState<string | null>(null);
  const [pmErr, setPmErr] = useState("");

  const load = useCallback(async () => {
    const r = await loadTrades(uid, { owner: "desk", limit: 300 });
    setErr(r.error);
    if (!r.error) setTrades(r.trades);
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function writePostmortem(id: string, force: boolean) {
    if (pmBusy) return;
    setPmBusy(id); setPmErr("");
    const r = await callFn<{ review?: Record<string, unknown> }>(REVIEW_FN, { mode: "postmortem", trade_id: id, force }, 150_000);
    if (r.error) setPmErr(r.error);
    else await load();
    setPmBusy(null);
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-28" /><div className="skeleton h-40 mt-3" /></div>;

  const open = trades.filter((t) => t.status === "open" || t.status === "pending");
  const closed = trades.filter((t) => t.status === "closed");
  const ts = tradeStats(closed);
  const cs = curveStats(curve.map((p) => p.equity));
  const deskLive = live?.marks.find((m) => m.owner === "desk");
  const equityNow = deskLive?.equity ?? account.equity;
  const gross = deskLive?.gross ?? (curve[curve.length - 1]?.gross_exposure ?? 0) * equityNow;
  const first = closed.length ? closed[closed.length - 1] : null;
  const weeks = first?.entry_at ? Math.max(1, (Date.parse(today + "T21:00:00Z") - Date.parse(first.entry_at)) / (7 * 86_400_000)) : 1;

  const spyNorm = curve.length >= 2 && curve[0].spy_close ? curve.map((p) => (p.spy_close ? (account.starting_equity * p.spy_close) / (curve[0].spy_close as number) : account.starting_equity)) : [];

  return (
    <div>
      {err && (
        <button onClick={load} className="w-full mt-3 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">
          {err} — tap to retry
        </button>
      )}

      {/* ── open positions ─────────────────────────────────────────── */}
      <SectionTitle>Open positions</SectionTitle>
      {open.length === 0 ? (
        <Card><p className="text-[13px] text-[var(--text-3)] leading-relaxed">
          Nothing open. Sits run every five minutes on what the scan flags and the nightly jury sits at 9:30pm ET. A sit&apos;s order fills on the next 5-minute bar; a nightly stock order at the next open, nightly crypto at the next hourly candle.
        </p></Card>
      ) : (
        <div className="space-y-2.5">
          {open.map((t) => {
            const mark = live?.quotes[t.symbol]?.price;
            const filled = t.status === "open" && t.entry_price !== null;
            const u = filled && mark ? unrealized(t, mark) : null;
            const base = t.instrument === "crypto_perp" ? t.margin : t.notional;
            const isOpen = openId === t.id;
            return (
              <Card key={t.id}>
                <button onClick={() => setOpenId(isOpen ? null : t.id)} className="w-full text-left active:scale-[0.995]">
                  <div className="flex items-baseline gap-2">
                    <span className="mono text-sm font-bold">{t.symbol}</span>
                    <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-4)]">
                      {VENUE[t.venue]} · {INSTR[t.instrument]} · {t.side}{t.side === "short" ? " · paper" : ""}{t.instrument === "crypto_perp" ? ` · ${t.leverage}x` : ""}
                    </span>
                    <span className="flex-1" />
                    {u !== null ? (
                      <span className="mono text-[13px] font-bold" style={{ color: tone(u) }}>{signed(u)} <span className="text-[10px]">({fmtPct(base > 0 ? u / base : 0)})</span></span>
                    ) : (
                      <span className="mono text-[10px] text-[var(--warn)]">{t.status === "pending" ? (t.fill_rule === "next_5m" ? "fills next 5-min bar" : t.fill_rule === "next_hour" ? "fills next hour" : "fills at next open") : "no live price"}</span>
                    )}
                  </div>
                  <p className="mono text-[11px] text-[var(--text-3)] mt-1.5">
                    {t.qty} {t.unit}{t.qty === 1 ? "" : "s"} · entry {filled ? fmtPrice(t.entry_price as number) : `ref ${fmtPrice(t.entry_ref)}`} ·{" "}
                    <span style={{ color: "var(--bad)" }}>stop {fmtPrice(t.stop)}</span> · <span style={{ color: "var(--ok)" }}>target {fmtPrice(t.target)}</span>
                    {t.liq_price ? <> · <span className="text-[var(--warn)]">liq {fmtPrice(t.liq_price)}{mark ? ` (${fmtPct(t.liq_price / mark - 1)})` : ""}</span></> : null}
                    {filled ? ` · ${daysLeft(t, today)}` : ""}
                  </p>
                  <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-1">{SOURCE[t.source ?? "nightly"]}{t.strategy ? ` · ${stratName(t.strategy)}` : ""} · {TF[t.timeframe ?? "swing"]}{t.horizon_hours ? ` · ${t.horizon_hours}h clock` : ""}</p>
                  {t.catalyst && <p className="text-[11.5px] text-[var(--text-3)] mt-1.5 leading-snug">{t.catalyst}</p>}
                </button>
                {isOpen && (
                  <div className="mt-2.5 pt-2.5 border-t border-[var(--border-1)] rise-in space-y-1.5">
                    <p className="text-[12.5px] leading-relaxed">{t.thesis}</p>
                    <p className="text-[11.5px] text-[var(--text-3)] leading-snug"><span className="text-[var(--text-4)]">Wrong if:</span> {t.falsifier}</p>
                    <p className="mono text-[10px] text-[var(--text-4)]">
                      template {t.template || "none"} · {templateName(t.template)} · confidence {(t.confidence * 100).toFixed(0)}% · horizon {t.horizon_days}d
                    </p>
                    <p className="mono text-[10px] text-[var(--text-4)]">
                      notional {fmtMoney(t.notional)}{t.instrument === "crypto_perp" ? ` · margin ${fmtMoney(t.margin)}` : ""} · fees {fmtMoney(t.fees, 2)}
                      {t.instrument === "crypto_perp" ? ` · funding paid ${signed(-t.funding, 2)}` : ""} · slippage {t.slippage_bps} bps
                      {t.entry_at ? ` · filled ${new Date(t.entry_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
                    </p>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ── equity ─────────────────────────────────────────────────── */}
      <SectionTitle>Equity</SectionTitle>
      <Card>
        {curve.length >= 2 ? (
          <>
            <Sparkline series={[
              ...(spyNorm.length ? [{ values: spyNorm, color: "var(--text-4)", width: 1.2, opacity: 0.8 }] : []),
              { values: curve.map((p) => p.equity), color: "var(--neon)", width: 1.8 },
            ]} goal={account.starting_equity} height={64} />
            <p className="text-[10px] text-[var(--text-4)] mt-2 leading-relaxed">
              Purple is the desk. Grey is what the same starting money would be worth sitting in SPY, marked on the same days. The dashed line is where it started.
              {" "}Being up in a market that rose more is not skill.
            </p>
          </>
        ) : (
          <p className="text-[12px] text-[var(--text-3)] leading-relaxed">The curve starts after the first 4pm mark. It is drawn against SPY from the same day, so a green number in a rising market gets no credit it did not earn.</p>
        )}
      </Card>

      {/* ── stats ──────────────────────────────────────────────────── */}
      <SectionTitle>Is any of this working?</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Win rate" value={ts.winRate === null ? "—" : `${(ts.winRate * 100).toFixed(0)}%`} note={`Closed trades that made money. ${ts.n} closed so far.`} />
        <Stat label="Expectancy" value={ts.expectancyR === null ? "—" : `${fmtR(ts.expectancyR)}`} sub={ts.expectancyUsd === null ? "" : signed(ts.expectancyUsd)} note="Average result per trade in R, where 1R is the distance from entry to the stop. Positive means the average trade makes money." />
        <Stat label="Profit factor" value={ts.profitFactor === null ? "—" : ts.profitFactor.toFixed(2)} note="Gross wins divided by gross losses. Above 1.5 is healthy; below 1 is losing." />
        <Stat label="Sharpe" value={cs.sharpeDaily === null ? "—" : cs.sharpeDaily.toFixed(2)} sub={cs.sharpeAnnual === null ? "" : `${cs.sharpeAnnual.toFixed(2)} annualised`} note="Return per unit of wobble on the daily equity curve. Needs months of days before it means much." />
        <Stat label="Max drawdown" value={curve.length ? fmtPct(-cs.maxDrawdown) : "—"} sub={cs.ddDays ? `${cs.ddDays} days under water` : ""} note="The worst peak-to-trough fall in equity so far, and the longest stretch below the previous high." />
        <Stat label="Exposure" value={fmtPct(equityNow > 0 ? gross / equityNow : 0).replace("+", "")} note="Sum of open position notionals as a share of equity. Perps count their full notional, not just the margin." />
        <Stat label="Average hold" value={ts.avgHoldDays === null ? "—" : `${ts.avgHoldDays.toFixed(1)}d`} note="Days from fill to exit, averaged over closed trades." />
        <Stat label="Trades per week" value={closed.length ? (closed.length / weeks).toFixed(1) : "—"} note="Closed trades divided by weeks since the first fill. Scalps, swings and positions all count, so this runs well above the old one-jury-a-night pace." />
        <Stat label="Trades to a first verdict" value={`${closed.length} of 100`} note={`About 100 closed trades before hit rate means anything; about ${tradesToDetect(0.6)} to tell 60% from a coin flip. Until then every number above is weather, not climate.`} wide />
      </div>

      {/* ── closed trades ──────────────────────────────────────────── */}
      {closed.length > 0 && (
        <>
          <SectionTitle>Closed — and what each one taught</SectionTitle>
          <div className="space-y-2.5">
            {closed.map((t) => {
              const isOpen = openId === t.id;
              const review = t.review ?? {};
              const grade = typeof review.grade === "string" ? review.grade : "";
              const verdict = typeof review.verdict === "string" ? review.verdict : "";
              const tags = Array.isArray(review.tags) ? (review.tags as string[]) : [];
              const text = typeof review.text === "string" ? review.text : "";
              return (
                <Card key={t.id}>
                  <button onClick={() => setOpenId(isOpen ? null : t.id)} className="w-full text-left active:scale-[0.995]">
                    <div className="flex items-baseline gap-2">
                      <span className="mono text-sm font-bold">{t.symbol}</span>
                      <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-4)]">{t.side}{t.instrument === "crypto_perp" ? ` ${t.leverage}x` : ""} · {EXIT[t.exit_reason ?? ""] ?? t.exit_reason}{t.strategy ? ` · ${stratName(t.strategy)}` : t.source === "sit" ? " · sit" : ""}{t.ambiguous_bar ? " · both touched, stop assumed" : ""}</span>
                      <span className="flex-1" />
                      <span className="mono text-[13px] font-bold" style={{ color: tone(t.pnl ?? 0) }}>{signed(t.pnl ?? 0)}</span>
                      <span className="mono text-[10px]" style={{ color: tone(t.r_multiple ?? 0) }}>{fmtR(t.r_multiple ?? 0)}</span>
                    </div>
                    <p className="text-[11.5px] text-[var(--text-3)] mt-1 leading-snug">{t.catalyst || t.thesis}</p>
                    {(grade || verdict) && (
                      <p className="mono text-[10px] mt-1" style={{ color: verdict === "held" ? "var(--ok)" : verdict === "broke" ? "var(--bad)" : "var(--warn)" }}>
                        reasoning {verdict || "ungraded"}{grade ? ` · process ${grade}` : ""}{tags.length ? ` · ${tags.join(", ")}` : ""}
                      </p>
                    )}
                  </button>
                  {isOpen && (
                    <div className="mt-2.5 pt-2.5 border-t border-[var(--border-1)] rise-in space-y-1.5">
                      <p className="text-[12.5px] leading-relaxed">{t.thesis}</p>
                      <p className="text-[11.5px] text-[var(--text-3)]"><span className="text-[var(--text-4)]">Wrong if:</span> {t.falsifier}</p>
                      <p className="mono text-[10px] text-[var(--text-4)]">
                        entry {t.entry_price !== null ? fmtPrice(t.entry_price) : "—"} · exit {t.exit_price !== null ? fmtPrice(t.exit_price) : "—"} · stop {fmtPrice(t.stop)} · target {fmtPrice(t.target)}
                        {t.exit_at ? ` · closed ${new Date(t.exit_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
                        {t.spy_entry && t.spy_exit ? ` · SPY ${fmtPct(t.spy_exit / t.spy_entry - 1)} over the same days` : ""}
                        {t.mae_r !== null ? ` · worst ${fmtR(t.mae_r)} · best ${fmtR(t.mfe_r ?? 0)}` : ""}
                      </p>
                      {text ? (
                        <div className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-3">
                          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1.5">Post-mortem{typeof review.quadrant === "string" && review.quadrant ? ` · ${QUADRANT[String(review.quadrant)] ?? review.quadrant}` : ""}</p>
                          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap">{text}</p>
                          {typeof review.lesson === "string" && review.lesson && <p className="text-[11.5px] text-[var(--text-2)] mt-2"><span className="text-[var(--text-4)]">Lesson:</span> {review.lesson}</p>}
                          <button onClick={() => writePostmortem(t.id, true)} disabled={pmBusy !== null} className="mono text-[10px] text-[var(--text-4)] mt-2 active:scale-95 disabled:opacity-50">{pmBusy === t.id ? "rewriting…" : "rewrite the post-mortem"}</button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <button onClick={() => writePostmortem(t.id, false)} disabled={pmBusy !== null} className="rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] text-xs font-semibold px-3 py-1.5 active:scale-95 disabled:opacity-50">{pmBusy === t.id ? "Writing…" : "Write the post-mortem"}</button>
                          <span className="mono text-[9px] text-[var(--text-4)]">grades the reasoning apart from the money</span>
                        </div>
                      )}
                      {pmErr && pmBusy === null && openId === t.id && <p className="text-[11px] text-orange-400">{pmErr}</p>}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* ── how the ledger works ───────────────────────────────────── */}
      <SectionTitle>How the ledger works</SectionTitle>
      <Card>
        <Eyebrow className="mb-2">The rules that keep it honest</Eyebrow>
        <ul className="text-[11.5px] text-[var(--text-2)] leading-relaxed space-y-1.5 list-disc pl-4">
          <li>A sit&apos;s order fills on the <b>next 5-minute bar</b> (a stock after hours waits for the next session&apos;s first bar). A nightly decision fills at the <b>next session&apos;s open</b> for stocks, or the <b>next hourly candle</b> for crypto. Never at the price the models saw.</li>
          <li>Slippage against you on every fill: {COSTS.slip_bps.stock_large} bps on large stocks and ETFs, {COSTS.slip_bps.stock_other} bps on smaller ones (doubled when the stock gapped more than {COSTS.gap_doubling * 100}%), {COSTS.slip_bps.crypto_major} bps on BTC/ETH/SOL perps, {COSTS.slip_bps.crypto_alt} bps on other coins, {COSTS.spread_bps.crypto_spot} bps spread on Robinhood spot crypto.</li>
          <li>Fees: $0 stock commissions but the SEC fee ({(COSTS.sec_fee * 10000).toFixed(2)} bps) and FINRA fee (${COSTS.taf_per_share}/share, capped ${COSTS.taf_cap}) on every sale; BloFin perps pay {COSTS.perp_taker * 100}% taker each way and funding every 8 hours at the live rate.</li>
          <li>Stops fill at the <b>gap price</b> when a bar opens through them. A bar that touches both the stop and the target counts as the stop.</li>
          <li>Perps liquidate at {(COSTS.maint_margin * 100).toFixed(1)}% maintenance margin; the margin is gone. The guardrail keeps every stop inside the liquidation price, so a liquidation means a rule was wrong.</li>
          <li>Shorts on stocks are marked &ldquo;paper&rdquo; because Robinhood cannot short; the real-world equivalent is a put or an inverse ETF.</li>
          <li>Equity is marked at 4pm ET every day, open positions at that moment&apos;s prices, and drawn against SPY from the same start.</li>
        </ul>
        <button onClick={onRefresh} className="mono text-[10px] text-[var(--neon)] mt-3 active:scale-95">refresh prices</button>
      </Card>
    </div>
  );
}

function Stat({ label, value, sub, note, wide }: { label: string; value: string; sub?: string; note: string; wide?: boolean }) {
  return (
    <div className={`rounded-xl border border-[var(--border-1)] bg-[var(--card)] p-3 ${wide ? "col-span-2" : ""}`}>
      <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">{label}</p>
      <p className="mono text-[20px] font-bold leading-tight mt-1">{value}{sub ? <span className="text-[11px] font-semibold text-[var(--text-3)] ml-1.5">{sub}</span> : null}</p>
      <p className="text-[10px] text-[var(--text-4)] mt-1 leading-relaxed">{note}</p>
    </div>
  );
}
