-- Review to delivery (Nov 16 2026): the one review queue, Approve & schedule,
-- an approval that binds its publish time and destination, a rejection loop
-- that cannot cycle unchanged content back, kept history, and the publisher
-- refusing held clients. Builds on 0045 (review gate), 0054 (creative) and
-- 20261019202359 (delegated approval); nothing there is replaced except the
-- creative guard's rejection rule (an attached photo may now be rejected too).
--
-- What changes for people:
--   * "Approve & schedule" approves and schedules in one transaction. The
--     approval then names its time: moving or unscheduling that post needs a
--     reopen (a fresh review). Plain "Approve" still never schedules.
--   * Scheduling a time that has passed is refused; so is scheduling, or the
--     publisher starting, a post of a paused or offboarded client, or a post
--     whose Page / location binding changed after it was approved.
--   * A rejection records what was rejected (copy, image or both); the same
--     copy or image cannot be resubmitted unchanged.
--   * Copy changes, rejections, resubmissions and discards are kept in
--     social_post_history, which survives a discarded (deleted) draft.
--
-- Existing approvals are preserved: approved posts get their current
-- destination recorded as the approved one, and no time binding (they were
-- approved without one).

-- ── 1. Columns ──────────────────────────────────────────────────────────────
alter table social_posts
  add column approved_publish_at timestamptz,
  add column approved_destination text,
  add column no_image_reason text,
  add column rejected_copy_hash text,
  add column rejected_media_hash text;

comment on column social_posts.approved_publish_at is
  'Set when the approval and the schedule happened together (Approve & schedule, or the owner''s delegated approve-and-publish / publish): the time the owner authorized. Moving or unscheduling that post needs a reopen. Null for an approve-only decision.';
comment on column social_posts.approved_destination is
  'The destination key (content_social_destination) the post was approved for. Scheduling and publishing refuse when the account''s binding no longer matches.';
comment on column social_posts.no_image_reason is
  'Why this post deliberately goes out without an image (e.g. no verified photo for this location). The review queue treats a post with neither an image nor a reason as needing preparation.';
comment on column social_posts.rejected_copy_hash is
  'md5 of the copy a reviewer rejected (copy or both); resubmitting the same copy is refused. Cleared by a successful resubmission.';
comment on column social_posts.rejected_media_hash is
  'Fingerprint of the media a reviewer rejected (image or both); resubmitting the same media is refused. Cleared by a successful resubmission.';

alter table social_posts add constraint social_posts_no_image_reason_len
  check (no_image_reason is null or char_length(btrim(no_image_reason)) between 3 and 500);

-- Existing approvals keep standing: their current destination is the one they
-- were approved for (the binding cannot have changed unseen before today,
-- because nothing recorded it). Runs before the guard below exists.
update social_posts p
   set approved_destination = content_social_destination(p)->>'key'
 where p.review_status = 'approved';

-- ── 2. History that survives a discard ─────────────────────────────────────
create table social_post_history (
  id bigint generated always as identity primary key,
  post_id uuid not null,              -- no FK: a discarded post's history stays
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in ('copy_changed', 'rejected', 'resubmitted', 'discarded')),
  actor_id uuid references team_members(id) on delete set null,
  actor_kind text not null,
  copy text,
  media_fingerprint text,
  category text,
  note text,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index social_post_history_post_idx on social_post_history (post_id, id);
create index social_post_history_client_idx on social_post_history (client_id, at desc);
comment on table social_post_history is
  'Append-only revision history of social posts: every copy change (before and after), every rejection with its feedback and the rejected copy and media, every resubmission after a rejection, and a full record of a discarded draft. Written only by triggers; survives the post''s deletion.';
alter table social_post_history enable row level security;
create policy "team reads post history" on social_post_history for select to authenticated
  using ((select is_team()));
revoke all on social_post_history from anon, authenticated;
grant select on social_post_history to authenticated;

-- ── 3. Helpers ──────────────────────────────────────────────────────────────
-- The post's media as one fingerprint: each brand or creative asset with the
-- hash the post pins, in order. '' for no media.
create function social_post_media_fingerprint(p_post uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(md5(string_agg(
           coalesce(pa.brand_asset_id::text, '') || '/' || coalesce(pa.creative_asset_id::text, '') || '@' || coalesce(pa.content_hash, ''),
           ',' order by pa.sort_order, coalesce(pa.brand_asset_id, pa.creative_asset_id))), '')
  from post_assets pa where pa.post_id = p_post
$$;
revoke all on function social_post_media_fingerprint(uuid) from public, anon, authenticated;

create function social_post_client_hold(p_client uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when c.status::text in ('paused', 'offboarded') then format('%s is %s.', c.name, c.status) end
  from clients c where c.id = p_client
$$;
revoke all on function social_post_client_hold(uuid) from public, anon, authenticated;

-- ── 4. The delivery guard (runs after 0045's gate, 0047's drafter guard and
--       0054's creative guard: triggers fire in name order) ─────────────────
create function social_posts_delivery_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text := post_caller_kind();
  v_owner_decision boolean := coalesce(current_setting('compass.delegation_write', true), '') = 'on';
  v_hold text;
  v_dest text;
begin
  -- Only this trigger writes these.
  new.approved_publish_at := old.approved_publish_at;
  new.approved_destination := old.approved_destination;
  new.rejected_copy_hash := old.rejected_copy_hash;
  new.rejected_media_hash := old.rejected_media_hash;

  -- ── Review ──
  if old.review_status = 'in_review' and new.review_status = 'approved' then
    new.approved_destination := content_social_destination(new)->>'key';
  end if;
  if new.review_status <> 'approved' then
    new.approved_publish_at := null;
    new.approved_destination := null;
  end if;

  if old.review_status = 'in_review' and new.review_status = 'rejected' then
    new.rejected_copy_hash := case when new.rejection_category in ('copy', 'both') then md5(coalesce(new.copy, '')) end;
    new.rejected_media_hash := case when new.rejection_category in ('creative', 'both') then social_post_media_fingerprint(new.id) end;
  end if;

  if old.review_status = 'draft' and new.review_status = 'in_review' then
    if old.rejected_copy_hash is not null and md5(coalesce(new.copy, '')) = old.rejected_copy_hash then
      raise exception 'The copy is unchanged since it was rejected. Revise it before resubmitting (feedback: %).',
        coalesce(nullif(btrim(old.review_note), ''), 'see the post history') using errcode = 'check_violation';
    end if;
    if old.rejected_media_hash is not null and social_post_media_fingerprint(new.id) = old.rejected_media_hash then
      raise exception 'The image is unchanged since it was rejected. Replace or remove it before resubmitting (feedback: %).',
        coalesce(nullif(btrim(old.review_note), ''), 'see the post history') using errcode = 'check_violation';
    end if;
    new.rejected_copy_hash := null;
    new.rejected_media_hash := null;
  end if;

  -- ── Scheduling ──
  if new.publish_status = 'scheduled' and old.publish_status in ('not_scheduled', 'failed') and v_kind <> 'publisher' then
    if new.scheduled_at is null or new.scheduled_at < now() - interval '5 minutes' then
      raise exception 'Pick a publish time that has not passed' using errcode = 'check_violation';
    end if;
    v_hold := social_post_client_hold(new.client_id);
    if v_hold is not null then
      raise exception 'Nothing is scheduled for a held client: %', v_hold using errcode = 'check_violation';
    end if;
    v_dest := content_social_destination(new)->>'key';
    if new.approved_destination is not null and v_dest is distinct from new.approved_destination then
      raise exception 'The post''s Page or location changed after it was approved (% → %). Reopen it for a fresh review.',
        new.approved_destination, coalesce(v_dest, 'none') using errcode = 'check_violation';
    end if;
    if old.publish_status = 'failed' and old.approved_publish_at is not null and not v_owner_decision then
      raise exception 'This post was approved for %; reopen it to choose a new time.',
        to_char(old.approved_publish_at at time zone 'America/Chicago', 'Mon DD, YYYY HH12:MI AM "Central"')
        using errcode = 'check_violation';
    end if;
    -- Approved and scheduled in the same transaction, or scheduled on the
    -- owner's explicit delegated decision: the time is part of the approval.
    if new.reviewed_at = now() or v_owner_decision then
      new.approved_publish_at := new.scheduled_at;
    end if;
  elsif old.publish_status = 'scheduled' and new.review_status = 'approved' and old.approved_publish_at is not null
        and v_kind <> 'publisher'
        and (new.publish_status = 'not_scheduled' or (new.publish_status = 'scheduled' and new.scheduled_at is distinct from old.scheduled_at)) then
    raise exception 'This post was approved for %; reopen it to change or cancel that time.',
      to_char(old.approved_publish_at at time zone 'America/Chicago', 'Mon DD, YYYY HH12:MI AM "Central"')
      using errcode = 'check_violation';
  end if;

  -- ── Publishing ──
  if old.publish_status = 'scheduled' and new.publish_status = 'publishing' then
    v_hold := social_post_client_hold(new.client_id);
    if v_hold is not null then
      raise exception 'Not published: %', v_hold using errcode = 'check_violation';
    end if;
    v_dest := content_social_destination(new)->>'key';
    if new.approved_destination is not null and v_dest is distinct from new.approved_destination then
      raise exception 'Not published: the post''s Page or location changed after it was approved' using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;
revoke all on function social_posts_delivery_guard() from public, anon, authenticated;
create trigger social_posts_ad_delivery before update on social_posts
  for each row execute function social_posts_delivery_guard();

-- History rows (after the row is written).
create function social_posts_delivery_history() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text := post_caller_kind();
  v_actor uuid := case when v_kind = 'team' then task_actor() end;
begin
  if new.copy is distinct from old.copy then
    insert into social_post_history (post_id, client_id, kind, actor_id, actor_kind, copy, detail)
    values (new.id, new.client_id, 'copy_changed', v_actor, v_kind, new.copy, jsonb_build_object('previous_copy', old.copy));
  end if;
  if old.review_status = 'in_review' and new.review_status = 'rejected' then
    insert into social_post_history (post_id, client_id, kind, actor_id, actor_kind, copy, media_fingerprint, category, note)
    values (new.id, new.client_id, 'rejected', v_actor, v_kind, new.copy, social_post_media_fingerprint(new.id),
            new.rejection_category, new.review_note);
  end if;
  if old.review_status = 'draft' and new.review_status = 'in_review'
     and (old.rejected_copy_hash is not null or old.rejected_media_hash is not null
          or exists (select 1 from social_post_history h where h.post_id = new.id and h.kind = 'rejected')) then
    insert into social_post_history (post_id, client_id, kind, actor_id, actor_kind, copy, media_fingerprint)
    values (new.id, new.client_id, 'resubmitted', v_actor, v_kind, new.copy, social_post_media_fingerprint(new.id));
  end if;
  return null;
end $$;
revoke all on function social_posts_delivery_history() from public, anon, authenticated;
create trigger social_posts_delivery_history after update on social_posts
  for each row execute function social_posts_delivery_history();

-- Discard (delete of a draft or rejected post): keep the full record.
-- Runs after 0045's social_posts_aa_delete, which refuses anything else.
create function social_posts_discard_archive() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text := post_caller_kind();
begin
  insert into social_post_history (post_id, client_id, kind, actor_id, actor_kind, copy, media_fingerprint, note, detail)
  values (old.id, old.client_id, 'discarded', case when v_kind = 'team' then task_actor() end, v_kind, old.copy,
          social_post_media_fingerprint(old.id), old.review_note,
          jsonb_build_object(
            'post', to_jsonb(old),
            'claims', coalesce((select jsonb_agg(claim_id) from post_claims where post_id = old.id), '[]'::jsonb),
            'media', coalesce((select jsonb_agg(jsonb_build_object('brand_asset_id', brand_asset_id, 'creative_asset_id', creative_asset_id,
                                                                   'content_hash', content_hash, 'sort_order', sort_order))
                               from post_assets where post_id = old.id), '[]'::jsonb),
            'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from post_events e where e.post_id = old.id), '[]'::jsonb)));
  return old;
end $$;
revoke all on function social_posts_discard_archive() from public, anon, authenticated;
create trigger social_posts_ab_discard before delete on social_posts
  for each row execute function social_posts_discard_archive();

-- ── 5. Rejecting an attached photo (not only a Creative Engine graphic) ─────
-- 0054's guard, with one change: "creative" (the image) or "both" may be
-- chosen whenever the post has any media; with no media only the copy can be
-- rejected. Everything else is 0054's text.
create or replace function social_posts_creative_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_human boolean := post_caller_is_human();
  v_creative boolean := creative_session_active();
  v_super boolean := drafter_caller_is_superuser();
  v_system boolean := coalesce(current_setting('compass.post_system', true), '') = 'on';
  v_has boolean;
  v_media boolean;
begin
  if tg_op = 'INSERT' then
    new.creative_policy := creative_policy_for(new.client_id, new.platform::text);
    new.creative_status := case when new.creative_policy = 'required' then 'needed' else 'none' end;
    new.creative_version := 0;
    new.rejection_category := null;
    return new;
  end if;

  if new.creative_policy is distinct from old.creative_policy then
    if not (v_human or v_super) then
      raise exception 'Only a signed-in Compass teammate changes a post''s creative policy' using errcode = 'insufficient_privilege';
    end if;
    if new.review_status <> 'draft' then
      raise exception 'The creative policy changes only while the post is a draft' using errcode = 'check_violation';
    end if;
  end if;

  if new.creative_version is distinct from old.creative_version
     and not (v_super or (v_creative and new.creative_version = old.creative_version + 1)) then
    raise exception 'Only the Creative Engine function advances the creative version' using errcode = 'insufficient_privilege';
  end if;

  if new.creative_status is distinct from old.creative_status and not v_super then
    if new.creative_status in ('rendering', 'ready', 'failed') and not v_creative then
      raise exception 'Only the Creative Engine function records rendering, ready or failed' using errcode = 'insufficient_privilege';
    end if;
    if new.creative_status = 'requested' and not (v_human or v_creative) then
      raise exception 'Only a signed-in Compass teammate requests new creative' using errcode = 'insufficient_privilege';
    end if;
    if new.creative_status in ('none', 'needed') and not (v_human or v_creative or v_system) then
      raise exception 'The worker does not move a post''s creative status' using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.copy is distinct from old.copy
     and exists (select 1 from post_assets where post_id = new.id and creative_asset_id is not null) then
    new.creative_status := case when new.creative_policy = 'none' then 'none' else 'needed' end;
  elsif new.creative_policy is distinct from old.creative_policy then
    if new.creative_policy = 'required' and new.creative_status = 'none' then new.creative_status := 'needed'; end if;
    if new.creative_policy = 'none' and new.creative_status in ('needed', 'failed') then new.creative_status := 'none'; end if;
  end if;

  if old.review_status = 'in_review' and new.review_status = 'rejected' then
    v_has := exists (select 1 from post_assets where post_id = new.id and creative_asset_id is not null);
    v_media := exists (select 1 from post_assets where post_id = new.id);
    if v_has and new.rejection_category is null then
      raise exception 'Say whether the copy, the creative or both are rejected' using errcode = 'check_violation';
    end if;
    if not v_media then
      if coalesce(new.rejection_category, 'copy') <> 'copy' then
        raise exception 'The post has no image; only its copy can be rejected' using errcode = 'check_violation';
      end if;
      new.rejection_category := 'copy';
    elsif new.rejection_category is null then
      new.rejection_category := 'copy';
    end if;
  else
    new.rejection_category := old.rejection_category;
  end if;
  return new;
end $$;
revoke all on function social_posts_creative_guard() from public, anon, authenticated;

-- ── 6. Approve & schedule (one decision, one transaction) ──────────────────
-- The reviewer approves the submission they looked at (submitted_at pins it,
-- as approvePostAction does) for one publish time. The approval and the
-- schedule commit together or not at all; the guard above binds the time.
create function social_post_approve_and_schedule(
  p_post uuid, p_submitted_at timestamptz, p_publish_at timestamptz, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p social_posts;
  v_problems text[];
begin
  if not is_team() or not post_caller_is_human() then
    raise exception 'Only a signed-in Compass team member approves and schedules a post' using errcode = 'insufficient_privilege';
  end if;
  select * into p from social_posts where id = p_post for update;
  if p.id is null then raise exception 'Unknown post' using errcode = 'no_data_found'; end if;
  if p.review_status <> 'in_review' or p.submitted_at is distinct from p_submitted_at then
    raise exception 'The post changed since this page loaded (it is %). Reload and look again.', p.review_status
      using errcode = 'check_violation';
  end if;
  if p_publish_at is null or p_publish_at < now() + interval '2 minutes' then
    raise exception 'Pick a publish time at least a few minutes from now' using errcode = 'check_violation';
  end if;
  v_problems := content_social_publish_problems(p);
  if cardinality(v_problems) > 0 then
    raise exception 'The publisher would not send this post, so it can only be approved (not scheduled): %',
      array_to_string(v_problems, ' ') using errcode = 'check_violation';
  end if;
  update social_posts set review_status = 'approved', review_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_post;
  update social_posts set publish_status = 'scheduled', scheduled_at = p_publish_at
   where id = p_post;
  select * into p from social_posts where id = p_post;
  return jsonb_build_object('post_id', p.id, 'review_status', p.review_status, 'publish_status', p.publish_status,
                            'scheduled_at', p.scheduled_at, 'approved_publish_at', p.approved_publish_at,
                            'approved_hash', p.approved_hash, 'approved_destination', p.approved_destination);
end $$;
revoke all on function social_post_approve_and_schedule(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function social_post_approve_and_schedule(uuid, timestamptz, timestamptz, text) to authenticated;

-- ── 7. The review queue (one read model across clients) ────────────────────
-- Every open social post (draft after a rejection, in review, approved,
-- scheduled, publishing, failed, and published in the last 14 days) with the
-- final copy, media, destination, the slot's planned date, readiness and the
-- publisher's blockers, and a stage:
--   ready              in review, grounded, an image or a stated no-image reason
--   needs_preparation  in review but not grounded, or no image and no reason
--   revising           rejected or a draft after rejection (feedback attached)
--   blocked            in review but the client is held or the post names no account
--   approved / scheduled / publishing / published / failed  (delivery)
create function review_queue(p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not is_team() then
    raise exception 'Only the Compass team can read the review queue' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(q)::jsonb order by q.client_name, q.platform, q.submitted_at nulls last, q.id)
    from (
      select p.id, p.client_id, c.name as client_name, c.status::text as client_status, p.platform::text as platform,
             p.copy, p.cta_type, p.cta_url, p.post_type, p.search_intent,
             s.name as service_name, k.keyword,
             p.review_status, p.publish_status, p.submitted_at, p.reviewed_at, p.review_note, p.rejection_category,
             p.scheduled_at, p.approved_publish_at, p.published_at, p.published_url, p.external_post_id, p.error,
             p.publish_attempts, p.no_image_reason,
             p.social_account_id, d->>'name' as destination_name, d->>'key' as destination_key,
             p.approved_destination,
             (select min(i.planned_date) from content_plan_items i where i.social_post_id = p.id and i.retired_at is null) as planned_date,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                        'kind', case when pa.creative_asset_id is not null then 'creative' else coalesce(ba.kind::text, 'photo') end,
                        'label', coalesce(ba.label, ca.alt_text),
                        'storage_path', coalesce(ba.storage_path, ca.storage_path),
                        'bucket', case when pa.creative_asset_id is not null then 'creative-assets' else 'brand-assets' end,
                        'asset_id', coalesce(pa.brand_asset_id, pa.creative_asset_id),
                        'url', ba.url, 'content_hash', coalesce(pa.content_hash, ca.content_hash),
                        'width', coalesce(ba.width, ca.width), 'height', coalesce(ba.height, ca.height))
                      order by pa.sort_order)
               from post_assets pa
               left join brand_assets ba on ba.id = pa.brand_asset_id
               left join creative_assets ca on ca.id = pa.creative_asset_id
               where pa.post_id = p.id), '[]'::jsonb) as media,
             social_post_grounding_problems(p) as grounding_problems,
             content_social_publish_problems(p) as publish_problems,
             social_post_client_hold(p.client_id) as client_hold,
             case
               when p.publish_status = 'published' then 'published'
               when p.publish_status = 'publishing' then 'publishing'
               when p.publish_status = 'failed' then 'failed'
               when p.publish_status = 'scheduled' then 'scheduled'
               when p.review_status = 'approved' then 'approved'
               when p.review_status = 'rejected' or (p.review_status = 'draft' and (p.rejected_copy_hash is not null or p.rejected_media_hash is not null)) then 'revising'
               when p.review_status = 'in_review' and (social_post_client_hold(p.client_id) is not null or p.social_account_id is null) then 'blocked'
               when p.review_status = 'in_review' and cardinality(social_post_grounding_problems(p)) = 0
                    and (exists (select 1 from post_assets pa where pa.post_id = p.id) or p.no_image_reason is not null) then 'ready'
               when p.review_status = 'in_review' then 'needs_preparation'
               else 'draft'
             end as stage,
             (select h.note from social_post_history h where h.post_id = p.id and h.kind = 'rejected' order by h.id desc limit 1) as last_feedback,
             (select count(*) from social_post_history h where h.post_id = p.id and h.kind = 'rejected') as rejections
      from social_posts p
      join clients c on c.id = p.client_id
      left join services s on s.id = p.service_id
      left join keywords k on k.id = p.keyword_id
      left join lateral (select content_social_destination(p) as d) dd on true
      where (p_client is null or p.client_id = p_client)
        and p.platform::text in ('facebook', 'google_business')
        and (p.review_status in ('in_review', 'approved', 'rejected')
             or (p.review_status = 'draft' and (p.rejected_copy_hash is not null or p.rejected_media_hash is not null))
             or p.publish_status in ('scheduled', 'publishing', 'failed'))
        and not (p.publish_status = 'published' and p.published_at < now() - interval '14 days')
    ) q), '[]'::jsonb);
end $$;
revoke all on function review_queue(uuid) from public, anon;
grant execute on function review_queue(uuid) to authenticated;

-- A stated reason for a deliberately image-less post (not content: it is not
-- part of the approval, and may be set while the post is in review).
create function social_post_set_no_image_reason(p_post uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not is_team() then
    raise exception 'Only the Compass team sets this' using errcode = 'insufficient_privilege';
  end if;
  update social_posts set no_image_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_post and review_status in ('draft', 'in_review', 'rejected');
  if not found then raise exception 'Only a post that is not yet approved takes a no-image reason' using errcode = 'check_violation'; end if;
end $$;
revoke all on function social_post_set_no_image_reason(uuid, text) from public, anon;
grant execute on function social_post_set_no_image_reason(uuid, text) to authenticated;
