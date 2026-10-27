-- Organic rank counts only the client's own website (20261021163048).
-- Full migration replay + shared fixtures; every write rolls back.
begin;
-- Fixture rows for client A: a keyword whose earlier check found the website
-- and whose latest check matched a third-party page by name; a keyword found
-- on client B's website (another client is never "us"); A's own website
-- written with www and in upper case; and a DataForSEO row with a position
-- but no URL. A stays a single-site client here; the multi-brand rule
-- (20261027191343: each keyword judged against its own brand site) is
-- checked at the end.
insert into keywords(id,client_id,keyword,is_tracked,priority) values
 ('00000000-0000-4000-d000-0000000000f1','00000000-0000-4000-b000-00000000000a','a third party',true,'p1'),
 ('00000000-0000-4000-d000-0000000000f2','00000000-0000-4000-b000-00000000000a','a foreign site',true,'p1'),
 ('00000000-0000-4000-d000-0000000000f3','00000000-0000-4000-b000-00000000000a','a www site',true,'p1'),
 ('00000000-0000-4000-d000-0000000000f4','00000000-0000-4000-b000-00000000000a','a no url',true,'p1'),
 ('00000000-0000-4000-d000-0000000000f5','00000000-0000-4000-b000-00000000000a','a dropped',true,'p1'),
 ('00000000-0000-4000-d000-0000000000f6','00000000-0000-4000-b000-00000000000a','a upper host',true,'p2');
insert into locations(id,client_id,name,city,state) values
 ('00000000-0000-4000-c000-0000000000f0','00000000-0000-4000-b000-00000000000a','A test area','Testville','MO');
insert into rank_snapshots(keyword_id,location_id,result_type,position,url_ranked,recorded_at,source) values
 ('00000000-0000-4000-d000-0000000000f1','00000000-0000-4000-c000-0000000000f0','organic',4,'https://a.example.test/services',date_trunc('month',now())+interval '1 hour','dataforseo'),
 ('00000000-0000-4000-d000-0000000000f1','00000000-0000-4000-c000-0000000000f0','organic',1,'https://www.facebook.com/SandboxA/',date_trunc('month',now())+interval '2 hours','dataforseo'),
 ('00000000-0000-4000-d000-0000000000f1','00000000-0000-4000-c000-0000000000f0','map_pack',2,null,date_trunc('month',now())+interval '2 hours','dataforseo'),
 ('00000000-0000-4000-d000-0000000000f2','00000000-0000-4000-c000-0000000000f0','organic',2,'https://b.example.test/',date_trunc('month',now())+interval '2 hours','dataforseo'),
 ('00000000-0000-4000-d000-0000000000f3','00000000-0000-4000-c000-0000000000f0','organic',6,'https://www.a.example.test/page',date_trunc('month',now())+interval '2 hours','dataforseo'),
 ('00000000-0000-4000-d000-0000000000f4','00000000-0000-4000-c000-0000000000f0','organic',3,null,date_trunc('month',now())+interval '2 hours','dataforseo'),
 -- 'a dropped': website #4, then a newer check that found nothing. The newer
 -- not-found is the latest; the older #4 must not be used.
 ('00000000-0000-4000-d000-0000000000f5','00000000-0000-4000-c000-0000000000f0','organic',4,'https://a.example.test/dropped',date_trunc('month',now())+interval '1 hour','dataforseo'),
 ('00000000-0000-4000-d000-0000000000f5','00000000-0000-4000-c000-0000000000f0','organic',null,null,date_trunc('month',now())+interval '3 hours','dataforseo'),
 ('00000000-0000-4000-d000-0000000000f6','00000000-0000-4000-c000-0000000000f0','organic',7,'https://WWW.A.Example.Test/page',date_trunc('month',now())+interval '2 hours','dataforseo');

-- Team view (security invoker, team RLS).
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
do $$ begin
 if not exists(select 1 from client_growth_rankings where keyword='a third party' and result_type='organic'
   and first_position=4 and first_state='website' and position is null and state='third_party') then
  raise exception 'O1 third-party latest counted as website rank or website baseline lost'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a third party' and result_type='map_pack' and position=2 and state='listed') then
  raise exception 'O2 map pack changed'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a foreign site' and position is null and state='third_party') then
  raise exception 'O3 another client''s website verified this client''s rank'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a www site' and position=6 and state='website') then
  raise exception 'O4 the client''s own website (www) not recognised'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a no url' and position is null and state='unverified') then
  raise exception 'O5 a DataForSEO position with no URL was counted'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a plumber' and result_type='organic' and position=5 and state='website' and previous_position=9 and previous_state='website') then
  raise exception 'O6 verified website ranks changed'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a upper host' and position=7 and state='website') then
  raise exception 'O8 an upper-case WWW page of the website was not recognised'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a dropped' and position is null and state='not_found' and first_position=4) then
  raise exception 'O9 latest not-found replaced by an older rank'; end if;
 -- Executable parity with src/lib/organic-rank.ts (tests/organic-rank.test.mjs).
 if url_host('https://WWW.Site.Test') is distinct from 'site.test' or url_host('HTTPS://User:pw@WWW.Site.Test:8443/x?y#z') is distinct from 'site.test'
    or url_host('site.test/no-scheme') is not null or url_host(null) is not null
    or organic_rank_state('dataforseo',2,'https://site.test/page',array[url_host('https://WWW.Site.Test')])<>'website'
    or organic_rank_state('dataforseo',2,'https://WWW.SITE.TEST/page',array['site.test'])<>'website' then
  raise exception 'O10 SQL host normalisation differs from the TypeScript mirror'; end if;
 if exists(select 1 from client_growth_rankings where client_id='00000000-0000-4000-b000-00000000000b' and keyword like 'a %') then
  raise exception 'O7 client A keywords attributed to client B'; end if;
end $$;

-- Portal A sees the same states for its own keywords only; portal B none of A's.
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000011',true);
do $$ begin
 if not exists(select 1 from portal_growth_rankings where keyword='a third party' and result_type='organic' and position is null and state='third_party' and first_position=4) then
  raise exception 'P1 portal growth view counts the third-party page'; end if;
 if not exists(select 1 from portal_rankings where keyword='a third party' and result_type='organic' and position is null and state='third_party' and previous_position=4 and previous_state='website') then
  raise exception 'P2 portal rankings counts the third-party page'; end if;
 if not exists(select 1 from portal_rankings where keyword='a plumber' and result_type='organic' and position=5 and previous_position=9) then
  raise exception 'P3 portal website ranks changed'; end if;
 if exists(select 1 from portal_rankings where client_id<>'00000000-0000-4000-b000-00000000000a') or exists(select 1 from portal_growth_rankings where client_id<>'00000000-0000-4000-b000-00000000000a') then
  raise exception 'P4 foreign rows exposed'; end if;
 if exists(select 1 from client_growth_rankings) then raise exception 'P5 portal read the team view'; end if;
 begin
  perform organic_rank_state('dataforseo',1,'https://a.example.test/',array['a.example.test']);
 exception when insufficient_privilege then raise exception 'P6 portal views need execute on organic_rank_state'; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-a000-000000000012',true);
do $$ begin
 if exists(select 1 from portal_rankings where keyword like 'a %') or exists(select 1 from portal_growth_rankings where keyword like 'a %') then
  raise exception 'P7 portal B sees client A'; end if;
 if not exists(select 1 from portal_rankings where keyword='b electrician' and position=4 and state='website') then
  raise exception 'P8 portal B website rank lost'; end if;
end $$;
set local role anon;
do $$ begin
 begin perform organic_rank_state('dataforseo',1,'https://a.example.test/',array['a.example.test']); raise exception 'P9 anon may execute'; exception when insufficient_privilege then null; end;
end $$;

-- City Index (worker role): website organic rows only; the stored history is untouched.
reset role;
do $$
declare v location_index;
begin
 perform compute_location_index('00000000-0000-4000-c000-0000000000f0', date_trunc('month',now())::date);
 select * into v from location_index where location_id='00000000-0000-4000-c000-0000000000f0' and period=date_trunc('month',now())::date;
 -- P1 keywords in this month: 'a www site' #6 is the only verified website rank;
 -- 'a third party' (#1 Facebook), 'a foreign site' (#2 on B) and 'a no url' (#3) are excluded,
 -- and 'a dropped' is excluded because its latest check (not found) supersedes its older #4.
 if v.organic_index is distinct from 6.00 then raise exception 'C1 City Index organic=% (expected 6.00: third-party, unverified and superseded rows excluded)', v.organic_index; end if;
 if v.map_index is distinct from 2.00 then raise exception 'C2 City Index map pack changed: %', v.map_index; end if;
 if (select count(*) from rank_snapshots where keyword_id='00000000-0000-4000-d000-0000000000f1' and position=1 and url_ranked like '%facebook%')<>1 then
  raise exception 'C3 stored history was changed'; end if;
end $$;

-- Multi-brand (20261027191343): once A has brand sites, each keyword is
-- judged against the brand site owning its service. A sister brand's page is
-- third party; a keyword no brand site owns, and an older row not judged
-- against the keyword's own site, prove nothing (unverified).
insert into services(id,client_id,name,status) values
 ('00000000-0000-4000-e000-0000000000f1','00000000-0000-4000-b000-00000000000a','Brand A service','approved'),
 ('00000000-0000-4000-e000-0000000000f2','00000000-0000-4000-b000-00000000000a','Upper A service','approved');
insert into client_brand_workspaces(client_id,slug,name,website_url,phone,service_ids) values
 ('00000000-0000-4000-b000-00000000000a','brand-a','Brand A','https://www.brand-a.example.test','202-555-0100',array['00000000-0000-4000-e000-0000000000f1'::uuid]),
 -- Recorded with an upper-case WWW: still the bare host upper-a.example.test.
 ('00000000-0000-4000-b000-00000000000a','upper-a','Upper A','https://WWW.Upper-A.example.test','202-555-0101',array['00000000-0000-4000-e000-0000000000f2'::uuid]);
insert into keywords(id,client_id,keyword,is_tracked,priority,service_id) values
 ('00000000-0000-4000-d000-0000000000f7','00000000-0000-4000-b000-00000000000a','a brand keyword',true,'p2','00000000-0000-4000-e000-0000000000f1'),
 ('00000000-0000-4000-d000-0000000000f8','00000000-0000-4000-b000-00000000000a','a upper keyword',true,'p2','00000000-0000-4000-e000-0000000000f2'),
 ('00000000-0000-4000-d000-0000000000f9','00000000-0000-4000-b000-00000000000a','a sister page',true,'p2','00000000-0000-4000-e000-0000000000f1');
insert into rank_snapshots(keyword_id,location_id,result_type,position,url_ranked,recorded_at,source,site_host) values
 ('00000000-0000-4000-d000-0000000000f7','00000000-0000-4000-c000-0000000000f0','organic',6,'https://brand-a.example.test/page',date_trunc('month',now())+interval '2 hours','dataforseo','brand-a.example.test'),
 ('00000000-0000-4000-d000-0000000000f8','00000000-0000-4000-c000-0000000000f0','organic',7,'https://upper-a.example.test/page',date_trunc('month',now())+interval '2 hours','dataforseo','upper-a.example.test'),
 ('00000000-0000-4000-d000-0000000000f9','00000000-0000-4000-c000-0000000000f0','organic',3,'https://upper-a.example.test/x',date_trunc('month',now())+interval '2 hours','dataforseo','brand-a.example.test');
do $$ begin
 if not exists(select 1 from client_growth_rankings where keyword='a brand keyword' and position=6 and state='website') then
  raise exception 'M1 a keyword''s own brand website not recognised'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a upper keyword' and position=7 and state='website') then
  raise exception 'M2 an upper-case WWW brand website not recognised'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a sister page' and position is null and state='third_party') then
  raise exception 'M3 a sister brand''s page counted as this keyword''s rank'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a www site' and position is null and state='unverified') then
  raise exception 'M4 a keyword no brand site owns (older row) shown as a measurement'; end if;
 if (select count(*) from rank_snapshots where keyword_id='00000000-0000-4000-d000-0000000000f3' and position=6)<>1 then
  raise exception 'M5 stored history was changed'; end if;
end $$;
rollback;
