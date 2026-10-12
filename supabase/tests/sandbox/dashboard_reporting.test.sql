begin;
-- Superuser fixture loading only; production import calls use service identity.
reset role;
reset session authorization;
set session authorization supabase_admin;
update clients set gsc_property='sc-domain:a.example.test' where id='00000000-0000-4000-b000-00000000000a';
set local session_replication_role=replica;
insert into social_posts(client_id,platform,search_intent,copy,publish_status,published_at,published_url,review_status,reviewed_by,reviewed_at,approved_snapshot,approved_hash,external_post_id) values
 ('00000000-0000-4000-b000-00000000000a','facebook','commercial','PRIVATE copy','published','2026-09-02T03:00:00Z','https://facebook.com/example','approved','00000000-0000-4000-a000-000000000001',now(),'{}','fixture','fixture'),
 ('00000000-0000-4000-b000-00000000000a','google_business','commercial','PRIVATE draft','not_scheduled',null,null,'draft',null,null,null,null,null),
 ('00000000-0000-4000-b000-00000000000b','google_business','commercial','PRIVATE foreign','published','2026-09-02T03:00:00Z','https://maps.google.com/example','approved','00000000-0000-4000-a000-000000000001',now(),'{}','fixture','fixture');
set local session_replication_role=origin;
set session authorization authenticator;
set role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
do $$ declare payload jsonb:='{"aggregation":"byProperty","search_type":"web","values":{"search_clicks":12,"search_impressions":120}}'; r jsonb; begin
 r:=gsc_performance_record('00000000-0000-4000-b000-00000000000a','sc-domain:a.example.test','2026-08-01','2026-08-31',payload);
 if r->>'status'<>'imported' then raise exception 'missing import'; end if;
 r:=gsc_performance_record('00000000-0000-4000-b000-00000000000a','sc-domain:a.example.test','2026-08-01','2026-08-31',payload);
 if r->>'status'<>'unchanged' then raise exception 'duplicate retry'; end if;
 begin perform gsc_performance_record('00000000-0000-4000-b000-00000000000b','sc-domain:a.example.test','2026-08-01','2026-08-31',payload); raise exception 'foreign client accepted'; exception when check_violation then null; end;
 begin perform gsc_performance_record('00000000-0000-4000-b000-00000000000a','sc-domain:a.example.test','2026-08-01','2026-08-30',payload); raise exception 'partial month accepted'; exception when check_violation then null; end;
 begin perform gsc_performance_record('00000000-0000-4000-b000-00000000000a','sc-domain:a.example.test','2026-08-01','2026-08-31',jsonb_set(payload,'{values,search_clicks}','-1')); raise exception 'negative accepted'; exception when check_violation then null; end;
 perform gsc_performance_record('00000000-0000-4000-b000-00000000000a','sc-domain:a.example.test','2026-08-01','2026-08-31',jsonb_set(payload,'{values,search_clicks}','13'));
 if (select count(*) from report_measurements where source='Google Search Console property totals')<>4 then raise exception 'correction/retry failed'; end if;
 if (select value from report_measurements where source='Google Search Console property totals' and metric='search_clicks' order by sequence limit 1)<>12 then raise exception 'baseline changed'; end if;
end $$;
reset role;
reset session authorization;
set session authorization postgres;
set role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000011',true);
do $$ begin
 if (select count(*) from portal_growth_measurements where source='Google Search Console property totals')<>4 then raise exception 'own metrics missing'; end if;
 if exists(select 1 from gsc_performance_imports) or exists(select 1 from gsc_performance_sync_runs) then raise exception 'internal import exposed'; end if;
 if not exists(select 1 from portal_growth_work where kind='social' and published_on='2026-09-01') then raise exception 'social/date missing'; end if;
 if exists(select 1 from portal_growth_work where client_id<>'00000000-0000-4000-b000-00000000000a' or kind='gbp' or title like '%draft%') then raise exception 'foreign/draft work leaked'; end if;
 if (select jsonb_agg(to_jsonb(w))::text from portal_growth_work w) like '%PRIVATE%' then raise exception 'private copy leaked'; end if;
 if has_function_privilege('authenticated','public.gsc_performance_record(uuid,text,date,date,jsonb)','execute') or has_table_privilege('authenticated','portal_growth_work','insert,update,delete') or has_table_privilege('anon','portal_growth_work','select') then raise exception 'unsafe grants'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000012',true);
do $$ begin
 if exists(select 1 from portal_growth_measurements where source='Google Search Console property totals') or exists(select 1 from portal_growth_work where client_id<>'00000000-0000-4000-b000-00000000000b') then raise exception 'foreign data leaked'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000013',true);
do $$ begin if exists(select 1 from portal_growth_work) then raise exception 'inactive contact access'; end if; end $$;
reset role;
do $$ begin begin perform gsc_performance_record(null,null,null,null,null); raise exception 'worker bypass'; exception when insufficient_privilege then null; end; end $$;
rollback;
