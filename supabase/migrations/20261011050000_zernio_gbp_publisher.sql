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
-- 4. publisher_client_transports: each client's Business Profile transport
--    (google / zernio) as an explicit, durable choice, with an append-only
--    history. Binding a location selects zernio; removing the binding does
--    NOT change it, so a client switched to Zernio never falls back to the
--    direct Google path by accident. Only a signed-in team admin returns a
--    client to google (publisher_set_gbp_transport), and only once no
--    location is bound.
--
-- Transport selection (enforced by the publisher, docs/zernio-publisher.md):
-- a Business Profile post whose approved snapshot names the client's
-- location, or whose client's transport is zernio, goes through Zernio only;
-- such a post is never sent directly to Google. The approval binds the
-- destination (social_post_snapshot includes social_account_id), so naming
-- the location on an already approved post means reopening and approving it
-- again: nothing here rewrites an approval.
--
-- Unchanged: 0045's review gate, 0046's switch and pilot list, the Facebook
-- binding rules, the guard trigger and the binding history.
--
-- Rollback: drop publisher_set_gbp_transport, publisher_client_transport_events,
-- publisher_client_transports and their guard functions,
-- publisher_bind_gbp_location, the publisher_runs column and its check, the
-- one-location index; restore the Facebook-only binding check
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

-- ── 1b. The client's Business Profile transport ─────────────────────────────
create table publisher_client_transports (
  client_id       uuid primary key references clients(id) on delete cascade,
  gbp_transport   text not null check (gbp_transport in ('google', 'zernio')),
  changed_at      timestamptz not null default now(),
  changed_by      uuid references team_members(id) on delete set null,
  changed_by_kind text not null check (changed_by_kind in ('publisher', 'team'))
);
alter table publisher_client_transports enable row level security;
create policy "team reads publisher transports" on publisher_client_transports
  for select to authenticated using ((select is_team()));
revoke all on publisher_client_transports from public, anon, authenticated, service_role;
grant select on publisher_client_transports to authenticated, service_role;
comment on table publisher_client_transports is
  'Each client''s Business Profile transport, chosen explicitly: zernio once a location is bound (and kept after an unbind), google again only by a team admin. No row = google.';

create table publisher_client_transport_events (
  id             bigint generated always as identity primary key,
  client_id      uuid not null references clients(id) on delete cascade,
  from_transport text,
  to_transport   text not null check (to_transport in ('google', 'zernio')),
  actor_id       uuid references team_members(id) on delete set null,
  actor_kind     text not null check (actor_kind in ('publisher', 'team')),
  created_at     timestamptz not null default now()
);
create index publisher_client_transport_events_client_idx on publisher_client_transport_events (client_id, id);
alter table publisher_client_transport_events enable row level security;
create policy "team reads publisher transport history" on publisher_client_transport_events
  for select to authenticated using ((select is_team()));
revoke all on publisher_client_transport_events from public, anon, authenticated, service_role;
grant select on publisher_client_transport_events to authenticated, service_role;

-- Who may change a transport: the publisher's service session (binding) or a
-- signed-in team admin, each inside its function. The worker's SQL is refused
-- even with the flag set.
create or replace function publisher_client_transports_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_flag text := coalesce(current_setting('compass.publish_transport', true), '');
  v_service boolean := session_user = 'authenticator' and current_setting('role', true) = 'service_role';
begin
  if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then
    return old; -- the client itself was deleted (cascade)
  end if;
  if tg_op <> 'DELETE' and ((v_flag = 'bind' and v_service) or (v_flag = 'admin' and post_caller_is_human() and is_team_admin())) then
    return new;
  end if;
  raise exception 'A client''s Business Profile transport changes only through the publisher or a team admin'
    using errcode = 'insufficient_privilege';
end $$;
revoke execute on function publisher_client_transports_guard() from public, anon, authenticated;
create trigger publisher_client_transports_guard
  before insert or update or delete on publisher_client_transports
  for each row execute function publisher_client_transports_guard();

create or replace function publisher_client_transport_events_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then
    return old;
  end if;
  if tg_op = 'INSERT' and (
       (current_setting('compass.publish_transport', true) = 'bind' and session_user = 'authenticator' and current_setting('role', true) = 'service_role')
    or (current_setting('compass.publish_transport', true) = 'admin' and post_caller_is_human() and is_team_admin())) then
    return new;
  end if;
  raise exception 'Publisher transport history is append-only' using errcode = 'insufficient_privilege';
end $$;
revoke execute on function publisher_client_transport_events_guard() from public, anon, authenticated;
create trigger publisher_client_transport_events_guard
  before insert or update or delete on publisher_client_transport_events
  for each row execute function publisher_client_transport_events_guard();

-- Records a transport change and its history row. Internal: called by the
-- binding and the admin function, whose guards decide who may.
create or replace function publisher_record_gbp_transport(p_client_id uuid, p_transport text, p_kind text, p_flag text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_from text;
  v_actor uuid := case when p_kind = 'team' then task_actor() end;
begin
  select gbp_transport into v_from from publisher_client_transports where client_id = p_client_id for update;
  if v_from is not distinct from p_transport then return false; end if;
  perform set_config('compass.publish_transport', p_flag, true);
  insert into publisher_client_transports (client_id, gbp_transport, changed_at, changed_by, changed_by_kind)
  values (p_client_id, p_transport, now(), v_actor, p_kind)
  on conflict (client_id) do update set gbp_transport = excluded.gbp_transport, changed_at = excluded.changed_at,
    changed_by = excluded.changed_by, changed_by_kind = excluded.changed_by_kind;
  insert into publisher_client_transport_events (client_id, from_transport, to_transport, actor_id, actor_kind)
  values (p_client_id, coalesce(v_from, 'google'), p_transport, v_actor, p_kind);
  perform set_config('compass.publish_transport', '', true);
  return true;
end $$;
revoke execute on function publisher_record_gbp_transport(uuid, text, text, text) from public, anon, authenticated, service_role;

-- A team admin sets a client's Business Profile transport. Returning to the
-- direct Google path needs the location binding removed first, so a client
-- is never half on each.
create or replace function publisher_set_gbp_transport(p_client_id uuid, p_transport text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_changed boolean;
begin
  if not (post_caller_is_human() and is_team_admin()) then
    raise exception 'Only a signed-in team admin changes a client''s Business Profile transport' using errcode = 'insufficient_privilege';
  end if;
  if p_transport not in ('google', 'zernio') then
    raise exception 'The transport is google or zernio' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from clients where id = p_client_id) then
    raise exception 'No such client' using errcode = 'no_data_found';
  end if;
  if p_transport = 'google' and exists (select 1 from social_accounts where client_id = p_client_id
                                          and platform = 'google_business' and publish_provider is not null) then
    raise exception 'Remove the client''s Zernio location binding before returning it to the direct Google path'
      using errcode = 'check_violation';
  end if;
  v_changed := publisher_record_gbp_transport(p_client_id, p_transport, 'team', 'admin');
  return jsonb_build_object('client_id', p_client_id, 'gbp_transport', p_transport, 'changed', v_changed);
end $$;
revoke execute on function publisher_set_gbp_transport(uuid, text) from public, anon;
grant execute on function publisher_set_gbp_transport(uuid, text) to authenticated;

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
  -- Binding a location is the explicit choice of Zernio for this client's
  -- Business Profile posts; it outlives the binding.
  perform publisher_record_gbp_transport(p_client_id, 'zernio', 'publisher', 'bind');
  return publisher_bind_account(v_row, p_account_id, p_location_id, p_account_name, p_health)
    || jsonb_build_object('client_id', p_client_id, 'location_id', p_location_id, 'gbp_transport', 'zernio');
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
  if has_function_privilege('authenticated', 'public.publisher_record_gbp_transport(uuid, text, text, text)', 'execute')
     or has_function_privilege('service_role', 'public.publisher_record_gbp_transport(uuid, text, text, text)', 'execute')
     or has_function_privilege('anon', 'public.publisher_set_gbp_transport(uuid, text)', 'execute') then
    raise exception 'zernio gbp: a transport function is callable wider than intended';
  end if;
  if has_table_privilege('authenticated', 'publisher_client_transports', 'insert,update,delete')
     or has_table_privilege('service_role', 'publisher_client_transports', 'insert,update,delete')
     or has_table_privilege('anon', 'publisher_client_transports', 'select') then
    raise exception 'zernio gbp: grants on publisher_client_transports are wider than intended';
  end if;
end $$;
