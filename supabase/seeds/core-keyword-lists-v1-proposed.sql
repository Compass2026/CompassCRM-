-- PROVISIONAL — NOT APPLIED. Run only after migration 20261027160000 is
-- reviewed, accepted and applied (PR #192).
--
-- Proposes core keyword list v1 for every active or launching client. The
-- rows are PROPOSALS (status 'proposed'): nothing here approves a list,
-- deletes or untracks a keyword, or touches an existing draft or
-- publication. Until a signed-in teammate approves a client's list
-- (Keywords tab › Core keyword list), the weekly path drafts nothing for that
-- client and says so in delivery_queue_log.
--
-- Source: the selection that already exists, keywords.is_tracked, which
-- normalize_tracked_keywords (0033) keeps at the top 50 active keywords per
-- client (money, then priority, then volume) for the weekly rank checks Tom
-- chose on Sept 13 2026. No other selected list exists; the only recorded
-- keyword approval (Show Me Electrical, Sept 2 2026) covers a 24-term list.
-- Two clients differ, both prepared for Tom's review (Executive OS task
-- 3ab519f3, message 4baa55f4):
--
--   BHG Safety Partners — one shared 50 across its three site programs,
--     rebalanced so no site is starved. The tracked 50 gave Safety 35,
--     Forklift 11, Heavy Equipment 0 and 4 generic terms with no service
--     (no owner page, so they cannot anchor content). Proposed: every active
--     Heavy Equipment keyword (4, all its research has), every active
--     Forklift keyword (15), and the best 31 Safety keywords — first the
--     best keyword of each Safety service, then by intent, money, priority
--     and volume. A separate 50 per site (150) is Tom's decision and needs
--     new research for Heavy (+46) and Forklift (+35); it is not proposed.
--   Show Me Electrical — its 48 tracked keywords plus two researched
--     additions, each mapped to an approved service (DataForSEO, St. Louis,
--     Oct 27 2026): "ev charger installation" (20/mo) and "electrical panel
--     upgrade" (20/mo). No emergency term.
--
-- Re-running is a no-op: a client that already has any list is skipped.
with bhg as (select '3eaa3389-2a33-4004-837c-8aef90404410'::uuid as id),
bhg_kw as (
  select k.*, w.name as site
  from keywords k
  join client_brand_workspaces w on w.client_id = k.client_id and k.service_id = any(w.service_ids)
  where k.client_id = (select id from bhg) and k.is_active
),
bhg_other as (select id from bhg_kw where site <> 'BHG Safety Partners'),
bhg_safety as (
  select id,
         row_number() over (partition by service_id order by (intent is not null) desc, is_money desc, priority, volume desc nulls last, created_at) as svc_rank,
         row_number() over (order by (intent is not null) desc, is_money desc, priority, volume desc nulls last, created_at) as overall
  from bhg_kw where site = 'BHG Safety Partners'
),
bhg_pick as (
  select id from bhg_other
  union all
  select id from (select id, row_number() over (order by (svc_rank = 1) desc, overall) as r from bhg_safety) s
  where r <= 50 - (select count(*) from bhg_other)
),
sme_add as (
  select k.id from keywords k
  where k.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d' and k.is_active
    and lower(k.keyword) in ('ev charger installation', 'electrical panel upgrade')
),
proposal as (
  select (select id from bhg) as client_id, id as keyword_id from bhg_pick
  union all
  select k.client_id, k.id from keywords k
  where k.is_active and k.is_tracked and k.client_id <> (select id from bhg)
  union all
  select '9a8e05f5-3d28-4839-9735-79bcdd0e277d'::uuid, id from sme_add
)
insert into core_keyword_lists (client_id, keyword_ids, source_ref)
select c.id, p.ids,
  case
    when c.id = (select id from bhg) then 'BHG shared 50 rebalanced across Safety / Forklift / Heavy Equipment (all Heavy and Forklift keywords + best Safety per service)'
    when c.id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d' then 'keywords.is_tracked (48) + 2 researched additions (DataForSEO St. Louis, Oct 27 2026)'
    else 'keywords.is_tracked as of ' || to_char(now() at time zone 'America/Chicago', 'YYYY-MM-DD') || ' (normalize_tracked_keywords, 0033)'
  end || '. Proposed for approval: executive_os:task/3ab519f3-27bd-416c-a3f1-219b285462c3'
from clients c
cross join lateral (
  select array_agg(distinct p.keyword_id) as ids from proposal p where p.client_id = c.id
) p
where c.status in ('active', 'launching')
  and cardinality(p.ids) between 1 and 50
  and not exists (select 1 from core_keyword_lists l where l.client_id = c.id);
