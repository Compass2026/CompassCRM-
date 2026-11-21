-- Rollback of 20261120210000_superseded_drafts_not_delivered_slots.sql.
-- Refuses while any draft is superseded or any slot is closed as not
-- delivered: those rows are history and would break the old checks. The
-- patched functions get back their exact previous text by undoing each
-- replacement. Part 2 first (it was applied last).
do $rollback$
declare
  src text;
begin
  if exists (select 1 from content_plan_items where not_delivered_at is not null) then
    raise exception 'Slots closed as not delivered exist; keep this release (they are history)';
  end if;
  drop function if exists content_slot_not_delivered(text, uuid, uuid);
  drop trigger if exists content_plan_items_aa_decision on content_plan_items;
  drop function if exists content_plan_items_decision_guard();
  execute replace(pg_get_functiondef('public.content_draft_request(uuid,text,text)'::regprocedure), $x$  -- not_delivered_v1: a slot closed as not delivered by decision is never drafted.
  if i.not_delivered_at is not null then
    raise exception 'This slot was closed as not delivered by decision (%); nothing is drafted for it', i.not_delivered_reason
      using errcode = '22023';
  end if;
$x$, '');
  execute replace(pg_get_functiondef('public.delivery_items(uuid,date,date)'::regprocedure),
    '(pi.retired_at is not null or pi.not_delivered_at is not null), pi.created_at', 'pi.retired_at is not null, pi.created_at');
  src := pg_get_functiondef('public.delivery_targets_monthly(uuid,date)'::regprocedure);
  src := replace(src, E'\n      and pi.not_delivered_at is null', '');
  src := replace(src, ' and pi.not_delivered_at is null', '');
  execute src;
  execute replace(pg_get_functiondef('public.delivery_v1_slot_retirable(uuid,date)'::regprocedure), ' and i.not_delivered_at is null', '');
  execute 'create or replace view public.content_plan_board with (security_invoker = true) as '
    || regexp_replace(pg_get_viewdef('public.content_plan_board'::regclass),
                      'WHEN \(i\.not_delivered_at IS NOT NULL\) THEN ''not_delivered''::text\s+', '');
end
$rollback$;
alter table content_plan_items drop constraint content_plan_items_not_delivered_shape,
  drop constraint content_plan_items_not_delivered_reason_check;
alter table content_plan_items drop column not_delivered_by, drop column not_delivered_reason, drop column not_delivered_at;

do $rollback$
declare
  f regprocedure;
  src text;
begin
  if exists (select 1 from content_drafts where status = 'superseded' or superseded_by is not null) then
    raise exception 'Superseded drafts exist; keep this release (they are history)';
  end if;
  drop function if exists content_draft_supersede(uuid, uuid, text);

  foreach f in array array[
      'public.content_draft_open_weekly(jsonb)'::regprocedure, 'public.queue_standard_blog_tasks(uuid,date)'::regprocedure,
      'public.queue_standard_blog_tasks_site(uuid,uuid,date,date)'::regprocedure, 'public.delivery_v1_slot_retirable(uuid,date)'::regprocedure] loop
    src := pg_get_functiondef(f);
    src := replace(src, $x$ and y.status <> 'superseded'$x$, '');
    src := replace(src, $x$ and d.status <> 'superseded'$x$, '');
    src := replace(src, $x$  -- draft_supersede_v1: a retired request is terminal; its task is never redrafted.
  if d.status = 'superseded' then
    raise exception 'draft_superseded: this task''s draft % was retired as superseded by %; nothing to draft', d.id, d.superseded_by
      using errcode = '22023';
  end if;
$x$, '');
    execute src;
  end loop;
  foreach f in array array['public.promotion_hold_conflicts(uuid)'::regprocedure, 'public.promotion_hold_conflict_counts(uuid)'::regprocedure] loop
    execute replace(pg_get_functiondef(f), $x$d.status not in ('rejected', 'superseded')$x$, $x$d.status <> 'rejected'$x$);
  end loop;

  src := pg_get_functiondef('public.content_drafts_guard()'::regprocedure);
  src := replace(src, $x$  -- draft_supersede_v1: content_draft_supersede's own write, by a signed-in teammate.
  v_supersede boolean := v_human and coalesce(current_setting('compass.content_draft_supersede', true), '') = 'on';
$x$, '');
  src := replace(src, $x$    -- draft_supersede_v1: a retired request and the draft that replaced it are history.
    if not v_super and old.status = 'superseded' then
      raise exception 'A superseded draft is kept as history; it cannot be deleted' using errcode = '23514';
    end if;
    if not v_super and exists (select 1 from content_drafts s where s.superseded_by = old.id) then
      raise exception 'This draft replaced a retired request and is kept as its record; it cannot be deleted' using errcode = '23514';
    end if;
$x$, '');
  src := regexp_replace(src, '  -- draft_supersede_v1: superseded is terminal.*?\n  end if;\n\n(  if tg_op = ''INSERT'' then)', '\1');
  src := replace(src, $x$
       and not (v_supersede and new.status = 'superseded') then$x$, ' then');
  if strpos(src, 'supersede') > 0 then raise exception 'content_drafts_guard did not unpatch cleanly; restore it by hand'; end if;
  execute src;

  execute 'create or replace view public.content_plan_board with (security_invoker = true) as '
    || replace(pg_get_viewdef('public.content_plan_board'::regclass),
               $x$WHERE ((x.plan_item_id = i.id) AND (x.status <> 'superseded'::text))$x$, 'WHERE (x.plan_item_id = i.id)');
end
$rollback$;

alter table content_drafts drop constraint content_drafts_superseded_fk,
  drop constraint content_drafts_superseded_shape, drop constraint content_drafts_superseded_not_self,
  drop constraint content_drafts_superseded_reason_check;
drop index if exists content_drafts_superseded_by_idx;
alter table content_drafts drop constraint content_drafts_written;
alter table content_drafts add constraint content_drafts_written
  check (status = 'requested' or (title is not null and body_markdown is not null));
alter table content_drafts drop constraint content_drafts_status_check;
alter table content_drafts add constraint content_drafts_status_check
  check (status = any (array['requested', 'draft', 'in_review', 'approved', 'rejected']));
alter table content_drafts drop column superseded_actor, drop column superseded_reason, drop column superseded_at, drop column superseded_by;
