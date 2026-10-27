-- 20261027190935: several Business Profile locations per client, each post and
-- slot naming its own. Fictional clients only (removed at the end); run after
-- drafter_gbp_destination.test.sql (uses its fd helpers).
\set team '00000000-0000-4000-a000-000000000001'
\set la '00000000-0000-4000-e600-00000000000a'
\set lb '00000000-0000-4000-e600-00000000000b'
\c - postgres
create schema gl;
create table gl.ids(k text primary key, id uuid);
create function gl.id(p_k text) returns uuid language sql stable as $$ select id from gl.ids where k = p_k $$;
create function gl.ok(label text, cond boolean, detail text default null) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED % %', label, coalesce(detail, ''); end if; raise notice 'ok %', label; end $$;
grant usage on schema gl to service_role, authenticated;
grant all on gl.ids to service_role, authenticated;
grant execute on all functions in schema gl to service_role, authenticated;
insert into clients (id, name, status) values
  (:'la', 'GL Multi-location', 'active'),
  (:'lb', 'GL Other client', 'active');

-- ── 1. Binding: several locations per client, one client per location ───────
\c - authenticator
set role service_role;
select fd.as_user('service_role', null);
do $$
declare r jsonb; e text;
begin
  r := publisher_bind_gbp_location('00000000-0000-4000-e600-00000000000a', 'ccccccccccccccccccccccc1', 'locations/700001', 'Wichita', 'GL Google', '{"status":"healthy"}');
  insert into gl.ids values ('wichita', (r ->> 'social_account_id')::uuid);
  -- The same Zernio googlebusiness account serves a second location of the same client.
  r := publisher_bind_gbp_location('00000000-0000-4000-e600-00000000000a', 'ccccccccccccccccccccccc1', 'locations/700002', 'Overland Park', 'GL Google', '{"status":"healthy"}');
  insert into gl.ids values ('op', (r ->> 'social_account_id')::uuid);
  perform gl.ok('LB1 a client binds a second location; both stay bound, both start switched off',
    (select count(*) = 2 and bool_and(publish_provider = 'zernio' and not publish_enabled and publish_verified_at is not null)
       from social_accounts where client_id = '00000000-0000-4000-e600-00000000000a' and platform = 'google_business'));
  r := publisher_bind_gbp_location('00000000-0000-4000-e600-00000000000a', 'ccccccccccccccccccccccc1', 'locations/700001', 'Wichita', 'GL Google', '{"status":"healthy"}');
  perform gl.ok('LB2 binding a location again re-verifies its own row', r ->> 'kind' = 'verified' and (r ->> 'social_account_id')::uuid = gl.id('wichita'));
  e := fd.try($q$select publisher_bind_gbp_location('00000000-0000-4000-e600-00000000000b', 'ccccccccccccccccccccccc2', 'locations/700001', 'x', 'x', '{"status":"healthy"}')$q$);
  perform gl.ok('LB3 another client can never bind this client''s location', e like '23505:%another client%', e);
  perform gl.ok('LB4 ... and the refusal left no row for that client',
    not exists (select 1 from social_accounts where client_id = '00000000-0000-4000-e600-00000000000b'));
  -- A Zernio googlebusiness account may serve another client's own, different location (each request pins its location).
  r := publisher_bind_gbp_location('00000000-0000-4000-e600-00000000000b', 'ccccccccccccccccccccccc1', 'locations/700003', 'Other', 'GL Google', '{"status":"healthy"}');
  insert into gl.ids values ('other', (r ->> 'social_account_id')::uuid);
  perform gl.ok('LB5 one Zernio Business Profile account can serve another client''s different location',
    (select client_id = '00000000-0000-4000-e600-00000000000b' and publish_page_id = 'locations/700003' from social_accounts where id = gl.id('other')));
  e := fd.try(format($q$select publisher_bind_account(%L, 'ccccccccccccccccccccccc1', 'locations/700001', 'x', '{}')$q$, gl.id('op')));
  perform gl.ok('LB6 a row is never re-pointed at another location', e like '23514:%', e);
end $$;
reset role;

-- ── 2. Drafts name their location; never guessed between two ────────────────
-- (drafter_gbp_destination.test.sql covers the drafter: unnamed with two
-- locations is refused, a named location is used, another client's refused.)

-- ── 3. Plan slots and posts: never redirected ───────────────────────────────
\c - supabase_admin
begin;
do $$
declare
  a constant uuid := '00000000-0000-4000-e600-00000000000a';
  w date := date_trunc('week', now())::date;
  s_w uuid; s_any uuid; p_w uuid; p_op uuid; p_none uuid; e text; fb uuid;
begin
  insert into social_posts (client_id, platform, search_intent, crm_facts_only, copy, social_account_id)
    values (a, 'google_business', 'navigational', true, 'GL Wichita post.', gl.id('wichita')) returning id into p_w;
  insert into social_posts (client_id, platform, search_intent, crm_facts_only, copy, social_account_id)
    values (a, 'google_business', 'navigational', true, 'GL Overland Park post.', gl.id('op')) returning id into p_op;
  insert into social_posts (client_id, platform, search_intent, crm_facts_only, copy)
    values (a, 'google_business', 'navigational', true, 'GL post with no location.') returning id into p_none;
  insert into content_plan_items (client_id, week_start, deliverable, channel, purpose, topic, gbp_location_id)
    values (a, w, 'gbp', 'google_business', 'service', 'GL Wichita slot', gl.id('wichita')) returning id into s_w;
  insert into content_plan_items (client_id, week_start, deliverable, channel, purpose, topic)
    values (a, w, 'gbp', 'google_business', 'service', 'GL unlocated slot') returning id into s_any;

  e := fd.try(format($q$update content_plan_items set social_post_id = %L where id = %L$q$, p_op, s_w));
  perform gl.ok('LS1 a Wichita slot refuses an Overland Park post', e like '23514:%never redirected%', e);
  e := fd.try(format($q$update content_plan_items set social_post_id = %L where id = %L$q$, p_none, s_w));
  perform gl.ok('LS2 ... and a post that names no location', e like '23514:%never redirected%', e);
  update content_plan_items set social_post_id = p_w where id = s_w;
  perform gl.ok('LS3 a Wichita slot takes a Wichita post', (select social_post_id = p_w from content_plan_items where id = s_w));
  e := fd.try(format($q$update social_posts set social_account_id = %L where id = %L$q$, gl.id('op'), p_w));
  perform gl.ok('LS4 a linked post cannot be moved to another location', e like '23514:%never redirected%', e);
  e := fd.try(format($q$update content_plan_items set gbp_location_id = %L where id = %L$q$, gl.id('op'), s_w));
  perform gl.ok('LS5 nor can its slot', e like '23514:%never redirected%', e);
  update content_plan_items set social_post_id = p_op where id = s_any;
  perform gl.ok('LS6 a slot with no location chosen behaves as before', (select social_post_id = p_op from content_plan_items where id = s_any));
  e := fd.try(format($q$insert into content_plan_items (client_id, week_start, deliverable, channel, purpose, topic, gbp_location_id)
    values (%L, %L, 'blog', null, 'educational', 'x', %L)$q$, a, w, gl.id('wichita')));
  perform gl.ok('LS7 only a Business Profile slot names a location', e like '23514:%', e);
  e := fd.try(format($q$insert into content_plan_items (client_id, week_start, deliverable, channel, purpose, topic, gbp_location_id)
    values (%L, %L, 'gbp', 'google_business', 'service', 'x', %L)$q$, a, w, gl.id('other')));
  perform gl.ok('LS8 a slot cannot name another client''s location', e like '23503:%', e);
  insert into social_accounts (client_id, platform, external_account_id, display_name) values (a, 'facebook', '1234567', 'GL Page') returning id into fb;
  e := fd.try(format($q$insert into content_plan_items (client_id, week_start, deliverable, channel, purpose, topic, gbp_location_id)
    values (%L, %L, 'gbp', 'google_business', 'service', 'x', %L)$q$, a, w, fb));
  perform gl.ok('LS9 a slot''s location is a Business Profile location, not a Facebook Page', e like '23514:%Business Profile location%', e);
end $$;
rollback;

-- ── Cleanup: unbind as a team admin, then remove the fictional clients ──────
\c - authenticator
set role authenticated;
select fd.as_user('authenticated', :'team');
select publisher_unbind_account(gl.id('wichita'));
select publisher_unbind_account(gl.id('op'));
select publisher_unbind_account(gl.id('other'));
reset role;
\c - postgres
delete from clients where id in (:'la', :'lb');
drop schema gl cascade;
