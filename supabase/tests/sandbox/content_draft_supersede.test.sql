-- Tests for 20261120210000 (retire a draft request as superseded), run by
-- scripts/test-portal-sandbox.sh on the same replay. Own harness schema (sx)
-- and fictional clients.
--
-- The Nov 20 2026 case, replayed: two requests repeat a keyword whose draft
-- is already in review. A teammate retires each as superseded by the
-- surviving draft; nothing drafts it again, nothing counts it as delivered,
-- its history stays, and the slot it held is released.
--
-- Callers, as they reach production:
--   person   authenticator, role authenticated, team JWT
--   stranger authenticator, role authenticated, a non-team JWT
--   drafter  authenticator, role service_role (the content-drafter function)
--   worker   postgres (the worker's own SQL)

\set team     '00000000-0000-4000-a000-000000000001'
\set stranger '00000000-0000-4000-a000-000000000014'

\c - supabase_admin
\o /dev/null
create schema sx;
create table sx.results (n serial, status text, name text, detail text);
create table sx.saved (k text primary key, v text);
grant usage on schema sx to anon, authenticated, service_role, authenticator, postgres;
grant insert, select on sx.results to anon, authenticated, service_role, authenticator, postgres;
grant insert, select, update on sx.saved to anon, authenticated, service_role, authenticator, postgres;
grant usage on sequence sx.results_n_seq to anon, authenticated, service_role, authenticator, postgres;
create function sx.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into sx.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function sx.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function sx.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function sx.id(p_k text) returns uuid language sql immutable as $$ select md5('sx:' || p_k)::uuid $$;
create function sx.save(p_k text, p_v text) returns void language sql as $$
  insert into sx.saved values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function sx.get(p_k text) returns text language sql stable as $$ select v from sx.saved where k = p_k $$;
create function sx.d(p_k text) returns content_drafts language sql stable security definer set search_path = public as $$
  select * from content_drafts where id = sx.get(p_k)::uuid
$$;
create function sx.task_of(p_k text) returns tasks language sql stable security definer set search_path = public as $$
  select t.* from tasks t join content_drafts d on t.id = coalesce(d.request_task_id, d.source_task_id) where d.id = sx.get(p_k)::uuid
$$;
create function sx.sup(p_k text, p_by text, p_reason text default 'Duplicate request for the same keyword') returns text
language sql as $$
  select sx.try(format('select content_draft_supersede(%L, %L, %L)', sx.get(p_k), sx.get(p_by), p_reason))
$$;
-- A written draft as the content-drafter function sends it.
create function sx.payload(p_draft uuid, p_submit boolean default true) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'draft_id', p_draft, 'brief', jsonb_build_object('v', 1), 'brief_hash', 'sha256:' || repeat('c', 64),
    'runtime', 'sandbox', 'lint', jsonb_build_object('ok', true),
    'claim_ids', jsonb_build_array(md5('sx:c-sourced')::uuid), 'submit', p_submit,
    'content', jsonb_build_object(
      'title', 'What is a GFCI outlet?', 'slug', 'what-is-a-gfci-outlet',
      'meta_title', 'What Is a GFCI Outlet?', 'meta_description', 'Where a home needs ground-fault protection and why it trips.',
      'h1', 'What is a GFCI outlet?', 'outline', '[{"level": 2, "heading": "What a GFCI does"}]'::jsonb,
      'body_markdown', '## What a GFCI does' || chr(10) || repeat('A GFCI cuts power when current leaks to ground. ', 50),
      'internal_links', '[{"url": "https://sup-electric.example.test/services/residential", "anchor": "residential electrical"}]'::jsonb,
      'cta', '{"text": "Book an electrician", "url": "https://sup-electric.example.test/contact"}'::jsonb))
$$;
grant execute on all functions in schema sx to anon, authenticated, service_role, authenticator, postgres;

-- ── Fixtures (fictional) ────────────────────────────────────────────────────
insert into clients (id, name, city, state, status) values
  (sx.id('a'), 'Supersede Electric', 'Ballwin', 'MO', 'active'),
  (sx.id('b'), 'Other Electric', 'Rolla', 'MO', 'active');
insert into services (id, client_id, name, status) values
  (sx.id('svc'), sx.id('a'), 'Residential Electrical', 'approved'),
  (sx.id('svc-b'), sx.id('b'), 'Residential Electrical', 'approved');
insert into keywords (id, client_id, keyword, intent, service_id) values
  (sx.id('kw'), sx.id('a'), 'what is a gfci outlet', 'informational', sx.id('svc')),
  (sx.id('kw-b'), sx.id('b'), 'what is a gfci outlet', 'informational', sx.id('svc-b'));
insert into claims (id, client_id, claim, status, source) values
  (sx.id('c-sourced'), sx.id('a'), 'GFCI outlets are required near water', 'sourced', 'https://code.example.test/gfci');
-- Plan slots: the survivor's, two duplicates (one never written, one a draft),
-- a delivery-standard v1 slot, and the other client's.
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent, keyword_id, service_id, planned_date)
select sx.id('i-' || k), sx.id('a'), date '2026-11-09', 'blog', null, 'educational', 'GFCI outlets ' || k, 'informational', sx.id('kw'), sx.id('svc'), null
  from unnest(array['survivor', 'dup', 'dupdraft', 'review']) k;
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent, keyword_id, service_id,
                                planned_date, standard_key, standard_month, standard_seq)
values (sx.id('i-std'), sx.id('a'), date '2026-10-26', 'blog', null, 'educational', 'Blog · Supersede Electric · October 2026', 'informational',
        sx.id('kw'), sx.id('svc'), date '2026-10-27', 'blog_posts', date '2026-10-01', 4);
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent, keyword_id, service_id, planned_date)
values (sx.id('i-b'), sx.id('b'), date '2026-11-09', 'blog', null, 'educational', 'GFCI outlets other', 'informational', sx.id('kw-b'), sx.id('svc-b'), null);
-- The weekly blog task (a week with no other open slot).
insert into tasks (id, client_id, title, owner, key, due_date, autonomy_level)
values (sx.id('t-weekly'), sx.id('a'), 'Blog slot: core keyword, sourced article, team review', 'CLAUDE', 'blog_post', date '2026-11-04', 'run_flag');
\o

-- ── A teammate presses Generate draft on each slot ──────────────────────────
\c - authenticator
set role authenticated;
select sx.as_user('authenticated', :'team');
\o /dev/null
do $$
declare k text;
begin
  foreach k in array array['survivor', 'dup', 'dupdraft', 'review', 'std', 'b'] loop
    perform sx.save(k, content_draft_request(sx.id('i-' || k))->>'draft_id');
  end loop;
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── The drafter writes the survivor (in review), one draft and opens the weekly
\c - authenticator
set role service_role;
select sx.as_user('service_role', null);
\o /dev/null
do $$
declare r jsonb;
begin
  r := content_draft_write(sx.payload(sx.get('survivor')::uuid));
  perform sx.ok('F1 the surviving draft is in review', r->>'status' = 'in_review', r::text);
  r := content_draft_write(sx.payload(sx.get('review')::uuid));
  perform sx.ok('F2 a second written draft is in review', r->>'status' = 'in_review', r::text);
  r := content_draft_write(sx.payload(sx.get('dupdraft')::uuid, false));
  perform sx.ok('F3 a duplicate written but not submitted is a draft', r->>'status' = 'draft', r::text);
  r := content_draft_open_weekly(jsonb_build_object('task_id', sx.id('t-weekly'), 'topic', 'What is a GFCI outlet and where homes need one',
         'search_intent', 'informational', 'keyword_id', sx.id('kw'), 'service_id', sx.id('svc')));
  perform sx.save('weekly', r->>'draft_id');
  perform sx.ok('F4 the weekly blog opened a requested draft on its blog_post task', r->>'status' = 'requested' and not (r->>'reused')::boolean, r::text);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── The release: shape, grants ──────────────────────────────────────────────
\c - supabase_admin
\o /dev/null
select sx.ok('S1 superseded is a status, with its own record columns and checks',
  (select pg_get_constraintdef(oid) like '%superseded%' from pg_constraint where conname = 'content_drafts_status_check')
  and exists (select 1 from pg_constraint where conname = 'content_drafts_superseded_fk' and contype = 'f')
  and exists (select 1 from pg_constraint where conname = 'content_drafts_superseded_shape')
  and exists (select 1 from pg_attribute where attrelid = 'content_drafts'::regclass and attname = 'superseded_actor'));
select sx.ok('S2 the RPC is security definer, team-callable, never anon or PUBLIC',
  (select prosecdef from pg_proc where oid = 'public.content_draft_supersede(uuid,uuid,text)'::regprocedure)
  and has_function_privilege('authenticated', 'public.content_draft_supersede(uuid,uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public.content_draft_supersede(uuid,uuid,text)', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                   where p.oid = 'public.content_draft_supersede(uuid,uuid,text)'::regprocedure and a.grantee = 0));
\o

-- ── Refusals: who, what, from where ─────────────────────────────────────────
\c - authenticator
set role authenticated;
select sx.as_user('authenticated', :'stranger');
\o /dev/null
select sx.ok('R1 a signed-in non-team user cannot retire a request', sx.sup('dup', 'survivor') like '42501%', sx.sup('dup', 'survivor'));
\o
reset role;
select sx.as_user('anon', null);
set role anon;
\o /dev/null
select sx.ok('R2 anon cannot call it', sx.sup('dup', 'survivor') like '42501%', sx.sup('dup', 'survivor'));
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role service_role;
select sx.as_user('service_role', null);
\o /dev/null
select sx.ok('R3 the content-drafter function cannot retire a request (a person does)', sx.sup('dup', 'survivor') like '42501%', sx.sup('dup', 'survivor'));
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o /dev/null
select sx.ok('R4 the worker''s own SQL cannot retire a request', sx.sup('dup', 'survivor') like '42501%', sx.sup('dup', 'survivor'));
select sx.ok('R5 the worker cannot write the status or record directly',
  sx.try(format('update content_drafts set status = ''superseded'' where id = %L', sx.get('dup'))) like '42501%');
\o

\c - authenticator
set role authenticated;
select sx.as_user('authenticated', :'team');
\o /dev/null
do $$
declare e text;
begin
  perform sx.ok('R6 a reason is required', sx.sup('dup', 'survivor', '   ') like '22023%', sx.sup('dup', 'survivor', '   '));
  perform sx.ok('R7 a draft never supersedes itself', sx.sup('dup', 'dup') like '22023%', sx.sup('dup', 'dup'));
  perform sx.ok('R8 the survivor is the same client''s', sx.sup('dup', 'b') like '22023%', sx.sup('dup', 'b'));
  e := sx.sup('review', 'survivor');
  perform sx.ok('R9 a draft in review is not retired (withdraw it first)', e like '23514%', e);
  e := sx.try(format('update content_drafts set status = ''superseded'' where id = %L', sx.get('dup')));
  perform sx.ok('R10 a teammate cannot set the status directly', e like '42501%content_draft_supersede%', e);
  e := sx.try(format('update content_drafts set superseded_reason = ''x'' where id = %L', sx.get('dupdraft')));
  perform sx.ok('R11 nor the record fields', e like '42501%', e);
  e := sx.try(format('select content_draft_supersede(%L, %L, %L)', sx.get('dup'), gen_random_uuid(), 'gone'));
  perform sx.ok('R12 an unknown survivor is refused', e like 'P0002%', e);
  perform sx.ok('R13 every refusal left the requests as they were',
    (sx.d('dup')).status = 'requested' and (sx.d('dupdraft')).status = 'draft' and (sx.d('review')).status = 'in_review'
    and (sx.d('dup')).superseded_by is null);
end $$;
\o

-- ── Retire the duplicates ───────────────────────────────────────────────────
\o /dev/null
do $$
declare r jsonb; me uuid := (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001');
  v_task uuid := (sx.task_of('dup')).id;
begin
  r := content_draft_supersede(sx.get('dup')::uuid, sx.get('survivor')::uuid,
         'Duplicate request for the same keyword; superseded by ' || sx.get('survivor') || ' (in review)');
  perform sx.ok('P1 a requested duplicate is retired: superseded, by the survivor, with reason, who and when',
    r->>'status' = 'superseded' and (r->>'superseded_by')::uuid = sx.get('survivor')::uuid and r->>'surviving_status' = 'in_review'
    and (sx.d('dup')).status = 'superseded' and (sx.d('dup')).superseded_by = sx.get('survivor')::uuid
    and (sx.d('dup')).superseded_reason like 'Duplicate request for the same keyword; superseded by %'
    and (sx.d('dup')).superseded_actor = me and (sx.d('dup')).superseded_at is not null, r::text);
  perform sx.ok('P2 its request task is closed with a note that nothing was delivered',
    (select status::text = 'done' and notes like '%request retired%No article was delivered%' from tasks where id = v_task)
    and r->'closed_task_ids' = jsonb_build_array(v_task), r::text);
  perform sx.ok('P3 the history is intact: same row, request, keyword, slot and provenance',
    (sx.d('dup')).topic = 'GFCI outlets dup' and (sx.d('dup')).keyword_id = sx.id('kw') and (sx.d('dup')).plan_item_id = sx.id('i-dup')
    and (sx.d('dup')).request_task_id = v_task and (sx.d('dup')).requested_by = me and (sx.d('dup')).version = 0);
  r := content_draft_supersede(sx.get('dup')::uuid, sx.get('survivor')::uuid, 'again');
  perform sx.ok('P4 retiring again by the same survivor is a no-op replay', (r->>'replayed')::boolean
    and (sx.d('dup')).superseded_reason like 'Duplicate request%', r::text);
  perform sx.ok('P5 retiring again by another draft is refused', sx.sup('dup', 'review') like '23514%', sx.sup('dup', 'review'));
  perform sx.ok('P6 a retired request cannot be a survivor', sx.sup('dupdraft', 'dup') like '22023%', sx.sup('dupdraft', 'dup'));

  r := content_draft_supersede(sx.get('dupdraft')::uuid, sx.get('survivor')::uuid, 'Duplicate request for the same keyword');
  perform sx.ok('P7 a written, unsubmitted draft is retired the same way (its content kept)',
    (sx.d('dupdraft')).status = 'superseded' and (sx.d('dupdraft')).title is not null and (sx.d('dupdraft')).version = 1, r::text);
  r := content_draft_supersede(sx.get('weekly')::uuid, sx.get('survivor')::uuid, 'Duplicate request for the same keyword');
  perform sx.ok('P8 the weekly duplicate is retired; its blog_post task closes (not delivered)',
    (sx.d('weekly')).status = 'superseded'
    and (select status::text = 'done' and notes like '%No article was delivered%' from tasks where id = sx.id('t-weekly')), r::text);
  r := content_draft_supersede(sx.get('std')::uuid, sx.get('survivor')::uuid, 'Duplicate request for the same keyword');
  perform sx.ok('P9 a standard slot''s request is retired', (sx.d('std')).status = 'superseded', r::text);
end $$;
\o

-- ── Terminal for a teammate ─────────────────────────────────────────────────
\o /dev/null
do $$
declare e text;
begin
  e := sx.try(format('select content_draft_regenerate(%L)', sx.get('dupdraft')));
  perform sx.ok('T1 regenerate is refused', e like '22023%', e);
  e := sx.try(format('update content_drafts set status = ''draft'' where id = %L', sx.get('dupdraft')));
  perform sx.ok('T2 no status change (not even back to draft)', e like '23514%closed record%', e);
  e := sx.try(format('update content_drafts set title = ''Edited'' where id = %L', sx.get('dupdraft')));
  perform sx.ok('T3 no edit', e like '23514%', e);
  e := sx.try(format('select content_draft_approve(%L, 1)', sx.get('dupdraft')));
  perform sx.ok('T4 approval is refused', e like '23514%', e);
  e := sx.try(format('insert into content_draft_claims (draft_id, client_id, claim_id) values (%L, %L, %L)',
                     sx.get('dup'), sx.id('a'), sx.id('c-sourced')));
  perform sx.ok('T5 no claims are linked to it', e like '42501%', e);
  e := sx.try(format('delete from content_drafts where id = %L', sx.get('dup')));
  perform sx.ok('T6 a retired request is never deleted', e like '23514%history%', e);
  e := sx.try(format('delete from content_drafts where id = %L', sx.get('survivor')));
  perform sx.ok('T7 nor the draft that replaced it', e like '23514%', e);
  perform sx.ok('T8 all four retired rows still exist',
    (select count(*) from content_drafts where status = 'superseded' and client_id = sx.id('a')) = 4);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Terminal for the worker and the drafter ─────────────────────────────────
\c - postgres
\o /dev/null
do $$
declare r jsonb;
begin
  r := content_draft_claim(sx.get('dup')::uuid, 'worker-routine');
  perform sx.ok('W1 the worker cannot claim a retired request (draft_not_open)',
    not (r->>'claimed')::boolean and r->>'reason' = 'draft_not_open', r::text);
  r := content_draft_claim(sx.get('weekly')::uuid, 'worker-routine');
  perform sx.ok('W2 nor the weekly one', not (r->>'claimed')::boolean, r::text);
  -- The worker skill's sweeps, verbatim (foundation-worker SKILL.md).
  perform sx.ok('W3 the Wednesday blog sweep skips the retired weekly request',
    not exists (select 1 from tasks t join clients c on c.id = t.client_id
                 where t.key = 'blog_post' and t.status <> 'done' and c.status in ('active', 'launching')
                   and not exists (select 1 from content_drafts d where d.source_task_id = t.id and d.status <> 'requested')
                   and t.id = sx.id('t-weekly')));
  perform sx.ok('W4 and would even with the task reopened (its draft is not requested)',
    exists (select 1 from content_drafts d where d.source_task_id = sx.id('t-weekly') and d.status <> 'requested'));
  perform sx.ok('W5 the content draft request sweep skips the retired requests',
    not exists (select 1 from tasks t join clients c on c.id = t.client_id
                  join content_drafts d on d.id = substring(t.key from 15)::uuid
                 where t.key like 'content\_draft:%' and t.status in ('open', 'in_progress') and d.status = 'requested'
                   and c.status not in ('paused', 'offboarded') and d.id in (sx.get('dup')::uuid, sx.get('std')::uuid)));
  perform sx.ok('W6 the worker cannot touch the record', sx.try(format('update content_drafts set status = ''requested'' where id = %L', sx.get('dup'))) like '42501%');
end $$;
\o

\c - authenticator
set role service_role;
select sx.as_user('service_role', null);
\o /dev/null
do $$
declare e text; r jsonb;
begin
  e := sx.try(format('select content_draft_write(%L::jsonb)', sx.payload(sx.get('dup')::uuid)));
  perform sx.ok('D1 the drafter cannot write a retired request', e like '23514%superseded%', e);
  e := sx.try(format('select content_draft_write(%L::jsonb)', sx.payload(sx.get('weekly')::uuid)));
  perform sx.ok('D2 nor the weekly one', e like '23514%', e);
  e := sx.try(format('select content_draft_open_weekly(%L::jsonb)', jsonb_build_object('task_id', sx.id('t-weekly'), 'topic', 'x',
         'search_intent', 'informational', 'keyword_id', sx.id('kw'), 'service_id', sx.id('svc'))));
  perform sx.ok('D3 the weekly opener refuses to reuse a retired request (draft_superseded)', e like '22023%draft_superseded%', e);
  r := content_review_batch(sx.id('a'));
  perform sx.ok('D4 the review queue shows the survivor and none of the retired requests',
    (select bool_or((x->>'id')::uuid = sx.get('survivor')::uuid) and not bool_or(x->>'status' = 'superseded')
       from jsonb_array_elements(r->'drafts') x), r::text);
  perform sx.ok('D5 the survivor is untouched', (sx.d('survivor')).status = 'in_review' and (sx.d('survivor')).superseded_by is null);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── The slot it held is released, never delivered ───────────────────────────
\c - postgres
\o /dev/null
do $$
declare n int;
begin
  perform sx.ok('L1 the planner board no longer shows the slot as drafting',
    (select draft_id is null and status <> 'drafting' from content_plan_board where id = sx.id('i-dup')),
    (select to_jsonb(b)::text from content_plan_board b where id = sx.id('i-dup')));
  perform sx.ok('L2 the survivor''s slot still shows its draft in review',
    (select draft_id = sx.get('survivor')::uuid and status = 'in_review' from content_plan_board where id = sx.id('i-survivor')));
  perform sx.ok('L3 the slot is not delivered in the delivery accounting',
    (select bool_and(not done) from delivery_items(sx.id('a'), date '2026-10-01', date '2026-11-30')
      where plan_item_id in (sx.id('i-dup'), sx.id('i-std'))));
  perform sx.ok('L4 a v1 standard slot released by the retirement is retirable again',
    delivery_v1_slot_retirable(sx.id('i-std'), date '2026-10-01'));
  n := queue_standard_blog_tasks_site(sx.id('a'), null, null, date '2026-10-31');
  perform sx.ok('L5 the monthly queue treats the released standard slot as empty (one new blog task names it)',
    n = 1 and exists (select 1 from tasks where client_id = sx.id('a') and key = 'blog_post' and status = 'open'
                       and notes like '%plan_item:' || sx.id('i-std') || '%'), n::text);
  perform sx.ok('L6 the promotion-hold conflict lists skip retired requests',
    (select prosrc like '%''rejected'', ''superseded''%' from pg_proc where oid = 'public.promotion_hold_conflicts(uuid)'::regprocedure)
    and (select prosrc like '%''rejected'', ''superseded''%' from pg_proc where oid = 'public.promotion_hold_conflict_counts(uuid)'::regprocedure));
  perform sx.ok('L7 the retired weekly task no longer counts as planned blog work against the agreement',
    not exists (select 1 from tasks where id = sx.id('t-weekly') and status <> 'done'));
end $$;
\o

\c - authenticator
set role authenticated;
select sx.as_user('authenticated', :'team');
\o /dev/null
do $$
declare r jsonb;
begin
  r := content_draft_request(sx.id('i-dup'));
  perform sx.ok('L8 Generate draft on the released slot makes a fresh request; the retired one stays',
    not (r->>'reused')::boolean and (r->>'draft_id')::uuid <> sx.get('dup')::uuid and (sx.d('dup')).status = 'superseded', r::text);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o
\pset footer off
select status, count(*) from sx.results group by status order by status;
select n, status, name, detail from sx.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from sx.results where status = 'fail';
  if f > 0 then raise exception '% content draft supersede check(s) failed', f; end if;
end $$;
