-- Temporary rows for the generic portal boundary checks.
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
commit;
