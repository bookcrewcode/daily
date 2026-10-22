# The Overseer: design (build 1 of 3)

Status: draft for Ben's review, 2026-10-15. Turns the Today screen's Overseer strip into a real agent that runs Ben's day over Telegram.

## What Ben wants (his words, 2026-10-15)

- "A one on one agent that has access to message me through Telegram ... basically a manager for me."
- "It is aware of everything I have to do because it's going to live inside the personal app."
- "I want it to be able to edit things for me, do stuff for me."
- "I need someone constantly reminding me ... I can't be wasting time throughout the day when I have shit to do."
- AI as his processing speed: he does the thinking, the agent does the legwork. He is willing to pay for it on OpenRouter.
- On silence or skipping: "there needs to be some emotional pressure because that's what makes me act with ADHD ... it messages something embarrassing to a friend or a family member ... nothing awful, but something goofy."

Answers from the design session:

- Reach: Daily app, Google Calendar, Gmail, his Mac, texts. Split into three builds (below); this spec is build 1.
- Intensity: drill sergeant. During drill blocks it pings until the current task is done.
- When ignored: shrink the task, ping faster, reshuffle the day, and stakes messages to a friend on tasks he marks.
- Budget: $1 a day.
- Platform: a Cloudflare agent (Ben's pick over Supabase edge functions).

## The three builds

1. **Brain + Telegram + Daily app + Google Calendar** (this spec). Runs in the cloud, never sleeps.
2. **Gmail.** Same brain, new tools: read the inbox, flag what needs Ben, draft replies he approves with one tap. Own spec.
3. **Mac + texts.** A small helper on Ben's Mac that the brain can call while the Mac is awake (files, apps, iMessage). Builds on `~/telegram-claude-bot`. Own spec.

## Lines this design keeps

- **A fixed tool list, not a shell.** "Full access" means the agent acts without asking inside its tool list. It has no shell, no arbitrary SQL and no way to add tools to itself.
- **Never:** moving money, trades, purchases, passwords or account settings. Same rule as the portfolio copilot.
- **Asks first with a Yes tap:** deleting anything (it archives instead), changing its own rules (hours, stakes, cap, models), and any message to a person other than an opted-in stakes partner.
- **Never goes silent because of money.** At the cap, or when OpenRouter is out of credit (it ran dry on 2026-09-11), pings and buttons keep working from templates.
- **Data is data.** Calendar titles, captures and notes are read as content. Text inside them can never trigger an action.
- **The app explains itself:** every label defined on screen, no hover tooltips, no emojis, in the app or in Telegram messages.
- **Firm, never shaming.** No "you failed", no day counts of misses. The evening wrap leads with wins.
- One Telegram bot for everything. Ben's existing Mac bot (a remote shell) stays separate and never carries these buttons.

## What it does

### 1. Morning (Ben's wake time, default 07:30 ET)

One message: "Here's today." Built from last night's top 3 (`nights.top3`), today's timetable blocks (`class_blocks`), Google Calendar, deadlines due in the next three days, open goal steps, and unprocessed captures. It names the task for each drill block, then suggests one or two tasks for stakes.

Buttons: **Lock it in** · **Change** · **No stakes today**. "Change" opens a short back-and-forth ("swap 2 and 3", "drop the essay to tomorrow"). "No stakes today" is only offered here, in the morning message.

If Ben has not answered the morning message by the start of the first drill block, the tasks lock as suggested and no task carries stakes that day (stakes need his tap).

### 2. Drill blocks

Block kinds `study`, `work` and `read` are drill blocks by default. `class`, `gym`, `drive`, `reset` and anything outside the wake-to-wrap window are quiet: no pings. Ben can change which kinds drill in settings.

At the start of a drill block: "Now: <task>. First step: <smallest concrete step>." Then a ping every 40 minutes (setting) with buttons:

- **Done:** marks it in the app, moves to the next task in the block.
- **10 more min:** next ping in 10 minutes.
- **Stuck:** cuts the task to a two-minute step, or asks one question to unstick it.
- **Skip:** moves the task to the next free drill slot (today, else tomorrow) and says where it went.

**Silence ladder.** "Silence" means no tap and no message since the last ping.

1. No answer: ping again after 20 minutes.
2. Still none: ping again after 10 minutes.
3. Still none: shrink. "Just do this: <two-minute step>." Buttons: **Done** · **Stuck**.
4. Still none after 10 minutes:
   - Stakes task: the countdown (section 4).
   - Otherwise: reshuffle the task to the next free slot, say where, and move on to the next task.

Any tap or message resets the ladder.

### 3. Talk to it anytime

Ben texts it like a person: "move gym to 6", "add: call dentist", "I'm overwhelmed, pick for me", "what's left today?" It acts and replies with what changed. Commands that work without a model, even at the cap: `/today`, `/pause`, `/resume`, `/done`, `/skip`, `/stakes off` (only before the first drill block starts). `/pause` stops all pings until `/resume`; each pause is logged and named in the evening wrap.

### 4. Stakes

- **Lines.** Ben writes his own list of goofy lines in the app ahead of time, e.g. "Ben owes you a coffee and has to tell you his most embarrassing song." The agent never writes a stakes line itself.
- **Partners opt in.** Ben sends a friend an invite link (`t.me/<bot>?start=<code>`). The friend taps it, which is also the only way a Telegram bot can message someone. They can leave anytime with `/stop`.
- **Trigger.** Only on a task Ben confirmed as stakes in the morning, only after the full silence ladder, only inside that task's block.
- **Countdown.** "15 minutes, then <partner> gets line #<n>." Cancelled only by tapping **Done** on the two-minute step. No other button, message or `/pause` cancels a countdown once it has started.
- **The message.** Sent to the partner as: "From Ben's accountability bot: <line>". It picks the line and partner in rotation.
- **Limits.** At most one stakes message a day. Every send is logged in the app.

### 5. Evening wrap (default 21:30 ET)

What got done, what moved and where it went, wins first. Then it sets tomorrow's top 3 with Ben (writes `nights.top3`, same as the Night flow in the app). After the wrap it is quiet until the morning unless Ben messages it.

### 6. Its powers (tools)

Acts on its own, logging each action with an Undo:

- Read everything the Today, Plan and Card screens read.
- Tasks and goal steps: add, edit, complete, reschedule, archive.
- Captures: add, process into tasks.
- Day plan and top 3: set and reorder.
- Timetable blocks: move or add one-off blocks for today and tomorrow.
- Card check-offs Ben reports ("took meds", "lifted").
- Google Calendar: create and move events. Deleting an event asks first.

### 7. In the app

- **Overseer page:** today's actions with Undo, the Telegram conversation, settings (wake and wrap times, drill block kinds, ping interval, models, cap, pause), stakes lines, partners with their join status, and today's spend against the cap.
- **The Today strip** (`Overseer.tsx`) shows the agent's latest message instead of a pre-written one.
- **Learn push:** when the Overseer goes live, the `nudge` cron is turned off and the daily Learn round becomes one of the Overseer's tasks, so there is one voice.

## How it is built

### Pieces

- **Cloudflare Worker `overseer`** (new folder `overseer/` in this repo, its own `wrangler.jsonc`), on a personal Cloudflare account separate from BookCrew. Workers free plan; upgrade to the $5 paid plan only if CPU limits are hit.
- **One Agent (Agents SDK, SQLite-backed Durable Object)** for Ben. It holds the live loop: current block, current task, ladder step, next ping, open countdown, and the last few turns of conversation. It sets its own next wake-up with `this.schedule()` after every ping. Morning and wrap are cron schedules.
- **Supabase stays the source of truth** for everything the app shows. The agent reads and writes app tables through the REST API with the service role key.
- **Worker routes:**
  - `POST /telegram`: the webhook. Checks Telegram's secret header. Accepts anything from Ben's chat id; from any other chat it accepts only `/start <invite code>` and `/stop`, and ignores everything else.
  - `POST /api/*`: calls from the app (undo, pause, test ping, partner invite). Checks the Supabase user JWT and that it is Ben's user id.
  - `GET /google/callback`: the one-time Google sign-in.

### New tables (Supabase)

- `overseer_settings`: wake and wrap times, drill kinds, ping interval, models, cap, paused, Telegram chat id.
- `overseer_messages`: every message in and out (mirror of the Telegram chat).
- `overseer_actions`: every action: tool, target, before, after, `undone_at`.
- `overseer_stakes_lines`: Ben's lines.
- `overseer_partners`: name, Telegram chat id, invite code, joined, left.
- `overseer_stakes_events`: task, countdown start, cancelled or sent, line, partner.
- `overseer_spend`: one row per model call with its cost.

Migrations are copied into `supabase/overseer/00N_*.sql`, like the Desk's.

### Secrets (Worker)

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY` (a new key just for the Overseer, with its own spending limit on OpenRouter as a second cap), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. The Google refresh token lives in the agent's own storage.

### Google Calendar

Today the app edits the calendar only while it is open (browser token). The agent needs offline access: Ben signs in with Google once from the Overseer page, the agent keeps the refresh token, and calls the Calendar API directly. If the app's existing Google OAuth client is set up, it is reused with the agent's callback URL added.

### Models and the $1 cap

- **No model:** routine pings, ladder steps, countdowns and commands are filled-in templates.
- **Cheap model:** Ben's free-text replies and "Stuck" step-cutting. Must do reliable tool calls.
- **Smart model:** the morning plan and the evening wrap only.
- Both are settings. The defaults are picked at build time from OpenRouter's current prices and tool-call reliability, and named on the Overseer page.
- Every call records its cost (OpenRouter `usage`) in `overseer_spend`. The day runs midnight to midnight ET. Before each call the agent checks today's total; at $1.00 it switches to template mode and says so once: "Today's AI budget is used up. Buttons still work; I'll read your messages in the morning."
- Expected spend on a normal day: well under $0.50.

### When things fail

- **OpenRouter error or out of credit:** same as the cap, template mode, plus a warning on the Overseer page.
- **Supabase read fails:** never read as "nothing to do". The ping uses the last task the agent holds; if it has none, it skips that ping and logs it.
- **Telegram send fails:** retried at the next wake-up, logged.
- **Double sends:** each ping gets an id written before sending; a wake-up that finds its ping id already sent does nothing.

## Testing

- Unit tests (Vitest with the Workers pool) for: which blocks drill and which are quiet, the silence ladder and its reset, Skip and reshuffle slot-finding, the stakes trigger and that only Done cancels a countdown, the one-a-day stakes limit, the cap switch to template mode, the webhook's chat-id and secret checks, Undo for every tool.
- A dry-run setting: everything goes to `overseer_messages` and the app, nothing to Telegram. One full dry-run day before Ben's phone gets pings, and stakes stay off for the first live day.

## Ben's setup (about 15 minutes, one time)

1. Create the bot in Telegram's BotFather and paste the token into the Overseer page.
2. Make a personal Cloudflare account (or confirm which one to use) and run `wrangler login` once.
3. Sign in with Google from the Overseer page.
4. Write three to five stakes lines and send the invite link to one friend.

## Build order (inside build 1)

1. Worker, agent, Telegram webhook, `/today` and `/pause`, read-only. Dry run.
2. The drill loop: morning message, block pings, buttons, silence ladder, shrink, Skip and reshuffle, with the action log and Undo.
3. The Overseer page in the app.
4. Talk-anytime with tools, the $1 cap and template fallback.
5. Stakes: lines, partner invites, countdown.
6. Google Calendar sign-in and calendar tools.
7. Evening wrap into tomorrow's top 3. Turn off the `nudge` cron. Go live.

## Touches other specs

The portfolio copilot spec (`2026-10-15-portfolio-copilot-design.md`, desk worktree) plans its own alert bot. With this design, portfolio alerts go out through the Overseer's bot instead: the `pilot` function sends with the same bot token, and the Overseer's webhook forwards any button tap whose data starts with `pf:` to `pilot`'s `telegram` mode. That spec needs a one-paragraph update before either is built.
