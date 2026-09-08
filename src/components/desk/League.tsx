"use client";

// The League — the jurors against each other, and against the standard. Every
// nightly juror runs a shadow book ($100k, its own top pick each night); every
// sit juror is scored on each take-or-pass vote. Elo comes from head-to-head
// matches, Brier from stated confidence against what happened. A seat is kept
// by performing: below the standard is cut, the bench fills the seat, and the
// log here says who went and why. Thin samples say so on screen.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow, SectionTitle } from "../ui";
import { loadRatings, loadTrades, loadLatestEquity, loadStrategies, loadRosterLog, callFn, REVIEW_FN, fmtMoney, fmtPct, fmtPrice, modelLabel, labTone, type Account, type Rating, type StrategyRow, type RosterLogRow } from "@/lib/desk/api";
import { shrink, CALIB_BINS, DEFAULT_CUT_RULES } from "@/lib/desk/stats";
import { STRATEGIES } from "@/lib/desk/scan";
import { sfx, buzz } from "@/lib/fx";
import type { Trade } from "@/lib/desk/types";
import type { LiveMarks } from "./DeskSpace";

const SHADOW_START = 100000;
const tone = (v: number) => (v > 0 ? "var(--ok)" : v < 0 ? "var(--bad)" : "var(--text-3)");
const STANDING_COLOR: Record<string, string> = { fresh: "var(--text-4)", "meeting the standard": "var(--ok)", "on notice": "var(--warn)", cut: "var(--bad)" };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

type Row = { model: string; r: Rating | null; equity: number; seats: string[]; cut: boolean; riding: Trade[] };

export default function League({ uid, account, live, onChanged }: { uid: string; account: Account; live: LiveMarks | null; onChanged: () => void }) {
  const [ratings, setRatings] = useState<Rating[]>([]);
  const [open, setOpen] = useState<Trade[]>([]);
  const [eq, setEq] = useState<Record<string, { day: string; equity: number }>>({});
  const [strategies, setStrategies] = useState<StrategyRow[]>([]);
  const [log, setLog] = useState<RosterLogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const [r, t, e, g, l] = await Promise.all([loadRatings(uid), loadTrades(uid, { status: ["pending", "open"], limit: 200 }), loadLatestEquity(uid), loadStrategies(uid), loadRosterLog(uid, 20)]);
    setErr(r.error || t.error || e.error || g.error || l.error);
    if (!r.error) setRatings(r.ratings);
    if (!t.error) setOpen(t.trades.filter((x) => x.owner !== "desk"));
    if (!e.error) setEq(e.latest);
    if (!g.error) setStrategies(g.strategies);
    if (!l.error) setLog(l.log);
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function applyStandard() {
    if (busy) return;
    setBusy(true); setNote("");
    const r = await callFn<{ changes?: unknown[] }>(REVIEW_FN, { mode: "roster" }, 120_000);
    if (r.error) setNote(r.error);
    else {
      const n = Array.isArray(r.changes) ? r.changes.length : 0;
      setNote(n ? `${n} change${n === 1 ? "" : "s"} made; see the log below.` : "Every seat meets the standard, or has not reached its sample yet.");
      sfx.coin(); buzz(8);
      await load(); onChanged();
    }
    setBusy(false);
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-20" /><div className="skeleton h-48 mt-3" /></div>;

  const roster = account.roster, sitRoster = account.sit_roster;
  const rated = new Map(ratings.map((r) => [r.model, r]));
  // A vote carries a model's Elo once it has a record: ten shadow trades or twenty scored sits.
  const hasRecord = (r: Rating | null | undefined) => !!r && (r.n_trades >= 10 || r.n_sits >= 20);
  const anyRated = ratings.some((r) => hasRecord(r));
  const weightOf = (m: string) => { const r = rated.get(m); if (!anyRated) return 1; return hasRecord(r) ? Math.max(0.25, ((r as Rating).elo - 1400) / 200) : 0.5; };
  const equityOf = (m: string) => live?.marks.find((x) => x.owner === m)?.equity ?? eq[m]?.equity ?? SHADOW_START;
  const models = [...new Set([...roster, ...sitRoster, ...ratings.map((r) => r.model)])].filter((m) => !m.startsWith("strat:"));
  const rows: Row[] = models
    .map((m) => ({ model: m, r: rated.get(m) ?? null, equity: equityOf(m), seats: [roster.includes(m) ? "nightly" : "", sitRoster.includes(m) ? "sit" : ""].filter(Boolean), cut: rated.get(m)?.status === "cut" && !roster.includes(m) && !sitRoster.includes(m), riding: open.filter((t) => t.owner === m) }))
    .sort((a, b) => Number(a.cut) - Number(b.cut) || (b.r?.elo ?? 1500) - (a.r?.elo ?? 1500) || b.equity - a.equity || modelLabel(a.model).localeCompare(modelLabel(b.model)));
  const closedTotal = ratings.reduce((a, r) => a + r.n_trades, 0);
  const rules = { ...DEFAULT_CUT_RULES, ...account.cut_rules };

  return (
    <div className="pt-3">
      {err && <p className="text-[11px] text-orange-400 mb-2">{err}</p>}
      <Card>
        <Eyebrow className="mb-1.5">Standings</Eyebrow>
        <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed">
          {roster.length} on the nightly board, {sitRoster.length} on the sit jury. Nightly jurors run a {fmtMoney(SHADOW_START)} shadow book that takes their own top pick every night under the desk&apos;s rules; sit jurors are scored on every take-or-pass vote. Ranked by Elo, then by shadow equity; the cut sit at the bottom.
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
          const standings = Object.entries(r?.standing ?? {}).filter(([seat]) => row.seats.includes(seat));
          return (
            <Card key={row.model} className={row.cut ? "opacity-60" : ""}>
              <button onClick={() => setExpanded(isOpen ? null : row.model)} className="w-full text-left active:scale-[0.995]">
                <div className="flex items-center gap-2">
                  <span className="mono text-[11px] text-[var(--text-4)] w-4 shrink-0">{i + 1}</span>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: labTone(row.model) }} />
                  <span className="text-[13px] font-semibold flex-1 min-w-0 truncate">
                    {modelLabel(row.model)}
                    {row.cut ? <span className="mono text-[9px] uppercase tracking-widest text-[var(--bad)] ml-2">cut</span>
                      : row.seats.length === 0 ? <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] ml-2">retired</span>
                      : row.seats.includes("nightly") ? null : <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] ml-2">sit jury</span>}
                  </span>
                  <span className="mono text-[14px] font-bold">{Math.round(r?.elo ?? 1500)}</span>
                  <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">elo</span>
                </div>
                <div className="flex items-baseline gap-3 mt-1.5 pl-6">
                  {row.seats.includes("nightly") || n > 0 ? <span className="mono text-[12px] font-semibold" style={{ color: tone(pnl) }}>{fmtMoney(row.equity)} <span className="text-[10px]">({fmtPct(pnl / SHADOW_START)})</span></span> : null}
                  <span className="mono text-[10px] text-[var(--text-4)]">
                    {n} scored · win {hit === null ? "—" : `${(hit * 100).toFixed(0)}%`} · R {meanR === null ? "—" : `${meanR >= 0 ? "+" : ""}${meanR.toFixed(2)}`} · Brier {r?.brier === null || r?.brier === undefined ? "—" : r.brier.toFixed(2)}{r && r.n_sits > 0 ? ` · ${r.n_sits} sits, right ${((r.n_sit_right / r.n_sits) * 100).toFixed(0)}%` : ""}
                  </span>
                </div>
                {standings.map(([seat, st]) => (
                  <p key={seat} className="text-[10.5px] mt-1 pl-6 leading-snug">
                    <span className="mono text-[9px] uppercase" style={{ color: STANDING_COLOR[st.label] ?? "var(--text-4)" }}>{seat}: {st.label}</span>
                    {st.reasons.length ? <span className="text-[var(--text-4)]"> · {st.reasons.join("; ")}</span> : null}
                  </p>
                ))}
                {row.cut && r?.cut_reason ? <p className="text-[10.5px] mt-1 pl-6 text-[var(--text-4)] leading-snug">cut{r.cut_at ? ` ${day(r.cut_at)}` : ""}: {r.cut_reason}</p> : null}
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
                    <Mini label="Vote weight" value={weightOf(row.model).toFixed(2)} note={anyRated ? "From Elo once a model has 10 scored trades or 20 scored sits; 0.5 before." : "Equal until any model has 10 scored trades or 20 scored sits."} />
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
                    Each column is a band of stated confidence; the big number is how often those calls actually hit, the small one how many there were. A calibrated model reads like a diagonal. {n + (r?.n_sits ?? 0) < 20 ? "Too few to trust yet." : ""}
                  </p>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <SectionTitle>The standard · perform or be replaced</SectionTitle>
      <Card>
        <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed">
          Every seat is judged every morning by the same bars, once the juror has the sample. A nightly juror is judged after {rules.min_trades} scored shadow trades and cut when its book is {rules.max_loss_pct}% below its start, its shrunk R is {rules.min_r} or worse per trade, its Brier is {rules.max_brier} or worse (0.25 is a coin flip), or its Elo is {rules.min_elo} or lower. A sit juror is judged after {rules.min_sits} scored sits and cut when it is on the right side of {(rules.min_sit_right * 100).toFixed(0)}% of them or fewer, or on the same Brier and Elo bars. Half way to any bar is a notice. A cut juror goes to the back of the bench; the first bench model that is not seated, and not itself below the standard, takes the seat. A jury never drops below three.
        </p>
        <div className="flex items-center gap-3 mt-2.5">
          <button onClick={applyStandard} disabled={busy} className="rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] text-xs font-semibold px-3 py-2 active:scale-95 disabled:opacity-50">{busy ? "Judging…" : "Apply the standard now"}</button>
          <span className="mono text-[9px] text-[var(--text-4)]">no model call; runs by itself at 1:05am ET</span>
        </div>
        {note && <p className="text-[11px] text-[var(--text-3)] mt-2">{note}</p>}
        <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-3 mb-1">The bench, in order</p>
        <p className="text-[11px] text-[var(--text-2)] leading-relaxed"><span className="text-[var(--text-4)]">Nightly:</span> {account.bench.length ? account.bench.map(modelLabel).join(" → ") : "empty"}</p>
        <p className="text-[11px] text-[var(--text-2)] leading-relaxed mt-1"><span className="text-[var(--text-4)]">Sits:</span> {account.sit_bench.length ? account.sit_bench.map(modelLabel).join(" → ") : "empty"}</p>
        {log.length > 0 && (
          <>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-3 mb-1">The log</p>
            {log.map((x) => (
              <p key={x.id} className="text-[11px] leading-snug py-1 border-t border-[var(--border-1)]">
                <span className="mono text-[9px] text-[var(--text-4)]">{day(x.at)}</span> <span className="mono text-[9px] uppercase" style={{ color: x.action === "cut" ? "var(--bad)" : x.action === "notice" ? "var(--warn)" : "var(--text-4)" }}>{x.action}</span> <span className="font-semibold">{modelLabel(x.model)}</span> <span className="text-[var(--text-4)]">({x.seat})</span>
                {x.replaced_by ? <> → {modelLabel(x.replaced_by)}</> : null}<span className="text-[var(--text-3)]">: {x.reason}</span>
              </p>
            ))}
          </>
        )}
      </Card>

      <SectionTitle>Strategy books</SectionTitle>
      <Card>
        <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed">Each coded strategy runs its own {fmtMoney(SHADOW_START)} book with no jury: every setup it flags is taken at its levels. Read it against the desk&apos;s juried trades from the same rule to see what the jury adds. Twenty closed trades and a positive shrunk R earn size; a losing rule sits a week on the bench.</p>
        <div className="mt-2.5 space-y-1.5">
          {STRATEGIES.map((s) => {
            const st = strategies.find((x) => x.id === s.id);
            const equity = equityOf(`strat:${s.id}`);
            const pnl = equity - SHADOW_START;
            const stats = st?.stats ?? {};
            return (
              <div key={s.id} className="flex items-baseline gap-2 text-[11.5px]">
                <span className="font-semibold flex-1 min-w-0 truncate">{s.name}</span>
                <span className="mono text-[10px] text-[var(--text-4)] shrink-0">{stats.n ?? 0} closed{stats.n && stats.shrunk_r !== undefined ? ` · R ${stats.shrunk_r >= 0 ? "+" : ""}${stats.shrunk_r.toFixed(2)}` : ""}{st && st.size_mult !== 1 ? ` · size ×${st.size_mult}` : ""}{st?.benched_until ? ` · benched to ${st.benched_until.slice(5)}` : ""}</span>
                <span className="mono text-[11px] font-semibold shrink-0" style={{ color: tone(pnl) }}>{fmtMoney(equity)}</span>
              </div>
            );
          })}
        </div>
      </Card>

      <SectionTitle>How the League scores</SectionTitle>
      <Card>
        <ul className="text-[11.5px] text-[var(--text-2)] leading-relaxed space-y-1.5 list-disc pl-4">
          <li><b>Shadow book</b>: every night each nightly juror&apos;s highest-confidence proposal is filled, sized and exited by the same ledger as the desk, in its own {fmtMoney(SHADOW_START)} account. The desk only takes what the room voted through; the shadow books show what each model would have done alone.</li>
          <li><b>Elo</b> starts at 1500. Two jurors on opposite sides of the same symbol play a match when both trades close; the better R wins. A juror who abstained plays the trade it abstained on: it wins if the trade lost. K is 32 for the first 30 matches, then 16.</li>
          <li><b>Brier</b> is the average squared gap between stated confidence and the outcome (1 for a target hit, 0 for a stop). 0 is perfect, 0.25 is a coin flip with no idea, above 0.25 is worse than saying 50% every time.</li>
          <li><b>Sits</b>: a sit juror&apos;s take or pass is scored when the setup&apos;s own shadow trade closes. Its confidence goes into Brier and calibration, and every taker plays every passer for Elo, the taker winning if the setup won. Passing on a winner costs rating too.</li>
          <li><b>R</b> is profit in units of the risk taken: +2R means the trade made twice what it risked. The mean shown is shrunk toward zero for small samples, so a lucky first week reads as roughly zero, not as genius.</li>
          <li><b>Vote weight</b> is what a juror&apos;s support or opposition counts for in the tally. Equal for everyone until a model has 10 scored trades or 20 scored sits; then a 1600 Elo counts 1.0, a 1500 counts 0.5, and nothing goes below 0.25.</li>
          <li><b>The standard</b> is applied every morning before the macro review, and on demand above. Cuts are logged with the number that caused them; a cut model can be seated again only after everyone else on the bench has had a turn.</li>
          <li>Ratings only move when a trade or a sit&apos;s shadow trade closes, so this page changes slowly on purpose.</li>
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
