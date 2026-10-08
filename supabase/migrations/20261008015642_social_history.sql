-- Social History, SH1: the canonical store for a client's imported social
-- posts and their metric snapshots (docs/social-history.md; architecture
-- approved Oct 7 2026). Additive. Nothing is published, scheduled or
-- changed on any platform, and nothing here is factual grounding.
--
-- What it adds
--   social_history_imports   one row per import run (the social-history Edge
--                            Function's `import` mode; `plan` writes nothing)
--   social_history_posts     one row per platform post, keyed on
--                            (platform, platform_post_id): re-importing is a
--                            no-op, an edited post updates in place, a post
--                            no longer listed gets missing_since, never deleted
--   social_history_metrics   append-only metric snapshots (engagement grows
--                            after posting, so numbers are never overwritten;
--                            NULL = not supplied, 0 = a real zero)
--   social_history_post_latest      each post with its newest snapshot
--   social_history_learnable_posts  the ONLY read a style analyzer may use:
--                            no Compass-generated post (decision 6), no paid
--                            post, nothing the Page did not author, nothing a
--                            teammate excluded, nothing missing from the platform
--   social_accounts          reused as the account identity (0 rows before
--                            this); a partial unique index per external id
--
-- Writers
--   social_history_begin_import / _record_posts / _finish_import
--       the social-history Edge Function only (PostgREST's authenticator
--       login + service_role). A guard trigger refuses every other write,
--       including the worker's SQL (session_user postgres) and a raw
--       service-role REST call, so no agent session can "import" text that
--       was never published.
--   social_history_set_learning
--       a signed-in teammate through PostgREST: include / exclude a post from
--       style learning, with a note. Imported copy, times and metrics are
--       never editable.
--
-- Historical posts are style / performance evidence only (decisions 2 and
-- 8). No function or view outside the social_history_* family may read
-- these tables; the verify block at the end refuses the migration otherwise,
-- and supabase/tests/sandbox/social_history.test.sql re-checks it after
-- every later migration. Claims, offers, services, social_posts, Client
-- Intelligence and Authority are read here only to tell a Compass post
-- apart from the client's own, and are never written.
--
-- Team-only (is_team(), 0036). anon nothing. No portal view.
--
-- Rollback (nothing outside these objects depends on them): drop the two
-- views, the functions, the three tables and the index
-- social_accounts_client_platform_external_key; delete the social_accounts
-- rows the import created (status manual_only, access_token null).

-- ── 0. Account identity ─────────────────────────────────────────────────────
-- One social_accounts row per client, platform and external (Page) id.
create unique index social_accounts_client_platform_external_key
  on social_accounts (client_id, platform, external_account_id) where external_account_id is not null;

-- ── 1. Tables ───────────────────────────────────────────────────────────────
create table social_history_imports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  social_account_id uuid not null,
  platform social_platform not null,
  provider text not null default 'zernio' check (provider in ('zernio')),
  provider_account_id text not null check (length(btrim(provider_account_id)) between 1 and 200),
  mode text not null default 'import' check (mode in ('import')),
  status text not null default 'running' check (status in ('running', 'completed', 'partial', 'failed')),
  requested_by uuid references team_members(id) on delete set null,
  limit_requested int not null check (limit_requested between 1 and 200),
  window_from timestamptz not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  fetched int not null default 0 check (fetched >= 0),
  inserted int not null default 0 check (inserted >= 0),
  updated int not null default 0 check (updated >= 0),
  unchanged int not null default 0 check (unchanged >= 0),
  metrics_captured int not null default 0 check (metrics_captured >= 0),
  skipped int not null default 0 check (skipped >= 0),
  provider_state jsonb not null default '{}'::jsonb,
  error text,
  unique (id, client_id),
  -- Cascades only when the client goes; the guard refuses any other delete.
  foreign key (social_account_id, client_id) references social_accounts (id, client_id) on delete cascade,
  check ((status = 'running') = (finished_at is null)),
  check (status <> 'failed' or nullif(btrim(error), '') is not null)
);
create unique index social_history_imports_one_running on social_history_imports (social_account_id) where status = 'running';
create index social_history_imports_client_idx on social_history_imports (client_id, started_at desc);
comment on table social_history_imports is
  'Social History import runs (SH1). Written only by the social-history Edge Function. A dry run (plan) is never recorded.';

create table social_history_posts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  social_account_id uuid not null,
  platform social_platform not null,
  platform_post_id text not null check (length(btrim(platform_post_id)) between 1 and 200),
  provider text not null default 'zernio' check (provider in ('zernio')),
  provider_post_id text,
  provider_scheduled_id text,
  origin text not null check (origin in ('external', 'provider_scheduled', 'compass')),
  compass_post_id uuid,
  permalink text check (permalink ~ '^https://'),
  published_at timestamptz not null,
  copy text not null default '',
  copy_hash text not null,
  format text not null check (format in ('text', 'photo', 'album', 'video', 'reel', 'story', 'link', 'other')),
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),
  thumbnail_url text,
  is_paid boolean not null default false,
  is_owner boolean,
  first_imported_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_import_id uuid not null,
  copy_changed_at timestamptz,
  missing_since timestamptz,
  learning_status text not null default 'included' check (learning_status in ('included', 'excluded')),
  learning_note text,
  learning_set_by uuid references team_members(id) on delete set null,
  learning_set_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  unique (platform, platform_post_id),
  unique (id, client_id),
  foreign key (social_account_id, client_id) references social_accounts (id, client_id) on delete cascade,
  foreign key (last_import_id, client_id) references social_history_imports (id, client_id) on delete cascade,
  foreign key (compass_post_id, client_id) references social_posts (id, client_id) on delete set null (compass_post_id),
  check (learning_status = 'included' or nullif(btrim(learning_note), '') is not null),
  check (origin = 'compass' or compass_post_id is null)
);
create index social_history_posts_client_idx on social_history_posts (client_id, platform, published_at desc);
comment on table social_history_posts is
  'Posts a client published on a social platform, imported read-only (SH1). Style and performance evidence only: never a claim, a source or grounding. Written only by the social-history Edge Function; a teammate may only include / exclude a post from style learning.';
comment on column social_history_posts.origin is
  'external = published directly on the platform; provider_scheduled = published through the provider (Zernio) by someone else; compass = matches a Compass social_posts row. Compass posts never feed style learning, and the origin never leaves compass once set.';
comment on column social_history_posts.is_owner is 'Facebook: false when the Page did not author the post (Zernio isOwner). Such posts are never learned from.';
comment on column social_history_posts.is_paid is 'The provider reports paid delivery in its metrics (Zernio isAd). Excluded from organic learning.';

create table social_history_metrics (
  id bigint generated always as identity primary key,
  post_id uuid not null,
  client_id uuid not null,
  import_id uuid not null,
  captured_at timestamptz not null default now(),
  age_hours int not null check (age_hours >= 0),
  provider_updated_at timestamptz,
  sync_status text not null check (sync_status in ('synced', 'partial')),
  impressions bigint check (impressions >= 0),
  reach bigint check (reach >= 0),
  reactions bigint check (reactions >= 0),
  comments bigint check (comments >= 0),
  shares bigint check (shares >= 0),
  saves bigint check (saves >= 0),
  clicks bigint check (clicks >= 0),
  views bigint check (views >= 0),
  engagement_rate numeric check (engagement_rate >= 0),
  unavailable text[] not null default '{}',
  raw jsonb not null default '{}'::jsonb,
  foreign key (post_id, client_id) references social_history_posts (id, client_id) on delete cascade,
  foreign key (import_id, client_id) references social_history_imports (id, client_id) on delete cascade
);
create index social_history_metrics_post_idx on social_history_metrics (post_id, captured_at desc, id desc);
comment on table social_history_metrics is
  'Append-only metric snapshots per imported post. NULL = the provider did not supply it (listed in unavailable); 0 = a real zero. reactions = Facebook''s aggregate reaction count (Zernio reports it as likes).';

-- ── 2. Who is calling ────────────────────────────────────────────────────────
create function social_history_caller_is_service() returns boolean
language sql stable set search_path = public, pg_temp as $$
  select session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'service_role'
$$;
revoke execute on function social_history_caller_is_service() from public, anon, authenticated;

create function social_history_write_active() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(current_setting('compass.social_history_write', true), '') = 'on'
     and (social_history_caller_is_service() or post_caller_is_human())
$$;
revoke execute on function social_history_write_active() from public, anon, authenticated;

-- The guard: no write outside the functions. Deleting the client cascades.
create function social_history_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then
    return old;
  end if;
  -- A Compass post deleted: compass_post_id is set NULL by the FK's action.
  if tg_table_name = 'social_history_posts' and tg_op = 'UPDATE' and pg_trigger_depth() > 1
     and (to_jsonb(new) - 'compass_post_id') = (to_jsonb(old) - 'compass_post_id') then
    return new;
  end if;
  if not social_history_write_active() then
    raise exception 'Social History is written only by the social-history functions' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Social History records are kept' using errcode = '42501';
  end if;
  if tg_table_name = 'social_history_metrics' and tg_op <> 'INSERT' then
    raise exception 'Metric snapshots are append-only' using errcode = '42501';
  end if;
  if tg_table_name = 'social_history_posts' and tg_op = 'UPDATE' then
    if old.origin = 'compass' and new.origin <> 'compass' then
      raise exception 'A Compass-generated post stays compass' using errcode = '42501';
    end if;
    if (old.client_id, old.platform, old.platform_post_id, old.first_imported_at)
       is distinct from (new.client_id, new.platform, new.platform_post_id, new.first_imported_at) then
      raise exception 'An imported post''s identity never changes' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end $$;
revoke execute on function social_history_guard() from public, anon, authenticated;

create trigger social_history_imports_guard before insert or update or delete on social_history_imports
  for each row execute function social_history_guard();
create trigger social_history_posts_guard before insert or update or delete on social_history_posts
  for each row execute function social_history_guard();
create trigger social_history_metrics_guard before insert or update or delete on social_history_metrics
  for each row execute function social_history_guard();

-- ── 3. Helpers ───────────────────────────────────────────────────────────────
-- Copy as compared: lower case, whitespace collapsed, trimmed.
create function social_history_norm_copy(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select btrim(regexp_replace(lower(coalesce(p, '')), '\s+', ' ', 'g'))
$$;
create function social_history_copy_hash(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(social_history_norm_copy(p), 'UTF8')), 'hex')
$$;
revoke execute on function social_history_norm_copy(text) from public, anon;
revoke execute on function social_history_copy_hash(text) from public, anon;
grant execute on function social_history_norm_copy(text) to authenticated, service_role;
grant execute on function social_history_copy_hash(text) to authenticated, service_role;

-- The Compass post an imported post is, if any: the same platform id, the
-- recorded published URL, or (for copy of 40+ characters) the same copy.
create function social_history_compass_match(p_client_id uuid, p_platform social_platform,
  p_platform_post_id text, p_permalink text, p_copy text) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select sp.id from social_posts sp
   where sp.client_id = p_client_id and sp.platform = p_platform
     and (sp.external_post_id = p_platform_post_id
          or (p_permalink is not null and sp.published_url = p_permalink)
          or (length(social_history_norm_copy(p_copy)) >= 40
              and social_history_norm_copy(sp.copy) = social_history_norm_copy(p_copy)))
   order by (sp.external_post_id = p_platform_post_id) desc, sp.created_at
   limit 1
$$;
revoke execute on function social_history_compass_match(uuid, social_platform, text, text, text) from public, anon, authenticated;

-- ── 4. Writers (the social-history function only) ───────────────────────────
-- Opens an import and records the account identity (a social_accounts row,
-- manual_only, no token). Refuses a different Page for the client's platform,
-- a Page already on another client, an offboarded client and a second
-- running import (55P03). A running import over 30 minutes old is failed.
create function social_history_begin_import(p_client_id uuid, p_platform text, p_page_id text, p_page_name text,
  p_provider_account_id text, p_limit int, p_window_from timestamptz, p_requested_by uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_platform social_platform;
  v_account uuid;
  v_status client_status;
  v_id uuid;
begin
  if not social_history_caller_is_service() then
    raise exception 'social_history_begin_import is called only by the social-history function' using errcode = '42501';
  end if;
  if p_platform is distinct from 'facebook' then
    raise exception 'SH1 imports Facebook only' using errcode = '22023';
  end if;
  v_platform := p_platform::social_platform;
  if nullif(btrim(p_page_id), '') is null or nullif(btrim(p_provider_account_id), '') is null then
    raise exception 'A Page id and a provider account id are required' using errcode = '22023';
  end if;
  select status into v_status from clients where id = p_client_id;
  if v_status is null then raise exception 'No client %', p_client_id using errcode = 'P0002'; end if;
  if v_status = 'offboarded' then raise exception 'The client is offboarded' using errcode = '42501'; end if;
  if exists (select 1 from social_accounts where platform = v_platform and external_account_id = p_page_id
               and client_id <> p_client_id) then
    raise exception 'Page % is recorded for another client', p_page_id using errcode = '23505';
  end if;
  if exists (select 1 from social_accounts where client_id = p_client_id and platform = v_platform
               and external_account_id is not null and external_account_id <> p_page_id) then
    raise exception 'This client''s % account is a different Page; change it by hand first', p_platform using errcode = '23505';
  end if;

  perform pg_advisory_xact_lock(hashtext('social_history:' || p_client_id::text || ':' || p_platform));
  select id into v_account from social_accounts
   where client_id = p_client_id and platform = v_platform and external_account_id = p_page_id;
  if v_account is null then
    insert into social_accounts (client_id, platform, external_account_id, display_name, status)
    values (p_client_id, v_platform, p_page_id, nullif(btrim(p_page_name), ''), 'manual_only')
    returning id into v_account;
  elsif nullif(btrim(p_page_name), '') is not null then
    update social_accounts set display_name = btrim(p_page_name) where id = v_account and display_name is distinct from btrim(p_page_name);
  end if;

  perform set_config('compass.social_history_write', 'on', true);
  update social_history_imports set status = 'failed', finished_at = now(), error = 'Timed out (not finished within 30 minutes).'
   where social_account_id = v_account and status = 'running' and started_at < now() - interval '30 minutes';
  begin
    insert into social_history_imports (client_id, social_account_id, platform, provider_account_id,
      requested_by, limit_requested, window_from)
    values (p_client_id, v_account, v_platform, btrim(p_provider_account_id), p_requested_by, p_limit, p_window_from)
    returning id into v_id;
  exception when unique_violation then
    perform set_config('compass.social_history_write', '', true);
    raise exception 'An import is already running for this account' using errcode = '55P03';
  end;
  perform set_config('compass.social_history_write', '', true);
  return jsonb_build_object('import_id', v_id, 'social_account_id', v_account);
end $$;
revoke all on function social_history_begin_import(uuid, text, text, text, text, int, timestamptz, uuid) from public, anon, authenticated;
grant execute on function social_history_begin_import(uuid, text, text, text, text, int, timestamptz, uuid) to service_role;

-- Records up to 50 mapped posts of a running import. Each element:
--   {platform_post_id, provider_post_id, provider_scheduled_id, permalink,
--    published_at, copy, format, media, thumbnail_url, is_paid, is_owner,
--    raw, metrics: null | {provider_updated_at, sync_status, impressions,
--    reach, reactions, comments, shares, saves, clicks, views,
--    engagement_rate, unavailable, raw}}
-- The origin and the copy hash are decided here, never by the caller. A
-- snapshot is appended only when the provider's numbers changed since the
-- post's newest one. Returns {inserted, updated, unchanged, metrics_captured}.
create function social_history_record_posts(p_import_id uuid, p_posts jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  imp social_history_imports;
  e jsonb;
  m jsonb;
  cur social_history_posts;
  v_post uuid;
  v_copy text;
  v_permalink text;
  v_published timestamptz;
  v_match uuid;
  v_origin text;
  v_hash text;
  v_last social_history_metrics;
  v_unavail text[];
  n_ins int := 0; n_upd int := 0; n_same int := 0; n_met int := 0;
begin
  if not social_history_caller_is_service() then
    raise exception 'social_history_record_posts is called only by the social-history function' using errcode = '42501';
  end if;
  select * into imp from social_history_imports where id = p_import_id for update;
  if imp.id is null then raise exception 'No import %', p_import_id using errcode = 'P0002'; end if;
  if imp.status <> 'running' then raise exception 'Import % is already %', p_import_id, imp.status using errcode = '42501'; end if;
  if jsonb_typeof(p_posts) is distinct from 'array' or jsonb_array_length(p_posts) > 50 then
    raise exception 'p_posts is an array of at most 50 posts' using errcode = '22023';
  end if;

  perform set_config('compass.social_history_write', 'on', true);
  for e in select value from jsonb_array_elements(p_posts) loop
    if nullif(btrim(e ->> 'platform_post_id'), '') is null or (e ->> 'published_at') is null then
      raise exception 'Every post needs platform_post_id and published_at' using errcode = '22023';
    end if;
    v_copy := coalesce(e ->> 'copy', '');
    v_permalink := nullif(btrim(e ->> 'permalink'), '');
    v_published := (e ->> 'published_at')::timestamptz;
    v_hash := social_history_copy_hash(v_copy);
    v_match := social_history_compass_match(imp.client_id, imp.platform, e ->> 'platform_post_id', v_permalink, v_copy);
    v_origin := case when v_match is not null then 'compass'
                     when nullif(btrim(e ->> 'provider_scheduled_id'), '') is not null then 'provider_scheduled'
                     else 'external' end;

    select * into cur from social_history_posts where platform = imp.platform and platform_post_id = e ->> 'platform_post_id' for update;
    if cur.id is not null and cur.client_id <> imp.client_id then
      raise exception 'Post % belongs to another client', e ->> 'platform_post_id' using errcode = '42501';
    end if;

    if cur.id is null then
      insert into social_history_posts (client_id, social_account_id, platform, platform_post_id, provider_post_id,
        provider_scheduled_id, origin, compass_post_id, permalink, published_at, copy, copy_hash, format, media,
        thumbnail_url, is_paid, is_owner, last_import_id, raw)
      values (imp.client_id, imp.social_account_id, imp.platform, e ->> 'platform_post_id', e ->> 'provider_post_id',
        nullif(btrim(e ->> 'provider_scheduled_id'), ''), v_origin, v_match, v_permalink, v_published, v_copy, v_hash,
        coalesce(e ->> 'format', 'other'), coalesce(e -> 'media', '[]'::jsonb), e ->> 'thumbnail_url',
        coalesce((e ->> 'is_paid')::boolean, false), (e ->> 'is_owner')::boolean, imp.id, coalesce(e -> 'raw', '{}'::jsonb))
      returning id into v_post;
      n_ins := n_ins + 1;
    else
      v_post := cur.id;
      -- A post once matched to Compass stays compass (the guard refuses the reverse).
      if cur.origin = 'compass' then
        v_origin := 'compass';
        v_match := coalesce(v_match, cur.compass_post_id);
      end if;
      if (cur.copy_hash, cur.permalink, cur.published_at, cur.format, cur.media, cur.thumbnail_url, cur.is_paid,
          cur.is_owner, cur.origin, cur.compass_post_id, cur.provider_scheduled_id, cur.missing_since is not null)
         is distinct from
         (v_hash, v_permalink, v_published, coalesce(e ->> 'format', 'other'), coalesce(e -> 'media', '[]'::jsonb),
          e ->> 'thumbnail_url', coalesce((e ->> 'is_paid')::boolean, false), (e ->> 'is_owner')::boolean, v_origin,
          v_match, nullif(btrim(e ->> 'provider_scheduled_id'), ''), false) then
        n_upd := n_upd + 1;
      else
        n_same := n_same + 1;
      end if;
      update social_history_posts set
        provider_post_id = coalesce(e ->> 'provider_post_id', provider_post_id),
        provider_scheduled_id = nullif(btrim(e ->> 'provider_scheduled_id'), ''),
        origin = v_origin, compass_post_id = v_match,
        permalink = v_permalink, published_at = v_published,
        copy_changed_at = case when copy_hash <> v_hash then now() else copy_changed_at end,
        copy = v_copy, copy_hash = v_hash,
        format = coalesce(e ->> 'format', 'other'), media = coalesce(e -> 'media', '[]'::jsonb),
        thumbnail_url = e ->> 'thumbnail_url', is_paid = coalesce((e ->> 'is_paid')::boolean, false),
        is_owner = (e ->> 'is_owner')::boolean, last_seen_at = now(), last_import_id = imp.id,
        missing_since = null, raw = coalesce(e -> 'raw', '{}'::jsonb)
      where id = v_post;
    end if;

    m := e -> 'metrics';
    if m is not null and jsonb_typeof(m) = 'object' then
      v_unavail := coalesce(array(select jsonb_array_elements_text(coalesce(m -> 'unavailable', '[]'::jsonb)) order by 1), '{}');
      select * into v_last from social_history_metrics where post_id = v_post order by captured_at desc, id desc limit 1;
      if v_last.id is null
         or (v_last.impressions, v_last.reach, v_last.reactions, v_last.comments, v_last.shares, v_last.saves,
             v_last.clicks, v_last.views, v_last.engagement_rate, v_last.unavailable, v_last.sync_status)
            is distinct from
            ((m ->> 'impressions')::bigint, (m ->> 'reach')::bigint, (m ->> 'reactions')::bigint, (m ->> 'comments')::bigint,
             (m ->> 'shares')::bigint, (m ->> 'saves')::bigint, (m ->> 'clicks')::bigint, (m ->> 'views')::bigint,
             (m ->> 'engagement_rate')::numeric, v_unavail, coalesce(m ->> 'sync_status', 'synced')) then
        insert into social_history_metrics (post_id, client_id, import_id, age_hours, provider_updated_at, sync_status,
          impressions, reach, reactions, comments, shares, saves, clicks, views, engagement_rate, unavailable, raw)
        values (v_post, imp.client_id, imp.id, greatest(0, floor(extract(epoch from (now() - v_published)) / 3600))::int,
          (m ->> 'provider_updated_at')::timestamptz, coalesce(m ->> 'sync_status', 'synced'),
          (m ->> 'impressions')::bigint, (m ->> 'reach')::bigint, (m ->> 'reactions')::bigint, (m ->> 'comments')::bigint,
          (m ->> 'shares')::bigint, (m ->> 'saves')::bigint, (m ->> 'clicks')::bigint, (m ->> 'views')::bigint,
          (m ->> 'engagement_rate')::numeric, v_unavail, coalesce(m -> 'raw', '{}'::jsonb));
        n_met := n_met + 1;
      end if;
    end if;
  end loop;

  update social_history_imports set
    fetched = fetched + jsonb_array_length(p_posts), inserted = inserted + n_ins, updated = updated + n_upd,
    unchanged = unchanged + n_same, metrics_captured = metrics_captured + n_met
  where id = imp.id;
  perform set_config('compass.social_history_write', '', true);
  return jsonb_build_object('inserted', n_ins, 'updated', n_upd, 'unchanged', n_same, 'metrics_captured', n_met);
end $$;
revoke all on function social_history_record_posts(uuid, jsonb) from public, anon, authenticated;
grant execute on function social_history_record_posts(uuid, jsonb) to service_role;

-- Finishes an import: completed / partial / failed (failed needs the error).
-- p_listing = {complete: bool, oldest_seen: timestamptz, skipped: int,
-- provider_state: {...}}. When the provider's listing was read completely
-- down to oldest_seen, this account's posts in that range that the import
-- did not see get missing_since (kept, never deleted). Strictly newer than
-- oldest_seen, so a post sharing the oldest timestamp is never misjudged.
create function social_history_finish_import(p_import_id uuid, p_status text, p_error text, p_listing jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  imp social_history_imports;
  v_missing int := 0;
begin
  if not social_history_caller_is_service() then
    raise exception 'social_history_finish_import is called only by the social-history function' using errcode = '42501';
  end if;
  if p_status not in ('completed', 'partial', 'failed') then
    raise exception 'An import finishes completed, partial or failed, not %', p_status using errcode = '22023';
  end if;
  select * into imp from social_history_imports where id = p_import_id for update;
  if imp.id is null then raise exception 'No import %', p_import_id using errcode = 'P0002'; end if;
  if imp.status <> 'running' then raise exception 'Import % is already %', p_import_id, imp.status using errcode = '42501'; end if;

  perform set_config('compass.social_history_write', 'on', true);
  if p_status = 'completed' and coalesce((p_listing ->> 'complete')::boolean, false) and (p_listing ->> 'oldest_seen') is not null then
    update social_history_posts set missing_since = now()
     where social_account_id = imp.social_account_id and missing_since is null
       and published_at > (p_listing ->> 'oldest_seen')::timestamptz
       and last_import_id <> imp.id;
    get diagnostics v_missing = row_count;
  end if;
  update social_history_imports set
    status = p_status, finished_at = now(),
    error = case when p_status = 'completed' then null else left(nullif(btrim(p_error), ''), 2000) end,
    skipped = skipped + coalesce((p_listing ->> 'skipped')::int, 0),
    provider_state = coalesce(p_listing -> 'provider_state', '{}'::jsonb) || jsonb_build_object('marked_missing', v_missing)
  where id = imp.id
  returning * into imp;
  perform set_config('compass.social_history_write', '', true);
  return to_jsonb(imp) - 'provider_state';
end $$;
revoke all on function social_history_finish_import(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function social_history_finish_import(uuid, text, text, jsonb) to service_role;

-- A teammate includes or excludes a post from style learning (a note is
-- required to exclude). A Compass-generated post can never be included.
create function social_history_set_learning(p_post_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare cur social_history_posts;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate changes what Social History learns from' using errcode = '42501';
  end if;
  if p_status not in ('included', 'excluded') then
    raise exception 'learning_status is included or excluded' using errcode = '22023';
  end if;
  select * into cur from social_history_posts where id = p_post_id for update;
  if cur.id is null then raise exception 'No imported post %', p_post_id using errcode = 'P0002'; end if;
  if p_status = 'included' and cur.origin = 'compass' then
    raise exception 'Compass-generated posts never feed style learning' using errcode = '42501';
  end if;
  if p_status = 'excluded' and nullif(btrim(p_note), '') is null then
    raise exception 'Say why the post is excluded' using errcode = '22023';
  end if;
  perform set_config('compass.social_history_write', 'on', true);
  update social_history_posts set learning_status = p_status, learning_note = nullif(btrim(p_note), ''),
    learning_set_by = task_actor(), learning_set_at = now()
  where id = cur.id;
  perform set_config('compass.social_history_write', '', true);
end $$;
revoke all on function social_history_set_learning(uuid, text, text) from public, anon, authenticated;
grant execute on function social_history_set_learning(uuid, text, text) to authenticated;

-- ── 5. Read models (invoker rights) ─────────────────────────────────────────
create view social_history_post_latest with (security_invoker = true) as
select p.*, m.id as metrics_id, m.captured_at as metrics_captured_at, m.age_hours as metrics_age_hours,
       m.sync_status as metrics_sync_status, m.impressions, m.reach, m.reactions, m.comments, m.shares, m.saves,
       m.clicks, m.views, m.engagement_rate, m.unavailable as metrics_unavailable
from social_history_posts p
left join lateral (select * from social_history_metrics x where x.post_id = p.id
                   order by x.captured_at desc, x.id desc limit 1) m on true;

-- The only input a style analyzer may read (SH2). Compass-generated content
-- is excluded twice: by the stored origin and by a live match against
-- social_posts, so a Compass post published after the import is excluded too.
create view social_history_learnable_posts with (security_invoker = true) as
select p.*
from social_history_posts p
where p.origin <> 'compass'
  and p.learning_status = 'included'
  and not p.is_paid
  and coalesce(p.is_owner, true)
  and p.missing_since is null
  and not exists (
    select 1 from social_posts sp
     where sp.client_id = p.client_id and sp.platform = p.platform
       and (sp.external_post_id = p.platform_post_id
            or (p.permalink is not null and sp.published_url = p.permalink)
            or (length(social_history_norm_copy(p.copy)) >= 40
                and social_history_norm_copy(sp.copy) = social_history_norm_copy(p.copy))));

-- ── 6. Access ────────────────────────────────────────────────────────────────
alter table social_history_imports enable row level security;
alter table social_history_posts enable row level security;
alter table social_history_metrics enable row level security;
create policy "team full access" on social_history_imports for all to authenticated using ((select is_team())) with check ((select is_team()));
create policy "team full access" on social_history_posts for all to authenticated using ((select is_team())) with check ((select is_team()));
create policy "team full access" on social_history_metrics for all to authenticated using ((select is_team())) with check ((select is_team()));
revoke all on social_history_imports, social_history_posts, social_history_metrics from public, anon, authenticated, service_role;
grant select on social_history_imports, social_history_posts, social_history_metrics to authenticated, service_role;
revoke all on social_history_post_latest, social_history_learnable_posts from public, anon, authenticated, service_role;
grant select on social_history_post_latest, social_history_learnable_posts to authenticated, service_role;

-- ── 7. Verify ────────────────────────────────────────────────────────────────
do $$
declare v text;
begin
  -- Decision 8: nothing outside the social_history_* family reads these tables.
  select string_agg(p.oid::regprocedure::text, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~ 'social_history_(posts|metrics|imports|post_latest|learnable_posts)'
     and p.proname !~ '^social_history_';
  if v is not null then raise exception 'social history verify: functions outside the family read it: %', v; end if;
  select string_agg(viewname, ', ') into v from pg_views
   where schemaname = 'public' and definition ~ 'social_history_' and viewname !~ '^social_history_';
  if v is not null then raise exception 'social history verify: views outside the family read it: %', v; end if;
  -- The writers write no grounding table.
  select string_agg(p.proname, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname ~ '^social_history_'
     and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(claims|offers|services|post_claims|post_assets|social_posts|keywords|client_brands|brand_assets)\M';
  if v is not null then raise exception 'social history verify: a writer touches grounding: %', v; end if;
  -- Grants as designed.
  if has_table_privilege('anon', 'public.social_history_posts', 'select')
     or has_table_privilege('authenticated', 'public.social_history_posts', 'insert, update, delete')
     or has_table_privilege('service_role', 'public.social_history_posts', 'insert, update, delete')
     or has_function_privilege('authenticated', 'social_history_record_posts(uuid, jsonb)', 'execute') then
    raise exception 'social history verify: grants are wider than designed';
  end if;
end $$;
