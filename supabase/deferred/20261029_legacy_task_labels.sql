-- DEFERRED, not part of any migration (review of PR #200, item 4). Labels the
-- still-OPEN tasks created from the retired BrightLocal / Metricool templates
-- so nobody buys a retired service. Run only after the preview below has been
-- reviewed (task ids, clients, count) and Tom has agreed.
--
-- 1. Preview (read-only):
--      select t.id, c.name as client, t.key, t.title, t.status, t.created_at
--      from tasks t join clients c on c.id = t.client_id
--      where t.status <> 'done' and t.title not like '[Legacy%'
--        and (t.key in ('brightlocal_lrt','brightlocal_lsg') or t.title = 'Connect Metricool')
--      order by c.name, t.key;
-- 2. Apply with the reviewed count, in one transaction:
--      begin; set local compass.expected_legacy_tasks = '<count>'; \i this file; commit;
--    A different count refuses the whole script.
--
-- What it does: prefixes the title, appends one dated note line. Task ids,
-- status, owner, stage, completion and every done task are untouched; the
-- original title stays readable after the prefix. Undo: the last block of
-- supabase/rollback/20261029170000_client_onboarding_checklist.down.sql.
do $$
declare
  v_expected int := nullif(current_setting('compass.expected_legacy_tasks', true), '')::int;
  v_found int;
  v_done int;
begin
  select count(*) into v_found from public.tasks t
  where t.status <> 'done' and t.title not like '[Legacy%'
    and (t.key in ('brightlocal_lrt','brightlocal_lsg') or t.title = 'Connect Metricool');
  if v_expected is null or v_expected <> v_found then
    raise exception 'legacy task labels: expected % open tasks, found %; review the preview first', coalesce(v_expected::text, 'no count'), v_found;
  end if;
  select count(*) into v_done from public.tasks t where t.status = 'done'
    and (t.key in ('brightlocal_lrt','brightlocal_lsg') or t.title = 'Connect Metricool');

  update public.tasks
  set title = '[Legacy — do not buy] ' || title,
      notes = concat_ws(E'\n', nullif(notes, ''), 'Oct 29 2026: BrightLocal rank / grid reports are retired; ranks come from rank-sync and Compass map grids. Close as not needed unless Tom says otherwise. Existing BrightLocal subscriptions are not cancelled here.')
  where key in ('brightlocal_lrt','brightlocal_lsg') and status <> 'done' and title not like '[Legacy%';
  update public.tasks
  set title = '[Legacy] ' || title,
      notes = concat_ws(E'\n', nullif(notes, ''), 'Oct 29 2026: Metricool is retired; connect and verify the Zernio destination (Onboarding checklist D).')
  where title = 'Connect Metricool' and status <> 'done';

  if (select count(*) from public.tasks t where t.status = 'done'
      and (t.key in ('brightlocal_lrt','brightlocal_lsg') or t.title = 'Connect Metricool')) <> v_done then
    raise exception 'legacy task labels: a completed task changed';
  end if;
  raise notice 'legacy task labels: % open tasks labelled; % completed tasks untouched', v_found, v_done;
end $$;
