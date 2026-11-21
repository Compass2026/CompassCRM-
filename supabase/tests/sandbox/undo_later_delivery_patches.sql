-- Sandbox harness only (never a migration). weekly_delivery_standard.test.sql
-- replays the 20261030180000 rollback on today's schema. Rolling back in
-- reverse order would first undo later releases that patched the functions
-- that rollback restores exactly; this undoes only those patches, inside the
-- caller's transaction:
--   20261120210000 (not delivered by decision): delivery_targets_monthly
--   skips slots closed as not delivered.
do $undo$
declare src text := pg_get_functiondef('public.delivery_targets_monthly(uuid,date)'::regprocedure);
begin
  if strpos(src, 'not_delivered_at') = 0 then return; end if;
  src := replace(src, E'\n      and pi.not_delivered_at is null', '');
  src := replace(src, ' and pi.not_delivered_at is null', '');
  execute src;
end
$undo$;
