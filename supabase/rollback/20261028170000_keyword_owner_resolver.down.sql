-- Rollback for 20261028170000_keyword_owner_resolver.sql.
-- Run as ONE transaction (psql -1 -f, or the Supabase SQL editor), and only
-- AFTER the previous post-drafter and content-drafter are redeployed: the
-- restored loader takes (client, service) again, and today's drafters call
-- it with p_keyword_id. Undeploy owner-page-check first too (its target
-- list is dropped here).
--
-- What it does:
--   1. drops the five copy-hold triggers and their functions;
--   2. restores, byte for byte, the eleven functions the migration replaced
--      and the planner board view (definitions captured from main's schema,
--      not retyped), and the two-argument drafter loader with its grants;
--   3. drops the resolver, the hold matcher and their helpers.
-- What it keeps: client_service_markets, owner_page_checks,
-- client_promotion_holds (and their guards and the four URL / text helpers
-- the guards use), keywords.market_id and the owner columns on
-- core_keyword_links (and the guard on that column). Those hold recorded
-- decisions and evidence, so they are not dropped; nothing reads them once
-- this has run. No row is deleted or rewritten. Because they stay, the same
-- migration does not re-apply on top of a rollback: a fix-forward is a new
-- migration that reuses them.
-- Proven in the sandbox (keyword_owner_resolver_rollback.test.sql), and
-- against main's schema: every restored definition, grant and the view
-- hash the same as main's; the only trigger left is keywords_market_guard.

-- 1. Holds on the copy
drop trigger social_posts_ab_promotion_hold on public.social_posts;
drop trigger content_drafts_ab_promotion_hold on public.content_drafts;
drop trigger blog_publications_promotion_hold on public.blog_publications;
drop trigger change_log_ab_promotion_hold on public.change_log;
drop trigger content_plan_items_ab_promotion_hold on public.content_plan_items;
drop function public.social_posts_promotion_hold();
drop function public.content_drafts_promotion_hold();
drop function public.blog_publications_promotion_hold();
drop function public.change_log_promotion_hold();
drop function public.content_plan_items_promotion_hold();
drop function public.promotion_hold_conflicts(uuid);

-- 2. The previous definitions (main, before 20261028170000)
CREATE OR REPLACE FUNCTION public.core_keyword_change_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_kw uuid; v_site sites; v_program uuid; v_multi boolean; v_problem text;
begin
  if new.change_type not in ('page_rewrite', 'page_added', 'blog_post') or core_keyword_exempt(new.client_id) then return new; end if;
  -- A revision is rechecked when it changes what the change is about.
  if tg_op = 'UPDATE' and (new.change_type, new.object_type, new.object_id, new.after->>'keyword_id', new.after->>'url')
     is not distinct from (old.change_type, old.object_type, old.object_id, old.after->>'keyword_id', old.after->>'url') then
    return new;
  end if;
  v_kw := case when coalesce(new.after->>'keyword_id', '') ~ '^[0-9a-f-]{36}$' then (new.after->>'keyword_id')::uuid end;
  if v_kw is null then
    raise exception 'core_keyword_required: a % change names its core keyword (after.keyword_id)', new.change_type using errcode = '23514';
  end if;
  select * into v_site from sites where id = new.object_id and client_id = new.client_id;
  v_multi := exists (select 1 from client_brand_workspaces w where w.client_id = new.client_id);
  if new.object_type is distinct from 'site' or v_site.id is null then
    raise exception 'core_keyword_required: a % change names the site it is on (object_type site, object_id)', new.change_type using errcode = '23514';
  end if;
  if v_multi then
    select w.id into v_program from client_brand_workspaces w where w.client_id = new.client_id and w.blog_site_id = v_site.id;
    if v_program is null then
      raise exception 'core_keyword_required: the site of this % change belongs to no brand site program', new.change_type using errcode = '23514';
    end if;
  end if;
  v_problem := core_keyword_eligibility(new.client_id, v_program, v_kw, null);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '23514';
  end if;
  if coalesce(new.after->>'url', '') ~ '^https?://'
     and lower(regexp_replace(substring(new.after->>'url' from '^https?://([^/:?#]+)'), '^www\.', ''))
         is distinct from lower(regexp_replace(substring(v_site.url from '^https?://([^/:?#]+)'), '^www\.', '')) then
    raise exception 'core_keyword_required: the changed page % is not on the site this change names', new.after->>'url' using errcode = '23514';
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.core_keyword_draft_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_problem text; v_site uuid;
begin
  if core_keyword_draft_governed(tg_op, new, case when tg_op = 'UPDATE' then old end) and not core_keyword_exempt(new.client_id) then
    if new.keyword_id is null then
      raise exception 'core_keyword_required: a draft in review names a keyword of its site''s approved core keyword list' using errcode = '23514';
    end if;
    v_site := coalesce((select i.brand_workspace_id from content_plan_items i where i.id = new.plan_item_id),
                       core_site_of_service(new.client_id, new.service_id));
    v_problem := core_keyword_eligibility(new.client_id, v_site, new.keyword_id, new.service_id);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '23514';
    end if;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.core_keyword_eligibility(p_client_id uuid, p_brand_workspace_id uuid, p_keyword_id uuid, p_service_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare k keywords; v services; site text; ws client_brand_workspaces; norm_page text;
begin
  select * into k from keywords where id = p_keyword_id and client_id = p_client_id;
  if k.id is null or not k.is_active then return 'keyword_not_eligible: the keyword is inactive or not this client''s.'; end if;
  if not exists (select 1 from core_keyword_grounding(p_client_id, p_keyword_id)) then
    return 'core_keyword_required: the keyword is not in the approved core keyword list and names no active core parent.';
  end if;
  if k.intent is null then return 'keyword_not_eligible: the keyword has no recorded intent.'; end if;
  if p_service_id is not null and p_service_id is distinct from k.service_id then
    return 'keyword_not_eligible: the post''s service is not the keyword''s service.';
  end if;
  select * into v from services where id = k.service_id and client_id = p_client_id;
  if v.id is null or v.status::text <> 'approved' then return 'keyword_not_eligible: the keyword''s service is not approved.'; end if;
  if p_brand_workspace_id is not null then
    select * into ws from client_brand_workspaces where id = p_brand_workspace_id and client_id = p_client_id;
    if ws.id is null or not (v.id = any(ws.service_ids)) then
      return 'keyword_not_eligible: the keyword''s service belongs to another brand site.';
    end if;
    site := ws.website_url;
  else
    select website_url into site from clients where id = p_client_id;
  end if;
  norm_page := lower(regexp_replace(regexp_replace(v.page_url, '^(https?://)www\.', '\1'), '/+$', ''));
  if v.page_url is null or v.page_url !~ '^https://\S+$'
     or lower(regexp_replace(substring(v.page_url from '^https?://([^/:?#]+)'), '^www\.', ''))
        is distinct from lower(regexp_replace(substring(site from '^https?://([^/:?#]+)'), '^www\.', ''))
     or not exists (select 1 from page_groups g where g.client_id = p_client_id and g.status = 'approved'
                      and lower(regexp_replace(regexp_replace(g.target_url, '^(https?://)www\.', '\1'), '/+$', '')) = norm_page) then
    return 'keyword_not_eligible: the service''s owner page is not on the site with an approved page group.';
  end if;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.core_keyword_grounding(p_client_id uuid, p_keyword_id uuid)
 RETURNS TABLE(list_id uuid, list_version integer, core_keyword_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The keyword's program: the brand site that owns its service (multi-brand
  -- clients), else the client. Only that program's approved list counts, so
  -- a keyword of one BHG site never qualifies through another site's list.
  with k as (
    select k.id, k.core_parent_keyword_id,
           case when exists (select 1 from client_brand_workspaces x where x.client_id = k.client_id)
                then (select w.id from client_brand_workspaces w where w.client_id = k.client_id and k.service_id = any(w.service_ids)) end as program,
           exists (select 1 from client_brand_workspaces x where x.client_id = k.client_id) as multi
    from keywords k where k.id = p_keyword_id and k.client_id = p_client_id and k.is_active
  )
  select l.id, l.version, case when k.id = any(l.keyword_ids) then k.id else pk.id end
  from k
  join core_keyword_lists l on l.client_id = p_client_id and l.status = 'approved'
   and l.brand_workspace_id is not distinct from k.program and (not k.multi or k.program is not null)
  left join keywords pk on pk.id = k.core_parent_keyword_id and pk.client_id = p_client_id and pk.is_active
  where k.id = any(l.keyword_ids) or pk.id = any(l.keyword_ids)
$function$
;

CREATE OR REPLACE FUNCTION public.core_keyword_link_once(p_client_id uuid, p_keyword_id uuid, p_post uuid, p_draft uuid, p_change uuid, p_plan_item uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare g record;
begin
  select * into g from core_keyword_grounding(p_client_id, p_keyword_id);
  if g.list_id is null then return; end if;
  if not exists (select 1 from core_keyword_links c
                  where c.list_id = g.list_id and c.list_version = g.list_version and c.keyword_id = p_keyword_id
                    and (c.social_post_id = p_post or c.content_draft_id = p_draft or c.change_log_id = p_change)) then
    insert into core_keyword_links (client_id, list_id, list_version, keyword_id, core_keyword_id, social_post_id, content_draft_id, change_log_id, plan_item_id)
    values (p_client_id, g.list_id, g.list_version, p_keyword_id, g.core_keyword_id, p_post, p_draft, p_change, p_plan_item);
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.core_keyword_lists_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare n int; multi boolean; ws client_brand_workspaces;
begin
  if tg_op = 'DELETE' then
    raise exception 'A core keyword list is kept; propose a new version instead' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' or new.approved_by is not null or new.approved_at is not null then
      raise exception 'A core keyword list starts as a proposal' using errcode = '23514';
    end if;
    select count(distinct k.id) into n from keywords k
     where k.client_id = new.client_id and k.is_active and k.id = any(new.keyword_ids);
    if n <> cardinality(new.keyword_ids) then
      raise exception 'Every core keyword is a distinct, active keyword of this client' using errcode = '23514';
    end if;
    multi := exists (select 1 from client_brand_workspaces w where w.client_id = new.client_id);
    if multi and new.brand_workspace_id is null then
      raise exception 'A multi-brand client''s core list names its brand site' using errcode = '23514';
    elsif not multi and new.brand_workspace_id is not null then
      raise exception 'A single-site client''s core list names no brand site' using errcode = '23514';
    end if;
    if multi then
      select * into ws from client_brand_workspaces where id = new.brand_workspace_id and client_id = new.client_id;
      if ws.id is null then
        raise exception 'The brand site belongs to another client' using errcode = '23514';
      end if;
      if exists (select 1 from keywords k where k.id = any(new.keyword_ids)
                  and (k.service_id is null or not (k.service_id = any(ws.service_ids)))) then
        raise exception 'Every core keyword of % is for a service of that site', ws.name using errcode = '23514';
      end if;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('core-list:' || new.client_id::text, 0));
    select coalesce(max(version), 0) + 1 into new.version from core_keyword_lists
     where client_id = new.client_id and brand_workspace_id is not distinct from new.brand_workspace_id;
    new.proposed_at := now();
    return new;
  end if;
  if (new.id, new.client_id, new.brand_workspace_id, new.version, new.keyword_ids, new.source_ref, new.proposed_at)
     is distinct from (old.id, old.client_id, old.brand_workspace_id, old.version, old.keyword_ids, old.source_ref, old.proposed_at) then
    raise exception 'A core keyword list does not change; propose a new version' using errcode = '42501';
  end if;
  if new.status = old.status then
    if (new.approved_by, new.approved_at) is distinct from (old.approved_by, old.approved_at) then
      raise exception 'Approval attribution is not editable' using errcode = '42501';
    end if;
  elsif old.status = 'proposed' and new.status = 'approved' then
    if not post_caller_is_human() then
      raise exception 'Only a signed-in teammate approves a core keyword list' using errcode = '42501';
    end if;
    -- Exactly 50 valid keywords, judged now (not at proposal): distinct,
    -- active, with a recorded intent, and for a brand site a service that
    -- site owns. An incomplete list stays a visible proposal.
    select count(distinct k.id) into n from keywords k
     where k.id = any(new.keyword_ids) and k.client_id = new.client_id and k.is_active and k.intent is not null
       and (new.brand_workspace_id is null or exists (
             select 1 from client_brand_workspaces w where w.id = new.brand_workspace_id and k.service_id = any(w.service_ids)));
    if cardinality(new.keyword_ids) <> 50 or n <> 50 then
      raise exception 'core_list_incomplete: a core keyword list is approved with exactly 50 valid keywords (active, intent recorded, the site''s own services); this one has % valid of %',
        n, cardinality(new.keyword_ids) using errcode = '23514';
    end if;
    new.approved_by := task_actor(); new.approved_at := now();
    perform set_config('compass.core_supersede', 'on', true);
    update core_keyword_lists set status = 'superseded'
     where client_id = new.client_id and brand_workspace_id is not distinct from new.brand_workspace_id
       and status = 'approved' and id <> new.id;
    perform set_config('compass.core_supersede', '', true);
    -- Weekly rank tracking follows the approved site lists: the union of
    -- this client's approved lists (this one included). Nothing is deleted.
    update keywords k set is_tracked = (k.id = any(new.keyword_ids) or exists (
             select 1 from core_keyword_lists l where l.client_id = new.client_id and l.status = 'approved'
               and l.id <> new.id and l.brand_workspace_id is distinct from new.brand_workspace_id and k.id = any(l.keyword_ids)))
     where k.client_id = new.client_id and k.is_active;
  elsif new.status = 'superseded' then
    -- Withdrawn proposal or revoked approval (a teammate), or replaced by a newer approval.
    if not post_caller_is_human() and coalesce(current_setting('compass.core_supersede', true), '') <> 'on' then
      raise exception 'Only a signed-in teammate withdraws or revokes a core keyword list' using errcode = '42501';
    end if;
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
  else
    raise exception 'A core keyword list moves proposed → approved → superseded only' using errcode = '23514';
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.core_keyword_record(p_client_id uuid, p_keyword_id uuid, p_kind text, p_ref uuid, p_plan_item_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare g record;
begin
  if p_kind not in ('social_post', 'content_draft', 'change_log') or p_ref is null then
    raise exception 'Record a social_post, content_draft or change_log' using errcode = '22023';
  end if;
  select * into g from core_keyword_grounding(p_client_id, p_keyword_id);
  if g.list_id is null then
    raise exception 'core_keyword_required: the keyword is not in the approved core keyword list and names no core parent' using errcode = '22023';
  end if;
  insert into core_keyword_links (client_id, list_id, list_version, keyword_id, core_keyword_id,
                                  social_post_id, content_draft_id, change_log_id, plan_item_id)
  values (p_client_id, g.list_id, g.list_version, p_keyword_id, g.core_keyword_id,
          case when p_kind = 'social_post' then p_ref end, case when p_kind = 'content_draft' then p_ref end,
          case when p_kind = 'change_log' then p_ref end, p_plan_item_id);
  return jsonb_build_object('list_id', g.list_id, 'list_version', g.list_version, 'core_keyword_id', g.core_keyword_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.core_keyword_social_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_problem text;
begin
  if core_keyword_social_governed(tg_op, new, case when tg_op = 'UPDATE' then old end) and not core_keyword_exempt(new.client_id) then
    if new.keyword_id is null then
      raise exception 'core_keyword_required: a post in review names a keyword of its site''s approved core keyword list' using errcode = '23514';
    end if;
    v_problem := coalesce(core_keyword_eligibility(new.client_id, core_site_of_service(new.client_id, new.service_id), new.keyword_id, new.service_id),
                          core_market_problem(new.client_id, new.social_account_id, new.keyword_id));
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '23514';
    end if;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.drafter_write(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_client uuid := (p->>'client_id')::uuid;
  v_brief jsonb := p->'brief';
  v_target jsonb := v_brief->'target';
  v_copy text := p->>'copy';
  v_claims uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'claim_ids', '[]')) x), '{}');
  v_assets uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'asset_ids', '[]')) x), '{}');
  v_allowed uuid[];
  v_service uuid := nullif(v_target->'service'->>'id', '')::uuid;
  v_page text;
  v_cta_type text := nullif(v_target->'cta'->>'type', '');
  v_cta_url text := nullif(v_target->'cta'->>'url', '');
  v_run uuid;
  v_post uuid;
  v_task uuid;
  i int;
  -- 0053: an Authority hand-off
  v_opp uuid := nullif(p->>'authority_opportunity_id', '')::uuid;
  o authority_opportunities;
  v_req tasks;
  v_latest uuid;
  v_site text;
  v_pref uuid[];
  v_evidence uuid[];
  -- 0054
  v_policy text;
  -- Facebook drafts (20261011040000)
  v_channel text := coalesce(v_target->>'channel', '');
  v_account uuid;
begin
  if not drafter_caller_is_service() then
    raise exception 'drafter_write runs only in the post-drafter function' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.drafter_write', 'on', true);

  if v_client is null or v_brief is null or v_target is null or nullif(btrim(coalesce(v_copy, '')), '') is null then
    raise exception 'drafter_write needs client_id, brief, target and copy' using errcode = 'check_violation';
  end if;
  if (v_brief->'client'->>'id')::uuid is distinct from v_client then
    raise exception 'The brief is for another client' using errcode = 'check_violation';
  end if;
  if coalesce((p->'lint'->>'ok')::boolean, false) is not true then
    raise exception 'Only a draft that passed the linter is written' using errcode = 'check_violation';
  end if;
  if v_channel not in ('google_business', 'facebook') then
    raise exception 'The drafter writes Business Profile and Facebook posts only' using errcode = 'check_violation';
  end if;
  -- A Facebook draft: a standard post with no button, on one of this
  -- client's Facebook Pages named explicitly by the brief, with at most one
  -- image that is a stored, hashed brand asset of this client. Authority
  -- hand-offs stay Business Profile only.
  if v_channel = 'facebook' then
    if coalesce(v_target->>'post_type', '') <> 'standard' or nullif(v_target->'offer'->>'id', '') is not null then
      raise exception 'A drafted Facebook post is a standard post' using errcode = 'check_violation';
    end if;
    if v_cta_type is not null or v_cta_url is not null then
      raise exception 'Facebook posts carry no button' using errcode = 'check_violation';
    end if;
    if v_opp is not null then
      raise exception 'Authority hand-offs draft Business Profile posts only' using errcode = 'check_violation';
    end if;
    v_account := nullif(v_target->'social_account'->>'id', '')::uuid;
    if v_account is null or not exists (select 1 from social_accounts
                                         where id = v_account and client_id = v_client and platform::text = 'facebook') then
      raise exception 'A Facebook draft names one of this client''s Facebook Pages' using errcode = 'check_violation';
    end if;
    if cardinality(v_assets) > 1 then
      raise exception 'Facebook posts take one image in v1' using errcode = 'check_violation';
    end if;
    if exists (select 1 from unnest(v_assets) x
                left join brand_assets b on b.id = x and b.client_id = v_client
               where b.id is null or b.storage_path is null or b.content_hash is null
                  or b.kind::text not in ('photo', 'social_post')) then
      raise exception 'A Facebook image is a stored, hashed photo or social graphic of this client' using errcode = 'check_violation';
    end if;
  end if;
  -- core_keyword_gate_v1: every draft (worker, operator or teammate) is for a
  -- keyword of its target site's approved core list, with that keyword's own
  -- service, page and site; no approved list (absent, proposed or revoked) → refused.
  declare v_core_problem text := core_keyword_eligibility(v_client, core_site_of_service(v_client, v_service),
                                                          nullif(v_target->'keyword'->>'id', '')::uuid, v_service);
  begin
    if core_keyword_exempt(v_client) and coalesce(p->>'claimant', '') not like 'worker-routine:%' then
      null;  -- Tom's recorded exception; unattended runs are never exempt
    elsif nullif(v_target->'keyword'->>'id', '') is null then
      raise exception 'core_keyword_required: a draft names a keyword of its site''s approved core keyword list' using errcode = 'check_violation';
    elsif v_core_problem is not null then
      raise exception '%', v_core_problem using errcode = 'check_violation';
    end if;
  end;
  -- Claims: only ones the brief allowed.
  select coalesce(array_agg((c->>'id')::uuid), '{}') into v_allowed
    from jsonb_array_elements(coalesce(v_brief->'allowed_facts'->'claims', '[]')) c;
  if not (v_claims <@ v_allowed) then
    raise exception 'A linked claim is not in the brief' using errcode = 'check_violation';
  end if;
  if v_channel = 'google_business' and cardinality(v_assets) > 1 then
    raise exception 'Business Profile posts take one photo in v1' using errcode = 'check_violation';
  end if;
  -- The button goes to the service's own page.
  if v_service is not null then
    select page_url into v_page from services where id = v_service and client_id = v_client and status = 'approved';
    if v_page is null then
      raise exception 'The target service is not an approved service of this client with a page' using errcode = 'check_violation';
    end if;
    if v_cta_type is not null and v_cta_type <> 'CALL'
       and rtrim(lower(v_cta_url), '/') is distinct from rtrim(lower(v_page), '/') then
      raise exception 'The button must link to the service page' using errcode = 'check_violation';
    end if;
  end if;
  -- 0053: a draft for an Authority opportunity. Authority only narrows: every
  -- check above still applies, and each of these refuses (AU409, nothing
  -- written) when the opportunity and the Drafter's own target disagree, when
  -- the recommendation is no longer current, or when no teammate asked.
  if v_opp is not null then
    select * into o from authority_opportunities where id = v_opp for update;
    if o.id is null or o.client_id is distinct from v_client then
      raise exception 'authority_conflict opportunity_not_found: No such Authority opportunity for this client' using errcode = 'AU409';
    end if;
    select r.id, r.inventory->>'site' into v_latest, v_site from authority_runs r
     where r.client_id = v_client and r.status = 'completed' order by r.finished_at desc, r.id limit 1;
    if not o.present or o.last_seen_run_id is distinct from v_latest then
      raise exception 'authority_conflict opportunity_not_current: The latest analysis no longer reports this opportunity' using errcode = 'AU409';
    end if;
    if nullif(p->>'authority_run_id', '') is not null and (p->>'authority_run_id')::uuid is distinct from o.last_seen_run_id then
      raise exception 'authority_conflict authority_stale: Requested against analysis run %, the current one is %', p->>'authority_run_id', o.last_seen_run_id using errcode = 'AU409';
    end if;
    if o.status = 'dismissed' then
      raise exception 'authority_conflict dismissed: The opportunity is dismissed' using errcode = 'AU409';
    end if;
    if o.content_type is distinct from 'gbp_post' or o.section <> 'ready' or o.action <> 'create' then
      raise exception 'authority_conflict not_ready: The analysis does not mark this post ready to create' using errcode = 'AU409';
    end if;
    if o.eligible_from is not null and o.eligible_from > (now() at time zone 'America/Chicago')::date then
      raise exception 'authority_conflict cadence_active: Not eligible until %', o.eligible_from using errcode = 'AU409';
    end if;
    if o.key is distinct from format('gbp_post:%s:%s', v_service, v_target->>'search_intent')
       or o.service_id is distinct from v_service or o.intent is distinct from v_target->>'search_intent'
       or o.keyword_id is distinct from nullif(v_target->'keyword'->>'id', '')::uuid
       or coalesce(v_target->>'post_type', '') <> 'standard' or nullif(v_target->'offer'->>'id', '') is not null
       or (o.opportunity->'target'->>'cta') is distinct from v_cta_type
       or o.target_path is distinct from authority_norm_path(v_page, v_site) then
      raise exception 'authority_conflict target_mismatch: The Drafter''s target differs from the Authority opportunity' using errcode = 'AU409';
    end if;
    if (v_brief->'authority'->>'opportunity_id') is distinct from v_opp::text then
      raise exception 'authority_conflict brief_mismatch: The brief was not built for this Authority opportunity' using errcode = 'AU409';
    end if;
    select coalesce(array_agg(x::uuid), '{}') into v_pref from jsonb_array_elements_text(coalesce(v_brief->'authority'->'preferred_claim_ids', '[]')) x;
    select coalesce(array_agg(x::uuid), '{}') into v_evidence from jsonb_array_elements_text(coalesce(o.opportunity->'evidence_claim_ids', '[]')) x;
    if not (v_pref <@ v_evidence and v_evidence <@ v_pref) or not (v_pref <@ v_allowed) then
      raise exception 'authority_conflict evidence_ineligible: Authority''s preferred evidence is not the analysis''s, or not a claim the brief allows' using errcode = 'AU409';
    end if;
    if exists (select 1 from authority_opportunity_links l
                where l.opportunity_id = o.id and l.kind = 'social_post'
                  and l.created_at >= coalesce(o.cycle_started_at, '-infinity'::timestamptz)
                  and authority_link_state(l) in ('active', 'done')) then
      raise exception 'authority_conflict already_in_progress: A draft for this opportunity is already in review or approved' using errcode = 'AU409';
    end if;
    select * into v_req from tasks
     where client_id = v_client and key = 'authority_draft:' || o.id and status in ('open', 'in_progress') for update;
    if v_req.id is null
       or not exists (select 1 from authority_opportunity_events e
                       where e.opportunity_id = o.id and e.kind = 'decision' and e.actor_kind = 'team'
                         and e.detail->>'action' = 'request_draft' and e.detail->>'task_id' = v_req.id::text) then
      raise exception 'authority_conflict not_requested: No open Draft with AI request from a teammate for this opportunity' using errcode = 'AU409';
    end if;
    -- authority_draft_claims_v1: a live claim on the request binds the write.
    if v_req.claimed_by is not null and v_req.claimed_at > now() - interval '1 hour'
       and v_req.claimed_by is distinct from nullif(btrim(coalesce(p->>'claimant', '')), '') then
      raise exception 'claimed_by_other: % holds this Draft with AI request until %', v_req.claimed_by, v_req.claimed_at + interval '1 hour'
        using errcode = 'CD409';
    end if;
    -- Cadence, live (the analysis may be older than the last post).
    if exists (select 1 from social_posts sp
                where sp.client_id = v_client and sp.platform::text = 'google_business' and sp.service_id = v_service
                  and sp.search_intent = v_target->>'search_intent'
                  and (sp.review_status in ('draft', 'in_review', 'approved') or sp.publish_status::text = 'published')
                  and sp.created_at > now() - interval '21 days') then
      raise exception 'authority_conflict cadence_active: A post for this service and intent was created in the last 21 days' using errcode = 'AU409';
    end if;
  end if;

  -- One open drafter post per client, channel, service and intent (Business
  -- Profile). A Facebook queue holds one open draft per concept instead: no
  -- two open drafted Facebook posts with the same copy or the same image.
  if v_channel = 'facebook' and exists (
       select 1 from social_posts sp
        where sp.client_id = v_client and sp.drafter_run_id is not null and sp.platform::text = 'facebook'
          and sp.review_status in ('draft', 'in_review')
          and (drafter_copy_hash(sp.copy) = drafter_copy_hash(v_copy)
               or exists (select 1 from post_assets pa where pa.post_id = sp.id and pa.brand_asset_id = any (v_assets)))) then
    raise exception 'An open drafted Facebook post already has this copy or this image' using errcode = 'unique_violation';
  end if;
  if v_channel = 'google_business' and exists (select 1 from social_posts
             where client_id = v_client and drafter_run_id is not null
               and platform::text = v_target->>'channel' and service_id is not distinct from v_service
               and search_intent = v_target->>'search_intent' and review_status in ('draft', 'in_review')) then
    raise exception 'An open drafted post already exists for this service and intent' using errcode = 'unique_violation';
  end if;


  -- drafter_gbp_destination_v2 (20261027150000): the location the draft names
  -- (one of this client's verified Zernio locations), else the client's only
  -- one. Never chosen between several, never another client's.
  if v_channel = 'google_business' then
    v_account := nullif(v_target->'social_account'->>'id', '')::uuid;
    if v_account is not null then
      perform 1 from social_accounts
       where id = v_account and client_id = v_client and platform::text = 'google_business'
         and publish_provider = 'zernio'
         and nullif(btrim(publish_account_id), '') is not null
         and nullif(btrim(publish_page_id), '') is not null
         and publish_verified_at is not null
       for share;
      if not found then
        raise exception 'A Business Profile draft names one of this client''s verified locations' using errcode = 'check_violation';
      end if;
    elsif exists (
      select 1 from publisher_client_transports
       where client_id = v_client and gbp_transport = 'zernio'
    ) then
      begin
        select id into strict v_account
          from social_accounts
         where client_id = v_client and platform::text = 'google_business'
           and publish_provider = 'zernio'
           and nullif(btrim(publish_account_id), '') is not null
           and nullif(btrim(publish_page_id), '') is not null
           and publish_verified_at is not null
         for share;
      exception
        when no_data_found then
          raise exception 'A Zernio Business Profile draft needs the client''s verified location binding' using errcode = 'check_violation';
        when too_many_rows then
          raise exception 'This client has several Business Profile locations; the draft names one (social_account)' using errcode = 'check_violation';
      end;
    end if;
  end if;

  insert into drafter_runs (client_id, requested_via, requested_by, target, brief_version, brief_hash, brief,
                            claim_ids, runtime, attempt, lint, copy_hash, status, authority_opportunity_id)
  values (v_client, coalesce(p->>'requested_via', 'worker'), nullif(p->>'requested_by', '')::uuid, v_target,
          p->>'brief_version', p->>'brief_hash', v_brief, v_claims, p->>'runtime',
          coalesce((p->>'attempt')::int, 1), p->'lint', drafter_copy_hash(v_copy), 'writing', v_opp)
  returning id into v_run;

  insert into social_posts (client_id, platform, post_type, search_intent, service_id, keyword_id, offer_id,
                            cta_type, cta_url, copy, crm_facts_only, drafter_run_id, social_account_id)
  values (v_client, (v_target->>'channel')::social_platform, v_target->>'post_type', v_target->>'search_intent',
          v_service, nullif(v_target->'keyword'->>'id', '')::uuid, nullif(v_target->'offer'->>'id', '')::uuid,
          v_cta_type, v_cta_url, v_copy, false, v_run, v_account)
  returning id into v_post;

  insert into post_claims (post_id, client_id, claim_id)
  select v_post, v_client, c from unnest(v_claims) c;
  i := 0;
  while i < cardinality(v_assets) loop
    i := i + 1;
    insert into post_assets (post_id, client_id, brand_asset_id, sort_order) values (v_post, v_client, v_assets[i], i);
  end loop;

  -- 0054: a post whose client and channel require creative stays a draft
  -- (creative_status 'needed'); the Creative Engine submits it with its
  -- creative. Policy none / optional: submitted exactly as before.
  select creative_policy into v_policy from social_posts where id = v_post;
  if v_policy is distinct from 'required' then
    update social_posts set review_status = 'in_review' where id = v_post returning review_task_id into v_task;
  end if;
  update drafter_runs set status = 'submitted', post_id = v_post where id = v_run;

  -- 0053: the post drives the opportunity's lifecycle (in review → in
  -- progress, approved → completed); the request is done, not linked.
  if v_opp is not null then
    perform authority_decide(v_opp, 'link', jsonb_build_object('kind', 'social_post', 'id', v_post));
    update tasks set status = 'done', completed_at = now(),
      notes = coalesce(notes || E'\n', '') || format('Drafted: post %s (drafter run %s), %s.', v_post, v_run,
                     case when v_policy = 'required' then 'waiting for its creative' else 'now in review' end)
     where id = v_req.id;
  end if;

  return jsonb_build_object('run_id', v_run, 'post_id', v_post, 'review_task_id', v_task, 'social_account_id', v_account,
    'authority_opportunity_id', v_opp, 'request_task_id', v_req.id, 'creative_policy', v_policy);
end $function$
;

CREATE OR REPLACE FUNCTION public.social_slot_link(p_task_id uuid, p_post_id uuid, p_claimant text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  t tasks; i content_plan_items; p social_posts; r record; g jsonb;
  v_who text := btrim(coalesce(p_claimant, ''));
  v_url text; v_problem text;
begin
  select * into t from tasks where id = p_task_id for update;
  if t.id is null or t.key not like 'social\_slot:%' then
    raise exception 'No such social slot task' using errcode = 'P0002';
  end if;
  if t.status = 'done' then
    raise exception 'The social slot task is already done' using errcode = '22023';
  end if;
  if not social_slot_claimant_ok(v_who) or t.claimed_by is distinct from v_who or t.claimed_at <= now() - interval '1 hour' then
    raise exception 'claimed_by_other: claim the task with this run''s token before linking' using errcode = 'CD409';
  end if;
  select * into i from content_plan_items where id = substring(t.key from 13)::uuid and client_id = t.client_id for update;
  if i.id is null then
    raise exception 'The slot this task names no longer exists' using errcode = '22023';
  end if;
  select * into r from social_slot_readiness(t.client_id, i.planned_date, i.planned_date) x where x.plan_item_id = i.id;
  if not coalesce(r.ready, false) then
    raise exception 'not_ready: %', coalesce(r.reason, 'the slot is no longer eligible') using errcode = '22023';
  end if;
  select * into p from social_posts where id = p_post_id for update;
  if p.id is null or p.client_id <> t.client_id then
    raise exception 'No such post for this client' using errcode = 'P0002';
  elsif p.platform::text is distinct from i.channel::text then
    raise exception 'The post is for %, the slot is for %', p.platform, i.channel using errcode = '22023';
  elsif p.review_status::text <> 'in_review' or p.drafter_run_id is null or p.created_at < t.created_at then
    raise exception 'Only a governed draft written for this task, still in review, can fill the slot' using errcode = '22023';
  elsif exists (select 1 from content_plan_items x where x.social_post_id = p.id and x.id <> i.id) then
    raise exception 'The post already fills another slot' using errcode = '23505';
  end if;
  if p.social_account_id is distinct from r.social_account_id then
    raise exception 'The post is not addressed to the slot''s verified destination' using errcode = '22023';
  end if;
  if i.brand_workspace_id is not null and not exists (
       select 1 from client_brand_workspaces w where w.id = i.brand_workspace_id and p.service_id = any(w.service_ids)) then
    raise exception 'The post''s service belongs to another brand site' using errcode = '22023';
  end if;
  -- The post's own keyword and service, judged now: another usable core
  -- keyword never vouches for it.
  v_problem := core_keyword_eligibility(t.client_id, i.brand_workspace_id, p.keyword_id, p.service_id);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  v_problem := core_market_problem(t.client_id, p.social_account_id, p.keyword_id);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  -- Evidence for the current approved version (the review gate recorded it on
  -- entry; a newer version since then gets its own row).
  select jsonb_build_object('list_id', x.list_id, 'list_version', x.list_version, 'core_keyword_id', x.core_keyword_id) into g
    from core_keyword_grounding(t.client_id, p.keyword_id) x;
  if not exists (select 1 from core_keyword_links c where c.social_post_id = p.id
                  and c.list_id = (g->>'list_id')::uuid and c.list_version = (g->>'list_version')::int) then
    g := core_keyword_record(t.client_id, p.keyword_id, 'social_post', p.id, i.id);
  end if;
  select coalesce(case when p.cta_url ~ '^https?://\S+$' then p.cta_url end,
                  case when k.target_url ~ '^https?://\S+$' then k.target_url end,
                  case when v.page_url ~ '^https?://\S+$' then v.page_url end)
    into v_url
    from services v left join keywords k on k.id = p.keyword_id and k.client_id = p.client_id
   where v.id = p.service_id and v.client_id = p.client_id;
  update content_plan_items
     set social_post_id = p.id, keyword_id = coalesce(p.keyword_id, keyword_id), service_id = coalesce(p.service_id, service_id),
         search_intent = coalesce(p.search_intent, search_intent), target_url = coalesce(v_url, target_url)
   where id = i.id;
  update tasks set status = 'done', completed_at = now(),
         recommendation = left('Drafted post ' || p.id || ' into review for this slot (core list v' || (g->>'list_version') || ').', 500)
   where id = t.id;
  return jsonb_build_object('linked', true, 'plan_item_id', i.id, 'post_id', p.id, 'task_id', t.id,
                            'social_account_id', p.social_account_id, 'review_task_id', p.review_task_id) || g;
end $function$
;

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
    when not exists (
      select 1 from keywords k
       where k.client_id = s.client_id and k.is_active
         and core_keyword_eligibility(s.client_id, case when s.multi then s.brand_workspace_id end, k.id) is null)
      then 'No core keyword (v' || s.list_version || ') with an intent and an approved service whose owner page is on the site with an approved page group.'
  end as reason) r
  order by s.planned_date, s.id
$function$
;

-- The two-argument loader, as before
drop function public.client_intelligence_for_content(uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION public.client_intelligence_for_content(p_client_id uuid, p_service_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare i jsonb; b client_brand_workspaces;
begin
  i:=client_intelligence_input(p_client_id);
  if not exists(select 1 from client_brand_workspaces where client_id=p_client_id) then return i; end if;
  select * into b from client_brand_workspaces where client_id=p_client_id and p_service_id=any(service_ids);
  if b.id is null then raise exception 'Select a service assigned to a brand before drafting' using errcode='23514'; end if;
  i:=jsonb_set(i,'{client}',i->'client'||jsonb_build_object('name',b.name,'phone',b.phone,'website_url',b.website_url));
  i:=jsonb_set(i,'{brand}',jsonb_build_object('positioning',b.positioning,'voice_tone',b.voice_tone,'audience',b.audience,
    'differentiators',b.differentiators,'ai_guidance',b.ai_guidance,'words_we_use',b.words_we_use,
    'words_we_avoid',b.words_we_avoid,'content_pillars',b.content_pillars,'tagline',b.tagline));
  i:=jsonb_set(i,'{board}',jsonb_build_object('id',b.id,'version',b.version,'status',b.status,'hard_rules',b.hard_rules,'standing_cta',b.standing_cta));
  i:=jsonb_set(i,'{services}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'services') x where (x->>'id')::uuid=any(b.service_ids)),'[]'));
  i:=jsonb_set(i,'{keywords}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'keywords') x where (x->>'service_id')::uuid=any(b.service_ids)),'[]'));
  i:=jsonb_set(i,'{claims}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'claims') x where (x->>'id')::uuid=any(b.claim_ids)),'[]'));
  i:=jsonb_set(i,'{assets}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'assets') x where (x->>'id')::uuid=any(b.asset_ids)),'[]'));
  i:=jsonb_set(i,'{offers}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'offers') x where (x->>'service_id')::uuid=any(b.service_ids)),'[]'));
  i:=jsonb_set(i,'{pageGroups}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'pageGroups') x where exists(
    select 1 from jsonb_array_elements(i->'keywords') k where k->>'id'=x->>'primary_keyword_id')),'[]'));
  return i||jsonb_build_object('workspace',jsonb_build_object('id',b.id,'version',b.version,'facebook_account_id',b.facebook_account_id));
end $function$
;
revoke all on function public.client_intelligence_for_content(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.client_intelligence_for_content(uuid, uuid) to authenticated;
grant execute on function public.client_intelligence_for_content(uuid, uuid) to service_role;

-- The planner board, as before
create or replace view public.content_plan_board with (security_invoker = true) as
 SELECT i.id,
    i.client_id,
    i.week_start,
    i.deliverable,
    i.channel,
    i.purpose,
    i.topic,
    i.search_intent,
    i.keyword_id,
    i.service_id,
    i.authority_opportunity_id,
    i.target_url,
    i.planned_date,
    i.social_post_id,
    i.content_post_id,
    i.output_url,
    i.hold,
    i.hold_reason,
    i.notes,
    i.created_by,
    i.updated_by,
    i.created_at,
    i.updated_at,
        CASE
            WHEN (i.hold = 'blocked'::text) THEN 'blocked'::text
            WHEN ((i.hold = 'delivered'::text) OR (sp.publish_status = 'published'::text) OR (cp.status = 'published'::content_status)) THEN 'delivered'::text
            WHEN ((sp.review_status = 'approved'::text) OR (cp.status = 'approved'::content_status) OR (dr.status = 'approved'::text)) THEN 'approved'::text
            WHEN ((sp.review_status = 'in_review'::text) OR (cp.status = 'review'::content_status) OR (dr.status = 'in_review'::text)) THEN 'in_review'::text
            WHEN ((sp.id IS NOT NULL) OR (cp.id IS NOT NULL) OR (dr.id IS NOT NULL) OR ((i.authority_opportunity_id IS NOT NULL) AND (EXISTS ( SELECT 1
               FROM tasks t
              WHERE ((t.client_id = i.client_id) AND (t.key = ('authority_draft:'::text || i.authority_opportunity_id)) AND (t.status <> 'done'::task_status)))))) THEN 'drafting'::text
            WHEN ((i.search_intent IS NOT NULL) AND (EXISTS ( SELECT 1
               FROM keywords k
              WHERE ((k.id = i.keyword_id) AND (k.client_id = i.client_id) AND k.is_active))) AND ((i.service_id IS NOT NULL) OR (i.authority_opportunity_id IS NOT NULL) OR (i.deliverable = 'blog'::text))) THEN 'ready_to_generate'::text
            ELSE 'planned'::text
        END AS status,
    sp.review_status AS post_review_status,
    sp.publish_status AS post_publish_status,
    sp.published_url AS post_published_url,
    (cp.status)::text AS content_status,
    cp.url AS content_url,
    dr.id AS draft_id,
    dr.status AS draft_status
   FROM (((content_plan_items i
     LEFT JOIN social_posts sp ON ((sp.id = i.social_post_id)))
     LEFT JOIN content_posts cp ON ((cp.id = i.content_post_id)))
     LEFT JOIN LATERAL ( SELECT x.id,
            x.status
           FROM content_drafts x
          WHERE (x.plan_item_id = i.id)
          ORDER BY x.updated_at DESC
         LIMIT 1) dr ON (true));

-- 3. The resolver and the hold matcher
drop function public.keyword_owner_context(uuid, uuid);
drop function public.keyword_owner(uuid, uuid, uuid, text);
drop function public.core_keyword_eligibility(uuid, uuid, uuid, uuid, text);
drop function public.owner_page_check_targets(uuid, uuid);
drop function public.core_site_of_keyword(uuid, uuid);
drop function public.core_owner_allows(text, text, text);
drop function public.core_promotion_hold(uuid, uuid, text, uuid, text);
drop function public.core_copy_hold(uuid, uuid, text, uuid, text);
drop function public.content_draft_hold_text(public.content_drafts);
drop function public.content_draft_program(public.content_drafts);
drop function public.core_hold_hit(text[], text);
drop function public.core_hold_tokens(text);
drop function public.core_hold_stem(text);

do $verify$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
              and p.proname in ('keyword_owner', 'core_copy_hold', 'core_hold_hit', 'promotion_hold_conflicts')) then
    raise exception 'rollback: resolver functions remain';
  end if;
  if strpos(pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure), 'core_keyword_gate_v2') > 0
     or strpos(pg_get_functiondef('public.core_keyword_social_gate()'::regprocedure), 'keyword_owner') > 0 then
    raise exception 'rollback: a patched function was not restored';
  end if;
  if exists (select 1 from pg_trigger where tgname in ('social_posts_ab_promotion_hold', 'content_drafts_ab_promotion_hold',
              'blog_publications_promotion_hold', 'change_log_ab_promotion_hold', 'content_plan_items_ab_promotion_hold')) then
    raise exception 'rollback: a copy-hold trigger remains';
  end if;
end $verify$;
