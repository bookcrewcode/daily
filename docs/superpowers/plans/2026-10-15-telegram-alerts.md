# Telegram Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated Telegram bot (@dailyappalert_bot) that sends Ben a 7:45 plan, a ping when each timetable block starts, one nudge when a block goes untouched, and a 6pm heads-up before deadlines, with Done/Starting/Snooze buttons that write back into Daily.

**Architecture:** A pure planner (`supabase/functions/alerts/plan.ts`) decides what to send from the clock plus today's data; the `alerts` edge function (pg_cron, every 5 minutes) loads data, runs the planner, claims an `alert_log` row per message and sends it. The `telegram` edge function is the bot's webhook (button taps, `/start`, `/today`, `/pause`, `/resume`) plus the app's connect/test/pause calls. The bot token enters only through a new Settings card and a SECURITY DEFINER RPC, the same path as the AI key.

**Tech Stack:** Supabase (Postgres, pg_cron, pg_net, Vault, Deno edge functions deployed through the Supabase MCP), Telegram Bot API, Next.js 16 static export (React 19), node:test via `npx --yes tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-15-telegram-alerts-design.md`

## Global Constraints

- Supabase project id: `pciljeqsrricybdnhvsu`. Everything is applied through the Supabase MCP (`apply_migration`, `execute_sql`, `deploy_edge_function`); Ben has no dashboard access and there is no `supabase/migrations` dir.
- Ben's user id (already hard-coded in `set_ai_key`): `f0e1e204-aa54-4a45-bbb5-99c83114fecb`.
- Time zone `America/New_York`; morning plan `07:45`; quiet: class blocks, gym blocks, `22:00`–`07:30`; drive blocks send with `disable_notification: true`; cap 10 messages a day outside the plan.
- Nudge once, 15 minutes after a block starts. Snooze is 15 minutes. Due-tomorrow heads-up at `18:00`.
- Never a day count, never "you missed". No emojis in anything shipped (messages or UI).
- Claude never handles the bot token: it goes app → `set_telegram_token` RPC → Vault only.
- Each edge function file set stays under the 44 KB MCP deploy cap. Deploy with `verify_jwt: false` (both functions check auth themselves, like `nudge`).
- Tests: `npx --yes tsx --test <file>` from the repo root. `tsconfig.json` excludes `supabase/`, so the planner tests run under Node, not Deno.
- Commits: `git -c user.name="Ben Garnet" -c user.email="bengarnet@mac.lan" commit …` with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `telegram-alerts`; pushing `main` deploys the app (GitHub Pages), so merge/push only in Task 7 with Ben's OK. Push needs `gh auth switch -u bookcrewcode` first.

## Review Focus

- A Canvas deadline at 23:59 local is stored as 03:59Z the next day: the 6pm heads-up must go out the evening before the **local** due day (pinned in Task 2).
- Sun Nov 1 2026 is the end of daylight saving: block pings must follow local wall time across the change (pinned in Task 2).
- Telegram rejects `callback_data` over 64 bytes: every button built from a uuid key must fit (pinned in Task 2).
- Ben ticks a block in the app before it starts: no ping, no nudge, and it drops out of the top 3 (pinned in Task 2).
- Two cron ticks overlap: the same message must never go out twice; only the tick that wins the `alert_log` insert sends (pinned in Task 4).

---

### Task 1: Database — alert log, settings column, secrets, token RPCs

**Files:**
- No repo files (applied through the MCP). The SQL below is the record.

**Interfaces:**
- Produces: table `public.alert_log` (unique `(user_id, key)`), column `public.user_settings.telegram jsonb`, Vault secrets `telegram_webhook_secret` and `alerts_cron_secret`, RPCs `public.set_telegram_token(p_token text) → text` and `public.telegram_status() → table(is_set boolean, hint text, linked boolean, bot_username text, blocked boolean, paused_until text)`.

- [ ] **Step 1: Create the branch**

```bash
cd ~/Downloads/daily && git checkout -b telegram-alerts
```

- [ ] **Step 2: Confirm the pieces the migration relies on exist**

`execute_sql`:

```sql
select
  (select count(*) from pg_proc where proname = 'gen_random_bytes') as has_pgcrypto,
  (select count(*) from information_schema.columns where table_name = 'user_settings' and column_name = 'telegram') as has_telegram_col,
  (select count(*) from information_schema.tables where table_name = 'alert_log') as has_alert_log;
```

Expected: `has_pgcrypto ≥ 1`, `has_telegram_col = 0`, `has_alert_log = 0`.

- [ ] **Step 3: Apply the migration**

`apply_migration` name `telegram_alerts`:

```sql
create table public.alert_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  kind text not null check (kind in ('plan','block','nudge','due_eve','bundle')),
  day date not null,
  ref_id uuid,
  state text not null check (state in ('held','sent','started','done','snoozed','skipped','failed')),
  snooze_until timestamptz,
  tg_message_id bigint,
  tries int not null default 0,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);
create index alert_log_user_day on public.alert_log (user_id, day);
create index alert_log_user_held on public.alert_log (user_id) where state = 'held';
alter table public.alert_log enable row level security;
create policy "alert_log owner reads" on public.alert_log for select using (auth.uid() = user_id);

alter table public.user_settings add column if not exists telegram jsonb not null default '{}'::jsonb;

select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'telegram_webhook_secret', 'Telegram alerts: webhook secret_token');
select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'alerts_cron_secret', 'Telegram alerts: cron secret for the alerts function');

create or replace function public.set_telegram_token(p_token text)
returns text language plpgsql security definer set search_path to '' as $$
declare
  v_id uuid;
  v_tok text := btrim(coalesce(p_token, ''));
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if auth.uid() <> 'f0e1e204-aa54-4a45-bbb5-99c83114fecb'::uuid then raise exception 'not permitted'; end if;
  if v_tok !~ '^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$' then
    raise exception 'that does not look like a bot token from BotFather (numbers, a colon, then letters)';
  end if;
  select id into v_id from vault.secrets where name = 'telegram_bot_token' limit 1;
  if v_id is null then
    perform vault.create_secret(v_tok, 'telegram_bot_token', 'Telegram alerts bot token (set from the app)');
  else
    perform vault.update_secret(v_id, v_tok, 'telegram_bot_token', 'Telegram alerts bot token (set from the app)');
  end if;
  return 'saved';
end; $$;
revoke all on function public.set_telegram_token(text) from public, anon;
grant execute on function public.set_telegram_token(text) to authenticated;

create or replace function public.telegram_status()
returns table(is_set boolean, hint text, linked boolean, bot_username text, blocked boolean, paused_until text)
language plpgsql security definer set search_path to '' as $$
declare t jsonb;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select coalesce(us.telegram, '{}'::jsonb) into t from public.user_settings us where us.user_id = auth.uid();
  t := coalesce(t, '{}'::jsonb);
  return query select
    exists (select 1 from vault.secrets s where s.name = 'telegram_bot_token'),
    (select '…' || right(d.decrypted_secret, 4) from vault.decrypted_secrets d where d.name = 'telegram_bot_token' limit 1),
    (jsonb_typeof(t->'chat_id') = 'number'),
    t->>'bot_username',
    coalesce((t->>'blocked')::boolean, false),
    t->>'paused_until';
end; $$;
revoke all on function public.telegram_status() from public, anon;
grant execute on function public.telegram_status() to authenticated;
```

- [ ] **Step 4: Verify, including that a token from anyone but Ben is refused**

`execute_sql`:

```sql
select
  (select count(*) from vault.secrets where name in ('telegram_webhook_secret','alerts_cron_secret')) as secrets,
  (select count(*) from information_schema.columns where table_name = 'user_settings' and column_name = 'telegram') as telegram_col,
  (select relrowsecurity from pg_class where relname = 'alert_log') as rls_on;
```

Expected: `secrets = 2`, `telegram_col = 1`, `rls_on = true`.

Then, in its own `execute_sql` (the error is the expected result):

```sql
begin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select public.set_telegram_token('123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
rollback;
```

Expected: `ERROR: not permitted`.

And the status as Ben (no token yet):

```sql
begin;
select set_config('request.jwt.claims', '{"sub":"f0e1e204-aa54-4a45-bbb5-99c83114fecb","role":"authenticated"}', true);
set local role authenticated;
select * from public.telegram_status();
rollback;
```

Expected: one row, `is_set = false`, `linked = false`, `blocked = false`.

- [ ] **Step 5: Record the migration in the spec and commit**

Append to the end of `docs/superpowers/specs/2026-10-15-telegram-alerts-design.md`:

```markdown
## Applied

- 2026-10-15: migration `telegram_alerts` (alert_log, user_settings.telegram, two generated vault secrets, set_telegram_token, telegram_status).
```

```bash
cd ~/Downloads/daily && git add docs/superpowers/specs/2026-10-15-telegram-alerts-design.md docs/superpowers/plans/2026-10-15-telegram-alerts.md
git -c user.name="Ben Garnet" -c user.email="bengarnet@mac.lan" commit -m "Telegram alerts: spec, plan, and the database (alert_log, settings, token RPCs)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The planner (pure, fully tested)

**Files:**
- Create: `supabase/functions/alerts/plan.ts`
- Test: `supabase/functions/alerts/plan.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (exported from `plan.ts`): types `Block`, `DayItem`, `Deadline`, `AlertKind`, `LogState`, `LogRow`, `Settings`, `Btn`, `Alert`, `Clock`, `Input`; constants `APP_URL`, `DEFAULT_SETTINGS`, `NUDGE_AFTER`, `SNOOZE_MIN`, `STALE_MIN`, `PLAN_STALE_MIN`, `DUE_EVE_AT`, `BUNDLE_GAP_MIN`, `MAX_TRIES`; functions `readSettings(raw: unknown): Settings`, `toMin(hhmm: string): number`, `localClock(now: Date, tz: string): Clock`, `localDay(iso: string, tz: string): string`, `addDays(day: string, n: number): string`, `daysBetween(a: string, b: string): number`, `prettyDay(day: string): string`, `shortCourse(course: string): string`, `quietAt(min: number, s: Settings, blocks: Block[], except?: string | null): "night" | "class" | "gym" | null`, `pickTop3(inp: Input, c: Clock): string[]`, `planText(inp: Input, c: Clock, top3: string[], held: LogRow[]): string`, `addSteps(text: string, top3: string[], steps: string[]): string`, `planAlerts(inp: Input): Alert[]`.
- Callback data format on buttons: `"<code>|<key>"`, code `s` Starting, `d` Done, `z` Snooze, `k` Skip. Keys: `plan:<day>`, `block:<blockId>:<day>`, `nudge:<blockId>:<day>`, `due_eve:<deadlineId>`, `bundle:<day>:<min>`, `today:<day>:<min>`.

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/alerts/plan.test.ts`:

```ts
// Unit tests for the Telegram alerts planner.
// Run: npx --yes tsx --test supabase/functions/alerts/plan.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planAlerts, localClock, localDay, quietAt, readSettings, shortCourse, addSteps, pickTop3,
  DEFAULT_SETTINGS,
  type Alert, type AlertKind, type Block, type Deadline, type Input, type LogRow, type LogState, type Settings,
} from "./plan.ts";

// ─── fixtures: Ben's real Friday, Oct 16 2026 (EDT, UTC-4) ─────────────────
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const B = (n: number, kind: string, label: string, start_t: string, end_t: string): Block =>
  ({ id: U(n), kind, label, location: "", start_t, end_t });
const FRI: Block[] = [
  B(1, "class", "Intro to Econ-Macro", "08:30", "09:50"),
  B(2, "gym", "Gym 1.5h", "10:15", "11:45"),
  B(3, "read", "Read 40 min", "12:00", "12:40"),
  B(4, "drill", "Reading drill 15 min", "12:40", "12:55"),
  B(5, "drive", "Drive", "13:00", "22:00"),
];
const edt = (y: number, mo: number, d: number, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h + 4, m));
};
const fri = (hhmm: string) => edt(2026, 10, 16, hhmm);
const SET: Settings = { ...DEFAULT_SETTINGS, chat_id: 42 };
const row = (key: string, kind: AlertKind, state: LogState, extra: Partial<LogRow> = {}): LogRow =>
  ({ key, kind, state, snooze_until: null, tries: 0, updated_at: "2026-10-16T04:00:00Z", meta: null, ...extra });
const PLANNED = [row("plan:2026-10-16", "plan", "sent")];
const input = (now: Date, over: Partial<Input> = {}): Input =>
  ({ now, settings: SET, blocks: FRI, items: [], top3: [], deadlines: [], log: PLANNED, ...over });
const DL = (n: number, title: string, due_at: string, start_by: string | null, kind = "assignment", course = "21:640:114:07 PRECALCULUS"): Deadline =>
  ({ id: U(100 + n), title, course, kind, due_at, start_by, goal_id: null });
const TEST1 = DL(1, "In-Class Test #1 (midterm exam, 20%)", "2026-10-23T03:59:00Z", "2026-10-15", "exam", "Fall 2026 (21:512:368:01)");
const HW5 = DL(2, "HW 5 Set 5", "2026-10-26T03:59:00Z", "2026-10-22");
const kinds = (as: Alert[]) => as.map((a) => `${a.kind}:${a.action}`);
const blockKey = (n: number, day = "2026-10-16") => `block:${U(n)}:${day}`;

test("localClock reads New York wall time, across the DST change", () => {
  assert.deepEqual(localClock(fri("07:45"), "America/New_York"), { day: "2026-10-16", min: 465, weekday: 5 });
  // Sun Nov 1 2026, clocks fall back at 2am: 14:00Z is 09:00 EST
  assert.deepEqual(localClock(new Date("2026-11-01T14:00:00Z"), "America/New_York"), { day: "2026-11-01", min: 540, weekday: 0 });
});

test("a Canvas 23:59 deadline stored as 03:59Z belongs to the earlier local day", () => {
  assert.equal(localDay("2026-10-26T03:59:00Z", "America/New_York"), "2026-10-25");
});

test("quietAt: night wraps midnight; class and gym are quiet; a block is never quiet for its own ping", () => {
  assert.equal(quietAt(23 * 60, SET, FRI), "night");
  assert.equal(quietAt(7 * 60 + 29, SET, FRI), "night");
  assert.equal(quietAt(7 * 60 + 30, SET, FRI), null);
  assert.equal(quietAt(9 * 60, SET, FRI), "class");
  assert.equal(quietAt(10 * 60 + 30, SET, FRI), "gym");
  assert.equal(quietAt(10 * 60 + 30, SET, FRI, U(2)), null);
});

test("nothing at all when the chat isn't linked or alerts are paused", () => {
  assert.deepEqual(planAlerts(input(fri("10:15"), { settings: DEFAULT_SETTINGS })), []);
  assert.deepEqual(planAlerts(input(fri("10:15"), { settings: { ...SET, paused_until: fri("12:00").toISOString() } })), []);
});

test("morning plan at 7:45: started deadlines first, then the day's blocks; a countdown to the exam", () => {
  const as = planAlerts(input(fri("07:45"), { deadlines: [TEST1, HW5], log: [] }));
  const plan = as.find((a) => a.kind === "plan")!;
  assert.equal(plan.key, "plan:2026-10-16");
  assert.equal(plan.action, "send");
  assert.deepEqual(plan.top3, ["In-Class Test #1 (midterm exam, 20%), due Thu Oct 22", "Gym 1.5h at 10:15", "Read 40 min at 12:00"]);
  assert.match(plan.text, /Coming up\n- In-Class Test #1 \(midterm exam, 20%\): in 6 days/);
  assert.ok(!plan.text.includes("Macro"), "classes are not plan items");
});

test("the plan uses Ben's own top 3 when he set one, sends once, and waits out the night", () => {
  const own = planAlerts(input(fri("07:45"), { top3: ["Finish HW 5", "", "Call mom"], log: [] })).find((a) => a.kind === "plan")!;
  assert.deepEqual(own.top3, ["Finish HW 5", "Call mom"]);
  assert.equal(planAlerts(input(fri("08:00"))).filter((a) => a.kind === "plan").length, 0);
  const early = { ...SET, morning_at: "07:00" };
  assert.equal(planAlerts(input(fri("07:10"), { settings: early, log: [] })).filter((a) => a.kind === "plan").length, 0);
  assert.equal(planAlerts(input(fri("07:30"), { settings: early, log: [] })).filter((a) => a.kind === "plan").length, 1);
});

test("a block pings at its start, the gym included; classes never ping", () => {
  const as = planAlerts(input(fri("10:15")));
  assert.deepEqual(kinds(as), ["block:send"]);
  assert.equal(as[0].key, blockKey(2));
  assert.equal(as[0].text, "Gym 1.5h\nNow · 10:15–11:45");
  assert.equal(planAlerts(input(fri("08:30"))).filter((a) => a.kind === "block").length, 0);
});

test("a block already ticked in the app gets no ping, no nudge, and stays out of the top 3", () => {
  const items = [{ id: "i1", time: "10:15", what: "Gym 1.5h", done: true, block_id: U(2) }];
  assert.deepEqual(planAlerts(input(fri("10:15"), { items })), []);
  assert.deepEqual(planAlerts(input(fri("10:30"), { items, log: [...PLANNED, row(blockKey(2), "block", "sent")] })), []);
  const top = pickTop3(input(fri("07:45"), { items }), localClock(fri("07:45"), SET.tz));
  assert.ok(!top.some((t) => t.startsWith("Gym")));
});

test("a ping that starts inside another block's quiet window is held", () => {
  const blocks = [B(1, "class", "Precalculus", "10:00", "10:55"), B(9, "study", "Flashcards", "10:30", "11:00")];
  assert.deepEqual(kinds(planAlerts(input(fri("10:30"), { blocks }))), ["block:hold"]);
});

test("a start more than an hour old never pings", () => {
  assert.deepEqual(planAlerts(input(fri("11:20"))), []);
});

test("one nudge 15 minutes in when nothing was tapped — never twice, never after a tap or the block's end", () => {
  const sent = [...PLANNED, row(blockKey(2), "block", "sent")];
  const n = planAlerts(input(fri("10:30"), { log: sent }));
  assert.deepEqual(kinds(n), ["nudge:send"]);
  assert.equal(n[0].text, "Gym 1.5h\nStarted 15 min ago. Still on?");
  assert.ok(n[0].buttons[0].every((b) => b.data?.endsWith(blockKey(2))), "nudge buttons act on the block's row");
  assert.deepEqual(planAlerts(input(fri("10:35"), { log: [...sent, row(`nudge:${U(2)}:2026-10-16`, "nudge", "sent")] })), []);
  assert.deepEqual(planAlerts(input(fri("10:30"), { log: [...PLANNED, row(blockKey(2), "block", "started")] })), []);
  assert.deepEqual(planAlerts(input(fri("10:29"), { log: sent })), []);
  assert.deepEqual(planAlerts(input(fri("11:50"), { log: sent })), []);
});

test("snooze: the same key pings again once the snooze runs out", () => {
  const z = [...PLANNED, row(blockKey(2), "block", "snoozed", { snooze_until: fri("10:30").toISOString() })];
  assert.deepEqual(planAlerts(input(fri("10:25"), { log: z })), []);
  const again = planAlerts(input(fri("10:30"), { log: z }));
  assert.deepEqual(kinds(again), ["block:send"]);
  assert.equal(again[0].key, blockKey(2));
});

test("6pm the evening before: uses the local due day, rings silently on a drive, holds at the gym", () => {
  const sat = [B(6, "drive", "Drive", "10:30", "20:30")];
  const eve = planAlerts(input(edt(2026, 10, 24, "18:00"), { blocks: sat, deadlines: [HW5], log: [row("plan:2026-10-24", "plan", "sent")] }));
  assert.deepEqual(kinds(eve), ["due_eve:send"]);
  assert.equal(eve[0].text, "Due tomorrow: HW 5 Set 5 (Precalculus)");
  assert.equal(eve[0].silent, true);
  assert.deepEqual(planAlerts(input(edt(2026, 10, 25, "18:00"), { blocks: [], deadlines: [HW5], log: [row("plan:2026-10-25", "plan", "sent")] })), []);
  const mon = [B(7, "gym", "Gym 1.5h", "18:00", "19:30")];
  const quiz = DL(3, "Quiz 4", "2026-10-21T03:59:00Z", "2026-10-19", "quiz");
  const gym = planAlerts(input(edt(2026, 10, 19, "18:00"), { blocks: mon, deadlines: [quiz], log: [row("plan:2026-10-19", "plan", "sent")] }));
  assert.deepEqual(kinds(gym).sort(), ["block:send", "due_eve:hold"]);
});

test("over the cap: pings wait for a bundle and nudges are dropped", () => {
  const busy = Array.from({ length: 10 }, (_, i) => row(`block:x${i}:2026-10-16`, "block", "sent"));
  assert.deepEqual(kinds(planAlerts(input(fri("10:15"), { log: [...PLANNED, ...busy] }))), ["block:hold"]);
  assert.deepEqual(planAlerts(input(fri("10:30"), { log: [...PLANNED, ...busy.slice(0, 9), row(blockKey(2), "block", "sent")] })), []);
});

test("held items arrive as one bundle once nothing is quiet — after the plan, at most hourly", () => {
  const heldRead = row(blockKey(3), "block", "held", { meta: { text: "Read 40 min\nNow · 12:00–12:40" } });
  const b = planAlerts(input(fri("12:10"), { log: [...PLANNED, heldRead] }));
  assert.deepEqual(kinds(b), ["bundle:send"]);
  assert.equal(b[0].text, "While you were busy\n- Read 40 min");
  assert.deepEqual(b[0].absorbs, [blockKey(3)]);
  assert.deepEqual(planAlerts(input(fri("09:00"), { log: [...PLANNED, heldRead] })).filter((a) => a.kind === "bundle"), []);
  const recent = row("bundle:2026-10-16:700", "bundle", "sent", { updated_at: fri("11:40").toISOString() });
  assert.deepEqual(planAlerts(input(fri("12:10"), { log: [...PLANNED, heldRead, recent] })).filter((a) => a.kind === "bundle"), []);
});

test("the morning plan absorbs what was held overnight", () => {
  const held = row("due_eve:abc", "due_eve", "held", { meta: { text: "Due tomorrow: Quiz 4" } });
  const p = planAlerts(input(fri("07:45"), { log: [held] })).find((a) => a.kind === "plan")!;
  assert.deepEqual(p.absorbs, ["due_eve:abc"]);
  assert.match(p.text, /Held for you\n- Due tomorrow: Quiz 4/);
});

test("long held lists are trimmed so a message stays far under Telegram's 4096-char limit", () => {
  const many = Array.from({ length: 20 }, (_, i) => row(`due_eve:${i}`, "due_eve", "held", { meta: { text: `Item ${i}` } }));
  const b = planAlerts(input(fri("12:10"), { log: [...PLANNED, ...many] })).find((a) => a.kind === "bundle")!;
  assert.equal(b.absorbs.length, 20);
  assert.match(b.text, /…and 8 more$/);
});

test("button data fits Telegram's 64-byte callback limit", () => {
  const as = [...planAlerts(input(fri("10:15"))), ...planAlerts(input(fri("10:30"), { log: [...PLANNED, row(blockKey(2), "block", "sent")] }))];
  assert.ok(as.length >= 2);
  for (const a of as) for (const r of a.buttons) for (const b of r) {
    if (b.data) assert.ok(new TextEncoder().encode(b.data).length <= 64, b.data);
  }
});

test("DST end day: a 9:00 block pings at 9:00 EST, not an hour off", () => {
  const sun = [B(8, "read", "Read 40 min", "09:00", "09:40")];
  const log = [row("plan:2026-11-01", "plan", "sent")];
  assert.deepEqual(kinds(planAlerts(input(new Date("2026-11-01T14:00:00Z"), { blocks: sun, log }))), ["block:send"]);
  assert.deepEqual(planAlerts(input(new Date("2026-11-01T13:00:00Z"), { blocks: sun, log })), []);
});

test("addSteps puts a first step under each top-3 line and skips missing ones", () => {
  assert.equal(addSteps("Today\n\nTop 3\n1. A\n2. B", ["A", "B"], ["Open it", ""]), "Today\n\nTop 3\n1. A\n   First step: Open it\n2. B");
});

test("readSettings fills gaps with the defaults", () => {
  assert.deepEqual(readSettings(null), DEFAULT_SETTINGS);
  const s = readSettings({ chat_id: 7, quiet: { gym: false } });
  assert.equal(s.chat_id, 7);
  assert.equal(s.quiet.gym, false);
  assert.equal(s.quiet.class, true);
});

test("shortCourse turns Canvas codes into a plain name, or nothing", () => {
  assert.equal(shortCourse("21:640:114:07 PRECALCULUS"), "Precalculus");
  assert.equal(shortCourse("21:220:102:03 INTRO TO ECON-MACRO"), "Econ-Macro");
  assert.equal(shortCourse("Fall 2026 (21:512:368:01)"), "");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd ~/Downloads/daily && npx --yes tsx --test supabase/functions/alerts/plan.test.ts`
Expected: FAIL — `Cannot find module './plan.ts'`.

- [ ] **Step 3: Write the planner**

Create `supabase/functions/alerts/plan.ts`:

```ts
// Telegram alerts planner — pure. Given the clock and today's data it decides
// what to send now, what to hold for later, and what a bundle delivers.
// No I/O here: index.ts loads the data, runs planAlerts, then claims a log
// row per message and sends it.
// Tests: npx --yes tsx --test supabase/functions/alerts/plan.test.ts

export type Block = { id: string; label: string; kind: string; location: string; start_t: string; end_t: string };
export type DayItem = { id: string; time: string; what: string; done?: boolean; at?: number; src?: string; block_id?: string; goal_id?: string };
export type Deadline = { id: string; title: string; course: string; kind: string; due_at: string; start_by: string | null; goal_id: string | null };
export type AlertKind = "plan" | "block" | "nudge" | "due_eve" | "bundle";
export type LogState = "held" | "sent" | "started" | "done" | "snoozed" | "skipped" | "failed";
export type LogRow = {
  key: string; kind: AlertKind; state: LogState; snooze_until: string | null;
  tries: number; updated_at: string; meta: { text?: string } | null;
};
export type Settings = {
  chat_id: number | null; morning_at: string; tz: string;
  quiet: { class: boolean; gym: boolean; night: [string, string] };
  drive_silent: boolean; paused_until: string | null; cap: number;
};
export type Btn = { text: string; data?: string; url?: string };
export type Alert = {
  key: string; kind: AlertKind; refId: string | null; text: string; buttons: Btn[][];
  silent: boolean; action: "send" | "hold"; absorbs: string[]; top3: string[];
};
export type Clock = { day: string; min: number; weekday: number };
export type Input = {
  now: Date; settings: Settings; blocks: Block[]; items: DayItem[]; top3: string[];
  deadlines: Deadline[]; log: LogRow[];   // today's rows plus any still-held rows
};

export const APP_URL = "https://bookcrewcode.github.io/daily/";
export const NUDGE_AFTER = 15;     // minutes into a block before the one nudge
export const SNOOZE_MIN = 15;
export const STALE_MIN = 60;       // a trigger older than this never fires
export const PLAN_STALE_MIN = 240;
export const DUE_EVE_AT = "18:00";
export const BUNDLE_GAP_MIN = 60;
export const MAX_TRIES = 3;
const MAX_LIST = 12;

export const DEFAULT_SETTINGS: Settings = {
  chat_id: null, morning_at: "07:45", tz: "America/New_York",
  quiet: { class: true, gym: true, night: ["22:00", "07:30"] },
  drive_silent: true, paused_until: null, cap: 10,
};

// user_settings.telegram can be partial or from an older shape; fill the gaps.
export function readSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const q = (r.quiet && typeof r.quiet === "object" ? r.quiet : {}) as Record<string, unknown>;
  const hhmm = (v: unknown, d: string) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : d);
  const night: [string, string] = Array.isArray(q.night) && q.night.length === 2
    ? [hhmm(q.night[0], "22:00"), hhmm(q.night[1], "07:30")]
    : DEFAULT_SETTINGS.quiet.night;
  return {
    chat_id: typeof r.chat_id === "number" ? r.chat_id : null,
    morning_at: hhmm(r.morning_at, DEFAULT_SETTINGS.morning_at),
    tz: typeof r.tz === "string" && r.tz ? r.tz : DEFAULT_SETTINGS.tz,
    quiet: { class: q.class !== false, gym: q.gym !== false, night },
    drive_silent: r.drive_silent !== false,
    paused_until: typeof r.paused_until === "string" ? r.paused_until : null,
    cap: typeof r.cap === "number" && r.cap > 0 ? r.cap : DEFAULT_SETTINGS.cap,
  };
}

export const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Wall-clock day, minute-of-day and weekday in `tz` — DST-safe via Intl.
export function localClock(now: Date, tz: string): Clock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    min: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: WD.indexOf(get("weekday")),
  };
}
export const localDay = (iso: string, tz: string): string => localClock(new Date(iso), tz).day;

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86_400_000);
}
export function prettyDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MONTHS[m - 1]} ${d}`;
}

// "21:640:114:07 PRECALCULUS" → "Precalculus"; "Fall 2026 (21:512:368:01)" → "".
export function shortCourse(course: string): string {
  const t = course
    .replace(/\b\d{2}:\d{3}:\d{3}(?::\d{2})?\b/g, "")
    .replace(/^\s*(fall|spring|summer|winter)\s+\d{4}\s*\(\s*\)\s*$/i, "")
    .replace(/\bintro to\s+/i, "")
    .trim();
  return t ? t.toLowerCase().replace(/\b[a-z]/g, (x) => x.toUpperCase()) : "";
}
const courseTag = (course: string) => { const s = shortCourse(course); return s ? ` (${s})` : ""; };

// Which quiet window covers `min`. A block's own ping and nudge are never
// held by that same block (`except`) — "Gym now" is the point of the gym block.
export function quietAt(min: number, s: Settings, blocks: Block[], except: string | null = null): "night" | "class" | "gym" | null {
  const [ns, ne] = s.quiet.night.map(toMin);
  if (ns > ne ? (min >= ns || min < ne) : (min >= ns && min < ne)) return "night";
  for (const b of blocks) {
    if (b.id === except) continue;
    const quiet = (b.kind === "class" && s.quiet.class) || (b.kind === "gym" && s.quiet.gym);
    if (quiet && min >= toMin(b.start_t) && min < toMin(b.end_t)) return b.kind as "class" | "gym";
  }
  return null;
}
const driving = (min: number, blocks: Block[]) =>
  blocks.some((b) => b.kind === "drive" && min >= toMin(b.start_t) && min < toMin(b.end_t));

const btn = (text: string, code: "s" | "d" | "z" | "k", key: string): Btn => ({ text, data: `${code}|${key}` });
const firstLine = (r: LogRow) => (r.meta?.text ?? r.key).split("\n")[0];
function heldLines(rows: LogRow[]): string[] {
  const lines = rows.slice(0, MAX_LIST).map((r) => `- ${firstLine(r)}`);
  return rows.length > MAX_LIST ? [...lines, `…and ${rows.length - MAX_LIST} more`] : lines;
}

export function pickTop3(inp: Input, c: Clock): string[] {
  const own = inp.top3.map((t) => String(t ?? "").trim()).filter(Boolean);
  if (own.length) return own.slice(0, 3);
  const tz = inp.settings.tz;
  const started = inp.deadlines
    .filter((d) => d.start_by !== null && d.start_by <= c.day && localDay(d.due_at, tz) >= c.day)
    .sort((a, b) => a.due_at.localeCompare(b.due_at))
    .map((d) => `${d.title}${courseTag(d.course)}, due ${prettyDay(localDay(d.due_at, tz))}`);
  const done = new Set(inp.items.filter((i) => i.done && i.block_id).map((i) => i.block_id));
  const blocks = inp.blocks
    .filter((b) => b.kind !== "class" && toMin(b.end_t) > c.min && !done.has(b.id))
    .sort((a, b) => toMin(a.start_t) - toMin(b.start_t))
    .map((b) => `${b.label} at ${b.start_t}`);
  return [...started, ...blocks].slice(0, 3);
}

export function planText(inp: Input, c: Clock, top3: string[], held: LogRow[]): string {
  const tz = inp.settings.tz;
  const L: string[] = [`Today · ${prettyDay(c.day)}`];
  if (top3.length) { L.push("", "Top 3"); top3.forEach((t, i) => L.push(`${i + 1}. ${t}`)); }
  else L.push("", "Nothing scheduled. A free day.");
  const dueToday = inp.deadlines.filter((d) => localDay(d.due_at, tz) === c.day);
  if (dueToday.length) { L.push("", "Due today"); dueToday.forEach((d) => L.push(`- ${d.title}${courseTag(d.course)}`)); }
  const startToday = inp.deadlines.filter((d) => d.start_by === c.day && localDay(d.due_at, tz) !== c.day);
  if (startToday.length) {
    L.push("", "Start today");
    startToday.forEach((d) => L.push(`- ${d.title}${courseTag(d.course)}, due ${prettyDay(localDay(d.due_at, tz))}`));
  }
  const exams = inp.deadlines
    .filter((d) => d.kind === "exam")
    .map((d) => ({ d, n: daysBetween(c.day, localDay(d.due_at, tz)) }))
    .filter((x) => x.n >= 1 && x.n <= 14);
  if (exams.length) {
    L.push("", "Coming up");
    exams.forEach(({ d, n }) => L.push(`- ${d.title}${courseTag(d.course)}: ${n === 1 ? "tomorrow" : `in ${n} days`}`));
  }
  if (held.length) L.push("", "Held for you", ...heldLines(held));
  return L.join("\n");
}

export function addSteps(text: string, top3: string[], steps: string[]): string {
  let out = text;
  top3.forEach((t, i) => {
    const step = (steps[i] ?? "").trim();
    if (step) out = out.replace(`${i + 1}. ${t}`, `${i + 1}. ${t}\n   First step: ${step}`);
  });
  return out;
}

export function planAlerts(inp: Input): Alert[] {
  const s = inp.settings;
  if (s.chat_id === null) return [];
  if (s.paused_until && new Date(s.paused_until) > inp.now) return [];
  const c = localClock(inp.now, s.tz);
  const byKey = new Map(inp.log.map((r) => [r.key, r] as const));
  const silent = s.drive_silent && driving(c.min, inp.blocks);
  const fresh = (t: number, stale = STALE_MIN) => c.min >= t && c.min - t <= stale;
  // a logged key goes again only when its snooze ran out or its send failed
  const retry = (r: LogRow | undefined) => !!r && (
    (r.state === "snoozed" && !!r.snooze_until && new Date(r.snooze_until) <= inp.now) ||
    (r.state === "failed" && r.tries < MAX_TRIES));
  const doneBlocks = new Set(inp.items.filter((i) => i.done && i.block_id).map((i) => i.block_id as string));
  const held = inp.log.filter((r) => r.state === "held");
  const base = { silent, absorbs: [] as string[], top3: [] as string[] };
  const out: Alert[] = [];

  // 1. the morning plan — waits out the night; never held by a class or the gym
  const planKey = `plan:${c.day}`;
  const planRow = byKey.get(planKey);
  if ((!planRow || retry(planRow)) && fresh(toMin(s.morning_at), PLAN_STALE_MIN) && quietAt(c.min, s, inp.blocks) !== "night") {
    const top3 = pickTop3(inp, c);
    out.push({ ...base, key: planKey, kind: "plan", refId: null, text: planText(inp, c, top3, held),
      buttons: [[{ text: "Open Daily", url: APP_URL }]], action: "send", absorbs: held.map((r) => r.key), top3 });
  }

  // 2. a ping when each non-class block starts, or when its snooze runs out
  for (const b of inp.blocks) {
    if (b.kind === "class" || doneBlocks.has(b.id)) continue;
    const key = `block:${b.id}:${c.day}`;
    const r = byKey.get(key);
    if (r ? !retry(r) : !fresh(toMin(b.start_t))) continue;
    if (c.min >= toMin(b.end_t)) continue;
    out.push({ ...base, key, kind: "block", refId: b.id, text: `${b.label}\nNow · ${b.start_t}–${b.end_t}`,
      buttons: [[btn("Starting", "s", key), btn("Done", "d", key), btn("Snooze 15m", "z", key)]],
      action: quietAt(c.min, s, inp.blocks, b.id) ? "hold" : "send" });
  }

  // 3. one nudge, 15 minutes in, when nothing was tapped and nothing ticked
  for (const b of inp.blocks) {
    if (b.kind === "class" || doneBlocks.has(b.id)) continue;
    const bkey = `block:${b.id}:${c.day}`;
    const nkey = `nudge:${b.id}:${c.day}`;
    if (byKey.get(bkey)?.state !== "sent" || byKey.has(nkey)) continue;
    const t = toMin(b.start_t);
    if (c.min < t + NUDGE_AFTER || c.min >= toMin(b.end_t)) continue;
    if (quietAt(c.min, s, inp.blocks, b.id)) continue; // a nudge only matters now; it is never held
    out.push({ ...base, key: nkey, kind: "nudge", refId: b.id, text: `${b.label}\nStarted ${c.min - t} min ago. Still on?`,
      buttons: [[btn("Starting", "s", bkey), btn("Done", "d", bkey), btn("Skip today", "k", bkey)]], action: "send" });
  }

  // 4. 6pm the evening before the LOCAL due day
  if (fresh(toMin(DUE_EVE_AT))) {
    const tomorrow = addDays(c.day, 1);
    for (const d of inp.deadlines) {
      const key = `due_eve:${d.id}`;
      if (localDay(d.due_at, s.tz) !== tomorrow) continue;
      if (byKey.has(key) && !retry(byKey.get(key))) continue;
      out.push({ ...base, key, kind: "due_eve", refId: d.id, text: `Due tomorrow: ${d.title}${courseTag(d.course)}`,
        buttons: [[btn("Done", "d", key), { text: "Open Daily", url: APP_URL }]],
        action: quietAt(c.min, s, inp.blocks) ? "hold" : "send" });
    }
  }

  // 5. the cap: past it, pings wait for a bundle and nudges are dropped
  let used = inp.log.filter((r) => (r.kind === "block" || r.kind === "nudge" || r.kind === "due_eve")
    && (r.state === "sent" || r.state === "started" || r.state === "done" || r.state === "snoozed" || r.state === "skipped")).length;
  const capped: Alert[] = [];
  for (const a of out) {
    if (a.kind === "plan" || a.action !== "send" || byKey.has(a.key)) { capped.push(a); continue; }
    if (used < s.cap) { used++; capped.push(a); continue; }
    if (a.kind !== "nudge") capped.push({ ...a, action: "hold" });
  }

  // 6. one bundle delivers what was held, once nothing is quiet, after the plan, at most hourly
  const planGoing = capped.some((a) => a.kind === "plan");
  const planDone = (!!planRow && planRow.state !== "held") || c.min > toMin(s.morning_at) + PLAN_STALE_MIN;
  const lastBundle = inp.log.filter((r) => r.kind === "bundle").map((r) => Date.parse(r.updated_at)).sort((x, y) => y - x)[0];
  const gapOk = lastBundle === undefined || (inp.now.getTime() - lastBundle) / 60_000 >= BUNDLE_GAP_MIN;
  if (held.length && !planGoing && planDone && !quietAt(c.min, s, inp.blocks) && gapOk) {
    capped.push({ ...base, key: `bundle:${c.day}:${c.min}`, kind: "bundle", refId: null,
      text: ["While you were busy", ...heldLines(held)].join("\n"),
      buttons: [[{ text: "Open Daily", url: APP_URL }]], action: "send", absorbs: held.map((r) => r.key) });
  }
  return capped;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd ~/Downloads/daily && npx --yes tsx --test supabase/functions/alerts/plan.test.ts`
Expected: PASS, 22 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
cd ~/Downloads/daily && git add supabase/functions/alerts/plan.ts supabase/functions/alerts/plan.test.ts
git -c user.name="Ben Garnet" -c user.email="bengarnet@mac.lan" commit -m "Telegram alerts: the pure planner (plan, block pings, one nudge, 6pm heads-up, quiet windows, cap, bundles)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Ticking a block from Telegram, the Card's way

**Files:**
- Create: `supabase/functions/alerts/items.ts`
- Test: `supabase/functions/alerts/items.test.ts`

**Interfaces:**
- Consumes: `Block`, `DayItem` types from `./plan.ts`.
- Produces: `newItemId(): string` (same format as `src/lib/theGame.ts`), `tickBlockItem(items: DayItem[], seeded: boolean, blocks: Block[], blockId: string, atSec: number, newId?: () => string): DayItem[]`.

- [ ] **Step 1: Write the failing tests**

Create `supabase/functions/alerts/items.test.ts`:

```ts
// Run: npx --yes tsx --test supabase/functions/alerts/items.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tickBlockItem, newItemId } from "./items.ts";
import type { Block, DayItem } from "./plan.ts";

const blocks: Block[] = [
  { id: "b-class", kind: "class", label: "Precalculus", location: "Conklin 349", start_t: "10:00", end_t: "10:55" },
  { id: "b-gym", kind: "gym", label: "Gym 1.5h", location: "", start_t: "17:00", end_t: "18:30" },
];
let n = 0;
const ids = () => `t${++n}`;

test("unseeded day: seeds the timetable like the Card, then ticks the block", () => {
  const mine: DayItem[] = [{ id: "a", time: "", what: "Call mom" }];
  const out = tickBlockItem(mine, false, blocks, "b-gym", 61_200, ids);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], mine[0]);
  assert.deepEqual(out[1], { id: "t1", time: "10:00", what: "Precalculus · Conklin 349", src: "block", block_id: "b-class" });
  assert.deepEqual(out[2], { id: "t2", time: "17:00", what: "Gym 1.5h", src: "block", block_id: "b-gym", done: true, at: 61_200 });
});

test("seeded day: only ticks, never re-adds a block Ben removed", () => {
  const list: DayItem[] = [{ id: "x", time: "17:00", what: "Gym 1.5h", src: "block", block_id: "b-gym" }];
  assert.deepEqual(tickBlockItem(list, true, blocks, "b-gym", 100, ids), [{ ...list[0], done: true, at: 100 }]);
  assert.deepEqual(tickBlockItem(list, true, blocks, "b-class", 100, ids), list);
});

test("newItemId matches the app's id shape", () => {
  assert.match(newItemId(), /^i[0-9a-z]+$/);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd ~/Downloads/daily && npx --yes tsx --test supabase/functions/alerts/items.test.ts`
Expected: FAIL — `Cannot find module './items.ts'`.

- [ ] **Step 3: Write `items.ts`**

```ts
// Ticking a timetable block from a Telegram button, exactly the way the Card
// does it. If the Card hasn't seeded today's blocks yet (Ben hasn't opened the
// app today), seed them first with the same DayItem shape TheCard.tsx writes
// (src "block", block_id, label + location for classes), then tick.
// Tests: npx --yes tsx --test supabase/functions/alerts/items.test.ts

import type { Block, DayItem } from "./plan.ts";

let seq = 0;
// same format as newItemId() in src/lib/theGame.ts
export function newItemId(): string {
  seq = (seq + 1) % 100000;
  return `i${Date.now().toString(36)}${seq.toString(36)}`;
}

export function tickBlockItem(items: DayItem[], seeded: boolean, blocks: Block[], blockId: string, atSec: number, newId: () => string = newItemId): DayItem[] {
  let list = items.slice();
  if (!seeded) {
    const have = new Set(list.map((i) => i.block_id).filter(Boolean));
    list = [...list, ...blocks.filter((b) => !have.has(b.id)).map((b): DayItem => ({
      id: newId(), time: b.start_t,
      what: `${b.label}${(b.kind ?? "class") === "class" && b.location ? ` · ${b.location}` : ""}`.slice(0, 200),
      src: "block", block_id: b.id,
    }))];
  }
  return list.map((i) => (i.block_id === blockId ? { ...i, done: true, at: atSec } : i));
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd ~/Downloads/daily && npx --yes tsx --test supabase/functions/alerts/items.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/Downloads/daily && git add supabase/functions/alerts/items.ts supabase/functions/alerts/items.test.ts
git -c user.name="Ben Garnet" -c user.email="bengarnet@mac.lan" commit -m "Telegram alerts: tick a block from Telegram the same way the Card does

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The `alerts` edge function

**Files:**
- Create: `supabase/functions/alerts/index.ts`

**Interfaces:**
- Consumes: everything exported by `./plan.ts`; `tickBlockItem`, `newItemId` from `./items.ts`; RPC `get_secret`; tables `user_settings`, `class_blocks`, `nights`, `deadlines`, `goals`, `alert_log`.
- Produces: `POST /functions/v1/alerts` with body `{cronSecret, mode?, userId?, key?, dryRun?}`:
  - no mode / `"tick"`: send what's due for every linked user → `{results: [{user, day, min, sent, held}]}`
  - `dryRun: true` (needs `userId`): plan without writing or sending → `{results: [{user, day, min, alerts: [{key, kind, action, silent, text}]}]}`
  - `mode: "today"` + `userId`: send the plan right now (`/today`)
  - `mode: "done"` + `userId` + `key`: apply Done for `block:<id>:<day>` (tick the Card item) or `due_eve:<id>` (close the deadline and its goal) → `{ok: true}` or `{error}`

- [ ] **Step 1: Write `index.ts`**

```ts
// Alerts edge function — sends the Telegram alerts.
//
// CALLERS (all must carry {cronSecret} = vault alerts_cron_secret):
//  - pg_cron every 5 minutes: plan and send what's due for each linked user.
//  - the telegram function: {mode:"today", userId} for /today, and
//    {mode:"done", userId, key} when Ben taps Done.
//  - by hand: {dryRun:true, userId} returns what would go out, sends nothing.
//
// Every message's alert_log row is CLAIMED before the send (insert, or flip a
// snoozed/failed row), so two overlapping ticks can never send the same thing.
// A failed read ends the tick: a failed read is never an empty list.
// verify_jwt=false at the gateway; the cron secret is checked here.

import {
  planAlerts, readSettings, localClock, addSteps,
  type Alert, type Block, type DayItem, type Deadline, type LogRow,
} from "./plan.ts";
import { tickBlockItem, newItemId } from "./items.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SVC = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const OR_BASE = "https://openrouter.ai/api/v1";
const D_FAST = "google/gemini-2.5-flash-lite";

type C = Record<string, unknown>;
type SettingsRow = { user_id: string; telegram: C | null; ai_models: C | null };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const enc = encodeURIComponent;

async function secretOf(name: string): Promise<string> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, { method: "POST", headers: SVC, body: JSON.stringify({ secret_name: name }) });
    return r.ok ? ((await r.json()) as string | null) ?? "" : "";
  } catch { return ""; }
}

async function get<T>(q: string): Promise<T[] | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: SVC });
    if (!r.ok) { console.error(`[alerts] read ${q.split("?")[0]} ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
    return (await r.json()) as T[];
  } catch (e) { console.error(`[alerts] read ${q.split("?")[0]}`, e instanceof Error ? e.message : e); return null; }
}

// POST/PATCH as the service role. null = failed; [] = nothing matched/inserted.
async function rest(method: "POST" | "PATCH", q: string, body: unknown, prefer = "return=representation"): Promise<C[] | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { method, headers: { ...SVC, Prefer: prefer }, body: JSON.stringify(body) });
    if (!r.ok) { console.error(`[alerts] ${method} ${q.split("?")[0]} ${r.status} ${(await r.text()).slice(0, 200)}`); return null; }
    const t = await r.text();
    return t ? (JSON.parse(t) as C[]) : [];
  } catch (e) { console.error(`[alerts] ${method} ${q.split("?")[0]}`, e instanceof Error ? e.message : e); return null; }
}

async function tg(token: string, method: string, body: C): Promise<{ ok: boolean; status: number; result?: C }> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    return { ok: !!d.ok, status: r.status, result: d.result };
  } catch { return { ok: false, status: 0 }; }
}

const keyboard = (a: Alert) => ({
  inline_keyboard: a.buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))),
});

// One cheap model call per morning: a first physical step for each top-3 item.
// Any failure means no steps — the plan still goes out.
async function firstSteps(top3: string[], aiModels: C | null): Promise<string[]> {
  if (!top3.length) return [];
  const key = await secretOf("anthropic_api_key");
  if (!key) return [];
  const sys = "For each task the user lists, write the first small physical step, under 2 minutes, that gets it started, like \"Open MyMathLab and read problem 1\". Reply with exactly one line per task, in the same order, at most 12 words each, no numbering, nothing else.";
  const user = top3.map((t, i) => `${i + 1}. ${t}`).join("\n");
  try {
    let text = "";
    if (key.startsWith("sk-or-")) {
      const m = aiModels?.fast;
      const model = typeof m === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(m) ? m : D_FAST;
      const r = await fetch(`${OR_BASE}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: "system", content: sys }, { role: "user", content: user }] }),
      });
      if (!r.ok) { console.error(`[alerts] steps ${r.status}`); return []; }
      text = String((await r.json())?.choices?.[0]?.message?.content ?? "");
    } else {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 300, system: sys, messages: [{ role: "user", content: user }] }),
      });
      if (!r.ok) { console.error(`[alerts] steps ${r.status}`); return []; }
      const d = await r.json();
      text = (d.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    }
    return text.split("\n").map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, "").trim()).filter(Boolean).slice(0, top3.length);
  } catch (e) { console.error("[alerts] steps", e instanceof Error ? e.message : e); return []; }
}

async function tickUser(u: SettingsRow, token: string, opts: { dryRun: boolean; today: boolean }): Promise<C> {
  const s0 = readSettings(u.telegram);
  const s = opts.dryRun && s0.chat_id === null ? { ...s0, chat_id: 0 } : s0;
  if (s.chat_id === null) return { skipped: "not linked" };
  const now = new Date();
  const c = localClock(now, s.tz);
  const uid = u.user_id;
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const [blocks, nights, deadlines, log] = await Promise.all([
    get<Block>(`class_blocks?select=id,label,kind,location,start_t,end_t&user_id=eq.${uid}&weekday=eq.${c.weekday}&order=start_t`),
    get<{ items: unknown; top3: unknown }>(`nights?select=items,top3&user_id=eq.${uid}&day=eq.${c.day}`),
    get<Deadline>(`deadlines?select=id,title,course,kind,due_at,start_by,goal_id&user_id=eq.${uid}&done=eq.false&due_at=gte.${enc(since)}&order=due_at`),
    get<LogRow>(`alert_log?select=key,kind,state,snooze_until,tries,updated_at,meta&user_id=eq.${uid}&or=(day.eq.${c.day},state.eq.held)`),
  ]);
  if (!blocks || !nights || !deadlines || !log) return { skipped: "a read failed" };
  const night = nights[0];
  const input = {
    now, settings: s, deadlines, log,
    blocks: blocks.map((b) => ({ ...b, kind: b.kind ?? "class", location: b.location ?? "" })),
    items: Array.isArray(night?.items) ? (night.items as DayItem[]) : [],
    top3: Array.isArray(night?.top3) ? (night.top3 as string[]) : [],
  };

  let alerts = planAlerts(input);
  if (opts.today) {
    // /today: the plan as of right now, never quiet, never deduped against the morning one
    const hh = `${String(Math.floor(c.min / 60)).padStart(2, "0")}:${String(c.min % 60).padStart(2, "0")}`;
    const p = planAlerts({
      ...input,
      settings: { ...s, morning_at: hh, paused_until: null, quiet: { ...s.quiet, night: ["00:00", "00:00"] } },
      log: input.log.filter((r) => !r.key.startsWith("plan:")),
    }).find((a) => a.kind === "plan");
    alerts = p ? [{ ...p, key: `today:${c.day}:${c.min}`, absorbs: [] }] : [];
  }
  if (opts.dryRun) {
    return { day: c.day, min: c.min, alerts: alerts.map((a) => ({ key: a.key, kind: a.kind, action: a.action, silent: a.silent, text: a.text })) };
  }

  let sent = 0, held = 0;
  for (const a of alerts) {
    const existing = log.find((r) => r.key === a.key);
    const state = a.action === "hold" ? "held" : "sent";
    const stamp = new Date().toISOString();
    // claim the row first; only the tick that wins the write sends
    const claimed = existing
      ? await rest("PATCH", `alert_log?user_id=eq.${uid}&key=eq.${enc(a.key)}&state=eq.${existing.state}`,
          { state, snooze_until: null, updated_at: stamp, meta: { text: a.text } })
      : await rest("POST", "alert_log?on_conflict=user_id,key",
          { user_id: uid, key: a.key, kind: a.kind, day: c.day, ref_id: a.refId, state, meta: { text: a.text } },
          "return=representation,resolution=ignore-duplicates");
    if (!claimed || claimed.length === 0) continue;
    if (a.action === "hold") { held++; continue; }

    let text = a.text;
    if (a.kind === "plan" && a.top3.length) text = addSteps(text, a.top3, await firstSteps(a.top3, u.ai_models));
    const r = await tg(token, "sendMessage", {
      chat_id: s.chat_id, text, reply_markup: keyboard(a), disable_notification: a.silent,
      link_preview_options: { is_disabled: true },
    });
    const row = `alert_log?user_id=eq.${uid}&key=eq.${enc(a.key)}`;
    if (r.ok) {
      sent++;
      await rest("PATCH", row, { tg_message_id: r.result?.message_id ?? null, meta: { text } }, "return=minimal");
      if (a.absorbs.length) {
        const keys = a.absorbs.map((k) => enc(`"${k}"`)).join(",");
        await rest("PATCH", `alert_log?user_id=eq.${uid}&state=eq.held&key=in.(${keys})`, { state: "sent", updated_at: stamp }, "return=minimal");
      }
    } else if (r.status === 403) {
      // the bot was blocked or the chat is gone: stop, and let the app say "connect again"
      await rest("PATCH", row, { state: "failed", updated_at: stamp }, "return=minimal");
      await rest("PATCH", `user_settings?user_id=eq.${uid}`, { telegram: { ...(u.telegram ?? {}), chat_id: null, blocked: true } }, "return=minimal");
      return { day: c.day, min: c.min, sent, held, blocked: true };
    } else {
      await rest("PATCH", row, { state: r.status === 429 ? "held" : "failed", tries: (existing?.tries ?? 0) + 1, updated_at: stamp }, "return=minimal");
    }
  }
  return { day: c.day, min: c.min, sent, held };
}

// Done from a Telegram button: tick the block on today's Card, or close the deadline.
async function applyDone(uid: string, key: string, tz: string): Promise<C> {
  const [kind, ref, day] = key.split(":");
  if (!isUuid(ref ?? "")) return { error: "bad key" };
  const stamp = new Date().toISOString();
  if (kind === "block") {
    const c = localClock(new Date(), tz);
    if (day !== c.day) return { ok: true, note: "a past day; only the alert is marked" };
    const [blocks, nights] = await Promise.all([
      get<Block>(`class_blocks?select=id,label,kind,location,start_t,end_t&user_id=eq.${uid}&weekday=eq.${c.weekday}&order=start_t`),
      get<{ items: unknown; blocks_seeded: boolean | null }>(`nights?select=items,blocks_seeded&user_id=eq.${uid}&day=eq.${c.day}`),
    ]);
    if (!blocks || !nights) return { error: "read failed" };
    const n = nights[0];
    const items = tickBlockItem(Array.isArray(n?.items) ? (n.items as DayItem[]) : [], !!n?.blocks_seeded,
      blocks.map((b) => ({ ...b, kind: b.kind ?? "class", location: b.location ?? "" })), ref, c.min * 60, newItemId);
    const w = await rest("POST", "nights?on_conflict=user_id,day", { user_id: uid, day: c.day, items, blocks_seeded: true },
      "return=minimal,resolution=merge-duplicates");
    return w ? { ok: true } : { error: "write failed" };
  }
  if (kind === "due_eve") {
    const rows = await rest("PATCH", `deadlines?user_id=eq.${uid}&id=eq.${ref}`, { done: true, updated_at: stamp });
    if (!rows) return { error: "write failed" };
    const goal = rows[0]?.goal_id;
    if (typeof goal === "string") await rest("PATCH", `goals?user_id=eq.${uid}&id=eq.${goal}`, { status: "done", updated_at: stamp }, "return=minimal");
    return { ok: true };
  }
  return { error: "bad key" };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = (await req.json().catch(() => ({}))) as C;
  const want = await secretOf("alerts_cron_secret");
  if (!want || body.cronSecret !== want) return json({ error: "unauthorized" }, 401);
  const mode = typeof body.mode === "string" ? body.mode : "tick";
  const userId = typeof body.userId === "string" && isUuid(body.userId) ? body.userId : "";
  const dryRun = body.dryRun === true;
  if ((mode === "today" || mode === "done" || dryRun) && !userId) return json({ error: "userId required" });

  const filter = userId ? `user_id=eq.${userId}` : "telegram->>chat_id=not.is.null";
  const users = await get<SettingsRow>(`user_settings?select=user_id,telegram,ai_models&${filter}`);
  if (!users) return json({ error: "couldn't read settings" }, 500);

  if (mode === "done") {
    const u = users[0];
    if (!u) return json({ error: "no such user" });
    return json(await applyDone(u.user_id, String(body.key ?? ""), readSettings(u.telegram).tz));
  }

  const token = await secretOf("telegram_bot_token");
  if (!token && !dryRun) return json({ skipped: "no bot token yet" });
  const results: C[] = [];
  for (const u of users) {
    results.push({ user: u.user_id.slice(0, 8), ...(await tickUser(u, token, { dryRun, today: mode === "today" })) });
  }
  return json({ results });
});
```

- [ ] **Step 2: Re-run both test files (the planner is unchanged, the import graph is checked)**

Run: `cd ~/Downloads/daily && npx --yes tsx --test supabase/functions/alerts/plan.test.ts supabase/functions/alerts/items.test.ts`
Expected: PASS, 25 tests.

- [ ] **Step 3: Check sizes against the 44 KB deploy cap**

Run: `cd ~/Downloads/daily && wc -c supabase/functions/alerts/index.ts supabase/functions/alerts/plan.ts supabase/functions/alerts/items.ts`
Expected: total well under 45,000 bytes.

- [ ] **Step 4: Deploy**

`deploy_edge_function` with `project_id: "pciljeqsrricybdnhvsu"`, `name: "alerts"`, `entrypoint_path: "index.ts"`, `verify_jwt: false`, and `files` = the three files `index.ts`, `plan.ts`, `items.ts` with their exact contents (build the JSON-escaped contents with `python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()))' <file>` rather than escaping by hand). Do NOT include the `.test.ts` files.

Expected: deploy succeeds and reports version 1.

- [ ] **Step 5: Smoke test — wrong secret is refused, dry run plans from Ben's real data**

`execute_sql` (one post per statement, because `net.http_post` only fires at commit):

```sql
select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/alerts',
  headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"cronSecret":"wrong"}'::jsonb) as id;
```

```sql
select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/alerts',
  headers := '{"Content-Type":"application/json"}'::jsonb,
  body := jsonb_build_object('cronSecret', (select decrypted_secret from vault.decrypted_secrets where name = 'alerts_cron_secret'),
                             'dryRun', true, 'userId', 'f0e1e204-aa54-4a45-bbb5-99c83114fecb')) as id;
```

Then read both responses (use the two ids returned):

```sql
select id, status_code, left(content, 1500) from net._http_response where id in (<id1>, <id2>);
```

Expected: the first is `401` with `{"error":"unauthorized"}`; the second is `200` with `{"results":[{"user":"f0e1e204","day":"<today>","min":…,"alerts":[…]}]}` whose alerts match what the planner should want right now (e.g. a `block` alert if a block started in the last hour).

- [ ] **Step 6: Pin the overlapping-ticks guarantee (Review Focus)**

`execute_sql`:

```sql
begin;
insert into public.alert_log (user_id, key, kind, day, state) values ('f0e1e204-aa54-4a45-bbb5-99c83114fecb', 'test:race', 'block', current_date, 'sent')
  on conflict (user_id, key) do nothing returning key;
insert into public.alert_log (user_id, key, kind, day, state) values ('f0e1e204-aa54-4a45-bbb5-99c83114fecb', 'test:race', 'block', current_date, 'sent')
  on conflict (user_id, key) do nothing returning key;
rollback;
```

Expected: the first insert returns one row, the second returns zero rows. That is the same `ignore-duplicates` path `tickUser` uses to claim a message, so only one of two overlapping ticks can send.

- [ ] **Step 7: Commit**

```bash
cd ~/Downloads/daily && git add supabase/functions/alerts/index.ts
git -c user.name="Ben Garnet" -c user.email="bengarnet@mac.lan" commit -m "Telegram alerts: the alerts function (5-minute ticks, claim-then-send, /today, Done write-back, dry run)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The `telegram` edge function (webhook + app calls)

**Files:**
- Create: `supabase/functions/telegram/index.ts`

**Interfaces:**
- Consumes: `alerts` function modes `today` and `done` (Task 4); vault `telegram_bot_token`, `telegram_webhook_secret`, `alerts_cron_secret`; `user_settings.telegram`; `alert_log`.
- Produces: `POST /functions/v1/telegram`
  - from Telegram (header `X-Telegram-Bot-Api-Secret-Token`): button taps `"<s|d|z|k>|<key>"`, `/start <code>`, `/today`, `/pause <hours>`, `/resume`, anything else → help. Always answers 200.
  - from the app (Ben's JWT): `{mode: "connect"}` → `{bot_username, link}`; `{mode: "test"}` → `{ok}`; `{mode: "pause", until: iso}`; `{mode: "resume"}`. Errors as `{error: "<words for the screen>"}`.

- [ ] **Step 1: Write `index.ts`**

```ts
// Telegram edge function — the alerts bot's webhook, plus the app's calls.
//
// TWO KINDS OF CALLER:
//  - Telegram, carrying X-Telegram-Bot-Api-Secret-Token (vault
//    telegram_webhook_secret): button taps, /start <code>, /today, /pause,
//    /resume. Only the linked chat is ever acted on.
//  - The app, with Ben's JWT and {mode}: "connect" registers the webhook and
//    returns a one-time Start link; "test" sends one message; "pause"/"resume".
//
// Done taps and /today go through the alerts function, which owns all
// day/time logic. verify_jwt=false at the gateway; both callers are checked here.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SVC = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const OWNER = "f0e1e204-aa54-4a45-bbb5-99c83114fecb"; // the same single owner set_ai_key allows
const HELP = "Commands:\n/today shows today's plan\n/pause 2h stops alerts for 2 hours (1-24)\n/resume turns them back on";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
type C = Record<string, unknown>;
type UserRow = { user_id: string; telegram: C };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const S = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const enc = encodeURIComponent;

const sc = new Map<string, { v: string; at: number }>();
async function secretOf(name: string): Promise<string> {
  const c = sc.get(name);
  if (c && Date.now() - c.at < 60_000) return c.v;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_secret`, { method: "POST", headers: SVC, body: JSON.stringify({ secret_name: name }) });
    const v = r.ok ? ((await r.json()) as string | null) ?? "" : "";
    if (v) sc.set(name, { v, at: Date.now() });
    return v;
  } catch { return ""; }
}

async function get<T>(q: string): Promise<T[] | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { headers: SVC });
    if (!r.ok) { console.error(`[telegram] read ${q.split("?")[0]} ${r.status}`); return null; }
    return (await r.json()) as T[];
  } catch { return null; }
}
async function patch(q: string, body: C): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, { method: "PATCH", headers: { ...SVC, Prefer: "return=minimal" }, body: JSON.stringify(body) });
    if (!r.ok) console.error(`[telegram] patch ${q.split("?")[0]} ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.ok;
  } catch { return false; }
}
const setTelegram = (u: UserRow, change: C) =>
  patch(`user_settings?user_id=eq.${u.user_id}`, { telegram: { ...(u.telegram ?? {}), ...change } });

async function tg(method: string, body: C): Promise<{ ok: boolean; result?: C }> {
  const token = await secretOf("telegram_bot_token");
  if (!token) return { ok: false };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) console.error(`[telegram] ${method} ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
    return { ok: !!d.ok, result: d.result };
  } catch { return { ok: false }; }
}
const send = async (chat: unknown, text: string) => (await tg("sendMessage", { chat_id: chat, text })).ok;
const answer = (id: unknown, text: string) => tg("answerCallbackQuery", { callback_query_id: id, text });

async function callAlerts(body: C): Promise<C> {
  const cronSecret = await secretOf("alerts_cron_secret");
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/alerts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, cronSecret }) });
    return (await r.json().catch(() => ({ error: `HTTP ${r.status}` }))) as C;
  } catch { return { error: "unreachable" }; }
}

async function userByChat(chat: unknown): Promise<UserRow | null> {
  if (typeof chat !== "number") return null;
  const rows = await get<UserRow>(`user_settings?select=user_id,telegram&telegram->>chat_id=eq.${chat}`);
  return rows?.[0] ? { ...rows[0], telegram: rows[0].telegram ?? {} } : null;
}

// ── Telegram → us ───────────────────────────────────────────────────────────
async function onButton(cq: C) {
  const data = S(cq.data, 64);
  const code = data.slice(0, 1);
  const key = data.slice(2);
  const msg = cq.message as C | undefined;
  const chat = (msg?.chat as C | undefined)?.id;
  const u = await userByChat(chat);
  if (!u || !key) { await answer(cq.id, "This chat isn't linked to Daily."); return; }
  const stamp = new Date().toISOString();
  const change: C = { updated_at: stamp };
  let label = "";
  if (code === "s") { change.state = "started"; label = "Starting"; }
  else if (code === "z") { change.state = "snoozed"; change.snooze_until = new Date(Date.now() + 15 * 60_000).toISOString(); label = "Snoozed 15 min"; }
  else if (code === "k") { change.state = "skipped"; label = "Skipped today"; }
  else if (code === "d") { change.state = "done"; label = "Done"; }
  else { await answer(cq.id, "That button is out of date."); return; }
  if (code === "d") {
    const r = await callAlerts({ mode: "done", userId: u.user_id, key });
    if (r.error) { await answer(cq.id, "Couldn't tick it in Daily. Try again."); return; }
  }
  const ok = await patch(`alert_log?user_id=eq.${u.user_id}&key=eq.${enc(key)}`, change);
  await answer(cq.id, ok ? label : "Couldn't save that. Try again.");
  // editing without reply_markup removes the buttons, so a tap can't be repeated
  if (ok && msg) await tg("editMessageText", { chat_id: chat, message_id: msg.message_id, text: `${S(msg.text, 3800)}\n\n${label}` });
}

async function onMessage(m: C) {
  const chat = (m.chat as C | undefined)?.id;
  const text = S(m.text, 200);
  if (chat === undefined || !text.startsWith("/")) return;
  const [cmd, arg = ""] = text.split(/\s+/, 2);

  if (cmd === "/start") {
    const code = arg.replace(/[^a-z0-9]/gi, "");
    const rows = code ? await get<UserRow>(`user_settings?select=user_id,telegram&telegram->>link_code=eq.${code}`) : [];
    const u = rows?.[0];
    const exp = u ? Date.parse(String(u.telegram?.link_code_exp ?? "")) : NaN;
    if (!u || !(exp > Date.now())) {
      await send(chat, "That Start link has expired or isn't valid. In Daily, open Settings, Telegram alerts, and get a new link.");
      return;
    }
    await setTelegram(u, { chat_id: chat, linked_at: new Date().toISOString(), link_code: null, link_code_exp: null, blocked: false });
    await send(chat, `Connected. Your plan arrives at 7:45 each morning.\n\n${HELP}`);
    return;
  }

  const u = await userByChat(chat);
  if (!u) return; // strangers get nothing
  if (cmd === "/today") {
    const r = await callAlerts({ mode: "today", userId: u.user_id });
    if (r.error) await send(chat, "Couldn't build today's plan just now. Try again in a minute.");
    return;
  }
  if (cmd === "/pause") {
    const h = Math.min(24, Math.max(1, parseInt(arg, 10) || 2));
    await setTelegram(u, { paused_until: new Date(Date.now() + h * 3_600_000).toISOString() });
    await send(chat, `Paused for ${h} hour${h === 1 ? "" : "s"}. /resume turns alerts back on.`);
    return;
  }
  if (cmd === "/resume") {
    await setTelegram(u, { paused_until: null });
    await send(chat, "Alerts are back on.");
    return;
  }
  await send(chat, HELP);
}

async function webhook(req: Request, given: string): Promise<Response> {
  const want = await secretOf("telegram_webhook_secret");
  if (!want || given !== want) return json({ error: "unauthorized" }, 401);
  const update = (await req.json().catch(() => ({}))) as C;
  try {
    if (update.callback_query) await onButton(update.callback_query as C);
    else if (update.message) await onMessage(update.message as C);
  } catch (e) { console.error("[telegram] update", e instanceof Error ? e.message : e); }
  return json({ ok: true }); // always 200, or Telegram retries the same update
}

// ── the app → us ────────────────────────────────────────────────────────────
async function getUser(token: string): Promise<{ id?: string } | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function fromApp(req: Request): Promise<Response> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const user = jwt ? await getUser(jwt) : null;
  if (!user?.id) return json({ error: "Sign in again." }, 401);
  if (user.id !== OWNER) return json({ error: "Not permitted." }, 403);
  const body = (await req.json().catch(() => ({}))) as C;
  const rows = await get<UserRow>(`user_settings?select=user_id,telegram&user_id=eq.${user.id}`);
  if (!rows?.[0]) return json({ error: "Couldn't read your settings. Try again." });
  const u: UserRow = { ...rows[0], telegram: rows[0].telegram ?? {} };
  const mode = S(body.mode, 20);

  if (mode === "connect") {
    const token = await secretOf("telegram_bot_token");
    if (!token) return json({ error: "Save the token first." });
    const me = await tg("getMe", {});
    if (!me.ok) return json({ error: "Telegram didn't accept that token. Copy it again from BotFather (/mybots, your bot, API Token)." });
    const hook = await tg("setWebhook", {
      url: `${SUPABASE_URL}/functions/v1/telegram`, secret_token: await secretOf("telegram_webhook_secret"),
      allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
    });
    if (!hook.ok) return json({ error: "Telegram wouldn't register the bot with the server. Try again in a minute." });
    const username = S(me.result?.username, 64);
    const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
    const code = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % 32]).join("");
    const ok = await setTelegram(u, { bot_username: username, link_code: code, link_code_exp: new Date(Date.now() + 10 * 60_000).toISOString() });
    if (!ok) return json({ error: "Couldn't save the Start link. Try again." });
    return json({ bot_username: username, link: `https://t.me/${username}?start=${code}` });
  }
  if (mode === "test") {
    const chat = u.telegram.chat_id;
    if (typeof chat !== "number") return json({ error: "Tap Start in Telegram first." });
    return json((await send(chat, "Alerts are connected. Your plan arrives at 7:45.")) ? { ok: true } : { error: "Telegram didn't take the message. The bot may be blocked." });
  }
  if (mode === "pause") {
    const until = S(body.until, 40);
    if (!(Date.parse(until) > Date.now())) return json({ error: "Pick a time in the future." });
    return json((await setTelegram(u, { paused_until: until })) ? { ok: true } : { error: "Couldn't pause. Try again." });
  }
  if (mode === "resume") {
    return json((await setTelegram(u, { paused_until: null })) ? { ok: true } : { error: "Couldn't resume. Try again." });
  }
  return json({ error: `Unknown mode "${mode}".` });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const hook = req.headers.get("x-telegram-bot-api-secret-token");
  return hook !== null ? await webhook(req, hook) : await fromApp(req);
});
```

- [ ] **Step 2: Check size**

Run: `cd ~/Downloads/daily && wc -c supabase/functions/telegram/index.ts`
Expected: under 15,000 bytes.

- [ ] **Step 3: Deploy**

`deploy_edge_function` with `name: "telegram"`, `entrypoint_path: "index.ts"`, `verify_jwt: false`, `files: [index.ts]` (JSON-escaped with the same python one-liner as Task 4).

- [ ] **Step 4: Smoke test the two auth gates**

`execute_sql`, one post per statement:

```sql
select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/telegram',
  headers := '{"Content-Type":"application/json","X-Telegram-Bot-Api-Secret-Token":"wrong"}'::jsonb, body := '{}'::jsonb) as id;
```

```sql
select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/telegram',
  headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"mode":"connect"}'::jsonb) as id;
```

```sql
select id, status_code, content from net._http_response where id in (<id1>, <id2>);
```

Expected: `401 {"error":"unauthorized"}` and `401 {"error":"Sign in again."}`.

- [ ] **Step 5: Commit**

```bash
cd ~/Downloads/daily && git add supabase/functions/telegram/index.ts
git -c user.name="Ben Garnet" -c user.email="bengarnet@mac.lan" commit -m "Telegram alerts: the bot's webhook (buttons, /start link, /today, /pause, /resume) and the app's connect/test/pause calls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The Settings card

**Files:**
- Create: `src/components/TelegramAlerts.tsx`
- Modify: `src/lib/supabase.ts` (add `TELEGRAM_FN` after `NUDGE_FN`, line 16)
- Modify: `src/app/page.tsx` (import, and mount after `<AIModels />` in the settings sheet, around line 217)

**Interfaces:**
- Consumes: RPCs `set_telegram_token`, `telegram_status` (Task 1); `telegram` function modes `connect`, `test`, `pause`, `resume` (Task 5).
- Produces: `<TelegramAlerts />` default export, no props.

- [ ] **Step 1: Add the endpoint constant**

In `src/lib/supabase.ts`, after `export const NUDGE_FN = \`${URL}/functions/v1/nudge\`;` add:

```ts
export const TELEGRAM_FN = `${URL}/functions/v1/telegram`;
```

- [ ] **Step 2: Write the card**

Create `src/components/TelegramAlerts.tsx`:

```tsx
"use client";

// Telegram alerts — connect the "Daily alerts" bot and see that it works.
//
// The bot token goes from this box straight into the encrypted vault through
// the set_telegram_token rpc (the same path as the AI key). It is never shown
// again, only its last 4 characters. Connect then registers the bot with the
// server and hands back a one-time Start link that ties the bot to Ben's
// Telegram chat; this card watches for that to land.

import { useCallback, useEffect, useState } from "react";
import { supabase, SUPABASE_ANON, TELEGRAM_FN } from "@/lib/supabase";
import { Card } from "./ui";

type Status = { is_set: boolean; hint: string | null; linked: boolean; bot_username: string | null; blocked: boolean; paused_until: string | null };
type Reply = { error?: string; link?: string; bot_username?: string };

async function call(body: Record<string, unknown>): Promise<Reply> {
  try {
    const { data } = await supabase.auth.getSession();
    const r = await fetch(TELEGRAM_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${data.session?.access_token}` },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as Reply;
    if (!r.ok || j.error) return { error: j.error || `The server said no (${r.status}).` };
    return j;
  } catch { return { error: "Couldn't reach the server. Try again." }; }
}

function endOfToday(): string {
  const d = new Date();
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

export default function TelegramAlerts() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [link, setLink] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc("telegram_status");
      if (error) return;
      const row = (Array.isArray(data) ? data[0] : data) as Status | undefined;
      if (row) setStatus(row);
    } catch { /* leave unknown */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  // while a Start link is out, look every 3 seconds (up to 2 minutes) for the chat to link
  useEffect(() => {
    if (!link || status?.linked) return;
    let tries = 0;
    const t = setInterval(() => { tries++; if (tries > 40) clearInterval(t); else load(); }, 3000);
    return () => clearInterval(t);
  }, [link, status?.linked, load]);

  async function connect(fresh: string) {
    if (busy) return;
    setBusy("connect"); setErr(""); setMsg("");
    try {
      if (fresh) {
        const { error } = await supabase.rpc("set_telegram_token", { p_token: fresh });
        if (error) { setErr(error.message.replace(/^.*?:\s*/, "") || "Couldn't save that token."); return; }
        setToken(""); // don't leave the secret sitting in a form field
        setOpen(false);
      }
      const r = await call({ mode: "connect" });
      if (r.error) { setErr(r.error); return; }
      setLink(r.link ?? "");
      setMsg(`Now open @${r.bot_username} and tap Start. The link works for 10 minutes.`);
      await load();
    } finally { setBusy(""); }
  }

  async function run(mode: "test" | "pause" | "resume") {
    if (busy) return;
    setBusy(mode); setErr(""); setMsg("");
    try {
      const r = await call(mode === "pause" ? { mode, until: endOfToday() } : { mode });
      if (r.error) { setErr(r.error); return; }
      setMsg(mode === "test" ? "Sent. Check Telegram." : mode === "pause" ? "Paused until midnight." : "Alerts are back on.");
      await load();
    } finally { setBusy(""); }
  }

  const paused = !!status?.paused_until && new Date(status.paused_until) > new Date();
  const line = status === null ? "checking…"
    : !status.is_set ? "Not connected"
    : status.blocked ? "The bot was blocked or the chat is gone. Get a new Start link."
    : status.linked ? `Connected to @${status.bot_username ?? "your bot"}${paused ? " · paused for today" : ""}`
    : "Token saved. Tap Start in Telegram to finish.";

  return (
    <Card className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-widest opacity-60">Telegram alerts</p>
          <p className="text-[11px] opacity-50 mt-0.5">{line}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          {status?.linked && (
            <button onClick={() => run("test")} disabled={!!busy} className="px-3 py-2 rounded-lg bg-white/10 text-xs font-semibold active:scale-95 disabled:opacity-50">
              {busy === "test" ? "sending…" : "Send a test"}
            </button>
          )}
          <button onClick={() => { setOpen((v) => !v); setErr(""); setMsg(""); }} className="px-3 py-2 rounded-lg bg-[var(--neon)] text-black text-xs font-bold active:scale-95">
            {open ? "Cancel" : status?.is_set ? "Replace token" : "Connect"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3">
          <input
            type="password" autoComplete="off" spellCheck={false}
            value={token} onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && token.trim()) connect(token.trim()); }}
            placeholder="Token from BotFather, like 1234567890:AA…"
            className="w-full rounded-lg bg-black/40 px-3 py-2.5 outline-none text-sm font-mono" />
          <button onClick={() => connect(token.trim())} disabled={!!busy || !token.trim()}
            className="mt-2 w-full rounded-xl bg-[var(--neon)] text-black font-bold py-2.5 active:scale-95 disabled:opacity-40">
            {busy === "connect" ? "connecting…" : "Save and connect"}
          </button>
          <p className="text-[10px] opacity-40 mt-2 leading-relaxed">
            In Telegram: @BotFather, /mybots, your bot, API Token. The token goes straight into your encrypted vault
            and is never shown again, only its last 4 characters.
          </p>
        </div>
      )}

      {status?.is_set && (!status.linked || status.blocked) && !open && !link && (
        <button onClick={() => connect("")} disabled={!!busy}
          className="mt-3 w-full rounded-xl bg-white/10 py-2.5 text-xs font-semibold active:scale-95 disabled:opacity-50">
          {busy === "connect" ? "getting a link…" : "Get a new Start link"}
        </button>
      )}
      {link && !status?.linked && (
        <a href={link} target="_blank" rel="noreferrer"
          className="mt-3 block w-full rounded-xl bg-[var(--neon)] text-black text-center font-bold py-2.5 active:scale-95">
          Open the bot and tap Start
        </a>
      )}
      {status?.linked && !status.blocked && (
        <button onClick={() => run(paused ? "resume" : "pause")} disabled={!!busy}
          className="mt-3 w-full rounded-xl bg-white/10 py-2.5 text-xs font-semibold active:scale-95 disabled:opacity-50">
          {busy === "pause" || busy === "resume" ? "saving…" : paused ? "Resume alerts" : "Pause for the rest of today"}
        </button>
      )}

      {msg && <p className="text-xs text-[var(--neon)] mt-2">{msg}</p>}
      {err && <p className="text-xs text-orange-400 mt-2">{err}</p>}

      <p className="text-[11px] opacity-60 mt-3 leading-relaxed">
        What it sends: your plan at 7:45 with a first step for each of the top 3, a ping when each block starts
        (not classes), one nudge if a block goes 15 minutes untouched, and a heads-up at 6pm the day before
        something is due. Done on a ping ticks it on your Card. It stays quiet during class, the gym and
        10pm to 7:30am, then sends what it held in one message. Pings during a drive arrive without sound.
        In Telegram: /today, /pause 2h, /resume.
      </p>
    </Card>
  );
}
```

- [ ] **Step 3: Mount it in the settings sheet**

In `src/app/page.tsx`, add the import next to the AIKey import:

```tsx
import TelegramAlerts from "@/components/TelegramAlerts";
```

and in the settings sheet change

```tsx
              <AIKey />
              <AIModels />
```

to

```tsx
              <AIKey />
              <AIModels />
              <TelegramAlerts />
```

- [ ] **Step 4: Type-check, lint and build**

Run: `cd ~/Downloads/daily && npx tsc --noEmit && npm run lint && npm run build`
Expected: no type errors, no new lint errors in the touched files, static export completes.

- [ ] **Step 5: Look at it**

Run `npm run dev`, open `http://localhost:3000/daily/` in the browser pane at the mobile preset, open Settings (the `•••` button), and confirm the card shows "Not connected", a Connect button, and the "What it sends" paragraph with no emojis. Take a screenshot for Ben.

- [ ] **Step 6: Commit**

```bash
cd ~/Downloads/daily && git add src/components/TelegramAlerts.tsx src/lib/supabase.ts src/app/page.tsx
git -c user.name="Ben Garnet" -c user.email="bengarnet@mac.lan" commit -m "Telegram alerts: the Settings card (save token, Start link, test, pause)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Go live with Ben

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-telegram-alerts-design.md` (status line)

**Interfaces:**
- Consumes: everything above.
- Produces: cron job `telegram-alerts`; the app deployed with the card; Ben linked.

- [ ] **Step 1: Ask Ben before merging and pushing** (pushing `main` deploys the app). On a yes:

```bash
cd ~/Downloads/daily && git checkout main && git merge --no-ff telegram-alerts -m "Merge telegram-alerts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
gh auth switch -u bookcrewcode && git push origin main
```

Then watch the Pages deploy finish: `gh run list --limit 1` until the newest run shows `completed success`.

- [ ] **Step 2: Schedule the 5-minute tick**

`execute_sql`:

```sql
select cron.schedule('telegram-alerts', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/alerts',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('cronSecret', (select decrypted_secret from vault.decrypted_secrets where name = 'alerts_cron_secret')),
    timeout_milliseconds := 30000);
$$);
select jobname, schedule, active from cron.job where jobname = 'telegram-alerts';
```

Expected: one active row. (Until Ben links, each tick answers `{"skipped":"no bot token yet"}` or an empty results list.)

- [ ] **Step 3: Ben connects (his 3 steps, on his phone)**

Tell Ben, in this order:
1. Revoke the token that was pasted in chat: @BotFather, /mybots, @dailyappalert_bot, API Token, Revoke current token. Copy the new one.
2. In Daily (reload once so the new version loads): Settings, Telegram alerts, Connect, paste, Save and connect.
3. Tap "Open the bot and tap Start", tap Start in Telegram, come back and tap "Send a test".

- [ ] **Step 4: Verify the link and the first real tick**

`execute_sql`:

```sql
select telegram->>'bot_username' as bot, jsonb_typeof(telegram->'chat_id') as chat_type, telegram->>'linked_at' as linked_at
from user_settings where user_id = 'f0e1e204-aa54-4a45-bbb5-99c83114fecb';
```

Expected: `bot = dailyappalert_bot`, `chat_type = number`, `linked_at` set.

After the next 5-minute boundary:

```sql
select key, kind, state, updated_at from alert_log order by created_at desc limit 10;
select status_code, left(content, 400) from net._http_response order by created desc limit 3;
```

Expected: the tick responses are `200` with `{"results":[{"user":"f0e1e204",…,"sent":N,"held":M}]}`; any due block or plan shows up as an `alert_log` row in state `sent` or `held`.

- [ ] **Step 5: Mark the spec live and commit**

In `docs/superpowers/specs/2026-10-15-telegram-alerts-design.md` change the status line to `2026-10-15 · status: live`, then:

```bash
cd ~/Downloads/daily && git add docs/superpowers/specs/2026-10-15-telegram-alerts-design.md
git -c user.name="Ben Garnet" -c user.email="bengarnet@mac.lan" commit -m "Telegram alerts: live

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 6: Save a project memory**

Write `/Users/bengarnet/.claude/projects/-Users-bengarnet-Downloads-Ben-s-Second-Brain/memory/daily-telegram-alerts.md` (type `project`) covering: @dailyappalert_bot; functions `alerts` (cron `telegram-alerts` */5, modes tick/dryRun/today/done) and `telegram` (webhook + connect/test/pause); `alert_log` keys; settings in `user_settings.telegram`; vault names; the dry-run SQL from Task 4 Step 5 as the first debugging move; and that the token only ever goes through the app card. Add its one-line pointer to `MEMORY.md`.
