"use client";

// 💰 Income Engine — the lever on the $1M north star.
// Hormozi's rule: you can't cut your way to wealth, you grow the top line.
// The gym has a growth system (progressive overload); money had only a ledger.
// This makes income a growth system too: log the LEADING activities you control
// (outreach, demos, closes) — the lead measures — watch the funnel convert, and
// bank a daily "money rep" for doing the ONE revenue action. Revenue logged
// projects your date to $1M.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, todayStr, dateStr } from "@/lib/supabase";
import { MONEY_REP_XP } from "@/lib/gamification";
import { useGame } from "@/lib/useGameData";
import { burstConfetti } from "@/lib/confetti";
import { xpToast, sfx } from "@/lib/fx";
import { SectionTitle, Card } from "./ui";
import OfferBuilder from "./OfferBuilder";

type Activity = { id: string; day: string; kind: string; qty: number; value: number; note: string };

// The BookCrew funnel, top to bottom. Each is a LEAD measure you control daily.
// `revenue` marks the stage where money is actually booked.
const STAGES: { kind: string; emoji: string; label: string; revenue?: boolean }[] = [
  { kind: "outreach", emoji: "📤", label: "Outreach" },
  { kind: "reply", emoji: "↩️", label: "Replies" },
  { kind: "demo", emoji: "🎬", label: "Demos" },
  { kind: "proposal", emoji: "📄", label: "Proposals" },
  { kind: "close", emoji: "🤝", label: "Closes", revenue: true },
];
const EXTRA: { kind: string; emoji: string; label: string }[] = [
  { kind: "affiliate", emoji: "🧲", label: "Affiliates" },
  { kind: "content", emoji: "🎥", label: "Content" },
];
const KIND_LABEL: Record<string, { emoji: string; label: string }> = Object.fromEntries(
  [...STAGES, ...EXTRA].map((s) => [s.kind, { emoji: s.emoji, label: s.label }]),
);
// what counts as a real "revenue action" — doing any of these banks the daily money rep
const REVENUE_ACTIONS = new Set(["outreach", "reply", "demo", "proposal", "close", "affiliate"]);

function mondayOf(d = new Date()): string {
  const c = new Date(d);
  c.setDate(c.getDate() - ((c.getDay() + 6) % 7));
  return dateStr(c);
}

export default function IncomeEngine() {
  const game = useGame();
  const uid = game.uid;
  const [acts, setActs] = useState<Activity[]>([]);
  const [offline, setOffline] = useState(false);
  const [busyKind, setBusyKind] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeAmt, setCloseAmt] = useState("");
  const [offerOpen, setOfferOpen] = useState(false);
  const [note, setNote] = useState("");
  const dayRef = useRef(todayStr());

  const load = useCallback(async () => {
    const since = mondayOf(); // this week only — the scoreboard resets Monday
    const { data, error } = await supabase.from("income_activities")
      .select("id,day,kind,qty,value,note").eq("user_id", uid).gte("day", since).order("created_at", { ascending: false });
    if (error) { setOffline(true); return; } // keep prior data on a blip, don't blank the board
    setOffline(false);
    setActs((data ?? []) as Activity[]);
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  // midnight + week rollover guard — the "today" money-rep state and the weekly
  // scoreboard must both re-anchor when the calendar day changes.
  useEffect(() => {
    const check = () => { if (todayStr() !== dayRef.current) { dayRef.current = todayStr(); load(); } };
    const id = setInterval(check, 30000);
    const onVis = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  const today = todayStr();
  const todays = acts.filter((a) => a.day === today);
  const moneyRepDone = todays.some((a) => REVENUE_ACTIONS.has(a.kind)) || game.todaysQuestClaims.has("moneyrep");
  const weekCount = (kind: string) => acts.filter((a) => a.kind === kind).reduce((s, a) => s + a.qty, 0);
  const weekRevenue = acts.filter((a) => a.kind === "close").reduce((s, a) => s + Number(a.value), 0);

  // conversion rates down the funnel — the numbers Hormozi actually optimizes
  const conv = (from: string, to: string) => {
    const f = weekCount(from), t = weekCount(to);
    return f > 0 ? Math.round((t / f) * 100) : null;
  };

  // $1M projection from the logged weekly run-rate (52 weeks/yr), on top of live net worth
  const start = Math.max(0, game.netWorth);
  const perYear = weekRevenue * 52;
  const yearsToMillion = perYear > 0 ? (1_000_000 - start) / perYear : null;

  async function logActivity(kind: string, qty = 1, value = 0, actNote = "") {
    if (busyKind) return;
    setBusyKind(kind);
    setNote("");
    // WRITE-THEN-CELEBRATE: insert first, only bank the rep + celebrate on success.
    const { data, error } = await supabase.from("income_activities")
      .insert({ user_id: uid, day: today, kind, qty, value, note: actNote })
      .select("id,day,kind,qty,value,note").single();
    if (error || !data) {
      setBusyKind("");
      setNote("Couldn't log that — try again.");
      return;
    }
    setActs((x) => [data as Activity, ...x]);
    sfx.pop();

    // Daily money rep: the FIRST revenue action of the day banks +15 XP, once.
    // quest_claims UNIQUE (user_id, day, quest_key) dedupes it — a second action
    // today returns false and simply doesn't double-pay.
    if (REVENUE_ACTIONS.has(kind) && !game.todaysQuestClaims.has("moneyrep")) {
      const banked = await game.bankQuestXP("moneyrep", MONEY_REP_XP);
      if (banked) { xpToast(MONEY_REP_XP, "money rep"); if (kind === "close") burstConfetti("small"); }
    } else if (kind === "close") {
      burstConfetti("small");
    }
    setBusyKind("");
    game.refresh();
  }

  async function logClose() {
    const v = Number(closeAmt) || 0;
    await logActivity("close", 1, v, "");
    setCloseAmt(""); setCloseOpen(false);
  }

  async function undo(id: string) {
    const prev = acts;
    setActs((x) => x.filter((a) => a.id !== id));
    const { error } = await supabase.from("income_activities").delete().eq("id", id);
    if (error) { setActs(prev); setNote("Couldn't undo — try again."); return; } // roll back on failure
    game.refresh();
  }

  return (
    <div>
      <h1 className="text-2xl font-bold pt-3">💰 Income Engine</h1>
      <p className="opacity-50 text-sm mt-1">You can&apos;t cut your way to $1M — you grow the top line. Log the reps that make money, not just the money.</p>
      {offline && <p className="text-xs text-orange-400 mt-1">Showing last-loaded data — couldn&apos;t refresh.</p>}

      {/* the daily money rep — the ONE revenue action */}
      <Card tone={moneyRepDone ? "neon" : "warn"} className="mt-4">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{moneyRepDone ? "✅" : "🎯"}</span>
          <div className="flex-1">
            <p className="font-bold">{moneyRepDone ? "Money rep done today." : "No revenue action yet today."}</p>
            <p className="text-xs opacity-60">{moneyRepDone ? "You moved the $1M line. Volume wins — do more if you can." : "Do ONE thing that can make money. Tap a chip below. +15 XP."}</p>
          </div>
        </div>
      </Card>

      {/* one-tap logging — near-zero friction (Value Equation: cut effort) */}
      <SectionTitle>Log a rep</SectionTitle>
      <div className="grid grid-cols-3 gap-2">
        {STAGES.filter((s) => !s.revenue).concat(EXTRA as never[]).map((s) => (
          <button key={s.kind} disabled={busyKind === s.kind} onClick={() => logActivity(s.kind)}
            className="rounded-xl bg-white/5 border border-white/10 py-3 active:scale-95 disabled:opacity-50">
            <span className="block text-xl">{s.emoji}</span>
            <span className="block text-[11px] font-semibold mt-0.5">{busyKind === s.kind ? "…" : `+ ${s.label}`}</span>
          </button>
        ))}
        <button onClick={() => setCloseOpen((o) => !o)}
          className="rounded-xl bg-[var(--neon)]/15 border border-[var(--neon)]/40 py-3 active:scale-95">
          <span className="block text-xl">🤝</span>
          <span className="block text-[11px] font-bold mt-0.5 text-[var(--neon)]">+ Close 💵</span>
        </button>
      </div>
      {closeOpen && (
        <div className="flex gap-2 mt-2">
          <input value={closeAmt} onChange={(e) => setCloseAmt(e.target.value)} inputMode="decimal" placeholder="deal size $"
            className="flex-1 min-w-0 rounded-xl bg-black/30 px-3 py-2.5 outline-none text-sm" />
          <button onClick={logClose} disabled={busyKind === "close"} className="px-4 rounded-xl bg-[var(--neon)] text-black font-bold active:scale-95 disabled:opacity-50">Booked</button>
        </div>
      )}
      {note && <p className="text-xs text-orange-400 mt-2">{note}</p>}

      {/* the funnel — this week's volume + conversion, top of the pipe to cash */}
      <SectionTitle>This week&apos;s pipeline</SectionTitle>
      <Card>
        {STAGES.map((s, i) => {
          const c = weekCount(s.kind);
          const rate = i > 0 ? conv(STAGES[i - 1].kind, s.kind) : null;
          return (
            <div key={s.kind}>
              {i > 0 && (
                <p className="text-[10px] text-center opacity-40 py-0.5">
                  {rate != null ? `↓ ${rate}% convert` : "↓"}
                </p>
              )}
              <div className="flex items-center gap-3">
                <span className="text-lg w-6 text-center">{s.emoji}</span>
                <span className="flex-1 text-sm">{s.label}</span>
                <span className="font-display font-extrabold tabular-nums text-lg">{c}</span>
              </div>
            </div>
          );
        })}
        <div className="mt-2 pt-2 border-t border-white/10 flex items-center gap-2">
          {EXTRA.map((s) => (
            <span key={s.kind} className="text-xs opacity-70">{s.emoji} {weekCount(s.kind)} {s.label.toLowerCase()}</span>
          ))}
        </div>
      </Card>

      {/* the cash + the projection — make the delayed payoff visible */}
      <SectionTitle>Cash this week → the $1M</SectionTitle>
      <Card tone="neon">
        <div className="flex items-baseline justify-between">
          <span className="font-display font-extrabold text-3xl text-[var(--neon)]">${weekRevenue.toLocaleString()}</span>
          <span className="text-xs opacity-60">booked this week</span>
        </div>
        <p className="text-sm mt-2">
          {yearsToMillion != null && yearsToMillion > 0
            ? <>At this run-rate (${perYear.toLocaleString()}/yr on top of ${start.toLocaleString()}), you hit <b className="text-[var(--neon)]">$1M in {yearsToMillion < 1 ? `${Math.round(yearsToMillion * 12)} months` : `${yearsToMillion.toFixed(1)} years`}</b>.</>
            : <span className="opacity-60">Book your first close this week to see your projected date to $1M — and watch it move every week you sell.</span>}
        </p>
        <p className="text-[10px] opacity-40 mt-2">Double your weekly revenue and you roughly halve the years. That&apos;s the whole game.</p>
      </Card>

      {/* sharpen the offer — the Value Equation for what you sell */}
      <SectionTitle>🧲 Sharpen the offer</SectionTitle>
      {!offerOpen ? (
        <button onClick={() => setOfferOpen(true)} className="w-full rounded-xl border border-dashed border-white/20 py-3 text-sm opacity-70 active:scale-95">
          Score BookCrew&apos;s offer on the Value Equation →
        </button>
      ) : (
        <OfferBuilder />
      )}

      {/* today's log, undoable */}
      {todays.length > 0 && (
        <>
          <SectionTitle>Today&apos;s reps · {todays.length}</SectionTitle>
          <div className="space-y-1.5">
            {todays.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm">
                <span>{KIND_LABEL[a.kind]?.emoji ?? "•"}</span>
                <span className="flex-1">{a.qty > 1 ? `${a.qty}× ` : ""}{KIND_LABEL[a.kind]?.label ?? a.kind}{a.value > 0 ? ` · $${Number(a.value).toLocaleString()}` : ""}</span>
                <button onClick={() => undo(a.id)} className="opacity-30 text-xs active:scale-90">✕</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
