"use client";

// Sits — the jury before every intraday trade. A coded strategy flags a
// setup; three fast models read it with the headlines and vote take or pass
// with a confidence, may tighten the levels, and the desk takes it only on a
// majority with a positive weighted score and a fresh price check. Every
// ballot is kept and scored later against what the setup's own shadow book
// did, so a model that passes on winners loses rating too.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow } from "../ui";
import { loadSits, modelLabel, labTone, fmtPrice, fmtMoney, type SitRow } from "@/lib/desk/api";
import { STRATEGIES } from "@/lib/desk/scan";

const TF: Record<string, string> = { scalp: "scalp · hours", swing: "swing · days", position: "position · weeks" };
const stratName = (id: string) => STRATEGIES.find((s) => s.id === id)?.name ?? id;
type Setup = { symbol?: string; side?: string; venue?: string; instrument?: string; entry_ref?: number; stop?: number; target?: number; leverage_hint?: number; score?: number; reasons?: { label: string; value: string; ok: boolean; core: boolean }[]; invalidation?: string };
type Decision = { take?: boolean; taken?: boolean; score?: number; answered?: number; takers?: number; reasons?: string[]; sized?: { qty: number; unit: string; notional: number; leverage: number; entry: number; stop: number; target: number } };

export default function Sits({ uid }: { uid: string }) {
  const [sits, setSits] = useState<SitRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    const r = await loadSits(uid, 80, 72);
    setErr(r.error);
    if (!r.error) setSits(r.sits);
    setNow(Date.now());
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);
  useEffect(() => { const id = setInterval(load, 60_000); return () => clearInterval(id); }, [load]);

  if (!loaded) return <div className="pt-3"><div className="skeleton h-16" /><div className="skeleton h-48 mt-3" /></div>;

  const done = sits.filter((s) => s.status === "done");
  const taken = done.filter((s) => (s.decision as Decision).taken).length;
  const spent = sits.reduce((a, s) => a + s.cost_usd, 0);

  return (
    <div>
      <Card className="mt-3">
        <Eyebrow className="mb-1.5">A jury before every trade</Eyebrow>
        <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed">
          The scan flags a setup; three fast models read it with the day&apos;s headlines and vote take or pass, each with a confidence that the target is hit before the stop. The desk takes it only when at least two say take and the weighted score is positive, then checks the price again: through the stop, or already more than half way to the target, and it passes. A taker may tighten the stop or target and lower the leverage, never widen them. Every ballot is scored later against what the setup&apos;s own shadow book did.
        </p>
        <p className="mono text-[10px] text-[var(--text-4)] mt-2">{sits.length} sits in three days · {taken} taken of {done.length} decided · {fmtMoney(spent, 2)} spent · about a cent a sit</p>
      </Card>
      {err && <button onClick={load} className="w-full mt-2 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">{err} — tap to retry</button>}
      {sits.length === 0 && <Card className="mt-3"><p className="text-[12px] text-[var(--text-3)]">No sits yet. The first opens at the five-minute tick after the scan finds a setup.</p></Card>}
      <div className="mt-3 space-y-2">
        {sits.map((s) => <SitCard key={s.id} sit={s} now={now} isOpen={open === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} />)}
      </div>
    </div>
  );
}

function SitCard({ sit, now, isOpen, onToggle }: { sit: SitRow; now: number; isOpen: boolean; onToggle: () => void }) {
  const setup = ((sit.brief as { setup?: Setup }).setup ?? {}) as Setup;
  const d = sit.decision as Decision;
  const status = sit.status === "launched" ? "jury sitting" : sit.status === "failed" ? "failed" : d.taken ? "taken" : d.take ? "take, not placed" : "passed";
  const color = status === "taken" ? "var(--ok)" : status === "jury sitting" ? "var(--neon)" : status === "failed" ? "var(--bad)" : "var(--text-4)";
  const rr = setup.entry_ref && setup.stop && setup.target ? Math.abs(setup.target - setup.entry_ref) / Math.abs(setup.entry_ref - setup.stop) : null;
  const checks = [...(setup.reasons ?? []).filter((r) => r.core), ...(setup.reasons ?? []).filter((r) => !r.core)];
  const showDecision = !!(d.sized || (d.reasons && d.reasons.length));
  return (
    <Card>
      <button onClick={onToggle} className="w-full text-left active:scale-[0.995]">
        <div className="flex items-baseline gap-2">
          <span className="mono text-sm font-bold">{sit.symbol}</span>
          <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-4)]">{setup.side}{setup.instrument === "crypto_perp" && setup.leverage_hint ? ` · up to ${setup.leverage_hint}x` : ""} · {TF[sit.timeframe] ?? sit.timeframe}</span>
          <span className="flex-1" />
          <span className="mono text-[10px] font-semibold shrink-0" style={{ color }}>{status}</span>
        </div>
        <p className="text-[11.5px] text-[var(--text-2)] mt-1 leading-snug">
          {stratName(sit.strategy)} · {ago(sit.created_at, now)}{d.answered !== undefined ? ` · ${d.takers ?? 0} of ${d.answered} said take · score ${(d.score ?? 0) >= 0 ? "+" : ""}${(d.score ?? 0).toFixed(2)}` : ""}
        </p>
        {setup.entry_ref !== undefined && (
          <p className="mono text-[10px] text-[var(--text-4)] mt-1">
            ref {fmtPrice(setup.entry_ref)} · <span style={{ color: "var(--bad)" }}>stop {fmtPrice(setup.stop ?? 0)}</span> · <span style={{ color: "var(--ok)" }}>target {fmtPrice(setup.target ?? 0)}</span>{rr !== null ? ` · ${rr.toFixed(1)}:1` : ""} · confluence {((setup.score ?? 0) * 100).toFixed(0)}%
          </p>
        )}
      </button>
      {isOpen && (
        <div className="mt-2.5 pt-2.5 border-t border-[var(--border-1)] rise-in space-y-2.5">
          <div>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">The setup&apos;s checks · core must all hold</p>
            {checks.map((r, i) => (
              <p key={i} className="text-[11px] leading-snug">
                <span className="mono text-[9px]" style={{ color: r.ok ? "var(--ok)" : "var(--bad)" }}>{r.ok ? "ok" : "no"}</span> <span className="text-[var(--text-2)]">{r.label}</span> <span className="text-[var(--text-4)]">{r.value}</span>{r.core ? null : <span className="mono text-[8px] text-[var(--text-4)]"> · confirmation</span>}
              </p>
            ))}
            {setup.invalidation && <p className="text-[11px] text-[var(--text-3)] mt-1"><span className="text-[var(--text-4)]">Wrong if:</span> {setup.invalidation}</p>}
          </div>
          <div>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">The ballots</p>
            {sit.votes.length === 0 && <p className="text-[11px] text-[var(--text-3)]">{sit.status === "launched" ? "Still coming in: each juror answers in its own call, usually within a minute, and the next tick counts them." : "No ballots were recorded."}</p>}
            <div className="space-y-1.5">
              {sit.votes.map((v, i) => (
                <div key={i} className="rounded-lg bg-black/30 border border-[var(--border-1)] px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: labTone(v.model) }} />
                    <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-3)] flex-1 min-w-0 truncate">{modelLabel(v.model)}</span>
                    {v.error ? <span className="mono text-[10px] text-orange-400">no answer</span> : (
                      <span className="mono text-[10px] font-semibold" style={{ color: v.stance === "take" ? "var(--ok)" : "var(--text-4)" }}>{v.stance} · {(v.confidence * 100).toFixed(0)}%</span>
                    )}
                  </div>
                  {v.error ? <p className="text-[10.5px] text-orange-400 mt-1">{v.error}</p> : (
                    <>
                      {v.thesis && <p className="text-[11.5px] leading-snug mt-1">{v.thesis}</p>}
                      {v.what_would_prove_me_wrong && <p className="text-[11px] text-[var(--text-3)] mt-0.5"><span className="text-[var(--text-4)]">Wrong if:</span> {v.what_would_prove_me_wrong}</p>}
                      <p className="mono text-[9px] text-[var(--text-4)] mt-1">
                        {v.stop ? `stop ${fmtPrice(v.stop)}` : ""}{v.target ? ` · target ${fmtPrice(v.target)}` : ""}{v.leverage && setup.instrument === "crypto_perp" ? ` · ${v.leverage}x` : ""}{Array.isArray(v.tags) && v.tags.length ? ` · ${v.tags.join(", ")}` : ""}
                      </p>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
          {showDecision && (
            <div>
              <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1">The decision</p>
              {d.sized && <p className="mono text-[10.5px] text-[var(--text-2)]">{d.sized.qty} {d.sized.unit}{d.sized.qty === 1 ? "" : "s"} · {fmtMoney(d.sized.notional)} notional{d.sized.leverage > 1 ? ` · ${d.sized.leverage}x` : ""} · in at {fmtPrice(d.sized.entry)} · stop {fmtPrice(d.sized.stop)} · target {fmtPrice(d.sized.target)}</p>}
              {(d.reasons ?? []).map((r, i) => <p key={i} className="text-[11px] text-[var(--text-3)] leading-snug mt-0.5">{r}</p>)}
            </div>
          )}
          <p className="mono text-[9px] text-[var(--text-4)]">{fmtMoney(sit.cost_usd, 3)}{sit.error ? ` · ${sit.error}` : ""}</p>
        </div>
      )}
    </Card>
  );
}

function ago(iso: string, now: number): string {
  const m = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m) || m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
