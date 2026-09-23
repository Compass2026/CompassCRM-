-- Client Intelligence prerequisites (five-layer plan, layer 1; Sept 23 2026).
-- Plan: docs/client-intelligence.md, sequence step 3. No post record here —
-- that is 0045, reviewed separately.
--
-- 1. keywords.intent_note — a free-text note about a keyword, so notes never
--    have to live in `intent`.
-- 2. Existing notes move, verbatim, from `intent` to `intent_note`, and
--    `intent` becomes NULL on those rows. Nothing is deleted and no intent is
--    guessed from a note. Measured on production Sept 23: 547 keywords —
--    414 carry one of the four intents exactly, 78 are NULL, 55 carry a note
--    (all Shewmaker Brothers Masonry, the blueprint record; Tom asked for
--    the notes to be preserved and moved, not rewritten), 0 are blank, 0
--    need case or whitespace fixed. Expected after: 414 unchanged, 55 moved,
--    133 NULL, 547 rows. The verify block at the end refuses the migration
--    if any moved note differs from what `intent` held.
-- 3. `intent` is normalized on write (spaces, tabs and line breaks trimmed,
--    lower-cased, blank → NULL)
--    and constrained to navigational / informational / commercial /
--    transactional or NULL. The worker's Keyword Research step already
--    writes DataForSEO's labels, which are exactly these four.
-- 4. offers — the minimum a post needs before it may mention an offer:
--    the exact terms as the client states them, where they came from, the
--    dates, an optional service, and the client's confirmation. A
--    confirmed offer must carry both dates and who confirmed it; nothing
--    here decides which offers a post may use — that rule lands with 0045.
--
-- Access is team-only (is_team(), 0036). The portal (0037) reads neither
-- column nor table: no portal_* view references keywords.intent_note or
-- offers.
--
-- Rollback (before any new note or offer is written):
--   alter table keywords drop constraint keywords_intent_known;
--   drop trigger keywords_normalize_intent on keywords;
--   update keywords set intent = intent_note, intent_note = null
--     where intent is null and intent_note is not null;
--   alter table keywords drop column intent_note;
--   drop table offers;
--   drop function keywords_normalize_intent(), offers_check_service();

-- ── 1. The note column ───────────────────────────────────────────────────────
alter table keywords add column intent_note text;
comment on column keywords.intent_note is
  'Free-text note about the keyword (why it matters, where it belongs). Never a search intent; that is keywords.intent.';

-- ── 2. Move notes out of intent, verbatim ────────────────────────────────────
-- Remember exactly what moves so the verify block can prove nothing changed
-- on the way. Dropped at the end of the migration.
create temporary table migration_0044_moved as
select id, intent as original
from keywords
where intent is not null
  and btrim(intent, E' \t\r\n') <> ''
  and lower(btrim(intent, E' \t\r\n')) not in ('navigational', 'informational', 'commercial', 'transactional');

update keywords k
set intent_note = m.original,
    intent = null
from migration_0044_moved m
where k.id = m.id;

-- Values that are an intent in the wrong case or with stray spaces keep
-- their meaning; blanks carry nothing and become NULL.
update keywords
set intent = lower(btrim(intent, E' \t\r\n'))
where intent is not null
  and intent <> lower(btrim(intent, E' \t\r\n'))
  and lower(btrim(intent, E' \t\r\n')) in ('navigational', 'informational', 'commercial', 'transactional');

update keywords set intent = null where intent is not null and btrim(intent, E' \t\r\n') = '';

-- ── 3. Normalize on write, then constrain ────────────────────────────────────
create function keywords_normalize_intent() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.intent := nullif(lower(btrim(new.intent, E' \t\r\n')), '');
  return new;
end $$;
revoke execute on function keywords_normalize_intent() from public, anon, authenticated;

create trigger keywords_normalize_intent
  before insert or update of intent on keywords
  for each row execute function keywords_normalize_intent();

alter table keywords
  add constraint keywords_intent_known
  check (intent is null or intent in ('navigational', 'informational', 'commercial', 'transactional'));

-- ── 4. Offers ────────────────────────────────────────────────────────────────
create table offers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  service_id uuid references services(id) on delete set null,
  title text not null,
  -- The terms exactly as the client states them; a post never paraphrases
  -- a price, a percentage or a deadline into something new.
  terms text not null,
  -- Where the offer comes from: a client email, their website URL, a flyer.
  source text not null,
  starts_on date,
  ends_on date,
  status text not null default 'draft',
  confirmed_by text,
  confirmed_on timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offers_title_present check (btrim(title) <> ''),
  constraint offers_terms_present check (btrim(terms) <> ''),
  constraint offers_source_present check (btrim(source) <> ''),
  constraint offers_status_known check (status in ('draft', 'confirmed', 'retired')),
  constraint offers_dates_ordered check (starts_on is null or ends_on is null or ends_on >= starts_on),
  -- A confirmed offer is one a post could state, so it needs its window and
  -- who confirmed it (Google's offer posts need a start and an end too).
  constraint offers_confirmed_complete check (
    status <> 'confirmed'
    or (starts_on is not null and ends_on is not null
        and confirmed_by is not null and btrim(confirmed_by) <> '' and confirmed_on is not null)
  )
);
create index offers_client_status on offers (client_id, status);
comment on table offers is
  'Client offers a post may mention once confirmed: exact terms, source, dates. Team-only.';

create trigger offers_updated_at before update on offers
  for each row execute function set_updated_at();

-- An offer's service must be the same client's service.
create function offers_check_service() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.service_id is not null and not exists (
    select 1 from services s where s.id = new.service_id and s.client_id = new.client_id
  ) then
    raise exception 'The service belongs to another client' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke execute on function offers_check_service() from public, anon, authenticated;

create trigger offers_check_service
  before insert or update of client_id, service_id on offers
  for each row execute function offers_check_service();

alter table offers enable row level security;
create policy "team full access" on offers
  for all to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on offers from anon;
revoke truncate, references, trigger on offers from authenticated;

-- ── Verify ───────────────────────────────────────────────────────────────────
do $$
declare
  n int;
begin
  -- Every moved note is in intent_note exactly as it was, and its intent is
  -- NULL (not guessed).
  select count(*) into n
  from migration_0044_moved m
  left join keywords k on k.id = m.id
  where k.id is null or k.intent_note is distinct from m.original or k.intent is not null;
  if n > 0 then
    raise exception '0044: % moved note(s) did not land verbatim in intent_note', n;
  end if;

  select count(*) into n from keywords
  where intent is not null and intent not in ('navigational', 'informational', 'commercial', 'transactional');
  if n > 0 then raise exception '0044: % keyword(s) still carry a non-intent', n; end if;

  if not exists (select 1 from pg_constraint where conname = 'keywords_intent_known' and convalidated) then
    raise exception '0044: keywords_intent_known is missing or not validated';
  end if;

  select count(*) into n from pg_policies
  where tablename = 'offers' and (qual not like '%is_team()%' or with_check not like '%is_team()%');
  if n > 0 or not exists (select 1 from pg_policies where tablename = 'offers') then
    raise exception '0044: offers is not guarded by is_team()';
  end if;

  if has_table_privilege('anon', 'public.offers', 'select') then
    raise exception '0044: anon can read offers';
  end if;

  if has_function_privilege('authenticated', 'public.keywords_normalize_intent()', 'execute')
     or has_function_privilege('authenticated', 'public.offers_check_service()', 'execute') then
    raise exception '0044: an internal 0044 function is callable over the API';
  end if;
end $$;

drop table migration_0044_moved;
