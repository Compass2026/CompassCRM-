-- Tests for migration 0062 (billing B5: the entitlement contract, monthly
-- quota accounting, planning within the agreement, agreement history, and
-- billing in the client portal), run by scripts/test-portal-sandbox.sh after
-- the 0061 suite. Own harness schema (be).
--
-- Callers: worker (postgres), person (authenticated + team JWT), portal A / B
-- (authenticated + the fixtures' portal contacts), stranger, anon, fixtures
-- for the Stripe mirror (supabase_admin, exempt from 0059's guard).
--
-- The portal fixtures' clients are used: A (Stripe-collected, linked
-- customer, invoices) and B (an external arrangement). E is a new active
-- client with no agreement.

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set pb     '00000000-0000-4000-a000-000000000012'
\set strngr '00000000-0000-4000-a000-000000000014'
\set ca     '00000000-0000-4000-b000-00000000000a'
\set cb     '00000000-0000-4000-b000-00000000000b'

\o /dev/null
create schema be;
create table be.results (n serial, status text, name text, detail text);
create table be.saved (k text primary key, v jsonb);
grant usage on schema be to anon, authenticated, service_role, authenticator;
grant insert, select on be.results to anon, authenticated, service_role, authenticator;
grant insert, select, update on be.saved to anon, authenticated, service_role, authenticator;
grant usage on sequence be.results_n_seq to anon, authenticated, service_role, authenticator;
create function be.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into be.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function be.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function be.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function be.id(p_k text) returns uuid language sql immutable as $$ select md5('be:' || p_k)::uuid $$;
create function be.ent(p_client uuid, p_key text) returns jsonb language sql stable as $$
  select to_jsonb(e) from client_entitlements_for(p_client) e where e.service_key = p_key
$$;
create function be.use(p_client uuid, p_key text) returns jsonb language sql stable as $$
  select to_jsonb(u) from client_quota_usage(p_client) u where u.service_key = p_key
$$;
create function be.all_ent(p_client uuid) returns jsonb language sql stable as $$
  select jsonb_agg(to_jsonb(e) order by e.service_key) from client_entitlements_for(p_client) e
$$;
create function be.today() returns date language sql stable as $$ select (now() at time zone 'America/Chicago')::date $$;
grant execute on all functions in schema be to anon, authenticated, service_role, authenticator;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Package "Growth": SEO, Website, GBP on, Social explicitly off, 4 blog
-- posts, 4 GBP posts, 2 new pages, social posts explicitly off, nothing said
-- about refreshes or the other features.
insert into billing_packages (id, key, name, kind) values (be.id('pkg'), 'be_growth', 'Growth', 'standard');
insert into package_entitlements (package_id, service_key, service_kind, enabled, quantity) values
  (be.id('pkg'), 'seo', 'feature', true, null),
  (be.id('pkg'), 'website', 'feature', true, null),
  (be.id('pkg'), 'gbp', 'feature', true, null),
  (be.id('pkg'), 'client_portal', 'feature', true, null),
  (be.id('pkg'), 'social', 'feature', false, null),
  (be.id('pkg'), 'blog_posts', 'quota', true, 4),
  (be.id('pkg'), 'gbp_posts', 'quota', true, 4),
  (be.id('pkg'), 'website_pages', 'quota', true, 2),
  (be.id('pkg'), 'social_posts', 'quota', false, null);
delete from plans where client_id in (:'ca', :'cb');
insert into plans (client_id, package_id) values (:'ca', be.id('pkg'));
insert into plans (client_id, package_id, collection, external_method, external_amount_cents, external_currency, external_interval)
  values (:'cb', be.id('pkg'), 'external', 'check', 150000, 'usd', 'month');
insert into clients (id, name, city, state, status) values (be.id('ce'), 'No Agreement Co', 'Rolla', 'MO', 'active');
-- Client A's own terms on top of the package (a teammate writes overrides).
set role authenticated;
select be.as_user('authenticated', :'team');
insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, quantity, reason) values
  (:'ca', 'social', 'feature', true, null, 'Social added at signing'),
  (:'ca', 'social_posts', 'quota', true, 8, 'Eight social posts a month agreed');
reset role;
select set_config('request.jwt.claims', '', false);

-- The Stripe side for client A (test mode): a linked customer, an active
-- subscription on a package price, a paid invoice, an open invoice, a draft
-- and a live-mode invoice. Client B (external) has none.
\c - supabase_admin
insert into stripe_products (stripe_product_id, livemode, name, active, stripe_synced_at) values
  ('prod_Be1', false, 'Growth', true, now());
insert into stripe_prices (stripe_price_id, stripe_product_id, livemode, active, type, currency, unit_amount_cents,
  recurring_interval, recurring_interval_count, recurring_usage_type, stripe_synced_at) values
  ('price_Be1', 'prod_Be1', false, true, 'recurring', 'usd', 150000, 'month', 1, 'licensed', now());
update billing_packages set stripe_product_id = 'prod_Be1' where id = md5('be:pkg')::uuid;
insert into billing_package_prices (package_id, package_kind, stripe_product_id, stripe_price_id, is_default) values (md5('be:pkg')::uuid, 'standard', 'prod_Be1', 'price_Be1', true);
-- (A's test-mode customer cus_A is billing_foundation's; reused.)
insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at)
  select '00000000-0000-4000-b000-00000000000a', 'cus_A', false, 'created', now()
  where not exists (select 1 from stripe_customers where stripe_customer_id = 'cus_A');
insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at) values
  ('00000000-0000-4000-b000-00000000000a', 'cus_BeALive', true, 'created', now());
insert into subscriptions (client_id, stripe_customer_id, stripe_subscription_id, livemode, status, collection_method, currency,
  current_period_start, current_period_end, stripe_created_at, stripe_synced_at) values
  ('00000000-0000-4000-b000-00000000000a', 'cus_A', 'sub_BeA', false, 'active', 'charge_automatically', 'usd',
   now() - interval '10 days', now() + interval '20 days', now(), now());
insert into subscription_items (subscription_id, client_id, stripe_subscription_item_id, stripe_price_id, quantity, stripe_synced_at)
  select id, client_id, 'si_BeA', 'price_Be1', 1, now() from subscriptions where stripe_subscription_id = 'sub_BeA';
insert into invoices (client_id, stripe_customer_id, stripe_invoice_id, livemode, status, collection_method, currency, number,
  subtotal_cents, total_cents, amount_due_cents, amount_paid_cents, amount_remaining_cents, hosted_invoice_url, invoice_pdf,
  stripe_created_at, stripe_synced_at) values
  ('00000000-0000-4000-b000-00000000000a', 'cus_A', 'in_BePaid', false, 'paid', 'charge_automatically', 'usd', 'BE-0001',
   150000, 150000, 150000, 150000, 0, 'https://invoice.stripe.test/paid', 'https://invoice.stripe.test/paid.pdf', now() - interval '31 days', now()),
  ('00000000-0000-4000-b000-00000000000a', 'cus_A', 'in_BeOpen', false, 'open', 'charge_automatically', 'usd', 'BE-0002',
   150000, 150000, 150000, 0, 150000, 'https://invoice.stripe.test/open', 'https://invoice.stripe.test/open.pdf', now() - interval '1 day', now()),
  ('00000000-0000-4000-b000-00000000000a', 'cus_A', 'in_BeDraft', false, 'draft', 'charge_automatically', 'usd', null,
   150000, 150000, 150000, 0, 150000, null, null, now(), now()),
  ('00000000-0000-4000-b000-00000000000a', 'cus_BeALive', 'in_BeLive', true, 'paid', 'charge_automatically', 'usd', 'BE-LIVE-1',
   150000, 150000, 150000, 150000, 0, 'https://invoice.stripe.test/live', 'https://invoice.stripe.test/live.pdf', now(), now());

-- ── E. The entitlement contract ──────────────────────────────────────────────
\c - postgres
set role authenticated;
select be.as_user('authenticated', :'team');
do $$
declare a uuid := '00000000-0000-4000-b000-00000000000a'; b uuid := '00000000-0000-4000-b000-00000000000b'; e jsonb; n int;
begin
  e := be.ent(a, 'seo');
  perform be.ok('E1 a package feature is included, sourced to the package',
    (e ->> 'enabled')::boolean and e ->> 'source' = 'package' and e ->> 'kind' = 'feature'
    and e ->> 'quantity' is null and (e ->> 'package_id')::uuid = be.id('pkg'), e::text);
  e := be.ent(a, 'blog_posts');
  perform be.ok('E2 a package quota is its monthly allocation',
    (e ->> 'enabled')::boolean and (e ->> 'quantity')::int = 4 and e ->> 'source' = 'package'
    and e ->> 'unit' = 'posts' and e ->> 'period' = 'month', e::text);
  e := be.ent(a, 'social');
  perform be.ok('E3 a client override turns on a feature the package leaves off',
    (e ->> 'enabled')::boolean and e ->> 'source' = 'client_override', e::text);
  e := be.ent(a, 'social_posts');
  perform be.ok('E4 a client override sets a quota', (e ->> 'quantity')::int = 8 and e ->> 'source' = 'client_override', e::text);
  e := be.ent(b, 'social');
  perform be.ok('E5 a feature the package disables is not included', not (e ->> 'enabled')::boolean and e ->> 'source' = 'package', e::text);
  e := be.ent(b, 'social_posts');
  perform be.ok('E6 a disabled quota is 0, not unlimited', not (e ->> 'enabled')::boolean and (e ->> 'quantity')::int = 0, e::text);
  e := be.ent(a, 'website_refreshes');
  perform be.ok('E7 a service the package does not mention is not included (source none, 0)',
    not (e ->> 'enabled')::boolean and (e ->> 'quantity')::int = 0 and e ->> 'source' = 'none', e::text);
  select count(*) into n from client_entitlements_for(be.id('ce')) x
    where not x.enabled and x.source = 'none' and x.package_id is null and (x.kind = 'feature' or x.quantity = 0);
  perform be.ok('E8 a client with no agreement: all fourteen services not included, quotas 0', n = 14, n::text);
  select count(*) into n from client_entitlements_for(a);
  perform be.ok('E9 one row per catalog service', n = 14, n::text);
  perform be.ok('E10 the keys are the nine features and five quotas',
    (select array_agg(service_key order by service_key) from client_entitlements_for(a)) =
    array['blog_posts','client_portal','crm','gbp','gbp_posts','hosting','paid_ads','reporting','seo','social','social_posts','website','website_pages','website_refreshes']);
  perform be.ok('E11 the bulk read covers every client in one call',
    (select count(distinct client_id) from client_entitlements_for(null)) = (select count(*) from clients));
  insert into be.saved values ('a_before', be.all_ent(a));
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- Billing state never changes an entitlement: past due, unpaid, canceled,
-- billing_attention, a reconciliation run.
\c - supabase_admin
update subscriptions set status = 'past_due' where stripe_subscription_id = 'sub_BeA';
\c - postgres
do $$ begin
  perform be.ok('E12 past_due: billing attention is raised',
    (select billing_attention from client_billing_status where client_id = '00000000-0000-4000-b000-00000000000a'));
  perform be.ok('E13 past_due: entitlements unchanged',
    be.all_ent('00000000-0000-4000-b000-00000000000a') = (select v from be.saved where k = 'a_before'));
end $$;
\c - supabase_admin
update subscriptions set status = 'unpaid' where stripe_subscription_id = 'sub_BeA';
\c - postgres
do $$ begin
  perform be.ok('E14 unpaid: entitlements unchanged',
    be.all_ent('00000000-0000-4000-b000-00000000000a') = (select v from be.saved where k = 'a_before'));
end $$;
\c - supabase_admin
update subscriptions set status = 'canceled', canceled_at = now() where stripe_subscription_id = 'sub_BeA';
insert into billing_reconciliation_runs (id, trigger, status, livemode, scope_client_id, completed_at, records_changed)
  values (md5('be:run')::uuid, 'admin_client', 'completed', false, '00000000-0000-4000-b000-00000000000a', clock_timestamp(), 3);
insert into billing_reconciliation_results (run_id, client_id, stripe_customer_id, livemode, status, records_changed)
  values (md5('be:run')::uuid, '00000000-0000-4000-b000-00000000000a', 'cus_A', false, 'repaired', 3);
\c - postgres
do $$ begin
  perform be.ok('E15 canceled + a reconciliation that repaired the mirror: entitlements unchanged',
    be.all_ent('00000000-0000-4000-b000-00000000000a') = (select v from be.saved where k = 'a_before'));
end $$;
\c - supabase_admin
update subscriptions set status = 'active', canceled_at = null where stripe_subscription_id = 'sub_BeA';

-- ── F. Fail safe: entitlements unreadable → planning stops and says why ─────
\c - postgres
do $$
declare n int;
begin
  alter view client_entitlements rename to client_entitlements_hidden;
  n := create_weekly_blog_tasks();
  alter view client_entitlements_hidden rename to client_entitlements;
  perform be.ok('F1 no weekly blog task is created when entitlements cannot be read', n = 0, n::text);
  perform be.ok('F2 ...and the reason is logged per client',
    exists (select 1 from automation_entitlement_log where client_id = '00000000-0000-4000-b000-00000000000a'
            and automation = 'weekly_blog_post' and decision = 'skipped' and reason = 'entitlements_unavailable'));
  perform be.ok('F3 ...and nothing was planned',
    not exists (select 1 from tasks where key = 'blog_post' and client_id = '00000000-0000-4000-b000-00000000000a'));
  delete from automation_entitlement_log;
end $$;

-- ── U. Monthly quota accounting and planning within the agreement ────────────
do $$
declare a uuid := '00000000-0000-4000-b000-00000000000a'; u jsonb; n int;
begin
  -- Other suites' content for client A is from other months or not Compass's;
  -- start this month clean for A's blog accounting.
  delete from content_posts where client_id = a and (published_at >= date_trunc('month', be.today()) or due_date >= date_trunc('month', be.today()));
  u := be.use(a, 'blog_posts');
  perform be.ok('U1 nothing planned: remaining is the allocation',
    (u ->> 'allocation')::int = 4 and (u ->> 'used')::int = 0 and (u ->> 'remaining')::int = 4
    and (u ->> 'month')::date = date_trunc('month', be.today())::date, u::text);

  insert into content_posts (client_id, title, status, due_date) values (a, 'Planned post', 'draft', be.today());
  u := be.use(a, 'blog_posts');
  perform be.ok('U2 planned work reduces remaining', (u ->> 'planned')::int = 1 and (u ->> 'remaining')::int = 3, u::text);

  insert into content_posts (client_id, title, status, published_at) values
    (a, 'Done 1', 'published', be.today()), (a, 'Done 2', 'published', be.today()), (a, 'Done 3', 'published', be.today());
  insert into content_posts (client_id, title, status, published_at, origin) values (a, 'Already on the site', 'published', be.today(), 'site_inventory');
  u := be.use(a, 'blog_posts');
  perform be.ok('U3 completed work counts; a site_inventory page is not Compass work',
    (u ->> 'completed')::int = 3 and (u ->> 'used')::int = 4 and (u ->> 'remaining')::int = 0, u::text);

  n := create_weekly_blog_tasks();
  perform be.ok('U4 allocation used: no weekly blog task (no duplicate work)',
    not exists (select 1 from tasks where key = 'blog_post' and client_id = a));
  perform be.ok('U5 ...logged as allocation_used with the numbers',
    exists (select 1 from automation_entitlement_log where client_id = a and reason = 'allocation_used' and allocation = 4 and used = 4));
  perform be.ok('U6 a client with no agreement gets no weekly blog task, logged not_in_agreement',
    not exists (select 1 from tasks where key = 'blog_post' and client_id = be.id('ce'))
    and exists (select 1 from automation_entitlement_log where client_id = be.id('ce') and reason = 'not_in_agreement'));
end $$;

-- Mid-month increase (a teammate raises the allocation): room opens at once.
set role authenticated;
select be.as_user('authenticated', :'team');
insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, quantity, reason)
  values (:'ca', 'blog_posts', 'quota', true, 6, 'Two extra posts from October');
reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare a uuid := '00000000-0000-4000-b000-00000000000a'; u jsonb; n int;
begin
  u := be.use(a, 'blog_posts');
  perform be.ok('U7 mid-month increase: remaining recalculates', (u ->> 'allocation')::int = 6 and (u ->> 'remaining')::int = 2, u::text);
  n := create_weekly_blog_tasks();
  perform be.ok('U8 ...and the weekly blog task is planned',
    (select count(*) from tasks where key = 'blog_post' and client_id = a) = 1);
  perform be.ok('U9 ...logged within_allocation',
    exists (select 1 from automation_entitlement_log where client_id = a and decision = 'created' and reason = 'within_allocation'));
  u := be.use(a, 'blog_posts');
  perform be.ok('U10 the open blog task counts as planned', (u ->> 'planned')::int = 2 and (u ->> 'remaining')::int = 1, u::text);
  n := create_weekly_blog_tasks();
  perform be.ok('U11 a second run the same week plans nothing more',
    (select count(*) from tasks where key = 'blog_post' and client_id = a) = 1);
end $$;

-- Mid-month decrease: nothing already planned or done is removed.
set role authenticated;
select be.as_user('authenticated', :'team');
update client_entitlement_overrides set quantity = 2, reason = 'Reduced to two from this month'
  where client_id = :'ca' and service_key = 'blog_posts';
reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare a uuid := '00000000-0000-4000-b000-00000000000a'; u jsonb;
begin
  u := be.use(a, 'blog_posts');
  perform be.ok('U12 mid-month decrease: remaining 0, the excess reported',
    (u ->> 'allocation')::int = 2 and (u ->> 'remaining')::int = 0 and (u ->> 'over_allocation')::int = 3, u::text);
  perform be.ok('U13 ...and no work is deleted',
    (select count(*) from content_posts where client_id = a and origin = 'compass'
       and (published_at >= date_trunc('month', be.today()) or due_date >= date_trunc('month', be.today()))) = 4
    and (select count(*) from tasks where key = 'blog_post' and client_id = a) = 1);
end $$;

-- A person may always add work beyond the allocation.
set role authenticated;
select be.as_user('authenticated', :'team');
do $$
declare e text; u jsonb;
begin
  e := be.try($q$insert into content_posts (client_id, title, status, due_date)
      values ('00000000-0000-4000-b000-00000000000a', 'Extra post Tom asked for', 'draft', (now() at time zone 'America/Chicago')::date)$q$);
  perform be.ok('U14 a teammate adds a post beyond the allocation', e is null, e);
  e := be.try($q$insert into tasks (client_id, title, owner, status, key)
      values ('00000000-0000-4000-b000-00000000000a', 'Extra blog post', 'TOM', 'open', 'blog_post')$q$);
  perform be.ok('U15 ...and a task for it', e is null, e);
  u := be.use('00000000-0000-4000-b000-00000000000a', 'blog_posts');
  perform be.ok('U16 the extra work is counted, not refused', (u ->> 'used')::int = 7 and (u ->> 'over_allocation')::int = 5, u::text);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- GBP vs social, and website pages / refreshes. Posts are loaded as the
-- cluster superuser with triggers off: these checks are about counting, and
-- 0045's review rules (only a teammate rejects) are tested in their own suite.
insert into be.saved values
  ('gbp0', be.use('00000000-0000-4000-b000-00000000000a', 'gbp_posts')),
  ('soc0', be.use('00000000-0000-4000-b000-00000000000a', 'social_posts'));
\c - supabase_admin
set session_replication_role = replica;
insert into social_posts (client_id, platform, search_intent, copy, created_at) values
  ('00000000-0000-4000-b000-00000000000a', 'google_business', 'commercial', 'GBP draft', now()),
  ('00000000-0000-4000-b000-00000000000a', 'facebook', 'commercial', 'FB draft', now()),
  ('00000000-0000-4000-b000-00000000000a', 'instagram', 'commercial', 'IG draft', now());
insert into social_posts (client_id, platform, search_intent, copy, created_at, review_status, reviewed_by, reviewed_at, review_note)
  select '00000000-0000-4000-b000-00000000000a', 'google_business', 'commercial', 'GBP rejected', now(), 'rejected',
         (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001'), now(), 'Not this one';
set session_replication_role = origin;
\c - postgres
do $$
declare a uuid := '00000000-0000-4000-b000-00000000000a'; u jsonb; g jsonb; g0 jsonb; u0 jsonb;
begin
  -- Earlier suites' posts for A are in the baseline; the checks are deltas.
  g0 := (select v from be.saved where k = 'gbp0');
  u0 := (select v from be.saved where k = 'soc0');
  g := be.use(a, 'gbp_posts');
  u := be.use(a, 'social_posts');
  perform be.ok('U17 GBP posts count against gbp_posts only; rejected ones do not count',
    (g ->> 'planned')::int - (g0 ->> 'planned')::int = 1 and (g ->> 'completed')::int = (g0 ->> 'completed')::int, g::text || ' vs ' || g0::text);
  perform be.ok('U18 other platforms count against social_posts',
    (u ->> 'planned')::int - (u0 ->> 'planned')::int = 2
    and (u ->> 'remaining')::int = greatest((u ->> 'allocation')::int - (u ->> 'used')::int, 0), u::text || ' vs ' || u0::text);

  insert into change_log (client_id, change_type, object_type, status) values
    (a, 'page_added', 'site', 'approved'), (a, 'page_added', 'site', 'proposed'),
    (a, 'page_rewrite', 'site', 'approved'), (a, 'page_added', 'site', 'vetoed');
  u := be.use(a, 'website_pages');
  perform be.ok('U19 new pages: approved completed, proposed planned, vetoed ignored',
    (u ->> 'completed')::int = 1 and (u ->> 'planned')::int = 1 and (u ->> 'remaining')::int = 0, u::text);
  u := be.use(a, 'website_refreshes');
  perform be.ok('U20 a refresh with no allocation is over allocation, not refused',
    (u ->> 'allocation')::int = 0 and (u ->> 'over_allocation')::int = 1, u::text);
end $$;

-- Monthly website updates fire only while pages / refreshes have room.
do $$
declare a uuid := '00000000-0000-4000-b000-00000000000a'; b uuid := '00000000-0000-4000-b000-00000000000b'; p date; n int;
begin
  p := date_trunc('month', be.today())::date;
  insert into monthly_cycles (client_id, period, status) values (a, p, 'open'), (b, p, 'open') on conflict do nothing;
  insert into tasks (client_id, monthly_cycle_id, title, owner, status, key)
    select mc.client_id, mc.id, 'Website updates', 'CLAUDE', 'open', 'site_updates' from monthly_cycles mc
    where mc.period = p and mc.client_id in (a, b)
      and not exists (select 1 from tasks t where t.monthly_cycle_id = mc.id and t.key = 'site_updates');
  delete from automation_entitlement_log;
  n := fire_website_updates(p);
  perform be.ok('W1 pages used up and no refreshes agreed: website updates not fired for A',
    exists (select 1 from automation_entitlement_log where client_id = a and automation = 'website_updates' and reason = 'allocation_used'));
  perform be.ok('W2 B has room (2 pages, none used): fired and logged',
    exists (select 1 from automation_entitlement_log where client_id = b and automation = 'website_updates' and decision = 'created'));
  perform be.ok('W2b exactly one cycle fired (B''s)', n = 1, n::text);
  perform be.ok('W3 the site_updates tasks stay open for a person either way',
    (select count(*) from tasks t join monthly_cycles mc on mc.id = t.monthly_cycle_id
      where mc.period = p and mc.client_id in (a, b) and t.key = 'site_updates' and t.status = 'open') = 2);
end $$;

-- Without the Website feature, pages and refreshes are not automated even
-- with a quantity (a teammate turns the feature off for B).
set role authenticated;
select be.as_user('authenticated', :'team');
insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, quantity, reason)
  values (:'cb', 'website', 'feature', false, null, 'Client runs its own site now');
reset role;
select set_config('request.jwt.claims', '', false);
do $$
declare b uuid := '00000000-0000-4000-b000-00000000000b'; n int;
begin
  delete from automation_entitlement_log;
  n := fire_website_updates(date_trunc('month', be.today())::date);
  perform be.ok('W4 no Website feature: website updates not fired, logged not_in_agreement',
    exists (select 1 from automation_entitlement_log where client_id = b and automation = 'website_updates' and reason = 'not_in_agreement'));
end $$;

-- ── H. Agreement history ─────────────────────────────────────────────────────
do $$
declare a uuid := '00000000-0000-4000-b000-00000000000a';
begin
  perform be.ok('H1 every override change is recorded with the teammate who made it',
    (select count(*) from client_agreement_events where client_id = a and subject = 'override') >= 4
    and not exists (select 1 from client_agreement_events where client_id = a and subject = 'override' and actor_team_member_id is null));
  perform be.ok('H2 the decrease keeps the before and after (quantity and reason)',
    exists (select 1 from client_agreement_events where client_id = a and service_key = 'blog_posts' and action = 'update'
            and (before ->> 'quantity')::int = 6 and (after ->> 'quantity')::int = 2
            and after ->> 'reason' = 'Reduced to two from this month'));
end $$;
set role authenticated;
select be.as_user('authenticated', :'team');
delete from client_entitlement_overrides where client_id = :'ca' and service_key = 'blog_posts';
select be.as_user('authenticated', :'team');
reset role;
insert into be.saved values ('plan_events', to_jsonb((select count(*) from client_agreement_events where subject = 'plan')));
set role authenticated;
select be.as_user('authenticated', :'team');
update plans set term_months = term_months where client_id = :'ca';
do $$
declare e text;
begin
  perform be.ok('H3 a removed override is recorded (with what it was)',
    exists (select 1 from client_agreement_events where service_key = 'blog_posts' and action = 'delete'
            and (before ->> 'quantity')::int = 2 and after is null));
  perform be.ok('H4 a no-op update records nothing',
    (select count(*) from client_agreement_events where subject = 'plan') = (select v::int from be.saved where k = 'plan_events'));
  e := be.try($q$insert into client_agreement_events (client_id, subject, action) values ('00000000-0000-4000-b000-00000000000a', 'plan', 'update')$q$);
  perform be.ok('H5 a teammate cannot write the history', e like '42501%', e);
  e := be.try($q$delete from client_agreement_events$q$);
  perform be.ok('H6 ...or delete it', e like '42501%' or e is null and (select count(*) from client_agreement_events) > 0, e);
  e := be.try($q$insert into automation_entitlement_log (client_id, automation, service_key, decision, reason)
      values ('00000000-0000-4000-b000-00000000000a', 'weekly_blog_post', 'blog_posts', 'created', 'within_allocation')$q$);
  perform be.ok('H7 a teammate cannot write the planning log', e like '42501%', e);
  e := be.try($q$select create_weekly_blog_tasks()$q$);
  perform be.ok('H8 a teammate cannot run the planner directly', e like '42501%', e);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── X. Five Layer systems never read billing ─────────────────────────────────
do $$
declare v_bad text;
begin
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and (p.proname ~ '^(authority_|drafter_|creative_|client_intelligence_|publisher_|post_|brand_asset_|source_asset)'
         or p.proname in ('client_entitlements_for', 'client_quota_usage', 'create_weekly_blog_tasks', 'fire_website_updates',
                          'create_monthly_cycles', 'fire_monthly_reporting', 'fire_foundation_worker'))
    and pg_get_functiondef(p.oid) ~* '(stripe_|\msubscriptions\M|\minvoices\M|\mpayments\M|client_billing_status|billing_attention|billing_reconcil|checkout_sessions)';
  perform be.ok('X1 no Five Layer or planning function reads a Stripe / billing table', v_bad is null, v_bad);
end $$;

-- ── P. Portal billing ────────────────────────────────────────────────────────
set role authenticated;
select be.as_user('authenticated', :'pa');
do $$
declare s record; n int; e text;
begin
  select count(*) into n from portal_billing_summary;
  select * into s from portal_billing_summary;
  perform be.ok('P1 portal A sees one billing summary, its own', n = 1 and s.client_id = '00000000-0000-4000-b000-00000000000a', n::text);
  perform be.ok('P2 ...in client terms: plan name, active, monthly amount, next billing date, can manage',
    s.plan_name = 'Growth' and s.status = 'active' and s.monthly_amount_cents = 150000 and s.currency = 'usd'
    and s.next_billing_at is not null and s.can_manage_billing and s.collection = 'stripe', row_to_json(s)::text);
  select count(*) into n from portal_entitlements where client_id <> '00000000-0000-4000-b000-00000000000a';
  perform be.ok('P3 portal A sees only its own plan services', n = 0 and (select count(*) from portal_entitlements) > 0);
  perform be.ok('P4 ...only what is included (social on by override, refreshes absent)',
    exists (select 1 from portal_entitlements where service_key = 'social')
    and not exists (select 1 from portal_entitlements where service_key = 'website_refreshes')
    and (select quantity from portal_entitlements where service_key = 'social_posts') = 8);
  perform be.ok('P5 portal A sees its test-mode, non-draft invoices only',
    (select array_agg(number order by number) from portal_billing_invoices where number like 'BE-%') = array['BE-0001', 'BE-0002']
    and not exists (select 1 from portal_billing_invoices where number is null));
  perform be.ok('P6 ...with the Stripe-hosted page and PDF',
    (select hosted_invoice_url from portal_billing_invoices where number = 'BE-0002') = 'https://invoice.stripe.test/open'
    and (select invoice_pdf from portal_billing_invoices where number = 'BE-0002') = 'https://invoice.stripe.test/open.pdf');
  select count(*) into n from client_entitlements_for(null);
  perform be.ok('P7 the internal entitlement read returns nothing to a portal contact', n = 0, n::text);
  select count(*) into n from client_quota_usage(null);
  perform be.ok('P8 ...nor the quota accounting', n = 0, n::text);
  select (select count(*) from billing_audit_events) + (select count(*) from billing_reconciliation_runs)
       + (select count(*) from billing_reconciliation_results) + (select count(*) from client_billing_reconciliation)
       + (select count(*) from stripe_events)
       + (select count(*) from client_billing_status) + (select count(*) from client_agreement_events)
       + (select count(*) from automation_entitlement_log) + (select count(*) from client_entitlement_overrides)
       + (select count(*) from plans) + (select count(*) from payments) + (select count(*) from invoices) into n;
  perform be.ok('P9 no internal billing, reconciliation, webhook, audit or agreement data', n = 0, n::text);
  perform be.ok('P9b the sync health row shows a portal contact nothing',
    (select last_run_id is null and failed_events = 0 from billing_sync_health));
  e := be.try($q$insert into client_entitlement_overrides (client_id, service_key, service_kind, enabled, quantity, reason)
      values ('00000000-0000-4000-b000-00000000000a', 'blog_posts', 'quota', true, 99, 'mine')$q$);
  perform be.ok('P10 portal cannot change an entitlement', e like '42501%', e);
  e := be.try($q$update plans set package_id = null where client_id = '00000000-0000-4000-b000-00000000000a'$q$);
  perform be.ok('P11 portal cannot change the agreement (no rows visible to update)',
    e like '42501%' or (e is null and (select package_id from plans where client_id = '00000000-0000-4000-b000-00000000000a') is null
       and (select count(*) from plans) = 0), e);
  e := be.try($q$insert into portal_entitlements (client_id, service_key, service_name, kind, quantity) values ('00000000-0000-4000-b000-00000000000a', 'crm', 'CRM', 'feature', null)$q$);
  perform be.ok('P12 portal cannot write through the entitlement view', e like '42501%' or e like '55000%', e);
  e := be.try($q$update portal_billing_summary set status = 'active'$q$);
  perform be.ok('P13 ...or the billing summary', e like '42501%' or e like '55000%', e);
  e := be.try($q$delete from portal_billing_invoices$q$);
  perform be.ok('P14 ...or the invoices', e like '42501%' or e like '55000%', e);
  perform be.ok('P14b calling the row functions directly gives the contact only what the views show',
    (select count(*) from portal_billing_summary_row()) = 1
    and (select client_id from portal_billing_summary_row()) = '00000000-0000-4000-b000-00000000000a'
    and not exists (select 1 from portal_entitlement_rows() where client_id <> '00000000-0000-4000-b000-00000000000a'));
end $$;
reset role;

-- Plans still says what it said: the portal's attempts changed nothing.
do $$ begin
  perform be.ok('P15 the agreement is unchanged after the portal attempts',
    (select package_id from plans where client_id = '00000000-0000-4000-b000-00000000000a') = be.id('pkg'));
end $$;

-- External arrangement (client B).
set role authenticated;
select be.as_user('authenticated', :'pb');
do $$
declare s record;
begin
  select * into s from portal_billing_summary;
  perform be.ok('P16 portal B sees its own summary: external, no money, no Stripe management',
    s.client_id = '00000000-0000-4000-b000-00000000000b' and s.collection = 'external' and s.status = 'external'
    and s.monthly_amount_cents is null and s.next_billing_at is null and not s.can_manage_billing, row_to_json(s)::text);
  perform be.ok('P17 portal B sees none of A''s invoices', (select count(*) from portal_billing_invoices where client_id <> '00000000-0000-4000-b000-00000000000b' or number like 'BE-%') = 0);
  perform be.ok('P18 portal B sees its own plan services only',
    not exists (select 1 from portal_entitlements where client_id <> '00000000-0000-4000-b000-00000000000b')
    and not exists (select 1 from portal_entitlements where service_key = 'social'));
end $$;
reset role;

-- Live mode: the portal follows the billing mode like the team's views.
\c - supabase_admin
insert into app_settings (key, value) values ('billing', '{"livemode": true}');
\c - postgres
set role authenticated;
select be.as_user('authenticated', :'pa');
do $$ begin
  perform be.ok('P19 in live mode portal A sees the live invoice only (billing mode read for portal contacts)',
    (select array_agg(number) from portal_billing_invoices) = array['BE-LIVE-1']);
end $$;
reset role;
\c - supabase_admin
delete from app_settings where key = 'billing';
\c - postgres

-- Status wording codes.
\c - supabase_admin
update subscriptions set status = 'past_due' where stripe_subscription_id = 'sub_BeA';
\c - postgres
set role authenticated;
select be.as_user('authenticated', :'pa');
do $$ begin
  perform be.ok('P20 past_due is reported as payment_attention (no internal code)',
    (select status from portal_billing_summary) = 'payment_attention');
end $$;
reset role;
\c - supabase_admin
update subscriptions set status = 'active', cancel_at_period_end = true where stripe_subscription_id = 'sub_BeA';
\c - postgres
set role authenticated;
select be.as_user('authenticated', :'pa');
do $$ begin
  perform be.ok('P21 canceling is scheduled_to_end with its end date',
    (select status = 'scheduled_to_end' and ends_at is not null and next_billing_at is null from portal_billing_summary));
end $$;
reset role;
\c - supabase_admin
update subscriptions set cancel_at_period_end = false where stripe_subscription_id = 'sub_BeA';
\c - postgres

-- Stranger, anon, team.
set role authenticated;
select be.as_user('authenticated', :'strngr');
do $$ begin
  perform be.ok('P22 a signed-in stranger sees no portal billing',
    (select count(*) from portal_billing_summary) + (select count(*) from portal_billing_invoices)
    + (select count(*) from portal_entitlements) + (select count(*) from client_entitlements_for(null)) = 0);
end $$;
reset role;
set role anon;
select be.as_user('anon', null);
do $$
declare e text;
begin
  e := be.try($q$select * from portal_billing_summary$q$);
  perform be.ok('P23 anon is refused the portal billing summary', e like '42501%', e);
  e := be.try($q$select * from client_entitlements_for(null)$q$);
  perform be.ok('P24 anon is refused the entitlement read', e like '42501%', e);
  e := be.try($q$select * from client_quota_usage(null)$q$);
  perform be.ok('P25 anon is refused the quota accounting', e like '42501%', e);
  e := be.try($q$select * from portal_billing_summary_row()$q$);
  perform be.ok('P25b anon is refused the portal row functions', e like '42501%', e);
end $$;
reset role;
set role authenticated;
select be.as_user('authenticated', :'team');
do $$ begin
  perform be.ok('P26 a teammate is not a portal contact: the portal views show them nothing',
    (select count(*) from portal_billing_summary) + (select count(*) from portal_entitlements)
    + (select count(*) from portal_billing_summary_row()) + (select count(*) from portal_entitlement_rows()) = 0);
  perform be.ok('P27 team access unchanged: entitlements, usage, billing status, history readable',
    (select count(*) from client_entitlements_for('00000000-0000-4000-b000-00000000000a')) = 14
    and (select count(*) from client_quota_usage('00000000-0000-4000-b000-00000000000a')) = 5
    and (select count(*) from client_billing_status where client_id = '00000000-0000-4000-b000-00000000000a') = 1
    and (select count(*) from client_agreement_events) > 0);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o
\pset footer off
select status, count(*) from be.results group by status order by status;
select n, status, name, detail from be.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from be.results where status = 'fail';
  if f > 0 then raise exception '% billing entitlement / portal check(s) failed', f; end if;
end $$;
