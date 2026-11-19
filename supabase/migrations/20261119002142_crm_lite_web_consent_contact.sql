-- CRM Lite: structured website SMS consent at intake, and an inquiry contact
-- that holds the inquiry's own phone number.
--
-- Two production faults (BHG Safety Partners, Nov 18 2026):
--
-- 1. A website's SMS consent checkbox reached Compass only as words inside
--    the inquiry's message, so no communication_consents row existed and a
--    teammate had to record it by hand. inquiry-intake now passes an explicit
--    `sms_consent` object ({granted, consented_at, disclosure_version,
--    disclosure_text, phone, source_url}) and crm_ingest_inquiry records it
--    through crm_apply_web_consent below. Nothing parses message text.
--
-- 2. crm_ingest_inquiry matched a contact by email first. An older contact
--    with the same email and no phone became the inquiry's contact, so
--    calling (which dials inquiries.phone_e164) worked and texting (which
--    sent to contacts.phone_e164) failed with no_phone. Had the older
--    contact held a different number, the text would have gone to that
--    number instead. Now the phone decides: a contact that already holds the
--    inquiry's number is used; otherwise a new contact is created with it.
--    An existing contact is never changed, merged or given a number here.
--
-- Consent rules (crm_apply_web_consent), on top of 0063's:
--   * Only an explicit granted = true grants. Unchecked or missing consent
--     records nothing and never revokes an existing grant.
--   * The consented phone must be the inquiry's own phone.
--   * Any opted_out row for the phone wins (only the recipient's START lifts
--     it). A revocation dated after the consent wins.
--   * An existing grant is left exactly as it is (history preserved).
--   * Applied only for a new submission: a retried submission id returns
--     the first inquiry before any consent work, so retries add no events.
--   * The consent history row (0063's trigger) records actor_kind
--     'recipient', source 'web_form', the disclosure version, the page and
--     the exact wording with its sha256.
-- Every outcome is one inquiry_events row (kind 'sms_consent'); the contact
-- decision is another ('contact_matched'). Neither kind is in the portal
-- view, which lists its kinds explicitly.
--
-- Rollback: supabase/rollback/20261118210000_crm_lite_web_consent_contact.down.sql
-- (restores the 20261012002616 crm_ingest_inquiry, drops the two helpers;
-- event rows of the new kinds are kept, so the kind check keeps them).

-- ── 1. Event kinds ──────────────────────────────────────────────────────────
alter table inquiry_events drop constraint inquiry_events_kind_check;
alter table inquiry_events add constraint inquiry_events_kind_check check (kind in (
  'received', 'status_changed', 'note_added', 'email_reported', 'contact_matched', 'sms_consent', 'contact_relinked'));

-- ── 2. Contact resolution ───────────────────────────────────────────────────
-- Within one client only. The phone is the SMS identity (contacts are unique
-- by phone per client), so it decides; email decides only when there is no
-- valid phone. Never edits an existing contact.
create function crm_resolve_inquiry_contact(p_client uuid, p_name text, p_email text, p_phone_e164 text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_by_email uuid;
  v_by_phone uuid;
  v_id uuid;
begin
  if crm_caller() not in ('service', 'superuser') then
    raise exception 'forbidden: contacts are resolved inside inquiry intake only' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('compass.crm_contact:' || p_client::text, 0));
  if p_email is not null then
    select id into v_by_email from contacts where client_id = p_client and lower(email) = lower(p_email)
      order by created_at, id limit 1;
  end if;
  if p_phone_e164 is not null then
    select id into v_by_phone from contacts where client_id = p_client and phone_e164 = p_phone_e164;
    if v_by_phone is not null then
      return jsonb_build_object('contact_id', v_by_phone, 'created', false, 'matched_by', 'phone',
        'email_contact_id', case when v_by_email is distinct from v_by_phone then v_by_email end);
    end if;
  elsif v_by_email is not null then
    return jsonb_build_object('contact_id', v_by_email, 'created', false, 'matched_by', 'email', 'email_contact_id', null);
  end if;

  perform set_config('compass.communications_write', 'on', true);
  insert into contacts (client_id, first_name, phone_e164, email, source, notes)
  values (p_client, left(p_name, 200), p_phone_e164, p_email, 'web_form',
    case when v_by_email is not null then 'From a website inquiry (its email also matches an earlier contact without this number)'
         else 'From a website inquiry' end)
  returning id into v_id;
  perform set_config('compass.communications_write', '', true);
  return jsonb_build_object('contact_id', v_id, 'created', true, 'matched_by', 'created', 'email_contact_id', v_by_email);
end $$;
revoke all on function crm_resolve_inquiry_contact(uuid, text, text, text) from public, anon, authenticated, service_role;
comment on function crm_resolve_inquiry_contact(uuid, text, text, text) is
  'Inquiry intake only: the contact holding the inquiry''s phone, else (no phone) the oldest with its email, else a new contact. Never edits an existing contact (20261118210000).';

-- ── 3. Website consent ──────────────────────────────────────────────────────
-- Returns {outcome, reason, consent_id}. outcome: granted | already_granted |
-- not_granted (box unchecked) | not_applied (a rule refused it; reason says
-- which). Raises only on a malformed object, which inquiry-intake refuses
-- before it gets here.
create function crm_apply_web_consent(p_client uuid, p_contact uuid, p_inquiry uuid, p_phone_e164 text,
                                      p_consent jsonb, p_source_label text, p_submission text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_version text;
  v_text text;
  v_url text;
  v_at timestamptz;
  v_claimed text;
  v_row record;
  v_exists boolean;
  v_id uuid;
begin
  if crm_caller() not in ('service', 'superuser') then
    raise exception 'forbidden: website consent is recorded inside inquiry intake only' using errcode = 'insufficient_privilege';
  end if;
  if p_consent is null or jsonb_typeof(p_consent) = 'null' then return null; end if;
  if jsonb_typeof(p_consent) <> 'object' or jsonb_typeof(p_consent->'granted') is distinct from 'boolean' then
    raise exception 'invalid: sms_consent' using errcode = '22023';
  end if;
  if not (p_consent->>'granted')::boolean then
    return jsonb_build_object('outcome', 'not_granted', 'reason', 'unchecked');
  end if;

  v_version := btrim(coalesce(p_consent->>'disclosure_version', ''));
  v_text := btrim(coalesce(p_consent->>'disclosure_text', ''));
  v_url := nullif(btrim(coalesce(p_consent->>'source_url', '')), '');
  if v_version !~ '^[A-Za-z0-9._:-]{1,100}$' or length(v_text) = 0 or length(v_text) > 2000 then
    raise exception 'invalid: sms_consent' using errcode = '22023';
  end if;
  if v_url is not null and (v_url !~ '^https://' or length(v_url) > 2000) then v_url := null; end if;
  begin
    v_at := (p_consent->>'consented_at')::timestamptz;
  exception when others then
    raise exception 'invalid: sms_consent' using errcode = '22023';
  end;
  if v_at is null then raise exception 'invalid: sms_consent' using errcode = '22023'; end if;

  if p_phone_e164 is null then return jsonb_build_object('outcome', 'not_applied', 'reason', 'no_valid_phone'); end if;
  v_claimed := nullif(btrim(coalesce(p_consent->>'phone', '')), '');
  if v_claimed is not null and crm_phone_e164(v_claimed) is distinct from p_phone_e164 then
    return jsonb_build_object('outcome', 'not_applied', 'reason', 'phone_mismatch');
  end if;
  if v_at > now() + interval '5 minutes' then
    return jsonb_build_object('outcome', 'not_applied', 'reason', 'consented_in_future');
  end if;

  -- The same rows a send locks, so a STOP arriving now waits or wins.
  perform 1 from communication_consents where client_id = p_client and phone_e164 = p_phone_e164 for update;
  if exists (select 1 from communication_consents where client_id = p_client and phone_e164 = p_phone_e164 and status = 'opted_out') then
    return jsonb_build_object('outcome', 'not_applied', 'reason', 'opted_out');
  end if;
  select id, status, revoked_at into v_row from communication_consents
   where client_id = p_client and phone_e164 = p_phone_e164 and consent_type = 'sms_customer_care';
  v_exists := found;
  if v_exists and v_row.status = 'granted' then
    return jsonb_build_object('outcome', 'already_granted', 'reason', null, 'consent_id', v_row.id);
  end if;
  if v_exists and v_row.revoked_at >= v_at then
    return jsonb_build_object('outcome', 'not_applied', 'reason', 'revoked_after_consent', 'consent_id', v_row.id);
  end if;

  perform set_config('compass.communications_write', 'on', true);
  perform set_config('compass.consent_context', jsonb_build_object('actor_kind', 'recipient', 'source', 'web_form')::text, true);
  if v_exists then
    update communication_consents
       set status = 'granted', source = 'web_form', source_url = v_url, disclosure_version = v_version,
           evidence = format('Website checkbox ticked by the visitor (%s; inquiry %s, submission %s). Wording %s, sha256 %s: %s',
             p_source_label, p_inquiry, p_submission, v_version, encode(sha256(convert_to(v_text, 'UTF8')), 'hex'), v_text),
           consented_at = v_at, revoked_at = null, recorded_by = null, contact_id = coalesce(contact_id, p_contact)
     where id = v_row.id and status = 'revoked'
    returning id into v_id;
  else
    insert into communication_consents (client_id, contact_id, phone_e164, consent_type, status, source, source_url,
      disclosure_version, evidence, consented_at)
    values (p_client, p_contact, p_phone_e164, 'sms_customer_care', 'granted', 'web_form', v_url, v_version,
      format('Website checkbox ticked by the visitor (%s; inquiry %s, submission %s). Wording %s, sha256 %s: %s',
        p_source_label, p_inquiry, p_submission, v_version, encode(sha256(convert_to(v_text, 'UTF8')), 'hex'), v_text),
      v_at)
    on conflict (client_id, phone_e164, consent_type) do nothing
    returning id into v_id;
  end if;
  perform set_config('compass.consent_context', '', true);
  perform set_config('compass.communications_write', '', true);
  if v_id is null then
    -- Another writer (a STOP) created or changed the row between the lock and here.
    return jsonb_build_object('outcome', 'not_applied', 'reason', 'concurrent_change');
  end if;
  return jsonb_build_object('outcome', 'granted', 'reason', null, 'consent_id', v_id);
end $$;
revoke all on function crm_apply_web_consent(uuid, uuid, uuid, text, jsonb, text, text) from public, anon, authenticated, service_role;
comment on function crm_apply_web_consent(uuid, uuid, uuid, text, jsonb, text, text) is
  'Inquiry intake only: records a website SMS checkbox as sms_customer_care consent for the inquiry''s own phone. Explicit granted only; never over an opt-out, a later revocation or an existing grant (20261118210000).';

-- ── 4. Intake ───────────────────────────────────────────────────────────────
-- 20261012002616's function with the contact block replaced by
-- crm_resolve_inquiry_contact and the consent applied after the inquiry is
-- saved. The duplicate branch is unchanged (a retry does no consent work).
create or replace function crm_ingest_inquiry(p jsonb) returns jsonb
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
  v_match jsonb;
  v_contact uuid;
  v_contact_created boolean := false;
  v_inquiry uuid;
  v_consent jsonb;
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
  if p ? 'sms_consent' and jsonb_typeof(p->'sms_consent') not in ('object', 'null') then
    raise exception 'invalid: sms_consent' using errcode = '22023';
  end if;

  select s.id, s.client_id, s.enabled, s.label into v_src from inquiry_sources s where s.id = v_source;
  if not found then raise exception 'not_found: no such inquiry source' using errcode = 'P0002'; end if;

  perform pg_advisory_xact_lock(hashtextextended('compass.inquiry:' || v_source::text || ':' || v_sub, 0));
  perform set_config('compass.crm_write', 'on', true);

  -- A retry of a submission already recorded: the first record stands; only
  -- the website's email outcome may move forward (failed → accepted). No
  -- contact or consent work, so a retry never adds a consent event.
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

  -- The contact, within this client only. The inquiry's phone decides.
  v_match := crm_resolve_inquiry_contact(v_src.client_id, v_name, v_email, v_phone_e164);
  v_contact := (v_match->>'contact_id')::uuid;
  v_contact_created := (v_match->>'created')::boolean;

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
  insert into inquiry_events (client_id, inquiry_id, kind, detail, actor_kind, actor_name)
  values (v_src.client_id, v_inquiry, 'contact_matched', v_match, 'system', 'inquiry intake');

  v_consent := crm_apply_web_consent(v_src.client_id, v_contact, v_inquiry, v_phone_e164, p->'sms_consent', v_src.label, v_sub);
  if v_consent is not null then
    insert into inquiry_events (client_id, inquiry_id, kind, detail, actor_kind, actor_name)
    values (v_src.client_id, v_inquiry, 'sms_consent',
      v_consent || jsonb_build_object('disclosure_version', nullif(p->'sms_consent'->>'disclosure_version', '')),
      'website', v_src.label);
  end if;

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
    'contact_created', v_contact_created, 'contact_matched_by', v_match->>'matched_by',
    'sms_consent', coalesce(v_consent->>'outcome', 'not_sent'), 'jobs', v_jobs);
end $$;
revoke all on function crm_ingest_inquiry(jsonb) from public, anon, authenticated;
grant execute on function crm_ingest_inquiry(jsonb) to service_role;
