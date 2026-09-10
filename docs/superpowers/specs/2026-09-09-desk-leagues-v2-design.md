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

**Death** at the death line stays: the book is closed, the team row dies, and the frontier comes back at once with a new life at $100k in Bronze. **The daily ranking** at 16:06 ET keeps the passive-day penalty, the tier re-rank and the season champion. The daily Bronze cut, councils and replacements are gone.

**Hours.** The cycle only queues setups whose venue is open; sessions only fire inside hours; the feed tagger pauses 22:00 to 09:00 ET. The sync (fills, stops, funding, marks) runs round the clock; it costs nothing.

**Budget** defaults to $3 a day (Ben, 2026-09-09 evening: "3 dollar budget cap, it prob won't even get to that"). Candidates stop at 85% of it; the sessions keep the rest.

**Learn.** The micro review gains a `teach` block: every input the trade used with its value, its plain meaning and why it mattered, and a glossary of the terms used. The app renders a "what went into this trade" panel from the ticket and the review, wraps lingo in a Term component that shows the meaning in parentheses until Ben marks it learned (`desk_accounts.learned_terms`), explains the strategies' rules the same way, and shows the trade on the chart with entry, stop, target and exit, with the TradingView toggle.

## Cost

About $4 to $5 a day at today's setup volume: the crew about $0.30, frontier decisions about $1.60 (eight candidates a call), sessions about $1.10, the daily review and tagging the rest.
