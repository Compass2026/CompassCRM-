-- Replay hook, run just before 20261120190000 (clear obsolete no-image
-- reasons) is applied: one fictional client with posts in the shapes
-- production has on Nov 20 2026, so the migration's backfill runs against
-- them instead of against nothing. Seeded as supabase_admin with triggers off
-- (a direct seed of existing rows, never how posts are made); the backfill
-- itself then runs with every trigger on. 20261120190000.after.sql snapshots
-- the result and removes these rows before the suites run.
--   nb1  in review, an image and a reason  -> cleared
--   nb2  draft, an image and a reason      -> cleared
--   nb3  in review, no image, a reason     -> kept
--   nb4  in review, an image, no reason    -> untouched
\c - supabase_admin
set session_replication_role = replica;
insert into clients (id, name, city, state, status) values
  ('0c000000-0000-4000-b000-0000000000c1', 'No Image Backfill Co (fictional)', 'Wichita', 'KS', 'active');
insert into services (id, client_id, name, status) values
  ('0c000000-0000-4000-b000-0000000000a1', '0c000000-0000-4000-b000-0000000000c1', 'Residential Solar Panel Installation', 'approved');
insert into social_accounts (id, client_id, platform, external_account_id, display_name) values
  ('0c000000-0000-4000-b000-0000000000f1', '0c000000-0000-4000-b000-0000000000c1', 'facebook', '999000111222', 'Backfill Page');
insert into brand_assets (id, client_id, kind, source, label, storage_path, mime_type, size_bytes, width, height, content_hash,
                          content_hashed_at, content_measurement) values
  ('0c000000-0000-4000-b000-0000000000e1', '0c000000-0000-4000-b000-0000000000c1', 'social_post', 'upload', 'Revised graphic',
   '0c000000-0000-4000-b000-0000000000c1/upload/' || repeat('7', 64) || '.png', 'image/png', 1000, 1080, 1080, repeat('7', 64), now(),
   '{"bytes": 1000, "content_type": "image/png", "measured_by": "sandbox"}');
insert into social_posts (id, client_id, platform, search_intent, crm_facts_only, copy, social_account_id, service_id, review_status, no_image_reason) values
  ('0c000000-0000-4000-b000-0000000000b1', '0c000000-0000-4000-b000-0000000000c1', 'facebook', 'navigational', true, 'Backfill Co: post one.',
   '0c000000-0000-4000-b000-0000000000f1', '0c000000-0000-4000-b000-0000000000a1', 'in_review', 'No verified photo for this location yet (nb1).'),
  ('0c000000-0000-4000-b000-0000000000b2', '0c000000-0000-4000-b000-0000000000c1', 'facebook', 'navigational', true, 'Backfill Co: post two.',
   '0c000000-0000-4000-b000-0000000000f1', '0c000000-0000-4000-b000-0000000000a1', 'draft', 'No approved image of this service (nb2).'),
  ('0c000000-0000-4000-b000-0000000000b3', '0c000000-0000-4000-b000-0000000000c1', 'facebook', 'navigational', true, 'Backfill Co: post three.',
   '0c000000-0000-4000-b000-0000000000f1', '0c000000-0000-4000-b000-0000000000a1', 'in_review', 'Text-only on purpose (nb3).'),
  ('0c000000-0000-4000-b000-0000000000b4', '0c000000-0000-4000-b000-0000000000c1', 'facebook', 'navigational', true, 'Backfill Co: post four.',
   '0c000000-0000-4000-b000-0000000000f1', '0c000000-0000-4000-b000-0000000000a1', 'in_review', null);
insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role, content_hash)
  select id, client_id, '0c000000-0000-4000-b000-0000000000e1', 1, 'media', repeat('7', 64)
    from social_posts
   where id in ('0c000000-0000-4000-b000-0000000000b1', '0c000000-0000-4000-b000-0000000000b2', '0c000000-0000-4000-b000-0000000000b4');
set session_replication_role = origin;
