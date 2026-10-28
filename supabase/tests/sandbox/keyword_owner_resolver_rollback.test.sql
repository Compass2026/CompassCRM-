-- 20261028170000 rollback: the down script restores the previous gates,
-- drafter_write, slot functions, loader and planner board, drops the
-- resolver and the copy-hold triggers, and keeps the recorded markets,
-- page checks and holds. Run inside a transaction and undone.
begin;
insert into client_promotion_holds (client_id, offering, phrases, source_ref, decided_on)
select id, 'Rollback fixture', array['rollback fixture phrase'], 'rollback test', current_date from clients limit 1;
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
  raise notice 'ok RB1-RB6 the 20261028170000 rollback restores the previous functions and keeps the recorded data';
end $$;
rollback;
