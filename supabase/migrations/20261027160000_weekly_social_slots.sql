-- Weekly Facebook and Business Profile drafting from the monthly delivery
-- standard's slots (Oct 27 2026). Written with its sandbox test
-- (weekly_social_slots.test.sql). Needs 20261015150000_monthly_delivery_standard
-- and 20261015175410_authority_draft_claims.
--
-- Until now the standard opened 8 Facebook and 8 Business Profile slots per
-- site and month, but nothing drafted them: the weekly beat queued blog slots
-- only, and only for active clients. Every social draft came from a person's
-- session. This adds the same weekly path for social slots, reusing what the
-- blog path already has:
--
--   social_slot_readiness()        one row per standard Facebook / GBP slot in a
--                                  window: ready, or the first reason it is not
--                                  (visible on the planner and in the log).
--   queue_standard_social_tasks()  one CLAUDE task per ready slot, keyed
--                                  social_slot:<slot>; a slot can never get a
--                                  second task (unique index). Forward only: a
--                                  slot dated before this week is not queued.
--   social_slot_claim()            the binding one-hour claim, through the same
--                                  compass.task_claim door as authority_draft_claim.
--   social_slot_link()             after post-drafter's submit: checks the post is
--                                  the governed draft for this slot (client,
--                                  channel, destination, brand, in review, written
--                                  after the task by the claimant) and links it.
--   delivery_queue_log             every queue decision, queued or skipped, with
--                                  its reason: runtime evidence per weekly run.
--
-- Lifecycle is not changed and nothing is published. Readiness, not lifecycle,
-- decides drafting: a launching client whose brand is approved is now queued
-- (blogs and social) exactly like an active one; a client whose brand or
-- destination is missing is skipped with the reason. Publishing still needs
-- Tom's approval, the publisher switch and the pilot list, all untouched.
--
-- Rollback: restore create_weekly_blog_tasks() and tasks_claim_guard() from
-- 20261015150000 / 20261015175410, then drop the five functions, the index and
-- delivery_queue_log.

-- ── 1. Decision log ─────────────────────────────────────────────────────────
create table delivery_queue_log (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  client_id uuid not null references clients(id) on delete cascade,
  plan_item_id uuid references content_plan_items(id) on delete set null,
  deliverable text not null check (deliverable in ('blog_posts', 'facebook_posts', 'gbp_posts')),
  decision text not null check (decision in ('queued', 'skipped')),
  reason text not null check (length(btrim(reason)) between 1 and 300),
  task_id uuid references tasks(id) on delete set null
);
create index delivery_queue_log_client_idx on delivery_queue_log(client_id, run_at desc);
alter table delivery_queue_log enable row level security;
create policy "team delivery queue log" on delivery_queue_log to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on delivery_queue_log from public, anon, authenticated;
grant select on delivery_queue_log to authenticated;
grant select on delivery_queue_log to service_role;

-- ── 2. One task per slot, ever ──────────────────────────────────────────────
create unique index tasks_social_slot_key on tasks(key) where key like 'social\_slot:%';

-- ── 3. Readiness ────────────────────────────────────────────────────────────
-- Brand: the slot's brand site must be approved (multi-brand clients), else
-- the client's brand board. Destination, never inferred:
--   Facebook: the brand site's own Page (multi-brand), else the client's one
--             Facebook row; bound through the publisher (zernio, verified).
--   GBP:      the client's transport is zernio and exactly one verified
--             location is bound (drafter_write's own rule). A location shared
--             by several brand sites serves them all; shared_same_day counts
--             the other open slots on that location and day.
-- Keyword: at least one active keyword with a recorded intent, an approved
-- service of the slot's brand (or client) and an http(s) owner page.
create function social_slot_readiness(p_client_id uuid, p_from date, p_through date)
returns table (
  plan_item_id uuid,
  client_id uuid,
  brand_workspace_id uuid,
  deliverable text,
  channel text,
  planned_date date,
  social_account_id uuid,
  shared_same_day integer,
  ready boolean,
  reason text
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with slots as (
    select i.*, c.status::text as client_status,
           w.status as ws_status, w.facebook_account_id as ws_facebook, w.service_ids as ws_services,
           exists (select 1 from client_brand_workspaces x where x.client_id = i.client_id) as multi
    from content_plan_items i
    join clients c on c.id = i.client_id
    left join client_brand_workspaces w on w.id = i.brand_workspace_id
    where i.client_id = p_client_id and i.standard_key in ('facebook_posts', 'gbp_posts')
      and i.planned_date between p_from and p_through
  ),
  dest as (
    select s.id,
      case
        when s.standard_key = 'facebook_posts' and s.multi then (
          select sa.id from social_accounts sa where sa.id = s.ws_facebook and sa.client_id = s.client_id
            and sa.platform::text = 'facebook' and sa.publish_provider = 'zernio'
            and nullif(btrim(sa.publish_account_id), '') is not null and sa.publish_verified_at is not null)
        when s.standard_key = 'facebook_posts' then (
          select case when count(*) = 1 then (array_agg(sa.id))[1] end from social_accounts sa
           where sa.client_id = s.client_id and sa.platform::text = 'facebook' and sa.publish_provider = 'zernio'
             and nullif(btrim(sa.publish_account_id), '') is not null and sa.publish_verified_at is not null)
        else (
          select case when count(*) = 1 then (array_agg(sa.id))[1] end from social_accounts sa
           where sa.client_id = s.client_id and sa.platform::text = 'google_business' and sa.publish_provider = 'zernio'
             and nullif(btrim(sa.publish_account_id), '') is not null and nullif(btrim(sa.publish_page_id), '') is not null
             and sa.publish_verified_at is not null
             and exists (select 1 from publisher_client_transports t where t.client_id = s.client_id and t.gbp_transport = 'zernio'))
      end as account_id
    from slots s
  )
  select s.id, s.client_id, s.brand_workspace_id, s.standard_key, s.channel::text, s.planned_date, d.account_id,
    (select count(*)::int from slots o where o.standard_key = 'gbp_posts' and s.standard_key = 'gbp_posts'
       and o.id <> s.id and o.planned_date = s.planned_date and o.social_post_id is null and o.hold is null),
    r.reason is null, r.reason
  from slots s join dest d on d.id = s.id
  cross join lateral (select case
    when s.client_status not in ('active', 'launching') then 'Client is ' || s.client_status || '.'
    when s.social_post_id is not null then 'Already linked to a post.'
    when s.hold = 'delivered' then 'Marked delivered.'
    when s.hold = 'blocked' then left('Blocked: ' || coalesce(s.hold_reason, 'no reason given'), 300)
    when exists (select 1 from tasks t where t.key = 'social_slot:' || s.id::text) then 'Already queued.'
    when s.multi and s.brand_workspace_id is null then 'The slot names no brand site.'
    when s.multi and s.ws_status is distinct from 'approved' then 'The brand site''s guidance is not approved.'
    when not s.multi and not exists (select 1 from brand_boards b where b.client_id = s.client_id and b.status = 'approved')
      then 'The brand board is not approved.'
    when d.account_id is null and s.standard_key = 'facebook_posts' then 'No verified Facebook Page is bound for this site.'
    when d.account_id is null then 'No verified Business Profile location is bound for this client.'
    when not exists (
      select 1 from keywords k join services v on v.id = k.service_id and v.client_id = k.client_id
       where k.client_id = s.client_id and k.is_active and k.intent is not null and v.status = 'approved'
         and coalesce(k.target_url, v.page_url) ~ '^https?://\S+$'
         and (not s.multi or v.id = any(s.ws_services)))
      then 'No active keyword with an intent, an approved service and an owner page.'
  end as reason) r
  order by s.planned_date, s.id
$$;
revoke all on function social_slot_readiness(uuid, date, date) from public, anon;
grant execute on function social_slot_readiness(uuid, date, date) to authenticated, service_role;

-- ── 4. Queue ────────────────────────────────────────────────────────────────
-- One task per ready Facebook / GBP slot dated from this week's Monday
-- (America/Chicago) through p_through. Earlier slots stay the month's visible
-- shortfall; they are never drafted late. Every slot in the window is logged.
create function queue_standard_social_tasks(p_client_id uuid, p_through date) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s record; made int := 0; v_task uuid; unit text;
  week date := date_trunc('week', now() at time zone 'America/Chicago')::date;
begin
  perform pg_advisory_xact_lock(hashtextextended('social:' || p_client_id::text, 0));
  for s in select * from social_slot_readiness(p_client_id, week, p_through) loop
    if not s.ready then
      insert into delivery_queue_log (client_id, plan_item_id, deliverable, decision, reason)
      values (p_client_id, s.plan_item_id, s.deliverable, 'skipped', s.reason);
      continue;
    end if;
    v_task := null;
    select coalesce(w.name, c.name) into unit from clients c left join client_brand_workspaces w on w.id = s.brand_workspace_id
     where c.id = p_client_id;
    insert into tasks (client_id, title, owner, status, playbook_step, autonomy_level, key, due_date, notes)
    values (p_client_id,
      left(case s.deliverable when 'facebook_posts' then 'Facebook post' else 'Business Profile post' end
           || ' for ' || unit || ': governed keyword, brand voice, team review', 200),
      'CLAUDE', 'open', 'PB7', 'run_flag', 'social_slot:' || s.plan_item_id::text, s.planned_date,
      'plan_item:' || s.plan_item_id || ' channel:' || s.channel || ' account:' || s.social_account_id
        || ' (monthly delivery standard). Draft one post for ' || unit || ' through post-drafter and link it with social_slot_link.'
        || case when s.shared_same_day > 0
             then ' This Business Profile location has ' || s.shared_same_day || ' other open slot(s) on the same day: choose a different service and topic.'
             else '' end)
    on conflict (key) where key like 'social\_slot:%' do nothing
    returning id into v_task;
    if v_task is null then
      insert into delivery_queue_log (client_id, plan_item_id, deliverable, decision, reason)
      values (p_client_id, s.plan_item_id, s.deliverable, 'skipped', 'Already queued.');
      continue;
    end if;
    insert into delivery_queue_log (client_id, plan_item_id, deliverable, decision, reason, task_id)
    values (p_client_id, s.plan_item_id, s.deliverable, 'queued', 'Ready.', v_task);
    made := made + 1;
  end loop;
  return made;
end $$;
revoke all on function queue_standard_social_tasks(uuid, date) from public, anon, authenticated, service_role;

-- ── 5. Claim ────────────────────────────────────────────────────────────────
-- authority_draft_claim's rule on social_slot tasks: unclaimed, the
-- claimant's own, or claimed over an hour ago. A refusal is an answer.
create function social_slot_claim(p_task_id uuid, p_claimant text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t tasks;
  v_who text := nullif(btrim(coalesce(p_claimant, '')), '');
begin
  if v_who is null or length(v_who) > 80 then
    raise exception 'A claim names its claimant (a short label)' using errcode = '22023';
  end if;
  select * into t from tasks where id = p_task_id for update;
  if t.id is null or t.key not like 'social\_slot:%' then
    raise exception 'No such social slot task' using errcode = 'P0002';
  end if;
  if t.status not in ('open', 'in_progress') then
    return jsonb_build_object('claimed', false, 'reason', 'task_not_open', 'task_status', t.status, 'task_id', t.id);
  end if;
  if t.claimed_by is not null and t.claimed_by <> v_who and t.claimed_at > now() - interval '1 hour' then
    return jsonb_build_object('claimed', false, 'reason', 'claimed_by_other', 'task_id', t.id,
                              'claimed_by', t.claimed_by, 'claimed_at', t.claimed_at, 'expires_at', t.claimed_at + interval '1 hour');
  end if;
  perform set_config('compass.task_claim', 'on', true);
  update tasks set claimed_by = v_who, claimed_at = now(),
         status = case when status = 'open' then 'in_progress' else status end
   where id = t.id
  returning * into t;
  perform set_config('compass.task_claim', '', true);
  return jsonb_build_object('claimed', true, 'task_id', t.id, 'plan_item_id', substring(t.key from 13)::uuid,
                            'claimed_by', t.claimed_by, 'claimed_at', t.claimed_at, 'expires_at', t.claimed_at + interval '1 hour');
end $$;
revoke all on function social_slot_claim(uuid, text) from public, anon, authenticated;
grant execute on function social_slot_claim(uuid, text) to service_role;

create or replace function tasks_claim_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if (tg_op = 'INSERT' and (new.claimed_by is not null or new.claimed_at is not null))
     or (tg_op = 'UPDATE' and (new.claimed_by is distinct from old.claimed_by or new.claimed_at is distinct from old.claimed_at)) then
    if coalesce(current_setting('compass.task_claim', true), '') <> 'on' and not drafter_caller_is_superuser() then
      raise exception 'A task is claimed only through content_draft_claim, authority_draft_claim or social_slot_claim' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function tasks_claim_guard() from public, anon, authenticated;

-- ── 6. Link ─────────────────────────────────────────────────────────────────
-- The post must be the governed draft for exactly this slot: same client and
-- channel, written by post-drafter after the task opened, in review, at the
-- destination readiness chose, for a service of the slot's brand, and linked
-- to no other slot. The claimant must hold the live claim. Then the slot takes
-- the post's keyword, service and intent and the task is done; the post's own
-- review task (0045) is what a person acts on. Nothing is approved here.
create function social_slot_link(p_task_id uuid, p_post_id uuid, p_claimant text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t tasks; i content_plan_items; p social_posts; r record;
  v_who text := nullif(btrim(coalesce(p_claimant, '')), '');
  v_url text;
begin
  select * into t from tasks where id = p_task_id for update;
  if t.id is null or t.key not like 'social\_slot:%' then
    raise exception 'No such social slot task' using errcode = 'P0002';
  end if;
  if t.status = 'done' then
    raise exception 'The social slot task is already done' using errcode = '22023';
  end if;
  if v_who is null or t.claimed_by is distinct from v_who or t.claimed_at <= now() - interval '1 hour' then
    raise exception 'claimed_by_other: claim the task with social_slot_claim before linking' using errcode = 'CD409';
  end if;
  select * into i from content_plan_items where id = substring(t.key from 13)::uuid and client_id = t.client_id for update;
  if i.id is null then
    raise exception 'The slot this task names no longer exists' using errcode = '22023';
  elsif i.social_post_id is not null or i.hold is not null then
    raise exception 'The slot is already linked, blocked or delivered' using errcode = '22023';
  end if;
  select * into p from social_posts where id = p_post_id for update;
  if p.id is null or p.client_id <> t.client_id then
    raise exception 'No such post for this client' using errcode = 'P0002';
  elsif p.platform::text is distinct from i.channel::text then
    raise exception 'The post is for %, the slot is for %', p.platform, i.channel using errcode = '22023';
  elsif p.review_status::text <> 'in_review' or p.drafter_run_id is null or p.created_at < t.created_at then
    raise exception 'Only a governed draft written for this task, still in review, can fill the slot' using errcode = '22023';
  elsif exists (select 1 from content_plan_items x where x.social_post_id = p.id and x.id <> i.id) then
    raise exception 'The post already fills another slot' using errcode = '23505';
  end if;
  select * into r from social_slot_readiness(t.client_id, i.planned_date, i.planned_date) x where x.plan_item_id = i.id;
  if r.social_account_id is null or p.social_account_id is distinct from r.social_account_id then
    raise exception 'The post is not addressed to the slot''s verified destination' using errcode = '22023';
  end if;
  if i.brand_workspace_id is not null and not exists (
       select 1 from client_brand_workspaces w where w.id = i.brand_workspace_id and p.service_id = any(w.service_ids)) then
    raise exception 'The post''s service belongs to another brand site' using errcode = '22023';
  end if;
  select coalesce(case when p.cta_url ~ '^https?://\S+$' then p.cta_url end,
                  case when k.target_url ~ '^https?://\S+$' then k.target_url end,
                  case when v.page_url ~ '^https?://\S+$' then v.page_url end)
    into v_url
    from services v left join keywords k on k.id = p.keyword_id and k.client_id = p.client_id
   where v.id = p.service_id and v.client_id = p.client_id;
  update content_plan_items
     set social_post_id = p.id, keyword_id = coalesce(p.keyword_id, keyword_id), service_id = coalesce(p.service_id, service_id),
         search_intent = coalesce(p.search_intent, search_intent), target_url = coalesce(v_url, target_url)
   where id = i.id;
  update tasks set status = 'done', completed_at = now(),
         recommendation = left('Drafted post ' || p.id || ' into review for this slot.', 500)
   where id = t.id;
  return jsonb_build_object('linked', true, 'plan_item_id', i.id, 'post_id', p.id, 'task_id', t.id,
                            'social_account_id', p.social_account_id, 'review_task_id', p.review_task_id);
end $$;
revoke all on function social_slot_link(uuid, uuid, text) from public, anon, authenticated;
grant execute on function social_slot_link(uuid, uuid, text) to service_role;

-- ── 7. Blog slots from a date ───────────────────────────────────────────────
-- queue_standard_blog_tasks() with a lower bound: a launching client that
-- becomes eligible is queued from this week on, never for the months it was
-- not eligible (no October backlog). Active clients keep the unbounded call.
create function queue_standard_blog_tasks_from(p_client_id uuid, p_from date, p_through date) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; made int := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('blog:'||p_client_id::text,0));
  for s in select i.id, i.planned_date, coalesce(w.name, 'the client') as unit
    from content_plan_items i left join client_brand_workspaces w on w.id = i.brand_workspace_id
    where i.client_id = p_client_id and i.standard_key = 'blog_posts' and i.planned_date between p_from and p_through
      and i.content_post_id is null and i.hold is null
      and not exists (select 1 from content_drafts d where d.plan_item_id = i.id)
      and not exists (select 1 from tasks t where t.client_id = p_client_id and t.key = 'blog_post' and t.notes like '%plan_item:' || i.id::text || '%')
    order by i.planned_date, i.id loop
    insert into tasks(client_id,title,owner,status,playbook_step,autonomy_level,key,due_date,notes)
      values(p_client_id, left('Blog slot for '||s.unit||': governed keyword, sourced article, team review',200),
        'CLAUDE','open','PB7','run_flag','blog_post',s.planned_date,
        'plan_item:'||s.id||' (monthly delivery standard). Choose a keyword and service of '||s.unit||'.');
    made := made + 1;
  end loop;
  return made;
end $$;
revoke all on function queue_standard_blog_tasks_from(uuid, date, date) from public, anon, authenticated, service_role;

-- ── 8. The weekly beat ──────────────────────────────────────────────────────
-- As 20261015150000, with two changes for clients on a standard:
--   * blogs are queued for a launching client whose brand is approved, as for
--     an active one (readiness, not lifecycle), from this week on; others are
--     logged as skipped;
--   * ready Facebook / GBP slots are queued (queue_standard_social_tasks).
-- One fire per client when anything was queued. Clients without a standard
-- run the previous body unchanged.
create or replace function create_weekly_blog_tasks() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; u record; made int:=0; existing int; slots int; n int; opened int; social int; brand_ok boolean;
  week date:=date_trunc('week',now() at time zone 'America/Chicago')::date;
begin
  for c in select cl.id, cl.status from clients cl where cl.status in ('active','launching')
      and ((client_delivery_standard(cl.id, week)).id is not null or (client_delivery_standard(cl.id, week+6)).id is not null)
      order by cl.id loop
    perform pg_advisory_xact_lock(hashtextextended('blog:'||c.id::text,0));
    perform plan_delivery_month(c.id, week);
    if date_trunc('month', week+6) <> date_trunc('month', week) then perform plan_delivery_month(c.id, week+6); end if;
    opened := 0;
    brand_ok := exists (select 1 from brand_boards b where b.client_id = c.id and b.status = 'approved')
             or exists (select 1 from client_brand_workspaces w where w.client_id = c.id and w.status = 'approved');
    if c.status = 'active' then
      opened := queue_standard_blog_tasks(c.id, week+6);
    elsif brand_ok then
      opened := queue_standard_blog_tasks_from(c.id, week, week+6);
    else
      insert into delivery_queue_log (client_id, deliverable, decision, reason)
      values (c.id, 'blog_posts', 'skipped', 'Launching client without an approved brand board or brand site.');
    end if;
    social := queue_standard_social_tasks(c.id, week+6);
    made := made + opened + social;
    if opened + social > 0 then
      perform fire_foundation_worker(c.id,'Weekly drafts: fill this week''s standard blog, Facebook and Business Profile slots for their brand and stop for team review');
    end if;
  end loop;

  for c in select cl.id,cl.name from clients cl where cl.status='active'
      and (client_delivery_standard(cl.id, week)).id is null and (client_delivery_standard(cl.id, week+6)).id is null
      order by cl.id loop
    perform pg_advisory_xact_lock(hashtextextended('blog:'||c.id::text,0));
    select count(*) into existing from tasks where client_id=c.id and key='blog_post'
      and (created_at at time zone 'America/Chicago')::date>=week
      and (created_at at time zone 'America/Chicago')::date<week+7;
    if existing>=2 then continue; end if;
    begin
      select allocation,used,remaining into u from client_quota_usage(c.id) where service_key='blog_posts';
    exception when others then
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason)
        values(c.id,'weekly_blog_post','blog_posts','skipped','entitlements_unavailable');
      continue;
    end;
    if u is null then
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason)
        values(c.id,'weekly_blog_post','blog_posts','skipped','entitlements_unavailable');
      continue;
    end if;
    slots:=least(2-existing,u.remaining);
    if u.allocation=0 or slots<=0 then
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason,allocation,used)
        values(c.id,'weekly_blog_post','blog_posts','skipped',case when u.allocation=0 then 'not_in_agreement' else 'allocation_used' end,u.allocation,u.used);
      continue;
    end if;
    for n in 1..slots loop
      insert into tasks(client_id,title,owner,status,playbook_step,autonomy_level,key,due_date)
        values(c.id,'Blog slot '||(existing+n)||': governed keyword, sourced article, team review',
          'CLAUDE','open','PB7','run_flag','blog_post',week+2+2*(existing+n-1));
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason,allocation,used)
        values(c.id,'weekly_blog_post','blog_posts','created','within_allocation',u.allocation,u.used+n);
      made:=made+1;
    end loop;
    perform fire_foundation_worker(c.id,'Weekly blog drafts: select active governed keywords and stop for team review');
  end loop;
  return made;
end $$;
revoke all on function create_weekly_blog_tasks() from public,anon,authenticated,service_role;

-- ── 9. Postconditions ───────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public.social_slot_claim(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.social_slot_link(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.queue_standard_social_tasks(uuid, date)', 'execute')
     or has_function_privilege('anon', 'public.social_slot_readiness(uuid, date, date)', 'execute') then
    raise exception 'The social slot doors are the worker''s; readiness is the team''s to read';
  end if;
  if has_table_privilege('authenticated', 'public.delivery_queue_log', 'insert')
     or has_table_privilege('anon', 'public.delivery_queue_log', 'select') then
    raise exception 'delivery_queue_log is written only by the queue';
  end if;
  if (select prosrc from pg_proc where oid = 'public.create_weekly_blog_tasks()'::regprocedure) not like '%queue_standard_social_tasks%' then
    raise exception 'The weekly beat does not queue social slots';
  end if;
end $$;
