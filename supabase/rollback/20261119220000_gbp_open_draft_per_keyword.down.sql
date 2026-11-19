-- Rollback of 20261119220000_gbp_open_draft_per_keyword.sql: restores the
-- one-open-drafted-GBP-post-per-service-and-intent rule, byte for byte.
do $rollback$
declare
  definition text := pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
  new_block text := $new$  -- gbp_open_draft_keyword_v1 (20261119220000): one open drafted Business
  -- Profile post per keyword; never two with the same copy or the same image.
  if v_channel = 'google_business' and exists (
       select 1 from social_posts sp
        where sp.client_id = v_client and sp.drafter_run_id is not null and sp.platform::text = 'google_business'
          and sp.review_status in ('draft', 'in_review')
          and ((nullif(v_target->'keyword'->>'id', '') is not null
                and sp.keyword_id = nullif(v_target->'keyword'->>'id', '')::uuid)
               or (nullif(v_target->'keyword'->>'id', '') is null
                   and sp.service_id is not distinct from v_service
                   and sp.search_intent = v_target->>'search_intent')
               or drafter_copy_hash(sp.copy) = drafter_copy_hash(v_copy)
               or exists (select 1 from post_assets pa where pa.post_id = sp.id and pa.brand_asset_id = any (v_assets)))) then
    raise exception 'An open drafted Business Profile post already has this keyword, this copy or this image' using errcode = 'unique_violation';
  end if;
$new$;
  old_block text := $old$  if v_channel = 'google_business' and exists (select 1 from social_posts
             where client_id = v_client and drafter_run_id is not null
               and platform::text = v_target->>'channel' and service_id is not distinct from v_service
               and search_intent = v_target->>'search_intent' and review_status in ('draft', 'in_review')) then
    raise exception 'An open drafted post already exists for this service and intent' using errcode = 'unique_violation';
  end if;
$old$;
begin
  if strpos(definition, 'gbp_open_draft_keyword_v1') = 0 then return; end if;
  execute replace(definition, new_block, old_block);
end;
$rollback$;
