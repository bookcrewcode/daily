# Portfolio Copilot, Step 1: Holdings, Weekly Buy and Morning Report. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Invest" space to the Daily app for Ben's real Robinhood account. Ben types what he owns, the app records his weekly Wednesday buy, and a morning report on his holdings, the market and the news is ready at 08:30 ET.

**Architecture:** Pure TypeScript modules in `src/lib/portfolio/` do the math (lots into holdings, the weekly-buy schedule, the report prompt and its checks, the tick plan) and are tested with `node:test`. A copy script places them in a new Supabase edge function `pilot` that a five-minute cron drives. The function runs the existing news feed (`desk-feed`), records weekly lots using 5-minute bars from the existing `tape` function, and writes the report with one OpenRouter call under a $1/day cap. The app reads the `pf_` tables directly, and calls `tape` for live prices.

**Tech Stack:** Next.js 16 static export (React 19, Tailwind 4), Supabase (Postgres with RLS, Deno edge functions, pg_cron with pg_net), OpenRouter, `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-15-portfolio-copilot-design.md`. This plan covers build step 1 only: sections 1 and 2, the cost cap, and the Portfolio tab's holdings, report and settings. Steps 2 to 6 get their own plans.

## Global Constraints

- No order placement. Nothing places, cancels or changes a real order, and nothing holds broker credentials. Real money moves only when Ben taps in Robinhood.
- The app explains itself: every number and label is defined on screen, there are no hover-only `title` tooltips, and there are no emojis in the UI.
- A failed read never renders like an empty state. Loaders return `{ ..., error }`, and the UI says what failed.
- Hard cap of $1 a day on model calls (`pf_settings.cap_usd_day`, default 1, max 5), enforced on the server by summing `pf_spend` since midnight New York time. The feed's tagging cost counts toward it.
- Report model is `google/gemini-3.8-flash`, with fallback `google/gemini-3.5-flash-lite`. The OpenRouter key is read with the `get_secret` RPC under the name `anthropic_api_key`.
- Never print the OpenRouter key or `desk_cron_secret` in output, logs or commits.
- Ben never touches Supabase. SQL goes through the Supabase MCP (`apply_migration` for schema, `execute_sql` for data and cron). Functions go through MCP `deploy_edge_function` with `verify_jwt: false`, project `pciljeqsrricybdnhvsu`.
- Ben's user id is `f0e1e204-aa54-4a45-bbb5-99c83114fecb`.
- Weekly buy day defaults to Wednesday (`buy_dow` 3; 1 is Monday and 5 is Friday). If the buy day is a market holiday, the buy moves to the next trading day.
- The Desk stays paused. Do not re-enable the `desk-tick` (job 13) or `desk-coach` (job 12) crons.
- Lib copies drop blank and comment-only lines (`scripts/desk-sync-libs.mjs`), so template strings in `src/lib/portfolio/*` must never contain blank lines.
- Worktree: `/Users/bengarnet/Downloads/daily/.worktrees/desk`, branch `desk`, already merged with `origin/main` (0aeca18). Run every command from the worktree root.
- Commit messages are written to a file and committed with `git commit -F <file>`. They end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A buy day on a market holiday** (Thanksgiving Thursday, Christmas Friday): the weekly lot lands on the next trading day, even when that day is in the next week, and only once. Covered by Task 2's `buyDateForWeek` and `dueWeeklyLots` holiday tests.
2. **The cron missing the buy day** (outage, deploy gap): the lot is caught up within 14 days and never dated before `recurring_since`. The partial unique index stops a second copy. Covered by Task 2's catch-up and lookback tests, and the duplicate-run check in Task 6 Step 7.
3. **Holdings typed after weekly lots were recorded**: the Robinhood numbers Ben types ("I already own this") replace everything before them, so nothing is counted twice. On the same day, entry order decides. Covered by Task 1's snapshot and same-day tests.
4. **No price for one holding** (Yahoo error, delisted ticker): totals leave it out and say so by name, and never treat it as $0. Covered by Task 1's missing-price test and the warning line in Task 7.
5. **The report model fails or answers in the wrong shape, or the day's budget is used up**: the report row says why, retries stop after three tries, and nothing is spent past the cap. Covered by Task 3's `parseReport` and `reportDue` tests and Task 4's budget test.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/portfolio/lots.ts` (create) | Lots into holdings and totals: average cost, sales, snapshots, missing prices. Pure. |
| `src/lib/portfolio/weekly.ts` (create) | Weekly buy date for a week, which weekly lots are due, the 9:35 price, fractional shares, New York midnight. Pure. |
| `src/lib/portfolio/report.ts` (create) | Report input types, prompt, JSON schema, answer check, retry rule. Pure. |
| `src/lib/portfolio/tick.ts` (create) | What the five-minute tick starts (feed, lots, report). Pure. |
| `src/lib/portfolio/*.test.ts` (create) | `node:test` tests for each module above. |
| `scripts/desk-sync-libs.mjs` (modify) | Also copies `src/lib/portfolio` modules into `supabase/functions/pilot/lib`. |
| `supabase/desk/008_portfolio.sql` (create) | Record of the `pf_` tables, RLS and spend RPCs, applied by MCP. |
| `supabase/desk/009_pilot_cron.sql` (create) | Record of the `pilot-tick` cron, applied by MCP. |
| `supabase/functions/pilot/index.ts` (create) | The edge function: modes `tick`, `feed`, `lots`, `report`. |
| `src/lib/portfolio/api.ts` (create) | Client loaders and writers for the `pf_` tables, prices and the pilot function. |
| `src/components/portfolio/fmt.ts` (create) | Shared formatting: signed money, tone colour, share counts. |
| `src/components/portfolio/PortfolioSpace.tsx` (create) | The space: totals card plus the Holdings, Report and Settings gears. |
| `src/components/portfolio/Holdings.tsx` (create) | Holdings list, each holding's entries (edit and delete), and the add form. |
| `src/components/portfolio/Report.tsx` (create) | Today's report and past reports, Write it now, AI cost today. |
| `src/components/portfolio/PortfolioSettings.tsx` (create) | Weekly buy rows, buy day, daily AI limit, pause. |
| `src/app/page.tsx` (modify) | Adds the "Invest" space. |

---

### Task 1: Lots into holdings

**Files:**
- Create: `src/lib/portfolio/lots.ts`
- Test: `src/lib/portfolio/lots.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type LotKind = "start" | "weekly" | "manual"`, `type Lot = { id: string; symbol: string; shares: number; price: number; day: string; kind: LotKind; assumed: boolean; note: string; created_at: string }`, `type Quote = { price: number; prevClose: number | null; name?: string }`, `type Holding`, `type Totals`, `lotOrder(a: Lot, b: Lot): number`, `holdingsOf(lots: Lot[], quotes: Record<string, Quote>): { holdings: Holding[]; totals: Totals }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/portfolio/lots.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { holdingsOf, type Lot, type LotKind } from "./lots";

let seq = 0;
const lot = (symbol: string, shares: number, price: number, day: string, kind: LotKind = "manual", extra: Partial<Lot> = {}): Lot => {
  seq++;
  return { id: `l${seq}`, symbol, shares, price, day, kind, assumed: false, note: "", created_at: new Date(Date.UTC(2026, 9, 16, 12) + seq * 1000).toISOString(), ...extra };
};
const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("buys add up at average cost; value, gain, today and weight come from the quote", () => {
  const { holdings, totals } = holdingsOf(
    [lot("SPCX", 5, 140, "2026-10-12", "start"), lot("SPCX", 2.726653, 146.7, "2026-10-14", "weekly", { assumed: true })],
    { SPCX: { price: 150, prevClose: 147, name: "Space Exploration Technologies Corp." } },
  );
  assert.equal(holdings.length, 1);
  const h = holdings[0];
  close(h.shares, 7.726653);
  close(h.cost, 700 + 2.726653 * 146.7);
  close(h.avgCost, (700 + 2.726653 * 146.7) / 7.726653);
  close(h.value, 7.726653 * 150);
  close(h.gain, 7.726653 * 150 - (700 + 2.726653 * 146.7));
  close(h.dayChange, 7.726653 * 3);
  close(h.weight, 1);
  assert.equal(h.assumedLots, 1);
  assert.equal(h.name, "Space Exploration Technologies Corp.");
  close(totals.value, 7.726653 * 150);
  assert.deepEqual(totals.missing, []);
});

test("a sale comes out at average cost and books the realized gain", () => {
  const { holdings } = holdingsOf(
    [lot("RKLB", 10, 100, "2026-10-01"), lot("RKLB", 10, 200, "2026-10-02"), lot("RKLB", -5, 180, "2026-10-03")],
    { RKLB: { price: 190, prevClose: null } },
  );
  close(holdings[0].shares, 15);
  close(holdings[0].cost, 2250);
  close(holdings[0].avgCost, 150);
  close(holdings[0].realized, 150);
  assert.equal(holdings[0].dayChange, null);
});

test("typed Robinhood numbers replace everything entered before them", () => {
  const { holdings } = holdingsOf(
    [lot("SPCX", 2, 100, "2026-10-07", "weekly", { assumed: true }), lot("SPCX", 10, 120, "2026-10-08", "start"), lot("SPCX", 1, 130, "2026-10-09", "weekly", { assumed: true })],
    { SPCX: { price: 130, prevClose: 130 } },
  );
  close(holdings[0].shares, 11);
  close(holdings[0].cost, 1330);
  assert.equal(holdings[0].assumedLots, 1);
});

test("on the same day, the order the entries were made decides", () => {
  const weeklyFirst = holdingsOf([lot("SPCX", 1, 146, "2026-10-14", "weekly"), lot("SPCX", 8, 140, "2026-10-14", "start")], { SPCX: { price: 150, prevClose: 150 } });
  close(weeklyFirst.holdings[0].shares, 8);
  close(weeklyFirst.holdings[0].cost, 1120);
  const startFirst = holdingsOf([lot("SPCX", 8, 140, "2026-10-14", "start"), lot("SPCX", 1, 146, "2026-10-14", "weekly")], { SPCX: { price: 150, prevClose: 150 } });
  close(startFirst.holdings[0].shares, 9);
  close(startFirst.holdings[0].cost, 1266);
});

test("a missing price leaves the holding out of the totals and names it", () => {
  const { holdings, totals } = holdingsOf(
    [lot("SPCX", 2, 100, "2026-10-01", "start"), lot("RKLB", 10, 50, "2026-10-01", "start")],
    { SPCX: { price: 110, prevClose: 100 } },
  );
  assert.equal(holdings[0].symbol, "SPCX");
  close(holdings[0].weight, 1);
  const rklb = holdings.find((h) => h.symbol === "RKLB")!;
  assert.equal(rklb.value, null);
  assert.equal(rklb.weight, null);
  close(totals.value, 220);
  close(totals.cost, 200);
  close(totals.gain, 20);
  close(totals.dayChange, 20);
  assert.deepEqual(totals.missing, ["RKLB"]);
});

test("selling everything closes the holding; selling more than held stops at zero", () => {
  const { holdings, totals } = holdingsOf([lot("ASTS", 3, 10, "2026-10-01"), lot("ASTS", -5, 12, "2026-10-02")], { ASTS: { price: 12, prevClose: 12 } });
  assert.equal(holdings.length, 0);
  close(totals.realized, 6);
});

test("symbols merge whatever their case", () => {
  const { holdings } = holdingsOf([lot("spcx", 1, 100, "2026-10-01"), lot("SPCX", 1, 120, "2026-10-02")], { SPCX: { price: 110, prevClose: 110 } });
  assert.equal(holdings.length, 1);
  close(holdings[0].shares, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/lib/portfolio/lots.test.ts`
Expected: FAIL with `Cannot find module './lots'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/portfolio/lots.ts`:

```ts
// Portfolio — lots and holdings. Pure.
// A lot is one entry in Ben's record of his real Robinhood account:
//   start   "I already own this": the shares and average cost Robinhood shows on that day.
//           It replaces everything entered for that stock before it (a snapshot), so
//           re-entering it is how the record is brought back in line with Robinhood.
//   weekly  the recurring Robinhood buy, recorded by the app (assumed until Ben checks it)
//   manual  a buy (positive shares) or a sale (negative shares) Ben entered
// Lots apply in date order, and in the order they were entered on the same day.
// A sale takes shares out at average cost; selling more than is held stops at zero.

export type LotKind = "start" | "weekly" | "manual";
export type Lot = { id: string; symbol: string; shares: number; price: number; day: string; kind: LotKind; assumed: boolean; note: string; created_at: string };
export type Quote = { price: number; prevClose: number | null; name?: string };
export type Holding = {
  symbol: string; name: string; shares: number; cost: number; avgCost: number; realized: number;
  price: number | null; value: number | null; gain: number | null; gainPct: number | null; dayChange: number | null; weight: number | null;
  assumedLots: number;
};
export type Totals = { value: number; cost: number; gain: number; gainPct: number | null; dayChange: number; realized: number; missing: string[] };

const EPS = 1e-9;

export function lotOrder(a: Lot, b: Lot): number {
  return a.day.localeCompare(b.day) || a.created_at.localeCompare(b.created_at) || Number(b.shares > 0) - Number(a.shares > 0);
}

export function holdingsOf(lots: Lot[], quotes: Record<string, Quote>): { holdings: Holding[]; totals: Totals } {
  const bySym = new Map<string, Lot[]>();
  for (const l of lots) {
    const s = l.symbol.toUpperCase();
    bySym.set(s, [...(bySym.get(s) ?? []), l]);
  }
  const holdings: Holding[] = [];
  let realizedAll = 0;
  for (const [symbol, list] of bySym) {
    let shares = 0, cost = 0, realized = 0, assumed = 0;
    for (const l of [...list].sort(lotOrder)) {
      if (l.kind === "start") { shares = Math.max(0, l.shares); cost = shares * l.price; assumed = 0; continue; }
      if (l.shares > 0) { shares += l.shares; cost += l.shares * l.price; if (l.assumed) assumed++; continue; }
      const sell = Math.min(-l.shares, shares);
      if (sell <= EPS) continue;
      const avg = cost / shares;
      realized += sell * (l.price - avg);
      cost -= sell * avg;
      shares -= sell;
    }
    realizedAll += realized;
    if (shares <= EPS) continue;
    const q = quotes[symbol];
    const price = q && Number.isFinite(q.price) && q.price > 0 ? q.price : null;
    const value = price === null ? null : shares * price;
    holdings.push({
      symbol, name: q?.name || symbol, shares, cost, avgCost: cost / shares, realized,
      price, value,
      gain: value === null ? null : value - cost,
      gainPct: value === null || cost <= EPS ? null : (value - cost) / cost,
      dayChange: price === null || q?.prevClose == null ? null : shares * (price - q.prevClose),
      weight: null, assumedLots: assumed,
    });
  }
  const priced = holdings.filter((h) => h.value !== null);
  const value = priced.reduce((a, h) => a + (h.value as number), 0);
  for (const h of priced) h.weight = value > EPS ? (h.value as number) / value : null;
  const cost = priced.reduce((a, h) => a + h.cost, 0);
  holdings.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.symbol.localeCompare(b.symbol));
  return {
    holdings,
    totals: {
      value, cost, gain: value - cost, gainPct: cost > EPS ? (value - cost) / cost : null,
      dayChange: priced.reduce((a, h) => a + (h.dayChange ?? 0), 0), realized: realizedAll,
      missing: holdings.filter((h) => h.value === null).map((h) => h.symbol),
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/lib/portfolio/lots.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/portfolio/lots.ts src/lib/portfolio/lots.test.ts
printf 'Portfolio: lots into holdings (average cost, sales, Robinhood snapshots, missing prices)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > /tmp/pf-msg.txt
git commit -q -F /tmp/pf-msg.txt
```

---

### Task 2: The weekly buy schedule

**Files:**
- Create: `src/lib/portfolio/weekly.ts`
- Test: `src/lib/portfolio/weekly.test.ts`

**Interfaces:**
- Consumes: `addDays`, `etParts`, `isTradingDay`, `nextSessionDate`, `sessionBounds`, `weekStart` from `src/lib/desk/clock.ts` (`weekStart` returns the Monday); `type Bar = { t: number; o: number; h: number; l: number; c: number; v: number }` from `src/lib/desk/types.ts`, where `t` is the epoch ms of the bar's open.
- Produces: `type Recurring = { symbol: string; usd: number }`, `type WeeklySettings = { recurring: Recurring[]; buyDow: number; since: string | null }`, `type DueLot = { symbol: string; usd: number; day: string }`, `buyDateForWeek(monday: string, buyDow: number): string`, `dueWeeklyLots(nowMs: number, s: WeeklySettings, existing: { symbol: string; day: string }[], lookbackDays?: number): DueLot[]`, `firstFiveMinutePrice(bars: Bar[], day: string): number | null`, `sharesFor(usd: number, price: number): number`, `etMidnightMs(day: string): number`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/portfolio/weekly.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buyDateForWeek, dueWeeklyLots, etMidnightMs, firstFiveMinutePrice, sharesFor } from "./weekly";
import type { Bar } from "../desk/types";

const ms = (iso: string) => Date.parse(iso);
const bar = (iso: string, c: number): Bar => ({ t: ms(iso), o: c, h: c, l: c, c, v: 1 });
const SPCX = [{ symbol: "SPCX", usd: 400 }];

test("the buy day is that week's weekday, or the next trading day after a holiday", () => {
  assert.equal(buyDateForWeek("2026-10-12", 3), "2026-10-14");
  assert.equal(buyDateForWeek("2026-11-23", 4), "2026-11-27"); // Thanksgiving Thursday moves to Friday
  assert.equal(buyDateForWeek("2026-12-21", 5), "2026-12-28"); // Christmas Friday moves to next Monday
});

test("a buy day's lot is due once the 9:30 bar is final, and only once", () => {
  const s = { recurring: SPCX, buyDow: 3, since: "2026-10-14" };
  const have = [{ symbol: "SPCX", day: "2026-10-14" }];
  assert.deepEqual(dueWeeklyLots(ms("2026-10-21T13:35:00Z"), s, have), []);
  assert.deepEqual(dueWeeklyLots(ms("2026-10-21T13:37:00Z"), s, have), [{ symbol: "SPCX", usd: 400, day: "2026-10-21" }]);
  assert.deepEqual(dueWeeklyLots(ms("2026-10-21T13:37:00Z"), s, [...have, { symbol: "SPCX", day: "2026-10-21" }]), []);
});

test("a missed buy day is caught up, but never before the weekly buy was set up", () => {
  const now = ms("2026-10-21T13:37:00Z");
  assert.deepEqual(dueWeeklyLots(now, { recurring: SPCX, buyDow: 3, since: "2026-10-14" }, []).map((d) => d.day), ["2026-10-14", "2026-10-21"]);
  assert.deepEqual(dueWeeklyLots(now, { recurring: SPCX, buyDow: 3, since: "2026-10-16" }, []).map((d) => d.day), ["2026-10-21"]);
  assert.deepEqual(dueWeeklyLots(now, { recurring: SPCX, buyDow: 3, since: "2026-09-01" }, []).map((d) => d.day), ["2026-10-07", "2026-10-14", "2026-10-21"]);
});

test("nothing is due without a start date, a ticker or an amount", () => {
  const now = ms("2026-10-21T13:37:00Z");
  assert.deepEqual(dueWeeklyLots(now, { recurring: SPCX, buyDow: 3, since: null }, []), []);
  assert.deepEqual(dueWeeklyLots(now, { recurring: [], buyDow: 3, since: "2026-10-21" }, []), []);
  assert.deepEqual(dueWeeklyLots(now, { recurring: [{ symbol: "SPCX", usd: 0 }], buyDow: 3, since: "2026-10-21" }, []), []);
});

test("a holiday buy day is recorded on the next trading day; tickers match whatever their case", () => {
  const s = { recurring: [{ symbol: "spcx", usd: 400 }], buyDow: 4, since: "2026-11-20" };
  assert.deepEqual(dueWeeklyLots(ms("2026-11-27T14:37:00Z"), s, []), [{ symbol: "SPCX", usd: 400, day: "2026-11-27" }]);
  assert.deepEqual(dueWeeklyLots(ms("2026-11-27T14:37:00Z"), s, [{ symbol: "SPCX", day: "2026-11-27" }]), []);
});

test("the 9:35 price is the close of the bar that opens at 9:30 New York time", () => {
  assert.equal(firstFiveMinutePrice([bar("2026-10-14T13:25:00Z", 1), bar("2026-10-14T13:30:00Z", 146.5), bar("2026-10-14T13:35:00Z", 147)], "2026-10-14"), 146.5);
  assert.equal(firstFiveMinutePrice([bar("2026-11-04T13:30:00Z", 1), bar("2026-11-04T14:30:00Z", 150)], "2026-11-04"), 150); // EST
  assert.equal(firstFiveMinutePrice([bar("2026-11-26T14:30:00Z", 150)], "2026-11-26"), null); // holiday
  assert.equal(firstFiveMinutePrice([bar("2026-10-14T13:45:00Z", 150)], "2026-10-14"), null);
});

test("shares are cut to six decimals, like Robinhood's fractional shares", () => {
  assert.equal(sharesFor(400, 146.7), 2.726653);
  assert.equal(sharesFor(400, 0), 0);
  assert.equal(sharesFor(-5, 10), 0);
});

test("midnight in New York, in both daylight and standard time", () => {
  assert.equal(etMidnightMs("2026-10-16"), ms("2026-10-16T04:00:00Z"));
  assert.equal(etMidnightMs("2026-12-01"), ms("2026-12-01T05:00:00Z"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/lib/portfolio/weekly.test.ts`
Expected: FAIL with `Cannot find module './weekly'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/portfolio/weekly.ts`:

```ts
// Portfolio — the weekly Robinhood buy. Pure.
// Ben's recurring investment runs in Robinhood itself; the app only records it,
// as an "assumed" lot at the close of the first five-minute bar after the open
// (09:30–09:35 ET), which he can correct when Robinhood's fill differs.
// A buy day that is a market holiday moves to the next trading day.

import { addDays, etParts, isTradingDay, nextSessionDate, sessionBounds, weekStart } from "../desk/clock";
import type { Bar } from "../desk/types";

export type Recurring = { symbol: string; usd: number };
export type WeeklySettings = { recurring: Recurring[]; buyDow: number; since: string | null };
export type DueLot = { symbol: string; usd: number; day: string };

export const FIRST_BAR_MS = 5 * 60_000;
export const SETTLE_MS = 6 * 60_000; // the 09:30 bar is final by 09:36

export function buyDateForWeek(monday: string, buyDow: number): string {
  const d = addDays(monday, Math.min(5, Math.max(1, Math.round(buyDow))) - 1);
  return isTradingDay(d) ? d : nextSessionDate(d);
}

// Every weekly lot that should exist by now and doesn't: the buy days from
// lookbackDays ago through today, on or after the day the weekly buy was set up.
export function dueWeeklyLots(nowMs: number, s: WeeklySettings, existing: { symbol: string; day: string }[], lookbackDays = 14): DueLot[] {
  if (!s.since || !s.recurring.length) return [];
  const today = etParts(nowMs).date;
  const from = addDays(today, -lookbackDays);
  const have = new Set(existing.map((e) => `${e.symbol.toUpperCase()}|${e.day}`));
  const days = new Set<string>();
  for (let w = weekStart(from); w <= today; w = addDays(w, 7)) days.add(buyDateForWeek(w, s.buyDow));
  const out: DueLot[] = [];
  for (const day of [...days].sort()) {
    if (day < s.since || day < from || day > today) continue;
    const b = sessionBounds(day);
    if (!b || nowMs < b.openMs + SETTLE_MS) continue;
    for (const r of s.recurring) {
      const symbol = r.symbol.toUpperCase();
      if (!(r.usd > 0) || have.has(`${symbol}|${day}`)) continue;
      out.push({ symbol, usd: r.usd, day });
    }
  }
  return out;
}

export function firstFiveMinutePrice(bars: Bar[], day: string): number | null {
  const b = sessionBounds(day);
  if (!b) return null;
  const first = bars.find((x) => x.t >= b.openMs && x.t < b.openMs + FIRST_BAR_MS);
  return first && first.c > 0 ? first.c : null;
}

export function sharesFor(usd: number, price: number): number {
  if (!(usd > 0) || !(price > 0)) return 0;
  return Math.floor((usd / price) * 1e6) / 1e6;
}

// Midnight in New York on a date, as epoch ms (where "spent today" starts).
export function etMidnightMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const off = (etParts(Date.UTC(y, m - 1, d, 12)).hour - 12) * 3_600_000;
  return Date.UTC(y, m - 1, d) - off;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/lib/portfolio/weekly.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/portfolio/weekly.ts src/lib/portfolio/weekly.test.ts
printf 'Portfolio: the weekly buy schedule (holidays, catch-up, the 9:35 price, fractional shares)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > /tmp/pf-msg.txt
git commit -q -F /tmp/pf-msg.txt
```

---

### Task 3: The morning report's prompt and checks

**Files:**
- Create: `src/lib/portfolio/report.ts`
- Test: `src/lib/portfolio/report.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type ReportHolding`, `type ReportNews = { symbols: string[]; title: string; plain: string; impact: number; direction: string; source: string; link: string; published: string }`, `type ReportEvent = { day: string; time_et: string; kind: string; label: string; symbol: string }`, `type ReportMarket = { label: string; level: number; change: number; unit: "pct" | "pts" }`, `type ReportInput = { day: string; holdings: ReportHolding[]; news: ReportNews[]; macro: ReportNews[]; events: ReportEvent[]; market: ReportMarket[] }`, `type ReportOut = { summary: string; watch: string[]; per_holding: { symbol: string; line: string }[] }`, `type ReportRow = { status: "running" | "done" | "failed"; tries: number; updated_at: string }`, constants `REPORT_MODEL`, `REPORT_FALLBACK`, `REPORT_ESTIMATE_USD`, `MAX_TRIES`, `REPORT_SYSTEM`, `REPORT_SCHEMA`, and functions `reportPrompt(x: ReportInput): string`, `parseReport(raw: unknown, symbols: string[]): ReportOut | null`, `reportDue(nowMs: number, row: ReportRow | null, staleMs?: number): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/portfolio/report.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORT_SYSTEM, parseReport, reportDue, reportPrompt, type ReportInput } from "./report";

const input: ReportInput = {
  day: "2026-10-16",
  holdings: [{ symbol: "SPCX", name: "Space Exploration Technologies Corp.", price: 146.7, ret1d: 0.012, ret5d: -0.034, shares: 7.73, value: 1134, gainPct: 0.031 }],
  news: [],
  macro: [],
  events: [{ day: "2026-10-28", time_et: "14:00", kind: "fomc", label: "FOMC decision", symbol: "" }],
  market: [{ label: "S&P 500", level: 6850.12, change: 0.004, unit: "pct" }, { label: "10-year Treasury yield", level: 4.21, change: -0.03, unit: "pts" }],
};

test("the prompt carries the numbers, says none for empty sections, and gives the yield in points", () => {
  const p = reportPrompt(input);
  assert.ok(p.includes("SPCX (Space Exploration Technologies Corp.): $146.70, +1.2% yesterday, -3.4% over 5 days; he holds 7.73 shares worth $1134, +3.1% against what he paid."));
  assert.ok(p.includes("S&P 500: 6850.12, +0.4% yesterday."));
  assert.ok(p.includes("10-year Treasury yield: 4.21%, -0.03 points yesterday."));
  assert.ok(p.includes("NEWS ON HIS HOLDINGS (last 24 hours, most important first)\nnone"));
  assert.ok(p.includes("2026-10-28 14:00 ET: FOMC decision"));
});

test("the system prompt has no blank lines (the lib copy would drop them)", () => {
  assert.ok(!/\n\s*\n/.test(REPORT_SYSTEM));
});

test("a good answer is kept; unknown and repeated holdings are dropped; watch stops at three", () => {
  const raw = JSON.stringify({
    summary: "SPCX rose 1.2% yesterday after a launch contract; the wider market was flat.",
    watch: ["a", "b", "c", "d"],
    per_holding: [{ symbol: "spcx", line: "Up on the contract." }, { symbol: "TSLA", line: "Not held." }, { symbol: "SPCX", line: "Duplicate." }],
  });
  const out = parseReport(raw, ["SPCX"])!;
  assert.equal(out.summary.startsWith("SPCX rose"), true);
  assert.deepEqual(out.watch, ["a", "b", "c"]);
  assert.deepEqual(out.per_holding, [{ symbol: "SPCX", line: "Up on the contract." }]);
});

test("an answer in the wrong shape is refused", () => {
  assert.equal(parseReport("not json", ["SPCX"]), null);
  assert.equal(parseReport(JSON.stringify({ summary: "short" }), ["SPCX"]), null);
  assert.equal(parseReport(42, ["SPCX"]), null);
  assert.equal(parseReport(null, ["SPCX"]), null);
});

test("a report is due when missing or failed, waits while running, and stops after three tries", () => {
  const now = Date.parse("2026-10-16T12:40:00Z");
  assert.equal(reportDue(now, null), true);
  assert.equal(reportDue(now, { status: "done", tries: 1, updated_at: "2026-10-16T12:31:00Z" }), false);
  assert.equal(reportDue(now, { status: "failed", tries: 1, updated_at: "2026-10-16T12:31:00Z" }), true);
  assert.equal(reportDue(now, { status: "failed", tries: 3, updated_at: "2026-10-16T12:31:00Z" }), false);
  assert.equal(reportDue(now, { status: "running", tries: 1, updated_at: "2026-10-16T12:38:00Z" }), false);
  assert.equal(reportDue(now, { status: "running", tries: 1, updated_at: "2026-10-16T12:34:00Z" }), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/lib/portfolio/report.test.ts`
Expected: FAIL with `Cannot find module './report'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/portfolio/report.ts`:

```ts
// Portfolio — the morning report. Pure: the prompt, the answer's shape, the
// check on what the model sent back, and when a report is due.
// The numbers on screen come from the data, never from the model; the model
// only writes the plain-words summary, what to watch, and a line per holding.
// No blank lines inside template strings: the edge function's lib copy drops them.

export type ReportHolding = { symbol: string; name: string; price: number; ret1d: number; ret5d: number; shares: number; value: number; gainPct: number | null };
export type ReportNews = { symbols: string[]; title: string; plain: string; impact: number; direction: string; source: string; link: string; published: string };
export type ReportEvent = { day: string; time_et: string; kind: string; label: string; symbol: string };
export type ReportMarket = { label: string; level: number; change: number; unit: "pct" | "pts" };
export type ReportInput = { day: string; holdings: ReportHolding[]; news: ReportNews[]; macro: ReportNews[]; events: ReportEvent[]; market: ReportMarket[] };
export type ReportOut = { summary: string; watch: string[]; per_holding: { symbol: string; line: string }[] };
export type ReportRow = { status: "running" | "done" | "failed"; tries: number; updated_at: string };

export const REPORT_MODEL = "google/gemini-3.8-flash";
export const REPORT_FALLBACK = "google/gemini-3.5-flash-lite";
export const REPORT_ESTIMATE_USD = 0.03; // held back from the day's budget before a report call
export const MAX_TRIES = 3;

export const REPORT_SYSTEM = `You write Ben's morning report on his own stock portfolio. Ben is 19 and new to investing; he holds for years and buys every week, so he wants to understand what is happening, not to trade on it. Use ONLY the data given: never invent a price, a headline, a date or a number. Do not tell him to buy or sell anything. Write in plain words; any piece of market lingo gets a parenthesis with its meaning, for example "guidance (the company's own forecast)". No emojis.
Return JSON with:
- summary: at most 150 words. Start with how his holdings did and why, using the news given; then one or two sentences on the market backdrop.
- watch: one to three short items for today or the coming days, each tied to a dated event or a news item from the data.
- per_holding: one line per holding (at most 30 words) on what moved it or what is coming for it; if nothing in the data explains a move, say the move had no news behind it.`;

export const REPORT_SCHEMA = {
  name: "report", strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["summary", "watch", "per_holding"],
    properties: {
      summary: { type: "string" },
      watch: { type: "array", items: { type: "string" } },
      per_holding: { type: "array", items: { type: "object", additionalProperties: false, required: ["symbol", "line"], properties: { symbol: { type: "string" }, line: { type: "string" } } } },
    },
  },
};

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

export function reportPrompt(x: ReportInput): string {
  const lines: string[] = [`Date: ${x.day} (New York).`, "", "HOLDINGS"];
  for (const h of x.holdings) lines.push(`${h.symbol} (${h.name}): $${h.price.toFixed(2)}, ${pct(h.ret1d)} yesterday, ${pct(h.ret5d)} over 5 days; he holds ${h.shares} shares worth $${h.value.toFixed(0)}${h.gainPct === null ? "" : `, ${pct(h.gainPct)} against what he paid`}.`);
  lines.push("", "MARKET");
  for (const m of x.market) lines.push(`${m.label}: ${m.unit === "pts" ? `${m.level.toFixed(2)}%, ${m.change >= 0 ? "+" : ""}${m.change.toFixed(2)} points` : `${m.level.toFixed(2)}, ${pct(m.change)}`} yesterday.`);
  lines.push("", "NEWS ON HIS HOLDINGS (last 24 hours, most important first)");
  if (!x.news.length) lines.push("none");
  for (const n of x.news) lines.push(`[${n.symbols.join(", ")}] ${n.title} (${n.source}, impact ${n.impact} of 5, ${n.direction}). ${n.plain}`);
  lines.push("", "BIG ECONOMY AND MARKET NEWS (last 24 hours)");
  if (!x.macro.length) lines.push("none");
  for (const n of x.macro) lines.push(`${n.title} (${n.source}, impact ${n.impact} of 5). ${n.plain}`);
  lines.push("", "EVENTS IN THE NEXT TWO WEEKS");
  if (!x.events.length) lines.push("none");
  for (const e of x.events) lines.push(`${e.day}${e.time_et ? ` ${e.time_et} ET` : ""}: ${e.label}`);
  return lines.join("\n");
}

const clip = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function parseReport(raw: unknown, symbols: string[]): ReportOut | null {
  let j: unknown = raw;
  if (typeof raw === "string") { try { j = JSON.parse(raw); } catch { return null; } }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const summary = clip(o.summary, 1500);
  if (summary.length < 20) return null;
  const watch = (Array.isArray(o.watch) ? o.watch : []).map((w) => clip(w, 240)).filter(Boolean).slice(0, 3);
  const want = new Set(symbols.map((s) => s.toUpperCase()));
  const seen = new Set<string>();
  const per_holding: ReportOut["per_holding"] = [];
  for (const p of Array.isArray(o.per_holding) ? o.per_holding : []) {
    const r = (p ?? {}) as Record<string, unknown>;
    const symbol = clip(r.symbol, 14).toUpperCase();
    const line = clip(r.line, 300);
    if (!want.has(symbol) || seen.has(symbol) || !line) continue;
    seen.add(symbol);
    per_holding.push({ symbol, line });
  }
  return { summary, watch, per_holding };
}

export function reportDue(nowMs: number, row: ReportRow | null, staleMs = 5 * 60_000): boolean {
  if (!row) return true;
  if (row.tries >= MAX_TRIES) return false;
  if (row.status === "failed") return true;
  if (row.status === "running") return nowMs - Date.parse(row.updated_at) > staleMs;
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/lib/portfolio/report.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/portfolio/report.ts src/lib/portfolio/report.test.ts
printf 'Portfolio: the morning report prompt, answer check and retry rule\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > /tmp/pf-msg.txt
git commit -q -F /tmp/pf-msg.txt
```

---

### Task 4: The tick plan and the lib copies for `pilot`

**Files:**
- Create: `src/lib/portfolio/tick.ts`
- Test: `src/lib/portfolio/tick.test.ts`
- Modify: `scripts/desk-sync-libs.mjs` (the whole file, shown below)

**Interfaces:**
- Consumes: `etParts`, `isTradingDay` from `src/lib/desk/clock.ts`.
- Produces: `type TickPlan = { feed: boolean; lots: boolean; report: boolean }`, `tickPlan(nowMs: number, o: { paused: boolean; budgetLeft: boolean; reportDue: boolean }): TickPlan`. It also produces the copied files `supabase/functions/pilot/lib/{types,clock,lots,weekly,report,tick}.ts`, which Task 6 imports as `./lib/<name>.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/portfolio/tick.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tickPlan } from "./tick";

const at = (iso: string) => Date.parse(iso);
const go = { paused: false, budgetLeft: true, reportDue: true };

test("08:32 on a trading day: the feed's quarter and the report; lots wait for 09:36", () => {
  assert.deepEqual(tickPlan(at("2026-10-15T12:32:00Z"), go), { feed: true, lots: false, report: true });
});

test("before 08:30 no report; off the quarter no feed", () => {
  assert.deepEqual(tickPlan(at("2026-10-15T12:29:00Z"), go), { feed: false, lots: false, report: false });
});

test("Saturday: the feed only", () => {
  assert.deepEqual(tickPlan(at("2026-10-17T12:32:00Z"), go), { feed: true, lots: false, report: false });
});

test("paused: weekly lots still recorded, no AI", () => {
  assert.deepEqual(tickPlan(at("2026-10-15T13:47:00Z"), { ...go, paused: true }), { feed: false, lots: true, report: false });
});

test("budget used up: no feed, no report", () => {
  assert.deepEqual(tickPlan(at("2026-10-15T12:32:00Z"), { ...go, budgetLeft: false }), { feed: false, lots: false, report: false });
});

test("the feed sleeps before 07:00; a morning report is not written after the close", () => {
  assert.equal(tickPlan(at("2026-10-15T10:47:00Z"), go).feed, false);
  assert.deepEqual(tickPlan(at("2026-10-15T20:02:00Z"), go), { feed: true, lots: true, report: false });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/lib/portfolio/tick.test.ts`
Expected: FAIL with `Cannot find module './tick'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/portfolio/tick.ts`:

```ts
// Portfolio — what the five-minute tick starts. Pure.
// The cron fires at two minutes past each five-minute mark; the feed runs on
// the quarter (minutes 2–4 past :00, :15, :30, :45). Weekly lots cost nothing,
// so pausing the AI does not stop them.

import { etParts, isTradingDay } from "../desk/clock";

export type TickPlan = { feed: boolean; lots: boolean; report: boolean };

export const FEED_FROM = 7 * 60;      // overnight news is picked up by the 07:02 run
export const FEED_UNTIL = 22 * 60;
export const REPORT_AT = 8 * 60 + 30; // 08:30 New York
export const REPORT_UNTIL = 16 * 60;  // a morning report is not written after the close
export const LOTS_FROM = 9 * 60 + 36; // the 09:30 bar is final
export const LOTS_UNTIL = 20 * 60;

export function tickPlan(nowMs: number, o: { paused: boolean; budgetLeft: boolean; reportDue: boolean }): TickPlan {
  const p = etParts(nowMs);
  const min = p.hour * 60 + p.minute;
  const trading = isTradingDay(p.date);
  const quarter = p.minute % 15 >= 2 && p.minute % 15 <= 4;
  const ai = !o.paused && o.budgetLeft;
  return {
    feed: ai && quarter && min >= FEED_FROM && min < FEED_UNTIL,
    lots: trading && min >= LOTS_FROM && min < LOTS_UNTIL,
    report: ai && trading && o.reportDue && min >= REPORT_AT && min < REPORT_UNTIL,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/lib/portfolio/tick.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Teach the copy script about portfolio modules**

Replace the whole of `scripts/desk-sync-libs.mjs` with:

```js
// Copies the pure desk modules (src/lib/desk) and portfolio modules
// (src/lib/portfolio, written "pf:<name>") into each edge function's lib/ dir,
// rewriting relative imports to Deno's explicit ".ts" form, and fails when a
// copy drifts. Run after every change to src/lib/desk/* or src/lib/portfolio/*;
// the build check runs it with --check.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
const MODS = ["types", "clock", "ta", "risk", "rules", "ledger", "stats", "vote", "playbook", "scan", "league"];
const PF_MODS = ["lots", "weekly", "report", "tick"];
const TARGETS = {
  tape: ["types", "clock", "ta"],
  desk: ["types", "clock", "risk", "rules", "vote", "playbook", "stats", "ledger", "ta", "scan"],
  "desk-scan": ["types", "clock", "risk", "rules", "ledger", "ta", "scan"],
  "desk-sync": ["types", "clock", "ledger", "risk"],
  "desk-review": ["types", "stats", "playbook", "league"],
  "desk-league": ["types", "clock", "risk", "rules", "ledger", "stats", "scan", "ta", "league"],
  pilot: ["types", "clock", "pf:lots", "pf:weekly", "pf:report", "pf:tick"],
};
const check = process.argv.includes("--check");
let drift = 0;
for (const [fn, mods] of Object.entries(TARGETS)) {
  const dir = `supabase/functions/${fn}/lib`;
  if (!check) mkdirSync(dir, { recursive: true });
  for (const m of mods) {
    const pf = m.startsWith("pf:");
    const name = pf ? m.slice(3) : m;
    if (!(pf ? PF_MODS : MODS).includes(name)) throw new Error(`unknown module ${m}`);
    // Deno wants explicit ".ts" specifiers, and every copy sits flat in lib/, so
    // "../desk/clock" and "./clock" both become "./clock.ts". Comment-only and blank
    // lines are dropped so the deploy payload stays under the MCP limit. Logic is untouched.
    const src = readFileSync(`src/lib/${pf ? "portfolio" : "desk"}/${name}.ts`, "utf8")
      .replace(/from "\.\.\/desk\/([a-z-]+)"/g, 'from "./$1.ts"')
      .replace(/from "\.\/([a-z-]+)"/g, 'from "./$1.ts"')
      .split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("//")).join("\n") + "\n";
    const out = `${dir}/${name}.ts`;
    if (check) { if (!existsSync(out) || readFileSync(out, "utf8") !== src) { console.error(`drift: ${out}`); drift++; } }
    else writeFileSync(out, src);
  }
}
if (check && drift) process.exit(1);
console.log(check ? "desk lib copies in sync" : "desk lib copies written");
```

- [ ] **Step 6: Write the copies and check them**

Run: `node scripts/desk-sync-libs.mjs && node scripts/desk-sync-libs.mjs --check && ls supabase/functions/pilot/lib && grep -n 'from "' supabase/functions/pilot/lib/weekly.ts supabase/functions/pilot/lib/tick.ts && git status --short supabase/functions`
Expected: `desk lib copies written`, then `desk lib copies in sync`. The listing shows `clock.ts lots.ts report.ts tick.ts types.ts weekly.ts`. The imports read `from "./clock.ts"` and `from "./types.ts"`. `git status` shows only the new `supabase/functions/pilot/` directory (the Desk functions' copies are unchanged).

- [ ] **Step 7: Run every portfolio and desk test**

Run: `npx tsx --test src/lib/portfolio/*.test.ts src/lib/desk/*.test.ts`
Expected: all pass (26 portfolio tests plus the 59 desk tests).

- [ ] **Step 8: Commit**

```bash
git add src/lib/portfolio/tick.ts src/lib/portfolio/tick.test.ts scripts/desk-sync-libs.mjs supabase/functions/pilot/lib
printf 'Portfolio: the tick plan, and lib copies for the pilot function\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > /tmp/pf-msg.txt
git commit -q -F /tmp/pf-msg.txt
```

---

### Task 5: The database

**Files:**
- Create: `supabase/desk/008_portfolio.sql`

**Interfaces:**
- Consumes: `auth.users`.
- Produces:
  - Tables `pf_lots`, `pf_settings`, `pf_reports` and `pf_spend` (columns below; `pf_reports` is unique on `(user_id, day)`; `pf_lots` has a partial unique index on `(user_id, symbol, day)` where `kind = 'weekly'`).
  - RPC `pf_spend_since(p_user uuid, p_since timestamptz) returns numeric`, for the service role only.
  - RPC `pf_my_spend_since(p_since timestamptz) returns numeric`, for signed-in users.

- [ ] **Step 1: Write the SQL record**

Create `supabase/desk/008_portfolio.sql`:

```sql
-- Portfolio copilot, build step 1 (2026-10-16): Ben's real holdings as lots, the copilot's settings,
-- the morning reports, and every model call's cost for the $1 daily cap.
-- Applied through the Supabase MCP as migration portfolio_step1; kept here as the record.

create table if not exists public.pf_lots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol text not null check (symbol ~ '^[A-Z0-9.^-]{1,14}$'),
  shares numeric not null check (shares <> 0),
  price numeric not null check (price > 0),
  day date not null,
  kind text not null check (kind in ('start','weekly','manual')),
  assumed boolean not null default false,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists pf_lots_user_day on public.pf_lots(user_id, day);
-- one recorded weekly buy per stock per day, however often the tick runs
create unique index if not exists pf_lots_weekly_once on public.pf_lots(user_id, symbol, day) where kind = 'weekly';

create table if not exists public.pf_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  recurring jsonb not null default '[]'::jsonb,          -- [{ "symbol": "SPCX", "usd": 400 }]
  buy_dow int not null default 3 check (buy_dow between 1 and 5),
  recurring_since date,                                  -- weekly lots are recorded for buy days on or after this date
  cap_usd_day numeric not null default 1 check (cap_usd_day >= 0 and cap_usd_day <= 5),
  report_model text not null default 'google/gemini-3.8-flash',
  paused boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.pf_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  status text not null default 'running' check (status in ('running','done','failed')),
  tries int not null default 0,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  model text not null default '',
  cost_usd numeric not null default 0,
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, day)
);

create table if not exists public.pf_spend (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,                                    -- feed | report (later steps add judge, idea, hunt)
  model text not null default '',
  cost_usd numeric not null default 0
);
create index if not exists pf_spend_user_at on public.pf_spend(user_id, at);

alter table public.pf_lots enable row level security;
alter table public.pf_settings enable row level security;
alter table public.pf_reports enable row level security;
alter table public.pf_spend enable row level security;
create policy pf_lots_own on public.pf_lots for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy pf_settings_own on public.pf_settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy pf_reports_read on public.pf_reports for select using (auth.uid() = user_id);   -- the pilot function writes
create policy pf_spend_read on public.pf_spend for select using (auth.uid() = user_id);       -- the pilot function writes

-- The budget gate's sum, on the server (a plain select is capped at 1000 rows).
create or replace function public.pf_spend_since(p_user uuid, p_since timestamptz)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_usd), 0)::numeric from public.pf_spend where user_id = p_user and at >= p_since;
$$;
revoke all on function public.pf_spend_since(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.pf_spend_since(uuid, timestamptz) to service_role;

-- The same sum for the signed-in user, for the app's "AI cost today" line.
create or replace function public.pf_my_spend_since(p_since timestamptz)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_usd), 0)::numeric from public.pf_spend where user_id = auth.uid() and at >= p_since;
$$;
revoke all on function public.pf_my_spend_since(timestamptz) from public, anon;
grant execute on function public.pf_my_spend_since(timestamptz) to authenticated;
```

- [ ] **Step 2: Apply it**

Call the Supabase MCP tool `apply_migration` with `project_id: "pciljeqsrricybdnhvsu"`, `name: "portfolio_step1"`, and `query` set to the file's full contents.
Expected: success.

- [ ] **Step 3: Verify the tables, RLS and grants**

Call MCP `execute_sql` with:

```sql
select c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('pf_lots','pf_settings','pf_reports','pf_spend') order by 1;
select has_function_privilege('anon', 'public.pf_spend_since(uuid,timestamptz)', 'execute') as anon_can,
       has_function_privilege('authenticated', 'public.pf_spend_since(uuid,timestamptz)', 'execute') as auth_can,
       has_function_privilege('authenticated', 'public.pf_my_spend_since(timestamptz)', 'execute') as auth_my;
select public.pf_spend_since('f0e1e204-aa54-4a45-bbb5-99c83114fecb', now() - interval '1 day') as spent;
```

Expected: four rows, each with `relrowsecurity = true`; `anon_can = false`, `auth_can = false`, `auth_my = true`; `spent = 0`.

- [ ] **Step 4: Check the security advisors**

Call MCP `get_advisors` with `type: "security"`.
Expected: no new findings that name a `pf_` table or function. If one appears, fix it in the SQL file, apply the fix as a new migration (`portfolio_step1_fix`), and re-run Step 3.

- [ ] **Step 5: Commit**

```bash
git add supabase/desk/008_portfolio.sql
printf 'Portfolio: tables for lots, settings, reports and spend (applied as portfolio_step1)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > /tmp/pf-msg.txt
git commit -q -F /tmp/pf-msg.txt
```

---

### Task 6: The `pilot` edge function

**Files:**
- Create: `supabase/functions/pilot/index.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4 through `./lib/*.ts`; Task 5's tables and `pf_spend_since`. It calls these existing functions with the service role:
  - `tape` `{ mode: "bars", symbol, interval: "5m", range: "1mo" }` returns `{ bars: Bar[] }`.
  - `tape` `{ mode: "snapshot", symbols: [{ symbol }] }` returns `{ cards: Record<string, TapeCard | { error }> }`. A TapeCard has `price`, `prevClose`, `ret1d`, `ret5d` and `name`.
  - `tape` `{ mode: "calendar", days: 14, symbols: string[] }` returns `{ events: ReportEvent[] }`.
  - `desk-feed` `{ mode: "ingest" }` returns `{ cost, model, tagged, ... }`.
  - The `get_secret` RPC: `anthropic_api_key` (the OpenRouter key) and `desk_cron_secret`.
- Produces the HTTP endpoint `POST /functions/v1/pilot` with these modes:
  - `{ mode: "tick" | "feed" | "lots" | "report", userId, cronSecret }` from the cron or the service role.
  - `{ mode: "report" }` with a user JWT, from the app. It returns `{ ok: true, ... }` or `{ error: string }`.

- [ ] **Step 1: Write the function**

Create `supabase/functions/pilot/index.ts`:

```ts
// pilot — the portfolio copilot's server side. Build step 1: the weekly lot
// and the morning report. Modes:
//   tick    the five-minute cron: starts the feed, records due weekly lots, starts the report
//   feed    runs desk-feed's ingest and books its model cost to pf_spend
//   lots    records Robinhood's weekly buy as an assumed lot (idempotent)
//   report  writes today's morning report (also the app's "Write it now")
// It never places, changes or cancels an order and holds no broker credentials.
//
// verify_jwt=false; callers checked here: the cron's vault secret, the service
// role (the tick launching its own children), or a signed-in user's JWT, which
// may only ask for the report.

import { addDays, etParts } from "./lib/clock.ts";
import type { Bar } from "./lib/types.ts";
import { holdingsOf, type Lot, type LotKind, type Quote } from "./lib/lots.ts";
import { dueWeeklyLots, etMidnightMs, firstFiveMinutePrice, sharesFor, type Recurring } from "./lib/weekly.ts";
import { MAX_TRIES, REPORT_ESTIMATE_USD, REPORT_FALLBACK, REPORT_MODEL, REPORT_SCHEMA, REPORT_SYSTEM, parseReport, reportDue, reportPrompt, type ReportEvent, type ReportInput, type ReportMarket, type ReportNews, type ReportRow } from "./lib/report.ts";
import { tickPlan } from "./lib/tick.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OR = "https://openrouter.ai/api/v1/chat/completions";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const svcH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
type J = Record<string, unknown>;
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const SYM = /^[\^A-Z0-9.\-]{1,14}$/;

// The market backdrop in the report: the two big indexes, bitcoin, and the 10-year yield (in percentage points).
const MARKET: { symbol: string; label: string; unit: "pct" | "pts" }[] = [
  { symbol: "^GSPC", label: "S&P 500", unit: "pct" },
  { symbol: "^IXIC", label: "Nasdaq", unit: "pct" },
  { symbol: "BTC-USD", label: "Bitcoin", unit: "pct" },
  { symbol: "^TNX", label: "10-year Treasury yield", unit: "pts" },
];

async function rest(path: string, init?: RequestInit): Promise<{ ok: boolean; json: unknown; status: number }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...svcH, ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) console.error(`[pilot] rest ${r.status} ${path.slice(0, 80)} ${text.slice(0, 200)}`);
  return { ok: r.ok, json, status: r.status };
}
async function secret(name: string): Promise<string> {
  const r = await rest("rpc/get_secret", { method: "POST", body: JSON.stringify({ secret_name: name }) });
  return r.ok && typeof r.json === "string" ? r.json : "";
}
async function call(fn: string, body: J, ms: number): Promise<J> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: "POST", headers: svcH, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    try { return JSON.parse(text) as J; } catch { return { error: `${fn}: HTTP ${r.status} ${text.slice(0, 120)}` }; }
  } catch (e) { return { error: `${fn}: ${e instanceof Error ? e.message : String(e)}` }; }
  finally { clearTimeout(t); }
}
// Fire and keep the isolate alive until the child answers, without waiting for it.
function launch(fn: string, body: J): void {
  const p = fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: "POST", headers: svcH, body: JSON.stringify(body) }).then((r) => r.text()).catch((e) => console.error("[pilot] launch", fn, e instanceof Error ? e.message : e));
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p);
}

/* ── settings and spend ─────────────────────────────────────────────────── */
type Settings = { recurring: Recurring[]; buyDow: number; since: string | null; cap: number; model: string; paused: boolean };
async function settingsOf(uid: string): Promise<Settings> {
  const r = await rest(`pf_settings?user_id=eq.${uid}&select=*`);
  const row = ((r.ok && Array.isArray(r.json) ? (r.json as J[])[0] : null) ?? {}) as J;
  return {
    recurring: (Array.isArray(row.recurring) ? (row.recurring as J[]) : []).map((x) => ({ symbol: String(x.symbol ?? "").toUpperCase(), usd: num(x.usd) })).filter((x) => SYM.test(x.symbol) && x.usd > 0),
    buyDow: num(row.buy_dow, 3),
    since: row.recurring_since ? String(row.recurring_since) : null,
    cap: num(row.cap_usd_day, 1),
    model: String(row.report_model ?? "") || REPORT_MODEL,
    paused: row.paused === true,
  };
}
// null when the sum can't be read: callers treat that as no budget left.
async function spentToday(uid: string, nowMs: number): Promise<number | null> {
  const r = await rest("rpc/pf_spend_since", { method: "POST", body: JSON.stringify({ p_user: uid, p_since: new Date(etMidnightMs(etParts(nowMs).date)).toISOString() }) });
  const v = Number(r.json);
  return r.ok && Number.isFinite(v) ? v : null;
}
async function book(uid: string, kind: string, model: string, cost: number): Promise<void> {
  if (cost > 0) await rest("pf_spend", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: uid, kind, model, cost_usd: cost }) });
}
// undefined when the read failed, null when there is no report yet today.
async function reportRow(uid: string, day: string): Promise<ReportRow | null | undefined> {
  const r = await rest(`pf_reports?user_id=eq.${uid}&day=eq.${day}&select=status,tries,updated_at`);
  if (!r.ok || !Array.isArray(r.json)) return undefined;
  const row = (r.json as J[])[0];
  return row ? { status: row.status as ReportRow["status"], tries: num(row.tries), updated_at: String(row.updated_at) } : null;
}
function toLot(r: J): Lot {
  return { id: String(r.id), symbol: String(r.symbol), shares: num(r.shares), price: num(r.price), day: String(r.day), kind: (r.kind as LotKind) ?? "manual", assumed: r.assumed === true, note: String(r.note ?? ""), created_at: String(r.created_at ?? "") };
}

/* ── tick ───────────────────────────────────────────────────────────────── */
async function tick(uid: string, body: J): Promise<J> {
  const now = Date.now();
  const day = etParts(now).date;
  const s = await settingsOf(uid);
  const spent = await spentToday(uid, now);
  const row = await reportRow(uid, day);
  const budgetLeft = spent !== null && spent + REPORT_ESTIMATE_USD <= s.cap;
  const plan = tickPlan(now, { paused: s.paused, budgetLeft, reportDue: row !== undefined && reportDue(now, row) });
  const out: J = { at: new Date(now).toISOString(), plan, spent };
  if (plan.feed || (body.feed === true && budgetLeft)) { launch("pilot", { mode: "feed", userId: uid }); out.feed = "launched"; }
  if (plan.lots || body.lots === true) out.lots = await recordLots(uid, s, now);
  if (plan.report) { launch("pilot", { mode: "report", userId: uid }); out.report = "launched"; }
  return out;
}

/* ── feed ───────────────────────────────────────────────────────────────── */
async function feed(uid: string): Promise<J> {
  const r = await call("desk-feed", { mode: "ingest", userId: uid }, 130_000);
  await book(uid, "feed", String(r.model ?? ""), num(r.cost));
  return r;
}

/* ── weekly lots ────────────────────────────────────────────────────────── */
async function recordLots(uid: string, s: Settings, now: number): Promise<J> {
  if (!s.recurring.length || !s.since) return { due: 0 };
  const today = etParts(now).date;
  const ex = await rest(`pf_lots?user_id=eq.${uid}&kind=eq.weekly&day=gte.${addDays(today, -15)}&select=symbol,day`);
  if (!ex.ok || !Array.isArray(ex.json)) return { error: "Couldn't read the recorded weekly buys." };
  const due = dueWeeklyLots(now, { recurring: s.recurring, buyDow: s.buyDow, since: s.since }, (ex.json as J[]).map((x) => ({ symbol: String(x.symbol), day: String(x.day) })));
  if (!due.length) return { due: 0 };
  const bars = new Map<string, Bar[]>();
  const written: J[] = [];
  const waiting: string[] = [];
  for (const d of due) {
    if (!bars.has(d.symbol)) {
      const r = await call("tape", { mode: "bars", symbol: d.symbol, interval: "5m", range: "1mo", userId: uid }, 30_000);
      bars.set(d.symbol, Array.isArray(r.bars) ? (r.bars as Bar[]) : []);
    }
    const price = firstFiveMinutePrice(bars.get(d.symbol) ?? [], d.day);
    const shares = price ? sharesFor(d.usd, price) : 0;
    if (!price || shares <= 0) { waiting.push(`${d.symbol} ${d.day}`); continue; } // retried by the next tick
    const ins = await rest("pf_lots", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, symbol: d.symbol, shares, price, day: d.day, kind: "weekly", assumed: true, note: `Robinhood weekly buy of $${d.usd}, assumed at the 9:35 price.` }),
    });
    if (ins.ok || ins.status === 409) written.push({ symbol: d.symbol, day: d.day, price, shares });
  }
  return { due: due.length, written, waiting };
}

/* ── the morning report ─────────────────────────────────────────────────── */
async function ask(key: string, model: string, prompt: string): Promise<{ out: string; cost: number; error: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 50_000);
  try {
    const r = await fetch(OR, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://bookcrewcode.github.io/daily/", "X-Title": "Daily Portfolio" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: REPORT_SYSTEM }, { role: "user", content: prompt }], max_tokens: 4000, reasoning: { effort: "low", exclude: true }, response_format: { type: "json_schema", json_schema: REPORT_SCHEMA }, provider: { require_parameters: true } }),
    });
    const d = (await r.json().catch(() => null)) as J | null;
    const content = String((((d?.choices as J[]) ?? [])[0]?.message as J)?.content ?? "");
    return { out: r.ok ? content : "", cost: num((d?.usage as J)?.cost), error: r.ok ? (content ? "" : "empty answer") : `HTTP ${r.status}` };
  } catch (e) { return { out: "", cost: 0, error: e instanceof Error ? e.message : String(e) }; }
  finally { clearTimeout(t); }
}
async function fail(uid: string, day: string, error: string, extra: J = {}): Promise<J> {
  await rest(`pf_reports?user_id=eq.${uid}&day=eq.${day}`, { method: "PATCH", body: JSON.stringify({ status: "failed", error, updated_at: new Date().toISOString(), ...extra }) });
  return { error };
}
function toNews(r: J, held: string[]): ReportNews {
  const tickers = Array.isArray(r.tickers) ? (r.tickers as unknown[]).map(String) : [];
  return {
    symbols: held.filter((s) => tickers.includes(s) || (s.endsWith("-USD") && tickers.includes(s.slice(0, -4)))),
    title: String(r.title ?? "").slice(0, 220), plain: String(r.plain ?? "").slice(0, 400), impact: num(r.impact, 1),
    direction: String(r.direction ?? "none"), source: String(r.source ?? ""), link: String(r.link ?? ""), published: String(r.published ?? ""),
  };
}

async function writeReport(uid: string, fromApp: boolean): Promise<J> {
  const t0 = Date.now();
  const day = etParts(t0).date;
  const s = await settingsOf(uid);
  if (s.paused) return { error: "The copilot is paused in Settings." };
  const row = await reportRow(uid, day);
  if (row === undefined) return { error: "Couldn't read today's report." };
  if (row && row.tries >= MAX_TRIES) return { error: "Today's report has already been tried three times. It tries again tomorrow." };
  if (row?.status === "running" && t0 - Date.parse(row.updated_at) < 5 * 60_000) return { error: "The report is being written right now. Check back in a minute." };
  if (row?.status === "done" && !fromApp) return { skipped: "already written" };

  // claim today's row (one per day; the tries count stops runaway retries)
  const claim = await rest("pf_reports?on_conflict=user_id,day", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: uid, day, status: "running", tries: (row?.tries ?? 0) + 1, error: "", updated_at: new Date().toISOString() }),
  });
  if (!claim.ok) return { error: "Couldn't start the report." };

  const spent = await spentToday(uid, t0);
  if (spent === null || spent + REPORT_ESTIMATE_USD > s.cap) return await fail(uid, day, "Today's AI budget is used up, so no report was written. It resets at midnight New York time.");

  const lotsR = await rest(`pf_lots?user_id=eq.${uid}&select=id,symbol,shares,price,day,kind,assumed,note,created_at&order=day.asc&limit=2000`);
  if (!lotsR.ok || !Array.isArray(lotsR.json)) return await fail(uid, day, "Couldn't read your holdings.");
  const lots = (lotsR.json as J[]).map(toLot);
  const symbols = [...new Set(lots.map((l) => l.symbol.toUpperCase()))];
  if (!symbols.length) return await fail(uid, day, "There are no holdings yet. Add them on the Holdings page first.");

  const snap = await call("tape", { mode: "snapshot", symbols: [...symbols, ...MARKET.map((m) => m.symbol)].map((symbol) => ({ symbol })), userId: uid }, 40_000);
  const cards = ((snap.cards ?? {}) as Record<string, J>);
  const quotes: Record<string, Quote> = {};
  for (const [k, c] of Object.entries(cards)) {
    const price = Number(c?.price);
    if (Number.isFinite(price) && price > 0) quotes[k] = { price, prevClose: num(c.prevClose, NaN) || null, name: String(c.name ?? k) };
  }
  const held = holdingsOf(lots, quotes).holdings.filter((h) => h.price !== null && h.value !== null);
  if (!held.length) return await fail(uid, day, "No prices came back for your holdings, so the report waits for the next try.");
  const syms = held.map((h) => h.symbol);

  const since = new Date(t0 - 24 * 3_600_000).toISOString();
  const newsTickers = [...new Set(syms.flatMap((x) => (x.endsWith("-USD") ? [x, x.slice(0, -4)] : [x])))];
  const newsR = await rest(`desk_news?tagged=eq.true&impact=gte.2&published=gte.${since}&tickers=ov.{${newsTickers.map(encodeURIComponent).join(",")}}&select=title,plain,impact,direction,source,link,published,tickers&order=impact.desc,published.desc&limit=40`);
  const macroR = await rest(`desk_news?tagged=eq.true&impact=gte.4&venue=eq.macro&published=gte.${since}&select=title,plain,impact,direction,source,link,published,tickers&order=impact.desc,published.desc&limit=5`);
  if (!newsR.ok || !macroR.ok) return await fail(uid, day, "Couldn't read the news.");
  const count = new Map<string, number>();
  const news: ReportNews[] = [];
  for (const r of newsR.json as J[]) {
    const n = toNews(r, syms);
    if (!n.symbols.length || n.symbols.every((x) => (count.get(x) ?? 0) >= 4)) continue;
    n.symbols.forEach((x) => count.set(x, (count.get(x) ?? 0) + 1));
    news.push(n);
    if (news.length >= 12) break;
  }
  const macro = (macroR.json as J[]).map((r) => toNews(r, []));

  const cal = await call("tape", { mode: "calendar", days: 14, symbols: syms, userId: uid }, 20_000);
  if (!Array.isArray(cal.events)) return await fail(uid, day, "Couldn't read the events calendar.");
  const events: ReportEvent[] = (cal.events as J[]).map((e) => ({ day: String(e.day), time_et: String(e.time_et ?? ""), kind: String(e.kind ?? ""), label: String(e.label ?? ""), symbol: String(e.symbol ?? "") }))
    .filter((e) => !e.symbol || syms.includes(e.symbol)).slice(0, 12);

  const market: ReportMarket[] = MARKET.flatMap((m) => {
    const c = cards[m.symbol];
    const level = Number(c?.price);
    if (!c || !Number.isFinite(level)) return [];
    const change = m.unit === "pts" ? level - num(c.prevClose, level) : num(c.ret1d);
    return [{ label: m.label, level, change, unit: m.unit }];
  });

  const input: ReportInput = {
    day,
    holdings: held.map((h) => ({ symbol: h.symbol, name: h.name, price: h.price as number, ret1d: num(cards[h.symbol]?.ret1d), ret5d: num(cards[h.symbol]?.ret5d), shares: Math.round(h.shares * 1e6) / 1e6, value: h.value as number, gainPct: h.gainPct })),
    news, macro, events, market,
  };

  const key = await secret("anthropic_api_key");
  if (!key) return await fail(uid, day, "The AI key is missing.", { input });
  const prompt = reportPrompt(input);
  let model = s.model;
  let res = await ask(key, model, prompt);
  let cost = res.cost;
  let out = res.out ? parseReport(res.out, syms) : null;
  if (!out && Date.now() - t0 < 80_000) {
    model = REPORT_FALLBACK;
    res = await ask(key, model, prompt);
    cost += res.cost;
    out = res.out ? parseReport(res.out, syms) : null;
  }
  await book(uid, "report", model, cost);
  if (!out) return await fail(uid, day, `The AI's answer couldn't be read (${res.error || "wrong shape"}).`, { input, model, cost_usd: cost });
  await rest(`pf_reports?user_id=eq.${uid}&day=eq.${day}`, { method: "PATCH", body: JSON.stringify({ status: "done", input, output: out, model, cost_usd: cost, error: "", updated_at: new Date().toISOString() }) });
  return { ok: true, day, model, cost, holdings: held.length, news: news.length, events: events.length, ms: Date.now() - t0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const body = (await req.json().catch(() => ({}))) as J;
    let uid = "";
    let fromApp = false;
    const cronSecret = String(body.cronSecret ?? "");
    if (cronSecret) { const want = await secret("desk_cron_secret"); if (want.length > 20 && want === cronSecret) uid = String(body.userId ?? ""); }
    if (!uid && token && SERVICE_KEY && token === SERVICE_KEY) uid = String(body.userId ?? "");
    if (!uid && token) {
      try {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
        if (r.ok) { uid = String((await r.json())?.id ?? ""); fromApp = true; }
      } catch { /* 401 below */ }
    }
    if (!/^[0-9a-f-]{36}$/i.test(uid)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    const mode = String(body.mode ?? "");
    if (fromApp && mode !== "report") return ok({ error: "The app can only ask for the report." });
    if (mode === "tick") return ok(await tick(uid, body));
    if (mode === "feed") return ok(await feed(uid));
    if (mode === "lots") return ok(await recordLots(uid, await settingsOf(uid), Date.now()));
    if (mode === "report") return ok(await writeReport(uid, fromApp));
    return ok({ error: "Unknown mode." });
  } catch (e) {
    console.error("[pilot] fatal", e instanceof Error ? e.stack ?? e.message : e);
    return new Response(JSON.stringify({ error: "Something broke on the way. Try again." }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
```

- [ ] **Step 2: Type-check the function**

Run: `npx tsc --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --lib es2022,dom supabase/functions/pilot/index.ts 2>&1 | grep -v "Cannot find name 'Deno'" | grep -v "Parameter 'req' implicitly" | head -20`
Expected: no output. Two kinds of error are expected and filtered out: those that name `Deno`, and `req`'s implicit `any` (tsc doesn't know `Deno.serve`). The plan's code was checked this way on 2026-10-16. Any other error is a bug to fix before going on.

- [ ] **Step 3: Bundle and syntax-check**

Run: `node scripts/desk-bundle.mjs pilot && node --check supabase/functions/pilot/dist/index.ts && wc -c supabase/functions/pilot/dist/index.ts`
Expected: `pilot: N bytes bundled`, no syntax error, and a size under about 40,000 bytes.

- [ ] **Step 4: Deploy with the MCP**

If the bundle is over 20,000 bytes, split it so each piece can be read whole:

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("supabase/functions/pilot/dist/index.ts","utf8");const n=Math.ceil(s.length/20000);const k=Math.ceil(s.length/n);for(let i=0;i<n;i++)fs.writeFileSync(`supabase/functions/pilot/dist/frag${i}.txt`,s.slice(i*k,(i+1)*k));console.log(n,"fragments")'
```

Read every fragment with the Read tool. Then call MCP `deploy_edge_function` with these parameters:
- `project_id: "pciljeqsrricybdnhvsu"`
- `name: "pilot"`
- `entrypoint_path: "index.ts"`
- `verify_jwt: false`
- `files: [{ name: "index.ts", content: <the fragments concatenated in order, byte for byte> }]`

Expected: the deploy returns a version and status `ACTIVE`.

- [ ] **Step 5: Smoke test with no settings (nothing due)**

Call MCP `execute_sql` and keep the returned id:

```sql
select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/pilot',
  headers := '{"Content-Type":"application/json"}'::jsonb,
  body := jsonb_build_object('mode','tick','userId','f0e1e204-aa54-4a45-bbb5-99c83114fecb',
    'cronSecret',(select decrypted_secret from vault.decrypted_secrets where name='desk_cron_secret')),
  timeout_milliseconds := 120000) as id;
```

About ten seconds later, run `select status_code, left(content::text, 600) from net._http_response where id = <id>;`.
Expected: 200 with `{"at":...,"plan":{...},"spent":0,...}`. If `plan.feed` was true, `"feed":"launched"` also appears. It has no `error` field.

- [ ] **Step 6: Test the weekly lot on last Wednesday's real price, then clean up**

Call MCP `execute_sql`:

```sql
insert into public.pf_settings (user_id, recurring, buy_dow, recurring_since)
values ('f0e1e204-aa54-4a45-bbb5-99c83114fecb', '[{"symbol":"SPCX","usd":400}]', 3, '2026-10-14')
on conflict (user_id) do update set recurring = excluded.recurring, buy_dow = 3, recurring_since = '2026-10-14';
select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/pilot',
  headers := '{"Content-Type":"application/json"}'::jsonb,
  body := jsonb_build_object('mode','lots','userId','f0e1e204-aa54-4a45-bbb5-99c83114fecb',
    'cronSecret',(select decrypted_secret from vault.decrypted_secrets where name='desk_cron_secret')),
  timeout_milliseconds := 120000) as id;
```

About fifteen seconds later, run:

```sql
select status_code, left(content::text, 600) from net._http_response where id = <id>;
select symbol, shares, price, day, kind, assumed, note from public.pf_lots where user_id = 'f0e1e204-aa54-4a45-bbb5-99c83114fecb';
```

Expected: the response shows `"due":1` and a `written` entry for `SPCX` on `2026-10-14`. One `pf_lots` row exists with `kind = weekly`, `assumed = true`, and `shares = floor(400 / price, 6 decimals)`. The price should be within a few percent of SPCX's 2026-10-14 close; check it against `tape` bars if it looks off.

- [ ] **Step 7: Run it again and confirm there is no second copy**

Repeat Step 6's `net.http_post` (the lots call only), then re-run the response and row queries.
Expected: `{"due":0}` and still exactly one `pf_lots` row.

- [ ] **Step 8: Test the report end to end, then clean up**

Call MCP `execute_sql`:

```sql
insert into public.pf_lots (user_id, symbol, shares, price, day, kind, note)
values ('f0e1e204-aa54-4a45-bbb5-99c83114fecb', 'SPCX', 1, 140, '2026-10-13', 'start', 'smoke test');
select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/pilot',
  headers := '{"Content-Type":"application/json"}'::jsonb,
  body := jsonb_build_object('mode','report','userId','f0e1e204-aa54-4a45-bbb5-99c83114fecb',
    'cronSecret',(select decrypted_secret from vault.decrypted_secrets where name='desk_cron_secret')),
  timeout_milliseconds := 140000) as id;
```

About sixty seconds later, run:

```sql
select status_code, left(content::text, 600) from net._http_response where id = <id>;
select day, status, tries, model, cost_usd, error, output->>'summary' as summary, jsonb_array_length(input->'holdings') as holdings, jsonb_array_length(input->'market') as market
from public.pf_reports where user_id = 'f0e1e204-aa54-4a45-bbb5-99c83114fecb';
select kind, model, cost_usd from public.pf_spend where user_id = 'f0e1e204-aa54-4a45-bbb5-99c83114fecb' order by at desc limit 5;
```

Expected:
- The response is `{"ok":true,...}`.
- One `pf_reports` row for today with `status = done`, `tries = 1`, a plain summary of under about 150 words and no emojis, `holdings = 1` and `market = 4`. If `market` is 3, one index returned no price; check it with a `tape` snapshot call before going on.
- A `pf_spend` row with `kind = report` and a cost of about $0.01 to $0.03.

Read the summary yourself. It must use only numbers from the input, give no buy or sell advice, and explain any lingo in parentheses. If it fails that, tighten `REPORT_SYSTEM` in Task 3, re-run Tasks 3 and 4's tests, re-sync the libs, and redeploy (Steps 3 and 4).

Then clean up the test data so Ben starts empty. The spend rows stay; that was real spend.

```sql
delete from public.pf_lots where user_id = 'f0e1e204-aa54-4a45-bbb5-99c83114fecb';
delete from public.pf_reports where user_id = 'f0e1e204-aa54-4a45-bbb5-99c83114fecb';
delete from public.pf_settings where user_id = 'f0e1e204-aa54-4a45-bbb5-99c83114fecb';
```

- [ ] **Step 9: Test the feed and its booked cost**

Call `pilot` with `'mode','feed'`, the same way as Step 5, and use `timeout_milliseconds := 140000`. About ninety seconds later, read the response and run `select kind, model, cost_usd, at from public.pf_spend order by at desc limit 3;`.
Expected: the response has `inserted`, `tagged` and `cost`. There is a `pf_spend` row with `kind = feed`, unless the cost was 0 (nothing new to tag), which is fine.

- [ ] **Step 10: Commit**

```bash
git add supabase/functions/pilot/index.ts
printf 'Portfolio: the pilot edge function (tick, feed, weekly lots, morning report under the $1 cap)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > /tmp/pf-msg.txt
git commit -q -F /tmp/pf-msg.txt
```

---

### Task 7: Client API, the space and Holdings

**Files:**
- Create: `src/lib/portfolio/api.ts`
- Create: `src/components/portfolio/fmt.ts`
- Create: `src/components/portfolio/PortfolioSpace.tsx`
- Create: `src/components/portfolio/Holdings.tsx`
- Create: `src/components/portfolio/Report.tsx`, as a stub that Task 8 replaces
- Create: `src/components/portfolio/PortfolioSettings.tsx`, as a stub that Task 9 replaces
- Modify: `src/app/page.tsx` (lines 19, 44, 52, 174 and 196 as of 0aeca18)

**Interfaces:**
- Consumes: `holdingsOf`, `Lot`, `LotKind`, `Quote`, `Holding` (Task 1); `Recurring`, `etMidnightMs` (Task 2); `ReportInput`, `ReportOut` (Task 3); `callFn`, `TAPE_FN`, `fmtMoney`, `fmtPct` from `src/lib/desk/api.ts`; `supabase`, `SUPABASE_URL`, `todayStr` from `src/lib/supabase.ts`; `Card`, `Eyebrow`, `Segmented` from `src/components/ui.tsx`.
- Produces:
  - `PILOT_FN`
  - `loadLots(uid): Promise<{ lots: Lot[]; error: string }>`
  - `addLot(uid, l: Omit<Lot, "id" | "created_at">): Promise<string>`
  - `updateLot(id, patch): Promise<string>`
  - `deleteLot(id): Promise<string>`
  - `type PfSettings = { recurring: Recurring[]; buy_dow: number; recurring_since: string | null; cap_usd_day: number; paused: boolean }`
  - `loadSettings(uid): Promise<{ settings: PfSettings | null; error: string }>`
  - `saveSettings(uid, patch: Partial<PfSettings>): Promise<string>`
  - `type ReportRowFull`
  - `loadReports(uid, limit?): Promise<{ reports: ReportRowFull[]; error: string }>`
  - `writeReportNow(): Promise<{ ok?: boolean; error?: string }>`
  - `spentSince(iso: string): Promise<number | null>`
  - `loadQuotes(symbols): Promise<{ quotes: Record<string, Quote>; error: string }>`
  - `checkSymbol(symbol): Promise<{ ok: boolean; name: string; error: string }>`
  - Components `PortfolioSpace({ uid })`, `Report({ uid, hasHoldings, paused })` and `PortfolioSettings({ uid, settings, onSaved })`. Tasks 8 and 9 keep exactly these props.

- [ ] **Step 1: Write the client API**

Create `src/lib/portfolio/api.ts`:

```ts
"use client";

// Portfolio — client side of the pilot function and the pf_ tables. Every
// loader returns an error string next to its data, so a failed read never
// renders like an empty portfolio (GRADING.md rule 2).

import { supabase, SUPABASE_URL } from "@/lib/supabase";
import { callFn, TAPE_FN } from "@/lib/desk/api";
import type { Lot, LotKind, Quote } from "./lots";
import type { Recurring } from "./weekly";
import type { ReportInput, ReportOut } from "./report";

export const PILOT_FN = `${SUPABASE_URL}/functions/v1/pilot`;

const n = (v: unknown, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

function toLot(r: Record<string, unknown>): Lot {
  return { id: String(r.id), symbol: String(r.symbol), shares: n(r.shares), price: n(r.price), day: String(r.day), kind: (r.kind as LotKind) ?? "manual", assumed: r.assumed === true, note: String(r.note ?? ""), created_at: String(r.created_at ?? "") };
}

export async function loadLots(uid: string): Promise<{ lots: Lot[]; error: string }> {
  const { data, error } = await supabase.from("pf_lots").select("id,symbol,shares,price,day,kind,assumed,note,created_at").eq("user_id", uid).order("day", { ascending: true }).limit(2000);
  if (error) return { lots: [], error: "Couldn't load your holdings." };
  return { lots: ((data ?? []) as Record<string, unknown>[]).map(toLot), error: "" };
}
export async function addLot(uid: string, l: Omit<Lot, "id" | "created_at">): Promise<string> {
  const { error } = await supabase.from("pf_lots").insert({ user_id: uid, ...l });
  return error ? "Couldn't save that. Try again." : "";
}
export async function updateLot(id: string, patch: Partial<Omit<Lot, "id" | "created_at">>): Promise<string> {
  const { error } = await supabase.from("pf_lots").update(patch).eq("id", id);
  return error ? "Couldn't save that change." : "";
}
export async function deleteLot(id: string): Promise<string> {
  const { error } = await supabase.from("pf_lots").delete().eq("id", id);
  return error ? "Couldn't delete that." : "";
}

export type PfSettings = { recurring: Recurring[]; buy_dow: number; recurring_since: string | null; cap_usd_day: number; paused: boolean };
function toSettings(r: Record<string, unknown>): PfSettings {
  return {
    recurring: (Array.isArray(r.recurring) ? (r.recurring as Record<string, unknown>[]) : []).map((x) => ({ symbol: String(x.symbol ?? ""), usd: n(x.usd) })),
    buy_dow: n(r.buy_dow, 3), recurring_since: r.recurring_since ? String(r.recurring_since) : null,
    cap_usd_day: n(r.cap_usd_day, 1), paused: r.paused === true,
  };
}
// Select, and only if the read succeeded and found nothing, create the row.
export async function loadSettings(uid: string): Promise<{ settings: PfSettings | null; error: string }> {
  const { data, error } = await supabase.from("pf_settings").select("*").eq("user_id", uid).maybeSingle();
  if (error) return { settings: null, error: "Couldn't load the settings." };
  if (data) return { settings: toSettings(data as Record<string, unknown>), error: "" };
  const ins = await supabase.from("pf_settings").insert({ user_id: uid }).select("*").maybeSingle();
  if (ins.error || !ins.data) return { settings: null, error: "Couldn't create the settings." };
  return { settings: toSettings(ins.data as Record<string, unknown>), error: "" };
}
export async function saveSettings(uid: string, patch: Partial<PfSettings>): Promise<string> {
  const { error } = await supabase.from("pf_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("user_id", uid);
  return error ? "Couldn't save the settings." : "";
}

export type ReportRowFull = {
  day: string; status: "running" | "done" | "failed"; tries: number;
  input: Partial<ReportInput>; output: Partial<ReportOut>; model: string; cost_usd: number; error: string; updated_at: string;
};
export async function loadReports(uid: string, limit = 8): Promise<{ reports: ReportRowFull[]; error: string }> {
  const { data, error } = await supabase.from("pf_reports").select("day,status,tries,input,output,model,cost_usd,error,updated_at").eq("user_id", uid).order("day", { ascending: false }).limit(limit);
  if (error) return { reports: [], error: "Couldn't load the reports." };
  return {
    reports: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      day: String(r.day), status: r.status as ReportRowFull["status"], tries: n(r.tries),
      input: (r.input as Partial<ReportInput>) ?? {}, output: (r.output as Partial<ReportOut>) ?? {},
      model: String(r.model ?? ""), cost_usd: n(r.cost_usd), error: String(r.error ?? ""), updated_at: String(r.updated_at ?? ""),
    })),
    error: "",
  };
}
export async function writeReportNow(): Promise<{ ok?: boolean; error?: string }> {
  return callFn<{ ok?: boolean }>(PILOT_FN, { mode: "report" }, 150_000);
}
export async function spentSince(iso: string): Promise<number | null> {
  const { data, error } = await supabase.rpc("pf_my_spend_since", { p_since: iso });
  return error ? null : n(data);
}

export async function loadQuotes(symbols: string[]): Promise<{ quotes: Record<string, Quote>; error: string }> {
  if (!symbols.length) return { quotes: {}, error: "" };
  const r = await callFn<{ cards?: Record<string, Record<string, unknown>> }>(TAPE_FN, { mode: "snapshot", symbols: symbols.map((symbol) => ({ symbol })) }, 60_000);
  if (r.error || !r.cards) return { quotes: {}, error: r.error || "Couldn't load prices." };
  const quotes: Record<string, Quote> = {};
  for (const [k, c] of Object.entries(r.cards)) {
    const price = Number(c?.price), prev = Number(c?.prevClose);
    if (!Number.isFinite(price) || price <= 0) continue;
    quotes[k] = { price, prevClose: Number.isFinite(prev) && prev > 0 ? prev : null, name: String(c.name ?? k) };
  }
  return { quotes, error: "" };
}
export async function checkSymbol(symbol: string): Promise<{ ok: boolean; name: string; error: string }> {
  const r = await callFn<{ ok?: boolean; name?: string }>(TAPE_FN, { mode: "validate", symbol }, 30_000);
  if (r.ok === true) return { ok: true, name: String(r.name ?? symbol), error: "" };
  return { ok: false, name: "", error: String(r.error ?? `${symbol} isn't a stock or ETF Robinhood trades.`) };
}
```

- [ ] **Step 2: Write the shared formatting**

Create `src/components/portfolio/fmt.ts`:

```ts
import { fmtMoney } from "@/lib/desk/api";

export const toneOf = (v: number) => (v > 0 ? "var(--ok)" : v < 0 ? "var(--bad)" : "var(--text-3)");
export const signed = (v: number) => (v >= 0 ? "+" : "-") + fmtMoney(Math.abs(v), 2);
export const fmtShares = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 6 });
```

- [ ] **Step 3: Write the space**

Create `src/components/portfolio/PortfolioSpace.tsx`:

```tsx
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
```

- [ ] **Step 4: Write Holdings**

Create `src/components/portfolio/Holdings.tsx`:

```tsx
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
  l.kind === "start" ? "What Robinhood showed you owned that day. It replaces anything entered before it."
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
  return (
    <div className="mt-3 border-t border-[var(--border-1)] pt-2 space-y-2.5">
      <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">Each buy and sale, newest first</p>
      {[...lots].sort((a, b) => b.day.localeCompare(a.day) || b.created_at.localeCompare(a.created_at)).map((l) => editing === l.id ? (
        <LotEdit key={l.id} lot={l} onDone={(saved) => { setEditing(null); if (saved) onChanged(); }} />
      ) : (
        <div key={l.id} className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[12px]">{l.day} · {l.kind === "start" ? "owned" : l.shares < 0 ? "sold" : "bought"} {fmtShares(Math.abs(l.shares))} at {fmtMoney(l.price, 2)}</p>
            <p className="text-[10px] text-[var(--text-4)] leading-relaxed">{kindLabel(l)}</p>
          </div>
          <div className="flex gap-3 shrink-0 pt-0.5">
            <button onClick={() => setEditing(l.id)} className="text-[11px] font-semibold text-[var(--neon)]">Edit</button>
            <button onClick={() => remove(l)} className="text-[11px] text-[var(--text-3)]">Delete</button>
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
    const e = await addLot(uid, { symbol: sym, shares: action === "sell" ? -s : s, price: p, day, kind: action === "start" ? "start" : "manual", assumed: false, note: "" });
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
```

- [ ] **Step 5: Add stubs so the space compiles (Tasks 8 and 9 replace them)**

Create `src/components/portfolio/Report.tsx`:

```tsx
"use client";

export default function Report({ uid, hasHoldings, paused }: { uid: string; hasHoldings: boolean; paused: boolean }) {
  void uid; void hasHoldings; void paused;
  return null;
}
```

Create `src/components/portfolio/PortfolioSettings.tsx`:

```tsx
"use client";

import type { PfSettings } from "@/lib/portfolio/api";

export default function PortfolioSettings({ uid, settings, onSaved }: { uid: string; settings: PfSettings; onSaved: () => void }) {
  void uid; void settings; void onSaved;
  return null;
}
```

- [ ] **Step 6: Add the Invest space to the shell**

Make these edits in `src/app/page.tsx`:

1. After the line `import DeskSpace from "@/components/desk/DeskSpace";` add the line `import PortfolioSpace from "@/components/portfolio/PortfolioSpace";`.
2. Replace `  | "home" | "plan" | "body" | "learning" | "read" | "desk"` with `  | "home" | "plan" | "body" | "learning" | "read" | "portfolio" | "desk"`.
3. Replace `  { key: "read", label: "Read" },` with:
   ```tsx
     { key: "read", label: "Read" },
     { key: "portfolio", label: "Invest" },
   ```
4. Replace `          {tab === "read" && <ReadSpace uid={uid} />}` with:
   ```tsx
             {tab === "read" && <ReadSpace uid={uid} />}
             {tab === "portfolio" && <PortfolioSpace uid={uid} />}
   ```
5. Replace `          <div className="max-w-md mx-auto grid grid-cols-6">` with `          <div className="max-w-md mx-auto grid grid-cols-7">`. The mobile dock now has six spaces plus the settings dots.

- [ ] **Step 7: Lint, type-check and build**

Run: `npx eslint src/components/portfolio src/lib/portfolio src/app/page.tsx --max-warnings 0 && npx tsc --noEmit && npm run build 2>&1 | tail -5; git checkout public/version.json src/lib/buildId.ts`
Expected: no lint output, no type errors, and the build ends with the static export's route list and no error.

- [ ] **Step 8: Commit**

```bash
git add src/lib/portfolio/api.ts src/components/portfolio src/app/page.tsx
printf 'Portfolio: the Invest space with holdings (typed Robinhood numbers, weekly buys, sales, edits)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > /tmp/pf-msg.txt
git commit -q -F /tmp/pf-msg.txt
```

---

### Task 8: The Report view

**Files:**
- Modify: `src/components/portfolio/Report.tsx` (replace the stub completely)

**Interfaces:**
- Consumes: `loadReports`, `spentSince`, `writeReportNow`, `ReportRowFull` (Task 7); `etMidnightMs` (Task 2); `ReportNews` (Task 3); `etDate`, `etParts` and `isTradingDay` from `src/lib/desk/clock.ts`; `fmtPct` from `src/lib/desk/api.ts`; `toneOf` (Task 7).
- Produces: `Report({ uid, hasHoldings, paused })`, the same props as the stub.

- [ ] **Step 1: Write the view**

Replace `src/components/portfolio/Report.tsx` with:

```tsx
"use client";

// Report — the 08:30 morning report on Ben's holdings. The numbers come from
// the data the server gathered (prices, tagged news, the events calendar); the
// summary, what to watch and the line per stock come from one AI call. Older
// reports stay readable under today's.

import { useCallback, useEffect, useState } from "react";
import { Card } from "../ui";
import { fmtPct } from "@/lib/desk/api";
import { etDate, etParts, isTradingDay } from "@/lib/desk/clock";
import { loadReports, spentSince, writeReportNow, type ReportRowFull } from "@/lib/portfolio/api";
import { etMidnightMs } from "@/lib/portfolio/weekly";
import type { ReportNews } from "@/lib/portfolio/report";
import { toneOf } from "./fmt";

export default function Report({ uid, hasHoldings, paused }: { uid: string; hasHoldings: boolean; paused: boolean }) {
  const [reports, setReports] = useState<ReportRowFull[]>([]);
  const [spent, setSpent] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [now, setNow] = useState(0); // set on each load, so render stays pure

  const load = useCallback(async () => {
    const t = Date.now();
    const [r, s] = await Promise.all([loadReports(uid, 8), spentSince(new Date(etMidnightMs(etDate(t))).toISOString())]);
    setNow(t);
    setReports(r.reports);
    setSpent(s);
    setErr(r.error);
    setLoaded(true);
  }, [uid]);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const writeNow = async () => {
    setBusy(true);
    setErr("");
    const r = await writeReportNow();
    setBusy(false);
    if (r.error) setErr(r.error);
    await load();
  };

  if (!loaded) return <div className="mt-3 skeleton h-40" />;

  const p = etParts(now);
  const today = p.date;
  const todays = reports.find((x) => x.day === today) ?? null;
  const done = reports.filter((x) => x.status === "done");
  const shown = done.find((x) => x.day === pick) ?? done[0] ?? null;
  const beforeTime = p.hour * 60 + p.minute < 8 * 60 + 30;
  const canWrite = hasHoldings && !paused && !busy && (!todays || (todays.status !== "running" && todays.tries < 3));

  let status: string;
  if (!hasHoldings) status = "Add what you own on the Holdings page first; the report is about your stocks.";
  else if (paused) status = "The copilot is paused in Settings, so no report is written.";
  else if (todays?.status === "done") status = `Today's report is below.`;
  else if (todays?.status === "running") status = "Today's report is being written right now.";
  else if (todays?.status === "failed") status = `Today's report didn't work: ${todays.error}${todays.tries >= 3 ? " It tries again tomorrow." : ""}`;
  else if (!isTradingDay(today)) status = "The market is closed today, so no report is written on its own.";
  else if (beforeTime) status = "Today's report arrives at 8:30 New York time.";
  else status = "Today's report hasn't arrived yet. It retries every five minutes until the close.";

  return (
    <div className="mt-3 space-y-3">
      <Card>
        <p className="text-[13px] text-[var(--text-2)] leading-relaxed">{status}</p>
        {canWrite && todays?.status !== "done" && (
          <button onClick={writeNow} className="mt-3 w-full rounded-lg bg-[var(--neon)] text-black text-xs font-semibold py-2.5 active:scale-95">Write it now</button>
        )}
        {busy && <p className="text-[11px] text-[var(--text-3)] mt-2">Writing. This takes up to a minute.</p>}
        {err && <p className="text-[11px] text-orange-400 mt-2">{err}</p>}
        <p className="text-[10px] text-[var(--text-4)] mt-2">
          AI cost today: {spent === null ? "couldn't load" : `$${spent.toFixed(2)}`}. The daily limit is in Settings; the report costs about one to two cents, and reading the news a few cents a day.
        </p>
      </Card>

      {shown && <ReportView r={shown} />}

      {done.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {done.map((x) => (
            <button key={x.day} onClick={() => setPick(x.day)} className={`rounded-lg px-2.5 py-1.5 mono text-[10px] ${x.day === shown?.day ? "bg-[var(--neon)] text-black font-semibold" : "bg-white/[0.04] opacity-70"}`}>{x.day}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportView({ r }: { r: ReportRowFull }) {
  const out = r.output;
  const inp = r.input;
  const lines = new Map((out.per_holding ?? []).map((x) => [x.symbol, x.line]));
  return (
    <Card>
      <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">Morning report · {r.day}</p>
      <p className="text-[14px] leading-relaxed mt-2">{out.summary}</p>

      {!!out.watch?.length && (
        <div className="mt-3">
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">What to watch</p>
          <ul className="mt-1 space-y-1 list-disc pl-4">{out.watch.map((w, i) => <li key={i} className="text-[13px] leading-relaxed">{w}</li>)}</ul>
        </div>
      )}

      {(inp.holdings ?? []).map((h) => (
        <div key={h.symbol} className="mt-3 border-t border-[var(--border-1)] pt-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">{h.symbol}</p>
            <p className="mono text-[11px]">
              ${h.price.toFixed(2)} · day <span style={{ color: toneOf(h.ret1d) }}>{fmtPct(h.ret1d)}</span> · week <span style={{ color: toneOf(h.ret5d) }}>{fmtPct(h.ret5d)}</span>
            </p>
          </div>
          {lines.get(h.symbol) && <p className="text-[13px] leading-relaxed mt-1 text-[var(--text-2)]">{lines.get(h.symbol)}</p>}
          {(inp.news ?? []).filter((x) => x.symbols.includes(h.symbol)).map((x) => <NewsLine key={x.link} n={x} />)}
        </div>
      ))}

      {!!inp.macro?.length && (
        <div className="mt-3 border-t border-[var(--border-1)] pt-2">
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">Economy and market news</p>
          {inp.macro.map((x) => <NewsLine key={x.link} n={x} />)}
        </div>
      )}

      {!!inp.events?.length && (
        <div className="mt-3 border-t border-[var(--border-1)] pt-2">
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">Coming up in the next two weeks</p>
          {inp.events.map((e, i) => <p key={i} className="text-[12px] mt-1">{e.day}{e.time_et ? ` ${e.time_et} ET` : ""} · {e.label}</p>)}
        </div>
      )}

      {!!inp.market?.length && (
        <div className="mt-3 border-t border-[var(--border-1)] pt-2">
          <p className="mono text-[9px] uppercase tracking-widest text-[var(--text-4)]">The market at yesterday&apos;s close</p>
          <div className="grid grid-cols-2 gap-2 mt-1">
            {inp.market.map((m) => (
              <div key={m.label}>
                <p className="mono text-[12px]">
                  {m.unit === "pts" ? `${m.level.toFixed(2)}%` : m.level.toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
                  <span style={{ color: toneOf(m.change) }}>{m.unit === "pts" ? `${m.change >= 0 ? "+" : ""}${m.change.toFixed(2)} pts` : fmtPct(m.change)}</span>
                </p>
                <p className="mono text-[8px] uppercase tracking-widest text-[var(--text-4)]">{m.label}</p>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-[var(--text-4)] mt-2 leading-relaxed">
            Day is the change at yesterday&apos;s close; week is the last five trading days. The 10-year Treasury yield is the interest rate on 10-year US government bonds; when it rises, fast-growing stocks often fall. Pts means percentage points.
          </p>
        </div>
      )}

      <p className="text-[10px] text-[var(--text-4)] mt-3">Prices, news and dates come from the data. The AI ({r.model}) only wrote the words, for ${r.cost_usd.toFixed(3)}.</p>
    </Card>
  );
}

function NewsLine({ n }: { n: ReportNews }) {
  return (
    <div className="mt-1.5">
      <a href={n.link} target="_blank" rel="noreferrer" className="text-[12px] font-semibold underline decoration-white/20 underline-offset-2">{n.title}</a>
      <p className="text-[12px] text-[var(--text-2)] leading-relaxed">{n.plain} <span className="text-[var(--text-4)]">({n.source})</span></p>
    </div>
  );
}
```

- [ ] **Step 2: Lint, type-check and build**

Run: `npx eslint src/components/portfolio --max-warnings 0 && npx tsc --noEmit && npm run build 2>&1 | tail -5; git checkout public/version.json src/lib/buildId.ts`
Expected: no lint output, no type errors, and the build finishes.

- [ ] **Step 3: Commit**

```bash
git add src/components/portfolio/Report.tsx
printf 'Portfolio: the morning report view (status, Write it now, AI cost today, past reports)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > /tmp/pf-msg.txt
git commit -q -F /tmp/pf-msg.txt
```

---

### Task 9: Settings

**Files:**
- Modify: `src/components/portfolio/PortfolioSettings.tsx` (replace the stub completely)

**Interfaces:**
- Consumes: `saveSettings`, `PfSettings` (Task 7); `etDate` from `src/lib/desk/clock.ts`.
- Produces: `PortfolioSettings({ uid, settings, onSaved })`, the same props as the stub.

- [ ] **Step 1: Write the settings**

Replace `src/components/portfolio/PortfolioSettings.tsx` with:

```tsx
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
```

- [ ] **Step 2: Lint, type-check and build**

Run: `npx eslint src/components/portfolio --max-warnings 0 && npx tsc --noEmit && npm run build 2>&1 | tail -5; git checkout public/version.json src/lib/buildId.ts`
Expected: no lint output, no type errors, and the build finishes.

- [ ] **Step 3: Commit**

```bash
git add src/components/portfolio/PortfolioSettings.tsx
printf 'Portfolio: settings (weekly buy rows, buy day, daily AI limit, pause)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > /tmp/pf-msg.txt
git commit -q -F /tmp/pf-msg.txt
```

---

### Task 10: The cron, a live check, and shipping

**Files:**
- Create: `supabase/desk/009_pilot_cron.sql`

**Interfaces:**
- Consumes: the deployed `pilot` function (Task 6) and the built app (Tasks 7 to 9).
- Produces: cron job `pilot-tick`, and the app live at GitHub Pages.

- [ ] **Step 1: Write the cron record**

Create `supabase/desk/009_pilot_cron.sql`:

```sql
-- The portfolio copilot's five-minute heartbeat (build step 1): the news feed on the quarter,
-- the weekly lot after 09:36 ET on the buy day, the morning report from 08:30 ET.
-- Applied through the Supabase MCP (execute_sql); kept here as the record. Two minutes past each
-- five-minute mark, one minute after the paused desk-tick's slot.
select cron.schedule('pilot-tick', '2-59/5 * * * *', $$
  select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/pilot',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('mode','tick','userId','f0e1e204-aa54-4a45-bbb5-99c83114fecb',
      'cronSecret',(select decrypted_secret from vault.decrypted_secrets where name='desk_cron_secret')),
    timeout_milliseconds := 140000);
$$);
```

- [ ] **Step 2: Schedule it and confirm the Desk stays off**

Call MCP `execute_sql` with the `select cron.schedule(...)` statement above. Then run:

```sql
select jobid, jobname, schedule, active from cron.job where jobname in ('pilot-tick','desk-tick','desk-coach') order by jobid;
```

Expected: `pilot-tick` is active on `2-59/5 * * * *`. `desk-tick` and `desk-coach` are still inactive.

- [ ] **Step 3: Watch one real tick**

After the next firing (minutes ending in 2 or 7), run:

```sql
select r.status_code, left(r.content::text, 400), r.created
from net._http_response r order by r.created desc limit 3;
select status, return_message, start_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'pilot-tick') order by start_time desc limit 3;
```

Expected: the run `succeeded`. A response contains `"plan":{...}` with no `error`, and `"spent"` is a number.

- [ ] **Step 4: Run every check**

Run: `npx tsx --test src/lib/portfolio/*.test.ts src/lib/desk/*.test.ts && node scripts/desk-sync-libs.mjs --check && npx eslint src/components/portfolio src/lib/portfolio src/components/desk src/lib/desk --max-warnings 0 && npx tsc --noEmit && npm run build 2>&1 | tail -3; git checkout public/version.json src/lib/buildId.ts`
Expected: all tests pass, `desk lib copies in sync`, no lint or type errors, and the build finishes.

- [ ] **Step 5: Commit and ship**

```bash
git add supabase/desk/009_pilot_cron.sql
printf 'Portfolio: the pilot-tick cron (feed, weekly lot, 08:30 report)\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' > /tmp/pf-msg.txt
git commit -q -F /tmp/pf-msg.txt
git -c credential.helper= -c 'credential.helper=!f() { echo username=bookcrewcode; echo "password=$(gh auth token --user bookcrewcode 2>/dev/null)"; }; f' push origin desk:main
GH_TOKEN=$(gh auth token --user bookcrewcode) gh run list --repo bookcrewcode/daily --limit 1
```

Expected: the push is a fast-forward of `main`. The latest Actions run is the Pages deploy for this commit; wait for it to report `completed success`.

- [ ] **Step 6: Hand over to Ben**

Tell Ben, in three steps:
1. Open Daily, then Invest, then Holdings, then "I already own this": enter SPCX with the shares and average cost from Robinhood, plus any other stock he owns.
2. Go to Settings, then Weekly buy: enter SPCX, $400, Wednesday, and save.
3. In Robinhood, change the SPCX recurring investment to Wednesday.

The first report arrives at 08:30 ET on the next trading day, or he can tap Write it now.

Update the memory file `portfolio-copilot.md`:
- step 1 is live (the `pilot` function, the `pilot-tick` cron, and the `pf_` tables);
- the Invest space is in the app;
- the snapshot rule for "I already own this";
- the plan path.
