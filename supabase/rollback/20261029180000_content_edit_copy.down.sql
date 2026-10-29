-- Rollback for 20261029180000_content_edit_copy.sql (delegated copy edits).
-- Restores content_edit_record / content_edit_execute exactly as
-- 20261020200000 defined them (grants are kept by CREATE OR REPLACE), takes
-- the copy branches back out of the two drafter guards, and drops the two
-- helpers and the stage rule. A receipt with no stage (an executed copy edit)
-- blocks restoring stage_id NOT NULL: the script stops and says so, and
-- nothing is changed; those receipts are records and are never deleted here.
do $guard$
begin
  if exists (select 1 from content_edit_receipts where stage_id is null) then
    raise exception 'rollback 20261029180000: copy-edit receipts exist; keep the schema or decide by hand';
  end if;
end $guard$;

create or replace function content_edit_record(p jsonb) returns jsonb
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

create or replace function content_edit_execute(p_id uuid, p_measured jsonb) returns jsonb
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

do $gates$
declare
  d text := pg_get_functiondef('public.social_posts_drafter_guard()'::regprocedure);
  g text := pg_get_functiondef('public.post_links_drafter_guard()'::regprocedure);
  d1 text := $x$
     and not content_edit_copy_allows(old, new)$x$;
  g1 text := $x$  if tg_table_name = 'post_claims' then
    if tg_op = 'INSERT' then
      if content_edit_copy_claim(v_post_id, new.claim_id) then return new; end if;
    elsif content_edit_copy_claim(v_post_id, null) then
      return old;
    end if;
  end if;
$x$;
begin
  if strpos(d, d1) = 0 or strpos(g, g1) = 0 then
    raise exception 'rollback 20261029180000: the guards are not as 20261029180000 left them';
  end if;
  execute replace(d, d1, '');
  execute replace(g, g1, '');
end $gates$;

drop function content_edit_copy_allows(social_posts, social_posts);
drop function content_edit_copy_claim(uuid, uuid);
alter table content_edit_receipts drop constraint content_edit_receipts_stage_kind;
alter table content_edit_receipts alter column stage_id set not null;

do $verify$
begin
  if md5(pg_get_functiondef('public.content_edit_record(jsonb)'::regprocedure)) <> '254f1606df29aa29f314949385f7e31b'
     or md5(pg_get_functiondef('public.content_edit_execute(uuid,jsonb)'::regprocedure)) <> '3726cd1320e3498193c15215c74e6ead'
     or md5(pg_get_functiondef('public.social_posts_drafter_guard()'::regprocedure)) <> '863b5b1ae83e80ddb9efdc4ffcba458b'
     or md5(pg_get_functiondef('public.post_links_drafter_guard()'::regprocedure)) <> '67fa308ffb9a8cc17f2c55153324367a' then
    raise exception 'rollback 20261029180000: the restored definitions are not the pre-release ones';
  end if;
end $verify$;
