-- Prepare the existing delegated billing capability before the client signs.
-- Only payment metadata changes. Issued terms and signatures remain immutable.
create function agreement_private.prepare_payment(p_actor uuid,p_id uuid,p_token text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.agreement_contracts; m public.team_members; l public.billing_payment_links;
begin
  if session_user <> 'agreement_service' then raise exception 'agreement_runtime_only'; end if;
  select * into m from public.team_members where auth_user_id=p_actor and role::text='admin';
  if m.id is null then raise exception 'agreement_admin_only'; end if;
  select c.* into a from public.agreement_contracts c join public.agreement_issuers i on i.id=c.issuer_id
    where c.id=p_id and i.client_id is null and i.enabled for update of c;
  if a.id is null or a.status not in ('issued','signed') or (a.status='issued' and a.expires_at<=now())
    or not public.billing_livemode() then raise exception 'agreement_live_issued_required'; end if;
  if a.snapshot->'scope' is distinct from agreement_private.scope(a.client_id)
    then raise exception 'agreement_signed_scope_changed'; end if;
  if a.snapshot#>>'{scope,plan,collection}' <> 'stripe' then raise exception 'agreement_stripe_required'; end if;
  -- Refuse changed scope before the CRM replaces any delegated payment link.
  if p_token is null then return to_jsonb(a); end if;
  if length(p_token)<>43 or p_token !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'agreement_payment_link_required'; end if;
  select * into l from public.billing_payment_links
    where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for share;
  if l.id is null or l.client_id<>a.client_id or not l.livemode or l.revoked_at is not null or l.expires_at<=now()
    or l.agreement is distinct from public.billing_payment_plan(a.client_id)
    or not exists(select 1 from public.team_members where id=l.issued_by and role::text='admin')
    or not exists(select 1 from public.clients where id=a.client_id and status::text<>'offboarded')
    or not exists(select 1 from public.stripe_customers where client_id=a.client_id and livemode
      and stripe_customer_id=l.customer_id and unlinked_at is null and deleted_at is null)
    then raise exception 'agreement_payment_link_required'; end if;
  if (a.payment_url,a.payment_expires_at) is distinct from ('/pay/'||p_token,l.expires_at) then
    update public.agreement_contracts set payment_url='/pay/'||p_token,payment_expires_at=l.expires_at
      where id=a.id returning * into a;
    insert into public.agreement_events(contract_id,kind,actor,detail)
      values(a.id,'payment_prepared',m.name,jsonb_build_object('payment_link_id',l.id,'expires_at',l.expires_at));
  end if;
  return to_jsonb(a);
end $$;
revoke all on function agreement_private.prepare_payment(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function agreement_private.prepare_payment(uuid,uuid,text) to agreement_service;
