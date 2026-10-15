-- Reviewed agency rollout snapshots. Never activate marketing or supporting systems.
-- Every edit appends history, bound to an expected per-client/brand version.
create table public.agency_rollout_reviews (
 id uuid primary key default gen_random_uuid(),
 client_id uuid not null references public.clients(id),
 brand_workspace_id uuid references public.client_brand_workspaces(id),
 version integer not null check(version>0),
 standard_version text not null default '1.0' check(standard_version='1.0'),
 stage text not null check(stage in ('unassessed','scoped','configured','ready','pilot','operating')),
 requirements jsonb not null check(jsonb_typeof(requirements)='array' and jsonb_array_length(requirements)=13),
 scope_ref text not null default '', configuration_ref text not null default '', pilot_ref text not null default '',
 cycle_one_start date, cycle_one_ref text not null default '', cycle_two_start date, cycle_two_ref text not null default '',
 owner text not null check(length(btrim(owner)) between 1 and 200),
 next_action text not null check(length(btrim(next_action)) between 1 and 2000),
 reason text not null check(length(btrim(reason)) between 1 and 2000),
 critical_clear boolean not null default false, accepted boolean not null default false,
 reviewed_by uuid not null references public.team_members(id), reviewed_at timestamptz not null default now(),
 check(length(scope_ref)<=2000 and length(configuration_ref)<=2000 and length(pilot_ref)<=2000 and length(cycle_one_ref)<=2000 and length(cycle_two_ref)<=2000)
);
create unique index agency_rollout_review_version on public.agency_rollout_reviews
 (client_id,coalesce(brand_workspace_id,'00000000-0000-0000-0000-000000000000'::uuid),version);
create index agency_rollout_brand_idx on public.agency_rollout_reviews(brand_workspace_id);
create index agency_rollout_reviewer_idx on public.agency_rollout_reviews(reviewed_by);
alter table public.agency_rollout_reviews enable row level security;
create policy "team rollout reviews" on public.agency_rollout_reviews to authenticated
 using ((select public.is_team())) with check ((select public.is_team()));
revoke all on public.agency_rollout_reviews from public,anon,authenticated,service_role;
grant select,insert on public.agency_rollout_reviews to authenticated;
grant select on public.agency_rollout_reviews to service_role;

create function public.agency_rollout_review_guard() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
declare prior public.agency_rollout_reviews; r jsonb; k text; actor uuid;
 stage_rank int; prior_rank int; keys text[]:=array['intelligence','gsc','ga4','gbp','rankings','backlinks','engine','workflow','website','blogs','facebook','instagram','gbp_publish'];
 stages text[]:=array['unassessed','scoped','configured','ready','pilot','operating'];
begin
 if tg_op<>'INSERT' then raise exception 'Rollout history is immutable; append another review.' using errcode='23514'; end if;
 if session_user<>'authenticator' or current_user<>'authenticated' or auth.uid() is null or not public.is_team() then
  raise exception 'Only a signed-in teammate can record a rollout review.' using errcode='42501';
 end if;
 select id into actor from public.team_members where auth_user_id=auth.uid();
 new.reviewed_by:=actor; new.reviewed_at:=now();
 if not exists(select 1 from public.clients where id=new.client_id and status in ('active','launching')) then
  raise exception 'Only an active or launching client can be reviewed.' using errcode='23514'; end if;
 if new.brand_workspace_id is not null and not exists(select 1 from public.client_brand_workspaces where id=new.brand_workspace_id and client_id=new.client_id) then
  raise exception 'Brand does not belong to this client.' using errcode='23514'; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.client_id::text||coalesce(new.brand_workspace_id::text,'parent'),0));
 select * into prior from public.agency_rollout_reviews where client_id=new.client_id and brand_workspace_id is not distinct from new.brand_workspace_id order by version desc limit 1;
 if new.version<>coalesce(prior.version,0)+1 then raise exception 'This review changed. Reload before saving.' using errcode='40001'; end if;
 if jsonb_typeof(new.requirements)<>'array' or jsonb_array_length(new.requirements)<>13 or
  (select count(distinct x->>'key') from jsonb_array_elements(new.requirements) x)<>13 then
  raise exception 'Review every requirement exactly once.' using errcode='23514'; end if;
 for r in select * from jsonb_array_elements(new.requirements) loop
  if jsonb_typeof(r)<>'object' or not coalesce((r->>'key')=any(keys),false) or
   not coalesce((r->>'applicability') in ('unknown','required','optional','excluded'),false) or
   not coalesce((r->>'state') in ('current','attention','blocked','unknown'),false) then
   raise exception 'Invalid requirement scope or state.' using errcode='23514'; end if;
  foreach k in array array['key','applicability','state','evidence_ref','checked_at','valid_until','period','reason','review_trigger','owner','next_action'] loop
   if jsonb_typeof(r->k) is distinct from 'string' or length(r->>k)>2000 then raise exception 'Invalid requirement field: %',k using errcode='23514'; end if;
  end loop;
  if r->>'applicability' in ('optional','excluded') and
   (btrim(r->>'reason')='' or btrim(r->>'evidence_ref')='' or btrim(r->>'review_trigger')='') then
   raise exception 'Scope exceptions require reason, decision evidence and review trigger.' using errcode='23514'; end if;
  if r->>'applicability'='required' and (btrim(r->>'owner')='' or btrim(r->>'next_action')='') then
   raise exception 'Required items need an owner and next action.' using errcode='23514'; end if;
  if r->>'state'='current' then
   if btrim(r->>'evidence_ref')='' or coalesce(r->>'checked_at','')='' or coalesce(r->>'valid_until','')='' then
    raise exception 'Current evidence needs reference, check time and review expiry.' using errcode='23514'; end if;
   if not isfinite((r->>'checked_at')::timestamptz) or not isfinite((r->>'valid_until')::timestamptz) or
    (r->>'checked_at')::timestamptz>now() or (r->>'valid_until')::timestamptz<(r->>'checked_at')::timestamptz then
    raise exception 'Invalid current evidence dates.' using errcode='23514'; end if;
  end if;
 end loop;
 stage_rank:=array_position(stages,new.stage); prior_rank:=coalesce(array_position(stages,prior.stage),1);
 if prior_rank>=4 and stage_rank>=4 and (new.scope_ref<>prior.scope_ref or exists(
  select 1 from jsonb_array_elements(new.requirements) x join jsonb_array_elements(prior.requirements) p on x->>'key'=p->>'key'
  where x->>'applicability'<>p->>'applicability')) then
  raise exception 'Scope changed. Return to Configured or earlier and reverify.' using errcode='23514'; end if;
 if stage_rank>prior_rank+1 then raise exception 'Advance one stage at a time.' using errcode='23514'; end if;
 if stage_rank>=2 and (btrim(new.scope_ref)='' or exists(select 1 from jsonb_array_elements(new.requirements) x where x->>'applicability'='unknown') or
  not exists(select 1 from jsonb_array_elements(new.requirements) x where x->>'applicability'='required')) then
  raise exception 'Scoped requires agreed scope and explicit applicability decisions.' using errcode='23514'; end if;
 if stage_rank>=3 and btrim(new.configuration_ref)='' then raise exception 'Configuration evidence required.' using errcode='23514'; end if;
 if stage_rank>prior_rank and stage_rank>=4 then
  if not new.critical_clear then raise exception 'Review unresolved critical marketing incidents before advancing.' using errcode='23514'; end if;
  for r in select * from jsonb_array_elements(new.requirements) loop
   if r->>'applicability'='required' and (r->>'state'<>'current' or (r->>'valid_until')::timestamptz<now()) then
    raise exception 'Required evidence must be current to advance.' using errcode='23514'; end if;
  end loop;
 end if;
 if stage_rank>=5 and btrim(new.pilot_ref)='' then raise exception 'Full pilot-cycle evidence required.' using errcode='23514'; end if;
 if stage_rank>=6 then
  if new.cycle_one_start is null or new.cycle_two_start is null or not isfinite(new.cycle_one_start) or not isfinite(new.cycle_two_start) or
   new.cycle_two_start-new.cycle_one_start<>7 or new.cycle_two_start+7>(now() at time zone 'America/Chicago')::date or
   btrim(new.cycle_one_ref)='' or btrim(new.cycle_two_ref)='' or not new.accepted then
   raise exception 'Operating requires two consecutive completed weekly cycles and explicit acceptance.' using errcode='23514'; end if;
  if stage_rank>prior_rank and not public.is_team_admin() then raise exception 'An admin must accept Operating.' using errcode='42501'; end if;
 end if;
 return new;
end $$;
revoke all on function public.agency_rollout_review_guard() from public,anon,authenticated,service_role;
create trigger agency_rollout_review_guard before insert or update or delete on public.agency_rollout_reviews
 for each row execute function public.agency_rollout_review_guard();
comment on table public.agency_rollout_reviews is 'Team-reviewed operating standard snapshots; historical stage is separate from current health. No publishing, billing, SMS, portal or worker activation.';
