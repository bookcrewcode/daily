"use client";

// Debate — the argument, as a transcript. The news the jury saw, each
// juror's proposals, the rebuttals, the tally, and the judge. Jurors wear
// anonymous letters inside the debate; here their real names are shown, with
// one colour per lab, so Ben learns who tends to be right about what.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow } from "../ui";
import { loadOpinions, loadSessions, modelLabel, labTone, fmtPrice, fmtMoney, type OpinionRow, type SessionRow } from "@/lib/desk/api";
import { templateName } from "@/lib/desk/playbook";
import type { Tally } from "@/lib/desk/vote";

type BriefItem = { i: number; headline: string; why: string; thesis: string; url: string; exposure?: string };
type Proposal = { id?: string; venue: string; instrument: string; symbol: string; side: string; leverage: number; template: number; thesis: string; catalyst: string; what_would_prove_me_wrong: string; entry_ref: number; stop: number; target: number; horizon_days: number; risk_pct: number; confidence: number; evidence: number[]; key_risks: string[]; crosses_event: boolean; dropped?: string };
type Ballot = { proposal_id: string; stance: string; confidence: number; counter: string };

export default function Debate({ uid }: { uid: string }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sel, setSel] = useState<string>("");
  const [ops, setOps] = useState<OpinionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [newsOpen, setNewsOpen] = useState(false);

  const load = useCallback(async () => {
    const s = await loadSessions(uid, 14);
    if (s.error) { setErr(s.error); setLoaded(true); return; }
    const list = s.sessions.filter((x) => x.status !== "dry");
    setSessions(list);
    setSel((cur) => cur && list.some((x) => x.id === cur) ? cur : (list[0]?.id ?? ""));
    setErr(""); setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  useEffect(() => {
    if (!sel) return;
    let live = true;
    Promise.resolve().then(() => loadOpinions(sel)).then((r) => { if (!live) return; if (r.error) setErr(r.error); else setOps(r.opinions); });
    return () => { live = false; };
  }, [sel]);

  if (!loaded) return <div className="pt-3"><div className="skeleton h-12" /><div className="skeleton h-48 mt-3" /></div>;
  const session = sessions.find((s) => s.id === sel) ?? null;

  if (!session) {
    return (
      <Card className="mt-3">
        <p className="text-[13px] leading-relaxed">No debate yet. The transcript of every night lands here: proposals, rebuttals, the tally and the judge.</p>
        {err && <button onClick={load} className="mt-3 w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">{err} — tap to retry</button>}
      </Card>
    );
  }

  const briefing = Array.isArray(session.packet.briefing) ? (session.packet.briefing as BriefItem[]) : [];
  const r1 = ops.filter((o) => o.round === "1");
  const r2 = ops.filter((o) => o.round === "2");
  const judge = ops.find((o) => o.round === "judge");
  const tally = session.votes;
  const jurorName = new Map(r1.map((o) => [o.juror, o.model]));
  const proposals = new Map<string, Proposal>();
  for (const o of r1) for (const p of (Array.isArray(o.content.proposals) ? (o.content.proposals as Proposal[]) : [])) if (p.id) proposals.set(p.id, p);

  return (
    <div>
      {/* day picker */}
      <div className="flex gap-1.5 mt-3 overflow-x-auto no-scrollbar pb-1">
        {sessions.map((s) => (
          <button key={s.id} onClick={() => setSel(s.id)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-semibold transition ${s.id === sel ? "bg-[var(--neon)] text-black" : "bg-white/5 opacity-70"}`}>
            {new Date(s.day + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" })}{s.seq > 1 ? ` · ${s.seq}` : ""}{s.status !== "done" ? ` · ${s.status}` : ""}
          </button>
        ))}
      </div>
      {err && <button onClick={load} className="w-full mt-2 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">{err} — tap to retry</button>}

      {/* the news they saw */}
      <Card className="mt-3">
        <button onClick={() => setNewsOpen((v) => !v)} className="w-full text-left active:scale-[0.995]">
          <div className="flex items-baseline justify-between">
            <Eyebrow>What the jury read</Eyebrow>
            <span className="mono text-[10px] text-[var(--neon)]">{newsOpen ? "close" : `${briefing.length} items · regime ${session.regime || "?"}`}</span>
          </div>
        </button>
        {newsOpen && (
          <div className="mt-2.5 space-y-2.5 rise-in">
            {briefing.map((b) => (
              <div key={b.i} className="border-l-2 border-[var(--border-2)] pl-2.5">
                <p className="text-[12.5px] font-semibold leading-snug"><span className="mono text-[10px] text-[var(--text-4)]">[{b.i}]</span> {b.headline}</p>
                <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed mt-0.5">{b.why}</p>
                {b.thesis && <p className="text-[11px] text-[var(--text-3)] italic mt-0.5">{b.thesis}</p>}
                {b.exposure && <p className="mono text-[10px] text-[var(--text-4)] mt-0.5">{b.exposure}</p>}
                {b.url && <a href={b.url} target="_blank" rel="noopener noreferrer" className="mono text-[9px] text-[var(--text-4)] underline decoration-dotted underline-offset-2">source ↗</a>}
              </div>
            ))}
            {briefing.length === 0 && <p className="text-[12px] text-[var(--text-3)]">The packet for this session holds no briefing items.</p>}
          </div>
        )}
      </Card>

      {/* round 1 */}
      <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-4 mb-1.5">Round 1 · proposals</p>
      <div className="space-y-2">
        {r1.length === 0 && <Card><p className="text-[12px] text-[var(--text-3)]">No proposals were recorded for this session.</p></Card>}
        {r1.map((o) => <JurorBubble key={o.id} op={o} />)}
      </div>

      {/* round 2 */}
      {r2.length > 0 && (
        <>
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-4 mb-1.5">Round 2 · rebuttals and ballots</p>
          <div className="space-y-2">
            {r2.map((o) => (
              <Bubble key={o.id} juror={o.juror} model={o.model} error={o.error}>
                {(Array.isArray(o.content.ballots) ? (o.content.ballots as Ballot[]) : []).map((b, i) => (
                  <p key={i} className="text-[11.5px] leading-snug mt-1">
                    <span className="mono text-[10px]" style={{ color: b.stance === "support" ? "var(--ok)" : b.stance === "oppose" ? "var(--bad)" : "var(--text-4)" }}>
                      {b.stance} {b.proposal_id} ({(b.confidence * 100).toFixed(0)}%)
                    </span>{" "}
                    <span className="text-[var(--text-2)]">{b.counter}</span>
                  </p>
                ))}
                {typeof o.content.change_my_mind === "string" && o.content.change_my_mind && (
                  <p className="text-[11px] text-[var(--text-3)] mt-1.5 italic">Would change my mind: {o.content.change_my_mind}</p>
                )}
              </Bubble>
            ))}
          </div>
        </>
      )}

      {/* tally */}
      {tally.length > 0 && (
        <Card className="mt-4">
          <Eyebrow className="mb-2">The tally</Eyebrow>
          <div className="space-y-1">
            {tally.map((t: Tally) => {
              const p = proposals.get(t.proposal_id);
              return (
                <div key={t.proposal_id} className="flex items-baseline gap-2 text-[11.5px]">
                  <span className="mono text-[10px] text-[var(--text-4)] w-7">{t.proposal_id}</span>
                  <span className="mono font-semibold">{p?.symbol ?? "?"}</span>
                  <span className="text-[var(--text-3)]">{p?.side}{p && p.instrument === "crypto_perp" ? ` ${p.leverage}x` : ""}</span>
                  <span className="flex-1" />
                  <span className="mono text-[10px] text-[var(--text-3)]">{t.support}↑ {t.oppose}↓ of {t.voters}</span>
                  <span className="mono text-[11px] font-bold" style={{ color: t.candidate ? "var(--ok)" : "var(--text-4)" }}>{t.score.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-[var(--text-4)] mt-2 leading-relaxed">
            Score = each juror&apos;s stance (+1 support, −1 oppose) × its confidence, shrunk toward how right that model has been at that confidence, × its rating weight. A proposal needs half the room and at least three voters to reach the judge.
          </p>
        </Card>
      )}

      {/* judge */}
      {judge && (
        <div className="mt-4">
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1.5">The judge · {modelLabel(judge.model)}</p>
          <Card tone="neon">
            {judge.error ? <p className="text-[12px] text-orange-400">Did not answer: {judge.error}</p> : (
              <>
                <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap">{String(judge.content.narrative ?? "")}</p>
                {Array.isArray(judge.content.decisions) && (judge.content.decisions as { proposal_id: string; action: string; reason: string; size_multiplier?: number; leverage?: number }[]).map((d, i) => (
                  <p key={i} className="text-[11.5px] mt-1.5 leading-snug">
                    <span className="mono text-[10px]" style={{ color: d.action === "take" ? "var(--ok)" : d.action === "veto" ? "var(--bad)" : "var(--warn)" }}>{d.action} {d.proposal_id}</span>{" "}
                    <span className="text-[var(--text-2)]">{d.reason}</span>
                  </p>
                ))}
                {typeof judge.content.lesson === "string" && judge.content.lesson && <p className="text-[12px] text-[var(--text-2)] mt-2.5 leading-relaxed"><span className="text-[var(--text-4)]">Lesson:</span> {judge.content.lesson}</p>}
                <p className="mono text-[9px] text-[var(--text-4)] mt-2">{fmtMoney(judge.cost_usd, 3)} · {(judge.latency_ms / 1000).toFixed(0)}s</p>
              </>
            )}
          </Card>
        </div>
      )}

      {/* ask the desk: phase 4 */}
      <Card className="mt-4">
        <Eyebrow className="mb-1.5">Ask the desk</Eyebrow>
        <p className="text-[11.5px] text-[var(--text-3)] leading-relaxed">Questions about this debate, answered with the packet and the transcript in hand, arrive with phase 4.</p>
      </Card>

      <p className="mono text-[9px] text-[var(--text-4)] mt-3">{jurorName.size} jurors · session cost {fmtMoney(session.cost_usd, 2)}</p>
    </div>
  );
}

function Bubble({ juror, model, error, children }: { juror: string; model: string; error: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl px-3 py-2.5 bg-black/30 mr-2 border border-[var(--border-1)]">
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: labTone(model) }} />
        <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-3)]">Juror {juror} · {modelLabel(model)}</span>
      </div>
      {error ? <p className="text-[11.5px] text-orange-400 mt-1">Did not answer: {error}</p> : children}
    </div>
  );
}

function JurorBubble({ op }: { op: OpinionRow }) {
  const c = op.content;
  const proposals = Array.isArray(c.proposals) ? (c.proposals as Proposal[]) : [];
  return (
    <Bubble juror={op.juror} model={op.model} error={op.error}>
      {typeof c.market_read === "string" && c.market_read && <p className="text-[12px] text-[var(--text-2)] leading-relaxed mt-1">{c.market_read}</p>}
      {c.no_trade === true && <p className="text-[11.5px] text-[var(--warn)] mt-1.5">No trade. {String(c.no_trade_reason ?? "")}</p>}
      {proposals.map((p, i) => (
        <div key={i} className={`mt-2 rounded-lg border px-2.5 py-2 ${p.dropped ? "border-orange-500/30 opacity-70" : "border-[var(--border-1)] bg-[var(--raised)]"}`}>
          <div className="flex items-baseline gap-2">
            <span className="mono text-[10px] text-[var(--text-4)]">{p.id ?? ""}</span>
            <span className="mono text-[12px] font-bold">{p.symbol}</span>
            <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-4)]">{p.side}{p.instrument === "crypto_perp" ? ` ${p.leverage}x` : ""} · {p.venue}</span>
            <span className="flex-1" />
            <span className="mono text-[10px] text-[var(--text-3)]">{(p.confidence * 100).toFixed(0)}%</span>
          </div>
          <p className="mono text-[10px] text-[var(--text-4)] mt-0.5">
            ref {fmtPrice(p.entry_ref)} · stop {fmtPrice(p.stop)} · target {fmtPrice(p.target)} · {p.horizon_days}d · risk {p.risk_pct}% · {p.template ? templateName(p.template) : "no template"}{p.crosses_event ? " · crosses an event" : ""}
          </p>
          <p className="text-[11.5px] leading-snug mt-1">{p.thesis}</p>
          <p className="text-[11px] text-[var(--text-3)] mt-0.5"><span className="text-[var(--text-4)]">Wrong if:</span> {p.what_would_prove_me_wrong}</p>
          {p.dropped && <p className="text-[10px] text-orange-400 mt-0.5">Dropped by the guardrail: {p.dropped}</p>}
        </div>
      ))}
      <p className="mono text-[9px] text-[var(--text-4)] mt-1.5">{fmtMoney(op.cost_usd, 3)} · {(op.latency_ms / 1000).toFixed(0)}s</p>
    </Bubble>
  );
}
