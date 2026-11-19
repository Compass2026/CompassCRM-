-- Citations follow-up from the Logic Overland Park pilot audit (docs/citations.md,
-- "Listing enrichment" and "Field-level checks"). Additive: no client row is
-- changed. Existing checks keep their verdicts and evidence; their field
-- coverage is 'unrecorded' and is never inferred. The only rows written are the
-- key history, which copies each listing's current key (and external id).
--
-- 1. Enrichment: an existing listing gains its public URL and / or external id
--    through an append-only citation_listing_enrichments record (before, after,
--    reason, actor, time). Only empty values are filled; the listing keeps its
--    id, import provenance, provider status, checks and tasks. Every key a
--    listing has carried stays in citation_listing_keys, so a reimport of the
--    original (URL-less) or the enriched source finds the same listing.
-- 2. Address equivalence is a display rule (src/lib/citations.ts); no schema.
-- 3. Field-level checks: a content check records, for name, address, phone and
--    website, verified / discrepancy / not displayed / not checked /
--    inaccessible. The database derives the check's result from them: any
--    discrepancy is a discrepancy, every field correct is accurate, otherwise
--    it is partial. A name-only review is partial, never "verified accurate".

-- ── Key history: every key a listing has been identified by ───────────────
create table public.citation_listing_keys (
  location_id uuid not null references public.citation_locations(id) on delete restrict,
  directory_id uuid not null references public.citation_directories(id) on delete restrict,
  listing_key text not null,
  listing_id uuid not null references public.citation_listings(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  primary key (location_id, directory_id, listing_key)
);
create index citation_listing_keys_listing on public.citation_listing_keys(listing_id);
comment on table public.citation_listing_keys is 'Every key (normalized URL, external id, or the one URL-less slot) a listing has carried, per location and directory. Written only by triggers; imports match against it so an enriched listing is still found by its original key.';

insert into public.citation_listing_keys (location_id, directory_id, listing_key, listing_id, recorded_at)
select location_id, directory_id, listing_key, id, created_at from public.citation_listings;
-- A URL-keyed listing that also has an external id can be found by either.
insert into public.citation_listing_keys (location_id, directory_id, listing_key, listing_id, recorded_at)
select location_id, directory_id, 'ext:' || lower(btrim(external_id)), id, updated_at from public.citation_listings
where external_id is not null and listing_key not like 'ext:%'
on conflict do nothing;

create function public.record_citation_listing_keys() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare k text; v_owner uuid;
begin
  if tg_op = 'UPDATE' and (new.listing_key, new.external_id) is not distinct from (old.listing_key, old.external_id) then return null; end if;
  foreach k in array array[new.listing_key] || case when new.external_id is not null then array['ext:' || lower(btrim(new.external_id))] else '{}'::text[] end loop
    insert into public.citation_listing_keys (location_id, directory_id, listing_key, listing_id)
    values (new.location_id, new.directory_id, k, new.id) on conflict do nothing;
    select listing_id into v_owner from public.citation_listing_keys where location_id = new.location_id and directory_id = new.directory_id and listing_key = k;
    if v_owner <> new.id then
      raise exception '%', case when k = 'none'
        then 'This directory already has a listing at this location that was recorded without a URL or id. Add the URL / id to that listing instead.'
        else 'That URL or id already identifies another listing of this directory at this location.' end using errcode = '23505';
    end if;
  end loop;
  return null;
end $$;
create trigger record_citation_listing_keys after insert or update on public.citation_listings
for each row execute function public.record_citation_listing_keys();

-- ── Enrichment: the only way a listing's URL / external id / key changes ──
create table public.citation_listing_enrichments (
  id uuid primary key,
  client_id uuid not null references public.clients(id) on delete restrict,
  listing_id uuid not null references public.citation_listings(id) on delete restrict,
  -- What the teammate adds. Only an empty value is ever filled.
  listing_url text check (listing_url is null or (length(listing_url) <= 2000 and listing_url ~ '^https?://[^/[:space:]?#@]+')),
  external_id text check (external_id is null or length(btrim(external_id)) between 1 and 200),
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  -- Listings elsewhere (another location, directory or client) carrying the same URL / id, reviewed before saving.
  acknowledged_listing_ids uuid[] not null default '{}',
  before_url text, before_external_id text, before_key text not null default '',
  after_url text, after_external_id text, after_key text not null default '',
  recorded_at timestamptz not null default now(),
  recorded_by uuid references auth.users(id),
  check (listing_url is not null or external_id is not null),
  -- No user name or password in the address (the Phase 1 pattern only checks a prefix).
  check (listing_url is null or listing_url !~ '^https?://[^/?#]*@'),
  -- A tokenized account / verification link is never a listing URL (src/lib/citations.ts sensitiveContent).
  check (listing_url is null or listing_url !~* '[?&#;](token|access_token|id_token|auth|authkey|key|code|sig|signature|hash|otp|session|sessionid|sid|ticket|nonce|verify|verification|confirm|reset|magic)=[^&#[:space:]]{8,}')
);
create index citation_listing_enrichments_listing on public.citation_listing_enrichments(listing_id, recorded_at);
comment on table public.citation_listing_enrichments is 'Append-only audit of URLs / external ids added to existing listings (before, after, reason, actor, time). Inserting one applies it; nothing else can change how a listing is identified.';

create function public.guard_citation_enrichment() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare x public.citation_listings; k text; v_other uuid;
begin
  if tg_op <> 'INSERT' then raise exception 'Listing enrichments are append-only.' using errcode = '23514'; end if;
  select * into x from public.citation_listings where id = new.listing_id for update;
  if x.id is null or x.client_id <> new.client_id then raise exception 'Listing belongs to another client.' using errcode = '23514'; end if;
  if x.archived then raise exception 'This listing is archived.' using errcode = '23514'; end if;
  new.external_id := nullif(btrim(new.external_id), '');
  if new.listing_url is not null and x.listing_url is not null then
    raise exception 'This listing already has a URL. A different URL is a different listing: record it separately and resolve the suspected duplicate.' using errcode = '23514';
  end if;
  if new.external_id is not null and x.external_id is not null then
    raise exception 'This listing already has an external id, which is fixed.' using errcode = '23514';
  end if;
  if new.listing_url is null and new.external_id is null then raise exception 'Add a URL or an external id.' using errcode = '23514'; end if;
  new.before_url := x.listing_url; new.before_external_id := x.external_id; new.before_key := x.listing_key;
  new.after_url := coalesce(new.listing_url, x.listing_url); new.after_external_id := coalesce(new.external_id, x.external_id);
  new.after_key := public.citation_listing_key(new.after_url, new.after_external_id);
  -- Collision-safe: the same normalization as imports; a key another listing of
  -- this directory and location carries (now or earlier) is refused.
  foreach k in array array[new.after_key] || case when new.after_external_id is not null then array['ext:' || lower(new.after_external_id)] else '{}'::text[] end loop
    select listing_id into v_other from public.citation_listing_keys
    where location_id = x.location_id and directory_id = x.directory_id and listing_key = k and listing_id <> x.id;
    if v_other is not null then
      raise exception 'That URL or id already identifies another listing of this directory at this location. Resolve the suspected duplicate instead.' using errcode = '23514';
    end if;
  end loop;
  new.recorded_at := clock_timestamp(); new.recorded_by := auth.uid();
  return new;
end $$;
create trigger guard_citation_enrichment before insert or update or delete on public.citation_listing_enrichments
for each row execute function public.guard_citation_enrichment();

create function public.apply_citation_enrichment() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  update public.citation_listings set listing_url = new.after_url, external_id = new.after_external_id, listing_key = new.after_key
  where id = new.listing_id;
  return null;
end $$;
create trigger apply_citation_enrichment after insert on public.citation_listing_enrichments
for each row execute function public.apply_citation_enrichment();

-- The listing guard, unchanged except that URL / external id / key change only
-- by an enrichment record (applied from its trigger, never a direct update).
create or replace function public.guard_citation_listing() returns trigger
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
    if (new.id, new.client_id, new.location_id, new.directory_id, new.created_at, new.created_by)
      is distinct from (old.id, old.client_id, old.location_id, old.directory_id, old.created_at, old.created_by) then
      raise exception 'A listing''s location and directory are fixed. Record a new listing instead.' using errcode = '23514';
    end if;
    if (new.listing_url, new.external_id, new.listing_key) is distinct from (old.listing_url, old.external_id, old.listing_key) and not (
      pg_trigger_depth() > 1
      and new.listing_key = public.citation_listing_key(new.listing_url, new.external_id)
      and exists (select 1 from public.citation_listing_enrichments e where e.listing_id = new.id
        and e.before_key = old.listing_key and e.before_url is not distinct from old.listing_url and e.before_external_id is not distinct from old.external_id
        and e.after_key = new.listing_key and e.after_url is not distinct from new.listing_url and e.after_external_id is not distinct from new.external_id)) then
      raise exception 'A listing''s URL and external id change only by recording an enrichment (Add URL / id), which keeps the before and after.' using errcode = '23514';
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;

-- ── Field-level checks ─────────────────────────────────────────────────────
alter table public.citation_checks
  add column field_coverage text not null default 'unrecorded' check (field_coverage in ('unrecorded','recorded')),
  add column name_status text check (name_status in ('verified','discrepancy','not_displayed','not_checked','inaccessible')),
  add column address_status text check (address_status in ('verified','discrepancy','not_displayed','not_checked','inaccessible')),
  add column phone_status text check (phone_status in ('verified','discrepancy','not_displayed','not_checked','inaccessible')),
  add column website_status text check (website_status in ('verified','discrepancy','not_displayed','not_checked','inaccessible'));
comment on column public.citation_checks.field_coverage is 'recorded: the *_status columns say exactly which fields were reviewed. unrecorded: a check saved before field-level review; which fields it covered is unknown and is never inferred.';

-- The result, method and observation rules gain 'partial'. They were declared
-- without names; drop exactly those three by definition, then re-add them named.
do $$
declare c record; n int := 0;
begin
  for c in select conname from pg_constraint where conrelid = 'public.citation_checks'::regclass and contype = 'c'
    and (pg_get_constraintdef(oid) like '%confirmed_absent%' or pg_get_constraintdef(oid) like '%observed_name || observed_address%') loop
    execute format('alter table public.citation_checks drop constraint %I', c.conname);
    n := n + 1;
  end loop;
  if n <> 3 then raise exception 'Expected the three Phase 1 check rules on citation_checks, found %.', n; end if;
end $$;
alter table public.citation_checks
  add constraint citation_checks_result check (result in ('accurate','discrepancy','partial','inaccessible','not_found','confirmed_absent')),
  add constraint citation_checks_method_supports_result check (case result
    when 'accurate' then method in ('visited_url','owner_dashboard')
    when 'discrepancy' then method in ('visited_url','owner_dashboard')
    when 'partial' then method in ('visited_url','owner_dashboard')
    when 'inaccessible' then method in ('visited_url','other')
    when 'not_found' then method in ('publisher_search','other')
    when 'confirmed_absent' then method in ('owner_dashboard','publisher_confirmation') end),
  add constraint citation_checks_content_observed check (result not in ('accurate','discrepancy','partial')
    or btrim(observed_name || observed_address || observed_phone || observed_website) <> ''),
  -- Coverage: a recorded content check states all four fields; any other recorded check states none.
  add constraint citation_checks_field_coverage check (case
    when field_coverage = 'unrecorded' then result <> 'partial' and num_nulls(name_status, address_status, phone_status, website_status) = 4
    when result in ('accurate','discrepancy','partial') then num_nulls(name_status, address_status, phone_status, website_status) = 0
    else num_nulls(name_status, address_status, phone_status, website_status) = 4 end),
  -- A value is recorded exactly when the field was seen (verified or discrepancy): the raw observation is kept, nothing is invented.
  add constraint citation_checks_field_values check (field_coverage = 'unrecorded' or (
    (coalesce(name_status, '') in ('verified','discrepancy')) = (btrim(observed_name) <> '')
    and (coalesce(address_status, '') in ('verified','discrepancy')) = (btrim(observed_address) <> '')
    and (coalesce(phone_status, '') in ('verified','discrepancy')) = (btrim(observed_phone) <> '')
    and (coalesce(website_status, '') in ('verified','discrepancy')) = (btrim(observed_website) <> '')));

-- The check guard, as before, plus: every new check records its field coverage,
-- and a content check's result is derived from its fields against the identity
-- in effect on its date. A field the identity does not publish (a hidden
-- address, no approved phone or website) is correct when not displayed and can
-- never be "verified": showing a hidden street is a discrepancy.
create or replace function public.guard_citation_check() returns trigger
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare v_hidden boolean; v_phone text; v_site text; s text[]; v_ok int := 0; v_any boolean := false; f int;
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
  new.field_coverage := 'recorded';
  if new.result in ('accurate','discrepancy','partial') then
    if num_nulls(new.name_status, new.address_status, new.phone_status, new.website_status) > 0 then
      raise exception 'Record each field as verified, discrepancy, not displayed, not checked or inaccessible.' using errcode = '23514';
    end if;
    select i.hide_address, i.phone, i.website_url into v_hidden, v_phone, v_site
    from public.citation_listings x join public.citation_location_identities i on i.location_id = x.location_id
    where x.id = new.listing_id and i.version = new.identity_version;
    if not found then
      select l.hide_address, l.phone, l.website_url into v_hidden, v_phone, v_site
      from public.citation_listings x join public.citation_locations l on l.id = x.location_id where x.id = new.listing_id;
    end if;
    if v_hidden and new.address_status = 'verified' then
      raise exception 'This is a hidden-address business: a listing that shows a street address is a discrepancy. Record "not displayed" when no street is shown.' using errcode = '23514';
    end if;
    if btrim(coalesce(v_phone, '')) = '' and new.phone_status = 'verified' then
      raise exception 'The approved identity has no phone, so a phone cannot be verified.' using errcode = '23514';
    end if;
    if v_site is null and new.website_status = 'verified' then
      raise exception 'The approved identity has no website, so a website cannot be verified.' using errcode = '23514';
    end if;
    s := array[new.name_status, new.address_status, new.phone_status, new.website_status];
    for f in 1..4 loop
      if s[f] = 'discrepancy' then v_any := true;
      elsif s[f] = 'verified' or (s[f] = 'not_displayed' and ((f = 2 and v_hidden) or (f = 3 and btrim(coalesce(v_phone, '')) = '') or (f = 4 and v_site is null))) then
        v_ok := v_ok + 1;
      end if;
    end loop;
    if not v_any and v_ok = 0 then
      raise exception 'A content check needs at least one field verified or a discrepancy. If nothing could be reviewed, record the listing as inaccessible.' using errcode = '23514';
    end if;
    new.result := case when v_any then 'discrepancy' when v_ok = 4 then 'accurate' else 'partial' end;
  end if;
  new.recorded_at := clock_timestamp(); new.recorded_by := auth.uid();
  return new;
end $$;

-- ── The current-evidence projection, with field coverage ─────────────────
-- Unchanged columns first (same order and types); partial is
-- partially_verified; the latest content check's field statuses and coverage
-- are appended. suspected_duplicate now also flags a URL-less listing beside
-- another listing of the same directory.
create or replace view public.citation_listing_overview with (security_invoker = true) as
select x.id, x.client_id, x.location_id, x.directory_id, x.listing_url, x.external_id, x.listing_key, x.fulfillment_status,
  x.source_name, x.source_address, x.source_phone, x.source_website, x.source_provider, x.source_observed_on,
  x.last_import_id, x.last_imported_at, x.archived, x.notes, x.created_at, x.updated_at, x.created_by,
  d.name as directory_name, d.key as directory_key, l.label as location_label, l.hide_address, l.identity_version, c.name as client_name,
  k.id as last_check_id, k.checked_on as last_checked_on, k.result as last_check_result, k.method as last_check_method,
  k.identity_version as check_identity_version,
  case when k.id is null then 'unverified'
       when k.identity_version <> l.identity_version then 'needs_reverification'
       when k.result = 'accurate' then 'verified_accurate'
       when k.result = 'partial' then 'partially_verified'
       when k.result = 'discrepancy' then 'discrepancy'
       when k.result = 'inaccessible' then 'inaccessible'
       when k.result = 'confirmed_absent' then 'confirmed_absent'
       else 'unverified' end as verification_status,
  case when k.result in ('accurate','discrepancy','partial') then k.observed_name else '' end as current_name,
  case when k.result in ('accurate','discrepancy','partial') then k.observed_address else '' end as current_address,
  case when k.result in ('accurate','discrepancy','partial') then k.observed_phone else '' end as current_phone,
  case when k.result in ('accurate','discrepancy','partial') then k.observed_website else '' end as current_website,
  (select count(*) from public.citation_tasks t where t.listing_id = x.id and t.status in ('open','in_progress','waiting'))::int as open_tasks,
  count(*) over (partition by x.location_id, x.directory_id) > 1 as suspected_duplicate,
  case when k.result in ('accurate','discrepancy','partial') then k.field_coverage end as check_field_coverage,
  case when k.result in ('accurate','discrepancy','partial') then k.name_status end as name_check,
  case when k.result in ('accurate','discrepancy','partial') then k.address_status end as address_check,
  case when k.result in ('accurate','discrepancy','partial') then k.phone_status end as phone_check,
  case when k.result in ('accurate','discrepancy','partial') then k.website_status end as website_check
from public.citation_listings x
join public.citation_directories d on d.id = x.directory_id
join public.citation_locations l on l.id = x.location_id
join public.clients c on c.id = x.client_id
left join lateral (select * from public.citation_checks k where k.listing_id = x.id
  order by k.checked_on desc, k.recorded_at desc, k.seq desc limit 1) k on true
where not x.archived;

-- ── Import: matches every key a listing has carried; never guesses ───────
-- Unchanged contract (counts, preview rollback, idempotent commit, held rows).
-- Matching now uses citation_listing_keys (current and earlier keys, and the
-- external id), so an enriched listing is found by its original URL-less row
-- and by its new URL. A row that cannot be placed without guessing is
-- rejected with the way to resolve it:
--   - its URL and its id point at two different listings;
--   - its id belongs to a listing with a different URL, or it carries a
--     different external id than the listing it matched;
--   - it has a URL / id the location does not know, while the directory has a
--     listing without one (enrich that listing first);
--   - it has no URL / id, while the directory already has listings with one.
-- An import never changes a listing's URL or external id; a value the listing
-- lacks is reported on the row ("add it with Add URL / id").
create or replace function public.citation_import(p_import jsonb, p_rows jsonb, p_rejected jsonb, p_commit boolean, p_held jsonb default '[]') returns jsonb
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
  v_loc uuid; v_url text; v_ext text; v_ext_key text; v_by_key uuid; v_by_ext uuid; v_match uuid; v_note text; v_dir_name text;
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
        v_loc := (r->>'location_id')::uuid;
        if not exists (select 1 from public.citation_locations where id = v_loc and client_id = v_client and status = 'active') then
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
            select name into v_dir_name from public.citation_directories where id = v_dir;
            v_url := nullif(r->>'listing_url', ''); v_ext := nullif(btrim(coalesce(r->>'external_id', '')), '');
            v_key := public.citation_listing_key(v_url, v_ext);
            v_ext_key := case when v_ext is not null then 'ext:' || lower(v_ext) end;
            select listing_id into v_by_key from public.citation_listing_keys where location_id = v_loc and directory_id = v_dir and listing_key = v_key;
            v_by_ext := null;
            if v_ext_key is not null and v_ext_key <> v_key then
              select listing_id into v_by_ext from public.citation_listing_keys where location_id = v_loc and directory_id = v_dir and listing_key = v_ext_key;
            end if;
            v_match := coalesce(v_by_key, v_by_ext);
            v_listing := null;
            if v_match is not null then select * into v_listing from public.citation_listings where id = v_match; end if;
            v_note := '';
            if v_by_key is not null and v_by_ext is not null and v_by_key <> v_by_ext then
              v_outcome := 'rejected'; v_message := 'The URL and the external id belong to two different listings here. Resolve the suspected duplicate first.';
            elsif v_match is not null and v_url is not null and v_by_key is null and v_listing.listing_url is not null then
              v_outcome := 'rejected'; v_message := 'The external id belongs to a listing with a different URL. Check which is right before importing this row.';
            elsif v_match is not null and v_ext is not null and v_listing.external_id is not null and lower(btrim(v_listing.external_id)) <> lower(v_ext) then
              v_outcome := 'rejected'; v_message := 'The external id differs from the one recorded for this listing. Check which is right before importing this row.';
            elsif v_match is null and v_key <> 'none' and exists (select 1 from public.citation_listings
                where location_id = v_loc and directory_id = v_dir and listing_key = 'none' and not archived) then
              v_outcome := 'rejected'; v_message := format('%s already has a listing at this location without a URL or id. If this row is that listing, add the URL / id to it (Add URL / id) and import again; if it is another listing, add it by hand.', v_dir_name);
            elsif v_match is null and v_key = 'none' and exists (select 1 from public.citation_listings
                where location_id = v_loc and directory_id = v_dir and not archived) then
              v_outcome := 'rejected'; v_message := format('This location already has a %s listing with a URL or id, so a row without one cannot be matched. Add the URL or id to the row.', v_dir_name);
            elsif v_seen ? (v_loc::text || '|' || v_dir::text || '|' || v_key) or v_seen ? coalesce(v_match::text, '') then
              v_outcome := 'rejected';
              v_message := format('Same listing as row %s in this file.', coalesce(v_seen->>(v_loc::text || '|' || v_dir::text || '|' || v_key), v_seen->>(v_match::text)));
            else
              v_seen := v_seen || jsonb_build_object(v_loc::text || '|' || v_dir::text || '|' || v_key, r->>'row_number');
              if v_match is not null then
                v_seen := v_seen || jsonb_build_object(v_match::text, r->>'row_number');
                if v_url is not null and v_listing.listing_url is null then v_note := ' The file''s URL is not on this listing yet: add it with Add URL / id.'; end if;
                if v_ext is not null and v_listing.external_id is null then v_note := v_note || ' The file''s external id is not on this listing yet: add it with Add URL / id.'; end if;
              end if;
              v_fs := nullif(r->>'fulfillment_status', '');
              v_on := nullif(r->>'source_observed_on', '')::date;
              if v_match is null then
                insert into public.citation_listings (client_id, location_id, directory_id, listing_url, external_id, fulfillment_status,
                  source_name, source_address, source_phone, source_website, source_provider, source_observed_on, last_import_id, last_imported_at, notes)
                values (v_client, v_loc, v_dir, v_url, v_ext, coalesce(v_fs, 'none'),
                  coalesce(r->>'observed_name', ''), coalesce(r->>'observed_address', ''), coalesce(r->>'observed_phone', ''), coalesce(r->>'observed_website', ''),
                  v_provider, v_on, v_import, now(), coalesce(r->>'notes', ''))
                returning id into v_id;
                v_outcome := 'added';
                v_seen := v_seen || jsonb_build_object(v_id::text, r->>'row_number');
              elsif v_on is not null and v_listing.source_observed_on is not null and v_on < v_listing.source_observed_on then
                v_id := v_listing.id; v_outcome := 'skipped'; v_message := 'Older than the observation already recorded.';
              else
                v_id := v_listing.id;
                v_changed := (coalesce(v_fs, v_listing.fulfillment_status), coalesce(nullif(r->>'observed_name', ''), v_listing.source_name),
                    coalesce(nullif(r->>'observed_address', ''), v_listing.source_address), coalesce(nullif(r->>'observed_phone', ''), v_listing.source_phone),
                    coalesce(nullif(r->>'observed_website', ''), v_listing.source_website), coalesce(v_on, v_listing.source_observed_on),
                    coalesce(nullif(r->>'notes', ''), v_listing.notes))
                  is distinct from (v_listing.fulfillment_status, v_listing.source_name, v_listing.source_address, v_listing.source_phone,
                    v_listing.source_website, v_listing.source_observed_on, v_listing.notes);
                if v_changed then
                  update public.citation_listings set
                    fulfillment_status = coalesce(v_fs, fulfillment_status),
                    source_name = coalesce(nullif(r->>'observed_name', ''), source_name),
                    source_address = coalesce(nullif(r->>'observed_address', ''), source_address),
                    source_phone = coalesce(nullif(r->>'observed_phone', ''), source_phone),
                    source_website = coalesce(nullif(r->>'observed_website', ''), source_website),
                    source_observed_on = coalesce(v_on, source_observed_on),
                    notes = coalesce(nullif(r->>'notes', ''), notes),
                    source_provider = v_provider, last_import_id = v_import, last_imported_at = now()
                  where id = v_id;
                  v_outcome := 'updated';
                else
                  v_outcome := 'skipped'; v_message := 'Unchanged.';
                end if;
              end if;
              v_message := left(btrim(v_message || v_note), 500);
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

-- ── Access: team only, as Phase 1 ─────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['citation_listing_keys', 'citation_listing_enrichments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "team %s" on public.%I to authenticated using ((select public.is_team())) with check ((select public.is_team()))', t, t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;
grant select on public.citation_listing_keys to authenticated;
grant select, insert on public.citation_listing_enrichments to authenticated;
revoke all on public.citation_listing_overview from public, anon, authenticated;
grant select on public.citation_listing_overview to authenticated;
revoke all on function public.citation_import(jsonb, jsonb, jsonb, boolean, jsonb) from public, anon;
grant execute on function public.citation_import(jsonb, jsonb, jsonb, boolean, jsonb) to authenticated;
revoke all on function public.record_citation_listing_keys(), public.guard_citation_enrichment(), public.apply_citation_enrichment(),
  public.guard_citation_listing(), public.guard_citation_check() from public, anon, authenticated;
