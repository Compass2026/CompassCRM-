-- Ginger Huff Interiors — CRM Lite pilot setup (docs/crm-lite.md).
--
-- Data script, not a migration. Run as postgres through the Supabase MCP
-- AFTER 20261012002616_crm_lite.sql is applied, after a rolled-back dry run.
-- Idempotent: it only inserts what is missing and never changes a row a
-- teammate has touched.
--
-- What it does, as data only (no client-specific code exists anywhere):
--   * crm_lite_settings: CRM Lite ON, client portal access ON (nobody sees it
--     until a portal contact is invited — Ginger has none today), SMS OFF.
--     The database refuses SMS on from this login.
--   * inquiry_sources: "ginger-huff-website", DISABLED. A Compass admin
--     issues its token (Setup & alerts › Issue token; stored in Vault as
--     CRM_INTAKE_GINGER_HUFF_WEBSITE), then enables it.
--   * No alert sender: a Compass admin adds Compass's own sender (the
--     "Compass - Notifications" subaccount and its toll-free number) on the
--     Setup & alerts page, as Twilio identifiers are recorded for BHG — they
--     are not committed to the repository. Its verification starts pending;
--     only a signed-in admin records approval.
--   * notification_recipients: Ginger's confirmed mobile for alerts, with
--     consent PENDING. The owner confirmed she wants inquiry texts; the date,
--     method, her actual response and the disclosure acknowledgment are not
--     recorded here (they are not known), so nothing marks consent complete.
--
-- What it does NOT do: no credential (the sender's API key / Auth Token and
-- the intake token live only in Vault); no BHG sender or credential; no
-- text, no email, no invitation, no password reset; nothing for any other
-- client.

do $$
declare
  v_client constant uuid := 'db9009c2-a04b-4e93-843f-e20c49263b5b';
begin
  if not exists (select 1 from clients where id = v_client and name ilike 'Ginger Huff Interiors%') then
    raise exception 'Ginger Huff Interiors (%) is not in this database', v_client;
  end if;

  insert into crm_lite_settings (client_id, enabled, portal_enabled, display_name, notes)
  values (v_client, true, true, 'Ginger Huff Interiors',
    'CRM Lite pilot (Oct 2026). Inquiries from gingerhuffinteriors.com. SMS alerts stay off until the toll-free verification is approved, Ginger''s consent is recorded and a delivery test is confirmed.')
  on conflict (client_id) do nothing;

  insert into inquiry_sources (client_id, source_key, kind, label, site_url, enabled, secret_name)
  values (v_client, 'ginger-huff-website', 'website_form', 'gingerhuffinteriors.com contact form', 'https://www.gingerhuffinteriors.com',
    false, 'CRM_INTAKE_GINGER_HUFF_WEBSITE')
  on conflict (source_key) do nothing;

  insert into notification_recipients (client_id, channel, phone_e164, name, link_target, enabled)
  values (v_client, 'sms', '+16187919113', 'Ginger Huff (mobile)', 'portal', true)
  on conflict (client_id, channel, phone_e164) do nothing;
end $$;
