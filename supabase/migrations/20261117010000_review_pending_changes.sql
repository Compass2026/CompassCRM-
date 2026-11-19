-- Review workflow, finished (Nov 17 2026). Tom: "Posts with pending copy or
-- image changes must remain 'Needs preparation.' Show 'Ready for final
-- review' only when the displayed copy and image are the actual final
-- version." and "Verify ... Reject with feedback through revision and fresh
-- review."
--
-- 1. content_edit_holds: one row per change Executive OS has asked Tom to
--    approve for a post (a copy edit or new media). Executive OS opens it
--    when it files the approval request (content-approvals mode "hold") and
--    closes it when Tom rejects the request or the operator withdraws or
--    supersedes it (mode "release"). Compass closes it itself when the
--    approved revision executes or is refused. Holds are records: never
--    deleted, closed once.
-- 2. While a hold is open the post is not final: the review queue shows it
--    under Needs preparation with the pending change, and approving it is
--    refused (whichever door: the Review page, the post page, a delegated
--    approval).
-- 3. A rejected post can be revised through the same delegated door
--    (content_revise): withdraw → change → resubmit, so feedback comes back
--    as a fresh review. The rejection guards of 20261116150000 still refuse
--    the same copy or image coming back unchanged.
-- 4. content_review_batch lists rejected posts too, with the feedback, the
--    rejection category and any pending changes, so an operator can revise
--    from it.

-- ── 1. Holds ────────────────────────────────────────────────────────────────
create table content_edit_holds (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique check (ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  client_id uuid not null references clients (id) on delete cascade,
  post_id uuid not null references social_posts (id) on delete cascade,
  channel text not null check (channel in ('facebook', 'google_business')),
  kind text not null check (kind in ('replace_copy', 'replace_media')),
  review_hash text check (review_hash is null or review_hash ~ '^sha256:[0-9a-f]{64}$'),
  summary text not null check (length(btrim(summary)) between 1 and 300),
  requested_by text not null check (length(btrim(requested_by)) between 1 and 160),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text check (close_reason in ('executed', 'refused', 'rejected', 'withdrawn', 'superseded')),
  close_note text check (close_note is null or length(close_note) <= 1000),
  superseded_by_ref text check (superseded_by_ref is null or superseded_by_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  check ((closed_at is null) = (close_reason is null)),
  check (superseded_by_ref is null or close_reason = 'superseded')
);
create index content_edit_holds_open_idx on content_edit_holds (post_id) where closed_at is null;
create index content_edit_holds_client_idx on content_edit_holds (client_id, opened_at desc);
comment on table content_edit_holds is
  'A change Executive OS asked Tom to approve for a post (20261117010000). Open while the request is pending; the post is not final and cannot be approved until it is closed (executed, refused, rejected, withdrawn or superseded). Written only by the content-approvals function.';

alter table content_edit_holds enable row level security;
create policy "team reads edit holds" on content_edit_holds for select to authenticated using ((select is_team()));
revoke all on content_edit_holds from anon, authenticated;
grant select on content_edit_holds to authenticated;

create function content_edit_holds_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    -- A post (or client) being removed takes its holds with it; nothing else deletes one.
    if not exists (select 1 from social_posts where id = old.post_id) or drafter_caller_is_superuser() then return old; end if;
    raise exception 'Edit holds are records' using errcode = '42501';
  end if;
  if coalesce(current_setting('compass.edit_hold', true), '') <> 'on' and not drafter_caller_is_superuser() then
    raise exception 'Edit holds are written by the content-approvals function' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if old.closed_at is not null then raise exception 'A closed hold is a record' using errcode = '42501'; end if;
    if (to_jsonb(new) - array['closed_at', 'close_reason', 'close_note', 'superseded_by_ref'])
       is distinct from (to_jsonb(old) - array['closed_at', 'close_reason', 'close_note', 'superseded_by_ref']) then
      raise exception 'A hold only closes' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end $$;
revoke all on function content_edit_holds_guard() from public, anon, authenticated;
create trigger content_edit_holds_guard before insert or update or delete on content_edit_holds
  for each row execute function content_edit_holds_guard();

-- The open holds of a post, as the queue and the batch show them.
create function content_edit_pending_changes(p_post uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'ref', h.ref, 'kind', h.kind, 'summary', h.summary, 'requested_by', h.requested_by, 'opened_at', h.opened_at,
           'stale', h.review_hash is not null and h.review_hash is distinct from content_social_review_hash(p))
           order by h.opened_at, h.id), '[]'::jsonb)
    from content_edit_holds h join social_posts p on p.id = h.post_id
   where h.post_id = p_post and h.closed_at is null
$$;
revoke all on function content_edit_pending_changes(uuid) from public, anon;
grant execute on function content_edit_pending_changes(uuid) to authenticated, service_role;

-- Open: idempotent per ref (the Executive OS approval id).
create function content_edit_hold_open(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  h content_edit_holds;
  sp social_posts;
  v_channel text := p->'post'->>'channel';
  v_post uuid;
  v_client uuid;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  if coalesce(p->>'ref', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(p->>'client_id', '') !~ '^[0-9a-f-]{36}$' or coalesce(p->'post'->>'id', '') !~ '^[0-9a-f-]{36}$'
     or v_channel is null or v_channel not in ('facebook', 'google_business')
     or coalesce(p->>'kind', '') not in ('replace_copy', 'replace_media')
     or (p->>'review_hash' is not null and p->>'review_hash' !~ '^sha256:[0-9a-f]{64}$')
     or length(btrim(coalesce(p->>'summary', ''))) not between 1 and 300
     or length(btrim(coalesce(p->>'requested_by', ''))) not between 1 and 160 then
    raise exception 'request_invalid: ref (uuid), client_id, post {channel, id}, kind, summary and requested_by are required' using errcode = '22023';
  end if;
  v_post := (p->'post'->>'id')::uuid;
  v_client := (p->>'client_id')::uuid;
  select * into h from content_edit_holds where ref = p->>'ref';
  if h.id is not null then
    if h.post_id <> v_post or h.kind <> p->>'kind' then
      raise exception 'operation_reused: hold % is for another post or change', h.ref using errcode = 'CD409';
    end if;
    return to_jsonb(h) || jsonb_build_object('replayed', true);
  end if;
  select * into sp from social_posts where id = v_post and client_id = v_client;
  if sp.id is null then raise exception 'post_not_found: % is not a post of this client', v_post using errcode = '23514'; end if;
  if sp.platform::text <> v_channel then
    raise exception 'channel_mismatch: post % is a % post, not %', sp.id, sp.platform, v_channel using errcode = '23514';
  end if;
  if sp.review_status not in ('in_review', 'rejected', 'draft') or sp.publish_status <> 'not_scheduled' or sp.approved_hash is not null then
    raise exception 'not_holdable: the post is % / %; a change can be pending only on a post that is not approved, scheduled or published',
      sp.review_status, sp.publish_status using errcode = '23514';
  end if;
  perform set_config('compass.edit_hold', 'on', true);
  insert into content_edit_holds (ref, client_id, post_id, channel, kind, review_hash, summary, requested_by)
  values (p->>'ref', v_client, v_post, v_channel, p->>'kind', p->>'review_hash', btrim(p->>'summary'), btrim(p->>'requested_by'))
  returning * into h;
  perform set_config('compass.edit_hold', '', true);
  return to_jsonb(h) || jsonb_build_object('replayed', false);
end $$;
revoke all on function content_edit_hold_open(jsonb) from public, anon, authenticated;
grant execute on function content_edit_hold_open(jsonb) to service_role;

-- Close: idempotent; an unknown ref releases nothing.
create function content_edit_hold_close(p_ref text, p_reason text, p_note text default null, p_superseded_by text default null)
returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare h content_edit_holds;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  if p_reason is null or p_reason not in ('executed', 'refused', 'rejected', 'withdrawn', 'superseded') then
    raise exception 'request_invalid: reason is rejected, withdrawn or superseded' using errcode = '22023';
  end if;
  if p_superseded_by is not null and p_reason <> 'superseded' then
    raise exception 'request_invalid: superseded_by_ref goes with reason superseded' using errcode = '22023';
  end if;
  perform set_config('compass.edit_hold', 'on', true);
  update content_edit_holds set closed_at = now(), close_reason = p_reason, close_note = left(nullif(btrim(coalesce(p_note, '')), ''), 1000),
         superseded_by_ref = p_superseded_by
   where ref = p_ref and closed_at is null returning * into h;
  perform set_config('compass.edit_hold', '', true);
  if h.id is not null then return jsonb_build_object('hold', to_jsonb(h), 'released', true); end if;
  select * into h from content_edit_holds where ref = p_ref;
  return jsonb_build_object('hold', case when h.id is null then null else to_jsonb(h) end, 'released', false);
end $$;
revoke all on function content_edit_hold_close(text, text, text, text) from public, anon, authenticated;
grant execute on function content_edit_hold_close(text, text, text, text) to service_role;

-- An approved revision closes its own hold when it finishes, either way.
create function content_edit_receipts_close_hold() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status in ('executed', 'refused') and old.status not in ('executed', 'refused')
     and new.authority->>'kind' = 'owner_approval' and new.authority->>'id' is not null then
    perform set_config('compass.edit_hold', 'on', true);
    update content_edit_holds set closed_at = now(), close_reason = new.status,
           close_note = case when new.status = 'refused' then left(new.refusal, 1000) else 'Applied by content-approvals edit ' || new.id end
     where ref = new.authority->>'id' and closed_at is null;
    perform set_config('compass.edit_hold', '', true);
  end if;
  return new;
end $$;
revoke all on function content_edit_receipts_close_hold() from public, anon, authenticated;
create trigger content_edit_receipts_close_hold after update of status on content_edit_receipts
  for each row execute function content_edit_receipts_close_hold();

-- ── 2. A post with a pending change is not approved ─────────────────────────
-- Named to run with the other before-update guards (alphabetical order; it
-- only reads, so its position among them does not matter).
create function social_posts_pending_change_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare h content_edit_holds;
begin
  if new.review_status = 'approved' and old.review_status is distinct from 'approved' then
    select * into h from content_edit_holds where post_id = new.id and closed_at is null order by opened_at limit 1;
    if h.id is not null then
      raise exception 'pending_change: a % for this post is waiting in Executive OS (request %); approve once it is applied, rejected or withdrawn',
        case h.kind when 'replace_copy' then 'copy change' else 'new image' end, h.ref
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
revoke all on function social_posts_pending_change_guard() from public, anon, authenticated;
create trigger social_posts_ab_pending_change before update of review_status on social_posts
  for each row execute function social_posts_pending_change_guard();

-- ── 3. A rejected post is revised through the same door ─────────────────────
do $$
declare
  b text := pg_get_functiondef('public.content_edit_execute(uuid,jsonb)'::regprocedure);
  old_s text := $x$  if sp.review_status <> 'in_review' or sp.publish_status <> 'not_scheduled' or sp.approved_hash is not null then
    raise exception 'not_editable: the post is % / %; only an unapproved, unscheduled post in review is revised', sp.review_status, sp.publish_status$x$;
  new_s text := $x$  if sp.review_status not in ('in_review', 'rejected') or sp.publish_status <> 'not_scheduled' or sp.approved_hash is not null then
    raise exception 'not_editable: the post is % / %; only an unapproved, unscheduled post in review (or rejected with feedback) is revised', sp.review_status, sp.publish_status$x$;
begin
  if (length(b) - length(replace(b, old_s, ''))) / length(old_s) <> 1 then
    raise exception 'content_edit_execute is not the expected definition; stop and re-read it';
  end if;
  execute replace(b, old_s, new_s);
end $$;

-- ── 4. The batch: rejected posts, feedback and pending changes ──────────────
do $$
declare
  b text := pg_get_functiondef('public.content_review_batch(uuid,text)'::regprocedure);
  s1 text := $x$      'service_id', p.service_id,
$x$;
  r1 text := $x$      'service_id', p.service_id,
      'rejection_category', p.rejection_category,
      'feedback', (select h.note from social_post_history h where h.post_id = p.id and h.kind = 'rejected' order by h.id desc limit 1),
      'pending_changes', content_edit_pending_changes(p.id),
$x$;
  s2 text := $x$and p.review_status in ('in_review', 'approved') and p.publish_status <> 'published'$x$;
  r2 text := $x$and p.review_status in ('in_review', 'approved', 'rejected') and p.publish_status <> 'published'$x$;
begin
  if (length(b) - length(replace(b, s1, ''))) / length(s1) <> 1 or (length(b) - length(replace(b, s2, ''))) / length(s2) <> 1 then
    raise exception 'content_review_batch is not the expected definition; stop and re-read it';
  end if;
  execute replace(replace(b, s1, r1), s2, r2);
end $$;

-- ── 5. The review queue: pending changes keep a post out of Ready ───────────
create or replace function review_queue(p_client uuid default null) returns jsonb
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
             content_edit_pending_changes(p.id) as pending_changes,
             case
               when p.publish_status = 'published' then 'published'
               when p.publish_status = 'publishing' then 'publishing'
               when p.publish_status = 'failed' then 'failed'
               when p.publish_status = 'scheduled' then 'scheduled'
               when p.review_status = 'approved' then 'approved'
               when p.review_status = 'rejected' or (p.review_status = 'draft' and (p.rejected_copy_hash is not null or p.rejected_media_hash is not null)) then 'revising'
               when p.review_status = 'in_review' and (social_post_client_hold(p.client_id) is not null or p.social_account_id is null) then 'blocked'
               when p.review_status = 'in_review' and cardinality(social_post_grounding_problems(p)) = 0
                    and (exists (select 1 from post_assets pa where pa.post_id = p.id) or p.no_image_reason is not null)
                    and not exists (select 1 from content_edit_holds h where h.post_id = p.id and h.closed_at is null) then 'ready'
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
