-- Tests for CRM Lite (20261011220000_crm_lite.sql), run by
-- scripts/test-portal-sandbox.sh on the same replay. Own harness schema (cl)
-- and its own fictional clients, people and numbers (555 numbers, example
-- domains); no real Twilio identifier. Nothing is sent anywhere.
--
-- Callers, as they reach production:
--   worker   psql as postgres (the Routine's SQL, data scripts)
--   service  psql as authenticator, role service_role (inquiry-intake,
--            crm-lite, twilio-webhook)
--   admin    psql as authenticator, role authenticated, the admin team JWT
--   member   the same with a non-admin teammate's JWT
--   portal   a portal contact's JWT (client X or client Y)
--   stranger a signed-in non-team, non-portal user; anon

\set admin    '00000000-0000-4000-a000-000000000001'
\set member   '00000000-0000-4000-a000-0000000000c1'
\set px       '00000000-0000-4000-a000-0000000000c2'
\set py       '00000000-0000-4000-a000-0000000000c3'
\set stranger '00000000-0000-4000-a000-000000000014'

\o /dev/null
create schema cl;
create table cl.results (n serial, status text, name text, detail text);
create table cl.saved (k text primary key, v jsonb);
grant usage on schema cl to anon, authenticated, service_role, authenticator;
grant insert, select on cl.results to anon, authenticated, service_role, authenticator;
grant insert, select, update on cl.saved to anon, authenticated, service_role, authenticator;
grant usage on sequence cl.results_n_seq to anon, authenticated, service_role, authenticator;
create function cl.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into cl.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function cl.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function cl.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function cl.id(p_k text) returns uuid language sql immutable as $$ select md5('cl:' || p_k)::uuid $$;
create function cl.sid(p_prefix text, p_k text) returns text language sql immutable as $$ select p_prefix || md5('cl-sid:' || p_k) $$;
create function cl.put(p_k text, p_v jsonb) returns void language sql as $$
  insert into cl.saved (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function cl.get(p_k text) returns jsonb language sql stable as $$ select v from cl.saved where k = p_k $$;
-- Rows as they are, whoever is calling (the harness's eyes only).
create function cl.inq(p_id uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(i) from inquiries i where id = p_id $$;
create function cl.job(p_id uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(j) from notification_jobs j where id = p_id $$;
create function cl.rcpt(p_id uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(r) from notification_recipients r where id = p_id $$;
create function cl.count(p_sql text) returns bigint language plpgsql security definer set search_path = public as $$
declare n bigint; begin execute format('select count(*) from (%s) q', p_sql) into n; return n; end $$;
-- A payload as inquiry-intake sends it.
create function cl.payload(p_source text, p_sub text, p_email text, p_extra jsonb default '{}') returns jsonb language sql stable as $$
  select jsonb_build_object('source_id', cl.id(p_source), 'submission_id', p_sub, 'name', 'Pat Visitor', 'email', p_email,
    'phone', '(618) 555-0142', 'location', 'Edwardsville, IL', 'service_type', 'Home Interiors', 'budget', 'Not sure yet',
    'message', 'We would like help with our living room. Private details stay out of texts.',
    'page_url', 'https://www.example.test/contact/', 'submitted_at', now(), 'payload_sha256', md5(p_sub) || md5(p_sub || 'x'),
    'email_status', 'accepted', 'email_provider_id', 'email-' || p_sub) || p_extra
$$;
grant execute on all functions in schema cl to anon, authenticated, service_role, authenticator;

-- ── Fixtures (as the cluster superuser) ─────────────────────────────────────
\c - supabase_admin
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-0000000000c1', 'crm-member@compassmarketing.ai', now()),
  ('00000000-0000-4000-a000-0000000000c2', 'owner-x@example.test', now()),
  ('00000000-0000-4000-a000-0000000000c3', 'owner-y@example.test', now());
insert into team_members (auth_user_id, name, email, role) values
  ('00000000-0000-4000-a000-0000000000c1', 'CRM Member', 'crm-member@compassmarketing.ai', 'member');
insert into clients (id, name, city, state, status) values
  (cl.id('x'), 'Lite Interiors X', 'Edwardsville', 'IL', 'active'),
  (cl.id('y'), 'Lite Roofing Y', 'Wentzville', 'MO', 'active'),
  (cl.id('z'), 'Lite Off Z', 'Rolla', 'MO', 'active');
insert into portal_users (client_id, email, name, is_active) values
  (cl.id('x'), 'owner-x@example.test', 'Owner X', true),
  (cl.id('y'), 'owner-y@example.test', 'Owner Y', true);
\c - postgres

-- ── S. Static ───────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['crm_lite_settings', 'inquiry_sources', 'inquiries', 'inquiry_notes', 'inquiry_events',
    'notification_senders', 'notification_recipients', 'notification_consent_events', 'notification_opt_outs',
    'notification_inbound_keywords', 'notification_jobs'] loop
    perform cl.ok('S1 RLS on, team policy only: ' || t,
      (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass)
      and (select count(*) = 1 and bool_and(qual like '%is_team()%') from pg_policies where schemaname = 'public' and tablename = t));
    perform cl.ok('S2 anon has no privilege on ' || t, not has_table_privilege('anon', 'public.' || t, 'select, insert, update, delete'));
  end loop;
  foreach t in array array['inquiries', 'inquiry_notes', 'inquiry_events', 'notification_jobs', 'notification_consent_events',
    'notification_opt_outs', 'notification_inbound_keywords'] loop
    perform cl.ok('S3 nobody writes ' || t || ' directly',
      not has_table_privilege('authenticated', 'public.' || t, 'insert, update, delete')
      and not has_table_privilege('service_role', 'public.' || t, 'insert, update, delete'));
  end loop;
  perform cl.ok('S4 the intake / dispatch / webhook functions are the service role''s only',
    (select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute'))
     from unnest(array['crm_ingest_inquiry(jsonb)', 'crm_inquiry_source(text)', 'crm_record_token_issued(uuid, uuid)',
       'crm_notification_begin_test(jsonb)', 'crm_notification_claim(integer)', 'crm_notification_claim_unknown(integer)',
       'crm_notification_result(jsonb)', 'crm_notification_record_status(jsonb)', 'crm_notification_keyword(jsonb)',
       'crm_notification_sender_known(text)']::regprocedure[]) f));
  perform cl.ok('S5 a submission is unique per source (database guarantee)',
    exists (select 1 from pg_constraint where conrelid = 'public.inquiries'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (source_id, submission_id)'));
  perform cl.ok('S6 one alert job per inquiry and recipient (database guarantee)',
    exists (select 1 from pg_indexes where indexname = 'notification_jobs_one_alert'));
  perform cl.ok('S7 no portal view reads contacts, communications or notifications',
    not exists (select 1 from information_schema.view_table_usage where view_name like 'portal\_%'
      and (table_name = 'contacts' or table_name like 'communication%' or table_name like 'notification\_%')));
  perform cl.ok('S8 portal views carry no email outcome, payload hash or contact link',
    not exists (select 1 from information_schema.columns where table_name in ('portal_inquiries', 'portal_inquiry_events', 'portal_inquiry_notes')
      and column_name in ('email_status', 'email_provider_id', 'payload_sha256', 'contact_id', 'detail', 'source_id', 'submission_id')));
  perform cl.ok('S9 the dispatch tick is scheduled', exists (select 1 from cron.job where jobname = 'crm-lite-dispatch'));
end $$;

-- ── W. The worker's SQL (postgres) ──────────────────────────────────────────
do $$
declare e text;
begin
  -- A data script may create settings, a source, a sender and a recipient.
  insert into crm_lite_settings (client_id, enabled, portal_enabled) values (cl.id('x'), true, true), (cl.id('y'), true, true);
  insert into crm_lite_settings (client_id, enabled) values (cl.id('z'), false);
  insert into inquiry_sources (id, client_id, source_key, label, site_url, enabled, secret_name) values
    (cl.id('src-x'), cl.id('x'), 'lite-x-website', 'Lite X website', 'https://www.example.test', true, 'CRM_INTAKE_LITE_X_WEBSITE'),
    (cl.id('src-y'), cl.id('y'), 'lite-y-website', 'Lite Y website', 'https://y.example.test', true, 'CRM_INTAKE_LITE_Y_WEBSITE'),
    (cl.id('src-z'), cl.id('z'), 'lite-z-website', 'Lite Z website', null, true, 'CRM_INTAKE_LITE_Z_WEBSITE'),
    (cl.id('src-off'), cl.id('x'), 'lite-x-old-form', 'Old form', null, false, 'CRM_INTAKE_LITE_X_OLD_FORM');
  insert into notification_senders (id, sender_key, label, provider_account_sid, phone_e164)
  values (cl.id('sender'), 'lite_alerts', 'Compass alerts (test)', cl.sid('AC', 'sender'), '+18885550199');
  insert into notification_recipients (id, client_id, phone_e164, name) values
    (cl.id('rx'), cl.id('x'), '+16185550100', 'Owner X mobile'),
    (cl.id('ry'), cl.id('y'), '+16185550100', 'Same phone, client Y');
  perform cl.ok('W0 a data script creates settings, sources, a sender and recipients (all off / pending)', true);

  e := cl.try(format('insert into inquiries (client_id, source_id, submission_id, name, email, message, submitted_at, payload_sha256) values (%L, %L, %L, %L, %L, %L, now(), %L)',
    cl.id('x'), cl.id('src-x'), 'worker-forged-1', 'Forged', 'f@example.test', 'x', repeat('c', 64)));
  perform cl.ok('W1 the worker cannot fabricate an inquiry', e like '42501%', e);
  e := cl.try(format('select crm_ingest_inquiry(%L)', cl.payload('src-x', 'worker-forged-2', 'f@example.test')));
  perform cl.ok('W2 the worker cannot call the intake function', e like '42501%', e);
  e := cl.try(format('update crm_lite_settings set sms_alerts_enabled = true, sms_sender_id = %L where client_id = %L', cl.id('sender'), cl.id('x')));
  perform cl.ok('W3 the worker cannot turn SMS alerts on', e like '42501%', e);
  e := cl.try(format('update notification_senders set verification_status = %L where id = %L', 'approved', cl.id('sender')));
  perform cl.ok('W4 the worker cannot approve a sender', e is not null, e);
  e := cl.try(format('update notification_recipients set consent_status = %L where id = %L', 'granted', cl.id('rx')));
  perform cl.ok('W5 the worker cannot mark consent granted', e is not null, e);
  e := cl.try(format('select crm_record_notification_consent(%L)', jsonb_build_object('recipient_id', cl.id('rx'))));
  perform cl.ok('W6 the worker cannot record consent', e like '42501%', e);
  perform set_config('compass.crm_write', 'on', false);
  e := cl.try(format('insert into inquiry_events (client_id, inquiry_id, kind, actor_kind) values (%L, %L, %L, %L)', cl.id('x'), cl.id('nope'), 'received', 'system'));
  perform cl.ok('W7 the worker cannot borrow the write flag', e like '42501%', e);
  perform set_config('compass.crm_write', '', false);
  e := cl.try(format('update inquiry_sources set token_issued_at = now() where id = %L', cl.id('src-x')));
  perform cl.ok('W8 a token is issued only by the crm-lite function', e like '42501%', e);
end $$;

-- ── I. Intake (the inquiry-intake function's identity) ──────────────────────
\c - authenticator
set role service_role;
do $$
declare r jsonb; r2 jsonb; r3 jsonb; r4 jsonb; e text; inq jsonb;
begin
  r := crm_inquiry_source('lite-x-website');
  perform cl.ok('I0 a source key resolves to its own client and secret name (never the caller''s say-so)',
    (r->>'client_id')::uuid = cl.id('x') and r->>'secret_name' = 'CRM_INTAKE_LITE_X_WEBSITE' and (r->>'client_enabled')::boolean);
  perform cl.ok('I0b an unknown key resolves to nothing', crm_inquiry_source('no-such-source') is null);

  r := crm_ingest_inquiry(cl.payload('src-x', 'sub-0001-aaaa', 'Pat@Example.test', jsonb_build_object('client_id', cl.id('y'))));
  perform cl.put('i1', r);
  inq := cl.inq((r->>'inquiry_id')::uuid);
  perform cl.ok('I1 a submission is saved under the source''s client (a client id in the body is ignored)',
    not (r->>'duplicate')::boolean and (inq->>'client_id')::uuid = cl.id('x') and inq->>'status' = 'new'
    and inq->>'message' like 'We would like help%' and inq->>'phone_e164' = '+16185550142' and inq->>'email' = 'pat@example.test'
    and inq->>'location' = 'Edwardsville, IL' and inq->>'service_type' = 'Home Interiors' and inq->>'email_status' = 'accepted', r::text);
  perform cl.ok('I2 a contact is created in that client from the web form',
    (r->>'contact_created')::boolean and cl.count(format('select 1 from contacts where id = %L and client_id = %L and source = %L',
      r->>'contact_id', cl.id('x'), 'web_form')) = 1);
  perform cl.ok('I3 its history starts with "received"',
    cl.count(format('select 1 from inquiry_events where inquiry_id = %L and kind = %L and actor_kind = %L', r->>'inquiry_id', 'received', 'website')) = 1);
  perform cl.ok('I4 an alert job exists but is blocked while SMS is off (sms_alerts_off)',
    jsonb_array_length(r->'jobs') = 1 and r->'jobs'->0->>'status' = 'blocked' and r->'jobs'->0->>'block_reason' = 'sms_alerts_off', r::text);

  r2 := crm_ingest_inquiry(cl.payload('src-x', 'sub-0001-aaaa', 'pat@example.test'));
  perform cl.ok('I5 the same submission id again is the same inquiry (retry is a no-op)',
    (r2->>'duplicate')::boolean and r2->>'inquiry_id' = r->>'inquiry_id'
    and cl.count(format('select 1 from inquiries where source_id = %L and submission_id = %L', cl.id('src-x'), 'sub-0001-aaaa')) = 1
    and cl.count(format('select 1 from notification_jobs where inquiry_id = %L', r->>'inquiry_id')) = 1, r2::text);

  r3 := crm_ingest_inquiry(cl.payload('src-x', 'sub-0002-bbbb', 'PAT@example.test', '{"email_status": "failed"}'));
  perform cl.ok('I6 a separate submission from the same person is a separate inquiry on the same contact',
    not (r3->>'duplicate')::boolean and r3->>'inquiry_id' <> r->>'inquiry_id' and r3->>'contact_id' = r->>'contact_id'
    and not (r3->>'contact_created')::boolean, r3::text);
  perform cl.put('i2', r3);
  r4 := crm_ingest_inquiry(cl.payload('src-x', 'sub-0002-bbbb', 'pat@example.test', '{"email_status": "accepted", "email_provider_id": "email-retry"}'));
  perform cl.ok('I7 a retry moves the website''s email outcome forward (failed → accepted), recorded in history',
    cl.inq((r3->>'inquiry_id')::uuid)->>'email_status' = 'accepted'
    and cl.count(format('select 1 from inquiry_events where inquiry_id = %L and kind = %L', r3->>'inquiry_id', 'email_reported')) = 1);
  r4 := crm_ingest_inquiry(cl.payload('src-x', 'sub-0002-bbbb', 'pat@example.test', '{"email_status": "failed"}'));
  perform cl.ok('I8 ... and never back', cl.inq((r3->>'inquiry_id')::uuid)->>'email_status' = 'accepted');

  r4 := crm_ingest_inquiry(cl.payload('src-y', 'sub-0001-aaaa', 'pat@example.test'));
  perform cl.ok('I9 the same person at another client is that client''s own inquiry and contact (no cross-client match)',
    not (r4->>'duplicate')::boolean and (r4->>'contact_created')::boolean and r4->>'contact_id' <> r->>'contact_id'
    and (cl.inq((r4->>'inquiry_id')::uuid)->>'client_id')::uuid = cl.id('y'), r4::text);
  perform cl.put('iy', r4);

  e := cl.try(format('select crm_ingest_inquiry(%L)', cl.payload('src-off', 'sub-0003-cccc', 'a@example.test')));
  perform cl.ok('I10 a disabled source is refused', e like 'P0001: not_enabled%', e);
  e := cl.try(format('select crm_ingest_inquiry(%L)', cl.payload('src-z', 'sub-0003-cccc', 'a@example.test')));
  perform cl.ok('I11 a client with CRM Lite off is refused', e like 'P0001: not_enabled%', e);
  e := cl.try(format('select crm_ingest_inquiry(%L)', cl.payload('src-x', 'bad id with spaces', 'a@example.test')));
  perform cl.ok('I12 a malformed submission id is refused', e like '22023%', e);
  e := cl.try(format('select crm_ingest_inquiry(%L)', cl.payload('src-x', 'sub-0004-dddd', 'a@example.test', '{"message": "   "}')));
  perform cl.ok('I13 an empty message is refused', e like '22023%', e);
  r4 := crm_ingest_inquiry(cl.payload('src-x', 'sub-0005-eeee', null, '{"phone": "618-555-0142"}'));
  perform cl.ok('I14 no email: matched by phone within the client', r4->>'contact_id' = r->>'contact_id', r4::text);
end $$;
reset role;

-- ── T. Teammates ────────────────────────────────────────────────────────────
set role authenticated;
select cl.as_user('authenticated', :'member') \g /dev/null
do $$
declare r jsonb; e text; v_id uuid := (cl.get('i1')->>'inquiry_id')::uuid;
begin
  perform cl.ok('T1 a teammate reads inquiries, notes and history',
    (select count(*) from inquiries where client_id = cl.id('x')) >= 3 and (select count(*) from inquiry_events where inquiry_id = v_id) >= 1);
  r := crm_inquiry_set_status(v_id, 'contacted', 'new');
  perform cl.ok('T2 a teammate marks it contacted; history says who and when',
    (r->>'changed')::boolean and (select status from inquiries where inquiries.id = v_id) = 'contacted'
    and exists (select 1 from inquiry_events where inquiry_id = v_id and kind = 'status_changed' and from_status = 'new'
      and to_status = 'contacted' and actor_kind = 'team' and actor_name = 'CRM Member' and actor_team_member_id is not null));
  e := cl.try(format('select crm_inquiry_set_status(%L, %L, %L)', v_id, 'closed', 'new'));
  perform cl.ok('T3 a stale page (expected new, now contacted) is refused', e like 'P0001: changed%', e);
  e := cl.try(format('select crm_inquiry_set_status(%L, %L)', v_id, 'archived'));
  perform cl.ok('T4 only new / contacted / closed', e like '22023%', e);
  r := crm_inquiry_add_note(v_id, 'Left a voicemail, will try again Tuesday.');
  perform cl.ok('T5 a note records its author and time',
    exists (select 1 from inquiry_notes where inquiry_notes.id = (r->>'note_id')::uuid and author_kind = 'team' and author_name = 'CRM Member'));
  e := cl.try(format('update inquiry_notes set body = %L where id = %L', 'rewritten', r->>'note_id'));
  perform cl.ok('T6 notes are immutable', e like '42501%', e);
  e := cl.try(format('update inquiries set status = %L where id = %L', 'closed', v_id));
  perform cl.ok('T7 a teammate changes status only through the function (history kept)', e like '42501%', e);
  e := cl.try(format('delete from inquiry_events where inquiry_id = %L', v_id));
  perform cl.ok('T8 history cannot be deleted', e like '42501%', e);
  e := cl.try(format('select crm_set_sms_alerts(%L, true, %L)', cl.id('x'), cl.id('sender')));
  perform cl.ok('T9 a member (not an admin) cannot turn SMS alerts on', e like '42501%', e);
  e := cl.try(format('update notification_senders set verification_status = %L, verification_sid = %L, verification_evidence = %L where id = %L',
    'approved', cl.sid('HH', 'v'), 'x', cl.id('sender')));
  perform cl.ok('T10 a member cannot approve the sender', e like '42501%', e);
end $$;
reset role;

-- ── P. Portal contacts ──────────────────────────────────────────────────────
set role authenticated;
select cl.as_user('authenticated', :'px') \g /dev/null
do $$
declare r jsonb; e text; v_id uuid := (cl.get('i1')->>'inquiry_id')::uuid; v_idy uuid := (cl.get('iy')->>'inquiry_id')::uuid;
begin
  perform cl.ok('P1 the portal contact sees their own client''s inquiries, notes and history',
    (select count(*) from portal_inquiries) >= 3 and (select count(*) from portal_inquiries where client_id <> cl.id('x')) = 0
    and (select count(*) from portal_inquiry_notes where inquiry_id = v_id) = 1
    and (select count(*) from portal_inquiry_events where inquiry_id = v_id) >= 2
    and (select count(*) from portal_crm_lite) = 1);
  perform cl.ok('P2 ... never another client''s', (select count(*) from portal_inquiries where id = v_idy) = 0);
  perform cl.ok('P3 ... and nothing from the base tables or the outbox',
    (select count(*) from inquiries) = 0 and (select count(*) from notification_jobs) = 0 and (select count(*) from contacts) = 0
    and (select count(*) from notification_recipients) = 0);
  r := crm_inquiry_set_status(v_id, 'closed', 'contacted');
  perform cl.ok('P4 the client closes their own inquiry; history names them',
    (r->>'changed')::boolean and exists (select 1 from portal_inquiry_events where inquiry_id = v_id and to_status = 'closed'
      and actor_kind = 'portal' and actor_name = 'Owner X'));
  r := crm_inquiry_set_status(v_id, 'new', 'closed');
  perform cl.ok('P5 ... and reopens it', (select status from portal_inquiries where portal_inquiries.id = v_id) = 'new');
  r := crm_inquiry_add_note(v_id, 'Booked a consultation for Friday.');
  perform cl.ok('P6 the client adds a note under their own name',
    exists (select 1 from portal_inquiry_notes where inquiry_id = v_id and author_kind = 'portal' and author_name = 'Owner X'));
  e := cl.try(format('select crm_inquiry_set_status(%L, %L)', v_idy, 'closed'));
  perform cl.ok('P7 another client''s inquiry looks missing (status)', e like 'P0002: not_found%', e);
  e := cl.try(format('select crm_inquiry_add_note(%L, %L)', v_idy, 'x'));
  perform cl.ok('P8 another client''s inquiry looks missing (note)', e like 'P0002: not_found%', e);
  e := cl.try(format('select crm_record_notification_consent(%L)', jsonb_build_object('recipient_id', cl.id('rx'))));
  perform cl.ok('P9 the client cannot record alert consent', e like '42501%', e);
end $$;
reset role;

-- Portal access switched off for X: the views empty, the actions refused.
\c - supabase_admin
update crm_lite_settings set portal_enabled = false where client_id = cl.id('x');
\c - authenticator
set role authenticated;
select cl.as_user('authenticated', :'px') \g /dev/null
do $$
declare e text;
begin
  perform cl.ok('P10 portal access off: the client sees nothing',
    (select count(*) from portal_inquiries) = 0 and (select count(*) from portal_crm_lite) = 0);
  e := cl.try(format('select crm_inquiry_set_status(%L, %L)', cl.get('i1')->>'inquiry_id', 'closed'));
  perform cl.ok('P11 ... and cannot change anything', e like 'P0002: not_found%', e);
end $$;
reset role;
\c - supabase_admin
update crm_lite_settings set portal_enabled = true where client_id = cl.id('x');

-- ── X. Strangers and anon ───────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select cl.as_user('authenticated', :'stranger') \g /dev/null
do $$
declare e text;
begin
  perform cl.ok('X1 a stranger reads nothing', (select count(*) from portal_inquiries) = 0 and (select count(*) from inquiries) = 0);
  e := cl.try(format('select crm_inquiry_set_status(%L, %L)', cl.get('i1')->>'inquiry_id', 'closed'));
  perform cl.ok('X2 a stranger cannot follow up', e like '42501%', e);
end $$;
reset role;
set role anon;
select cl.as_user('anon', null) \g /dev/null
do $$
begin
  perform cl.ok('X3 anon is refused the views and the functions',
    cl.try('select count(*) from portal_inquiries') like '42501%'
    and cl.try(format('select crm_inquiry_add_note(%L, %L)', cl.get('i1')->>'inquiry_id', 'x')) like '42501%');
end $$;
reset role;

-- ── G. The gates (an admin, step by step) ───────────────────────────────────
set role authenticated;
select cl.as_user('authenticated', :'admin') \g /dev/null
do $$
declare e text; r jsonb;
begin
  e := cl.try(format('update notification_senders set verification_status = %L where id = %L', 'approved', cl.id('sender')));
  perform cl.ok('G1 approval needs the HH sid and evidence', e like '23514%', e);
  e := cl.try(format('update notification_senders set enabled = true where id = %L', cl.id('sender')));
  perform cl.ok('G2 a sender cannot be enabled before approval', e like '23514%', e);
  perform crm_set_sms_sender(cl.id('x'), cl.id('sender'));
  e := cl.try(format('select crm_set_sms_alerts(%L, true, null)', cl.id('x')));
  perform cl.ok('G3 alerts stay off while the sender is not approved', e like 'P0001: sender_not_approved%', e);
  update notification_senders set verification_status = 'approved', verification_sid = cl.sid('HH', 'v'),
    verification_evidence = 'Twilio Console: toll-free verification approved (sandbox fixture)' where id = cl.id('sender');
  update notification_senders set enabled = true where id = cl.id('sender');
  perform cl.ok('G4 the admin records approval; who and when are stamped',
    (select verification_checked_by is not null and verification_checked_at is not null and enabled from notification_senders where id = cl.id('sender')));
  e := cl.try(format('select crm_set_sms_alerts(%L, true, null)', cl.id('x')));
  perform cl.ok('G5 alerts stay off with no consent on record', e like 'P0001: no_ready_recipient%', e);
  perform cl.ok('G5b the gate says why', crm_notification_block_reason(cl.id('rx'), cl.id('sender'), true) = 'consent_incomplete');
  e := cl.try(format('select crm_record_notification_consent(%L)', jsonb_build_object('recipient_id', cl.id('rx'),
    'consented_at', now() - interval '1 day', 'consent_method', 'verbal', 'disclosure_version', '2026-10-11', 'disclosure_acknowledged', true)));
  perform cl.ok('G6 consent without the recipient''s actual response is incomplete', e like '22023: incomplete%', e);
  e := cl.try(format('select crm_record_notification_consent(%L)', jsonb_build_object('recipient_id', cl.id('rx'),
    'consented_at', now() - interval '1 day', 'consent_method', 'verbal', 'consent_response', 'Yes, I agree.', 'disclosure_version', '2026-10-11')));
  perform cl.ok('G7 consent without the disclosure acknowledged is incomplete', e like '22023: incomplete%', e);
  e := cl.try(format('update notification_recipients set consent_status = %L where id = %L', 'granted', cl.id('rx')));
  perform cl.ok('G8 consent is never set directly', e is not null, e);
  r := crm_record_notification_consent(jsonb_build_object('recipient_id', cl.id('rx'), 'consented_at', now() - interval '1 day',
    'consent_method', 'verbal', 'consent_response', 'Yes, I agree to receive Compass CRM inquiry alerts at my confirmed mobile number.',
    'disclosure_version', '2026-10-11', 'disclosure_url', 'https://www.example.test/sms-consent', 'disclosure_acknowledged', true));
  perform cl.ok('G9 complete consent is granted, with its history',
    (select consent_status = 'granted' and consent_recorded_by is not null from notification_recipients where id = cl.id('rx'))
    and exists (select 1 from notification_consent_events where recipient_id = cl.id('rx') and to_status = 'granted' and actor_kind = 'team'));
  e := cl.try(format('select crm_set_sms_alerts(%L, true, null)', cl.id('x')));
  perform cl.ok('G10 alerts stay off until a delivery test is confirmed', e like 'P0001: no_ready_recipient%', e);
end $$;
reset role;

-- The delivery test, as the crm-lite function runs it for the admin.
set role service_role;
do $$
declare r jsonb; c jsonb; e text; v_admin uuid;
begin
  select id into v_admin from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001';
  e := cl.try(format('select crm_notification_begin_test(%L)', jsonb_build_object('recipient_id', cl.id('rx'), 'request_id', cl.id('t1'),
    'actor_id', (select id from team_members where email = 'crm-member@compassmarketing.ai'))));
  perform cl.ok('G11 a member cannot send a delivery test', e like '42501%', e);
  r := crm_notification_begin_test(jsonb_build_object('recipient_id', cl.id('rx'), 'request_id', cl.id('t1'), 'actor_id', v_admin));
  perform cl.ok('G12 the admin''s delivery test is queued (idempotent on its request)',
    r->>'status' = 'queued' and (crm_notification_begin_test(jsonb_build_object('recipient_id', cl.id('rx'), 'request_id', cl.id('t1'),
      'actor_id', v_admin))->>'duplicate')::boolean);
  perform cl.put('test', r);
  c := crm_notification_claim(5);
  perform cl.ok('G13 the dispatcher claims only the test (blocked alerts never)',
    jsonb_array_length(c) = 1 and c->0->>'job_id' = r->>'job_id' and c->0->>'from' = '+18885550199'
    and c->0->>'account_sid' = cl.sid('AC', 'sender') and (cl.job((r->>'job_id')::uuid)->>'status') = 'sending', c::text);
  perform crm_notification_result(jsonb_build_object('job_id', r->>'job_id', 'outcome', 'accepted', 'message_sid', cl.sid('SM', 't1'),
    'provider_status', 'queued'));
  e := cl.try(format('select crm_notification_record_status(%L)', jsonb_build_object('job_id', r->>'job_id', 'message_sid', cl.sid('SM', 't1'),
    'account_sid', cl.sid('AC', 'someone-else'), 'status', 'delivered')));
  perform cl.ok('G14 a status callback from another account is refused', e like '42501%', e);
  perform crm_notification_record_status(jsonb_build_object('job_id', r->>'job_id', 'message_sid', cl.sid('SM', 't1'),
    'account_sid', cl.sid('AC', 'sender'), 'status', 'delivered'));
  perform crm_notification_record_status(jsonb_build_object('job_id', r->>'job_id', 'message_sid', cl.sid('SM', 't1'),
    'account_sid', cl.sid('AC', 'sender'), 'status', 'sent'));
  perform cl.ok('G15 delivery status moves forward only (delivered stays delivered)',
    cl.job((r->>'job_id')::uuid)->>'provider_status' = 'delivered' and cl.job((r->>'job_id')::uuid)->>'status' = 'sent');
end $$;
reset role;

set role authenticated;
select cl.as_user('authenticated', :'admin') \g /dev/null
do $$
declare r jsonb; e text;
begin
  r := crm_confirm_delivery_test(cl.id('rx'), (cl.get('test')->>'job_id')::uuid);
  r := crm_set_sms_alerts(cl.id('x'), true, null);
  perform cl.ok('G16 every gate open: the admin turns alerts on', (r->>'sms_alerts_enabled')::boolean, r::text);
  perform cl.ok('G17 inquiries saved before alerts were on stay blocked (never sent later)',
    not exists (select 1 from notification_jobs where client_id = cl.id('x') and kind = 'inquiry_alert' and status <> 'blocked'));
end $$;
reset role;

set role service_role;
do $$
declare r jsonb; c jsonb; j jsonb; jid uuid; e text;
begin
  r := crm_ingest_inquiry(cl.payload('src-x', 'sub-0100-live', 'new.visitor@example.test'));
  jid := (r->'jobs'->0->>'job_id')::uuid;
  j := cl.job(jid);
  perform cl.ok('G18 a new inquiry queues its alert, naming Compass and the business, with the authenticated link and nothing private',
    j->>'status' = 'queued' and j->>'body' like 'Compass Marketing: Lite Interiors X has a new website inquiry. Review it: https://compass-crm-ten.vercel.app/portal/inquiries/%'
    and j->>'body' like '%Reply STOP to opt out or HELP for help.' and j->>'body' not like '%living room%'
    and j->>'body' not like '%visitor%' and j->>'body' not like '%555-0142%', j::text);
  c := crm_notification_claim(5);
  perform crm_notification_result(jsonb_build_object('job_id', jid, 'outcome', 'unknown', 'error_message', 'timeout'));
  perform cl.ok('G19 an unknown outcome is never claimed for a blind resend',
    cl.job(jid)->>'status' = 'unknown' and jsonb_array_length(crm_notification_claim(5)) = 0);
end $$;
-- Time passes; the unknown job is checked against Twilio first.
\c - supabase_admin
update notification_jobs set next_attempt_at = now() - interval '1 minute' where status = 'unknown';
\c - authenticator
set role service_role;
do $$
declare c jsonb; jid uuid;
begin
  c := crm_notification_claim_unknown(5);
  jid := (c->0->>'job_id')::uuid;
  perform cl.ok('G20 the unknown job is handed out for reconciliation with its exact text and window',
    jsonb_array_length(c) = 1 and c->0->>'body' like 'Compass Marketing:%' and c->0->>'since' is not null, c::text);
  perform crm_notification_result(jsonb_build_object('job_id', jid, 'outcome', 'absent'));
  perform cl.ok('G21 Twilio has no such message: safe to queue again, with backoff',
    cl.job(jid)->>'status' = 'queued' and (cl.job(jid)->>'next_attempt_at')::timestamptz > now());
  perform cl.put('live', jsonb_build_object('job_id', jid));
end $$;
reset role;
\c - supabase_admin
update notification_jobs set next_attempt_at = now() - interval '1 minute' where id = (cl.get('live')->>'job_id')::uuid;
\c - authenticator
set role service_role;
do $$
declare c jsonb; jid uuid := (cl.get('live')->>'job_id')::uuid;
begin
  c := crm_notification_claim(5);
  perform crm_notification_result(jsonb_build_object('job_id', jid, 'outcome', 'transient', 'error_code', '20429'));
  perform cl.ok('G22 a transient refusal (429) retries with backoff', cl.job(jid)->>'status' = 'queued' and (cl.job(jid)->>'attempts')::int = 2);
end $$;
reset role;
\c - supabase_admin
update notification_jobs set next_attempt_at = now() - interval '1 minute' where id = (cl.get('live')->>'job_id')::uuid;
\c - authenticator
set role service_role;
do $$
declare c jsonb; jid uuid := (cl.get('live')->>'job_id')::uuid;
begin
  c := crm_notification_claim(5);
  perform crm_notification_result(jsonb_build_object('job_id', jid, 'outcome', 'transient', 'error_code', '20429'));
  perform cl.ok('G23 after max attempts it fails instead of retrying forever',
    cl.job(jid)->>'status' = 'failed' and (cl.job(jid)->>'attempts')::int = 3);
end $$;
reset role;

-- A queued job older than 24 hours is never sent.
\c - authenticator
set role service_role;
do $$
declare r jsonb; jid uuid;
begin
  r := crm_ingest_inquiry(cl.payload('src-x', 'sub-0101-stale', 'stale.visitor@example.test'));
  perform cl.put('stale', jsonb_build_object('job_id', r->'jobs'->0->>'job_id'));
end $$;
reset role;
\c - supabase_admin
update notification_jobs set created_at = now() - interval '25 hours' where id = (cl.get('stale')->>'job_id')::uuid;
\c - authenticator
set role service_role;
do $$
declare jid uuid := (cl.get('stale')->>'job_id')::uuid;
begin
  perform crm_notification_claim(5);
  perform cl.ok('G24 a stale queued alert is blocked, not sent', cl.job(jid)->>'status' = 'blocked' and cl.job(jid)->>'block_reason' = 'stale');
end $$;

-- ── K. STOP / START / HELP ──────────────────────────────────────────────────
do $$
declare r jsonb; e text; q jsonb; jid uuid;
begin
  q := crm_ingest_inquiry(cl.payload('src-x', 'sub-0102-stop', 'stop.case@example.test'));
  jid := (q->'jobs'->0->>'job_id')::uuid;
  perform cl.ok('K0 sender lookup for webhook routing', crm_notification_sender_known(cl.sid('AC', 'sender'))
    and not crm_notification_sender_known(cl.sid('AC', 'unknown')));
  e := cl.try(format('select crm_notification_keyword(%L)', jsonb_build_object('message_sid', cl.sid('SM', 'k0'),
    'account_sid', cl.sid('AC', 'sender'), 'to', '+18885550100', 'from', '+16185550100', 'keyword', 'STOP')));
  perform cl.ok('K1 a keyword to a number that is not the sender''s is refused', e like 'P0002: unknown_number%', e);
  r := crm_notification_keyword(jsonb_build_object('message_sid', cl.sid('SM', 'k1'), 'account_sid', cl.sid('AC', 'sender'),
    'to', '+18885550199', 'from', '+16185550100', 'keyword', 'STOP'));
  perform cl.ok('K2 STOP opts the phone out for every client and blocks what was waiting',
    (r->>'recipients_opted_out')::int = 2
    and cl.rcpt(cl.id('rx'))->>'consent_status' = 'opted_out' and cl.rcpt(cl.id('ry'))->>'consent_status' = 'opted_out'
    and cl.job(jid)->>'status' = 'blocked' and cl.job(jid)->>'block_reason' = 'opted_out', r::text);
  r := crm_notification_keyword(jsonb_build_object('message_sid', cl.sid('SM', 'k1'), 'account_sid', cl.sid('AC', 'sender'),
    'to', '+18885550199', 'from', '+16185550100', 'keyword', 'STOP'));
  perform cl.ok('K3 a webhook retry of the same STOP is a no-op', (r->>'duplicate')::boolean);
  perform cl.ok('K4 the gate says opted_out', crm_notification_block_reason(cl.id('rx'), cl.id('sender'), false) = 'opted_out');
  r := crm_notification_keyword(jsonb_build_object('message_sid', cl.sid('SM', 'k2'), 'account_sid', cl.sid('AC', 'sender'),
    'to', '+18885550199', 'from', '+16185550100', 'keyword', 'HELP'));
  perform cl.ok('K5 HELP is recorded and changes nothing', cl.rcpt(cl.id('rx'))->>'consent_status' = 'opted_out'
    and exists (select 1 from notification_inbound_keywords where provider_message_sid = cl.sid('SM', 'k2') and keyword = 'HELP'));
  perform cl.put('stopjob', jsonb_build_object('n', 1));
end $$;
reset role;

set role authenticated;
select cl.as_user('authenticated', :'admin') \g /dev/null
do $$
declare e text;
begin
  e := cl.try(format('select crm_record_notification_consent(%L)', jsonb_build_object('recipient_id', cl.id('rx'),
    'consented_at', now(), 'consent_method', 'verbal', 'consent_response', 'Yes', 'disclosure_version', '2026-10-11', 'disclosure_acknowledged', true)));
  perform cl.ok('K6 a teammate cannot overwrite a STOP', e like 'P0001: opted_out%', e);
end $$;
reset role;

set role service_role;
do $$
declare r jsonb;
begin
  r := crm_notification_keyword(jsonb_build_object('message_sid', cl.sid('SM', 'k3'), 'account_sid', cl.sid('AC', 'sender'),
    'to', '+18885550199', 'from', '+16185550100', 'keyword', 'START'));
  perform cl.ok('K7 START lifts the sender block, but consent stays opted out until a teammate records it again',
    not (select opted_out from notification_opt_outs where phone_e164 = '+16185550100')
    and cl.rcpt(cl.id('rx'))->>'consent_status' = 'opted_out'
    and crm_notification_block_reason(cl.id('rx'), cl.id('sender'), false) = 'opted_out');
end $$;
reset role;

-- ── D. A client's deletion cascades through everything ──────────────────────
\c - supabase_admin
do $$
declare e text;
begin
  e := cl.try(format('delete from clients where id = %L', cl.id('y')));
  perform cl.ok('D1 deleting a client removes its inquiries, notes, history, recipients and jobs (guards let the cascade through)',
    e is null and not exists (select 1 from inquiries where client_id = cl.id('y'))
    and not exists (select 1 from notification_recipients where client_id = cl.id('y'))
    and exists (select 1 from inquiries where client_id = cl.id('x')), e);
end $$;

-- ── Seed. The Ginger Huff pilot data script, twice (idempotent) ─────────────
-- (the replay may already hold the production-shaped client; it is kept)
insert into clients (id, name, city, state, status) values
  ('db9009c2-a04b-4e93-843f-e20c49263b5b', 'Ginger Huff Interiors', 'Edwardsville', 'IL', 'launching')
on conflict (id) do nothing;
\c - postgres
\ir ../../seeds/clients/ginger-huff-crm-lite.sql
\ir ../../seeds/clients/ginger-huff-crm-lite.sql
do $$
declare g constant uuid := 'db9009c2-a04b-4e93-843f-e20c49263b5b';
begin
  perform cl.ok('SD1 the pilot seed: CRM Lite and portal on, SMS off, no sender, one disabled source, consent pending',
    (select enabled and portal_enabled and not sms_alerts_enabled and sms_sender_id is null from crm_lite_settings where client_id = g)
    and (select count(*) = 1 and bool_and(not enabled and token_issued_at is null) from inquiry_sources where client_id = g)
    and not exists (select 1 from notification_senders where sender_key = 'compass_notifications')
    and (select count(*) = 1 and bool_and(consent_status = 'pending' and phone_e164 = '+16187919113' and consented_at is null)
         from notification_recipients where client_id = g));
  perform cl.ok('SD2 the seed touches no other client', (select count(*) from crm_lite_settings where client_id not in (g, cl.id('x'), cl.id('z'))) = 0);
end $$;
\c - supabase_admin
select cl.ok('SD3 the seed''s alert gate is closed (no sender)', crm_notification_block_reason(
  (select id from notification_recipients where client_id = 'db9009c2-a04b-4e93-843f-e20c49263b5b'),
  (select sms_sender_id from crm_lite_settings where client_id = 'db9009c2-a04b-4e93-843f-e20c49263b5b'), true) = 'no_sender');
delete from notification_recipients where client_id = 'db9009c2-a04b-4e93-843f-e20c49263b5b';
delete from inquiry_sources where client_id = 'db9009c2-a04b-4e93-843f-e20c49263b5b';
delete from crm_lite_settings where client_id = 'db9009c2-a04b-4e93-843f-e20c49263b5b';

\c - postgres
\o
\pset footer off
select status, count(*) from cl.results group by status order by status;
select n, status, name, detail from cl.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from cl.results where status = 'fail';
  if f > 0 then raise exception '% CRM Lite check(s) failed', f; end if;
end $$;
