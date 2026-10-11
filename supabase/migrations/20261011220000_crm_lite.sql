-- CRM Lite (Oct 11 2026): website inquiries saved in Compass, a simple
-- New → Contacted → Closed workspace for the agency and for the client's own
-- portal sign-in, and the SMS inquiry-alert foundation (sending disabled).
-- Piloted with Ginger Huff Interiors; nothing in this file names a client.
-- Design, gates and rollout: docs/crm-lite.md.
--
-- Shape:
--   crm_lite_settings ............ per client (no row = off): enabled,
--                                  portal_enabled, sms_alerts_enabled
--   inquiry_sources .............. an authenticated integration (a website
--                                  form). Its bearer token lives in Vault
--                                  (secret_name); the client is the source's,
--                                  never a value the caller sends.
--   inquiries .................... one per submission; unique per source and
--                                  submission id (a retry is a no-op)
--   inquiry_notes / inquiry_events  follow-up notes and the append-only
--                                  history (received, status changes, notes,
--                                  email outcome)
--   contacts (0063) .............. the client's own customers: an inquiry is
--                                  matched by email, then phone, within its
--                                  client only, or a contact is created
--   notification_senders ......... Compass's own alert sender (a Twilio
--                                  subaccount + number); approval recorded by
--                                  an admin, never assumed
--   notification_recipients ...... who gets a client's alerts, with the
--                                  consent record a teammate completes
--   notification_consent_events .. append-only consent history
--   notification_opt_outs ........ STOP per sender and phone (all clients)
--   notification_inbound_keywords  STOP / START / HELP received (idempotent)
--   notification_jobs ............ the durable outbox, one job per inquiry
--                                  and recipient; delivery status is separate
--                                  from the inquiry's own status
--
-- Callers (crm_caller()): service (the inquiry-intake / crm-lite /
-- twilio-webhook Edge Functions), team (a signed-in teammate through
-- PostgREST), portal (a signed-in portal contact), owner (postgres: the
-- worker's SQL and data scripts), superuser (sandbox fixtures).
--
-- Who writes what:
--   * inquiries, notes, events, jobs, opt-outs and keywords: only inside the
--     functions below (guard triggers, no direct grants). The worker's SQL
--     cannot fabricate an inquiry, change a status or send.
--   * status changes and notes: a teammate, or a portal contact of the
--     inquiry's own client while that client's portal access is on
--     (crm_inquiry_set_status / crm_inquiry_add_note).
--   * settings, sources, recipients: a teammate; a data script may create
--     them but never turns SMS on, approves a sender or records consent.
--   * consent: a signed-in teammate only (crm_record_notification_consent),
--     with date, method, the recipient's actual response and the disclosure
--     acknowledged. Nothing marks it complete automatically.
--   * sender approval, SMS on/off, delivery-test confirmation: an admin.
--
-- SMS stays off until all of: the sender's toll-free verification is
-- recorded approved by an admin, the sender is enabled, the recipient's
-- consent is complete, an admin confirmed a delivered test to that
-- recipient, and an admin turned the client's alerts on. A job created while
-- any gate is closed is 'blocked' for good: enabling later never sends old
-- inquiries, and a queued job older than 24 hours is never sent.
--
-- Portal: four views filtered by portal_client_id() and the client's
-- portal_enabled, carrying the submitted inquiry, notes and history only (no
-- contacts, email or notification internals).
--
-- Rollback (keeps every saved inquiry): turn the website integration off
-- (unset its CRM_INTAKE_* variables), set crm_lite_settings.enabled = false,
-- and unschedule crm-lite-dispatch. Dropping the objects is a separate,
-- deliberate step (docs/crm-lite.md › Rollback).

-- ── 0. Preconditions ────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public'
             and table_name in ('crm_lite_settings', 'inquiry_sources', 'inquiries', 'inquiry_notes', 'inquiry_events',
               'notification_senders', 'notification_recipients', 'notification_consent_events', 'notification_opt_outs',
               'notification_inbound_keywords', 'notification_jobs')) then
    raise exception 'crm_lite: a CRM Lite table already exists';
  end if;
  if not exists (select 1 from pg_proc where proname = 'communication_status_rank') then
    raise exception 'crm_lite: needs 0063 (Compass Communications)';
  end if;
end $$;

-- ── 1. Who is calling ───────────────────────────────────────────────────────
create function crm_caller() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when coalesce((select rolsuper from pg_roles where rolname = session_user), false) then 'superuser'
    when session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'service_role' then 'service'
    when session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'authenticated' and is_team() then 'team'
    when session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'authenticated'
         and portal_client_id() is not null then 'portal'
    when session_user = 'postgres' then 'owner'
    else 'other'
  end
$$;
revoke all on function crm_caller() from public, anon, authenticated, service_role;
comment on function crm_caller() is
  'service (a CRM Lite Edge Function), team, portal (a signed-in portal contact), owner (postgres), superuser (sandbox) or other.';

-- On only inside the write functions below, and only for a service / team /
-- portal caller, so the worker's SQL cannot borrow it.
create function crm_in_write() returns boolean
language sql stable set search_path = public, pg_temp as $$
  select coalesce(current_setting('compass.crm_write', true), '') = 'on'
     and crm_caller() in ('service', 'team', 'portal')
$$;
revoke all on function crm_in_write() from public, anon, authenticated, service_role;

create function crm_is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select crm_caller() = 'team' and is_team_admin()
$$;
revoke all on function crm_is_admin() from public, anon, authenticated, service_role;

-- US numbers as the website takes them: 10 digits, or 11 starting with 1.
create function crm_phone_e164(p text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case
    when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) = 10
         and regexp_replace(p, '\D', '', 'g') ~ '^[2-9]' then '+1' || regexp_replace(p, '\D', '', 'g')
    when length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) = 11
         and regexp_replace(p, '\D', '', 'g') ~ '^1[2-9]' then '+' || regexp_replace(p, '\D', '', 'g')
    else null
  end
$$;
revoke all on function crm_phone_e164(text) from public, anon;
grant execute on function crm_phone_e164(text) to authenticated, service_role;

-- ── 2. Tables ───────────────────────────────────────────────────────────────
create table notification_senders (
  id uuid primary key default gen_random_uuid(),
  sender_key text not null unique check (sender_key ~ '^[a-z0-9][a-z0-9_]{2,62}$'),
  label text not null,
  provider text not null default 'twilio' check (provider in ('twilio')),
  provider_account_sid text not null unique check (provider_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  messaging_service_sid text check (messaging_service_sid ~ '^MG[0-9a-fA-F]{32}$'),
  -- The toll-free verification, as an admin confirmed it in Twilio.
  verification_sid text check (verification_sid ~ '^HH[0-9a-fA-F]{32}$'),
  verification_status text not null default 'pending_review'
    check (verification_status in ('not_submitted', 'pending_review', 'in_review', 'approved', 'rejected')),
  verification_evidence text,
  verification_checked_by uuid references team_members(id) on delete set null,
  verification_checked_at timestamptz,
  enabled boolean not null default false,
  link_base_url text not null default 'https://compass-crm-ten.vercel.app' check (link_base_url ~ '^https://[^/\s]+$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_senders_approved_evidence check (
    verification_status <> 'approved'
    or (verification_sid is not null and length(btrim(coalesce(verification_evidence, ''))) > 0
        and verification_checked_by is not null and verification_checked_at is not null)),
  constraint notification_senders_enabled_needs_approval check (not enabled or verification_status = 'approved')
);
comment on table notification_senders is
  'Compass''s own SMS alert sender: a Twilio subaccount and number (credentials in Vault as TWILIO_SUB_<sid>_*). Approved only when an admin records the toll-free verification; enabled only once approved (CRM Lite).';

create table crm_lite_settings (
  client_id uuid primary key references clients(id) on delete cascade,
  enabled boolean not null default false,
  portal_enabled boolean not null default false,
  display_name text,
  sms_alerts_enabled boolean not null default false,
  sms_sender_id uuid references notification_senders(id) on delete set null,
  sms_alerts_enabled_at timestamptz,
  sms_alerts_enabled_by uuid references team_members(id) on delete set null,
  notes text,
  updated_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_lite_settings_portal_needs_enabled check (not portal_enabled or enabled),
  constraint crm_lite_settings_sms_needs_enabled check (not sms_alerts_enabled or (enabled and sms_sender_id is not null))
);
comment on table crm_lite_settings is
  'CRM Lite per client. No row = off. enabled: inquiries are accepted and the agency workspace is on; portal_enabled: the client''s portal contacts see and follow up their own inquiries; sms_alerts_enabled: only through crm_set_sms_alerts (admin, every gate).';

create table inquiry_sources (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  source_key text not null unique check (source_key ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  kind text not null default 'website_form' check (kind in ('website_form')),
  label text not null,
  site_url text check (site_url ~ '^https://'),
  enabled boolean not null default false,
  -- The Vault name of the bearer token (never the token).
  secret_name text not null unique check (secret_name ~ '^CRM_INTAKE_[A-Z0-9_]{3,80}$'),
  token_issued_at timestamptz,
  token_issued_by uuid references team_members(id) on delete set null,
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id)
);
comment on table inquiry_sources is
  'An authenticated inquiry integration (a website form). The caller proves itself with the bearer token stored in Vault under secret_name; the inquiry''s client is this row''s client, never a value in the request (CRM Lite).';

create table inquiries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  source_id uuid not null,
  submission_id text not null check (submission_id ~ '^[A-Za-z0-9._:-]{8,100}$'),
  contact_id uuid,
  name text not null check (length(btrim(name)) between 1 and 200),
  email text check (email is null or (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone text check (phone is null or length(phone) <= 60),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  location text check (location is null or length(location) <= 200),
  service_type text check (service_type is null or length(service_type) <= 200),
  budget text check (budget is null or length(budget) <= 200),
  message text not null check (length(message) <= 10000),
  page_url text check (page_url is null or (page_url ~ '^https://' and length(page_url) <= 2000)),
  submitted_at timestamptz not null,
  received_at timestamptz not null default now(),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  status_changed_at timestamptz,
  -- What the website reported about its own (Resend) email for this
  -- submission. CRM Lite sends no email of its own.
  email_status text not null default 'not_reported' check (email_status in ('not_reported', 'failed', 'accepted')),
  email_provider_id text check (email_provider_id is null or length(email_provider_id) <= 200),
  email_reported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, submission_id),
  unique (id, client_id),
  foreign key (source_id, client_id) references inquiry_sources (id, client_id),
  foreign key (contact_id, client_id) references contacts (id, client_id) on delete set null (contact_id)
);
create index inquiries_client_received on inquiries (client_id, received_at desc);
create index inquiries_client_status on inquiries (client_id, status, received_at desc);
comment on table inquiries is
  'One website inquiry: the fields the form collects, the full message, when it was submitted and from which source. Unique per source and submission id, so a retried submission is recorded once; separate submissions from the same person are separate inquiries (CRM Lite).';

create table inquiry_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  inquiry_id uuid not null,
  body text not null check (length(btrim(body)) between 1 and 5000),
  author_kind text not null check (author_kind in ('team', 'portal')),
  author_team_member_id uuid references team_members(id) on delete set null,
  author_portal_user_id uuid references portal_users(id) on delete set null,
  author_name text not null,
  created_at timestamptz not null default now(),
  foreign key (inquiry_id, client_id) references inquiries (id, client_id) on delete cascade
);
create index on inquiry_notes (inquiry_id, created_at);
comment on table inquiry_notes is 'Follow-up notes on an inquiry, with author and time. Immutable (CRM Lite).';

create table inquiry_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  inquiry_id uuid not null,
  kind text not null check (kind in ('received', 'status_changed', 'note_added', 'email_reported')),
  from_status text,
  to_status text,
  detail jsonb not null default '{}'::jsonb,
  actor_kind text not null check (actor_kind in ('team', 'portal', 'website', 'system')),
  actor_team_member_id uuid references team_members(id) on delete set null,
  actor_portal_user_id uuid references portal_users(id) on delete set null,
  actor_name text,
  created_at timestamptz not null default now(),
  foreign key (inquiry_id, client_id) references inquiries (id, client_id) on delete cascade
);
create index on inquiry_events (inquiry_id, created_at);
comment on table inquiry_events is 'Append-only history of an inquiry: received, every status change (who, when), notes, the website''s email outcome (CRM Lite).';

create table notification_recipients (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  channel text not null default 'sms' check (channel in ('sms')),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  name text not null check (length(btrim(name)) > 0),
  link_target text not null default 'portal' check (link_target in ('portal', 'crm')),
  enabled boolean not null default true,
  consent_status text not null default 'pending' check (consent_status in ('pending', 'granted', 'revoked', 'opted_out')),
  consent_method text check (consent_method in ('verbal', 'written', 'email', 'text_reply', 'web_form', 'other')),
  consented_at timestamptz,
  consent_response text,
  disclosure_version text,
  disclosure_url text check (disclosure_url is null or disclosure_url ~ '^https://'),
  disclosure_acknowledged boolean not null default false,
  consent_recorded_by uuid references team_members(id) on delete set null,
  consent_recorded_at timestamptz,
  opted_out_at timestamptz,
  delivery_test_job_id uuid,
  delivery_test_confirmed_by uuid references team_members(id) on delete set null,
  delivery_test_confirmed_at timestamptz,
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, channel, phone_e164),
  unique (id, client_id),
  constraint notification_recipients_consent_complete check (
    consent_status <> 'granted'
    or (consent_method is not null and consented_at is not null
        and length(btrim(coalesce(consent_response, ''))) > 0
        and length(btrim(coalesce(disclosure_version, ''))) > 0
        and disclosure_acknowledged
        and consent_recorded_by is not null and consent_recorded_at is not null))
);
comment on table notification_recipients is
  'Who receives a client''s inquiry alerts. A phone number is not consent: granted needs the date, method, the recipient''s actual response and the acknowledged disclosure, recorded by a signed-in teammate (CRM Lite).';

create table notification_consent_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  recipient_id uuid not null,
  phone_e164 text not null,
  from_status text,
  to_status text not null,
  consent_method text,
  consented_at timestamptz,
  consent_response text,
  disclosure_version text,
  disclosure_url text,
  detail text,
  actor_kind text not null check (actor_kind in ('team', 'recipient', 'system')),
  actor_id uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (recipient_id, client_id) references notification_recipients (id, client_id) on delete cascade
);
create index on notification_consent_events (recipient_id, created_at);
comment on table notification_consent_events is 'Append-only history of every alert-consent change (CRM Lite).';

create table notification_opt_outs (
  sender_id uuid not null references notification_senders(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  opted_out boolean not null,
  last_keyword text not null check (last_keyword in ('STOP', 'START')),
  last_message_sid text,
  updated_at timestamptz not null default now(),
  primary key (sender_id, phone_e164)
);
comment on table notification_opt_outs is
  'STOP to a Compass alert sender stops every alert from it to that phone, for every client; START lifts this block, and consent is then recorded again by a teammate (CRM Lite).';

create table notification_inbound_keywords (
  provider_message_sid text primary key check (provider_message_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$'),
  sender_id uuid not null references notification_senders(id) on delete cascade,
  from_e164 text not null,
  keyword text not null check (keyword in ('STOP', 'START', 'HELP')),
  received_at timestamptz not null default now()
);
comment on table notification_inbound_keywords is 'STOP / START / HELP received on an alert sender, recorded once per Twilio MessageSid. Bodies are not stored (CRM Lite).';

create table notification_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in ('inquiry_alert', 'delivery_test')),
  inquiry_id uuid,
  recipient_id uuid not null,
  sender_id uuid references notification_senders(id) on delete set null,
  request_id uuid unique,
  channel text not null default 'sms' check (channel in ('sms')),
  -- Compass's delivery state of the job (the inquiry keeps its own status).
  status text not null check (status in ('blocked', 'queued', 'sending', 'unknown', 'sent', 'failed')),
  block_reason text,
  to_e164 text not null check (to_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  from_e164 text,
  body text not null check (length(body) between 1 and 320),
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null default 3 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  reconcile_checks int not null default 0,
  -- The provider's side.
  provider_message_sid text unique check (provider_message_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$'),
  provider_status text check (provider_status is null or communication_status_rank(provider_status) >= 0),
  provider_status_at timestamptz,
  error_code text,
  error_message text,
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id),
  foreign key (inquiry_id, client_id) references inquiries (id, client_id) on delete cascade,
  foreign key (recipient_id, client_id) references notification_recipients (id, client_id) on delete cascade,
  constraint notification_jobs_kind_shape check (
    (kind = 'inquiry_alert' and inquiry_id is not null) or (kind = 'delivery_test' and inquiry_id is null and request_id is not null)),
  constraint notification_jobs_blocked_reason check (status <> 'blocked' or block_reason is not null)
);
create unique index notification_jobs_one_alert on notification_jobs (inquiry_id, recipient_id) where kind = 'inquiry_alert';
create index notification_jobs_due on notification_jobs (status, next_attempt_at) where status in ('queued', 'sending', 'unknown');
comment on table notification_jobs is
  'The durable SMS outbox: one job per inquiry and recipient (or an admin''s delivery test). blocked jobs are never sent later; unknown means Twilio may have accepted it, so it is reconciled against Twilio before any resend (CRM Lite).';

alter table notification_recipients
  add foreign key (delivery_test_job_id) references notification_jobs (id) on delete set null;

-- contacts (0063) learn the web form as a source, and are matched by email.
alter table contacts drop constraint contacts_source_check;
alter table contacts add constraint contacts_source_check check (source in ('manual', 'inbound_sms', 'import', 'web_form'));
create index contacts_client_email on contacts (client_id, lower(email)) where email is not null;

-- ── 3. updated_at ───────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['notification_senders', 'crm_lite_settings', 'inquiry_sources', 'inquiries',
    'notification_recipients', 'notification_jobs'] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;

-- ── 4. Guards ───────────────────────────────────────────────────────────────
-- Function-only tables.
create function crm_guard_function_only() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op <> 'INSERT' then
    if not exists (select 1 from clients where id = old.client_id) then
      return case when tg_op = 'DELETE' then old else new end;  -- a client's deletion cascades
    end if;
  end if;
  if crm_in_write() or crm_caller() = 'superuser' then
    if tg_op = 'UPDATE' then
      if new.client_id is distinct from old.client_id then
        raise exception 'crm_lite: a row keeps its client' using errcode = 'check_violation';
      end if;
    end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'crm_lite: % on % goes through the CRM Lite functions', lower(tg_op), tg_table_name
    using errcode = 'insufficient_privilege';
end $$;
revoke all on function crm_guard_function_only() from public, anon, authenticated, service_role;

-- The same for the sender-scoped tables (no client).
create function crm_guard_sender_function_only() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from notification_senders where id = old.sender_id) then return old; end if;
  end if;
  if crm_in_write() or crm_caller() = 'superuser' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'crm_lite: % on % goes through the CRM Lite functions', lower(tg_op), tg_table_name
    using errcode = 'insufficient_privilege';
end $$;
revoke all on function crm_guard_sender_function_only() from public, anon, authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array['inquiries', 'inquiry_notes', 'inquiry_events', 'notification_jobs', 'notification_consent_events'] loop
    execute format('create trigger %I before insert or update or delete on %I for each row execute function crm_guard_function_only()',
      t || '_guard', t);
  end loop;
  foreach t in array array['notification_opt_outs', 'notification_inbound_keywords'] loop
    execute format('create trigger %I before insert or update or delete on %I for each row execute function crm_guard_sender_function_only()',
      t || '_guard', t);
  end loop;
end $$;

-- Notes and history never change once written (inside the functions too).
create function crm_append_only() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id)
       or not exists (select 1 from inquiries where id = old.inquiry_id) then return old; end if;
  end if;
  if crm_caller() = 'superuser' then return case when tg_op = 'DELETE' then old else new end; end if;
  raise exception 'crm_lite: % is append-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;
revoke all on function crm_append_only() from public, anon, authenticated, service_role;
create trigger inquiry_notes_append_only before update or delete on inquiry_notes for each row execute function crm_append_only();
create trigger inquiry_events_append_only before update or delete on inquiry_events for each row execute function crm_append_only();

create function notification_consent_events_append_only() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id)
       or not exists (select 1 from notification_recipients where id = old.recipient_id) then return old; end if;
  end if;
  if crm_caller() = 'superuser' then return case when tg_op = 'DELETE' then old else new end; end if;
  raise exception 'crm_lite: consent history is append-only' using errcode = 'insufficient_privilege';
end $$;
revoke all on function notification_consent_events_append_only() from public, anon, authenticated, service_role;
create trigger notification_consent_events_append_only before update or delete on notification_consent_events
  for each row execute function notification_consent_events_append_only();

-- Settings: a teammate's; a data script may create them; SMS only through
-- crm_set_sms_alerts.
create function crm_lite_settings_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller text := crm_caller();
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id) or v_caller = 'superuser' then return old; end if;
    raise exception 'crm_lite: turn CRM Lite off instead of deleting the setting' using errcode = 'check_violation';
  end if;
  if v_caller = 'superuser' then return new; end if;
  if tg_op = 'UPDATE' and new.client_id is distinct from old.client_id then
    raise exception 'crm_lite: a setting keeps its client' using errcode = 'check_violation';
  end if;
  if v_caller not in ('team', 'owner') then
    raise exception 'crm_lite: only a signed-in Compass teammate changes CRM Lite settings' using errcode = 'insufficient_privilege';
  end if;
  if (tg_op = 'INSERT' and (new.sms_alerts_enabled or new.sms_alerts_enabled_at is not null))
     or (tg_op = 'UPDATE' and (new.sms_alerts_enabled, new.sms_alerts_enabled_at, new.sms_alerts_enabled_by, new.sms_sender_id)
         is distinct from (old.sms_alerts_enabled, old.sms_alerts_enabled_at, old.sms_alerts_enabled_by, old.sms_sender_id)) then
    if not (crm_in_write() and v_caller = 'team') then
      raise exception 'crm_lite: SMS alerts are switched only through crm_set_sms_alerts (an admin, every gate checked)'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  -- Turning CRM Lite off also stops SMS alerts.
  if not new.enabled and new.sms_alerts_enabled then
    new.sms_alerts_enabled := false;
  end if;
  if v_caller = 'team' then new.updated_by := task_actor(); end if;
  return new;
end $$;
revoke all on function crm_lite_settings_guard() from public, anon, authenticated, service_role;
create trigger crm_lite_settings_guard before insert or update or delete on crm_lite_settings
  for each row execute function crm_lite_settings_guard();

-- Sources: a teammate's (or a data script's). The token is issued only by
-- the crm-lite function (token_issued_*); a source keeps its client and key
-- once it has inquiries.
create function inquiry_sources_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller text := crm_caller();
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id) or v_caller = 'superuser' then return old; end if;
    if exists (select 1 from inquiries where source_id = old.id) then
      raise exception 'crm_lite: this source has inquiries, which are kept; disable it instead' using errcode = 'check_violation';
    end if;
    if v_caller = 'team' then return old; end if;
    raise exception 'crm_lite: only a teammate removes a source' using errcode = 'insufficient_privilege';
  end if;
  if v_caller = 'superuser' then return new; end if;
  if crm_in_write() and v_caller = 'service' and tg_op = 'UPDATE' then
    -- The token issue records when and by whom, nothing else.
    if (new.client_id, new.source_key, new.secret_name, new.enabled, new.label, new.site_url)
       is distinct from (old.client_id, old.source_key, old.secret_name, old.enabled, old.label, old.site_url) then
      raise exception 'crm_lite: issuing a token changes nothing else' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if v_caller not in ('team', 'owner') then
    raise exception 'crm_lite: only a signed-in Compass teammate manages inquiry sources' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.token_issued_at is not null or new.token_issued_by is not null then
      raise exception 'crm_lite: a token is issued by the crm-lite function, never by an insert' using errcode = 'check_violation';
    end if;
    if v_caller = 'team' then new.created_by := task_actor(); end if;
    return new;
  end if;
  if (new.token_issued_at, new.token_issued_by) is distinct from (old.token_issued_at, old.token_issued_by) then
    raise exception 'crm_lite: a token is issued by the crm-lite function' using errcode = 'insufficient_privilege';
  end if;
  if (new.client_id, new.source_key, new.secret_name) is distinct from (old.client_id, old.source_key, old.secret_name)
     and exists (select 1 from inquiries where source_id = old.id) then
    raise exception 'crm_lite: a source with inquiries keeps its client, key and secret' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function inquiry_sources_guard() from public, anon, authenticated, service_role;
create trigger inquiry_sources_guard before insert or update or delete on inquiry_sources
  for each row execute function inquiry_sources_guard();

-- Senders: an admin's. A data script may create one, never approved or
-- enabled.
create function notification_senders_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller text := crm_caller();
begin
  if v_caller = 'superuser' then return case when tg_op = 'DELETE' then old else new end; end if;
  if tg_op = 'DELETE' then
    if crm_is_admin() and not exists (select 1 from notification_jobs where sender_id = old.id) then return old; end if;
    raise exception 'crm_lite: a sender with messages is kept; disable it instead' using errcode = 'insufficient_privilege';
  end if;
  if v_caller = 'owner' then
    if new.enabled or new.verification_status = 'approved' or new.verification_checked_by is not null then
      raise exception 'crm_lite: only a signed-in admin approves or enables an alert sender' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if not crm_is_admin() then
    raise exception 'crm_lite: only a Compass admin changes an alert sender' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and (new.verification_status, new.verification_sid, new.verification_evidence)
       is distinct from (old.verification_status, old.verification_sid, old.verification_evidence) then
    new.verification_checked_by := task_actor();
    new.verification_checked_at := now();
    if new.verification_status <> 'approved' then new.enabled := false; end if;
  elsif tg_op = 'INSERT' and new.verification_status = 'approved' then
    new.verification_checked_by := task_actor();
    new.verification_checked_at := now();
  end if;
  if tg_op = 'UPDATE' and (new.provider_account_sid, new.phone_e164) is distinct from (old.provider_account_sid, old.phone_e164)
     and exists (select 1 from notification_jobs where sender_id = old.id) then
    raise exception 'crm_lite: a sender with messages keeps its account and number; add a new sender' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function notification_senders_guard() from public, anon, authenticated, service_role;
create trigger notification_senders_guard before insert or update or delete on notification_senders
  for each row execute function notification_senders_guard();

-- Recipients: a teammate's (or a data script's). Consent fields and the
-- delivery test only through the functions; a changed phone starts over.
create function notification_recipients_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller text := crm_caller();
  v_consent_changed boolean;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id) or v_caller = 'superuser' then return old; end if;
    if v_caller <> 'team' then
      raise exception 'crm_lite: only a teammate removes a recipient' using errcode = 'insufficient_privilege';
    end if;
    if exists (select 1 from notification_jobs where recipient_id = old.id)
       or exists (select 1 from notification_consent_events where recipient_id = old.id) then
      raise exception 'crm_lite: this recipient has consent or messages on record, which are kept; disable it instead'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if v_caller = 'superuser' then return new; end if;
  if crm_in_write() then return new; end if;
  if v_caller not in ('team', 'owner') then
    raise exception 'crm_lite: only a signed-in Compass teammate manages alert recipients' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.consent_status <> 'pending' or new.consent_recorded_by is not null or new.consented_at is not null
       or new.delivery_test_confirmed_at is not null or new.delivery_test_job_id is not null then
      raise exception 'crm_lite: consent is recorded by a teammate with crm_record_notification_consent, never by an insert'
        using errcode = 'check_violation';
    end if;
    if v_caller = 'team' then new.created_by := task_actor(); end if;
    return new;
  end if;
  if new.client_id is distinct from old.client_id then
    raise exception 'crm_lite: a recipient keeps its client' using errcode = 'check_violation';
  end if;
  v_consent_changed := (new.consent_status, new.consent_method, new.consented_at, new.consent_response, new.disclosure_version,
      new.disclosure_url, new.disclosure_acknowledged, new.consent_recorded_by, new.consent_recorded_at, new.opted_out_at,
      new.delivery_test_job_id, new.delivery_test_confirmed_by, new.delivery_test_confirmed_at)
    is distinct from (old.consent_status, old.consent_method, old.consented_at, old.consent_response, old.disclosure_version,
      old.disclosure_url, old.disclosure_acknowledged, old.consent_recorded_by, old.consent_recorded_at, old.opted_out_at,
      old.delivery_test_job_id, old.delivery_test_confirmed_by, old.delivery_test_confirmed_at);
  if new.phone_e164 is distinct from old.phone_e164 then
    if exists (select 1 from notification_jobs where recipient_id = old.id) then
      raise exception 'crm_lite: this recipient has messages on record; add a new recipient for the new number'
        using errcode = 'check_violation';
    end if;
    -- A new number is a new person to ask.
    new.consent_status := 'pending'; new.consent_method := null; new.consented_at := null; new.consent_response := null;
    new.disclosure_version := null; new.disclosure_url := null; new.disclosure_acknowledged := false;
    new.consent_recorded_by := null; new.consent_recorded_at := null; new.opted_out_at := null;
    new.delivery_test_job_id := null; new.delivery_test_confirmed_by := null; new.delivery_test_confirmed_at := null;
    return new;
  end if;
  if v_consent_changed then
    raise exception 'crm_lite: consent and delivery tests change only through the CRM Lite functions' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
revoke all on function notification_recipients_guard() from public, anon, authenticated, service_role;
create trigger notification_recipients_guard before insert or update or delete on notification_recipients
  for each row execute function notification_recipients_guard();

-- ── 5. Notification gates and text ──────────────────────────────────────────
-- Why a recipient cannot be texted now (null = every gate open).
-- p_test: an admin's delivery test, which needs everything except the
-- client's switch and the test itself.
create function crm_notification_block_reason(p_recipient uuid, p_sender uuid, p_test boolean default false) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r record;
  s record;
  st record;
begin
  if crm_caller() not in ('team', 'service', 'superuser') then
    raise exception 'forbidden: alert gates are a teammate''s to read' using errcode = 'insufficient_privilege';
  end if;
  select * into r from notification_recipients where id = p_recipient;
  if not found then return 'recipient_missing'; end if;
  select * into st from crm_lite_settings where client_id = r.client_id;
  if not found or not st.enabled then return 'crm_lite_off'; end if;
  if not p_test and not st.sms_alerts_enabled then return 'sms_alerts_off'; end if;
  if p_sender is null then return 'no_sender'; end if;
  select * into s from notification_senders where id = p_sender;
  if not found then return 'no_sender'; end if;
  if s.verification_status <> 'approved' then return 'sender_not_approved'; end if;
  if not s.enabled then return 'sender_disabled'; end if;
  if not r.enabled then return 'recipient_disabled'; end if;
  if r.consent_status = 'opted_out' then return 'opted_out'; end if;
  if exists (select 1 from notification_opt_outs where sender_id = p_sender and phone_e164 = r.phone_e164 and opted_out) then
    return 'opted_out';
  end if;
  if r.consent_status <> 'granted' then return 'consent_incomplete'; end if;
  if not p_test and r.delivery_test_confirmed_at is null then return 'delivery_test_not_confirmed'; end if;
  return null;
end $$;
revoke all on function crm_notification_block_reason(uuid, uuid, boolean) from public, anon;
grant execute on function crm_notification_block_reason(uuid, uuid, boolean) to authenticated, service_role;
comment on function crm_notification_block_reason(uuid, uuid, boolean) is
  'Null when an inquiry alert may go to this recipient from this sender now; otherwise the first closed gate (CRM Lite).';

-- The alert text: Compass, the business, an authenticated link; never the
-- inquiry's message or the visitor's details.
create function crm_inquiry_alert_text(p_inquiry uuid, p_recipient uuid, p_sender uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select 'Compass Marketing: ' || coalesce(nullif(btrim(st.display_name), ''), c.name)
      || ' has a new website inquiry. Review it: '
      || s.link_base_url
      || case when r.link_target = 'portal' then '/portal/inquiries/' || i.id::text
              else '/clients/' || i.client_id::text || '/inquiries/' || i.id::text end
      || ' Reply STOP to opt out or HELP for help.'
  from inquiries i
  join clients c on c.id = i.client_id
  join notification_recipients r on r.id = p_recipient and r.client_id = i.client_id
  join notification_senders s on s.id = p_sender
  left join crm_lite_settings st on st.client_id = i.client_id
  where i.id = p_inquiry
$$;
revoke all on function crm_inquiry_alert_text(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ── 6. Inquiry intake (inquiry-intake function only) ────────────────────────
create function crm_ingest_inquiry(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_source uuid := nullif(p->>'source_id', '')::uuid;
  v_sub text := btrim(coalesce(p->>'submission_id', ''));
  v_name text := btrim(coalesce(p->>'name', ''));
  v_email text := nullif(lower(btrim(coalesce(p->>'email', ''))), '');
  v_phone text := nullif(btrim(coalesce(p->>'phone', '')), '');
  v_message text := coalesce(p->>'message', '');
  v_hash text := lower(coalesce(p->>'payload_sha256', ''));
  v_email_status text := coalesce(nullif(p->>'email_status', ''), 'not_reported');
  v_email_id text := nullif(btrim(coalesce(p->>'email_provider_id', '')), '');
  v_submitted timestamptz;
  v_src record;
  v_st record;
  v_dup record;
  v_phone_e164 text;
  v_contact uuid;
  v_contact_created boolean := false;
  v_inquiry uuid;
  r record;
  v_reason text;
  v_jobs jsonb := '[]'::jsonb;
  v_job uuid;
  v_rank_new int;
  v_rank_old int;
begin
  if crm_caller() <> 'service' then
    raise exception 'forbidden: inquiries are recorded by the inquiry-intake function only' using errcode = 'insufficient_privilege';
  end if;
  if v_source is null then raise exception 'invalid: source_id' using errcode = '22023'; end if;
  if v_sub !~ '^[A-Za-z0-9._:-]{8,100}$' then raise exception 'invalid: submission_id' using errcode = '22023'; end if;
  if v_email_status not in ('not_reported', 'failed', 'accepted') then raise exception 'invalid: email_status' using errcode = '22023'; end if;
  if v_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid: payload_sha256' using errcode = '22023'; end if;

  select s.id, s.client_id, s.enabled, s.label into v_src from inquiry_sources s where s.id = v_source;
  if not found then raise exception 'not_found: no such inquiry source' using errcode = 'P0002'; end if;

  perform pg_advisory_xact_lock(hashtextextended('compass.inquiry:' || v_source::text || ':' || v_sub, 0));
  perform set_config('compass.crm_write', 'on', true);

  -- A retry of a submission already recorded: the first record stands; only
  -- the website's email outcome may move forward (failed → accepted).
  select id, client_id, email_status, payload_sha256 into v_dup from inquiries where source_id = v_source and submission_id = v_sub
    for update;
  if found then
    v_rank_new := case v_email_status when 'accepted' then 2 when 'failed' then 1 else 0 end;
    v_rank_old := case v_dup.email_status when 'accepted' then 2 when 'failed' then 1 else 0 end;
    if v_rank_new > v_rank_old then
      update inquiries set email_status = v_email_status, email_provider_id = coalesce(v_email_id, email_provider_id),
        email_reported_at = now() where id = v_dup.id;
      insert into inquiry_events (client_id, inquiry_id, kind, detail, actor_kind, actor_name)
      values (v_dup.client_id, v_dup.id, 'email_reported', jsonb_build_object('email_status', v_email_status, 'retry', true),
        'website', v_src.label);
    end if;
    perform set_config('compass.crm_write', '', true);
    return jsonb_build_object('duplicate', true, 'inquiry_id', v_dup.id, 'payload_matches', v_dup.payload_sha256 = v_hash);
  end if;

  -- A new submission: the source and the client must be on.
  if not v_src.enabled then raise exception 'not_enabled: this inquiry source is disabled' using errcode = 'P0001'; end if;
  select * into v_st from crm_lite_settings where client_id = v_src.client_id;
  if not found or not v_st.enabled then
    raise exception 'not_enabled: CRM Lite is not enabled for this client' using errcode = 'P0001';
  end if;

  if length(v_name) = 0 or length(v_name) > 200 then raise exception 'invalid: name' using errcode = '22023'; end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'invalid: email' using errcode = '22023';
  end if;
  if length(btrim(v_message)) = 0 or length(v_message) > 10000 then raise exception 'invalid: message' using errcode = '22023'; end if;
  if v_email is null and v_phone is null then raise exception 'invalid: an inquiry needs an email or a phone' using errcode = '22023'; end if;
  begin
    v_submitted := coalesce(nullif(p->>'submitted_at', '')::timestamptz, now());
  exception when others then
    raise exception 'invalid: submitted_at' using errcode = '22023';
  end;
  -- A clock far off is recorded as received now, never in the future.
  if v_submitted > now() + interval '5 minutes' or v_submitted < now() - interval '7 days' then v_submitted := now(); end if;
  v_phone_e164 := crm_phone_e164(v_phone);

  -- The contact, within this client only: same email, else same phone,
  -- else a new one. Never another client's.
  perform pg_advisory_xact_lock(hashtextextended('compass.crm_contact:' || v_src.client_id::text, 0));
  if v_email is not null then
    select id into v_contact from contacts where client_id = v_src.client_id and lower(email) = v_email
      order by created_at limit 1;
  end if;
  if v_contact is null and v_phone_e164 is not null then
    select id into v_contact from contacts where client_id = v_src.client_id and phone_e164 = v_phone_e164;
  end if;
  if v_contact is null then
    perform set_config('compass.communications_write', 'on', true);
    insert into contacts (client_id, first_name, phone_e164, email, source, notes)
    values (v_src.client_id, left(v_name, 200), v_phone_e164, v_email, 'web_form', 'From a website inquiry')
    returning id into v_contact;
    perform set_config('compass.communications_write', '', true);
    v_contact_created := true;
  end if;

  insert into inquiries (client_id, source_id, submission_id, contact_id, name, email, phone, phone_e164, location, service_type,
    budget, message, page_url, submitted_at, payload_sha256, email_status, email_provider_id, email_reported_at)
  values (v_src.client_id, v_source, v_sub, v_contact, v_name, v_email, left(v_phone, 60), v_phone_e164,
    nullif(left(btrim(coalesce(p->>'location', '')), 200), ''), nullif(left(btrim(coalesce(p->>'service_type', '')), 200), ''),
    nullif(left(btrim(coalesce(p->>'budget', '')), 200), ''), v_message,
    case when coalesce(p->>'page_url', '') ~ '^https://' then left(p->>'page_url', 2000) end,
    v_submitted, v_hash, v_email_status, v_email_id, case when v_email_status <> 'not_reported' then now() end)
  returning id into v_inquiry;
  insert into inquiry_events (client_id, inquiry_id, kind, to_status, detail, actor_kind, actor_name)
  values (v_src.client_id, v_inquiry, 'received', 'new',
    jsonb_build_object('source', v_src.label, 'email_status', v_email_status), 'website', v_src.label);

  -- One alert job per recipient. A closed gate blocks the job for good, so
  -- turning alerts on later never texts about this inquiry.
  for r in select id, phone_e164 from notification_recipients where client_id = v_src.client_id and channel = 'sms' order by created_at loop
    v_reason := crm_notification_block_reason(r.id, v_st.sms_sender_id, false);
    insert into notification_jobs (client_id, kind, inquiry_id, recipient_id, sender_id, status, block_reason, to_e164, from_e164,
      body, next_attempt_at)
    values (v_src.client_id, 'inquiry_alert', v_inquiry, r.id, v_st.sms_sender_id,
      case when v_reason is null then 'queued' else 'blocked' end, v_reason, r.phone_e164,
      (select phone_e164 from notification_senders where id = v_st.sms_sender_id),
      coalesce(crm_inquiry_alert_text(v_inquiry, r.id, v_st.sms_sender_id),
        'Compass Marketing: you have a new website inquiry. Reply STOP to opt out or HELP for help.'),
      case when v_reason is null then now() end)
    returning id into v_job;
    v_jobs := v_jobs || jsonb_build_object('job_id', v_job, 'status', case when v_reason is null then 'queued' else 'blocked' end,
      'block_reason', v_reason);
  end loop;
  perform set_config('compass.crm_write', '', true);

  return jsonb_build_object('duplicate', false, 'inquiry_id', v_inquiry, 'client_id', v_src.client_id, 'contact_id', v_contact,
    'contact_created', v_contact_created, 'jobs', v_jobs);
end $$;
revoke all on function crm_ingest_inquiry(jsonb) from public, anon, authenticated;
grant execute on function crm_ingest_inquiry(jsonb) to service_role;

-- The source behind a key, for the intake function's token check.
create function crm_inquiry_source(p_key text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when crm_caller() = 'service' then (
    select jsonb_build_object('id', s.id, 'client_id', s.client_id, 'enabled', s.enabled, 'secret_name', s.secret_name,
      'client_enabled', coalesce(st.enabled, false))
    from inquiry_sources s left join crm_lite_settings st on st.client_id = s.client_id
    where s.source_key = p_key) end
$$;
revoke all on function crm_inquiry_source(text) from public, anon, authenticated;
grant execute on function crm_inquiry_source(text) to service_role;

-- The crm-lite function records that it issued (or rotated) a source token.
create function crm_record_token_issued(p_source uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text;
begin
  if crm_caller() <> 'service' then
    raise exception 'forbidden: tokens are issued by the crm-lite function only' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from team_members where id = p_actor and role = 'admin') then
    raise exception 'forbidden: only an admin issues an intake token' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.crm_write', 'on', true);
  update inquiry_sources set token_issued_at = now(), token_issued_by = p_actor where id = p_source
    returning secret_name into v_name;
  perform set_config('compass.crm_write', '', true);
  if v_name is null then raise exception 'not_found: no such inquiry source' using errcode = 'P0002'; end if;
  return jsonb_build_object('source_id', p_source, 'secret_name', v_name);
end $$;
revoke all on function crm_record_token_issued(uuid, uuid) from public, anon, authenticated;
grant execute on function crm_record_token_issued(uuid, uuid) to service_role;

-- ── 7. Follow-up: status and notes (teammate or the client's portal) ───────
-- The caller's identity for an inquiry, or an error. Portal contacts act
-- only on their own client's inquiries while its portal access is on.
create function crm_inquiry_actor(p_inquiry uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_caller text := crm_caller();
  v_client uuid;
  v_member record;
  v_portal record;
begin
  select client_id into v_client from inquiries where id = p_inquiry;
  if v_caller = 'team' then
    if v_client is null then raise exception 'not_found: no such inquiry' using errcode = 'P0002'; end if;
    select id, name into v_member from team_members where auth_user_id = auth.uid();
    return jsonb_build_object('kind', 'team', 'client_id', v_client, 'team_member_id', v_member.id, 'name', v_member.name);
  end if;
  if v_caller = 'portal' then
    -- Another client's inquiry and a missing one look the same.
    if v_client is null or v_client <> portal_client_id()
       or not exists (select 1 from crm_lite_settings where client_id = v_client and enabled and portal_enabled) then
      raise exception 'not_found: no such inquiry' using errcode = 'P0002';
    end if;
    select id, coalesce(nullif(btrim(name), ''), email) as name into v_portal
    from portal_users where auth_user_id = auth.uid() and is_active and client_id = v_client limit 1;
    return jsonb_build_object('kind', 'portal', 'client_id', v_client, 'portal_user_id', v_portal.id, 'name', v_portal.name);
  end if;
  raise exception 'forbidden: only a Compass teammate or the client''s own portal sign-in follows up an inquiry'
    using errcode = 'insufficient_privilege';
end $$;
revoke all on function crm_inquiry_actor(uuid) from public, anon, authenticated, service_role;

create function crm_inquiry_set_status(p_inquiry uuid, p_status text, p_expected text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor jsonb := crm_inquiry_actor(p_inquiry);
  v_old text;
begin
  if p_status not in ('new', 'contacted', 'closed') then
    raise exception 'invalid: status must be new, contacted or closed' using errcode = '22023';
  end if;
  select status into v_old from inquiries where id = p_inquiry for update;
  if p_expected is not null and v_old <> p_expected then
    raise exception 'changed: this inquiry is now %; reload and try again', v_old using errcode = 'P0001';
  end if;
  if v_old = p_status then
    return jsonb_build_object('inquiry_id', p_inquiry, 'status', v_old, 'changed', false);
  end if;
  perform set_config('compass.crm_write', 'on', true);
  update inquiries set status = p_status, status_changed_at = now() where id = p_inquiry;
  insert into inquiry_events (client_id, inquiry_id, kind, from_status, to_status, actor_kind, actor_team_member_id,
    actor_portal_user_id, actor_name)
  values ((v_actor->>'client_id')::uuid, p_inquiry, 'status_changed', v_old, p_status, v_actor->>'kind',
    nullif(v_actor->>'team_member_id', '')::uuid, nullif(v_actor->>'portal_user_id', '')::uuid, v_actor->>'name');
  perform set_config('compass.crm_write', '', true);
  return jsonb_build_object('inquiry_id', p_inquiry, 'status', p_status, 'changed', true, 'from', v_old);
end $$;
revoke all on function crm_inquiry_set_status(uuid, text, text) from public, anon;
grant execute on function crm_inquiry_set_status(uuid, text, text) to authenticated;

create function crm_inquiry_add_note(p_inquiry uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor jsonb := crm_inquiry_actor(p_inquiry);
  v_body text := btrim(coalesce(p_body, ''));
  v_note uuid;
begin
  if length(v_body) = 0 then raise exception 'empty: the note is empty' using errcode = '22023'; end if;
  if length(v_body) > 5000 then raise exception 'too_long: a note is at most 5,000 characters' using errcode = '22023'; end if;
  perform set_config('compass.crm_write', 'on', true);
  insert into inquiry_notes (client_id, inquiry_id, body, author_kind, author_team_member_id, author_portal_user_id, author_name)
  values ((v_actor->>'client_id')::uuid, p_inquiry, v_body, v_actor->>'kind', nullif(v_actor->>'team_member_id', '')::uuid,
    nullif(v_actor->>'portal_user_id', '')::uuid, coalesce(v_actor->>'name', 'Unknown'))
  returning id into v_note;
  insert into inquiry_events (client_id, inquiry_id, kind, detail, actor_kind, actor_team_member_id, actor_portal_user_id, actor_name)
  values ((v_actor->>'client_id')::uuid, p_inquiry, 'note_added', jsonb_build_object('note_id', v_note), v_actor->>'kind',
    nullif(v_actor->>'team_member_id', '')::uuid, nullif(v_actor->>'portal_user_id', '')::uuid, v_actor->>'name');
  perform set_config('compass.crm_write', '', true);
  return jsonb_build_object('note_id', v_note, 'inquiry_id', p_inquiry);
end $$;
revoke all on function crm_inquiry_add_note(uuid, text) from public, anon;
grant execute on function crm_inquiry_add_note(uuid, text) to authenticated;

-- ── 8. Consent, sender approval, the switch, delivery tests ─────────────────
-- A signed-in teammate records the recipient's consent exactly as given.
create function crm_record_notification_consent(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := nullif(p->>'recipient_id', '')::uuid;
  v_status text := coalesce(p->>'status', 'granted');
  v_method text := nullif(btrim(coalesce(p->>'consent_method', '')), '');
  v_response text := nullif(btrim(coalesce(p->>'consent_response', '')), '');
  v_version text := nullif(btrim(coalesce(p->>'disclosure_version', '')), '');
  v_url text := nullif(btrim(coalesce(p->>'disclosure_url', '')), '');
  v_ack boolean := coalesce((p->>'disclosure_acknowledged')::boolean, false);
  v_at timestamptz;
  v_old record;
  v_actor uuid;
begin
  if crm_caller() <> 'team' then
    raise exception 'forbidden: consent is recorded by a signed-in Compass teammate' using errcode = 'insufficient_privilege';
  end if;
  v_actor := task_actor();
  select * into v_old from notification_recipients where id = v_id for update;
  if not found then raise exception 'not_found: no such recipient' using errcode = 'P0002'; end if;
  if v_status not in ('granted', 'revoked') then raise exception 'invalid: status must be granted or revoked' using errcode = '22023'; end if;

  perform set_config('compass.crm_write', 'on', true);
  if v_status = 'granted' then
    if v_old.consent_status = 'opted_out' and exists (select 1 from notification_opt_outs
         where phone_e164 = v_old.phone_e164 and opted_out) then
      raise exception 'opted_out: this number texted STOP; only the recipient lifts that (START)' using errcode = 'P0001';
    end if;
    begin
      v_at := nullif(p->>'consented_at', '')::timestamptz;
    exception when others then
      raise exception 'invalid: consented_at' using errcode = '22023';
    end;
    if v_at is null then raise exception 'incomplete: the date consent was given is required' using errcode = '22023'; end if;
    if v_at > now() + interval '5 minutes' then raise exception 'invalid: consent cannot be in the future' using errcode = '22023'; end if;
    if v_method is null or v_method not in ('verbal', 'written', 'email', 'text_reply', 'web_form', 'other') then
      raise exception 'incomplete: how consent was given is required' using errcode = '22023';
    end if;
    if v_response is null then raise exception 'incomplete: the recipient''s actual response is required' using errcode = '22023'; end if;
    if v_version is null then raise exception 'incomplete: the disclosure version shown is required' using errcode = '22023'; end if;
    if not v_ack then raise exception 'incomplete: the recipient must have acknowledged the disclosure' using errcode = '22023'; end if;
    update notification_recipients set consent_status = 'granted', consent_method = v_method, consented_at = v_at,
      consent_response = v_response, disclosure_version = v_version, disclosure_url = v_url, disclosure_acknowledged = true,
      consent_recorded_by = v_actor, consent_recorded_at = now(), opted_out_at = null
    where id = v_id;
  else
    if v_old.consent_status not in ('granted', 'pending') then
      raise exception 'invalid: consent is %', v_old.consent_status using errcode = '22023';
    end if;
    update notification_recipients set consent_status = 'revoked', consent_recorded_by = coalesce(consent_recorded_by, v_actor),
      consent_recorded_at = coalesce(consent_recorded_at, now()) where id = v_id;
  end if;
  insert into notification_consent_events (client_id, recipient_id, phone_e164, from_status, to_status, consent_method,
    consented_at, consent_response, disclosure_version, disclosure_url, detail, actor_kind, actor_id)
  values (v_old.client_id, v_id, v_old.phone_e164, v_old.consent_status, v_status, v_method, v_at, v_response, v_version, v_url,
    nullif(btrim(coalesce(p->>'detail', '')), ''), 'team', v_actor);
  perform set_config('compass.crm_write', '', true);
  return jsonb_build_object('recipient_id', v_id, 'consent_status', v_status);
end $$;
revoke all on function crm_record_notification_consent(jsonb) from public, anon;
grant execute on function crm_record_notification_consent(jsonb) to authenticated;

-- An admin turns a client's alerts on (every gate checked) or off.
create function crm_set_sms_alerts(p_client uuid, p_enabled boolean, p_sender uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_st record;
  v_sender uuid;
  v_ready int;
begin
  if not crm_is_admin() then
    raise exception 'forbidden: only a Compass admin switches SMS alerts' using errcode = 'insufficient_privilege';
  end if;
  select * into v_st from crm_lite_settings where client_id = p_client for update;
  if not found or not v_st.enabled then
    raise exception 'not_enabled: CRM Lite is not enabled for this client' using errcode = 'P0001';
  end if;
  perform set_config('compass.crm_write', 'on', true);
  if not p_enabled then
    update crm_lite_settings set sms_alerts_enabled = false where client_id = p_client;
    perform set_config('compass.crm_write', '', true);
    return jsonb_build_object('client_id', p_client, 'sms_alerts_enabled', false);
  end if;
  v_sender := coalesce(p_sender, v_st.sms_sender_id);
  if v_sender is null or not exists (select 1 from notification_senders where id = v_sender and verification_status = 'approved' and enabled) then
    raise exception 'sender_not_approved: the alert sender''s verification is not recorded approved and enabled' using errcode = 'P0001';
  end if;
  select count(*) into v_ready from notification_recipients r
  where r.client_id = p_client and r.enabled and r.consent_status = 'granted' and r.delivery_test_confirmed_at is not null
    and not exists (select 1 from notification_opt_outs o where o.sender_id = v_sender and o.phone_e164 = r.phone_e164 and o.opted_out)
    and exists (select 1 from notification_jobs j where j.id = r.delivery_test_job_id and j.sender_id = v_sender);
  if v_ready = 0 then
    raise exception 'no_ready_recipient: no recipient has complete consent and a confirmed delivery test from this sender'
      using errcode = 'P0001';
  end if;
  update crm_lite_settings set sms_alerts_enabled = true, sms_sender_id = v_sender, sms_alerts_enabled_at = now(),
    sms_alerts_enabled_by = task_actor()
  where client_id = p_client;
  perform set_config('compass.crm_write', '', true);
  return jsonb_build_object('client_id', p_client, 'sms_alerts_enabled', true, 'ready_recipients', v_ready);
end $$;
revoke all on function crm_set_sms_alerts(uuid, boolean, uuid) from public, anon;
grant execute on function crm_set_sms_alerts(uuid, boolean, uuid) to authenticated;

-- An admin chooses the client's alert sender (alerts stay off).
create function crm_set_sms_sender(p_client uuid, p_sender uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not crm_is_admin() then
    raise exception 'forbidden: only a Compass admin chooses the alert sender' using errcode = 'insufficient_privilege';
  end if;
  if p_sender is not null and not exists (select 1 from notification_senders where id = p_sender) then
    raise exception 'not_found: no such sender' using errcode = 'P0002';
  end if;
  if not exists (select 1 from crm_lite_settings where client_id = p_client) then
    raise exception 'not_enabled: CRM Lite has no settings for this client' using errcode = 'P0001';
  end if;
  perform set_config('compass.crm_write', 'on', true);
  update crm_lite_settings set sms_sender_id = p_sender, sms_alerts_enabled = false where client_id = p_client;
  perform set_config('compass.crm_write', '', true);
  return jsonb_build_object('client_id', p_client, 'sms_sender_id', p_sender, 'sms_alerts_enabled', false);
end $$;
revoke all on function crm_set_sms_sender(uuid, uuid) from public, anon;
grant execute on function crm_set_sms_sender(uuid, uuid) to authenticated;

-- The crm-lite function opens a delivery test for an admin (checked by the
-- function and again here). Idempotent on request_id.
create function crm_notification_begin_test(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_recipient uuid := nullif(p->>'recipient_id', '')::uuid;
  v_request uuid := nullif(p->>'request_id', '')::uuid;
  v_actor uuid := nullif(p->>'actor_id', '')::uuid;
  v_r record;
  v_st record;
  v_s record;
  v_reason text;
  v_job uuid;
  v_dup record;
begin
  if crm_caller() <> 'service' then
    raise exception 'forbidden: delivery tests are sent by the crm-lite function only' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from team_members where id = v_actor and role = 'admin') then
    raise exception 'forbidden: only an admin sends a delivery test' using errcode = 'insufficient_privilege';
  end if;
  if v_request is null then raise exception 'invalid: request_id' using errcode = '22023'; end if;
  select id, status, client_id into v_dup from notification_jobs where request_id = v_request;
  if found then return jsonb_build_object('duplicate', true, 'job_id', v_dup.id, 'status', v_dup.status); end if;
  select * into v_r from notification_recipients where id = v_recipient;
  if not found then raise exception 'not_found: no such recipient' using errcode = 'P0002'; end if;
  select * into v_st from crm_lite_settings where client_id = v_r.client_id;
  v_reason := crm_notification_block_reason(v_recipient, v_st.sms_sender_id, true);
  if v_reason is not null then
    raise exception 'blocked: %', v_reason using errcode = 'P0001';
  end if;
  select * into v_s from notification_senders where id = v_st.sms_sender_id;
  perform set_config('compass.crm_write', 'on', true);
  insert into notification_jobs (client_id, kind, recipient_id, sender_id, request_id, status, to_e164, from_e164, body, next_attempt_at, max_attempts)
  values (v_r.client_id, 'delivery_test', v_recipient, v_s.id, v_request, 'queued', v_r.phone_e164, v_s.phone_e164,
    'Compass Marketing: test of inquiry alerts for '
      || coalesce(nullif(btrim(v_st.display_name), ''), (select name from clients where id = v_r.client_id))
      || '. No action needed. Reply STOP to opt out or HELP for help.',
    now(), 1)
  returning id into v_job;
  update notification_recipients set delivery_test_job_id = v_job, delivery_test_confirmed_at = null,
    delivery_test_confirmed_by = null where id = v_recipient;
  perform set_config('compass.crm_write', '', true);
  return jsonb_build_object('duplicate', false, 'job_id', v_job, 'status', 'queued');
end $$;
revoke all on function crm_notification_begin_test(jsonb) from public, anon, authenticated;
grant execute on function crm_notification_begin_test(jsonb) to service_role;

-- An admin confirms the test arrived: Twilio reported it delivered, and the
-- person says they received it.
create function crm_confirm_delivery_test(p_recipient uuid, p_job uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_job record;
begin
  if not crm_is_admin() then
    raise exception 'forbidden: only a Compass admin confirms a delivery test' using errcode = 'insufficient_privilege';
  end if;
  select j.* into v_job from notification_jobs j join notification_recipients r on r.delivery_test_job_id = j.id
  where r.id = p_recipient and j.id = p_job and j.kind = 'delivery_test';
  if not found then raise exception 'not_found: this is not the recipient''s latest delivery test' using errcode = 'P0002'; end if;
  if coalesce(v_job.provider_status, '') <> 'delivered' then
    raise exception 'not_delivered: Twilio has not reported this test delivered (status %)', coalesce(v_job.provider_status, v_job.status)
      using errcode = 'P0001';
  end if;
  perform set_config('compass.crm_write', 'on', true);
  update notification_recipients set delivery_test_confirmed_at = now(), delivery_test_confirmed_by = task_actor() where id = p_recipient;
  perform set_config('compass.crm_write', '', true);
  return jsonb_build_object('recipient_id', p_recipient, 'confirmed', true);
end $$;
revoke all on function crm_confirm_delivery_test(uuid, uuid) from public, anon;
grant execute on function crm_confirm_delivery_test(uuid, uuid) to authenticated;

-- ── 9. Dispatch (crm-lite function only) ────────────────────────────────────
-- Claims due jobs: queued ones whose gates are still open (re-checked now;
-- a closed gate blocks the job) and that are fresh (< 24 h). Each claimed
-- job is 'sending' with one more attempt, before anything reaches Twilio.
create function crm_notification_claim(p_limit int default 5) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j record;
  v_reason text;
  v_out jsonb := '[]'::jsonb;
  v_sender record;
begin
  if crm_caller() <> 'service' then
    raise exception 'forbidden: jobs are claimed by the crm-lite function only' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.crm_write', 'on', true);
  for j in
    select * from notification_jobs
    where status = 'queued' and coalesce(next_attempt_at, now()) <= now()
    order by created_at
    limit greatest(1, least(coalesce(p_limit, 5), 25))
    for update skip locked
  loop
    if j.created_at < now() - interval '24 hours' then
      update notification_jobs set status = 'blocked', block_reason = 'stale', next_attempt_at = null where id = j.id;
      continue;
    end if;
    v_reason := crm_notification_block_reason(j.recipient_id, j.sender_id, j.kind = 'delivery_test');
    if v_reason is null and j.kind = 'inquiry_alert'
       and (select sms_sender_id from crm_lite_settings where client_id = j.client_id) is distinct from j.sender_id then
      v_reason := 'sender_changed';
    end if;
    if v_reason is not null then
      update notification_jobs set status = 'blocked', block_reason = v_reason, next_attempt_at = null where id = j.id;
      continue;
    end if;
    select * into v_sender from notification_senders where id = j.sender_id;
    update notification_jobs set status = 'sending', attempts = attempts + 1, last_attempt_at = now(), next_attempt_at = null,
      from_e164 = v_sender.phone_e164
    where id = j.id;
    v_out := v_out || jsonb_build_object('job_id', j.id, 'attempt', j.attempts + 1, 'to', j.to_e164, 'from', v_sender.phone_e164,
      'body', j.body, 'account_sid', v_sender.provider_account_sid, 'messaging_service_sid', v_sender.messaging_service_sid,
      'kind', j.kind, 'since', now());
  end loop;
  perform set_config('compass.crm_write', '', true);
  return v_out;
end $$;
revoke all on function crm_notification_claim(int) from public, anon, authenticated;
grant execute on function crm_notification_claim(int) to service_role;

-- Jobs whose outcome is unknown (the send's answer never came back, or a
-- dispatcher died mid-send): checked against Twilio before any resend.
create function crm_notification_claim_unknown(p_limit int default 5) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j record;
  v_out jsonb := '[]'::jsonb;
begin
  if crm_caller() <> 'service' then
    raise exception 'forbidden: jobs are reconciled by the crm-lite function only' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.crm_write', 'on', true);
  update notification_jobs set status = 'unknown', error_message = coalesce(error_message, 'The send did not finish; checking Twilio before any resend.')
  where status = 'sending' and last_attempt_at < now() - interval '10 minutes';
  for j in
    select n.*, s.provider_account_sid, s.phone_e164 as sender_phone from notification_jobs n
    join notification_senders s on s.id = n.sender_id
    where n.status = 'unknown' and n.provider_message_sid is null and n.reconcile_checks < 12
      and coalesce(n.next_attempt_at, now()) <= now()
    order by n.last_attempt_at
    limit greatest(1, least(coalesce(p_limit, 5), 25))
    for update of n skip locked
  loop
    update notification_jobs set reconcile_checks = reconcile_checks + 1, next_attempt_at = now() + interval '5 minutes' where id = j.id;
    v_out := v_out || jsonb_build_object('job_id', j.id, 'to', j.to_e164, 'from', j.sender_phone, 'body', j.body,
      'account_sid', j.provider_account_sid, 'since', j.last_attempt_at - interval '2 minutes', 'attempts', j.attempts,
      'max_attempts', j.max_attempts);
  end loop;
  perform set_config('compass.crm_write', '', true);
  return v_out;
end $$;
revoke all on function crm_notification_claim_unknown(int) from public, anon, authenticated;
grant execute on function crm_notification_claim_unknown(int) to service_role;

-- Records what happened to one attempt.
--   accepted   Twilio created the message (sid)            → sent
--   rejected   Twilio refused it, permanently              → failed
--   transient  Twilio refused it before accepting (429, …) → queued again with
--              backoff, or failed after max_attempts
--   unknown    no answer we can trust                      → unknown (no resend)
--   found      reconciliation found it on Twilio (sid)     → sent
--   absent     reconciliation: Twilio has no such message  → queued again (or failed)
create function crm_notification_result(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := nullif(p->>'job_id', '')::uuid;
  v_outcome text := p->>'outcome';
  v_sid text := nullif(p->>'message_sid', '');
  v_status text := lower(coalesce(nullif(p->>'provider_status', ''), 'queued'));
  j record;
  v_new text;
begin
  if crm_caller() <> 'service' then
    raise exception 'forbidden: results are recorded by the crm-lite function only' using errcode = 'insufficient_privilege';
  end if;
  select * into j from notification_jobs where id = v_id for update;
  if not found then raise exception 'not_found: no such job' using errcode = 'P0002'; end if;
  if v_outcome in ('accepted', 'found') and (v_sid is null or v_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$') then
    raise exception 'invalid: an accepted message needs its sid' using errcode = '22023';
  end if;
  if communication_status_rank(v_status) < 0 then v_status := 'queued'; end if;
  perform set_config('compass.crm_write', 'on', true);
  if v_outcome in ('accepted', 'found') then
    if j.status not in ('sending', 'unknown') and j.provider_message_sid is not null then
      perform set_config('compass.crm_write', '', true);
      return jsonb_build_object('job_id', v_id, 'status', j.status, 'ignored', true);
    end if;
    update notification_jobs set status = 'sent', provider_message_sid = coalesce(provider_message_sid, v_sid),
      provider_status = case when communication_status_rank(v_status) > communication_status_rank(coalesce(provider_status, 'pending'))
                             then v_status else provider_status end,
      provider_status_at = now(), sent_at = coalesce(sent_at, now()), error_code = null, error_message = null, next_attempt_at = null
    where id = v_id;
    v_new := 'sent';
  elsif v_outcome = 'rejected' then
    update notification_jobs set status = 'failed', error_code = nullif(p->>'error_code', ''),
      error_message = left(coalesce(p->>'error_message', 'Twilio refused the message'), 300), next_attempt_at = null
    where id = v_id and status in ('sending', 'unknown');
    v_new := 'failed';
  elsif v_outcome in ('transient', 'absent') then
    v_new := case when j.attempts >= j.max_attempts then 'failed' else 'queued' end;
    update notification_jobs set status = v_new, error_code = nullif(p->>'error_code', ''),
      error_message = left(coalesce(p->>'error_message', case when v_outcome = 'absent'
        then 'Twilio has no record of the earlier attempt; safe to send again' else 'Twilio could not take the message yet' end), 300),
      next_attempt_at = case when v_new = 'queued' then now() + (interval '2 minutes' * power(3, greatest(j.attempts - 1, 0))) end
    where id = v_id and status in ('sending', 'unknown');
  elsif v_outcome = 'unknown' then
    update notification_jobs set status = 'unknown', error_message = left(coalesce(p->>'error_message',
        'No answer from Twilio; checking before any resend'), 300), next_attempt_at = now() + interval '2 minutes'
    where id = v_id and status = 'sending';
    v_new := 'unknown';
  else
    raise exception 'invalid: outcome' using errcode = '22023';
  end if;
  perform set_config('compass.crm_write', '', true);
  return jsonb_build_object('job_id', v_id, 'status', v_new);
end $$;
revoke all on function crm_notification_result(jsonb) from public, anon, authenticated;
grant execute on function crm_notification_result(jsonb) to service_role;

-- Twilio's status callback for an alert (twilio-webhook, signature checked).
-- Forward-only; the callback's account must be the job's sender.
create function crm_notification_record_status(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid := nullif(p->>'job_id', '')::uuid;
  v_sid text := p->>'message_sid';
  v_status text := lower(coalesce(p->>'status', ''));
  j record;
begin
  if crm_caller() <> 'service' then
    raise exception 'forbidden: delivery status is recorded by the twilio-webhook function only' using errcode = 'insufficient_privilege';
  end if;
  if communication_status_rank(v_status) < 0 then raise exception 'invalid: status %', v_status using errcode = '22023'; end if;
  select n.*, s.provider_account_sid into j from notification_jobs n join notification_senders s on s.id = n.sender_id
  where (v_id is not null and n.id = v_id) or (v_id is null and n.provider_message_sid = v_sid)
  for update of n;
  if not found then raise exception 'not_found: no such alert' using errcode = 'P0002'; end if;
  if lower(j.provider_account_sid) <> lower(coalesce(p->>'account_sid', '')) then
    raise exception 'forbidden: that account did not send this alert' using errcode = 'insufficient_privilege';
  end if;
  if j.provider_message_sid is not null and j.provider_message_sid <> v_sid then
    raise exception 'forbidden: that message is not this alert' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.crm_write', 'on', true);
  if communication_status_rank(v_status) > communication_status_rank(coalesce(j.provider_status, 'pending')) then
    update notification_jobs set provider_status = v_status, provider_status_at = now(),
      provider_message_sid = coalesce(provider_message_sid, v_sid),
      -- A callback for a job whose send answer was lost proves it was accepted.
      status = case when status in ('sending', 'unknown') then 'sent' else status end,
      sent_at = case when status in ('sending', 'unknown') then coalesce(sent_at, now()) else sent_at end,
      delivered_at = case when v_status = 'delivered' then now() else delivered_at end,
      error_code = case when v_status in ('failed', 'undelivered') then nullif(p->>'error_code', '') else error_code end,
      error_message = case when v_status in ('failed', 'undelivered') then left(nullif(p->>'error_message', ''), 300) else error_message end
    where id = j.id;
  end if;
  perform set_config('compass.crm_write', '', true);
  return jsonb_build_object('job_id', j.id, 'provider_status', crm_greatest_status(j.provider_status, v_status));
end $$;

create function crm_greatest_status(a text, b text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when communication_status_rank(b) > communication_status_rank(coalesce(a, 'pending')) then b else a end
$$;
revoke all on function crm_greatest_status(text, text) from public, anon;
grant execute on function crm_greatest_status(text, text) to authenticated, service_role;
revoke all on function crm_notification_record_status(jsonb) from public, anon, authenticated;
grant execute on function crm_notification_record_status(jsonb) to service_role;

-- Is this Twilio account a Compass alert sender? (twilio-webhook routing)
create function crm_notification_sender_known(p_account_sid text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select crm_caller() = 'service' and exists (select 1 from notification_senders where lower(provider_account_sid) = lower(p_account_sid))
$$;
revoke all on function crm_notification_sender_known(text) from public, anon, authenticated;
grant execute on function crm_notification_sender_known(text) to service_role;

-- STOP / START / HELP texted to an alert sender. STOP blocks every alert
-- from this sender to the phone, for every client, at once. START lifts
-- that block; a teammate then records consent again. HELP is recorded (the
-- reply is Twilio's, per docs/crm-lite.md). Idempotent on the MessageSid.
create function crm_notification_keyword(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sid text := p->>'message_sid';
  v_kw text := upper(coalesce(p->>'keyword', ''));
  v_from text := p->>'from';
  v_sender record;
  r record;
  n int := 0;
begin
  if crm_caller() <> 'service' then
    raise exception 'forbidden: keywords are recorded by the twilio-webhook function only' using errcode = 'insufficient_privilege';
  end if;
  if v_sid is null or v_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$' then raise exception 'invalid: MessageSid' using errcode = '22023'; end if;
  if v_kw not in ('STOP', 'START', 'HELP') then raise exception 'invalid: keyword' using errcode = '22023'; end if;
  if v_from is null or v_from !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'invalid: From' using errcode = '22023'; end if;
  select * into v_sender from notification_senders
  where lower(provider_account_sid) = lower(coalesce(p->>'account_sid', '')) and phone_e164 = p->>'to';
  if not found then raise exception 'unknown_number: % is not a Compass alert sender of that account', p->>'to' using errcode = 'P0002'; end if;

  perform pg_advisory_xact_lock(hashtextextended('compass.crm_keyword:' || v_sid, 0));
  if exists (select 1 from notification_inbound_keywords where provider_message_sid = v_sid) then
    return jsonb_build_object('duplicate', true, 'keyword', v_kw);
  end if;
  perform set_config('compass.crm_write', 'on', true);
  insert into notification_inbound_keywords (provider_message_sid, sender_id, from_e164, keyword)
  values (v_sid, v_sender.id, v_from, v_kw);
  if v_kw in ('STOP', 'START') then
    insert into notification_opt_outs (sender_id, phone_e164, opted_out, last_keyword, last_message_sid)
    values (v_sender.id, v_from, v_kw = 'STOP', v_kw, v_sid)
    on conflict (sender_id, phone_e164) do update
      set opted_out = excluded.opted_out, last_keyword = excluded.last_keyword, last_message_sid = excluded.last_message_sid, updated_at = now();
  end if;
  if v_kw = 'STOP' then
    for r in select * from notification_recipients where phone_e164 = v_from and consent_status <> 'opted_out' for update loop
      update notification_recipients set consent_status = 'opted_out', opted_out_at = now() where id = r.id;
      insert into notification_consent_events (client_id, recipient_id, phone_e164, from_status, to_status, detail, actor_kind)
      values (r.client_id, r.id, v_from, r.consent_status, 'opted_out', 'Recipient texted STOP (' || v_sid || ')', 'recipient');
      n := n + 1;
    end loop;
    -- Nothing already waiting goes out after a STOP.
    update notification_jobs set status = 'blocked', block_reason = 'opted_out', next_attempt_at = null
    where to_e164 = v_from and sender_id = v_sender.id and status = 'queued';
  elsif v_kw = 'START' then
    for r in select * from notification_recipients where phone_e164 = v_from and consent_status = 'opted_out' loop
      insert into notification_consent_events (client_id, recipient_id, phone_e164, from_status, to_status, detail, actor_kind)
      values (r.client_id, r.id, v_from, 'opted_out', 'opted_out',
        'Recipient texted START (' || v_sid || '); a teammate records consent again before alerts resume', 'recipient');
    end loop;
  end if;
  perform set_config('compass.crm_write', '', true);
  return jsonb_build_object('duplicate', false, 'keyword', v_kw, 'recipients_opted_out', n);
end $$;
revoke all on function crm_notification_keyword(jsonb) from public, anon, authenticated;
grant execute on function crm_notification_keyword(jsonb) to service_role;

-- ── 10. Portal views ────────────────────────────────────────────────────────
-- The client's own inquiries while its portal access is on. No contacts,
-- email outcome or notification internals.
create view portal_crm_lite as
  select s.client_id, s.portal_enabled
  from crm_lite_settings s
  where s.client_id = (select portal_client_id()) and s.enabled and s.portal_enabled;

create view portal_inquiries as
  select i.id, i.client_id, i.name, i.email, i.phone, i.phone_e164, i.location, i.service_type, i.budget, i.message,
         i.page_url, i.submitted_at, i.received_at, i.status, i.status_changed_at
  from inquiries i
  join crm_lite_settings s on s.client_id = i.client_id and s.enabled and s.portal_enabled
  where i.client_id = (select portal_client_id());

create view portal_inquiry_notes as
  select n.id, n.client_id, n.inquiry_id, n.body, n.author_kind, n.author_name, n.created_at
  from inquiry_notes n
  join crm_lite_settings s on s.client_id = n.client_id and s.enabled and s.portal_enabled
  where n.client_id = (select portal_client_id());

create view portal_inquiry_events as
  select e.id, e.client_id, e.inquiry_id, e.kind, e.from_status, e.to_status, e.actor_kind, e.actor_name, e.created_at
  from inquiry_events e
  join crm_lite_settings s on s.client_id = e.client_id and s.enabled and s.portal_enabled
  where e.client_id = (select portal_client_id()) and e.kind in ('received', 'status_changed', 'note_added');

do $$
declare v text;
begin
  foreach v in array array['portal_crm_lite', 'portal_inquiries', 'portal_inquiry_notes', 'portal_inquiry_events'] loop
    execute format('alter view %I set (security_invoker = false)', v);
    execute format('revoke all on %I from public, anon, authenticated, service_role', v);
    execute format('grant select on %I to authenticated', v);
  end loop;
end $$;

-- ── 11. RLS and grants ──────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['crm_lite_settings', 'inquiry_sources', 'inquiries', 'inquiry_notes', 'inquiry_events',
    'notification_senders', 'notification_recipients', 'notification_consent_events', 'notification_opt_outs',
    'notification_inbound_keywords', 'notification_jobs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "team full access" on %I for all to authenticated using ((select is_team())) with check ((select is_team()))', t);
    execute format('revoke all on %I from public, anon, authenticated, service_role', t);
    execute format('grant select on %I to authenticated, service_role', t);
  end loop;
end $$;
-- What a teammate writes directly (the guards refine it).
grant insert, update on crm_lite_settings to authenticated;
grant insert, update, delete on inquiry_sources to authenticated;
grant insert, update, delete on notification_senders to authenticated;
grant insert, update, delete on notification_recipients to authenticated;

-- ── 12. The dispatch tick: only when something is due ───────────────────────
-- No queued / unknown job → no request at all. While every client's SMS is
-- off, every job is blocked at creation, so this never calls the function.
select cron.schedule(
  'crm-lite-dispatch',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/crm-lite',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_secret('SUPABASE_ANON_KEY'),
      'x-cron-secret', get_secret('SYNC_CRON_SECRET')
    ),
    body := jsonb_build_object('mode', 'dispatch'),
    timeout_milliseconds := 60000
  )
  where exists (select 1 from notification_jobs where status in ('queued', 'unknown', 'sending')
                and coalesce(next_attempt_at, now()) <= now() + interval '1 minute');
  $$
);

-- ── 13. Verify ──────────────────────────────────────────────────────────────
do $$
declare
  t text;
  f record;
  v record;
begin
  foreach t in array array['crm_lite_settings', 'inquiry_sources', 'inquiries', 'inquiry_notes', 'inquiry_events',
    'notification_senders', 'notification_recipients', 'notification_consent_events', 'notification_opt_outs',
    'notification_inbound_keywords', 'notification_jobs'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'crm_lite: RLS is off on %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'insert') then
      raise exception 'crm_lite: anon can reach %', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t
               and (qual is null or qual not like '%is_team()%')) then
      raise exception 'crm_lite: % has a policy that does not read is_team()', t;
    end if;
  end loop;
  foreach t in array array['inquiries', 'inquiry_notes', 'inquiry_events', 'notification_jobs', 'notification_consent_events',
    'notification_opt_outs', 'notification_inbound_keywords'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('service_role', 'public.' || t, 'insert') or has_table_privilege('service_role', 'public.' || t, 'update') then
      raise exception 'crm_lite: % is written directly; it must go through the functions', t;
    end if;
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and (p.proname like 'crm\_%' or p.proname like 'notification\_%') loop
    if has_function_privilege('anon', f.sig, 'execute') then raise exception 'crm_lite: anon may execute %', f.sig; end if;
  end loop;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name in ('inquiry_sources', 'notification_senders', 'notification_recipients', 'crm_lite_settings')
             and column_name ~ '(^|_)(token|auth_token|api_secret|api_key|password)$') then
    raise exception 'crm_lite: a column looks like it holds a credential';
  end if;
  for v in select c.relname, pg_get_viewdef(c.oid) def from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
             and c.relname in ('portal_crm_lite', 'portal_inquiries', 'portal_inquiry_notes', 'portal_inquiry_events') loop
    if v.def not like '%portal_client_id()%' then raise exception 'crm_lite: % does not filter by portal_client_id()', v.relname; end if;
    if has_table_privilege('authenticated', 'public.' || v.relname, 'insert,update,delete')
       or has_table_privilege('anon', 'public.' || v.relname, 'select') then
      raise exception 'crm_lite: % grants more than authenticated SELECT', v.relname;
    end if;
  end loop;
  if exists (select 1 from information_schema.view_table_usage where view_schema = 'public' and view_name like 'portal\_%'
             and (table_name like 'communication%' or table_name = 'contacts' or table_name like 'notification\_%')) then
    raise exception 'crm_lite: a portal view references communications, contacts or notifications';
  end if;
end $$;
