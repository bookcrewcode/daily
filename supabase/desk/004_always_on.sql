-- The Desk, phase 5 (always on). Record of the three migrations applied through the
-- Supabase MCP on 2026-09-08 (desk_always_on, desk_scan_state, desk_sit_ratings).
-- The live database is the source of truth; this file is the readable copy.

-- ── desk_always_on: feed, setups, sits, strategies, watchlist; timeframes on trades ──
alter table public.desk_trades
  add column if not exists source text not null default 'nightly',      -- nightly | sit | shadow
  add column if not exists strategy text not null default '',           -- scan strategy id, '' for jury-only trades
  add column if not exists timeframe text not null default 'swing',     -- scalp | swing | position
  add column if not exists sit_id uuid,
  add column if not exists horizon_hours integer,                       -- scalps run on a clock in hours
  add column if not exists size_mult numeric not null default 1;        -- the strategy's earned size at decision time
create index if not exists desk_trades_strategy on public.desk_trades(user_id, strategy, status);

-- ballots from sits have no session; they point at the sit instead
alter table public.desk_opinions alter column session_id drop not null;
alter table public.desk_opinions add column if not exists sit_id uuid;
create index if not exists desk_opinions_sit on public.desk_opinions(sit_id, round);

alter table public.desk_accounts
  add column if not exists sit_roster jsonb not null default '["google/gemini-3.8-flash","openai/gpt-5.6-luna","deepseek/deepseek-v4-flash-0731"]'::jsonb,
  add column if not exists sit_budget_usd numeric not null default 3,
  add column if not exists cooldown_hours numeric not null default 4,
  add column if not exists strategies_off jsonb not null default '[]'::jsonb;

-- the news funnel is shared (no user column); the service role writes, signed-in users read
create table if not exists public.desk_news (
  id uuid primary key default gen_random_uuid(),
  link text not null unique,
  title text not null,
  source text not null default '',
  published timestamptz not null default now(),
  summary text not null default '',
  tickers jsonb not null default '[]'::jsonb,
  venue text not null default 'none',       -- stock | crypto | macro | none
  category text not null default 'other',   -- macro | earnings | guidance | deal | regulation | geopolitics | crypto | company | other
  impact integer not null default 0,        -- 1 noise … 5 moves an index or a major coin today
  direction text not null default 'none',   -- bullish | bearish | mixed | none
  horizon text not null default 'none',     -- scalp | swing | position | none
  why text not null default '',             -- one line on the mechanism
  tagged boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists desk_news_published on public.desk_news(published desc);
create index if not exists desk_news_tickers on public.desk_news using gin (tickers);
alter table public.desk_news enable row level security;
do $$ begin
  create policy desk_news_read on public.desk_news for select to authenticated using (true);
exception when duplicate_object then null; end $$;

-- what the scan flagged: one row per strategy × symbol × side, expiring by timeframe
create table if not exists public.desk_setups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  strategy text not null,
  symbol text not null,
  venue text not null,
  instrument text not null,
  side text not null,
  timeframe text not null default 'swing',
  entry_ref numeric not null,
  stop numeric not null,
  target numeric not null,
  leverage_hint numeric not null default 1,
  horizon_hours integer,
  horizon_days integer,
  score numeric not null default 0,           -- confluence: confirmations that held / confirmations checked
  reasons jsonb not null default '[]'::jsonb, -- [{label, value, ok, core}]
  invalidation text not null default '',
  news jsonb not null default '[]'::jsonb,
  card jsonb not null default '{}'::jsonb,    -- the tape snapshot the jury reads
  status text not null default 'new',         -- new | held | cooled | sit | taken | passed
  sit_id uuid,
  trade_id uuid,
  shadow_trade_id uuid,                       -- the strategy's own book took it regardless
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists desk_setups_user_status on public.desk_setups(user_id, status, created_at desc);
create index if not exists desk_setups_symbol on public.desk_setups(user_id, symbol, created_at desc);
alter table public.desk_setups enable row level security;
do $$ begin
  create policy desk_setups_own on public.desk_setups for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- a sit: the fast jury on one setup
create table if not exists public.desk_sits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  setup_id uuid references public.desk_setups(id) on delete set null,
  symbol text not null,
  strategy text not null default '',
  timeframe text not null default 'swing',
  status text not null default 'launched',    -- launched | done | failed
  brief jsonb not null default '{}'::jsonb,   -- what every juror read
  launched jsonb not null default '{}'::jsonb,-- {juror: {at, n}} for relaunches
  votes jsonb not null default '[]'::jsonb,   -- the ballots, copied in at settle
  decision jsonb not null default '{}'::jsonb,-- {take, taken, score, answered, takers, reasons, sized}
  trade_id uuid,
  cost_usd numeric not null default 0,
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists desk_sits_user_status on public.desk_sits(user_id, status, created_at desc);
alter table public.desk_sits enable row level security;
do $$ begin
  create policy desk_sits_own on public.desk_sits for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- a strategy's earned size, written by desk-review when its shadow trade closes
create table if not exists public.desk_strategies (
  user_id uuid not null default auth.uid(),
  id text not null,
  enabled boolean not null default true,
  size_mult numeric not null default 1,       -- 0.5 benched … 2 promoted
  benched_until date,
  stats jsonb not null default '{}'::jsonb,   -- {n, wins, hit, mean_r, shrunk_r, recent_r, label, as_of}
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.desk_strategies enable row level security;
do $$ begin
  create policy desk_strategies_own on public.desk_strategies for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

create table if not exists public.desk_watchlist (
  user_id uuid not null default auth.uid(),
  symbol text not null,
  venue text not null default 'robinhood',
  source text not null default 'seed',
  added_at timestamptz not null default now(),
  primary key (user_id, symbol)
);
alter table public.desk_watchlist enable row level security;
do $$ begin
  create policy desk_watchlist_own on public.desk_watchlist for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- Ben: no limits, 5% risk per trade, and the seed watchlist (S&P names, growth names, sector ETFs)
update public.desk_accounts set preset = 'no_limits', rules = coalesce(rules, '{}'::jsonb) || '{"risk_pct": 5}'::jsonb, updated_at = now()
  where user_id = 'f0e1e204-aa54-4a45-bbb5-99c83114fecb';
insert into public.desk_watchlist (user_id, symbol, venue, source)
select 'f0e1e204-aa54-4a45-bbb5-99c83114fecb', s, 'robinhood', 'seed' from unnest(array[
  'AAPL','ABBV','ABT','ACN','ADBE','AIG','AMD','AMGN','AMT','AMZN','AVGO','AXP','BA','BAC','BK','BKNG','BLK','BMY','BRK-B','C','CAT','CHTR','CL','CMCSA','COF','COP','COST','CRM','CSCO','CVS','CVX','DE','DHR','DIS','DUK','EMR','FDX','GD','GE','GEV','GILD','GM','GOOG','GOOGL','GS','HD','HON','IBM','INTC','INTU','ISRG','JNJ','JPM','KO','LIN','LLY','LMT','LOW','MA','MCD','MDLZ','MDT','MET','META','MMM','MO','MRK','MS','MSFT','NEE','NFLX','NKE','NOW','NVDA','ORCL','PEP','PFE','PG','PLTR','PM','PYPL','QCOM','RTX','SBUX','SCHW','SO','SPG','T','TGT','TMO','TMUS','TSLA','TXN','UNH','UNP','UPS','USB','V','VZ','WFC','WMT','XOM',
  'MU','LRCX','AMAT','KLAC','ADI','MRVL','PANW','CRWD','SNPS','CDNS','ADP','VRTX','REGN','MELI','PDD','ARM','APP','MSTR','COIN','SHOP','DASH','ABNB','UBER','HOOD','SMCI','ANET','TTD','FTNT','DDOG','CEG',
  'XLE','XLF','XLK','XLV','XLU','XLP','XLY','XLI','XLB','XLRE','XLC','SMH','SPY','QQQ','IWM','DIA','TLT','GLD','USO','UUP','IBIT','ETHA'
]) as s
on conflict do nothing;

-- ── desk_scan_state: the scan remembers its daily stock pass ──
alter table public.desk_accounts add column if not exists scan_state jsonb not null default '{}'::jsonb;
create index if not exists desk_setups_expires on public.desk_setups(user_id, expires_at);

-- ── desk_sit_ratings: sit ballots scored against the setup's shadow-book outcome ──
alter table public.desk_ratings
  add column if not exists n_sits integer not null default 0,
  add column if not exists n_sit_right integer not null default 0;
comment on column public.desk_ratings.n_sits is 'sit ballots scored against the setup''s shadow-book outcome';
comment on column public.desk_ratings.n_sit_right is 'sit ballots on the right side of that outcome (take and it won, or pass and it lost)';
