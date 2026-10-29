-- Undoes 20261029010000: restores the held-offering matcher and the seven
-- functions it changed exactly as 20261028170000 defined them (fields joined
-- with spaces, link addresses read as words, JSON read as text), and drops
-- the two helpers it added. Run as one transaction. No row is touched; the
-- holds stay recorded and enforced. With it back, an article that only
-- matched across fields or a link address matches again, and an edit or
-- re-release of it is refused.
-- To roll back 20261028170000 as well, run this first.
create or replace function core_hold_hit(p_phrases text[], p_text text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare t text[] := core_hold_tokens(p_text); ph text; ps text[]; m int;
begin
  if cardinality(t) = 0 then return null; end if;
  foreach ph in array coalesce(p_phrases, '{}') loop
    ps := core_hold_tokens(ph); m := cardinality(ps);
    continue when m = 0;
    if exists (select 1 from generate_subscripts(t, 1) i where t[i] = any(ps) and ps <@ t[i:i + m + 1]) then
      return ph;
    end if;
  end loop;
  return null;
end $$;
create or replace function core_copy_hold(p_client_id uuid, p_program uuid, p_text text, p_service_id uuid, p_url text)
returns text language sql stable security invoker set search_path = public, pg_temp as $$
  select 'held_offering: ' || coalesce('"' || core_hold_hit(h.phrases, concat_ws(' ', p_text, p_url)) || '" promotes ', 'this promotes ')
         || h.offering || ', which is held from promotion (' || h.decided_on || ': ' || left(h.source_ref, 160)
         || '). Edit the copy; only a signed-in teammate releases the hold.'
  from client_promotion_holds h
  where h.client_id = p_client_id and h.status = 'held'
    and (h.brand_workspace_id is null or p_program is null or h.brand_workspace_id = p_program)
    and ((p_service_id is not null and p_service_id = any(h.service_ids))
      or core_hold_hit(h.phrases, concat_ws(' ', p_text, p_url)) is not null
      or (p_url is not null and exists (select 1 from services v where v.id = any(h.service_ids) and v.page_url is not null
                                          and core_norm_url(v.page_url) = core_norm_url(p_url))))
  order by h.created_at, h.id limit 1
$$;
create or replace function social_posts_promotion_hold() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_problem text; v_program uuid;
begin
  if new.review_status not in ('in_review', 'approved') or new.publish_status not in ('not_scheduled', 'scheduled', 'publishing') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- The outcome of a send already under way is recorded, never refused.
    if old.publish_status = 'publishing' then return new; end if;
    if (new.review_status, new.publish_status, new.copy, new.cta_url, new.service_id, new.keyword_id)
       is not distinct from (old.review_status, old.publish_status, old.copy, old.cta_url, old.service_id, old.keyword_id) then
      return new;
    end if;
  end if;
  if not exists (select 1 from client_promotion_holds h where h.client_id = new.client_id and h.status = 'held') then return new; end if;
  v_program := coalesce(core_site_of_service(new.client_id, new.service_id),
                        case when new.keyword_id is not null then core_site_of_keyword(new.client_id, new.keyword_id) end);
  v_problem := core_copy_hold(new.client_id, v_program,
                              concat_ws(' ', new.copy, (select k.keyword from keywords k where k.id = new.keyword_id)),
                              new.service_id, nullif(btrim(coalesce(new.cta_url, '')), ''));
  if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
  return new;
end $$;
create or replace function content_draft_hold_text(d content_drafts) returns text
language sql stable security invoker set search_path = public, pg_temp as $$
  select concat_ws(' ', d.topic, d.primary_keyword, d.title, d.meta_title, d.meta_description, d.h1, d.tldr, d.slug,
                   d.body_markdown, d.cta::text, d.structured_data::text,
                   (select k.keyword from keywords k where k.id = d.keyword_id))
$$;
create or replace function change_log_promotion_hold() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_problem text; v_program uuid;
begin
  if new.change_type not in ('page_rewrite', 'page_added', 'blog_post') or new.status::text = 'vetoed' then return new; end if;
  if tg_op = 'UPDATE' and (new.status, new.after) is not distinct from (old.status, old.after) then return new; end if;
  if not exists (select 1 from client_promotion_holds h where h.client_id = new.client_id and h.status = 'held') then return new; end if;
  select w.id into v_program from client_brand_workspaces w where w.client_id = new.client_id and w.blog_site_id = new.object_id;
  v_problem := core_copy_hold(new.client_id, v_program, new.after::text, null, nullif(new.after->>'url', ''));
  if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
  return new;
end $$;
create or replace function content_plan_items_promotion_hold() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_problem text;
begin
  if new.hold is not null then return new; end if;
  if not exists (select 1 from client_promotion_holds h where h.client_id = new.client_id and h.status = 'held') then return new; end if;
  v_problem := core_copy_hold(new.client_id, new.brand_workspace_id,
                              concat_ws(' ', new.topic, (select k.keyword from keywords k where k.id = new.keyword_id)),
                              new.service_id, nullif(btrim(coalesce(new.target_url, '')), ''));
  if v_problem is not null then
    new.hold := 'blocked'; new.hold_reason := left(v_problem, 500);
  end if;
  return new;
end $$;
create or replace function promotion_hold_conflicts(p_client_id uuid)
returns table (kind text, id uuid, state text, step text, title text, problem text)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from (
    select 'social_post'::text, p.id, p.review_status || '/' || p.publish_status,
           case when p.publish_status = 'published' then 'published: review the live post'
                when p.review_status in ('draft', 'rejected') then 'refused if submitted'
                else 'refused at its next step (approve, schedule, publish) or edit' end,
           left(p.copy, 120),
           core_copy_hold(p.client_id, coalesce(core_site_of_service(p.client_id, p.service_id),
                          case when p.keyword_id is not null then core_site_of_keyword(p.client_id, p.keyword_id) end),
                          concat_ws(' ', p.copy, (select k.keyword from keywords k where k.id = p.keyword_id)),
                          p.service_id, nullif(btrim(coalesce(p.cta_url, '')), ''))
    from social_posts p where p.client_id = p_client_id and p.review_status <> 'rejected'
    union all
    select 'content_draft', d.id, d.status,
           case when d.status in ('draft', 'requested', 'rejected') then 'refused if submitted'
                else 'refused at its next step or edit; a queued release is blocked at claim' end,
           coalesce(d.title, d.topic),
           core_copy_hold(d.client_id, content_draft_program(d), content_draft_hold_text(d), d.service_id,
                          nullif(btrim(coalesce(d.target_url, '')), ''))
    from content_drafts d where d.client_id = p_client_id and d.status <> 'rejected'
    union all
    select 'content_post', c.id, c.status::text, 'published or planned article: review it', c.title,
           core_copy_hold(c.client_id, null, concat_ws(' ', c.title, c.url), null, nullif(btrim(coalesce(c.url, '')), ''))
    from content_posts c where c.client_id = p_client_id
    union all
    select 'content_plan_item', i.id, coalesce(i.hold, 'open'), 'planned slot: marked blocked when next edited', i.topic,
           core_copy_hold(i.client_id, i.brand_workspace_id,
                          concat_ws(' ', i.topic, (select k.keyword from keywords k where k.id = i.keyword_id)),
                          i.service_id, nullif(btrim(coalesce(i.target_url, '')), ''))
    from content_plan_items i where i.client_id = p_client_id and i.content_post_id is null and i.social_post_id is null
  ) x(kind, id, state, step, title, problem)
  where x.problem is not null
  order by 1, 2
$$;
drop function core_hold_segments(text);
drop function core_hold_json_text(jsonb);
