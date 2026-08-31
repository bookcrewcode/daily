"use client";

// 📈 THE NEWS AGENT — a paper trading agent that reads the briefing, writes a
// thesis, takes a position, and is then graded against its own claim.
//
// Ben: "a paper trade based off of the news, then the agent makes a thesis and
// makes a trade... it teaches me based on the news, and then I could watch this
// agent make live trades and learn from that."
//
// The screen is built around the LEARNING, not the P&L. Every closed trade
// shows what the agent claimed, what it said would prove it wrong, and whether
// that claim actually survived — because "up 3%" teaches nothing on its own,
// and a winner for the wrong reason is worth knowing about.
//
// PAPER ONLY. The edge function's Alpaca URL is a hardcoded constant and the
// key RPC refuses live (AK…) keys outright. This screen says so on its face,
// because a simulator that looks like a brokerage is a trap.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, SUPABASE_URL, SUPABASE_ANON } from "@/lib/supabase";
import { Card, Eyebrow, SectionTitle } from "./ui";
import { sfx, buzz } from "@/lib/fx";

const TRADER_FN = `${SUPABASE_URL}/functions/v1/trader`;

type Cfg = {
  enabled: boolean; dry: boolean; per_trade_pct: number; max_open: number;
  hold_days: number; stop_pct: number; take_pct: number; allow_short: boolean;
};
type Pos = {
  symbol: string; qty: number; side: string; avg_entry_price: number;
  current_price: number; market_value: number; unrealized_pl: number; unrealized_plpc: number;
};
type Trade = {
  id: string; day: string; symbol: string; side: string; notional: number;
  headline: string; source_url: string; thesis: string; falsifier: string; conviction: number;
  status: string; reject_reason: string; entry_price: number | null; exit_price: number | null;
  exit_reason: string; pnl: number | null; pnl_pct: number | null; verdict: string; lesson: string;
};
type Equity = { day: string; equity: number; spy_close: number | null };

const money = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
const pct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const tone = (n: number) => (n > 0 ? "var(--ok)" : n < 0 ? "var(--bad)" : "var(--text-3)");

const VERDICT: Record<string, { label: string; tone: string }> = {
  held: { label: "thesis held", tone: "var(--ok)" },
  broke: { label: "thesis broke", tone: "var(--bad)" },
  unclear: { label: "unclear", tone: "var(--warn)" },
};

export default function NewsTrader({ uid }: { uid: string }) {
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [alpacaErr, setAlpacaErr] = useState("");
  const [account, setAccount] = useState<{ equity: number; last_equity: number; cash: number } | null>(null);
  const [positions, setPositions] = useState<Pos[]>([]);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [curve, setCurve] = useState<Equity[]>([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [keyTail, setKeyTail] = useState("");
  const [showKeys, setShowKeys] = useState(false);
  const [kId, setKId] = useState("");
  const [kSec, setKSec] = useState("");
  const running = useRef(false);

  const call = useCallback(async (mode: string, extra?: Record<string, unknown>) => {
    const { data: s } = await supabase.auth.getSession();
    const r = await fetch(TRADER_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${s.session?.access_token}` },
      body: JSON.stringify({ mode, ...(extra ?? {}) }),
    });
    return await r.json();
  }, []);

  const load = useCallback(async () => {
    try {
      const [st, tr, eq, ks] = await Promise.all([
        call("status"),
        supabase.from("agent_trades").select("*").eq("user_id", uid).order("created_at", { ascending: false }).limit(60),
        supabase.from("agent_equity").select("day,equity,spy_close").eq("user_id", uid).order("day"),
        supabase.rpc("alpaca_key_status"),
      ]);
      setConnected(!!st?.connected);
      setAlpacaErr(String(st?.alpacaError ?? ""));
      setAccount(st?.account ?? null);
      setPositions(st?.positions ?? []);
      setCfg(st?.cfg ?? null);
      if (!tr.error) setTrades((tr.data ?? []) as Trade[]);
      if (!eq.error) setCurve((eq.data ?? []) as Equity[]);
      if (!ks.error) setKeyTail(String(ks.data ?? ""));
    } catch { setErr("Couldn't reach the agent — try again."); }
    finally { setLoaded(true); }
  }, [uid, call]);
  useEffect(() => { load(); }, [load]);

  async function saveKeys() {
    if (!kId.trim() || !kSec.trim()) return;
    setBusy("keys"); setErr(""); setMsg("");
    const { error } = await supabase.rpc("set_alpaca_keys", { p_key: kId.trim(), p_secret: kSec.trim() });
    setBusy("");
    if (error) { setErr(error.message); return; }
    setKId(""); setKSec(""); setShowKeys(false);
    setMsg("Keys saved. They live encrypted in the vault — this app never shows them again.");
    sfx.pop();
    await load();
  }

  async function saveCfg(next: Partial<Cfg>) {
    if (!cfg) return;
    const merged = { ...cfg, ...next };
    setCfg(merged);
    const { error } = await supabase.from("user_settings")
      .upsert({ user_id: uid, trader: merged }, { onConflict: "user_id" });
    if (error) { setErr("Couldn't save that setting."); await load(); }
  }

  async function run() {
    if (running.current) return;
    running.current = true; setBusy("run"); setErr(""); setMsg("");
    try {
      const j = await call("run");
      if (j.error) setErr(j.error);
      else if (j.skipped) setMsg(j.skipped);
      else setMsg(`${(j.placed ?? []).length} position${(j.placed ?? []).length === 1 ? "" : "s"} from ${j.candidates} candidate${j.candidates === 1 ? "" : "s"}${j.dry ? " — dry run, no orders sent" : ""}.`);
      if (!j.error) { sfx.coin(); buzz(12); await load(); }
    } catch { setErr("Couldn't reach the agent."); }
    finally { running.current = false; setBusy(""); }
  }

  async function sync() {
    if (running.current) return;
    running.current = true; setBusy("sync"); setErr(""); setMsg("");
    try {
      const j = await call("sync");
      if (j.error) setErr(j.error);
      else setMsg(`${(j.opened ?? []).length} filled, ${(j.closed ?? []).length} closed.`);
      if (!j.error) await load();
    } catch { setErr("Couldn't reach the agent."); }
    finally { running.current = false; setBusy(""); }
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-28" /><div className="skeleton h-40 mt-3" /></div>;

  const open = trades.filter((t) => t.status === "open" || t.status === "pending");
  const closed = trades.filter((t) => t.status === "closed");
  const dry = trades.filter((t) => t.status === "dry");
  const rejected = trades.filter((t) => t.status === "rejected");

  // Benchmark from the marks stored on the day, not re-derived later.
  const first = curve[0], last = curve[curve.length - 1];
  const agentPct = first && last && first.equity > 0 ? ((last.equity - first.equity) / first.equity) * 100 : null;
  const spyPct = first?.spy_close && last?.spy_close ? ((last.spy_close - first.spy_close) / first.spy_close) * 100 : null;

  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  const held = closed.filter((t) => t.verdict === "held").length;

  return (
    <div className="pt-3">
      <SectionTitle>The news agent</SectionTitle>

      <div className="rounded-xl border border-[var(--border-2)] bg-[var(--raised)] px-3.5 py-3">
        <p className="text-[12px] text-[var(--text-2)] leading-relaxed">
          <b>Paper money only.</b> This trades a simulated Alpaca account — the endpoint is hardcoded and
          a live key is refused outright. Nothing here is advice, and a paper record does not transfer to
          real money: no slippage, no emotion, and the agent never sized a position it could actually lose.
        </p>
      </div>

      {/* ── connection ─────────────────────────────────────────────── */}
      <Card className="mt-3">
        <div className="flex items-center gap-2.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: connected ? "var(--ok)" : "var(--text-4)" }} />
          <p className="text-[12px] flex-1 min-w-0 text-[var(--text-2)]">
            {connected
              ? `Alpaca paper connected${keyTail ? ` · key ending ${keyTail}` : ""}`
              : keyTail ? "Keys saved, but Alpaca refused them" : "Not connected to Alpaca yet"}
          </p>
          <button onClick={() => setShowKeys((v) => !v)} className="mono text-[10px] text-[var(--neon)] active:scale-95">
            {showKeys ? "cancel" : connected ? "replace keys" : "connect"}
          </button>
        </div>
        {alpacaErr && <p className="text-[11px] text-orange-400 mt-1.5">{alpacaErr}</p>}

        {showKeys && (
          <div className="mt-3 space-y-2 rise-in">
            <p className="text-[11px] text-[var(--text-3)] leading-relaxed">
              Make a free <b>paper</b> account at alpaca.markets, generate API keys, and paste them here.
              The key id starts with <span className="mono">PK</span> — a live key (<span className="mono">AK</span>) is
              rejected. They go straight to the encrypted vault; this app can never show them back to you.
            </p>
            <input value={kId} onChange={(e) => setKId(e.target.value)} placeholder="Key ID (PK…)"
              autoComplete="off" spellCheck={false}
              className="w-full rounded-lg bg-black/30 px-3 py-2 outline-none text-sm mono" />
            <input value={kSec} onChange={(e) => setKSec(e.target.value)} placeholder="Secret key" type="password"
              autoComplete="off" spellCheck={false}
              className="w-full rounded-lg bg-black/30 px-3 py-2 outline-none text-sm mono" />
            <button onClick={saveKeys} disabled={busy === "keys" || !kId.trim() || !kSec.trim()}
              className="w-full rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2 active:scale-95 disabled:opacity-40">
              {busy === "keys" ? "saving…" : "Save the keys"}
            </button>
          </div>
        )}
      </Card>

      {/* ── scoreboard ─────────────────────────────────────────────── */}
      {(account || curve.length > 0) && (
        <Card className="mt-3">
          <Eyebrow>Against the only benchmark that matters</Eyebrow>
          <div className="flex items-baseline gap-4 mt-2">
            <div>
              <p className="mono text-[26px] font-bold" style={{ color: agentPct === null ? "var(--text-3)" : tone(agentPct) }}>
                {agentPct === null ? "—" : pct(agentPct)}
              </p>
              <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-0.5">the agent</p>
            </div>
            <div>
              <p className="mono text-[26px] font-bold" style={{ color: spyPct === null ? "var(--text-3)" : tone(spyPct) }}>
                {spyPct === null ? "—" : pct(spyPct)}
              </p>
              <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-0.5">S&amp;P 500</p>
            </div>
          </div>
          {curve.length < 2 && (
            <p className="text-[11px] text-[var(--text-4)] mt-2">
              Needs a few days of marks before this means anything. One day of difference is noise, not skill.
            </p>
          )}
          {account && (
            <div className="stat mono text-[11px] text-[var(--text-3)] mt-3 pt-3 border-t border-[var(--border-1)] leading-relaxed">
              <div>equity <b className="text-[var(--text)]">{money(account.equity)}</b> · cash {money(account.cash)}</div>
              {closed.length > 0 && (
                <div>
                  {closed.length} closed · {wins} up · <b className="text-[var(--text)]">{held}</b> where the thesis actually held
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* ── controls ───────────────────────────────────────────────── */}
      {cfg && (
        <Card className="mt-3">
          <Eyebrow className="mb-2">The agent</Eyebrow>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => saveCfg({ dry: !cfg.dry })}
              className={`px-3 py-2 rounded-lg text-xs font-semibold border active:scale-95 ${cfg.dry ? "bg-white/5 border-[var(--border-1)]" : "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40"}`}>
              {cfg.dry ? "Dry run" : "Placing paper orders"}
            </button>
            <button onClick={() => saveCfg({ enabled: !cfg.enabled })}
              className={`px-3 py-2 rounded-lg text-xs font-semibold border active:scale-95 ${cfg.enabled ? "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40" : "bg-white/5 border-[var(--border-1)]"}`}>
              {cfg.enabled ? "Runs nightly" : "Manual only"}
            </button>
            <button onClick={() => saveCfg({ allow_short: !cfg.allow_short })}
              className={`px-3 py-2 rounded-lg text-xs font-semibold border active:scale-95 ${cfg.allow_short ? "bg-[var(--neon)]/15 text-[var(--neon)] border-[var(--neon)]/40" : "bg-white/5 border-[var(--border-1)]"}`}>
              {cfg.allow_short ? "Shorts on" : "Long only"}
            </button>
          </div>
          <p className="text-[11px] text-[var(--text-4)] mt-2 leading-relaxed">
            {cfg.per_trade_pct}% of equity per position · at most {cfg.max_open} open · exits at
            −{cfg.stop_pct}%, +{cfg.take_pct}%, or {cfg.hold_days} days, whichever comes first.
            {cfg.dry && " In dry run the agent still picks and writes a thesis, it just doesn't send the order."}
          </p>
          <div className="flex gap-2 mt-3">
            <button onClick={run} disabled={!!busy}
              className="flex-1 rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2.5 active:scale-95 disabled:opacity-40">
              {busy === "run" ? "reading the news…" : "Run on tonight's briefing"}
            </button>
            <button onClick={sync} disabled={!!busy || !connected}
              className="rounded-lg bg-white/10 text-sm font-semibold px-4 active:scale-95 disabled:opacity-40">
              {busy === "sync" ? "…" : "Sync"}
            </button>
          </div>
          {msg && <p className="text-[11px] text-[var(--ok)] mt-2">{msg}</p>}
          {err && <p className="text-[11px] text-orange-400 mt-2">{err}</p>}
        </Card>
      )}

      {/* ── live positions ─────────────────────────────────────────── */}
      {positions.length > 0 && (
        <Card className="mt-3">
          <Eyebrow className="mb-2">Open right now</Eyebrow>
          <div className="space-y-2">
            {positions.map((p) => {
              const plpc = p.unrealized_plpc * 100;
              return (
                <div key={p.symbol} className="flex items-baseline gap-2">
                  <span className="mono text-sm font-bold w-14">{p.symbol}</span>
                  <span className="mono text-[11px] text-[var(--text-4)] flex-1">
                    {p.qty} @ {money(p.avg_entry_price)} → {money(p.current_price)}
                  </span>
                  <span className="mono text-[12px] font-semibold" style={{ color: tone(plpc) }}>{pct(plpc)}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── the trades, as claims ──────────────────────────────────── */}
      <SectionTitle>What it thought, and whether it was right</SectionTitle>
      {trades.length === 0 ? (
        <Card><p className="note text-[13px] text-[var(--text-3)] leading-relaxed">
          Nothing yet. Build tonight&apos;s briefing on the Card first — the agent only trades names that a real
          story tonight actually touched, so with no briefing it has nothing to act on.
        </p></Card>
      ) : (
        <div className="space-y-2.5">
          {[...open, ...dry, ...closed, ...rejected].map((t) => {
            const v = VERDICT[t.verdict];
            return (
              <Card key={t.id}>
                <div className="flex items-baseline gap-2">
                  <span className="mono text-sm font-bold">{t.symbol}</span>
                  <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-4)]">
                    {t.side === "buy" ? "long" : "short"} · {money(t.notional)} · {"●".repeat(t.conviction)}
                  </span>
                  <span className="flex-1" />
                  {t.status === "closed" && t.pnl_pct !== null ? (
                    <span className="mono text-[13px] font-bold" style={{ color: tone(t.pnl_pct) }}>{pct(t.pnl_pct)}</span>
                  ) : (
                    <span className="mono text-[10px] text-[var(--text-4)]">
                      {t.status === "dry" ? "not sent" : t.status}
                    </span>
                  )}
                </div>

                {t.headline && (
                  <p className="text-[11.5px] text-[var(--text-3)] mt-1.5 leading-snug">
                    {t.source_url
                      ? <a href={t.source_url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2">{t.headline}</a>
                      : t.headline}
                  </p>
                )}
                {t.thesis && <p className="text-[12.5px] mt-1.5 leading-relaxed">{t.thesis}</p>}
                {t.falsifier && (
                  <p className="text-[11.5px] text-[var(--text-3)] mt-1 leading-relaxed">
                    <span className="text-[var(--text-4)]">Wrong if:</span> {t.falsifier}
                  </p>
                )}

                {t.status === "closed" && (
                  <div className="mt-2 pt-2 border-t border-[var(--border-1)]">
                    <p className="mono text-[10px] text-[var(--text-4)]">
                      closed — {t.exit_reason}
                      {v && <span style={{ color: v.tone }}> · {v.label}</span>}
                    </p>
                    {t.lesson && <p className="text-[12px] text-[var(--text-2)] mt-1 leading-relaxed italic">{t.lesson}</p>}
                  </div>
                )}
                {t.status === "rejected" && t.reject_reason && (
                  <p className="text-[11px] text-orange-400 mt-1.5">Alpaca refused it: {t.reject_reason}</p>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-[var(--text-4)] mt-4 leading-relaxed">
        A profitable trade for the wrong reason is not a vindicated thesis, so the agent is graded on whether
        its claim survived, separately from whether the position made money. That column is the one worth
        reading.
      </p>
    </div>
  );
}
