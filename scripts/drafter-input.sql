-- AI Drafter v1: the read-only input for scripts/drafter-dry-run.mjs.
-- One SELECT, no writes. Returns the canonical Client Intelligence rows for
-- one client as the DrafterInput JSON (supabase/functions/post-drafter/types.ts).
--
--   psql "$DATABASE_URL" -v client_id="'<uuid>'" -At -f scripts/drafter-input.sql > /tmp/input.json
--
-- (or paste it into the SQL editor with the uuid substituted for :client_id).
with c as (select :client_id::uuid as id)
select jsonb_build_object(
  'asOf', (now() at time zone 'America/Chicago')::date,
  'client', (select jsonb_build_object('id', id, 'name', name, 'phone', phone, 'website_url', website_url, 'city', city,
             'state', state, 'service_area', service_area, 'business_type', business_type, 'address_line1', address_line1)
             from clients where id = (select id from c)),
  'brand', (select jsonb_build_object('positioning', positioning, 'voice_tone', voice_tone, 'audience', audience,
            'differentiators', differentiators, 'ai_guidance', ai_guidance, 'words_we_use', words_we_use,
            'words_we_avoid', words_we_avoid, 'content_pillars', content_pillars, 'tagline', tagline)
            from client_brands where client_id = (select id from c)),
  'board', (select jsonb_build_object('id', id, 'version', version, 'status', status, 'hard_rules', hard_rules, 'standing_cta', standing_cta)
            from brand_boards where client_id = (select id from c) order by version desc limit 1),
  'services', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'status', status, 'page_url', page_url,
               'primary_keyword_id', primary_keyword_id, 'parent_service_id', parent_service_id, 'segment', segment) order by sort_order)
               from services where client_id = (select id from c)), '[]'),
  'keywords', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'keyword', keyword, 'intent', intent, 'intent_note', intent_note,
               'is_active', is_active, 'is_tracked', is_tracked, 'is_money', is_money, 'service_id', service_id,
               'target_url', target_url, 'priority', priority))
               from keywords where client_id = (select id from c)), '[]'),
  'claims', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'claim', claim, 'status', status, 'source', source) order by created_at, id)
             from claims where client_id = (select id from c)), '[]'),
  'locations', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'city', city, 'state', state, 'is_active', is_active))
                from locations where client_id = (select id from c)), '[]'),
  'assets', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'label', label, 'storage_path', storage_path))
             from brand_assets where client_id = (select id from c)), '[]'),
  'offers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'terms', terms, 'source', source, 'status', status,
             'starts_on', starts_on, 'ends_on', ends_on, 'confirmed_by', confirmed_by, 'confirmed_on', confirmed_on, 'service_id', service_id))
             from offers where client_id = (select id from c)), '[]'),
  'pageGroups', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'status', status, 'target_url', target_url,
                'primary_keyword_id', primary_keyword_id))
                from page_groups where client_id = (select id from c)), '[]')
) as input;
