-- Creative Engine, step 2 (Sept 30 2026): the overlay record covers every
-- line the renderer draws. Database only. NOT APPLIED — written with its
-- sandbox tests (creative_overlay_roles.test.sql) and held for approval.
--
-- 0054 records a creative's overlay as governed lines, each equal to its
-- source, and allowed at most three lines from six roles (business name,
-- service name, tagline, standing CTA, a claim linked to the post, the
-- post's confirmed offer title). The approved Lucas layouts (Sept 28 2026
-- decisions; docs/creative-engine.md) also print, on every render, the
-- governed phone and website in the footer, the service's segment as an
-- eyebrow, and a fixed template label ("Our work", a season). Recording
-- fewer lines than are drawn would make the record lie, so:
--
-- 1. creative_overlay_problems gains four roles, each still EQUAL to its
--    source:
--      phone            clients.phone
--      website          clients.website_url shown without scheme, "www."
--                       and trailing slashes (the renderer's displayWebsite)
--      service_segment  services.segment of the post's service (a preview:
--                       of the approved service named by source_id)
--      template_label   one of the labels in the template spec named by
--                       source_id (creative_templates.spec->'labels'); a
--                       label is design text Compass reviewed with the
--                       template, never a claim
--    and a template preview (no post) may show a usable claim of the client
--    named by source_id (confirmed, or sourced with a source) — before, a
--    preview could not show the claims its post would. A post's claim lines
--    are unchanged: linked to the post and usable.
-- 2. At most 12 lines (was 3); the primary line stays at most 8 words.
--    creative_assets_overlay_bounded follows (≤ 12).
--
-- Nothing else changes: no table, grant, policy or write boundary. Only the
-- Creative Engine's service session calls this function (0054's grants).
-- Production holds no creative asset today, so no stored row is affected.
--
-- Rollback (while no creative asset has more than three lines or a new
-- role): restore 0054's creative_overlay_problems and
-- `check (jsonb_array_length(overlay) <= 3)`.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.creative_overlay_problems(uuid,uuid,jsonb)') is null then
    raise exception '0057: needs 0054 (creative_overlay_problems)';
  end if;
  if exists (select 1 from creative_assets where jsonb_array_length(overlay) > 12) then
    raise exception '0057: a creative asset already records more than 12 overlay lines';
  end if;
end $$;

-- ── 1. Overlay rule ─────────────────────────────────────────────────────────
create or replace function creative_overlay_problems(p_client uuid, p_post_id uuid, p_overlay jsonb) returns text[]
language plpgsql stable security invoker set search_path = public as $$
declare
  v_problems text[] := '{}';
  v_line jsonb;
  v_role text;
  v_text text;
  v_expected text;
  v_src uuid;
  v_i int := 0;
  p social_posts;
begin
  if jsonb_typeof(coalesce(p_overlay, '[]')) <> 'array' then
    return array['The overlay is a list of lines.'];
  end if;
  if jsonb_array_length(coalesce(p_overlay, '[]')) > 12 then
    v_problems := v_problems || 'At most twelve overlay lines.'::text;
  end if;
  if p_post_id is not null then
    select * into p from social_posts where id = p_post_id and client_id = p_client;
  end if;
  for v_line in select * from jsonb_array_elements(coalesce(p_overlay, '[]')) loop
    v_i := v_i + 1;
    v_role := v_line->>'role';
    v_text := v_line->>'text';
    begin
      v_src := nullif(v_line->>'source_id', '')::uuid;
    exception when invalid_text_representation then
      v_problems := v_problems || format('Overlay line %s has a source_id that is not an id.', v_i);
      continue;
    end;
    v_expected := null;
    if nullif(btrim(coalesce(v_text, '')), '') is null then
      v_problems := v_problems || format('Overlay line %s is empty.', v_i);
      continue;
    end if;
    case v_role
      when 'business_name' then
        select name into v_expected from clients where id = p_client;
      when 'service_name' then
        select name into v_expected from services
         where client_id = p_client and status = 'approved'
           and id = coalesce(case when p_post_id is not null then p.service_id end, v_src);
      when 'service_segment' then
        select nullif(btrim(segment), '') into v_expected from services
         where client_id = p_client and status = 'approved'
           and id = coalesce(case when p_post_id is not null then p.service_id end, v_src);
      when 'tagline' then
        select tagline into v_expected from client_brands where client_id = p_client;
      when 'standing_cta' then
        select standing_cta into v_expected from brand_boards where client_id = p_client order by version desc limit 1;
      when 'phone' then
        select nullif(btrim(phone), '') into v_expected from clients where id = p_client;
      when 'website' then
        select nullif(regexp_replace(regexp_replace(btrim(website_url), '^(https?://)?(www\.)?', '', 'i'), '/+$', ''), '')
          into v_expected from clients where id = p_client;
      when 'template_label' then
        select l->>'text' into v_expected
          from creative_templates t, jsonb_array_elements(coalesce(t.spec->'labels', '[]')) l
         where t.id = v_src and l->>'text' = v_text
         limit 1;
      when 'claim' then
        if p_post_id is not null then
          select cl.claim into v_expected from claims cl join post_claims pc on pc.claim_id = cl.id
           where pc.post_id = p_post_id and cl.id = v_src
             and (cl.status::text = 'confirmed' or (cl.status::text = 'sourced' and nullif(btrim(coalesce(cl.source, '')), '') is not null));
        else
          select cl.claim into v_expected from claims cl
           where cl.client_id = p_client and cl.id = v_src
             and (cl.status::text = 'confirmed' or (cl.status::text = 'sourced' and nullif(btrim(coalesce(cl.source, '')), '') is not null));
        end if;
      when 'offer_title' then
        if p_post_id is not null then
          select o.title into v_expected from offers o
           where o.id = p.offer_id and o.status = 'confirmed'
             and (o.ends_on is null or o.ends_on >= (now() at time zone 'America/Chicago')::date);
        end if;
      else
        v_problems := v_problems || format('Overlay line %s has an unknown role "%s".', v_i, coalesce(v_role, ''));
        continue;
    end case;
    if v_expected is null then
      v_problems := v_problems || format('Overlay line %s (%s) has no governed source for this post.', v_i, v_role);
    elsif v_text <> v_expected then
      v_problems := v_problems || format('Overlay line %s must be exactly the governed %s.', v_i, v_role);
    end if;
    if v_i = 1 and cardinality(regexp_split_to_array(btrim(v_text), '\s+')) > 8 then
      v_problems := v_problems || 'The primary overlay line is at most 8 words.'::text;
    end if;
  end loop;
  return v_problems;
end $$;
revoke all on function creative_overlay_problems(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function creative_overlay_problems(uuid, uuid, jsonb) to service_role;

-- ── 2. The stored record's bound ────────────────────────────────────────────
alter table creative_assets drop constraint creative_assets_overlay_bounded;
alter table creative_assets add constraint creative_assets_overlay_bounded check (jsonb_array_length(overlay) <= 12);

-- ── 3. Verify ───────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public.creative_overlay_problems(uuid,uuid,jsonb)', 'execute')
     or has_function_privilege('anon', 'public.creative_overlay_problems(uuid,uuid,jsonb)', 'execute') then
    raise exception '0057: creative_overlay_problems must stay service-role only';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.creative_overlay_problems(uuid,uuid,jsonb)'::regprocedure) then
    raise exception '0057: creative_overlay_problems must stay security invoker';
  end if;
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'creative_assets_overlay_bounded'))
     not like '%<= 12%' then
    raise exception '0057: overlay bound not updated';
  end if;
end $$;
