-- Synthetic fixtures for the portal access tests. Two clients, one portal
-- contact each, an inactive contact, a signed-in stranger and the team
-- account from bootstrap.sql. Run as postgres after every migration.

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-000000000011', 'portal-a@example.test', now()),
  ('00000000-0000-4000-a000-000000000012', 'portal-b@example.test', now()),
  ('00000000-0000-4000-a000-000000000013', 'portal-a-former@example.test', now()),
  ('00000000-0000-4000-a000-000000000014', 'stranger@example.test', now());

-- The client insert triggers (Foundation enrollment, brand row, worker fire,
-- provisioning) all run; pg_net is a stub so the fires only queue.
insert into clients (id, name, city, state, website_url, status, notes, gbp_spec) values
  ('00000000-0000-4000-b000-00000000000a', 'Sandbox Client A', 'Springfield', 'MO', 'https://a.example.test', 'active', 'internal note A', '{"internal": true}'),
  ('00000000-0000-4000-b000-00000000000b', 'Sandbox Client B', 'Columbia', 'MO', 'https://b.example.test', 'active', 'internal note B', '{"internal": true}');

insert into locations (id, client_id, name, city, state) values
  ('00000000-0000-4000-c000-00000000000a', '00000000-0000-4000-b000-00000000000a', 'A home', 'Springfield', 'MO'),
  ('00000000-0000-4000-c000-00000000000b', '00000000-0000-4000-b000-00000000000b', 'B home', 'Columbia', 'MO');

insert into keywords (id, client_id, keyword, is_tracked, is_money) values
  ('00000000-0000-4000-d000-00000000000a', '00000000-0000-4000-b000-00000000000a', 'a plumber', true, true),
  ('00000000-0000-4000-d000-00000000001a', '00000000-0000-4000-b000-00000000000a', 'a untracked', false, false),
  ('00000000-0000-4000-d000-00000000000b', '00000000-0000-4000-b000-00000000000b', 'b electrician', true, true);

insert into rank_snapshots (keyword_id, location_id, result_type, position, recorded_at, source) values
  ('00000000-0000-4000-d000-00000000000a', '00000000-0000-4000-c000-00000000000a', 'organic', 9, now() - interval '7 days', 'dataforseo'),
  ('00000000-0000-4000-d000-00000000000a', '00000000-0000-4000-c000-00000000000a', 'organic', 5, now(), 'dataforseo'),
  ('00000000-0000-4000-d000-00000000000a', '00000000-0000-4000-c000-00000000000a', 'organic', 1, now(), 'brightlocal_report'),
  ('00000000-0000-4000-d000-00000000001a', '00000000-0000-4000-c000-00000000000a', 'organic', 3, now(), 'dataforseo'),
  ('00000000-0000-4000-d000-00000000000b', '00000000-0000-4000-c000-00000000000b', 'organic', 4, now(), 'dataforseo');

insert into gsc_snapshots (client_id, query, page, clicks, impressions, ctr, avg_position, period_start, period_end) values
  ('00000000-0000-4000-b000-00000000000a', 'a plumber', '/', 10, 100, 0.1, 5.2, '2026-08-01', '2026-08-28'),
  ('00000000-0000-4000-b000-00000000000a', 'a drain', '/drains', 2, 50, 0.04, 8.1, '2026-08-01', '2026-08-28'),
  ('00000000-0000-4000-b000-00000000000b', 'b electrician', '/', 7, 70, 0.1, 3.3, '2026-08-01', '2026-08-28');

insert into change_log (client_id, change_type, object_type, reasoning, evidence, status) values
  ('00000000-0000-4000-b000-00000000000a', 'page', 'site', 'internal reasoning A', 'internal evidence A', 'approved'),
  ('00000000-0000-4000-b000-00000000000a', 'page', 'site', 'not yet', 'not yet', 'proposed'),
  ('00000000-0000-4000-b000-00000000000b', 'page', 'site', 'internal reasoning B', 'internal evidence B', 'approved');

insert into content_posts (client_id, title, status, url, published_at) values
  ('00000000-0000-4000-b000-00000000000a', 'A published post', 'published', 'https://a.example.test/blog/1', '2026-09-01'),
  ('00000000-0000-4000-b000-00000000000a', 'A draft post', 'draft', null, null),
  ('00000000-0000-4000-b000-00000000000b', 'B published post', 'published', 'https://b.example.test/blog/1', '2026-09-01');

insert into monthly_cycles (client_id, period, status, report_url) values
  ('00000000-0000-4000-b000-00000000000a', '2026-08-01', 'open', 'https://docs.example.test/a-aug'),
  ('00000000-0000-4000-b000-00000000000a', '2026-09-01', 'open', null),
  ('00000000-0000-4000-b000-00000000000b', '2026-08-01', 'open', 'https://docs.example.test/b-aug');

insert into sites (client_id, url, stack, controlled_by_compass)
select id, website_url, 'nextjs', true from clients
where id in ('00000000-0000-4000-b000-00000000000a', '00000000-0000-4000-b000-00000000000b')
  and not exists (select 1 from sites s where s.client_id = clients.id);

insert into storage.objects (bucket_id, name) values
  ('documents', '00000000-0000-4000-b000-00000000000a/report.pdf'),
  ('brand-assets', '00000000-0000-4000-b000-00000000000b/logo.png');

select vault.create_secret('not-a-real-value', 'SANDBOX_SECRET');

insert into portal_users (client_id, email, is_active) values
  ('00000000-0000-4000-b000-00000000000a', 'portal-a@example.test', true),
  ('00000000-0000-4000-b000-00000000000b', 'portal-b@example.test', true),
  ('00000000-0000-4000-b000-00000000000a', 'portal-a-former@example.test', false);
