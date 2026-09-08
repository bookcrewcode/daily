-- The Desk, phase 6: the standard (perform or be replaced), the bench, the daily macro review.
-- Record of the migration desk_fear_factor applied through the Supabase MCP on 2026-09-08.
-- The live database is the source of truth; this file is the readable copy.

alter table public.desk_accounts
  add column if not exists bench jsonb not null default '[]'::jsonb,       -- nightly candidates waiting for a seat, in order
  add column if not exists sit_bench jsonb not null default '[]'::jsonb,   -- sit-jury candidates, in order
  add column if not exists cut_rules jsonb not null default '{}'::jsonb;   -- overrides of DEFAULT_CUT_RULES (src/lib/desk/stats.ts)

alter table public.desk_ratings
  add column if not exists status text not null default 'active',          -- active | cut
  add column if not exists standing jsonb not null default '{}'::jsonb,    -- {nightly|sit: {label, reasons, sample, needed, as_of}}
  add column if not exists cut_at timestamptz,
  add column if not exists cut_reason text not null default '';

-- who went, who came, and the number that did it
create table if not exists public.desk_roster_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  at timestamptz not null default now(),
  seat text not null,                       -- nightly | sit
  action text not null,                     -- cut | notice | kept
  model text not null default '',
  replaced_by text not null default '',
  reason text not null default ''
);
create index if not exists desk_roster_log_user on public.desk_roster_log(user_id, at desc);
alter table public.desk_roster_log enable row level security;
do $$ begin
  create policy desk_roster_log_own on public.desk_roster_log for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- the coach writes daily now: one card per day (week_start stays as the week the day belongs to)
alter table public.desk_cards add column if not exists day date;
update public.desk_cards set day = week_start where day is null;
alter table public.desk_cards alter column day set not null;
alter table public.desk_cards drop constraint if exists desk_cards_pkey;
alter table public.desk_cards add primary key (user_id, day);

-- Ben's board: nine seats (Opus 5 and Kimi K3 added), GPT-6 Astra judging, $3 a night, the bench in order.
-- The standard (DEFAULT_CUT_RULES): judged after 12 scored shadow trades (nightly) or 30 scored sits (sit jury);
-- cut at a book 10% below its start, shrunk R at or below -0.15, Brier at or above 0.30, Elo at or below 1440,
-- or a sit juror right on 40% of its sits or fewer; on notice half way to any bar.
update public.desk_accounts set
  roster = '["anthropic/claude-sonnet-5","openai/gpt-5.6-terra","google/gemini-3.8-flash","x-ai/grok-4.6","deepseek/deepseek-v4-pro-0813","qwen/qwen3.8-max-0902","moonshotai/kimi-k2.6","anthropic/claude-opus-5","moonshotai/kimi-k3"]'::jsonb,
  judge = 'openai/gpt-6-astra',
  budget_usd_per_run = 3,
  bench = '["google/gemini-3.1-pro-preview","anthropic/claude-fable-5.1","deepseek/deepseek-v4-flash-0731","qwen/qwen3.8-flash","mistralai/mistral-medium-3-5","z-ai/glm-5.3","minimax/minimax-m3","meta/muse-spark-1.3","anthropic/claude-haiku-4.5","openai/gpt-5.6-luna","google/gemini-3.5-flash-lite"]'::jsonb,
  sit_bench = '["qwen/qwen3.8-flash","google/gemini-3.5-flash-lite","minimax/minimax-m3","anthropic/claude-haiku-4.5","moonshotai/kimi-k2.6","x-ai/grok-4.3"]'::jsonb,
  updated_at = now()
where user_id = 'f0e1e204-aa54-4a45-bbb5-99c83114fecb';

-- desk-coach cron moved from weekly to daily 05:05 UTC (see 003_cron.sql)
