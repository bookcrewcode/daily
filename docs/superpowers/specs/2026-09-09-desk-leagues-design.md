# The Desk, phase 7: the leagues

Ben, 2026-09-09: "Let's just remove the now thing. Let's just focus on the league and optimizing the league. Keep the news feed. The league should include more models in each one, combinations of models working together, perform or die, you die out if you go down more than five percent, promoted based on who's in the lead percent-wise, after two weeks whatever league is in the lead is the one we'll move forward with. In Learn I want to learn from every decision each league makes, all their trades and reasons why they didn't take a trade, closed a trade etc. Add in the TradingView charts. Each league should have a frontier and workers behind it; make the leagues as even as possible; an oligarchy structure: the agents can vote to kick off any models they think aren't performing and add a new model from the sideline. A new league can't be the same combination of models." Then: "3 leagues of 3. 1 frontier, barely does any brute work, 4 workers per team. Diamond, Gold, Bronze are the three leagues, performance based. After 1 day the worst team in the Bronze league gets replaced by a different combo of models."

## Shape

- **Team** = one frontier model + four worker models, a $100,000 paper book, a name (`<frontier short name> <roman numeral>`), a tier. Nine teams live at all times: three in Diamond, three in Gold, three in Bronze.
- **Workers do the brute work.** Every candidate (a scan setup, or a session idea) goes to every live team. The four workers each read the brief, may look twice (bars at another interval, funding, a news search, the strategy's record), and vote take or pass with a confidence, a thesis, a "wrong if", tightened levels. About a third of a cent each.
- **The frontier decides.** If at least one worker says take, the frontier gets the candidate(s) with the ballots and the team's book and decides take or pass with a written reason, its risk per trade (0.5% to the cap, default cap 3%), leverage and levels. Code sizes the position, checks the price again, and writes the trade with a ticket. If no worker wants it, the team passes and the workers' reasons are the record. Three sessions a day (8:45, 15:15, 21:30 ET) the workers each propose at most one idea from the feed since the last session; the frontier reviews the open positions (close or tighten, with a reason) and picks at most two proposals.
- **Death.** A team whose equity touches 100,000 × (1 − 5%) at any tick dies: open positions are closed at the next bar, the team is logged as dead with the cause, its members return to the sideline, and a replacement forms immediately in Bronze. Every day at the 16:06 ET tick, after the mark: live teams are ranked by percent return since formation, the top three are Diamond, the next three Gold, the rest Bronze, and the worst team in Bronze dies and is replaced. New teams start in Bronze.
- **Even, unique.** The initial draft deals frontiers from the strong pool and workers from the cheap pool so every team gets a similar spread of workers and every worker sits in about the same number of teams. A replacement team's frontier is the model in the frontier pool with the best pool standing among those leading the fewest live teams; its workers are the best-standing workers with the fewest live seats. No two teams, living or dead, past or present, may share the exact same set of members (the `combo` key is unique per user). Models repeat; sets never do.
- **The oligarchy.** A team is ruled by its frontier and its two senior workers (the two with the best ballot record on the team; the first two by draft until there is a record). At the daily cut each council member sees the team's equity, its distance to the death line, and every member's record, and votes kick or keep on every other member with a reason. Two of three kicks. One kick a day per team. The replacement is the best-standing sideline model of the same role that keeps the set unique.
- **Rank, season, the desk.** The League table ranks teams within tiers by percent return. A season is 14 days. At the daily cut on the last day, the top team is the champion; from then on Ben's own $100k desk mirrors the champion's decisions (each take copied at the desk's size, each close copied). Books do not reset; a new season starts and the champion keeps the desk until another season ends. Until the first champion, the desk takes nothing new; its open HOOD trade runs to its stop, target or clock.
- **Learn.** Every decision by every team is a journal entry: takes with the ticket, passes with the reason (the frontier's, or the workers' when the frontier was not consulted), closes with the reason and who closed it, session proposals, council votes, kicks. One candidate can be opened to see every team's verdict side by side. Micro reviews at every close (the existing postmortem) cover team trades. The daily macro review reads the whole tournament: who leads and why, what the dead did, which frontiers, workers and strategies are working.
- **Charts.** Every symbol gets a TradingView chart (the free embed; BloFin perps as `BLOFIN:<BASE>USDT.P`, tokenized stock perps mapped to the stock) and our own chart from the tape with entries, stops, targets and exits drawn on it.
- **Feed** stays as the shared eyes. **Strategy shadow books** stay as the rule-only baseline and score the workers' ballots.
- **Removed:** the Now tab, the Debate and Book tabs (the desk's book lives under League), the nightly nine-seat board, the flash sit trio, the per-model standard. Model ratings continue as pool standing.

## Cost

About $0.04 per candidate per team (four worker ballots with light research, the frontier on the candidates the workers liked), 30 candidates a day, nine teams: about $11. Sessions about $4, councils about $1, reviews about $1. About $15 to $20 a day. `league.budget_usd_day` (default 25) stops new model calls when spent; a decision skipped for budget is written as a pass with that reason.

## Data

- `desk_teams`: id, user_id, name, frontier, workers[], seniors[], combo (unique per user), tier, status live|dead, season, formed_at, died_at, death_reason, start_equity, equity, peak, return_pct, marked_at, stats jsonb.
- `desk_decisions`: id, user_id, team_id, kind candidate|session|close|council, setup_id, symbol, strategy, timeframe, status launched|done|failed, brief jsonb, ballots jsonb, verdict jsonb, outcome jsonb, cost_usd, created_at, updated_at.
- `desk_councils`: id, user_id, team_id, day, votes jsonb, kicked, replaced_by, reason, cost_usd.
- `desk_seasons`: id, user_id, n, start_day, end_day, champion_team, status.
- `desk_accounts.league` jsonb: the settings (pools, counts, death_pct, risk_max_pct, budget_usd_day, research, session_times, season_days).
- `desk_trades`: owner `team:<id>`, source `league`, proposal_id = decision id, `ticket` jsonb, `close_requested_at`, `close_reason`.
- `desk_opinions.decision_id` for cost tracking; `desk_roster_log` records formed, died, kicked, promoted, relegated, champion.

## Functions

- `desk-league`: modes `form`, `cycle` (every tick: marks and deaths, stale decisions, dispatch candidates), `decide` (child, one team, up to four candidates), `session` and `session_team`, `council` and `council_team`, `status`.
- `desk-sync`: honours `close_requested_at` (closes at the next quote as `thesis_broke`).
- `desk-tick`: sync → league cycle → sessions at their minutes → council at or after 16:06 ET once a day. The sit collector and the nightly ladder are retired.
- `desk-review`: settle scores every team's ballots on a setup when the strategy's shadow trade closes; micro reviews for team trades; the macro review reads the tournament.

## Rules kept from before

Paper only, no broker keys. Every trade has a stop; a perp's stop sits inside its liquidation price; one position per symbol per book. Fills at the next bar, exits on bars, funding every eight hours. No emojis; every label explained on screen.
