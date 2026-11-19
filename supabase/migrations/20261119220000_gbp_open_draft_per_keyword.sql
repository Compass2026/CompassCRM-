-- GBP open-draft limit: per keyword, not per service and intent.
--
-- Executive OS 3ab519f3 (Nov 19 2026, Tom: "get production working across
-- Facebook, GBP, blogs and webpage refreshes ... correct recurring worker
-- issues at their source").
--
-- drafter_write allowed one open drafted Business Profile post per client,
-- service and intent. A client's approved core list maps to 8–36 service ×
-- intent pairs, so once the drafts waiting for review covered every pair the
-- weekly standard (5 GBP posts a week) stopped: every Monday and Wednesday
-- run since Nov 4 refused Logic, MADHAIRLAB, Pensacola and Show Me Design
-- with 23505 and blocked the slot task until someone reviewed the queue.
-- Review latency became lost production.
--
-- The rule now matches the Facebook rule (20261011040705): no two open
-- drafted Business Profile posts for the same keyword, with the same copy or
-- with the same image. A core list has 50 keywords, so a week's five slots
-- always have room, and the duplicate the old rule guarded against (two
-- open posts saying the same thing) is still refused. Unchanged: the
-- Authority path's 21-day cadence per service and intent, the core keyword
-- gate, the GBP destination rules, the one-post-per-location-per-day planner
-- cap, review, approval and publishing.
--
-- Patched in place (as 20261027191343 did) so every other change to
-- drafter_write is kept. Refuses to apply if the definition is not the one
-- reviewed. Rollback:
-- supabase/rollback/20261119220000_gbp_open_draft_per_keyword.down.sql.

do $migration$
declare
  definition text := pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
  old_block text := $old$  if v_channel = 'google_business' and exists (select 1 from social_posts
             where client_id = v_client and drafter_run_id is not null
               and platform::text = v_target->>'channel' and service_id is not distinct from v_service
               and search_intent = v_target->>'search_intent' and review_status in ('draft', 'in_review')) then
    raise exception 'An open drafted post already exists for this service and intent' using errcode = 'unique_violation';
  end if;
$old$;
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
begin
  if strpos(definition, 'gbp_open_draft_keyword_v1') > 0 then return; end if;
  if strpos(definition, 'core_keyword_gate_v1') = 0
     or (length(definition) - length(replace(definition, old_block, ''))) <> length(old_block) then
    raise exception 'Unexpected drafter_write definition; review before changing the GBP open-draft limit';
  end if;
  execute replace(definition, old_block, new_block);
end;
$migration$;

-- Verify: the new rule is in place and the old one is gone.
do $verify$
declare d text := pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
begin
  if strpos(d, 'gbp_open_draft_keyword_v1') = 0
     or strpos(d, 'An open drafted post already exists for this service and intent') > 0
     or strpos(d, 'core_keyword_gate_v1') = 0
     or strpos(d, 'An open drafted Facebook post already has this copy or this image') = 0 then
    raise exception 'drafter_write verify failed';
  end if;
end;
$verify$;
