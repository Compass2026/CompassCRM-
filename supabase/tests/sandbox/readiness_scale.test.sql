-- 20261029030000: keyword_owner's expression index and slot readiness judged
-- once per site. The rows must be the ones the previous definition returned
-- (it is run and undone here through the down script), and the eligibility
-- work must follow the sites, not the slots. Fictional clients only;
-- everything is rolled back. Timings are the benchmark's (private review
-- package), not asserted here.
--   T  multi-brand: T1 has an eligible core keyword; T2 has none (its owner
--      page is unchecked) while its sister sites do; T3 is eligible only
--      through a supporting term (its core keyword has no intent); a keyword
--      of each of T1 / T2 sits in the other's list (drift)
--   U  single site, an eligible core keyword
--   V  single site, an approved list with nothing eligible
--   W  single site, a list only proposed
--   Z  single site, an approved list, every slot blocked
begin;
do $$ begin
  if exists (select 1 from pg_trigger where tgname = 'sandbox_core_exempt_new_client') then
    execute 'alter table clients disable trigger sandbox_core_exempt_new_client';
  end if;
end $$;
create schema rs;
create function rs.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function rs.id(k text) returns uuid language sql immutable as $$ select md5('rs:' || k)::uuid $$;
create function rs.w() returns date language sql immutable as $$ select date '2026-11-02' $$;  -- a Monday

set local session_replication_role = replica;
insert into clients (id, name, status, website_url) values
  (rs.id('T'), 'RS Multi', 'active', 'https://t.rs.test'), (rs.id('U'), 'RS Single', 'active', 'https://u.rs.test'),
  (rs.id('V'), 'RS Unverified', 'active', 'https://v.rs.test'), (rs.id('W'), 'RS Proposed', 'active', 'https://w.rs.test'),
  (rs.id('Z'), 'RS Blocked', 'active', 'https://z.rs.test');
insert into brand_boards (client_id, status, approved_on)
select rs.id(c), 'approved', now() from unnest(array['T', 'U', 'V', 'W', 'Z']) c;
insert into services (id, client_id, name, status, page_url) values
  (rs.id('sT1'), rs.id('T'), 'T1 service', 'approved', 'https://t1.rs.test/service'),
  (rs.id('sT2'), rs.id('T'), 'T2 service', 'approved', 'https://t2.rs.test/service'),
  (rs.id('sT3'), rs.id('T'), 'T3 service', 'approved', 'https://t3.rs.test/service'),
  (rs.id('sU'), rs.id('U'), 'U service', 'approved', 'https://u.rs.test/service'),
  (rs.id('sV'), rs.id('V'), 'V service', 'approved', 'https://v.rs.test/service'),
  (rs.id('sW'), rs.id('W'), 'W service', 'approved', 'https://w.rs.test/service'),
  (rs.id('sZ'), rs.id('Z'), 'Z service', 'approved', 'https://z.rs.test/service');
insert into keywords (id, client_id, keyword, intent, service_id, core_parent_keyword_id, is_active) values
  (rs.id('kT1a'), rs.id('T'), 'rs t1 alpha', 'commercial', rs.id('sT1'), null, true),
  (rs.id('kT1b'), rs.id('T'), 'rs t1 beta', 'informational', rs.id('sT1'), null, true),
  (rs.id('kT2a'), rs.id('T'), 'rs t2 alpha', 'commercial', rs.id('sT2'), null, true),
  (rs.id('kT2b'), rs.id('T'), 'rs t2 beta', 'informational', rs.id('sT2'), null, true),
  (rs.id('kT3p'), rs.id('T'), 'rs t3 parent', null, rs.id('sT3'), null, true),
  (rs.id('kT3c'), rs.id('T'), 'rs t3 parent cost', 'commercial', rs.id('sT3'), rs.id('kT3p'), true),
  (rs.id('kX'), rs.id('T'), 'rs drift on t1 service', 'commercial', rs.id('sT1'), null, true),
  (rs.id('kY'), rs.id('T'), 'rs drift on t2 service', 'commercial', rs.id('sT2'), null, true),
  (rs.id('kOut'), rs.id('T'), 'rs outside every list', 'commercial', rs.id('sT1'), null, true),
  (rs.id('kU'), rs.id('U'), 'rs u alpha', 'commercial', rs.id('sU'), null, true),
  (rs.id('kV'), rs.id('V'), 'rs v alpha', 'commercial', rs.id('sV'), null, true),
  (rs.id('kW'), rs.id('W'), 'rs w alpha', 'commercial', rs.id('sW'), null, true),
  (rs.id('kZ'), rs.id('Z'), 'rs z alpha', 'commercial', rs.id('sZ'), null, true);
insert into sites (id, client_id, url)
select rs.id('site' || k), rs.id('T'), 'https://' || lower(k) || '.rs.test' from unnest(array['T1', 'T2', 'T3']) k;
insert into page_groups (client_id, name, page_type, target_url, status, supporting_keyword_ids)
select v.client_id, v.name, 'service', v.page_url, 'approved', '{}' from services v where v.client_id in (select id from clients where name like 'RS %');
-- Every owner page checked live except T2's and V's.
insert into owner_page_checks (client_id, requested_url, url_norm, final_url, http_status, verdict, method, source_ref)
select v.client_id, v.page_url, core_norm_url(v.page_url), v.page_url, 200, 'live', 'http', 'test fixture'
from services v where v.client_id in (select id from clients where name like 'RS %') and v.id not in (rs.id('sT2'), rs.id('sV'));
insert into social_accounts (id, client_id, platform, display_name, external_account_id, publish_provider, publish_account_id,
                             publish_page_id, publish_verified_at, publish_enabled)
select rs.id('fb' || k), rs.id(c), 'facebook', k || ' Page', (81000 + n)::text, 'zernio', left(md5('rsfb' || k), 24), (81000 + n)::text, now(), false
from (values ('T1', 'T', 1), ('T2', 'T', 2), ('T3', 'T', 3), ('U', 'U', 4), ('V', 'V', 5), ('W', 'W', 6), ('Z', 'Z', 7)) v(k, c, n);
insert into client_brand_workspaces (id, client_id, slug, name, website_url, phone, service_ids, facebook_account_id, status, approved_by, approved_at, blog_site_id)
select rs.id(k), rs.id('T'), lower(k), 'RS ' || k, 'https://' || lower(k) || '.rs.test', '5555555555', array[rs.id('s' || k)], rs.id('fb' || k),
       'approved', (select id from team_members limit 1), now(), rs.id('site' || k)
from unnest(array['T1', 'T2', 'T3']) k;
insert into core_keyword_lists (id, client_id, brand_workspace_id, version, status, keyword_ids, source_ref, approved_by, approved_at) values
  (rs.id('lT1'), rs.id('T'), rs.id('T1'), 1, 'approved', array[rs.id('kT1a'), rs.id('kT1b'), rs.id('kY')], 'test fixture', (select id from team_members limit 1), now()),
  (rs.id('lT2'), rs.id('T'), rs.id('T2'), 1, 'approved', array[rs.id('kT2a'), rs.id('kT2b'), rs.id('kX')], 'test fixture', (select id from team_members limit 1), now()),
  (rs.id('lT3'), rs.id('T'), rs.id('T3'), 1, 'approved', array[rs.id('kT3p')], 'test fixture', (select id from team_members limit 1), now()),
  (rs.id('lU'), rs.id('U'), null, 1, 'approved', array[rs.id('kU')], 'test fixture', (select id from team_members limit 1), now()),
  (rs.id('lV'), rs.id('V'), null, 1, 'approved', array[rs.id('kV')], 'test fixture', (select id from team_members limit 1), now()),
  (rs.id('lZ'), rs.id('Z'), null, 1, 'approved', array[rs.id('kZ')], 'test fixture', (select id from team_members limit 1), now());
insert into core_keyword_lists (id, client_id, version, status, keyword_ids, source_ref)
values (rs.id('lW'), rs.id('W'), 1, 'proposed', array[rs.id('kW')], 'test fixture');
set local session_replication_role = origin;

-- Facebook slots: per site of T three over two weeks plus a blocked one on
-- T1; two on each single-site client; Z's are all blocked.
create function rs.slot(k text, c text, d date, ws text default null, hold text default null) returns uuid language sql as $$
  insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, planned_date, standard_key,
                                  brand_workspace_id, hold, hold_reason)
  values (rs.id(k), rs.id(c), d - (extract(isodow from d)::int - 1), 'social', 'facebook'::social_platform, 'service', 'slot ' || k, d,
          'facebook_posts', case when ws is not null then rs.id(ws) end, hold, case when hold = 'blocked' then 'held by a teammate' end)
  returning id $$;
select rs.slot(s || '.' || n, 'T', rs.w() + (n - 1) * 4, s) from unnest(array['T1', 'T2', 'T3']) s, generate_series(1, 3) n;
select rs.slot('T1.held', 'T', rs.w() + 1, 'T1', 'blocked');
select rs.slot(c || '.' || n, c, rs.w() + (n - 1) * 7) from unnest(array['U', 'V', 'W']) c, generate_series(1, 2) n;
select rs.slot('Z.' || n, 'Z', rs.w() + n, null, 'blocked') from generate_series(1, 2) n;

-- Every readiness row for every client and two windows, as jsonb.
create table rs.snap (run text, client text, win int, r jsonb);
create function rs.take(run text) returns void language sql as $$
  insert into rs.snap
  select run, c, win, to_jsonb(x) from unnest(array['T', 'U', 'V', 'W', 'Z']) c, unnest(array[6, 13]) win,
       lateral social_slot_readiness(rs.id(c), rs.w(), rs.w() + win) x $$;
-- Eligibility calls made by one readiness call (pg_stat_xact_user_functions).
set local track_functions = 'pl';
create function rs.calls() returns bigint language sql as $$
  select coalesce((select calls from pg_stat_xact_user_functions
                    where funcid = 'core_keyword_eligibility(uuid,uuid,uuid,uuid,text)'::regprocedure), 0) $$;
create function rs.calls_for(c text, win int) returns bigint language plpgsql as $$
declare b bigint := rs.calls(); n bigint;
begin
  select count(*) into n from social_slot_readiness(rs.id(c), rs.w(), rs.w() + win) x where x::text is not null;
  return rs.calls() - b;
end $$;

select rs.take('per_site');
select rs.ok('R0 the fixture reaches every branch: T1 and T3 ready, T2 has no eligible keyword, U ready, V not, W proposed only, Z blocked',
  (select bool_and((r->>'ready')::boolean) from rs.snap where run = 'per_site' and win = 13 and client = 'T'
     and r->>'brand_workspace_id' in (rs.id('T1')::text, rs.id('T3')::text) and r->>'plan_item_id' <> rs.id('T1.held')::text)
  and (select bool_and(r->>'reason' like 'No core keyword (v1)%') from rs.snap where run = 'per_site' and win = 13 and r->>'brand_workspace_id' = rs.id('T2')::text)
  and (select count(*) from rs.snap where run = 'per_site' and win = 13 and r->>'brand_workspace_id' = rs.id('T2')::text) = 3
  and (select bool_and((r->>'ready')::boolean) from rs.snap where run = 'per_site' and win = 13 and client = 'U')
  and (select bool_and(r->>'reason' like 'No core keyword (v1)%') from rs.snap where run = 'per_site' and win = 13 and client = 'V')
  and (select bool_and(r->>'reason' like 'No approved core keyword list (v1 proposed%') from rs.snap where run = 'per_site' and win = 13 and client = 'W')
  and (select bool_and(r->>'reason' like 'Blocked:%') from rs.snap where run = 'per_site' and win = 13 and client = 'Z'));

select set_config('rs.new_T', rs.calls_for('T', 13)::text, true), set_config('rs.new_Z', rs.calls_for('Z', 13)::text, true),
       set_config('rs.new_T_week', rs.calls_for('T', 6)::text, true);
select rs.ok('R1 the eligibility work follows the sites: at most each site''s own list and supporting terms, none for a client whose slots never reach the check',
  current_setting('rs.new_T')::int <= 3 + 3 + 2             -- T1 3, T2 3, T3 a parent and its supporting term
  and current_setting('rs.new_T')::int >= 3                 -- T2 judged in full
  and current_setting('rs.new_T_week')::int = current_setting('rs.new_T')::int
  and current_setting('rs.new_Z')::int = 0);
-- Three more T2 slots: the same work.
select rs.slot('T2.extra' || n, 'T', rs.w() + n, 'T2') from generate_series(1, 3) n;
select rs.ok('R2 more slots on a site with nothing eligible add no eligibility work',
  rs.calls_for('T', 13) = current_setting('rs.new_T')::bigint);
delete from content_plan_items where id in (select rs.id('T2.extra' || n) from generate_series(1, 3) n);

-- The previous definition, run and undone: the same rows, more work.
savepoint before_rs_down;
\ir ../../rollback/20261029030000_readiness_scale.down.sql
select rs.take('per_slot');
select set_config('rs.old_T', rs.calls_for('T', 13)::text, true);
select rs.ok('R3 the rows are the previous definition''s, for every client and window (both directions)',
  (select count(*) from rs.snap where run = 'per_site') = (select count(*) from rs.snap where run = 'per_slot')
  and not exists ((select client, win, r from rs.snap where run = 'per_site') except all (select client, win, r from rs.snap where run = 'per_slot'))
  and not exists ((select client, win, r from rs.snap where run = 'per_slot') except all (select client, win, r from rs.snap where run = 'per_site')));
select rs.ok(format('R4 the previous definition judged keywords slot by slot (what this fixes): %s eligibility calls, against %s per site',
                    current_setting('rs.old_T'), current_setting('rs.new_T')),
  current_setting('rs.old_T')::int > current_setting('rs.new_T')::int
  and md5(pg_get_functiondef('social_slot_readiness(uuid,date,date)'::regprocedure)) = '34557bebbcec78cd2a0fe401577ce3c5'
  and to_regclass('keywords_client_norm_kw') is null);
rollback to savepoint before_rs_down;

-- The index changes no owner: every fixture keyword resolves the same with
-- and without it.
create table rs.own (run text, id uuid, o jsonb);
insert into rs.own select 'indexed', k.id, keyword_owner(k.client_id, null, k.id, 'post') from keywords k where k.client_id in (select id from clients where name like 'RS %');
savepoint before_rs_noindex;
drop index keywords_client_norm_kw;
insert into rs.own select 'unindexed', k.id, keyword_owner(k.client_id, null, k.id, 'post') from keywords k where k.client_id in (select id from clients where name like 'RS %');
select rs.ok('R5 keyword_owner answers the same with and without the index',
  (select count(*) from rs.own where run = 'unindexed') = (select count(*) from rs.own where run = 'indexed')
  and not exists ((select id, o from rs.own where run = 'indexed') except (select id, o from rs.own where run = 'unindexed'))
  and not exists ((select id, o from rs.own where run = 'unindexed') except (select id, o from rs.own where run = 'indexed')));
rollback to savepoint before_rs_noindex;
select rs.ok('R6 the migration''s definition, index and grants are back after the down script is undone',
  strpos(pg_get_functiondef('social_slot_readiness(uuid,date,date)'::regprocedure), 'site_ok as materialized') > 0
  and to_regclass('keywords_client_norm_kw') is not null
  and not has_function_privilege('anon', 'social_slot_readiness(uuid,date,date)', 'execute')
  and has_function_privilege('authenticated', 'social_slot_readiness(uuid,date,date)', 'execute'));
rollback;
