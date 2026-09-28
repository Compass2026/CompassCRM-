-- Source Asset Governance, step 1: hashing provenance and a stricter review
-- (Sept 28 2026). Builds on 0054; enables nothing, approves nothing, changes
-- no image, post or policy.
--
-- 0054 let any caller (the worker's SQL included) write brand_assets
-- .content_hash, and approved an image with only a hash, dimensions and (for
-- a photo) the own-work decision. A hash is only worth governing if it is the
-- hash of the stored bytes, so:
--
-- 1. content_hash, content_hashed_at and content_measurement are written only
--    by brand_asset_record_hash(), called by the source-assets Edge Function
--    (PostgREST authenticator + service_role, compass.source_hash set for the
--    transaction). The function downloads the stored file from the
--    brand-assets bucket, hashes and measures the bytes it read, and records
--    them here. It never writes image bytes, storage paths or anything else.
--    The record is a compare-and-set on the path and the hash the caller saw,
--    requires the storage object to exist (and its recorded size to match),
--    and is a no-op when nothing changed (idempotent).
-- 2. Any other change to the file fields (storage_path, url, width, height)
--    clears the hash: the measurement no longer attests to the bytes. 0054
--    already resets the review on a file change; a cleared or changed hash is
--    a file change too, and 0054's recheck lapses any approved post whose
--    creative used the image.
-- 3. Approval for creative use now requires, besides 0054's stored file,
--    hash and dimensions: a hash recorded by the source-assets function
--    (content_hashed_at), the storage object present in the brand-assets
--    bucket, at least one governed subject tag (lower-case words), and for a
--    photo the own-work decision and a focal point. Exclusion still needs a
--    reason (0054). A teammate may also set an image back to unreviewed.
-- 4. History: every hash recorded, changed or cleared is a
--    creative_governance_events row (actor 'hasher' for the function), and an
--    approval event carries the content hash it approved.
--
-- AI suggestions stay in creative_suggestions (0054): never governed, never
-- read by approval or by the Creative Engine.
--
-- Rollback (while no asset is hashed or approved): restore 0054's
-- brand_assets_creative_guard / brand_assets_creative_history /
-- creative_actor_kind and the approval constraint; drop the new columns,
-- functions and the actor-kind value.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from brand_assets where creative_use = 'approved') then
    raise exception '0055: an asset is already approved; the stricter approval rule was written for none';
  end if;
  -- 0054 let any caller write a hash; none was written (production: 0 of
  -- 106). A hash nobody measured is not trusted into the new rule.
  if exists (select 1 from brand_assets where content_hash is not null) then
    raise exception '0055: an asset carries a hash from before the source-assets function';
  end if;
end $$;

-- ── 1. Columns ──────────────────────────────────────────────────────────────
alter table brand_assets
  add column content_hashed_at timestamptz,
  add column content_measurement jsonb,
  add constraint brand_assets_hash_recorded check (
    (content_hash is null and content_hashed_at is null and content_measurement is null)
    or (content_hash is not null and content_hashed_at is not null and jsonb_typeof(content_measurement) = 'object'));
comment on column brand_assets.content_hash is
  'sha256 (hex) of the stored file''s bytes, recorded only by the source-assets function (0055). Cleared when the file fields change.';
comment on column brand_assets.content_measurement is
  'What the source-assets function read: {bytes, content_type, raw_width, raw_height, orientation, measured_by}.';

-- Subject tags: short lower-case words (a governed vocabulary, not free text).
create function creative_subjects_valid(p text[]) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(bool_and(s ~ '^[a-z0-9][a-z0-9 -]{0,39}$'), true) from unnest(p) s
$$;
-- A check constraint runs it as the writer: pure and harmless, so granted.
revoke all on function creative_subjects_valid(text[]) from public, anon;
grant execute on function creative_subjects_valid(text[]) to authenticated, service_role;

alter table brand_assets
  drop constraint brand_assets_creative_approved_complete,
  add constraint brand_assets_creative_approved_complete check (
    creative_use <> 'approved'
    or (storage_path is not null and content_hash is not null and content_hashed_at is not null
        and width > 0 and height > 0 and cardinality(subjects) > 0
        and (kind::text <> 'photo' or (depicts_own_work is not null and focal_x is not null)))),
  add constraint brand_assets_subjects_vocabulary check (creative_subjects_valid(subjects));

-- ── 2. Who is calling ───────────────────────────────────────────────────────
create function source_hash_session_active() returns boolean
language sql stable set search_path = public as $$
  select drafter_caller_is_service() and coalesce(current_setting('compass.source_hash', true), '') = 'on'
$$;
revoke all on function source_hash_session_active() from public, anon, authenticated;
grant execute on function source_hash_session_active() to service_role;

alter table creative_governance_events drop constraint creative_governance_events_actor_kind_check;
alter table creative_governance_events add constraint creative_governance_events_actor_kind_check
  check (actor_kind in ('team', 'worker', 'system', 'creative', 'superuser', 'hasher'));

create or replace function creative_actor_kind() returns text
language sql stable security definer set search_path = public as $$
  select case
    when source_hash_session_active() then 'hasher'
    when creative_session_active() then 'creative'
    when coalesce(current_setting('compass.post_system', true), '') = 'on' then 'system'
    when post_caller_is_human() then 'team'
    when drafter_caller_is_superuser() then 'superuser'
    else 'worker'
  end
$$;
revoke all on function creative_actor_kind() from public, anon, authenticated;

-- ── 3. The guard (0054's, plus hash provenance and the stored-file check) ──
create or replace function brand_assets_creative_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_human boolean := post_caller_is_human();
  v_super boolean := drafter_caller_is_superuser();
  v_hasher boolean := source_hash_session_active();
  v_file_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.creative_use <> 'unreviewed' or new.creative_reviewed_by is not null or new.creative_reviewed_at is not null then
      if not v_super then
        raise exception 'A new asset starts unreviewed; a teammate reviews it for creative use afterwards'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
    if (new.content_hash is not null or new.content_hashed_at is not null or new.content_measurement is not null)
       and not v_super then
      raise exception 'A content hash is recorded by the source-assets function after the file is stored'
        using errcode = 'insufficient_privilege';
    end if;
    if not (v_human or v_super) then
      new.depicts_own_work := null; new.subjects := '{}'; new.focal_x := null; new.focal_y := null;
      new.creative_review_note := null;
    end if;
    return new;
  end if;

  -- The hash is a measurement of the stored bytes: only the source-assets
  -- function records it.
  if (new.content_hash, new.content_hashed_at, new.content_measurement)
     is distinct from (old.content_hash, old.content_hashed_at, old.content_measurement)
     and not (v_hasher or v_super) then
    raise exception 'Content hashes are recorded only by the source-assets function' using errcode = 'insufficient_privilege';
  end if;
  -- Any other change to the file clears the measurement.
  if (new.storage_path, new.url, new.width, new.height) is distinct from (old.storage_path, old.url, old.width, old.height)
     and not (v_hasher or v_super) then
    new.content_hash := null;
    new.content_hashed_at := null;
    new.content_measurement := null;
  end if;

  v_file_changed := (new.storage_path, new.url, new.content_hash, new.width, new.height)
                    is distinct from (old.storage_path, old.url, old.content_hash, old.width, old.height);

  if (new.creative_use, new.depicts_own_work, new.subjects, new.focal_x, new.focal_y, new.creative_review_note)
     is distinct from
     (old.creative_use, old.depicts_own_work, old.subjects, old.focal_x, old.focal_y, old.creative_review_note) then
    if not (v_human or v_super) then
      raise exception 'Only a signed-in Compass teammate reviews an asset for creative use'
        using errcode = 'insufficient_privilege';
    end if;
    new.creative_reviewed_by := case when v_human then task_actor() else old.creative_reviewed_by end;
    new.creative_reviewed_at := now();
  else
    new.creative_reviewed_by := old.creative_reviewed_by;
    new.creative_reviewed_at := old.creative_reviewed_at;
  end if;

  -- A review covers these exact bytes: a new file is unreviewed again.
  if v_file_changed and new.creative_use <> 'unreviewed' then
    new.creative_use := 'unreviewed';
    new.creative_reviewed_by := null;
    new.creative_reviewed_at := null;
  end if;

  -- Approving needs the stored file itself, not only its record.
  if new.creative_use = 'approved' and not v_super
     and not exists (select 1 from storage.objects where bucket_id = 'brand-assets' and name = new.storage_path) then
    raise exception 'The stored file is missing from the brand-assets bucket; it cannot be approved'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function brand_assets_creative_guard() from public, anon, authenticated;

-- ── 4. History (0054's, plus hashing and the approved hash) ─────────────────
create or replace function brand_assets_creative_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_changes jsonb := creative_diff(to_jsonb(old), to_jsonb(new),
    array['creative_use', 'depicts_own_work', 'subjects', 'focal_x', 'focal_y', 'creative_review_note']);
  v_file jsonb := creative_diff(to_jsonb(old), to_jsonb(new), array['storage_path', 'url', 'content_hash', 'width', 'height']);
begin
  if new.content_hash is distinct from old.content_hash then
    perform creative_governance_log(new.client_id, 'brand_asset', new.id,
      case when old.content_hash is null then 'hashed' when new.content_hash is null then 'hash_cleared' else 'rehashed' end,
      v_file || jsonb_strip_nulls(jsonb_build_object('measurement', new.content_measurement)));
  end if;
  if v_changes = '{}'::jsonb then return null; end if;
  perform creative_governance_log(new.client_id, 'brand_asset', new.id,
    case
      when old.creative_use <> 'unreviewed' and new.creative_use = 'unreviewed' and v_file <> '{}'::jsonb then 'reset_file_changed'
      when new.creative_use is distinct from old.creative_use then new.creative_use
      else 'metadata_changed'
    end,
    v_changes
      || case when v_file <> '{}'::jsonb then jsonb_build_object('file', v_file) else '{}'::jsonb end
      || case when new.creative_use = 'approved' then jsonb_build_object('approved_content_hash', new.content_hash) else '{}'::jsonb end,
    new.creative_review_note);
  return null;
end $$;
revoke all on function brand_assets_creative_history() from public, anon, authenticated;

-- ── 5. The governed write ───────────────────────────────────────────────────
-- p: {asset_id, storage_path, expected_hash (the hash the caller read, or
--     null), content_hash, width, height (display, after EXIF orientation),
--     byte_size, content_type, raw_width, raw_height, orientation, measured_by}
create function brand_asset_record_hash(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  a brand_assets;
  v_obj record;
  v_hash text := p->>'content_hash';
  v_w int := (p->>'width')::int;
  v_h int := (p->>'height')::int;
  v_bytes bigint := (p->>'byte_size')::bigint;
  v_type text := p->>'content_type';
  v_measure jsonb;
begin
  if not drafter_caller_is_service() then
    raise exception 'brand_asset_record_hash runs only in the source-assets function' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.source_hash', 'on', true);

  select * into a from brand_assets where id = (p->>'asset_id')::uuid for update;
  if a.id is null then
    raise exception 'asset_missing: No such brand asset' using errcode = 'check_violation';
  end if;
  if a.storage_path is null or a.storage_path is distinct from p->>'storage_path' then
    raise exception 'path_changed: The asset''s stored file is not the one that was read' using errcode = 'check_violation';
  end if;
  if a.content_hash is distinct from nullif(p->>'expected_hash', '') then
    raise exception 'hash_changed: The asset''s hash changed since it was read' using errcode = 'check_violation';
  end if;
  if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A content hash is a sha256 hex digest' using errcode = 'check_violation';
  end if;
  if v_w is null or v_h is null or v_w <= 0 or v_h <= 0 or v_bytes is null or v_bytes <= 0 then
    raise exception 'The measurement needs width, height and size' using errcode = 'check_violation';
  end if;
  if v_type not in ('image/png', 'image/jpeg', 'image/gif', 'image/webp') then
    raise exception 'unsupported_type: % is not a measurable image type', coalesce(v_type, 'unknown') using errcode = 'check_violation';
  end if;
  select * into v_obj from storage.objects where bucket_id = 'brand-assets' and name = a.storage_path;
  if not found then
    raise exception 'object_missing: The stored file is not in the brand-assets bucket' using errcode = 'check_violation';
  end if;
  if (v_obj.metadata->>'size') is not null and (v_obj.metadata->>'size')::bigint <> v_bytes then
    raise exception 'size_mismatch: The bytes read are not the stored object''s size' using errcode = 'check_violation';
  end if;

  if a.content_hash = v_hash and a.width is not distinct from v_w and a.height is not distinct from v_h then
    return jsonb_build_object('asset_id', a.id, 'status', 'unchanged', 'content_hash', v_hash);
  end if;

  v_measure := jsonb_build_object('bytes', v_bytes, 'content_type', v_type,
    'raw_width', (p->>'raw_width')::int, 'raw_height', (p->>'raw_height')::int,
    'orientation', coalesce((p->>'orientation')::int, 1), 'measured_by', coalesce(p->>'measured_by', 'source-assets'));
  update brand_assets
     set content_hash = v_hash, content_hashed_at = now(), content_measurement = v_measure, width = v_w, height = v_h
   where id = a.id;
  return jsonb_build_object('asset_id', a.id,
    'status', case when a.content_hash is null then 'hashed' when a.content_hash = v_hash then 'measured' else 'rehashed' end,
    'content_hash', v_hash, 'previous_hash', a.content_hash,
    'previous_width', a.width, 'previous_height', a.height, 'width', v_w, 'height', v_h,
    'review_reset', a.creative_use <> 'unreviewed');
end $$;
revoke all on function brand_asset_record_hash(jsonb) from public, anon, authenticated;
grant execute on function brand_asset_record_hash(jsonb) to service_role;

-- ── 6. Verify ───────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from brand_assets where content_hash is not null or content_hashed_at is not null) then
    raise exception '0055: an asset carries a hash the source-assets function did not record';
  end if;
  if exists (select 1 from brand_assets where creative_use = 'approved') then
    raise exception '0055: an asset is approved';
  end if;
  if has_function_privilege('authenticated', 'public.brand_asset_record_hash(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.brand_asset_record_hash(jsonb)', 'execute')
     or (select prosecdef from pg_proc where oid = 'public.brand_asset_record_hash(jsonb)'::regprocedure) then
    raise exception '0055: brand_asset_record_hash must be the service role''s, with its rights';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
             where ns.nspname = 'public'
               and p.proname in ('source_hash_session_active', 'creative_actor_kind',
                                 'brand_assets_creative_guard', 'brand_assets_creative_history')
               and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) then
    raise exception '0055: an internal function is callable over the API';
  end if;
  if (select prosrc from pg_proc where oid = 'public.brand_assets_creative_guard()'::regprocedure) not like '%source_hash_session_active%' then
    raise exception '0055: the guard lost the hash rule';
  end if;
end $$;
