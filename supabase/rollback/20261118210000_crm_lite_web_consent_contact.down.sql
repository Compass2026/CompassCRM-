-- Rollback of 20261118210000_crm_lite_web_consent_contact.sql.
--
-- Restores crm_ingest_inquiry exactly as 20261012002616 defined it (email
-- first contact matching, no consent work) and drops the two helpers. Kept on
-- purpose: every contacts, communication_consents, communication_consent_events
-- and inquiry_events row written while the migration was live (they are
-- evidence; consent history is append-only), so the inquiry_events kind check
-- keeps the new kinds. Roll back inquiry-intake first (to the version that
-- does not send sms_consent), or the old function simply ignores the field.

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

drop function crm_apply_web_consent(uuid, uuid, uuid, text, jsonb, text, text);
drop function crm_resolve_inquiry_contact(uuid, text, text, text);
