"use client";

// Tonight — the verdict. What the jury decided, why, what it turned down,
// and the one thing Ben should take from the night. Also the button that
// runs the desk by hand, which walks the same stages the cron walks.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card, Eyebrow, SectionTitle } from "../ui";
import { sfx, buzz } from "@/lib/fx";
import { callFn, DESK_FN, loadSessions, loadTrades, fmtMoney, fmtPrice, modelLabel, type Account, type SessionRow } from "@/lib/desk/api";
import { isNyseOpen, sessionBounds, nextSessionDate, etParts } from "@/lib/desk/clock";
import { templateName } from "@/lib/desk/playbook";
import type { Trade } from "@/lib/desk/types";

type CalEvent = { day: string; time_et: string; kind: string; label: string };
type BriefItem = { i: number; headline: string; url: string };
const STAGE_TEXT: Record<string, string> = { packet: "reading the news and the tape…", round1: "the jurors are writing their proposals…", round2: "the jurors are arguing…", judge: "the judge is writing…", done: "done" };
// "round1:5" while five jurors are still answering in their own invocations.
function stageLabel(stage: string): string {
  const [base, n] = stage.split(":");
  const text = STAGE_TEXT[base] ?? base;
  return n ? `${text} · ${n} still answering` : text;
}
const VENUE: Record<string, string> = { robinhood: "Robinhood", blofin: "BloFin" };

function clockLine(today: string): string {
  const now = Date.now();
  const p = etParts(now);
  if (isNyseOpen(now)) {
    const b = sessionBounds(p.date)!;
    return `NYSE open · closes ${new Date(b.closeMs).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET`;
  }
  const b = sessionBounds(p.date);
  const nextDay = b && now < b.openMs ? p.date : nextSessionDate(p.date);
  const nb = sessionBounds(nextDay);
  const when = nb ? new Date(nb.openMs).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) : nextDay;
  return `NYSE closed · opens ${when} ET${today !== p.date ? "" : ""}`;
}

export default function Tonight({ uid, account, today, onRan }: { uid: string; account: Account; today: string; onRan: () => void }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [stage, setStage] = useState("");
  const [runErr, setRunErr] = useState("");
  const running = useRef(false);

  const load = useCallback(async () => {
    const s = await loadSessions(uid, 40);
    if (s.error) { setErr(s.error); setLoaded(true); return; }
    setSessions(s.sessions);
    const latest = s.sessions.find((x) => x.status !== "dry");
    if (latest) {
      const t = await loadTrades(uid, { sessionId: latest.id, owner: "desk" });
      if (!t.error) setTrades(t.trades);
    } else setTrades([]);
    const { data } = await supabase.from("desk_calendar").select("day,time_et,kind,label").gte("day", today).order("day").limit(4);
    setEvents(((data ?? []) as CalEvent[]).filter((e) => e.kind !== "holiday" && e.kind !== "early_close"));
    setErr(""); setLoaded(true);
  }, [uid, today]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function run(force = false) {
    if (running.current) return;
    running.current = true; setRunErr(""); setStage("packet");
    try {
      // Each call moves one stage or reports that jurors are still answering
      // in their own invocations; poll every 15s, for at most 15 minutes.
      for (let i = 0; i < 60; i++) {
        const r = await callFn<{ stage?: string; next?: boolean; waiting?: boolean; pending?: string[]; error?: string }>(DESK_FN, { mode: "run", day: today, force: force && i === 0 }, 150_000);
        if (r.error) { setRunErr(r.error); break; }
        setStage(r.waiting ? `${r.stage ?? ""}:${(r.pending ?? []).length}` : (r.stage ?? ""));
        if (!r.next) break;
        if (r.waiting) await new Promise((res) => setTimeout(res, 15_000));
      }
      await load();
      sfx.coin(); buzz(12);
      onRan();
    } catch { setRunErr("Couldn't reach the desk."); }
    finally { running.current = false; setStage(""); }
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-16" /><div className="skeleton h-48 mt-3" /></div>;

  const latest = sessions.find((s) => s.status !== "dry") ?? null;
  const isToday = latest?.day === today;
  const verdict = latest?.verdict ?? {};
  const briefing = (Array.isArray(latest?.packet?.briefing) ? (latest!.packet.briefing as BriefItem[]) : []);
  const month = today.slice(0, 7);
  const monthCost = sessions.filter((s) => s.day.startsWith(month)).reduce((a, s) => a + s.cost_usd, 0);
  const failed = Array.isArray((verdict as Record<string, unknown>).failed) ? ((verdict as Record<string, unknown>).failed as { model: string; error: string }[]) : [];
  const halted = !!account.halted_until && account.halted_until >= today;

  return (
    <div>
      <Card className="mt-3">
        <div className="flex items-baseline justify-between">
          <Eyebrow>The clock</Eyebrow>
          <span className="mono text-[9px] text-[var(--text-4)]">crypto always on</span>
        </div>
        <p className="mono text-[12px] mt-1.5">{clockLine(today)}</p>
        {events.length > 0 && (
          <p className="text-[11px] text-[var(--text-3)] mt-1">
            Next on the calendar: {events.slice(0, 2).map((e) => `${e.label} ${new Date(e.day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}${e.time_et ? ` ${e.time_et} ET` : ""}`).join(" · ")}
          </p>
        )}
      </Card>

      {err && <button onClick={load} className="w-full mt-3 rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">{err} — tap to retry</button>}

      {/* ── the verdict ────────────────────────────────────────────── */}
      <SectionTitle>{isToday ? "Tonight's verdict" : latest ? `Last verdict · ${latest.day}` : "No verdict yet"}</SectionTitle>
      {!latest ? (
        <Card>
          <p className="text-[13px] leading-relaxed">The jury sits at 9:30pm ET, after the briefing. Seven models from seven labs read the same news and tape, propose, argue, and vote; the judge can only veto.</p>
          <p className="text-[12px] text-[var(--text-3)] mt-1.5 leading-relaxed">Run it now if tonight&apos;s briefing is already built.</p>
        </Card>
      ) : latest.status === "running" ? (
        <Card tone="neon">
          <p className="text-[13px] font-semibold">The jury is sitting.</p>
          <p className="text-[12px] text-[var(--text-3)] mt-1">{STAGE_TEXT[latest.stage] ?? latest.stage}. Started {new Date(latest.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}. The next cron tick carries it forward; or press Run to push it along.</p>
        </Card>
      ) : latest.status === "failed" || latest.status === "skipped" ? (
        <Card tone="warn">
          <p className="text-[13px] font-semibold">{latest.status === "failed" ? "The run failed." : "The run was skipped."}</p>
          <p className="text-[12px] text-[var(--text-2)] mt-1 leading-relaxed">{latest.error || "No reason was recorded."}</p>
        </Card>
      ) : (
        <>
          <Card>
            {latest.seq > 1 && <p className="mono text-[9px] uppercase tracking-widest text-[var(--warn)] mb-1.5">re-run {latest.seq} of the night · orders were not queued twice</p>}
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{verdict.narrative || "The judge left no narrative."}</p>
            <p className="mono text-[10px] text-[var(--text-4)] mt-2.5">
              regime {latest.regime || "unknown"} · judge {modelLabel(latest.judge_model || account.judge)} · this run {fmtMoney(latest.cost_usd, 2)} · this month {fmtMoney(monthCost, 2)}
            </p>
          </Card>

          {trades.length === 0 ? (
            <Card className="mt-2.5"><p className="text-[12.5px] text-[var(--text-3)] leading-relaxed">No trade tonight. {halted ? "The account is halted, so nothing could be queued." : "Sitting out is a scored answer: if the night turns out quiet, every juror who said so gets credit."}</p></Card>
          ) : (
            <div className="space-y-2.5 mt-2.5">
              {trades.map((t) => (
                <Card key={t.id}>
                  <div className="flex items-baseline gap-2">
                    <span className="mono text-sm font-bold">{t.symbol}</span>
                    <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-4)]">
                      {VENUE[t.venue]} · {t.side}{t.side === "short" ? " · paper" : ""}{t.instrument === "crypto_perp" ? ` · ${t.leverage}x` : ""} · {t.qty} {t.unit}{t.qty === 1 ? "" : "s"}
                    </span>
                    <span className="flex-1" />
                    <span className="mono text-[10px] text-[var(--text-4)]">{t.status === "pending" ? (t.fill_rule === "next_hour" ? "fills next hour" : "fills at the open") : t.status}</span>
                  </div>
                  <p className="mono text-[11px] text-[var(--text-3)] mt-1.5">
                    ref {fmtPrice(t.entry_ref)} · <span style={{ color: "var(--bad)" }}>wrong at {fmtPrice(t.stop)}</span> · <span style={{ color: "var(--ok)" }}>target {fmtPrice(t.target)}</span>
                    {t.liq_price ? <> · <span className="text-[var(--warn)]">liq {fmtPrice(t.liq_price)}</span></> : null} · {t.horizon_days}d · risk {t.risk_pct}% · notional {fmtMoney(t.notional)}
                  </p>
                  <p className="mono text-[10px] text-[var(--text-4)] mt-1">{t.template ? `${t.template}. ${templateName(t.template)}` : "no template"} · confidence {(t.confidence * 100).toFixed(0)}%</p>
                  <p className="text-[12.5px] mt-1.5 leading-relaxed">{t.thesis}</p>
                  <p className="text-[11.5px] text-[var(--text-3)] mt-1 leading-snug"><span className="text-[var(--text-4)]">Wrong if:</span> {t.falsifier}</p>
                  {t.evidence.length > 0 && briefing.length > 0 && (
                    <div className="flex flex-wrap gap-x-2.5 gap-y-1 mt-1.5">
                      {t.evidence.map((i) => briefing.find((b) => b.i === i)).filter((b): b is BriefItem => !!b).map((b) => (
                        b.url ? <a key={b.i} href={b.url} target="_blank" rel="noopener noreferrer" className="mono text-[9px] text-[var(--text-4)] underline decoration-dotted underline-offset-2">[{b.i}] {b.headline.slice(0, 60)}{b.headline.length > 60 ? "…" : ""} ↗</a>
                          : <span key={b.i} className="mono text-[9px] text-[var(--text-4)]">[{b.i}] {b.headline.slice(0, 60)}</span>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}

          {Array.isArray(verdict.why_not) && verdict.why_not.length > 0 && (
            <Card className="mt-2.5">
              <Eyebrow className="mb-1.5">Why not the others</Eyebrow>
              <div className="space-y-1.5">
                {verdict.why_not.map((w, i) => (
                  <p key={i} className="text-[11.5px] text-[var(--text-2)] leading-snug"><span className="mono text-[10px] text-[var(--text-4)]">{w.proposal_id}</span> {w.reason}</p>
                ))}
              </div>
            </Card>
          )}

          {verdict.lesson && (
            <Card className="mt-2.5" tone="neon">
              <Eyebrow className="mb-1.5">Tonight&apos;s lesson</Eyebrow>
              <p className="text-[12.5px] leading-relaxed">{verdict.lesson}</p>
            </Card>
          )}

          {failed.length > 0 && (
            <p className="text-[11px] text-orange-400 mt-2.5 leading-relaxed">
              Did not answer: {failed.map((f) => `${modelLabel(f.model)} (${f.error})`).join(", ")}. The debate went on with the rest.
            </p>
          )}
        </>
      )}

      {/* ── run it ─────────────────────────────────────────────────── */}
      <Card className="mt-3">
        <button onClick={() => run(!!isToday && latest?.status === "done")} disabled={!!stage}
          className="w-full rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2.5 active:scale-95 disabled:opacity-40">
          {stage ? stageLabel(stage) : isToday && latest?.status === "done" ? "Run the desk again tonight" : "Run the desk now"}
        </button>
        <p className="text-[10px] text-[var(--text-4)] mt-2 leading-relaxed">
          Runs automatically at 9:30pm ET after the briefing. A run costs about {fmtMoney(0.45, 2)} with the default jury; the cap is {fmtMoney(account.budget_usd_per_run, 2)}. A second run tonight is recorded separately and does not queue orders twice.
        </p>
        {runErr && <p className="text-[11px] text-orange-400 mt-2">{runErr}</p>}
      </Card>
    </div>
  );
}
