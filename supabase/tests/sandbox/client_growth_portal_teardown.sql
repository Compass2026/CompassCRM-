-- Remove only these synthetic rows as the isolated cluster administrator.
-- Disable immutable-history triggers for fixture cleanup, never in production.
begin;
set local session_replication_role = replica;
delete from backlink_checks where opportunity_id in ('00000000-0000-4000-8000-00000000f001','00000000-0000-4000-8000-00000000f002','00000000-0000-4000-8000-00000000f003');
delete from backlink_opportunities where id in ('00000000-0000-4000-8000-00000000f001','00000000-0000-4000-8000-00000000f002','00000000-0000-4000-8000-00000000f003');
delete from report_measurements where id in ('00000000-0000-4000-8000-00000000e001','00000000-0000-4000-8000-00000000e002');
commit;
