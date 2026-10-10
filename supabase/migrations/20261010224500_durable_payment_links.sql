-- Thirty-day, client/price/customer-bound capabilities. Only the dedicated
-- billing runtime can redeem them; no anonymous database access or new secrets.
alter table billing_audit_events drop constraint billing_audit_events_action_check;
alter table billing_audit_events add constraint billing_audit_events_action_check check (action in (
  'link_customer', 'create_customer', 'resync_customer', 'import_product', 'create_custom_price',
  'create_checkout', 'expire_checkout', 'configure_portal', 'portal_session',
  'record_external_payment', 'void_external_payment', 'issue_payment_link', 'revoke_payment_link'));
create table billing_payment_links (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  livemode boolean not null,
  customer_id text not null,
  agreement jsonb not null,
  issued_by uuid not null references team_members(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz,
  request_id uuid not null default gen_random_uuid(),
  latest_session_id text,
  lease_id uuid,
  lease_until timestamptz
);
create unique index billing_payment_links_one_active on billing_payment_links(client_id, livemode) where revoked_at is null;
alter table billing_payment_links enable row level security;
create policy "team read" on billing_payment_links to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on billing_payment_links from public, anon, authenticated, service_role, billing_sync;
grant select (id, client_id, livemode, created_at, expires_at, revoked_at) on billing_payment_links to authenticated;

create function billing_payment_plan(p_client uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('package_id', package_id, 'collection', collection,
    'agreed_amount_cents', agreed_amount_cents, 'agreed_currency', agreed_currency,
    'agreed_billing_interval', agreed_billing_interval, 'agreed_billing_interval_count', agreed_billing_interval_count,
    'billing_package_price_id', billing_package_price_id) from plans where client_id = p_client
$$;
revoke all on function billing_payment_plan(uuid) from public, anon, authenticated, service_role;

create function billing_payment_link_read(p_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare l billing_payment_links; v_status text; v_name text;
begin
  if session_user <> 'billing_sync' then raise insufficient_privilege; end if;
  select * into l from billing_payment_links where token_hash = p_hash;
  if not found or l.revoked_at is not null or l.expires_at <= now() then return null; end if;
  if not exists(select 1 from team_members where id = l.issued_by and role = 'admin')
    or l.livemode <> billing_livemode()
    or billing_payment_plan(l.client_id) is distinct from l.agreement
    or not exists(select 1 from stripe_customers where client_id = l.client_id and livemode = l.livemode
      and stripe_customer_id = l.customer_id and unlinked_at is null and deleted_at is null)
    then return null; end if;
  select name into v_name from clients where id = l.client_id and status <> 'offboarded';
  if not found then return null; end if;
  select status into v_status from checkout_sessions where stripe_checkout_session_id = l.latest_session_id;
  return to_jsonb(l) - 'token_hash' - 'lease_until' || jsonb_build_object('client_name', v_name,
    'state', case when v_status = 'complete' then 'complete' else 'ready' end);
end $$;
revoke all on function billing_payment_link_read(text) from public, anon, authenticated, service_role;
grant execute on function billing_payment_link_read(text) to billing_sync;

create function billing_payment_link_write(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare l billing_payment_links; v_client uuid; v_live boolean; v_actor uuid; v_plan jsonb; v_cus text; v_id uuid; v_read jsonb;
begin
  if session_user <> 'billing_sync' then raise insufficient_privilege; end if;
  if p->>'op' in ('issue', 'revoke') then
    v_client := (p->>'client_id')::uuid; v_actor := (p->>'actor_id')::uuid; v_live := billing_livemode();
    if not exists(select 1 from team_members where id = v_actor and role = 'admin') then raise insufficient_privilege; end if;
    -- Serialize issue/revoke for a client; a public redemption holds a lease,
    -- not a session lock (the runtime uses transaction-pooled connections).
    perform pg_advisory_xact_lock(hashtextextended(v_client::text, 37));
    select * into l from billing_payment_links where client_id = v_client and livemode = v_live and revoked_at is null for update;
    if l.lease_until > now() then raise exception 'Payment setup is in progress. Try again shortly.' using errcode = '55P03'; end if;
    if p->>'op' = 'issue' then
      v_plan := billing_payment_plan(v_client);
      if v_plan is distinct from p->'agreement' or v_plan->>'collection' <> 'stripe'
        or v_plan->>'billing_package_price_id' is null then raise exception 'Agreement changed' using errcode = '23514'; end if;
      select stripe_customer_id into v_cus from stripe_customers where client_id = v_client and livemode = v_live
        and unlinked_at is null and deleted_at is null;
      if v_cus is null or v_cus <> p->>'customer_id' then raise exception 'Customer changed' using errcode = '23514'; end if;
    end if;
    update billing_payment_links set revoked_at = now() where id = l.id;
    if p->>'op' = 'issue' then
      insert into billing_payment_links(client_id, token_hash, livemode, customer_id, agreement, issued_by)
      values(v_client, p->>'token_hash', v_live, v_cus, v_plan, v_actor) returning * into l;
      v_id := l.id;
    else v_id := l.id; end if;
    perform billing_audit(jsonb_build_object('client_id', v_client, 'action', case when p->>'op' = 'issue' then 'issue_payment_link' else 'revoke_payment_link' end,
      'actor_kind', 'team', 'actor_team_member_id', v_actor, 'livemode', v_live, 'subject', v_id,
      'detail', jsonb_build_object('valid_days', 30)));
    return jsonb_build_object('id', v_id, 'expires_at', l.expires_at);
  elsif p->>'op' = 'claim' then
    select * into l from billing_payment_links where token_hash = p->>'token_hash' for update;
    if not found then return null; end if;
    v_read := billing_payment_link_read(p->>'token_hash');
    if v_read is null or v_read->>'state' = 'complete' then return null; end if;
    if l.lease_until > now() then return jsonb_build_object('busy', true); end if;
    if exists(select 1 from checkout_sessions where stripe_checkout_session_id = l.latest_session_id
      and (status = 'expired' or (status = 'open' and expires_at <= now()))) then
      l.request_id := gen_random_uuid();
      l.latest_session_id := null;
    end if;
    update billing_payment_links set lease_id = (p->>'lease_id')::uuid, lease_until = now() + interval '120 seconds',
      request_id = l.request_id, latest_session_id = l.latest_session_id where id = l.id;
    return v_read || jsonb_build_object('request_id', l.request_id);
  elsif p->>'op' = 'release' then
    update billing_payment_links set lease_id = null, lease_until = null,
      latest_session_id = coalesce(p->>'session_id', latest_session_id)
      where id = (p->>'id')::uuid and lease_id = (p->>'lease_id')::uuid;
    return '{}'::jsonb;
  end if;
  raise exception 'Unknown operation' using errcode = '23514';
end $$;
revoke all on function billing_payment_link_write(jsonb) from public, anon, authenticated, service_role;
grant execute on function billing_payment_link_write(jsonb) to billing_sync;
