-- Tests for migration 0064 (Option B: the dedicated billing runtime login),
-- run by scripts/test-portal-sandbox.sh after the billing suites. Own harness
-- schema (brt), fictional clients and Stripe ids.
--
-- Callers, as they reach production:
--   runtime   psql as billing_sync (the compass-billing Vercel project)
--   service   psql as authenticator, role service_role (any Edge Function)
--   worker    psql as postgres (the Supabase MCP / connector SQL)

\o /dev/null
create schema brt;
create table brt.results (n serial, status text, name text, detail text);
grant usage on schema brt to billing_sync, authenticator, service_role;
grant insert, select on brt.results to billing_sync, authenticator, service_role;
grant usage on sequence brt.results_n_seq to billing_sync, authenticator, service_role;
create function brt.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into brt.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function brt.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function brt.id(p_k text) returns uuid language sql immutable as $$ select md5('brt:' || p_k)::uuid $$;
grant execute on all functions in schema brt to billing_sync, authenticator, service_role;

insert into clients (id, name, city, state, status, notes) values
  (brt.id('c1'), 'Runtime Roofing', 'Wentzville', 'MO', 'active', 'private note');
insert into billing_packages (id, key, name, kind) values
  (brt.id('std'), 'br_standard', 'Runtime Standard', 'standard'),
  (brt.id('cus'), 'br_custom', 'Runtime Custom', 'custom');

-- ── R. The runtime login: billing writes through the functions ──────────────
\c - billing_sync
do $$
declare e text; r jsonb;
begin
  perform brt.ok('R1 session_user is the billing login', session_user = 'billing_sync');
  r := billing_event_begin(jsonb_build_object('id', 'evt_BR1', 'type', 'invoice.paid', 'livemode', false,
    'api_version', null, 'event_created_at', now(), 'object_type', 'invoice', 'object_id', 'in_BR1'), 300);
  perform brt.ok('R2 the runtime claims a webhook event', (r ->> 'claimed')::boolean, r::text);
  r := billing_event_finish('evt_BR1', 1, 'ignored', 'unsupported_event');
  perform brt.ok('R3 ...and finishes it', (select status from stripe_events where id = 'evt_BR1') = 'ignored', r::text);
  r := billing_sync_apply(jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', 'product',
    'row', jsonb_build_object('stripe_product_id', 'prod_BR1', 'livemode', false, 'name', 'Runtime product',
      'active', true, 'metadata', '{}'::jsonb, 'stripe_synced_at', now())))));
  perform brt.ok('R4 the runtime writes the mirror through billing_sync_apply',
    exists (select 1 from stripe_products where stripe_product_id = 'prod_BR1'), r::text);
  perform brt.ok('R5 the runtime records an audit event', billing_audit(jsonb_build_object('client_id', brt.id('c1'),
    'action', 'resync_customer', 'actor_kind', 'team', 'detail', '{}'::jsonb)) is not null);
  perform brt.ok('R6 the runtime reads the billing status read model',
    (select count(*) from client_billing_status where client_id = brt.id('c1')) = 1);
  perform brt.ok('R7 ...and the mirror fingerprint', billing_mirror_fingerprint(brt.id('c1'), false) ? 'customer');

  -- No direct mirror, ledger, agreement or history writes.
  e := brt.try($q$insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at) values ('prod_BR2', false, 'x', true, now())$q$);
  perform brt.ok('R8 no direct mirror insert', e like '42501%', e);
  e := brt.try($q$update stripe_events set status = 'processed', processed_at = now() where id = 'evt_BR1'$q$);
  perform brt.ok('R9 no direct ledger update', e like '42501%', e);
  e := brt.try(format($q$update plans set agreed_amount_cents = 1 where client_id = %L$q$, brt.id('c1')));
  perform brt.ok('R10 no agreement update', e like '42501%', e);
  e := brt.try($q$delete from billing_reconciliation_runs$q$);
  perform brt.ok('R11 no history delete', e like '42501%', e);
  e := brt.try($q$insert into app_settings (key, value) values ('billing', '{"livemode": true}')$q$);
  perform brt.ok('R12 cannot switch the billing mode', e like '42501%', e);

  -- Only the columns it needs on shared tables.
  e := brt.try($q$select notes from clients$q$);
  perform brt.ok('R13 cannot read client notes', e like '42501%', e);
  e := brt.try($q$select email from team_members$q$);
  perform brt.ok('R14 cannot read teammates'' emails', e like '42501%', e);
  perform brt.ok('R15 reads a client''s name', (select name from clients where id = brt.id('c1')) = 'Runtime Roofing');

  -- The direct writes the handlers make after their admin check, and only those.
  e := brt.try(format($q$update billing_packages set stripe_product_id = 'prod_BR1' where id = %L$q$, brt.id('std')));
  perform brt.ok('R16 maps a catalog entry''s Stripe Product', e is null
    and (select stripe_product_id from billing_packages where id = brt.id('std')) = 'prod_BR1', e);
  e := brt.try(format($q$update billing_packages set name = 'Renamed' where id = %L$q$, brt.id('std')));
  perform brt.ok('R17 cannot rename a package', e like '42501%', e);
  e := brt.try($q$insert into app_settings (key, value) values ('billing_portal', '{"configuration_id": "bpc_BR"}')$q$);
  perform brt.ok('R18 saves the portal setting', e is null, e);
  e := brt.try($q$insert into app_settings (key, value) values ('google_ops', '{}')$q$);
  perform brt.ok('R19 cannot write another setting', e like '42501%', e);

  -- Vault and secrets are out of reach.
  e := brt.try($q$select get_secret('STRIPE_SECRET_KEY')$q$);
  perform brt.ok('R20 cannot call get_secret', e like '42501%', e);
  e := brt.try($q$select count(*) from vault.decrypted_secrets$q$);
  perform brt.ok('R21 cannot read Vault', e like '42501%', e);
  e := brt.try($q$update billing_runtime set edge_functions = true$q$);
  perform brt.ok('R22 cannot touch the runtime switch', e like '42501%', e);
end $$;

-- Prices: a client-bound custom price only, never a standard or default one.
do $$
declare e text;
begin
  e := brt.try(format($q$insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id, client_id, is_default)
    values (%L, 'standard', 'prod_BR1', 'price_BR_std', null, true)$q$, brt.id('std')));
  perform brt.ok('R23 cannot add a standard or default price', e is not null and (e like '42501%' or e like '23%'), e);
end $$;

-- ── S. The Edge Function path while the switch is open, then closed ─────────
\c - authenticator
set role service_role;
do $$
declare e text;
begin
  perform brt.ok('S1 the Edge Function path still writes (switch open)',
    billing_audit(jsonb_build_object('client_id', brt.id('c1'), 'action', 'resync_customer', 'actor_kind', 'team', 'detail', '{}'::jsonb)) is not null);
  e := brt.try($q$update billing_runtime set edge_functions = true$q$);
  perform brt.ok('S2 service_role cannot change the switch', e like '42501%', e);
end $$;
reset role;

\c - postgres
do $$
declare e text;
begin
  e := brt.try($q$select billing_audit('{"action": "worker_probe", "actor_kind": "team"}')$q$);
  perform brt.ok('S3 the worker''s SQL is still refused', e like '42501%', e);
end $$;
update billing_runtime set edge_functions = false, updated_at = now();

\c - authenticator
set role service_role;
do $$
declare e text;
begin
  e := brt.try(format($q$select billing_audit(jsonb_build_object('client_id', %L::uuid, 'action', 'resync_customer', 'actor_kind', 'team', 'detail', '{}'::jsonb))$q$, brt.id('c1')));
  perform brt.ok('S4 the Edge Function path is refused once the switch is closed', e like '42501%', e);
  e := brt.try($q$select billing_sync_apply('{"ops": []}')$q$);
  perform brt.ok('S5 ...for the sync as well', e like '42501%', e);
end $$;
reset role;

\c - billing_sync
do $$
begin
  perform brt.ok('S6 the runtime still writes with the switch closed',
    billing_audit(jsonb_build_object('client_id', brt.id('c1'), 'action', 'resync_customer', 'actor_kind', 'team', 'detail', '{}'::jsonb)) is not null);
end $$;

-- Restore the default for any suite that runs after this one.
\c - postgres
update billing_runtime set edge_functions = true, updated_at = now();

\o
\pset footer off
select status, count(*) from brt.results group by status order by status;
select n, status, name, detail from brt.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from brt.results where status = 'fail';
  if f > 0 then raise exception '% billing runtime check(s) failed', f; end if;
end $$;
