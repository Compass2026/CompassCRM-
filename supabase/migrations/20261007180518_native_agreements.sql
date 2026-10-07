-- Native agreements. Public signers never receive Data API privileges.
-- A dedicated server login can execute only the private, validating API.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='agreement_service') then
    create role agreement_service login noinherit nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end $$;
grant agreement_service to postgres;
create schema agreement_private;
revoke all on schema agreement_private from public, anon, authenticated, service_role;
grant usage on schema agreement_private to agreement_service;

-- Provision credentials without storing a password in migration history.
create function agreement_private.set_password(p_password text) returns void
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if session_user <> 'postgres' or current_user <> 'postgres' or length(p_password)<40 then
    raise exception 'agreement_password_provisioning_refused';
  end if;
  execute format('alter role agreement_service password %L',p_password);
end $$;

create table public.agreement_issuers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid unique references public.clients(id) on delete restrict,
  name text not null, terms text not null default '',
  terms_reviewed boolean not null default false,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
create unique index agreement_compass_issuer on public.agreement_issuers ((client_id is null)) where client_id is null;
insert into public.agreement_issuers(name,enabled) values ('Compass Marketing Advisors LLC',true);

create table public.agreement_contracts (
  id uuid primary key default gen_random_uuid(),
  issuer_id uuid not null references public.agreement_issuers(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  title text not null,
  recipient_name text not null default '', recipient_email text not null default '',
  status text not null default 'draft' check(status in ('draft','issued','signed','declined','void')),
  snapshot jsonb not null,
  content_hash text,
  provider_name text, provider_signed_at timestamptz,
  signer_name text, signed_at timestamptz, signer_ip text, signer_agent text,
  consent_text text,
  issued_at timestamptz, expires_at timestamptz,
  payment_url text, payment_expires_at timestamptz,
  pdf_hash text,
  created_by uuid references public.team_members(id) on delete restrict,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index agreement_contracts_client on public.agreement_contracts(client_id,created_at desc);
create index agreement_contracts_issuer on public.agreement_contracts(issuer_id);
create index agreement_contracts_actor on public.agreement_contracts(created_by);
create table public.agreement_events (
  id bigint generated always as identity primary key,
  contract_id uuid not null references public.agreement_contracts(id) on delete restrict,
  kind text not null, actor text not null, detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index agreement_events_contract on public.agreement_events(contract_id,id);
create table agreement_private.links (
  contract_id uuid primary key references public.agreement_contracts(id) on delete restrict,
  token_hash text unique not null,
  code_hash text, code_until timestamptz, attempts integer not null default 0,
  last_code_at timestamptz, code_count integer not null default 0, code_day date,
  session_hash text, session_until timestamptz,
  last_view_at timestamptz
);
create table agreement_private.artifacts (
  contract_id uuid primary key references public.agreement_contracts(id) on delete restrict,
  bytes bytea not null, sha256 text not null, created_at timestamptz not null default now()
);
alter table public.agreement_issuers enable row level security;
alter table public.agreement_contracts enable row level security;
alter table public.agreement_events enable row level security;
alter table agreement_private.links enable row level security;
alter table agreement_private.artifacts enable row level security;
revoke all on public.agreement_issuers,public.agreement_contracts,public.agreement_events from public,anon,authenticated,service_role,agreement_service;
revoke all on all tables in schema agreement_private from public,anon,authenticated,service_role,agreement_service;
grant select on public.agreement_issuers,public.agreement_contracts,public.agreement_events to authenticated;
create policy agreement_issuers_team on public.agreement_issuers for select to authenticated using ((select public.is_team()));
create policy agreement_contracts_team on public.agreement_contracts for select to authenticated using ((select public.is_team()));
create policy agreement_events_team on public.agreement_events for select to authenticated using ((select public.is_team()));

create function agreement_private.guard() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if current_user <> 'postgres' or session_user <> 'agreement_service' then
    raise exception 'agreement_write_boundary';
  end if;
  if tg_op='DELETE' then raise exception 'agreement_records_retained'; end if;
  if tg_table_name='agreement_events' or tg_table_name='artifacts' then
    if tg_op <> 'INSERT' then raise exception 'agreement_append_only'; end if;
  elsif tg_table_name='agreement_contracts' and tg_op='UPDATE' then
    if old.status <> 'draft' and
      (new.snapshot,new.title,new.recipient_name,new.recipient_email,new.client_id,new.issuer_id,new.content_hash,new.provider_name,new.provider_signed_at,new.issued_at,new.expires_at)
      is distinct from
      (old.snapshot,old.title,old.recipient_name,old.recipient_email,old.client_id,old.issuer_id,old.content_hash,old.provider_name,old.provider_signed_at,old.issued_at,old.expires_at)
    then raise exception 'agreement_content_locked'; end if;
    if old.status='signed' and
      (new.status,new.signer_name,new.signed_at,new.signer_ip,new.signer_agent,new.consent_text)
      is distinct from (old.status,old.signer_name,old.signed_at,old.signer_ip,old.signer_agent,old.consent_text)
    then raise exception 'agreement_signature_locked'; end if;
  end if;
  return new;
end $$;
create trigger agreement_contracts_guard before insert or update or delete on public.agreement_contracts for each row execute function agreement_private.guard();
create trigger agreement_issuers_guard before insert or update or delete on public.agreement_issuers for each row execute function agreement_private.guard();
create trigger agreement_events_guard before insert or update or delete on public.agreement_events for each row execute function agreement_private.guard();
create trigger agreement_artifacts_guard before insert or update or delete on agreement_private.artifacts for each row execute function agreement_private.guard();

create function agreement_private.scope(p_client uuid) returns jsonb language sql stable set search_path=public,pg_temp as $$
  select jsonb_build_object('client_name',c.name,'plan',
    jsonb_build_object('package_id',p.package_id,'collection',p.collection,'amount_cents',p.agreed_amount_cents,
      'currency',p.agreed_currency,'interval',p.agreed_billing_interval,'interval_count',p.agreed_billing_interval_count,
      'start_date',p.start_date,'term_months',p.term_months,'managed_ad_budget_cents',p.managed_ad_budget_cents),
    'services',(select coalesce(jsonb_agg(jsonb_build_object('name',e.service_name,'quantity',e.quantity,'unit',e.unit,'period',e.period) order by e.sort_order),'[]')
      from public.client_entitlements_for(p_client) e where e.enabled))
  from public.clients c join public.plans p on p.client_id=c.id where c.id=p_client
$$;

create function agreement_private.staff(p_actor uuid,p_action text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.team_members; a public.agreement_contracts; i public.agreement_issuers; s jsonb; cid uuid; outval jsonb;
begin
  if session_user <> 'agreement_service' then raise exception 'agreement_runtime_only'; end if;
  select * into m from public.team_members where auth_user_id=p_actor;
  if m.id is null then raise exception 'agreement_team_only'; end if;
  cid := nullif(p_args->>'client_id','')::uuid;
  select * into i from public.agreement_issuers where client_id is null;
  if p_action='list' then
    return jsonb_build_object('issuer',to_jsonb(i),'contracts',(select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc),'[]') from public.agreement_contracts t where t.client_id=cid and t.issuer_id=i.id));
  end if;
  if p_action='read' then
    select * into a from public.agreement_contracts where id=(p_args->>'id')::uuid and issuer_id=i.id;
    if a.id is null then raise exception 'agreement_not_found'; end if;
    return to_jsonb(a)||jsonb_build_object('events',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]') from public.agreement_events e where e.contract_id=a.id));
  end if;
  if m.role::text <> 'admin' then raise exception 'agreement_admin_only'; end if;
  if p_action='template' then
    if length(p_args->>'terms') not between 50 and 60000 then raise exception 'agreement_terms_required'; end if;
    update public.agreement_issuers set terms=p_args->>'terms',terms_reviewed=(p_args->>'reviewed')::boolean,updated_at=now() where id=i.id;
    return jsonb_build_object('ok',true);
  end if;
  if p_action in ('create','save') then
    s := agreement_private.scope(cid);
    if s is null then raise exception 'agreement_plan_required'; end if;
    if p_action='create' then
      insert into public.agreement_contracts(issuer_id,client_id,title,snapshot,created_by)
        values(i.id,cid,coalesce(nullif(p_args->>'title',''),'Marketing Services Agreement'),
          jsonb_build_object('version',1,'issuer_name',i.name,'scope',s,'terms',i.terms),m.id) returning * into a;
    else
      select * into a from public.agreement_contracts where id=(p_args->>'id')::uuid and client_id=cid and issuer_id=i.id for update;
      if a.id is null or a.status <> 'draft' then raise exception 'agreement_draft_only'; end if;
      if length(p_args->>'terms') not between 50 and 60000 then raise exception 'agreement_terms_required'; end if;
      if length(p_args->>'recipient_name') not between 2 and 160 or length(p_args->>'recipient_email')>254
        or p_args->>'recipient_email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'agreement_recipient_required'; end if;
      update public.agreement_contracts set recipient_name=p_args->>'recipient_name',recipient_email=lower(p_args->>'recipient_email'),
        title=left(coalesce(nullif(p_args->>'title',''),'Marketing Services Agreement'),180),
        snapshot=jsonb_build_object('version',1,'issuer_name',i.name,'scope',s,'terms',p_args->>'terms'),updated_at=now()
        where id=a.id returning * into a;
    end if;
    insert into public.agreement_events(contract_id,kind,actor) values(a.id,p_action,m.name);
    return to_jsonb(a);
  end if;
  select * into a from public.agreement_contracts where id=(p_args->>'id')::uuid and issuer_id=i.id for update;
  if a.id is null then raise exception 'agreement_not_found'; end if;
  if p_action='issue' then
    if a.status <> 'draft' or not i.enabled then raise exception 'agreement_draft_only'; end if;
    if p_args->>'reviewed' is distinct from 'true' or coalesce(length(p_args->>'provider_name'),0) not between 2 and 160 then raise exception 'agreement_review_required'; end if;
    if coalesce(length(a.snapshot->>'terms'),0)<50 or a.recipient_email='' or a.recipient_name='' then raise exception 'agreement_terms_and_recipient_required'; end if;
    if a.snapshot->'scope' is distinct from agreement_private.scope(a.client_id) then raise exception 'agreement_plan_changed_save_again'; end if;
    if (a.snapshot#>>'{scope,plan,amount_cents}') is null then raise exception 'agreement_price_required'; end if;
    if length(p_args->>'token_hash')<>64 then raise exception 'agreement_invalid_token'; end if;
    update public.agreement_contracts set status='issued',issued_at=now(),expires_at=now()+interval '14 days',
      content_hash=encode(extensions.digest(jsonb_build_object('document',snapshot,'title',title,'recipient_name',recipient_name,'recipient_email',recipient_email)::text,'sha256'),'hex'),provider_name=p_args->>'provider_name',provider_signed_at=now(),updated_at=now()
      where id=a.id returning * into a;
    insert into agreement_private.links(contract_id,token_hash) values(a.id,p_args->>'token_hash');
  elsif p_action='relink' then
    if a.status<>'issued' or a.expires_at<now() then raise exception 'agreement_draft_only'; end if;
    if p_args->>'reviewed' is distinct from 'true' or length(p_args->>'token_hash')<>64 then raise exception 'agreement_review_required'; end if;
    update agreement_private.links set token_hash=p_args->>'token_hash',code_hash=null,code_until=null,attempts=0,
      session_hash=null,session_until=null,last_view_at=null where contract_id=a.id;
  elsif p_action='delivery' then
    if a.status<>'issued' or a.expires_at<now() or not exists(select 1 from agreement_private.links where contract_id=a.id and token_hash=p_args->>'token_hash') then raise exception 'agreement_link_unavailable'; end if;
    return jsonb_build_object('email',a.recipient_email,'name',a.recipient_name,'title',a.title,'issuer',a.snapshot->>'issuer_name');
  elsif p_action='sent' then
    if a.status<>'issued' then raise exception 'agreement_link_unavailable'; end if;
    insert into public.agreement_events(contract_id,kind,actor,detail) values(a.id,'email_accepted',m.name,jsonb_build_object('provider_id',left(p_args->>'provider_id',100)));
    return jsonb_build_object('ok',true);
  elsif p_action='void' then
    if a.status not in ('draft','issued') then raise exception 'agreement_cannot_void'; end if;
    update public.agreement_contracts set status='void',updated_at=now() where id=a.id returning * into a;
    delete from agreement_private.links where contract_id=a.id;
  elsif p_action='payment' then
    if a.status<>'signed' or not public.billing_livemode() then raise exception 'agreement_live_signed_only'; end if;
    if a.snapshot->'scope' is distinct from agreement_private.scope(a.client_id) then raise exception 'agreement_signed_scope_changed'; end if;
    select jsonb_build_object('url',c.url,'expires_at',c.expires_at) into outval from public.checkout_sessions c
      where c.client_id=a.client_id and c.livemode and c.status='open' and c.expires_at>now()
      order by c.created_at desc limit 1;
    if outval is null then raise exception 'agreement_live_checkout_required'; end if;
    update public.agreement_contracts set payment_url=outval->>'url',payment_expires_at=(outval->>'expires_at')::timestamptz where id=a.id returning * into a;
  else raise exception 'agreement_unknown_action';
  end if;
  insert into public.agreement_events(contract_id,kind,actor) values(a.id,p_action,m.name);
  return to_jsonb(a);
end $$;

create function agreement_private.signer(p_token text,p_session text,p_action text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare l agreement_private.links; a public.agreement_contracts; verified boolean; code text;
begin
  if session_user <> 'agreement_service' then raise exception 'agreement_runtime_only'; end if;
  select * into l from agreement_private.links where token_hash=p_token;
  if l.contract_id is null then return jsonb_build_object('error','unavailable'); end if;
  select * into a from public.agreement_contracts where id=l.contract_id for update;
  -- Staff and signers acquire contract, then link, in the same order. Re-read
  -- after waiting so a concurrently replaced token cannot survive revocation.
  select * into l from agreement_private.links where contract_id=a.id and token_hash=p_token for update;
  if l.contract_id is null then return jsonb_build_object('error','unavailable'); end if;
  if a.status not in ('issued','signed','declined') or (a.status<>'signed' and a.expires_at<now())
    or (a.status='signed' and a.signed_at<now()-interval '90 days') then return jsonb_build_object('error','unavailable'); end if;
  verified := l.session_hash is not null and l.session_hash=p_session and l.session_until>now();
  if p_action='code' then
    if a.status='declined' then return jsonb_build_object('error','unavailable'); end if;
    if l.last_code_at>now()-interval '60 seconds' or (l.code_day=current_date and l.code_count>=10)
      then return jsonb_build_object('error','code_rate_limited'); end if;
    if length(p_args->>'code_hash')<>64 then return jsonb_build_object('error','invalid_code'); end if;
    update agreement_private.links set code_hash=p_args->>'code_hash',code_until=now()+interval '10 minutes',attempts=0,
      last_code_at=now(),code_day=current_date,code_count=case when l.code_day=current_date then l.code_count+1 else 1 end
      where contract_id=a.id;
    insert into public.agreement_events(contract_id,kind,actor) values(a.id,'verification_requested','recipient');
    return jsonb_build_object('email',a.recipient_email,'issuer',a.snapshot->>'issuer_name');
  elsif p_action='verify' then
    if l.code_hash is null or l.code_until<now() or l.attempts>=5 then return jsonb_build_object('error','code_expired'); end if;
    update agreement_private.links set attempts=attempts+1 where contract_id=a.id;
    if l.code_hash is distinct from p_args->>'code_hash' then return jsonb_build_object('error','invalid_code'); end if;
    if length(p_args->>'session_hash')<>64 then return jsonb_build_object('error','invalid_code'); end if;
    update agreement_private.links set code_hash=null,session_hash=p_args->>'session_hash',session_until=now()+interval '1 hour' where contract_id=a.id;
    insert into public.agreement_events(contract_id,kind,actor) values(a.id,'email_verified','recipient');
    return jsonb_build_object('ok',true);
  elsif p_action='read' and not verified then
    return jsonb_build_object('verified',false,'issuer',a.snapshot->>'issuer_name');
  end if;
  if not verified then return jsonb_build_object('error','verification_required'); end if;
  if p_action='read' then
    if l.last_view_at is null then
      insert into public.agreement_events(contract_id,kind,actor) values(a.id,'viewed','recipient');
      update agreement_private.links set last_view_at=now() where contract_id=a.id;
    end if;
  elsif p_action='sign' then
    if a.status='signed' then return to_jsonb(a)||jsonb_build_object('verified',true); end if;
    if a.status<>'issued' then return jsonb_build_object('error','unavailable'); end if;
    if p_args->>'consent' is distinct from 'true' or coalesce(length(p_args->>'name'),0) not between 2 and 160 then return jsonb_build_object('error','consent_required'); end if;
    if p_args->>'content_hash' is distinct from a.content_hash then return jsonb_build_object('error','version_changed'); end if;
    update public.agreement_contracts set status='signed',signer_name=p_args->>'name',signed_at=now(),
      signer_ip=left(p_args->>'ip',120),signer_agent=left(p_args->>'agent',500),
      consent_text='I have read this agreement, consent to electronic records and signatures, and am authorized to sign for the customer. Typing my name is my signature. I can download and retain a copy. Signing does not authorize a bank debit or card charge.',updated_at=now()
      where id=a.id returning * into a;
    insert into public.agreement_events(contract_id,kind,actor,detail) values(a.id,'signed','recipient',jsonb_build_object('content_hash',a.content_hash,'email_verified',true));
  elsif p_action='decline' then
    if a.status<>'issued' then return jsonb_build_object('error','unavailable'); end if;
    update public.agreement_contracts set status='declined',updated_at=now() where id=a.id returning * into a;
    insert into public.agreement_events(contract_id,kind,actor) values(a.id,'declined','recipient');
  else return jsonb_build_object('error','unavailable'); end if;
  return to_jsonb(a)||jsonb_build_object('verified',true);
end $$;

create function agreement_private.artifact(p_id uuid,p_actor uuid,p_token text,p_session text,p_bytes bytea default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.agreement_contracts; f agreement_private.artifacts;
begin
  if session_user <> 'agreement_service' then raise exception 'agreement_runtime_only'; end if;
  select * into a from public.agreement_contracts where id=p_id for update;
  if not exists(select 1 from public.team_members where auth_user_id=p_actor) and not exists(
    select 1 from agreement_private.links l join public.agreement_contracts c on c.id=l.contract_id where l.contract_id=p_id and l.token_hash=p_token and l.session_hash=p_session and l.session_until>now() and c.signed_at>now()-interval '90 days')
    then raise exception 'agreement_verification_required'; end if;
  if a.status<>'signed' then raise exception 'agreement_signed_only'; end if;
  select * into f from agreement_private.artifacts where contract_id=p_id;
  if f.contract_id is null and p_bytes is not null then
    if octet_length(p_bytes)>2000000 or substring(p_bytes from 1 for 5)<>convert_to('%PDF-','UTF8') then raise exception 'agreement_invalid_pdf'; end if;
    insert into agreement_private.artifacts(contract_id,bytes,sha256) values(p_id,p_bytes,encode(extensions.digest(p_bytes,'sha256'),'hex')) returning * into f;
    update public.agreement_contracts set pdf_hash=f.sha256 where id=p_id;
    insert into public.agreement_events(contract_id,kind,actor,detail) values(p_id,'pdf_sealed','system',jsonb_build_object('sha256',f.sha256));
  end if;
  return jsonb_build_object('pdf',encode(f.bytes,'base64'),'sha256',f.sha256);
end $$;
revoke all on all functions in schema agreement_private from public,anon,authenticated,service_role,agreement_service;
grant execute on function agreement_private.staff(uuid,text,jsonb),agreement_private.signer(text,text,text,jsonb),agreement_private.artifact(uuid,uuid,text,text,bytea) to agreement_service;
