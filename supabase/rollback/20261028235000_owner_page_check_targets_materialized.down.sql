-- Undoes 20261028235000: restores owner_page_check_targets exactly as
-- 20261028170000 §15 defined it (the inlinable owner CTE). Run as one
-- transaction. Nothing else changes and no row is touched. With it back,
-- owner-page-check times out again for BHG, so BHG stays unchecked.
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
  o as (
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
