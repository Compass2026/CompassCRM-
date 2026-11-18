-- Tests for 20261118210000_crm_lite_web_consent_contact.sql and
-- 20261118210100_client_phone_sms_recipient.sql, run by
-- scripts/test-portal-sandbox.sh on the same replay, after crm_lite.test.sql.
-- Own harness schema (cc), fictional clients, people and 555 numbers; nothing
-- is sent anywhere. Callers as they reach production: inquiry-intake and
-- client-phone are psql as authenticator with role service_role.
--
--   G  website SMS consent: explicit grant, unchecked, missing, STOP wins,
--      a later revocation wins, an existing grant is left alone, retries add
--      nothing, a different phone, malformed input, no one else can call it
--   K  contact resolution: the phone decides, an existing contact is never
--      edited, conflicting email / phone, no phone, another client's contact
--   R  the text recipient is the lead's own number; inbound and outbound land
--      in the lead's thread
--   F  the deferred BHG repair script on a production-shaped copy

\o /dev/null
create schema cc;
create table cc.results (n serial, status text, name text, detail text);
grant usage on schema cc to anon, authenticated, service_role, authenticator;
grant insert, select on cc.results to anon, authenticated, service_role, authenticator;
grant usage on sequence cc.results_n_seq to anon, authenticated, service_role, authenticator;
create function cc.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into cc.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function cc.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function cc.id(p_k text) returns uuid language sql immutable as $$ select md5('cc:' || p_k)::uuid $$;
create function cc.sid(p_prefix text, p_k text) returns text language sql immutable as $$ select p_prefix || md5('cc-sid:' || p_k) $$;
-- The harness's eyes only (whoever is calling).
create function cc.q(p_sql text) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; begin execute format('select to_jsonb(q) from (%s) q limit 1', p_sql) into v; return v; end $$;
create function cc.n(p_sql text) returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint; begin execute format('select count(*) from (%s) q', p_sql) into v; return v; end $$;
-- A payload as inquiry-intake sends it.
create function cc.payload(p_sub text, p_email text, p_phone text, p_consent jsonb default null, p_source text default 'src-a')
returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object('source_id', cc.id(p_source), 'submission_id', p_sub, 'name', 'Sam Lead',
    'email', p_email, 'phone', p_phone, 'message', 'Please quote a forklift class for six people.',
    'page_url', 'https://www.example.test/contact/', 'submitted_at', now(), 'payload_sha256', md5(p_sub) || md5(p_sub || 'x'),
    'email_status', 'accepted')) || case when p_consent is null then '{}'::jsonb else jsonb_build_object('sms_consent', p_consent) end
$$;
create function cc.granted(p_phone text default '(618) 555-0101', p_at timestamptz default now()) returns jsonb language sql stable as $$
  select jsonb_build_object('granted', true, 'consented_at', p_at, 'disclosure_version', 'cc-sms-consent-2026-10-02',
    'disclosure_text', 'Yes, text me about my inquiry. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.',
    'phone', p_phone, 'source_url', 'https://www.example.test/contact/')
$$;
grant execute on all functions in schema cc to anon, authenticated, service_role, authenticator;

-- ── Fixtures (cluster superuser) ────────────────────────────────────────────
\c - supabase_admin
insert into auth.users (id, email, email_confirmed_at) values (cc.id('tm-user'), 'cc-member@compassmarketing.ai', now());
insert into team_members (auth_user_id, name, email, role) values (cc.id('tm-user'), 'CC Member', 'cc-member@compassmarketing.ai', 'member');
insert into clients (id, name, city, state, status) values
  (cc.id('a'), 'Consent Safety A', 'Edwardsville', 'IL', 'active'),
  (cc.id('b'), 'Consent Roofing B', 'Rolla', 'MO', 'active');
insert into crm_lite_settings (client_id, enabled, portal_enabled) values (cc.id('a'), true, false), (cc.id('b'), true, false);
insert into inquiry_sources (id, client_id, source_key, label, enabled, secret_name) values
  (cc.id('src-a'), cc.id('a'), 'cc-a-website', 'A website', true, 'CRM_INTAKE_CC_A'),
  (cc.id('src-b'), cc.id('b'), 'cc-b-website', 'B website', true, 'CRM_INTAKE_CC_B');
insert into communication_accounts (id, client_id, provider_account_sid) values (cc.id('acct-a'), cc.id('a'), cc.sid('AC', 'a'));
insert into communication_messaging_services (id, client_id, communication_account_id, provider_service_sid, friendly_name)
  values (cc.id('mg-a'), cc.id('a'), cc.id('acct-a'), cc.sid('MG', 'a'), 'A Messaging');
insert into communication_numbers (id, client_id, communication_account_id, messaging_service_id, provider_phone_number_sid, phone_number_e164,
  sms_enabled, voice_enabled, is_primary)
  values (cc.id('num-a'), cc.id('a'), cc.id('acct-a'), cc.id('mg-a'), cc.sid('PN', 'a'), '+18885550123', true, true, true);
insert into client_communication_settings (client_id, enabled, outbound_enabled) values (cc.id('a'), true, true);
insert into communication_compliance_profiles (client_id, profile_type, status) values (cc.id('a'), 'toll_free_verification', 'approved');
-- Existing contacts, as production has them.
insert into contacts (id, client_id, first_name, email, source) values
  (cc.id('k-email-only'), cc.id('a'), 'Old Test Contact', 'shared@example.test', 'web_form');
insert into contacts (id, client_id, first_name, email, phone_e164, source) values
  (cc.id('k-other-phone'), cc.id('a'), 'Pat Earlier', 'pat@example.test', '+16185550177', 'web_form'),
  (cc.id('k-phone-only'), cc.id('a'), null, null, '+16185550188', 'inbound_sms'),
  (cc.id('k-b'), cc.id('b'), 'B Person', 'b@example.test', '+16185550199', 'web_form');

-- ── S. Static ───────────────────────────────────────────────────────────────
\c - postgres
select cc.ok('S1 the two helpers are callable by no API role (only from inside intake)',
  not has_function_privilege('service_role', 'crm_apply_web_consent(uuid, uuid, uuid, text, jsonb, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'crm_apply_web_consent(uuid, uuid, uuid, text, jsonb, text, text)', 'execute')
  and not has_function_privilege('anon', 'crm_resolve_inquiry_contact(uuid, text, text, text)', 'execute')
  and not has_function_privilege('service_role', 'crm_resolve_inquiry_contact(uuid, text, text, text)', 'execute'));
select cc.ok('S2 intake and the SMS reservation stay service-role only',
  has_function_privilege('service_role', 'crm_ingest_inquiry(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'crm_ingest_inquiry(jsonb)', 'execute')
  and has_function_privilege('service_role', 'client_phone_begin_sms(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'client_phone_begin_sms(jsonb)', 'execute'));
select cc.ok('S3 the portal event view still lists only its three kinds (new kinds stay internal)',
  pg_get_viewdef('portal_inquiry_events'::regclass) like '%''received''%' and pg_get_viewdef('portal_inquiry_events'::regclass) not like '%sms_consent%'
  and pg_get_viewdef('portal_inquiry_events'::regclass) not like '%contact_%');
select cc.ok('S4 the worker cannot record a consent or resolve a contact',
  cc.try(format('select crm_apply_web_consent(%L, null, %L, %L, %L, %L, %L)', cc.id('a'), cc.id('x'), '+16185550101', cc.granted(), 'w', 'w-sub-0001'))
    like '42501%'
  and cc.try(format('select crm_resolve_inquiry_contact(%L, %L, null, %L)', cc.id('a'), 'W', '+16185550101')) like '42501%');

-- ── G. Website consent (inquiry-intake's identity) ──────────────────────────
\c - authenticator
set role service_role;
do $$
declare r jsonb; c jsonb; e text; n_events bigint; n_consent_events bigint; before jsonb;
begin
  -- G1 explicit grant
  r := crm_ingest_inquiry(cc.payload('cc-g1-0001', 'g1@example.test', '(618) 555-0101', cc.granted()));
  c := cc.q(format($q$select * from communication_consents where client_id = %L and phone_e164 = '+16185550101'$q$, cc.id('a')));
  perform cc.ok('G1 a ticked box is recorded as sms_customer_care consent for the inquiry''s own phone, from the website',
    r->>'sms_consent' = 'granted' and c->>'status' = 'granted' and c->>'source' = 'web_form' and c->>'consent_type' = 'sms_customer_care'
    and c->>'disclosure_version' = 'cc-sms-consent-2026-10-02' and c->>'source_url' = 'https://www.example.test/contact/'
    and (c->>'contact_id')::uuid = (r->>'contact_id')::uuid and c->>'recorded_by' is null
    and c->>'evidence' like 'Website checkbox ticked by the visitor (A website; inquiry ' || (r->>'inquiry_id') || ', submission cc-g1-0001). Wording cc-sms-consent-2026-10-02, sha256 %'
    and c->>'evidence' like '%Reply STOP to opt out.', r::text || ' ' || coalesce(c::text, 'no consent'));
  perform cc.ok('G2 its history says the recipient did it, with the version, page and wording',
    cc.n(format($q$select 1 from communication_consent_events where consent_id = %L and from_status is null and to_status = 'granted'
      and actor_kind = 'recipient' and actor_id is null and source = 'web_form' and disclosure_version = 'cc-sms-consent-2026-10-02'
      and source_url = 'https://www.example.test/contact/' and evidence like 'Website checkbox%%'$q$, c->>'id')) = 1);
  perform cc.ok('G3 the inquiry''s history records the outcome',
    cc.n(format($q$select 1 from inquiry_events where inquiry_id = %L and kind = 'sms_consent' and actor_kind = 'website'
      and detail->>'outcome' = 'granted' and detail->>'consent_id' = %L and detail->>'disclosure_version' = 'cc-sms-consent-2026-10-02'$q$,
      r->>'inquiry_id', c->>'id')) = 1);
  perform cc.ok('G3b the consented time is the website''s, not the time Compass received it',
    (c->>'consented_at')::timestamptz <= now());

  -- G4 retry of the same submission: nothing new
  n_events := cc.n('select 1 from inquiry_events');
  n_consent_events := cc.n('select 1 from communication_consent_events');
  r := crm_ingest_inquiry(cc.payload('cc-g1-0001', 'g1@example.test', '(618) 555-0101', cc.granted()));
  perform cc.ok('G4 a retried submission is a duplicate and adds no inquiry or consent event',
    (r->>'duplicate')::boolean and cc.n('select 1 from inquiry_events') = n_events
    and cc.n('select 1 from communication_consent_events') = n_consent_events, r::text);

  -- G5 an existing grant is left exactly as it is
  before := cc.q(format($q$select * from communication_consents where client_id = %L and phone_e164 = '+16185550101'$q$, cc.id('a')));
  r := crm_ingest_inquiry(cc.payload('cc-g5-0001', 'g1@example.test', '6185550101', cc.granted('6185550101', now() - interval '1 minute')));
  perform cc.ok('G5 a second grant for a granted phone changes nothing and adds no consent event',
    r->>'sms_consent' = 'already_granted'
    and cc.q(format($q$select * from communication_consents where client_id = %L and phone_e164 = '+16185550101'$q$, cc.id('a'))) = before
    and cc.n('select 1 from communication_consent_events') = n_consent_events, r::text);

  -- G6 unchecked
  r := crm_ingest_inquiry(cc.payload('cc-g6-0001', 'g6@example.test', '(618) 555-0102',
    '{"granted": false, "disclosure_version": "cc-sms-consent-2026-10-02"}'::jsonb));
  perform cc.ok('G6 an unchecked box records no consent, only that it was unchecked',
    r->>'sms_consent' = 'not_granted'
    and cc.n(format($q$select 1 from communication_consents where client_id = %L and phone_e164 = '+16185550102'$q$, cc.id('a'))) = 0
    and cc.n(format($q$select 1 from inquiry_events where inquiry_id = %L and kind = 'sms_consent' and detail->>'outcome' = 'not_granted'$q$,
      r->>'inquiry_id')) = 1, r::text);
  -- G7 unchecked never revokes an existing grant
  r := crm_ingest_inquiry(cc.payload('cc-g7-0001', 'g1@example.test', '(618) 555-0101', '{"granted": false}'::jsonb));
  perform cc.ok('G7 an unchecked box on a later form does not revoke an earlier grant',
    r->>'sms_consent' = 'not_granted'
    and (cc.q(format($q$select status from communication_consents where client_id = %L and phone_e164 = '+16185550101'$q$, cc.id('a'))))->>'status' = 'granted');

  -- G8 missing
  r := crm_ingest_inquiry(cc.payload('cc-g8-0001', 'g8@example.test', '(618) 555-0103'));
  perform cc.ok('G8 no consent object (a form without the box) records nothing',
    r->>'sms_consent' = 'not_sent'
    and cc.n(format($q$select 1 from communication_consents where client_id = %L and phone_e164 = '+16185550103'$q$, cc.id('a'))) = 0
    and cc.n(format($q$select 1 from inquiry_events where inquiry_id = %L and kind = 'sms_consent'$q$, r->>'inquiry_id')) = 0, r::text);
  -- G8b message words are not consent
  r := crm_ingest_inquiry(cc.payload('cc-g8-0002', 'g8b@example.test', '(618) 555-0104') ||
    '{"message": "SMS consent: YES — opted in to text messages. Disclosure version: cc-sms-consent-2026-10-02"}'::jsonb);
  perform cc.ok('G8b consent words inside the message grant nothing',
    cc.n(format($q$select 1 from communication_consents where client_id = %L and phone_e164 = '+16185550104'$q$, cc.id('a'))) = 0);

  -- G9 a different phone in the consent than in the inquiry
  r := crm_ingest_inquiry(cc.payload('cc-g9-0001', 'g9@example.test', '(618) 555-0105', cc.granted('(618) 555-0106')));
  perform cc.ok('G9 consent for a number other than the inquiry''s grants nothing (either number)',
    r->>'sms_consent' = 'not_applied'
    and cc.n(format($q$select 1 from communication_consents where client_id = %L and phone_e164 in ('+16185550105', '+16185550106')$q$, cc.id('a'))) = 0
    and cc.n(format($q$select 1 from inquiry_events where inquiry_id = %L and detail->>'reason' = 'phone_mismatch'$q$, r->>'inquiry_id')) = 1, r::text);
  -- G10 no valid phone
  r := crm_ingest_inquiry(cc.payload('cc-g10-0001', 'g10@example.test', '555-01', cc.granted('555-01')));
  perform cc.ok('G10 a ticked box with no valid phone grants nothing',
    r->>'sms_consent' = 'not_applied'
    and cc.n(format($q$select 1 from inquiry_events where inquiry_id = %L and detail->>'reason' = 'no_valid_phone'$q$, r->>'inquiry_id')) = 1, r::text);
  -- G11 dated in the future
  r := crm_ingest_inquiry(cc.payload('cc-g11-0001', 'g11@example.test', '(618) 555-0107', cc.granted('(618) 555-0107', now() + interval '1 day')));
  perform cc.ok('G11 a consent dated in the future grants nothing',
    r->>'sms_consent' = 'not_applied'
    and cc.n(format($q$select 1 from communication_consents where client_id = %L and phone_e164 = '+16185550107'$q$, cc.id('a'))) = 0, r::text);
  -- G12 malformed: refused whole, nothing saved
  e := cc.try(format('select crm_ingest_inquiry(%L)', cc.payload('cc-g12-0001', 'g12@example.test', '(618) 555-0108',
    '{"granted": "yes"}'::jsonb)));
  perform cc.ok('G12 a malformed consent (granted not a boolean) refuses the submission; nothing is saved',
    e like '22023: invalid: sms_consent%'
    and cc.n($q$select 1 from inquiries where submission_id = 'cc-g12-0001'$q$) = 0, e);
  e := cc.try(format('select crm_ingest_inquiry(%L)', cc.payload('cc-g12-0002', 'g12@example.test', '(618) 555-0108',
    '{"granted": true, "consented_at": "2026-11-18T21:48:42Z"}'::jsonb)));
  perform cc.ok('G12b a grant without its disclosure version and wording is refused',
    e like '22023: invalid: sms_consent%' and cc.n($q$select 1 from inquiries where submission_id = 'cc-g12-0002'$q$) = 0, e);
end $$;
reset role;

-- STOP and revocation fixtures, the way production writes them (the opt-out
-- function the inbound webhook uses; a teammate's revocation), as the superuser.
\c - supabase_admin
do $$
begin
  perform set_config('compass.communications_write', 'on', true);
  perform communication_opt_out(cc.id('a'), '+16185550101', null, now(), 'inbound_sms', 'recipient', null, 'Recipient texted STOP');
  -- An earlier teammate revocation (an hour ago) and a revocation after the consent time used below.
  insert into communication_consents (client_id, phone_e164, consent_type, status, source, evidence, consented_at, revoked_at)
  values (cc.id('a'), '+16185550110', 'sms_customer_care', 'revoked', 'verbal', 'Asked by phone', now() - interval '3 days', now() - interval '1 hour'),
         (cc.id('a'), '+16185550111', 'sms_customer_care', 'revoked', 'verbal', 'Asked by phone', now() - interval '3 days', now());
  perform set_config('compass.communications_write', '', true);
end $$;

\c - authenticator
set role service_role;
do $$
declare r jsonb; n_consent_events bigint; before jsonb;
begin
  -- G13 STOP wins over a new website grant, and over a retry
  before := cc.q(format($q$select * from communication_consents where client_id = %L and phone_e164 = '+16185550101'$q$, cc.id('a')));
  n_consent_events := cc.n('select 1 from communication_consent_events');
  r := crm_ingest_inquiry(cc.payload('cc-g13-0001', 'g1@example.test', '(618) 555-0101', cc.granted()));
  perform cc.ok('G13 after STOP, a new ticked box does not opt the number back in (only START does)',
    before->>'status' = 'opted_out' and r->>'sms_consent' = 'not_applied'
    and cc.q(format($q$select * from communication_consents where client_id = %L and phone_e164 = '+16185550101'$q$, cc.id('a'))) = before
    and cc.n('select 1 from communication_consent_events') = n_consent_events
    and cc.n(format($q$select 1 from inquiry_events where inquiry_id = %L and detail->>'reason' = 'opted_out'$q$, r->>'inquiry_id')) = 1, r::text);
  r := crm_ingest_inquiry(cc.payload('cc-g1-0001', 'g1@example.test', '(618) 555-0101', cc.granted(), 'src-a'));
  perform cc.ok('G14 a late retry of the original granted submission does not overwrite the newer opt-out',
    (r->>'duplicate')::boolean
    and (cc.q(format($q$select status from communication_consents where client_id = %L and phone_e164 = '+16185550101'$q$, cc.id('a'))))->>'status' = 'opted_out');
  -- G15 a revocation dated after the consent wins
  r := crm_ingest_inquiry(cc.payload('cc-g15-0001', 'g15@example.test', '(618) 555-0111', cc.granted('(618) 555-0111', now() - interval '2 hours')));
  perform cc.ok('G15 a teammate revocation dated after the box was ticked stands',
    r->>'sms_consent' = 'not_applied'
    and (cc.q(format($q$select status from communication_consents where client_id = %L and phone_e164 = '+16185550111'$q$, cc.id('a'))))->>'status' = 'revoked', r::text);
  -- G16 a newer ticked box after an earlier revocation is new consent
  r := crm_ingest_inquiry(cc.payload('cc-g16-0001', 'g16@example.test', '(618) 555-0110', cc.granted('(618) 555-0110')));
  perform cc.ok('G16 a box ticked after an earlier revocation grants again, with history from revoked',
    r->>'sms_consent' = 'granted'
    and (cc.q(format($q$select status from communication_consents where client_id = %L and phone_e164 = '+16185550110'$q$, cc.id('a'))))->>'status' = 'granted'
    and cc.n(format($q$select 1 from communication_consent_events e join communication_consents s on s.id = e.consent_id
      where s.client_id = %L and s.phone_e164 = '+16185550110' and e.from_status = 'revoked' and e.to_status = 'granted' and e.actor_kind = 'recipient'$q$,
      cc.id('a'))) = 1, r::text);
  -- G17 tenancy: consent lands in the source's client only
  r := crm_ingest_inquiry(cc.payload('cc-g17-0001', 'b2@example.test', '(618) 555-0112', cc.granted('(618) 555-0112'), 'src-b'));
  perform cc.ok('G17 consent is recorded under the source''s client only',
    cc.n(format($q$select 1 from communication_consents where client_id = %L and phone_e164 = '+16185550112'$q$, cc.id('b'))) = 1
    and cc.n(format($q$select 1 from communication_consents where client_id = %L and phone_e164 = '+16185550112'$q$, cc.id('a'))) = 0);
end $$;

-- ── K. Contact resolution ───────────────────────────────────────────────────
do $$
declare r jsonb; k jsonb;
begin
  -- K1 the BHG shape: same email as an older contact that has no phone
  r := crm_ingest_inquiry(cc.payload('cc-k1-0001', 'Shared@Example.test', '(618) 555-0120'));
  k := cc.q(format('select * from contacts where id = %L', r->>'contact_id'));
  perform cc.ok('K1 an email match without the inquiry''s phone is not used: a contact holding the phone is created',
    r->>'contact_id' <> cc.id('k-email-only')::text and (r->>'contact_created')::boolean and r->>'contact_matched_by' = 'created'
    and k->>'phone_e164' = '+16185550120' and k->>'email' = 'shared@example.test', r::text);
  perform cc.ok('K2 the older contact is not edited (no number added, nothing merged)',
    (cc.q(format('select phone_e164, first_name, email from contacts where id = %L', cc.id('k-email-only'))))
      = jsonb_build_object('phone_e164', null, 'first_name', 'Old Test Contact', 'email', 'shared@example.test'));
  perform cc.ok('K3 the decision is in the inquiry''s history, naming the other email match',
    cc.n(format($q$select 1 from inquiry_events where inquiry_id = %L and kind = 'contact_matched' and actor_kind = 'system'
      and detail->>'matched_by' = 'created' and detail->>'email_contact_id' = %L$q$, r->>'inquiry_id', cc.id('k-email-only'))) = 1);
  -- K4 email matches a contact with a different number
  r := crm_ingest_inquiry(cc.payload('cc-k4-0001', 'pat@example.test', '(618) 555-0121'));
  perform cc.ok('K4 an email match holding a different number is never overwritten; the inquiry gets a contact with its own number',
    r->>'contact_id' <> cc.id('k-other-phone')::text
    and (cc.q(format('select phone_e164 from contacts where id = %L', cc.id('k-other-phone'))))->>'phone_e164' = '+16185550177'
    and (cc.q(format('select phone_e164 from contacts where id = %L', r->>'contact_id')))->>'phone_e164' = '+16185550121', r::text);
  -- K5 phone matches a contact with a different (or no) email
  r := crm_ingest_inquiry(cc.payload('cc-k5-0001', 'pat@example.test', '(618) 555-0188'));
  perform cc.ok('K5 the contact holding the phone is used even when the email points elsewhere, unchanged',
    r->>'contact_id' = cc.id('k-phone-only')::text and r->>'contact_matched_by' = 'phone'
    and (cc.q(format('select email from contacts where id = %L', cc.id('k-phone-only'))))->>'email' is null
    and cc.n(format($q$select 1 from inquiry_events where inquiry_id = %L and kind = 'contact_matched' and detail->>'email_contact_id' = %L$q$,
      r->>'inquiry_id', cc.id('k-other-phone'))) = 1, r::text);
  -- K6 no phone: email decides
  r := crm_ingest_inquiry(cc.payload('cc-k6-0001', 'pat@example.test', null));
  perform cc.ok('K6 without a phone the oldest contact with the email is used',
    r->>'contact_id' = cc.id('k-other-phone')::text and r->>'contact_matched_by' = 'email', r::text);
  -- K7 same phone in another client
  r := crm_ingest_inquiry(cc.payload('cc-k7-0001', 'k7@example.test', '(618) 555-0199'));
  perform cc.ok('K7 another client''s contact with the same phone is never used',
    r->>'contact_id' <> cc.id('k-b')::text
    and (cc.q(format('select client_id from contacts where id = %L', r->>'contact_id')))->>'client_id' = cc.id('a')::text, r::text);
  -- K8 the same person again
  r := crm_ingest_inquiry(cc.payload('cc-k8-0001', 'shared@example.test', '618-555-0120'));
  perform cc.ok('K8 a second inquiry from the same number reuses its contact',
    r->>'contact_matched_by' = 'phone' and not (r->>'contact_created')::boolean
    and r->>'contact_id' = (cc.q($q$select contact_id from inquiries where submission_id = 'cc-k1-0001'$q$))->>'contact_id', r::text);
end $$;
reset role;

-- ── R. The text recipient (client-phone's identity) ─────────────────────────
-- A legacy row shaped like BHG's: the inquiry links the email-only contact,
-- a contact holding its phone exists (from an inbound text) with consent.
\c - supabase_admin
insert into contacts (id, client_id, phone_e164, source) values (cc.id('k-legacy-phone'), cc.id('a'), '+16185550130', 'inbound_sms');
insert into inquiries (id, client_id, source_id, submission_id, contact_id, name, email, phone, phone_e164, message, submitted_at, payload_sha256)
values
  (cc.id('i-legacy'), cc.id('a'), cc.id('src-a'), 'cc-legacy-0001', cc.id('k-email-only'), 'Legacy Lead', 'shared@example.test',
   '(618) 555-0130', '+16185550130', 'Legacy', now(), md5('l') || md5('l2')),
  (cc.id('i-nophone'), cc.id('a'), cc.id('src-a'), 'cc-nophone-0001', cc.id('k-email-only'), 'Email Only', 'shared@example.test',
   null, null, 'No phone', now(), md5('n') || md5('n2')),
  (cc.id('i-orphan'), cc.id('a'), cc.id('src-a'), 'cc-orphan-0001', cc.id('k-email-only'), 'Orphan', 'shared@example.test',
   '(618) 555-0140', '+16185550140', 'No contact holds this number', now(), md5('o') || md5('o2'));
insert into communication_consents (client_id, contact_id, phone_e164, consent_type, status, source, evidence, consented_at)
values (cc.id('a'), cc.id('k-legacy-phone'), '+16185550130', 'sms_customer_care', 'granted', 'web_form', 'Recorded by a teammate', now()),
       (cc.id('a'), null, '+16185550140', 'sms_customer_care', 'granted', 'web_form', 'Recorded by a teammate', now());
insert into client_phone_drafts (client_id, inquiry_id, actor_id, body, revision) values
  (cc.id('a'), cc.id('i-legacy'), cc.id('tm-user'), 'Hi, following up on your quote.', cc.id('rev-legacy')),
  (cc.id('a'), cc.id('i-nophone'), cc.id('tm-user'), 'Hello', cc.id('rev-nophone')),
  (cc.id('a'), cc.id('i-orphan'), cc.id('tm-user'), 'Hello', cc.id('rev-orphan'));

\c - authenticator
set role service_role;
do $$
declare r jsonb; r2 jsonb; e text; inb jsonb; m jsonb;
begin
  r := client_phone_begin_sms(jsonb_build_object('client_id', cc.id('a'), 'inquiry_id', cc.id('i-legacy'), 'actor_id', cc.id('tm-user'),
    'request_id', cc.id('rev-legacy'), 'contact_id', cc.id('k-other-phone'), 'conversation_id', cc.id('nope')));
  m := cc.q(format('select * from communication_messages where id = %L', r->>'message_id'));
  perform cc.ok('R1 a lead linked to a phoneless contact is texted at its own number, in the thread of the contact holding it',
    r->>'to' = '+16185550130' and m->>'to_e164' = '+16185550130' and (m->>'inquiry_id')::uuid = cc.id('i-legacy')
    and (cc.q(format('select contact_id from communication_conversations where id = %L', r->>'conversation_id')))->>'contact_id'
        = cc.id('k-legacy-phone')::text, r::text);
  perform cc.ok('R2 a contact or thread in the request cannot redirect the text', r->>'to' <> '+16185550177');
  r2 := client_phone_begin_sms(jsonb_build_object('client_id', cc.id('a'), 'inquiry_id', cc.id('i-legacy'), 'actor_id', cc.id('tm-user'),
    'request_id', cc.id('rev-legacy')));
  perform cc.ok('R3 the same saved revision again is the same message (send dedupe kept)',
    (r2->>'duplicate')::boolean and r2->>'message_id' = r->>'message_id'
    and cc.n(format($q$select 1 from communication_messages where request_id = %L$q$, cc.id('rev-legacy'))) = 1, r2::text);
  e := cc.try(format('select client_phone_begin_sms(%L)', jsonb_build_object('client_id', cc.id('a'), 'inquiry_id', cc.id('i-nophone'),
    'actor_id', cc.id('tm-user'), 'request_id', cc.id('rev-nophone'))));
  perform cc.ok('R4 a lead with no valid phone answers no_phone (nothing reserved)',
    e like 'P0001: no_phone: this lead%' and cc.n(format($q$select 1 from communication_messages where request_id = %L$q$, cc.id('rev-nophone'))) = 0, e);
  e := cc.try(format('select client_phone_begin_sms(%L)', jsonb_build_object('client_id', cc.id('a'), 'inquiry_id', cc.id('i-orphan'),
    'actor_id', cc.id('tm-user'), 'request_id', cc.id('rev-orphan'))));
  perform cc.ok('R5 a number no contact holds answers lead_contact_mismatch (no contact is invented, nothing reserved)',
    e like 'P0001: lead_contact_mismatch%' and cc.n(format($q$select 1 from communication_messages where request_id = %L$q$, cc.id('rev-orphan'))) = 0, e);
  e := cc.try(format('select client_phone_begin_sms(%L)', jsonb_build_object('client_id', cc.id('b'), 'inquiry_id', cc.id('i-legacy'),
    'actor_id', cc.id('tm-user'), 'request_id', cc.id('rev-legacy'))));
  perform cc.ok('R6 another client cannot reserve a text for this lead', e is not null and e not like '%"duplicate"%', e);

  -- Inbound from the lead's number lands in the same thread.
  inb := communication_record_inbound(jsonb_build_object('message_sid', cc.sid('SM', 'in-legacy'), 'account_sid', cc.sid('AC', 'a'),
    'to', '+18885550123', 'from', '+16185550130', 'body', 'Thanks, Tuesday works.'));
  perform cc.ok('R7 the lead''s reply arrives in the same thread as the text sent to them',
    inb->>'conversation_id' = r->>'conversation_id' and inb->>'contact_id' = cc.id('k-legacy-phone')::text, inb::text);
end $$;
reset role;

-- ── F. The deferred BHG repair on a production-shaped copy ──────────────────
\c - supabase_admin
insert into clients (id, name, city, state, status) values ('3eaa3389-2a33-4004-837c-8aef90404410', 'Repair Copy Co', 'St. Louis', 'MO', 'active');
insert into crm_lite_settings (client_id, enabled) values ('3eaa3389-2a33-4004-837c-8aef90404410', true);
insert into inquiry_sources (id, client_id, source_key, label, enabled, secret_name)
values (cc.id('src-f'), '3eaa3389-2a33-4004-837c-8aef90404410', 'cc-f-website', 'F website', true, 'CRM_INTAKE_CC_F');
insert into contacts (id, client_id, first_name, email, source) values
  ('6f2cf15e-151b-483d-83d9-5ce5c0ce2167', '3eaa3389-2a33-4004-837c-8aef90404410', 'Integration Test', 'repair@example.test', 'web_form');
insert into contacts (id, client_id, phone_e164, source) values
  ('7c022fbe-e8c7-4a42-9266-f7bd07300fbd', '3eaa3389-2a33-4004-837c-8aef90404410', '+16185554620', 'inbound_sms');
insert into inquiries (id, client_id, source_id, submission_id, contact_id, name, email, phone, phone_e164, message, submitted_at, payload_sha256)
values ('6233265f-87c3-4d97-b642-76c8c86b80f1', '3eaa3389-2a33-4004-837c-8aef90404410', cc.id('src-f'), 'cc-repair-0001',
  '6f2cf15e-151b-483d-83d9-5ce5c0ce2167', 'Repair Lead', 'repair@example.test', '(618) 555-4620', '+16185554620', 'x', now(), md5('r') || md5('r2'));
\c - postgres
select cc.ok('F0 a data script cannot relink an inquiry without the repair (guard on)',
  cc.try($q$update inquiries set contact_id = '7c022fbe-e8c7-4a42-9266-f7bd07300fbd' where id = '6233265f-87c3-4d97-b642-76c8c86b80f1'$q$) like '42501%');
\ir ../../deferred/20261118_bhg_inquiry_contact_relink.sql
select cc.ok('F1 the repair relinks exactly that inquiry to the contact holding its phone, with one history row',
  (select contact_id from inquiries where id = '6233265f-87c3-4d97-b642-76c8c86b80f1') = '7c022fbe-e8c7-4a42-9266-f7bd07300fbd'
  and (select count(*) from inquiry_events where inquiry_id = '6233265f-87c3-4d97-b642-76c8c86b80f1' and kind = 'contact_relinked'
       and detail->>'from_contact_id' = '6f2cf15e-151b-483d-83d9-5ce5c0ce2167' and actor_kind = 'system') = 1);
select cc.ok('F2 the guards are back on after the repair',
  (select bool_and(tgenabled = 'O') from pg_trigger where tgname in ('inquiries_guard', 'inquiry_events_guard'))
  and cc.try($q$update inquiries set contact_id = '6f2cf15e-151b-483d-83d9-5ce5c0ce2167' where id = '6233265f-87c3-4d97-b642-76c8c86b80f1'$q$) like '42501%');
select cc.ok('F3 no contact was edited by the repair',
  (select phone_e164 is null and email = 'repair@example.test' from contacts where id = '6f2cf15e-151b-483d-83d9-5ce5c0ce2167'));
-- A second run must refuse (its own exception), leaving everything as is.
\set ON_ERROR_STOP 0
\echo 'F4 expects one "relink: already linked" error next:'
\ir ../../deferred/20261118_bhg_inquiry_contact_relink.sql
\set ON_ERROR_STOP 1
select cc.ok('F4 running it again refuses (already linked) and adds nothing',
  (select count(*) from inquiry_events where inquiry_id = '6233265f-87c3-4d97-b642-76c8c86b80f1' and kind = 'contact_relinked') = 1
  and (select contact_id from inquiries where id = '6233265f-87c3-4d97-b642-76c8c86b80f1') = '7c022fbe-e8c7-4a42-9266-f7bd07300fbd');
\c - supabase_admin
delete from clients where id = '3eaa3389-2a33-4004-837c-8aef90404410';
\c - postgres
\o

-- ── Report ──────────────────────────────────────────────────────────────────
\pset footer off
select status, count(*) from cc.results group by status order by status;
select n, status, name, detail from cc.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from cc.results where status = 'fail';
  if f > 0 then raise exception '% CRM Lite consent / contact check(s) failed', f; end if;
end $$;
