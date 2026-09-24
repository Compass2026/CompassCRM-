-- Business Profile publisher (Sept 24 2026). Design approved Sept 24; the
-- post record and its human review gate are 0045.
--
-- The post-publisher Edge Function publishes approved, scheduled
-- google_business posts to the client's Business Profile. It writes as the
-- service role through PostgREST, which is the "publisher" identity 0045's
-- triggers recognise; 0045 re-checks the approval fingerprint and grounding
-- when it claims a post (scheduled → publishing). This migration adds only
-- what the function needs around that:
--
-- 1. publisher_runs — one row per thing the publisher did or could not do
--    for a post: published, failed (transient or final), blocked by
--    preflight, lapsed, reconciled against Google, a retry scheduled, a
--    hand-publishing reminder opened / closed. The Publishing block on the
--    Brief and the post page read it. Team reads; nobody writes over the
--    API (the function writes with the service role).
-- 2. app_settings 'publisher' — { enabled: false, clients: [] }: the switch
--    and the pilot list. Off by default; nothing publishes until a person
--    turns it on for named clients.
-- 3. The post-publisher-tick cron job, every 5 minutes. The function does
--    nothing for Business Profile posts while the switch is off; it still
--    opens "post this by hand" tasks for non-Business-Profile posts whose
--    scheduled time has come (those are never published by the publisher).
--
-- Nothing here publishes. Rollback: unschedule post-publisher-tick, drop
-- publisher_runs, delete app_settings 'publisher'.

create table publisher_runs (
  id bigint generated always as identity primary key,
  post_id uuid not null,
  client_id uuid not null,
  mode text not null check (mode in ('tick', 'now', 'sweep', 'retry', 'reminder')),
  outcome text not null check (outcome in (
    'published', 'reconciled', 'failed', 'blocked', 'lapsed', 'retry_scheduled',
    'reminder_opened', 'reminder_closed')),
  transient boolean not null default false,
  http_status int,
  detail text,
  task_id uuid references tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (post_id, client_id) references social_posts (id, client_id) on delete cascade
);
create index publisher_runs_post_idx on publisher_runs (post_id, id desc);
create index publisher_runs_recent_idx on publisher_runs (created_at desc);
-- One hand-publishing reminder per post.
create unique index publisher_runs_one_reminder on publisher_runs (post_id) where outcome = 'reminder_opened';
comment on table publisher_runs is
  'What the Business Profile publisher did or could not do, per post. Written only by the post-publisher function (service role).';

alter table publisher_runs enable row level security;
create policy "team reads publisher runs" on publisher_runs
  for select to authenticated using ((select is_team()));
revoke all on publisher_runs from anon;
revoke insert, update, delete, truncate, references, trigger on publisher_runs from authenticated;

insert into app_settings (key, value)
values ('publisher', jsonb_build_object('enabled', false, 'clients', jsonb_build_array()))
on conflict (key) do nothing;

select cron.schedule(
  'post-publisher-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/post-publisher',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_secret('SUPABASE_ANON_KEY'),
      'x-cron-secret', get_secret('SYNC_CRON_SECRET')
    ),
    body := jsonb_build_object('mode', 'tick'),
    timeout_milliseconds := 60000
  );
  $$
);

-- ── Verify ───────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_policies where tablename = 'publisher_runs'
             and ((qual is not null and qual not like '%is_team()%') or (with_check is not null and with_check not like '%is_team()%'))) then
    raise exception '0046: a publisher_runs policy does not read is_team()';
  end if;
  if has_table_privilege('anon', 'public.publisher_runs', 'select,insert,update,delete')
     or has_table_privilege('authenticated', 'public.publisher_runs', 'insert,update,delete') then
    raise exception '0046: grants on publisher_runs are wider than intended';
  end if;
  if not exists (select 1 from app_settings where key = 'publisher') then
    raise exception '0046: app_settings publisher row missing';
  end if;
  if exists (select 1 from pg_views where viewname like 'portal\_%' and definition ilike '%publisher_runs%') then
    raise exception '0046: a portal view reads publisher_runs';
  end if;
end $$;
