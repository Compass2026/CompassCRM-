-- Ends the rollback containment (…containment.sql). Run as ONE transaction,
-- with Tom's go, only once hold enforcement is back and verified: the
-- fix-forward migration applied and its tests passed. It refuses while the
-- five copy-hold triggers are missing; a fix-forward that renames them
-- must update this check in the same change.
do $verify$
begin
  if (select count(*) from pg_trigger where tgenabled <> 'D' and tgname in
        ('social_posts_ab_promotion_hold', 'content_drafts_ab_promotion_hold', 'blog_publications_promotion_hold',
         'change_log_ab_promotion_hold', 'content_plan_items_ab_promotion_hold')) <> 5
     or to_regprocedure('public.core_copy_hold(uuid,uuid,text,uuid,text)') is null then
    raise exception 'containment stays: hold enforcement is not back (copy-hold triggers / core_copy_hold missing)';
  end if;
end $verify$;
drop trigger social_posts_a0_rollback_containment on public.social_posts;
drop trigger content_drafts_a0_rollback_containment on public.content_drafts;
drop trigger blog_publications_a0_rollback_containment on public.blog_publications;
drop trigger change_log_a0_rollback_containment on public.change_log;
drop trigger content_plan_items_a0_rollback_containment on public.content_plan_items;
drop function public.rollback_hold_containment();
drop function public.rollback_hold_contained(uuid);
-- Slots the containment marked blocked stay blocked (their reason says
-- why); a teammate clears each one, and the restored gates judge it then.
