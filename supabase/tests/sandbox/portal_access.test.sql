-- Access tests for migrations 0036 (team-only), 0037 (portal) and 0038
-- (portal_seen), run by scripts/test-portal-sandbox.sh against a replay of
-- every migration. Each check records pass / fail / gap in t.results; the
-- run fails if anything failed. "gap" is a known weakness that is reported,
-- not hidden — see docs/portal-reconciliation.md.
--
-- Callers are simulated the way PostgREST does it: SET ROLE to anon or
-- authenticated and put the JWT claims in request.jwt.claims.

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set pb     '00000000-0000-4000-a000-000000000012'
\set former '00000000-0000-4000-a000-000000000013'
\set strngr '00000000-0000-4000-a000-000000000014'
\set ca     '00000000-0000-4000-b000-00000000000a'
\set cb     '00000000-0000-4000-b000-00000000000b'

-- ── Harness ─────────────────────────────────────────────────────────────────
create schema t;
create table t.results (n serial, status text, name text, detail text);
grant usage on schema t to anon, authenticated;
grant insert, select on t.results to anon, authenticated;
grant usage on sequence t.results_n_seq to anon, authenticated;

create function t.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into t.results (status, name, detail)
  values (case when p_pass then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function t.gap(p_name text, p_detail text) returns void
language sql as $$ insert into t.results (status, name, detail) values ('gap', p_name, p_detail) $$;

-- Runs a statement as the current role; returns null if it succeeded, else
-- the SQLSTATE it failed with.
create function t.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- Rows a statement affected, or -1 if it failed.
create function t.affected(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
exception when others then
  return -1;
end $$;

-- count(*) of a query, or -1 if it was refused.
create function t.cnt(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from (%s) q', p_sql) into n;
  return n;
exception when others then
  return -1;
end $$;

-- Every portal view name.
create function t.portal_views() returns setof text language sql stable as $$
  select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'portal\_%' order by 1
$$;
-- Every public base table.
create function t.public_tables() returns setof text language sql stable as $$
  select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1
$$;
grant execute on all functions in schema t to anon, authenticated;

-- Sign in as someone (or as nobody, for anon).
create function t.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
grant execute on function t.as_user(text, text) to anon, authenticated;

-- ── A. Static shape (as postgres) ──────────────────────────────────────────
do $$
declare v record; n int;
begin
  select count(*) into n from t.portal_views();
  perform t.ok('A0 eight portal views exist', n = 8, n || ' views');

  for v in
    select c.relname, pg_get_userbyid(c.relowner) owner, r.rolsuper, r.rolbypassrls,
           coalesce(c.reloptions::text, '{}') opts, pg_get_viewdef(c.oid) def
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace join pg_roles r on r.oid = c.relowner
    where ns.nspname = 'public' and c.relkind = 'v' and c.relname like 'portal\_%'
  loop
    perform t.ok('A1 ' || v.relname || ' is a security-definer view owned by a non-superuser BYPASSRLS role (as in production)',
      v.owner = 'postgres' and not v.rolsuper and v.rolbypassrls and v.opts like '%security_invoker=false%',
      v.owner || ' ' || v.opts);
    perform t.ok('A2 ' || v.relname || ' filters by portal_client_id()', v.def like '%portal_client_id()%');
    perform t.ok('A3 ' || v.relname || ' grants: authenticated SELECT only, nothing for anon / PUBLIC',
      has_table_privilege('authenticated', 'public.' || v.relname, 'select')
      and not has_table_privilege('authenticated', 'public.' || v.relname, 'insert,update,delete,truncate,references,trigger')
      and not has_table_privilege('anon', 'public.' || v.relname, 'select,insert,update,delete,truncate,references,trigger'));
  end loop;

  select count(*) into n from pg_policies
  where schemaname in ('public', 'storage') and (qual = 'true' or with_check = 'true');
  perform t.ok('A4 no policy is open to every signed-in user', n = 0, n || ' open');

  select count(*) into n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  perform t.ok('A5 RLS enabled on every public table', n = 0, n || ' without RLS');

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute');
  perform t.ok('A6 anon can execute no security-definer function', n = 0, n || ' executable');

  perform t.ok('A7 authenticated can execute exactly is_team, portal_client_id, portal_seen, secret_present among security-definer functions',
    (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
       and has_function_privilege('authenticated', p.oid, 'execute'))
    = array['is_team', 'portal_client_id', 'portal_seen', 'secret_present']);

  -- portal_client and portal_site are simple views, so Postgres would let a
  -- write through them (as the owner, bypassing RLS) if a grant allowed it.
  -- The grants in A3 are what stop that; this records why they matter.
  perform t.ok('A8 portal_client / portal_site are auto-updatable, so the SELECT-only grant is load-bearing',
    pg_relation_is_updatable('public.portal_client', false) > 0 and pg_relation_is_updatable('public.portal_site', false) > 0);
end $$;

-- ── B. Anonymous caller ─────────────────────────────────────────────────────
set role anon;
select t.as_user('anon', null) \g /dev/null
do $$
declare r text; n bigint;
begin
  for r in select * from t.public_tables() loop
    n := t.cnt(format('select 1 from public.%I', r));
    perform t.ok('B1 anon sees no rows in ' || r, n <= 0, n::text);
  end loop;
  for r in select * from t.portal_views() loop
    perform t.ok('B2 anon is refused ' || r, t.try(format('select * from public.%I', r)) = '42501');
  end loop;
  perform t.ok('B3 anon cannot insert a client',
    t.try($q$insert into clients (name) values ('anon client')$q$) is not null);
  perform t.ok('B4 anon cannot call is_team()', t.try('select is_team()') = '42501');
  perform t.ok('B4 anon cannot call portal_client_id()', t.try('select portal_client_id()') = '42501');
  perform t.ok('B4 anon cannot call portal_seen()', t.try('select portal_seen()') = '42501');
  perform t.ok('B4 anon cannot call secret_present()', t.try($q$select secret_present('SANDBOX_SECRET')$q$) = '42501');
  n := t.cnt('select 1 from storage.objects');
  perform t.ok('B5 anon sees no storage objects', n <= 0, n::text);
end $$;
reset role;

-- ── C. Team member ──────────────────────────────────────────────────────────
set role authenticated;
select t.as_user('authenticated', :'team') \g /dev/null
do $$
declare r text; n bigint;
begin
  perform t.ok('C1 is_team() is true for the team', is_team());
  perform t.ok('C2 team sees both clients', t.cnt('select 1 from clients') = 2);
  perform t.ok('C3 team can update a client',
    t.affected($q$update clients set notes = notes where id = '00000000-0000-4000-b000-00000000000a'$q$) = 1);
  perform t.ok('C4 team can insert a task',
    t.affected($q$insert into tasks (client_id, title) values ('00000000-0000-4000-b000-00000000000a', 'sandbox task')$q$) = 1);
  perform t.ok('C5 team reads storage objects in both buckets', t.cnt('select 1 from storage.objects') = 2);
  perform t.ok('C6 team can write to the documents bucket',
    t.affected($q$insert into storage.objects (bucket_id, name) values ('documents', 'sandbox/new.pdf')$q$) = 1);
  perform t.ok('C7 secret_present() answers for the team', secret_present('SANDBOX_SECRET'));
  perform t.ok('C8 team reads every portal_users row', t.cnt('select 1 from portal_users') = 3);
  for r in select * from t.portal_views() loop
    n := t.cnt(format('select 1 from public.%I', r));
    perform t.ok('C9 team gets nothing from ' || r || ' (no portal scope)', n = 0, n::text);
  end loop;
end $$;
reset role;

-- ── D. Portal user, client A ────────────────────────────────────────────────
set role authenticated;
select t.as_user('authenticated', :'pa') \g /dev/null
do $$
declare r text; n bigint; other bigint; seen_before timestamptz;
  ca constant uuid := '00000000-0000-4000-b000-00000000000a';
  cb constant uuid := '00000000-0000-4000-b000-00000000000b';
begin
  perform t.ok('D1 is_team() is false for a portal user', not is_team());
  perform t.ok('D1 portal_client_id() is client A', portal_client_id() = ca);

  for r in select * from t.public_tables() where public_tables <> 'portal_users' loop
    n := t.cnt(format('select 1 from public.%I', r));
    perform t.ok('D2 portal user sees no rows in base table ' || r, n <= 0, n::text);
  end loop;
  perform t.ok('D2 portal user sees only their own portal_users row',
    t.cnt('select 1 from portal_users') = 1
    and t.cnt($q$select 1 from portal_users where email = 'portal-a@example.test'$q$) = 1);

  -- Isolation: every view returns rows, all for client A, none for B.
  perform t.ok('D3 portal_client is exactly client A',
    t.cnt($q$select 1 from portal_client where id = '00000000-0000-4000-b000-00000000000a'$q$) = 1
    and t.cnt('select 1 from portal_client') = 1);
  for r in select * from t.portal_views() where portal_views <> 'portal_client' loop
    n := t.cnt(format('select 1 from public.%I', r));
    execute format('select count(*) from public.%I where client_id <> $1', r) into other using ca;
    perform t.ok('D3 ' || r || ' returns client A rows only', n > 0 and other = 0, n || ' rows, ' || other || ' foreign');
    execute format('select count(*) from public.%I where client_id = $1', r) into other using cb;
    perform t.ok('D4 asking ' || r || ' for client B returns nothing', other = 0);
  end loop;

  -- Content filters inside the views.
  perform t.ok('D5 portal_rankings: tracked keywords, DataForSEO only, latest and previous',
    t.cnt($q$select 1 from portal_rankings where keyword = 'a plumber' and position = 5 and previous_position = 9$q$) = 1
    and t.cnt($q$select 1 from portal_rankings where keyword = 'a untracked'$q$) = 0);
  perform t.ok('D6 portal_work_log: approved changes and published posts only',
    t.cnt('select 1 from portal_work_log') = 2
    and t.cnt($q$select 1 from portal_work_log where label = 'A draft post'$q$) = 0);
  perform t.ok('D7 portal_reports: only cycles with a report',
    t.cnt('select 1 from portal_reports') = 1);
  perform t.ok('D8 portal_client carries no internal columns',
    t.try('select notes from portal_client') is not null
    and t.try('select gbp_spec from portal_client') is not null
    and t.try('select drive_root_url from portal_client') is not null);
  perform t.ok('D8 portal_work_log carries no reasoning / evidence',
    t.try('select reasoning from portal_work_log') is not null
    and t.try('select evidence from portal_work_log') is not null);

  -- Read-only: every write through a view is refused. A simple view
  -- (portal_client, portal_site) is auto-updatable, so only the missing
  -- privilege stops it (42501); the others are joins / aggregates / unions,
  -- which Postgres refuses as not updatable (55000) before privileges are
  -- even consulted. Either way nothing is written; the code is recorded.
  for r in select * from t.portal_views() loop
    declare ins text; upd text; del text; simple boolean;
    begin
      simple := pg_relation_is_updatable(('public.' || r)::regclass, false) > 0;
      ins := t.try(format('insert into public.%I default values', r));
      upd := t.try(format('update public.%I set client_id = client_id', r));
      if r = 'portal_client' then upd := t.try('update public.portal_client set name = name'); end if;
      del := t.try(format('delete from public.%I', r));
      perform t.ok('D9 portal user cannot INSERT into ' || r,
        ins = '42501' or (not simple and ins = '55000'), coalesce(ins, 'succeeded'));
      perform t.ok('D9 portal user cannot UPDATE ' || r,
        upd = '42501' or (not simple and upd = '55000'), coalesce(upd, 'succeeded'));
      perform t.ok('D9 portal user cannot DELETE from ' || r,
        del = '42501' or (not simple and del = '55000'), coalesce(del, 'succeeded'));
    end;
  end loop;
  perform t.ok('D10 portal user cannot rename their client through the base table',
    t.affected($q$update clients set name = 'pwned' where id = '00000000-0000-4000-b000-00000000000a'$q$) <= 0);
  perform t.ok('D10 portal user cannot move themselves to client B',
    t.affected($q$update portal_users set client_id = '00000000-0000-4000-b000-00000000000b'$q$) <= 0);
  perform t.ok('D10 portal user cannot reactivate or create portal rows',
    t.affected($q$insert into portal_users (client_id, email) values ('00000000-0000-4000-b000-00000000000b', 'x@example.test')$q$) <= 0);
  perform t.ok('D10 portal user cannot write change_log',
    t.affected($q$insert into change_log (client_id, change_type, object_type, status) values ('00000000-0000-4000-b000-00000000000a', 'page', 'site', 'approved')$q$) <= 0);
  perform t.ok('D10 portal user cannot delete a client',
    t.affected('delete from clients') <= 0);

  -- Functions: only the four callable ones; a security-invoker function
  -- that anyone may call still runs under the caller's RLS.
  perform t.ok('D11 portal user cannot call any other security-definer function',
    not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
        and p.proname not in ('is_team', 'portal_client_id', 'portal_seen', 'secret_present')
        and has_function_privilege(p.oid, 'execute')));
  perform t.ok('D12 secret_present() answers false for a portal user', not secret_present('SANDBOX_SECRET'));
  perform t.ok('D13 get_brand_profile() (security invoker) reveals nothing to a portal user',
    coalesce(get_brand_profile(cb)::text, '') not like '%Sandbox Client B%'
    and coalesce(get_brand_profile(ca)::text, '') not like '%internal note%');
  n := t.cnt('select 1 from storage.objects');
  perform t.ok('D14 portal user sees no storage objects', n <= 0, n::text);
  perform t.ok('D14 portal user cannot upload to storage',
    t.affected($q$insert into storage.objects (bucket_id, name) values ('documents', 'x')$q$) <= 0);

  -- portal_seen(): the one write, own row only.
  perform portal_seen();
end $$;
reset role;
do $$
begin
  perform t.ok('D15 portal_seen() stamped the caller',
    (select last_seen_at from portal_users where email = 'portal-a@example.test') is not null);
  perform t.ok('D15 portal_seen() touched no other row',
    (select count(*) from portal_users where email <> 'portal-a@example.test' and last_seen_at is not null) = 0);
end $$;

-- ── E. Portal user, client B (symmetry) ────────────────────────────────────
set role authenticated;
select t.as_user('authenticated', :'pb') \g /dev/null
do $$
declare r text; n bigint; other bigint;
begin
  perform t.ok('E1 portal_client_id() is client B', portal_client_id() = '00000000-0000-4000-b000-00000000000b');
  for r in select * from t.portal_views() where portal_views <> 'portal_client' loop
    n := t.cnt(format('select 1 from public.%I', r));
    execute format('select count(*) from public.%I where client_id <> $1', r) into other
      using '00000000-0000-4000-b000-00000000000b'::uuid;
    perform t.ok('E2 ' || r || ' returns client B rows only', n > 0 and other = 0, n || ' rows, ' || other || ' foreign');
  end loop;
  perform t.ok('E3 portal_client is exactly client B',
    t.cnt($q$select 1 from portal_client where name = 'Sandbox Client B'$q$) = 1 and t.cnt('select 1 from portal_client') = 1);
end $$;
reset role;

-- ── F. Signed in but not entitled ───────────────────────────────────────────
set role authenticated;
select t.as_user('authenticated', :'former') \g /dev/null
do $$
declare r text; n bigint;
begin
  perform t.ok('F1 an inactive portal user has no scope', portal_client_id() is null);
  for r in select * from t.portal_views() loop
    n := t.cnt(format('select 1 from public.%I', r));
    perform t.ok('F2 inactive portal user gets nothing from ' || r, n = 0, n::text);
  end loop;
end $$;
select t.as_user('authenticated', :'strngr') \g /dev/null
do $$
declare r text; n bigint;
begin
  perform t.ok('F3 a stranger is neither team nor portal', not is_team() and portal_client_id() is null);
  for r in select * from t.portal_views() loop
    n := t.cnt(format('select 1 from public.%I', r));
    perform t.ok('F4 stranger gets nothing from ' || r, n = 0, n::text);
  end loop;
  for r in select * from t.public_tables() loop
    n := t.cnt(format('select 1 from public.%I', r));
    perform t.ok('F5 stranger sees no rows in ' || r, n <= 0, n::text);
  end loop;
end $$;
reset role;

-- ── G. The security-definer views, directly ────────────────────────────────
-- The advisor flags all eight views (lint 0010). These checks show what that
-- means here: the views do bypass RLS, the WHERE clause is the only thing
-- scoping them, and it follows the caller, not the session or the owner.
set role authenticated;
select t.as_user('authenticated', :'pa') \g /dev/null
do $$
begin
  perform t.ok('G1 the view bypasses RLS: rank_snapshots is hidden from the portal user, portal_rankings is not',
    t.cnt('select 1 from rank_snapshots') = 0 and t.cnt('select 1 from portal_rankings') > 0);
  perform t.ok('G1 same for gsc_snapshots vs portal_search_queries',
    t.cnt('select 1 from gsc_snapshots') = 0 and t.cnt('select 1 from portal_search_queries') > 0);
end $$;
-- Same session, different JWT: the scope follows auth.uid() per statement.
select t.as_user('authenticated', :'pb') \g /dev/null
do $$
begin
  perform t.ok('G2 switching the JWT in one session switches the scope (nothing cached)',
    (select id from portal_client) = '00000000-0000-4000-b000-00000000000b'
    and t.cnt($q$select 1 from portal_search_queries where client_id = '00000000-0000-4000-b000-00000000000a'$q$) = 0);
end $$;
reset role;

-- Revocation takes effect on the next statement.
update portal_users set is_active = false where email = 'portal-a@example.test';
set role authenticated;
select t.as_user('authenticated', :'pa') \g /dev/null
do $$
declare r text; n bigint := 0; m bigint;
begin
  for r in select * from t.portal_views() loop
    m := t.cnt(format('select 1 from public.%I', r));
    n := n + greatest(m, 0);
  end loop;
  perform t.ok('G3 a revoked portal user immediately sees nothing in any view', n = 0, n || ' rows');
end $$;
reset role;
update portal_users set is_active = true where email = 'portal-a@example.test';

-- A team address can never become a portal user (is_team() would win and the
-- CRM would open to a client scope).
do $$
begin
  perform t.ok('G4 the trigger refuses a team address as a portal user',
    t.try($q$insert into portal_users (client_id, email) values ('00000000-0000-4000-b000-00000000000a', 'SANDBOX-TEAM@compassmarketing.ai')$q$) is not null);
end $$;

-- portal_client_id() is "limit 1" with no ORDER BY and portal_users has no
-- unique index on auth_user_id. The link trigger only fills a null
-- auth_user_id, so one sign-in can end up on two active rows only through a
-- direct write (team or service role). If it does, which client that
-- sign-in sees is undefined. Recorded as a gap, then undone.
do $$
declare dup_allowed boolean;
begin
  dup_allowed := t.try($q$insert into portal_users (client_id, email, auth_user_id)
    values ('00000000-0000-4000-b000-00000000000b', 'second-address@example.test', '00000000-0000-4000-a000-000000000011')$q$) is null;
  if dup_allowed then
    perform t.gap('G5 one auth user can be linked to two active portal_users rows',
      'no unique index on portal_users.auth_user_id; portal_client_id() would pick one arbitrarily. Only a team or service-role write can do this.');
    delete from portal_users where email = 'second-address@example.test';
  else
    perform t.ok('G5 one auth user cannot be linked to two portal rows', true);
  end if;
end $$;

-- ── Report ──────────────────────────────────────────────────────────────────
\pset footer off
select status, count(*) from t.results group by status order by status;
select n, status, name, detail from t.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from t.results where status = 'fail';
  if f > 0 then raise exception '% portal access check(s) failed', f; end if;
end $$;
