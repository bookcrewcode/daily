"use client";

// Now — the desk as it stands this minute. Every five minutes the tick fills
// and exits orders, settles the juries that have voted and opens new ones;
// every quarter hour the feed and the scan run. This gear shows what is open
// at live prices, which juries are sitting, what the desk did today and what
// is waiting on the table. Every label is explained where it sits.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow, SectionTitle } from "../ui";
import { loadTrades, loadSits, loadSetups, fmtMoney, fmtPct, fmtPrice, fmtR, type Account, type SitRow, type SetupRow } from "@/lib/desk/api";
import { unrealized } from "@/lib/desk/ledger";
import { STRATEGIES } from "@/lib/desk/scan";
import { etDate } from "@/lib/desk/clock";
import type { Trade } from "@/lib/desk/types";
import type { LiveMarks } from "./DeskSpace";

const TF: Record<string, string> = { scalp: "scalp · hours", swing: "swing · days", position: "position · weeks" };
const SOURCE: Record<string, string> = { sit: "sit", nightly: "nightly jury", shadow: "shadow" };
const stratName = (id?: string) => (id ? STRATEGIES.find((s) => s.id === id)?.name ?? id : "");
const tone = (v: number) => (v > 0 ? "var(--ok)" : v < 0 ? "var(--bad)" : "var(--text-3)");
const signed = (v: number, d = 0) => (v >= 0 ? "+" : "-") + fmtMoney(Math.abs(v), d);
const onDay = (iso: string | null | undefined, day: string) => !!iso && etDate(Date.parse(iso)) === day;

// Ticks fire one minute past each five: :01, :06, :11 … this is the next one after `now`.
function nextTick(now: number): number {
  const m = new Date(now);
  m.setUTCSeconds(0, 0);
  let t = m.getTime();
  for (let i = 0; i < 6; i++) { t += 60_000; if (new Date(t).getUTCMinutes() % 5 === 1) return t; }
  return t;
}
function ago(iso: string, now: number): string {
  const m = Math.floor((now - Date.parse(iso)) / 60_000);
  return !Number.isFinite(m) || m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}
function fillLabel(t: Trade): string {
  return t.fill_rule === "next_5m" ? "fills on the next 5-minute bar" : t.fill_rule === "next_hour" ? "fills on the next hourly candle" : "fills at the next open";
}

type Decision = { take?: boolean; taken?: boolean; score?: number; answered?: number; takers?: number; reasons?: string[] };

export default function Now({ uid, account, live, today, onRefresh }: { uid: string; account: Account; live: LiveMarks | null; today: string; onRefresh: () => void }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [sits, setSits] = useState<SitRow[]>([]);
  const [setups, setSetups] = useState<SetupRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    const [t, s, u] = await Promise.all([loadTrades(uid, { owner: "desk", limit: 150 }), loadSits(uid, 60, 24), loadSetups(uid, 100, 24)]);
    setErr(t.error || s.error || u.error);
    if (!t.error) setTrades(t.trades);
    if (!s.error) setSits(s.sits);
    if (!u.error) setSetups(u.setups);
    setNow(Date.now());
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);
  useEffect(() => { const id = setInterval(load, 60_000); return () => clearInterval(id); }, [load]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(id); }, []);

  if (!loaded) return <div className="pt-3"><div className="skeleton h-24" /><div className="skeleton h-40 mt-3" /></div>;

  const open = trades.filter((t) => t.status === "open");
  const pending = trades.filter((t) => t.status === "pending");
  const closedToday = trades.filter((t) => t.status === "closed" && onDay(t.exit_at, today));
  const pnlToday = closedToday.reduce((a, t) => a + (t.pnl ?? 0), 0);
  const sitting = sits.filter((s) => s.status === "launched");
  const decided = sits.filter((s) => s.status === "done" && onDay(s.updated_at || s.created_at, today));
  const takenToday = decided.filter((s) => (s.decision as Decision).taken).length;
  const spentToday = decided.reduce((a, s) => a + s.cost_usd, 0);
  const fresh = setups.filter((s) => s.status === "new" && (!s.expires_at || Date.parse(s.expires_at) > now));
  const next = now ? nextTick(now) : 0;
  const mins = next ? Math.max(1, Math.ceil((next - now) / 60_000)) : 0;
  const halted = !!account.halted_until && account.halted_until >= today;
  const byStrategy = new Map<string, SetupRow[]>();
  for (const s of fresh) byStrategy.set(s.strategy, [...(byStrategy.get(s.strategy) ?? []), s]);

  return (
    <div>
      {err && <button onClick={load} className="w-full mt-3 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">{err} — tap to retry</button>}

      <Card className="mt-3">
        <div className="flex items-baseline justify-between">
          <Eyebrow>This minute</Eyebrow>
          <span className="mono text-[10px] text-[var(--neon)]">next tick in {mins}m</span>
        </div>
        <div className="grid grid-cols-4 gap-2 mt-2.5">
          <Mini label="Open" value={String(open.length)} note="positions filled and running" />
          <Mini label="Queued" value={String(pending.length)} note="orders waiting for a bar" />
          <Mini label="Juries" value={String(sitting.length)} note="sits voting right now" />
          <Mini label="Table" value={String(fresh.length)} note="setups no jury has seen" />
        </div>
        <p className="text-[10.5px] text-[var(--text-4)] mt-2.5 leading-relaxed">
          The tick runs a minute past every five: it fills queued orders on the next bar, checks every stop, target and clock, settles the juries that have voted and opens up to six new ones from the top of the table. The feed and the scan run every quarter hour.
          {" "}Today: {closedToday.length} closed for <span style={{ color: tone(pnlToday) }}>{signed(pnlToday)}</span>, {takenToday} of {decided.length} sits taken, {fmtMoney(spentToday, 2)} of the {fmtMoney(account.sit_budget_usd, 2)} sit budget spent.
          {halted ? " The account is halted, so juries pass on everything until it lifts." : ""}
        </p>
      </Card>

      {/* ── open and queued ─────────────────────────────────────────── */}
      <SectionTitle>On the book</SectionTitle>
      {open.length + pending.length === 0 ? (
        <Card><p className="text-[12.5px] text-[var(--text-3)] leading-relaxed">Flat. The next sit that wins its vote puts an order here; it fills on the next 5-minute bar.</p></Card>
      ) : (
        <div className="space-y-2">
          {[...open, ...pending].map((t) => {
            const mark = live?.quotes[t.symbol]?.price;
            const filled = t.status === "open" && t.entry_price !== null;
            const u = filled && mark ? unrealized(t, mark) : null;
            const base = t.instrument === "crypto_perp" ? t.margin : t.notional;
            return (
              <Card key={t.id} padded={false}>
                <div className="px-3 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="mono text-[13px] font-bold">{t.symbol}</span>
                    <span className="mono text-[9px] uppercase tracking-wider text-[var(--text-4)] truncate">{t.side}{t.instrument === "crypto_perp" ? ` ${t.leverage}x` : ""} · {SOURCE[t.source ?? "nightly"]}{t.strategy ? ` · ${stratName(t.strategy)}` : ""}</span>
                    <span className="flex-1" />
                    {u !== null ? (
                      <span className="mono text-[12px] font-bold shrink-0" style={{ color: tone(u) }}>{signed(u)} <span className="text-[9px]">({fmtPct(base > 0 ? u / base : 0)})</span></span>
                    ) : (
                      <span className="mono text-[9px] text-[var(--warn)] shrink-0">{t.status === "pending" ? fillLabel(t) : "no live price"}</span>
                    )}
                  </div>
                  <p className="mono text-[10px] text-[var(--text-3)] mt-1">
                    {filled ? `in at ${fmtPrice(t.entry_price as number)}` : `ref ${fmtPrice(t.entry_ref)}`} · <span style={{ color: "var(--bad)" }}>stop {fmtPrice(t.stop)}</span> · <span style={{ color: "var(--ok)" }}>target {fmtPrice(t.target)}</span> · {fmtMoney(t.notional)} · {TF[t.timeframe ?? "swing"]}{t.horizon_hours ? ` · ${t.horizon_hours}h clock` : ` · ${t.horizon_days}d`}
                  </p>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── juries sitting ──────────────────────────────────────────── */}
      {sitting.length > 0 && (
        <>
          <SectionTitle>Juries sitting</SectionTitle>
          <Card>
            <div className="space-y-1.5">
              {sitting.map((s) => (
                <p key={s.id} className="text-[11.5px] leading-snug"><span className="mono font-bold">{s.symbol}</span> <span className="text-[var(--text-2)]">{stratName(s.strategy)} · {TF[s.timeframe] ?? s.timeframe}</span> <span className="mono text-[10px] text-[var(--text-4)]">· opened {ago(s.created_at, now)}</span></p>
              ))}
            </div>
            <p className="text-[10px] text-[var(--text-4)] mt-2 leading-relaxed">Three fast models are reading each setup with its headlines. Their ballots settle at the next tick; the full votes land under Debate.</p>
          </Card>
        </>
      )}

      {/* ── today ───────────────────────────────────────────────────── */}
      <SectionTitle>Today</SectionTitle>
      {decided.length + closedToday.length === 0 ? (
        <Card><p className="text-[12.5px] text-[var(--text-3)] leading-relaxed">Nothing decided yet today. Sits open as the scan finds setups; closes show here with their result.</p></Card>
      ) : (
        <Card>
          <div className="space-y-1.5">
            {closedToday.map((t) => (
              <p key={t.id} className="text-[11.5px] leading-snug flex items-baseline gap-2">
                <span className="mono font-bold">{t.symbol}</span>
                <span className="text-[var(--text-3)] flex-1 min-w-0 truncate">closed · {t.exit_reason === "target" ? "hit target" : t.exit_reason === "stop" ? "stopped out" : t.exit_reason === "time" ? "time stop" : t.exit_reason}{t.strategy ? ` · ${stratName(t.strategy)}` : ""}</span>
                <span className="mono text-[11px] font-semibold" style={{ color: tone(t.pnl ?? 0) }}>{signed(t.pnl ?? 0)} · {fmtR(t.r_multiple ?? 0)}</span>
              </p>
            ))}
            {decided.map((s) => {
              const d = s.decision as Decision;
              return (
                <p key={s.id} className="text-[11.5px] leading-snug flex items-baseline gap-2">
                  <span className="mono font-bold">{s.symbol}</span>
                  <span className="text-[var(--text-3)] flex-1 min-w-0 truncate">{stratName(s.strategy)} · {d.takers ?? 0} of {d.answered ?? 0} said take{d.reasons?.length && !d.taken ? ` · ${d.reasons[0]}` : ""}</span>
                  <span className="mono text-[10px] font-semibold" style={{ color: d.taken ? "var(--ok)" : "var(--text-4)" }}>{d.taken ? "taken" : d.take ? "not placed" : "passed"}</span>
                </p>
              );
            })}
          </div>
          <p className="text-[10px] text-[var(--text-4)] mt-2 leading-relaxed">A sit is taken on two of three votes and a positive weighted score; &ldquo;not placed&rdquo; means the room said take but the price had moved or a rule blocked it. Reasons and every ballot are under Debate.</p>
        </Card>
      )}

      {/* ── the table ───────────────────────────────────────────────── */}
      <SectionTitle>On the table</SectionTitle>
      <Card>
        {fresh.length === 0 ? (
          <p className="text-[12.5px] text-[var(--text-3)] leading-relaxed">Nothing waiting. The scan runs every quarter hour over the watchlist and the top BloFin perps; a setup lands here when every core check of a strategy holds.</p>
        ) : (
          <div className="space-y-1.5">
            {[...byStrategy.entries()].map(([id, list]) => (
              <p key={id} className="text-[11.5px] leading-snug"><span className="font-semibold">{stratName(id)}</span> <span className="text-[var(--text-3)]">{list.map((s) => `${s.symbol} ${s.side}`).join(", ")}</span></p>
            ))}
          </div>
        )}
        <p className="text-[10px] text-[var(--text-4)] mt-2 leading-relaxed">Ranked by confluence, the share of a strategy&apos;s confirmations that also held. The next tick opens juries for the top six not already on the book or in cooldown; scalps expire in two hours, swings in a day, positions in three.</p>
        <button onClick={() => { load(); onRefresh(); }} className="mono text-[10px] text-[var(--neon)] mt-2 active:scale-95">refresh</button>
      </Card>
    </div>
  );
}

function Mini({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg bg-[var(--raised)] border border-[var(--border-1)] px-2 py-1.5">
      <p className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)]">{label}</p>
      <p className="mono text-[16px] font-bold leading-tight mt-0.5">{value}</p>
      <p className="text-[8.5px] text-[var(--text-4)] mt-0.5 leading-snug">{note}</p>
    </div>
  );
}
