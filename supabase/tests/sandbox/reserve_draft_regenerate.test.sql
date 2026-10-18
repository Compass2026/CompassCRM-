-- Tests for 20261018230000 (Reserve for on content_draft_regenerate), run by
-- scripts/test-portal-sandbox.sh on the same replay, after
-- reserve_draft_requests. Own harness schema (rg) and fictional clients.
--
-- A teammate sends a draft or a rejected draft back, reserving the redraft for
-- an operator session: the worker is not fired, and a Routine run started by
-- anything else is refused at the claim and at the write. Unset, Regenerate
-- does exactly what 0067 did.
--
-- Callers, as they reach production:
--   person   authenticator, role authenticated, team JWT
--   drafter  authenticator, role service_role (the content-drafter function)
--   worker   postgres (the worker's own SQL; an operator session uses the same)

\set team   '00000000-0000-4000-a000-000000000001'

\c - supabase_admin
\o /dev/null
create schema rg;
create table rg.results (n serial, status text, name text, detail text);
create table rg.saved (k text primary key, v text);
grant usage on schema rg to anon, authenticated, service_role, authenticator, postgres;
grant insert, select on rg.results to anon, authenticated, service_role, authenticator, postgres;
grant insert, select, update on rg.saved to anon, authenticated, service_role, authenticator, postgres;
grant usage on sequence rg.results_n_seq to anon, authenticated, service_role, authenticator, postgres;
create function rg.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into rg.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function rg.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function rg.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function rg.id(p_k text) returns uuid language sql immutable as $$ select md5('rg:' || p_k)::uuid $$;
create function rg.save(p_k text, p_v text) returns void language sql as $$
  insert into rg.saved values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function rg.get(p_k text) returns text language sql stable as $$ select v from rg.saved where k = p_k $$;
create function rg.draft(p_k text) returns content_drafts language sql stable as $$
  select * from content_drafts where id = rg.get(p_k)::uuid
$$;
-- The draft's request task (the one Regenerate points at).
create function rg.task(p_k text) returns tasks language sql stable as $$
  select t.* from tasks t join content_drafts d on t.id = coalesce(d.request_task_id, d.source_task_id) where d.id = rg.get(p_k)::uuid
$$;
create function rg.open_tasks(p_k text) returns bigint language sql stable as $$
  select count(*) from tasks where key = 'content_draft:' || rg.get(p_k) and status <> 'done'
$$;
-- Fires recorded for a draft (fire_foundation_worker logs one per real fire).
create function rg.fires(p_k text) returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select count(*) from worker_fires where reason = 'Content draft request ' || rg.get(p_k)
$$;
-- A written draft as the content-drafter function sends it, with its claimant.
create function rg.payload(p_draft uuid, p_claimant text, p_submit boolean default true) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'draft_id', p_draft, 'brief', jsonb_build_object('v', 1), 'brief_hash', 'sha256:' || repeat('d', 64),
    'runtime', 'sandbox', 'claimant', p_claimant, 'lint', jsonb_build_object('ok', true),
    'claim_ids', jsonb_build_array(md5('rg:c-sourced')::uuid), 'submit', p_submit,
    'content', jsonb_build_object(
      'title', 'When should a water heater be replaced?', 'slug', 'when-to-replace-a-water-heater',
      'meta_title', 'When Should a Water Heater Be Replaced?', 'meta_description', 'The signs a tank is near the end and what a replacement involves.',
      'h1', 'When should a water heater be replaced?', 'outline', '[{"level": 2, "heading": "Signs a tank is failing"}]'::jsonb,
      'body_markdown', '## Signs a tank is failing' || chr(10) || repeat('Rust, noise and leaks mean the tank is near the end. ', 50),
      'internal_links', '[{"url": "https://regen-plumbing.example.test/services/water-heaters", "anchor": "water heater service"}]'::jsonb,
      'cta', '{"text": "Book a visit", "url": "https://regen-plumbing.example.test/contact"}'::jsonb))
$$;
grant execute on all functions in schema rg to anon, authenticated, service_role, authenticator, postgres;

-- ── Fixtures (fictional) ────────────────────────────────────────────────────
insert into clients (id, name, city, state, status) values (rg.id('a'), 'Regen Plumbing', 'Carthage', 'MO', 'active');
insert into services (id, client_id, name, status) values (rg.id('svc'), rg.id('a'), 'Water Heaters', 'approved');
insert into keywords (id, client_id, keyword, intent, service_id) values
  (rg.id('kw'), rg.id('a'), 'when to replace a water heater', 'informational', rg.id('svc'));
insert into claims (id, client_id, claim, status, source) values
  (rg.id('c-sourced'), rg.id('a'), 'Licensed master plumbers', 'sourced', 'https://license.example.test/3');
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent, keyword_id, service_id, planned_date)
select rg.id('i-' || k), rg.id('a'), date '2026-10-19', 'blog', null, 'educational', 'Water heaters ' || k, 'informational', rg.id('kw'), rg.id('svc'), null
  from unnest(array['routine', 'rejected', 'draft', 'badlabel', 'conflict', 'expired']) k;
\o

-- ── Each item gets a written draft: requested, then written ─────────────────
\c - authenticator
set role authenticated;
select rg.as_user('authenticated', :'team');
\o /dev/null
select rg.save(k, content_draft_request(rg.id('i-' || k))->>'draft_id')
  from unnest(array['routine', 'rejected', 'draft', 'badlabel', 'conflict', 'expired']) k;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role service_role;
select rg.as_user('service_role', null);
\o /dev/null
select content_draft_write(rg.payload(rg.get(k)::uuid, null, k <> 'draft'))
  from unnest(array['routine', 'rejected', 'draft', 'badlabel', 'conflict', 'expired']) k;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- The reviewer rejects the submitted ones; 'draft' stays a draft (written, not submitted).
\c - authenticator
set role authenticated;
select rg.as_user('authenticated', :'team');
\o /dev/null
update content_drafts set status = 'rejected', review_note = 'Lead with the warning signs'
 where client_id = rg.id('a') and status = 'in_review';
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- Forget the request fires so the regenerate fires are not hidden by the
-- two-minute debounce; give 'conflict' an open request task another operator
-- holds (fixtures only).
\c - supabase_admin
\o /dev/null
delete from worker_fires where client_id = rg.id('a');
insert into tasks (client_id, title, notes, owner, key, status, claimed_by, claimed_at)
values (rg.id('a'), 'Redraft: Water heaters conflict', 'Held by another operator', 'CLAUDE', 'content_draft:' || rg.get('conflict'),
        'in_progress', 'operator-td', now());
\o

\c - postgres
\o /dev/null
select rg.ok('F0 the drafts are written and reviewed, nothing fired yet, and the Routine has credentials',
  (select count(*) from content_drafts where client_id = rg.id('a') and status = 'rejected') = 5
  and (rg.draft('draft')).status = 'draft'
  and (select count(*) from worker_fires where client_id = rg.id('a')) = 0
  and exists (select 1 from vault.secrets where name = 'ROUTINE_FIRE_URL'));
\o

-- ── A teammate presses Regenerate ───────────────────────────────────────────
\c - authenticator
set role authenticated;
select rg.as_user('authenticated', :'team');
\o /dev/null
do $$
declare r jsonb; e text;
begin
  -- Unset: exactly 0067.
  r := content_draft_regenerate(rg.get('routine')::uuid, 'Shorter intro');
  perform rg.ok('P1 unset: back to requested with the note, a new unclaimed Redraft task, 0067''s answer',
    (rg.draft('routine')).status = 'requested' and (rg.draft('routine')).request_note = 'Shorter intro'
    and (rg.task('routine')).id = (r->>'task_id')::uuid and (rg.task('routine')).status::text = 'open'
    and (rg.task('routine')).claimed_by is null and (rg.task('routine')).claimed_at is null
    and (rg.task('routine')).title = 'Redraft: Water heaters routine'
    and (rg.task('routine')).notes = format('Content draft request %s (regenerate). Teammate''s note: Shorter intro', rg.get('routine'))
    and r = jsonb_build_object('draft_id', rg.get('routine')::uuid, 'task_id', (rg.task('routine')).id), r::text);

  -- Reserved, from rejected.
  r := content_draft_regenerate(rg.get('rejected')::uuid, 'Claude redrafts this from chat', ' claude-operator ');
  perform rg.ok('R1 reserved (rejected): back to requested, the new task claimed for the label and in progress',
    (rg.draft('rejected')).status = 'requested' and (rg.draft('rejected')).request_note = 'Claude redrafts this from chat'
    and (rg.task('rejected')).claimed_by = 'claude-operator' and (rg.task('rejected')).status::text = 'in_progress'
    and (rg.task('rejected')).claimed_at > now() - interval '1 minute' and rg.open_tasks('rejected') = 1, r::text);
  perform rg.ok('R2 the answer says who holds it and until when (the claim''s hour)',
    r->>'reserved_for' = 'claude-operator' and (r->>'task_id')::uuid = (rg.task('rejected')).id
    and (r->>'expires_at')::timestamptz = (r->>'claimed_at')::timestamptz + interval '1 hour', r::text);
  perform rg.ok('R3 the Redraft task''s notes record the reservation after the teammate''s note',
    (rg.task('rejected')).notes = format('Content draft request %s (regenerate). Teammate''s note: Claude redrafts this from chat', rg.get('rejected'))
      || ' Reserved for claude-operator at request time: the worker Routine was not fired, and the claim binds for an hour.',
    (rg.task('rejected')).notes);

  -- Reserved, from draft.
  r := content_draft_regenerate(rg.get('draft')::uuid, null, 'claude-operator');
  perform rg.ok('R4 reserved (draft): the same, and an empty note keeps the earlier request note',
    (rg.draft('draft')).status = 'requested' and (rg.task('draft')).claimed_by = 'claude-operator'
    and (rg.draft('draft')).request_note is null
    and (rg.task('draft')).notes like '%Teammate''s note: —%Reserved for claude-operator%', r::text);

  -- Labels.
  perform rg.ok('L1 a label is short, lowercase letters, digits and dashes',
    rg.try(format('select content_draft_regenerate(%L, null, %L)', rg.get('badlabel'), 'Claude Operator')) like '22023%Reserve for takes a short label%'
    and rg.try(format('select content_draft_regenerate(%L, null, %L)', rg.get('badlabel'), 'x')) like '22023%'
    and rg.try(format('select content_draft_regenerate(%L, null, %L)', rg.get('badlabel'), repeat('a', 41))) like '22023%'
    and rg.try(format('select content_draft_regenerate(%L, null, %L)', rg.get('badlabel'), 'op;drop')) like '22023%');
  perform rg.ok('L2 the Routine''s own label is not a reservation (leave it empty)',
    rg.try(format('select content_draft_regenerate(%L, null, %L)', rg.get('badlabel'), 'worker-routine')) like '22023%Leave Reserve for empty%');
  perform rg.ok('L3 a refused label changes nothing: still rejected, no Redraft task',
    (rg.draft('badlabel')).status = 'rejected' and rg.open_tasks('badlabel') = 0);
  r := content_draft_regenerate(rg.get('badlabel')::uuid, null, '  ');
  perform rg.ok('L4 a blank label is unset (the Routine)',
    (rg.draft('badlabel')).status = 'requested' and (rg.task('badlabel')).claimed_by is null and r->>'reserved_for' is null, r::text);

  -- Another label holds the draft's open task.
  e := rg.try(format('select content_draft_regenerate(%L, %L, %L)', rg.get('conflict'), 'Mine now', 'claude-operator'));
  perform rg.ok('K1 another label''s live claim refuses the reservation (CD409, who and until when)',
    e like 'CD409%claimed_by_other: operator-td holds this request until%', e);
  perform rg.ok('K2 ... and nothing changed: still rejected with its note, the claim untouched',
    (rg.draft('conflict')).status = 'rejected' and (rg.draft('conflict')).request_note is distinct from 'Mine now'
    and (select claimed_by = 'operator-td' from tasks where key = 'content_draft:' || rg.get('conflict') and status <> 'done'));
  r := content_draft_regenerate(rg.get('conflict')::uuid);
  perform rg.ok('K3 unset regenerates as 0067 did: reuses the open task, leaves its claim alone',
    (rg.draft('conflict')).status = 'requested' and rg.open_tasks('conflict') = 1
    and (rg.task('conflict')).claimed_by = 'operator-td' and (rg.task('conflict')).notes = 'Held by another operator', r::text);

  -- Status.
  perform rg.ok('S0 a requested draft is not regenerated, reserved or not',
    rg.try(format('select content_draft_regenerate(%L, null, %L)', rg.get('routine'), 'claude-operator')) like '22023%Withdraw or reopen%'
    and rg.try(format('select content_draft_regenerate(%L)', rg.get('routine'))) like '22023%Withdraw or reopen%');

  perform rg.ok('G1 a teammate still cannot claim or set a claim directly',
    rg.try(format('select content_draft_claim(%L, ''me'')', rg.get('routine'))) like '42501%'
    and rg.try(format('update tasks set claimed_by = ''me'' where id = %L', (rg.task('routine')).id)) like '42501%');
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o /dev/null
do $$
begin
  perform rg.ok('F1 unset regenerate fires the worker Routine, as before',
    rg.fires('routine') = 1 and rg.fires('badlabel') = 1 and rg.fires('conflict') = 1,
    format('%s %s %s', rg.fires('routine'), rg.fires('badlabel'), rg.fires('conflict')));
  perform rg.ok('F2 reserved regenerate does not fire, and a refused one fired nothing first',
    rg.fires('rejected') = 0 and rg.fires('draft') = 0,
    format('%s %s', rg.fires('rejected'), rg.fires('draft')));
end $$;
\o

-- ── The race: a Routine run started by anything else ────────────────────────
\c - postgres
\o /dev/null
do $$
declare r jsonb;
begin
  r := content_draft_claim(rg.get('rejected')::uuid, 'worker-routine');
  perform rg.ok('C1 the Routine''s claim on the redraft is refused: claimed_by_other',
    not (r->>'claimed')::boolean and r->>'reason' = 'claimed_by_other' and r->>'claimed_by' = 'claude-operator', r::text);
  r := content_draft_claim(rg.get('rejected')::uuid, 'claude-operator');
  perform rg.ok('C2 the operator claims it with the same label', (r->>'claimed')::boolean, r::text);
end $$;
\o

\c - authenticator
set role service_role;
select rg.as_user('service_role', null);
\o /dev/null
do $$
declare r jsonb; e text;
begin
  e := rg.try(format('select content_draft_write(%L::jsonb)', rg.payload(rg.get('rejected')::uuid, 'worker-routine')));
  perform rg.ok('W1 the Routine''s write is refused (CD409), the draft still requested',
    e like 'CD409%claimed_by_other%claude-operator%' and (rg.draft('rejected')).status = 'requested', e);
  r := content_draft_write(rg.payload(rg.get('rejected')::uuid, 'claude-operator'));
  perform rg.ok('W2 the operator writes the redraft: in review, the Redraft task done',
    r->>'status' = 'in_review' and (rg.task('rejected')).status::text = 'done', r::text);
  r := content_draft_write(rg.payload(rg.get('routine')::uuid, null));
  perform rg.ok('W3 an unreserved redraft writes exactly as before (no claimant needed)',
    r->>'status' = 'in_review' and (rg.task('routine')).claimed_by is null, r::text);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── A reservation nobody acted on ───────────────────────────────────────────
\c - authenticator
set role authenticated;
select rg.as_user('authenticated', :'team');
\o /dev/null
select content_draft_regenerate(rg.get('expired')::uuid, null, 'claude-operator');
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - supabase_admin
update tasks set claimed_at = now() - interval '61 minutes' where id = (rg.task('expired')).id;

\c - postgres
\o /dev/null
do $$
declare r jsonb;
begin
  r := content_draft_claim(rg.get('expired')::uuid, 'worker-routine');
  perform rg.ok('E1 after the hour the redraft is anyone''s: the sweep''s Routine takes it',
    (r->>'claimed')::boolean and (rg.task('expired')).claimed_by = 'worker-routine', r::text);
end $$;
\o

-- ── Signature and access ────────────────────────────────────────────────────
\c - supabase_admin
\o /dev/null
select rg.ok('S1 one content_draft_regenerate: the three-argument function, a teammate''s only',
  to_regprocedure('public.content_draft_regenerate(uuid, text)') is null
  and (select count(*) from pg_proc where proname = 'content_draft_regenerate' and pronamespace = 'public'::regnamespace) = 1
  and has_function_privilege('authenticated', 'public.content_draft_regenerate(uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.content_draft_regenerate(uuid, text, text)', 'execute')
  and not has_function_privilege('public', 'public.content_draft_regenerate(uuid, text, text)', 'execute')
  and (select prosecdef and proconfig @> array['search_path=public, pg_temp'] from pg_proc
        where oid = 'public.content_draft_regenerate(uuid, text, text)'::regprocedure));
\o

\c - authenticator
set role anon;
select rg.as_user('anon', null);
\o /dev/null
select rg.ok('S2 anon cannot regenerate (or reserve)',
  rg.try(format('select content_draft_regenerate(%L, null, %L)', rg.get('badlabel'), 'claude-operator')) like '42501%');
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role service_role;
select rg.as_user('service_role', null);
\o /dev/null
select rg.ok('S3 the drafter (service role) cannot regenerate: a teammate''s call',
  rg.try(format('select content_draft_regenerate(%L, null, %L)', rg.get('badlabel'), 'claude-operator')) like '42501%');
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o
\pset footer off
select status, count(*) from rg.results group by status order by status;
select n, status, name, detail from rg.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from rg.results where status = 'fail';
  if f > 0 then raise exception '% reserve draft regenerate check(s) failed', f; end if;
end $$;
