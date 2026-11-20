-- An attached image makes "why this post has no image" obsolete (Nov 20 2026).
--
-- social_posts.no_image_reason (20261116150000) says why a post deliberately
-- goes out without an image. The delegated media edit (content_edit_execute,
-- replace_media: 20261020200000, 20261029180000, 20261117010000) attaches an
-- image but left the reason in place, so nine posts revised on Nov 20 still
-- told the reviewer they had no image.
--
--   1. content_edit_execute: a successful replace_media that leaves the post
--      with media clears no_image_reason in the same transaction, writes a
--      post_events row (kind 'edited', actor 'assistant' with the receipt via
--      post_events_edit_detail, from_value and detail.cleared_no_image_reason
--      = the cleared text) and puts the cleared text on the receipt's result
--      (result.cleared_no_image_reason). Nothing else in the function changes:
--      it is the production definition with these lines added (the md5 below
--      is production's on Nov 20 2026; each patch must match exactly once).
--   2. Backfill, once: every post with at least one post_assets row and a
--      reason has the reason cleared, with one post_events row per post
--      (actor 'system', the old text kept in from_value and the detail).
--
-- Rollback: supabase/rollback/20261120190000_clear_obsolete_no_image_reason.down.sql

do $guard$
begin
  if md5(pg_get_functiondef('public.content_edit_execute(uuid,jsonb)'::regprocedure)) <> '6e0f33ea7a8df9c487584ac98f66c39a' then
    raise exception '20261120190000: content_edit_execute is not the reviewed definition; re-read it before applying';
  end if;
end $guard$;

-- ── 1. replace_media clears the obsolete reason ─────────────────────────────
do $patch$
declare
  b text := pg_get_functiondef('public.content_edit_execute(uuid,jsonb)'::regprocedure);
  old_s text := $x$    insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role) values (sp.id, sp.client_id, a.id, 1, 'media');
    v_result := jsonb_build_object(
      'added_asset', jsonb_build_object('brand_asset_id', a.id, 'content_hash', a.content_hash, 'width', a.width, 'height', a.height,
                                        'storage_path', a.storage_path),
      'removed_assets', v_removed);$x$;
  new_s text := $x$    insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role) values (sp.id, sp.client_id, a.id, 1, 'media');
    -- 5. no_image_reason_v1: the post has an image now; the reason it had none is obsolete.
    --    Cleared here, kept in the history and on the receipt (sp still holds the old text).
    if sp.no_image_reason is not null and exists (select 1 from post_assets where post_id = sp.id) then
      update social_posts set no_image_reason = null where id = sp.id;
      insert into post_events (post_id, client_id, actor_kind, kind, from_value, to_value, detail)
      values (sp.id, sp.client_id, 'assistant', 'edited', sp.no_image_reason, null,
              jsonb_build_object('fields', jsonb_build_array('no_image_reason'), 'cleared_no_image_reason', sp.no_image_reason));
    end if;
    v_result := jsonb_build_object(
      'added_asset', jsonb_build_object('brand_asset_id', a.id, 'content_hash', a.content_hash, 'width', a.width, 'height', a.height,
                                        'storage_path', a.storage_path),
      'removed_assets', v_removed)
      || case when sp.no_image_reason is not null then jsonb_build_object('cleared_no_image_reason', sp.no_image_reason) else '{}'::jsonb end;$x$;
begin
  if (length(b) - length(replace(b, old_s, ''))) / length(old_s) <> 1 then
    raise exception '20261120190000: content_edit_execute is not the expected definition; stop and re-read it';
  end if;
  execute replace(b, old_s, new_s);
end $patch$;

-- ── 2. Backfill: posts that already have an image ──────────────────────────
do $backfill$
declare
  n int;
begin
  with stale as (
    select p.id, p.client_id, p.no_image_reason as old_reason
      from social_posts p
     where p.no_image_reason is not null
       and exists (select 1 from post_assets pa where pa.post_id = p.id)
       for update of p
  ), cleared as (
    update social_posts p set no_image_reason = null
      from stale s
     where p.id = s.id
    returning s.id, s.client_id, s.old_reason
  )
  insert into post_events (post_id, client_id, actor_kind, kind, from_value, to_value, detail)
  select c.id, c.client_id, 'system', 'edited', c.old_reason, null,
         jsonb_build_object('fields', jsonb_build_array('no_image_reason'), 'cleared_no_image_reason', c.old_reason,
                            'cleared_by', 'migration 20261120190000_clear_obsolete_no_image_reason',
                            'why', 'The post has an attached image, so the reason it had none is obsolete.')
    from cleared c;
  get diagnostics n = row_count;
  raise notice '20261120190000: cleared the no-image reason on % post(s) that have an image', n;
end $backfill$;

-- ── 3. Postconditions ───────────────────────────────────────────────────────
do $verify$
begin
  if (select prosrc from pg_proc where oid = 'public.content_edit_execute(uuid,jsonb)'::regprocedure) not like '%no_image_reason_v1%'
     or (select prosrc from pg_proc where oid = 'public.content_edit_execute(uuid,jsonb)'::regprocedure) not like '%lint_failed%'
     or (select prosrc from pg_proc where oid = 'public.content_edit_execute(uuid,jsonb)'::regprocedure) not like '%rejected with feedback%' then
    raise exception '20261120190000: content_edit_execute was not patched as expected';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.content_edit_execute(uuid,jsonb)'::regprocedure)
     or (select array_to_string(proconfig, ',') from pg_proc where oid = 'public.content_edit_execute(uuid,jsonb)'::regprocedure)
        is distinct from 'search_path=public, pg_temp'
     or has_function_privilege('authenticated', 'public.content_edit_execute(uuid,jsonb)', 'execute')
     or has_function_privilege('anon', 'public.content_edit_execute(uuid,jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.content_edit_execute(uuid,jsonb)', 'execute') then
    raise exception '20261120190000: content_edit_execute lost its rights or settings';
  end if;
  if exists (select 1 from social_posts p
              where p.no_image_reason is not null and exists (select 1 from post_assets pa where pa.post_id = p.id)) then
    raise exception '20261120190000: a post with an image still carries a no-image reason';
  end if;
end $verify$;
