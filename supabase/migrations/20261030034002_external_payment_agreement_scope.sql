-- External collection uses the already-recorded manual payment terms.
-- Keep the Stripe snapshot shape unchanged; never rewrite issued/signed records.
create or replace function agreement_private.scope(p_client uuid)
returns jsonb language sql stable set search_path=public,pg_temp as $$
  select jsonb_build_object('client_name',c.name,'plan',
    jsonb_build_object('package_id',p.package_id,'collection',p.collection,
      'amount_cents',case when p.collection='external' then p.external_amount_cents else p.agreed_amount_cents end,
      'currency',case when p.collection='external' then p.external_currency else p.agreed_currency end,
      'interval',case when p.collection='external' then p.external_interval else p.agreed_billing_interval end,
      'interval_count',case when p.collection='external' then 1 else p.agreed_billing_interval_count end,
      'start_date',p.start_date,'term_months',p.term_months,'managed_ad_budget_cents',p.managed_ad_budget_cents),
    'services',(select coalesce(jsonb_agg(jsonb_build_object('name',e.service_name,'quantity',e.quantity,'unit',e.unit,'period',e.period) order by e.sort_order),'[]')
      from public.client_entitlements_for(p_client) e where e.enabled))
  from public.clients c join public.plans p on p.client_id=c.id where c.id=p_client
$$;
