-- Several Business Profile locations per client, each post naming its own
-- (Oct 15 2026). Logic Solar has a verified Wichita profile now and an
-- Overland Park profile that is not connected yet; until now the CRM bound
-- one location per client (20261011050000) and every draft, slot and post
-- inherited it. This makes the destination explicit and per post:
--
-- 1. Binding: a client may bind several verified locations. A location is
--    bound to at most one Compass row (so one client). One Zernio
--    googlebusiness account may serve several locations (every Zernio request
--    pins its location, gbp-path.ts); a Facebook Page account stays one per
--    Compass Page. Binding never enables, as before.
-- 2. Drafts: a Business Profile draft may name its location (brief
--    target.social_account), which must be one of this client's verified
--    Zernio locations. Unnamed, the client's only location is used; with
--    several, the draft is refused. Never another location.
-- 3. Plan slots: content_plan_items.gbp_location_id names a GBP slot's
--    location. A post linked to a slot must go to that location, and a linked
--    post's destination cannot be changed to another one: a slot's posts are
--    never redirected. A slot with no location set behaves as before.
-- 4. Monthly standard: delivery_targets reports "N verified locations (chosen
--    per slot)" instead of no destination, so a multi-location client's slots
--    are not opened blocked as if nothing were connected. Targets stay per
--    client: binding a location never adds slots.
--
-- Unchanged: the review gate (the approved snapshot binds social_account_id,
-- so changing a post's location means reopening and approving it again),
-- the publisher (it already sends to the approved snapshot's location and
-- refuses an unbound or disabled one), enabling (team admin only) and the
-- Facebook rules.
--
-- Rollback: once at most one location per client is bound, recreate
-- social_accounts_one_gbp_binding and the Facebook-and-GBP
-- social_accounts_publish_account_key, restore publisher_bind_account and
-- publisher_bind_gbp_location from 20261011050000, re-run
-- 20261015010350's body on the 20261011040705 drafter_write, drop the
-- gbp_location_id column and its triggers, and restore delivery_targets'
-- destination case.

-- ── 1. Binding ───────────────────────────────────────────────────────────────
drop index social_accounts_one_gbp_binding;
-- A Business Profile location belongs to one Compass row, so to one client.
create unique index social_accounts_gbp_location_binding
  on social_accounts (publish_page_id) where platform = 'google_business' and publish_provider is not null;
-- One Compass Page per Zernio Facebook account (unchanged for Facebook).
drop index social_accounts_publish_account_key;
create unique index social_accounts_publish_account_key
  on social_accounts (publish_provider, publish_account_id)
  where publish_account_id is not null and platform = 'facebook';

create or replace function publisher_bind_account(
  p_social_account_id uuid, p_account_id text, p_page_id text, p_account_name text, p_health jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a social_accounts;
  v_kind text;
begin
  if not (session_user = 'authenticator' and current_setting('role', true) = 'service_role') then
    raise exception 'Only the publisher binds a publishing account' using errcode = 'insufficient_privilege';
  end if;
  select * into a from social_accounts where id = p_social_account_id for update;
  if not found then raise exception 'No such social account' using errcode = 'no_data_found'; end if;
  if a.platform not in ('facebook', 'google_business') then
    raise exception 'Only Facebook Pages and Business Profile locations are published through Zernio' using errcode = 'check_violation';
  end if;
  if coalesce(p_account_id, '') !~ '^[0-9a-f]{24}$' then
    raise exception 'Not a Zernio account id' using errcode = 'check_violation';
  end if;
  if a.external_account_id is null or p_page_id is distinct from a.external_account_id then
    if a.platform = 'facebook' then
      raise exception 'The Zernio account posts to Page %, not this account''s Page %', p_page_id, a.external_account_id
        using errcode = 'check_violation';
    end if;
    raise exception 'The Zernio account posts to location %, not this account''s location %', p_page_id, a.external_account_id
      using errcode = 'check_violation';
  end if;
  -- A Facebook account serves one Compass Page; a Business Profile location
  -- one Compass row. One Zernio googlebusiness account may serve several
  -- locations: each request pins its location.
  if a.platform = 'facebook' and exists (
       select 1 from social_accounts where publish_provider = 'zernio' and publish_account_id = p_account_id and id <> a.id) then
    raise exception 'That Zernio account is already bound to another Compass account' using errcode = 'unique_violation';
  end if;
  if a.platform = 'google_business' and exists (
       select 1 from social_accounts where platform = 'google_business' and publish_provider is not null
          and publish_page_id = p_page_id and id <> a.id) then
    raise exception 'Business Profile location % is already bound to another Compass account', p_page_id using errcode = 'unique_violation';
  end if;

  v_kind := case when a.publish_account_id is null then 'bound'
                 when a.publish_account_id = p_account_id then 'verified'
                 else 'bound' end;
  perform set_config('compass.publish_binding', 'bind', true);
  update social_accounts set
    publish_provider = 'zernio',
    publish_account_id = p_account_id,
    publish_page_id = p_page_id,
    publish_account_name = nullif(btrim(coalesce(p_account_name, '')), ''),
    publish_verified_at = now(),
    publish_health = p_health,
    -- A different Zernio account starts switched off.
    publish_enabled = case when a.publish_account_id = p_account_id then a.publish_enabled else false end,
    publish_enabled_by = case when a.publish_account_id = p_account_id then a.publish_enabled_by else null end,
    publish_enabled_at = case when a.publish_account_id = p_account_id then a.publish_enabled_at else null end
  where id = a.id;
  perform set_config('compass.publish_binding', '', true);

  insert into social_account_publish_events (social_account_id, client_id, kind, actor_kind, detail)
  values (a.id, a.client_id, v_kind, 'publisher', jsonb_build_object(
    'provider', 'zernio', 'platform', a.platform, 'account_id', p_account_id, 'page_id', p_page_id,
    'previous_account_id', a.publish_account_id, 'health', p_health));
  return jsonb_build_object('social_account_id', a.id, 'kind', v_kind, 'account_id', p_account_id, 'page_id', p_page_id,
    'enabled', case when a.publish_account_id = p_account_id then a.publish_enabled else false end);
end $$;
revoke execute on function publisher_bind_account(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function publisher_bind_account(uuid, text, text, text, jsonb) to service_role;

-- Binds one more (or re-verifies a) Business Profile location of a client to
-- the Zernio googlebusiness account the publisher just verified. The row is
-- the client's google_business social_accounts row for that location,
-- created when missing. Other locations of the client are untouched; a
-- location bound to another client is refused (publisher_bind_account).
-- Never enables.
create or replace function publisher_bind_gbp_location(
  p_client_id uuid, p_account_id text, p_location_id text, p_location_name text, p_account_name text, p_health jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row uuid;
begin
  if not (session_user = 'authenticator' and current_setting('role', true) = 'service_role') then
    raise exception 'Only the publisher binds a publishing account' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from clients where id = p_client_id) then
    raise exception 'No such client' using errcode = 'no_data_found';
  end if;
  if coalesce(p_location_id, '') !~ '^locations/[0-9]{1,30}$' then
    raise exception 'Not a Business Profile location (locations/<id>)' using errcode = 'check_violation';
  end if;
  if exists (select 1 from social_accounts where platform = 'google_business' and external_account_id = p_location_id
              and client_id <> p_client_id) then
    raise exception 'Business Profile location % belongs to another client', p_location_id using errcode = 'unique_violation';
  end if;

  select id into v_row from social_accounts
   where client_id = p_client_id and platform = 'google_business' and external_account_id = p_location_id
   for update;
  if not found then
    insert into social_accounts (client_id, platform, external_account_id, display_name, status)
    values (p_client_id, 'google_business', p_location_id, nullif(btrim(coalesce(p_location_name, '')), ''), 'manual_only')
    returning id into v_row;
  end if;
  perform publisher_record_gbp_transport(p_client_id, 'zernio', 'publisher', 'bind');
  return publisher_bind_account(v_row, p_account_id, p_location_id, p_account_name, p_health)
    || jsonb_build_object('client_id', p_client_id, 'location_id', p_location_id, 'gbp_transport', 'zernio');
end $$;
revoke execute on function publisher_bind_gbp_location(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function publisher_bind_gbp_location(uuid, text, text, text, text, jsonb) to service_role;

-- ── 2. Drafts name their location ───────────────────────────────────────────
do $migration$
declare
  definition text := pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
  v1 text := $q$
  -- drafter_gbp_destination_v1: only an already-bound client location.
  if v_channel = 'google_business' and exists (
    select 1 from publisher_client_transports
     where client_id = v_client and gbp_transport = 'zernio'
  ) then
    begin
      select id into strict v_account
        from social_accounts
       where client_id = v_client and platform::text = 'google_business'
         and publish_provider = 'zernio'
         and nullif(btrim(publish_account_id), '') is not null
         and nullif(btrim(publish_page_id), '') is not null
         and publish_verified_at is not null
       for share;
    exception
      when no_data_found then
        raise exception 'A Zernio Business Profile draft needs the client''s verified location binding' using errcode = 'check_violation';
      when too_many_rows then
        raise exception 'A Zernio Business Profile draft needs exactly one verified location binding' using errcode = 'check_violation';
    end;
  end if;

$q$;
  v2 text := $q$
  -- drafter_gbp_destination_v2 (20261015200000): the location the draft names
  -- (one of this client's verified Zernio locations), else the client's only
  -- one. Never chosen between several, never another client's.
  if v_channel = 'google_business' then
    v_account := nullif(v_target->'social_account'->>'id', '')::uuid;
    if v_account is not null then
      perform 1 from social_accounts
       where id = v_account and client_id = v_client and platform::text = 'google_business'
         and publish_provider = 'zernio'
         and nullif(btrim(publish_account_id), '') is not null
         and nullif(btrim(publish_page_id), '') is not null
         and publish_verified_at is not null
       for share;
      if not found then
        raise exception 'A Business Profile draft names one of this client''s verified locations' using errcode = 'check_violation';
      end if;
    elsif exists (
      select 1 from publisher_client_transports
       where client_id = v_client and gbp_transport = 'zernio'
    ) then
      begin
        select id into strict v_account
          from social_accounts
         where client_id = v_client and platform::text = 'google_business'
           and publish_provider = 'zernio'
           and nullif(btrim(publish_account_id), '') is not null
           and nullif(btrim(publish_page_id), '') is not null
           and publish_verified_at is not null
         for share;
      exception
        when no_data_found then
          raise exception 'A Zernio Business Profile draft needs the client''s verified location binding' using errcode = 'check_violation';
        when too_many_rows then
          raise exception 'This client has several Business Profile locations; the draft names one (social_account)' using errcode = 'check_violation';
      end;
    end if;
  end if;

$q$;
  facebook_only text := $q$  elsif nullif(v_target->'social_account'->>'id', '') is not null then
    raise exception 'Only a Facebook draft names a social account' using errcode = 'check_violation';
  end if;$q$;
begin
  if strpos(definition, 'drafter_gbp_destination_v2') > 0 then return; end if;
  if (length(definition) - length(replace(definition, v1, ''))) <> length(v1)
     or (length(definition) - length(replace(definition, facebook_only, ''))) <> length(facebook_only) then
    raise exception 'Unexpected drafter_write definition; review before applying per-post Business Profile locations';
  end if;
  execute replace(replace(definition, v1, v2), facebook_only, '  end if;');
end;
$migration$;

-- ── 3. Plan slots name their location ───────────────────────────────────────
alter table content_plan_items
  add column gbp_location_id uuid,
  add constraint content_plan_items_gbp_location_fk foreign key (gbp_location_id, client_id)
    references social_accounts (id, client_id) on delete set null (gbp_location_id),
  add constraint content_plan_items_gbp_location_shape check (gbp_location_id is null or deliverable = 'gbp');
comment on column content_plan_items.gbp_location_id is
  'The Business Profile location (social_accounts row) this GBP slot is for. Its linked post must go there; null = not chosen (a single-location client''s posts go to its only location).';

create function content_plan_items_gbp_location() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_platform text;
  v_dest uuid;
begin
  if new.gbp_location_id is not null
     and (tg_op = 'INSERT' or new.gbp_location_id is distinct from old.gbp_location_id) then
    select platform::text into v_platform from social_accounts where id = new.gbp_location_id;
    if v_platform is distinct from 'google_business' then
      raise exception 'A Business Profile slot names a Business Profile location' using errcode = 'check_violation';
    end if;
  end if;
  if new.gbp_location_id is not null and new.social_post_id is not null
     and (tg_op = 'INSERT' or new.gbp_location_id is distinct from old.gbp_location_id
          or new.social_post_id is distinct from old.social_post_id) then
    select social_account_id into v_dest from social_posts where id = new.social_post_id;
    if v_dest is distinct from new.gbp_location_id then
      raise exception 'The post goes to another Business Profile location than this slot; a slot''s posts are never redirected'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
revoke all on function content_plan_items_gbp_location() from public, anon, authenticated;
create trigger content_plan_items_gbp_location before insert or update of gbp_location_id, social_post_id
  on content_plan_items for each row execute function content_plan_items_gbp_location();

-- A post linked to a located slot keeps that location. (When the location row
-- itself is deleted, the foreign keys clear both.)
create function social_posts_slot_location() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.social_account_id is distinct from old.social_account_id
     and (new.social_account_id is not null or exists (select 1 from social_accounts where id = old.social_account_id))
     and exists (select 1 from content_plan_items c
                  where c.social_post_id = new.id and c.gbp_location_id is not null
                    and c.gbp_location_id is distinct from new.social_account_id) then
    raise exception 'This post fills a plan slot for another Business Profile location; a slot''s posts are never redirected'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function social_posts_slot_location() from public, anon, authenticated;
create trigger social_posts_slot_location before update of social_account_id on social_posts
  for each row execute function social_posts_slot_location();

-- ── 4. Monthly standard: several locations are a destination, chosen per slot ─
do $migration$
declare
  definition text := pg_get_functiondef('public.delivery_targets(uuid, date)'::regprocedure);
  old_case text := $q$select case when count(*) = 1 then max(coalesce(nullif(btrim(sa.publish_account_name), ''), sa.publish_page_id)) end$q$;
  new_case text := $q$select case when count(*) = 1 then max(coalesce(nullif(btrim(sa.publish_account_name), ''), sa.publish_page_id)) when count(*) > 1 then count(*) || ' verified locations (chosen per slot)' end$q$;
begin
  if strpos(definition, 'chosen per slot') > 0 then return; end if;
  if (length(definition) - length(replace(definition, old_case, ''))) <> length(old_case) then
    raise exception 'Unexpected delivery_targets definition; review before applying per-post Business Profile locations';
  end if;
  execute replace(definition, old_case, new_case);
end;
$migration$;

-- ── 5. Verify ────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.social_accounts_one_gbp_binding') is not null then
    raise exception 'The one-location-per-client index is still present';
  end if;
  if strpos(pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure), 'drafter_gbp_destination_v2') = 0 then
    raise exception 'drafter_write was not updated';
  end if;
  if has_function_privilege('authenticated', 'public.publisher_bind_gbp_location(uuid, text, text, text, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.publisher_bind_account(uuid, text, text, text, jsonb)', 'execute') then
    raise exception 'Binding functions must stay service-only';
  end if;
end $$;
