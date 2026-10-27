-- Sandbox harness only (never a migration). Suites written before the core
-- keyword gates (20261027160000) test their own behaviour with fictional
-- clients that have no core keyword list. They run with the recorded
-- exception (core_keyword_exemptions), granted here for every existing client
-- and, through a sandbox trigger, every client a suite creates. The admin-only
-- guard on exemptions is switched off for this harness only.
-- weekly_social_slots and delivery_standard switch both back inside their
-- own transaction and test the strict rule.
alter table core_keyword_exemptions disable trigger core_keyword_exemptions_guard;
insert into core_keyword_exemptions (client_id, reason) select id, 'sandbox: legacy suite fixture' from clients
on conflict do nothing;
create function public.sandbox_core_exempt_new_client() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into core_keyword_exemptions (client_id, reason) values (new.id, 'sandbox: legacy suite fixture') on conflict do nothing;
  return new;
end $$;
revoke all on function public.sandbox_core_exempt_new_client() from public, anon, authenticated;
create trigger sandbox_core_exempt_new_client after insert on clients for each row execute function public.sandbox_core_exempt_new_client();
