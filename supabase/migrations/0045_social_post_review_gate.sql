-- Post record with a human review gate (five-layer plan, layer 1 → 3;
-- Sept 23 2026). Design approved Sept 23 after review; plan in
-- docs/client-intelligence.md, sequence step 4.
--
-- social_posts is evolved in place (0 rows on production, checked Sept 23)
-- into the one record every AI-drafted or hand-written social / Business
-- Profile post lives in. content_posts (blog) stays separate. Nothing is
-- published by this migration and no publisher exists yet: the worker never
-- calls google-ops gbp_posts or gbp_qa (PRs #57, #58), and google-ops is
-- unchanged.
--
-- 1. The old free-for-all `status` column and the `social_post_status` type
--    are dropped (verified before the drop: the table is empty, nothing but
--    that column and its index uses the type, and no view, function, policy
--    or cron job reads the column). Two statuses replace it:
--      review_status   draft → in_review → approved | rejected
--      publish_status  not_scheduled → scheduled → publishing → published | failed
--    Anything past not_scheduled requires review_status = 'approved'.
--    The legacy single-asset columns (asset_url, storage_path) are dropped
--    too: post_assets is the one media relationship. post_type is
--    'standard' or 'offer' (Business Profile only); Event posts come later
--    with their own fields and adapter.
-- 2. Human approval. Only a signed-in team member reaching the database
--    through the API may approve, reject or reopen: session_user =
--    'authenticator' (PostgREST), role 'authenticated', and auth.uid()
--    resolving to a team_members row. The worker (SQL as postgres), Edge
--    Functions on the service role, pg_cron and triggers never qualify. A
--    person may approve their own draft. reviewed_by / created_by /
--    updated_by hold team_members.id, never an Auth UUID, and are stamped by
--    trigger; callers cannot set them.
-- 3. Grounding, checked when a post is submitted, when it is approved and
--    when publishing starts (social_post_grounding_problems):
--    - a linked claim counts only if confirmed, or sourced with a source;
--      any linked unverified (or source-less sourced) claim blocks;
--    - informational, commercial and transactional posts need at least one
--      usable linked claim;
--    - a navigational post may have no claims only when crm_facts_only is
--      set: the author states the copy uses only directly stored CRM facts
--      (business name, phone, website, approved services, locations and
--      service area, other explicit client fields); the reviewer confirms
--      that by approving. Any other factual assertion needs a claim;
--    - a linked offer must be confirmed and not past its end date (dates
--      stay optional; channel rules such as what Google requires for an
--      OFFER post are the publishing adapter's);
--    - a linked service must be approved;
--    - topic: a standard informational / commercial / transactional post
--      needs an approved service_id; a navigational post may be
--      brand-level; an offer post needs its offer_id (service optional for
--      a business-wide offer); keyword_id is always optional.
-- 4. Approved content is frozen: content columns change only while a post is
--    a draft, and claims / assets are linked only to drafts. Approval stores
--    approved_snapshot (content + claim text + offer terms + assets) and its
--    sha256 approved_hash; publishing starts only if the current snapshot
--    still hashes the same.
-- 5. Lapse: when a linked claim is unverified, edited or deleted, an offer or
--    service changes status or terms, or an asset changes, an approved post
--    that has not started publishing goes back to in_review (approval
--    cleared, unscheduled, new review task, a grounding_lapsed event). A
--    published or publishing post only gets the event. A daily job catches
--    offers that end by date.
-- 6. Publishing (the publisher is the service role; no publisher exists
--    yet): scheduled → publishing re-checks everything and counts the
--    attempt; publishing → published needs external_post_id, published_url
--    and published_at; → failed needs the error; failed → scheduled retries.
--    A publishing change may not touch any review column, so scheduling,
--    publishing and retries never alter a valid approval. publish_key is a
--    per-post idempotency key; (platform, external_post_id) is unique.
--    Manual publication: a signed-in team member may mark an approved
--    facebook / instagram / linkedin / x / tiktok post published after
--    posting it natively (from not_scheduled, scheduled or failed). The
--    approval hash and grounding are re-checked, published_at and an https
--    published_url are required, external_post_id may be null, and the
--    event names the person (detail.manual = true). A Business Profile post
--    is never marked published by hand: only the publisher can.
-- 7. Review tasks stay in the task system: submitting opens one
--    `post_review` task per post in the CLAUDE_APPROVAL lane (the hold lane:
--    the work is drafted, a person decides; the Brief lists it under "needs
--    a decision"), unassigned, linked by review_task_id; approving,
--    rejecting or withdrawing closes it; a lapse opens a new one.
-- 8. post_claims, post_assets and the append-only post_events (written only
--    by trigger) all carry (post_id, client_id) with composite FKs, as do
--    the post's own links (keyword, service, offer, account, review task),
--    so nothing on a post can belong to another client.
--
-- Access is team-only (is_team(), 0036). No portal_* view references any of
-- it. anon loses every privilege on social_posts (it held Supabase's default
-- ALL; RLS already blocked it).
--
-- Rollback (while no post exists): drop the three new tables, the new
-- functions and triggers, the added columns and constraints, the
-- social-posts-recheck cron job and the id/client unique keys; recreate
-- social_post_status and social_posts.status as in 0001. The
-- 'google_business' enum value cannot be removed (harmless if unused).

-- ── 0. The old status column is safe to drop ─────────────────────────────────
do $$
begin
  if exists (select 1 from social_posts) then
    raise exception '0045: social_posts has rows; the old status column would need converting first';
  end if;
  if exists (
    select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
    where a.atttypid = 'social_post_status'::regtype and not a.attisdropped
      and c.relkind <> 'i'  -- social_posts_client_id_status_idx is dropped below
      and not (a.attrelid = 'public.social_posts'::regclass and a.attname = 'status')
  ) then
    raise exception '0045: another column uses social_post_status';
  end if;
  if exists (
    select 1 from pg_proc
    where prorettype = 'social_post_status'::regtype
       or 'social_post_status'::regtype = any (proargtypes)
       or prosrc ilike '%social_post_status%'
       or (prosrc ilike '%social_posts%' and prosrc ilike '%status%')
  ) then
    raise exception '0045: a function refers to social_posts.status or social_post_status';
  end if;
  if exists (select 1 from pg_views where definition ilike '%social_posts%')
     or exists (select 1 from pg_matviews where definition ilike '%social_posts%') then
    raise exception '0045: a view reads social_posts';
  end if;
  if exists (select 1 from pg_policies where tablename = 'social_posts'
             and (coalesce(qual, '') ilike '%status%' or coalesce(with_check, '') ilike '%status%')) then
    raise exception '0045: a policy reads social_posts.status';
  end if;
  if exists (select 1 from cron.job where command ilike '%social_posts%') then
    raise exception '0045: a cron job touches social_posts';
  end if;
end $$;

drop index if exists social_posts_client_id_status_idx;
alter table social_posts drop column status;   -- no CASCADE: anything else depending on it fails the migration
drop type social_post_status;
-- post_assets is the one media relationship (brand assets, ordered, with
-- content hashes). The legacy single-asset columns go while the table is
-- empty rather than living on as a second media model.
alter table social_posts drop column asset_url, drop column storage_path;

-- Business Profile posts are social posts too. Added in this transaction, so
-- it is only compared as text below (a new enum value cannot be used as a
-- literal until the transaction commits).
alter type social_platform add value if not exists 'google_business';

-- ── 1. Composite keys the same-client FKs point at ───────────────────────────
alter table claims        add constraint claims_id_client_key        unique (id, client_id);
alter table services      add constraint services_id_client_key      unique (id, client_id);
alter table offers        add constraint offers_id_client_key        unique (id, client_id);
alter table keywords      add constraint keywords_id_client_key      unique (id, client_id);
alter table brand_assets  add constraint brand_assets_id_client_key  unique (id, client_id);
alter table social_accounts add constraint social_accounts_id_client_key unique (id, client_id);
-- tasks_id_client_key exists (0043).

-- ── 2. The post record ───────────────────────────────────────────────────────
alter table social_posts
  add column post_type      text not null default 'standard',
  add column search_intent  text not null,
  add column keyword_id     uuid,
  add column service_id     uuid,
  add column offer_id       uuid,
  add column cta_type       text,
  add column cta_url        text,
  add column crm_facts_only boolean not null default false,
  add column author_kind    text not null default 'worker',
  add column created_by     uuid references team_members(id),
  add column updated_by     uuid references team_members(id) on delete set null,
  add column created_at     timestamptz not null default now(),
  add column updated_at     timestamptz,
  add column review_status  text not null default 'draft',
  add column submitted_at   timestamptz,
  add column reviewed_by    uuid references team_members(id),
  add column reviewed_at    timestamptz,
  add column review_note    text,
  add column approved_snapshot jsonb,
  add column approved_hash  text,
  add column review_task_id uuid,
  add column publish_status text not null default 'not_scheduled',
  add column publish_key    uuid not null default gen_random_uuid(),
  add column publish_attempts int not null default 0,
  add column last_attempt_at timestamptz,
  add column published_at   timestamptz;

alter table social_posts
  add constraint social_posts_id_client_key unique (id, client_id),
  add constraint social_posts_publish_key_key unique (publish_key),
  drop constraint social_posts_social_account_id_fkey,
  add constraint social_posts_account_fkey foreign key (social_account_id, client_id)
    references social_accounts (id, client_id) on delete set null (social_account_id),
  add constraint social_posts_keyword_fkey foreign key (keyword_id, client_id)
    references keywords (id, client_id) on delete set null (keyword_id),
  -- A service or offer a post names cannot be deleted; retire it instead,
  -- which sends an approved post back to review.
  add constraint social_posts_service_fkey foreign key (service_id, client_id)
    references services (id, client_id),
  add constraint social_posts_offer_fkey foreign key (offer_id, client_id)
    references offers (id, client_id),
  add constraint social_posts_review_task_fkey foreign key (review_task_id, client_id)
    references tasks (id, client_id) on delete set null (review_task_id),
  -- Event posts come later, with their own fields and publishing adapter.
  add constraint social_posts_post_type_known check (post_type in ('standard', 'offer')),
  add constraint social_posts_intent_known
    check (search_intent in ('navigational', 'informational', 'commercial', 'transactional')),
  add constraint social_posts_author_kind_known check (author_kind in ('human', 'worker')),
  add constraint social_posts_human_author check (author_kind = 'worker' or created_by is not null),
  add constraint social_posts_review_status_known
    check (review_status in ('draft', 'in_review', 'approved', 'rejected')),
  add constraint social_posts_publish_status_known
    check (publish_status in ('not_scheduled', 'scheduled', 'publishing', 'published', 'failed')),
  -- Offer posts are a Business Profile post type.
  add constraint social_posts_gbp_types check (post_type = 'standard' or platform::text = 'google_business'),
  add constraint social_posts_offer_post_has_offer check (post_type <> 'offer' or offer_id is not null),
  add constraint social_posts_crm_facts_navigational check (not crm_facts_only or search_intent = 'navigational'),
  -- No execution state without a human approval.
  add constraint social_posts_execution_needs_approval
    check (publish_status = 'not_scheduled' or review_status = 'approved'),
  add constraint social_posts_approval_complete check (
    review_status <> 'approved'
    or (reviewed_by is not null and reviewed_at is not null and approved_snapshot is not null and approved_hash is not null)),
  add constraint social_posts_rejection_explained check (
    review_status <> 'rejected'
    or (reviewed_by is not null and reviewed_at is not null and nullif(btrim(review_note), '') is not null)),
  add constraint social_posts_scheduled_has_time check (publish_status <> 'scheduled' or scheduled_at is not null),
  -- A published post always says where and when. Google's id is required
  -- for a Business Profile post (only the publisher publishes those); a
  -- social post a person published by hand may have none.
  add constraint social_posts_published_complete check (
    publish_status <> 'published'
    or (published_url is not null and published_at is not null
        and (external_post_id is not null or platform::text <> 'google_business'))),
  add constraint social_posts_failed_explained check (publish_status <> 'failed' or nullif(btrim(error), '') is not null),
  add constraint social_posts_attempts_nonnegative check (publish_attempts >= 0);

create unique index social_posts_platform_external_id_key
  on social_posts (platform, external_post_id) where external_post_id is not null;
create index social_posts_client_review_idx on social_posts (client_id, review_status);
create index social_posts_client_publish_idx on social_posts (client_id, publish_status);
create index social_posts_offer_idx on social_posts (offer_id) where offer_id is not null;
create index social_posts_service_idx on social_posts (service_id) where service_id is not null;

comment on table social_posts is
  'Social and Business Profile posts. review_status is the human gate; publish_status is execution and needs an approval. Content is frozen once submitted; see 0045.';
comment on column social_posts.crm_facts_only is
  'Navigational posts only: the copy states nothing beyond directly stored CRM facts (name, phone, website, approved services, locations / service area, explicit client fields), so it needs no claim. Confirmed by the reviewer on approval.';
comment on column social_posts.approved_snapshot is
  'What was approved: content, claim text, offer terms, linked assets. Publishing sends this, and starts only if the live content still hashes to approved_hash.';
comment on column social_posts.reviewed_by is 'team_members.id of the person who approved or rejected. Never an Auth UUID.';

-- ── 3. Links and history ─────────────────────────────────────────────────────
create table post_claims (
  post_id uuid not null,
  client_id uuid not null,
  claim_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (post_id, claim_id),
  foreign key (post_id, client_id) references social_posts (id, client_id) on delete cascade,
  -- Deleting a claim unlinks it; a post that relied on it goes back to review.
  foreign key (claim_id, client_id) references claims (id, client_id) on delete cascade
);
create index post_claims_claim_idx on post_claims (claim_id);
comment on table post_claims is 'Claims a post stands on. Linked only while the post is a draft.';

create table post_assets (
  post_id uuid not null,
  client_id uuid not null,
  brand_asset_id uuid not null,
  sort_order int not null default 0,
  content_hash text,
  created_at timestamptz not null default now(),
  primary key (post_id, brand_asset_id),
  foreign key (post_id, client_id) references social_posts (id, client_id) on delete cascade,
  foreign key (brand_asset_id, client_id) references brand_assets (id, client_id) on delete cascade
);
create index post_assets_asset_idx on post_assets (brand_asset_id);
comment on table post_assets is 'The media a post uses: brand assets in sort_order, with an optional content hash. Linked only while the post is a draft. The only media relationship for posts.';

create table post_events (
  id bigint generated always as identity primary key,
  post_id uuid not null,
  client_id uuid not null,
  actor_id uuid references team_members(id) on delete set null,
  actor_kind text not null check (actor_kind in ('team', 'worker', 'system', 'publisher')),
  kind text not null check (kind in (
    'created', 'edited', 'claim_linked', 'claim_unlinked', 'asset_linked', 'asset_unlinked',
    'submitted', 'withdrawn', 'approved', 'rejected', 'revised', 'reopened', 'grounding_lapsed',
    'scheduled', 'rescheduled', 'unscheduled', 'publishing', 'published', 'failed', 'retried')),
  from_value text,
  to_value text,
  detail jsonb,
  created_at timestamptz not null default now(),
  foreign key (post_id, client_id) references social_posts (id, client_id) on delete cascade
);
create index post_events_post_idx on post_events (post_id, id);
comment on table post_events is
  'Append-only post history, written only by trigger. actor_id is a team_members.id; NULL with actor_kind worker / system / publisher.';

-- ── 4. Who is calling ────────────────────────────────────────────────────────
-- Security definer does not change session_user or the role GUC, so these
-- still see the real caller when called from the triggers below.
create or replace function post_caller_is_human() returns boolean
language sql stable security definer set search_path = public as $$
  select session_user = 'authenticator'
     and current_setting('role', true) = 'authenticated'
     and coalesce(auth.role(), '') = 'authenticated'
     and task_actor() is not null
$$;
revoke execute on function post_caller_is_human() from public, anon, authenticated;

create or replace function post_caller_kind() returns text
language sql stable security definer set search_path = public as $$
  select case
    when coalesce(current_setting('compass.post_system', true), '') = 'on' then 'system'
    when post_caller_is_human() then 'team'
    when session_user = 'authenticator' and current_setting('role', true) = 'service_role' then 'publisher'
    else 'worker'
  end
$$;
revoke execute on function post_caller_kind() from public, anon, authenticated;

-- ── 5. Grounding and the approval snapshot ───────────────────────────────────
create or replace function social_post_grounding_problems(p social_posts) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare
  v_problems text[] := '{}';
  v_usable int := 0;
  v_linked int := 0;
  c record;
  o record;
  v_service_status text;
  v_today date := (now() at time zone 'America/Chicago')::date;
begin
  if nullif(btrim(coalesce(p.copy, '')), '') is null then
    v_problems := v_problems || 'The post has no copy.'::text;
  end if;

  for c in
    select cl.claim, cl.status::text as status, cl.source
    from post_claims pc join claims cl on cl.id = pc.claim_id
    where pc.post_id = p.id
  loop
    v_linked := v_linked + 1;
    if c.status = 'confirmed' or (c.status = 'sourced' and nullif(btrim(coalesce(c.source, '')), '') is not null) then
      v_usable := v_usable + 1;
    elsif c.status = 'sourced' then
      v_problems := v_problems || format('Claim "%s" is marked sourced but has no source.', left(c.claim, 80));
    else
      v_problems := v_problems || format('Claim "%s" is unverified; unlink it or verify it.', left(c.claim, 80));
    end if;
  end loop;

  if p.search_intent <> 'navigational' and v_usable = 0 then
    v_problems := v_problems || format('%s %s post needs at least one confirmed or sourced claim.', case when p.search_intent = 'informational' then 'An' else 'A' end, p.search_intent);
  end if;
  if p.search_intent = 'navigational' and v_linked = 0 and not p.crm_facts_only then
    v_problems := v_problems ||
      'A navigational post with no claims must be marked "CRM facts only" (name, phone, website, approved services, service area); otherwise link a claim.'::text;
  end if;

  -- Topic: a standard informational / commercial / transactional post is
  -- about an approved service; a navigational post may be brand-level; an
  -- offer post is about its offer (the service may be null when the offer
  -- is business-wide). keyword_id is always optional.
  if p.post_type = 'standard' and p.search_intent <> 'navigational' and p.service_id is null then
    v_problems := v_problems || format('%s %s post needs an approved service as its topic.', case when p.search_intent = 'informational' then 'An' else 'A' end, p.search_intent);
  end if;
  if p.post_type = 'offer' and p.offer_id is null then
    v_problems := v_problems || 'An offer post needs one of the client''s offers.'::text;
  end if;

  if p.offer_id is not null then
    select status, ends_on into o from offers where id = p.offer_id;
    if o.status is distinct from 'confirmed' then
      v_problems := v_problems || 'The offer is not confirmed.'::text;
    end if;
    if o.ends_on is not null and o.ends_on < v_today then
      v_problems := v_problems || format('The offer ended on %s.', o.ends_on);
    end if;
  end if;

  if p.service_id is not null then
    select status::text into v_service_status from services where id = p.service_id;
    if v_service_status is distinct from 'approved' then
      v_problems := v_problems || format('The service is %s, not approved.', coalesce(v_service_status, 'missing'));
    end if;
  end if;

  return v_problems;
end $$;
revoke execute on function social_post_grounding_problems(social_posts) from public, anon, authenticated;

create or replace function social_post_snapshot(p social_posts) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'platform', p.platform::text,
    'social_account_id', p.social_account_id,
    'post_type', p.post_type,
    'search_intent', p.search_intent,
    'copy', p.copy,
    'cta_type', p.cta_type,
    'cta_url', p.cta_url,
    'crm_facts_only', p.crm_facts_only,
    'service_id', p.service_id,
    'claims', coalesce((
      select jsonb_agg(jsonb_build_object('id', cl.id, 'claim', cl.claim, 'source', cl.source) order by cl.id)
      from post_claims pc join claims cl on cl.id = pc.claim_id where pc.post_id = p.id), '[]'::jsonb),
    'offer', (
      select jsonb_build_object('id', o.id, 'title', o.title, 'terms', o.terms, 'starts_on', o.starts_on, 'ends_on', o.ends_on)
      from offers o where o.id = p.offer_id),
    'assets', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'storage_path', a.storage_path, 'url', a.url,
                                          'content_hash', pa.content_hash, 'sort_order', pa.sort_order)
                       order by pa.sort_order, a.id)
      from post_assets pa join brand_assets a on a.id = pa.brand_asset_id where pa.post_id = p.id), '[]'::jsonb)
  )
$$;
revoke execute on function social_post_snapshot(social_posts) from public, anon, authenticated;

create or replace function social_post_hash(p_snapshot jsonb) returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(p_snapshot::text, 'UTF8')), 'hex')
$$;
revoke execute on function social_post_hash(jsonb) from public, anon, authenticated;

-- What the app shows next to Submit / Approve. Team only.
create or replace function social_post_readiness(p_post_id uuid) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare
  p social_posts;
begin
  if not is_team() then
    raise exception 'Only the Compass team can read posts' using errcode = 'insufficient_privilege';
  end if;
  select * into p from social_posts where id = p_post_id;
  if p.id is null then return null; end if;
  return social_post_grounding_problems(p);
end $$;
revoke execute on function social_post_readiness(uuid) from public, anon;
grant execute on function social_post_readiness(uuid) to authenticated;

-- ── 6. Review tasks ──────────────────────────────────────────────────────────
create or replace function social_post_open_review_task(p social_posts, p_reason text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_platform text := case p.platform::text
    when 'google_business' then 'Business Profile' when 'x' then 'X'
    else initcap(p.platform::text) end;
begin
  insert into tasks (client_id, title, owner, status, key, notes)
  values (
    p.client_id,
    left(format('Review %s post: %s', v_platform, coalesce(nullif(btrim(p.copy), ''), '(no copy)')), 120),
    'CLAUDE_APPROVAL', 'open', 'post_review',
    format('%s Open /clients/%s/social/%s to approve or reject it. post_id=%s', p_reason, p.client_id, p.id, p.id))
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function social_post_open_review_task(social_posts, text) from public, anon, authenticated;

create or replace function social_post_close_review_task(p_task_id uuid, p_outcome text) returns void
language sql security definer set search_path = public as $$
  update tasks
  set status = 'done', completed_at = now(),
      notes = concat_ws(E'\n', notes, p_outcome)
  where id = p_task_id and status <> 'done'
$$;
revoke execute on function social_post_close_review_task(uuid, text) from public, anon, authenticated;

-- ── 7. The workflow ──────────────────────────────────────────────────────────
create or replace function social_posts_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.review_status <> 'draft' or new.publish_status <> 'not_scheduled' then
    raise exception 'A new post starts as a draft that is not scheduled' using errcode = 'check_violation';
  end if;
  if new.submitted_at is not null or new.reviewed_by is not null or new.reviewed_at is not null
     or new.approved_snapshot is not null or new.approved_hash is not null or new.review_task_id is not null
     or new.external_post_id is not null or new.published_url is not null or new.published_at is not null
     or new.publish_attempts <> 0 or new.last_attempt_at is not null or new.error is not null then
    raise exception 'Review and publishing fields are set by the workflow, not on insert' using errcode = 'check_violation';
  end if;
  -- Authorship comes from the caller, never from the row.
  if post_caller_is_human() then
    new.author_kind := 'human';
    new.created_by := task_actor();
  else
    new.author_kind := 'worker';
    new.created_by := null;
  end if;
  new.created_at := now();
  new.updated_at := null;
  new.updated_by := null;
  new.publish_key := gen_random_uuid();
  return new;
end $$;
revoke execute on function social_posts_before_insert() from public, anon, authenticated;

create or replace function social_posts_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_kind text := post_caller_kind();
  v_human boolean := post_caller_is_human();
  v_review_change boolean := new.review_status is distinct from old.review_status;
  v_publish_change boolean := new.publish_status is distinct from old.publish_status;
  v_problems text[];
  v_snapshot jsonb;
  v_step text;
begin
  if new.client_id is distinct from old.client_id then
    raise exception 'A post cannot move to another client' using errcode = 'check_violation';
  end if;
  if new.id is distinct from old.id then
    raise exception 'A post id never changes' using errcode = 'check_violation';
  end if;
  if v_review_change and v_publish_change then
    raise exception 'Change the review status and the publishing status separately' using errcode = 'check_violation';
  end if;

  -- Stamps nobody may forge.
  new.author_kind := old.author_kind;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.publish_key := old.publish_key;
  new.updated_at := now();
  new.updated_by := case when v_human then task_actor() end;

  -- Content changes only while the post is (or becomes) a draft.
  if (new.platform, new.social_account_id, new.post_type, new.search_intent, new.service_id, new.offer_id,
      new.copy, new.cta_type, new.cta_url, new.crm_facts_only)
     is distinct from
     (old.platform, old.social_account_id, old.post_type, old.search_intent, old.service_id, old.offer_id,
      old.copy, old.cta_type, old.cta_url, old.crm_facts_only)
     and new.review_status <> 'draft'
     -- An account deleted under a post is the one change allowed later (FK SET NULL).
     and not (new.social_account_id is null and old.social_account_id is not null
              and (new.platform, new.post_type, new.search_intent, new.service_id, new.offer_id, new.copy,
                   new.cta_type, new.cta_url, new.crm_facts_only)
                  is not distinct from
                  (old.platform, old.post_type, old.search_intent, old.service_id, old.offer_id, old.copy,
                   old.cta_type, old.cta_url, old.crm_facts_only)) then
    raise exception 'The post is %; its content is frozen. Withdraw or reopen it to edit.', old.review_status
      using errcode = 'check_violation';
  end if;

  -- Review fields move only with a review transition.
  if not v_review_change then
    new.submitted_at := old.submitted_at;
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
    new.review_note := old.review_note;
    new.approved_snapshot := old.approved_snapshot;
    new.approved_hash := old.approved_hash;
    -- Only an FK SET NULL (the task was deleted) may clear the link.
    if new.review_task_id is not null
       or exists (select 1 from tasks where id = old.review_task_id) then
      new.review_task_id := old.review_task_id;
    end if;
  else
    new.review_task_id := old.review_task_id;
  end if;

  -- Publishing results move only with a publishing transition, by the publisher.
  if not v_publish_change then
    if (new.external_post_id, new.published_url, new.published_at, new.error, new.publish_attempts, new.last_attempt_at)
       is distinct from
       (old.external_post_id, old.published_url, old.published_at, old.error, old.publish_attempts, old.last_attempt_at) then
      raise exception 'Publishing results are recorded by the publisher with a publishing transition'
        using errcode = 'check_violation';
    end if;
  elsif v_kind <> 'publisher'
        and not (new.publish_status = 'published' and old.publish_status in ('not_scheduled', 'scheduled', 'failed')) then
    -- Scheduling, unscheduling and retrying keep the last attempt's record.
    -- (A person marking a hand-published social post records its own
    -- result; that step is checked below.)
    new.publish_attempts := old.publish_attempts;
    new.last_attempt_at := old.last_attempt_at;
    new.external_post_id := old.external_post_id;
    new.published_url := old.published_url;
    new.published_at := old.published_at;
    new.error := old.error;
  end if;

  if new.scheduled_at is distinct from old.scheduled_at and old.publish_status in ('publishing', 'published') then
    raise exception 'The post is %; its schedule can no longer change', old.publish_status using errcode = 'check_violation';
  end if;

  -- ── Review transitions ──
  if v_review_change then
    v_step := old.review_status || '>' || new.review_status;
    case v_step
      when 'draft>in_review' then
        v_problems := social_post_grounding_problems(new);
        if cardinality(v_problems) > 0 then
          raise exception 'The post cannot be submitted: %', array_to_string(v_problems, ' ')
            using errcode = 'check_violation';
        end if;
        new.submitted_at := now();
        new.reviewed_by := null; new.reviewed_at := null;
        new.review_note := null;
        new.approved_snapshot := null; new.approved_hash := null;
        new.review_task_id := social_post_open_review_task(new, 'Submitted for review.');

      when 'in_review>draft' then  -- withdrawn by anyone
        perform social_post_close_review_task(old.review_task_id, 'Withdrawn before review.');
        new.submitted_at := null;
        new.review_task_id := null;

      when 'in_review>approved' then
        if not v_human then
          raise exception 'Only a signed-in Compass team member can approve a post' using errcode = 'insufficient_privilege';
        end if;
        v_problems := social_post_grounding_problems(new);
        if cardinality(v_problems) > 0 then
          raise exception 'The post cannot be approved: %', array_to_string(v_problems, ' ')
            using errcode = 'check_violation';
        end if;
        v_snapshot := social_post_snapshot(new);
        new.reviewed_by := task_actor();
        new.reviewed_at := now();
        new.approved_snapshot := v_snapshot;
        new.approved_hash := social_post_hash(v_snapshot);
        perform social_post_close_review_task(old.review_task_id, 'Approved.');

      when 'in_review>rejected' then
        if not v_human then
          raise exception 'Only a signed-in Compass team member can reject a post' using errcode = 'insufficient_privilege';
        end if;
        if nullif(btrim(coalesce(new.review_note, '')), '') is null then
          raise exception 'Say why the post is rejected' using errcode = 'check_violation';
        end if;
        new.reviewed_by := task_actor();
        new.reviewed_at := now();
        new.approved_snapshot := null; new.approved_hash := null;
        perform social_post_close_review_task(old.review_task_id, 'Rejected: ' || new.review_note);

      when 'rejected>draft' then  -- revise; the rejection note stays for the reviser
        new.submitted_at := null;
        new.reviewed_by := null; new.reviewed_at := null;
        new.review_task_id := null;

      when 'approved>draft' then  -- reopen
        if not v_human then
          raise exception 'Only a signed-in Compass team member can reopen an approved post' using errcode = 'insufficient_privilege';
        end if;
        if old.publish_status not in ('not_scheduled', 'scheduled', 'failed') then
          raise exception 'The post is %; it can no longer be reopened', old.publish_status using errcode = 'check_violation';
        end if;
        new.submitted_at := null;
        new.reviewed_by := null; new.reviewed_at := null;
        new.approved_snapshot := null; new.approved_hash := null;
        new.review_task_id := null;
        new.publish_status := 'not_scheduled';

      when 'approved>in_review' then  -- lapse: only when the support really changed
        if old.publish_status not in ('not_scheduled', 'scheduled', 'failed') then
          raise exception 'The post is %; it stays as it is', old.publish_status using errcode = 'check_violation';
        end if;
        v_problems := social_post_grounding_problems(new);
        if cardinality(v_problems) = 0 and social_post_hash(social_post_snapshot(new)) = old.approved_hash then
          raise exception 'Nothing the approval stood on has changed; reopen the post instead' using errcode = 'check_violation';
        end if;
        new.submitted_at := now();
        new.reviewed_by := null; new.reviewed_at := null;
        new.review_note := null;
        new.approved_snapshot := null; new.approved_hash := null;
        new.publish_status := 'not_scheduled';
        new.review_task_id := social_post_open_review_task(new,
          'Sent back to review: what the approval stood on changed. ' || array_to_string(v_problems, ' '));

      else
        raise exception 'A post cannot go from % to %', old.review_status, new.review_status
          using errcode = 'check_violation';
    end case;
  end if;

  -- ── Publishing transitions (never touch review fields; checked above) ──
  if v_publish_change then
    v_step := old.publish_status || '>' || new.publish_status;
    case v_step
      when 'not_scheduled>scheduled', 'failed>scheduled' then
        if new.review_status <> 'approved' then
          raise exception 'Only an approved post can be scheduled' using errcode = 'check_violation';
        end if;
      when 'scheduled>not_scheduled', 'failed>not_scheduled' then
        null;
      when 'scheduled>publishing' then
        if v_kind <> 'publisher' then
          raise exception 'Only the publisher starts publishing' using errcode = 'insufficient_privilege';
        end if;
        if new.review_status <> 'approved' then
          raise exception 'The post is not approved' using errcode = 'check_violation';
        end if;
        if social_post_hash(social_post_snapshot(new)) is distinct from new.approved_hash then
          raise exception 'The post changed since it was approved; it goes back to review' using errcode = 'check_violation';
        end if;
        v_problems := social_post_grounding_problems(new);
        if cardinality(v_problems) > 0 then
          raise exception 'The post cannot be published: %', array_to_string(v_problems, ' ')
            using errcode = 'check_violation';
        end if;
        new.publish_attempts := old.publish_attempts + 1;
        new.last_attempt_at := now();
        new.error := null;
      when 'publishing>published', 'publishing>failed' then
        if v_kind <> 'publisher' then
          raise exception 'Only the publisher records the result' using errcode = 'insufficient_privilege';
        end if;
      -- Published by hand: a person posted an approved social post natively
      -- and records where. Business Profile posts are the publisher's alone.
      when 'not_scheduled>published', 'scheduled>published', 'failed>published' then
        if not v_human then
          raise exception 'Only a signed-in Compass team member can mark a post published by hand'
            using errcode = 'insufficient_privilege';
        end if;
        if new.platform::text not in ('facebook', 'instagram', 'linkedin', 'x', 'tiktok') then
          raise exception 'A % post is published by the publisher, not by hand', new.platform
            using errcode = 'insufficient_privilege';
        end if;
        if new.review_status <> 'approved' then
          raise exception 'The post is not approved' using errcode = 'check_violation';
        end if;
        if social_post_hash(social_post_snapshot(new)) is distinct from new.approved_hash then
          raise exception 'The post changed since it was approved; it goes back to review' using errcode = 'check_violation';
        end if;
        v_problems := social_post_grounding_problems(new);
        if cardinality(v_problems) > 0 then
          raise exception 'The post cannot be marked published: %', array_to_string(v_problems, ' ')
            using errcode = 'check_violation';
        end if;
        if new.published_at is null or nullif(btrim(coalesce(new.published_url, '')), '') is null then
          raise exception 'Say where and when it was published' using errcode = 'check_violation';
        end if;
        if new.published_at > now() + interval '5 minutes' then
          raise exception 'The publication time is in the future' using errcode = 'check_violation';
        end if;
        if new.published_url !~* '^https://' then
          raise exception 'The published link must be an https:// address' using errcode = 'check_violation';
        end if;
        -- Attempts count the publisher's tries; the last error is history.
        new.publish_attempts := old.publish_attempts;
        new.last_attempt_at := old.last_attempt_at;
        new.error := old.error;
      else
        raise exception 'Publishing cannot go from % to %', old.publish_status, new.publish_status
          using errcode = 'check_violation';
    end case;
  end if;

  return new;
end $$;
revoke execute on function social_posts_before_update() from public, anon, authenticated;

-- A post that was approved, is in review or has any publishing history
-- stays on record; withdraw / reopen it first. Deleting its client is
-- refused for the same reason (offboard the client instead).
create or replace function social_posts_before_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.review_status not in ('draft', 'rejected') or old.publish_status <> 'not_scheduled'
     or old.publish_attempts > 0 or old.external_post_id is not null then
    raise exception 'A post that is % / % stays on record', old.review_status, old.publish_status
      using errcode = 'check_violation';
  end if;
  return old;
end $$;
revoke execute on function social_posts_before_delete() from public, anon, authenticated;

create or replace function social_posts_record_events() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_kind text := post_caller_kind();
  v_actor uuid := case when v_kind = 'team' then task_actor() end;
  v_event text;
  v_detail jsonb;
  v_changed text[];
  v_problems text[];
begin
  if tg_op = 'INSERT' then
    insert into post_events (post_id, client_id, actor_id, actor_kind, kind, to_value, detail)
    values (new.id, new.client_id, v_actor, v_kind, 'created', new.review_status,
            jsonb_build_object('platform', new.platform::text, 'search_intent', new.search_intent, 'author_kind', new.author_kind));
    return new;
  end if;

  if new.review_status is distinct from old.review_status then
    v_event := case old.review_status || '>' || new.review_status
      when 'draft>in_review' then 'submitted'
      when 'in_review>draft' then 'withdrawn'
      when 'in_review>approved' then 'approved'
      when 'in_review>rejected' then 'rejected'
      when 'rejected>draft' then 'revised'
      when 'approved>draft' then 'reopened'
      when 'approved>in_review' then 'grounding_lapsed'
    end;
    if v_event = 'grounding_lapsed' then
      v_problems := social_post_grounding_problems(new);
      if cardinality(v_problems) = 0 then
        v_problems := array['What the approval stood on changed since it was approved (claim text, offer terms or assets).'];
      end if;
    end if;
    v_detail := jsonb_strip_nulls(jsonb_build_object(
      'note', case when v_event in ('rejected', 'approved') then new.review_note end,
      'approved_hash', case when v_event = 'approved' then new.approved_hash end,
      'review_task_id', coalesce(new.review_task_id, old.review_task_id),
      'problems', case when v_event = 'grounding_lapsed' then to_jsonb(v_problems) end,
      'unscheduled_from', case when old.publish_status <> new.publish_status then old.publish_status end));
    insert into post_events (post_id, client_id, actor_id, actor_kind, kind, from_value, to_value, detail)
    values (new.id, new.client_id, v_actor, v_kind, v_event, old.review_status, new.review_status, v_detail);
  end if;

  if new.publish_status is distinct from old.publish_status and new.review_status is not distinct from old.review_status then
    v_event := case old.publish_status || '>' || new.publish_status
      when 'not_scheduled>scheduled' then 'scheduled'
      when 'failed>scheduled' then 'retried'
      when 'scheduled>not_scheduled' then 'unscheduled'
      when 'failed>not_scheduled' then 'unscheduled'
      when 'scheduled>publishing' then 'publishing'
      when 'publishing>published' then 'published'
      when 'publishing>failed' then 'failed'
      when 'not_scheduled>published' then 'published'
      when 'scheduled>published' then 'published'
      when 'failed>published' then 'published'
    end;
    insert into post_events (post_id, client_id, actor_id, actor_kind, kind, from_value, to_value, detail)
    values (new.id, new.client_id, v_actor, v_kind, v_event, old.publish_status, new.publish_status,
            jsonb_strip_nulls(jsonb_build_object(
              'scheduled_at', new.scheduled_at, 'attempt', case when v_event = 'publishing' then new.publish_attempts end,
              'external_post_id', new.external_post_id, 'published_url', new.published_url,
              'published_at', case when v_event = 'published' then new.published_at end,
              'manual', case when v_event = 'published' and old.publish_status <> 'publishing' then true end,
              'error', case when v_event = 'failed' then new.error end)));
  elsif new.scheduled_at is distinct from old.scheduled_at and new.publish_status = old.publish_status
        and old.publish_status = 'scheduled' then
    insert into post_events (post_id, client_id, actor_id, actor_kind, kind, from_value, to_value)
    values (new.id, new.client_id, v_actor, v_kind, 'rescheduled', old.scheduled_at::text, new.scheduled_at::text);
  end if;

  select array_agg(f) into v_changed from (values
    ('platform', old.platform::text is distinct from new.platform::text),
    ('social_account_id', old.social_account_id is distinct from new.social_account_id),
    ('post_type', old.post_type is distinct from new.post_type),
    ('search_intent', old.search_intent is distinct from new.search_intent),
    ('keyword_id', old.keyword_id is distinct from new.keyword_id),
    ('service_id', old.service_id is distinct from new.service_id),
    ('offer_id', old.offer_id is distinct from new.offer_id),
    ('copy', old.copy is distinct from new.copy),
    ('cta', (old.cta_type, old.cta_url) is distinct from (new.cta_type, new.cta_url)),
    ('crm_facts_only', old.crm_facts_only is distinct from new.crm_facts_only),
    ('scheduled_at', old.scheduled_at is distinct from new.scheduled_at and old.publish_status <> 'scheduled'
                     and new.publish_status = old.publish_status),
    ('notes', old.notes is distinct from new.notes)
  ) as c(f, changed) where changed;
  if cardinality(v_changed) > 0 then
    insert into post_events (post_id, client_id, actor_id, actor_kind, kind, detail)
    values (new.id, new.client_id, v_actor, v_kind, 'edited', jsonb_build_object('fields', to_jsonb(v_changed)));
  end if;
  return new;
end $$;
revoke execute on function social_posts_record_events() from public, anon, authenticated;

create trigger social_posts_aa_insert before insert on social_posts
  for each row execute function social_posts_before_insert();
create trigger social_posts_aa_update before update on social_posts
  for each row execute function social_posts_before_update();
create trigger social_posts_aa_delete before delete on social_posts
  for each row execute function social_posts_before_delete();
create trigger social_posts_history after insert or update on social_posts
  for each row execute function social_posts_record_events();

-- ── 8. Links: drafts only, same client, recorded ─────────────────────────────
create or replace function post_links_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_post social_posts;
  v_row record := case when tg_op = 'DELETE' then old else new end;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Links are not edited; unlink and link again' using errcode = 'check_violation';
  end if;
  select * into v_post from social_posts where id = v_row.post_id;
  if tg_op = 'DELETE' then
    -- The post itself, or the claim / asset, is being deleted: a cascade.
    if v_post.id is null then return old; end if;
    -- (Separate branches: each table has only its own column.)
    if tg_table_name = 'post_claims' then
      if not exists (select 1 from claims where id = old.claim_id) then return old; end if;
    else
      if not exists (select 1 from brand_assets where id = old.brand_asset_id) then return old; end if;
    end if;
  end if;
  if v_post.id is null then
    raise exception 'No such post' using errcode = 'foreign_key_violation';
  end if;
  if v_post.review_status <> 'draft' then
    raise exception 'The post is %; its claims and assets are frozen', v_post.review_status
      using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if new.client_id is null then new.client_id := v_post.client_id; end if;
    return new;
  end if;
  return old;
end $$;
revoke execute on function post_links_guard() from public, anon, authenticated;

create or replace function post_links_record() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_kind text := post_caller_kind();
  v_row record := case when tg_op = 'DELETE' then old else new end;
  v_ref uuid;
  v_event text;
begin
  if not exists (select 1 from social_posts where id = v_row.post_id) then
    return null;  -- the post is being deleted
  end if;
  if tg_table_name = 'post_claims' then
    v_ref := v_row.claim_id;
    v_event := case when tg_op = 'INSERT' then 'claim_linked' else 'claim_unlinked' end;
  else
    v_ref := v_row.brand_asset_id;
    v_event := case when tg_op = 'INSERT' then 'asset_linked' else 'asset_unlinked' end;
  end if;
  insert into post_events (post_id, client_id, actor_id, actor_kind, kind, to_value)
  values (v_row.post_id, v_row.client_id, case when v_kind = 'team' then task_actor() end, v_kind, v_event, v_ref::text);
  -- A claim or asset deleted under a submitted / approved post.
  if tg_op = 'DELETE' then
    perform recheck_social_posts(array[v_row.post_id]);
  end if;
  return null;
end $$;
revoke execute on function post_links_record() from public, anon, authenticated;

-- ── 9. Lapse ─────────────────────────────────────────────────────────────────
-- Re-checks posts whose support may have changed. An approved post not yet
-- publishing goes back to review; anything else in review or already
-- published / publishing gets a grounding_lapsed event only. With no ids:
-- every approved or in-review post (the daily job, for offers that end by
-- date). Returns how many posts went back to review.
create or replace function recheck_social_posts(p_post_ids uuid[] default null) returns int
language plpgsql security definer set search_path = public as $$
declare
  p social_posts;
  v_problems text[];
  v_changed boolean;
  v_count int := 0;
  v_prev text := current_setting('compass.post_system', true);
begin
  for p in
    select * from social_posts
    where review_status in ('in_review', 'approved')
      and (p_post_ids is null or id = any (p_post_ids))
    order by id
  loop
    v_problems := social_post_grounding_problems(p);
    v_changed := p.review_status = 'approved'
                 and social_post_hash(social_post_snapshot(p)) is distinct from p.approved_hash;
    continue when cardinality(v_problems) = 0 and not v_changed;
    if v_changed and cardinality(v_problems) = 0 then
      v_problems := array['What the approval stood on changed since it was approved (claim text, offer terms or assets).'];
    end if;

    if p.review_status = 'approved' and p.publish_status in ('not_scheduled', 'scheduled', 'failed') then
      perform set_config('compass.post_system', 'on', true);
      update social_posts set review_status = 'in_review' where id = p.id;
      perform set_config('compass.post_system', coalesce(v_prev, ''), true);
      v_count := v_count + 1;
    elsif p_post_ids is not null then
      -- In review (the reviewer sees the problems) or already out the door:
      -- record it once per change, never move it.
      insert into post_events (post_id, client_id, actor_kind, kind, from_value, to_value, detail)
      values (p.id, p.client_id, 'system', 'grounding_lapsed', p.review_status, p.review_status,
              jsonb_build_object('problems', to_jsonb(v_problems), 'publish_status', p.publish_status));
    end if;
  end loop;
  return v_count;
end $$;
revoke execute on function recheck_social_posts(uuid[]) from public, anon, authenticated;

create or replace function social_posts_support_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_ids uuid[];
begin
  if tg_table_name = 'claims' then
    select array_agg(post_id) into v_ids from post_claims where claim_id = new.id;
  elsif tg_table_name = 'offers' then
    select array_agg(id) into v_ids from social_posts where offer_id = new.id;
  elsif tg_table_name = 'services' then
    select array_agg(id) into v_ids from social_posts where service_id = new.id;
  elsif tg_table_name = 'brand_assets' then
    select array_agg(post_id) into v_ids from post_assets where brand_asset_id = new.id;
  end if;
  if v_ids is not null then
    perform recheck_social_posts(v_ids);
  end if;
  return null;
end $$;
revoke execute on function social_posts_support_changed() from public, anon, authenticated;

create trigger claims_zz_recheck_posts after update of claim, status, source on claims
  for each row execute function social_posts_support_changed();
create trigger offers_zz_recheck_posts after update of status, title, terms, starts_on, ends_on on offers
  for each row execute function social_posts_support_changed();
create trigger services_zz_recheck_posts after update of status on services
  for each row execute function social_posts_support_changed();
create trigger brand_assets_zz_recheck_posts after update of storage_path, url on brand_assets
  for each row execute function social_posts_support_changed();

create trigger post_claims_guard before insert or update or delete on post_claims
  for each row execute function post_links_guard();
create trigger post_claims_history after insert or delete on post_claims
  for each row execute function post_links_record();
create trigger post_assets_guard before insert or update or delete on post_assets
  for each row execute function post_links_guard();
create trigger post_assets_history after insert or delete on post_assets
  for each row execute function post_links_record();

-- Offers end by date with nobody touching them.
select cron.schedule('social-posts-recheck', '15 11 * * *', $$select recheck_social_posts()$$);

-- ── 10. Access ───────────────────────────────────────────────────────────────
-- social_posts keeps its "team full access" policy (0036).
revoke all on social_posts from anon;
revoke truncate, references, trigger on social_posts from authenticated;

alter table post_claims enable row level security;
create policy "team reads post claims" on post_claims
  for select to authenticated using ((select is_team()));
create policy "team links post claims" on post_claims
  for insert to authenticated with check ((select is_team()));
create policy "team unlinks post claims" on post_claims
  for delete to authenticated using ((select is_team()));
revoke all on post_claims from anon;
revoke update, truncate, references, trigger on post_claims from authenticated;

alter table post_assets enable row level security;
create policy "team reads post assets" on post_assets
  for select to authenticated using ((select is_team()));
create policy "team links post assets" on post_assets
  for insert to authenticated with check ((select is_team()));
create policy "team unlinks post assets" on post_assets
  for delete to authenticated using ((select is_team()));
revoke all on post_assets from anon;
revoke update, truncate, references, trigger on post_assets from authenticated;

alter table post_events enable row level security;
create policy "team reads post history" on post_events
  for select to authenticated using ((select is_team()));
revoke all on post_events from anon;
revoke insert, update, delete, truncate, references, trigger on post_events from authenticated;

-- ── Verify ───────────────────────────────────────────────────────────────────
do $$
declare n int;
begin
  if exists (select 1 from pg_type where typname = 'social_post_status') then
    raise exception '0045: social_post_status still exists';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'social_posts' and column_name = 'status') then
    raise exception '0045: social_posts.status still exists';
  end if;

  select count(*) into n from pg_policies
  where schemaname = 'public' and tablename in ('social_posts', 'post_claims', 'post_assets', 'post_events')
    and ((qual is not null and qual not like '%is_team()%')
      or (with_check is not null and with_check not like '%is_team()%'));
  if n > 0 then raise exception '0045: a post policy does not read is_team()'; end if;

  if (select count(*) from pg_class
      where oid in ('public.social_posts'::regclass, 'public.post_claims'::regclass,
                    'public.post_assets'::regclass, 'public.post_events'::regclass)
        and relrowsecurity) <> 4 then
    raise exception '0045: RLS is not on for every post table';
  end if;

  if has_table_privilege('anon', 'public.social_posts', 'select,insert,update,delete')
     or has_table_privilege('anon', 'public.post_claims', 'select,insert,update,delete')
     or has_table_privilege('anon', 'public.post_assets', 'select,insert,update,delete')
     or has_table_privilege('anon', 'public.post_events', 'select,insert,update,delete')
     or has_table_privilege('authenticated', 'public.post_events', 'insert,update,delete')
     or has_table_privilege('authenticated', 'public.post_claims', 'update')
     or has_table_privilege('authenticated', 'public.post_assets', 'update') then
    raise exception '0045: grants on the post tables are wider than intended';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname in ('post_caller_is_human', 'post_caller_kind', 'social_post_grounding_problems',
                        'social_post_snapshot', 'social_post_hash', 'social_post_open_review_task',
                        'social_post_close_review_task', 'social_posts_before_insert', 'social_posts_before_update',
                        'social_posts_before_delete', 'social_posts_record_events', 'post_links_guard',
                        'post_links_record', 'recheck_social_posts', 'social_posts_support_changed')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
  ) then
    raise exception '0045: an internal post function is callable over the API';
  end if;
  if has_function_privilege('anon', 'public.social_post_readiness(uuid)', 'execute') then
    raise exception '0045: anon can call social_post_readiness';
  end if;

  if exists (select 1 from pg_views where schemaname = 'public' and viewname like 'portal\_%'
             and (definition ilike '%social_posts%' or definition ilike '%post_claims%'
                  or definition ilike '%post_events%' or definition ilike '%post_assets%')) then
    raise exception '0045: a portal view reads the post tables';
  end if;
end $$;
