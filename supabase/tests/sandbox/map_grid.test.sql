begin;
insert into public.clients(id,name) values ('90000000-0000-4000-a000-000000000001','Grid Test');
insert into public.locations(id,client_id,name) values ('90000000-0000-4000-a000-000000000002','90000000-0000-4000-a000-000000000001','Home');
insert into public.keywords(id,client_id,keyword) values ('90000000-0000-4000-a000-000000000003','90000000-0000-4000-a000-000000000001','roofer');
insert into public.grid_configs(id,location_id) values ('90000000-0000-4000-a000-000000000004','90000000-0000-4000-a000-000000000002');
insert into public.map_grid_profiles(id,client_id,grid_config_id,label,target_place_id,points,keywords,enabled)
values ('90000000-0000-4000-a000-000000000005','90000000-0000-4000-a000-000000000001','90000000-0000-4000-a000-000000000004','test','ChIJtestplace','[{"lat":38,"lng":-90},{"lat":38.1,"lng":-90}]','[{"id":"90000000-0000-4000-a000-000000000003","keyword":"roofer"}]',true);
do $$declare r uuid;begin
 update public.map_grid_profiles set search_this_area=false where id='90000000-0000-4000-a000-000000000005';
 r:=public.map_grid_start('90000000-0000-4000-a000-000000000005','same');
 update public.map_grid_profiles set search_this_area=true where id='90000000-0000-4000-a000-000000000005';
 if (select config->'search_this_area' from public.map_grid_runs where id=r)<>'false'::jsonb then raise exception 'search mode history changed';end if;
 if r<>public.map_grid_start('90000000-0000-4000-a000-000000000005','same') then raise exception 'idempotency failed';end if;
 if (select count(*) from public.map_grid_checks where run_id=r)<>2 then raise exception 'fanout failed';end if;
 begin perform public.map_grid_start('90000000-0000-4000-a000-000000000005','other');raise exception 'duplicate allowed';exception when raise_exception then if sqlerrm='duplicate allowed' then raise;end if;end;
 update public.map_grid_runs set status='complete' where id=r;
 begin perform public.map_grid_start('90000000-0000-4000-a000-000000000005','other');raise exception 'cooldown failed';exception when raise_exception then if sqlerrm='cooldown failed' then raise;end if;end;
 if has_function_privilege('authenticated','public.map_grid_start(uuid,text)','execute') or has_function_privilege('anon','public.map_grid_start(uuid,text)','execute') then raise exception 'start publicly executable';end if;
 if has_table_privilege('authenticated','public.map_grid_profiles','update') then raise exception 'profile writable';end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000001',true);
do $$begin if (select count(*) from public.map_grid_profiles)<>1 then raise exception 'team read failed';end if;end $$;
select set_config('request.jwt.claim.sub','99999999-0000-4000-a000-000000000099',true);
do $$begin
 if exists(select 1 from public.map_grid_profiles) or exists(select 1 from public.map_grid_runs) or exists(select 1 from public.map_grid_checks) then raise exception 'non-team data leaked';end if;
end $$;
reset role;
rollback;
