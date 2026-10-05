-- 0064 — Option B: the dedicated billing runtime (docs/billing-runtime.md;
-- the decision is docs/billing-service-role.md).
--
-- The three Stripe handlers move out of Supabase Edge Functions into their own
-- Vercel project (`compass-billing`, billing/). Only that project holds the
-- Stripe key, the webhook signing secret and the password of the database
-- login created here. No other Compass code has any of them, and the billing
-- runtime holds no Supabase service-role key.
--
-- What it does
--   1. `billing_sync`, a database login for the billing runtime alone: no
--      superuser, BYPASSRLS, CREATEROLE, CREATEDB or replication, a member of
--      no role, and no password here — Tom sets one in the SQL editor
--      (docs/billing-runtime.md § 2). Until then nobody can log in as it.
--   2. Billing-only access, all of it through RLS policies scoped to this
--      login and explicit grants (no PUBLIC grant reaches it):
--        - read: the Stripe mirror, the catalog, the webhook ledger, the
--          reconciliation history and the billing read models; on shared
--          tables only the columns the handlers read (clients: id, name,
--          status; plans: the agreement columns; team_members and
--          portal_users: who a signed-in caller is);
--        - write, directly: only what the handlers already wrote directly
--          after their own admin check — a catalog entry's Stripe Product, a
--          client's custom-retainer price (custom, client-bound, never a
--          default), and the `billing_portal` setting. Never `plans`, the
--          billing mode (`billing`), entitlements, or a mirror table;
--        - execute: the billing write functions (sync, ledger, operations,
--          reconciliation) and the read helpers the read models call. Not
--          get_secret / set_secret, not Vault.
--   3. The write boundary admits this login: billing_caller_is_service() is
--      true for session_user `billing_sync`. session_user is the login, so
--      neither SET ROLE nor anything short of the password or a superuser can
--      present it (the worker's SQL stays refused, as before).
--   4. The Edge Function path (authenticator + service_role) stays open while
--      `billing_runtime.edge_functions` is true — the TEST setup keeps
--      working until the replacement is verified — and closes the moment the
--      owner sets it false (docs/billing-runtime.md § 6). Only the table owner
--      can change that row: service_role may read it, never write it, so no
--      Edge Function can reopen the path for itself.

-- ── 1. The login ────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'billing_sync') then
    create role billing_sync login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      connection limit 20;
  end if;
end $$;
alter role billing_sync set statement_timeout = '60s';
comment on role billing_sync is
  'The dedicated billing runtime (Vercel project compass-billing). Billing-only access; the only session the billing write functions admit once billing_runtime.edge_functions is false. Password set by the owner, never in the repository.';
grant usage on schema public to billing_sync;

-- ── 2. The runtime switch ───────────────────────────────────────────────────
create table billing_runtime (
  id boolean primary key default true check (id),
  edge_functions boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into billing_runtime default values;
alter table billing_runtime enable row level security;
revoke all on billing_runtime from public, anon, authenticated, service_role;
grant select on billing_runtime to service_role;
comment on table billing_runtime is
  'Whether the Supabase Edge Function billing path (authenticator + service_role) may still write billing. One row; only the owner changes it: update billing_runtime set edge_functions = false, updated_at = now().';

create or replace function billing_caller_is_service() returns boolean
language sql stable set search_path = public, pg_temp as $$
  select session_user = 'billing_sync'
      or (session_user = 'authenticator'
          and coalesce(current_setting('role', true), '') = 'service_role'
          and coalesce((select r.edge_functions from public.billing_runtime r where r.id), false))
$$;

-- ── 3. Reads ────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  -- Billing's own tables, whole rows (reconciliation fingerprints hash rows).
  foreach t in array array['stripe_products', 'stripe_prices', 'stripe_customers', 'checkout_sessions',
    'subscriptions', 'subscription_items', 'invoices', 'invoice_line_items', 'payments', 'stripe_refunds',
    'stripe_events', 'billing_packages', 'billing_package_prices', 'billing_one_time_items',
    'billing_reconciliation_runs', 'billing_reconciliation_results'] loop
    execute format('grant select on %I to billing_sync', t);
    execute format('create policy "billing runtime reads" on %I for select to billing_sync using (true)', t);
  end loop;
  -- Shared tables: only the columns the handlers read.
  foreach t in array array['clients', 'plans', 'team_members', 'portal_users'] loop
    execute format('create policy "billing runtime reads" on %I for select to billing_sync using (true)', t);
  end loop;
end $$;
grant select (id, name, status) on clients to billing_sync;
grant select (client_id, package_id, collection, agreed_amount_cents, agreed_currency, agreed_billing_interval,
              agreed_billing_interval_count, billing_package_price_id) on plans to billing_sync;
grant select (id, role, auth_user_id) on team_members to billing_sync;
grant select (id, client_id, auth_user_id, is_active) on portal_users to billing_sync;
-- The read models the handlers query (invoker rights: the grants above apply).
grant select on client_agreement_price, client_billing_status, client_billing_reconciliation to billing_sync;

-- ── 4. Direct writes (after the handler's own admin check) ─────────────────
grant update (stripe_product_id) on billing_packages, billing_one_time_items to billing_sync;
create policy "billing runtime maps products" on billing_packages for update to billing_sync using (true) with check (true);
create policy "billing runtime maps products" on billing_one_time_items for update to billing_sync using (true) with check (true);

grant insert (package_id, package_kind, stripe_product_id, stripe_price_id, client_id, notes, is_default, active)
  on billing_package_prices to billing_sync;
create policy "billing runtime maps client prices" on billing_package_prices for insert to billing_sync
  with check (package_kind = 'custom' and client_id is not null and not is_default);

grant select (key, value, updated_at), insert (key, value, updated_at), update (value, updated_at) on app_settings to billing_sync;
create policy "billing runtime portal setting" on app_settings for all to billing_sync
  using (key = 'billing_portal') with check (key = 'billing_portal');

-- ── 5. Functions ────────────────────────────────────────────────────────────
grant execute on function billing_sync_apply(jsonb), billing_link_customer(jsonb), billing_event_begin(jsonb, int),
  billing_event_finish(text, int, text, text), billing_event_fail(text, int, text),
  billing_audit(jsonb), billing_record_checkout(jsonb), billing_record_external_payment(jsonb),
  billing_void_external_payment(jsonb),
  billing_reconcile_begin(jsonb), billing_reconcile_client(jsonb), billing_reconcile_finish(jsonb),
  billing_mirror_fingerprint(uuid, boolean), billing_catalog_fingerprint(boolean), billing_row_digest(jsonb),
  billing_livemode(), billing_monthly_cents(bigint, int, text, int)
  to billing_sync;

-- ── 6. Verify ───────────────────────────────────────────────────────────────
do $$
declare
  v_bad text;
  v_expected text[] := array['app_settings', 'billing_one_time_items', 'billing_package_prices', 'billing_packages',
    'billing_reconciliation_results', 'billing_reconciliation_runs', 'checkout_sessions', 'client_agreement_price',
    'client_billing_reconciliation', 'client_billing_status', 'clients', 'invoice_line_items', 'invoices', 'payments',
    'plans', 'portal_users', 'stripe_customers', 'stripe_events', 'stripe_prices', 'stripe_products', 'stripe_refunds',
    'subscription_items', 'subscriptions', 'team_members'];
  v_functions text[] := array['billing_sync_apply', 'billing_link_customer', 'billing_event_begin', 'billing_event_finish',
    'billing_event_fail', 'billing_audit', 'billing_record_checkout', 'billing_record_external_payment',
    'billing_void_external_payment', 'billing_reconcile_begin', 'billing_reconcile_client', 'billing_reconcile_finish',
    'billing_mirror_fingerprint', 'billing_catalog_fingerprint', 'billing_row_digest', 'billing_livemode',
    'billing_monthly_cents'];
begin
  if exists (select 1 from pg_roles where rolname = 'billing_sync'
             and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication or not rolcanlogin)) then
    raise exception '0064: billing_sync must be a plain login';
  end if;
  if exists (select 1 from pg_auth_members where member = 'billing_sync'::regrole) then
    raise exception '0064: billing_sync must be a member of no role';
  end if;

  -- Exactly the expected relations, and nothing it could delete or truncate.
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
    and (has_table_privilege('billing_sync', c.oid, 'select,insert,update,delete,truncate,references,trigger')
         or has_any_column_privilege('billing_sync', c.oid, 'select,insert,update,references'))
    and c.relname <> all (v_expected);
  if v_bad is not null then raise exception '0064: billing_sync reaches unexpected relations: %', v_bad; end if;
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and has_table_privilege('billing_sync', c.oid, 'delete,truncate,trigger,references');
  if v_bad is not null then raise exception '0064: billing_sync may delete or truncate: %', v_bad; end if;
  -- No direct write to the mirror, the ledger, the agreement or the history.
  select string_agg(t, ', ') into v_bad
  from unnest(array['stripe_products', 'stripe_prices', 'stripe_customers', 'checkout_sessions', 'subscriptions',
    'subscription_items', 'invoices', 'invoice_line_items', 'payments', 'stripe_refunds', 'stripe_events',
    'billing_reconciliation_runs', 'billing_reconciliation_results', 'plans', 'clients', 'team_members',
    'portal_users', 'billing_runtime']) t
  where has_table_privilege('billing_sync', 'public.' || t, 'insert,update')
     or has_any_column_privilege('billing_sync', 'public.' || t, 'insert,update');
  if v_bad is not null then raise exception '0064: billing_sync can write % directly', v_bad; end if;

  -- Functions: nothing beyond anon's reach except the billing allowlist.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('billing_sync', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and p.proname <> all (v_functions);
  if v_bad is not null then raise exception '0064: billing_sync can execute unexpected functions: %', v_bad; end if;
  if has_function_privilege('billing_sync', 'public.get_secret(text)', 'execute')
     or has_function_privilege('billing_sync', 'public.set_secret(text, text)', 'execute')
     or has_schema_privilege('billing_sync', 'vault', 'usage') then
    raise exception '0064: billing_sync can reach Vault';
  end if;

  -- The switch: owner-only, open by default (the TEST setup keeps working).
  if has_table_privilege('service_role', 'public.billing_runtime', 'insert,update,delete,truncate')
     or has_table_privilege('authenticated', 'public.billing_runtime', 'select,insert,update,delete')
     or has_table_privilege('anon', 'public.billing_runtime', 'select,insert,update,delete')
     or has_table_privilege('billing_sync', 'public.billing_runtime', 'select,insert,update,delete') then
    raise exception '0064: billing_runtime is writable or readable beyond its owner and service_role';
  end if;
  if (select count(*) from billing_runtime) <> 1 or not (select edge_functions from billing_runtime) then
    raise exception '0064: billing_runtime must start with the Edge Function path open';
  end if;
end $$;
