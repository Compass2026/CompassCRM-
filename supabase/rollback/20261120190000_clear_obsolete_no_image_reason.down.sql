-- Rollback for 20261120190000_clear_obsolete_no_image_reason.sql.
-- 1. Takes the no_image_reason_v1 lines back out of content_edit_execute
--    (the inverse replace; grants are kept by CREATE OR REPLACE), returning
--    it to the md5 the migration was written against.
-- 2. Does NOT put the cleared reasons back by default: they were obsolete.
--    To restore them, run the commented block at the end; it re-sets each
--    reason from the backfill's post_events row, only where the post still
--    has no reason. The history rows stay (they are records).
do $patch$
declare
  b text := pg_get_functiondef('public.content_edit_execute(uuid,jsonb)'::regprocedure);
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
  old_s text := $x$    insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role) values (sp.id, sp.client_id, a.id, 1, 'media');
    v_result := jsonb_build_object(
      'added_asset', jsonb_build_object('brand_asset_id', a.id, 'content_hash', a.content_hash, 'width', a.width, 'height', a.height,
                                        'storage_path', a.storage_path),
      'removed_assets', v_removed);$x$;
begin
  if (length(b) - length(replace(b, new_s, ''))) / length(new_s) <> 1 then
    raise exception 'rollback 20261120190000: content_edit_execute is not the patched definition; stop and re-read it';
  end if;
  execute replace(b, new_s, old_s);
  if md5(pg_get_functiondef('public.content_edit_execute(uuid,jsonb)'::regprocedure)) <> '6e0f33ea7a8df9c487584ac98f66c39a' then
    raise exception 'rollback 20261120190000: content_edit_execute did not return to its previous definition';
  end if;
end $patch$;

-- Optional: put the backfilled reasons back (uncomment to run).
-- update social_posts p set no_image_reason = e.from_value
--   from post_events e
--  where e.post_id = p.id and e.kind = 'edited' and p.no_image_reason is null
--    and e.detail->>'cleared_by' = 'migration 20261120190000_clear_obsolete_no_image_reason';
