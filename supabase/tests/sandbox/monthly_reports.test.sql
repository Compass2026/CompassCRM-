-- Tests for 20261021220000 (monthly report versions). Fictional clients only;
-- the fixtures are removed at the end. Callers, as they reach production:
--   person   authenticator, role authenticated, team JWT
--   worker   postgres (the worker's own SQL)
--   portal   authenticator, role authenticated, portal JWT
--   anon     authenticator, role anon

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set pb     '00000000-0000-4000-a000-000000000012'

\c - supabase_admin
\o /dev/null
create schema mr;
create table mr.results (n serial, status text, name text, detail text);
create table mr.saved (k text primary key, v text);
grant usage on schema mr to anon, authenticated, service_role, authenticator, postgres;
grant insert, select on mr.results to anon, authenticated, service_role, authenticator, postgres;
grant insert, select, update on mr.saved to anon, authenticated, service_role, authenticator, postgres;
grant usage on sequence mr.results_n_seq to anon, authenticated, service_role, authenticator, postgres;
create function mr.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into mr.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function mr.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function mr.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function mr.id(p_k text) returns uuid language sql immutable as $$ select md5('mr:' || p_k)::uuid $$;
create function mr.save(p_k text, p_v text) returns void language sql as $$
  insert into mr.saved values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function mr.get(p_k text) returns text language sql stable as $$ select v from mr.saved where k = p_k $$;
create function mr.snap(p_client uuid, p_brand uuid, p_period date, p_cutoff timestamptz, p_completeness text, p_note text default 'x')
returns jsonb language sql stable as $$
  select jsonb_build_object('client_id', p_client, 'brand_workspace_id', p_brand, 'period', p_period::text,
    'cutoff', to_jsonb(p_cutoff)#>>'{}', 'calculation_version', 'monthly-report-test', 'completeness', p_completeness,
    'report', jsonb_build_object('note', p_note), 'audit', jsonb_build_object('rows', 'internal'))
$$;
grant execute on all functions in schema mr to anon, authenticated, service_role, authenticator, postgres;

-- Fixtures: A and B are the sandbox portal clients; M has two brand sites.
insert into client_contacts (client_id, name, email) values
  ('00000000-0000-4000-b000-00000000000a', 'A Owner', 'Owner-A@example.test'),
  ('00000000-0000-4000-b000-00000000000b', 'B Owner', 'owner-b@example.test');
set session_replication_role = replica;
insert into clients (id, name, status) values (mr.id('m'), 'MR Multi', 'active');
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone) values
  (mr.id('m1'), mr.id('m'), 'one', 'Brand One', 'https://one.example.test', '5555555555'),
  (mr.id('m2'), mr.id('m'), 'two', 'Brand Two', 'https://two.example.test', '5555555555');
set session_replication_role = origin;
\o

-- ── Month bounds ────────────────────────────────────────────────────────────
\o /dev/null
select mr.ok('B1 October 2026 is Oct 1 05:00Z to Nov 1 05:00Z (CDT both ends)',
  monthly_report_bounds('2026-10-17') = tstzrange('2026-10-01 05:00+00', '2026-11-01 05:00+00', '[)'));
select mr.ok('B2 November 2026 ends on CST: Nov 1 05:00Z to Dec 1 06:00Z (DST ends inside it)',
  monthly_report_bounds('2026-11-01') = tstzrange('2026-11-01 05:00+00', '2026-12-01 06:00+00', '[)'));
select mr.ok('B3 March 2026 starts on CST: Mar 1 06:00Z to Apr 1 05:00Z (DST starts inside it)',
  monthly_report_bounds('2026-03-01') = tstzrange('2026-03-01 06:00+00', '2026-04-01 05:00+00', '[)'));
select mr.ok('B4 half-open: 23:59:59 Chicago on Oct 31 is October, midnight Nov 1 is not',
  monthly_report_bounds('2026-10-01') @> '2026-10-31 23:59:59 America/Chicago'::timestamptz
  and not monthly_report_bounds('2026-10-01') @> '2026-11-01 00:00:00 America/Chicago'::timestamptz);
\o

-- ── Person: generate, edit, review, approve, correct, deliver ──────────────
\c - authenticator
set role authenticated;
select mr.as_user('authenticated', :'team');
\o /dev/null
do $$
declare
  a uuid := '00000000-0000-4000-b000-00000000000a';
  b uuid := '00000000-0000-4000-b000-00000000000b';
  sep_cut timestamptz := '2026-10-01 05:00+00';
  cur date := date_trunc('month', now() at time zone 'America/Chicago')::date;
  cur_cut timestamptz;
  r jsonb; r2 jsonb; v1 uuid; v2 uuid; h text; e text;
begin
  -- Current month: a partial preview.
  cur_cut := greatest(now() - interval '1 minute', lower(monthly_report_bounds(cur)) + interval '1 second');
  r := monthly_report_save(a, null, cur, cur_cut, 'monthly-report-test', mr.snap(a, null, cur, cur_cut, 'complete'), '{}', 'mrtest-req-partial-1');
  perform mr.save('partial', r->>'report_id');
  perform mr.ok('G1 generating the current month makes a partial draft version 1',
    (select status = 'draft' and version = 1 and is_partial and period_end = upper(monthly_report_bounds(cur)) from monthly_reports where id = (r->>'report_id')::uuid));
  r2 := monthly_report_save(a, null, cur, cur_cut, 'monthly-report-test', mr.snap(a, null, cur, cur_cut, 'complete'), '{}', 'mrtest-req-partial-1');
  perform mr.ok('G2 a retried Generate (same request key) returns the same version', (r2->>'reused')::boolean and r2->>'report_id' = r->>'report_id');
  r2 := monthly_report_save(a, null, cur, cur_cut, 'monthly-report-test', mr.snap(a, null, cur, cur_cut, 'complete'), '{}', 'mrtest-req-partial-2');
  perform mr.ok('G3 the same figures under a new request key return the open version, not a duplicate',
    (r2->>'reused')::boolean and r2->>'report_id' = r->>'report_id'
    and (select count(*) from monthly_reports where client_id = a and period = cur) = 1);
  perform mr.ok('G4 a snapshot for another client is refused',
    mr.try(format('select monthly_report_save(%L, null, %L, %L, ''monthly-report-test'', %L::jsonb, ''{}'', ''mrtest-req-iso-1'')',
      a, cur, cur_cut, mr.snap(b, null, cur, cur_cut, 'complete'))) like '23514%');
  perform mr.ok('G5 another client''s brand site is refused',
    mr.try(format('select monthly_report_save(%L, %L, %L, %L, ''monthly-report-test'', %L::jsonb, ''{}'', ''mrtest-req-iso-2'')',
      a, mr.id('m1'), cur, cur_cut, mr.snap(a, mr.id('m1'), cur, cur_cut, 'complete'))) like '23514%');
  perform mr.ok('G6 a cutoff in the future is refused',
    mr.try(format('select monthly_report_save(%L, null, %L, %L, ''monthly-report-test'', %L::jsonb, ''{}'', ''mrtest-req-future'')',
      a, cur, now() + interval '1 day', mr.snap(a, null, cur, now() + interval '1 day', 'complete'))) like '22023%');
  perform monthly_report_submit((r->>'report_id')::uuid, 1);
  h := (select content_hash from monthly_reports where id = (r->>'report_id')::uuid);
  perform mr.ok('G7 a partial preview can be reviewed but never approved',
    mr.try(format('select monthly_report_approve(%L, %L, ''email'', array[''owner-a@example.test''])', r->>'report_id', h)) like '23514%partial preview%');

  -- September: a complete month.
  r := monthly_report_save(a, null, '2026-09-01', sep_cut, 'monthly-report-test', mr.snap(a, null, '2026-09-01', sep_cut, 'complete', 'v1'),
         '{"summary": ["first"]}', 'mrtest-req-sep-1');
  v1 := (r->>'report_id')::uuid; perform mr.save('v1', v1::text);
  perform mr.ok('E1 a month generated at its end is not partial', (select not is_partial and completeness = 'complete' from monthly_reports where id = v1));
  perform monthly_report_edit(v1, 1, '{"summary": ["second"]}');
  perform mr.ok('E2 an edit with a stale edit version is refused',
    mr.try(format('select monthly_report_edit(%L, 1, ''{"summary": ["third"]}'')', v1)) like '40001%');
  perform monthly_report_submit(v1, 2);
  h := (select content_hash from monthly_reports where id = v1);
  perform monthly_report_edit(v1, 2, '{"summary": ["edited in review"]}');
  perform mr.ok('E3 editing a report in review sends it back to draft',
    (select status = 'draft' and submitted_at is null and content_hash <> h from monthly_reports where id = v1));
  perform monthly_report_submit(v1, 3);
  perform mr.ok('E4 approving against the hash Tom saw before the edit is refused',
    mr.try(format('select monthly_report_approve(%L, %L, ''email'', array[''owner-a@example.test''])', v1, h)) like '40001%');
  h := (select content_hash from monthly_reports where id = v1);
  perform mr.ok('E5 another client''s contact is never a recipient',
    mr.try(format('select monthly_report_approve(%L, %L, ''email'', array[''owner-b@example.test''])', v1, h)) like '23514%');
  perform mr.ok('E6 portal approval needs an active portal contact of this client',
    mr.try(format('select monthly_report_approve(%L, %L, ''portal'', array[''owner-a@example.test''])', v1, h)) like '23514%');
  r := monthly_report_approve(v1, h, 'portal', array['Portal-A@example.test']);
  perform mr.ok('E7 approval records the exact hash, destination and lower-cased recipients',
    (select status = 'approved' and approved_hash = h and approved_destination = 'portal' and approved_recipients = array['portal-a@example.test']
       from monthly_reports where id = v1));
  r := monthly_report_approve(v1, h, 'portal', array['portal-a@example.test']);
  perform mr.ok('E8 approving again is idempotent', (r->>'already')::boolean);
  perform mr.ok('E9 an approved version cannot be edited',
    mr.try(format('select monthly_report_edit(%L, 3, ''{"summary": ["late"]}'')', v1)) like '23514%');
  perform mr.ok('E10 a teammate cannot write the table directly (only the functions)',
    mr.try(format('update monthly_reports set editorial = ''{}'' where id = %L', v1)) like '42501%'
    and mr.try(format('delete from monthly_reports where id = %L', v1)) like '42501%');

  -- Delivery
  perform mr.ok('D1 a delivery outside the approval (destination) is refused',
    mr.try(format('select monthly_report_record_delivery(%L, ''email'', array[''portal-a@example.test''], ''sent'', '''', ''mrtest-del-1'')', v1)) like '23514%');
  perform mr.ok('D2 a delivery outside the approval (recipients) is refused',
    mr.try(format('select monthly_report_record_delivery(%L, ''portal'', array[''portal-a-former@example.test''], ''sent'', '''', ''mrtest-del-2'')', v1)) like '23514%');
  r := monthly_report_record_delivery(v1, 'portal', array['portal-a@example.test'], 'uncertain', 'not confirmed', 'mrtest-del-3');
  perform mr.ok('D3 an uncertain outcome is recorded and is not a sent delivery',
    (select count(*) from monthly_report_deliveries where report_id = v1 and outcome = 'uncertain') = 1
    and not exists (select 1 from monthly_report_deliveries where report_id = v1 and outcome = 'sent'));
  r := monthly_report_record_delivery(v1, 'portal', array['portal-a@example.test'], 'sent', 'published', 'mrtest-del-4');
  r2 := monthly_report_record_delivery(v1, 'portal', array['portal-a@example.test'], 'sent', 'published', 'mrtest-del-4');
  perform mr.ok('D4 a retried record (same key) returns the same delivery', (r2->>'reused')::boolean and r2->>'delivery_id' = r->>'delivery_id');
  perform mr.ok('D5 a second sent delivery of the same version is refused',
    mr.try(format('select monthly_report_record_delivery(%L, ''portal'', array[''portal-a@example.test''], ''sent'', '''', ''mrtest-del-5'')', v1)) like '23505%');
  perform mr.ok('D6 delivery records never change',
    mr.try(format('update monthly_report_deliveries set outcome = ''failed'' where id = %L', r->>'delivery_id')) like '42501%');

  -- Correction
  perform mr.ok('C1 regenerating an approved month needs a correction reason',
    mr.try(format('select monthly_report_save(%L, null, ''2026-09-01'', %L, ''monthly-report-test'', %L::jsonb, null, ''mrtest-req-sep-2'')',
      a, sep_cut, mr.snap(a, null, '2026-09-01', sep_cut, 'incomplete', 'v2'))) like '22023%');
  r := monthly_report_save(a, null, '2026-09-01', sep_cut, 'monthly-report-test', mr.snap(a, null, '2026-09-01', sep_cut, 'incomplete', 'v2'),
         null, 'mrtest-req-sep-2', 'GBP import arrived late');
  v2 := (r->>'report_id')::uuid; perform mr.save('v2', v2::text);
  perform mr.ok('C2 the correction is version 2, linked to version 1 with its reason, editorial carried forward',
    (select version = 2 and supersedes_id = v1 and correction_reason = 'GBP import arrived late' and status = 'draft'
            and editorial = '{"summary": ["edited in review"]}'::jsonb from monthly_reports where id = v2));
  perform mr.ok('C3 version 1 stays approved (and stays what the client sees) until the correction is approved',
    (select status = 'approved' from monthly_reports where id = v1));
  perform monthly_report_submit(v2, 1);
  h := (select content_hash from monthly_reports where id = v2);
  perform mr.ok('C4 an incomplete report needs an explicit incomplete approval',
    mr.try(format('select monthly_report_approve(%L, %L, ''portal'', array[''portal-a@example.test''])', v2, h)) like '23514%missing sources%');
  r := monthly_report_approve(v2, h, 'portal', array['portal-a@example.test'], true);
  perform mr.ok('C5 approving the correction supersedes version 1; one approved version per month',
    (select status = 'superseded' and superseded_by = v2 from monthly_reports where id = v1)
    and (select count(*) from monthly_reports where client_id = a and period = '2026-09-01' and status = 'approved') = 1);
  perform mr.ok('C6 a superseded version is not delivered',
    mr.try(format('select monthly_report_record_delivery(%L, ''email'', array[''owner-a@example.test''], ''failed'', '''', ''mrtest-del-6'')', v1)) like '23514%');

  -- Brand units are separate reports.
  r := monthly_report_save(mr.id('m'), mr.id('m1'), '2026-09-01', sep_cut, 'monthly-report-test', mr.snap(mr.id('m'), mr.id('m1'), '2026-09-01', sep_cut, 'complete'), '{}', 'mrtest-req-m1');
  r2 := monthly_report_save(mr.id('m'), mr.id('m2'), '2026-09-01', sep_cut, 'monthly-report-test', mr.snap(mr.id('m'), mr.id('m2'), '2026-09-01', sep_cut, 'complete'), '{}', 'mrtest-req-m2');
  perform mr.ok('U1 each brand site has its own version 1 for the same month',
    (select count(*) = 2 and bool_and(version = 1) from monthly_reports where client_id = mr.id('m')));
  perform mr.ok('U2 a brand report cannot carry the other brand''s snapshot',
    mr.try(format('select monthly_report_save(%L, %L, ''2026-09-01'', %L, ''monthly-report-test'', %L::jsonb, ''{}'', ''mrtest-req-m3'')',
      mr.id('m'), mr.id('m1'), sep_cut, mr.snap(mr.id('m'), mr.id('m2'), '2026-09-01', sep_cut, 'complete', 'other'))) like '23514%');
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Worker: no person, no report; and the guard holds for its SQL too ──────
\c - postgres
\o /dev/null
do $$
declare v1 uuid := mr.get('v1')::uuid; v2 uuid := mr.get('v2')::uuid;
begin
  perform mr.ok('W1 the worker''s SQL cannot generate or approve (no signed-in person)',
    mr.try(format('select monthly_report_save(%L, null, ''2026-08-01'', ''2026-09-01 05:00+00'', ''monthly-report-test'', %L::jsonb, ''{}'', ''mrtest-req-worker'')',
      '00000000-0000-4000-b000-00000000000a', mr.snap('00000000-0000-4000-b000-00000000000a', null, '2026-08-01', '2026-09-01 05:00+00', 'complete'))) like '42501%');
  perform mr.ok('W2 even the table owner cannot change a frozen snapshot',
    mr.try(format('update monthly_reports set snapshot = snapshot || ''{"x": 1}'' where id = %L', mr.get('partial'))) like '42501%');
  perform mr.ok('W3 even the table owner cannot edit an approved or superseded version',
    mr.try(format('update monthly_reports set editorial = ''{}'' where id = %L', v2)) like '42501%'
    and mr.try(format('update monthly_reports set approved_recipients = array[''x@example.test''] where id = %L', v1)) like '42501%');
  perform mr.ok('W4 nobody deletes a version or a delivery',
    mr.try(format('delete from monthly_reports where id = %L', v1)) like '42501%'
    and mr.try('delete from monthly_report_deliveries') like '42501%');
  perform mr.ok('W5 a second open version for the same month is refused by the index',
    mr.try(format($q$insert into monthly_reports (client_id, period, version, cutoff, calculation_version, snapshot, snapshot_hash,
      content_hash, period_start, period_end, is_partial, completeness, request_key)
      values ('00000000-0000-4000-b000-00000000000a', %L, 9, now() - interval '1 minute', 'monthly-report-test', %L::jsonb, '', '', now(), now(), false, 'complete', 'mrtest-req-direct')$q$,
      (select period from monthly_reports where id = mr.get('partial')::uuid),
      mr.snap('00000000-0000-4000-b000-00000000000a', null, (select period from monthly_reports where id = mr.get('partial')::uuid), now() - interval '1 minute', 'complete'))) is not null);
end $$;
\o

-- ── Portal: own client's published version only, never the audit ──────────
\c - authenticator
set role authenticated;
select mr.as_user('authenticated', :'pa');
\o /dev/null
do $$
begin
  perform mr.ok('P1 until the correction is published, portal A still sees the version it was given (v1), without the audit section',
    (select count(*) = 1 and bool_and(version = 1 and not (report ? 'audit')) from portal_monthly_reports));
  perform mr.ok('P2 portal A cannot read report versions or deliveries directly',
    (select count(*) from monthly_reports) = 0 and (select count(*) from monthly_report_deliveries) = 0);
  perform mr.ok('P3 portal A cannot generate, edit, approve or record',
    mr.try(format('select monthly_report_edit(%L, 1, ''{}'')', mr.get('partial'))) like '42501%'
    and mr.try(format('select monthly_report_record_delivery(%L, ''portal'', array[''portal-a@example.test''], ''sent'', '''', ''mrtest-del-portal'')', mr.get('v2'))) like '42501%');
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- The correction is published to the portal, then portal A sees it.
set role authenticated;
select mr.as_user('authenticated', :'team');
\o /dev/null
select monthly_report_record_delivery(mr.get('v2')::uuid, 'portal', array['portal-a@example.test'], 'sent', 'published', 'mrtest-del-v2');
\o
reset role;
set role authenticated;
select mr.as_user('authenticated', :'pa');
\o /dev/null
select mr.ok('P4 after publication portal A sees exactly version 2, no audit section',
  (select count(*) = 1 and bool_and(version = 2 and not (report ? 'audit') and report->'report'->>'note' = 'v2') from portal_monthly_reports));
\o
reset role;
set role authenticated;
select mr.as_user('authenticated', :'pb');
\o /dev/null
select mr.ok('P5 portal B sees none of client A''s reports', (select count(*) from portal_monthly_reports) = 0);
\o
reset role;
set role anon;
select mr.as_user('anon', null);
\o /dev/null
select mr.ok('P6 anon reads nothing and calls nothing',
  mr.try('select count(*) from portal_monthly_reports') like '42501%'
  and mr.try('select count(*) from monthly_reports') like '42501%'
  and mr.try(format('select monthly_report_submit(%L, 1)', mr.get('partial'))) like '42501%');
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Results and cleanup ────────────────────────────────────────────────────
\c - supabase_admin
\pset footer off
select status, count(*) from mr.results group by status order by status;
select n, status, name, detail from mr.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from mr.results where status = 'fail';
  if f > 0 then raise exception '% monthly report check(s) failed', f; end if;
end $$;
\o /dev/null
set session_replication_role = replica;
delete from monthly_report_deliveries;
delete from monthly_reports;
delete from client_brand_workspaces where client_id = mr.id('m');
delete from clients where id = mr.id('m');
delete from client_contacts where email in ('Owner-A@example.test', 'owner-b@example.test');
set session_replication_role = origin;
drop schema mr cascade;
\o
