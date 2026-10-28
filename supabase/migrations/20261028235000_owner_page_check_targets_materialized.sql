-- owner_page_check_targets: resolve each keyword's owner once.
--
-- 20261028170000 §15 left the CTE that calls keyword_owner() inlinable, so
-- Postgres pasted the call into every place the query reads o.j (the
-- filter, the grouping key and both aggregates) and resolved each keyword
-- three to four times. BHG's three sites (about 150 keywords) took 24 s and
-- every owner-page-check call for BHG hit the API's 8 s statement timeout
-- (Oct 28 release, HTTP 500). MATERIALIZED makes the CTE run once per
-- keyword; the same query, read-only on production, took 3.7 s for BHG.
--
-- Same signature, return shape, rows and grants: only the plan changes.
-- Rollback: supabase/rollback/20261028235000_owner_page_check_targets_materialized.down.sql
-- restores the §15 definition.
create or replace function owner_page_check_targets(p_client_id uuid, p_brand_workspace_id uuid default null)
returns table (url text, site_url text, keyword_count integer)
language sql stable security invoker set search_path = public, pg_temp as $$
  with ks as (
    select distinct k.id, l.brand_workspace_id
    from core_keyword_lists l
    cross join lateral unnest(l.keyword_ids) kid
    join keywords k on k.client_id = l.client_id and (k.id = kid or k.core_parent_keyword_id = kid) and k.is_active
    where l.client_id = p_client_id and l.status in ('proposed', 'approved')
      and (p_brand_workspace_id is null or l.brand_workspace_id = p_brand_workspace_id)
  ),
  o as materialized (
    select ks.id, keyword_owner(p_client_id, null, ks.id, 'add') as j, ks.brand_workspace_id from ks
  )
  select coalesce(min(o.j->>'display_url'), min(o.j->>'url')),
         coalesce((select w.website_url from client_brand_workspaces w where w.id = min(o.brand_workspace_id::text)::uuid),
                  (select c.website_url from clients c where c.id = p_client_id)),
         count(*)::int
  from o where o.j->>'url' ~ '^https://'
  group by o.j->>'url'
  order by 3 desc, 1
$$;
revoke all on function owner_page_check_targets(uuid, uuid) from public, anon, authenticated;
grant execute on function owner_page_check_targets(uuid, uuid) to service_role;

do $verify$
begin
  if strpos(pg_get_functiondef('public.owner_page_check_targets(uuid,uuid)'::regprocedure), 'o as materialized') = 0 then
    raise exception 'owner_page_check_targets: the owner CTE is not materialized';
  end if;
  if has_function_privilege('anon', 'public.owner_page_check_targets(uuid,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.owner_page_check_targets(uuid,uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.owner_page_check_targets(uuid,uuid)', 'execute') then
    raise exception 'owner_page_check_targets: grants changed (service_role only)';
  end if;
end $verify$;
