"use client";

// Strategies — the eight coded rules the scan runs, each explained: what it
// does, why it might work, when it fails, the exact checks, and its record
// from its own shadow book. This is the technical-analysis textbook of the
// desk, written as things the code actually does rather than as theory.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow } from "../ui";
import { loadTrades, updateAccount, fmtMoney, fmtR, type Account } from "@/lib/desk/api";
import { STRATEGIES, type StrategyDef } from "@/lib/desk/scan";
import { tradeStats, shrink } from "@/lib/desk/stats";
import type { Trade } from "@/lib/desk/types";

const TF: Record<string, string> = { scalp: "scalp · hours", swing: "swing · days", position: "position · weeks" };

export default function Strategies({ uid, account, onSaved }: { uid: string; account: Account; onSaved: () => void }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await loadTrades(uid, { ownerLike: "strat:%", limit: 1000 });
    setErr(r.error);
    if (!r.error) setTrades(r.trades);
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function toggle(id: string) {
    if (busy) return;
    setBusy(id);
    const off = new Set(account.strategies_off);
    if (off.has(id)) off.delete(id); else off.add(id);
    const r = await updateAccount(uid, { strategies_off: [...off] });
    setBusy(null);
    if (r.error) setErr(r.error); else onSaved();
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-40" /></div>;

  return (
    <div className="pt-3">
      {err && <p className="text-[11px] text-orange-400 mb-2">{err}</p>}
      <Card>
        <Eyebrow className="mb-1.5">The strategies</Eyebrow>
        <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed">
          Eight rules in code, scanned every fifteen minutes across the watchlist and the top BloFin perps. Each one runs its own shadow book with no jury, so its raw record can be read against the desk&apos;s juried trades. A rule with twenty closed trades and a positive shrunk R earns bigger size; a losing one gets benched. Switch any of them off here.
        </p>
      </Card>
      <div className="mt-2 space-y-2">
        {STRATEGIES.map((s) => {
          const mine = trades.filter((t) => t.owner === `strat:${s.id}`);
          const closed = mine.filter((t) => t.status === "closed");
          const live = mine.filter((t) => t.status === "open" || t.status === "pending");
          const st = tradeStats(closed);
          const off = account.strategies_off.includes(s.id);
          const isOpen = open === s.id;
          return (
            <Card key={s.id} className={off ? "opacity-60" : ""}>
              <button onClick={() => setOpen(isOpen ? null : s.id)} className="w-full text-left active:scale-[0.995]">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold flex-1 min-w-0 truncate">{s.name}</span>
                  <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">{TF[s.timeframe]}</span>
                  {off && <span className="mono text-[9px] uppercase tracking-widest text-orange-400">off</span>}
                </div>
                <p className="text-[11.5px] text-[var(--text-2)] mt-1 leading-snug">{s.what}</p>
                <p className="mono text-[10px] text-[var(--text-4)] mt-1.5">
                  <Record st={st} n={closed.length} /> · {live.length} riding · {s.venues.join(" and ")}{s.venues.includes("perps") ? ` · up to ${s.leverage}x` : ""}
                </p>
              </button>
              {isOpen && <Detail s={s} closed={closed} off={off} busy={busy === s.id} onToggle={() => toggle(s.id)} />}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Record({ st, n }: { st: ReturnType<typeof tradeStats>; n: number }) {
  if (!n) return <span>no closed trades yet</span>;
  const sh = st.expectancyR === null ? null : shrink(st.expectancyR, n);
  return <span>{n} closed · win {st.winRate === null ? "—" : `${(st.winRate * 100).toFixed(0)}%`} · R {sh === null ? "—" : fmtR(sh)}{n < 20 ? " · too few to trust" : ""}</span>;
}

function Detail({ s, closed, off, busy, onToggle }: { s: StrategyDef; closed: Trade[]; off: boolean; busy: boolean; onToggle: () => void }) {
  const pnl = closed.reduce((a, t) => a + (t.pnl ?? 0), 0);
  return (
    <div className="mt-2.5 pt-2.5 border-t border-[var(--border-1)] rise-in space-y-2">
      <p className="text-[11.5px] leading-relaxed"><span className="text-[var(--text-4)]">Why it might work:</span> {s.why}</p>
      <p className="text-[11.5px] leading-relaxed"><span className="text-[var(--text-4)]">When it fails:</span> {s.fails}</p>
      <div>
        <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">The checks, exactly as the code runs them</p>
        <ol className="text-[11.5px] leading-relaxed list-decimal pl-4 space-y-0.5">{s.rules.map((r, i) => <li key={i}>{r}</li>)}</ol>
      </div>
      {closed.length > 0 && <p className="mono text-[10px] text-[var(--text-3)]">shadow book: {closed.length} closed, {pnl >= 0 ? "+" : "-"}{fmtMoney(Math.abs(pnl))} on $100k, best {fmtR(Math.max(...closed.map((t) => t.r_multiple ?? 0)))}, worst {fmtR(Math.min(...closed.map((t) => t.r_multiple ?? 0)))}</p>}
      <button onClick={onToggle} disabled={busy} className={`rounded-lg text-xs font-semibold px-3 py-1.5 active:scale-95 disabled:opacity-50 ${off ? "bg-[var(--neon)]/15 text-[var(--neon)]" : "bg-white/5 text-[var(--text-2)]"}`}>
        {busy ? "…" : off ? "Switch on" : "Switch off"}
      </button>
    </div>
  );
}
