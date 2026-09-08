# The Desk, phase 5: always on

**Status:** approved in direction by Ben on 2026-09-08 ("a jury before each trade; multiple trades placed and sold each day; a mix of strategies with different holding times; high risk; perps; regular trades; longer trades; short attention-based trades; $100k"). Defaults below that Ben did not decide explicitly are marked *assumed*.

**Supersedes** the nightly-only loop of `2026-09-07-desk-design.md` §5. Everything else in that spec (ledger rules, ratings, lessons, the app must explain itself, paper only, no broker keys) still holds.

## 1. What changes

| Before (phase 1–4) | Now |
|---|---|
| One nightly debate on the briefing | A news **feed** every 15 minutes, a technical **scan** every 15 minutes, a mini-jury **sit** before every trade, plus the nightly full debate |
| News is the only source of ideas | Two engines: news (feed + briefing) and **technicals** (eight coded strategies across three timeframes) |
| At most two new trades a night | No cap on trades; several a day is the intent |
| Holds of days | **Scalp** (hours, or to the close), **swing** (days), **position** (weeks) |
| Fills at next open / next hourly candle | Next **5-minute** bar (stocks in session, crypto always); otherwise the open |
| Aggressive preset | **No-limits** preset by default: leverage to the venue maximum, 20 open positions, gross to 1000%, no daily halt. Three rules stay (§6) |
| Models are the only competitors | Strategies get their own shadow books and records; the ones that earn it size up |

## 2. Timeframes

| Timeframe | Hold | Bars | Exit |
|---|---|---|---|
| scalp | up to 8 hours (crypto) or the session close (stocks) | 5m, 15m, 1h | stop, target, or time; stocks flat by 15:55 ET |
| swing | 1–10 days | 1h, 1d | stop, target, or time stop in days |
| position | 2–8 weeks | 1d, weekly | stop, target, or weekly-trend break |

Every setup, sit, trade and record carries a timeframe. The League and the coach break results down by it.

## 3. Universe and data

- **Stocks and ETFs (Robinhood):** a watchlist table seeded with the S&P 100, the 30 largest Nasdaq-100 names, sector ETFs (XLE XLF XLK XLV XLU XLP XLY XLI XLB XLRE XLC SMH), index ETFs (SPY QQQ IWM DIA), macro ETFs (TLT GLD USO UUP), crypto ETFs (IBIT ETHA), plus any ticker the feed tagged with impact ≥ 3 in the last 48 hours. Cap 200. Daily bars come from the `desk_bars` cache; 5-minute bars are fetched only for candidates.
- **Perps (BloFin):** the top 40 USDT perps by 24-hour volume, refreshed hourly, plus any coin the feed mentions. Bars: 5m (25 hours), 1H (12 days), 4H (50 days), 1D (400 days). The tape function gains `bar` values 5m, 15m, 4H.
- **Feeds (verified reachable from Supabase on 2026-09-08):** CNBC top/finance/economy, MarketWatch top stories and MarketPulse, Yahoo Finance news, CoinDesk, Cointelegraph, The Block, Decrypt, Google News (Reuters markets query, Business section), Federal Reserve press releases, PR Newswire financial, WSJ Markets, Investing.com stock news, Seeking Alpha breaking news. SEC EDGAR needs a declared user agent (later).

## 4. The feed (`desk-feed`, every 15 minutes)

1. Fetch every source in parallel (8-wide, 10s timeout each). Parse RSS 2.0 and Atom with a small regex parser: title, link, published, source, summary (tags stripped, ≤ 300 chars).
2. Dedupe by normalised link (tracking parameters removed) and by a title hash within 24 hours.
3. Tag the new items (≤ 80 per run) in one strict-JSON call to `deepseek/deepseek-v4-flash-0731` (fallback `google/gemini-3.5-flash-lite`): tickers (uppercase, ≤ 4), venue (stock | crypto | macro | none), category (macro | earnings | guidance | deal | regulation | geopolitics | crypto | company | other), impact 1–5, direction (bullish | bearish | mixed | none), horizon (scalp | swing | position | none), and `why` in ≤ 25 words. Cost ≈ $0.002 per run.
4. Insert into `desk_news`. Items with impact ≥ 4 and at least one tradable ticker become **news triggers** for the scan.
5. Retention 30 days. The nightly packet reads the last 24 hours of the feed (top by impact) next to the briefing.

## 5. The scan (`desk-scan`, every 15 minutes) and the eight strategies

Pure code, no model. For every symbol in the universe it computes: SMA 20/50/200, EMA 9/20/21/55, RSI 14 and RSI 2, ATR 14 (daily, 4H, 5m), 20-day high/low, volume ratio vs the 20-day average, distance from the 52-week high/low, weekly trend (10-week vs 40-week average from daily bars), monthly momentum (12-1 return), relative strength vs SPY over 20 days, the opening range (first 30 minutes), intraday move in ATRs, and for perps the funding rate and 4H trend. A correlation panel (30-day, daily returns: BTC ETH SOL SPY QQQ GLD TLT) gives the risk-on/off read.

Each strategy is a function that returns a **setup card** or nothing:

| id | Timeframe | Rule (long; shorts mirrored where the venue allows) | Stop / target | Why it might work |
|---|---|---|---|---|
| trend-pullback | swing | close > SMA50 > SMA200 with SMA50 rising, weekly trend up, close within 1 ATR of EMA20, RSI14 35–55, today closed up | stop below the 3-day low − 0.5 ATR; target 2R or the 20-day high | trends persist; buying the dip in a trend puts the stop where the trend is wrong |
| breakout | swing | new 20-day closing high, volume ≥ 1.5× average, not extended (close − SMA20 < 3 ATR), weekly trend up | stop = breakout level − 1 ATR; target 2.5R | post-breakout drift; volume shows real demand |
| rsi2-reversion | swing (1–5 days) | close > SMA200 and RSI2 < 10 | stop 2 ATR below; target 1.5R; time stop 5 days | short-term overreaction inside a long-term trend snaps back |
| crypto-momentum | swing (72 h) | perp: 4H EMA21 > EMA55, daily close > SMA20 > SMA50, top-40 volume, funding between −0.05% and +0.05%, 1H pullback to EMA21 | stop below the 12-bar 4H swing low − 0.5 ATR(4H); target 2R; 3–5× | trend plus a calm funding rate means the move is not crowded |
| attention-spike | scalp | a feed headline on the symbol in the last 2 hours with impact ≥ 4, 30-minute volume ≥ 3× normal, intraday move ≥ 1.5 daily ATR | stop beyond the spike bar ± 1 ATR(5m×12); target 1.5R; time stop 6h (crypto) or the close | attention brings flow for hours; quantitative news drifts, qualitative news fades (the jury picks the side) |
| opening-range-break | scalp (stocks) | after 10:00 ET, price breaks the first-30-minute high with volume ≥ 1.5× and the daily trend up | stop = range midpoint; target 2R; flat at the close | the first half hour sets the day's auction; a break with volume tends to run |
| funding-extreme-fade | swing (72 h, perps) | funding ≥ +0.10%/8h with price at a 20-day high → short; ≤ −0.10% → long | stop 1.5 ATR(1D); target 2R | extreme funding means one side is crowded and paying to stay in |
| weekly-trend-position | position | 12-1 momentum in the top decile of the universe, weekly trend up, price above the 10-week average | stop = 10-week average − 2.5 daily ATR; target 3R; horizon 40 days | momentum persists over months; the weekly average is the trend's own stop |

A setup card is `{strategy, symbol, venue, instrument, side, timeframe, entry_ref, stop, target, leverage_hint, horizon (hours or days), score, reasons[], invalidation}` where `reasons` are the checks with their numbers (`"RSI14 = 42, in the 35–55 pullback zone"`) and `score` is the count of secondary confirmations (weekly trend agrees, relative strength positive, volume above average, news direction agrees, risk-on for crypto) divided by their number. Setups dedupe: none for a symbol that is open or pending, none for a symbol whose last sit was under 4 hours ago (*assumed cooldown*).

**Strategy shadow books.** Every setup a strategy produces is also traded by that strategy's own shadow book (`owner = strat:<id>`, $100k, code, no jury). That is how the app learns whether the raw rule works, and whether the jury adds anything on top of it. The desk's own book never trades without a jury.

## 6. Sits: a jury before every trade

- **Trigger:** a setup with score ≥ 0.5 (*assumed*), or a news trigger (the scan wraps it in an attention-spike or ATR-based card so the jury has levels).
- **Jurors:** three fast models, default `google/gemini-3.8-flash`, `openai/gpt-5.6-luna`, `deepseek/deepseek-v4-flash-0731` (three labs, ≈ 1 cent a sit). Configurable.
- **Brief:** the setup card with the strategy's one-paragraph explanation, the multi-timeframe tape card, the correlation/regime line, the symbol's headlines from the last 24 hours and the top five macro headlines, the book, the rules.
- **Ballot schema:** `{stance: take | pass, confidence 0–1, side, stop, target, leverage, thesis ≤ 60 words, what_would_prove_me_wrong, tags[]}`.
- **Tally:** the existing weighted tally; a trade needs support ≥ half the total weight and at least two voters. Levels: the card's, unless two jurors agree on tighter ones (median). No judge on sits.
- **Then code:** guardrail, sizing, insert into `desk_trades` with `source = 'sit'`, `strategy`, `timeframe`, `sit_id`. Ballots are stored as opinions (round `sit`) and scored later for Brier and Elo like any other vote.
- **Caps** (*assumed, all editable*): daily sit budget $3, max open positions from the preset, per-symbol cooldown 4 hours, one sit per setup.
- **Mechanism:** the same launch-and-collect as the nightly session (§8 of the phase-1 spec, as amended on 2026-09-08 for the 150-second gateway limit). Each sit launches three child invocations; the next 5-minute tick collects and trades. Entry latency ≤ 5 minutes plus the next 5-minute bar.
- The nightly full session (7 jurors + judge) stays, now with the day's feed and the position-timeframe setups in its packet.

**The three rules that stay under "no limits":** every trade has a stop (R-multiples and calibration need it); a perp's stop sits inside its liquidation price (the guardrail cuts leverage until it does); one position per symbol at a time (so the ledger can attribute). Everything else is a knob: risk per trade (default 5%, up to 10%), leverage (venue max), open positions (20), gross exposure (1000%), sits per day (budget), trades per day (none).

## 7. Ledger changes

- `desk_trades` gains `source` (nightly | sit | shadow), `strategy`, `timeframe`, `sit_id`, `horizon_hours`, `size_mult`.
- Fills: next 5-minute bar open after the decision, with slippage as before; stocks outside the session fill at the first 5-minute bar of the next session. Crypto exits scan 5-minute BloFin candles (1H fallback when a gap exceeds a day).
- Scalps expire by hours (crypto) or at the 15:55 ET bar (stocks). Position trades also close when the weekly trend flips against them (checked by the scan).
- Presets: `aggressive` and `very_aggressive` open up (10 open, gross 500%, no per-night cap); new `no_limits` (risk 5%, notional 300%, 20 open, gross 1000%, leverage 100 = venue max, no daily halt, no heat cap, min R:R 1.2, min stop 0.3 ATR, liq buffer 0.1). Ben's account moves to `no_limits`.
- **Size by record:** each strategy has `size_mult` (0.5–1.5). After 20 closed trades: shrunk mean R > 0.2 → 1.25, > 0.5 → 1.5; < −0.2 → 0.5; a strategy under −0.5 after 30 trades is benched (still runs its shadow book, no sits) until the coach re-enables it. Jurors' vote weights as before.

## 8. Ratings, lessons, coach

- Settle scores sit ballots: `take` is scored on the trade's outcome, `pass` on its inverse; Elo matches pair take-vs-pass jurors on the same sit.
- Strategy records: n, hit rate, shrunk R, profit factor, by timeframe and instrument, with the existing too-few / emerging / rule / strong labels.
- The coach card adds sections per strategy and per timeframe, names what to promote or bench, and the promotion logic in §7 applies its numbers.
- Post-mortems know the strategy; lesson scope gains `strategy`.

## 9. The app

Tabs: **Now** (open positions at live prices, today's trades, sits in flight, the next tick, halts), **Feed** (the stream with impact dots and ticker chips; filters: acted on, high impact, stocks, crypto), **Debates** (sits and nightly sessions by day; a sit shows the card, three ballots, tally, outcome), **Book**, **League** (jurors and strategies, by timeframe), **Learn** (each strategy's rules, why it might work, when it fails, its record and promotion state; the playbook; lessons; the coach card). Settings add: sit roster, preset incl. no-limits, risk %, daily sit budget, max open, cooldown, extra tickers, strategy toggles. The Card chip stays.

## 10. Cron

| Job | Schedule | Does |
|---|---|---|
| desk-tick | every 5 min | sync fills/exits/funding/marks; collect finished sits and place trades; every 15 minutes launch `desk-feed` and `desk-scan` (children, so no call runs long) |
| desk-run | 01:30–02:55 UTC ladder | the nightly full session (unchanged) |
| desk-coach | Monday 00:00 UTC | the weekly card |

## 11. Cost (defaults)

Feed ≈ $0.20/day, scan free, sits ≈ $0.10–0.40/day at 10–40 sits, nightly ≈ $0.25. About $25 a month; the sit budget is the knob.

## 12. Rollout

A. Ledger and rules (5-minute fills, hour horizons, presets, new tables, the tick cron). B. Feed and the Feed tab. C. Scan, strategies, shadow books, Learn tab. D. Sits, Now and Debates tabs. E. Ratings, coach, promotion, nightly packet reads the feed.
