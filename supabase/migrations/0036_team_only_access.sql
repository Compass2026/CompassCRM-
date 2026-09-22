-- Client portal, step 0: the team, not every signed-in user (Sept 15 2026).
--
-- Until now every policy was `to authenticated using (true)`, which was the
-- same thing as "the team" while the team was the only sign-in. The portal
-- gives clients sign-ins, so access has to name the team explicitly first:
--
-- 1. team_members rows are linked to their auth users by email, and the
--    migration refuses to run if that leaves nobody linked (it would lock the
--    team out of its own app).
-- 2. is_team() answers "is auth.uid() a team member"; every blanket policy in
--    public and on the documents / brand-assets buckets is rewritten to it.
-- 3. Security-definer functions a signed-in client could call over PostgREST
--    are revoked from anon / authenticated. secret_present() stays callable
--    (the Settings page uses it) but answers false for non-team callers.
--
-- The Edge Functions get the matching check in code (a JWT must belong to a
-- team member; x-cron-secret callers are unaffected). Phase 5 adds
-- client-scoped read policies alongside these; nothing here grants clients
-- anything.

-- ── 1. The team: seed and link ──────────────────────────────────────────────
-- team_members was never populated, so seed it from the confirmed Compass
-- sign-ins that exist today. Sign-ups are disabled in Supabase Auth, so every
-- account was created by invite.
insert into team_members (auth_user_id, name, email, role)
select u.id,
       coalesce(nullif(u.raw_user_meta_data ->> 'full_name', ''), initcap(split_part(u.email, '@', 1))),
       u.email,
       'admin'
from auth.users u
where u.email_confirmed_at is not null
  and lower(split_part(u.email, '@', 2)) = 'compassmarketing.ai'
  and not exists (select 1 from team_members tm where lower(tm.email) = lower(u.email));

update team_members tm
set auth_user_id = u.id
from auth.users u
where tm.auth_user_id is null
  and lower(tm.email) = lower(u.email);

-- A teammate added later (invite them in Supabase Auth first, then insert the
-- team_members row) is linked to their sign-in by email.
create or replace function link_team_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.auth_user_id is null then
    select id into new.auth_user_id from auth.users where lower(email) = lower(new.email);
  end if;
  return new;
end $$;
revoke execute on function link_team_member() from public, anon, authenticated;
create trigger team_members_link before insert or update of email on team_members
  for each row execute function link_team_member();

do $$
begin
  if not exists (
    select 1 from team_members tm join auth.users u on u.id = tm.auth_user_id
  ) then
    raise exception 'No team_members row is linked to an auth user; applying 0036 would lock the team out';
  end if;
end $$;

-- ── 2. is_team() and the policies ───────────────────────────────────────────
create or replace function is_team() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where auth_user_id = auth.uid());
$$;
revoke execute on function is_team() from public, anon;
grant execute on function is_team() to authenticated, service_role;
comment on function is_team() is
  'Whether the signed-in user is a Compass team member. Every team policy reads it; portal policies must not.';

do $$
declare
  p record;
begin
  for p in
    select tablename, policyname, cmd
    from pg_policies
    where schemaname = 'public'
      and 'authenticated'::name = any (roles)
      and (qual = 'true' or with_check = 'true')
  loop
    execute format('drop policy %I on %I', p.policyname, p.tablename);
    if p.cmd = 'ALL' then
      execute format(
        'create policy %I on %I for all to authenticated using ((select is_team())) with check ((select is_team()))',
        p.policyname, p.tablename);
    elsif p.cmd = 'SELECT' then
      execute format(
        'create policy %I on %I for select to authenticated using ((select is_team()))',
        p.policyname, p.tablename);
    else
      raise exception 'Unexpected blanket % policy "%" on %', p.cmd, p.policyname, p.tablename;
    end if;
  end loop;
end $$;

drop policy "team read documents" on storage.objects;
drop policy "team write documents" on storage.objects;
drop policy "team update documents" on storage.objects;
drop policy "team delete documents" on storage.objects;
create policy "team read documents" on storage.objects
  for select to authenticated using (bucket_id = 'documents' and (select public.is_team()));
create policy "team write documents" on storage.objects
  for insert to authenticated with check (bucket_id = 'documents' and (select public.is_team()));
create policy "team update documents" on storage.objects
  for update to authenticated using (bucket_id = 'documents' and (select public.is_team()));
create policy "team delete documents" on storage.objects
  for delete to authenticated using (bucket_id = 'documents' and (select public.is_team()));

drop policy "team read brand assets" on storage.objects;
drop policy "team write brand assets" on storage.objects;
drop policy "team update brand assets" on storage.objects;
drop policy "team delete brand assets" on storage.objects;
create policy "team read brand assets" on storage.objects
  for select to authenticated using (bucket_id = 'brand-assets' and (select public.is_team()));
create policy "team write brand assets" on storage.objects
  for insert to authenticated with check (bucket_id = 'brand-assets' and (select public.is_team()));
create policy "team update brand assets" on storage.objects
  for update to authenticated using (bucket_id = 'brand-assets' and (select public.is_team()));
create policy "team delete brand assets" on storage.objects
  for delete to authenticated using (bucket_id = 'brand-assets' and (select public.is_team()));

-- ── 3. Callable functions ───────────────────────────────────────────────────
create or replace function secret_present(secret_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select (auth.role() = 'service_role' or is_team())
     and exists (select 1 from vault.secrets where name = secret_name);
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function, and Supabase adds
-- anon / authenticated. Earlier migrations revoked most security-definer
-- functions one by one; fire_foundation_worker() (0017, 0019) kept
-- authenticated and normalize_tracked_keywords() (0033) was never revoked.
-- Sweep them all rather than trust the list. Triggers still call them as the
-- owner, and the worker runs them through the Supabase MCP, not PostgREST.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.prokind = 'f'
      and p.prorettype <> 'trigger'::regtype
      and p.proname not in ('is_team', 'secret_present')
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))
  loop
    raise notice 'revoking execute on % from public, anon, authenticated', f.sig;
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- ── Verify ──────────────────────────────────────────────────────────────────
do $$
declare
  v_open text;
begin
  select string_agg(schemaname || '.' || tablename || ' "' || policyname || '"', ', ')
  into v_open
  from pg_policies
  where schemaname in ('public', 'storage')
    and ('authenticated'::name = any (roles) or 'anon'::name = any (roles) or 'public'::name = any (roles))
    and (qual = 'true' or with_check = 'true'
      or (schemaname = 'storage' and coalesce(qual, with_check) not like '%is_team%'));
  if v_open is not null then
    raise exception 'Policies still open to any signed-in user: %', v_open;
  end if;
end $$;
