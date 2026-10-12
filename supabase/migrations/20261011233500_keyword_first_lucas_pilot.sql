-- Keyword-first campaigns: Lucas Holiday Lighting pilot.
--
-- Production-specific rows are located by durable business keys (website,
-- service name, keyword text, page URL and approved asset label), never by
-- generated UUIDs. On a clean sandbox with no Lucas client, the data portion
-- is intentionally a no-op.
--
-- The migration:
--   1. reconciles the three approved lighting services to their owner pages;
--   2. maps the seasonal/permanent Christmas keyword clusters and fixes the
--      known "holiday lighting installation wentzville" intent error;
--   3. records narrow, current client-owned website evidence as sourced claims;
--   4. withdraws, corrects and re-submits the SAME ten Christmas Facebook
--      drafts, preserving their exact post_assets and leaving every post
--      in_review / not_scheduled; nothing is approved, scheduled or published;
--   5. exposes keyword competition to Authority input for campaign scoring.

do $pilot$
declare
  v_client uuid;
  v_seasonal_service uuid;
  v_permanent_service uuid;
  v_prev text := current_setting('compass.post_system', true);
  v_posts uuid[];
  v_service_claim uuid;
  v_layout_claim uuid;
  v_quote_claim uuid;
  v_calendar_claim uuid;
  v_contractor_claim uuid;
begin
  select id into v_client
  from clients
  where website_url in ('https://lucasconstructionmo.com', 'https://www.lucasconstructionmo.com')
  order by created_at
  limit 1;

  if v_client is not null then
    select id into strict v_seasonal_service
    from services
    where client_id = v_client and name = 'Holiday Lighting Installation';

    select id into strict v_permanent_service
    from services
    where client_id = v_client and name = 'Permanent & Landscape Lighting Installation';

    -- ── Owner pages ────────────────────────────────────────────────────────
    update services
    set page_url = case name
      when 'Holiday & Landscape Lighting' then 'https://lucasconstructionmo.com/lighting'
      when 'Holiday Lighting Installation' then 'https://lucasconstructionmo.com/christmas-lights'
      when 'Permanent & Landscape Lighting Installation' then 'https://lucasconstructionmo.com/permanent-holiday-lights'
      else page_url
    end
    where client_id = v_client
      and name in (
        'Holiday & Landscape Lighting',
        'Holiday Lighting Installation',
        'Permanent & Landscape Lighting Installation'
      );

    -- ── Keyword cluster ────────────────────────────────────────────────────
    update keywords
    set service_id = v_seasonal_service,
        target_url = 'https://lucasconstructionmo.com/christmas-lights',
        intent = case keyword
          when 'christmas light installation near me' then 'transactional'
          when 'lucas construction christmas lights' then 'navigational'
          else 'commercial'
        end,
        intent_note = case keyword
          when 'christmas light installation near me'
            then 'Keyword-first pilot: explicit near-me installation demand; transactional.'
          when 'lucas construction christmas lights'
            then 'Keyword-first pilot: brand + service query; intentionally navigational.'
          else 'Keyword-first pilot: service/provider discovery query; commercial.'
        end
    where client_id = v_client
      and keyword = any (array[
        'christmas light installation near me',
        'christmas light hanging service wentzville',
        'christmas light installation lake st louis',
        'christmas light installation st charles mo',
        'christmas light installation st louis',
        'christmas light installation wentzville',
        'christmas light installers near me',
        'christmas light removal wentzville',
        'christmas lights o''fallon mo',
        'commercial christmas light installation st louis',
        'holiday light installation wentzville',
        'holiday lighting company st charles county',
        'holiday lighting st peters mo',
        'lucas construction christmas lights',
        'outdoor christmas light installation st louis',
        'professional christmas light installation wentzville',
        'residential christmas light installation wentzville',
        'holiday lighting company wentzville mo',
        'holiday lighting installation wentzville'
      ]::text[]);

    update keywords
    set service_id = v_permanent_service,
        target_url = 'https://lucasconstructionmo.com/permanent-holiday-lights',
        intent = 'commercial',
        intent_note = 'Keyword-first pilot: permanent-lighting provider discovery query; commercial.'
    where client_id = v_client
      and keyword = any (array[
        'permanent christmas lights st louis',
        'permanent christmas lights wentzville',
        'permanent holiday lighting st charles mo'
      ]::text[]);

    -- The approved seasonal owner page explicitly governs the whole support set.
    update page_groups g
    set supporting_keyword_ids = (
      select array_agg(distinct x order by x)
      from unnest(
        coalesce(g.supporting_keyword_ids, '{}'::uuid[]) ||
        coalesce((
          select array_agg(k.id order by k.id)
          from keywords k
          where k.client_id = v_client
            and k.service_id = v_seasonal_service
            and k.keyword <> 'christmas light installation near me'
            and k.target_url = 'https://lucasconstructionmo.com/christmas-lights'
        ), '{}'::uuid[])
      ) x
    )
    where g.client_id = v_client
      and g.target_url = 'https://lucasconstructionmo.com/christmas-lights'
      and g.status = 'approved';

    -- ── Current client-owned evidence ──────────────────────────────────────
    update claims
    set status = 'sourced', source = 'https://lucasconstructionmo.com/christmas-lights'
    where client_id = v_client and claim = any (array[
      'Lucas Construction offers professional holiday lighting installation in Wentzville, Missouri.',
      'Holiday lighting layouts can include rooflines and ridges, trees and yard lighting, garland, wreaths, and entryways.',
      'The holiday lighting quote process includes walking the property, taking measurements, and talking through the desired look.',
      'The holiday lighting installation calendar runs October and November, and prime dates can fill early.'
    ]::text[]);

    insert into claims (client_id, claim, status, source)
    select v_client, x.claim, 'sourced', 'https://lucasconstructionmo.com/christmas-lights'
    from unnest(array[
      'Lucas Construction offers professional holiday lighting installation in Wentzville, Missouri.',
      'Holiday lighting layouts can include rooflines and ridges, trees and yard lighting, garland, wreaths, and entryways.',
      'The holiday lighting quote process includes walking the property, taking measurements, and talking through the desired look.',
      'The holiday lighting installation calendar runs October and November, and prime dates can fill early.'
    ]::text[]) x(claim)
    where not exists (
      select 1 from claims c where c.client_id = v_client and c.claim = x.claim
    );

    select id into strict v_service_claim from claims
      where client_id=v_client and claim='Lucas Construction offers professional holiday lighting installation in Wentzville, Missouri.'
      order by created_at limit 1;
    select id into strict v_layout_claim from claims
      where client_id=v_client and claim='Holiday lighting layouts can include rooflines and ridges, trees and yard lighting, garland, wreaths, and entryways.'
      order by created_at limit 1;
    select id into strict v_quote_claim from claims
      where client_id=v_client and claim='The holiday lighting quote process includes walking the property, taking measurements, and talking through the desired look.'
      order by created_at limit 1;
    select id into strict v_calendar_claim from claims
      where client_id=v_client and claim='The holiday lighting installation calendar runs October and November, and prime dates can fill early.'
      order by created_at limit 1;
    select id into strict v_contractor_claim from claims
      where client_id=v_client and claim='Roofing, siding, guttering, fascia and soffit contractor'
      order by created_at limit 1;

    -- ── The existing ten posts, located by their exact approved asset labels ─
    select array_agg(distinct sp.id order by sp.id) into v_posts
    from social_posts sp
    join post_assets pa on pa.post_id=sp.id and pa.client_id=sp.client_id
    join brand_assets ba on ba.id=pa.brand_asset_id and ba.client_id=sp.client_id
    where sp.client_id=v_client
      and ba.label = any (array[
        'xmas-01-season-is-here-wentzville-ranch',
        'xmas-02-save-your-weekend-wentzville-two-story',
        'xmas-03-stay-off-ladder-wentzville-three-car',
        'xmas-04-clean-professional-holiday-look',
        'xmas-05-make-home-merry-bright-wentzville-ranch',
        'xmas-06-brighten-neighborhood-wentzville-two-story',
        'xmas-07-why-homeowners-hire-it-out',
        'xmas-08-hosting-for-the-holidays',
        'xmas-09-schedule-early-for-the-holidays',
        'xmas-10-enjoy-season-skip-hassle'
      ]::text[]);

    if coalesce(cardinality(v_posts), 0) <> 10 then
      raise exception 'Lucas Christmas pilot expected exactly ten posts, found %', coalesce(cardinality(v_posts),0);
    end if;
    if (select count(*) from social_posts
        where client_id=v_client and id=any(v_posts)
          and review_status='in_review' and publish_status='not_scheduled') <> 10 then
      raise exception 'Lucas Christmas pilot expected ten in-review/not-scheduled posts';
    end if;

    perform set_config('compass.post_system', 'on', true);

    -- Keep the lifecycle transition governed: withdraw to editable draft.
    update social_posts set review_status='draft'
    where client_id=v_client and id=any(v_posts);

    -- These ten records were produced by Drafter v1. Its immutable run/link
    -- triggers correctly refuse retroactive changes. This one-time migration
    -- temporarily disables ONLY those two AI-immutability triggers while the
    -- posts are drafts. 0045's lifecycle/grounding/link guards stay enabled,
    -- post_assets is never touched, and PostgreSQL rolls the ALTER TABLE
    -- changes back too if any later statement fails.
    alter table social_posts disable trigger social_posts_ab_drafter;
    alter table post_claims disable trigger post_claims_drafter_guard;

    delete from post_claims
    where client_id=v_client and post_id=any(v_posts);

    -- Ground each existing post from its exact approved graphic label.
    with map(asset_label, keyword_text, intent) as (
      values
        ('xmas-01-season-is-here-wentzville-ranch', 'christmas light installation wentzville', 'commercial'),
        ('xmas-02-save-your-weekend-wentzville-two-story', 'christmas light hanging service wentzville', 'commercial'),
        ('xmas-03-stay-off-ladder-wentzville-three-car', 'professional christmas light installation wentzville', 'commercial'),
        ('xmas-04-clean-professional-holiday-look', 'holiday lighting company wentzville mo', 'commercial'),
        ('xmas-05-make-home-merry-bright-wentzville-ranch', 'holiday light installation wentzville', 'commercial'),
        ('xmas-06-brighten-neighborhood-wentzville-two-story', 'holiday lighting installation wentzville', 'commercial'),
        ('xmas-07-why-homeowners-hire-it-out', 'residential christmas light installation wentzville', 'commercial'),
        ('xmas-08-hosting-for-the-holidays', 'christmas light installers near me', 'commercial'),
        ('xmas-09-schedule-early-for-the-holidays', 'christmas light installation near me', 'transactional'),
        ('xmas-10-enjoy-season-skip-hassle', 'christmas light hanging service wentzville', 'commercial')
    ),
    targets as (
      select sp.id as post_id, m.intent, k.id as keyword_id, m.asset_label
      from map m
      join brand_assets ba on ba.client_id=v_client and ba.label=m.asset_label
      join post_assets pa on pa.client_id=v_client and pa.brand_asset_id=ba.id
      join social_posts sp on sp.id=pa.post_id and sp.client_id=v_client
      join keywords k on k.client_id=v_client and k.keyword=m.keyword_text
    )
    update social_posts sp
    set search_intent=t.intent,
        service_id=v_seasonal_service,
        keyword_id=t.keyword_id,
        drafter_run_id=null,
        crm_facts_only=false,
        copy=case when t.asset_label='xmas-09-schedule-early-for-the-holidays' then
          'Planning ahead helps if you want your Christmas lights up early in the season.\n\nLucas Construction''s holiday lighting installation calendar runs October and November, and prime dates can fill early. Reaching out sooner gives you more options for scheduling.\n\nIf you''d like your Wentzville home lit for the season, send us a message to request a quote.'
          else sp.copy end
    from targets t
    where sp.id=t.post_id;

    -- Every migrated post stands on the current service claim.
    insert into post_claims (post_id, claim_id, client_id)
    select id, v_service_claim, v_client
    from social_posts where client_id=v_client and id=any(v_posts);

    -- Add the second claim only where the copy needs it.
    insert into post_claims (post_id, claim_id, client_id)
    select distinct sp.id,
      case
        when ba.label in ('xmas-01-season-is-here-wentzville-ranch','xmas-05-make-home-merry-bright-wentzville-ranch') then v_layout_claim
        when ba.label='xmas-06-brighten-neighborhood-wentzville-two-story' then v_quote_claim
        when ba.label='xmas-09-schedule-early-for-the-holidays' then v_calendar_claim
        when ba.label in ('xmas-03-stay-off-ladder-wentzville-three-car','xmas-07-why-homeowners-hire-it-out','xmas-10-enjoy-season-skip-hassle') then v_contractor_claim
      end,
      v_client
    from social_posts sp
    join post_assets pa on pa.post_id=sp.id and pa.client_id=sp.client_id
    join brand_assets ba on ba.id=pa.brand_asset_id and ba.client_id=sp.client_id
    where sp.client_id=v_client and sp.id=any(v_posts)
      and ba.label in (
        'xmas-01-season-is-here-wentzville-ranch',
        'xmas-03-stay-off-ladder-wentzville-three-car',
        'xmas-05-make-home-merry-bright-wentzville-ranch',
        'xmas-06-brighten-neighborhood-wentzville-two-story',
        'xmas-07-why-homeowners-hire-it-out',
        'xmas-09-schedule-early-for-the-holidays',
        'xmas-10-enjoy-season-skip-hassle'
      );

    -- Restore the AI immutability boundary before these posts leave draft.
    alter table post_claims enable trigger post_claims_drafter_guard;
    alter table social_posts enable trigger social_posts_ab_drafter;

    -- Governed transition back to human review. This opens fresh review tasks.
    update social_posts set review_status='in_review'
    where client_id=v_client and id=any(v_posts);

    perform set_config('compass.post_system', coalesce(v_prev,''), true);
  end if;
exception when others then
  perform set_config('compass.post_system', coalesce(v_prev,''), true);
  raise;
end
$pilot$;

-- ── Authority keyword scoring signals ───────────────────────────────────────
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
