-- Delegated approval and publication: every client, blogs + Facebook + Google
-- Business Profile (Oct 19 2026). Extends 20261019190532; see
-- docs/delegated-content-approval.md.
--
-- Tom reviews the content and explicitly authorizes each item or batch in
-- ChatGPT or Claude; the standing permission lets either assistant carry out
-- his instruction. It never authorizes unattended publishing.
--
--   1. Central policy instead of the per-client pilot table:
--      content_delegation_settings (one row: on/off, approve, publish, the
--      channels) and content_delegation_exclusions (a client, or a client and
--      one channel; removable, kept as history). Paused and offboarded clients
--      are never delegated. Changed only by a signed-in team admin.
--   2. Social posts join the receipts. A Facebook item binds the post, its
--      exact approval snapshot (copy, claims, offer, images and their hashes,
--      creative) and the Page (Zernio account + Page id); a Business Profile
--      item binds the location (locations/<id>). The review hash covers all of
--      it, so any change after review refuses the item.
--   3. Publishing uses the existing publisher: "publish" schedules the
--      approved post (now or at the authorized time), and post-publisher's
--      tick publishes it through its own claim, preflight, Zernio binding,
--      image hash and duplicate checks. A post the publisher would not send
--      (switch off, client not on the pilot list, Page / location not bound,
--      enabled and healthy, Business Profile not on Zernio) is refused before
--      anything changes; approval alone is still allowed.
--   4. The social review gate accepts an executing receipt for exactly the
--      posts in its scope, like the blog gates; the reviewer and the event
--      actor are the authorizing admin, the note names the assistant.
--   5. Status is one vocabulary for every channel: approved, scheduled,
--      queued, publishing, published (with the live URL and the provider's
--      post id), failed (with the reason), uncertain.
--
-- Rollback: restore content_review_batch / _record / _execute / _status and
-- content_delegation_allows from 20261019190532, recreate
-- content_delegation_policies, restore social_posts_before_update and
-- social_posts_record_events from 0045, drop the new tables and functions.

-- ── 1. Central policy ───────────────────────────────────────────────────────
create table content_delegation_settings (
  id boolean primary key default true check (id),
  enabled boolean not null,
  allow_approve boolean not null,
  allow_publish boolean not null,
  channels text[] not null check (channels <@ array['blog', 'facebook', 'google_business']::text[]),
  note text,
  updated_by uuid references team_members (id),
  updated_at timestamptz not null default now(),
  check (allow_approve or not allow_publish)
);
comment on table content_delegation_settings is
  'One row: whether an admin''s explicit chat instruction (through Executive OS) may approve and/or publish content, and on which channels (20261019230000). Exclusions narrow it per client / channel.';

create table content_delegation_exclusions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  channel text check (channel in ('blog', 'facebook', 'google_business')),  -- null = every channel
  reason text not null check (length(btrim(reason)) between 1 and 500),
  created_by uuid references team_members (id),
  created_at timestamptz not null default now(),
  removed_by uuid references team_members (id),
  removed_at timestamptz,
  check (removed_at is not null or removed_by is null)
);
create unique index content_delegation_exclusions_active_idx
  on content_delegation_exclusions (client_id, coalesce(channel, '*')) where removed_at is null;

alter table content_delegation_settings enable row level security;
alter table content_delegation_exclusions enable row level security;
create policy "team reads delegation settings" on content_delegation_settings
  for select to authenticated using ((select is_team()));
create policy "team reads delegation exclusions" on content_delegation_exclusions
  for select to authenticated using ((select is_team()));
revoke all on content_delegation_settings, content_delegation_exclusions from anon, authenticated;
grant select on content_delegation_settings, content_delegation_exclusions to authenticated;

create function content_delegation_policy_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('compass.delegation_admin', true), '') <> 'on' and not drafter_caller_is_superuser() then
    raise exception 'The delegation policy changes only through content_delegation_configure / _exclude / _include' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' and not drafter_caller_is_superuser() then
    raise exception 'Delegation policy history is kept; remove an exclusion instead' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function content_delegation_policy_guard() from public, anon, authenticated;
create trigger content_delegation_settings_guard before insert or update or delete on content_delegation_settings
  for each row execute function content_delegation_policy_guard();
create trigger content_delegation_exclusions_guard before insert or update or delete on content_delegation_exclusions
  for each row execute function content_delegation_policy_guard();

-- Tom's decision (Oct 19 2026): every client, all three channels; each
-- publication still needs his explicit instruction.
select set_config('compass.delegation_admin', 'on', true);
insert into content_delegation_settings (enabled, allow_approve, allow_publish, channels, note)
values (true, true, true, array['blog', 'facebook', 'google_business'],
        'Tom, Oct 19 2026: every client, blogs + Facebook + Business Profile. Each item or batch still needs his explicit instruction in ChatGPT or Claude; never unattended.');
select set_config('compass.delegation_admin', '', true);

-- The admin doors (a signed-in team admin, from the app or SQL as that admin).
create function content_delegation_admin_check() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not (post_caller_is_human() and is_team_admin()) then
    raise exception 'Only a signed-in Compass admin changes the delegation policy' using errcode = '42501';
  end if;
  return task_actor();
end $$;
revoke all on function content_delegation_admin_check() from public, anon, authenticated;

create function content_delegation_configure(p_enabled boolean, p_allow_approve boolean, p_allow_publish boolean,
                                             p_channels text[], p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := content_delegation_admin_check(); s content_delegation_settings;
begin
  perform set_config('compass.delegation_admin', 'on', true);
  update content_delegation_settings set enabled = p_enabled, allow_approve = p_allow_approve, allow_publish = p_allow_publish,
         channels = coalesce(p_channels, '{}'), note = nullif(btrim(coalesce(p_note, '')), ''), updated_by = me, updated_at = now()
   returning * into s;
  perform set_config('compass.delegation_admin', '', true);
  return to_jsonb(s);
end $$;
revoke all on function content_delegation_configure(boolean, boolean, boolean, text[], text) from public, anon;
grant execute on function content_delegation_configure(boolean, boolean, boolean, text[], text) to authenticated;

create function content_delegation_exclude(p_client uuid, p_channel text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := content_delegation_admin_check(); x content_delegation_exclusions;
begin
  perform set_config('compass.delegation_admin', 'on', true);
  insert into content_delegation_exclusions (client_id, channel, reason, created_by)
  values (p_client, p_channel, p_reason, me) returning * into x;
  perform set_config('compass.delegation_admin', '', true);
  return to_jsonb(x);
end $$;
revoke all on function content_delegation_exclude(uuid, text, text) from public, anon;
grant execute on function content_delegation_exclude(uuid, text, text) to authenticated;

create function content_delegation_include(p_exclusion uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := content_delegation_admin_check(); x content_delegation_exclusions;
begin
  perform set_config('compass.delegation_admin', 'on', true);
  update content_delegation_exclusions set removed_at = now(), removed_by = me
   where id = p_exclusion and removed_at is null returning * into x;
  perform set_config('compass.delegation_admin', '', true);
  if x.id is null then raise exception 'No active exclusion with that id' using errcode = 'P0002'; end if;
  return to_jsonb(x);
end $$;
revoke all on function content_delegation_include(uuid) from public, anon;
grant execute on function content_delegation_include(uuid) to authenticated;

-- Null when the policy allows it, else why not.
create function content_delegation_refusal(p_client uuid, p_channel text, p_action text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s content_delegation_settings; c clients; x content_delegation_exclusions;
begin
  select * into s from content_delegation_settings;
  if s.id is null or not s.enabled then return 'Delegated approval is switched off in Compass.'; end if;
  if not (p_channel = any (s.channels)) then return format('Delegation is not enabled for %s.', p_channel); end if;
  if not s.allow_approve then return 'Delegated approval is not enabled.'; end if;
  if p_action <> 'approve' and not s.allow_publish then return 'Delegated publishing is not enabled; approve only.'; end if;
  select * into c from clients where id = p_client;
  if c.id is null then return 'No such client.'; end if;
  if c.status::text in ('paused', 'offboarded') then return format('%s is %s.', c.name, c.status); end if;
  select * into x from content_delegation_exclusions
   where client_id = p_client and removed_at is null and (channel is null or channel = p_channel)
   order by channel nulls first limit 1;
  if x.id is not null then
    return format('%s is excluded from delegated approval%s: %s', c.name, coalesce(' for ' || x.channel, ''), x.reason);
  end if;
  return null;
end $$;
revoke all on function content_delegation_refusal(uuid, text, text) from public, anon, authenticated;

-- The pilot table is superseded by the central policy.
drop table content_delegation_policies;

-- ── 2. Social posts: destination, publishability, review hash ───────────────
-- The Page (Facebook) or location (Business Profile) the post goes to: the
-- post's own social account and its Zernio binding.
create function content_social_destination(p social_posts) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'channel', p.platform::text, 'social_account_id', a.id,
    'name', coalesce(a.publish_account_name, a.display_name),
    'provider', a.publish_provider, 'provider_account_id', a.publish_account_id,
    'target', coalesce(a.publish_page_id, a.external_account_id),
    'key', p.platform::text || ':' || coalesce(a.publish_page_id, a.external_account_id, a.id::text))
  from social_accounts a where a.id = p.social_account_id and a.client_id = p.client_id
$$;
revoke all on function content_social_destination(social_posts) from public, anon, authenticated;

-- Why post-publisher would NOT send this post itself (empty = it would).
-- The same state gates post-publisher checks before every send (switch,
-- pilot list, Zernio binding, enabled, healthy, Business Profile transport);
-- the publisher still runs its full preflight, image-hash and duplicate
-- checks at send time.
create function content_social_publish_problems(p social_posts) returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v text[] := '{}';
  s jsonb := (select value from app_settings where key = 'publisher');
  a social_accounts;
begin
  if p.platform::text not in ('facebook', 'google_business') then
    return array[format('%s posts are posted by hand, not by the publisher.', p.platform)];
  end if;
  if not coalesce((s->>'enabled')::boolean, false) then v := v || 'The publisher is switched off (Settings → Publisher).'::text; end if;
  if not coalesce(s->'clients' ? p.client_id::text, false) then v := v || 'This client is not on the publisher''s pilot list (Settings → Publisher).'::text; end if;
  select * into a from social_accounts where id = p.social_account_id and client_id = p.client_id;
  if a.id is null then return v || 'The post names no account of this client.'::text; end if;
  if a.platform is distinct from p.platform then v := v || ('The account is not a ' || p.platform::text || ' account.'); end if;
  if a.publish_provider is distinct from 'zernio' or nullif(btrim(a.publish_account_id), '') is null
     or nullif(btrim(a.publish_page_id), '') is null or a.publish_verified_at is null then
    v := v || format('The %s is not bound to the publisher (verified Zernio binding).', case when p.platform::text = 'facebook' then 'Facebook Page' else 'Business Profile location' end)::text;
  end if;
  if not coalesce(a.publish_enabled, false) then v := v || 'Publishing is not enabled for this account.'::text; end if;
  if coalesce(a.publish_health->>'status', '') <> 'healthy' then v := v || 'The account''s last health check is not healthy.'::text; end if;
  if p.platform::text = 'google_business'
     and not exists (select 1 from publisher_client_transports where client_id = p.client_id and gbp_transport = 'zernio') then
    v := v || 'Business Profile publishing for this client is not on the Zernio path.'::text;
  end if;
  return v;
end $$;
revoke all on function content_social_publish_problems(social_posts) from public, anon, authenticated;

-- Everything the approval snapshot pins (copy, claims, offer, images and their
-- hashes, creative) plus where it goes. Any change → a different hash.
create function content_social_review_hash(p social_posts) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'post_id', p.id, 'snapshot_hash', social_post_hash(social_post_snapshot(p)),
    'destination', content_social_destination(p) - 'name')::text, 'UTF8')), 'hex')
$$;
revoke all on function content_social_review_hash(social_posts) from public, anon, authenticated;

-- A blog draft's destination key: the website origin.
create function content_blog_destination_key(d content_drafts) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select content_site_destination(d.client_id, d.service_id)->>'url'
$$;
revoke all on function content_blog_destination_key(content_drafts) from public, anon, authenticated;

-- ── 3. Receipts carry any channel ───────────────────────────────────────────
alter table content_approval_authorizations alter column destination_url drop not null;
alter table content_approval_authorizations drop constraint content_approval_authorizations_items_check;
alter table content_approval_authorizations add constraint content_approval_authorizations_items_check
  check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 50);
alter table content_approval_authorizations add column channels text[];

-- Items are stored normalized: {channel, id, version (blogs), review_hash,
-- destination}. Receipts from 20261019190532 carry {draft_id, version, ...}.
create or replace function content_delegation_allows(p_draft uuid, p_version int, p_step text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select (case p_step when 'approve' then a.action in ('approve', 'approve_and_publish')
                        when 'publish' then a.action in ('publish', 'approve_and_publish') else false end)
       and exists (select 1 from jsonb_array_elements(a.items) i
                    where coalesce(i->>'channel', 'blog') = 'blog'
                      and coalesce(i->>'id', i->>'draft_id')::uuid = p_draft and (i->>'version')::int = p_version)
      from (select (content_delegation_receipt()).*) a where a.id is not null), false)
$$;

create function content_delegation_allows_post(p_post uuid, p_step text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select (case p_step when 'approve' then a.action in ('approve', 'approve_and_publish')
                        when 'publish' then a.action in ('publish', 'approve_and_publish') else false end)
       and exists (select 1 from jsonb_array_elements(a.items) i
                    where i->>'channel' in ('facebook', 'google_business') and (i->>'id')::uuid = p_post)
      from (select (content_delegation_receipt()).*) a where a.id is not null), false)
$$;
revoke all on function content_delegation_allows_post(uuid, text) from public, anon, authenticated;

-- ── 4. The social review gate accepts a live delegation (patched in place) ──
do $migration$
declare
  u text := pg_get_functiondef('public.social_posts_before_update()'::regprocedure);
  e text := pg_get_functiondef('public.social_posts_record_events()'::regprocedure);
  u1 text := $x$      when 'in_review>approved' then
        if not v_human then
          raise exception 'Only a signed-in Compass team member can approve a post' using errcode = 'insufficient_privilege';$x$;
  u2 text := $x$        v_snapshot := social_post_snapshot(new);
        new.reviewed_by := task_actor();$x$;
  u3 text := $x$  new.updated_by := case when v_human then task_actor() end;$x$;
  e1 text := $x$  v_kind text := post_caller_kind();
  v_actor uuid := case when v_kind = 'team' then task_actor() end;$x$;
  n int;
begin
  if strpos(u, 'content_delegation_allows_post') > 0 then return; end if;
  foreach n in array array[
      (length(u) - length(replace(u, u1, ''))) / length(u1), (length(u) - length(replace(u, u2, ''))) / length(u2),
      (length(u) - length(replace(u, u3, ''))) / length(u3), (length(e) - length(replace(e, e1, ''))) / length(e1)] loop
    if n <> 1 then raise exception '20261019230000: a social gate anchor is missing or repeated; review before applying'; end if;
  end loop;
  execute replace(replace(replace(u, u1,
    $x$      when 'in_review>approved' then
        -- delegated_approval_v2: a signed-in teammate, or an executing delegated authorization for this post.
        if not (v_human or content_delegation_allows_post(new.id, 'approve')) then
          raise exception 'Only a signed-in Compass team member can approve a post' using errcode = 'insufficient_privilege';$x$),
    u2, $x$        v_snapshot := social_post_snapshot(new);
        new.reviewed_by := coalesce(task_actor(), content_delegation_reviewer());$x$),
    u3, $x$  new.updated_by := case when v_human then task_actor() else content_delegation_reviewer() end;$x$);
  -- Post history names the authorizing admin as a team action (the note on
  -- the approval names the assistant and the receipt).
  execute replace(e, e1, $x$  v_kind text := case when content_delegation_active() then 'team' else post_caller_kind() end;
  v_actor uuid := case when v_kind = 'team' then coalesce(task_actor(), content_delegation_reviewer()) end;$x$);
end;
$migration$;

-- ── 5. The Edge Function's doors, extended ──────────────────────────────────
-- One vocabulary for every channel's state now.
create function content_publication_state(p_status text, p_scheduled_at timestamptz) returns text
language sql stable set search_path = public, pg_temp as $$
  select case p_status
    when 'queued' then case when p_scheduled_at > now() then 'scheduled' else 'queued' end
    when 'scheduled' then case when p_scheduled_at > now() then 'scheduled' else 'queued' end
    when 'publishing' then 'publishing'
    when 'published' then 'published'
    when 'blocked' then 'failed'
    when 'failed' then 'failed'
    else p_status end
$$;
revoke all on function content_publication_state(text, timestamptz) from public, anon;

-- The latest publisher run for a post since a moment (a block after scheduling).
create function content_social_last_run(p_post uuid, p_since timestamptz) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('outcome', r.outcome, 'detail', r.detail, 'at', r.created_at, 'transport', r.transport,
                            'provider_post_id', r.provider_post_id, 'provider_status', r.provider_status)
    from publisher_runs r where r.post_id = p_post and r.created_at >= coalesce(p_since, '-infinity'::timestamptz)
   order by r.created_at desc, r.id desc limit 1
$$;
revoke all on function content_social_last_run(uuid, timestamptz) from public, anon, authenticated;

drop function content_review_batch(uuid);
create function content_review_batch(p_client uuid, p_channel text default null) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare c clients; blogs jsonb; posts jsonb;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  if p_channel is not null and p_channel not in ('blog', 'facebook', 'google_business') then
    raise exception 'channel is blog, facebook or google_business' using errcode = '22023';
  end if;
  select * into c from clients where id = p_client;
  if c.id is null then raise exception 'No such client' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'channel', 'blog', 'id', d.id, 'draft_id', d.id, 'title', d.title, 'status', d.status, 'version', d.version,
      'approved_version', d.approved_version, 'topic', d.topic, 'primary_keyword', d.primary_keyword,
      'planned_date', pi.planned_date, 'slug', d.slug, 'h1', d.h1, 'meta_title', d.meta_title,
      'meta_description', d.meta_description, 'tldr', d.tldr, 'word_count', d.word_count,
      'hero', case when d.hero_asset_id is null then null else jsonb_build_object('asset_id', d.hero_asset_id, 'alt', d.hero_alt,
                'illustrative', (content_draft_hero(d)->>'illustrative')::boolean, 'content_hash', content_draft_hero(d)->>'content_hash') end,
      'destination', content_blog_destination_key(d),
      'destination_url', content_site_destination(d.client_id, d.service_id)->>'url',
      'destination_controlled', coalesce((content_site_destination(d.client_id, d.service_id)->>'controlled_by_compass')::boolean, false),
      'article_url', rtrim(content_site_destination(d.client_id, d.service_id)->>'url', '/')
                     || replace(coalesce(content_site_destination(d.client_id, d.service_id)->'content_paths'->>'blog_route', '/blog/{slug}/'), '{slug}', coalesce(d.slug, '')),
      'review_hash', content_draft_review_hash(d),
      'problems', to_jsonb(content_draft_problems(d) || content_draft_hero_problems(d.client_id, d.service_id, d.hero_asset_id, d.hero_alt)),
      'publish_problems', to_jsonb(case when coalesce((content_site_destination(d.client_id, d.service_id)->>'controlled_by_compass')::boolean, false)
                                        then '{}'::text[] else array['The website is not Compass-managed; it cannot be published from Compass.'] end),
      'publication', (select jsonb_build_object('state', content_publication_state(p.status, p.scheduled_at), 'status', p.status,
                        'version', p.draft_version, 'published_url', p.published_url, 'scheduled_at', p.scheduled_at, 'last_error', p.last_error)
                        from blog_publications p where p.draft_id = d.id and p.status <> 'cancelled'
                        order by p.released_at desc limit 1),
      'review_url', 'https://compass-crm-ten.vercel.app/clients/' || d.client_id || '/drafts/' || d.id)
      order by pi.planned_date nulls last, d.created_at), '[]'::jsonb)
    into blogs
    from content_drafts d left join content_plan_items pi on pi.id = d.plan_item_id
   where d.client_id = c.id and d.deliverable = 'blog' and d.status in ('in_review', 'approved')
     and coalesce(p_channel, 'blog') = 'blog';

  select coalesce(jsonb_agg(jsonb_build_object(
      'channel', p.platform::text, 'id', p.id, 'post_id', p.id, 'status', p.review_status, 'publish_status', p.publish_status,
      'post_type', p.post_type, 'copy', p.copy, 'cta', case when p.cta_type is null then null else jsonb_build_object('type', p.cta_type, 'url', p.cta_url) end,
      'images', coalesce((select jsonb_agg(jsonb_build_object('asset_id', a.id, 'label', a.label, 'kind', a.kind,
                            'content_hash', pa.content_hash, 'illustrative', a.kind = 'social_post') order by pa.sort_order, a.id)
                          from post_assets pa join brand_assets a on a.id = pa.brand_asset_id where pa.post_id = p.id), '[]'::jsonb)
                || coalesce((select jsonb_agg(jsonb_build_object('creative_asset_id', ca.id, 'content_hash', ca.content_hash,
                               'alt', ca.alt_text, 'illustrative', true) order by pa.sort_order, ca.id)
                             from post_assets pa join creative_assets ca on ca.id = pa.creative_asset_id where pa.post_id = p.id), '[]'::jsonb),
      'destination', content_social_destination(p)->>'key',
      'destination_name', content_social_destination(p)->>'name',
      'scheduled_at', p.scheduled_at, 'submitted_at', p.submitted_at,
      'review_hash', content_social_review_hash(p),
      'approval_current', p.approved_hash is not null and p.approved_hash = social_post_hash(social_post_snapshot(p)),
      'problems', to_jsonb(social_post_grounding_problems(p)),
      'publish_problems', to_jsonb(content_social_publish_problems(p)),
      'publication', jsonb_strip_nulls(jsonb_build_object(
          'state', case when p.publish_status = 'not_scheduled' then null else content_publication_state(p.publish_status::text, p.scheduled_at) end,
          'published_url', p.published_url, 'provider_post_id', p.external_post_id, 'error', p.error)),
      'review_url', 'https://compass-crm-ten.vercel.app/clients/' || p.client_id || '/posts/' || p.id)
      order by p.submitted_at nulls last, p.created_at), '[]'::jsonb)
    into posts
    from social_posts p
   where p.client_id = c.id and p.platform::text in ('facebook', 'google_business')
     and p.review_status in ('in_review', 'approved') and p.publish_status <> 'published'
     and (p_channel is null or p.platform::text = p_channel);

  return jsonb_build_object(
    'client', jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status),
    'policy', jsonb_build_object(
      'blog', jsonb_build_object('approve', content_delegation_refusal(c.id, 'blog', 'approve') is null, 'publish', content_delegation_refusal(c.id, 'blog', 'publish') is null,
                                 'refusal', content_delegation_refusal(c.id, 'blog', 'publish')),
      'facebook', jsonb_build_object('approve', content_delegation_refusal(c.id, 'facebook', 'approve') is null, 'publish', content_delegation_refusal(c.id, 'facebook', 'publish') is null,
                                     'refusal', content_delegation_refusal(c.id, 'facebook', 'publish')),
      'google_business', jsonb_build_object('approve', content_delegation_refusal(c.id, 'google_business', 'approve') is null, 'publish', content_delegation_refusal(c.id, 'google_business', 'publish') is null,
                                            'refusal', content_delegation_refusal(c.id, 'google_business', 'publish'))),
    'items', blogs || posts,
    'drafts', blogs);
end $$;
revoke all on function content_review_batch(uuid, text) from public, anon, authenticated;
grant execute on function content_review_batch(uuid, text) to service_role;

-- Record: validates every item's channel against the central policy and
-- stores the items normalized.
create or replace function content_authorization_record(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  r content_approval_authorizations;
  m team_members;
  v_hash text := 'sha256:' || encode(sha256(convert_to((p - 'source_ref')::text, 'UTF8')), 'hex');
  v_action text := p->>'action';
  v_text text := btrim(coalesce(p->>'instruction_text', ''));
  v_publish_at timestamptz;
  v_items jsonb := '[]'::jsonb;
  v_channels text[] := '{}';
  v_refusal text;
  it jsonb;
  v_channel text;
  ch text;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  select * into r from content_approval_authorizations where operation_id = p->>'operation_id';
  if r.id is not null then
    if r.request_hash <> v_hash then
      raise exception 'operation_reused: operation % was used for a different request', r.operation_id using errcode = 'CD409';
    end if;
    return to_jsonb(r) || jsonb_build_object('replayed', true);
  end if;
  select * into m from team_members where lower(email) = lower(btrim(coalesce(p->>'account_email', '')));
  if m.id is null or m.role <> 'admin' then
    raise exception 'not_authorized: % is not a Compass admin who can approve content', p->>'account_email' using errcode = '42501';
  end if;
  if v_action not in ('approve', 'publish', 'approve_and_publish') then
    raise exception 'action_invalid: approve, publish or approve_and_publish' using errcode = '22023';
  end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') not between 1 and 50 then
    raise exception 'items_invalid: 1 to 50 items' using errcode = '22023';
  end if;
  for it in select * from jsonb_array_elements(p->'items') loop
    v_channel := coalesce(it->>'channel', 'blog');
    if v_channel not in ('blog', 'facebook', 'google_business') then
      raise exception 'items_invalid: channel % is not supported', v_channel using errcode = '22023';
    end if;
    if v_channel = 'blog' and (it->>'version') is null then
      raise exception 'items_invalid: a blog item needs its reviewed version' using errcode = '22023';
    end if;
    v_items := v_items || jsonb_strip_nulls(jsonb_build_object(
      'channel', v_channel, 'id', coalesce(it->>'id', it->>'draft_id', it->>'post_id'),
      'version', case when v_channel = 'blog' then (it->>'version')::int end,
      'review_hash', it->>'review_hash',
      'destination', coalesce(it->>'destination', case when v_channel = 'blog' then p->>'destination_url' end)));
    if not (v_channel = any (v_channels)) then v_channels := v_channels || v_channel; end if;
  end loop;
  if (select count(distinct x->>'id') from jsonb_array_elements(v_items) x) <> jsonb_array_length(v_items) then
    raise exception 'items_invalid: an item appears twice' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_items) x where x->>'destination' is null or x->>'review_hash' is null) then
    raise exception 'items_invalid: every item needs its review_hash and destination from the batch' using errcode = '22023';
  end if;
  foreach ch in array v_channels loop
    v_refusal := content_delegation_refusal((p->>'client_id')::uuid, ch, v_action);
    if v_refusal is not null then
      raise exception 'policy_disallows: %', v_refusal using errcode = '42501';
    end if;
  end loop;
  if v_text = '' then raise exception 'instruction_missing: the owner''s exact words are required' using errcode = '22023'; end if;
  -- The words must carry the action: approval words for an approval, publishing
  -- words for a publication. Anything else is ambiguous and is asked, not done.
  if v_action in ('approve', 'approve_and_publish') and v_text !~* '\m(approve[ds]?|approving|ok(ay)?|sign(ed)?[- ]off|good to go|go ahead)\M' then
    raise exception 'intent_unclear: the instruction does not say to approve' using errcode = '22023';
  end if;
  if v_action in ('publish', 'approve_and_publish') and v_text !~* '(publish|go live|live on|put (them|it|these) (live|up|on)|on the (web)?site|post (them|it|these)|push (them|it|these) live|schedule)' then
    raise exception 'intent_unclear: the instruction does not say to publish' using errcode = '22023';
  end if;
  if v_action = 'approve' and v_text ~* '(publish|go live|on the (web)?site|schedule)' then
    raise exception 'intent_mismatch: the instruction asks to publish; use approve_and_publish' using errcode = '22023';
  end if;
  if v_action <> 'approve' then
    v_publish_at := coalesce((p->>'publish_at')::timestamptz, now());
    if v_publish_at < now() - interval '5 minutes' then raise exception 'timing_invalid: now or a future time' using errcode = '22023'; end if;
  end if;
  perform set_config('compass.delegation_write', 'on', true);
  insert into content_approval_authorizations (operation_id, request_hash, client_id, action, authorized_by, account_email, channel,
      executed_by, instruction_text, instructed_at, source_ref, items, destination_url, publish_at, channels)
    values (p->>'operation_id', v_hash, (p->>'client_id')::uuid, v_action, m.id, lower(btrim(p->>'account_email')), p->>'channel',
      btrim(p->>'executed_by'), v_text, coalesce((p->>'instructed_at')::timestamptz, now()), p->'source_ref', v_items,
      p->>'destination_url', v_publish_at, v_channels)
    returning * into r;
  perform set_config('compass.delegation_write', '', true);
  return to_jsonb(r) || jsonb_build_object('replayed', false);
end $$;

-- Execute: every item checked, then the existing workflow per channel, in
-- one transaction.
create or replace function content_authorization_execute(p_id uuid) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  r content_approval_authorizations;
  d content_drafts;
  sp social_posts;
  it jsonb;
  dest jsonb;
  res jsonb := '[]'::jsonb;
  m team_members;
  v_note text;
  v_pub uuid;
  v_label text;
  v_channel text;
  v_problems text[];
  v_refusal text;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  select * into r from content_approval_authorizations where id = p_id for update;
  if r.id is null then raise exception 'No such authorization' using errcode = 'P0002'; end if;
  if r.status in ('executed', 'refused') then return to_jsonb(r) || jsonb_build_object('replayed', true); end if;
  select * into m from team_members where id = r.authorized_by;
  v_label := case r.channel when 'chatgpt' then 'ChatGPT' else 'Claude' end;
  v_note := format('Approved by %s through %s (Executive OS); executed by %s. Authorization %s: "%s"',
                   m.name, v_label, r.executed_by, r.id, left(r.instruction_text, 300));

  perform set_config('compass.delegation_write', 'on', true);
  update content_approval_authorizations set status = 'executing', executing_txid = txid_current() where id = r.id;
  perform set_config('compass.delegation', r.id::text, true);

  -- The policy again (it may have changed since recording).
  for v_channel in select distinct coalesce(x->>'channel', 'blog') from jsonb_array_elements(r.items) x loop
    v_refusal := content_delegation_refusal(r.client_id, v_channel, r.action);
    if v_refusal is not null then raise exception 'policy_disallows: %', v_refusal using errcode = '23514'; end if;
  end loop;

  -- Check every item before changing any.
  for it in select * from jsonb_array_elements(r.items) loop
    v_channel := coalesce(it->>'channel', 'blog');
    if v_channel = 'blog' then
      select * into d from content_drafts where id = coalesce(it->>'id', it->>'draft_id')::uuid and client_id = r.client_id for update;
      if d.id is null then raise exception 'draft_not_found: % is not a draft of this client', coalesce(it->>'id', it->>'draft_id') using errcode = '23514'; end if;
      if d.deliverable <> 'blog' then raise exception 'not_a_blog: %', d.id using errcode = '23514'; end if;
      if d.version <> (it->>'version')::int then
        raise exception 'stale_version: "%" is now version %, not %; review it again', d.title, d.version, it->>'version' using errcode = '23514';
      end if;
      if content_draft_review_hash(d) <> it->>'review_hash' then
        raise exception 'content_changed: "%" changed since it was reviewed; review it again', d.title using errcode = '23514';
      end if;
      dest := content_site_destination(d.client_id, d.service_id);
      if dest->>'url' is distinct from coalesce(it->>'destination', r.destination_url) then
        raise exception 'wrong_destination: "%" goes to %, not %', d.title, coalesce(dest->>'url', 'no website'), coalesce(it->>'destination', r.destination_url) using errcode = '23514';
      end if;
      if r.action <> 'approve' and not coalesce((dest->>'controlled_by_compass')::boolean, false) then
        raise exception 'destination_not_publishable: % is not a Compass-managed website', dest->>'url' using errcode = '23514';
      end if;
      if r.action in ('approve', 'approve_and_publish') and d.status <> 'in_review' then
        raise exception 'not_in_review: "%" is %', d.title, d.status using errcode = '23514';
      end if;
      if r.action = 'publish' and not (d.status = 'approved' and d.approved_version = d.version) then
        raise exception 'not_approved: "%" is % (approve it first)', d.title, d.status using errcode = '23514';
      end if;
    else
      select * into sp from social_posts where id = (it->>'id')::uuid and client_id = r.client_id for update;
      if sp.id is null then raise exception 'post_not_found: % is not a post of this client', it->>'id' using errcode = '23514'; end if;
      if sp.platform::text <> v_channel then
        raise exception 'channel_mismatch: post % is a % post, not %', sp.id, sp.platform, v_channel using errcode = '23514';
      end if;
      if content_social_destination(sp)->>'key' is distinct from it->>'destination' then
        raise exception 'wrong_destination: the % post goes to %, not %', sp.platform, coalesce(content_social_destination(sp)->>'key', 'no account'), it->>'destination' using errcode = '23514';
      end if;
      if content_social_review_hash(sp) <> it->>'review_hash' then
        raise exception 'content_changed: the % post % changed since it was reviewed; review it again', sp.platform, sp.id using errcode = '23514';
      end if;
      if r.action in ('approve', 'approve_and_publish') and sp.review_status <> 'in_review' then
        raise exception 'not_in_review: the % post % is %', sp.platform, sp.id, sp.review_status using errcode = '23514';
      end if;
      if r.action = 'publish' and not (sp.review_status = 'approved' and sp.approved_hash = social_post_hash(social_post_snapshot(sp))) then
        raise exception 'not_approved: the % post % is % (approve it first)', sp.platform, sp.id, sp.review_status using errcode = '23514';
      end if;
      if r.action <> 'approve' then
        v_problems := content_social_publish_problems(sp);
        if cardinality(v_problems) > 0 then
          raise exception 'destination_not_publishable: the % post % would not be sent by the publisher: %', sp.platform, sp.id, array_to_string(v_problems, ' ') using errcode = '23514';
        end if;
        if r.action = 'publish' and sp.publish_status = 'publishing' then
          raise exception 'publishing_in_progress: the % post % is being published now', sp.platform, sp.id using errcode = '23514';
        end if;
      end if;
    end if;
  end loop;

  -- Then the existing workflow, item by item.
  for it in select * from jsonb_array_elements(r.items) loop
    v_channel := coalesce(it->>'channel', 'blog');
    if v_channel = 'blog' then
      if r.action in ('approve', 'approve_and_publish') then
        perform content_draft_approve(coalesce(it->>'id', it->>'draft_id')::uuid, (it->>'version')::int, v_note);
      end if;
      v_pub := null;
      if r.action in ('publish', 'approve_and_publish') then
        v_pub := blog_publication_queue(coalesce(it->>'id', it->>'draft_id')::uuid, (it->>'version')::int, r.publish_at);
      end if;
      select * into d from content_drafts where id = coalesce(it->>'id', it->>'draft_id')::uuid;
      res := res || jsonb_build_object('channel', 'blog', 'id', d.id, 'draft_id', d.id, 'title', d.title, 'version', d.version,
               'status', d.status, 'approved_hash', d.approved_hash, 'publication_id', v_pub);
    else
      if r.action in ('approve', 'approve_and_publish') then
        update social_posts set review_status = 'approved', review_note = v_note where id = (it->>'id')::uuid;
      end if;
      -- Publishing = the existing schedule; post-publisher sends it. A post
      -- already scheduled or published is left as it is (never twice).
      if r.action in ('publish', 'approve_and_publish') then
        update social_posts set publish_status = 'scheduled', scheduled_at = r.publish_at
         where id = (it->>'id')::uuid and publish_status in ('not_scheduled', 'failed');
      end if;
      select * into sp from social_posts where id = (it->>'id')::uuid;
      res := res || jsonb_build_object('channel', sp.platform::text, 'id', sp.id, 'post_id', sp.id, 'status', sp.review_status,
               'publish_status', sp.publish_status, 'scheduled_at', sp.scheduled_at, 'approved_hash', sp.approved_hash,
               'destination', content_social_destination(sp)->>'key');
    end if;
  end loop;

  update content_approval_authorizations set status = 'executed', executed_at = now(), results = res, executing_txid = null where id = r.id
    returning * into r;
  perform set_config('compass.delegation', '', true);
  perform set_config('compass.delegation_write', '', true);
  return to_jsonb(r) || jsonb_build_object('replayed', false);
end $$;

-- Status: the receipt and every item's state now, in one vocabulary.
create or replace function content_authorization_status(p_operation_id text) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare r content_approval_authorizations;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  select * into r from content_approval_authorizations where operation_id = p_operation_id;
  if r.id is null then return null; end if;
  return to_jsonb(r) - 'executing_txid' || jsonb_build_object('items_now', coalesce((
    select jsonb_agg(x.item order by x.n) from (
      select n, case when coalesce(it->>'channel', 'blog') = 'blog' then (
        select jsonb_build_object(
          'channel', 'blog', 'id', d.id, 'draft_id', d.id, 'title', d.title, 'draft_status', d.status, 'version', d.version,
          'authorized_version', (it->>'version')::int, 'approved_version', d.approved_version,
          'state', case when p.id is not null then content_publication_state(p.status, p.scheduled_at)
                        when d.status = 'approved' then 'approved' else d.status end,
          'publication', case when p.id is null then null else jsonb_build_object(
            'id', p.id, 'state', content_publication_state(p.status, p.scheduled_at), 'status', p.status,
            'scheduled_at', p.scheduled_at, 'published_url', p.published_url, 'published_at', p.published_at,
            'commit_sha', p.commit_sha, 'last_error', p.last_error) end)
          from content_drafts d
          left join lateral (select * from blog_publications bp where bp.draft_id = d.id and bp.draft_version = (it->>'version')::int
                               and bp.status <> 'cancelled' order by bp.released_at desc limit 1) p on true
         where d.id = coalesce(it->>'id', it->>'draft_id')::uuid)
      else (
        select jsonb_build_object(
          'channel', sp.platform::text, 'id', sp.id, 'review_status', sp.review_status, 'publish_status', sp.publish_status,
          'destination', content_social_destination(sp)->>'key', 'destination_name', content_social_destination(sp)->>'name',
          'state', case
            when sp.publish_status <> 'not_scheduled' then content_publication_state(sp.publish_status::text, sp.scheduled_at)
            -- Scheduled by this authorization, then unscheduled by the publisher's preflight: it failed.
            when r.action <> 'approve' and lr->>'outcome' = 'blocked' then 'failed'
            else sp.review_status::text end,
          'scheduled_at', sp.scheduled_at, 'published_url', sp.published_url, 'published_at', sp.published_at,
          'provider_post_id', sp.external_post_id, 'error', coalesce(sp.error, case when lr->>'outcome' = 'blocked' then lr->>'detail' end),
          'last_run', lr)
          from social_posts sp
          cross join lateral (select content_social_last_run(sp.id, r.executed_at) lr) l
         where sp.id = (it->>'id')::uuid)
      end item
      from jsonb_array_elements(r.items) with ordinality t(it, n)) x), '[]'::jsonb));
end $$;

-- ── 6. Postconditions ───────────────────────────────────────────────────────
do $$
begin
  if (select prosrc from pg_proc where oid = 'public.social_posts_before_update()'::regprocedure) not like '%content_delegation_allows_post%'
     or (select prosrc from pg_proc where oid = 'public.social_posts_record_events()'::regprocedure) not like '%content_delegation_active()%' then
    raise exception '20261019230000: a social gate was not patched';
  end if;
  if has_function_privilege('authenticated', 'public.content_delegation_allows_post(uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.content_review_batch(uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.content_social_review_hash(social_posts)', 'execute')
     or has_function_privilege('anon', 'public.content_delegation_configure(boolean,boolean,boolean,text[],text)', 'execute')
     or has_table_privilege('authenticated', 'public.content_delegation_settings', 'update')
     or has_table_privilege('authenticated', 'public.content_delegation_exclusions', 'insert') then
    raise exception '20261019230000: grants are wrong';
  end if;
  if (select count(*) from content_delegation_settings) <> 1 then
    raise exception '20261019230000: exactly one settings row';
  end if;
end $$;
