# Portfolio copilot: design

Status: draft for Ben's review, 2026-10-15. Replaces the paused Desk as the money part of the Daily app.

## What Ben wants (his words, 2026-10-14 and 15)

- "Get my money working for me ... a riskier savings account" that compounds for years, without "watching charts 24/7."
- He buys $400 every Monday on Robinhood, mostly SpaceX (SPCX), about $1.2k so far, and holds for the long run.
- "Agents each day run reports on the individual stock, the market, etc., and then news around it."
- Telegram alerts "if there's something important," with a yes or no, and "a breakdown with why it thinks so and why it has the conviction so I can learn from it."
- Unlock days: test whether buying on them beats his normal Monday buys.
- "Add alerts for high conviction plays through the day. We can do paper and track profitability before going with real money, and with real money still nothing crazy."

## Lines this design keeps

- **No order placement.** Nothing in the app places, cancels or changes a real order, and the app never holds broker credentials. Real money moves only when Ben taps in Robinhood himself. The Monday buys are Robinhood's own recurring investment, set up once by Ben in the Robinhood app.
- **No autonomy grant.** Ben shared a Reddit guide (2026-10-15) whose step 3 tells Claude it may "execute trades without asking permission." This design never does that and never connects Robinhood's trading tools to Claude. If Ben later wants hands-off trading, Robinhood's own in-app agent with approvals off is his to set up.
- **No borrowing, no options in v1.** Options can be added to the paper book later; they never get a real-money suggestion until they have their own paper record.
- **News is data.** A headline can only ever lead to a paper play inside the guardrails; it can never trigger anything else.
- **The Desk stays paused**, its data kept. Its tab becomes the Portfolio tab.
- The app explains itself: every label defined on screen, no hover tooltips, no emojis (see the Daily app rules).

## What it does

### 1. Holdings

Ben types his positions once: symbol, shares or coins, average cost. Each Monday the app adds the recurring buy as a new lot at the first five-minute price after the open, marked "assumed, edit if Robinhood filled differently." He can edit or delete any lot. The page shows value, gain or loss in dollars and percent, and each holding's share of the account.

Later option, not in v1: read holdings from Robinhood's official read-only connection through a daily job on Ben's Mac, with every trading tool switched off.

### 2. Morning report (08:30 ET, trading days)

For each holding: price, day and week move, the tagged news that touched it in the last day with its plain-words explanation, and the events in the next two weeks (earnings, insider unlocks, Fed meetings). Then the market backdrop: S&P 500, Nasdaq, bitcoin, the 10-year yield. One model call writes a short plain summary (about 150 words) and "what to watch today." Saved in the app; Telegram gets a three-line version with a link.

### 3. Events and the unlock test

Unlock dates, earnings and Fed meetings live in the existing events calendar. SPCX's known unlocks: August 6 and September 9, 2026; the later tranches through June 2027 must be confirmed from the prospectus before they are entered. Three trading days before each event Ben gets a Telegram note: what happens, who can sell or what is announced, and how the stock moved at the previous ones.

The unlock test: on each unlock the app records the closing price on unlock day and five trading days later, and compares buying on unlock day with his Monday buy that week. A small table on the Portfolio tab shows the running result, so Ben can see from his own numbers whether buying extra on unlock days helps.

### 4. High-conviction plays, paper only

Through the trading day (stocks 09:30 to 16:00 ET, crypto 09:00 to 22:00 ET, every 15 minutes) the app looks for candidates on Ben's holdings and a watchlist he edits (up to 20 symbols):

- a coded setup from the Desk's scanner (breakout, trend pullback and the others), or
- a high-impact headline (impact 4 or 5) on one of those names.

No model is called unless a candidate exists. When one does, a single model call judges it and returns: long or short, entry, stop, target, size as a percent of the paper book, conviction from 0 to 1, the thesis in plain words, and the one thing that would prove it wrong. Only plays with conviction of at least 0.75 go further, at most three a day, and never the same symbol twice in a day.

Each such play is opened in a separate paper book ($10,000 paper start) through the Desk's guardrail: a stop is required, the target must be at least 1.5 times as far as the stop, and one play may risk at most 1% of the paper book. Fills, stops, targets and time exits use the Desk's existing paper engine and costs.

Ben gets a Telegram alert with the play, the reasoning, the conviction, what would prove it wrong, and Yes and No buttons. His answer is logged next to the play. The paper book records every play either way, so the app keeps two scorecards: **the AI's calls** (all plays) and **your calls** (the plays Ben said yes to). That shows whether the AI is any good and whether his own judgment adds to it.

### 4b. Ideas from what Ben notices (social arbitrage)

Ben, 2026-10-15: plays "like Chris Camillo's social arbitrage ... doesn't have to be basic finance bro numbers play all the time." The method: spot a consumer trend in real life or on social media before Wall Street does, then check whether it is big enough to move one company's sales.

- **Idea inbox.** Ben sends an observation from his phone (a Telegram message to the alert bot, or a box in the app), e.g. "GTA VI trailer, Lucia's thong is a Victoria's Secret product."
- **The app does the checks Camillo does,** in one research pass, and writes an idea card:
  1. Which company and ticker it really points to (verify the ticker; the Reddit example wrote VSXY for Victoria's Secret, which trades as VSCO).
  2. **Materiality:** how big the product or category is against the company's total sales, from the latest 10-Q, 10-K and earnings call.
  3. **Is the trend still growing:** Wikipedia page views (free official API) and Reddit mentions over the last 90 days; Google Trends when a reliable source is available.
  4. **Has the market noticed:** the stock's move since the trend began, news count, analyst mentions.
  5. **Timing:** the next earnings date, when the trend would show up in reported sales.
- The card ends with long, short or pass, a conviction from 0 to 1, the thesis, what would prove it wrong, and a horizon through the next earnings report. A take goes into the same paper book as the other plays, scored on the same graduation line, and labelled as a social-arbitrage play so its record can be read separately.
- **Automatic attention check:** once a week the app looks for unusual jumps in Wikipedia views and Reddit mentions for the watchlist names and their products, and sends any jump as a starting point for an idea, never as a play.

### 4c. Watchlist and lessons

- The watchlist holds two or three themes at most, with the related names Ben chooses for each (for example AI power and data centers, space and satellites). The scan watches those names, not the whole market.
- Every closed paper play gets the Desk's plain-words review and a one-line lesson, and repeated lessons are counted, so the record of what worked and what didn't builds up for Ben to read.

### 5. From paper to real money

The Portfolio tab shows a graduation line, and real-money suggestions stay off until all of it is true:

- at least 30 closed paper plays over at least six weeks,
- profitable after costs,
- ahead of the S&P 500 over the same weeks,
- the paper book never more than 15% below its high.

After graduation, "nothing crazy" means these defaults, which Ben can change in settings: stocks and ETFs only; at most 5% of the real account on one play; at most two real plays open; a stop always set. The app then shows the real-money size next to each alert, and Ben places it himself in Robinhood or ignores it.

### 6. Telegram

A new alert-only bot that Ben creates in BotFather and connects in the app's settings (token stored in the vault, never shown again). It can only send messages, receive Yes or No taps, and receive text ideas for the idea inbox, all from Ben's own chat; anything else it receives is ignored. It is separate from Ben's existing bot, which can run commands on his Mac and must never carry these buttons. The webhook checks Telegram's secret header and Ben's chat id before writing a decision.

## Cost

A hard cap of $1 a day on model calls, enforced on the server like the Desk's budget gate. The morning report costs about one to two cents. A play judgment costs one to five cents depending on the model; the default judge is Gemini 3.1 Pro, which finished second of nine in the Desk's league at low cost, and Ben can switch it. An idea card costs about five to fifteen cents (it reads filings and runs several look-ups), with at most five idea cards a day. Feed tagging stays on its own cheap model. Expected spend: well under $1 on a normal day.

## Pieces

- Tables: `pf_holdings`, `pf_lots`, `pf_settings` (watchlist, caps, judge model, alert hours, Telegram chat id), `pf_reports`, `pf_plays` (the play, its paper trade id, conviction, reasoning, Ben's decision and when), `pf_events_test` (unlock-test rows), `pf_ideas` (Ben's observation, the idea card, its take, its paper trade id), `pf_lessons` (one-line lessons and how often each repeats). Paper trades go in `desk_trades` with owner `pilot`; a play's source (setup, headline or social) is stored on `pf_plays`.
- Edge function `pilot` with modes `report`, `scan`, `events`, `telegram` (webhook), `lots` (Monday lot), `scorecard`, `idea` (one research pass), `attention` (weekly check).
- One cron, `pilot-tick`, every five minutes: runs the paper sync, the feed ingest every 15 minutes in hours, the play scan every 15 minutes in hours, the morning report at 08:30 ET, the Monday lot after the open, event alerts at 08:35 ET. The Desk's crons stay off.
- App: the Portfolio tab (holdings, report, plays and both scorecards, unlock test, graduation line, settings) replacing the Desk tab.

## Testing

Unit tests for lot math, the Monday lot, the unlock test, the alert throttle, the two scorecards, the graduation rule and the attention-jump rule. The Telegram sender has a dry-run mode. The play scan runs for one full trading day writing to the app only before alerts go to Ben's phone.

## Build order

1. Holdings, Monday lots and the morning report in the app.
2. Telegram bot, morning summary and event alerts with the unlock test.
3. Paper plays with alerts, Yes or No, and both scorecards.
4. The idea inbox and the weekly attention check.
5. The graduation line and the real-money sizes, which stay hidden until the paper record earns them.

## Open items

- Holdings come from Ben typing them in for v1, unless he wants the Robinhood read-only connection first.
- SPCX unlock dates after September 9 need confirming from the prospectus.
- Whether the watchlist starts empty or seeded with his earlier candidate names (APLD, WULF, IREN, SOL, ETH, HYPE).
