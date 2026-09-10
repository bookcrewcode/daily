"use client";

// Macro review — the daily read across the whole tournament, not one trade:
// three leagues of three teams, each one frontier model that decides on the
// crew every team shares, each with its own $100,000 paper book. Who is
// alive, who died, who was formed, which strategies are paying, how the
// models themselves are standing, and the trades the review actually read.
// Written every morning, or on demand here. Every label is explained where it
// sits and every trading word until Ben has learned it; nothing here is money
// anyone can lose.

import { useCallback, useEffect, useState } from "react";
import { Card, Eyebrow } from "../ui";
import { Lingo, LingoProse } from "./Term";
import { callFn, REVIEW_FN, loadCards, fmtMoney, fmtR, modelLabel, labTone, type CoachCard } from "@/lib/desk/api";
import { STRATEGIES } from "@/lib/desk/scan";
import { sfx, buzz } from "@/lib/fx";

/* ── the tournament card, read defensively ──────────────────────────────── */

type Cell = { n: number; hit: number | null; mean_r: number | null; shrunk_r: number | null; profit_factor: number | null; t: number | null; label: string };
type SeasonLine = { n: number; day_of: number; days: number; start_day: string; end_day: string; champion: string | null };
// Older cards still carry kick and council counts; they are read past, not shown.
type TeamLine = {
  id: string; name: string; tier: string; rank: number; status: string; frontier: string; workers: string[];
  return_pct: number; equity: number; days_alive: number; open: number; decisions: number; takes: number; passes: number; closes: number; death_reason: string;
};
type DeadLine = { name: string; reason: string; return_pct: number };
type FormedLine = { name: string; frontier: string; workers: string[] };
type PoolLine = { model: string; role: "frontier" | "worker"; standing: number | null; live_teams: number; elo: number; brier: number | null; sits: number; sit_right: number | null };
type TradeLine = { team: string; symbol: string; side: string; strategy: string; timeframe: string; r: number; pnl: number; exit: string; closed: string; quadrant: string; grade: string; lesson: string; why: string };
type TournamentCard = {
  as_of: string; day: string; season: SeasonLine | null; teams: TeamLine[]; dead_today: DeadLine[]; formed_today: FormedLine[];
  by_strategy: Record<string, Cell>; by_tier: Record<string, Cell>; strategy_books: Record<string, Cell>; pool: PoolLine[]; trades: TradeLine[]; spend_today: number;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const nOrNull = (v: unknown) => { const x = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(x) ? null : x; };
const strs = (v: unknown) => arr(v).map(str).filter((s) => s.length > 0);
const cell = (v: unknown): Cell => { const x = obj(v); return { n: num(x.n), hit: nOrNull(x.hit), mean_r: nOrNull(x.mean_r), shrunk_r: nOrNull(x.shrunk_r), profit_factor: nOrNull(x.profit_factor), t: nOrNull(x.t), label: str(x.label) }; };
const cells = (v: unknown): Record<string, Cell> => { const out: Record<string, Cell> = {}; for (const [k, x] of Object.entries(obj(v))) out[k] = cell(x); return out; };

function parse(card: unknown): TournamentCard {
  const c = obj(card);
  const s = obj(c.season);
  return {
    as_of: str(c.as_of), day: str(c.day),
    season: Object.keys(s).length ? { n: num(s.n, 1), day_of: num(s.day_of), days: num(s.days), start_day: str(s.start_day), end_day: str(s.end_day), champion: str(s.champion) || null } : null,
    teams: arr(c.teams).map((v) => {
      const x = obj(v);
      return {
        id: str(x.id), name: str(x.name), tier: str(x.tier) || "bronze", rank: num(x.rank), status: str(x.status) || "live", frontier: str(x.frontier),
        workers: strs(x.workers), return_pct: num(x.return_pct), equity: num(x.equity, 100000), days_alive: num(x.days_alive),
        open: num(x.open), decisions: num(x.decisions), takes: num(x.takes), passes: num(x.passes), closes: num(x.closes), death_reason: str(x.death_reason),
      };
    }),
    dead_today: arr(c.dead_today).map((v) => { const x = obj(v); return { name: str(x.name), reason: str(x.reason), return_pct: num(x.return_pct) }; }),
    formed_today: arr(c.formed_today).map((v) => { const x = obj(v); return { name: str(x.name), frontier: str(x.frontier), workers: strs(x.workers) }; }),
    by_strategy: cells(c.by_strategy), by_tier: cells(c.by_tier), strategy_books: cells(c.strategy_books),
    pool: arr(c.pool).map((v) => {
      const x = obj(v);
      return { model: str(x.model), role: x.role === "frontier" ? "frontier" : "worker", standing: nOrNull(x.standing), live_teams: num(x.live_teams), elo: num(x.elo, 1500), brier: nOrNull(x.brier), sits: num(x.sits), sit_right: nOrNull(x.sit_right) };
    }),
    trades: arr(c.trades).map((v) => {
      const x = obj(v);
      return { team: str(x.team), symbol: str(x.symbol), side: str(x.side), strategy: str(x.strategy), timeframe: str(x.timeframe), r: num(x.r), pnl: num(x.pnl), exit: str(x.exit), closed: str(x.closed), quadrant: str(x.quadrant), grade: str(x.grade), lesson: str(x.lesson), why: str(x.why) };
    }),
    spend_today: num(c.spend_today),
  };
}

/* ── words ──────────────────────────────────────────────────────────────── */

const TIER_COLOR: Record<string, string> = { diamond: "#7dd3fc", gold: "#fbbf24", bronze: "#d97706" };
const TIER_ORDER = ["diamond", "gold", "bronze"];
const TIER_NAME: Record<string, string> = { diamond: "Diamond", gold: "Gold", bronze: "Bronze" };
const EXIT: Record<string, string> = { stop: "stopped out", target: "hit the target", time: "the clock ran out", thesis_broke: "the frontier closed it", liquidated: "liquidated", halt: "halted", cancelled: "never filled" };
const QUADRANT: Record<string, string> = { earned: "earned it: good process, good outcome", bad_luck: "bad luck: good process, bad outcome", dumb_luck: "dumb luck: bad process, good outcome", deserved: "deserved: bad process, bad outcome" };
const HEADS: Record<string, string> = { "WHAT IS WORKING": "What is working", "WHAT IS NOT": "What is not", "WHAT THESE TRADES TEACH": "What these trades teach", "HOW TO PROCEED": "How to proceed" };

const stratName = (id: string) => STRATEGIES.find((s) => s.id === id)?.name ?? id;
const dec2 = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
const pct01 = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);
const pctU = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const toneOf = (v: number | null) => ((v ?? 0) > 0 ? "var(--ok)" : (v ?? 0) < 0 ? "var(--bad)" : "var(--text-3)");
const pf = (v: number | null) => (v === null ? "—" : v.toFixed(2));
const dayLabel = (day: string, o: Intl.DateTimeFormatOptions) => (day ? new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", ...o }) : "");

// The review writes four headings on their own lines; give them their own
// paragraph so they read as headings rather than a shouted first line.
function withHeadings(text: string): string {
  return (text ?? "").split("\n").map((line) => {
    const key = line.trim().replace(/[:.\s]+$/, "").toUpperCase();
    return HEADS[key] ? `\n## ${HEADS[key]}\n` : line;
  }).join("\n");
}

function TierChip({ tier }: { tier: string }) {
  const c = TIER_COLOR[tier];
  if (!c) return null;
  return <span className="mono text-[8.5px] uppercase tracking-widest px-1.5 py-[1px] rounded shrink-0" style={{ color: c, background: `${c}22` }}>{tier}</span>;
}

/* ── the screen ─────────────────────────────────────────────────────────── */

export default function MacroReview({ uid, onChanged }: { uid: string; onChanged: () => void }) {
  const [cards, setCards] = useState<CoachCard[]>([]);
  const [sel, setSel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const c = await loadCards(uid, 14);
    setErr(c.error);
    if (!c.error) { setCards(c.cards); setSel((cur) => (cur && c.cards.some((x) => x.day === cur) ? cur : (c.cards[0]?.day ?? ""))); }
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  async function write() {
    if (busy) return;
    setBusy(true); setNote("");
    const r = await callFn<{ ok?: boolean; cost?: number }>(REVIEW_FN, { mode: "coach" }, 150_000);
    if (r.error) setNote(r.error);
    else {
      setNote(`Written for ${fmtMoney(r.cost ?? 0, 3)} of model time.`);
      sfx.coin(); buzz(10);
      await load(); onChanged();
    }
    setBusy(false);
  }

  if (!loaded) return <div className="pt-3"><div className="skeleton h-14" /><div className="skeleton h-56 mt-3" /></div>;

  const card = cards.find((c) => c.day === sel) ?? cards[0] ?? null;
  const t = parse(card?.card);
  const alive = t.teams.filter((x) => x.status !== "dead");
  const stratKeys = [...new Set([...STRATEGIES.map((s) => s.id).filter((id) => t.by_strategy[id] || t.strategy_books[id]), ...Object.keys(t.by_strategy), ...Object.keys(t.strategy_books)])];
  const pool = [...t.pool].sort((a, b) => (b.standing ?? -999) - (a.standing ?? -999) || b.elo - a.elo);

  return (
    <div className="pt-3">
      <Card>
        <div className="flex items-baseline justify-between">
          <Eyebrow>The macro review</Eyebrow>
          <span className="mono text-[10px] text-[var(--text-4)]">daily at 1:05am ET</span>
        </div>
        <p className="text-[11.5px] text-[var(--text-2)] leading-relaxed mt-1.5">
          Every morning a model reads the whole tournament, not one trade: nine teams across three leagues, each one frontier model that decides, all sharing one crew of four cheap workers that research every candidate once, each team running its own $100,000 of paper money. It reads who is up and who is down, who died and who was formed, which strategies paid and which cost, and the last trades with their micro reviews. Then it writes what is working, what is not, what these trades teach, and how to proceed.
        </p>
        <div className="flex items-center gap-3 mt-2.5 flex-wrap">
          <button onClick={write} disabled={busy} className="rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] text-xs font-semibold px-3 py-2 active:scale-95 disabled:opacity-50">{busy ? "Reading the record…" : card ? "Write today's review now" : "Write the first review"}</button>
          <span className="mono text-[9px] text-[var(--text-4)]">one model call, about {fmtMoney(0.05, 2)}</span>
        </div>
        {(note || err) && <p className={`text-[11px] mt-2 ${err ? "text-orange-400" : "text-[var(--text-3)]"}`}>{err || note}</p>}
      </Card>

      {cards.length > 1 && (
        <div className="flex gap-1.5 mt-3 overflow-x-auto no-scrollbar pb-1">
          {cards.map((x) => (
            <button key={x.day} onClick={() => setSel(x.day)} className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-semibold transition ${x.day === card?.day ? "bg-[var(--neon)] text-black" : "bg-white/5 opacity-70"}`}>
              {dayLabel(x.day, { month: "short", day: "numeric" })}
            </button>
          ))}
        </div>
      )}

      {!card ? (
        <Card className="mt-3"><p className="text-[12px] text-[var(--text-3)] leading-relaxed">No review yet. The first one writes itself at 1:05am ET, or press the button.</p></Card>
      ) : (
        <>
          <Card className="mt-3" tone="neon">
            <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">{dayLabel(card.day, { weekday: "long", month: "long", day: "numeric" })}</p>
            {t.season && (
              <p className="mono text-[10px] text-[var(--text-3)] mt-1">
                Season {t.season.n} · day {t.season.day_of} of {t.season.days}
                {t.season.start_day ? ` · ${dayLabel(t.season.start_day, { month: "short", day: "numeric" })} to ${dayLabel(t.season.end_day, { month: "short", day: "numeric" })}` : ""}
                {t.season.champion ? ` · champion ${t.season.champion}` : ""}
              </p>
            )}
            <LingoProse className="mt-2" text={withHeadings(card.review)} />
            <p className="mono text-[10px] text-[var(--text-4)] mt-2">{alive.length} teams alive · {t.trades.length} closed trades read{t.spend_today ? ` · ${fmtMoney(t.spend_today, 2)} of model time spent today` : ""}</p>
          </Card>

          {t.teams.length > 0 && (
            <Card className="mt-2.5">
              <Eyebrow className="mb-1">The standings</Eyebrow>
              <div className="overflow-x-auto">
                <table className="w-full text-[10.5px]">
                  <thead><tr className="text-[var(--text-4)] mono text-[8px] uppercase tracking-wider">
                    <th className="text-left font-normal pb-1">team</th><th className="text-right font-normal pb-1">return</th><th className="text-right font-normal pb-1">book</th>
                    <th className="text-right font-normal pb-1">days</th><th className="text-right font-normal pb-1">open</th><th className="text-right font-normal pb-1">t/p/c</th>
                  </tr></thead>
                  <tbody>
                    {TIER_ORDER.flatMap((tier) => {
                      const rows = t.teams.filter((x) => x.tier === tier).sort((a, b) => (a.rank || 99) - (b.rank || 99) || b.return_pct - a.return_pct);
                      if (!rows.length) return [];
                      return [
                        <tr key={`h-${tier}`}><td colSpan={6} className="pt-2 pb-0.5"><span className="mono text-[9px] uppercase tracking-widest" style={{ color: TIER_COLOR[tier] }}>{TIER_NAME[tier] ?? tier}</span></td></tr>,
                        ...rows.map((x) => (
                          <tr key={x.id || x.name} className="border-t border-[var(--border-1)]">
                            <td className="py-1 pr-2"><span className={x.status === "dead" ? "line-through opacity-60" : ""}>{x.name}</span>{x.status === "dead" ? <span className="mono text-[8px] text-[var(--bad)] ml-1">dead</span> : null}</td>
                            <td className="py-1 text-right mono" style={{ color: toneOf(x.return_pct) }}>{pctU(x.return_pct)}</td>
                            <td className="py-1 text-right mono text-[var(--text-3)]">{fmtMoney(x.equity)}</td>
                            <td className="py-1 text-right mono text-[var(--text-4)]">{x.days_alive}</td>
                            <td className="py-1 text-right mono text-[var(--text-4)]">{x.open}</td>
                            <td className="py-1 text-right mono text-[var(--text-4)]">{x.takes}/{x.passes}/{x.closes}</td>
                          </tr>
                        )),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">
                Diamond, Gold and Bronze are the three leagues, three teams each, re-sorted at the daily ranking. Return is percent from the team&apos;s $100,000 paper start; book is what that money is worth now. Days is how long the team has been alive. Open is positions it is holding right now. t/p/c is takes, passes and closes today: a pass is a candidate it read and refused. A team dies 5% below its start, and its frontier comes back with a new life and a fresh book.
              </p>
            </Card>
          )}

          {(t.dead_today.length > 0 || t.formed_today.length > 0) && (
            <Card className="mt-2.5" tone="warn">
              <Eyebrow className="mb-1">Died and formed today</Eyebrow>
              {t.dead_today.map((d, i) => (
                <p key={`d${i}`} className="text-[11.5px] leading-snug mt-1">
                  <span className="mono text-[10px] uppercase" style={{ color: "var(--bad)" }}>died</span> <span className="font-semibold">{d.name}</span> <span className="mono text-[10px]" style={{ color: toneOf(d.return_pct) }}>{pctU(d.return_pct)}</span>
                  {d.reason ? <span className="text-[var(--text-3)]">: {d.reason}</span> : null}
                </p>
              ))}
              {t.formed_today.map((f, i) => (
                <p key={`f${i}`} className="text-[11.5px] leading-snug mt-1">
                  <span className="mono text-[10px] uppercase" style={{ color: "var(--warn)" }}>formed</span> <span className="font-semibold">{f.name}</span>
                  <span className="text-[var(--text-3)]">: {modelLabel(f.frontier)} decides, on the shared crew</span>
                </p>
              ))}
              <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">A dead team keeps its record; its frontier comes straight back with a new life, a fresh $100,000 book and the next numeral after its name.</p>
            </Card>
          )}

          {stratKeys.length > 0 && (
            <Card className="mt-2.5">
              <Eyebrow className="mb-1">Strategies across the teams</Eyebrow>
              <div className="overflow-x-auto">
                <table className="w-full text-[10.5px]">
                  <thead><tr className="text-[var(--text-4)] mono text-[8px] uppercase tracking-wider">
                    <th className="text-left font-normal pb-1">strategy</th><th className="text-right font-normal pb-1">n</th><th className="text-right font-normal pb-1">hit</th>
                    <th className="text-right font-normal pb-1">mean R</th><th className="text-right font-normal pb-1">shrunk R</th><th className="text-right font-normal pb-1">PF</th>
                    <th className="text-right font-normal pb-1">rule n</th><th className="text-right font-normal pb-1">rule R</th>
                  </tr></thead>
                  <tbody>
                    {stratKeys.map((id) => {
                      const a = t.by_strategy[id], b = t.strategy_books[id];
                      return (
                        <tr key={id} className="border-t border-[var(--border-1)]">
                          <td className="py-1 pr-2">{stratName(id)}</td>
                          <td className="py-1 text-right mono">{a?.n ?? 0}</td>
                          <td className="py-1 text-right mono text-[var(--text-3)]">{pct01(a?.hit ?? null)}</td>
                          <td className="py-1 text-right mono" style={{ color: toneOf(a?.mean_r ?? null) }}>{dec2(a?.mean_r ?? null)}</td>
                          <td className="py-1 text-right mono" style={{ color: toneOf(a?.shrunk_r ?? null) }}>{dec2(a?.shrunk_r ?? null)}</td>
                          <td className="py-1 text-right mono text-[var(--text-3)]">{pf(a?.profit_factor ?? null)}</td>
                          <td className="py-1 text-right mono text-[var(--text-4)]">{b?.n ?? 0}</td>
                          <td className="py-1 text-right mono" style={{ color: toneOf(b?.shrunk_r ?? null) }}>{dec2(b?.shrunk_r ?? null)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">
                The first five columns are the teams&apos; own trades from that strategy. n is how many have closed. Hit is the share that made money. Mean R is the average profit per unit of risk, where 1R is the distance from entry to stop. Shrunk R is that average pulled toward zero when the sample is small, so three lucky trades cannot look like an edge. PF is profit factor: everything won divided by everything lost, so above 1.00 makes money.
              </p>
              <p className="text-[10px] text-[var(--text-4)] mt-1 leading-relaxed">
                The last two columns are the same strategy taken mechanically, every signal, with no team involved. The gap between rule R and shrunk R is what the teams add or cost: read above the rule and the models are earning their place; read below it and they are getting in the way.
              </p>
            </Card>
          )}

          {Object.keys(t.by_tier).length > 0 && (
            <Card className="mt-2.5">
              <Eyebrow className="mb-1">By league</Eyebrow>
              {TIER_ORDER.filter((k) => t.by_tier[k]).concat(Object.keys(t.by_tier).filter((k) => !TIER_ORDER.includes(k))).map((k) => {
                const x = t.by_tier[k];
                return (
                  <p key={k} className="text-[10.5px] py-1 border-t border-[var(--border-1)] flex items-baseline gap-2">
                    <span className="flex-1 flex items-center gap-1.5"><TierChip tier={k} />{TIER_NAME[k] ?? k}</span>
                    <span className="mono text-[var(--text-4)]">{x.n} closed · hit {pct01(x.hit)} · R <span style={{ color: toneOf(x.shrunk_r) }}>{dec2(x.shrunk_r)}</span>{x.label ? ` · ${x.label}` : ""}</span>
                  </p>
                );
              })}
              <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">The same measures again, grouped by league, so it shows whether the teams that got promoted are actually the better traders.</p>
            </Card>
          )}

          {pool.length > 0 && (
            <Card className="mt-2.5">
              <Eyebrow className="mb-1">The pool</Eyebrow>
              {pool.map((p) => (
                <div key={`${p.model}-${p.role}`} className="py-1.5 border-t border-[var(--border-1)]">
                  <p className="text-[10.5px] flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: labTone(p.model) }} />
                    <span className="flex-1 min-w-0 truncate">{modelLabel(p.model)} <span className="mono text-[9px] text-[var(--text-4)]">{p.role}</span></span>
                    <span className="mono text-[var(--text-4)] shrink-0">
                      {p.standing === null ? "untested" : <span style={{ color: toneOf(p.standing) }}>{pctU(p.standing)}</span>} · {p.live_teams} live · {Math.round(p.elo)} elo · Brier {p.brier === null ? "—" : p.brier.toFixed(2)}{p.sits ? ` · ${p.sits} scored, right ${pct01(p.sit_right)}` : ""}
                    </span>
                  </p>
                </div>
              ))}
              <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">
                Every model in the pools. A frontier decides for a team; a worker is one of the crew every team shares, and researches and votes on every candidate. Standing is the average ranked return of the teams a frontier has led, living and dead — untested means it has not led one yet; the crew is shared, so a worker has no standing of its own, only its ratings. Live is how many teams it is on right now. Elo is a rating that rises when it is right where others were wrong; 1500 is average. Brier scores how honest its confidence is: 0 is perfect, 0.25 is a coin flip with no idea, higher is worse than saying fifty-fifty every time. Scored is how many of its votes have played out, and right is how often the side it voted for was the one that paid.
              </p>
            </Card>
          )}

          {t.trades.length > 0 && (
            <Card className="mt-2.5">
              <Eyebrow className="mb-1">The trades the review read</Eyebrow>
              {t.trades.map((x, i) => (
                <div key={i} className="py-1.5 border-t border-[var(--border-1)]">
                  <p className="text-[10.5px] flex items-baseline gap-2">
                    <span className="mono font-semibold">{x.symbol}</span>
                    <span className="text-[var(--text-3)] flex-1 min-w-0 truncate">{x.side}{x.team ? ` · ${x.team}` : ""}{x.strategy ? ` · ${stratName(x.strategy)}` : ""} · {EXIT[x.exit] ?? x.exit}</span>
                    <span className="mono shrink-0" style={{ color: toneOf(x.r) }}>{fmtR(x.r)}</span>
                  </p>
                  {(x.quadrant || x.grade) && (
                    <p className="text-[10px] text-[var(--text-4)] mt-0.5 leading-snug">{QUADRANT[x.quadrant] ?? x.quadrant}{x.grade ? `${x.quadrant ? " · " : ""}process ${x.grade}` : ""}</p>
                  )}
                  {x.lesson && <p className="text-[10.5px] text-[var(--text-2)] mt-0.5 leading-snug"><span className="text-[var(--text-4)]">Lesson:</span> <Lingo text={x.lesson} /></p>}
                </div>
              ))}
              <p className="text-[10px] text-[var(--text-4)] mt-1.5 leading-relaxed">
                The trades this review actually read, newest first. R is profit in units of the risk taken, so a 2R win made twice what it stood to lose. The quadrant is the micro review&apos;s judgment on process against outcome: good thinking can lose and bad thinking can win, and only one of those is worth repeating. Open any of them under Journal.
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
