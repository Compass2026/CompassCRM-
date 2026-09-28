-- Creative Engine, step 1: the database (Sept 28 2026; architecture approved
-- Sept 28). Schema, governance and write boundaries only. No renderer, no
-- template, no client policy and no creative exist after this migration; no
-- post changes, and every existing approval hash stays valid (checked in the
-- verify block).
--
-- Decisions this implements (docs/client-intelligence.md, "Creative Engine"):
--   * Composition first. A creative is (1) an approved source photo in a
--     branded composition, (2) a brand-only graphic, or (3) later, a generated
--     NON-representational layer (texture, abstract background, shapes) where
--     the client's policy permits. Representational generated imagery (roofs,
--     houses, crews, customers, projects, damage, before / after,
--     testimonials) has no setting at all: it cannot be switched on.
--   * Overlay text only from governed strings: the business name, the post's
--     approved service name, the approved tagline, the brand board's standing
--     CTA, a usable claim linked to the post, or the post's confirmed offer
--     title. Each overlay line must EQUAL its source; the primary line is at
--     most 8 words, and there are at most 3 lines (none is fine).
--   * Source photos are governed on brand_assets: creative_use unreviewed /
--     approved / excluded, own-work flag, subject tags, dimensions, focal
--     point, reviewer and time. Only a signed-in teammate changes them; AI
--     suggestions live in creative_suggestions and are never governed truth.
--     A changed file (path, url, hash, dimensions) resets the review. Every
--     governance change is recorded in creative_governance_events.
--   * Policy per client and channel (client_creative_settings); no row means
--     'none', the global default. This migration enables nothing.
--   * Templates are Compass's, versioned and immutable once registered
--     (creative_templates, written only by the Creative Engine function). A
--     client may use only template versions a teammate approved for it after
--     seeing a client-specific preview (client_creative_templates); a new
--     version is a new row and needs its own approval.
--   * creative_runs: one render attempt, idempotent on (post, brief hash,
--     template spec hash); at most one rendering run per post.
--   * creative_assets: immutable, content-addressed files in the private
--     creative-assets bucket at <client>/<sha256>.<ext>; unique per client and
--     hash. creative_asset_sources records every source image with the hash
--     and governance it had when used.
--   * post_assets gains creative links (exactly one of brand asset / creative
--     asset per row; a surrogate key). A creative link records the sha256 of
--     the copy it was made for; a copy change unlinks it.
--   * social_posts gains creative_policy (fixed at creation from the settings;
--     a teammate may change it on a draft), creative_status, creative_version
--     and rejection_category (copy / creative / both).
--   * Approval binds the exact copy and the exact creative bytes: the snapshot
--     gains a 'creative' key (asset id, content hash, path, format, size,
--     template and spec hash, copy hash) ONLY when the post has creative, so
--     the snapshot of every existing post is byte-identical.
--   * Grounding (0045) additionally refuses: required creative missing, a
--     withdrawn creative, creative made for other copy, a source image no
--     longer approved, changed or deleted. So a governance change lapses an
--     approved post exactly as a claim change does.
--   * request_new_creative(post, note): a teammate's "Request new creative".
--     The copy stays; no Drafter run; the post returns to draft with its
--     creative unlinked and creative_status 'requested'.
--   * Manual creative: the Creative Engine function hashes a teammate's upload
--     and records it with strategy 'manual', the uploader and provenance. Same
--     review and approval rules.
--
-- Write boundary (as 0045 / 0047): Creative Engine writes happen only in the
-- creative session — PostgREST's authenticator login with the service role,
-- inside creative_begin_run / creative_write / creative_fail_run /
-- creative_register_template (compass.creative_write set for the
-- transaction). The worker's SQL (session_user postgres) can never be that
-- session. Governance is a signed-in teammate's alone. True superusers are
-- exempt, as in 0047.
--
-- Platform limits (GBP sizes, formats, crops) are NOT in this schema: a
-- template carries its output size and type as data, and the channel adapter
-- (later, in code) checks the platform's current published requirements.
--
-- Rollback (while no creative exists): drop the new triggers, functions,
-- tables, bucket policy and storage trigger; restore 0045's snapshot,
-- grounding and link functions, 0047's post_caller_kind and link guard, and
-- 0053's drafter_write; drop the added columns and restore post_assets'
-- (post_id, brand_asset_id) primary key.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
-- (post_assets may hold brand-asset links: each gets a surrogate id, and the
-- (post_id, brand_asset_id) key stays unique; their snapshot is unchanged.)
do $$
begin
  if to_regclass('public.creative_assets') is not null then
    raise exception '0054: creative_assets already exists';
  end if;
end $$;

-- ── 1. Who is calling ───────────────────────────────────────────────────────
-- The Creative Engine function inside one of its governed writes.
create function creative_session_active() returns boolean
language sql stable set search_path = public as $$
  select drafter_caller_is_service() and coalesce(current_setting('compass.creative_write', true), '') = 'on'
$$;
revoke all on function creative_session_active() from public, anon, authenticated;
grant execute on function creative_session_active() to service_role;

-- A signed-in teammate through PostgREST, for invoker functions (0045's
-- post_caller_is_human is security definer and not granted to the API).
create function creative_caller_is_teammate() returns boolean
language sql stable set search_path = public as $$
  select session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'authenticated' and is_team()
$$;
revoke all on function creative_caller_is_teammate() from public, anon;
grant execute on function creative_caller_is_teammate() to authenticated;

-- The Creative Engine is its own actor in post history (never "publisher").
alter table post_events drop constraint post_events_actor_kind_check;
alter table post_events add constraint post_events_actor_kind_check
  check (actor_kind in ('team', 'worker', 'system', 'publisher', 'drafter', 'creative'));
alter table post_events drop constraint post_events_kind_check;
alter table post_events add constraint post_events_kind_check check (kind in (
  'created', 'edited', 'claim_linked', 'claim_unlinked', 'asset_linked', 'asset_unlinked',
  'submitted', 'withdrawn', 'approved', 'rejected', 'revised', 'reopened', 'grounding_lapsed',
  'scheduled', 'rescheduled', 'unscheduled', 'publishing', 'published', 'failed', 'retried',
  'creative_linked', 'creative_unlinked', 'creative_requested', 'creative_failed',
  'creative_policy_changed', 'rejection_classified'));

create or replace function post_caller_kind() returns text
language sql stable security definer set search_path = public as $$
  select case
    when drafter_session_active() then 'drafter'
    when creative_session_active() then 'creative'
    when coalesce(current_setting('compass.post_system', true), '') = 'on' then 'system'
    when post_caller_is_human() then 'team'
    when session_user = 'authenticator' and current_setting('role', true) = 'service_role' then 'publisher'
    else 'worker'
  end
$$;
revoke execute on function post_caller_kind() from public, anon, authenticated;

-- ── 2. Governance history ───────────────────────────────────────────────────
create table creative_governance_events (
  id bigint generated always as identity primary key,
  client_id uuid not null references clients(id) on delete cascade,
  subject_type text not null check (subject_type in ('brand_asset', 'template', 'client_template', 'client_setting', 'creative_asset')),
  subject_id uuid not null,
  actor_id uuid references team_members(id) on delete set null,
  actor_kind text not null check (actor_kind in ('team', 'worker', 'system', 'creative', 'superuser')),
  action text not null,
  changes jsonb not null default '{}',
  note text,
  created_at timestamptz not null default now()
);
create index creative_governance_events_subject_idx on creative_governance_events (subject_type, subject_id, id);
create index creative_governance_events_client_idx on creative_governance_events (client_id, id);
comment on table creative_governance_events is
  'Append-only history of creative governance: source-image review, template registration and client approval, creative policy, creative withdrawal. Written only by trigger.';

-- Written only from inside the governance triggers (trigger depth > 0), never
-- by a statement, and never changed; the client's deletion cascades.
create function creative_governance_events_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if drafter_caller_is_superuser() then return coalesce(new, old); end if;
  if tg_op = 'INSERT' then
    if pg_trigger_depth() < 2 then
      raise exception 'Creative governance history is written only by trigger' using errcode = 'insufficient_privilege';
    end if;
    new.created_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then return old; end if;
  raise exception 'Creative governance history is append-only' using errcode = 'insufficient_privilege';
end $$;
revoke all on function creative_governance_events_guard() from public, anon, authenticated;
create trigger creative_governance_events_guard before insert or update or delete on creative_governance_events
  for each row execute function creative_governance_events_guard();

create function creative_actor_kind() returns text
language sql stable security definer set search_path = public as $$
  select case
    when creative_session_active() then 'creative'
    when coalesce(current_setting('compass.post_system', true), '') = 'on' then 'system'
    when post_caller_is_human() then 'team'
    when drafter_caller_is_superuser() then 'superuser'
    else 'worker'
  end
$$;
revoke all on function creative_actor_kind() from public, anon, authenticated;

create function creative_governance_log(p_client uuid, p_type text, p_subject uuid, p_action text,
                                        p_changes jsonb, p_note text default null) returns void
language sql security definer set search_path = public as $$
  insert into creative_governance_events (client_id, subject_type, subject_id, actor_id, actor_kind, action, changes, note)
  values (p_client, p_type, p_subject, case when post_caller_is_human() then task_actor() end,
          creative_actor_kind(), p_action, coalesce(p_changes, '{}'), p_note)
$$;
revoke all on function creative_governance_log(uuid, text, uuid, text, jsonb, text) from public, anon, authenticated;

-- {field: {from, to}} for the named fields that differ.
create function creative_diff(p_old jsonb, p_new jsonb, p_fields text[]) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(f, jsonb_build_object('from', p_old->f, 'to', p_new->f)), '{}')
  from unnest(p_fields) f where (p_old->f) is distinct from (p_new->f)
$$;
revoke all on function creative_diff(jsonb, jsonb, text[]) from public, anon, authenticated;

-- ── 3. Source-image governance on brand_assets ──────────────────────────────
alter table brand_assets
  add column content_hash text,
  add column creative_use text not null default 'unreviewed',
  add column depicts_own_work boolean,
  add column subjects text[] not null default '{}',
  add column focal_x numeric,
  add column focal_y numeric,
  add column creative_reviewed_by uuid references team_members(id) on delete set null,
  add column creative_reviewed_at timestamptz,
  add column creative_review_note text,
  add column creative_suggestions jsonb,
  add constraint brand_assets_content_hash_format check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  add constraint brand_assets_creative_use_known check (creative_use in ('unreviewed', 'approved', 'excluded')),
  add constraint brand_assets_focal_point check (
    (focal_x is null and focal_y is null)
    or (focal_x between 0 and 1 and focal_y between 0 and 1)),
  add constraint brand_assets_subjects_bounded check (cardinality(subjects) <= 20),
  add constraint brand_assets_creative_reviewed check (
    creative_use = 'unreviewed' or creative_reviewed_at is not null),
  add constraint brand_assets_creative_approved_complete check (
    creative_use <> 'approved'
    or (storage_path is not null and content_hash is not null and width > 0 and height > 0
        and (kind::text <> 'photo' or depicts_own_work is not null))),
  add constraint brand_assets_creative_excluded_explained check (
    creative_use <> 'excluded' or nullif(btrim(creative_review_note), '') is not null);
create index brand_assets_creative_use_idx on brand_assets (client_id, creative_use);
comment on column brand_assets.creative_use is
  'May the Creative Engine use this file? unreviewed (default; never used) / approved / excluded. Set only by a signed-in teammate; a changed file resets it (0054).';
comment on column brand_assets.depicts_own_work is
  'Governed: the photo shows this client''s own work or business. A photo is used as a creative source only when true.';
comment on column brand_assets.creative_suggestions is
  'Machine suggestions (own work, subjects, focal point, measured size). Not governed; a teammate copies what is right into the governed fields.';

create function brand_assets_creative_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_human boolean := post_caller_is_human();
  v_super boolean := drafter_caller_is_superuser();
  v_file_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.creative_use <> 'unreviewed' or new.creative_reviewed_by is not null or new.creative_reviewed_at is not null then
      if not v_super then
        raise exception 'A new asset starts unreviewed; a teammate reviews it for creative use afterwards'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
    if not (v_human or v_super) then
      new.depicts_own_work := null; new.subjects := '{}'; new.focal_x := null; new.focal_y := null;
      new.creative_review_note := null;
    end if;
    return new;
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
  return new;
end $$;
revoke all on function brand_assets_creative_guard() from public, anon, authenticated;
create trigger brand_assets_creative_guard before insert or update on brand_assets
  for each row execute function brand_assets_creative_guard();

create function brand_assets_creative_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_changes jsonb := creative_diff(to_jsonb(old), to_jsonb(new),
    array['creative_use', 'depicts_own_work', 'subjects', 'focal_x', 'focal_y', 'creative_review_note']);
  v_file jsonb := creative_diff(to_jsonb(old), to_jsonb(new), array['storage_path', 'url', 'content_hash', 'width', 'height']);
begin
  if v_changes = '{}'::jsonb then return null; end if;
  perform creative_governance_log(new.client_id, 'brand_asset', new.id,
    case
      when old.creative_use <> 'unreviewed' and new.creative_use = 'unreviewed' and v_file <> '{}'::jsonb then 'reset_file_changed'
      when new.creative_use is distinct from old.creative_use then new.creative_use
      else 'metadata_changed'
    end,
    v_changes || case when v_file <> '{}'::jsonb then jsonb_build_object('file', v_file) else '{}'::jsonb end,
    new.creative_review_note);
  return null;
end $$;
revoke all on function brand_assets_creative_history() from public, anon, authenticated;
create trigger brand_assets_creative_history after update on brand_assets
  for each row execute function brand_assets_creative_history();

-- ── 4. Creative policy per client and channel ───────────────────────────────
create table client_creative_settings (
  client_id uuid not null references clients(id) on delete cascade,
  channel social_platform not null,
  creative_policy text not null default 'none' check (creative_policy in ('none', 'optional', 'required')),
  -- Representational generated imagery is not an option.
  generated_imagery text not null default 'off' check (generated_imagery in ('off', 'non_representational')),
  updated_by uuid references team_members(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (client_id, channel)
);
comment on table client_creative_settings is
  'Creative policy per client and channel. No row = none (the global default). Written only by a signed-in teammate; history in creative_governance_events.';

create function creative_policy_for(p_client uuid, p_channel text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select creative_policy from client_creative_settings
                    where client_id = p_client and channel::text = p_channel), 'none')
$$;
revoke all on function creative_policy_for(uuid, text) from public, anon, authenticated;

create function client_creative_settings_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not (post_caller_is_human() or drafter_caller_is_superuser()) then
    if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then return old; end if;
    raise exception 'Only a signed-in Compass teammate sets a client''s creative policy' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Set the policy to none instead of deleting it' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and (new.client_id, new.channel) is distinct from (old.client_id, old.channel) then
    raise exception 'A setting row keeps its client and channel' using errcode = 'check_violation';
  end if;
  new.updated_by := task_actor();
  new.updated_at := now();
  return new;
end $$;
revoke all on function client_creative_settings_guard() from public, anon, authenticated;
create trigger client_creative_settings_guard before insert or update or delete on client_creative_settings
  for each row execute function client_creative_settings_guard();

create function client_creative_settings_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_changes jsonb := case when tg_op = 'INSERT'
    then creative_diff(jsonb_build_object('creative_policy', 'none', 'generated_imagery', 'off'), to_jsonb(new),
                       array['creative_policy', 'generated_imagery'])
    else creative_diff(to_jsonb(old), to_jsonb(new), array['creative_policy', 'generated_imagery']) end;
begin
  if v_changes <> '{}'::jsonb then
    perform creative_governance_log(new.client_id, 'client_setting', new.client_id,
      'policy_changed', v_changes || jsonb_build_object('channel', new.channel::text));
  end if;
  return null;
end $$;
revoke all on function client_creative_settings_history() from public, anon, authenticated;
create trigger client_creative_settings_history after insert or update on client_creative_settings
  for each row execute function client_creative_settings_history();

-- ── 5. Templates and client approvals ───────────────────────────────────────
create table creative_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  version int not null check (version >= 1),
  channel social_platform not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text,
  output_width int not null check (output_width between 64 and 8192),
  output_height int not null check (output_height between 64 and 8192),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  spec jsonb not null,
  spec_hash text not null check (spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  status text not null default 'published' check (status in ('published', 'retired')),
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (key, version),
  constraint creative_templates_retired check (status <> 'retired' or retired_at is not null)
);
comment on table creative_templates is
  'Compass''s deterministic, versioned creative templates. Registered only by the Creative Engine function; immutable once registered (a change is a new version). Retiring stops new use.';

create function creative_spec_hash(p_spec jsonb) returns text
language sql immutable set search_path = public, extensions, pg_catalog as $$
  select 'sha256:' || encode(sha256(convert_to(p_spec::text, 'UTF8')), 'hex')
$$;
revoke all on function creative_spec_hash(jsonb) from public, anon, authenticated;
grant execute on function creative_spec_hash(jsonb) to service_role;

create function creative_templates_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if drafter_caller_is_superuser() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    raise exception 'Templates are never deleted; retire them' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if not creative_session_active() then
      raise exception 'Templates are registered only by the Creative Engine function' using errcode = 'insufficient_privilege';
    end if;
    if new.status <> 'published' then
      raise exception 'A template is registered published' using errcode = 'check_violation';
    end if;
    new.spec_hash := creative_spec_hash(new.spec);
    new.created_at := now();
    new.retired_at := null;
    return new;
  end if;
  -- UPDATE: published → retired, by the Creative Engine or a teammate; nothing else changes.
  if not (creative_session_active() or post_caller_is_human()) then
    raise exception 'Only the Creative Engine function or a teammate retires a template' using errcode = 'insufficient_privilege';
  end if;
  if not (old.status = 'published' and new.status = 'retired'
          and (to_jsonb(new) - 'status' - 'retired_at') = (to_jsonb(old) - 'status' - 'retired_at')) then
    raise exception 'A registered template is immutable; register a new version' using errcode = 'check_violation';
  end if;
  new.retired_at := now();
  return new;
end $$;
revoke all on function creative_templates_guard() from public, anon, authenticated;
create trigger creative_templates_guard before insert or update or delete on creative_templates
  for each row execute function creative_templates_guard();

create function creative_templates_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  c uuid;
begin
  -- Templates are global; the event is filed under each client that approved
  -- this version (retirement) and under no client at registration.
  if tg_op = 'UPDATE' then
    for c in select client_id from client_creative_templates where template_id = new.id loop
      perform creative_governance_log(c, 'template', new.id, 'retired',
        jsonb_build_object('key', new.key, 'version', new.version));
    end loop;
  end if;
  return null;
end $$;
revoke all on function creative_templates_history() from public, anon, authenticated;
create trigger creative_templates_history after update on creative_templates
  for each row execute function creative_templates_history();

-- ── 6. Runs, assets, sources ────────────────────────────────────────────────
create table creative_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  post_id uuid,
  purpose text not null check (purpose in ('post', 'template_preview')),
  reason text not null check (reason in ('initial', 'regenerate', 'copy_changed', 'retry', 'preview')),
  strategy text not null check (strategy in ('source_photo', 'brand_graphic', 'generated_layer')),
  template_id uuid not null references creative_templates(id),
  template_spec_hash text not null check (template_spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  requested_via text not null check (requested_via in ('worker', 'team', 'system')),
  requested_by uuid references team_members(id) on delete set null,
  copy_hash text check (copy_hash ~ '^[0-9a-f]{64}$'),
  brief jsonb not null,
  brief_hash text not null check (brief_hash ~ '^sha256:[0-9a-f]{64}$'),
  renderer text not null check (length(btrim(renderer)) between 1 and 80),
  status text not null default 'rendering' check (status in ('rendering', 'succeeded', 'failed', 'cancelled')),
  error text,
  creative_asset_id uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint creative_runs_id_client_key unique (id, client_id),
  constraint creative_runs_post_fk foreign key (post_id, client_id)
    references social_posts (id, client_id) on delete set null (post_id),
  constraint creative_runs_purpose_shape check (
    (purpose = 'post' and copy_hash is not null and reason <> 'preview')
    or (purpose = 'template_preview' and post_id is null and copy_hash is null and reason = 'preview')),
  constraint creative_runs_finished check ((status = 'rendering') = (finished_at is null)),
  constraint creative_runs_succeeded_has_asset check (status <> 'succeeded' or creative_asset_id is not null),
  constraint creative_runs_failed_explained check (status <> 'failed' or nullif(btrim(error), '') is not null)
);
-- One rendering run per post; a repeat of the same inputs is the same run
-- (unless it failed); the same for a template preview per client.
create unique index creative_runs_one_rendering_per_post on creative_runs (post_id) where status = 'rendering';
create unique index creative_runs_post_idempotency on creative_runs (post_id, brief_hash, template_spec_hash)
  where purpose = 'post' and status <> 'failed' and post_id is not null;
create unique index creative_runs_preview_idempotency on creative_runs (client_id, template_id, brief_hash)
  where purpose = 'template_preview' and status <> 'failed';
create index creative_runs_client_idx on creative_runs (client_id, created_at desc);
comment on table creative_runs is
  'One Creative Engine render attempt: inputs (brief, template spec hash, copy hash), renderer label, outcome. Written only by the Creative Engine function.';

create table creative_assets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  storage_bucket text not null default 'creative-assets' check (storage_bucket = 'creative-assets'),
  storage_path text not null,
  format text not null check (format in ('png', 'jpeg', 'webp')),
  mime_type text not null,
  width int not null check (width > 0),
  height int not null check (height > 0),
  size_bytes bigint not null check (size_bytes > 0),
  strategy text not null check (strategy in ('source_photo', 'brand_graphic', 'generated_layer', 'manual')),
  purpose text not null check (purpose in ('post', 'template_preview')),
  template_id uuid references creative_templates(id),
  template_spec_hash text check (template_spec_hash ~ '^sha256:[0-9a-f]{64}$'),
  run_id uuid,
  overlay jsonb not null default '[]' check (jsonb_typeof(overlay) = 'array'),
  alt_text text,
  generation jsonb not null default '{}' check (jsonb_typeof(generation) = 'object'),
  uploaded_by uuid references team_members(id) on delete set null,
  provenance jsonb not null default '{}' check (jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_by uuid references team_members(id) on delete set null,
  withdrawn_reason text,
  constraint creative_assets_id_client_key unique (id, client_id),
  constraint creative_assets_client_hash_key unique (client_id, content_hash),
  constraint creative_assets_path_key unique (storage_path),
  constraint creative_assets_content_addressed check (
    storage_path = client_id::text || '/' || content_hash || '.'
                   || case format when 'jpeg' then 'jpg' else format end),
  constraint creative_assets_mime_matches check (mime_type = 'image/' || format),
  constraint creative_assets_run_fk foreign key (run_id, client_id) references creative_runs (id, client_id),
  constraint creative_assets_manual_shape check (
    (strategy = 'manual' and run_id is null and template_id is null and template_spec_hash is null
       and purpose = 'post' and provenance ? 'uploaded_via')
    or (strategy <> 'manual' and run_id is not null and template_id is not null and template_spec_hash is not null
       and uploaded_by is null)),
  constraint creative_assets_post_alt_text check (purpose <> 'post' or nullif(btrim(alt_text), '') is not null),
  constraint creative_assets_overlay_bounded check (jsonb_array_length(overlay) <= 3),
  constraint creative_assets_withdrawn_explained check (
    withdrawn_at is null or (withdrawn_by is not null and nullif(btrim(withdrawn_reason), '') is not null))
);
create index creative_assets_run_idx on creative_assets (run_id) where run_id is not null;
create index creative_assets_template_idx on creative_assets (template_id) where template_id is not null;
comment on table creative_assets is
  'Immutable, content-addressed creative files (bucket creative-assets, <client>/<sha256>.<ext>). Written only by the Creative Engine function; a teammate may only withdraw one.';

alter table creative_runs add constraint creative_runs_asset_fk foreign key (creative_asset_id, client_id)
  references creative_assets (id, client_id);

create table creative_asset_sources (
  creative_asset_id uuid not null,
  client_id uuid not null,
  ordinal int not null check (ordinal between 1 and 10),
  role text not null check (role in ('photo', 'logo')),
  brand_asset_id uuid,
  source_content_hash text not null check (source_content_hash ~ '^[0-9a-f]{64}$'),
  source_storage_path text not null,
  source_width int not null check (source_width > 0),
  source_height int not null check (source_height > 0),
  governance jsonb not null,
  crop jsonb,
  focal jsonb,
  primary key (creative_asset_id, ordinal),
  foreign key (creative_asset_id, client_id) references creative_assets (id, client_id) on delete cascade,
  -- The record outlives a deleted brand asset (the id goes null; the hash stays).
  foreign key (brand_asset_id, client_id) references brand_assets (id, client_id) on delete set null (brand_asset_id)
);
create index creative_asset_sources_brand_idx on creative_asset_sources (brand_asset_id) where brand_asset_id is not null;
comment on table creative_asset_sources is
  'Every source image a creative used, with the hash, size and governance it had at render time. Immutable.';

create table client_creative_templates (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  template_id uuid not null references creative_templates(id),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'revoked')),
  preview_asset_id uuid,
  approved_by uuid references team_members(id) on delete set null,
  approved_at timestamptz,
  revoked_by uuid references team_members(id) on delete set null,
  revoked_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  unique (client_id, template_id),
  foreign key (preview_asset_id, client_id) references creative_assets (id, client_id),
  constraint client_creative_templates_approved check (
    status <> 'approved' or (preview_asset_id is not null and approved_at is not null)),
  constraint client_creative_templates_revoked check (status <> 'revoked' or revoked_at is not null)
);
comment on table client_creative_templates is
  'Which exact template versions a client may use. A teammate approves each (client, template version) after seeing its client-specific preview; a new version needs its own approval.';

-- ── 7. Guards: runs, assets, sources, client templates ──────────────────────
create function creative_runs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if drafter_caller_is_superuser() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id) then return old; end if;
    raise exception 'Creative runs are a record and are not deleted' using errcode = 'insufficient_privilege';
  end if;
  -- The foreign key clearing post_id when a (rejected) post is deleted.
  if tg_op = 'UPDATE' and old.post_id is not null and new.post_id is null
     and not exists (select 1 from social_posts where id = old.post_id)
     and (to_jsonb(new) - 'post_id') = (to_jsonb(old) - 'post_id') then
    return new;
  end if;
  if not creative_session_active() then
    raise exception 'Creative runs are written only by the Creative Engine function' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'rendering' or new.creative_asset_id is not null then
      raise exception 'A run starts rendering' using errcode = 'check_violation';
    end if;
    new.created_at := now();
    new.finished_at := null;
    return new;
  end if;
  if old.status <> 'rendering' or new.status = 'rendering'
     or (to_jsonb(new) - 'status' - 'error' - 'creative_asset_id' - 'finished_at')
        <> (to_jsonb(old) - 'status' - 'error' - 'creative_asset_id' - 'finished_at') then
    raise exception 'A creative run is immutable once finished' using errcode = 'check_violation';
  end if;
  new.finished_at := now();
  return new;
end $$;
revoke all on function creative_runs_guard() from public, anon, authenticated;
create trigger creative_runs_guard before insert or update or delete on creative_runs
  for each row execute function creative_runs_guard();

create function creative_assets_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if drafter_caller_is_superuser() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id) then return old; end if;
    raise exception 'Creative assets are immutable and never deleted; withdraw one instead' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if not creative_session_active() then
      raise exception 'Creative assets are written only by the Creative Engine function' using errcode = 'insufficient_privilege';
    end if;
    if new.withdrawn_at is not null or new.withdrawn_by is not null or new.withdrawn_reason is not null then
      raise exception 'A new creative asset is not withdrawn' using errcode = 'check_violation';
    end if;
    new.created_at := now();
    return new;
  end if;
  -- UPDATE: a teammate withdraws it; nothing else ever changes.
  if not post_caller_is_human() then
    raise exception 'Only a signed-in Compass teammate withdraws a creative asset' using errcode = 'insufficient_privilege';
  end if;
  if old.withdrawn_at is not null or new.withdrawn_at is null
     or (to_jsonb(new) - 'withdrawn_at' - 'withdrawn_by' - 'withdrawn_reason')
        <> (to_jsonb(old) - 'withdrawn_at' - 'withdrawn_by' - 'withdrawn_reason') then
    raise exception 'A creative asset is immutable; it can only be withdrawn, once' using errcode = 'check_violation';
  end if;
  new.withdrawn_at := now();
  new.withdrawn_by := task_actor();
  return new;
end $$;
revoke all on function creative_assets_guard() from public, anon, authenticated;
create trigger creative_assets_guard before insert or update or delete on creative_assets
  for each row execute function creative_assets_guard();

create function creative_assets_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform creative_governance_log(new.client_id, 'creative_asset', new.id, 'withdrawn',
    jsonb_build_object('content_hash', new.content_hash), new.withdrawn_reason);
  return null;
end $$;
revoke all on function creative_assets_history() from public, anon, authenticated;
create trigger creative_assets_history after update of withdrawn_at on creative_assets
  for each row execute function creative_assets_history();

create function creative_asset_sources_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if drafter_caller_is_superuser() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from creative_assets where id = old.creative_asset_id) then return old; end if;
    raise exception 'Creative sources are a record and are not deleted' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    -- The one change: the brand asset was deleted (FK SET NULL).
    if old.brand_asset_id is not null and new.brand_asset_id is null
       and not exists (select 1 from brand_assets where id = old.brand_asset_id)
       and (to_jsonb(new) - 'brand_asset_id') = (to_jsonb(old) - 'brand_asset_id') then
      return new;
    end if;
    raise exception 'Creative sources are immutable' using errcode = 'check_violation';
  end if;
  if not creative_session_active() then
    raise exception 'Creative sources are written only by the Creative Engine function' using errcode = 'insufficient_privilege';
  end if;
  -- Only while the asset itself is being created (same transaction).
  if not exists (select 1 from creative_assets where id = new.creative_asset_id and created_at = now()) then
    raise exception 'Sources are recorded with their creative asset, never added later' using errcode = 'check_violation';
  end if;
  if new.brand_asset_id is null then
    raise exception 'A source names its brand asset' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function creative_asset_sources_guard() from public, anon, authenticated;
create trigger creative_asset_sources_guard before insert or update or delete on creative_asset_sources
  for each row execute function creative_asset_sources_guard();

create function client_creative_templates_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_human boolean := post_caller_is_human();
  v_creative boolean := creative_session_active();
  t creative_templates;
  a creative_assets;
begin
  if drafter_caller_is_superuser() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id) then return old; end if;
    raise exception 'Template approvals are a record; revoke instead' using errcode = 'insufficient_privilege';
  end if;
  if not (v_human or v_creative) then
    raise exception 'Template approvals are written only by a teammate or the Creative Engine function'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' or new.approved_by is not null or new.approved_at is not null
       or new.revoked_by is not null or new.revoked_at is not null then
      raise exception 'A template is proposed for a client first; approval follows its preview' using errcode = 'check_violation';
    end if;
    if new.preview_asset_id is not null and not v_creative then
      raise exception 'Previews are recorded by the Creative Engine function' using errcode = 'insufficient_privilege';
    end if;
    new.created_at := now();
  else
    if (new.id, new.client_id, new.template_id, new.created_at) is distinct from (old.id, old.client_id, old.template_id, old.created_at) then
      raise exception 'An approval keeps its client and exact template version' using errcode = 'check_violation';
    end if;
    if new.preview_asset_id is distinct from old.preview_asset_id then
      if not v_creative then
        raise exception 'Previews are recorded by the Creative Engine function' using errcode = 'insufficient_privilege';
      end if;
      if old.status = 'approved' then
        raise exception 'This template version is approved for the client; its preview is fixed' using errcode = 'check_violation';
      end if;
      -- A new preview puts a revoked combination back up for review.
      new.status := 'proposed';
      new.approved_by := null; new.approved_at := null;
    elsif new.status is distinct from old.status then
      if not v_human then
        raise exception 'Only a signed-in Compass teammate approves or revokes a template for a client'
          using errcode = 'insufficient_privilege';
      end if;
      case old.status || '>' || new.status
        when 'proposed>approved' then
          select * into t from creative_templates where id = new.template_id;
          select * into a from creative_assets where id = new.preview_asset_id;
          if a.id is null then
            raise exception 'Approve a template only after seeing its preview for this client' using errcode = 'check_violation';
          end if;
          if a.purpose <> 'template_preview' or a.template_id is distinct from new.template_id
             or a.template_spec_hash is distinct from t.spec_hash or a.withdrawn_at is not null then
            raise exception 'The preview is not a current preview of this template version' using errcode = 'check_violation';
          end if;
          if t.status <> 'published' then
            raise exception 'The template version is retired' using errcode = 'check_violation';
          end if;
          new.approved_by := task_actor(); new.approved_at := now();
          new.revoked_by := null; new.revoked_at := null;
        when 'proposed>revoked', 'approved>revoked' then
          new.revoked_by := task_actor(); new.revoked_at := now();
        else
          raise exception 'A template approval cannot go from % to %', old.status, new.status using errcode = 'check_violation';
      end case;
    else
      new.approved_by := old.approved_by; new.approved_at := old.approved_at;
      new.revoked_by := old.revoked_by; new.revoked_at := old.revoked_at;
    end if;
  end if;
  return new;
end $$;
revoke all on function client_creative_templates_guard() from public, anon, authenticated;
create trigger client_creative_templates_guard before insert or update or delete on client_creative_templates
  for each row execute function client_creative_templates_guard();

create function client_creative_templates_history() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_changes jsonb := case when tg_op = 'INSERT' then jsonb_build_object('status', jsonb_build_object('from', null, 'to', new.status))
                     else creative_diff(to_jsonb(old), to_jsonb(new), array['status', 'preview_asset_id']) end;
begin
  if v_changes <> '{}'::jsonb then
    perform creative_governance_log(new.client_id, 'client_template', new.id,
      case when tg_op = 'INSERT' then 'proposed'
           when new.preview_asset_id is distinct from old.preview_asset_id then 'preview_recorded'
           else new.status end,
      v_changes || jsonb_build_object('template_id', new.template_id), new.note);
  end if;
  return null;
end $$;
revoke all on function client_creative_templates_history() from public, anon, authenticated;
create trigger client_creative_templates_history after insert or update on client_creative_templates
  for each row execute function client_creative_templates_history();

-- ── 8. post_assets: creative links ──────────────────────────────────────────
alter table post_assets drop constraint post_assets_pkey;
alter table post_assets
  add column id uuid not null default gen_random_uuid(),
  alter column brand_asset_id drop not null,
  add column creative_asset_id uuid,
  add column role text not null default 'media',
  add column copy_hash text,
  add constraint post_assets_pkey primary key (id),
  add constraint post_assets_post_brand_key unique (post_id, brand_asset_id),
  add constraint post_assets_post_creative_key unique (post_id, creative_asset_id),
  add constraint post_assets_creative_fkey foreign key (creative_asset_id, client_id)
    references creative_assets (id, client_id),
  add constraint post_assets_one_source check (num_nonnulls(brand_asset_id, creative_asset_id) = 1),
  add constraint post_assets_role_known check (role in ('media', 'primary')),
  add constraint post_assets_creative_bound check (
    creative_asset_id is null or (copy_hash ~ '^[0-9a-f]{64}$' and content_hash ~ '^[0-9a-f]{64}$'));
create index post_assets_creative_idx on post_assets (creative_asset_id) where creative_asset_id is not null;
comment on table post_assets is
  'The media a post uses: a brand asset or a creative asset per row, in sort_order. A creative link carries the creative''s content hash and the sha256 of the copy it was made for. Linked only while the post is a draft.';

-- 0045's guard, with creative rows: a creative link has no cascade path (a
-- creative asset is never deleted), so its delete is always checked.
create or replace function post_links_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_post social_posts;
  v_row record := case when tg_op = 'DELETE' then old else new end;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Links are not edited; unlink and link again' using errcode = 'check_violation';
  end if;
  select * into v_post from social_posts where id = v_row.post_id;
  if tg_op = 'DELETE' then
    -- The post itself, or the claim / asset, is being deleted: a cascade.
    if v_post.id is null then return old; end if;
    -- (Separate branches: each table has only its own column.)
    if tg_table_name = 'post_claims' then
      if not exists (select 1 from claims where id = old.claim_id) then return old; end if;
    else
      if old.brand_asset_id is not null and not exists (select 1 from brand_assets where id = old.brand_asset_id) then
        return old;
      end if;
    end if;
  end if;
  if v_post.id is null then
    raise exception 'No such post' using errcode = 'foreign_key_violation';
  end if;
  if v_post.review_status <> 'draft' then
    raise exception 'The post is %; its claims and assets are frozen', v_post.review_status
      using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if new.client_id is null then new.client_id := v_post.client_id; end if;
    return new;
  end if;
  return old;
end $$;
revoke execute on function post_links_guard() from public, anon, authenticated;

-- 0047's guard on drafter posts, with the Creative Engine allowed to link.
create or replace function post_links_drafter_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_post_id uuid := coalesce(new.post_id, old.post_id);
  v_run uuid;
  r drafter_runs;
begin
  select drafter_run_id into v_run from social_posts where id = v_post_id;
  if v_run is null then return coalesce(new, old); end if;  -- not a drafter post (or it is being deleted)
  if tg_op = 'DELETE' then
    -- Cascades from deleting the claim or asset itself.
    -- (Separate branches: each table has only its own column.)
    if tg_table_name = 'post_claims' then
      if not exists (select 1 from claims where id = old.claim_id) then return old; end if;
    else
      if old.brand_asset_id is not null and not exists (select 1 from brand_assets where id = old.brand_asset_id) then
        return old;
      end if;
    end if;
  end if;
  if drafter_caller_is_superuser() or post_caller_is_human() then return coalesce(new, old); end if;
  -- 0054: creative links are the Creative Engine's (checked in post_assets_creative_guard).
  -- (Nested: each table has only its own columns.)
  if tg_table_name = 'post_assets' then
    if coalesce(new.creative_asset_id, old.creative_asset_id) is not null
       and (creative_session_active() or coalesce(current_setting('compass.post_system', true), '') = 'on') then
      return coalesce(new, old);
    end if;
  end if;
  if not drafter_session_active() then
    raise exception 'A drafted post''s claims and assets change only through the post-drafter function or a person'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' and tg_table_name = 'post_claims' then
    select * into r from drafter_runs where id = v_run;
    if r.status <> 'writing' or not (new.claim_id = any (r.claim_ids)) then
      raise exception 'The drafter links only the claims its run chose' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end $$;
revoke all on function post_links_drafter_guard() from public, anon, authenticated;

-- Creative links: only the Creative Engine links one, bound to the asset's
-- bytes and the post's current copy; a teammate, the Engine or the copy-change
-- cleanup (system) unlinks.
create function post_assets_creative_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a creative_assets;
  v_copy text;
begin
  if tg_op = 'UPDATE' then return new; end if;  -- post_links_guard refuses edits
  if coalesce(new.creative_asset_id, old.creative_asset_id) is null then return coalesce(new, old); end if;
  if drafter_caller_is_superuser() then return coalesce(new, old); end if;
  if tg_op = 'DELETE' then
    if not exists (select 1 from social_posts where id = old.post_id) then return old; end if;  -- the post is being deleted
    if not (creative_session_active() or post_caller_is_human()
            or coalesce(current_setting('compass.post_system', true), '') = 'on') then
      raise exception 'Creative is unlinked only by a teammate or the Creative Engine function' using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;
  if not creative_session_active() then
    raise exception 'Creative is linked only by the Creative Engine function' using errcode = 'insufficient_privilege';
  end if;
  select * into a from creative_assets where id = new.creative_asset_id;
  if a.purpose <> 'post' then
    raise exception 'A template preview is not post creative' using errcode = 'check_violation';
  end if;
  if a.withdrawn_at is not null then
    raise exception 'The creative asset was withdrawn' using errcode = 'check_violation';
  end if;
  select copy into v_copy from social_posts where id = new.post_id;
  new.content_hash := a.content_hash;
  new.copy_hash := drafter_copy_hash(v_copy);
  return new;
end $$;
revoke all on function post_assets_creative_guard() from public, anon, authenticated;
create trigger post_assets_creative_guard before insert or update or delete on post_assets
  for each row execute function post_assets_creative_guard();

-- 0045's history, naming creative links as such.
create or replace function post_links_record() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_kind text := post_caller_kind();
  v_row record := case when tg_op = 'DELETE' then old else new end;
  v_ref uuid;
  v_event text;
begin
  if not exists (select 1 from social_posts where id = v_row.post_id) then
    return null;  -- the post is being deleted
  end if;
  if tg_table_name = 'post_claims' then
    v_ref := v_row.claim_id;
    v_event := case when tg_op = 'INSERT' then 'claim_linked' else 'claim_unlinked' end;
  elsif v_row.creative_asset_id is not null then
    v_ref := v_row.creative_asset_id;
    v_event := case when tg_op = 'INSERT' then 'creative_linked' else 'creative_unlinked' end;
  else
    v_ref := v_row.brand_asset_id;
    v_event := case when tg_op = 'INSERT' then 'asset_linked' else 'asset_unlinked' end;
  end if;
  insert into post_events (post_id, client_id, actor_id, actor_kind, kind, to_value)
  values (v_row.post_id, v_row.client_id, case when v_kind = 'team' then task_actor() end, v_kind, v_event, v_ref::text);
  -- A claim or asset deleted under a submitted / approved post.
  if tg_op = 'DELETE' then
    perform recheck_social_posts(array[v_row.post_id]);
  end if;
  return null;
end $$;
revoke execute on function post_links_record() from public, anon, authenticated;

-- ── 9. social_posts: policy, status, version, rejection category ────────────
alter table social_posts
  add column creative_policy text not null default 'none',
  add column creative_status text not null default 'none',
  add column creative_version int not null default 0,
  add column rejection_category text,
  add constraint social_posts_creative_policy_known check (creative_policy in ('none', 'optional', 'required')),
  add constraint social_posts_creative_status_known
    check (creative_status in ('none', 'needed', 'requested', 'rendering', 'ready', 'failed')),
  add constraint social_posts_creative_version_nonnegative check (creative_version >= 0),
  add constraint social_posts_rejection_category_known check (rejection_category in ('copy', 'creative', 'both'));
comment on column social_posts.creative_policy is
  'Fixed at creation from client_creative_settings (none when unset); a teammate may change it on a draft. required: the post is not submitted without its creative.';
comment on column social_posts.creative_status is
  'none | needed | requested (a teammate asked for new creative) | rendering | ready | failed. Moved by the Creative Engine, a teammate''s request, or a copy change.';
comment on column social_posts.creative_version is
  'Counts creative linked to this post; the Creative Engine''s write names the version it expects (compare-and-set).';
comment on column social_posts.rejection_category is
  'What a reviewer rejected: copy, creative or both. Required when the post had creative; copy otherwise.';

create function social_posts_creative_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_human boolean := post_caller_is_human();
  v_creative boolean := creative_session_active();
  v_super boolean := drafter_caller_is_superuser();
  v_system boolean := coalesce(current_setting('compass.post_system', true), '') = 'on';
  v_has boolean;
begin
  if tg_op = 'INSERT' then
    new.creative_policy := creative_policy_for(new.client_id, new.platform::text);
    new.creative_status := case when new.creative_policy = 'required' then 'needed' else 'none' end;
    new.creative_version := 0;
    new.rejection_category := null;
    return new;
  end if;

  if new.creative_policy is distinct from old.creative_policy then
    if not (v_human or v_super) then
      raise exception 'Only a signed-in Compass teammate changes a post''s creative policy' using errcode = 'insufficient_privilege';
    end if;
    if new.review_status <> 'draft' then
      raise exception 'The creative policy changes only while the post is a draft' using errcode = 'check_violation';
    end if;
  end if;

  if new.creative_version is distinct from old.creative_version
     and not (v_super or (v_creative and new.creative_version = old.creative_version + 1)) then
    raise exception 'Only the Creative Engine function advances the creative version' using errcode = 'insufficient_privilege';
  end if;

  if new.creative_status is distinct from old.creative_status and not v_super then
    if new.creative_status in ('rendering', 'ready', 'failed') and not v_creative then
      raise exception 'Only the Creative Engine function records rendering, ready or failed' using errcode = 'insufficient_privilege';
    end if;
    if new.creative_status = 'requested' and not (v_human or v_creative) then
      raise exception 'Only a signed-in Compass teammate requests new creative' using errcode = 'insufficient_privilege';
    end if;
    if new.creative_status in ('none', 'needed') and not (v_human or v_creative or v_system) then
      raise exception 'The worker does not move a post''s creative status' using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Copy that changes under its creative: the creative is unlinked (after
  -- this row is written) and is needed again.
  if new.copy is distinct from old.copy
     and exists (select 1 from post_assets where post_id = new.id and creative_asset_id is not null) then
    new.creative_status := case when new.creative_policy = 'none' then 'none' else 'needed' end;
  elsif new.creative_policy is distinct from old.creative_policy then
    if new.creative_policy = 'required' and new.creative_status = 'none' then new.creative_status := 'needed'; end if;
    if new.creative_policy = 'none' and new.creative_status in ('needed', 'failed') then new.creative_status := 'none'; end if;
  end if;

  if old.review_status = 'in_review' and new.review_status = 'rejected' then
    v_has := exists (select 1 from post_assets where post_id = new.id and creative_asset_id is not null);
    if v_has and new.rejection_category is null then
      raise exception 'Say whether the copy, the creative or both are rejected' using errcode = 'check_violation';
    end if;
    if not v_has then
      if coalesce(new.rejection_category, 'copy') <> 'copy' then
        raise exception 'The post has no creative; only its copy can be rejected' using errcode = 'check_violation';
      end if;
      new.rejection_category := 'copy';
    end if;
  else
    new.rejection_category := old.rejection_category;
  end if;
  return new;
end $$;
revoke all on function social_posts_creative_guard() from public, anon, authenticated;
-- Runs after 0045's social_posts_aa_* and 0047's social_posts_ab_drafter.
create trigger social_posts_ac_creative before insert or update on social_posts
  for each row execute function social_posts_creative_guard();

create function social_posts_creative_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_kind text := post_caller_kind();
  v_actor uuid := case when v_kind = 'team' then task_actor() end;
  v_prev text := current_setting('compass.post_system', true);
begin
  if new.copy is distinct from old.copy then
    perform set_config('compass.post_system', 'on', true);
    delete from post_assets
     where post_id = new.id and creative_asset_id is not null and copy_hash is distinct from drafter_copy_hash(new.copy);
    perform set_config('compass.post_system', coalesce(v_prev, ''), true);
  end if;
  if new.creative_policy is distinct from old.creative_policy then
    insert into post_events (post_id, client_id, actor_id, actor_kind, kind, from_value, to_value)
    values (new.id, new.client_id, v_actor, v_kind, 'creative_policy_changed', old.creative_policy, new.creative_policy);
  end if;
  if new.creative_status is distinct from old.creative_status and new.creative_status in ('requested', 'failed') then
    insert into post_events (post_id, client_id, actor_id, actor_kind, kind, from_value, to_value, detail)
    values (new.id, new.client_id, v_actor, v_kind,
            case new.creative_status when 'requested' then 'creative_requested' else 'creative_failed' end,
            old.creative_status, new.creative_status,
            jsonb_strip_nulls(jsonb_build_object('note', nullif(current_setting('compass.creative_note', true), ''))));
  end if;
  if old.review_status = 'in_review' and new.review_status = 'rejected' then
    insert into post_events (post_id, client_id, actor_id, actor_kind, kind, to_value)
    values (new.id, new.client_id, v_actor, v_kind, 'rejection_classified', new.rejection_category);
  end if;
  return null;
end $$;
revoke all on function social_posts_creative_after() from public, anon, authenticated;
create trigger social_posts_creative_after after update on social_posts
  for each row execute function social_posts_creative_after();

-- ── 10. Approval binding and grounding ──────────────────────────────────────
-- 0045's snapshot plus a 'creative' key only when creative is linked, so every
-- post without creative hashes exactly as before.
create or replace function social_post_snapshot(p social_posts) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'platform', p.platform::text,
    'social_account_id', p.social_account_id,
    'post_type', p.post_type,
    'search_intent', p.search_intent,
    'copy', p.copy,
    'cta_type', p.cta_type,
    'cta_url', p.cta_url,
    'crm_facts_only', p.crm_facts_only,
    'service_id', p.service_id,
    'claims', coalesce((
      select jsonb_agg(jsonb_build_object('id', cl.id, 'claim', cl.claim, 'source', cl.source) order by cl.id)
      from post_claims pc join claims cl on cl.id = pc.claim_id where pc.post_id = p.id), '[]'::jsonb),
    'offer', (
      select jsonb_build_object('id', o.id, 'title', o.title, 'terms', o.terms, 'starts_on', o.starts_on, 'ends_on', o.ends_on)
      from offers o where o.id = p.offer_id),
    'assets', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'storage_path', a.storage_path, 'url', a.url,
                                          'content_hash', pa.content_hash, 'sort_order', pa.sort_order)
                       order by pa.sort_order, a.id)
      from post_assets pa join brand_assets a on a.id = pa.brand_asset_id where pa.post_id = p.id), '[]'::jsonb)
  ) || coalesce((
      select jsonb_build_object('creative', jsonb_agg(jsonb_build_object(
               'id', ca.id, 'content_hash', ca.content_hash, 'storage_path', ca.storage_path,
               'format', ca.format, 'mime_type', ca.mime_type, 'width', ca.width, 'height', ca.height,
               'size_bytes', ca.size_bytes, 'strategy', ca.strategy, 'template_id', ca.template_id,
               'template_spec_hash', ca.template_spec_hash, 'alt_text', ca.alt_text, 'overlay', ca.overlay,
               'copy_hash', pa.copy_hash, 'role', pa.role, 'sort_order', pa.sort_order)
             order by pa.sort_order, ca.id))
      from post_assets pa join creative_assets ca on ca.id = pa.creative_asset_id
      where pa.post_id = p.id
      having count(*) > 0), '{}'::jsonb)
$$;
revoke execute on function social_post_snapshot(social_posts) from public, anon, authenticated;

-- 0045's grounding plus the creative checks (nothing new for a post with no
-- creative and policy none).
create or replace function social_post_grounding_problems(p social_posts) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare
  v_problems text[] := '{}';
  v_usable int := 0;
  v_linked int := 0;
  c record;
  o record;
  v_service_status text;
  v_today date := (now() at time zone 'America/Chicago')::date;
  cr record;
  s record;
begin
  if nullif(btrim(coalesce(p.copy, '')), '') is null then
    v_problems := v_problems || 'The post has no copy.'::text;
  end if;

  for c in
    select cl.claim, cl.status::text as status, cl.source
    from post_claims pc join claims cl on cl.id = pc.claim_id
    where pc.post_id = p.id
  loop
    v_linked := v_linked + 1;
    if c.status = 'confirmed' or (c.status = 'sourced' and nullif(btrim(coalesce(c.source, '')), '') is not null) then
      v_usable := v_usable + 1;
    elsif c.status = 'sourced' then
      v_problems := v_problems || format('Claim "%s" is marked sourced but has no source.', left(c.claim, 80));
    else
      v_problems := v_problems || format('Claim "%s" is unverified; unlink it or verify it.', left(c.claim, 80));
    end if;
  end loop;

  if p.search_intent <> 'navigational' and v_usable = 0 then
    v_problems := v_problems || format('%s %s post needs at least one confirmed or sourced claim.', case when p.search_intent = 'informational' then 'An' else 'A' end, p.search_intent);
  end if;
  if p.search_intent = 'navigational' and v_linked = 0 and not p.crm_facts_only then
    v_problems := v_problems ||
      'A navigational post with no claims must be marked "CRM facts only" (name, phone, website, approved services, service area); otherwise link a claim.'::text;
  end if;

  -- Topic: a standard informational / commercial / transactional post is
  -- about an approved service; a navigational post may be brand-level; an
  -- offer post is about its offer (the service may be null when the offer
  -- is business-wide). keyword_id is always optional.
  if p.post_type = 'standard' and p.search_intent <> 'navigational' and p.service_id is null then
    v_problems := v_problems || format('%s %s post needs an approved service as its topic.', case when p.search_intent = 'informational' then 'An' else 'A' end, p.search_intent);
  end if;
  if p.post_type = 'offer' and p.offer_id is null then
    v_problems := v_problems || 'An offer post needs one of the client''s offers.'::text;
  end if;

  if p.offer_id is not null then
    select status, ends_on into o from offers where id = p.offer_id;
    if o.status is distinct from 'confirmed' then
      v_problems := v_problems || 'The offer is not confirmed.'::text;
    end if;
    if o.ends_on is not null and o.ends_on < v_today then
      v_problems := v_problems || format('The offer ended on %s.', o.ends_on);
    end if;
  end if;

  if p.service_id is not null then
    select status::text into v_service_status from services where id = p.service_id;
    if v_service_status is distinct from 'approved' then
      v_problems := v_problems || format('The service is %s, not approved.', coalesce(v_service_status, 'missing'));
    end if;
  end if;

  -- 0054: creative.
  if p.creative_policy = 'required'
     and not exists (select 1 from post_assets pa where pa.post_id = p.id and pa.creative_asset_id is not null) then
    v_problems := v_problems || 'The post needs its creative before review.'::text;
  end if;
  for cr in
    select ca.id, ca.withdrawn_at, pa.copy_hash
    from post_assets pa join creative_assets ca on ca.id = pa.creative_asset_id where pa.post_id = p.id
  loop
    if cr.withdrawn_at is not null then
      v_problems := v_problems || 'The linked creative was withdrawn; request new creative.'::text;
    end if;
    if cr.copy_hash is distinct from drafter_copy_hash(p.copy) then
      v_problems := v_problems || 'The creative was made for different copy; request new creative.'::text;
    end if;
  end loop;
  for s in
    select src.brand_asset_id, src.source_content_hash, ba.id as current_id, ba.creative_use, ba.content_hash,
           ba.depicts_own_work, src.role
    from post_assets pa
    join creative_asset_sources src on src.creative_asset_id = pa.creative_asset_id
    left join brand_assets ba on ba.id = src.brand_asset_id
    where pa.post_id = p.id
  loop
    if s.current_id is null then
      v_problems := v_problems || 'A source image of the creative was deleted.'::text;
    elsif s.creative_use <> 'approved' then
      v_problems := v_problems || format('A source image of the creative is %s for creative use.', s.creative_use);
    elsif s.content_hash is distinct from s.source_content_hash then
      v_problems := v_problems || 'A source image of the creative changed since the creative was made.'::text;
    elsif s.role = 'photo' and s.depicts_own_work is not true then
      v_problems := v_problems || 'A source photo of the creative is no longer marked as the client''s own work.'::text;
    end if;
  end loop;

  return v_problems;
end $$;
revoke execute on function social_post_grounding_problems(social_posts) from public, anon, authenticated;

-- Governance changes that a post's creative stood on send it back to review.
create function creative_support_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_ids uuid[];
begin
  if tg_table_name = 'brand_assets' then
    select array_agg(distinct pa.post_id) into v_ids
      from creative_asset_sources src join post_assets pa on pa.creative_asset_id = src.creative_asset_id
     where src.brand_asset_id = new.id;
  else
    select array_agg(post_id) into v_ids from post_assets where creative_asset_id = new.id;
  end if;
  if v_ids is not null then
    perform recheck_social_posts(v_ids);
  end if;
  return null;
end $$;
revoke all on function creative_support_changed() from public, anon, authenticated;
create trigger brand_assets_zz_recheck_creative after update of creative_use, content_hash, depicts_own_work on brand_assets
  for each row execute function creative_support_changed();
create trigger creative_assets_zz_recheck_posts after update of withdrawn_at on creative_assets
  for each row execute function creative_support_changed();

-- ── 11. Overlay text: governed strings only ─────────────────────────────────
-- Each line: {role, text, source_id?}. text must EQUAL its governed source.
create function creative_overlay_problems(p_client uuid, p_post_id uuid, p_overlay jsonb) returns text[]
language plpgsql stable security invoker set search_path = public as $$
declare
  v_problems text[] := '{}';
  v_line jsonb;
  v_role text;
  v_text text;
  v_expected text;
  v_src uuid;
  v_i int := 0;
  p social_posts;
begin
  if jsonb_typeof(coalesce(p_overlay, '[]')) <> 'array' then
    return array['The overlay is a list of lines.'];
  end if;
  if jsonb_array_length(coalesce(p_overlay, '[]')) > 3 then
    v_problems := v_problems || 'At most three overlay lines.'::text;
  end if;
  if p_post_id is not null then
    select * into p from social_posts where id = p_post_id and client_id = p_client;
  end if;
  for v_line in select * from jsonb_array_elements(coalesce(p_overlay, '[]')) loop
    v_i := v_i + 1;
    v_role := v_line->>'role';
    v_text := v_line->>'text';
    v_src := nullif(v_line->>'source_id', '')::uuid;
    v_expected := null;
    if nullif(btrim(coalesce(v_text, '')), '') is null then
      v_problems := v_problems || format('Overlay line %s is empty.', v_i);
      continue;
    end if;
    case v_role
      when 'business_name' then
        select name into v_expected from clients where id = p_client;
      when 'service_name' then
        select name into v_expected from services
         where client_id = p_client and status = 'approved'
           and id = coalesce(case when p_post_id is not null then p.service_id end, v_src);
      when 'tagline' then
        select tagline into v_expected from client_brands where client_id = p_client;
      when 'standing_cta' then
        select standing_cta into v_expected from brand_boards where client_id = p_client order by version desc limit 1;
      when 'claim' then
        if p_post_id is not null then
          select cl.claim into v_expected from claims cl join post_claims pc on pc.claim_id = cl.id
           where pc.post_id = p_post_id and cl.id = v_src
             and (cl.status::text = 'confirmed' or (cl.status::text = 'sourced' and nullif(btrim(coalesce(cl.source, '')), '') is not null));
        end if;
      when 'offer_title' then
        if p_post_id is not null then
          select o.title into v_expected from offers o
           where o.id = p.offer_id and o.status = 'confirmed'
             and (o.ends_on is null or o.ends_on >= (now() at time zone 'America/Chicago')::date);
        end if;
      else
        v_problems := v_problems || format('Overlay line %s has an unknown role "%s".', v_i, coalesce(v_role, ''));
        continue;
    end case;
    if v_expected is null then
      v_problems := v_problems || format('Overlay line %s (%s) has no governed source for this post.', v_i, v_role);
    elsif v_text <> v_expected then
      v_problems := v_problems || format('Overlay line %s must be exactly the governed %s.', v_i, v_role);
    end if;
    if v_i = 1 and cardinality(regexp_split_to_array(btrim(v_text), '\s+')) > 8 then
      v_problems := v_problems || 'The primary overlay line is at most 8 words.'::text;
    end if;
  end loop;
  return v_problems;
end $$;
revoke all on function creative_overlay_problems(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function creative_overlay_problems(uuid, uuid, jsonb) to service_role;

-- ── 12. The Creative Engine's governed writes (service session) ─────────────
-- Register a template version (idempotent on key + version + spec).
-- p: {key, version, channel, name, description?, output_width, output_height, mime_type, spec}
create function creative_register_template(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  t creative_templates;
begin
  if not drafter_caller_is_service() then
    raise exception 'creative_register_template runs only in the Creative Engine function' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.creative_write', 'on', true);
  select * into t from creative_templates where key = p->>'key' and version = (p->>'version')::int for update;
  if t.id is not null then
    if t.spec_hash <> creative_spec_hash(p->'spec') or t.channel::text <> p->>'channel'
       or t.output_width <> (p->>'output_width')::int or t.output_height <> (p->>'output_height')::int
       or t.mime_type <> p->>'mime_type' then
      raise exception 'Template % v% is registered with a different definition; register a new version', p->>'key', p->>'version'
        using errcode = 'unique_violation';
    end if;
    return jsonb_build_object('template_id', t.id, 'spec_hash', t.spec_hash, 'registered', false);
  end if;
  insert into creative_templates (key, version, channel, name, description, output_width, output_height, mime_type, spec, spec_hash)
  values (p->>'key', (p->>'version')::int, (p->>'channel')::social_platform, p->>'name', p->>'description',
          (p->>'output_width')::int, (p->>'output_height')::int, p->>'mime_type', p->'spec', creative_spec_hash(p->'spec'))
  returning * into t;
  return jsonb_build_object('template_id', t.id, 'spec_hash', t.spec_hash, 'registered', true);
end $$;
revoke all on function creative_register_template(jsonb) from public, anon, authenticated;
grant execute on function creative_register_template(jsonb) to service_role;

-- Open a render (or return the run for the same inputs).
-- p: {client_id, purpose, post_id?, template_id, strategy, reason, requested_via, requested_by?,
--     copy_hash?, brief, brief_hash, renderer}
create function creative_begin_run(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_client uuid := (p->>'client_id')::uuid;
  v_purpose text := coalesce(p->>'purpose', 'post');
  v_post uuid := nullif(p->>'post_id', '')::uuid;
  v_template uuid := (p->>'template_id')::uuid;
  v_strategy text := p->>'strategy';
  t creative_templates;
  sp social_posts;
  r creative_runs;
  v_generated text;
begin
  if not drafter_caller_is_service() then
    raise exception 'creative_begin_run runs only in the Creative Engine function' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.creative_write', 'on', true);

  select * into t from creative_templates where id = v_template;
  if t.id is null then
    raise exception 'No such template' using errcode = 'check_violation';
  end if;
  if coalesce(p->>'brief_hash', '') <> creative_spec_hash(p->'brief') then
    raise exception 'brief_hash is not the hash of the brief' using errcode = 'check_violation';
  end if;

  if v_purpose = 'post' then
    select * into sp from social_posts where id = v_post and client_id = v_client for update;
    if sp.id is null then
      raise exception 'No such post for this client' using errcode = 'check_violation';
    end if;
    -- The same inputs are the same run.
    select * into r from creative_runs
     where post_id = v_post and brief_hash = p->>'brief_hash' and template_spec_hash = t.spec_hash
       and purpose = 'post' and status <> 'failed';
    if r.id is not null then
      return jsonb_build_object('run_id', r.id, 'status', r.status, 'reused', true, 'creative_asset_id', r.creative_asset_id);
    end if;
    if sp.review_status <> 'draft' then
      raise exception 'The post is %; request new creative first', sp.review_status using errcode = 'check_violation';
    end if;
    if sp.creative_policy = 'none' then
      raise exception 'The post''s creative policy is none' using errcode = 'check_violation';
    end if;
    if coalesce(p->>'copy_hash', '') <> drafter_copy_hash(sp.copy) then
      raise exception 'stale_copy: The post''s copy changed since the brief was built' using errcode = 'check_violation';
    end if;
    if t.channel <> sp.platform then
      raise exception 'The template is for another channel' using errcode = 'check_violation';
    end if;
  else
    select * into r from creative_runs
     where client_id = v_client and template_id = v_template and brief_hash = p->>'brief_hash'
       and purpose = 'template_preview' and status <> 'failed';
    if r.id is not null then
      return jsonb_build_object('run_id', r.id, 'status', r.status, 'reused', true, 'creative_asset_id', r.creative_asset_id);
    end if;
  end if;

  if t.status <> 'published' then
    raise exception 'The template version is retired' using errcode = 'check_violation';
  end if;
  if v_purpose = 'post' and not exists (select 1 from client_creative_templates
                                         where client_id = v_client and template_id = v_template and status = 'approved') then
    raise exception 'The template version is not approved for this client' using errcode = 'check_violation';
  end if;
  if v_strategy = 'generated_layer' then
    select generated_imagery into v_generated from client_creative_settings
     where client_id = v_client and channel = t.channel;
    if coalesce(v_generated, 'off') <> 'non_representational' then
      raise exception 'Generated imagery is off for this client and channel' using errcode = 'check_violation';
    end if;
  end if;

  insert into creative_runs (client_id, post_id, purpose, reason, strategy, template_id, template_spec_hash,
                             requested_via, requested_by, copy_hash, brief, brief_hash, renderer)
  values (v_client, v_post, v_purpose, coalesce(p->>'reason', case when v_purpose = 'post' then 'initial' else 'preview' end),
          v_strategy, v_template, t.spec_hash, coalesce(p->>'requested_via', 'worker'), nullif(p->>'requested_by', '')::uuid,
          case when v_purpose = 'post' then p->>'copy_hash' end, p->'brief', p->>'brief_hash', p->>'renderer')
  returning * into r;
  if v_purpose = 'post' then
    update social_posts set creative_status = 'rendering' where id = v_post;
  end if;
  return jsonb_build_object('run_id', r.id, 'status', r.status, 'reused', false);
end $$;
revoke all on function creative_begin_run(jsonb) from public, anon, authenticated;
grant execute on function creative_begin_run(jsonb) to service_role;

-- A render that failed. p: {run_id, error}
create function creative_fail_run(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  r creative_runs;
begin
  if not drafter_caller_is_service() then
    raise exception 'creative_fail_run runs only in the Creative Engine function' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.creative_write', 'on', true);
  select * into r from creative_runs where id = (p->>'run_id')::uuid for update;
  if r.id is null or r.status <> 'rendering' then
    raise exception 'The run is not rendering' using errcode = 'check_violation';
  end if;
  update creative_runs set status = 'failed', error = coalesce(nullif(btrim(p->>'error'), ''), 'failed') where id = r.id;
  if r.post_id is not null then
    update social_posts set creative_status = 'failed' where id = r.post_id and creative_status = 'rendering';
  end if;
  return jsonb_build_object('run_id', r.id, 'status', 'failed');
end $$;
revoke all on function creative_fail_run(jsonb) from public, anon, authenticated;
grant execute on function creative_fail_run(jsonb) to service_role;

-- Record a rendered (or manually uploaded) creative and link it.
-- Rendered: {run_id, expected_creative_version (post), asset: {content_hash, format, width, height,
--            size_bytes, alt_text?, overlay, generation?}, sources: [{brand_asset_id, role,
--            source_content_hash, crop?, focal?}], submit?}
-- Manual:   {mode: 'manual', client_id, post_id, uploaded_by, expected_creative_version,
--            asset: {content_hash, format, width, height, size_bytes, alt_text}, provenance: {uploaded_via, ...}}
-- The file must already be in the creative-assets bucket at its content address.
create function creative_write(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_manual boolean := coalesce(p->>'mode', '') = 'manual';
  r creative_runs;
  t creative_templates;
  sp social_posts;
  a creative_assets;
  v_client uuid;
  v_post uuid;
  v_hash text := p->'asset'->>'content_hash';
  v_format text := p->'asset'->>'format';
  v_path text;
  v_obj record;
  v_problems text[];
  v_src jsonb;
  b brand_assets;
  v_i int := 0;
  v_new boolean;
  v_photo_sources int := 0;
  v_link_count int;
  v_task uuid;
begin
  if not drafter_caller_is_service() then
    raise exception 'creative_write runs only in the Creative Engine function' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.creative_write', 'on', true);

  if v_manual then
    v_client := (p->>'client_id')::uuid;
    v_post := (p->>'post_id')::uuid;
    if not exists (select 1 from team_members where id = nullif(p->>'uploaded_by', '')::uuid) then
      raise exception 'A manual creative names the teammate who uploaded it' using errcode = 'check_violation';
    end if;
  else
    select * into r from creative_runs where id = (p->>'run_id')::uuid for update;
    if r.id is null or r.status <> 'rendering' then
      raise exception 'The run is not rendering' using errcode = 'check_violation';
    end if;
    v_client := r.client_id;
    v_post := r.post_id;
    select * into t from creative_templates where id = r.template_id;
    if t.spec_hash <> r.template_spec_hash then
      raise exception 'The template changed under the run' using errcode = 'check_violation';
    end if;
    if (p->'asset'->>'width')::int <> t.output_width or (p->'asset'->>'height')::int <> t.output_height
       or 'image/' || v_format <> t.mime_type then
      raise exception 'The render is not the template''s output size and type' using errcode = 'check_violation';
    end if;
    if r.purpose = 'post' and r.post_id is null then
      raise exception 'The run''s post was deleted' using errcode = 'check_violation';
    end if;
  end if;

  if v_post is not null then
    select * into sp from social_posts where id = v_post and client_id = v_client for update;
    if sp.id is null then
      raise exception 'No such post for this client' using errcode = 'check_violation';
    end if;
    if sp.review_status <> 'draft' then
      raise exception 'The post is %; creative is linked only to a draft', sp.review_status using errcode = 'check_violation';
    end if;
    if sp.creative_version is distinct from (p->>'expected_creative_version')::int then
      raise exception 'creative_version_conflict: The post''s creative changed (version %)', sp.creative_version
        using errcode = 'check_violation';
    end if;
    if not v_manual and r.copy_hash is distinct from drafter_copy_hash(sp.copy) then
      raise exception 'stale_copy: The post''s copy changed since the run began' using errcode = 'check_violation';
    end if;
    if not v_manual and not exists (select 1 from client_creative_templates
                                     where client_id = v_client and template_id = r.template_id and status = 'approved') then
      raise exception 'The template version is no longer approved for this client' using errcode = 'check_violation';
    end if;
  end if;

  -- The file, at its content address.
  if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' or v_format not in ('png', 'jpeg', 'webp') then
    raise exception 'The asset needs a sha256 content hash and a png / jpeg / webp format' using errcode = 'check_violation';
  end if;
  v_path := v_client::text || '/' || v_hash || '.' || case v_format when 'jpeg' then 'jpg' else v_format end;
  select * into v_obj from storage.objects where bucket_id = 'creative-assets' and name = v_path;
  if not found then
    raise exception 'The file is not in the creative-assets bucket at %', v_path using errcode = 'check_violation';
  end if;
  if (v_obj.metadata->>'size') is not null and (v_obj.metadata->>'size')::bigint <> (p->'asset'->>'size_bytes')::bigint then
    raise exception 'The stored file''s size differs from the asset''s' using errcode = 'check_violation';
  end if;
  if (v_obj.metadata->>'mimetype') is not null and v_obj.metadata->>'mimetype' <> 'image/' || v_format then
    raise exception 'The stored file''s type differs from the asset''s' using errcode = 'check_violation';
  end if;

  -- Overlay text: governed strings only.
  v_problems := creative_overlay_problems(v_client, v_post, coalesce(p->'asset'->'overlay', '[]'));
  if v_manual and jsonb_array_length(coalesce(p->'asset'->'overlay', '[]')) > 0 then
    v_problems := v_problems || 'A manual upload records no overlay; its text is reviewed on the image.'::text;
  end if;
  if cardinality(v_problems) > 0 then
    raise exception 'overlay_ungoverned: %', array_to_string(v_problems, ' ') using errcode = 'check_violation';
  end if;
  if not v_manual and r.strategy = 'generated_layer'
     and coalesce((p->'asset'->'generation'->>'non_representational')::boolean, false) is not true then
    raise exception 'A generated layer must be declared non-representational' using errcode = 'check_violation';
  end if;

  -- The asset (the same bytes are the same asset).
  select * into a from creative_assets where client_id = v_client and content_hash = v_hash;
  v_new := a.id is null;
  if not v_new then
    if a.format <> v_format or a.width <> (p->'asset'->>'width')::int or a.height <> (p->'asset'->>'height')::int
       or a.size_bytes <> (p->'asset'->>'size_bytes')::bigint then
      raise exception 'These bytes are recorded with a different format or size' using errcode = 'check_violation';
    end if;
    if a.withdrawn_at is not null then
      raise exception 'These bytes were withdrawn; render something else' using errcode = 'check_violation';
    end if;
    if a.purpose <> (case when v_post is null then 'template_preview' else 'post' end) then
      raise exception 'These bytes are recorded for another purpose' using errcode = 'check_violation';
    end if;
  else
    insert into creative_assets (client_id, content_hash, storage_path, format, mime_type, width, height, size_bytes,
                                 strategy, purpose, template_id, template_spec_hash, run_id, overlay, alt_text,
                                 generation, uploaded_by, provenance)
    values (v_client, v_hash, v_path, v_format, 'image/' || v_format, (p->'asset'->>'width')::int,
            (p->'asset'->>'height')::int, (p->'asset'->>'size_bytes')::bigint,
            case when v_manual then 'manual' else r.strategy end,
            case when v_post is null then 'template_preview' else 'post' end,
            t.id, t.spec_hash, r.id, coalesce(p->'asset'->'overlay', '[]'), nullif(btrim(p->'asset'->>'alt_text'), ''),
            coalesce(p->'asset'->'generation', '{}'),
            case when v_manual then (p->>'uploaded_by')::uuid end,
            case when v_manual then coalesce(p->'provenance', '{}') else '{}'::jsonb end)
    returning * into a;

    -- Sources: approved, unchanged, own-work photos; logos of the client.
    for v_src in select * from jsonb_array_elements(coalesce(p->'sources', '[]')) loop
      v_i := v_i + 1;
      select * into b from brand_assets where id = (v_src->>'brand_asset_id')::uuid and client_id = v_client for share;
      if b.id is null then
        raise exception 'Source % is not one of this client''s assets', v_i using errcode = 'check_violation';
      end if;
      if b.creative_use <> 'approved' then
        raise exception 'Source % is % for creative use', v_i, b.creative_use using errcode = 'check_violation';
      end if;
      if b.content_hash is distinct from v_src->>'source_content_hash' then
        raise exception 'Source % is not the reviewed file', v_i using errcode = 'check_violation';
      end if;
      if v_src->>'role' = 'photo' then
        if b.kind::text <> 'photo' or b.depicts_own_work is not true then
          raise exception 'Source % is not a photo of the client''s own work', v_i using errcode = 'check_violation';
        end if;
        v_photo_sources := v_photo_sources + 1;
      elsif v_src->>'role' = 'logo' then
        if b.kind::text not like 'logo%' then
          raise exception 'Source % is not a logo', v_i using errcode = 'check_violation';
        end if;
      else
        raise exception 'Source % has an unknown role', v_i using errcode = 'check_violation';
      end if;
      insert into creative_asset_sources (creative_asset_id, client_id, ordinal, role, brand_asset_id, source_content_hash,
                                          source_storage_path, source_width, source_height, governance, crop, focal)
      values (a.id, v_client, v_i, v_src->>'role', b.id, b.content_hash, b.storage_path, b.width, b.height,
              jsonb_build_object('creative_use', b.creative_use, 'depicts_own_work', b.depicts_own_work,
                                 'subjects', to_jsonb(b.subjects), 'focal_x', b.focal_x, 'focal_y', b.focal_y,
                                 'reviewed_by', b.creative_reviewed_by, 'reviewed_at', b.creative_reviewed_at),
              v_src->'crop', coalesce(v_src->'focal', case when b.focal_x is not null
                                        then jsonb_build_object('x', b.focal_x, 'y', b.focal_y) end));
    end loop;
    if not v_manual and r.strategy = 'source_photo' and v_photo_sources = 0 then
      raise exception 'A source-photo creative names its approved photo' using errcode = 'check_violation';
    end if;
    if not v_manual and r.strategy = 'brand_graphic' and v_photo_sources > 0 then
      raise exception 'A brand graphic uses no photo' using errcode = 'check_violation';
    end if;
  end if;

  if not v_manual then
    update creative_runs set status = 'succeeded', creative_asset_id = a.id where id = r.id;
  end if;

  if v_post is null then
    -- A template preview for this client: (re)propose the combination.
    insert into client_creative_templates (client_id, template_id, preview_asset_id)
    values (v_client, t.id, a.id)
    on conflict (client_id, template_id) do update set preview_asset_id = excluded.preview_asset_id;
    return jsonb_build_object('creative_asset_id', a.id, 'storage_path', a.storage_path, 'new', v_new, 'preview', true);
  end if;

  -- The post: the new creative replaces the old one.
  delete from post_assets where post_id = v_post and creative_asset_id is not null;
  select count(*) into v_link_count from post_assets where post_id = v_post;
  if sp.platform::text = 'google_business' and v_link_count > 0 then
    raise exception 'Business Profile posts take one image; unlink the photo first' using errcode = 'check_violation';
  end if;
  insert into post_assets (post_id, client_id, creative_asset_id, sort_order, role)
  values (v_post, v_client, a.id, 1, 'primary');
  update social_posts set creative_version = creative_version + 1, creative_status = 'ready' where id = v_post;
  if coalesce((p->>'submit')::boolean, false) and not v_manual then
    update social_posts set review_status = 'in_review' where id = v_post returning review_task_id into v_task;
  end if;
  return jsonb_build_object('creative_asset_id', a.id, 'storage_path', a.storage_path, 'new', v_new,
                            'post_id', v_post, 'creative_version', sp.creative_version + 1, 'review_task_id', v_task);
end $$;
revoke all on function creative_write(jsonb) from public, anon, authenticated;
grant execute on function creative_write(jsonb) to service_role;

-- ── 13. A teammate's "Request new creative" ─────────────────────────────────
-- Keeps the copy, creates no Drafter run: the post returns to draft (withdrawn,
-- revised after a creative rejection, or reopened), its creative is unlinked
-- and creative_status is 'requested' for the Creative Engine.
create function request_new_creative(p_post_id uuid, p_note text) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  sp social_posts;
begin
  if not creative_caller_is_teammate() then
    raise exception 'Only a signed-in Compass teammate requests new creative' using errcode = 'insufficient_privilege';
  end if;
  select * into sp from social_posts where id = p_post_id for update;
  if sp.id is null then
    raise exception 'No such post' using errcode = 'check_violation';
  end if;
  if sp.publish_status in ('publishing', 'published') then
    raise exception 'The post is %; its creative stays as it is', sp.publish_status using errcode = 'check_violation';
  end if;
  if sp.review_status = 'rejected' and sp.rejection_category is distinct from 'creative' then
    raise exception 'The copy was rejected; that needs a new draft, not new creative' using errcode = 'check_violation';
  end if;
  if sp.creative_policy = 'none' then
    raise exception 'The post''s creative policy is none; set it first' using errcode = 'check_violation';
  end if;
  perform set_config('compass.creative_note', coalesce(btrim(p_note), ''), true);
  if sp.review_status in ('in_review', 'rejected', 'approved') then
    update social_posts set review_status = 'draft' where id = p_post_id;
  end if;
  delete from post_assets where post_id = p_post_id and creative_asset_id is not null;
  update social_posts set creative_status = 'requested' where id = p_post_id;
  perform set_config('compass.creative_note', '', true);
  return jsonb_build_object('post_id', p_post_id, 'creative_status', 'requested', 'from', sp.review_status);
end $$;
revoke all on function request_new_creative(uuid, text) from public, anon;
grant execute on function request_new_creative(uuid, text) to authenticated;

-- ── 14. drafter_write: a post whose channel requires creative waits for it ──
create or replace function drafter_write(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_client uuid := (p->>'client_id')::uuid;
  v_brief jsonb := p->'brief';
  v_target jsonb := v_brief->'target';
  v_copy text := p->>'copy';
  v_claims uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'claim_ids', '[]')) x), '{}');
  v_assets uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'asset_ids', '[]')) x), '{}');
  v_allowed uuid[];
  v_service uuid := nullif(v_target->'service'->>'id', '')::uuid;
  v_page text;
  v_cta_type text := nullif(v_target->'cta'->>'type', '');
  v_cta_url text := nullif(v_target->'cta'->>'url', '');
  v_run uuid;
  v_post uuid;
  v_task uuid;
  i int;
  -- 0053: an Authority hand-off
  v_opp uuid := nullif(p->>'authority_opportunity_id', '')::uuid;
  o authority_opportunities;
  v_req tasks;
  v_latest uuid;
  v_site text;
  v_pref uuid[];
  v_evidence uuid[];
  -- 0054
  v_policy text;
begin
  if not drafter_caller_is_service() then
    raise exception 'drafter_write runs only in the post-drafter function' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.drafter_write', 'on', true);

  if v_client is null or v_brief is null or v_target is null or nullif(btrim(coalesce(v_copy, '')), '') is null then
    raise exception 'drafter_write needs client_id, brief, target and copy' using errcode = 'check_violation';
  end if;
  if (v_brief->'client'->>'id')::uuid is distinct from v_client then
    raise exception 'The brief is for another client' using errcode = 'check_violation';
  end if;
  if coalesce((p->'lint'->>'ok')::boolean, false) is not true then
    raise exception 'Only a draft that passed the linter is written' using errcode = 'check_violation';
  end if;
  if coalesce(v_target->>'channel', '') <> 'google_business' then
    raise exception 'The drafter writes Business Profile posts only in v1' using errcode = 'check_violation';
  end if;
  -- Claims: only ones the brief allowed.
  select coalesce(array_agg((c->>'id')::uuid), '{}') into v_allowed
    from jsonb_array_elements(coalesce(v_brief->'allowed_facts'->'claims', '[]')) c;
  if not (v_claims <@ v_allowed) then
    raise exception 'A linked claim is not in the brief' using errcode = 'check_violation';
  end if;
  if cardinality(v_assets) > 1 then
    raise exception 'Business Profile posts take one photo in v1' using errcode = 'check_violation';
  end if;
  -- The button goes to the service's own page.
  if v_service is not null then
    select page_url into v_page from services where id = v_service and client_id = v_client and status = 'approved';
    if v_page is null then
      raise exception 'The target service is not an approved service of this client with a page' using errcode = 'check_violation';
    end if;
    if v_cta_type is not null and v_cta_type <> 'CALL'
       and rtrim(lower(v_cta_url), '/') is distinct from rtrim(lower(v_page), '/') then
      raise exception 'The button must link to the service page' using errcode = 'check_violation';
    end if;
  end if;
  -- 0053: a draft for an Authority opportunity. Authority only narrows: every
  -- check above still applies, and each of these refuses (AU409, nothing
  -- written) when the opportunity and the Drafter's own target disagree, when
  -- the recommendation is no longer current, or when no teammate asked.
  if v_opp is not null then
    select * into o from authority_opportunities where id = v_opp for update;
    if o.id is null or o.client_id is distinct from v_client then
      raise exception 'authority_conflict opportunity_not_found: No such Authority opportunity for this client' using errcode = 'AU409';
    end if;
    select r.id, r.inventory->>'site' into v_latest, v_site from authority_runs r
     where r.client_id = v_client and r.status = 'completed' order by r.finished_at desc, r.id limit 1;
    if not o.present or o.last_seen_run_id is distinct from v_latest then
      raise exception 'authority_conflict opportunity_not_current: The latest analysis no longer reports this opportunity' using errcode = 'AU409';
    end if;
    if nullif(p->>'authority_run_id', '') is not null and (p->>'authority_run_id')::uuid is distinct from o.last_seen_run_id then
      raise exception 'authority_conflict authority_stale: Requested against analysis run %, the current one is %', p->>'authority_run_id', o.last_seen_run_id using errcode = 'AU409';
    end if;
    if o.status = 'dismissed' then
      raise exception 'authority_conflict dismissed: The opportunity is dismissed' using errcode = 'AU409';
    end if;
    if o.content_type is distinct from 'gbp_post' or o.section <> 'ready' or o.action <> 'create' then
      raise exception 'authority_conflict not_ready: The analysis does not mark this post ready to create' using errcode = 'AU409';
    end if;
    if o.eligible_from is not null and o.eligible_from > (now() at time zone 'America/Chicago')::date then
      raise exception 'authority_conflict cadence_active: Not eligible until %', o.eligible_from using errcode = 'AU409';
    end if;
    if o.key is distinct from format('gbp_post:%s:%s', v_service, v_target->>'search_intent')
       or o.service_id is distinct from v_service or o.intent is distinct from v_target->>'search_intent'
       or o.keyword_id is distinct from nullif(v_target->'keyword'->>'id', '')::uuid
       or coalesce(v_target->>'post_type', '') <> 'standard' or nullif(v_target->'offer'->>'id', '') is not null
       or (o.opportunity->'target'->>'cta') is distinct from v_cta_type
       or o.target_path is distinct from authority_norm_path(v_page, v_site) then
      raise exception 'authority_conflict target_mismatch: The Drafter''s target differs from the Authority opportunity' using errcode = 'AU409';
    end if;
    if (v_brief->'authority'->>'opportunity_id') is distinct from v_opp::text then
      raise exception 'authority_conflict brief_mismatch: The brief was not built for this Authority opportunity' using errcode = 'AU409';
    end if;
    select coalesce(array_agg(x::uuid), '{}') into v_pref from jsonb_array_elements_text(coalesce(v_brief->'authority'->'preferred_claim_ids', '[]')) x;
    select coalesce(array_agg(x::uuid), '{}') into v_evidence from jsonb_array_elements_text(coalesce(o.opportunity->'evidence_claim_ids', '[]')) x;
    if not (v_pref <@ v_evidence and v_evidence <@ v_pref) or not (v_pref <@ v_allowed) then
      raise exception 'authority_conflict evidence_ineligible: Authority''s preferred evidence is not the analysis''s, or not a claim the brief allows' using errcode = 'AU409';
    end if;
    if exists (select 1 from authority_opportunity_links l
                where l.opportunity_id = o.id and l.kind = 'social_post'
                  and l.created_at >= coalesce(o.cycle_started_at, '-infinity'::timestamptz)
                  and authority_link_state(l) in ('active', 'done')) then
      raise exception 'authority_conflict already_in_progress: A draft for this opportunity is already in review or approved' using errcode = 'AU409';
    end if;
    select * into v_req from tasks
     where client_id = v_client and key = 'authority_draft:' || o.id and status in ('open', 'in_progress') for update;
    if v_req.id is null
       or not exists (select 1 from authority_opportunity_events e
                       where e.opportunity_id = o.id and e.kind = 'decision' and e.actor_kind = 'team'
                         and e.detail->>'action' = 'request_draft' and e.detail->>'task_id' = v_req.id::text) then
      raise exception 'authority_conflict not_requested: No open Draft with AI request from a teammate for this opportunity' using errcode = 'AU409';
    end if;
    -- Cadence, live (the analysis may be older than the last post).
    if exists (select 1 from social_posts sp
                where sp.client_id = v_client and sp.platform::text = 'google_business' and sp.service_id = v_service
                  and sp.search_intent = v_target->>'search_intent'
                  and (sp.review_status in ('draft', 'in_review', 'approved') or sp.publish_status::text = 'published')
                  and sp.created_at > now() - interval '21 days') then
      raise exception 'authority_conflict cadence_active: A post for this service and intent was created in the last 21 days' using errcode = 'AU409';
    end if;
  end if;

  -- One open drafter post per client, channel, service and intent.
  if exists (select 1 from social_posts
             where client_id = v_client and drafter_run_id is not null
               and platform::text = v_target->>'channel' and service_id is not distinct from v_service
               and search_intent = v_target->>'search_intent' and review_status in ('draft', 'in_review')) then
    raise exception 'An open drafted post already exists for this service and intent' using errcode = 'unique_violation';
  end if;

  insert into drafter_runs (client_id, requested_via, requested_by, target, brief_version, brief_hash, brief,
                            claim_ids, runtime, attempt, lint, copy_hash, status, authority_opportunity_id)
  values (v_client, coalesce(p->>'requested_via', 'worker'), nullif(p->>'requested_by', '')::uuid, v_target,
          p->>'brief_version', p->>'brief_hash', v_brief, v_claims, p->>'runtime',
          coalesce((p->>'attempt')::int, 1), p->'lint', drafter_copy_hash(v_copy), 'writing', v_opp)
  returning id into v_run;

  insert into social_posts (client_id, platform, post_type, search_intent, service_id, keyword_id, offer_id,
                            cta_type, cta_url, copy, crm_facts_only, drafter_run_id)
  values (v_client, (v_target->>'channel')::social_platform, v_target->>'post_type', v_target->>'search_intent',
          v_service, nullif(v_target->'keyword'->>'id', '')::uuid, nullif(v_target->'offer'->>'id', '')::uuid,
          v_cta_type, v_cta_url, v_copy, false, v_run)
  returning id into v_post;

  insert into post_claims (post_id, client_id, claim_id)
  select v_post, v_client, c from unnest(v_claims) c;
  i := 0;
  while i < cardinality(v_assets) loop
    i := i + 1;
    insert into post_assets (post_id, client_id, brand_asset_id, sort_order) values (v_post, v_client, v_assets[i], i);
  end loop;

  -- 0054: a post whose client and channel require creative stays a draft
  -- (creative_status 'needed'); the Creative Engine submits it with its
  -- creative. Policy none / optional: submitted exactly as before.
  select creative_policy into v_policy from social_posts where id = v_post;
  if v_policy is distinct from 'required' then
    update social_posts set review_status = 'in_review' where id = v_post returning review_task_id into v_task;
  end if;
  update drafter_runs set status = 'submitted', post_id = v_post where id = v_run;

  -- 0053: the post drives the opportunity's lifecycle (in review → in
  -- progress, approved → completed); the request is done, not linked.
  if v_opp is not null then
    perform authority_decide(v_opp, 'link', jsonb_build_object('kind', 'social_post', 'id', v_post));
    update tasks set status = 'done', completed_at = now(),
      notes = coalesce(notes || E'\n', '') || format('Drafted: post %s (drafter run %s), %s.', v_post, v_run,
                     case when v_policy = 'required' then 'waiting for its creative' else 'now in review' end)
     where id = v_req.id;
  end if;

  return jsonb_build_object('run_id', v_run, 'post_id', v_post, 'review_task_id', v_task,
    'authority_opportunity_id', v_opp, 'request_task_id', v_req.id, 'creative_policy', v_policy);
end $$;
revoke all on function drafter_write(jsonb) from public, anon, authenticated;
grant execute on function drafter_write(jsonb) to service_role;

-- ── 15. Storage: the creative-assets bucket ─────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('creative-assets', 'creative-assets', false, 20971520, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;
-- Team reads; nobody writes through the API (the Creative Engine function
-- uploads with the service role; there is no insert, update or delete policy).
create policy "team read creative assets" on storage.objects
  for select to authenticated using (bucket_id = 'creative-assets' and (select is_team()));

-- A creative file is never replaced, renamed or deleted.
create function creative_objects_immutable() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
begin
  if tg_op = 'DELETE' then
    if old.bucket_id = 'creative-assets' then
      raise exception 'Creative files are immutable and never deleted' using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;
  if (old.bucket_id = 'creative-assets' or new.bucket_id = 'creative-assets')
     and (new.bucket_id is distinct from old.bucket_id or new.name is distinct from old.name
          or ((to_jsonb(old)->>'version') is not null
              and (to_jsonb(new)->>'version') is distinct from (to_jsonb(old)->>'version'))) then
    raise exception 'Creative files are immutable; a new file has a new content address' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
revoke all on function creative_objects_immutable() from public, anon, authenticated;
create trigger creative_objects_immutable before update or delete on storage.objects
  for each row execute function creative_objects_immutable();

-- ── 16. Access ──────────────────────────────────────────────────────────────
alter table creative_governance_events enable row level security;
create policy "team reads creative governance" on creative_governance_events
  for select to authenticated using ((select is_team()));
revoke all on creative_governance_events from anon;
revoke insert, update, delete, truncate, references, trigger on creative_governance_events from authenticated;

alter table client_creative_settings enable row level security;
create policy "team reads creative settings" on client_creative_settings
  for select to authenticated using ((select is_team()));
create policy "team sets creative settings" on client_creative_settings
  for insert to authenticated with check ((select is_team()));
create policy "team changes creative settings" on client_creative_settings
  for update to authenticated using ((select is_team())) with check ((select is_team()));
revoke all on client_creative_settings from anon;
revoke delete, truncate, references, trigger on client_creative_settings from authenticated;

alter table creative_templates enable row level security;
create policy "team reads creative templates" on creative_templates
  for select to authenticated using ((select is_team()));
create policy "team retires creative templates" on creative_templates
  for update to authenticated using ((select is_team())) with check ((select is_team()));
revoke all on creative_templates from anon;
revoke insert, delete, truncate, references, trigger on creative_templates from authenticated;

alter table client_creative_templates enable row level security;
create policy "team reads client templates" on client_creative_templates
  for select to authenticated using ((select is_team()));
create policy "team proposes client templates" on client_creative_templates
  for insert to authenticated with check ((select is_team()));
create policy "team approves client templates" on client_creative_templates
  for update to authenticated using ((select is_team())) with check ((select is_team()));
revoke all on client_creative_templates from anon;
revoke delete, truncate, references, trigger on client_creative_templates from authenticated;

alter table creative_runs enable row level security;
create policy "team reads creative runs" on creative_runs
  for select to authenticated using ((select is_team()));
revoke all on creative_runs from anon;
revoke insert, update, delete, truncate, references, trigger on creative_runs from authenticated;

alter table creative_assets enable row level security;
create policy "team reads creative assets" on creative_assets
  for select to authenticated using ((select is_team()));
create policy "team withdraws creative assets" on creative_assets
  for update to authenticated using ((select is_team())) with check ((select is_team()));
revoke all on creative_assets from anon;
revoke insert, delete, truncate, references, trigger on creative_assets from authenticated;

alter table creative_asset_sources enable row level security;
create policy "team reads creative sources" on creative_asset_sources
  for select to authenticated using ((select is_team()));
revoke all on creative_asset_sources from anon;
revoke insert, update, delete, truncate, references, trigger on creative_asset_sources from authenticated;

-- ── 17. Verify ──────────────────────────────────────────────────────────────
do $$
declare
  n int;
begin
  -- Every approved post still hashes to its approval; nothing moved.
  select count(*) into n from social_posts p
   where p.review_status = 'approved' and social_post_hash(social_post_snapshot(p)) is distinct from p.approved_hash;
  if n > 0 then raise exception '0054: % approved post(s) would no longer match their approval', n; end if;
  if exists (select 1 from social_posts where creative_policy <> 'none' or creative_status <> 'none'
                                           or creative_version <> 0 or rejection_category is not null) then
    raise exception '0054: an existing post has creative state';
  end if;
  if exists (select 1 from brand_assets where creative_use <> 'unreviewed') then
    raise exception '0054: an existing asset is not unreviewed';
  end if;
  if exists (select 1 from client_creative_settings) or exists (select 1 from creative_templates) then
    raise exception '0054: no policy or template is enabled by this migration';
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('creative_governance_events', 'client_creative_settings', 'creative_templates',
                       'client_creative_templates', 'creative_runs', 'creative_assets', 'creative_asset_sources')
     and ((qual is not null and qual not like '%is_team()%') or (with_check is not null and with_check not like '%is_team()%'));
  if n > 0 then raise exception '0054: a creative policy does not read is_team()'; end if;
  if (select count(*) from pg_class
       where oid in ('public.creative_governance_events'::regclass, 'public.client_creative_settings'::regclass,
                     'public.creative_templates'::regclass, 'public.client_creative_templates'::regclass,
                     'public.creative_runs'::regclass, 'public.creative_assets'::regclass,
                     'public.creative_asset_sources'::regclass)
         and relrowsecurity) <> 7 then
    raise exception '0054: RLS is not on for every creative table';
  end if;
  if has_table_privilege('anon', 'public.creative_assets', 'select')
     or has_table_privilege('anon', 'public.creative_runs', 'select')
     or has_table_privilege('authenticated', 'public.creative_assets', 'insert,delete')
     or has_table_privilege('authenticated', 'public.creative_runs', 'insert,update,delete')
     or has_table_privilege('authenticated', 'public.creative_asset_sources', 'insert,update,delete')
     or has_table_privilege('authenticated', 'public.creative_governance_events', 'insert,update,delete')
     or has_table_privilege('authenticated', 'public.creative_templates', 'insert,delete') then
    raise exception '0054: grants on the creative tables are wider than intended';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname in ('creative_session_active', 'creative_actor_kind', 'creative_governance_events_guard', 'creative_governance_log', 'creative_diff',
                        'brand_assets_creative_guard', 'brand_assets_creative_history', 'creative_policy_for',
                        'client_creative_settings_guard', 'client_creative_settings_history', 'creative_spec_hash',
                        'creative_templates_guard', 'creative_templates_history', 'creative_runs_guard',
                        'creative_assets_guard', 'creative_assets_history', 'creative_asset_sources_guard',
                        'client_creative_templates_guard', 'client_creative_templates_history',
                        'post_assets_creative_guard', 'social_posts_creative_guard', 'social_posts_creative_after',
                        'creative_support_changed', 'creative_overlay_problems', 'creative_register_template',
                        'creative_begin_run', 'creative_fail_run', 'creative_write', 'creative_objects_immutable',
                        'drafter_write')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
  ) then
    raise exception '0054: an internal creative function is callable over the API';
  end if;
  if has_function_privilege('anon', 'public.request_new_creative(uuid, text)', 'execute')
     or (select prosecdef from pg_proc where oid = 'public.request_new_creative(uuid, text)'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'public.creative_write(jsonb)'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure) then
    raise exception '0054: request_new_creative / creative_write / drafter_write must run with the caller''s rights, not anon''s';
  end if;
  if (select prosrc from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure) not like '%authority_conflict not_requested%'
     or (select prosrc from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure) not like '%creative_policy%' then
    raise exception '0054: drafter_write lost the Authority hand-off or the creative wait';
  end if;
  if exists (select 1 from pg_views where schemaname = 'public' and viewname like 'portal\_%'
             and (definition ilike '%creative%' or definition ilike '%post_assets%')) then
    raise exception '0054: a portal view reads creative tables';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and policyname ilike '%creative%' and cmd <> 'SELECT') then
    raise exception '0054: the creative bucket takes writes through the API';
  end if;
end $$;
