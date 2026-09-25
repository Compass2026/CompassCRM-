-- Tests for migration 0047 (AI Drafter write boundary + canonical loader),
-- run by scripts/test-portal-sandbox.sh after the 0045 / 0046 tests, on the
-- same replay. Own harness schema (dr).
--
-- Callers are real sessions, the way each reaches production:
--   worker     psql as postgres (the Supabase connector's login), with or
--              without SET ROLE service_role / authenticated
--   drafter    psql as authenticator, role service_role (the post-drafter
--              Edge Function through PostgREST)
--   person     psql as authenticator, role authenticated, team JWT
--   portal     psql as authenticator, role authenticated, portal JWT
-- 0047 tells the drafter apart from the worker by session_user, so the
-- drafter's writes only pass on an authenticator connection — the point.
-- Fictional data only.

\set team   '00000000-0000-4000-a000-000000000001'
\set pb     '00000000-0000-4000-a000-000000000012'
\set strngr '00000000-0000-4000-a000-000000000014'
\set cb     '00000000-0000-4000-b000-00000000000b'

\o /dev/null
-- ── Harness ─────────────────────────────────────────────────────────────────
create schema dr;
create table dr.results (n serial, status text, name text, detail text);
create table dr.ids (k text primary key, id uuid);
grant usage on schema dr to anon, authenticated, service_role;
grant insert, select on dr.results to anon, authenticated, service_role;
grant select, insert on dr.ids to anon, authenticated, service_role;
grant usage on sequence dr.results_n_seq to anon, authenticated, service_role;

create function dr.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into dr.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function dr.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function dr.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function dr.id(p_k text) returns uuid language sql stable as $$ select id from dr.ids where k = p_k $$;

-- A drafter_write request shaped like the post-drafter function's: a brief
-- for client B's approved "Panel upgrades" service, a commercial Business
-- Profile post with a LEARN_MORE button to the service page.
create function dr.req(p_intent text, p_claims uuid[], p_copy text,
                       p_allowed uuid[] default null, p_cta_url text default 'https://b.example.test/panel-upgrades',
                       p_lint_ok boolean default true, p_client uuid default '00000000-0000-4000-b000-00000000000b')
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'client_id', p_client, 'requested_via', 'worker', 'runtime', 'sandbox-model', 'attempt', 1,
    'brief_version', 'drafter-brief/1', 'brief_hash', 'sha256:' || repeat('ab', 32),
    'brief', jsonb_build_object(
      'client', jsonb_build_object('id', '00000000-0000-4000-b000-00000000000b'),
      'target', jsonb_build_object('channel', 'google_business', 'post_type', 'standard', 'search_intent', p_intent,
        'service', jsonb_build_object('id', '00000000-0000-4000-e000-00000000002b', 'name', 'Panel upgrades'),
        'keyword', jsonb_build_object('id', '00000000-0000-4000-d000-00000000000b', 'text', 'b electrician'),
        'cta', jsonb_build_object('type', 'LEARN_MORE', 'url', p_cta_url), 'offer', null),
      'allowed_facts', jsonb_build_object('claims',
        (select coalesce(jsonb_agg(jsonb_build_object('id', c)), '[]') from unnest(coalesce(p_allowed, p_claims)) c))),
    'lint', jsonb_build_object('ok', p_lint_ok, 'problems', '[]'::jsonb, 'warnings', '[]'::jsonb),
    'copy', p_copy, 'claim_ids', to_jsonb(p_claims), 'asset_ids', '[]'::jsonb)
$$;
grant execute on all functions in schema dr to anon, authenticated, service_role;

-- ── Fixtures (as postgres): client B's service with a page, claims ──────────
insert into services (id, client_id, name, status, page_url) values
  ('00000000-0000-4000-e000-00000000002b', :'cb', 'Panel upgrades', 'approved', 'https://b.example.test/panel-upgrades');
insert into claims (id, client_id, claim, status, source, confirmed_by, confirmed_on) values
  ('00000000-0000-4000-f000-00000000003b', :'cb', 'Licensed electricians', 'sourced', 'https://b.example.test/about', null, null),
  ('00000000-0000-4000-f000-00000000004b', :'cb', 'Fastest electrician in Columbia', 'unverified', null, null, null);

-- ── S. Static checks ────────────────────────────────────────────────────────
do $$
begin
  perform dr.ok('S1 anon cannot read drafter_runs', not has_table_privilege('anon', 'public.drafter_runs', 'select'));
  perform dr.ok('S2 authenticated cannot write drafter_runs',
    not has_table_privilege('authenticated', 'public.drafter_runs', 'insert')
    and not has_table_privilege('authenticated', 'public.drafter_runs', 'update')
    and not has_table_privilege('authenticated', 'public.drafter_runs', 'delete'));
  perform dr.ok('S3 drafter_write is callable by the service role only',
    has_function_privilege('service_role', 'public.drafter_write(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.drafter_write(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.drafter_write(jsonb)', 'execute'));
  perform dr.ok('S4 client_intelligence_input: team and service yes, anon no',
    has_function_privilege('authenticated', 'public.client_intelligence_input(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.client_intelligence_input(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.client_intelligence_input(uuid)', 'execute'));
  perform dr.ok('S5 internal drafter functions are not callable over the API',
    not exists (select 1 from pg_proc p where p.proname in
      ('drafter_caller_is_service', 'drafter_session_active', 'drafter_caller_is_superuser', 'drafter_copy_hash',
       'drafter_runs_guard', 'social_posts_drafter_guard', 'post_links_drafter_guard')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));
  perform dr.ok('S6 drafter_runs has RLS on', (select relrowsecurity from pg_class where oid = 'public.drafter_runs'::regclass));
  perform dr.ok('S7 no portal view reads drafter_runs',
    not exists (select 1 from pg_views where viewname like 'portal\_%' and definition ilike '%drafter%'));
  perform dr.ok('S8 the worker login is not a superuser', not (select rolsuper from pg_roles where rolname = 'postgres'));
end $$;

-- ── A. The worker's own SQL (session_user postgres) cannot create drafts ────
do $$
declare st text; n0 bigint := (select count(*) from social_posts); r0 bigint := (select count(*) from drafter_runs);
begin
  st := dr.try($q$insert into social_posts (client_id, platform, search_intent, service_id, copy, cta_type, cta_url)
                values ('00000000-0000-4000-b000-00000000000b', 'google_business', 'commercial',
                        '00000000-0000-4000-e000-00000000002b', 'Panel upgrades for older homes.', 'LEARN_MORE',
                        'https://b.example.test/panel-upgrades')$q$);
  perform dr.ok('A1 a direct worker insert into social_posts is refused', st like '42501:%post-drafter%', st);

  st := dr.try(format('select drafter_write(%L::jsonb)',
    dr.req('commercial', array['00000000-0000-4000-f000-00000000000b']::uuid[], 'Panel upgrades for older homes. Veteran owned')));
  perform dr.ok('A2 the worker cannot call drafter_write', st like '42501:%', st);

  perform set_config('compass.drafter_write', 'on', false);
  st := dr.try($q$insert into social_posts (client_id, platform, search_intent, service_id, copy, cta_type, cta_url)
                values ('00000000-0000-4000-b000-00000000000b', 'google_business', 'commercial',
                        '00000000-0000-4000-e000-00000000002b', 'Panel upgrades.', 'LEARN_MORE',
                        'https://b.example.test/panel-upgrades')$q$);
  perform dr.ok('A3 setting the drafter flag by hand does not open the door', st like '42501:%', st);
  st := dr.try($q$insert into drafter_runs (client_id, requested_via, target, brief_version, brief_hash, runtime, copy_hash, status)
                values ('00000000-0000-4000-b000-00000000000b', 'worker', '{}', 'v', 'sha256:' || repeat('0', 64), 'x',
                        repeat('0', 64), 'writing')$q$);
  perform dr.ok('A4 the worker cannot open a drafter run (even with the flag)', st like '42501:%', st);
  st := dr.try($q$insert into drafter_runs (client_id, requested_via, target, brief_version, brief_hash, runtime, status)
                values ('00000000-0000-4000-b000-00000000000b', 'worker', '{}', 'v', 'sha256:' || repeat('0', 64), 'x', 'refused')$q$);
  perform dr.ok('A5 the worker cannot record a failed run either', st like '42501:%', st);
  perform set_config('compass.drafter_write', '', false);

  perform dr.ok('A6 nothing was written', (select count(*) from social_posts) = n0 and (select count(*) from drafter_runs) = r0);
end $$;

-- The worker switching roles: SET ROLE service_role keeps session_user postgres.
set role service_role;
select dr.as_user('service_role', null);
do $$
declare st text;
begin
  st := dr.try($q$insert into social_posts (client_id, platform, search_intent, service_id, copy, cta_type, cta_url)
                values ('00000000-0000-4000-b000-00000000000b', 'google_business', 'commercial',
                        '00000000-0000-4000-e000-00000000002b', 'Panel upgrades.', 'LEARN_MORE',
                        'https://b.example.test/panel-upgrades')$q$);
  perform dr.ok('A7 SET ROLE service_role does not let the worker insert a post', st like '42501:%', st);
  st := dr.try(format('select drafter_write(%L::jsonb)',
    dr.req('commercial', array['00000000-0000-4000-f000-00000000000b']::uuid[], 'Panel upgrades. Veteran owned')));
  perform dr.ok('A8 SET ROLE service_role does not let the worker call drafter_write', st like '42501:%post-drafter%', st);
  perform set_config('compass.drafter_write', 'on', false);
  st := dr.try($q$insert into drafter_runs (client_id, requested_via, target, brief_version, brief_hash, runtime, copy_hash, status)
                values ('00000000-0000-4000-b000-00000000000b', 'worker', '{}', 'v', 'sha256:' || repeat('0', 64), 'x',
                        repeat('0', 64), 'writing')$q$);
  perform dr.ok('A9 SET ROLE service_role + the flag still cannot open a run', st like '42501:%', st);
  perform set_config('compass.drafter_write', '', false);
end $$;
reset role;
-- ...nor SET ROLE authenticated with a team JWT (0045's human check needs authenticator).
set role authenticated;
select dr.as_user('authenticated', :'team');
do $$
declare st text;
begin
  st := dr.try($q$insert into social_posts (client_id, platform, search_intent, service_id, copy, cta_type, cta_url)
                values ('00000000-0000-4000-b000-00000000000b', 'google_business', 'commercial',
                        '00000000-0000-4000-e000-00000000002b', 'Panel upgrades.', 'LEARN_MORE',
                        'https://b.example.test/panel-upgrades')$q$);
  perform dr.ok('A10 SET ROLE authenticated + a team JWT does not make the worker a person', st like '42501:%', st);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── D. The post-drafter function (authenticator → service_role) ─────────────
\c - authenticator
set role service_role;
select dr.as_user('service_role', null);
do $$
declare
  st text; res jsonb; r0 bigint; n0 bigint; v_failed uuid;
  v_copy text := 'Thinking about panel upgrades for an older home? Veteran owned. Learn more about panel upgrades.';
begin
  -- The service role without drafter_write is no different from the worker.
  st := dr.try($q$insert into social_posts (client_id, platform, search_intent, service_id, copy, cta_type, cta_url)
                values ('00000000-0000-4000-b000-00000000000b', 'google_business', 'commercial',
                        '00000000-0000-4000-e000-00000000002b', 'Panel upgrades.', 'LEARN_MORE',
                        'https://b.example.test/panel-upgrades')$q$);
  perform dr.ok('D0 the service role cannot insert a post outside drafter_write', st like '42501:%', st);
  st := dr.try($q$insert into drafter_runs (client_id, requested_via, target, brief_version, brief_hash, runtime, copy_hash, status)
                values ('00000000-0000-4000-b000-00000000000b', 'worker', '{}', 'v', 'sha256:' || repeat('0', 64), 'x',
                        repeat('0', 64), 'writing')$q$);
  perform dr.ok('D0b ...nor open a writing run outside drafter_write', st like '42501:%', st);
  st := dr.try($q$insert into drafter_runs (client_id, requested_via, target, brief_version, brief_hash, runtime, copy_hash, status, post_id)
                values ('00000000-0000-4000-b000-00000000000b', 'worker', '{}', 'v', 'sha256:' || repeat('0', 64), 'x',
                        repeat('0', 64), 'submitted', null)$q$);
  perform dr.ok('D0c ...nor insert a run as submitted', st like '23514:%', st);

  -- A failed attempt is recorded by the function (lint_failed / stale_brief / refused).
  insert into drafter_runs (client_id, requested_via, target, brief_version, brief_hash, runtime, attempt, lint, status, detail)
  values ('00000000-0000-4000-b000-00000000000b', 'worker', '{"channel": "google_business"}', 'drafter-brief/1',
          'sha256:' || repeat('ab', 32), 'sandbox-model', 1, '{"ok": false}', 'lint_failed', 'unsupported_superlative')
  returning id into v_failed;
  insert into dr.ids values ('failed_run', v_failed);
  perform dr.ok('D0d the service role records a failed attempt', dr.id('failed_run') is not null);

  -- The governed write.
  res := drafter_write(dr.req('commercial', array['00000000-0000-4000-f000-00000000000b']::uuid[], v_copy));
  insert into dr.ids values ('run', (res->>'run_id')::uuid), ('post', (res->>'post_id')::uuid), ('task', (res->>'review_task_id')::uuid);
  perform dr.ok('D1 drafter_write returns the run, the post and the review task',
    dr.id('run') is not null and dr.id('post') is not null and dr.id('task') is not null, res::text);
  perform dr.ok('D2 the post is in review, worker-authored, linked to its run',
    (select review_status = 'in_review' and publish_status = 'not_scheduled' and author_kind = 'worker'
            and created_by is null and drafter_run_id = dr.id('run') and platform = 'google_business'
            and service_id = '00000000-0000-4000-e000-00000000002b' and keyword_id = '00000000-0000-4000-d000-00000000000b'
            and cta_type = 'LEARN_MORE' and cta_url = 'https://b.example.test/panel-upgrades' and copy = v_copy
     from social_posts where id = dr.id('post')));
  perform dr.ok('D3 its claim is linked',
    (select array_agg(claim_id) from post_claims where post_id = dr.id('post')) = array['00000000-0000-4000-f000-00000000000b']::uuid[]);
  perform dr.ok('D4 0045 opened one open, unassigned CLAUDE_APPROVAL post_review task',
    (select key = 'post_review' and owner = 'CLAUDE_APPROVAL' and status = 'open' and assignee_id is null
            and client_id = '00000000-0000-4000-b000-00000000000b'
     from tasks where id = dr.id('task'))
    and (select review_task_id from social_posts where id = dr.id('post')) = dr.id('task'));
  perform dr.ok('D5 the run is submitted with the copy''s sha256',
    (select status = 'submitted' and post_id = dr.id('post') and copy_hash = encode(sha256(convert_to(v_copy, 'UTF8')), 'hex')
            and claim_ids = array['00000000-0000-4000-f000-00000000000b']::uuid[] and runtime = 'sandbox-model'
     from drafter_runs where id = dr.id('run')));

  r0 := (select count(*) from drafter_runs); n0 := (select count(*) from social_posts);
  st := dr.try(format('select drafter_write(%L::jsonb)',
    dr.req('commercial', array['00000000-0000-4000-f000-00000000000b']::uuid[], 'Another panel upgrades post. Veteran owned')));
  perform dr.ok('D6 a second open drafted post for the same service and intent is refused', st like '23505:%', st);
  st := dr.try(format('select drafter_write(%L::jsonb)',
    dr.req('informational', array['00000000-0000-4000-f000-00000000004b']::uuid[], 'Fastest electrician in Columbia')));
  perform dr.ok('D7 an unverified claim (even one a forged brief allows) fails 0045 grounding', st like '23514:%unverified%', st);
  st := dr.try(format('select drafter_write(%L::jsonb)',
    dr.req('informational', array['00000000-0000-4000-f000-00000000003b']::uuid[], 'Licensed electricians',
           array['00000000-0000-4000-f000-00000000000b']::uuid[])));
  perform dr.ok('D8 a claim the brief did not allow is refused', st like '23514:%not in the brief%', st);
  st := dr.try(format('select drafter_write(%L::jsonb)',
    dr.req('informational', array['00000000-0000-4000-f000-00000000003b']::uuid[], 'Licensed electricians', null, 'https://b.example.test/panel-upgrades', false)));
  perform dr.ok('D9 a draft that did not pass the linter is refused', st like '23514:%linter%', st);
  st := dr.try(format('select drafter_write(%L::jsonb)',
    dr.req('informational', array['00000000-0000-4000-f000-00000000003b']::uuid[], 'Licensed electricians', null, 'https://b.example.test/')));
  perform dr.ok('D10 a button that does not go to the service page is refused', st like '23514:%service page%', st);
  st := dr.try(format('select drafter_write(%L::jsonb)',
    dr.req('informational', array['00000000-0000-4000-f000-00000000000a']::uuid[], 'Family owned since 1998')));
  perform dr.ok('D11 another client''s claim cannot be linked', st is not null, st);
  st := dr.try(format('select drafter_write(%L::jsonb)',
    dr.req('informational', array['00000000-0000-4000-f000-00000000003b']::uuid[], 'Licensed electricians',
           null, 'https://b.example.test/panel-upgrades', true, '00000000-0000-4000-b000-00000000000a')));
  perform dr.ok('D12 a brief for another client is refused', st like '23514:%another client%', st);
  perform dr.ok('D13 every refusal rolled back completely (no run, no post)',
    (select count(*) from drafter_runs) = r0 and (select count(*) from social_posts) = n0);

  st := dr.try(format($q$update drafter_runs set detail = 'edited' where id = %L$q$, dr.id('run')));
  perform dr.ok('D14 a run is immutable once written', st like '23514:%immutable%', st);
  st := dr.try(format($q$update drafter_runs set status = 'submitted', post_id = %L where id = %L$q$, dr.id('post'), dr.id('failed_run')));
  perform dr.ok('D15 a failed run cannot be turned into a submitted one', st like '23514:%', st);
  st := dr.try(format($q$delete from drafter_runs where id = %L$q$, dr.id('run')));
  perform dr.ok('D16 runs are not deleted', st like '42501:%', st);
  st := dr.try(format($q$update social_posts set drafter_run_id = null where id = %L$q$, dr.id('post')));
  perform dr.ok('D17 provenance is fixed (drafter_run_id cannot be cleared)', st like '23514:%fixed%', st);
end $$;
reset role;

-- ── E. Worker SQL against a drafted post ────────────────────────────────────
\c - postgres
do $$
declare st text; v uuid;
begin
  -- Withdrawing is 0045's "anyone" step; editing a drafted post's content is not.
  update social_posts set review_status = 'draft' where id = dr.id('post');
  perform dr.ok('E1 the drafted post was withdrawn to draft (0045 allows anyone)',
    (select review_status from social_posts where id = dr.id('post')) = 'draft');
  st := dr.try(format($q$update social_posts set copy = 'Best electrician in Missouri.' where id = %L$q$, dr.id('post')));
  perform dr.ok('E2 worker SQL cannot edit a drafted post''s copy', st like '42501:%', st);
  st := dr.try(format($q$update social_posts set cta_url = 'https://evil.example.test/' where id = %L$q$, dr.id('post')));
  perform dr.ok('E3 ...nor its button', st like '42501:%', st);
  st := dr.try(format($q$insert into post_claims (post_id, claim_id) values (%L, '00000000-0000-4000-f000-00000000004b')$q$, dr.id('post')));
  perform dr.ok('E4 worker SQL cannot link a claim to a drafted post', st like '42501:%', st);
  st := dr.try(format($q$delete from post_claims where post_id = %L$q$, dr.id('post')));
  perform dr.ok('E5 ...nor unlink one', st like '42501:%', st);
  st := dr.try(format($q$update social_posts set drafter_run_id = %L where id = %L$q$, dr.id('failed_run'), dr.id('post')));
  perform dr.ok('E6 worker SQL cannot change provenance', st like '23514:%fixed%', st);
  st := dr.try(format($q$update drafter_runs set brief_hash = 'sha256:' || repeat('cd', 32) where id = %L$q$, dr.id('run')));
  perform dr.ok('E7 worker SQL cannot rewrite a run', st like '42501:%', st);
  st := dr.try(format($q$delete from drafter_runs where id = %L$q$, dr.id('run')));
  perform dr.ok('E8 worker SQL cannot delete a run', st like '42501:%', st);

  -- A non-drafter post: the worker cannot adopt it into a run either.
  select id into v from social_posts where drafter_run_id is null and client_id = '00000000-0000-4000-b000-00000000000b' limit 1;
  if v is null then
    select id into v from social_posts where drafter_run_id is null limit 1;
  end if;
  st := dr.try(format($q$update social_posts set drafter_run_id = %L where id = %L$q$, dr.id('run'), v));
  perform dr.ok('E9 worker SQL cannot stamp drafter provenance on an existing post', st is not null, st);

  -- Re-submitting unchanged content is still just 0045's draft → in_review.
  update social_posts set review_status = 'in_review' where id = dr.id('post');
  perform dr.ok('E10 the unchanged drafted post can be re-submitted',
    (select review_status from social_posts where id = dr.id('post')) = 'in_review');
end $$;
set role service_role;
do $$
declare st text;
begin
  perform set_config('compass.drafter_write', 'on', true);
  st := dr.try(format($q$update social_posts set review_status = 'draft' where id = %L$q$, dr.id('post')));
  st := dr.try(format($q$update social_posts set copy = 'Best electrician in Missouri.' where id = %L$q$, dr.id('post')));
  perform dr.ok('E11 SET ROLE service_role + the flag still cannot edit a drafted post', st like '42501:%', st);
end $$;
reset role;

-- ── H. A person (authenticator → authenticated, team JWT) ───────────────────
\c - authenticator
set role authenticated;
select dr.as_user('authenticated', :'team');
do $$
declare st text; v uuid; j jsonb;
begin
  perform dr.ok('H1 the team reads drafter runs', (select count(*) from drafter_runs) >= 2);
  st := dr.try($q$insert into drafter_runs (client_id, requested_via, target, brief_version, brief_hash, runtime, status)
                values ('00000000-0000-4000-b000-00000000000b', 'team', '{}', 'v', 'sha256:' || repeat('0', 64), 'x', 'refused')$q$);
  perform dr.ok('H2 a person cannot write drafter runs', st like '42501:%', st);
  st := dr.try(format('select drafter_write(%L::jsonb)',
    dr.req('informational', array['00000000-0000-4000-f000-00000000003b']::uuid[], 'Licensed electricians')));
  perform dr.ok('H3 a person cannot call drafter_write', st like '42501:%', st);
  st := dr.try(format($q$insert into social_posts (client_id, platform, search_intent, service_id, copy, cta_type, cta_url, drafter_run_id)
                values ('00000000-0000-4000-b000-00000000000b', 'google_business', 'informational',
                        '00000000-0000-4000-e000-00000000002b', 'Licensed electricians', 'LEARN_MORE',
                        'https://b.example.test/panel-upgrades', %L)$q$, dr.id('run')));
  perform dr.ok('H4 a person cannot forge drafter_run_id on a new post', st like '42501:%drafter_run_id%', st);

  insert into social_posts (client_id, platform, search_intent, service_id, copy, cta_type, cta_url)
  values ('00000000-0000-4000-b000-00000000000b', 'google_business', 'informational',
          '00000000-0000-4000-e000-00000000002b', 'Licensed electricians. Learn about panel upgrades.', 'LEARN_MORE',
          'https://b.example.test/panel-upgrades')
  returning id into v;
  insert into dr.ids values ('human_post', v);
  insert into post_claims (post_id, claim_id) values (v, '00000000-0000-4000-f000-00000000003b');
  update social_posts set copy = 'Licensed electricians. Read about panel upgrades.' where id = v;
  update social_posts set review_status = 'in_review' where id = v;
  perform dr.ok('H5 human-created posts work as before (author human, no provenance, submitted)',
    (select author_kind = 'human' and created_by is not null and drafter_run_id is null and review_status = 'in_review'
     from social_posts where id = v));
  st := dr.try(format($q$update social_posts set drafter_run_id = %L where id = %L$q$, dr.id('run'), v));
  perform dr.ok('H6 a person cannot stamp provenance on an existing post', st like '23514:%fixed%', st);

  -- A person may edit a drafted post (the app), after withdrawing it.
  update social_posts set review_status = 'draft' where id = dr.id('post');
  update social_posts set copy = 'Thinking about panel upgrades? Veteran owned. Learn more.' where id = dr.id('post');
  delete from post_claims where post_id = dr.id('post');
  insert into post_claims (post_id, claim_id) values (dr.id('post'), '00000000-0000-4000-f000-00000000000b');
  perform dr.ok('H7 a person can edit a drafted post''s copy and claims',
    (select copy like 'Thinking about panel upgrades?%' and drafter_run_id = dr.id('run') from social_posts where id = dr.id('post')));
  perform dr.ok('H8 the run still records what the drafter wrote (copy hash no longer matches)',
    (select copy_hash <> encode(sha256(convert_to(p.copy, 'UTF8')), 'hex')
     from drafter_runs r join social_posts p on p.id = r.post_id where r.id = dr.id('run')));
  st := dr.try(format($q$update social_posts set review_status = 'approved' where id = %L$q$, dr.id('post')));
  perform dr.ok('H9 approval still needs the post to be in review (0045 unchanged)', st is not null, st);

  j := client_intelligence_input('00000000-0000-4000-b000-00000000000b');
  perform dr.ok('H10 the team reads Client Intelligence through the loader',
    j->'client'->>'name' = 'Sandbox Client B'
    and jsonb_array_length(j->'claims') >= 3
    and exists (select 1 from jsonb_array_elements(j->'services') s where s->>'page_url' = 'https://b.example.test/panel-upgrades')
    and j ? 'asOf' and j ? 'board' and j ? 'offers' and j ? 'pageGroups' and j ? 'assets' and j ? 'locations' and j ? 'keywords', j::text);
  perform dr.ok('H11 the loader is deterministic', client_intelligence_input('00000000-0000-4000-b000-00000000000b') = j);
end $$;

-- Rejecting and deleting a drafted post keeps its run (post_id cleared).
do $$
begin
  update social_posts set review_status = 'in_review' where id = dr.id('post');
  update social_posts set review_status = 'rejected', review_note = 'Sandbox: not this month.' where id = dr.id('post');
  delete from social_posts where id = dr.id('post');
  perform dr.ok('H12 deleting a rejected drafted post keeps its run as the audit record',
    (select status = 'submitted' and post_id is null from drafter_runs where id = dr.id('run')));
end $$;
reset role;

-- ── P. Anon, a stranger and a portal contact ────────────────────────────────
set role anon;
select dr.as_user('anon', null);
do $$
begin
  perform dr.ok('P1 anon cannot read drafter runs', dr.try('select 1 from drafter_runs') like '42501:%');
  perform dr.ok('P2 anon cannot call the loader',
    dr.try($q$select client_intelligence_input('00000000-0000-4000-b000-00000000000b')$q$) like '42501:%');
end $$;
reset role;
set role authenticated;
select dr.as_user('authenticated', :'strngr');
do $$
declare j jsonb := client_intelligence_input('00000000-0000-4000-b000-00000000000b');
begin
  perform dr.ok('P3 a signed-in stranger sees no drafter runs', (select count(*) from drafter_runs) = 0);
  perform dr.ok('P4 ...and an empty Client Intelligence', j->'client' = 'null'::jsonb and j->'claims' = '[]'::jsonb
    and j->'services' = '[]'::jsonb, j::text);
end $$;
select dr.as_user('authenticated', :'pb');
do $$
declare j jsonb := client_intelligence_input('00000000-0000-4000-b000-00000000000b');
begin
  perform dr.ok('P5 a portal contact sees no drafter runs, even their own client''s', (select count(*) from drafter_runs) = 0);
  perform dr.ok('P6 ...and no Client Intelligence (base tables stay team-only)',
    j->'client' = 'null'::jsonb and j->'claims' = '[]'::jsonb, j::text);
  perform dr.ok('P7 ...and no posts', (select count(*) from social_posts) = 0);
end $$;
reset role;

\c - postgres
\o
-- ── Report ──────────────────────────────────────────────────────────────────
\pset footer off
select status, count(*) from dr.results group by status order by status;
select n, status, name, detail from dr.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from dr.results where status = 'fail';
  if f > 0 then raise exception '% drafter check(s) failed', f; end if;
end $$;
