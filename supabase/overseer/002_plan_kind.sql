-- Overseer: timed items from the Plan chat are their own check-in kind
-- ("plan"), on by default, so Ben can switch them off on the Overseer page.
alter table public.overseer_settings alter column ping_kinds set default '{study,work,read,drill,plan}';
update public.overseer_settings set ping_kinds = array_append(ping_kinds, 'plan') where not ('plan' = any(ping_kinds));
