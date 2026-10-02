-- Tests for migration 0063 (Compass Communications: Twilio SMS, Phase 1),
-- run by scripts/test-portal-sandbox.sh on the same replay. Own harness
-- schema (cm) and its own fictional clients; no real Twilio identifier.
--
-- Callers, as they reach production:
--   worker   psql as postgres (the Routine's SQL, data scripts)
--   service  psql as authenticator, role service_role (the communications /
--            twilio-webhook Edge Functions)
--   person   psql as authenticator, role authenticated, team JWT
--   portal   psql as authenticator, role authenticated, portal JWT
--   stranger psql as authenticator, role authenticated, a non-team sign-in
--   admin    psql as supabase_admin (fixtures only: composite keys)

\set team     '00000000-0000-4000-a000-000000000001'
\set pa       '00000000-0000-4000-a000-000000000011'
\set stranger '00000000-0000-4000-a000-000000000014'

\o /dev/null
create schema cm;
create table cm.results (n serial, status text, name text, detail text);
create table cm.saved (k text primary key, v jsonb);
grant usage on schema cm to anon, authenticated, service_role, authenticator;
grant insert, select on cm.results to anon, authenticated, service_role, authenticator;
grant insert, select, update on cm.saved to anon, authenticated, service_role, authenticator;
grant usage on sequence cm.results_n_seq to anon, authenticated, service_role, authenticator;
create function cm.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into cm.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
-- null on success, else "SQLSTATE: message".
create function cm.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function cm.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function cm.id(p_k text) returns uuid language sql immutable as $$ select md5('cm:' || p_k)::uuid $$;
create function cm.sid(p_prefix text, p_k text) returns text language sql immutable as $$ select p_prefix || md5('cm-sid:' || p_k) $$;
create function cm.put(p_k text, p_v jsonb) returns void language sql as $$
  insert into cm.saved (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function cm.get(p_k text) returns jsonb language sql stable as $$ select v from cm.saved where k = p_k $$;
-- A message's state, readable by the harness whoever is calling.
create function cm.msg(p_id uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(m) from communication_messages m where id = p_id
$$;
create function cm.consent(p_client uuid, p_phone text) returns text language sql stable security definer set search_path = public as $$
  select string_agg(status, ',' order by consent_type) from communication_consents where client_id = p_client and phone_e164 = p_phone
$$;
grant execute on all functions in schema cm to anon, authenticated, service_role, authenticator;

insert into clients (id, name, city, state, status) values
  (cm.id('a'), 'Comms Safety Co', 'Hannibal', 'MO', 'active'),
  (cm.id('b'), 'Comms Roofing', 'Wentzville', 'MO', 'active'),
  (cm.id('c'), 'Comms Data Script Client', 'Rolla', 'MO', 'active');

-- ── S. Static ───────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['client_communication_settings', 'communication_accounts', 'communication_messaging_services',
    'communication_numbers', 'communication_compliance_profiles', 'communication_compliance_items', 'contacts',
    'communication_consents', 'communication_consent_events', 'communication_conversations', 'communication_messages'] loop
    perform cm.ok('S1 RLS is on and only the team policy exists on ' || t,
      (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass)
      and (select count(*) = 1 and bool_and(qual like '%is_team()%') from pg_policies where schemaname = 'public' and tablename = t));
    perform cm.ok('S2 anon has no privilege on ' || t,
      not has_table_privilege('anon', 'public.' || t, 'select, insert, update, delete'));
  end loop;
  foreach t in array array['communication_accounts', 'communication_messaging_services', 'communication_numbers',
    'communication_consents', 'communication_consent_events', 'communication_conversations', 'communication_messages'] loop
    perform cm.ok('S3 nobody writes ' || t || ' directly (teammate or service role)',
      not has_table_privilege('authenticated', 'public.' || t, 'insert, update, delete')
      and not has_table_privilege('service_role', 'public.' || t, 'insert, update, delete'));
  end loop;
  perform cm.ok('S4 the webhook / send functions are the service role''s only',
    (select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute')
                     and not has_function_privilege('anon', f, 'execute'))
     from unnest(array['communication_record_inbound(jsonb)', 'communication_begin_outbound(jsonb)', 'communication_mark_sent(jsonb)',
       'communication_record_status(jsonb)', 'communication_register_account(jsonb)', 'communication_register_messaging_service(jsonb)',
       'communication_register_number(jsonb)', 'communication_record_compliance_sync(jsonb)']::regprocedure[]) f));
  perform cm.ok('S5 internal helpers are nobody''s to call (opt-out, status, caller)',
    (select bool_and(not has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute'))
     from unnest(array['communication_opt_out(uuid, text, uuid, timestamptz, text, text, uuid, text)',
       'communication_apply_status(uuid, text, text, text, timestamptz)', 'communication_caller()', 'communication_in_write()']::regprocedure[]) f));
  perform cm.ok('S6 no column holds a credential or a tax id',
    not exists (select 1 from information_schema.columns where table_schema = 'public'
      and (table_name like 'communication%' or table_name = 'contacts')
      and column_name ~ '(^|_)(ein|tax_id|tin|ssn|auth_token|api_secret|api_key|password)($|_)'));
  perform cm.ok('S7 no portal view reads communications',
    not exists (select 1 from information_schema.view_table_usage where view_name like 'portal_%'
      and (table_name like 'communication%' or table_name = 'contacts')));
  perform cm.ok('S8 status rank: forward order, finals equal',
    communication_status_rank('pending') < communication_status_rank('queued')
    and communication_status_rank('queued') < communication_status_rank('sent')
    and communication_status_rank('sent') < communication_status_rank('delivered')
    and communication_status_rank('delivered') = communication_status_rank('failed')
    and communication_status_rank('nonsense') = -1);
end $$;

-- ── W. The worker's SQL (postgres) ──────────────────────────────────────────
-- (A write and its check are separate statements: SQL does not order AND.)
do $$
declare e text; n int;
begin
  perform cm.ok('W1 the worker cannot register a Twilio account',
    cm.try(format('insert into communication_accounts (client_id, provider_account_sid) values (%L, %L)', cm.id('a'), cm.sid('AC', 'w')))
      like '42501%');
  perform cm.ok('W2 the worker cannot call the service functions',
    cm.try(format('select communication_register_account(%L)', jsonb_build_object('client_id', cm.id('a'), 'account_sid', cm.sid('AC', 'w'))))
      like '42501%'
    and cm.try('select communication_record_inbound(''{}'')') like '42501%'
    and cm.try('select communication_begin_outbound(''{}'')') like '42501%');
  perform cm.ok('W3 the worker cannot record consent',
    cm.try(format('select communication_record_consent(%L)', jsonb_build_object('client_id', cm.id('a'), 'phone_e164', '+15735550100',
      'status', 'granted', 'source', 'verbal', 'evidence', 'x'))) like '42501%');
  perform cm.ok('W4 the worker cannot borrow the write flag',
    cm.try(format($q$select set_config('compass.communications_write', 'on', true);
                     insert into communication_accounts (client_id, provider_account_sid) values (%L, %L)$q$, cm.id('a'), cm.sid('AC', 'w')))
      like '42501%');
  perform cm.ok('W5 a data script may create a client''s settings with sending off',
    cm.try(format('insert into client_communication_settings (client_id, enabled) values (%L, true)', cm.id('c'))) is null);
  perform cm.ok('W6 … but never turns outbound sending on',
    cm.try(format('update client_communication_settings set outbound_enabled = true where client_id = %L', cm.id('c'))) like '42501%'
    and cm.try(format('insert into client_communication_settings (client_id, enabled, outbound_enabled) values (%L, true, true)', cm.id('b')))
      like '42501%');
  perform cm.ok('W7 a data script may draft a compliance registration',
    cm.try(format($q$insert into communication_compliance_profiles (id, client_id, profile_type, legal_business_name, use_case_categories)
                     values (%L, %L, 'toll_free_verification', 'Comms Data Script Client LLC', '{CUSTOMER_CARE}')$q$, cm.id('c-tfv'), cm.id('c'))) is null);
  perform cm.ok('W8 … never with Twilio''s status, and never restricted',
    cm.try(format($q$insert into communication_compliance_profiles (client_id, profile_type, status) values (%L, 'secondary_customer_profile', 'approved')$q$, cm.id('c')))
      like '23514%'
    and cm.try(format($q$update communication_compliance_profiles set restriction = 'blocked', restriction_reason = 'x' where id = %L$q$, cm.id('c-tfv')))
      like '42501%');
  n := communication_ensure_checklist(cm.id('c-tfv'));
  perform cm.ok('W9 a data script copies the standard checklist (all open)',
    n = 12
    and (select count(*) = 12 and bool_and(status = 'open') from communication_compliance_items where profile_id = cm.id('c-tfv')));
  perform cm.ok('W10 the worker cannot check an item off',
    cm.try(format($q$update communication_compliance_items set status = 'done', evidence = 'x' where profile_id = %L$q$, cm.id('c-tfv'))) like '42501%');
  perform cm.ok('W11 the worker cannot invent a contact',
    cm.try(format($q$insert into contacts (client_id, phone_e164) values (%L, '+15735550199')$q$, cm.id('a'))) like '42501%');
end $$;

-- ── R. Registry, through the communications function (service) ──────────────
\c - authenticator
set role service_role;
select cm.as_user('service_role', null);
do $$
declare r jsonb;
begin
  r := communication_register_account(jsonb_build_object('client_id', cm.id('a'), 'account_sid', cm.sid('AC', 'a'), 'friendly_name', 'Compass - Comms Safety Co'));
  perform cm.put('acct_a', r);
  perform communication_register_account(jsonb_build_object('client_id', cm.id('b'), 'account_sid', cm.sid('AC', 'b')));
  perform cm.ok('R1 a client gets one subaccount; a second, different one is refused',
    cm.try(format('select communication_register_account(%L)', jsonb_build_object('client_id', cm.id('a'), 'account_sid', cm.sid('AC', 'a2'))))
      like '23505: account_exists%');
  perform cm.ok('R2 one client''s subaccount cannot be registered to another client',
    cm.try(format('select communication_register_account(%L)', jsonb_build_object('client_id', cm.id('c'), 'account_sid', cm.sid('AC', 'a'))))
      like '23505: account_taken%');
  perform cm.ok('R3 registering the same subaccount again is a no-op',
    (communication_register_account(jsonb_build_object('client_id', cm.id('a'), 'account_sid', cm.sid('AC', 'a'), 'friendly_name', 'Compass - Comms Safety Co'))->>'account_id')
      = r->>'account_id');
  perform communication_register_messaging_service(jsonb_build_object('client_id', cm.id('a'), 'service_sid', cm.sid('MG', 'a'),
    'friendly_name', 'Comms Safety Messaging', 'use_case', 'customer_care'));
  perform communication_register_messaging_service(jsonb_build_object('client_id', cm.id('b'), 'service_sid', cm.sid('MG', 'b'), 'friendly_name', 'Comms Roofing Messaging'));
  perform cm.ok('R4 another client''s Messaging Service cannot be attached to a number',
    cm.try(format('select communication_register_number(%L)', jsonb_build_object('client_id', cm.id('a'), 'number_sid', cm.sid('PN', 'x'),
      'phone_number', '+18005550199', 'messaging_service_sid', cm.sid('MG', 'b')))) like 'P0002: not_found%');
  r := communication_register_number(jsonb_build_object('client_id', cm.id('a'), 'number_sid', cm.sid('PN', 'a'), 'phone_number', '+18005550100',
    'friendly_name', 'Comms Safety toll-free', 'number_type', 'toll_free', 'voice', true, 'sms', true, 'messaging_service_sid', cm.sid('MG', 'a')));
  perform cm.put('num_a', r);
  perform communication_register_number(jsonb_build_object('client_id', cm.id('b'), 'number_sid', cm.sid('PN', 'b'), 'phone_number', '+18005550200',
    'number_type', 'toll_free', 'voice', true, 'sms', true, 'messaging_service_sid', cm.sid('MG', 'b')));
  perform cm.ok('R5 the first number is the primary',
    (select is_primary and messaging_service_id is not null from communication_numbers where id = (r->>'number_id')::uuid));
  perform communication_register_number(jsonb_build_object('client_id', cm.id('a'), 'number_sid', cm.sid('PN', 'a'),
    'phone_number', '+18005550100', 'messaging_service_sid', cm.sid('MG', 'a')));
  perform cm.ok('R5b re-registering a number to attach it keeps its capabilities and name',
    (select sms_enabled and voice_enabled and friendly_name = 'Comms Safety toll-free' from communication_numbers where id = (r->>'number_id')::uuid));
  perform cm.ok('R6 a number cannot be moved to another client',
    cm.try(format('select communication_register_number(%L)', jsonb_build_object('client_id', cm.id('b'), 'number_sid', cm.sid('PN', 'a'),
      'phone_number', '+18005550100'))) like '23505: number_taken%');
  perform cm.ok('R7 the service role cannot write a table directly',
    cm.try(format('update communication_numbers set is_primary = false where id = %L', r->>'number_id')) like '42501%');
  perform cm.ok('R8 the service cannot change settings or record a teammate''s consent',
    cm.try(format('insert into client_communication_settings (client_id, enabled) values (%L, true)', cm.id('a'))) like '42501%'
    and cm.try(format('select communication_record_consent(%L)', jsonb_build_object('client_id', cm.id('a'), 'phone_e164', '+15735550101',
      'status', 'granted', 'source', 'verbal', 'evidence', 'x'))) like '42501%');
end $$;
reset role;

-- ── I. Inbound SMS (service, after the webhook's signature check) ───────────
set role service_role;
do $$
declare
  r1 jsonb; r2 jsonb; r3 jsonb; conv uuid;
begin
  r1 := communication_record_inbound(jsonb_build_object('message_sid', cm.sid('SM', 'in1'), 'account_sid', cm.sid('AC', 'a'),
    'to', '+18005550100', 'from', '+15735550101', 'body', 'Do you have a CPR class next week?', 'num_media', '0'));
  perform cm.put('in1', r1);
  conv := (r1->>'conversation_id')::uuid;
  perform cm.ok('I1 an inbound message creates the contact, the thread and the message',
    (r1->>'duplicate')::boolean = false
    and exists (select 1 from contacts where id = (r1->>'contact_id')::uuid and client_id = cm.id('a') and phone_e164 = '+15735550101' and source = 'inbound_sms')
    and (select unread_count = 1 and status = 'open' and last_direction = 'inbound' and last_message_preview like 'Do you have%'
         from communication_conversations where id = conv)
    and (select provider_status = 'received' and direction = 'inbound' and client_id = cm.id('a') from communication_messages where id = (r1->>'message_id')::uuid));
  r2 := communication_record_inbound(jsonb_build_object('message_sid', cm.sid('SM', 'in1'), 'account_sid', cm.sid('AC', 'a'),
    'to', '+18005550100', 'from', '+15735550101', 'body', 'Do you have a CPR class next week?'));
  perform cm.ok('I2 a Twilio retry of the same MessageSid is a no-op (same message, unread unchanged)',
    (r2->>'duplicate')::boolean and r2->>'message_id' = r1->>'message_id'
    and (select count(*) from communication_messages where provider_message_sid = cm.sid('SM', 'in1')) = 1
    and (select unread_count from communication_conversations where id = conv) = 1);
  r3 := communication_record_inbound(jsonb_build_object('message_sid', cm.sid('SM', 'in2'), 'account_sid', cm.sid('AC', 'a'),
    'to', '+18005550100', 'from', '+15735550101', 'body', 'Also, pricing?'));
  perform cm.ok('I3 a second message joins the thread, unread 2, one contact',
    r3->>'conversation_id' = r1->>'conversation_id' and (select unread_count from communication_conversations where id = conv) = 2
    and (select count(*) from contacts where client_id = cm.id('a') and phone_e164 = '+15735550101') = 1);
  perform cm.ok('I4 a number with the wrong account is refused (no cross-tenant routing)',
    cm.try(format('select communication_record_inbound(%L)', jsonb_build_object('message_sid', cm.sid('SM', 'x1'), 'account_sid', cm.sid('AC', 'a'),
      'to', '+18005550200', 'from', '+15735550101'))) like 'P0002: unknown_number%'
    and cm.try(format('select communication_record_inbound(%L)', jsonb_build_object('message_sid', cm.sid('SM', 'x2'), 'account_sid', cm.sid('AC', 'zz'),
      'to', '+18005550100', 'from', '+15735550101'))) like 'P0002: unknown_number%');
  perform cm.ok('I5 a malformed sender or SID is refused',
    cm.try(format('select communication_record_inbound(%L)', jsonb_build_object('message_sid', 'SMnope', 'account_sid', cm.sid('AC', 'a'),
      'to', '+18005550100', 'from', '+15735550101'))) like '22023%'
    and cm.try(format('select communication_record_inbound(%L)', jsonb_build_object('message_sid', cm.sid('SM', 'x3'), 'account_sid', cm.sid('AC', 'a'),
      'to', '+18005550100', 'from', '573-555-0101'))) like '22023%');
  -- The same phone texting client B is B's own contact and thread.
  r3 := communication_record_inbound(jsonb_build_object('message_sid', cm.sid('SM', 'inb'), 'account_sid', cm.sid('AC', 'b'),
    'to', '+18005550200', 'from', '+15735550101', 'body', 'Roof leak'));
  perform cm.put('inb', r3);
  perform cm.ok('I6 the same phone at another client is a separate contact and thread',
    r3->>'contact_id' <> r1->>'contact_id' and r3->>'conversation_id' <> r1->>'conversation_id'
    and (select client_id from contacts where id = (r3->>'contact_id')::uuid) = cm.id('b'));
end $$;
reset role;

-- ── C. Composite keys (fixtures login) ──────────────────────────────────────
\c - supabase_admin
do $$
begin
  perform cm.ok('C1 a message cannot sit in another client''s conversation',
    cm.try(format($q$insert into communication_messages (client_id, conversation_id, provider_message_sid, direction, from_e164, to_e164, provider_status)
                     values (%L, %L, %L, 'inbound', '+15735550101', '+18005550200', 'received')$q$,
      cm.id('b'), cm.get('in1')->>'conversation_id', cm.sid('SM', 'cross'))) like '23503%');
  perform cm.ok('C2 a conversation cannot use another client''s number',
    cm.try(format($q$insert into communication_conversations (client_id, contact_id, communication_number_id) values (%L, %L, %L)$q$,
      cm.id('b'), cm.get('inb')->>'contact_id', cm.get('num_a')->>'number_id')) like '23503%');
  perform cm.ok('C3 a consent cannot point at another client''s contact',
    cm.try(format($q$insert into communication_consents (client_id, contact_id, phone_e164, status, source, consented_at)
                     values (%L, %L, '+15735550101', 'granted', 'verbal', now())$q$, cm.id('b'), cm.get('in1')->>'contact_id')) like '23503%');
end $$;

-- ── P. A teammate (signed in through PostgREST) ─────────────────────────────
\c - authenticator
set role authenticated;
select cm.as_user('authenticated', :'team');
do $$
declare r jsonb; e text; e2 text; n int;
begin
  e := cm.try(format('insert into client_communication_settings (client_id, enabled, outbound_enabled) values (%L, true, true)', cm.id('a')));
  perform cm.ok('P1 a teammate enables communications and outbound for a client',
    e is null
    and (select updated_by is not null from client_communication_settings where client_id = cm.id('a')));
  perform cm.try(format('insert into client_communication_settings (client_id, enabled, outbound_enabled) values (%L, true, false)', cm.id('b')));
  e := cm.try(format('delete from client_communication_settings where client_id = %L', cm.id('b')));
  perform cm.ok('P2 a teammate cannot delete a setting (turn it off instead)', e like '42501%', e);
  perform cm.ok('P3 a teammate sees both clients'' threads (agency-wide team access)',
    (select count(distinct client_id) from communication_conversations where client_id in (cm.id('a'), cm.id('b'))) = 2);
  perform cm.ok('P4 a teammate cannot write messages, threads, consents or numbers directly',
    cm.try(format('update communication_messages set body = ''x'' where id = %L', cm.get('in1')->>'message_id')) like '42501%'
    and cm.try(format('update communication_conversations set unread_count = 0 where id = %L', cm.get('in1')->>'conversation_id')) like '42501%'
    and cm.try(format($q$insert into communication_consents (client_id, phone_e164, status, source, consented_at) values (%L, '+15735550101', 'granted', 'verbal', now())$q$, cm.id('a'))) like '42501%'
    and cm.try('delete from communication_consent_events') like '42501%');
  e := cm.try(format('select communication_update_conversation(%L)', jsonb_build_object('conversation_id', cm.get('in1')->>'conversation_id', 'mark_read', true)));
  perform cm.ok('P5 marking a thread read goes through its function',
    e is null
    and (select unread_count from communication_conversations where id = (cm.get('in1')->>'conversation_id')::uuid) = 0);
  perform cm.ok('P6 a contact''s number cannot change once it has messages, nor can it be deleted',
    cm.try(format($q$update contacts set phone_e164 = '+15735550102' where id = %L$q$, cm.get('in1')->>'contact_id')) like '23514%'
    and cm.try(format('delete from contacts where id = %L', cm.get('in1')->>'contact_id')) like '23514%');
  perform cm.ok('P7 … but its name can be filled in',
    cm.try(format($q$update contacts set first_name = 'Pat', last_name = 'Lee', company = 'River Plant' where id = %L$q$, cm.get('in1')->>'contact_id')) is null);
  e := cm.try(format($q$insert into contacts (id, client_id, first_name, phone_e164, email) values (%L, %L, 'Sam', '+15735550103', 'sam@example.test')$q$,
      cm.id('sam'), cm.id('a')));
  perform cm.ok('P8 a teammate creates a contact for a client',
    e is null
    and (select created_by is not null from contacts where id = cm.id('sam')));
  perform cm.ok('P9 consent needs evidence',
    cm.try(format('select communication_record_consent(%L)', jsonb_build_object('client_id', cm.id('a'), 'phone_e164', '+15735550103',
      'contact_id', cm.id('sam'), 'status', 'granted', 'source', 'web_form'))) like '22023: no_evidence%');
  r := communication_record_consent(jsonb_build_object('client_id', cm.id('a'), 'phone_e164', '+15735550103', 'contact_id', cm.id('sam'),
    'status', 'granted', 'source', 'web_form', 'source_url', 'https://example.test/contact', 'disclosure_version', '2026-10-01',
    'evidence', 'Opt-in box ticked on the contact form'));
  perform cm.ok('P10 a teammate records consent; the history names them',
    (select status = 'granted' and source = 'web_form' and recorded_by is not null from communication_consents where id = (r->>'consent_id')::uuid)
    and (select count(*) = 1 and bool_and(actor_kind = 'team' and actor_id is not null and to_status = 'granted' and from_status is null)
         from communication_consent_events where consent_id = (r->>'consent_id')::uuid));
  perform communication_record_consent(jsonb_build_object('client_id', cm.id('a'), 'phone_e164', '+15735550101', 'contact_id', cm.get('in1')->>'contact_id',
    'status', 'granted', 'source', 'inbound_sms', 'evidence', 'Customer texted first asking about classes and asked us to follow up by text'));
  perform cm.ok('P11 a consent of client A grants nothing at client B',
    cm.consent(cm.id('b'), '+15735550103') is null);
  perform cm.ok('P12 only the teammate functions for a person; the service''s are refused',
    cm.try('select communication_record_inbound(''{}'')') like '42501%'
    and cm.try('select communication_begin_outbound(''{}'')') like '42501%');
  -- Compliance.
  perform cm.ok('P13 a teammate drafts the registrations',
    cm.try(format($q$insert into communication_compliance_profiles (id, client_id, profile_type, legal_business_name, website_url, privacy_url, terms_url)
                     values (%L, %L, 'secondary_customer_profile', 'Comms Safety Co LLC', 'https://example.test', 'https://example.test/privacy', 'https://example.test/terms')$q$,
      cm.id('a-cp'), cm.id('a'))) is null
    and cm.try(format($q$insert into communication_compliance_profiles (id, client_id, profile_type, communication_number_id, use_case_categories, message_volume, opt_in_type)
                     values (%L, %L, 'toll_free_verification', %L, '{CUSTOMER_CARE}', '1,000', 'WEB_FORM')$q$,
      cm.id('a-tfv'), cm.id('a'), cm.get('num_a')->>'number_id')) is null);
  perform cm.ok('P14 a teammate cannot set Twilio''s status',
    cm.try(format($q$update communication_compliance_profiles set status = 'approved' where id = %L$q$, cm.id('a-tfv'))) like '42501%');
  perform cm.ok('P15 linking a Twilio SID is a teammate''s; the shape is checked per type',
    cm.try(format('update communication_compliance_profiles set provider_profile_sid = %L where id = %L', cm.sid('HH', 'a'), cm.id('a-tfv'))) is null
    and cm.try(format('update communication_compliance_profiles set provider_profile_sid = %L where id = %L', cm.sid('HH', 'cp'), cm.id('a-cp'))) like '23514%');
  perform cm.ok('P16 one toll-free verification per number',
    cm.try(format($q$insert into communication_compliance_profiles (client_id, profile_type, communication_number_id) values (%L, 'toll_free_verification', %L)$q$,
      cm.id('a'), cm.get('num_a')->>'number_id')) like '23505%');
  n := communication_ensure_checklist(cm.id('a-tfv'));
  e := cm.try(format($q$update communication_compliance_items set status = 'done' where profile_id = %L and item_key = 'disclosure_rates'$q$, cm.id('a-tfv')));
  e2 := cm.try(format($q$update communication_compliance_items set status = 'done', evidence = 'Live on /contact' where profile_id = %L and item_key = 'disclosure_rates'$q$, cm.id('a-tfv')));
  perform cm.ok('P17 a teammate copies the checklist and checks an item off with evidence (stamped)',
    n = 12 and e like '23514%' and e2 is null
    and (select checked_by is not null and checked_at is not null from communication_compliance_items where profile_id = cm.id('a-tfv') and item_key = 'disclosure_rates'));
  e := cm.try(format($q$update communication_compliance_profiles set restriction = 'restricted' where id = %L$q$, cm.id('a-tfv')));
  e2 := cm.try(format($q$update communication_compliance_profiles set restriction = 'restricted', restriction_reason = 'Carrier filtering reported' where id = %L$q$, cm.id('a-tfv')));
  perform cm.ok('P18 a restriction is a teammate''s call, with a reason, stamped',
    e like '23514%' and e2 is null
    and (select restricted_by is not null from communication_compliance_profiles where id = cm.id('a-tfv')));
  perform cm.try(format($q$update communication_compliance_profiles set restriction = null, restriction_reason = null where id = %L$q$, cm.id('a-tfv')));
end $$;
reset role;

-- ── O. Outbound (service, for a teammate it checked) ────────────────────────
set role service_role;
select cm.as_user('service_role', null);
do $$
declare
  tm uuid := (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001');
  r jsonb; r2 jsonb;
begin
  perform cm.put('tm', to_jsonb(tm));
  r := communication_begin_outbound(jsonb_build_object('request_id', cm.id('req1'), 'client_id', cm.id('a'),
    'contact_id', cm.id('sam'), 'body', 'Hi Sam, your class is Tuesday at 9.', 'sent_by', tm));
  perform cm.put('out1', r);
  perform cm.ok('O1 a send to a consenting contact starts as pending from the primary number through the Messaging Service',
    (r->>'duplicate')::boolean = false and r->>'from' = '+18005550100' and r->>'to' = '+15735550103'
    and r->>'messaging_service_sid' = cm.sid('MG', 'a') and r->>'account_sid' = cm.sid('AC', 'a')
    and (cm.msg((r->>'message_id')::uuid)->>'provider_status') = 'pending');
  r2 := communication_begin_outbound(jsonb_build_object('request_id', cm.id('req1'), 'client_id', cm.id('a'),
    'contact_id', cm.id('sam'), 'body', 'Hi Sam, your class is Tuesday at 9.', 'sent_by', tm));
  perform cm.ok('O2 the same request (a double click) does not send twice',
    (r2->>'duplicate')::boolean and r2->>'message_id' = r->>'message_id'
    and (select count(*) from communication_messages where request_id = cm.id('req1')) = 1);
  perform cm.ok('O3 outbound turned off for the client → refused',
    cm.try(format('select communication_begin_outbound(%L)', jsonb_build_object('request_id', cm.id('req-nc'), 'client_id', cm.id('b'),
      'conversation_id', cm.get('inb')->>'conversation_id', 'body', 'hi', 'sent_by', tm))) like 'P0001: outbound_disabled%');
  perform cm.ok('O4 … and nothing was recorded',
    not exists (select 1 from communication_messages where request_id = cm.id('req-nc')));
  perform cm.ok('O5 a contact of another client cannot be texted from this client',
    cm.try(format('select communication_begin_outbound(%L)', jsonb_build_object('request_id', cm.id('req-x'), 'client_id', cm.id('a'),
      'contact_id', cm.get('inb')->>'contact_id', 'body', 'hi', 'sent_by', tm))) like 'P0002: not_found%');
  perform cm.ok('O6 an empty or over-long message is refused; a non-teammate sender is refused',
    cm.try(format('select communication_begin_outbound(%L)', jsonb_build_object('request_id', cm.id('req-e'), 'client_id', cm.id('a'),
      'contact_id', cm.id('sam'), 'body', '   ', 'sent_by', tm))) like '22023: empty%'
    and cm.try(format('select communication_begin_outbound(%L)', jsonb_build_object('request_id', cm.id('req-l'), 'client_id', cm.id('a'),
      'contact_id', cm.id('sam'), 'body', repeat('x', 1601), 'sent_by', tm))) like '22023: too_long%'
    and cm.try(format('select communication_begin_outbound(%L)', jsonb_build_object('request_id', cm.id('req-s'), 'client_id', cm.id('a'),
      'contact_id', cm.id('sam'), 'body', 'hi', 'sent_by', cm.id('nobody')))) like '42501%');

  -- Twilio answered, then the callbacks (out of order).
  perform communication_mark_sent(jsonb_build_object('message_id', r->>'message_id', 'provider_message_sid', cm.sid('SM', 'out1'), 'provider_status', 'queued'));
  perform cm.ok('O7 Twilio''s answer records the SID and queued',
    (cm.msg((r->>'message_id')::uuid)->>'provider_message_sid') = cm.sid('SM', 'out1')
    and (cm.msg((r->>'message_id')::uuid)->>'provider_status') = 'queued');
  perform communication_record_status(jsonb_build_object('message_sid', cm.sid('SM', 'out1'), 'account_sid', cm.sid('AC', 'a'), 'status', 'delivered'));
  perform cm.ok('O8 delivered is recorded with its time (and sent_at)',
    (cm.msg((r->>'message_id')::uuid)->>'provider_status') = 'delivered'
    and (cm.msg((r->>'message_id')::uuid)->>'delivered_at') is not null and (cm.msg((r->>'message_id')::uuid)->>'sent_at') is not null);
  perform cm.ok('O9 a late "sent" callback does not move it back',
    (communication_record_status(jsonb_build_object('message_sid', cm.sid('SM', 'out1'), 'account_sid', cm.sid('AC', 'a'), 'status', 'sent'))->>'result') = 'unchanged'
    and (cm.msg((r->>'message_id')::uuid)->>'provider_status') = 'delivered');
  perform cm.ok('O10 a callback from another account is refused',
    cm.try(format('select communication_record_status(%L)', jsonb_build_object('message_sid', cm.sid('SM', 'out1'), 'account_sid', cm.sid('AC', 'b'), 'status', 'failed')))
      like '42501%');
  perform cm.ok('O11 an unknown SID answers unknown (no write)',
    (communication_record_status(jsonb_build_object('message_sid', cm.sid('SM', 'never'), 'account_sid', cm.sid('AC', 'a'), 'status', 'delivered'))->>'result') = 'unknown');
  -- A callback that outruns Twilio's answer finds the message by the id in its URL.
  r2 := communication_begin_outbound(jsonb_build_object('request_id', cm.id('req2'), 'client_id', cm.id('a'),
    'contact_id', cm.id('sam'), 'body', 'Reminder: bring ID.', 'sent_by', tm));
  perform communication_record_status(jsonb_build_object('message_sid', cm.sid('SM', 'out2'), 'message_id', r2->>'message_id',
    'account_sid', cm.sid('AC', 'a'), 'status', 'sent'));
  perform communication_mark_sent(jsonb_build_object('message_id', r2->>'message_id', 'provider_message_sid', cm.sid('SM', 'out2'), 'provider_status', 'queued'));
  perform cm.ok('O12 a callback before Twilio''s answer is kept; the answer does not move it back',
    (cm.msg((r2->>'message_id')::uuid)->>'provider_message_sid') = cm.sid('SM', 'out2')
    and (cm.msg((r2->>'message_id')::uuid)->>'provider_status') = 'sent');
  -- Twilio refused the API call.
  r2 := communication_begin_outbound(jsonb_build_object('request_id', cm.id('req3'), 'client_id', cm.id('a'),
    'contact_id', cm.id('sam'), 'body', 'Third.', 'sent_by', tm));
  perform communication_mark_sent(jsonb_build_object('message_id', r2->>'message_id', 'error_code', '21211', 'error_message', 'Invalid To'));
  perform cm.ok('O13 a refused API call is failed with Twilio''s code',
    (cm.msg((r2->>'message_id')::uuid)->>'provider_status') = 'failed' and (cm.msg((r2->>'message_id')::uuid)->>'error_code') = '21211');
end $$;
reset role;

-- ── X. Opt-out and opt-in by the recipient ──────────────────────────────────
set role service_role;
do $$
declare
  tm uuid := (cm.get('tm')#>>'{}')::uuid;
  r jsonb;
begin
  r := communication_record_inbound(jsonb_build_object('message_sid', cm.sid('SM', 'stop'), 'account_sid', cm.sid('AC', 'a'),
    'to', '+18005550100', 'from', '+15735550103', 'body', 'STOP', 'opt_out_type', 'STOP'));
  perform cm.ok('X1 STOP marks the consent opted_out, recorded as the recipient''s, with the message',
    cm.consent(cm.id('a'), '+15735550103') = 'opted_out'
    and exists (select 1 from communication_consent_events e join communication_consents c on c.id = e.consent_id
                where c.client_id = cm.id('a') and c.phone_e164 = '+15735550103' and e.to_status = 'opted_out'
                  and e.actor_kind = 'recipient' and e.message_id = (r->>'message_id')::uuid)
    and (cm.msg((r->>'message_id')::uuid)->>'opt_out_type') = 'STOP');
  perform cm.ok('X2 an opted-out recipient cannot be sent to',
    cm.try(format('select communication_begin_outbound(%L)', jsonb_build_object('request_id', cm.id('req-stop'), 'client_id', cm.id('a'),
      'contact_id', cm.id('sam'), 'body', 'Are you sure?', 'sent_by', tm))) like 'P0001: opted_out%');
  perform cm.ok('X3 the opt-out is this client''s only',
    cm.consent(cm.id('b'), '+15735550103') is null);
  r := communication_record_inbound(jsonb_build_object('message_sid', cm.sid('SM', 'stop2'), 'account_sid', cm.sid('AC', 'a'),
    'to', '+18005550100', 'from', '+15735550177', 'body', 'stop', 'opt_out_type', 'STOP'));
  perform cm.ok('X4 STOP from a number with no consent on record is remembered',
    cm.consent(cm.id('a'), '+15735550177') = 'opted_out');
  r := communication_record_inbound(jsonb_build_object('message_sid', cm.sid('SM', 'help'), 'account_sid', cm.sid('AC', 'a'),
    'to', '+18005550100', 'from', '+15735550101', 'body', 'HELP', 'opt_out_type', 'HELP'));
  perform cm.ok('X5 HELP is recorded on the message and changes no consent',
    (cm.msg((r->>'message_id')::uuid)->>'opt_out_type') = 'HELP' and cm.consent(cm.id('a'), '+15735550101') = 'granted');
end $$;
reset role;

set role authenticated;
select cm.as_user('authenticated', :'team');
do $$
declare e text;
begin
  perform cm.ok('X6 a teammate cannot overwrite a recipient''s opt-out',
    cm.try(format('select communication_record_consent(%L)', jsonb_build_object('client_id', cm.id('a'), 'phone_e164', '+15735550103',
      'status', 'granted', 'source', 'verbal', 'evidence', 'They said it was fine on the phone'))) like 'P0001: opted_out%');
  e := cm.try(format('select communication_record_consent(%L)', jsonb_build_object('client_id', cm.id('a'), 'phone_e164', '+15735550101',
      'status', 'revoked', 'evidence', 'Asked by phone to stop texting')));
  perform cm.ok('X7 a teammate can revoke consent (and it is history)',
    e is null
    and cm.consent(cm.id('a'), '+15735550101') = 'revoked');
end $$;
reset role;

set role service_role;
select cm.as_user('service_role', null);
do $$
declare
  tm uuid := (cm.get('tm')#>>'{}')::uuid;
  r jsonb; e text;
begin
  perform cm.ok('X8 revoked consent blocks sending',
    cm.try(format('select communication_begin_outbound(%L)', jsonb_build_object('request_id', cm.id('req-rev'), 'client_id', cm.id('a'),
      'conversation_id', cm.get('in1')->>'conversation_id', 'body', 'hi', 'sent_by', tm))) like 'P0001: no_consent%');
  r := communication_record_inbound(jsonb_build_object('message_sid', cm.sid('SM', 'start'), 'account_sid', cm.sid('AC', 'a'),
    'to', '+18005550100', 'from', '+15735550103', 'body', 'START', 'opt_out_type', 'START'));
  perform cm.ok('X9 START from the recipient restores consent, sourced to the keyword',
    cm.consent(cm.id('a'), '+15735550103') = 'granted'
    and (select source = 'keyword_start' and evidence like '%' || cm.sid('SM', 'start') || '%' from communication_consents
         where client_id = cm.id('a') and phone_e164 = '+15735550103'));
  r := communication_record_inbound(jsonb_build_object('message_sid', cm.sid('SM', 'start2'), 'account_sid', cm.sid('AC', 'a'),
    'to', '+18005550100', 'from', '+15735550101', 'body', 'START', 'opt_out_type', 'START'));
  perform cm.ok('X10 START does not undo a teammate''s revocation',
    cm.consent(cm.id('a'), '+15735550101') = 'revoked');
  -- Twilio's 21610 on a send: the recipient had opted out at Twilio.
  r := communication_begin_outbound(jsonb_build_object('request_id', cm.id('req-21610'), 'client_id', cm.id('a'),
    'contact_id', cm.id('sam'), 'body', 'Hello again', 'sent_by', tm));
  perform communication_mark_sent(jsonb_build_object('message_id', r->>'message_id', 'error_code', '21610',
    'error_message', 'Attempt to send to unsubscribed recipient'));
  perform cm.ok('X11 Twilio''s 21610 refusal marks the recipient opted_out (provider)',
    cm.consent(cm.id('a'), '+15735550103') = 'opted_out'
    and exists (select 1 from communication_consent_events e join communication_consents c on c.id = e.consent_id
                where c.client_id = cm.id('a') and c.phone_e164 = '+15735550103' and e.actor_kind = 'provider'));
  -- Compliance sync.
  e := cm.try(format('select communication_record_compliance_sync(%L)', jsonb_build_object('profile_id', cm.id('a-tfv'),
      'provider_profile_sid', cm.sid('HH', 'a'), 'provider_status', 'TWILIO_APPROVED', 'status', 'approved')));
  perform cm.ok('X12 a sync records Twilio''s status (raw and mapped)',
    e is null
    and (select provider_status = 'TWILIO_APPROVED' and status = 'approved' and approved_at is not null and last_synced_at is not null
         from communication_compliance_profiles where id = cm.id('a-tfv')));
  perform cm.ok('X13 a sync for a relinked registration is refused',
    cm.try(format('select communication_record_compliance_sync(%L)', jsonb_build_object('profile_id', cm.id('a-tfv'),
      'provider_profile_sid', cm.sid('HH', 'other'), 'provider_status', 'TWILIO_REJECTED', 'status', 'rejected'))) like 'P0001: changed%');
end $$;
reset role;

-- ── T. Tenancy: portal contact, stranger, anon ──────────────────────────────
set role authenticated;
select cm.as_user('authenticated', :'pa');
do $$
declare t text; n bigint;
begin
  foreach t in array array['client_communication_settings', 'communication_accounts', 'communication_messaging_services',
    'communication_numbers', 'communication_compliance_profiles', 'communication_compliance_items', 'contacts',
    'communication_consents', 'communication_consent_events', 'communication_conversations', 'communication_messages'] loop
    execute format('select count(*) from %I', t) into n;
    perform cm.ok('T1 a portal contact sees nothing in ' || t, n = 0, n::text);
  end loop;
  perform cm.ok('T2 a portal contact cannot create a contact or turn communications on',
    cm.try(format($q$insert into contacts (client_id, phone_e164) values (%L, '+15735550111')$q$, cm.id('a'))) is not null
    and cm.try(format('insert into client_communication_settings (client_id, enabled) values (%L, true)', cm.id('c'))) is not null);
end $$;
select cm.as_user('authenticated', :'stranger');
do $$
declare t text; n bigint;
begin
  foreach t in array array['communication_numbers', 'contacts', 'communication_conversations', 'communication_messages',
    'communication_compliance_profiles', 'communication_accounts'] loop
    execute format('select count(*) from %I', t) into n;
    perform cm.ok('T3 a non-team sign-in sees nothing in ' || t, n = 0, n::text);
  end loop;
  perform cm.ok('T4 a non-team sign-in cannot use the teammate functions',
    cm.try(format('select communication_update_conversation(%L)', jsonb_build_object('conversation_id', cm.get('in1')->>'conversation_id', 'mark_read', true)))
      like '42501%');
end $$;
reset role;
set role anon;
select cm.as_user('anon', null);
do $$
begin
  perform cm.ok('T5 anon is refused outright',
    cm.try('select count(*) from communication_messages') like '42501%'
    and cm.try('select count(*) from contacts') like '42501%'
    and cm.try('select communication_record_consent(''{}'')') like '42501%');
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── D. A client's deletion cascades through everything ──────────────────────
\c - supabase_admin
do $$
declare e text;
begin
  e := cm.try(format('delete from clients where id = %L', cm.id('b')));
  perform cm.ok('D1 deleting a client removes its communications (guards let the cascade through)',
    e is null
    and not exists (select 1 from communication_messages where client_id = cm.id('b'))
    and not exists (select 1 from contacts where client_id = cm.id('b'))
    and exists (select 1 from communication_messages where client_id = cm.id('a')));
end $$;

\c - postgres
\o
\pset footer off
select status, count(*) from cm.results group by status order by status;
select n, status, name, detail from cm.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from cm.results where status = 'fail';
  if f > 0 then raise exception '% communications check(s) failed', f; end if;
end $$;
