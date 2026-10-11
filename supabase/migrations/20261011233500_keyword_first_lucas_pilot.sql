-- Keyword-first campaigns: Lucas Holiday Lighting pilot.
--
-- This migration does four governed data corrections:
-- 1) reconciles the approved lighting services to their live owner pages;
-- 2) maps the Christmas/holiday keyword cluster to those services/pages and
--    corrects the known navigational intent error;
-- 3) records current client-owned website evidence as sourced claims; and
-- 4) withdraws, corrects and re-submits the existing ten Christmas Facebook
--    drafts in place. Their exact assets remain untouched, nothing is approved,
--    scheduled or published, and the obsolete v1 drafter-run link is cleared.
--
-- It also exposes keyword competition to the Authority input so keyword-first
-- ranking can use priority, owner role, money/tracked status, volume, CPC and
-- competition.

-- ── 1. Owner pages ──────────────────────────────────────────────────────────
update services
set page_url = 'https://lucasconstructionmo.com/lighting'
where id = '269dbe4a-7870-4293-a564-a2e02a16b32a'
  and client_id = '102d3b20-2795-44ae-bd64-d1e43916291c';

update services
set page_url = 'https://lucasconstructionmo.com/christmas-lights'
where id = 'c82e9fe9-e7c0-4768-ab6e-3dc1ba717b2e'
  and client_id = '102d3b20-2795-44ae-bd64-d1e43916291c';

update services
set page_url = 'https://lucasconstructionmo.com/permanent-holiday-lights'
where id = 'ae2f28f0-38d4-41e0-9f30-b029724665d8'
  and client_id = '102d3b20-2795-44ae-bd64-d1e43916291c';

-- ── 2. Keyword cluster ──────────────────────────────────────────────────────
-- Seasonal Christmas lighting. Location approval remains a separate Authority
-- gate; mapping a keyword to the right service/page does not approve a market.
update keywords
set service_id = 'c82e9fe9-e7c0-4768-ab6e-3dc1ba717b2e',
    target_url = 'https://lucasconstructionmo.com/christmas-lights',
    intent = case
      when id = '1403b969-1773-4889-8c6f-d7f2e212dec8' then 'transactional'
      when id = '59204363-a26f-4bbe-8590-56cb576d2b55' then 'navigational'
      else 'commercial'
    end,
    intent_note = case
      when id = '1403b969-1773-4889-8c6f-d7f2e212dec8'
        then 'Keyword-first pilot: explicit near-me installation demand; transactional.'
      when id = '59204363-a26f-4bbe-8590-56cb576d2b55'
        then 'Keyword-first pilot: brand + service query; intentionally navigational.'
      else 'Keyword-first pilot: service/provider discovery query; commercial.'
    end
where client_id = '102d3b20-2795-44ae-bd64-d1e43916291c'
  and id = any (array[
    '1403b969-1773-4889-8c6f-d7f2e212dec8'::uuid,
    'b2932e62-a74b-44c1-81fd-5831e6da662b'::uuid,
    'dd0653c4-58be-4640-a31f-aa3894bde601'::uuid,
    'c171fb7c-51f3-47ed-8bbe-0625c905233f'::uuid,
    '4d8cab10-6728-4554-995d-16f4ea5ff912'::uuid,
    '748cb0f9-74de-4205-824f-dbf80d73e701'::uuid,
    'bd274f0d-81a4-48ad-9912-8286a6c87c7b'::uuid,
    '2d1bcbce-1e3e-4f79-a32d-f29ae4e5f0ed'::uuid,
    'be2fcf6b-de57-4c1b-8664-8fb43115dd71'::uuid,
    'c645b7d7-81af-42d9-afcc-ace190a450b9'::uuid,
    'b3f689a3-a4e6-4844-8f3f-8b020c4a1ef6'::uuid,
    '300ce96c-4069-423e-b13f-4dbc05c46caf'::uuid,
    '7f231ac3-6385-454e-a673-0a5e5dc6afa1'::uuid,
    '59204363-a26f-4bbe-8590-56cb576d2b55'::uuid,
    '4e07249e-85e1-4c2d-8e78-4f1094fe0baa'::uuid,
    '6079bf7f-f396-460a-a8f7-d08e79fac4dc'::uuid,
    '320543cf-10ec-4087-b82c-56f4ffdac7e9'::uuid,
    '142e9fe6-da95-4a8e-bd20-fe14dd8b4e26'::uuid,
    '8296bfc1-d8e4-4065-be8f-1fc566117f1f'::uuid
  ]);

-- Permanent Christmas-light terms belong to the approved permanent service,
-- not the seasonal page.
update keywords
set service_id = 'ae2f28f0-38d4-41e0-9f30-b029724665d8',
    target_url = 'https://lucasconstructionmo.com/permanent-holiday-lights',
    intent = 'commercial',
    intent_note = 'Keyword-first pilot: permanent-lighting provider discovery query; commercial.'
where client_id = '102d3b20-2795-44ae-bd64-d1e43916291c'
  and id = any (array[
    'f4f0d87c-ae2a-4292-ae6f-8b45ef5398ea'::uuid,
    'faad1cb6-20c9-45e1-ad15-c4b3cebdaa6a'::uuid,
    '4b08887a-f1db-4de3-b009-89ef6bfa78a3'::uuid
  ]);

-- Preserve any existing support set while making the seasonal cluster explicit.
update page_groups
set supporting_keyword_ids = (
  select array_agg(distinct x order by x)
  from unnest(
    coalesce(supporting_keyword_ids, '{}'::uuid[]) || array[
      'b2932e62-a74b-44c1-81fd-5831e6da662b'::uuid,
      'dd0653c4-58be-4640-a31f-aa3894bde601'::uuid,
      'c171fb7c-51f3-47ed-8bbe-0625c905233f'::uuid,
      '4d8cab10-6728-4554-995d-16f4ea5ff912'::uuid,
      '748cb0f9-74de-4205-824f-dbf80d73e701'::uuid,
      'bd274f0d-81a4-48ad-9912-8286a6c87c7b'::uuid,
      '2d1bcbce-1e3e-4f79-a32d-f29ae4e5f0ed'::uuid,
      'be2fcf6b-de57-4c1b-8664-8fb43115dd71'::uuid,
      'c645b7d7-81af-42d9-afcc-ace190a450b9'::uuid,
      'b3f689a3-a4e6-4844-8f3f-8b020c4a1ef6'::uuid,
      '300ce96c-4069-423e-b13f-4dbc05c46caf'::uuid,
      '7f231ac3-6385-454e-a673-0a5e5dc6afa1'::uuid,
      '59204363-a26f-4bbe-8590-56cb576d2b55'::uuid,
      '4e07249e-85e1-4c2d-8e78-4f1094fe0baa'::uuid,
      '6079bf7f-f396-460a-a8f7-d08e79fac4dc'::uuid,
      '320543cf-10ec-4087-b82c-56f4ffdac7e9'::uuid,
      '142e9fe6-da95-4a8e-bd20-fe14dd8b4e26'::uuid,
      '8296bfc1-d8e4-4065-be8f-1fc566117f1f'::uuid
    ]
  ) x
)
where id = '87f9deb8-7c6b-431e-ac3b-74bfd1b96cf3'
  and client_id = '102d3b20-2795-44ae-bd64-d1e43916291c';

-- ── 3. Current client-owned evidence ───────────────────────────────────────
-- The full migration sandbox has no production client rows. Skip the
-- client-specific seed there; production performs it when Lucas exists.
do $claims$
begin
  if exists (select 1 from clients where id = '102d3b20-2795-44ae-bd64-d1e43916291c') then
    insert into claims (id, client_id, claim, status, source)
    values
  (
    '6a797f3c-e6f8-4ee0-926f-a1cbb7a5c801',
    '102d3b20-2795-44ae-bd64-d1e43916291c',
    'Lucas Construction offers professional holiday lighting installation in Wentzville, Missouri.',
    'sourced',
    'https://lucasconstructionmo.com/christmas-lights'
  ),
  (
    '53d8be8c-5d8a-4b39-a18e-5ead9ff2d902',
    '102d3b20-2795-44ae-bd64-d1e43916291c',
    'Holiday lighting layouts can include rooflines and ridges, trees and yard lighting, garland, wreaths, and entryways.',
    'sourced',
    'https://lucasconstructionmo.com/christmas-lights'
  ),
  (
    'f4a4d386-b83b-4df7-aefe-c588ccca0f03',
    '102d3b20-2795-44ae-bd64-d1e43916291c',
    'The holiday lighting quote process includes walking the property, taking measurements, and talking through the desired look.',
    'sourced',
    'https://lucasconstructionmo.com/christmas-lights'
  ),
  (
    '5bfbc4d7-08f6-4e6d-bf44-76a035657604',
    '102d3b20-2795-44ae-bd64-d1e43916291c',
    'The holiday lighting installation calendar runs October and November, and prime dates can fill early.',
    'sourced',
    'https://lucasconstructionmo.com/christmas-lights'
  )
on conflict (id) do update
    set claim = excluded.claim,
        status = excluded.status,
        source = excluded.source;
  end if;
end
$claims$;

-- ── 4. Correct the existing ten posts in place ─────────────────────────────
-- Use the same governed post state machine the app uses: withdraw to draft,
-- change grounding while editable, then submit back to human review.
do $$
declare
  v_prev text := current_setting('compass.post_system', true);
  v_client constant uuid := '102d3b20-2795-44ae-bd64-d1e43916291c';
  v_posts constant uuid[] := array[
    'a643d847-f6e3-41ba-84bf-7bdf3a277fa0'::uuid,
    'b5d2cddd-60da-47b7-865a-395fb604ff3c'::uuid,
    '7ce0b892-1708-4232-8310-f2285106632d'::uuid,
    'eba50553-753b-4f91-93a1-b019ca82951d'::uuid,
    '15dd7594-fe7e-45e0-9653-951adbf8ad68'::uuid,
    'cedc3fe2-ea78-48ae-a113-d426895a3167'::uuid,
    'e6fb964c-0b6c-4932-832e-62b27ac76254'::uuid,
    '812a1fc2-5dc9-4d4f-8ee4-e312ed5e5232'::uuid,
    '7a1fcd69-38e0-4b0e-b4f0-714ec61a5c51'::uuid,
    '4b0b297f-8982-4ba5-8224-f6957671b583'::uuid
  ];
begin
  -- Empty schema/sandbox runs have no Lucas row and should remain a no-op.
  if not exists (select 1 from clients where id = v_client) then
    return;
  end if;

  perform set_config('compass.post_system', 'on', true);

  -- Abort instead of touching an unexpected lifecycle state.
  if (select count(*) from social_posts
      where client_id = v_client and id = any(v_posts)
        and review_status = 'in_review' and publish_status = 'not_scheduled') <> 10 then
    raise exception 'Lucas Christmas pilot expected ten in-review/not-scheduled posts';
  end if;

  update social_posts
  set review_status = 'draft'
  where client_id = v_client and id = any(v_posts);

  -- Old v1 links used a generic roofing claim. The new links below are the
  -- evidence the corrected keyword/service brief stands on.
  delete from post_claims
  where client_id = v_client and post_id = any(v_posts);

  update social_posts
  set search_intent = 'commercial',
      service_id = 'c82e9fe9-e7c0-4768-ab6e-3dc1ba717b2e',
      keyword_id = case id
        when 'a643d847-f6e3-41ba-84bf-7bdf3a277fa0'::uuid then '748cb0f9-74de-4205-824f-dbf80d73e701'::uuid
        when 'b5d2cddd-60da-47b7-865a-395fb604ff3c'::uuid then 'b2932e62-a74b-44c1-81fd-5831e6da662b'::uuid
        when '7ce0b892-1708-4232-8310-f2285106632d'::uuid then '6079bf7f-f396-460a-a8f7-d08e79fac4dc'::uuid
        when 'eba50553-753b-4f91-93a1-b019ca82951d'::uuid then '142e9fe6-da95-4a8e-bd20-fe14dd8b4e26'::uuid
        when '15dd7594-fe7e-45e0-9653-951adbf8ad68'::uuid then 'b3f689a3-a4e6-4844-8f3f-8b020c4a1ef6'::uuid
        when 'cedc3fe2-ea78-48ae-a113-d426895a3167'::uuid then '8296bfc1-d8e4-4065-be8f-1fc566117f1f'::uuid
        when 'e6fb964c-0b6c-4932-832e-62b27ac76254'::uuid then '320543cf-10ec-4087-b82c-56f4ffdac7e9'::uuid
        when '812a1fc2-5dc9-4d4f-8ee4-e312ed5e5232'::uuid then 'bd274f0d-81a4-48ad-9912-8286a6c87c7b'::uuid
        when '4b0b297f-8982-4ba5-8224-f6957671b583'::uuid then 'b2932e62-a74b-44c1-81fd-5831e6da662b'::uuid
        else keyword_id
      end,
      drafter_run_id = null,
      crm_facts_only = false
  where client_id = v_client
    and id = any(v_posts)
    and id <> '7a1fcd69-38e0-4b0e-b4f0-714ec61a5c51'::uuid;

  update social_posts
  set search_intent = 'transactional',
      service_id = 'c82e9fe9-e7c0-4768-ab6e-3dc1ba717b2e',
      keyword_id = '1403b969-1773-4889-8c6f-d7f2e212dec8',
      copy = 'Planning ahead helps if you want your Christmas lights up early in the season.\n\nLucas Construction''s holiday lighting installation calendar runs October and November, and prime dates can fill early. Reaching out sooner gives you more options for scheduling.\n\nIf you''d like your Wentzville home lit for the season, send us a message to request a quote.',
      drafter_run_id = null,
      crm_facts_only = false
  where client_id = v_client
    and id = '7a1fcd69-38e0-4b0e-b4f0-714ec61a5c51';

  -- Every post gets the service claim.
  insert into post_claims (post_id, claim_id, client_id)
  select p.id, '6a797f3c-e6f8-4ee0-926f-a1cbb7a5c801'::uuid, v_client
  from unnest(v_posts) p(id);

  -- Layout/scope support.
  insert into post_claims (post_id, claim_id, client_id)
  values
    ('a643d847-f6e3-41ba-84bf-7bdf3a277fa0', '53d8be8c-5d8a-4b39-a18e-5ead9ff2d902', v_client),
    ('15dd7594-fe7e-45e0-9653-951adbf8ad68', '53d8be8c-5d8a-4b39-a18e-5ead9ff2d902', v_client),
    ('cedc3fe2-ea78-48ae-a113-d426895a3167', 'f4a4d386-b83b-4df7-aefe-c588ccca0f03', v_client),
    ('7a1fcd69-38e0-4b0e-b4f0-714ec61a5c51', '5bfbc4d7-08f6-4e6d-bf44-76a035657604', v_client);

  -- Posts that explicitly mention Lucas's roofing/exterior work keep the
  -- existing sourced contractor claim as their second fact.
  insert into post_claims (post_id, claim_id, client_id)
  values
    ('7ce0b892-1708-4232-8310-f2285106632d', 'fc6e22d0-f704-43f8-b39b-24f8750ada61', v_client),
    ('e6fb964c-0b6c-4932-832e-62b27ac76254', 'fc6e22d0-f704-43f8-b39b-24f8750ada61', v_client),
    ('4b0b297f-8982-4ba5-8224-f6957671b583', 'fc6e22d0-f704-43f8-b39b-24f8750ada61', v_client);

  -- Re-submit through the review gate. This creates fresh review tasks and
  -- leaves every post in_review / not_scheduled.
  update social_posts
  set review_status = 'in_review'
  where client_id = v_client and id = any(v_posts);

  perform set_config('compass.post_system', coalesce(v_prev, ''), true);
exception when others then
  perform set_config('compass.post_system', coalesce(v_prev, ''), true);
  raise;
end $$;

-- ── 5. Authority keyword signals ────────────────────────────────────────────
create or replace function authority_input(p_client_id uuid) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
begin
  if not (coalesce((select is_team()), false)
          or (session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'service_role')) then
    raise exception 'Authority is team-only' using errcode = '42501';
  end if;
  return (select client_intelligence_input(p_client_id) || jsonb_build_object('authority', jsonb_build_object(
    'now', now(),
    'site', (select jsonb_build_object('url', coalesce(s.url, cl.website_url), 'content_paths', s.content_paths,
              'work_mode', s.work_mode, 'adapter', s.content_adapter)
             from clients cl left join sites s on s.client_id = cl.id where cl.id = p_client_id
             order by s.created_at limit 1),
    'pageGroupsFull', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'page_type', g.page_type,
              'status', g.status, 'city_tier', g.city_tier, 'target_url', g.target_url, 'primary_keyword_id', g.primary_keyword_id,
              'supporting_keyword_ids', g.supporting_keyword_ids) order by g.name, g.id)
             from page_groups g where g.client_id = p_client_id), '[]'::jsonb),
    'keywordExtras', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'volume', k.volume, 'cpc', k.cpc,
              'competition', k.competition, 'city', k.city) order by k.id)
             from keywords k where k.client_id = p_client_id), '[]'::jsonb),
    'moneyKeywordIds', coalesce((select jsonb_agg(m.keyword_id order by m.keyword_id) from money_keywords m where m.client_id = p_client_id), '[]'::jsonb),
    'gsc', coalesce((select jsonb_agg(jsonb_build_object('query', g.query, 'page', g.page, 'impressions', g.impressions,
              'clicks', g.clicks, 'avg_position', g.avg_position, 'period_start', g.period_start, 'period_end', g.period_end,
              'keyword_id', g.keyword_id) order by g.period_end, g.query, g.page)
             from gsc_snapshots g where g.client_id = p_client_id), '[]'::jsonb),
    'ranks', coalesce((select jsonb_agg(jsonb_build_object('keyword_id', r.keyword_id, 'result_type', r.result_type,
              'position', r.position, 'url_ranked', r.url_ranked, 'recorded_at', r.recorded_at) order by r.keyword_id, r.result_type)
             from (select distinct on (r.keyword_id, r.result_type) r.*
                   from rank_snapshots r join keywords k on k.id = r.keyword_id
                   where k.client_id = p_client_id
                   order by r.keyword_id, r.result_type, r.recorded_at desc) r), '[]'::jsonb),
    'socialPosts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'platform', p.platform, 'search_intent', p.search_intent,
              'service_id', p.service_id, 'keyword_id', p.keyword_id, 'review_status', p.review_status,
              'publish_status', p.publish_status, 'review_note', p.review_note, 'created_at', p.created_at,
              'reviewed_at', p.reviewed_at, 'drafter_run_id', p.drafter_run_id, 'copy', p.copy,
              'claim_ids', coalesce((select jsonb_agg(pc.claim_id order by pc.claim_id) from post_claims pc where pc.post_id = p.id), '[]'::jsonb))
              order by p.created_at, p.id)
             from social_posts p where p.client_id = p_client_id), '[]'::jsonb),
    'contentPosts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'status', p.status, 'url', p.url,
              'keyword_id', p.keyword_id, 'published_at', p.published_at) order by p.id)
             from content_posts p where p.client_id = p_client_id), '[]'::jsonb),
    'changeLog', coalesce((select jsonb_agg(jsonb_build_object('change_type', l.change_type, 'object_type', l.object_type,
              'status', l.status, 'after', l.after, 'created_at', l.created_at) order by l.created_at, l.id)
             from change_log l where l.client_id = p_client_id and l.change_type in ('page_added', 'page_rewrite')), '[]'::jsonb),
    'inventory', null
  )));
end $$;
