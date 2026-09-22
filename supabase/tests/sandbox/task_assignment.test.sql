-- Tests for migration 0043 (task assignment, history, comments), run by
-- scripts/test-portal-sandbox.sh after portal_access.test.sql against the
-- same replay + fixtures. Own harness schema (tk) so the two files stay
-- independent.
--
-- Callers are simulated the way PostgREST does it: SET ROLE to anon /
-- authenticated / service_role with the JWT claims in request.jwt.claims.
-- The worker writes as a caller with no JWT (service role or SQL).

\set team   '00000000-0000-4000-a000-000000000001'
\set team2  '00000000-0000-4000-a000-000000000002'
\set pa     '00000000-0000-4000-a000-000000000011'
\set strngr '00000000-0000-4000-a000-000000000014'
\set ca     '00000000-0000-4000-b000-00000000000a'
\set cb     '00000000-0000-4000-b000-00000000000b'

\o /dev/null
-- ── Harness ─────────────────────────────────────────────────────────────────
create schema tk;
create table tk.results (n serial, status text, name text, detail text);
create table tk.ids (k text primary key, id uuid);
grant usage on schema tk to anon, authenticated, service_role;
grant insert, select on tk.results to anon, authenticated, service_role;
grant select on tk.ids to anon, authenticated, service_role;
grant usage on sequence tk.results_n_seq to anon, authenticated, service_role;

create function tk.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into tk.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
-- null if the statement succeeded, else its SQLSTATE.
create function tk.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate; end $$;
-- rows affected, or -1 if refused.
create function tk.affected(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin execute p_sql; get diagnostics n = row_count; return n;
exception when others then return -1; end $$;
create function tk.cnt(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin execute format('select count(*) from (%s) q', p_sql) into n; return n;
exception when others then return -1; end $$;
create function tk.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function tk.id(p_k text) returns uuid language sql stable as $$ select id from tk.ids where k = p_k $$;
grant execute on all functions in schema tk to anon, authenticated, service_role;

-- ── Fixtures (as postgres) ──────────────────────────────────────────────────
-- A second teammate, the worker's Routine secrets (so a gate task's fire is
-- observable through the pg_net stub) and one worker-created task per client.
insert into auth.users (id, email, email_confirmed_at) values
  (:'team2', 'sandbox-second@compassmarketing.ai', now());
insert into team_members (name, email, role) values ('Second Teammate', 'sandbox-second@compassmarketing.ai', 'member');
insert into tk.ids select 'me', id from team_members where auth_user_id = :'team';
insert into tk.ids select 'second', id from team_members where auth_user_id = :'team2';
select vault.create_secret('https://routine.example.test/fire', 'ROUTINE_FIRE_URL');
select vault.create_secret('not-a-real-token', 'ROUTINE_FIRE_TOKEN');

insert into tk.ids
select 'stage_a', cs.id from client_stages cs join client_pipelines cp on cp.id = cs.client_pipeline_id
where cp.client_id = :'ca' order by cs.id limit 1;
insert into tk.ids
select 'stage_b', cs.id from client_stages cs join client_pipelines cp on cp.id = cs.client_pipeline_id
where cp.client_id = :'cb' order by cs.id limit 1;
insert into tk.ids select 'cycle_b', id from monthly_cycles where client_id = :'cb' limit 1;
-- Pipeline tasks in both lanes: a TOM-lane one a person can pick up, and a
-- CLAUDE-lane one the worker runs.
insert into tk.ids
select 'worker_task_a', t.id from tasks t where t.client_id = :'ca' and t.client_stage_id is not null
  and t.owner = 'TOM' order by t.created_at, t.id limit 1;
insert into tk.ids
select 'claude_task_a', t.id from tasks t where t.client_id = :'ca' and t.client_stage_id is not null
  and t.owner = 'CLAUDE' order by t.created_at, t.id limit 1;

-- ── S. Shape and "nothing changed for existing tasks" ───────────────────────
do $$
begin
  perform tk.ok('S1 assignee_id / created_by / updated_by / updated_at are nullable',
    (select bool_and(is_nullable = 'YES') from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks'
       and column_name in ('assignee_id', 'created_by', 'updated_by', 'updated_at')));
  perform tk.ok('S2 owner and autonomy_level are unchanged (owner NOT NULL default TOM)',
    (select is_nullable = 'NO' and column_default like '''TOM''%' from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks' and column_name = 'owner'));
  perform tk.ok('S3 every existing task is unassigned (no backfill)',
    not exists (select 1 from tasks where assignee_id is not null));
  perform tk.ok('S4 pipeline-created tasks exist for the fixtures (TOM and CLAUDE lanes)',
    tk.id('worker_task_a') is not null and tk.id('claude_task_a') is not null);
  -- Pipeline tasks (created by the enrollment triggers with no JWT).
  -- portal_access.test.sql also writes a task as the team; it is excluded.
  perform tk.ok('S5 pipeline-created tasks carry no human author',
    not exists (select 1 from tasks where client_stage_id is not null and created_by is not null));
  perform tk.ok('S6 each pipeline-created task has a "created" event with no actor',
    (select count(*) from tasks where client_stage_id is not null)
    = (select count(*) from task_events e join tasks t on t.id = e.task_id
       where t.client_stage_id is not null and e.kind = 'created' and e.actor_id is null));
  perform tk.ok('S7 RLS on task_events and task_comments',
    (select bool_and(relrowsecurity) from pg_class where oid in ('public.task_events'::regclass, 'public.task_comments'::regclass)));
  perform tk.ok('S8 anon holds no privilege on the new tables',
    not has_table_privilege('anon', 'public.task_events', 'select,insert,update,delete,truncate')
    and not has_table_privilege('anon', 'public.task_comments', 'select,insert,update,delete,truncate'));
  perform tk.ok('S9 internal task functions are not callable by anon / authenticated',
    not exists (select 1 from pg_proc p where p.proname in ('task_actor', 'tasks_stamp_and_check', 'tasks_record_history', 'task_comments_stamp')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));
  perform tk.ok('S10 existing worker trigger still present',
    exists (select 1 from pg_trigger where tgname = 'tasks_zz_fire_worker' and tgrelid = 'public.tasks'::regclass));
end $$;

-- ── T. A team member works tasks ────────────────────────────────────────────
set role authenticated;
select tk.as_user('authenticated', :'team');
do $$
declare st text; v_task uuid; v_comment uuid; n bigint; r record;
begin
  -- Create, assigned to a teammate, trying to forge created_by.
  insert into tasks (client_id, title, assignee_id, due_date, created_by)
  values ('00000000-0000-4000-b000-00000000000a', 'Call the client about photos', tk.id('second'),
          current_date - 1, tk.id('second'))
  returning id into v_task;
  select * into r from tasks where id = v_task;
  perform tk.ok('T1 team creates an assigned task', r.assignee_id = tk.id('second'));
  perform tk.ok('T2 created_by is the caller, not the forged value', r.created_by = tk.id('me'), r.created_by::text);
  perform tk.ok('T3 owner keeps its default (TOM) and autonomy stays null', r.owner = 'TOM' and r.autonomy_level is null);
  perform tk.ok('T4 creation is recorded with the actor',
    exists (select 1 from task_events where task_id = v_task and kind = 'created' and actor_id = tk.id('me'))
    and exists (select 1 from task_events where task_id = v_task and kind = 'assignee' and to_value = tk.id('second')::text));

  -- Reassign, forging updated_by.
  update tasks set assignee_id = tk.id('me'), updated_by = tk.id('second') where id = v_task;
  select * into r from tasks where id = v_task;
  perform tk.ok('T5 reassign', r.assignee_id = tk.id('me'));
  perform tk.ok('T6 updated_by / updated_at stamped from the caller', r.updated_by = tk.id('me') and r.updated_at is not null);
  perform tk.ok('T7 reassignment recorded from → to',
    exists (select 1 from task_events where task_id = v_task and kind = 'assignee'
            and from_value = tk.id('second')::text and to_value = tk.id('me')::text and actor_id = tk.id('me')));

  -- Unassign.
  update tasks set assignee_id = null where id = v_task;
  perform tk.ok('T8 unassign', (select assignee_id is null from tasks where id = v_task));

  -- The existing completion flow (toggleTaskAction's update).
  update tasks set status = 'done', completed_at = now() where id = v_task;
  perform tk.ok('T9 mark done', (select status = 'done' and completed_at is not null from tasks where id = v_task));
  perform tk.ok('T10 status change recorded',
    exists (select 1 from task_events where task_id = v_task and kind = 'status' and from_value = 'open' and to_value = 'done'));
  update tasks set status = 'open', completed_at = null where id = v_task;
  perform tk.ok('T11 reopen', (select status = 'open' and completed_at is null from tasks where id = v_task));

  -- Comments.
  insert into task_comments (task_id, body, author_id) values (v_task, 'Left a voicemail', tk.id('second'))
  returning id into v_comment;
  perform tk.ok('T12 comment author is the caller, not the forged value',
    (select author_id = tk.id('me') and client_id = '00000000-0000-4000-b000-00000000000a' from task_comments where id = v_comment));
  st := tk.try(format($q$insert into task_comments (task_id, client_id, body) values (%L, %L, 'x')$q$,
                      v_task, '00000000-0000-4000-b000-00000000000b'));
  perform tk.ok('T13 comment naming another client is refused', st = '23514', st);
  st := tk.try($q$insert into task_comments (task_id, body) values (gen_random_uuid(), 'x')$q$);
  perform tk.ok('T14 comment on a missing task is refused', st is not null, st);
  st := tk.try(format($q$insert into task_comments (task_id, body) values (%L, '   ')$q$, v_task));
  perform tk.ok('T15 empty comment is refused', st = '23514', st);
  n := tk.affected(format($q$update task_comments set body = 'edited' where id = %L$q$, v_comment));
  perform tk.ok('T16 comments cannot be edited', n <= 0, n::text);
  n := tk.affected(format($q$delete from task_comments where id = %L$q$, v_comment));
  perform tk.ok('T17 comments cannot be deleted', n <= 0, n::text);

  -- History is trigger-only.
  st := tk.try(format($q$insert into task_events (task_id, client_id, kind) values (%L, %L, 'status')$q$,
                      v_task, '00000000-0000-4000-b000-00000000000a'));
  perform tk.ok('T18 team cannot write history directly', st is not null, st);
  n := tk.affected(format($q$delete from task_events where task_id = %L$q$, v_task));
  perform tk.ok('T19 team cannot delete history', n <= 0, n::text);

  -- Belonging together.
  st := tk.try(format($q$update tasks set client_id = %L where id = %L$q$, '00000000-0000-4000-b000-00000000000b', v_task));
  perform tk.ok('T20 a task cannot move to another client', st = '23514', st);
  st := tk.try(format($q$update tasks set client_stage_id = %L where id = %L$q$, tk.id('stage_b'), v_task));
  perform tk.ok('T21 a task cannot point at another client''s stage', st = '23514', st);
  st := tk.try(format($q$update tasks set monthly_cycle_id = %L where id = %L$q$, tk.id('cycle_b'), v_task));
  perform tk.ok('T22 a task cannot point at another client''s monthly cycle', st = '23514', st);
  st := tk.try(format($q$insert into tasks (client_id, client_stage_id, title) values (%L, %L, 'x')$q$,
                      '00000000-0000-4000-b000-00000000000a', tk.id('stage_b')));
  perform tk.ok('T23 creating a task on another client''s stage is refused', st = '23514', st);
  st := tk.try(format($q$update tasks set client_stage_id = %L where id = %L$q$, tk.id('stage_a'), v_task));
  perform tk.ok('T24 the same client''s stage is accepted', st is null, st);
  st := tk.try(format($q$update tasks set assignee_id = %L where id = %L$q$, '00000000-0000-4000-a000-000000000011', v_task));
  perform tk.ok('T25 assignee must be a team member (a portal user id is refused)', st = '23503', st);
  st := tk.try(format($q$update tasks set assignee_id = gen_random_uuid() where id = %L$q$, v_task));
  perform tk.ok('T26 assignee must exist', st = '23503', st);

  -- A worker-created task in a human lane: a person can pick it up; the
  -- worker fields are left alone.
  update tasks set assignee_id = tk.id('second') where id = tk.id('worker_task_a');
  select * into r from tasks where id = tk.id('worker_task_a');
  perform tk.ok('T27 a TOM-lane pipeline task can be assigned', r.assignee_id = tk.id('second') and r.owner = 'TOM');
  perform tk.ok('T28 assigning a pipeline task leaves created_by empty (worker-created stays worker-created)',
    r.created_by is null);

  -- Team reads everything it wrote.
  perform tk.ok('T29 team reads comments and history',
    tk.cnt(format('select 1 from task_comments where task_id = %L', v_task)) = 1
    and tk.cnt(format('select 1 from task_events where task_id = %L', v_task)) >= 6);
end $$;
reset role;

-- The gate-task fire (0026) still happens when a team member closes one.
do $$
declare v_task uuid;
begin
  insert into tasks (client_id, title, key) values ('00000000-0000-4000-b000-00000000000a', 'Client review', 'client_review')
  returning id into v_task;
  insert into tk.ids values ('gate', v_task);
end $$;
set role authenticated;
select tk.as_user('authenticated', :'team');
update tasks set status = 'done', completed_at = now() where id = tk.id('gate');
reset role;
select tk.ok('T30 closing a client_review task still fires the worker',
  exists (select 1 from worker_fires where client_id = :'ca' and reason = 'client_review done'));

-- ── W. The worker (no JWT) keeps working ────────────────────────────────────
set role service_role;
select tk.as_user('service_role', null);
do $$
declare st text; v_task uuid; r record;
begin
  st := tk.try(format($q$update tasks set status = 'done', completed_at = now(), flagged_for_review = true,
                         recommendation = 'ok' where id = %L$q$, tk.id('worker_task_a')));
  perform tk.ok('W1 worker closes a pipeline task', st is null, st);
  select * into r from tasks where id = tk.id('worker_task_a');
  perform tk.ok('W2 worker update stamps no human (updated_by null)', r.updated_by is null and r.updated_at is not null);
  perform tk.ok('W3 the teammate assignment survives the worker closing it', r.assignee_id = tk.id('second'));
  perform tk.ok('W4 worker status change recorded with no actor',
    exists (select 1 from task_events where task_id = tk.id('worker_task_a') and kind = 'status'
            and to_value = 'done' and actor_id is null));
  insert into tasks (client_id, title, owner, autonomy_level, key)
  values ('00000000-0000-4000-b000-00000000000b', 'Weekly blog post', 'CLAUDE', 'run_flag', 'blog_post')
  returning id into v_task;
  perform tk.ok('W5 worker creates tasks as before, unassigned',
    (select assignee_id is null and created_by is null and owner = 'CLAUDE' from tasks where id = v_task));
  st := tk.try(format($q$insert into task_comments (task_id, body) values (%L, 'x')$q$, v_task));
  perform tk.ok('W6 a comment with no team author is refused', st = '23514', st);
end $$;
reset role;

-- ── L. The CLAUDE lane is the worker's: no human assignee ───────────────────
do $$
begin
  perform tk.ok('L1 tasks_claude_lane_unassigned exists and is validated',
    exists (select 1 from pg_constraint where conname = 'tasks_claude_lane_unassigned'
            and conrelid = 'public.tasks'::regclass and convalidated));
  perform tk.ok('L2 no CLAUDE task carries an assignee',
    not exists (select 1 from tasks where owner = 'CLAUDE' and assignee_id is not null));
end $$;

set role authenticated;
select tk.as_user('authenticated', :'team');
do $$
declare st text; n int; v_task uuid;
begin
  select count(*) into n from task_events where task_id = tk.id('claude_task_a');
  st := tk.try(format($q$update tasks set assignee_id = %L where id = %L$q$, tk.id('me'), tk.id('claude_task_a')));
  perform tk.ok('L3 team cannot assign a CLAUDE pipeline task', st = '23514', st);
  perform tk.ok('L4 the refused assignment leaves the task and its history untouched',
    (select assignee_id is null from tasks where id = tk.id('claude_task_a'))
    and (select count(*) from task_events where task_id = tk.id('claude_task_a')) = n);
  st := tk.try(format($q$insert into tasks (client_id, title, owner, assignee_id) values (%L, 'x', 'CLAUDE', %L)$q$,
                      '00000000-0000-4000-b000-00000000000a', tk.id('me')));
  perform tk.ok('L5 team cannot create a CLAUDE task with an assignee', st = '23514', st);
  st := tk.try(format($q$update tasks set status = 'in_progress', due_date = current_date + 3, notes = 'seen' where id = %L$q$, tk.id('claude_task_a')));
  perform tk.ok('L6 team can still edit a CLAUDE task''s other fields', st is null, st);

  -- CLAUDE_APPROVAL: the hold lane, a person decides — assignable.
  insert into tasks (client_id, title, owner, autonomy_level, recommendation)
  values ('00000000-0000-4000-b000-00000000000a', 'Approve the GBP category change', 'CLAUDE_APPROVAL', 'hold', 'Switch to Plumber')
  returning id into v_task;
  st := tk.try(format($q$update tasks set assignee_id = %L where id = %L$q$, tk.id('second'), v_task));
  perform tk.ok('L7 a CLAUDE_APPROVAL (hold) task can be assigned to the person deciding', st is null, st);
  perform tk.ok('L8 WAITING / DELEGATED tasks can be assigned',
    tk.try(format($q$insert into tasks (client_id, title, owner, assignee_id) values (%L, 'w', 'WAITING', %L)$q$,
                  '00000000-0000-4000-b000-00000000000a', tk.id('me'))) is null
    and tk.try(format($q$insert into tasks (client_id, title, owner, assignee_id) values (%L, 'd', 'DELEGATED', %L)$q$,
                      '00000000-0000-4000-b000-00000000000a', tk.id('me'))) is null);

  -- An assigned human-lane task cannot be pushed into the worker's lane
  -- with its assignee still on it.
  st := tk.try(format($q$update tasks set owner = 'CLAUDE' where id = %L$q$, tk.id('worker_task_a')));
  perform tk.ok('L9 an assigned task cannot move to the CLAUDE lane', st = '23514', st);
  perform tk.ok('L10 ...and keeps its lane and assignee',
    (select owner = 'TOM' and assignee_id = tk.id('second') from tasks where id = tk.id('worker_task_a')));
end $$;
reset role;

-- The worker hands a step to a person by moving the lane (as the skill does
-- for Google ops it cannot reach); then it can be assigned.
set role service_role;
select tk.as_user('service_role', null);
do $$
declare st text;
begin
  st := tk.try(format($q$update tasks set assignee_id = %L where id = %L$q$, tk.id('me'), tk.id('claude_task_a')));
  perform tk.ok('L11 the worker (no JWT) cannot assign a CLAUDE task either', st = '23514', st);
  st := tk.try(format($q$update tasks set status = 'done', completed_at = now() where id = %L$q$, tk.id('claude_task_a')));
  perform tk.ok('L12 the worker closes an unassigned CLAUDE task as before', st is null, st);
  update tasks set status = 'open', completed_at = null, owner = 'TOM', notes = 'handed to Tom: no GBP access'
  where id = tk.id('claude_task_a');
end $$;
reset role;
set role authenticated;
select tk.as_user('authenticated', :'team');
do $$
declare st text;
begin
  st := tk.try(format($q$update tasks set assignee_id = %L where id = %L$q$, tk.id('me'), tk.id('claude_task_a')));
  perform tk.ok('L13 once the worker hands it to the TOM lane, it can be assigned', st is null, st);
  perform tk.ok('L14 the handover and the assignment are both in the history',
    exists (select 1 from task_events where task_id = tk.id('claude_task_a') and kind = 'owner'
            and from_value = 'CLAUDE' and to_value = 'TOM' and actor_id is null)
    and exists (select 1 from task_events where task_id = tk.id('claude_task_a') and kind = 'assignee'
                and to_value = tk.id('me')::text and actor_id = tk.id('me')));
end $$;
reset role;

-- ── P. Portal users, strangers and anon get nothing ─────────────────────────
do $$
declare who record; st text; n bigint; v_task uuid;
begin
  select id into v_task from tasks where client_id = '00000000-0000-4000-b000-00000000000a' limit 1;
  for who in select * from (values
    ('authenticated', '00000000-0000-4000-a000-000000000011', 'portal user of client A'),
    ('authenticated', '00000000-0000-4000-a000-000000000014', 'signed-in stranger'),
    ('anon', null, 'anonymous')) as w(role, sub, label)
  loop
    perform tk.as_user(who.role, who.sub);
    execute format('set local role %I', who.role);
    n := tk.cnt('select 1 from tasks');
    perform tk.ok('P1 ' || who.label || ' sees no tasks', n <= 0, n::text);
    n := tk.cnt('select 1 from task_comments');
    perform tk.ok('P2 ' || who.label || ' sees no comments', n <= 0, n::text);
    n := tk.cnt('select 1 from task_events');
    perform tk.ok('P3 ' || who.label || ' sees no history', n <= 0, n::text);
    n := tk.affected(format($q$update tasks set assignee_id = null, title = 'hijacked' where id = %L$q$, v_task));
    perform tk.ok('P4 ' || who.label || ' cannot update a task', n <= 0, n::text);
    st := tk.try(format($q$insert into task_comments (task_id, body) values (%L, 'hello')$q$, v_task));
    perform tk.ok('P5 ' || who.label || ' cannot comment', st is not null, st);
    st := tk.try($q$insert into tasks (client_id, title) values ('00000000-0000-4000-b000-00000000000a', 'x')$q$);
    perform tk.ok('P6 ' || who.label || ' cannot create a task', st is not null, st);
    reset role;
  end loop;
  perform tk.ok('P7 no task was renamed by the attempts', not exists (select 1 from tasks where title = 'hijacked'));
end $$;

\o
-- ── Report ──────────────────────────────────────────────────────────────────
\pset footer off
select status, count(*) from tk.results group by status order by status;
select n, status, name, detail from tk.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from tk.results where status = 'fail';
  if f > 0 then raise exception '% task assignment check(s) failed', f; end if;
end $$;
