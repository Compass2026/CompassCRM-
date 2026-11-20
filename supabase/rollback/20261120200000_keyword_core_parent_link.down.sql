-- Rollback of 20261120200000_keyword_core_parent_link.sql. Drops the column
-- guard, the link functions, the rule and the event table. Links already made
-- stay on keywords.core_parent_keyword_id and keep grounding drafts exactly as
-- before; with the guard gone the column is unguarded again (as it was).
-- Export keyword_core_link_events first if the history should be kept.
drop trigger if exists keywords_core_parent_guard on keywords;
drop function if exists keywords_core_parent_guard();
drop function if exists keyword_unlink_core_parent(uuid, text);
drop function if exists keyword_link_core_parent(uuid, uuid, text);
drop function if exists keyword_core_link_caller();
drop function if exists keyword_core_link_options(uuid);
drop function if exists keyword_core_link_problem(uuid, uuid, boolean);
drop function if exists keyword_core_link_places(uuid, boolean);
drop table if exists keyword_core_link_events;
drop function if exists keyword_core_link_events_guard();
