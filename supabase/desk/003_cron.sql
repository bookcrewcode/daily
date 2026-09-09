-- Desk cron jobs. Applied through the Supabase MCP (execute_sql); kept here as the record.
-- Times are UTC. The world briefing lands at 01:00 UTC (EDT) / 02:00 UTC (EST); the desk
-- reads it and runs one stage per firing (packet -> round1 -> round2 -> judge), so the
-- 5-minute ladder finishes the debate about 20 minutes after the briefing. Firings after
-- "done" return immediately. A firing that finds no briefing yet marks the session
-- "skipped" and the next firing retries it.

select cron.schedule('desk-run', '30,35,40,45,50,55 1,2 * * *', $$
  select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/desk',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('mode','run','userId','f0e1e204-aa54-4a45-bbb5-99c83114fecb',
      'cronSecret',(select decrypted_secret from vault.decrypted_secrets where name='desk_cron_secret')),
    timeout_milliseconds := 140000);
$$);

-- Weekly coach card: Monday 00:00 UTC (Sunday evening in New York).
select cron.schedule('desk-coach', '0 0 * * 1', $$
  select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/desk-review',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('mode','coach','userId','f0e1e204-aa54-4a45-bbb5-99c83114fecb',
      'cronSecret',(select decrypted_secret from vault.decrypted_secrets where name='desk_cron_secret')),
    timeout_milliseconds := 140000);
$$);

-- Already scheduled in Task 9 (fills, exits, funding, marks): desk-sync at :05 and :35 every hour.
-- select cron.schedule('desk-sync', '5,35 * * * *', $$ ... mode 'sync' ... $$);

-- Retired 2026-09-08 (the Desk replaces the RegimeBot news-agent bridge). To bring one back:
-- select cron.schedule('news-agent-run-edt', '30 1 * * *', $$ select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/trader', headers := '{"Content-Type":"application/json"}'::jsonb, body := jsonb_build_object('mode','run','userId','f0e1e204-aa54-4a45-bbb5-99c83114fecb','cronSecret',(select decrypted_secret from vault.decrypted_secrets where name='trader_cron_secret')), timeout_milliseconds := 150000); $$);
-- select cron.schedule('news-agent-sync-edt', '30 20 * * 1-5', $$ ... same with 'mode','sync' ... $$);
-- select cron.schedule('news-agent-sync-est', '30 21 * * 1-5', $$ ... same with 'mode','sync' ... $$);
select cron.unschedule('news-agent-run-edt');
select cron.unschedule('news-agent-sync-edt');
select cron.unschedule('news-agent-sync-est');

-- Phase 5 (2026-09-08): the five-minute heartbeat replaces the half-hourly sync. One minute past each
-- five-minute mark, after the exchanges have opened the new candle.
select cron.unschedule('desk-sync');
select cron.schedule('desk-tick', '1-59/5 * * * *', $$
  select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/desk-tick',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('userId','f0e1e204-aa54-4a45-bbb5-99c83114fecb',
      'cronSecret',(select decrypted_secret from vault.decrypted_secrets where name='desk_cron_secret')),
    timeout_milliseconds := 140000);
$$);

-- 2026-09-08, phase 6: the coach became the daily macro review (with the standard applied first).
--   select cron.alter_job(job_id := 12, schedule := '5 5 * * *');   -- desk-coach, 01:05 ET every day

-- 2026-09-09, phase 7 (the leagues): the nightly nine-seat ladder is retired; the tick now runs the league cycle
-- (marks, deaths, every fresh setup to every team) and the cycle launches the sessions at 08:45, 15:15 and
-- 21:30 ET and the daily cut after 16:06 ET. The sit collector no longer runs. desk-coach stays at 05:05 UTC
-- and now writes the tournament's macro review.
select cron.unschedule('desk-run');
