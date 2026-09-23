-- Tests for migration 0041 (scorecard ledger), run by
-- scripts/test-portal-sandbox.sh after the portal and task suites, against
-- the same replay + fixtures, in either replay order (APPLY_LAST="0041" runs
-- it after 0043, as production will). Own harness schema (rm).

\set team '00000000-0000-4000-a000-000000000001'
\set pa   '00000000-0000-4000-a000-000000000011'
\set ca   '00000000-0000-4000-b000-00000000000a'
\set cb   '00000000-0000-4000-b000-00000000000b'

\o /dev/null
create schema rm;
create table rm.results (n serial, status text, name text, detail text);
grant usage on schema rm to anon, authenticated, service_role;
grant insert, select on rm.results to anon, authenticated, service_role;
grant usage on sequence rm.results_n_seq to anon, authenticated, service_role;
create function rm.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into rm.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function rm.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate; end $$;
create function rm.cnt(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin execute format('select count(*) from (%s) q', p_sql) into n; return n;
exception when others then return -1; end $$;
create function rm.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
-- A valid insert for client A, with overrides.
create function rm.ins(p_client uuid, p_patch jsonb default '{}') returns text language plpgsql as $$
declare d jsonb := jsonb_build_object(
  'client_id', p_client, 'metric', 'search_clicks', 'scope', 'a.example.test web US',
  'source', 'GSC property export', 'context', 'existing_client', 'report_period', null,
  'window_start', '2026-08-01', 'window_end', '2026-08-31', 'status', 'measured',
  'value', 0, 'evidence', 'fixture export', 'meaning', 'zero clicks', 'next_action', 'check') || p_patch;
  cols text := (select string_agg(quote_ident(k), ', ') from jsonb_object_keys(d) k);
begin
  -- Only the supplied columns, so defaults (id) still apply.
  execute format($f$insert into report_measurements (%s)
    select %s from jsonb_populate_record(null::report_measurements, %L)$f$, cols, cols, d);
  return null;
exception when others then return sqlstate; end $$;
grant execute on all functions in schema rm to anon, authenticated, service_role;

-- ── Shape (as postgres) ─────────────────────────────────────────────────────
do $$
begin
  perform rm.ok('R1 RLS on report_measurements',
    (select relrowsecurity from pg_class where oid = 'public.report_measurements'::regclass));
  perform rm.ok('R2 both policies read is_team()',
    (select count(*) from pg_policies where tablename = 'report_measurements'
      and coalesce(qual, with_check) like '%is_team()%') = 2);
  perform rm.ok('R3 authenticated: SELECT + INSERT only; anon: nothing',
    has_table_privilege('authenticated', 'public.report_measurements', 'select,insert')
    and not has_table_privilege('authenticated', 'public.report_measurements', 'update')
    and not has_table_privilege('authenticated', 'public.report_measurements', 'delete')
    and not has_table_privilege('authenticated', 'public.report_measurements', 'truncate')
    and not has_table_privilege('anon', 'public.report_measurements', 'select,insert,update,delete,truncate'));
  perform rm.ok('R4 internal functions not executable over the API',
    not exists (select 1 from pg_proc where proname in ('guard_report_measurement', 'create_reporting_baseline_task')
      and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute'))));
  perform rm.ok('R5 the ledger sequence is not usable by API roles',
    not has_sequence_privilege('authenticated', 'public.report_measurement_sequence', 'usage,select,update')
    and not has_sequence_privilege('anon', 'public.report_measurement_sequence', 'usage,select,update'));
  -- Fixture clients are inserted after every migration, so the intake trigger ran for both.
  perform rm.ok('R6 intake trigger: one TOM reporting_baseline task per client, unassigned (0043)',
    (select count(*) from tasks where key = 'reporting_baseline' and owner = 'TOM' and assignee_id is null
       and client_id in ('00000000-0000-4000-b000-00000000000a', '00000000-0000-4000-b000-00000000000b')) = 2);
  perform rm.ok('R7 the baseline task has its 0043 "created" history row',
    (select count(*) from task_events e join tasks t on t.id = e.task_id
      where t.key = 'reporting_baseline' and e.kind = 'created') = 2);
end $$;

-- ── Team member ─────────────────────────────────────────────────────────────
set role authenticated;
select rm.as_user('authenticated', :'team');
do $$
declare st text; r record; v_today date := (now() at time zone 'America/Chicago')::date;
begin
  st := rm.ins('00000000-0000-4000-b000-00000000000a',
    '{"sequence": -5, "recorded_by": "spoofed", "created_at": "2001-01-01T00:00:00Z"}');
  perform rm.ok('T1 team records a measured zero (callers may omit or spoof stamped columns)', st is null, st);
  select * into r from report_measurements where client_id = '00000000-0000-4000-b000-00000000000a' order by sequence desc limit 1;
  perform rm.ok('T2 sequence, recorded_by and created_at are stamped by the trigger',
    r.sequence > 0 and r.recorded_by = '00000000-0000-4000-a000-000000000001'
    and r.created_at > now() - interval '1 minute', r.sequence || ' ' || r.recorded_by);
  perform rm.ok('T3 zero is stored as zero, not null', r.value = 0);
  st := rm.ins('00000000-0000-4000-b000-00000000000a', jsonb_build_object(
    'metric', 'pages_live', 'window_start', v_today, 'window_end', v_today, 'value', 3));
  perform rm.ok('T4 a measurement dated Compass''s today (America/Chicago) is accepted', st is null, st);
  st := rm.ins('00000000-0000-4000-b000-00000000000a', jsonb_build_object(
    'metric', 'pages_live', 'window_start', v_today + 1, 'window_end', v_today + 1, 'value', 3));
  perform rm.ok('T5 Compass''s tomorrow is refused as a future date', st = '23514', st);
  st := rm.ins('00000000-0000-4000-b000-00000000000a', '{"status": "not_connected", "value": null, "evidence": ""}');
  perform rm.ok('T6 an unavailable status with an empty value is accepted', st is null, st);
  st := rm.ins('00000000-0000-4000-b000-00000000000a', '{"status": "not_connected", "value": 0}');
  perform rm.ok('T7 an unavailable status cannot carry a zero', st = '23514', st);
  st := rm.try($q$update report_measurements set value = 99$q$);
  perform rm.ok('T8 team cannot update history', st is not null, st);
  st := rm.try($q$delete from report_measurements$q$);
  perform rm.ok('T9 team cannot delete history', st is not null, st);
end $$;
reset role;

-- ── Everyone else ───────────────────────────────────────────────────────────
do $$
declare who record; st text; n bigint;
begin
  for who in select * from (values
    ('authenticated', '00000000-0000-4000-a000-000000000011', 'portal user of client A'),
    ('anon', null, 'anonymous')) as w(role, sub, label)
  loop
    perform rm.as_user(who.role, who.sub);
    execute format('set local role %I', who.role);
    n := rm.cnt('select 1 from report_measurements');
    perform rm.ok('P1 ' || who.label || ' reads no measurements', n <= 0, n::text);
    st := rm.ins('00000000-0000-4000-b000-00000000000a');
    perform rm.ok('P2 ' || who.label || ' cannot record a measurement', st is not null, st);
    reset role;
  end loop;
end $$;

-- ── Owner-level protections (as postgres) ──────────────────────────────────
do $$
declare st text;
begin
  st := rm.try($q$update report_measurements set value = 99$q$);
  perform rm.ok('O1 even the owner cannot update history (trigger)', st = '23514', st);
  st := rm.try($q$delete from report_measurements$q$);
  perform rm.ok('O2 even the owner cannot delete history (trigger)', st = '23514', st);
  st := rm.try($q$delete from clients where id = '00000000-0000-4000-b000-00000000000a'$q$);
  perform rm.ok('O3 a client with measurements cannot be deleted (offboard it instead)', st = '23503', st);
  perform rm.ok('O4 ...and it is still there', exists (select 1 from clients where id = '00000000-0000-4000-b000-00000000000a'));
end $$;

\o
\pset footer off
select status, count(*) from rm.results group by status order by status;
select n, status, name, detail from rm.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from rm.results where status = 'fail';
  if f > 0 then raise exception '% report measurement check(s) failed', f; end if;
end $$;
