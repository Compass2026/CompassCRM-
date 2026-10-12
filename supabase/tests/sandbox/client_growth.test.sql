-- Runs after full migration replay and the generic A/B portal fixtures.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
insert into report_measurements (id,client_id,metric,scope,source,context,window_start,window_end,status,value,evidence,meaning,next_action) values
 ('00000000-0000-4000-8000-00000000e001','00000000-0000-4000-b000-00000000000a','referring_domains','Fixture scope','Fixture export','existing_client','2026-08-01','2026-08-01','measured',10,'PRIVATE evidence','PRIVATE meaning','PRIVATE next'),
 ('00000000-0000-4000-8000-00000000e002','00000000-0000-4000-b000-00000000000b','referring_domains','Fixture scope','Fixture export','existing_client','2026-08-01','2026-08-01','measured',20,'PRIVATE evidence','PRIVATE meaning','PRIVATE next');
insert into backlink_opportunities(id,client_id,keyword_id,source_url,target_url,title,kind,notes) values
 ('00000000-0000-4000-8000-00000000f001','00000000-0000-4000-b000-00000000000a','00000000-0000-4000-d000-00000000000a','https://association.example.test/a','https://a.example.test/','Association A','association','PRIVATE outreach'),
 ('00000000-0000-4000-8000-00000000f002','00000000-0000-4000-b000-00000000000b','00000000-0000-4000-d000-00000000000b','https://association.example.test/b','https://b.example.test/','Association B','association','PRIVATE outreach'),
 ('00000000-0000-4000-8000-00000000f003','00000000-0000-4000-b000-00000000000a','00000000-0000-4000-d000-00000000000a','https://association.example.test/unverified','https://a.example.test/','Not checked','association','PRIVATE');
insert into backlink_checks(opportunity_id,observed_on,result,evidence,recorded_by) values
 ('00000000-0000-4000-8000-00000000f001','2026-08-01','live','PRIVATE evidence','00000000-0000-4000-a000-000000000014'),
 ('00000000-0000-4000-8000-00000000f001','2026-09-01','unreachable','PRIVATE evidence',null),
 ('00000000-0000-4000-8000-00000000f002','2026-08-01','live','PRIVATE evidence',null);
do $$ begin
 if exists(select 1 from backlink_checks where recorded_by <> '00000000-0000-4000-a000-000000000001') then raise exception 'actor spoofing'; end if;
 begin
  insert into backlink_opportunities(client_id,keyword_id,source_url,target_url,title,kind) values ('00000000-0000-4000-b000-00000000000a','00000000-0000-4000-d000-00000000000b','https://x.test/a','https://a.example.test','Wrong client keyword','other');
  raise exception 'foreign keyword accepted';
 exception when check_violation then null; end;
 begin
  update backlink_opportunities set target_url='https://b.example.test' where id='00000000-0000-4000-8000-00000000f001';
  raise exception 'identity changed';
 exception when check_violation then null; end;
 begin
  insert into backlink_opportunities(client_id,keyword_id,source_url,target_url,title,kind) values ('00000000-0000-4000-b000-00000000000a','00000000-0000-4000-d000-00000000000a','https://x.test/a','https://b.example.test','Wrong destination','other');
  raise exception 'foreign target accepted';
 exception when check_violation then null; end;
 begin
  insert into backlink_checks(opportunity_id,observed_on,result,evidence) values ('00000000-0000-4000-8000-00000000f001','2099-01-01','live','Future');
  raise exception 'future evidence accepted';
 exception when check_violation then null; end;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000011',true);
do $$ declare n int; payload text; begin
 select count(*) into n from portal_growth_measurements;
 if n <> 1 then raise exception 'portal measurements leaked or missing: %',n; end if;
 select jsonb_agg(to_jsonb(m))::text into payload from portal_growth_measurements m;
 if payload like '%PRIVATE%' or payload like '%recorded_by%' then raise exception 'private measurement columns exposed'; end if;
 if exists(select 1 from portal_growth_search where client_id<>'00000000-0000-4000-b000-00000000000a') then raise exception 'search history leaked'; end if;
 select count(*) into n from portal_backlinks;
 if n<>1 then raise exception 'other client or unverified opportunity exposed: %',n; end if;
 select jsonb_agg(to_jsonb(b))::text into payload from portal_backlinks b;
 if payload like '%PRIVATE%' or payload like '%evidence%' or payload like '%notes%' then raise exception 'private backlink columns exposed'; end if;
 if not exists(select 1 from portal_backlinks where result='unreachable' and first_live_on='2026-08-01') then raise exception 'check history lost'; end if;
 if exists(select 1 from backlink_opportunities) or exists(select 1 from backlink_checks) or exists(select 1 from report_measurements) then raise exception 'portal base data exposed'; end if;
 begin
  insert into backlink_checks(opportunity_id,observed_on,result,evidence) values ('00000000-0000-4000-8000-00000000f001','2026-09-02','live','forged');
  raise exception 'portal wrote a check';
 exception when insufficient_privilege then null; end;
 begin
  update portal_growth_measurements set value=999;
  raise exception 'portal wrote through a view';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000012',true);
do $$ begin
 if exists(select 1 from portal_backlinks where client_id<>'00000000-0000-4000-b000-00000000000b') then raise exception 'client B leaked'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000013',true);
do $$ begin
 if exists(select 1 from portal_backlinks) or exists(select 1 from portal_growth_measurements) or exists(select 1 from portal_growth_search) then raise exception 'inactive user has access'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000014',true);
do $$ begin
 if exists(select 1 from portal_backlinks) or exists(select 1 from portal_growth_measurements) then raise exception 'stranger has access'; end if;
end $$;
reset role;
do $$ begin
 begin update backlink_checks set evidence='overwritten'; raise exception 'history mutable'; exception when check_violation then null; end;
 if has_table_privilege('anon','portal_backlinks','SELECT') or has_table_privilege('authenticated','portal_backlinks','INSERT') or has_table_privilege('authenticated','portal_growth_search','UPDATE') then raise exception 'unsafe view grants'; end if;
end $$;
rollback;
