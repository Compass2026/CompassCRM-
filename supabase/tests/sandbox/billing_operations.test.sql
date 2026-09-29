-- Tests for migration 0059 (billing B3 operations: Checkout records, external
-- payments with void corrections, the append-only billing audit trail), run by
-- scripts/test-portal-sandbox.sh after the 0058 suite. Own harness schema (bo).
--
-- Callers: worker (postgres), service (authenticator + service_role: the
-- stripe-billing function), person (authenticated + team JWT), portal, anon,
-- fixtures (supabase_admin).

\set team '00000000-0000-4000-a000-000000000001'
\set pa   '00000000-0000-4000-a000-000000000011'

\o /dev/null
create schema bo;
create table bo.results (n serial, status text, name text, detail text);
create table bo.saved (k text primary key, v text);
grant usage on schema bo to anon, authenticated, service_role, authenticator;
grant insert, select on bo.results to anon, authenticated, service_role, authenticator;
grant insert, select, update on bo.saved to anon, authenticated, service_role, authenticator;
grant usage on sequence bo.results_n_seq to anon, authenticated, service_role, authenticator;
create function bo.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into bo.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function bo.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function bo.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function bo.id(p_k text) returns uuid language sql immutable as $$ select md5('bo:' || p_k)::uuid $$;
grant execute on all functions in schema bo to anon, authenticated, service_role, authenticator;

insert into clients (id, name, city, state, status) values
  (bo.id('c1'), 'Ops Roofing', 'Wentzville', 'MO', 'active'),
  (bo.id('c2'), 'Ops Plumbing', 'Columbia', 'MO', 'active');
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-0000000000e2', 'ops-member@compassmarketing.ai', now());
insert into team_members (auth_user_id, name, email, role) values
  ('00000000-0000-4000-a000-0000000000e2', 'Ops Member', 'ops-member@compassmarketing.ai', 'member');
insert into bo.saved values
  ('admin', (select id::text from team_members where auth_user_id = :'team')),
  ('member', (select id::text from team_members where auth_user_id = '00000000-0000-4000-a000-0000000000e2'));

\c - supabase_admin
insert into stripe_customers (client_id, stripe_customer_id, livemode, link_source, stripe_synced_at) values
  (bo.id('c1'), 'cus_Ops1', false, 'created', now()),
  (bo.id('c2'), 'cus_Ops2', false, 'created', now());

-- ── W. The worker's SQL, a teammate, a portal contact and anon are refused ──
\c - postgres
do $$
declare e text;
begin
  e := bo.try(format($q$select billing_record_external_payment(%L)$q$, jsonb_build_object('client_id', bo.id('c1'))));
  perform bo.ok('W1 the worker cannot record an external payment', e like '42501%', e);
  e := bo.try($q$select billing_audit('{"action": "link_customer", "actor_kind": "team"}')$q$);
  perform bo.ok('W2 the worker cannot write the audit trail through the function', e like '42501%', e);
  e := bo.try($q$insert into billing_audit_events (action, actor_kind) values ('link_customer', 'team')$q$);
  perform bo.ok('W3 ...or directly', e like '42501%', e);
  e := bo.try(format($q$insert into payments (client_id, source, status, external_method, amount_cents, currency, paid_at)
      values (%L, 'external', 'succeeded', 'check', 1, 'usd', now())$q$, bo.id('c1')));
  perform bo.ok('W4 the worker cannot insert a payment directly', e like '42501%', e);
end $$;

\c - authenticator
set role authenticated;
select bo.as_user('authenticated', :'team');
do $$
declare e text;
begin
  e := bo.try(format($q$select billing_record_external_payment(%L)$q$, jsonb_build_object('client_id', bo.id('c1'))));
  perform bo.ok('P1 even an admin''s own session cannot call the function directly (only the stripe-billing function)', e like '42501%', e);
  e := bo.try($q$select billing_record_checkout('{}')$q$);
  perform bo.ok('P2 ...nor record a Checkout session', e like '42501%', e);
  e := bo.try($q$insert into billing_audit_events (action, actor_kind) values ('link_customer', 'team')$q$);
  perform bo.ok('P3 a teammate cannot write the audit trail', e like '42501%', e);
end $$;
reset role;
set role authenticated;
select bo.as_user('authenticated', :'pa');
do $$
declare e text;
begin
  e := bo.try($q$select billing_void_external_payment('{}')$q$);
  perform bo.ok('P4 a portal contact cannot call the billing functions', e like '42501%', e);
end $$;
reset role;
set role anon;
select bo.as_user('anon', null);
do $$
declare e text;
begin
  e := bo.try($q$select billing_audit('{}')$q$);
  perform bo.ok('P5 anon cannot call the billing functions', e like '42501%', e);
end $$;
reset role;

-- ── S. The stripe-billing function's session ────────────────────────────────
set role service_role;
select bo.as_user('service_role', null);
do $$
declare e text; r jsonb; admin uuid := (select v::uuid from bo.saved where k = 'admin');
  member uuid := (select v::uuid from bo.saved where k = 'member'); req uuid := gen_random_uuid();
begin
  -- External payments.
  r := billing_record_external_payment(jsonb_build_object('client_id', bo.id('c1'), 'amount_cents', 120000, 'currency', 'USD',
    'paid_at', '2026-09-10', 'external_method', 'check', 'reference', 'Check 1042', 'notes', 'September retainer by check',
    'recorded_by', admin, 'client_request_id', req));
  perform bo.ok('M1 an admin records an external payment (check), marked external, succeeded, lower-case currency',
    (r ->> 'created')::boolean and (select source || ':' || status || ':' || currency || ':' || external_method
      from payments where id = (r ->> 'id')::uuid) = 'external:succeeded:usd:check', r::text);
  insert into bo.saved values ('payment', r ->> 'id');
  r := billing_record_external_payment(jsonb_build_object('client_id', bo.id('c1'), 'amount_cents', 120000, 'currency', 'usd',
    'paid_at', '2026-09-10', 'external_method', 'check', 'reference', 'Check 1042', 'notes', 'September retainer by check',
    'recorded_by', admin, 'client_request_id', req));
  perform bo.ok('M2 the same request twice records one payment (idempotent)',
    not (r ->> 'created')::boolean and (select count(*) from payments where client_request_id = req) = 1, r::text);
  e := bo.try(format($q$select billing_record_external_payment(%L)$q$, jsonb_build_object('client_id', bo.id('c1'),
    'amount_cents', 5000, 'currency', 'usd', 'paid_at', '2026-09-11', 'external_method', 'wire', 'notes', 'x',
    'recorded_by', member, 'client_request_id', gen_random_uuid())));
  perform bo.ok('M3 a member cannot be the recorder (the database re-checks admin)', e like '42501%', e);
  e := bo.try(format($q$select billing_record_external_payment(%L)$q$, jsonb_build_object('client_id', bo.id('c1'),
    'amount_cents', 5000, 'currency', 'usd', 'paid_at', '2026-09-11', 'external_method', 'wire', 'notes', '  ',
    'recorded_by', admin, 'client_request_id', gen_random_uuid())));
  perform bo.ok('M4 a note is required', e like '23514%', e);
  e := bo.try(format($q$select billing_record_external_payment(%L)$q$, jsonb_build_object('client_id', bo.id('c1'),
    'amount_cents', 5000, 'currency', 'usd', 'paid_at', '2026-09-11', 'external_method', 'cash', 'notes', 'x',
    'recorded_by', admin, 'client_request_id', gen_random_uuid())));
  perform bo.ok('M5 the method is check, wire, manually received ACH or other', e like '23514%', e);
  e := bo.try(format($q$select billing_record_external_payment(%L)$q$, jsonb_build_object('client_id', bo.id('c1'),
    'amount_cents', -1, 'currency', 'usd', 'paid_at', '2026-09-11', 'external_method', 'wire', 'notes', 'x',
    'recorded_by', admin, 'client_request_id', gen_random_uuid())));
  perform bo.ok('M6 an amount is never negative', e like '23514%', e);
  perform bo.ok('M7 recording writes an audit event with the recorder and terms',
    (select count(*) from billing_audit_events where action = 'record_external_payment' and client_id = bo.id('c1')
       and actor_team_member_id = admin and (detail ->> 'amount_cents')::bigint = 120000) = 1);

  -- Void corrections.
  e := bo.try(format($q$select billing_void_external_payment(%L)$q$, jsonb_build_object('client_id', bo.id('c2'),
    'payment_id', (select v from bo.saved where k = 'payment'), 'voided_by', admin, 'reason', 'wrong client')));
  perform bo.ok('V1 a payment is voided only for its own client', e like 'P0002%', e);
  e := bo.try(format($q$select billing_void_external_payment(%L)$q$, jsonb_build_object('client_id', bo.id('c1'),
    'payment_id', (select v from bo.saved where k = 'payment'), 'voided_by', admin, 'reason', ' ')));
  perform bo.ok('V2 voiding needs a reason', e like '23514%', e);
  e := bo.try(format($q$select billing_void_external_payment(%L)$q$, jsonb_build_object('client_id', bo.id('c1'),
    'payment_id', (select v from bo.saved where k = 'payment'), 'voided_by', member, 'reason', 'typo')));
  perform bo.ok('V3 a member cannot void', e like '42501%', e);
  r := billing_void_external_payment(jsonb_build_object('client_id', bo.id('c1'),
    'payment_id', (select v from bo.saved where k = 'payment'), 'voided_by', admin, 'reason', 'Recorded against the wrong month'));
  perform bo.ok('V4 an admin voids it: the record stays, voided with who and why, and the void is audited',
    (select voided_at is not null and voided_by = admin and void_reason = 'Recorded against the wrong month' and amount_cents = 120000
       from payments where id = (select v::uuid from bo.saved where k = 'payment'))
    and exists (select 1 from billing_audit_events where action = 'void_external_payment'), r::text);
  e := bo.try(format($q$select billing_void_external_payment(%L)$q$, jsonb_build_object('client_id', bo.id('c1'),
    'payment_id', (select v from bo.saved where k = 'payment'), 'voided_by', admin, 'reason', 'again')));
  perform bo.ok('V5 a payment is voided once', e like 'P0002%', e);

  -- Checkout records.
  r := billing_record_checkout(jsonb_build_object('client_id', bo.id('c1'), 'stripe_customer_id', 'cus_Ops1',
    'stripe_checkout_session_id', 'cs_test_Ops1', 'livemode', false, 'mode', 'subscription', 'status', 'open',
    'url', 'https://checkout.stripe.com/c/pay/cs_test_Ops1', 'expires_at', now() + interval '1 day',
    'line_items', '[{"price": "price_X", "quantity": 1}]'::jsonb, 'created_by', admin, 'stripe_synced_at', now()));
  perform bo.ok('K1 a Checkout session is recorded for the client, with an audit event',
    (r ->> 'created')::boolean and exists (select 1 from checkout_sessions where stripe_checkout_session_id = 'cs_test_Ops1'
      and client_id = bo.id('c1') and created_by = admin)
    and exists (select 1 from billing_audit_events where action = 'create_checkout' and subject = 'cs_test_Ops1'), r::text);
  r := billing_record_checkout(jsonb_build_object('client_id', bo.id('c1'), 'stripe_customer_id', 'cus_Ops1',
    'stripe_checkout_session_id', 'cs_test_Ops1', 'livemode', false, 'mode', 'subscription', 'status', 'open',
    'expires_at', now() + interval '1 day', 'created_by', admin, 'stripe_synced_at', now()));
  perform bo.ok('K2 recording the same session again is a no-op', not (r ->> 'created')::boolean
    and (select count(*) from billing_audit_events where subject = 'cs_test_Ops1') = 1, r::text);
  e := bo.try(format($q$select billing_record_checkout(%L)$q$, jsonb_build_object('client_id', bo.id('c2'), 'stripe_customer_id', 'cus_Ops1',
    'stripe_checkout_session_id', 'cs_test_Cross', 'livemode', false, 'mode', 'subscription', 'status', 'open',
    'expires_at', now() + interval '1 day', 'stripe_synced_at', now())));
  perform bo.ok('K3 a Checkout session cannot put one client''s customer on another client', e like '23503%', e);

  -- The audit function and direct writes.
  r := to_jsonb(billing_audit(jsonb_build_object('client_id', bo.id('c1'), 'action', 'portal_session', 'actor_kind', 'portal',
    'actor_portal_user_id', (select id from portal_users limit 1), 'livemode', false, 'subject', 'cus_Ops1')));
  perform bo.ok('A1 the function records a portal contact''s action', r is not null, r::text);
  e := bo.try($q$select billing_audit('{"action": "portal_session", "actor_kind": "portal"}')$q$);
  perform bo.ok('A2 a portal action names its portal contact', e like '23514%', e);
  e := bo.try($q$insert into billing_audit_events (action, actor_kind) values ('link_customer', 'team')$q$);
  perform bo.ok('A3 the service role cannot write the audit trail directly', e like '42501%', e);
end $$;
reset role;

-- ── I. Immutability, even for the cluster superuser ─────────────────────────
\c - supabase_admin
do $$
declare e text;
begin
  e := bo.try(format($q$update payments set amount_cents = 1 where id = %L$q$, (select v from bo.saved where k = 'payment')));
  perform bo.ok('I1 an external payment''s amount never changes', e like '23514%', e);
  e := bo.try(format($q$update payments set voided_at = null, void_reason = null, voided_by = null where id = %L$q$,
    (select v from bo.saved where k = 'payment')));
  perform bo.ok('I2 a void is never undone', e like '23514%', e);
  e := bo.try($q$update billing_audit_events set subject = 'x'$q$);
  perform bo.ok('I3 the superuser is exempt from the append-only rule (it can switch triggers off anyway)', e is null, e);
end $$;
\c - postgres
do $$
declare e text;
begin
  e := bo.try($q$delete from billing_audit_events$q$);
  perform bo.ok('I4 the worker cannot delete audit history', e like '42501%' or e like '23514%', e);
  e := bo.try(format($q$delete from payments where id = %L$q$, (select v from bo.saved where k = 'payment')));
  perform bo.ok('I5 ...or a payment', e like '42501%', e);
end $$;

\c - authenticator
set role authenticated;
select bo.as_user('authenticated', :'team');
do $$
begin
  perform bo.ok('T1 the team reads the audit trail and the voided payment',
    (select count(*) from billing_audit_events where client_id = bo.id('c1')) >= 4
    and (select voided_at is not null from payments where id = (select v::uuid from bo.saved where k = 'payment')));
end $$;
reset role;
set role authenticated;
select bo.as_user('authenticated', :'pa');
do $$
begin
  perform bo.ok('T2 a portal contact reads no audit history', (select count(*) from billing_audit_events) = 0);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o
\pset footer off
select status, count(*) from bo.results group by status order by status;
select n, status, name, detail from bo.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from bo.results where status = 'fail';
  if f > 0 then raise exception '% billing operations check(s) failed', f; end if;
end $$;
