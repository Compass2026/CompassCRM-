-- Tests for 20261019202359 (delegated approval for every client and for
-- Facebook / Business Profile posts), run by scripts/test-portal-sandbox.sh
-- after content_delegation.test.sql (its cd harness and cd.dg_authorize).
-- A fictional client with a bound, enabled, healthy Facebook Page and
-- Business Profile location, on the publisher's pilot list.
--
--   DC1-DC4   the central policy: on for every client by default; an admin
--             excludes a client or one channel and includes it again; a
--             non-admin cannot; switched off refuses everything; a paused
--             client is never delegated
--   DC5-DC7   the batch: posts with their Page / location, images, review
--             hash, and whether the publisher would send them
--   DC8-DC10  approve a Facebook post: approved, Tom the reviewer, the note
--             names the assistant, history is a team action by Tom, nothing
--             scheduled; the service role alone still cannot approve
--   DC11-DC15 binding: wrong channel, wrong Page, changed copy (withdrawn,
--             edited, resubmitted), an unbound Page refuses publishing (approval
--             alone still allowed), a stale approval refuses publish
--   DC16-DC18 approve and publish Facebook + Business Profile: scheduled at
--             the authorized time for the existing publisher; a duplicate
--             operation schedules nothing twice
--   DC19-DC22 status: scheduled, queued, publishing, published with the
--             live URL and the provider's post id, failed with the error,
--             and a retry of the failed post by a new instruction

\set team '00000000-0000-4000-a000-000000000001'

\c - supabase_admin
\o /dev/null
create table cd.publisher_before as select value from app_settings where key = 'publisher';
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-a000-0000000000d7', 'dc-member@compassmarketing.ai', now());
insert into team_members (auth_user_id, name, email, role) values
  ('00000000-0000-4000-a000-0000000000d7', 'Delegation Channel Member', 'dc-member@compassmarketing.ai', 'member');
insert into clients (id, name, city, state, status) values
  (cd.id('dgs'), 'Delegation Social Co (fictional)', 'Columbia', 'MO', 'active'),
  (cd.id('dgs-paused'), 'Paused Social Co (fictional)', 'Columbia', 'MO', 'paused');
insert into app_settings (key, value) values ('publisher', jsonb_build_object('enabled', true, 'clients', jsonb_build_array(cd.id('dgs')::text)))
on conflict (key) do update set value = jsonb_set(jsonb_set(coalesce(app_settings.value, '{}'), '{enabled}', 'true'),
  '{clients}', coalesce(app_settings.value->'clients', '[]'::jsonb) || jsonb_build_array(cd.id('dgs')::text));
insert into social_accounts (id, client_id, platform, external_account_id, display_name) values
  (cd.id('dgs-fb'), cd.id('dgs'), 'facebook', '555000111222', 'DGS Page'),
  (cd.id('dgs-fb-unbound'), cd.id('dgs'), 'facebook', '555000999888', 'DGS Second Page'),
  (cd.id('dgs-p-fb'), cd.id('dgs-paused'), 'facebook', '444000111222', 'Paused Page');
\o

-- The publisher binds the Page and the location (its service session).
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
select publisher_bind_account(cd.id('dgs-fb'), 'aaaaaaaaaaaaaaaaaaaaaaa9', '555000111222', 'DGS Page', '{"status": "healthy"}');
select cd.save('dgs-gbp', (publisher_bind_gbp_location(cd.id('dgs'), 'bbbbbbbbbbbbbbbbbbbbbbb9', 'locations/9876543210',
  'DGS Location', 'DGS', '{"status": "healthy"}'))->>'social_account_id');
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- A team admin enables both (as on the Settings page).
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select publisher_set_account_enabled(cd.id('dgs-fb'), true, 'aaaaaaaaaaaaaaaaaaaaaaa9');
select publisher_set_account_enabled(coalesce(cd.get('dgs-gbp')::uuid,
  (select id from social_accounts where client_id = cd.id('dgs') and platform = 'google_business')), true, 'bbbbbbbbbbbbbbbbbbbbbbb9');
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - supabase_admin
\o /dev/null
select cd.save('dgs-gbp', id::text) from social_accounts where client_id = cd.id('dgs') and platform = 'google_business';
insert into social_posts (id, client_id, platform, search_intent, crm_facts_only, copy, social_account_id) values
  (cd.id('fb1'), cd.id('dgs'), 'facebook', 'navigational', true, 'Delegation Social Co, roofing in Columbia. One.', cd.id('dgs-fb')),
  (cd.id('fb2'), cd.id('dgs'), 'facebook', 'navigational', true, 'Delegation Social Co, roofing in Columbia. Two.', cd.id('dgs-fb')),
  (cd.id('fb3'), cd.id('dgs'), 'facebook', 'navigational', true, 'Delegation Social Co, roofing in Columbia. Three.', cd.id('dgs-fb')),
  (cd.id('fbu'), cd.id('dgs'), 'facebook', 'navigational', true, 'Delegation Social Co, roofing in Columbia. Unbound.', cd.id('dgs-fb-unbound')),
  (cd.id('gb1'), cd.id('dgs'), 'google_business', 'navigational', true, 'Delegation Social Co, roofing in Columbia. Profile.', cd.get('dgs-gbp')::uuid),
  (cd.id('pfb'), cd.id('dgs-paused'), 'facebook', 'navigational', true, 'Paused Social Co, roofing in Columbia.', cd.id('dgs-p-fb'));
update social_posts set review_status = 'in_review' where id in (cd.id('fb1'), cd.id('fb2'), cd.id('fb3'), cd.id('fbu'), cd.id('gb1'), cd.id('pfb'));
-- What content-approvals sends for social items, built from the batch.
create function cd.dg_social(p_op text, p_action text, p_posts uuid[], p_text text, p_client uuid default cd.id('dgs')) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b jsonb := content_review_batch(p_client);
begin
  return jsonb_build_object('operation_id', p_op, 'client_id', p_client, 'action', p_action,
    'items', (select jsonb_agg(jsonb_build_object('channel', x->>'channel', 'id', x->>'id', 'review_hash', x->>'review_hash',
                                                   'destination', x->>'destination') order by array_position(p_posts, (x->>'id')::uuid))
                from jsonb_array_elements(b->'items') x where (x->>'id')::uuid = any (p_posts)),
    'instruction_text', p_text, 'channel', 'chatgpt', 'account_email', 'sandbox-team@compassmarketing.ai',
    'executed_by', 'ChatGPT via Executive OS', 'source_ref', '{"surface": "sandbox"}'::jsonb)
    || case when p_action = 'approve' then '{}'::jsonb else jsonb_build_object('publish_at', now() + interval '2 hours') end;
end $$;
grant execute on all functions in schema cd to anon, authenticated, service_role, authenticator, postgres;
\o

-- ── The central policy ──────────────────────────────────────────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare b jsonb := content_review_batch(cd.id('dgs')); fb jsonb; ub jsonb; gb jsonb; e text;
begin
  perform cd.ok('DC1 every client and channel is delegated by default',
    (b#>>'{policy,facebook,publish}')::boolean and (b#>>'{policy,google_business,publish}')::boolean and (b#>>'{policy,blog,publish}')::boolean, b->>'policy');
  select x into fb from jsonb_array_elements(b->'items') x where x->>'id' = cd.id('fb1')::text;
  select x into ub from jsonb_array_elements(b->'items') x where x->>'id' = cd.id('fbu')::text;
  select x into gb from jsonb_array_elements(b->'items') x where x->>'id' = cd.id('gb1')::text;
  perform cd.ok('DC5 the batch binds a Facebook post to its Page and a Profile post to its location',
    fb->>'channel' = 'facebook' and fb->>'destination' = 'facebook:555000111222' and fb->>'destination_name' = 'DGS Page'
    and gb->>'channel' = 'google_business' and gb->>'destination' = 'google_business:locations/9876543210'
    and fb->>'review_hash' ~ '^sha256:[0-9a-f]{64}$' and fb->>'review_hash' <> gb->>'review_hash', b::text);
  perform cd.ok('DC6 the publisher would send the bound posts; the unbound Page says why not',
    jsonb_array_length(fb->'publish_problems') = 0 and jsonb_array_length(gb->'publish_problems') = 0
    and ub->>'publish_problems' like '%not bound to the publisher%', ub::text);
  perform cd.ok('DC7 a channel filter returns only that channel',
    (select bool_and(x->>'channel' = 'google_business') and count(*) = 1 from jsonb_array_elements(content_review_batch(cd.id('dgs'), 'google_business')->'items') x));
  e := cd.dg_authorize(cd.dg_social('dc-paused-1', 'approve', array[cd.id('pfb')], 'Approve the post', cd.id('dgs-paused')));
  perform cd.ok('DC4 a paused client is refused', e like '42501%policy_disallows%paused%', e);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- Exclusions are the admin's; a member cannot.
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select cd.save('dc-excl', (content_delegation_exclude(cd.id('dgs'), 'facebook', 'sandbox: Facebook held'))->>'id');
\o
reset role;
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare e text;
begin
  e := cd.dg_authorize(cd.dg_social('dc-excl-1', 'approve', array[cd.id('fb1')], 'Approve the Facebook post'));
  perform cd.ok('DC2 an excluded client channel is refused; its other channels are not',
    e like '42501%policy_disallows%excluded%for facebook%'
    and content_delegation_refusal(cd.id('dgs'), 'google_business', 'publish') is null, e);
end $$;
\o
reset role;
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select content_delegation_include(cd.get('dc-excl')::uuid);
select content_delegation_configure(false, true, true, array['blog', 'facebook', 'google_business'], 'sandbox: off');
\o
reset role;
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare e text;
begin
  e := cd.dg_authorize(cd.dg_social('dc-off-1', 'approve', array[cd.id('fb1')], 'Approve the Facebook post'));
  perform cd.ok('DC3 switched off centrally refuses every client', e like '42501%policy_disallows%switched off%', e);
end $$;
\o
reset role;
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select content_delegation_configure(true, true, true, array['blog', 'facebook', 'google_business'], 'sandbox: on');
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', '00000000-0000-4000-a000-0000000000d7');
\o /dev/null
select cd.ok('DC3a a member cannot change the policy or exclusions',
  cd.try(format('select content_delegation_exclude(%L, null, ''nope'')', cd.id('dgs'))) like '42501%'
  and cd.try('select content_delegation_configure(false, false, false, ''{}'')') like '42501%'
  and cd.try('update content_delegation_settings set enabled = false') like '42501%');
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Approve a Facebook post ─────────────────────────────────────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r text; me uuid := (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001');
begin
  perform cd.ok('DC10 the service role alone still cannot approve a post',
    cd.try(format('update social_posts set review_status = ''approved'' where id = %L', cd.id('fb3'))) like '42501%');
  r := cd.dg_authorize(cd.dg_social('dc-approve-1', 'approve', array[cd.id('fb1')], 'Approve the first Facebook post'));
  perform cd.ok('DC8 approve: approved, Tom the reviewer, the note names ChatGPT, nothing scheduled',
    r = 'executed'
    and (select review_status = 'approved' and reviewed_by = me and publish_status = 'not_scheduled'
                and review_note like 'Approved by Sandbox Team through ChatGPT (Executive OS); executed by ChatGPT via Executive OS.%'
                and approved_hash = social_post_hash(social_post_snapshot(p))
           from social_posts p where id = cd.id('fb1')), r);
  perform cd.ok('DC9 post history records a team approval by Tom, with the note',
    exists (select 1 from post_events where post_id = cd.id('fb1') and kind = 'approved' and actor_kind = 'team' and actor_id = me
            and detail->>'note' like '%Authorization%'));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Binding ─────────────────────────────────────────────────────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare p jsonb; r text;
begin
  p := cd.dg_social('dc-chan-1', 'approve', array[cd.id('gb1')], 'Approve the Profile post');
  r := cd.dg_authorize(jsonb_set(p, '{items,0,channel}', '"facebook"'));
  perform cd.ok('DC11 an item declared on the wrong channel is refused', r like '23514%channel_mismatch%', r);
  p := cd.dg_social('dc-dest-1', 'approve', array[cd.id('fb2')], 'Approve the second Facebook post');
  r := cd.dg_authorize(jsonb_set(p, '{items,0,destination}', '"facebook:999999999999"'));
  perform cd.ok('DC12 a different Page is refused', r like '23514%wrong_destination%'
    and (select review_status = 'in_review' from social_posts where id = cd.id('fb2')), r);
  perform cd.save('dc-fb3-reviewed', cd.dg_social('dc-changed-1', 'approve', array[cd.id('fb3')], 'Approve the third Facebook post')::text);
end $$;
\o
reset role;
-- The copy changes after Tom read it: withdrawn, edited, resubmitted.
\c - supabase_admin
\o /dev/null
update social_posts set review_status = 'draft' where id = cd.id('fb3');
update social_posts set copy = 'Delegation Social Co, roofing in Columbia. Three, edited.' where id = cd.id('fb3');
update social_posts set review_status = 'in_review' where id = cd.id('fb3');
\o
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r text;
begin
  r := cd.dg_authorize(cd.get('dc-fb3-reviewed')::jsonb);
  perform cd.ok('DC13 copy changed after review: refused, nothing approved', r like '23514%content_changed%'
    and (select review_status = 'in_review' from social_posts where id = cd.id('fb3')), r);
  r := cd.dg_authorize(cd.dg_social('dc-unbound-1', 'approve_and_publish', array[cd.id('fbu')], 'Approve and publish the post'));
  perform cd.ok('DC14 a Page the publisher would not send to refuses publishing; approval alone is allowed',
    r like '23514%destination_not_publishable%not bound%'
    and (select review_status = 'in_review' from social_posts where id = cd.id('fbu'))
    and cd.dg_authorize(cd.dg_social('dc-unbound-2', 'approve', array[cd.id('fbu')], 'Approve the post')) = 'executed', r);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Approve and publish Facebook + Business Profile ─────────────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare p jsonb := cd.dg_social('dc-pub-1', 'approve_and_publish', array[cd.id('fb2'), cd.id('gb1')], 'Approve and publish the Facebook and Profile posts');
        r text; at timestamptz;
begin
  r := cd.dg_authorize(p);
  select publish_at into at from content_approval_authorizations where operation_id = 'dc-pub-1';
  perform cd.ok('DC16 approve and publish: both approved and scheduled at the authorized time for the publisher',
    r = 'executed'
    and (select count(*) = 2 from social_posts where id in (cd.id('fb2'), cd.id('gb1'))
          and review_status = 'approved' and publish_status = 'scheduled' and scheduled_at = at)
    and (select channels @> array['facebook', 'google_business'] from content_approval_authorizations where operation_id = 'dc-pub-1'), r);
  r := cd.dg_authorize(p);
  perform cd.ok('DC17 the same request again is a replay', r = 'replayed:executed', r);
  r := cd.dg_authorize(cd.dg_social('dc-pub-2', 'publish', array[cd.id('fb2')], 'Publish the Facebook post'));
  perform cd.ok('DC18 a new publish operation for a scheduled post schedules nothing twice',
    r = 'executed' and (select scheduled_at = at from social_posts where id = cd.id('fb2'))
    and (select count(*) = 1 from post_events where post_id = cd.id('fb2') and kind = 'scheduled'), r);
  r := cd.dg_authorize(cd.dg_social('dc-stale-1', 'publish', array[cd.id('fbu')], 'Publish the post'));
  perform cd.ok('DC15 publish needs a current approval and a sendable Page', r like '23514%destination_not_publishable%', r);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Status ──────────────────────────────────────────────────────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare s jsonb := content_authorization_status('dc-pub-1');
begin
  perform cd.ok('DC19 scheduled in the future says scheduled, with the Page / location',
    (select bool_and(x->>'state' = 'scheduled') and count(*) = 2 from jsonb_array_elements(s->'items_now') x)
    and (select x->>'destination' from jsonb_array_elements(s->'items_now') x where x->>'id' = cd.id('fb2')::text) = 'facebook:555000111222', s::text);
end $$;
\o
-- The publisher's tick: due now, then publishing, then its results.
update social_posts set scheduled_at = now() - interval '1 minute' where id in (cd.id('fb2'), cd.id('gb1'));
update social_posts set publish_status = 'publishing' where id in (cd.id('fb2'), cd.id('gb1'));
\o /dev/null
select cd.ok('DC20 due and claimed says publishing',
  (select bool_and(x->>'state' = 'publishing') from jsonb_array_elements(content_authorization_status('dc-pub-1')->'items_now') x));
\o
update social_posts set publish_status = 'published', published_url = 'https://www.facebook.com/555000111222/posts/987654321',
       external_post_id = 'zernio-post-1', published_at = now() where id = cd.id('fb2');
update social_posts set publish_status = 'failed', error = 'Zernio refused the image: too small.' where id = cd.id('gb1');
\o /dev/null
do $$
declare s jsonb := content_authorization_status('dc-pub-1'); f jsonb; g jsonb; r text;
begin
  select x into f from jsonb_array_elements(s->'items_now') x where x->>'id' = cd.id('fb2')::text;
  select x into g from jsonb_array_elements(s->'items_now') x where x->>'id' = cd.id('gb1')::text;
  perform cd.ok('DC21 published with the live URL and the provider''s post id; failed with the error',
    f->>'state' = 'published' and f->>'published_url' like 'https://www.facebook.com/%' and f->>'provider_post_id' = 'zernio-post-1'
    and g->>'state' = 'failed' and g->>'error' like 'Zernio refused%', s::text);
  r := cd.dg_authorize(cd.dg_social('dc-retry-1', 'publish', array[cd.id('gb1')], 'Publish the Profile post again'));
  perform cd.ok('DC22 a new instruction retries the failed post through the existing schedule',
    r = 'executed' and (select publish_status = 'scheduled' from social_posts where id = cd.id('gb1'))
    and exists (select 1 from post_events where post_id = cd.id('gb1') and kind = 'retried'), r);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - supabase_admin
\o /dev/null
update app_settings set value = (select value from cd.publisher_before) where key = 'publisher' and exists (select 1 from cd.publisher_before);
delete from app_settings where key = 'publisher' and not exists (select 1 from cd.publisher_before);
\o
select status, count(*) from cd.results where name ~ '^DC[0-9]' group by status;
select n, status, name, detail from cd.results where name ~ '^DC[0-9]' and status <> 'pass' order by n;
do $$
begin
  if exists (select 1 from cd.results where name ~ '^DC[0-9]' and status = 'fail')
     or (select count(*) from cd.results where name ~ '^DC[0-9]') < 23 then
    raise exception 'content_delegation_channels: failures above';
  end if;
end $$;
