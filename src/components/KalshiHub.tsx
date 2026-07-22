"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase, KALSHI_FN, SUPABASE_ANON } from "@/lib/supabase";

// Kalshi "Markets" section — a trading-terminal view inside the daily app.
// Data comes from the `kalshi` edge function (public trades -> liquidity map +
// a Claude copilot) and the local hub's pushed account snapshot. No trading key
// is involved; real orders stay gated on the bot's own machine.
//
// Visual design adapted from Krypt Trader (github.com/scripflipped/Krypt-Trader,
// MIT) — dark terminal cards, indigo→purple→pink accent, glow on key numbers.
// Our data, our strategies; their look.

type Cat = { category: string; usd: number };
type Market = { ticker: string; usd: number; trades: number; category: string; link: string };
type Whale = { ticker: string; usd: number; category: string; link: string; time: string };
type Scan = { total: number; by_category: Cat[]; top_markets: Market[]; whales: Whale[]; ts: number };
type Msg = { role: "user" | "assistant"; content: string };
type Position = { ticker: string; position: number; exposure: number | string | null };
type Fill = { ticker: string; side: string; count: number | string; price: string; time: string };
type StalenessPos = { asset: string; side: string; entry: number; contracts: number };
type Staleness = {
  online: boolean; mode?: string; halted?: boolean; halt_reason?: string;
  pnl?: number; wins?: number; losses?: number; signals_seen?: number; open?: number;
  stop_loss_usd?: number; spot_feed?: boolean; open_positions?: StalenessPos[];
};
type HubStatus = {
  updated_at: string; connected: boolean; paper_mode: boolean; stop_loss_usd: number;
  halted: boolean; balance: number | null; positions: Position[]; fills: Fill[];
  staleness?: Staleness;
};

const fmt = (n: number) => "$" + Math.round(n).toLocaleString();
const CAT_TAG: Record<string, string> = {
  Weather: "bg-emerald-500/15 text-emerald-300 border-emerald-500/20",
  Crypto: "bg-amber-500/15 text-amber-300 border-amber-500/20",
  Sports: "bg-violet-500/15 text-violet-300 border-violet-500/20",
  Mentions: "bg-rose-500/15 text-rose-300 border-rose-500/20",
  Economics: "bg-sky-500/15 text-sky-300 border-sky-500/20",
  Politics: "bg-pink-500/15 text-pink-300 border-pink-500/20",
  Other: "bg-white/10 text-white/50 border-white/10",
};

async function callKalshi(body: Record<string, unknown>) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(KALSHI_FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

const GREETING =
  "This is the Kalshi research desk. Ask me what's liquid right now, what the research actually found, or how to plan a play. I can explain and advise — I can't place real trades (that stays on your machine).";

// ── design primitives (Krypt-style terminal cards) ──
function Card({ title, tag, children }: { title: string; tag?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0e0f17]/70 overflow-hidden shadow-[0_10px_40px_-16px_rgba(168,85,247,0.25)]">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.03] px-4 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/60">{title}</p>
        {tag}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-3">
      <p className="text-[10px] uppercase tracking-[0.15em] text-white/40">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${accent ?? "text-white"}`}>{value}</p>
    </div>
  );
}

export default function KalshiHub() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [err, setErr] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([{ role: "assistant", content: GREETING }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hub, setHub] = useState<HubStatus | null>(null);
  const [hubMissing, setHubMissing] = useState(false);
  const scanRef = useRef<Scan | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await callKalshi({ action: "scan" });
      if (d && Array.isArray(d.by_category)) { setScan(d); scanRef.current = d; setErr(false); }
      else setErr(true);
    } catch { setErr(true); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  const loadHub = useCallback(async () => {
    const { data, error } = await supabase
      .from("kalshi_hub_status").select("payload").eq("id", 1).maybeSingle();
    if (error || !data) { setHubMissing(true); return; }
    setHubMissing(false);
    setHub(data.payload as HubStatus);
  }, []);
  useEffect(() => { loadHub(); const t = setInterval(loadHub, 15000); return () => clearInterval(t); }, [loadHub]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [msgs]);

  async function send() {
    const m = input.trim();
    if (!m || busy) return;
    setInput(""); setBusy(true);
    const next: Msg[] = [...msgs, { role: "user", content: m }];
    setMsgs(next);
    try {
      const d = await callKalshi({ action: "chat", message: m, history: msgs.slice(1), scan: scanRef.current });
      setMsgs([...next, { role: "assistant", content: d.reply || "(no reply)" }]);
    } catch {
      setMsgs([...next, { role: "assistant", content: "[couldn't reach the copilot — check connection]" }]);
    }
    setBusy(false);
  }

  const maxCat = Math.max(1, ...(scan?.by_category ?? []).map((c) => c.usd));
  const hubStale = hub ? (Date.now() - new Date(hub.updated_at).getTime()) / 6e4 > 2 : false;

  return (
    <div className="relative space-y-4">
      {/* ambient glow backdrop */}
      <div className="pointer-events-none absolute -top-8 left-0 right-0 h-40 bg-[radial-gradient(600px_circle_at_20%_0%,rgba(168,85,247,0.12),transparent_60%),radial-gradient(500px_circle_at_90%_0%,rgba(236,72,153,0.08),transparent_60%)]" />

      {/* header */}
      <div className="relative">
        <h1 className="text-2xl font-extrabold tracking-tight bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
          Kalshi Markets
        </h1>
        <p className="mt-0.5 text-xs text-white/50">
          Research desk · live liquidity, whale flow &amp; an honest copilot. Trades stay gated on the bot&apos;s machine.
        </p>
      </div>

      {/* stat row */}
      <div className="relative grid grid-cols-3 gap-3">
        <Stat label="Balance"
          value={hub?.balance != null ? "$" + hub.balance.toFixed(2) : "—"}
          accent="text-emerald-400 drop-shadow-[0_0_10px_rgba(34,197,94,0.35)]" />
        <Stat label="Mode"
          value={<span className={hub && !hub.paper_mode ? "text-rose-400" : "text-sky-400"}>{hub ? (hub.paper_mode ? "PAPER" : "LIVE") : "—"}</span>} />
        <Stat label="Trades scanned"
          value={scan ? scan.total.toLocaleString() : "…"} accent="text-white/90" />
      </div>

      {/* staleness pilot */}
      {hub?.staleness && (
        <Card title="Staleness pilot"
          tag={hub.staleness.online
            ? <span className={`text-[10px] font-semibold ${hub.staleness.mode?.startsWith("LIVE") ? "text-rose-400" : "text-sky-400"}`}>{hub.staleness.mode}</span>
            : <span className="text-[10px] text-white/40">offline</span>}>
          {!hub.staleness.online ? (
            <p className="text-sm text-white/50">
              Pilot not running. Start <code className="rounded bg-white/10 px-1">staleness_bot.py</code> to watch it live.
            </p>
          ) : (
            <>
              {hub.staleness.halted && (
                <p className="mb-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm font-bold text-rose-400">
                  ⛔ Halted — {hub.staleness.halt_reason || "stop hit"}
                </p>
              )}
              <div className="grid grid-cols-4 gap-2">
                <div><p className="text-[10px] uppercase tracking-wider text-white/40">Paper P&amp;L</p>
                  <p className={`text-lg font-bold tabular-nums ${(hub.staleness.pnl ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {(hub.staleness.pnl ?? 0) >= 0 ? "+" : ""}${(hub.staleness.pnl ?? 0).toFixed(2)}</p></div>
                <div><p className="text-[10px] uppercase tracking-wider text-white/40">Signals</p>
                  <p className="text-lg font-bold tabular-nums text-white/90">{hub.staleness.signals_seen ?? 0}</p></div>
                <div><p className="text-[10px] uppercase tracking-wider text-white/40">W / L</p>
                  <p className="text-lg font-bold tabular-nums text-white/90">{hub.staleness.wins ?? 0}/{hub.staleness.losses ?? 0}</p></div>
                <div><p className="text-[10px] uppercase tracking-wider text-white/40">Open</p>
                  <p className="text-lg font-bold tabular-nums text-white/90">{hub.staleness.open ?? 0}</p></div>
              </div>
              {(hub.staleness.open_positions?.length ?? 0) > 0 && (
                <div className="mt-3 space-y-1">
                  {hub.staleness.open_positions!.map((p, i) => (
                    <div key={i} className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-1.5 text-sm">
                      <span className="font-medium text-white/80">{p.asset} <span className={p.side === "yes" ? "text-emerald-400" : "text-rose-400"}>{p.side.toUpperCase()}</span></span>
                      <span className="tabular-nums text-white/50">{p.contracts} @ {p.entry.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-[11px] text-white/30">
                {hub.staleness.mode?.startsWith("LIVE") ? "● live money · " : "◌ paper — watching for the edge · "}
                spot feed {hub.staleness.spot_feed ? "ok" : "down"} · stop ${hub.staleness.stop_loss_usd}
              </p>
            </>
          )}
        </Card>
      )}

      {/* account */}
      <Card title="Account"
        tag={hub && <span className="text-[10px] text-white/40">stop ${hub.stop_loss_usd}</span>}>
        {hubMissing || !hub ? (
          <p className="text-sm text-white/50">
            Local hub offline. Run <code className="rounded bg-white/10 px-1">hub.py</code> to stream balance &amp; positions.
          </p>
        ) : (
          <>
            {hub.halted && (
              <p className="mb-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm font-bold text-rose-400">
                ⛔ Kill switch tripped — bot halted.
              </p>
            )}
            {hub.positions.length > 0 ? (
              <div className="space-y-1.5">
                {hub.positions.map((p) => (
                  <div key={p.ticker} className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-sm">
                    <span className="truncate font-medium text-white/80">{p.ticker}</span>
                    <span className="text-white/50">{p.position}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-white/40">Flat — no open positions.</p>
            )}
            {hub.fills?.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-[10px] uppercase tracking-[0.15em] text-white/30">recent fills</p>
                <div className="space-y-0.5">
                  {hub.fills.slice(0, 6).map((f, i) => (
                    <div key={i} className="flex justify-between text-xs text-white/50">
                      <span className="truncate">{f.ticker}</span>
                      <span className="tabular-nums">{f.side} {f.count}{f.price ? ` @ $${f.price}` : ""}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className={`mt-3 text-[11px] ${hubStale ? "text-amber-400" : "text-white/30"}`}>
              {hubStale ? "⚠ stale — hub may be offline · " : "● live · "}
              {new Date(hub.updated_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            </p>
          </>
        )}
      </Card>

      {/* liquidity map */}
      <Card title="Where the money is"
        tag={<span className={`text-[10px] ${err ? "text-amber-400" : "text-white/40"}`}>{err ? "reconnecting…" : "last 90m turnover"}</span>}>
        {!scan ? (
          <p className="text-sm text-white/40">Scanning the live trade feed…</p>
        ) : (
          <div className="space-y-2.5">
            {scan.by_category.map((c) => (
              <div key={c.category}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] ${CAT_TAG[c.category] ?? CAT_TAG.Other}`}>{c.category}</span>
                  <b className="tabular-nums text-white/70">{fmt(c.usd)}</b>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-black/40">
                  <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"
                    style={{ width: `${Math.max(2, (100 * c.usd) / maxCat)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* top markets */}
      {scan && scan.top_markets.length > 0 && (
        <Card title="Most-traded markets">
          <div className="space-y-0.5">
            {scan.top_markets.slice(0, 10).map((m) => (
              <a key={m.ticker} href={m.link} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition hover:bg-white/5">
                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${CAT_TAG[m.category] ?? CAT_TAG.Other}`}>{m.category.slice(0, 4)}</span>
                <span className="flex-1 truncate text-white/70">{m.ticker}</span>
                <span className="font-semibold tabular-nums text-emerald-400">{fmt(m.usd)}</span>
              </a>
            ))}
          </div>
        </Card>
      )}

      {/* whales */}
      {scan && scan.whales.length > 0 && (
        <Card title="Whale flow" tag={<span className="text-[10px] text-white/40">≥ $1k</span>}>
          <div className="max-h-56 space-y-0.5 overflow-auto">
            {scan.whales.slice(0, 18).map((w, i) => (
              <a key={`${w.ticker}-${w.time}-${i}`} href={w.link} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 rounded px-2 py-1 text-sm transition hover:bg-white/5">
                <span className="w-16 font-semibold tabular-nums text-emerald-400">{fmt(w.usd)}</span>
                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${CAT_TAG[w.category] ?? CAT_TAG.Other}`}>{w.category.slice(0, 4)}</span>
                <span className="flex-1 truncate text-white/60">{w.ticker}</span>
              </a>
            ))}
          </div>
        </Card>
      )}

      {/* copilot */}
      <Card title="Copilot">
        <div ref={logRef} className="mb-3 max-h-72 space-y-2 overflow-auto">
          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                m.role === "user"
                  ? "rounded-br-sm bg-gradient-to-r from-indigo-500/25 to-purple-500/25 text-white"
                  : "rounded-bl-sm border border-white/10 bg-white/[0.03] text-white/80"}`}>
                {m.content}
              </div>
            </div>
          ))}
          {busy && <div className="px-1 text-xs text-white/40">thinking…</div>}
        </div>
        <div className="flex gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="what's liquid? what did the research find? plan a play…"
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm outline-none transition focus:border-purple-400/50" />
          <button onClick={send} disabled={busy}
            className="rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 px-4 font-bold text-white shadow-[0_0_20px_-4px_rgba(168,85,247,0.6)] transition active:scale-95 disabled:opacity-50">
            {busy ? "…" : "Ask"}
          </button>
        </div>
      </Card>

      <p className="pt-1 text-center text-[10px] text-white/25">
        terminal design adapted from Krypt Trader (MIT) · data &amp; strategies our own
      </p>
    </div>
  );
}
