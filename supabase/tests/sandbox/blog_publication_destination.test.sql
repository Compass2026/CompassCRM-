-- Tests for 20261019214729 (one writer per website destination), run by
-- scripts/test-portal-sandbox.sh after blog_publication.test.sql on the cd
-- harness. The ticks are the real cron.job commands, run against the pg_net
-- stub; each request sent names the publication the publisher would claim.
-- Fictional releases are written directly (they never reach a real site) and
-- removed at the end, so later suites see no extra queue.
--
--   BPD1      a destination is the repository (any case, trailing / or .git)
--             and branch; without a repository, the site
--   BPD2-BPD3 two queued releases for one site: the tick sends only the
--             earliest; two for different sites: both are sent
--   BPD4-BPD5 while one release holds a lease, the tick sends nothing for its
--             destination and a direct claim leaves the other queued
--   BPD6-BPD7 reconciliation: no resume while the destination is written (the
--             attempt is not spent); one eligible release per destination
--   BPD8      an expired lease is still sent (to be turned uncertain), the
--             destination's queued release is not
--   BPD9-BPD10 once the destination is free the next queued release is sent
--             and its claim passes the destination step

\c - supabase_admin
\o /dev/null
-- Sorted publication ids the named cron job sends in one run.
create function cd.bp_tick(p_job text) returns uuid[] language plpgsql as $$
declare m bigint := (select coalesce(max(id), 0) from net.http_request_queue);
begin
  execute regexp_replace((select command from cron.job where jobname = p_job), ';\s*$', '');
  return array(select (body->>'publication_id')::uuid from net.http_request_queue where id > m order by 1);
end $$;
create function cd.bp_set(p uuid[]) returns uuid[] language sql immutable as $$ select array(select unnest(p) order by 1) $$;
create function cd.bp_snapshot(p_site text, p_repo text, p_branch text default 'main') returns jsonb language sql immutable as $$
  select jsonb_build_object('destination', jsonb_build_object('site_id', p_site, 'url', 'https://' || p_site || '.example.test',
    'repo_url', p_repo, 'branch', p_branch, 'controlled_by_compass', true))
$$;
grant execute on all functions in schema cd to anon, authenticated, service_role, authenticator, postgres;

-- Releases as the publication functions leave them (the guard is bypassed
-- for fixtures only). a1/a2/a3/a4 share one repository branch, b1/b2 another.
set session_replication_role = replica;
insert into blog_publications (id, client_id, draft_id, draft_version, release_hash, snapshot, released_by, released_at, scheduled_at,
                               status, last_error, evidence, reconciliation_attempts)
select cd.id('bpd-' || k), cd.id(c), cd.get('blog')::uuid, v, 'sha256:' || repeat('0', 64), s,
       (select id from team_members limit 1), now() - r * interval '1 minute', now() - r * interval '1 minute', st,
       case when st = 'uncertain' then 'Website commit or deployment is not confirmed. Reconcile before retrying.' end,
       case when st = 'uncertain' then '{"transport": {"error": "update ref failed (422): {\"message\":\"Update is not a fast forward\"}"}}'::jsonb end, 0
from (values
  ('a1', 'a', 901, 30, 'queued',    cd.bp_snapshot('logic', 'https://github.com/example/logic')),
  ('a2', 'a', 902, 20, 'queued',    cd.bp_snapshot('logic', 'https://github.com/Example/Logic.git')),
  ('b1', 'b', 903, 10, 'queued',    cd.bp_snapshot('other', 'https://github.com/example/other/')),
  ('a3', 'a', 904, 50, 'uncertain', cd.bp_snapshot('logic', 'https://github.com/example/logic')),
  ('a4', 'a', 905, 40, 'uncertain', cd.bp_snapshot('logic', 'https://github.com/example/logic')),
  ('b2', 'b', 906, 45, 'uncertain', cd.bp_snapshot('other', 'https://github.com/example/other'))
) f(k, c, v, r, st, s);
set session_replication_role = origin;
\o

\c - postgres
\o /dev/null
select cd.ok('BPD1 a destination is the repository and branch, else the site',
  blog_publication_destination(cd.bp_snapshot('x', 'https://github.com/Example/Logic.git/'))
    = blog_publication_destination(cd.bp_snapshot('y', 'https://github.com/example/logic'))
  and blog_publication_destination(cd.bp_snapshot('x', 'https://github.com/example/logic', 'preview'))
    <> blog_publication_destination(cd.bp_snapshot('x', 'https://github.com/example/logic'))
  and blog_publication_destination(cd.bp_snapshot('x', null)) = 'site:x');
-- Reconcile first, so the queued releases' destinations are still idle.
select cd.save('bpd-reconcile1', cd.bp_tick('blog-publisher-reconcile-tick')::text);
select cd.ok('BPD7 reconciliation sends one eligible release per destination, the earliest',
  cd.get('bpd-reconcile1')::uuid[] = cd.bp_set(array[cd.id('bpd-a3'), cd.id('bpd-b2')]), cd.get('bpd-reconcile1'));
select cd.save('bpd-tick1', cd.bp_tick('blog-publisher-tick')::text);
select cd.ok('BPD2 two queued releases for one site: one tick sends only the earliest',
  not (cd.get('bpd-tick1')::uuid[] @> array[cd.id('bpd-a2')]) and cd.get('bpd-tick1')::uuid[] @> array[cd.id('bpd-a1')],
  cd.get('bpd-tick1'));
select cd.ok('BPD3 queued releases for different sites are both sent in one tick',
  cd.get('bpd-tick1')::uuid[] = cd.bp_set(array[cd.id('bpd-a1'), cd.id('bpd-b1')]), cd.get('bpd-tick1'));
\o

-- The publisher leased a1 and b1 (as blog_publication_claim leaves them).
\c - supabase_admin
set session_replication_role = replica;
update blog_publications set status = 'publishing', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes'
 where id in (cd.id('bpd-a1'), cd.id('bpd-b1'));
set session_replication_role = origin;

\c - postgres
\o /dev/null
select cd.ok('BPD4 while a release is written, neither tick sends another for its destination',
  cardinality(cd.bp_tick('blog-publisher-tick')) = 0 and cardinality(cd.bp_tick('blog-publisher-reconcile-tick')) = 0);
\o

-- The publisher function's session: a claim or resume sent anyway (a
-- concurrent tick, a teammate's manual run) is deferred under the lock.
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r jsonb;
begin
  r := blog_publication_claim(cd.id('bpd-a2'));
  perform cd.ok('BPD5 a claim on a busy destination leaves the release queued',
    r->>'reason' = 'destination busy' and r->>'acquired' = 'false'
    and (select status = 'queued' and lease_token is null from blog_publications where id = cd.id('bpd-a2')), r::text);
  r := blog_publication_resume(cd.id('bpd-a3'));
  perform cd.ok('BPD6 a resume on a busy destination stays uncertain and keeps its attempt',
    r->>'reason' = 'destination busy' and r->>'acquired' = 'false'
    and (select status = 'uncertain' and reconciliation_attempts = 0 and lease_token is null
           from blog_publications where id = cd.id('bpd-a3')), r::text);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- a1's publisher died (lease expired); b1 was published.
\c - supabase_admin
set session_replication_role = replica;
update blog_publications set lease_expires_at = now() - interval '1 minute' where id = cd.id('bpd-a1');
update blog_publications set status = 'published', published_url = 'https://other.example.test/blog/x', published_at = now(),
       lease_token = null where id = cd.id('bpd-b1');
set session_replication_role = origin;

\c - postgres
\o /dev/null
select cd.save('bpd-tick3', cd.bp_tick('blog-publisher-tick')::text);
select cd.ok('BPD8 an expired lease is sent to be turned uncertain; its destination''s queue waits',
  cd.get('bpd-tick3')::uuid[] = array[cd.id('bpd-a1')], cd.get('bpd-tick3'));
\o

\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
select cd.save('bpd-a1-claim', blog_publication_claim(cd.id('bpd-a1'))::text);
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o /dev/null
select cd.save('bpd-tick4', cd.bp_tick('blog-publisher-tick')::text);
select cd.ok('BPD9 once the destination is free the next queued release is sent',
  cd.get('bpd-a1-claim')::jsonb->>'status' = 'uncertain' and cd.get('bpd-tick4')::uuid[] = array[cd.id('bpd-a2')],
  cd.get('bpd-a1-claim') || ' ' || cd.get('bpd-tick4'));
\o

\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r jsonb := blog_publication_claim(cd.id('bpd-a2'));
begin
  -- The fictional release does not match its draft, so the next step blocks it.
  perform cd.ok('BPD10 its claim passes the destination step to the existing checks',
    r->>'status' = 'blocked' and r ? 'problems', r::text);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - supabase_admin
set session_replication_role = replica;
delete from blog_publications where id in (select cd.id('bpd-' || k) from unnest(array['a1', 'a2', 'a3', 'a4', 'b1', 'b2']) k);
set session_replication_role = origin;
select status, count(*) from cd.results where name ~ '^BPD' group by status;
select n, status, name, detail from cd.results where name ~ '^BPD' and status <> 'pass' order by n;
do $$
begin
  if exists (select 1 from cd.results where name ~ '^BPD' and status = 'fail')
     or (select count(*) from cd.results where name ~ '^BPD') < 10 then
    raise exception 'blog_publication_destination: failures above';
  end if;
end $$;
