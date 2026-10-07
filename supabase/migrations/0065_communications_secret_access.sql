-- 0065 — Compass Communications: per-subaccount Vault access and Twilio's
-- official SID format (Oct 5 2026; fixes the BHG link of Oct 5).
--
-- 1. One read for a subaccount's credentials. The communications and
--    twilio-webhook functions read TWILIO_SUB_<AccountSid>_API_KEY /
--    _API_SECRET / _AUTH_TOKEN through communication_subaccount_secrets(sid)
--    instead of building names for get_secret(). It returns the three values
--    and, for each, the exact name it expects and the name it found, so a
--    missing credential is reported by name. A name that differs from the
--    expected one only in the SID's letter case is accepted when it is the
--    only such name (a token stored by hand as AC4AF8… is found for AC4af8…);
--    surrounding whitespace is trimmed (a pasted token often carries a
--    newline). It also lists the other subaccount SIDs Vault holds an Auth
--    Token for, which is how a token stored under another SID is spotted.
--    Service role only, like get_secret().
-- 2. communication_secret_status(sid): the same matching, answered yes / no
--    for the Settings and Numbers pages (a teammate or the service role). It
--    never returns a value.
-- 3. Twilio documents SIDs as two letters and 32 hex digits of either case
--    ([0-9a-fA-F]); 0063 accepted lower case only. The registry constraints
--    and the three functions that check a MessageSid accept both now.
--    Nothing else in 0063 changes (the three functions are 0063's bodies with
--    that one pattern replaced).
--
-- get_secret(), set_secret() and secret_present() are unchanged; no secret
-- value is stored outside Vault and no Communications row changes.
--
-- Rollback: drop communication_secret_status(text),
-- communication_subaccount_secrets(text), communication_vault_match(text);
-- re-create the five constraints and three functions from 0063.

-- ── 1. Vault matching ───────────────────────────────────────────────────────
-- The secret stored under exactly p_name; else under the one name that equals
-- it ignoring case. Internal: callable only by the functions below.
create function communication_vault_match(p_name text)
returns table (matched_name text, secret text)
language sql stable security definer set search_path = public, pg_catalog as $$
  select d.name, nullif(btrim(d.decrypted_secret, E' \t\r\n'), '')
  from vault.decrypted_secrets d
  where lower(d.name) = lower(p_name)
    and (d.name = p_name
         or not exists (select 1 from vault.secrets s where s.name = p_name)
            and (select count(*) from vault.secrets s where lower(s.name) = lower(p_name)) = 1)
  order by (d.name = p_name) desc
  limit 1
$$;
revoke all on function communication_vault_match(text) from public, anon, authenticated, service_role;

create function communication_subaccount_secrets(p_account_sid text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare
  v_out jsonb := '{}'::jsonb;
  v_kind text;
  v_name text;
  v_found text;
  v_value text;
begin
  if p_account_sid is null or p_account_sid !~ '^AC[0-9a-fA-F]{32}$' then
    raise exception 'invalid: not a Twilio account SID' using errcode = '22023';
  end if;
  foreach v_kind in array array['api_key', 'api_secret', 'auth_token'] loop
    v_name := 'TWILIO_SUB_' || p_account_sid || '_' || upper(v_kind);
    v_found := null; v_value := null;
    select m.matched_name, m.secret into v_found, v_value from communication_vault_match(v_name) m;
    v_out := v_out || jsonb_build_object(v_kind, v_value, v_kind || '_name', v_name, v_kind || '_found_as', v_found);
  end loop;
  return v_out || jsonb_build_object(
    'account_sid', p_account_sid,
    'other_auth_token_accounts', (
      select coalesce(jsonb_agg(sid order by sid), '[]'::jsonb) from (
        select substring(s.name from '^TWILIO_SUB_(AC[0-9a-fA-F]{32})_AUTH_TOKEN$') as sid from vault.secrets s) x
      where sid is not null and lower(sid) <> lower(p_account_sid)));
end $$;
revoke all on function communication_subaccount_secrets(text) from public, anon, authenticated;
grant execute on function communication_subaccount_secrets(text) to service_role;
comment on function communication_subaccount_secrets(text) is
  'A Twilio subaccount''s API key, API secret and Auth Token from Vault (TWILIO_SUB_<sid>_*), each with the name expected and the name found; a name differing only in the SID''s case counts when it is the only one. Service role only (0065).';

create function communication_secret_status(p_account_sid text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_catalog as $$
declare
  v_sub jsonb;
begin
  if communication_caller() not in ('team', 'service', 'superuser') then
    raise exception 'forbidden: Compass team only' using errcode = 'insufficient_privilege';
  end if;
  if p_account_sid is not null then
    v_sub := communication_subaccount_secrets(p_account_sid);
  end if;
  return jsonb_build_object(
    'parent', (select count(*) = 3 from vault.secrets where name in ('TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY', 'TWILIO_API_SECRET')),
    'subaccount_key', v_sub is not null and v_sub->>'api_key' is not null and v_sub->>'api_secret' is not null,
    'subaccount_auth_token', v_sub is not null and v_sub->>'auth_token' is not null,
    'auth_token_name', v_sub->>'auth_token_name',
    'auth_token_found_as', v_sub->>'auth_token_found_as',
    'other_auth_token_accounts', coalesce(v_sub->'other_auth_token_accounts', '[]'::jsonb));
end $$;
revoke all on function communication_secret_status(text) from public, anon;
grant execute on function communication_secret_status(text) to authenticated, service_role;
comment on function communication_secret_status(text) is
  'Yes / no for the parent Main key and a subaccount''s key and Auth Token in Vault, with the expected secret name; never a value. A teammate or the service role (0065).';

-- ── 2. Twilio SIDs: [0-9a-fA-F] ─────────────────────────────────────────────
alter table communication_accounts drop constraint communication_accounts_provider_account_sid_check,
  add constraint communication_accounts_provider_account_sid_check check (provider_account_sid ~ '^AC[0-9a-fA-F]{32}$');
alter table communication_messaging_services drop constraint communication_messaging_services_provider_service_sid_check,
  add constraint communication_messaging_services_provider_service_sid_check check (provider_service_sid ~ '^MG[0-9a-fA-F]{32}$');
alter table communication_numbers drop constraint communication_numbers_provider_phone_number_sid_check,
  add constraint communication_numbers_provider_phone_number_sid_check check (provider_phone_number_sid ~ '^PN[0-9a-fA-F]{32}$');
alter table communication_messages drop constraint communication_messages_provider_message_sid_check,
  add constraint communication_messages_provider_message_sid_check check (provider_message_sid ~ '^(SM|MM)[0-9a-fA-F]{32}$');
alter table communication_compliance_profiles drop constraint communication_compliance_profiles_sid_shape,
  add constraint communication_compliance_profiles_sid_shape check (
    provider_profile_sid is null
    or (profile_type = 'secondary_customer_profile' and provider_profile_sid ~ '^BU[0-9a-fA-F]{32}$')
    or (profile_type = 'toll_free_verification' and provider_profile_sid ~ '^HH[0-9a-fA-F]{32}$'));

-- 0063's three MessageSid checks, otherwise unchanged.
create or replace function communication_record_inbound(p jsonb) returns jsonb
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
  if v_sid is null or v_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$' then raise exception 'invalid: MessageSid' using errcode = '22023'; end if;
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

create or replace function communication_mark_sent(p jsonb) returns jsonb
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
    if v_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$' then raise exception 'invalid: MessageSid' using errcode = '22023'; end if;
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

create or replace function communication_record_status(p jsonb) returns jsonb
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
  if v_sid is null or v_sid !~ '^(SM|MM)[0-9a-fA-F]{32}$' then raise exception 'invalid: MessageSid' using errcode = '22023'; end if;
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

-- ── 3. Verify ───────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('anon', 'communication_subaccount_secrets(text)', 'execute')
     or has_function_privilege('authenticated', 'communication_subaccount_secrets(text)', 'execute') then
    raise exception '0065: communication_subaccount_secrets must be the service role''s only';
  end if;
  if has_function_privilege('anon', 'communication_secret_status(text)', 'execute')
     or has_function_privilege('anon', 'communication_vault_match(text)', 'execute')
     or has_function_privilege('authenticated', 'communication_vault_match(text)', 'execute')
     or has_function_privilege('service_role', 'communication_vault_match(text)', 'execute') then
    raise exception '0065: a Vault helper is reachable from the API';
  end if;
  if exists (select 1 from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c'
             and conrelid::regclass::text like 'communication%' and pg_get_constraintdef(oid) ~ '\[0-9a-f\]\{32\}') then
    raise exception '0065: a Communications constraint still accepts lower-case SIDs only';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname like 'communication%'
             and prosrc ~ '\[0-9a-f\]\{32\}') then
    raise exception '0065: a Communications function still accepts lower-case SIDs only';
  end if;
end $$;
