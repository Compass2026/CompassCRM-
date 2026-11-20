-- Rollback of 20261120000000_drafter_images.sql: removes the image
-- governance block and the no_image_reason column from drafter_write's insert,
-- byte for byte.
do $rollback$
declare
  definition text := pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
  gov text := $g$  -- drafter_image_governance_v1 (20261120000000): an unattended draft
  -- attaches only files approved for creative use (a photo of the client's
  -- own work), or says why it has none.
  if coalesce(p->>'claimant', '') like 'worker-routine:%' then
    if exists (select 1 from unnest(v_assets) x left join brand_assets a on a.id = x
                where a.id is null or a.client_id <> v_client or a.creative_use <> 'approved'
                   or (a.kind::text = 'photo' and a.depicts_own_work is not true)) then
      raise exception 'image_not_approved: an unattended draft uses only brand files approved for creative use (a photo must show the client''s own work)'
        using errcode = 'check_violation';
    end if;
    if cardinality(v_assets) = 0 and nullif(btrim(coalesce(p->>'no_image_reason', '')), '') is null then
      raise exception 'image_or_reason_required: an unattended draft attaches an approved image or says why it has none (no_image_reason)'
        using errcode = 'check_violation';
    end if;
  end if;
$g$;
  old_insert text := $o$  insert into social_posts (client_id, platform, post_type, search_intent, service_id, keyword_id, offer_id,
                            cta_type, cta_url, copy, crm_facts_only, drafter_run_id, social_account_id)
  values (v_client, (v_target->>'channel')::social_platform, v_target->>'post_type', v_target->>'search_intent',
          v_service, nullif(v_target->'keyword'->>'id', '')::uuid, nullif(v_target->'offer'->>'id', '')::uuid,
          v_cta_type, v_cta_url, v_copy, false, v_run, v_account)
  returning id into v_post;
$o$;
  new_insert text := $n$  insert into social_posts (client_id, platform, post_type, search_intent, service_id, keyword_id, offer_id,
                            cta_type, cta_url, copy, crm_facts_only, drafter_run_id, social_account_id, no_image_reason)
  values (v_client, (v_target->>'channel')::social_platform, v_target->>'post_type', v_target->>'search_intent',
          v_service, nullif(v_target->'keyword'->>'id', '')::uuid, nullif(v_target->'offer'->>'id', '')::uuid,
          v_cta_type, v_cta_url, v_copy, false, v_run, v_account,
          case when cardinality(v_assets) = 0 then left(nullif(btrim(coalesce(p->>'no_image_reason', '')), ''), 300) end)
  returning id into v_post;
$n$;
begin
  if strpos(definition, 'drafter_image_governance_v1') = 0 then return; end if;
  execute replace(replace(definition, gov, ''), new_insert, old_insert);
end;
$rollback$;
