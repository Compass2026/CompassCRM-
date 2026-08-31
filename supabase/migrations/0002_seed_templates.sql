-- Seed pipelines, stages, and reporting task templates (spec v0.2 §5)

insert into pipelines (key, name, sort_order, is_recurring) values
  ('seo', 'SEO', 1, false),
  ('website', 'Website', 2, false),
  ('social', 'Social Media', 3, false),
  ('crm', 'CRM', 4, false),
  ('paid_ads', 'Paid Ads', 5, false),
  ('reporting', 'Reporting', 6, true);

-- SEO
insert into stages (pipeline_id, name, sort_order, is_optional, description)
select p.id, s.name, s.sort_order, s.is_optional, s.description
from pipelines p,
(values
  ('Audit', 1, false, 'On-page / technical / off-page audit — deliverable: audit report from Compass SEO skills'),
  ('Onboarding', 2, false, 'Access (GSC, GA4, GBP, hosting), domain portfolio check, brand assets, NAP confirmed'),
  ('Keyword Research & Targeting', 3, false, 'Target keyword set entered in Keywords tab'),
  ('Local Citations', 4, false, 'Citation build list + completion sheet'),
  ('GBP Setup & Optimization', 5, false, null),
  ('Backlink Foundation', 6, false, null),
  ('Tracking & Reporting Setup', 7, false, 'GSC/GA4/Looker Studio connected')
) as s(name, sort_order, is_optional, description)
where p.key = 'seo';

-- Website
insert into stages (pipeline_id, name, sort_order, is_optional, description)
select p.id, s.name, s.sort_order, s.is_optional, s.description
from pipelines p,
(values
  ('Discovery', 1, false, 'Sitemap, page inventory, content sources, photos requested'),
  ('Build', 2, false, 'Next.js + Antigravity, GitHub repo created'),
  ('SEO QA', 3, false, 'On-page/technical skills run, Rich Results Test passed, schema components in place'),
  ('Launch', 4, false, 'DNS cutover, redirects verified, GSC submitted')
) as s(name, sort_order, is_optional, description)
where p.key = 'website';

-- Social Media
insert into stages (pipeline_id, name, sort_order, is_optional, description)
select p.id, s.name, s.sort_order, s.is_optional, s.description
from pipelines p,
(values
  ('Audit', 1, false, 'Existing profiles, handles, posting history'),
  ('Brand & Content Setup', 2, false, 'Voice, pillars, templates (Canva), Metricool connected'),
  ('Content Calendar', 3, false, 'First 30 days planned in Social tab'),
  ('First Month Live', 4, false, null)
) as s(name, sort_order, is_optional, description)
where p.key = 'social';

-- CRM
insert into stages (pipeline_id, name, sort_order, is_optional, description)
select p.id, s.name, s.sort_order, s.is_optional, s.description
from pipelines p,
(values
  ('Requirements', 1, false, 'Pipelines, fields, automations, comms needs'),
  ('Build', 2, false, null),
  ('Data Migration', 3, true, 'Optional per client'),
  ('Training', 4, false, null),
  ('Live', 5, false, null)
) as s(name, sort_order, is_optional, description)
where p.key = 'crm';

-- Paid Ads
insert into stages (pipeline_id, name, sort_order, is_optional, description)
select p.id, s.name, s.sort_order, s.is_optional, s.description
from pipelines p,
(values
  ('Account Audit', 1, false, 'Existing ad accounts, historical spend, pixel/tag state'),
  ('Tracking Setup', 2, false, 'Conversions, GA4, Meta pixel/CAPI'),
  ('Campaign Build', 3, false, null),
  ('Launch', 4, false, null),
  ('Optimization Handoff', 5, false, 'Hands off to Reporting')
) as s(name, sort_order, is_optional, description)
where p.key = 'paid_ads';

-- Reporting monthly cycle task templates (filtered by client's departments)
insert into task_templates (pipeline_id, department, title, default_owner, sort_order)
select p.id, t.department::department, t.title, t.default_owner::owner_type, t.sort_order
from pipelines p,
(values
  ('seo', 'GBP posts (count per plan)', 'CLAUDE_APPROVAL', 1),
  ('seo', 'New backlinks', 'TOM', 2),
  ('seo', 'Blog content published (from Content tab)', 'CLAUDE_APPROVAL', 3),
  ('social', 'Social posts published (from Social tab)', 'TOM', 4),
  ('paid_ads', 'Paid ads optimization + spend review', 'TOM', 5),
  ('seo', 'Rank snapshot recorded', 'CLAUDE', 6),
  (null, 'Monthly report generated → saved to Drive → link stored in Reports tab', 'CLAUDE_APPROVAL', 7)
) as t(department, title, default_owner, sort_order)
where p.key = 'reporting';

-- Grid defaults by client type (spec §6.5a), editable in Settings
insert into app_settings (key, value) values
('grid_defaults', '[
  {"client_type": "City-based contractor / retail (dense metro)", "grid_size": 7, "spacing_miles": 1},
  {"client_type": "Suburban service business", "grid_size": 7, "spacing_miles": 2},
  {"client_type": "Rural / wide service area", "grid_size": 9, "spacing_miles": 4},
  {"client_type": "Single storefront", "grid_size": 5, "spacing_miles": 1}
]'::jsonb);
