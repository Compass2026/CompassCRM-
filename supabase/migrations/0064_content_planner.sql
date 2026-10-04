-- Content Planner MVP (Oct 4 2026; Production MVP sprint). Database only.
-- NOT APPLIED — written with its sandbox tests (content_planner.test.sql)
-- and held for approval.
--
-- One row per planned deliverable for a client and week: the weekly target
-- per managed client is 2 Social, 2 Business Profile, 2 Blogs and 1 Web
-- page (targets live in the app, src/lib/content-planner.ts; they are a
-- cadence, not a quota: Authority and quality stay the gate). A plan item
-- says what is planned and why; the work itself stays where it already
-- lives — a social / Business Profile post in social_posts (the 0045 review
-- gate), a blog in content_posts — and the item links to it.
--
-- Decisions this implements:
--   * Purpose is one of authority, educational, service, review,
--     seasonal_offer, community_team, real_work. An authority item names its
--     Authority opportunity and nothing else does; the opportunity's content
--     type must match the deliverable (gbp_post → gbp; blog_post /
--     blog_refresh → blog; service_page / location_page / page_improvement →
--     web_page). Authority has no social content type yet, so a social item
--     is never an authority item. A dismissed or suppressed opportunity
--     cannot be planned.
--   * Channel follows the deliverable: gbp is google_business; social is
--     facebook / instagram / linkedin / x / tiktok; blog and web_page have
--     none. A linked post must be the item's client and channel; a post or a
--     blog fills one slot only.
--   * Status is derived, never stored, in content_plan_board (security
--     invoker): blocked (a teammate's hold, with a reason) → delivered (a
--     teammate's hold, or the linked post published / blog published) →
--     approved (post approved) → in_review (post in review / blog in review)
--     → drafting (a linked post or blog in progress, or an open Draft with
--     AI request for the item's opportunity) → ready_to_generate (intent set,
--     and a service, an opportunity or — for a blog — a topic) → planned.
--     Rejected posts read as drafting: they need rework.
--   * Billing's monthly quota accounting (0062) counts the posts and blogs
--     themselves; this table adds no count of its own and touches no
--     billing object.
--
-- Access: team only (is_team()), as every 0036 table. Portal contacts and
-- anon see nothing; no function is added.
--
-- Rollback: drop view content_plan_board; drop table content_plan_items
-- (nothing else references them).

-- ── 0. Preconditions ────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.content_plan_items') is not null then
    raise exception '0064: content_plan_items already exists';
  end if;
  if to_regclass('public.authority_opportunities') is null or to_regclass('public.social_posts') is null then
    raise exception '0064: needs 0045 (social_posts) and 0048 (authority_opportunities)';
  end if;
end $$;

-- ── 1. Plan items ───────────────────────────────────────────────────────────
create table content_plan_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  deliverable text not null check (deliverable in ('social', 'gbp', 'blog', 'web_page')),
  channel social_platform,
  purpose text not null check (purpose in ('authority', 'educational', 'service', 'review', 'seasonal_offer',
                                           'community_team', 'real_work')),
  topic text not null check (length(btrim(topic)) between 1 and 200),
  search_intent text check (search_intent in ('navigational', 'informational', 'commercial', 'transactional')),
  keyword_id uuid,
  service_id uuid,
  authority_opportunity_id uuid,
  target_url text check (target_url is null or target_url ~ '^https?://\S+$'),
  planned_date date,
  social_post_id uuid,
  content_post_id uuid,
  output_url text check (output_url is null or output_url ~ '^https?://\S+$'),
  hold text check (hold in ('blocked', 'delivered')),
  hold_reason text check (hold_reason is null or length(btrim(hold_reason)) between 1 and 500),
  notes text check (notes is null or length(notes) <= 2000),
  created_by uuid references team_members(id) on delete set null,
  updated_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint content_plan_items_id_client_key unique (id, client_id),
  constraint content_plan_items_keyword_fk foreign key (keyword_id, client_id) references keywords (id, client_id),
  constraint content_plan_items_service_fk foreign key (service_id, client_id) references services (id, client_id),
  constraint content_plan_items_opportunity_fk foreign key (authority_opportunity_id, client_id)
    references authority_opportunities (id, client_id),
  constraint content_plan_items_social_post_fk foreign key (social_post_id, client_id)
    references social_posts (id, client_id) on delete set null (social_post_id),
  constraint content_plan_items_content_post_fk foreign key (content_post_id, client_id)
    references content_posts (id, client_id) on delete set null (content_post_id),
  -- coalesce: a NULL channel must fail the check, not pass it.
  constraint content_plan_items_channel_shape check (coalesce(
    (deliverable = 'gbp' and channel = 'google_business')
    or (deliverable = 'social' and channel in ('facebook', 'instagram', 'linkedin', 'x', 'tiktok'))
    or (deliverable in ('blog', 'web_page') and channel is null), false)),
  constraint content_plan_items_authority_shape check ((purpose = 'authority') = (authority_opportunity_id is not null)),
  constraint content_plan_items_output_shape check (
    (social_post_id is null or deliverable in ('social', 'gbp'))
    and (content_post_id is null or deliverable = 'blog')),
  constraint content_plan_items_planned_in_week check (planned_date is null or planned_date between week_start and week_start + 6),
  constraint content_plan_items_blocked_reason check (hold is distinct from 'blocked' or hold_reason is not null)
);
comment on table content_plan_items is
  'Content Planner (0064): one planned deliverable (social, gbp, blog, web_page) for a client and week (Monday), with its purpose, topic and the draft / output it links to. Status is derived in content_plan_board.';

create index content_plan_items_week_idx on content_plan_items (week_start, client_id);
create unique index content_plan_items_social_post_key on content_plan_items (social_post_id) where social_post_id is not null;
create unique index content_plan_items_content_post_key on content_plan_items (content_post_id) where content_post_id is not null;

-- ── 2. Guard: what a link must match, who changed it ────────────────────────
-- Security definer (as every guard here): it stamps task_actor(), which
-- signed-in callers cannot execute, and reads the linked opportunity and post
-- the composite foreign keys have already tied to the item's client.
create function content_plan_items_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o authority_opportunities;
  v_platform text;
  v_expected text;
begin
  if tg_op = 'UPDATE' and (new.id, new.client_id, new.created_at, new.created_by) is distinct from
                          (old.id, old.client_id, old.created_at, old.created_by) then
    raise exception 'A plan item keeps its client and creation record' using errcode = 'check_violation';
  end if;

  if new.authority_opportunity_id is not null
     and (tg_op = 'INSERT' or new.authority_opportunity_id is distinct from old.authority_opportunity_id
          or new.deliverable is distinct from old.deliverable) then
    select * into o from authority_opportunities where id = new.authority_opportunity_id;
    v_expected := case o.content_type
      when 'gbp_post' then 'gbp'
      when 'blog_post' then 'blog' when 'blog_refresh' then 'blog'
      when 'service_page' then 'web_page' when 'location_page' then 'web_page' when 'page_improvement' then 'web_page'
    end;
    if v_expected is null or v_expected <> new.deliverable then
      raise exception 'The Authority opportunity is a % opportunity; it cannot fill a % slot', o.content_type, new.deliverable
        using errcode = 'check_violation';
    end if;
    if o.status = 'dismissed' or o.suppressed then
      raise exception 'The Authority opportunity is dismissed or suppressed; it cannot be planned' using errcode = 'check_violation';
    end if;
  end if;

  if new.social_post_id is not null and (tg_op = 'INSERT' or new.social_post_id is distinct from old.social_post_id
                                         or new.channel is distinct from old.channel) then
    select platform::text into v_platform from social_posts where id = new.social_post_id;
    if v_platform is distinct from new.channel::text then
      raise exception 'The post is for %; this slot is for %', v_platform, new.channel using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, task_actor());
    new.created_at := now();
  end if;
  if new.hold is distinct from 'blocked' then new.hold_reason := case when new.hold = 'delivered' then new.hold_reason end; end if;
  new.updated_by := coalesce(task_actor(), new.updated_by);
  new.updated_at := now();
  return new;
end $$;
revoke all on function content_plan_items_guard() from public, anon, authenticated;
create trigger content_plan_items_guard before insert or update on content_plan_items
  for each row execute function content_plan_items_guard();

-- ── 3. The board: each item with its derived status ─────────────────────────
create view content_plan_board with (security_invoker = true) as
select i.*,
  case
    when i.hold = 'blocked' then 'blocked'
    when i.hold = 'delivered' or sp.publish_status = 'published' or cp.status = 'published' then 'delivered'
    when sp.review_status = 'approved' then 'approved'
    when sp.review_status = 'in_review' or cp.status = 'review' then 'in_review'
    when sp.id is not null or cp.id is not null
      or (i.authority_opportunity_id is not null and exists (
            select 1 from tasks t where t.client_id = i.client_id
               and t.key = 'authority_draft:' || i.authority_opportunity_id and t.status <> 'done')) then 'drafting'
    when i.search_intent is not null
      and (i.service_id is not null or i.authority_opportunity_id is not null or i.deliverable = 'blog') then 'ready_to_generate'
    else 'planned'
  end as status,
  sp.review_status as post_review_status,
  sp.publish_status as post_publish_status,
  sp.published_url as post_published_url,
  cp.status::text as content_status,
  cp.url as content_url
from content_plan_items i
left join social_posts sp on sp.id = i.social_post_id
left join content_posts cp on cp.id = i.content_post_id;
comment on view content_plan_board is
  'Content Planner (0064): plan items with their derived status (blocked, delivered, approved, in_review, drafting, ready_to_generate, planned). Security invoker: team only, through the base tables.';

-- ── 4. Access ───────────────────────────────────────────────────────────────
alter table content_plan_items enable row level security;
create policy "team plans content" on content_plan_items
  for all to authenticated using ((select is_team())) with check ((select is_team()));
revoke all on content_plan_items from public, anon;
revoke truncate, references, trigger on content_plan_items from authenticated;
grant select, insert, update, delete on content_plan_items to authenticated;
grant all on content_plan_items to service_role;
revoke all on content_plan_board from public, anon, authenticated;
grant select on content_plan_board to authenticated, service_role;

-- ── 5. Verify ───────────────────────────────────────────────────────────────
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.content_plan_items'::regclass) then
    raise exception '0064: RLS must be on';
  end if;
  if exists (select 1 from pg_policies where tablename = 'content_plan_items'
              and (qual not like '%is_team()%' or with_check not like '%is_team()%')) then
    raise exception '0064: every policy reads is_team()';
  end if;
  if has_table_privilege('anon', 'public.content_plan_items', 'select')
     or has_table_privilege('anon', 'public.content_plan_board', 'select') then
    raise exception '0064: anon must not read plan items';
  end if;
  if (select array_agg(c) from unnest((select reloptions from pg_class where oid = 'public.content_plan_board'::regclass)) c)
     is distinct from array['security_invoker=true'] then
    raise exception '0064: content_plan_board must be security invoker';
  end if;
end $$;
