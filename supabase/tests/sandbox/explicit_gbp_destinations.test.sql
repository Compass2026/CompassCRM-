-- Fictional profiles. Uses the real writer, review gate and publisher guards.
\set team '00000000-0000-4000-a000-000000000001'
\c - postgres
grant select,insert on gd.results to authenticated;
insert into publisher_gbp_policies(client_id,excluded_locations)
 values('00000000-0000-4000-b000-00000000000b',array['locations/99900']);
\c - authenticator
set role service_role;
select fd.as_user('service_role',null);
insert into gd.ids select 'multi1',(publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000b',
 'ddddddddddddddddddddddd1','locations/987654321','Wichita fixture','Shared Google','{"status":"healthy"}') ->> 'social_account_id')::uuid;
insert into gd.ids select 'multi2',(publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000b',
 'ddddddddddddddddddddddd1','locations/987654322','Second market fixture','Shared Google','{"status":"healthy"}') ->> 'social_account_id')::uuid;
do $$ declare r jsonb; e text; begin
 e:=fd.try(format('select drafter_write(%L::jsonb)',gd.req('Explicit missing fixture')));
 perform gd.ok('explicit policy refuses missing destination',e like '23514:%explicit%',e);
 e:=fd.try($q$select publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000b','ddddddddddddddddddddddd1','locations/99900','Excluded','Shared','{}')$q$);
 perform gd.ok('excluded destination cannot be bound',e like '23514:%excluded%',e);
 e:=fd.try(format('select drafter_write(%L::jsonb)',jsonb_set(gd.req('Foreign destination fixture'),'{brief,target,social_account}',
  jsonb_build_object('id',(select id from social_accounts where client_id='00000000-0000-4000-b000-00000000000a' and platform='google_business' limit 1)))));
 perform gd.ok('foreign client selection is refused',e like '23514:%belonging to this client%',e);
 r:=drafter_write(jsonb_set(gd.req('Selected second market fixture'),'{brief,target,social_account}',jsonb_build_object('id',(select id from gd.ids where k='multi2'))));
 insert into gd.ids values('multi-post',(r->>'post_id')::uuid);
 perform gd.ok('explicit choice persists, never replaced by first location',r->>'social_account_id'=(select id::text from gd.ids where k='multi2'));
 perform gd.ok('binding never enables publishing',(select bool_and(not publish_enabled) from social_accounts where id in(select id from gd.ids where k in('multi1','multi2'))));
end $$;
reset role;
set role authenticated;
select fd.as_user('authenticated', :'team');
update social_posts set review_status='approved' where id=(select id from gd.ids where k='multi-post');
do $$ declare e text; begin
 perform gd.ok('approval pins selection',(select approved_snapshot->>'social_account_id'=(select id::text from gd.ids where k='multi2') from social_posts where id=(select id from gd.ids where k='multi-post')));
 e:=fd.try($q$update social_posts set social_account_id=(select id from gd.ids where k='multi1') where id=(select id from gd.ids where k='multi-post')$q$);
 perform gd.ok('approved destination is frozen',e like '23514:%frozen%',e);
end $$;
update social_posts set review_status='draft' where id=(select id from gd.ids where k='multi-post');
update social_posts set social_account_id=(select id from gd.ids where k='multi1') where id=(select id from gd.ids where k='multi-post');
select gd.ok('reopening clears approval and schedule',(select approved_hash is null and approved_snapshot is null and publish_status='not_scheduled' from social_posts where id=(select id from gd.ids where k='multi-post')));
update social_posts set review_status='in_review' where id=(select id from gd.ids where k='multi-post');
update social_posts set review_status='approved' where id=(select id from gd.ids where k='multi-post');
select gd.ok('new approval pins new destination',(select approved_snapshot->>'social_account_id'=(select id::text from gd.ids where k='multi1') from social_posts where id=(select id from gd.ids where k='multi-post')));
select publisher_unbind_account((select id from gd.ids where k='multi1'));
do $$ declare e text; begin
 e:=fd.try($q$update social_accounts set external_account_id='locations/111' where id=(select id from gd.ids where k='multi1')$q$);
 perform gd.ok('unbound profile cannot be repurposed under approval',e like '23514:%immutable%',e);
end $$;
reset role;
\c - postgres
select gd.ok('policy grants remain read-only',not has_table_privilege('authenticated','publisher_gbp_policies','insert,update,delete')
 and not has_table_privilege('anon','publisher_gbp_policies','select') and not has_table_privilege('service_role','publisher_gbp_policies','insert,update,delete'));
select * from gd.results;
do $$ begin if exists(select 1 from gd.results where not passed) then raise exception 'Explicit GBP checks failed'; end if; end $$;
