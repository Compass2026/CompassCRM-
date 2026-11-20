-- A phone number recorded for one Business Profile location (Nov 3 2026).
--
-- A Business Profile post scoped to a location (its markets recorded in
-- gbp_location_markets) names no phone and takes no Call button, because the
-- client's phone (clients.phone) is not recorded for any one location. This
-- table records a location's own number, from a team decision, so its posts
-- may carry that number and a Call button; the client-wide number stays the
-- client's (Facebook, the other listings) and is never this location's.
--
-- One row per location, team-managed, effective on insert. The row says what
-- the location's number is, nothing more: it is not evidence of a staffed
-- office. Nothing is inserted here; a location's number is a data step
-- naming its decision in source_ref.
--
-- Rollback: supabase/rollback/20261103170000_gbp_location_phones.down.sql.
create table gbp_location_phones (
  social_account_id uuid primary key references social_accounts(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  -- A ten-digit North American number as written for the post:
  -- (316) 555-0100, 316-555-0100, 316.555.0100 or 3165550100.
  phone text not null check (phone ~ '^(\([2-9][0-9]{2}\) ?|[2-9][0-9]{2}[ .-]?)[0-9]{3}[ .-]?[0-9]{4}$'),
  source_ref text not null check (length(btrim(source_ref)) between 1 and 500),
  recorded_by uuid references team_members(id),
  recorded_at timestamptz not null default now()
);
create index gbp_location_phones_client on gbp_location_phones (client_id);

-- The account must be one of this client's Business Profile locations (as
-- gbp_location_markets_guard). A signed-in teammate is the recorder; a
-- service or SQL-editor write keeps the recorder it names (or none).
create function gbp_location_phones_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from social_accounts sa where sa.id = new.social_account_id and sa.client_id = new.client_id
                  and sa.platform::text = 'google_business') then
    raise exception 'A location phone belongs to one of this client''s Business Profile locations' using errcode = '23514';
  end if;
  new.recorded_by := coalesce(task_actor(), new.recorded_by);
  new.recorded_at := now();
  return new;
end $$;
revoke all on function gbp_location_phones_guard() from public, anon, authenticated;
create trigger gbp_location_phones_guard before insert or update on gbp_location_phones
  for each row execute function gbp_location_phones_guard();

alter table gbp_location_phones enable row level security;
create policy "team gbp location phones" on gbp_location_phones to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on gbp_location_phones from public, anon, authenticated;
grant select, insert, update, delete on gbp_location_phones to authenticated;
grant select on gbp_location_phones to service_role;

comment on table gbp_location_phones is
  'One Business Profile location''s own phone (team decision in source_ref). post-drafter v10: a post scoped to the location carries this number and may take a Call button; clients.phone is refused there. Not evidence of a staffed office.';
