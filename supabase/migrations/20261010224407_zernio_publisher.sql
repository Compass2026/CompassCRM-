-- Zernio Social Publisher v1 (Oct 10 2026; docs/zernio-publisher.md).
--
-- Facebook posts that a person approved can be published through Zernio by
-- the existing post-publisher, Lucas Construction first. Additive only:
--
-- 1. An explicit, client-bound publishing binding on social_accounts: the
--    exact Zernio account id and the Facebook Page id it must post to (the
--    row's own external_account_id). The publisher never searches Zernio or
--    picks an account at publish time; it uses this binding or nothing.
--    - Bound only by the publisher's service session (publisher_bind_account),
--      after the function has re-read the account and its Page from Zernio.
--      Binding never enables publishing.
--    - Enabled / disabled / unbound only by a signed-in team admin
--      (publisher_set_account_enabled, publisher_unbind_account).
--    - The worker's SQL cannot write any of it, with or without a flag.
--    - One Compass account per Zernio account; Facebook only; the Page id
--      must equal the row's external_account_id.
-- 2. social_account_publish_events: append-only history of every binding
--    change (team read; written only by those functions).
-- 3. publisher_runs records the transport (google / zernio / manual) and,
--    for Zernio, the Zernio post id, its status, the target account and the
--    idempotency key sent — never a secret or a header. A new outcome,
--    `submitted`: Zernio accepted the post and the platform result is not in
--    yet (the publisher reconciles it from GET /v1/posts/{id}).
-- 4. publisher_post_gate(): the claim's re-check, read without claiming, for
--    the no-write preflight (service session only).
-- 5. A brand asset linked to a post carries its measured hash (0055) onto the
--    link, so the approval snapshot binds the exact image bytes.
--
-- Unchanged: 0045's review gate (only an approved post whose snapshot hash
-- and grounding still hold can start publishing; only the publisher records
-- the result), 0046's switch and pilot list, the Google path.
--
-- Rollback: drop the post_assets_zz_brand_hash trigger, publisher_post_gate,
-- the three binding functions, the guard triggers and their functions,
-- social_account_publish_events, the publisher_runs columns and constraint
-- change, and the social_accounts columns, constraints and index.

-- ── 1. The binding ───────────────────────────────────────────────────────────
alter table social_accounts
  add column publish_provider     text,
  add column publish_account_id   text,
  add column publish_page_id      text,
  add column publish_account_name text,
  add column publish_verified_at  timestamptz,
  add column publish_health       jsonb,
  add column publish_enabled      boolean not null default false,
  add column publish_enabled_by   uuid references team_members(id) on delete set null,
  add column publish_enabled_at   timestamptz;

alter table social_accounts
  add constraint social_accounts_publish_provider check (publish_provider is null or publish_provider = 'zernio'),
  add constraint social_accounts_publish_binding check (
    (publish_provider is null and publish_account_id is null and publish_page_id is null
       and publish_verified_at is null and publish_enabled = false)
    or (publish_provider = 'zernio'
        and platform = 'facebook'
        and publish_account_id ~ '^[0-9a-f]{24}$'
        and publish_page_id ~ '^[0-9]{5,30}$'
        and publish_page_id = external_account_id
        and publish_verified_at is not null)),
  add constraint social_accounts_publish_enabled_by check (publish_enabled = false or publish_enabled_by is not null);

-- One Compass account per Zernio account: a Zernio account can never serve
-- two clients.
create unique index social_accounts_publish_account_key
  on social_accounts (publish_provider, publish_account_id) where publish_account_id is not null;

comment on column social_accounts.publish_account_id is
  'Zernio account id this Facebook Page is published through (bound by the publisher after a read check; never chosen at publish time).';
comment on column social_accounts.publish_enabled is
  'A team admin''s switch for publishing to this account; the publisher''s global switch and pilot list still apply.';

-- Who may change the binding: the publisher's service session inside
-- publisher_bind_account, or a signed-in team admin inside the admin
-- functions. The flag alone is not enough: the worker's SQL is refused even
-- when it sets it.
create or replace function social_accounts_publish_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_flag text := coalesce(current_setting('compass.publish_binding', true), '');
  v_service boolean := session_user = 'authenticator' and current_setting('role', true) = 'service_role';
  v_admin boolean := post_caller_is_human() and is_team_admin();
begin
  if tg_op = 'INSERT' then
    if new.publish_provider is not null or new.publish_account_id is not null or new.publish_page_id is not null
       or new.publish_enabled or new.publish_verified_at is not null or new.publish_health is not null
       or new.publish_enabled_by is not null or new.publish_enabled_at is not null or new.publish_account_name is not null then
      raise exception 'A publishing binding is added only by the publisher after it verifies the account'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (new.publish_provider, new.publish_account_id, new.publish_page_id, new.publish_account_name, new.publish_verified_at,
      new.publish_health, new.publish_enabled, new.publish_enabled_by, new.publish_enabled_at)
     is not distinct from
     (old.publish_provider, old.publish_account_id, old.publish_page_id, old.publish_account_name, old.publish_verified_at,
      old.publish_health, old.publish_enabled, old.publish_enabled_by, old.publish_enabled_at) then
    -- The Page id is part of the binding: a bound row keeps its external id.
    if old.publish_account_id is not null and new.external_account_id is distinct from old.external_account_id then
      raise exception 'Unbind the publishing account before changing the Page id' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if v_flag = 'bind' and v_service then return new; end if;
  if v_flag = 'admin' and v_admin then return new; end if;
  raise exception 'The publishing binding changes only through the publisher or a team admin'
    using errcode = 'insufficient_privilege';
end $$;
revoke execute on function social_accounts_publish_guard() from public, anon, authenticated;

create trigger social_accounts_publish_guard
  before insert or update on social_accounts
  for each row execute function social_accounts_publish_guard();

-- ── 2. History ───────────────────────────────────────────────────────────────
create table social_account_publish_events (
  id                bigint generated always as identity primary key,
  social_account_id uuid not null,
  client_id         uuid not null,
  kind              text not null check (kind in ('bound', 'verified', 'enabled', 'disabled', 'unbound')),
  actor_id          uuid references team_members(id) on delete set null,
  actor_kind        text not null check (actor_kind in ('publisher', 'team')),
  detail            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  foreign key (social_account_id, client_id) references social_accounts (id, client_id) on delete cascade
);
create index social_account_publish_events_account_idx on social_account_publish_events (social_account_id, id);
alter table social_account_publish_events enable row level security;
create policy "team reads publishing binding history" on social_account_publish_events
  for select to authenticated using ((select is_team()));
revoke all on social_account_publish_events from public, anon, authenticated, service_role;
grant select on social_account_publish_events to authenticated, service_role;

create or replace function social_account_publish_events_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from social_accounts where id = old.social_account_id) then
    return old; -- the account itself was deleted (cascade)
  end if;
  raise exception 'Publishing binding history is append-only' using errcode = 'insufficient_privilege';
end $$;
revoke execute on function social_account_publish_events_guard() from public, anon, authenticated;
create trigger social_account_publish_events_guard
  before update or delete on social_account_publish_events
  for each row execute function social_account_publish_events_guard();

-- ── 3. The functions ─────────────────────────────────────────────────────────
-- Binds (or re-verifies) a Facebook account to its Zernio account. Called by
-- the post-publisher's service session after it has read, with the publish
-- key: the account (Facebook, active, enabled for posting), its selected Page
-- (equal to this row's external_account_id) and its health. Never enables
-- publishing; a different Zernio account than the one bound turns it off.
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
  if a.platform <> 'facebook' then
    raise exception 'Only Facebook accounts are published through Zernio in v1' using errcode = 'check_violation';
  end if;
  if coalesce(p_account_id, '') !~ '^[0-9a-f]{24}$' then
    raise exception 'Not a Zernio account id' using errcode = 'check_violation';
  end if;
  if a.external_account_id is null or p_page_id is distinct from a.external_account_id then
    raise exception 'The Zernio account posts to Page %, not this account''s Page %', p_page_id, a.external_account_id
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
    'provider', 'zernio', 'account_id', p_account_id, 'page_id', p_page_id,
    'previous_account_id', a.publish_account_id, 'health', p_health));
  return jsonb_build_object('social_account_id', a.id, 'kind', v_kind, 'account_id', p_account_id, 'page_id', p_page_id,
    'enabled', case when a.publish_account_id = p_account_id then a.publish_enabled else false end);
end $$;
revoke execute on function publisher_bind_account(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function publisher_bind_account(uuid, text, text, text, jsonb) to service_role;

-- A team admin switches publishing to a bound account on or off. The caller
-- names the Zernio account it saw, so a rebinding since the page loaded is
-- refused rather than enabled blind.
create or replace function publisher_set_account_enabled(
  p_social_account_id uuid, p_enabled boolean, p_expected_account_id text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a social_accounts;
  v_actor uuid := task_actor();
begin
  if not (post_caller_is_human() and is_team_admin()) then
    raise exception 'Only a signed-in team admin switches publishing for an account' using errcode = 'insufficient_privilege';
  end if;
  select * into a from social_accounts where id = p_social_account_id for update;
  if not found then raise exception 'No such social account' using errcode = 'no_data_found'; end if;
  if a.publish_account_id is null then
    raise exception 'This account has no verified publishing binding' using errcode = 'check_violation';
  end if;
  if a.publish_account_id is distinct from p_expected_account_id then
    raise exception 'The binding changed since the page loaded; reload and check it' using errcode = 'check_violation';
  end if;
  if a.publish_enabled = p_enabled then
    return jsonb_build_object('social_account_id', a.id, 'enabled', a.publish_enabled, 'changed', false);
  end if;
  perform set_config('compass.publish_binding', 'admin', true);
  update social_accounts set
    publish_enabled = p_enabled,
    publish_enabled_by = case when p_enabled then v_actor else null end,
    publish_enabled_at = case when p_enabled then now() else null end
  where id = a.id;
  perform set_config('compass.publish_binding', '', true);
  insert into social_account_publish_events (social_account_id, client_id, kind, actor_id, actor_kind, detail)
  values (a.id, a.client_id, case when p_enabled then 'enabled' else 'disabled' end, v_actor, 'team',
          jsonb_build_object('account_id', a.publish_account_id));
  return jsonb_build_object('social_account_id', a.id, 'enabled', p_enabled, 'changed', true);
end $$;
revoke execute on function publisher_set_account_enabled(uuid, boolean, text) from public, anon;
grant execute on function publisher_set_account_enabled(uuid, boolean, text) to authenticated;

create or replace function publisher_unbind_account(p_social_account_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a social_accounts;
  v_actor uuid := task_actor();
begin
  if not (post_caller_is_human() and is_team_admin()) then
    raise exception 'Only a signed-in team admin removes a publishing binding' using errcode = 'insufficient_privilege';
  end if;
  select * into a from social_accounts where id = p_social_account_id for update;
  if not found then raise exception 'No such social account' using errcode = 'no_data_found'; end if;
  if a.publish_account_id is null then
    return jsonb_build_object('social_account_id', a.id, 'changed', false);
  end if;
  perform set_config('compass.publish_binding', 'admin', true);
  update social_accounts set
    publish_provider = null, publish_account_id = null, publish_page_id = null, publish_account_name = null,
    publish_verified_at = null, publish_health = null,
    publish_enabled = false, publish_enabled_by = null, publish_enabled_at = null
  where id = a.id;
  perform set_config('compass.publish_binding', '', true);
  insert into social_account_publish_events (social_account_id, client_id, kind, actor_id, actor_kind, detail)
  values (a.id, a.client_id, 'unbound', v_actor, 'team', jsonb_build_object('account_id', a.publish_account_id));
  return jsonb_build_object('social_account_id', a.id, 'changed', true);
end $$;
revoke execute on function publisher_unbind_account(uuid) from public, anon;
grant execute on function publisher_unbind_account(uuid) to authenticated;

-- ── 4. publisher_runs: transport and Zernio execution state ──────────────────
alter table publisher_runs
  add column transport         text not null default 'google',
  add column provider_post_id  text,
  add column provider_status   text,
  add column target_account_id text,
  add column request_key       text,
  add column provider_media_url text;
update publisher_runs set transport = 'manual' where mode = 'reminder';
alter table publisher_runs
  add constraint publisher_runs_transport check (transport in ('google', 'zernio', 'manual')),
  add constraint publisher_runs_provider_post_id check (provider_post_id is null or (transport = 'zernio' and provider_post_id ~ '^[0-9A-Za-z_-]{1,64}$')),
  add constraint publisher_runs_zernio_fields check (transport = 'zernio' or (request_key is null and provider_media_url is null and provider_status is null and target_account_id is null)),
  add constraint publisher_runs_media_url check (provider_media_url is null or provider_media_url ~* '^https://');
alter table publisher_runs drop constraint publisher_runs_outcome_check;
alter table publisher_runs add constraint publisher_runs_outcome_check check (outcome in (
  'published', 'reconciled', 'uncertain', 'ambiguous', 'failed', 'blocked', 'lapsed', 'retry_scheduled',
  'reminder_opened', 'reminder_closed', 'submitted'));
create index publisher_runs_provider_post_idx on publisher_runs (post_id, id) where provider_post_id is not null;

comment on column publisher_runs.provider_media_url is
  'The public media URL Zernio gave for the upload this request carried (not a secret; kept so a re-send with the same Idempotency-Key carries the identical body).';

-- ── 5. The publisher's read of a post's gate ─────────────────────────────────
-- What the claim would re-check, without claiming: whether the approval
-- fingerprint still holds and what grounding problems there are. Used by the
-- no-write preflight. Service session only.
create or replace function publisher_post_gate(p_post_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  p social_posts;
begin
  if not (session_user = 'authenticator' and current_setting('role', true) = 'service_role') then
    raise exception 'Only the publisher reads a post''s gate' using errcode = 'insufficient_privilege';
  end if;
  select * into p from social_posts where id = p_post_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'review_status', p.review_status, 'publish_status', p.publish_status,
    'hash_ok', p.approved_hash is not null and social_post_hash(social_post_snapshot(p)) = p.approved_hash,
    'grounding_problems', to_jsonb(social_post_grounding_problems(p)));
end $$;
revoke execute on function publisher_post_gate(uuid) from public, anon, authenticated;
grant execute on function publisher_post_gate(uuid) to service_role;

-- ── 6. A brand image carries its hash onto the post ──────────────────────────
-- A brand asset linked to a post records the asset's measured hash (0055) on
-- the link, so the approval snapshot binds the exact bytes and the publisher
-- can check them before it uploads. Links made before this keep a null hash;
-- the publisher refuses such an image for Facebook rather than guessing.
create or replace function post_assets_brand_hash() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.brand_asset_id is not null and new.content_hash is null then
    select content_hash into new.content_hash from brand_assets where id = new.brand_asset_id;
  end if;
  return new;
end $$;
revoke execute on function post_assets_brand_hash() from public, anon, authenticated;
create trigger post_assets_zz_brand_hash before insert on post_assets
  for each row execute function post_assets_brand_hash();

-- ── 7. Verify ────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_policies where tablename = 'social_account_publish_events'
             and coalesce(qual, '') not ilike '%is_team()%') then
    raise exception 'zernio publisher: a history policy does not read is_team()';
  end if;
  if has_table_privilege('anon', 'social_account_publish_events', 'select')
     or has_table_privilege('authenticated', 'social_account_publish_events', 'insert')
     or has_table_privilege('service_role', 'social_account_publish_events', 'insert') then
    raise exception 'zernio publisher: grants on social_account_publish_events are wider than intended';
  end if;
  if has_function_privilege('anon', 'public.publisher_bind_account(uuid, text, text, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.publisher_bind_account(uuid, text, text, text, jsonb)', 'execute') then
    raise exception 'zernio publisher: publisher_bind_account is callable over the API';
  end if;
  if has_function_privilege('anon', 'public.publisher_set_account_enabled(uuid, boolean, text)', 'execute')
     or has_function_privilege('anon', 'public.publisher_unbind_account(uuid)', 'execute') then
    raise exception 'zernio publisher: the admin functions are callable by anon';
  end if;
  if has_function_privilege('authenticated', 'public.publisher_post_gate(uuid)', 'execute') then
    raise exception 'zernio publisher: publisher_post_gate is callable by a signed-in user';
  end if;
  if exists (select 1 from social_accounts where publish_enabled) then
    raise exception 'zernio publisher: no account may start enabled';
  end if;
end $$;
