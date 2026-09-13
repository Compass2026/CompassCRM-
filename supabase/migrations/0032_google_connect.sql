-- Connect Google from Settings (Tom, Sept 13 2026: "Build the Google Button").
--
-- google-ops needs GOOGLE_OPS_REFRESH_TOKEN and GA4_ACCOUNT_ID in Vault; until
-- now both had to be pasted in by hand. The google-connect Edge Function runs
-- the OAuth consent flow from a button on the Settings page and stores what
-- Google hands back through set_secret(). Nothing here exposes a value:
-- set_secret is service-role only and secret_present() answers yes / no so
-- the page can show status.

create or replace function set_secret(secret_name text, secret_value text) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = secret_name;
  if v_id is null then
    perform vault.create_secret(secret_value, secret_name);
  else
    perform vault.update_secret(v_id, secret_value);
  end if;
end $$;
revoke execute on function set_secret(text, text) from public, anon, authenticated;
grant execute on function set_secret(text, text) to service_role;

create or replace function secret_present(secret_name text) returns boolean
language sql security definer
set search_path = public
as $$
  select exists (select 1 from vault.secrets where name = secret_name);
$$;
revoke execute on function secret_present(text) from public, anon;
grant execute on function secret_present(text) to authenticated, service_role;

comment on function set_secret(text, text) is 'Upsert a Vault secret. Service role only; called by google-connect.';
comment on function secret_present(text) is 'Whether a Vault secret exists, never its value. Settings page status.';
