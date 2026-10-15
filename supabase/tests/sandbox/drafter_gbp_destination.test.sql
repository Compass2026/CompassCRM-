-- Fictional data only; run after the existing Facebook drafter sandbox suite.
\set team '00000000-0000-4000-a000-000000000001'
\c - postgres
create schema gd;
create table gd.results(name text, passed boolean, detail text);
create table gd.ids(k text primary key,id uuid);
grant usage on schema gd to service_role,authenticated,anon;
grant all on all tables in schema gd to service_role;
grant select on gd.ids to authenticated;
create function gd.ok(label text, value boolean, detail text default null) returns void language sql as $$
 insert into gd.results values(label,coalesce(value,false),detail)
$$;
create function gd.req(label text) returns jsonb language sql stable as $$
 select jsonb_set(fd.req(label || '. Licensed electricians.',null,p_channel=>'google_business',p_intent=>'navigational'),'{brief,target,service}','null'::jsonb)
$$;
grant execute on all functions in schema gd to service_role;

\c - authenticator
set role service_role;
select fd.as_user('service_role',null);
insert into gd.ids select 'bound',(publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000b',
 'ddddddddddddddddddddddd1','locations/987654321','Client B','Client B','{"status":"healthy"}') ->> 'social_account_id')::uuid;
do $$ declare r jsonb; e text; n bigint; begin
 r:=drafter_write(gd.req('Verified destination test'));
 insert into gd.ids values('post',(r->>'post_id')::uuid);
 perform gd.ok('bound GBP account is returned and persisted',r->>'social_account_id'=(select id::text from gd.ids where k='bound')
  and (select social_account_id=(select id from gd.ids where k='bound') from social_posts where id=(r->>'post_id')::uuid));
 perform gd.ok('draft stops at human review without scheduling',(select review_status='in_review' and publish_status='not_scheduled' and approved_hash is null from social_posts where id=(r->>'post_id')::uuid));
 perform gd.ok('drafting never enables publishing',(select not publish_enabled from social_accounts where id=(select id from gd.ids where k='bound')));
 e:=fd.try(format('select drafter_write(%L::jsonb)',jsonb_set(gd.req('Forged account test'),'{brief,target,social_account}',jsonb_build_object('id','00000000-0000-4000-8000-000000000099'))));
 perform gd.ok('caller cannot forge a GBP social account',e like '23514:%verified Business Profile%',e);
end $$;
reset role;

\c - authenticator
set role authenticated;
select fd.as_user('authenticated', :'team');
update social_posts set review_status='rejected',review_note='Fictional destination test complete'
 where id=(select id from gd.ids where k='post');
select publisher_unbind_account((select id from gd.ids where k='bound'));
reset role;
set role service_role;
select fd.as_user('service_role',null);
-- A foreign client's verified row must not satisfy client B's missing binding.
select publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000a',
 'ddddddddddddddddddddddd2','locations/7654321','Client A','Client A','{"status":"healthy"}');
do $$ declare e text; n bigint; begin
 select count(*) into n from drafter_runs;
 e:=fd.try(format('select drafter_write(%L::jsonb)',gd.req('Missing destination test')));
 perform gd.ok('missing or unverified own binding refuses, never borrows another client',e like '23514:%verified location binding%',e);
 perform gd.ok('refusal is atomic and creates no drafter run',(select count(*)=n from drafter_runs));
end $$;
select publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000b',
 'ddddddddddddddddddddddd1','locations/987654321','Client B','Client B','{"status":"healthy"}');
do $$ begin
 begin
  perform publisher_bind_gbp_location('00000000-0000-4000-b000-00000000000b','ddddddddddddddddddddddd1','locations/7654322','Another B','Another B','{"status":"healthy"}');
  if (select count(*) from social_accounts where client_id='00000000-0000-4000-b000-00000000000b' and publish_provider='zernio' and platform='google_business')<>2 then raise exception 'second binding missing'; end if;
  raise exception 'multi verified' using errcode='P9999';
 exception when sqlstate 'P9999' then perform gd.ok('multiple distinct destinations are supported',true); end;
end $$;
reset role;
set role authenticated;
select fd.as_user('authenticated', :'team');
select publisher_unbind_account((select id from gd.ids where k='bound'));
select publisher_set_gbp_transport('00000000-0000-4000-b000-00000000000b','google');
reset role;
set role service_role;
select fd.as_user('service_role',null);
do $$ declare r jsonb; begin
 r:=drafter_write(gd.req('Existing Google transport test'));
 perform gd.ok('existing Google transport keeps its account-free draft path',r->>'social_account_id' is null
  and (select social_account_id is null from social_posts where id=(r->>'post_id')::uuid));
end $$;
reset role;
\c - postgres
select gd.ok('write privileges remain restricted to the governed service path',
 has_function_privilege('service_role','drafter_write(jsonb)','execute')
 and not has_function_privilege('authenticated','drafter_write(jsonb)','execute')
 and not has_function_privilege('anon','drafter_write(jsonb)','execute'));
select * from gd.results;
do $$ begin if exists(select 1 from gd.results where not passed) then raise exception 'GBP drafter destination regression failed'; end if; end $$;
