-- Full migration replay + shared fixtures; every write rolls back.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
insert into keywords(id,client_id,keyword,is_tracked) values
 ('00000000-0000-4000-d000-00000000002a','00000000-0000-4000-b000-00000000000a','awaiting check',true);
insert into locations(id,client_id,name,city,state) values
 ('00000000-0000-4000-c000-00000000002a','00000000-0000-4000-b000-00000000000a','A nearby','Nearby','MO');
insert into rank_snapshots(keyword_id,location_id,result_type,position,recorded_at,source) values
 ('00000000-0000-4000-d000-00000000000a','00000000-0000-4000-c000-00000000002a','organic',2,now()-interval '1 day','dataforseo'),
 ('00000000-0000-4000-d000-00000000000a','00000000-0000-4000-c000-00000000000a','map_pack',3,now()-interval '2 days','dataforseo'),
 ('00000000-0000-4000-d000-00000000000a','00000000-0000-4000-c000-00000000000a','map_pack',null,now()-interval '1 day','dataforseo'),
 ('00000000-0000-4000-d000-00000000000a','00000000-0000-4000-c000-00000000000a','organic',1,now()+interval '1 day','dataforseo');
do $$ begin
 if (select count(distinct keyword_id) from client_growth_rankings where client_id='00000000-0000-4000-b000-00000000000a')<>2 then raise exception 'tracked total excluded unchecked or included untracked'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a plumber' and location_name='A home' and result_type='organic' and first_position=9 and position=5 and previous_position=9) then raise exception 'source, future date or first/latest comparison wrong'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a plumber' and location_name='A nearby' and first_position=2 and position=2) then raise exception 'location comparison conflated'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a plumber' and result_type='map_pack' and first_position=3 and position is null and previous_position=3) then raise exception 'null latest replaced with historic found rank'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='awaiting check' and checked_at is null and result_type is null) then raise exception 'unchecked keyword missing'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000011',true);
do $$ begin
 if (select count(*) from portal_growth_rankings)<>4 then raise exception 'portal A own rows missing'; end if;
 if exists(select 1 from portal_growth_rankings where client_id<>'00000000-0000-4000-b000-00000000000a') then raise exception 'foreign ranking exposed'; end if;
 if exists(select 1 from client_growth_rankings) then raise exception 'portal accessed team rankings'; end if;
 begin
  update portal_growth_rankings set keyword='forged';
  raise exception 'portal wrote to rankings';
 exception when insufficient_privilege or object_not_in_prerequisite_state then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000012',true);
do $$ begin
 if (select count(*) from portal_growth_rankings)<>1 or exists(select 1 from portal_growth_rankings where client_id<>'00000000-0000-4000-b000-00000000000b') then raise exception 'portal B isolation failed'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000013',true);
do $$ begin if exists(select 1 from portal_growth_rankings) then raise exception 'former portal contact exposed'; end if; end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000014',true);
do $$ begin if exists(select 1 from portal_growth_rankings) then raise exception 'stranger exposed'; end if; end $$;
set local role anon;
do $$ begin
 begin perform * from portal_growth_rankings; raise exception 'anon access'; exception when insufficient_privilege then null; end;
end $$;
rollback;
