-- Tests for 20261120210000 part 2 (close a slot as not delivered by
-- decision), run by scripts/test-portal-sandbox.sh on the same replay. Own
-- harness schema (nd) and a fictional client.
--
-- The Nov 20 2026 case, replayed: blog tasks dated before the weekly
-- standard's start, never drafted, and Tom's "no backfill of missed dates".
-- A teammate records the decision; the slots and tasks are kept, neither
-- delivered nor pending, and every sweep skips them while later slots stay
-- eligible.
--
-- Callers: person / stranger (authenticator + authenticated), drafter
-- (authenticator + service_role), worker (postgres).

\set team     '00000000-0000-4000-a000-000000000001'
\set stranger '00000000-0000-4000-a000-000000000014'

\c - supabase_admin
\o /dev/null
create schema nd;
create table nd.results (n serial, status text, name text, detail text);
grant usage on schema nd to anon, authenticated, service_role, authenticator, postgres;
grant insert, select on nd.results to anon, authenticated, service_role, authenticator, postgres;
grant usage on sequence nd.results_n_seq to anon, authenticated, service_role, authenticator, postgres;
create function nd.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into nd.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function nd.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function nd.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function nd.id(p_k text) returns uuid language sql immutable as $$ select md5('nd:' || p_k)::uuid $$;
create function nd.slot(p_k text) returns content_plan_items language sql stable security definer set search_path = public as $$
  select * from content_plan_items where id = nd.id('i-' || p_k)
$$;
create function nd.task(p_k text) returns tasks language sql stable security definer set search_path = public as $$
  select * from tasks where id = nd.id('t-' || p_k)
$$;
create function nd.close(p_reason text, p_task text, p_slot text) returns text language sql as $$
  select nd.try(format('select content_slot_not_delivered(%L, %L, %L)', p_reason,
                       case when p_task is null then null else nd.id('t-' || p_task) end,
                       case when p_slot is null then null else nd.id('i-' || p_slot) end))
$$;
-- The worker skill's Wednesday blog sweep (foundation-worker SKILL.md), verbatim.
create function nd.sweep() returns setof uuid language sql stable security definer set search_path = public as $$
  select t.id from tasks t join clients c on c.id = t.client_id
   where t.key = 'blog_post' and t.status <> 'done' and c.status in ('active', 'launching')
     and not exists (select 1 from content_drafts d where d.source_task_id = t.id and d.status <> 'requested')
     and t.client_id = nd.id('a')
$$;
grant execute on all functions in schema nd to anon, authenticated, service_role, authenticator, postgres;

insert into clients (id, name, city, state, status) values (nd.id('a'), 'Backfill Electric', 'Ballwin', 'MO', 'active');
insert into services (id, client_id, name, status) values (nd.id('svc'), nd.id('a'), 'Residential Electrical', 'approved');
insert into keywords (id, client_id, keyword, intent, service_id) values
  (nd.id('kw'), nd.id('a'), 'why does my breaker trip', 'informational', nd.id('svc'));
-- October slots (before the weekly start), November slots (after it).
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent, keyword_id, service_id,
                                planned_date, standard_key, standard_month, standard_seq)
select nd.id('i-' || k), nd.id('a'), wk, 'blog', null, 'educational', 'Blog · Backfill Electric · ' || k, 'informational', nd.id('kw'), nd.id('svc'),
       d, 'blog_posts', date_trunc('month', d)::date, seq
  from (values ('old1', date '2026-10-12', date '2026-10-16', 1), ('old2', date '2026-10-19', date '2026-10-20', 2),
               ('old3', date '2026-10-19', date '2026-10-23', 3), ('drafted', date '2026-10-26', date '2026-10-27', 4),
               ('delivered', date '2026-10-26', date '2026-10-28', 5),
               ('new', date '2026-11-16', date '2026-11-18', 1), ('ctrl', date '2026-11-16', date '2026-11-20', 2)) v(k, wk, d, seq);
update content_plan_items set hold = 'delivered' where id = nd.id('i-delivered');
insert into tasks (id, client_id, title, owner, key, due_date, status, notes) values
  (nd.id('t-noslot'), nd.id('a'), 'Blog slot 2: governed keyword, sourced article, team review', 'CLAUDE', 'blog_post', date '2026-10-16', 'blocked', null),
  (nd.id('t-old1'), nd.id('a'), 'Blog slot for the client', 'CLAUDE', 'blog_post', date '2026-10-16', 'blocked',
   'plan_item:' || nd.id('i-old1') || ' (monthly delivery standard).'),
  (nd.id('t-old2'), nd.id('a'), 'Blog slot for the client', 'CLAUDE', 'blog_post', date '2026-10-20', 'blocked',
   'plan_item:' || nd.id('i-old2') || ' (monthly delivery standard).'),
  (nd.id('t-new'), nd.id('a'), 'Blog slot for the client', 'CLAUDE', 'blog_post', date '2026-11-18', 'open',
   'plan_item:' || nd.id('i-new') || ' (monthly delivery standard).'),
  (nd.id('t-other'), nd.id('a'), 'Not a slot', 'CLAUDE', 'brand_board', null, 'open', null);
\o

-- A live draft on one October slot (a teammate's Generate).
\c - authenticator
set role authenticated;
select nd.as_user('authenticated', :'team');
\o /dev/null
select content_draft_request(nd.id('i-drafted'));
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Refusals ────────────────────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select nd.as_user('authenticated', :'stranger');
\o /dev/null
select nd.ok('R1 a signed-in non-team user is refused', nd.close('no backfill', 'old1', null) like '42501%', nd.close('no backfill', 'old1', null));
\o
reset role;
select nd.as_user('anon', null);
set role anon;
\o /dev/null
select nd.ok('R2 anon cannot call it', nd.close('no backfill', 'old1', null) like '42501%');
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - authenticator
set role service_role;
select nd.as_user('service_role', null);
\o /dev/null
select nd.ok('R3 the content-drafter function cannot decide', nd.close('no backfill', 'old1', null) like '42501%');
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - postgres
\o /dev/null
select nd.ok('R4 nor the worker''s SQL', nd.close('no backfill', 'old1', null) like '42501%');
select nd.ok('R5 the worker cannot write the decision directly',
  nd.try(format('update content_plan_items set hold = ''blocked'', hold_reason = ''x'', not_delivered_at = now(), not_delivered_reason = ''x'' where id = %L', nd.id('i-new'))) like '42501%');
\o

\c - authenticator
set role authenticated;
select nd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare e text;
begin
  perform nd.ok('R6 a reason is required', nd.close(' ', 'old1', null) like '22023%');
  perform nd.ok('R7 a slot or task is required', nd.close('x', null, null) like '22023%');
  perform nd.ok('R8 only blog / social slot tasks', nd.close('x', 'other', null) like '22023%', nd.close('x', 'other', null));
  perform nd.ok('R9 a task and a slot must agree', nd.close('x', 'old1', 'old2') like '22023%');
  e := nd.close('x', null, 'drafted');
  perform nd.ok('R10 a slot with a live draft is refused (retire the draft first)', e like '23514%draft%', e);
  e := nd.close('x', null, 'delivered');
  perform nd.ok('R11 a delivered slot is refused', e like '23514%delivered%', e);
  e := nd.try(format('update content_plan_items set not_delivered_at = now(), not_delivered_reason = ''x'', hold = ''blocked'', hold_reason = ''x'' where id = %L', nd.id('i-new')));
  perform nd.ok('R12 a teammate cannot write the decision directly', e like '42501%content_slot_not_delivered%', e);
  perform nd.ok('R13 nothing changed', (nd.slot('old1')).not_delivered_at is null and (nd.task('old1')).status::text = 'blocked'
    and (nd.slot('new')).hold is null);
end $$;
\o

-- ── Decide ──────────────────────────────────────────────────────────────────
\o /dev/null
do $$
declare r jsonb; me uuid := (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001');
  rule text := 'Dated before the Nov 9 weekly-standard start; no backfill of missed dates (Tom, task 3ab519f3).';
begin
  r := content_slot_not_delivered(rule, nd.id('t-old1'));
  perform nd.ok('D1 by its task: the slot records the decision (who, when, why) and is held',
    (nd.slot('old1')).not_delivered_at is not null and (nd.slot('old1')).not_delivered_reason = rule
    and (nd.slot('old1')).not_delivered_by = me and (nd.slot('old1')).hold = 'blocked'
    and (nd.slot('old1')).hold_reason = 'Not delivered by decision: ' || rule, r::text);
  perform nd.ok('D2 its task is closed with the decision marker, not as delivered work',
    (nd.task('old1')).status::text = 'done' and (nd.task('old1')).notes like '%not_delivered_by_decision:%neither delivered nor pending%'
    and r->'closed_task_ids' = jsonb_build_array(nd.id('t-old1')), r::text);
  r := content_slot_not_delivered(rule, null, nd.id('i-old2'));
  perform nd.ok('D3 by its slot: the task naming it closes too', (nd.task('old2')).status::text = 'done'
    and (nd.slot('old2')).not_delivered_at is not null, r::text);
  r := content_slot_not_delivered(rule, nd.id('t-noslot'));
  perform nd.ok('D4 a task with no slot is closed the same way', (nd.task('noslot')).status::text = 'done'
    and (nd.task('noslot')).notes like 'not_delivered_by_decision:%' and r->>'plan_item_id' is null, r::text);
  r := content_slot_not_delivered(rule, null, nd.id('i-old3'));
  perform nd.ok('D5 a slot with no task', (nd.slot('old3')).not_delivered_at is not null and r->'closed_task_ids' = '[]'::jsonb, r::text);
  r := content_slot_not_delivered('again', nd.id('t-old1'));
  perform nd.ok('D6 deciding again is a no-op replay', (r->>'replayed')::boolean and (nd.slot('old1')).not_delivered_reason = rule, r::text);
  perform nd.ok('D7 a closed slot-less task is not closed again', nd.close('again', 'noslot', null) like '23514%');
  perform nd.ok('D8 the November slot and its task are untouched',
    (nd.slot('new')).not_delivered_at is null and (nd.slot('new')).hold is null and (nd.task('new')).status::text = 'open');
end $$;
\o

-- ── Terminal ────────────────────────────────────────────────────────────────
\o /dev/null
do $$
declare e text;
begin
  e := nd.try(format('update content_plan_items set hold = null where id = %L', nd.id('i-old1')));
  perform nd.ok('T1 the hold cannot be cleared', e like '23514%not delivered by decision%', e);
  e := nd.try(format('update content_plan_items set topic = ''x'' where id = %L', nd.id('i-old1')));
  perform nd.ok('T2 the slot is not edited', e like '23514%', e);
  e := nd.try(format('delete from content_plan_items where id = %L', nd.id('i-old1')));
  perform nd.ok('T3 nor deleted', e like '23514%history%', e);
  e := nd.try(format('select content_draft_request(%L)', nd.id('i-old1')));
  perform nd.ok('T4 Generate draft refuses it', e like '22023%not delivered by decision%', e);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role service_role;
select nd.as_user('service_role', null);
\o /dev/null
do $$
declare e text;
begin
  e := nd.try(format('select content_draft_open_weekly(%L::jsonb)', jsonb_build_object('task_id', nd.id('t-old1'), 'topic', 'x',
         'search_intent', 'informational', 'keyword_id', nd.id('kw'), 'service_id', nd.id('svc'))));
  perform nd.ok('T5 the weekly opener refuses the closed task', e like '22023%', e);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Neither delivered nor pending; the sweeps skip it, later slots stay ─────
\c - postgres
\o /dev/null
do $$
declare n int;
begin
  perform nd.ok('A1 the planner board shows the decision',
    (select status from content_plan_board where id = nd.id('i-old1')) = 'not_delivered'
    and (select status from content_plan_board where id = nd.id('i-new')) <> 'not_delivered');
  perform nd.ok('A2 delivery accounting: not done, counted as retired (no credit, no open slot)',
    (select not done and retired from delivery_items(nd.id('a'), date '2026-10-01', date '2026-10-31') where plan_item_id = nd.id('i-old1'))
    and (select not retired from delivery_items(nd.id('a'), date '2026-11-01', date '2026-11-30') where plan_item_id = nd.id('i-new')));
  perform nd.ok('A3 the monthly card counts it in neither completed nor planned',
    (select (length(prosrc) - length(replace(prosrc, 'pi.not_delivered_at is null', ''))) / length('pi.not_delivered_at is null') = 2
       from pg_proc where oid = 'public.delivery_targets_monthly(uuid,date)'::regprocedure));
  perform nd.ok('A4 the v1 retirement leaves it alone', not delivery_v1_slot_retirable(nd.id('i-old3'), date '2026-10-01'));
  perform nd.ok('A5 the Wednesday sweep: the closed tasks are out, the November task is in',
    not exists (select 1 from nd.sweep() s where s in (nd.id('t-old1'), nd.id('t-old2'), nd.id('t-noslot')))
    and exists (select 1 from nd.sweep() s where s = nd.id('t-new')));
  n := queue_standard_blog_tasks_site(nd.id('a'), null, null, date '2026-11-30');
  perform nd.ok('A6 the blog queue opens no task for a decided slot; an open later slot is still queued',
    n = 1 and not exists (select 1 from tasks where key = 'blog_post' and client_id = nd.id('a') and status <> 'done'
                           and (notes like '%' || nd.id('i-old3') || '%' or notes like '%' || nd.id('i-old1') || '%'))
    and exists (select 1 from tasks where key = 'blog_post' and status = 'open' and notes like '%plan_item:' || nd.id('i-ctrl') || '%'), n::text);
  perform nd.ok('A7 the history is kept: every slot and task still exists',
    (select count(*) from content_plan_items where client_id = nd.id('a')) = 7
    and (select count(*) from tasks where id in (nd.id('t-old1'), nd.id('t-old2'), nd.id('t-noslot'))) = 3);
  perform nd.ok('A8 the RPC and guard are hardened',
    has_function_privilege('authenticated', 'public.content_slot_not_delivered(text,uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.content_slot_not_delivered(text,uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.content_plan_items_decision_guard()', 'execute'));
end $$;
\o

\o
\pset footer off
select status, count(*) from nd.results group by status order by status;
select n, status, name, detail from nd.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from nd.results where status = 'fail';
  if f > 0 then raise exception '% not-delivered check(s) failed', f; end if;
end $$;
