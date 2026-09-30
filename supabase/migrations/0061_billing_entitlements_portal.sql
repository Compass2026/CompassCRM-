-- 0061 — Billing B5: the entitlement contract for Compass's own systems, and
-- billing in the client portal.
--
-- Two separate paths, kept separate:
--
--   Stripe → billing mirror → billing status            (money; B1–B4)
--   Agreement → service entitlements → Five Layers       (scope; here)
--
-- Part 1 gives every internal system one read for "what has Compass agreed to
-- deliver": client_entitlements_for(), and client_quota_allocation() for
-- "how much of this month's allocation is left". Neither reads a Stripe or
-- billing table, and billing state (past due, unpaid, canceled,
-- reconciliation) cannot change either answer.
--
-- Part 2 adds three portal views — the client's billing summary in client
-- language, its invoices, and its plan's services — each filtered by
-- portal_client_id() and granted SELECT only, exactly as 0037's views. No
-- Stripe id, internal code, note, override reason or reconciliation detail is
-- in any of them; the portal still reaches no billing table.

-- ── Part 1: the entitlement contract ─────────────────────────────────────────
-- One read for every Compass system that plans or shows work. Invoker rights
-- over client_entitlements (0057): a teammate sees every client, the service
-- role and the worker's SQL see every client, a portal contact or anyone else
-- sees nothing (client_entitlements' base tables are team-only).
--
--   source   package | client_override | none (no agreement, or the package
--            says nothing about this service)
--   quantity a quota's monthly allocation: 0 when not enabled or not agreed,
--            never NULL and never "unlimited"; NULL for a feature.
--
-- It reads plans.package_id, package_entitlements and
-- client_entitlement_overrides — never a Stripe, subscription, invoice,
-- payment or billing-status table — so a past-due, unpaid or canceled
-- subscription, billing_attention or a reconciliation cannot change it.
create function client_entitlements_for(p_client_id uuid default null)
returns table (
  client_id uuid,
  service_key text,
  service_name text,
  kind text,
  enabled boolean,
  quantity int,
  unit text,
  period text,
  source text,
  package_id uuid,
  sort_order int
)
language sql stable security invoker set search_path = public as $$
  select e.client_id,
         e.service_key,
         e.service_name,
         e.service_kind,
         coalesce(e.enabled, false),
         case when e.service_kind = 'quota'
              then case when coalesce(e.enabled, false) then greatest(coalesce(e.quantity, 0), 0) else 0 end
         end,
         e.unit,
         e.period,
         case e.source when 'override' then 'client_override' else e.source end,
         e.package_id,
         e.sort_order
  from client_entitlements e
  where p_client_id is null or e.client_id = p_client_id
  order by e.client_id, e.sort_order, e.service_key
$$;
revoke all on function client_entitlements_for(uuid) from public, anon;
grant execute on function client_entitlements_for(uuid) to authenticated, service_role;
comment on function client_entitlements_for(uuid) is
  'B5 entitlement contract: what the agreement includes (package defaults + client overrides), per client and service. Never reads billing; a disabled or absent quota is 0.';

-- Monthly quota accounting on the America/Chicago calendar (the team's day,
-- as the Tasks page's "overdue"). For each quota:
--
--   completed  delivered this month
--   planned    in the plan for this month, not delivered yet
--   used       completed + planned
--   remaining  max(0, allocation − used)   — what automation may still add
--   over_allocation  max(0, used − allocation) — kept, never deleted
--
-- The allocation is read live from client_entitlements_for(), so a mid-month
-- increase opens room at once and a decrease closes it; work already planned
-- or done is never removed. What counts, per quota:
--
--   blog_posts         content_posts origin 'compass': published this month
--                      (completed), or not published and due this month
--                      (planned); plus open weekly blog_post tasks created
--                      this month (planned — the post is not recorded yet)
--   gbp_posts          social_posts on google_business, not rejected:
--                      published this month (completed), else scheduled —
--                      or, unscheduled, created — this month (planned)
--   social_posts       the same on every other platform
--   website_pages      change_log page_added this month, not vetoed:
--                      approved (completed), proposed (planned)
--   website_refreshes  change_log page_rewrite, the same
--
-- Invoker rights: a caller sees the clients and work its own RLS shows.
create function client_quota_usage(p_client_id uuid default null, p_month date default null)
returns table (
  client_id uuid,
  service_key text,
  service_name text,
  month date,
  allocation int,
  completed int,
  planned int,
  used int,
  remaining int,
  over_allocation int
)
language sql stable security invoker set search_path = public as $$
  with b as (
    select m as m_start, (m + interval '1 month')::date as m_end
    from (select date_trunc('month', coalesce(p_month, (now() at time zone 'America/Chicago')::date))::date as m) x
  ),
  ent as (
    select e.client_id, e.service_key, e.service_name, e.quantity, e.sort_order
    from client_entitlements_for(p_client_id) e
    where e.kind = 'quota'
  ),
  work as (
    select cp.client_id, 'blog_posts'::text as service_key, cp.status = 'published' as done
    from content_posts cp, b
    where cp.origin = 'compass'
      and (p_client_id is null or cp.client_id = p_client_id)
      and ((cp.status = 'published' and cp.published_at >= b.m_start and cp.published_at < b.m_end)
        or (cp.status <> 'published' and cp.due_date >= b.m_start and cp.due_date < b.m_end))
    union all
    select t.client_id, 'blog_posts', false
    from tasks t, b
    where t.key = 'blog_post' and t.status <> 'done'
      and (p_client_id is null or t.client_id = p_client_id)
      and (t.created_at at time zone 'America/Chicago')::date >= b.m_start
      and (t.created_at at time zone 'America/Chicago')::date < b.m_end
    union all
    select sp.client_id,
           case when sp.platform::text = 'google_business' then 'gbp_posts' else 'social_posts' end,
           sp.publish_status = 'published'
    from social_posts sp, b
    where sp.review_status <> 'rejected'
      and (p_client_id is null or sp.client_id = p_client_id)
      and (case when sp.publish_status = 'published'
                then (sp.published_at at time zone 'America/Chicago')::date
                else (coalesce(sp.scheduled_at, sp.created_at) at time zone 'America/Chicago')::date
           end) >= b.m_start
      and (case when sp.publish_status = 'published'
                then (sp.published_at at time zone 'America/Chicago')::date
                else (coalesce(sp.scheduled_at, sp.created_at) at time zone 'America/Chicago')::date
           end) < b.m_end
    union all
    select cl.client_id,
           case cl.change_type when 'page_added' then 'website_pages' else 'website_refreshes' end,
           cl.status = 'approved'
    from change_log cl, b
    where cl.change_type in ('page_added', 'page_rewrite') and cl.status <> 'vetoed'
      and (p_client_id is null or cl.client_id = p_client_id)
      and (cl.created_at at time zone 'America/Chicago')::date >= b.m_start
      and (cl.created_at at time zone 'America/Chicago')::date < b.m_end
  ),
  counts as (
    select w.client_id, w.service_key,
           count(*) filter (where w.done)::int as completed,
           count(*) filter (where not w.done)::int as planned
    from work w
    group by w.client_id, w.service_key
  )
  select e.client_id, e.service_key, e.service_name, b.m_start,
         e.quantity,
         coalesce(c.completed, 0),
         coalesce(c.planned, 0),
         coalesce(c.completed, 0) + coalesce(c.planned, 0),
         greatest(e.quantity - coalesce(c.completed, 0) - coalesce(c.planned, 0), 0),
         greatest(coalesce(c.completed, 0) + coalesce(c.planned, 0) - e.quantity, 0)
  from ent e
  cross join b
  left join counts c on c.client_id = e.client_id and c.service_key = e.service_key
  order by e.client_id, e.sort_order
$$;
revoke all on function client_quota_usage(uuid, date) from public, anon;
grant execute on function client_quota_usage(uuid, date) to authenticated, service_role;
comment on function client_quota_usage(uuid, date) is
  'B5 monthly quota accounting (America/Chicago month): allocation from the agreement, completed + planned work, remaining for automation, over_allocation kept. Never reads billing.';

-- Automated planning follows the agreement. A skip is recorded with its
-- reason (never silent); a person may still create any work by hand — no
-- constraint anywhere refuses work beyond the allocation.
create table automation_entitlement_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients on delete cascade,
  automation text not null check (automation in ('weekly_blog_post', 'website_updates')),
  service_key text not null,
  decision text not null check (decision in ('created', 'skipped')),
  reason text not null check (reason in ('within_allocation', 'not_in_agreement', 'allocation_used', 'entitlements_unavailable')),
  allocation int,
  used int,
  created_at timestamptz not null default now()
);
create index on automation_entitlement_log (client_id, created_at desc);
alter table automation_entitlement_log enable row level security;
create policy "team read" on automation_entitlement_log for select to authenticated using ((select is_team()));
revoke all on automation_entitlement_log from public, anon, authenticated;
grant select on automation_entitlement_log to authenticated;
comment on table automation_entitlement_log is
  'B5: each automated planning decision made against the agreement (created / skipped with the reason). Written only by the planning functions; team read-only.';

-- The weekly blog post (0035), now within the agreement: one per active
-- client per week while the month's blog_posts allocation has room. No
-- agreement, a disabled quota or a used-up allocation → no task, logged.
create or replace function create_weekly_blog_tasks()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_client record;
  v_usage record;
  v_count int := 0;
begin
  for v_client in
    select c.id, c.name from clients c
    where c.status = 'active'
      and not exists (
        select 1 from tasks t where t.client_id = c.id and t.key = 'blog_post'
          and t.status <> 'done' and t.created_at > now() - interval '6 days')
  loop
    v_usage := null;
    begin
      select u.allocation, u.used, u.remaining into v_usage
      from client_quota_usage(v_client.id) u where u.service_key = 'blog_posts';
    exception when others then
      insert into automation_entitlement_log (client_id, automation, service_key, decision, reason)
      values (v_client.id, 'weekly_blog_post', 'blog_posts', 'skipped', 'entitlements_unavailable');
      continue;
    end;
    if v_usage is null then
      insert into automation_entitlement_log (client_id, automation, service_key, decision, reason)
      values (v_client.id, 'weekly_blog_post', 'blog_posts', 'skipped', 'entitlements_unavailable');
      continue;
    end if;
    if v_usage.allocation = 0 or v_usage.remaining = 0 then
      insert into automation_entitlement_log (client_id, automation, service_key, decision, reason, allocation, used)
      values (v_client.id, 'weekly_blog_post', 'blog_posts', 'skipped',
              case when v_usage.allocation = 0 then 'not_in_agreement' else 'allocation_used' end,
              v_usage.allocation, v_usage.used);
      continue;
    end if;
    insert into tasks (client_id, title, owner, status, playbook_step, autonomy_level, key, due_date)
    values (v_client.id,
            'Blog post this week: one long-tail keyword, one service page, brand voice, sourced facts only',
            'CLAUDE', 'open', 'PB7', 'run_flag', 'blog_post', (current_date + 4));
    insert into automation_entitlement_log (client_id, automation, service_key, decision, reason, allocation, used)
    values (v_client.id, 'weekly_blog_post', 'blog_posts', 'created', 'within_allocation', v_usage.allocation, v_usage.used + 1);
    perform fire_foundation_worker(v_client.id, 'Weekly blog post ' || to_char(current_date, 'YYYY-MM-DD'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function create_weekly_blog_tasks() from public, anon, authenticated;

-- Monthly website updates (0035), within the agreement: the worker is fired
-- for a cycle only while website_pages or website_refreshes has room this
-- month; it reads the exact numbers from client_quota_usage(). The cycle's
-- site_updates task stays open either way, for a person to act on.
create or replace function fire_website_updates(p_period date default date_trunc('month', now())::date)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_cycle record;
  v_alloc int;
  v_used int;
  v_room int;
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
    v_alloc := null;
    begin
      select sum(u.allocation), sum(u.used), sum(u.remaining) into v_alloc, v_used, v_room
      from client_quota_usage(v_cycle.client_id, p_period) u
      where u.service_key in ('website_pages', 'website_refreshes');
    exception when others then
      v_alloc := null;
    end;
    if v_alloc is null then
      insert into automation_entitlement_log (client_id, automation, service_key, decision, reason)
      values (v_cycle.client_id, 'website_updates', 'website_pages+website_refreshes', 'skipped', 'entitlements_unavailable');
      continue;
    end if;
    if v_alloc = 0 or v_room = 0 then
      insert into automation_entitlement_log (client_id, automation, service_key, decision, reason, allocation, used)
      values (v_cycle.client_id, 'website_updates', 'website_pages+website_refreshes', 'skipped',
              case when v_alloc = 0 then 'not_in_agreement' else 'allocation_used' end, v_alloc, v_used);
      continue;
    end if;
    insert into automation_entitlement_log (client_id, automation, service_key, decision, reason, allocation, used)
    values (v_cycle.client_id, 'website_updates', 'website_pages+website_refreshes', 'created', 'within_allocation', v_alloc, v_used);
    perform fire_foundation_worker(v_cycle.client_id, 'Website updates ' || to_char(p_period, 'YYYY-MM'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke execute on function fire_website_updates(date) from public, anon, authenticated;

-- Agreement history. plans and client_entitlement_overrides keep only their
-- latest state (reason, updated_by, updated_at); this keeps every change,
-- including a removed override, append-only and written only by trigger.
-- It is history, not versioning: entitlements are always read as of now.
create table client_agreement_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients on delete cascade,
  subject text not null check (subject in ('plan', 'override')),
  service_key text,
  action text not null check (action in ('insert', 'update', 'delete')),
  before jsonb,
  after jsonb,
  actor_team_member_id uuid references team_members on delete set null,
  created_at timestamptz not null default clock_timestamp()
);
create index on client_agreement_events (client_id, created_at desc);
alter table client_agreement_events enable row level security;
create policy "team read" on client_agreement_events for select to authenticated using ((select is_team()));
revoke all on client_agreement_events from public, anon, authenticated;
grant select on client_agreement_events to authenticated;

create function record_client_agreement_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_before jsonb;
  v_after jsonb;
begin
  -- A client being deleted takes its history with it (cascade); nothing to record.
  if not exists (select 1 from clients where id = (v_row ->> 'client_id')::uuid) then
    return null;
  end if;
  v_before := case when tg_op <> 'INSERT' then to_jsonb(old) - 'updated_at' - 'updated_by' end;
  v_after := case when tg_op <> 'DELETE' then to_jsonb(new) - 'updated_at' - 'updated_by' end;
  if tg_op = 'UPDATE' and v_before = v_after then
    return null;
  end if;
  insert into client_agreement_events (client_id, subject, service_key, action, before, after, actor_team_member_id)
  values ((v_row ->> 'client_id')::uuid,
          case tg_table_name when 'plans' then 'plan' else 'override' end,
          v_row ->> 'service_key',
          lower(tg_op), v_before, v_after,
          (select id from team_members where auth_user_id = auth.uid()));
  return null;
end $$;
revoke all on function record_client_agreement_event() from public, anon, authenticated;

create trigger plans_agreement_history after insert or update or delete on plans
  for each row execute function record_client_agreement_event();
create trigger client_entitlement_overrides_history after insert or update or delete on client_entitlement_overrides
  for each row execute function record_client_agreement_event();

-- ── Part 2: portal billing views ─────────────────────────────────────────────
-- billing_livemode() (0057) ran as its caller, and only the team can read
-- app_settings — so inside a portal view it answered "test mode" for a
-- portal contact even with live mode on. It returns one boolean; run it as
-- its owner so every caller sees the same mode.
alter function billing_livemode() security definer;

-- client_billing_status and client_entitlements are security-invoker views:
-- even inside an owner-run portal view they are read with the caller's
-- rights, and a portal contact can read no billing table. So each is read
-- through a security-definer row function that takes no argument, answers
-- only for portal_client_id() and returns only the client-safe columns —
-- calling it directly (RPC) gives a contact exactly what the view does.

-- The client's billing state reduced to client-safe codes (the app words
-- them). Money only for Stripe-collected agreements; an external arrangement
-- says so and nothing more.
create function portal_billing_summary_row()
returns table (
  client_id uuid,
  collection text,
  plan_name text,
  status text,
  monthly_amount_cents bigint,
  currency text,
  next_billing_at timestamptz,
  ends_at timestamptz,
  can_manage_billing boolean
)
language sql stable security definer set search_path = public as $$
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
    (pl.collection = 'stripe' and b.stripe_customer_id is not null)
  from client_billing_status b
  join plans pl on pl.client_id = b.client_id
  left join billing_packages pk on pk.id = pl.package_id
  where b.client_id = portal_client_id()
$$;

-- What the agreement includes, from the same entitlement contract Compass
-- uses (package defaults + the client's overrides) — without where each came
-- from, and only what is included.
create function portal_entitlement_rows()
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
language sql stable security definer set search_path = public as $$
  select e.client_id, e.service_key, e.service_name, e.kind, e.quantity, e.unit, e.period, e.sort_order
  from client_entitlements_for(portal_client_id()) e
  where portal_client_id() is not null and e.enabled
$$;

revoke all on function portal_billing_summary_row() from public, anon;
revoke all on function portal_entitlement_rows() from public, anon;
grant execute on function portal_billing_summary_row() to authenticated;
grant execute on function portal_entitlement_rows() to authenticated;

create view portal_billing_summary as
select s.* from portal_billing_summary_row() s
where s.client_id = (select portal_client_id());

-- Invoices a customer is meant to see (never drafts), in the current mode,
-- with the Stripe-hosted page and PDF Stripe gives the customer.
create view portal_billing_invoices as
select
  i.client_id,
  i.number,
  i.stripe_created_at as invoice_date,
  i.status,
  i.currency,
  i.total_cents,
  i.amount_paid_cents,
  i.amount_remaining_cents,
  i.due_date,
  i.period_start,
  i.period_end,
  i.hosted_invoice_url,
  i.invoice_pdf
from invoices i
where i.client_id = (select portal_client_id())
  and i.livemode = billing_livemode()
  and i.status in ('open', 'paid', 'uncollectible', 'void');

create view portal_entitlements as
select e.* from portal_entitlement_rows() e
where e.client_id = (select portal_client_id());

do $$
declare v text;
begin
  foreach v in array array['portal_billing_summary', 'portal_billing_invoices', 'portal_entitlements'] loop
    execute format('alter view %I set (security_invoker = false)', v);
    execute format('revoke all on %I from public, anon, authenticated', v);
    execute format('grant select on %I to authenticated', v);
  end loop;
end $$;

-- ── Verify ───────────────────────────────────────────────────────────────────
do $$
declare v_bad text;
begin
  -- 0037's rules for every portal view: filtered by portal_client_id(), and
  -- nothing but authenticated SELECT.
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'portal\_%'
    and pg_get_viewdef(c.oid) not like '%portal_client_id()%';
  if v_bad is not null then raise exception '0061: portal views missing the client filter: %', v_bad; end if;

  select string_agg(distinct g.table_name || ' ' || g.privilege_type, ', ') into v_bad
  from information_schema.role_table_grants g
  join pg_class c on c.relname = g.table_name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = g.table_schema
  where g.table_schema = 'public' and g.table_name like 'portal\_%'
    and ((g.grantee = 'authenticated' and c.relkind = 'v' and g.privilege_type <> 'SELECT')
      or g.grantee = 'anon' or g.grantee = 'PUBLIC');
  if v_bad is not null then raise exception '0061: unexpected portal grants: %', v_bad; end if;

  -- The portal billing views carry no Stripe id or internal field.
  select string_agg(table_name || '.' || column_name, ', ') into v_bad
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('portal_billing_summary', 'portal_billing_invoices', 'portal_entitlements')
    and (column_name like 'stripe\_%' or column_name in ('package_id', 'source', 'override_reason', 'attention_reasons',
         'billing_attention', 'livemode', 'notes', 'reference', 'external_method', 'recorded_by'));
  if v_bad is not null then raise exception '0061: a portal billing view exposes an internal column: %', v_bad; end if;

  -- The entitlement contract and the planning that follows it never read
  -- billing (0057's client_entitlements reads only plans.package_id,
  -- package_entitlements and the overrides).
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('client_entitlements_for', 'client_quota_usage', 'create_weekly_blog_tasks', 'fire_website_updates',
                      'client_intelligence_input', 'authority_input')
    and pg_get_functiondef(p.oid) ~* '(stripe_|subscriptions|invoices|payments|client_billing_status|billing_attention|billing_reconcil|checkout_sessions)';
  if v_bad is not null then raise exception '0061: a planning function reads billing: %', v_bad; end if;
  if pg_get_viewdef('client_entitlements'::regclass) ~* '(stripe_|subscriptions|invoices|payments|billing_status|billing_attention)' then
    raise exception '0061: client_entitlements reads billing';
  end if;

  if has_function_privilege('anon', 'client_entitlements_for(uuid)', 'execute')
     or has_function_privilege('anon', 'client_quota_usage(uuid, date)', 'execute')
     or has_function_privilege('authenticated', 'create_weekly_blog_tasks()', 'execute')
     or has_function_privilege('authenticated', 'fire_website_updates(date)', 'execute')
     or has_function_privilege('authenticated', 'record_client_agreement_event()', 'execute') then
    raise exception '0061: unexpected function grants';
  end if;
end $$;
