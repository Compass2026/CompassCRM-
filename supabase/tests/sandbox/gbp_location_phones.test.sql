-- 20261103170000: a phone recorded for one Business Profile location. The
-- row belongs to one of the client's own Business Profile locations, has a
-- sane format, is team-only (RLS is_team(), anon nothing; the post-drafter's
-- service role reads it; grants as gbp_location_markets), names a teammate
-- as recorder, and the down script removes it. Fictional clients and
-- synthetic 555-01xx numbers only; everything is removed at the end. Own
-- harness schema (lp).
\set team '00000000-0000-4000-a000-000000000001'
\set outsider '00000000-0000-4000-a000-0000000000f9'
\set ca '00000000-0000-4000-e700-00000000000a'
\set cb '00000000-0000-4000-e700-00000000000b'
\c - supabase_admin
create schema lp;
create table lp.ids(k text primary key, id uuid);
create function lp.id(p_k text) returns uuid language sql stable as $$ select id from lp.ids where k = p_k $$;
create function lp.ok(label text, cond boolean, detail text default null) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED % %', label, coalesce(detail, ''); end if; raise notice 'ok %', label; end $$;
create function lp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function lp.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
grant usage on schema lp to anon, authenticated, service_role;
grant select on lp.ids to anon, authenticated, service_role;
grant execute on all functions in schema lp to anon, authenticated, service_role;

insert into clients (id, name, status) values (:'ca', 'LP Multi-location', 'active'), (:'cb', 'LP Other client', 'active');
with a as (
  insert into social_accounts (client_id, platform, external_account_id, display_name) values
    (:'ca', 'google_business', 'locations/800001', 'LP North'),
    (:'ca', 'google_business', 'locations/800002', 'LP South'),
    (:'ca', 'facebook', '8000001', 'LP Page'),
    (:'cb', 'google_business', 'locations/800003', 'LP Other')
  returning id, display_name)
insert into lp.ids select display_name, id from a;

-- ── 1. A teammate records a location's phone ────────────────────────────────
\c - authenticator
set role authenticated;
select lp.as_user('authenticated', :'team');
do $$
declare e text;
begin
  insert into gbp_location_phones (social_account_id, client_id, phone, source_ref)
    values (lp.id('LP North'), '00000000-0000-4000-e700-00000000000a', '(316) 555-0142', 'test: the north location''s number');
  perform lp.ok('P1 a teammate records one location''s phone; the recorder is that teammate',
    (select phone = '(316) 555-0142' and recorded_by = (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001')
       from gbp_location_phones where social_account_id = lp.id('LP North')));
  perform lp.ok('P2 the other location of the same client has none', not exists (select 1 from gbp_location_phones where social_account_id = lp.id('LP South')));
  e := lp.try(format($q$insert into gbp_location_phones (social_account_id, client_id, phone, source_ref) values (%L, %L, '(316) 555-0143', 'x')$q$,
    lp.id('LP North'), '00000000-0000-4000-e700-00000000000a'));
  perform lp.ok('P3 one phone per location', e like '23505:%', e);
  for e in select unnest(array['555-0142', '(016) 555-0142', '+1 316 555 0142', '316-555-0142 ext 4', 'call us', '']) loop
    perform lp.ok('P4 a malformed phone is refused: ' || e,
      lp.try(format($q$insert into gbp_location_phones (social_account_id, client_id, phone, source_ref) values (%L, %L, %L, 'x')$q$,
        lp.id('LP South'), '00000000-0000-4000-e700-00000000000a', e)) like '23514:%');
  end loop;
  e := lp.try(format($q$insert into gbp_location_phones (social_account_id, client_id, phone, source_ref) values (%L, %L, '316-555-0144', '  ')$q$,
    lp.id('LP South'), '00000000-0000-4000-e700-00000000000a'));
  perform lp.ok('P5 a phone names its source', e like '23514:%', e);
  e := lp.try(format($q$insert into gbp_location_phones (social_account_id, client_id, phone, source_ref) values (%L, %L, '316-555-0144', 'x')$q$,
    lp.id('LP Page'), '00000000-0000-4000-e700-00000000000a'));
  perform lp.ok('P6 a Facebook Page is not a Business Profile location', e like '23514:%Business Profile locations%', e);
  e := lp.try(format($q$insert into gbp_location_phones (social_account_id, client_id, phone, source_ref) values (%L, %L, '316-555-0144', 'x')$q$,
    lp.id('LP Other'), '00000000-0000-4000-e700-00000000000a'));
  perform lp.ok('P7 another client''s location cannot carry this client''s phone', e like '23514:%', e);
  e := lp.try(format($q$update gbp_location_phones set social_account_id = %L where social_account_id = %L$q$, lp.id('LP Other'), lp.id('LP North')));
  perform lp.ok('P8 ... nor be moved there', e like '23514:%', e);
  insert into gbp_location_phones (social_account_id, client_id, phone, source_ref)
    values (lp.id('LP South'), '00000000-0000-4000-e700-00000000000a', '316.555.0145', 'test: the south location''s number');
  update gbp_location_phones set phone = '316-555-0146' where social_account_id = lp.id('LP South');
  perform lp.ok('P9 a teammate corrects a number', (select phone = '316-555-0146' from gbp_location_phones where social_account_id = lp.id('LP South')));
end $$;
reset role;

-- ── 2. Nobody else ──────────────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select lp.as_user('authenticated', :'outsider');
do $$
declare e text;
begin
  perform lp.ok('P10 a signed-in non-teammate sees no location phone', (select count(*) = 0 from gbp_location_phones));
  e := lp.try(format($q$insert into gbp_location_phones (social_account_id, client_id, phone, source_ref) values (%L, %L, '316-555-0147', 'x')$q$,
    lp.id('LP South'), '00000000-0000-4000-e700-00000000000a'));
  perform lp.ok('P11 ... and cannot record one', e like '42501:%', e);
end $$;
reset role;
set role anon;
select lp.as_user('anon', null);
select lp.ok('P12 anon cannot read location phones', lp.try('select * from gbp_location_phones') like '42501:%');
reset role;
set role service_role;
select lp.as_user('service_role', null);
select lp.ok('P13 the post-drafter''s service role reads them', (select count(*) = 2 from gbp_location_phones where client_id = '00000000-0000-4000-e700-00000000000a'));
reset role;

-- ── 3. Rollback: the down script removes the table and its guard ────────────
\c - postgres
begin;
\ir ../../rollback/20261103170000_gbp_location_phones.down.sql
select lp.ok('P14 the down script drops the table and its guard',
  to_regclass('public.gbp_location_phones') is null and to_regprocedure('public.gbp_location_phones_guard()') is null);
rollback;
select lp.ok('P15 ... rolled back here', to_regclass('public.gbp_location_phones') is not null);

-- ── Cleanup ─────────────────────────────────────────────────────────────────
\c - supabase_admin
delete from clients where id in (:'ca', :'cb');
select lp.ok('P16 removing a client removes its location phones', not exists (select 1 from gbp_location_phones where client_id = :'ca'));
drop schema lp cascade;
