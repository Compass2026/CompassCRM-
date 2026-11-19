-- Rollback of 20261104200000_claim_verification.sql: back to Claims Registry
-- v1 (the superuser-only lock, the v1 registry). No gate, approval or drafter
-- function reads these objects (the migration's verify block proved it).
--
-- History is never deleted (ChatGPT review, refinement 3): once any claim
-- review or evidence file has been recorded, this rollback refuses and the fix
-- is a forward migration. Claim history rows in creative_governance_events are
-- kept either way. The claim-evidence bucket is left in place (empty, private:
-- Supabase refuses direct bucket deletes); re-applying the migration reuses it.
do $refuse$
begin
  if exists (select 1 from claim_reviews) or exists (select 1 from claim_evidence)
     or exists (select 1 from claim_evidence_uploads)
     or exists (select 1 from storage.objects where bucket_id = 'claim-evidence') then
    raise exception 'claim verification has recorded history or evidence: it is kept, so this rollback refuses (fix forward)';
  end if;
end $refuse$;

drop function if exists claim_revoke(uuid, text, text, uuid);
drop function if exists claim_verify(uuid, text, text, text, date, text, uuid, uuid, uuid, date, text, text);
drop function if exists claim_classify(uuid, text, text, uuid, text);
drop function if exists claim_review_open(uuid, text, uuid);
drop trigger if exists claims_keep_reviewed on claims;
drop function if exists claims_keep_reviewed();
alter table claims drop column if exists review_id;
drop table if exists claim_reviews;
drop function if exists claim_reviews_audit();
drop function if exists claim_reviews_guard();
drop function if exists claim_own_hosts(uuid, uuid);
drop function if exists claim_workspace_ids(uuid, uuid);
drop function if exists claim_location_identity_sha256(uuid);
drop function if exists claim_fingerprint(uuid, text, text, text);
drop function if exists claim_evidence_intact(claim_evidence);
drop function if exists claim_evidence_register(uuid, text, text, bigint, text, text, text, text, text, date);
drop function if exists claim_evidence_request_upload(uuid, text, bigint, text);
drop trigger if exists claim_evidence_objects_immutable on storage.objects;
drop function if exists claim_evidence_objects_immutable();
drop trigger if exists claim_evidence_bucket_guard on storage.buckets;
drop function if exists claim_evidence_bucket_guard();
drop function if exists claim_evidence_bucket_sound();
drop policy if exists "team read claim evidence" on storage.objects;
drop table if exists claim_evidence;
drop function if exists claim_evidence_guard();
drop table if exists claim_evidence_uploads;
drop function if exists claim_evidence_uploads_guard();
drop function if exists claim_evidence_ext(text);
drop table if exists claim_verification_authorities;
drop function if exists claim_verification_authorities_guard();
drop function if exists claim_reviewer_authority();

-- v1's lock, history fields and registry, exactly as 20261103220000 wrote them.
create or replace function claims_registry_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if (new.kind, new.verification_method, new.verified_at, new.verified_by, new.review_by, new.superseded_by)
       is not distinct from (null::text, null::text, null::timestamptz, null::uuid, null::date, null::uuid) then
      return new;
    end if;
  elsif (new.kind, new.verification_method, new.verified_at, new.verified_by, new.review_by, new.superseded_by)
        is not distinct from (old.kind, old.verification_method, old.verified_at, old.verified_by, old.review_by, old.superseded_by) then
    return new;
  end if;
  if drafter_caller_is_superuser() then
    return new;
  end if;
  raise exception 'A claim''s classification, verification, review date and successor are locked until the verification workflow is released'
    using errcode = 'insufficient_privilege';
end $$;
revoke all on function claims_registry_guard() from public, anon, authenticated;

create or replace function claim_history_fields() returns text[]
language sql immutable set search_path = public as $$
  select array['claim', 'status', 'source', 'confirmed_by', 'confirmed_on', 'kind', 'verification_method',
               'verified_at', 'verified_by', 'review_by', 'superseded_by']
$$;
revoke all on function claim_history_fields() from public, anon, authenticated;

create or replace function claim_registry(p_client_id uuid, p_today date default null) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  c clients;
  v_today date := coalesce(p_today, (now() at time zone 'America/Chicago')::date);
  v_has_ws boolean;
  v_claims jsonb;
  v_programs jsonb;
begin
  if not coalesce(is_team(), false) then
    raise exception 'The claims registry is for the Compass team' using errcode = 'insufficient_privilege';
  end if;
  select * into c from clients where id = p_client_id;
  if c.id is null then
    raise exception 'Client % not found', p_client_id using errcode = 'no_data_found';
  end if;
  v_has_ws := exists (select 1 from client_brand_workspaces where client_id = c.id);

  with
  ws as (
    select w.id, w.slug, w.name, w.website_url, w.status, w.claim_ids, w.phone, w.sort_key
      from (select w.*, row_number() over (order by w.created_at, w.slug) sort_key
              from client_brand_workspaces w where w.client_id = c.id) w
  ),
  hosts as (
    select claim_url_host(u) host from (
      select c.website_url u union all select s.url from sites s where s.client_id = c.id
      union all select ws.website_url from ws) x
     where claim_url_host(u) is not null
  ),
  -- Client-wide numbers (the client and its brand workspaces) and each
  -- approved location's own number (citation_locations). A claim's phone is
  -- compared with both; a number on neither is a POTENTIAL mismatch only,
  -- since other location-specific numbers are not evaluated yet.
  phones as (
    select claim_phone_digits(p) digits from (select c.phone p union all select ws.phone from ws) x
     where claim_phone_digits(p) is not null
  ),
  -- Approved means approved by someone (ChatGPT 42aca6fb final review):
  -- approved_at is NOT NULL DEFAULT now() on citation_locations, so every row
  -- has one; approved_by records who approved it. An active location without
  -- a recorded approver is not an approved identity, and its number is not
  -- treated as one.
  location_phones as (
    select claim_phone_digits(l.phone) digits, l.label
      from citation_locations l
     where l.client_id = c.id and l.status = 'active'
       and l.approved_at is not null and l.approved_by is not null
       and claim_phone_digits(l.phone) is not null
  ),
  base as (
    select cl.*, iv.review_days, iv.authoritative_methods, coalesce(iv.kind, 'unclassified') eff_kind,
           (cl.status::text = 'confirmed' or (cl.status::text = 'sourced' and nullif(btrim(coalesce(cl.source, '')), '') is not null)) legacy_usable,
           claim_source_url(cl.source) src_url,
           case when cl.verified_at is not null and cl.verification_method is not null then cl.verified_at
                when cl.status::text = 'confirmed' then cl.confirmed_on end last_verified_at,
           tm.name verified_by_name
      from claims cl
      join claim_review_intervals iv on iv.kind = coalesce(cl.kind, 'unclassified')
      left join team_members tm on tm.id = cl.verified_by
     where cl.client_id = c.id
  ),
  b2 as (
    select b.*,
           claim_url_host(b.src_url) src_host,
           case when b.last_verified_at is null then b.review_by
                else least(b.review_by, (b.last_verified_at at time zone 'America/Chicago')::date + b.review_days) end due_on,
           (b.verified_at is not null and b.verification_method = any (b.authoritative_methods)) authoritative,
           -- A text or source change after the last verification that did not
           -- itself verify the claim.
           (b.last_verified_at is not null and exists (
              select 1 from creative_governance_events e
               where e.subject_type = 'claim' and e.subject_id = b.id and e.action = 'updated'
                 and (e.changes ? 'claim' or e.changes ? 'source')
                 and not (e.changes ? 'verified_at' or e.changes ? 'confirmed_on')
                 and e.created_at > b.last_verified_at)) changed_since_verified,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', sp.id, 'platform', sp.platform, 'review_status', sp.review_status,
                     'publish_status', sp.publish_status, 'published_at', sp.published_at,
                     'published_url', sp.published_url) order by sp.published_at desc nulls last, sp.created_at, sp.id), '[]')
              from post_claims pc join social_posts sp on sp.id = pc.post_id where pc.claim_id = b.id) posts,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', d.id, 'deliverable', d.deliverable, 'status', d.status, 'title', d.title,
                     'published_url', cp.url, 'published_at', cp.published_at) order by d.created_at, d.id), '[]')
              from content_draft_claims dc join content_drafts d on d.id = dc.draft_id
              left join content_posts cp on cp.id = d.final_content_post_id
             where dc.claim_id = b.id) drafts,
           array(select ws.slug from ws where b.id = any (ws.claim_ids) order by ws.sort_key) programs,
           -- Another claim's note that says it supersedes this one by id: the
           -- whole id, or its first 8 characters as a word when they name only
           -- this claim of the client. TENTATIVE (ChatGPT 42aca6fb C): never a
           -- bucket, never a gate; only superseded_by marks a claim superseded.
           (select coalesce(jsonb_agg(o.id order by o.id), '[]') from claims o
             where o.client_id = b.client_id and o.id <> b.id
               and (coalesce(o.claim, '') || ' ' || coalesce(o.source, '')) ~* 'supersed'
               and ((coalesce(o.claim, '') || ' ' || coalesce(o.source, '')) ~* ('\m' || b.id::text || '\M')
                    or ((coalesce(o.claim, '') || ' ' || coalesce(o.source, '')) ~* ('\m' || left(b.id::text, 8) || '\M')
                        and (select count(*) from claims z where z.client_id = b.client_id
                                and left(z.id::text, 8) = left(b.id::text, 8)) = 1))) supersession_mentioned_by,
           (select coalesce(jsonb_agg(o.id order by o.id), '[]') from claims o where o.superseded_by = b.id) supersedes,
           claim_phone_digits(b.claim) phone
      from base b
  ),
  b3 as (
    select b.*,
           case when b.last_verified_at is null then 'never_verified'
                when b.due_on < v_today then 'overdue'
                when b.due_on - v_today <= 14 then 'due'
                else 'current' end freshness,
           case when nullif(btrim(coalesce(b.source, '')), '') is null then 'none'
                when (b.source ~* '\msummar(y|ies)\M') then 'search_summary'
                when b.src_host is not null and exists (select 1 from hosts h where h.host = b.src_host) then 'client_site'
                when b.src_host ~ '(^|\.)google\.[a-z.]+$' or b.src_host = 'g.page' then 'google'
                when b.src_host ~ '\.(gov|mil)$' then 'government'
                when b.src_host is not null then 'third_party_web'
                when b.source ~* 'confirm' then 'confirmation_note'
                else 'text_note' end source_class,
           (select count(*) from jsonb_array_elements(b.posts) p where p->>'publish_status' = 'published')
             + (select count(*) from jsonb_array_elements(b.drafts) d where d->>'published_url' is not null) published_count
      from b2 b
  ),
  b4 as (
    select b.*,
           array_remove(array[
             case when b.superseded_by is not null then 'superseded' end,
             case when b.status::text = 'unverified' then 'unverified' end,
             case when b.status::text = 'sourced' and b.source_class = 'none' then 'missing_source' end,
             case when b.freshness = 'overdue' then 'overdue' end,
             case when b.freshness = 'due' then 'due_soon' end,
             case when b.freshness = 'never_verified' then 'never_verified' end,
             case when b.kind is null then 'unclassified' end,
             case when b.last_verified_at is not null and b.verified_at is null then 'method_unrecorded' end,
             case when b.verified_at is not null and not b.authoritative then 'method_not_authoritative' end,
             case when b.changed_since_verified then 'changed_since_verified' end,
             case when not b.legacy_usable and (jsonb_array_length(b.posts) + jsonb_array_length(b.drafts)) > 0 then 'cited_while_unusable' end,
             case when not b.legacy_usable and b.published_count > 0 then 'published_while_unusable' end,
             case when b.superseded_by is not null and (jsonb_array_length(b.posts) + jsonb_array_length(b.drafts)) > 0 then 'cited_while_superseded' end,
             case when jsonb_array_length(b.supersession_mentioned_by) > 0 then 'supersession_mentioned' end,
             case when (coalesce(b.claim, '') || ' ' || coalesce(b.source, '')) ~* '\m(conflict[a-z]*|contradict[a-z]*|inconsistent)\M' then 'conflict_noted' end,
             case when b.source_class = 'search_summary' then 'summary_source' end,
             case when b.phone is not null and exists (select 1 from phones p where p.digits = b.phone) then 'duplicates_structured_phone' end,
             case when b.phone is not null and not exists (select 1 from phones p where p.digits = b.phone)
                       and exists (select 1 from location_phones l where l.digits = b.phone) then 'matches_location_phone' end,
             case when b.phone is not null and (exists (select 1 from phones) or exists (select 1 from location_phones))
                       and not exists (select 1 from phones p where p.digits = b.phone)
                       and not exists (select 1 from location_phones l where l.digits = b.phone) then 'phone_potential_mismatch' end,
             case when b.phone is not null and not exists (select 1 from phones) and not exists (select 1 from location_phones) then 'phone_without_structured_record' end,
             case when v_has_ws and cardinality(b.programs) = 0 then 'unassigned_to_site' end,
             case when cardinality(b.programs) > 1 then 'shared_across_sites' end
           ], null) reasons,
           case when b.superseded_by is not null then 'superseded'
                when b.status::text = 'unverified' then 'unverified'
                when b.status::text = 'sourced' and b.source_class = 'none' then 'missing_source'
                when b.freshness = 'overdue' then 'stale'
                when b.freshness = 'never_verified' or b.kind is null or not b.authoritative or b.changed_since_verified then 'needs_review'
                when b.freshness = 'due' then 'due'
                else 'verified' end bucket
      from b3 b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           -- Two separate questions (ChatGPT 42aca6fb B): may today's rules cite
           -- it (legacy_usable, unchanged), and has it been independently
           -- verified with an authoritative method (never true for a legacy
           -- confirmation or a URL alone).
           'id', b.id, 'claim', b.claim, 'status', b.status, 'legacy_usable', b.legacy_usable,
           'verification_state', case when b.verified_at is not null and b.authoritative then 'independently_verified'
                                      else 'not_independently_verified' end,
           'bucket', b.bucket, 'reasons', to_jsonb(b.reasons),
           'kind', b.kind, 'kind_label', (select label from claim_review_intervals where kind = b.eff_kind),
           'recorded_at', b.created_at,
           'verification', jsonb_build_object(
              'method', b.verification_method, 'authoritative', case when b.verified_at is not null then b.authoritative end,
              'authoritative_methods', to_jsonb(b.authoritative_methods),
              'verified_at', b.verified_at, 'verified_by', b.verified_by, 'verified_by_name', b.verified_by_name,
              'confirmed_by', b.confirmed_by, 'confirmed_on', b.confirmed_on,
              'last_verified_at', b.last_verified_at, 'changed_since_verified', b.changed_since_verified),
           'freshness', jsonb_build_object(
              'state', b.freshness, 'interval_days', b.review_days, 'review_by', b.review_by, 'due_on', b.due_on,
              'days_left', case when b.due_on is not null then b.due_on - v_today end),
           'source', jsonb_build_object('text', b.source, 'url', b.src_url, 'host', b.src_host, 'class', b.source_class),
           'scope', jsonb_build_object(
              'programs', to_jsonb(b.programs),
              'shared', case when v_has_ws then cardinality(b.programs) > 1 end,
              'unassigned', case when v_has_ws then cardinality(b.programs) = 0 end),
           'superseded_by', b.superseded_by, 'supersedes', b.supersedes, 'supersession_mentioned_by', b.supersession_mentioned_by,
           'phone_location', (select l.label from location_phones l where l.digits = b.phone order by l.label limit 1),
           'affected', jsonb_build_object(
              'posts', b.posts, 'drafts', b.drafts, 'published', b.published_count,
              'total', jsonb_array_length(b.posts) + jsonb_array_length(b.drafts)))
         order by array_position(array['superseded', 'unverified', 'missing_source', 'stale', 'needs_review', 'due', 'verified'], b.bucket),
                  b.created_at, b.id), '[]')
    into v_claims
    from b4 b;

  -- One program per approved-or-draft brand workspace; a client with none is
  -- one program. A draft workspace's scope is not authoritative: its counts
  -- are null (unknown), not 0.
  select coalesce(jsonb_agg(p order by (p->>'sort_key')::int), '[]') into v_programs from (
    select jsonb_build_object(
             'sort_key', w.sort_key, 'workspace_id', w.id, 'slug', w.slug, 'name', w.name, 'website_url', w.website_url,
             'scope', 'brand_workspace', 'workspace_status', w.status, 'scope_authoritative', w.status = 'approved',
             'claim_ids', (select coalesce(jsonb_agg(x->'id' order by x->>'id'), '[]') from jsonb_array_elements(v_claims) x
                            where x->'scope'->'programs' ? w.slug),
             'counts', case when w.status = 'approved' then (
                select jsonb_build_object(
                  'total', count(*),
                  'verified', count(*) filter (where x->>'bucket' = 'verified'),
                  'due', count(*) filter (where x->>'bucket' = 'due'),
                  'stale', count(*) filter (where x->>'bucket' = 'stale'),
                  'needs_review', count(*) filter (where x->>'bucket' = 'needs_review'),
                  'unverified', count(*) filter (where x->>'bucket' = 'unverified'),
                  'missing_source', count(*) filter (where x->>'bucket' = 'missing_source'),
                  'superseded', count(*) filter (where x->>'bucket' = 'superseded'),
                  'legacy_usable', count(*) filter (where (x->>'legacy_usable')::boolean),
                  'shared', count(*) filter (where (x->'scope'->>'shared')::boolean),
                  'cited_while_unusable', count(*) filter (where x->'reasons' ? 'cited_while_unusable'))
                 from jsonb_array_elements(v_claims) x where x->'scope'->'programs' ? w.slug) end) p
      from (select w.*, row_number() over (order by w.created_at, w.slug) sort_key
              from client_brand_workspaces w where w.client_id = c.id) w
    union all
    select jsonb_build_object(
             'sort_key', 0, 'workspace_id', null, 'slug', null, 'name', c.name, 'website_url', c.website_url,
             'scope', 'client', 'workspace_status', null, 'scope_authoritative', true,
             'claim_ids', (select coalesce(jsonb_agg(x->'id' order by x->>'id'), '[]') from jsonb_array_elements(v_claims) x),
             'counts', null)
     where not v_has_ws
  ) q;

  return jsonb_build_object(
    'version', 'claim-registry/v1',
    'client_id', c.id,
    'client', c.name,
    'as_of', now(),
    'today', v_today,
    'multi_site', v_has_ws,
    'intervals', (select jsonb_agg(jsonb_build_object('kind', kind, 'label', label, 'review_days', review_days,
                                                      'authoritative_methods', authoritative_methods) order by review_days, kind)
                    from claim_review_intervals),
    'totals', (select jsonb_build_object(
                  'total', count(*),
                  'verified', count(*) filter (where x->>'bucket' = 'verified'),
                  'due', count(*) filter (where x->>'bucket' = 'due'),
                  'stale', count(*) filter (where x->>'bucket' = 'stale'),
                  'needs_review', count(*) filter (where x->>'bucket' = 'needs_review'),
                  'unverified', count(*) filter (where x->>'bucket' = 'unverified'),
                  'missing_source', count(*) filter (where x->>'bucket' = 'missing_source'),
                  'superseded', count(*) filter (where x->>'bucket' = 'superseded'),
                  'legacy_usable', count(*) filter (where (x->>'legacy_usable')::boolean),
                  'cited_while_unusable', count(*) filter (where x->'reasons' ? 'cited_while_unusable'),
                  'published_while_unusable', count(*) filter (where x->'reasons' ? 'published_while_unusable'),
                  'unassigned', case when v_has_ws then count(*) filter (where (x->'scope'->>'unassigned')::boolean) end,
                  'shared', case when v_has_ws then count(*) filter (where (x->'scope'->>'shared')::boolean) end)
                 from jsonb_array_elements(v_claims) x),
    -- A single-site client's one program carries the client totals.
    'programs', case when v_has_ws then v_programs
                     else (select jsonb_agg(p || jsonb_build_object('counts', (
                              select jsonb_build_object(
                                'total', count(*),
                                'verified', count(*) filter (where x->>'bucket' = 'verified'),
                                'due', count(*) filter (where x->>'bucket' = 'due'),
                                'stale', count(*) filter (where x->>'bucket' = 'stale'),
                                'needs_review', count(*) filter (where x->>'bucket' = 'needs_review'),
                                'unverified', count(*) filter (where x->>'bucket' = 'unverified'),
                                'missing_source', count(*) filter (where x->>'bucket' = 'missing_source'),
                                'superseded', count(*) filter (where x->>'bucket' = 'superseded'),
                                'legacy_usable', count(*) filter (where (x->>'legacy_usable')::boolean),
                                'shared', null,
                                'cited_while_unusable', count(*) filter (where x->'reasons' ? 'cited_while_unusable'))
                               from jsonb_array_elements(v_claims) x)))
                             from jsonb_array_elements(v_programs) p) end,
    'claims', v_claims);
end $$;
revoke all on function claim_registry(uuid, date) from public, anon;
grant execute on function claim_registry(uuid, date) to authenticated, service_role;
