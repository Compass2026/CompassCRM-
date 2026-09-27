-- 0053 Authority → AI Drafter hand-off.
--
-- A teammate asks the AI Drafter to write the Business Profile post an
-- Authority opportunity recommends. Authority chooses what to create; the
-- Drafter rebuilds its own governed brief from live data and decides whether
-- and how it can be written. Authority only narrows: every Drafter refusal
-- stays, and the hand-off adds its own.
--
--   1. drafter_runs.authority_opportunity_id: every attempt made for an
--      opportunity, refused ones included (provenance).
--   2. authority_opportunities.cycle_started_at, and authority_opportunity_state
--      counting only this cycle's links: a recurring Business Profile
--      opportunity is completed by an approved post for one cadence cycle, not
--      for good.
--   3. One open Draft with AI request per opportunity (a partial unique index
--      on tasks.key).
--   4. authority_draft_start(task): starts (or restarts) the worker for an
--      open request. The worker's own fire log retries a failed start.
--   5. authority_apply 'request_draft' (a signed-in teammate only): records the
--      request as a CLAUDE task keyed authority_draft:<opportunity id> — the
--      worker's work item, never an Authority link, so it never decides
--      completion — accepts the opportunity, writes the decision event and
--      starts the worker. Idempotent: an open or blocked request is reused
--      (a blocked one reopens) and restarted; a second request is never made.
--   6. authority_record_run: when the engine reports a recurring Business
--      Profile opportunity eligible again and this cycle's work is done, a
--      new cycle starts (reopened event, status open).
--   7. drafter_write with authority_opportunity_id: locks the opportunity and
--      refuses (AU409, nothing written) unless it is this client's, current,
--      Ready, eligible, not dismissed, not already in review or approved this
--      cycle, requested by a teammate (an open request task and the team's
--      request_draft decision event naming it), matching the Drafter's own
--      target (service, keyword, intent, page, button, standard post), with
--      the brief built for it and Authority's preferred evidence a subset of
--      the brief's allowed claims, and no post for the service and intent in
--      the last 21 days (live cadence). Then, in the same transaction as the
--      run and the post: links the post to the opportunity (in review → in
--      progress; approved → completed) and closes the request.
--
-- Nothing here drafts, approves, schedules or publishes.
-- Rollback: 0052's authority_apply, 0049's authority_record_run, 0047's
-- drafter_write, 0048's authority_opportunity_state; drop the index, the
-- function and the two columns.

-- ── 1. Provenance on drafter runs ───────────────────────────────────────────
alter table drafter_runs
  add column authority_opportunity_id uuid,
  add constraint drafter_runs_authority_opportunity_fk foreign key (authority_opportunity_id, client_id)
    references authority_opportunities (id, client_id) on delete set null (authority_opportunity_id);
create index drafter_runs_authority_opportunity_idx on drafter_runs (authority_opportunity_id) where authority_opportunity_id is not null;
comment on column drafter_runs.authority_opportunity_id is
  'The Authority opportunity this attempt was made for (0053), refused attempts included. Set only by the post-drafter function.';

-- ── 2. Recurring cycles ─────────────────────────────────────────────────────
alter table authority_opportunities add column cycle_started_at timestamptz;
comment on column authority_opportunities.cycle_started_at is
  'Start of the current cycle of a recurring opportunity (0053); only links made since then count toward its lifecycle. Null: since it was first reported.';

drop view authority_opportunity_state;
create view authority_opportunity_state with (security_invoker = true) as
select o.*,
  case
    when exists (select 1 from authority_opportunity_links l where l.opportunity_id = o.id
                  and l.created_at >= coalesce(o.cycle_started_at, '-infinity'::timestamptz) and authority_link_state(l) = 'done') then 'completed'
    when exists (select 1 from authority_opportunity_links l where l.opportunity_id = o.id
                  and l.created_at >= coalesce(o.cycle_started_at, '-infinity'::timestamptz) and authority_link_state(l) = 'active') then 'in_progress'
    -- a normal dismissal whose date has passed reads as open while still reported
    -- (the next completed run records the reopening)
    when o.status = 'dismissed' and not o.suppressed and o.dismissed_until <= (now() at time zone 'America/Chicago')::date
         and o.present then 'open'
    when o.status = 'dismissed' then 'dismissed'
    when not o.present then 'resolved'
    else o.status
  end as effective_status
from authority_opportunities o;
revoke all on authority_opportunity_state from public, anon, authenticated;
grant select on authority_opportunity_state to authenticated, service_role;

-- ── 3. One open request per opportunity ─────────────────────────────────────
create unique index tasks_authority_draft_open_key on tasks (key)
  where key like 'authority\_draft:%' and status <> 'done';

-- ── 4. Start (or restart) the worker for an open request ────────────────────
-- A teammate (the Draft with AI button, or its retry) or the service. The
-- worker's fire is debounced per client and reason, logged to worker_fires
-- and retried by retry_failed_fires() when Anthropic's Routine API does not
-- answer 200; the daily sweep also picks up open requests. None of these can
-- create a second request, run or post: drafter_write needs the open request
-- and closes it with the post it writes.
create function authority_draft_start(p_task_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t tasks;
  o authority_opportunities;
  v_reason text;
  v_before bigint;
begin
  if not (post_caller_is_human() or authority_caller_is_service()) then
    raise exception 'Only a signed-in teammate starts a Draft with AI request' using errcode = '42501';
  end if;
  select * into t from tasks where id = p_task_id;
  if t.id is null or t.key not like 'authority\_draft:%' then
    raise exception 'No such Draft with AI request' using errcode = 'P0002';
  end if;
  if t.status not in ('open', 'in_progress') then
    return jsonb_build_object('task_id', t.id, 'fired', false, 'reason', format('the request is %s', t.status));
  end if;
  select * into o from authority_opportunities where id = substring(t.key from 17)::uuid and client_id = t.client_id;
  if o.id is null or not o.present then
    return jsonb_build_object('task_id', t.id, 'fired', false, 'reason', 'the analysis no longer reports the opportunity');
  end if;
  v_reason := format('Authority draft request %s', t.id);
  select count(*) into v_before from worker_fires where client_id = t.client_id and reason = v_reason;
  perform fire_foundation_worker(t.client_id, v_reason);
  return jsonb_build_object('task_id', t.id, 'reason', v_reason,
    'fired', (select count(*) from worker_fires where client_id = t.client_id and reason = v_reason) > v_before);
end $$;
revoke all on function authority_draft_start(uuid) from public, anon;
grant execute on function authority_draft_start(uuid) to authenticated, service_role;

-- ── 5. authority_apply: request_draft ───────────────────────────────────────
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
  -- 0053
  v_task tasks;
  v_reused boolean;
  v_start jsonb;
begin
  -- A signed-in teammate through PostgREST, and nobody else.
  if not (session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'authenticated' and is_team()) then
    raise exception 'Only a signed-in Compass teammate applies Authority decisions' using errcode = '42501';
  end if;
  if p_action not in ('keep_intent', 'set_intent', 'approve_market', 'decline_market', 'confirm_service', 'not_offered', 'create_task',
                      'set_service_page', 'rehome_keywords', 'record_content', 'map_keywords', 'request_draft') then
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
  -- ── AI Drafter hand-off (0053) ──────────────────────────────────────────
  -- A teammate asks the AI Drafter to write this Business Profile post. The
  -- request is a CLAUDE task (orchestration only, never linked: the
  -- opportunity's lifecycle follows the linked post). Idempotent: an open or
  -- blocked request for the opportunity is reused (a blocked one reopens) and
  -- the worker is started again; a second request is never created.
  when 'request_draft' then
    if o.content_type is distinct from 'gbp_post' then
      raise exception 'Draft with AI applies to a Business Profile post opportunity' using errcode = '22023';
    end if;
    if o.last_seen_run_id is distinct from (select r.id from authority_runs r where r.client_id = o.client_id and r.status = 'completed'
                                             order by r.finished_at desc, r.id limit 1) then
      raise exception 'Changed since the preview: a newer analysis exists' using errcode = 'AU409';
    end if;
    if o.section <> 'ready' or o.action <> 'create' then
      raise exception 'The analysis does not mark this post ready to create (it is % / %)', o.section, o.action using errcode = '22023';
    end if;
    if o.eligible_from is not null and o.eligible_from > (now() at time zone 'America/Chicago')::date then
      raise exception 'Not eligible until % (cadence)', o.eligible_from using errcode = '22023';
    end if;
    if exists (select 1 from authority_opportunity_links l
                where l.opportunity_id = o.id and l.kind = 'social_post'
                  and l.created_at >= coalesce(o.cycle_started_at, '-infinity'::timestamptz)
                  and authority_link_state(l) in ('active', 'done')) then
      raise exception 'Changed since the preview: a draft for this opportunity is already in review or approved' using errcode = 'AU409';
    end if;
    select * into v_task from tasks
     where client_id = o.client_id and key = 'authority_draft:' || o.id and status <> 'done' for update;
    if v_task.id is null then
      insert into tasks (client_id, title, notes, owner, key)
      values (o.client_id, left(format('Draft with AI: %s (%s Business Profile post)', o.topic, o.intent), 200),
              format('Authority opportunity %s (%s), analysis run %s. The foundation-worker skill''s "Authority draft request" '
                     'playbook drafts it through post-drafter with this opportunity id; the draft stops in human review and '
                     'nothing is published. This task only orchestrates the request: the opportunity''s lifecycle follows '
                     'the linked post.', o.id, o.key, o.last_seen_run_id),
              'CLAUDE', 'authority_draft:' || o.id)
      returning * into v_task;
      v_reused := false;
    else
      if v_task.status = 'blocked' then update tasks set status = 'open' where id = v_task.id; end if;
      v_reused := true;
    end if;
    if o.status = 'open' then perform authority_decide(o.id, 'accept', '{}'); end if;
    perform authority_decide(o.id, 'decision', jsonb_build_object(
      'decision', case when v_reused then 'Draft with AI requested again (the same request, restarted)' else 'Draft with AI requested' end,
      'action', 'request_draft', 'task_id', v_task.id, 'run_id', o.last_seen_run_id, 'reused', v_reused));
    v_start := authority_draft_start(v_task.id);
    v_id := v_task.id;
    v_done := jsonb_build_array(jsonb_build_object('task_id', v_task.id, 'reused', v_reused, 'started', v_start));
  end case;

  return jsonb_build_object('action', p_action, 'opportunity_id', o.id, 'client_id', o.client_id,
    'canonical_change', v_canonical, 'id', v_id, 'rows', v_done, 'skipped', v_skipped);
end $$;
revoke all on function authority_apply(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function authority_apply(uuid, text, jsonb, jsonb) to authenticated;

-- ── 6. authority_record_run: recurring cycles ───────────────────────────────
create or replace function authority_record_run(p_run_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r authority_runs;
  v_status text := p->>'status';
  v_report jsonb := p->'report';
  v_prev uuid;
  v_as_of date;
  o jsonb;
  cur authority_opportunities;
  v_id uuid;
  v_keys text[] := '{}';
  added text[] := '{}'; resolved text[] := '{}'; regressed text[] := '{}'; moved text[] := '{}'; reopened text[] := '{}';
  v_counts jsonb;
begin
  if not authority_caller_is_service() then
    raise exception 'authority_record_run is called only by the authority-run function' using errcode = '42501';
  end if;
  select * into r from authority_runs where id = p_run_id for update;
  if r.id is null then raise exception 'No Authority run %', p_run_id using errcode = 'P0002'; end if;
  if r.status <> 'running' then raise exception 'Authority run % is already %', p_run_id, r.status using errcode = '42501'; end if;
  if v_status not in ('completed', 'degraded', 'failed') then
    raise exception 'A run finishes completed, degraded or failed, not %', v_status using errcode = '22023';
  end if;

  perform set_config('compass.authority_write', 'on', true);

  if v_status = 'failed' then
    update authority_runs set status = 'failed', finished_at = now(), error = coalesce(nullif(p->>'error', ''), 'Failed.')
     where id = p_run_id;
    perform set_config('compass.authority_write', '', true);
    return jsonb_build_object('run_id', p_run_id, 'status', 'failed');
  end if;

  if v_report is null or (v_report->'client'->>'id')::uuid is distinct from r.client_id then
    raise exception 'The report is not for this run''s client' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_report->'opportunities') x
             group by x->>'key' having count(*) > 1 or x->>'key' is null) then
    raise exception 'Opportunity keys must be present and unique within a run' using errcode = '22023';
  end if;
  v_as_of := coalesce((p->>'as_of')::date, (v_report->>'as_of')::date);

  select jsonb_build_object(
    'by_section', coalesce((select jsonb_object_agg(s, n) from (select x->>'section' s, count(*) n from jsonb_array_elements(v_report->'opportunities') x group by 1) a), '{}'),
    'by_action',  coalesce((select jsonb_object_agg(s, n) from (select x->>'action' s, count(*) n from jsonb_array_elements(v_report->'opportunities') x group by 1) a), '{}'),
    'by_tier',    coalesce((select jsonb_object_agg(s, n) from (select x->>'tier' s, count(*) n from jsonb_array_elements(v_report->'opportunities') x group by 1) a), '{}'))
  into v_counts;
  select id into v_prev from authority_runs
   where client_id = r.client_id and status = 'completed' and id <> p_run_id order by finished_at desc, id limit 1;

  -- Everything but the status first; the run finishes in one last update
  -- (a finished run is immutable, so nothing may follow it).
  update authority_runs set
    engine_version = p->>'engine_version',
    judged_at = (p->>'judged_at')::timestamptz, as_of = v_as_of, input_hash = p->>'input_hash',
    section_hashes = p->'section_hashes',
    inventory_fetched_at = (p->'inventory'->>'fetched_at')::timestamptz,
    inventory_pages = jsonb_array_length(coalesce(p->'inventory'->'pages', '[]')),
    inventory_errors = (p->>'inventory_errors')::int,
    inventory = p->'inventory', sources = v_report->'sources', report = v_report, counts = v_counts,
    previous_run_id = v_prev
  where id = p_run_id;

  if v_status = 'degraded' then
    -- A degraded observation (site down, most pages erroring) never resolves
    -- or reopens anything.
    update authority_runs set status = 'degraded', finished_at = now(),
      diff = jsonb_build_object('skipped', 'degraded run: opportunities unchanged') where id = p_run_id;
    perform set_config('compass.authority_write', '', true);
    return jsonb_build_object('run_id', p_run_id, 'status', 'degraded');
  end if;

  for o in select x from jsonb_array_elements(v_report->'opportunities') x loop
    v_keys := v_keys || (o->>'key');
    select * into cur from authority_opportunities where client_id = r.client_id and key = o->>'key' for update;
    if cur.id is null then
      insert into authority_opportunities (client_id, key, first_seen_run_id, last_seen_run_id, last_seen_at, present,
        section, action, tier, content_type, topic, service_id, keyword_id, intent, target_path, sort_order, eligible_from, opportunity)
      values (r.client_id, o->>'key', p_run_id, p_run_id, now(), true,
        o->>'section', o->>'action', o->>'tier', o->>'content_type', o->>'topic',
        (o->>'service_id')::uuid, (o->'target'->>'keyword_id')::uuid, o->'target'->>'intent', o->'target'->>'owner_path',
        coalesce((select array_agg(x::int) from jsonb_array_elements_text(o->'order') x), '{}'), (o->>'eligible_from')::date, o)
      returning id into v_id;
      insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
      values (v_id, r.client_id, p_run_id, 'created', 'engine', jsonb_build_object('section', o->>'section', 'action', o->>'action'));
      added := added || (o->>'key');
    else
      if not cur.present then
        insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
        values (cur.id, r.client_id, p_run_id, 'regressed', 'engine', jsonb_build_object('status_was', cur.status));
        regressed := regressed || cur.key;
        if cur.status = 'accepted' then cur.status := 'open'; end if;
      end if;
      if cur.section <> o->>'section' or cur.action <> o->>'action' then
        insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
        values (cur.id, r.client_id, p_run_id, 'section_changed', 'engine',
          jsonb_build_object('from', jsonb_build_object('section', cur.section, 'action', cur.action),
                             'to', jsonb_build_object('section', o->>'section', 'action', o->>'action')));
        moved := moved || cur.key;
      end if;
      -- 0049: "Keep current intent" holds only for the recommendation a
      -- person reviewed. When the engine now recommends something materially
      -- different, that suppression lifts and the decision comes back.
      if cur.status = 'dismissed' and cur.suppressed and cur.suppression_basis is not null
         and authority_recommendation_basis(cur.key, o) is distinct from cur.suppression_basis then
        insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
        values (cur.id, r.client_id, p_run_id, 'reopened', 'engine',
          jsonb_build_object('reason', 'recommendation changed', 'reviewed', cur.suppression_basis,
                             'now', authority_recommendation_basis(cur.key, o)));
        reopened := reopened || cur.key;
        cur.status := 'open'; cur.suppressed := false; cur.suppression_basis := null; cur.status_reason := null;
      end if;
      -- 0053: a recurring Business Profile opportunity starts a new cycle
      -- when the engine reports it eligible again (its cadence has passed)
      -- and this cycle's linked work is done: an older approved post never
      -- completes it for good.
      if o->>'content_type' = 'gbp_post' and o->>'section' = 'ready' and o->>'action' = 'create'
         and nullif(o->>'eligible_from', '') is null and cur.status <> 'dismissed'
         and exists (select 1 from authority_opportunity_links l where l.opportunity_id = cur.id
                      and l.created_at >= coalesce(cur.cycle_started_at, '-infinity'::timestamptz) and authority_link_state(l) = 'done')
         and not exists (select 1 from authority_opportunity_links l where l.opportunity_id = cur.id
                      and l.created_at >= coalesce(cur.cycle_started_at, '-infinity'::timestamptz) and authority_link_state(l) = 'active') then
        insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
        values (cur.id, r.client_id, p_run_id, 'reopened', 'engine',
          jsonb_build_object('reason', 'new cadence cycle', 'previous_cycle_started_at', cur.cycle_started_at));
        reopened := reopened || cur.key;
        cur.status := 'open'; cur.cycle_started_at := now();
      end if;
      -- A normal dismissal ends on its date, and only then; a suppression
      -- never does.
      if cur.status = 'dismissed' and not cur.suppressed and cur.dismissed_until <= v_as_of then
        insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
        values (cur.id, r.client_id, p_run_id, 'reopened', 'engine',
          jsonb_build_object('reason', 'dismissal expired', 'until', cur.dismissed_until));
        reopened := reopened || cur.key;
        cur.status := 'open'; cur.dismissed_until := null; cur.status_reason := null;
      end if;
      update authority_opportunities set
        last_seen_run_id = p_run_id, last_seen_at = now(), present = true,
        section = o->>'section', action = o->>'action', tier = o->>'tier', content_type = o->>'content_type', topic = o->>'topic',
        service_id = (o->>'service_id')::uuid, keyword_id = (o->'target'->>'keyword_id')::uuid, intent = o->'target'->>'intent',
        target_path = o->'target'->>'owner_path',
        sort_order = coalesce((select array_agg(x::int) from jsonb_array_elements_text(o->'order') x), '{}'),
        eligible_from = (o->>'eligible_from')::date, opportunity = o,
        status = cur.status, dismissed_until = cur.dismissed_until, status_reason = cur.status_reason,
        suppressed = cur.suppressed, suppression_basis = cur.suppression_basis, cycle_started_at = cur.cycle_started_at
      where id = cur.id;
    end if;
  end loop;

  -- No longer reported: resolved (presence only; the workflow status is kept).
  for cur in select * from authority_opportunities
              where client_id = r.client_id and present and not (key = any (v_keys)) for update loop
    update authority_opportunities set present = false where id = cur.id;
    insert into authority_opportunity_events (opportunity_id, client_id, run_id, kind, actor_kind, detail)
    values (cur.id, r.client_id, p_run_id, 'resolved', 'engine', jsonb_build_object('reason', 'no longer reported'));
    resolved := resolved || cur.key;
  end loop;

  update authority_runs set status = 'completed', finished_at = now(),
    diff = jsonb_build_object('added', to_jsonb(added), 'resolved', to_jsonb(resolved),
      'regressed', to_jsonb(regressed), 'section_changed', to_jsonb(moved), 'reopened', to_jsonb(reopened))
  where id = p_run_id;
  perform set_config('compass.authority_write', '', true);
  return jsonb_build_object('run_id', p_run_id, 'status', 'completed', 'added', cardinality(added), 'resolved', cardinality(resolved),
    'regressed', cardinality(regressed), 'section_changed', cardinality(moved), 'reopened', cardinality(reopened));
end $$;
revoke all on function authority_record_run(uuid, jsonb) from public, anon, authenticated;
grant execute on function authority_record_run(uuid, jsonb) to service_role;

-- ── 7. drafter_write: the Authority hand-off ────────────────────────────────
create or replace function drafter_write(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
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
  if coalesce(v_target->>'channel', '') <> 'google_business' then
    raise exception 'The drafter writes Business Profile posts only in v1' using errcode = 'check_violation';
  end if;
  -- Claims: only ones the brief allowed.
  select coalesce(array_agg((c->>'id')::uuid), '{}') into v_allowed
    from jsonb_array_elements(coalesce(v_brief->'allowed_facts'->'claims', '[]')) c;
  if not (v_claims <@ v_allowed) then
    raise exception 'A linked claim is not in the brief' using errcode = 'check_violation';
  end if;
  if cardinality(v_assets) > 1 then
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
    -- Cadence, live (the analysis may be older than the last post).
    if exists (select 1 from social_posts sp
                where sp.client_id = v_client and sp.platform::text = 'google_business' and sp.service_id = v_service
                  and sp.search_intent = v_target->>'search_intent'
                  and (sp.review_status in ('draft', 'in_review', 'approved') or sp.publish_status::text = 'published')
                  and sp.created_at > now() - interval '21 days') then
      raise exception 'authority_conflict cadence_active: A post for this service and intent was created in the last 21 days' using errcode = 'AU409';
    end if;
  end if;

  -- One open drafter post per client, channel, service and intent.
  if exists (select 1 from social_posts
             where client_id = v_client and drafter_run_id is not null
               and platform::text = v_target->>'channel' and service_id is not distinct from v_service
               and search_intent = v_target->>'search_intent' and review_status in ('draft', 'in_review')) then
    raise exception 'An open drafted post already exists for this service and intent' using errcode = 'unique_violation';
  end if;

  insert into drafter_runs (client_id, requested_via, requested_by, target, brief_version, brief_hash, brief,
                            claim_ids, runtime, attempt, lint, copy_hash, status, authority_opportunity_id)
  values (v_client, coalesce(p->>'requested_via', 'worker'), nullif(p->>'requested_by', '')::uuid, v_target,
          p->>'brief_version', p->>'brief_hash', v_brief, v_claims, p->>'runtime',
          coalesce((p->>'attempt')::int, 1), p->'lint', drafter_copy_hash(v_copy), 'writing', v_opp)
  returning id into v_run;

  insert into social_posts (client_id, platform, post_type, search_intent, service_id, keyword_id, offer_id,
                            cta_type, cta_url, copy, crm_facts_only, drafter_run_id)
  values (v_client, (v_target->>'channel')::social_platform, v_target->>'post_type', v_target->>'search_intent',
          v_service, nullif(v_target->'keyword'->>'id', '')::uuid, nullif(v_target->'offer'->>'id', '')::uuid,
          v_cta_type, v_cta_url, v_copy, false, v_run)
  returning id into v_post;

  insert into post_claims (post_id, client_id, claim_id)
  select v_post, v_client, c from unnest(v_claims) c;
  i := 0;
  while i < cardinality(v_assets) loop
    i := i + 1;
    insert into post_assets (post_id, client_id, brand_asset_id, sort_order) values (v_post, v_client, v_assets[i], i);
  end loop;

  update social_posts set review_status = 'in_review' where id = v_post returning review_task_id into v_task;
  update drafter_runs set status = 'submitted', post_id = v_post where id = v_run;

  -- 0053: the post drives the opportunity's lifecycle (in review → in
  -- progress, approved → completed); the request is done, not linked.
  if v_opp is not null then
    perform authority_decide(v_opp, 'link', jsonb_build_object('kind', 'social_post', 'id', v_post));
    update tasks set status = 'done', completed_at = now(),
      notes = coalesce(notes || E'\n', '') || format('Drafted: post %s (drafter run %s), now in review.', v_post, v_run)
     where id = v_req.id;
  end if;

  return jsonb_build_object('run_id', v_run, 'post_id', v_post, 'review_task_id', v_task,
    'authority_opportunity_id', v_opp, 'request_task_id', v_req.id);
end $$;
revoke all on function drafter_write(jsonb) from public, anon, authenticated;
grant execute on function drafter_write(jsonb) to service_role;

-- ── 8. Verify ───────────────────────────────────────────────────────────────
do $$
declare
  v_apply text := (select prosrc from pg_proc where oid = 'public.authority_apply(uuid, text, jsonb, jsonb)'::regprocedure);
  v_write text := (select prosrc from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure);
  v_run text := (select prosrc from pg_proc where oid = 'public.authority_record_run(uuid, jsonb)'::regprocedure);
begin
  if (select prosecdef from pg_proc where oid = 'public.authority_apply(uuid, text, jsonb, jsonb)'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure) then
    raise exception '0053: authority_apply and drafter_write must run with the caller''s rights';
  end if;
  if v_apply not like '%session_user = ''authenticator''%' or v_apply not like '%''request_draft''%' then
    raise exception '0053: authority_apply lost its caller gate or request_draft';
  end if;
  if v_apply not like '%array_remove(supporting_keyword_ids, v_kw.id)%' or v_apply not like '%''location_unapproved''%' then
    raise exception '0053: authority_apply lost 0051 / 0052';
  end if;
  if v_write not like '%drafter_caller_is_service()%' or v_write not like '%authority_conflict not_requested%'
     or v_write not like '%authority_conflict cadence_active%' or v_write not like '%''kind'', ''social_post''%' then
    raise exception '0053: drafter_write lost its gate or the Authority hand-off';
  end if;
  if v_run not like '%new cadence cycle%' or v_run not like '%authority_recommendation_basis%' then
    raise exception '0053: authority_record_run lost the cycle or 0049';
  end if;
  if has_function_privilege('anon', 'public.authority_apply(uuid, text, jsonb, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.authority_draft_start(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.drafter_write(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.drafter_write(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.authority_record_run(uuid, jsonb)', 'execute') then
    raise exception '0053: a grant is wider than intended';
  end if;
  if has_table_privilege('anon', 'public.authority_opportunity_state', 'select')
     or has_table_privilege('authenticated', 'public.authority_opportunity_state', 'insert,update,delete') then
    raise exception '0053: authority_opportunity_state grants are wider than intended';
  end if;
  if pg_get_viewdef('public.authority_opportunity_state'::regclass) not like '%cycle_started_at%' then
    raise exception '0053: the state view does not scope links to the cycle';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'tasks_authority_draft_open_key') then
    raise exception '0053: the one-open-request index is missing';
  end if;
end $$;
