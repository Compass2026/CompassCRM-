-- Tests for 20261015175410 (binding claims on Authority draft requests), run
-- by scripts/test-portal-sandbox.sh on the same replay. Own harness schema
-- (adc) and a fictional client with three services, so each scenario has its
-- own Ready Business Profile opportunity and Draft with AI request.
--
-- The blog drafts' Oct 15 2026 incident, on the Authority path: an operator
-- session claims the request, the worker Routine tries to draft the same
-- opportunity. A fresh foreign claim blocks drafter_write; an expired one
-- does not; an unclaimed request writes exactly as before.
--
-- Callers, as they reach production:
--   person   authenticator, role authenticated, team JWT
--   drafter  authenticator, role service_role (the post-drafter function)
--   engine   authenticator, role service_role (the authority-run function)
--   worker   postgres (the worker's own SQL)

\set team   '00000000-0000-4000-a000-000000000001'

\c - postgres
\o /dev/null
create schema adc;
create table adc.results (n serial, status text, name text, detail text);
create table adc.saved (k text primary key, v jsonb);
grant usage on schema adc to anon, authenticated, service_role;
grant insert, select on adc.results to anon, authenticated, service_role;
grant select, insert, update on adc.saved to anon, authenticated, service_role;
grant usage on sequence adc.results_n_seq to anon, authenticated, service_role;

create function adc.ok(p_name text, p_pass boolean, p_detail text default null) returns void language sql as $$
  insert into adc.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail) $$;
create function adc.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function adc.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case when p_sub is null then json_build_object('role', p_role)::text
    else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function adc.id(p_k text) returns uuid language sql immutable as $$ select md5('adc:' || p_k)::uuid $$;
create function adc.save(p_k text, p_v jsonb) returns void language sql as $$
  insert into adc.saved values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function adc.saved(p_k text) returns jsonb language sql stable as $$ select v from adc.saved where k = p_k $$;

create function adc.site() returns text language sql immutable as $$ select 'https://claim-roofing.example.test' $$;
create function adc.path(p_svc text) returns text language sql immutable as $$ select '/services/' || p_svc $$;
create function adc.page_url(p_svc text) returns text language sql immutable as $$ select adc.site() || adc.path(p_svc) $$;
create function adc.page(p_path text) returns jsonb language sql immutable as $$
  select jsonb_build_object('url', adc.site() || p_path, 'status', 200, 'final_url', adc.site() || p_path, 'final_status', 200,
    'redirect_loop', false, 'in_sitemap', true, 'title', null, 'h1', null, 'h2', '[]'::jsonb, 'canonical', null, 'words', 300, 'text', 'x')
$$;
-- One Ready transactional Business Profile post per service, as the engine reports it.
create function adc.gbp(p_svc text) returns jsonb language sql stable as $$
  select jsonb_build_object('id', 'gbp_post:' || p_svc || ':transactional',
    'key', format('gbp_post:%s:transactional', adc.id('svc-' || p_svc)),
    'section', 'ready', 'action', 'create', 'tier', 'B', 'content_type', 'gbp_post', 'topic', initcap(p_svc),
    'service_id', adc.id('svc-' || p_svc), 'objective', 'fixture', 'order', jsonb_build_array(1), 'eligible_from', null,
    'gap', 'A transactional Business Profile post.',
    'target', jsonb_build_object('keyword_id', adc.id('kw-' || p_svc), 'keyword', p_svc || ' quote claim', 'intent', 'transactional',
                                 'location', null, 'owner_path', adc.path(p_svc), 'cta', 'LEARN_MORE'),
    'evidence_claim_ids', jsonb_build_array(adc.id('cl')),
    'existing_coverage', '[]'::jsonb, 'blockers', '[]'::jsonb, 'gates', '[]'::jsonb,
    'reasons', jsonb_build_array(jsonb_build_object('tag', 'FACT', 'text', 'fixture')))
$$;
create function adc.run() returns uuid language plpgsql as $$
declare r uuid;
begin
  r := authority_begin_run(adc.id('c'), 'refresh', 'worker');
  perform authority_record_run(r, jsonb_build_object('status', 'completed', 'engine_version', 'authority-v1.3', 'judged_at', now(),
    'as_of', current_date, 'input_hash', 'sha256:' || repeat('ad', 32), 'section_hashes', authority_fingerprint(adc.id('c')),
    'inventory', jsonb_build_object('fetched_at', now(), 'site', adc.site(), 'pages', jsonb_build_array(adc.page('/'),
      adc.page(adc.path('fresh')), adc.page(adc.path('expired')), adc.page(adc.path('unclaimed')))),
    'inventory_errors', 0,
    'report', jsonb_build_object('client', jsonb_build_object('id', adc.id('c')), 'as_of', current_date, 'sources', '{}'::jsonb,
      'keywords', '[]'::jsonb, 'opportunities', jsonb_build_array(adc.gbp('fresh'), adc.gbp('expired'), adc.gbp('unclaimed')))));
  return r;
end $$;
create function adc.o(p_svc text) returns public.authority_opportunities language sql stable security definer as $$
  select * from public.authority_opportunities where client_id = adc.id('c') and key = format('gbp_post:%s:transactional', adc.id('svc-' || p_svc)) $$;
create function adc.task(p_svc text) returns public.tasks language sql stable security definer as $$
  select * from public.tasks where client_id = adc.id('c') and key = 'authority_draft:' || (adc.o(p_svc)).id order by created_at desc limit 1 $$;
create function adc.posts(p_svc text) returns bigint language sql stable security definer as $$
  select count(*) from public.social_posts where client_id = adc.id('c') and service_id = adc.id('svc-' || p_svc) $$;
create function adc.runs() returns bigint language sql stable security definer as $$
  select count(*) from public.drafter_runs where client_id = adc.id('c') $$;
-- A drafter_write request shaped like post-drafter's in Authority mode, with its claimant.
create function adc.req(p_svc text, p_claimant text) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'client_id', adc.id('c'), 'requested_via', 'worker', 'runtime', 'sandbox-model', 'attempt', 1,
    'brief_version', 'drafter-v1', 'brief_hash', 'sha256:' || repeat('ae', 32),
    'authority_opportunity_id', (adc.o(p_svc)).id, 'authority_run_id', (adc.o(p_svc)).last_seen_run_id, 'claimant', p_claimant,
    'brief', jsonb_build_object(
      'client', jsonb_build_object('id', adc.id('c')),
      'target', jsonb_build_object('channel', 'google_business', 'post_type', 'standard', 'search_intent', 'transactional',
        'service', jsonb_build_object('id', adc.id('svc-' || p_svc), 'name', initcap(p_svc), 'page_url', adc.page_url(p_svc)),
        'keyword', jsonb_build_object('id', adc.id('kw-' || p_svc), 'text', p_svc || ' quote claim'),
        'cta', jsonb_build_object('type', 'LEARN_MORE', 'url', adc.page_url(p_svc)), 'offer', null),
      'allowed_facts', jsonb_build_object('claims', jsonb_build_array(jsonb_build_object('id', adc.id('cl')))),
      'authority', jsonb_build_object('opportunity_id', (adc.o(p_svc)).id, 'preferred_claim_ids', jsonb_build_array(adc.id('cl')))),
    'lint', jsonb_build_object('ok', true, 'problems', '[]'::jsonb, 'warnings', '[]'::jsonb),
    'copy', format('Ready for a %s quote? Our crew installs architectural shingles. Request a quote today.', p_svc),
    'claim_ids', jsonb_build_array(adc.id('cl')), 'asset_ids', '[]'::jsonb)
$$;
create function adc.write(p_svc text, p_claimant text) returns text language sql as $$
  select adc.try(format('select adc.save(%L, drafter_write(%L::jsonb))', 'w-' || p_svc, adc.req(p_svc, p_claimant))) $$;
grant execute on all functions in schema adc to anon, authenticated, service_role;

-- ── Fixtures (fictional) ────────────────────────────────────────────────────
insert into clients (id, name, city, state, website_url, status) values
  (adc.id('c'), 'Claim Roofing', 'Joplin', 'MO', adc.site(), 'active');
insert into services (id, client_id, name, status, page_url)
select adc.id('svc-' || k), adc.id('c'), initcap(k), 'approved', adc.page_url(k) from unnest(array['fresh', 'expired', 'unclaimed']) k;
insert into keywords (id, client_id, keyword, intent, service_id, target_url, is_active)
select adc.id('kw-' || k), adc.id('c'), k || ' quote claim', 'transactional', adc.id('svc-' || k), adc.page_url(k), true
  from unnest(array['fresh', 'expired', 'unclaimed']) k;
insert into claims (id, client_id, claim, status, source) values
  (adc.id('cl'), adc.id('c'), 'Installs architectural shingles', 'sourced', 'https://claim-roofing.example.test/roofing');
insert into tasks (id, client_id, title, owner, key) values
  (adc.id('t-other'), adc.id('c'), 'Not a Draft with AI request', 'CLAUDE', 'blog_post');
\o

-- ── The analysis, then a teammate presses Draft with AI on each ─────────────
\c - authenticator
set role service_role;
select adc.as_user('service_role', null);
\o /dev/null
select adc.run();
\o
reset role;

set role authenticated;
select adc.as_user('authenticated', :'team');
\o /dev/null
do $$
declare k text;
begin
  foreach k in array array['fresh', 'expired', 'unclaimed'] loop
    perform authority_apply((adc.o(k)).id, 'request_draft', '{}'::jsonb,
      jsonb_build_object('run_id', (adc.o(k)).last_seen_run_id, 'status', (adc.o(k)).status,
                         'suppressed', (adc.o(k)).suppressed, 'dismissed_until', (adc.o(k)).dismissed_until));
  end loop;
  perform adc.ok('G1 three open, unclaimed Draft with AI requests',
    (select bool_and((adc.task(svc)).status::text = 'open' and (adc.task(svc)).claimed_by is null) from unnest(array['fresh', 'expired', 'unclaimed']) svc));
  perform adc.ok('G2 a teammate cannot claim, or set a claim on a request directly',
    adc.try(format('select authority_draft_claim(%L, ''me'')', (adc.task('fresh')).id)) like '42501%'
    and adc.try(format('update tasks set claimed_by = ''me'' where id = %L', (adc.task('fresh')).id)) like '42501%');
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Claims (the worker's own SQL; an operator session uses the same) ───────
\c - postgres
\o /dev/null
do $$
declare r jsonb;
begin
  r := authority_draft_claim((adc.task('fresh')).id, 'operator-session');
  perform adc.ok('C1 the first claim wins: claimed_by recorded, the request in progress',
    (r->>'claimed')::boolean and (adc.task('fresh')).claimed_by = 'operator-session'
    and (adc.task('fresh')).status::text = 'in_progress', r::text);
  r := authority_draft_claim((adc.task('fresh')).id, 'worker-routine');
  perform adc.ok('C2 a second claimant is refused while the claim is fresh, told who holds it and until when',
    not (r->>'claimed')::boolean and r->>'reason' = 'claimed_by_other' and r->>'claimed_by' = 'operator-session'
    and r->>'expires_at' is not null and (adc.task('fresh')).claimed_by = 'operator-session', r::text);
  r := authority_draft_claim((adc.task('fresh')).id, 'operator-session');
  perform adc.ok('C3 the holder re-claims (refreshes) its own claim', (r->>'claimed')::boolean, r::text);
  perform adc.ok('C4 the worker cannot set or forge a claim by updating tasks',
    adc.try(format('update tasks set claimed_by = ''worker-routine'' where id = %L', (adc.task('fresh')).id)) like '42501%'
    and adc.try(format('update tasks set claimed_at = now() - interval ''2 hours'' where id = %L', (adc.task('fresh')).id)) like '42501%');
  perform adc.ok('C5 a claim names its claimant',
    adc.try(format('select authority_draft_claim(%L, '' '')', (adc.task('fresh')).id)) like '22023%');
  perform adc.ok('C6 only a Draft with AI request can be claimed here',
    adc.try(format('select authority_draft_claim(%L, ''worker-routine'')', adc.id('t-other'))) like 'P0002%'
    and adc.try(format('select authority_draft_claim(%L, ''worker-routine'')', adc.id('nope'))) like 'P0002%');

  perform authority_draft_claim((adc.task('expired')).id, 'operator-session');
end $$;
\o

-- Age the expired claim past the hour (a session that died); fixtures only.
\c - supabase_admin
update tasks set claimed_at = now() - interval '61 minutes' where id = (adc.task('expired')).id;

\c - postgres
\o /dev/null
do $$
declare r jsonb;
begin
  r := authority_draft_claim((adc.task('expired')).id, 'worker-routine');
  perform adc.ok('C7 a claim over an hour old is free: the worker takes it over',
    (r->>'claimed')::boolean and (adc.task('expired')).claimed_by = 'worker-routine', r::text);
end $$;
\o

-- ── drafter_write honours the claim ─────────────────────────────────────────
\c - authenticator
set role service_role;
select adc.as_user('service_role', null);
\o /dev/null
do $$
declare e text;
begin
  e := adc.write('fresh', 'worker-routine');
  perform adc.ok('W1 the incident: a fresh foreign claim blocks the Routine''s write (CD409 claimed_by_other)',
    e like 'CD409%claimed_by_other%operator-session%', e);
  e := adc.write('fresh', null);
  perform adc.ok('W2 a writer with no claimant is someone else too', e like 'CD409%', e);
  perform adc.ok('W3 a blocked write changes nothing: no run, no post, the request still the holder''s',
    adc.runs() = 0 and adc.posts('fresh') = 0 and (adc.task('fresh')).status::text = 'in_progress'
    and (adc.task('fresh')).claimed_by = 'operator-session');
  e := adc.write('fresh', 'operator-session');
  perform adc.ok('W4 the holder writes: the post in review, the request done',
    e is null and adc.posts('fresh') = 1 and (adc.task('fresh')).status::text = 'done'
    and (select review_status::text from social_posts where id = (adc.saved('w-fresh')->>'post_id')::uuid) = 'in_review', e);

  e := adc.write('expired', 'operator-session');
  perform adc.ok('W5 a lapsed holder is refused once the worker has taken the request over', e like 'CD409%worker-routine%', e);
  e := adc.write('expired', 'worker-routine');
  perform adc.ok('W6 the worker writes the request it took over', e is null and (adc.task('expired')).status::text = 'done', e);

  e := adc.write('unclaimed', null);
  perform adc.ok('W7 an unclaimed request writes exactly as before (no claimant needed)',
    e is null and adc.posts('unclaimed') = 1 and (adc.task('unclaimed')).status::text = 'done'
    and (adc.task('unclaimed')).claimed_by is null, e);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── After the write: nothing left to claim ──────────────────────────────────
\c - postgres
\o /dev/null
do $$
declare r jsonb;
begin
  r := authority_draft_claim((adc.task('fresh')).id, 'worker-routine');
  perform adc.ok('A1 a drafted request cannot be claimed (request_not_open)',
    not (r->>'claimed')::boolean and r->>'reason' = 'request_not_open', r::text);
end $$;
\o

\c - supabase_admin
\o /dev/null
select adc.ok('S1 authority_draft_claim is the worker''s and the drafter''s only',
  not has_function_privilege('authenticated', 'public.authority_draft_claim(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.authority_draft_claim(uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.authority_draft_claim(uuid, text)', 'execute')
  and has_function_privilege('postgres', 'public.authority_draft_claim(uuid, text)', 'execute'));
select adc.ok('S2 drafter_write keeps the caller''s rights, the GBP destination and Facebook changes, and gains the gate',
  not (select prosecdef from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure)
  and (select prosrc from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure) like '%authority_draft_claims_v1%'
  -- 20261027190935 (per-post Business Profile locations) supersedes the v1
  -- destination block: a GBP draft may name one of the client's verified
  -- locations, any other named account is refused, and Facebook keeps its Page rule.
  and (select prosrc from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure) like '%drafter_gbp_destination_v2%'
  and (select prosrc from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure) like '%A Business Profile draft names one of this client''''s verified locations%'
  and (select prosrc from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure) like '%A Facebook draft names one of this client''''s Facebook Pages%');
\o

\c - postgres
\o
\pset footer off
select status, count(*) from adc.results group by status order by status;
select n, status, name, detail from adc.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from adc.results where status = 'fail';
  if f > 0 then raise exception '% Authority draft claim check(s) failed', f; end if;
end $$;
