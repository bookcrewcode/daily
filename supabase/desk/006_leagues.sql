-- Desk phase 7 (2026-09-09): the leagues. Applied through the Supabase MCP as migration
-- "desk_leagues"; the live database is the source of truth, this file is the readable copy.
-- Teams of one frontier and four workers, each with its own $100k paper book; every decision
-- recorded (candidate, session, close, council); daily councils that can kick a member; seasons.
create table if not exists public.desk_teams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,                       -- "Astra II": the frontier's short name and its team count
  frontier text not null,                   -- the model that decides
  workers text[] not null default '{}',     -- the four models that do the brute work
  seniors text[] not null default '{}',     -- the two workers who sit on the council with the frontier
  combo text not null,                      -- frontier|sorted workers; unique per user for all time
  tier text not null default 'bronze' check (tier in ('diamond','gold','bronze')),
  status text not null default 'live' check (status in ('live','dead')),
  season int not null default 1,
  formed_at timestamptz not null default now(),
  died_at timestamptz,
  death_reason text not null default '',
  start_equity numeric not null default 100000,
  equity numeric not null default 100000,   -- last computed at a tick (closed P/L + open at live marks)
  peak numeric not null default 100000,
  return_pct numeric not null default 0,
  marked_at timestamptz,
  stats jsonb not null default '{}'::jsonb, -- decisions, takes, passes, closes, kicks
  created_at timestamptz not null default now(),
  unique (user_id, combo)
);
create index if not exists desk_teams_user_status on public.desk_teams(user_id, status);

create table if not exists public.desk_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid not null references public.desk_teams(id) on delete cascade,
  kind text not null check (kind in ('candidate','session','close','council')),
  setup_id uuid references public.desk_setups(id) on delete set null,
  symbol text not null default '',
  strategy text not null default '',
  timeframe text not null default '',
  status text not null default 'launched' check (status in ('launched','done','failed')),
  brief jsonb not null default '{}'::jsonb,   -- what the team was shown
  ballots jsonb not null default '[]'::jsonb, -- the workers' votes, and the frontier's as a ballot too
  verdict jsonb,                              -- the frontier's decision {action, reason, risk_pct, leverage, stop, target}
  outcome jsonb,                              -- {taken, trade_id, reasons, ticket} or the pass reason
  cost_usd numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists desk_decisions_team on public.desk_decisions(team_id, created_at desc);
create index if not exists desk_decisions_setup on public.desk_decisions(setup_id);
create index if not exists desk_decisions_user_created on public.desk_decisions(user_id, created_at desc);

create table if not exists public.desk_councils (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid not null references public.desk_teams(id) on delete cascade,
  day date not null,
  votes jsonb not null default '[]'::jsonb,   -- per council member: its kick/keep vote on every other member, with reasons
  kicked text,
  replaced_by text,
  reason text not null default '',
  cost_usd numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (team_id, day)
);

create table if not exists public.desk_seasons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  n int not null,
  start_day date not null,
  end_day date not null,
  champion_team uuid references public.desk_teams(id) on delete set null,
  status text not null default 'running' check (status in ('running','done')),
  created_at timestamptz not null default now(),
  unique (user_id, n)
);

alter table public.desk_accounts add column if not exists league jsonb not null default '{}'::jsonb; -- LeagueSettings overrides
alter table public.desk_trades add column if not exists ticket jsonb;                 -- everything that went into the trade
alter table public.desk_trades add column if not exists close_requested_at timestamptz; -- a frontier asked to close; the sync closes at the next quote
alter table public.desk_trades add column if not exists close_reason text;
alter table public.desk_opinions add column if not exists decision_id uuid;          -- league model calls, for the budget
create index if not exists desk_opinions_decision on public.desk_opinions(decision_id);

alter table public.desk_teams enable row level security;
alter table public.desk_decisions enable row level security;
alter table public.desk_councils enable row level security;
alter table public.desk_seasons enable row level security;
do $$ begin
  create policy desk_teams_own on public.desk_teams for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy desk_decisions_own on public.desk_decisions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy desk_councils_own on public.desk_councils for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  create policy desk_seasons_own on public.desk_seasons for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
