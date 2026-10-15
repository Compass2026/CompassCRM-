-- Tests for 20261011040705_drafter_facebook.sql (AI Drafter: Facebook drafts),
-- run by scripts/test-portal-sandbox.sh on the same replay as drafter.test.sql.
-- Own harness schema (fd).
--
-- Callers are real sessions, the way each reaches production:
--   worker     psql as postgres (the Supabase connector's login)
--   drafter    psql as authenticator, role service_role (the post-drafter
--              Edge Function through PostgREST)
--   person     psql as authenticator, role authenticated, team JWT
-- What it proves: a Facebook draft exists only through drafter_write, names
-- one of the client's own Facebook Pages, carries no button and at most one
-- stored, hashed photo or graphic of the client, lands in review and is never
-- approved or scheduled by it; one open draft per concept (copy, image);
-- Business Profile drafts are unchanged. Fictional data only.

\set team   '00000000-0000-4000-a000-000000000001'
\set ca     '00000000-0000-4000-b000-00000000000a'
\set cb     '00000000-0000-4000-b000-00000000000b'

\o /dev/null
-- ── Harness ─────────────────────────────────────────────────────────────────
create schema fd;
create table fd.results (n serial, status text, name text, detail text);
create table fd.ids (k text primary key, id uuid);
grant usage on schema fd to anon, authenticated, service_role;
grant insert, select on fd.results to anon, authenticated, service_role;
grant select, insert on fd.ids to anon, authenticated, service_role;
grant usage on sequence fd.results_n_seq to anon, authenticated, service_role;

create function fd.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into fd.results (status, name, detail)
  values (case when coalesce(p_pass, false) then 'pass' else 'fail' end, p_name, p_detail)
$$;
create function fd.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function fd.as_user(p_role text, p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_sub is null then json_build_object('role', p_role)::text
         else json_build_object('role', p_role, 'sub', p_sub)::text end, false);
end $$;
create function fd.id(p_k text) returns uuid language sql stable as $$ select id from fd.ids where k = p_k $$;

-- A drafter_write request shaped like the post-drafter function's Facebook
-- submit: client B's approved "Panel upgrades" service, a standard post with
-- no button, on the named Page.
create function fd.req(p_copy text, p_account uuid, p_assets uuid[] default '{}',
                       p_claims uuid[] default array['00000000-0000-4000-f000-00000000003b']::uuid[],
                       p_intent text default 'informational', p_channel text default 'facebook',
                       p_post_type text default 'standard', p_cta jsonb default '{"type": null, "url": null}',
                       p_opp uuid default null)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'client_id', '00000000-0000-4000-b000-00000000000b', 'requested_via', 'worker', 'runtime', 'sandbox-model', 'attempt', 1,
    'brief_version', 'drafter-brief/1', 'brief_hash', 'sha256:' || repeat('cd', 32),
    'authority_opportunity_id', p_opp,
    'brief', jsonb_build_object(
      'client', jsonb_build_object('id', '00000000-0000-4000-b000-00000000000b'),
      'target', jsonb_build_object('channel', p_channel, 'post_type', p_post_type, 'search_intent', p_intent,
        'service', jsonb_build_object('id', '00000000-0000-4000-e000-00000000002b', 'name', 'Panel upgrades'),
        'keyword', null, 'cta', p_cta, 'offer', null,
        'social_account', case when p_account is null then null
                               else jsonb_build_object('id', p_account, 'page_id', 'x', 'name', 'Page') end),
      'allowed_facts', jsonb_build_object('claims',
        (select coalesce(jsonb_agg(jsonb_build_object('id', c)), '[]') from unnest(p_claims) c))),
    'lint', jsonb_build_object('ok', true, 'problems', '[]'::jsonb, 'warnings', '[]'::jsonb),
    'copy', p_copy, 'claim_ids', to_jsonb(p_claims), 'asset_ids', to_jsonb(p_assets))
$$;
grant execute on all functions in schema fd to anon, authenticated, service_role;

-- ── Fixtures (as the cluster superuser) ─────────────────────────────────────
\c - supabase_admin
do $$
declare v uuid;
begin
  insert into social_accounts (client_id, platform, external_account_id, display_name)
  values ('00000000-0000-4000-b000-00000000000b', 'facebook', 'fd-b-page', 'Client B Drafter Page') returning id into v;
  insert into fd.ids values ('fb_b', v);
  insert into social_accounts (client_id, platform, external_account_id, display_name)
  values ('00000000-0000-4000-b000-00000000000a', 'facebook', 'fd-a-page', 'Client A Drafter Page') returning id into v;
  insert into fd.ids values ('fb_a', v);
  insert into social_accounts (client_id, platform, external_account_id, display_name)
  values ('00000000-0000-4000-b000-00000000000b', 'instagram', 'fd-b-ig', 'Client B IG') returning id into v;
  insert into fd.ids values ('ig_b', v);

  insert into brand_assets (client_id, kind, label, source, storage_path, mime_type, width, height, content_hash, content_hashed_at, notes)
  values ('00000000-0000-4000-b000-00000000000b', 'social_post', '01-panel-check', 'upload',
          '00000000-0000-4000-b000-00000000000b/upload/' || repeat('11', 32) || '.png', 'image/png', 1080, 1350,
          repeat('11', 32), now(), 'ChatGPT-generated / non-evidentiary visual.') returning id into v;
  insert into fd.ids values ('g1', v);
  insert into brand_assets (client_id, kind, label, source, storage_path, mime_type, width, height, content_hash, content_hashed_at)
  values ('00000000-0000-4000-b000-00000000000b', 'social_post', '02-panel-safety', 'upload',
          '00000000-0000-4000-b000-00000000000b/upload/' || repeat('22', 32) || '.png', 'image/png', 1080, 1350,
          repeat('22', 32), now()) returning id into v;
  insert into fd.ids values ('g2', v);
  insert into brand_assets (client_id, kind, label, source, storage_path, mime_type, width, height)
  values ('00000000-0000-4000-b000-00000000000b', 'social_post', 'unhashed graphic', 'upload',
          '00000000-0000-4000-b000-00000000000b/upload/unhashed.png', 'image/png', 1080, 1350) returning id into v;
  insert into fd.ids values ('unhashed', v);
  insert into brand_assets (client_id, kind, label, source, storage_path, mime_type, width, height, content_hash, content_hashed_at)
  values ('00000000-0000-4000-b000-00000000000b', 'logo_primary', 'B logo', 'upload',
          '00000000-0000-4000-b000-00000000000b/logo-fd.png', 'image/png', 600, 200, repeat('33', 32), now()) returning id into v;
  insert into fd.ids values ('logo', v);
  insert into brand_assets (client_id, kind, label, source, storage_path, mime_type, width, height, content_hash, content_hashed_at)
  values ('00000000-0000-4000-b000-00000000000a', 'social_post', 'A graphic', 'upload',
          '00000000-0000-4000-b000-00000000000a/upload/' || repeat('44', 32) || '.png', 'image/png', 1080, 1350,
          repeat('44', 32), now()) returning id into v;
  insert into fd.ids values ('g_a', v);
end $$;

-- ── A. The worker's own SQL cannot create or call ───────────────────────────
\c - postgres
do $$
declare st text; n0 bigint := (select count(*) from social_posts);
begin
  st := fd.try(format($q$insert into social_posts (client_id, platform, search_intent, service_id, copy, social_account_id)
                values ('00000000-0000-4000-b000-00000000000b', 'facebook', 'informational',
                        '00000000-0000-4000-e000-00000000002b', 'Panel upgrades for older homes.', %L)$q$, fd.id('fb_b')));
  perform fd.ok('A1 a direct worker insert of a Facebook post is refused', st like '42501:%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('Panel upgrades for older homes.', fd.id('fb_b'))));
  perform fd.ok('A2 the worker cannot call drafter_write for Facebook', st like '42501:%', st);
  perform fd.ok('A3 nothing was written', (select count(*) from social_posts) = n0);
end $$;
set role service_role;
select fd.as_user('service_role', null);
do $$
declare st text;
begin
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('Panel upgrades for older homes.', fd.id('fb_b'))));
  perform fd.ok('A4 SET ROLE service_role does not let the worker call drafter_write', st like '42501:%', st);
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- ── D. The post-drafter function (authenticator → service_role) ─────────────
\c - authenticator
set role service_role;
select fd.as_user('service_role', null);
do $$
declare
  st text; res jsonb; r0 bigint; n0 bigint;
  v_copy text := 'An older panel can be worth a look before you add new appliances. Licensed electricians. Request a quote.';
begin
  res := drafter_write(fd.req(v_copy, fd.id('fb_b'), array[fd.id('g1')]));
  insert into fd.ids values ('post', (res->>'post_id')::uuid), ('run', (res->>'run_id')::uuid), ('task', (res->>'review_task_id')::uuid);
  perform fd.ok('D1 a Facebook draft is written and names its Page',
    fd.id('post') is not null and (res->>'social_account_id')::uuid = fd.id('fb_b'), res::text);
  perform fd.ok('D2 ...in review, not scheduled, not approved, no button, worker-authored, on the named Page',
    (select platform = 'facebook' and post_type = 'standard' and review_status = 'in_review'
            and publish_status = 'not_scheduled' and approved_hash is null and approved_snapshot is null and reviewed_by is null
            and scheduled_at is null and cta_type is null and cta_url is null and author_kind = 'worker'
            and social_account_id = fd.id('fb_b') and drafter_run_id = fd.id('run') and copy = v_copy
     from social_posts where id = fd.id('post')));
  perform fd.ok('D3 its one graphic and its claim are linked',
    (select array_agg(brand_asset_id) from post_assets where post_id = fd.id('post')) = array[fd.id('g1')]
    and (select array_agg(claim_id) from post_claims where post_id = fd.id('post')) = array['00000000-0000-4000-f000-00000000003b']::uuid[]);
  perform fd.ok('D4 a person decides: one open, unassigned CLAUDE_APPROVAL post_review task',
    (select key = 'post_review' and owner = 'CLAUDE_APPROVAL' and status = 'open' and assignee_id is null
     from tasks where id = fd.id('task')));

  r0 := (select count(*) from drafter_runs); n0 := (select count(*) from social_posts);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', null)));
  perform fd.ok('D5 a Facebook draft without a Page is refused', st like '23514:%Facebook Pages%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', fd.id('fb_a'))));
  perform fd.ok('D6 another client''s Page is refused', st like '23514:%Facebook Pages%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', fd.id('ig_b'))));
  perform fd.ok('D7 the client''s Instagram account is not a Facebook Page', st like '23514:%Facebook Pages%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', fd.id('fb_b'),
    p_cta => '{"type": "LEARN_MORE", "url": "https://b.example.test/panel-upgrades"}')));
  perform fd.ok('D8 a button is refused', st like '23514:%no button%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', fd.id('fb_b'), p_post_type => 'offer')));
  perform fd.ok('D9 an offer post is refused', st like '23514:%standard post%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', fd.id('fb_b'), array[fd.id('g2'), fd.id('g1')])));
  perform fd.ok('D10 two images are refused', st like '23514:%one image%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', fd.id('fb_b'), array[fd.id('unhashed')])));
  perform fd.ok('D11 an unhashed graphic is refused', st like '23514:%stored, hashed%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', fd.id('fb_b'), array[fd.id('logo')])));
  perform fd.ok('D12 a logo is not a post image', st like '23514:%stored, hashed%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', fd.id('fb_b'), array[fd.id('g_a')])));
  perform fd.ok('D13 another client''s graphic is refused', st like '23514:%stored, hashed%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', fd.id('fb_b'),
    p_opp => '00000000-0000-4000-9000-000000000001')));
  perform fd.ok('D14 an Authority hand-off cannot draft a Facebook post', st like '23514:%Business Profile posts only%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req(v_copy, fd.id('fb_b'), array[fd.id('g2')])));
  perform fd.ok('D15 the same copy cannot be queued twice', st like '23505:%this copy or this image%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A different panel post. Licensed electricians.', fd.id('fb_b'), array[fd.id('g1')])));
  perform fd.ok('D16 the same image cannot be queued twice', st like '23505:%this copy or this image%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', fd.id('fb_b'),
    p_claims => array['00000000-0000-4000-f000-00000000004b']::uuid[])));
  perform fd.ok('D17 0045 grounding still applies (an unverified claim)', st like '23514:%unverified%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('A second panel post. Licensed electricians.', fd.id('fb_b'), p_channel => 'instagram')));
  perform fd.ok('D18 Instagram is still not drafted', st like '23514:%Business Profile and Facebook%', st);
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('Panel upgrades. Licensed electricians.', fd.id('fb_b'),
    p_channel => 'google_business', p_intent => 'transactional',
    p_cta => '{"type": "LEARN_MORE", "url": "https://b.example.test/panel-upgrades"}')));
  perform fd.ok('D19 a Business Profile brief cannot name a Facebook account', st like '23514:%verified Business Profile%', st);
  perform fd.ok('D20 every refusal rolled back completely',
    (select count(*) from drafter_runs) = r0 and (select count(*) from social_posts) = n0);

  -- A second concept: different copy, different image, same service and intent.
  res := drafter_write(fd.req('Planning a kitchen remodel? Your panel is worth checking first. Licensed electricians.', fd.id('fb_b'), array[fd.id('g2')]));
  insert into fd.ids values ('post2', (res->>'post_id')::uuid);
  perform fd.ok('D21 a second concept for the same service and intent is queued (Facebook is per concept)',
    (select review_status = 'in_review' and publish_status = 'not_scheduled' from social_posts where id = fd.id('post2')));

  -- Business Profile unchanged: a GBP draft without an account still works.
  res := drafter_write(fd.req('Panel upgrades for older homes. Licensed electricians.', null,
    p_channel => 'google_business', p_intent => 'transactional',
    p_cta => '{"type": "LEARN_MORE", "url": "https://b.example.test/panel-upgrades"}'));
  insert into fd.ids values ('gbp', (res->>'post_id')::uuid);
  perform fd.ok('D22 a Business Profile draft is written as before (no account, its button)',
    (select platform = 'google_business' and social_account_id is null and cta_type = 'LEARN_MORE'
            and review_status = 'in_review' from social_posts where id = fd.id('gbp')));
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('Another panel upgrades post. Licensed electricians.', null,
    p_channel => 'google_business', p_intent => 'transactional',
    p_cta => '{"type": "LEARN_MORE", "url": "https://b.example.test/panel-upgrades"}')));
  perform fd.ok('D23 ...and its one-open-per-service-and-intent rule still holds', st like '23505:%service and intent%', st);
end $$;
reset role;

-- ── E. Worker SQL against a Facebook draft ──────────────────────────────────
\c - postgres
do $$
declare st text;
begin
  st := fd.try(format($q$update social_posts set review_status = 'approved' where id = %L$q$, fd.id('post')));
  perform fd.ok('E1 the worker cannot approve a Facebook draft', st is not null, st);
  st := fd.try(format($q$update social_posts set social_account_id = %L where id = %L$q$, fd.id('fb_a'), fd.id('post')));
  perform fd.ok('E2 ...nor move it to another Page', st is not null, st);
  st := fd.try(format($q$update social_posts set publish_status = 'scheduled', scheduled_at = now() where id = %L$q$, fd.id('post')));
  perform fd.ok('E3 ...nor schedule it', st is not null, st);
  perform fd.ok('E4 it is still in review and not scheduled',
    (select review_status = 'in_review' and publish_status = 'not_scheduled' from social_posts where id = fd.id('post')));
end $$;

-- ── H. A person (the app) still decides ─────────────────────────────────────
\c - authenticator
set role authenticated;
select fd.as_user('authenticated', :'team');
do $$
declare st text;
begin
  st := fd.try(format('select drafter_write(%L::jsonb)', fd.req('Panel post. Licensed electricians.', fd.id('fb_b'))));
  perform fd.ok('H1 a person cannot call drafter_write', st like '42501:%', st);
  perform fd.ok('H2 the team sees the Facebook draft and its Page',
    (select social_account_id = fd.id('fb_b') from social_posts where id = fd.id('post')));
end $$;
reset role;

\c - postgres
\o
-- ── Report ──────────────────────────────────────────────────────────────────
\pset footer off
select status, count(*) from fd.results group by status order by status;
select n, status, name, detail from fd.results where status <> 'pass' order by n;
do $$
declare f int;
begin
  select count(*) into f from fd.results where status = 'fail';
  if f > 0 then raise exception '% Facebook drafter check(s) failed', f; end if;
end $$;
