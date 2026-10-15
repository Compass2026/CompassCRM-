-- Blog hero images (Oct 15 2026): one reviewed hero image per blog draft.
--
--   content_drafts.hero_asset_id / hero_alt
--     One brand asset of the SAME client (composite FK), stored and hashed,
--     kind photo or social_post, a PNG / JPEG / WebP with recorded
--     dimensions, plus alt text. Set together or not at all. With brand
--     workspaces, the asset must be assigned to the draft's brand.
--   content_drafts_hero_guard (after content_drafts_guard)
--     A hero change follows the content-edit rules exactly: the drafter in a
--     requested / draft / rejected draft, a teammate in a draft / rejected
--     one (withdraw or reopen first). It bumps the version, so an open review
--     or a pinned approval no longer matches.
--   content_draft_hero(d)
--     The hero as approval pins it: asset id, content hash, alt, kind,
--     illustrative, file facts. content_draft_approve adds it to the approval
--     snapshot (so the approved hash covers it) only when a hero is set, so
--     approvals of hero-less drafts hash exactly as before.
--   blog_publication_problems
--     Also blocks a release whose hero asset changed (file, kind, alt) since
--     approval, or is no longer a valid hero.
--   content_draft_write_with_hero(p)
--     The drafter's submit with a hero: the hero and content_draft_write in
--     one transaction. content_draft_write itself is unchanged.
--
-- A social_post asset is a generated graphic: non-evidentiary. It is shown
-- as illustrative in review and on the site, and is never a claim or a
-- source. Nothing here publishes; the website delivery is blog-publisher's
-- (the file is copied into the site repository with the article).

do $$
begin
  if to_regprocedure('public.content_site_destination(uuid,uuid)') is null then
    raise exception '20261015210000: needs brand workspaces (content_site_destination)';
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'content_drafts' and column_name = 'hero_asset_id') then
    raise exception '20261015210000: content_drafts.hero_asset_id already exists';
  end if;
end $$;

-- ── 1. Columns ──────────────────────────────────────────────────────────────
alter table content_drafts
  add column hero_asset_id uuid,
  add column hero_alt text check (hero_alt is null or length(btrim(hero_alt)) between 1 and 250),
  add constraint content_drafts_hero_fk foreign key (hero_asset_id, client_id) references brand_assets (id, client_id),
  add constraint content_drafts_hero_pair check ((hero_asset_id is null) = (hero_alt is null)),
  add constraint content_drafts_hero_blog_only check (hero_asset_id is null or deliverable = 'blog');
create index content_drafts_hero_idx on content_drafts (hero_asset_id) where hero_asset_id is not null;
comment on column content_drafts.hero_asset_id is
  'The blog''s hero image (20261015210000): a stored, hashed photo or social_post brand asset of the same client. A change bumps the version; approval pins its content hash.';
comment on column content_drafts.hero_alt is 'Alt text for the hero image; approved with it.';

-- ── 2. What a hero must be ──────────────────────────────────────────────────
-- Security invoker: a teammate reads brand assets through RLS, the drafter
-- and the publisher as service_role, the definer guards as the owner.
create function content_draft_hero_problems(p_client uuid, p_service uuid, p_asset uuid, p_alt text) returns text[]
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare a brand_assets; v text[] := '{}';
begin
  if p_asset is null then return v; end if;
  select * into a from brand_assets where id = p_asset;
  if a.id is null or a.client_id <> p_client then
    return array['The hero image must be one of this client''s brand assets.'];
  end if;
  if a.kind::text not in ('photo', 'social_post') then v := v || 'The hero image must be a photo or a social graphic.'::text; end if;
  if a.storage_path is null or a.content_hash is null then v := v || 'The hero image must be a stored, hashed file.'::text; end if;
  if coalesce(a.mime_type, '') not in ('image/png', 'image/jpeg', 'image/webp') then
    v := v || 'The hero image must be a PNG, JPEG or WebP file.'::text;
  end if;
  if a.width is null or a.height is null or a.width < 1 or a.height < 1 then v := v || 'The hero image needs recorded dimensions.'::text; end if;
  if nullif(btrim(coalesce(p_alt, '')), '') is null then v := v || 'The hero image needs alt text.'::text; end if;
  if exists (select 1 from client_brand_workspaces where client_id = p_client)
     and not exists (select 1 from client_brand_workspaces b where b.client_id = p_client
                      and p_service = any(b.service_ids) and p_asset = any(b.asset_ids)) then
    v := v || 'The hero image is not assigned to this brand.'::text;
  end if;
  return v;
end $$;
revoke all on function content_draft_hero_problems(uuid, uuid, uuid, text) from public, anon;
grant execute on function content_draft_hero_problems(uuid, uuid, uuid, text) to authenticated, service_role;

-- The hero as an approval pins it. SQL NULL when the draft has none.
create function content_draft_hero(d content_drafts) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object('asset_id', a.id, 'content_hash', a.content_hash, 'alt', d.hero_alt, 'kind', a.kind,
           'illustrative', a.kind::text = 'social_post', 'mime_type', a.mime_type, 'width', a.width, 'height', a.height,
           'size_bytes', a.size_bytes, 'storage_path', a.storage_path)
    from brand_assets a where a.id = d.hero_asset_id and a.client_id = d.client_id
$$;
revoke all on function content_draft_hero(content_drafts) from public, anon;
grant execute on function content_draft_hero(content_drafts) to authenticated, service_role;

-- ── 3. The guard ────────────────────────────────────────────────────────────
-- Fires after content_drafts_guard (trigger names sort), which has already
-- decided who is writing and refused everyone else.
create function content_drafts_hero_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_human boolean := post_caller_is_human();
  v_drafter boolean := content_drafter_session_active();
  v_super boolean := drafter_caller_is_superuser();
  v_problems text[];
begin
  if tg_op = 'INSERT' then
    if new.hero_asset_id is not null or new.hero_alt is not null then
      raise exception 'A hero image is chosen on a written draft' using errcode = '23514';
    end if;
    return new;
  end if;
  new.hero_alt := nullif(btrim(new.hero_alt), '');
  if (new.hero_asset_id, new.hero_alt) is not distinct from (old.hero_asset_id, old.hero_alt) then
    -- Unchanged hero: re-check it when the draft goes to review.
    if new.status = 'in_review' and old.status <> 'in_review' and new.hero_asset_id is not null then
      v_problems := content_draft_hero_problems(new.client_id, new.service_id, new.hero_asset_id, new.hero_alt);
      if cardinality(v_problems) > 0 then
        raise exception 'The draft cannot be submitted: %', array_to_string(v_problems, ' ') using errcode = '23514';
      end if;
    end if;
    return new;
  end if;
  -- The same rule as a content edit.
  if v_drafter then
    if old.status not in ('requested', 'draft', 'rejected') then
      raise exception 'The drafter sets a hero only on a requested, draft or rejected draft (it is %)', old.status using errcode = '23514';
    end if;
  elsif v_human or v_super then
    if old.status not in ('draft', 'rejected') then
      raise exception 'Withdraw or reopen the draft to change its hero image (it is %)', old.status using errcode = '23514';
    end if;
  else
    raise exception 'Only a teammate or the content-drafter function sets a hero image' using errcode = '42501';
  end if;
  if new.deliverable <> 'blog' then raise exception 'Only a blog carries a hero image' using errcode = '23514'; end if;
  if new.hero_asset_id is not null then
    if new.hero_alt is null then raise exception 'The hero image needs alt text' using errcode = '23514'; end if;
    v_problems := content_draft_hero_problems(new.client_id, new.service_id, new.hero_asset_id, new.hero_alt);
    if cardinality(v_problems) > 0 then raise exception '%', array_to_string(v_problems, ' ') using errcode = '23514'; end if;
  else
    new.hero_alt := null;
  end if;
  -- A content edit in the same statement has already moved the version.
  if new.version = old.version then new.version := old.version + 1; end if;
  return new;
end $$;
revoke all on function content_drafts_hero_guard() from public, anon, authenticated;
create trigger content_drafts_hero_guard before insert or update on content_drafts
  for each row execute function content_drafts_hero_guard();

-- ── 4. The drafter's submit with a hero ─────────────────────────────────────
create function content_draft_write_with_hero(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare h jsonb := p->'content'->'hero';
begin
  if not drafter_caller_is_service() then
    raise exception 'content_draft_write_with_hero runs only in the content-drafter function' using errcode = '42501';
  end if;
  if jsonb_typeof(h) is distinct from 'object' then
    raise exception 'A hero is { asset_id, alt }' using errcode = '22023';
  end if;
  perform set_config('compass.content_draft_write', 'on', true);
  update content_drafts set hero_asset_id = (h->>'asset_id')::uuid, hero_alt = h->>'alt'
   where id = (p->>'draft_id')::uuid
     and (hero_asset_id, hero_alt) is distinct from ((h->>'asset_id')::uuid, nullif(btrim(h->>'alt'), ''));
  perform set_config('compass.content_draft_write', '', true);
  return content_draft_write(jsonb_set(p, '{content}', (p->'content') - 'hero'));
end $$;
revoke all on function content_draft_write_with_hero(jsonb) from public, anon, authenticated;
grant execute on function content_draft_write_with_hero(jsonb) to service_role;

-- ── 5. Approval pins the hero ───────────────────────────────────────────────
create or replace function content_draft_approve(p_draft_id uuid, p_version int, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d content_drafts;
  v_problems text[];
  v_snapshot jsonb;
  v_hero jsonb;
  v_post uuid;
  v_created boolean := false;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate approves a draft' using errcode = '42501';
  end if;
  select * into d from content_drafts where id = p_draft_id for update;
  if d.id is null then raise exception 'No such draft' using errcode = 'P0002'; end if;
  if d.status = 'approved' and d.approved_version = p_version then
    return jsonb_build_object('draft_id', d.id, 'content_post_id', d.final_content_post_id, 'already', true);
  end if;
  if d.status <> 'in_review' then
    raise exception 'The draft is %; only a draft in review is approved', d.status using errcode = '23514';
  end if;
  if d.version <> p_version then
    raise exception 'The draft changed since you opened it (version % now); reload and review it again', d.version
      using errcode = '40001';
  end if;
  v_problems := content_draft_problems(d)
    || content_draft_hero_problems(d.client_id, d.service_id, d.hero_asset_id, d.hero_alt);
  if cardinality(v_problems) > 0 then
    raise exception 'The draft cannot be approved: %', array_to_string(v_problems, ' ') using errcode = '23514';
  end if;
  v_snapshot := jsonb_build_object(
    'version', d.version, 'deliverable', d.deliverable, 'page_type', d.page_type,
    'title', d.title, 'slug', d.slug, 'meta_title', d.meta_title, 'meta_description', d.meta_description, 'h1', d.h1,
    'draft_id', d.id, 'client_id', d.client_id, 'plan_item_id', d.plan_item_id,
    'topic', d.topic, 'primary_keyword', d.primary_keyword, 'keyword_id', d.keyword_id,
    'search_intent', d.search_intent, 'service_id', d.service_id,
    'authority_opportunity_id', d.authority_opportunity_id, 'target_url', d.target_url,
    'brief', d.brief, 'brief_hash', d.brief_hash, 'lint', d.lint,
    'destination', content_site_destination(d.client_id,d.service_id),
    'outline', d.outline, 'body_markdown', d.body_markdown, 'body_hash', d.body_hash, 'word_count', d.word_count,
    'internal_links', d.internal_links, 'cta', d.cta, 'structured_data', d.structured_data,
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', cl.id, 'claim', cl.claim, 'status', cl.status, 'source', cl.source) order by cl.id)
                         from content_draft_claims dc join claims cl on cl.id = dc.claim_id where dc.draft_id = d.id), '[]'::jsonb));
  -- Only a draft with a hero gains the key: hero-less approvals hash as before.
  v_hero := content_draft_hero(d);
  if v_hero is not null then v_snapshot := v_snapshot || jsonb_build_object('hero', v_hero); end if;

  perform set_config('compass.content_draft_system', 'on', true);
  if d.deliverable = 'blog' then
    if d.final_content_post_id is null then
      insert into content_posts (client_id, keyword_id, title, status, word_count, url, due_date, notes, origin)
      values (d.client_id, d.keyword_id, d.title, 'approved', d.word_count, null,
              (select planned_date from content_plan_items where id = d.plan_item_id),
              format('Approved from content draft %s (version %s).', d.id, d.version), 'compass')
      returning id into v_post;
      v_created := true;
    else
      v_post := d.final_content_post_id;
      update content_posts set title = d.title, word_count = d.word_count,
             status = case when status = 'published' then status else 'approved' end,
             notes = format('Approved from content draft %s (version %s).', d.id, d.version)
       where id = v_post;
    end if;
    if d.plan_item_id is not null then
      update content_plan_items set content_post_id = v_post where id = d.plan_item_id and content_post_id is null;
    end if;
    -- The weekly blog task closes with the approval (0068), never earlier.
    if d.source_task_id is not null then
      update tasks set status = 'done' where id = d.source_task_id and status <> 'done';
    end if;
  end if;
  update content_drafts set status = 'approved', approved_version = d.version,
         approved_hash = 'sha256:' || encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex'),
         approved_snapshot = v_snapshot, reviewed_by = task_actor(), reviewed_at = now(),
         review_note = nullif(btrim(coalesce(p_note, '')), ''), final_content_post_id = v_post
   where id = d.id;
  perform set_config('compass.content_draft_system', '', true);
  return jsonb_build_object('draft_id', d.id, 'content_post_id', v_post, 'created', v_created, 'already', false);
end $$;
revoke all on function content_draft_approve(uuid, int, text) from public, anon;
grant execute on function content_draft_approve(uuid, int, text) to authenticated;

-- ── 6. A release re-checks its hero ─────────────────────────────────────────
create or replace function blog_publication_problems(d content_drafts, p_snapshot jsonb) returns text[]
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare v text[] := content_draft_problems(d); dest jsonb; cl jsonb;
begin
  if d.deliverable <> 'blog' or d.status <> 'approved' or d.version <> d.approved_version
     or d.approved_snapshot is distinct from p_snapshot then
    v := v || 'The approved article changed. Review and approve the current version.'::text;
  end if;
  dest := content_site_destination(d.client_id,d.service_id);
  if dest is distinct from p_snapshot->'destination' or coalesce((dest->>'controlled_by_compass')::boolean,false) = false then
    v := v || 'Website destination changed or is not controlled by Compass. Review before publishing.'::text;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'claim',c.claim,'status',c.status,'source',c.source) order by c.id),'[]'::jsonb)
    into cl from content_draft_claims dc join claims c on c.id = dc.claim_id where dc.draft_id = d.id;
  if cl is distinct from p_snapshot->'claims' then v := v || 'Supporting evidence changed since approval.'::text; end if;
  if content_draft_hero(d) is distinct from p_snapshot->'hero'
     or cardinality(content_draft_hero_problems(d.client_id, d.service_id, d.hero_asset_id, d.hero_alt)) > 0 then
    v := v || 'The hero image changed since approval or is no longer usable. Review before publishing.'::text;
  end if;
  return v;
end $$;
revoke all on function blog_publication_problems(content_drafts,jsonb) from public, anon, authenticated;
grant execute on function blog_publication_problems(content_drafts,jsonb) to service_role;

-- ── 7. Self-check ───────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public.content_draft_write_with_hero(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.content_draft_write_with_hero(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.content_drafts_hero_guard()', 'execute')
     or has_function_privilege('anon', 'public.content_draft_hero(public.content_drafts)', 'execute')
     or not has_function_privilege('service_role', 'public.content_draft_write_with_hero(jsonb)', 'execute') then
    raise exception '20261015210000: function grants are wrong';
  end if;
end $$;
