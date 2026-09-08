-- Foundation enrollment + gating (build order step 3; docs/reconciliation.md
-- decisions 2 and 3, "Automations to add"). Enforced in triggers, not the UI:
--   * every new client is enrolled in Foundation, and stays enrolled
--   * a pipeline with gated stages (SEO, Website) enrolls as 'pending' while
--     Foundation is incomplete; its template tasks are created at unlock
--   * gated stages cannot start before Foundation completes
--   * Foundation stages 2 and 3 wait for stage 1 (the taxonomy)
-- Template tasks now carry playbook_step / autonomy_level onto tasks.

create function foundation_complete(p_client_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from client_pipelines cp
    join pipelines p on p.id = cp.pipeline_id
    where cp.client_id = p_client_id and p.key = 'foundation' and cp.status = 'complete'
  );
$$;
revoke execute on function foundation_complete(uuid) from public, anon, authenticated;

-- Template tasks for every stage of an enrollment that has none yet.
create function create_stage_tasks(p_client_pipeline_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  insert into tasks (client_id, client_stage_id, title, owner, status, playbook_step, autonomy_level)
  select cp.client_id, cs.id, tt.title, tt.default_owner, 'open',
         coalesce(tt.playbook_step, s.playbook_ref),
         coalesce(tt.autonomy_level, s.autonomy_level)
  from client_pipelines cp
  join client_stages cs on cs.client_pipeline_id = cp.id
  join stages s on s.id = cs.stage_id
  join task_templates tt on tt.stage_id = s.id
  where cp.id = p_client_pipeline_id
    and not exists (select 1 from tasks t where t.client_stage_id = cs.id)
  order by s.sort_order, tt.sort_order;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function create_stage_tasks(uuid) from public, anon, authenticated;

-- ── Enrollment ───────────────────────────────────────────────────────────
-- Before insert: a pipeline with gated stages waits for Foundation.
create function gate_pipeline_enrollment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'active'
     and exists (select 1 from stages s where s.pipeline_id = new.pipeline_id and s.requires_foundation)
     and not foundation_complete(new.client_id) then
    new.status := 'pending';
  end if;
  return new;
end $$;
revoke execute on function gate_pipeline_enrollment() from public, anon, authenticated;
create trigger client_pipelines_gate before insert on client_pipelines
  for each row execute function gate_pipeline_enrollment();

-- After insert (replaces 0001): stages for every enrollment; template tasks
-- only when the enrollment is not pending (pending ones get them at unlock).
create or replace function handle_pipeline_enrollment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into client_stages (client_pipeline_id, stage_id, status, owner)
  select new.id, s.id, 'not_started', s.default_owner
  from stages s
  where s.pipeline_id = new.pipeline_id
  order by s.sort_order;

  if new.status <> 'pending' then
    perform create_stage_tasks(new.id);
  end if;
  return new;
end $$;

-- ── Foundation complete → unlock pending pipelines ───────────────────────
create function handle_foundation_completion() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_cp record;
begin
  if new.status = 'complete' and old.status is distinct from 'complete'
     and exists (select 1 from pipelines p where p.id = new.pipeline_id and p.key = 'foundation') then
    for v_cp in
      select id from client_pipelines
      where client_id = new.client_id and status = 'pending'
    loop
      update client_pipelines set status = 'active' where id = v_cp.id;
      perform create_stage_tasks(v_cp.id);
    end loop;
  end if;
  return new;
end $$;
revoke execute on function handle_foundation_completion() from public, anon, authenticated;
create trigger client_pipelines_foundation_unlock after update on client_pipelines
  for each row execute function handle_foundation_completion();

-- ── Stage gates ──────────────────────────────────────────────────────────
-- Runs before client_stages_status (alphabetical trigger order).
create function enforce_stage_gates() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_stage stages%rowtype;
  v_cp client_pipelines%rowtype;
  v_key pipeline_key;
  v_taxonomy_done boolean;
begin
  if new.status = old.status or new.status in ('not_started', 'skipped') then
    return new;
  end if;

  select * into v_stage from stages where id = new.stage_id;
  select * into v_cp from client_pipelines where id = new.client_pipeline_id;
  select key into v_key from pipelines where id = v_cp.pipeline_id;

  if v_stage.requires_foundation and not foundation_complete(v_cp.client_id) then
    raise exception '% cannot start until Foundation is complete for this client', v_stage.name
      using errcode = 'check_violation',
            hint = 'Finish Onboarding & Service Taxonomy, Brand Build and Keyword Research first.';
  end if;

  -- Foundation: the taxonomy (stage 1) gates Brand Build and Keyword Research.
  if v_key = 'foundation' and v_stage.sort_order > 1 then
    select exists (
      select 1
      from client_stages cs
      join stages s on s.id = cs.stage_id
      where cs.client_pipeline_id = new.client_pipeline_id
        and s.sort_order = 1 and cs.status = 'complete'
    ) into v_taxonomy_done;
    if not v_taxonomy_done then
      raise exception '% cannot start until Onboarding & Service Taxonomy is complete', v_stage.name
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;
revoke execute on function enforce_stage_gates() from public, anon, authenticated;
create trigger client_stages_gate before update on client_stages
  for each row execute function enforce_stage_gates();

-- ── Every client runs Foundation ─────────────────────────────────────────
create function enroll_client_in_foundation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into client_pipelines (client_id, pipeline_id, status)
  select new.id, p.id, 'active'
  from pipelines p
  where p.key = 'foundation'
  on conflict (client_id, pipeline_id) do nothing;
  return new;
end $$;
revoke execute on function enroll_client_in_foundation() from public, anon, authenticated;
create trigger clients_foundation_enrollment after insert on clients
  for each row execute function enroll_client_in_foundation();

-- ...and cannot drop it (deleting the client itself still cascades).
create function protect_foundation_enrollment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from pipelines p where p.id = old.pipeline_id and p.key = 'foundation')
     and exists (select 1 from clients c where c.id = old.client_id) then
    raise exception 'Foundation enrollment cannot be removed; every client runs Foundation'
      using errcode = 'check_violation';
  end if;
  return old;
end $$;
revoke execute on function protect_foundation_enrollment() from public, anon, authenticated;
create trigger client_pipelines_protect_foundation before delete on client_pipelines
  for each row execute function protect_foundation_enrollment();

-- ── Monthly cycles carry playbook_step / autonomy_level (replaces 0001) ──
create or replace function create_monthly_cycles(p_period date default date_trunc('month', now())::date)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int := 0;
  v_client record;
  v_cycle_id uuid;
begin
  for v_client in
    select c.id
    from clients c
    where c.status = 'active'
      and exists (
        select 1 from client_pipelines cp
        join pipelines p on p.id = cp.pipeline_id
        where cp.client_id = c.id and p.is_recurring and cp.status = 'active'
      )
      and not exists (
        select 1 from monthly_cycles mc
        where mc.client_id = c.id and mc.period = p_period
      )
  loop
    insert into monthly_cycles (client_id, period)
    values (v_client.id, p_period)
    returning id into v_cycle_id;

    insert into tasks (client_id, monthly_cycle_id, title, owner, status, playbook_step, autonomy_level)
    select v_client.id, v_cycle_id, tt.title, tt.default_owner, 'open', tt.playbook_step, tt.autonomy_level
    from task_templates tt
    join pipelines p on p.id = tt.pipeline_id and p.is_recurring
    where tt.department is null
       or exists (
         select 1 from client_pipelines cp
         join pipelines dp on dp.id = cp.pipeline_id
         where cp.client_id = v_client.id and dp.key::text = tt.department::text
       )
    order by tt.sort_order;

    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ── Backfill: SEO / Website enrollments made before Foundation existed ───
update client_pipelines cp
set status = 'pending'
from pipelines p
where cp.pipeline_id = p.id
  and cp.status = 'active'
  and exists (select 1 from stages s where s.pipeline_id = p.id and s.requires_foundation)
  and not foundation_complete(cp.client_id);
