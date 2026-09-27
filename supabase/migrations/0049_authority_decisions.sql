-- 0049 Authority decisions (Decisions PR B): a person's decision on an
-- Authority opportunity, with the canonical change it implies, as ONE
-- transaction.
--
--   authority_apply(opportunity, action, payload, expected)
--     keep_intent     decision + suppression bound to the reviewed recommendation
--     set_intent      keywords.intent, to the intent the engine recommends
--     approve_market  locations: the market's row turned on, or inserted with coordinates
--     decline_market  decision + suppression (Authority decision only)
--     confirm_service services: an approved service owning the live page
--     not_offered     decision + suppression (Authority decision only)
--     create_task     tasks insert + authority_opportunity_links + events
--
-- Rights: authority_apply runs with the CALLER's rights, so every client-data
-- write goes through the teammate's own RLS (is_team()). It refuses anyone
-- but a signed-in teammate through PostgREST (session_user authenticator,
-- role authenticated, on team_members): the worker's SQL, the service role,
-- a portal contact, a stranger and anon are refused before anything is read.
-- Every Authority write goes through authority_decide (security definer,
-- 0048), which checks the caller again, so the decision, the suppression, the
-- link and the canonical write commit together or not at all.
--
-- Changed since preview: the caller sends what the preview showed
-- (p_expected: the run the opportunity was last reported by, its stored
-- workflow and the before-values of the rows it will write). The opportunity
-- and those rows are locked, then compared; any difference refuses the whole
-- call with SQLSTATE AU409 and nothing is written.
--
-- Refinement 1 (keep current intent): the suppression carries
-- suppression_basis, the recommendation the person reviewed ({keyword_id,
-- stored, assessed} from the engine's report). authority_record_run lifts it
-- when a later completed run reports a materially different recommendation
-- for the same keyword (event 'reopened', reason 'recommendation changed');
-- the same recommendation, or unrelated data changes, leave it suppressed.
-- The opportunity keeps its key. authority_decide's suppress accepts a basis
-- only when it equals the recommendation as currently reported.
--
-- Refinement 2: decline_market and not_offered create no Client Intelligence
-- record. Their decision event says so in so many words.
--
-- Refinement 3: create_task inserts the task and links it (authority_decide
-- link: link + accepted + linked events) in the same transaction.
--
-- Nothing here writes the website, change_log, social posts, drafter runs or
-- any portal view. The app starts an Authority refresh after a canonical
-- change; the database does not.
--
-- Rollback (before any decision uses it): restore authority_record_run and
-- authority_decide from 0048, drop authority_apply, authority_lock_opportunity,
-- authority_recommendation_basis and authority_norm_place, then drop the
-- column suppression_basis (with its check).

-- ── 1. The reviewed recommendation ─────────────────────────────────────────
alter table authority_opportunities add column suppression_basis jsonb;
alter table authority_opportunities add constraint authority_opportunities_basis_suppressed
  check (suppression_basis is null or (suppressed and jsonb_typeof(suppression_basis) = 'object'));
comment on column authority_opportunities.suppression_basis is
  'The recommendation a person reviewed when they kept the current intent (0049). The suppression holds while the engine reports the same recommendation.';

-- What a decision on this opportunity was about, from the engine's report
-- entry: for an intent conflict, the keyword, its stored intent and the
-- intent the query reads as. NULL for every other kind (no bound suppression).
create function authority_recommendation_basis(p_key text, p_opportunity jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case when p_key like 'confirm\_intent:%' and p_opportunity is not null then jsonb_build_object(
    'keyword_id', p_opportunity->'target'->>'keyword_id',
    'stored', lower(p_opportunity->'target'->>'intent'),
    'assessed', coalesce(substring(p_opportunity->>'gap' from 'the query reads as (.+)\.$'), p_opportunity->>'gap'))
  end
$$;
revoke all on function authority_recommendation_basis(text, jsonb) from public, anon;
grant execute on function authority_recommendation_basis(text, jsonb) to authenticated, service_role;

-- The engine's place normalisation (authority/urls.ts normPlace), for
-- matching a market's city to the opportunity it decides.
create function authority_norm_place(p text) returns text
language sql immutable set search_path = public as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(p, '')), '[''’]', '', 'g'),
    '\mst\M\.?', 'saint', 'g'), '[^a-z0-9]+', ' ', 'g'))
$$;
revoke all on function authority_norm_place(text) from public, anon;
grant execute on function authority_norm_place(text) to authenticated, service_role;

-- ── 2. authority_record_run: lift a suppression whose recommendation changed ─
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
        suppressed = cur.suppressed, suppression_basis = cur.suppression_basis
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

-- ── 3. authority_decide: suppress may carry the reviewed recommendation ────
create or replace function authority_decide(p_opportunity_id uuid, p_verb text, p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o authority_opportunities;
  v_person boolean := post_caller_is_human();
  v_actor uuid := case when post_caller_is_human() then task_actor() end;
  v_kind text := case when post_caller_is_human() then 'team' else 'drafter' end;
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_until date;
  v_link_kind text := p_payload->>'kind';
  v_ref uuid;
  v_basis jsonb := nullif(p_payload->'basis', 'null'::jsonb);
begin
  if not v_person and not (authority_caller_is_service() and p_verb in ('accept', 'link')) then
    raise exception 'Only a signed-in teammate decides Authority opportunities' using errcode = '42501';
  end if;
  select * into o from authority_opportunities where id = p_opportunity_id for update;
  if o.id is null then raise exception 'No such opportunity' using errcode = 'P0002'; end if;

  perform set_config('compass.authority_write', 'on', true);
  case p_verb
  when 'accept' then
    if o.status <> 'open' then raise exception 'Only an open opportunity can be accepted (it is %)', o.status using errcode = '22023'; end if;
    update authority_opportunities set status = 'accepted', decided_by = v_actor, decided_at = now() where id = o.id;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id)
    values (o.id, o.client_id, 'accepted', v_kind, v_actor);
  when 'release' then
    if not v_person then raise exception 'Only a person releases an opportunity' using errcode = '42501'; end if;
    if o.status <> 'accepted' then raise exception 'Only an accepted opportunity can be released' using errcode = '22023'; end if;
    update authority_opportunities set status = 'open', decided_by = v_actor, decided_at = now() where id = o.id;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id)
    values (o.id, o.client_id, 'released', v_kind, v_actor);
  when 'dismiss', 'suppress' then
    if not v_person then raise exception 'Only a person dismisses an opportunity' using errcode = '42501'; end if;
    if v_reason is null then raise exception 'A dismissal needs a reason' using errcode = '22023'; end if;
    if exists (select 1 from authority_opportunity_links l where l.opportunity_id = o.id and authority_link_state(l) = 'active') then
      raise exception 'Work is linked to this opportunity and still open; finish or close it first' using errcode = '22023';
    end if;
    -- A bound suppression names the recommendation as the engine reports it now.
    if v_basis is not null and (p_verb <> 'suppress' or v_basis is distinct from authority_recommendation_basis(o.key, o.opportunity)) then
      raise exception 'A suppression basis must be the recommendation as currently reported' using errcode = '22023';
    end if;
    if p_verb = 'dismiss' then
      v_until := nullif(p_payload->>'until', '')::date;
      if v_until is null then
        raise exception 'A dismissal needs a date (dismissed_until); "never recommend again" is suppress' using errcode = '22023';
      end if;
      if v_until <= (now() at time zone 'America/Chicago')::date then
        raise exception 'dismissed_until must be in the future' using errcode = '22023';
      end if;
    end if;
    update authority_opportunities set status = 'dismissed', status_reason = v_reason,
      dismissed_until = case when p_verb = 'dismiss' then v_until end, suppressed = (p_verb = 'suppress'),
      suppression_basis = v_basis, decided_by = v_actor, decided_at = now() where id = o.id;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id, detail)
    values (o.id, o.client_id, case when p_verb = 'suppress' then 'suppressed' else 'dismissed' end, v_kind, v_actor,
            jsonb_build_object('reason', v_reason, 'until', v_until)
            || case when v_basis is not null then jsonb_build_object('basis', v_basis) else '{}'::jsonb end);
  when 'reopen' then
    if not v_person then raise exception 'Only a person reopens an opportunity' using errcode = '42501'; end if;
    if o.status <> 'dismissed' then raise exception 'Only a dismissed opportunity can be reopened' using errcode = '22023'; end if;
    update authority_opportunities set status = 'open', suppressed = false, suppression_basis = null, dismissed_until = null,
      status_reason = null, decided_by = v_actor, decided_at = now() where id = o.id;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id, detail)
    values (o.id, o.client_id, 'reopened', v_kind, v_actor, jsonb_build_object('reason', 'reopened by a person'));
  when 'link' then
    if o.status = 'dismissed' then raise exception 'A dismissed opportunity takes no new work' using errcode = '22023'; end if;
    v_ref := (p_payload->>'id')::uuid;
    if v_link_kind not in ('social_post', 'drafter_run', 'content_post', 'change_log', 'task') or v_ref is null then
      raise exception 'link needs {kind, id}' using errcode = '22023';
    end if;
    -- The composite FKs refuse an asset of another client.
    insert into authority_opportunity_links (opportunity_id, client_id, created_by, kind, ref_id,
      social_post_id, drafter_run_id, content_post_id, change_log_id, task_id)
    values (o.id, o.client_id, v_actor, v_link_kind, v_ref,
      case when v_link_kind = 'social_post' then v_ref end, case when v_link_kind = 'drafter_run' then v_ref end,
      case when v_link_kind = 'content_post' then v_ref end, case when v_link_kind = 'change_log' then v_ref end,
      case when v_link_kind = 'task' then v_ref end);
    if o.status = 'open' then
      update authority_opportunities set status = 'accepted', decided_by = v_actor, decided_at = now() where id = o.id;
      insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id)
      values (o.id, o.client_id, 'accepted', v_kind, v_actor);
    end if;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id, detail)
    values (o.id, o.client_id, 'linked', v_kind, v_actor, jsonb_build_object('kind', v_link_kind, 'id', v_ref));
  when 'decision' then
    if not v_person then raise exception 'Only a person records a decision' using errcode = '42501'; end if;
    if nullif(btrim(coalesce(p_payload->>'decision', '')), '') is null then
      raise exception 'A decision needs its text' using errcode = '22023';
    end if;
    insert into authority_opportunity_events (opportunity_id, client_id, kind, actor_kind, actor_id, detail)
    values (o.id, o.client_id, 'decision', v_kind, v_actor, p_payload);
  else
    raise exception 'Unknown verb %', p_verb using errcode = '22023';
  end case;
  perform set_config('compass.authority_write', '', true);
  return (select to_jsonb(s) - 'opportunity' from authority_opportunity_state s where s.id = o.id);
end $$;
revoke all on function authority_decide(uuid, text, jsonb) from public, anon;
grant execute on function authority_decide(uuid, text, jsonb) to authenticated, service_role;

-- ── 4. Locking an opportunity for a decision ────────────────────────────────
-- authority_apply runs as the caller, who has no UPDATE right on Authority
-- tables and so cannot SELECT … FOR UPDATE them. This locks the row (until
-- the transaction ends) for a signed-in teammate only, and returns it.
create function authority_lock_opportunity(p_opportunity_id uuid) returns authority_opportunities
language plpgsql security definer set search_path = public as $$
declare o authority_opportunities;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate decides Authority opportunities' using errcode = '42501';
  end if;
  select * into o from authority_opportunities where id = p_opportunity_id for update;
  if o.id is null then raise exception 'No such opportunity' using errcode = 'P0002'; end if;
  return o;
end $$;
revoke all on function authority_lock_opportunity(uuid) from public, anon;
grant execute on function authority_lock_opportunity(uuid) to authenticated;

-- ── 5. authority_apply ──────────────────────────────────────────────────────
create function authority_apply(p_opportunity_id uuid, p_action text, p_payload jsonb default '{}', p_expected jsonb default '{}')
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
begin
  -- A signed-in teammate through PostgREST, and nobody else.
  if not (session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'authenticated' and is_team()) then
    raise exception 'Only a signed-in Compass teammate applies Authority decisions' using errcode = '42501';
  end if;
  if p_action not in ('keep_intent', 'set_intent', 'approve_market', 'decline_market', 'confirm_service', 'not_offered', 'create_task') then
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
  end case;

  return jsonb_build_object('action', p_action, 'opportunity_id', o.id, 'client_id', o.client_id,
    'canonical_change', v_canonical, 'id', v_id);
end $$;
revoke all on function authority_apply(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function authority_apply(uuid, text, jsonb, jsonb) to authenticated;

-- ── 6. Verify ───────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('anon', 'public.authority_apply(uuid, text, jsonb, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.authority_lock_opportunity(uuid)', 'execute') then
    raise exception 'anon can call an Authority decision function';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.authority_apply(uuid, text, jsonb, jsonb)'::regprocedure) then
    raise exception 'authority_apply must run with the caller''s rights';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.authority_lock_opportunity(uuid)'::regprocedure) then
    raise exception 'authority_lock_opportunity must be security definer';
  end if;
  if position('suppression_basis' in (select prosrc from pg_proc where oid = 'public.authority_record_run(uuid, jsonb)'::regprocedure)) = 0 then
    raise exception 'authority_record_run does not honour suppression_basis';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename like 'authority\_%' and cmd <> 'SELECT') then
    raise exception 'An Authority table has a write policy';
  end if;
  if exists (select 1 from pg_views where schemaname = 'public' and viewname like 'portal\_%' and definition ilike '%authority%') then
    raise exception 'A portal view reads Authority';
  end if;
end $$;
