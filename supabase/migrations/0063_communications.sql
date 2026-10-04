-- 0063 — Compass Communications, Phase 1 (Oct 2 2026; issue #88): Twilio
-- SMS for a client, piloted with BHG Safety Partners. Database only; enables
-- nothing for any client and stores no credential.
--
-- Shape (docs/communications.md):
--
--   Compass's parent Twilio account (Main API Key, Vault)
--     └ one subaccount per client ............ communication_accounts
--         ├ Messaging Service(s) .............. communication_messaging_services
--         ├ phone numbers ..................... communication_numbers
--         └ compliance: secondary customer profile + toll-free verification
--                                               communication_compliance_profiles
--                                               communication_compliance_items
--   The client's own customers ................ contacts
--   Consent to be texted (current + history) .. communication_consents
--                                               communication_consent_events
--   Threads and messages ...................... communication_conversations
--                                               communication_messages
--   Per-client switch (no row = off) .......... client_communication_settings
--
-- contacts are the CLIENT'S customers (people BHG texts). client_contacts
-- (0001) stays what it is: Compass's own contacts at the client.
--
-- Credentials. Nothing here holds one. Vault holds the parent account's Main
-- API Key (TWILIO_ACCOUNT_SID / TWILIO_API_KEY / TWILIO_API_SECRET) and, per
-- subaccount, its own Standard API Key and its Auth Token (the token signs
-- that subaccount's webhooks), under names derived from the subaccount SID:
-- TWILIO_SUB_<AccountSid>_API_KEY / _API_SECRET / _AUTH_TOKEN. Only the
-- communications Edge Functions read them, through get_secret().
-- No EIN or other tax identifier has a column anywhere in this migration: a
-- registration that needs one is submitted to Twilio directly.
--
-- Who writes what (communication_caller()):
--   service   the communications / twilio-webhook Edge Functions
--             (authenticator + service_role), through the functions below
--   team      a signed-in teammate through PostgREST
--   owner     postgres: the worker and data scripts (BHG's pilot setup)
--   superuser the sandbox's fixtures
-- Messages, conversations, consents and the Twilio registry (accounts,
-- Messaging Services, numbers) are written ONLY inside the functions below:
-- no direct DML for anyone, the worker's SQL included (a guard trigger, as
-- 0047 does for drafted posts). The worker cannot send, fabricate a message
-- or grant consent. Settings, compliance details and the checklist are a
-- teammate's (the owner may create them for a data script, but never turns
-- outbound sending on). Contacts are a teammate's and the inbound path's.
--
-- Tenancy. Every row carries client_id; every child references its parent by
-- (id, client_id), so a message cannot sit in another client's conversation,
-- a conversation cannot use another client's number, and so on. RLS is the
-- 0036 team policy on every table; nothing is granted to anon and no portal
-- view references any of it (a portal contact reaches none of it).
--
-- Consent. A phone number is not consent. Outbound needs a 'granted' consent
-- row for the recipient (communication_begin_outbound, under a row lock); a
-- STOP from the recipient (Twilio's OptOutType, or the standard keywords) or
-- Twilio's 21610 refusal marks every consent of that number opted_out, which
-- a teammate cannot overwrite (the recipient texts START). History is
-- append-only in communication_consent_events.
--
-- Webhook safety. Inbound messages are idempotent on the Twilio MessageSid
-- (a retry returns the first record); delivery status only moves forward
-- (communication_status_rank), because Twilio's callbacks arrive out of order.
--
-- Rollback: drop the functions below, then drop table communication_messages,
-- communication_conversations, communication_consent_events,
-- communication_consents, contacts, communication_compliance_items,
-- communication_compliance_profiles, communication_numbers,
-- communication_messaging_services, communication_accounts,
-- client_communication_settings.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public'
             and table_name in ('contacts', 'client_communication_settings', 'communication_accounts',
               'communication_messaging_services', 'communication_numbers', 'communication_compliance_profiles',
               'communication_compliance_items', 'communication_consents', 'communication_consent_events',
               'communication_conversations', 'communication_messages')) then
    raise exception '0063: a communications table already exists';
  end if;
end $$;

-- ── 1. Who is calling ───────────────────────────────────────────────────────
create function communication_caller() returns text
language sql stable security definer set search_path = public, pg_catalog as $$
  select case
    when coalesce((select rolsuper from pg_roles where rolname = session_user), false) then 'superuser'
    when session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'service_role' then 'service'
    when session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'authenticated' and is_team() then 'team'
    when session_user = 'postgres' then 'owner'
    else 'other'
  end
$$;
revoke all on function communication_caller() from public, anon, authenticated, service_role;
comment on function communication_caller() is
  'service (a communications Edge Function), team (a signed-in teammate through PostgREST), owner (postgres: worker, data scripts), superuser (sandbox fixtures) or other (0063).';

-- Set by the write functions for the length of their own work; the guards
-- accept a function-only write only with it on AND a service / team caller,
-- so the worker's SQL cannot borrow it.
create function communication_in_write() returns boolean
language sql stable set search_path = public, pg_catalog as $$
  select coalesce(current_setting('compass.communications_write', true), '') = 'on'
     and communication_caller() in ('service', 'team')
$$;
revoke all on function communication_in_write() from public, anon, authenticated, service_role;

create function communication_status_rank(p text) returns int
language sql immutable set search_path = pg_catalog as $$
  select case p
    when 'pending' then 0
    when 'accepted' then 1 when 'scheduled' then 1
    when 'queued' then 2
    when 'sending' then 3
    when 'sent' then 4 when 'receiving' then 4
    when 'received' then 5
    when 'delivered' then 6 when 'undelivered' then 6 when 'failed' then 6
    when 'canceled' then 6 when 'partially_delivered' then 6
    when 'read' then 7
    else -1
  end
$$;
comment on function communication_status_rank(text) is
  'Order of Twilio message statuses (plus Compass''s pending: created, not yet accepted by Twilio). A message status only moves to a higher rank; equal-rank finals keep the first (0063).';
revoke all on function communication_status_rank(text) from public, anon;
grant execute on function communication_status_rank(text) to authenticated, service_role;

-- ── 2. Tables ───────────────────────────────────────────────────────────────
create table client_communication_settings (
  client_id uuid primary key references clients(id) on delete cascade,
  enabled boolean not null default false,
  outbound_enabled boolean not null default false,
  display_name text,
  notes text,
  updated_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_communication_settings_outbound_needs_enabled check (not outbound_enabled or enabled)
);
comment on table client_communication_settings is
  'Communications per client. No row = off. enabled: the module is on (numbers, inbox); outbound_enabled: teammates may send. Only a signed-in teammate turns outbound on (0063).';

create table communication_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  provider text not null default 'twilio' check (provider in ('twilio')),
  provider_account_sid text not null unique check (provider_account_sid ~ '^AC[0-9a-f]{32}$'),
  friendly_name text,
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, provider),
  unique (id, client_id)
);
comment on table communication_accounts is
  'The client''s own Twilio subaccount under Compass''s parent account. Its API Key and Auth Token are in Vault (TWILIO_SUB_<sid>_*), never here (0063).';

create table communication_messaging_services (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  communication_account_id uuid not null,
  provider text not null default 'twilio' check (provider in ('twilio')),
  provider_service_sid text not null unique check (provider_service_sid ~ '^MG[0-9a-f]{32}$'),
  friendly_name text not null,
  use_case text not null default 'customer_care',
  opt_out_mode text not null default 'twilio_default' check (opt_out_mode in ('twilio_default', 'advanced')),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id),
  foreign key (communication_account_id, client_id) references communication_accounts (id, client_id)
);
comment on table communication_messaging_services is
  'A Twilio Messaging Service in the client''s subaccount: one per client and use case. opt_out_mode records how STOP / HELP replies are handled (Twilio''s, never Compass''s) (0063).';

create table communication_numbers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  communication_account_id uuid not null,
  messaging_service_id uuid,
  provider text not null default 'twilio' check (provider in ('twilio')),
  provider_phone_number_sid text not null unique check (provider_phone_number_sid ~ '^PN[0-9a-f]{32}$'),
  phone_number_e164 text not null unique check (phone_number_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  friendly_name text,
  number_type text not null default 'toll_free' check (number_type in ('toll_free', 'local', 'mobile')),
  voice_enabled boolean not null default false,
  sms_enabled boolean not null default false,
  mms_enabled boolean not null default false,
  is_primary boolean not null default false,
  status text not null default 'active' check (status in ('active', 'released')),
  purchased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id),
  foreign key (communication_account_id, client_id) references communication_accounts (id, client_id),
  foreign key (messaging_service_id, client_id) references communication_messaging_services (id, client_id)
    on delete set null (messaging_service_id)
);
create unique index communication_numbers_one_primary on communication_numbers (client_id)
  where is_primary and status = 'active';
comment on table communication_numbers is
  'A phone number in the client''s subaccount. Its toll-free verification is a communication_compliance_profiles row (profile_type toll_free_verification) (0063).';

create table communication_compliance_profiles (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  communication_account_id uuid,
  communication_number_id uuid,
  provider text not null default 'twilio' check (provider in ('twilio')),
  profile_type text not null check (profile_type in ('secondary_customer_profile', 'toll_free_verification')),
  provider_profile_sid text unique,
  -- Twilio's own status string, verbatim, and its clean mapping.
  provider_status text,
  status text not null default 'draft'
    check (status in ('draft', 'pending_review', 'in_review', 'approved', 'rejected')),
  -- A teammate's call, not Twilio's: Twilio has no such verification state.
  restriction text check (restriction in ('restricted', 'blocked')),
  restriction_reason text,
  restricted_by uuid references team_members(id) on delete set null,
  restricted_at timestamptz,
  -- Business identity (secondary customer profile; repeated on a TFV).
  legal_business_name text,
  doing_business_as text,
  website_url text,
  address_street text,
  address_city text,
  address_region text,
  address_postal_code text,
  address_country text default 'US',
  business_contact_name text,
  business_contact_email text,
  business_contact_phone text,
  notification_email text,
  -- The messaging program (toll-free verification).
  use_case_categories text[] not null default '{}',
  use_case_summary text,
  sample_messages text[] not null default '{}',
  message_volume text,
  opt_in_type text check (opt_in_type in ('WEB_FORM', 'VERBAL', 'PAPER_FORM', 'VIA_TEXT', 'MOBILE_QR_CODE', 'IMPORT')),
  opt_in_url text,
  opt_in_image_urls text[] not null default '{}',
  privacy_url text,
  terms_url text,
  -- From Twilio, by sync only.
  submitted_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  rejection_code text,
  rejection_reason text,
  edit_allowed boolean,
  last_synced_at timestamptz,
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id),
  foreign key (communication_account_id, client_id) references communication_accounts (id, client_id),
  foreign key (communication_number_id, client_id) references communication_numbers (id, client_id),
  constraint communication_compliance_profiles_sid_shape check (
    provider_profile_sid is null
    or (profile_type = 'secondary_customer_profile' and provider_profile_sid ~ '^BU[0-9a-f]{32}$')
    or (profile_type = 'toll_free_verification' and provider_profile_sid ~ '^HH[0-9a-f]{32}$')),
  constraint communication_compliance_profiles_restriction_reason check (
    restriction is null or length(btrim(coalesce(restriction_reason, ''))) > 0),
  constraint communication_compliance_profiles_urls check (
    (website_url is null or website_url ~ '^https?://')
    and (opt_in_url is null or opt_in_url ~ '^https://')
    and (privacy_url is null or privacy_url ~ '^https://')
    and (terms_url is null or terms_url ~ '^https://'))
);
create unique index communication_compliance_one_customer_profile on communication_compliance_profiles (client_id)
  where profile_type = 'secondary_customer_profile';
create unique index communication_compliance_one_tfv_per_number on communication_compliance_profiles (communication_number_id)
  where profile_type = 'toll_free_verification' and communication_number_id is not null;
comment on table communication_compliance_profiles is
  'Twilio compliance registrations: the client''s secondary customer profile (BU…) and each toll-free verification (HH…). Business and program details are a teammate''s; provider_status / status / dates / rejection come only from a sync with Twilio. No tax identifier is stored (0063).';

create table communication_compliance_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  profile_id uuid not null,
  item_key text not null check (item_key ~ '^[a-z0-9_]+$'),
  label text not null,
  sort_order int not null default 0,
  status text not null default 'open' check (status in ('open', 'done', 'not_applicable')),
  evidence text,
  checked_by uuid references team_members(id) on delete set null,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, item_key),
  foreign key (profile_id, client_id) references communication_compliance_profiles (id, client_id) on delete cascade,
  constraint communication_compliance_items_done_evidence check (
    status = 'open' or length(btrim(coalesce(evidence, ''))) > 0)
);
comment on table communication_compliance_items is
  'The pre-submission checklist of a registration (communication_standard_checklist()), one row per item with the evidence and who checked it (0063).';

create table contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  first_name text,
  last_name text,
  company text,
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  notes text,
  source text not null default 'manual' check (source in ('manual', 'inbound_sms', 'import')),
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id),
  constraint contacts_reachable check (phone_e164 is not null or email is not null)
);
create unique index contacts_client_phone on contacts (client_id, phone_e164) where phone_e164 is not null;
comment on table contacts is
  'The client''s own customers and leads (the people the client messages). Not client_contacts, which are Compass''s contacts at the client. Unique by phone per client (0063).';

create table communication_consents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  contact_id uuid,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  consent_type text not null default 'sms_customer_care' check (consent_type in ('sms_customer_care', 'sms_marketing')),
  status text not null check (status in ('granted', 'revoked', 'opted_out')),
  source text not null check (source in ('web_form', 'verbal', 'paper_form', 'inbound_sms', 'keyword_start', 'import', 'other')),
  source_url text,
  disclosure_version text,
  evidence text,
  consented_at timestamptz,
  revoked_at timestamptz,
  recorded_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, phone_e164, consent_type),
  unique (id, client_id),
  foreign key (contact_id, client_id) references contacts (id, client_id) on delete set null (contact_id),
  constraint communication_consents_granted_dated check (status <> 'granted' or consented_at is not null),
  constraint communication_consents_ended_dated check (status = 'granted' or revoked_at is not null)
);
comment on table communication_consents is
  'Consent to be texted, per client, phone and type: the current state. granted needs a date and evidence; opted_out is the recipient''s (STOP / Twilio 21610) and only the recipient lifts it (START). History: communication_consent_events (0063).';

create table communication_consent_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  consent_id uuid not null,
  phone_e164 text not null,
  consent_type text not null,
  from_status text,
  to_status text not null,
  source text not null,
  source_url text,
  disclosure_version text,
  evidence text,
  message_id uuid,
  actor_kind text not null check (actor_kind in ('team', 'recipient', 'provider')),
  actor_id uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (consent_id, client_id) references communication_consents (id, client_id) on delete cascade
);
create index on communication_consent_events (consent_id, created_at);
comment on table communication_consent_events is
  'Append-only history of every consent change, written by trigger inside the consent writes: who (teammate / recipient keyword / provider refusal), from what, to what, with which evidence (0063).';

create table communication_conversations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  contact_id uuid not null,
  communication_number_id uuid not null,
  channel text not null default 'sms' check (channel in ('sms')),
  status text not null default 'open' check (status in ('open', 'closed')),
  last_message_at timestamptz,
  last_message_preview text,
  last_direction text check (last_direction in ('inbound', 'outbound')),
  unread_count int not null default 0 check (unread_count >= 0),
  assigned_user_id uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, contact_id, communication_number_id, channel),
  unique (id, client_id),
  foreign key (contact_id, client_id) references contacts (id, client_id),
  foreign key (communication_number_id, client_id) references communication_numbers (id, client_id)
);
create index on communication_conversations (client_id, last_message_at desc);
comment on table communication_conversations is
  'One thread per client, contact, Compass number and channel; a new inbound message reopens it and adds to unread_count (0063).';

create table communication_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  conversation_id uuid not null,
  provider text not null default 'twilio' check (provider in ('twilio')),
  provider_message_sid text unique check (provider_message_sid ~ '^(SM|MM)[0-9a-f]{32}$'),
  request_id uuid unique,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_e164 text not null check (from_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  to_e164 text not null check (to_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  body text not null default '',
  num_media int not null default 0 check (num_media >= 0),
  provider_status text not null check (communication_status_rank(provider_status) >= 0),
  error_code text,
  error_message text,
  opt_out_type text check (opt_out_type in ('STOP', 'START', 'HELP')),
  sent_by uuid references team_members(id) on delete set null,
  sent_at timestamptz,
  delivered_at timestamptz,
  status_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, client_id) references communication_conversations (id, client_id) on delete cascade,
  constraint communication_messages_inbound_has_sid check (direction = 'outbound' or provider_message_sid is not null),
  constraint communication_messages_outbound_request check (direction = 'inbound' or request_id is not null)
);
create index on communication_messages (conversation_id, created_at);
comment on table communication_messages is
  'Every SMS in or out. Inbound is unique by Twilio MessageSid (a webhook retry is a no-op); outbound by the sender''s request_id (a double click sends once). provider_status is Twilio''s status (pending = not yet accepted by Twilio) and only moves forward (0063).';

-- ── 3. updated_at ───────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['client_communication_settings', 'communication_accounts', 'communication_messaging_services',
    'communication_numbers', 'communication_compliance_profiles', 'communication_compliance_items', 'contacts',
    'communication_consents', 'communication_conversations', 'communication_messages'] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;

-- ── 4. Guards ───────────────────────────────────────────────────────────────
-- Function-only tables: messages, conversations, consents, consent events and
-- the Twilio registry. A client's deletion cascades through them.
create function communication_guard_function_only() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  -- A client's deletion cascades (and sets null) through these tables.
  if tg_op <> 'INSERT' and not exists (select 1 from clients where id = old.client_id) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if communication_in_write() or communication_caller() = 'superuser' then
    if tg_op = 'UPDATE' and new.client_id is distinct from old.client_id then
      raise exception 'communications: a row keeps its client' using errcode = 'check_violation';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'communications: % on % goes through the Communications functions', lower(tg_op), tg_table_name
    using errcode = 'insufficient_privilege';
end $$;
revoke all on function communication_guard_function_only() from public, anon, authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array['communication_accounts', 'communication_messaging_services', 'communication_numbers',
    'communication_consents', 'communication_conversations', 'communication_messages'] loop
    execute format('create trigger %I before insert or update or delete on %I for each row execute function communication_guard_function_only()',
      t || '_guard', t);
  end loop;
end $$;

-- Consent history is append-only: inserted inside a consent write, never changed.
create function communication_consent_events_guard() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then
    return old;
  end if;
  if tg_op = 'INSERT' and (communication_in_write() or communication_caller() = 'superuser') then
    return new;
  end if;
  raise exception 'communications: consent history is append-only' using errcode = 'insufficient_privilege';
end $$;
revoke all on function communication_consent_events_guard() from public, anon, authenticated, service_role;
create trigger communication_consent_events_guard before insert or update or delete on communication_consent_events
  for each row execute function communication_consent_events_guard();

-- Settings: a teammate's. The owner may create a row for a data script but
-- never turns outbound sending on.
create function client_communication_settings_guard() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_caller text := communication_caller();
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id) or v_caller = 'superuser' then return old; end if;
    raise exception 'communications: turn a client''s communications off instead of deleting the setting'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.client_id is distinct from old.client_id then
    raise exception 'communications: a setting keeps its client' using errcode = 'check_violation';
  end if;
  if v_caller = 'team' then
    new.updated_by := task_actor();
    return new;
  end if;
  if v_caller in ('owner', 'superuser') then
    if new.outbound_enabled and (tg_op = 'INSERT' or not old.outbound_enabled) and v_caller = 'owner' then
      raise exception 'communications: only a signed-in Compass teammate turns outbound messaging on'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  raise exception 'communications: only a signed-in Compass teammate changes communications settings'
    using errcode = 'insufficient_privilege';
end $$;
revoke all on function client_communication_settings_guard() from public, anon, authenticated, service_role;
create trigger client_communication_settings_guard before insert or update or delete on client_communication_settings
  for each row execute function client_communication_settings_guard();

-- Compliance registrations: details are a teammate's (or a data script's);
-- Twilio's status, dates and rejection come only from a sync; a restriction
-- is a teammate's call.
create function communication_compliance_profiles_guard() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_caller text := communication_caller();
  v_sync_changed boolean;
  v_restriction_changed boolean;
  v_sid_changed boolean;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id) or v_caller = 'superuser' then return old; end if;
    if v_caller = 'team' and old.provider_profile_sid is null then return old; end if;
    raise exception 'communications: only a teammate deletes a registration, and only one never linked to Twilio'
      using errcode = 'insufficient_privilege';
  end if;
  if v_caller = 'superuser' then return new; end if;

  if tg_op = 'INSERT' then
    if v_caller not in ('team', 'owner') then
      raise exception 'communications: only a teammate (or a data script) creates a compliance registration'
        using errcode = 'insufficient_privilege';
    end if;
    if new.provider_status is not null or new.status <> 'draft' or new.submitted_at is not null or new.approved_at is not null
       or new.rejected_at is not null or new.rejection_code is not null or new.rejection_reason is not null
       or new.edit_allowed is not null or new.last_synced_at is not null then
      raise exception 'communications: Twilio''s status comes from a sync, never from an insert' using errcode = 'check_violation';
    end if;
    if new.restriction is not null and v_caller <> 'team' then
      raise exception 'communications: only a signed-in teammate restricts or blocks messaging' using errcode = 'insufficient_privilege';
    end if;
    if v_caller = 'team' then
      new.created_by := task_actor();
      if new.restriction is not null then new.restricted_by := task_actor(); new.restricted_at := now(); end if;
    end if;
    return new;
  end if;

  if new.client_id is distinct from old.client_id or new.profile_type is distinct from old.profile_type then
    raise exception 'communications: a registration keeps its client and type' using errcode = 'check_violation';
  end if;
  v_sync_changed := (new.provider_status, new.status, new.submitted_at, new.approved_at, new.rejected_at,
                     new.rejection_code, new.rejection_reason, new.edit_allowed, new.last_synced_at)
         is distinct from (old.provider_status, old.status, old.submitted_at, old.approved_at, old.rejected_at,
                     old.rejection_code, old.rejection_reason, old.edit_allowed, old.last_synced_at);
  v_restriction_changed := (new.restriction, new.restriction_reason) is distinct from (old.restriction, old.restriction_reason);
  v_sid_changed := new.provider_profile_sid is distinct from old.provider_profile_sid;

  if communication_in_write() and v_caller = 'service' then
    -- A sync: Twilio's fields only.
    if v_restriction_changed or v_sid_changed
       or (new.legal_business_name, new.doing_business_as, new.website_url, new.privacy_url, new.terms_url, new.opt_in_url,
           new.communication_number_id, new.communication_account_id)
          is distinct from (old.legal_business_name, old.doing_business_as, old.website_url, old.privacy_url, old.terms_url,
           old.opt_in_url, old.communication_number_id, old.communication_account_id) then
      raise exception 'communications: a sync records Twilio''s status only' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if v_caller not in ('team', 'owner') then
    raise exception 'communications: only a teammate changes a compliance registration' using errcode = 'insufficient_privilege';
  end if;
  if v_restriction_changed then
    if v_caller <> 'team' then
      raise exception 'communications: only a signed-in teammate restricts or blocks messaging' using errcode = 'insufficient_privilege';
    end if;
    new.restricted_by := case when new.restriction is null then null else task_actor() end;
    new.restricted_at := case when new.restriction is null then null else now() end;
  end if;
  if v_sid_changed then
    -- Linking (or re-linking) a registration made in the Twilio Console: the
    -- status is unknown until the next sync.
    new.provider_status := null; new.status := 'draft'; new.submitted_at := null; new.approved_at := null;
    new.rejected_at := null; new.rejection_code := null; new.rejection_reason := null;
    new.edit_allowed := null; new.last_synced_at := null;
  elsif v_sync_changed then
    raise exception 'communications: Twilio''s status comes from a sync, never from an edit' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
revoke all on function communication_compliance_profiles_guard() from public, anon, authenticated, service_role;
create trigger communication_compliance_profiles_guard before insert or update or delete on communication_compliance_profiles
  for each row execute function communication_compliance_profiles_guard();

create function communication_compliance_items_guard() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_caller text := communication_caller();
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id)
       or not exists (select 1 from communication_compliance_profiles where id = old.profile_id)
       or v_caller in ('team', 'superuser') then
      return old;
    end if;
    raise exception 'communications: only a teammate removes a checklist item' using errcode = 'insufficient_privilege';
  end if;
  if v_caller = 'superuser' then return new; end if;
  if tg_op = 'INSERT' then
    if v_caller = 'owner' and new.status = 'open' and new.checked_by is null then return new; end if;
    if v_caller <> 'team' then
      raise exception 'communications: only a teammate checks off compliance items' using errcode = 'insufficient_privilege';
    end if;
  else
    if v_caller <> 'team' then
      raise exception 'communications: only a teammate checks off compliance items' using errcode = 'insufficient_privilege';
    end if;
    if (new.client_id, new.profile_id, new.item_key) is distinct from (old.client_id, old.profile_id, old.item_key) then
      raise exception 'communications: a checklist item keeps its registration and key' using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status or new.evidence is distinct from old.evidence then
    new.checked_by := case when new.status = 'open' then null else task_actor() end;
    new.checked_at := case when new.status = 'open' then null else now() end;
  end if;
  return new;
end $$;
revoke all on function communication_compliance_items_guard() from public, anon, authenticated, service_role;
create trigger communication_compliance_items_guard before insert or update or delete on communication_compliance_items
  for each row execute function communication_compliance_items_guard();

-- Contacts: a teammate's, or the inbound path's (inside its function). A
-- contact keeps its client, and its phone once a thread or consent uses it.
create function contacts_guard() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_caller text := communication_caller();
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id) or v_caller = 'superuser' then return old; end if;
    if v_caller <> 'team' then
      raise exception 'communications: only a teammate deletes a contact' using errcode = 'insufficient_privilege';
    end if;
    if exists (select 1 from communication_conversations where contact_id = old.id)
       or exists (select 1 from communication_consents where contact_id = old.id) then
      raise exception 'communications: this contact has messages or consent on record, which are kept as evidence'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if not (v_caller in ('team', 'superuser') or communication_in_write()) then
    raise exception 'communications: only a teammate (or an inbound message) creates or changes a contact'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    if new.client_id is distinct from old.client_id then
      raise exception 'communications: a contact keeps its client' using errcode = 'check_violation';
    end if;
    if new.phone_e164 is distinct from old.phone_e164
       and (exists (select 1 from communication_conversations where contact_id = old.id)
            or exists (select 1 from communication_consents where contact_id = old.id)) then
      raise exception 'communications: this contact''s number has messages or consent on record; add a new contact for the new number'
        using errcode = 'check_violation';
    end if;
  elsif v_caller = 'team' then
    new.created_by := task_actor();
  end if;
  return new;
end $$;
revoke all on function contacts_guard() from public, anon, authenticated, service_role;
create trigger contacts_guard before insert or update or delete on contacts
  for each row execute function contacts_guard();

-- Every consent change writes its history. The writer describes itself in
-- compass.consent_context (actor kind, message id) for the length of its work.
create function communication_consent_log() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_ctx jsonb := coalesce(nullif(current_setting('compass.consent_context', true), '')::jsonb, '{}'::jsonb);
begin
  if tg_op = 'UPDATE' and (new.status, new.source, new.evidence, new.source_url, new.disclosure_version, new.consented_at)
       is not distinct from (old.status, old.source, old.evidence, old.source_url, old.disclosure_version, old.consented_at) then
    return new;
  end if;
  insert into communication_consent_events (client_id, consent_id, phone_e164, consent_type, from_status, to_status,
    source, source_url, disclosure_version, evidence, message_id, actor_kind, actor_id)
  values (new.client_id, new.id, new.phone_e164, new.consent_type,
    case when tg_op = 'UPDATE' then old.status end, new.status,
    coalesce(v_ctx->>'source', new.source), new.source_url, new.disclosure_version,
    coalesce(v_ctx->>'evidence', new.evidence), nullif(v_ctx->>'message_id', '')::uuid,
    coalesce(v_ctx->>'actor_kind', 'team'), case when coalesce(v_ctx->>'actor_kind', 'team') = 'team' then task_actor() end);
  return new;
end $$;
revoke all on function communication_consent_log() from public, anon, authenticated, service_role;
create trigger communication_consent_log after insert or update on communication_consents
  for each row execute function communication_consent_log();

-- ── 5. Write functions ──────────────────────────────────────────────────────
-- Errors carry a short code before the colon ("opted_out: …"); the Edge
-- Functions and the app read it.

-- Marks every consent of a phone (for that client) opted_out; creates the
-- record when there was none, so the opt-out is remembered.
create function communication_opt_out(p_client uuid, p_phone text, p_contact uuid, p_at timestamptz,
                                      p_source text, p_actor text, p_message uuid, p_evidence text)
returns void
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  perform set_config('compass.consent_context',
    jsonb_build_object('actor_kind', p_actor, 'message_id', p_message, 'evidence', p_evidence, 'source', p_source)::text, true);
  update communication_consents
     set status = 'opted_out', revoked_at = p_at, contact_id = coalesce(contact_id, p_contact)
   where client_id = p_client and phone_e164 = p_phone and status <> 'opted_out';
  if not exists (select 1 from communication_consents where client_id = p_client and phone_e164 = p_phone) then
    insert into communication_consents (client_id, contact_id, phone_e164, consent_type, status, source, evidence, revoked_at)
    values (p_client, p_contact, p_phone, 'sms_customer_care', 'opted_out', p_source, p_evidence, p_at);
  end if;
  perform set_config('compass.consent_context', '', true);
end $$;
revoke all on function communication_opt_out(uuid, text, uuid, timestamptz, text, text, uuid, text) from public, anon, authenticated, service_role;

-- Inbound SMS (twilio-webhook, after the signature check). One transaction:
-- contact, conversation, message, unread count and the recipient's STOP /
-- START. Idempotent on the MessageSid.
create function communication_record_inbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_sid text := p->>'message_sid';
  v_to text := p->>'to';
  v_from text := p->>'from';
  v_body text := coalesce(p->>'body', '');
  v_opt text := upper(nullif(btrim(coalesce(p->>'opt_out_type', '')), ''));
  v_at timestamptz := coalesce(nullif(p->>'received_at', '')::timestamptz, now());
  v_num record;
  v_contact uuid;
  v_conv uuid;
  v_msg uuid;
  v_dup record;
begin
  if communication_caller() <> 'service' then
    raise exception 'forbidden: inbound messages are recorded by the twilio-webhook function only' using errcode = 'insufficient_privilege';
  end if;
  if v_sid is null or v_sid !~ '^(SM|MM)[0-9a-f]{32}$' then raise exception 'invalid: MessageSid' using errcode = '22023'; end if;
  if v_to is null or v_to !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'invalid: To' using errcode = '22023'; end if;
  if v_from is null or v_from !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'invalid: From' using errcode = '22023'; end if;
  if v_opt is not null and v_opt not in ('STOP', 'START', 'HELP') then v_opt := null; end if;

  perform pg_advisory_xact_lock(hashtextextended('compass.comm_message:' || v_sid, 0));
  select id, conversation_id, client_id into v_dup from communication_messages where provider_message_sid = v_sid;
  if found then
    return jsonb_build_object('duplicate', true, 'message_id', v_dup.id, 'conversation_id', v_dup.conversation_id, 'client_id', v_dup.client_id);
  end if;

  select n.id, n.client_id into v_num
  from communication_numbers n join communication_accounts a on a.id = n.communication_account_id
  where n.phone_number_e164 = v_to and n.status = 'active' and a.provider_account_sid = p->>'account_sid';
  if not found then
    raise exception 'unknown_number: % is not an active Compass number of that account', v_to using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('compass.comm_contact:' || v_num.client_id::text || v_from, 0));
  perform set_config('compass.communications_write', 'on', true);
  select id into v_contact from contacts where client_id = v_num.client_id and phone_e164 = v_from;
  if not found then
    insert into contacts (client_id, phone_e164, source) values (v_num.client_id, v_from, 'inbound_sms')
    returning id into v_contact;
  end if;

  insert into communication_conversations (client_id, contact_id, communication_number_id, channel, status,
    last_message_at, last_message_preview, last_direction, unread_count)
  values (v_num.client_id, v_contact, v_num.id, 'sms', 'open', v_at, left(v_body, 160), 'inbound', 1)
  on conflict (client_id, contact_id, communication_number_id, channel) do update
    set status = 'open',
        unread_count = communication_conversations.unread_count + 1,
        last_message_at = greatest(communication_conversations.last_message_at, excluded.last_message_at),
        last_message_preview = case when communication_conversations.last_message_at is null
                                      or excluded.last_message_at >= communication_conversations.last_message_at
                                    then excluded.last_message_preview else communication_conversations.last_message_preview end,
        last_direction = case when communication_conversations.last_message_at is null
                                or excluded.last_message_at >= communication_conversations.last_message_at
                              then 'inbound' else communication_conversations.last_direction end
  returning id into v_conv;

  insert into communication_messages (client_id, conversation_id, provider, provider_message_sid, direction,
    from_e164, to_e164, body, num_media, provider_status, opt_out_type, sent_at, status_updated_at)
  values (v_num.client_id, v_conv, 'twilio', v_sid, 'inbound', v_from, v_to, v_body,
    greatest(coalesce(nullif(p->>'num_media', '')::int, 0), 0), 'received', v_opt, v_at, now())
  returning id into v_msg;

  if v_opt = 'STOP' then
    perform communication_opt_out(v_num.client_id, v_from, v_contact, v_at, 'inbound_sms', 'recipient', v_msg,
      'Recipient texted an opt-out keyword (' || coalesce(nullif(p->>'opt_out_via', ''), 'twilio') || ')');
  elsif v_opt = 'START' then
    -- START is the recipient's own opt-in keyword (Twilio re-subscribes them):
    -- every opted-out consent of the number becomes granted, sourced to the
    -- keyword and the message. A teammate's revocation stays as it is.
    perform set_config('compass.consent_context', jsonb_build_object('actor_kind', 'recipient', 'message_id', v_msg,
      'evidence', 'Recipient texted START', 'source', 'keyword_start')::text, true);
    update communication_consents
       set status = 'granted', source = 'keyword_start', revoked_at = null,
           consented_at = v_at, evidence = 'Recipient texted START (message ' || v_sid || ')',
           contact_id = coalesce(contact_id, v_contact)
     where client_id = v_num.client_id and phone_e164 = v_from and status = 'opted_out';
    perform set_config('compass.consent_context', '', true);
  end if;
  perform set_config('compass.communications_write', '', true);

  return jsonb_build_object('duplicate', false, 'message_id', v_msg, 'conversation_id', v_conv,
    'contact_id', v_contact, 'client_id', v_num.client_id, 'opt_out_type', v_opt);
end $$;
revoke all on function communication_record_inbound(jsonb) from public, anon, authenticated;
grant execute on function communication_record_inbound(jsonb) to service_role;

-- Outbound, step 1 (communications function, for a teammate it has checked):
-- every rule, then the message row as 'pending'. Idempotent on request_id.
-- Twilio is called only after this returns.
create function communication_begin_outbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_request uuid := nullif(p->>'request_id', '')::uuid;
  v_client uuid := nullif(p->>'client_id', '')::uuid;
  v_conv_id uuid := nullif(p->>'conversation_id', '')::uuid;
  v_contact_id uuid := nullif(p->>'contact_id', '')::uuid;
  v_number_id uuid := nullif(p->>'number_id', '')::uuid;
  v_body text := btrim(coalesce(p->>'body', ''));
  v_sender uuid := nullif(p->>'sent_by', '')::uuid;
  v_dup record;
  v_settings record;
  v_contact record;
  v_num record;
  v_consent text;
  v_conv uuid;
  v_msg uuid;
begin
  if communication_caller() <> 'service' then
    raise exception 'forbidden: messages are sent through the communications function only' using errcode = 'insufficient_privilege';
  end if;
  if v_request is null or v_client is null then raise exception 'invalid: request_id and client_id are required' using errcode = '22023'; end if;
  if not exists (select 1 from team_members where id = v_sender) then
    raise exception 'forbidden: the sender is not a Compass teammate' using errcode = 'insufficient_privilege';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('compass.comm_request:' || v_request::text, 0));
  select m.id, m.conversation_id, m.client_id, m.provider_status, m.provider_message_sid, m.to_e164, m.from_e164
    into v_dup from communication_messages m where m.request_id = v_request;
  if found then
    if v_dup.client_id <> v_client then raise exception 'invalid: request_id belongs to another client' using errcode = '22023'; end if;
    return jsonb_build_object('duplicate', true, 'message_id', v_dup.id, 'conversation_id', v_dup.conversation_id,
      'provider_status', v_dup.provider_status, 'provider_message_sid', v_dup.provider_message_sid);
  end if;

  if length(v_body) = 0 then raise exception 'empty: the message is empty' using errcode = '22023'; end if;
  if length(v_body) > 1600 then raise exception 'too_long: a message is at most 1,600 characters' using errcode = '22023'; end if;

  select enabled, outbound_enabled into v_settings from client_communication_settings where client_id = v_client;
  if not found or not v_settings.enabled then
    raise exception 'not_enabled: communications are not enabled for this client' using errcode = 'P0001';
  end if;
  if not v_settings.outbound_enabled then
    raise exception 'outbound_disabled: sending is turned off for this client' using errcode = 'P0001';
  end if;

  if v_conv_id is not null then
    select contact_id, communication_number_id into v_contact_id, v_number_id
    from communication_conversations where id = v_conv_id and client_id = v_client;
    if not found then raise exception 'not_found: no such conversation for this client' using errcode = 'P0002'; end if;
  end if;
  if v_number_id is null then
    select id into v_number_id from communication_numbers where client_id = v_client and is_primary and status = 'active';
  end if;

  select id, phone_e164 into v_contact from contacts where id = v_contact_id and client_id = v_client;
  if not found then raise exception 'not_found: no such contact for this client' using errcode = 'P0002'; end if;
  if v_contact.phone_e164 is null then raise exception 'no_phone: the contact has no mobile number' using errcode = 'P0001'; end if;

  select n.id, n.phone_number_e164, n.sms_enabled, n.status, s.provider_service_sid, s.status as service_status, a.provider_account_sid
    into v_num
  from communication_numbers n
  join communication_accounts a on a.id = n.communication_account_id
  left join communication_messaging_services s on s.id = n.messaging_service_id
  where n.id = v_number_id and n.client_id = v_client;
  if not found then raise exception 'no_number: this client has no Compass number to send from' using errcode = 'P0001'; end if;
  if v_num.status <> 'active' or not v_num.sms_enabled then
    raise exception 'no_number: % cannot send SMS', v_num.phone_number_e164 using errcode = 'P0001';
  end if;
  if v_num.provider_service_sid is null or v_num.service_status <> 'active' then
    raise exception 'no_messaging_service: % is not in an active Messaging Service', v_num.phone_number_e164 using errcode = 'P0001';
  end if;

  -- Consent, locked so a STOP arriving now waits for this decision or wins it.
  select status into v_consent from communication_consents
   where client_id = v_client and phone_e164 = v_contact.phone_e164 and status = 'opted_out' limit 1 for update;
  if found then
    raise exception 'opted_out: % opted out of messages from this business', v_contact.phone_e164 using errcode = 'P0001';
  end if;
  select status into v_consent from communication_consents
   where client_id = v_client and phone_e164 = v_contact.phone_e164 and consent_type = 'sms_customer_care' for update;
  if not found then
    raise exception 'no_consent: there is no SMS consent on record for %', v_contact.phone_e164 using errcode = 'P0001';
  end if;
  if v_consent <> 'granted' then
    raise exception 'no_consent: SMS consent for % is %', v_contact.phone_e164, v_consent using errcode = 'P0001';
  end if;

  perform set_config('compass.communications_write', 'on', true);
  insert into communication_conversations (client_id, contact_id, communication_number_id, channel, status,
    last_message_at, last_message_preview, last_direction, unread_count)
  values (v_client, v_contact.id, v_num.id, 'sms', 'open', now(), left(v_body, 160), 'outbound', 0)
  on conflict (client_id, contact_id, communication_number_id, channel) do update
    set status = 'open', last_message_at = now(), last_message_preview = excluded.last_message_preview, last_direction = 'outbound'
  returning id into v_conv;

  insert into communication_messages (client_id, conversation_id, provider, request_id, direction, from_e164, to_e164,
    body, provider_status, sent_by, status_updated_at)
  values (v_client, v_conv, 'twilio', v_request, 'outbound', v_num.phone_number_e164, v_contact.phone_e164,
    v_body, 'pending', v_sender, now())
  returning id into v_msg;
  perform set_config('compass.communications_write', '', true);

  return jsonb_build_object('duplicate', false, 'message_id', v_msg, 'conversation_id', v_conv,
    'to', v_contact.phone_e164, 'from', v_num.phone_number_e164,
    'messaging_service_sid', v_num.provider_service_sid, 'account_sid', v_num.provider_account_sid, 'body', v_body);
end $$;
revoke all on function communication_begin_outbound(jsonb) from public, anon, authenticated;
grant execute on function communication_begin_outbound(jsonb) to service_role;

-- Applies a status to one message: forward only; the first final wins.
create function communication_apply_status(p_msg uuid, p_status text, p_error_code text, p_error_message text, p_at timestamptz)
returns text
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v record;
begin
  select m.*, c.contact_id into v from communication_messages m
  join communication_conversations c on c.id = m.conversation_id where m.id = p_msg for update of m;
  if communication_status_rank(p_status) < 0 then
    raise exception 'invalid: unknown message status %', p_status using errcode = '22023';
  end if;
  if communication_status_rank(p_status) <= communication_status_rank(v.provider_status) then
    return 'unchanged';
  end if;
  perform set_config('compass.communications_write', 'on', true);
  update communication_messages
     set provider_status = p_status,
         error_code = coalesce(nullif(p_error_code, ''), error_code),
         error_message = coalesce(nullif(p_error_message, ''), error_message),
         sent_at = case when p_status in ('sent', 'delivered', 'undelivered', 'read') then coalesce(sent_at, p_at) else sent_at end,
         delivered_at = case when p_status in ('delivered', 'read') then coalesce(delivered_at, p_at) else delivered_at end,
         status_updated_at = now()
   where id = p_msg;
  -- Twilio refuses a number that texted STOP with 21610; remember it.
  if p_error_code = '21610' then
    perform communication_opt_out(v.client_id, v.to_e164, v.contact_id, p_at, 'other', 'provider', p_msg,
      'Twilio refused the message: the recipient has opted out (21610)');
  end if;
  perform set_config('compass.communications_write', '', true);
  return 'updated';
end $$;
revoke all on function communication_apply_status(uuid, text, text, text, timestamptz) from public, anon, authenticated, service_role;

-- Outbound, step 2: what Twilio answered (a SID and its status, or an error).
create function communication_mark_sent(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_msg uuid := nullif(p->>'message_id', '')::uuid;
  v_sid text := nullif(p->>'provider_message_sid', '');
  v record;
  v_result text;
begin
  if communication_caller() <> 'service' then
    raise exception 'forbidden: the communications function records sends' using errcode = 'insufficient_privilege';
  end if;
  select id, provider_message_sid, direction into v from communication_messages where id = v_msg for update;
  if not found or v.direction <> 'outbound' then raise exception 'not_found: no such outbound message' using errcode = 'P0002'; end if;
  if v_sid is not null then
    if v_sid !~ '^(SM|MM)[0-9a-f]{32}$' then raise exception 'invalid: MessageSid' using errcode = '22023'; end if;
    if v.provider_message_sid is not null and v.provider_message_sid <> v_sid then
      raise exception 'conflict: the message already has another SID' using errcode = '23505';
    end if;
    if v.provider_message_sid is null then
      perform set_config('compass.communications_write', 'on', true);
      update communication_messages set provider_message_sid = v_sid where id = v_msg;
      perform set_config('compass.communications_write', '', true);
    end if;
  end if;
  v_result := communication_apply_status(v_msg, coalesce(nullif(p->>'provider_status', ''), case when v_sid is null then 'failed' else 'queued' end),
    p->>'error_code', p->>'error_message', now());
  return jsonb_build_object('message_id', v_msg, 'result', v_result);
end $$;
revoke all on function communication_mark_sent(jsonb) from public, anon, authenticated;
grant execute on function communication_mark_sent(jsonb) to service_role;

-- Delivery status callback (twilio-webhook, after the signature check). The
-- callback URL carries the Compass message id, so a callback that outruns
-- step 2 still finds its message. The AccountSid must be the message's.
create function communication_record_status(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_sid text := nullif(p->>'message_sid', '');
  v_id uuid := case when coalesce(p->>'message_id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then (p->>'message_id')::uuid end;
  v record;
  v_result text;
begin
  if communication_caller() <> 'service' then
    raise exception 'forbidden: delivery status is recorded by the twilio-webhook function only' using errcode = 'insufficient_privilege';
  end if;
  if v_sid is null or v_sid !~ '^(SM|MM)[0-9a-f]{32}$' then raise exception 'invalid: MessageSid' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('compass.comm_message:' || v_sid, 0));

  select m.id, m.provider_message_sid, a.provider_account_sid into v
  from communication_messages m
  join communication_conversations c on c.id = m.conversation_id
  join communication_numbers n on n.id = c.communication_number_id
  join communication_accounts a on a.id = n.communication_account_id
  where (v_id is not null and m.id = v_id and (m.provider_message_sid is null or m.provider_message_sid = v_sid))
     or m.provider_message_sid = v_sid
  order by (m.provider_message_sid = v_sid) desc nulls last
  limit 1;
  if not found then return jsonb_build_object('result', 'unknown'); end if;
  if v.provider_account_sid <> p->>'account_sid' then
    raise exception 'forbidden: the callback''s account does not own this message' using errcode = 'insufficient_privilege';
  end if;
  if v.provider_message_sid is null then
    perform set_config('compass.communications_write', 'on', true);
    update communication_messages set provider_message_sid = v_sid where id = v.id;
    perform set_config('compass.communications_write', '', true);
  end if;
  v_result := communication_apply_status(v.id, p->>'status', p->>'error_code', p->>'error_message',
    coalesce(nullif(p->>'at', '')::timestamptz, now()));
  return jsonb_build_object('result', v_result, 'message_id', v.id);
end $$;
revoke all on function communication_record_status(jsonb) from public, anon, authenticated;
grant execute on function communication_record_status(jsonb) to service_role;

-- The Twilio registry, written by the communications function after Twilio
-- answered (create / link subaccount, Messaging Service, number).
create function communication_register_account(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_client uuid := (p->>'client_id')::uuid;
  v_sid text := p->>'account_sid';
  v_existing record;
  v_id uuid;
begin
  if communication_caller() <> 'service' then
    raise exception 'forbidden: the communications function registers Twilio accounts' using errcode = 'insufficient_privilege';
  end if;
  select id, provider_account_sid into v_existing from communication_accounts where client_id = v_client and provider = 'twilio';
  if found and v_existing.provider_account_sid <> v_sid then
    raise exception 'account_exists: this client already has subaccount %', v_existing.provider_account_sid using errcode = '23505';
  end if;
  perform set_config('compass.communications_write', 'on', true);
  insert into communication_accounts (client_id, provider, provider_account_sid, friendly_name, status, created_by)
  values (v_client, 'twilio', v_sid, p->>'friendly_name', coalesce(nullif(p->>'status', ''), 'active'), nullif(p->>'created_by', '')::uuid)
  on conflict (provider_account_sid) do update
    set friendly_name = excluded.friendly_name, status = excluded.status
    where communication_accounts.client_id = excluded.client_id
  returning id into v_id;
  perform set_config('compass.communications_write', '', true);
  if v_id is null then raise exception 'account_taken: subaccount % belongs to another client', v_sid using errcode = '23505'; end if;
  return jsonb_build_object('account_id', v_id);
end $$;
revoke all on function communication_register_account(jsonb) from public, anon, authenticated;
grant execute on function communication_register_account(jsonb) to service_role;

create function communication_register_messaging_service(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_client uuid := (p->>'client_id')::uuid;
  v_account uuid;
  v_id uuid;
begin
  if communication_caller() <> 'service' then
    raise exception 'forbidden: the communications function registers Messaging Services' using errcode = 'insufficient_privilege';
  end if;
  select id into v_account from communication_accounts where client_id = v_client and provider = 'twilio';
  if not found then raise exception 'no_account: this client has no Twilio subaccount' using errcode = 'P0001'; end if;
  perform set_config('compass.communications_write', 'on', true);
  insert into communication_messaging_services (client_id, communication_account_id, provider_service_sid, friendly_name, use_case, opt_out_mode)
  values (v_client, v_account, p->>'service_sid', p->>'friendly_name', coalesce(nullif(p->>'use_case', ''), 'customer_care'),
          coalesce(nullif(p->>'opt_out_mode', ''), 'twilio_default'))
  on conflict (provider_service_sid) do update
    set friendly_name = excluded.friendly_name, use_case = excluded.use_case, status = 'active'
    where communication_messaging_services.client_id = excluded.client_id
  returning id into v_id;
  perform set_config('compass.communications_write', '', true);
  if v_id is null then raise exception 'service_taken: that Messaging Service belongs to another client' using errcode = '23505'; end if;
  return jsonb_build_object('messaging_service_id', v_id);
end $$;
revoke all on function communication_register_messaging_service(jsonb) from public, anon, authenticated;
grant execute on function communication_register_messaging_service(jsonb) to service_role;

create function communication_register_number(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_client uuid := (p->>'client_id')::uuid;
  v_account uuid;
  v_service uuid;
  v_id uuid;
begin
  if communication_caller() <> 'service' then
    raise exception 'forbidden: the communications function registers numbers' using errcode = 'insufficient_privilege';
  end if;
  select id into v_account from communication_accounts where client_id = v_client and provider = 'twilio';
  if not found then raise exception 'no_account: this client has no Twilio subaccount' using errcode = 'P0001'; end if;
  if nullif(p->>'messaging_service_sid', '') is not null then
    select id into v_service from communication_messaging_services
     where client_id = v_client and provider_service_sid = p->>'messaging_service_sid';
    if not found then raise exception 'not_found: that Messaging Service is not this client''s' using errcode = 'P0002'; end if;
  end if;
  perform set_config('compass.communications_write', 'on', true);
  insert into communication_numbers (client_id, communication_account_id, messaging_service_id, provider_phone_number_sid,
    phone_number_e164, friendly_name, number_type, voice_enabled, sms_enabled, mms_enabled, is_primary, purchased_at)
  values (v_client, v_account, v_service, p->>'number_sid', p->>'phone_number', p->>'friendly_name',
    coalesce(nullif(p->>'number_type', ''), 'toll_free'), coalesce((p->>'voice')::boolean, false),
    coalesce((p->>'sms')::boolean, false), coalesce((p->>'mms')::boolean, false),
    not exists (select 1 from communication_numbers where client_id = v_client and is_primary and status = 'active'),
    nullif(p->>'purchased_at', '')::timestamptz)
  -- A re-registration updates only what it names (attaching a number to its
  -- Messaging Service names no capabilities and must not clear them).
  on conflict (provider_phone_number_sid) do update
    set messaging_service_id = coalesce(excluded.messaging_service_id, communication_numbers.messaging_service_id),
        friendly_name = coalesce(nullif(p->>'friendly_name', ''), communication_numbers.friendly_name),
        voice_enabled = case when p ? 'voice' then excluded.voice_enabled else communication_numbers.voice_enabled end,
        sms_enabled = case when p ? 'sms' then excluded.sms_enabled else communication_numbers.sms_enabled end,
        mms_enabled = case when p ? 'mms' then excluded.mms_enabled else communication_numbers.mms_enabled end,
        status = 'active'
    where communication_numbers.client_id = excluded.client_id
  returning id into v_id;
  perform set_config('compass.communications_write', '', true);
  if v_id is null then raise exception 'number_taken: that number belongs to another client' using errcode = '23505'; end if;
  return jsonb_build_object('number_id', v_id);
end $$;
revoke all on function communication_register_number(jsonb) from public, anon, authenticated;
grant execute on function communication_register_number(jsonb) to service_role;

-- A sync's result for one registration: Twilio's raw status, its mapping,
-- dates and rejection. Nothing else.
create function communication_record_compliance_sync(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_id uuid := (p->>'profile_id')::uuid;
  v_rows int;
begin
  if communication_caller() <> 'service' then
    raise exception 'forbidden: the communications function records Twilio''s status' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.communications_write', 'on', true);
  update communication_compliance_profiles
     set provider_status = p->>'provider_status',
         status = p->>'status',
         submitted_at = coalesce(nullif(p->>'submitted_at', '')::timestamptz, submitted_at),
         approved_at = case when p->>'status' = 'approved' then coalesce(nullif(p->>'approved_at', '')::timestamptz, approved_at, now()) end,
         rejected_at = case when p->>'status' = 'rejected' then coalesce(nullif(p->>'rejected_at', '')::timestamptz, rejected_at, now()) end,
         rejection_code = case when p->>'status' = 'rejected' then nullif(p->>'rejection_code', '') end,
         rejection_reason = case when p->>'status' = 'rejected' then nullif(p->>'rejection_reason', '') end,
         edit_allowed = (p->>'edit_allowed')::boolean,
         last_synced_at = now()
   where id = v_id and provider_profile_sid = p->>'provider_profile_sid';
  get diagnostics v_rows = row_count;
  perform set_config('compass.communications_write', '', true);
  if v_rows = 0 then raise exception 'changed: the registration was relinked or removed during the sync' using errcode = 'P0001'; end if;
  return jsonb_build_object('profile_id', v_id, 'status', p->>'status');
end $$;
revoke all on function communication_record_compliance_sync(jsonb) from public, anon, authenticated;
grant execute on function communication_record_compliance_sync(jsonb) to service_role;

-- A teammate records (or revokes) a recipient's consent, with its evidence.
-- A recipient's opt-out is theirs to lift (START); a teammate cannot.
create function communication_record_consent(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_client uuid := (p->>'client_id')::uuid;
  v_phone text := p->>'phone_e164';
  v_type text := coalesce(nullif(p->>'consent_type', ''), 'sms_customer_care');
  v_status text := p->>'status';
  v_source text := p->>'source';
  v_contact uuid := nullif(p->>'contact_id', '')::uuid;
  v_evidence text := nullif(btrim(coalesce(p->>'evidence', '')), '');
  v_url text := nullif(btrim(coalesce(p->>'source_url', '')), '');
  v_at timestamptz := coalesce(nullif(p->>'consented_at', '')::timestamptz, now());
  v_current text;
  v_id uuid;
begin
  if communication_caller() <> 'team' then
    raise exception 'forbidden: only a signed-in Compass teammate records consent' using errcode = 'insufficient_privilege';
  end if;
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'invalid: phone number' using errcode = '22023'; end if;
  if v_status not in ('granted', 'revoked') then raise exception 'invalid: status must be granted or revoked' using errcode = '22023'; end if;
  if v_status = 'granted' and v_source not in ('web_form', 'verbal', 'paper_form', 'inbound_sms', 'import', 'other') then
    raise exception 'invalid: how was consent given?' using errcode = '22023';
  end if;
  if v_status = 'granted' and v_evidence is null and v_url is null then
    raise exception 'no_evidence: record where or how the recipient agreed' using errcode = '22023';
  end if;
  if v_status = 'granted' and v_at > now() + interval '5 minutes' then
    raise exception 'invalid: consent cannot be dated in the future' using errcode = '22023';
  end if;
  if v_contact is not null and not exists (select 1 from contacts where id = v_contact and client_id = v_client) then
    raise exception 'not_found: no such contact for this client' using errcode = 'P0002';
  end if;
  if not exists (select 1 from clients where id = v_client) then raise exception 'not_found: no such client' using errcode = 'P0002'; end if;

  select status into v_current from communication_consents
   where client_id = v_client and phone_e164 = v_phone and consent_type = v_type for update;
  if v_current = 'opted_out' and v_status = 'granted' then
    raise exception 'opted_out: % texted STOP; only the recipient can opt back in, by texting START', v_phone using errcode = 'P0001';
  end if;
  if v_status = 'granted' and exists (select 1 from communication_consents
       where client_id = v_client and phone_e164 = v_phone and status = 'opted_out') then
    raise exception 'opted_out: % texted STOP; only the recipient can opt back in, by texting START', v_phone using errcode = 'P0001';
  end if;
  if v_current is null and v_status = 'revoked' then
    raise exception 'not_found: there is no consent to revoke' using errcode = 'P0002';
  end if;

  perform set_config('compass.communications_write', 'on', true);
  perform set_config('compass.consent_context', jsonb_build_object('actor_kind', 'team')::text, true);
  if v_status = 'granted' then
    insert into communication_consents (client_id, contact_id, phone_e164, consent_type, status, source, source_url,
      disclosure_version, evidence, consented_at, revoked_at, recorded_by)
    values (v_client, v_contact, v_phone, v_type, 'granted', v_source, v_url, nullif(p->>'disclosure_version', ''),
      v_evidence, v_at, null, task_actor())
    on conflict (client_id, phone_e164, consent_type) do update
      set status = 'granted', source = excluded.source, source_url = excluded.source_url,
          disclosure_version = excluded.disclosure_version, evidence = excluded.evidence,
          consented_at = excluded.consented_at, revoked_at = null, recorded_by = excluded.recorded_by,
          contact_id = coalesce(excluded.contact_id, communication_consents.contact_id)
    returning id into v_id;
  else
    update communication_consents
       set status = 'revoked', revoked_at = now(), recorded_by = task_actor(),
           evidence = coalesce(v_evidence, 'Revoked by a teammate')
     where client_id = v_client and phone_e164 = v_phone and consent_type = v_type
    returning id into v_id;
  end if;
  perform set_config('compass.consent_context', '', true);
  perform set_config('compass.communications_write', '', true);
  return jsonb_build_object('consent_id', v_id, 'status', v_status);
end $$;
revoke all on function communication_record_consent(jsonb) from public, anon;
grant execute on function communication_record_consent(jsonb) to authenticated;

-- A teammate's changes to a thread: read, open / closed, assignee.
create function communication_update_conversation(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_id uuid := (p->>'conversation_id')::uuid;
  v_rows int;
begin
  if communication_caller() <> 'team' then
    raise exception 'forbidden: only a signed-in Compass teammate updates a conversation' using errcode = 'insufficient_privilege';
  end if;
  if p ? 'status' and p->>'status' not in ('open', 'closed') then raise exception 'invalid: status' using errcode = '22023'; end if;
  if nullif(p->>'assigned_user_id', '') is not null
     and not exists (select 1 from team_members where id = (p->>'assigned_user_id')::uuid) then
    raise exception 'invalid: assignee is not a teammate' using errcode = '22023';
  end if;
  perform set_config('compass.communications_write', 'on', true);
  update communication_conversations
     set unread_count = case when coalesce((p->>'mark_read')::boolean, false) then 0 else unread_count end,
         status = coalesce(nullif(p->>'status', ''), status),
         assigned_user_id = case when p ? 'assigned_user_id' then nullif(p->>'assigned_user_id', '')::uuid else assigned_user_id end
   where id = v_id;
  get diagnostics v_rows = row_count;
  perform set_config('compass.communications_write', '', true);
  if v_rows = 0 then raise exception 'not_found: no such conversation' using errcode = 'P0002'; end if;
  return jsonb_build_object('conversation_id', v_id);
end $$;
revoke all on function communication_update_conversation(jsonb) from public, anon;
grant execute on function communication_update_conversation(jsonb) to authenticated;

create function communication_set_primary_number(p_number_id uuid) returns void
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_client uuid;
begin
  if communication_caller() <> 'team' then
    raise exception 'forbidden: only a signed-in Compass teammate picks the primary number' using errcode = 'insufficient_privilege';
  end if;
  select client_id into v_client from communication_numbers where id = p_number_id and status = 'active';
  if not found then raise exception 'not_found: no such active number' using errcode = 'P0002'; end if;
  perform set_config('compass.communications_write', 'on', true);
  update communication_numbers set is_primary = false where client_id = v_client and is_primary and id <> p_number_id;
  update communication_numbers set is_primary = true where id = p_number_id;
  perform set_config('compass.communications_write', '', true);
end $$;
revoke all on function communication_set_primary_number(uuid) from public, anon;
grant execute on function communication_set_primary_number(uuid) to authenticated;

-- ── 6. The standard pre-submission checklist ────────────────────────────────
-- Generic (CTIA / Twilio toll-free verification); nothing client-specific.
create function communication_standard_checklist()
returns table (item_key text, label text, sort_order int)
language sql immutable set search_path = pg_catalog as $$
  values
    ('consent_checkbox_optional', 'SMS consent on the web form is optional and unchecked by default', 10),
    ('disclosure_names_business', 'The consent disclosure names the legal business', 20),
    ('disclosure_purpose_frequency', 'The disclosure states the message purpose and that frequency varies', 30),
    ('disclosure_rates', 'The disclosure says "Message and data rates may apply"', 40),
    ('disclosure_help_stop', 'The disclosure gives HELP and STOP instructions', 50),
    ('policy_links_beside_optin', 'Terms of Service and Privacy Policy links sit directly beside the opt-in', 60),
    ('privacy_sms_non_sharing', 'The Privacy Policy says SMS opt-in data is never shared or sold to third parties', 70),
    ('terms_sms_program', 'The Terms describe the SMS program: purpose, frequency, rates, support, STOP / HELP, carrier liability', 80),
    ('placeholder_numbers_removed', 'No placeholder phone numbers (e.g. 800-555-0100) remain on the business''s sites', 90),
    ('opt_in_evidence', 'A screenshot or URL of the live opt-in is ready for the verification', 100),
    ('sample_messages', 'Sample messages match the declared use case and include the business name', 110),
    ('no_purchased_lists', 'The business confirms no purchased lists and no cold texting', 120)
$$;
comment on function communication_standard_checklist() is
  'The standard pre-submission checklist for a toll-free verification (0063). Generic; copied onto a registration by communication_ensure_checklist().';
revoke all on function communication_standard_checklist() from public, anon;
grant execute on function communication_standard_checklist() to authenticated, service_role;

-- Adds the missing standard items to a registration (invoker rights; the
-- items guard decides who may).
create function communication_ensure_checklist(p_profile_id uuid) returns int
language plpgsql security invoker set search_path = public, pg_catalog as $$
declare
  v_client uuid;
  v_count int;
begin
  select client_id into v_client from communication_compliance_profiles where id = p_profile_id;
  if not found then raise exception 'not_found: no such registration' using errcode = 'P0002'; end if;
  insert into communication_compliance_items (client_id, profile_id, item_key, label, sort_order)
  select v_client, p_profile_id, s.item_key, s.label, s.sort_order from communication_standard_checklist() s
  on conflict (profile_id, item_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function communication_ensure_checklist(uuid) from public, anon;
grant execute on function communication_ensure_checklist(uuid) to authenticated;

-- ── 7. RLS and grants ───────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['client_communication_settings', 'communication_accounts', 'communication_messaging_services',
    'communication_numbers', 'communication_compliance_profiles', 'communication_compliance_items', 'contacts',
    'communication_consents', 'communication_consent_events', 'communication_conversations', 'communication_messages'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "team full access" on %I for all to authenticated using ((select is_team())) with check ((select is_team()))', t);
    execute format('revoke all on %I from public, anon, authenticated, service_role', t);
    execute format('grant select on %I to authenticated, service_role', t);
  end loop;
end $$;
-- What a teammate writes directly (the guards above refine it).
grant insert, update on client_communication_settings to authenticated;
grant insert, update, delete on communication_compliance_profiles to authenticated;
grant insert, update, delete on communication_compliance_items to authenticated;
grant insert, update, delete on contacts to authenticated;

-- ── 8. Verify ───────────────────────────────────────────────────────────────
do $$
declare
  t text;
  f record;
begin
  foreach t in array array['client_communication_settings', 'communication_accounts', 'communication_messaging_services',
    'communication_numbers', 'communication_compliance_profiles', 'communication_compliance_items', 'contacts',
    'communication_consents', 'communication_consent_events', 'communication_conversations', 'communication_messages'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '0063: RLS is off on %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'insert') then
      raise exception '0063: anon can reach %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
               and (qual is null or qual not like '%is_team()%')) then
      raise exception '0063: % has a policy that does not read is_team()', t;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'client_id') then
      raise exception '0063: % is not scoped by client_id', t;
    end if;
  end loop;
  foreach t in array array['communication_accounts', 'communication_messaging_services', 'communication_numbers',
    'communication_consents', 'communication_consent_events', 'communication_conversations', 'communication_messages'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('service_role', 'public.' || t, 'insert') or has_table_privilege('service_role', 'public.' || t, 'update') then
      raise exception '0063: % is written directly; it must go through the functions', t;
    end if;
  end loop;
  for f in select p.oid::regprocedure as sig, p.prosecdef from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname like 'communication%' loop
    if has_function_privilege('anon', f.sig, 'execute') then raise exception '0063: anon may execute %', f.sig; end if;
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name like 'communication%' and column_name ~ '(^|_)(ein|tax_id|auth_token|api_secret|api_key)($|_)') then
    raise exception '0063: a communications column looks like it holds a credential or tax id';
  end if;
  if exists (select 1 from information_schema.view_table_usage where view_schema = 'public' and view_name like 'portal_%'
             and (table_name like 'communication%' or table_name = 'contacts')) then
    raise exception '0063: a portal view references communications';
  end if;
end $$;
