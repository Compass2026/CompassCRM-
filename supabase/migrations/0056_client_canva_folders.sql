-- Canva folder mapping, step 1 (Sept 28 2026): the client record carries the
-- ids of its Canva folders. Database only; enables nothing, syncs nothing,
-- and changes nothing in Canva.
--
-- Each Compass client keeps its designs in a primary Canva folder with one
-- "Used" subfolder inside it. The reconciliation of Sept 28 2026 (read-only,
-- through the Canva connector) matched every active client to exactly one of
-- each, by the folder's parent rather than its name, and Tom confirmed the
-- two matches whose names differ (Show Me Design → "ShowMe Design+Build",
-- Show Me Electrical → "Show Me Electric", whose Used subfolder is the
-- generic "Show Me Used").
--
-- 1. clients.canva_folder_id and clients.canva_used_folder_id (text, both
--    nullable: a client without Canva has neither). The Canva folder id is
--    the integration key. Folder names are display labels in Canva and are
--    never stored or matched here. An id must look like a Canva folder id
--    ("FA" + 6-62 url-safe characters), which refuses a folder name, Canva's
--    pseudo-folders ("root", "uploads") and design / template ids. A Used
--    folder needs a primary folder and must differ from it.
-- 2. No two live clients (any status but offboarded) share a folder:
--    - partial unique indexes on each column (the race-proof backstop), and
--    - clients_canva_folders_guard, which also refuses one client's primary
--      folder as another's Used folder (and the reverse), serialises writers
--      of the same id with a transaction advisory lock, and names the client
--      that already holds it (SQLSTATE 23505).
--    An offboarded client keeps its ids for the record; they no longer
--    count, and reactivating it is refused while a live client holds them.
-- 3. client_canva_folders(p_client_id default null): the read model the
--    Creative Engine will use (invoker rights, so RLS decides; team and the
--    service role only). client_intelligence_input and authority_input are
--    deliberately NOT extended: Authority fingerprints the whole
--    intelligence document, so adding fields there would mark every run
--    stale, and the Drafter's brief does not need them.
-- 4. Backfill of the eight confirmed active clients, matched by client id
--    only. The fictional, offboarded Compass Activation Test client and
--    every Canva-only folder stay unmapped. On a database without these
--    clients (the sandbox replay, a fresh project) nothing is seeded; a
--    partial set, an offboarded client or an existing different mapping
--    aborts the migration.
--
-- Nothing reads these columns yet besides the read model: no Canva asset
-- sync, no design moves, no creative generation or publishing.
--
-- Rollback: drop function client_canva_folders(uuid); drop trigger
-- clients_canva_folders_guard on clients; drop function
-- clients_canva_folders_guard(); drop index clients_canva_folder_id_live,
-- clients_canva_used_folder_id_live; alter table clients drop column
-- canva_used_folder_id, drop column canva_folder_id.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'clients'
               and column_name in ('canva_folder_id', 'canva_used_folder_id')) then
    raise exception '0056: clients already carries a Canva folder column';
  end if;
end $$;

-- ── 1. Columns ──────────────────────────────────────────────────────────────
alter table clients
  add column canva_folder_id text,
  add column canva_used_folder_id text,
  add constraint clients_canva_folder_id_format check (
    canva_folder_id is null or canva_folder_id ~ '^FA[A-Za-z0-9_-]{6,62}$'),
  add constraint clients_canva_used_folder_id_format check (
    canva_used_folder_id is null or canva_used_folder_id ~ '^FA[A-Za-z0-9_-]{6,62}$'),
  add constraint clients_canva_used_needs_primary check (
    canva_used_folder_id is null or canva_folder_id is not null),
  add constraint clients_canva_folders_distinct check (
    canva_used_folder_id is null or canva_used_folder_id <> canva_folder_id);
comment on column clients.canva_folder_id is
  'Id of the client''s primary Canva folder (the integration key; the folder''s name is display only). Null: the client does not use Canva. Unique among clients that are not offboarded (0056).';
comment on column clients.canva_used_folder_id is
  'Id of the client''s "Used" subfolder inside its primary Canva folder. Needs canva_folder_id; unique among clients that are not offboarded (0056).';

-- ── 2. No shared folders between live clients ───────────────────────────────
create unique index clients_canva_folder_id_live on clients (canva_folder_id)
  where canva_folder_id is not null and status <> 'offboarded';
create unique index clients_canva_used_folder_id_live on clients (canva_used_folder_id)
  where canva_used_folder_id is not null and status <> 'offboarded';

-- Security definer so the check sees every client whatever the writer's RLS.
create function clients_canva_folders_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_id text;
  v_other text;
begin
  if new.status = 'offboarded' or (new.canva_folder_id is null and new.canva_used_folder_id is null) then
    return new;
  end if;
  -- One lock per folder id, in a fixed order, shared by both columns.
  perform pg_advisory_xact_lock(hashtextextended('compass.canva_folder:' || x, 0))
  from (select distinct unnest(array[new.canva_folder_id, new.canva_used_folder_id]) as x) ids
  where x is not null order by x;
  foreach v_id in array array[new.canva_folder_id, new.canva_used_folder_id] loop
    continue when v_id is null;
    select c.name into v_other from clients c
    where c.id <> new.id and c.status <> 'offboarded'
      and (c.canva_folder_id = v_id or c.canva_used_folder_id = v_id)
    order by c.name limit 1;
    if found then
      raise exception 'Canva folder % is already mapped to client "%"', v_id, v_other
        using errcode = '23505', hint = 'A Canva folder belongs to one live client. Offboard or unmap the other client first.';
    end if;
  end loop;
  return new;
end $$;
revoke all on function clients_canva_folders_guard() from public, anon, authenticated;
create trigger clients_canva_folders_guard
  before insert or update of canva_folder_id, canva_used_folder_id, status on clients
  for each row execute function clients_canva_folders_guard();

-- ── 3. Read model ───────────────────────────────────────────────────────────
-- One client (any status, so the caller sees why it is not usable) or every
-- client that is not offboarded. canva_enabled: a primary folder and a live
-- client. Invoker rights: a portal contact, a stranger and anon see nothing.
create function client_canva_folders(p_client_id uuid default null)
returns table (client_id uuid, client_name text, client_status text,
               canva_folder_id text, canva_used_folder_id text, canva_enabled boolean)
language sql stable security invoker set search_path = public as $$
  select c.id, c.name, c.status::text, c.canva_folder_id, c.canva_used_folder_id,
         c.canva_folder_id is not null and c.status <> 'offboarded'
  from clients c
  where case when p_client_id is null then c.status <> 'offboarded' else c.id = p_client_id end
  order by c.name, c.id
$$;
comment on function client_canva_folders(uuid) is
  'The Canva folder ids of one client, or of every client that is not offboarded (0056). Ids are the integration keys; names are never matched.';
revoke all on function client_canva_folders(uuid) from public, anon;
grant execute on function client_canva_folders(uuid) to authenticated, service_role;

-- ── 4. Backfill: the confirmed reconciliation of Sept 28 2026 ───────────────
-- Matched on client id only; the name column documents the row.
create temp table canva_folder_seed (
  client_id uuid primary key, client_name text not null,
  canva_folder_id text not null unique, canva_used_folder_id text not null unique
) on commit drop;
insert into canva_folder_seed (client_id, client_name, canva_folder_id, canva_used_folder_id) values
  ('3eaa3389-2a33-4004-837c-8aef90404410', 'BHG Safety Partners',         'FAHWhNkklNQ', 'FAHWhHij2r8'),
  ('db9009c2-a04b-4e93-843f-e20c49263b5b', 'Ginger Huff Interiors',       'FAFkWjGulG4', 'FAF50sDs_zY'),
  ('70211d71-d9f4-46ab-abe2-ef39c41591fb', 'Logic Solar',                 'FAF3N2KiA2c', 'FAF50jAeWzI'),
  ('102d3b20-2795-44ae-bd64-d1e43916291c', 'Lucas Construction',          'FAFgsbtQBMU', 'FAF50gfFIFo'),
  ('1e12fc47-731a-4d84-a4f1-4aed777db451', 'Pensacola Equipment Rentals', 'FAFm0L4SN3I', 'FAF50oq0gLs'),
  ('a88f5ce2-30ac-508b-b217-cf22d277b278', 'Shewmaker Brothers Masonry',  'FAHWhKRTBmM', 'FAHWhFz-WfY'),
  ('d94cfde2-0751-4002-a149-c83b4c6c956d', 'Show Me Design',              'FAF1yAflBAI', 'FAF50vURLLI'),
  ('9a8e05f5-3d28-4839-9735-79bcdd0e277d', 'Show Me Electrical',          'FAFmufa_fQo', 'FAF50si5M04');

do $$
declare
  v_expected int := (select count(*) from canva_folder_seed);
  v_found int := (select count(*) from clients c join canva_folder_seed s on s.client_id = c.id);
begin
  if v_found = 0 then
    raise notice '0056: none of the confirmed clients exist here; no Canva folders seeded';
    return;
  end if;
  if v_found <> v_expected then
    raise exception '0056: % of the % confirmed clients exist; refusing a partial Canva seed', v_found, v_expected;
  end if;
  if exists (select 1 from clients c join canva_folder_seed s on s.client_id = c.id where c.status = 'offboarded') then
    raise exception '0056: a confirmed client is offboarded; the reconciliation mapped active clients only';
  end if;
  if exists (select 1 from clients c join canva_folder_seed s on s.client_id = c.id
             where (c.canva_folder_id, c.canva_used_folder_id) is distinct from (null::text, null::text)
               and (c.canva_folder_id, c.canva_used_folder_id) is distinct from (s.canva_folder_id, s.canva_used_folder_id)) then
    raise exception '0056: a confirmed client already carries a different Canva mapping';
  end if;

  update clients c set canva_folder_id = s.canva_folder_id, canva_used_folder_id = s.canva_used_folder_id
  from canva_folder_seed s
  where c.id = s.client_id
    and (c.canva_folder_id, c.canva_used_folder_id) is distinct from (s.canva_folder_id, s.canva_used_folder_id);

  if (select count(*) from clients c join canva_folder_seed s on s.client_id = c.id
      where c.canva_folder_id = s.canva_folder_id and c.canva_used_folder_id = s.canva_used_folder_id) <> v_expected then
    raise exception '0056: the Canva seed did not land on every confirmed client';
  end if;
  if exists (select 1 from clients c where c.canva_folder_id is not null
             and not exists (select 1 from canva_folder_seed s where s.client_id = c.id)) then
    raise exception '0056: a client outside the confirmed set carries a Canva folder';
  end if;
end $$;
