-- Tests for 20261120190000 (an attached image clears the obsolete no-image
-- reason), run by scripts/test-portal-sandbox.sh after
-- review_pending_changes.test.sql (the cd harness, and content_edits.test.sql's
-- pe request helpers; sandbox-team@compassmarketing.ai is an admin there). A
-- fictional client with a Facebook Page and posts in review.
--
--   NI1  replace_media on a post with a reason: executed; the reason is
--        cleared in the same transaction; the receipt's result keeps the
--        cleared text; one 'edited' history row names the assistant with the
--        receipt (no person) and keeps the old text
--   NI2  replace_media on a post without a reason: nothing extra in the
--        result and no no-image history row
--   NI3  a refused replace_media leaves the reason, the media and the history
--        exactly as they were
--   NI4  replace_copy never touches the reason (no image is attached)
--   NI5  the backfill (replay hooks): posts with an image and a reason were
--        cleared with one 'system' history row each keeping the old text; a
--        post without an image keeps its reason; a post without a reason has
--        no row
--   NI6  the function keeps its rights and settings; the rollback restores the
--        previous definition (verified in a rolled-back transaction)

\set team '00000000-0000-4000-a000-000000000001'

\c - supabase_admin
\o /dev/null
create schema ni;
insert into clients (id, name, city, state, status) values
  (cd.id('ni'), 'No Image Lights Co (fictional)', 'Wentzville', 'MO', 'active');
insert into services (id, client_id, name, status) values
  (cd.id('ni-svc'), cd.id('ni'), 'Holiday Lighting Installation', 'approved');
insert into social_accounts (id, client_id, platform, external_account_id, display_name) values
  (cd.id('ni-fb'), cd.id('ni'), 'facebook', '777000555666', 'No Image Page');
insert into brand_assets (id, client_id, kind, source, label, storage_path, mime_type, size_bytes, width, height, content_hash,
                          content_hashed_at, content_measurement) values
  (cd.id('ni-old'), cd.id('ni'), 'social_post', 'upload', 'Old graphic', cd.id('ni')::text || '/upload/' || repeat('8', 64) || '.png',
   'image/png', 1900000, 1254, 1254, repeat('8', 64), now(), '{"bytes": 1900000, "content_type": "image/png", "measured_by": "sandbox"}');
insert into storage.objects (bucket_id, name, metadata) values
  ('brand-assets', cd.id('ni')::text || '/upload/' || repeat('8', 64) || '.png', '{"size": 1900000}'),
  ('brand-assets', cd.id('ni')::text || '/upload/' || pe.sha('ni-1') || '.png', '{"size": 2100000}'),
  ('brand-assets', cd.id('ni')::text || '/upload/' || pe.sha('ni-2') || '.png', '{"size": 2100000}'),
  ('brand-assets', cd.id('ni')::text || '/upload/' || pe.sha('ni-3') || '.png', '{"size": 2100000}');
insert into social_posts (id, client_id, platform, search_intent, crm_facts_only, copy, social_account_id, service_id) values
  (cd.id('ni1'), cd.id('ni'), 'facebook', 'navigational', true, 'No Image Lights Co: lights post one.', cd.id('ni-fb'), cd.id('ni-svc')),
  (cd.id('ni2'), cd.id('ni'), 'facebook', 'navigational', true, 'No Image Lights Co: lights post two.', cd.id('ni-fb'), cd.id('ni-svc')),
  (cd.id('ni3'), cd.id('ni'), 'facebook', 'navigational', true, 'No Image Lights Co: lights post three.', cd.id('ni-fb'), cd.id('ni-svc')),
  (cd.id('ni4'), cd.id('ni'), 'facebook', 'navigational', true, 'No Image Lights Co: lights post four.', cd.id('ni-fb'), cd.id('ni-svc'));
-- ni2 already has an image; ni1, ni3 and ni4 went to review deliberately without one.
insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role)
  values (cd.id('ni2'), cd.id('ni'), cd.id('ni-old'), 1, 'media');
update social_posts set review_status = 'in_review' where client_id = cd.id('ni');
update social_posts set no_image_reason = 'No verified photo of this service yet (' || right(id::text, 4) || ').'
 where id in (cd.id('ni1'), cd.id('ni3'), cd.id('ni4'));

create function ni.copy_req(p_op text, p_post uuid, p_copy text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('operation_id', p_op, 'client_id', p.client_id,
    'post', jsonb_build_object('channel', p.platform::text, 'id', p.id, 'service_id', p.service_id,
                               'review_hash', content_social_review_hash(p), 'destination', content_social_destination(p)->>'key'),
    'change', jsonb_build_object('kind', 'replace_copy', 'copy', p_copy, 'claim_ids', '[]'::jsonb),
    'executor', jsonb_build_object('channel', 'claude', 'executed_by', 'Claude via Executive OS', 'account_email', 'sandbox-team@compassmarketing.ai'),
    'authority', jsonb_build_object('kind', 'standing_policy', 'id', 'policy-sandbox', 'channels', '["facebook"]'::jsonb,
                                    'service_ids', jsonb_build_array(cd.id('ni-svc')::text), 'operations', '["replace_copy"]'::jsonb),
    'reason', 'Tom''s wording.')
  from social_posts p where p.id = p_post
$$;
create function ni.copy_revise(p jsonb) returns text language plpgsql as $$
declare r jsonb; e text;
begin
  begin r := content_edit_record(p); exception when others then return sqlstate || ' ' || sqlerrm; end;
  begin
    perform content_edit_execute((r->>'id')::uuid, jsonb_build_object('lint_ok', true, 'brief_hash', 'sha256:' || repeat('b', 64),
      'checked_copy', p->'change'->>'copy', 'warnings', '[]'::jsonb));
  exception when others then
    e := sqlstate || ' ' || sqlerrm;
    perform content_edit_refuse((r->>'id')::uuid, substring(sqlerrm from '^([a-z_]{3,40}):'), sqlerrm);
    return e;
  end;
  return 'executed';
end $$;
-- The post, its media and its history, for "nothing changed".
create function ni.snap(p_post uuid) returns text language sql stable security definer set search_path = public, pg_temp as $$
  select p.review_status || '/' || coalesce(p.no_image_reason, '-') || '/'
      || coalesce((select string_agg(coalesce(pa.brand_asset_id::text, ''), ',' order by pa.id) from post_assets pa where pa.post_id = p.id), '')
      || '/' || (select count(*) from post_events e where e.post_id = p.id)
  from social_posts p where p.id = p_post
$$;
create function ni.receipt(p_op text) returns content_edit_receipts language sql stable security definer set search_path = public, pg_temp as $$
  select * from content_edit_receipts where operation_id = p_op
$$;
grant usage on schema ni to anon, authenticated, service_role, authenticator, postgres;
grant execute on all functions in schema ni to anon, authenticated, service_role, authenticator, postgres;
\o

-- The function (authenticator + service_role), as content-approvals calls it.
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare
  s1 text; s2 text; s3 text; r1 text; r2 text; r3 text; r4 text;
  before3 text := ni.snap(cd.id('ni3'));
  before4 text := ni.snap(cd.id('ni4'));
  reason1 text := (select no_image_reason from social_posts where id = cd.id('ni1'));
  reason4 text := (select no_image_reason from social_posts where id = cd.id('ni4'));
  rc content_edit_receipts;
  ev record;
begin
  -- NI1
  s1 := pe.stage(pe.stage_req('ni-stage-1', cd.id('ni1'), pe.sha('ni-1')));
  r1 := pe.revise(pe.req('ni-rev-1', cd.id('ni1'), s1::uuid, pe.sha('ni-1'), p_services => jsonb_build_array(cd.id('ni-svc')::text)),
                  pe.measured(pe.sha('ni-1')));
  rc := ni.receipt('ni-rev-1');
  select e.* into ev from post_events e where e.post_id = cd.id('ni1') and e.kind = 'edited'
     and e.detail->'fields' ? 'no_image_reason' order by e.id desc limit 1;
  perform cd.ok('NI1 replace_media on a post with a reason: executed, the reason cleared, the receipt and the history keep the old text',
    r1 = 'executed' and reason1 is not null
    and (select no_image_reason is null and review_status = 'in_review' from social_posts where id = cd.id('ni1'))
    and exists (select 1 from post_assets pa join brand_assets a on a.id = pa.brand_asset_id
                 where pa.post_id = cd.id('ni1') and a.content_hash = pe.sha('ni-1'))
    and rc.status = 'executed' and rc.result->>'cleared_no_image_reason' = reason1
    and rc.result ? 'added_asset' and rc.result ? 'removed_assets'
    and ev.actor_kind = 'assistant' and ev.actor_id is null and ev.from_value = reason1 and ev.to_value is null
    and ev.detail->>'cleared_no_image_reason' = reason1 and ev.detail->'edit'->>'receipt' = rc.id::text
    and (select count(*) from post_events e where e.post_id = cd.id('ni1') and e.detail ? 'cleared_no_image_reason') = 1,
    concat_ws(' | ', r1, rc.result::text, to_jsonb(ev)::text));

  -- NI2
  s2 := pe.stage(pe.stage_req('ni-stage-2', cd.id('ni2'), pe.sha('ni-2')));
  r2 := pe.revise(pe.req('ni-rev-2', cd.id('ni2'), s2::uuid, pe.sha('ni-2'), p_services => jsonb_build_array(cd.id('ni-svc')::text)),
                  pe.measured(pe.sha('ni-2')));
  rc := ni.receipt('ni-rev-2');
  perform cd.ok('NI2 replace_media on a post without a reason: no cleared text, no no-image history row',
    r2 = 'executed' and rc.status = 'executed' and not (rc.result ? 'cleared_no_image_reason')
    and (select no_image_reason is null from social_posts where id = cd.id('ni2'))
    and not exists (select 1 from post_events e where e.post_id = cd.id('ni2') and e.detail ? 'cleared_no_image_reason'),
    concat_ws(' | ', r2, rc.result::text));

  -- NI3: the stored bytes are not the declared file.
  s3 := pe.stage(pe.stage_req('ni-stage-3', cd.id('ni3'), pe.sha('ni-3')));
  r3 := pe.revise(pe.req('ni-rev-3', cd.id('ni3'), s3::uuid, pe.sha('ni-3'), p_services => jsonb_build_array(cd.id('ni-svc')::text)),
                  pe.measured(pe.sha('ni-3'), 999));
  perform cd.ok('NI3 a refused replace_media leaves the reason, the media and the history as they were',
    r3 like '23514 bytes_mismatch%' and (ni.receipt('ni-rev-3')).status = 'refused' and ni.snap(cd.id('ni3')) = before3,
    concat_ws(' | ', r3, before3, ni.snap(cd.id('ni3'))));

  -- NI4
  r4 := ni.copy_revise(ni.copy_req('ni-copy-4', cd.id('ni4'), 'No Image Lights Co: lights post four, reworded.'));
  perform cd.ok('NI4 replace_copy never touches the no-image reason',
    r4 = 'executed' and (select no_image_reason = reason4 and copy = 'No Image Lights Co: lights post four, reworded.' from social_posts where id = cd.id('ni4'))
    and not ((ni.receipt('ni-copy-4')).result ? 'cleared_no_image_reason')
    and not exists (select 1 from post_events e where e.post_id = cd.id('ni4') and e.detail ? 'cleared_no_image_reason'),
    concat_ws(' | ', r4, before4, ni.snap(cd.id('ni4'))));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- NI5: what the backfill did to the production-shaped posts (replay hooks).
\c - supabase_admin
\o /dev/null
do $$
declare
  b1 uuid := '0c000000-0000-4000-b000-0000000000b1'; b2 uuid := '0c000000-0000-4000-b000-0000000000b2';
  b3 uuid := '0c000000-0000-4000-b000-0000000000b3'; b4 uuid := '0c000000-0000-4000-b000-0000000000b4';
begin
  perform cd.ok('NI5 backfill: an image and a reason → cleared with one system history row keeping the old text; no image → kept; no reason → no row',
    (select count(*) from ni_replay.posts) = 4
    and (select no_image_reason is null from ni_replay.posts where id = b1)
    and (select no_image_reason is null and review_status = 'draft' from ni_replay.posts where id = b2)
    and (select no_image_reason = 'Text-only on purpose (nb3).' from ni_replay.posts where id = b3)
    and (select no_image_reason is null from ni_replay.posts where id = b4)
    and (select count(*) from ni_replay.events) = 2
    and exists (select 1 from ni_replay.events where post_id = b1 and kind = 'edited' and actor_kind = 'system' and actor_id is null
                   and from_value = 'No verified photo for this location yet (nb1).' and to_value is null
                   and detail->>'cleared_no_image_reason' = from_value
                   and detail->>'cleared_by' = 'migration 20261120190000_clear_obsolete_no_image_reason')
    and exists (select 1 from ni_replay.events where post_id = b2 and from_value = 'No approved image of this service (nb2).')
    and not exists (select 1 from clients where id = '0c000000-0000-4000-b000-0000000000c1'),
    (select string_agg(to_jsonb(e)::text, ' ; ') from ni_replay.events e));
end $$;
\o

-- NI6: rights and settings; the rollback restores the previous definition.
\o /dev/null
select cd.ok('NI6 content_edit_execute keeps its rights and settings (security invoker, pinned search_path, service role only)',
  not (select prosecdef from pg_proc where oid = 'public.content_edit_execute(uuid,jsonb)'::regprocedure)
  and (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.content_edit_execute(uuid,jsonb)'::regprocedure) = 'search_path=public, pg_temp'
  and not has_function_privilege('authenticated', 'public.content_edit_execute(uuid,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.content_edit_execute(uuid,jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.content_edit_execute(uuid,jsonb)', 'execute'));
begin;
\ir ../../rollback/20261120190000_clear_obsolete_no_image_reason.down.sql
do $$ begin
  if position('no_image_reason_v1' in pg_get_functiondef('public.content_edit_execute(uuid,jsonb)'::regprocedure)) > 0 then
    raise exception 'NI6: content_edit_execute not restored';
  end if;
end $$;
\o
rollback;
\o /dev/null
-- (a failed check above stops psql under ON_ERROR_STOP, so reaching this line is the pass)
select cd.ok('NI6b the rollback restores the previous content_edit_execute (verified in a rolled-back transaction)',
  position('no_image_reason_v1' in pg_get_functiondef('public.content_edit_execute(uuid,jsonb)'::regprocedure)) > 0);
\o

\c - supabase_admin
drop schema ni_replay cascade;
select status, count(*) from cd.results where name ~ '^NI[0-9]' group by status;
select n, status, name, detail from cd.results where name ~ '^NI[0-9]' and status <> 'pass' order by n;
do $$
begin
  if exists (select 1 from cd.results where name ~ '^NI[0-9]' and status = 'fail')
     or (select count(*) from cd.results where name ~ '^NI[0-9]') < 7 then
    raise exception 'no_image_reason: failures above';
  end if;
end $$;
