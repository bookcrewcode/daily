"use client";

// Ticket — what the desk wrote down the moment a team took a trade: the risk
// it accepted, the size that risk bought, the levels, the costs, the rule
// checks, the book before and after, who said what, and the price it went in
// at. Every line is money that only exists on paper. Compact mode is the two
// lines a decision card shows; the full ticket explains each part in plain
// words, because a number nobody can read is not a record of anything.

import { useState } from "react";
import { fmtMoney, fmtPct, fmtPrice, modelLabel } from "@/lib/desk/api";
import { STRATEGIES } from "@/lib/desk/scan";

type Check = { name: string; pass: boolean; detail: string };

const TF: Record<string, string> = { scalp: "scalp · hours", swing: "swing · days", position: "position · weeks" };
const INSTRUMENT: Record<string, string> = { stock: "stock", etf: "ETF", crypto_spot: "spot crypto", crypto_perp: "perpetual future" };
const stratName = (id: string) => STRATEGIES.find((s) => s.id === id)?.name ?? id;

const num = (v: unknown): number | null => { const x = Number(v); return typeof v !== "boolean" && v !== null && v !== "" && v !== undefined && Number.isFinite(x) ? x : null; };
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const has = (v: number | null): v is number => v !== null;

// The ticket keeps percentages in percent units: 2.0 means 2%.
const pct = (v: number, d = 1) => `${v.toFixed(d)}%`;
const spct = (v: number, d = 1) => fmtPct(v / 100, d); // signed, for numbers that can go either way
const count = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 4 });
const units = (unit: string, qty: number | null) => {
  const u = unit || "unit";
  return qty !== null && Math.abs(qty) === 1 ? u : `${u}s`;
};
/** A timestamp read straight off the string: no clock, no timezone surprises. */
function stamp(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) { const s = new Date(v).toISOString(); return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`; }
  const t = str(v).trim();
  if (t.length < 16) return t;
  const base = `${t.slice(0, 10)} ${t.slice(11, 16)}`;
  return t.endsWith("Z") ? `${base} UTC` : base;
}

export default function Ticket({ ticket, compact }: { ticket: Record<string, unknown>; compact?: boolean }) {
  const [showChecks, setShowChecks] = useState(false);
  const t = rec(ticket);

  const riskPct = num(t.risk_pct), riskUsd = num(t.risk_usd);
  const qty = num(t.qty), unit = str(t.unit), contractValue = num(t.contract_value);
  const notional = num(t.notional), leverage = num(t.leverage), margin = num(t.margin);
  const liq = num(t.liq_price), liqBuf = num(t.liq_buffer_pct);
  const entry = num(t.entry_ref), stop = num(t.stop), target = num(t.target);
  const stopPct = num(t.stop_dist_pct), stopAtr = num(t.stop_dist_atr), targetPct = num(t.target_dist_pct), rr = num(t.rr);

  const betLine = [
    has(riskPct) ? `risk ${pct(riskPct)}${has(riskUsd) ? ` (${fmtMoney(riskUsd)})` : ""}` : "",
    has(qty) ? `${count(qty)} ${units(unit, qty)}` : "",
    has(notional) ? `${fmtMoney(notional)} notional` : "",
    has(leverage) && leverage > 1 ? `${count(leverage)}x` : "",
    has(margin) ? `margin ${fmtMoney(margin)}` : "",
  ].filter(Boolean).join(" · ");
  const levelLine = [
    has(stopPct) ? `stop ${pct(stopPct)} away${has(stopAtr) ? ` (${stopAtr.toFixed(1)} ATR)` : ""}` : "",
    has(targetPct) ? `target ${pct(targetPct)}` : "",
    has(rr) ? `${rr.toFixed(1)}:1` : "",
    has(liq) ? `liquidation $${fmtPrice(liq)}${has(liqBuf) ? `, ${pct(liqBuf, 0)} past the stop` : ""}` : "",
  ].filter(Boolean).join(" · ");

  if (compact) {
    if (!betLine && !levelLine) return null;
    return (
      <div>
        {betLine && <p className="mono text-[10.5px] text-[var(--text-2)] leading-snug">{betLine}</p>}
        {levelLine && <p className="mono text-[10.5px] text-[var(--text-2)] leading-snug mt-0.5">{levelLine}</p>}
        <p className="text-[10px] text-[var(--text-4)] leading-snug mt-0.5">Paper money. Nothing is placed with a broker.</p>
      </div>
    );
  }

  const symbol = str(t.symbol), side = str(t.side), strategy = str(t.strategy), timeframe = str(t.timeframe);
  const instrument = str(t.instrument), venue = str(t.venue), team = str(t.team), kind = str(t.kind);
  const equity = num(t.equity), deathLine = num(t.death_line), toDeath = num(t.distance_to_death_pct);
  const fees = num(t.fees_est), fundingRate = num(t.funding_rate), fundingEst = num(t.funding_est), slippage = num(t.slippage_bps);
  const horizon = str(t.horizon), expires = str(t.expires);
  const checks = list(t.checks).map(rec).map((c): Check => ({ name: str(c.name), pass: c.pass === true, detail: str(c.detail) }));
  const before = rec(t.exposure_before), after = rec(t.exposure_after);
  const workers = rec(t.workers), frontier = rec(t.frontier), price = rec(t.price_check);
  const failed = checks.filter((c) => !c.pass).length;

  const idLine = [
    symbol,
    side,
    strategy ? stratName(strategy) : "",
    TF[timeframe] ?? timeframe,
    INSTRUMENT[instrument] ?? instrument,
    venue,
  ].filter(Boolean).join(" · ");

  const move = (bKey: string, money: boolean) => {
    const b = num(before[bKey]), a = num(after[bKey]);
    if (!has(b) && !has(a)) return null;
    const f = (v: number | null) => (has(v) ? (money ? fmtMoney(v) : count(v)) : "not recorded");
    return `${f(b)}, then ${f(a)}`;
  };

  const take = num(workers.take), passed = num(workers.pass), answered = num(workers.answered), score = num(workers.score);
  const askedRisk = num(frontier.risk_pct_asked), askedLev = num(frontier.leverage_asked);
  const priceRef = num(price.ref), priceNow = num(price.now), progress = num(price.progress_pct);

  return (
    <div className="space-y-3">
      <div>
        <p className="mono text-[11px] font-semibold text-[var(--text-2)]">{idLine || "the ticket"}</p>
        <p className="mono text-[9px] text-[var(--text-4)] mt-0.5">
          {[team, kind === "session" ? "from a worker's own idea" : kind === "candidate" ? "from a flagged setup" : kind, stamp(t.at)].filter(Boolean).join(" · ")}
        </p>
        <p className="text-[11px] text-[var(--text-3)] leading-snug mt-1">
          The ticket is everything that went into the trade, written the moment it was taken. All money here is paper: nothing is placed with a broker.
        </p>
      </div>

      <Section title="The bet" note="Risk is what one stop costs, as a share of the team's paper book. Size is worked back from it and the stop distance; no model picks a size.">
        <Rows>
          <Row label="Risk on this trade" value={has(riskPct) ? `${pct(riskPct)}${has(riskUsd) ? ` of the book (${fmtMoney(riskUsd)} paper)` : ""}` : null} />
          <Row label="Size" value={has(qty) ? `${count(qty)} ${units(unit, qty)}` : null} />
          <Row label="One contract is worth" value={unit === "contract" && has(contractValue) ? fmtMoney(contractValue, 2) : null} />
          <Row label="Notional (the full position)" value={has(notional) ? `${fmtMoney(notional)} paper` : null} />
          <Row label="Leverage" value={has(leverage) ? `${count(leverage)}x` : null} />
          <Row label="Margin put up" value={has(margin) ? `${fmtMoney(margin)} paper` : null} />
          <Row label="Liquidation price" value={has(liq) ? `$${fmtPrice(liq)}${has(liqBuf) ? `, ${pct(liqBuf, 0)} past the stop` : ""}` : null} tone="var(--warn)" />
        </Rows>
      </Section>

      <Section title="The levels" note="The stop is where the trade is wrong and it closes. The target is where it takes the money. Reward to risk is how many times the risk the target pays. ATR is the average daily range, so 1.3 ATR means the stop sits about one normal day's move away.">
        <Rows>
          <Row label="Entry reference" value={has(entry) ? `$${fmtPrice(entry)}` : null} />
          <Row label="Stop" value={has(stop) ? `$${fmtPrice(stop)}${has(stopPct) ? ` · ${pct(stopPct)} away` : ""}${has(stopAtr) ? ` · ${stopAtr.toFixed(1)} ATR` : ""}` : null} tone="var(--bad)" />
          <Row label="Target" value={has(target) ? `$${fmtPrice(target)}${has(targetPct) ? ` · ${pct(targetPct)} away` : ""}` : null} tone="var(--ok)" />
          <Row label="Reward to risk" value={has(rr) ? `${rr.toFixed(1)}:1` : null} />
        </Rows>
      </Section>

      <Section title="Costs" note="Costs come off the paper book exactly as real ones would. Funding is the running fee perpetual traders pay each other every eight hours; a positive rate means the longs are paying. Slippage is the gap between the price asked for and the price got, in basis points, one hundredth of a percent each.">
        <Rows>
          <Row label="Fees, in and out" value={has(fees) ? `${fmtMoney(fees, 2)} paper` : null} />
          <Row label="Funding rate, every 8 hours" value={has(fundingRate) ? spct(fundingRate, 3) : null} />
          <Row label="Funding over the hold" value={has(fundingEst) ? `about ${fmtMoney(fundingEst, 2)} paper` : null} />
          <Row label="Slippage allowed" value={has(slippage) ? `${count(slippage)} basis points (${pct(slippage / 100, 2)})` : null} />
        </Rows>
      </Section>

      <Section title="The clock" note="The horizon is how long the trade is meant to live. At the expiry it is closed at the next price, win or lose, so a bad idea cannot quietly become a long-term hold.">
        <Rows>
          <Row label="Horizon" value={horizon || null} />
          <Row label="Closed no later than" value={expires || null} />
        </Rows>
      </Section>

      {checks.length > 0 && (
        <Section title="The checks" note="Every rule the desk tests in code before a trade is allowed out. One fail and it is not taken; no model can talk its way past these.">
          <button onClick={() => setShowChecks(!showChecks)} className="mono text-[10px] text-[var(--text-3)] active:scale-95">
            {checks.length - failed} of {checks.length} passed{failed ? ` · ${failed} failed` : ""} · {showChecks ? "hide them" : "show each one"}
          </button>
          {showChecks && (
            <div className="mt-1 space-y-0.5 rise-in">
              {checks.map((c, i) => (
                <p key={i} className="text-[11px] leading-snug">
                  <span className="mono text-[9px]" style={{ color: c.pass ? "var(--ok)" : "var(--bad)" }}>{c.pass ? "ok" : "no"}</span>{" "}
                  <span className="text-[var(--text-2)]">{c.name}</span>{c.detail ? <span className="text-[var(--text-4)]"> {c.detail}</span> : null}
                </p>
              ))}
            </div>
          )}
        </Section>
      )}

      <Section title="The book" note="Gross is the size of everything the team has open. Heat is the money at risk if every stop hits at once. The death line is where the team's book is closed for good.">
        <Rows>
          <Row label="The team's paper book" value={has(equity) ? fmtMoney(equity) : null} />
          <Row label="Death line" value={has(deathLine) ? `${fmtMoney(deathLine)}${has(toDeath) ? ` · ${spct(toDeath)} away` : ""}` : null} />
          <Row label="Open positions, before and after" value={move("positions", false)} />
          <Row label="Gross notional, before and after" value={move("gross", true)} />
          <Row label="Heat, before and after" value={move("heat", true)} />
        </Rows>
      </Section>

      <Section title="The room" note="The workers vote first; the frontier that leads the team decides. It may ask for less risk or less leverage than the rules allow, never more, and the code is what actually sets the number.">
        <Rows>
          <Row label="Workers" value={has(answered) ? `${has(take) ? take : 0} of ${answered} said take${has(passed) ? `, ${passed} said pass` : ""}` : null} />
          <Row label="Weighted score" value={has(score) ? `${score >= 0 ? "+" : ""}${score.toFixed(2)}` : null} />
          <Row label="The frontier" value={str(frontier.model) ? modelLabel(str(frontier.model)) : null} />
          <Row label="It asked for" value={has(askedRisk) || has(askedLev) ? [has(askedRisk) ? `${pct(askedRisk)} risk` : "", has(askedLev) ? `${count(askedLev)}x` : ""].filter(Boolean).join(" · ") : null} />
          <Row label="The code gave it" value={has(riskPct) || has(leverage) ? [has(riskPct) ? `${pct(riskPct)} risk` : "", has(leverage) ? `${count(leverage)}x` : ""].filter(Boolean).join(" · ") : null} />
        </Rows>
        {str(frontier.reason) && <p className="text-[11.5px] text-[var(--text-2)] leading-snug mt-1.5">{str(frontier.reason)}</p>}
      </Section>

      <Section title="The price" note="The desk looks at the price once more before it takes the setup. Too far along already and it passes: the easy part of the move is gone.">
        <Rows>
          <Row label="Price when the setup was flagged" value={has(priceRef) ? `$${fmtPrice(priceRef)}` : null} />
          <Row label="Price when it was taken" value={has(priceNow) ? `$${fmtPrice(priceNow)}` : null} />
          <Row label="Already moved toward the target" value={has(progress) ? pct(progress) : null} />
        </Rows>
      </Section>

      {t.mirrored_to_desk === true && (
        <p className="text-[11px] text-[var(--text-3)] leading-snug">This trade was also copied onto the main desk book, so it shows up under the journal as well.</p>
      )}
    </div>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">{title}</p>
      <p className="text-[11px] text-[var(--text-3)] leading-snug mt-0.5 mb-1.5">{note}</p>
      {children}
    </div>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 items-baseline">{children}</div>;
}

function Row({ label, value, tone }: { label: string; value: string | null; tone?: string }) {
  if (!value) return null;
  return (
    <>
      <span className="text-[11.5px] text-[var(--text-3)] leading-snug">{label}</span>
      <span className="mono text-[11px] text-right leading-snug" style={tone ? { color: tone } : undefined}>{value}</span>
    </>
  );
}
