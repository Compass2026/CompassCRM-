-- Tests for 20261116150000_review_to_delivery, run by
-- scripts/test-portal-sandbox.sh after the other post suites. Own harness
-- schema (rd), own fictional rows (ids d…), the same real sessions as
-- social_post_review.test.sql:
--   worker     psql as postgres
--   reviewer   psql as authenticator, role authenticated, team JWT
--   publisher  psql as authenticator, role service_role
--
-- The whole path: worker draft → review queue (ready / needs preparation) →
-- Approve & schedule (time + destination bound) → publisher claim → published,
-- and reject (copy / image) → revise → fresh review, plus the failure cases
-- the brief names: stale approvals, wrong client / destination, changed
-- media, duplicate calls and claims, a retry after an uncertain send, blocked
-- channels and held clients, past times, and discards that keep history.

\set team '00000000-0000-4000-a000-000000000001'
\set ca   '00000000-0000-4000-b000-00000000000a'
\set cb   '00000000-0000-4000-b000-00000000000b'

\o /dev/null
-- ── Harness ─────────────────────────────────────────────────────────────────
create schema rd;
create table rd.results (n serial, status text, name text, detail text);
create table rd.ids (k text primary key, id uuid);
grant usage on schema rd to anon, authenticated, service_role;
grant insert, select on rd.results to anon, authenticated, service_role;
grant select, insert on rd.ids to anon, authenticated, service_role;
grant usage on sequence rd.results_n_seq to anon, authenticated, service_role;
create function rd.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into rd.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function rd.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function rd.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function rd.id(p_k text) returns uuid language sql stable as $$ select id from rd.ids where k = p_k $$;
-- The queue row for one post (as the caller sees it).
create function rd.q(p_k text) returns jsonb language sql as $$
  select e from jsonb_array_elements(review_queue(null)) e where (e->>'id')::uuid = rd.id(p_k)
$$;
grant execute on all functions in schema rd to anon, authenticated, service_role;

-- ── Fixtures (as postgres): an approved service, a sourced claim, photos,
--    a Facebook Page bound to the publisher for each client ──────────────────
insert into services (id, client_id, name, status) values
  ('00000000-0000-4000-d000-00000000000a', :'ca', 'Sewer camera inspection', 'approved'),
  ('00000000-0000-4000-d000-00000000000b', :'cb', 'EV charger installs', 'approved');
insert into claims (id, client_id, claim, status, source) values
  ('00000000-0000-4000-d100-00000000000a', :'ca', 'Every inspection is recorded on video', 'sourced', 'https://a.example.test/camera'),
  ('00000000-0000-4000-d100-00000000000b', :'cb', 'Level 2 chargers installed in a day', 'sourced', 'https://b.example.test/ev');
insert into brand_assets (id, client_id, kind, label, storage_path) values
  ('00000000-0000-4000-d200-00000000000a', :'ca', 'photo', 'Camera inspection, Nixa', :'ca' || '/photos/camera.jpg'),
  ('00000000-0000-4000-d200-00000000001a', :'ca', 'photo', 'Van at a job, Ozark', :'ca' || '/photos/van.jpg'),
  ('00000000-0000-4000-d200-00000000002a', :'ca', 'photo', 'Lateral line, Republic', :'ca' || '/photos/lateral.jpg');
insert into social_accounts (id, client_id, platform, display_name, external_account_id) values
  ('00000000-0000-4000-d300-00000000000a', :'ca', 'facebook', 'Client A Page', '1110001'),
  ('00000000-0000-4000-d300-00000000000b', :'cb', 'facebook', 'Client B Page', '2220002');
-- The publisher setting is shared with later suites: kept and restored at the end.
create table rd.saved_settings as select key, value from app_settings where key = 'publisher';
insert into app_settings (key, value) values ('publisher', jsonb_build_object('enabled', true, 'clients', jsonb_build_array(:'ca', :'cb')))
on conflict (key) do update set value = excluded.value;

-- Worker drafts (only the cluster superuser stands in for post-drafter here).
\c - supabase_admin
do $$
declare v uuid; k text;
begin
  foreach k in array array['flow', 'approve_only', 'reject_copy', 'reject_image', 'no_image', 'held', 'blocked', 'dest', 'media', 'retry', 'discard'] loop
    insert into social_posts (client_id, platform, search_intent, service_id, social_account_id, copy)
    values ('00000000-0000-4000-b000-00000000000a', 'facebook', 'commercial', '00000000-0000-4000-d000-00000000000a',
            '00000000-0000-4000-d300-00000000000a',
            'Buying an older home? Every inspection is recorded on video, so you see the sewer line yourself (' || k || ').')
    returning id into v;
    insert into rd.ids values (k, v);
    insert into post_claims (post_id, claim_id) values (v, '00000000-0000-4000-d100-00000000000a');
    if k <> 'no_image' then
      insert into post_assets (post_id, brand_asset_id, sort_order)
      values (v, case when k = 'media' then '00000000-0000-4000-d200-00000000002a'::uuid else '00000000-0000-4000-d200-00000000000a'::uuid end, 0);
    end if;
  end loop;
  insert into social_posts (client_id, platform, search_intent, service_id, social_account_id, copy)
  values ('00000000-0000-4000-b000-00000000000b', 'facebook', 'commercial', '00000000-0000-4000-d000-00000000000b',
          '00000000-0000-4000-d300-00000000000b', 'Thinking about an EV? Level 2 chargers installed in a day.')
  returning id into v;
  insert into rd.ids values ('other_client', v);
  insert into post_claims (post_id, claim_id) values (v, '00000000-0000-4000-d100-00000000000b');
end $$;

-- The publisher verifies and binds both Pages (its own session and flag).
\c - authenticator
set role service_role;
select rd.as_user('service_role', null);
select set_config('compass.publish_binding', 'bind', false);
update social_accounts set publish_provider = 'zernio', publish_account_id = 'aaaaaaaaaaaaaaaaaaaaaaa' || right(id::text, 1), publish_enabled_by = (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001'), publish_page_id = external_account_id,
       publish_account_name = display_name, publish_verified_at = now(), publish_enabled = true,
       publish_health = '{"status":"healthy","tokenValid":true,"postingGranted":true}'
 where id in ('00000000-0000-4000-d300-00000000000a', '00000000-0000-4000-d300-00000000000b');
select set_config('compass.publish_binding', '', false);
reset role;

\c - postgres
update social_posts set review_status = 'in_review'
 where id in (select id from rd.ids where k <> 'discard');

-- ── S. Shape ────────────────────────────────────────────────────────────────
do $$
begin
  perform rd.ok('S1 the new functions are not callable by anon',
    not exists (select 1 from pg_proc p where p.proname in ('review_queue', 'social_post_approve_and_schedule',
                'social_post_set_no_image_reason', 'social_post_media_fingerprint', 'social_post_client_hold')
                and has_function_privilege('anon', p.oid, 'execute')));
  perform rd.ok('S2 the internal helpers are not callable by signed-in users',
    not has_function_privilege('authenticated', 'social_post_media_fingerprint(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'social_post_client_hold(uuid)', 'execute'));
  perform rd.ok('S3 post history is read-only to the team and closed to anon',
    has_table_privilege('authenticated', 'social_post_history', 'select')
    and not has_table_privilege('authenticated', 'social_post_history', 'insert,update,delete')
    and not has_table_privilege('anon', 'social_post_history', 'select'));
  perform rd.ok('S4 eleven drafts were submitted for review',
    (select count(*) from social_posts where id in (select id from rd.ids) and review_status = 'in_review') = 11);
end $$;

-- ── Q, A. The reviewer (authenticator → authenticated) ──────────────────────
\c - authenticator
set role authenticated;
select rd.as_user('authenticated', :'team');
do $$
declare st text; r jsonb; v_at timestamptz := date_trunc('minute', now()) + interval '1 day';
begin
  -- Q. The queue.
  perform rd.ok('Q1 a grounded post with a photo is ready for final review', rd.q('flow')->>'stage' = 'ready', rd.q('flow')::text);
  perform rd.ok('Q2 the queue shows the final copy, the photo and the destination',
    rd.q('flow')->>'copy' like 'Buying an older home?%' and jsonb_array_length(rd.q('flow')->'media') = 1
    and rd.q('flow')->'media'->0->>'bucket' = 'brand-assets' and rd.q('flow')->>'destination_name' = 'Client A Page');
  perform rd.ok('Q3 a post with no image and no stated reason needs preparation', rd.q('no_image')->>'stage' = 'needs_preparation');
  perform social_post_set_no_image_reason(rd.id('no_image'), 'No verified photo of this location yet.');
  perform rd.ok('Q4 a stated no-image reason makes it ready', rd.q('no_image')->>'stage' = 'ready'
    and rd.q('no_image')->>'no_image_reason' like 'No verified photo%');
  perform rd.ok('Q5 the queue lists both clients'' posts', rd.q('other_client') is not null);

  -- A. Approve & schedule: one decision, time and destination bound.
  st := rd.try(format('select social_post_approve_and_schedule(%L, %L, %L)', rd.id('flow'), now() - interval '1 hour', v_at));
  perform rd.ok('A1 a stale submission (wrong submitted_at) is refused', st like '23514:%changed since%', st);
  st := rd.try(format('select social_post_approve_and_schedule(%L, %L, %L)', rd.id('flow'),
               (select submitted_at from social_posts where id = rd.id('flow')), now() - interval '1 hour'));
  perform rd.ok('A2 a time that has passed is refused', st like '23514:%publish time%', st);
  perform rd.ok('A3 a refused decision changed nothing',
    (select review_status = 'in_review' and publish_status = 'not_scheduled' from social_posts where id = rd.id('flow')));

  r := social_post_approve_and_schedule(rd.id('flow'), (select submitted_at from social_posts where id = rd.id('flow')), v_at, 'Looks right.');
  perform rd.ok('A4 Approve & schedule approves and schedules in one step',
    r->>'review_status' = 'approved' and r->>'publish_status' = 'scheduled' and (r->>'scheduled_at')::timestamptz = v_at, r::text);
  perform rd.ok('A5 the approval names its time and destination',
    (select approved_publish_at = v_at and approved_destination = 'facebook:1110001' and approved_hash is not null
     from social_posts where id = rd.id('flow')));
  perform rd.ok('A6 the queue shows it scheduled', rd.q('flow')->>'stage' = 'scheduled');
  st := rd.try(format('select social_post_approve_and_schedule(%L, %L, %L)', rd.id('flow'),
               (select submitted_at from social_posts where id = rd.id('flow')), v_at));
  perform rd.ok('A7 a duplicate Approve & schedule is refused and schedules nothing twice', st like '23514:%', st);
  st := rd.try(format('update social_posts set scheduled_at = %L where id = %L', v_at + interval '2 hours', rd.id('flow')));
  perform rd.ok('A8 moving a time-bound approval is refused', st like '23514:%approved for%reopen%', st);
  st := rd.try(format($q$update social_posts set publish_status = 'not_scheduled' where id = %L$q$, rd.id('flow')));
  perform rd.ok('A9 unscheduling a time-bound approval is refused', st like '23514:%reopen%', st);

  -- B. Approve only never schedules.
  update social_posts set review_status = 'approved' where id = rd.id('approve_only');
  perform rd.ok('B1 Approve alone leaves the post unscheduled with no time bound',
    (select review_status = 'approved' and publish_status = 'not_scheduled' and approved_publish_at is null
     from social_posts where id = rd.id('approve_only')));
  perform rd.ok('B2 the queue shows it approved, not scheduled', rd.q('approve_only')->>'stage' = 'approved');
  st := rd.try(format($q$update social_posts set scheduled_at = now() - interval '2 days', publish_status = 'scheduled' where id = %L$q$, rd.id('approve_only')));
  perform rd.ok('B3 a later schedule in the past is refused', st like '23514:%not passed%', st);
end $$;
-- A separate request (its own transaction), as the Schedule form is.
do $$
declare st text;
begin
  update social_posts set scheduled_at = now() + interval '3 days', publish_status = 'scheduled' where id = rd.id('approve_only');
  perform rd.ok('B4 a separate later schedule is a separate decision (not bound to the approval)',
    (select publish_status = 'scheduled' and approved_publish_at is null from social_posts where id = rd.id('approve_only')));

  -- I. Blocked channels and held clients.
  update social_posts set review_status = 'approved' where id = rd.id('dest');  -- approve-only first, for E below
  perform rd.ok('I0 setup', true);
end $$;
reset role;

-- The worker switches the Page's publishing off and holds a client.
\c - authenticator
set role service_role;
select rd.as_user('service_role', null);
select set_config('compass.publish_binding', 'bind', false);
update social_accounts set publish_enabled = false where id = '00000000-0000-4000-d300-00000000000b';
select set_config('compass.publish_binding', '', false);
reset role;
\c - authenticator
set role authenticated;
select rd.as_user('authenticated', :'team');
do $$
declare st text;
begin
  st := rd.try(format('select social_post_approve_and_schedule(%L, %L, %L)', rd.id('other_client'),
               (select submitted_at from social_posts where id = rd.id('other_client')), now() + interval '1 day'));
  perform rd.ok('I1 a channel with publishing off can be approved, not approved-and-scheduled',
    st like '23514:%only be approved%Publishing is not enabled%', st);
  perform rd.ok('I2 ...and the queue still offers it for review with the publisher''s reason',
    rd.q('other_client')->>'stage' = 'needs_preparation'  -- no image yet; the channel itself does not hide it
    and rd.q('other_client')->>'publish_problems' like '%Publishing is not enabled%', rd.q('other_client')::text);
end $$;
reset role;

\c - postgres
update clients set status = 'paused' where id = '00000000-0000-4000-b000-00000000000b';
\c - authenticator
set role authenticated;
select rd.as_user('authenticated', :'team');
do $$
declare st text;
begin
  perform rd.ok('I3 a paused client''s post shows as blocked', rd.q('other_client')->>'stage' = 'blocked');
  update social_posts set review_status = 'approved' where id = rd.id('other_client');
  st := rd.try(format($q$update social_posts set scheduled_at = now() + interval '1 day', publish_status = 'scheduled' where id = %L$q$, rd.id('other_client')));
  perform rd.ok('I4 nothing is scheduled for a paused client', st like '23514:%held client%paused%', st);
end $$;
reset role;

-- ── P. The publisher (authenticator → service_role) ─────────────────────────
set role service_role;
select rd.as_user('service_role', null);
do $$
declare st text; n int;
begin
  -- The flow post is due (the publisher may claim early in a test; the time is the tick's concern).
  update social_posts set publish_status = 'publishing' where id = rd.id('flow') and publish_status = 'scheduled';
  get diagnostics n = row_count;
  perform rd.ok('P1 the publisher claims the scheduled post', n = 1);
  update social_posts set publish_status = 'publishing' where id = rd.id('flow') and publish_status = 'scheduled';
  get diagnostics n = row_count;
  perform rd.ok('P2 a duplicate claim (second tick) takes nothing', n = 0);
  update social_posts set publish_status = 'published', external_post_id = '1110001_99', published_url = 'https://www.facebook.com/1110001/posts/99',
         published_at = now() where id = rd.id('flow');
  perform rd.ok('P3 published with the provider id and URL; the approval is untouched',
    (select publish_status = 'published' and external_post_id = '1110001_99' and approved_hash is not null and approved_publish_at is not null
     from social_posts where id = rd.id('flow')));

  -- H. Retry after an uncertain / failed send keeps the decision.
  update social_posts set publish_status = 'publishing' where id = rd.id('approve_only');
  update social_posts set publish_status = 'failed', error = 'Zernio: no answer (uncertain)' where id = rd.id('approve_only');
  update social_posts set publish_status = 'scheduled', scheduled_at = now() + interval '10 minutes' where id = rd.id('approve_only');
  perform rd.ok('H1 the publisher re-queues its own failed attempt (bounded retry) with the approval intact',
    (select publish_status = 'scheduled' and review_status = 'approved' and publish_attempts = 1 from social_posts where id = rd.id('approve_only')));
end $$;
reset role;

-- ── R. Reject → feedback → revise → fresh review; E/M: destination and media ─
set role authenticated;
select rd.as_user('authenticated', :'team');
do $$
declare st text;
begin
  perform rd.ok('Q6 the queue shows the published post with its URL',
    rd.q('flow')->>'stage' = 'published' and rd.q('flow')->>'published_url' like 'https://www.facebook.com/%');

  -- Copy rejection.
  update social_posts set review_status = 'rejected', review_note = 'Lead with the buyer''s question, not the video.',
         rejection_category = 'copy' where id = rd.id('reject_copy');
  perform rd.ok('R1 the rejection records the rejected copy', (select rejected_copy_hash is not null and rejected_media_hash is null
     from social_posts where id = rd.id('reject_copy')));
  perform rd.ok('R2 the queue shows it revising with the feedback',
    rd.q('reject_copy')->>'stage' = 'revising' and rd.q('reject_copy')->>'last_feedback' like 'Lead with%');
  update social_posts set review_status = 'draft' where id = rd.id('reject_copy');  -- revise
  st := rd.try(format($q$update social_posts set review_status = 'in_review' where id = %L$q$, rd.id('reject_copy')));
  perform rd.ok('R3 unchanged rejected copy cannot go back to review', st like '23514:%copy is unchanged%Lead with%', st);
  update social_posts set copy = 'Buying an older home and wondering about the sewer line? Every inspection is recorded on video.'
   where id = rd.id('reject_copy');
  update social_posts set review_status = 'in_review' where id = rd.id('reject_copy');
  perform rd.ok('R4 revised copy goes back for a fresh review, never approved by itself',
    (select review_status = 'in_review' and approved_hash is null and reviewed_by is null and rejected_copy_hash is null
     from social_posts where id = rd.id('reject_copy')));
  perform rd.ok('R5 history keeps the rejection, the copy change and the resubmission',
    (select array_agg(kind order by id) from social_post_history where post_id = rd.id('reject_copy'))
      = array['rejected', 'copy_changed', 'resubmitted']
    and (select note from social_post_history where post_id = rd.id('reject_copy') and kind = 'rejected') like 'Lead with%'
    and (select detail->>'previous_copy' from social_post_history where post_id = rd.id('reject_copy') and kind = 'copy_changed') like '%(reject_copy)%');

  -- Image rejection (a brand photo, not a Creative Engine graphic).
  update social_posts set review_status = 'rejected', review_note = 'Wrong photo: that job was in Ozark.',
         rejection_category = 'creative' where id = rd.id('reject_image');
  perform rd.ok('R6 an attached photo can be rejected on its own', (select rejection_category = 'creative'
     and rejected_media_hash is not null and rejected_copy_hash is null from social_posts where id = rd.id('reject_image')));
  update social_posts set review_status = 'draft' where id = rd.id('reject_image');
  st := rd.try(format($q$update social_posts set review_status = 'in_review' where id = %L$q$, rd.id('reject_image')));
  perform rd.ok('R7 the same photo cannot be resubmitted', st like '23514:%image is unchanged%', st);
  delete from post_assets where post_id = rd.id('reject_image');
  insert into post_assets (post_id, brand_asset_id, sort_order) values (rd.id('reject_image'), '00000000-0000-4000-d200-00000000001a', 0);
  update social_posts set review_status = 'in_review' where id = rd.id('reject_image');
  perform rd.ok('R8 with a different photo (copy untouched) it returns to review',
    (select review_status = 'in_review' from social_posts where id = rd.id('reject_image')));
  st := rd.try(format($q$update social_posts set review_status = 'rejected', review_note = 'x', rejection_category = 'creative' where id = %L$q$, rd.id('no_image')));
  perform rd.ok('R9 a post with no image can only have its copy rejected', st like '23514:%no image%', st);

  -- E. Destination binding: an approved post whose Page binding changes.
  perform rd.ok('E0 the approve-only post names its destination', (select approved_destination = 'facebook:1110001' from social_posts where id = rd.id('dest')));
end $$;
reset role;

\c - authenticator
set role service_role;
select rd.as_user('service_role', null);
select set_config('compass.publish_binding', 'bind', false);
update social_accounts set publish_page_id = '1119999', external_account_id = '1119999' where id = '00000000-0000-4000-d300-00000000000a';
select set_config('compass.publish_binding', '', false);
reset role;
\c - authenticator
set role authenticated;
select rd.as_user('authenticated', :'team');
do $$
declare st text;
begin
  st := rd.try(format($q$update social_posts set scheduled_at = now() + interval '1 day', publish_status = 'scheduled' where id = %L$q$, rd.id('dest')));
  perform rd.ok('E1 a post approved for one Page is not scheduled to another', st like '23514:%Page or location changed%', st);
end $$;
reset role;
\c - authenticator
set role service_role;
select rd.as_user('service_role', null);
select set_config('compass.publish_binding', 'bind', false);
update social_accounts set publish_page_id = '1110001', external_account_id = '1110001' where id = '00000000-0000-4000-d300-00000000000a';
select set_config('compass.publish_binding', '', false);
reset role;
\c - authenticator
set role authenticated;
select rd.as_user('authenticated', :'team');
do $$
declare st text;
begin
  -- Media: an approved, scheduled post whose photo changes goes back to review (0045's recheck), losing its time.
  perform social_post_approve_and_schedule(rd.id('media'), (select submitted_at from social_posts where id = rd.id('media')), now() + interval '2 days');
  perform rd.ok('M0 setup: scheduled with a bound time', (select approved_publish_at is not null from social_posts where id = rd.id('media')));
end $$;
reset role;
\c - postgres
update brand_assets set storage_path = '00000000-0000-4000-b000-00000000000a/photos/lateral-v2.jpg' where id = '00000000-0000-4000-d200-00000000002a';
\c - authenticator
set role authenticated;
select rd.as_user('authenticated', :'team');
do $$
declare st text;
begin
  perform rd.ok('M1 a changed photo sends the approved post back to review, unscheduled, decision cleared',
    (select review_status = 'in_review' and publish_status = 'not_scheduled' and approved_publish_at is null and approved_hash is null
     from social_posts where id = rd.id('media')));

  -- Retry after failure: a time-bound approval is not silently moved by a person.
  perform social_post_approve_and_schedule(rd.id('retry'), (select submitted_at from social_posts where id = rd.id('retry')), now() + interval '30 minutes');
end $$;
reset role;
set role service_role;
select rd.as_user('service_role', null);
update social_posts set publish_status = 'publishing' where id = (select id from rd.ids where k = 'retry');
update social_posts set publish_status = 'failed', error = 'Zernio: 503' where id = (select id from rd.ids where k = 'retry');
reset role;
set role authenticated;
select rd.as_user('authenticated', :'team');
do $$
declare st text;
begin
  st := rd.try(format($q$update social_posts set scheduled_at = now() + interval '1 day', publish_status = 'scheduled' where id = %L$q$, rd.id('retry')));
  perform rd.ok('H2 after a failure, a person cannot move a time-bound approval to a new time', st like '23514:%reopen%', st);
  perform rd.ok('H3 the queue shows it failed with the error', rd.q('retry')->>'stage' = 'failed' and rd.q('retry')->>'error' like 'Zernio: 503%');
  update social_posts set review_status = 'draft' where id = rd.id('retry');  -- reopen
  perform rd.ok('H4 reopening clears the approval and its time',
    (select review_status = 'draft' and publish_status = 'not_scheduled' and approved_publish_at is null and approved_hash is null
     from social_posts where id = rd.id('retry')));

  -- Discard keeps the record.
  delete from social_posts where id = rd.id('discard');
  perform rd.ok('D1 a discarded draft leaves its full record in history',
    (select count(*) from social_post_history where post_id = rd.id('discard') and kind = 'discarded'
       and detail->'post'->>'copy' like '%(discard)%' and jsonb_array_length(detail->'events') >= 1
       and jsonb_array_length(detail->'media') = 1) = 1);
end $$;
reset role;

-- ── O. The owner's delegated decision binds the time too ────────────────────
\c - postgres
do $$
declare st text;
begin
  -- An approve-only post scheduled under the delegated write marker (as
  -- content_authorization_execute does for "publish") binds that time.
  update social_posts set publish_status = 'not_scheduled' where id = rd.id('approve_only') and publish_status = 'scheduled';
  perform set_config('compass.delegation_write', 'on', true);
  update social_posts set publish_status = 'scheduled', scheduled_at = date_trunc('minute', now()) + interval '4 days'
   where id = rd.id('approve_only');
  perform set_config('compass.delegation_write', '', true);
  perform rd.ok('O1 the owner''s delegated publish binds its time',
    (select approved_publish_at = scheduled_at from social_posts where id = rd.id('approve_only')));
  st := rd.try(format($q$update social_posts set scheduled_at = now() + interval '5 days' where id = %L$q$, rd.id('approve_only')));
  perform rd.ok('O2 ...which the worker cannot then move', st like '23514:%reopen%', st);
  st := rd.try(format($q$update social_posts set approved_publish_at = now() where id = %L$q$, rd.id('dest')));
  perform rd.ok('O3 nobody writes the binding columns directly',
    (select approved_publish_at is null from social_posts where id = rd.id('dest')), st);
  update clients set status = 'active' where id = '00000000-0000-4000-b000-00000000000b';
end $$;
-- Leave the shared publisher setting as it was.
delete from app_settings where key = 'publisher';
insert into app_settings (key, value) select key, value from rd.saved_settings;

-- Unbind the two fictional Pages again (later suites start with none enabled).
\c - authenticator
set role service_role;
select rd.as_user('service_role', null);
select set_config('compass.publish_binding', 'bind', false);
update social_accounts set publish_enabled = false, publish_enabled_by = null, publish_enabled_at = null, publish_provider = null,
       publish_account_id = null, publish_page_id = null, publish_account_name = null, publish_verified_at = null, publish_health = null
 where id in ('00000000-0000-4000-d300-00000000000a', '00000000-0000-4000-d300-00000000000b');
select set_config('compass.publish_binding', '', false);
reset role;
\c - postgres

\o
-- ── Report ──────────────────────────────────────────────────────────────────
\pset footer off
select status, count(*) from rd.results group by status order by status;
select n, status, name, detail from rd.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from rd.results where status = 'fail';
  if f > 0 then raise exception '% review-to-delivery check(s) failed', f; end if;
end $$;
