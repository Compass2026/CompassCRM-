-- Agency work management, slice 1: tasks a person can own (Sept 22 2026).
--
-- `tasks.owner` / `autonomy_level` say what kind of worker does a step (TOM,
-- CLAUDE, WAITING …) and how much it may do unattended; the worker, the
-- pipeline seeds and the Brief all read them. They stay exactly as they are.
-- This adds, alongside them:
--
-- 1. tasks.assignee_id — an actual team member, nullable. Every existing task
--    stays unassigned; nothing is backfilled and no meaning changes.
-- 2. tasks.created_by / updated_by / updated_at — stamped by trigger from
--    auth.uid(). A write with no signed-in team member (the worker, pg_cron,
--    Edge Functions on the service role, migrations) stamps NULL, which the
--    app shows as "Worker / system". Callers cannot forge them.
-- 3. task_events — an append-only history (created, status, assignee, due
--    date, title, owner) written only by trigger. Not writable over the API.
-- 4. task_comments — team comments on a task.
-- 5. Belonging-together: comments and events carry (task_id, client_id) with
--    a composite FK to tasks, a task's client never changes, and a task's
--    stage / monthly cycle must be the same client's. Checked live on
--    Sept 22: no existing task violates this (0 stage, 0 cycle mismatches).
--
-- Access is team-only (is_team(), 0036). Portal users (0037) read nothing
-- here: the portal only ever touches its portal_* views, none of which
-- reference tasks, comments or events.
--
-- Depends on 0036 (is_team, team_members linked). Numbered 0043: 0041 is
-- PR #50's reporting work and 0042 is PR #51's portal single assignment.

-- ── 1–2. Columns ────────────────────────────────────────────────────────────
alter table tasks
  add column assignee_id uuid,
  add column created_by uuid,
  add column updated_by uuid,
  add column updated_at timestamptz;

alter table tasks
  add constraint tasks_assignee_id_fkey foreign key (assignee_id)
    references team_members(id) on delete set null,
  add constraint tasks_created_by_fkey foreign key (created_by)
    references team_members(id) on delete set null,
  add constraint tasks_updated_by_fkey foreign key (updated_by)
    references team_members(id) on delete set null,
  -- Target for the composite FKs below.
  add constraint tasks_id_client_key unique (id, client_id);

comment on column tasks.assignee_id is
  'The team member doing this task. Independent of owner (the worker lane) and autonomy_level.';
comment on column tasks.updated_by is
  'Team member behind the last update; NULL = worker / system (no signed-in team member).';

create index tasks_assignee_open_idx on tasks (assignee_id) where status <> 'done';
create index tasks_due_open_idx on tasks (due_date) where status <> 'done' and due_date is not null;

-- The signed-in team member, or NULL. Internal: called only from the
-- security-definer triggers below, never over PostgREST.
create or replace function task_actor() returns uuid
language sql stable security definer set search_path = public as $$
  select id from team_members where auth_user_id = auth.uid()
$$;
revoke execute on function task_actor() from public, anon, authenticated;

create or replace function tasks_stamp_and_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := task_actor();
begin
  if tg_op = 'UPDATE' then
    if new.client_id is distinct from old.client_id then
      raise exception 'A task cannot move to another client'
        using errcode = 'check_violation';
    end if;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := v_actor;
  else
    -- A signed-in caller is always recorded as themselves; only a caller
    -- with no JWT (service role, SQL) may pass created_by through.
    if auth.uid() is not null then
      new.created_by := v_actor;
    end if;
    new.updated_at := null;
    new.updated_by := null;
  end if;

  if new.client_stage_id is not null
     and (tg_op = 'INSERT' or new.client_stage_id is distinct from old.client_stage_id)
     and not exists (
       select 1 from client_stages cs
       join client_pipelines cp on cp.id = cs.client_pipeline_id
       where cs.id = new.client_stage_id and cp.client_id = new.client_id
     ) then
    raise exception 'The stage belongs to another client' using errcode = 'check_violation';
  end if;

  if new.monthly_cycle_id is not null
     and (tg_op = 'INSERT' or new.monthly_cycle_id is distinct from old.monthly_cycle_id)
     and not exists (
       select 1 from monthly_cycles mc
       where mc.id = new.monthly_cycle_id and mc.client_id = new.client_id
     ) then
    raise exception 'The monthly cycle belongs to another client' using errcode = 'check_violation';
  end if;

  return new;
end $$;
revoke execute on function tasks_stamp_and_check() from public, anon, authenticated;

-- Runs before the existing AFTER trigger tasks_zz_fire_worker, which it does
-- not affect.
create trigger tasks_aa_stamp before insert or update on tasks
  for each row execute function tasks_stamp_and_check();

-- ── 3. History ──────────────────────────────────────────────────────────────
create table task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  client_id uuid not null,
  actor_id uuid references team_members(id) on delete set null,
  kind text not null check (kind in ('created', 'status', 'assignee', 'due_date', 'title', 'owner')),
  from_value text,
  to_value text,
  created_at timestamptz not null default now(),
  foreign key (task_id, client_id) references tasks (id, client_id) on delete cascade
);
create index task_events_task_idx on task_events (task_id, created_at);
comment on table task_events is
  'Append-only task history, written by trigger. actor_id NULL = worker / system.';

create or replace function tasks_record_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := task_actor();
begin
  if tg_op = 'INSERT' then
    insert into task_events (task_id, client_id, actor_id, kind, to_value)
    values (new.id, new.client_id, v_actor, 'created', new.title);
    if new.assignee_id is not null then
      insert into task_events (task_id, client_id, actor_id, kind, to_value)
      values (new.id, new.client_id, v_actor, 'assignee', new.assignee_id::text);
    end if;
    return new;
  end if;

  insert into task_events (task_id, client_id, actor_id, kind, from_value, to_value)
  select new.id, new.client_id, v_actor, c.kind, c.old_v, c.new_v
  from (values
    ('status',   old.status::text,      new.status::text),
    ('assignee', old.assignee_id::text, new.assignee_id::text),
    ('due_date', old.due_date::text,    new.due_date::text),
    ('title',    old.title,             new.title),
    ('owner',    old.owner::text,       new.owner::text)
  ) as c(kind, old_v, new_v)
  where c.old_v is distinct from c.new_v;
  return new;
end $$;
revoke execute on function tasks_record_history() from public, anon, authenticated;

create trigger tasks_history after insert or update on tasks
  for each row execute function tasks_record_history();

alter table task_events enable row level security;
create policy "team reads task history" on task_events
  for select to authenticated using ((select is_team()));
revoke all on task_events from anon;
revoke insert, update, delete, truncate, references, trigger on task_events from authenticated;

-- ── 4. Comments ─────────────────────────────────────────────────────────────
create table task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  client_id uuid not null,
  author_id uuid references team_members(id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (task_id, client_id) references tasks (id, client_id) on delete cascade
);
create index task_comments_task_idx on task_comments (task_id, created_at);

-- The author is whoever is signed in; the client is the task's. A caller
-- that names a different client is refused rather than silently corrected.
create or replace function task_comments_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid;
  v_actor uuid := task_actor();
begin
  select client_id into v_client from tasks where id = new.task_id;
  if v_client is null then
    raise exception 'No such task' using errcode = 'foreign_key_violation';
  end if;
  if new.client_id is not null and new.client_id <> v_client then
    raise exception 'The task belongs to another client' using errcode = 'check_violation';
  end if;
  new.client_id := v_client;
  if auth.uid() is not null then
    new.author_id := v_actor;
  end if;
  if new.author_id is null then
    raise exception 'A comment needs a team member as its author' using errcode = 'check_violation';
  end if;
  new.created_at := now();
  return new;
end $$;
revoke execute on function task_comments_stamp() from public, anon, authenticated;

create trigger task_comments_stamp before insert on task_comments
  for each row execute function task_comments_stamp();

alter table task_comments enable row level security;
create policy "team reads task comments" on task_comments
  for select to authenticated using ((select is_team()));
create policy "team adds task comments" on task_comments
  for insert to authenticated with check ((select is_team()));
-- Comments are immutable in v1: no update / delete policy, and no grant.
revoke all on task_comments from anon;
revoke update, delete, truncate, references, trigger on task_comments from authenticated;

-- ── Verify ──────────────────────────────────────────────────────────────────
do $$
declare n int;
begin
  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename in ('task_events', 'task_comments')
    and ((qual is not null and qual not like '%is_team()%')
      or (with_check is not null and with_check not like '%is_team()%'));
  if n > 0 then raise exception '0043: a task policy does not read is_team()'; end if;

  if has_table_privilege('anon', 'public.task_events', 'select,insert,update,delete')
     or has_table_privilege('anon', 'public.task_comments', 'select,insert,update,delete')
     or has_table_privilege('authenticated', 'public.task_events', 'insert,update,delete')
     or has_table_privilege('authenticated', 'public.task_comments', 'update,delete') then
    raise exception '0043: grants on task_events / task_comments are wider than intended';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname in ('task_actor', 'tasks_stamp_and_check', 'tasks_record_history', 'task_comments_stamp')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
  ) then
    raise exception '0043: an internal task function is callable over the API';
  end if;
end $$;
