-- Rollback for 20261117010000 (pending changes; revising rejected posts).
-- Restores content_edit_execute, content_review_batch and review_queue to
-- their previous definitions (reverse of the guarded replacements), then drops
-- the guard trigger, the receipt trigger, the hold functions and the holds
-- table. Holds are records: this stops if any exists, unless the caller has
-- exported them and sets compass.drop_holds = 'yes' in the same transaction.
-- Then deploy content-approvals v4.
do $$
begin
  if exists (select 1 from content_edit_holds) and coalesce(current_setting('compass.drop_holds', true), '') <> 'yes' then
    raise exception 'content_edit_holds has rows: export them, then set compass.drop_holds = yes to drop them';
  end if;
end $$;

do $$
declare
  b text := pg_get_functiondef('public.content_edit_execute(uuid,jsonb)'::regprocedure);
  new_s text := $x$  if sp.review_status not in ('in_review', 'rejected') or sp.publish_status <> 'not_scheduled' or sp.approved_hash is not null then
    raise exception 'not_editable: the post is % / %; only an unapproved, unscheduled post in review (or rejected with feedback) is revised', sp.review_status, sp.publish_status$x$;
  old_s text := $x$  if sp.review_status <> 'in_review' or sp.publish_status <> 'not_scheduled' or sp.approved_hash is not null then
    raise exception 'not_editable: the post is % / %; only an unapproved, unscheduled post in review is revised', sp.review_status, sp.publish_status$x$;
begin
  if (length(b) - length(replace(b, new_s, ''))) / length(new_s) <> 1 then raise exception 'content_edit_execute is not the 20261117010000 definition'; end if;
  execute replace(b, new_s, old_s);
end $$;

do $$
declare
  b text := pg_get_functiondef('public.content_review_batch(uuid,text)'::regprocedure);
  r1 text := $x$      'service_id', p.service_id,
      'rejection_category', p.rejection_category,
      'feedback', (select h.note from social_post_history h where h.post_id = p.id and h.kind = 'rejected' order by h.id desc limit 1),
      'pending_changes', content_edit_pending_changes(p.id),
$x$;
  s1 text := $x$      'service_id', p.service_id,
$x$;
  r2 text := $x$and p.review_status in ('in_review', 'approved', 'rejected') and p.publish_status <> 'published'$x$;
  s2 text := $x$and p.review_status in ('in_review', 'approved') and p.publish_status <> 'published'$x$;
begin
  if (length(b) - length(replace(b, r1, ''))) / length(r1) <> 1 or (length(b) - length(replace(b, r2, ''))) / length(r2) <> 1 then
    raise exception 'content_review_batch is not the 20261117010000 definition';
  end if;
  execute replace(replace(b, r1, s1), r2, s2);
end $$;

do $$
declare
  b text := pg_get_functiondef('public.review_queue(uuid)'::regprocedure);
  a1 text := $x$             content_edit_pending_changes(p.id) as pending_changes,
$x$;
  a2 text := $x$
                    and not exists (select 1 from content_edit_holds h where h.post_id = p.id and h.closed_at is null) then 'ready'$x$;
begin
  if position(a1 in b) = 0 or position(a2 in b) = 0 then raise exception 'review_queue is not the 20261117010000 definition'; end if;
  execute replace(replace(b, a1, ''), a2, $x$ then 'ready'$x$);
end $$;

drop trigger social_posts_ab_pending_change on social_posts;
drop function social_posts_pending_change_guard();
drop trigger content_edit_receipts_close_hold on content_edit_receipts;
drop function content_edit_receipts_close_hold();
drop function content_edit_hold_close(text, text, text, text);
drop function content_edit_hold_open(jsonb);
drop function content_edit_pending_changes(uuid);
drop trigger content_edit_holds_guard on content_edit_holds;
drop function content_edit_holds_guard();
drop table content_edit_holds;
