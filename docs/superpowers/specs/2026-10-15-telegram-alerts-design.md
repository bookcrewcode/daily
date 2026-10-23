# Telegram alerts — design

2026-10-15 · status: paused 2026-10-16, handed to the Overseer (see docs/superpowers/handoffs/2026-10-16-telegram-alerts-to-overseer.md)

## Why

Ben has ADHD and gets things done when something outside him says "now". Daily
already knows what "now" is: the weekly timetable (`class_blocks`), the day's
checklist (`nights.items`), and every deadline with its start-by day
(`deadlines` mirrored into `goals`). Telegram is where the prompt lands, because
it reaches his phone reliably and lets him answer with one tap.

## Decisions Ben made

- **Alert on:** deadlines and exams, timetable blocks, a 7:45 morning plan, and
  one follow-up nudge when a block goes untouched.
- **A new, dedicated bot** ("Daily alerts"). Not `~/telegram-claude-bot`: that
  bot runs Claude Code with full permissions on the Mac, and alert replies must
  never route into it.
- **Runs on Supabase**, next to the data. Not Cloudflare.
- **Quiet during** class blocks, gym blocks, and 22:00–07:30. Anything due in a
  quiet window is held and delivered as one bundle when the window ends.
- **Drive blocks:** delivered silently (Telegram `disable_notification`). Ben
  did not ask for quiet while driving; silent delivery is the default so the
  phone never buzzes mid-shift. One setting flips it.
- **No dashboard.** Ben has no Supabase dashboard access, so everything is set
  up through the MCP and the app. The bot token enters through the app (the
  same pattern as `set_ai_key` / `AIKey.tsx`) and never passes through Claude.

## What Ben sees

| When | Message | Buttons |
|---|---|---|
| 07:45 every day | **Morning plan:** today's top 3, each with its first small step; what starts today; exam countdowns ("Precalc Assessment 3 in 12 days") | Open Daily |
| A non-class block starts | "Gym now · 17:00–18:30" | Starting · Done · Snooze 15m |
| 15 min after a block starts, nothing tapped and not ticked in the app | "Gym started 15 min ago. Still on?" — sent **once**, never repeated | Starting · Done · Skip today |
| 18:00 the day before something is due | "Due tomorrow: HW 5 Set 5 (Precalc)" | Done · Open Daily |
| A quiet window ends with held items | One bundled message listing them | Open Daily |

Start-by days and same-day deadlines are folded into the morning plan rather
than sent separately.

**Commands:** `/today` (the plan again), `/pause 2h` (1 to 24 hours; the app card has "Pause for the rest of today"),
`/resume`.

**Limits:** at most 10 messages a day outside the morning plan; past the cap,
items fold into the next bundle or the next morning plan.

**Tone:** short and plain. Never a day count, never "you missed" (the rule
`nudge` already follows). No emojis.

## How it works

### Data

- **`alert_log`** (new table, RLS owner-only): `id`, `user_id`, `key`
  (unique per user), `kind` (`plan` | `block` | `nudge` | `due_eve` |
  `bundle`), `day`, `ref_id` (block or deadline id), `state` (`held` | `sent` |
  `started` | `done` | `snoozed` | `skipped` | `failed`), `held_until`,
  `snooze_until`, `tg_message_id`, `tries`, `meta` jsonb, `created_at`,
  `updated_at`. Keys look like `plan:2026-10-16`, `block:<id>:2026-10-16`,
  `nudge:<id>:2026-10-16`, `due_eve:<deadline id>`. The row is written
  **before** the send, so a slow Telegram call can never double-send.
- **`user_settings.telegram`** (new jsonb column): `chat_id`, `linked_at`,
  `morning_at` ("07:45"), `tz` ("America/New_York"), `quiet`
  (`{class: true, gym: true, night: ["22:00","07:30"]}`), `drive_silent`
  (true), `paused_until`, `cap` (10), `link_code`, `link_code_exp`.
- **Vault secrets:** `telegram_bot_token` (written only by the RPC below),
  `telegram_webhook_secret` and `alerts_cron_secret` (both generated inside
  SQL; nobody ever sees them).
- **RPCs** (SECURITY DEFINER, `auth.uid()` required, same shape as
  `set_ai_key` / `ai_key_status`): `set_telegram_token(p_token)` and
  `telegram_status()` → `{is_set, hint (last 4), linked, bot_username}`. The
  token is never returned to the client.

### Edge functions

**`alerts`** — pg_cron every 5 minutes, `{cronSecret}` checked against the
vault, the same wiring as `learn-nudge`. Each tick:

1. Reads settings, today's `class_blocks`, today's `nights` row, open
   deadlines, and today's `alert_log`. Any failed read ends the tick: a failed
   read is never treated as an empty list.
2. Runs the pure planner `planAlerts(now, data)`, which returns the messages
   due now after quiet windows, pause, snoozes, the cap and bundling are
   applied.
3. For each message: writes the `alert_log` row, sends with `sendMessage` and
   an inline keyboard (silent inside a drive block), and stores the Telegram
   message id.

Top 3 for the morning plan: `nights.top3` when Ben set one; otherwise
deadlines whose start-by day has come (nearest due first), then today's
non-class blocks. The first step per item comes from one model call through
the same AI key path the `learn` function uses; if that call fails, the plan
is sent without steps.

**`telegram`** — the bot's webhook. `verify_jwt=false`; every update must carry
the `X-Telegram-Bot-Api-Secret-Token` header matching the vault.

- **Buttons:** Starting / Done / Snooze / Skip update the `alert_log` row.
  **Done on a block** ticks the same checklist item the Card shows. If the
  Card hasn't seeded today's blocks yet, it seeds them exactly as
  `TheCard.tsx` does (same `DayItem` shape, `src: "block"`, `block_id`, then
  `blocks_seeded = true`) before ticking. **Done on a deadline** sets
  `deadlines.done` and runs `mirror_deadline_goals`, which closes the goal.
- **Messages:** `/start <code>` links `chat_id` when the code matches and
  hasn't expired. Every other message from any chat but the linked one is
  ignored.
- **`mode: "connect"`** (called from the app with Ben's JWT): validates the
  token with `getMe`, registers the webhook (`setWebhook` with the secret
  token, `allowed_updates: ["message", "callback_query"]`), makes a 10-minute
  link code, and returns `{bot_username, link: "https://t.me/<bot>?start=<code>"}`.
- **`mode: "test"`** (JWT): sends "Alerts are connected." to the linked chat.

### App

A **Telegram alerts** card in settings, next to the AI key card:

1. Paste the token from BotFather, then tap **Connect**.
2. Tap **Open the bot and tap Start** (the deep link).
3. A status line ("Connected to @dailyappalert_bot"), a **Pause for the rest of today**
   switch, and a **Send a test** button.

The card says in plain words what gets sent and when the bot stays quiet,
with no hover-only explanations (see the app-explains-itself rule).

### Size

Both functions stay well under the 44 KB MCP deploy cap. The planner lives in
its own file (`supabase/functions/alerts/plan.ts`) so it can be unit tested.

## Errors

- Telegram 403 (bot blocked or chat gone): stop sending; the app card shows
  "Reconnect".
- Telegram 429: honor `retry_after`; the row stays `held` and goes on the next
  tick.
- Any other send failure: the row is marked `failed` and retried at most twice.
- Time: everything is computed in `America/New_York`, so daylight-saving days
  shift correctly.

## Testing

- Unit tests for `planAlerts` (run with `npx --yes tsx --test`, like
  `session.test.ts`): quiet windows and bundling, the cap, snooze, the nudge
  firing once, silence in drive blocks, pause, the DST-change day, and a
  failed read meaning no send.
- `alerts` with `{cronSecret, dryRun: true}` returns what it would send
  without sending, for checking against real data.
- End to end: Connect from the app, `/start`, then **Send a test**, then a
  forced tick during a real block.

## Ben's part (about 3 minutes, after the build)

1. ~~In Telegram, message @BotFather, send `/newbot`, and name it "Daily
   alerts".~~ Done 2026-10-15: **@dailyappalert_bot**. Its first token was
   pasted into a chat, so it gets revoked in BotFather and the fresh token goes
   only into the app.
2. In Daily, paste the token into the Telegram alerts card and tap Connect.
3. Tap the Start link it shows.

## Out of scope for v1

- Chatting with an AI through the alerts bot.
- Editing the timetable from Telegram.
- Desk or trading alerts.
- Automatic Canvas re-sync. It stays the Sync button in the Classes card; a
  daily automatic sync can come later.

## Applied

- 2026-10-15: migration `telegram_alerts` (alert_log, user_settings.telegram, two generated vault secrets, set_telegram_token, telegram_status), then `telegram_status_linked_boolean` (linked is false, never null, before a chat is linked).
