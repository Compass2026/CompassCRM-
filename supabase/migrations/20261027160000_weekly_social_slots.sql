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
-- One list per SITE PROGRAM: the client for a single-site client
-- (brand_workspace_id null), each brand site for a multi-brand client (BHG:
-- Safety, Forklift and Heavy Equipment, 50 each, Tom Oct 27). Versions and
-- the one-approved rule are per program; a site's keywords are only those
-- whose service that site owns. Locations are not programs: they are the
-- destination layer (GBP location per slot) on top of the site's list.
create table core_keyword_lists (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  brand_workspace_id uuid references client_brand_workspaces(id),
  version integer not null check (version > 0),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'superseded')),
  keyword_ids uuid[] not null check (cardinality(keyword_ids) between 1 and 50),
  source_ref text not null check (length(btrim(source_ref)) between 1 and 500),
  proposed_at timestamptz not null default now(),
  approved_by uuid references team_members(id),
  approved_at timestamptz,
  check (status <> 'approved' or (approved_by is not null and approved_at is not null)),
  check (status <> 'proposed' or (approved_by is null and approved_at is null))
);
create unique index core_keyword_lists_program_version on core_keyword_lists
  (client_id, coalesce(brand_workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), version);
create unique index core_keyword_lists_one_approved on core_keyword_lists
  (client_id, coalesce(brand_workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status = 'approved';

create function core_keyword_lists_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; multi boolean; ws client_brand_workspaces;
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
    multi := exists (select 1 from client_brand_workspaces w where w.client_id = new.client_id);
    if multi and new.brand_workspace_id is null then
      raise exception 'A multi-brand client''s core list names its brand site' using errcode = '23514';
    elsif not multi and new.brand_workspace_id is not null then
      raise exception 'A single-site client''s core list names no brand site' using errcode = '23514';
    end if;
    if multi then
      select * into ws from client_brand_workspaces where id = new.brand_workspace_id and client_id = new.client_id;
      if ws.id is null then
        raise exception 'The brand site belongs to another client' using errcode = '23514';
      end if;
      if exists (select 1 from keywords k where k.id = any(new.keyword_ids)
                  and (k.service_id is null or not (k.service_id = any(ws.service_ids)))) then
        raise exception 'Every core keyword of % is for a service of that site', ws.name using errcode = '23514';
      end if;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('core-list:' || new.client_id::text, 0));
    select coalesce(max(version), 0) + 1 into new.version from core_keyword_lists
     where client_id = new.client_id and brand_workspace_id is not distinct from new.brand_workspace_id;
    new.proposed_at := now();
    return new;
  end if;
  if (new.id, new.client_id, new.brand_workspace_id, new.version, new.keyword_ids, new.source_ref, new.proposed_at)
     is distinct from (old.id, old.client_id, old.brand_workspace_id, old.version, old.keyword_ids, old.source_ref, old.proposed_at) then
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
    -- Exactly 50 valid keywords, judged now (not at proposal): distinct,
    -- active, with a recorded intent, and for a brand site a service that
    -- site owns. An incomplete list stays a visible proposal.
    select count(distinct k.id) into n from keywords k
     where k.id = any(new.keyword_ids) and k.client_id = new.client_id and k.is_active and k.intent is not null
       and (new.brand_workspace_id is null or exists (
             select 1 from client_brand_workspaces w where w.id = new.brand_workspace_id and k.service_id = any(w.service_ids)));
    if cardinality(new.keyword_ids) <> 50 or n <> 50 then
      raise exception 'core_list_incomplete: a core keyword list is approved with exactly 50 valid keywords (active, intent recorded, the site''s own services); this one has % valid of %',
        n, cardinality(new.keyword_ids) using errcode = '23514';
    end if;
    new.approved_by := task_actor(); new.approved_at := now();
    perform set_config('compass.core_supersede', 'on', true);
    update core_keyword_lists set status = 'superseded'
     where client_id = new.client_id and brand_workspace_id is not distinct from new.brand_workspace_id
       and status = 'approved' and id <> new.id;
    perform set_config('compass.core_supersede', '', true);
    -- Weekly rank tracking follows the approved site lists: the union of
    -- this client's approved lists (this one included). Nothing is deleted.
    update keywords k set is_tracked = (k.id = any(new.keyword_ids) or exists (
             select 1 from core_keyword_lists l where l.client_id = new.client_id and l.status = 'approved'
               and l.id <> new.id and l.brand_workspace_id is distinct from new.brand_workspace_id and k.id = any(l.keyword_ids)))
     where k.client_id = new.client_id and k.is_active;
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

-- The approved list an ACTIVE keyword traces to: itself a member, or its
-- named parent when that parent is active and a member. Evidence already
-- recorded in core_keyword_links is history and is never re-read through this.
create function core_keyword_grounding(p_client_id uuid, p_keyword_id uuid)
returns table (list_id uuid, list_version integer, core_keyword_id uuid)
language sql stable security invoker set search_path = public, pg_temp as $$
  -- The keyword's program: the brand site that owns its service (multi-brand
  -- clients), else the client. Only that program's approved list counts, so
  -- a keyword of one BHG site never qualifies through another site's list.
  with k as (
    select k.id, k.core_parent_keyword_id,
           case when exists (select 1 from client_brand_workspaces x where x.client_id = k.client_id)
                then (select w.id from client_brand_workspaces w where w.client_id = k.client_id and k.service_id = any(w.service_ids)) end as program,
           exists (select 1 from client_brand_workspaces x where x.client_id = k.client_id) as multi
    from keywords k where k.id = p_keyword_id and k.client_id = p_client_id and k.is_active
  )
  select l.id, l.version, case when k.id = any(l.keyword_ids) then k.id else pk.id end
  from k
  join core_keyword_lists l on l.client_id = p_client_id and l.status = 'approved'
   and l.brand_workspace_id is not distinct from k.program and (not k.multi or k.program is not null)
  left join keywords pk on pk.id = k.core_parent_keyword_id and pk.client_id = p_client_id and pk.is_active
  where k.id = any(l.keyword_ids) or pk.id = any(l.keyword_ids)
$$;
revoke all on function core_keyword_grounding(uuid, uuid) from public, anon;
grant execute on function core_keyword_grounding(uuid, uuid) to authenticated, service_role;

-- Is THIS keyword (with this service, when a post names one) usable for a
-- weekly draft of this site right now? null = yes, else the first reason:
--   keyword_not_eligible: inactive / another client's, no recorded intent,
--     the post's service is not the keyword's, the service is not approved,
--     its owner page fails post-drafter's page gate (https, on the site's
--     host — the brand site's for multi-brand clients — with an approved
--     page group), or the service belongs to another brand site;
--   core_keyword_required: it does not trace to the approved core list.
-- Readiness asks it for every keyword; the link asks it for the post's own
-- keyword and service, so another usable keyword never vouches for a post.
create function core_keyword_eligibility(p_client_id uuid, p_brand_workspace_id uuid, p_keyword_id uuid, p_service_id uuid default null)
returns text
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare k keywords; v services; site text; ws client_brand_workspaces; norm_page text;
begin
  select * into k from keywords where id = p_keyword_id and client_id = p_client_id;
  if k.id is null or not k.is_active then return 'keyword_not_eligible: the keyword is inactive or not this client''s.'; end if;
  if not exists (select 1 from core_keyword_grounding(p_client_id, p_keyword_id)) then
    return 'core_keyword_required: the keyword is not in the approved core keyword list and names no active core parent.';
  end if;
  if k.intent is null then return 'keyword_not_eligible: the keyword has no recorded intent.'; end if;
  if p_service_id is not null and p_service_id is distinct from k.service_id then
    return 'keyword_not_eligible: the post''s service is not the keyword''s service.';
  end if;
  select * into v from services where id = k.service_id and client_id = p_client_id;
  if v.id is null or v.status::text <> 'approved' then return 'keyword_not_eligible: the keyword''s service is not approved.'; end if;
  if p_brand_workspace_id is not null then
    select * into ws from client_brand_workspaces where id = p_brand_workspace_id and client_id = p_client_id;
    if ws.id is null or not (v.id = any(ws.service_ids)) then
      return 'keyword_not_eligible: the keyword''s service belongs to another brand site.';
    end if;
    site := ws.website_url;
  else
    select website_url into site from clients where id = p_client_id;
  end if;
  norm_page := lower(regexp_replace(regexp_replace(v.page_url, '^(https?://)www\.', '\1'), '/+$', ''));
  if v.page_url is null or v.page_url !~ '^https://\S+$'
     or lower(regexp_replace(substring(v.page_url from '^https?://([^/:?#]+)'), '^www\.', ''))
        is distinct from lower(regexp_replace(substring(site from '^https?://([^/:?#]+)'), '^www\.', ''))
     or not exists (select 1 from page_groups g where g.client_id = p_client_id and g.status = 'approved'
                      and lower(regexp_replace(regexp_replace(g.target_url, '^(https?://)www\.', '\1'), '/+$', '')) = norm_page) then
    return 'keyword_not_eligible: the service''s owner page is not on the site with an approved page group.';
  end if;
  return null;
end $$;
revoke all on function core_keyword_eligibility(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function core_keyword_eligibility(uuid, uuid, uuid, uuid) to authenticated, service_role;

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

-- The site program a service belongs to: the brand site owning it for a
-- multi-brand client (null when none does), the client (null) otherwise.
create function core_site_of_service(p_client_id uuid, p_service_id uuid) returns uuid
language sql stable security invoker set search_path = public, pg_temp as $$
  select w.id from client_brand_workspaces w where w.client_id = p_client_id and p_service_id = any(w.service_ids)
$$;
revoke all on function core_site_of_service(uuid, uuid) from public, anon;
grant execute on function core_site_of_service(uuid, uuid) to authenticated, service_role;

-- Approved markets per Business Profile location: the cities a location may
-- carry location-specific content for. 'office' (its own city), 'service_area'
-- (a city it serves) or 'all' (a shared headquarters profile that serves every
-- market of the client, e.g. BHG's Hannibal profile). Team-managed records,
-- each with its source; nothing here binds, unholds or edits a profile.
create table gbp_location_markets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  social_account_id uuid not null references social_accounts(id) on delete cascade,
  market text not null check (length(btrim(market)) between 1 and 120),
  kind text not null check (kind in ('office', 'service_area', 'all')),
  source_ref text not null check (length(btrim(source_ref)) between 1 and 500),
  created_at timestamptz not null default now()
);
create unique index gbp_location_markets_key on gbp_location_markets (social_account_id, lower(btrim(market)));
create function gbp_location_markets_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from social_accounts sa where sa.id = new.social_account_id and sa.client_id = new.client_id
                  and sa.platform::text = 'google_business') then
    raise exception 'A market belongs to one of this client''s Business Profile locations' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function gbp_location_markets_guard() from public, anon, authenticated;
create trigger gbp_location_markets_guard before insert or update on gbp_location_markets
  for each row execute function gbp_location_markets_guard();
alter table gbp_location_markets enable row level security;
create policy "team gbp location markets" on gbp_location_markets to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on gbp_location_markets from public, anon, authenticated;
grant select, insert, update, delete on gbp_location_markets to authenticated;
grant select on gbp_location_markets to service_role;

-- Is a keyword's market right for this destination? null = yes. Only a
-- Business Profile destination and a keyword that names a city are judged:
-- the city must be one of the location's approved markets, unless the
-- location serves 'all'. A client with one location and no market records
-- keeps today's behaviour; with several locations, a city keyword needs the
-- location's markets recorded. Facebook Pages are not market-bound.
create function core_market_problem(p_client_id uuid, p_account_id uuid, p_keyword_id uuid) returns text
language sql stable security invoker set search_path = public, pg_temp as $$
  select case
    when sa.id is null or k.city is null or btrim(k.city) = '' then null
    when exists (select 1 from gbp_location_markets m where m.social_account_id = sa.id and m.kind = 'all') then null
    when exists (select 1 from gbp_location_markets m where m.social_account_id = sa.id
                  and lower(btrim(m.market)) = lower(btrim(k.city))) then null
    when not exists (select 1 from gbp_location_markets m where m.social_account_id = sa.id)
     and (select count(*) from social_accounts x where x.client_id = p_client_id and x.platform::text = 'google_business'
            and x.publish_verified_at is not null) <= 1 then null
    else 'market_not_applicable: ' || k.city || ' is not an approved market of the Business Profile location ' || coalesce(sa.display_name, sa.publish_page_id, sa.id::text) || '.'
  end
  from keywords k
  left join social_accounts sa on sa.id = p_account_id and sa.client_id = p_client_id and sa.platform::text = 'google_business'
  where k.id = p_keyword_id and k.client_id = p_client_id
$$;
revoke all on function core_market_problem(uuid, uuid, uuid) from public, anon;
grant execute on function core_market_problem(uuid, uuid, uuid) to authenticated, service_role;

-- An explicit exception Tom grants (the review allowed one): a client exempt
-- from the core-keyword gates on manual / nonstandard / refresh paths. Only a
-- signed-in team admin grants or revokes it, with a reason; production starts
-- with none. The weekly queue never uses it: it always needs approved lists.
create table core_keyword_exemptions (
  client_id uuid primary key references clients(id) on delete cascade,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  granted_by uuid references team_members(id),
  granted_at timestamptz not null default now()
);
create function core_keyword_exemptions_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (post_caller_is_human() and is_team_admin()) then
    raise exception 'Only a signed-in team admin grants or revokes a core keyword exemption' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.granted_by := task_actor(); new.granted_at := now();
  return new;
end $$;
revoke all on function core_keyword_exemptions_guard() from public, anon, authenticated;
create trigger core_keyword_exemptions_guard before insert or update or delete on core_keyword_exemptions
  for each row execute function core_keyword_exemptions_guard();
alter table core_keyword_exemptions enable row level security;
create policy "team core keyword exemptions" on core_keyword_exemptions to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on core_keyword_exemptions from public, anon, authenticated;
grant select, insert, delete on core_keyword_exemptions to authenticated;
grant select on core_keyword_exemptions to service_role;

create function core_keyword_exempt(p_client_id uuid) returns boolean
language sql stable security invoker set search_path = public, pg_temp as $$
  select exists (select 1 from core_keyword_exemptions e where e.client_id = p_client_id)
$$;
revoke all on function core_keyword_exempt(uuid) from public, anon;
grant execute on function core_keyword_exempt(uuid) to authenticated, service_role;

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
           (select max(p.version) from core_keyword_lists p where p.client_id = i.client_id and p.status = 'proposed'
               and p.brand_workspace_id is not distinct from i.brand_workspace_id) as proposed_version,
           (select t.id from tasks t where t.key = 'social_slot:' || i.id::text) as queued_task
    from content_plan_items i
    join clients c on c.id = i.client_id
    left join client_brand_workspaces w on w.id = i.brand_workspace_id
    left join core_keyword_lists l on l.client_id = i.client_id and l.status = 'approved'
          and l.brand_workspace_id is not distinct from i.brand_workspace_id
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
        -- Business Profile: the location the slot names (20261027150000), which
        -- must be one of this client's verified Zernio locations; with none
        -- named, the client's only location. Never another location.
        when s.gbp_location_id is not null then (
          select sa.id from social_accounts sa where sa.id = s.gbp_location_id and sa.client_id = s.client_id
            and sa.platform::text = 'google_business' and sa.publish_provider = 'zernio'
            and nullif(btrim(sa.publish_account_id), '') is not null and nullif(btrim(sa.publish_page_id), '') is not null
            and sa.publish_verified_at is not null
            and exists (select 1 from publisher_client_transports t where t.client_id = s.client_id and t.gbp_transport = 'zernio'))
        else (
          select case when count(*) = 1 then (array_agg(sa.id))[1] end from social_accounts sa
           where sa.client_id = s.client_id and sa.platform::text = 'google_business' and sa.publish_provider = 'zernio'
             and nullif(btrim(sa.publish_account_id), '') is not null and nullif(btrim(sa.publish_page_id), '') is not null
             and sa.publish_verified_at is not null
             and exists (select 1 from publisher_client_transports t where t.client_id = s.client_id and t.gbp_transport = 'zernio'))
      end as account_id,
      (select count(*) from social_accounts sa where sa.client_id = s.client_id and sa.platform::text = 'google_business'
         and sa.publish_provider = 'zernio' and sa.publish_verified_at is not null) as gbp_locations
    from slots s
  )
  select s.id, s.client_id, s.brand_workspace_id, s.standard_key, s.channel::text, s.planned_date, d.account_id,
    (select count(*)::int from slots o where o.standard_key = 'gbp_posts' and s.standard_key = 'gbp_posts'
       and o.id <> s.id and o.planned_date = s.planned_date and o.social_post_id is null and o.hold is null
       and o.gbp_location_id is not distinct from s.gbp_location_id),
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
    when d.account_id is null and s.gbp_location_id is null and d.gbp_locations > 1
      then 'Choose this slot''s Business Profile location (the client has ' || d.gbp_locations || ' verified locations).'
    when d.account_id is null and s.gbp_location_id is not null then 'The slot''s Business Profile location is not a verified location of this client.'
    when d.account_id is null then 'No verified Business Profile location is bound for this client.'
    when s.list_id is null then 'No approved core keyword list'
      || case when s.proposed_version is not null then ' (v' || s.proposed_version || ' proposed, awaiting approval).' else '.' end
    when not exists (
      select 1 from keywords k
       where k.client_id = s.client_id and k.is_active
         and core_keyword_eligibility(s.client_id, case when s.multi then s.brand_workspace_id end, k.id) is null)
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
  v_url text; v_problem text;
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
  -- The post's own keyword and service, judged now: another usable core
  -- keyword never vouches for it.
  v_problem := core_keyword_eligibility(t.client_id, i.brand_workspace_id, p.keyword_id, p.service_id);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  v_problem := core_market_problem(t.client_id, p.social_account_id, p.keyword_id);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  -- Evidence for the current approved version (the review gate recorded it on
  -- entry; a newer version since then gets its own row).
  select jsonb_build_object('list_id', x.list_id, 'list_version', x.list_version, 'core_keyword_id', x.core_keyword_id) into g
    from core_keyword_grounding(t.client_id, p.keyword_id) x;
  if not exists (select 1 from core_keyword_links c where c.social_post_id = p.id
                  and c.list_id = (g->>'list_id')::uuid and c.list_version = (g->>'list_version')::int) then
    g := core_keyword_record(t.client_id, p.keyword_id, 'social_post', p.id, i.id);
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
  gate text := $gate$  -- core_keyword_gate_v1: every draft (worker, operator or teammate) is for a
  -- keyword of its target site's approved core list, with that keyword's own
  -- service, page and site; no approved list (absent, proposed or revoked) → refused.
  declare v_core_problem text := core_keyword_eligibility(v_client, core_site_of_service(v_client, v_service),
                                                          nullif(v_target->'keyword'->>'id', '')::uuid, v_service);
  begin
    if core_keyword_exempt(v_client) and coalesce(p->>'claimant', '') not like 'worker-routine:%' then
      null;  -- Tom's recorded exception; unattended runs are never exempt
    elsif nullif(v_target->'keyword'->>'id', '') is null then
      raise exception 'core_keyword_required: a draft names a keyword of its site''s approved core keyword list' using errcode = 'check_violation';
    elsif v_core_problem is not null then
      raise exception '%', v_core_problem using errcode = 'check_violation';
    end if;
  end;
$gate$;
begin
  if strpos(definition, 'core_keyword_gate_v1') > 0 then return; end if;
  if (strpos(definition, 'drafter_gbp_destination_v1') = 0 and strpos(definition, 'drafter_gbp_destination_v2') = 0)
     or strpos(definition, 'authority_draft_claims_v1') = 0
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

-- ── 10. Blog slots of one site ─────────────────────────────────────────────
-- queue_standard_blog_tasks() for one site program (p_site: the brand site,
-- or null for a single-site client) and, optionally, from a date: a launching
-- client that becomes eligible is queued from this week on (no backlog).
create function queue_standard_blog_tasks_site(p_client_id uuid, p_site uuid, p_from date, p_through date) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; made int := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('blog:'||p_client_id::text,0));
  for s in select i.id, i.planned_date, coalesce(w.name, 'the client') as unit
    from content_plan_items i left join client_brand_workspaces w on w.id = i.brand_workspace_id
    where i.client_id = p_client_id and i.standard_key = 'blog_posts'
      and i.brand_workspace_id is not distinct from p_site
      and (p_from is null or i.planned_date >= p_from) and i.planned_date <= p_through
      and i.content_post_id is null and i.hold is null
      and not exists (select 1 from content_drafts d where d.plan_item_id = i.id)
      and not exists (select 1 from tasks t where t.client_id = p_client_id and t.key = 'blog_post' and t.notes like '%plan_item:' || i.id::text || '%')
    order by i.planned_date, i.id loop
    insert into tasks(client_id,title,owner,status,playbook_step,autonomy_level,key,due_date,notes)
      values(p_client_id, left('Blog slot for '||s.unit||': core keyword, sourced article, team review',200),
        'CLAUDE','open','PB7','run_flag','blog_post',s.planned_date,
        'plan_item:'||s.id||' (monthly delivery standard). Choose a keyword of '||s.unit||'''s approved core list and its service.');
    made := made + 1;
  end loop;
  return made;
end $$;
revoke all on function queue_standard_blog_tasks_site(uuid, uuid, date, date) from public, anon, authenticated, service_role;

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
declare c record; u record; site record; made int:=0; existing int; slots int; n int; opened int; social int; core_ok boolean;
  week date:=date_trunc('week',now() at time zone 'America/Chicago')::date;
begin
  for c in select cl.id, cl.status from clients cl where cl.status in ('active','launching')
      and ((client_delivery_standard(cl.id, week)).id is not null or (client_delivery_standard(cl.id, week+6)).id is not null)
      order by cl.id loop
    perform pg_advisory_xact_lock(hashtextextended('blog:'||c.id::text,0));
    perform plan_delivery_month(c.id, week);
    if date_trunc('month', week+6) <> date_trunc('month', week) then perform plan_delivery_month(c.id, week+6); end if;
    opened := 0;
    -- Per site program: each brand site of a multi-brand client, else the client.
    for site in select w.id, w.name, w.status = 'approved' as brand_ok from client_brand_workspaces w where w.client_id = c.id
                union all
                select null::uuid, null::text, exists (select 1 from brand_boards b where b.client_id = c.id and b.status = 'approved')
                where not exists (select 1 from client_brand_workspaces w where w.client_id = c.id) loop
      core_ok := exists (select 1 from core_keyword_lists l where l.client_id = c.id and l.status = 'approved'
                          and l.brand_workspace_id is not distinct from site.id);
      if c.status <> 'active' and not site.brand_ok then
        insert into delivery_queue_log (client_id, deliverable, decision, reason)
        values (c.id, 'blog_posts', 'skipped', left(coalesce('Launching client without an approved brand site: ' || site.name || '.',
                                                             'Launching client without an approved brand board or brand site.'), 300));
      elsif not core_ok then
        insert into delivery_queue_log (client_id, deliverable, decision, reason)
        values (c.id, 'blog_posts', 'skipped', left('No approved core keyword list' || coalesce(' for ' || site.name, '') || '.', 300));
      else
        opened := opened + queue_standard_blog_tasks_site(c.id, site.id, case when c.status = 'active' then null else week end, week+6);
      end if;
    end loop;
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

-- ── 12. Every path into review ─────────────────────────────────────────────
-- Tom, Oct 27: every blog, Facebook post, Business Profile post and webpage
-- refresh traces to its site's approved core 50. The weekly path is gated
-- above; these close the other doors, always (no approved list — absent,
-- proposed or revoked — means refused):
--   * a social post entering review (drafter, operator, hand-typed, revision)
--   * a blog draft entering review (weekly, Generate draft, any request)
--   * a change_log row that adds or rewrites content (page_rewrite,
--     page_added, blog_post) on a site
-- Each is judged on its exact target: the keyword must be eligible for the
-- site of the item's own service (or the site the change is on), with the
-- keyword's own service and page, and a Business Profile post's keyword
-- market must suit its location. Every entry into review records the
-- keyword, site list and version in core_keyword_links (a re-review under a
-- new version adds a row; history stays). Drafts may be prepared freely;
-- only entering review or delivery is gated, and nothing historical changes.
-- Every entry into review, and every revision while in review (a new
-- keyword, service or destination), is checked against the site's approved
-- list (BEFORE) and recorded with the list and version that vouched for it
-- (AFTER, once per post, list version and keyword). Missing or revoked
-- approval refuses: there is no fail-open path.
create function core_keyword_link_once(p_client_id uuid, p_keyword_id uuid, p_post uuid, p_draft uuid, p_change uuid, p_plan_item uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare g record;
begin
  select * into g from core_keyword_grounding(p_client_id, p_keyword_id);
  if g.list_id is null then return; end if;
  if not exists (select 1 from core_keyword_links c
                  where c.list_id = g.list_id and c.list_version = g.list_version and c.keyword_id = p_keyword_id
                    and (c.social_post_id = p_post or c.content_draft_id = p_draft or c.change_log_id = p_change)) then
    insert into core_keyword_links (client_id, list_id, list_version, keyword_id, core_keyword_id, social_post_id, content_draft_id, change_log_id, plan_item_id)
    values (p_client_id, g.list_id, g.list_version, p_keyword_id, g.core_keyword_id, p_post, p_draft, p_change, p_plan_item);
  end if;
end $$;
revoke all on function core_keyword_link_once(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

create function core_keyword_social_governed(tg_op text, n social_posts, o social_posts) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select n.review_status = 'in_review'
     and (tg_op = 'INSERT' or o.review_status is distinct from 'in_review'
          or (n.keyword_id, n.service_id, n.social_account_id) is distinct from (o.keyword_id, o.service_id, o.social_account_id))
$$;
revoke all on function core_keyword_social_governed(text, social_posts, social_posts) from public, anon, authenticated;

create function core_keyword_social_gate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_problem text;
begin
  if core_keyword_social_governed(tg_op, new, case when tg_op = 'UPDATE' then old end) and not core_keyword_exempt(new.client_id) then
    if new.keyword_id is null then
      raise exception 'core_keyword_required: a post in review names a keyword of its site''s approved core keyword list' using errcode = '23514';
    end if;
    v_problem := coalesce(core_keyword_eligibility(new.client_id, core_site_of_service(new.client_id, new.service_id), new.keyword_id, new.service_id),
                          core_market_problem(new.client_id, new.social_account_id, new.keyword_id));
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function core_keyword_social_gate() from public, anon, authenticated;
create trigger social_posts_aa_core_keyword before insert or update of review_status, keyword_id, service_id, social_account_id on social_posts
  for each row execute function core_keyword_social_gate();

create function core_keyword_social_record() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if core_keyword_social_governed(tg_op, new, case when tg_op = 'UPDATE' then old end) and new.keyword_id is not null then
    perform core_keyword_link_once(new.client_id, new.keyword_id, new.id, null, null, null);
  end if;
  return null;
end $$;
revoke all on function core_keyword_social_record() from public, anon, authenticated;
create trigger social_posts_core_keyword_record after insert or update of review_status, keyword_id, service_id, social_account_id on social_posts
  for each row execute function core_keyword_social_record();

create function core_keyword_draft_governed(tg_op text, n content_drafts, o content_drafts) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select n.status = 'in_review'
     and (tg_op = 'INSERT' or o.status is distinct from 'in_review'
          or (n.keyword_id, n.service_id, n.plan_item_id) is distinct from (o.keyword_id, o.service_id, o.plan_item_id))
$$;
revoke all on function core_keyword_draft_governed(text, content_drafts, content_drafts) from public, anon, authenticated;

create function core_keyword_draft_gate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_problem text; v_site uuid;
begin
  if core_keyword_draft_governed(tg_op, new, case when tg_op = 'UPDATE' then old end) and not core_keyword_exempt(new.client_id) then
    if new.keyword_id is null then
      raise exception 'core_keyword_required: a draft in review names a keyword of its site''s approved core keyword list' using errcode = '23514';
    end if;
    v_site := coalesce((select i.brand_workspace_id from content_plan_items i where i.id = new.plan_item_id),
                       core_site_of_service(new.client_id, new.service_id));
    v_problem := core_keyword_eligibility(new.client_id, v_site, new.keyword_id, new.service_id);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function core_keyword_draft_gate() from public, anon, authenticated;
create trigger content_drafts_aa_core_keyword before insert or update of status, keyword_id, service_id, plan_item_id on content_drafts
  for each row execute function core_keyword_draft_gate();

create function core_keyword_draft_record() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if core_keyword_draft_governed(tg_op, new, case when tg_op = 'UPDATE' then old end) and new.keyword_id is not null then
    perform core_keyword_link_once(new.client_id, new.keyword_id, null, new.id, null, new.plan_item_id);
  end if;
  return null;
end $$;
revoke all on function core_keyword_draft_record() from public, anon, authenticated;
create trigger content_drafts_core_keyword_record after insert or update of status, keyword_id, service_id, plan_item_id on content_drafts
  for each row execute function core_keyword_draft_record();

-- A content change names the site it is on (object_type 'site', object_id a
-- sites row of this client) and its keyword (after.keyword_id). The keyword
-- must be eligible for THAT site, and a changed URL (after.url) must be on it.
create function core_keyword_change_gate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_kw uuid; v_site sites; v_program uuid; v_multi boolean; v_problem text;
begin
  if new.change_type not in ('page_rewrite', 'page_added', 'blog_post') or core_keyword_exempt(new.client_id) then return new; end if;
  -- A revision is rechecked when it changes what the change is about.
  if tg_op = 'UPDATE' and (new.change_type, new.object_type, new.object_id, new.after->>'keyword_id', new.after->>'url')
     is not distinct from (old.change_type, old.object_type, old.object_id, old.after->>'keyword_id', old.after->>'url') then
    return new;
  end if;
  v_kw := case when coalesce(new.after->>'keyword_id', '') ~ '^[0-9a-f-]{36}$' then (new.after->>'keyword_id')::uuid end;
  if v_kw is null then
    raise exception 'core_keyword_required: a % change names its core keyword (after.keyword_id)', new.change_type using errcode = '23514';
  end if;
  select * into v_site from sites where id = new.object_id and client_id = new.client_id;
  v_multi := exists (select 1 from client_brand_workspaces w where w.client_id = new.client_id);
  if new.object_type is distinct from 'site' or v_site.id is null then
    raise exception 'core_keyword_required: a % change names the site it is on (object_type site, object_id)', new.change_type using errcode = '23514';
  end if;
  if v_multi then
    select w.id into v_program from client_brand_workspaces w where w.client_id = new.client_id and w.blog_site_id = v_site.id;
    if v_program is null then
      raise exception 'core_keyword_required: the site of this % change belongs to no brand site program', new.change_type using errcode = '23514';
    end if;
  end if;
  v_problem := core_keyword_eligibility(new.client_id, v_program, v_kw, null);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '23514';
  end if;
  if coalesce(new.after->>'url', '') ~ '^https?://'
     and lower(regexp_replace(substring(new.after->>'url' from '^https?://([^/:?#]+)'), '^www\.', ''))
         is distinct from lower(regexp_replace(substring(v_site.url from '^https?://([^/:?#]+)'), '^www\.', '')) then
    raise exception 'core_keyword_required: the changed page % is not on the site this change names', new.after->>'url' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function core_keyword_change_gate() from public, anon, authenticated;
create trigger change_log_aa_core_keyword before insert or update on change_log
  for each row execute function core_keyword_change_gate();

create function core_keyword_change_record() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Same predicate as the gate: an insert, or a revision of what the change
  -- is about (type, site, keyword or URL). A same-keyword URL revision under
  -- a newer approved version gets its own row for that version.
  if new.change_type in ('page_rewrite', 'page_added', 'blog_post') and coalesce(new.after->>'keyword_id', '') ~ '^[0-9a-f-]{36}$'
     and (tg_op = 'INSERT'
          or (new.change_type, new.object_type, new.object_id, new.after->>'keyword_id', new.after->>'url')
             is distinct from (old.change_type, old.object_type, old.object_id, old.after->>'keyword_id', old.after->>'url')) then
    perform core_keyword_link_once(new.client_id, (new.after->>'keyword_id')::uuid, null, null, new.id, null);
  end if;
  return null;
end $$;
revoke all on function core_keyword_change_record() from public, anon, authenticated;
create trigger change_log_core_keyword_record after insert or update on change_log
  for each row execute function core_keyword_change_record();

-- ── 12b. Tracking and reporting per site ───────────────────────────────────
-- normalize_tracked_keywords keeps its 0033 rule for clients without an
-- approved core list; a client with approved lists tracks exactly the union
-- of its approved site lists (BHG: 3 × 50, not a client-wide 50).
create or replace function normalize_tracked_keywords(p_client_id uuid, p_target int default 50)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_n int;
begin
  if exists (select 1 from core_keyword_lists l where l.client_id = p_client_id and l.status = 'approved') then
    update keywords k
       set is_tracked = exists (select 1 from core_keyword_lists l where l.client_id = p_client_id and l.status = 'approved' and k.id = any(l.keyword_ids))
     where k.client_id = p_client_id and k.is_active
       and k.is_tracked is distinct from exists (select 1 from core_keyword_lists l where l.client_id = p_client_id and l.status = 'approved' and k.id = any(l.keyword_ids));
    get diagnostics v_n = row_count;
    return v_n;
  end if;
  with ranked as (
    select k.id,
           row_number() over (
             order by k.is_money desc,
                      case k.priority when 'p1' then 1 when 'p2' then 2 else 3 end,
                      k.volume desc nulls last,
                      k.created_at
           ) as rn
    from keywords k
    where k.client_id = p_client_id and k.is_active
  )
  update keywords k
  set is_tracked = (r.rn <= p_target)
  from ranked r
  where k.id = r.id and k.is_tracked is distinct from (r.rn <= p_target);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ── 12c. Rank observations per site ───────────────────────────────────────
-- A keyword's organic rank is measured against its own website: the
-- client's one site, or for a multi-brand client the brand site owning the
-- keyword's service (the core list ownership). rank-sync resolves it per
-- keyword (supabase/functions/_shared/rank-site.ts) and stores the host it
-- judged against on site_host; rows from before carry null and are never
-- rewritten. keyword_site_hosts() is the SQL mirror. keyword_organic_state()
-- judges one row: for a multi-brand client a DataForSEO row not judged
-- against this keyword's own host (older rows judged against "the first
-- site") proves nothing for this site unless it shows a page on it, so it is
-- 'unverified', never a position. The ranking views, the City Index and the
-- coverage view read it, so no reader presents a sister site's result, or
-- an unattributed old row, as a per-site measurement.
alter table rank_snapshots add column site_host text;
comment on column rank_snapshots.site_host is
  'Host the collector judged this observation against (the keyword''s own website). Null on rows before 20261027160000.';

-- The keyword's own website hosts: [its host], or {} when unresolved (two
-- different hosts, no owning brand site, several, no website). Security
-- invoker: a reader sees only what RLS lets it read. The portal views inline
-- the same lookup because they run as their owner and a function would run
-- as the portal user (20261021163048).
create function public.keyword_site_hosts(p_keyword_id uuid) returns text[]
language sql stable security invoker set search_path = public, pg_temp as $$
  with k as (select id, client_id, service_id from keywords where id = p_keyword_id),
  h as (
    select array_agg(distinct x.h) filter (where x.h is not null) as hosts, count(distinct x.w) as owners
    from k cross join lateral (
      select public.url_host(w.website_url) as h, w.id as w from client_brand_workspaces w
       where w.client_id = k.client_id and k.service_id = any(w.service_ids)
      union all
      select public.url_host(si.url), w.id from client_brand_workspaces w join sites si on si.id = w.blog_site_id
       where w.client_id = k.client_id and k.service_id = any(w.service_ids)
      union all
      select public.url_host(c.website_url), null from clients c
       where c.id = k.client_id and not exists (select 1 from client_brand_workspaces w where w.client_id = k.client_id)
      union all
      select public.url_host(si.url), null from sites si
       where si.client_id = k.client_id and not exists (select 1 from client_brand_workspaces w where w.client_id = k.client_id)
    ) x
  )
  select case when coalesce(cardinality(h.hosts), 0) = 1 and coalesce(h.owners, 0) <= 1 then h.hosts else '{}'::text[] end
  from k cross join h
$$;
revoke all on function public.keyword_site_hosts(uuid) from public, anon;
grant execute on function public.keyword_site_hosts(uuid) to authenticated, service_role;

-- One organic row, given the keyword's hosts and whether its client is
-- multi-brand. Pure.
create function public.keyword_rank_state(p_source text, p_position integer, p_url text, p_site_host text, p_hosts text[], p_multi boolean)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case
    when p_multi and p_source = 'dataforseo' and (p_site_host is null or not (p_site_host = any(coalesce(p_hosts, '{}'))))
      then case when p_position is not null and public.organic_rank_state(p_source, p_position, p_url, p_hosts) = 'website'
                then 'website' else 'unverified' end
    else public.organic_rank_state(p_source, p_position, p_url, p_hosts)
  end
$$;
revoke all on function public.keyword_rank_state(text, integer, text, text, text[], boolean) from public, anon;
grant execute on function public.keyword_rank_state(text, integer, text, text, text[], boolean) to authenticated, service_role;

create function public.keyword_organic_state(p_keyword_id uuid, p_source text, p_position integer, p_url text, p_site_host text)
returns text language sql stable security invoker set search_path = public, pg_temp as $$
  select public.keyword_rank_state(p_source, p_position, p_url, p_site_host, public.keyword_site_hosts(p_keyword_id),
           exists (select 1 from keywords k join client_brand_workspaces w on w.client_id = k.client_id where k.id = p_keyword_id))
$$;
revoke all on function public.keyword_organic_state(uuid, text, integer, text, text) from public, anon;
grant execute on function public.keyword_organic_state(uuid, text, integer, text, text) to authenticated, service_role;

-- The three ranking views and the City Index as 20261021163048, judging each
-- row against its keyword's own website instead of every client host.
create or replace view public.client_growth_rankings with (security_invoker = true) as
select k.client_id, k.id as keyword_id, k.keyword, k.city as keyword_city,
  s.location_id, l.name as location_name, s.result_type,
  s.first_position, s.first_checked_at, s.position, s.checked_at, s.previous_position, s.previous_checked_at,
  s.first_state, s.state, s.previous_state
from public.keywords k
cross join lateral (
  -- The keyword's own website, as public.keyword_site_hosts (inline: this
  -- view may run as its owner for a portal user).
  select case when coalesce(cardinality(x.hosts), 0) = 1 and coalesce(x.owners, 0) <= 1 then x.hosts else '{}'::text[] end as hosts,
         exists (select 1 from public.client_brand_workspaces b where b.client_id = k.client_id) as multi
  from (
    select array_agg(distinct y.h) filter (where y.h is not null) as hosts, count(distinct y.w) as owners from (
      select public.url_host(b.website_url) as h, b.id as w from public.client_brand_workspaces b
       where b.client_id = k.client_id and k.service_id = any(b.service_ids)
      union all
      select public.url_host(si.url), b.id from public.client_brand_workspaces b join public.sites si on si.id = b.blog_site_id
       where b.client_id = k.client_id and k.service_id = any(b.service_ids)
      union all
      select public.url_host(c.website_url), null from public.clients c
       where c.id = k.client_id and not exists (select 1 from public.client_brand_workspaces b where b.client_id = k.client_id)
      union all
      select public.url_host(si.url), null from public.sites si
       where si.client_id = k.client_id and not exists (select 1 from public.client_brand_workspaces b where b.client_id = k.client_id)
    ) y
  ) x
) w
left join lateral (
  with ordered as (
    select r.location_id, r.result_type::text as result_type, r.position, r.recorded_at,
      case when r.result_type::text = 'organic' then public.keyword_rank_state(r.source::text, r.position, r.url_ranked, r.site_host, w.hosts, w.multi)
           when r.position is null then 'not_found' else 'listed' end as state,
      row_number() over (partition by r.location_id, r.result_type order by r.recorded_at desc, r.id desc) as latest,
      row_number() over (partition by r.location_id, r.result_type order by r.recorded_at, r.id) as earliest
    from public.rank_snapshots r
    where r.keyword_id = k.id and r.source::text = 'dataforseo' and r.recorded_at <= now()
  )
  select o.location_id, o.result_type,
    max(o.position) filter (where o.earliest = 1 and o.state in ('website', 'listed')) as first_position,
    max(o.recorded_at) filter (where o.earliest = 1) as first_checked_at,
    max(o.position) filter (where o.latest = 1 and o.state in ('website', 'listed')) as position,
    max(o.recorded_at) filter (where o.latest = 1) as checked_at,
    max(o.position) filter (where o.latest = 2 and o.state in ('website', 'listed')) as previous_position,
    max(o.recorded_at) filter (where o.latest = 2) as previous_checked_at,
    max(o.state) filter (where o.earliest = 1) as first_state,
    max(o.state) filter (where o.latest = 1) as state,
    max(o.state) filter (where o.latest = 2) as previous_state
  from ordered o
  where o.latest <= 2 or o.earliest = 1
  group by o.location_id, o.result_type
) s on true
left join public.locations l on l.id = s.location_id and l.client_id = k.client_id
where k.is_active and k.is_tracked;

create or replace view public.portal_growth_rankings with (security_barrier = true, security_invoker = false) as
select k.client_id, k.id as keyword_id, k.keyword, k.city as keyword_city,
  s.location_id, l.name as location_name, s.result_type,
  s.first_position, s.first_checked_at, s.position, s.checked_at, s.previous_position, s.previous_checked_at,
  s.first_state, s.state, s.previous_state
from public.keywords k
cross join lateral (
  -- The keyword's own website, as public.keyword_site_hosts (inline: this
  -- view may run as its owner for a portal user).
  select case when coalesce(cardinality(x.hosts), 0) = 1 and coalesce(x.owners, 0) <= 1 then x.hosts else '{}'::text[] end as hosts,
         exists (select 1 from public.client_brand_workspaces b where b.client_id = k.client_id) as multi
  from (
    select array_agg(distinct y.h) filter (where y.h is not null) as hosts, count(distinct y.w) as owners from (
      select public.url_host(b.website_url) as h, b.id as w from public.client_brand_workspaces b
       where b.client_id = k.client_id and k.service_id = any(b.service_ids)
      union all
      select public.url_host(si.url), b.id from public.client_brand_workspaces b join public.sites si on si.id = b.blog_site_id
       where b.client_id = k.client_id and k.service_id = any(b.service_ids)
      union all
      select public.url_host(c.website_url), null from public.clients c
       where c.id = k.client_id and not exists (select 1 from public.client_brand_workspaces b where b.client_id = k.client_id)
      union all
      select public.url_host(si.url), null from public.sites si
       where si.client_id = k.client_id and not exists (select 1 from public.client_brand_workspaces b where b.client_id = k.client_id)
    ) y
  ) x
) w
left join lateral (
  with ordered as (
    select r.location_id, r.result_type::text as result_type, r.position, r.recorded_at,
      case when r.result_type::text = 'organic' then public.keyword_rank_state(r.source::text, r.position, r.url_ranked, r.site_host, w.hosts, w.multi)
           when r.position is null then 'not_found' else 'listed' end as state,
      row_number() over (partition by r.location_id, r.result_type order by r.recorded_at desc, r.id desc) as latest,
      row_number() over (partition by r.location_id, r.result_type order by r.recorded_at, r.id) as earliest
    from public.rank_snapshots r
    where r.keyword_id = k.id and r.source::text = 'dataforseo' and r.recorded_at <= now()
  )
  select o.location_id, o.result_type,
    max(o.position) filter (where o.earliest = 1 and o.state in ('website', 'listed')) as first_position,
    max(o.recorded_at) filter (where o.earliest = 1) as first_checked_at,
    max(o.position) filter (where o.latest = 1 and o.state in ('website', 'listed')) as position,
    max(o.recorded_at) filter (where o.latest = 1) as checked_at,
    max(o.position) filter (where o.latest = 2 and o.state in ('website', 'listed')) as previous_position,
    max(o.recorded_at) filter (where o.latest = 2) as previous_checked_at,
    max(o.state) filter (where o.earliest = 1) as first_state,
    max(o.state) filter (where o.latest = 1) as state,
    max(o.state) filter (where o.latest = 2) as previous_state
  from ordered o
  where o.latest <= 2 or o.earliest = 1
  group by o.location_id, o.result_type
) s on true
left join public.locations l on l.id = s.location_id and l.client_id = k.client_id
where k.is_active and k.is_tracked and k.client_id = (select public.portal_client_id());

create or replace view public.portal_rankings with (security_invoker = false) as
with ranked as (
  select k.client_id, k.id as keyword_id, k.keyword, k.city, k.is_money,
    r.result_type::text as result_type, r.position, r.recorded_at,
    case when r.result_type::text = 'organic' then public.keyword_rank_state(r.source::text, r.position, r.url_ranked, r.site_host, w.hosts, w.multi)
         when r.position is null then 'not_found' else 'listed' end as state,
    row_number() over (partition by k.id, r.result_type order by r.recorded_at desc) as rn
  from public.rank_snapshots r
  join public.keywords k on k.id = r.keyword_id
  cross join lateral (
    -- The keyword's own website, as public.keyword_site_hosts (inline: this
    -- view may run as its owner for a portal user).
    select case when coalesce(cardinality(x.hosts), 0) = 1 and coalesce(x.owners, 0) <= 1 then x.hosts else '{}'::text[] end as hosts,
           exists (select 1 from public.client_brand_workspaces b where b.client_id = k.client_id) as multi
    from (
      select array_agg(distinct y.h) filter (where y.h is not null) as hosts, count(distinct y.w) as owners from (
        select public.url_host(b.website_url) as h, b.id as w from public.client_brand_workspaces b
         where b.client_id = k.client_id and k.service_id = any(b.service_ids)
        union all
        select public.url_host(si.url), b.id from public.client_brand_workspaces b join public.sites si on si.id = b.blog_site_id
         where b.client_id = k.client_id and k.service_id = any(b.service_ids)
        union all
        select public.url_host(c.website_url), null from public.clients c
         where c.id = k.client_id and not exists (select 1 from public.client_brand_workspaces b where b.client_id = k.client_id)
        union all
        select public.url_host(si.url), null from public.sites si
         where si.client_id = k.client_id and not exists (select 1 from public.client_brand_workspaces b where b.client_id = k.client_id)
      ) y
    ) x
  ) w
  where k.client_id = (select public.portal_client_id())
    and k.is_active and k.is_tracked
    and r.source::text = 'dataforseo'
)
select client_id, keyword, city, is_money, result_type,
  max(position) filter (where rn = 1 and state in ('website', 'listed')) as position,
  max(position) filter (where rn = 2 and state in ('website', 'listed')) as previous_position,
  max(recorded_at) filter (where rn = 1) as checked_at,
  max(state) filter (where rn = 1) as state,
  max(state) filter (where rn = 2) as previous_state
from ranked
where rn <= 2
group by client_id, keyword, city, is_money, result_type;

create or replace function public.compute_location_index(p_location_id uuid, p_period date)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_client uuid;
  v_start date := date_trunc('month', p_period)::date;
  v_end date := (date_trunc('month', p_period) + interval '1 month')::date;
  v_organic numeric(5,2);
  v_map numeric(5,2);
  v_counted int;
begin
  select client_id into v_client from locations where id = p_location_id;
  if v_client is null then
    return;
  end if;


  select count(*) into v_counted
  from keywords k
  where k.client_id = v_client and k.is_active and k.priority = 'p1';

  -- Latest in-period organic row per P1 keyword, chosen BEFORE judging it:
  -- when that latest check found nothing, or found a page that is not the
  -- client's website, the keyword is left out. An older website rank is never
  -- substituted for the latest check. Map pack keeps its existing rule (latest
  -- found position in the period).
  with latest as (
    select distinct on (rs.keyword_id, rs.result_type)
      rs.result_type, rs.position as pos,
      rs.result_type::text <> 'organic'
        or public.keyword_organic_state(rs.keyword_id, rs.source::text, rs.position, rs.url_ranked, rs.site_host) = 'website' as counts
    from rank_snapshots rs
    join keywords k on k.id = rs.keyword_id
    where rs.location_id = p_location_id
      and k.client_id = v_client and k.is_active and k.priority = 'p1'
      and (rs.result_type::text = 'organic' or rs.position is not null)
      and rs.recorded_at >= v_start and rs.recorded_at < v_end
    order by rs.keyword_id, rs.result_type, rs.recorded_at desc
  )
  select round(avg(pos) filter (where result_type = 'organic' and counts), 2),
         round(avg(pos) filter (where result_type = 'map_pack'), 2)
  into v_organic, v_map
  from latest;

  insert into location_index (location_id, period, organic_index, map_index, keywords_counted, computed_at)
  values (p_location_id, v_start, v_organic, v_map, v_counted, now())
  on conflict (location_id, period) do update
    set organic_index = excluded.organic_index,
        map_index = excluded.map_index,
        keywords_counted = excluded.keywords_counted,
        computed_at = excluded.computed_at;
end $$;
revoke execute on function public.compute_location_index(uuid, date) from public, anon, authenticated;

-- Per site: each approved core keyword with its tracking state, the governed
-- content that traces to it and its latest organic position.
create view core_keyword_site_coverage with (security_invoker = true) as
select l.client_id, l.brand_workspace_id, w.name as site_name, l.id as list_id, l.version as list_version,
       k.id as keyword_id, k.keyword, k.intent, k.is_tracked, k.service_id,
       (select count(*) from core_keyword_links c where c.list_id = l.id and c.core_keyword_id = k.id) as linked_items,
       (select case when public.keyword_organic_state(k.id, r.source::text, r.position, r.url_ranked, r.site_host) = 'website'
                    then r.position end
          from rank_snapshots r where r.keyword_id = k.id and r.result_type = 'organic'
          order by r.recorded_at desc limit 1) as latest_organic_position,
       (select max(r.recorded_at) from rank_snapshots r where r.keyword_id = k.id) as last_ranked_at
from core_keyword_lists l
join keywords k on k.id = any(l.keyword_ids)
left join client_brand_workspaces w on w.id = l.brand_workspace_id
where l.status = 'approved';
revoke all on core_keyword_site_coverage from public, anon, authenticated;
grant select on core_keyword_site_coverage to authenticated, service_role;

-- ── 13. Postconditions ──────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public.social_slot_claim(uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.social_slot_link(uuid, uuid, text)', 'execute')
     or has_function_privilege('authenticated', 'public.queue_standard_social_tasks(uuid, date)', 'execute')
     or has_function_privilege('authenticated', 'public.core_keyword_record(uuid, uuid, text, uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.social_slot_readiness(uuid, date, date)', 'execute')
     or has_function_privilege('anon', 'public.core_keyword_grounding(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.core_keyword_eligibility(uuid, uuid, uuid, uuid)', 'execute') then
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
