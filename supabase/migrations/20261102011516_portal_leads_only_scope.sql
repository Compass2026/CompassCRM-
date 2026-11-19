-- Per-contact scope, independent of CRM feature readiness. Existing users keep full access.
alter table public.portal_users add column access_scope text not null default 'full'
  check (access_scope in ('full', 'leads_only'));
comment on column public.portal_users.access_scope is
  'Team-managed portal scope. leads_only allows inquiries and their communications, not agency reporting or billing.';

-- Invoker rights and the existing own-row RLS policy are sufficient. No user-editable JWT metadata.
create function public.portal_has_reporting_access() returns boolean
language sql stable security invoker set search_path = public, pg_temp as $$
  select exists(select 1 from public.portal_users
    where auth_user_id = auth.uid() and is_active and access_scope = 'full');
$$;
revoke all on function public.portal_has_reporting_access() from public, anon;
grant execute on function public.portal_has_reporting_access() to authenticated, service_role;

-- Keep every reviewed projection, client filter, owner and SELECT-only grant.
-- Add the scope boundary outside the existing query, including aggregate views.
do $$
declare v text; definition text;
begin
  foreach v in array array[
    'portal_progress', 'portal_rankings', 'portal_search_performance',
    'portal_search_queries', 'portal_work_log', 'portal_reports', 'portal_site',
    'portal_growth_measurements', 'portal_growth_rankings', 'portal_growth_search',
    'portal_growth_work', 'portal_backlinks', 'portal_billing_summary',
    'portal_billing_invoices', 'portal_entitlements'
  ] loop
    definition := rtrim(pg_get_viewdef(('public.' || v)::regclass, true), E'; \n');
    if definition not like '%portal_client_id()%' then
      raise exception 'Missing client filter on %', v;
    end if;
    execute format('create or replace view public.%I with (security_invoker=false) as
      select scoped.* from (%s) scoped where (select public.portal_has_reporting_access())', v, definition);
  end loop;
end $$;

-- The callable billing RPCs must enforce the same boundary as their views.
create or replace function portal_billing_summary_row()
returns table (
  client_id uuid,
  collection text,
  plan_name text,
  status text,
  monthly_amount_cents bigint,
  currency text,
  next_billing_at timestamptz,
  ends_at timestamptz,
  can_manage_billing boolean,
  agreed_amount_cents bigint,
  agreed_currency text,
  agreed_interval text,
  agreed_interval_count int
)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    b.client_id,
    pl.collection,
    pk.name,
    case b.billing_state
      when 'active' then 'active'
      when 'trialing' then 'trial'
      when 'past_due' then 'payment_attention'
      when 'unpaid' then 'payment_attention'
      when 'incomplete' then 'payment_pending'
      when 'canceling' then 'scheduled_to_end'
      when 'canceled' then 'ended'
      when 'external' then 'external'
      when 'checkout_pending' then 'awaiting_setup'
      when 'paused' then 'paused'
      when 'collection_paused' then 'paused'
      else 'not_set_up'
    end,
    case when pl.collection = 'stripe' then b.mrr_cents end,
    case when pl.collection = 'stripe' then b.currency end,
    case when pl.collection = 'stripe' then b.next_billing_at end,
    case when pl.collection = 'stripe' and b.billing_state = 'canceling'
         then coalesce(b.cancel_at, b.current_period_end) end,
    (pl.collection = 'stripe' and b.stripe_customer_id is not null),
    case when pl.collection = 'stripe' then pl.agreed_amount_cents end,
    case when pl.collection = 'stripe' then pl.agreed_currency end,
    case when pl.collection = 'stripe' then pl.agreed_billing_interval end,
    case when pl.collection = 'stripe' then pl.agreed_billing_interval_count end
  from client_billing_status b
  join plans pl on pl.client_id = b.client_id
  left join billing_packages pk on pk.id = pl.package_id
  where b.client_id = portal_client_id() and portal_has_reporting_access()
$$;

-- What the agreement includes, from the same entitlement contract Compass
-- uses (package defaults + the client's overrides) — without where each came
-- from, and only what is included.
create or replace function portal_entitlement_rows()
returns table (
  client_id uuid,
  service_key text,
  service_name text,
  kind text,
  quantity int,
  unit text,
  period text,
  sort_order int
)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.client_id, e.service_key, e.service_name, e.kind, e.quantity, e.unit, e.period, e.sort_order
  from client_entitlements_for(portal_client_id()) e
  where portal_client_id() is not null and portal_has_reporting_access() and e.enabled
$$;


-- The dedicated billing runtime derives callers from this table. Restrict the
-- existing SELECT policy, so even a runtime deployed before this migration refuses
-- leads-only callers. Agency billing records and team authorization are unchanged.
alter policy "billing runtime reads" on public.portal_users to billing_sync
  using (access_scope = 'full');
