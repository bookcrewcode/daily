# Honest Paper-Trading Ledger, Trading Journal, and Self-Learning Loop — Research Brief

*Prepared 2026-09-07. Sources are listed at the end; bracketed numbers refer to that list.*

## 0. Five rules that keep the ledger honest

1. **A decision and its fill are two different timestamps.** The simulator never fills at a price the model already saw; it fills at the next price that a real order could have reached.
2. **Every ambiguity resolves against the trader**: worse side of the spread, gap price not stop price, stop-before-target on an ambiguous bar, next session's open for after-hours decisions.
3. **Money is accounted the boring way**: orders → fills → positions (average cost) → daily equity snapshots, with realized and unrealized P&L kept separate and fees on the fill.
4. **Process and outcome are judged separately.** Every closed trade gets an R-multiple, a 2x2 process/outcome cell, and an A–F process grade that ignores P&L.
5. **Models are fed statistics, not sermons.** Track-record numbers, shrunk toward priors and gated by minimum sample size, are the only "lessons" that enter prompts — because LLMs do not reliably self-correct without external feedback [30].

---

## 1. Simulated execution realism

### 1.1 The decision/fill boundary (the most common cheat)

Bar-based backtesters converge on one rule: *generate the signal at bar close, execute at the next bar's open* [1][2]. Backtrader's default broker fills a market order at the next incoming price; its `cheat-on-open` mode exists only so a strategy can size against the open it is about to receive, not to fill at the close it already saw [3]. QuantConnect's equity fill model is stricter still: it "won't fill limit orders with stale data or data with the order timestamp to avoid look-ahead bias," and "only fills market orders during regular trading hours" [4].

Rules for the app:

- Store `decided_at` (when the jury emitted the idea) and `submitted_at`. A fill may use only market data timestamped strictly **after** `submitted_at`, plus a latency buffer (e.g., 1 s live, or the full delay of a delayed feed).
- **Equities, after hours:** an order submitted outside 09:30–16:00 ET becomes a market-on-open order for the *next* trading session and fills at that session's official open ± spread/slippage. QuantConnect fills MOO orders at the official opening-auction price [4]. A 9 pm ET Tuesday decision fills Wednesday 09:30; a Friday 9 pm decision fills Monday (or Tuesday if Monday is a holiday). Never fill at the last close.
- **Equities, intraday:** fill at the first quote/bar after submission — buys at the ask, sells at the bid [4].
- **Crypto:** 24/7; fill at the first 1-minute bar after submission.

Why this matters: an audit of 30 LLM-trading studies found only 14 gave a recoverable transaction-cost treatment and most never said whether trades executed at the same close, next open, or next close; adding 10 bps of cost cut a proxy strategy's growth multiple from 1.471 to 1.307, and 25 bps cut it to 1.081 [5]. A companion survey found only 1 of 19 primary studies reported an explicit cost model, and warned that news timestamps record *publication*, not when the information became actionable [6].

### 1.2 Spread and slippage

Model `fill = reference × (1 ± half_spread ± slippage)`, sign against the trader.

Reference points: SPY's average quoted spread is ≈0.003% [7]; a basket of S&P 500 names costs ≈4.5 bps per trade in spread; small/illiquid names can exceed 50 bps round-trip, sometimes hundreds [8]. The average US ETP spread is 0.52% (median 0.20%) [7]. Zipline's default `FixedBasisPointsSlippage` is **5 bps** with a 10%-of-minute-volume fill cap; its `VolumeShareSlippage` charges `price_impact × volume_share²` with `price_impact = 0.1` and a 2.5% volume limit [9]. QuantConnect ships the same volume-share model (defaults 0.025 / 0.1) plus a market-impact model [10]. Kaiko finds BTC spreads tighter than ETH on most venues, USDT pairs tightest, and Binance tightest overall [11].

Recommended per-side slippage, added on top of half-spread: **5 bps** liquid large caps/ETFs; **10–30 bps** small caps; **10 bps** BTC/ETH; 30–50 bps other crypto. Double it in the first five minutes after the open and on gap days (>2% gap).

### 1.3 Commissions and regulatory fees

- **US equities:** $0 commission at retail brokers, but pass-through fees on **sales**. SEC Section 31: **$20.60 per $1,000,000** sold (2.06 bps), effective April 4, 2026, after sitting at $0 from May 2025; charge date is trade date [12][13]. FINRA TAF: **$0.000195 per share** sold, capped at **$9.79** per trade, effective Jan 1, 2026 [14]. Together under 1 bp for a normal stock — model them anyway so the ledger is truthful.
- **Crypto:** Coinbase Advanced base tier 0.60% maker / 1.20% taker, dropping to 0.25%/0.40% above $10k 30-day volume; Kraken Pro base 0.25%/0.40% [15][16]. Default to **0.40% taker**; 0.10% is a stretch at retail volumes.

### 1.4 Gaps, stops, limits, partial fills

- A stop is a trigger, not a price: once hit it becomes a market order and fills at the next available price [17][18]. Simulator rule (QuantConnect): sell-stop fills at `min(open, stop) − slippage`, buy-stop at `max(open, stop) + slippage` [4]. A $95 stop on a stock that opens at $88 fills near $88.
- Limit orders fill only when marketable; on bars, a buy limit fills if `low < limit` at `min(open, limit)` [4]. Require a trade-through, not a touch.
- Partial fills: Alpaca's paper engine randomly partial-fills 10% of eligible orders and does not check size against NBBO quantity [19]; IBKR's paper fills come from top-of-book only and "may appear more favorable than live executions" [20]. For orders under ~1% of average daily volume, ignore partials; optionally cap fills at 10% of bar volume [9].

### 1.5 Stop and target in the same bar

With daily OHLC you cannot know which was hit first. Claeys (2026) shows that with a 10-point stop and 10-point target on 1-minute NQ data, 18.47% of bars were ambiguous and the best-case/worst-case gap reached 3,695 points ($73,900) per 1,000 trades; his recommendation is a *declared* conservative rule, never whichever assumption improves performance [21]. Rule: **stop first**, unless the bar's open is already beyond the target (then target at the open). Better: resolve with intraday bars (TradingView's "bar magnifier" approach [22]). Flag `ambiguous_bar = true` so you can count how often it happened.

### 1.6 Calendars and marking

- NYSE regular session 09:30–16:00 ET. 2026 full closures: Jan 1, Jan 19, Feb 16, Apr 3, May 25, Jun 19, Jul 3, Sep 7, Nov 26, Dec 25; 1:00 pm early closes on Nov 27 and Dec 24 [23][24]. Do not hand-code this: `pandas_market_calendars` mirrors `exchange_calendars` and ships holiday/early-close rules as package code [25].
- Crypto trades 24/7; the institutional convention strikes the daily close at **00:00 UTC** [26]. So a "session date" is ET-based for equities and UTC-based for crypto — store `session_date` and the mark timestamp on each snapshot.
- **Mark-to-market:** at each session close, mark every open position at the official close (equities) or the 00:00 UTC minute close (crypto) and write an equity snapshot: `equity = cash + Σ(qty × mark)`. Daily P&L = `equity_t − equity_{t−1} − net_deposits`. Update MAE/MFE from that day's high/low in the same job.

---

## 2. Position and P&L accounting

Objects: **account → orders → fills → positions → equity snapshots.** Orders are intents; fills are facts; positions are derived (and cached) from fills; equity snapshots are the audit trail.

Position update on a fill (signed quantity: long +, short −; `side = +1` long, `−1` short):

- **Increasing** (same sign): `avg_cost' = (qty × avg_cost + fill_qty × fill_px) / (qty + fill_qty)` [27].
- **Reducing/closing** (opposite sign): `realized += (fill_px − avg_cost) × closed_qty × side − fees`; `avg_cost` unchanged for the remainder [27][28].
- **Crossing zero:** split into a close and a new open.
- **Unrealized:** `(mark − avg_cost) × qty × side` — a short profits when `mark < avg_cost` [28].
- **Cash:** buys debit `qty × px + fees`; sells credit `qty × px − fees`; short sales credit proceeds. Ignore borrow cost, margin interest, and dividends, and say so on the dashboard (Alpaca's paper engine ignores them too [19]).
- **Equity** = cash + Σ market value (short positions carry negative market value).

**R-multiples** (Van Tharp): `R_initial = |entry_px − stop_px| × qty`, using the stop *planned at entry* and frozen thereafter; `R_multiple = net_pnl / R_initial`. A clean stop-out is −1R [29][30-a]. If the agent later moves the stop, R does not change — otherwise expectancy-in-R is gamed.

**MAE/MFE** (Sweeney): `MAE_long = entry − min(low)` and `MFE_long = max(high) − entry` over bars strictly inside `[entry_fill_ts, exit_fill_ts]` (mirror for shorts) [31]. Store price, dollar, and R-normalized versions — Tradervue keeps both "position" and "price" variants [32]. Plotting MAE against final R across ≥100 trades reveals the excursion beyond which trades rarely recover, which is the data-driven stop distance [31].

**Same-bar reconciliation:** if `low ≤ stop` and `high ≥ target` on one daily bar, the trade exits at the stop (conservative) and the bar is flagged.

---

## 3. Performance metrics

Notation: `n` closed trades, `P_i` net P&L, `R_i = P_i / R_initial_i`, `W` wins, `L` losses, daily return `r_t = equity_t / equity_{t−1} − 1`.

| Metric | Formula / rule |
|---|---|
| Total return | `equity_T / equity_0 − 1`; CAGR `= (equity_T/equity_0)^(365/days) − 1` |
| Daily P&L | `equity_t − equity_{t−1}` (net of deposits) |
| Win rate | `p = W / n` |
| Avg win / avg loss | `Σ P_i>0 / W` ; `|Σ P_i<0| / L` |
| Payoff ratio | `avg_win / avg_loss` [33] |
| Profit factor | `gross_profit / gross_loss` [34] |
| Expectancy ($) | `p × avg_win − (1−p) × avg_loss = mean(P_i)` [35] |
| Expectancy (R) | `mean(R_i)` |
| Sharpe | `mean(r_t − rf_t) / std(r_t)`, annualized `× √252` equities, `× √365` crypto [36][26] |
| Sortino | `mean(r_t − target) / √(mean(min(r_t − target, 0)²))`, same annualization [37] |
| Max drawdown | `max_t (peak_t − equity_t) / peak_t` [36] |
| Drawdown duration | longest run of sessions below the prior equity peak, peak to recovery [38] |
| Calmar | `CAGR / |MDD|` [36] |
| Exposure % | sessions with an open position ÷ total sessions (backtesting.py's "Exposure Time [%]") [39]; also gross exposure `Σ|mkt value| / equity` |
| Cadence | trades/week; avg holding `= mean(exit_ts − entry_ts)` |

**Caveat on √N scaling:** it assumes i.i.d. returns; Lo (2002) shows serial correlation can overstate an annualized Sharpe by up to 65% [40]. Report the daily Sharpe alongside the annualized one.

**Benchmarks.** (a) SPY buy-and-hold from the same start date and equity, marked on the same calendar; compare return, Sharpe, MDD. (b) *Coin-flip with the same sizing*: for each real trade keep symbol, entry session, size, stop and target distances, and holding period, but randomize direction (or entry date); run 1,000–10,000 paths; report the percentile of the real expectancy and Sharpe within that distribution — the random-entry baseline of Monte Carlo permutation testing [41][42]. `p ≈ share of random paths ≥ actual`.

**Statistical significance of the edge.** `t = mean(R_i) / (std(R_i) / √n)`; `t ≥ 2` ≈ two-sided p < 0.05; required `n ≈ 4 × (std/mean)²` [43]. Mean +0.2R with std 1.0R needs ~100 trades; +0.1R with std 1.2R needs ~576. Typical retail edges need 100–350 trades; 20–30 trades are "essentially untested" [44]. Related: Van Tharp's SQN `= √n × mean(R)/std(R)` [45]; the Probabilistic Sharpe Ratio and Minimum Track Record Length correct for skew and kurtosis, and the Deflated Sharpe Ratio corrects for how many strategies you tried [46][47]. Overlapping trades are not independent — count them conservatively — and testing `k` cells inflates the false-positive rate to `1 − (1−α)^k` [43].

---

## 4. Trading-journal best practices

**At entry** (Steenbarger's "plan, emotion, outcome" triad [48]; Tharp's rules-first framing [49]; thesis/invalidation guides [50]):

- One-sentence thesis; catalyst; setup template name; horizon; planned entry/stop/target; R at risk and sizing rationale; stated confidence as a probability of reaching target before stop.
- "What would prove me wrong": an evidence-based invalidation trigger, not just a price percentage. If you cannot write the trigger and a review date in plain language, treat it as a no-action signal [50].
- Market context (regime label, index trend, volatility bucket) and emotional/conviction state; checklist pass/fail (Edgewonk builds per-setup checklists into the entry [51]).

**At exit:** `exit_reason ∈ {target, stop, time, thesis_broke, discretionary, risk_override}`; execution vs plan (exited where planned? early? late?); realized slippage vs modeled; mistake tags.

**Post-mortem:**

- Four yes/no verdicts: thesis right? timing right? sizing right? rules followed?
- **Process/outcome 2x2** (Annie Duke's "resulting"): good decision/good outcome = earned reward; good decision/bad outcome = bad luck; bad decision/good outcome = dumb luck; bad/bad = just deserts [52]. Tunguz's framing: "success is a lagging indicator; processes are leading indicators" [53].
- **Process grade A–F, independent of P&L.** Rubric: checklist complete, size within rule, stop honored, exit per plan, invalidation respected, zero mistake tags. Tharp: a mistake is "not following your rules"; average traders are only 70–80% efficient; one $200M futures trader's 11 mistakes in nine months cost 46.5R [49].
- **Mistake taxonomy** (Edgewonk tracks mistakes and their cumulative cost and scores discipline with a "Tiltmeter" [51][54]): *entry* (chased, early, no catalyst), *sizing* (over/under), *stop* (moved, widened, none), *exit* (early on winner, late on loser, ignored target), *thesis* (stale, wrong catalyst), *process* (no checklist, outside rules, impulse/revenge). Each carries a $ and R cost so "cost of mistakes" is a monthly number.
- Steenbarger: the ideal entry "notes something distinctive that was done right or something distinctive that needs improvement," says why it matters, sets a concrete goal and plan, and the next entry reviews that goal; review weekly, and do not set new goals every day [48].
- Douglas: think in probabilities; judge over samples of 20+ trades; a single outcome carries no information [55].
- Tradervue's model: tag by strategy, instrument, session and market condition, then slice 100+ reports and MAE/MFE by tag [32][56].

---

## 5. Self-learning loop for an AI system

**Pipeline**

1. **Trade closes → reviewer.** A separate reviewer prompt (different model or temperature than the proposer) fills the structured post-mortem above and proposes 1–3 candidate lessons, each a rule-shaped sentence bound to a scope: setup template, news category, regime, asset class, model.
2. **Lessons pool with evidence counts.** Deduplicate by embedding similarity; each review *adds*, *upvotes*, *downvotes*, or *edits* a lesson — the insight-pool operations from ExpeL, which learns from stored successes and failures without gradient updates [57]. Reflexion established that verbal reflections kept in an episodic buffer improve later trials [58].
3. **Weekly coach pass.** Aggregate closed trades by `model × setup × news_category × regime`: n, hit rate, mean R, t-stat, profit factor, MAE distribution. TradingGroup does something similar — it labels the past 20 trading days of decisions with outcomes, compiles an "experience summary," and prepends it to the prompt; ablating self-reflection dropped its AMZN return from 40.46% to 9.41% [59].
4. **Track-record card in the prompt** (numbers, not prose): "Earnings-drift longs: n=12, hit 58%, +0.4R raw / +0.3R shrunk — emerging. Macro-fade shorts: n=7, hit 29%, −0.6R raw / −0.2R shrunk — insufficient sample, no rule yet." The survey of agentic trading notes that Reflexion-style loops assume prompt feedback, "in tension with trading settings where outcomes materialize only after meaningful market delay" [6] — so the loop must run on trade closes and weekly, not per session. And Huang et al. show LLMs cannot reliably self-correct without external feedback [30] — the ledger is that feedback.

**Anti-overfitting**

- **Shrinkage.** Hit rate `= (wins + s0) / (n + s0 + f0)` with `s0, f0` fit to the population of cells by method of moments: `s0 = μ(μ(1−μ)/σ² − 1)`, `f0 = s0 (1−μ)/μ` [60][61]. Practical prior: 20 pseudo-trades at the model's overall hit rate. Mean R: `R̂ = (n × mean_R + k × prior_R) / (n + k)`, `k = 20`, `prior_R = 0`.
- **Activation gates.** `n < 10`: hidden. `10–19`: "emerging," never phrased as a rule. `n ≥ 20` and shrunk expectancy sign stable across two weekly passes: "active." `n ≥ 50` and `|t| ≥ 2`: "strong." A lesson needs ≥5 `evidence_for` and `evidence_for ≥ 3 × evidence_against`.
- **Multiple comparisons.** 4 setups × 5 news categories × 3 regimes = 60 cells → ~3 false positives at α = 0.05 [43]. Require replication in a holdout half of the period before a cell becomes "strong."
- **Outcome embargo.** When retrieving past episodes, never expose outcomes not known at the decision time being evaluated (the survey's fix for the "oracle fallacy") [6]. Matters for replays and backfills.
- **Freeze regime labels at decision time** (e.g., SPY above/below 200-day × VIX bucket) and weight cards by recency (90-day half-life) while keeping the all-time table.

---

## 6. Competition and leaderboard between models

- **Shadow portfolios.** One account per model, built only from that model's own proposals, identical sizing rule (e.g., 0.5% of equity at risk per trade), identical simulator and starting equity; plus a *consensus* account (trade when ≥k of m agree) and the *coin-flip* account from §3.
- **Ranking.** Primary: shrunk expectancy (R) with `n ≥ 20`; secondary: Sharpe with a bootstrap confidence interval; always show n and t. Below the minimum, a model is "provisional." Chatbot Arena shows the pattern: models with fewer votes get visibly wider intervals [62].
- **Pairwise ratings.** When two models disagree on a trade idea (long vs short/skip), that is a match; the winner is the stance that would have earned more R over the idea's horizon. Fit **Bradley-Terry** by MLE on all matches — Chatbot Arena moved from online Elo to BT because model skill is static and BT gives properly calibrated intervals [62]; Glicko/TrueSkill add per-model uncertainty and converge faster than plain Elo [63]. Simple version: Elo with K=32 for a model's first 30 matches, K=16 after, refit BT weekly. Watch "The Leaderboard Illusion": models that opine on more trades get more precise, and possibly biased, ratings [64].
- **Calibration.** Each opinion carries `p(target before stop)`. Brier `= mean((p_i − y_i)²)`; reliability diagram in 5 bins; ECE [65][66]. Highlight the **confident-and-wrong quadrant**: `p ≥ 0.7` and loss — count and R cost. LLMs are systematically overconfident, with the gap widest in the 0.7–1.0 region [67]; the most accurate model is often not the best calibrated, and some score worse than a calibrated-random baseline [68]; against Kalshi outcomes, models stayed confident when wrong [69]. Tetlock's finding is the point: forecasters improve when they keep score on calibration and resolution [70].
- **Weekly MVP** = highest shrunk expectancy among models with ≥5 closes that week; **Most Improved** = largest 8-week gain in shrunk expectancy or Brier.
- **Does telling a model its rank change behavior?** Evidence is weak and mixed: EmotionPrompt-style stakes framing reports large gains, but a replication puts the average relative improvement at 2.6–4.4% [71]; "tipping" effects are inconsistent [72]; score-in-prompt studies mostly shift style (more direct, concise) [73]; and intrinsic self-correction fails without external feedback [30]. Prediction: the rank alone changes little; the *track-record numbers* may, because they are evidence. Keep standings prompt-visible anyway — cheap, honest, and the human learning is the real payoff. Alpha Arena is the cautionary example: six models, $10k each, identical prompts on Hyperliquid perps; Qwen3 Max returned +22.3% on ~43 trades while four models lost 31–63%; the leaderboard omitted drawdown and Sharpe [74]; a replication found leverage choice (Anthropic ~15x vs OpenAI 10x) and timing dominated asset selection, and only one pairwise difference was significant (p = 0.025) [75]. Rank on sized-controlled, risk-adjusted results with intervals, or you are ranking noise and leverage appetite.

---

## 7. Compact Postgres schema

Append-only for orders, fills, snapshots, and reviews (block UPDATE/DELETE with a trigger [76]); `positions` is a cache rebuildable from `fills`.

```sql
create table accounts (
  id            bigserial primary key,
  name          text not null,              -- 'consensus', 'model:gpt', 'coinflip'
  owner_model   text,                       -- null for consensus/baselines
  starting_cash numeric(18,2) not null,
  cash          numeric(18,2) not null,
  created_at    timestamptz not null default now()
);

create table jury_sessions (
  id           bigserial primary key,
  decided_at   timestamptz not null,        -- when the jury sat
  symbol       text not null,
  asset_class  text not null check (asset_class in ('equity','etf','crypto')),
  news_category text, regime text,          -- frozen at decision time
  context      jsonb not null               -- headlines, prices seen, checklist
);
create index on jury_sessions (decided_at desc);

create table agent_opinions (
  id          bigserial primary key,
  session_id  bigint not null references jury_sessions(id),
  model       text not null,
  stance      text not null check (stance in ('long','short','skip')),
  confidence  numeric(4,3) check (confidence between 0 and 1),
  thesis      text, invalidation text,
  proposed_stop numeric(18,6), proposed_target numeric(18,6),
  horizon_days int,
  unique (session_id, model)
);
create index on agent_opinions (model, session_id);

create table trade_ideas (
  id            bigserial primary key,
  session_id    bigint not null references jury_sessions(id),
  account_id    bigint not null references accounts(id),
  setup_template text not null,
  side          text not null check (side in ('long','short')),
  entry_plan numeric(18,6), stop_plan numeric(18,6) not null, target_plan numeric(18,6),
  r_initial     numeric(18,2),               -- |entry_fill - stop_plan| * qty, set on fill
  status        text not null default 'open'
                check (status in ('open','filled','closed','cancelled')),
  opened_at timestamptz, closed_at timestamptz,
  exit_reason   text check (exit_reason in
                ('target','stop','time','thesis_broke','discretionary','risk_override')),
  net_pnl numeric(18,2), r_multiple numeric(8,3),
  mae_r numeric(8,3), mfe_r numeric(8,3), ambiguous_bar boolean default false
);
create index on trade_ideas (account_id, status);
create index on trade_ideas (setup_template, closed_at);

create table orders (
  id          bigserial primary key,
  idea_id     bigint not null references trade_ideas(id),
  account_id  bigint not null references accounts(id),
  symbol      text not null,
  side        text not null check (side in ('buy','sell')),
  qty         numeric(18,8) not null,
  type        text not null check (type in ('market','limit','stop','moo')),
  limit_px numeric(18,6), stop_px numeric(18,6),
  submitted_at timestamptz not null,
  status      text not null default 'pending'
              check (status in ('pending','filled','cancelled','rejected'))
);
create index on orders (account_id, status, submitted_at);

create table fills (
  id          bigserial primary key,
  order_id    bigint not null references orders(id),
  filled_at   timestamptz not null,         -- must be > orders.submitted_at
  session_date date not null,
  qty         numeric(18,8) not null,
  price       numeric(18,6) not null,       -- after spread + slippage
  reference_px numeric(18,6) not null,      -- open/quote used
  slippage_bps numeric(8,2) not null,
  fees        numeric(18,4) not null default 0,
  fill_rule   text not null                 -- 'next_open','next_bar','gap_stop',...
);
create index on fills (order_id);
create index on fills (session_date);

create table positions (
  account_id bigint not null references accounts(id),
  symbol     text not null,
  qty        numeric(18,8) not null,        -- signed
  avg_cost   numeric(18,6) not null,
  realized_pnl numeric(18,2) not null default 0,
  updated_at timestamptz not null,
  primary key (account_id, symbol)
);

create table equity_snapshots (
  account_id   bigint not null references accounts(id),
  session_date date not null,
  marked_at    timestamptz not null,
  cash numeric(18,2) not null, market_value numeric(18,2) not null,
  equity numeric(18,2) not null, daily_pnl numeric(18,2) not null,
  gross_exposure numeric(6,3),
  primary key (account_id, session_date)
);

create table trade_reviews (
  id            bigserial primary key,
  idea_id       bigint not null references trade_ideas(id) unique,
  reviewer_model text not null,
  thesis_right boolean, timing_right boolean, sizing_right boolean, rules_followed boolean,
  process_grade char(1) check (process_grade in ('A','B','C','D','F')),
  quadrant      text check (quadrant in ('earned','bad_luck','dumb_luck','deserved')),
  mistakes      text[] not null default '{}',
  mistake_cost_r numeric(8,3),
  notes         text,
  created_at    timestamptz not null default now()
);

create table lessons (
  id             bigserial primary key,
  scope          jsonb not null,            -- {"setup":"earnings_drift","regime":"risk_on"}
  rule_text      text not null,
  evidence_for   int not null default 0,
  evidence_against int not null default 0,
  n_trades int, shrunk_expectancy_r numeric(8,3), t_stat numeric(8,3),
  status         text not null default 'hidden'
                 check (status in ('hidden','emerging','active','strong','retired')),
  updated_at     timestamptz not null default now()
);
create index on lessons using gin (scope);

create table model_ratings (
  model         text not null,
  as_of         date not null,
  n_closed int, expectancy_r numeric(8,3), shrunk_expectancy_r numeric(8,3),
  sharpe_daily numeric(8,3), brier numeric(6,4), confident_wrong_n int,
  elo numeric(8,2), bt_score numeric(8,3), ci_low numeric(8,3), ci_high numeric(8,3),
  primary key (model, as_of)
);
```

Indexes cover the hot paths: open orders per account, closed ideas by setup and date, fills by session for marking, snapshots by account/date for the equity curve, and a GIN index on lesson scope for card assembly. A materialized view `cell_stats(model, setup_template, news_category, regime)` computed weekly feeds both `lessons` and `model_ratings`.

---

## Sources

1. Nautilus Trader issue: next-bar-open execution — https://github.com/nautechsystems/nautilus_trader/issues/4063
2. StratBase, "Look-Ahead Bias: The Hidden Backtest Killer" — https://stratbase.ai/en/blog/look-ahead-bias-hidden-killer
3. Backtrader docs, Cheat-On-Open — https://www.backtrader.com/docu/cerebro/cheat-on-open/cheat-on-open/
4. QuantConnect, Equity fill model — https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/trade-fills/supported-models/equity-model
5. Yao & Zheng, "Beyond Agent Architecture: Execution Assumptions and Reproducibility in LLM-Based Trading Systems" — https://arxiv.org/html/2606.08285
6. "Agentic Trading: When LLM Agents Meet Financial Markets" (survey) — https://arxiv.org/html/2605.19337v1
7. ETF.com, ETFs with the highest and lowest spreads — https://www.etf.com/sections/news/etfs-highest-lowest-trading-spreads
8. Equicurious, Bid-ask spreads and liquidity in US equities — https://equicurious.com/learn/investing-basics/market-mechanics/bid-ask-spreads-and-liquidity-in-us-equities
9. Zipline slippage module — https://zipline.ml4trading.io/_modules/zipline/finance/slippage.html
10. QuantConnect, Slippage models — https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/slippage/supported-models
11. Kaiko, A cheatsheet for bid-ask spreads — https://www.kaiko.com/resources/a-cheatsheet-for-bid-ask-spreads
12. FINRA Information Notice 3/17/26, Section 31 rate — https://www.finra.org/rules-guidance/notices/information-notice-20260317
13. Federal Register, FY2026 Section 31 fee-rate order — https://www.federalregister.gov/documents/2026/03/04/2026-04233/order-making-fiscal-year-2026-annual-adjustments-to-transaction-fee-rates
14. FINRA By-Laws Schedule A §1 (TAF) — https://www.finra.org/rules-guidance/rulebooks/corporate-organization/section-1-member-regulatory-fees
15. Coinbase Advanced vs Kraken fee comparison — https://traderssecondbrain.com/guides/coinbase-advanced-vs-kraken
16. CoinLaw, Crypto exchange fees compared 2026 — https://coinlaw.io/crypto-exchange-fees/
17. Schwab, Market, limit and stop orders — https://www.schwab.com/learn/story/3-order-types-market-limit-and-stop-orders
18. Optimus Futures, Managing orders around gaps — https://learn.optimusfutures.com/gap-trading-orders
19. Alpaca, Paper trading docs — https://docs.alpaca.markets/us/docs/paper-trading
20. IBKR Campus, Paper vs live trading — https://www.interactivebrokers.com/campus/trading-lessons/paper-trading-vs-live-trading-whats-the-difference/
21. Claeys, "When Backtests Guess: How Trading Platforms Silently Fabricate Results" (SSRN) — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6240638
22. TradingView, Bar Magnifier — https://br.tradingview.com/support/solutions/43000669285/
23. NYSE, Holidays & trading hours — https://www.nyse.com/trade/hours-calendars
24. ICE press release, NYSE 2024–2026 holiday calendar — https://ir.theice.com/press/news-details/2023/NYSE-Group-Announces-2024-2025-and-2026-Holiday-and-Early-Closings-Calendar/default.aspx
25. pandas_market_calendars — https://github.com/rsheftel/pandas_market_calendars
26. Crypto-market eval conventions (00:00 UTC, √365) — https://github.com/terrylica/cc-skills/blob/main/plugins/quant-research/skills/opendeviation-eval-metrics/references/crypto-markets.md
27. KuCoin, Calculating unrealized and realized PnL — https://www.kucoin.com/support/26695061760793
28. Coincall, Profit and loss (PnL) — https://support.coincall.com/hc/en-us/articles/17206588685849-Profit-and-loss-PnL
29. JournalPlus, R-multiple definition — https://journalplus.co/learn/glossary/r-multiple/
30. Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet" — https://arxiv.org/abs/2310.01798
30-a. TradeZella, Understanding R and R-multiple — https://www.tradezella.com/blog/understanding-r-and-r-multiple
31. QuantifiedStrategies, MAE and MFE explained — https://www.quantifiedstrategies.com/maximum-adverse-excursion-and-maximum-favorable-excursion/
32. Tradervue, MFE and MAE calculations — https://help.tradervue.com/article/3440-mfe-and-mae-calculations
33. JournalPlus, Payoff ratio — https://journalplus.co/learn/glossary/payoff-ratio/
34. JournalPlus, Profit factor — https://journalplus.co/metrics/profit-factor/
35. PineConnector, Trading expectancy — https://www.pineconnector.com/blogs/pico-blog/expectancy-a-key-metric-for-evaluating-trading-strategies
36. Quantt, Risk-adjusted returns guide (Sharpe, Calmar, MDD) — https://www.quantt.co.uk/resources/risk-adjusted-returns-guide
37. MetricGate, Sortino ratio — https://metricgate.com/docs/sortino-ratio/
38. RCM Alternatives, Drawdown depth and duration — https://www.rcmalternatives.com/2013/10/the-2-important-drawdown-measurements-how-deep-how-long/
39. backtesting.py, Quick Start (stats incl. Exposure Time) — https://kernc.github.io/backtesting.py/doc/examples/Quick%20Start%20User%20Guide.html
40. Lo (2002), "The Statistics of Sharpe Ratios," FAJ — https://rpc.cfainstitute.org/research/financial-analysts-journal/2002/the-statistics-of-sharpe-ratios
41. BuildAlpha, Monte Carlo permutation test — https://www.buildalpha.com/monte-carlo-permutation/
42. Susan Potter, Monte Carlo permutation tests for strategy significance — https://www.susanpotter.net/quant/monte-carlo-permutation-tests-strategy-significance/
43. MQL5, Hypothesis testing for trading strategies — https://www.mql5.com/en/articles/23742
44. "How Many Trades Are Enough?" — https://medium.com/@trading.dude/how-many-trades-are-enough-a-guide-to-statistical-significance-in-backtesting-093c2eac6f05
45. JournalPlus, System Quality Number — https://journalplus.co/metrics/system-quality-number/
46. Portfolio Optimizer, Probabilistic Sharpe Ratio and MinTRL — https://portfoliooptimizer.io/blog/the-probabilistic-sharpe-ratio-bias-adjustment-confidence-intervals-hypothesis-testing-and-minimum-track-record-length/
47. Bailey & López de Prado, "The Deflated Sharpe Ratio" — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551
48. Steenbarger, TraderFeed: Keeping a trading journal — http://traderfeed.blogspot.com/2019/05/trading-psychology-techniques-1-keeping.html
49. Van Tharp Institute, Traders and mistakes — https://vantharpinstitute.com/traders-and-mistakes/
50. JournalPlus, Stock journal template (thesis/invalidation) — https://journalplus.co/learn/guides/trading-journal-for-stocks/
51. Edgewonk, Features — https://edgewonk.com/features
52. Satyajit Rout on Annie Duke's "resulting" and the 2x2 — https://satyajit-rout.medium.com/when-the-outcome-tail-wags-the-decision-dog-b46c06ef04cd
53. Tunguz, Separating outcome quality and decision quality — https://tomtunguz.com/outcome-quality-decision-quality/
54. LuxAlgo, Edgewonk journal analysis (Tiltmeter, mistake categories) — https://www.luxalgo.com/blog/edgewonk-journal-tool-analysis/
55. Trade That Swing, Takeaways from "Trading in the Zone" — https://tradethatswing.com/key-takeaways-from-trading-in-the-zone-by-mark-douglas/
56. Tradervue, Trade reports — https://help.tradervue.com/category/3410-trade-reports
57. Zhao et al., "ExpeL: LLM Agents Are Experiential Learners" — https://arxiv.org/abs/2308.10144
58. Shinn et al., "Reflexion: Language Agents with Verbal Reinforcement Learning" — https://arxiv.org/abs/2303.11366
59. "TradingGroup: A Multi-Agent Trading System with Self-Reflection and Data-Synthesis" — https://arxiv.org/html/2508.17565
60. Kiwidamien, Shrinkage and empirical Bayes — https://kiwidamien.github.io/shrinkage-and-empirical-bayes-to-improve-inference.html
61. Robinson, Empirical Bayes estimation with baseball statistics — http://varianceexplained.org/r/empirical_bayes_baseball/
62. LMSYS, Chatbot Arena Elo → Bradley-Terry update — https://www.lmsys.org/blog/2023-12-07-leaderboard/
63. Tom Rocks Maths, Elo and Glicko rating systems — https://tomrocksmaths.com/2021/07/16/elo-and-glicko-standardised-rating-systems/
64. "The Leaderboard Illusion" — https://arxiv.org/pdf/2504.20879
65. Emergent Mind, Brier score: calibration, resolution, uncertainty — https://www.emergentmind.com/topics/brier-score-term
66. Metaculus FAQ (calibration curves) — https://www.metaculus.com/faq/
67. "Mind the Confidence Gap: Overconfidence, Calibration, and Distractor Effects in LLMs" — https://arxiv.org/pdf/2502.11028
68. "ConfidenceBench: Evaluating Confidence Calibration in LLMs" — https://arxiv.org/html/2607.20526
69. "KalshiBench: Evaluating Epistemic Calibration via Prediction Markets" — https://arxiv.org/pdf/2512.16030
70. Long Now / Brand, "All it takes to improve forecasting is keep score" (Tetlock) — https://medium.com/the-long-now-foundation/all-it-takes-to-improve-forecasting-is-keep-score-289888d4d76c
71. "A Looming Replication Crisis in Evaluating Behavior in Language Models?" — https://arxiv.org/pdf/2409.20303
72. IntuitionLabs, High-stakes emotional prompts (EmotionPrompt, tipping) — https://intuitionlabs.ai/articles/llm-performance-high-stakes-emotional-prompts
73. Score-based prompting for feedback generation (ScienceDirect) — https://www.sciencedirect.com/science/article/pii/S0360131525002799
74. iWeaver, Alpha Arena Season 1 results — https://www.iweaver.ai/blog/alpha-arena-ai-trading-season-1-results/
75. Eug-Chua, Alpha Arena replication — https://github.com/Eug-Chua/llm_trading_arena
76. Deocleciano, Implementing a ledger in Postgres (append-only triggers) — https://renandeocleciano.medium.com/como-implementar-um-ledger-corretamente-em-postgres-schema-real-queries-imutabilidade-e-escala-4059b8a1667a
