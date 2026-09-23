-- Sandbox bootstrap: the pieces of a Supabase project the migrations assume,
-- run as the cluster superuser (supabase_admin) before 0001.
--
-- Mirrors the production role shape checked on Sept 22 2026:
--   postgres       NOSUPERUSER, BYPASSRLS — owns every migrated object,
--                  including the portal views (security_invoker = false)
--   service_role   BYPASSRLS
--   authenticated / anon  plain roles; RLS applies
-- and Supabase's default privileges (ALL on new public objects to anon,
-- authenticated, service_role), which is what makes 0036's revokes and 0037's
-- view grants matter. pg_cron, pg_net, Vault, Storage and Auth are stubs with
-- only the columns and functions the migrations touch — nothing is sent,
-- scheduled or encrypted here.

create role postgres login nosuperuser bypassrls createrole createdb;
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
grant anon, authenticated, service_role to postgres;
-- PostgREST's login: connects, then switches to the JWT's role. 0045 tells a
-- person apart from the worker by session_user = 'authenticator'.
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
grant authenticator to postgres;

grant all on database sandbox to postgres;
grant all on schema public to postgres;
alter schema public owner to postgres;
grant usage on schema public to anon, authenticated, service_role;

create schema extensions authorization postgres;
grant usage on schema extensions to anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
alter database sandbox set search_path = "$user", public, extensions;

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;

-- ── auth ────────────────────────────────────────────────────────────────────
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
-- Same resolution order as Supabase's auth.uid() / auth.role(): the
-- per-claim GUC first, then the claims JSON PostgREST sets from the JWT.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
grant usage on schema auth to postgres, anon, authenticated, service_role;
grant all on auth.users to postgres, service_role;
grant execute on function auth.uid(), auth.role() to public;

-- ── storage ─────────────────────────────────────────────────────────────────
create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
grant usage on schema storage to postgres, anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to postgres, anon, authenticated, service_role;
alter table storage.objects owner to postgres;
alter table storage.buckets owner to postgres;

-- ── vault ───────────────────────────────────────────────────────────────────
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  secret text,
  created_at timestamptz default now()
);
create view vault.decrypted_secrets as
  select id, name, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null)
returns uuid language sql as $$
  insert into vault.secrets (name, secret) values (new_name, new_secret) returning id
$$;
create function vault.update_secret(secret_id uuid, new_secret text default null)
returns void language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id
$$;
grant usage on schema vault to postgres, service_role;
grant all on all tables in schema vault to postgres, service_role;
grant execute on all functions in schema vault to postgres, service_role;

-- ── pg_net (stub: records the request, sends nothing) ──────────────────────
create schema net;
create table net.http_request_queue (
  id bigserial primary key,
  url text, headers jsonb, body jsonb, created_at timestamptz default now()
);
create table net._http_response (
  id bigint primary key,
  status_code int,
  content text,
  created timestamptz default now()
);
create function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds int default 5000
) returns bigint language sql as $$
  insert into net.http_request_queue (url, headers, body) values (url, headers, body) returning id
$$;
grant usage on schema net to postgres, service_role;
grant all on all tables in schema net to postgres, service_role;
grant all on all sequences in schema net to postgres, service_role;
grant execute on all functions in schema net to postgres, service_role;

-- ── pg_cron (stub: records the job, runs nothing) ──────────────────────────
create schema cron;
create table cron.job (
  jobid bigserial primary key,
  jobname text unique,
  schedule text,
  command text
);
create function cron.schedule(job_name text, schedule text, command text)
returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
create function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d)
$$;
grant usage on schema cron to postgres;
grant all on all tables in schema cron to postgres;
grant all on all sequences in schema cron to postgres;
grant execute on all functions in schema cron to postgres;

-- ── The team sign-in 0036 requires ─────────────────────────────────────────
-- 0036 seeds team_members from confirmed compassmarketing.ai sign-ins and
-- refuses to run if none is linked. A synthetic account stands in.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('00000000-0000-4000-a000-000000000001', 'sandbox-team@compassmarketing.ai', now(),
   '{"full_name": "Sandbox Team"}');
