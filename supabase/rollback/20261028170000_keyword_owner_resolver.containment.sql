-- Rollback containment for 20261028170000_keyword_owner_resolver.sql.
-- Run as ONE transaction BEFORE anything else in the rollback: before the
-- previous drafters are redeployed and before the down script, which
-- refuses to run without it.
--
-- Why: the down script removes the copy-hold triggers and the hold-aware
-- resolver. The holds themselves are kept, but nothing would enforce them
-- any more. So every client with an active hold is paused here, at the
-- database, until enforcement is back and verified:
--   - no new post or draft (drafting is paused: the drafters' writes fail);
--   - no post enters review or approval, is scheduled, or is claimed for
--     publishing; no draft enters review or approval;
--   - no blog release; a queued release's claim is recorded `blocked`;
--   - no page change (rewrite, new page, article) is recorded;
--   - a planner slot is kept and marked `blocked`.
-- Still allowed: recording the outcome of a send already under way
-- (publishing → published / failed), the blog publisher's reconcile of an
-- uncertain release, moving content backwards (unschedule, reject, back to
-- draft), and edits to drafts. Nothing is deleted or rewritten.
-- It depends only on client_promotion_holds, which the rollback keeps.
-- Released only by ...containment-release.sql, which refuses until the
-- copy-hold enforcement is present again.

create function public.rollback_hold_contained(p_client_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from client_promotion_holds h where h.client_id = p_client_id and h.status = 'held')
$$;
revoke all on function public.rollback_hold_contained(uuid) from public, anon, authenticated;

create function public.rollback_hold_containment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_msg text := 'rollback_containment: this client has an active promotion hold, and hold enforcement is rolled back; '
                || 'drafting, review, approval, scheduling and publishing are paused until it is restored '
                || '(supabase/rollback/20261028170000_keyword_owner_resolver.containment-release.sql)';
begin
  if not rollback_hold_contained(new.client_id) then return new; end if;
  if tg_table_name = 'social_posts' then
    if tg_op = 'INSERT' then raise exception '%', v_msg using errcode = '55000'; end if;
    if old.publish_status = 'publishing' then return new; end if;     -- a send already under way is recorded
    if new.review_status in ('in_review', 'approved') and new.publish_status in ('not_scheduled', 'scheduled', 'publishing')
       and (new.review_status, new.publish_status) is distinct from (old.review_status, old.publish_status) then
      raise exception '%', v_msg using errcode = '55000';
    end if;
  elsif tg_table_name = 'content_drafts' then
    if tg_op = 'INSERT' or (new.status in ('in_review', 'approved') and new.status is distinct from old.status) then
      raise exception '%', v_msg using errcode = '55000';
    end if;
  elsif tg_table_name = 'blog_publications' then
    if tg_op = 'INSERT' then raise exception '%', v_msg using errcode = '55000'; end if;
    if old.status = 'queued' and new.status = 'publishing' then
      new.status := 'blocked'; new.lease_token := null; new.lease_expires_at := null; new.last_error := left(v_msg, 1000);
    end if;
  elsif tg_table_name = 'change_log' then
    if new.change_type in ('page_rewrite', 'page_added', 'blog_post') and new.status::text <> 'vetoed'
       and (tg_op = 'INSERT' or new.status is distinct from old.status or new.after is distinct from old.after) then
      raise exception '%', v_msg using errcode = '55000';
    end if;
  elsif tg_table_name = 'content_plan_items' then
    if new.hold is null then new.hold := 'blocked'; new.hold_reason := left(v_msg, 500); end if;
  end if;
  return new;
end $$;
revoke all on function public.rollback_hold_containment() from public, anon, authenticated;

-- a0: before every other trigger on these tables (the gates are aa_ / ab_).
create trigger social_posts_a0_rollback_containment before insert or update on public.social_posts
  for each row execute function public.rollback_hold_containment();
create trigger content_drafts_a0_rollback_containment before insert or update on public.content_drafts
  for each row execute function public.rollback_hold_containment();
create trigger blog_publications_a0_rollback_containment before insert or update on public.blog_publications
  for each row execute function public.rollback_hold_containment();
create trigger change_log_a0_rollback_containment before insert or update on public.change_log
  for each row execute function public.rollback_hold_containment();
create trigger content_plan_items_a0_rollback_containment before insert or update on public.content_plan_items
  for each row execute function public.rollback_hold_containment();

-- Postcondition, and the list the operator reconciles before the down
-- script: in-flight sends of contained clients. Wait for each to finish
-- (published / failed) or reconcile it (blog-publisher reconcile mode for
-- an uncertain release); stop the rollback if any cannot be resolved.
do $verify$
begin
  if (select count(*) from pg_trigger where tgname like '%_a0_rollback_containment' and tgenabled <> 'D') <> 5 then
    raise exception 'containment: not every path is paused';
  end if;
end $verify$;
select 'social_post' kind, p.id, p.client_id, p.publish_status state from social_posts p
 where rollback_hold_contained(p.client_id) and p.publish_status = 'publishing'
union all
select 'blog_publication', b.id, b.client_id, b.status from blog_publications b
 where rollback_hold_contained(b.client_id) and b.status in ('publishing', 'uncertain');
