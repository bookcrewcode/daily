"use client";

// The rules of the leagues, in one place. Every field says in plain words
// what it changes, and nothing saves until all of them are inside their
// range. The two buttons at the bottom do by hand what the clock does on its
// own: the daily ranking of the tiers, and a session.

import { useState } from "react";
import { Card, Eyebrow, Segmented } from "../ui";
import { Note } from "./LeagueBits";
import { updateAccount, callFn, LEAGUE_FN, modelLabel, fmtMoney, MODEL_ID, type Account } from "@/lib/desk/api";
import { leagueSettings, type LeagueSettings as Settings } from "@/lib/desk/league";

const lines = (s: string) => s.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
const num = (s: string) => Number(s.trim());
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The function answers with whatever it did; say it plainly, whatever shape it takes. */
function resultLine(r: Record<string, unknown>, ok: string): string {
  if (typeof r.error === "string" && r.error) return r.error;
  if (typeof r.note === "string" && r.note) return r.note;
  const bits: string[] = [];
  for (const k of ["teams", "formed", "died", "ranked", "passive", "launched", "decisions", "taken", "closed"]) {
    const v = r[k];
    if (typeof v === "number" && v > 0) bits.push(`${v} ${k}`);
    else if (Array.isArray(v) && v.length) bits.push(`${v.length} ${k}`);
  }
  if (typeof r.champion === "string" && r.champion) bits.push(`champion ${r.champion}`);
  return bits.length ? `${ok} ${bits.join(" · ")}.` : ok;
}

export default function LeagueSettings({ uid, account, onSaved }: { uid: string; account: Account; onSaved: () => void }) {
  const saved = leagueSettings(account.league);
  const [open, setOpen] = useState(false);
  const [frontiers, setFrontiers] = useState(saved.frontier_pool.join("\n"));
  const [workers, setWorkers] = useState(saved.worker_pool.join("\n"));
  const [perTier, setPerTier] = useState(String(saved.teams_per_tier));
  const [death, setDeath] = useState(String(saved.death_pct));
  const [risk, setRisk] = useState(String(saved.risk_max_pct));
  const [budget, setBudget] = useState(String(saved.budget_usd_day));
  const [research, setResearch] = useState<Settings["research"]>(saved.research);
  const [lookups, setLookups] = useState(String(saved.worker_lookups));
  const [stocksOpen, setStocksOpen] = useState(saved.hours.stocks[0]);
  const [stocksClose, setStocksClose] = useState(saved.hours.stocks[1]);
  const [cryptoOpen, setCryptoOpen] = useState(saved.hours.crypto[0]);
  const [cryptoClose, setCryptoClose] = useState(saved.hours.crypto[1]);
  const [times, setTimes] = useState(saved.session_times.join(", "));
  const [days, setDays] = useState(String(saved.season_days));
  const [minTakes, setMinTakes] = useState(String(saved.min_takes_day));
  const [minHeat, setMinHeat] = useState(String(saved.min_heat_pct));
  const [penalty, setPenalty] = useState(String(saved.passive_penalty_pct));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [rankNote, setRankNote] = useState("");
  const [sessionNote, setSessionNote] = useState("");

  const fp = lines(frontiers), wp = lines(workers);
  const st = times.split(",").map((x) => x.trim()).filter(Boolean);
  const nPerTier = num(perTier), nDeath = num(death), nRisk = num(risk), nBudget = num(budget), nDays = num(days), nLookups = num(lookups);
  const hours = [stocksOpen, stocksClose, cryptoOpen, cryptoClose];

  const problems: string[] = [];
  if (fp.length < 1) problems.push("the frontier pool needs at least one model");
  if (fp.some((m) => !MODEL_ID.test(m))) problems.push("a frontier is not a model id like anthropic/claude-opus-5");
  if (wp.length < 1) problems.push("the crew needs at least one model");
  if (wp.length > 6) problems.push("six is the most the crew can be");
  if (wp.some((m) => !MODEL_ID.test(m))) problems.push("a crew member is not a model id");
  if (!(nPerTier >= 1 && nPerTier <= 5)) problems.push("teams per tier must be 1 to 5");
  if (!(nDeath >= 1 && nDeath <= 50)) problems.push("the death line must be 1% to 50%");
  if (!(nRisk >= 0.5 && nRisk <= 10)) problems.push("risk per trade must be 0.5% to 10%");
  if (!(nBudget >= 0 && nBudget <= 500)) problems.push("the daily budget must be $0 to $500");
  if (!(nLookups >= 0 && nLookups <= 2)) problems.push("look-ups per ballot must be 0, 1 or 2");
  if (hours.some((h) => !HHMM.test(h))) problems.push("the hours must be HH:MM, New York time");
  if (!st.length || st.some((t) => !HHMM.test(t))) problems.push("session times must be HH:MM, comma separated");
  if (st.length > 6) problems.push("six session times is the most");
  if (!(nDays >= 3 && nDays <= 90)) problems.push("a season must be 3 to 90 days");
  const nTakes = Number(minTakes), nHeat = Number(minHeat), nPenalty = Number(penalty);
  if (!(nTakes >= 0 && nTakes <= 20)) problems.push("takes a day must be 0 to 20");
  if (!(nHeat >= 0 && nHeat <= 50)) problems.push("risk on must be 0% to 50%");
  if (!(nPenalty >= 0 && nPenalty <= 10)) problems.push("the passive penalty must be 0% to 10%");

  async function save() {
    if (saving || problems.length) return;
    setSaving(true); setErr(""); setMsg("");
    const next: Partial<Settings> = {
      frontier_pool: fp, worker_pool: wp, teams_per_tier: Math.floor(nPerTier),
      death_pct: nDeath, risk_max_pct: nRisk, budget_usd_day: nBudget, research, worker_lookups: Math.floor(nLookups),
      hours: { stocks: [stocksOpen, stocksClose], crypto: [cryptoOpen, cryptoClose] },
      session_times: st, season_days: Math.floor(nDays),
      min_takes_day: Math.floor(nTakes), min_heat_pct: nHeat, passive_penalty_pct: nPenalty,
    };
    const r = await updateAccount(uid, { league: next });
    setSaving(false);
    if (r.error) { setErr(r.error); return; }
    setMsg("Saved. The next tick reads these.");
    onSaved();
  }

  async function run(mode: "rank" | "session") {
    if (busy) return;
    setBusy(mode);
    if (mode === "rank") setRankNote(""); else setSessionNote("");
    const r = await callFn<Record<string, unknown>>(LEAGUE_FN, { mode, force: true }, 150_000);
    const line = resultLine(r, mode === "rank" ? "The tiers are re-ranked." : "The session ran.");
    if (mode === "rank") setRankNote(line); else setSessionNote(line);
    setBusy("");
    if (!r.error) onSaved();
  }

  return (
    <Card className="mt-3">
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left flex items-baseline justify-between active:scale-[0.995]">
        <Eyebrow>League settings</Eyebrow>
        <span className="mono text-[10px] text-[var(--text-4)]">
          {saved.teams_per_tier * 3} teams · one crew of {saved.worker_pool.length} · dies at −{saved.death_pct}% · {fmtMoney(saved.budget_usd_day, 0)}/day {open ? "▴" : "▾"}
        </span>
      </button>

      {open && (
        <div className="mt-3 rise-in space-y-4">
          <div>
            <p className="text-[11px] font-semibold mb-1">Frontier pool <span className="mono text-[9px] text-[var(--text-4)] font-normal">one model id per line</span></p>
            <textarea value={frontiers} onChange={(e) => setFrontiers(e.target.value)} rows={Math.min(12, Math.max(4, fp.length + 1))} spellCheck={false}
              className="w-full rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] leading-relaxed outline-none focus:border-[var(--neon)]/50" />
            <Note className="mt-1">The strong models. Forming deals one team per frontier here, in this order; each one reads the crew&apos;s votes and makes the call for its own team, and does barely any of the brute work.</Note>
          </div>

          <div>
            <p className="text-[11px] font-semibold mb-1">The crew <span className="mono text-[9px] text-[var(--text-4)] font-normal">one model id per line</span></p>
            <textarea value={workers} onChange={(e) => setWorkers(e.target.value)} rows={Math.min(8, Math.max(4, wp.length + 1))} spellCheck={false}
              className="w-full rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] leading-relaxed outline-none focus:border-[var(--neon)]/50" />
            <Note className="mt-1">These {wp.length === 4 ? "four" : wp.length} cheap models do the research for every team. {wp.length ? `${wp.slice(0, 4).map(modelLabel).join(" · ")}${wp.length > 4 ? ` and ${wp.length - 4} more` : ""}. ` : ""}They read every candidate once, look things up and vote take or pass; every frontier then decides on the same ballots. Keep them cheap: they do almost all the calls. Two to six.</Note>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Teams per tier" value={perTier} onChange={setPerTier} note={`How many teams sit in Diamond, in Gold and in Bronze. ${Number.isFinite(nPerTier) ? Math.floor(nPerTier) * 3 : 9} teams in all, one per frontier. 1 to 5.`} />
            <Field label="Look-ups per ballot" value={lookups} onChange={setLookups} note="How many things a worker may look up before it votes: bars at another interval, the funding rate, a news search, or the strategy's record. One forces it to pick the look-up that decides the vote. 0 to 2." />
            <Field label="Death line" value={death} onChange={setDeath} note={`A team dies the moment its book touches this far below its start — ${fmtMoney(100000 * (1 - (Number.isFinite(nDeath) ? nDeath : 5) / 100))} on a $100,000 book. Checked at every five-minute tick. 1 to 50.`} />
            <Field label="Most risk per trade" value={risk} onChange={setRisk} note="The most of its book a frontier may put at risk on one trade, entry to stop, as a percent. Size is worked back from this; a model never picks it. 0.5 to 10." />
            <Field label="Budget a day" value={budget} onChange={setBudget} note="Dollars of credit all the teams together may spend on model calls in a day. When it is gone the teams stop reading candidates until tomorrow. 0 to 500." />
            <Field label="Season length" value={days} onChange={setDays} note="Days in a season. At the last daily ranking the team on top is the champion, and the desk mirrors it from then on. 3 to 90." />
            <Field label="Takes a day" value={minTakes} onChange={setMinTakes} note="Playing to survive, part one: a team that takes fewer trades than this in a day, and also keeps less than the risk-on floor at risk, is passive that day. 0 to 20." />
            <Field label="Risk on" value={minHeat} onChange={setMinHeat} note="Playing to survive, part two: the share of the book at risk in open positions (entry to stop) a team must keep, as a percent, to count as active. 0 to 50." />
            <Field label="Passive penalty" value={penalty} onChange={setPenalty} note="Percent docked from a team's ranked return for every passive day. The ranked return decides the tiers and the champion. 0 to 10." />
          </div>

          <div>
            <p className="text-[11px] font-semibold mb-1.5">Trading hours <span className="mono text-[9px] text-[var(--text-4)] font-normal">New York time</span></p>
            <div className="grid grid-cols-2 gap-3">
              <TimeField label="Stocks open" value={stocksOpen} onChange={setStocksOpen} />
              <TimeField label="Stocks close" value={stocksClose} onChange={setStocksClose} />
              <TimeField label="Crypto open" value={cryptoOpen} onChange={setCryptoOpen} />
              <TimeField label="Crypto close" value={cryptoClose} onChange={setCryptoClose} />
            </div>
            <Note className="mt-1.5">New decisions and sessions only happen inside these windows: a stock setup is only put to the teams between the stock hours, a perp setup between the crypto hours. Positions are managed round the clock: fills, stops, targets and funding run at every tick whatever the hour. The open is inside the window, the close is outside it, and a window may cross midnight.</Note>
          </div>

          <div>
            <p className="text-[11px] font-semibold mb-1.5">Research</p>
            <Segmented value={research} onChange={setResearch} options={[{ key: "off", label: "Off" }, { key: "light", label: "Light" }]} />
            <Note className="mt-1.5">
              Light lets a worker look something up before it votes, as many times as the look-ups above allow. Off means one look at the brief and a vote. Light costs more and takes longer, and is the reason a worker is worth having.
            </Note>
          </div>

          <div>
            <p className="text-[11px] font-semibold mb-1">Session times <span className="mono text-[9px] text-[var(--text-4)] font-normal">HH:MM New York, comma separated</span></p>
            <input value={times} onChange={(e) => setTimes(e.target.value)} spellCheck={false}
              className="w-full rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] outline-none focus:border-[var(--neon)]/50" />
            <Note className="mt-1">At each of these the crew puts new ideas up once, and every frontier sits down with everything its team holds and may close, tighten or leave it alone. A session only fires inside trading hours. Six is the most. These are clock times in New York, not your phone&apos;s time zone.</Note>
          </div>

          {problems.length > 0 && <p className="text-[11px] text-orange-400 leading-relaxed">Not saved yet: {problems.join("; ")}.</p>}
          <div className="flex items-center gap-3">
            <button onClick={save} disabled={saving || problems.length > 0} className="rounded-lg bg-[var(--neon)] text-black text-xs font-bold px-4 py-2 active:scale-95 disabled:opacity-40">{saving ? "Saving…" : "Save"}</button>
            {msg && <span className="text-[11px] text-[var(--ok)]">{msg}</span>}
            {err && <span className="text-[11px] text-orange-400">{err}</span>}
          </div>

          <div className="pt-3 border-t border-[var(--border-1)] space-y-2.5">
            <p className="text-[11px] font-semibold">Do it now</p>
            <div>
              <button onClick={() => run("rank")} disabled={busy !== ""} className="rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] text-xs font-semibold px-3 py-2 active:scale-95 disabled:opacity-50">
                {busy === "rank" ? "Re-ranking…" : "Re-rank the tiers now"}
              </button>
              <Note className="mt-1">Ranks the live teams by ranked return, marks passive days, sets the tiers and, on the last day of a season, crowns the champion. It runs by itself at 16:06 New York time; this does it early.</Note>
              {rankNote && <p className="text-[11px] text-[var(--text-3)] mt-1">{rankNote}</p>}
            </div>
            <div>
              <button onClick={() => run("session")} disabled={busy !== ""} className="rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] text-xs font-semibold px-3 py-2 active:scale-95 disabled:opacity-50">
                {busy === "session" ? "Holding the session…" : "Hold a session now"}
              </button>
              <Note className="mt-1">Every frontier reviews what its team holds and the crew puts new ideas up, right now, instead of waiting for the next session time.</Note>
              {sessionNote && <p className="text-[11px] text-[var(--text-3)] mt-1">{sessionNote}</p>}
            </div>
          </div>

          <Note>Paper only. There is no broker key anywhere in this app.</Note>
        </div>
      )}
    </Card>
  );
}

function Field({ label, value, onChange, note }: { label: string; value: string; onChange: (v: string) => void; note: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold mb-1">{label}</p>
      <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal"
        className="w-full rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] outline-none focus:border-[var(--neon)]/50" />
      <Note className="mt-1">{note}</Note>
    </div>
  );
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <p className="text-[11px] font-semibold mb-1">{label}</p>
      <input type="time" value={value} onChange={(e) => onChange(e.target.value)} placeholder="HH:MM"
        className="w-full rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] outline-none focus:border-[var(--neon)]/50" />
    </div>
  );
}
