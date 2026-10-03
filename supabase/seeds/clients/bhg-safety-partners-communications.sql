-- BHG Safety Partners — Compass Communications pilot setup (issue #88).
--
-- Data script, not a migration. Run as postgres through the Supabase MCP
-- AFTER 0063 is applied, after a rolled-back dry run. Idempotent: it only
-- inserts what is missing and never changes a row a teammate has touched.
--
-- What it does, as data only (no client-specific code exists anywhere):
--   * client_communication_settings: communications ON, sending OFF. Only a
--     signed-in teammate turns sending on (0063 refuses it from this login),
--     and only after the toll-free verification is approved.
--   * a draft secondary customer profile with BHG's business identity;
--   * a draft toll-free verification with the messaging program (customer
--     care; inquiry responses, quote follow-up, training scheduling,
--     reminders; ~1,000 messages / month; web-form opt-in) and the standard
--     pre-submission checklist.
--
-- What it does NOT do: no EIN (it is entered from BHG's IRS record in the
-- Twilio Console at submission and never stored in Compass); no Twilio
-- subaccount, Messaging Service or number (those are created from the
-- Numbers page by a Compass admin, which records Twilio's SIDs); no privacy /
-- terms / opt-in URLs (BHG's site does not carry the SMS disclosures yet —
-- they are checklist items); nothing is sent and nothing is purchased.
--
-- Known facts (issue #88): BHG Safety Partners LLC, 11325 Dove Ridge Road,
-- Hannibal, MO 63401; business phone 573-822-6448; contact Brad Gibbons,
-- brad@bhgsafety.com; preferred number: US toll-free, 800 prefix; no
-- purchased lists, no cold texting.

do $$
declare
  v_client constant uuid := '3eaa3389-2a33-4004-837c-8aef90404410';
  v_profile uuid;
  v_tfv uuid;
begin
  if not exists (select 1 from clients where id = v_client and name ilike 'BHG Safety Partners%') then
    raise exception 'BHG Safety Partners (%) is not in this database', v_client;
  end if;

  insert into client_communication_settings (client_id, enabled, outbound_enabled, display_name, notes)
  values (v_client, true, false, 'BHG Safety',
    'Pilot (issue #88). Sending stays off until the toll-free verification is approved.')
  on conflict (client_id) do nothing;

  select id into v_profile from communication_compliance_profiles
   where client_id = v_client and profile_type = 'secondary_customer_profile';
  if v_profile is null then
    insert into communication_compliance_profiles (client_id, profile_type, legal_business_name, website_url,
      address_street, address_city, address_region, address_postal_code, address_country,
      business_contact_name, business_contact_email, business_contact_phone)
    values (v_client, 'secondary_customer_profile', 'BHG Safety Partners LLC', 'https://bhgsafety.com/',
      '11325 Dove Ridge Road', 'Hannibal', 'MO', '63401', 'US',
      'Brad Gibbons', 'brad@bhgsafety.com', '+15738226448')
    returning id into v_profile;
  end if;

  select id into v_tfv from communication_compliance_profiles
   where client_id = v_client and profile_type = 'toll_free_verification';
  if v_tfv is null then
    insert into communication_compliance_profiles (client_id, profile_type, legal_business_name, website_url,
      address_street, address_city, address_region, address_postal_code, address_country,
      business_contact_name, business_contact_email, business_contact_phone,
      use_case_categories, use_case_summary, sample_messages, message_volume, opt_in_type)
    values (v_client, 'toll_free_verification', 'BHG Safety Partners LLC', 'https://bhgsafety.com/',
      '11325 Dove Ridge Road', 'Hannibal', 'MO', '63401', 'US',
      'Brad Gibbons', 'brad@bhgsafety.com', '+15738226448',
      '{CUSTOMER_CARE}',
      'BHG Safety Partners texts customers and prospects who opted in on its website contact form (optional, unchecked SMS consent) or who texted the business first: replies to inquiries, quote follow-ups, safety-training scheduling and reminders, and customer care. No purchased lists and no cold or marketing campaigns. Message frequency varies.',
      array[
        'BHG Safety Partners: Thanks for your inquiry about OSHA training. When is a good time to call you about dates? Reply STOP to opt out.',
        'BHG Safety Partners: Following up on the quote we sent for your first aid/CPR class. Any questions? Reply HELP for help, STOP to opt out.',
        'BHG Safety Partners: Reminder: your training is scheduled for Tue at 8:00 AM. Reply STOP to opt out.'
      ],
      '1,000', 'WEB_FORM')
    returning id into v_tfv;
  end if;

  perform communication_ensure_checklist(v_tfv);
end $$;

-- Check (read-only):
-- select c.enabled, c.outbound_enabled,
--        (select count(*) from communication_compliance_profiles where client_id = c.client_id) as registrations,
--        (select count(*) from communication_compliance_items where client_id = c.client_id) as checklist
-- from client_communication_settings c where c.client_id = '3eaa3389-2a33-4004-837c-8aef90404410';
