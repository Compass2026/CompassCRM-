-- Tests for migration 0064 (Content Planner), run by
-- scripts/test-portal-sandbox.sh on the same replay. Own harness schema (pl)
-- and its own fictional clients.
--
-- Callers, as they reach production:
--   person   psql as authenticator, role authenticated, team JWT
--   portal   psql as authenticator, role authenticated, portal JWT
--   anon     psql as authenticator, role anon
--   service  psql as authenticator, role service_role
-- Fixtures that stand in for other parts of the system (Authority's runs,
-- the review gate's transitions) are written as supabase_admin.

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'

\c - supabase_admin
\o /dev/null
create schema pl;
create table pl.results (n serial, status text, name text, detail text);
grant usage on schema pl to anon, authenticated, service_role, authenticator, postgres;
grant insert, select on pl.results to anon, authenticated, service_role, authenticator, postgres;
grant usage on sequence pl.results_n_seq to anon, authenticated, service_role, authenticator, postgres;
create function pl.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into pl.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function pl.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function pl.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function pl.id(p_k text) returns uuid language sql immutable as $$ select md5('pl:' || p_k)::uuid $$;
-- A plan item as SQL (null-safe literals), for pl.try.
create function pl.item(p_id uuid, p_client uuid, p_week date, p_deliverable text, p_channel text, p_purpose text,
                        p_topic text, p_intent text default null, p_service uuid default null, p_opp uuid default null,
                        p_keyword uuid default null, p_planned date default null) returns text
language sql immutable as $$
  select format('insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent,
                   service_id, authority_opportunity_id, keyword_id, planned_date)
                 values (%L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L, %L)',
                p_id, p_client, p_week, p_deliverable, p_channel, p_purpose, p_topic, p_intent, p_service, p_opp, p_keyword, p_planned)
$$;
grant execute on all functions in schema pl to anon, authenticated, service_role, authenticator, postgres;

-- ── Fixtures (fictional) ────────────────────────────────────────────────────
insert into clients (id, name, city, state, status) values
  (pl.id('a'), 'Planner Roofing', 'Wentzville', 'MO', 'active'),
  (pl.id('b'), 'Planner Plumbing', 'Columbia', 'MO', 'active');
insert into services (id, client_id, name, status) values
  (pl.id('svc-a'), pl.id('a'), 'Roof Replacement', 'approved'),
  (pl.id('svc-b'), pl.id('b'), 'Drain Cleaning', 'approved');
insert into keywords (id, client_id, keyword) values
  (pl.id('kw-a'), pl.id('a'), 'roof replacement wentzville'),
  (pl.id('kw-b'), pl.id('b'), 'drain cleaning columbia');
-- Authority's records stand in for a completed run (its guard admits only the
-- authority functions' session, so the fixture skips triggers).
set session_replication_role = replica;
insert into authority_runs (id, client_id, status, mode, requested_via) values
  (pl.id('run-a'), pl.id('a'), 'running', 'full', 'team'),
  (pl.id('run-b'), pl.id('b'), 'running', 'full', 'team');
insert into authority_opportunities (id, client_id, key, first_seen_run_id, last_seen_run_id, last_seen_at, section, action, tier,
                                     content_type, topic, service_id, intent, opportunity, status, status_reason, dismissed_until) values
  (pl.id('opp-gbp'), pl.id('a'), 'gbp:roof', pl.id('run-a'), pl.id('run-a'), now(), 'ready', 'create', 'A', 'gbp_post',
   'Roof replacement', pl.id('svc-a'), 'commercial', '{}', 'open', null, null),
  (pl.id('opp-blog'), pl.id('a'), 'blog:roof', pl.id('run-a'), pl.id('run-a'), now(), 'ready', 'create', 'B', 'blog_post',
   'When to replace a roof', pl.id('svc-a'), 'informational', '{}', 'open', null, null),
  (pl.id('opp-page'), pl.id('a'), 'page:roof', pl.id('run-a'), pl.id('run-a'), now(), 'ready', 'create', 'B', 'service_page',
   'Roof replacement page', pl.id('svc-a'), 'commercial', '{}', 'open', null, null),
  (pl.id('opp-dismissed'), pl.id('a'), 'gbp:old', pl.id('run-a'), pl.id('run-a'), now(), 'ready', 'create', 'C', 'gbp_post',
   'Old idea', pl.id('svc-a'), 'commercial', '{}', 'dismissed', 'Not this season', date '2027-01-01'),
  (pl.id('opp-b'), pl.id('b'), 'gbp:drain', pl.id('run-b'), pl.id('run-b'), now(), 'ready', 'create', 'A', 'gbp_post',
   'Drain cleaning', pl.id('svc-b'), 'commercial', '{}', 'open', null, null);
set session_replication_role = origin;
insert into social_posts (id, client_id, platform, search_intent, service_id, copy) values
  (pl.id('post-gbp'), pl.id('a'), 'google_business', 'commercial', pl.id('svc-a'), 'Roof replacement in Wentzville.'),
  (pl.id('post-fb'), pl.id('a'), 'facebook', 'informational', pl.id('svc-a'), 'How long does a roof last?'),
  (pl.id('post-gbp-2'), pl.id('a'), 'google_business', 'commercial', pl.id('svc-a'), 'Another roof post.'),
  (pl.id('post-b'), pl.id('b'), 'google_business', 'commercial', pl.id('svc-b'), 'Drain cleaning in Columbia.');
insert into claims (id, client_id, claim, status, source) values
  (pl.id('claim-a'), pl.id('a'), 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/contractors/1');
insert into post_claims (post_id, client_id, claim_id) values (pl.id('post-gbp'), pl.id('a'), pl.id('claim-a'));
insert into content_posts (id, client_id, title, status) values
  (pl.id('blog-a'), pl.id('a'), 'When to replace a roof', 'draft');
\o

-- ── Person: shapes, links and derived status ────────────────────────────────
\c - authenticator
set role authenticated;
select pl.as_user('authenticated', :'team');
\o /dev/null
do $$
declare
  w date := date '2026-10-05';        -- a Monday
  a uuid := pl.id('a');
  b uuid := pl.id('b');
  e text;
  st text;
  me uuid := (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001');
begin
  -- Shapes
  e := pl.try(pl.item(pl.id('i-gbp'), a, w, 'gbp', 'google_business', 'service', 'Roof replacement', 'commercial', pl.id('svc-a')));
  perform pl.ok('S1 a teammate plans a Business Profile service post', e is null, e);
  perform pl.ok('S2 week_start must be a Monday',
    pl.try(pl.item(pl.id('x1'), a, w + 1, 'gbp', 'google_business', 'service', 'x')) like '23514%');
  perform pl.ok('S3 a gbp slot is google_business only',
    pl.try(pl.item(pl.id('x2'), a, w, 'gbp', 'facebook', 'service', 'x')) like '23514%');
  perform pl.ok('S4 a social slot needs a social channel',
    pl.try(pl.item(pl.id('x3'), a, w, 'social', 'google_business', 'service', 'x')) like '23514%'
    and pl.try(pl.item(pl.id('x4'), a, w, 'social', null, 'service', 'x')) like '23514%');
  perform pl.ok('S5 blog and web page slots carry no channel',
    pl.try(pl.item(pl.id('x5'), a, w, 'blog', 'facebook', 'educational', 'x')) like '23514%');
  perform pl.ok('S6 the purpose is one of the seven',
    pl.try(pl.item(pl.id('x6'), a, w, 'blog', null, 'viral', 'x')) like '23514%');
  perform pl.ok('S7 a planned date stays inside the week',
    pl.try(pl.item(pl.id('x7'), a, w, 'blog', null, 'educational', 'x', null, null, null, null, w + 7)) like '23514%');
  perform pl.ok('S8 a topic is required',
    pl.try(pl.item(pl.id('x8'), a, w, 'blog', null, 'educational', '  ')) like '23514%');

  -- Authority
  perform pl.ok('A1 an authority item names its opportunity',
    pl.try(pl.item(pl.id('x9'), a, w, 'gbp', 'google_business', 'authority', 'x', 'commercial')) like '23514%');
  perform pl.ok('A2 only an authority item names an opportunity',
    pl.try(pl.item(pl.id('x10'), a, w, 'gbp', 'google_business', 'service', 'x', 'commercial', null, pl.id('opp-gbp'))) like '23514%');
  e := pl.try(pl.item(pl.id('i-auth'), a, w, 'gbp', 'google_business', 'authority', 'Roof replacement', 'commercial', pl.id('svc-a'), pl.id('opp-gbp')));
  perform pl.ok('A3 a gbp_post opportunity fills a gbp slot', e is null, e);
  e := pl.try(pl.item(pl.id('x11'), a, w, 'blog', null, 'authority', 'x', 'informational', null, pl.id('opp-gbp')));
  perform pl.ok('A4 an opportunity fills only its own kind of slot', e like '23514%gbp_post%blog%', e);
  perform pl.ok('A5 blog_post → blog and service_page → web_page',
    pl.try(pl.item(pl.id('i-auth-blog'), a, w, 'blog', null, 'authority', 'When to replace a roof', 'informational', null, pl.id('opp-blog'))) is null
    and pl.try(pl.item(pl.id('i-auth-page'), a, w, 'web_page', null, 'authority', 'Roof replacement page', 'commercial', pl.id('svc-a'), pl.id('opp-page'))) is null);
  perform pl.ok('A6 a social slot cannot be an authority item (no social opportunity type)',
    pl.try(pl.item(pl.id('x12'), a, w, 'social', 'facebook', 'authority', 'x', 'commercial', null, pl.id('opp-gbp'))) like '23514%');
  perform pl.ok('A7 a dismissed opportunity cannot be planned',
    pl.try(pl.item(pl.id('x13'), a, w, 'gbp', 'google_business', 'authority', 'x', 'commercial', null, pl.id('opp-dismissed'))) like '23514%dismissed%');

  -- Same client
  perform pl.ok('C1 another client''s service, keyword or opportunity is refused',
    pl.try(pl.item(pl.id('x14'), a, w, 'gbp', 'google_business', 'service', 'x', 'commercial', pl.id('svc-b'))) like '23503%'
    and pl.try(pl.item(pl.id('x15'), a, w, 'blog', null, 'educational', 'x', null, null, null, pl.id('kw-b'))) like '23503%'
    and pl.try(pl.item(pl.id('x16'), a, w, 'gbp', 'google_business', 'authority', 'x', 'commercial', null, pl.id('opp-b'))) like '23503%');
  perform pl.ok('C2 another client''s post is refused',
    pl.try(format('update content_plan_items set social_post_id = %L where id = %L', pl.id('post-b'), pl.id('i-gbp'))) like '23503%');
  perform pl.ok('C3 an item keeps its client',
    pl.try(format('update content_plan_items set client_id = %L where id = %L', b, pl.id('i-gbp'))) is not null
    and (select client_id from content_plan_items where id = pl.id('i-gbp')) = a);

  -- Status
  select status into st from content_plan_board where id = pl.id('i-gbp');
  perform pl.ok('D1 intent + service → ready to generate', st = 'ready_to_generate', st);
  e := pl.try(pl.item(pl.id('i-planned'), a, w, 'social', 'facebook', 'educational', 'Roof care tips'));
  select status into st from content_plan_board where id = pl.id('i-planned');
  perform pl.ok('D2 no intent → planned', e is null and st = 'planned', coalesce(e, st));
  perform pl.ok('D3 an authority blog with intent is ready (a blog needs no service)',
    (select status from content_plan_board where id = pl.id('i-auth-blog')) = 'ready_to_generate');

  perform pl.ok('L1 a post for another channel cannot fill the slot',
    pl.try(format('update content_plan_items set social_post_id = %L where id = %L', pl.id('post-fb'), pl.id('i-gbp'))) like '23514%');
  e := pl.try(format('update content_plan_items set social_post_id = %L where id = %L', pl.id('post-gbp'), pl.id('i-gbp')));
  perform pl.ok('L2 the matching post links', e is null, e);
  select status into st from content_plan_board where id = pl.id('i-gbp');
  perform pl.ok('D4 a linked draft post → drafting', st = 'drafting', st);
  perform pl.ok('L3 a post fills one slot only',
    pl.try(format('update content_plan_items set social_post_id = %L where id = %L', pl.id('post-gbp'), pl.id('i-auth'))) like '23505%');
  perform pl.ok('L4 a blog links only to a blog slot',
    pl.try(format('update content_plan_items set content_post_id = %L where id = %L', pl.id('blog-a'), pl.id('i-gbp'))) like '23514%');
  e := pl.try(format('update content_plan_items set content_post_id = %L where id = %L', pl.id('blog-a'), pl.id('i-auth-blog')));
  perform pl.ok('L5 a draft blog links to its slot → drafting',
    e is null and (select status from content_plan_board where id = pl.id('i-auth-blog')) = 'drafting', e);

  perform pl.ok('H1 blocked needs a reason',
    pl.try(format('update content_plan_items set hold = ''blocked'' where id = %L', pl.id('i-planned'))) like '23514%');
  update content_plan_items set hold = 'blocked', hold_reason = 'Waiting on photos from the client' where id = pl.id('i-planned');
  perform pl.ok('H2 blocked overrides everything', (select status from content_plan_board where id = pl.id('i-planned')) = 'blocked');
  update content_plan_items set hold = null where id = pl.id('i-planned');
  perform pl.ok('H3 clearing the hold clears the reason',
    (select hold_reason is null from content_plan_items where id = pl.id('i-planned'))
    and (select status from content_plan_board where id = pl.id('i-planned')) = 'planned');
  update content_plan_items set hold = 'delivered', output_url = 'https://example.test/posts/1' where id = pl.id('i-auth-page');
  perform pl.ok('H4 a teammate marks a deliverable delivered',
    (select status from content_plan_board where id = pl.id('i-auth-page')) = 'delivered');

  perform pl.ok('W1 the database records who planned and who changed it',
    (select created_by = me and updated_by = me from content_plan_items where id = pl.id('i-gbp')));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── The review gate moves the linked post; the board follows ───────────────
\c - supabase_admin
\o /dev/null
insert into tasks (client_id, title, owner, status, key)
values (pl.id('a'), 'Draft with AI request', 'CLAUDE', 'open', 'authority_draft:' || pl.id('opp-gbp'));
\o
\c - authenticator
set role authenticated;
select pl.as_user('authenticated', :'team');
\o /dev/null
do $$
begin
  update social_posts set review_status = 'in_review' where id = pl.id('post-gbp');
  perform pl.ok('D5 the linked post in review → in review',
    (select status from content_plan_board where id = pl.id('i-gbp')) = 'in_review'
    and (select post_review_status from content_plan_board where id = pl.id('i-gbp')) = 'in_review');
  perform pl.ok('D6 an open Draft with AI request for the item''s opportunity → drafting',
    (select status from content_plan_board where id = pl.id('i-auth')) = 'drafting');
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role authenticated;
select pl.as_user('authenticated', :'team');
\o /dev/null
do $$
begin
  update social_posts set review_status = 'approved' where id = pl.id('post-gbp');
  perform pl.ok('D7 the linked post approved → approved',
    (select status from content_plan_board where id = pl.id('i-gbp')) = 'approved');
  delete from content_plan_items where id = pl.id('i-planned');
  perform pl.ok('W2 a teammate deletes a plan item', not exists (select 1 from content_plan_items where id = pl.id('i-planned')));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Who sees plan items ─────────────────────────────────────────────────────
\c - authenticator
select pl.as_user('authenticated', :'pa');
set role authenticated;
\o /dev/null
do $$
begin
  perform pl.ok('P1 a portal contact sees no plan item and no board row',
    (select count(*) from content_plan_items) = 0 and (select count(*) from content_plan_board) = 0);
  perform pl.ok('P2 a portal contact cannot plan',
    pl.try(pl.item(pl.id('x-portal'), pl.id('a'), date '2026-10-05', 'blog', null, 'educational', 'x')) like '42501%');
end $$;
\o
reset role;
set role anon;
select pl.as_user('anon', null);
\o /dev/null
do $$
begin
  perform pl.ok('P3 anon cannot read plan items or the board',
    pl.try('select count(*) from content_plan_items') like '42501%' and pl.try('select count(*) from content_plan_board') like '42501%');
end $$;
\o
reset role;
set role service_role;
select pl.as_user('service_role', null);
\o /dev/null
do $$
begin
  perform pl.ok('P4 the service role reads the board', (select count(*) from content_plan_board where client_id = pl.id('a')) >= 4);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Deleting a linked post unlinks it (the plan item stays) ─────────────────
\c - supabase_admin
\o /dev/null
update content_plan_items set social_post_id = pl.id('post-gbp-2') where id = pl.id('i-auth');
delete from social_posts where id = pl.id('post-gbp-2');
select pl.ok('K1 deleting the linked post leaves the item, unlinked',
  (select social_post_id is null from content_plan_items where id = pl.id('i-auth')));
\o

\c - postgres
\o
\pset footer off
select status, count(*) from pl.results group by status order by status;
select n, status, name, detail from pl.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from pl.results where status = 'fail';
  if f > 0 then raise exception '% content planner check(s) failed', f; end if;
end $$;
