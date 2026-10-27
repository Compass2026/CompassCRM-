-- 20261027160000: weekly Facebook / Business Profile drafting from standard
-- slots. Fictional clients only; everything is rolled back.
--   A  active, approved board, Facebook + GBP bound, a ready keyword
--   L  launching, approved board, Facebook bound            (readiness, not lifecycle)
--   D  launching, draft board, Facebook bound               (skipped: brand)
--   K  active, approved board, Facebook bound, no keyword intent (skipped: keyword)
--   M  active, two brand sites sharing one GBP location; M1 approved with its
--      own Page, M2 draft without one (BHG's shape)
begin;
create schema ws_test;
create function ws_test.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function ws_test.err(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
create function ws_test.id(k text) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-e5' || lpad(to_hex((hashtext(k)::bigint & 255)::int), 2, '0') || '-'
          || lpad(to_hex(hashtext(k || '.')::bigint & 4294967295), 12, '0'))::uuid $$;
create function ws_test.w() returns date language sql stable as $$ select date_trunc('week', now() at time zone 'America/Chicago')::date $$;
grant usage on schema ws_test to anon, authenticated, service_role;
grant execute on all functions in schema ws_test to anon, authenticated, service_role;

set local session_replication_role = replica;
insert into clients (id, name, status) values
  (ws_test.id('A'), 'WS Active', 'active'), (ws_test.id('L'), 'WS Launching', 'launching'),
  (ws_test.id('D'), 'WS Draft board', 'launching'), (ws_test.id('K'), 'WS No intent', 'active'),
  (ws_test.id('M'), 'WS Multi', 'active');
insert into brand_boards (client_id, status, approved_on) values
  (ws_test.id('A'), 'approved', now()), (ws_test.id('L'), 'approved', now()), (ws_test.id('D'), 'draft', null),
  (ws_test.id('K'), 'approved', now()), (ws_test.id('M'), 'draft', null);
insert into services (id, client_id, name, status, page_url) values
  (ws_test.id('sA'), ws_test.id('A'), 'Service A', 'approved', 'https://a.example.test/service'),
  (ws_test.id('sA2'), ws_test.id('A'), 'Service A2', 'approved', 'https://a.example.test/service-2'),
  (ws_test.id('sL'), ws_test.id('L'), 'Service L', 'approved', 'https://l.example.test/service'),
  (ws_test.id('sD'), ws_test.id('D'), 'Service D', 'approved', 'https://d.example.test/service'),
  (ws_test.id('sK'), ws_test.id('K'), 'Service K', 'approved', 'https://k.example.test/service'),
  (ws_test.id('sM1'), ws_test.id('M'), 'Service M1', 'approved', 'https://m1.example.test/service'),
  (ws_test.id('sM2'), ws_test.id('M'), 'Service M2', 'approved', 'https://m2.example.test/service');
insert into keywords (id, client_id, keyword, service_id, is_active, intent, target_url) values
  (ws_test.id('kA'), ws_test.id('A'), 'kw a', ws_test.id('sA'), true, 'commercial', 'https://a.example.test/service'),
  (ws_test.id('kL'), ws_test.id('L'), 'kw l', ws_test.id('sL'), true, 'informational', null),
  (ws_test.id('kD'), ws_test.id('D'), 'kw d', ws_test.id('sD'), true, 'commercial', null),
  (ws_test.id('kK'), ws_test.id('K'), 'kw k', ws_test.id('sK'), true, null, null),
  (ws_test.id('kM1'), ws_test.id('M'), 'kw m1', ws_test.id('sM1'), true, 'commercial', null),
  (ws_test.id('kM2'), ws_test.id('M'), 'kw m2', ws_test.id('sM2'), true, 'commercial', null);
insert into social_accounts (id, client_id, platform, display_name, external_account_id, publish_provider, publish_account_id,
                             publish_page_id, publish_verified_at, publish_enabled) values
  (ws_test.id('fbA'), ws_test.id('A'), 'facebook', 'A Page', '11111', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa01', '11111', now(), false),
  (ws_test.id('gbA'), ws_test.id('A'), 'google_business', 'A GBP', 'locations/1', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa02', 'locations/1', now(), false),
  (ws_test.id('fbL'), ws_test.id('L'), 'facebook', 'L Page', '22222', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa03', '22222', now(), false),
  (ws_test.id('fbD'), ws_test.id('D'), 'facebook', 'D Page', '33333', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa04', '33333', now(), false),
  (ws_test.id('fbK'), ws_test.id('K'), 'facebook', 'K Page', '44444', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa05', '44444', now(), false),
  (ws_test.id('fbM1'), ws_test.id('M'), 'facebook', 'M1 Page', '55555', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa06', '55555', now(), false),
  (ws_test.id('gbM'), ws_test.id('M'), 'google_business', 'M GBP', 'locations/2', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa07', 'locations/2', now(), false),
  -- an unbound Instagram row: never a destination
  (ws_test.id('fbX'), ws_test.id('K'), 'instagram', 'K IG', '999', null, null, null, null, false);
insert into publisher_client_transports (client_id, gbp_transport, changed_by_kind) values
  (ws_test.id('A'), 'zernio', 'publisher'), (ws_test.id('M'), 'zernio', 'publisher');
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, facebook_account_id, status, approved_by, approved_at) values
  (ws_test.id('M1'), ws_test.id('M'), 'm1', 'M One', 'https://m1.example.test', '5555555555', array[ws_test.id('sM1')], ws_test.id('fbM1'),
   'approved', (select id from team_members limit 1), now()),
  (ws_test.id('M2'), ws_test.id('M'), 'm2', 'M Two', 'https://m2.example.test', '5555555555', array[ws_test.id('sM2')], null, 'draft', null, null);
set local session_replication_role = origin;

insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
select c, s.id, (date_trunc('month', now() at time zone 'America/Chicago') - interval '1 month')::date, 'test'
from delivery_standards s, unnest(array[ws_test.id('A'), ws_test.id('L'), ws_test.id('D'), ws_test.id('K'), ws_test.id('M')]) c
where s.version = 1;

-- Hand-made slots (standard_key set, no seq), so the monthly planner's own
-- slots never mix in: this week (Wednesday), last week, and a blocked one.
create function ws_test.slot(k text, c text, std text, d date, ws text default null, hold text default null) returns uuid
language sql as $$
  insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, planned_date, standard_key,
                                  brand_workspace_id, hold, hold_reason)
  values (ws_test.id(k), ws_test.id(c), d - (extract(isodow from d)::int - 1),
          case std when 'facebook_posts' then 'social' else 'gbp' end,
          case std when 'facebook_posts' then 'facebook' else 'google_business' end::social_platform,
          'service', 'slot ' || k, d, std, case when ws is not null then ws_test.id(ws) end, hold,
          case when hold = 'blocked' then 'held by a teammate' end)
  returning id $$;
select ws_test.slot('A.fb', 'A', 'facebook_posts', ws_test.w() + 2), ws_test.slot('A.gb', 'A', 'gbp_posts', ws_test.w() + 2),
       ws_test.slot('A.old', 'A', 'facebook_posts', ws_test.w() - 5), ws_test.slot('A.held', 'A', 'gbp_posts', ws_test.w() + 3, null, 'blocked'),
       ws_test.slot('L.fb', 'L', 'facebook_posts', ws_test.w() + 2), ws_test.slot('L.gb', 'L', 'gbp_posts', ws_test.w() + 2),
       ws_test.slot('D.fb', 'D', 'facebook_posts', ws_test.w() + 2), ws_test.slot('K.fb', 'K', 'facebook_posts', ws_test.w() + 2),
       ws_test.slot('M1.fb', 'M', 'facebook_posts', ws_test.w() + 2, 'M1'), ws_test.slot('M1.gb', 'M', 'gbp_posts', ws_test.w() + 2, 'M1'),
       ws_test.slot('M2.fb', 'M', 'facebook_posts', ws_test.w() + 2, 'M2'), ws_test.slot('M2.gb', 'M', 'gbp_posts', ws_test.w() + 2, 'M2');

-- ── Readiness ───────────────────────────────────────────────────────────────
create function ws_test.reason(c text, k text) returns text language sql as $$
  select coalesce(reason, 'READY') from social_slot_readiness(ws_test.id(c), ws_test.w() - 7, ws_test.w() + 6) where plan_item_id = ws_test.id(k) $$;
do $$ begin
  perform ws_test.ok('R1 an active client''s bound Facebook and GBP slots are ready, at the bound destination',
    ws_test.reason('A', 'A.fb') = 'READY' and ws_test.reason('A', 'A.gb') = 'READY'
    and (select social_account_id from social_slot_readiness(ws_test.id('A'), ws_test.w(), ws_test.w() + 6) where plan_item_id = ws_test.id('A.fb')) = ws_test.id('fbA')
    and (select social_account_id from social_slot_readiness(ws_test.id('A'), ws_test.w(), ws_test.w() + 6) where plan_item_id = ws_test.id('A.gb')) = ws_test.id('gbA'));
  perform ws_test.ok('R2 a teammate''s hold is shown with its reason and never worked around',
    ws_test.reason('A', 'A.held') = 'Blocked: held by a teammate');
  perform ws_test.ok('R3 a launching client with an approved brand is ready (readiness, not lifecycle)',
    ws_test.reason('L', 'L.fb') = 'READY');
  perform ws_test.ok('R4 no GBP binding (or no zernio transport) → named reason, never another location',
    ws_test.reason('L', 'L.gb') = 'No verified Business Profile location is bound for this client.');
  perform ws_test.ok('R5 a draft brand board blocks drafting',
    ws_test.reason('D', 'D.fb') = 'The brand board is not approved.');
  perform ws_test.ok('R6 no keyword with an intent, approved service and owner page → named reason',
    ws_test.reason('K', 'K.fb') = 'No active keyword with an intent, an approved service and an owner page.');
  perform ws_test.ok('R7 multi-brand: an approved site with its own Page is ready; the shared location serves it',
    ws_test.reason('M', 'M1.fb') = 'READY' and ws_test.reason('M', 'M1.gb') = 'READY'
    and (select social_account_id from social_slot_readiness(ws_test.id('M'), ws_test.w(), ws_test.w() + 6) where plan_item_id = ws_test.id('M1.fb')) = ws_test.id('fbM1'));
  perform ws_test.ok('R8 a draft brand site is refused before its destination; no other brand''s Page is borrowed',
    ws_test.reason('M', 'M2.fb') = 'The brand site''s guidance is not approved.' and ws_test.reason('M', 'M2.gb') = 'The brand site''s guidance is not approved.');
  perform set_config('session_replication_role', 'replica', true);
  update client_brand_workspaces set status = 'approved', approved_by = (select id from team_members limit 1), approved_at = now() where id = ws_test.id('M2');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('R9 once approved, a site without its own Page is still refused for Facebook (never the sister brand''s Page)',
    ws_test.reason('M', 'M2.fb') = 'No verified Facebook Page is bound for this site.' and ws_test.reason('M', 'M2.gb') = 'READY');
  perform ws_test.ok('R10 two brand slots on one shared location and day are counted for the worker',
    (select shared_same_day from social_slot_readiness(ws_test.id('M'), ws_test.w(), ws_test.w() + 6) where plan_item_id = ws_test.id('M1.gb')) = 1);
  perform ws_test.ok('R11 readiness is readable by the team, not by anon',
    has_function_privilege('authenticated', 'social_slot_readiness(uuid, date, date)', 'execute')
    and not has_function_privilege('anon', 'social_slot_readiness(uuid, date, date)', 'execute'));
end $$;

-- ── Queue ───────────────────────────────────────────────────────────────────
do $$
declare a int; again int;
begin
  a := queue_standard_social_tasks(ws_test.id('A'), ws_test.w() + 6);
  perform ws_test.ok('Q1 one task per ready slot this week, keyed to the slot, naming slot, channel and destination',
    a = 2 and (select count(*) from tasks where client_id = ws_test.id('A') and key like 'social\_slot:%') = 2
    and exists (select 1 from tasks where key = 'social_slot:' || ws_test.id('A.fb') and owner = 'CLAUDE' and status = 'open'
                and due_date = ws_test.w() + 2 and notes like 'plan_item:' || ws_test.id('A.fb') || ' channel:facebook account:' || ws_test.id('fbA') || '%'));
  perform ws_test.ok('Q2 forward only: last week''s slot is not queued and not even considered',
    not exists (select 1 from tasks where key = 'social_slot:' || ws_test.id('A.old'))
    and not exists (select 1 from delivery_queue_log where plan_item_id = ws_test.id('A.old')));
  perform ws_test.ok('Q3 every decision in the window is logged with its reason',
    exists (select 1 from delivery_queue_log where plan_item_id = ws_test.id('A.held') and decision = 'skipped' and reason like 'Blocked:%')
    and (select count(*) from delivery_queue_log where client_id = ws_test.id('A') and decision = 'queued') = 2);
  again := queue_standard_social_tasks(ws_test.id('A'), ws_test.w() + 6);
  perform ws_test.ok('Q4 a rerun opens nothing and says why',
    again = 0 and (select count(*) from tasks where client_id = ws_test.id('A') and key like 'social\_slot:%') = 2
    and (select count(*) from delivery_queue_log where client_id = ws_test.id('A') and reason = 'Already queued.') = 2);
  perform ws_test.ok('Q5 a second task for the same slot is refused by the database (concurrent queues)',
    ws_test.err(format($q$insert into tasks (client_id, title, owner, status, key) values (%L, 'dup', 'CLAUDE', 'open', %L)$q$,
      ws_test.id('A'), 'social_slot:' || ws_test.id('A.fb'))) = '23505');
  perform ws_test.ok('Q6 the queue and the claim/link doors are not the team''s or anon''s',
    not has_function_privilege('authenticated', 'queue_standard_social_tasks(uuid, date)', 'execute')
    and not has_function_privilege('authenticated', 'social_slot_claim(uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'social_slot_link(uuid, uuid, text)', 'execute')
    and not has_function_privilege('anon', 'social_slot_link(uuid, uuid, text)', 'execute'));
end $$;

-- ── Claim ───────────────────────────────────────────────────────────────────
select set_config('ws_test.task', (select id::text from tasks where key = 'social_slot:' || ws_test.id('A.fb')), true);
select set_config('ws_test.gtask', (select id::text from tasks where key = 'social_slot:' || ws_test.id('A.gb')), true);
do $$
declare t uuid := current_setting('ws_test.task')::uuid; r jsonb;
begin
  r := social_slot_claim(t, 'worker-routine');
  perform ws_test.ok('C1 the first claimant holds the task for an hour', (r->>'claimed')::boolean
    and (select claimed_by = 'worker-routine' and status = 'in_progress' from tasks where id = t)
    and (r->>'plan_item_id')::uuid = ws_test.id('A.fb'));
  r := social_slot_claim(t, 'claude-operator');
  perform ws_test.ok('C2 a second session is refused while the claim is live', not (r->>'claimed')::boolean and r->>'reason' = 'claimed_by_other');
  perform ws_test.ok('C3 the claimant may refresh its own claim', (social_slot_claim(t, 'worker-routine')->>'claimed')::boolean);
end $$;

-- ── Link ────────────────────────────────────────────────────────────────────
-- Posts as post-drafter leaves them (in review, with a run), written after the task opened.
set local session_replication_role = replica;
insert into social_posts (id, client_id, platform, search_intent, service_id, keyword_id, review_status, publish_status, created_at,
                          drafter_run_id, social_account_id, author_kind, copy, cta_type, cta_url) values
  (ws_test.id('p.ok'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA'), ws_test.id('kA'), 'in_review', 'not_scheduled',
   now() + interval '1 second', gen_random_uuid(), ws_test.id('fbA'), 'worker', 'copy ok', null, null),
  (ws_test.id('p.gb'), ws_test.id('A'), 'google_business', 'commercial', ws_test.id('sA'), ws_test.id('kA'), 'in_review', 'not_scheduled',
   now() + interval '1 second', gen_random_uuid(), ws_test.id('gbA'), 'worker', 'copy gbp', 'LEARN_MORE', 'https://a.example.test/service'),
  (ws_test.id('p.hand'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA'), ws_test.id('kA'), 'in_review', 'not_scheduled',
   now() + interval '1 second', null, ws_test.id('fbA'), 'worker', 'hand typed', null, null),
  (ws_test.id('p.old'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA'), ws_test.id('kA'), 'in_review', 'not_scheduled',
   now() - interval '1 day', gen_random_uuid(), ws_test.id('fbA'), 'worker', 'old draft', null, null),
  (ws_test.id('p.other'), ws_test.id('K'), 'facebook', 'commercial', ws_test.id('sK'), ws_test.id('kK'), 'in_review', 'not_scheduled',
   now() + interval '1 second', gen_random_uuid(), ws_test.id('fbK'), 'worker', 'other client', null, null);
set local session_replication_role = origin;
do $$
declare t uuid := current_setting('ws_test.task')::uuid; g uuid := current_setting('ws_test.gtask')::uuid; r jsonb;
begin
  perform ws_test.ok('L1 a session without the live claim cannot link',
    ws_test.err(format($q$select social_slot_link(%L, %L, 'claude-operator')$q$, t, ws_test.id('p.ok'))) = 'CD409');
  perform ws_test.ok('L2 a post on the wrong channel is refused',
    ws_test.err(format($q$select social_slot_link(%L, %L, 'worker-routine')$q$, t, ws_test.id('p.gb'))) = '22023');
  perform ws_test.ok('L3 a post not written by post-drafter, or written before the task, is refused',
    ws_test.err(format($q$select social_slot_link(%L, %L, 'worker-routine')$q$, t, ws_test.id('p.hand'))) = '22023'
    and ws_test.err(format($q$select social_slot_link(%L, %L, 'worker-routine')$q$, t, ws_test.id('p.old'))) = '22023');
  perform ws_test.ok('L4 another client''s post is refused',
    ws_test.err(format($q$select social_slot_link(%L, %L, 'worker-routine')$q$, t, ws_test.id('p.other'))) = 'P0002');
  perform set_config('session_replication_role', 'replica', true);
  update social_posts set social_account_id = null where id = ws_test.id('p.ok');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('L5 a post without the slot''s verified destination is refused',
    ws_test.err(format($q$select social_slot_link(%L, %L, 'worker-routine')$q$, t, ws_test.id('p.ok'))) = '22023');
  perform set_config('session_replication_role', 'replica', true);
  update social_posts set social_account_id = ws_test.id('fbA') where id = ws_test.id('p.ok');
  perform set_config('session_replication_role', 'origin', true);
  r := social_slot_link(t, ws_test.id('p.ok'), 'worker-routine');
  perform ws_test.ok('L6 the governed draft fills the slot: post, keyword, service, intent and owner page; the task is done',
    (r->>'linked')::boolean
    and (select social_post_id = ws_test.id('p.ok') and keyword_id = ws_test.id('kA') and service_id = ws_test.id('sA')
               and search_intent = 'commercial' and target_url = 'https://a.example.test/service' and hold is null
         from content_plan_items where id = ws_test.id('A.fb'))
    and (select status = 'done' from tasks where id = t));
  perform ws_test.ok('L7 nothing is approved, scheduled or enabled by linking',
    (select review_status = 'in_review' and publish_status = 'not_scheduled' from social_posts where id = ws_test.id('p.ok'))
    and not (select publish_enabled from social_accounts where id = ws_test.id('fbA')));
  perform ws_test.ok('L8 a done task cannot link again',
    ws_test.err(format($q$select social_slot_link(%L, %L, 'worker-routine')$q$, t, ws_test.id('p.ok'))) = '22023');
  perform social_slot_claim(g, 'worker-routine');
  perform ws_test.ok('L9 one post fills one slot',
    ws_test.err(format($q$select social_slot_link(%L, %L, 'worker-routine')$q$, g, ws_test.id('p.ok'))) in ('22023', '23505'));
  r := social_slot_link(g, ws_test.id('p.gb'), 'worker-routine');
  perform ws_test.ok('L10 the GBP slot takes its post and the button''s owner page',
    (select social_post_id = ws_test.id('p.gb') and target_url = 'https://a.example.test/service' from content_plan_items where id = ws_test.id('A.gb')));
  perform ws_test.ok('L11 a linked slot is no longer ready and is not queued again',
    ws_test.reason('A', 'A.fb') = 'Already linked to a post.' and queue_standard_social_tasks(ws_test.id('A'), ws_test.w() + 6) = 0);
end $$;

-- ── The weekly beat ─────────────────────────────────────────────────────────
-- Blog slots this week for L (launching, approved) and D (launching, draft),
-- and one of L's from last week (the backlog a newly eligible client must not get).
insert into content_plan_items (client_id, week_start, deliverable, purpose, topic, planned_date, standard_key)
select c, ws_test.w(), 'blog', 'educational', 'this week''s blog', ws_test.w() + 2, 'blog_posts'
from unnest(array[ws_test.id('L'), ws_test.id('D')]) c;
insert into content_plan_items (id, client_id, week_start, deliverable, purpose, topic, planned_date, standard_key)
values (ws_test.id('L.oldblog'), ws_test.id('L'), ws_test.w() - 7, 'blog', 'educational', 'last week''s blog', ws_test.w() - 5, 'blog_posts');
select create_weekly_blog_tasks();
do $$
declare before int;
begin
  perform ws_test.ok('W1 a launching client with an approved brand gets its blog and social tasks',
    exists (select 1 from tasks where client_id = ws_test.id('L') and key = 'blog_post')
    and exists (select 1 from tasks where key = 'social_slot:' || ws_test.id('L.fb')));
  perform ws_test.ok('W2 a launching client with a draft board gets neither, and the skip is logged with its reason',
    not exists (select 1 from tasks where client_id = ws_test.id('D') and (key = 'blog_post' or key like 'social\_slot:%'))
    and exists (select 1 from delivery_queue_log where client_id = ws_test.id('D') and deliverable = 'blog_posts'
                and reason = 'Launching client without an approved brand board or brand site.')
    and exists (select 1 from delivery_queue_log where client_id = ws_test.id('D') and plan_item_id = ws_test.id('D.fb')
                and reason = 'The brand board is not approved.'));
  perform ws_test.ok('W3 multi-brand: each ready site''s slots are queued once, the unready Page is not',
    (select count(*) from tasks where key in ('social_slot:' || ws_test.id('M1.fb'), 'social_slot:' || ws_test.id('M1.gb'),
                                             'social_slot:' || ws_test.id('M2.gb'))) = 3
    and not exists (select 1 from tasks where key = 'social_slot:' || ws_test.id('M2.fb')));
  perform ws_test.ok('W4 the second brand on a shared location is told to choose a different service and topic',
    exists (select 1 from tasks where key in ('social_slot:' || ws_test.id('M1.gb'), 'social_slot:' || ws_test.id('M2.gb'))
            and notes like '%other open slot(s) on the same day%'));
  perform ws_test.ok('W4b a newly eligible launching client is queued from this week on: no backlog task for last week''s blog',
    not exists (select 1 from tasks where client_id = ws_test.id('L') and key = 'blog_post' and notes like '%plan_item:' || ws_test.id('L.oldblog') || '%')
    and not has_function_privilege('authenticated', 'queue_standard_blog_tasks_from(uuid, date, date)', 'execute'));
  perform ws_test.ok('W5 lifecycle is untouched: nobody became active',
    (select status::text from clients where id = ws_test.id('L')) = 'launching'
    and (select status::text from clients where id = ws_test.id('D')) = 'launching');
  select count(*) into before from tasks where key like 'social\_slot:%' or key = 'blog_post';
  perform create_weekly_blog_tasks();
  perform ws_test.ok('W6 a rerun of the weekly beat opens nothing',
    (select count(*) from tasks where key like 'social\_slot:%' or key = 'blog_post') = before);
end $$;

-- ── Access ──────────────────────────────────────────────────────────────────
set local role anon;
do $$ begin
  perform ws_test.ok('X1 anon reads nothing of the log', ws_test.err('select count(*) from delivery_queue_log') = '42501');
end $$;
reset role;
set local role authenticated;
do $$ begin
  perform ws_test.ok('X2 a signed-in teammate cannot write the log', ws_test.err(format(
    $q$insert into delivery_queue_log (client_id, deliverable, decision, reason) values (%L, 'blog_posts', 'queued', 'x')$q$, ws_test.id('A'))) = '42501');
end $$;
reset role;
rollback;
