-- Tests for 20261117010000 (pending changes keep a post out of Ready; revising
-- a rejected post through the delegated door), run by
-- scripts/test-portal-sandbox.sh after content_edit_copy.test.sql (the cd
-- harness; sandbox-team@compassmarketing.ai is an admin there). A fictional
-- client with a Facebook Page, a service, two sourced claims and posts in
-- review.
--
--   RP1  a hold opens for a post in review (idempotent per ref; the same ref
--        for another post or change conflicts); teammates and anon cannot call it
--   RP2  the queue shows the post under Needs preparation with the pending
--        change; the batch lists it; without a hold the same post is Ready
--   RP3  approving a post with an open hold is refused, whoever approves
--   RP4  release (superseded, with the newer ref) closes it; Ready again;
--        a second release and an unknown ref release nothing
--   RP5  holds refuse: an approved post, another client's post, the wrong channel
--   RP6  an approved copy revision closes its own hold (executed)
--   RP7  a refused approved revision closes its own hold (refused)
--   RP8  reject with feedback → the batch lists it with the feedback →
--        unchanged copy cannot come back → a revised copy comes back through
--        the delegated door for a fresh review; history keeps every step;
--        the queue shows it Ready
--   RP9  holds are records: written only by the functions, never deleted,
--        closed once
--   RP10 the rollback restores the previous definitions (run and undone)

\set team '00000000-0000-4000-a000-000000000001'
\c - supabase_admin
\o /dev/null
create schema rp;
insert into clients (id, name, city, state, status) values
  (cd.id('rp'), 'Pending Change Solar Co (fictional)', 'Wichita', 'KS', 'active'),
  (cd.id('rp-other'), 'Other Pending Co (fictional)', 'Topeka', 'KS', 'active');
insert into services (id, client_id, name, status) values
  (cd.id('rp-svc'), cd.id('rp'), 'Residential Solar Panel Installation', 'approved');
insert into social_accounts (id, client_id, platform, external_account_id, display_name) values
  (cd.id('rp-fb'), cd.id('rp'), 'facebook', '888000333444', 'Pending Change Page');
insert into claims (id, client_id, claim, status, source) values
  (cd.id('rp-roof'), cd.id('rp'), 'The size, shape, and slope of your roof are also important factors to consider.', 'sourced', 'https://www.energy.gov/eere/solar/homeowners-guide-going-solar'),
  (cd.id('rp-value'), cd.id('rp'), 'A solar energy system will likely increase a home’s value.', 'sourced', 'https://www.energy.gov/cmei/systems/consumers-guide-buying-house-solar-panels');
insert into brand_assets (id, client_id, kind, source, label, storage_path, mime_type, size_bytes, width, height, content_hash,
                          content_hashed_at, content_measurement) values
  (cd.id('rp-img'), cd.id('rp'), 'photo', 'upload', 'Rooftop array (job photo)', cd.id('rp')::text || '/upload/' || repeat('6', 64) || '.jpg',
   'image/jpeg', 300000, 1080, 1350, repeat('6', 64), now(), '{"bytes": 300000, "content_type": "image/jpeg", "measured_by": "sandbox"}');
insert into social_posts (id, client_id, platform, search_intent, crm_facts_only, copy, social_account_id, service_id) values
  (cd.id('rp1'), cd.id('rp'), 'facebook', 'informational', false, 'Thinking about solar? The size, shape, and slope of your roof are also important factors to consider. (rp1)', cd.id('rp-fb'), cd.id('rp-svc')),
  (cd.id('rp2'), cd.id('rp'), 'facebook', 'informational', false, 'Thinking about solar? The size, shape, and slope of your roof are also important factors to consider. (rp2)', cd.id('rp-fb'), cd.id('rp-svc')),
  (cd.id('rp3'), cd.id('rp'), 'facebook', 'informational', false, 'Thinking about solar? The size, shape, and slope of your roof are also important factors to consider. (rp3)', cd.id('rp-fb'), cd.id('rp-svc')),
  (cd.id('rp4'), cd.id('rp'), 'facebook', 'informational', false, 'Thinking about solar? The size, shape, and slope of your roof are also important factors to consider. (rp4)', cd.id('rp-fb'), cd.id('rp-svc'));
insert into post_claims (post_id, client_id, claim_id)
  select id, client_id, cd.id('rp-roof') from social_posts where client_id = cd.id('rp');
insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role)
  select id, client_id, cd.id('rp-img'), 1, 'media' from social_posts where client_id = cd.id('rp');
update social_posts set review_status = 'in_review' where client_id = cd.id('rp');

create function rp.hold(p_ref text, p_post uuid, p_kind text default 'replace_copy', p_client uuid default null, p_channel text default 'facebook')
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ref', p_ref, 'client_id', coalesce(p_client, p.client_id),
    'post', jsonb_build_object('channel', p_channel, 'id', p.id), 'kind', p_kind,
    'review_hash', content_social_review_hash(p), 'summary', 'Revise one Facebook post in Compass: replace its copy',
    'requested_by', 'Claude via Executive OS')
  from social_posts p where p.id = p_post
$$;
create function rp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create function rp.ref(p text) returns text language sql immutable as $$ select cd.id(p)::text $$;
-- The copy revision content-approvals would send (owner_approval = the hold's ref).
create function rp.req(p_op text, p_post uuid, p_copy text, p_ref text, p_hash text default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('operation_id', p_op, 'client_id', p.client_id,
    'post', jsonb_build_object('channel', p.platform::text, 'id', p.id, 'service_id', p.service_id,
                               'review_hash', coalesce(p_hash, content_social_review_hash(p)), 'destination', content_social_destination(p)->>'key'),
    'change', jsonb_build_object('kind', 'replace_copy', 'copy', p_copy, 'claim_ids', jsonb_build_array(cd.id('rp-value')::text)),
    'executor', jsonb_build_object('channel', 'claude', 'executed_by', 'Claude via Executive OS', 'account_email', 'sandbox-team@compassmarketing.ai'),
    'authority', jsonb_build_object('kind', 'owner_approval', 'id', p_ref, 'channels', '["facebook"]'::jsonb,
                                    'service_ids', jsonb_build_array(cd.id('rp-svc')::text), 'operations', '["replace_copy"]'::jsonb),
    'reason', 'Tom''s feedback, applied.')
  from social_posts p where p.id = p_post
$$;
create function rp.revise(p jsonb) returns text language plpgsql as $$
declare r jsonb; e text;
begin
  begin r := content_edit_record(p); exception when others then return sqlstate || ' ' || sqlerrm; end;
  if r->>'status' in ('executed', 'refused') then return 'replayed:' || (r->>'status'); end if;
  begin
    perform content_edit_execute((r->>'id')::uuid, jsonb_build_object('lint_ok', true, 'brief_hash', 'sha256:' || repeat('b', 64),
      'checked_copy', p->'change'->>'copy', 'warnings', '[]'::jsonb));
  exception when others then
    e := sqlstate || ' ' || sqlerrm;
    perform content_edit_refuse((r->>'id')::uuid, substring(sqlerrm from '^([a-z_]{3,40}):'), sqlerrm);
    return e;
  end;
  return 'executed';
end $$;
create function rp.q(p_post uuid) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select x from jsonb_array_elements(review_queue(cd.id('rp'))) x where x->>'id' = p_post::text
$$;
create function rp.batch_item(p_post uuid) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select x from jsonb_array_elements(content_review_batch(cd.id('rp'))->'items') x where x->>'id' = p_post::text
$$;
grant usage on schema rp to anon, authenticated, service_role, authenticator, postgres;
grant execute on all functions in schema rp to anon, authenticated, service_role, authenticator, postgres;
\o

-- rp4 is approved by a teammate (a hold may not open on it).
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
update social_posts set review_status = 'approved' where id = cd.id('rp4');
\o
reset role;

-- ── RP1 / RP5: opening holds (the function's door) ───────────────────────────
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare a jsonb; b jsonb; c text; d text; e text; f text;
begin
  a := content_edit_hold_open(rp.hold(rp.ref('h1'), cd.id('rp1')));
  b := content_edit_hold_open(rp.hold(rp.ref('h1'), cd.id('rp1')));
  c := rp.try(format('select content_edit_hold_open(%L::jsonb)', rp.hold(rp.ref('h1'), cd.id('rp2'))));
  perform cd.ok('RP1 a hold opens for a post in review; the same ref replays; the same ref for another post conflicts',
    a->>'replayed' = 'false' and b->>'replayed' = 'true' and a->>'id' = b->>'id' and a->>'closed_at' is null
    and c like 'CD409 operation_reused%', c);
  d := rp.try(format('select content_edit_hold_open(%L::jsonb)', rp.hold(rp.ref('h-approved'), cd.id('rp4'))));
  e := rp.try(format('select content_edit_hold_open(%L::jsonb)', rp.hold(rp.ref('h-other'), cd.id('rp2'), 'replace_copy', cd.id('rp-other'))));
  f := rp.try(format('select content_edit_hold_open(%L::jsonb)', rp.hold(rp.ref('h-channel'), cd.id('rp2'), 'replace_copy', null, 'google_business')));
  perform cd.ok('RP5 holds refuse an approved post, another client''s post and the wrong channel',
    d like '23514 not_holdable: the post is approved%' and e like '23514 post_not_found%' and f like '23514 channel_mismatch%'
    and not exists (select 1 from content_edit_holds where ref in (rp.ref('h-approved'), rp.ref('h-other'), rp.ref('h-channel'))),
    concat_ws(' | ', d, e, f));
  perform cd.ok('RP2b the batch lists the pending change for the operator',
    jsonb_array_length(rp.batch_item(cd.id('rp1'))->'pending_changes') = 1
    and rp.batch_item(cd.id('rp1'))->'pending_changes'->0->>'ref' = rp.ref('h1')
    and rp.batch_item(cd.id('rp1'))->'pending_changes'->0->>'stale' = 'false'
    and jsonb_array_length(rp.batch_item(cd.id('rp2'))->'pending_changes') = 0);
end $$;
\o
reset role;

-- Teammates and anon cannot open or close holds.
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare a text; b text; c text;
begin
  a := rp.try(format('select content_edit_hold_open(%L::jsonb)', rp.hold(rp.ref('h-team'), cd.id('rp2'))));
  b := rp.try(format('select content_edit_hold_close(%L, %L)', rp.ref('h1'), 'withdrawn'));
  c := rp.try(format('insert into content_edit_holds (ref, client_id, post_id, channel, kind, summary, requested_by) values (%L, %L, %L, %L, %L, %L, %L)',
                     rp.ref('h-direct'), cd.id('rp'), cd.id('rp2'), 'facebook', 'replace_copy', 'x', 'y'));
  perform cd.ok('RP1b a teammate cannot open, close or write holds', a like '42501%' and b like '42501%' and c like '42501%', concat_ws(' | ', a, b, c));

  -- RP2: the queue.
  perform cd.ok('RP2 the queue keeps a post with a pending change under Needs preparation; the same post without one is Ready',
    rp.q(cd.id('rp1'))->>'stage' = 'needs_preparation'
    and rp.q(cd.id('rp1'))->'pending_changes'->0->>'kind' = 'replace_copy'
    and rp.q(cd.id('rp1'))->'pending_changes'->0->>'requested_by' = 'Claude via Executive OS'
    and rp.q(cd.id('rp2'))->>'stage' = 'ready' and jsonb_array_length(rp.q(cd.id('rp2'))->'pending_changes') = 0,
    concat_ws(' | ', rp.q(cd.id('rp1'))->>'stage', rp.q(cd.id('rp2'))->>'stage'));

  -- RP3: approval refused while the change is pending.
  a := rp.try(format('update social_posts set review_status = %L where id = %L', 'approved', cd.id('rp1')));
  perform cd.ok('RP3 approving a post with a pending change is refused',
    a like '23514 pending_change: a copy change for this post is waiting in Executive OS%'
    and (select review_status = 'in_review' from social_posts where id = cd.id('rp1')), a);
end $$;
\o
reset role;

-- ── RP4: release ──────────────────────────────────────────────────────────────
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare a jsonb; b jsonb; c jsonb; d text;
begin
  a := content_edit_hold_close(rp.ref('h1'), 'superseded', 'Refiled against the new review hash', rp.ref('h1-new'));
  b := content_edit_hold_close(rp.ref('h1'), 'withdrawn');
  c := content_edit_hold_close(rp.ref('nope'), 'rejected');
  d := rp.try(format('select content_edit_hold_close(%L, %L, null, %L)', rp.ref('h1'), 'withdrawn', rp.ref('x')));
  perform cd.ok('RP4 release closes the hold (superseded, with the newer ref); again or unknown releases nothing',
    a->>'released' = 'true' and a->'hold'->>'close_reason' = 'superseded' and a->'hold'->>'superseded_by_ref' = rp.ref('h1-new')
    and b->>'released' = 'false' and b->'hold'->>'close_reason' = 'superseded'
    and c->>'released' = 'false' and c->'hold' = 'null'::jsonb and d like '22023%', d);
end $$;
\o
reset role;
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select cd.ok('RP4b with the change released the post is Ready again', rp.q(cd.id('rp1'))->>'stage' = 'ready');
\o
reset role;

-- ── RP6 / RP7: approved revisions close their own holds ──────────────────────
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r text; h content_edit_holds;
begin
  perform content_edit_hold_open(rp.hold(rp.ref('h2'), cd.id('rp2')));
  r := rp.revise(rp.req('rp-rev-2', cd.id('rp2'),
         'Do solar panels add value? The U.S. Department of Energy puts it plainly: A solar energy system will likely increase a home’s value.',
         rp.ref('h2')));
  select * into h from content_edit_holds where ref = rp.ref('h2');
  perform cd.ok('RP6 the approved copy revision runs and closes its own hold (executed)',
    r = 'executed' and h.close_reason = 'executed' and h.close_note like 'Applied by content-approvals edit %'
    and (select review_status = 'in_review' from social_posts where id = cd.id('rp2')), r);

  perform content_edit_hold_open(rp.hold(rp.ref('h3'), cd.id('rp3')));
  r := rp.revise(rp.req('rp-rev-3', cd.id('rp3'), 'Any copy at all.', rp.ref('h3'), 'sha256:' || repeat('0', 64)));
  select * into h from content_edit_holds where ref = rp.ref('h3');
  perform cd.ok('RP7 a refused approved revision closes its own hold (refused) and changes nothing',
    r like '23514 content_changed%' and h.close_reason = 'refused' and h.close_note like 'content_changed%'
    and (select copy like '%(rp3)' from social_posts where id = cd.id('rp3')), r);
end $$;
\o
reset role;

-- ── RP8: reject with feedback → revise → fresh review ────────────────────────
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
update social_posts set review_status = 'rejected', review_note = 'Answer the value question with the DOE source, not the roof line.',
       rejection_category = 'copy' where id = cd.id('rp3');
select cd.ok('RP8a the rejected post shows as revising with the feedback',
  rp.q(cd.id('rp3'))->>'stage' = 'revising' and rp.q(cd.id('rp3'))->>'last_feedback' like 'Answer the value question%');
\o
reset role;
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r1 text; r2 text; b jsonb := rp.batch_item(cd.id('rp3'));
begin
  perform cd.ok('RP8b the batch lists the rejected post with its feedback and category',
    b->>'status' = 'rejected' and b->>'feedback' like 'Answer the value question%' and b->>'rejection_category' = 'copy', b::text);
  -- Unchanged copy cannot come back (the rejection guard), and nothing changes.
  r1 := rp.revise(rp.req('rp-rev-3-same', cd.id('rp3'),
         (select copy from social_posts where id = cd.id('rp3')), rp.ref('h4')));
  perform cd.ok('RP8c the rejected copy cannot come back unchanged through the door',
    r1 like '23514 grounding_failed:%copy is unchanged%' and (select review_status = 'rejected' from social_posts where id = cd.id('rp3')), r1);
  r2 := rp.revise(rp.req('rp-rev-3-new', cd.id('rp3'),
         'Wondering if solar adds value? The U.S. Department of Energy says it plainly: A solar energy system will likely increase a home’s value.',
         rp.ref('h5')));
  perform cd.ok('RP8d a revised copy comes back through the door for a fresh review, unapproved',
    r2 = 'executed' and (select review_status = 'in_review' and approved_hash is null and reviewed_by is null and rejected_copy_hash is null
                         from social_posts where id = cd.id('rp3')), r2);
end $$;
\o
reset role;
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select cd.ok('RP8e history keeps the rejection, the copy change and the resubmission; the queue shows it Ready',
  (select array_agg(kind order by id) from social_post_history where post_id = cd.id('rp3'))
     = array['rejected', 'copy_changed', 'resubmitted']
  and rp.q(cd.id('rp3'))->>'stage' = 'ready',
  (select array_agg(kind order by id)::text from social_post_history where post_id = cd.id('rp3')) || ' ' || coalesce(rp.q(cd.id('rp3'))->>'stage', '-'));
\o
reset role;

-- ── RP9: holds are records ───────────────────────────────────────────────────
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare a text; b text; c text;
begin
  a := rp.try(format('delete from content_edit_holds where ref = %L', rp.ref('h1')));
  b := rp.try(format('update content_edit_holds set summary = %L where ref = %L', 'changed', rp.ref('h1')));
  perform set_config('compass.edit_hold', 'on', true);
  c := rp.try(format('update content_edit_holds set closed_at = now(), close_reason = %L where ref = %L', 'withdrawn', rp.ref('h1')));
  perform set_config('compass.edit_hold', '', true);
  perform cd.ok('RP9 holds are never deleted and close once; nothing but the functions writes them',
    a like '42501%' and b like '42501%' and c like '42501 A closed hold is a record%', concat_ws(' | ', a, b, c));
end $$;
\o
reset role;

-- RP10: the rollback restores the previous definitions (in a transaction that is undone).
\c - supabase_admin
\o /dev/null
begin;
select set_config('compass.drop_holds', 'yes', true);
\ir ../../rollback/20261117010000_review_pending_changes.down.sql
do $$ begin
  if to_regclass('public.content_edit_holds') is not null then raise exception 'RP10: holds table not dropped'; end if;
  if position('pending_changes' in pg_get_functiondef('public.review_queue(uuid)'::regprocedure)) > 0 then raise exception 'RP10: review_queue not restored'; end if;
  if position('content_edit_holds' in pg_get_functiondef('public.review_queue(uuid)'::regprocedure)) > 0 then raise exception 'RP10: review_queue still reads holds'; end if;
  if position('in review is revised' in pg_get_functiondef('public.content_edit_execute(uuid,jsonb)'::regprocedure)) = 0 then raise exception 'RP10: content_edit_execute not restored'; end if;
  if position('''rejected''' in pg_get_functiondef('public.content_review_batch(uuid,text)'::regprocedure)) > 0 then raise exception 'RP10: batch not restored'; end if;
end $$;
\o
rollback;
\o /dev/null
-- (a failed check above stops psql under ON_ERROR_STOP, so reaching this line is the pass)
select cd.ok('RP10 the rollback restores the previous definitions and drops the holds (verified in a rolled-back transaction)',
  to_regclass('public.content_edit_holds') is not null);
\o

\c - supabase_admin
select status, count(*) from cd.results where name ~ '^RP[0-9]' group by status;
select n, status, name, detail from cd.results where name ~ '^RP[0-9]' and status <> 'pass' order by n;
do $$
begin
  if exists (select 1 from cd.results where name ~ '^RP[0-9]' and status = 'fail')
     or (select count(*) from cd.results where name ~ '^RP[0-9]') < 17 then
    raise exception 'review_pending_changes: failures above';
  end if;
end $$;
