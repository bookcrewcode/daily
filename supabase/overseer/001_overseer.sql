-- Overseer (build 1): the agent's settings, its log, stakes and spend.
-- The Cloudflare agent writes with the service role; the app reads its own
-- rows and edits only settings and stakes lines.

create table if not exists public.overseer_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  tz text not null default 'America/New_York',
  wake text not null default '07:30' check (wake ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  wrap text not null default '21:30' check (wrap ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ping_kinds text[] not null default '{study,work,read,drill}',
  ping_every_min int not null default 40 check (ping_every_min between 10 and 120),
  cap_usd numeric not null default 1 check (cap_usd between 0 and 5),
  cheap_model text not null default 'google/gemini-3.7-flash',
  smart_model text not null default 'anthropic/claude-sonnet-5',
  paused boolean not null default false,
  dry_run boolean not null default true,
  chat_id bigint,
  link_code text,
  updated_at timestamptz not null default now()
);

create table if not exists public.overseer_messages (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  peer text not null check (peer in ('ben', 'partner')),
  text text not null,
  buttons jsonb,
  dry_run boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists overseer_messages_user_created on public.overseer_messages (user_id, created_at desc);

create table if not exists public.overseer_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tool text not null,
  summary text not null,
  before jsonb,
  after jsonb,
  undone_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists overseer_actions_user_created on public.overseer_actions (user_id, created_at desc);

create table if not exists public.overseer_stakes_lines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  text text not null check (char_length(text) between 3 and 280),
  used int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.overseer_partners (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  invite_code text not null unique,
  chat_id bigint,
  joined_at timestamptz,
  left_at timestamptz,
  sent int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.overseer_stakes_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null,
  item_id text not null,
  what text not null,
  status text not null check (status in ('started', 'cancelled', 'sent', 'voided')),
  line_id uuid,
  partner_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.overseer_spend (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null,
  model text not null,
  purpose text not null,
  cost_usd numeric not null default 0,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists overseer_spend_user_day on public.overseer_spend (user_id, day);

alter table public.overseer_settings enable row level security;
alter table public.overseer_messages enable row level security;
alter table public.overseer_actions enable row level security;
alter table public.overseer_stakes_lines enable row level security;
alter table public.overseer_partners enable row level security;
alter table public.overseer_stakes_events enable row level security;
alter table public.overseer_spend enable row level security;

-- the owner reads everything
create policy "overseer_settings read own" on public.overseer_settings for select using (user_id = auth.uid());
create policy "overseer_messages read own" on public.overseer_messages for select using (user_id = auth.uid());
create policy "overseer_actions read own" on public.overseer_actions for select using (user_id = auth.uid());
create policy "overseer_stakes_lines read own" on public.overseer_stakes_lines for select using (user_id = auth.uid());
create policy "overseer_partners read own" on public.overseer_partners for select using (user_id = auth.uid());
create policy "overseer_stakes_events read own" on public.overseer_stakes_events for select using (user_id = auth.uid());
create policy "overseer_spend read own" on public.overseer_spend for select using (user_id = auth.uid());

-- the app edits its rules and the stakes lines; everything else is the agent's (service role)
create policy "overseer_settings update own" on public.overseer_settings for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "overseer_stakes_lines insert own" on public.overseer_stakes_lines for insert with check (user_id = auth.uid());
create policy "overseer_stakes_lines update own" on public.overseer_stakes_lines for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Ben's settings row exists from the start (dry run on)
insert into public.overseer_settings (user_id) values ('f0e1e204-aa54-4a45-bbb5-99c83114fecb') on conflict (user_id) do nothing;
