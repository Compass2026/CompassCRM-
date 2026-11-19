-- Lead communications reuse the existing SMS transport and STOP/consent ledger.
-- Portal callers receive no base-table grants or provisioning permissions.
alter table communication_messages add column client_actor_id uuid references auth.users(id);
alter table communication_messages add column inquiry_id uuid;
alter table communication_messages add constraint communication_messages_inquiry_fk foreign key(inquiry_id,client_id) references inquiries(id,client_id);
create table client_phone_drafts (
  client_id uuid not null references clients(id), inquiry_id uuid not null, actor_id uuid not null references auth.users(id),
  body text not null check(length(body)<=1600), revision uuid not null default gen_random_uuid(), updated_at timestamptz not null default now(),
  primary key(client_id,inquiry_id,actor_id), foreign key(inquiry_id,client_id) references inquiries(id,client_id)
);
create table client_voice_settings (
  client_id uuid primary key references clients(id), enabled boolean not null default false,
  application_sid text check(application_sid ~ '^AP[0-9a-fA-F]{32}$'),
  fallback_url text check(fallback_url ~ '^https://handler\.twilio\.com/twiml/EH[0-9a-fA-F]{32}$')
);
create table client_voice_calls (
  id uuid primary key default gen_random_uuid(), client_id uuid not null references clients(id), inquiry_id uuid,
  actor_id uuid references auth.users(id), provider_sid text unique, direction text not null check(direction in ('inbound','outbound')),
  from_number text not null, to_number text not null, status text not null default 'prepared',
  duration integer, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '2 minutes',
  foreign key(inquiry_id,client_id) references inquiries(id,client_id)
);
create index on client_voice_calls(client_id,created_at desc);
alter table client_phone_drafts enable row level security;
alter table client_voice_settings enable row level security;
alter table client_voice_calls enable row level security;
revoke all on client_phone_drafts,client_voice_settings,client_voice_calls from public,anon,authenticated;
grant all on client_phone_drafts,client_voice_settings,client_voice_calls to service_role;

create function client_phone_begin_sms(p jsonb) returns jsonb
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
  select contact_id into v_contact_id from inquiries where id=v_inquiry and client_id=v_client;
  if not found or v_contact_id is null then raise exception 'not_found: lead contact'; end if;
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
