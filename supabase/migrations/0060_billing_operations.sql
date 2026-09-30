-- 0060 — Billing B3: the operations the stripe-billing command handler records.
--
-- Everything here is written through 0059's boundary: inside a billing
-- function (SECURITY DEFINER, callable only by an authenticator +
-- service_role session, i.e. an Edge Function) that sets the sync flag the
-- mirror guard admits. The handler has already checked who is asking
-- (admin / member / portal contact); each function re-checks what it can in
-- the database (the recording teammate is an admin, the client exists, the
-- payment belongs to the client) so a caller of the function cannot skip it.
--
--   1. checkout_sessions rows: billing_record_checkout() records a Checkout
--      Session the handler created in Stripe (0059's sync then keeps it
--      current; it never creates one).
--   2. External (manual) payments: billing_record_external_payment() —
--      admin-recorded check / wire / manually received ACH / other; exact
--      terms, idempotent per request, and immutable once written. A mistake
--      is corrected by billing_void_external_payment() (voided with who, when
--      and why), never by deleting or editing the record.
--   3. billing_audit_events: an append-only history of every billing action
--      (who linked or created a customer, created a price or a Checkout link,
--      opened the Customer Portal, recorded or voided a payment, configured
--      the catalog's Stripe side). Team-readable; nobody updates or deletes it.
--
-- The shared service-role key residual (docs/billing.md, "The write boundary,
-- and its limit") applies unchanged: any Edge Function could call these.

-- ── 1. External payments: idempotency, void correction, immutability ────────
alter table payments
  add column client_request_id uuid unique,
  add column voided_at timestamptz,
  add column voided_by uuid references team_members on delete set null,
  add column void_reason text,
  add constraint payments_void_external_only check (voided_at is null or source = 'external'),
  add constraint payments_void_reason check ((voided_at is null) = (void_reason is null)),
  add constraint payments_request_external_only check (client_request_id is null or source = 'external');

-- An external payment never changes after it is recorded, except to be voided
-- once. (Stripe payments follow Stripe through the sync.)
create function billing_external_payment_immutable() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.source = 'external' and (
       (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason', 'updated_at'])
         is distinct from (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason', 'updated_at'])
    or (old.voided_at is not null and (new.voided_at, new.voided_by, new.void_reason)
                                     is distinct from (old.voided_at, old.voided_by, old.void_reason))) then
    raise exception 'An external payment is never edited: void it and record the correct one'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function billing_external_payment_immutable() from public, anon, authenticated;
create trigger payments_external_immutable before update on payments
  for each row execute function billing_external_payment_immutable();

-- ── 2. The billing audit trail ───────────────────────────────────────────────
create table billing_audit_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients on delete restrict, -- NULL for catalog / account configuration
  action text not null check (action in (
    'link_customer', 'create_customer', 'resync_customer', 'import_product', 'create_custom_price',
    'create_checkout', 'expire_checkout', 'configure_portal', 'portal_session',
    'record_external_payment', 'void_external_payment')),
  actor_kind text not null check (actor_kind in ('team', 'portal')),
  actor_team_member_id uuid references team_members on delete set null,
  actor_portal_user_id uuid references portal_users on delete set null,
  livemode boolean,
  subject text,                      -- the Stripe id or payment id acted on
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now(),
  -- A teammate's action names no portal contact; a portal contact's names no
  -- teammate. (The teammate id may later be nulled if the member is removed.)
  check (case actor_kind when 'team' then actor_portal_user_id is null
                         else actor_portal_user_id is not null and actor_team_member_id is null end)
);
create index on billing_audit_events (client_id, created_at desc);

alter table billing_audit_events enable row level security;
create policy "team read" on billing_audit_events for select to authenticated using ((select is_team()));
revoke all on billing_audit_events from public, anon, authenticated, service_role;
grant select on billing_audit_events to authenticated, service_role;
create trigger billing_audit_events_sync_guard before insert or update or delete on billing_audit_events
  for each row execute function billing_mirror_guard();
create trigger billing_audit_events_sync_guard_truncate before truncate on billing_audit_events
  for each statement execute function billing_mirror_guard();

create function billing_audit_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if billing_caller_is_superuser() then return coalesce(new, old); end if;
  raise exception 'The billing audit trail is append-only' using errcode = 'check_violation';
end $$;
revoke all on function billing_audit_append_only() from public, anon, authenticated;
create trigger billing_audit_events_append_only before update or delete on billing_audit_events
  for each row execute function billing_audit_append_only();

-- ── 3. Functions (Edge Function session only) ────────────────────────────────
create function billing_require_service() returns void
language plpgsql set search_path = public as $$
begin
  if not billing_caller_is_service() then
    raise exception 'Billing operations are for the Stripe functions only' using errcode = '42501';
  end if;
  perform set_config('compass.billing_sync', 'on', true);
end $$;
revoke all on function billing_require_service() from public, anon, authenticated, service_role;

-- p = {client_id, action, actor_kind, actor_team_member_id | actor_portal_user_id, livemode, subject, detail}
create function billing_audit(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform billing_require_service();
  insert into billing_audit_events (client_id, action, actor_kind, actor_team_member_id, actor_portal_user_id,
                                    livemode, subject, detail)
  values ((p ->> 'client_id')::uuid, p ->> 'action', p ->> 'actor_kind', (p ->> 'actor_team_member_id')::uuid,
          (p ->> 'actor_portal_user_id')::uuid, (p ->> 'livemode')::boolean, p ->> 'subject',
          coalesce(p -> 'detail', '{}'))
  returning id into v_id;
  perform set_config('compass.billing_sync', 'off', true);
  return v_id;
end $$;

-- A Checkout Session the handler created in Stripe. p = the session as the
-- handler maps it + {client_id, package_id, line_items, created_by}. The
-- customer must be the client's (composite key); the audit row is written in
-- the same transaction.
create function billing_record_checkout(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform billing_require_service();
  insert into checkout_sessions (client_id, stripe_customer_id, stripe_checkout_session_id, livemode, mode, status,
      payment_status, url, expires_at, package_id, line_items, created_by, stripe_created_at, stripe_synced_at)
  select (p ->> 'client_id')::uuid, x.stripe_customer_id, x.stripe_checkout_session_id, x.livemode, x.mode, x.status,
         x.payment_status, x.url, x.expires_at, (p ->> 'package_id')::uuid, coalesce(p -> 'line_items', '[]'),
         (p ->> 'created_by')::uuid, x.stripe_created_at, x.stripe_synced_at
  from jsonb_populate_record(null::checkout_sessions, p) x
  on conflict (stripe_checkout_session_id) do nothing
  returning id into v_id;
  if v_id is not null then
    insert into billing_audit_events (client_id, action, actor_kind, actor_team_member_id, livemode, subject, detail)
    values ((p ->> 'client_id')::uuid, 'create_checkout', 'team', (p ->> 'created_by')::uuid, (p ->> 'livemode')::boolean,
            p ->> 'stripe_checkout_session_id',
            jsonb_build_object('package_id', p ->> 'package_id', 'line_items', p -> 'line_items', 'expires_at', p ->> 'expires_at'));
  end if;
  perform set_config('compass.billing_sync', 'off', true);
  return jsonb_build_object('id', coalesce(v_id, (select id from checkout_sessions
    where stripe_checkout_session_id = p ->> 'stripe_checkout_session_id')), 'created', v_id is not null);
end $$;

-- An external payment, recorded by an admin. p = {client_id, amount_cents,
-- currency, paid_at, external_method, reference, notes, recorded_by,
-- client_request_id}. The same request id twice records one payment.
create function billing_record_external_payment(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_existing uuid;
begin
  perform billing_require_service();
  if not exists (select 1 from team_members where id = (p ->> 'recorded_by')::uuid and role = 'admin') then
    raise exception 'Only an admin records an external payment' using errcode = '42501';
  end if;
  if not exists (select 1 from clients where id = (p ->> 'client_id')::uuid) then
    raise exception 'client % does not exist', p ->> 'client_id' using errcode = '23503';
  end if;
  if coalesce(btrim(p ->> 'notes'), '') = '' then
    raise exception 'An external payment needs a note' using errcode = 'check_violation';
  end if;
  select id into v_existing from payments where client_request_id = (p ->> 'client_request_id')::uuid;
  if v_existing is not null then
    perform set_config('compass.billing_sync', 'off', true);
    return jsonb_build_object('id', v_existing, 'created', false);
  end if;
  insert into payments (client_id, source, status, external_method, reference, notes, recorded_by, amount_cents,
                        currency, paid_at, client_request_id)
  values ((p ->> 'client_id')::uuid, 'external', 'succeeded', p ->> 'external_method', nullif(btrim(p ->> 'reference'), ''),
          btrim(p ->> 'notes'), (p ->> 'recorded_by')::uuid, (p ->> 'amount_cents')::bigint, lower(p ->> 'currency'),
          (p ->> 'paid_at')::timestamptz, (p ->> 'client_request_id')::uuid)
  returning id into v_id;
  insert into billing_audit_events (client_id, action, actor_kind, actor_team_member_id, subject, detail)
  values ((p ->> 'client_id')::uuid, 'record_external_payment', 'team', (p ->> 'recorded_by')::uuid, v_id::text,
          jsonb_build_object('amount_cents', (p ->> 'amount_cents')::bigint, 'currency', lower(p ->> 'currency'),
            'method', p ->> 'external_method', 'paid_at', p ->> 'paid_at', 'reference', p ->> 'reference'));
  perform set_config('compass.billing_sync', 'off', true);
  return jsonb_build_object('id', v_id, 'created', true);
end $$;

-- Void an external payment (the correction path). p = {client_id,
-- payment_id, voided_by, reason}.
create function billing_void_external_payment(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform billing_require_service();
  if not exists (select 1 from team_members where id = (p ->> 'voided_by')::uuid and role = 'admin') then
    raise exception 'Only an admin voids an external payment' using errcode = '42501';
  end if;
  if coalesce(btrim(p ->> 'reason'), '') = '' then
    raise exception 'Voiding a payment needs a reason' using errcode = 'check_violation';
  end if;
  update payments set voided_at = now(), voided_by = (p ->> 'voided_by')::uuid, void_reason = btrim(p ->> 'reason')
   where id = (p ->> 'payment_id')::uuid and client_id = (p ->> 'client_id')::uuid
     and source = 'external' and voided_at is null;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'No unvoided external payment % for this client', p ->> 'payment_id' using errcode = 'P0002';
  end if;
  insert into billing_audit_events (client_id, action, actor_kind, actor_team_member_id, subject, detail)
  values ((p ->> 'client_id')::uuid, 'void_external_payment', 'team', (p ->> 'voided_by')::uuid, p ->> 'payment_id',
          jsonb_build_object('reason', btrim(p ->> 'reason')));
  perform set_config('compass.billing_sync', 'off', true);
  return jsonb_build_object('id', p ->> 'payment_id', 'voided', true);
end $$;

revoke all on function billing_audit(jsonb) from public, anon, authenticated;
revoke all on function billing_record_checkout(jsonb) from public, anon, authenticated;
revoke all on function billing_record_external_payment(jsonb) from public, anon, authenticated;
revoke all on function billing_void_external_payment(jsonb) from public, anon, authenticated;
grant execute on function billing_audit(jsonb) to service_role;
grant execute on function billing_record_checkout(jsonb) to service_role;
grant execute on function billing_record_external_payment(jsonb) to service_role;
grant execute on function billing_void_external_payment(jsonb) to service_role;

-- ── 4. Verify ────────────────────────────────────────────────────────────────
do $$
begin
  if has_table_privilege('service_role', 'public.billing_audit_events', 'insert,update,delete,truncate')
     or has_table_privilege('authenticated', 'public.billing_audit_events', 'insert,update,delete,truncate')
     or has_table_privilege('anon', 'public.billing_audit_events', 'select') then
    raise exception '0060: billing_audit_events is writable through the API';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'billing\_%' and p.prosecdef
               and (has_function_privilege('authenticated', p.oid, 'execute')
                    or has_function_privilege('anon', p.oid, 'execute'))) then
    raise exception '0060: a billing security-definer function is callable by a signed-in user or anon';
  end if;
end $$;
