-- Remove the fixture reports (versions are never deleted in production; the
-- guard is bypassed here only to reset the isolated sandbox).
begin;
set local session_replication_role = replica;
delete from monthly_report_deliveries where report_id in ('00000000-0000-4000-8000-0000000c000a', '00000000-0000-4000-8000-0000000c000b');
delete from monthly_reports where id in ('00000000-0000-4000-8000-0000000c000a', '00000000-0000-4000-8000-0000000c000b');
commit;
