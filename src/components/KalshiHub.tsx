"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, KALSHI_FN, SUPABASE_ANON } from "@/lib/supabase";

// Kalshi "Markets" section. Everything live here comes from the `kalshi` edge
// function (public trades -> liquidity map + a Claude copilot on the shared AI
// key). No trading key is involved — real orders stay gated on the bot's own
// machine, never the public app. This section is for research + monitoring.

type Cat = { category: string; usd: number };
type Market = { ticker: string; usd: number; trades: number; category: string; link: string };
type Whale = { ticker: string; usd: number; category: string; link: string; time: string };
type Scan = { total: number; by_category: Cat[]; top_markets: Market[]; whales: Whale[]; ts: number };
type Msg = { role: "user" | "assistant"; content: string };
type Position = { ticker: string; position: number; exposure: number | string | null };
type Fill = { ticker: string; side: string; count: number | string; price: string; time: string };
type HubStatus = {
  updated_at: string; connected: boolean; paper_mode: boolean; stop_loss_usd: number;
  halted: boolean; balance: number | null; positions: Position[]; fills: Fill[];
};

const fmt = (n: number) => "$" + Math.round(n).toLocaleString();
const CAT_BAR: Record<string, string> = {
  Weather: "bg-emerald-400", Crypto: "bg-amber-400", Sports: "bg-violet-400",
  Mentions: "bg-rose-400", Economics: "bg-sky-400", Politics: "bg-pink-400", Other: "bg-white/25",
};
const CAT_TAG: Record<string, string> = {
  Weather: "bg-emerald-500/15 text-emerald-300", Crypto: "bg-amber-500/15 text-amber-300",
  Sports: "bg-violet-500/15 text-violet-300", Mentions: "bg-rose-500/15 text-rose-300",
  Economics: "bg-sky-500/15 text-sky-300", Politics: "bg-pink-500/15 text-pink-300",
  Other: "bg-white/10 opacity-70",
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

  // Account/positions are pushed by the local hub (hub.py) into kalshi_hub_status —
  // read-only here, exactly like the Money tab's TradingBot card. The trading key
  // never leaves the machine; this app only ever shows what the hub chooses to send.
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

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-widest opacity-60">🎲 Kalshi · Markets</p>
        <p className="text-sm opacity-60 mt-1">
          Research desk. Live liquidity map + honest copilot. Real trades stay on the bot&apos;s
          own machine — this is where you watch, learn, and plan.
        </p>
      </div>

      {/* ACCOUNT — pushed by the local hub (read-only, key stays on the machine) */}
      <div className="rounded-2xl bg-white/5 border border-white/10 p-5">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-widest opacity-60">🏦 Account</p>
          {hub && (
            <div className="flex gap-1.5 text-[10px] font-bold uppercase tracking-wider">
              <span className={`px-2 py-0.5 rounded-full ${hub.paper_mode ? "bg-sky-500/20 text-sky-300" : "bg-red-500/20 text-red-300"}`}>
                {hub.paper_mode ? "paper" : "live"}
              </span>
              <span className="px-2 py-0.5 rounded-full bg-white/10 opacity-70">stop ${hub.stop_loss_usd}</span>
            </div>
          )}
        </div>
        {hubMissing || !hub ? (
          <p className="text-sm opacity-60 mt-2">
            Local hub offline. Run <code className="bg-white/10 px-1 rounded">hub.py</code> on your machine
            to stream balance &amp; positions here — the scanner and copilot below work either way.
          </p>
        ) : (() => {
          const stale = (Date.now() - new Date(hub.updated_at).getTime()) / 6e4 > 2;
          return (
            <>
              {hub.halted && (
                <p className="mt-2 text-sm font-bold text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                  ⛔ Kill switch tripped — bot halted.
                </p>
              )}
              <p className="text-3xl font-extrabold mt-2">{hub.balance != null ? "$" + hub.balance.toFixed(2) : "—"}</p>
              {hub.positions.length > 0 ? (
                <div className="mt-3 space-y-1.5">
                  {hub.positions.map((p) => (
                    <div key={p.ticker} className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2 text-sm">
                      <span className="font-semibold truncate">{p.ticker}</span>
                      <span className="opacity-70">{p.position}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm opacity-50 mt-2">Flat — no open positions.</p>
              )}
              {hub.fills?.length > 0 && (
                <div className="mt-3">
                  <p className="text-[10px] uppercase tracking-widest opacity-40 mb-1">recent fills</p>
                  <div className="space-y-0.5">
                    {hub.fills.slice(0, 6).map((f, i) => (
                      <div key={i} className="flex justify-between text-xs opacity-70">
                        <span className="truncate">{f.ticker}</span>
                        <span>{f.side} {f.count}{f.price ? ` @ $${f.price}` : ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className={`text-[11px] mt-3 ${stale ? "text-orange-400" : "opacity-40"}`}>
                {stale ? "⚠️ stale — hub may be offline · " : "live · "}
                updated {new Date(hub.updated_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </p>
            </>
          );
        })()}
      </div>

      {/* LIQUIDITY MAP */}
      <div className="rounded-2xl bg-white/5 border border-white/10 p-5">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-widest opacity-60">📊 Where the money is</p>
          <span className={`text-[10px] ${err ? "text-orange-400" : "opacity-40"}`}>
            {err ? "reconnecting…" : scan ? `${scan.total.toLocaleString()} trades scanned` : "loading…"}
          </span>
        </div>
        {!scan ? (
          <p className="text-sm opacity-50 mt-3">Scanning the live trade feed…</p>
        ) : (
          <div className="mt-3 space-y-2">
            {scan.by_category.map((c) => (
              <div key={c.category}>
                <div className="flex justify-between text-xs mb-0.5">
                  <span className={`px-1.5 rounded ${CAT_TAG[c.category] ?? CAT_TAG.Other}`}>{c.category}</span>
                  <b className="opacity-80">{fmt(c.usd)}</b>
                </div>
                <div className="h-1.5 rounded-full bg-black/30 overflow-hidden">
                  <div className={`h-full ${CAT_BAR[c.category] ?? CAT_BAR.Other}`}
                    style={{ width: `${Math.max(2, (100 * c.usd) / maxCat)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* TOP MARKETS */}
      {scan && scan.top_markets.length > 0 && (
        <div className="rounded-2xl bg-white/5 border border-white/10 p-5">
          <p className="text-xs uppercase tracking-widest opacity-60 mb-2">🔥 Most-traded markets</p>
          <div className="space-y-1">
            {scan.top_markets.slice(0, 10).map((m) => (
              <a key={m.ticker} href={m.link} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 text-sm">
                <span className={`text-[10px] px-1.5 rounded ${CAT_TAG[m.category] ?? CAT_TAG.Other}`}>{m.category.slice(0, 4)}</span>
                <span className="flex-1 truncate opacity-80">{m.ticker}</span>
                <span className="text-emerald-400 font-semibold tabular-nums">{fmt(m.usd)}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* WHALE FEED */}
      {scan && scan.whales.length > 0 && (
        <div className="rounded-2xl bg-white/5 border border-white/10 p-5">
          <p className="text-xs uppercase tracking-widest opacity-60 mb-2">🐋 Big trades (≥ $1k)</p>
          <div className="space-y-1 max-h-52 overflow-auto">
            {scan.whales.slice(0, 18).map((w, i) => (
              <a key={`${w.ticker}-${w.time}-${i}`} href={w.link} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 text-sm hover:bg-white/5 rounded px-2 py-1">
                <span className="text-emerald-400 font-semibold tabular-nums w-16">{fmt(w.usd)}</span>
                <span className={`text-[10px] px-1.5 rounded ${CAT_TAG[w.category] ?? CAT_TAG.Other}`}>{w.category.slice(0, 4)}</span>
                <span className="flex-1 truncate opacity-70">{w.ticker}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* COPILOT */}
      <div className="rounded-2xl bg-white/5 border border-white/10 p-5">
        <p className="text-xs uppercase tracking-widest opacity-60 mb-2">💬 Copilot</p>
        <div ref={logRef} className="max-h-72 overflow-auto space-y-2 mb-3">
          {msgs.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ${
                m.role === "user" ? "bg-[var(--neon)]/20 text-[var(--neon)] rounded-br-sm"
                  : "bg-white/5 border border-white/10 rounded-bl-sm"}`}>
                {m.content}
              </div>
            </div>
          ))}
          {busy && <div className="text-xs opacity-40 px-1">thinking…</div>}
        </div>
        <div className="flex gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="what's liquid? what did the research find? plan a play…"
            className="flex-1 min-w-0 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 outline-none focus:border-[var(--neon)]/50 transition text-sm" />
          <button onClick={send} disabled={busy}
            className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-50">
            {busy ? "…" : "Ask"}
          </button>
        </div>
      </div>
    </div>
  );
}
