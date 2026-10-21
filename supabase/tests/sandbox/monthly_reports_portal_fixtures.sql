-- Temporary rows for the generic portal boundary checks: one approved,
-- portal-published monthly report per sandbox portal client. Written as the
-- worker would, through the guard's own transitions.
begin;
insert into monthly_reports (id, client_id, period, version, cutoff, calculation_version, snapshot, snapshot_hash, content_hash,
  period_start, period_end, is_partial, completeness, request_key)
select ('00000000-0000-4000-8000-0000000c00' || x.k)::uuid, x.client_id, '2026-08-01', 1, '2026-09-01 05:00+00', 'fixture',
  jsonb_build_object('client_id', x.client_id, 'brand_workspace_id', null, 'period', '2026-08-01', 'cutoff', '2026-09-01T05:00:00+00:00',
    'calculation_version', 'fixture', 'completeness', 'complete', 'report', '{}'::jsonb, 'audit', jsonb_build_object('private', 'PRIVATE')),
  '', '', '-infinity', '-infinity', false, 'complete', 'fixture-portal-' || x.k
from (values ('0a', '00000000-0000-4000-b000-00000000000a'::uuid), ('0b', '00000000-0000-4000-b000-00000000000b'::uuid)) x(k, client_id);
update monthly_reports set status = 'in_review', submitted_at = now(), submitted_by = (select id from team_members order by id limit 1)
 where id in ('00000000-0000-4000-8000-0000000c000a', '00000000-0000-4000-8000-0000000c000b');
update monthly_reports set status = 'approved', approved_at = now(), approved_by = submitted_by, approved_hash = content_hash,
       approved_destination = 'portal',
       approved_recipients = case client_id when '00000000-0000-4000-b000-00000000000a' then array['portal-a@example.test'] else array['portal-b@example.test'] end
 where id in ('00000000-0000-4000-8000-0000000c000a', '00000000-0000-4000-8000-0000000c000b');
insert into monthly_report_deliveries (report_id, client_id, destination, recipients, outcome, request_key, recorded_by)
select id, client_id, 'portal', approved_recipients, 'sent', 'fixture-delivery-' || id, approved_by
from monthly_reports where id in ('00000000-0000-4000-8000-0000000c000a', '00000000-0000-4000-8000-0000000c000b');
commit;
