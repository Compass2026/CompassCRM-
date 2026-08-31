-- Harden functions flagged by the Supabase security linter:
-- pin search_path everywhere and keep trigger/cron functions out of the
-- public RPC surface (triggers still fire; cron calls run as service role).

alter function set_updated_at() set search_path = public;
alter function handle_stage_status_change() set search_path = public;

revoke execute on function handle_pipeline_enrollment() from public, anon, authenticated;
revoke execute on function handle_pipeline_completion() from public, anon, authenticated;
revoke execute on function check_pipeline_completion() from public, anon, authenticated;
revoke execute on function create_monthly_cycles(date) from public, anon, authenticated;
