-- 20261028170000 rollback: containment first, then the down script.
-- The down script is refused without the containment; the containment
-- pauses every path for a client with an active hold (and nobody else),
-- still records a send already under way, and cannot be released while
-- hold enforcement is missing. The down script restores the previous
-- gates, drafter_write, slot functions, loader and planner board, drops
-- the resolver and the copy-hold triggers, and keeps the recorded markets,
-- page checks and holds. Run inside a transaction and undone.
begin;
create schema rbt;
create function rbt.st(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function rbt.id(k text) returns uuid language sql immutable as $$ select md5('rb:' || k)::uuid $$;

-- A held client and an unheld one, and a post of the held client mid-send.
set local session_replication_role = replica;
insert into clients (id, name, status, website_url) values
  (rbt.id('held'), 'Rollback Held Co', 'active', 'https://held.example.test'),
  (rbt.id('free'), 'Rollback Free Co', 'active', 'https://free.example.test');
insert into social_posts (id, client_id, platform, search_intent, review_status, publish_status, created_at, copy,
                          reviewed_by, reviewed_at, approved_snapshot, approved_hash, scheduled_at)
values (rbt.id('sending'), rbt.id('held'), 'facebook', 'commercial', 'approved', 'publishing', now(), 'Fixture copy.',
        (select id from team_members limit 1), now(), '{}', 'sha256:' || repeat('d', 64), now());
set local session_replication_role = origin;
insert into client_promotion_holds (client_id, offering, phrases, source_ref, decided_on)
values (rbt.id('held'), 'Rollback fixture', array['rollback fixture phrase'], 'rollback test', current_date);

-- RB0: the down script itself refuses without the containment (its errors
-- below are expected; everything it tried is rolled back to the savepoint).
\set ON_ERROR_STOP off
savepoint before_down;
\ir ../../rollback/20261028170000_keyword_owner_resolver.down.sql
rollback to savepoint before_down;
\set ON_ERROR_STOP on
do $$ begin
  if to_regprocedure('keyword_owner(uuid,uuid,uuid,text)') is null
     or not exists (select 1 from pg_trigger where tgname = 'social_posts_ab_promotion_hold') then
    raise exception 'RB0 the down script ran without the containment';
  end if;
  raise notice 'ok RB0 the down script refuses without the containment';
end $$;

\ir ../../rollback/20261028170000_keyword_owner_resolver.containment.sql

do $$
declare h uuid := rbt.id('held'); f uuid := rbt.id('free'); r text;
begin
  -- Every path of the held client is paused ...
  r := rbt.st(format($q$insert into social_posts (client_id, platform, search_intent, review_status, publish_status, copy)
                        values (%L, 'facebook', 'commercial', 'draft', 'not_scheduled', 'x')$q$, h));
  if r not like '55000: rollback_containment%' then raise exception 'RC1 a new post was not refused: %', r; end if;
  r := rbt.st(format($q$insert into content_drafts (client_id, deliverable, topic, status) values (%L, 'blog', 'x', 'draft')$q$, h));
  if r not like '55000: rollback_containment%' then raise exception 'RC2 a new draft was not refused: %', r; end if;
  r := rbt.st(format($q$insert into blog_publications (client_id, draft_id, draft_version, release_hash, snapshot, released_by, scheduled_at)
                        values (%L, %L, 1, %L, '{}', %L, now())$q$, h, gen_random_uuid(), 'sha256:' || repeat('e', 64),
                        (select id from team_members limit 1)));
  if r not like '55000: rollback_containment%' then raise exception 'RC3 a blog release was not refused: %', r; end if;
  r := rbt.st(format($q$insert into change_log (client_id, change_type, object_type, after, status)
                        values (%L, 'page_rewrite', 'site', '{}', 'proposed')$q$, h));
  if r not like '55000: rollback_containment%' then raise exception 'RC4 a page change was not refused: %', r; end if;
  -- ... a send already under way is still recorded ...
  r := rbt.st(format($q$update social_posts set publish_status = 'published', published_at = now(),
                        published_url = 'https://facebook.example.test/rb' where id = %L$q$, rbt.id('sending')));
  if r like '55000:%' then raise exception 'RC5 the outcome of a send under way was refused: %', r; end if;
  -- ... and another client is not paused.
  r := rbt.st(format($q$insert into social_posts (client_id, platform, search_intent, review_status, publish_status, copy)
                        values (%L, 'facebook', 'commercial', 'draft', 'not_scheduled', 'x')$q$, f));
  if r like '55000:%' then raise exception 'RC6 an unheld client was paused: %', r; end if;
  raise notice 'ok RC1-RC6 containment pauses the held client''s every path, records a send under way, leaves others alone';
end $$;

\ir ../../rollback/20261028170000_keyword_owner_resolver.down.sql
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
              and p.proname in ('keyword_owner', 'keyword_owner_context', 'core_copy_hold', 'core_hold_hit', 'core_promotion_hold',
                                'promotion_hold_conflicts', 'owner_page_check_targets', 'core_site_of_keyword')) then
    raise exception 'RB1 resolver functions remain';
  end if;
  if exists (select 1 from pg_proc where proname = 'core_keyword_eligibility' and pronargs = 5) then raise exception 'RB2 5-argument eligibility remains'; end if;
  if strpos(pg_get_functiondef('core_keyword_social_gate()'::regprocedure), 'keyword_owner') > 0
     or strpos(pg_get_functiondef('core_keyword_draft_gate()'::regprocedure), 'owner_page_mismatch') > 0
     or strpos(pg_get_functiondef('drafter_write(jsonb)'::regprocedure), 'core_keyword_gate_v2') > 0
     or strpos(pg_get_viewdef('content_plan_board'::regclass), 'core_keyword_eligibility') > 0 then
    raise exception 'RB3 a patched function or the board was not restored';
  end if;
  if to_regprocedure('client_intelligence_for_content(uuid,uuid,uuid)') is not null
     or to_regprocedure('client_intelligence_for_content(uuid,uuid)') is null
     or has_function_privilege('anon', 'client_intelligence_for_content(uuid,uuid)', 'execute')
     or not has_function_privilege('authenticated', 'client_intelligence_for_content(uuid,uuid)', 'execute') then
    raise exception 'RB4 the two-argument loader and its grants were not restored';
  end if;
  if exists (select 1 from pg_trigger where tgname in ('social_posts_ab_promotion_hold', 'content_drafts_ab_promotion_hold',
              'blog_publications_promotion_hold', 'change_log_ab_promotion_hold', 'content_plan_items_ab_promotion_hold')) then
    raise exception 'RB5 a copy-hold trigger remains';
  end if;
  if not exists (select 1 from client_promotion_holds where offering = 'Rollback fixture')
     or to_regclass('client_service_markets') is null or to_regclass('owner_page_checks') is null
     or not exists (select 1 from information_schema.columns where table_name = 'keywords' and column_name = 'market_id') then
    raise exception 'RB6 recorded markets, checks and holds must be kept';
  end if;
  -- The pause outlives the rollback, and cannot be lifted without enforcement.
  if (select count(*) from pg_trigger where tgname like '%_a0_rollback_containment' and tgenabled <> 'D') <> 5
     or rbt.st(format($q$insert into content_drafts (client_id, deliverable, topic, status) values (%L, 'blog', 'x', 'draft')$q$, rbt.id('held')))
        not like '55000: rollback_containment%' then
    raise exception 'RB7 the containment did not survive the rollback';
  end if;
  raise notice 'ok RB1-RB7 the rollback restores the previous functions, keeps the recorded data, and the pause stays';
end $$;
-- RB8: the release refuses while enforcement is missing (expected error).
\set ON_ERROR_STOP off
savepoint before_release;
\ir ../../rollback/20261028170000_keyword_owner_resolver.containment-release.sql
rollback to savepoint before_release;
\set ON_ERROR_STOP on
do $$ begin
  if (select count(*) from pg_trigger where tgname like '%_a0_rollback_containment') <> 5 then
    raise exception 'RB8 the containment was released while hold enforcement is missing';
  end if;
  raise notice 'ok RB8 the release refuses while hold enforcement is missing';
end $$;
rollback;
