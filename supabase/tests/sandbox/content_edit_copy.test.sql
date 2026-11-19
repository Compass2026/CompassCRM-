-- Tests for 20261029180000 (delegated copy edits), run by
-- scripts/test-portal-sandbox.sh after content_edits.test.sql (the cd harness;
-- sandbox-team@compassmarketing.ai is an admin there). A fictional client with
-- a Facebook Page, an approved service, three of its own claims (two sourced,
-- one unverified), another client's claim, and drafter-made posts in review.
--
--   CC1  a copy revision of a drafted post: withdrawn, copy set, exactly the
--        listed claims linked, resubmitted for a fresh review; the same post,
--        destination, service and media; never approved or scheduled
--   CC2  history names the assistant with the receipt and no person;
--        updated_by is the authorizing admin; the receipt keeps both copy
--        hashes, the brief hash and what was unlinked; no stage
--   CC3  a replay acts once
--   CC4  the copy must be checked clean, and be the copy that was checked
--   CC5  the authority must list replace_copy; the claims must be usable
--        claims of this client; a stale review hash is refused
--   CC6  recording: a copy edit carries no file fields
--   CC7  without the receipt the service role still cannot change a drafted
--        post's copy or claims, and a media receipt cannot change its copy
--   CC8  every refusal left its post exactly as it was
--   CC9  the rollback restores the pre-release definitions byte for byte

\c - supabase_admin
\o /dev/null
create schema pc;
create table pc.before (post_id uuid primary key, snap text);
insert into clients (id, name, city, state, status) values
  (cd.id('cc'), 'Copy Edit Solar Co (fictional)', 'Wichita', 'KS', 'active'),
  (cd.id('cc-other'), 'Other Copy Co (fictional)', 'Topeka', 'KS', 'active');
insert into services (id, client_id, name, status) values
  (cd.id('cc-svc'), cd.id('cc'), 'Residential Solar Panel Installation', 'approved');
insert into social_accounts (id, client_id, platform, external_account_id, display_name) values
  (cd.id('cc-fb'), cd.id('cc'), 'facebook', '888000111222', 'Copy Edit Page');
insert into claims (id, client_id, claim, status, source) values
  (cd.id('cc-roof'), cd.id('cc'), 'The size, shape, and slope of your roof are also important factors to consider.', 'sourced', 'https://www.energy.gov/eere/solar/homeowners-guide-going-solar'),
  (cd.id('cc-value'), cd.id('cc'), 'A solar energy system will likely increase a home’s value.', 'sourced', 'https://www.energy.gov/cmei/systems/consumers-guide-buying-house-solar-panels'),
  (cd.id('cc-unverified'), cd.id('cc'), 'Founded 2022', 'unverified', null),
  (cd.id('cc-o-claim'), cd.id('cc-other'), 'Another client''s claim.', 'sourced', 'https://example.org/other');
insert into brand_assets (id, client_id, kind, source, label, storage_path, mime_type, size_bytes, width, height, content_hash,
                          content_hashed_at, content_measurement) values
  (cd.id('cc-img'), cd.id('cc'), 'social_post', 'upload', 'Illustrative graphic', cd.id('cc')::text || '/upload/' || repeat('4', 64) || '.png',
   'image/png', 1900000, 1254, 1254, repeat('4', 64), now(), '{"bytes": 1900000, "content_type": "image/png", "measured_by": "sandbox"}');

insert into social_posts (id, client_id, platform, search_intent, crm_facts_only, copy, social_account_id, service_id) values
  (cd.id('c1'), cd.id('cc'), 'facebook', 'informational', false, 'Do solar panels increase home value? It depends. The size, shape, and slope of your roof are also important factors to consider.', cd.id('cc-fb'), cd.id('cc-svc')),
  (cd.id('c2'), cd.id('cc'), 'facebook', 'informational', false, 'A second drafted post. The size, shape, and slope of your roof are also important factors to consider.', cd.id('cc-fb'), cd.id('cc-svc'));
insert into drafter_runs (id, client_id, requested_via, target, brief_version, brief_hash, runtime, copy_hash, status) values
  (cd.id('cc-run1'), cd.id('cc'), 'worker', '{"campaignMode": "keyword"}', 'sandbox', 'sha256:' || repeat('0', 64), 'sandbox',
   drafter_copy_hash('Do solar panels increase home value? It depends. The size, shape, and slope of your roof are also important factors to consider.'), 'submitted'),
  (cd.id('cc-run2'), cd.id('cc'), 'worker', '{}', 'sandbox', 'sha256:' || repeat('0', 64), 'sandbox',
   drafter_copy_hash('A second drafted post. The size, shape, and slope of your roof are also important factors to consider.'), 'submitted');
set session_replication_role = replica;
update social_posts set drafter_run_id = cd.id('cc-run1') where id = cd.id('c1');
update social_posts set drafter_run_id = cd.id('cc-run2') where id = cd.id('c2');
set session_replication_role = origin;
insert into post_claims (post_id, client_id, claim_id) values
  (cd.id('c1'), cd.id('cc'), cd.id('cc-roof')), (cd.id('c2'), cd.id('cc'), cd.id('cc-roof'));
insert into post_assets (post_id, client_id, brand_asset_id, sort_order, role) values
  (cd.id('c1'), cd.id('cc'), cd.id('cc-img'), 1, 'media'), (cd.id('c2'), cd.id('cc'), cd.id('cc-img'), 1, 'media');
update social_posts set review_status = 'in_review' where client_id = cd.id('cc');

create function pc.copy() returns text language sql immutable as $$
  select 'Do solar panels increase home value? The U.S. Department of Energy puts it plainly: A solar energy system will likely increase a home’s value.'
$$;
-- The request content-approvals would send, built from the live post.
create function pc.req(p_op text, p_post uuid, p_copy text default pc.copy(), p_claims jsonb default null,
                       p_operations jsonb default '["replace_copy"]', p_hash text default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('operation_id', p_op, 'client_id', p.client_id,
    'post', jsonb_build_object('channel', p.platform::text, 'id', p.id, 'service_id', p.service_id,
                               'review_hash', coalesce(p_hash, content_social_review_hash(p)), 'destination', content_social_destination(p)->>'key'),
    'change', jsonb_build_object('kind', 'replace_copy', 'copy', p_copy,
                                 'claim_ids', coalesce(p_claims, jsonb_build_array(cd.id('cc-value')::text))),
    'executor', jsonb_build_object('channel', 'claude', 'executed_by', 'Claude via Executive OS', 'account_email', 'sandbox-team@compassmarketing.ai'),
    'authority', jsonb_build_object('kind', 'owner_approval', 'id', 'approval-sandbox', 'channels', '["facebook"]'::jsonb,
                                    'service_ids', jsonb_build_array(cd.id('cc-svc')::text), 'operations', p_operations),
    'reason', 'Answer the keyword question with the reviewed DOE claim.')
  from social_posts p where p.id = p_post
$$;
-- What content-approvals' copy check hands to execute.
create function pc.checked(p jsonb, p_ok boolean default true, p_copy text default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('lint_ok', p_ok, 'brief_hash', 'sha256:' || repeat('b', 64),
                            'checked_copy', coalesce(p_copy, p->'change'->>'copy'), 'warnings', '[]'::jsonb)
$$;
create function pc.revise(p jsonb, p_measured jsonb default null) returns text language plpgsql as $$
declare r jsonb; e text;
begin
  begin
    r := content_edit_record(p);
  exception when others then
    return sqlstate || ' ' || sqlerrm;
  end;
  if r->>'status' in ('executed', 'refused') then return 'replayed:' || (r->>'status'); end if;
  begin
    perform content_edit_execute((r->>'id')::uuid, coalesce(p_measured, pc.checked(p)));
  exception when others then
    e := sqlstate || ' ' || sqlerrm;
    perform content_edit_refuse((r->>'id')::uuid, substring(sqlerrm from '^([a-z_]{3,40}):'), sqlerrm);
    return e;
  end;
  return 'executed';
end $$;
create function pc.snap(p_post uuid) returns text language sql stable security definer set search_path = public, pg_temp as $$
  select p.review_status || '/' || p.publish_status || '/' || md5(p.copy) || '/'
    || coalesce((select string_agg(claim_id::text, ',' order by claim_id) from post_claims where post_id = p.id), '') || '/'
    || coalesce((select string_agg(brand_asset_id::text, ',' order by id) from post_assets where post_id = p.id), '') || '/'
    || (select count(*) from post_events e where e.post_id = p.id)
  from social_posts p where p.id = p_post
$$;
grant usage on schema pc to anon, authenticated, service_role, authenticator, postgres;
grant execute on all functions in schema pc to anon, authenticated, service_role, authenticator, postgres;
grant select, insert, update on pc.before to service_role;
\o

-- The function (authenticator + service_role).
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
insert into pc.before select id, pc.snap(id) from social_posts where id = cd.id('c2');
do $$
declare r text; rec content_edit_receipts; sp social_posts; old social_posts; old_task uuid; ev text; admin_id uuid;
begin
  select * into old from social_posts where id = cd.id('c1');
  old_task := old.review_task_id;
  perform cd.save('cc-req', pc.req('cc-rev-c1', cd.id('c1'))::text);
  r := pc.revise(cd.get('cc-req')::jsonb);
  select * into rec from content_edit_receipts where operation_id = 'cc-rev-c1';
  select * into sp from social_posts where id = cd.id('c1');
  select id into admin_id from team_members where email = 'sandbox-team@compassmarketing.ai';
  select string_agg(kind || ':' || actor_kind || ':' || coalesce(actor_id::text, '-'), ',' order by id) into ev
    from post_events where post_id = sp.id and actor_kind = 'assistant';
  perform cd.ok('CC1 a copy revision: withdrawn, copy set, exactly the listed claims, resubmitted fresh; same post, destination, service, media',
    r = 'executed' and rec.status = 'executed' and rec.stage_id is null
    and sp.copy = pc.copy() and sp.review_status = 'in_review' and sp.publish_status = 'not_scheduled'
    and sp.approved_hash is null and sp.reviewed_by is null and sp.submitted_at > old.submitted_at
    and sp.review_task_id is not null and sp.review_task_id is distinct from old_task
    and (select status = 'done' from tasks where id = old_task) and (select status = 'open' from tasks where id = sp.review_task_id)
    and (select array_agg(claim_id) = array[cd.id('cc-value')] from post_claims where post_id = sp.id)
    and (select array_agg(brand_asset_id) = array[cd.id('cc-img')] from post_assets where post_id = sp.id)
    and sp.social_account_id = old.social_account_id and sp.service_id = old.service_id and sp.drafter_run_id = old.drafter_run_id
    and sp.search_intent = old.search_intent and sp.keyword_id is not distinct from old.keyword_id,
    r || ' ' || coalesce(rec.refusal, '') || ' ' || coalesce(sp.review_status, ''));
  perform cd.ok('CC2 history: the assistant with the receipt, never a person; updated_by is the admin; the receipt records the change',
    ev like 'withdrawn:assistant:-,%' and ev like '%submitted:assistant:-'
    and not exists (select 1 from post_events e where e.post_id = sp.id and e.id > (select coalesce(max(id), 0) from post_events
                     where post_id = sp.id and actor_kind <> 'assistant' and created_at < rec.created_at)
                     and (e.actor_kind <> 'assistant' or e.detail->'edit'->>'receipt' is distinct from rec.id::text))
    and sp.updated_by = admin_id and rec.authorized_by = admin_id
    and rec.result->>'copy_hash' = drafter_copy_hash(pc.copy()) and rec.result->>'previous_copy_hash' = drafter_copy_hash(old.copy)
    and rec.result->>'brief_hash' = 'sha256:' || repeat('b', 64)
    and rec.result->'unlinked_claims' = jsonb_build_array(cd.id('cc-roof'))
    and rec.result->>'review_hash' = content_social_review_hash(sp)
    and rec.result->>'review_url' like '%/social/' || sp.id::text,
    ev || ' | ' || rec.result::text);
end $$;
do $$
declare n int := (select count(*) from post_events where post_id = cd.id('c1')); r text;
begin
  r := pc.revise(cd.get('cc-req')::jsonb);
  perform cd.ok('CC3 a replay acts once', r = 'replayed:executed' and (select count(*) from post_events where post_id = cd.id('c1')) = n, r);
end $$;
do $$
declare dirty text; wrong text; media_only text; foreign_claim text; unverified text; stale text; files text;
begin
  dirty := pc.revise(pc.req('cc-c2-dirty', cd.id('c2')), pc.checked(pc.req('cc-c2-dirty', cd.id('c2')), false));
  wrong := pc.revise(pc.req('cc-c2-wrong', cd.id('c2')), pc.checked(pc.req('cc-c2-wrong', cd.id('c2')), true, 'Some other copy that was checked.'));
  media_only := pc.revise(pc.req('cc-c2-media-auth', cd.id('c2'), p_operations => '["replace_media"]'));
  foreign_claim := pc.revise(pc.req('cc-c2-foreign', cd.id('c2'), p_claims => jsonb_build_array(cd.id('cc-o-claim')::text)));
  unverified := pc.revise(pc.req('cc-c2-unverified', cd.id('c2'), p_claims => jsonb_build_array(cd.id('cc-unverified')::text)));
  stale := pc.revise(pc.req('cc-c2-stale', cd.id('c2'), p_hash => 'sha256:' || repeat('c', 64)));
  files := pc.revise(pc.req('cc-c2-files', cd.id('c2')) #- '{change,claim_ids}' || jsonb_build_object('change',
             jsonb_build_object('kind', 'replace_copy', 'copy', pc.copy(), 'claim_ids', '[]'::jsonb, 'stage_id', gen_random_uuid(), 'sha256', repeat('5', 64))));
  perform cd.ok('CC4 the copy must be checked clean, and be the copy that was checked',
    dirty like '23514 lint_failed%' and wrong like '23514 lint_failed%' and (select status = 'refused' and refusal_code = 'lint_failed'
      from content_edit_receipts where operation_id = 'cc-c2-dirty'), concat_ws(' | ', dirty, wrong));
  perform cd.ok('CC5 the authority must list replace_copy; claims must be usable claims of this client; a stale read is refused',
    media_only like '23514 outside_authority%' and foreign_claim like '23514 claims_unusable%' and unverified like '23514 claims_unusable%'
    and stale like '23514 content_changed%', concat_ws(' | ', media_only, foreign_claim, unverified, stale));
  perform cd.ok('CC6 recording: a copy edit carries no file fields (nothing recorded)',
    files like '22023 request_invalid%' and not exists (select 1 from content_edit_receipts where operation_id = 'cc-c2-files'), files);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- CC7: the service role alone, and a media receipt, cannot change a drafted post's copy or claims.
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare direct text; claims text; res text;
begin
  -- Withdrawn first (anyone may withdraw), so the drafter guard is what
  -- answers, not the frozen-in-review rule; then rolled back.
  begin
    update social_posts set review_status = 'draft' where id = cd.id('c2');
    direct := cd.try(format('update social_posts set copy = %L where id = %L', 'Changed without a receipt.', cd.id('c2')));
    claims := cd.try(format('insert into post_claims (post_id, client_id, claim_id) values (%L, %L, %L)', cd.id('c2'), cd.id('cc'), cd.id('cc-value')));
    raise exception using errcode = 'P0001', message = concat_ws(' | ', direct, claims);
  exception when raise_exception then
    res := sqlerrm;
  end;
  perform cd.ok('CC7 without the receipt the service role cannot change a drafted post''s copy or claims, even as a draft',
    res like '42501: A drafted post''s content changes only through the post-drafter function or a person'
             || ' | 42501: A drafted post''s claims and assets change only through the post-drafter function or a person'
    and (select copy like 'A second drafted post.%' and review_status = 'in_review' from social_posts where id = cd.id('c2')),
    res);
end $$;
do $$
declare bad text;
begin
  select string_agg(b.post_id::text || ' ' || b.snap || ' -> ' || pc.snap(b.post_id), '; ') into bad
    from pc.before b where pc.snap(b.post_id) is distinct from b.snap;
  perform cd.ok('CC8 every refusal left its post exactly as it was (state, copy, claims, media, history)', bad is null, bad);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- CC7b: a media receipt executing for its post does not admit a copy change
-- (probed in a subtransaction that rolls back; only the answer survives).
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare res text; o social_posts; n social_posts;
begin
  begin
    perform set_config('compass.edit_write', 'on', true);
    insert into content_edit_receipts (operation_id, request_hash, client_id, post_id, channel, service_id, review_hash, destination, stage_id, change,
        authorized_by, account_email, executor_channel, executed_by, authority, reason, status, executing_txid)
    select 'cc-media-probe', 'sha256:' || repeat('d', 64), cd.id('cc'), cd.id('c2'), 'facebook', cd.id('cc-svc'), 'sha256:' || repeat('d', 64),
           'facebook:888000111222', (select id from content_edit_stages order by created_at limit 1),
           jsonb_build_object('kind', 'replace_media', 'copy', 'Smuggled copy.'), m.id, m.email, 'claude', 'probe',
           '{}'::jsonb, 'probe', 'executing', txid_current()
      from team_members m where m.email = 'sandbox-team@compassmarketing.ai';
    perform set_config('compass.content_edit', (select id::text from content_edit_receipts where operation_id = 'cc-media-probe'), true);
    select * into o from social_posts where id = cd.id('c2');
    n := o; n.copy := 'Smuggled copy.';
    res := 'active=' || content_edit_active()::text || ' allows=' || content_edit_copy_allows(o, n)::text
        || ' claim=' || content_edit_copy_claim(o.id, cd.id('cc-value'))::text;
    raise exception using errcode = 'P0001', message = res;
  exception when raise_exception then
    res := sqlerrm;
  end;
  perform cd.ok('CC7b a media receipt does not admit a copy or claim change', res = 'active=true allows=false claim=false', res);
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- CC9: the rollback restores the pre-release definitions byte for byte (its
-- own verify block checks the md5s), inside a transaction that is undone. The
-- sandbox's copy receipts are set aside first, as the script requires.
\c - supabase_admin
\o /dev/null
begin;
delete from content_edit_receipts where stage_id is null;
\ir ../../rollback/20261029180000_content_edit_copy.down.sql
do $$ begin
  if to_regprocedure('public.content_edit_copy_allows(social_posts,social_posts)') is not null then raise exception 'CC9: helper not dropped'; end if;
end $$;
\o
rollback;
\o /dev/null
-- (a failed check above stops psql under ON_ERROR_STOP, so reaching this line is the pass)
select cd.ok('CC9 the rollback restores the pre-release definitions (verified in a rolled-back transaction)', true);
\o

\c - supabase_admin
select status, count(*) from cd.results where name ~ '^CC[0-9]' group by status;
select n, status, name, detail from cd.results where name ~ '^CC[0-9]' and status <> 'pass' order by n;
do $$
begin
  if exists (select 1 from cd.results where name ~ '^CC[0-9]' and status = 'fail')
     or (select count(*) from cd.results where name ~ '^CC[0-9]') < 10 then
    raise exception 'content_edit_copy: failures above';
  end if;
end $$;
