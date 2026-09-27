-- 0050 Authority CRM reconciliation (Decisions PR C1): the four data fixes
-- the Authority Engine already reports, applied by a person through
-- authority_apply with the same guarantees as 0049 (the caller's RLS, the
-- opportunity and every written row locked, SQLSTATE AU409 when anything
-- differs from the preview, the canonical write and its Authority event in
-- one transaction).
--
--   set_service_page  data_fix:service-page:<service>   services.page_url := the approved
--                                                        page group's target (live, own site)
--   rehome_keywords   data_fix:keyword-ownership:<svc>  selected keywords (1-25) that still
--                                                        target the home page: to the service's
--                                                        live page, or to the approved Home page
--                                                        group (only a keyword the analysis marks
--                                                        home_eligible: the engine change, C3)
--   record_content    data_fix:record-live-blog-posts   selected live blog pages (1-25) not yet in
--                                                        content_posts, recorded as
--                                                        origin = 'site_inventory' and linked
--   map_keywords      data_fix:unmapped-keywords        selected unmapped keywords (1-25), one
--                                                        approved service each, only a service
--                                                        whose page group target is live
--
-- Provenance (decision 2b): content_posts.origin is 'compass' (every
-- existing row, and the default) or 'site_inventory' (content that was
-- already on the client's site, recorded by Authority). It is set once and
-- never changes. The client-facing work log (portal_work_log) shows
-- Compass-produced content only; Authority coverage (authority_input) counts
-- both, unchanged.
--
-- The site snapshot every check reads is the stored inventory of the run
-- that last reported the opportunity, which the caller's preview also used
-- (p_expected.run_id).
--
-- Nothing here writes the website, change_log, social posts, drafter runs
-- or any portal data; the one portal change is the work log's filter.
--
-- Rollback (before any reconciliation uses it): restore authority_apply from
-- 0049, drop the helpers below, restore portal_work_log from 0037 (with its
-- grants), drop the content_posts trigger, its function, the check and the
-- origin column.

-- ── 1. Provenance ──────────────────────────────────────────────────────────
alter table content_posts add column origin text not null default 'compass';
alter table content_posts add constraint content_posts_origin_check check (origin in ('compass', 'site_inventory'));
comment on column content_posts.origin is
  'compass: produced by Compass. site_inventory: already on the client''s site, recorded by Authority (0050). Set once; never changes.';

create function content_posts_origin_fixed() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.origin is distinct from old.origin then
    raise exception 'content_posts.origin is set when the row is recorded and never changes' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function content_posts_origin_fixed() from public, anon, authenticated;
create trigger content_posts_origin_fixed before update of origin on content_posts
  for each row execute function content_posts_origin_fixed();

-- The client-facing work log: Compass-produced content only (0037 otherwise unchanged).
create or replace view portal_work_log as
  select l.client_id,
         l.created_at as at,
         'change'::text as kind,
         l.change_type::text as label,
         l.object_type::text as detail,
         null::text as url
  from change_log l
  where l.client_id = (select portal_client_id())
    and l.status::text = 'approved'
  union all
  select p.client_id,
         p.published_at::timestamptz,
         'post'::text,
         p.title,
         null::text,
         p.url
  from content_posts p
  where p.client_id = (select portal_client_id())
    and p.status::text = 'published'
    and p.origin = 'compass';
alter view portal_work_log set (security_invoker = false);
revoke all on portal_work_log from public, anon, authenticated;
grant select on portal_work_log to authenticated;

-- ── 2. Helpers (the engine's URL and page rules, in SQL) ────────────────────
-- decodeURIComponent: NULL when the escapes are malformed (the engine's
-- normPath returns null then too).
create function authority_url_decode(p text) returns text
language plpgsql immutable strict set search_path = public as $$
declare
  src bytea := convert_to(p, 'UTF8');
  b bytea := ''::bytea;
  i int := 0;
  n int := length(src);
  h text;
begin
  -- Byte by byte, so the answer does not depend on the database encoding.
  while i < n loop
    if get_byte(src, i) = 37 then -- '%'
      if i + 2 >= n then return null; end if;
      h := convert_from(substring(src from i + 2 for 2), 'UTF8');
      if h !~ '^[0-9A-Fa-f]{2}$' then return null; end if;
      b := b || decode(h, 'hex');
      i := i + 3;
    else
      b := b || substring(src from i + 1 for 1);
      i := i + 1;
    end if;
  end loop;
  return convert_from(b, 'UTF8');
exception when others then
  return null;
end $$;

-- authority/urls.ts normPath: the path of a URL on the client's site
-- (another host → NULL), decoded, '//' collapsed, no trailing slash, '/' for
-- the root. tests/authority-norm-path.test.mjs pins the same vectors.
create function authority_norm_path(p_url text, p_site text default null) returns text
language plpgsql immutable set search_path = public as $$
declare
  raw text := btrim(coalesce(p_url, ''));
  v_path text;
  v_host text;
  v_site_host text;
begin
  if raw = '' then return null; end if;
  if raw ~* '^https?://' then
    v_host := regexp_replace(lower(substring(raw from '^[A-Za-z]+://(?:[^@/?#]*@)?([^/:?#]+)')), '^www\.', '');
    if coalesce(p_site, '') ~* '^https?://' then
      v_site_host := regexp_replace(lower(substring(p_site from '^[A-Za-z]+://(?:[^@/?#]*@)?([^/:?#]+)')), '^www\.', '');
      if v_host is distinct from v_site_host then return null; end if;
    end if;
    v_path := coalesce(substring(raw from '^[A-Za-z]+://[^/?#]*([^?#]*)'), '');
  elsif raw ~ '^[A-Za-z][A-Za-z0-9+.-]*:' or left(raw, 2) = '//' then
    return null; -- another scheme, or a host the check cannot see: never ours
  else
    v_path := split_part(split_part(raw, '#', 1), '?', 1);
    if left(v_path, 1) <> '/' then v_path := '/' || v_path; end if;
  end if;
  if v_path = '' then v_path := '/'; end if;
  v_path := authority_url_decode(v_path);
  if v_path is null then return null; end if;
  v_path := regexp_replace(v_path, '/{2,}', '/', 'g');
  if length(v_path) > 1 then v_path := regexp_replace(v_path, '/+$', ''); end if;
  return coalesce(nullif(v_path, ''), '/');
end $$;

-- authority/urls.ts buildInventory().resolve over a run's stored site
-- snapshot: {state: live | redirects | missing | error | redirect_loop |
-- not_checked, final_path, page}. Invoker rights (team RLS on authority_runs).
create function authority_page_state(p_run_id uuid, p_path text) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_inv jsonb;
  v_site text;
  v_page jsonb;
  v_final text;
  v_status int;
begin
  select inventory into v_inv from authority_runs where id = p_run_id;
  if v_inv is null or p_path is null then return jsonb_build_object('state', 'not_checked'); end if;
  v_site := v_inv->>'site';
  select x into v_page from jsonb_array_elements(v_inv->'pages') with ordinality t(x, n)
   where authority_norm_path(x->>'url', v_site) = p_path order by n limit 1;
  if v_page is null then return jsonb_build_object('state', 'not_checked'); end if;
  if coalesce((v_page->>'redirect_loop')::boolean, false) then
    return jsonb_build_object('state', 'redirect_loop', 'final_path', null, 'page', v_page);
  end if;
  v_final := authority_norm_path(v_page->>'final_url', v_site);
  v_status := coalesce((v_page->>'final_status')::int, (v_page->>'status')::int);
  if v_status in (404, 410) then return jsonb_build_object('state', 'missing', 'final_path', v_final, 'page', v_page); end if;
  if v_status is null or v_status >= 500 or v_status = 0 then
    return jsonb_build_object('state', 'error', 'final_path', v_final, 'page', v_page);
  end if;
  if v_final is not null and v_final <> p_path then
    return jsonb_build_object('state', 'redirects', 'final_path', v_final, 'page', v_page);
  end if;
  if v_status between 200 and 299 then return jsonb_build_object('state', 'live', 'final_path', p_path, 'page', v_page); end if;
  return jsonb_build_object('state', 'error', 'final_path', v_final, 'page', v_page);
end $$;

-- authority/owners.ts serviceGroup: the approved service / hub page group
-- with the service's name.
create function authority_service_group(p_client_id uuid, p_service_name text) returns page_groups
language sql stable security invoker set search_path = public as $$
  select * from page_groups g
   where g.client_id = p_client_id and g.page_type in ('service', 'hub') and g.status = 'approved'
     and lower(btrim(g.name)) = lower(btrim(p_service_name))
   order by g.name, g.id limit 1
$$;

-- The explicitly selected rows of a batch, each with the row the preview
-- showed for it: 1-25, no repeats, exactly the previewed selection.
create function authority_selected_rows(p_rows jsonb, p_expected jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_ids uuid[];
  v_expected uuid[];
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 25 then
    raise exception 'Select between 1 and 25 rows' using errcode = '22023';
  end if;
  select array_agg((x->>'keyword_id')::uuid order by (x->>'keyword_id')::uuid) into v_ids from jsonb_array_elements(p_rows) x;
  if array_position(v_ids, null) is not null or cardinality(v_ids) <> (select count(distinct u) from unnest(v_ids) u) then
    raise exception 'Each selected row needs its own keyword' using errcode = '22023';
  end if;
  if jsonb_typeof(p_expected) is distinct from 'array' then
    raise exception 'Changed since the preview: the preview''s rows are missing' using errcode = 'AU409';
  end if;
  select array_agg((x->>'keyword_id')::uuid order by (x->>'keyword_id')::uuid) into v_expected from jsonb_array_elements(p_expected) x;
  if v_ids is distinct from v_expected then
    raise exception 'Changed since the preview: the selection differs from the preview' using errcode = 'AU409';
  end if;
  return (select jsonb_agg(r || jsonb_build_object('expected', e) order by (r->>'keyword_id')::uuid)
            from jsonb_array_elements(p_rows) r join jsonb_array_elements(p_expected) e on e->>'keyword_id' = r->>'keyword_id');
end $$;

do $$
declare f text;
begin
  foreach f in array array['authority_url_decode(text)', 'authority_norm_path(text, text)', 'authority_page_state(uuid, text)',
                           'authority_service_group(uuid, text)', 'authority_selected_rows(jsonb, jsonb)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- ── 3. authority_apply: the four reconciliation actions ────────────────────
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
        update keywords set service_id = null, target_url = hg.target_url where id = v_kw.id and client_id = o.client_id;
        if hg.primary_keyword_id is distinct from v_kw.id and not (v_kw.id = any (hg.supporting_keyword_ids)) then
          update page_groups set supporting_keyword_ids = supporting_keyword_ids || v_kw.id where id = hg.id returning * into hg;
        end if;
        v_done := v_done || jsonb_build_object('keyword_id', v_kw.id, 'keyword', v_kw.keyword, 'destination', v_dest,
          'page_group_id', hg.id,
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
      select * into v_svc from services where id = nullif(v_row->>'service_id', '')::uuid and client_id = o.client_id for share;
      if v_svc.id is null or v_svc.status <> 'approved' then
        raise exception 'Choose one of this client''s approved services for "%"', v_kw.keyword using errcode = '22023';
      end if;
      g := authority_service_group(o.client_id, v_svc.name);
      if g.id is null or authority_page_state(o.last_seen_run_id, authority_norm_path(g.target_url, v_site))->>'state' is distinct from 'live' then
        raise exception '% has no live owner page yet, so no keyword can be mapped to it', v_svc.name using errcode = '22023';
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


-- ── 4. Verify ───────────────────────────────────────────────────────────────
do $$
declare v_bad text;
begin
  if (select prosecdef from pg_proc where oid = 'public.authority_apply(uuid, text, jsonb, jsonb)'::regprocedure) then
    raise exception 'authority_apply must run with the caller''s rights';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
             and proname in ('authority_url_decode', 'authority_norm_path', 'authority_page_state', 'authority_service_group', 'authority_selected_rows')) then
    raise exception 'A 0050 helper must not be security definer';
  end if;
  if has_function_privilege('anon', 'public.authority_apply(uuid, text, jsonb, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.authority_page_state(uuid, text)', 'execute') then
    raise exception 'anon can call an Authority reconciliation function';
  end if;
  if pg_get_viewdef('public.portal_work_log'::regclass) not like '%portal_client_id()%'
     or pg_get_viewdef('public.portal_work_log'::regclass) not like '%origin%compass%' then
    raise exception 'portal_work_log lost its client filter or its Compass-only filter';
  end if;
  select string_agg(distinct g.grantee || ' ' || g.privilege_type, ', ') into v_bad
  from information_schema.role_table_grants g
  where g.table_schema = 'public' and g.table_name = 'portal_work_log'
    and (g.grantee in ('anon', 'public') or (g.grantee = 'authenticated' and g.privilege_type <> 'SELECT'));
  if v_bad is not null then raise exception 'portal_work_log grants too much: %', v_bad; end if;
  if (select reloptions from pg_class where oid = 'public.portal_work_log'::regclass) is distinct from array['security_invoker=false'] then
    raise exception 'portal_work_log must run as its owner (0037)';
  end if;
  if exists (select 1 from content_posts where origin <> 'compass') then
    raise exception 'Existing content_posts must all be compass';
  end if;
end $$;
