-- Tests for migration 0045 (post record + human review gate), run by
-- scripts/test-portal-sandbox.sh against the full replay + fixtures, after
-- the other sandbox tests. Own harness schema (pr).
--
-- Callers are real sessions, the way each reaches production:
--   worker     psql as postgres (the Supabase connector's login)
--   person     psql as authenticator (PostgREST's login), role authenticated,
--              JWT claims in request.jwt.claims
--   publisher  psql as authenticator, role service_role
-- 0045 tells them apart by session_user, so the person and publisher checks
-- only pass on an authenticator connection — which is the point.
--
-- Fixtures are shaped like what the worker files today: the four first-month
-- Business Profile posts from a GBP Spec (a "what we do" post, a service
-- spotlight, a city spotlight and an offer), claims in all three states, a
-- standing offer and one with a window. Fictional data only.

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'
\set strngr '00000000-0000-4000-a000-000000000014'
\set rvw    '00000000-0000-4000-a000-000000000031'
\set ca     '00000000-0000-4000-b000-00000000000a'
\set cb     '00000000-0000-4000-b000-00000000000b'

\o /dev/null
-- ── Harness ─────────────────────────────────────────────────────────────────
create schema pr;
create table pr.results (n serial, status text, name text, detail text);
create table pr.ids (k text primary key, id uuid);
grant usage on schema pr to anon, authenticated, service_role;
grant insert, select on pr.results to anon, authenticated, service_role;
grant select, insert on pr.ids to anon, authenticated, service_role;
grant usage on sequence pr.results_n_seq to anon, authenticated, service_role;

create function pr.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into pr.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
-- NULL if the statement succeeded, else SQLSTATE: message.
create function pr.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function pr.cnt(p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin execute format('select count(*) from (%s) q', p_sql) into n; return n;
exception when others then return -1; end $$;
create function pr.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function pr.id(p_k text) returns uuid language sql stable as $$ select id from pr.ids where k = p_k $$;
grant execute on all functions in schema pr to anon, authenticated, service_role;

-- ── Fixtures (as postgres) ──────────────────────────────────────────────────
insert into auth.users (id, email, email_confirmed_at) values
  (:'rvw', 'sandbox-reviewer@compassmarketing.ai', now());
insert into team_members (name, email, role) values ('Post Reviewer', 'sandbox-reviewer@compassmarketing.ai', 'member');
insert into pr.ids select 'me', id from team_members where auth_user_id = :'team';
insert into pr.ids select 'reviewer', id from team_members where auth_user_id = :'rvw';

insert into services (id, client_id, name, status) values
  ('00000000-0000-4000-e000-00000000000a', :'ca', 'Drain cleaning', 'approved'),
  ('00000000-0000-4000-e000-00000000001a', :'ca', 'Water heaters', 'proposed'),
  ('00000000-0000-4000-e000-00000000000b', :'cb', 'Panel upgrades', 'approved');
insert into claims (id, client_id, claim, status, source, confirmed_by, confirmed_on) values
  ('00000000-0000-4000-f000-00000000000a', :'ca', 'Family owned since 1998', 'confirmed', null, 'Owner, intake call', now()),
  ('00000000-0000-4000-f000-00000000001a', :'ca', 'Licensed master plumber on every job', 'sourced', 'https://a.example.test/about', null, null),
  ('00000000-0000-4000-f000-00000000002a', :'ca', 'Fastest plumber in Springfield', 'unverified', null, null, null),
  ('00000000-0000-4000-f000-00000000000b', :'cb', 'Veteran owned', 'confirmed', null, 'Owner', now());
insert into offers (id, client_id, title, terms, source, starts_on, ends_on, status, confirmed_by, confirmed_on) values
  ('00000000-0000-4000-f100-00000000000a', :'ca', 'Free estimates', 'Free estimates on any drain job.', 'Client email', null, null, 'confirmed', 'Owner', now()),
  ('00000000-0000-4000-f100-00000000001a', :'ca', 'Fall drain special', '$79 drain clearing', 'Website banner', current_date - 3, current_date + 40, 'confirmed', 'Owner', now()),
  ('00000000-0000-4000-f100-00000000000b', :'cb', 'Panel check', 'Free panel check', 'Email', null, null, 'confirmed', 'Owner', now());
insert into brand_assets (id, client_id, kind, label, storage_path) values
  ('00000000-0000-4000-f200-00000000000a', :'ca', 'photo', 'Drain job, Nixa', '00000000-0000-4000-b000-00000000000a/photos/drain.jpg');

-- ── S. Shape ────────────────────────────────────────────────────────────────
do $$
begin
  perform pr.ok('S1 social_posts.status is gone',
    not exists (select 1 from information_schema.columns where table_name = 'social_posts' and column_name = 'status'));
  perform pr.ok('S2 social_post_status is gone', not exists (select 1 from pg_type where typname = 'social_post_status'));
  perform pr.ok('S3 google_business is a platform', 'google_business' = any (enum_range(null::social_platform)::text[]));
  perform pr.ok('S4 RLS on all four post tables',
    (select bool_and(relrowsecurity) from pg_class where oid in
      ('public.social_posts'::regclass, 'public.post_claims'::regclass, 'public.post_assets'::regclass, 'public.post_events'::regclass)));
  perform pr.ok('S5 anon holds no privilege on the post tables',
    not has_table_privilege('anon', 'public.social_posts', 'select,insert,update,delete,truncate')
    and not has_table_privilege('anon', 'public.post_claims', 'select,insert,update,delete,truncate')
    and not has_table_privilege('anon', 'public.post_assets', 'select,insert,update,delete,truncate')
    and not has_table_privilege('anon', 'public.post_events', 'select,insert,update,delete,truncate'));
  perform pr.ok('S6 post history is read-only over the API',
    not has_table_privilege('authenticated', 'public.post_events', 'insert,update,delete,truncate'));
  perform pr.ok('S7 no portal view reads a post table',
    not exists (select 1 from pg_views where viewname like 'portal\_%'
                and (definition ilike '%social_posts%' or definition ilike '%post_events%'
                     or definition ilike '%post_claims%' or definition ilike '%post_assets%')));
  perform pr.ok('S8 the daily recheck is scheduled',
    exists (select 1 from cron.job where jobname = 'social-posts-recheck' and command like '%recheck_social_posts%'));
  perform pr.ok('S9 internal post functions are not callable over the API',
    not exists (select 1 from pg_proc p where p.proname in
      ('post_caller_is_human', 'post_caller_kind', 'social_post_grounding_problems', 'social_post_snapshot',
       'recheck_social_posts', 'social_post_open_review_task', 'social_post_close_review_task')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));
  perform pr.ok('S10 the Reports tab source (published posts) is readable by the team',
    has_table_privilege('authenticated', 'public.social_posts', 'select'));
end $$;

-- ── W. The worker drafts the GBP Spec's four posts (SQL as postgres) ────────
do $$
declare v uuid; st text;
begin
  insert into social_posts (client_id, platform, search_intent, crm_facts_only, copy, cta_type, cta_url)
  values ('00000000-0000-4000-b000-00000000000a', 'google_business', 'navigational', true,
          'Sandbox Client A — plumbing in Springfield, MO. Call (417) 555-0100 or book at a.example.test.',
          'CALL', 'https://a.example.test/contact')
  returning id into v;
  insert into pr.ids values ('what_we_do', v);

  insert into social_posts (client_id, platform, search_intent, service_id, copy, cta_type, cta_url)
  values ('00000000-0000-4000-b000-00000000000a', 'google_business', 'commercial', '00000000-0000-4000-e000-00000000000a',
          'Slow drains? A licensed master plumber clears them the same week.', 'LEARN_MORE', 'https://a.example.test/drains')
  returning id into v;
  insert into pr.ids values ('spotlight', v);
  insert into post_claims (post_id, claim_id) values (v, '00000000-0000-4000-f000-00000000001a');
  insert into post_assets (post_id, brand_asset_id) values (v, '00000000-0000-4000-f200-00000000000a');

  insert into social_posts (client_id, platform, search_intent, copy)
  values ('00000000-0000-4000-b000-00000000000a', 'google_business', 'informational',
          'Fastest plumber in Springfield, family owned since 1998.')
  returning id into v;
  insert into pr.ids values ('city', v);
  insert into post_claims (post_id, claim_id) values
    (v, '00000000-0000-4000-f000-00000000000a'), (v, '00000000-0000-4000-f000-00000000002a');

  insert into social_posts (client_id, platform, post_type, offer_id, search_intent, copy, cta_type, cta_url)
  values ('00000000-0000-4000-b000-00000000000a', 'google_business', 'offer', '00000000-0000-4000-f100-00000000001a',
          'transactional', '$79 drain clearing this fall. Family owned since 1998.', 'BOOK', 'https://a.example.test/book')
  returning id into v;
  insert into pr.ids values ('offer', v);
  insert into post_claims (post_id, claim_id) values (v, '00000000-0000-4000-f000-00000000000a');

  perform pr.ok('W1 worker drafts carry no human author',
    not exists (select 1 from social_posts where author_kind <> 'worker' or created_by is not null));
  perform pr.ok('W2 each draft has a created event with no actor',
    (select count(*) from post_events where kind = 'created' and actor_kind = 'worker' and actor_id is null) = 4);

  update social_posts set review_status = 'in_review' where id in (pr.id('what_we_do'), pr.id('spotlight'), pr.id('offer'));
  perform pr.ok('W3 three grounded drafts submit',
    (select count(*) from social_posts where review_status = 'in_review') = 3);
  st := pr.try(format($q$update social_posts set review_status = 'in_review' where id = %L$q$, pr.id('city')));
  perform pr.ok('W4 the city post with an unverified claim cannot be submitted', st like '23514:%unverified%', st);

  perform pr.ok('W5 each submission opened an unassigned TOM post_review task on the post''s client',
    (select count(*) from social_posts p join tasks t on t.id = p.review_task_id and t.client_id = p.client_id
     where p.review_status = 'in_review' and t.key = 'post_review' and t.owner = 'TOM'
       and t.status = 'open' and t.assignee_id is null) = 3);
  perform pr.ok('W6 the review tasks carry the 0043 history (created, no actor)',
    (select count(*) from task_events e join social_posts p on p.review_task_id = e.task_id
     where e.kind = 'created' and e.actor_id is null) = 3);

  st := pr.try(format($q$update social_posts set review_status = 'approved' where id = %L$q$, pr.id('spotlight')));
  perform pr.ok('W7 the worker cannot approve', st like '42501:%', st);
  st := pr.try(format($q$update social_posts set review_status = 'rejected', review_note = 'x' where id = %L$q$, pr.id('spotlight')));
  perform pr.ok('W8 the worker cannot reject', st like '42501:%', st);
  st := pr.try(format($q$update social_posts set copy = 'rewritten' where id = %L$q$, pr.id('spotlight')));
  perform pr.ok('W9 submitted copy is frozen', st like '23514:%frozen%', st);
  st := pr.try(format($q$insert into post_claims (post_id, claim_id) values (%L, '00000000-0000-4000-f000-00000000000b')$q$, pr.id('city')));
  perform pr.ok('W10 another client''s claim cannot be linked', st like '23503:%', st);
end $$;

-- The worker pretending to be a person: SET ROLE + a team JWT on its own
-- connection. session_user stays postgres.
set role authenticated;
select pr.as_user('authenticated', :'team');
do $$
declare st text;
begin
  st := pr.try(format($q$update social_posts set review_status = 'approved' where id = %L$q$, pr.id('spotlight')));
  perform pr.ok('W11 a postgres session with a team JWT still cannot approve', st like '42501:%', st);
end $$;
reset role;

-- ── H. A person reviews through the API (authenticator → authenticated) ─────
\c - authenticator
set role authenticated;
select pr.as_user('authenticated', :'rvw');
do $$
declare r text[]; n bigint; st text;
begin
  perform pr.ok('H1 the reviewer sees the client''s posts', pr.cnt('select 1 from social_posts') = 4);
  r := social_post_readiness(pr.id('city'));
  perform pr.ok('H2 readiness names the unverified claim', array_to_string(r, ' ') like '%unverified%', array_to_string(r, ' | '));
  perform pr.ok('H3 a grounded post is ready', cardinality(social_post_readiness(pr.id('spotlight'))) = 0);

  update social_posts set review_status = 'approved' where id = pr.id('spotlight');
  update social_posts set review_status = 'approved', review_note = 'Good; standing offer checked.' where id = pr.id('offer');
  perform pr.ok('H4 two posts approved',
    (select count(*) from social_posts where review_status = 'approved') = 2);
  perform pr.ok('H5 reviewed_by is the reviewer''s team_members id, not the Auth UUID',
    (select bool_and(reviewed_by = pr.id('reviewer') and reviewed_by <> '00000000-0000-4000-a000-000000000031'::uuid)
     from social_posts where review_status = 'approved'));
  perform pr.ok('H6 approval froze the content with a hash',
    (select bool_and(approved_snapshot ->> 'copy' = copy and approved_hash ~ '^[0-9a-f]{64}$'
                     and jsonb_array_length(approved_snapshot -> 'assets') = case when id = pr.id('spotlight') then 1 else 0 end)
     from social_posts where review_status = 'approved'));
  perform pr.ok('H7 the offer post''s snapshot holds the offer terms verbatim',
    (select approved_snapshot -> 'offer' ->> 'terms' from social_posts where id = pr.id('offer')) = '$79 drain clearing');
  perform pr.ok('H8 approving closed the review tasks, recorded as the reviewer (0043 history)',
    (select count(*) from task_events e join social_posts p on p.review_task_id = e.task_id
     where p.review_status = 'approved' and e.kind = 'status' and e.to_value = 'done' and e.actor_id = pr.id('reviewer')) = 2);
  perform pr.ok('H9 the approved events name the reviewer',
    (select count(*) from post_events where kind = 'approved' and actor_kind = 'team' and actor_id = pr.id('reviewer')) = 2);

  st := pr.try(format($q$update social_posts set review_status = 'rejected' where id = %L$q$, pr.id('what_we_do')));
  perform pr.ok('H10 a rejection needs a reason', st like '23514:%', st);
  update social_posts set review_status = 'rejected', review_note = 'Add the service area.' where id = pr.id('what_we_do');
  perform pr.ok('H11 a person rejects with a note',
    (select review_status = 'rejected' and reviewed_by = pr.id('reviewer') from social_posts where id = pr.id('what_we_do')));

  -- Scheduling as a person keeps the approval as it was.
  update social_posts set scheduled_at = now() + interval '2 days' where id in (pr.id('spotlight'), pr.id('offer'));
  update social_posts set publish_status = 'scheduled' where id in (pr.id('spotlight'), pr.id('offer'));
  perform pr.ok('H12 scheduled posts keep their approval',
    (select bool_and(publish_status = 'scheduled' and review_status = 'approved' and reviewed_by = pr.id('reviewer'))
     from social_posts where id in (pr.id('spotlight'), pr.id('offer'))));
  st := pr.try(format($q$update social_posts set publish_status = 'publishing' where id = %L$q$, pr.id('spotlight')));
  perform pr.ok('H13 a person cannot start publishing', st like '42501:%', st);
end $$;

-- A person edits the claim the spotlight stands on (removes its source). The
-- approved, scheduled post goes back to review.
do $$
begin
  update claims set source = null where id = '00000000-0000-4000-f000-00000000001a';
  perform pr.ok('H14 a claim losing its source sends the approved post back to review, unscheduled',
    (select review_status = 'in_review' and publish_status = 'not_scheduled' and approved_hash is null
     from social_posts where id = pr.id('spotlight')));
  perform pr.ok('H15 the lapse opened a new review task and recorded why',
    (select count(*) from tasks t join social_posts p on p.review_task_id = t.id
     where p.id = pr.id('spotlight') and t.status = 'open' and t.notes like 'Sent back to review%') = 1
    and exists (select 1 from post_events where post_id = pr.id('spotlight') and kind = 'grounding_lapsed'
                and actor_kind = 'system' and detail::text like '%no source%'));
end $$;

-- Other sign-ins through the API see nothing.
select pr.as_user('authenticated', :'pa');
do $$
begin
  perform pr.ok('H16 a portal user sees no posts, links or history',
    pr.cnt('select 1 from social_posts') = 0 and pr.cnt('select 1 from post_events') = 0
    and pr.cnt('select 1 from post_claims') = 0);
  perform pr.ok('H17 a portal user cannot read readiness',
    pr.try(format('select social_post_readiness(%L)', pr.id('offer'))) like '42501:%');
end $$;
select pr.as_user('authenticated', :'strngr');
do $$
begin
  perform pr.ok('H18 a signed-in stranger sees no posts', pr.cnt('select 1 from social_posts') = 0);
end $$;
reset role;
set role anon;
select pr.as_user('anon', null);
do $$
begin
  perform pr.ok('H19 anon cannot read posts', pr.try('select 1 from social_posts') like '42501:%');
end $$;
reset role;

-- ── P. The publisher (authenticator → service_role) ─────────────────────────
set role service_role;
select pr.as_user('service_role', null);
do $$
declare st text; v_before record; v_after record;
begin
  select reviewed_by, reviewed_at, approved_hash into v_before from social_posts where id = pr.id('offer');
  update social_posts set publish_status = 'publishing' where id = pr.id('offer');
  update social_posts set publish_status = 'failed', error = 'Google: 429 quota' where id = pr.id('offer');
  update social_posts set publish_status = 'scheduled' where id = pr.id('offer');
  update social_posts set publish_status = 'publishing' where id = pr.id('offer');
  update social_posts set publish_status = 'published', external_post_id = 'accounts/1/locations/2/localPosts/9',
         published_url = 'https://business.google.example/posts/9', published_at = now()
  where id = pr.id('offer');
  select reviewed_by, reviewed_at, approved_hash, publish_attempts, publish_status into v_after
  from social_posts where id = pr.id('offer');
  perform pr.ok('P1 the publisher publishes after a failed attempt', v_after.publish_status = 'published' and v_after.publish_attempts = 2);
  perform pr.ok('P2 publishing and the retry left the approval untouched',
    (v_after.reviewed_by, v_after.reviewed_at, v_after.approved_hash) = (v_before.reviewed_by, v_before.reviewed_at, v_before.approved_hash));
  st := pr.try(format($q$update social_posts set review_status = 'approved' where id = %L$q$, pr.id('spotlight')));
  perform pr.ok('P3 the publisher cannot approve', st like '42501:%', st);
  st := pr.try(format($q$delete from social_posts where id = %L$q$, pr.id('offer')));
  perform pr.ok('P4 a published post stays on record', st like '23514:%', st);
end $$;
reset role;

-- ── Back to the worker for the last checks ──────────────────────────────────
\c - postgres
do $$
declare st text;
begin
  -- Retiring the offer after publication moves nothing; it is recorded.
  update offers set status = 'retired' where id = '00000000-0000-4000-f100-00000000001a';
  perform pr.ok('X1 a published post is not moved by a lapse',
    (select review_status = 'approved' and publish_status = 'published' from social_posts where id = pr.id('offer'))
    and exists (select 1 from post_events where post_id = pr.id('offer') and kind = 'grounding_lapsed'));
  st := pr.try($q$delete from clients where id = '00000000-0000-4000-b000-00000000000a'$q$);
  perform pr.ok('X2 a client with a published post cannot be deleted', st is not null, st);
  perform pr.ok('X3 every post event names a known actor kind and no Auth UUID',
    not exists (select 1 from post_events e where e.actor_id is not null
                and not exists (select 1 from team_members m where m.id = e.actor_id)));
end $$;

\o
-- ── Report ──────────────────────────────────────────────────────────────────
\pset footer off
select status, count(*) from pr.results group by status order by status;
select n, status, name, detail from pr.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from pr.results where status = 'fail';
  if f > 0 then raise exception '% social post review check(s) failed', f; end if;
end $$;
