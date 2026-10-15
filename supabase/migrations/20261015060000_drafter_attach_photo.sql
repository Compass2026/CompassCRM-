-- AI Drafter: attach an approved brand photo to an existing drafted post.
--
-- Two Lucas Business Profile posts were drafted without a photo. Their assets
-- may change only through the post-drafter function or a person
-- (post_links_drafter_guard, 0047), and the drafter could only CREATE posts,
-- so the only way to add a photo was a teammate picking it from a list. This
-- adds the drafter's second write: drafter_attach_photo(), service role only,
-- which opens the same drafter session drafter_write opens and moves the post
-- through the review transitions anyone may make:
--
--   in_review → draft (withdraw) → link the photo → draft → in_review (resubmit)
--
-- all in one transaction. Grounding runs on the resubmit and a refusal rolls
-- the whole edit back. It never approves, schedules or publishes, never
-- touches copy, claims, service, keyword or destination, and leaves the
-- original drafter run (the post's provenance) as it was. The post's history
-- records the drafter as the actor (post_events, actor_kind 'drafter'); the
-- edit itself is recorded in drafter_post_edits with the operation id, the
-- before / after media and who asked (the worker or a teammate through the
-- function), never as a person's creative approval.
--
-- Eligibility of the photo is this client's own brand asset of kind photo,
-- approved for creative use, stored, with a recorded content hash equal to
-- the hash the function measured from the stored bytes. depicts_own_work is
-- recorded, not required: illustration that a teammate approved for creative
-- use stays usable (no policy change here).
--
-- Grounding gains one rule: a linked brand image that a teammate later
-- excludes from creative use is a problem, so the existing recheck (any
-- brand_assets change rechecks its posts) sends an approved post back to
-- review and the publisher refuses to send it. Unreviewed images keep their
-- current behaviour (17 production links today, all Facebook graphics).

-- ── The edit record ─────────────────────────────────────────────────────────
create table public.drafter_post_edits (
  id uuid primary key default gen_random_uuid(),
  operation_id text not null unique check (operation_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  client_id uuid not null references public.clients(id) on delete cascade,
  post_id uuid not null,
  drafter_run_id uuid not null,
  kind text not null check (kind = 'attach_photo'),
  outcome text not null check (outcome in ('attached', 'unchanged')),
  brand_asset_id uuid not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  depicts_own_work boolean,
  expected_updated_at timestamptz,
  before_review_status text not null,
  after_review_status text not null,
  before_review_task_id uuid,
  after_review_task_id uuid,
  before_assets jsonb not null,
  after_assets jsonb not null,
  requested_via text not null check (requested_via in ('worker', 'team')),
  requested_by uuid references public.team_members(id) on delete set null,
  runtime text not null check (length(btrim(runtime)) between 1 and 80),
  result jsonb not null,
  created_at timestamptz not null default now(),
  check (requested_via = 'team' or requested_by is null)
);
create index drafter_post_edits_post on public.drafter_post_edits (post_id, created_at);

alter table public.drafter_post_edits enable row level security;
create policy "team reads drafter post edits" on public.drafter_post_edits
  for select to authenticated using ((select is_team()));
revoke all on public.drafter_post_edits from public, anon, authenticated, service_role;
grant select on public.drafter_post_edits to authenticated;
grant select, insert on public.drafter_post_edits to service_role;

-- Written once, inside drafter_attach_photo; never edited; removed only with
-- the client. (The requester FK's SET NULL is the one update allowed.)
create function public.drafter_post_edits_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if drafter_caller_is_superuser() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if not drafter_session_active() then
      raise exception 'Drafter post edits are recorded only inside drafter_attach_photo' using errcode = 'insufficient_privilege';
    end if;
    new.created_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id) then return old; end if;
    raise exception 'Drafter post edits are an audit record and are not deleted' using errcode = 'insufficient_privilege';
  end if;
  if old.requested_by is not null and new.requested_by is null
     and not exists (select 1 from team_members where id = old.requested_by)
     and (to_jsonb(new) - 'requested_by') = (to_jsonb(old) - 'requested_by') then
    return new;
  end if;
  raise exception 'Drafter post edits are immutable' using errcode = 'insufficient_privilege';
end $$;
revoke all on function public.drafter_post_edits_guard() from public, anon, authenticated, service_role;
create trigger drafter_post_edits_guard before insert or update or delete on public.drafter_post_edits
  for each row execute function public.drafter_post_edits_guard();

-- ── The write ───────────────────────────────────────────────────────────────
-- p: { post_id, brand_asset_id, operation_id, expected_updated_at (the post's
--      updated_at as the caller read it; JSON null when never updated),
--      verified_hash (sha256 of the stored bytes, measured by the function),
--      requested_via, requested_by, runtime }
-- The client is the post's own; the caller never names it.
-- Errors: 42501 caller; DR409 state / staleness / existing media / reused
-- operation id; DR422 an ineligible post or photo; P0002 no such post or
-- photo. Each message starts with a stable code.
create function public.drafter_attach_photo(p jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_post uuid;
  v_asset uuid;
  v_op text := p->>'operation_id';
  v_hash text := p->>'verified_hash';
  v_via text := coalesce(p->>'requested_via', '');
  v_by uuid;
  v_runtime text := btrim(coalesce(p->>'runtime', ''));
  v_expected timestamptz;
  e drafter_post_edits;
  sp social_posts;
  sp2 social_posts;
  b brand_assets;
  v_before jsonb;
  v_after jsonb;
  v_claims_before uuid[];
  v_claims_after uuid[];
  v_links int;
  v_outcome text;
  v_result jsonb;
  v_edit uuid;
begin
  if not drafter_caller_is_service() then
    raise exception 'drafter_attach_photo runs only in the post-drafter function' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.drafter_write', 'on', true);

  -- ── The request ──
  if coalesce(p->>'post_id', '') !~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
     or coalesce(p->>'brand_asset_id', '') !~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then
    raise exception 'bad_request: post_id and brand_asset_id are uuids' using errcode = 'check_violation';
  end if;
  v_post := (p->>'post_id')::uuid;
  v_asset := (p->>'brand_asset_id')::uuid;
  if coalesce(v_op, '') !~ '^[A-Za-z0-9_-]{8,128}$' then
    raise exception 'bad_request: operation_id is 8-128 letters, digits, _ or -' using errcode = 'check_violation';
  end if;
  if coalesce(v_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'bad_request: verified_hash is the sha256 of the stored file' using errcode = 'check_violation';
  end if;
  if not (p ? 'expected_updated_at') then
    raise exception 'bad_request: expected_updated_at is required (null when the post was never updated)' using errcode = 'check_violation';
  end if;
  v_expected := nullif(p->>'expected_updated_at', '')::timestamptz;
  if v_runtime = '' or length(v_runtime) > 80 then
    raise exception 'bad_request: runtime is a 1-80 character label' using errcode = 'check_violation';
  end if;
  if v_via = 'team' then
    v_by := nullif(p->>'requested_by', '')::uuid;
    if v_by is null or not exists (select 1 from team_members where id = v_by) then
      raise exception 'bad_request: a team request names its team member' using errcode = 'check_violation';
    end if;
  elsif v_via = 'worker' then
    if nullif(p->>'requested_by', '') is not null then
      raise exception 'bad_request: a worker request names no team member' using errcode = 'check_violation';
    end if;
  else
    raise exception 'bad_request: requested_via is worker or team' using errcode = 'check_violation';
  end if;

  -- ── The post, locked (a concurrent retry waits here, then replays) ──
  select * into sp from social_posts where id = v_post for update;

  -- ── A retry of the same operation returns what it did ──
  select * into e from drafter_post_edits where operation_id = v_op;
  if e.id is not null then
    if e.post_id = v_post and e.brand_asset_id = v_asset then
      return e.result || jsonb_build_object('replayed', true);
    end if;
    raise exception 'operation_reused: operation % already attached another photo or post', v_op using errcode = 'DR409';
  end if;

  if sp.id is null then
    raise exception 'post_not_found: no such post' using errcode = 'P0002';
  end if;
  if sp.drafter_run_id is null then
    raise exception 'post_not_drafted: only a post the drafter wrote is edited by the drafter' using errcode = 'DR422';
  end if;
  if sp.platform::text not in ('google_business', 'facebook') or sp.post_type <> 'standard' then
    raise exception 'post_unsupported: only a standard Business Profile or Facebook post takes a photo here' using errcode = 'DR422';
  end if;
  if sp.review_status not in ('draft', 'in_review') then
    raise exception 'post_state: the post is %; a person reopens it before its media changes', sp.review_status using errcode = 'DR409';
  end if;
  if sp.publish_status <> 'not_scheduled' or sp.scheduled_at is not null or sp.published_at is not null
     or sp.external_post_id is not null then
    raise exception 'post_state: the post is % with a publishing record; its media stays as it is', sp.publish_status using errcode = 'DR409';
  end if;
  if sp.updated_at is distinct from v_expected then
    raise exception 'stale_post: the post changed at % after it was read (expected %)', sp.updated_at, v_expected using errcode = 'DR409';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('brand_asset_id', brand_asset_id, 'creative_asset_id', creative_asset_id,
                                               'content_hash', content_hash, 'sort_order', sort_order) order by sort_order, id), '[]'),
         count(*) filter (where creative_asset_id is not null)
    into v_before, v_links
    from post_assets where post_id = v_post;
  if v_links > 0 then
    raise exception 'media_present: the post carries rendered creative; it is not replaced here' using errcode = 'DR409';
  end if;

  -- ── The photo, locked against a concurrent review change ──
  select * into b from brand_assets where id = v_asset for share;
  if b.id is null or b.client_id <> sp.client_id then
    raise exception 'asset_not_found: no such photo for this post''s client' using errcode = 'P0002';
  end if;
  if b.kind::text <> 'photo' then
    raise exception 'asset_not_photo: the asset is a %, not a photo', b.kind using errcode = 'DR422';
  end if;
  if b.creative_use <> 'approved' then
    raise exception 'asset_not_approved: the photo is % for creative use; a teammate approves it first', b.creative_use using errcode = 'DR422';
  end if;
  if nullif(btrim(coalesce(b.storage_path, '')), '') is null then
    raise exception 'asset_unstored: the photo has no stored file' using errcode = 'DR422';
  end if;
  if coalesce(b.content_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'asset_unhashed: the photo has no recorded content hash' using errcode = 'DR422';
  end if;
  if b.content_hash <> v_hash then
    raise exception 'asset_hash_mismatch: the stored file does not match the photo''s recorded hash' using errcode = 'DR422';
  end if;
  if exists (select 1 from client_brand_workspaces where client_id = sp.client_id)
     and not exists (select 1 from client_brand_workspaces w where w.client_id = sp.client_id
                      and sp.service_id = any (w.service_ids) and v_asset = any (w.asset_ids)) then
    raise exception 'asset_not_in_brand: the photo is not assigned to this post''s brand' using errcode = 'DR422';
  end if;

  -- ── Already there: nothing to do (and nothing else may be) ──
  if jsonb_array_length(v_before) > 0 then
    if jsonb_array_length(v_before) = 1 and (v_before->0->>'brand_asset_id')::uuid = v_asset then
      v_outcome := 'unchanged';
    else
      raise exception 'media_present: the post already carries another image; a person removes it first' using errcode = 'DR409';
    end if;
  else
    v_outcome := 'attached';
  end if;

  select coalesce(array_agg(claim_id order by claim_id), '{}') into v_claims_before from post_claims where post_id = v_post;

  if v_outcome = 'attached' then
    if sp.review_status = 'in_review' then
      update social_posts set review_status = 'draft' where id = v_post;
    end if;
    insert into post_assets (post_id, client_id, brand_asset_id, sort_order) values (v_post, sp.client_id, v_asset, 1);
    if sp.review_status = 'in_review' then
      -- Grounding and the new review task come from the ordinary submit.
      update social_posts set review_status = 'in_review' where id = v_post;
    end if;
  end if;

  select * into sp2 from social_posts where id = v_post;
  select coalesce(array_agg(claim_id order by claim_id), '{}') into v_claims_after from post_claims where post_id = v_post;
  if (sp2.client_id, sp2.platform, sp2.social_account_id, sp2.post_type, sp2.search_intent, sp2.service_id, sp2.keyword_id,
      sp2.offer_id, sp2.copy, sp2.cta_type, sp2.cta_url, sp2.crm_facts_only, sp2.drafter_run_id, sp2.review_status,
      sp2.publish_status, sp2.publish_attempts, sp2.scheduled_at, sp2.published_at, sp2.external_post_id,
      sp2.approved_hash, sp2.creative_policy, sp2.creative_status)
     is distinct from
     (sp.client_id, sp.platform, sp.social_account_id, sp.post_type, sp.search_intent, sp.service_id, sp.keyword_id,
      sp.offer_id, sp.copy, sp.cta_type, sp.cta_url, sp.crm_facts_only, sp.drafter_run_id, sp.review_status,
      sp.publish_status, sp.publish_attempts, sp.scheduled_at, sp.published_at, sp.external_post_id,
      sp.approved_hash, sp.creative_policy, sp.creative_status)
     or v_claims_after is distinct from v_claims_before then
    raise exception 'internal: the post changed beyond its media; nothing was written' using errcode = 'DR409';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('brand_asset_id', brand_asset_id, 'creative_asset_id', creative_asset_id,
                                               'content_hash', content_hash, 'sort_order', sort_order) order by sort_order, id), '[]')
    into v_after from post_assets where post_id = v_post;
  if jsonb_array_length(v_after) <> 1 or (v_after->0->>'brand_asset_id')::uuid <> v_asset
     or v_after->0->>'content_hash' is distinct from b.content_hash then
    raise exception 'internal: the photo link is not the one expected; nothing was written' using errcode = 'DR409';
  end if;

  v_edit := gen_random_uuid();
  v_result := jsonb_build_object(
    'status', v_outcome, 'edit_id', v_edit, 'operation_id', v_op, 'post_id', v_post, 'client_id', sp.client_id,
    'brand_asset_id', v_asset, 'content_hash', b.content_hash, 'depicts_own_work', b.depicts_own_work,
    'review_status', sp2.review_status, 'publish_status', sp2.publish_status, 'publish_attempts', sp2.publish_attempts,
    'review_task_id', sp2.review_task_id, 'previous_review_task_id', sp.review_task_id,
    'social_account_id', sp2.social_account_id, 'updated_at', sp2.updated_at);
  insert into drafter_post_edits (id, operation_id, client_id, post_id, drafter_run_id, kind, outcome, brand_asset_id,
    content_hash, depicts_own_work, expected_updated_at, before_review_status, after_review_status,
    before_review_task_id, after_review_task_id, before_assets, after_assets, requested_via, requested_by, runtime, result)
  values (v_edit, v_op, sp.client_id, v_post, sp.drafter_run_id, 'attach_photo', v_outcome, v_asset,
    b.content_hash, b.depicts_own_work, v_expected, sp.review_status, sp2.review_status,
    sp.review_task_id, sp2.review_task_id, v_before, v_after, v_via, v_by, v_runtime, v_result);
  return v_result;
end $$;
revoke all on function public.drafter_attach_photo(jsonb) from public, anon, authenticated;
grant execute on function public.drafter_attach_photo(jsonb) to service_role;

-- ── Grounding: an image withdrawn from creative use after it was linked ────
do $migration$
declare
  definition text := pg_get_functiondef('public.social_post_grounding_problems(public.social_posts)'::regprocedure);
  anchor text := '  v_problems := v_problems || brand_content_problems(';
  rule text := $rule$
  -- drafter_attach_photo_v1: a linked brand image a teammate has since
  -- excluded from creative use (unreviewed images keep their behaviour).
  if exists (select 1 from post_assets pa join brand_assets ba on ba.id = pa.brand_asset_id
              where pa.post_id = p.id and ba.creative_use = 'excluded') then
    v_problems := v_problems || 'A linked image is excluded from creative use; remove it or pick another.'::text;
  end if;

$rule$;
begin
  if strpos(definition, 'drafter_attach_photo_v1') > 0 then return; end if;
  if (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) then
    raise exception 'Unexpected social_post_grounding_problems definition; review before applying the excluded-image rule';
  end if;
  execute replace(definition, anchor, rule || anchor);
end;
$migration$;

-- A brand image's posts were rechecked only when its file moved (0045:
-- storage_path, url); a creative-use review rechecked only rendered creative
-- built from it (0054). Recheck the posts that link it directly when its
-- creative use changes too, so the rule above reaches an approved post the
-- moment a teammate excludes its photo. Recheck acts only on problems or a
-- changed approval, so approving an image moves nothing.
drop trigger brand_assets_zz_recheck_posts on public.brand_assets;
create trigger brand_assets_zz_recheck_posts after update of storage_path, url, creative_use on public.brand_assets
  for each row execute function public.social_posts_support_changed();
