"use client";

// Report — the 08:30 morning report on Ben's holdings. The numbers come from
// the data the server gathered (prices, tagged news, the events calendar); the
// summary, what to watch and the line per stock come from one AI call. Older
// reports stay readable under today's.

import { useCallback, useEffect, useState } from "react";
import { Card } from "../ui";
import { fmtPct } from "@/lib/desk/api";
import { etDate, etParts, isTradingDay } from "@/lib/desk/clock";
import { loadReports, spentSince, writeReportNow, type ReportRowFull } from "@/lib/portfolio/api";
import { etMidnightMs } from "@/lib/portfolio/weekly";
import { REPORT_ESTIMATE_USD, type ReportNews } from "@/lib/portfolio/report";
import { toneOf } from "./fmt";

export default function Report({ uid, hasHoldings, paused, capUsd }: { uid: string; hasHoldings: boolean; paused: boolean; capUsd: number }) {
  const [reports, setReports] = useState<ReportRowFull[]>([]);
  const [spent, setSpent] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [now, setNow] = useState(0); // set on each load, so render stays pure

  const load = useCallback(async () => {
    const t = Date.now();
    const [r, s] = await Promise.all([loadReports(uid, 8), spentSince(new Date(etMidnightMs(etDate(t))).toISOString())]);
    setNow(t);
    setReports(r.reports);
    setSpent(s);
    setErr(r.error);
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 60_000); // the 08:30 report shows up without a reload
    return () => clearInterval(id);
  }, [load]);

  const writeNow = async () => {
    setBusy(true);
    setErr("");
    const r = await writeReportNow();
    setBusy(false);
    if (r.error) setErr(r.error);
    await load();
  };

  if (!loaded) return <div className="mt-3 skeleton h-40" />;

  const p = etParts(now);
  const today = p.date;
  const todays = reports.find((x) => x.day === today) ?? null;
  const done = reports.filter((x) => x.status === "done");
  const shown = done.find((x) => x.day === pick) ?? done[0] ?? null;
  const beforeTime = p.hour * 60 + p.minute < 8 * 60 + 30;
  const budgetGone = spent !== null && spent + REPORT_ESTIMATE_USD > capUsd;
  const canWrite = hasHoldings && !paused && !busy && !budgetGone && (!todays || (todays.status !== "running" && todays.tries < 3));

  let status: string;
  if (!hasHoldings) status = "Add what you own on the Holdings page first; the report is about your stocks.";
  else if (paused) status = "The copilot is paused in Settings, so no report is written.";
  else if (todays?.status === "done") status = `Today's report is below.`;
  else if (todays?.status === "running") status = "Today's report is being written right now.";
  else if (todays?.status === "failed") status = `Today's report didn't work: ${todays.error}${todays.tries >= 3 ? " It tries again tomorrow." : ""}`;
  else if (budgetGone) status = `Today's AI budget is used up ($${(spent ?? 0).toFixed(2)} of your $${capUsd.toFixed(2)} limit), so the report and the news reading resume after midnight New York time.`;
  else if (!isTradingDay(today)) status = "The market is closed today, so no report is written on its own.";
  else if (beforeTime) status = "Today's report arrives at 8:30 New York time.";
  else status = "Today's report hasn't arrived yet. It retries every five minutes until the close.";

  return (
    <div className="mt-3 space-y-3">
      <Card>
        <p className="text-[13px] text-[var(--text-2)] leading-relaxed">{status}</p>
        {canWrite && todays?.status !== "done" && (
          <button onClick={writeNow} className="mt-3 w-full rounded-lg bg-[var(--neon)] text-black text-xs font-semibold py-2.5 active:scale-95">Write it now</button>
        )}
        {busy && <p className="text-[11px] text-[var(--text-3)] mt-2">Writing. This takes up to a minute.</p>}
        {err && <p className="text-[11px] text-orange-400 mt-2">{err}</p>}
        <p className="text-[10px] text-[var(--text-4)] mt-2">
          AI cost today: {spent === null ? "couldn't load" : `$${spent.toFixed(2)}`}. The daily limit is in Settings; the report costs about one to two cents, and reading the news a few cents a day.
        </p>
      </Card>

      {shown && <ReportView r={shown} />}

      {done.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {done.map((x) => (
            <button key={x.day} onClick={() => setPick(x.day)} className={`rounded-lg px-2.5 py-1.5 mono text-[10px] ${x.day === shown?.day ? "bg-[var(--neon)] text-black font-semibold" : "bg-white/[0.04] opacity-70"}`}>{x.day}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportView({ r }: { r: ReportRowFull }) {
  const out = r.output;
  const inp = r.input;
  const lines = new Map((out.per_holding ?? []).map((x) => [x.symbol, x.line]));
  return (
    <Card>
      <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">Morning report · {r.day}</p>
      <p className="text-[14px] leading-relaxed mt-2">{out.summary}</p>

      {!!out.watch?.length && (
        <div className="mt-3">
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">What to watch</p>
          <ul className="mt-1 space-y-1 list-disc pl-4">{out.watch.map((w, i) => <li key={i} className="text-[13px] leading-relaxed">{w}</li>)}</ul>
        </div>
      )}

      {(inp.holdings ?? []).map((h) => (
        <div key={h.symbol} className="mt-3 border-t border-[var(--border-1)] pt-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">{h.symbol}</p>
            <p className="mono text-[11px]">
              ${h.price.toFixed(2)} · day <span style={{ color: toneOf(h.ret1d) }}>{fmtPct(h.ret1d)}</span> · week <span style={{ color: toneOf(h.ret5d) }}>{fmtPct(h.ret5d)}</span>
            </p>
          </div>
          {lines.get(h.symbol) && <p className="text-[13px] leading-relaxed mt-1 text-[var(--text-2)]">{lines.get(h.symbol)}</p>}
          {(inp.news ?? []).filter((x) => x.symbols.includes(h.symbol)).map((x) => <NewsLine key={x.link} n={x} />)}
        </div>
      ))}

      {!!inp.macro?.length && (
        <div className="mt-3 border-t border-[var(--border-1)] pt-2">
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">Economy and market news</p>
          {inp.macro.map((x) => <NewsLine key={x.link} n={x} />)}
        </div>
      )}

      {!!inp.events?.length && (
        <div className="mt-3 border-t border-[var(--border-1)] pt-2">
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">Coming up in the next two weeks</p>
          {inp.events.map((e, i) => <p key={i} className="text-[12px] mt-1">{e.day}{e.time_et ? ` ${e.time_et} ET` : ""} · {e.label}</p>)}
        </div>
      )}

      {!!inp.market?.length && (
        <div className="mt-3 border-t border-[var(--border-1)] pt-2">
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">The market at yesterday&apos;s close</p>
          <div className="grid grid-cols-2 gap-2 mt-1">
            {inp.market.map((m) => (
              <div key={m.label}>
                <p className="mono text-[12px]">
                  {m.unit === "pts" ? `${m.level.toFixed(2)}%` : m.level.toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
                  <span style={{ color: toneOf(m.change) }}>{m.unit === "pts" ? `${m.change >= 0 ? "+" : ""}${m.change.toFixed(2)} pts` : fmtPct(m.change)}</span>
                </p>
                <p className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)]">{m.label}</p>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-[var(--text-4)] mt-2 leading-relaxed">
            Day is the change at yesterday&apos;s close; week is the last five trading days. The 10-year Treasury yield is the interest rate on 10-year US government bonds; when it rises, fast-growing stocks often fall. Pts means percentage points.
          </p>
        </div>
      )}

      <p className="text-[10px] text-[var(--text-4)] mt-3">Prices, news and dates come from the data. The AI ({r.model}) only wrote the words, for ${r.cost_usd.toFixed(3)}.</p>
    </Card>
  );
}

function NewsLine({ n }: { n: ReportNews }) {
  return (
    <div className="mt-1.5">
      <a href={n.link} target="_blank" rel="noreferrer" className="text-[12px] font-semibold underline decoration-white/20 underline-offset-2">{n.title}</a>
      <p className="text-[12px] text-[var(--text-2)] leading-relaxed">{n.plain} <span className="text-[var(--text-4)]">({n.source})</span></p>
    </div>
  );
}
