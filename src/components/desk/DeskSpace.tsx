"use client";

// The Desk — the space. Five gears: Tonight (the verdict), Debate (the
// argument), Book (the ledger), League (the models against each other),
// Lessons (what it has learned). Paper money on every screen, said plainly.
//
// This shell owns the account row and the live marks; the gears render.
// A failed read never looks like an empty account (GRADING.md rule 2), and
// the day rolls over safely when the PWA is left open (rule 3).

import { useCallback, useEffect, useRef, useState } from "react";
import { todayStr } from "@/lib/supabase";
import { Card, Eyebrow, Segmented } from "../ui";
import { ensureAccount, loadEquity, callFn, SYNC_FN, fmtMoney, fmtPct, type Account, type EquityPoint } from "@/lib/desk/api";
import Book from "./Book";
import Tonight from "./Tonight";
import Debate from "./Debate";
import League from "./League";
import Lessons from "./Lessons";
import DeskSettings from "./DeskSettings";

type Gear = "tonight" | "debate" | "book" | "league" | "lessons";
export type LiveMarks = { quotes: Record<string, { price?: number; at?: number; error?: string }>; marks: { owner: string; equity: number; unrealized: number; gross: number }[]; at: number };

export default function DeskSpace({ uid }: { uid: string }) {
  const [gear, setGear] = useState<Gear>("tonight");
  const [account, setAccount] = useState<Account | null>(null);
  const [curve, setCurve] = useState<EquityPoint[]>([]);
  const [live, setLive] = useState<LiveMarks | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [today, setToday] = useState(todayStr());
  const liveBusy = useRef(false);

  const load = useCallback(async () => {
    const a = await ensureAccount(uid);
    if (a.error || !a.account) { setLoadErr(a.error || "Couldn't open the desk."); setLoaded(true); return; }
    const e = await loadEquity(uid, "desk");
    setAccount(a.account);
    setCurve(e.curve);
    setLoadErr(e.error);
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const refreshLive = useCallback(async () => {
    if (liveBusy.current) return;
    liveBusy.current = true;
    try {
      const r = await callFn<LiveMarks>(SYNC_FN, { mode: "quotes" }, 60_000);
      if (!r.error && Array.isArray(r.marks)) setLive({ quotes: r.quotes ?? {}, marks: r.marks, at: r.at ?? Date.now() });
    } finally { liveBusy.current = false; }
  }, []);
  useEffect(() => {
    if (!account) return;
    Promise.resolve().then(refreshLive);
    const id = setInterval(refreshLive, 5 * 60_000);
    return () => clearInterval(id);
  }, [account, refreshLive]);

  // Midnight and return-from-background guard.
  useEffect(() => {
    const tick = () => { const t = todayStr(); if (t !== today) { setToday(t); load(); } };
    const id = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [today, load]);

  if (!loaded) return <div className="pt-3"><div className="skeleton h-24" /><div className="skeleton h-40 mt-3" /></div>;
  if (!account) {
    return (
      <Card className="mt-3">
        <p className="text-sm text-[var(--text-2)]">{loadErr || "Couldn't open the desk."}</p>
        <button onClick={load} className="mt-3 w-full rounded-lg bg-orange-500/15 text-orange-300 text-xs font-semibold py-2.5 active:scale-95">Tap to retry</button>
      </Card>
    );
  }

  const deskLive = live?.marks.find((m) => m.owner === "desk");
  const equity = deskLive?.equity ?? account.equity;
  const last = curve[curve.length - 1];
  const prevClose = curve.length >= 2 ? curve[curve.length - 2].equity : account.starting_equity;
  const todayPnl = last?.day === today ? last.pnl_day + (deskLive ? equity - last.equity : 0) : equity - (last?.equity ?? account.starting_equity);
  const allTime = equity - account.starting_equity;
  const halted = !!account.halted_until && account.halted_until >= today;

  return (
    <div className="pt-3">
      <div className="flex items-baseline justify-between">
        <Eyebrow>The Desk</Eyebrow>
        <span className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">paper money · real prices</span>
      </div>

      <Card className="mt-2">
        <div className="flex items-baseline gap-5">
          <div>
            <p className="mono text-[26px] font-bold leading-none">{fmtMoney(equity)}</p>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-1.5">equity</p>
          </div>
          <div>
            <p className="mono text-[18px] font-bold leading-none" style={{ color: tone(todayPnl) }}>{signed(todayPnl)}</p>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-1.5">today</p>
          </div>
          <div>
            <p className="mono text-[18px] font-bold leading-none" style={{ color: tone(allTime) }}>{signed(allTime)} <span className="text-[11px] font-semibold">({fmtPct(allTime / account.starting_equity)})</span></p>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-1.5">all time</p>
          </div>
        </div>
        <p className="text-[10px] text-[var(--text-4)] mt-2.5 leading-relaxed">
          Started at {fmtMoney(account.starting_equity)}. Today is the change since yesterday&apos;s 4pm mark{live ? ", including open positions at live prices" : ""}.
          {prevClose !== account.starting_equity && curve.length < 2 ? "" : ""} Nothing here is money you can lose; that is the point of the first hundred trades.
        </p>
        {halted && (
          <div className="mt-3 rounded-lg bg-orange-500/[0.08] border border-orange-500/30 px-3 py-2.5">
            <p className="text-[12px] font-semibold text-orange-300">Halted until {account.halted_until}</p>
            <p className="text-[11px] text-[var(--text-2)] mt-0.5 leading-relaxed">{account.halt_reason || "The loss limit fired."} Nothing new is queued; open positions still run to their stops and targets.</p>
          </div>
        )}
        {loadErr && <p className="text-[11px] text-orange-400 mt-2">{loadErr}</p>}
      </Card>

      <div className="mt-3">
        <Segmented value={gear} onChange={setGear} options={[
          { key: "tonight", label: "Tonight" }, { key: "debate", label: "Debate" }, { key: "book", label: "Book" }, { key: "league", label: "League" }, { key: "lessons", label: "Lessons" },
        ]} />
      </div>

      <div key={gear} className="tab-enter">
        {gear === "tonight" && (
          <>
            <Tonight uid={uid} account={account} today={today} onRan={() => { load(); refreshLive(); }} />
            <DeskSettings key={account.preset + account.roster.join(",") + account.judge + account.budget_usd_per_run + String(account.leverage_cap_override)} uid={uid} account={account} onSaved={load} />
          </>
        )}
        {gear === "debate" && <Debate uid={uid} />}
        {gear === "book" && <Book uid={uid} account={account} curve={curve} live={live} today={today} onRefresh={() => { load(); refreshLive(); }} />}
        {gear === "league" && <League uid={uid} account={account} live={live} />}
        {gear === "lessons" && <Lessons uid={uid} />}
      </div>
    </div>
  );
}

const tone = (v: number) => (v > 0 ? "var(--ok)" : v < 0 ? "var(--bad)" : "var(--text-3)");
const signed = (v: number) => (v >= 0 ? "+" : "-") + fmtMoney(Math.abs(v)).replace("$", "$");
