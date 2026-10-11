-- Seven days from issuance for new and existing unrevoked Compass links.
-- Preserve URLs and any earlier expiry. Already opened Stripe Checkout sessions
-- retain their separate expiry; no agreements, charges or prices are changed.
alter table billing_payment_links
  alter column expires_at set default now() + interval '7 days';
update billing_payment_links
  set expires_at = least(expires_at, created_at + interval '7 days')
  where revoked_at is null and expires_at > created_at + interval '7 days';

-- Keep the issuance audit duration consistent with the database default.
create or replace function billing_payment_link_write(p jsonb) returns jsonb
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
      'detail', jsonb_build_object('valid_days', 7)));
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
