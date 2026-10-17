"use client";

// Settings — the weekly buy the app records (Robinhood does the buying), the
// daily AI budget, and the pause switch. Changing the weekly buy starts the
// record from today: buys before today are already in what Ben typed.

import { useState } from "react";
import { Card } from "../ui";
import { etDate } from "@/lib/desk/clock";
import { saveSettings, type PfSettings } from "@/lib/portfolio/api";

const DAYS: [number, string][] = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"]];

export default function PortfolioSettings({ uid, settings, onSaved }: { uid: string; settings: PfSettings; onSaved: () => void }) {
  const [rows, setRows] = useState<{ symbol: string; usd: string }[]>(
    settings.recurring.length ? settings.recurring.map((r) => ({ symbol: r.symbol, usd: String(r.usd) })) : [{ symbol: "", usd: "" }],
  );
  const [dow, setDow] = useState(settings.buy_dow);
  const [cap, setCap] = useState(String(settings.cap_usd_day));
  const [paused, setPaused] = useState(settings.paused);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const recurring = rows.map((r) => ({ symbol: r.symbol.trim().toUpperCase(), usd: Number(r.usd) })).filter((r) => r.symbol || r.usd);
    if (recurring.some((r) => !/^[\^A-Z0-9.\-]{1,14}$/.test(r.symbol) || !(r.usd > 0))) { setMsg("Each weekly buy needs a ticker and a dollar amount above zero."); return; }
    const c = Number(cap);
    if (!(c >= 0 && c <= 5)) { setMsg("The daily AI limit must be between $0 and $5."); return; }
    const scheduleChanged = JSON.stringify(recurring) !== JSON.stringify(settings.recurring.map((r) => ({ symbol: r.symbol, usd: r.usd }))) || dow !== settings.buy_dow;
    setBusy(true);
    const e = await saveSettings(uid, { recurring, buy_dow: dow, cap_usd_day: c, paused, ...(scheduleChanged ? { recurring_since: etDate(Date.now()) } : {}) });
    setBusy(false);
    setMsg(e || "Saved.");
    if (!e) onSaved();
  };

  return (
    <div className="mt-3 space-y-3">
      <Card>
        <p className="text-sm font-semibold">Weekly buy</p>
        <p className="text-[11px] text-[var(--text-3)] mt-1 leading-relaxed">
          Robinhood makes this buy on its own (your recurring investment). The app only records it: on the buy day it adds an entry at the 9:35 price, marked as an assumption, which you can correct on the Holdings page.
          If you change the day here, change it in Robinhood too; the app can&apos;t change Robinhood.
        </p>
        <div className="mt-3 space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex gap-2 items-end">
              <label className="flex-1">
                <span className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)]">ticker</span>
                <input value={r.symbol} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, symbol: e.target.value } : x)))} autoCapitalize="characters" spellCheck={false}
                  className="mt-1 w-full rounded-md bg-white/[0.05] border border-[var(--border-1)] px-2 py-1.5 text-[14px]" />
              </label>
              <label className="flex-1">
                <span className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)]">dollars each week</span>
                <input value={r.usd} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, usd: e.target.value } : x)))} inputMode="decimal"
                  className="mt-1 w-full rounded-md bg-white/[0.05] border border-[var(--border-1)] px-2 py-1.5 text-[14px]" />
              </label>
              <button onClick={() => setRows(rows.length > 1 ? rows.filter((_, k) => k !== i) : [{ symbol: "", usd: "" }])} className="text-[11px] text-[var(--text-3)] pb-2">Remove</button>
            </div>
          ))}
          <button onClick={() => setRows([...rows, { symbol: "", usd: "" }])} className="text-[11px] font-semibold text-[var(--neon)]">Add another stock</button>
        </div>

        <p className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)] mt-4">buy day</p>
        <div className="mt-1 flex gap-1">
          {DAYS.map(([k, label]) => (
            <button key={k} onClick={() => setDow(k)} className={`flex-1 rounded-lg py-2 text-[11px] font-semibold ${dow === k ? "bg-[var(--neon)] text-black" : "bg-white/[0.04] opacity-70"}`}>{label}</button>
          ))}
        </div>
        <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">
          If the buy day is a market holiday, Robinhood buys on the next trading day, and the record follows it.
          {settings.recurring_since ? ` Recording weekly buys since ${settings.recurring_since}.` : " Nothing is recorded until you save a weekly buy."}
        </p>
      </Card>

      <Card>
        <p className="text-sm font-semibold">Daily AI limit</p>
        <label className="block mt-2">
          <span className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)]">dollars per day, $0 to $5</span>
          <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" className="mt-1 w-28 rounded-md bg-white/[0.05] border border-[var(--border-1)] px-2 py-1.5 text-[14px]" />
        </label>
        <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">The most the copilot may spend on AI in a day, counted from midnight New York time: reading and tagging the news, and the morning report. Once it is reached, both stop until midnight.</p>

        <button onClick={() => setPaused(!paused)} className="mt-3 w-full flex items-center justify-between rounded-lg bg-white/[0.04] px-3 py-2.5">
          <span className="text-[12px] font-semibold">Pause the AI</span>
          <span className={`mono text-[10px] font-semibold ${paused ? "text-orange-300" : "text-[var(--text-3)]"}`}>{paused ? "PAUSED" : "RUNNING"}</span>
        </button>
        <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">Paused stops the news reading and the morning report. Weekly buys are still recorded, since that costs nothing.</p>
      </Card>

      <button disabled={busy} onClick={save} className="w-full rounded-lg bg-[var(--neon)] text-black text-xs font-semibold py-2.5 active:scale-95 disabled:opacity-50">{busy ? "Saving" : "Save settings"}</button>
      {msg && <p className={`text-[11px] ${msg === "Saved." ? "text-[var(--text-3)]" : "text-orange-400"}`}>{msg}</p>}
      <p className="text-[10px] text-[var(--text-4)] leading-relaxed px-1">This app never places, changes or cancels an order. Money only moves when you tap in Robinhood.</p>
    </div>
  );
}
