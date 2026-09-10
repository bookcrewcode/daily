# The Desk leagues, v2: one crew, nine frontiers, trading hours, a Learn tab that teaches

Ben's decisions on 2026-09-09 evening, after the first afternoon of the leagues cost about $12 of model credit:

- "Cut usage by a lot, keep the rules intact and the volume, frontier models still decide." Every team gets the same four cheapest workers doing the research; the frontiers decide independently.
- "Give them a limit on the amount of research they can do and force quality over quantity."
- The ninth team is Grok 4.3 as a cheap frontier, a control against the expensive ones.
- Councils, kicks and replacement combinations are removed: with one shared crew there is nothing to swap.
- Hours: stocks 09:00 to 17:00 ET, crypto 09:00 to 22:00 ET.
- Learn must break every trade down simply, teach everything a trade used and why, put a parenthesis with the plain meaning after every piece of trading lingo until Ben marks it learned, and show the trade on a chart.

## What changes

**Teams.** A team is a frontier plus the shared crew. Pool: Opus 5, GPT-6 Astra, Fable 5.1, Gemini 3.1 Pro, Kimi K3, Grok 4.6, Sonnet 5, GPT-5.6 Terra, Grok 4.3. Crew: Gemini 3.5 Flash Lite, GPT-5.6 Luna, MiniMax M3, Gemini 3.8 Flash (settings `worker_pool`, two to six). A team's `combo` becomes `frontier#life` so a frontier that dies can come back as "Opus 5 II" with a fresh $100k book while its dead team keeps its record.

**Research once, decide nine times.** A fresh setup inside its venue's hours becomes one `desk_research` row (the crew's ballots) and one `desk_decisions` row per live team pointing at it. One child per batch of up to eight setups runs the crew once per setup (each worker gets `worker_lookups` look-ups, default one, and is told to make it the one that decides), saves the ballots, then asks every frontier in parallel over the candidates at least one worker liked or whose confluence score is 0.6 or more, and executes per team with the same guardrail and ticket as before. Ballots are copied onto each team's decision so the app reads them as before.

**Sessions** (09:35, 15:15, 21:30 ET, inside hours): one child per session; the crew proposes once, every frontier reviews its own positions and judges the same proposals.

**Death** at the death line stays, but the line is 25% below the start (Ben, later that evening: "make it a 25k death not 5k"), pushed lower by any cushion the team has earned. At the line the book is closed, the team row dies, and the frontier comes back at once with a new life at $100k in Bronze, unless the team holds a life vest: then the vest is spent, the book is refilled to its start (`stats.refill`), the team keeps its name, tier and record, and the log says "revived". **The daily ranking** at 16:06 ET keeps the passive-day penalty, the tier re-rank and the season champion. The daily Bronze cut, councils and replacements are gone.

**Hours.** The cycle only queues setups whose venue is open; sessions only fire inside hours; the feed tagger pauses 22:00 to 09:00 ET. The sync (fills, stops, funding, marks) runs round the clock; it costs nothing.

**Budget** defaults to $3 a day (Ben, 2026-09-09 evening: "3 dollar budget cap, it prob won't even get to that"). Candidates stop at 85% of it; the sessions keep the rest.

**Learn.** The micro review gains a `teach` block: every input the trade used with its value, its plain meaning and why it mattered, and a glossary of the terms used. The app renders a "what went into this trade" panel from the ticket and the review, wraps lingo in a Term component that shows the meaning in parentheses until Ben marks it learned (`desk_accounts.learned_terms`), explains the strategies' rules the same way, and shows the trade on the chart with entry, stop, target and exit, with the TradingView toggle.

## Cost

About $4 to $5 a day at today's setup volume: the crew about $0.30, frontier decisions about $1.60 (eight candidates a call), sessions about $1.10, the daily review and tagging the rest.

## Later the same evening: own playbooks, rewards, plain words

Ben, after watching the first candidates: "the groups shouldn't only follow the 8 strategies, they're too conservative and it's going to lead to all similar pnls... the head models should come up with their own strats, you can leave the 8"; "I want there also to be an incentive to taking riskier trades/high pnl days: a 5k day earns the team a life vest... anything above like 10k-20k-30k+ you come up with rewards that get increasingly better"; "make it a 25k death not 5k"; and, earlier, "the journal entries need to be easier to understand, also if it's pulling from the news it should give a brief explanation of what happened not just the title".

**Own playbooks.** At every session each frontier may add up to two trades of its own (`ideas` in the session answer): a playbook name it chooses and reuses (stored as `strategy = own:<slug>`, shown as "own playbook: …"), the thesis, the catalyst, what proves it wrong, the stop and target as percent distances from the live price (code reads the price and places them), the horizon, leverage, risk and confidence. Each becomes a `desk_decisions` row of kind `own` with the idea under `brief.proposal` and the frontier's own ballot, then the same validation, guardrail and ticket as any trade. Own ideas count toward a limit of three new positions a session with the proposal takes. The eight coded strategies stay. The look-ups behind the ideas are memoised per symbol across the nine teams, run two at a time, and wait out the data source's retry-after window together, because nine frontiers naming the same few symbols at once tripped its rate limit.

**Rewards for big days** (`REWARD_LADDER` in `league.ts`, one source for the functions and the app). At the 16:06 ET ranking each team's change in its book since the last ranking is measured (`stats.day_ref`, refills left out), once a day like the passive day, and each step includes the ones below it: +$5,000 earns a life vest (up to three held); +$10,000 also a cushion, the death line dropping $10,000 for the rest of the team's life (to $50,000 below the start at most); +$20,000 also bigger guns, the frontier's risk cap per trade rising one point (three at most); +$30,000 also a shield (the team cannot be relegated at the next ranking; the tier holds one more team that day) and a second vest. The holdings live in `desk_teams.stats` (`vests`, `cushion`, `risk_bonus`, `shield`, `refill`, `revivals`), the frontiers read them in every brief ("rewards in hand"), and the log records `reward`, `revived` and `shielded`.

**Plain words.** Every tagged headline carries `plain` (what happened and what it means for the price, for a beginner; backfilled once for the last three days), the briefs keep structured `headline_items`, `macro_items` and `digest_items`, and the app writes an "In short" summary for every decision and trade from the row itself.

**Budget** is $3 a day.
