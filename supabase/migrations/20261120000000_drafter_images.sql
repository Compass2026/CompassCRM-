-- Weekly drafts carry their image (or say why not) when they are written.
--
-- Executive OS 3ab519f3 (Nov 19 2026, Tom: "Ensure the recurring workflow
-- produces complete Facebook and GBP drafts, including suitable images or
-- documented exceptions. Correct recurring worker issues at their source
-- instead of repeatedly repairing the same copy problems." Standing rule:
-- "Use verified client photos. Exclude stock photos, invented project
-- imagery and unverified location claims.")
--
-- The weekly worker submitted every Facebook / Business Profile draft with
-- no image ("Images are a separate step"), so each week's drafts reached
-- review incomplete and were repaired by hand. Now, in drafter_write:
--
--   * an unattended run (claimant 'worker-routine:…') may attach only brand
--     files of this client that a teammate approved for creative use
--     (brand_assets.creative_use = 'approved'; a photo must also be marked
--     as the client's own work) — check_violation `image_not_approved`;
--   * an unattended run attaches an image or states why it has none
--     (`no_image_reason`, one line for the reviewer) — check_violation
--     `image_or_reason_required`;
--   * any draft written with no image may carry `no_image_reason`; it is
--     stored on the post (social_posts.no_image_reason, the field the review
--     queue already shows) and ignored when an image is attached.
--
-- Teammate and operator drafting is otherwise unchanged; review, approval
-- and publishing are unchanged. Patched in place (the check sits after the core keyword gate); refuses an
-- unexpected definition. Rollback: supabase/rollback/20261120000000_drafter_images.down.sql.

do $migration$
declare
  definition text := pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
  anchor text := $a$  -- Claims: only ones the brief allowed.
$a$;
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
  if strpos(definition, 'drafter_image_governance_v1') > 0 then return; end if;
  if strpos(definition, 'gbp_open_draft_keyword_v1') = 0 or strpos(definition, 'core_keyword_gate_v1') = 0
     or strpos(definition, 'core_keyword_gate_v1') > strpos(definition, anchor)
     or (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor)
     or (length(definition) - length(replace(definition, old_insert, ''))) <> length(old_insert) then
    raise exception 'Unexpected drafter_write definition; review before adding image governance';
  end if;
  execute replace(replace(definition, anchor, gov || anchor), old_insert, new_insert);
end;
$migration$;

do $verify$
declare d text := pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
begin
  if strpos(d, 'drafter_image_governance_v1') = 0 or strpos(d, 'gbp_open_draft_keyword_v1') = 0
     or strpos(d, 'core_keyword_gate_v1') = 0 or strpos(d, 'social_account_id, no_image_reason)') = 0 then
    raise exception 'drafter_write verify failed';
  end if;
end;
$verify$;
