-- Held-offering matching respects field and link boundaries.
--
-- 20261028170000 joined a draft's fields (topic, keyword, title, …, slug,
-- body, CTA, schema) with spaces and matched held phrases across the joins,
-- and it read link addresses inside prose as words. Logic Solar's approved
-- installation article a922bdfa matched twice without promoting anything
-- held: "solar consultation overland park ks" across its topic and its
-- keyword fields, and "solar consulting service" across the address of a
-- link to /services/installation and the visible word after it.
--
-- Now a phrase matches inside one segment only:
-- - each field is its own segment (fields are joined with U+001F);
-- - each link address is its own segment, and prose is read with its
--   addresses taken out, so the visible words stay together;
-- - JSON (CTA, schema, a page change's content) contributes its string
--   values, each its own segment, never its keys.
-- A held phrase inside any one field, link address or JSON value still
-- matches, and keywords, services and owner pages are checked as before.
-- The same rule is in holdHit() (authority/keyword-owner.ts) and both
-- drafter linters.
-- Rollback: supabase/rollback/20261029010000_promotion_hold_field_boundaries.down.sql

-- The segments a held phrase is matched within (see above).
create function core_hold_segments(p_text text) returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(array_agg(s order by n, k), '{}') from (
    select f.n, 0::bigint as k, regexp_replace(f.v, '(?:https?://|www\.)[^][()<>"''[:space:]]+', ' ', 'gi') as s
    from unnest(string_to_array(coalesce(p_text, ''), E'\x1f')) with ordinality f(v, n)
    union all
    select f.n, u.k, u.m[1]
    from unnest(string_to_array(coalesce(p_text, ''), E'\x1f')) with ordinality f(v, n)
    cross join lateral regexp_matches(f.v, '((?:https?://|www\.)[^][()<>"''[:space:]]+)', 'gi') with ordinality u(m, k)
  ) x where btrim(s) <> ''
$$;

-- A JSON value's strings, one segment each (keys and other scalars are not copy).
create function core_hold_json_text(p jsonb) returns text
language sql immutable set search_path = public, pg_temp as $$
  select string_agg(v #>> '{}', E'\x1f') from jsonb_path_query(coalesce(p, 'null'::jsonb), 'strict $.**') v
  where jsonb_typeof(v) = 'string'
$$;
revoke all on function core_hold_segments(text), core_hold_json_text(jsonb) from public, anon;
grant execute on function core_hold_segments(text), core_hold_json_text(jsonb) to authenticated, service_role;

-- The first held phrase whose words all occur, in any order, within a span
-- of the phrase's length + 2 words of one segment; null when none does.
-- '|' marks a segment boundary (core_hold_tokens never yields it). A miss is
-- not a statement the prose is safe: what the phrases do not name is the
-- human reviewer's to catch.
create or replace function core_hold_hit(p_phrases text[], p_text text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare t text[] := '{}'; seg text; ph text; ps text[]; m int;
begin
  foreach seg in array core_hold_segments(p_text) loop
    t := t || core_hold_tokens(seg) || '{|}'::text[];
  end loop;
  if cardinality(t) = 0 then return null; end if;
  foreach ph in array coalesce(p_phrases, '{}') loop
    ps := core_hold_tokens(ph); m := cardinality(ps);
    continue when m = 0;
    if exists (select 1 from generate_subscripts(t, 1) i, lateral (select t[i:i + m + 1] w) x
               where t[i] = any(ps)
                 and ps <@ case when array_position(x.w, '|') is null then x.w else x.w[1:array_position(x.w, '|') - 1] end) then
      return ph;
    end if;
  end loop;
  return null;
end $$;

create or replace function core_copy_hold(p_client_id uuid, p_program uuid, p_text text, p_service_id uuid, p_url text)
returns text language sql stable security invoker set search_path = public, pg_temp as $$
  select 'held_offering: ' || coalesce('"' || core_hold_hit(h.phrases, concat_ws(E'\x1f', p_text, p_url)) || '" promotes ', 'this promotes ')
         || h.offering || ', which is held from promotion (' || h.decided_on || ': ' || left(h.source_ref, 160)
         || '). Edit the copy; only a signed-in teammate releases the hold.'
  from client_promotion_holds h
  where h.client_id = p_client_id and h.status = 'held'
    and (h.brand_workspace_id is null or p_program is null or h.brand_workspace_id = p_program)
    and ((p_service_id is not null and p_service_id = any(h.service_ids))
      or core_hold_hit(h.phrases, concat_ws(E'\x1f', p_text, p_url)) is not null
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
                              concat_ws(E'\x1f', new.copy, (select k.keyword from keywords k where k.id = new.keyword_id)),
                              new.service_id, nullif(btrim(coalesce(new.cta_url, '')), ''));
  if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
  return new;
end $$;

create or replace function content_draft_hold_text(d content_drafts) returns text
language sql stable security invoker set search_path = public, pg_temp as $$
  select concat_ws(E'\x1f', d.topic, d.primary_keyword, d.title, d.meta_title, d.meta_description, d.h1, d.tldr, d.slug,
                   d.body_markdown, core_hold_json_text(d.cta), core_hold_json_text(d.structured_data),
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
  v_problem := core_copy_hold(new.client_id, v_program, core_hold_json_text(new.after), null, nullif(new.after->>'url', ''));
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
                              concat_ws(E'\x1f', new.topic, (select k.keyword from keywords k where k.id = new.keyword_id)),
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
                          concat_ws(E'\x1f', p.copy, (select k.keyword from keywords k where k.id = p.keyword_id)),
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
           core_copy_hold(c.client_id, null, concat_ws(E'\x1f', c.title, c.url), null, nullif(btrim(coalesce(c.url, '')), ''))
    from content_posts c where c.client_id = p_client_id
    union all
    select 'content_plan_item', i.id, coalesce(i.hold, 'open'), 'planned slot: marked blocked when next edited', i.topic,
           core_copy_hold(i.client_id, i.brand_workspace_id,
                          concat_ws(E'\x1f', i.topic, (select k.keyword from keywords k where k.id = i.keyword_id)),
                          i.service_id, nullif(btrim(coalesce(i.target_url, '')), ''))
    from content_plan_items i where i.client_id = p_client_id and i.content_post_id is null and i.social_post_id is null
  ) x(kind, id, state, step, title, problem)
  where x.problem is not null
  order by 1, 2
$$;

do $verify$
begin
  -- Across fields and across a link address: no match. Inside one field,
  -- one address or one JSON string: a match.
  if core_hold_hit(array['solar consultation oakfield ks'], concat_ws(E'\x1f', 'what to gather before a design consultation', 'solar installation oakfield ks')) is not null
     or core_hold_hit(array['solar consulting service'], 'a [solar installation](https://example.test/services/installation) consultation helps') is not null
     or core_hold_hit(array['solar consultation oakfield ks'], concat_ws(E'\x1f', 'a title', 'solar consultation oakfield ks')) is null
     or core_hold_hit(array['solar repair'], 'see [our page](https://example.test/services/solar-repair/)') is null
     or core_hold_hit(array['monitoring plan'], core_hold_json_text('{"text": "Ask about our monitoring plan", "url": "https://example.test/"}')) is null
     or core_hold_hit(array['url text'], core_hold_json_text('{"url": "a", "text": "b"}')) is not null then
    raise exception 'promotion hold field boundaries: the matcher does not behave as specified';
  end if;
  if (select count(*) from pg_trigger where tgenabled <> 'D' and tgname in
        ('social_posts_ab_promotion_hold', 'content_drafts_ab_promotion_hold', 'blog_publications_promotion_hold',
         'change_log_ab_promotion_hold', 'content_plan_items_ab_promotion_hold')) <> 5 then
    raise exception 'promotion hold field boundaries: a copy-hold trigger is missing';
  end if;
  if has_function_privilege('anon', 'core_hold_hit(text[],text)', 'execute')
     or has_function_privilege('anon', 'core_copy_hold(uuid,uuid,text,uuid,text)', 'execute')
     or has_function_privilege('anon', 'core_hold_segments(text)', 'execute')
     or has_function_privilege('authenticated', 'social_posts_promotion_hold()', 'execute')
     or has_function_privilege('authenticated', 'content_draft_hold_text(content_drafts)', 'execute') then
    raise exception 'promotion hold field boundaries: grants changed';
  end if;
end $verify$;
