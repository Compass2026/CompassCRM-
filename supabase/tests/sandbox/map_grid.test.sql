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
 -- Dense geometry: the next run freezes it, the legacy run keeps no geometry, and a later edit never reaches history.
 update public.map_grid_runs set started_at=now()-interval '2 hours' where id=r;
 update public.map_grid_profiles set geometry='{"version":"local-multiscale-v1","center":{"lat":38,"lng":-90},"tiers":[{"max_miles":5,"spacing_miles":1}],"radii_miles":[5],"default_radius_miles":5,"point_count":2}' where id='90000000-0000-4000-a000-000000000005';
 declare d uuid:=public.map_grid_start('90000000-0000-4000-a000-000000000005','dense');begin
  if (select config->'geometry'->>'version' from public.map_grid_runs where id=d)<>'local-multiscale-v1' then raise exception 'geometry not frozen';end if;
  if (select coalesce(config->'geometry','null'::jsonb) from public.map_grid_runs where id=r)<>'null'::jsonb then raise exception 'legacy run gained geometry';end if;
  update public.map_grid_profiles set geometry=jsonb_set(geometry,'{center,lat}','38.5') where id='90000000-0000-4000-a000-000000000005';
  if (select config->'geometry'->'center'->>'lat' from public.map_grid_runs where id=d)<>'38' then raise exception 'frozen geometry changed';end if;
  update public.map_grid_runs set status='complete' where id=d;
 end;
 -- Empty, incomplete or inconsistent metadata is refused; the validator never answers NULL (which a CHECK would accept).
 declare v jsonb:='{"version":"local-multiscale-v1","center":{"lat":38,"lng":-90},"tiers":[{"max_miles":5,"spacing_miles":1}],"radii_miles":[5],"default_radius_miles":5,"point_count":2}';bad jsonb;begin
  if public.map_grid_geometry_valid(v,2) is not true then raise exception 'valid geometry refused';end if;
  if public.map_grid_geometry_valid(null,2) is not true then raise exception 'legacy null geometry refused';end if;
  foreach bad in array array['{}'::jsonb,'[]','"geometry"','5',
    v-'version',v-'center',v-'tiers',v-'radii_miles',v-'default_radius_miles',v-'point_count',
    jsonb_set(v,'{version}','"other"'),jsonb_set(v,'{center,lat}','"38"'),jsonb_set(v,'{center,lat}','95'),jsonb_set(v,'{center}','{}'),
    jsonb_set(v,'{tiers}','[]'),jsonb_set(v,'{tiers}','[{}]'),jsonb_set(v,'{tiers}','[{"max_miles":5}]'),jsonb_set(v,'{tiers}','[{"max_miles":5,"spacing_miles":0}]'),
    jsonb_set(v,'{tiers}','[{"max_miles":5,"spacing_miles":6}]'),jsonb_set(v,'{tiers}','[{"max_miles":"5","spacing_miles":1}]'),
    jsonb_set(jsonb_set(v,'{tiers}','[{"max_miles":2,"spacing_miles":1},{"max_miles":2,"spacing_miles":1}]'),'{radii_miles}','[2,2]'),
    jsonb_set(v,'{radii_miles}','[4]'),jsonb_set(v,'{radii_miles}','[5,5]'),jsonb_set(v,'{radii_miles}','{}'),jsonb_set(v,'{default_radius_miles}','3'),jsonb_set(v,'{default_radius_miles}','"5"'),
    jsonb_set(v,'{point_count}','3'),jsonb_set(v,'{point_count}','"2"')] loop
   if public.map_grid_geometry_valid(bad,2) is not false then raise exception 'geometry validator did not refuse %',bad;end if;
   begin update public.map_grid_profiles set geometry=bad where id='90000000-0000-4000-a000-000000000005';raise exception 'invalid geometry stored: %',bad;exception when check_violation then null;end;
  end loop;
  update public.map_grid_profiles set geometry=null where id='90000000-0000-4000-a000-000000000005';
  update public.map_grid_profiles set geometry=v where id='90000000-0000-4000-a000-000000000005';
 end;
 -- Budget guard: 153 dense points x 7 keywords exceeds 1,000 checks.
 begin update public.map_grid_profiles set geometry=null,points=(select jsonb_agg(jsonb_build_object('lat',38+g/1000.0,'lng',-90)) from generate_series(1,153) g),keywords=(select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'keyword','k'||g)) from generate_series(1,7) g) where id='90000000-0000-4000-a000-000000000005';raise exception 'check budget exceeded';exception when check_violation then null;end;
 if has_function_privilege('authenticated','public.map_grid_start(uuid,text)','execute') or has_function_privilege('anon','public.map_grid_start(uuid,text)','execute') then raise exception 'start publicly executable';end if;
 if has_table_privilege('authenticated','public.map_grid_profiles','update') then raise exception 'profile writable';end if;
 -- Weekly start outcomes: durable, constrained, service-only writes.
 insert into public.map_grid_weekly_attempts(profile_id,request_key,outcome,run_id) values('90000000-0000-4000-a000-000000000005','weekly:2026-10-15','started',r);
 insert into public.map_grid_weekly_attempts(profile_id,request_key,outcome,message) values('90000000-0000-4000-a000-000000000005','weekly:2026-10-15','error','Grid keyword mismatch');
 begin insert into public.map_grid_weekly_attempts(profile_id,request_key,outcome) values('90000000-0000-4000-a000-000000000005','weekly:x','skipped');raise exception 'unknown outcome stored';exception when check_violation then null;end;
 begin insert into public.map_grid_weekly_attempts(profile_id,request_key,outcome,message) values('90000000-0000-4000-a000-000000000005','weekly:x','error',repeat('x',501));raise exception 'unbounded message stored';exception when check_violation then null;end;
 if has_table_privilege('authenticated','public.map_grid_weekly_attempts','insert') or has_table_privilege('authenticated','public.map_grid_weekly_attempts','update')
   or has_table_privilege('authenticated','public.map_grid_weekly_attempts','delete') or has_table_privilege('anon','public.map_grid_weekly_attempts','select') then raise exception 'weekly attempts writable or public';end if;
 if not (select relrowsecurity from pg_class where oid='public.map_grid_weekly_attempts'::regclass) then raise exception 'weekly attempts without RLS';end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000001',true);
do $$begin if (select count(*) from public.map_grid_profiles)<>1 then raise exception 'team read failed';end if;
 if (select count(*) from public.map_grid_weekly_attempts)<>2 then raise exception 'team cannot read weekly attempts';end if;end $$;
select set_config('request.jwt.claim.sub','99999999-0000-4000-a000-000000000099',true);
do $$begin
 if exists(select 1 from public.map_grid_profiles) or exists(select 1 from public.map_grid_runs) or exists(select 1 from public.map_grid_checks)
   or exists(select 1 from public.map_grid_weekly_attempts) then raise exception 'non-team data leaked';end if;
end $$;
reset role;
rollback;
