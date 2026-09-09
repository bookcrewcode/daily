# Desk phase 7: the leagues — implementation plan

Spec: docs/superpowers/specs/2026-09-09-desk-leagues-design.md

Constraints: edge functions deploy only via the Supabase MCP (bundle with `node scripts/desk-bundle.mjs <fn>`, split, paste); 150 s per invocation, launch-and-collect for anything longer; cron auth via the vault secret; tests `npx tsx --test src/lib/desk/*.test.ts`; lint `npx eslint src/components/desk src/lib/desk`; `npx tsc --noEmit`; `npm run build`; `useEffect(() => { Promise.resolve().then(load); }, [load]);`; no `Date.now()` in render; no emojis; explain every label.

## Task 1: pure league logic — `src/lib/desk/league.ts` + `league.test.ts`
- Types `LeagueSettings`, `DEFAULT_LEAGUE`, `TeamLike`.
- `comboKey`, `draftTeams` (shift pattern, unique sets, even usage), `replacementTeam` (pool standing, fewest seats, unique), `rankTiers`, `teamName` (short label + roman), `poolStanding`, `deathLine`, `sessionDue`.
- Tests: 9×4 draft is unique and even; replacement never repeats a set; tiers by return; names.
- Add `league` to `scripts/desk-sync-libs.mjs` MODS and a `desk-league` target.

## Task 2: schema — `supabase/desk/006_leagues.sql`, applied via MCP `apply_migration`
- Tables above with RLS "own" policies; indexes on (user_id, status), (team_id, created_at), (setup_id).
- `desk_accounts.league jsonb default '{}'`; `desk_trades.ticket jsonb`, `close_requested_at`, `close_reason`; `desk_opinions.decision_id uuid`.

## Task 3: client API — `src/lib/desk/api.ts`
- `Account.league: Partial<LeagueSettings>`; `Trade.source` gains `league`; `ticket` on Trade.
- `TeamRow`, `loadTeams`; `DecisionRow`, `loadDecisions({team, setup, kind, limit, sinceHours})`; `CouncilRow`, `loadCouncils`; `SeasonRow`, `loadSeasons`; `updateAccount` accepts `league`; `LEAGUE_FN`.

## Task 4: `supabase/functions/desk-league/index.ts` (new)
- Auth like the others. Modes: form, cycle, decide, session, session_team, council, council_team, status.
- Worker ballot with light research (tools: bars, funding, news, record; two calls; 60 s); frontier decision (one call over the supported candidates); execution (quote check, guardrail with the team's open trades, insert trade with ticket, mirror to the desk when champion).
- Death and marks each cycle from one batched quotes call; council: rank, tiers, cut, form, launch council children, season.
- Bundle, deploy (verify_jwt false), form the teams live, run a cycle, inspect rows.

## Task 5: `desk-sync` close requests; `desk-tick` wiring
- Exits loop: `close_requested_at` → close at the next quote as `thesis_broke`; pending → cancelled.
- Tick: drop the sit collector; call `desk-league cycle`; launch `session` at the session minutes; launch `council` at or after 16:06 ET.
- Deploy both; unschedule `desk-run` (job 11); record in `003_cron.sql`.

## Task 6: `desk-review`
- `settle`: `team:` owners get the micro review; a closed `strat:` shadow trade scores every team decision on that setup (worker ballots and the frontier's verdict) into `desk_ratings`.
- `coach`: tournament card (teams by tier, returns, days alive, decisions, kicks, dead today, strategy by tier, pool standings, recent team trades with reviews); prompt rewritten.
- Deploy.

## Task 7: UI
- `DeskSpace.tsx`: gears Feed | League | Learn; delete Now, Tonight, Debate, Sits, DeskSettings, old League.
- `Leagues.tsx` (season header, tiers, team cards, sideline, graveyard, the desk (Book), strategy books, settings), `Team.tsx` (book with charts, decisions, council, members), `DecisionCard.tsx`, `Ticket.tsx`, `Chart.tsx` (lightweight-charts + TradingView toggle), `LeagueSettings.tsx`.
- Learn: `Journal.tsx` → every decision across teams with filters and the per-candidate view; `MacroReview.tsx` reads the tournament card.
- `npm i lightweight-charts@5`. Lint, tsc, build.

## Task 8: go live
- Deploy everything, form teams, watch the first cycle and the first decisions, push `desk:main`, update memory.
