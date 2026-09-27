-- Tests for migration 0053 (Authority → AI Drafter hand-off), run by
-- scripts/test-portal-sandbox.sh after the 0052 suite, on a client of its own.
-- Own harness (dh). Fictional data only.
--
-- Callers, the way each reaches production:
--   person    authenticator + authenticated + team JWT (the app's server action)
--   drafter   authenticator + service_role (the post-drafter function)
--   engine    authenticator + service_role (the authority-run function)
--   worker    postgres (the Supabase connector's login)
--   portal / stranger / anon as in the other suites
--
-- The worker fire: the sandbox's net.http_post records the request and sends
-- nothing; ROUTINE_FIRE_URL / _TOKEN are in the sandbox vault (task suite).

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set strngr '00000000-0000-4000-a000-000000000014'

\c - postgres
\o /dev/null
create schema dh;
create table dh.results (n serial, status text, name text, detail text);
create table dh.ids (k text primary key, id uuid);
create table dh.saved (k text primary key, v jsonb);
grant usage on schema dh to anon, authenticated, service_role;
grant insert, select on dh.results to anon, authenticated, service_role;
grant select, insert, update on dh.ids, dh.saved to anon, authenticated, service_role;
grant usage on sequence dh.results_n_seq to anon, authenticated, service_role;

create function dh.ok(p_name text, p_pass boolean, p_detail text default null) returns void language sql as $$
  insert into dh.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail) $$;
create function dh.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function dh.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_sub is null then json_build_object('role', p_role)::text
    else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function dh.id(p_k text) returns uuid language sql stable as $$ select id from dh.ids where k = p_k $$;
create function dh.put(p_k text, p_id uuid) returns void language sql as $$
  insert into dh.ids values (p_k, p_id) on conflict (k) do update set id = excluded.id $$;
create function dh.save(p_k text, p_v jsonb) returns void language sql as $$
  insert into dh.saved values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function dh.saved(p_k text) returns jsonb language sql stable as $$ select v from dh.saved where k = p_k $$;

insert into dh.ids values
  ('c', '00000000-0000-4000-b000-00000000005a'),
  ('rr', '00000000-0000-4000-e000-00000000005a'),
  ('kt', '00000000-0000-4000-d000-00000000005a'), ('kc', '00000000-0000-4000-d000-00000000005b'),
  ('kx', '00000000-0000-4000-d000-00000000005c'),
  ('cl1', '00000000-0000-4000-f000-00000000005a'), ('cl2', '00000000-0000-4000-f000-00000000005b'),
  ('cl3', '00000000-0000-4000-f000-00000000005c'),
  ('g_rr', '00000000-0000-4000-9000-00000000005a');

create function dh.site() returns text language sql immutable as $$ select 'https://handoff.example.test' $$;
create function dh.page_url() returns text language sql immutable as $$ select 'https://handoff.example.test/services/roof-replacement' $$;
create function dh.page(p_path text) returns jsonb language sql immutable as $$
  select jsonb_build_object('url', dh.site() || p_path, 'status', 200, 'final_url', dh.site() || p_path, 'final_status', 200,
    'redirect_loop', false, 'in_sitemap', true, 'title', null, 'h1', null, 'h2', '[]'::jsonb, 'canonical', null, 'words', 300, 'text', 'x')
$$;
-- A Business Profile post opportunity the way the engine reports it.
create function dh.gbp(p_intent text, p_keyword text, p_section text default 'ready', p_action text default 'create',
                       p_eligible date default null, p_evidence uuid[] default null) returns jsonb language sql stable as $$
  select jsonb_build_object('id', 'gbp_post:roof-replacement:' || p_intent, 'key', format('gbp_post:%s:%s', dh.id('rr'), p_intent),
    'section', p_section, 'action', p_action, 'tier', 'B', 'content_type', 'gbp_post', 'topic', 'Roof Replacement',
    'service_id', dh.id('rr'), 'objective', 'fixture', 'order', jsonb_build_array(1), 'eligible_from', p_eligible,
    'gap', format('A %s Business Profile post.', p_intent),
    'target', jsonb_build_object('keyword_id', dh.id(p_keyword), 'keyword', p_keyword, 'intent', p_intent, 'location', null,
                                 'owner_path', '/services/roof-replacement', 'cta', 'LEARN_MORE'),
    'evidence_claim_ids', to_jsonb(coalesce(p_evidence, array[dh.id('cl2')])),
    'existing_coverage', '[]'::jsonb, 'blockers', '[]'::jsonb, 'gates', '[]'::jsonb,
    'reasons', jsonb_build_array(jsonb_build_object('tag', 'FACT', 'text', 'fixture')))
$$;
-- One analysis: p_tx the transactional post's state, the rest fixed.
create function dh.report(p_tx jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('client', jsonb_build_object('id', dh.id('c')), 'as_of', current_date, 'sources', '{}'::jsonb,
    'keywords', '[]'::jsonb,
    'opportunities', jsonb_build_array(p_tx,
      dh.gbp('commercial', 'kc', 'ready', 'create', current_date + 10),
      dh.gbp('informational', 'kx', 'blocked', 'blocked_data_prerequisite'),
      jsonb_build_object('id', 'page_improvement:rr', 'key', 'page_improvement:' || dh.id('rr'), 'section', 'fix_now', 'action', 'improve',
        'tier', 'A', 'content_type', 'page_improvement', 'topic', 'Roof Replacement', 'service_id', dh.id('rr'), 'objective', null,
        'order', jsonb_build_array(0), 'eligible_from', null, 'gap', 'fixture',
        'target', jsonb_build_object('keyword_id', null, 'keyword', null, 'intent', null, 'location', null, 'owner_path', '/services/roof-replacement', 'cta', null),
        'reasons', jsonb_build_array(jsonb_build_object('tag', 'FACT', 'text', 'fixture')))))
$$;
create function dh.run(p_tx jsonb) returns uuid language plpgsql as $$
declare r uuid;
begin
  r := authority_begin_run(dh.id('c'), 'refresh', 'worker');
  perform authority_record_run(r, jsonb_build_object('status', 'completed', 'engine_version', 'authority-v1.3', 'judged_at', now(),
    'as_of', current_date, 'input_hash', 'sha256:' || repeat('5a', 32), 'section_hashes', authority_fingerprint(dh.id('c')),
    'inventory', jsonb_build_object('fetched_at', now(), 'site', dh.site(), 'pages', jsonb_build_array(dh.page('/'), dh.page('/services/roof-replacement'))),
    'inventory_errors', 0, 'report', dh.report(p_tx)));
  return r;
end $$;
create function dh.o(p_intent text default 'transactional') returns public.authority_opportunities language sql stable security definer as $$
  select * from public.authority_opportunities where client_id = dh.id('c') and key = format('gbp_post:%s:%s', dh.id('rr'), p_intent) $$;
create function dh.oid(p_intent text default 'transactional') returns uuid language sql stable as $$ select (dh.o(p_intent)).id $$;
create function dh.effective(p_intent text default 'transactional') returns text language sql stable security definer as $$
  select effective_status from public.authority_opportunity_state where id = dh.oid(p_intent) $$;
create function dh.exp(p_intent text default 'transactional') returns jsonb language sql stable as $$
  select jsonb_build_object('run_id', (dh.o(p_intent)).last_seen_run_id, 'status', (dh.o(p_intent)).status,
    'suppressed', (dh.o(p_intent)).suppressed, 'dismissed_until', (dh.o(p_intent)).dismissed_until) $$;
create function dh.request(p_intent text default 'transactional') returns text language sql as $$
  select dh.try(format('select dh.save(''req'', authority_apply(%L, ''request_draft'', ''{}''::jsonb, %L::jsonb))', dh.oid(p_intent), dh.exp(p_intent))) $$;
-- Counts, read past RLS.
create function dh.n(p_sql text) returns bigint language plpgsql security definer as $$
declare n bigint; begin execute p_sql into n; return n; end $$;
create function dh.open_requests() returns bigint language sql stable security definer as $$
  select count(*) from public.tasks where client_id = dh.id('c') and key like 'authority\_draft:%' and status <> 'done' $$;
create function dh.requests() returns bigint language sql stable security definer as $$
  select count(*) from public.tasks where client_id = dh.id('c') and key like 'authority\_draft:%' $$;
create function dh.req_task() returns public.tasks language sql stable security definer as $$
  select * from public.tasks where client_id = dh.id('c') and key = 'authority_draft:' || dh.oid() order by created_at desc limit 1 $$;
create function dh.fires(p_task uuid) returns bigint language sql stable security definer as $$
  select count(*) from public.worker_fires where client_id = dh.id('c') and reason = 'Authority draft request ' || p_task $$;
create function dh.runs() returns bigint language sql stable security definer as $$
  select count(*) from public.drafter_runs where client_id = dh.id('c') $$;
create function dh.posts() returns bigint language sql stable security definer as $$
  select count(*) from public.social_posts where client_id = dh.id('c') $$;
create function dh.links() returns bigint language sql stable security definer as $$
  select count(*) from public.authority_opportunity_links where client_id = dh.id('c') $$;

-- A drafter_write request shaped like post-drafter's in Authority mode.
create function dh.req(p_copy text, p_extra jsonb default '{}', p_brief_authority jsonb default null, p_keyword text default 'kt',
                       p_claims uuid[] default null) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'client_id', dh.id('c'), 'requested_via', 'worker', 'runtime', 'sandbox-model', 'attempt', 1,
    'brief_version', 'drafter-v1', 'brief_hash', 'sha256:' || repeat('5b', 32),
    'authority_opportunity_id', dh.oid(),
    'brief', jsonb_build_object(
      'client', jsonb_build_object('id', dh.id('c')),
      'target', jsonb_build_object('channel', 'google_business', 'post_type', 'standard', 'search_intent', 'transactional',
        'service', jsonb_build_object('id', dh.id('rr'), 'name', 'Roof Replacement', 'page_url', dh.page_url()),
        'keyword', jsonb_build_object('id', dh.id(p_keyword), 'text', 'roof quote handoff'),
        'cta', jsonb_build_object('type', 'LEARN_MORE', 'url', dh.page_url()), 'offer', null),
      'allowed_facts', jsonb_build_object('claims', jsonb_build_array(jsonb_build_object('id', dh.id('cl1')), jsonb_build_object('id', dh.id('cl2')))),
      'authority', coalesce(p_brief_authority, jsonb_build_object('opportunity_id', dh.oid(), 'preferred_claim_ids', jsonb_build_array(dh.id('cl2'))))),
    'lint', jsonb_build_object('ok', true, 'problems', '[]'::jsonb, 'warnings', '[]'::jsonb),
    'copy', p_copy, 'claim_ids', to_jsonb(coalesce(p_claims, array[dh.id('cl2')])), 'asset_ids', '[]'::jsonb) || p_extra
$$;
create function dh.write(p_req jsonb) returns text language sql as $$
  select dh.try(format('select dh.save(''written'', drafter_write(%L::jsonb))', p_req)) $$;
grant execute on all functions in schema dh to anon, authenticated, service_role;

-- ── Fixtures (as postgres) ──────────────────────────────────────────────────
insert into clients (id, name, city, state, website_url, status) values
  (dh.id('c'), 'Handoff Roofing', 'Wentzville', 'MO', dh.site(), 'active');
insert into services (id, client_id, name, status, page_url) values (dh.id('rr'), dh.id('c'), 'Roof Replacement', 'approved', dh.page_url());
insert into keywords (id, client_id, keyword, intent, service_id, target_url, is_active) values
  (dh.id('kt'), dh.id('c'), 'roof quote handoff', 'transactional', dh.id('rr'), dh.page_url(), true),
  (dh.id('kc'), dh.id('c'), 'roof replacement handoff', 'commercial', dh.id('rr'), dh.page_url(), true),
  (dh.id('kx'), dh.id('c'), 'how long does a roof last handoff', 'informational', dh.id('rr'), dh.page_url(), true);
insert into page_groups (id, client_id, name, page_type, target_url, supporting_keyword_ids, status) values
  (dh.id('g_rr'), dh.id('c'), 'Roof Replacement', 'service', dh.page_url(), '{}', 'approved');
insert into claims (id, client_id, claim, status, source) values
  (dh.id('cl1'), dh.id('c'), 'Lifetime workmanship warranty', 'sourced', 'https://handoff.example.test/warranty'),
  (dh.id('cl2'), dh.id('c'), 'Installs architectural shingles', 'sourced', 'https://handoff.example.test/roofing'),
  (dh.id('cl3'), dh.id('c'), 'Best roofer in town', 'unverified', null);
create function dh.fail_link() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('dh.fail_link', true), '') = 'on' then raise exception 'forced link failure' using errcode = 'XX003'; end if;
  return new;
end $$;
create trigger dh_fail_link before insert on authority_opportunity_links for each row execute function dh.fail_link();

-- ── The first analysis ──────────────────────────────────────────────────────
\c - authenticator
set role service_role;
select dh.as_user('service_role', null);
select dh.put('r1', dh.run(dh.gbp('transactional', 'kt')));
reset role;

\c - postgres
do $$ begin
  perform dh.ok('S1 one open request per opportunity is an index, and the new column and function exist',
    exists (select 1 from pg_indexes where indexname = 'tasks_authority_draft_open_key')
    and exists (select 1 from information_schema.columns where table_name = 'drafter_runs' and column_name = 'authority_opportunity_id')
    and exists (select 1 from information_schema.columns where table_name = 'authority_opportunities' and column_name = 'cycle_started_at'));
  perform dh.ok('S2 authority_draft_start: teammates and the service, not anon',
    has_function_privilege('authenticated', 'authority_draft_start(uuid)', 'execute')
    and not has_function_privilege('anon', 'authority_draft_start(uuid)', 'execute'));
  perform dh.ok('S3 the opportunity starts open, with no request, run, post or link',
    (dh.o()).status = 'open' and dh.effective() = 'open' and dh.requests() = 0 and dh.runs() = 0 and dh.posts() = 0 and dh.links() = 0);
end $$;

-- ── Q. Who may request ──────────────────────────────────────────────────────
do $$ declare e text := dh.request();
begin perform dh.ok('Q1 the worker''s SQL cannot request a draft', e like '42501%' and dh.requests() = 0, e); end $$;
\c - authenticator
set role service_role;
select dh.as_user('service_role', null);
do $$ declare e text := dh.request();
begin perform dh.ok('Q2 the service role cannot request a draft', e like '42501%' and dh.requests() = 0, e); end $$;
reset role;
set role authenticated;
select dh.as_user('authenticated', :'pa');
do $$ declare e text := dh.request();
begin perform dh.ok('Q3 a portal contact cannot request a draft', e like '42501%' and dh.requests() = 0, e); end $$;
select dh.as_user('authenticated', :'strngr');
do $$ declare e text := dh.request();
begin perform dh.ok('Q4 a non-team sign-in cannot request a draft', e like '42501%' and dh.requests() = 0, e); end $$;
reset role;
set role anon;
select dh.as_user('anon', null);
do $$ declare e text := dh.request();
begin perform dh.ok('Q5 anon cannot request a draft', e like '42501%' and dh.requests() = 0, e); end $$;
reset role;

-- ── R. A teammate requests ──────────────────────────────────────────────────
set role authenticated;
select dh.as_user('authenticated', :'team');
do $$
declare e text;
begin
  e := dh.request('commercial');
  perform dh.ok('R1 a post still inside its cadence cannot be requested', e like '22023%cadence%' and dh.requests() = 0, e);
  e := dh.request('informational');
  perform dh.ok('R2 a blocked post cannot be requested', e like '22023%ready%' and dh.requests() = 0, e);
  e := dh.try(format('select authority_apply(%L, ''request_draft'', ''{}''::jsonb, %L::jsonb)',
    (select id from authority_opportunities where client_id = dh.id('c') and key like 'page\_improvement:%'),
    (select jsonb_build_object('run_id', last_seen_run_id, 'status', status, 'suppressed', suppressed, 'dismissed_until', dismissed_until)
       from authority_opportunities where client_id = dh.id('c') and key like 'page\_improvement:%')));
  perform dh.ok('R3 only a Business Profile post opportunity takes Draft with AI', e like '22023%Business Profile%' and dh.requests() = 0, e);
  e := dh.try(format('select authority_apply(%L, ''request_draft'', ''{}''::jsonb, %L::jsonb)', dh.oid(), dh.exp() || '{"status": "accepted"}'));
  perform dh.ok('R4 a request against a changed workflow is refused (AU409)', e like 'AU409%' and dh.requests() = 0, e);

  e := dh.request();
  perform dh.ok('R5 a teammate''s request succeeds', e is null, e);
  perform dh.put('task1', (dh.saved('req')->>'id')::uuid);
  perform dh.ok('R6 ...as one open CLAUDE task keyed to the opportunity, created by the teammate',
    dh.requests() = 1 and (dh.req_task()).id = dh.id('task1') and (dh.req_task()).owner = 'CLAUDE' and (dh.req_task()).status = 'open'
    and (dh.req_task()).created_by is not null and (dh.req_task()).key = 'authority_draft:' || dh.oid());
  perform dh.ok('R7 ...the opportunity is accepted, not in progress: the request is never a link',
    (dh.o()).status = 'accepted' and dh.effective() = 'accepted' and dh.links() = 0);
  perform dh.ok('R8 ...with an accepted event and the team''s request_draft decision naming the task',
    dh.n(format($q$select count(*) from authority_opportunity_events where opportunity_id = %L and kind = 'accepted' and actor_kind = 'team'$q$, dh.oid())) = 1
    and dh.n(format($q$select count(*) from authority_opportunity_events where opportunity_id = %L and kind = 'decision' and actor_kind = 'team'
      and detail->>'action' = 'request_draft' and detail->>'task_id' = %L$q$, dh.oid(), dh.id('task1'))) = 1);
  perform dh.ok('R9 ...and the worker was started once for it',
    dh.fires(dh.id('task1')) = 1 and (dh.saved('req')->'rows'->0->'started'->>'fired')::boolean);
  perform dh.ok('R10 no Drafter run and no post yet', dh.runs() = 0 and dh.posts() = 0);
end $$;
reset role;

-- ── I. Idempotency and retry-safe starts ────────────────────────────────────
\c - postgres
do $$ declare e text;
begin
  e := dh.try(format($q$insert into tasks (client_id, title, owner, key) values (%L, 'dup', 'CLAUDE', %L)$q$, dh.id('c'), 'authority_draft:' || dh.oid()));
  perform dh.ok('I1 a second open request for the opportunity is impossible (unique index)', e like '23505%' and dh.open_requests() = 1, e);
end $$;
\c - authenticator
set role authenticated;
select dh.as_user('authenticated', :'team');
do $$ declare e text;
begin
  e := dh.request();
  perform dh.ok('I2 requesting again reuses the open request (no second task)',
    e is null and (dh.saved('req')->>'id')::uuid = dh.id('task1') and (dh.saved('req')->'rows'->0->>'reused')::boolean
    and dh.requests() = 1 and dh.open_requests() = 1, e);
  perform dh.ok('I3 ...and a start inside two minutes is debounced, not repeated', dh.fires(dh.id('task1')) = 1);
end $$;
reset role;
-- The first start failed (the Routine API answered 500) and ten minutes passed.
\c - postgres
update worker_fires set created_at = now() - interval '11 minutes' where client_id = dh.id('c') and reason = 'Authority draft request ' || dh.id('task1');
insert into net._http_response (id, status_code, content)
  select request_id, 500, 'upstream error' from worker_fires where client_id = dh.id('c') and reason = 'Authority draft request ' || dh.id('task1');
do $$
begin
  perform retry_failed_fires();
  perform dh.ok('I4 a failed start is retried by the fire log (retry_failed_fires): a second fire, the same request',
    dh.fires(dh.id('task1')) = 2 and dh.requests() = 1 and dh.open_requests() = 1 and dh.runs() = 0 and dh.posts() = 0);
end $$;
-- The start never happened at all (no Routine credentials at the time): the
-- request stays durable, and a restart fires it.
update worker_fires set created_at = now() - interval '30 minutes' where client_id = dh.id('c') and reason = 'Authority draft request ' || dh.id('task1');
create table dh.secrets_backup as select * from vault.secrets where name in ('ROUTINE_FIRE_URL', 'ROUTINE_FIRE_TOKEN');
delete from vault.secrets where name in ('ROUTINE_FIRE_URL', 'ROUTINE_FIRE_TOKEN');
\c - authenticator
set role authenticated;
select dh.as_user('authenticated', :'team');
do $$ declare v jsonb;
begin
  v := authority_draft_start(dh.id('task1'));
  perform dh.ok('I5 with no Routine credentials a start fires nothing, and the request stays open',
    not (v->>'fired')::boolean and dh.fires(dh.id('task1')) = 2 and dh.open_requests() = 1, v::text);
end $$;
reset role;
\c - postgres
insert into vault.secrets select * from dh.secrets_backup;
\c - authenticator
set role authenticated;
select dh.as_user('authenticated', :'team');
do $$ declare v jsonb;
begin
  v := authority_draft_start(dh.id('task1'));
  perform dh.ok('I6 a restart (the Retry start button) fires the same request once more; still one request, no run, no post',
    (v->>'fired')::boolean and dh.fires(dh.id('task1')) = 3 and dh.requests() = 1 and dh.runs() = 0 and dh.posts() = 0, v::text);
end $$;
reset role;
set role anon;
select dh.as_user('anon', null);
do $$ declare e text := dh.try(format('select authority_draft_start(%L)', dh.id('task1')));
begin perform dh.ok('I7 anon cannot start a request', e like '42501%', e); end $$;
reset role;

-- ── D. drafter_write in Authority mode: every conflict refuses, nothing written ──
-- Every case below is the valid request with one thing wrong, so each refusal
-- is the one named. The one successful write comes after all of them.
\c - postgres
create function dh.nothing_written() returns boolean language sql stable as $$
  select dh.runs() = 0 and dh.posts() = 0 and dh.links() = 0 and dh.open_requests() = 1 $$;
create function dh.copy() returns text language sql immutable as $$
  select 'Ready for a roof replacement quote in Wentzville? We install architectural shingles. Request a quote.' $$;
create function dh.decide(p_verb text, p_payload jsonb default '{}') returns text language sql as $$
  select dh.try(format('select authority_decide(%L, %L, %L::jsonb)', dh.oid(), p_verb, p_payload)) $$;
create function dh.close_request_by_hand() returns void language sql as $$
  update public.tasks set status = 'done' where client_id = dh.id('c') and key like 'authority\_draft:%' and status <> 'done' $$;
grant execute on all functions in schema dh to anon, authenticated, service_role;

do $$ declare e text := dh.write(dh.req(dh.copy()));
begin perform dh.ok('D1 the worker''s SQL cannot write a draft', e like '42501%' and dh.nothing_written(), e); end $$;

\c - authenticator
set role service_role;
select dh.as_user('service_role', null);
do $$
declare e text; r jsonb;
begin
  e := dh.write(dh.req(dh.copy(), '{"authority_run_id": "00000000-0000-4000-0000-000000000000"}'));
  perform dh.ok('D2 an expected analysis run that is not the opportunity''s current one is refused (authority_stale)',
    e like 'AU409%authority_stale%' and dh.nothing_written(), e);
  e := dh.write(dh.req(dh.copy(), jsonb_build_object('authority_opportunity_id', gen_random_uuid())));
  perform dh.ok('D3 an unknown opportunity is refused (opportunity_not_found)', e like 'AU409%opportunity_not_found%' and dh.nothing_written(), e);
  e := dh.write(dh.req(dh.copy(), '{}', null, 'kc'));
  perform dh.ok('D4 a different keyword than the opportunity''s is refused (target_mismatch)', e like 'AU409%target_mismatch%' and dh.nothing_written(), e);
  e := dh.write(jsonb_set(dh.req(dh.copy()), '{brief,target,search_intent}', '"commercial"'));
  perform dh.ok('D5 a different intent is refused (target_mismatch)', e like 'AU409%target_mismatch%' and dh.nothing_written(), e);
  e := dh.write(jsonb_set(dh.req(dh.copy()), '{brief,target,cta,type}', '"BOOK"'));
  perform dh.ok('D6 a different button is refused (target_mismatch)', e like 'AU409%target_mismatch%' and dh.nothing_written(), e);
  e := dh.write(jsonb_set(dh.req(dh.copy()), '{brief,target,post_type}', '"offer"'));
  perform dh.ok('D7 an offer post is refused (target_mismatch: Authority recommends a standard post)', e like 'AU409%target_mismatch%' and dh.nothing_written(), e);
  e := dh.write(dh.req(dh.copy(), '{}', jsonb_build_object('opportunity_id', dh.oid('commercial'), 'preferred_claim_ids', jsonb_build_array(dh.id('cl2')))));
  perform dh.ok('D8 a brief built for another opportunity is refused (brief_mismatch)', e like 'AU409%brief_mismatch%' and dh.nothing_written(), e);
  e := dh.write(dh.req(dh.copy(), '{}', jsonb_build_object('opportunity_id', dh.oid(), 'preferred_claim_ids', jsonb_build_array(dh.id('cl1')))));
  perform dh.ok('D9 preferred evidence that is not the analysis''s is refused (evidence_ineligible)', e like 'AU409%evidence_ineligible%' and dh.nothing_written(), e);
  r := jsonb_set(dh.req(dh.copy(), '{}', null, 'kt', array[dh.id('cl1')]), '{brief,allowed_facts,claims}', jsonb_build_array(jsonb_build_object('id', dh.id('cl1'))));
  e := dh.write(r);
  perform dh.ok('D10 preferred evidence the brief does not allow is refused (evidence_ineligible)', e like 'AU409%evidence_ineligible%' and dh.nothing_written(), e);
  -- The Drafter's own refusals stay authoritative in Authority mode.
  e := dh.write(dh.req(dh.copy(), '{"lint": {"ok": false, "problems": [{"code": "x"}], "warnings": []}}'));
  perform dh.ok('D11 a draft that failed the linter is still refused', e like '23514%linter%' and dh.nothing_written(), e);
  e := dh.write(dh.req(dh.copy(), '{}', null, 'kt', array[dh.id('cl3')]));
  perform dh.ok('D12 a claim the brief did not allow is still refused', e like '23514%claim%' and dh.nothing_written(), e);
end $$;
reset role;

-- The opportunity leaves the analysis, is blocked, then waits on cadence:
-- each refused, and the next analysis restores it.
\c - authenticator
set role service_role;
select dh.as_user('service_role', null);
select dh.put('r_gone', dh.run(dh.gbp('commercial', 'kc', 'ready', 'create', current_date + 10) || '{"key": "gbp_post:placeholder:none"}'));
do $$ declare e text := dh.write(dh.req(dh.copy()));
begin perform dh.ok('D13 an opportunity the latest analysis no longer reports is refused (opportunity_not_current)',
  e like 'AU409%opportunity_not_current%' and dh.nothing_written() and not (dh.o()).present, e); end $$;
select dh.put('r_blocked', dh.run(dh.gbp('transactional', 'kt', 'blocked', 'blocked_data_prerequisite')));
do $$ declare e text := dh.write(dh.req(dh.copy()));
begin perform dh.ok('D14 an opportunity the analysis now blocks is refused (not_ready)', e like 'AU409%not_ready%' and dh.nothing_written(), e); end $$;
select dh.put('r_wait', dh.run(dh.gbp('transactional', 'kt', 'ready', 'create', current_date + 5)));
do $$ declare e text := dh.write(dh.req(dh.copy()));
begin perform dh.ok('D15 an opportunity inside its cadence is refused (cadence_active)', e like 'AU409%cadence_active%' and dh.nothing_written(), e); end $$;
select dh.put('r2', dh.run(dh.gbp('transactional', 'kt')));
do $$ declare e text := dh.write(dh.req(dh.copy(), jsonb_build_object('authority_run_id', dh.id('r1'))));
begin perform dh.ok('D16 after a newer analysis, the older expected run is refused (authority_stale)', e like 'AU409%authority_stale%' and dh.nothing_written(), e); end $$;
reset role;

-- Dismissed by a teammate: refused. Reopened: the request still stands.
set role authenticated;
select dh.as_user('authenticated', :'team');
do $$ declare e text := dh.decide('dismiss', jsonb_build_object('reason', 'Not this month', 'until', (now() at time zone 'America/Chicago')::date + 30));
begin perform dh.ok('D17a (setup) a teammate dismisses the opportunity', e is null and (dh.o()).status = 'dismissed', e); end $$;
reset role;
set role service_role;
select dh.as_user('service_role', null);
do $$ declare e text := dh.write(dh.req(dh.copy()));
begin perform dh.ok('D17 a dismissed opportunity is refused (dismissed)', e like 'AU409%dismissed%' and dh.nothing_written(), e); end $$;
reset role;
set role authenticated;
select dh.as_user('authenticated', :'team');
do $$ declare e text := dh.decide('reopen');
begin perform dh.ok('D18a (setup) reopened', e is null and (dh.o()).status = 'open', e); end $$;

-- A request closed by hand is not a completion, and no longer authorises a draft.
do $$ begin
  perform dh.close_request_by_hand();
  perform dh.ok('D18 a request task closed by hand never completes the opportunity (no link; still open)',
    dh.open_requests() = 0 and dh.links() = 0 and dh.effective() = 'open');
end $$;
reset role;
set role service_role;
select dh.as_user('service_role', null);
do $$ declare e text := dh.write(dh.req(dh.copy()));
begin perform dh.ok('D19 ...and a draft without an open request is refused (not_requested)',
  e like 'AU409%not_requested%' and dh.runs() = 0 and dh.posts() = 0 and dh.links() = 0, e); end $$;
reset role;
-- A task with the right key that no teammate asked for (no team decision event) is not a request.
\c - postgres
insert into tasks (client_id, title, owner, key) values (dh.id('c'), 'Forged request', 'CLAUDE', 'authority_draft:' || dh.oid());
\c - authenticator
set role service_role;
select dh.as_user('service_role', null);
do $$ declare e text := dh.write(dh.req(dh.copy()));
begin perform dh.ok('D20 an open task with the key but no teammate''s request_draft decision is refused (not_requested)',
  e like 'AU409%not_requested%' and dh.nothing_written(), e); end $$;
reset role;
-- The teammate asks again: the open task is reused and now carries the team's decision.
set role authenticated;
select dh.as_user('authenticated', :'team');
do $$ declare e text := dh.request();
begin
  perform dh.put('task2', (dh.saved('req')->>'id')::uuid);
  perform dh.ok('D21 (setup) a teammate''s request reuses the open task and records its decision',
    e is null and (dh.saved('req')->'rows'->0->>'reused')::boolean and dh.open_requests() = 1 and (dh.o()).status = 'accepted', e);
end $$;
reset role;

-- A failure after the post is written (the link) rolls everything back.
set role service_role;
select dh.as_user('service_role', null);
set dh.fail_link = 'on';
do $$ declare e text := dh.write(dh.req(dh.copy()));
begin perform dh.ok('D22 a failure while linking rolls back the run, the post and the request''s closing',
  e like 'XX003%' and dh.nothing_written() and (dh.req_task()).status = 'open', e); end $$;
set dh.fail_link = 'off';

-- ── W. The one successful write ─────────────────────────────────────────────
do $$ declare e text := dh.write(dh.req(dh.copy(), jsonb_build_object('authority_run_id', dh.id('r2'))));
begin
  perform dh.ok('W1 a requested, matching draft is written', e is null, e);
  perform dh.put('run1', (dh.saved('written')->>'run_id')::uuid);
  perform dh.put('post1', (dh.saved('written')->>'post_id')::uuid);
end $$;
reset role;
\c - postgres
do $$ begin
  perform dh.ok('W2 one run, carrying the opportunity; one post in review',
    dh.runs() = 1 and dh.posts() = 1
    and (select authority_opportunity_id = dh.oid() and status = 'submitted' and post_id = dh.id('post1') from drafter_runs where id = dh.id('run1'))
    and (select review_status = 'in_review' and publish_status = 'not_scheduled' from social_posts where id = dh.id('post1')));
  perform dh.ok('W3 the post, not the request, is linked: one social_post link',
    dh.links() = 1 and exists (select 1 from authority_opportunity_links where opportunity_id = dh.oid() and kind = 'social_post' and social_post_id = dh.id('post1')));
  perform dh.ok('W4 the request is done with a note naming the post; the opportunity is in progress',
    dh.open_requests() = 0 and (select status = 'done' and completed_at is not null and notes like '%' || dh.id('post1') || '%' from tasks where id = dh.id('task2'))
    and dh.effective() = 'in_progress' and (dh.saved('written')->>'request_task_id')::uuid = dh.id('task2'));
  perform dh.ok('W5 0045''s human review task is open, unassigned, in the CLAUDE_APPROVAL lane',
    (select t.owner = 'CLAUDE_APPROVAL' and t.status <> 'done' and t.assignee_id is null
       from social_posts p join tasks t on t.id = p.review_task_id where p.id = dh.id('post1')));
  perform dh.ok('W6 nothing is approved, scheduled or published',
    not exists (select 1 from social_posts where client_id = dh.id('c') and (review_status = 'approved' or publish_status <> 'not_scheduled')));
end $$;

-- ── E. Retries after the write ──────────────────────────────────────────────
\c - authenticator
set role service_role;
select dh.as_user('service_role', null);
do $$ declare e text := dh.write(dh.req(dh.copy()));
begin perform dh.ok('E1 the same submit again (a duplicate worker session) is refused; still one run, one post, one link',
  e like 'AU409%already_in_progress%' and dh.runs() = 1 and dh.posts() = 1 and dh.links() = 1, e); end $$;
do $$ declare v jsonb := authority_draft_start(dh.id('task2'));
begin perform dh.ok('E2 a late restart of the finished request fires nothing', not (v->>'fired')::boolean, v::text); end $$;
reset role;
set role authenticated;
select dh.as_user('authenticated', :'team');
do $$ declare e text := dh.request();
begin perform dh.ok('E3 a new request while the draft is in review is refused (AU409), no task',
  e like 'AU409%' and dh.open_requests() = 0 and dh.requests() = 2, e); end $$;

-- ── L. The linked post drives the lifecycle ─────────────────────────────────
do $$ declare e text;
begin
  e := dh.try(format($q$update social_posts set review_status = 'rejected', review_note = 'Say which shingles.' where id = %L$q$, dh.id('post1')));
  perform dh.ok('L1 rejecting the post returns the opportunity to accepted (the link is dead)',
    e is null and dh.effective() = 'accepted' and (dh.o()).status = 'accepted', e);
  e := dh.request();
  perform dh.put('task3', (dh.saved('req')->>'id')::uuid);
  perform dh.ok('L2 a redraft can be requested: a new request task, started',
    e is null and not (dh.saved('req')->'rows'->0->>'reused')::boolean and dh.open_requests() = 1 and dh.fires(dh.id('task3')) = 1, e);
end $$;
reset role;
set role service_role;
select dh.as_user('service_role', null);
do $$ declare e text := dh.write(dh.req(dh.copy() || ' Owens Corning shingles.', '{"attempt": 2}'));
begin
  perform dh.put('post2', (dh.saved('written')->>'post_id')::uuid);
  perform dh.ok('L3 the redraft is written (a rejected post is no cadence block): in progress again',
    e is null and dh.runs() = 2 and dh.posts() = 2 and dh.links() = 2 and dh.open_requests() = 0 and dh.effective() = 'in_progress', e);
end $$;
reset role;
set role authenticated;
select dh.as_user('authenticated', :'team');
do $$ declare e text;
begin
  e := dh.try(format($q$update social_posts set review_status = 'approved' where id = %L$q$, dh.id('post2')));
  perform dh.ok('L4 approving the post completes the opportunity', e is null and dh.effective() = 'completed', e);
  e := dh.request();
  perform dh.ok('L5 a completed opportunity takes no new request this cycle (AU409)', e like 'AU409%' and dh.open_requests() = 0, e);
  perform dh.ok('L6 still nothing scheduled or published', not exists (select 1 from social_posts where client_id = dh.id('c') and publish_status <> 'not_scheduled'));
end $$;
reset role;

-- ── C. Recurring cycles ─────────────────────────────────────────────────────
set role service_role;
select dh.as_user('service_role', null);
select dh.put('r3', dh.run(dh.gbp('transactional', 'kt', 'ready', 'create', current_date + 21)));
do $$ begin
  perform dh.ok('C1 while the engine reports the next post inside its cadence, the cycle stays completed',
    dh.effective() = 'completed' and (dh.o()).cycle_started_at is null
    and dh.n(format($q$select count(*) from authority_opportunity_events where opportunity_id = %L and kind = 'reopened'
                        and detail->>'reason' = 'new cadence cycle'$q$, dh.oid())) = 0);
end $$;
select dh.put('r4', dh.run(dh.gbp('transactional', 'kt')));
do $$ begin
  perform dh.ok('C2 once the engine reports it eligible again, a new cycle starts: reopened, open, the old approved post no longer counts',
    dh.effective() = 'open' and (dh.o()).status = 'open' and (dh.o()).cycle_started_at is not null
    and dh.n(format($q$select count(*) from authority_opportunity_events where opportunity_id = %L and kind = 'reopened'
                        and detail->>'reason' = 'new cadence cycle'$q$, dh.oid())) = 1);
end $$;
select dh.put('r5', dh.run(dh.gbp('transactional', 'kt')));
do $$ begin
  perform dh.ok('C3 a further analysis does not start another cycle (no done link this cycle)',
    dh.n(format($q$select count(*) from authority_opportunity_events where opportunity_id = %L and kind = 'reopened'
                        and detail->>'reason' = 'new cadence cycle'$q$, dh.oid())) = 1);
end $$;
reset role;
set role authenticated;
select dh.as_user('authenticated', :'team');
do $$ declare e text := dh.request();
begin
  perform dh.put('task4', (dh.saved('req')->>'id')::uuid);
  perform dh.ok('C4 the new cycle takes a request', e is null and dh.open_requests() = 1, e);
end $$;
reset role;
set role service_role;
select dh.as_user('service_role', null);
do $$ declare e text := dh.write(dh.req(dh.copy() || ' New month.', '{"attempt": 1}'));
begin perform dh.ok('C5 ...but the Drafter rechecks cadence live: an approved post from the last 21 days refuses (cadence_active)',
  e like 'AU409%cadence_active%' and dh.runs() = 2 and dh.posts() = 2 and dh.links() = 2 and dh.open_requests() = 1, e); end $$;
reset role;

-- ── Summary ─────────────────────────────────────────────────────────────────
\c - postgres
\o
\pset footer off
select status, count(*) from dh.results group by status order by status;
select n, status, name, detail from dh.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from dh.results where status = 'fail';
  if f > 0 then raise exception '% Drafter hand-off check(s) failed', f; end if;
end $$;
