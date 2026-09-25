-- Authority Engine v1 input: read-only. One SELECT; writes nothing.
--
--   psql "$DB" -v client_id=<client uuid> -At -f scripts/authority-input.sql > authority-input.json
--
-- The canonical Client Intelligence loader (migration 0047, the same read the
-- Intelligence tab and post-drafter make) plus the `authority` section: full
-- page groups, keyword volumes, money keywords, every Search Console row
-- (the engine keeps the latest window), the latest rank per keyword and
-- result type, posts with their linked claims, content posts, change_log
-- page proposals and the site's recorded content contract. The site
-- inventory is added by scripts/site-inventory.mjs; the dry run merges both.
-- Once migration 0048 is applied, `select authority_input('<uuid>')` is the
-- same read (arrays in a fixed order; the engine's result is identical).
with c as (select :'client_id'::uuid as id)
select client_intelligence_input(c.id) || jsonb_build_object('authority', jsonb_build_object(
  'now', now(),
  'site', (select jsonb_build_object('url', coalesce(s.url, cl.website_url), 'content_paths', s.content_paths,
            'work_mode', s.work_mode, 'adapter', s.content_adapter)
           from clients cl left join sites s on s.client_id = cl.id where cl.id = c.id
           order by s.created_at limit 1),
  'pageGroupsFull', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'page_type', g.page_type,
            'status', g.status, 'city_tier', g.city_tier, 'target_url', g.target_url, 'primary_keyword_id', g.primary_keyword_id,
            'supporting_keyword_ids', g.supporting_keyword_ids) order by g.name)
           from page_groups g where g.client_id = c.id), '[]'::jsonb),
  'keywordExtras', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'volume', k.volume, 'cpc', k.cpc, 'city', k.city))
           from keywords k where k.client_id = c.id), '[]'::jsonb),
  'moneyKeywordIds', coalesce((select jsonb_agg(m.keyword_id) from money_keywords m where m.client_id = c.id), '[]'::jsonb),
  'gsc', coalesce((select jsonb_agg(jsonb_build_object('query', g.query, 'page', g.page, 'impressions', g.impressions,
            'clicks', g.clicks, 'avg_position', g.avg_position, 'period_start', g.period_start, 'period_end', g.period_end,
            'keyword_id', g.keyword_id))
           from gsc_snapshots g where g.client_id = c.id), '[]'::jsonb),
  'ranks', coalesce((select jsonb_agg(jsonb_build_object('keyword_id', r.keyword_id, 'result_type', r.result_type,
            'position', r.position, 'url_ranked', r.url_ranked, 'recorded_at', r.recorded_at))
           from (select distinct on (r.keyword_id, r.result_type) r.*
                 from rank_snapshots r join keywords k on k.id = r.keyword_id
                 where k.client_id = c.id
                 order by r.keyword_id, r.result_type, r.recorded_at desc) r), '[]'::jsonb),
  'socialPosts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'platform', p.platform, 'search_intent', p.search_intent,
            'service_id', p.service_id, 'keyword_id', p.keyword_id, 'review_status', p.review_status,
            'publish_status', p.publish_status, 'review_note', p.review_note, 'created_at', p.created_at,
            'reviewed_at', p.reviewed_at, 'drafter_run_id', p.drafter_run_id, 'copy', p.copy,
            'claim_ids', coalesce((select jsonb_agg(pc.claim_id) from post_claims pc where pc.post_id = p.id), '[]'::jsonb))
            order by p.created_at)
           from social_posts p where p.client_id = c.id), '[]'::jsonb),
  'contentPosts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'status', p.status, 'url', p.url,
            'keyword_id', p.keyword_id, 'published_at', p.published_at))
           from content_posts p where p.client_id = c.id), '[]'::jsonb),
  'changeLog', coalesce((select jsonb_agg(jsonb_build_object('change_type', l.change_type, 'object_type', l.object_type,
            'status', l.status, 'after', l.after, 'created_at', l.created_at) order by l.created_at)
           from change_log l where l.client_id = c.id and l.change_type in ('page_added', 'page_rewrite')), '[]'::jsonb),
  'inventory', null
)) as input
from c;
