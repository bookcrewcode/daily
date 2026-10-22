-- Portfolio copilot, review fix (2026-10-17): a weekly lot keeps the buy day it was scheduled for
-- (due_day), separate from its editable date, and a week Robinhood didn't buy is marked skipped
-- instead of deleted. The tick dedupes on due_day, so editing or skipping a weekly lot sticks.
-- Applied through the Supabase MCP as migration portfolio_due_day; kept here as the record.

alter table public.pf_lots add column if not exists due_day date;
alter table public.pf_lots add column if not exists skipped boolean not null default false;
update public.pf_lots set due_day = day where kind = 'weekly' and due_day is null;
alter table public.pf_lots drop constraint if exists pf_lots_weekly_due_day;
alter table public.pf_lots add constraint pf_lots_weekly_due_day check (kind <> 'weekly' or due_day is not null);
drop index if exists public.pf_lots_weekly_once;
create unique index if not exists pf_lots_weekly_once on public.pf_lots(user_id, symbol, due_day) where kind = 'weekly';
