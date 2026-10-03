-- Billing rollback: undo migrations 0058 – 0062 and restore the schema exactly
-- as 0001 – 0057 left it (the pre-billing production state). Tested by
-- scripts/test-billing-rollback.sh: replay → apply billing → seed → back up →
-- this script → the schema, cron and billing settings must equal the baseline.
--
-- NOT a migration: never put it in supabase/migrations. Run it only per
-- docs/billing-cutover.md § Rollback, after:
--   1. the Stripe webhook endpoint is disabled in the Stripe dashboard and
--      STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / BILLING_RECONCILE_SECRET
--      are removed from Vault (the functions then answer 503);
--   2. supabase/rollback/billing_0058_0062_backup.sql has been run and its
--      output saved (agreements, overrides, catalog, history and external
--      payments are dropped here and exist nowhere else);
--   3. the app on main is back on the pre-billing commit (the billing app
--      reads tables this script drops; the old app reads the ones it restores).
-- Run as postgres in ONE transaction (`psql --single-transaction` or the
-- Supabase MCP's execute_sql wraps it). It refuses to run twice.

do $$
begin
  if to_regclass('public.billing_packages') is null then
    raise exception 'billing rollback: 0058 is not applied (nothing to roll back)';
  end if;
end $$;

-- ── Schedules and settings ───────────────────────────────────────────────────
select cron.unschedule(jobname) from cron.job where jobname in ('billing-reconcile-daily');
delete from app_settings where key like 'billing%';

-- ── 0062: portal billing, entitlement contract, planners, history ───────────
drop view if exists portal_billing_summary, portal_billing_invoices, portal_entitlements;
drop function if exists portal_billing_summary_row(), portal_entitlement_rows();
drop trigger if exists plans_agreement_history on plans;
drop trigger if exists client_entitlement_overrides_history on client_entitlement_overrides;
drop function if exists record_client_agreement_event();
drop table if exists client_agreement_events, automation_entitlement_log;
drop function if exists client_quota_usage(uuid, date), client_entitlements_for(uuid);
alter function portal_client_id() set search_path = public;
alter function is_team() set search_path = public;

-- The planners exactly as 0035 defines them (no agreement gate).
create or replace function fire_website_updates(p_period date default date_trunc('month', now())::date)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_cycle record;
  v_count int := 0;
begin
  for v_cycle in
    select mc.client_id
    from monthly_cycles mc
    join clients c on c.id = mc.client_id
    where mc.period = p_period and mc.status = 'open'
      and c.status = 'active'
      and exists (select 1 from tasks t where t.monthly_cycle_id = mc.id and t.key = 'site_updates' and t.status <> 'done')
  loop
    perform fire_foundation_worker(v_cycle.client_id, 'Website updates ' || to_char(p_period, 'YYYY-MM'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function fire_website_updates(date) from public, anon, authenticated;
grant execute on function fire_website_updates(date) to service_role;

create or replace function create_weekly_blog_tasks()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_client record;
  v_count int := 0;
begin
  for v_client in
    select c.id, c.name from clients c
    where c.status = 'active'
      and not exists (
        select 1 from tasks t where t.client_id = c.id and t.key = 'blog_post'
          and t.status <> 'done' and t.created_at > now() - interval '6 days')
  loop
    insert into tasks (client_id, title, owner, status, playbook_step, autonomy_level, key, due_date)
    values (v_client.id,
            'Blog post this week: one long-tail keyword, one service page, brand voice, sourced facts only',
            'CLAUDE', 'open', 'PB7', 'run_flag', 'blog_post', (current_date + 4));
    perform fire_foundation_worker(v_client.id, 'Weekly blog post ' || to_char(current_date, 'YYYY-MM-DD'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function create_weekly_blog_tasks() from public, anon, authenticated;
grant execute on function create_weekly_blog_tasks() to service_role;

-- ── 0061: reconciliation ────────────────────────────────────────────────────
drop view if exists client_billing_reconciliation, billing_sync_health;
drop function if exists billing_fire_reconciliation(), billing_reconcile_begin(jsonb), billing_reconcile_client(jsonb),
  billing_reconcile_finish(jsonb), billing_row_digest(jsonb), billing_mirror_fingerprint(uuid, boolean),
  billing_catalog_fingerprint(boolean);
drop table if exists billing_reconciliation_results, billing_reconciliation_runs;
drop function if exists billing_reconciliation_immutable();

-- ── 0060: billing operations ────────────────────────────────────────────────
drop function if exists billing_record_checkout(jsonb), billing_record_external_payment(jsonb),
  billing_void_external_payment(jsonb), billing_audit(jsonb);
drop table if exists billing_audit_events;
drop function if exists billing_audit_append_only(), billing_require_service();

-- ── 0058 read models, then 0059's sync functions ────────────────────────────
drop view if exists client_billing_status, client_agreement_price, client_entitlements;
drop function if exists billing_sync_apply(jsonb), billing_link_customer(jsonb), billing_event_begin(jsonb, int),
  billing_event_finish(text, int, text, text), billing_event_fail(text, int, text), billing_owner(text, boolean),
  billing_upsert(text, text[], jsonb), billing_update(text, text, jsonb);

-- ── 0058: the mirror, the catalog, the agreement ────────────────────────────
drop table plans;   -- references billing_packages; recreated below in its 0001 shape
drop function if exists plans_agreement_price_guard();
drop table if exists stripe_refunds, invoice_line_items, payments, invoices, subscription_items, subscriptions,
  checkout_sessions, stripe_customers, stripe_events, client_entitlement_overrides, package_entitlements,
  billing_package_prices, billing_one_time_items, billing_packages, service_catalog, stripe_prices, stripe_products;
drop function if exists billing_mirror_guard(), billing_sync_active(), billing_caller_is_service(),
  billing_caller_is_superuser(), billing_external_payment_immutable();
drop policy if exists "billing settings: admin writes" on app_settings;
drop policy if exists "billing settings: admin updates" on app_settings;
drop policy if exists "billing settings: admin deletes" on app_settings;
drop trigger if exists team_members_admin_guard on team_members;
drop function if exists team_members_admin_guard(), is_team_admin();
drop function if exists billing_livemode(), billing_monthly_cents(bigint, int, text, int), billing_stamp_updated(),
  billing_owner_immutable(), billing_product_single_owner();

-- ── Restore 0001 / 0008 / 0036 exactly ───────────────────────────────────────
create type paid_status_type as enum ('paid', 'processing', 'open', 'past_due');
create type payment_method as enum ('card', 'stripe_ach', 'external_ach', 'check');
create type payment_method_type as enum ('card', 'us_bank_account', 'external_ach');
create type payment_source as enum ('stripe', 'manual');

create table plans (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  package_name text,
  monthly_fee numeric(10,2),
  term_months integer,
  start_date date,
  renewal_date date,
  gbp_posts_per_month integer,
  blog_posts_per_month integer,
  social_posts_per_month integer,
  ad_budget_managed numeric(10,2),
  notes text
);
create table stripe_customers (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  stripe_customer_id text not null,
  payment_method_type payment_method_type,
  last4 text,
  created_at timestamptz default now() not null
);
create table subscriptions (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  stripe_subscription_id text,
  stripe_price_id text,
  amount numeric(10,2),
  "interval" text default 'month' not null,
  status text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  paid_status paid_status_type default 'open' not null,
  cancel_at timestamptz,
  created_at timestamptz default now() not null,
  latest_invoice_url text
);
create table payments (
  id uuid default gen_random_uuid() not null,
  client_id uuid not null,
  subscription_id uuid,
  source payment_source default 'stripe' not null,
  stripe_invoice_id text,
  stripe_payment_intent_id text,
  amount numeric(10,2) not null,
  method payment_method,
  period_start date,
  period_end date,
  reference text,
  paid_at timestamptz,
  recorded_by text,
  notes text
);
create table stripe_events (
  id text not null,
  type text not null,
  received_at timestamptz default now() not null
);
alter table only plans add constraint plans_pkey primary key (id);
alter table only plans add constraint plans_client_id_key unique (client_id);
alter table only stripe_customers add constraint stripe_customers_pkey primary key (id);
alter table only stripe_customers add constraint stripe_customers_client_id_key unique (client_id);
alter table only stripe_customers add constraint stripe_customers_stripe_customer_id_key unique (stripe_customer_id);
alter table only subscriptions add constraint subscriptions_pkey primary key (id);
alter table only subscriptions add constraint subscriptions_stripe_subscription_id_key unique (stripe_subscription_id);
alter table only payments add constraint payments_pkey primary key (id);
alter table only payments add constraint payments_stripe_invoice_id_key unique (stripe_invoice_id);
alter table only stripe_events add constraint stripe_events_pkey primary key (id);
create index payments_client_id_idx on payments using btree (client_id);
create index subscriptions_client_id_idx on subscriptions using btree (client_id);
alter table only plans add constraint plans_client_id_fkey foreign key (client_id) references clients(id) on delete cascade;
alter table only stripe_customers add constraint stripe_customers_client_id_fkey foreign key (client_id) references clients(id) on delete cascade;
alter table only subscriptions add constraint subscriptions_client_id_fkey foreign key (client_id) references clients(id) on delete cascade;
alter table only payments add constraint payments_client_id_fkey foreign key (client_id) references clients(id) on delete cascade;
alter table only payments add constraint payments_subscription_id_fkey foreign key (subscription_id) references subscriptions(id) on delete set null;
alter table plans enable row level security;
alter table stripe_customers enable row level security;
alter table subscriptions enable row level security;
alter table payments enable row level security;
alter table stripe_events enable row level security;
create policy "team full access" on plans to authenticated using ((select is_team())) with check ((select is_team()));
create policy "team full access" on stripe_customers to authenticated using ((select is_team())) with check ((select is_team()));
create policy "team full access" on subscriptions to authenticated using ((select is_team())) with check ((select is_team()));
create policy "team full access" on payments to authenticated using ((select is_team())) with check ((select is_team()));
create policy "team read stripe events" on stripe_events for select to authenticated using ((select is_team()));

create function mark_past_due_subscriptions() returns void
language sql security definer
set search_path = public
as $$
  update subscriptions
     set paid_status = 'past_due'
   where paid_status = 'open'
     and current_period_end is not null
     and current_period_end < now() - interval '3 days'
     and coalesce(status, 'active') not in ('canceled', 'paused');
$$;
revoke execute on function mark_past_due_subscriptions() from public, anon, authenticated;
select cron.schedule('billing-daily-past-due', '30 6 * * *', $$select public.mark_past_due_subscriptions()$$);

-- ── Verify ───────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.billing_packages') is not null or to_regclass('public.client_billing_status') is not null
     or to_regprocedure('public.client_entitlements_for(uuid)') is not null then
    raise exception 'billing rollback: billing objects remain';
  end if;
  if not exists (select 1 from information_schema.columns where table_name = 'plans' and column_name = 'monthly_fee') then
    raise exception 'billing rollback: plans not restored';
  end if;
end $$;
