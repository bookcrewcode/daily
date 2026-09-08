# The Desk — news-driven paper trading with a jury of models

Design spec, 2026-09-07. Approved by Ben ("go") with one change: the universe is
everything he can trade on Robinhood and on BloFin, crypto futures included.
Companion research (four briefs, ~17,000 words, ~250 sources): `docs/desk/research/`.

## 1. Purpose

One space in the Daily app where, every night:

1. the day's market-moving news is laid out (the nightly briefing already does this, with
   per-story tickers and a thesis);
2. a jury of models from different labs argues over the best trade on that news plus the
   technical picture, and a verdict is issued;
3. the verdict becomes a paper trade on the app's own ledger, filled and marked with live
   prices (no broker, no Alpaca, no RegimeBot);
4. every trade carries its thesis, its invalidation, its exit reason and a post-mortem, so
   wins and losses both teach;
5. the models compete: each model's own call is tracked, ranked and calibrated, and the
   system feeds its measured track record back into tomorrow's debate.

Goals in order: learn how news moves markets → find out honestly whether the jury has an
edge → if it does, have something worth trusting with money.

**What the research says to expect.** Every published multi-agent trading paper reports
great backtests; every live, contamination-controlled benchmark in 2025–26 finds little or
no persistent alpha (LiveTradeBench, StockBench, KTD-Fin, Alpha Arena). The live failures
were behavioural, not analytical: overtrading, leverage, long bias. Retail base rates: 97%
of persistent day traders lose. So the Desk is a measurement instrument first: about 100
closed trades before a first honest verdict on edge, about 400 before re-weighting
anything. At one or two trades a night that is three to six months. The learning starts on
night one.

## 2. Non-goals

- No real money and no broker keys, ever, in this feature.
- No intraday scalping. Decisions once a night; fills at the next open (stocks) or the next
  hourly candle (crypto). The reaction to the number itself is priced by machines in
  milliseconds; the tradable part is the multi-day drift after quantitative news and the
  fade after transient shocks.
- No advice. Every screen says paper; post-mortems grade reasoning separately from money.

## 3. The universe — what Ben actually trades

Ben uses Robinhood and BloFin, so the jury may trade anything on either. Nothing is
pre-filtered; validation happens at proposal time against live data.

| Venue | Instrument | Side | Leverage | Validated how |
|---|---|---|---|---|
| Robinhood | every US-listed stock and ETF | long or short (paper; Robinhood itself cannot short, so the Book labels shorts "short · paper") | none | Yahoo search: exchange in NYSE, NASDAQ, NYSE Arca, AMEX, BATS; quoteType EQUITY or ETF; USD |
| Robinhood | crypto spot | long only | none | Coinbase Exchange product exists |
| BloFin | all live USDT-margined perpetual swaps (461 on 2026-09-07) | long or short | up to the instrument's `maxLeverage` (3x–150x), capped by the preset | BloFin instruments endpoint, refreshed nightly into `desk_instruments`; inverse (coin-margined) and USDC contracts excluded |

Options: Robinhood offers them, but no free options-chain source was verified, so the
ledger cannot fill an option honestly yet. Jurors may still discuss an options-shaped idea;
the guardrails map it to the underlying or drop it, and the verdict says so. This is the
one gap, stated in the app, to close when a chain source exists.

## 4. What exists and what changes

Stays: the `news` function (v3) and `world_briefings` (14 feeds, 9pm ET, `exposure[]` and
`thesis` per item); `WorldBriefing.tsx` on the Card; the OpenRouter key in the vault
(`anthropic_api_key`, sk-or-); `user_settings.ai_models`; the retry ladder.

Retired for this feature (data kept, nothing new writes to it): the `trader` function's
Alpaca path, `botbridge`, `NewsTrader.tsx`, cron jobs `news-agent-run-edt`,
`news-agent-sync-edt`, `news-agent-sync-est`, and the tables `agent_trades`, `bot_theses`,
`agent_equity`. RegimeBot has been dormant since July and that bridge needed Ben to drive
it by hand on his Mac. The old Markets legacy tab keeps `KalshiHub`.

## 5. Architecture

Everything runs in Supabase (edge functions + pg_cron) and renders in the PWA. No new
servers. No new keys required (two optional ones make the stock data path sturdier, §5.2).

### 5.1 Nightly timeline (ET)

    21:00       news       tonight's briefing (exists)
    21:30       desk run   packet → round 1 → round 2 → vote → judge → guardrails →
                           session + verdict saved, orders queued
    every 30m   desk sync  24/7, decides for itself: fill queued stock orders once the
                           open bar exists (9:35 ET); fill crypto at the next hourly
                           candle; check stops/targets on 5-min bars while NYSE is open
                           and on hourly candles for crypto; apply perp funding at each
                           8-hour mark; first run after 16:05 ET writes the day's mark
                           and equity snapshot; any close triggers a post-mortem
    Sun 20:00   desk coach weekly review → track-record card + lessons refresh

Ben can press "Run the desk now" any night (same code path; a day already run returns the
existing session unless he asks to re-run, which is recorded as a second session with
`seq = 2` and does not queue orders twice).

### 5.2 Market data (verified from inside Supabase's network, 2026-09-07)

| Need | Primary | Fallback | Verified |
|---|---|---|---|
| Stock/ETF daily bars (1y) for TA, official open/close | Yahoo `v8/finance/chart` (keyless) | Twelve Data `time_series` (optional free key) | 200 for SPY/AAPL/^VIX; bad symbol → clean 404 JSON |
| Stock/ETF 5-min bars for stop/target checks | Yahoo `interval=5m` | Twelve Data `5min` | 200 |
| Stock/ETF current price | Yahoo chart `meta.regularMarketPrice` | Finnhub `/quote` (optional free key) | 200 |
| Ticker validation + sector | Yahoo `v1/finance/search` | — | 200 |
| Crypto spot candles + price | Coinbase Exchange `candles`/`ticker` | Kraken `OHLC` | 200 |
| Crypto perps: instruments, tickers (bid/ask/last/24h), 1H and 1D candles, funding rate | BloFin `openapi.blofin.com/api/v1/market/*` (keyless) | Coinbase for price only | 200 for all four endpoints; 461 live USDT swaps; 1D candles up to 400 rows |
| Earnings dates | Nasdaq `api/calendar/earnings` (browser UA) | Finnhub `/calendar/earnings` (optional key) | 200 from Supabase; timed out from another datacenter — best effort |
| Macro dates | `desk_calendar` table (below) | FRED `releases/dates` (optional key) | BLS pages are Akamai-blocked |

Yahoo is unofficial and rate-limits shared IPs, so: one `tape` function owns every call,
daily bars are cached in `desk_bars` (a year once, then only missing days), a symbol that
fails is reported as unavailable (never a silent zero), and Twelve Data / Finnhub keys, if
Ben ever pastes them in Settings, are used automatically. Expected volume: ~40 symbols at
21:30 plus ~10 calls per sync — far under any limit.

Hard-coded calendar (from the published schedules): CPI 2026-09-11, 10-14, 11-10, 12-10;
jobs report 10-02, 11-06, 12-04; FOMC 09-15/16, 10-27/28, 12-08/09 and the 2027 tentative
dates; NYSE holidays 2026–27 and early closes. Stored in `desk_calendar`, editable, so a
wrong date is a row fix rather than a redeploy.

### 5.3 Edge functions (each small enough to redeploy in one MCP call)

1. **`tape`** — data + technicals. Modes: `snapshot` (symbols → per-symbol card: price,
   1d/5d/20d returns, 20/50/200-day SMA state, RSI-14, ATR-14 and ATR%, 20-day realized
   vol, 52-week high/low distance, volume vs 20-day average, gap %, relative strength vs
   SPY over 20/60 days; for perps also funding rate, 24h volume and the leverage cap),
   `context` (SPY, QQQ, IWM, TLT, GLD, USO, XLE, XLF, SMH, ^VIX, BTC, ETH; regime label),
   `movers` (BloFin: top 15 by 24h volume and top 10 by |24h change|), `bars` (5m, 1H, 1d),
   `quotes`, `calendar` (next 7 days: macro + earnings in the universe), `validate`,
   `instruments` (refresh `desk_instruments` from BloFin).
2. **`desk`** — the jury. Modes: `run` (§7), `status`. Ben's JWT or the cron secret.
3. **`desk-sync`** — the ledger engine (§8). Modes: `sync`, `quotes` (for the Book's live
   unrealized P&L), `mark`.
4. **`desk-review`** — learning (§10) and chat. Modes: `postmortem`, `coach`, `ask`.

Cron secret pattern reused: `desk_cron_secret` created in the vault with
`vault.create_secret(encode(gen_random_bytes(32),'hex'), …)`; one `desk-sync` job every
30 minutes, `desk-run` at 01:30 UTC and 02:30 UTC (the second is a no-op across DST, like
the briefing), `desk-coach` Sundays.

## 6. Data model (Postgres; RLS owner-only, `user_id default auth.uid()`)

- **`desk_accounts`** (pk user_id): `starting_equity` (100000), `cash`, `equity`,
  `preset` (aggressive|very_aggressive|moderate), `rules` jsonb (the live limits, §9),
  `halted_until` date, `halt_reason`, `roster` jsonb (model ids), `judge` (model id or
  "rotate"), `budget_usd_per_run` (1.50), `ladder` jsonb (unlock state), `created_at`.
- **`desk_sessions`** (unique user_id, day, seq): `day`, `seq`, `status`
  (running|done|failed|skipped), `regime`, `packet` jsonb (what every juror saw, frozen),
  `votes` jsonb (the deterministic tally per proposal), `verdict` jsonb, `judge_model`,
  `cost_usd`, `tokens_in`, `tokens_out`, `error`, `created_at`.
- **`desk_opinions`**: `session_id`, `model`, `juror` (A–H, shuffled nightly), `round`
  (1|2|judge), `content` jsonb, `raw` text (first 4 KB), `latency_ms`, `cost_usd`,
  `tokens_in`, `tokens_out`, `error`.
- **`desk_trades`** — every position, ledger or shadow: `owner` ('desk' | model id),
  `session_id`, `proposal_id`, `venue` (robinhood|blofin), `instrument`
  (stock|etf|crypto_spot|crypto_perp), `symbol` (AAPL, BTC-USD, SOL-USDT), `name`, `side`
  (long|short), `status` (pending|open|closed|cancelled), `template`, `thesis`, `catalyst`,
  `falsifier`, `confidence`, `evidence` jsonb, `regime`, `decided_at`, `entry_ref`, `stop`,
  `target`, `horizon_days`, `risk_pct`, `leverage` (1 for everything but perps), `qty`
  (shares, coins, or contracts), `notional`, `margin`, `liq_price`, `entry_price`,
  `entry_at`, `fill_rule`, `slippage_bps`, `fees`, `funding` (net funding paid, perps),
  `expires_on`, `exit_price`, `exit_at`, `exit_reason`
  (stop|target|time|thesis_broke|liquidated|halt|cancelled), `ambiguous_bar` bool, `pnl`,
  `pnl_pct` (on margin for perps, on notional otherwise — both shown), `r_multiple`,
  `mae_r`, `mfe_r`, `spy_entry`, `spy_exit`, `review` jsonb, `created_at`.
- **`desk_equity`** (unique user_id, day, owner): `equity`, `cash`, `market_value`,
  `gross_exposure`, `pnl_day`, `spy_close`, `marked_at`.
- **`desk_bars`** (unique symbol, day): `o,h,l,c,v`, `source` — shared cache, service-role
  written, readable by clients.
- **`desk_instruments`** (pk inst_id): `base`, `quote`, `max_leverage`, `contract_value`,
  `lot_size`, `tick_size`, `state`, `vol_24h_usd`, `last`, `updated_at` — BloFin, nightly.
- **`desk_calendar`**: `day`, `time_et`, `kind` (fomc|cpi|nfp|pce|gdp|earnings|holiday|
  early_close), `label`, `symbol`, `source`.
- **`desk_ratings`** (unique user_id, model): `elo`, `n_trades`, `n_wins`, `sum_r`,
  `brier_sum`, `brier_n`, `calib` jsonb, `n_abstain`, `updated_at`.
- **`desk_lessons`**: `text`, `scope` jsonb, `for_count`, `against_count`,
  `applied_count`, `status` (hidden|emerging|active|retired), `source_trade_ids` jsonb,
  `created_at`, `updated_at`.
- **`desk_cards`** (unique user_id, week_start): `card` jsonb, `review` text, `created_at`.
- **`chat_messages`** with `advisor = 'desk'`, `topic_id = session day`, for Ask-the-desk.

## 7. The jury protocol

**Packet** (identical for every juror, frozen on the session):
- tonight's briefing items, numbered, each with `why`, `exposure[]` and `thesis`;
  evidence must be cited by index;
- tape cards for: every exposure ticker, the context list, open positions, and the BloFin
  movers (top 15 by volume, top 10 by 24h change), plus the regime label;
- the universe index: a compact list of all live BloFin instrument ids, and the rule that
  any US-listed stock or ETF may be named (a proposal for a symbol without a card gets its
  card fetched on the fly; round 2 sees it);
- calendar for the next 7 days — a trade that crosses a known binary event must say so;
- the book: cash, equity, open positions with unrealized P&L, leverage, funding paid and
  days to time stop, gross exposure, halt state;
- the track-record card and active lessons — numbers, not adjectives;
- the playbook (12 templates with evidence grades, §7.5) — every proposal names one;
- the rules the guardrails will enforce (so proposals arrive pre-shaped);
- dates are relative ("today", "in 3 days"); the year is omitted where possible.

**Round 1 — proposals** (parallel, structured JSON): a two-sentence market read; 0–3
proposals or an explicit `no_trade` with the reason; each proposal: `{venue, instrument,
symbol, side, leverage, template, thesis, catalyst, what_would_prove_me_wrong, entry_ref,
stop, target, horizon_days, risk_pct, confidence (P(target before stop)), evidence[],
key_risks[], crosses_event}`. `no_trade` is a first-class answer and is scored (§11).

**Round 2 — rebuttals and ballots** (parallel): every juror sees all round-1 proposals
under anonymous labels (Juror A…H, reshuffled nightly), writes the strongest
counter-argument to each of the top proposals plus any it opposes, and returns a ballot:
`{proposal_id → support|oppose|abstain, confidence}` and one line: "what would change my
mind".

**Vote** (code, not a model): for each proposal
`score = Σ_jurors stance(+1/−1/0) × calibrated_confidence × weight`, where
`calibrated_confidence` shrinks the stated number toward that model's measured hit rate in
that confidence bin (once ≥ 20 scored calls; identity before), and `weight` comes from the
model's rating conservatively (rating − k·uncertainty, normalised; equal weights until a
model has 10 closed shadow trades). A proposal is a candidate when `score ≥ 0.5 × Σ weights`
and at least 3 jurors voted on it. Ranked by score; ties by reward:risk.

**Judge** (one call, sees the packet, both rounds, the tally): writes the verdict
narrative, "why not" for every rejected proposal, and "tonight's lesson" for Ben; may VETO
any candidate or cut its size or leverage (with a stated reason), may not add a trade or a
symbol. Default judge `anthropic/claude-opus-5` (not on the jury); option "rotate" picks the
juror with the best calibration over 30 days (≥ 10 scored calls).

**Guardrails after the judge** (code): symbol validated on the tape (an invented ticker or
a delisted perp is dropped and logged); stop on the correct side and ≥ 0.5 ATR from entry;
for perps the stop must sit inside the liquidation price with a 20% buffer, else leverage
is cut until it does; reward:risk ≥ 1.5 unless the template allows less; size = risk_pct ×
equity ÷ |entry − stop| per unit, rounded to lots, then capped by max notional per position
and gross exposure; leverage ≤ preset cap and ≤ instrument max; not already open in that
symbol; theme cap (positions on the same macro driver count as one); halted account →
verdict recorded, nothing queued; at most `max_new_per_night` (2) new positions.

**Shadow trades**: each juror's own top-ranked proposal is written as a shadow trade,
`owner = model id`, sized on a fixed $100k virtual book with the same rules, filled and
exited by the same engine. Every model is scored on what it would have done.

**Model calls**: OpenRouter chat completions with `response_format: json_schema
(strict)` and `provider: {require_parameters: true}`; on 503 retry once as plain JSON in the
prompt; `reasoning: {effort: "low", exclude: true}` set explicitly on every call because
most current models reason by default at high effort (the output bill is unbounded
otherwise); `max_tokens` generous; on a 4xx retry without the reasoning field; on empty
content retry with double the ceiling. A juror that still fails is recorded and shown as
failed. Cost is read from `usage.cost` on every response.

### 7.5 The playbook (from the research, evidence-graded; the full text ships in Lessons)

1. Earnings drift after a big beat with raised guidance — long, 10–60 days — strong
2. Earnings miss with cut guidance — short, 10–40 days — strong
3. Fade the first spike on ambiguous macro — index, ≤ 2 days — weak
4. Hawkish surprise → long USD / short duration (TLT) — 5–15 days — medium
5. Dovish surprise → long index 15 days — medium
6. Sector ETF on a regulatory shock (reversible policy → flip to fade) — 5–30 days — medium
7. Merger-arb spread on a friendly cash deal — to close — strong pattern, thin payoff
8. Geopolitical shock fade (no lasting supply impairment) — 10–40 days — medium
9. Oil supply shock → XLE/USO, then fade on the first repair headline — 2–20 days — medium
10. Crypto ETF-flow momentum — 2–10 days — weak/medium
11. Crypto sell-the-news after a run-up into an anticipated event — 3–15 days — folklore
12. Exchange hack (solvent) fade vs. solvency failure stand-aside — 1–10 days — practitioner

Organising rule the jurors are given: quantitative, cash-flow news under-reacts (drift);
qualitative, transient or anticipated news over-reacts (reversal). Templates 3, 11 and 12
get the smallest size. Half the paper return is assumed (post-publication decay).

## 8. The paper ledger — realism rules

- **Two timestamps.** `decided_at` (the verdict) and `entry_at` (the fill) are never the
  same moment. A stock decision at night fills at the next session's official open (the
  daily bar's open), never at the close the model saw. Crypto (spot and perps) fills at the
  open of the next hourly candle.
- **Slippage and fees** (per side, constants in one place, shown in the Book's rules
  note): stocks/ETFs 5 bps large-cap, 15 bps otherwise, doubled on a day the symbol gapped
  more than 2%; $0 commission, SEC fee 2.06 bps on sells, FINRA TAF $0.000195/share on
  sells capped at $9.79. Robinhood crypto spot: 50 bps spread cost per side. BloFin perps:
  taker 0.06% per side on notional, slippage 10 bps for BTC/ETH/SOL and 25 bps for other
  coins, funding every 8 hours (00:00, 08:00, 16:00 UTC) at the live rate: longs pay when
  the rate is positive, shorts receive; charged at each sync that crosses a funding time.
- **Leverage and margin (perps).** `margin = notional ÷ leverage`, isolated per position;
  `liq_price = entry × (1 ∓ (1 ÷ leverage − 0.005))`; if an hourly candle crosses it, the
  position closes there with `exit_reason = liquidated` and the margin is gone. The stop is
  always inside the liquidation price (guardrail), so liquidation should never fire —
  when it does, that is a lesson in itself.
- **Exits.** Stocks: while NYSE is open, 5-min bars are checked every 30 minutes; a long
  stop hits when a bar's low ≤ stop and fills at min(open, stop) − slippage (a gap through
  the stop fills at the gap); targets mirror on the high. Crypto: hourly candles, 24/7.
  Same bar touches both → stop first, `ambiguous_bar = true`. Time stop: closed at the open
  of the session (or hour) after `expires_on`. `thesis_broke`: the next jury may vote to
  close an open position early only by naming the falsifier that fired; the judge cannot do
  it alone. Halt: nothing is force-closed.
- **Marks.** After 16:05 ET every open position is marked at the daily close (crypto at
  that moment from the hourly candle) and `desk_equity` gets one row per owner:
  `equity = cash + Σ unrealized` (perps: margin + unrealized; stocks: qty × mark; shorts as
  negative value with proceeds in cash), `pnl_day = equity − yesterday`. The Book also shows
  a live number from quotes.
- **R and excursions.** `r_multiple = pnl ÷ (|entry_price − stop| × qty × unit_value)`
  with the stop frozen at entry; MAE/MFE in R from bar highs/lows over the holding period.
- **Benchmark.** SPY at entry and exit on every trade; the equity curve is drawn against
  SPY buy-and-hold from the account's first day.
- **Hours.** NYSE 9:30–16:00 ET computed in America/New_York with the `desk_calendar`
  holiday and early-close rows. Crypto 24/7.

## 9. Risk rules and presets

Per-trade risk = distance to the stop, never conviction. Leverage changes the margin a
position uses, not the risk taken.

| Preset | risk/trade | max notional / position | max open | gross cap | max leverage (perps) | daily halt | weekly pause | heat cap |
|---|---|---|---|---|---|---|---|---|
| Aggressive (default) | 3% | 100% of equity | 4 | 200% | 10x | −6% day → no new entries next session | −12% week → coach review before resuming | 12% |
| Very aggressive | 5% | 200% | 4 | 400% | 25x | −8% | −15% | 15% |
| Moderate | 1.5% | 25% | 5 | 100% | 3x | −4% | −8% | 6% |

Hard rules in every preset: a stop on every trade; no averaging down; a time stop on every
trade; theme cap; nothing new into a halt; size halved after a 10% peak-to-trough drawdown
until a new equity high; a perp's stop inside its liquidation price. Aggression ladder
(measured, never by time): "Very aggressive" unlocks only after 20 closed desk trades with
positive expectancy in R; it re-locks if the trailing-20 expectancy turns negative. Ben can
override the leverage cap per preset in Settings up to the instrument max, and the setting
says what that does to the liquidation distance.

## 10. The learning loop

1. **Post-mortem on every close** (structured, by the "smart" model, ≤ 130 words of prose
   plus fields): thesis right? timing right? sizing right? rules followed? → verdict
   held|broke|unclear; process grade A–F independent of P&L; quadrant (earned | bad luck |
   dumb luck | deserved); mistake tags from a fixed taxonomy (chased, no_catalyst,
   ignored_calendar, stop_too_tight, size_too_big, leverage_too_high, thesis_vague,
   wrong_instrument, moved_stop, held_past_time, funding_ignored, luck); one transferable
   lesson written as a rule.
2. **Lessons library.** Each post-mortem's lesson is matched to an existing lesson (same
   scope, near-identical text) or created `hidden`; a match increments `for_count`, a
   contradiction `against_count`. `emerging` at for ≥ 3; `active` (injected into the
   packet) at for ≥ 5 and for ≥ 3 × against; `retired` after 10 applications with
   against ≥ for. At most 10 active lessons ride in the packet, most-applied first.
3. **Weekly coach** (Sunday): closed trades grouped by template × news category × model ×
   venue × regime → the track-record card: n, hit rate, mean R shrunk toward 0 with a
   20-trade prior, profit factor, t-stat. Cells with n < 8 read "too few to trust"; n ≥ 20
   with a stable sign read as a rule; n ≥ 50 and |t| ≥ 2 read "strong". The coach also
   writes a 200-word review for Ben. The card is what the jurors read all week.
4. **Ratings** update on every closed shadow trade (§11).

## 11. The League

Per model, and "the desk" consensus as a row: trades, hit rate, mean R, expectancy (R and
$), profit factor, max drawdown of its shadow book, Sharpe (daily, annualised shown
second), Brier score on stated confidence, a calibration strip (stated bin → realised hit
rate), the confident-and-wrong count (stated ≥ 0.7 and lost), `no_trade` count with how
the desk did those nights, and a rating.

Rating: Elo, K = 32 for a model's first 30 matches then 16, refit weekly as Bradley-Terry
across all matches. A match is two jurors taking opposite sides on the same symbol the same
night, or one trading while another explicitly abstained; the higher realised R over the
trade's horizon wins. Models with fewer than 10 closed shadow trades are "provisional" and
ranked below the line. Weekly MVP = best shrunk expectancy with ≥ 5 closes; Most Improved =
largest 8-week gain. Standings are in the packet.

## 12. UI

**Where:** Markets is promoted from Settings → Legacy to a fifth space in the dock: Card ·
Plan · Body · Learn · **Desk**. The desktop rail gains the same entry.

**Desk space, sub-tabs (Segmented):**
- **Tonight** — market clock (NYSE open/closed, crypto always on, next scheduled event),
  equity, today's P&L and all-time P&L (mono, odometer), the verdict card per trade
  (venue · symbol · side · leverage · size · entry, stop, target, liquidation for perps ·
  horizon · template · thesis · evidence links · what proves it wrong), the "why not" list,
  tonight's lesson, "Run the desk now", the run's cost, and a visible failure state naming
  which juror or feed failed.
- **Debate** — the day's news panel (the briefing items the jury saw, collapsed), then the
  transcript as chat: round 1 per juror (lab colour dot, model name, confidence chip),
  round 2 rebuttals, the tally, the judge; "Ask the desk" at the bottom — Ben's question is
  answered by the smart model with the packet and transcript as context, saved in
  chat_messages. Past days browsable.
- **Book** — open positions with live unrealized P&L (perps show leverage, margin, funding
  paid, liquidation distance), the equity curve vs SPY (Sparkline), stats grid (win rate,
  expectancy in R and $, profit factor, Sharpe, max drawdown, exposure, average hold,
  trades/week, trades to significance), closed trades with expandable thesis → exit →
  post-mortem (grade, quadrant, tags), and the ledger rules note.
- **League** — standings table with per-model sparkline and calibration strip; tap a
  model for its shadow book.
- **Lessons** — active lessons with counts, emerging candidates, the weekly coach review,
  the track-record card, and the playbook with the research behind it.

Card chip: "Desk · 2 open · +1.3% today" (or "Desk · verdict at 9:30pm"). Settings gains a
"Desk" block: roster checkboxes with a $/run estimate from the live catalog, judge
selection, risk preset with the ladder state and the leverage cap, budget cap, optional
data keys.

Style: existing tokens and primitives (Card, Eyebrow, SectionTitle, Segmented, Sparkline,
Num), dark-first, mono numbers, no emojis in the new screens, every label explained on
screen (the app-explains-itself rule), one bold next action per screen.

## 13. Cost control

Default roster (7 labs) and judge, live catalog prices 2026-09-07 ($/M in → out):
`anthropic/claude-sonnet-5` 2 → 10, `openai/gpt-5.6-terra` 2 → 12, `google/gemini-3.8-flash`
0.75 → 3.75, `x-ai/grok-4.6` 2 → 6, `deepseek/deepseek-v4-pro-0813` 1.05 → 3.15,
`qwen/qwen3.8-max-0902` 2 → 6, `moonshotai/kimi-k2.6` 0.95 → 4; judge
`anthropic/claude-opus-5` 5 → 25. Estimated ≈ $0.45 per run ≈ $13–15 per month, plus about
$1 per month for post-mortems and the coach. Every call records tokens and `usage.cost`; a
run has a budget cap (default $1.50): round 2 is skipped if round 1 spent 60% of it, the
judge always runs. A 402 shows "credits out" exactly as the news function does. Tonight
shows the run's cost and the month to date.

## 14. Error handling and honesty

- A juror that errors is shown as errored; the debate proceeds if ≥ 3 jurors answered,
  otherwise the session is `failed` with the reason and nothing is queued.
- A symbol the tape cannot price is out for the night and named in the verdict.
- A fill needs a real bar: if the bar is missing, the order stays pending and the next
  sync retries; after two sessions (or 48 hours for crypto) it is cancelled with the reason.
- Write-first, celebrate-second; `{error}` checked on every write; midnight guards on
  every date-keyed view; snapshots and sessions are idempotent by unique keys so a double
  cron fire across DST cannot double-count (GRADING.md rules).
- The packet is stored exactly as sent, so a bad verdict can always be re-read against
  what the models actually saw.

## 15. Testing

- Pure ledger math in `src/lib/desk/ledger.ts` (fills, exits incl. gap-through,
  both-touched and liquidation, funding, marks, R, MAE/MFE), pure rules in
  `src/lib/desk/rules.ts` (sizing incl. lots and leverage, caps, halts, ladder,
  liquidation buffer), pure stats in `src/lib/desk/stats.ts` (expectancy, profit factor,
  Sharpe, drawdown, Brier, Elo/BT, shrinkage) — all with `node:test` via `npx tsx --test`,
  the existing pattern. The edge functions carry copies of those modules (functions cannot
  import from `src`), checked by a script that diffs the copies.
- One recorded packet (a real briefing day) replayed through `desk` in `dry` mode (writes
  nothing) to check every roster model's schema compliance before the first live night.
- First live night is watched: the stock fill at the next open is checked by hand against
  the official open; a perp fill against BloFin's candle.

## 16. Rollout (each phase ships and is usable on its own)

1. Schema + `tape` (Yahoo, Coinbase, BloFin) + `desk-sync` + ledger/rules/stats libraries
   with tests + the Book tab on an empty account; a manual test order proves a fill.
2. `desk` run (round 1 + vote + judge + guardrails), Tonight and Debate tabs, orders and
   shadow trades, nightly cron. First verdicts.
3. Round 2 rebuttals, post-mortems, League, lessons, weekly coach, Card chip.
4. Ask-the-desk, playbook in Lessons, the Settings block, retire the old trader cron jobs.
   Grader pass per GRADING.md.

Ships the usual way: branch `desk` in a git worktree, pushed to `main` in
`bookcrewcode/daily` with the bookcrewcode token, GitHub Pages deploys; migrations and
functions deploy through the Supabase MCP.

## 17. Decisions (Ben, 2026-09-07)

1. Fifth space "Desk" in the dock — approved.
2. Universe — changed: everything on Robinhood and BloFin, all crypto futures allowed, no
   pre-filtering. Options deferred only because no chain data source exists yet.
3. Aggressive preset by default with the measured ladder — approved.
4. Seven-lab roster ≈ $0.45/run with a $1.50 cap — approved.
5. Retire the RegimeBot bridge for this feature — approved.
6. Ship phases to `main` as they land — approved.
