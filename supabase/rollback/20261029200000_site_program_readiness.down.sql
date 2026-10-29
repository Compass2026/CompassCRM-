-- Rollback of 20261029200000_site_program_readiness.sql. Nothing else reads
-- these objects; no existing row, gate or function is touched. The place
-- reference rows go with their tables (reload with
-- supabase/seeds/place-names-v1.sql after re-applying).
drop function if exists site_program_readiness(uuid);
drop function if exists core_places_in(text, text[], text[]);
drop table if exists place_names;
drop table if exists place_name_sources;
drop function if exists core_us_states();
drop function if exists core_place_norm(text);
