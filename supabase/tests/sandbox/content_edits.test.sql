-- Tests for 20261020200000 (delegated post edits), run by
-- scripts/test-portal-sandbox.sh after content_delegation_channels.test.sql
-- (the cd harness; sandbox-team@compassmarketing.ai is an admin there,
-- dg-member@compassmarketing.ai is not). A fictional client with a Facebook
-- Page and a Business Profile location, a holiday-lighting and a roofing
-- service, and posts in every state.
--
--   CE1  the doors: a teammate and anon cannot call the content_edit functions
--   CE2  the batch returns each post's service_id
--   CE3  staging: content-addressed path, replay, a reused operation, another
--        client's post and the wrong channel
--   CE4  recording: a non-admin account, the switch off and an exclusion are
--        refused and nothing is recorded
--   CE5  a revision: withdrawn, media replaced by the measured file (a new
--        unreviewed asset with the provenance), resubmitted for a fresh review;
--        no approval, nothing scheduled; history names the assistant with the
--        receipt and no person; updated_by is the authorizing admin
--   CE6  a replay acts once; the same operation for another request conflicts
--   CE7  a drafter-made Business Profile post: revised under the receipt (the
--        asset row for the same bytes is reused); the service role alone
--        cannot swap a drafted post's media
--   CE8  identity: a compass.content_edit setting from an earlier transaction,
--        or a forged executing receipt, confers nothing
--   CE9  binding: declared service, the authority's services, the destination
--        and a post edited after it was read are refused; nothing changes
--   CE10 approved, published and scheduled posts are never revised
--   CE11 the file: bytes measured differently, nothing uploaded, an expired
--        stage, a consumed stage
--   CE12 a Creative Engine post is not revised here
--   CE13 status: the receipt and the post now
--   CE14 every refusal left its post exactly as it was

\set team '00000000-0000-4000-a000-000000000001'

\c - supabase_admin
\o /dev/null
create schema pe;
create table pe.before (post_id uuid primary key, review_status text, publish_status text, media text, events int);
insert into clients (id, name, city, state, status) values
  (cd.id('ce'), 'Editorial Lights Co (fictional)', 'Wentzville', 'MO', 'active'),
  (cd.id('ce-other'), 'Other Editorial Co (fictional)', 'Columbia', 'MO', 'active');
insert into services (id, client_id, name, status) values
  (cd.id('ce-holiday'), cd.id('ce'), 'Holiday Lighting Installation', 'approved'),
  (cd.id('ce-roof'), cd.id('ce'), 'Roof Replacement', 'approved'),
  (cd.id('ce-o-svc'), cd.id('ce-other'), 'Holiday Lighting Installation', 'approved');
insert into social_accounts (id, client_id, platform, external_account_id, display_name) values
  (cd.id('ce-fb'), cd.id('ce'), 'facebook', '777000111222', 'Editorial Page'),
  (cd.id('ce-gb'), cd.id('ce'), 'google_business', 'locations/7770001', 'Editorial Location'),
  (cd.id('ce-o-fb'), cd.id('ce-other'), 'facebook', '777000999888', 'Other Page');
-- The current (regular-logo) graphics, stored and hashed.
insert into brand_assets (id, client_id, kind, source, label, storage_path, mime_type, size_bytes, width, height, content_hash,
                          content_hashed_at, content_measurement) values
  (cd.id('ce-old'), cd.id('ce'), 'social_post', 'upload', 'Regular logo graphic', cd.id('ce')::text || '/upload/' || repeat('1', 64) || '.png',
   'image/png', 1900000, 1254, 1254, repeat('1', 64), now(), '{"bytes": 1900000, "content_type": "image/png", "measured_by": "sandbox"}'),
  (cd.id('ce-o-old'), cd.id('ce-other'), 'social_post', 'upload', 'Other graphic', cd.id('ce-other')::text || '/upload/' || repeat('2', 64) || '.png',
   'image/png', 1900000, 1254, 1254, repeat('2', 64), now(), '{"bytes": 1900000, "content_type": "image/png", "measured_by": "sandbox"}');
insert into storage.buckets (id, name) values ('brand-assets', 'brand-assets') on conflict do nothing;
insert into storage.objects (bucket_id, name, metadata) values
  ('brand-assets', cd.id('ce')::text || '/upload/' || repeat('1', 64) || '.png', '{"size": 1900000}'),
  ('brand-assets', cd.id('ce-other')::text || '/upload/' || repeat('2', 64) || '.png', '{"size": 1900000}'),
  -- The holiday-logo file the assistant uploaded (its slot path).
  ('brand-assets', cd.id('ce')::text || '/upload/' || encode(sha256('ce-holiday-logo'), 'hex') || '.png', '{"size": 2100000}');

insert into social_posts (id, client_id, platform, search_intent, crm_facts_only, copy, social_account_id, service_id) values
  (cd.id('p1'), cd.id('ce'), 'facebook', 'navigational', true, 'Editorial Lights Co: Christmas lights season is here.', cd.id('ce-fb'), cd.id('ce-holiday')),
  (cd.id('p2'), cd.id('ce'), 'google_business', 'navigational', true, 'Editorial Lights Co: Christmas light installation.', cd.id('ce-gb'), cd.id('ce-holiday')),
  (cd.id('p3'), cd.id('ce'), 'facebook', 'navigational', true, 'Editorial Lights Co: roof replacement.', cd.id('ce-fb'), cd.id('ce-roof')),
  (cd.id('p4'), cd.id('ce'), 'facebook', 'navigational', true, 'Editorial Lights Co: approved lights post.', cd.id('ce-fb'), cd.id('ce-holiday')),
  (cd.id('p5'), cd.id('ce'), 'facebook', 'navigational', true, 'Editorial Lights Co: published lights post.', cd.id('ce-fb'), cd.id('ce-holiday')),
  (cd.id('p6'), cd.id('ce'), 'facebook', 'navigational', true, 'Editorial Lights Co: scheduled lights post.', cd.id('ce-fb'), cd.id('ce-holiday')),
  (cd.id('p7'), cd.id('ce'), 'facebook', 'navigational', true, 'Editorial Lights Co: lights post, first copy.', cd.id('ce-fb'), cd.id('ce-holiday')),
  (cd.id('p8'), cd.id('ce-other'), 'facebook', 'navigational', true, 'Other Editorial Co: lights.', cd.id('ce-o-fb'), cd.id('ce-o-svc')),
  (cd.id('p9'), cd.id('ce'), 'facebook', 'navigational', true, 'Editorial Lights Co: creative engine post.', cd.id('ce-fb'), cd.id('ce-holiday')),
  (cd.id('p10'), cd.id('ce'), 'facebook', 'navigational', true, 'Editorial Lights Co: one more lights post.', cd.id('ce-fb'), cd.id('ce-holiday'));
-- p2 was made by the post drafter (as the Lucas GBP posts were).
insert into drafter_runs (id, client_id, requested_via, target, brief_version, brief_hash, runtime, copy_hash, status)
values (cd.id('ce-run'), cd.id('ce'), 'worker', '{}', 'sandbox', 'sha256:' || repeat('0', 64), 'sandbox',
        drafter_copy_hash('Editorial Lights Co: Christmas light installation.'), 'submitted');
set session_replication_role = replica;
update social_posts set drafter_run_id = cd.id('ce-run') where id = cd.id('p2');
set session_replication_role = origin;
insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role)
select id, client_id, case when client_id = cd.id('ce') then cd.id('ce-old') else cd.id('ce-o-old') end, 1, 'media'
  from social_posts where id in (cd.id('p1'), cd.id('p2'), cd.id('p3'), cd.id('p4'), cd.id('p5'), cd.id('p6'), cd.id('p7'), cd.id('p8'), cd.id('p10'));
-- p9's media is Creative Engine output.
insert into creative_assets (id, client_id, content_hash, storage_path, format, mime_type, width, height, size_bytes, strategy, purpose, provenance, alt_text)
values (cd.id('ce-creative'), cd.id('ce'), repeat('3', 64), cd.id('ce')::text || '/' || repeat('3', 64) || '.png', 'png', 'image/png',
        1254, 1254, 1800000, 'manual', 'post', '{"uploaded_via": "sandbox"}', 'Christmas lights on a ranch home at dusk (illustrative)');
insert into post_assets (post_id, client_id, creative_asset_id, sort_order, role, content_hash, copy_hash)
values (cd.id('p9'), cd.id('ce'), cd.id('ce-creative'), 1, 'media', repeat('3', 64), drafter_copy_hash('Editorial Lights Co: creative engine post.'));
update social_posts set review_status = 'in_review' where client_id in (cd.id('ce'), cd.id('ce-other'));

-- The request content-approvals would send, built from the live post (what
-- content_review_batch showed the assistant).
create function pe.sha(p text default 'ce-holiday-logo') returns text language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;
create function pe.stage_req(p_op text, p_post uuid, p_sha text default pe.sha(), p_client uuid default null, p_channel text default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('operation_id', p_op, 'client_id', coalesce(p_client, p.client_id),
    'post', jsonb_build_object('channel', coalesce(p_channel, p.platform::text), 'id', p.id),
    'file', jsonb_build_object('sha256', p_sha, 'size_bytes', 2100000, 'mime_type', 'image/png', 'width', 1254, 'height', 1254,
                               'file_name', 'xmas-holiday-logo.png'))
  from social_posts p where p.id = p_post
$$;
create function pe.req(p_op text, p_post uuid, p_stage uuid, p_sha text default pe.sha(),
                       p_email text default 'sandbox-team@compassmarketing.ai', p_services jsonb default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('operation_id', p_op, 'client_id', p.client_id,
    'post', jsonb_build_object('channel', p.platform::text, 'id', p.id, 'service_id', p.service_id,
                               'review_hash', content_social_review_hash(p), 'destination', content_social_destination(p)->>'key'),
    'change', jsonb_build_object('kind', 'replace_media', 'stage_id', p_stage, 'sha256', p_sha, 'label', 'Holiday logo graphic',
                                 'provenance', 'AI-generated illustrative concept; holiday logo composited; non-evidentiary.'),
    'executor', jsonb_build_object('channel', 'claude', 'executed_by', 'Claude via Executive OS', 'account_email', p_email),
    'authority', jsonb_build_object('kind', 'standing_policy', 'id', 'policy-sandbox', 'channels', '["facebook", "google_business"]'::jsonb,
                                    'service_ids', coalesce(p_services, jsonb_build_array(cd.id('ce-holiday')::text)), 'operations', '["replace_media"]'::jsonb),
    'reason', 'Tom asked for the holiday logo on every Christmas Lights post.',
    'source_ref', '{"surface": "sandbox"}'::jsonb)
  from social_posts p where p.id = p_post
$$;
-- What the function measured from the stored bytes.
create function pe.measured(p_sha text default pe.sha(), p_bytes bigint default 2100000) returns jsonb language sql immutable as $$
  select jsonb_build_object('content_hash', p_sha, 'bytes', p_bytes, 'content_type', 'image/png', 'width', 1254, 'height', 1254,
                            'raw_width', 1254, 'raw_height', 1254, 'orientation', 1)
$$;
-- One PostgREST call per step, as the handler makes them.
create function pe.stage(p jsonb) returns text language plpgsql as $$
begin return content_edit_stage(p)->>'id';
exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create function pe.revise(p jsonb, p_measured jsonb default pe.measured()) returns text language plpgsql as $$
declare r jsonb; e text;
begin
  begin
    r := content_edit_record(p);
  exception when others then
    return sqlstate || ' ' || sqlerrm;  -- refused at recording: nothing recorded
  end;
  if r->>'status' in ('executed', 'refused') then return 'replayed:' || (r->>'status'); end if;
  begin
    perform content_edit_execute((r->>'id')::uuid, p_measured);
  exception when others then
    e := sqlstate || ' ' || sqlerrm;
    perform content_edit_refuse((r->>'id')::uuid, substring(sqlerrm from '^([a-z_]{3,40}):'), sqlerrm);
    return e;
  end;
  return 'executed';
end $$;
create function pe.identity() returns text language sql stable security definer set search_path = public, pg_temp as $$
  select post_caller_kind() || '/' || content_edit_active()::text
$$;
-- A post's state, for "nothing changed".
create function pe.snap(p_post uuid) returns text language sql stable security definer set search_path = public, pg_temp as $$
  select p.review_status || '/' || p.publish_status || '/' || coalesce((select string_agg(coalesce(pa.content_hash, ''), ',' order by pa.id)
    from post_assets pa where pa.post_id = p.id), '') || '/' || (select count(*) from post_events e where e.post_id = p.id)
  from social_posts p where p.id = p_post
$$;
create function pe.save_snaps() returns void language sql security definer set search_path = public, pg_temp as $$
  insert into pe.before select p.id, p.review_status, p.publish_status, pe.snap(p.id), 0 from social_posts p
   where p.client_id in (cd.id('ce'), cd.id('ce-other')) and p.id <> all (array[cd.id('p1'), cd.id('p2')])
  on conflict (post_id) do update set media = excluded.media
$$;
grant usage on schema pe to anon, authenticated, service_role, authenticator, postgres;
grant execute on all functions in schema pe to anon, authenticated, service_role, authenticator, postgres;
grant select, insert, update on pe.before to service_role, authenticated;
\o

-- Team: approve p4, p5, p6; mark p5 published by hand; schedule p6.
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
update social_posts set review_status = 'approved' where id in (cd.id('p4'), cd.id('p5'), cd.id('p6'));
update social_posts set publish_status = 'published', published_at = now(), published_url = 'https://www.facebook.com/777000111222/posts/1'
 where id = cd.id('p5');
update social_posts set publish_status = 'scheduled', scheduled_at = now() + interval '2 days' where id = cd.id('p6');
\o
-- CE1: the doors are the function's alone.
do $$
begin
  perform cd.ok('CE1 a teammate cannot call the content_edit functions or write their tables',
    cd.try('select content_edit_stage(''{}'')') like '42501%' and cd.try('select content_edit_record(''{}'')') like '42501%'
    and cd.try(format('select content_edit_execute(%L, ''{}'')', gen_random_uuid())) like '42501%'
    and cd.try('select content_edit_status(''x'')') like '42501%'
    and cd.try(format('insert into content_edit_stages (operation_id, request_hash, client_id, post_id, channel, sha256, size_bytes, mime_type, width, height, file_name, storage_path, expires_at)
                       values (''forged-0001'', ''sha256:%s'', %L, %L, ''facebook'', %L, 1, ''image/png'', 1, 1, ''x.png'', ''x'', now())',
                      repeat('0', 64), cd.id('ce'), cd.id('p1'), repeat('0', 64))) like '42501%');
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role anon;
select cd.as_user('anon', null);
do $$
begin
  perform cd.ok('CE1b anon cannot call them either',
    cd.try('select content_edit_record(''{}'')') like '42501%' and cd.try('select content_edit_status(''x'')') like '42501%');
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- The function (authenticator + service_role).
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
select pe.save_snaps();
do $$
declare b jsonb := content_review_batch(cd.id('ce'), 'facebook'); s1 text; s1b text; s1c text; s1d text; s1e text;
begin
  perform cd.ok('CE2 the batch returns each post''s service_id',
    exists (select 1 from jsonb_array_elements(b->'items') i where i->>'id' = cd.id('p1')::text and i->>'service_id' = cd.id('ce-holiday')::text)
    and exists (select 1 from jsonb_array_elements(b->'items') i where i->>'id' = cd.id('p3')::text and i->>'service_id' = cd.id('ce-roof')::text), b::text);

  s1 := pe.stage(pe.stage_req('ce-stage-p1', cd.id('p1')));
  s1b := pe.stage(pe.stage_req('ce-stage-p1', cd.id('p1')));
  s1c := pe.stage(pe.stage_req('ce-stage-p1', cd.id('p1'), pe.sha('another file')));
  s1d := pe.stage(pe.stage_req('ce-stage-wrong-client', cd.id('p8'), pe.sha(), cd.id('ce')));
  s1e := pe.stage(pe.stage_req('ce-stage-wrong-channel', cd.id('p1'), pe.sha(), null, 'google_business'));
  perform cd.save('stage-p1', s1);
  perform cd.ok('CE3 staging: one content-addressed slot per operation; a reused operation, another client''s post and the wrong channel are refused',
    (select storage_path = cd.id('ce')::text || '/upload/' || pe.sha() || '.png' and expires_at > now() and consumed_at is null
       from content_edit_stages where id = s1::uuid)
    and s1b = s1 and s1c like 'CD409 operation_reused%' and s1d like '23514 post_not_found%' and s1e like '23514 channel_mismatch%'
    and (select count(*) = 1 from content_edit_stages where client_id = cd.id('ce')),
    concat_ws(' | ', s1, s1b, s1c, s1d, s1e));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- CE4: refusals at recording (switch off, exclusion) need an admin to flip them.
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select content_delegation_configure_edits(false);
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r1 text; r2 text;
begin
  r1 := pe.revise(pe.req('ce-off-1', cd.id('p1'), cd.get('stage-p1')::uuid));
  r2 := pe.stage(pe.stage_req('ce-stage-off', cd.id('p10')));
  perform cd.save('off', concat_ws(' | ', r1, r2));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select content_delegation_configure_edits(true);
select cd.save('excl', (content_delegation_exclude(cd.id('ce'), 'facebook', 'sandbox: edits paused for this Page'))->>'id');
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r3 text; r4 text;
begin
  r3 := pe.revise(pe.req('ce-excl-1', cd.id('p1'), cd.get('stage-p1')::uuid));
  perform cd.save('excluded', r3);
  r4 := pe.revise(pe.req('ce-member-1', cd.id('p1'), cd.get('stage-p1')::uuid, pe.sha(), 'dg-member@compassmarketing.ai'));
  perform cd.save('member', r4);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select content_delegation_include(cd.get('excl')::uuid);
\o
do $$
begin
  perform cd.ok('CE4 a non-admin account, the switch off and an exclusion are refused, and nothing is recorded',
    cd.get('off') like '42501 policy_disallows: Delegated edits are switched off%| 42501 policy_disallows%'
    and cd.get('excluded') like '42501 policy_disallows: Editorial Lights Co (fictional) is excluded%'
    and cd.get('member') like '42501 not_authorized%'
    and (select count(*) = 0 from content_edit_receipts where client_id = cd.id('ce'))
    and (select review_status = 'in_review' from social_posts where id = cd.id('p1')),
    concat_ws(' || ', cd.get('off'), cd.get('excluded'), cd.get('member')));
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- CE5-CE7: revisions.
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare r text; rec content_edit_receipts; sp social_posts; a brand_assets; old_task uuid; ev text; admin_id uuid;
begin
  select review_task_id into old_task from social_posts where id = cd.id('p1');
  perform cd.save('p1-hash-before', content_social_review_hash(p)) from social_posts p where p.id = cd.id('p1');
  perform cd.save('req-p1', pe.req('ce-rev-p1', cd.id('p1'), cd.get('stage-p1')::uuid)::text);
  r := pe.revise(cd.get('req-p1')::jsonb);
  select * into rec from content_edit_receipts where operation_id = 'ce-rev-p1';
  select * into sp from social_posts where id = cd.id('p1');
  select ba.* into a from post_assets pa join brand_assets ba on ba.id = pa.brand_asset_id where pa.post_id = sp.id;
  select id into admin_id from team_members where email = 'sandbox-team@compassmarketing.ai';
  select string_agg(kind || ':' || actor_kind || ':' || coalesce(actor_id::text, '-'), ',' order by id) into ev
    from post_events where post_id = sp.id and id > coalesce((select max(id) from post_events where post_id = sp.id and kind = 'submitted' and actor_kind <> 'assistant'), 0);
  perform cd.save('p1-receipt', rec.id::text);
  perform cd.ok('CE5 a revision: withdrawn, media replaced, resubmitted for a fresh review; never approved or scheduled',
    r = 'executed' and rec.status = 'executed'
    and sp.review_status = 'in_review' and sp.publish_status = 'not_scheduled' and sp.approved_hash is null and sp.reviewed_by is null
    and sp.review_task_id is not null and sp.review_task_id is distinct from old_task
    and (select status = 'done' from tasks where id = old_task) and (select status = 'open' from tasks where id = sp.review_task_id)
    and (select count(*) = 1 from post_assets where post_id = sp.id)
    and a.content_hash = pe.sha() and a.kind = 'social_post' and a.creative_use = 'unreviewed' and a.depicts_own_work is null
    and a.notes like 'AI-generated illustrative concept; holiday logo composited; non-evidentiary.%Claude via Executive OS%sandbox-team@compassmarketing.ai%'
    and a.content_measurement->>'measured_by' = 'content-approvals/editorial'
    and rec.result->>'review_hash' = content_social_review_hash(sp) and rec.result->>'review_hash' <> cd.get('p1-hash-before')
    and rec.result->'removed_assets'->0->>'content_hash' = repeat('1', 64) and rec.result->'added_asset'->>'content_hash' = pe.sha()
    and (select consumed_by = rec.id from content_edit_stages where id = cd.get('stage-p1')::uuid),
    r || ' ' || coalesce(rec.refusal, '') || ' ' || sp.review_status);
  perform cd.ok('CE5b history: the assistant with the receipt, never a person; updated_by is the authorizing admin',
    ev = 'withdrawn:assistant:-,asset_unlinked:assistant:-,asset_linked:assistant:-,submitted:assistant:-'
    and not exists (select 1 from post_events e where e.post_id = sp.id and e.actor_kind = 'assistant'
                     and (e.detail->'edit'->>'receipt' is distinct from rec.id::text or e.detail->'edit'->>'executed_by' <> 'Claude via Executive OS'
                          or e.detail->'edit'->>'authorized_by' <> admin_id::text))
    and sp.updated_by = admin_id and rec.authorized_by = admin_id,
    ev);
end $$;
do $$
declare n int := (select count(*) from post_events where post_id = cd.id('p1')); r text; c text;
begin
  -- The identical request again (a retry): the receipt, nothing more.
  r := pe.revise(cd.get('req-p1')::jsonb);
  -- The same operation id, a different request: the receipt is not reused.
  c := pe.revise(jsonb_set(cd.get('req-p1')::jsonb, '{reason}', '"something else"'));
  perform cd.ok('CE6 a replay acts once; the same operation for another request conflicts',
    r = 'replayed:executed' and c like 'CD409 operation_reused%'
    and (select count(*) from post_events where post_id = cd.id('p1')) = n
    and (select count(*) = 1 from content_edit_receipts where operation_id = 'ce-rev-p1'), r || ' | ' || c);
end $$;
do $$
declare st text; r text; sp social_posts; denied text;
begin
  st := pe.stage(pe.stage_req('ce-stage-p2', cd.id('p2')));
  r := pe.revise(pe.req('ce-rev-p2', cd.id('p2'), st::uuid));
  select * into sp from social_posts where id = cd.id('p2');
  -- Without a receipt the service role cannot swap a drafted post's media.
  denied := cd.try(format('do $x$ begin update social_posts set review_status = ''draft'' where id = %L;
    delete from post_assets where post_id = %L; end $x$', cd.id('p2'), cd.id('p2')));
  perform cd.ok('CE7 a drafter-made Business Profile post is revised under the receipt, reusing the asset for the same bytes; not without it',
    r = 'executed' and sp.review_status = 'in_review' and sp.drafter_run_id = cd.id('ce-run')
    and (select pa.brand_asset_id from post_assets pa where pa.post_id = cd.id('p2'))
        = (select pa.brand_asset_id from post_assets pa where pa.post_id = cd.id('p1'))
    and (select count(*) = 1 from brand_assets where client_id = cd.id('ce') and content_hash = pe.sha())
    and denied like '42501%' and (select review_status = 'in_review' from social_posts where id = cd.id('p2')),
    concat_ws(' | ', st, r, denied));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- CE8: identity is the executing receipt in THIS transaction, nothing else.
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
select set_config('compass.content_edit', cd.get('p1-receipt'), false);  -- left on the connection
select cd.save('stale-identity', pe.identity());
select cd.save('recorded-only', content_edit_record(pe.req('ce-recorded-only', cd.id('p10'), pe.stage(pe.stage_req('ce-stage-p10', cd.id('p10'))) ::uuid))->>'id');
select set_config('compass.content_edit', '', false);
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - supabase_admin
\o /dev/null
update content_edit_receipts set status = 'executing', executing_txid = 1 where id = cd.get('recorded-only')::uuid;
\o

\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
select set_config('compass.content_edit', cd.get('recorded-only'), false);
select cd.save('forged-identity', pe.identity());
select cd.save('forged-swap', coalesce(cd.try(format('insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role) values (%L, %L, %L, 2, ''media'')',
  cd.id('p2'), cd.id('ce'), cd.id('ce-old'))), 'inserted'));
select set_config('compass.content_edit', '', false);
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - supabase_admin
\o /dev/null
update content_edit_receipts set status = 'recorded', executing_txid = null where id = cd.get('recorded-only')::uuid;
\o
do $$
begin
  perform cd.ok('CE8 a setting from an earlier transaction, or a forged executing receipt, confers nothing',
    cd.get('stale-identity') = 'publisher/false' and cd.get('forged-identity') = 'publisher/false'
    and cd.get('forged-swap') like '42501%' and (select count(*) = 1 from post_assets where post_id = cd.id('p2')),
    concat_ws(' | ', cd.get('stale-identity'), cd.get('forged-identity'), cd.get('forged-swap')));
end $$;

-- CE9-CE12: refusals; each leaves its post as it was.
-- p7 is read, then edited (withdrawn, copy changed, resubmitted) before the revision runs.
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
select cd.save('stage-p7', pe.stage(pe.stage_req('ce-stage-p7', cd.id('p7'))));
select cd.save('req-p7', pe.req('ce-rev-p7', cd.id('p7'), cd.get('stage-p7')::uuid)::text);
\o
reset role;
select set_config('request.jwt.claims', '', false);
\c - supabase_admin
\o /dev/null
update social_posts set review_status = 'draft' where id = cd.id('p7');
update social_posts set copy = 'Editorial Lights Co: lights post, second copy.' where id = cd.id('p7');
update social_posts set review_status = 'in_review' where id = cd.id('p7');
\o

\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
select pe.save_snaps();  -- p7 as edited; the others as they are
do $$
declare st3 text := pe.stage(pe.stage_req('ce-stage-p3', cd.id('p3'))); svc text; outside text; dest text; stale text;
begin
  svc := pe.revise(jsonb_set(pe.req('ce-rev-p3-svc', cd.id('p3'), st3::uuid), '{post,service_id}', to_jsonb(cd.id('ce-holiday')::text)));
  outside := pe.revise(pe.req('ce-rev-p3-out', cd.id('p3'), st3::uuid));
  dest := pe.revise(jsonb_set(pe.req('ce-rev-p10-dest', cd.id('p10'), pe.stage(pe.stage_req('ce-stage-p10', cd.id('p10')))::uuid),
                              '{post,destination}', '"facebook:999999999999"'));
  stale := pe.revise(cd.get('req-p7')::jsonb);
  perform cd.ok('CE9 a declared service that is not the post''s, a service outside the authority, another Page and a post edited after it was read are refused',
    svc like '23514 service_mismatch%' and outside like '23514 outside_authority%' and dest like '23514 wrong_destination%'
    and stale like '23514 content_changed%'
    and (select count(*) = 4 from content_edit_receipts where operation_id in ('ce-rev-p3-svc', 'ce-rev-p3-out', 'ce-rev-p10-dest', 'ce-rev-p7')
                                                             and status = 'refused' and refusal_code in ('service_mismatch', 'outside_authority', 'wrong_destination', 'content_changed')),
    concat_ws(' | ', svc, outside, dest, stale));
end $$;
do $$
declare r4 text; r5 text; r6 text;
begin
  r4 := pe.revise(pe.req('ce-rev-p4', cd.id('p4'), pe.stage(pe.stage_req('ce-stage-p4', cd.id('p4')))::uuid));
  r5 := pe.revise(pe.req('ce-rev-p5', cd.id('p5'), pe.stage(pe.stage_req('ce-stage-p5', cd.id('p5')))::uuid));
  r6 := pe.revise(pe.req('ce-rev-p6', cd.id('p6'), pe.stage(pe.stage_req('ce-stage-p6', cd.id('p6')))::uuid));
  perform cd.ok('CE10 approved, published and scheduled posts are never revised',
    r4 like '23514 not_editable: the post is approved / not_scheduled%' and r5 like '23514 not_editable: the post is approved / published%'
    and r6 like '23514 not_editable: the post is approved / scheduled%'
    and (select review_status = 'approved' and approved_hash is not null from social_posts where id = cd.id('p4'))
    and (select publish_status = 'published' and published_url like 'https://www.facebook.com/%' from social_posts where id = cd.id('p5'))
    and (select publish_status = 'scheduled' from social_posts where id = cd.id('p6')),
    concat_ws(' | ', r4, r5, r6));
end $$;
do $$
declare st text := pe.stage(pe.stage_req('ce-stage-p10', cd.id('p10'))); other text := pe.sha('nobody uploaded this');
        mism text; size text; missing text; consumed text;
begin
  mism := pe.revise(pe.req('ce-rev-p10-mism', cd.id('p10'), st::uuid), pe.measured(pe.sha('different bytes')));
  size := pe.revise(pe.req('ce-rev-p10-size', cd.id('p10'), st::uuid), pe.measured(pe.sha(), 2100001));
  missing := pe.revise(pe.req('ce-rev-p10-missing', cd.id('p10'), pe.stage(pe.stage_req('ce-stage-p10-missing', cd.id('p10'), other))::uuid, other),
                       pe.measured(other));
  consumed := pe.revise(pe.req('ce-rev-p10-consumed', cd.id('p10'), cd.get('stage-p1')::uuid));
  perform cd.save('stage-p10', st);
  perform cd.ok('CE11 bytes measured differently, a different size, nothing uploaded and another post''s (consumed) stage are refused',
    mism like '23514 bytes_mismatch%' and size like '23514 bytes_mismatch%' and missing like '23514 bytes_missing%'
    and consumed like '23514 stage_not_found%',
    concat_ws(' | ', mism, size, missing, consumed));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - supabase_admin
\o /dev/null
update content_edit_stages set expires_at = now() - interval '1 minute' where id = cd.get('stage-p10')::uuid;
\o

\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare expired text; creative text;
begin
  expired := pe.revise(pe.req('ce-rev-p10-expired', cd.id('p10'), cd.get('stage-p10')::uuid));
  creative := pe.revise(pe.req('ce-rev-p9', cd.id('p9'), pe.stage(pe.stage_req('ce-stage-p9', cd.id('p9')))::uuid));
  perform cd.ok('CE11b an expired stage is refused', expired like '23514 stage_expired%', expired);
  perform cd.ok('CE12 a Creative Engine post is not revised here', creative like '23514 creative_engine_post%', creative);
end $$;
do $$
declare s jsonb := content_edit_status('ce-rev-p1'); f jsonb := content_edit_status('ce-rev-p4'); n jsonb := content_edit_status('no-such-op');
begin
  perform cd.ok('CE13 status: the receipt with the post now; a refusal with its reason; none for an unknown operation',
    s->>'status' = 'executed' and s->'post_now'->>'review_status' = 'in_review' and s->'post_now'->'media'->0->>'content_hash' = pe.sha()
    and s->>'executed_by' = 'Claude via Executive OS' and not (s ? 'executing_txid')
    and f->>'status' = 'refused' and f->>'refusal_code' = 'not_editable' and n is null, s::text);
end $$;
do $$
declare bad text;
begin
  select string_agg(b.post_id::text || ' ' || b.media || ' -> ' || pe.snap(b.post_id), '; ') into bad
    from pe.before b where pe.snap(b.post_id) is distinct from b.media;
  perform cd.ok('CE14 every refusal left its post exactly as it was (state, media, history)', bad is null, bad);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - supabase_admin
select status, count(*) from cd.results where name ~ '^CE[0-9]' group by status;
select n, status, name, detail from cd.results where name ~ '^CE[0-9]' and status <> 'pass' order by n;
do $$
begin
  if exists (select 1 from cd.results where name ~ '^CE[0-9]' and status = 'fail')
     or (select count(*) from cd.results where name ~ '^CE[0-9]') < 17 then
    raise exception 'content_edits: failures above';
  end if;
end $$;
