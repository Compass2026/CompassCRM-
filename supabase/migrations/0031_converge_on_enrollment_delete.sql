-- Convergence re-evaluates when a launch enrollment is removed.
--
-- BHG Safety Partners keeps its site, so Tom dropped its Website enrollment
-- after SEO had already completed. Convergence (client → active, Reporting
-- enrolled) only ran on a pipeline *update*, so removing the one enrollment
-- that was still open left the client stuck at launching with no cycle.
-- The check moves into converge_client(); the completion trigger and a new
-- after-delete trigger both call it.

create or replace function converge_client(p_client_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from client_pipelines cp join pipelines p on p.id = cp.pipeline_id
    where cp.client_id = p_client_id and p.is_recurring = false and p.key <> 'foundation'
  )
  and not exists (
    select 1 from client_pipelines cp join pipelines p on p.id = cp.pipeline_id
    where cp.client_id = p_client_id and p.is_recurring = false and cp.status <> 'complete'
  ) then
    update clients set status = 'active' where id = p_client_id and status = 'launching';
    insert into client_pipelines (client_id, pipeline_id, status)
    select p_client_id, p.id, 'active' from pipelines p
    where p.is_recurring
      and not exists (select 1 from client_pipelines cp2 where cp2.client_id = p_client_id and cp2.pipeline_id = p.id);
    return true;
  end if;
  return false;
end $$;

revoke execute on function converge_client(uuid) from public, anon, authenticated;

create or replace function handle_pipeline_completion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'complete' and old.status is distinct from 'complete' then
    perform converge_client(new.client_id);
  end if;
  return new;
end $$;

create or replace function handle_pipeline_removal() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from pipelines p where p.id = old.pipeline_id and p.is_recurring = false) then
    perform converge_client(old.client_id);
  end if;
  return old;
end $$;

revoke execute on function handle_pipeline_removal() from public, anon, authenticated;

drop trigger if exists client_pipelines_zz_removal_convergence on client_pipelines;
create trigger client_pipelines_zz_removal_convergence after delete on client_pipelines
  for each row execute function handle_pipeline_removal();
