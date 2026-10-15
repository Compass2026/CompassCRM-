-- Add destinations without changing existing posts, approvals, schedules or quotas.
create table publisher_gbp_policies (
 client_id uuid primary key references clients(id) on delete cascade,
 require_explicit boolean not null default true,
 excluded_locations text[] not null default '{}'
);
alter table publisher_gbp_policies enable row level security;
revoke all on publisher_gbp_policies from public, anon, authenticated, service_role;
grant select on publisher_gbp_policies to authenticated, service_role;
create policy "team reads GBP policies" on publisher_gbp_policies for select to authenticated
 using ((select is_team()));
-- Tom's Logic-only routing decision. No business address is stored.
insert into publisher_gbp_policies(client_id, excluded_locations)
 select id, array['locations/2702790686939089446'] from clients
 where id='70211d71-d9f4-46ab-abe2-ef39c41591fb';

drop index social_accounts_one_gbp_binding;
drop index social_accounts_publish_account_key;
-- A Google account can manage many clients. The destination, not the login,
-- is exclusive. Facebook retains its existing one-account rule.
create unique index social_accounts_publish_account_key on social_accounts(publish_provider,publish_account_id)
 where publish_account_id is not null and platform <> 'google_business';
create unique index social_accounts_gbp_location_key on social_accounts(external_account_id)
 where platform='google_business' and external_account_id is not null;

create or replace function publisher_bind_account(
  p_social_account_id uuid, p_account_id text, p_page_id text, p_account_name text, p_health jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a social_accounts;
  v_kind text;
begin
  if not (session_user = 'authenticator' and current_setting('role', true) = 'service_role') then
    raise exception 'Only the publisher binds a publishing account' using errcode = 'insufficient_privilege';
  end if;
  select * into a from social_accounts where id = p_social_account_id for update;
  if not found then raise exception 'No such social account' using errcode = 'no_data_found'; end if;
  if a.platform not in ('facebook', 'google_business') then
    raise exception 'Only Facebook Pages and Business Profile locations are published through Zernio' using errcode = 'check_violation';
  end if;
  if coalesce(p_account_id, '') !~ '^[0-9a-f]{24}$' then
    raise exception 'Not a Zernio account id' using errcode = 'check_violation';
  end if;
  if a.external_account_id is null or p_page_id is distinct from a.external_account_id then
    if a.platform = 'facebook' then
      raise exception 'The Zernio account posts to Page %, not this account''s Page %', p_page_id, a.external_account_id
        using errcode = 'check_violation';
    end if;
    raise exception 'The Zernio account posts to location %, not this account''s location %', p_page_id, a.external_account_id
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from social_accounts where publish_provider = 'zernio' and publish_account_id = p_account_id
             and id <> a.id and (a.platform <> 'google_business' or platform <> 'google_business')) then
    raise exception 'That Zernio account is already bound to another Compass account' using errcode = 'unique_violation';
  end if;

  v_kind := case when a.publish_account_id is null then 'bound'
                 when a.publish_account_id = p_account_id then 'verified'
                 else 'bound' end;
  perform set_config('compass.publish_binding', 'bind', true);
  update social_accounts set
    publish_provider = 'zernio',
    publish_account_id = p_account_id,
    publish_page_id = p_page_id,
    publish_account_name = nullif(btrim(coalesce(p_account_name, '')), ''),
    publish_verified_at = now(),
    publish_health = p_health,
    -- A different Zernio account starts switched off.
    publish_enabled = case when a.publish_account_id = p_account_id then a.publish_enabled else false end,
    publish_enabled_by = case when a.publish_account_id = p_account_id then a.publish_enabled_by else null end,
    publish_enabled_at = case when a.publish_account_id = p_account_id then a.publish_enabled_at else null end
  where id = a.id;
  perform set_config('compass.publish_binding', '', true);

  insert into social_account_publish_events (social_account_id, client_id, kind, actor_kind, detail)
  values (a.id, a.client_id, v_kind, 'publisher', jsonb_build_object(
    'provider', 'zernio', 'platform', a.platform, 'account_id', p_account_id, 'page_id', p_page_id,
    'previous_account_id', a.publish_account_id, 'health', p_health));
  return jsonb_build_object('social_account_id', a.id, 'kind', v_kind, 'account_id', p_account_id, 'page_id', p_page_id,
    'enabled', case when a.publish_account_id = p_account_id then a.publish_enabled else false end);
end $$;
revoke execute on function publisher_bind_account(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function publisher_bind_account(uuid, text, text, text, jsonb) to service_role;

-- Binds a client's Business Profile location to the Zernio googlebusiness
-- account the publisher just verified. The location row is the client's
-- social_accounts row for google_business with external_account_id =
-- `locations/<id>`; create a separate row for each destination. Existing
-- destinations remain bound. Never enables.
create or replace function publisher_bind_gbp_location(
  p_client_id uuid, p_account_id text, p_location_id text, p_location_name text, p_account_name text, p_health jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row uuid;
begin
  if not (session_user = 'authenticator' and current_setting('role', true) = 'service_role') then
    raise exception 'Only the publisher binds a publishing account' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from clients where id = p_client_id) then
    raise exception 'No such client' using errcode = 'no_data_found';
  end if;
  if coalesce(p_location_id, '') !~ '^locations/[0-9]{1,30}$' then
    raise exception 'Not a Business Profile location (locations/<id>)' using errcode = 'check_violation';
  end if;
  -- Serialize bindings for the same resource, including across clients/accounts.
  perform pg_advisory_xact_lock(hashtextextended(p_location_id, 0));
  if exists (select 1 from publisher_gbp_policies where client_id=p_client_id
             and p_location_id=any(excluded_locations)) then
    raise exception 'This Business Profile is excluded for this client' using errcode='check_violation';
  end if;
  if exists (select 1 from social_accounts where platform='google_business'
             and external_account_id=p_location_id and client_id<>p_client_id) then
    raise exception 'This Business Profile belongs to another client' using errcode='check_violation';
  end if;

  select id into v_row from social_accounts
   where client_id = p_client_id and platform = 'google_business' and external_account_id = p_location_id
   for update;
  if not found then
    insert into social_accounts (client_id, platform, external_account_id, display_name, status)
    values (p_client_id, 'google_business', p_location_id, nullif(btrim(coalesce(p_location_name, '')), ''), 'manual_only')
    returning id into v_row;
  end if;
  -- Binding a location is the explicit choice of Zernio for this client's
  -- Business Profile posts; it outlives the binding.
  perform publisher_record_gbp_transport(p_client_id, 'zernio', 'publisher', 'bind');
  return publisher_bind_account(v_row, p_account_id, p_location_id, p_account_name, p_health)
    || jsonb_build_object('client_id', p_client_id, 'location_id', p_location_id, 'gbp_transport', 'zernio');
end $$;
revoke execute on function publisher_bind_gbp_location(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function publisher_bind_gbp_location(uuid, text, text, text, text, jsonb) to service_role;


-- An approved social_account_id must never be repurposed to another location.
create function publisher_gbp_identity_guard() returns trigger
language plpgsql set search_path=public as $$
begin
 if old.platform='google_business' and
   (old.client_id,old.platform,old.external_account_id) is distinct from
   (new.client_id,new.platform,new.external_account_id) then
   raise exception 'A Business Profile destination is immutable; bind a separate profile and reopen the post' using errcode='check_violation';
 end if;
 return new;
end $$;
revoke execute on function publisher_gbp_identity_guard() from public,anon,authenticated;
create trigger publisher_gbp_identity_guard before update on social_accounts
 for each row execute function publisher_gbp_identity_guard();

-- Patch narrowly so concurrent claim/creative migrations keep their changes.
do $migration$
declare d text; old_block text; new_block text;
begin
 d:=pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
 if strpos(d,'drafter_gbp_destination_v1')=0 then raise exception 'Missing GBP drafter baseline'; end if;
 d:=replace(d, $old$elsif nullif(v_target->'social_account'->>'id', '') is not null then$old$,
 $new$elsif v_channel <> 'google_business' and nullif(v_target->'social_account'->>'id', '') is not null then$new$);
 old_block:=substring(d from strpos(d,'  -- drafter_gbp_destination_v1') for
 strpos(d,'  insert into drafter_runs (client_id, requested_via, requested_by, target, brief_version, brief_hash, brief,')-strpos(d,'  -- drafter_gbp_destination_v1'));
 new_block:=$block$
  -- drafter_gbp_destination_v2: explicit choice wins; never replace it.
  if v_channel='google_business' then
    v_account:=nullif(v_target->'social_account'->>'id','')::uuid;
    if v_account is null and not exists(select 1 from publisher_gbp_policies where client_id=v_client and require_explicit)
       and (select count(*) from social_accounts where client_id=v_client and platform='google_business'
            and publish_provider='zernio' and publish_verified_at is not null)=1 then
      select id into v_account from social_accounts where client_id=v_client and platform='google_business'
       and publish_provider='zernio' and publish_verified_at is not null for share;
    end if;
    if v_account is not null and not exists(select 1 from social_accounts where id=v_account and client_id=v_client
        and platform='google_business' and publish_provider='zernio' and publish_verified_at is not null
        and publish_page_id=external_account_id) then
      raise exception 'Select a verified Business Profile destination belonging to this client' using errcode='check_violation';
    end if;
    if v_account is null and (exists(select 1 from publisher_gbp_policies where client_id=v_client and require_explicit)
      or exists(select 1 from publisher_client_transports where client_id=v_client and gbp_transport='zernio')) then
      raise exception 'Select an explicit verified location binding for this Business Profile draft' using errcode='check_violation';
    end if;
  end if;

$block$;
 if length(old_block)=0 then raise exception 'Unexpected drafter binding block'; end if;
 d:=replace(d,old_block,'');
 if strpos(d,'  -- Claims: only ones the brief allowed.')=0 then raise exception 'Unexpected drafter claims anchor'; end if;
 d:=replace(d,'  -- Claims: only ones the brief allowed.',new_block || '  -- Claims: only ones the brief allowed.');
 -- Same concept may have distinct approved destinations, but no duplicate
 -- open draft on the same destination. Legacy null-destination behavior stays.
 d:=replace(d, $old$and platform::text = v_target->>'channel' and service_id is not distinct from v_service$old$,
 $new$and platform::text = v_target->>'channel' and social_account_id is not distinct from v_account and service_id is not distinct from v_service$new$);
 execute d;

 d:=pg_get_functiondef('public.social_post_grounding_problems(public.social_posts)'::regprocedure);
 if strpos(d,'  return v_problems;')=0 then raise exception 'Unexpected grounding function'; end if;
 execute replace(d,'  return v_problems;', $guard$
  if p.platform='google_business' then
    if p.social_account_id is null and (exists(select 1 from publisher_gbp_policies where client_id=p.client_id and require_explicit)
       or (select count(*) from social_accounts where client_id=p.client_id and platform='google_business' and publish_provider='zernio')>1) then
      v_problems:=v_problems || 'Choose an explicit verified Business Profile destination before review.'::text;
    elsif p.social_account_id is not null and not exists(select 1 from social_accounts a
       where a.id=p.social_account_id and a.client_id=p.client_id and a.platform='google_business'
         and a.publish_provider='zernio' and a.publish_verified_at is not null and a.publish_page_id=a.external_account_id
         and not exists(select 1 from publisher_gbp_policies pol where pol.client_id=p.client_id and a.external_account_id=any(pol.excluded_locations))) then
      v_problems:=v_problems || 'The selected Business Profile is missing, unverified, excluded or belongs to another client.'::text;
    end if;
  end if;
  return v_problems;
$guard$);
end $migration$;
