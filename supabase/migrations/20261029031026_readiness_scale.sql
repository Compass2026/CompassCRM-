-- BHG at list scale: one index for keyword_owner, slot readiness judged per site.
--
-- The isolated benchmark (three approved 50-keyword lists, BHG's shape;
-- private review package benchmark/README.md) found two paths over the API's
-- 8 s statement timeout:
-- - keyword_owner compares core_norm_kw(keyword) across every active
--   keyword of the client, unindexed, so each call grows with the client
--   (about 31 ms per call for BHG on production today);
-- - social_slot_readiness re-scans every keyword of the client for every
--   slot until one is eligible, so a site with nothing eligible costs one
--   owner lookup per client keyword per slot (one week: about 42 s).
--
-- 1. An expression index serves keyword_owner's equivalent-rows lookup.
-- 2. social_slot_readiness asks "does this site have a core keyword ready to
--    draft from" once per site, over the site's own approved list and the
--    supporting terms that name one of its keywords. The answer is the same:
--    eligibility needs grounding, grounding needs an approved list of the
--    keyword's own site (one per site, core_keyword_lists_one_approved), and
--    keyword_owner refuses any other site (keyword_wrong_site). So every
--    eligible keyword is in that list or names a keyword of it.
-- Same signature, rows and grants. Nothing else changes.
-- Rollback: supabase/rollback/20261029030000_readiness_scale.down.sql

create index keywords_client_norm_kw on keywords (client_id, core_norm_kw(keyword)) where is_active;

do $guard$
begin
  -- Written against this exact definition (20261027191343, patched by
  -- 20261028170000 §12); anything else is reviewed first.
  if md5(pg_get_functiondef('public.social_slot_readiness(uuid,date,date)'::regprocedure)) <> '34557bebbcec78cd2a0fe401577ce3c5' then
    raise exception 'social_slot_readiness is not the reviewed definition; review before applying';
  end if;
end $guard$;

CREATE OR REPLACE FUNCTION public.social_slot_readiness(p_client_id uuid, p_from date, p_through date)
 RETURNS TABLE(plan_item_id uuid, client_id uuid, brand_workspace_id uuid, deliverable text, channel text, planned_date date, social_account_id uuid, shared_same_day integer, core_list_id uuid, core_list_version integer, task_id uuid, ready boolean, reason text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with slots as (
    select i.*, c.status::text as client_status, c.website_url as client_website,
           w.status as ws_status, w.facebook_account_id as ws_facebook, w.service_ids as ws_services, w.website_url as ws_website,
           exists (select 1 from client_brand_workspaces x where x.client_id = i.client_id) as multi,
           l.id as list_id, l.version as list_version, l.keyword_ids as core_ids,
           (select max(p.version) from core_keyword_lists p where p.client_id = i.client_id and p.status = 'proposed'
               and p.brand_workspace_id is not distinct from i.brand_workspace_id) as proposed_version,
           (select t.id from tasks t where t.key = 'social_slot:' || i.id::text) as queued_task
    from content_plan_items i
    join clients c on c.id = i.client_id
    left join client_brand_workspaces w on w.id = i.brand_workspace_id
    left join core_keyword_lists l on l.client_id = i.client_id and l.status = 'approved'
          and l.brand_workspace_id is not distinct from i.brand_workspace_id
    where i.client_id = p_client_id and i.standard_key in ('facebook_posts', 'gbp_posts')
      and i.planned_date between p_from and p_through
  ),
  -- Whether a site has a core keyword ready to draft from is the same for
  -- every slot of the site, and only the site's own approved list (its
  -- keywords, and supporting terms naming one of them) can ground such a
  -- keyword (20261029030000): judged once per site, from that list only.
  -- Materialized and read lazily, so a site is judged only when one of its
  -- slots reaches that check.
  site_ok as materialized (
    select x.brand_workspace_id, exists (
             select 1 from keywords k
              where k.client_id = p_client_id and k.is_active
                and (k.id = any(x.core_ids) or k.core_parent_keyword_id = any(x.core_ids))
                and core_keyword_eligibility(p_client_id, case when x.multi then x.brand_workspace_id end, k.id, null, 'post') is null) as ok
    from (select distinct s.brand_workspace_id, s.multi, s.core_ids from slots s where s.list_id is not null) x
  ),
  dest as (
    select s.id,
      case
        when s.standard_key = 'facebook_posts' and s.multi then (
          select sa.id from social_accounts sa where sa.id = s.ws_facebook and sa.client_id = s.client_id
            and sa.platform::text = 'facebook' and sa.publish_provider = 'zernio'
            and nullif(btrim(sa.publish_account_id), '') is not null and sa.publish_verified_at is not null)
        when s.standard_key = 'facebook_posts' then (
          select case when count(*) = 1 then (array_agg(sa.id))[1] end from social_accounts sa
           where sa.client_id = s.client_id and sa.platform::text = 'facebook' and sa.publish_provider = 'zernio'
             and nullif(btrim(sa.publish_account_id), '') is not null and sa.publish_verified_at is not null)
        -- Business Profile: the location the slot names (20261027150000), which
        -- must be one of this client's verified Zernio locations; with none
        -- named, the client's only location. Never another location.
        when s.gbp_location_id is not null then (
          select sa.id from social_accounts sa where sa.id = s.gbp_location_id and sa.client_id = s.client_id
            and sa.platform::text = 'google_business' and sa.publish_provider = 'zernio'
            and nullif(btrim(sa.publish_account_id), '') is not null and nullif(btrim(sa.publish_page_id), '') is not null
            and sa.publish_verified_at is not null
            and exists (select 1 from publisher_client_transports t where t.client_id = s.client_id and t.gbp_transport = 'zernio'))
        else (
          select case when count(*) = 1 then (array_agg(sa.id))[1] end from social_accounts sa
           where sa.client_id = s.client_id and sa.platform::text = 'google_business' and sa.publish_provider = 'zernio'
             and nullif(btrim(sa.publish_account_id), '') is not null and nullif(btrim(sa.publish_page_id), '') is not null
             and sa.publish_verified_at is not null
             and exists (select 1 from publisher_client_transports t where t.client_id = s.client_id and t.gbp_transport = 'zernio'))
      end as account_id,
      (select count(*) from social_accounts sa where sa.client_id = s.client_id and sa.platform::text = 'google_business'
         and sa.publish_provider = 'zernio' and sa.publish_verified_at is not null) as gbp_locations
    from slots s
  )
  select s.id, s.client_id, s.brand_workspace_id, s.standard_key, s.channel::text, s.planned_date, d.account_id,
    (select count(*)::int from slots o where o.standard_key = 'gbp_posts' and s.standard_key = 'gbp_posts'
       and o.id <> s.id and o.planned_date = s.planned_date and o.social_post_id is null and o.hold is null
       and o.gbp_location_id is not distinct from s.gbp_location_id),
    s.list_id, s.list_version, s.queued_task,
    r.reason is null, r.reason
  from slots s join dest d on d.id = s.id
  cross join lateral (select case
    when s.client_status not in ('active', 'launching') then 'Client is ' || s.client_status || '.'
    when s.social_post_id is not null then 'Already linked to a post.'
    when s.hold = 'delivered' then 'Marked delivered.'
    when s.hold = 'blocked' then left('Blocked: ' || coalesce(s.hold_reason, 'no reason given'), 300)
    when s.multi and s.brand_workspace_id is null then 'The slot names no brand site.'
    when s.multi and s.ws_status is distinct from 'approved' then 'The brand site''s guidance is not approved.'
    when not s.multi and not exists (select 1 from brand_boards b where b.client_id = s.client_id and b.status = 'approved')
      then 'The brand board is not approved.'
    when d.account_id is null and s.standard_key = 'facebook_posts' then 'No verified Facebook Page is bound for this site.'
    when d.account_id is null and s.gbp_location_id is null and d.gbp_locations > 1
      then 'Choose this slot''s Business Profile location (the client has ' || d.gbp_locations || ' verified locations).'
    when d.account_id is null and s.gbp_location_id is not null then 'The slot''s Business Profile location is not a verified location of this client.'
    when d.account_id is null then 'No verified Business Profile location is bound for this client.'
    when s.list_id is null then 'No approved core keyword list'
      || case when s.proposed_version is not null then ' (v' || s.proposed_version || ' proposed, awaiting approval).' else '.' end
    when not (select o.ok from site_ok o where o.brand_workspace_id is not distinct from s.brand_workspace_id)
      then 'No core keyword (v' || s.list_version || ') with an intent and one verified owner page on the site (an approved page group, checked live), an approved related service where the page needs one, and an approved market.'
  end as reason) r
  order by s.planned_date, s.id
$function$;

do $verify$
begin
  if strpos(pg_get_functiondef('public.social_slot_readiness(uuid,date,date)'::regprocedure), 'site_ok as materialized') = 0
     or strpos(pg_get_functiondef('public.social_slot_readiness(uuid,date,date)'::regprocedure), 'where k.client_id = s.client_id and k.is_active') > 0 then
    raise exception 'social_slot_readiness: the per-site check is not in place';
  end if;
  if has_function_privilege('anon', 'public.social_slot_readiness(uuid,date,date)', 'execute')
     or not has_function_privilege('authenticated', 'public.social_slot_readiness(uuid,date,date)', 'execute')
     or not has_function_privilege('service_role', 'public.social_slot_readiness(uuid,date,date)', 'execute') then
    raise exception 'social_slot_readiness: grants changed';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'keywords_client_norm_kw'
                  and indexdef like '%(client_id, core_norm_kw(keyword))%' and indexdef like '%WHERE is_active%') then
    raise exception 'keywords_client_norm_kw is missing';
  end if;
end $verify$;
