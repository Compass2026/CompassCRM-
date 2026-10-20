-- Delegated post edits (Oct 20 2026). Extends 20261019202359; see
-- docs/delegated-post-edits.md and Executive OS docs/phase-5/CONTENT_EDITS.md.
--
-- Tom (Oct 20 2026): "I don't want to have to withdraw them, I want you 2 to
-- handle these kind of edits." Claude or ChatGPT, through Executive OS, may
-- revise ONE Facebook / Business Profile post that is waiting for review:
-- withdraw it, replace its media with bytes Compass measured itself, and
-- resubmit it for a FRESH review, in one transaction under a receipt. An edit
-- never approves, schedules or publishes, and never touches an approved,
-- scheduled or published post (reopening an approved post stays a signed-in
-- teammate's step, so no edit inherits an old approval).
--
--   1. Policy: content_delegation_settings.allow_edit (Compass's own switch;
--      the client / channel exclusions and paused / offboarded clients apply
--      as for approval). Seeded on with Tom's decision; an admin turns it off
--      with content_delegation_configure_edits.
--   2. content_edit_stages: a declared file for one post (sha256, size, type,
--      dimensions) and its content-addressed upload path. Writes no post.
--      content_edit_receipts: one per operation_id; who authorized (an admin
--      team member resolved from the Executive OS account), which assistant
--      executed, the authority Executive OS holds (standing policy or the
--      owner's approval, with its channels / services / operations), the exact
--      post state (review hash, destination, service) and the change.
--   3. Identity: content_edit_receipt() is the receipt only while it is
--      'executing' in THIS transaction (txid), for the service role — the
--      content_delegation_receipt() pattern. A compass.content_edit setting
--      left on a pooled connection matches nothing in the next transaction.
--      post_caller_kind() then says 'assistant'; post history records the
--      assistant with the receipt, never a person as the actor.
--   4. The gates: the drafter link guard admits the receipt's own post's
--      brand-asset media; updated_by names the authorizing admin.
--   5. content_edit_stage / _record / _execute / _refuse / _status: the
--      content-approvals function's only doors (service role).
--   6. content_review_batch returns each post's service_id (the revision binds it).
--
-- Rollback: drop the five functions, the identity helpers, the post_events
-- trigger and both tables; drop allow_edit; restore post_caller_kind (0054),
-- social_posts_before_update / content_review_batch (20261019202359),
-- post_links_drafter_guard (0054) and post_events_actor_kind_check (0054).

-- ── 1. Policy ───────────────────────────────────────────────────────────────
alter table content_delegation_settings add column allow_edit boolean not null default false;
select set_config('compass.delegation_admin', 'on', true);
update content_delegation_settings set allow_edit = true;
select set_config('compass.delegation_admin', '', true);
comment on column content_delegation_settings.allow_edit is
  'Tom, Oct 20 2026: Claude / ChatGPT may revise a post in review (replace media, resubmit for his fresh review) under Executive OS''s editorial policy. Never approves, schedules or publishes (20261020200000).';

create function content_delegation_configure_edits(p_allow_edit boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := content_delegation_admin_check(); s content_delegation_settings;
begin
  perform set_config('compass.delegation_admin', 'on', true);
  update content_delegation_settings set allow_edit = p_allow_edit, updated_by = me, updated_at = now() returning * into s;
  perform set_config('compass.delegation_admin', '', true);
  return to_jsonb(s);
end $$;
revoke all on function content_delegation_configure_edits(boolean) from public, anon;
grant execute on function content_delegation_configure_edits(boolean) to authenticated;

-- Null when the policy allows an edit, else why not.
create function content_delegation_edit_refusal(p_client uuid, p_channel text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s content_delegation_settings; c clients; x content_delegation_exclusions;
begin
  if p_channel not in ('facebook', 'google_business') then return format('%s items are not edited by delegation.', p_channel); end if;
  select * into s from content_delegation_settings;
  if s.id is null or not s.enabled then return 'Delegation is switched off in Compass.'; end if;
  if not s.allow_edit then return 'Delegated edits are switched off in Compass.'; end if;
  if not (p_channel = any (s.channels)) then return format('Delegation is not enabled for %s.', p_channel); end if;
  select * into c from clients where id = p_client;
  if c.id is null then return 'No such client.'; end if;
  if c.status::text in ('paused', 'offboarded') then return format('%s is %s.', c.name, c.status); end if;
  select * into x from content_delegation_exclusions
   where client_id = p_client and removed_at is null and (channel is null or channel = p_channel)
   order by channel nulls first limit 1;
  if x.id is not null then
    return format('%s is excluded from delegation%s: %s', c.name, coalesce(' for ' || x.channel, ''), x.reason);
  end if;
  return null;
end $$;
revoke all on function content_delegation_edit_refusal(uuid, text) from public, anon, authenticated;

-- ── 2. Stages and receipts ──────────────────────────────────────────────────
create table content_edit_stages (
  id uuid primary key default gen_random_uuid(),
  operation_id text not null unique check (operation_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  request_hash text not null check (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  client_id uuid not null references clients (id),
  post_id uuid not null,
  channel text not null check (channel in ('facebook', 'google_business')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes between 1 and 31457280),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  width int not null check (width between 1 and 10000),
  height int not null check (height between 1 and 10000),
  file_name text not null check (file_name ~ '^[\w.\- ]{1,200}$'),
  storage_path text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid,
  foreign key (post_id, client_id) references social_posts (id, client_id) on delete cascade,
  check ((consumed_at is null) = (consumed_by is null))
);
comment on table content_edit_stages is
  'A declared replacement file for one post and its content-addressed upload path (20261020200000). Written only by content_edit_stage / _execute.';

create table content_edit_receipts (
  id uuid primary key default gen_random_uuid(),
  operation_id text not null unique check (operation_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  request_hash text not null check (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  client_id uuid not null references clients (id),
  post_id uuid not null,
  channel text not null check (channel in ('facebook', 'google_business')),
  service_id uuid,
  review_hash text not null check (review_hash ~ '^sha256:[0-9a-f]{64}$'),
  destination text not null,
  stage_id uuid not null references content_edit_stages (id),
  change jsonb not null,
  authorized_by uuid not null references team_members (id),
  account_email text not null,
  executor_channel text not null check (executor_channel in ('chatgpt', 'claude')),
  executed_by text not null check (length(btrim(executed_by)) between 1 and 120),
  authority jsonb not null,
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  source_ref jsonb,
  status text not null default 'recorded' check (status in ('recorded', 'executing', 'executed', 'refused')),
  executing_txid bigint,
  refusal_code text,
  refusal text,
  result jsonb,
  created_at timestamptz not null default now(),
  executed_at timestamptz,
  check ((status = 'refused') = (refusal is not null)),
  check ((status = 'executed') = (executed_at is not null))
);
create index content_edit_receipts_post_idx on content_edit_receipts (post_id, created_at desc);
comment on table content_edit_receipts is
  'Receipts for delegated post edits (20261020200000): who authorized, which assistant executed, the authority, the exact post state and the change. Written only by the content_edit_* functions.';

alter table content_edit_stages enable row level security;
alter table content_edit_receipts enable row level security;
create policy "team reads edit stages" on content_edit_stages for select to authenticated using ((select is_team()));
create policy "team reads edit receipts" on content_edit_receipts for select to authenticated using ((select is_team()));
revoke all on content_edit_stages, content_edit_receipts from anon, authenticated;
grant select on content_edit_stages, content_edit_receipts to authenticated;

create function content_edit_tables_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('compass.edit_write', true), '') <> 'on' and not drafter_caller_is_superuser() then
    raise exception 'Edit stages and receipts are written by the content_edit functions' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' and not drafter_caller_is_superuser() then
    raise exception 'Edit stages and receipts are records' using errcode = '42501';
  end if;
  if tg_table_name = 'content_edit_receipts' and tg_op = 'UPDATE' then
    if (new.id, new.operation_id, new.request_hash, new.client_id, new.post_id, new.channel, new.service_id, new.review_hash,
        new.destination, new.stage_id, new.change, new.authorized_by, new.account_email, new.executor_channel, new.executed_by,
        new.authority, new.reason, new.source_ref, new.created_at)
       is distinct from (old.id, old.operation_id, old.request_hash, old.client_id, old.post_id, old.channel, old.service_id, old.review_hash,
        old.destination, old.stage_id, old.change, old.authorized_by, old.account_email, old.executor_channel, old.executed_by,
        old.authority, old.reason, old.source_ref, old.created_at) then
      raise exception 'The authorized edit is immutable' using errcode = '42501';
    end if;
    if old.status in ('executed', 'refused') and not drafter_caller_is_superuser() then
      raise exception 'A finished edit is a record' using errcode = '42501';
    end if;
  end if;
  if tg_table_name = 'content_edit_stages' and tg_op = 'UPDATE' and not drafter_caller_is_superuser()
     and (to_jsonb(new) - array['consumed_at', 'consumed_by']) is distinct from (to_jsonb(old) - array['consumed_at', 'consumed_by']) then
    raise exception 'A declared file is immutable' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function content_edit_tables_guard() from public, anon, authenticated;
create trigger content_edit_stages_guard before insert or update or delete on content_edit_stages
  for each row execute function content_edit_tables_guard();
create trigger content_edit_receipts_guard before insert or update or delete on content_edit_receipts
  for each row execute function content_edit_tables_guard();

-- ── 3. Identity: the executing receipt, in this transaction only ────────────
create function content_edit_receipt() returns content_edit_receipts
language sql stable security definer set search_path = public, pg_temp as $$
  select r.* from content_edit_receipts r
   where drafter_caller_is_service()
     and r.id = nullif(current_setting('compass.content_edit', true), '')::uuid
     and r.status = 'executing' and r.executing_txid = txid_current()
$$;
revoke all on function content_edit_receipt() from public, anon, authenticated;

create function content_edit_active() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select (content_edit_receipt()).id is not null
$$;
revoke all on function content_edit_active() from public, anon, authenticated;

create function content_edit_authorizer() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select (content_edit_receipt()).authorized_by
$$;
revoke all on function content_edit_authorizer() from public, anon, authenticated;

create function content_edit_allows_post(p_post uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select r.post_id = p_post from (select (content_edit_receipt()).*) r where r.id is not null), false)
$$;
revoke all on function content_edit_allows_post(uuid) from public, anon, authenticated;

-- Post history: the assistant is its own actor, with the receipt.
alter table post_events drop constraint post_events_actor_kind_check;
alter table post_events add constraint post_events_actor_kind_check
  check (actor_kind in ('team', 'worker', 'system', 'publisher', 'drafter', 'creative', 'assistant'));

create function post_events_edit_detail() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r content_edit_receipts := content_edit_receipt();
begin
  if r.id is not null and new.post_id = r.post_id then
    if new.actor_kind in ('assistant', 'worker') then
      new.actor_kind := 'assistant';
      new.actor_id := null;
    end if;
    new.detail := coalesce(new.detail, '{}'::jsonb) || jsonb_build_object('edit', jsonb_build_object(
      'receipt', r.id, 'executed_by', r.executed_by, 'channel', r.executor_channel, 'authorized_by', r.authorized_by));
  end if;
  return new;
end $$;
revoke all on function post_events_edit_detail() from public, anon, authenticated;
create trigger post_events_edit_detail before insert on post_events
  for each row execute function post_events_edit_detail();

-- ── 4. The gates (patched in place) ─────────────────────────────────────────
do $migration$
declare
  k text := pg_get_functiondef('public.post_caller_kind()'::regprocedure);
  u text := pg_get_functiondef('public.social_posts_before_update()'::regprocedure);
  g text := pg_get_functiondef('public.post_links_drafter_guard()'::regprocedure);
  b text := pg_get_functiondef('public.content_review_batch(uuid,text)'::regprocedure);
  k1 text := $x$  select case
    when drafter_session_active() then 'drafter'$x$;
  u1 text := $x$  new.updated_by := case when v_human then task_actor() else content_delegation_reviewer() end;$x$;
  g1 text := $x$  if drafter_caller_is_superuser() or post_caller_is_human() then return coalesce(new, old); end if;$x$;
  b1 text := $x$      'channel', p.platform::text, 'id', p.id, 'post_id', p.id, 'status', p.review_status, 'publish_status', p.publish_status,$x$;
  n int;
begin
  if strpos(k, 'content_edit_active') > 0 then return; end if;
  foreach n in array array[
      (length(k) - length(replace(k, k1, ''))) / length(k1), (length(u) - length(replace(u, u1, ''))) / length(u1),
      (length(g) - length(replace(g, g1, ''))) / length(g1), (length(b) - length(replace(b, b1, ''))) / length(b1)] loop
    if n <> 1 then raise exception '20261020200000: a gate anchor is missing or repeated; review before applying'; end if;
  end loop;
  execute replace(k, k1, $x$  select case
    when content_edit_active() then 'assistant'
    when drafter_session_active() then 'drafter'$x$);
  execute replace(u, u1,
    $x$  new.updated_by := case when v_human then task_actor() else coalesce(content_delegation_reviewer(), content_edit_authorizer()) end;$x$);
  -- delegated_post_edits_v1: the executing edit receipt may swap its own post's brand-asset media.
  execute replace(g, g1, $x$  if drafter_caller_is_superuser() or post_caller_is_human() then return coalesce(new, old); end if;
  if tg_table_name = 'post_assets' and content_edit_allows_post(v_post_id) then
    if coalesce(new.creative_asset_id, old.creative_asset_id) is null then return coalesce(new, old); end if;
  end if;$x$);
  execute replace(b, b1, $x$      'channel', p.platform::text, 'id', p.id, 'post_id', p.id, 'status', p.review_status, 'publish_status', p.publish_status,
      'service_id', p.service_id,$x$);
end;
$migration$;

-- ── 5. The Edge Function's doors ────────────────────────────────────────────
-- Stage: one declared file for one post, and where its bytes go
-- (<client>/upload/<sha256>.<ext>, never overwritten). Idempotent per
-- operation_id; the same id for a different request is a conflict.
create function content_edit_stage(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  s content_edit_stages;
  sp social_posts;
  v_hash text := 'sha256:' || encode(sha256(convert_to(p::text, 'UTF8')), 'hex');
  f jsonb := coalesce(p->'file', '{}'::jsonb);
  v_channel text := p->'post'->>'channel';
  v_refusal text;
  v_ext text;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  select * into s from content_edit_stages where operation_id = p->>'operation_id';
  if s.id is not null then
    if s.request_hash <> v_hash then
      raise exception 'operation_reused: operation % was used for a different request', s.operation_id using errcode = 'CD409';
    end if;
    return to_jsonb(s) || jsonb_build_object('replayed', true);
  end if;
  if coalesce(p->>'operation_id', '') !~ '^[A-Za-z0-9_-]{8,128}$' then raise exception 'request_invalid: operation_id' using errcode = '22023'; end if;
  if v_channel not in ('facebook', 'google_business') then raise exception 'request_invalid: channel is facebook or google_business' using errcode = '22023'; end if;
  v_ext := case f->>'mime_type' when 'image/png' then 'png' when 'image/jpeg' then 'jpg' when 'image/webp' then 'webp' end;
  if v_ext is null or coalesce(f->>'sha256', '') !~ '^[0-9a-f]{64}$' or coalesce(f->>'file_name', '') !~ '^[\w.\- ]{1,200}$'
     or coalesce((f->>'size_bytes')::bigint, 0) not between 1 and 31457280
     or coalesce((f->>'width')::int, 0) not between 1 and 10000 or coalesce((f->>'height')::int, 0) not between 1 and 10000 then
    raise exception 'request_invalid: the file needs sha256, size_bytes, mime_type (png, jpeg, webp), width, height and file_name' using errcode = '22023';
  end if;
  select * into sp from social_posts where id = (p->'post'->>'id')::uuid and client_id = (p->>'client_id')::uuid;
  if sp.id is null then raise exception 'post_not_found: % is not a post of this client', p->'post'->>'id' using errcode = '23514'; end if;
  if sp.platform::text <> v_channel then
    raise exception 'channel_mismatch: post % is a % post, not %', sp.id, sp.platform, v_channel using errcode = '23514';
  end if;
  v_refusal := content_delegation_edit_refusal(sp.client_id, v_channel);
  if v_refusal is not null then raise exception 'policy_disallows: %', v_refusal using errcode = '42501'; end if;
  perform set_config('compass.edit_write', 'on', true);
  insert into content_edit_stages (operation_id, request_hash, client_id, post_id, channel, sha256, size_bytes, mime_type, width, height,
      file_name, storage_path, expires_at)
    values (p->>'operation_id', v_hash, sp.client_id, sp.id, v_channel, f->>'sha256', (f->>'size_bytes')::bigint, f->>'mime_type',
      (f->>'width')::int, (f->>'height')::int, f->>'file_name', sp.client_id || '/upload/' || (f->>'sha256') || '.' || v_ext,
      now() + interval '30 minutes')
    returning * into s;
  perform set_config('compass.edit_write', '', true);
  return to_jsonb(s) || jsonb_build_object('replayed', false);
end $$;
revoke all on function content_edit_stage(jsonb) from public, anon, authenticated;
grant execute on function content_edit_stage(jsonb) to service_role;

-- Record: the receipt, before anything changes.
create function content_edit_record(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  r content_edit_receipts;
  m team_members;
  st content_edit_stages;
  v_hash text := 'sha256:' || encode(sha256(convert_to((p - 'source_ref')::text, 'UTF8')), 'hex');
  po jsonb := coalesce(p->'post', '{}'::jsonb);
  ch jsonb := coalesce(p->'change', '{}'::jsonb);
  ex jsonb := coalesce(p->'executor', '{}'::jsonb);
  au jsonb := coalesce(p->'authority', '{}'::jsonb);
  v_refusal text;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  select * into r from content_edit_receipts where operation_id = p->>'operation_id';
  if r.id is not null then
    if r.request_hash <> v_hash then
      raise exception 'operation_reused: operation % was used for a different request', r.operation_id using errcode = 'CD409';
    end if;
    select * into st from content_edit_stages where id = r.stage_id;
    return to_jsonb(r) - 'executing_txid' || jsonb_build_object('replayed', true, 'storage_path', st.storage_path);
  end if;
  select * into m from team_members where lower(email) = lower(btrim(coalesce(ex->>'account_email', '')));
  if m.id is null or m.role <> 'admin' then
    raise exception 'not_authorized: % is not a Compass admin who can authorize edits', ex->>'account_email' using errcode = '42501';
  end if;
  if coalesce(p->>'operation_id', '') !~ '^[A-Za-z0-9_-]{8,128}$'
     or po->>'channel' not in ('facebook', 'google_business')
     or coalesce(po->>'review_hash', '') !~ '^sha256:[0-9a-f]{64}$'
     or nullif(btrim(coalesce(po->>'destination', '')), '') is null
     or ch->>'kind' is distinct from 'replace_media'
     or coalesce(ch->>'sha256', '') !~ '^[0-9a-f]{64}$'
     or length(btrim(coalesce(ch->>'label', ''))) not between 1 and 200
     or length(btrim(coalesce(ch->>'provenance', ''))) not between 1 and 1000
     or ex->>'channel' not in ('chatgpt', 'claude')
     or length(btrim(coalesce(ex->>'executed_by', ''))) not between 1 and 120
     or length(btrim(coalesce(p->>'reason', ''))) not between 1 and 1000
     or au->>'kind' not in ('standing_policy', 'owner_approval') or nullif(btrim(coalesce(au->>'id', '')), '') is null
     or jsonb_typeof(au->'channels') <> 'array' or jsonb_typeof(au->'service_ids') <> 'array' or jsonb_typeof(au->'operations') <> 'array' then
    raise exception 'request_invalid: post {channel, id, service_id, review_hash, destination}, change {kind replace_media, stage_id, sha256, label, provenance}, executor, authority and reason are required'
      using errcode = '22023';
  end if;
  v_refusal := content_delegation_edit_refusal((p->>'client_id')::uuid, po->>'channel');
  if v_refusal is not null then raise exception 'policy_disallows: %', v_refusal using errcode = '42501'; end if;
  select * into st from content_edit_stages
   where id = (ch->>'stage_id')::uuid and client_id = (p->>'client_id')::uuid and post_id = (po->>'id')::uuid;
  if st.id is null then raise exception 'stage_not_found: no staged file for this post' using errcode = '23514'; end if;
  perform set_config('compass.edit_write', 'on', true);
  insert into content_edit_receipts (operation_id, request_hash, client_id, post_id, channel, service_id, review_hash, destination,
      stage_id, change, authorized_by, account_email, executor_channel, executed_by, authority, reason, source_ref)
    values (p->>'operation_id', v_hash, (p->>'client_id')::uuid, (po->>'id')::uuid, po->>'channel', nullif(po->>'service_id', '')::uuid,
      po->>'review_hash', po->>'destination', st.id, ch, m.id, lower(btrim(ex->>'account_email')), ex->>'channel', btrim(ex->>'executed_by'),
      au, btrim(p->>'reason'), p->'source_ref')
    returning * into r;
  perform set_config('compass.edit_write', '', true);
  return to_jsonb(r) - 'executing_txid' || jsonb_build_object('replayed', false, 'storage_path', st.storage_path);
end $$;
revoke all on function content_edit_record(jsonb) from public, anon, authenticated;
grant execute on function content_edit_record(jsonb) to service_role;

-- Execute: every check, then withdraw → replace media → resubmit, in ONE
-- transaction. p_measured is what the function measured from the stored bytes.
create function content_edit_execute(p_id uuid, p_measured jsonb) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  r content_edit_receipts;
  sp social_posts;
  st content_edit_stages;
  a brand_assets;
  v_refusal text;
  v_obj record;
  v_removed jsonb;
  v_sha text := p_measured->>'content_hash';
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  select * into r from content_edit_receipts where id = p_id for update;
  if r.id is null then raise exception 'No such edit' using errcode = 'P0002'; end if;
  if r.status in ('executed', 'refused') then return to_jsonb(r) - 'executing_txid' || jsonb_build_object('replayed', true); end if;

  perform set_config('compass.edit_write', 'on', true);
  update content_edit_receipts set status = 'executing', executing_txid = txid_current() where id = r.id;
  perform set_config('compass.content_edit', r.id::text, true);

  -- The policy again (it may have changed since recording).
  v_refusal := content_delegation_edit_refusal(r.client_id, r.channel);
  if v_refusal is not null then raise exception 'policy_disallows: %', v_refusal using errcode = '23514'; end if;

  -- The post, held to the authority and to what the assistant read.
  select * into sp from social_posts where id = r.post_id and client_id = r.client_id for update;
  if sp.id is null then raise exception 'post_not_found: % is not a post of this client', r.post_id using errcode = '23514'; end if;
  if sp.platform::text <> r.channel then
    raise exception 'channel_mismatch: post % is a % post, not %', sp.id, sp.platform, r.channel using errcode = '23514';
  end if;
  if sp.service_id is distinct from r.service_id then
    raise exception 'service_mismatch: the post''s service is %, not %', coalesce(sp.service_id::text, 'none'), coalesce(r.service_id::text, 'none')
      using errcode = '23514';
  end if;
  if not (r.authority->'channels' ? sp.platform::text) or sp.service_id is null or not (r.authority->'service_ids' ? sp.service_id::text)
     or not (r.authority->'operations' ? 'replace_media') then
    raise exception 'outside_authority: the post is outside the authority''s channels, services or operations' using errcode = '23514';
  end if;
  if content_social_destination(sp)->>'key' is distinct from r.destination then
    raise exception 'wrong_destination: the % post goes to %, not %', sp.platform, coalesce(content_social_destination(sp)->>'key', 'no account'), r.destination
      using errcode = '23514';
  end if;
  if sp.review_status <> 'in_review' or sp.publish_status <> 'not_scheduled' or sp.approved_hash is not null then
    raise exception 'not_editable: the post is % / %; only an unapproved, unscheduled post in review is revised', sp.review_status, sp.publish_status
      using errcode = '23514';
  end if;
  if content_social_review_hash(sp) <> r.review_hash then
    raise exception 'content_changed: the % post % changed since it was read; read the batch again', sp.platform, sp.id using errcode = '23514';
  end if;
  if exists (select 1 from post_assets where post_id = sp.id and creative_asset_id is not null) then
    raise exception 'creative_engine_post: its media is Creative Engine output; request new creative instead' using errcode = '23514';
  end if;

  -- The file: declared, uploaded and measured identically.
  select * into st from content_edit_stages where id = r.stage_id for update;
  if st.id is null or st.post_id <> sp.id or st.client_id <> r.client_id then
    raise exception 'stage_not_found: no staged file for this post' using errcode = '23514';
  end if;
  if st.consumed_at is not null then raise exception 'stage_consumed: the staged file was already used' using errcode = '23514'; end if;
  if st.expires_at < now() then raise exception 'stage_expired: stage the file again' using errcode = '23514'; end if;
  select * into v_obj from storage.objects where bucket_id = 'brand-assets' and name = st.storage_path;
  if not found or v_sha is null then raise exception 'bytes_missing: nothing was uploaded to the slot' using errcode = '23514'; end if;
  if v_sha <> st.sha256 or r.change->>'sha256' <> st.sha256
     or (p_measured->>'bytes')::bigint is distinct from st.size_bytes
     or p_measured->>'content_type' is distinct from st.mime_type
     or (p_measured->>'width')::int is distinct from st.width or (p_measured->>'height')::int is distinct from st.height
     or ((v_obj.metadata->>'size') is not null and (v_obj.metadata->>'size')::bigint <> st.size_bytes) then
    raise exception 'bytes_mismatch: the stored bytes are not the declared file (measured %, % bytes, %, %x%)',
      left(coalesce(v_sha, 'none'), 12), p_measured->>'bytes', p_measured->>'content_type', p_measured->>'width', p_measured->>'height'
      using errcode = '23514';
  end if;

  -- 1. Withdraw (its review task closes).
  update social_posts set review_status = 'draft' where id = sp.id;
  -- 2. Unlink its brand-asset media.
  select coalesce(jsonb_agg(jsonb_build_object('brand_asset_id', brand_asset_id, 'content_hash', content_hash) order by sort_order, id), '[]'::jsonb)
    into v_removed from post_assets where post_id = sp.id and role = 'media' and creative_asset_id is null;
  delete from post_assets where post_id = sp.id and role = 'media' and creative_asset_id is null;
  -- 3. The asset: the client's row for these bytes, or a new one; its hash is measured, never typed.
  select * into a from brand_assets where client_id = r.client_id and storage_path = st.storage_path order by created_at limit 1;
  if a.id is null then
    insert into brand_assets (client_id, kind, source, label, storage_path, file_name, mime_type, size_bytes, width, height, notes, uploaded_by)
    values (r.client_id, 'social_post', 'upload', btrim(r.change->>'label'), st.storage_path, st.file_name, st.mime_type, st.size_bytes,
            st.width, st.height,
            format('%s Filed by content-approvals (delegated edit %s): executed by %s on the authorization of %s.',
                   btrim(r.change->>'provenance'), r.id, r.executed_by, r.account_email),
            format('content-approvals editorial (%s)', r.executed_by))
    returning * into a;
  end if;
  if a.content_hash is null then
    perform brand_asset_record_hash(jsonb_build_object('asset_id', a.id, 'storage_path', a.storage_path, 'expected_hash', null,
      'content_hash', v_sha, 'width', st.width, 'height', st.height, 'byte_size', st.size_bytes, 'content_type', st.mime_type,
      'raw_width', coalesce((p_measured->>'raw_width')::int, st.width), 'raw_height', coalesce((p_measured->>'raw_height')::int, st.height),
      'orientation', coalesce((p_measured->>'orientation')::int, 1), 'measured_by', 'content-approvals/editorial'));
    perform set_config('compass.source_hash', '', true);
    select * into a from brand_assets where id = a.id;
  elsif a.content_hash <> v_sha then
    raise exception 'bytes_mismatch: the asset on file for these bytes records another hash' using errcode = '23514';
  end if;
  -- 4. Link it.
  insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role) values (sp.id, sp.client_id, a.id, 1, 'media');
  -- 5. Resubmit: the existing grounding check, a new review task.
  begin
    update social_posts set review_status = 'in_review' where id = sp.id;
  exception when check_violation then
    raise exception 'grounding_failed: %', sqlerrm using errcode = '23514';
  end;

  select * into sp from social_posts where id = sp.id;
  update content_edit_stages set consumed_at = now(), consumed_by = r.id where id = st.id;
  update content_edit_receipts set status = 'executed', executed_at = now(), executing_txid = null,
         result = jsonb_build_object('post_id', sp.id, 'review_status', sp.review_status, 'publish_status', sp.publish_status,
           'review_hash', content_social_review_hash(sp), 'review_task_id', sp.review_task_id,
           'added_asset', jsonb_build_object('brand_asset_id', a.id, 'content_hash', a.content_hash, 'width', a.width, 'height', a.height,
                                             'storage_path', a.storage_path),
           'removed_assets', v_removed,
           'review_url', 'https://compass-crm-ten.vercel.app/clients/' || sp.client_id || '/social/' || sp.id)
   where id = r.id returning * into r;
  perform set_config('compass.content_edit', '', true);
  perform set_config('compass.edit_write', '', true);
  return to_jsonb(r) - 'executing_txid' || jsonb_build_object('replayed', false);
end $$;
revoke all on function content_edit_execute(uuid, jsonb) from public, anon, authenticated;
grant execute on function content_edit_execute(uuid, jsonb) to service_role;

-- Refuse: a recorded edit whose execution failed its checks (it rolled back).
create function content_edit_refuse(p_id uuid, p_code text, p_message text) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare r content_edit_receipts;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  perform set_config('compass.edit_write', 'on', true);
  update content_edit_receipts set status = 'refused', refusal_code = left(coalesce(p_code, 'refused'), 60),
         refusal = left(coalesce(nullif(btrim(p_message), ''), 'Refused.'), 1000)
   where id = p_id and status = 'recorded' returning * into r;
  perform set_config('compass.edit_write', '', true);
  if r.id is null then select * into r from content_edit_receipts where id = p_id; end if;
  return to_jsonb(r) - 'executing_txid';
end $$;
revoke all on function content_edit_refuse(uuid, text, text) from public, anon, authenticated;
grant execute on function content_edit_refuse(uuid, text, text) to service_role;

-- Status: the receipt and the post now.
create function content_edit_status(p_operation_id text) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare r content_edit_receipts; sp social_posts;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  select * into r from content_edit_receipts where operation_id = p_operation_id;
  if r.id is null then return null; end if;
  select * into sp from social_posts where id = r.post_id;
  return to_jsonb(r) - 'executing_txid' || jsonb_build_object('post_now', case when sp.id is null then null else jsonb_build_object(
    'review_status', sp.review_status, 'publish_status', sp.publish_status, 'review_hash', content_social_review_hash(sp),
    'media', coalesce((select jsonb_agg(jsonb_build_object('brand_asset_id', pa.brand_asset_id, 'content_hash', pa.content_hash) order by pa.sort_order, pa.id)
                         from post_assets pa where pa.post_id = sp.id and pa.role = 'media'), '[]'::jsonb)) end);
end $$;
revoke all on function content_edit_status(text) from public, anon, authenticated;
grant execute on function content_edit_status(text) to service_role;

-- ── 6. Postconditions ───────────────────────────────────────────────────────
do $$
begin
  if (select prosrc from pg_proc where oid = 'public.post_caller_kind()'::regprocedure) not like '%content_edit_active()%'
     or (select prosrc from pg_proc where oid = 'public.social_posts_before_update()'::regprocedure) not like '%content_edit_authorizer()%'
     or (select prosrc from pg_proc where oid = 'public.post_links_drafter_guard()'::regprocedure) not like '%content_edit_allows_post%'
     or (select prosrc from pg_proc where oid = 'public.content_review_batch(uuid,text)'::regprocedure) not like '%''service_id'', p.service_id%' then
    raise exception '20261020200000: a gate was not patched';
  end if;
  if has_function_privilege('authenticated', 'public.content_edit_execute(uuid,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.content_edit_record(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.content_edit_stage(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.content_edit_allows_post(uuid)', 'execute')
     or has_function_privilege('anon', 'public.content_edit_status(text)', 'execute')
     or has_table_privilege('authenticated', 'public.content_edit_receipts', 'insert')
     or has_table_privilege('authenticated', 'public.content_edit_stages', 'update') then
    raise exception '20261020200000: grants are wrong';
  end if;
end $$;
