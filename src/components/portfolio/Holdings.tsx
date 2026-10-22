"use client";

// Holdings — what Ben owns, as entries. He types each stock once ("I already
// own this": the shares and average cost Robinhood shows), and the app adds the
// weekly buy itself as an assumed entry he can correct. Sales are entries with
// negative shares, taken out at average cost.

import { useState } from "react";
import { Card } from "../ui";
import { fmtMoney, fmtPct } from "@/lib/desk/api";
import { todayStr } from "@/lib/supabase";
import { addLot, checkSymbol, deleteLot, updateLot } from "@/lib/portfolio/api";
import type { Holding, Lot } from "@/lib/portfolio/lots";
import { fmtShares, signed, toneOf } from "./fmt";

type Action = "start" | "buy" | "sell";

export default function Holdings({ uid, lots, holdings, onChanged }: { uid: string; lots: Lot[]; holdings: Holding[]; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(holdings.length === 0);

  return (
    <div className="mt-3 space-y-3">
      {holdings.map((h) => (
        <Card key={h.symbol}>
          <button onClick={() => setOpen(open === h.symbol ? null : h.symbol)} className="w-full text-left">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold">{h.symbol} {h.name !== h.symbol && <span className="text-[11px] font-normal text-[var(--text-3)]">{h.name}</span>}</p>
              <p className="mono text-sm font-bold shrink-0">{h.value === null ? "no price" : fmtMoney(h.value, 2)}</p>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2">
              <Fact label="shares" value={fmtShares(h.shares)} />
              <Fact label="average cost" value={fmtMoney(h.avgCost, 2)} />
              <Fact label="price now" value={h.price === null ? "none" : fmtMoney(h.price, 2)} />
              <Fact label="gain" value={h.gain === null ? "none" : `${signed(h.gain)}${h.gainPct === null ? "" : ` ${fmtPct(h.gainPct)}`}`} tone={h.gain ?? 0} />
              <Fact label="today" value={h.dayChange === null ? "none" : signed(h.dayChange)} tone={h.dayChange ?? 0} />
              <Fact label="share of account" value={h.weight === null ? "none" : `${Math.round(h.weight * 100)}%`} />
            </div>
          </button>
          <p className="text-[10px] text-[var(--text-4)] mt-2">
            {h.assumedLots > 0 ? `${h.assumedLots} weekly ${h.assumedLots === 1 ? "buy is" : "buys are"} recorded at the 9:35 price, an assumption. ` : ""}
            Tap the card to see each buy and sale{h.assumedLots > 0 ? " and correct them against Robinhood" : ""}.
          </p>
          {open === h.symbol && <LotList lots={lots.filter((l) => l.symbol.toUpperCase() === h.symbol)} onChanged={onChanged} />}
        </Card>
      ))}

      {holdings.length > 0 && (
        <p className="text-[10px] text-[var(--text-4)] leading-relaxed px-1">
          Shares and average cost (what you paid per share, on average) come from what you enter here. Price now is the latest market price.
          Gain is what it is worth minus what you paid. Share of account is this stock&apos;s part of the total.
        </p>
      )}

      {adding ? (
        <AddForm uid={uid} holdings={holdings} onDone={(saved) => { setAdding(false); if (saved) onChanged(); }} />
      ) : (
        <button onClick={() => setAdding(true)} className="w-full rounded-lg border border-[var(--border-2)] text-xs font-semibold py-2.5 active:scale-95">Add or change a stock</button>
      )}
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: number }) {
  return (
    <div>
      <p className="mono text-[12px] font-semibold" style={tone === undefined ? undefined : { color: toneOf(tone) }}>{value}</p>
      <p className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)] mt-0.5">{label}</p>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", decimal }: { label: string; value: string; onChange: (v: string) => void; type?: string; decimal?: boolean }) {
  return (
    <label className="block">
      <span className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)]">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} type={type} inputMode={decimal ? "decimal" : undefined} autoCapitalize="characters" spellCheck={false}
        className="mt-1 w-full rounded-md bg-white/[0.05] border border-[var(--border-1)] px-2 py-1.5 text-[14px]" />
    </label>
  );
}

const kindLabel = (l: Lot) =>
  l.skipped ? "Skipped: Robinhood didn't buy this week, so it counts for nothing."
  : l.kind === "start" ? "What Robinhood showed you owned that day. It replaces anything entered before it."
  : l.kind === "weekly" ? (l.assumed ? "Weekly Robinhood buy, recorded at the 9:35 price. Edit it to Robinhood's real fill." : "Weekly Robinhood buy, checked against Robinhood.")
  : l.shares < 0 ? "A sale you entered." : "A buy you entered.";

function LotList({ lots, onChanged }: { lots: Lot[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const remove = async (l: Lot) => {
    if (!confirm(`Delete the ${l.day} ${l.symbol} entry?`)) return;
    const e = await deleteLot(l.id);
    if (e) setMsg(e); else onChanged();
  };
  // A weekly buy is never deleted: the app would record it again. Marking it skipped keeps the week accounted for.
  const skip = async (l: Lot, skipped: boolean) => {
    const e = await updateLot(l.id, { skipped });
    if (e) setMsg(e); else onChanged();
  };
  return (
    <div className="mt-3 border-t border-[var(--border-1)] pt-2 space-y-2.5">
      <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">Each buy and sale, newest first</p>
      {lots.some((l) => l.kind === "weekly") && <p className="text-[10px] text-[var(--text-4)] leading-relaxed">For a weekly buy Robinhood didn&apos;t make (no money in the account, or the recurring buy was paused), tap Didn&apos;t happen. It stays listed, crossed out, and counts for nothing.</p>}
      {[...lots].sort((a, b) => b.day.localeCompare(a.day) || b.created_at.localeCompare(a.created_at)).map((l) => editing === l.id ? (
        <LotEdit key={l.id} lot={l} onDone={(saved) => { setEditing(null); if (saved) onChanged(); }} />
      ) : (
        <div key={l.id} className="flex items-start justify-between gap-2">
          <div>
            <p className={`text-[12px] ${l.skipped ? "line-through opacity-50" : ""}`}>{l.day} · {l.kind === "start" ? "owned" : l.shares < 0 ? "sold" : "bought"} {fmtShares(Math.abs(l.shares))} at {fmtMoney(l.price, 2)}</p>
            <p className="text-[10px] text-[var(--text-4)] leading-relaxed">{kindLabel(l)}</p>
          </div>
          <div className="flex gap-3 shrink-0 pt-0.5">
            {l.kind === "weekly" && l.skipped ? (
              <button onClick={() => skip(l, false)} className="text-[11px] font-semibold text-[var(--neon)]">Undo</button>
            ) : (
              <>
                <button onClick={() => setEditing(l.id)} className="text-[11px] font-semibold text-[var(--neon)]">Edit</button>
                {l.kind === "weekly"
                  ? <button onClick={() => skip(l, true)} className="text-[11px] text-[var(--text-3)]">Didn&apos;t happen</button>
                  : <button onClick={() => remove(l)} className="text-[11px] text-[var(--text-3)]">Delete</button>}
              </>
            )}
          </div>
        </div>
      ))}
      {msg && <p className="text-[11px] text-orange-400">{msg}</p>}
    </div>
  );
}

function LotEdit({ lot, onDone }: { lot: Lot; onDone: (saved: boolean) => void }) {
  const [shares, setShares] = useState(String(Math.abs(lot.shares)));
  const [price, setPrice] = useState(String(lot.price));
  const [day, setDay] = useState(lot.day);
  const [err, setErr] = useState("");
  const save = async () => {
    const s = Number(shares), p = Number(price);
    if (!(s > 0) || !(p > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) { setErr("Shares and price must be above zero, and the date a real date."); return; }
    const e = await updateLot(lot.id, { shares: lot.shares < 0 ? -s : s, price: p, day, assumed: false });
    if (e) setErr(e); else onDone(true);
  };
  return (
    <div className="rounded-lg bg-white/[0.03] p-2.5 space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <Field label="shares" value={shares} onChange={setShares} decimal />
        <Field label="price per share" value={price} onChange={setPrice} decimal />
        <Field label="date" value={day} onChange={setDay} type="date" />
      </div>
      {err && <p className="text-[11px] text-orange-400">{err}</p>}
      <div className="flex gap-2">
        <button onClick={save} className="flex-1 rounded-lg bg-[var(--neon)] text-black text-xs font-semibold py-2 active:scale-95">Save</button>
        <button onClick={() => onDone(false)} className="flex-1 rounded-lg border border-[var(--border-2)] text-xs py-2">Cancel</button>
      </div>
    </div>
  );
}

function AddForm({ uid, holdings, onDone }: { uid: string; holdings: Holding[]; onDone: (saved: boolean) => void }) {
  const [action, setAction] = useState<Action>("start");
  const [symbol, setSymbol] = useState("");
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState("");
  const [day, setDay] = useState(todayStr());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    const sym = symbol.trim().toUpperCase();
    const s = Number(shares), p = Number(price);
    if (!/^[\^A-Z0-9.\-]{1,14}$/.test(sym)) { setErr("Type the ticker, like SPCX. Crypto takes -USD, like BTC-USD."); return; }
    if (!(s > 0) || !(p > 0)) { setErr("Shares and price must both be above zero."); return; }
    const held = holdings.find((h) => h.symbol === sym);
    if (action === "sell" && (!held || s > held.shares + 1e-9)) { setErr(held ? `You hold ${fmtShares(held.shares)} ${sym}, so you can't sell more than that.` : `You don't hold ${sym}.`); return; }
    setBusy(true);
    setErr("");
    if (!held) {
      const c = await checkSymbol(sym);
      if (!c.ok) { setBusy(false); setErr(c.error); return; }
    }
    const e = await addLot(uid, { symbol: sym, shares: action === "sell" ? -s : s, price: p, day, kind: action === "start" ? "start" : "manual", assumed: false, skipped: false, note: "" });
    setBusy(false);
    if (e) setErr(e); else onDone(true);
  };

  const OPTIONS: [Action, string][] = [["start", "I already own this"], ["buy", "I bought more"], ["sell", "I sold some"]];
  return (
    <Card>
      <p className="text-sm font-semibold">Add or change a stock</p>
      <div className="mt-2 flex gap-1">
        {OPTIONS.map(([k, label]) => (
          <button key={k} onClick={() => setAction(k)} className={`flex-1 rounded-lg px-2 py-2 text-[11px] font-semibold ${action === k ? "bg-[var(--neon)] text-black" : "bg-white/[0.04] opacity-70"}`}>{label}</button>
        ))}
      </div>
      <p className="text-[10px] text-[var(--text-4)] mt-2 leading-relaxed">
        {action === "start"
          ? "In Robinhood, open the stock and scroll to your position: it shows your shares and your average cost (what you paid per share, on average). Enter those two numbers. They replace anything entered for this stock before that date, so you can re-enter them any time to match Robinhood."
          : action === "buy"
            ? "A buy you made yourself in Robinhood. You don't need to add the weekly buy; the app records that on its own."
            : "Shares you sold in Robinhood and the price you got. The app takes them out at your average cost."}
      </p>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <Field label="ticker (the stock's short code)" value={symbol} onChange={setSymbol} />
        <Field label="shares" value={shares} onChange={setShares} decimal />
        <Field label={action === "start" ? "average cost per share" : "price per share"} value={price} onChange={setPrice} decimal />
        <Field label="date" value={day} onChange={setDay} type="date" />
      </div>
      {err && <p className="text-[11px] text-orange-400 mt-2">{err}</p>}
      <div className="flex gap-2 mt-3">
        <button disabled={busy} onClick={save} className="flex-1 rounded-lg bg-[var(--neon)] text-black text-xs font-semibold py-2.5 active:scale-95 disabled:opacity-50">{busy ? "Checking the ticker" : "Save"}</button>
        {holdings.length > 0 && <button onClick={() => onDone(false)} className="flex-1 rounded-lg border border-[var(--border-2)] text-xs py-2.5">Cancel</button>}
      </div>
    </Card>
  );
}
