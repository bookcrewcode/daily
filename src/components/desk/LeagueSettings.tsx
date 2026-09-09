"use client";

// The rules of the leagues, in one place. Every field says in plain words
// what it changes, and nothing saves until all of them are inside their
// range. The two buttons at the bottom do by hand what the clock does on its
// own: the daily cut, and a session.

import { useState } from "react";
import { Card, Eyebrow, Segmented } from "../ui";
import { Note } from "./LeagueBits";
import { updateAccount, callFn, LEAGUE_FN, modelLabel, fmtMoney, MODEL_ID, type Account } from "@/lib/desk/api";
import { leagueSettings, type LeagueSettings as Settings } from "@/lib/desk/league";

const lines = (s: string) => s.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
const num = (s: string) => Number(s.trim());

/** The function answers with whatever it did; say it plainly, whatever shape it takes. */
function resultLine(r: Record<string, unknown>, ok: string): string {
  if (typeof r.error === "string" && r.error) return r.error;
  const bits: string[] = [];
  for (const k of ["teams", "formed", "died", "kicked", "launched", "decisions", "taken", "closed"]) {
    const v = r[k];
    if (typeof v === "number" && v > 0) bits.push(`${v} ${k}`);
    else if (Array.isArray(v) && v.length) bits.push(`${v.length} ${k}`);
  }
  return bits.length ? `${ok} ${bits.join(" · ")}.` : ok;
}

export default function LeagueSettings({ uid, account, onSaved }: { uid: string; account: Account; onSaved: () => void }) {
  const saved = leagueSettings(account.league);
  const [open, setOpen] = useState(false);
  const [frontiers, setFrontiers] = useState(saved.frontier_pool.join("\n"));
  const [workers, setWorkers] = useState(saved.worker_pool.join("\n"));
  const [perTier, setPerTier] = useState(String(saved.teams_per_tier));
  const [perTeam, setPerTeam] = useState(String(saved.workers_per_team));
  const [death, setDeath] = useState(String(saved.death_pct));
  const [risk, setRisk] = useState(String(saved.risk_max_pct));
  const [budget, setBudget] = useState(String(saved.budget_usd_day));
  const [research, setResearch] = useState<Settings["research"]>(saved.research);
  const [times, setTimes] = useState(saved.session_times.join(", "));
  const [days, setDays] = useState(String(saved.season_days));
  const [minTakes, setMinTakes] = useState(String(saved.min_takes_day));
  const [minHeat, setMinHeat] = useState(String(saved.min_heat_pct));
  const [penalty, setPenalty] = useState(String(saved.passive_penalty_pct));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [cutNote, setCutNote] = useState("");
  const [sessionNote, setSessionNote] = useState("");

  const fp = lines(frontiers), wp = lines(workers);
  const st = times.split(",").map((x) => x.trim()).filter(Boolean);
  const nPerTier = num(perTier), nPerTeam = num(perTeam), nDeath = num(death), nRisk = num(risk), nBudget = num(budget), nDays = num(days);

  const problems: string[] = [];
  if (fp.length < 1) problems.push("the frontier pool needs at least one model");
  if (fp.some((m) => !MODEL_ID.test(m))) problems.push("a frontier is not a model id like anthropic/claude-opus-5");
  if (wp.some((m) => !MODEL_ID.test(m))) problems.push("a worker is not a model id");
  if (!(nPerTier >= 1 && nPerTier <= 5)) problems.push("teams per tier must be 1 to 5");
  if (!(nPerTeam >= 2 && nPerTeam <= 6)) problems.push("workers per team must be 2 to 6");
  if (wp.length < nPerTeam) problems.push(`the worker pool needs at least ${Number.isFinite(nPerTeam) ? nPerTeam : "enough"} models to fill one team`);
  if (!(nDeath >= 1 && nDeath <= 50)) problems.push("the death line must be 1% to 50%");
  if (!(nRisk >= 0.5 && nRisk <= 10)) problems.push("risk per trade must be 0.5% to 10%");
  if (!(nBudget >= 0 && nBudget <= 500)) problems.push("the daily budget must be $0 to $500");
  if (!st.length || st.some((t) => !/^\d{2}:\d{2}$/.test(t))) problems.push("session times must be HH:MM, comma separated");
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
      frontier_pool: fp, worker_pool: wp, teams_per_tier: Math.floor(nPerTier), workers_per_team: Math.floor(nPerTeam),
      death_pct: nDeath, risk_max_pct: nRisk, budget_usd_day: nBudget, research, session_times: st, season_days: Math.floor(nDays),
      min_takes_day: Math.floor(nTakes), min_heat_pct: nHeat, passive_penalty_pct: nPenalty,
    };
    const r = await updateAccount(uid, { league: next });
    setSaving(false);
    if (r.error) { setErr(r.error); return; }
    setMsg("Saved. The next tick reads these.");
    onSaved();
  }

  async function run(mode: "council" | "session") {
    if (busy) return;
    setBusy(mode);
    if (mode === "council") setCutNote(""); else setSessionNote("");
    const r = await callFn<Record<string, unknown>>(LEAGUE_FN, { mode, force: true }, 150_000);
    const line = resultLine(r, mode === "council" ? "The cut ran." : "The session ran.");
    if (mode === "council") setCutNote(line); else setSessionNote(line);
    setBusy("");
    if (!r.error) onSaved();
  }

  return (
    <Card className="mt-3">
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left flex items-baseline justify-between active:scale-[0.995]">
        <Eyebrow>League settings</Eyebrow>
        <span className="mono text-[10px] text-[var(--text-4)]">
          {saved.teams_per_tier * 3} teams · 1 + {saved.workers_per_team} each · dies at −{saved.death_pct}% · {fmtMoney(saved.budget_usd_day, 0)}/day {open ? "▴" : "▾"}
        </span>
      </button>

      {open && (
        <div className="mt-3 rise-in space-y-4">
          <div>
            <p className="text-[11px] font-semibold mb-1">Frontier pool <span className="mono text-[9px] text-[var(--text-4)] font-normal">one model id per line</span></p>
            <textarea value={frontiers} onChange={(e) => setFrontiers(e.target.value)} rows={Math.min(12, Math.max(4, fp.length + 1))} spellCheck={false}
              className="w-full rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] leading-relaxed outline-none focus:border-[var(--neon)]/50" />
            <Note className="mt-1">The strong models. One of these leads each team: it reads its workers&apos; votes and makes the call, and it does barely any of the brute work. No model may lead more than two live teams at once.</Note>
          </div>

          <div>
            <p className="text-[11px] font-semibold mb-1">Worker pool <span className="mono text-[9px] text-[var(--text-4)] font-normal">one model id per line</span></p>
            <textarea value={workers} onChange={(e) => setWorkers(e.target.value)} rows={Math.min(14, Math.max(4, wp.length + 1))} spellCheck={false}
              className="w-full rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] leading-relaxed outline-none focus:border-[var(--neon)]/50" />
            <Note className="mt-1">The fast, cheap models. {wp.length ? `${wp.slice(0, 4).map(modelLabel).join(" · ")}${wp.length > 4 ? ` and ${wp.length - 4} more` : ""}. ` : ""}They read every candidate, do the research and vote take or pass. Keep them cheap: they do almost all the calls.</Note>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Teams per tier" value={perTier} onChange={setPerTier} note={`How many teams sit in Diamond, in Gold and in Bronze. ${Number.isFinite(nPerTier) ? Math.floor(nPerTier) * 3 : 9} teams in all. 1 to 5.`} />
            <Field label="Workers per team" value={perTeam} onChange={setPerTeam} note="How many workers sit behind each frontier. More workers means a wider vote and a bigger bill. 2 to 6." />
            <Field label="Death line" value={death} onChange={setDeath} note={`A team dies the moment its book touches this far below its start — ${fmtMoney(100000 * (1 - (Number.isFinite(nDeath) ? nDeath : 5) / 100))} on a $100,000 book. Checked at every five-minute tick. 1 to 50.`} />
            <Field label="Most risk per trade" value={risk} onChange={setRisk} note="The most of its book a frontier may put at risk on one trade, entry to stop, as a percent. Size is worked back from this; a model never picks it. 0.5 to 10." />
            <Field label="Budget a day" value={budget} onChange={setBudget} note="Dollars of credit all the teams together may spend on model calls in a day. When it is gone the teams stop reading candidates until tomorrow. 0 to 500." />
            <Field label="Season length" value={days} onChange={setDays} note="Days in a season. At the last daily cut the team on top is the champion, and the desk mirrors it from then on. 3 to 90." />
            <Field label="Takes a day" value={minTakes} onChange={setMinTakes} note="Playing to survive, part one: a team that takes fewer trades than this in a day, and also keeps less than the risk-on floor at risk, is passive that day. 0 to 20." />
            <Field label="Risk on" value={minHeat} onChange={setMinHeat} note="Playing to survive, part two: the share of the book at risk in open positions (entry to stop) a team must keep, as a percent, to count as active. 0 to 50." />
            <Field label="Passive penalty" value={penalty} onChange={setPenalty} note="Percent docked from a team's ranked return for every passive day. The ranked return decides the tiers and who is cut; a passive team is cut before any active one. 0 to 10." />
          </div>

          <div>
            <p className="text-[11px] font-semibold mb-1.5">Research</p>
            <Segmented value={research} onChange={setResearch} options={[{ key: "off", label: "Off" }, { key: "light", label: "Light" }]} />
            <Note className="mt-1.5">
              Light lets a worker look twice before it votes: bars at another interval, the funding rate, a news search, and the strategy&apos;s own record. Off means one look at the brief and a vote. Light costs more and takes longer, and is the reason a worker is worth having.
            </Note>
          </div>

          <div>
            <p className="text-[11px] font-semibold mb-1">Session times <span className="mono text-[9px] text-[var(--text-4)] font-normal">HH:MM New York, comma separated</span></p>
            <input value={times} onChange={(e) => setTimes(e.target.value)} spellCheck={false}
              className="w-full rounded-lg bg-black/30 border border-[var(--border-1)] px-3 py-2 mono text-[11px] outline-none focus:border-[var(--neon)]/50" />
            <Note className="mt-1">At each of these the frontier sits down with everything its team holds and may close, tighten or leave it alone, and the workers put new ideas in front of it. Six is the most. These are clock times in New York, not your phone&apos;s time zone.</Note>
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
              <button onClick={() => run("council")} disabled={busy !== ""} className="rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] text-xs font-semibold px-3 py-2 active:scale-95 disabled:opacity-50">
                {busy === "council" ? "Running the cut…" : "Run the daily cut now"}
              </button>
              <Note className="mt-1">Ranks the live teams, sets the tiers, kills the worst book in Bronze, forms its replacement, and holds every team&apos;s council. It runs by itself at 16:06 New York time; this does it early. It can take a couple of minutes.</Note>
              {cutNote && <p className="text-[11px] text-[var(--text-3)] mt-1">{cutNote}</p>}
            </div>
            <div>
              <button onClick={() => run("session")} disabled={busy !== ""} className="rounded-lg bg-[var(--neon)]/15 text-[var(--neon)] text-xs font-semibold px-3 py-2 active:scale-95 disabled:opacity-50">
                {busy === "session" ? "Holding the session…" : "Hold a session now"}
              </button>
              <Note className="mt-1">Every frontier reviews what its team holds and its workers put new ideas up, right now, instead of waiting for the next session time.</Note>
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
