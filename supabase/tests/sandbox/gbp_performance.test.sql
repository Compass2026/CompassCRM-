begin;
-- Use a real PostgREST-shaped service session, never a caller-supplied role claim.
set session authorization authenticator;
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
select publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000a','eeeeeeeeeeeeeeeeeeeeeee1','locations/1234567890','A','A','{}');
do $$ declare payload jsonb:='{"values":{"gbp_views":120,"gbp_clicks":30,"gbp_call_clicks":0,"gbp_directions":12},"daily":{}}'; r jsonb; begin
 r:=gbp_performance_record('00000000-0000-4000-b000-00000000000a','eeeeeeeeeeeeeeeeeeeeeee1','locations/1234567890','2026-08-01','2026-08-31',payload);
 if r->>'status'<>'imported' then raise exception 'import missing'; end if;
 r:=gbp_performance_record('00000000-0000-4000-b000-00000000000a','eeeeeeeeeeeeeeeeeeeeeee1','locations/1234567890','2026-08-01','2026-08-31',payload);
 if r->>'status'<>'unchanged' then raise exception 'retry duplicated'; end if;
 begin
  perform gbp_performance_record('00000000-0000-4000-b000-00000000000b','eeeeeeeeeeeeeeeeeeeeeee1','locations/1234567890','2026-08-01','2026-08-31',payload);
  raise exception 'foreign client accepted'; exception when check_violation then null; end;
 begin
  perform gbp_performance_record('00000000-0000-4000-b000-00000000000a','eeeeeeeeeeeeeeeeeeeeeee1','locations/999','2026-08-01','2026-08-31',payload);
  raise exception 'foreign location accepted'; exception when check_violation then null; end;
 begin
  perform gbp_performance_record('00000000-0000-4000-b000-00000000000a','eeeeeeeeeeeeeeeeeeeeeee1','locations/1234567890','2026-08-01','2026-08-30',payload);
  raise exception 'partial month accepted'; exception when check_violation then null; end;
 perform gbp_performance_record('00000000-0000-4000-b000-00000000000a','eeeeeeeeeeeeeeeeeeeeeee1','locations/1234567890','2026-08-01','2026-08-31',jsonb_set(payload,'{values,gbp_clicks}','31'));
 if (select count(*) from report_measurements where source='Google Business Profile via Zernio')<>8 then raise exception 'correction lost or retry duplicated'; end if;
 if (select value from report_measurements where source='Google Business Profile via Zernio' and metric='gbp_clicks' order by sequence limit 1)<>30 then raise exception 'baseline overwritten'; end if;
end $$;
reset role;
reset session authorization;
set session authorization postgres;
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000011',true);
do $$ begin
 if (select count(*) from portal_growth_measurements where source='Google Business Profile via Zernio')<>8 then raise exception 'portal missing own metrics'; end if;
 if exists(select 1 from gbp_performance_imports) or exists(select 1 from gbp_performance_sync_runs) then raise exception 'portal exposed internal imports'; end if;
 if has_function_privilege('authenticated','public.gbp_performance_record(uuid,text,text,date,date,jsonb)','execute') then raise exception 'portal can import'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000012',true);
do $$ begin
 if exists(select 1 from portal_growth_measurements where source='Google Business Profile via Zernio') then raise exception 'foreign metrics leaked'; end if;
end $$;
reset role;
do $$ begin
 begin perform gbp_performance_record(null,null,null,null,null,null); raise exception 'worker bypassed service boundary'; exception when insufficient_privilege then null; end;
end $$;
rollback;
