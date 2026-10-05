-- Tests for migrations 0066 + 0067 + 0068 + 0069 (content drafts: the Blog Drafter and the
-- Web Page Drafter's foundation), run by scripts/test-portal-sandbox.sh on the
-- same replay. Own harness schema (cd) and fictional clients.
--
-- Callers, as they reach production:
--   person   authenticator, role authenticated, team JWT
--   drafter  authenticator, role service_role (the content-drafter function)
--   worker   postgres (the worker's own SQL)
--   portal   authenticator, role authenticated, portal JWT

\set team   '00000000-0000-4000-a000-000000000001'
\set pa     '00000000-0000-4000-a000-000000000011'

\c - supabase_admin
\o /dev/null
create schema cd;
create table cd.results (n serial, status text, name text, detail text);
create table cd.saved (k text primary key, v text);
grant usage on schema cd to anon, authenticated, service_role, authenticator, postgres;
grant insert, select on cd.results to anon, authenticated, service_role, authenticator, postgres;
grant insert, select, update on cd.saved to anon, authenticated, service_role, authenticator, postgres;
grant usage on sequence cd.results_n_seq to anon, authenticated, service_role, authenticator, postgres;
create function cd.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into cd.results (status, name, detail) values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function cd.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function cd.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function cd.id(p_k text) returns uuid language sql immutable as $$ select md5('cd:' || p_k)::uuid $$;
create function cd.save(p_k text, p_v text) returns void language sql as $$
  insert into cd.saved values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function cd.get(p_k text) returns text language sql stable as $$ select v from cd.saved where k = p_k $$;
-- A written draft as the content-drafter function sends it.
create function cd.payload(p_draft uuid, p_words int, p_claims uuid[], p_submit boolean default true) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'draft_id', p_draft, 'brief', jsonb_build_object('v', 1), 'brief_hash', 'sha256:' || repeat('a', 64),
    'runtime', 'sandbox', 'lint', jsonb_build_object('ok', true), 'claim_ids', to_jsonb(p_claims), 'submit', p_submit,
    'content', jsonb_build_object(
      'title', 'How long does a roof last in Missouri?', 'slug', 'how-long-does-a-roof-last-in-missouri',
      'meta_title', 'How Long Does a Roof Last in Missouri?', 'meta_description', 'What shortens a roof''s life here and when to plan a replacement.',
      'h1', 'How long does a roof last in Missouri?', 'outline', '[{"level": 2, "heading": "What wears a roof out"}, {"level": 2, "heading": "Planning ahead"}]'::jsonb,
      'body_markdown', '## What wears a roof out' || chr(10) || repeat('Shingles age with sun and storms. ', p_words / 6),
      'internal_links', '[{"url": "https://planner-roofing.example.test/services/roof-replacement", "anchor": "roof replacement"}]'::jsonb,
      'cta', '{"text": "Request a quote", "url": "https://planner-roofing.example.test/contact"}'::jsonb,
      'page_path', '/services/roof-replacement', 'page_objective', 'Turn homeowners comparing roofers into quote requests.'))
$$;
grant execute on all functions in schema cd to anon, authenticated, service_role, authenticator, postgres;

-- ── Fixtures (fictional) ────────────────────────────────────────────────────
insert into clients (id, name, city, state, status) values
  (cd.id('a'), 'Draft Roofing', 'Wentzville', 'MO', 'active'),
  (cd.id('b'), 'Draft Plumbing', 'Columbia', 'MO', 'active');
insert into services (id, client_id, name, status) values (cd.id('svc'), cd.id('a'), 'Roof Replacement', 'approved');
insert into keywords (id, client_id, keyword) values (cd.id('kw'), cd.id('a'), 'how long does a roof last missouri');
insert into claims (id, client_id, claim, status, source) values
  (cd.id('c-sourced'), cd.id('a'), 'Owens Corning Preferred Contractor', 'sourced', 'https://manufacturer.example.test/1'),
  (cd.id('c-unverified'), cd.id('a'), 'Family operated since 2018', 'unverified', null),
  (cd.id('c-b'), cd.id('b'), 'Licensed master plumber', 'sourced', 'https://state.example.test/1');
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent, keyword_id, service_id, planned_date) values
  (cd.id('i-blog'), cd.id('a'), date '2026-10-05', 'blog', null, 'educational', 'How long does a roof last', 'informational', cd.id('kw'), cd.id('svc'), date '2026-10-07'),
  (cd.id('i-blog-2'), cd.id('a'), date '2026-10-05', 'blog', null, 'educational', 'Signs of hail damage', 'informational', null, cd.id('svc'), null),
  (cd.id('i-page'), cd.id('a'), date '2026-10-05', 'web_page', null, 'service', 'Roof replacement page', 'commercial', null, cd.id('svc'), null),
  (cd.id('i-gbp'), cd.id('a'), date '2026-10-05', 'gbp', 'google_business', 'service', 'Roof post', 'commercial', null, cd.id('svc'), null),
  (cd.id('i-page-2'), cd.id('a'), date '2026-10-05', 'web_page', null, 'service', 'Roof replacement page refresh', 'commercial', null, cd.id('svc'), null),
  (cd.id('i-compare'), cd.id('a'), date '2026-10-05', 'web_page', null, 'educational', 'Repair or replace', 'commercial', null, null, null);
update content_plan_items set target_url = 'https://a.example.test/services/roof-replacement' where id = cd.id('i-page-2');
\o

-- ── Person: request ─────────────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare r jsonb; r2 jsonb; e text;
begin
  r := content_draft_request(cd.id('i-blog'));
  perform cd.save('blog', r->>'draft_id');
  perform cd.ok('R1 Generate on a blog item opens one requested draft with its brief inputs and a CLAUDE task',
    (select status = 'requested' and topic = 'How long does a roof last' and primary_keyword = 'how long does a roof last missouri'
            and search_intent = 'informational' and service_id = cd.id('svc') from content_drafts where id = (r->>'draft_id')::uuid)
    and (select owner::text = 'CLAUDE' and key = 'content_draft:' || (r->>'draft_id') from tasks where id = (r->>'task_id')::uuid));
  r2 := content_draft_request(cd.id('i-blog'));
  perform cd.ok('R2 a second Generate reuses the request', (r2->>'reused')::boolean and r2->>'draft_id' = r->>'draft_id');
  perform cd.ok('R3 a Business Profile item is drafted as a post, not here',
    cd.try(format('select content_draft_request(%L)', cd.id('i-gbp'))) like '22023%');
  perform cd.ok('R4 a web page needs its type; a location page needs a location_page opportunity',
    cd.try(format('select content_draft_request(%L)', cd.id('i-page'))) like '22023%'
    and cd.try(format('select content_draft_request(%L, ''location'', null, ''page_added'')', cd.id('i-page'))) like '22023%location_page%');
  perform cd.ok('R7 a page says new or refresh; a refresh names the existing page; a comparison is justified',
    cd.try(format('select content_draft_request(%L, ''service'')', cd.id('i-page'))) like '22023%new page or a refresh%'
    and cd.try(format('select content_draft_request(%L, ''service'', null, ''page_rewrite'')', cd.id('i-page'))) like '22023%existing page%'
    and cd.try(format('select content_draft_request(%L, ''comparison'', null, ''page_added'')', cd.id('i-compare'))) like '22023%justified%'
    and cd.try(format('select content_draft_request(%L, null, null, ''page_added'')', cd.id('i-blog-2'))) like '22023%Only a web page%');
  r := content_draft_request(cd.id('i-page'), 'service', null, 'page_added');
  perform cd.save('page', r->>'draft_id');
  r := content_draft_request(cd.id('i-blog-2'));
  perform cd.save('blog2', r->>'draft_id');
  perform cd.ok('R5 the planner reads the request as drafting',
    (select status from content_plan_board where id = cd.id('i-blog')) = 'drafting');
  perform cd.ok('R6 a teammate cannot insert a draft or call the drafter''s write',
    cd.try(format('insert into content_drafts (client_id, deliverable, topic) values (%L, ''blog'', ''x'')', cd.id('a'))) like '42501%'
    and cd.try(format('select content_draft_write(%L::jsonb)', cd.payload(cd.get('blog')::uuid, 320, array[cd.id('c-sourced')]))) like '42501%');
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── The worker's own SQL cannot write a draft ───────────────────────────────
\c - postgres
\o /dev/null
select cd.ok('W1 the worker''s SQL cannot write content or call the drafter''s write',
  cd.try(format('update content_drafts set title = ''x'' where id = %L', cd.get('blog'))) like '42501%'
  and cd.try(format('select content_draft_write(%L::jsonb)', cd.payload(cd.get('blog')::uuid, 320, array[cd.id('c-sourced')]))) like '42501%');
\o

-- ── The drafter writes ──────────────────────────────────────────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r jsonb; e text;
begin
  e := cd.try(format('select content_draft_write(%L::jsonb)', cd.payload(cd.get('blog')::uuid, 320, array[cd.id('c-b')])));
  perform cd.ok('D1 a draft stands only on its own client''s claims', e like '23514%', e);
  e := cd.try(format('select content_draft_write(%L::jsonb)', cd.payload(cd.get('blog2')::uuid, 120, array[cd.id('c-sourced')])));
  perform cd.ok('D2 a blog under 300 words is not submitted', e like '23514%300 words%', e);
  e := cd.try(format('select content_draft_write(%L::jsonb)', cd.payload(cd.get('blog')::uuid, 320, '{}'::uuid[])));
  perform cd.ok('D3 an informational draft with no claim is not submitted', e like '23514%claim%', e);
  r := content_draft_write(cd.payload(cd.get('blog')::uuid, 320, array[cd.id('c-sourced')]));
  perform cd.ok('D4 the drafter writes and submits: in review, version 1, words counted, request task done',
    r->>'status' = 'in_review' and (r->>'version')::int = 1 and (r->>'word_count')::int >= 300
    and (select author_kind = 'drafter' and body_hash ~ '^[0-9a-f]{64}$' from content_drafts where id = cd.get('blog')::uuid)
    and (select status::text from tasks where key = 'content_draft:' || cd.get('blog')) = 'done');
  e := cd.try(format('select content_draft_write(%L::jsonb)', cd.payload(cd.get('page')::uuid, 200, array[cd.id('c-sourced')])));
  perform cd.ok('D5 a page under 250 words is not submitted', e like '23514%250 words%', e);
  r := content_draft_write(cd.payload(cd.get('page')::uuid, 270, array[cd.id('c-sourced')]));
  perform cd.ok('D6 a page draft with its path and objective goes to review; no change_log row',
    r->>'status' = 'in_review'
    and (select page_path = '/services/roof-replacement' and page_change = 'page_added' from content_drafts where id = cd.get('page')::uuid)
    and (select count(*) from change_log where client_id = cd.id('a')) = 0);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Person: review, approve, finalize ───────────────────────────────────────
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare r jsonb; e text; v_post uuid; me uuid := (select id from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001');
  b uuid := cd.get('blog')::uuid; p uuid := cd.get('page')::uuid;
begin
  perform cd.ok('P1 the planner reads the draft in review', (select status from content_plan_board where id = cd.id('i-blog')) = 'in_review');
  perform cd.ok('P2 a draft in review is frozen', cd.try(format('update content_drafts set title = ''Edited'' where id = %L', b)) like '23514%');
  perform cd.ok('P3 approval is only through content_draft_approve',
    cd.try(format('update content_drafts set status = ''approved'' where id = %L', b)) is not null);
  e := cd.try(format('select content_draft_approve(%L, 99)', b));
  perform cd.ok('P4 approving a version you did not see is refused', e like '40001%', e);
  perform cd.ok('P5 no content_posts row exists before approval (drafts never count)',
    (select count(*) from content_posts where client_id = cd.id('a')) = 0);

  r := content_draft_approve(b, 1, 'Good to go');
  v_post := (r->>'content_post_id')::uuid;
  perform cd.save('post', v_post::text);
  perform cd.ok('A1 approval creates ONE final content_posts row (approved, Compass, the title, the planned date)',
    (r->>'created')::boolean and (select status::text = 'approved' and origin = 'compass' and title = 'How long does a roof last in Missouri?'
                                         and due_date = date '2026-10-07' from content_posts where id = v_post));
  perform cd.ok('A2 the draft records who approved what (version, hash, snapshot with its claims)',
    (select status = 'approved' and reviewed_by = me and approved_version = 1 and approved_hash ~ '^sha256:'
            and approved_snapshot->'claims'->0->>'claim' = 'Owens Corning Preferred Contractor'
            and final_content_post_id = v_post from content_drafts where id = b));
  perform cd.ok('A3 the plan item links the final article; the board reads approved',
    (select content_post_id = v_post from content_plan_items where id = cd.id('i-blog'))
    and (select status from content_plan_board where id = cd.id('i-blog')) = 'approved');
  r := content_draft_approve(b, 1);
  perform cd.ok('A4 approving again is a no-op: the same row, no duplicate',
    (r->>'already')::boolean and (r->>'content_post_id')::uuid = v_post
    and (select count(*) from content_posts where client_id = cd.id('a')) = 1);
  perform cd.ok('A5 an approved draft cannot be deleted', cd.try(format('delete from content_drafts where id = %L', b)) like '23514%');

  update content_drafts set status = 'draft' where id = b;
  perform cd.ok('O1 reopen clears the approval and keeps the final article',
    (select status = 'draft' and approved_version is null and approved_snapshot is null and final_content_post_id = v_post
       from content_drafts where id = b));
  update content_drafts set title = 'How long does a roof last in Missouri? (2026)' where id = b;
  perform cd.ok('O2 a teammate''s edit bumps the version and marks the author',
    (select version = 2 and author_kind = 'team' from content_drafts where id = b));
  update content_drafts set status = 'in_review' where id = b;
  r := content_draft_approve(b, 2);
  perform cd.ok('O3 re-approval updates the same final row (still one)',
    (r->>'content_post_id')::uuid = v_post and not (r->>'created')::boolean
    and (select title from content_posts where id = v_post) = 'How long does a roof last in Missouri? (2026)'
    and (select count(*) from content_posts where client_id = cd.id('a')) = 1);

  -- Reject, revise with an unusable claim, regenerate (the web page)
  perform cd.ok('J1 rejecting needs a note', cd.try(format('update content_drafts set status = ''rejected'' where id = %L', p)) like '23514%');
  update content_drafts set status = 'rejected', review_note = 'Too generic' where id = p;
  perform cd.ok('J2 rejected, with who and when', (select status = 'rejected' and reviewed_by = me from content_drafts where id = p)
    and (select status from content_plan_board where id = cd.id('i-page')) = 'drafting');
  insert into content_draft_claims (draft_id, client_id, claim_id) values (p, cd.id('a'), cd.id('c-unverified'));
  e := cd.try(format('update content_drafts set status = ''in_review'' where id = %L', p));
  perform cd.ok('J3 an unverified claim blocks submission', e like '23514%not confirmed or sourced%', e);
  delete from content_draft_claims where draft_id = p and claim_id = cd.id('c-unverified');
  r := content_draft_regenerate(p, 'Lead with the inspection process');
  perform cd.ok('J4 regenerate sends it back to the drafter with the note and an open task',
    (select status = 'requested' and request_note = 'Lead with the inspection process' from content_drafts where id = p)
    and (select count(*) from tasks where key = 'content_draft:' || p and status <> 'done') = 1);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- The drafter writes the page again; a teammate approves it.
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
select content_draft_write(cd.payload(cd.get('page')::uuid, 270, array[cd.id('c-sourced')]));
\o
reset role;
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare r jsonb; p uuid := cd.get('page')::uuid;
begin
  r := content_draft_approve(p, (select version from content_drafts where id = p));
  perform cd.ok('G1 a new page finalizes to ONE change_log row: page_added, approved, the draft as its object, the URL and objective',
    (select status = 'approved' and final_content_post_id is null and final_change_log_id = (r->>'change_log_id')::uuid from content_drafts where id = p)
    and (select change_type = 'page_added' and object_type = 'site' and object_id = p and status::text = 'approved'
                and after->>'path' = '/services/roof-replacement' and reasoning = 'Turn homeowners comparing roofers into quote requests.'
                and evidence like 'Owens Corning Preferred Contractor (https://manufacturer%' and reviewed_by is not null
           from change_log where id = (r->>'change_log_id')::uuid)
    and (select count(*) from change_log where client_id = cd.id('a')) = 1
    and (select count(*) from content_posts where client_id = cd.id('a')) = 1);
  perform cd.save('change', r->>'change_log_id');
  -- Billing's blog count (0062, client_quota_usage) reads Compass
  -- content_posts and open blog_post tasks: one row, no task.
  perform cd.ok('B1 what Billing counts: one Compass article for three drafts, two blog versions and a rejection',
    (select count(*) from content_posts where client_id = cd.id('a') and origin = 'compass') = 1
    and (select count(*) from tasks where client_id = cd.id('a') and key = 'blog_post') = 0);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── P. Web pages finalize to one change_log row (0069) ──────────────────────
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare r jsonb; p uuid := cd.get('page')::uuid; ch uuid := cd.get('change')::uuid; r2 jsonb; p2 uuid; e text;
begin
  r := content_draft_approve(p, (select approved_version from content_drafts where id = p));
  perform cd.ok('P1 approving again is a no-op: the same row', (r->>'already')::boolean and (r->>'change_log_id')::uuid = ch);
  perform cd.ok('P2 the final row is approval''s alone',
    cd.try(format('update content_drafts set final_change_log_id = null where id = %L', p)) like '42501%');
  update content_drafts set status = 'draft' where id = p;
  perform cd.ok('P3 reopening returns the row to proposed (Billing: planned, not completed); the slot is not done',
    (select status::text from change_log where id = ch) = 'proposed'
    and (select status from content_plan_board where id = cd.id('i-page')) = 'drafting');
  update content_drafts set page_objective = 'Answer what a roof replacement involves, then invite a quote request.' where id = p;
  update content_drafts set status = 'in_review' where id = p;
  r := content_draft_approve(p, (select version from content_drafts where id = p));
  perform cd.ok('P4 re-approval updates the same row: approved, the new objective and version; still one row',
    (r->>'change_log_id')::uuid = ch
    and (select status::text = 'approved' and reasoning like 'Answer what a roof replacement involves%'
                and (after->>'version')::int = (select version from content_drafts where id = p) from change_log where id = ch)
    and (select count(*) from change_log where client_id = cd.id('a')) = 1
    and (select status from content_plan_board where id = cd.id('i-page')) = 'approved');
  -- A refresh: page_rewrite, with the existing page as before.
  r2 := content_draft_request(cd.id('i-page-2'), 'service', null, 'page_rewrite');
  p2 := (r2->>'draft_id')::uuid;
  perform cd.save('page2', p2::text);
  perform cd.ok('P5 a teammate cannot change a page''s kind or new / refresh',
    cd.try(format('update content_drafts set page_change = ''page_added'' where id = %L', p2)) like '23514%');
end $$;
\o
reset role;
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
select content_draft_write(cd.payload(cd.get('page2')::uuid, 270, array[cd.id('c-sourced')]));
\o
reset role;
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare r jsonb; p2 uuid := cd.get('page2')::uuid;
begin
  perform cd.ok('P6 a refresh in review has no change_log row yet', (select count(*) from change_log where client_id = cd.id('a')) = 1);
  update content_drafts set status = 'rejected', review_note = 'Keep the existing FAQ' where id = p2;
  perform cd.ok('P7 rejection creates no row', (select count(*) from change_log where client_id = cd.id('a')) = 1);
  update content_drafts set status = 'draft' where id = p2;
  update content_drafts set status = 'in_review' where id = p2;
  r := content_draft_approve(p2, (select version from content_drafts where id = p2));
  perform cd.ok('P8 an approved refresh is ONE page_rewrite row naming the existing page',
    (select change_type = 'page_rewrite' and before->>'url' = 'https://a.example.test/services/roof-replacement' and status::text = 'approved'
       from change_log where id = (r->>'change_log_id')::uuid)
    and (select count(*) from change_log where client_id = cd.id('a')) = 2);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── K. The weekly blog completes only at approval (0068) ────────────────────
\c - supabase_admin
\o /dev/null
insert into tasks (id, client_id, title, owner, status, key) values (cd.id('weekly'), cd.id('b'), 'Weekly blog post', 'CLAUDE', 'open', 'blog_post');
\o
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select cd.ok('K1 a teammate cannot open a weekly draft (the drafter''s only)',
  cd.try(format('select content_draft_open_weekly(%L::jsonb)', jsonb_build_object('task_id', cd.id('weekly'), 'topic', 'x', 'search_intent', 'informational'))) like '42501%');
\o
reset role;
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r jsonb; r2 jsonb;
begin
  r := content_draft_open_weekly(jsonb_build_object('task_id', cd.id('weekly'), 'topic', 'When to clear a slow drain', 'search_intent', 'informational'));
  perform cd.save('weekly_draft', r->>'draft_id');
  perform cd.ok('K2 the worker opens a draft for the weekly task: requested, in this week''s blog slot, the task in progress',
    (select status = 'requested' and source_task_id = cd.id('weekly') and plan_item_id = (r->>'plan_item_id')::uuid from content_drafts where id = (r->>'draft_id')::uuid)
    and (select deliverable = 'blog' and week_start = date_trunc('week', (now() at time zone 'America/Chicago'))::date
           from content_plan_items where id = (r->>'plan_item_id')::uuid)
    and (select status::text from tasks where id = cd.id('weekly')) = 'in_progress');
  r2 := content_draft_open_weekly(jsonb_build_object('task_id', cd.id('weekly'), 'topic', 'Something else', 'search_intent', 'informational'));
  perform cd.ok('K3 opening it again returns the same draft', (r2->>'reused')::boolean and r2->>'draft_id' = r->>'draft_id');
  r := content_draft_write(cd.payload(cd.get('weekly_draft')::uuid, 320, array[cd.id('c-b')]));
  perform cd.ok('K4 submitted for review, the weekly task stays open (Billing counts it as planned); no content_posts row',
    r->>'status' = 'in_review' and (select status::text from tasks where id = cd.id('weekly')) = 'in_progress'
    and (select count(*) from content_posts where client_id = cd.id('b')) = 0
    and (select status from content_plan_board where id = (select plan_item_id from content_drafts where id = cd.get('weekly_draft')::uuid)) = 'in_review');
end $$;
\o
reset role;
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare w uuid := cd.get('weekly_draft')::uuid; item uuid; r jsonb; v_post uuid;
begin
  select plan_item_id into item from content_drafts where id = w;
  update content_drafts set status = 'rejected', review_note = 'Shorter intro' where id = w;
  perform cd.ok('K5 rejection does not complete it', (select status::text from tasks where id = cd.id('weekly')) = 'in_progress'
    and (select status from content_plan_board where id = item) = 'drafting');
  update content_drafts set status = 'draft' where id = w;
  update content_drafts set status = 'in_review' where id = w;
  r := content_draft_approve(w, (select version from content_drafts where id = w));
  v_post := (r->>'content_post_id')::uuid;
  perform cd.ok('K6 approval completes it: the final row, the weekly task closed, the slot approved',
    (select status::text from content_posts where id = v_post) = 'approved'
    and (select status::text from tasks where id = cd.id('weekly')) = 'done'
    and (select status from content_plan_board where id = item) = 'approved');
  update content_drafts set status = 'draft' where id = w;
  perform cd.ok('K7 reopening un-completes the slot: the final row back to draft, the task stays closed, still one row',
    (select status::text from content_posts where id = v_post) = 'draft'
    and (select status from content_plan_board where id = item) = 'drafting'
    and (select status::text from tasks where id = cd.id('weekly')) = 'done'
    and (select count(*) from content_posts where client_id = cd.id('b')) = 1);
  update content_drafts set status = 'in_review' where id = w;
  r := content_draft_approve(w, (select version from content_drafts where id = w));
  perform cd.ok('K8 approved again: the same row, approved; the slot counts again',
    (r->>'content_post_id')::uuid = v_post and (select status::text from content_posts where id = v_post) = 'approved'
    and (select status from content_plan_board where id = item) = 'approved'
    and (select count(*) from content_posts where client_id = cd.id('b')) = 1);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Who sees drafts ─────────────────────────────────────────────────────────
\c - authenticator
select cd.as_user('authenticated', :'pa');
set role authenticated;
\o /dev/null
do $$
begin
  perform cd.ok('X1 a portal contact sees no draft and cannot request one',
    (select count(*) from content_drafts) = 0 and (select count(*) from content_draft_claims) = 0
    and cd.try(format('select content_draft_request(%L)', cd.id('i-blog-2'))) like '42501%');
end $$;
\o
reset role;
set role anon;
select cd.as_user('anon', null);
\o /dev/null
select cd.ok('X2 anon cannot read drafts or call the functions',
  cd.try('select count(*) from content_drafts') like '42501%'
  and cd.try(format('select content_draft_approve(%L, 1)', cd.get('blog'))) like '42501%');
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - postgres
\o
\pset footer off
select status, count(*) from cd.results group by status order by status;
select n, status, name, detail from cd.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from cd.results where status = 'fail';
  if f > 0 then raise exception '% content draft check(s) failed', f; end if;
end $$;
