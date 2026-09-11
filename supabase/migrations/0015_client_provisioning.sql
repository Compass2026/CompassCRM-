-- Client provisioning (reconciliation.md build-order step 4): creating a
-- client fires the client-provision Edge Function, which creates the Drive
-- folder structure and the site's GitHub repo and writes both back.
--
-- The function is safe to run without credentials — each step reports
-- "skipped" when its Vault secrets are absent — so this migration can land
-- before GDRIVE_* / GITHUB_TOKEN exist. Until they do, the two checklist
-- tasks stay open and Tom (or Claude, via the connectors) does it by hand.

-- ── Let templates carry a stable key, the way tasks already do ───────────
-- 0009 added tasks.key so automations can find a task again. The provisioning
-- function needs the same handle on template-created tasks: matching on title
-- would break the moment someone rewords a checklist item.
alter table task_templates add column if not exists key text;

create or replace function create_stage_tasks(p_client_pipeline_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  insert into tasks (client_id, client_stage_id, title, owner, status,
                     playbook_step, autonomy_level, key)
  select cp.client_id, cs.id, tt.title, tt.default_owner, 'open',
         coalesce(tt.playbook_step, s.playbook_ref),
         coalesce(tt.autonomy_level, s.autonomy_level),
         tt.key
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

-- The two templates the function satisfies.
update task_templates
set key = 'drive_folders'
where title like 'Create the Drive folder structure%';

update task_templates
set key = 'github_repo'
where title like 'Create the GitHub repo and Vercel project%';

-- Existing clients' already-created tasks get the same keys.
update tasks
set key = 'drive_folders'
where key is null and title like 'Create the Drive folder structure%';

update tasks
set key = 'github_repo'
where key is null and title like 'Create the GitHub repo and Vercel project%';

-- ── Fire provisioning when a client is created ───────────────────────────
create or replace function provision_new_client() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_cron text;
begin
  -- No cron secret means the function cannot authorize the call; skip rather
  -- than queue a request that will only come back 401.
  v_cron := get_secret('SYNC_CRON_SECRET');
  if v_cron is null then
    return new;
  end if;

  perform net.http_post(
    url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/client-provision',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_secret('SUPABASE_ANON_KEY'),
      'x-cron-secret', v_cron
    ),
    body := jsonb_build_object('client_id', new.id)
  );
  return new;
end $$;

revoke execute on function provision_new_client() from public, anon, authenticated;

drop trigger if exists clients_provision on clients;
create trigger clients_provision after insert on clients
  for each row execute function provision_new_client();
