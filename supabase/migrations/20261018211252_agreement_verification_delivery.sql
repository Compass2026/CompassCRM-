-- Append delivery evidence through the existing isolated agreement runtime.
-- No public RPC, table grant, signature mutation or payment operation.
create function agreement_private.verification_delivery(p_token text, p_code text, p_result jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare
  l agreement_private.links;
  request_id bigint;
  outcome text := p_result->>'outcome';
  safe_detail jsonb;
  previous_detail jsonb;
begin
  if session_user <> 'agreement_service' then raise exception 'agreement_runtime_only'; end if;
  if outcome is null or outcome not in ('accepted','failed','unknown')
    or p_code is null or p_code !~ '^[a-f0-9]{64}$'
    or (outcome='accepted' and coalesce(p_result->>'provider_id','') !~ '^[A-Za-z0-9-]{1,100}$')
    or (outcome<>'accepted' and coalesce(p_result->>'failure_code','') not in
      ('sender_not_authorized','provider_rejected','rate_limited','provider_unavailable','transport_unknown'))
    or (p_result ? 'http_status' and coalesce(p_result->>'http_status','') !~ '^[1-5][0-9]{2}$')
    then raise exception 'agreement_delivery_invalid'; end if;
  select * into l from agreement_private.links where token_hash=p_token;
  if l.contract_id is null then raise exception 'agreement_delivery_unavailable'; end if;
  -- Same lock order as signer/staff, followed by a re-read after lock acquisition.
  perform 1 from public.agreement_contracts where id=l.contract_id for update;
  select * into l from agreement_private.links where token_hash=p_token for update;
  if l.contract_id is null or l.code_hash is distinct from p_code then
    raise exception 'agreement_delivery_unavailable'; end if;
  select id into request_id from public.agreement_events
    where contract_id=l.contract_id and kind='verification_requested'
    order by id desc limit 1;
  if request_id is null then raise exception 'agreement_delivery_unavailable'; end if;
  safe_detail := jsonb_strip_nulls(jsonb_build_object(
    'request_event_id',request_id,'outcome',outcome,
    'provider_id',case when outcome='accepted' then p_result->>'provider_id' end,
    'http_status',p_result->'http_status',
    'failure_code',case when outcome<>'accepted' then p_result->>'failure_code' end));
  select detail into previous_detail from public.agreement_events
    where contract_id=l.contract_id and kind in
      ('verification_email_accepted','verification_email_failed','verification_email_unknown')
      and detail->>'request_event_id'=request_id::text;
  if found then
    if previous_detail is distinct from safe_detail then raise exception 'agreement_delivery_conflict'; end if;
    return;
  end if;
  insert into public.agreement_events(contract_id,kind,actor,detail)
    values(l.contract_id,'verification_email_'||outcome,'system',safe_detail);
end $$;
revoke all on function agreement_private.verification_delivery(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function agreement_private.verification_delivery(text,text,jsonb) to agreement_service;
