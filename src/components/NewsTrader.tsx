"use client";

// 📈 THE BOOK — RegimeBot's news theses, and what they taught.
//
// Ben: "use the regime bot as the thing that paper trades the news from the
// personal app, and then have it be all in the personal app, like the PL, the
// stats, the trades it's taking each day... And then post-analysis of wins and
// losses from the bots, why a thesis worked, why it lost."
//
// So there is exactly one trader and one book:
//
//   this app  = the ANALYST. Reads 14 news feeds nightly, works out which listed
//               companies each story actually touches, writes a thesis and the
//               thing that would prove it wrong. It never places an order.
//   RegimeBot = the TRADER. Prices each idea, turns the prose falsifier into an
//               invalidation LEVEL, sizes off the stop, executes on the paper
//               account, and scores the result against SPY.
//
// This screen is the window onto that. It is built around whether the REASONING
// was sound, kept deliberately separate from whether the trade made money,
// because those come apart constantly and confusing them teaches the wrong
// lesson. A winner on a broken thesis is luck.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, SUPABASE_URL, SUPABASE_ANON } from "@/lib/supabase";
import { Card, Eyebrow, SectionTitle } from "./ui";
import { sfx, buzz } from "@/lib/fx";

const TRADER_FN = `${SUPABASE_URL}/functions/v1/trader`;
const BRIDGE_FN = `${SUPABASE_URL}/functions/v1/botbridge`;

type Thesis = {
  id: string; symbol: string; direction: string; sector: string;
  conviction: number; horizon_days: number;
  entry_ref: number; invalidation_level: number; target_level: number;
  reasoning: string; catalyst: string; sources: string[];
  created: string; status: string; resolved: string | null;
  outcome_pct: number | null; benchmark_pct: number | null; alpha: number | null;
  note: string; postmortem: string; synced_at: string;
};
type Pick = {
  id: string; day: string; symbol: string; side: string; status: string;
  headline: string; thesis: string; falsifier: string; conviction: number; reject_reason: string;
};
type Equity = { day: string; equity: number; spy_close: number | null };

const pct = (n: number) => (n >= 0 ? "+" : "") + (n * 100).toFixed(1) + "%";
const money = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const tone = (n: number) => (n > 0 ? "var(--ok)" : n < 0 ? "var(--bad)" : "var(--text-3)");

const STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: "open", tone: "var(--text-3)" },
  correct: { label: "hit its target", tone: "var(--ok)" },
  wrong: { label: "hit its invalidation", tone: "var(--bad)" },
  expired: { label: "ran out of time", tone: "var(--warn)" },
};

export default function NewsTrader({ uid }: { uid: string }) {
  const [loaded, setLoaded] = useState(false);
  const [theses, setTheses] = useState<Thesis[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [curve, setCurve] = useState<Equity[]>([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const running = useRef(false);

  const load = useCallback(async () => {
    try {
      const [th, pk, eq] = await Promise.all([
        supabase.from("bot_theses").select("*").eq("user_id", uid).order("created", { ascending: false }).limit(80),
        supabase.from("agent_trades").select("id,day,symbol,side,status,headline,thesis,falsifier,conviction,reject_reason")
          .eq("user_id", uid).order("created_at", { ascending: false }).limit(20),
        supabase.from("agent_equity").select("day,equity,spy_close").eq("user_id", uid).order("day"),
      ]);
      if (!th.error) setTheses((th.data ?? []) as Thesis[]);
      if (!pk.error) setPicks((pk.data ?? []) as Pick[]);
      if (!eq.error) setCurve((eq.data ?? []) as Equity[]);
    } catch { setErr("Couldn't load the book."); }
    finally { setLoaded(true); }
  }, [uid]);
  useEffect(() => { load(); }, [load]);

  async function runAnalyst() {
    if (running.current) return;
    running.current = true; setBusy("run"); setErr(""); setMsg("");
    try {
      const { data: s } = await supabase.auth.getSession();
      const r = await fetch(TRADER_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${s.session?.access_token}` },
        body: JSON.stringify({ mode: "run" }),
      });
      const j = await r.json();
      if (j.error) setErr(j.error);
      else if (j.skipped) setMsg(j.skipped);
      else setMsg(`${(j.placed ?? []).length} pick${(j.placed ?? []).length === 1 ? "" : "s"} written from ${j.candidates} candidate${j.candidates === 1 ? "" : "s"}. RegimeBot takes it from here.`);
      if (!j.error) { sfx.coin(); buzz(12); await load(); }
    } catch { setErr("Couldn't reach the analyst."); }
    finally { running.current = false; setBusy(""); }
  }

  async function postmortem(id: string, force = false) {
    setBusy(id); setErr("");
    try {
      const { data: s } = await supabase.auth.getSession();
      const r = await fetch(BRIDGE_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${s.session?.access_token}` },
        body: JSON.stringify({ mode: "postmortem", id, force }),
      });
      const j = await r.json();
      if (j.error) setErr(j.error);
      else { setTheses((ts) => ts.map((t) => (t.id === id ? { ...t, postmortem: j.postmortem } : t))); sfx.pop(); }
    } catch { setErr("Couldn't write the post-mortem."); }
    finally { setBusy(""); }
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-24" /><div className="skeleton h-40 mt-3" /></div>;

  const open = theses.filter((t) => t.status === "open");
  const done = theses.filter((t) => t.status !== "open");
  const scored = done.filter((t) => t.alpha !== null);

  const hits = done.filter((t) => t.status === "correct").length;
  const meanAlpha = scored.length ? scored.reduce((a, t) => a + (t.alpha as number), 0) / scored.length : null;
  // The calibration test the bot's own risk ladder runs: high-conviction calls
  // must actually outperform low-conviction ones, or the rating means nothing.
  const hi = scored.filter((t) => t.conviction >= 4);
  const lo = scored.filter((t) => t.conviction <= 3);
  const hiA = hi.length ? hi.reduce((a, t) => a + (t.alpha as number), 0) / hi.length : null;
  const loA = lo.length ? lo.reduce((a, t) => a + (t.alpha as number), 0) / lo.length : null;

  const last = curve[curve.length - 1];
  const waiting = picks.filter((p) => p.status === "dry");

  return (
    <div className="pt-3">
      <SectionTitle>The book</SectionTitle>

      <div className="rounded-xl border border-[var(--border-2)] bg-[var(--raised)] px-3.5 py-3">
        <p className="text-[12px] text-[var(--text-2)] leading-relaxed">
          <b>Paper money.</b> This app reads the news and writes the thesis; <b>RegimeBot</b> prices it,
          places it on the Alpaca paper account and scores it. Nothing here is advice, and a paper
          record does not carry over to real money &mdash; no slippage, and nothing you could actually lose.
        </p>
      </div>

      {/* ── scorecard ──────────────────────────────────────────────── */}
      <Card className="mt-3">
        <Eyebrow>Is the reasoning any good?</Eyebrow>
        <div className="flex items-baseline gap-5 mt-2">
          <div>
            <p className="mono text-[26px] font-bold" style={{ color: meanAlpha === null ? "var(--text-3)" : tone(meanAlpha) }}>
              {meanAlpha === null ? "—" : pct(meanAlpha)}
            </p>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-0.5">mean alpha</p>
          </div>
          <div>
            <p className="mono text-[26px] font-bold">{done.length ? `${hits}/${done.length}` : "—"}</p>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-0.5">hit target</p>
          </div>
          <div>
            <p className="mono text-[26px] font-bold">{open.length}</p>
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mt-0.5">still open</p>
          </div>
        </div>
        <p className="text-[11px] text-[var(--text-4)] mt-2 leading-relaxed">
          Alpha is what a thesis returned <i>minus what SPY did over exactly the same days</i> &mdash; being up
          in a market that rose more is not skill.
          {scored.length < 10 && ` Only ${scored.length} scored so far; the bot's own risk ladder won't widen until 10, for good reason.`}
        </p>
        {hiA !== null && loA !== null && (
          <p className="text-[11px] mt-1.5 leading-relaxed" style={{ color: hiA > loA ? "var(--ok)" : "var(--warn)" }}>
            Conviction {hiA > loA ? "is calibrated" : "is not calibrated"}: high-conviction calls average {pct(hiA)} against {pct(loA)} for the rest.
            {hiA <= loA && " Rating things 4 and 5 is currently adding nothing."}
          </p>
        )}
        {last && (
          <p className="mono text-[11px] text-[var(--text-3)] mt-3 pt-3 border-t border-[var(--border-1)]">
            paper account {money(last.equity)} &middot; last reported {last.day}
          </p>
        )}
      </Card>

      {/* ── tonight ────────────────────────────────────────────────── */}
      <Card className="mt-3">
        <Eyebrow className="mb-2">Tonight</Eyebrow>
        {waiting.length > 0 ? (
          <>
            <p className="text-[12px] text-[var(--text-2)] leading-relaxed mb-2">
              {waiting.length} pick{waiting.length === 1 ? "" : "s"} written and waiting for RegimeBot to price and place:
            </p>
            {waiting.map((p) => (
              <p key={p.id} className="text-[12px] mb-1">
                <span className="mono font-bold">{p.symbol}</span>
                <span className="text-[var(--text-4)]"> &middot; {p.side === "buy" ? "long" : "short"} &middot; {p.headline}</span>
              </p>
            ))}
            <p className="mono text-[10px] text-[var(--text-4)] mt-2">
              on your Mac: <span className="text-[var(--text-2)]">research.py news</span> &rarr;{" "}
              <span className="text-[var(--text-2)]">execute</span> &rarr;{" "}
              <span className="text-[var(--text-2)]">push</span>
            </p>
          </>
        ) : (
          <p className="text-[12px] text-[var(--text-3)] leading-relaxed">
            Nothing waiting. The analyst runs after the briefing each night; on most nights it correctly picks nothing.
          </p>
        )}
        <button onClick={runAnalyst} disabled={!!busy}
          className="mt-3 w-full rounded-lg bg-[var(--neon)] text-black text-sm font-bold py-2.5 active:scale-95 disabled:opacity-40">
          {busy === "run" ? "reading the news…" : "Run the analyst on tonight's briefing"}
        </button>
        {msg && <p className="text-[11px] text-[var(--ok)] mt-2">{msg}</p>}
        {err && <p className="text-[11px] text-orange-400 mt-2">{err}</p>}
      </Card>

      {/* ── the book ───────────────────────────────────────────────── */}
      <SectionTitle>Open positions</SectionTitle>
      {open.length === 0 ? (
        <Card><p className="text-[13px] text-[var(--text-3)] leading-relaxed">
          Nothing open. RegimeBot pushes its book here whenever it runs.
        </p></Card>
      ) : (
        <div className="space-y-2.5">
          {open.map((t) => {
            const room = ((t.entry_ref - t.invalidation_level) / t.entry_ref) * (t.direction === "long" ? 1 : -1);
            const reach = ((t.target_level - t.entry_ref) / t.entry_ref) * (t.direction === "long" ? 1 : -1);
            return (
              <Card key={t.id}>
                <div className="flex items-baseline gap-2">
                  <span className="mono text-sm font-bold">{t.symbol}</span>
                  <span className="mono text-[10px] uppercase tracking-wider text-[var(--text-4)]">
                    {t.direction} &middot; {t.sector} &middot; {"●".repeat(t.conviction)}{"○".repeat(Math.max(0, 5 - t.conviction))}
                  </span>
                  <span className="flex-1" />
                  <span className="mono text-[10px] text-[var(--text-4)]">{t.horizon_days}d</span>
                </div>
                <p className="mono text-[11px] text-[var(--text-3)] mt-1.5">
                  entry {t.entry_ref} &middot; <span style={{ color: "var(--bad)" }}>wrong at {t.invalidation_level}</span>
                  {" "}({pct(-room)}) &middot; <span style={{ color: "var(--ok)" }}>target {t.target_level}</span> ({pct(reach)})
                </p>
                {t.catalyst && <p className="text-[11.5px] text-[var(--text-3)] mt-1.5 leading-snug">{t.catalyst}</p>}
                <p className="text-[12.5px] mt-1.5 leading-relaxed">{t.reasoning}</p>
                {t.sources?.[0] && /^https?:\/\//.test(t.sources[0]) && (
                  <a href={t.sources[0]} target="_blank" rel="noopener noreferrer"
                    className="mono text-[9px] text-[var(--text-4)] underline decoration-dotted underline-offset-2 mt-1.5 inline-block">
                    the story &#8599;
                  </a>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ── resolved, with the lesson ──────────────────────────────── */}
      {done.length > 0 && (
        <>
          <SectionTitle>Closed &mdash; and what it taught</SectionTitle>
          <div className="space-y-2.5">
            {done.map((t) => {
              const st = STATUS[t.status] ?? STATUS.open;
              const isOpen = openId === t.id;
              return (
                <Card key={t.id}>
                  <button onClick={() => setOpenId(isOpen ? null : t.id)} className="w-full text-left active:scale-[0.995]">
                    <div className="flex items-baseline gap-2">
                      <span className="mono text-sm font-bold">{t.symbol}</span>
                      <span className="mono text-[10px]" style={{ color: st.tone }}>{st.label}</span>
                      <span className="flex-1" />
                      {t.outcome_pct !== null && (
                        <span className="mono text-[13px] font-bold" style={{ color: tone(t.outcome_pct) }}>{pct(t.outcome_pct)}</span>
                      )}
                    </div>
                    {t.alpha !== null && (
                      <p className="mono text-[11px] mt-1" style={{ color: tone(t.alpha) }}>
                        {pct(t.alpha)} vs SPY
                        <span className="text-[var(--text-4)]"> (SPY did {pct(t.benchmark_pct ?? 0)} over the same days)</span>
                      </p>
                    )}
                    <p className="text-[11.5px] text-[var(--text-3)] mt-1 leading-snug">{t.catalyst}</p>
                  </button>

                  {isOpen && (
                    <div className="mt-2.5 pt-2.5 border-t border-[var(--border-1)] rise-in">
                      <p className="text-[12.5px] leading-relaxed">{t.reasoning}</p>
                      <p className="mono text-[10px] text-[var(--text-4)] mt-1.5">
                        entry {t.entry_ref} &middot; invalidation {t.invalidation_level} &middot; target {t.target_level}
                        {t.resolved ? ` · resolved ${t.resolved}` : ""}
                      </p>
                      {t.postmortem ? (
                        <div className="mt-2.5 rounded-lg bg-[var(--raised)] border border-[var(--border-1)] p-3">
                          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)] mb-1.5">Post-mortem</p>
                          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap">{t.postmortem}</p>
                          <button onClick={() => postmortem(t.id, true)} disabled={!!busy}
                            className="mono text-[10px] text-[var(--text-4)] underline mt-2 active:scale-95 disabled:opacity-40">
                            {busy === t.id ? "rewriting…" : "rewrite it"}
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => postmortem(t.id)} disabled={!!busy}
                          className="mt-2.5 w-full rounded-lg bg-white/10 text-sm font-semibold py-2 active:scale-95 disabled:opacity-40">
                          {busy === t.id ? "thinking it through…" : "Why did this work / not work?"}
                        </button>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}

      <p className="text-[11px] text-[var(--text-4)] mt-4 leading-relaxed">
        A thesis is closed by its <i>invalidation price</i>, never by someone deciding afterwards that they
        still like it. That is the whole discipline: the level was set when the idea was fresh, and it gets
        to be right.
      </p>
    </div>
  );
}
