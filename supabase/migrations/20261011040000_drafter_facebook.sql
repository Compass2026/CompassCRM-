-- AI Drafter: Facebook drafts (Oct 11 2026; docs/zernio-publisher.md,
-- "Facebook drafts").
--
-- The post-drafter function may now write a Facebook draft through the same
-- governed path as a Business Profile draft: the brief is rebuilt from live
-- Client Intelligence, the linter passes it, and drafter_write creates the
-- post and submits it to 0045's human review in one transaction. Nothing is
-- approved, scheduled or published by it.
--
-- drafter_write (0054's, with these changes only):
-- - The channel may be facebook. A Facebook draft:
--   - is a standard post with no button;
--   - names one of the client's own Facebook Pages explicitly
--     (brief.target.social_account.id → social_posts.social_account_id), so
--     the approval snapshot binds the Page;
--   - carries at most one image, which must be a stored, hashed photo or
--     social graphic of the client.
-- - Authority hand-offs stay Business Profile only.
-- - A Business Profile brief may not name a social account.
-- - Open drafts:
--   - Business Profile keeps one open drafted post per service and intent.
--   - A Facebook queue holds one open draft per concept: no two open drafted
--     Facebook posts may share the same copy or the same image.
--
-- Unchanged:
-- - who may call it (the post-drafter function's service session only);
-- - the linter requirement and the brief's claims;
-- - 0045's grounding at submit;
-- - every Business Profile and Authority rule.
--
-- Rollback: re-create drafter_write from 0054.

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
  elsif nullif(v_target->'social_account'->>'id', '') is not null then
    raise exception 'Only a Facebook draft names a social account' using errcode = 'check_violation';
  end if;
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
end $$;
revoke all on function drafter_write(jsonb) from public, anon, authenticated;
grant execute on function drafter_write(jsonb) to service_role;
