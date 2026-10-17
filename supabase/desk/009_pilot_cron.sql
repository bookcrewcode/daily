-- The portfolio copilot's five-minute heartbeat (build step 1): the news feed on the quarter,
-- the weekly lot after 09:36 ET on the buy day, the morning report from 08:30 ET.
-- Applied through the Supabase MCP (execute_sql); kept here as the record. Two minutes past each
-- five-minute mark, one minute after the paused desk-tick's slot.
select cron.schedule('pilot-tick', '2-59/5 * * * *', $$
  select net.http_post(url := 'https://pciljeqsrricybdnhvsu.supabase.co/functions/v1/pilot',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('mode','tick','userId','f0e1e204-aa54-4a45-bbb5-99c83114fecb',
      'cronSecret',(select decrypted_secret from vault.decrypted_secrets where name='desk_cron_secret')),
    timeout_milliseconds := 140000);
$$);
