-- Claims Registry v1 (Nov 3 2026): COMPASS-2027-ROADMAP W1 / P1.1a. Executive
-- OS task 11454716, proposal ae049b45, ChatGPT decision cabb4e9a. See
-- docs/claim-registry.md.
--
-- ChatGPT review 42aca6fb (Nov 3 2026): the new columns are locked to
-- every application caller until PR2's controlled verification workflow.
--
-- Additive and read-only. It changes NO gate: what a post or draft may cite is
-- still decided by social_post_grounding_problems / content_draft_problems
-- (confirmed, or sourced with a source; never unverified), exactly as before.
-- The verify block at the end proves it by hashing every reader of claims
-- before and after.
--
--   1. claim_review_intervals: one reviewed row per claim kind (how often it is
--      re-verified, and which verification methods are authoritative for it).
--      Changed only by a reviewed migration; team read.
--   2. claims gains nullable classification / verification / review /
--      supersession columns. Nothing is backfilled: every column is NULL until
--      PR2's owner-approved writers set it, and NULL reads as "not verified",
--      never as verified.
--   3. claims_registry_guard: those columns are LOCKED. No signed-in
--      teammate, Edge Function, worker or PostgREST caller may set them
--      (42501); only a superuser session (platform administration, and the
--      sandbox suites seeding fixtures) can. PR2 replaces this with guarded,
--      audited, owner-approved writers tied to evidence.
--   4. Claim history in the existing creative_governance_events store
--      (subject_type 'claim'): append-only, written only by trigger, actor from
--      the session, team read. A deleted claim keeps its history.
--   5. claim_registry(client): STABLE, security invoker, team only. Per claim:
--      legacy usability (today's gate rule, unchanged) kept apart from
--      independent verification (never true for a legacy confirmation),
--      freshness, a bucket, source class, site-program scope from the approved
--      brand workspaces, affected posts and drafts, and indicators. Per program
--      and client: counts. Unknown is null, never 0.
--
-- Not here (later PRs): writers, disputed / retired statuses, delete →
-- retire, proof objects, service / market scope, readiness integration and any
-- enforcement.
-- Rollback: supabase/rollback/20261103220000_claim_registry.down.sql

do $guard$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'claims' and column_name = 'verified_at') then
    raise exception '20261103220000: claims.verified_at already exists';
  end if;
end $guard$;

-- Every function that reads claims for a gate, an approval or the drafter,
-- hashed now and again at the end: this migration must leave all of them
-- byte-identical.
create temp table claim_registry_pinned on commit drop as
  select p.oid::regprocedure::text as fn, md5(pg_get_functiondef(p.oid)) as h
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and (p.prosrc ~ '\mclaims\M' or p.prosrc ~ 'claim_ids');

-- ── 1. Review intervals ─────────────────────────────────────────────────────
-- ChatGPT decision cabb4e9a, D1 / D2. review_days is how often a verified claim
-- is reviewed again (a review, not an expiry of truth); a verified document's
-- own expiry is set on claims.review_by and the earlier date wins.
-- authoritative_methods are the verification methods that settle that kind of
-- fact; any other method is supporting evidence only.
create table claim_review_intervals (
  kind text primary key check (kind ~ '^[a-z_]{3,40}$'),
  label text not null check (length(btrim(label)) between 1 and 60),
  review_days integer not null check (review_days between 1 and 730),
  authoritative_methods text[] not null
    check (authoritative_methods <@ array['client_contract', 'manufacturer_document', 'issuer_record',
                                          'structured_record', 'platform_record', 'client_confirmation',
                                          'client_published', 'third_party']::text[]),
  basis text not null check (length(btrim(basis)) between 1 and 500)
);
comment on table claim_review_intervals is
  'Reviewed review intervals per claim kind (20261103220000; ChatGPT decision cabb4e9a). Changed only by a reviewed migration. ''unclassified'' applies to a claim with no kind.';
insert into claim_review_intervals (kind, label, review_days, authoritative_methods, basis) values
  ('rating_review', 'Rating or review count', 30, array['platform_record'],
   'Ratings and review counts move weekly; the platform listing is the only authority.'),
  ('offering', 'Offer or service availability', 90, array['client_confirmation', 'client_contract'],
   'What the client offers (free quotes, inspections) is the client''s to confirm.'),
  ('contact_identity', 'Contact or identity detail', 90, array['structured_record'],
   'Phone, address and hours are governed by verified structured location / onboarding records; a claim only mirrors them.'),
  ('service_description', 'Service description', 180, array['client_confirmation', 'client_published'],
   'What the client does, as the client publishes or confirms it.'),
  ('warranty_guarantee', 'Warranty or guarantee', 180, array['client_contract', 'manufacturer_document'],
   'The signed project agreement governs the client''s own workmanship term; a manufacturer document governs product coverage.'),
  ('experience_stat', 'Experience or volume figure', 365, array['client_confirmation'],
   'Years in business, jobs completed, people trained: the client confirms the figure.'),
  ('credential', 'Licence, certification or accreditation', 365, array['issuer_record'],
   'The issuing body (government, manufacturer programme, BBB) governs; a document''s expiry, when earlier, is the review date.'),
  ('reference_fact', 'Third-party reference fact', 365, array['issuer_record'],
   'A regulation or official guidance, settled by its publisher.'),
  ('unclassified', 'Not yet classified', 90, array[]::text[],
   'A claim with no kind is reviewed for priority and is never verified until it is classified.');

alter table claim_review_intervals enable row level security;
create policy "team reads review intervals" on claim_review_intervals for select to authenticated
  using ((select is_team()));
revoke all on claim_review_intervals from public, anon, authenticated;
grant select on claim_review_intervals to authenticated, service_role;

-- ── 2. Registry columns on claims (all nullable; no backfill) ───────────────
alter table claims
  add column kind text references claim_review_intervals (kind) check (kind <> 'unclassified'),
  add column verification_method text check (verification_method in (
    'client_contract', 'manufacturer_document', 'issuer_record', 'structured_record',
    'platform_record', 'client_confirmation', 'client_published', 'third_party')),
  add column verified_at timestamptz,
  add column verified_by uuid references team_members (id) on delete set null,
  add column review_by date,
  add column superseded_by uuid,
  add constraint claims_verification_pair check ((verified_at is null) = (verification_method is null)),
  add constraint claims_verified_by_needs_verification check (verified_by is null or verified_at is not null),
  add constraint claims_not_self_superseded check (superseded_by is distinct from id),
  -- The successor must be one of this client's own claims.
  add constraint claims_superseded_by_fkey foreign key (superseded_by, client_id) references claims (id, client_id);
create index claims_superseded_by_idx on claims (superseded_by) where superseded_by is not null;
comment on column claims.kind is 'Claim kind (claim_review_intervals). NULL = unclassified: reviewed for priority, never verified (20261103220000).';
comment on column claims.verification_method is 'How the claim was last verified. Authoritative only when listed for its kind in claim_review_intervals.';
comment on column claims.verified_at is 'When a teammate last verified the claim against its evidence. NULL = never verified under the registry (a legacy confirmation is read from confirmed_on).';
comment on column claims.verified_by is 'The teammate who verified it. Locked in v1 (claims_registry_guard); PR2''s verification workflow stamps it from the session.';
comment on column claims.review_by is 'An earlier review date than the kind''s interval (e.g. a credential document''s expiry). The earlier of the two wins.';
comment on column claims.superseded_by is 'The same client''s claim that replaces this one. Read by the registry only; no gate reads it yet.';

-- ── 3. Locked until PR2 ─────────────────────────────────────────────────────
-- A method token or a date is not verification: PR2 must tie each one to
-- linked authoritative evidence and an authorized reviewer (ChatGPT decision
-- 42aca6fb A). Until then no application caller may set these columns: not a
-- signed-in teammate (the CRM's own forms, or a direct PostgREST write), not
-- an Edge Function (service role), not the worker's SQL. Only a superuser
-- session can, which the CRM never is. Every other claim edit is unaffected.
create function claims_registry_guard() returns trigger
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
create trigger claims_registry_guard before insert or update on claims
  for each row execute function claims_registry_guard();

-- ── 4. History (the existing governance event store) ───────────────────────
alter table creative_governance_events drop constraint creative_governance_events_subject_type_check;
alter table creative_governance_events add constraint creative_governance_events_subject_type_check
  check (subject_type in ('brand_asset', 'template', 'client_template', 'client_setting', 'creative_asset', 'claim'));
comment on table creative_governance_events is
  'Append-only governance history: source-image review, template registration and client approval, creative policy, creative withdrawal, and claims (20261103220000). Written only by trigger.';

create function claim_history_fields() returns text[]
language sql immutable set search_path = public as $$
  select array['claim', 'status', 'source', 'confirmed_by', 'confirmed_on', 'kind', 'verification_method',
               'verified_at', 'verified_by', 'review_by', 'superseded_by']
$$;
revoke all on function claim_history_fields() from public, anon, authenticated;

-- created / deleted carry the whole governed record; updated carries
-- {field: {from, to}} for what changed. A claim deleted because its client
-- was deleted is not recorded (the client's history goes with it).
create function claims_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_changes jsonb;
begin
  if tg_op = 'INSERT' then
    perform creative_governance_log(new.client_id, 'claim', new.id, 'created',
      creative_diff('{}'::jsonb, to_jsonb(new), claim_history_fields()));
  elsif tg_op = 'UPDATE' then
    v_changes := creative_diff(to_jsonb(old), to_jsonb(new), claim_history_fields());
    if v_changes <> '{}'::jsonb then
      perform creative_governance_log(new.client_id, 'claim', new.id, 'updated', v_changes);
    end if;
  else
    if exists (select 1 from clients where id = old.client_id) then
      perform creative_governance_log(old.client_id, 'claim', old.id, 'deleted',
        creative_diff(to_jsonb(old), '{}'::jsonb, claim_history_fields()));
    end if;
  end if;
  return null;
end $$;
revoke all on function claims_history() from public, anon, authenticated;
create trigger claims_history after insert or update or delete on claims
  for each row execute function claims_history();

-- ── 5. The registry (read-only) ─────────────────────────────────────────────
-- First URL in a free-text source, and its host without www.
create function claim_source_url(p_source text) returns text
language sql immutable set search_path = pg_catalog as $$
  select (regexp_match(coalesce(p_source, ''), 'https?://[^[:space:]"''<>()]+'))[1]
$$;
create function claim_url_host(p_url text) returns text
language sql immutable set search_path = pg_catalog as $$
  select nullif(regexp_replace(lower(split_part(split_part(coalesce(p_url, ''), '://', 2), '/', 1)), '^www\.|:[0-9]+$', '', 'g'), '')
$$;
-- The ten digits of the first North American phone number in a text.
create function claim_phone_digits(p_text text) returns text
language sql immutable set search_path = pg_catalog as $$
  select regexp_replace(m[1], '[^0-9]', '', 'g')
    from (select regexp_match(coalesce(p_text, ''), '(\(?[2-9][0-9]{2}\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4})') m) x
   where m is not null
$$;
revoke all on function claim_source_url(text), claim_url_host(text), claim_phone_digits(text) from public, anon;
grant execute on function claim_source_url(text), claim_url_host(text), claim_phone_digits(text) to authenticated, service_role;

-- Bucket (one per claim, first match wins):
--   superseded      superseded_by is set
--   unverified      status unverified
--   missing_source  sourced with a blank source
--   stale           a verification whose review date has passed
--   needs_review    usable today but not independently verified for the
--                   registry: never verified, unclassified, the method is not
--                   authoritative for the kind (a legacy confirmation records
--                   none), or the text / source changed since verification
--   due             verified, review within 14 days
--   verified        classified, verified by an authoritative method, current
-- legacy_usable is today's gate rule, reported unchanged.
create function claim_registry(p_client_id uuid, p_today date default null) returns jsonb
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
  location_phones as (
    select claim_phone_digits(l.phone) digits, l.label
      from citation_locations l
     where l.client_id = c.id and l.status = 'active' and claim_phone_digits(l.phone) is not null
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

-- ── 6. Verify ───────────────────────────────────────────────────────────────
do $verify$
declare
  v_changed text;
begin
  select string_agg(p.fn, ', ') into v_changed
    from claim_registry_pinned p
   where p.h is distinct from (select md5(pg_get_functiondef(p.fn::regprocedure)));
  if v_changed is not null then
    raise exception '20261103220000 changed a reader of claims: %', v_changed;
  end if;
  if (select provolatile from pg_proc where oid = 'public.claim_registry(uuid,date)'::regprocedure) <> 's'
     or (select prosecdef from pg_proc where oid = 'public.claim_registry(uuid,date)'::regprocedure) then
    raise exception 'claim_registry must be stable and security invoker';
  end if;
  if has_function_privilege('anon', 'public.claim_registry(uuid,date)', 'execute')
     or has_function_privilege('authenticated', 'public.claims_registry_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.claims_history()', 'execute')
     or has_table_privilege('anon', 'public.claim_review_intervals', 'select')
     or has_table_privilege('authenticated', 'public.claim_review_intervals', 'insert, update, delete, truncate')
     or has_table_privilege('authenticated', 'public.creative_governance_events', 'insert, update, delete, truncate') then
    raise exception 'claim registry grants';
  end if;
  if exists (select 1 from claims where kind is not null or verification_method is not null or verified_at is not null
                or verified_by is not null or review_by is not null or superseded_by is not null) then
    raise exception 'claim registry columns must start empty (no backfill)';
  end if;
end $verify$;
