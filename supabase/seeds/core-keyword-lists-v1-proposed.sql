-- PROVISIONAL — NOT APPLIED. Run only after migration 20261027160000 is
-- reviewed, accepted and applied (PR #192).
--
-- Proposes core keyword list v1 for every active or launching client. The
-- rows are PROPOSALS (status 'proposed'): nothing here approves a list,
-- deletes or untracks a keyword, or touches an existing draft or
-- publication. Until a signed-in teammate approves a client's list
-- (Keywords tab › Core keyword list), nothing new enters review for that
-- client — weekly or by hand — and the queue says so in delivery_queue_log.
-- A list is approvable only with exactly 50 valid keywords (active, intent
-- recorded); on Oct 27 that is Ginger, Logic, Lucas, Pensacola and Show Me
-- Design. The others stay visible proposals until their intents are set.
--
-- Source: the selection that already exists, keywords.is_tracked, which
-- normalize_tracked_keywords (0033) keeps at the top 50 active keywords per
-- client (money, then priority, then volume) for the weekly rank checks Tom
-- chose on Sept 13 2026. No other selected list exists; the only recorded
-- keyword approval (Show Me Electrical, Sept 2 2026) covers a 24-term list.
-- Two clients differ, both prepared for Tom's review (Executive OS task
-- 3ab519f3, message 4baa55f4):
--
--   BHG Safety Partners — not here: multi-brand clients get one list per
--     site (Tom, Oct 27: 50 per site), seeded by bhg-core-keyword-lists-v1-proposed.sql.
--   Show Me Electrical — its 48 tracked keywords plus two researched
--     additions, each mapped to an approved service (DataForSEO, St. Louis,
--     Oct 27 2026): "ev charger installation" (20/mo) and "electrical panel
--     upgrade" (20/mo). No emergency term.
--
-- Re-running is a no-op: a client that already has any list is skipped.
with proposal as (
  select k.client_id, k.id as keyword_id from keywords k
  where k.is_active and k.is_tracked
    and not exists (select 1 from client_brand_workspaces w where w.client_id = k.client_id)
  union all
  select '9a8e05f5-3d28-4839-9735-79bcdd0e277d'::uuid, k.id from keywords k
  where k.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d' and k.is_active
    and lower(k.keyword) in ('ev charger installation', 'electrical panel upgrade')
)
insert into core_keyword_lists (client_id, keyword_ids, source_ref)
select c.id, p.ids,
  case
    when c.id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d' then 'keywords.is_tracked (48) + 2 researched additions (DataForSEO St. Louis, Oct 27 2026)'
    else 'keywords.is_tracked as of ' || to_char(now() at time zone 'America/Chicago', 'YYYY-MM-DD') || ' (normalize_tracked_keywords, 0033)'
  end || '. Proposed for approval: executive_os:task/3ab519f3-27bd-416c-a3f1-219b285462c3'
from clients c
cross join lateral (
  select array_agg(distinct p.keyword_id) as ids from proposal p where p.client_id = c.id
) p
where c.status in ('active', 'launching')
  and not exists (select 1 from client_brand_workspaces w where w.client_id = c.id)
  and cardinality(p.ids) between 1 and 50
  and not exists (select 1 from core_keyword_lists l where l.client_id = c.id);
