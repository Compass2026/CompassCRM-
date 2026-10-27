-- Weekly Facebook and Business Profile drafting from the monthly delivery
-- standard's slots, grounded in each client's approved core keyword list
-- (Oct 27 2026). Written with its sandbox test (weekly_social_slots.test.sql).
-- Needs 20261015150000_monthly_delivery_standard and
-- 20261015175410_authority_draft_claims.
--
-- Until now the standard opened 8 Facebook and 8 Business Profile slots per
-- site and month, but nothing drafted them: the weekly beat queued blog slots
-- only, and only for active clients. Every social draft came from a person's
-- session. This adds the same weekly path for social slots, reusing what the
-- blog path already has, and makes the client's approved core keyword list
-- (Tom, Oct 27: "the designated approved core 50") the root of everything the
-- weekly path generates:
--
--   core_keyword_lists        versioned, at most 50 keyword ids per client;
--                             proposed → approved only by a signed-in teammate;
--                             an approval supersedes the previous one; never
--                             edited or deleted (a change is a new version).
--   keywords.core_parent_keyword_id
--                             the explicit link from a supporting long-tail
--                             keyword to the core keyword it serves.
--   core_keyword_grounding()  the approved list, its version and the core
--                             keyword a keyword traces to (itself or its parent).
--   core_keyword_links        the evidence: list, version, keyword and core
--                             keyword for every draft the weekly path links.
--   social_slot_readiness()   one row per standard Facebook / GBP slot in a
--                             window: eligibility (ready, or the first reason
--                             it is not) and, separately, the task queued for it.
--   queue_standard_social_tasks()
--                             one CLAUDE task per eligible, unqueued slot this
--                             week, keyed social_slot:<slot> (unique index).
--   social_slot_claim()       the binding one-hour claim for one run's token
--                             (label:run-id); refuses a slot no longer eligible.
--   social_slot_link()        re-checks eligibility and the core grounding, then
--                             links the governed draft and records the evidence.
--   drafter_write             an unattended worker run writes only for a keyword
--                             grounded in the approved core list.
--   content_draft_open_weekly a draft for a standard blog slot needs the same
--                             grounding, and records it.
--   delivery_queue_log        every queue decision with its reason.
--
-- Lifecycle is not changed and nothing is published. Readiness, not lifecycle,
-- decides drafting: a launching client whose brand and core list are approved
-- is queued like an active one. Publishing still needs Tom's approval, the
-- publisher switch and the pilot list, all untouched. No list is created or
-- approved here: proposals are a data step, approval is Tom's.
--
-- Rollback: restore create_weekly_blog_tasks(), tasks_claim_guard(),
-- drafter_write() and content_draft_open_weekly() from their previous
-- definitions (remove the core_keyword_gate_v1 / core_keyword_weekly_v1
-- blocks), then drop the functions, tables, index and column added here.

-- ── 1. Core keyword lists ───────────────────────────────────────────────────
create table core_keyword_lists (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  version integer not null check (version > 0),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'superseded')),
  keyword_ids uuid[] not null check (cardinality(keyword_ids) between 1 and 50),
  source_ref text not null check (length(btrim(source_ref)) between 1 and 500),
  proposed_at timestamptz not null default now(),
  approved_by uuid references team_members(id),
  approved_at timestamptz,
  unique (client_id, version),
  check (status <> 'approved' or (approved_by is not null and approved_at is not null)),
  check (status <> 'proposed' or (approved_by is null and approved_at is null))
);
create unique index core_keyword_lists_one_approved on core_keyword_lists(client_id) where status = 'approved';

create function core_keyword_lists_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if tg_op = 'DELETE' then
    raise exception 'A core keyword list is kept; propose a new version instead' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'proposed' or new.approved_by is not null or new.approved_at is not null then
      raise exception 'A core keyword list starts as a proposal' using errcode = '23514';
    end if;
    select count(distinct k.id) into n from keywords k
     where k.client_id = new.client_id and k.is_active and k.id = any(new.keyword_ids);
    if n <> cardinality(new.keyword_ids) then
      raise exception 'Every core keyword is a distinct, active keyword of this client' using errcode = '23514';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('core-list:' || new.client_id::text, 0));
    select coalesce(max(version), 0) + 1 into new.version from core_keyword_lists where client_id = new.client_id;
    new.proposed_at := now();
    return new;
  end if;
  if (new.id, new.client_id, new.version, new.keyword_ids, new.source_ref, new.proposed_at)
     is distinct from (old.id, old.client_id, old.version, old.keyword_ids, old.source_ref, old.proposed_at) then
    raise exception 'A core keyword list does not change; propose a new version' using errcode = '42501';
  end if;
  if new.status = old.status then
    if (new.approved_by, new.approved_at) is distinct from (old.approved_by, old.approved_at) then
      raise exception 'Approval attribution is not editable' using errcode = '42501';
    end if;
  elsif old.status = 'proposed' and new.status = 'approved' then
    if not post_caller_is_human() then
      raise exception 'Only a signed-in teammate approves a core keyword list' using errcode = '42501';
    end if;
    new.approved_by := task_actor(); new.approved_at := now();
    perform set_config('compass.core_supersede', 'on', true);
    update core_keyword_lists set status = 'superseded'
     where client_id = new.client_id and status = 'approved' and id <> new.id;
    perform set_config('compass.core_supersede', '', true);
  elsif new.status = 'superseded' then
    -- Withdrawn proposal or revoked approval (a teammate), or replaced by a newer approval.
    if not post_caller_is_human() and coalesce(current_setting('compass.core_supersede', true), '') <> 'on' then
      raise exception 'Only a signed-in teammate withdraws or revokes a core keyword list' using errcode = '42501';
    end if;
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
  else
    raise exception 'A core keyword list moves proposed → approved → superseded only' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function core_keyword_lists_guard() from public, anon, authenticated;
create trigger core_keyword_lists_guard before insert or update or delete on core_keyword_lists
  for each row execute function core_keyword_lists_guard();

alter table core_keyword_lists enable row level security;
create policy "team core keyword lists" on core_keyword_lists to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on core_keyword_lists from public, anon, authenticated;
grant select, insert, update on core_keyword_lists to authenticated;
grant select, insert on core_keyword_lists to service_role;

-- A supporting long-tail keyword names the core keyword it serves.
alter table keywords add column core_parent_keyword_id uuid;
alter table keywords add constraint keywords_core_parent_fk
  foreign key (core_parent_keyword_id, client_id) references keywords(id, client_id);
alter table keywords add constraint keywords_core_parent_not_self check (core_parent_keyword_id is distinct from id);

-- The approved list a keyword traces to: itself a member, or its named parent.
create function core_keyword_grounding(p_client_id uuid, p_keyword_id uuid)
returns table (list_id uuid, list_version integer, core_keyword_id uuid)
language sql stable security invoker set search_path = public, pg_temp as $$
  select l.id, l.version, case when k.id = any(l.keyword_ids) then k.id else k.core_parent_keyword_id end
  from core_keyword_lists l
  join keywords k on k.client_id = l.client_id and k.id = p_keyword_id
  where l.client_id = p_client_id and l.status = 'approved'
    and (k.id = any(l.keyword_ids) or k.core_parent_keyword_id = any(l.keyword_ids))
$$;
revoke all on function core_keyword_grounding(uuid, uuid) from public, anon;
grant execute on function core_keyword_grounding(uuid, uuid) to authenticated, service_role;

create table core_keyword_links (
  id bigint generated always as identity primary key,
  client_id uuid not null references clients(id) on delete cascade,
  list_id uuid not null references core_keyword_lists(id),
  list_version integer not null,
  keyword_id uuid not null references keywords(id),
  core_keyword_id uuid not null references keywords(id),
  social_post_id uuid references social_posts(id) on delete cascade,
  content_draft_id uuid references content_drafts(id) on delete cascade,
  change_log_id uuid references change_log(id) on delete cascade,
  plan_item_id uuid references content_plan_items(id) on delete set null,
  linked_at timestamptz not null default now(),
  check (num_nonnulls(social_post_id, content_draft_id, change_log_id) = 1)
);
create index core_keyword_links_client_idx on core_keyword_links(client_id, linked_at desc);
alter table core_keyword_links enable row level security;
create policy "team core keyword links" on core_keyword_links to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on core_keyword_links from public, anon, authenticated;
grant select on core_keyword_links to authenticated, service_role;

-- Records one piece of work against the current approved list, or refuses
-- (22023) when its keyword does not trace to it. Also the worker's door for
-- a website refresh (kind 'change_log').
create function core_keyword_record(p_client_id uuid, p_keyword_id uuid, p_kind text, p_ref uuid, p_plan_item_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare g record;
begin
  if p_kind not in ('social_post', 'content_draft', 'change_log') or p_ref is null then
    raise exception 'Record a social_post, content_draft or change_log' using errcode = '22023';
  end if;
  select * into g from core_keyword_grounding(p_client_id, p_keyword_id);
  if g.list_id is null then
    raise exception 'core_keyword_required: the keyword is not in the approved core keyword list and names no core parent' using errcode = '22023';
  end if;
  insert into core_keyword_links (client_id, list_id, list_version, keyword_id, core_keyword_id,
                                  social_post_id, content_draft_id, change_log_id, plan_item_id)
  values (p_client_id, g.list_id, g.list_version, p_keyword_id, g.core_keyword_id,
          case when p_kind = 'social_post' then p_ref end, case when p_kind = 'content_draft' then p_ref end,
          case when p_kind = 'change_log' then p_ref end, p_plan_item_id);
  return jsonb_build_object('list_id', g.list_id, 'list_version', g.list_version, 'core_keyword_id', g.core_keyword_id);
end $$;
revoke all on function core_keyword_record(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function core_keyword_record(uuid, uuid, text, uuid, uuid) to service_role;

-- ── 2. Decision log ─────────────────────────────────────────────────────────
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

-- ── 3. One task per slot, ever ──────────────────────────────────────────────
create unique index tasks_social_slot_key on tasks(key) where key like 'social\_slot:%';

-- ── 4. Readiness ────────────────────────────────────────────────────────────
-- Eligibility only; queue occupancy is the separate task_id column, so a
-- queued slot whose brand, list or keyword is revoked shows that reason.
-- Brand: the slot's brand site (multi-brand clients), else the board.
-- Destination, never inferred:
--   Facebook: the brand site's own Page (multi-brand), else the client's one
--             Facebook row; bound through the publisher (zernio, verified).
--   GBP:      zernio transport and exactly one verified location (drafter_write's
--             own rule); a location shared by brand sites serves them all and
--             shared_same_day counts the other open slots there that day.
-- Core list: the client's approved core keyword list.
-- Keyword: an active keyword with a recorded intent that traces to the core
-- list (member, or explicit core parent) and whose approved service passes
-- post-drafter's page gate (brief.ts): an https page on the site's host (the
-- brand site's for multi-brand clients) targeted by an approved page group.
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
  core_list_id uuid,
  core_list_version integer,
  task_id uuid,
  ready boolean,
  reason text
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with slots as (
    select i.*, c.status::text as client_status, c.website_url as client_website,
           w.status as ws_status, w.facebook_account_id as ws_facebook, w.service_ids as ws_services, w.website_url as ws_website,
           exists (select 1 from client_brand_workspaces x where x.client_id = i.client_id) as multi,
           l.id as list_id, l.version as list_version, l.keyword_ids as core_ids,
           (select max(p.version) from core_keyword_lists p where p.client_id = i.client_id and p.status = 'proposed') as proposed_version,
           (select t.id from tasks t where t.key = 'social_slot:' || i.id::text) as queued_task
    from content_plan_items i
    join clients c on c.id = i.client_id
    left join client_brand_workspaces w on w.id = i.brand_workspace_id
    left join core_keyword_lists l on l.client_id = i.client_id and l.status = 'approved'
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
    s.list_id, s.list_version, s.queued_task,
    r.reason is null, r.reason
  from slots s join dest d on d.id = s.id
  cross join lateral (select case
    when s.client_status not in ('active', 'launching') then 'Client is ' || s.client_status || '.'
    when s.social_post_id is not null then 'Already linked to a post.'
    when s.hold = 'delivered' then 'Marked delivered.'
    when s.hold = 'blocked' then left('Blocked: ' || coalesce(s.hold_reason, 'no reason given'), 300)
    when s.multi and s.brand_workspace_id is null then 'The slot names no brand site.'
    when s.multi and s.ws_status is distinct from 'approved' then 'The brand site''s guidance is not approved.'
    when not s.multi and not exists (select 1 from brand_boards b where b.client_id = s.client_id and b.status = 'approved')
      then 'The brand board is not approved.'
    when d.account_id is null and s.standard_key = 'facebook_posts' then 'No verified Facebook Page is bound for this site.'
    when d.account_id is null then 'No verified Business Profile location is bound for this client.'
    when s.list_id is null then 'No approved core keyword list'
      || case when s.proposed_version is not null then ' (v' || s.proposed_version || ' proposed, awaiting approval).' else '.' end
    when not exists (
      select 1 from keywords k join services v on v.id = k.service_id and v.client_id = k.client_id
       where k.client_id = s.client_id and k.is_active and k.intent is not null and v.status = 'approved'
         and (k.id = any(s.core_ids) or k.core_parent_keyword_id = any(s.core_ids))
         and v.page_url ~ '^https://\S+$'
         and lower(regexp_replace(substring(v.page_url from '^https?://([^/:?#]+)'), '^www\.', ''))
             = lower(regexp_replace(substring(coalesce(s.ws_website, s.client_website) from '^https?://([^/:?#]+)'), '^www\.', ''))
         and exists (select 1 from page_groups g where g.client_id = v.client_id and g.status = 'approved'
                       and lower(regexp_replace(regexp_replace(g.target_url, '^(https?://)www\.', '\1'), '/+$', ''))
                         = lower(regexp_replace(regexp_replace(v.page_url, '^(https?://)www\.', '\1'), '/+$', '')))
         and (not s.multi or v.id = any(s.ws_services)))
      then 'No core keyword (v' || s.list_version || ') with an intent and an approved service whose owner page is on the site with an approved page group.'
  end as reason) r
  order by s.planned_date, s.id
$$;
revoke all on function social_slot_readiness(uuid, date, date) from public, anon;
grant execute on function social_slot_readiness(uuid, date, date) to authenticated, service_role;

-- ── 5. Queue ────────────────────────────────────────────────────────────────
-- One task per eligible, unqueued Facebook / GBP slot dated from this week's
-- Monday (America/Chicago) through p_through. Earlier slots stay the month's
-- visible shortfall; they are never drafted late. Every slot is logged.
create function queue_standard_social_tasks(p_client_id uuid, p_through date) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s record; made int := 0; v_task uuid; unit text;
  week date := date_trunc('week', now() at time zone 'America/Chicago')::date;
begin
  perform pg_advisory_xact_lock(hashtextextended('social:' || p_client_id::text, 0));
  for s in select * from social_slot_readiness(p_client_id, week, p_through) loop
    if s.task_id is not null or not s.ready then
      insert into delivery_queue_log (client_id, plan_item_id, deliverable, decision, reason, task_id)
      values (p_client_id, s.plan_item_id, s.deliverable, 'skipped',
              case when s.task_id is not null then 'Already queued.' else s.reason end, s.task_id);
      continue;
    end if;
    v_task := null;
    select coalesce(w.name, c.name) into unit from clients c left join client_brand_workspaces w on w.id = s.brand_workspace_id
     where c.id = p_client_id;
    insert into tasks (client_id, title, owner, status, playbook_step, autonomy_level, key, due_date, notes)
    values (p_client_id,
      left(case s.deliverable when 'facebook_posts' then 'Facebook post' else 'Business Profile post' end
           || ' for ' || unit || ': core keyword, brand voice, team review', 200),
      'CLAUDE', 'open', 'PB7', 'run_flag', 'social_slot:' || s.plan_item_id::text, s.planned_date,
      'plan_item:' || s.plan_item_id || ' channel:' || s.channel || ' account:' || s.social_account_id
        || ' core_list:' || s.core_list_id || ' v' || s.core_list_version
        || ' (monthly delivery standard). Draft one post for ' || unit
        || ' on a keyword of the approved core list (or its named long-tail child) through post-drafter and link it with social_slot_link.'
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
    values (p_client_id, s.plan_item_id, s.deliverable, 'queued', 'Ready (core list v' || s.core_list_version || ').', v_task);
    made := made + 1;
  end loop;
  return made;
end $$;
revoke all on function queue_standard_social_tasks(uuid, date) from public, anon, authenticated, service_role;

-- ── 6. Claim ────────────────────────────────────────────────────────────────
-- A claimant is one run's token, '<label>:<run id>' (8–64 of [A-Za-z0-9_-]):
-- the same on that run's retries, different for every run, so two sessions
-- never share a claim. authority_draft_claim's rule otherwise: unclaimed, this
-- exact token's own, or claimed over an hour ago. A slot that is no longer
-- eligible (its own queued task aside) is not claimed and the reason returned.
create function social_slot_claimant_ok(p_claimant text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select coalesce(p_claimant ~ '^[a-z][a-z0-9-]{1,39}:[A-Za-z0-9_-]{8,64}$', false)
$$;
revoke all on function social_slot_claimant_ok(text) from public, anon;
grant execute on function social_slot_claimant_ok(text) to authenticated, service_role;

create function social_slot_claim(p_task_id uuid, p_claimant text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t tasks; i content_plan_items; r record;
  v_who text := btrim(coalesce(p_claimant, ''));
begin
  if not social_slot_claimant_ok(v_who) then
    raise exception 'A claim names this run''s token, <label>:<run id> (for example worker-routine:<uuid>)' using errcode = '22023';
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
  select * into i from content_plan_items where id = substring(t.key from 13)::uuid and client_id = t.client_id;
  select * into r from social_slot_readiness(t.client_id, i.planned_date, i.planned_date) x where x.plan_item_id = i.id;
  if i.id is null or not coalesce(r.ready, false) then
    return jsonb_build_object('claimed', false, 'reason', 'not_ready', 'task_id', t.id,
                              'detail', coalesce(r.reason, 'The slot this task names no longer exists.'));
  end if;
  perform set_config('compass.task_claim', 'on', true);
  update tasks set claimed_by = v_who, claimed_at = now(),
         status = case when status = 'open' then 'in_progress' else status end
   where id = t.id
  returning * into t;
  perform set_config('compass.task_claim', '', true);
  return jsonb_build_object('claimed', true, 'task_id', t.id, 'plan_item_id', i.id,
                            'social_account_id', r.social_account_id, 'core_list_id', r.core_list_id, 'core_list_version', r.core_list_version,
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

-- ── 7. Link ─────────────────────────────────────────────────────────────────
-- The live claimant only. Eligibility is re-checked now (brand, destination,
-- core list), not trusted from the queue. The post must be the governed draft
-- for exactly this slot: same client and channel, written by post-drafter
-- after the task opened, in review, at the slot's destination, for a service
-- of the slot's brand, on a keyword that traces to the current approved core
-- list (whatever version was current at queue time), and linked to no other
-- slot. The slot takes the post's keyword, service, intent and owner page;
-- core_keyword_links records list, version and core keyword; the task is
-- done. Nothing is approved here.
create function social_slot_link(p_task_id uuid, p_post_id uuid, p_claimant text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t tasks; i content_plan_items; p social_posts; r record; g jsonb;
  v_who text := btrim(coalesce(p_claimant, ''));
  v_url text;
begin
  select * into t from tasks where id = p_task_id for update;
  if t.id is null or t.key not like 'social\_slot:%' then
    raise exception 'No such social slot task' using errcode = 'P0002';
  end if;
  if t.status = 'done' then
    raise exception 'The social slot task is already done' using errcode = '22023';
  end if;
  if not social_slot_claimant_ok(v_who) or t.claimed_by is distinct from v_who or t.claimed_at <= now() - interval '1 hour' then
    raise exception 'claimed_by_other: claim the task with this run''s token before linking' using errcode = 'CD409';
  end if;
  select * into i from content_plan_items where id = substring(t.key from 13)::uuid and client_id = t.client_id for update;
  if i.id is null then
    raise exception 'The slot this task names no longer exists' using errcode = '22023';
  end if;
  select * into r from social_slot_readiness(t.client_id, i.planned_date, i.planned_date) x where x.plan_item_id = i.id;
  if not coalesce(r.ready, false) then
    raise exception 'not_ready: %', coalesce(r.reason, 'the slot is no longer eligible') using errcode = '22023';
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
  if p.social_account_id is distinct from r.social_account_id then
    raise exception 'The post is not addressed to the slot''s verified destination' using errcode = '22023';
  end if;
  if i.brand_workspace_id is not null and not exists (
       select 1 from client_brand_workspaces w where w.id = i.brand_workspace_id and p.service_id = any(w.service_ids)) then
    raise exception 'The post''s service belongs to another brand site' using errcode = '22023';
  end if;
  g := core_keyword_record(t.client_id, p.keyword_id, 'social_post', p.id, i.id);
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
         recommendation = left('Drafted post ' || p.id || ' into review for this slot (core list v' || (g->>'list_version') || ').', 500)
   where id = t.id;
  return jsonb_build_object('linked', true, 'plan_item_id', i.id, 'post_id', p.id, 'task_id', t.id,
                            'social_account_id', p.social_account_id, 'review_task_id', p.review_task_id) || g;
end $$;
revoke all on function social_slot_link(uuid, uuid, text) from public, anon, authenticated;
grant execute on function social_slot_link(uuid, uuid, text) to service_role;

-- ── 8. Unattended drafts write only core keywords ───────────────────────────
-- drafter_write is patched in place (as 20261015010350 and 20261015175410 did).
-- A worker run's claimant is 'worker-routine:<run id>'; its write is refused
-- (check_violation, nothing written) unless the brief's keyword traces to the
-- client's approved core list. Teammate and operator drafting are unchanged.
do $migration$
declare
  definition text := pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
  anchor text := $anchor$  -- Claims: only ones the brief allowed.
$anchor$;
  gate text := $gate$  -- core_keyword_gate_v1: unattended runs write only core-grounded keywords.
  if coalesce(p->>'claimant', '') like 'worker-routine:%' and not exists (
       select 1 from core_keyword_grounding(v_client, nullif(v_target->'keyword'->>'id', '')::uuid)) then
    raise exception 'core_keyword_required: an unattended draft needs a keyword of the approved core keyword list (or its named long-tail child)'
      using errcode = 'check_violation';
  end if;
$gate$;
begin
  if strpos(definition, 'core_keyword_gate_v1') > 0 then return; end if;
  if strpos(definition, 'drafter_gbp_destination_v1') = 0 or strpos(definition, 'authority_draft_claims_v1') = 0
     or (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) then
    raise exception 'Unexpected drafter_write definition; review before applying the core keyword gate';
  end if;
  execute replace(definition, anchor, gate || anchor);
end;
$migration$;

-- ── 9. Weekly blog drafts for a named slot trace to the core list ───────────
do $migration$
declare
  definition text := pg_get_functiondef('public.content_draft_open_weekly(jsonb)'::regprocedure);
  a1 text := $a1$    raise exception 'Choose an active governed keyword before generating this item' using errcode = '22023';
  end if;
$a1$;
  g1 text := $g1$  -- core_keyword_weekly_v1: a standard slot's draft needs a core-grounded keyword.
  if substring(coalesce(t.notes, '') from 'plan_item:([0-9a-f-]{36})') is not null and not exists (
       select 1 from core_keyword_grounding(t.client_id, nullif(p->>'keyword_id', '')::uuid)) then
    raise exception 'core_keyword_required: choose a keyword of the approved core keyword list (or its named long-tail child)'
      using errcode = '22023';
  end if;
$g1$;
  a2 text := $a2$  update tasks set status = 'in_progress' where id = t.id and status = 'open';
$a2$;
  g2 text := $g2$  if v_slot is not null then
    perform core_keyword_record(t.client_id, d.keyword_id, 'content_draft', d.id, i.id);
  end if;
$g2$;
begin
  if strpos(definition, 'core_keyword_weekly_v1') > 0 then return; end if;
  if (length(definition) - length(replace(definition, a1, ''))) <> length(a1)
     or (length(definition) - length(replace(definition, a2, ''))) <> length(a2)
     or strpos(definition, 'v_slot := substring') = 0 then
    raise exception 'Unexpected content_draft_open_weekly definition; review before applying the core keyword gate';
  end if;
  execute replace(replace(definition, a1, a1 || g1), a2, g2 || a2);
end;
$migration$;

-- ── 10. Blog slots from a date ──────────────────────────────────────────────
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

-- ── 11. The weekly beat ─────────────────────────────────────────────────────
-- As 20261015150000, with these changes for clients on a standard:
--   * blogs are queued only when the client's core keyword list is approved
--     (the drafted keyword must trace to it, section 9);
--   * a launching client whose brand is approved is queued like an active one
--     (readiness, not lifecycle), from this week on;
--   * ready Facebook / GBP slots are queued (queue_standard_social_tasks).
-- Skips are logged with their reason. One fire per client when anything was
-- queued. Clients without a standard run the previous body unchanged.
create or replace function create_weekly_blog_tasks() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; u record; made int:=0; existing int; slots int; n int; opened int; social int; brand_ok boolean; core_ok boolean;
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
    core_ok := exists (select 1 from core_keyword_lists l where l.client_id = c.id and l.status = 'approved');
    if not core_ok then
      insert into delivery_queue_log (client_id, deliverable, decision, reason)
      values (c.id, 'blog_posts', 'skipped', 'No approved core keyword list.');
    elsif c.status = 'active' then
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
      perform fire_foundation_worker(c.id,'Weekly drafts: fill this week''s standard blog, Facebook and Business Profile slots from the core keywords and stop for team review');
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

-- ── 12. Postconditions ──────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public.social_slot_claim(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.social_slot_link(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.queue_standard_social_tasks(uuid, date)', 'execute')
     or has_function_privilege('authenticated', 'public.core_keyword_record(uuid, uuid, text, uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.social_slot_readiness(uuid, date, date)', 'execute')
     or has_function_privilege('anon', 'public.core_keyword_grounding(uuid, uuid)', 'execute') then
    raise exception 'The social slot and core keyword doors are the worker''s; readiness and grounding are the team''s to read';
  end if;
  if has_table_privilege('authenticated', 'public.delivery_queue_log', 'insert')
     or has_table_privilege('authenticated', 'public.core_keyword_links', 'insert')
     or has_table_privilege('anon', 'public.core_keyword_lists', 'select') then
    raise exception 'Logs and links are written only by their functions; lists are team-only';
  end if;
  if (select prosrc from pg_proc where oid = 'public.create_weekly_blog_tasks()'::regprocedure) not like '%queue_standard_social_tasks%'
     or (select prosrc from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure) not like '%core_keyword_gate_v1%'
     or (select prosrc from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure) not like '%authority_draft_claims_v1%'
     or (select prosrc from pg_proc where oid = 'public.content_draft_open_weekly(jsonb)'::regprocedure) not like '%core_keyword_weekly_v1%' then
    raise exception 'A core keyword gate or the weekly social queue is missing';
  end if;
end $$;
