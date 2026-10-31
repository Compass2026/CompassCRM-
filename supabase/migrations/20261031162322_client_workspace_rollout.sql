-- Roll out the enhanced workspace per client; existing portals keep their current screen.
alter table crm_lite_settings add column workspace_enabled boolean not null default false;
create or replace view portal_crm_lite with (security_invoker=false) as
  select s.client_id, s.portal_enabled, s.workspace_enabled
  from crm_lite_settings s
  where s.client_id=(select portal_client_id()) and s.enabled and s.portal_enabled;
