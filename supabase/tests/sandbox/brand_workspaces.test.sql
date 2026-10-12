-- Real RLS and caller sessions; reuse cd assertions after the blog suites.
\c - supabase_admin
insert into clients(id,name,city,state,status) values (cd.id('multi'),'Training Group','Testville','MO','active');
insert into services(id,client_id,name,status,page_url) values
 (cd.id('safety'),cd.id('multi'),'Safety','approved','https://safety.example.test/safety'),
 (cd.id('forklift'),cd.id('multi'),'Forklift','approved','https://forklift.example.test/forklift');
insert into keywords(id,client_id,keyword,intent,service_id,target_url) values
 (cd.id('safety-kw'),cd.id('multi'),'safety training','commercial',cd.id('safety'),'https://safety.example.test/safety'),
 (cd.id('forklift-kw'),cd.id('multi'),'forklift training','commercial',cd.id('forklift'),'https://forklift.example.test/forklift');
insert into claims(id,client_id,claim,status,source) values
 (cd.id('safety-claim'),cd.id('multi'),'Safety training','sourced','https://safety.example.test'),
 (cd.id('forklift-claim'),cd.id('multi'),'Forklift training','sourced','https://forklift.example.test');
insert into brand_assets(id,client_id,label,kind,url) values
 (cd.id('safety-logo'),cd.id('multi'),'Safety logo','logo_primary','https://safety.example.test/logo.png'),
 (cd.id('forklift-logo'),cd.id('multi'),'Forklift logo','logo_primary','https://forklift.example.test/logo.png');
insert into sites(id,client_id,url,stack) values
 (cd.id('safety-site'),cd.id('multi'),'https://safety.example.test','nextjs'),
 (cd.id('forklift-site'),cd.id('multi'),'https://forklift.example.test','nextjs');
insert into social_accounts(id,client_id,platform,display_name) values
 (cd.id('safety-fb'),cd.id('multi'),'facebook','Safety Page'),
 (cd.id('forklift-fb'),cd.id('multi'),'facebook','Forklift Page'),
 (cd.id('shared-gbp'),cd.id('multi'),'google_business','Shared profile');
select cd.save('plans-before',(select count(*)::text from plans));
\c - authenticator
set role authenticated;
select cd.as_user('authenticated','00000000-0000-4000-a000-000000000001');
insert into client_brand_workspaces(id,client_id,slug,name,website_url,phone,positioning,voice_tone,standing_cta,hard_rules,service_ids,claim_ids,asset_ids,blog_site_id,facebook_account_id) values
 (cd.id('safety-brand'),cd.id('multi'),'safety','Safety Training','https://safety.example.test','202-555-0120','Safety training','Clear','Call us',array['Use sourced claims'],array[cd.id('safety')],array[cd.id('safety-claim')],array[cd.id('safety-logo')],cd.id('safety-site'),cd.id('safety-fb')),
 (cd.id('forklift-brand'),cd.id('multi'),'forklift','Forklift Training','https://forklift.example.test','202-555-0120','Forklift training','Clear','Call us',array['Use sourced claims'],array[cd.id('forklift')],array[cd.id('forklift-claim')],array[cd.id('forklift-logo')],cd.id('forklift-site'),cd.id('forklift-fb'));
select cd.ok('BR1 legacy intelligence is byte-equivalent',client_intelligence_for_content(cd.id('a'),cd.id('svc'))=client_intelligence_input(cd.id('a')));
do $$ declare i jsonb; b jsonb; begin
 i:=client_intelligence_for_content(cd.id('multi'),cd.id('safety'));
 perform cd.ok('BR2 services, keywords, claims and images stay within selected brand',
  i->'client'->>'name'='Safety Training' and i->'client'->>'phone'='202-555-0120'
  and jsonb_array_length(i->'services')=1 and i->'services'->0->>'id'=cd.id('safety')::text
  and jsonb_array_length(i->'keywords')=1 and i->'keywords'->0->>'id'=cd.id('safety-kw')::text
  and jsonb_array_length(i->'claims')=1 and i->'claims'->0->>'id'=cd.id('safety-claim')::text
  and jsonb_array_length(i->'assets')=1 and i->'assets'->0->>'id'=cd.id('safety-logo')::text);
 perform cd.ok('BR3 no umbrella fallback without a brand service',cd.try(format('select client_intelligence_for_content(%L,null)',cd.id('multi'))) like '23514%');
 perform cd.ok('BR4 a service cannot be owned by two brands',cd.try(format('update client_brand_workspaces set service_ids=array[%L::uuid] where id=%L',cd.id('safety'),cd.id('forklift-brand'))) like '23514%');
 perform cd.ok('BR5 foreign-client claims are refused',cd.try(format('update client_brand_workspaces set claim_ids=array[%L::uuid] where id=%L',cd.id('c-b'),cd.id('safety-brand'))) like '23514%');
 perform cd.ok('BR6 another brand website or GBP-as-Facebook is refused',
  cd.try(format('update client_brand_workspaces set blog_site_id=%L where id=%L',cd.id('forklift-site'),cd.id('safety-brand'))) like '23514%'
  and cd.try(format('update client_brand_workspaces set facebook_account_id=%L where id=%L',cd.id('shared-gbp'),cd.id('safety-brand'))) like '23514%');
 b:=jsonb_build_object('gate',jsonb_build_object('brand_workspace_id',cd.id('safety-brand'),'brand_workspace_version','1'));
 perform cd.ok('BR7 a draft brand blocks content approval',cardinality(brand_content_problems(cd.id('multi'),cd.id('safety'),b))>0);
 update client_brand_workspaces set status='approved' where id=cd.id('safety-brand');
 perform cd.ok('BR8 human approval stamps actor and allows current brand',
  (select approved_by is not null and approved_at is not null and version=1 from client_brand_workspaces where id=cd.id('safety-brand'))
  and cardinality(brand_content_problems(cd.id('multi'),cd.id('safety'),b))=0);
 perform cd.ok('BR9 wrong brand and stale briefs fail closed',cardinality(brand_content_problems(cd.id('multi'),cd.id('forklift'),b))>0);
 update client_brand_workspaces set phone='202-555-0121' where id=cd.id('safety-brand');
 perform cd.ok('BR10 identity edits revoke approval and stale content',
  (select status='draft' and version=2 and approved_by is null from client_brand_workspaces where id=cd.id('safety-brand'))
  and cardinality(brand_content_problems(cd.id('multi'),cd.id('safety'),b))=2);
 perform cd.ok('BR11 each blog resolves its own website',content_site_destination(cd.id('multi'),cd.id('safety'))->>'site_id'=cd.id('safety-site')::text
  and content_site_destination(cd.id('multi'),cd.id('forklift'))->>'site_id'=cd.id('forklift-site')::text);
 update client_brand_workspaces set blog_site_id=null where id=cd.id('forklift-brand');
 perform cd.ok('BR12 missing destination never falls back to sibling website',content_site_destination(cd.id('multi'),cd.id('forklift')) is null);
 perform cd.ok('BR13 shared GBP and billing agreement are unchanged',
  (select count(*) from social_accounts where client_id=cd.id('multi') and platform='google_business')=1
  and (select count(*)::text from plans)=cd.get('plans-before'));
end $$;
reset role;
\c - postgres
select cd.ok('BR17 social approval rejects a sibling Facebook Page',
 'Connect and select this brand Facebook Page.'=any(social_post_grounding_problems(
 jsonb_populate_record(null::social_posts,jsonb_build_object('id',cd.id('sample-post'),'client_id',cd.id('multi'),'service_id',cd.id('safety'),'platform','facebook','social_account_id',cd.id('forklift-fb'),'copy','Safety training','search_intent','navigational','crm_facts_only',true)))));
select cd.ok('BR18 blog grounding includes stale brand review',
 'Review and approve this brand workspace.'=any(content_draft_problems(
 jsonb_populate_record(null::content_drafts,jsonb_build_object('id',cd.id('sample-blog'),'client_id',cd.id('multi'),'service_id',cd.id('safety'),'search_intent','navigational')))));
select cd.ok('BR14 worker cannot approve the brand',cd.try(format('update client_brand_workspaces set status=''approved'' where id=%L',cd.id('safety-brand'))) like '42501%');
select cd.ok('BR15 trigger internals and table are not exposed to anon',not has_function_privilege('authenticated','brand_workspace_guard()','execute') and not has_table_privilege('anon','client_brand_workspaces','select'));
\c - authenticator
set role authenticated;
select cd.as_user('authenticated','00000000-0000-4000-a000-000000000011');
select cd.ok('BR16 portal sees no brand profiles',(select count(*) from client_brand_workspaces)=0);
reset role;
\c - postgres
select n,status,name,detail from cd.results where name like 'BR%' order by n;
do $$ begin if exists(select 1 from cd.results where status='fail') then raise exception 'Brand workspace checks failed'; end if; end $$;
