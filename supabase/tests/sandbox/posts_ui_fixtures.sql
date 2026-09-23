-- Synthetic data for the posts review browser check (tests/posts-ui.mjs), on
-- top of fixtures.sql. Shaped like what the worker files today: the GBP
-- Spec's first-month posts, drafted with no JWT (SQL as postgres), plus the
-- claims, services and offers they stand on. Fictional names and
-- example.test addresses only.

update team_members set name = 'Sam Team' where email = 'sandbox-team@compassmarketing.ai';
update clients set name = 'Harbor Lane Plumbing', phone = '(417) 555-0100' where id = '00000000-0000-4000-b000-00000000000a';
update clients set name = 'Summit Electric' where id = '00000000-0000-4000-b000-00000000000b';

insert into services (id, client_id, name, status, sort_order) values
  ('00000000-0000-4000-e000-00000000000a', '00000000-0000-4000-b000-00000000000a', 'Drain cleaning', 'approved', 1),
  ('00000000-0000-4000-e000-00000000001a', '00000000-0000-4000-b000-00000000000a', 'Water heaters', 'approved', 2);
insert into claims (id, client_id, claim, status, source, confirmed_by, confirmed_on) values
  ('00000000-0000-4000-f000-00000000000a', '00000000-0000-4000-b000-00000000000a', 'Family owned since 1998', 'confirmed', null, 'Owner, intake call', now()),
  ('00000000-0000-4000-f000-00000000001a', '00000000-0000-4000-b000-00000000000a', 'Licensed master plumber on every job', 'sourced', 'https://a.example.test/about', null, null),
  ('00000000-0000-4000-f000-00000000002a', '00000000-0000-4000-b000-00000000000a', 'Fastest plumber in Springfield', 'unverified', null, null, null);
insert into offers (id, client_id, title, terms, source, status, confirmed_by, confirmed_on) values
  ('00000000-0000-4000-f100-00000000000a', '00000000-0000-4000-b000-00000000000a', 'Free estimates', 'Free estimates on any drain job.', 'Client email, Sept 2', 'confirmed', 'Owner', now());

-- The worker's drafts (no JWT → author_kind worker).
insert into social_posts (id, client_id, platform, search_intent, service_id, copy, cta_type, cta_url) values
  ('00000000-0000-4000-f300-00000000000a', '00000000-0000-4000-b000-00000000000a', 'google_business', 'commercial',
   '00000000-0000-4000-e000-00000000000a',
   'Slow drains? A licensed master plumber clears them the same week. Family owned since 1998.',
   'LEARN_MORE', 'https://a.example.test/drains');
insert into social_posts (id, client_id, platform, post_type, offer_id, search_intent, copy, cta_type, cta_url) values
  ('00000000-0000-4000-f300-00000000001a', '00000000-0000-4000-b000-00000000000a', 'google_business', 'offer',
   '00000000-0000-4000-f100-00000000000a', 'transactional',
   'Free estimates on any drain job. The fastest plumber in Springfield.', 'BOOK', 'https://a.example.test/book');
insert into post_claims (post_id, claim_id) values
  ('00000000-0000-4000-f300-00000000001a', '00000000-0000-4000-f000-00000000000a');
-- The offer post goes to review as the worker would send it.
update social_posts set review_status = 'in_review' where id = '00000000-0000-4000-f300-00000000001a';
