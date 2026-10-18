-- Tests for 20261018220000 (Reserve for on content_draft_request), run by
-- scripts/test-portal-sandbox.sh on the same replay, after the claim suites.
-- Own harness schema (rr) and fictional clients.
--
-- The Oct 16 2026 Logic Solar race, replayed with the fix: a teammate presses
-- Generate draft reserving the request for an operator session; the worker
-- is not fired, and a Routine run started by anything else is refused at the
-- claim and at the write. Unset, everything happens exactly as before.
--
-- Callers, as they reach production:
--   person   authenticator, role authenticated, team JWT
--   drafter  authenticator, role service_role (the content-drafter function)
--   worker   postgres (the worker's own SQL; an operator session uses the same)

\set team   '00000000-0000-4000-a000-000000000001'

\c - supabase_admin
\o /dev/null
create schema rr;
create table rr.results (n serial, status text, name text, detail text);
create table rr.saved (k text primary key, v text);
grant usage on schema rr to anon, authenticated, service_role, authenticator, postgres;
grant insert, select on rr.results to anon, authenticated, service_role, authenticator, postgres;
grant insert, select, update on rr.saved to anon, authenticated, service_role, authenticator, postgres;
grant usage on sequence rr.results_n_seq to anon, authenticated, service_role, authenticator, postgres;
create function rr.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into rr.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function rr.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function rr.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function rr.id(p_k text) returns uuid language sql immutable as $$ select md5('rr:' || p_k)::uuid $$;
create function rr.save(p_k text, p_v text) returns void language sql as $$
  insert into rr.saved values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function rr.get(p_k text) returns text language sql stable as $$ select v from rr.saved where k = p_k $$;
create function rr.task(p_k text) returns tasks language sql stable as $$
  select t.* from tasks t join content_drafts d on t.id = coalesce(d.request_task_id, d.source_task_id) where d.id = rr.get(p_k)::uuid
$$;
create function rr.drafts(p_item text) returns bigint language sql stable as $$
  select count(*) from content_drafts where plan_item_id = rr.id('i-' || p_item)
$$;
-- Fires recorded for a draft (fire_foundation_worker logs one per real fire).
create function rr.fires(p_k text) returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select count(*) from worker_fires where reason = 'Content draft request ' || rr.get(p_k)
$$;
-- A written draft as the content-drafter function sends it, with its claimant.
create function rr.payload(p_draft uuid, p_claimant text) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'draft_id', p_draft, 'brief', jsonb_build_object('v', 1), 'brief_hash', 'sha256:' || repeat('c', 64),
    'runtime', 'sandbox', 'claimant', p_claimant, 'lint', jsonb_build_object('ok', true),
    'claim_ids', jsonb_build_array(md5('rr:c-sourced')::uuid), 'submit', true,
    'content', jsonb_build_object(
      'title', 'How long do solar batteries last?', 'slug', 'how-long-do-solar-batteries-last',
      'meta_title', 'How Long Do Solar Batteries Last?', 'meta_description', 'What wears a home battery out and what a warranty covers.',
      'h1', 'How long do solar batteries last?', 'outline', '[{"level": 2, "heading": "What wears a battery out"}]'::jsonb,
      'body_markdown', '## What wears a battery out' || chr(10) || repeat('Heat and deep cycles age the cells. ', 60),
      'internal_links', '[{"url": "https://reserve-solar.example.test/services/solar-install", "anchor": "solar installation"}]'::jsonb,
      'cta', '{"text": "Request a quote", "url": "https://reserve-solar.example.test/contact"}'::jsonb))
$$;
grant execute on all functions in schema rr to anon, authenticated, service_role, authenticator, postgres;

-- ── Fixtures (fictional) ────────────────────────────────────────────────────
insert into clients (id, name, city, state, status) values (rr.id('a'), 'Reserve Solar', 'Neosho', 'MO', 'active');
insert into services (id, client_id, name, status) values (rr.id('svc'), rr.id('a'), 'Solar Install', 'approved');
insert into keywords (id, client_id, keyword, intent, service_id) values
  (rr.id('kw'), rr.id('a'), 'how long do solar batteries last', 'informational', rr.id('svc'));
insert into claims (id, client_id, claim, status, source) values
  (rr.id('c-sourced'), rr.id('a'), 'NABCEP certified installers', 'sourced', 'https://nabcep.example.test/2');
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent, keyword_id, service_id, planned_date)
select rr.id('i-' || k), rr.id('a'), date '2026-10-19', 'blog', null, 'educational', 'Solar batteries ' || k, 'informational', rr.id('kw'), rr.id('svc'), null
  from unnest(array['routine', 'reserved', 'badlabel', 'reuse', 'expired']) k;
\o

\c - postgres
\o /dev/null
select rr.ok('F0 the sandbox has Routine credentials, so a fire is recorded when it happens',
  exists (select 1 from vault.secrets where name = 'ROUTINE_FIRE_URL') and exists (select 1 from vault.secrets where name = 'ROUTINE_FIRE_TOKEN'));
\o

-- ── A teammate presses Generate draft ───────────────────────────────────────
\c - authenticator
set role authenticated;
select rr.as_user('authenticated', :'team');
\o /dev/null
do $$
declare r jsonb;
begin
  -- Unset: exactly as before.
  r := content_draft_request(rr.id('i-routine'));
  perform rr.save('routine', r->>'draft_id');
  perform rr.ok('R1 unset: the request task opens unclaimed, as before',
    (rr.task('routine')).claimed_by is null and (rr.task('routine')).claimed_at is null
    and (rr.task('routine')).status::text = 'open' and not (r->>'reused')::boolean and r->>'reserved_for' is null, r::text);

  -- Reserved for an operator.
  r := content_draft_request(rr.id('i-reserved'), null, 'Claude writes this one from chat', ' claude-operator ');
  perform rr.save('reserved', r->>'draft_id');
  perform rr.ok('R2 reserved: the task is claimed for the label at request time and in progress',
    (rr.task('reserved')).claimed_by = 'claude-operator' and (rr.task('reserved')).status::text = 'in_progress'
    and (rr.task('reserved')).claimed_at > now() - interval '1 minute', r::text);
  perform rr.ok('R3 the answer says who holds it and until when (the claim''s hour)',
    r->>'reserved_for' = 'claude-operator' and not (r->>'reused')::boolean
    and (r->>'expires_at')::timestamptz = (r->>'claimed_at')::timestamptz + interval '1 hour'
    and (r->>'task_id')::uuid = (rr.task('reserved')).id, r::text);
  perform rr.ok('R4 the request task''s notes record the reservation; the teammate''s note is on the draft',
    (rr.task('reserved')).notes like '%Reserved for claude-operator at request time%'
    and (select request_note from content_drafts where id = rr.get('reserved')::uuid) = 'Claude writes this one from chat');

  -- Labels.
  perform rr.ok('L1 a label is short, lowercase letters, digits and dashes',
    rr.try(format('select content_draft_request(%L, null, null, %L)', rr.id('i-badlabel'), 'Claude Operator')) like '22023%Reserve for takes a short label%'
    and rr.try(format('select content_draft_request(%L, null, null, %L)', rr.id('i-badlabel'), 'x')) like '22023%'
    and rr.try(format('select content_draft_request(%L, null, null, %L)', rr.id('i-badlabel'), repeat('a', 41))) like '22023%'
    and rr.try(format('select content_draft_request(%L, null, null, %L)', rr.id('i-badlabel'), 'op;drop')) like '22023%');
  perform rr.ok('L2 the Routine''s own label is not a reservation (leave it empty)',
    rr.try(format('select content_draft_request(%L, null, null, %L)', rr.id('i-badlabel'), 'worker-routine')) like '22023%Leave Reserve for empty%');
  perform rr.ok('L3 a refused label creates nothing', rr.drafts('badlabel') = 0);
  r := content_draft_request(rr.id('i-badlabel'), null, null, '  ');
  perform rr.save('badlabel', r->>'draft_id');
  perform rr.ok('L4 a blank label is unset (the Routine)', (rr.task('badlabel')).claimed_by is null, r::text);

  perform rr.ok('G1 a teammate still cannot claim or set a claim directly',
    rr.try(format('select content_draft_claim(%L, ''me'')', rr.get('routine'))) like '42501%'
    and rr.try(format('update tasks set claimed_by = ''me'' where id = %L', (rr.task('routine')).id)) like '42501%');
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o /dev/null
do $$
begin
  perform rr.ok('F1 unset fires the worker Routine, as before', rr.fires('routine') = 1, rr.fires('routine')::text);
  perform rr.ok('F2 reserved does not fire the worker Routine', rr.fires('reserved') = 0, rr.fires('reserved')::text);
end $$;
\o

-- ── The race, replayed: a Routine run started by anything else ──────────────
\c - postgres
\o /dev/null
do $$
declare r jsonb;
begin
  r := content_draft_claim(rr.get('reserved')::uuid, 'worker-routine');
  perform rr.ok('C1 the Routine''s claim is refused: claimed_by_other, told who holds it and until when',
    not (r->>'claimed')::boolean and r->>'reason' = 'claimed_by_other' and r->>'claimed_by' = 'claude-operator'
    and r->>'expires_at' is not null and (rr.task('reserved')).claimed_by = 'claude-operator', r::text);
  r := content_draft_claim(rr.get('reserved')::uuid, 'claude-operator');
  perform rr.ok('C2 the operator claims it with the same label (refreshing the hour)',
    (r->>'claimed')::boolean and (rr.task('reserved')).claimed_by = 'claude-operator', r::text);
end $$;
\o

\c - authenticator
set role service_role;
select rr.as_user('service_role', null);
\o /dev/null
do $$
declare r jsonb; e text;
begin
  e := rr.try(format('select content_draft_write(%L::jsonb)', rr.payload(rr.get('reserved')::uuid, 'worker-routine')));
  perform rr.ok('W1 the Routine''s write is refused (CD409 claimed_by_other), nothing written',
    e like 'CD409%claimed_by_other%claude-operator%'
    and (select status = 'requested' and title is null from content_drafts where id = rr.get('reserved')::uuid), e);
  r := content_draft_write(rr.payload(rr.get('reserved')::uuid, 'claude-operator'));
  perform rr.ok('W2 the operator writes it: in review, the request task done',
    r->>'status' = 'in_review' and (rr.task('reserved')).status::text = 'done', r::text);
  r := content_draft_write(rr.payload(rr.get('routine')::uuid, null));
  perform rr.ok('W3 an unreserved request writes exactly as before (no claimant needed)',
    r->>'status' = 'in_review' and (rr.task('routine')).claimed_by is null, r::text);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── A second Generate on a request that already exists ──────────────────────
\c - authenticator
set role authenticated;
select rr.as_user('authenticated', :'team');
\o /dev/null
select rr.save('reuse', content_draft_request(rr.id('i-reuse'))->>'draft_id');
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- Forget the first fire so the next checks are not hidden by the two-minute debounce.
\c - supabase_admin
delete from worker_fires where reason = 'Content draft request ' || rr.get('reuse');

\c - authenticator
set role authenticated;
select rr.as_user('authenticated', :'team');
\o /dev/null
do $$
declare r jsonb; e text;
begin
  r := content_draft_request(rr.id('i-reuse'), null, null, 'claude-operator');
  perform rr.ok('U1 reserving an existing request claims its task; same draft, reused',
    (r->>'reused')::boolean and r->>'draft_id' = rr.get('reuse') and r->>'reserved_for' = 'claude-operator'
    and (rr.task('reuse')).claimed_by = 'claude-operator' and (rr.task('reuse')).status::text = 'in_progress', r::text);
  e := rr.try(format('select content_draft_request(%L, null, null, %L)', rr.id('i-reuse'), 'operator-td'));
  perform rr.ok('U2 another label is refused while the reservation is live (CD409), nothing changed',
    e like 'CD409%claimed_by_other%claude-operator%' and (rr.task('reuse')).claimed_by = 'claude-operator', e);
  r := content_draft_request(rr.id('i-reuse'), null, null, 'claude-operator');
  perform rr.ok('U3 the same label re-reserves (refreshes)', (r->>'reused')::boolean and r->>'reserved_for' = 'claude-operator', r::text);
  perform rr.ok('U4 a reused request still has one draft', rr.drafts('reuse') = 1);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o /dev/null
select rr.ok('U5 reserving an existing request does not fire', rr.fires('reuse') = 0, rr.fires('reuse')::text);
\o

\c - authenticator
set role authenticated;
select rr.as_user('authenticated', :'team');
\o /dev/null
do $$
declare r jsonb;
begin
  r := content_draft_request(rr.id('i-reuse'));
  perform rr.ok('U6 an unset second Generate behaves as before (reused) and leaves the reservation alone',
    (r->>'reused')::boolean and r->>'reserved_for' is null and (rr.task('reuse')).claimed_by = 'claude-operator', r::text);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o /dev/null
select rr.ok('U7 ... and fires the Routine as before (its claim is then refused until the hour is up)', rr.fires('reuse') = 1, rr.fires('reuse')::text);
\o

-- ── A reservation nobody acted on ───────────────────────────────────────────
\c - authenticator
set role authenticated;
select rr.as_user('authenticated', :'team');
\o /dev/null
select rr.save('expired', content_draft_request(rr.id('i-expired'), null, null, 'claude-operator')->>'draft_id');
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- Age it past the hour; fixtures only.
\c - supabase_admin
update tasks set claimed_at = now() - interval '61 minutes' where id = (rr.task('expired')).id;

\c - postgres
\o /dev/null
do $$
declare r jsonb;
begin
  r := content_draft_claim(rr.get('expired')::uuid, 'worker-routine');
  perform rr.ok('E1 after the hour the request is anyone''s: the sweep''s Routine takes it',
    (r->>'claimed')::boolean and (rr.task('expired')).claimed_by = 'worker-routine', r::text);
end $$;
\o

-- ── Signature and access ────────────────────────────────────────────────────
\c - supabase_admin
\o /dev/null
select rr.ok('S1 one content_draft_request: the four-argument function, a teammate''s only',
  to_regprocedure('public.content_draft_request(uuid, text, text)') is null
  and (select count(*) from pg_proc where proname = 'content_draft_request' and pronamespace = 'public'::regnamespace) = 1
  and has_function_privilege('authenticated', 'public.content_draft_request(uuid, text, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.content_draft_request(uuid, text, text, text)', 'execute')
  and (select prosecdef and proconfig @> array['search_path=public, pg_temp'] from pg_proc
        where oid = 'public.content_draft_request(uuid, text, text, text)'::regprocedure));
\o

\c - authenticator
set role anon;
select rr.as_user('anon', null);
\o /dev/null
select rr.ok('S2 anon cannot request (or reserve)',
  rr.try(format('select content_draft_request(%L, null, null, %L)', rr.id('i-badlabel'), 'claude-operator')) like '42501%');
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o
\pset footer off
select status, count(*) from rr.results group by status order by status;
select n, status, name, detail from rr.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from rr.results where status = 'fail';
  if f > 0 then raise exception '% reserve draft request check(s) failed', f; end if;
end $$;
