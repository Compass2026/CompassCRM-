import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('rollout ledger enforces human identity, append-only history, stage gates, version conflicts and client isolation',async()=>{
 const db=new PGlite();
 try {
 await db.exec(`create role anon;create role authenticated;create role service_role;create role authenticator;grant anon,authenticated,service_role to authenticator;
 create schema auth;grant usage on schema auth to authenticated;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table clients(id uuid primary key,status text);create table team_members(id uuid primary key,auth_user_id uuid,role text);
 create table client_brand_workspaces(id uuid primary key,client_id uuid references clients(id),slug text,name text,website_url text,phone text);
 grant select on clients,team_members,client_brand_workspaces to authenticated;
 insert into clients values('00000000-0000-4000-b000-00000000000a','active'),('00000000-0000-4000-b000-00000000000b','active');
 insert into team_members values('00000000-0000-4000-a000-000000000001','00000000-0000-4000-a000-000000000001','admin');
 create function is_team() returns boolean language sql stable as $$select exists(select 1 from team_members where auth_user_id=auth.uid())$$;
 create function is_team_admin() returns boolean language sql stable as $$select exists(select 1 from team_members where auth_user_id=auth.uid() and role='admin')$$;
 alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
 await db.exec(readFileSync('supabase/migrations/20261015010455_agency_rollout_reviews.sql','utf8'));
 await db.exec(readFileSync('supabase/tests/sandbox/agency_rollout.test.sql','utf8'));
 } finally {await db.close();}
});
