-- DEFERRED data repair, not a migration. Run only after
-- 20261119002142_crm_lite_web_consent_contact.sql is applied (it adds the
-- 'contact_relinked' event kind) and Tom has agreed to this exact change.
--
-- What it fixes (BHG Safety Partners, Nov 18 2026): inquiry 6233265f… gave
-- a valid phone, but intake linked it by email to the older contact
-- 6f2cf15e… (an internal test contact with no phone). The inbound text from
-- that number then created contact 7c022fbe… and its conversation ff8444ff…,
-- and the teammate-recorded consent b9b083f4… sits on that phone and that
-- contact. So the lead's own thread, recipient and consent all belong to
-- 7c022fbe…; only the inquiry's link points elsewhere.
--
-- Production audit (Nov 18 2026, every client): this is the only inquiry
-- whose phone differs from its linked contact's phone.
--
-- The change: inquiries.contact_id 6f2cf15e… → 7c022fbe… for that one row,
-- plus one append-only inquiry_events row ('contact_relinked') saying from,
-- to and why. Nothing else is touched: no contact is edited, merged or
-- deleted; no message, conversation, consent or consent event changes; the
-- other three inquiries on 6f2cf15e… keep it.
--
-- How it is safe to run: every expected value is checked first and any
-- difference refuses the whole script. The two CRM Lite guard triggers that
-- refuse SQL outside the CRM Lite functions are disabled only inside this
-- transaction (as 20261011233500 did for its one-time repair); ALTER TABLE is
-- transactional, so a failure re-enables them with the rollback.
--
-- Run (one transaction; the Supabase connector's execute_sql is one):
--   1. The preview at the bottom, read-only, for the "before".
--   2. This file.
--   3. The preview again for the "after".
-- Undo: the block in the comment at the end.

do $$
declare
  c_client  constant uuid := '3eaa3389-2a33-4004-837c-8aef90404410';
  c_inquiry constant uuid := '6233265f-87c3-4d97-b642-76c8c86b80f1';
  c_from    constant uuid := '6f2cf15e-151b-483d-83d9-5ce5c0ce2167';
  c_to      constant uuid := '7c022fbe-e8c7-4a42-9266-f7bd07300fbd';
  v_inq record;
  v_from record;
  v_to record;
  v_msgs int;
  v_cons int;
begin
  select id, client_id, contact_id, phone_e164 into v_inq from public.inquiries where id = c_inquiry for update;
  if not found or v_inq.client_id <> c_client then raise exception 'relink: inquiry not found under BHG'; end if;
  if v_inq.contact_id = c_to then raise exception 'relink: already linked to %; nothing to do', c_to; end if;
  if v_inq.contact_id is distinct from c_from then
    raise exception 'relink: inquiry is linked to %, expected %; review again', v_inq.contact_id, c_from;
  end if;
  select id, client_id, phone_e164 into v_from from public.contacts where id = c_from;
  select id, client_id, phone_e164 into v_to from public.contacts where id = c_to;
  if v_from.client_id <> c_client or v_from.phone_e164 is not null then
    raise exception 'relink: the old contact changed (client or phone); review again';
  end if;
  if v_to.client_id <> c_client or v_to.phone_e164 is distinct from v_inq.phone_e164 or v_inq.phone_e164 is null then
    raise exception 'relink: the target contact does not hold the inquiry''s phone; review again';
  end if;
  if (select count(*) from public.contacts where client_id = c_client and phone_e164 = v_inq.phone_e164) <> 1 then
    raise exception 'relink: expected exactly one contact holding the phone';
  end if;
  select count(*) into v_msgs from public.communication_messages m join public.communication_conversations v on v.id = m.conversation_id
   where v.contact_id = c_to;
  select count(*) into v_cons from public.communication_consents where client_id = c_client and phone_e164 = v_inq.phone_e164;

  alter table public.inquiries disable trigger inquiries_guard;
  alter table public.inquiry_events disable trigger inquiry_events_guard;
  update public.inquiries set contact_id = c_to where id = c_inquiry and contact_id = c_from;
  insert into public.inquiry_events (client_id, inquiry_id, kind, detail, actor_kind, actor_name)
  values (c_client, c_inquiry, 'contact_relinked', jsonb_build_object(
      'from_contact_id', c_from, 'to_contact_id', c_to, 'matched_by', 'phone',
      'reason', 'Intake linked this inquiry by email to an older contact with no phone; the contact holding the inquiry''s own number has its texts and consent.',
      'messages_on_target', v_msgs, 'consents_on_phone', v_cons, 'repair', '20261118_bhg_inquiry_contact_relink'),
    'system', 'Compass data repair');
  alter table public.inquiry_events enable trigger inquiry_events_guard;
  alter table public.inquiries enable trigger inquiries_guard;

  raise notice 'relinked inquiry % from % to % (% messages, % consent rows on that phone; none changed)',
    c_inquiry, c_from, c_to, v_msgs, v_cons;
end $$;

-- Preview (read-only), before and after:
--   select i.id, i.contact_id, right(i.phone_e164, 4) phone4, right(k.phone_e164, 4) contact_phone4,
--          (select count(*) from inquiry_events e where e.inquiry_id = i.id and e.kind = 'contact_relinked') relinks,
--          (select count(*) from communication_conversations v where v.contact_id = i.contact_id) threads,
--          (select string_agg(status, ',') from communication_consents s where s.client_id = i.client_id and s.phone_e164 = i.phone_e164) consent
--   from inquiries i left join contacts k on k.id = i.contact_id
--   where i.id = '6233265f-87c3-4d97-b642-76c8c86b80f1';
--
-- Undo (the event row stays; history is append-only):
--   do $$ begin
--     alter table public.inquiries disable trigger inquiries_guard;
--     update public.inquiries set contact_id = '6f2cf15e-151b-483d-83d9-5ce5c0ce2167'
--      where id = '6233265f-87c3-4d97-b642-76c8c86b80f1' and contact_id = '7c022fbe-e8c7-4a42-9266-f7bd07300fbd';
--     alter table public.inquiries enable trigger inquiries_guard;
--   end $$;
