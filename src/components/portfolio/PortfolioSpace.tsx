"use client";

// Portfolio — Ben's real Robinhood account, read only. Three gears: Holdings
// (what he owns, typed in once, plus the weekly buy the app records), Report
// (the 08:30 morning report) and Settings (the weekly buy, the AI budget, pause).
// Nothing here can place an order: real money moves only when Ben taps in Robinhood.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow, Segmented } from "../ui";
import { fmtMoney, fmtPct } from "@/lib/desk/api";
import { loadLots, loadQuotes, loadSettings, type PfSettings } from "@/lib/portfolio/api";
import { holdingsOf, type Lot, type Quote } from "@/lib/portfolio/lots";
import Holdings from "./Holdings";
import Report from "./Report";
import PortfolioSettings from "./PortfolioSettings";
import { signed, toneOf } from "./fmt";

type Gear = "holdings" | "report" | "settings";

export default function PortfolioSpace({ uid }: { uid: string }) {
  const [gear, setGear] = useState<Gear | null>(null);
  const [lots, setLots] = useState<Lot[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [settings, setSettings] = useState<PfSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [priceErr, setPriceErr] = useState("");

  const load = useCallback(async () => {
    const [l, s] = await Promise.all([loadLots(uid), loadSettings(uid)]);
    setLots(l.lots);
    setSettings(s.settings);
    setErr([l.error, s.error].filter(Boolean).join(" "));
    setLoaded(true);
    const q = await loadQuotes([...new Set(l.lots.map((x) => x.symbol.toUpperCase()))]);
    setQuotes(q.quotes);
    setPriceErr(q.error);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 5 * 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (!loaded) return <div className="pt-3"><div className="skeleton h-24" /><div className="skeleton h-40 mt-3" /></div>;

  const { holdings, totals } = holdingsOf(lots, quotes);
  const shown: Gear = gear ?? (holdings.length ? "report" : "holdings");

  return (
    <div className="pt-3">
      <div className="flex items-baseline justify-between">
        <Eyebrow>Portfolio</Eyebrow>
        <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">your real account · read only</span>
      </div>

      <Card className="mt-2">
        {holdings.length ? (
          <>
            <div className="flex items-baseline gap-5">
              <Stat big value={fmtMoney(totals.value, 2)} label="worth now" />
              <Stat value={signed(totals.dayChange)} tone={totals.dayChange} label="today" />
              <Stat value={`${signed(totals.gain)}${totals.gainPct === null ? "" : ` (${fmtPct(totals.gainPct)})`}`} tone={totals.gain} label="gain" />
            </div>
            <p className="text-[10px] text-[var(--text-4)] mt-2.5 leading-relaxed">
              Worth now is your shares at the latest price. Today is the change since yesterday&apos;s close. Gain is what it is worth minus what you paid.
              {" "}This page only reads; buying and selling happen in Robinhood.
            </p>
            {totals.missing.length > 0 && <p className="text-[11px] text-orange-400 mt-2">No price right now for {totals.missing.join(", ")}, so the totals leave {totals.missing.length === 1 ? "it" : "them"} out.</p>}
            {priceErr && <p className="text-[11px] text-orange-400 mt-2">{priceErr}</p>}
          </>
        ) : (
          <p className="text-sm text-[var(--text-2)] leading-relaxed">Add what you own on the Holdings page, and this card shows what it is worth, today&apos;s change and your gain.</p>
        )}
        {err && (
          <div className="mt-2">
            <p className="text-[11px] text-orange-400">{err}</p>
            <button onClick={load} className="mt-2 w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">Tap to retry</button>
          </div>
        )}
      </Card>

      <div className="mt-3">
        <Segmented value={shown} onChange={setGear} options={[
          { key: "holdings", label: "Holdings" }, { key: "report", label: "Report" }, { key: "settings", label: "Settings" },
        ]} />
      </div>

      <div key={shown} className="tab-enter">
        {shown === "holdings" && <Holdings uid={uid} lots={lots} holdings={holdings} onChanged={load} />}
        {shown === "report" && <Report uid={uid} hasHoldings={holdings.length > 0} paused={settings?.paused ?? false} />}
        {shown === "settings" && (settings ? <PortfolioSettings uid={uid} settings={settings} onSaved={load} /> : (
          <Card className="mt-3"><p className="text-sm text-[var(--text-2)]">Couldn&apos;t load the settings.</p></Card>
        ))}
      </div>
    </div>
  );
}

function Stat({ value, label, tone, big }: { value: string; label: string; tone?: number; big?: boolean }) {
  return (
    <div>
      <p className={`mono ${big ? "text-[26px]" : "text-[16px]"} font-bold leading-none`} style={tone === undefined ? undefined : { color: toneOf(tone) }}>{value}</p>
      <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-1.5">{label}</p>
    </div>
  );
}
