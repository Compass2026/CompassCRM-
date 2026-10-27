-- PROVISIONAL — NOT APPLIED. Run only after migration 20261027160000 is
-- reviewed, accepted and applied (PR #192).
--
-- Proposes core keyword list v1 for every active or launching client from the
-- selection that already exists: the keywords marked is_tracked, which
-- normalize_tracked_keywords (0033) keeps at the top 50 active keywords per
-- client (money first, then priority, then volume) for the weekly rank checks
-- Tom chose on Sept 13 2026. No other selected list exists in the CRM: the
-- Keyword Research stages record research, and the only recorded approval
-- (Show Me Electrical, Sept 2 2026) covers a 24-term list, not the current one.
--
-- These rows are PROPOSALS (status 'proposed'). Nothing here approves a list,
-- picks a different 50, deletes or untracks a keyword, or touches an existing
-- draft or publication. Until a signed-in teammate approves a client's list
-- (Keywords tab › Core keyword list), the weekly path drafts nothing for that
-- client and says so in delivery_queue_log.
--
-- BHG: one client list (its 50 tracked keywords); each brand site's scope is
-- the members whose service belongs to that site. No 150-keyword commitment.
--
-- Re-running is a no-op: a client that already has any list is skipped.
insert into core_keyword_lists (client_id, keyword_ids, source_ref)
select c.id, k.ids,
  'keywords.is_tracked as of ' || to_char(now() at time zone 'America/Chicago', 'YYYY-MM-DD')
    || ' (normalize_tracked_keywords, 0033; ' || cardinality(k.ids) || ' keywords). Proposed for approval: '
    || 'executive_os:task/3ab519f3-27bd-416c-a3f1-219b285462c3#message/75f8694b-6253-4583-8cec-dd37db47e624'
from clients c
cross join lateral (
  select array_agg(k.id order by k.is_money desc, k.priority, k.volume desc nulls last, k.created_at) as ids
  from keywords k where k.client_id = c.id and k.is_active and k.is_tracked
) k
where c.status in ('active', 'launching')
  and cardinality(k.ids) between 1 and 50
  and not exists (select 1 from core_keyword_lists l where l.client_id = c.id);
