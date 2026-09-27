-- 0052 Authority reconciliation: bind every canonical write to its preview.
--
-- 0050 / 0051's reconciliation actions checked that the rows being changed
-- were as previewed, but took the value written from the page group at apply
-- time: a page group edited between the preview and the apply would have been
-- written (or a keyword removed from a group) without the teammate seeing it.
-- This redefines authority_apply with these changes, in the reconciliation
-- actions only:
--   set_service_page  p_expected.target_url must equal the service page
--                     group's target_url (the value written to services.page_url);
--   rehome_keywords   each row's expected.destination_url must equal the target
--                     written (the service page group's, or Home's), and a Home
--                     row's expected.removed_from must equal, as a set, the
--                     service / hub page groups that list the keyword (locked
--                     before comparing);
--   map_keywords      each row's expected.destination_url must equal the chosen
--                     service page group's target_url; and a keyword the
--                     analysis flags location_unapproved is refused (22023)
--                     until that market is approved and a refresh clears the flag.
-- A mismatch, or a missing field, is AU409 and, like every refusal, rolls the
-- whole call back: nothing is written. Everything else is 0051's body,
-- unchanged: the caller gate, the other actions, the grants.
--
-- Rollback: re-run 0051's authority_apply definition.

create or replace function authority_apply(p_opportunity_id uuid, p_action text, p_payload jsonb default '{}', p_expected jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  AUTHORITY_ONLY constant text := 'Authority decision only; no Client Intelligence record created.';
  o authority_opportunities;
  c clients;
  k keywords;
  loc locations;
  v_basis jsonb;
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_intent text;
  v_allowed text[];
  v_city text; v_state text; v_lat double precision; v_lng double precision;
  v_path text; v_url text; v_host text; v_site_host text; v_name text; v_segment text;
  v_id uuid;
  v_title text; v_assignee uuid;
  v_before jsonb; v_after jsonb;
  v_canonical boolean := false;
  -- 0050
  v_site text;
  v_svc services;
  g page_groups;
  hg page_groups;
  v_kw keywords;
  v_rows jsonb;
  v_row jsonb;
  v_entry jsonb;
  v_pstate jsonb;
  v_page jsonb;
  v_prefix text;
  v_route text;
  v_dest text;
  v_done jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  -- 0051
  v_removed jsonb;
  -- 0052
  v_removed_ids uuid[];
  v_exp_ids uuid[];
begin
  -- A signed-in teammate through PostgREST, and nobody else.
  if not (session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'authenticated' and is_team()) then
    raise exception 'Only a signed-in Compass teammate applies Authority decisions' using errcode = '42501';
  end if;
  if p_action not in ('keep_intent', 'set_intent', 'approve_market', 'decline_market', 'confirm_service', 'not_offered', 'create_task',
                      'set_service_page', 'rehome_keywords', 'record_content', 'map_keywords') then
    raise exception 'Unknown Authority decision %', p_action using errcode = '22023';
  end if;

  o := authority_lock_opportunity(p_opportunity_id);
  select * into c from clients where id = o.client_id;
  if c.id is null then raise exception 'No such client' using errcode = 'P0002'; end if;
  if c.status = 'offboarded' then raise exception 'This client is offboarded' using errcode = '22023'; end if;

  -- Changed since the preview: the run, the workflow, presence.
  if not o.present then
    raise exception 'Changed since the preview: the latest analysis no longer reports this' using errcode = 'AU409';
  end if;
  if (p_expected->>'run_id')::uuid is distinct from o.last_seen_run_id
     or (p_expected->>'status') is distinct from o.status
     or (p_expected->>'suppressed')::boolean is distinct from o.suppressed
     or nullif(p_expected->>'dismissed_until', '')::date is distinct from o.dismissed_until then
    raise exception 'Changed since the preview: the opportunity was re-analysed or decided meanwhile' using errcode = 'AU409';
  end if;
  if o.status = 'dismissed' then
    raise exception 'Reopen this opportunity before deciding it' using errcode = '22023';
  end if;

  case p_action
  -- ── Intent ──────────────────────────────────────────────────────────────
  when 'keep_intent', 'set_intent' then
    if o.key not like 'confirm\_intent:%' then raise exception '% applies to an intent conflict', p_action using errcode = '22023'; end if;
    v_basis := authority_recommendation_basis(o.key, o.opportunity);
    select * into k from keywords where id = (v_basis->>'keyword_id')::uuid and client_id = o.client_id for update;
    if k.id is null then raise exception 'The keyword is gone' using errcode = 'AU409'; end if;
    if (p_expected->>'intent') is distinct from k.intent then
      raise exception 'Changed since the preview: the keyword''s intent is now %', coalesce(k.intent, 'none') using errcode = 'AU409';
    end if;
    if k.intent is distinct from (v_basis->>'stored') then
      raise exception 'Changed since the analysis: the stored intent is now %; refresh first', coalesce(k.intent, 'none') using errcode = 'AU409';
    end if;
    if p_action = 'keep_intent' then
      perform authority_decide(o.id, 'decision', jsonb_build_object('decision', format('Keep the current intent (%s)', k.intent),
        'action', 'keep_intent', 'keyword_id', k.id, 'keyword', k.keyword, 'intent', k.intent, 'recommendation', v_basis));
      perform authority_decide(o.id, 'suppress', jsonb_build_object(
        'reason', coalesce(v_reason, format('Intent kept as %s; the engine read the query as %s', k.intent, v_basis->>'assessed')),
        'basis', v_basis));
    else
      v_intent := lower(btrim(coalesce(p_payload->>'intent', '')));
      v_allowed := case v_basis->>'assessed'
        when 'navigational' then array['navigational'] when 'informational' then array['informational']
        when 'commercial or transactional' then array['commercial', 'transactional'] else array[]::text[] end;
      if not (v_intent = any (v_allowed)) then
        raise exception 'The recommended intent is %; % is not it', v_basis->>'assessed', coalesce(nullif(v_intent, ''), 'nothing') using errcode = '22023';
      end if;
      update keywords set intent = v_intent where id = k.id and client_id = o.client_id;
      v_canonical := true;
      perform authority_decide(o.id, 'decision', jsonb_build_object('decision', format('Change the intent to %s', v_intent),
        'action', 'set_intent', 'keyword_id', k.id, 'keyword', k.keyword, 'recommendation', v_basis,
        'before', jsonb_build_object('keywords.intent', k.intent), 'after', jsonb_build_object('keywords.intent', v_intent)));
    end if;

  -- ── Markets ─────────────────────────────────────────────────────────────
  when 'approve_market' then
    if o.key not like 'confirm\_market:%' then raise exception 'approve_market applies to a market decision' using errcode = '22023'; end if;
    v_city := btrim(coalesce(p_payload->>'city', ''));
    v_state := upper(btrim(coalesce(p_payload->>'state', '')));
    v_lat := (p_payload->>'lat')::double precision;
    v_lng := (p_payload->>'lng')::double precision;
    if v_city = '' or length(v_city) > 100 or v_state !~ '^[A-Z]{2}$' then
      raise exception 'A market needs a city and a two-letter state' using errcode = '22023';
    end if;
    if v_lat is null or v_lng is null or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
      raise exception 'A market needs its coordinates (rank checks use them)' using errcode = '22023';
    end if;
    if authority_norm_place(v_city) <> authority_norm_place(o.opportunity->'target'->>'location') then
      raise exception '% is not the market this decision is about (%)', v_city, o.opportunity->'target'->>'location' using errcode = '22023';
    end if;
    select * into loc from locations
     where client_id = o.client_id and upper(coalesce(state, '')) = v_state
       and (authority_norm_place(city) = authority_norm_place(v_city) or authority_norm_place(regexp_replace(name, ',.*$', '')) = authority_norm_place(v_city))
     order by is_active desc, sort_order limit 1 for update;
    if (p_expected->>'location_id')::uuid is distinct from loc.id then
      raise exception 'Changed since the preview: the locations for % changed', v_city using errcode = 'AU409';
    end if;
    if loc.id is not null and loc.is_active then
      raise exception 'Changed since the preview: % is already an approved location', v_city using errcode = 'AU409';
    end if;
    if loc.id is null then
      insert into locations (client_id, name, city, state, lat, lng, is_active, is_physical_location, sort_order)
      values (o.client_id, format('%s, %s', v_city, v_state), v_city, v_state, v_lat, v_lng, true, false,
              coalesce((select max(sort_order) + 1 from locations where client_id = o.client_id), 0))
      returning id into v_id;
      v_before := jsonb_build_object('locations', null);
    else
      update locations set is_active = true, lat = coalesce(lat, v_lat), lng = coalesce(lng, v_lng) where id = loc.id and client_id = o.client_id;
      v_id := loc.id;
      v_before := jsonb_build_object('locations', jsonb_build_object('id', loc.id, 'is_active', false, 'lat', loc.lat, 'lng', loc.lng));
    end if;
    v_after := (select jsonb_build_object('locations', jsonb_build_object('id', l.id, 'name', l.name, 'city', l.city, 'state', l.state,
                'lat', l.lat, 'lng', l.lng, 'is_active', l.is_active)) from locations l where l.id = v_id);
    v_canonical := true;
    perform authority_decide(o.id, 'decision', jsonb_build_object('decision', format('Approve %s, %s as a market', v_city, v_state),
      'action', 'approve_market', 'location_id', v_id, 'before', v_before, 'after', v_after));

  when 'decline_market', 'not_offered' then
    if p_action = 'decline_market' and o.key not like 'confirm\_market:%' then
      raise exception 'decline_market applies to a market decision' using errcode = '22023';
    end if;
    if p_action = 'not_offered' and o.key not like 'confirm\_service:%' then
      raise exception 'not_offered applies to a service decision' using errcode = '22023';
    end if;
    if v_reason is null then raise exception 'A reason is required' using errcode = '22023'; end if;
    perform authority_decide(o.id, 'decision', jsonb_build_object(
      'decision', case p_action when 'decline_market' then 'Decline this market' else 'Not a service they offer' end,
      'action', p_action, 'reason', v_reason, 'note', AUTHORITY_ONLY, 'client_intelligence_record', false));
    perform authority_decide(o.id, 'suppress', jsonb_build_object('reason', format('%s %s', v_reason, AUTHORITY_ONLY)));

  -- ── Services ────────────────────────────────────────────────────────────
  when 'confirm_service' then
    if o.key not like 'confirm\_service:%' then raise exception 'confirm_service applies to a service decision' using errcode = '22023'; end if;
    v_path := rtrim(substring(o.key from length('confirm_service:') + 1), '/');
    v_name := btrim(coalesce(p_payload->>'name', ''));
    v_segment := nullif(btrim(coalesce(p_payload->>'segment', '')), '');
    v_url := btrim(coalesce(p_payload->>'page_url', ''));
    if v_name = '' or length(v_name) > 120 then raise exception 'A service needs a name' using errcode = '22023'; end if;
    v_host := lower(regexp_replace(substring(v_url from '^https?://([^/?#]+)'), '^www\.', ''));
    v_site_host := lower(regexp_replace(substring(coalesce(c.website_url, '') from '^https?://([^/?#]+)'), '^www\.', ''));
    if v_host is null or v_site_host is null or v_host <> v_site_host then
      raise exception 'The page must be on the client''s website (%)', coalesce(v_site_host, 'no website recorded') using errcode = '22023';
    end if;
    if rtrim(coalesce(substring(v_url from '^https?://[^/?#]+(/[^?#]*)'), '/'), '/') <> v_path then
      raise exception 'The page must be % (the page this decision is about)', v_path using errcode = '22023';
    end if;
    perform 1 from services where client_id = o.client_id for update;
    select id into v_id from services s
     where s.client_id = o.client_id and s.status <> 'retired'
       and (lower(s.name) = lower(v_name) or rtrim(coalesce(substring(s.page_url from '^https?://[^/?#]+(/[^?#]*)'), ''), '/') = v_path)
     limit 1;
    if v_id is not null or (p_expected ? 'service_id' and (p_expected->>'service_id') is not null) then
      raise exception 'Changed since the preview: a service with that name or page already exists' using errcode = 'AU409';
    end if;
    insert into services (client_id, name, segment, page_url, status, page_type, sort_order)
    values (o.client_id, v_name, v_segment, v_url, 'approved', 'service',
            coalesce((select max(sort_order) + 1 from services where client_id = o.client_id), 0))
    returning id into v_id;
    v_canonical := true;
    perform authority_decide(o.id, 'decision', jsonb_build_object('decision', format('Confirm %s as a service', v_name),
      'action', 'confirm_service', 'service_id', v_id, 'before', jsonb_build_object('services', null),
      'after', jsonb_build_object('services', jsonb_build_object('id', v_id, 'name', v_name, 'segment', v_segment, 'page_url', v_url, 'status', 'approved'))));

  -- ── Work ────────────────────────────────────────────────────────────────
  when 'create_task' then
    v_title := btrim(coalesce(p_payload->>'title', ''));
    if v_title = '' or length(v_title) > 200 then raise exception 'A task needs a title' using errcode = '22023'; end if;
    v_assignee := nullif(p_payload->>'assignee_id', '')::uuid;
    if v_assignee is not null and not exists (select 1 from team_members where id = v_assignee) then
      raise exception 'The assignee is not on the team' using errcode = '22023';
    end if;
    if exists (select 1 from authority_opportunity_links l where l.opportunity_id = o.id and l.kind = 'task'
               and authority_link_state(l) = 'active') then
      raise exception 'Changed since the preview: a task for this opportunity is already open' using errcode = 'AU409';
    end if;
    insert into tasks (client_id, title, notes, owner, key, assignee_id)
    values (o.client_id, v_title, nullif(btrim(coalesce(p_payload->>'notes', '')), ''), 'TOM', 'authority:' || o.key, v_assignee)
    returning id into v_id;
    perform authority_decide(o.id, 'link', jsonb_build_object('kind', 'task', 'id', v_id));

  -- ── Reconciliation (0050) ───────────────────────────────────────────────
  when 'set_service_page' then
    if o.key not like 'data\_fix:service-page:%' then raise exception 'set_service_page applies to a service-page fix' using errcode = '22023'; end if;
    v_site := (select inventory->>'site' from authority_runs where id = o.last_seen_run_id);
    select * into v_svc from services
     where id = substring(o.key from length('data_fix:service-page:') + 1)::uuid and client_id = o.client_id for update;
    if v_svc.id is null then raise exception 'The service is gone' using errcode = 'AU409'; end if;
    if v_svc.status <> 'approved' then raise exception 'Only an approved service takes a service page' using errcode = '22023'; end if;
    if (p_expected->>'page_url') is distinct from v_svc.page_url then
      raise exception 'Changed since the preview: the service page is now %', coalesce(v_svc.page_url, 'empty') using errcode = 'AU409';
    end if;
    g := authority_service_group(o.client_id, v_svc.name);
    if g.id is null then raise exception 'No approved page group supports this service' using errcode = '22023'; end if;
    -- 0052: the value written is the value the teammate previewed.
    if (p_expected->>'target_url') is distinct from g.target_url then
      raise exception 'Changed since the preview: the service''s page group now targets %', coalesce(g.target_url, 'nothing') using errcode = 'AU409';
    end if;
    v_path := authority_norm_path(g.target_url, v_site);
    if v_path is null then raise exception 'The page group''s page is not on the client''s site' using errcode = '22023'; end if;
    if authority_page_state(o.last_seen_run_id, v_path)->>'state' <> 'live' then
      raise exception 'The page % is not live in the latest site snapshot', v_path using errcode = '22023';
    end if;
    if authority_norm_path(v_svc.page_url, v_site) is not distinct from v_path then
      raise exception 'Changed since the preview: the service page is already %', v_path using errcode = 'AU409';
    end if;
    update services set page_url = g.target_url where id = v_svc.id and client_id = o.client_id;
    v_canonical := true;
    perform authority_decide(o.id, 'decision', jsonb_build_object('decision', format('Set %s''s service page to %s', v_svc.name, v_path),
      'action', 'set_service_page', 'service_id', v_svc.id, 'page_group_id', g.id, 'run_id', o.last_seen_run_id,
      'before', jsonb_build_object('services.page_url', v_svc.page_url), 'after', jsonb_build_object('services.page_url', g.target_url)));

  when 'rehome_keywords' then
    if o.key not like 'data\_fix:keyword-ownership:%' then raise exception 'rehome_keywords applies to a keyword-ownership fix' using errcode = '22023'; end if;
    v_rows := authority_selected_rows(p_payload->'rows', p_expected->'rows');
    v_site := (select inventory->>'site' from authority_runs where id = o.last_seen_run_id);
    select * into v_svc from services
     where id = substring(o.key from length('data_fix:keyword-ownership:') + 1)::uuid and client_id = o.client_id for share;
    if v_svc.id is null or v_svc.status <> 'approved' then raise exception 'The service is gone or not approved' using errcode = 'AU409'; end if;
    g := authority_service_group(o.client_id, v_svc.name);
    for v_row in select x from jsonb_array_elements(v_rows) x loop
      v_dest := v_row->>'destination';
      if v_dest is null or v_dest not in ('service_page', 'home') then
        raise exception 'Each row needs a destination: service_page or home' using errcode = '22023';
      end if;
      select * into v_kw from keywords where id = (v_row->>'keyword_id')::uuid and client_id = o.client_id for update;
      if v_kw.id is null then raise exception 'Changed since the preview: a selected keyword is gone' using errcode = 'AU409'; end if;
      if v_kw.service_id is distinct from nullif(v_row->'expected'->>'service_id', '')::uuid
         or v_kw.target_url is distinct from (v_row->'expected'->>'target_url') then
        raise exception 'Changed since the preview: "%" changed', v_kw.keyword using errcode = 'AU409';
      end if;
      if v_kw.service_id is distinct from v_svc.id or authority_norm_path(v_kw.target_url, v_site) is distinct from '/' then
        raise exception '"%" is not one of %''s keywords targeting the home page', v_kw.keyword, v_svc.name using errcode = '22023';
      end if;
      select e.x into v_entry from authority_runs r, jsonb_array_elements(r.report->'keywords') e(x)
       where r.id = o.last_seen_run_id and e.x->>'keyword_id' = v_kw.id::text;
      if v_entry is null or not coalesce(v_entry->'flags' ? 'homepage_pollution', false) then
        raise exception 'The analysis does not flag "%" as targeting the home page', v_kw.keyword using errcode = '22023';
      end if;
      if v_dest = 'service_page' then
        if g.id is null or authority_page_state(o.last_seen_run_id, authority_norm_path(g.target_url, v_site))->>'state' is distinct from 'live' then
          raise exception '% has no live owner page to re-home to', v_svc.name using errcode = '22023';
        end if;
        -- 0052: the destination is the one the teammate previewed.
        if (v_row->'expected'->>'destination_url') is distinct from g.target_url then
          raise exception 'Changed since the preview: % now targets %', v_svc.name, g.target_url using errcode = 'AU409';
        end if;
        update keywords set target_url = g.target_url where id = v_kw.id and client_id = o.client_id;
        v_done := v_done || jsonb_build_object('keyword_id', v_kw.id, 'keyword', v_kw.keyword, 'destination', v_dest,
          'before', jsonb_build_object('service_id', v_kw.service_id, 'target_url', v_kw.target_url),
          'after', jsonb_build_object('service_id', v_kw.service_id, 'target_url', g.target_url));
      else
        -- Home: only a keyword the analysis itself marks as belonging to Home.
        if not coalesce(v_entry->'flags' ? 'home_eligible', false) then
          raise exception 'The analysis does not recommend Home for "%"', v_kw.keyword using errcode = '22023';
        end if;
        if hg.id is null then
          if (select count(*) from page_groups where client_id = o.client_id and page_type = 'home' and status = 'approved') <> 1 then
            raise exception 'Home needs exactly one approved Home page group' using errcode = '22023';
          end if;
          select * into hg from page_groups where client_id = o.client_id and page_type = 'home' and status = 'approved' for update;
          if authority_norm_path(hg.target_url, v_site) is distinct from '/' then
            raise exception 'The Home page group does not target the home page' using errcode = '22023';
          end if;
        end if;
        -- 0051: a service's primary keyword never leaves its service by a re-home.
        if exists (select 1 from services sv where sv.client_id = o.client_id and sv.primary_keyword_id = v_kw.id)
           or exists (select 1 from page_groups pg where pg.client_id = o.client_id and pg.page_type in ('service', 'hub') and pg.primary_keyword_id = v_kw.id) then
          raise exception '"%" is a service''s primary keyword; change that before re-homing it to Home', v_kw.keyword using errcode = '22023';
        end if;
        -- 0052: the destination and the page groups it leaves are exactly the preview's.
        if (v_row->'expected'->>'destination_url') is distinct from hg.target_url then
          raise exception 'Changed since the preview: the Home page group now targets %', hg.target_url using errcode = 'AU409';
        end if;
        if jsonb_typeof(v_row->'expected'->'removed_from') is distinct from 'array' then
          raise exception 'Changed since the preview: the preview''s page-group removals for "%" are missing', v_kw.keyword using errcode = 'AU409';
        end if;
        select coalesce(array_agg(pg.id order by pg.id), '{}') into v_removed_ids
          from (select pg.id from page_groups pg
                 where pg.client_id = o.client_id and pg.page_type in ('service', 'hub') and v_kw.id = any (pg.supporting_keyword_ids)
                 order by pg.id for update) pg;
        select coalesce(array_agg(x::uuid order by x::uuid), '{}') into v_exp_ids
          from jsonb_array_elements_text(v_row->'expected'->'removed_from') x;
        if v_removed_ids is distinct from v_exp_ids then
          raise exception 'Changed since the preview: the page groups listing "%" changed', v_kw.keyword using errcode = 'AU409';
        end if;
        update keywords set service_id = null, target_url = hg.target_url where id = v_kw.id and client_id = o.client_id;
        -- 0051: it stops being any service page group's supporting keyword, in the same transaction.
        select coalesce(jsonb_agg(jsonb_build_object('id', pg.id, 'name', pg.name) order by pg.name, pg.id), '[]'::jsonb) into v_removed
          from (select pg.id, pg.name from page_groups pg
                 where pg.client_id = o.client_id and pg.page_type in ('service', 'hub') and v_kw.id = any (pg.supporting_keyword_ids)
                 order by pg.id for update) pg;
        update page_groups set supporting_keyword_ids = array_remove(supporting_keyword_ids, v_kw.id)
         where client_id = o.client_id and page_type in ('service', 'hub') and v_kw.id = any (supporting_keyword_ids);
        if hg.primary_keyword_id is distinct from v_kw.id and not (v_kw.id = any (hg.supporting_keyword_ids)) then
          update page_groups set supporting_keyword_ids = supporting_keyword_ids || v_kw.id where id = hg.id returning * into hg;
        end if;
        if exists (select 1 from page_groups pg where pg.client_id = o.client_id and pg.page_type in ('service', 'hub') and v_kw.id = any (pg.supporting_keyword_ids)) then
          raise exception 'Re-homing "%" left it on a service page group', v_kw.keyword using errcode = 'XX000';
        end if;
        v_done := v_done || jsonb_build_object('keyword_id', v_kw.id, 'keyword', v_kw.keyword, 'destination', v_dest,
          'page_group_id', hg.id, 'removed_from_page_groups', v_removed,
          'before', jsonb_build_object('service_id', v_kw.service_id, 'target_url', v_kw.target_url),
          'after', jsonb_build_object('service_id', null, 'target_url', hg.target_url));
      end if;
    end loop;
    v_canonical := true;
    perform authority_decide(o.id, 'decision', jsonb_build_object(
      'decision', format('Re-home %s keyword(s) of %s', jsonb_array_length(v_done), v_svc.name),
      'action', 'rehome_keywords', 'service_id', v_svc.id, 'run_id', o.last_seen_run_id, 'rows', v_done));

  when 'record_content' then
    if o.key <> 'data_fix:record-live-blog-posts' then raise exception 'record_content applies to the record-live-blog-posts fix' using errcode = '22023'; end if;
    if jsonb_typeof(p_payload->'paths') is distinct from 'array' or jsonb_array_length(p_payload->'paths') not between 1 and 25 then
      raise exception 'Select between 1 and 25 pages' using errcode = '22023';
    end if;
    if (select count(distinct x) from jsonb_array_elements_text(p_payload->'paths') x) <> jsonb_array_length(p_payload->'paths') then
      raise exception 'A page is selected twice' using errcode = '22023';
    end if;
    v_site := (select inventory->>'site' from authority_runs where id = o.last_seen_run_id);
    -- authority/site.ts prefixes(): the blog route recorded for the site, else /blog/.
    v_route := (select st.content_paths->>'blog_route' from sites st where st.client_id = o.client_id order by st.created_at limit 1);
    v_prefix := case when strpos(coalesce(v_route, ''), '{') > 1 then left(v_route, strpos(v_route, '{') - 1) else '/blog/' end;
    -- One recorder per client at a time: two teammates cannot record the same URL twice.
    perform pg_advisory_xact_lock(hashtextextended('authority:content_posts:' || o.client_id::text, 0));
    for v_path in select x from jsonb_array_elements_text(p_payload->'paths') x order by x loop
      if authority_norm_path(v_path, v_site) is distinct from v_path then
        raise exception '% is not a page path on the client''s site', v_path using errcode = '22023';
      end if;
      if left(v_path, length(v_prefix)) <> v_prefix or length(v_path) <= length(v_prefix) then
        raise exception '% is not a blog page (%)', v_path, v_prefix using errcode = '22023';
      end if;
      v_pstate := authority_page_state(o.last_seen_run_id, v_path);
      if v_pstate->>'state' is distinct from 'live' then
        raise exception '% is not live in the latest site snapshot', v_path using errcode = '22023';
      end if;
      if exists (select 1 from content_posts cp where cp.client_id = o.client_id and authority_norm_path(cp.url, v_site) = v_path) then
        v_skipped := v_skipped || to_jsonb(v_path);
        continue;
      end if;
      v_page := v_pstate->'page';
      v_title := left(coalesce(nullif(btrim(v_page->>'h1'), ''),
                               nullif(btrim(regexp_replace(coalesce(v_page->>'title', ''), '\s+[|–—-]\s+[^|–—-]*$', '')), ''),
                               v_path), 300);
      v_url := coalesce(nullif(v_page->>'final_url', ''), v_page->>'url');
      insert into content_posts (client_id, title, status, url, notes, origin)
      values (o.client_id, v_title, 'published', v_url,
              format('Already on the client''s site; recorded by Authority from run %s. Not produced by Compass.', o.last_seen_run_id),
              'site_inventory')
      returning id into v_id;
      perform authority_decide(o.id, 'link', jsonb_build_object('kind', 'content_post', 'id', v_id));
      v_done := v_done || jsonb_build_object('content_post_id', v_id, 'path', v_path, 'url', v_url, 'title', v_title);
    end loop;
    if jsonb_array_length(v_done) > 0 then
      v_canonical := true;
      perform authority_decide(o.id, 'decision', jsonb_build_object(
        'decision', format('Record %s existing page(s) from the client''s site', jsonb_array_length(v_done)),
        'action', 'record_content', 'origin', 'site_inventory', 'run_id', o.last_seen_run_id, 'rows', v_done, 'skipped', v_skipped));
    end if;

  when 'map_keywords' then
    if o.key <> 'data_fix:unmapped-keywords' then raise exception 'map_keywords applies to the unmapped-keywords fix' using errcode = '22023'; end if;
    v_rows := authority_selected_rows(p_payload->'rows', p_expected->'rows');
    v_site := (select inventory->>'site' from authority_runs where id = o.last_seen_run_id);
    for v_row in select x from jsonb_array_elements(v_rows) x loop
      select * into v_kw from keywords where id = (v_row->>'keyword_id')::uuid and client_id = o.client_id for update;
      if v_kw.id is null then raise exception 'Changed since the preview: a selected keyword is gone' using errcode = 'AU409'; end if;
      if v_kw.service_id is distinct from nullif(v_row->'expected'->>'service_id', '')::uuid
         or v_kw.target_url is distinct from (v_row->'expected'->>'target_url') then
        raise exception 'Changed since the preview: "%" changed', v_kw.keyword using errcode = 'AU409';
      end if;
      if v_kw.service_id is not null then raise exception '"%" already has a service', v_kw.keyword using errcode = '22023'; end if;
      select e.x into v_entry from authority_runs r, jsonb_array_elements(r.report->'keywords') e(x)
       where r.id = o.last_seen_run_id and e.x->>'keyword_id' = v_kw.id::text;
      if v_entry->>'role' is distinct from 'unmapped' then
        raise exception 'The analysis does not classify "%" as unmapped', v_kw.keyword using errcode = '22023';
      end if;
      -- 0052: a keyword naming an unapproved market waits for that market decision and a refresh.
      if coalesce(v_entry->'flags' ? 'location_unapproved', false) then
        raise exception '"%" references an unapproved market. Decide on that market first.', v_kw.keyword using errcode = '22023';
      end if;
      select * into v_svc from services where id = nullif(v_row->>'service_id', '')::uuid and client_id = o.client_id for share;
      if v_svc.id is null or v_svc.status <> 'approved' then
        raise exception 'Choose one of this client''s approved services for "%"', v_kw.keyword using errcode = '22023';
      end if;
      g := authority_service_group(o.client_id, v_svc.name);
      if g.id is null or authority_page_state(o.last_seen_run_id, authority_norm_path(g.target_url, v_site))->>'state' is distinct from 'live' then
        raise exception '% has no live owner page yet, so no keyword can be mapped to it', v_svc.name using errcode = '22023';
      end if;
      -- 0052: the destination is the one the teammate previewed.
      if (v_row->'expected'->>'destination_url') is distinct from g.target_url then
        raise exception 'Changed since the preview: % now targets %', v_svc.name, g.target_url using errcode = 'AU409';
      end if;
      update keywords set service_id = v_svc.id, target_url = g.target_url where id = v_kw.id and client_id = o.client_id;
      v_done := v_done || jsonb_build_object('keyword_id', v_kw.id, 'keyword', v_kw.keyword,
        'before', jsonb_build_object('service_id', v_kw.service_id, 'target_url', v_kw.target_url),
        'after', jsonb_build_object('service_id', v_svc.id, 'service', v_svc.name, 'target_url', g.target_url));
    end loop;
    v_canonical := true;
    perform authority_decide(o.id, 'decision', jsonb_build_object(
      'decision', format('Map %s keyword(s) to services', jsonb_array_length(v_done)),
      'action', 'map_keywords', 'run_id', o.last_seen_run_id, 'rows', v_done));
  end case;

  return jsonb_build_object('action', p_action, 'opportunity_id', o.id, 'client_id', o.client_id,
    'canonical_change', v_canonical, 'id', v_id, 'rows', v_done, 'skipped', v_skipped);
end $$;
revoke all on function authority_apply(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function authority_apply(uuid, text, jsonb, jsonb) to authenticated;

-- ── Verify ──────────────────────────────────────────────────────────────────
do $$
declare v_src text := (select prosrc from pg_proc where oid = 'public.authority_apply(uuid, text, jsonb, jsonb)'::regprocedure);
begin
  if (select prosecdef from pg_proc where oid = 'public.authority_apply(uuid, text, jsonb, jsonb)'::regprocedure) then
    raise exception 'authority_apply must run with the caller''s rights';
  end if;
  if has_function_privilege('anon', 'public.authority_apply(uuid, text, jsonb, jsonb)', 'execute') then
    raise exception 'anon can call authority_apply';
  end if;
  if v_src not like '%session_user = ''authenticator''%' then
    raise exception 'authority_apply lost its caller gate';
  end if;
  if v_src not like '%array_remove(supporting_keyword_ids, v_kw.id)%' or v_src not like '%removed_from_page_groups%' then
    raise exception 'authority_apply lost the 0051 Home cleanup';
  end if;
  if v_src not like '%(p_expected->>''target_url'') is distinct from g.target_url%'
     or (length(v_src) - length(replace(v_src, '''destination_url''', ''))) / length('''destination_url''') <> 3
     or v_src not like '%''removed_from''%' or v_src not like '%''location_unapproved''%' then
    raise exception 'authority_apply lost a 0052 preview binding';
  end if;
end $$;
