-- Portal: one sign-in, one client (Sept 22 2026).
--
-- portal_client_id() is `limit 1` over the caller's active portal_users rows.
-- Nothing stopped a sign-in from sitting on two active rows for different
-- clients (0037 only made `email` unique, and case-sensitively), and nothing
-- stopped an update from moving a contact to another client — portal-invite
-- upserted on email, so re-inviting an address from a second client's page
-- silently re-pointed it. Either way the client a portal user sees became
-- whichever row Postgres returned first.
--
-- 1. At most one ACTIVE row per auth user. A revoked row may stay behind.
-- 2. Emails are unique regardless of case (portal-invite lowercases; a row
--    written any other way can no longer shadow it).
-- 3. A row's client never changes. Moving a contact is: revoke, then a team
--    member removes the row, then invite from the other client's page.
--
-- portal_users is empty in production as of this migration; the checks below
-- refuse to run rather than guess if that is no longer true.
-- Numbered 0042: 0041 is taken by the reporting work on PR #50.

do $$
begin
  if exists (
    select 1 from portal_users
    where is_active and auth_user_id is not null
    group by auth_user_id having count(*) > 1
  ) then
    raise exception 'portal_users: a sign-in is active on more than one row; resolve by hand before 0042';
  end if;
  if exists (select 1 from portal_users group by lower(email) having count(*) > 1) then
    raise exception 'portal_users: two rows differ only by email case; resolve by hand before 0042';
  end if;
end $$;

create unique index portal_users_one_active_client
  on portal_users (auth_user_id)
  where is_active and auth_user_id is not null;

create unique index portal_users_email_lower_key
  on portal_users (lower(email));

create or replace function portal_user_client_fixed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.client_id is distinct from old.client_id then
    raise exception 'A portal contact belongs to one client: revoke % and invite them from the other client instead', old.email
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke execute on function portal_user_client_fixed() from public, anon, authenticated;
create trigger portal_users_client_fixed before update of client_id on portal_users
  for each row execute function portal_user_client_fixed();

-- ── Verify ──────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'portal_users_one_active_client') then
    raise exception '0042: portal_users_one_active_client missing';
  end if;
  if has_function_privilege('authenticated', 'public.portal_user_client_fixed()', 'execute') then
    raise exception '0042: portal_user_client_fixed() is callable by authenticated';
  end if;
end $$;
