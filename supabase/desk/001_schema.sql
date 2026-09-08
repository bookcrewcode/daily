-- The Desk: paper-trading jury. Owner-only RLS like every other table.
-- Applied through the Supabase MCP as migration "desk_schema" on 2026-09-07.
create table if not exists public.desk_accounts (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  starting_equity numeric not null default 100000,
  cash numeric not null default 100000,
  equity numeric not null default 100000,
  peak_equity numeric not null default 100000,
  preset text not null default 'aggressive',
  rules jsonb not null default '{}'::jsonb,
  halted_until date,
  halt_reason text not null default '',
  roster jsonb not null default '["anthropic/claude-sonnet-5","openai/gpt-5.6-terra","google/gemini-3.8-flash","x-ai/grok-4.6","deepseek/deepseek-v4-pro-0813","qwen/qwen3.8-max-0902","moonshotai/kimi-k2.6"]'::jsonb,
  judge text not null default 'anthropic/claude-opus-5',
  budget_usd_per_run numeric not null default 1.5,
  ladder jsonb not null default '{}'::jsonb,
  leverage_cap_override integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.desk_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  day date not null,
  seq integer not null default 1,
  status text not null default 'running',
  stage text not null default 'packet',
  regime text not null default '',
  packet jsonb not null default '{}'::jsonb,
  votes jsonb not null default '[]'::jsonb,
  verdict jsonb not null default '{}'::jsonb,
  judge_model text not null default '',
  cost_usd numeric not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, day, seq)
);
create table if not exists public.desk_opinions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  session_id uuid not null references public.desk_sessions(id) on delete cascade,
  model text not null,
  juror text not null,
  round text not null,
  content jsonb not null default '{}'::jsonb,
  raw text not null default '',
  latency_ms integer not null default 0,
  cost_usd numeric not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  error text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists desk_opinions_session on public.desk_opinions(session_id, round);
create table if not exists public.desk_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  owner text not null default 'desk',
  session_id uuid references public.desk_sessions(id) on delete set null,
  proposal_id text not null default '',
  venue text not null,
  instrument text not null,
  symbol text not null,
  name text not null default '',
  side text not null,
  status text not null default 'pending',
  template integer not null default 0,
  thesis text not null default '',
  catalyst text not null default '',
  falsifier text not null default '',
  confidence numeric not null default 0.5,
  evidence jsonb not null default '[]'::jsonb,
  regime text not null default '',
  decided_at timestamptz not null default now(),
  entry_ref numeric not null,
  stop numeric not null,
  target numeric not null,
  horizon_days integer not null default 10,
  risk_pct numeric not null default 3,
  leverage numeric not null default 1,
  qty numeric not null default 0,
  unit text not null default 'share',
  contract_value numeric not null default 1,
  notional numeric not null default 0,
  margin numeric not null default 0,
  liq_price numeric,
  entry_price numeric,
  entry_at timestamptz,
  fill_rule text not null default '',
  slippage_bps numeric not null default 0,
  fees numeric not null default 0,
  funding numeric not null default 0,
  funding_at timestamptz,
  checked_until timestamptz,
  expires_on text,
  exit_price numeric,
  exit_at timestamptz,
  exit_reason text,
  ambiguous_bar boolean not null default false,
  pnl numeric,
  pnl_pct numeric,
  r_multiple numeric,
  mae_r numeric,
  mfe_r numeric,
  spy_entry numeric,
  spy_exit numeric,
  review jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists desk_trades_owner_status on public.desk_trades(user_id, owner, status);
create index if not exists desk_trades_session on public.desk_trades(user_id, session_id);
create table if not exists public.desk_equity (
  user_id uuid not null default auth.uid(),
  day date not null,
  owner text not null default 'desk',
  equity numeric not null,
  cash numeric not null default 0,
  market_value numeric not null default 0,
  gross_exposure numeric not null default 0,
  pnl_day numeric not null default 0,
  spy_close numeric,
  marked_at timestamptz not null default now(),
  primary key (user_id, day, owner)
);
create table if not exists public.desk_bars (
  symbol text not null,
  day date not null,
  o numeric not null, h numeric not null, l numeric not null, c numeric not null, v numeric not null default 0,
  source text not null default '',
  primary key (symbol, day)
);
create table if not exists public.desk_instruments (
  inst_id text primary key,
  base text not null,
  quote text not null,
  max_leverage integer not null default 1,
  contract_value numeric not null default 1,
  lot_size numeric not null default 1,
  tick_size numeric not null default 0.01,
  state text not null default 'live',
  vol_24h_usd numeric not null default 0,
  last numeric,
  updated_at timestamptz not null default now()
);
create table if not exists public.desk_calendar (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  time_et text not null default '',
  kind text not null,
  label text not null,
  symbol text not null default '',
  source text not null default ''
);
create index if not exists desk_calendar_day on public.desk_calendar(day);
create table if not exists public.desk_ratings (
  user_id uuid not null default auth.uid(),
  model text not null,
  elo numeric not null default 1500,
  n_matches integer not null default 0,
  n_trades integer not null default 0,
  n_wins integer not null default 0,
  sum_r numeric not null default 0,
  brier_sum numeric not null default 0,
  brier_n integer not null default 0,
  calib jsonb not null default '[]'::jsonb,
  n_abstain integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, model)
);
create table if not exists public.desk_lessons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  text text not null,
  scope jsonb not null default '{}'::jsonb,
  for_count integer not null default 1,
  against_count integer not null default 0,
  applied_count integer not null default 0,
  status text not null default 'hidden',
  source_trade_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.desk_cards (
  user_id uuid not null default auth.uid(),
  week_start date not null,
  card jsonb not null default '{}'::jsonb,
  review text not null default '',
  created_at timestamptz not null default now(),
  primary key (user_id, week_start)
);

alter table public.desk_accounts enable row level security;
alter table public.desk_sessions enable row level security;
alter table public.desk_opinions enable row level security;
alter table public.desk_trades enable row level security;
alter table public.desk_equity enable row level security;
alter table public.desk_bars enable row level security;
alter table public.desk_instruments enable row level security;
alter table public.desk_calendar enable row level security;
alter table public.desk_ratings enable row level security;
alter table public.desk_lessons enable row level security;
alter table public.desk_cards enable row level security;

do $$ begin
  create policy desk_accounts_own on public.desk_accounts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy desk_sessions_own on public.desk_sessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy desk_opinions_own on public.desk_opinions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy desk_trades_own on public.desk_trades for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy desk_equity_own on public.desk_equity for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy desk_ratings_own on public.desk_ratings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy desk_lessons_own on public.desk_lessons for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy desk_cards_own on public.desk_cards for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy desk_bars_read on public.desk_bars for select to authenticated using (true);
  create policy desk_instruments_read on public.desk_instruments for select to authenticated using (true);
  create policy desk_calendar_read on public.desk_calendar for select to authenticated using (true);
exception when duplicate_object then null; end $$;
