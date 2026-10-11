-- Business Profile publishing through Zernio (Oct 11 2026;
-- docs/zernio-publisher.md). Extends Zernio Social Publisher v1
-- (20261010224407) from Facebook to Google Business Profile. Tom authorized
-- the switch on Oct 10 2026; the direct Google path stays for any client that
-- has not been switched (its quota follow-up is separate).
--
-- Compass stays the system of record for content, approval, schedule and
-- result. Additive only:
--
-- 1. The publishing binding (social_accounts.publish_*) may also name a
--    Business Profile location: platform google_business, the exact Zernio
--    googlebusiness account, and the Google location resource
--    (`locations/<id>`) as both the row's external_account_id and the pinned
--    publish_page_id. At most one bound location per client: no multi-location
--    fan-out, and a client's Business Profile transport is unambiguous.
-- 2. publisher_bind_gbp_location(): the publisher's service session, after it
--    has read the account, its locations and its health with the publish key,
--    records the client's location row (creating it when the client has none)
--    and binds it through publisher_bind_account. Binding never enables;
--    enabling stays a signed-in team admin's (publisher_set_account_enabled).
--    publisher_bind_account accepts google_business rows for re-verification.
-- 3. publisher_runs.target_location_id: the exact location a Zernio request
--    was pinned to, so the destination of an in-flight post is on record and
--    a binding that changed under it is caught.
--
-- Transport selection (enforced by the publisher, docs/zernio-publisher.md):
-- a Business Profile post whose approved snapshot names the client's bound
-- location goes through Zernio only; a client with a Zernio location never
-- has a Business Profile post sent directly to Google. The approval binds the
-- destination (social_post_snapshot includes social_account_id), so naming
-- the location on an already approved post means reopening and approving it
-- again: nothing here rewrites an approval.
--
-- Unchanged: 0045's review gate, 0046's switch and pilot list, the Facebook
-- binding rules, the guard trigger and the binding history.
--
-- Rollback: drop publisher_bind_gbp_location, the publisher_runs column and
-- its check, the one-location index; restore the Facebook-only binding check
-- and publisher_bind_account from 20261010224407 (after unbinding any
-- google_business row).

-- ── 1. The binding may name a Business Profile location ─────────────────────
alter table social_accounts drop constraint social_accounts_publish_binding;
alter table social_accounts add constraint social_accounts_publish_binding check (
  (publish_provider is null and publish_account_id is null and publish_page_id is null
     and publish_verified_at is null and publish_enabled = false)
  or (publish_provider = 'zernio'
      and platform = 'facebook'
      and publish_account_id ~ '^[0-9a-f]{24}$'
      and publish_page_id ~ '^[0-9]{5,30}$'
      and publish_page_id = external_account_id
      and publish_verified_at is not null)
  or (publish_provider = 'zernio'
      and platform = 'google_business'
      and publish_account_id ~ '^[0-9a-f]{24}$'
      and publish_page_id ~ '^locations/[0-9]{1,30}$'
      and publish_page_id = external_account_id
      and publish_verified_at is not null));

-- One bound Business Profile location per client.
create unique index social_accounts_one_gbp_binding
  on social_accounts (client_id) where platform = 'google_business' and publish_provider is not null;

comment on column social_accounts.publish_page_id is
  'The exact destination the binding pins: a Facebook Page id, or a Business Profile location resource (locations/<id>). Always equal to external_account_id.';

-- ── 2. Binding ───────────────────────────────────────────────────────────────
-- Re-verification and binding of a Facebook Page or a Business Profile
-- location row (same rules as 20261010224407; Facebook unchanged).
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
  if exists (select 1 from social_accounts where publish_provider = 'zernio' and publish_account_id = p_account_id
             and id <> a.id) then
    raise exception 'That Zernio account is already bound to another Compass account' using errcode = 'unique_violation';
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

-- Binds a client's Business Profile location to the Zernio googlebusiness
-- account the publisher just verified. The location row is the client's
-- social_accounts row for google_business with external_account_id =
-- `locations/<id>`; it is created here when the client has none (no other
-- path creates one). A client already bound to a different location must be
-- unbound by a team admin first. Never enables.
create or replace function publisher_bind_gbp_location(
  p_client_id uuid, p_account_id text, p_location_id text, p_location_name text, p_account_name text, p_health jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row uuid;
  v_other text;
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
  select external_account_id into v_other from social_accounts
   where client_id = p_client_id and platform = 'google_business' and publish_provider is not null
     and external_account_id is distinct from p_location_id;
  if found then
    raise exception 'This client is already bound to Business Profile location %; a team admin removes that binding first', v_other
      using errcode = 'unique_violation';
  end if;

  select id into v_row from social_accounts
   where client_id = p_client_id and platform = 'google_business' and external_account_id = p_location_id
   for update;
  if not found then
    insert into social_accounts (client_id, platform, external_account_id, display_name, status)
    values (p_client_id, 'google_business', p_location_id, nullif(btrim(coalesce(p_location_name, '')), ''), 'manual_only')
    returning id into v_row;
  end if;
  return publisher_bind_account(v_row, p_account_id, p_location_id, p_account_name, p_health)
    || jsonb_build_object('client_id', p_client_id, 'location_id', p_location_id);
end $$;
revoke execute on function publisher_bind_gbp_location(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function publisher_bind_gbp_location(uuid, text, text, text, text, jsonb) to service_role;

-- ── 3. publisher_runs: the pinned location ──────────────────────────────────
alter table publisher_runs add column target_location_id text;
alter table publisher_runs add constraint publisher_runs_target_location check (
  target_location_id is null or (transport = 'zernio' and target_location_id ~ '^locations/[0-9]{1,30}$'));
comment on column publisher_runs.target_location_id is
  'The Business Profile location (locations/<id>) a Zernio request was pinned to.';

-- ── 4. Verify ────────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('anon', 'public.publisher_bind_gbp_location(uuid, text, text, text, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.publisher_bind_gbp_location(uuid, text, text, text, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.publisher_bind_account(uuid, text, text, text, jsonb)', 'execute') then
    raise exception 'zernio gbp: a binding function is callable over the API';
  end if;
  if exists (select 1 from social_accounts where platform = 'google_business' and publish_enabled) then
    raise exception 'zernio gbp: no Business Profile location may start enabled';
  end if;
end $$;
