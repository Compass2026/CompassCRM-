-- Also executed with PGlite against the same real migration, using synthetic fixtures.
begin;
insert into client_brand_workspaces(id,client_id,slug,name,website_url,phone)
values('00000000-0000-4000-9000-00000000000b','00000000-0000-4000-b000-00000000000b','rollout-test','Rollout Brand B','https://b.example.test','5555555555');
create schema rollout_test;
grant usage on schema rollout_test to authenticated,anon,service_role;
create function rollout_test.save(v int,s text,overrides jsonb default '{}') returns void
language plpgsql security invoker set search_path=public,pg_temp as $$
declare r jsonb; begin
 r:=jsonb_build_object('client_id','00000000-0000-4000-b000-00000000000a','brand_workspace_id',null,'version',v,'standard_version','1.0','stage',s,
 'requirements',current_setting('test.rollout_req')::jsonb,'scope_ref','Agreed scope','configuration_ref','Configuration receipt','pilot_ref','Publication plus measurement',
 'owner','Test owner','next_action','Review next cycle','reason','Fictional proof','critical_clear',true,'accepted',true,
 'cycle_one_start',current_date-21,'cycle_two_start',current_date-14,'cycle_one_ref','First cycle','cycle_two_ref','Second cycle')||overrides;
 insert into agency_rollout_reviews(client_id,brand_workspace_id,version,standard_version,stage,requirements,scope_ref,configuration_ref,pilot_ref,owner,next_action,reason,critical_clear,accepted,cycle_one_start,cycle_two_start,cycle_one_ref,cycle_two_ref,reviewed_by,reviewed_at)
 select client_id,brand_workspace_id,version,standard_version,stage,requirements,scope_ref,configuration_ref,pilot_ref,owner,next_action,reason,critical_clear,accepted,cycle_one_start,cycle_two_start,cycle_one_ref,cycle_two_ref,reviewed_by,reviewed_at
 from jsonb_populate_record(null::agency_rollout_reviews,r);
end $$;
create function rollout_test.refuse(statement text,expected_state text) returns void language plpgsql security invoker as $$
begin
 begin execute statement;
 exception when others then
  if sqlstate<>expected_state then raise exception 'Expected %, got %: %',expected_state,sqlstate,sqlerrm; end if;
  return;
 end;
 raise exception 'Unsafe action accepted: %',statement;
end $$;
select set_config('test.rollout_req',(select jsonb_agg(jsonb_build_object('key',k,'applicability',case when k='intelligence' then 'required' else 'excluded' end,
 'state','current','evidence_ref','Synthetic receipt','checked_at',now()-interval '1 hour','valid_until',now()+interval '1 day','period','Current cycle','reason','Agreed scope','review_trigger','Scope renewal','owner','Test owner','next_action','Next review'))
 from unnest(array['intelligence','gsc','ga4','gbp','rankings','backlinks','engine','workflow','website','blogs','facebook','instagram','gbp_publish']) k)::text,true);
-- SQL worker cannot impersonate a human with a role/JWT.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000001',true);
select rollout_test.refuse($q$select rollout_test.save(1,'scoped')$q$,'42501');
reset role;
set session authorization authenticator;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000001',true);
select rollout_test.refuse($q$select rollout_test.save(1,'pilot')$q$,'23514');
select rollout_test.refuse($q$select rollout_test.save(1,'scoped','{"brand_workspace_id":"00000000-0000-4000-9000-00000000000b"}')$q$,'23514');
select rollout_test.save(1,'scoped','{"reviewed_at":"2099-01-01","reviewed_by":"00000000-0000-4000-9000-00000000000b"}');
do $$ begin
 if (select count(*) from agency_rollout_reviews)<>1 then raise exception 'initial review not saved'; end if;
 if exists(select 1 from agency_rollout_reviews r where r.reviewed_at>now() or not exists(select 1 from team_members t where t.id=r.reviewed_by and t.auth_user_id=auth.uid())) then raise exception 'reviewer or time forged'; end if;
end $$;
select rollout_test.refuse($q$select rollout_test.save(1,'scoped')$q$,'40001');
select rollout_test.refuse($q$update agency_rollout_reviews set stage='operating'$q$,'42501');
select rollout_test.refuse($q$delete from agency_rollout_reviews$q$,'42501');
select rollout_test.save(2,'configured');
select rollout_test.refuse($q$select rollout_test.save(3,'ready','{"critical_clear":false}')$q$,'23514');
select rollout_test.refuse($q$select rollout_test.save(3,'ready',jsonb_build_object('requirements',jsonb_set(current_setting('test.rollout_req')::jsonb,'{0,valid_until}',to_jsonb((now()-interval '1 minute')::text))))$q$,'23514');
select rollout_test.save(3,'ready');
select rollout_test.refuse($q$select rollout_test.save(4,'pilot','{"scope_ref":"New scope"}')$q$,'23514');
select rollout_test.save(4,'pilot');
select rollout_test.refuse($q$select rollout_test.save(5,'operating','{"accepted":false}')$q$,'23514');
select rollout_test.refuse($q$select rollout_test.save(5,'operating',jsonb_build_object('cycle_two_start',current_date))$q$,'23514');
-- This native fixture's primary team user is admin.
select rollout_test.save(5,'operating');
-- Current incident changes health, preserves the accepted historical stage.
select rollout_test.save(6,'operating',jsonb_build_object('requirements',jsonb_set(current_setting('test.rollout_req')::jsonb,'{0,state}','"blocked"')));
-- A changed scope must return to a configuration gate.
select rollout_test.save(7,'configured','{"scope_ref":"New scope"}');
do $$ begin if (select count(*) from agency_rollout_reviews)<>7 then raise exception 'review history lost'; end if; end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000011',true);
do $$ begin if exists(select 1 from agency_rollout_reviews) then raise exception 'portal read private rollout'; end if; end $$;
select rollout_test.refuse($q$select rollout_test.save(8,'configured')$q$,'42501');
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000014',true);
do $$ begin if exists(select 1 from agency_rollout_reviews) then raise exception 'stranger read private rollout'; end if; end $$;
reset role;
set local role anon;
select rollout_test.refuse($q$select * from agency_rollout_reviews$q$,'42501');
reset role;
reset session authorization;
do $$ begin
 if has_table_privilege('service_role','agency_rollout_reviews','INSERT') or has_table_privilege('authenticated','agency_rollout_reviews','DELETE') then raise exception 'excessive grants'; end if;
end $$;
rollback;
