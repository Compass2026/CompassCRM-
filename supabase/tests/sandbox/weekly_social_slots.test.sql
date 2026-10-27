-- 20261027191343: weekly Facebook / Business Profile drafting from standard
-- slots, grounded in each client's approved core keyword list. Fictional
-- clients only; everything is rolled back.
--   A  active, approved board, Facebook + GBP bound, core list [kA, kA3]; kA2
--      is a valid keyword outside the core list
--   L  launching, approved board, Facebook bound            (readiness, not lifecycle)
--   D  launching, draft board, Facebook bound               (skipped: brand)
--   K  active, approved board, Facebook bound, core keyword without intent
--   M  active, two brand sites sharing one GBP location; M1 approved with its
--      own Page, M2 draft without one (BHG's shape)
--   P  active, everything ready except: the core list is only proposed
--   O  active, the only usable keyword is outside the core list until it
--      names its core parent
-- Worker runs follow the skill's contract: claimant 'worker-routine:<run id>',
-- one id per run, reused on that run's retries.
begin;
-- The strict core-keyword rule (20261027191343): no sandbox exemption for this
-- suite's clients, and the admin-only guard on exemptions is on.
do $$ begin
  if exists (select 1 from pg_trigger where tgname = 'sandbox_core_exempt_new_client') then
    execute 'alter table clients disable trigger sandbox_core_exempt_new_client';
  end if;
  execute 'alter table core_keyword_exemptions enable trigger core_keyword_exemptions_guard';
end $$;
create schema ws_test;
create function ws_test.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function ws_test.err(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate; end $$;
create function ws_test.msg(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function ws_test.id(k text) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-e5' || lpad(to_hex((hashtext(k)::bigint & 255)::int), 2, '0') || '-'
          || lpad(to_hex(hashtext(k || '.')::bigint & 4294967295), 12, '0'))::uuid $$;
create function ws_test.w() returns date language sql stable as $$ select date_trunc('week', now() at time zone 'America/Chicago')::date $$;
grant usage on schema ws_test to anon, authenticated, service_role;
grant execute on all functions in schema ws_test to anon, authenticated, service_role;
-- Two worker runs and an operator, as the skill names them.
select set_config('ws_test.ra', 'worker-routine:runA0001aa', true), set_config('ws_test.rb', 'worker-routine:runB0002bb', true);

set local session_replication_role = replica;
insert into clients (id, name, status, website_url) values
  (ws_test.id('A'), 'WS Active', 'active', 'https://www.a.example.test'), (ws_test.id('L'), 'WS Launching', 'launching', 'https://l.example.test'),
  (ws_test.id('D'), 'WS Draft board', 'launching', 'https://d.example.test'), (ws_test.id('K'), 'WS No intent', 'active', 'https://k.example.test'),
  (ws_test.id('M'), 'WS Multi', 'active', 'https://parent.example.test'), (ws_test.id('P'), 'WS Proposed list', 'active', 'https://p.example.test'),
  (ws_test.id('O'), 'WS Out of core', 'active', 'https://o.example.test');
insert into brand_boards (client_id, status, approved_on) values
  (ws_test.id('A'), 'approved', now()), (ws_test.id('L'), 'approved', now()), (ws_test.id('D'), 'draft', null),
  (ws_test.id('K'), 'approved', now()), (ws_test.id('M'), 'draft', null), (ws_test.id('P'), 'approved', now()),
  (ws_test.id('O'), 'approved', now());
insert into services (id, client_id, name, status, page_url) values
  (ws_test.id('sA'), ws_test.id('A'), 'Service A', 'approved', 'https://a.example.test/service'),
  (ws_test.id('sA2'), ws_test.id('A'), 'Service A2', 'approved', 'https://a.example.test/service-2'),
  (ws_test.id('sA3'), ws_test.id('A'), 'Service A3', 'approved', 'https://a.example.test/service-3'),
  (ws_test.id('sL2'), ws_test.id('L'), 'Service L off-site', 'approved', 'https://booking.example.test/l'),
  (ws_test.id('sL'), ws_test.id('L'), 'Service L', 'approved', 'https://l.example.test/service'),
  (ws_test.id('sD'), ws_test.id('D'), 'Service D', 'approved', 'https://d.example.test/service'),
  (ws_test.id('sK'), ws_test.id('K'), 'Service K', 'approved', 'https://k.example.test/service'),
  (ws_test.id('sM1'), ws_test.id('M'), 'Service M1', 'approved', 'https://m1.example.test/service'),
  (ws_test.id('sM2'), ws_test.id('M'), 'Service M2', 'approved', 'https://m2.example.test/service'),
  (ws_test.id('sP'), ws_test.id('P'), 'Service P', 'approved', 'https://p.example.test/service'),
  (ws_test.id('sO1'), ws_test.id('O'), 'Service O pageless', 'approved', null),
  (ws_test.id('sO2'), ws_test.id('O'), 'Service O', 'approved', 'https://o.example.test/service');
insert into keywords (id, client_id, keyword, service_id, is_active, intent, target_url) values
  (ws_test.id('kA'), ws_test.id('A'), 'kw a', ws_test.id('sA'), true, 'commercial', 'https://a.example.test/service'),
  (ws_test.id('kA2'), ws_test.id('A'), 'kw a2 outside core', ws_test.id('sA2'), true, 'commercial', null),
  (ws_test.id('kA3'), ws_test.id('A'), 'kw a3 second core', ws_test.id('sA3'), true, 'informational', null),
  (ws_test.id('kL'), ws_test.id('L'), 'kw l', ws_test.id('sL'), true, 'informational', null),
  (ws_test.id('kL2'), ws_test.id('L'), 'kw l2', ws_test.id('sL2'), true, 'commercial', null),
  (ws_test.id('kD'), ws_test.id('D'), 'kw d', ws_test.id('sD'), true, 'commercial', null),
  (ws_test.id('kK'), ws_test.id('K'), 'kw k', ws_test.id('sK'), true, null, null),
  (ws_test.id('kM1'), ws_test.id('M'), 'kw m1', ws_test.id('sM1'), true, 'commercial', null),
  (ws_test.id('kM2'), ws_test.id('M'), 'kw m2', ws_test.id('sM2'), true, 'commercial', null),
  (ws_test.id('kP'), ws_test.id('P'), 'kw p', ws_test.id('sP'), true, 'commercial', null),
  (ws_test.id('kO1'), ws_test.id('O'), 'kw o core', ws_test.id('sO1'), true, 'commercial', null),
  (ws_test.id('kO2'), ws_test.id('O'), 'kw o long tail', ws_test.id('sO2'), true, 'informational', null);
-- 49 more valid A keywords, so a teammate can approve a complete 50 (V6).
insert into keywords (id, client_id, keyword, is_active, intent)
select ws_test.id('kA.f' || n), ws_test.id('A'), 'kw a filler ' || n, true, 'informational' from generate_series(1, 49) n;
insert into sites (id, client_id, url) values
  (ws_test.id('site.A'), ws_test.id('A'), 'https://a.example.test'),
  (ws_test.id('site.M1'), ws_test.id('M'), 'https://m1.example.test'),
  (ws_test.id('site.M2'), ws_test.id('M'), 'https://m2.example.test');
insert into page_groups (client_id, name, page_type, target_url, status, supporting_keyword_ids) values
  (ws_test.id('A'), 'A page', 'service', 'https://a.example.test/service/', 'approved', '{}'),
  (ws_test.id('A'), 'A2 page', 'service', 'https://a.example.test/service-2', 'approved', '{}'),
  (ws_test.id('A'), 'A3 page', 'service', 'https://a.example.test/service-3', 'approved', '{}'),
  (ws_test.id('L'), 'L page', 'service', 'https://l.example.test/service', 'approved', '{}'),
  (ws_test.id('L'), 'L off-site page', 'service', 'https://booking.example.test/l', 'approved', '{}'),
  (ws_test.id('D'), 'D page', 'service', 'https://d.example.test/service', 'approved', '{}'),
  (ws_test.id('K'), 'K page', 'service', 'https://k.example.test/service', 'approved', '{}'),
  (ws_test.id('M'), 'M1 page', 'service', 'https://m1.example.test/service', 'approved', '{}'),
  (ws_test.id('M'), 'M2 page', 'service', 'https://m2.example.test/service', 'approved', '{}'),
  (ws_test.id('P'), 'P page', 'service', 'https://p.example.test/service', 'approved', '{}'),
  (ws_test.id('O'), 'O page', 'service', 'https://o.example.test/service', 'approved', '{}');
insert into social_accounts (id, client_id, platform, display_name, external_account_id, publish_provider, publish_account_id,
                             publish_page_id, publish_verified_at, publish_enabled) values
  (ws_test.id('fbA'), ws_test.id('A'), 'facebook', 'A Page', '11111', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa01', '11111', now(), false),
  (ws_test.id('gbA'), ws_test.id('A'), 'google_business', 'A GBP', 'locations/1', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa02', 'locations/1', now(), false),
  (ws_test.id('fbL'), ws_test.id('L'), 'facebook', 'L Page', '22222', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa03', '22222', now(), false),
  (ws_test.id('fbD'), ws_test.id('D'), 'facebook', 'D Page', '33333', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa04', '33333', now(), false),
  (ws_test.id('fbK'), ws_test.id('K'), 'facebook', 'K Page', '44444', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa05', '44444', now(), false),
  (ws_test.id('fbM1'), ws_test.id('M'), 'facebook', 'M1 Page', '55555', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa06', '55555', now(), false),
  (ws_test.id('gbM'), ws_test.id('M'), 'google_business', 'M GBP', 'locations/2', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa07', 'locations/2', now(), false),
  (ws_test.id('fbP'), ws_test.id('P'), 'facebook', 'P Page', '66666', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa08', '66666', now(), false),
  (ws_test.id('fbO'), ws_test.id('O'), 'facebook', 'O Page', '77777', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa09', '77777', now(), false),
  -- an unbound Instagram row: never a destination
  (ws_test.id('fbX'), ws_test.id('K'), 'instagram', 'K IG', '999', null, null, null, null, false);
insert into publisher_client_transports (client_id, gbp_transport, changed_by_kind) values
  (ws_test.id('A'), 'zernio', 'publisher'), (ws_test.id('M'), 'zernio', 'publisher');
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, facebook_account_id, status, approved_by, approved_at, blog_site_id) values
  (ws_test.id('M1'), ws_test.id('M'), 'm1', 'M One', 'https://m1.example.test', '5555555555', array[ws_test.id('sM1')], ws_test.id('fbM1'),
   'approved', (select id from team_members limit 1), now(), ws_test.id('site.M1')),
  (ws_test.id('M2'), ws_test.id('M'), 'm2', 'M Two', 'https://m2.example.test', '5555555555', array[ws_test.id('sM2')], null, 'draft', null, null, ws_test.id('site.M2'));
-- Approved core lists as a teammate would leave them (the guard is tested below).
insert into core_keyword_lists (id, client_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
select ws_test.id('list.' || c), ws_test.id(c), 1, 'approved', ids, 'test fixture', (select id from team_members limit 1), now()
from (values ('A', array[ws_test.id('kA'), ws_test.id('kA3')]), ('L', array[ws_test.id('kL')]), ('D', array[ws_test.id('kD')]),
             ('K', array[ws_test.id('kK')]), ('O', array[ws_test.id('kO1')])) v(c, ids);
-- M is multi-brand: one list per site. M1's is approved; M2's starts approved
-- too (R8/R9 test brand approval) and is revoked later for per-site isolation.
insert into core_keyword_lists (id, client_id, brand_workspace_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
values (ws_test.id('list.M1'), ws_test.id('M'), ws_test.id('M1'), 1, 'approved', array[ws_test.id('kM1')], 'test fixture', (select id from team_members limit 1), now()),
       (ws_test.id('list.M2'), ws_test.id('M'), ws_test.id('M2'), 1, 'approved', array[ws_test.id('kM2')], 'test fixture', (select id from team_members limit 1), now());
insert into core_keyword_lists (id, client_id, version, status, keyword_ids, source_ref)
values (ws_test.id('list.P'), ws_test.id('P'), 1, 'proposed', array[ws_test.id('kP')], 'test fixture: keywords.is_tracked');
set local session_replication_role = origin;

insert into client_delivery_standards (client_id, standard_id, effective_month, source_ref)
select c, s.id, (date_trunc('month', now() at time zone 'America/Chicago') - interval '1 month')::date, 'test'
from delivery_standards s, unnest(array[ws_test.id('A'), ws_test.id('L'), ws_test.id('D'), ws_test.id('K'), ws_test.id('M'),
                                        ws_test.id('P'), ws_test.id('O')]) c
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
       ws_test.slot('M2.fb', 'M', 'facebook_posts', ws_test.w() + 2, 'M2'), ws_test.slot('M2.gb', 'M', 'gbp_posts', ws_test.w() + 2, 'M2'),
       ws_test.slot('P.fb', 'P', 'facebook_posts', ws_test.w() + 2), ws_test.slot('O.fb', 'O', 'facebook_posts', ws_test.w() + 2);

-- ── Core keyword lists ──────────────────────────────────────────────────────
do $$ begin
  perform ws_test.ok('K1 a list starts as a proposal of this client''s own active keywords',
    ws_test.err(format($q$insert into core_keyword_lists (client_id, keyword_ids, source_ref) values (%L, %L, 'x')$q$,
      ws_test.id('A'), array[ws_test.id('kL')])) = '23514'
    and ws_test.err(format($q$insert into core_keyword_lists (client_id, status, keyword_ids, source_ref) values (%L, 'approved', %L, 'x')$q$,
      ws_test.id('A'), array[ws_test.id('kA')])) = '23514'
    and ws_test.err(format($q$insert into core_keyword_lists (client_id, keyword_ids, source_ref) values (%L, %L, 'x')$q$,
      ws_test.id('A'), array_fill(ws_test.id('kA'), array[51]))) in ('23514', '23514'));
  perform ws_test.ok('K2 only a signed-in teammate approves; nobody edits or deletes a list',
    ws_test.err(format($q$update core_keyword_lists set status = 'approved' where id = %L$q$, ws_test.id('list.P'))) = '42501'
    and ws_test.err(format($q$update core_keyword_lists set keyword_ids = %L where id = %L$q$, array[ws_test.id('kA2')], ws_test.id('list.A'))) = '42501'
    and ws_test.err(format($q$delete from core_keyword_lists where id = %L$q$, ws_test.id('list.A'))) = '42501');
  perform ws_test.ok('K3 grounding: a member, and a long-tail keyword only through its named core parent',
    (select core_keyword_id from core_keyword_grounding(ws_test.id('A'), ws_test.id('kA'))) = ws_test.id('kA')
    and not exists (select 1 from core_keyword_grounding(ws_test.id('A'), ws_test.id('kA2')))
    and not exists (select 1 from core_keyword_grounding(ws_test.id('P'), ws_test.id('kP'))));
end $$;

-- ── Readiness ───────────────────────────────────────────────────────────────
create function ws_test.reason(c text, k text) returns text language sql as $$
  select coalesce(reason, 'READY') from social_slot_readiness(ws_test.id(c), ws_test.w() - 7, ws_test.w() + 6) where plan_item_id = ws_test.id(k) $$;
do $$ begin
  perform ws_test.ok('R1 an active client''s bound Facebook and GBP slots are ready, at the bound destination, with the core list version',
    ws_test.reason('A', 'A.fb') = 'READY' and ws_test.reason('A', 'A.gb') = 'READY'
    and (select social_account_id = ws_test.id('fbA') and core_list_id = ws_test.id('list.A') and core_list_version = 1
         from social_slot_readiness(ws_test.id('A'), ws_test.w(), ws_test.w() + 6) where plan_item_id = ws_test.id('A.fb'))
    and (select social_account_id from social_slot_readiness(ws_test.id('A'), ws_test.w(), ws_test.w() + 6) where plan_item_id = ws_test.id('A.gb')) = ws_test.id('gbA'));
  perform ws_test.ok('R2 a teammate''s hold is shown with its reason and never worked around',
    ws_test.reason('A', 'A.held') = 'Blocked: held by a teammate');
  perform ws_test.ok('R3 a launching client with an approved brand is ready (readiness, not lifecycle)',
    ws_test.reason('L', 'L.fb') = 'READY');
  perform ws_test.ok('R4 no GBP binding (or no zernio transport) → named reason, never another location',
    ws_test.reason('L', 'L.gb') = 'No verified Business Profile location is bound for this client.');
  perform ws_test.ok('R5 a draft brand board blocks drafting',
    ws_test.reason('D', 'D.fb') = 'The brand board is not approved.');
  perform ws_test.ok('R6 a core keyword without an intent is not usable → named reason with the list version',
    ws_test.reason('K', 'K.fb') = 'No core keyword (v1) with an intent and an approved service whose owner page is on the site with an approved page group.');
  perform set_config('session_replication_role', 'replica', true);
  update page_groups set status = 'proposed' where client_id = ws_test.id('A');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('R6b the drafter''s own page gate: no approved page group for the owner page → not ready (www and trailing slash ignored when approved)',
    ws_test.reason('A', 'A.fb') like 'No core keyword%');
  perform set_config('session_replication_role', 'replica', true);
  update page_groups set status = 'approved' where client_id = ws_test.id('A');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('R6c an owner page off the client''s site (a booking platform) does not count; an on-site one does',
    ws_test.reason('A', 'A.fb') = 'READY' and ws_test.reason('L', 'L.fb') = 'READY');
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
  perform ws_test.ok('R11 readiness and grounding are readable by the team, not by anon',
    has_function_privilege('authenticated', 'social_slot_readiness(uuid, date, date)', 'execute')
    and not has_function_privilege('anon', 'social_slot_readiness(uuid, date, date)', 'execute')
    and not has_function_privilege('anon', 'core_keyword_grounding(uuid, uuid)', 'execute'));
  perform ws_test.ok('R12 a proposed (unapproved) core list blocks drafting, with its version',
    ws_test.reason('P', 'P.fb') = 'No approved core keyword list (v1 proposed, awaiting approval).');
  perform ws_test.ok('R13 a valid, active keyword outside the core list cannot make a slot ready',
    ws_test.reason('O', 'O.fb') like 'No core keyword (v1)%');
  update keywords set core_parent_keyword_id = ws_test.id('kO1') where id = ws_test.id('kO2');
  perform ws_test.ok('R14 the same keyword is usable once it names its core parent (explicit long-tail linkage)',
    ws_test.reason('O', 'O.fb') = 'READY'
    and (select core_keyword_id from core_keyword_grounding(ws_test.id('O'), ws_test.id('kO2'))) = ws_test.id('kO1'));
  perform ws_test.ok('R15 a keyword cannot name another client''s keyword, or itself, as its core parent',
    ws_test.err(format('update keywords set core_parent_keyword_id = %L where id = %L', ws_test.id('kA'), ws_test.id('kO2'))) = '23503'
    and ws_test.err(format('update keywords set core_parent_keyword_id = %L where id = %L', ws_test.id('kO1'), ws_test.id('kO1'))) = '23514');
end $$;

-- ── Queue ───────────────────────────────────────────────────────────────────
do $$
declare a int; again int;
begin
  a := queue_standard_social_tasks(ws_test.id('A'), ws_test.w() + 6);
  perform ws_test.ok('Q1 one task per ready slot this week, naming slot, channel, destination and core list version',
    a = 2 and (select count(*) from tasks where client_id = ws_test.id('A') and key like 'social\_slot:%') = 2
    and exists (select 1 from tasks where key = 'social_slot:' || ws_test.id('A.fb') and owner = 'CLAUDE' and status = 'open'
                and due_date = ws_test.w() + 2
                and notes like 'plan_item:' || ws_test.id('A.fb') || ' channel:facebook account:' || ws_test.id('fbA')
                               || ' core_list:' || ws_test.id('list.A') || ' v1%'));
  perform ws_test.ok('Q2 forward only: last week''s slot is not queued and not even considered',
    not exists (select 1 from tasks where key = 'social_slot:' || ws_test.id('A.old'))
    and not exists (select 1 from delivery_queue_log where plan_item_id = ws_test.id('A.old')));
  perform ws_test.ok('Q3 every decision in the window is logged with its reason',
    exists (select 1 from delivery_queue_log where plan_item_id = ws_test.id('A.held') and decision = 'skipped' and reason like 'Blocked:%')
    and (select count(*) from delivery_queue_log where client_id = ws_test.id('A') and decision = 'queued' and reason = 'Ready (core list v1).') = 2);
  again := queue_standard_social_tasks(ws_test.id('A'), ws_test.w() + 6);
  perform ws_test.ok('Q4 a rerun opens nothing and says why',
    again = 0 and (select count(*) from tasks where client_id = ws_test.id('A') and key like 'social\_slot:%') = 2
    and (select count(*) from delivery_queue_log where client_id = ws_test.id('A') and reason = 'Already queued.') = 2);
  perform ws_test.ok('Q5 a second task for the same slot is refused by the database (concurrent queues)',
    ws_test.err(format($q$insert into tasks (client_id, title, owner, status, key) values (%L, 'dup', 'CLAUDE', 'open', %L)$q$,
      ws_test.id('A'), 'social_slot:' || ws_test.id('A.fb'))) = '23505');
  perform ws_test.ok('Q6 the queue, claim, link and record doors are not the team''s or anon''s',
    not has_function_privilege('authenticated', 'queue_standard_social_tasks(uuid, date)', 'execute')
    and not has_function_privilege('authenticated', 'social_slot_claim(uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'social_slot_link(uuid, uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'core_keyword_record(uuid, uuid, text, uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'social_slot_link(uuid, uuid, text)', 'execute'));
  perform ws_test.ok('Q7 readiness keeps queue occupancy apart from eligibility: a queued slot is still READY, with its task',
    (select ready and reason is null and task_id is not null
       from social_slot_readiness(ws_test.id('A'), ws_test.w(), ws_test.w() + 6) where plan_item_id = ws_test.id('A.fb')));
  again := queue_standard_social_tasks(ws_test.id('P'), ws_test.w() + 6);
  perform ws_test.ok('Q8 a client whose core list is only proposed queues nothing, with the reason logged',
    again = 0
    and exists (select 1 from delivery_queue_log where plan_item_id = ws_test.id('P.fb')
                and reason = 'No approved core keyword list (v1 proposed, awaiting approval).'));
end $$;

-- ── Claim: two worker runs, retries, expiry ─────────────────────────────────
select set_config('ws_test.task', (select id::text from tasks where key = 'social_slot:' || ws_test.id('A.fb')), true);
select set_config('ws_test.gtask', (select id::text from tasks where key = 'social_slot:' || ws_test.id('A.gb')), true);
do $$
declare t uuid := current_setting('ws_test.task')::uuid; ra text := current_setting('ws_test.ra'); rb text := current_setting('ws_test.rb'); r jsonb;
begin
  perform ws_test.ok('C0 a shared label is not a claimant: each run claims with its own token',
    ws_test.err(format($q$select social_slot_claim(%L, 'worker-routine')$q$, t)) = '22023'
    and ws_test.err(format($q$select social_slot_claim(%L, 'worker-routine:x')$q$, t)) = '22023');
  r := social_slot_claim(t, ra);
  perform ws_test.ok('C1 run A holds the task for an hour, with the destination and core list it must draft for', (r->>'claimed')::boolean
    and (select claimed_by = ra and status = 'in_progress' from tasks where id = t)
    and (r->>'plan_item_id')::uuid = ws_test.id('A.fb') and (r->>'social_account_id')::uuid = ws_test.id('fbA')
    and (r->>'core_list_version')::int = 1);
  r := social_slot_claim(t, rb);
  perform ws_test.ok('C2 run B, started at the same time with the same instructions, is refused: it drafts nothing',
    not (r->>'claimed')::boolean and r->>'reason' = 'claimed_by_other' and r->>'claimed_by' = ra);
  perform ws_test.ok('C3 run A''s retry with its own token refreshes the claim', (social_slot_claim(t, ra)->>'claimed')::boolean
    and (select claimed_by from tasks where id = t) = ra);
end $$;

-- ── Link ────────────────────────────────────────────────────────────────────
-- Posts as post-drafter leaves them (in review, with a run), written after the task opened.
set local session_replication_role = replica;
insert into social_posts (id, client_id, platform, search_intent, service_id, keyword_id, review_status, publish_status, created_at,
                          drafter_run_id, social_account_id, author_kind, copy, cta_type, cta_url) values
  (ws_test.id('p.ok'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA'), ws_test.id('kA'), 'in_review', 'not_scheduled',
   now() + interval '1 second', gen_random_uuid(), ws_test.id('fbA'), 'worker', 'copy ok', null, null),
  (ws_test.id('p.offcore'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA2'), ws_test.id('kA2'), 'in_review', 'not_scheduled',
   now() + interval '1 second', gen_random_uuid(), ws_test.id('fbA'), 'worker', 'copy off core', null, null),
  (ws_test.id('p.b'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA'), ws_test.id('kA'), 'in_review', 'not_scheduled',
   now() + interval '1 second', gen_random_uuid(), ws_test.id('fbA'), 'worker', 'run B copy', null, null),
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
declare t uuid := current_setting('ws_test.task')::uuid; g uuid := current_setting('ws_test.gtask')::uuid;
  ra text := current_setting('ws_test.ra'); rb text := current_setting('ws_test.rb'); r jsonb;
begin
  perform ws_test.ok('L1 run B (no live claim) cannot link its post, so a duplicate never fills the slot',
    ws_test.err(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.b'), rb)) = 'CD409');
  perform ws_test.ok('L2 a post on the wrong channel is refused',
    ws_test.err(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.gb'), ra)) = '22023');
  perform ws_test.ok('L3 a post not written by post-drafter, or written before the task, is refused',
    ws_test.err(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.hand'), ra)) = '22023'
    and ws_test.err(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.old'), ra)) = '22023');
  perform ws_test.ok('L4 another client''s post is refused',
    ws_test.err(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.other'), ra)) = 'P0002');
  perform ws_test.ok('L4b a governed post on a valid keyword outside the core list is refused at link (core_keyword_required)',
    ws_test.msg(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.offcore'), ra)) like '22023: core_keyword_required%'
    and not exists (select 1 from core_keyword_links where social_post_id = ws_test.id('p.offcore')));
  perform set_config('session_replication_role', 'replica', true);
  update social_posts set social_account_id = null where id = ws_test.id('p.ok');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('L5 a post without the slot''s verified destination is refused',
    ws_test.err(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.ok'), ra)) = '22023');
  perform set_config('session_replication_role', 'replica', true);
  update social_posts set social_account_id = ws_test.id('fbA') where id = ws_test.id('p.ok');
  perform set_config('session_replication_role', 'origin', true);
  r := social_slot_link(t, ws_test.id('p.ok'), ra);
  perform ws_test.ok('L6 the governed core draft fills the slot: post, keyword, service, intent and owner page; the task is done',
    (r->>'linked')::boolean and (r->>'list_version')::int = 1
    and (select social_post_id = ws_test.id('p.ok') and keyword_id = ws_test.id('kA') and service_id = ws_test.id('sA')
               and search_intent = 'commercial' and target_url = 'https://a.example.test/service' and hold is null
         from content_plan_items where id = ws_test.id('A.fb'))
    and (select status = 'done' from tasks where id = t));
  perform ws_test.ok('L6b the evidence names list, version, keyword and core keyword for the post',
    exists (select 1 from core_keyword_links where social_post_id = ws_test.id('p.ok') and list_id = ws_test.id('list.A')
            and list_version = 1 and keyword_id = ws_test.id('kA') and core_keyword_id = ws_test.id('kA')
            and plan_item_id = ws_test.id('A.fb')));
  perform ws_test.ok('L7 nothing is approved, scheduled or enabled by linking',
    (select review_status = 'in_review' and publish_status = 'not_scheduled' from social_posts where id = ws_test.id('p.ok'))
    and not (select publish_enabled from social_accounts where id = ws_test.id('fbA')));
  perform ws_test.ok('L8 a done task cannot link again',
    ws_test.err(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.ok'), ra)) = '22023');
  perform social_slot_claim(g, ra);
  perform ws_test.ok('L9 one post fills one slot',
    ws_test.err(format($q$select social_slot_link(%L, %L, %L)$q$, g, ws_test.id('p.ok'), ra)) in ('22023', '23505'));
  r := social_slot_link(g, ws_test.id('p.gb'), ra);
  perform ws_test.ok('L10 the GBP slot takes its post and the button''s owner page',
    (select social_post_id = ws_test.id('p.gb') and target_url = 'https://a.example.test/service' from content_plan_items where id = ws_test.id('A.gb')));
  perform ws_test.ok('L11 a linked slot is no longer ready and is not queued again',
    ws_test.reason('A', 'A.fb') = 'Already linked to a post.' and queue_standard_social_tasks(ws_test.id('A'), ws_test.w() + 6) = 0);
end $$;

-- ── The post's own keyword is judged at link, never vouched for by another ──
select ws_test.slot('A.fb3', 'A', 'facebook_posts', ws_test.w() + 5);
select queue_standard_social_tasks(ws_test.id('A'), ws_test.w() + 6);
select queue_standard_social_tasks(ws_test.id('O'), ws_test.w() + 6);
select set_config('ws_test.t3', (select id::text from tasks where key = 'social_slot:' || ws_test.id('A.fb3')), true);
select set_config('ws_test.to', (select id::text from tasks where key = 'social_slot:' || ws_test.id('O.fb')), true);
set local session_replication_role = replica;
insert into social_posts (id, client_id, platform, search_intent, service_id, keyword_id, review_status, publish_status, created_at,
                          drafter_run_id, social_account_id, author_kind, copy) values
  (ws_test.id('p.e1'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA'), ws_test.id('kA'), 'in_review', 'not_scheduled',
   now() + interval '1 second', gen_random_uuid(), ws_test.id('fbA'), 'worker', 'copy e1'),
  (ws_test.id('p.e5'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA3'), ws_test.id('kA'), 'in_review', 'not_scheduled',
   now() + interval '1 second', gen_random_uuid(), ws_test.id('fbA'), 'worker', 'copy e5 wrong service'),
  (ws_test.id('p.o2'), ws_test.id('O'), 'facebook', 'informational', ws_test.id('sO2'), ws_test.id('kO2'), 'in_review', 'not_scheduled',
   now() + interval '1 second', gen_random_uuid(), ws_test.id('fbO'), 'worker', 'copy long tail');
set local session_replication_role = origin;
do $$
declare t uuid := current_setting('ws_test.t3')::uuid; o uuid := current_setting('ws_test.to')::uuid; ra text := current_setting('ws_test.ra'); r jsonb;
begin
  perform ws_test.ok('E0 claimed: two core keywords (kA, kA3) are usable for the slot',
    (social_slot_claim(t, ra)->>'claimed')::boolean and (social_slot_claim(o, ra)->>'claimed')::boolean);
  perform ws_test.ok('E1 a post whose service is not its keyword''s service is refused',
    ws_test.msg(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.e5'), ra)) like '22023: keyword_not_eligible: the post''s service is not the keyword''s service%');
  perform set_config('session_replication_role', 'replica', true);
  update keywords set is_active = false where id = ws_test.id('kA');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('E2 the post''s keyword is deactivated while kA3 stays usable: the slot is ready, the stale post is refused, nothing recorded',
    ws_test.reason('A', 'A.fb3') = 'READY'
    and ws_test.msg(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.e1'), ra)) like '22023: keyword_not_eligible: the keyword is inactive%'
    and not exists (select 1 from core_keyword_links where social_post_id = ws_test.id('p.e1')));
  perform set_config('session_replication_role', 'replica', true);
  update keywords set is_active = true where id = ws_test.id('kA');
  update services set status = 'proposed' where id = ws_test.id('sA');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('E3 the post''s service loses its approval while kA3 stays usable: the post is refused',
    ws_test.reason('A', 'A.fb3') = 'READY'
    and ws_test.msg(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.e1'), ra)) like '22023: keyword_not_eligible: the keyword''s service is not approved%');
  perform set_config('session_replication_role', 'replica', true);
  update services set status = 'approved' where id = ws_test.id('sA');
  update keywords set is_active = false where id = ws_test.id('kO1');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('E4 a supporting term whose core parent is deactivated no longer traces to the list: refused, nothing recorded',
    not exists (select 1 from core_keyword_grounding(ws_test.id('O'), ws_test.id('kO2')))
    and ws_test.msg(format($q$select social_slot_link(%L, %L, %L)$q$, o, ws_test.id('p.o2'), ra)) like '22023: %'
    and not exists (select 1 from core_keyword_links where social_post_id = ws_test.id('p.o2')));
  perform set_config('session_replication_role', 'replica', true);
  update keywords set is_active = true where id = ws_test.id('kO1');
  perform set_config('session_replication_role', 'origin', true);
  r := social_slot_link(o, ws_test.id('p.o2'), ra);
  perform ws_test.ok('E5 parent restored: the supporting term links, evidence naming its core parent',
    (r->>'linked')::boolean
    and exists (select 1 from core_keyword_links where social_post_id = ws_test.id('p.o2') and keyword_id = ws_test.id('kO2')
                and core_keyword_id = ws_test.id('kO1')));
  r := social_slot_link(t, ws_test.id('p.e1'), ra);
  perform ws_test.ok('E6 unchanged selected keyword: the post links and the evidence names kA',
    (r->>'linked')::boolean
    and exists (select 1 from core_keyword_links where social_post_id = ws_test.id('p.e1') and core_keyword_id = ws_test.id('kA')));
end $$;

-- ── Queued, then revoked: eligibility is re-checked at claim and link ────────
select ws_test.slot('A.fb2', 'A', 'facebook_posts', ws_test.w() + 4);
select queue_standard_social_tasks(ws_test.id('A'), ws_test.w() + 6);
select set_config('ws_test.t2', (select id::text from tasks where key = 'social_slot:' || ws_test.id('A.fb2')), true);
set local session_replication_role = replica;
insert into social_posts (id, client_id, platform, search_intent, service_id, keyword_id, review_status, publish_status, created_at,
                          drafter_run_id, social_account_id, author_kind, copy) values
  (ws_test.id('p.ok2'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA'), ws_test.id('kA'), 'in_review', 'not_scheduled',
   now() + interval '1 second', gen_random_uuid(), ws_test.id('fbA'), 'worker', 'copy ok 2'),
  (ws_test.id('p.v2'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA2'), ws_test.id('kA2'), 'in_review', 'not_scheduled',
   now() + interval '1 second', gen_random_uuid(), ws_test.id('fbA'), 'worker', 'copy on v2 core');
set local session_replication_role = origin;
do $$
declare t uuid := current_setting('ws_test.t2')::uuid; ra text := current_setting('ws_test.ra'); rb text := current_setting('ws_test.rb'); r jsonb;
begin
  perform set_config('session_replication_role', 'replica', true);
  update brand_boards set status = 'draft' where client_id = ws_test.id('A');
  perform set_config('session_replication_role', 'origin', true);
  r := social_slot_claim(t, ra);
  perform ws_test.ok('V1 brand approval revoked after queueing: the queued slot shows it, and the claim is refused with the reason',
    ws_test.reason('A', 'A.fb2') = 'The brand board is not approved.'
    and not (r->>'claimed')::boolean and r->>'reason' = 'not_ready' and r->>'detail' = 'The brand board is not approved.'
    and (select claimed_by is null from tasks where id = t));
  perform set_config('session_replication_role', 'replica', true);
  update brand_boards set status = 'approved' where client_id = ws_test.id('A');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('V2 restored: run A claims', (social_slot_claim(t, ra)->>'claimed')::boolean);
  perform set_config('session_replication_role', 'replica', true);
  update core_keyword_lists set status = 'superseded' where id = ws_test.id('list.A');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('V3 core list revoked after the claim: the link is refused with the reason, nothing recorded',
    ws_test.msg(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.ok2'), ra)) like '22023: not_ready: No approved core keyword list%'
    and not exists (select 1 from core_keyword_links where social_post_id = ws_test.id('p.ok2')));
  perform set_config('session_replication_role', 'replica', true);
  update core_keyword_lists set status = 'approved' where id = ws_test.id('list.A');
  update keywords set intent = null where id = ws_test.id('kA');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('V4 the post''s own core keyword loses its intent while another core keyword stays usable: the slot is still ready, the post is refused',
    ws_test.reason('A', 'A.fb2') = 'READY'
    and ws_test.msg(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.ok2'), ra)) like '22023: keyword_not_eligible: the keyword has no recorded intent%'
    and not exists (select 1 from core_keyword_links where social_post_id = ws_test.id('p.ok2')));
  perform set_config('session_replication_role', 'replica', true);
  update keywords set intent = 'commercial' where id = ws_test.id('kA');
  update tasks set claimed_at = now() - interval '2 hours' where id = t;
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('V5 run A''s claim expired: run B takes over and run A''s late link is refused',
    (social_slot_claim(t, rb)->>'claimed')::boolean
    and ws_test.err(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.ok2'), ra)) = 'CD409');
end $$;

-- A teammate approves core list v2 (kA2 only): v1 is superseded, and the
-- queued task is revalidated against v2 at link time.
insert into core_keyword_lists (id, client_id, keyword_ids, source_ref)
values (ws_test.id('list.A2'), ws_test.id('A'), array[ws_test.id('kA2')] || (select array_agg(ws_test.id('kA.f' || n)) from generate_series(1, 49) n),
        'test: v2 replaces kA with kA2 and 49 more'),
       (ws_test.id('list.Ainc'), ws_test.id('A'), array[ws_test.id('kA2'), ws_test.id('kA3')], 'test: an incomplete proposal');
set local session authorization authenticator;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '00000000-0000-4000-a000-000000000001')::text, true);
select set_config('ws_test.incomplete', ws_test.msg(format($q$update core_keyword_lists set status = 'approved' where id = %L$q$, ws_test.id('list.Ainc'))), true);
update core_keyword_lists set status = 'approved' where id = ws_test.id('list.A2');
reset role;
reset session authorization;
do $$
declare t uuid := current_setting('ws_test.t2')::uuid; rb text := current_setting('ws_test.rb'); r jsonb;
begin
  perform ws_test.ok('V5b a teammate cannot approve an incomplete list: exactly 50 valid keywords, or it stays a proposal',
    current_setting('ws_test.incomplete') like '23514: core_list_incomplete%'
    and (select status from core_keyword_lists where id = ws_test.id('list.Ainc')) = 'proposed');
  perform ws_test.ok('V5c weekly rank tracking follows the approved site lists: exactly v2''s 50 are tracked',
    (select count(*) from keywords where client_id = ws_test.id('A') and is_tracked) = 50
    and (select is_tracked from keywords where id = ws_test.id('kA2'))
    and not (select is_tracked from keywords where id = ws_test.id('kA')));
  perform ws_test.ok('V6 a signed-in teammate approves v2: version 2, attributed, v1 superseded, one approved list',
    (select version = 2 and status = 'approved' and approved_by is not null from core_keyword_lists where id = ws_test.id('list.A2'))
    and (select status from core_keyword_lists where id = ws_test.id('list.A')) = 'superseded'
    and (select count(*) from core_keyword_lists where client_id = ws_test.id('A') and status = 'approved') = 1);
  perform ws_test.ok('V7 the task queued under v1 is revalidated against v2: the v1-only keyword is refused',
    ws_test.msg(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.ok2'), rb)) like '22023: core_keyword_required%');
  r := social_slot_link(t, ws_test.id('p.v2'), rb);
  perform ws_test.ok('V8 a v2 core keyword links, and the evidence records version 2',
    (r->>'list_version')::int = 2
    and exists (select 1 from core_keyword_links where social_post_id = ws_test.id('p.v2') and list_version = 2 and list_id = ws_test.id('list.A2'))
    and exists (select 1 from core_keyword_links where social_post_id = ws_test.id('p.ok') and list_version = 1));
end $$;

-- ── drafter_write: an unattended run writes only core keywords ──────────────
set local session authorization authenticator;
set local role service_role;
do $$
declare
  b jsonb := jsonb_build_object('client', jsonb_build_object('id', ws_test.id('O')),
    'target', jsonb_build_object('channel', 'google_business', 'keyword', jsonb_build_object('id', ws_test.id('kA2'))));
  req jsonb;
begin
  -- kA2 belongs to A; for O use O's keywords. O's core list is [kO1]; kO2 names kO1 as its parent.
  req := jsonb_build_object('client_id', ws_test.id('O'), 'copy', 'x', 'lint', jsonb_build_object('ok', true), 'claimant', current_setting('ws_test.ra'),
    'brief', jsonb_set(b, '{target,keyword,id}', to_jsonb(ws_test.id('kO2')::text)));
  perform ws_test.ok('D0 a long-tail keyword with its core parent passes the gate (any later refusal is the drafter''s own)',
    ws_test.msg(format('select drafter_write(%L::jsonb)', req)) not like '%core_keyword_required%');
  update keywords set core_parent_keyword_id = null where id = ws_test.id('kO2');
  perform ws_test.ok('D1 an unattended worker run is refused for a keyword outside the core list, before anything is written',
    ws_test.msg(format('select drafter_write(%L::jsonb)', req)) like '23514: core_keyword_required%'
    and not exists (select 1 from social_posts where client_id = ws_test.id('O') and copy = 'x'));
  perform ws_test.ok('D2 an operator draft on a site with an approved core list is held to it too',
    ws_test.msg(format('select drafter_write(%L::jsonb)', req || jsonb_build_object('claimant', 'claude-operator:op123456'))) like '23514: core_keyword_required%');
  perform ws_test.ok('D3 a site whose list is only proposed refuses every draft, operator included (P)',
    ws_test.msg(format('select drafter_write(%L::jsonb)', jsonb_build_object('client_id', ws_test.id('P'), 'copy', 'x', 'lint', jsonb_build_object('ok', true),
      'claimant', 'claude-operator:op123456', 'brief', jsonb_build_object('client', jsonb_build_object('id', ws_test.id('P')),
      'target', jsonb_build_object('channel', 'google_business', 'keyword', jsonb_build_object('id', ws_test.id('kP'))))))) like '23514: core_keyword_required%');
end $$;
reset role;
reset session authorization;

-- ── The weekly beat ─────────────────────────────────────────────────────────
-- Blog slots this week for L (launching, approved), D (launching, draft) and P
-- (core list only proposed), and one of L's from last week (the backlog a
-- newly eligible client must not get).
insert into content_plan_items (client_id, week_start, deliverable, purpose, topic, planned_date, standard_key)
select c, ws_test.w(), 'blog', 'educational', 'this week''s blog', ws_test.w() + 2, 'blog_posts'
from unnest(array[ws_test.id('L'), ws_test.id('D'), ws_test.id('P')]) c;
insert into content_plan_items (id, client_id, week_start, deliverable, purpose, topic, planned_date, standard_key)
values (ws_test.id('L.oldblog'), ws_test.id('L'), ws_test.w() - 7, 'blog', 'educational', 'last week''s blog', ws_test.w() - 5, 'blog_posts');
select create_weekly_blog_tasks();
do $$
declare before int;
begin
  perform ws_test.ok('W1 a launching client with an approved brand and core list gets its blog and social tasks',
    exists (select 1 from tasks where client_id = ws_test.id('L') and key = 'blog_post')
    and exists (select 1 from tasks where key = 'social_slot:' || ws_test.id('L.fb')));
  perform ws_test.ok('W2 a launching client with a draft board gets neither, and the skip is logged with its reason',
    not exists (select 1 from tasks where client_id = ws_test.id('D') and (key = 'blog_post' or key like 'social\_slot:%'))
    and exists (select 1 from delivery_queue_log where client_id = ws_test.id('D') and deliverable = 'blog_posts'
                and reason = 'Launching client without an approved brand board or brand site.')
    and exists (select 1 from delivery_queue_log where client_id = ws_test.id('D') and plan_item_id = ws_test.id('D.fb')
                and reason = 'The brand board is not approved.'));
  perform ws_test.ok('W2b an active client without an approved core list gets no blog task, with the reason logged',
    not exists (select 1 from tasks where client_id = ws_test.id('P') and key = 'blog_post')
    and exists (select 1 from delivery_queue_log where client_id = ws_test.id('P') and deliverable = 'blog_posts'
                and reason = 'No approved core keyword list.'));
  perform ws_test.ok('W3 multi-brand: each ready site''s slots are queued once, the unready Page is not',
    (select count(*) from tasks where key in ('social_slot:' || ws_test.id('M1.fb'), 'social_slot:' || ws_test.id('M1.gb'),
                                             'social_slot:' || ws_test.id('M2.gb'))) = 3
    and not exists (select 1 from tasks where key = 'social_slot:' || ws_test.id('M2.fb')));
  perform ws_test.ok('W4 the second brand on a shared location is told to choose a different service and topic',
    exists (select 1 from tasks where key in ('social_slot:' || ws_test.id('M1.gb'), 'social_slot:' || ws_test.id('M2.gb'))
            and notes like '%other open slot(s) on the same day%'));
  perform ws_test.ok('W4b a newly eligible launching client is queued from this week on: no backlog task for last week''s blog',
    not exists (select 1 from tasks where client_id = ws_test.id('L') and key = 'blog_post' and notes like '%plan_item:' || ws_test.id('L.oldblog') || '%')
    and not has_function_privilege('authenticated', 'queue_standard_blog_tasks_site(uuid, uuid, date, date)', 'execute'));
  perform ws_test.ok('W5 lifecycle is untouched: nobody became active',
    (select status::text from clients where id = ws_test.id('L')) = 'launching'
    and (select status::text from clients where id = ws_test.id('D')) = 'launching');
  select count(*) into before from tasks where key like 'social\_slot:%' or key = 'blog_post';
  perform create_weekly_blog_tasks();
  perform ws_test.ok('W6 a rerun of the weekly beat opens nothing',
    (select count(*) from tasks where key like 'social\_slot:%' or key = 'blog_post') = before);
end $$;

-- Per site: a multi-brand client's blog slots follow each site's own list.
set local session_replication_role = replica;
update core_keyword_lists set status = 'superseded' where id = ws_test.id('list.M2');
set local session_replication_role = origin;
insert into content_plan_items (id, client_id, week_start, deliverable, purpose, topic, planned_date, standard_key, brand_workspace_id)
values (ws_test.id('M1.blog'), ws_test.id('M'), ws_test.w(), 'blog', 'educational', 'M1 blog', ws_test.w() + 3, 'blog_posts', ws_test.id('M1')),
       (ws_test.id('M2.blog'), ws_test.id('M'), ws_test.w(), 'blog', 'educational', 'M2 blog', ws_test.w() + 3, 'blog_posts', ws_test.id('M2'));
select create_weekly_blog_tasks();
do $$ begin
  perform ws_test.ok('W7 each brand site''s blog queue stands alone: M1 (approved) is queued, M2 (revoked list) is not, and says why',
    exists (select 1 from tasks where client_id = ws_test.id('M') and key = 'blog_post' and notes like 'plan_item:' || ws_test.id('M1.blog') || '%')
    and not exists (select 1 from tasks where client_id = ws_test.id('M') and key = 'blog_post' and notes like 'plan_item:' || ws_test.id('M2.blog') || '%')
    and exists (select 1 from delivery_queue_log where client_id = ws_test.id('M') and deliverable = 'blog_posts'
                and reason = 'No approved core keyword list for M Two.'));
end $$;
set local session_replication_role = replica;
update core_keyword_lists set status = 'approved' where id = ws_test.id('list.M2');
set local session_replication_role = origin;

-- The weekly blog draft for L's named slot must be on a core keyword, and records it.
select set_config('ws_test.btask', (select id::text from tasks where client_id = ws_test.id('L') and key = 'blog_post' limit 1), true);
set local session authorization authenticator;
set local role service_role;
do $$
declare t uuid := current_setting('ws_test.btask')::uuid; r jsonb;
begin
  perform ws_test.ok('B1 a weekly blog for a standard slot on a keyword outside the core list is refused (core_keyword_required)',
    ws_test.msg(format('select content_draft_open_weekly(%L::jsonb)', jsonb_build_object('task_id', t, 'topic', 'Topic',
      'search_intent', 'commercial', 'keyword_id', ws_test.id('kL2'), 'service_id', ws_test.id('sL2')))) like '22023: core_keyword_required%');
  r := content_draft_open_weekly(jsonb_build_object('task_id', t, 'topic', 'Topic', 'search_intent', 'informational',
      'keyword_id', ws_test.id('kL'), 'service_id', ws_test.id('sL')));
  perform ws_test.ok('B2 a core keyword opens the draft, and the evidence names list and version',
    exists (select 1 from core_keyword_links where content_draft_id = (r->>'draft_id')::uuid
            and list_id = ws_test.id('list.L') and list_version = 1 and core_keyword_id = ws_test.id('kL')));
end $$;
reset role;
reset session authorization;

-- ── Site programs: one list per brand site, approved independently ─────────
do $$
declare ra text := current_setting('ws_test.ra'); r jsonb; t uuid;
begin
  perform ws_test.ok('S1 a multi-brand client''s list names its site, and only that site''s keywords; a single-site list names none',
    ws_test.err(format($q$insert into core_keyword_lists (client_id, keyword_ids, source_ref) values (%L, %L, 'x')$q$,
      ws_test.id('M'), array[ws_test.id('kM1')])) = '23514'
    and ws_test.err(format($q$insert into core_keyword_lists (client_id, brand_workspace_id, keyword_ids, source_ref) values (%L, %L, %L, 'x')$q$,
      ws_test.id('M'), ws_test.id('M1'), array[ws_test.id('kM2')])) = '23514'
    and ws_test.err(format($q$insert into core_keyword_lists (client_id, brand_workspace_id, keyword_ids, source_ref) values (%L, %L, %L, 'x')$q$,
      ws_test.id('A'), ws_test.id('M1'), array[ws_test.id('kA')])) = '23514');
  insert into core_keyword_lists (client_id, brand_workspace_id, keyword_ids, source_ref) values (ws_test.id('M'), ws_test.id('M1'), array[ws_test.id('kM1')], 'x');
  perform ws_test.ok('S2 versions are per site: a new M1 proposal is M1 v2, M2 keeps its own v1',
    (select max(version) from core_keyword_lists where brand_workspace_id = ws_test.id('M1')) = 2
    and (select max(version) from core_keyword_lists where brand_workspace_id = ws_test.id('M2')) = 1);
  perform ws_test.ok('S3 grounding is per site: a keyword grounds only in its own site''s list',
    (select list_id from core_keyword_grounding(ws_test.id('M'), ws_test.id('kM1'))) = ws_test.id('list.M1')
    and (select list_id from core_keyword_grounding(ws_test.id('M'), ws_test.id('kM2'))) = ws_test.id('list.M2'));
  perform set_config('session_replication_role', 'replica', true);
  update core_keyword_lists set status = 'superseded' where id = ws_test.id('list.M2');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('S4 per-site isolation: revoking M2''s list stops M2 and leaves M1 eligible; M1''s list never vouches for M2',
    ws_test.reason('M', 'M2.gb') like 'No approved core keyword list%'
    and ws_test.reason('M', 'M1.gb') in ('READY', 'Already linked to a post.')
    and not exists (select 1 from core_keyword_grounding(ws_test.id('M'), ws_test.id('kM2'))));
  perform set_config('session_replication_role', 'replica', true);
  update core_keyword_lists set status = 'approved' where id = ws_test.id('list.M2');
  perform set_config('session_replication_role', 'origin', true);
  t := (select id from tasks where key = 'social_slot:' || ws_test.id('M1.gb'));
  perform ws_test.ok('S5 claimed for M1', (social_slot_claim(t, ra)->>'claimed')::boolean);
  perform set_config('session_replication_role', 'replica', true);
  insert into social_posts (id, client_id, platform, search_intent, service_id, keyword_id, review_status, publish_status, created_at,
                            drafter_run_id, social_account_id, author_kind, copy, cta_type, cta_url) values
    (ws_test.id('p.cross'), ws_test.id('M'), 'google_business', 'commercial', ws_test.id('sM2'), ws_test.id('kM2'), 'in_review', 'not_scheduled',
     now() + interval '1 second', gen_random_uuid(), ws_test.id('gbM'), 'worker', 'copy for M2 on the shared location', 'LEARN_MORE', 'https://m2.example.test/service');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('S6 a valid, approved keyword of the sister site cannot fill an M1 slot, even on the shared location',
    ws_test.msg(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.cross'), ra)) like '22023: %belongs to another brand site%');
end $$;

-- ── Locations: several verified Business Profile locations per client ──────
set local session_replication_role = replica;
insert into clients (id, name, status, website_url) values (ws_test.id('G'), 'WS Two locations', 'active', 'https://g.example.test');
insert into brand_boards (client_id, status, approved_on) values (ws_test.id('G'), 'approved', now());
insert into services (id, client_id, name, status, page_url) values (ws_test.id('sG'), ws_test.id('G'), 'Service G', 'approved', 'https://g.example.test/service');
insert into keywords (id, client_id, keyword, service_id, is_active, intent, city) values
  (ws_test.id('kG'), ws_test.id('G'), 'kw g', ws_test.id('sG'), true, 'commercial', null),
  (ws_test.id('kGn'), ws_test.id('G'), 'kw g north city', ws_test.id('sG'), true, 'commercial', 'North City'),
  (ws_test.id('kGs'), ws_test.id('G'), 'kw g south town', ws_test.id('sG'), true, 'commercial', 'South Town');
insert into page_groups (client_id, name, page_type, target_url, status, supporting_keyword_ids) values (ws_test.id('G'), 'G page', 'service', 'https://g.example.test/service', 'approved', '{}');
insert into social_accounts (id, client_id, platform, display_name, external_account_id, publish_provider, publish_account_id, publish_page_id, publish_verified_at, publish_enabled) values
  (ws_test.id('gbG1'), ws_test.id('G'), 'google_business', 'G North', 'locations/71', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa71', 'locations/71', now(), false),
  (ws_test.id('gbG2'), ws_test.id('G'), 'google_business', 'G South', 'locations/72', 'zernio', 'aaaaaaaaaaaaaaaaaaaaaa72', 'locations/72', now(), false);
insert into publisher_client_transports (client_id, gbp_transport, changed_by_kind) values (ws_test.id('G'), 'zernio', 'publisher');
insert into core_keyword_lists (id, client_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
values (ws_test.id('list.G'), ws_test.id('G'), 1, 'approved', array[ws_test.id('kG'), ws_test.id('kGn'), ws_test.id('kGs')], 'test fixture', (select id from team_members limit 1), now());
insert into gbp_location_markets (client_id, social_account_id, market, kind, source_ref) values (ws_test.id('G'), ws_test.id('gbG1'), 'North City', 'office', 'test: the north office');
set local session_replication_role = origin;
select ws_test.slot('G.gb', 'G', 'gbp_posts', ws_test.w() + 2), ws_test.slot('G.gb1', 'G', 'gbp_posts', ws_test.w() + 3),
       ws_test.slot('G.gb2', 'G', 'gbp_posts', ws_test.w() + 3, null, 'blocked');
update content_plan_items set gbp_location_id = ws_test.id('gbG1') where id = ws_test.id('G.gb1');
update content_plan_items set gbp_location_id = ws_test.id('gbG2') where id = ws_test.id('G.gb2');
do $$
declare ra text := current_setting('ws_test.ra'); t uuid;
begin
  perform ws_test.ok('G1 a multi-location client''s slot with no location is never sent to a default: it asks for one',
    ws_test.reason('G', 'G.gb') = 'Choose this slot''s Business Profile location (the client has 2 verified locations).');
  perform ws_test.ok('G2 a slot naming its location is ready for exactly that location',
    ws_test.reason('G', 'G.gb1') = 'READY'
    and (select social_account_id from social_slot_readiness(ws_test.id('G'), ws_test.w(), ws_test.w() + 6) where plan_item_id = ws_test.id('G.gb1')) = ws_test.id('gbG1'));
  perform ws_test.ok('G3 a held location (verification hold) blocks only its own slot',
    ws_test.reason('G', 'G.gb2') = 'Blocked: held by a teammate' and ws_test.reason('G', 'G.gb1') = 'READY');
  perform queue_standard_social_tasks(ws_test.id('G'), ws_test.w() + 6);
  t := (select id from tasks where key = 'social_slot:' || ws_test.id('G.gb1'));
  perform ws_test.ok('G4 only the located slot is queued, naming its location',
    t is not null and not exists (select 1 from tasks where key = 'social_slot:' || ws_test.id('G.gb'))
    and (select notes like '%account:' || ws_test.id('gbG1') || '%' from tasks where id = t)
    and (social_slot_claim(t, ra)->>'social_account_id')::uuid = ws_test.id('gbG1'));
  perform set_config('session_replication_role', 'replica', true);
  insert into social_posts (id, client_id, platform, search_intent, service_id, keyword_id, review_status, publish_status, created_at,
                            drafter_run_id, social_account_id, author_kind, copy, cta_type, cta_url) values
    (ws_test.id('p.g2'), ws_test.id('G'), 'google_business', 'commercial', ws_test.id('sG'), ws_test.id('kG'), 'in_review', 'not_scheduled',
     now() + interval '1 second', gen_random_uuid(), ws_test.id('gbG2'), 'worker', 'copy for the other location', 'LEARN_MORE', 'https://g.example.test/service'),
    (ws_test.id('p.g1'), ws_test.id('G'), 'google_business', 'commercial', ws_test.id('sG'), ws_test.id('kG'), 'in_review', 'not_scheduled',
     now() + interval '1 second', gen_random_uuid(), ws_test.id('gbG1'), 'worker', 'copy for this location', 'LEARN_MORE', 'https://g.example.test/service');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('G5 a post for the other location cannot fill the slot',
    ws_test.msg(format($q$select social_slot_link(%L, %L, %L)$q$, t, ws_test.id('p.g2'), ra)) like '22023: The post is not addressed to the slot''s verified destination%');
  perform ws_test.ok('G6 the post for the slot''s own location links',
    (social_slot_link(t, ws_test.id('p.g1'), ra)->>'linked')::boolean);
  perform set_config('session_replication_role', 'replica', true);
  insert into social_posts (id, client_id, platform, search_intent, service_id, keyword_id, social_account_id, review_status, publish_status, author_kind, copy, created_by) values
    (ws_test.id('h.gs'), ws_test.id('G'), 'google_business', 'commercial', ws_test.id('sG'), ws_test.id('kGs'), ws_test.id('gbG1'), 'draft', 'not_scheduled', 'human', 'south town on the north profile', (select id from team_members limit 1)),
    (ws_test.id('h.gn'), ws_test.id('G'), 'google_business', 'informational', ws_test.id('sG'), ws_test.id('kGn'), ws_test.id('gbG1'), 'draft', 'not_scheduled', 'human', 'north city on the north profile', (select id from team_members limit 1)),
    (ws_test.id('h.g2'), ws_test.id('G'), 'google_business', 'commercial', ws_test.id('sG'), ws_test.id('kGs'), ws_test.id('gbG2'), 'draft', 'not_scheduled', 'human', 'south town on a location with no markets yet', (select id from team_members limit 1));
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('G7 a core keyword for another market cannot go to this Business Profile location',
    ws_test.msg(format($q$update social_posts set review_status = 'in_review', submitted_at = now() where id = %L$q$, ws_test.id('h.gs'))) like '23514: market_not_applicable: South Town%');
  perform ws_test.ok('G8 the location''s own market passes the core gate (only the ordinary review checklist remains)',
    ws_test.msg(format($q$update social_posts set review_status = 'in_review', submitted_at = now() where id = %L$q$, ws_test.id('h.gn')))
      like '23514: The post cannot be submitted: An informational post needs at least one confirmed or sourced claim.');
  -- Isolate the core gate from the ordinary review checklist (claims, creative)
  -- for the evidence checks; restored straight after.
  execute 'alter table social_posts disable trigger social_posts_aa_update';
  perform set_config('ws_test.g8b', ws_test.msg(format($q$update social_posts set review_status = 'in_review', submitted_at = now() where id = %L$q$, ws_test.id('h.gn'))), true);
  perform ws_test.ok('G8b entering review records the keyword, list and version that vouched for it',
    current_setting('ws_test.g8b') = 'accepted'
    and exists (select 1 from core_keyword_links where social_post_id = ws_test.id('h.gn') and list_id = ws_test.id('list.G')
                and list_version = 1 and keyword_id = ws_test.id('kGn') and core_keyword_id = ws_test.id('kGn')));
  perform ws_test.ok('G8c a revision in review is rechecked: moving it to a city outside the location''s market is refused',
    ws_test.msg(format($q$update social_posts set keyword_id = %L where id = %L$q$, ws_test.id('kGs'), ws_test.id('h.gn'))) like '23514: market_not_applicable%');
  perform set_config('ws_test.g8d', ws_test.msg(format($q$update social_posts set keyword_id = %L where id = %L$q$, ws_test.id('kG'), ws_test.id('h.gn'))), true);
  perform ws_test.ok('G8d a revision in review to another core keyword is recorded as its own evidence row',
    current_setting('ws_test.g8d') = 'accepted'
    and (select count(*) from core_keyword_links where social_post_id = ws_test.id('h.gn')) = 2
    and exists (select 1 from core_keyword_links where social_post_id = ws_test.id('h.gn') and keyword_id = ws_test.id('kG')));
  execute 'alter table social_posts enable trigger social_posts_aa_update';
  perform ws_test.ok('G9 a multi-location client''s location with no recorded market takes no city keyword (asks instead of guessing)',
    ws_test.msg(format($q$update social_posts set review_status = 'in_review', submitted_at = now() where id = %L$q$, ws_test.id('h.g2'))) like '23514: market_not_applicable%');
end $$;

-- ── Every path into review, once the site's list is approved ───────────────
do $$ begin
  perform set_config('session_replication_role', 'replica', true);
  insert into social_posts (id, client_id, platform, search_intent, service_id, keyword_id, review_status, publish_status, author_kind, copy, created_by) values
    -- A's approved list is v2 [kA2] by now (V6); kA is outside it.
    (ws_test.id('h.off'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA'), ws_test.id('kA'), 'draft', 'not_scheduled', 'human', 'hand typed off core', (select id from team_members limit 1)),
    (ws_test.id('h.none'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA'), null, 'draft', 'not_scheduled', 'human', 'hand typed no keyword', (select id from team_members limit 1)),
    (ws_test.id('h.p'), ws_test.id('P'), 'facebook', 'commercial', ws_test.id('sP'), ws_test.id('kP'), 'draft', 'not_scheduled', 'human', 'hand typed before approval', (select id from team_members limit 1));
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('P1 a hand-typed post submitted on a site with an approved list must name a core keyword',
    ws_test.msg(format($q$update social_posts set review_status = 'in_review', submitted_at = now() where id = %L$q$, ws_test.id('h.off'))) like '23514: core_keyword_required%'
    and ws_test.msg(format($q$update social_posts set review_status = 'in_review', submitted_at = now() where id = %L$q$, ws_test.id('h.none'))) like '23514: core_keyword_required%');
  perform ws_test.ok('P2 a site whose list is only proposed refuses a hand-typed post too (no fail-open before approval)',
    ws_test.msg(format($q$update social_posts set review_status = 'in_review', submitted_at = now() where id = %L$q$, ws_test.id('h.p'))) like '23514: core_keyword_required%');
  perform set_config('session_replication_role', 'replica', true);
  update core_keyword_lists set status = 'superseded' where id = ws_test.id('list.A2');
  insert into social_posts (id, client_id, platform, search_intent, service_id, keyword_id, review_status, publish_status, author_kind, copy, created_by) values
    (ws_test.id('h.rev'), ws_test.id('A'), 'facebook', 'commercial', ws_test.id('sA2'), ws_test.id('kA2'), 'draft', 'not_scheduled', 'human', 'after revocation', (select id from team_members limit 1));
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('P2b revoking the last approved list does not reopen the door',
    ws_test.msg(format($q$update social_posts set review_status = 'in_review', submitted_at = now() where id = %L$q$, ws_test.id('h.rev'))) like '23514: core_keyword_required%');
  perform set_config('session_replication_role', 'replica', true);
  update core_keyword_lists set status = 'approved' where id = ws_test.id('list.A2');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('P3 a refresh, new page or blog filing names its core keyword, and is recorded',
    ws_test.msg(format($q$insert into change_log (client_id, change_type, object_type, object_id, after, status) values (%L, 'page_rewrite', 'site', %L, '{}'::jsonb, 'proposed')$q$,
      ws_test.id('A'), ws_test.id('site.A'))) like '23514: core_keyword_required%'
    and ws_test.msg(format($q$insert into change_log (client_id, change_type, object_type, object_id, after, status) values (%L, 'page_added', 'site', %L, %L::jsonb, 'proposed')$q$,
      ws_test.id('A'), ws_test.id('site.A'), jsonb_build_object('keyword_id', ws_test.id('kA3')))) like '23514: core_keyword_required%'
    and ws_test.msg(format($q$insert into change_log (client_id, change_type, object_type, after, status) values (%L, 'page_rewrite', 'site', %L::jsonb, 'proposed')$q$,
      ws_test.id('A'), jsonb_build_object('keyword_id', ws_test.id('kA2')))) like '23514: core_keyword_required%names the site%'
    and ws_test.msg(format($q$insert into change_log (client_id, change_type, object_type, object_id, after, status) values (%L, 'page_rewrite', 'site', %L, %L::jsonb, 'proposed')$q$,
      ws_test.id('A'), ws_test.id('site.A'), jsonb_build_object('keyword_id', ws_test.id('kA2'), 'url', 'https://elsewhere.example.test/page'))) like '23514: core_keyword_required%not on the site%'
    and ws_test.msg(format($q$insert into change_log (id, client_id, change_type, object_type, object_id, after, status) values (%L, %L, 'page_rewrite', 'site', %L, %L::jsonb, 'proposed')$q$,
      ws_test.id('cl.ok'), ws_test.id('A'), ws_test.id('site.A'), jsonb_build_object('keyword_id', ws_test.id('kA2'), 'url', 'https://www.a.example.test/service-2'))) = 'accepted');
  perform ws_test.ok('P3c a sister site''s approved keyword cannot be filed against this site''s refresh',
    ws_test.msg(format($q$insert into change_log (client_id, change_type, object_type, object_id, after, status) values (%L, 'blog_post', 'site', %L, %L::jsonb, 'proposed')$q$,
      ws_test.id('M'), ws_test.id('site.M2'), jsonb_build_object('keyword_id', ws_test.id('kM1')))) like '23514: keyword_not_eligible%another brand site%');
  perform ws_test.ok('P3b the refresh''s grounding is recorded with list and version',
    exists (select 1 from core_keyword_links where change_log_id = ws_test.id('cl.ok') and core_keyword_id = ws_test.id('kA2') and list_version = 2));
  perform set_config('session_replication_role', 'replica', true);
  insert into content_drafts (id, client_id, deliverable, page_type, topic, keyword_id, service_id, status, title, body_markdown) values
    (ws_test.id('d.blogoff'), ws_test.id('A'), 'blog', null, 'hand blog off core', ws_test.id('kA'), ws_test.id('sA'), 'draft', 'T', 'Body'),
    (ws_test.id('d.pagenone'), ws_test.id('A'), 'web_page', 'service', 'hand page refresh, no keyword', null, ws_test.id('sA2'), 'draft', 'T', 'Body'),
    (ws_test.id('d.pagep'), ws_test.id('P'), 'web_page', 'service', 'page refresh before approval', ws_test.id('kP'), ws_test.id('sP'), 'draft', 'T', 'Body');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('P5 manual blog and page-refresh drafts are held to the same rule on entering review (off core, no keyword, unapproved site)',
    ws_test.msg(format($q$update content_drafts set status = 'in_review' where id = %L$q$, ws_test.id('d.blogoff'))) like '23514: core_keyword_required%'
    and ws_test.msg(format($q$update content_drafts set status = 'in_review' where id = %L$q$, ws_test.id('d.pagenone'))) like '23514: core_keyword_required%'
    and ws_test.msg(format($q$update content_drafts set status = 'in_review' where id = %L$q$, ws_test.id('d.pagep'))) like '23514: core_keyword_required%');
  -- A newer approved version (v3, same members) and a same-keyword URL revision.
  perform set_config('session_replication_role', 'replica', true);
  update core_keyword_lists set status = 'superseded' where id = ws_test.id('list.A2');
  insert into core_keyword_lists (id, client_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
  select ws_test.id('list.A3'), client_id, (select max(version) + 1 from core_keyword_lists where client_id = ws_test.id('A')), 'approved', keyword_ids, 'test: a newer version, same members', approved_by, now()
    from core_keyword_lists where id = ws_test.id('list.A2');
  perform set_config('session_replication_role', 'origin', true);
  perform set_config('ws_test.p3d', ws_test.msg(format($q$update change_log set after = after || '{"url": "https://a.example.test/service-2-revised"}'::jsonb where id = %L$q$,
    ws_test.id('cl.ok'))), true);
  perform set_config('ws_test.p3e', ws_test.msg(format($q$update change_log set after = after || '{"url": "https://m2.example.test/elsewhere"}'::jsonb where id = %L$q$,
    ws_test.id('cl.ok'))), true);
  perform set_config('session_replication_role', 'replica', true);
  update core_keyword_lists set status = 'superseded' where id = ws_test.id('list.A3');
  update core_keyword_lists set status = 'approved' where id = ws_test.id('list.A2');
  perform set_config('session_replication_role', 'origin', true);
  perform ws_test.ok('P4 other website changes (redirect, schema) are not content and are not gated',
    ws_test.msg(format($q$insert into change_log (client_id, change_type, object_type, after, status) values (%L, 'redirect', 'site', '{}'::jsonb, 'proposed')$q$,
      ws_test.id('A'))) = 'accepted');
end $$;

-- ── F. The strict path end to end: no exemption, every trigger on ──────────
-- A real drafter_write for A's Facebook slot on a core keyword (v2), as the
-- worker run that claimed the slot; the post enters review through the
-- ordinary checklist, the core gate records its evidence, and the slot links.
insert into claims (id, client_id, claim, status, source, confirmed_on)
values (ws_test.id('claim.A'), ws_test.id('A'), 'Service A2 is offered across the A metro.', 'confirmed', 'test fixture', now());
select ws_test.slot('A.fbF', 'A', 'facebook_posts', ws_test.w() + 4);
select queue_standard_social_tasks(ws_test.id('A'), ws_test.w() + 6);
set local session authorization authenticator;
set local role service_role;
do $$
declare ra text := current_setting('ws_test.ra'); t uuid; c jsonb; r jsonb; st text;
begin
  perform ws_test.ok('F0 strict: client A has no exemption and the exemption guard is on',
    not exists (select 1 from core_keyword_exemptions where client_id = ws_test.id('A'))
    and exists (select 1 from pg_trigger where tgname = 'core_keyword_exemptions_guard' and tgenabled = 'O')
    and exists (select 1 from pg_trigger where tgname = 'social_posts_aa_update' and tgenabled = 'O'));
  t := (select id from tasks where key = 'social_slot:' || ws_test.id('A.fbF'));
  c := social_slot_claim(t, ra);
  st := ws_test.msg(format('select set_config(%L, drafter_write(%L::jsonb)::text, true)', 'ws_test.f_write', jsonb_build_object(
    'client_id', ws_test.id('A'), 'requested_via', 'worker', 'runtime', 'sandbox-model', 'attempt', 1, 'claimant', ra,
    'brief_version', 'drafter-brief/1', 'brief_hash', 'sha256:' || repeat('ab', 32),
    'brief', jsonb_build_object('client', jsonb_build_object('id', ws_test.id('A')),
      'target', jsonb_build_object('channel', 'facebook', 'post_type', 'standard', 'search_intent', 'commercial',
        'service', jsonb_build_object('id', ws_test.id('sA2'), 'name', 'Service A2'),
        'keyword', jsonb_build_object('id', ws_test.id('kA2')), 'cta', jsonb_build_object('type', null, 'url', null), 'offer', null,
        'social_account', jsonb_build_object('id', ws_test.id('fbA'), 'page_id', '11111', 'name', 'A Page')),
      'allowed_facts', jsonb_build_object('claims', jsonb_build_array(jsonb_build_object('id', ws_test.id('claim.A'))))),
    'lint', jsonb_build_object('ok', true, 'problems', '[]'::jsonb, 'warnings', '[]'::jsonb),
    'copy', 'Service A2 is offered across the A metro. Ask us about it.', 'claim_ids', jsonb_build_array(ws_test.id('claim.A')), 'asset_ids', '[]'::jsonb)));
  r := nullif(current_setting('ws_test.f_write', true), '')::jsonb;
  perform set_config('ws_test.f_task', t::text, true);
  perform set_config('ws_test.f_post', coalesce(r->>'post_id', ''), true);
  perform ws_test.ok('F1 a worker run claims the slot and writes the post on a core keyword; it enters review through the ordinary checklist',
    st = 'accepted' and (select review_status = 'in_review' and keyword_id = ws_test.id('kA2') and social_account_id = ws_test.id('fbA')
                         from social_posts where id = (r->>'post_id')::uuid));
end $$;
do $$
declare p uuid := nullif(current_setting('ws_test.f_post'), '')::uuid;
begin
  perform ws_test.ok('F2 entering review recorded the keyword, the approved list and its version',
    exists (select 1 from core_keyword_links where social_post_id = p and keyword_id = ws_test.id('kA2')
            and list_id = ws_test.id('list.A2') and list_version = 2));
  perform set_config('ws_test.f_link', ws_test.msg(format('select social_slot_link(%L, %L, %L)', current_setting('ws_test.f_task'), p, current_setting('ws_test.ra'))), true);
end $$;
do $$ begin
  perform ws_test.ok('F3 the slot links that post and the task closes, without a second evidence row',
    current_setting('ws_test.f_link') = 'accepted'
    and (select content_post_id is null and social_post_id = nullif(current_setting('ws_test.f_post'), '')::uuid from content_plan_items where id = ws_test.id('A.fbF'))
    and (select status = 'done' from tasks where id = current_setting('ws_test.f_task')::uuid)
    and (select count(*) from core_keyword_links where social_post_id = nullif(current_setting('ws_test.f_post'), '')::uuid) = 1);
end $$;
reset role;
reset session authorization;

do $$ begin
  perform ws_test.ok('P3d a same-keyword URL revision under a newer approved version records its own evidence row (v2 kept, the newer one added)',
    current_setting('ws_test.p3d') = 'accepted'
    and exists (select 1 from core_keyword_links where change_log_id = ws_test.id('cl.ok') and list_version = 2)
    and exists (select 1 from core_keyword_links c join core_keyword_lists l on l.id = c.list_id where c.change_log_id = ws_test.id('cl.ok') and l.id = ws_test.id('list.A3') and c.list_version = l.version)
    and (select count(*) from core_keyword_links where change_log_id = ws_test.id('cl.ok')) = 2);
  perform ws_test.ok('P3e a URL revision onto another host is refused like an insert',
    current_setting('ws_test.p3e') like '23514: core_keyword_required%not on the site%');
end $$;
-- ── R. Rank observations are judged against the keyword's own site ─────────
insert into locations (id, client_id, name, city, is_physical_location) values (ws_test.id('loc.M'), ws_test.id('M'), 'M home', 'M City', true);
insert into keywords (id, client_id, keyword, service_id, is_active, intent) values (ws_test.id('kMx'), ws_test.id('M'), 'kw m none', null, true, 'commercial');
update keywords set is_tracked = true where id in (ws_test.id('kM1'), ws_test.id('kM2'));
insert into rank_snapshots (keyword_id, location_id, result_type, position, url_ranked, recorded_at, source, site_host) values
  -- kM2: an old row (no site_host) whose page is the sister site M1's
  (ws_test.id('kM2'), ws_test.id('loc.M'), 'organic', 2, 'https://m1.example.test/service', now() - interval '1 day', 'dataforseo', null),
  -- kM1: an older new-style website rank, then the latest new-style row: a sister page
  (ws_test.id('kM1'), ws_test.id('loc.M'), 'organic', 5, 'https://www.m1.example.test/service', now() - interval '8 days', 'dataforseo', 'm1.example.test'),
  (ws_test.id('kM1'), ws_test.id('loc.M'), 'organic', 1, 'https://m2.example.test/x', now() - interval '1 day', 'dataforseo', 'm1.example.test');
do $$ begin
  perform ws_test.ok('R1 each keyword resolves to its own brand site; a single-site client to its one site; unowned resolves to nothing',
    keyword_site_hosts(ws_test.id('kM1')) = array['m1.example.test'] and keyword_site_hosts(ws_test.id('kM2')) = array['m2.example.test']
    and keyword_site_hosts(ws_test.id('kA2')) = array['a.example.test'] and keyword_site_hosts(ws_test.id('kMx')) = '{}');
  perform ws_test.ok('R2 its own host counts, a sister brand''s host never does',
    keyword_organic_state(ws_test.id('kM1'), 'dataforseo', 3, 'https://blog.m1.example.test/a', 'm1.example.test') = 'website'
    and keyword_organic_state(ws_test.id('kM1'), 'dataforseo', 3, 'https://m2.example.test/a', 'm1.example.test') = 'third_party'
    and keyword_organic_state(ws_test.id('kMx'), 'dataforseo', 3, 'https://m1.example.test/a', 'm1.example.test') = 'unverified');
  perform ws_test.ok('R3 older multi-brand rows prove nothing for a site unless they show a page on it',
    keyword_organic_state(ws_test.id('kM2'), 'dataforseo', null, null, null) = 'unverified'
    and keyword_organic_state(ws_test.id('kM2'), 'dataforseo', 2, 'https://m1.example.test/service', null) = 'unverified'
    and keyword_organic_state(ws_test.id('kM2'), 'dataforseo', 4, 'https://m2.example.test/service', null) = 'website'
    and keyword_organic_state(ws_test.id('kM2'), 'dataforseo', null, null, 'm1.example.test') = 'unverified');
  perform ws_test.ok('R4 single-site clients are unchanged (not found, website, third party)',
    keyword_organic_state(ws_test.id('kA2'), 'dataforseo', null, null, null) = 'not_found'
    and keyword_organic_state(ws_test.id('kA2'), 'dataforseo', 4, 'https://www.a.example.test/p', null) = 'website'
    and keyword_organic_state(ws_test.id('kA2'), 'dataforseo', 4, 'https://www.facebook.com/a', null) = 'third_party');
  perform ws_test.ok('R5 the ranking view shows no position for a sister page or an unattributed old row, and keeps the earlier own-site rank as history',
    (select position is null and state = 'third_party' and previous_position = 5 and previous_state = 'website'
       from client_growth_rankings where keyword_id = ws_test.id('kM1') and result_type = 'organic')
    and (select position is null and state = 'unverified' from client_growth_rankings where keyword_id = ws_test.id('kM2') and result_type = 'organic'));
  perform ws_test.ok('R6 the per-site coverage view reports no position from a sister page',
    not exists (select 1 from core_keyword_site_coverage where keyword_id = ws_test.id('kM1') and latest_organic_position is not null));
  perform ws_test.ok('R7 anon cannot resolve sites or judge rows',
    not has_function_privilege('anon', 'public.keyword_site_hosts(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.keyword_organic_state(uuid, text, integer, text, text)', 'execute'));
end $$;

-- ── Access ──────────────────────────────────────────────────────────────────
set local role anon;
do $$ begin
  perform ws_test.ok('X1 anon reads nothing of the log, the lists or the links',
    ws_test.err('select count(*) from delivery_queue_log') = '42501'
    and ws_test.err('select count(*) from core_keyword_lists') = '42501'
    and ws_test.err('select count(*) from core_keyword_links') = '42501');
end $$;
reset role;
set local role authenticated;
do $$ begin
  perform ws_test.ok('X2 a signed-in teammate cannot write the log or the evidence', ws_test.err(format(
    $q$insert into delivery_queue_log (client_id, deliverable, decision, reason) values (%L, 'blog_posts', 'queued', 'x')$q$, ws_test.id('A'))) = '42501'
    and ws_test.err(format($q$insert into core_keyword_links (client_id, list_id, list_version, keyword_id, core_keyword_id, social_post_id)
      values (%L, %L, 1, %L, %L, %L)$q$, ws_test.id('A'), ws_test.id('list.A'), ws_test.id('kA'), ws_test.id('kA'), ws_test.id('p.ok'))) = '42501');
end $$;
reset role;
rollback;
