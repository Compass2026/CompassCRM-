-- Tests for 20261019190532 (delegated content approval and publication), run
-- by scripts/test-portal-sandbox.sh after blog_tldr.test.sql (the cd harness,
-- fictional client a with its Compass-controlled site from
-- blog_publication.test.sql, client b with no delegation policy).
--
--   DG1-DG3   the gates: the service role cannot approve or queue on its own,
--             nor by forging the delegation setting; teammates and anon cannot
--             call the receipt functions or write receipts
--   DG4-DG7   recording: not an admin, an excluded client, unclear or mismatched intent
--             are refused and nothing is recorded
--   DG8-DG10  approve only: approved with Tom as reviewer and the assistant
--             named in the note, nothing queued; a replay is the same receipt
--             and changes nothing; the same operation for another request is
--             a conflict
--   DG11-DG14 binding: stale version, changed content, wrong destination and a
--             publish of an unapproved draft are refused, the receipt says
--             why, and nothing changed
--   DG15-DG17 approve and publish: both approved and queued once, released by
--             Tom; a second operation for the same drafts queues nothing new;
--             status reports queued / publishing / published with the URL
--   DG18-DG19 failed publication: status says failed with the reason; a
--             failure the publisher cannot prove was pre-write is not
--             requeued; a safe pre-write one is requeued once, history intact
--   DG20      content changed after approval invalidates it; a later publish
--             of the old version is refused

\set team '00000000-0000-4000-a000-000000000001'

\c - supabase_admin
\o /dev/null
update team_members set role = 'admin' where auth_user_id = :'team';
insert into team_members (name, email, role) values ('Delegation Member', 'dg-member@compassmarketing.ai', 'member');
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent, keyword_id, service_id, planned_date) values
  (cd.id('i-dg1'), cd.id('a'), date '2026-10-26', 'blog', null, 'educational', 'Delegation one', 'informational', cd.id('kw'), cd.id('svc'), date '2026-10-26'),
  (cd.id('i-dg2'), cd.id('a'), date '2026-10-26', 'blog', null, 'educational', 'Delegation two', 'informational', cd.id('kw'), cd.id('svc'), date '2026-10-27'),
  (cd.id('i-dg3'), cd.id('a'), date '2026-10-26', 'blog', null, 'educational', 'Delegation three', 'informational', cd.id('kw'), cd.id('svc'), date '2026-10-28');
create function cd.dg_payload(p_draft uuid, p_n text) returns jsonb language sql immutable as $$
  select jsonb_set(jsonb_set(cd.payload(p_draft, 320, array[cd.id('c-sourced')]),
    '{content,slug}', to_jsonb('delegation-' || p_n)), '{content,title}', to_jsonb('Delegation ' || p_n))
$$;
-- The request content-approvals would send, built from the live drafts.
create function cd.dg_req(p_op text, p_action text, p_drafts uuid[], p_text text,
                          p_email text default 'sandbox-team@compassmarketing.ai', p_dest text default 'https://draft.example.test',
                          p_client uuid default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('operation_id', p_op, 'client_id', coalesce(p_client, cd.id('a')), 'action', p_action,
    'items', (select jsonb_agg(jsonb_build_object('draft_id', d.id, 'version', d.version, 'review_hash', content_draft_review_hash(d))
                                 order by array_position(p_drafts, d.id))
                from content_drafts d where d.id = any(p_drafts)),
    'destination_url', p_dest, 'instruction_text', p_text, 'channel', 'claude', 'account_email', p_email,
    'executed_by', 'Claude (Executive OS MCP)', 'source_ref', '{"surface": "sandbox"}'::jsonb)
    || case when p_action = 'approve' then '{}'::jsonb else jsonb_build_object('publish_at', now()) end
$$;
-- What a PostgREST call is: one statement in its own transaction. A failed
-- execute rolls back, then the handler refuses the receipt.
create function cd.dg_authorize(p jsonb) returns text language plpgsql as $$
declare r jsonb; e text;
begin
  begin
    r := content_authorization_record(p);
  exception when others then
    return sqlstate || ' ' || sqlerrm;  -- refused at recording: nothing recorded
  end;
  if r->>'status' in ('executed', 'refused') then return 'replayed:' || (r->>'status'); end if;
  begin
    perform content_authorization_execute((r->>'id')::uuid);
  exception when others then
    e := sqlstate || ' ' || sqlerrm;
    perform content_authorization_refuse((r->>'id')::uuid, substring(sqlerrm from '^([a-z_]{3,40}):'), sqlerrm);
    return e;
  end;
  return 'executed';
end $$;
grant execute on all functions in schema cd to anon, authenticated, service_role, authenticator, postgres;
\o

\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select cd.save('dg1', content_draft_request(cd.id('i-dg1'))->>'draft_id');
select cd.save('dg2', content_draft_request(cd.id('i-dg2'))->>'draft_id');
select cd.save('dg3', content_draft_request(cd.id('i-dg3'))->>'draft_id');
-- 20261019230000: the central policy (every client, all channels) with one exclusion.
select content_delegation_exclude(cd.id('b'), null, 'sandbox: client b is excluded');
\o
reset role;

\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
select content_draft_write(cd.dg_payload(cd.get('dg1')::uuid, '1'));
select content_draft_write(cd.dg_payload(cd.get('dg2')::uuid, '2'));
select content_draft_write(cd.dg_payload(cd.get('dg3')::uuid, '3'));
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── The gates, without a receipt ────────────────────────────────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare d content_drafts;
begin
  select * into d from content_drafts where id = cd.get('dg1')::uuid;
  perform cd.ok('DG0 the three drafts are in review and approvable',
    (select count(*) = 3 from content_drafts where id in (cd.get('dg1')::uuid, cd.get('dg2')::uuid, cd.get('dg3')::uuid) and status = 'in_review'),
    (select string_agg(status, ',') from content_drafts where id in (cd.get('dg1')::uuid, cd.get('dg2')::uuid, cd.get('dg3')::uuid)));
  perform cd.ok('DG1 the service role alone can neither approve nor queue',
    cd.try(format('select content_draft_approve(%L, %s)', d.id, d.version)) like '42501%'
    and cd.try(format('select blog_publication_queue(%L, %s)', d.id, d.version)) like '42501%'
    and (select status = 'in_review' from content_drafts where id = d.id));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
begin
  perform cd.ok('DG2 a teammate cannot call the receipt functions or write receipts, but reads them',
    cd.try(format('select content_authorization_record(%L::jsonb)', cd.dg_req('dg-teammate-1', 'approve', array[cd.get('dg1')::uuid], 'Approve it'))) like '42501%'
    and cd.try(format('select content_review_batch(%L)', cd.id('a'))) like '42501%'
    and cd.try(format('insert into content_approval_authorizations (operation_id, request_hash, client_id, action, authorized_by, account_email, channel, executed_by, instruction_text, instructed_at, items, destination_url) select ''dg-forged-1'', ''sha256:'' || repeat(''0'', 64), %L, ''approve'', id, email, ''claude'', ''x'', ''Approve'', now(), ''[{}]'', ''https://draft.example.test'' from team_members limit 1', cd.id('a'))) like '42501%'
    and cd.try('select count(*) from content_approval_authorizations') is null);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role anon;
select cd.ok('DG3a anon reads no receipts and calls nothing',
  cd.try('select count(*) from content_approval_authorizations') like '42501%'
  and cd.try(format('select content_authorization_status(%L)', 'dg-anything-1')) like '42501%');
reset role;

-- ── Recording ───────────────────────────────────────────────────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare d1 uuid := cd.get('dg1')::uuid; e text;
begin
  e := cd.try(format('select content_authorization_record(%L::jsonb)',
    cd.dg_req('dg-member-1', 'approve', array[d1], 'Approve Blog A', 'dg-member@compassmarketing.ai')));
  perform cd.ok('DG4 an account that is not a Compass admin is refused', e like '42501%not_authorized%', e);
  e := cd.try(format('select content_authorization_record(%L::jsonb)',
    cd.dg_req('dg-nopolicy-1', 'approve', array[d1], 'Approve Blog A', p_client => cd.id('b'))));
  perform cd.ok('DG5 an excluded client is refused', e like '42501%policy_disallows%excluded%', e);
  e := cd.try(format('select content_authorization_record(%L::jsonb)',
    cd.dg_req('dg-intent-1', 'approve_and_publish', array[d1], 'Approve Blog A')));
  perform cd.ok('DG6 approve and publish needs publishing words', e like '22023%intent_unclear%', e);
  e := cd.try(format('select content_authorization_record(%L::jsonb)',
    cd.dg_req('dg-intent-2', 'approve', array[d1], 'Approve and publish Blog A')));
  perform cd.ok('DG7 approve alone refuses an instruction that asks to publish', e like '22023%intent_mismatch%', e);
  perform cd.ok('DG7a nothing was recorded for any refusal',
    (select count(*) = 0 from content_approval_authorizations where operation_id like 'dg-%'));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Approve only ────────────────────────────────────────────────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare d1 uuid := cd.get('dg1')::uuid; p jsonb; r text; me uuid; n int;
begin
  select id into me from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001';
  p := cd.dg_req('dg-approve-1', 'approve', array[d1], 'Approve Logic Blog A');
  perform cd.save('dg-approve-1', p::text);
  r := cd.dg_authorize(p);
  perform cd.ok('DG8 approve: approved at that version, Tom is the reviewer, the note names the assistant, nothing is queued',
    r = 'executed'
    and (select status = 'approved' and approved_version = version and reviewed_by = me
                and review_note like 'Approved by Sandbox Team through Claude (Executive OS); executed by Claude (Executive OS MCP).%"Approve Logic Blog A"'
           from content_drafts where id = d1)
    and (select count(*) = 1 from content_draft_reviews where draft_id = d1 and reviewed_by = me)
    and not exists (select 1 from blog_publications where draft_id = d1)
    and (select status = 'executed' and authorized_by = me and channel = 'claude' and executed_by = 'Claude (Executive OS MCP)'
                and instruction_text = 'Approve Logic Blog A' and source_ref = '{"surface": "sandbox"}' and executing_txid is null
                and jsonb_array_length(results) = 1
           from content_approval_authorizations where operation_id = 'dg-approve-1'),
    r);
  select count(*) into n from content_draft_reviews where draft_id = d1;
  r := cd.dg_authorize(p);
  perform cd.ok('DG9 the same request again is a replay: same receipt, nothing changes',
    r = 'replayed:executed' and (select count(*) = n from content_draft_reviews where draft_id = d1)
    and (select count(*) = 1 from content_approval_authorizations where operation_id = 'dg-approve-1'), r);
  r := cd.try(format('select content_authorization_record(%L::jsonb)', jsonb_set(p, '{instruction_text}', '"Approve Logic Blogs A and B"')));
  perform cd.ok('DG10 the same operation for a different request is a conflict', r like 'CD409%operation_reused%', r);
  perform cd.ok('DG10a a finished receipt cannot be edited',
    cd.try(format('update content_approval_authorizations set results = null where operation_id = %L', 'dg-approve-1')) like '42501%');
  perform set_config('compass.delegation', (select id::text from content_approval_authorizations where operation_id = 'dg-approve-1'), false);
  perform cd.ok('DG3 a forged delegation setting naming a finished receipt opens no gate',
    cd.try(format('select content_draft_approve(%L, %s)', cd.get('dg2'), (select version from content_drafts where id = cd.get('dg2')::uuid))) like '42501%');
  perform set_config('compass.delegation', '', false);
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
declare d1 uuid := cd.get('dg1')::uuid; d2 uuid := cd.get('dg2')::uuid; d3 uuid := cd.get('dg3')::uuid; p jsonb; r text;
begin
  p := cd.dg_req('dg-stale-1', 'approve_and_publish', array[d2, d3], 'Approve and publish Blogs B and C');
  p := jsonb_set(p, '{items,1,version}', to_jsonb(((p#>>'{items,1,version}')::int - 1)));
  r := cd.dg_authorize(p);
  perform cd.ok('DG11 a stale version refuses the whole batch and nothing changes',
    r like '23514%stale_version%'
    and (select count(*) = 2 from content_drafts where id in (d2, d3) and status = 'in_review')
    and not exists (select 1 from blog_publications where draft_id in (d2, d3))
    and (select status = 'refused' and refusal_code = 'stale_version' from content_approval_authorizations where operation_id = 'dg-stale-1'), r);

  p := cd.dg_req('dg-changed-1', 'approve', array[d2], 'Approve Blog B');
  p := jsonb_set(p, '{items,0,review_hash}', to_jsonb('sha256:' || repeat('f', 64)));
  r := cd.dg_authorize(p);
  perform cd.ok('DG12 content that differs from what was reviewed is refused',
    r like '23514%content_changed%' and (select status = 'in_review' from content_drafts where id = d2), r);

  r := cd.dg_authorize(cd.dg_req('dg-dest-1', 'approve_and_publish', array[d2], 'Approve and publish Blog B',
                                  p_dest => 'https://other.example.test'));
  perform cd.ok('DG13 a different destination is refused',
    r like '23514%wrong_destination%' and (select status = 'in_review' from content_drafts where id = d2), r);

  r := cd.dg_authorize(cd.dg_req('dg-unapproved-1', 'publish', array[d2], 'Publish Blog B'));
  perform cd.ok('DG14 publish alone needs an approval at the same version',
    r like '23514%not_approved%' and not exists (select 1 from blog_publications where draft_id = d2), r);
  perform cd.ok('DG14a the approve-only draft is untouched by the refusals',
    (select status = 'approved' from content_drafts where id = d1));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Approve and publish ─────────────────────────────────────────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare d2 uuid := cd.get('dg2')::uuid; d3 uuid := cd.get('dg3')::uuid; p jsonb; r text; me uuid; s jsonb;
begin
  select id into me from team_members where auth_user_id = '00000000-0000-4000-a000-000000000001';
  p := cd.dg_req('dg-pub-1', 'approve_and_publish', array[d2, d3], 'Approve and publish Logic Blogs B and C');
  r := cd.dg_authorize(p);
  perform cd.ok('DG15 approve and publish: both approved and queued once, released by Tom',
    r = 'executed'
    and (select count(*) = 2 from content_drafts where id in (d2, d3) and status = 'approved' and reviewed_by = me)
    and (select count(*) = 2 from blog_publications where draft_id in (d2, d3) and status = 'queued' and released_by = me)
    and (select jsonb_array_length(results) = 2 and bool_and((x->>'publication_id') is not null)
           from content_approval_authorizations, jsonb_array_elements(results) x where operation_id = 'dg-pub-1' group by results),
    r);
  r := cd.dg_authorize(p);
  perform cd.ok('DG16 a retried request and a new operation for the same drafts publish nothing twice',
    r = 'replayed:executed'
    and cd.dg_authorize(cd.dg_req('dg-pub-2', 'approve_and_publish', array[d2, d3], 'Approve and publish Logic Blogs B and C')) like '23514%not_in_review%'
    and cd.dg_authorize(cd.dg_req('dg-pub-3', 'publish', array[d2], 'Publish Blog B')) = 'executed'
    and (select count(*) = 1 from blog_publications where draft_id = d2 and status <> 'cancelled')
    and (select count(*) = 1 from blog_publications where draft_id = d3 and status <> 'cancelled'), r);
  s := content_authorization_status('dg-pub-1');
  perform cd.ok('DG17a status says queued for both',
    (select bool_and(x#>>'{publication,state}' = 'queued') and count(*) = 2 from jsonb_array_elements(s->'items_now') x)
    and not (s ? 'executing_txid'), s::text);
end $$;
\o
-- The publisher, as it writes its receipts.
select set_config('compass.blog_publication_write', 'on', false);
update blog_publications set status = 'publishing' where draft_id = cd.get('dg2')::uuid and status = 'queued';
\o /dev/null
select cd.ok('DG17b status says publishing while the publisher works',
  (select x#>>'{publication,state}' = 'publishing' from jsonb_array_elements(content_authorization_status('dg-pub-1')->'items_now') x
    where x->>'draft_id' = cd.get('dg2')));
\o
update blog_publications set status = 'published', published_url = 'https://draft.example.test/blog/delegation-2', published_at = now(),
       commit_sha = repeat('a', 40), evidence = '{}'::jsonb
 where draft_id = cd.get('dg2')::uuid and status = 'publishing';
update blog_publications set status = 'blocked', last_error = 'The website build failed before any write.', evidence = '{}'::jsonb
 where draft_id = cd.get('dg3')::uuid and status = 'queued';
select set_config('compass.blog_publication_write', '', false);
\o /dev/null
do $$
declare s jsonb := content_authorization_status('dg-pub-1'); b jsonb; c jsonb; r text; old uuid;
begin
  select x into b from jsonb_array_elements(s->'items_now') x where x->>'draft_id' = cd.get('dg2');
  select x into c from jsonb_array_elements(s->'items_now') x where x->>'draft_id' = cd.get('dg3');
  perform cd.ok('DG17 status says published with the actual URL',
    b#>>'{publication,state}' = 'published' and b#>>'{publication,published_url}' = 'https://draft.example.test/blog/delegation-2', b::text);
  perform cd.ok('DG18 status says failed with the reason',
    c#>>'{publication,state}' = 'failed' and c#>>'{publication,last_error}' like 'The website build failed%', c::text);
  old := (c#>>'{publication,id}')::uuid;
  perform cd.save('dg3-blocked', old::text);
  r := cd.dg_authorize(cd.dg_req('dg-retry-0', 'publish', array[cd.get('dg3')::uuid], 'Publish Blog C again'));
  perform cd.ok('DG19a a failure the publisher cannot prove was pre-write is not requeued: the receipt says why',
    r like '23514%needs reconciliation%'
    and (select status = 'blocked' from blog_publications where id = old)
    and (select count(*) = 1 from blog_publications where draft_id = cd.get('dg3')::uuid)
    and (select status = 'refused' from content_approval_authorizations where operation_id = 'dg-retry-0'), r);
end $$;
\o
-- The publisher's known pre-write refusal (nothing was written to the site).
select set_config('compass.blog_publication_write', 'on', false);
update blog_publications set last_error = 'Keyword, brand or campaign foundation changed since review. Regenerate and review before publishing.'
 where id = cd.get('dg3-blocked')::uuid;
select set_config('compass.blog_publication_write', '', false);
\o /dev/null
do $$
declare old uuid := cd.get('dg3-blocked')::uuid; r text;
begin
  r := cd.dg_authorize(cd.dg_req('dg-retry-1', 'publish', array[cd.get('dg3')::uuid], 'Publish Blog C again'));
  r := r || '|' || cd.dg_authorize(cd.dg_req('dg-retry-2', 'publish', array[cd.get('dg3')::uuid], 'Publish Blog C again'));
  perform cd.ok('DG19 a safe pre-write failure is requeued once by a new publish operation, history intact',
    r = 'executed|executed'
    and (select status = 'cancelled' and last_error like 'Keyword, brand%' from blog_publications where id = old)
    and (select count(*) = 1 from blog_publications where draft_id = cd.get('dg3')::uuid and status = 'queued')
    and (select x#>>'{publication,state}' = 'queued' from jsonb_array_elements(content_authorization_status('dg-pub-1')->'items_now') x
          where x->>'draft_id' = cd.get('dg3')), r);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── Content changes invalidate approval ─────────────────────────────────────
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare d content_drafts;
begin
  select * into d from content_drafts where id = cd.get('dg1')::uuid;
  perform cd.save('dg1-approved-version', d.version::text);
  perform cd.save('dg1-approved-hash', content_draft_review_hash(d));
  update content_drafts set status = 'draft' where id = d.id;
  update content_drafts set tldr = 'A changed summary. It says something new.' where id = d.id;
  update content_drafts set status = 'in_review' where id = d.id;
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare d content_drafts; p jsonb; r text;
begin
  select * into d from content_drafts where id = cd.get('dg1')::uuid;
  p := cd.dg_req('dg-after-edit-1', 'publish', array[d.id], 'Publish Blog A');
  p := jsonb_set(jsonb_set(p, '{items,0,version}', to_jsonb(cd.get('dg1-approved-version')::int)),
                 '{items,0,review_hash}', to_jsonb(cd.get('dg1-approved-hash')));
  r := cd.dg_authorize(p);
  perform cd.ok('DG20 an edit after approval invalidates it: the old version cannot be published',
    d.status = 'in_review' and d.approved_version is distinct from d.version
    and content_draft_review_hash(d) <> cd.get('dg1-approved-hash')
    and r like '23514%stale_version%' and not exists (select 1 from blog_publications where draft_id = d.id), r);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - supabase_admin
select status, count(*) from cd.results where name ~ '^DG[0-9]' group by status;
select n, status, name, detail from cd.results where name ~ '^DG[0-9]' and status <> 'pass' order by n;
do $$
begin
  if exists (select 1 from cd.results where name ~ '^DG[0-9]' and status = 'fail')
     or (select count(*) from cd.results where name ~ '^DG[0-9]') < 28 then
    raise exception 'content_delegation: failures above';
  end if;
end $$;
