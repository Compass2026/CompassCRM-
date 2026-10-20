-- Citations Phase 1: provider-neutral listing inventory (docs/citations.md).
-- Additive only. Inserts no client rows; the directory registry is reference
-- data. Nothing here calls a provider, crawls a directory or spends money.
--
-- Three dimensions stay separate on every listing:
--   fulfillment_status   what a provider (or a teammate) reports about a submission
--   verification_status  derived in citation_listing_overview from the latest
--                        dated teammate check AND the identity version it was made
--                        against; an import or a provider never sets it
--   open issues          citation_tasks still open
-- Observations are kept by provenance: source_* is what an import / provider
-- saw (with source_observed_on); a check's observed_* is what a teammate saw.
-- The overview's current_* columns come from the latest check only.
-- A search that finds nothing is recorded as not_found and leaves the listing
-- unverified: absence needs a publisher or owner-dashboard confirmation.

-- ── Business locations: the approved identity per actual business ──────────
-- One row per real business / listing-eligible location. A client with several
-- websites (brand workspaces) does not automatically have several locations.
-- tracking_location_id links the existing rank / GBP / BrightLocal row in
-- `locations`, which carries no address or phone.
create table public.citation_locations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  brand_workspace_id uuid references public.client_brand_workspaces(id) on delete restrict,
  tracking_location_id uuid references public.locations(id) on delete set null,
  label text not null check (length(btrim(label)) between 1 and 120),
  business_name text not null check (length(btrim(business_name)) between 1 and 200),
  address_line1 text not null default '' check (length(address_line1) <= 200),
  address_line2 text not null default '' check (length(address_line2) <= 200),
  city text not null default '' check (length(city) <= 100),
  region text not null default '' check (length(region) <= 50),
  postal_code text not null default '' check (length(postal_code) <= 20),
  country text not null default 'US' check (country ~ '^[A-Z]{2}$'),
  hide_address boolean not null default false,
  phone text not null default '' check (length(phone) <= 40),
  website_url text check (website_url is null or (length(website_url) <= 2000 and website_url ~ '^https?://[^/[:space:]?#]+')),
  status text not null default 'active' check (status in ('active','archived')),
  identity_version integer not null default 1,
  identity_note text not null default '' check (length(identity_note) <= 1000),
  approved_at timestamptz not null default now(),
  approved_by uuid references auth.users(id),
  notes text not null default '' check (length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, label),
  -- A storefront's street is part of its identity; a service-area business may omit it.
  check (hide_address or (btrim(address_line1) <> '' and btrim(city) <> ''))
);
create index citation_locations_client on public.citation_locations(client_id, status, label);
comment on table public.citation_locations is 'Approved business identity per actual location (Citations Phase 1). hide_address: the street must never appear in client or public outputs.';

-- Every approved identity, kept: checks record which version they compared against.
create table public.citation_location_identities (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.citation_locations(id) on delete restrict,
  version integer not null,
  business_name text not null,
  address_line1 text not null,
  address_line2 text not null,
  city text not null,
  region text not null,
  postal_code text not null,
  country text not null,
  hide_address boolean not null,
  phone text not null,
  website_url text,
  note text not null default '',
  recorded_at timestamptz not null default now(),
  recorded_by uuid references auth.users(id),
  unique (location_id, version)
);
comment on table public.citation_location_identities is 'Append-only history of approved location identities, written only by the citation_locations trigger.';

-- ── Directory registry (reference data, shared by every client) ────────────
create table public.citation_directories (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9][a-z0-9_]{1,59}$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  domain text check (domain is null or domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  kind text not null default 'directory' check (kind in ('search_engine','map','aggregator','directory','social','review','niche','other')),
  hidden_address_support text not null default 'unknown' check (hidden_address_support in ('unknown','supported','not_supported')),
  -- Other names and hosts an export uses for this publisher (lowercase), e.g. maps.apple.com for Apple Business Connect.
  aliases text[] not null default '{}' check (aliases::text = lower(aliases::text)),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create unique index citation_directories_name on public.citation_directories(lower(name));
create unique index citation_directories_domain on public.citation_directories(domain) where domain is not null;
comment on table public.citation_directories is 'Publisher registry. hidden_address_support is unknown until confirmed; it is not a provider claim. aliases: other names / hosts imports use for the same publisher.';

insert into public.citation_directories (key, name, domain, kind, aliases) values
  ('google_business_profile', 'Google Business Profile', 'business.google.com', 'search_engine', '{google.com,google,google maps,maps.google.com}'),
  ('apple_business_connect', 'Apple Business Connect', 'businessconnect.apple.com', 'map', '{maps.apple.com,apple maps,apple}'),
  ('bing_places', 'Bing Places', 'bingplaces.com', 'search_engine', '{bing.com,bing,bing maps}'),
  ('facebook', 'Facebook', 'facebook.com', 'social', '{fb.com}');
insert into public.citation_directories (key, name, domain, kind) values
  ('yelp', 'Yelp', 'yelp.com', 'review'),
  ('yellow_pages', 'Yellow Pages', 'yellowpages.com', 'directory'),
  ('mapquest', 'MapQuest', 'mapquest.com', 'map'),
  ('foursquare', 'Foursquare', 'foursquare.com', 'aggregator'),
  ('data_axle', 'Data Axle', 'data-axle.com', 'aggregator'),
  ('localeze', 'Localeze (Neustar)', 'neustarlocaleze.biz', 'aggregator'),
  ('bbb', 'Better Business Bureau', 'bbb.org', 'directory'),
  ('nextdoor', 'Nextdoor', 'nextdoor.com', 'social'),
  ('angi', 'Angi', 'angi.com', 'niche'),
  ('manta', 'Manta', 'manta.com', 'directory'),
  ('superpages', 'Superpages', 'superpages.com', 'directory'),
  ('hotfrog', 'Hotfrog', 'hotfrog.com', 'directory'),
  ('chamber_of_commerce', 'ChamberofCommerce.com', 'chamberofcommerce.com', 'directory');

-- ── Listings ───────────────────────────────────────────────────────────────
-- listing_key: the normalized URL, else the external id, else the one URL-less
-- slot; unique per location and directory, so a repeat import updates instead
-- of duplicating. Several keys for one directory are suspected duplicates.
create function public.citation_listing_key(p_url text, p_external_id text) returns text
language sql immutable set search_path = pg_catalog, public, pg_temp as $$
  select case
    when nullif(btrim(p_url), '') is not null then
      'url:' || regexp_replace(lower(split_part(substring(p_url from '^https?://([^/?#]+)'), ':', 1)), '^www\.', '')
        || regexp_replace(coalesce(substring(p_url from '^https?://[^/?#]+([^?#]*)'), ''), '/+$', '')
        || coalesce(substring(p_url from '^https?://[^?#]*(\?[^#]*)'), '')
    when nullif(btrim(p_external_id), '') is not null then 'ext:' || lower(btrim(p_external_id))
    else 'none' end
$$;

create table public.citation_listings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  location_id uuid not null references public.citation_locations(id) on delete restrict,
  directory_id uuid not null references public.citation_directories(id) on delete restrict,
  listing_url text check (listing_url is null or (length(listing_url) <= 2000 and listing_url ~ '^https?://[^/[:space:]?#@]+')),
  external_id text check (external_id is null or length(btrim(external_id)) between 1 and 200),
  listing_key text not null,
  fulfillment_status text not null default 'none' check (fulfillment_status in ('none','submitted','pending','provider_complete','failed')),
  -- What the import / provider observed (provenance: source_provider, source_observed_on, last_import_id).
  source_name text not null default '' check (length(source_name) <= 300),
  source_address text not null default '' check (length(source_address) <= 500),
  source_phone text not null default '' check (length(source_phone) <= 50),
  source_website text not null default '' check (length(source_website) <= 2000),
  source_provider text check (source_provider is null or source_provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  source_observed_on date,
  last_import_id uuid,
  last_imported_at timestamptz,
  archived boolean not null default false,
  notes text not null default '' check (length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (location_id, directory_id, listing_key)
);
create index citation_listings_client on public.citation_listings(client_id, location_id);
create index citation_listings_directory on public.citation_listings(directory_id);
comment on table public.citation_listings is 'Directory listing inventory. source_* is the import / provider observation; verification is derived from teammate checks in citation_listing_overview, never stored here.';

-- ── Checks: append-only teammate evidence ──────────────────────────────────
create table public.citation_checks (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.citation_listings(id) on delete restrict,
  identity_version integer not null default 0,
  checked_on date not null,
  method text not null check (method in ('visited_url','publisher_search','owner_dashboard','publisher_confirmation','other')),
  result text not null check (result in ('accurate','discrepancy','inaccessible','not_found','confirmed_absent')),
  observed_name text not null default '' check (length(observed_name) <= 300),
  observed_address text not null default '' check (length(observed_address) <= 500),
  observed_phone text not null default '' check (length(observed_phone) <= 50),
  observed_website text not null default '' check (length(observed_website) <= 2000),
  evidence text not null check (length(btrim(evidence)) between 1 and 2000),
  evidence_url text check (evidence_url is null or (length(evidence_url) <= 2000 and evidence_url ~ '^https?://[^/[:space:]?#@]+')),
  recorded_at timestamptz not null default now(),
  recorded_by uuid references auth.users(id),
  -- The method has to be able to support the result (src/lib/citations.ts RESULT_METHODS).
  check (case result
    when 'accurate' then method in ('visited_url','owner_dashboard')
    when 'discrepancy' then method in ('visited_url','owner_dashboard')
    when 'inaccessible' then method in ('visited_url','other')
    when 'not_found' then method in ('publisher_search','other')
    when 'confirmed_absent' then method in ('owner_dashboard','publisher_confirmation') end),
  -- A verdict on the listing's content records at least one thing that was seen.
  check (result not in ('accurate','discrepancy') or btrim(observed_name || observed_address || observed_phone || observed_website) <> '')
);
create index citation_checks_latest on public.citation_checks(listing_id, checked_on desc, recorded_at desc, id desc);
comment on table public.citation_checks is 'Append-only manual evidence. not_found is a search result, never proof of absence. identity_version is the approved identity in effect on checked_on (0 = before any approved identity).';

-- ── Correction / verification queue ────────────────────────────────────────
create table public.citation_tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  location_id uuid not null references public.citation_locations(id) on delete restrict,
  listing_id uuid references public.citation_listings(id) on delete restrict,
  kind text not null check (kind in ('verify','correct','remove_duplicate','create_listing','investigate')),
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  status text not null default 'open' check (status in ('open','in_progress','waiting','resolved','cancelled')),
  assignee_id uuid references public.team_members(id) on delete set null,
  due_on date,
  opened_at timestamptz not null default now(),
  opened_by uuid references auth.users(id),
  resolved_on date,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  resolution text not null default '' check (length(resolution) <= 2000),
  evidence_ref text not null default '' check (length(evidence_ref) <= 2000),
  check_id uuid references public.citation_checks(id) on delete restrict,
  updated_at timestamptz not null default now(),
  check (status not in ('resolved','cancelled') or (resolved_at is not null and btrim(resolution) <> '')),
  check (status <> 'resolved' or (resolved_on is not null and (btrim(evidence_ref) <> '' or check_id is not null)))
);
create unique index citation_tasks_one_open on public.citation_tasks(listing_id, kind) where status in ('open','in_progress','waiting') and listing_id is not null;
create index citation_tasks_client on public.citation_tasks(client_id, status, due_on);
comment on table public.citation_tasks is 'Citation correction and verification tasks. Resolving needs a dated resolution and an evidence reference or a recorded check.';

-- ── Manual fulfillment tracking (never executes an order) ─────────────────
create table public.citation_fulfillment_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  location_id uuid not null references public.citation_locations(id) on delete restrict,
  directory_id uuid not null references public.citation_directories(id) on delete restrict,
  listing_id uuid references public.citation_listings(id) on delete restrict,
  action text not null check (action in ('create','update','remove_duplicate','other')),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  provider_reference text not null default '' check (length(provider_reference) <= 300),
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','submitted','provider_complete','failed','cancelled')),
  approved_budget numeric(12,2) check (approved_budget is null or approved_budget >= 0),
  budget_currency text not null default 'USD' check (budget_currency ~ '^[A-Z]{3}$'),
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  actual_amount numeric(12,2) check (actual_amount is null or actual_amount >= 0),
  actual_currency text not null default 'USD' check (actual_currency ~ '^[A-Z]{3}$'),
  credits_used integer check (credits_used is null or credits_used >= 0),
  notes text not null default '' check (length(notes) <= 2000),
  requested_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status not in ('approved','submitted','provider_complete','failed') or approved_at is not null)
);
create index citation_requests_client on public.citation_fulfillment_requests(client_id, status);
comment on table public.citation_fulfillment_requests is 'Manual record of provider orders. Cash (actual_amount) and prepaid credits (credits_used) are separate; nothing here places an order.';

create table public.citation_credit_entries (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  kind text not null check (kind in ('opening_balance','purchase','adjustment')),
  credits integer not null check (credits <> 0 and (kind = 'adjustment' or credits > 0)),
  cash_amount numeric(12,2) check (cash_amount is null or cash_amount >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  occurred_on date not null,
  reference text not null default '' check (length(reference) <= 300),
  note text not null default '' check (length(note) <= 1000),
  recorded_at timestamptz not null default now(),
  recorded_by uuid references auth.users(id),
  check (kind = 'purchase' or cash_amount is null)
);
comment on table public.citation_credit_entries is 'Append-only prepaid credit ledger (opening balances, purchases with their one-time cash, adjustments). Credits used are recorded on fulfillment requests.';

-- ── Imports: one header per committed file, one outcome per row ───────────
-- Raw rows are never stored: only the row number, a content hash and the outcome.
create table public.citation_imports (
  id uuid primary key,
  client_id uuid not null references public.clients(id) on delete restrict,
  file_name text not null check (length(file_name) between 1 and 300),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  mapping jsonb not null,
  rows_total integer not null check (rows_total >= 0),
  added integer not null, updated integer not null, skipped integer not null, rejected integer not null,
  -- Rows a provider-format preparation routed to review / history instead of the inventory (e.g. a failed or replaced submission).
  held integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  check (added + updated + skipped + rejected + held = rows_total)
);
create index citation_imports_client on public.citation_imports(client_id, created_at desc);
create table public.citation_import_rows (
  import_id uuid not null references public.citation_imports(id) on delete restrict,
  row_number integer not null check (row_number >= 2),
  row_hash text not null default '',
  outcome text not null check (outcome in ('added','updated','skipped','rejected','held')),
  listing_id uuid references public.citation_listings(id) on delete restrict,
  message text not null default '' check (length(message) <= 500),
  primary key (import_id, row_number)
);
comment on table public.citation_imports is 'Mapped CSV imports. Untrusted input: credential columns are refused before this point, raw rows are not kept.';

-- ── Guards ─────────────────────────────────────────────────────────────────
create function public.guard_citation_location() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'Archive a location instead of deleting it.' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' and (new.id, new.client_id, new.created_at) is distinct from (old.id, old.client_id, old.created_at) then
    raise exception 'A location stays with its client.' using errcode = '23514';
  end if;
  if new.brand_workspace_id is not null and not exists (select 1 from public.client_brand_workspaces where id = new.brand_workspace_id and client_id = new.client_id) then
    raise exception 'Brand workspace belongs to another client.' using errcode = '23514';
  end if;
  if new.tracking_location_id is not null and not exists (select 1 from public.locations where id = new.tracking_location_id and client_id = new.client_id) then
    raise exception 'Tracking location belongs to another client.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    new.identity_version := 1; new.created_at := clock_timestamp();
    new.approved_at := clock_timestamp(); new.approved_by := auth.uid();
  elsif (new.business_name, new.address_line1, new.address_line2, new.city, new.region, new.postal_code, new.country, new.hide_address, new.phone, new.website_url)
    is distinct from (old.business_name, old.address_line1, old.address_line2, old.city, old.region, old.postal_code, old.country, old.hide_address, old.phone, old.website_url) then
    if btrim(new.identity_note) = '' or new.identity_note = old.identity_note then
      raise exception 'Say why the approved identity changed.' using errcode = '23514';
    end if;
    new.identity_version := old.identity_version + 1;
    new.approved_at := clock_timestamp(); new.approved_by := auth.uid();
  else
    new.identity_version := old.identity_version; new.approved_at := old.approved_at; new.approved_by := old.approved_by;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
create trigger guard_citation_location before insert or update or delete on public.citation_locations
for each row execute function public.guard_citation_location();

create function public.record_citation_identity() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.identity_version <> old.identity_version then
    insert into public.citation_location_identities (location_id, version, business_name, address_line1, address_line2, city, region,
      postal_code, country, hide_address, phone, website_url, note, recorded_by)
    values (new.id, new.identity_version, new.business_name, new.address_line1, new.address_line2, new.city, new.region,
      new.postal_code, new.country, new.hide_address, new.phone, new.website_url, new.identity_note, auth.uid());
  end if;
  return null;
end $$;
create trigger record_citation_identity after insert or update on public.citation_locations
for each row execute function public.record_citation_identity();

create function public.guard_append_only() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception '% is append-only.', tg_table_name using errcode = '23514';
end $$;
create trigger citation_identities_append_only before update or delete on public.citation_location_identities
for each row execute function public.guard_append_only();
create trigger citation_credit_entries_append_only before update or delete on public.citation_credit_entries
for each row execute function public.guard_append_only();
create trigger citation_imports_append_only before update or delete on public.citation_imports
for each row execute function public.guard_append_only();
create trigger citation_import_rows_append_only before update or delete on public.citation_import_rows
for each row execute function public.guard_append_only();

create function public.guard_citation_listing() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'Archive a listing instead of deleting it.' using errcode = '23514'; end if;
  if not exists (select 1 from public.citation_locations where id = new.location_id and client_id = new.client_id) then
    raise exception 'Location belongs to another client.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    new.listing_key := public.citation_listing_key(new.listing_url, new.external_id);
    new.created_at := clock_timestamp(); new.created_by := auth.uid();
  else
    if (new.id, new.client_id, new.location_id, new.directory_id, new.listing_url, new.listing_key, new.created_at, new.created_by)
      is distinct from (old.id, old.client_id, old.location_id, old.directory_id, old.listing_url, old.listing_key, old.created_at, old.created_by) then
      raise exception 'A listing''s location, directory and URL are fixed. Record a new listing for a different URL.' using errcode = '23514';
    end if;
    if old.listing_key like 'ext:%' and new.external_id is distinct from old.external_id then
      raise exception 'This listing is identified by its external id, which is fixed.' using errcode = '23514';
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
create trigger guard_citation_listing before insert or update or delete on public.citation_listings
for each row execute function public.guard_citation_listing();

create function public.guard_citation_check() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op <> 'INSERT' then raise exception 'Checks are append-only. Record a new check.' using errcode = '23514'; end if;
  if new.checked_on > (current_timestamp at time zone 'America/Chicago')::date then
    raise exception 'A check cannot be dated in the future.' using errcode = '23514';
  end if;
  -- The identity in effect on the day of the check: a check dated before an
  -- identity change never counts as evaluating the new identity, and one dated
  -- before any approved identity is version 0 (it needs reverification).
  select coalesce(max(i.version), 0) into new.identity_version
  from public.citation_listings x join public.citation_location_identities i on i.location_id = x.location_id
  where x.id = new.listing_id and (i.recorded_at at time zone 'America/Chicago')::date <= new.checked_on;
  new.recorded_at := clock_timestamp(); new.recorded_by := auth.uid();
  return new;
end $$;
create trigger guard_citation_check before insert or update or delete on public.citation_checks
for each row execute function public.guard_citation_check();


create function public.guard_citation_task() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'Cancel a task instead of deleting it.' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' and (new.id, new.client_id, new.location_id, new.listing_id, new.kind, new.opened_at, new.opened_by)
    is distinct from (old.id, old.client_id, old.location_id, old.listing_id, old.kind, old.opened_at, old.opened_by) then
    raise exception 'A task''s listing and kind are fixed. Open a new task.' using errcode = '23514';
  end if;
  if not exists (select 1 from public.citation_locations where id = new.location_id and client_id = new.client_id) then
    raise exception 'Location belongs to another client.' using errcode = '23514';
  end if;
  if new.listing_id is not null and not exists (select 1 from public.citation_listings where id = new.listing_id and location_id = new.location_id) then
    raise exception 'Listing belongs to another location.' using errcode = '23514';
  end if;
  if new.check_id is not null and not exists (select 1 from public.citation_checks where id = new.check_id and listing_id = new.listing_id) then
    raise exception 'The evidence check belongs to another listing.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.status not in ('open','in_progress','waiting') then raise exception 'A new task starts open.' using errcode = '23514'; end if;
    new.opened_at := clock_timestamp(); new.opened_by := auth.uid();
  end if;
  if new.status in ('resolved','cancelled') then
    if tg_op = 'INSERT' or old.status not in ('resolved','cancelled') then
      new.resolved_at := clock_timestamp(); new.resolved_by := auth.uid();
    end if;
    if new.status = 'resolved' and (new.resolved_on > (current_timestamp at time zone 'America/Chicago')::date
      or new.resolved_on < (new.opened_at at time zone 'America/Chicago')::date) then
      raise exception 'The resolution date must be between the day the task opened and today.' using errcode = '23514';
    end if;
  else
    -- Reopened: the previous resolution is cleared from the open record.
    new.resolved_at := null; new.resolved_by := null; new.resolved_on := null; new.resolution := ''; new.check_id := null;
    if tg_op = 'UPDATE' then new.evidence_ref := case when old.status in ('resolved','cancelled') then '' else new.evidence_ref end; end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
create trigger guard_citation_task before insert or update or delete on public.citation_tasks
for each row execute function public.guard_citation_task();

-- Approval of a request (and any budget change after it) is an admin's;
-- an order is only ever recorded here, never placed.
create function public.guard_citation_request() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare was_approved boolean := tg_op = 'UPDATE' and old.approved_at is not null;
begin
  if tg_op = 'DELETE' then raise exception 'Cancel a request instead of deleting it.' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' and (new.id, new.client_id, new.location_id, new.directory_id, new.listing_id, new.action, new.created_at, new.requested_by)
    is distinct from (old.id, old.client_id, old.location_id, old.directory_id, old.listing_id, old.action, old.created_at, old.requested_by) then
    raise exception 'A request''s target is fixed. Record a new request.' using errcode = '23514';
  end if;
  if not exists (select 1 from public.citation_locations where id = new.location_id and client_id = new.client_id) then
    raise exception 'Location belongs to another client.' using errcode = '23514';
  end if;
  if new.listing_id is not null and not exists (select 1 from public.citation_listings where id = new.listing_id
    and location_id = new.location_id and directory_id = new.directory_id) then
    raise exception 'Listing belongs to another location or directory.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.status not in ('draft','pending_approval') then raise exception 'A request starts as a draft or pending approval.' using errcode = '23514'; end if;
    new.approved_at := null; new.approved_by := null;
    new.created_at := clock_timestamp(); new.requested_by := auth.uid();
  else
    if new.status = 'approved' and old.status in ('draft','pending_approval') then
      if not public.is_team_admin() then raise exception 'Only an admin can approve a fulfillment request.' using errcode = '42501'; end if;
      new.approved_at := clock_timestamp(); new.approved_by := auth.uid();
    elsif new.status in ('draft','pending_approval') then
      new.approved_at := null; new.approved_by := null;
    else
      new.approved_at := old.approved_at; new.approved_by := old.approved_by;
    end if;
    if was_approved and (new.approved_budget, new.budget_currency) is distinct from (old.approved_budget, old.budget_currency) and not public.is_team_admin() then
      raise exception 'Only an admin can change an approved budget.' using errcode = '42501';
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
create trigger guard_citation_request before insert or update or delete on public.citation_fulfillment_requests
for each row execute function public.guard_citation_request();

-- A request's provider outcome is the listing's fulfillment status (never its verification).
create function public.mirror_citation_request() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.listing_id is not null and new.status in ('submitted','provider_complete','failed')
    and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    update public.citation_listings set fulfillment_status = new.status where id = new.listing_id;
  end if;
  return null;
end $$;
create trigger mirror_citation_request after insert or update on public.citation_fulfillment_requests
for each row execute function public.mirror_citation_request();

create function public.stamp_citation_entry() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  new.recorded_at := clock_timestamp(); new.recorded_by := auth.uid();
  return new;
end $$;
create trigger stamp_citation_credit_entry before insert on public.citation_credit_entries
for each row execute function public.stamp_citation_entry();
create function public.stamp_citation_directory() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then new.created_at := clock_timestamp(); new.created_by := auth.uid();
  elsif (new.id, new.key, new.created_at, new.created_by) is distinct from (old.id, old.key, old.created_at, old.created_by) then
    raise exception 'A directory key is fixed.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger stamp_citation_directory before insert or update on public.citation_directories
for each row execute function public.stamp_citation_directory();

-- ── Import ─────────────────────────────────────────────────────────────────
-- p_rows: rows already validated by src/lib/citations.ts prepareImport;
-- p_rejected: the rows it refused; p_held: rows a provider-format preparation
-- routed to review / history (never listings). Everything is re-checked against this
-- client here. p_commit = false runs the identical path and rolls it back
-- (the preview). Committing an import id twice returns the first result.
-- Security invoker: RLS and the guards above apply to the caller.
create function public.citation_import(p_import jsonb, p_rows jsonb, p_rejected jsonb, p_commit boolean, p_held jsonb default '[]') returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
  v_client uuid := (p_import->>'client_id')::uuid;
  v_import uuid := (p_import->>'id')::uuid;
  v_provider text := p_import->>'provider';
  v_create boolean := coalesce((p_import->>'create_directories')::boolean, false);
  r jsonb; v_dir uuid; v_key text; v_listing public.citation_listings; v_id uuid;
  v_seen jsonb := '{}'; v_out jsonb := '[]'; v_outcome text; v_message text;
  v_name text; v_domain text; v_slug text;
  v_fs text; v_on date; v_changed boolean;
  n_add int := 0; n_upd int := 0; n_skip int := 0; n_rej int := 0; n_held int := 0;
  v_new jsonb := '[]'; v_created uuid;
  v_result jsonb;
begin
  if not public.is_team() then raise exception 'Only Compass team members can import citations.' using errcode = '42501'; end if;
  if v_client is null or v_import is null then raise exception 'Import id and client are required.' using errcode = '22023'; end if;
  if not exists (select 1 from public.clients where id = v_client) then raise exception 'Client unavailable.' using errcode = '42501'; end if;
  if p_commit then
    select jsonb_build_object('import_id', id, 'committed', true, 'already_committed', true, 'rows_total', rows_total, 'added', added,
      'updated', updated, 'skipped', skipped, 'rejected', rejected, 'held', held, 'new_directories', '[]'::jsonb,
      'rows', (select coalesce(jsonb_agg(jsonb_build_object('row_number', row_number, 'outcome', outcome, 'listing_id', listing_id, 'message', message) order by row_number), '[]')
        from public.citation_import_rows where import_id = i.id))
    into v_result from public.citation_imports i where id = v_import and client_id = v_client;
    if v_result is not null then return v_result; end if;
    if exists (select 1 from public.citation_imports where id = v_import) then
      raise exception 'This import id belongs to another client.' using errcode = '42501';
    end if;
  end if;

  begin
    for r in select value from jsonb_array_elements(coalesce(p_rows, '[]')) order by (value->>'row_number')::int loop
      v_outcome := null; v_message := ''; v_id := null;
      begin
        if not exists (select 1 from public.citation_locations where id = (r->>'location_id')::uuid and client_id = v_client and status = 'active') then
          v_outcome := 'rejected'; v_message := 'Location is not an active business location of this client.';
        else
          v_name := btrim(r->>'directory');
          select id into v_dir from public.citation_directories
          where lower(name) = lower(v_name) or key = lower(v_name) or domain = regexp_replace(lower(v_name), '^www\.', '')
            or regexp_replace(lower(v_name), '^www\.', '') = any(aliases) limit 1;
          if v_dir is null and nullif(r->>'listing_url', '') is not null then
            v_domain := regexp_replace(lower(substring(r->>'listing_url' from '^https?://([^/?#:]+)')), '^www\.', '');
            select id into v_dir from public.citation_directories where domain = v_domain or v_domain = any(aliases)
              or v_domain like '%.' || domain limit 1;
          end if;
          if v_dir is null and v_create then
            v_slug := left(regexp_replace(regexp_replace(lower(v_name), '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g'), 60);
            if length(v_slug) < 2 then v_slug := 'directory_' || substr(md5(v_name), 1, 8); end if;
            v_created := null;
            insert into public.citation_directories (key, name, domain, kind)
            values (v_slug, left(v_name, 120), case when lower(v_name) ~ '^[a-z0-9.-]+\.[a-z]{2,}$' then regexp_replace(lower(v_name), '^www\.', '') end, 'other')
            on conflict do nothing returning id into v_created;
            v_dir := v_created;
            if v_dir is null then select id into v_dir from public.citation_directories where key = v_slug or lower(name) = lower(v_name) limit 1; end if;
          end if;
          if v_dir is null then
            v_outcome := 'rejected'; v_message := format('Unknown directory "%s". Add it to the registry or allow new directories.', left(v_name, 80));
          else
            v_key := public.citation_listing_key(nullif(r->>'listing_url', ''), nullif(r->>'external_id', ''));
            if v_seen ? ((r->>'location_id') || '|' || v_dir || '|' || v_key) then
              v_outcome := 'rejected'; v_message := format('Same listing as row %s in this file.', v_seen->>((r->>'location_id') || '|' || v_dir || '|' || v_key));
            else
              v_seen := v_seen || jsonb_build_object((r->>'location_id') || '|' || v_dir || '|' || v_key, r->>'row_number');
              select * into v_listing from public.citation_listings
              where location_id = (r->>'location_id')::uuid and directory_id = v_dir and listing_key = v_key;
              v_fs := nullif(r->>'fulfillment_status', '');
              v_on := nullif(r->>'source_observed_on', '')::date;
              if v_listing.id is null then
                insert into public.citation_listings (client_id, location_id, directory_id, listing_url, external_id, fulfillment_status,
                  source_name, source_address, source_phone, source_website, source_provider, source_observed_on, last_import_id, last_imported_at, notes)
                values (v_client, (r->>'location_id')::uuid, v_dir, nullif(r->>'listing_url', ''), nullif(r->>'external_id', ''), coalesce(v_fs, 'none'),
                  coalesce(r->>'observed_name', ''), coalesce(r->>'observed_address', ''), coalesce(r->>'observed_phone', ''), coalesce(r->>'observed_website', ''),
                  v_provider, v_on, v_import, now(), coalesce(r->>'notes', ''))
                returning id into v_id;
                v_outcome := 'added';
              elsif v_on is not null and v_listing.source_observed_on is not null and v_on < v_listing.source_observed_on then
                v_id := v_listing.id; v_outcome := 'skipped'; v_message := 'Older than the observation already recorded.';
              else
                v_id := v_listing.id;
                v_changed := (coalesce(v_fs, v_listing.fulfillment_status), coalesce(nullif(r->>'observed_name', ''), v_listing.source_name),
                    coalesce(nullif(r->>'observed_address', ''), v_listing.source_address), coalesce(nullif(r->>'observed_phone', ''), v_listing.source_phone),
                    coalesce(nullif(r->>'observed_website', ''), v_listing.source_website), coalesce(v_on, v_listing.source_observed_on),
                    coalesce(nullif(r->>'external_id', ''), v_listing.external_id), coalesce(nullif(r->>'notes', ''), v_listing.notes))
                  is distinct from (v_listing.fulfillment_status, v_listing.source_name, v_listing.source_address, v_listing.source_phone,
                    v_listing.source_website, v_listing.source_observed_on, v_listing.external_id, v_listing.notes);
                if v_changed then
                  update public.citation_listings set
                    fulfillment_status = coalesce(v_fs, fulfillment_status),
                    source_name = coalesce(nullif(r->>'observed_name', ''), source_name),
                    source_address = coalesce(nullif(r->>'observed_address', ''), source_address),
                    source_phone = coalesce(nullif(r->>'observed_phone', ''), source_phone),
                    source_website = coalesce(nullif(r->>'observed_website', ''), source_website),
                    source_observed_on = coalesce(v_on, source_observed_on),
                    external_id = case when listing_key like 'ext:%' then external_id else coalesce(nullif(r->>'external_id', ''), external_id) end,
                    notes = coalesce(nullif(r->>'notes', ''), notes),
                    source_provider = v_provider, last_import_id = v_import, last_imported_at = now()
                  where id = v_id;
                  v_outcome := 'updated';
                else
                  v_outcome := 'skipped'; v_message := 'Unchanged.';
                end if;
              end if;
            end if;
          end if;
        end if;
      exception when others then
        v_outcome := 'rejected'; v_message := left('Not saved: ' || sqlerrm, 500); v_id := null;
      end;
      -- A directory created for a row that then failed is rolled back with it; only kept ones are reported.
      if v_created is not null and v_outcome <> 'rejected' and not v_new ? left(v_name, 120) then v_new := v_new || to_jsonb(left(v_name, 120)); end if;
      v_created := null;
      case v_outcome when 'added' then n_add := n_add + 1; when 'updated' then n_upd := n_upd + 1; when 'skipped' then n_skip := n_skip + 1; else n_rej := n_rej + 1; end case;
      v_out := v_out || jsonb_build_object('row_number', (r->>'row_number')::int, 'row_hash', coalesce(r->>'row_hash', ''), 'outcome', v_outcome,
        'listing_id', case when v_outcome = 'rejected' then null else v_id end, 'message', v_message);
    end loop;
    for r in select value from jsonb_array_elements(coalesce(p_rejected, '[]')) loop
      n_rej := n_rej + 1;
      v_out := v_out || jsonb_build_object('row_number', (r->>'row_number')::int, 'row_hash', '', 'outcome', 'rejected', 'listing_id', null, 'message', left(coalesce(r->>'reason', 'Invalid row.'), 500));
    end loop;
    for r in select value from jsonb_array_elements(coalesce(p_held, '[]')) loop
      n_held := n_held + 1;
      v_out := v_out || jsonb_build_object('row_number', (r->>'row_number')::int, 'row_hash', '', 'outcome', 'held', 'listing_id', null, 'message', left(coalesce(r->>'reason', 'Held for review.'), 500));
    end loop;
    select coalesce(jsonb_agg(value order by (value->>'row_number')::int), '[]') into v_out from jsonb_array_elements(v_out);
    if p_commit then
      insert into public.citation_imports (id, client_id, file_name, file_sha256, provider, mapping, rows_total, added, updated, skipped, rejected, held, created_by)
      values (v_import, v_client, left(coalesce(p_import->>'file_name', 'import.csv'), 300), p_import->>'file_sha256', v_provider,
        coalesce(p_import->'mapping', '{}'), n_add + n_upd + n_skip + n_rej + n_held, n_add, n_upd, n_skip, n_rej, n_held, auth.uid());
      insert into public.citation_import_rows (import_id, row_number, row_hash, outcome, listing_id, message)
      select v_import, (value->>'row_number')::int, value->>'row_hash', value->>'outcome', (value->>'listing_id')::uuid, value->>'message'
      from jsonb_array_elements(v_out);
    else
      raise exception using errcode = 'CIT01', message = 'preview';
    end if;
  exception when sqlstate 'CIT01' then
    null; -- preview: every write above is rolled back; the counts are kept
  end;
  return jsonb_build_object('import_id', v_import, 'committed', p_commit, 'already_committed', false, 'rows_total', n_add + n_upd + n_skip + n_rej + n_held,
    'added', n_add, 'updated', n_upd, 'skipped', n_skip, 'rejected', n_rej, 'held', n_held, 'new_directories', v_new, 'rows', v_out);
end $$;

-- ── Read models (invoker: RLS applies) ─────────────────────────────────────
-- The one current-evidence projection read by the overview, the location
-- page and the CSV. Current verification needs the latest check (by date,
-- then entry time) AND that it was made against the location's current
-- identity; otherwise it is needs_reverification. current_* are that check's
-- observations, and only for a verdict on the listing's content (accurate /
-- discrepancy): inaccessible, not found and confirmed absent observe nothing.
-- A blank current_* field means "not recorded in that check"; the import's
-- source_* values are never relabelled as checked.
create view public.citation_listing_overview with (security_invoker = true) as
select x.id, x.client_id, x.location_id, x.directory_id, x.listing_url, x.external_id, x.listing_key, x.fulfillment_status,
  x.source_name, x.source_address, x.source_phone, x.source_website, x.source_provider, x.source_observed_on,
  x.last_import_id, x.last_imported_at, x.archived, x.notes, x.created_at, x.updated_at, x.created_by,
  d.name as directory_name, d.key as directory_key, l.label as location_label, l.hide_address, l.identity_version, c.name as client_name,
  k.id as last_check_id, k.checked_on as last_checked_on, k.result as last_check_result, k.method as last_check_method,
  k.identity_version as check_identity_version,
  case when k.id is null then 'unverified'
       when k.identity_version <> l.identity_version then 'needs_reverification'
       when k.result = 'accurate' then 'verified_accurate'
       when k.result = 'discrepancy' then 'discrepancy'
       when k.result = 'inaccessible' then 'inaccessible'
       when k.result = 'confirmed_absent' then 'confirmed_absent'
       else 'unverified' end as verification_status,
  case when k.result in ('accurate','discrepancy') then k.observed_name else '' end as current_name,
  case when k.result in ('accurate','discrepancy') then k.observed_address else '' end as current_address,
  case when k.result in ('accurate','discrepancy') then k.observed_phone else '' end as current_phone,
  case when k.result in ('accurate','discrepancy') then k.observed_website else '' end as current_website,
  (select count(*) from public.citation_tasks t where t.listing_id = x.id and t.status in ('open','in_progress','waiting'))::int as open_tasks,
  x.listing_key <> 'none' and count(*) filter (where x.listing_key <> 'none') over (partition by x.location_id, x.directory_id) > 1 as suspected_duplicate
from public.citation_listings x
join public.citation_directories d on d.id = x.directory_id
join public.citation_locations l on l.id = x.location_id
join public.clients c on c.id = x.client_id
left join lateral (select * from public.citation_checks k where k.listing_id = x.id
  order by k.checked_on desc, k.recorded_at desc, k.id desc limit 1) k on true
where not x.archived;

create view public.citation_credit_balances with (security_invoker = true) as
select p.provider,
  coalesce((select sum(credits) from public.citation_credit_entries e where e.provider = p.provider), 0)::int as credits_recorded,
  coalesce((select sum(credits_used) from public.citation_fulfillment_requests r where r.provider = p.provider), 0)::int as credits_used,
  coalesce((select sum(cash_amount) from public.citation_credit_entries e where e.provider = p.provider and kind = 'purchase'), 0) as credit_purchase_cash
from (select provider from public.citation_credit_entries union select provider from public.citation_fulfillment_requests where credits_used is not null) p;

-- ── Access: team only, no portal, no anon ─────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['citation_locations', 'citation_location_identities', 'citation_directories', 'citation_listings', 'citation_checks',
    'citation_tasks', 'citation_fulfillment_requests', 'citation_credit_entries', 'citation_imports', 'citation_import_rows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "team %s" on public.%I to authenticated using ((select public.is_team())) with check ((select public.is_team()))', t, t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;
grant select, insert, update on public.citation_locations, public.citation_directories, public.citation_listings,
  public.citation_tasks, public.citation_fulfillment_requests to authenticated;
grant select, insert on public.citation_checks, public.citation_credit_entries, public.citation_imports, public.citation_import_rows to authenticated;
grant select on public.citation_location_identities to authenticated;
revoke all on public.citation_listing_overview, public.citation_credit_balances from public, anon, authenticated;
grant select on public.citation_listing_overview, public.citation_credit_balances to authenticated;

revoke all on function public.citation_import(jsonb, jsonb, jsonb, boolean, jsonb) from public, anon;
grant execute on function public.citation_import(jsonb, jsonb, jsonb, boolean, jsonb) to authenticated;
revoke all on function public.citation_listing_key(text, text) from public, anon;
grant execute on function public.citation_listing_key(text, text) to authenticated;
revoke all on function public.guard_citation_location(), public.record_citation_identity(), public.guard_append_only(), public.guard_citation_listing(),
  public.guard_citation_check(), public.guard_citation_task(), public.guard_citation_request(),
  public.mirror_citation_request(), public.stamp_citation_entry(), public.stamp_citation_directory() from public, anon, authenticated;
