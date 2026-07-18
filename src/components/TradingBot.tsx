"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// Read-only view of the RegimeBot trading bot (~/Downloads/trading-bot).
// The bot upserts one row (id=1) into trading_bot_status after every run;
// this card just renders it. No controls on purpose — money is managed from
// the bot's own machine, never from the public app.

type BotPosition = {
  symbol: string;
  qty: number;
  avg_entry: number;
  price: number;
  unrealized_pct: number;
};

type BotStatus = {
  updated_at: string;
  run_mode: string;
  trading_mode: "paper" | "live";
  dry_run: boolean;
  halted: boolean;
  equity: number | null;
  cash: number | null;
  positions: BotPosition[];
  regime: {
    hmm: string;
    markov: string;
    confidence: number;
    edge: number;
    sizing_multiplier: number;
  } | null;
  notes: string;
};

const fmt = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

const REGIME_EMOJI: Record<string, string> = {
  calm: "🟢", normal: "🟡", elevated: "🟠", turbulent: "🔴", crash: "🚨",
};

export default function TradingBot() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("trading_bot_status")
      .select("payload")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) { setMissing(true); return; }
    setMissing(false);
    setStatus(data.payload as BotStatus);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (missing || !status) {
    return (
      <div className="mt-6 rounded-2xl bg-white/5 border border-white/10 p-5">
        <p className="text-xs uppercase tracking-widest opacity-60">🤖 Trading bot</p>
        <p className="text-sm opacity-60 mt-2">
          No status yet — the bot hasn&apos;t pushed since setup. It reports here
          after each scheduled run.
        </p>
      </div>
    );
  }

  const ageHours = (Date.now() - new Date(status.updated_at).getTime()) / 36e5;
  const stale = ageHours > 30; // no push in over a day (weekends are fine-ish)

  return (
    <div className="mt-6 rounded-2xl bg-white/5 border border-white/10 p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-widest opacity-60">🤖 Trading bot</p>
        <div className="flex gap-1.5 text-[10px] font-bold uppercase tracking-wider">
          <span className={`px-2 py-0.5 rounded-full ${status.trading_mode === "live"
            ? "bg-red-500/20 text-red-300" : "bg-sky-500/20 text-sky-300"}`}>
            {status.trading_mode}
          </span>
          {status.dry_run && (
            <span className="px-2 py-0.5 rounded-full bg-white/10 opacity-70">dry run</span>
          )}
        </div>
      </div>

      {status.halted && (
        <p className="mt-2 text-sm font-bold text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
          ⛔ HALTED by risk layer — needs a manual look at journal/HALT
        </p>
      )}

      {status.equity != null && (
        <p className="text-3xl font-extrabold mt-2">{fmt(status.equity)}</p>
      )}

      {status.regime && (
        <p className="text-sm mt-1 opacity-80">
          {REGIME_EMOJI[status.regime.hmm] ?? "•"} vol {status.regime.hmm} · trend{" "}
          {status.regime.markov} · edge {status.regime.edge >= 0 ? "+" : ""}
          {status.regime.edge.toFixed(2)} · size ×{status.regime.sizing_multiplier.toFixed(2)}
        </p>
      )}

      {status.positions.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {status.positions.map((p) => (
            <div key={p.symbol} className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2 text-sm">
              <span className="font-bold">{p.symbol}</span>
              <span className="opacity-70">{p.qty} sh</span>
              <span className={p.unrealized_pct >= 0 ? "text-emerald-400" : "text-red-400"}>
                {(p.unrealized_pct * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm opacity-50 mt-3">Flat — no open positions.</p>
      )}

      <p className={`text-[11px] mt-3 ${stale ? "text-orange-400" : "opacity-40"}`}>
        {stale ? "⚠️ stale — " : ""}last run {status.run_mode} ·{" "}
        {new Date(status.updated_at).toLocaleString(undefined, {
          weekday: "short", hour: "numeric", minute: "2-digit",
        })}
      </p>
    </div>
  );
}
