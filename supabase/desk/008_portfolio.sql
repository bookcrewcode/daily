-- Portfolio copilot, build step 1 (2026-10-16): Ben's real holdings as lots, the copilot's settings,
-- the morning reports, and every model call's cost for the $1 daily cap.
-- Applied through the Supabase MCP as migration portfolio_step1; kept here as the record.

create table if not exists public.pf_lots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol text not null check (symbol ~ '^[A-Z0-9.^-]{1,14}$'),
  shares numeric not null check (shares <> 0),
  price numeric not null check (price > 0),
  day date not null,
  kind text not null check (kind in ('start','weekly','manual')),
  assumed boolean not null default false,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists pf_lots_user_day on public.pf_lots(user_id, day);
-- one recorded weekly buy per stock per day, however often the tick runs
create unique index if not exists pf_lots_weekly_once on public.pf_lots(user_id, symbol, day) where kind = 'weekly';

create table if not exists public.pf_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  recurring jsonb not null default '[]'::jsonb,          -- [{ "symbol": "SPCX", "usd": 400 }]
  buy_dow int not null default 3 check (buy_dow between 1 and 5),
  recurring_since date,                                  -- weekly lots are recorded for buy days on or after this date
  cap_usd_day numeric not null default 1 check (cap_usd_day >= 0 and cap_usd_day <= 5),
  report_model text not null default 'google/gemini-3.8-flash',
  paused boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.pf_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  status text not null default 'running' check (status in ('running','done','failed')),
  tries int not null default 0,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  model text not null default '',
  cost_usd numeric not null default 0,
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, day)
);

create table if not exists public.pf_spend (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,                                    -- feed | report (later steps add judge, idea, hunt)
  model text not null default '',
  cost_usd numeric not null default 0
);
create index if not exists pf_spend_user_at on public.pf_spend(user_id, at);

alter table public.pf_lots enable row level security;
alter table public.pf_settings enable row level security;
alter table public.pf_reports enable row level security;
alter table public.pf_spend enable row level security;
create policy pf_lots_own on public.pf_lots for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy pf_settings_own on public.pf_settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy pf_reports_read on public.pf_reports for select using (auth.uid() = user_id);   -- the pilot function writes
create policy pf_spend_read on public.pf_spend for select using (auth.uid() = user_id);       -- the pilot function writes

-- The budget gate's sum, on the server (a plain select is capped at 1000 rows).
create or replace function public.pf_spend_since(p_user uuid, p_since timestamptz)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_usd), 0)::numeric from public.pf_spend where user_id = p_user and at >= p_since;
$$;
revoke all on function public.pf_spend_since(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.pf_spend_since(uuid, timestamptz) to service_role;

-- The same sum for the signed-in user, for the app's "AI cost today" line.
create or replace function public.pf_my_spend_since(p_since timestamptz)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(cost_usd), 0)::numeric from public.pf_spend where user_id = auth.uid() and at >= p_since;
$$;
revoke all on function public.pf_my_spend_since(timestamptz) from public, anon;
grant execute on function public.pf_my_spend_since(timestamptz) to authenticated;
