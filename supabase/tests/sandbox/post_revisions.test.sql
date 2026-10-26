-- Tests for 20261026200000 (rejection corrections), run by
-- scripts/test-portal-sandbox.sh after content_edits.test.sql (the cd and pe
-- harnesses; sandbox-team@compassmarketing.ai is an admin). A fictional
-- client with a Business Profile location and a Facebook Page, and posts
-- shaped like the Lucas siding post (drafter-made, an attached image).
--
--   PR1  doors: a teammate cannot write the tables or call the worker /
--        function doors; anon reads nothing; a portal user is refused (portal_access)
--   PR2  the bug: an attached (uploaded) image can be rejected as the image;
--        one request with the exact feedback, hashes, destination; the image
--        queued for ChatGPT in the outbox; nothing for Claude
--   PR3  duplicates: a repeated reject changes nothing; one request per rejection
--   PR4  unchanged resubmission is refused and the feedback stays visible
--   PR5  caption-only: the worker Routine is fired (worker_fires + the queued
--        HTTP request) and recorded as dispatch evidence
--   PR6  claims: the worker claims; another claimant and a teammate cannot
--   PR7  the caption writer: wrong claimant, stale copy, unchanged copy,
--        another client are refused; a valid revision goes back for a FRESH
--        review (new review task, nothing approved or scheduled)
--   PR8  mixed: the caption alone leaves a draft waiting for the image; the
--        image (ChatGPT through content_edit, on the rejected/draft post)
--        completes it and the post returns for review
--   PR9  the outbox: Executive OS reads it, acknowledges once (replay), a
--        different receipt or a stale generation is refused
--   PR10 a rendered (Creative Engine) graphic: routed to a teammate's
--        re-render, never ChatGPT; a new graphic meets it
--   PR11 manual: Reopen to edit stands the worker and ChatGPT down; the
--        teammate's own edit meets the caption
--   PR12 a teammate records "no change needed" (note required, attributed)
--   PR13 a corrected category: history keeps the original, the correction is
--        its own event, the new obligation is dispatched
--   PR14 approval accepts the request; nothing is scheduled
--   PR15 a later rejection supersedes the request
--   PR16 destination changed under the request: the caption writer refuses
--   PR17 a delegated replace_copy (chat-requested caption) with hash checks
--   PR18 dispatcher unconfigured: blocked with one task; a retry reuses it
--   PR19 backfill: a legacy rejection (the Lucas shape) is recovered as a
--        manual request with its feedback; changes after it count as resolved
--   PR20 the review screen's caption edit: atomic, bound to what was seen,
--        waits for an owed image, and the worker stands down

\set team '00000000-0000-4000-a000-000000000001'

\c - supabase_admin
\o /dev/null
create schema rv;
create function rv.h(p text) returns text language sql immutable security definer set search_path = public, pg_temp as $$ select drafter_copy_hash(p) $$;
-- The Routine's fire URL and token (another suite may have set them already).
create table rv.saved_secrets as select name, secret from vault.secrets where name in ('ROUTINE_FIRE_URL', 'ROUTINE_FIRE_TOKEN');
insert into vault.secrets (name, secret) select n, v from (values ('ROUTINE_FIRE_URL', 'https://routine.example.test/fire'), ('ROUTINE_FIRE_TOKEN', 'sandbox-token')) x(n, v)
 where not exists (select 1 from vault.secrets where name = x.n);
delete from rv.saved_secrets;
insert into rv.saved_secrets select name, secret from vault.secrets where name in ('ROUTINE_FIRE_URL', 'ROUTINE_FIRE_TOKEN');
insert into clients (id, name, city, state, status) values
  (cd.id('pr'), 'Revision Roofing Co (fictional)', 'Wentzville', 'MO', 'active'),
  (cd.id('pr-other'), 'Other Revision Co (fictional)', 'Columbia', 'MO', 'active');
insert into services (id, client_id, name, status) values
  (cd.id('pr-siding'), cd.id('pr'), 'Siding Installation and Repair', 'approved'),
  (cd.id('pr-o-svc'), cd.id('pr-other'), 'Siding', 'approved');
insert into social_accounts (id, client_id, platform, external_account_id, display_name) values
  (cd.id('pr-gb'), cd.id('pr'), 'google_business', 'locations/3692365240387501506', 'Revision Location'),
  (cd.id('pr-gb2'), cd.id('pr'), 'google_business', 'locations/999', 'Second Location'),
  (cd.id('pr-fb'), cd.id('pr'), 'facebook', '888000111222', 'Revision Page');
insert into brand_assets (id, client_id, kind, source, label, storage_path, mime_type, size_bytes, width, height, content_hash,
                          content_hashed_at, content_measurement) values
  (cd.id('pr-img'), cd.id('pr'), 'social_post', 'upload', 'Siding graphic (blue underline)',
   cd.id('pr')::text || '/upload/' || repeat('a', 64) || '.png', 'image/png', 1900000, 1448, 1086, repeat('a', 64), now(),
   '{"bytes": 1900000, "content_type": "image/png", "measured_by": "sandbox"}');
insert into storage.objects (bucket_id, name, metadata) values
  ('brand-assets', cd.id('pr')::text || '/upload/' || repeat('a', 64) || '.png', '{"size": 1900000}'),
  ('brand-assets', cd.id('pr')::text || '/upload/' || encode(sha256('pr-fixed-image'), 'hex') || '.png', '{"size": 2100000}'),
  ('brand-assets', cd.id('pr')::text || '/upload/' || encode(sha256('pr-fixed-image-2'), 'hex') || '.png', '{"size": 2100000}');

insert into social_posts (id, client_id, platform, search_intent, crm_facts_only, copy, social_account_id, service_id) values
  -- r1: the Lucas shape (Business Profile, drafter-made, an uploaded image).
  (cd.id('r1'), cd.id('pr'), 'google_business', 'navigational', true, 'Revision Roofing Co: siding installation and repair in Wentzville.', cd.id('pr-gb'), cd.id('pr-siding')),
  -- r2: a rendered Creative Engine graphic.
  (cd.id('r2'), cd.id('pr'), 'facebook', 'navigational', true, 'Revision Roofing Co: rendered graphic post.', cd.id('pr-fb'), cd.id('pr-siding')),
  -- r3: no media (caption only).
  (cd.id('r3'), cd.id('pr'), 'google_business', 'navigational', true, 'Revision Roofing Co: siding installation and repair.', cd.id('pr-gb'), cd.id('pr-siding')),
  -- r4: mixed feedback on an uploaded image.
  (cd.id('r4'), cd.id('pr'), 'google_business', 'navigational', true, 'Revision Roofing Co: siding and repair, mixed.', cd.id('pr-gb'), cd.id('pr-siding')),
  -- r5: manual takeover; r6: resolved without change; r7: reclassified;
  -- r8: destination changed; r9: delegated caption edit; r10: unconfigured.
  (cd.id('r5'), cd.id('pr'), 'google_business', 'navigational', true, 'Revision Roofing Co: manual post.', cd.id('pr-gb'), cd.id('pr-siding')),
  (cd.id('r6'), cd.id('pr'), 'google_business', 'navigational', true, 'Revision Roofing Co: resolved post.', cd.id('pr-gb'), cd.id('pr-siding')),
  (cd.id('r7'), cd.id('pr'), 'google_business', 'navigational', true, 'Revision Roofing Co: reclassified post.', cd.id('pr-gb'), cd.id('pr-siding')),
  (cd.id('r8'), cd.id('pr'), 'google_business', 'navigational', true, 'Revision Roofing Co: destination post.', cd.id('pr-gb'), cd.id('pr-siding')),
  (cd.id('r9'), cd.id('pr'), 'google_business', 'navigational', true, 'Revision Roofing Co: chat caption post.', cd.id('pr-gb'), cd.id('pr-siding')),
  (cd.id('r10'), cd.id('pr'), 'google_business', 'navigational', true, 'Revision Roofing Co: unconfigured post.', cd.id('pr-gb'), cd.id('pr-siding')),
  -- r11 / r12: legacy rejections for the backfill.
  (cd.id('r11'), cd.id('pr'), 'google_business', 'navigational', true, 'Revision Roofing Co: legacy post.', cd.id('pr-gb'), cd.id('pr-siding')),
  (cd.id('r12'), cd.id('pr'), 'google_business', 'navigational', true, 'Revision Roofing Co: legacy edited post.', cd.id('pr-gb'), cd.id('pr-siding')),
  (cd.id('ro'), cd.id('pr-other'), 'google_business', 'navigational', true, 'Other Revision Co: siding.', null, cd.id('pr-o-svc'));
insert into drafter_runs (id, client_id, requested_via, target, brief_version, brief_hash, runtime, copy_hash, status)
values (cd.id('pr-run'), cd.id('pr'), 'worker', '{}', 'sandbox', 'sha256:' || repeat('0', 64), 'sandbox',
        rv.h('Revision Roofing Co: siding installation and repair in Wentzville.'), 'submitted');
set session_replication_role = replica;
update social_posts set drafter_run_id = cd.id('pr-run') where id = cd.id('r1');
set session_replication_role = origin;
insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role, content_hash)
select id, client_id, cd.id('pr-img'), 1, 'media', repeat('a', 64) from social_posts
 where id in (cd.id('r1'), cd.id('r4'), cd.id('r7'), cd.id('r11'), cd.id('r12'));
insert into creative_assets (id, client_id, content_hash, storage_path, format, mime_type, width, height, size_bytes, strategy, purpose, provenance, alt_text)
values (cd.id('pr-ce'), cd.id('pr'), repeat('c', 64), cd.id('pr')::text || '/' || repeat('c', 64) || '.png', 'png', 'image/png',
        1080, 1350, 1800000, 'manual', 'post', '{"uploaded_via": "sandbox"}', 'Siding on a ranch home (illustrative)'),
       (cd.id('pr-ce2'), cd.id('pr'), repeat('d', 64), cd.id('pr')::text || '/' || repeat('d', 64) || '.png', 'png', 'image/png',
        1080, 1350, 1800000, 'manual', 'post', '{"uploaded_via": "sandbox"}', 'Siding, re-rendered (illustrative)');
insert into post_assets (post_id, client_id, creative_asset_id, sort_order, role, content_hash, copy_hash)
values (cd.id('r2'), cd.id('pr'), cd.id('pr-ce'), 1, 'media', repeat('c', 64), rv.h('Revision Roofing Co: rendered graphic post.'));
update social_posts set review_status = 'in_review' where client_id in (cd.id('pr'), cd.id('pr-other'));

-- One reject as the reviewer sends it (the guarded update the app makes).
create function rv.reject(p_post uuid, p_note text, p_category text default null) returns text language plpgsql as $$
declare n int;
begin
  update social_posts set review_status = 'rejected', review_note = p_note, rejection_category = coalesce(p_category, rejection_category)
   where id = p_post and review_status = 'in_review';
  get diagnostics n = row_count;
  return n::text;
exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create function rv.step(p_post uuid, p_from text, p_to text) returns text language plpgsql as $$
declare n int;
begin
  update social_posts set review_status = p_to where id = p_post and review_status = p_from;
  get diagnostics n = row_count;
  return n::text;
exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create function rv.req(p_post uuid) returns post_revision_requests language sql stable security definer set search_path = public, pg_temp as $$
  select * from post_revision_requests where post_id = p_post order by created_at desc limit 1
$$;
create function rv.copy_req(p_op text, p_post uuid, p_copy text, p_prev text default null, p_ops jsonb default '["replace_media", "replace_copy"]')
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('operation_id', p_op, 'client_id', p.client_id,
    'post', jsonb_build_object('channel', p.platform::text, 'id', p.id, 'service_id', p.service_id,
                               'review_hash', content_social_review_hash(p), 'destination', content_social_destination(p)->>'key'),
    'change', jsonb_build_object('kind', 'replace_copy', 'copy', p_copy, 'previous_copy_hash', coalesce(p_prev, rv.h(p.copy))),
    'executor', jsonb_build_object('channel', 'claude', 'executed_by', 'Claude via Executive OS', 'account_email', 'sandbox-team@compassmarketing.ai'),
    'authority', jsonb_build_object('kind', 'owner_approval', 'id', 'approval-sandbox', 'channels', '["google_business", "facebook"]'::jsonb,
                                    'service_ids', jsonb_build_array(cd.id('pr-siding')::text), 'operations', p_ops),
    'reason', 'Tom asked for the caption change in chat.', 'source_ref', '{"surface": "sandbox"}'::jsonb)
  from social_posts p where p.id = p_post
$$;
create function rv.media_req(p_op text, p_post uuid, p_stage uuid, p_sha text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select pe.req(p_op, p_post, p_stage, p_sha, 'sandbox-team@compassmarketing.ai', jsonb_build_array(cd.id('pr-siding')::text))
$$;
create function rv.state(p_post uuid) returns text language sql stable security definer set search_path = public, pg_temp as $$
  select p.review_status || '/' || p.publish_status || '/' || r.status || '/' || r.copy_state || '/' || r.image_state
    from social_posts p join post_revision_requests r on r.post_id = p.id where p.id = p_post order by r.created_at desc limit 1
$$;
grant usage on schema rv to anon, authenticated, service_role, authenticator, postgres;
grant execute on all functions in schema rv to anon, authenticated, service_role, authenticator, postgres;
-- pe.req / pe.measured / pe.revise (content_edits.test.sql) are reused: the
-- delegation policy needs this client's channels.
\o

-- ── The reviewer rejects (a signed-in teammate) ─────────────────────────────
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare a text; b text; c text; d text; e text; f text; g text; h text; i text; j text; k text;
begin
  -- PR2: before this migration an uploaded image could only be rejected as "copy".
  a := rv.reject(cd.id('r1'), 'Get rid of the blue line under the wording in the top left corner. Also, capitalize Siding Installation and Repair.', 'creative');
  b := rv.reject(cd.id('r2'), 'The rendered graphic is too dark.', 'creative');
  c := rv.reject(cd.id('r3'), 'Say "siding installation" in the first sentence.', null);
  d := rv.reject(cd.id('r4'), 'Remove the blue line; and the caption should mention free estimates.', 'both');
  e := rv.reject(cd.id('r5'), 'Shorten the caption.', 'copy');
  f := rv.reject(cd.id('r6'), 'Is the caption right?', 'copy');
  g := rv.reject(cd.id('r7'), 'Get rid of the blue line.', 'copy');  -- misclassified, as on Lucas
  h := rv.reject(cd.id('r8'), 'Mention Wentzville.', 'copy');
  i := rv.reject(cd.id('r3'), 'A second click.', null);               -- PR3
  j := rv.reject(cd.id('r9'), 'x', 'creative');                       -- no media: refused
  perform cd.save('rejects', concat_ws(' | ', a, b, c, d, e, f, g, h, i, j));
end $$;
\o
do $$
declare r post_revision_requests := rv.req(cd.id('r1')); sp social_posts; ev bigint;
begin
  select * into sp from social_posts where id = cd.id('r1');
  select id into ev from post_events where post_id = sp.id and kind = 'rejected' order by id desc limit 1;
  perform cd.ok('PR2 an attached image is rejected as the image: one request with the exact feedback, hashes and destination',
    cd.get('rejects') like '1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0 | 23514 The post has no image%'
    and sp.review_status = 'rejected' and sp.rejection_category = 'creative'
    and r.rejection_event_id = ev and r.feedback = 'Get rid of the blue line under the wording in the top left corner. Also, capitalize Siding Installation and Repair.'
    and r.original_category = 'creative' and r.category = 'creative' and r.mode = 'automatic' and r.status = 'open'
    and r.copy_state = 'not_needed' and r.image_state = 'queued' and r.image_assignee = 'chatgpt'
    and r.original_copy_hash = rv.h(sp.copy) and r.original_media->0->>'content_hash' = repeat('a', 64)
    and r.destination = 'google_business:locations/3692365240387501506' and r.service_id = cd.id('pr-siding')
    and r.rejected_by is not null and r.platform = 'google_business',
    cd.get('rejects') || ' ' || to_jsonb(r)::text);
  perform cd.ok('PR2b the image is queued for ChatGPT in the outbox; nothing is sent to Claude for it',
    (select count(*) = 1 and bool_and(status = 'pending' and generation = 1) from post_revision_outbox where request_id = r.id)
    and not exists (select 1 from worker_fires where reason = 'Post revision request ' || r.id)
    and (select string_agg(kind || ':' || coalesce(obligation, '-') || ':' || actor_kind, ',' order by id) from post_revision_events where request_id = r.id)
        = 'created:-:team,queued:image:team',
    (select string_agg(kind || ':' || coalesce(obligation, '-') || ':' || actor_kind, ',' order by id) from post_revision_events where request_id = r.id));
  perform cd.ok('PR3 a repeated reject changes nothing: one request per rejection',
    (select count(*) = 1 from post_revision_requests where post_id = cd.id('r3'))
    and (select count(*) = 1 from post_events where post_id = cd.id('r3') and kind = 'rejected'));
  perform cd.ok('PR1 a teammate reads requests but cannot write them, claim, write copy or read the queue',
    (select count(*) >= 8 from post_revision_requests where client_id = cd.id('pr'))
    and cd.try(format('update post_revision_requests set status = %L where post_id = %L', 'accepted', cd.id('r1'))) like '42501%'
    and cd.try(format('insert into post_revision_events (request_id, client_id, post_id, kind, actor_kind) values (%L, %L, %L, ''revised'', ''team'')',
               r.id, r.client_id, r.post_id)) like '42501%'
    and cd.try(format('select post_revision_claim(%L, ''worker-routine'')', r.id)) like '42501%'
    and cd.try(format('select post_revision_write_copy(''{"request_id": "%s"}''::jsonb)', r.id)) like '42501%'
    and cd.try('select post_revision_outbox_pending(10)') like '42501%'
    and cd.try(format('select post_revision_dispatch(%L)', r.id)) like '42501%');
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role anon;
select cd.as_user('anon', null);
do $$
begin
  perform cd.ok('PR1b anon reads no revision requests, history or queue',
    cd.try('select count(*) from post_revision_requests') like '42501%'
    and cd.try('select count(*) from post_revision_outbox') like '42501%'
    and cd.try('select count(*) from post_revision_events') like '42501%');
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── PR4: reopen and resubmit unchanged (what happened to Lucas) ─────────────
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare a text; b text;
begin
  a := rv.step(cd.id('r1'), 'rejected', 'draft');
  b := rv.step(cd.id('r1'), 'draft', 'in_review');
  perform cd.save('pr4', concat_ws(' | ', a, b));
end $$;
\o
do $$
declare r post_revision_requests := rv.req(cd.id('r1'));
begin
  perform cd.ok('PR4 an unchanged resubmission is refused; the post stays a draft and the feedback stays on the request',
    cd.get('pr4') like '1 | 23514 The rejection feedback is not addressed: the image is unchanged (“Get rid of the blue line%'
    and rv.state(cd.id('r1')) = 'draft/not_scheduled/open/not_needed/queued'
    and r.feedback like 'Get rid of the blue line%', cd.get('pr4') || ' ' || rv.state(cd.id('r1')));
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── PR5 / PR6: caption-only dispatch and the worker's claim ─────────────────
\c - postgres
\o /dev/null
do $$
declare r post_revision_requests := rv.req(cd.id('r3')); a jsonb; b jsonb;
begin
  a := post_revision_claim(r.id, 'worker-routine');
  b := post_revision_claim(r.id, 'operator-tg');
  perform cd.save('claim-a', a::text);
  perform cd.save('claim-b', b::text);
  perform cd.save('claim-r5', post_revision_claim((rv.req(cd.id('r1'))).id, 'worker-routine')::text);
end $$;
\o
do $$
declare r post_revision_requests := rv.req(cd.id('r3')); f worker_fires;
begin
  select * into f from worker_fires where reason = 'Post revision request ' || r.id;
  perform cd.ok('PR5 caption-only: the worker Routine is fired and the fire is recorded as dispatch evidence',
    f.id is not null and f.client_id = cd.id('pr') and f.request_id is not null
    and (select body->>'text' like 'CRM event: Post revision request ' || r.id || ' for client "Revision Roofing Co (fictional)"%foundation-worker skill.'
           from net.http_request_queue where id = f.request_id)
    and exists (select 1 from post_revision_events where request_id = r.id and kind = 'dispatched' and obligation = 'copy'
                  and (detail->>'worker_fire_id')::bigint = f.id)
    and r.image_state = 'not_needed' and not exists (select 1 from post_revision_outbox where request_id = r.id),
    to_jsonb(f)::text);
  perform cd.ok('PR6 the worker claims the caption; another claimant is refused; an image-only request has nothing to claim',
    cd.get('claim-a')::jsonb->>'claimed' = 'true' and cd.get('claim-b')::jsonb->>'reason' = 'claimed_by_other'
    and cd.get('claim-r5')::jsonb->>'reason' = 'not_queued'
    and r.copy_state = 'working' and r.copy_claimed_by = 'worker-routine', cd.get('claim-a') || ' ' || cd.get('claim-b'));
end $$;

-- ── PR7: the caption writer (the post-drafter function's session) ───────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r post_revision_requests := rv.req(cd.id('r3')); sp social_posts; a text; b text; c text; d text; e jsonb; old_task uuid;
begin
  select * into sp from social_posts where id = cd.id('r3');
  a := cd.try(format('select post_revision_write_copy(%L::jsonb)', jsonb_build_object('request_id', r.id, 'client_id', r.client_id,
         'claimant', 'operator-tg', 'expected_copy_hash', rv.h(sp.copy), 'copy', 'Siding installation and repair in Wentzville.')));
  b := cd.try(format('select post_revision_write_copy(%L::jsonb)', jsonb_build_object('request_id', r.id, 'client_id', r.client_id,
         'claimant', 'worker-routine', 'expected_copy_hash', repeat('f', 64), 'copy', 'Siding installation and repair in Wentzville.')));
  c := cd.try(format('select post_revision_write_copy(%L::jsonb)', jsonb_build_object('request_id', r.id, 'client_id', r.client_id,
         'claimant', 'worker-routine', 'expected_copy_hash', rv.h(sp.copy), 'copy', sp.copy)));
  d := cd.try(format('select post_revision_write_copy(%L::jsonb)', jsonb_build_object('request_id', r.id, 'client_id', cd.id('pr-other'),
         'claimant', 'worker-routine', 'expected_copy_hash', rv.h(sp.copy), 'copy', 'Other client.')));
  perform cd.save('pr7-refusals', concat_ws(' | ', a, b, c, d));
  perform cd.save('pr7-state-after-refusals', rv.state(cd.id('r3')));
  e := post_revision_write_copy(jsonb_build_object('request_id', r.id, 'client_id', r.client_id, 'claimant', 'worker-routine',
         'expected_copy_hash', rv.h(sp.copy), 'runtime', 'claude-worker-skill', 'brief_hash', 'sha256:' || repeat('b', 64),
         'lint', '{"ok": true}'::jsonb,
         'copy', 'Siding installation and repair in Wentzville: Revision Roofing Co replaces and repairs siding.'));
  perform cd.save('pr7', e::text);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - supabase_admin
do $$
declare r post_revision_requests := rv.req(cd.id('r3')); sp social_posts; e jsonb := cd.get('pr7')::jsonb;
begin
  select * into sp from social_posts where id = cd.id('r3');
  perform cd.ok('PR7 the caption writer refuses another claimant, stale copy, an unchanged caption and another client, changing nothing',
    cd.get('pr7-refusals') like 'CD409: claimed_by_other%| 23514: content_changed%| 23514: unchanged%| P0002: request_not_found%'
    and cd.get('pr7-state-after-refusals') = 'rejected/not_scheduled/open/working/not_needed', cd.get('pr7-refusals'));
  perform cd.ok('PR7b a valid caption revision returns the post for a FRESH review: new review task, nothing approved or scheduled',
    e->>'resubmitted' = 'true' and sp.review_status = 'in_review' and sp.publish_status = 'not_scheduled' and sp.approved_hash is null
    and sp.reviewed_by is null and sp.review_task_id is not null
    and (select status = 'open' and owner = 'CLAUDE_APPROVAL' from tasks where id = sp.review_task_id)
    and sp.copy like 'Siding installation and repair in Wentzville:%' and sp.service_id = cd.id('pr-siding')
    and r.status = 'returned' and r.copy_state = 'ready' and r.copy_result_hash = rv.h(sp.copy)
    and (select string_agg(kind || ':' || actor_kind, ',' order by id) from post_events where post_id = sp.id and kind in ('revised', 'edited', 'submitted')
          and id > (select max(id) from post_events where post_id = sp.id and kind = 'rejected')) = 'revised:drafter,edited:drafter,submitted:drafter'
    and exists (select 1 from post_revision_events where request_id = r.id and kind = 'revised' and actor_kind = 'drafter'
                  and detail->>'runtime' = 'claude-worker-skill' and detail->>'claimant' = 'worker-routine'),
    e::text || ' ' || rv.state(sp.id));
end $$;

-- ── PR8: mixed — the caption first, then ChatGPT's image ────────────────────
\c - postgres
\o /dev/null
select post_revision_claim((rv.req(cd.id('r4'))).id, 'worker-routine');
\o
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r post_revision_requests := rv.req(cd.id('r4')); sp social_posts; e jsonb; st text; rv text;
begin
  select * into sp from social_posts where id = cd.id('r4');
  e := post_revision_write_copy(jsonb_build_object('request_id', r.id, 'client_id', r.client_id, 'claimant', 'worker-routine',
         'expected_copy_hash', rv.h(sp.copy), 'runtime', 'claude-worker-skill', 'copy', 'Siding and repair in Wentzville, with free estimates.'));
  perform cd.save('pr8-copy', e::text);
  perform cd.save('pr8-mid', rv.state(cd.id('r4')));
  -- ChatGPT, through Executive OS: stage and revise the rejected-then-draft post.
  st := pe.stage(pe.stage_req('pr-stage-r4', cd.id('r4'), encode(sha256('pr-fixed-image'), 'hex')));
  rv := pe.revise(rv.media_req('pr-rev-r4', cd.id('r4'), st::uuid, encode(sha256('pr-fixed-image'), 'hex')),
                  pe.measured(encode(sha256('pr-fixed-image'), 'hex')));
  perform cd.save('pr8-image', rv);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - supabase_admin
do $$
declare r post_revision_requests := rv.req(cd.id('r4')); sp social_posts; rc content_edit_receipts;
begin
  select * into sp from social_posts where id = cd.id('r4');
  select * into rc from content_edit_receipts where operation_id = 'pr-rev-r4';
  perform cd.ok('PR8 mixed: the caption alone leaves a draft waiting for the image',
    (cd.get('pr8-copy')::jsonb)->>'resubmitted' = 'false' and (cd.get('pr8-copy')::jsonb)->'waiting_for' = '["image"]'::jsonb
    and cd.get('pr8-mid') = 'draft/not_scheduled/open/ready/queued', cd.get('pr8-copy') || ' ' || cd.get('pr8-mid'));
  perform cd.ok('PR8b ChatGPT''s image through content_edit meets the image and the post returns for a fresh review',
    cd.get('pr8-image') = 'executed' and rc.status = 'executed' and rc.result->'revision'->>'resubmitted' = 'true'
    and rv.state(sp.id) = 'in_review/not_scheduled/returned/ready/ready' and sp.approved_hash is null
    and (select content_hash = encode(sha256('pr-fixed-image'), 'hex') from post_assets where post_id = sp.id)
    and (select status = 'done' from post_revision_outbox where request_id = r.id)
    and exists (select 1 from post_revision_events where request_id = r.id and kind = 'revised' and obligation = 'image'
                  and actor_kind = 'assistant' and detail->'edit'->>'channel' = 'claude'),
    cd.get('pr8-image') || ' ' || rv.state(sp.id));
end $$;

-- ── PR9: the outbox (Executive OS through content-approvals) ────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare q jsonb := post_revision_outbox_pending(50); o post_revision_outbox; a jsonb; b jsonb; c text; d text;
begin
  perform cd.save('pr9-queue', q::text);
  select * into o from post_revision_outbox where request_id = (rv.req(cd.id('r1'))).id;
  a := post_revision_outbox_ack(o.id, 1, '{"id": "eos-task-1", "handoff_id": "h-1"}');
  b := post_revision_outbox_ack(o.id, 1, '{"id": "eos-task-1", "handoff_id": "h-1"}');
  c := cd.try(format('select post_revision_outbox_ack(%L, 1, ''{"id": "eos-task-2"}'')', o.id));
  d := cd.try(format('select post_revision_outbox_ack(%L, 2, ''{"id": "eos-task-1"}'')', o.id));
  perform cd.save('pr9', concat_ws(' | ', a->>'replayed', b->>'replayed', c, d));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - supabase_admin
do $$
declare q jsonb := cd.get('pr9-queue')::jsonb; i jsonb; r post_revision_requests := rv.req(cd.id('r1'));
begin
  select x into i from jsonb_array_elements(q) x where x->>'post_id' = cd.id('r1')::text;
  perform cd.ok('PR9 Executive OS reads the queued image work with what content_revise needs (never a mixed post already met, never copy work)',
    i->>'channel' = 'google_business' and i->>'destination' = 'google_business:locations/3692365240387501506'
    and i->>'service_id' = cd.id('pr-siding')::text and i->>'review_hash' like 'sha256:%' and i->>'feedback' like 'Get rid of the blue line%'
    and i->>'generation' = '1' and i->>'target' = 'chatgpt'
    and not exists (select 1 from jsonb_array_elements(q) x where x->>'post_id' in (cd.id('r3')::text, cd.id('r4')::text, cd.id('r2')::text)),
    q::text);
  perform cd.ok('PR9b one acknowledgement per delivery: a replay is idempotent, another receipt or a stale generation is refused',
    cd.get('pr9') like 'false | true | CD409: already_delivered% | CD409: stale_generation%'
    and r.image_state = 'working' and r.image_detail like 'Delivered to ChatGPT through Executive OS (receipt eos-task-1)%',
    cd.get('pr9'));
end $$;

-- ── PR10: a rendered Creative Engine graphic ────────────────────────────────
\c - supabase_admin
do $$
declare r post_revision_requests := rv.req(cd.id('r2'));
begin
  perform cd.ok('PR10 a rendered graphic is routed to a teammate''s re-render, never to ChatGPT',
    r.image_assignee = 'creative_engine' and r.image_state = 'queued' and r.image_detail like 'A Creative Engine graphic%'
    and not exists (select 1 from post_revision_outbox where request_id = r.id), to_jsonb(r)::text);
end $$;
-- The Creative Engine renders a new graphic (simulated by the cluster owner).
\o /dev/null
update social_posts set review_status = 'draft' where id = cd.id('r2');
delete from post_assets where post_id = cd.id('r2');
insert into post_assets (post_id, client_id, creative_asset_id, sort_order, role, content_hash, copy_hash)
values (cd.id('r2'), cd.id('pr'), cd.id('pr-ce2'), 1, 'media', repeat('d', 64), rv.h('Revision Roofing Co: rendered graphic post.'));
\o
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select cd.save('pr10', rv.step(cd.id('r2'), 'draft', 'in_review'));
\o
do $$
begin
  perform cd.ok('PR10b a new graphic meets the image; the post returns for a fresh review',
    cd.get('pr10') = '1' and rv.state(cd.id('r2')) = 'in_review/not_scheduled/returned/not_needed/ready', cd.get('pr10') || ' ' || rv.state(cd.id('r2')));
end $$;

-- ── PR11 / PR12 / PR13: teammate actions ────────────────────────────────────
\o /dev/null
do $$
declare r5 post_revision_requests := rv.req(cd.id('r5')); r6 post_revision_requests := rv.req(cd.id('r6'));
        r7 post_revision_requests := rv.req(cd.id('r7'));
begin
  perform post_revision_reopen_manual(r5.id);
  perform cd.save('pr11-state', rv.state(cd.id('r5')));
  perform cd.save('pr11-edit', cd.try(format('update social_posts set copy = %L where id = %L', 'Revision Roofing Co: a shorter post.', cd.id('r5'))));
  perform cd.save('pr11-submit', rv.step(cd.id('r5'), 'draft', 'in_review'));

  perform cd.save('pr12-nonote', cd.try(format('select post_revision_resolve(%L, ''copy'', '' '')', r6.id)));
  perform cd.save('pr12-image', cd.try(format('select post_revision_resolve(%L, ''image'', ''x'')', r6.id)));
  perform post_revision_resolve(r6.id, 'copy', 'The caption is right; the reviewer asked a question.');
  perform rv.step(cd.id('r6'), 'rejected', 'draft');
  perform cd.save('pr12-submit', rv.step(cd.id('r6'), 'draft', 'in_review'));

  perform cd.save('pr13-nonote', cd.try(format('select post_revision_reclassify(%L, ''creative'', '''')', r7.id)));
  perform post_revision_reclassify(r7.id, 'creative', 'The blue line is on the image, not the caption.');
end $$;
\o
do $$
declare r5 post_revision_requests := rv.req(cd.id('r5')); r6 post_revision_requests := rv.req(cd.id('r6'));
        r7 post_revision_requests := rv.req(cd.id('r7')); me uuid;
begin
  select id into me from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001';
  perform cd.ok('PR11 Reopen to edit (manual) stands the worker down; the teammate''s own edit meets the caption',
    cd.get('pr11-state') = 'draft/not_scheduled/open/manual/not_needed' and cd.get('pr11-edit') is null and cd.get('pr11-submit') = '1'
    and r5.mode = 'manual' and r5.status = 'returned' and r5.copy_state = 'ready'
    and not exists (select 1 from worker_fires where reason = 'Post revision request ' || r5.id and created_at > (select max(created_at) from post_revision_events where request_id = r5.id and kind = 'manual'))
    and exists (select 1 from post_revision_events where request_id = r5.id and kind = 'manual' and actor_kind = 'team' and actor_id = me),
    concat_ws(' | ', cd.get('pr11-state'), cd.get('pr11-edit'), cd.get('pr11-submit'), rv.state(cd.id('r5'))));
  perform cd.ok('PR12 "no change needed" needs a note and an obligation that was rejected; it is attributed and lets the post go back',
    cd.get('pr12-nonote') like '23514%Say why%' and cd.get('pr12-image') like '23514%The image was not rejected%'
    and cd.get('pr12-submit') = '1' and r6.copy_state = 'resolved' and r6.status = 'returned'
    and r6.copy_detail = 'No change needed: The caption is right; the reviewer asked a question.'
    and exists (select 1 from post_revision_events where request_id = r6.id and kind = 'resolved' and obligation = 'copy'
                  and actor_kind = 'team' and actor_id = me),
    concat_ws(' | ', cd.get('pr12-nonote'), cd.get('pr12-image'), cd.get('pr12-submit'), to_jsonb(r6)::text));
  perform cd.ok('PR13 a corrected category keeps the original in history, records the correction and queues the image for ChatGPT',
    cd.get('pr13-nonote') like '23514%Say why%'
    and r7.original_category = 'copy' and r7.category = 'creative' and r7.copy_state = 'not_needed' and r7.image_state = 'queued'
    and (select to_value = 'copy' from post_events where post_id = cd.id('r7') and kind = 'rejection_classified')
    and (select from_value = 'copy' and to_value = 'creative' and actor_kind = 'team' and actor_id = me
           and detail->>'note' = 'The blue line is on the image, not the caption.'
           from post_events where post_id = cd.id('r7') and kind = 'rejection_reclassified')
    and (select status = 'pending' from post_revision_outbox where request_id = r7.id),
    to_jsonb(r7)::text);
end $$;

-- ── PR14 / PR15: approval and a later rejection ─────────────────────────────
\o /dev/null
select cd.save('pr14', rv.step(cd.id('r3'), 'in_review', 'approved'));
select cd.save('pr15', rv.reject(cd.id('r2'), 'Still too dark.', 'both'));
\o
do $$
declare r3 post_revision_requests := rv.req(cd.id('r3'));
begin
  perform cd.ok('PR14 approval accepts the request; nothing is scheduled',
    cd.get('pr14') = '1' and r3.status = 'accepted' and r3.closed_at is not null
    and (select publish_status = 'not_scheduled' and scheduled_at is null from social_posts where id = cd.id('r3')), to_jsonb(r3)::text);
  perform cd.ok('PR15 a later rejection supersedes the request; the new one carries the new feedback',
    cd.get('pr15') = '1'
    and (select count(*) = 2 from post_revision_requests where post_id = cd.id('r2'))
    and (select status = 'superseded' from post_revision_requests where post_id = cd.id('r2') and feedback = 'The rendered graphic is too dark.')
    and (select status = 'open' and copy_state = 'queued' and image_state = 'queued' from post_revision_requests
          where post_id = cd.id('r2') and feedback = 'Still too dark.'), cd.get('pr15'));
end $$;

-- PR16: the destination changes while the worker holds the caption.
\o /dev/null
select rv.step(cd.id('r8'), 'rejected', 'draft');
update social_posts set social_account_id = cd.id('pr-gb2') where id = cd.id('r8');
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - postgres
\o /dev/null
select post_revision_claim((rv.req(cd.id('r8'))).id, 'worker-routine');
\o
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r post_revision_requests := rv.req(cd.id('r8')); sp social_posts;
begin
  select * into sp from social_posts where id = cd.id('r8');
  perform cd.save('pr16', cd.try(format('select post_revision_write_copy(%L::jsonb)', jsonb_build_object('request_id', r.id, 'client_id', r.client_id,
         'claimant', 'worker-routine', 'expected_copy_hash', rv.h(sp.copy), 'copy', 'Mention Wentzville: done.'))));
end $$;
\o
do $$
begin
  perform cd.ok('PR16 a destination changed since the rejection is refused by the caption writer',
    cd.get('pr16') like '23514: target_changed%' and (select copy = 'Revision Roofing Co: destination post.' from social_posts where id = cd.id('r8')),
    cd.get('pr16'));
end $$;

-- ── PR17: a chat-requested caption edit (replace_copy) ──────────────────────
\o /dev/null
do $$
begin
  perform cd.save('pr17-stale', pe.revise(rv.copy_req('pr-copy-r9-stale', cd.id('r9'), 'New caption.', repeat('e', 64)), '{}'));
  perform cd.save('pr17-scope', pe.revise(rv.copy_req('pr-copy-r9-scope', cd.id('r9'), 'New caption.', null, '["replace_media"]'), '{}'));
  perform cd.save('pr17-req', rv.copy_req('pr-copy-r9', cd.id('r9'), 'Revision Roofing Co: siding repair, as Tom asked in chat.')::text);
  perform cd.save('pr17', pe.revise(cd.get('pr17-req')::jsonb, '{}'));
  -- An exact retry acts once; the same operation for a different request conflicts.
  perform cd.save('pr17-replay', pe.revise(cd.get('pr17-req')::jsonb, '{}'));
  perform cd.save('pr17-reused', pe.revise(rv.copy_req('pr-copy-r9', cd.id('r9'), 'Another caption.'), '{}'));
  -- A rejected post whose caption was not rejected, and a caption the worker
  -- is revising, are not edited here.
  perform cd.save('pr17-notcopy', pe.revise(rv.copy_req('pr-copy-r7', cd.id('r7'), 'Edited by chat.'), '{}'));
  perform cd.save('pr17-claimed', pe.revise(rv.copy_req('pr-copy-r8', cd.id('r8'), 'Edited by chat.'), '{}'));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - supabase_admin
do $$
declare sp social_posts; rc content_edit_receipts;
begin
  select * into sp from social_posts where id = cd.id('r9');
  select * into rc from content_edit_receipts where operation_id = 'pr-copy-r9';
  perform cd.ok('PR17 replace_copy: a stale hash and an operation outside the authority are refused; the edit withdraws, changes the caption and resubmits, attributed to the assistant',
    cd.get('pr17-stale') like '23514 content_changed%' and cd.get('pr17-scope') like '23514 outside_authority%'
    and cd.get('pr17') = 'executed' and cd.get('pr17-replay') = 'replayed:executed' and cd.get('pr17-reused') like 'CD409 operation_reused%'
    and rc.stage_id is null
    and sp.copy = 'Revision Roofing Co: siding repair, as Tom asked in chat.' and sp.review_status = 'in_review' and sp.approved_hash is null
    and not exists (select 1 from post_assets where post_id = sp.id)  -- r9 had no media; still none
    and exists (select 1 from post_events where post_id = sp.id and kind = 'edited' and actor_kind = 'assistant' and detail->'edit'->>'receipt' = rc.id::text)
    and cd.get('pr17-notcopy') like '23514 not_editable%' and cd.get('pr17-claimed') like '23514 claimed_by_other: worker-routine%',
    concat_ws(' | ', cd.get('pr17-stale'), cd.get('pr17-scope'), cd.get('pr17'), cd.get('pr17-replay'), cd.get('pr17-notcopy'), cd.get('pr17-claimed')));
end $$;

-- ── PR18: the dispatcher unconfigured, then a retry ─────────────────────────
\o /dev/null
delete from vault.secrets where name in ('ROUTINE_FIRE_URL', 'ROUTINE_FIRE_TOKEN');
\o
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select cd.save('pr18-reject', rv.reject(cd.id('r10'), 'Mention siding repair.', 'copy'));
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - supabase_admin
\o /dev/null
insert into vault.secrets (name, secret) select name, secret from rv.saved_secrets;
\o
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select cd.save('pr18-blocked', rv.state(cd.id('r10')) || ' ' || coalesce((rv.req(cd.id('r10'))).task_id::text, 'no-task'));
select post_revision_request_correction((rv.req(cd.id('r10'))).id);
\o
do $$
declare r post_revision_requests := rv.req(cd.id('r10'));
begin
  perform cd.ok('PR18 an unconfigured dispatcher blocks the caption with one task for a person; the retry dispatches and reuses that task',
    cd.get('pr18-reject') = '1' and cd.get('pr18-blocked') like 'rejected/not_scheduled/open/blocked/not_needed %-%'
    and r.copy_state = 'queued' and r.task_id is not null
    and (select count(*) = 1 from tasks where key = 'post_revision:' || r.id)
    and exists (select 1 from post_revision_events where request_id = r.id and kind = 'dispatch_unconfigured')
    and exists (select 1 from post_revision_events where request_id = r.id and kind = 'dispatched'
                  and (detail->>'worker_fire_id') is not null),
    cd.get('pr18-blocked') || ' ' || to_jsonb(r)::text);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── PR19: backfill a legacy rejection ───────────────────────────────────────
-- r11: rejected before this migration (its request removed), reopened and
-- resubmitted unchanged — exactly the Lucas post. r12: rejected, then its
-- caption edited before resubmission.
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select rv.reject(cd.id('r11'), 'Legacy: get rid of the blue line.', 'copy');
select rv.reject(cd.id('r12'), 'Legacy: fix the caption.', 'copy');
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - supabase_admin
\o /dev/null
delete from post_revision_requests where post_id in (cd.id('r11'), cd.id('r12'));
\o
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select rv.step(cd.id('r11'), 'rejected', 'draft');
select rv.step(cd.id('r11'), 'draft', 'in_review');
select rv.step(cd.id('r12'), 'rejected', 'draft');
update social_posts set copy = 'Revision Roofing Co: legacy edited post, fixed.' where id = cd.id('r12');
select rv.step(cd.id('r12'), 'draft', 'in_review');
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - supabase_admin
\o /dev/null
select cd.save('pr19-n', post_revision_backfill()::text);
select cd.save('pr19-again', post_revision_backfill()::text);
\o
do $$
declare r11 post_revision_requests := rv.req(cd.id('r11')); r12 post_revision_requests := rv.req(cd.id('r12'));
begin
  perform cd.ok('PR19 backfill: the legacy rejection is recovered as a visible, manual, undispatched request with its feedback',
    cd.get('pr19-n')::int >= 2 and cd.get('pr19-again') = '0'
    and r11.legacy and r11.mode = 'manual' and r11.status = 'open' and r11.copy_state = 'manual'
    and r11.feedback = 'Legacy: get rid of the blue line.'
    and (select review_note is null and review_status = 'in_review' from social_posts where id = cd.id('r11'))
    and not exists (select 1 from worker_fires where reason = 'Post revision request ' || r11.id)
    and not exists (select 1 from post_revision_outbox where request_id = r11.id),
    to_jsonb(r11)::text);
  perform cd.ok('PR19b a caption changed after the legacy rejection counts as resolved by the backfill; the post stays in review',
    r12.legacy and r12.copy_state = 'resolved' and r12.status = 'returned' and r12.copy_detail like 'Resolved by the backfill%'
    and exists (select 1 from post_revision_events where request_id = r12.id and kind = 'resolved' and actor_kind = 'system'),
    to_jsonb(r12)::text);
end $$;

-- ── PR20: the review screen's caption edit (social_post_edit_caption) ──────
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare c9 text; c2 text;
begin
  select copy into c9 from social_posts where id = cd.id('r9');
  select copy into c2 from social_posts where id = cd.id('r2');
  perform cd.save('pr20-stale', cd.try(format('select social_post_edit_caption(%L, %L, %L)', cd.id('r9'), repeat('0', 64), 'Stale edit.')));
  perform cd.save('pr20-same', cd.try(format('select social_post_edit_caption(%L, %L, %L)', cd.id('r9'), rv.h(c9), c9)));
  perform cd.save('pr20-review', social_post_edit_caption(cd.id('r9'), rv.h(c9), 'Revision Roofing Co: Siding Installation and Repair.')::text);
  -- r2: rejected for both; the image (a Creative Engine graphic) is still owed.
  perform cd.save('pr20-mixed', social_post_edit_caption(cd.id('r2'), rv.h(c2), 'Revision Roofing Co: a brighter rendered graphic post.')::text);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - postgres
\o /dev/null
select cd.save('pr20-claim', post_revision_claim((rv.req(cd.id('r2'))).id, 'worker-routine')::text);
\o
\c - supabase_admin
do $$
declare r2 post_revision_requests := rv.req(cd.id('r2')); a jsonb := cd.get('pr20-review')::jsonb; b jsonb := cd.get('pr20-mixed')::jsonb;
begin
  perform cd.ok('PR20 caption edit on the review screen: stale and unchanged captions are refused; a post in review goes back for a fresh review',
    cd.get('pr20-stale') like '23514: The caption changed since this page loaded%' and cd.get('pr20-same') like '23514: The caption is unchanged%'
    and a->>'from' = 'in_review' and a->>'review_status' = 'in_review' and a->>'waiting' is null
    and (select copy = 'Revision Roofing Co: Siding Installation and Repair.' and approved_hash is null from social_posts where id = cd.id('r9')),
    concat_ws(' | ', cd.get('pr20-stale'), cd.get('pr20-same'), a::text));
  perform cd.ok('PR20b on a mixed rejection the teammate''s caption meets the caption, the post waits for the image, and the worker stands down',
    b->>'from' = 'rejected' and b->>'review_status' = 'draft' and b->>'waiting' like 'The rejection feedback is not addressed: the image is unchanged%'
    and r2.copy_state = 'ready' and r2.image_state = 'queued' and r2.status = 'open'
    and (cd.get('pr20-claim')::jsonb)->>'reason' = 'not_queued'
    and exists (select 1 from post_revision_events where request_id = r2.id and kind = 'revised' and obligation = 'copy' and actor_kind = 'team'),
    concat_ws(' | ', b::text, cd.get('pr20-claim'), to_jsonb(r2)::text));
end $$;

\c - supabase_admin
select status, count(*) from cd.results where name ~ '^PR[0-9]' group by status;
select n, status, name, detail from cd.results where name ~ '^PR[0-9]' and status <> 'pass' order by n;
do $$
begin
  if exists (select 1 from cd.results where name ~ '^PR[0-9]' and status = 'fail')
     or (select count(*) from cd.results where name ~ '^PR[0-9]') < 28 then
    raise exception 'post_revisions: % of % checks failed: %', (select count(*) from cd.results where name ~ '^PR[0-9]' and status = 'fail'),
      (select count(*) from cd.results where name ~ '^PR[0-9]'),
      (select string_agg(name || ' => ' || coalesce(left(detail, 900), ''), E'\n' order by n) from cd.results where name ~ '^PR[0-9]' and status = 'fail');
  end if;
end $$;
