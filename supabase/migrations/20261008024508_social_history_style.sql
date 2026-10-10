-- Social History, SH2: proposed, versioned Client Social Style Profiles
-- (docs/social-history.md "SH2"). Additive. Nothing reads a profile yet:
-- the AI Drafter and the Creative Engine are not wired to it (SH3 / SH4).
--
-- What it adds
--   social_history_style_profiles  one row per analysis the social-history
--       function's `analyze` mode records: the analyzer's deterministic
--       output (traits with confidence, representative posts, top performers
--       against the client's own baseline, outliers, do-not-learn posts and
--       phrases), its input fingerprint and a hash of the stored profile.
--       Versions per client and platform; at most one proposed and one
--       approved at a time. A profile's content never changes once written.
--
-- Writers
--   social_history_style_record   the social-history function only
--       (authenticator + service_role). Idempotent: the same input
--       fingerprint and analyzer version returns the existing profile. A new
--       analysis supersedes the open proposal, never the approved profile.
--       Refuses example posts that are not this client's, and representative
--       or top-performing posts that are not in social_history_learnable_posts
--       (decision 6: Compass content never feeds the voice).
--   social_history_style_review   a signed-in teammate through PostgREST
--       (decision 1): approve or reject the proposal they looked at
--       (bound by its hash, SH409 otherwise). Approving supersedes the
--       previous approved profile; rejecting needs a reason. Approval is
--       refused when an example post has since left the learnable view.
--
-- Read
--   social_history_style_approved(client, platform)  the approved profile or
--       NULL. Nothing calls it yet; when SH3 wires the drafter, this is the
--       only read it may use. A proposed profile is never returned.
--
-- A profile is style / performance evidence only (decisions 2 and 8): it
-- stays inside the social_history_* family, which no Client Intelligence or
-- Authority function may read (SH1's verify block and the sandbox's
-- social_history.test.sql re-check that after every migration).
--
-- Team-only (is_team()). anon nothing. No portal view.
--
-- Rollback: drop the three functions, the guard and the table.

create table social_history_style_profiles (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  platform social_platform not null,
  version int not null check (version >= 1),
  analyzer_version text not null check (analyzer_version ~ '^[a-z0-9-]+-v[0-9]+(\.[0-9]+)*$'),
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  as_of timestamptz not null,
  posts_imported int not null check (posts_imported >= 0),
  posts_learnable int not null check (posts_learnable >= 0),
  posts_voice int not null check (posts_voice >= 0),
  posts_performance int not null check (posts_performance >= 0),
  profile jsonb not null,
  profile_hash text not null check (profile_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'superseded')),
  requested_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  reviewed_by uuid references team_members(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  superseded_at timestamptz,
  superseded_by uuid references social_history_style_profiles(id) on delete set null,
  unique (client_id, platform, version),
  check (status <> 'rejected' or nullif(btrim(review_note), '') is not null),
  check (status not in ('approved', 'rejected') or (reviewed_at is not null)),
  check (status <> 'superseded' or superseded_at is not null)
);
create unique index social_history_style_one_proposed on social_history_style_profiles (client_id, platform) where status = 'proposed';
create unique index social_history_style_one_approved on social_history_style_profiles (client_id, platform) where status = 'approved';
comment on table social_history_style_profiles is
  'Client Social Style Profiles (SH2): style and performance evidence from imported history, never factual grounding. Proposed until a teammate approves; nothing reads them yet.';

-- ── Guard ───────────────────────────────────────────────────────────────────
create function social_history_style_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then
    return old;
  end if;
  -- A teammate deleted: reviewed_by / requested_by are set NULL by the FK.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1
     and (to_jsonb(new) - 'reviewed_by' - 'requested_by' - 'superseded_by')
       = (to_jsonb(old) - 'reviewed_by' - 'requested_by' - 'superseded_by') then
    return new;
  end if;
  if not social_history_write_active() then
    raise exception 'Style profiles are written only by the social-history functions' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Style profiles are kept' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (old.client_id, old.platform, old.version, old.analyzer_version, old.input_fingerprint,
       old.as_of, old.profile, old.profile_hash, old.created_at, old.requested_by)
     is distinct from (new.client_id, new.platform, new.version, new.analyzer_version, new.input_fingerprint,
       new.as_of, new.profile, new.profile_hash, new.created_at, new.requested_by) then
    raise exception 'A style profile''s content never changes; run a new analysis' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.status in ('rejected', 'superseded')
     and (to_jsonb(new) - 'superseded_by') is distinct from (to_jsonb(old) - 'superseded_by') then
    raise exception 'A % style profile is final', old.status using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
revoke execute on function social_history_style_guard() from public, anon, authenticated;
create trigger social_history_style_profiles_guard before insert or update or delete on social_history_style_profiles
  for each row execute function social_history_style_guard();

-- ── Record (the social-history function only) ───────────────────────────────
-- p_profile is the analyzer's output (compass-social-style/1). The hash is
-- computed here over the stored jsonb, and is what a reviewer approves.
create function social_history_style_record(p_client_id uuid, p_platform text, p_fingerprint text,
  p_profile jsonb, p_requested_by uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_platform social_platform;
  v_analyzer text := p_profile ->> 'analyzer_version';
  v_hash text := encode(sha256(convert_to(p_profile::text, 'UTF8')), 'hex');
  v_existing social_history_style_profiles;
  v_version int;
  v_id uuid;
  v_bad text;
  v_prev uuid;
begin
  if not social_history_caller_is_service() then
    raise exception 'Only the social-history function records a style profile' using errcode = '42501';
  end if;
  v_platform := p_platform::social_platform;
  if not exists (select 1 from clients where id = p_client_id and status <> 'offboarded') then
    raise exception 'No active client %', p_client_id using errcode = 'P0002';
  end if;
  if p_profile ->> 'schema' is distinct from 'compass-social-style/1'
     or p_profile ->> 'client_id' is distinct from p_client_id::text
     or p_profile ->> 'platform' is distinct from p_platform
     or v_analyzer is null or jsonb_typeof(p_profile -> 'traits') <> 'object'
     or p_profile ->> 'boundary' is null then
    raise exception 'Not a compass-social-style/1 profile for this client and platform' using errcode = '22023';
  end if;
  if p_requested_by is not null and not exists (select 1 from team_members where id = p_requested_by) then
    raise exception 'Unknown teammate %', p_requested_by using errcode = '22023';
  end if;
  -- Every example post is this client's imported post on this platform.
  select string_agg(x, ', ') into v_bad from (
    select e ->> 'post_id' as x
      from jsonb_array_elements(coalesce(p_profile -> 'representative', '[]') || coalesce(p_profile -> 'top_performers', '[]')
                                || coalesce(p_profile -> 'outliers', '[]') || coalesce(p_profile #> '{do_not_learn,posts}', '[]')) e
     where not exists (select 1 from social_history_posts p where p.id::text = e ->> 'post_id'
                        and p.client_id = p_client_id and p.platform = v_platform)) s;
  if v_bad is not null then
    raise exception 'Example posts that are not this client''s: %', v_bad using errcode = '22023';
  end if;
  -- Decision 6: the voice examples come only from the learnable view.
  select string_agg(x, ', ') into v_bad from (
    select e ->> 'post_id' as x
      from jsonb_array_elements(coalesce(p_profile -> 'representative', '[]') || coalesce(p_profile -> 'top_performers', '[]')) e
     where not exists (select 1 from social_history_learnable_posts l where l.id::text = e ->> 'post_id')) s;
  if v_bad is not null then
    raise exception 'Representative and top-performing posts must be learnable: %', v_bad using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('social_history_style:' || p_client_id || ':' || p_platform, 0));
  select * into v_existing from social_history_style_profiles
   where client_id = p_client_id and platform = v_platform and input_fingerprint = p_fingerprint
     and analyzer_version = v_analyzer and status in ('proposed', 'approved')
   order by version desc limit 1;
  if v_existing.id is not null then
    return jsonb_build_object('id', v_existing.id, 'version', v_existing.version, 'status', v_existing.status,
      'profile_hash', v_existing.profile_hash, 'unchanged', true);
  end if;

  select coalesce(max(version), 0) + 1 into v_version from social_history_style_profiles
   where client_id = p_client_id and platform = v_platform;
  v_id := gen_random_uuid();
  perform set_config('compass.social_history_write', 'on', true);
  update social_history_style_profiles set status = 'superseded', superseded_at = now()
   where client_id = p_client_id and platform = v_platform and status = 'proposed'
   returning id into v_prev;
  insert into social_history_style_profiles (id, client_id, platform, version, analyzer_version, input_fingerprint, as_of,
    posts_imported, posts_learnable, posts_voice, posts_performance, profile, profile_hash, requested_by)
  values (v_id, p_client_id, v_platform, v_version, v_analyzer, p_fingerprint, (p_profile ->> 'as_of')::timestamptz,
    coalesce((p_profile #>> '{corpus,imported}')::int, 0), coalesce((p_profile #>> '{corpus,learnable}')::int, 0),
    coalesce((p_profile #>> '{corpus,voice}')::int, 0), coalesce((p_profile #>> '{corpus,performance_eligible}')::int, 0),
    p_profile, v_hash, p_requested_by);
  if v_prev is not null then
    update social_history_style_profiles set superseded_by = v_id where id = v_prev;
  end if;
  perform set_config('compass.social_history_write', '', true);
  return jsonb_build_object('id', v_id, 'version', v_version, 'status', 'proposed', 'profile_hash', v_hash,
    'unchanged', false, 'superseded', v_prev);
end $$;
revoke all on function social_history_style_record(uuid, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function social_history_style_record(uuid, text, text, jsonb, uuid) to service_role;

-- ── Review (a signed-in teammate only) ──────────────────────────────────────
create function social_history_style_review(p_profile_id uuid, p_decision text, p_expected_hash text,
  p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cur social_history_style_profiles;
  v_bad text;
  v_prev uuid;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate reviews a style profile' using errcode = '42501';
  end if;
  if p_decision not in ('approve', 'reject') then
    raise exception 'decision is approve or reject' using errcode = '22023';
  end if;
  select * into cur from social_history_style_profiles where id = p_profile_id for update;
  if cur.id is null then raise exception 'No style profile %', p_profile_id using errcode = 'P0002'; end if;
  if cur.status <> 'proposed' then
    raise exception 'This profile is % and can no longer be reviewed', cur.status using errcode = 'SH409';
  end if;
  if p_expected_hash is distinct from cur.profile_hash then
    raise exception 'The profile changed since the page loaded' using errcode = 'SH409';
  end if;
  if p_decision = 'reject' and nullif(btrim(p_note), '') is null then
    raise exception 'Say why the profile is rejected' using errcode = '22023';
  end if;
  if p_decision = 'approve' then
    select string_agg(x, ', ') into v_bad from (
      select e ->> 'post_id' as x
        from jsonb_array_elements(coalesce(cur.profile -> 'representative', '[]') || coalesce(cur.profile -> 'top_performers', '[]')) e
       where not exists (select 1 from social_history_learnable_posts l where l.id::text = e ->> 'post_id')) s;
    if v_bad is not null then
      raise exception 'Example posts have left the learnable set since the analysis (%); run it again', v_bad using errcode = 'SH409';
    end if;
  end if;
  perform set_config('compass.social_history_write', 'on', true);
  if p_decision = 'approve' then
    update social_history_style_profiles set status = 'superseded', superseded_at = now(), superseded_by = cur.id
     where client_id = cur.client_id and platform = cur.platform and status = 'approved'
     returning id into v_prev;
    update social_history_style_profiles set status = 'approved', reviewed_by = task_actor(), reviewed_at = now(),
      review_note = nullif(btrim(p_note), '') where id = cur.id;
  else
    update social_history_style_profiles set status = 'rejected', reviewed_by = task_actor(), reviewed_at = now(),
      review_note = btrim(p_note) where id = cur.id;
  end if;
  perform set_config('compass.social_history_write', '', true);
  return jsonb_build_object('id', cur.id, 'status', case p_decision when 'approve' then 'approved' else 'rejected' end,
    'superseded', v_prev);
end $$;
revoke all on function social_history_style_review(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function social_history_style_review(uuid, text, text, text) to authenticated;

-- ── Read (approved only; invoker rights) ────────────────────────────────────
create function social_history_style_approved(p_client_id uuid, p_platform text default 'facebook')
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object('id', id, 'version', version, 'analyzer_version', analyzer_version, 'profile_hash', profile_hash,
           'reviewed_at', reviewed_at, 'profile', profile)
    from social_history_style_profiles
   where client_id = p_client_id and platform = p_platform::social_platform and status = 'approved'
$$;
revoke all on function social_history_style_approved(uuid, text) from public, anon, authenticated;
grant execute on function social_history_style_approved(uuid, text) to authenticated, service_role;

-- ── Access ──────────────────────────────────────────────────────────────────
alter table social_history_style_profiles enable row level security;
create policy "team full access" on social_history_style_profiles for all to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on social_history_style_profiles from public, anon, authenticated, service_role;
grant select on social_history_style_profiles to authenticated, service_role;

-- ── Verify ──────────────────────────────────────────────────────────────────
do $$
declare v text;
begin
  -- Decision 8: nothing outside the social_history_* family reads profiles.
  select string_agg(p.oid::regprocedure::text, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~ 'social_history_style' and p.proname !~ '^social_history_';
  if v is not null then raise exception 'style verify: functions outside the family read profiles: %', v; end if;
  select string_agg(viewname, ', ') into v from pg_views
   where schemaname = 'public' and definition ~ 'social_history_style' and viewname !~ '^social_history_';
  if v is not null then raise exception 'style verify: views outside the family read profiles: %', v; end if;
  -- The style functions write no grounding and no post.
  select string_agg(p.proname, ', ') into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname ~ '^social_history_style_'
     and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(claims|offers|services|post_claims|post_assets|social_posts|keywords|client_brands|brand_assets|social_history_posts|social_history_metrics)\M';
  if v is not null then raise exception 'style verify: a style function writes outside its table: %', v; end if;
  if has_table_privilege('anon', 'public.social_history_style_profiles', 'select')
     or has_table_privilege('authenticated', 'public.social_history_style_profiles', 'insert, update, delete')
     or has_table_privilege('service_role', 'public.social_history_style_profiles', 'insert, update, delete')
     or has_function_privilege('authenticated', 'social_history_style_record(uuid, text, text, jsonb, uuid)', 'execute')
     or has_function_privilege('service_role', 'social_history_style_review(uuid, text, text, text)', 'execute')
     or has_function_privilege('anon', 'social_history_style_approved(uuid, text)', 'execute') then
    raise exception 'style verify: grants are wider than designed';
  end if;
end $$;
