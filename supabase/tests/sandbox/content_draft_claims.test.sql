-- Tests for 20261015175146 (binding claims on blog draft work), run by
-- scripts/test-portal-sandbox.sh on the same replay. Own harness schema (cc)
-- and fictional clients.
--
-- The Oct 15 2026 Logic Solar incident, replayed: an operator session claims
-- the request task, the worker Routine tries to write the same draft. A
-- fresh foreign claim blocks the write; an expired one does not; an
-- unclaimed task writes exactly as before.
--
-- Callers, as they reach production:
--   person   authenticator, role authenticated, team JWT
--   drafter  authenticator, role service_role (the content-drafter function)
--   worker   postgres (the worker's own SQL)

\set team   '00000000-0000-4000-a000-000000000001'

\c - supabase_admin
\o /dev/null
create schema cc;
create table cc.results (n serial, status text, name text, detail text);
create table cc.saved (k text primary key, v text);
grant usage on schema cc to anon, authenticated, service_role, authenticator, postgres;
grant insert, select on cc.results to anon, authenticated, service_role, authenticator, postgres;
grant insert, select, update on cc.saved to anon, authenticated, service_role, authenticator, postgres;
grant usage on sequence cc.results_n_seq to anon, authenticated, service_role, authenticator, postgres;
create function cc.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into cc.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function cc.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function cc.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function cc.id(p_k text) returns uuid language sql immutable as $$ select md5('cc:' || p_k)::uuid $$;
create function cc.save(p_k text, p_v text) returns void language sql as $$
  insert into cc.saved values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function cc.get(p_k text) returns text language sql stable as $$ select v from cc.saved where k = p_k $$;
create function cc.task(p_k text) returns tasks language sql stable as $$
  select t.* from tasks t join content_drafts d on t.id = coalesce(d.request_task_id, d.source_task_id) where d.id = cc.get(p_k)::uuid
$$;
-- A written draft as the content-drafter function sends it, with its claimant.
create function cc.payload(p_draft uuid, p_claimant text) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'draft_id', p_draft, 'brief', jsonb_build_object('v', 1), 'brief_hash', 'sha256:' || repeat('b', 64),
    'runtime', 'sandbox', 'claimant', p_claimant, 'lint', jsonb_build_object('ok', true),
    'claim_ids', jsonb_build_array(md5('cc:c-sourced')::uuid), 'submit', true,
    'content', jsonb_build_object(
      'title', 'When should solar panels be cleaned?', 'slug', 'when-should-solar-panels-be-cleaned',
      'meta_title', 'When Should Solar Panels Be Cleaned?', 'meta_description', 'What dust and pollen do to output and when a rinse is worth it.',
      'h1', 'When should solar panels be cleaned?', 'outline', '[{"level": 2, "heading": "What builds up on panels"}]'::jsonb,
      'body_markdown', '## What builds up on panels' || chr(10) || repeat('Dust and pollen settle on glass. ', 60),
      'internal_links', '[{"url": "https://claim-solar.example.test/services/solar-install", "anchor": "solar installation"}]'::jsonb,
      'cta', '{"text": "Request a quote", "url": "https://claim-solar.example.test/contact"}'::jsonb))
$$;
grant execute on all functions in schema cc to anon, authenticated, service_role, authenticator, postgres;

-- ── Fixtures (fictional) ────────────────────────────────────────────────────
insert into clients (id, name, city, state, status) values (cc.id('a'), 'Claim Solar', 'Joplin', 'MO', 'active');
insert into services (id, client_id, name, status) values (cc.id('svc'), cc.id('a'), 'Solar Install', 'approved');
insert into keywords (id, client_id, keyword, intent, service_id) values
  (cc.id('kw'), cc.id('a'), 'when to clean solar panels', 'informational', cc.id('svc'));
insert into claims (id, client_id, claim, status, source) values
  (cc.id('c-sourced'), cc.id('a'), 'NABCEP certified installers', 'sourced', 'https://nabcep.example.test/1');
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent, keyword_id, service_id, planned_date)
select cc.id('i-' || k), cc.id('a'), date '2026-10-12', 'blog', null, 'educational', 'Cleaning solar panels ' || k, 'informational', cc.id('kw'), cc.id('svc'), null
  from unnest(array['fresh', 'expired', 'reclaimed', 'unclaimed']) k;
\o

-- ── A teammate presses Generate draft on each ───────────────────────────────
\c - authenticator
set role authenticated;
select cc.as_user('authenticated', :'team');
\o /dev/null
do $$
declare k text;
begin
  foreach k in array array['fresh', 'expired', 'reclaimed', 'unclaimed'] loop
    perform cc.save(k, content_draft_request(cc.id('i-' || k))->>'draft_id');
  end loop;
  perform cc.ok('G1 a teammate cannot claim, or set a claim on a task directly',
    cc.try(format('select content_draft_claim(%L, ''me'')', cc.get('fresh'))) like '42501%'
    and cc.try(format('update tasks set claimed_by = ''me'' where id = %L', (cc.task('fresh')).id)) like '42501%');
  perform cc.ok('G2 a new request task is unclaimed', (cc.task('fresh')).claimed_by is null and (cc.task('fresh')).status::text = 'open');
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Claims (the worker's own SQL; the operator session uses the same) ──────
\c - postgres
\o /dev/null
do $$
declare r jsonb;
begin
  r := content_draft_claim(cc.get('fresh')::uuid, 'operator-session');
  perform cc.ok('C1 the first claim wins: claimed_by recorded, the task in progress',
    (r->>'claimed')::boolean and (cc.task('fresh')).claimed_by = 'operator-session'
    and (cc.task('fresh')).status::text = 'in_progress', r::text);
  r := content_draft_claim(cc.get('fresh')::uuid, 'worker-routine');
  perform cc.ok('C2 a second claimant is refused while the claim is fresh, told who holds it',
    not (r->>'claimed')::boolean and r->>'reason' = 'claimed_by_other' and r->>'claimed_by' = 'operator-session'
    and (cc.task('fresh')).claimed_by = 'operator-session', r::text);
  r := content_draft_claim(cc.get('fresh')::uuid, 'operator-session');
  perform cc.ok('C3 the holder re-claims (refreshes) its own claim', (r->>'claimed')::boolean, r::text);
  perform cc.ok('C4 the worker cannot set or forge a claim by updating tasks',
    cc.try(format('update tasks set claimed_by = ''worker-routine'' where id = %L', (cc.task('fresh')).id)) like '42501%'
    and cc.try(format('update tasks set claimed_at = now() - interval ''2 hours'' where id = %L', (cc.task('fresh')).id)) like '42501%');
  perform cc.ok('C5 a claim names its claimant', cc.try(format('select content_draft_claim(%L, '' '')', cc.get('fresh'))) like '22023%');

  perform content_draft_claim(cc.get('expired')::uuid, 'operator-session');
  perform content_draft_claim(cc.get('reclaimed')::uuid, 'operator-session');
end $$;
\o

-- Age two claims past the hour (a session that died); fixtures only.
\c - supabase_admin
update tasks set claimed_at = now() - interval '61 minutes'
 where id in ((cc.task('expired')).id, (cc.task('reclaimed')).id);

\c - postgres
\o /dev/null
do $$
declare r jsonb;
begin
  r := content_draft_claim(cc.get('reclaimed')::uuid, 'worker-routine');
  perform cc.ok('C6 a claim over an hour old is free: the worker takes it',
    (r->>'claimed')::boolean and (cc.task('reclaimed')).claimed_by = 'worker-routine', r::text);
end $$;
\o

-- ── The drafter's write honours the claim ───────────────────────────────────
\c - authenticator
set role service_role;
select cc.as_user('service_role', null);
\o /dev/null
do $$
declare r jsonb; e text;
begin
  e := cc.try(format('select content_draft_write(%L::jsonb)', cc.payload(cc.get('fresh')::uuid, 'worker-routine')));
  perform cc.ok('W1 the incident: a fresh foreign claim blocks the Routine''s write (CD409 claimed_by_other)',
    e like 'CD409%claimed_by_other%operator-session%', e);
  e := cc.try(format('select content_draft_write(%L::jsonb)', cc.payload(cc.get('fresh')::uuid, null)));
  perform cc.ok('W2 a writer with no claimant is someone else too', e like 'CD409%', e);
  perform cc.ok('W3 a blocked write changes nothing: the draft still requested, the task still open work',
    (select status = 'requested' and title is null from content_drafts where id = cc.get('fresh')::uuid)
    and (cc.task('fresh')).status::text = 'in_progress');
  r := content_draft_write(cc.payload(cc.get('fresh')::uuid, 'operator-session'));
  perform cc.ok('W4 the holder writes: in review, the request task done',
    r->>'status' = 'in_review' and (cc.task('fresh')).status::text = 'done', r::text);

  r := content_draft_write(cc.payload(cc.get('expired')::uuid, 'worker-routine'));
  perform cc.ok('W5 an expired claim does not block a write', r->>'status' = 'in_review', r::text);
  r := content_draft_write(cc.payload(cc.get('reclaimed')::uuid, 'worker-routine'));
  perform cc.ok('W6 the worker writes a draft it re-claimed after the hour', r->>'status' = 'in_review', r::text);
  r := content_draft_write(cc.payload(cc.get('unclaimed')::uuid, null));
  perform cc.ok('W7 an unclaimed task writes exactly as before (no claimant needed)',
    r->>'status' = 'in_review' and (cc.task('unclaimed')).status::text = 'done'
    and (cc.task('unclaimed')).claimed_by is null, r::text);
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
  r := content_draft_claim(cc.get('fresh')::uuid, 'worker-routine');
  perform cc.ok('A1 a written draft cannot be claimed (draft_not_open)',
    not (r->>'claimed')::boolean and r->>'reason' = 'draft_not_open', r::text);
end $$;
\o

-- ── The weekly blog: the claim lives on the blog_post task ──────────────────
\c - supabase_admin
insert into tasks (id, client_id, title, owner, key, due_date)
values (cc.id('t-weekly'), cc.id('a'), 'Weekly blog post', 'CLAUDE', 'blog_post', date '2026-10-14');

\c - authenticator
set role service_role;
select cc.as_user('service_role', null);
\o /dev/null
select cc.save('weekly', (content_draft_open_weekly(jsonb_build_object(
  'task_id', cc.id('t-weekly'), 'topic', 'Do solar panels work in winter?', 'search_intent', 'informational',
  'keyword_id', cc.id('kw'), 'service_id', cc.id('svc'))))->>'draft_id');
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o /dev/null
do $$
declare r jsonb;
begin
  r := content_draft_claim(cc.get('weekly')::uuid, 'operator-session');
  perform cc.ok('K1 a weekly draft is claimed on its blog_post task',
    (r->>'claimed')::boolean and (r->>'task_id')::uuid = cc.id('t-weekly')
    and (select claimed_by from tasks where id = cc.id('t-weekly')) = 'operator-session', r::text);
end $$;
\o

\c - authenticator
set role service_role;
select cc.as_user('service_role', null);
\o /dev/null
do $$
declare r jsonb; e text;
begin
  e := cc.try(format('select content_draft_write(%L::jsonb)', cc.payload(cc.get('weekly')::uuid, 'worker-routine')));
  perform cc.ok('K2 the Routine cannot write a weekly draft an operator holds', e like 'CD409%', e);
  r := content_draft_write(cc.payload(cc.get('weekly')::uuid, 'operator-session'));
  perform cc.ok('K3 the holder writes it; the blog_post task stays open until approval',
    r->>'status' = 'in_review' and (select status::text from tasks where id = cc.id('t-weekly')) = 'in_progress', r::text);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - supabase_admin
\o /dev/null
select cc.ok('S1 content_draft_claim is the worker''s and the drafter''s only',
  not has_function_privilege('authenticated', 'public.content_draft_claim(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.content_draft_claim(uuid, text)', 'execute')
  and has_function_privilege('service_role', 'public.content_draft_claim(uuid, text)', 'execute')
  and has_function_privilege('postgres', 'public.content_draft_claim(uuid, text)', 'execute'));
\o

\c - postgres
\o
\pset footer off
select status, count(*) from cc.results group by status order by status;
select n, status, name, detail from cc.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from cc.results where status = 'fail';
  if f > 0 then raise exception '% content draft claim check(s) failed', f; end if;
end $$;
