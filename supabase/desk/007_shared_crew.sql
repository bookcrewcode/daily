-- The Desk, leagues v2: one research crew shared by every team, frontiers deciding alone.
-- Applied on 2026-09-09 as migrations desk_shared_crew and desk_opinions_research.

-- The crew's work on one setup, done once for every team.
create table if not exists public.desk_research (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  setup_id uuid,
  symbol text,
  strategy text,
  timeframe text,
  status text not null default 'queued' check (status in ('queued','launched','done','failed')),
  brief jsonb,
  ballots jsonb,
  cost_usd numeric,
  launched jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, setup_id)
);
alter table public.desk_research enable row level security;
create policy "own research" on public.desk_research for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists desk_research_user_status on public.desk_research (user_id, status);

-- Every team's decision points at the research it was decided on; a crew ballot belongs to the research, not to one team's decision.
alter table public.desk_decisions add column if not exists research_id uuid references public.desk_research(id) on delete set null;
alter table public.desk_opinions add column if not exists research_id uuid references public.desk_research(id) on delete set null;
create index if not exists desk_opinions_research on public.desk_opinions (research_id) where research_id is not null;

-- The Learn tab stops explaining a term once Ben marks it learned.
alter table public.desk_accounts add column if not exists learned_terms text[] not null default '{}';
