-- Retire a blog / web page draft request as superseded: a supported,
-- audited, terminal state instead of Delete.
--
-- Tom (Nov 20 2026): stop two duplicate blog requests (the same keyword as a
-- draft already in review) from ever generating articles while keeping the
-- work and its history.
--
-- Before this, a requested draft had no way out but Delete (which destroys
-- the row and its provenance) or the source task being closed (which reads
-- as delivered work). Holds on the plan item do not stop the drafter, and the
-- Wednesday sweep picks up any non-done blog_post task whose draft is
-- requested.
--
-- What this adds (draft_supersede_v1):
--   * content_drafts.status gains 'superseded', with superseded_by (the
--     surviving draft, same client and kind, never itself superseded),
--     superseded_reason, superseded_at and superseded_actor (the teammate).
--   * content_draft_supersede(draft, surviving draft, reason): a signed-in
--     teammate (is_team, PostgREST session) retires a requested or draft
--     request. It is the only way in; superseded is terminal (no edit,
--     status change, regenerate, claim, write or delete, except by a
--     superuser). Idempotent for the same survivor.
--   * The draft's open tasks (its request task and its weekly source task)
--     are closed with a note saying no article was delivered.
--   * Delivery accounting: the superseded request releases its plan slot.
--     A slot counts as delivered only when held 'delivered' or linked to a
--     final article (delivery_items / delivery_targets_monthly), so the slot
--     stays open (planned, not done) and no longer counts as occupied: the
--     planner board shows it ready to generate again, Generate draft makes a
--     fresh request, the monthly queue and the v1 retirement treat it like an
--     empty slot. Its open source task is closed, so it is no longer counted
--     as planned blog work against the agreement (client_quota_usage) and the
--     weekly sweep (non-done blog_post tasks) never sees it.
--   * Everything else that reads content_drafts.status already treats a
--     status outside requested / draft / rejected / in_review / approved as
--     closed: content_draft_claim and content_draft_write (requested, draft,
--     rejected only), content_draft_regenerate (draft, rejected), approval and
--     publication (in_review / approved), the review queue
--     (content_review_batch: in_review, approved), the worker's sweeps
--     (status = 'requested' / status <> 'requested'), the hero and TL;DR
--     guards. The promotion-hold conflict lists counted every non-rejected
--     draft and now skip superseded ones too.
--
-- Rollback: supabase/rollback/20261120210000_content_draft_supersede.down.sql
-- (only while no draft is superseded).

-- ── 1. The state and its record ─────────────────────────────────────────────
alter table content_drafts
  add column superseded_by uuid,
  add column superseded_reason text,
  add column superseded_at timestamptz,
  add column superseded_actor uuid references team_members(id) on delete set null;

alter table content_drafts drop constraint content_drafts_status_check;
alter table content_drafts add constraint content_drafts_status_check
  check (status = any (array['requested', 'draft', 'in_review', 'approved', 'rejected', 'superseded']));

-- A request retired before it was written has no title or body.
alter table content_drafts drop constraint content_drafts_written;
alter table content_drafts add constraint content_drafts_written
  check (status in ('requested', 'superseded') or (title is not null and body_markdown is not null));

alter table content_drafts
  add constraint content_drafts_superseded_fk foreign key (superseded_by, client_id) references content_drafts (id, client_id),
  add constraint content_drafts_superseded_shape check (
    (status = 'superseded') = (superseded_by is not null and superseded_reason is not null and superseded_at is not null)),
  add constraint content_drafts_superseded_not_self check (superseded_by is distinct from id),
  add constraint content_drafts_superseded_reason_check check (
    superseded_reason is null or length(btrim(superseded_reason)) between 1 and 500);

create index content_drafts_superseded_by_idx on content_drafts (superseded_by) where superseded_by is not null;

comment on column content_drafts.superseded_by is
  'draft_supersede_v1: the surviving draft (same client and kind) that replaced this retired request. Set only by content_draft_supersede; superseded is terminal.';
comment on column content_drafts.superseded_reason is 'Why the request was retired (e.g. a duplicate request for the same keyword).';
comment on column content_drafts.superseded_actor is 'The teammate who retired the request.';

-- ── 2. The guard: only the RPC retires; a retired request is a record ───────
do $migration$
declare
  g text := pg_get_functiondef('public.content_drafts_guard()'::regprocedure);
  g1 text := $x$  v_problems text[];
$x$;
  g2 text := $x$      raise exception 'Only a teammate deletes a draft' using errcode = '42501';
    end if;
$x$;
  g3 text := $x$  if tg_op = 'INSERT' then
    if not (v_system or v_drafter or v_super) then$x$;
  g4 text := $x$    if new.status is distinct from old.status and not (v_system or v_super) then$x$;
  n int;
begin
  if strpos(g, 'draft_supersede_v1') > 0 then return; end if;
  foreach n in array array[
      (length(g) - length(replace(g, g1, ''))) / length(g1), (length(g) - length(replace(g, g2, ''))) / length(g2),
      (length(g) - length(replace(g, g3, ''))) / length(g3), (length(g) - length(replace(g, g4, ''))) / length(g4)] loop
    if n <> 1 then raise exception '20261120210000: a content_drafts_guard anchor is missing or repeated; review before applying'; end if;
  end loop;
  execute replace(replace(replace(replace(g,
    g1, $x$  v_problems text[];
  -- draft_supersede_v1: content_draft_supersede's own write, by a signed-in teammate.
  v_supersede boolean := v_human and coalesce(current_setting('compass.content_draft_supersede', true), '') = 'on';
$x$),
    g2, $x$      raise exception 'Only a teammate deletes a draft' using errcode = '42501';
    end if;
    -- draft_supersede_v1: a retired request and the draft that replaced it are history.
    if not v_super and old.status = 'superseded' then
      raise exception 'A superseded draft is kept as history; it cannot be deleted' using errcode = '23514';
    end if;
    if not v_super and exists (select 1 from content_drafts s where s.superseded_by = old.id) then
      raise exception 'This draft replaced a retired request and is kept as its record; it cannot be deleted' using errcode = '23514';
    end if;
$x$),
    g3, $x$  -- draft_supersede_v1: superseded is terminal, and only content_draft_supersede enters it.
  if tg_op = 'UPDATE' and old.status = 'superseded' and not v_super then
    raise exception 'A superseded draft is a closed record; it is never drafted, edited or reopened' using errcode = '23514';
  end if;
  if not v_super and (
       (tg_op = 'INSERT' and (new.status = 'superseded' or new.superseded_by is not null or new.superseded_reason is not null
                              or new.superseded_at is not null or new.superseded_actor is not null))
       or (tg_op = 'UPDATE' and (new.superseded_by, new.superseded_reason, new.superseded_at, new.superseded_actor)
                                is distinct from (old.superseded_by, old.superseded_reason, old.superseded_at, old.superseded_actor))
       or (tg_op = 'UPDATE' and new.status = 'superseded' and old.status is distinct from 'superseded')) then
    if tg_op = 'INSERT' or not v_supersede then
      raise exception 'A draft request is retired only through content_draft_supersede' using errcode = '42501';
    end if;
    if new.status is distinct from 'superseded' or old.status not in ('requested', 'draft') then
      raise exception 'Only a requested or draft request is retired as superseded (it is %)', old.status using errcode = '23514';
    end if;
  end if;

  if tg_op = 'INSERT' then
    if not (v_system or v_drafter or v_super) then$x$),
    g4, $x$    if new.status is distinct from old.status and not (v_system or v_super)
       and not (v_supersede and new.status = 'superseded') then$x$);
end
$migration$;

-- ── 3. The weekly blog never reopens a retired request; a released slot ─────
--      is an empty slot again.
do $migration$
declare
  o text := pg_get_functiondef('public.content_draft_open_weekly(jsonb)'::regprocedure);
  o1 text := $x$  select * into d from content_drafts where source_task_id = t.id;
  if d.id is not null then$x$;
  o2 text := $x$    elsif exists (select 1 from content_drafts y where y.plan_item_id = i.id) then$x$;
  o3 text := $x$       and not exists (select 1 from content_drafts y where y.plan_item_id = x.id)$x$;
  q text := pg_get_functiondef('public.queue_standard_blog_tasks(uuid,date)'::regprocedure);
  qs text := pg_get_functiondef('public.queue_standard_blog_tasks_site(uuid,uuid,date,date)'::regprocedure);
  r text := pg_get_functiondef('public.delivery_v1_slot_retirable(uuid,date)'::regprocedure);
  q1 text := $x$      and not exists (select 1 from content_drafts d where d.plan_item_id = i.id)$x$;
  c text := pg_get_functiondef('public.promotion_hold_conflicts(uuid)'::regprocedure);
  cc text := pg_get_functiondef('public.promotion_hold_conflict_counts(uuid)'::regprocedure);
  c1 text := $x$from content_drafts d where d.client_id = p_client_id and d.status <> 'rejected'$x$;
  n int;
begin
  if strpos(o, 'draft_supersede_v1') > 0 then return; end if;
  foreach n in array array[
      (length(o) - length(replace(o, o1, ''))) / length(o1), (length(o) - length(replace(o, o2, ''))) / length(o2),
      (length(o) - length(replace(o, o3, ''))) / length(o3),
      (length(q) - length(replace(q, q1, ''))) / length(q1), (length(qs) - length(replace(qs, q1, ''))) / length(q1),
      (length(r) - length(replace(r, q1, ''))) / length(q1),
      (length(c) - length(replace(c, c1, ''))) / length(c1), (length(cc) - length(replace(cc, c1, ''))) / length(c1)] loop
    if n <> 1 then raise exception '20261120210000: a drafting / delivery anchor is missing or repeated; review before applying'; end if;
  end loop;
  execute replace(replace(replace(o,
    o1, $x$  select * into d from content_drafts where source_task_id = t.id;
  -- draft_supersede_v1: a retired request is terminal; its task is never redrafted.
  if d.status = 'superseded' then
    raise exception 'draft_superseded: this task''s draft % was retired as superseded by %; nothing to draft', d.id, d.superseded_by
      using errcode = '22023';
  end if;
  if d.id is not null then$x$),
    o2, $x$    elsif exists (select 1 from content_drafts y where y.plan_item_id = i.id and y.status <> 'superseded') then$x$),
    o3, $x$       and not exists (select 1 from content_drafts y where y.plan_item_id = x.id and y.status <> 'superseded')$x$);
  execute replace(q, q1, $x$      and not exists (select 1 from content_drafts d where d.plan_item_id = i.id and d.status <> 'superseded')$x$);
  execute replace(qs, q1, $x$      and not exists (select 1 from content_drafts d where d.plan_item_id = i.id and d.status <> 'superseded')$x$);
  execute replace(r, q1, $x$      and not exists (select 1 from content_drafts d where d.plan_item_id = i.id and d.status <> 'superseded')$x$);
  execute replace(c, c1, $x$from content_drafts d where d.client_id = p_client_id and d.status not in ('rejected', 'superseded')$x$);
  execute replace(cc, c1, $x$from content_drafts d where d.client_id = p_client_id and d.status not in ('rejected', 'superseded')$x$);
end
$migration$;

-- ── 4. The planner board: a slot's draft is its latest live draft ───────────
do $migration$
declare
  v text := pg_get_viewdef('public.content_plan_board'::regclass);
  v1 text := 'WHERE (x.plan_item_id = i.id)';
begin
  if strpos(v, 'superseded') > 0 then return; end if;
  if (length(v) - length(replace(v, v1, ''))) / length(v1) <> 1 then
    raise exception '20261120210000: the content_plan_board anchor is missing or repeated; review before applying';
  end if;
  execute 'create or replace view public.content_plan_board with (security_invoker = true) as '
    || replace(v, v1, $x$WHERE ((x.plan_item_id = i.id) AND (x.status <> 'superseded'::text))$x$);
end
$migration$;

-- ── 5. Retire a request ─────────────────────────────────────────────────────
create or replace function content_draft_supersede(p_draft_id uuid, p_superseded_by uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  d content_drafts;
  s content_drafts;
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
  v_actor uuid := task_actor();
  v_who text;
  v_tasks uuid[];
begin
  if not (post_caller_is_human() and is_team()) then
    raise exception 'Only a signed-in teammate retires a draft request' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'Say why the request is retired (up to 500 characters)' using errcode = '22023';
  end if;
  if p_draft_id is null or p_superseded_by is null or p_draft_id = p_superseded_by then
    raise exception 'Choose the other draft that replaces this request' using errcode = '22023';
  end if;
  -- Both rows, in a fixed order (two retirements never deadlock).
  perform 1 from content_drafts where id in (p_draft_id, p_superseded_by) order by id for update;
  select * into d from content_drafts where id = p_draft_id;
  select * into s from content_drafts where id = p_superseded_by;
  if d.id is null then raise exception 'No such draft' using errcode = 'P0002'; end if;
  if s.id is null then raise exception 'No such surviving draft' using errcode = 'P0002'; end if;
  if d.status = 'superseded' then
    if d.superseded_by = s.id then
      return jsonb_build_object('draft_id', d.id, 'status', d.status, 'superseded_by', d.superseded_by, 'replayed', true);
    end if;
    raise exception 'The request was already retired as superseded by %', d.superseded_by using errcode = '23514';
  end if;
  if s.client_id <> d.client_id or s.deliverable <> d.deliverable then
    raise exception 'A request is superseded only by a draft of the same client and kind' using errcode = '22023';
  end if;
  if s.status = 'superseded' then
    raise exception 'Choose the surviving draft, not another retired request' using errcode = '22023';
  end if;
  if d.status not in ('requested', 'draft') then
    raise exception 'Only a requested or draft request is retired as superseded (it is %)', d.status using errcode = '23514';
  end if;

  perform set_config('compass.content_draft_supersede', 'on', true);
  update content_drafts set status = 'superseded', superseded_by = s.id, superseded_reason = v_reason,
         superseded_at = now(), superseded_actor = v_actor
   where id = d.id
  returning * into d;
  perform set_config('compass.content_draft_supersede', '', true);

  -- Its open tasks close as resolved, never as delivered work.
  select coalesce(name, email) into v_who from team_members where id = v_actor;
  with closed as (
    update tasks set status = 'done',
           notes = left(coalesce(notes || E'\n', '') || format(
             '%s %s: request retired. Draft %s is superseded by draft %s (%s). No article was delivered from this task; its plan slot is released. Reason: %s',
             to_char(now() at time zone 'America/Chicago', 'YYYY-MM-DD'), coalesce(v_who, 'A teammate'), d.id, s.id, s.status, v_reason), 20000)
     where id in (d.request_task_id, d.source_task_id) and client_id = d.client_id and status <> 'done'
    returning id)
  select coalesce(array_agg(id), '{}') into v_tasks from closed;

  return jsonb_build_object('draft_id', d.id, 'status', d.status, 'superseded_by', s.id, 'surviving_status', s.status,
                            'plan_item_id', d.plan_item_id, 'closed_task_ids', to_jsonb(v_tasks), 'replayed', false);
end
$function$;

comment on function content_draft_supersede(uuid, uuid, text) is
  'draft_supersede_v1: a signed-in teammate retires a requested or draft request as superseded by another draft of the same client and kind, with a reason. Terminal; closes its open tasks without delivering; releases its plan slot. Never deletes.';
revoke all on function content_draft_supersede(uuid, uuid, text) from public, anon, authenticated;
-- On purpose: the CRM calls it as the signed-in teammate (it re-checks is_team()).
grant execute on function content_draft_supersede(uuid, uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Part 2 (same release): close a plan slot as NOT DELIVERED BY DECISION.
--
-- Tom's standing rule for the weekly standard (task 3ab519f3): slots "dated
-- before the Nov 9 weekly-standard start; no backfill of missed dates". Until
-- now it lived only in task notes: the slots stayed open (planned, pending)
-- and their blog_post tasks stayed blocked in the sweeps. Those tasks have no
-- draft at all, so the superseded status above does not reach them.
--
-- content_slot_not_delivered(reason, task, plan item): a signed-in teammate
-- records the decision on the slot and closes its open tasks.
--   * The slot: not_delivered_at / _reason / _by, and hold 'blocked' with a
--     "Not delivered by decision: …" reason, so every existing gate that
--     needs an open slot (hold is null) already skips it: the monthly and
--     weekly blog queues (queue_standard_blog_tasks[_site], via
--     create_weekly_blog_tasks), content_draft_open_weekly (a named slot that
--     is blocked is refused; an unnamed task only takes a slot with no hold),
--     social_slot_readiness, queue_page_refresh_slots. Generate draft
--     (content_draft_request) now refuses it too.
--   * Terminal: the decision and the slot are frozen (no edit, hold change,
--     link or delete) except by a superuser. Never deleted.
--   * Neither delivered nor pending: the planner board shows it as
--     'not_delivered'; the monthly delivery card (delivery_targets_monthly,
--     and delivery_targets / plan_delivery_month through it) counts it in
--     neither completed nor planned, so the month shows the honest shortfall;
--     delivery_items reports it as retired, so the weekly reconciliation
--     credits it nothing and lists it as no open slot; the v1 retirement
--     leaves it alone. A past date is never planned again, so nothing
--     backfills it.
--   * Its open blog_post / social_slot tasks close with a
--     "not_delivered_by_decision:" note (who, when, why), so the Wednesday and
--     daily sweeps (non-done tasks) and the agreement's planned blog work
--     (client_quota_usage: non-done blog_post tasks) no longer count them.
--     A task with no slot (pre-standard "Blog slot N" tasks) is closed the
--     same way.
--   * Refused while the slot or task has a live draft (retire it as
--     superseded first) or is delivered / linked to a post or article.
-- ═══════════════════════════════════════════════════════════════════════════

alter table content_plan_items
  add column not_delivered_at timestamptz,
  add column not_delivered_reason text,
  add column not_delivered_by uuid references team_members(id) on delete set null;
alter table content_plan_items
  add constraint content_plan_items_not_delivered_shape check (
    (not_delivered_at is null) = (not_delivered_reason is null)
    and (not_delivered_at is null or hold = 'blocked')),
  add constraint content_plan_items_not_delivered_reason_check check (
    not_delivered_reason is null or length(btrim(not_delivered_reason)) between 1 and 500);
comment on column content_plan_items.not_delivered_at is
  'A teammate closed this slot as not delivered by decision (content_slot_not_delivered): neither delivered nor pending; terminal; never drafted or backfilled.';

-- The decision is set only by the RPC and freezes the slot.
create function content_plan_items_decision_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_super boolean := drafter_caller_is_superuser();
  v_rpc boolean := post_caller_is_human() and coalesce(current_setting('compass.content_slot_decision', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    if old.not_delivered_at is not null and not v_super and exists (select 1 from clients where id = old.client_id) then
      raise exception 'A slot closed as not delivered by decision is kept as history; it cannot be deleted' using errcode = '23514';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if (new.not_delivered_at is not null or new.not_delivered_reason is not null or new.not_delivered_by is not null) and not v_super then
      raise exception 'A slot is closed as not delivered only through content_slot_not_delivered' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.not_delivered_at is not null and not v_super
     and (to_jsonb(new) - array['updated_at', 'updated_by']) is distinct from (to_jsonb(old) - array['updated_at', 'updated_by']) then
    raise exception 'This slot was closed as not delivered by decision; it is a record and is not planned, drafted or edited again'
      using errcode = '23514';
  end if;
  if (new.not_delivered_at, new.not_delivered_reason, new.not_delivered_by)
     is distinct from (old.not_delivered_at, old.not_delivered_reason, old.not_delivered_by)
     and not (v_rpc or v_super) then
    raise exception 'A slot is closed as not delivered only through content_slot_not_delivered' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function content_plan_items_decision_guard() from public, anon, authenticated;
-- Fires first (trigger names sort), before the guard stamps the row.
create trigger content_plan_items_aa_decision before insert or update or delete on content_plan_items
  for each row execute function content_plan_items_decision_guard();

-- Generate draft, the planner board, the delivery accounting and the v1
-- retirement read the decision (patched in place).
do $migration$
declare
  rq text := pg_get_functiondef('public.content_draft_request(uuid,text,text)'::regprocedure);
  rq1 text := $x$  if i.deliverable not in ('blog', 'web_page') then$x$;
  di text := pg_get_functiondef('public.delivery_items(uuid,date,date)'::regprocedure);
  di1 text := $x$pi.retired_at is not null, pi.created_at$x$;
  dm text := pg_get_functiondef('public.delivery_targets_monthly(uuid,date)'::regprocedure);
  dm1 text := $x$      and not exists (select 1 from content_drafts d where d.plan_item_id = pi.id and d.final_content_post_id is not null)
      and coalesce(pi.planned_date, pi.week_start) >= b.m_start$x$;
  dm2 text := $x$and pi.deliverable = 'web_page' and pi.standard_key = 'page_refreshes'$x$;
  r text := pg_get_functiondef('public.delivery_v1_slot_retirable(uuid,date)'::regprocedure);
  r1 text := $x$and i.standard_week is null and i.retired_at is null$x$;
  v text := pg_get_viewdef('public.content_plan_board'::regclass);
  v1 text := $x$WHEN (i.hold = 'blocked'::text) THEN 'blocked'::text$x$;
  n int;
begin
  if strpos(rq, 'not_delivered_at') > 0 then return; end if;
  foreach n in array array[
      (length(rq) - length(replace(rq, rq1, ''))) / length(rq1), (length(di) - length(replace(di, di1, ''))) / length(di1),
      (length(dm) - length(replace(dm, dm1, ''))) / length(dm1), (length(dm) - length(replace(dm, dm2, ''))) / length(dm2),
      (length(r) - length(replace(r, r1, ''))) / length(r1), (length(v) - length(replace(v, v1, ''))) / length(v1)] loop
    if n <> 1 then raise exception '20261120210000: a not-delivered anchor is missing or repeated; review before applying'; end if;
  end loop;
  execute replace(rq, rq1, $x$  -- not_delivered_v1: a slot closed as not delivered by decision is never drafted.
  if i.not_delivered_at is not null then
    raise exception 'This slot was closed as not delivered by decision (%); nothing is drafted for it', i.not_delivered_reason
      using errcode = '22023';
  end if;
  if i.deliverable not in ('blog', 'web_page') then$x$);
  execute replace(di, di1, $x$(pi.retired_at is not null or pi.not_delivered_at is not null), pi.created_at$x$);
  execute replace(replace(dm, dm1, $x$      and not exists (select 1 from content_drafts d where d.plan_item_id = pi.id and d.final_content_post_id is not null)
      and pi.not_delivered_at is null
      and coalesce(pi.planned_date, pi.week_start) >= b.m_start$x$),
    dm2, $x$and pi.deliverable = 'web_page' and pi.standard_key = 'page_refreshes' and pi.not_delivered_at is null$x$);
  execute replace(r, r1, $x$and i.standard_week is null and i.retired_at is null and i.not_delivered_at is null$x$);
  execute 'create or replace view public.content_plan_board with (security_invoker = true) as '
    || replace(v, v1, $x$WHEN (i.not_delivered_at IS NOT NULL) THEN 'not_delivered'::text
            WHEN (i.hold = 'blocked'::text) THEN 'blocked'::text$x$);
end
$migration$;

create or replace function content_slot_not_delivered(p_reason text, p_task_id uuid default null, p_plan_item_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  t tasks;
  i content_plan_items;
  v_slot uuid;
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g')), '');
  v_actor uuid := task_actor();
  v_who text;
  v_client uuid;
  v_closed uuid[];
  v_replayed boolean := false;
begin
  if not (post_caller_is_human() and is_team()) then
    raise exception 'Only a signed-in teammate closes a slot as not delivered' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'Say why the slot is not delivered (up to 500 characters)' using errcode = '22023';
  end if;
  if p_task_id is null and p_plan_item_id is null then
    raise exception 'Choose the slot or its task' using errcode = '22023';
  end if;
  if p_task_id is not null then
    select * into t from tasks where id = p_task_id for update;
    if t.id is null then raise exception 'No such task' using errcode = 'P0002'; end if;
    if t.key is distinct from 'blog_post' and coalesce(t.key, '') not like 'social\_slot:%' then
      raise exception 'Only a blog or social slot task is closed as not delivered' using errcode = '22023';
    end if;
    v_slot := case when t.key = 'blog_post' then substring(coalesce(t.notes, '') from 'plan_item:([0-9a-f-]{36})')::uuid
                   else substring(t.key from 13)::uuid end;
    if p_plan_item_id is not null and v_slot is distinct from p_plan_item_id then
      raise exception 'The task names another slot' using errcode = '22023';
    end if;
  else
    v_slot := p_plan_item_id;
  end if;
  if v_slot is not null then
    select * into i from content_plan_items where id = v_slot for update;
    if i.id is null then raise exception 'No such plan slot' using errcode = 'P0002'; end if;
    if t.id is not null and i.client_id <> t.client_id then
      raise exception 'The task and the slot belong to different clients' using errcode = '22023';
    end if;
  end if;
  v_client := coalesce(i.client_id, t.client_id);

  if i.id is not null and i.not_delivered_at is not null then
    v_replayed := true;
  elsif i.id is null and t.status = 'done' then
    raise exception 'The task is already closed' using errcode = '23514';
  end if;
  if not v_replayed and i.id is not null then
    if i.hold = 'delivered' or i.content_post_id is not null or i.social_post_id is not null then
      raise exception 'The slot is delivered or linked to a post; it is not closed as not delivered' using errcode = '23514';
    end if;
    if exists (select 1 from content_drafts d where d.plan_item_id = i.id and d.status <> 'superseded') then
      raise exception 'The slot has a draft; retire the draft as superseded first, or let it run' using errcode = '23514';
    end if;
  end if;
  if t.id is not null and t.status <> 'done'
     and exists (select 1 from content_drafts d where d.source_task_id = t.id and d.status <> 'superseded') then
    raise exception 'The task has a draft; retire the draft as superseded first, or let it run' using errcode = '23514';
  end if;

  if not v_replayed and i.id is not null then
    perform set_config('compass.content_slot_decision', 'on', true);
    update content_plan_items set
           hold = 'blocked', hold_reason = left('Not delivered by decision: ' || v_reason, 500),
           notes = case when i.hold is null then notes
                        else left(coalesce(notes || E'\n', '') || format('Held %s before the decision: %s', i.hold, coalesce(i.hold_reason, 'no reason given')), 2000) end,
           not_delivered_at = now(), not_delivered_reason = v_reason, not_delivered_by = v_actor
     where id = i.id
    returning * into i;
    perform set_config('compass.content_slot_decision', '', true);
  end if;

  select coalesce(name, email) into v_who from team_members where id = v_actor;
  with closed as (
    update tasks x set status = 'done',
           notes = left(coalesce(x.notes || E'\n', '') || format(
             'not_delivered_by_decision: %s %s closed this %s as not delivered (neither delivered nor pending; nothing is drafted for it). Reason: %s',
             to_char(now() at time zone 'America/Chicago', 'YYYY-MM-DD'), coalesce(v_who, 'A teammate'),
             case when i.id is null then 'task' else 'slot (' || i.id || ')' end, v_reason), 20000)
     where x.client_id = v_client and x.status <> 'done'
       and (x.id = t.id
            or (i.id is not null and ((x.key = 'blog_post' and x.notes like '%plan_item:' || i.id::text || '%')
                                      or x.key = 'social_slot:' || i.id::text)))
       and not exists (select 1 from content_drafts d where d.source_task_id = x.id and d.status <> 'superseded')
    returning x.id)
  select coalesce(array_agg(id), '{}') into v_closed from closed;

  return jsonb_build_object('plan_item_id', i.id, 'task_id', t.id, 'not_delivered_at', i.not_delivered_at,
                            'closed_task_ids', to_jsonb(v_closed), 'replayed', v_replayed and cardinality(v_closed) = 0);
end
$function$;

comment on function content_slot_not_delivered(text, uuid, uuid) is
  'not_delivered_v1: a signed-in teammate closes a plan slot (and/or its blog or social slot task) as not delivered by decision, e.g. no backfill of missed dates. Terminal, neither delivered nor pending; closes its open tasks; never deletes.';
revoke all on function content_slot_not_delivered(text, uuid, uuid) from public, anon, authenticated;
-- On purpose: the CRM calls it as the signed-in teammate (it re-checks is_team()).
grant execute on function content_slot_not_delivered(text, uuid, uuid) to authenticated;
