-- Show Me Electrical — Foundation load.
-- Sources: "Service Taxonomy, Keyword Map & Tracked List v1.1" (approved 2026-09-02,
-- Drive › Compass Clients › Show Me Electrical › 03 Keywords) for PB1 + PB3, and the
-- Brand Board draft of 2026-09-01 (02 Brand) for PB2.
--
-- Data script, not a migration. Idempotent: ids are uuid5 of
-- 'show-me-electrical:<table>:<key>' (DNS namespace) and every statement upserts.
-- Run against the remote project through the Supabase MCP after a rolled-back
-- dry run. It references tasks.key, which exists remotely (brand-board branch).

-- ── Client record ─────────────────────────────────────────────────────────
-- Address is published on showmeelectrical.com, so it is fine to store.
update clients set
  industry      = coalesce(industry, 'Electrical contractor'),
  vertical      = coalesce(vertical, 'electrical'),
  phone         = coalesce(phone, '314-571-9756'),
  address_line1 = coalesce(address_line1, '5602 Heege Rd'),
  city          = coalesce(city, 'Affton'),
  state         = coalesce(state, 'MO'),
  zip           = coalesce(zip, '63123'),
  drive_folders = jsonb_build_object(
    'root',          '1_V3hAp-nraG5AZqVjO9FN0BPUNhNc7Yz',
    '01 Onboarding', '1uZmpVC-y8uZsV9JxwAHJbxnASm6Ng8Ts',
    '02 Brand',      '1Jqkcfi2NFXf4l0fg2zcfia3ebPAVlu4g',
    '03 Keywords',   '1U9HESwwq7s7D3F163xhYO2i87hpaQdGy',
    '04 Website',    '1K3byO2lcGGuRM3j_mEWVgyl8NXwVxP9D',
    '05 Reports',    '1_2RQz91e7eEmemJ5L7TQ01vsZqwHQPtg',
    'Media',         '1-hb5yzDdaY_DUMAlR97pURozTr-q3yvD')
where id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d';

insert into client_contacts (id, client_id, name, role, email, phone, is_primary)
values (uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:client_contacts:dan'),
        '9a8e05f5-3d28-4839-9735-79bcdd0e277d', 'Dan', 'Owner, Master Electrician',
        'info@showmeelectrical.com', '314-571-9756', true)
on conflict (id) do update set role = excluded.role, email = excluded.email,
  phone = excluded.phone, is_primary = excluded.is_primary;

-- ── Keywords (PB3) ────────────────────────────────────────────────────────
-- Volumes / CPC are St. Louis metro, DataForSEO, September 2026, as printed in
-- the approved map ("low" = null, "<10" and "~10" = 10). is_tracked marks the
-- approved 24-term tracked list; existing BrightLocal rows keep their flag.
insert into keywords (id, client_id, keyword, priority, department, is_active,
                      volume, cpc, intent, source, last_checked, is_tracked)
select uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:keywords:' || k.keyword),
       '9a8e05f5-3d28-4839-9735-79bcdd0e277d', k.keyword, k.priority::keyword_priority,
       'seo', true, k.volume, k.cpc, 'commercial', 'dataforseo', '2026-09-02', k.tracked
from (values
  -- money keywords (P1)
  ('electrician near me',                 'p1', 720, 31.00, true),
  ('electrician st louis',                'p1', 260, 17.00, true),
  ('st louis electrician',                'p1', null, null, true),
  ('emergency electrician st louis',      'p1', 20,  47.00, true),
  ('electrical panel upgrade st louis',   'p1', 10,  null, true),
  ('commercial electrician st louis',     'p1', 10,  30.00, true),
  -- additional metro terms on the tracked list
  ('st louis electricians',               'p2', null, null, true),
  ('electrical contractor st louis',      'p2', null, null, true),
  ('electrical contractors st louis mo',  'p2', null, null, true),
  ('electrical companies st louis mo',    'p2', null, null, true),
  ('industrial electrician st louis',     'p2', 10,  null, true),
  ('ev charger installation st louis',    'p2', 20,  null, true),
  ('generator installation st louis',     'p2', 10,  26.00, true),
  ('ceiling fan installation st louis',   'p2', 40,  null, true),
  ('home rewiring st louis',              'p2', 10,  null, true),
  ('electrical repair st louis',          'p2', null, null, true),
  -- Tier 1 city terms on the tracked list
  ('electrician st charles mo',           'p2', null, null, true),
  ('electrician chesterfield mo',         'p2', null, null, true),
  ('electrician o''fallon mo',            'p2', null, null, true),
  ('electrician kirkwood mo',             'p2', null, null, true),
  ('electrician florissant mo',           'p2', null, null, true),
  ('electrician wentzville mo',           'p2', null, null, true),
  ('electrician webster groves',          'p2', null, null, true),
  -- remaining service primaries (pages, not tracked)
  ('circuit breaker replacement st louis',    'p2', null, null, false),
  ('new construction electrical st louis',    'p2', null, null, false),
  ('remodel electrician st louis',            'p2', null, null, false),
  ('light fixture installation st louis',     'p2', null, null, false),
  ('outlet installation st louis',            'p2', null, null, false),
  ('smart home wiring st louis',              'p2', null, null, false),
  ('tenant build out electrical st louis',    'p2', null, null, false),
  ('commercial lighting st louis',            'p2', null, null, false),
  ('commercial electrical panel st louis',    'p2', null, null, false),
  ('electrical inspection st louis',          'p2', null, null, false),
  ('commercial electrical maintenance',       'p2', 10,  null, false),
  ('switchgear installation st louis',        'p2', null, null, false),
  ('machine wiring st louis',                 'p2', null, null, false),
  ('control panel wiring st louis',           'p2', null, null, false),
  ('industrial electrical maintenance',       'p2', 10,  null, false)
) as k(keyword, priority, volume, cpc, tracked)
on conflict (client_id, keyword) do update set
  priority     = excluded.priority,
  volume       = coalesce(excluded.volume, keywords.volume),
  cpc          = coalesce(excluded.cpc, keywords.cpc),
  intent       = coalesce(keywords.intent, excluded.intent),
  source       = coalesce(keywords.source, excluded.source),
  last_checked = excluded.last_checked,
  is_tracked   = keywords.is_tracked or excluded.is_tracked;

-- Money keywords: protected, approved with the map on 2026-09-02.
insert into money_keywords (id, client_id, keyword_id, confirmed_by, confirmed_on)
select uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:money_keywords:' || k.keyword),
       k.client_id, k.id, 'Tom — taxonomy & keyword map v1.1 approval', '2026-09-02'
from keywords k
where k.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d'
  and k.keyword in ('electrician near me', 'electrician st louis', 'st louis electrician',
                    'emergency electrician st louis', 'electrical panel upgrade st louis',
                    'commercial electrician st louis')
on conflict (keyword_id) do update set
  confirmed_by = excluded.confirmed_by, confirmed_on = excluded.confirmed_on;

-- ── Services (PB1): 24 canonical, three segments ──────────────────────────
-- gbp_entry starts as the service name; swap in Google's predefined label when
-- the GBP is aligned. No page URLs yet: the current site is WordPress and the
-- page map is a Website-pipeline decision.
insert into services (id, client_id, name, segment, gbp_entry, page_type,
                      primary_keyword_id, status, sort_order)
select uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:services:' || s.slug),
       '9a8e05f5-3d28-4839-9735-79bcdd0e277d', s.name, s.segment, s.name,
       s.page_type::service_page_type,
       (select k.id from keywords k
         where k.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d' and k.keyword = s.primary_kw),
       'approved', s.sort_order
from (values
  (1,  'Residential', 'Electrical Repair & Troubleshooting',       'electrical-repair',        'electrical repair st louis',              'service'),
  (2,  'Residential', 'Emergency Electrical Service',               'emergency-electrical',     'emergency electrician st louis',          'service'),
  (3,  'Residential', 'Electrical Panel Upgrades & Replacement',    'panel-upgrades',           'electrical panel upgrade st louis',       'service'),
  (4,  'Residential', 'Circuit Breaker Repair & Replacement',       'circuit-breakers',         'circuit breaker replacement st louis',    'service'),
  (5,  'Residential', 'Home Rewiring',                              'home-rewiring',            'home rewiring st louis',                  'service'),
  (6,  'Residential', 'New Construction Wiring',                    'new-construction-wiring',  'new construction electrical st louis',    'service'),
  (7,  'Residential', 'Remodel & Home Addition Electrical',         'remodel-electrical',       'remodel electrician st louis',            'service'),
  (8,  'Residential', 'Lighting & Fixture Installation',            'lighting-installation',    'light fixture installation st louis',     'service'),
  (9,  'Residential', 'Ceiling Fan Installation',                   'ceiling-fans',             'ceiling fan installation st louis',       'service'),
  (10, 'Residential', 'Outlet & Switch Installation',               'outlets-switches',         'outlet installation st louis',            'service'),
  (11, 'Residential', 'Smart Home & Security Wiring',               'smart-home-wiring',        'smart home wiring st louis',              'service'),
  (12, 'Residential', 'EV Charger Installation',                    'ev-chargers',              'ev charger installation st louis',        'service'),
  (13, 'Residential', 'Generator Installation',                     'generators',               'generator installation st louis',         'service'),
  (14, 'Commercial',  'Commercial Electrical Services',             'commercial-electrical',    'commercial electrician st louis',         'hub'),
  (15, 'Commercial',  'Tenant Build-Outs',                          'tenant-build-outs',        'tenant build out electrical st louis',    'service'),
  (16, 'Commercial',  'Commercial Lighting & LED Retrofits',        'commercial-lighting',      'commercial lighting st louis',            'service'),
  (17, 'Commercial',  'Commercial Panel & Service Upgrades',        'commercial-panels',        'commercial electrical panel st louis',    'service'),
  (18, 'Commercial',  'Electrical Code Compliance & Inspections',   'code-compliance',          'electrical inspection st louis',          'service'),
  (19, 'Commercial',  'Commercial Electrical Maintenance',          'commercial-maintenance',   'commercial electrical maintenance',       'service'),
  (20, 'Industrial',  'Industrial Electrical Services',             'industrial-electrical',    'industrial electrician st louis',         'hub'),
  (21, 'Industrial',  'Switchgear & Transformer Installation',      'switchgear',               'switchgear installation st louis',        'service'),
  (22, 'Industrial',  'Machinery & Equipment Hookups',              'machinery-hookups',        'machine wiring st louis',                 'service'),
  (23, 'Industrial',  'Control Panels & Power Distribution',        'control-panels',           'control panel wiring st louis',           'service'),
  (24, 'Industrial',  'Preventative Industrial Maintenance',        'industrial-maintenance',   'industrial electrical maintenance',       'service')
) as s(sort_order, segment, name, slug, primary_kw, page_type)
on conflict (id) do update set
  name = excluded.name, segment = excluded.segment, gbp_entry = excluded.gbp_entry,
  page_type = excluded.page_type, primary_keyword_id = excluded.primary_keyword_id,
  status = excluded.status, sort_order = excluded.sort_order;

-- ── Page groups (PB3): home + 24 service + 8 Tier 1 + 12 Tier 2 + 3 other ─
insert into page_groups (id, client_id, name, page_type, primary_keyword_id,
                         supporting_keyword_ids, city_tier, serp_notes, status)
select uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:page_groups:service:' || s.id::text),
       s.client_id, s.name, 'service', s.primary_keyword_id, '{}'::uuid[], null,
       case s.page_type when 'hub' then 'Segment hub page' else null end, 'approved'
from services s
where s.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d'
on conflict (id) do update set
  name = excluded.name, primary_keyword_id = excluded.primary_keyword_id,
  serp_notes = excluded.serp_notes, status = excluded.status;

insert into page_groups (id, client_id, name, page_type, primary_keyword_id,
                         supporting_keyword_ids, city_tier, serp_notes, status)
select uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:page_groups:' || p.slug),
       '9a8e05f5-3d28-4839-9735-79bcdd0e277d', p.name, p.page_type::page_group_type,
       (select k.id from keywords k
         where k.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d' and k.keyword = p.primary_kw),
       coalesce((select array_agg(k.id) from keywords k
         where k.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d' and k.keyword = any(p.supporting)), '{}'::uuid[]),
       p.tier::city_tier, p.notes, 'approved'
from (values
  ('home', 'Home', 'home', 'electrician st louis',
     array['st louis electrician', 'st louis electricians', 'electrical contractor st louis', 'electrician near me'],
     null, 'Metro term carries the demand. Brand demand is minimal; not a home-page primary.'),
  ('city-st-louis',      'St. Louis',      'city', 'electrician st louis',      null, '1', 'Tier 1 — build full: Ameren specifics, county permitting, communities, local examples'),
  ('city-st-charles',    'St. Charles',    'city', 'electrician st charles mo',  null, '1', 'Tier 1 — build full'),
  ('city-chesterfield',  'Chesterfield',   'city', 'electrician chesterfield mo', null, '1', 'Tier 1 — build full'),
  ('city-ofallon',       'O''Fallon MO',   'city', 'electrician o''fallon mo',   null, '1', 'Tier 1 — build full'),
  ('city-kirkwood',      'Kirkwood',       'city', 'electrician kirkwood mo',    null, '1', 'Tier 1 — build full'),
  ('city-florissant',    'Florissant',     'city', 'electrician florissant mo',  null, '1', 'Tier 1 — build full'),
  ('city-wentzville',    'Wentzville',     'city', 'electrician wentzville mo',  null, '1', 'Tier 1 — build full'),
  ('city-webster-groves','Webster Groves', 'city', 'electrician webster groves', null, '1', 'Tier 1 — build full'),
  ('city-ballwin',       'Ballwin',        'city', null, null, '2', 'Tier 2 — build lighter'),
  ('city-ellisville',    'Ellisville',     'city', null, null, '2', 'Tier 2 — build lighter'),
  ('city-manchester',    'Manchester',     'city', null, null, '2', 'Tier 2 — build lighter'),
  ('city-creve-coeur',   'Creve Coeur',    'city', null, null, '2', 'Tier 2 — build lighter'),
  ('city-clayton',       'Clayton',        'city', null, null, '2', 'Tier 2 — build lighter'),
  ('city-university-city','University City','city', null, null, '2', 'Tier 2 — build lighter'),
  ('city-maplewood',     'Maplewood',      'city', null, null, '2', 'Tier 2 — build lighter'),
  ('city-fenton',        'Fenton',         'city', null, null, '2', 'Tier 2 — build lighter'),
  ('city-arnold',        'Arnold',         'city', null, null, '2', 'Tier 2 — build lighter'),
  ('city-st-peters',     'St. Peters',     'city', null, null, '2', 'Tier 2 — build lighter'),
  ('city-edwardsville',  'Edwardsville IL','city', null, null, '2', 'Tier 2 — build lighter'),
  ('city-belleville',    'Belleville IL',  'city', null, null, '2', 'Tier 2 — build lighter'),
  ('service-area', 'Service area', 'other', null, null, null, 'Tier 3 (~50 cities) live here with real internal links; promote only on Search Console impressions'),
  ('contact',      'Contact',      'other', null, null, null, null),
  ('blog',         'Blog hub',     'hub',   null, null, null, 'First six topics: panel upgrade signs; home rewire cost; EV charger requirements in Missouri; emergency electrician signs; Ameren permitting basics; repair vs replacement')
) as p(slug, name, page_type, primary_kw, supporting, tier, notes)
on conflict (id) do update set
  name = excluded.name, page_type = excluded.page_type,
  primary_keyword_id = excluded.primary_keyword_id,
  supporting_keyword_ids = excluded.supporting_keyword_ids,
  city_tier = excluded.city_tier, serp_notes = excluded.serp_notes, status = excluded.status;

-- ── Brand board (PB2): draft, awaiting Tom ────────────────────────────────
insert into brand_boards (id, client_id, version, status, palette, typography,
                          positioning_line, standing_cta, hard_rules, drive_doc_url)
values (
  uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:brand_boards:v1'),
  '9a8e05f5-3d28-4839-9735-79bcdd0e277d', 1, 'draft',
  '[{"role":"primary","name":"Electric lime","hex":"#bfd62d","usage":"Logo plug + Missouri mark, accents","source":"sourced"},
    {"role":"secondary","name":"Wordmark grey","hex":"#606060","usage":"SHOW ME ELECTRICAL wordmark","source":"sourced"},
    {"role":"accent","name":"Navy","hex":"#04345c","usage":"Site accent","source":"sourced"},
    {"role":"text","name":"Charcoal","hex":"#121217","usage":"Body text","source":"sourced"}]'::jsonb,
  '{"heading":"Spectral SC","body":"Poppins","accent":"Spectral","notes":"As used on the current site. Poppins is a default geometric sans; whether it stays is a decision for Tom."}'::jsonb,
  'Owner-led, licensed Master Electrician serving St. Louis City, St. Louis County and the greater St. Louis area with residential, commercial and industrial electrical work done right the first time.',
  'Get a free quote',
  array[
    'Business name: Show Me Electrical',
    'Phone: 314-571-9756 — the only number published',
    'Emphasize the owner-operated Master Electrician; never invent licenses, certifications or pricing',
    'Avoid: cheap, discount, guaranteed lowest price, sales team, corporate jargon',
    'Real job-site photos only; no stock electrician clichés'
  ],
  'https://docs.google.com/document/d/1Ohv1j9MHVhrVsc_Bs5Hu-kgwWKYeYDQLXjofdw3cm0Q/edit'
)
on conflict (client_id, version) do update set
  status = brand_boards.status, -- approval is Tom's; never regress it here
  palette = excluded.palette, typography = excluded.typography,
  positioning_line = excluded.positioning_line, standing_cta = excluded.standing_cta,
  hard_rules = excluded.hard_rules, drive_doc_url = excluded.drive_doc_url;

-- Claims: sourced = on the client's own site; unverified until Dan confirms.
insert into claims (id, client_id, claim, status, source)
select uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:claims:' || c.key),
       '9a8e05f5-3d28-4839-9735-79bcdd0e277d', c.claim, c.status::claim_status, c.source
from (values
  ('owner-on-job',   'Dan is the owner and the Master Electrician on every job — no sales rep, no middle man', 'sourced',    'showmeelectrical.com'),
  ('master-license', 'Licensed Master Electrician',                                                        'sourced',    'showmeelectrical.com (license number not on file)'),
  ('years',          'Over 20 years of residential, commercial and industrial experience',                  'unverified', 'Brand board draft 2026-09-01; no figure confirmed by Dan'),
  ('free-quote',     'Free consultations / free quotes',                                                    'unverified', 'Brand board draft 2026-09-01'),
  ('missouri-born',  'Born and raised in Missouri',                                                         'unverified', 'Brand board draft 2026-09-01'),
  ('service-area',   'Serves St. Louis City, St. Louis County, St. Charles, Jefferson, Franklin, Warren and Lincoln Counties', 'sourced', 'showmeelectrical.com'),
  ('word-of-mouth',  'Reputation built on word of mouth: on time, straight answers, code-compliant work',   'unverified', 'Brand board draft 2026-09-01')
) as c(key, claim, status, source)
on conflict (id) do update set
  claim = excluded.claim, source = excluded.source,
  status = case when claims.status = 'confirmed' then claims.status else excluded.status end;

-- ── The existing site ─────────────────────────────────────────────────────
insert into sites (id, client_id, url, stack, controlled_by_compass, domain_constant)
values (uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:sites:showmeelectrical.com'),
        '9a8e05f5-3d28-4839-9735-79bcdd0e277d', 'https://showmeelectrical.com', 'other',
        false, 'showmeelectrical.com')
on conflict (id) do update set url = excluded.url, stack = excluded.stack,
  domain_constant = excluded.domain_constant;

-- ── Documents + deliverables ──────────────────────────────────────────────
insert into documents (id, client_id, kind, label, category, url)
values (uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:documents:taxonomy-v1.1'),
        '9a8e05f5-3d28-4839-9735-79bcdd0e277d', 'drive_link',
        'Service Taxonomy, Keyword Map & Tracked List v1.1 (approved 2026-09-02)', 'other',
        'https://docs.google.com/document/d/102N4xhS8aGfjWGOG_A0k8IjG7m_3SyY9YDKkf7xfV9A/edit')
on conflict (id) do nothing;

-- ── Foundation: reopen and record real evidence ───────────────────────────
-- Stage 1 (taxonomy) and stage 3 (keyword map) are genuinely approved; stage 2
-- (brand board) is a draft, so it goes back to in_progress. Guarded so a later
-- approval by Tom is never undone by re-running this script.
with f as (
  select cs.id, s.sort_order
  from client_stages cs
  join client_pipelines cp on cp.id = cs.client_pipeline_id
  join pipelines p on p.id = cp.pipeline_id and p.key = 'foundation'
  join stages s on s.id = cs.stage_id
  where cp.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d'
)
update client_stages cs set
  evidence = case f.sort_order
    when 1 then 'Service taxonomy (24 services, 3 segments) approved 2026-09-02 in "Service Taxonomy, Keyword Map & Tracked List v1.1": https://docs.google.com/document/d/102N4xhS8aGfjWGOG_A0k8IjG7m_3SyY9YDKkf7xfV9A/edit — loaded to services 2026-09-10.'
    when 3 then 'Keyword map, 24-term tracked list and 6 money keywords approved 2026-09-02 (same document) — loaded to keywords, money_keywords and page_groups 2026-09-10. GSC had ~30 days of data; rebuild at the first quarterly review.'
    else cs.evidence end,
  next_action = case f.sort_order
    when 3 then 'Push the 24-term tracked list to the BrightLocal report (SEO › Tracking Setup).'
    else cs.next_action end
from f
where cs.id = f.id and f.sort_order in (1, 3);

with f as (
  select cs.id
  from client_stages cs
  join client_pipelines cp on cp.id = cs.client_pipeline_id
  join pipelines p on p.id = cp.pipeline_id and p.key = 'foundation'
  join stages s on s.id = cs.stage_id
  where cp.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d' and s.sort_order = 2
    and cs.evidence like 'Backfilled by migration 0011%'
)
update client_stages cs set
  status = 'in_progress', evidence = null, completed_at = null,
  next_action = 'Tom: approve the brand board draft (2026-09-01) or send back; decide whether Poppins stays; confirm business type (storefront vs service area) and the free-quote claim.'
from f where cs.id = f.id;

update client_pipelines cp set status = 'active', completed_at = null
from pipelines p
where p.id = cp.pipeline_id and p.key = 'foundation'
  and cp.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d'
  and exists (select 1 from client_stages cs where cs.client_pipeline_id = cp.id and cs.status <> 'complete');

-- The open brand-board task belongs on Brand Build (tasks.key exists remotely only).
update tasks t set client_stage_id = cs.id
from client_stages cs
join client_pipelines cp on cp.id = cs.client_pipeline_id
join pipelines p on p.id = cp.pipeline_id and p.key = 'foundation'
join stages s on s.id = cs.stage_id and s.sort_order = 2
where cp.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d'
  and t.client_id = cp.client_id and t.key = 'brand_board' and t.client_stage_id is null;

insert into deliverables (id, client_id, client_stage_id, label, url, type)
select uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:deliverables:stage' || s.sort_order || ':' || d.key),
       cp.client_id, cs.id, d.label, d.url, 'drive'
from client_stages cs
join client_pipelines cp on cp.id = cs.client_pipeline_id
join pipelines p on p.id = cp.pipeline_id and p.key = 'foundation'
join stages s on s.id = cs.stage_id
join (values
  (1, 'taxonomy',    'Service Taxonomy, Keyword Map & Tracked List v1.1 (approved)', 'https://docs.google.com/document/d/102N4xhS8aGfjWGOG_A0k8IjG7m_3SyY9YDKkf7xfV9A/edit'),
  (3, 'keyword-map', 'Service Taxonomy, Keyword Map & Tracked List v1.1 (approved)', 'https://docs.google.com/document/d/102N4xhS8aGfjWGOG_A0k8IjG7m_3SyY9YDKkf7xfV9A/edit'),
  (2, 'brand-board', 'Brand Board (draft 2026-09-01, awaiting approval)',            'https://docs.google.com/document/d/1Ohv1j9MHVhrVsc_Bs5Hu-kgwWKYeYDQLXjofdw3cm0Q/edit')
) as d(sort_order, key, label, url) on d.sort_order = s.sort_order
where cp.client_id = '9a8e05f5-3d28-4839-9735-79bcdd0e277d'
on conflict (id) do update set label = excluded.label, url = excluded.url;

insert into change_log (id, client_id, change_type, object_type, object_id, after, reasoning, status)
values (uuid_generate_v5(uuid_ns_dns(), 'show-me-electrical:change_log:foundation-load-2026-09-10'),
        '9a8e05f5-3d28-4839-9735-79bcdd0e277d', 'foundation_load', 'client',
        '9a8e05f5-3d28-4839-9735-79bcdd0e277d',
        '{"services":24,"page_groups":48,"money_keywords":6,"claims":7,"brand_boards":1,"sites":1}'::jsonb,
        'Loaded PB1 + PB3 from the approved v1.1 taxonomy / keyword map and PB2 from the brand-board draft; Foundation reopened with Brand Build in progress. Drive folders 01–05 created and the three existing docs filed.',
        'proposed')
on conflict (id) do nothing;
