-- Lead texts go to the lead's own number (BHG Safety Partners, Nov 18 2026).
--
-- client_phone_begin_sms (20261031161048) sent to inquiries.contact_id's
-- phone. Intake had linked an inquiry to an older contact with the same email
-- and no phone, so texting failed with no_phone while calling (which dials
-- inquiries.phone_e164) worked; an older contact with a different number
-- would have received the text instead. Now the recipient is
-- inquiries.phone_e164 and the contact is the one holding that number
-- (contacts are unique by phone per client), so the lead, the recipient, the
-- consent row and the conversation always name the same phone. A lead with
-- no valid phone answers no_phone; a number no contact holds answers
-- lead_contact_mismatch (20261118210000 intake never produces one). The rest
-- of the function is unchanged: request dedupe, saved-draft revision, the
-- uncertain-send guard, settings, number, Messaging Service, STOP and
-- consent under a row lock.
--
-- Rollback: re-run the function from 20261031161048_client_phone_workspace.sql
-- (supabase/rollback/20261118210100_client_phone_sms_recipient.down.sql).

create or replace function client_phone_begin_sms(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_request uuid := nullif(p->>'request_id', '')::uuid;
  v_client uuid := nullif(p->>'client_id', '')::uuid;
  v_conv_id uuid := nullif(p->>'conversation_id', '')::uuid;
  v_contact_id uuid := nullif(p->>'contact_id', '')::uuid;
  v_number_id uuid := nullif(p->>'number_id', '')::uuid;
  v_body text := btrim(coalesce(p->>'body', ''));
  v_actor uuid := (p->>'actor_id')::uuid;
  v_inquiry uuid := (p->>'inquiry_id')::uuid;
  v_lead_phone text;
  v_sender uuid;
  v_draft client_phone_drafts;
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
  select id into v_sender from team_members where auth_user_id=v_actor;
  if not exists(select 1 from crm_lite_settings s join clients c on c.id=s.client_id
    where s.client_id=v_client and s.enabled and c.status not in ('paused','offboarded')
      and (v_sender is not null or (s.portal_enabled and exists(select 1 from portal_users u where u.auth_user_id=v_actor and u.client_id=v_client and u.is_active)))) then
    raise exception 'forbidden: inactive workspace actor' using errcode='insufficient_privilege';
  end if;
  -- The recipient is the lead's own number, never a number some other
  -- record holds: the inquiry's phone, the contact that holds that phone
  -- (unique per client), that contact's thread and that phone's consent.
  select phone_e164 into v_lead_phone from inquiries where id=v_inquiry and client_id=v_client;
  if not found then raise exception 'not_found: no such lead for this client' using errcode = 'P0002'; end if;
  if v_lead_phone is null then
    raise exception 'no_phone: this lead did not give a valid mobile number' using errcode = 'P0001';
  end if;
  select id into v_contact_id from contacts where client_id=v_client and phone_e164=v_lead_phone;
  if not found then
    raise exception 'lead_contact_mismatch: no contact holds this lead''s number yet' using errcode = 'P0001';
  end if;
  v_conv_id:=null; v_number_id:=null;
  if not exists(select 1 from communication_compliance_profiles where client_id=v_client and profile_type='toll_free_verification' and status='approved') then
    raise exception 'verification_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('compass.comm_request:' || v_request::text, 0));
  select m.id, m.conversation_id, m.client_id, m.provider_status, m.provider_message_sid, m.to_e164, m.from_e164, m.client_actor_id, m.inquiry_id
    into v_dup from communication_messages m where m.request_id = v_request;
  if found then
    if v_dup.client_id <> v_client or v_dup.client_actor_id is distinct from v_actor or v_dup.inquiry_id is distinct from v_inquiry then raise exception 'invalid: request_id belongs to another client' using errcode = '22023'; end if;
    return jsonb_build_object('duplicate', true, 'message_id', v_dup.id, 'conversation_id', v_dup.conversation_id,
      'provider_status', v_dup.provider_status, 'provider_message_sid', v_dup.provider_message_sid);
  end if;

  select * into v_draft from client_phone_drafts where client_id=v_client and inquiry_id=v_inquiry and actor_id=v_actor and revision=v_request for update;
  if not found then raise exception 'save_draft_first'; end if;
  v_body:=btrim(v_draft.body);
  if exists(select 1 from communication_messages where client_id=v_client and inquiry_id=v_inquiry and provider_status='pending' and provider_message_sid is null) then raise exception 'send_uncertain_refresh_first'; end if;
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
  if not found or v_contact.phone_e164 is distinct from v_lead_phone then
    raise exception 'lead_contact_mismatch: the lead''s number and its contact disagree' using errcode = 'P0001';
  end if;

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
    body, provider_status, sent_by, status_updated_at,client_actor_id,inquiry_id)
  values (v_client, v_conv, 'twilio', v_request, 'outbound', v_num.phone_number_e164, v_contact.phone_e164,
    v_body, 'pending', v_sender, now(),v_actor,v_inquiry)
  returning id into v_msg;
  perform set_config('compass.communications_write', '', true);

  return jsonb_build_object('duplicate', false, 'message_id', v_msg, 'conversation_id', v_conv,
    'to', v_contact.phone_e164, 'from', v_num.phone_number_e164,
    'messaging_service_sid', v_num.provider_service_sid, 'account_sid', v_num.provider_account_sid, 'body', v_body);
end $$;
revoke all on function client_phone_begin_sms(jsonb) from public, anon, authenticated;
grant execute on function client_phone_begin_sms(jsonb) to service_role;
