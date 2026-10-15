-- Map-tracking-only clients get no onboarding side effects; full clients keep them.
begin;
do $$
declare tracking uuid := '91000000-0000-4000-a000-000000000001';
        full_client uuid := '91000000-0000-4000-a000-000000000002';
begin
  insert into public.clients(id, name, status, service_scope)
    values (tracking, 'Map Tracking Only (fixture)', 'paused', 'map_tracking');
  if exists (select 1 from public.client_pipelines where client_id = tracking) then
    raise exception 'map-tracking client was enrolled in a pipeline';
  end if;
  if exists (select 1 from public.tasks where client_id = tracking) then
    raise exception 'map-tracking client received onboarding tasks';
  end if;
  if exists (select 1 from public.client_brands where client_id = tracking) then
    raise exception 'map-tracking client received a brand row';
  end if;
  if exists (select 1 from public.worker_fires where client_id = tracking) then
    raise exception 'map-tracking client fired the worker';
  end if;

  -- Positive control: the default scope still onboards.
  insert into public.clients(id, name) values (full_client, 'Full Service (fixture)');
  if (select service_scope from public.clients where id = full_client) <> 'full' then
    raise exception 'default scope is not full';
  end if;
  if not exists (select 1 from public.client_pipelines cp join public.pipelines p on p.id = cp.pipeline_id
                 where cp.client_id = full_client and p.key = 'foundation') then
    raise exception 'full client lost Foundation enrollment';
  end if;
  if not exists (select 1 from public.tasks where client_id = full_client and key = 'brand_board') then
    raise exception 'full client lost the brand board task';
  end if;
  if not exists (select 1 from public.client_brands where client_id = full_client) then
    raise exception 'full client lost its brand row';
  end if;

  -- A map-tracking client cannot become active/launching, which would put it in status-driven jobs.
  begin
    update public.clients set status = 'active' where id = tracking;
    raise exception 'map-tracking client activated';
  exception when check_violation then null;
  end;
  begin
    insert into public.clients(name, status, service_scope) values ('Bad scope (fixture)', 'launching', 'map_tracking');
    raise exception 'launching map-tracking client allowed';
  exception when check_violation then null;
  end;
  begin
    insert into public.clients(name, service_scope) values ('Unknown scope (fixture)', 'other');
    raise exception 'unknown scope allowed';
  exception when check_violation then null;
  end;
end $$;
rollback;
