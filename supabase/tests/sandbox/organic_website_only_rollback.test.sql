-- The rollback script restores the previous views, grants and City Index
-- function and drops the helpers. Run inside a transaction and undone.
begin;
\ir ../../rollback/20261020230000_organic_rank_website_only.down.sql
do $$ begin
 if exists(select 1 from pg_proc where proname in ('url_host','organic_rank_state')) then raise exception 'R1 helpers not dropped'; end if;
 if exists(select 1 from information_schema.columns where table_name in ('client_growth_rankings','portal_growth_rankings','portal_rankings') and column_name in ('state','first_state','previous_state')) then raise exception 'R2 state columns remain'; end if;
 if not exists(select 1 from pg_class where relname='client_growth_rankings' and 'security_invoker=true'=any(reloptions))
    or not exists(select 1 from pg_class where relname='portal_growth_rankings' and 'security_barrier=true'=any(reloptions) and 'security_invoker=false'=any(reloptions))
    or not exists(select 1 from pg_class where relname='portal_rankings' and 'security_invoker=false'=any(reloptions)) then raise exception 'R3 view options not restored'; end if;
 if has_table_privilege('anon','public.portal_rankings','select') or not has_table_privilege('authenticated','public.portal_rankings','select')
    or has_table_privilege('authenticated','public.client_growth_rankings','update') or not has_table_privilege('authenticated','public.client_growth_rankings','select') then raise exception 'R4 grants not restored'; end if;
 if pg_get_functiondef('compute_location_index'::regproc) like '%organic_rank_state%' then raise exception 'R5 City Index function not restored'; end if;
 if not exists(select 1 from client_growth_rankings where keyword='a plumber' and result_type='organic' and position=5 and previous_position=9) then raise exception 'R6 restored view lost data'; end if;
end $$;
rollback;
