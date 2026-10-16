# Handoff: Telegram alerts (Supabase build) → Overseer

2026-10-16 · from the "telegram alerts / study setup" chat, for the Overseer build chat.

**Ben's call (2026-10-16):** the Overseer is the one system. This chat's Telegram alerts build stops here and is handed over. Nothing from it is live: no cron, no webhook, no token stored. Reuse what helps, delete what doesn't.

Read with: `docs/superpowers/specs/2026-10-15-telegram-alerts-design.md` and `docs/superpowers/plans/2026-10-15-telegram-alerts.md` (both on branch `telegram-alerts` in `~/Downloads/daily`; from another worktree use `git show telegram-alerts:<path>`).

---

## 1. What exists right now

### Branch `telegram-alerts` (main checkout `~/Downloads/daily`, not pushed, not merged)

| Commit | What |
|---|---|
| e0f017a | spec, plan, database notes |
| df79348 | `supabase/functions/alerts/plan.ts` + `plan.test.ts`: pure planner, 22 tests |
| 5ef4a08 | `supabase/functions/alerts/items.ts` + `items.test.ts`: tick a block the Card's way |
| 89f4cf8 | `supabase/functions/alerts/index.ts`: cron tick, claim-then-send, `/today`, Done write-back, dry run |
| 65fda08 | `supabase/functions/telegram/index.ts`: webhook + app connect/test/pause |
| 50bf240 | `src/components/TelegramAlerts.tsx` (Settings card), `TELEGRAM_FN` in `src/lib/supabase.ts`, mounted in `src/app/page.tsx` |
| 0283870 | review fixes (see section 4), `telegram/taps.ts` + `taps.test.ts`, **and the `TheCard.tsx` fix** |

Tests: `npx --yes tsx --test supabase/functions/alerts/plan.test.ts supabase/functions/alerts/items.test.ts supabase/functions/telegram/taps.test.ts` → 31/31 pass. `npx tsc --noEmit` and `npm run build` pass. The one ESLint error in `TheCard.tsx` (line 241, `react-hooks/set-state-in-effect`) was there before; `AIKey.tsx` has the same one.

Uncommitted in that checkout: `public/version.json` and `src/lib/buildId.ts` are build stamps from `npm run build`. Not part of this work; discard them.

### Supabase project `pciljeqsrricybdnhvsu` (applied through the MCP; Ben has no dashboard access)

| Object | State | Notes |
|---|---|---|
| table `public.alert_log` | exists, 0 rows | unique `(user_id, key)`, RLS owner-read; keys `plan:<day>`, `block:<blockId>:<day>`, `nudge:<blockId>:<day>`, `due_eve:<deadlineId>`, `bundle:<day>:<min>`, `today:<day>:<min>` |
| column `user_settings.telegram jsonb` | exists, Ben's is `{}` | default `'{}'` |
| vault `telegram_webhook_secret`, `alerts_cron_secret` | exist | random hex generated inside SQL; nobody has seen them |
| vault `telegram_bot_token` | **does not exist** | the token was never stored |
| RPC `set_telegram_token(p_token)` | exists | SECURITY DEFINER, owner-only (same shape as `set_ai_key`), validates `^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$` |
| RPC `telegram_status()` | exists | `is_set, hint, linked, bot_username, blocked, paused_until` |
| edge function `alerts` | deployed **v1, idle** | v1 is the pre-review-fix code; the repo has the fixed code |
| edge function `telegram` | deployed **v1, idle** | same; no webhook points at it |
| cron `telegram-alerts` | **not scheduled** | |

Migrations applied: `telegram_alerts`, `telegram_status_linked_boolean`.

### The bot

- **@dailyappalert_bot** was created by Ben on 2026-10-15 with BotFather.
- **Its first token was pasted into this chat.** Treat it as exposed: Ben should revoke it (`/mybots` → @dailyappalert_bot → API Token → Revoke current token) before the Overseer uses the bot. Claude never stored or used it.
- No webhook is set and nothing is polling it.
- `~/telegram-claude-bot` is a different bot. It's a remote Claude Code shell running with `--dangerously-skip-permissions`, so alert replies must never route into it. It's running (pid was 52703).

---

## 2. Ben's decisions in this chat (reconcile with the Overseer spec)

| Topic | This chat | Overseer spec | Note |
|---|---|---|---|
| What alerts | deadlines/exams, timetable blocks, morning plan, nudge if quiet | superset | — |
| Morning plan | **07:45** | ? | Ben picked 07:45: before the 8:15 read (Mon/Wed) and 8:30 Macro (Tue/Fri) |
| Quiet times | **class blocks, gym blocks, 22:00–07:30** | ? | held items arrive as one bundle when quiet ends |
| Driving | Ben did NOT choose quiet while driving | ? | default here: **send silently** (`disable_notification`) during `drive` blocks so the phone never buzzes mid-shift. Raise it with him |
| Nudges | **one** nudge 15 min after an untouched block starts | pings every 40 min, silence ladder | the Overseer is more intense by design; Ben approved that spec later |
| Daily cap | 10 messages outside the plan | ? | |
| Hosting | Ben first said "we are using Cloudflare", then picked "keep it on Supabase" for this build | Cloudflare Agents SDK | the Cloudflare comment meant the Overseer |
| Token entry | through the app (`set_telegram_token` RPC + Settings card), because Ben has no Supabase dashboard access | `wrangler secret put` (Ben runs it) | either way **Claude never handles the token** |

---

## 3. Worth reusing

1. **`alerts/plan.ts` + 22 tests.** Pure logic the Overseer needs too:
   - `localClock` (Intl, DST-safe), `localDay`, `quietAt` (night wraps midnight; a block is never quiet for its own ping).
   - Due-tomorrow on the **local** due day, staleness windows, snooze and failed retries, the cap, bundling of held items, the plan absorbing held items.
   - `shortCourse` ("21:640:114:07 PRECALCULUS" → "Precalculus").
   - The tests pin the traps below. Port them even if you rewrite the code.
2. **`alerts/items.ts` + tests.** `tickBlockItem` writes the exact `DayItem` shape `TheCard.tsx` seeds (`src:"block"`, `block_id`, label + " · location" for classes) and seeds the day's blocks first when the Card hasn't (`nights.blocks_seeded`). `tickGoalItem` ticks a deadline's goal item. Any Telegram "Done" needs this.
3. **`telegram/taps.ts` + tests.**
   - `tapResult`: Starting keeps a Done button; Done, Skip and Snooze clear the buttons.
   - `pauseMs` and `pauseLabel`: `/pause 30m`, `2h` and `3` all parse; anything else is refused rather than guessed.
4. **The `TheCard.tsx` fix in 0283870 is needed by the Overseer regardless.** The Card never re-read `nights.items` on return from background, so a Done written by any server (Telegram, Overseer) was overwritten by the Card's next save of its stale list. Fix: re-read on `visibilitychange` when it's the same day. Cherry-pick it.
5. **The claim-then-send pattern.** Insert the log row with `on_conflict … ignore-duplicates`, or PATCH guarded by the current state, **before** sending. Only the winner sends. Do slow work (model calls) before the claim, and put a timeout on every outside call (10 s here).

---

## 4. Traps found (tests or the final review pinned these)

- **Canvas 23:59 local is stored as 03:59Z the next day.** Always compute the local due day before saying "due tomorrow".
- **DST ends Sun Nov 1 2026.** Use wall time through `Intl`; never add fixed UTC offsets.
- **Telegram `callback_data` is limited to 64 bytes.** `d|block:<uuid>:<YYYY-MM-DD>` is 55 bytes, which fits.
- **Ben may tick a block in the app before its start time.** Then send no ping, no nudge, and keep it out of the top 3.
- **Overlapping ticks must never double-send.** Claim first (verified: inserts returned [1,0]).
- **Removing the inline keyboard on every tap kills the Starting→Done flow.**
- **`parseInt("30m")` is 30**, so `/pause 30m` became 24 hours.
- **Scope every lookup to Ben's user id.** `user_settings.telegram` is writable by any signed-in account under RLS.
- **Deferred minors, not fixed:**
  - Blocks with no `end_t` (the app allows it), or that cross midnight, give `NaN` times.
  - Telegram 429 `retry_after` is ignored.
  - Haiku 5.5's thinking can eat a 300-token budget. The live AI key is OpenRouter, so the Gemini path is what runs.
  - `String.replace` with a string replacement mangles `$&`.
  - A 60 s secret cache can serve the old token right after a token replace.
  - Settings card copy: the token hint is never shown; relinking shows no link; status polling stops at 2 minutes while the link lasts 10.
  - Stale buttons give misleading feedback.
  - `alerts/index.ts` has no tests.
- **Operational:**
  - In this chat, MCP `deploy_edge_function` calls with roughly 30 KB of inline files were cut off mid-stream twice. Keep files small, or deploy in a fresh turn.
  - `net.http_post` fires at commit, so use one post per statement.
  - Deno isn't installed. Type-check edge code with `tsc` against a small `Deno` shim.
  - Commit as `git -c user.name="Ben Garnet" -c user.email="bengarnet@mac.lan"`.
  - Pushing to `bookcrewcode/daily` needs `gh auth switch -u bookcrewcode`. Pushing `main` deploys GitHub Pages.

---

## 5. Cleanup the Overseer chat should decide

If the Overseer doesn't reuse them:

```sql
-- database objects from this build
drop function if exists public.set_telegram_token(text);
drop function if exists public.telegram_status();
drop table if exists public.alert_log;
alter table public.user_settings drop column if exists telegram;  -- only if the Overseer stores its settings elsewhere
delete from vault.secrets where name in ('telegram_webhook_secret', 'alerts_cron_secret');
```

- **Edge functions:** the Supabase MCP has no delete. Either redeploy `alerts` and `telegram` as tiny stubs that return 410, the way `keycheck` was retired, or leave them idle. Nothing calls them.
- **Branch `telegram-alerts`:** cherry-pick `TheCard.tsx` and the tested modules, then delete the branch. Don't merge it whole: it adds a Settings card that talks to functions that won't be live.

---

## 6. Everything else this chat did (context for the Overseer)

**Ben's profile.**
- Memory `working-style-2e-profile.md`: strong reasoning, average processing speed, ADHD.
- Give the first 3 micro-steps only, bounded explanations, a clear "good enough", and Claude does the execution.
- Vault: `~/Downloads/Ben's Second Brain/Templates/Study Prompt.md` (study-coach prompt with LEARN/DRILL/CRAM modes and per-course add-ons).

**Classes loaded into Daily (live now).**
- **Canvas calendar feed:** connected (Ben pasted it in Learn → Classes). The feed is thin: only 12 events, and only Precalc posts upcoming items.
- **Class notebooks:** Precalc ("21:640:114:07 PRECALCULUS", made by Ben), Macroeconomics, Microeconomics, Planet Earth (made by Claude via SQL). Each has its syllabus as a source (supporting-services boilerplate stripped), and the chunks were built by the trigger.
- **Import files:** `~/Downloads/Ben's Second Brain/Areas/School - Class manifests/*.json` (`daily.class-manifest/1`).
  - `modern-america.json` holds the full slide text and OCR'd readings. It was never imported, because Ben doesn't want that notebook.
- **Deadlines:** 11 upcoming, each with a `start_by`. The next ones:
  - Modern America Test #1, Thu Oct 22 (closed note, no devices; start_by was Oct 15).
  - Precalc HW 5, due Oct 25 (Canvas).
  - Precalc Assessment 3 (Ch 5), ~Tue Oct 27 (day estimated from the syllabus week).
  - Modern America readings Oct 27 / Nov 3 / 10 / 17 / Dec 1.
  - Precalc Assessments 4 and 5, ~Nov 17 and ~Dec 1.
  - Modern America Test #2, Dec 10.
  - The 4 past Canvas items (SW2, SW3, HW 4, Assessment 2) were marked done.
- **Missing dates:** Macro, Micro and Planet Earth exam dates aren't in their syllabi. Add them when announced.
- **Modern America bans AI.** The syllabus forbids "the use of any artificial intelligence tools in this class", so no AI tutoring for that course; Ben dropped its notebook. Reminders about its dates are fine.
- **Course labels:** deadlines from Canvas use the feed's bracket labels, e.g. "Fall 2026 (21:512:368:01)" for Modern America. `course_key()` normalizes those.

**Timetable (`class_blocks`, 41 rows).**
- Kinds: `class`, `read`, `drill`, `study`, `gym`, `drive`, `reset`.
- Weekend drive blocks run 10:30–20:30; Friday's runs 13:00–22:00. Gym is Mon/Wed 18:00 and Tue/Thu 17:00, Fri 10:15.

**Open items, not done.**
- `~/Projects/rutgers-sniper` (launchd `com.bengarnet.rutgers-sniper`) is still polling Fall 2026 sections a month after registration closed. It runs `caffeinate -i -s` (keeps the Mac awake) and `watch.out` is about 8 MB. Ben was asked twice whether to turn it off and hasn't answered.
- Precalc Ch 5 slide decks for Assessment 3 weren't downloaded (needs Ben's OK). He already has the Ch 4 decks in `~/Downloads`.
- Learn features discussed but not built: an exam/cram mode (map → pillars → "don't study this" boundary; tag each mistake as concept, slip or misread; a "Later" list; Solid / Shaky / Next 3 wrap-up) and per-course add-ons.
- Tesseract was installed with Homebrew for the OCR (`brew uninstall tesseract` removes it).
