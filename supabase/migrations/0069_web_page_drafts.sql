-- Web Page Drafter v1 (Oct 4 2026; Tom's decisions of Oct 4). Database only.
-- NOT APPLIED — written with its sandbox tests (content_drafts.test.sql,
-- section P) and held for approval after 0066–0068.
--
--   Planner / Authority → Generate (a page type, new or refresh) → the
--   content-drafter writes it → human review → Approve → ONE change_log row
--   (page_added for a new page, page_rewrite for a substantial refresh) →
--   Copy / Download.
--
-- On 0067's content_drafts (one drafting foundation for blogs and pages):
--   * page_change ('page_added' / 'page_rewrite', required for a page and
--     fixed at the request), page_path (the proposed URL path),
--     page_objective; the page's sections are the outline, its copy the
--     body, structured_data the JSON-LD recommendation.
--   * content_draft_request gains p_page_change. A page names its type and
--     whether it is new or a refresh; a refresh names the existing page (the
--     plan item's target page); a service page names its service; a location
--     page needs an Authority location_page opportunity (0067, unchanged: no
--     service × city matrix); a comparison page needs an Authority
--     opportunity or the teammate's reason in the note.
--   * content_draft_approve finalizes a page into exactly one change_log row
--     (final_change_log_id, unique): object_type 'site', object_id the draft,
--     before {url} for a refresh, after {url, path, title, meta, h1, type,
--     objective, words, draft, version, approved hash}, reasoning the
--     objective, evidence the claims with their sources, status approved and
--     who approved it. A re-approval updates the same row. Drafts,
--     regenerations, rejections and review never create one.
--   * Reopening an approved page returns its change_log row to 'proposed':
--     the Planner stops counting it, and Billing (0062: page_added /
--     page_rewrite rows, approved = completed) counts it as planned until it
--     is approved again.
--   * content_draft_problems: a page needs its path, its objective, two
--     sections and 250 words.
--
-- No Billing object changes. content_draft_request keeps its name (the
-- portal suite's reviewed list); its old three-argument form is dropped.
--
-- Rollback (while no page is approved): restore 0067 / 0068's functions,
-- drop the new columns and constraints.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.content_draft_open_weekly(jsonb)') is null then
    raise exception '0069: needs 0068';
  end if;
end $$;

-- ── 1. Page fields ──────────────────────────────────────────────────────────
alter table content_drafts
  add column page_change text check (page_change in ('page_added', 'page_rewrite')),
  add column page_path text check (page_path is null or (page_path ~ '^/([a-z0-9]+(-[a-z0-9]+)*/?)*$' and length(page_path) <= 200)),
  add column page_objective text check (page_objective is null or length(btrim(page_objective)) between 1 and 1000),
  add column final_change_log_id uuid;
alter table content_drafts
  add constraint content_drafts_page_change_shape check ((deliverable = 'web_page') = (page_change is not null)),
  add constraint content_drafts_rewrite_names_page check (page_change is distinct from 'page_rewrite' or target_url is not null),
  add constraint content_drafts_page_fields_page_only check (deliverable = 'web_page' or (page_path is null and page_objective is null)),
  add constraint content_drafts_final_change_fk foreign key (final_change_log_id, client_id)
    references change_log (id, client_id) on delete set null (final_change_log_id),
  add constraint content_drafts_final_change_page_only check (final_change_log_id is null or deliverable = 'web_page');
create unique index content_drafts_final_change_key on content_drafts (final_change_log_id) where final_change_log_id is not null;

-- ── 2. The guard knows the page fields ──────────────────────────────────────
create or replace function content_drafts_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_human boolean := post_caller_is_human();
  v_drafter boolean := content_drafter_session_active();
  v_super boolean := drafter_caller_is_superuser();
  v_system boolean := coalesce(current_setting('compass.content_draft_system', true), '') = 'on';
  v_content_changed boolean;
  v_problems text[];
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from clients where id = old.client_id) then return old; end if;
    if not (v_human or v_super) then
      raise exception 'Only a teammate deletes a draft' using errcode = '42501';
    end if;
    if old.status = 'approved' or old.final_content_post_id is not null then
      raise exception 'An approved draft is a record; reopen it instead' using errcode = '23514';
    end if;
    return old;
  end if;

  -- A referential action (a linked plan item, task or final article deleted)
  -- only nulls its column.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1
     and (to_jsonb(new) - array['plan_item_id', 'request_task_id', 'final_content_post_id', 'source_task_id', 'final_change_log_id'])
       = (to_jsonb(old) - array['plan_item_id', 'request_task_id', 'final_content_post_id', 'source_task_id', 'final_change_log_id']) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not (v_system or v_drafter or v_super) then
      raise exception 'Drafts are created by a Generate request or the content-drafter function' using errcode = '42501';
    end if;
    new.created_at := now();
    new.created_by := coalesce(new.created_by, task_actor());
  else
    if (new.id, new.client_id, new.deliverable, new.created_at, new.created_by, new.page_change, new.page_type)
       is distinct from (old.id, old.client_id, old.deliverable, old.created_at, old.created_by, old.page_change, old.page_type) then
      raise exception 'A draft keeps its client, kind and page change' using errcode = '23514';
    end if;
    v_content_changed := (new.title, new.slug, new.meta_title, new.meta_description, new.h1, new.outline, new.body_markdown,
                          new.internal_links, new.cta, new.structured_data, new.page_path, new.page_objective)
                         is distinct from (old.title, old.slug, old.meta_title, old.meta_description, old.h1, old.outline,
                                           old.body_markdown, old.internal_links, old.cta, old.structured_data, old.page_path, old.page_objective);
    -- The brief and the drafter's own record are the drafter's.
    if not (v_drafter or v_system or v_super) and (
         (new.brief, new.brief_hash, new.lint, new.runtime) is distinct from (old.brief, old.brief_hash, old.lint, old.runtime)
         or new.request_task_id is distinct from old.request_task_id) then
      raise exception 'The brief and lint are written by the content-drafter function' using errcode = '42501';
    end if;
    -- Approval fields only through content_draft_approve (a reopen clears
    -- them below); review stamps only through a transition.
    if not (v_system or v_super) then
      if (new.approved_version, new.approved_hash, new.approved_snapshot, new.final_content_post_id, new.final_change_log_id)
         is distinct from (old.approved_version, old.approved_hash, old.approved_snapshot, old.final_content_post_id, old.final_change_log_id) then
        raise exception 'A draft is approved through content_draft_approve' using errcode = '42501';
      end if;
      new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at;
      new.submitted_at := old.submitted_at; new.requested_by := old.requested_by;
    end if;
    if v_content_changed then
      if v_drafter then
        if old.status not in ('requested', 'draft', 'rejected') then
          raise exception 'The drafter writes only a requested, draft or rejected draft (it is %)', old.status using errcode = '23514';
        end if;
        new.author_kind := 'drafter';
      elsif v_human or v_super then
        if old.status not in ('draft', 'rejected') then
          raise exception 'Withdraw or reopen the draft to edit it (it is %)', old.status using errcode = '23514';
        end if;
        new.author_kind := 'team';
      else
        raise exception 'Only a teammate or the content-drafter function writes a draft''s content' using errcode = '42501';
      end if;
      new.version := old.version + 1;
      new.body_hash := encode(sha256(convert_to(coalesce(new.body_markdown, ''), 'UTF8')), 'hex');
      new.word_count := case when btrim(coalesce(new.body_markdown, '')) = '' then 0 else
        array_length(regexp_split_to_array(btrim(regexp_replace(new.body_markdown, '[#*>_`|]+', ' ', 'g')), '\s+'), 1) end;
    elsif new.version is distinct from old.version and not v_super then
      raise exception 'The version follows the content' using errcode = '42501';
    end if;

    -- Status transitions.
    if new.status is distinct from old.status and not (v_system or v_super) then
      case old.status || '>' || new.status
        when 'requested>in_review' then
          if not v_drafter then raise exception 'Only the content-drafter function submits a generated draft' using errcode = '42501'; end if;
        when 'requested>draft' then
          if not v_drafter then raise exception 'Only the content-drafter function writes a requested draft' using errcode = '42501'; end if;
        when 'draft>in_review', 'rejected>in_review' then
          if not (v_human or v_drafter) then raise exception 'A teammate submits a draft' using errcode = '42501'; end if;
        when 'in_review>draft', 'rejected>draft', 'approved>draft' then
          if not v_human then raise exception 'A teammate withdraws, revises or reopens a draft' using errcode = '42501'; end if;
        when 'in_review>rejected' then
          if not v_human then raise exception 'Only a signed-in teammate rejects a draft' using errcode = '42501'; end if;
          new.reviewed_by := task_actor(); new.reviewed_at := now();
        when 'draft>requested', 'rejected>requested' then
          raise exception 'Regenerate through content_draft_regenerate' using errcode = '42501';
        else
          raise exception 'A draft cannot go from % to %', old.status, new.status using errcode = '23514';
      end case;
    end if;
    if new.status = 'in_review' and old.status <> 'in_review' then
      v_problems := content_draft_problems(new);
      if cardinality(v_problems) > 0 then
        raise exception 'The draft cannot be submitted: %', array_to_string(v_problems, ' ') using errcode = '23514';
      end if;
      new.submitted_at := now();
    end if;
    if old.status = 'approved' and new.status = 'draft' then
      -- Reopen: the approval is cleared; the final article (if any) stays and
      -- a re-approval updates it.
      new.approved_version := null; new.approved_hash := null; new.approved_snapshot := null;
      new.reviewed_by := null; new.reviewed_at := null;
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(task_actor(), new.updated_by);
  return new;
end $$;

-- ── 3. Grounding for a page ─────────────────────────────────────────────────
create or replace function content_draft_problems(d content_drafts) returns text[]
language plpgsql stable security invoker set search_path = public as $$
declare
  v text[] := '{}';
  v_claims int;
  v_unusable int;
begin
  if nullif(btrim(coalesce(d.title, '')), '') is null then v := v || 'A title is required.'::text; end if;
  if d.slug is null then v := v || 'A slug is required.'::text; end if;
  if nullif(btrim(coalesce(d.meta_title, '')), '') is null then v := v || 'A meta title is required.'::text;
  elsif length(d.meta_title) > 70 then v := v || 'The meta title is over 70 characters.'::text; end if;
  if nullif(btrim(coalesce(d.meta_description, '')), '') is null then v := v || 'A meta description is required.'::text;
  elsif length(d.meta_description) > 170 then v := v || 'The meta description is over 170 characters.'::text; end if;
  if nullif(btrim(coalesce(d.h1, '')), '') is null then v := v || 'An H1 is required.'::text; end if;
  if nullif(btrim(coalesce(d.body_markdown, '')), '') is null then v := v || 'The body is empty.'::text;
  elsif d.deliverable = 'blog' and coalesce(d.word_count, 0) < 300 then v := v || 'A blog body is at least 300 words.'::text;
  elsif d.deliverable = 'web_page' and coalesce(d.word_count, 0) < 250 then v := v || 'A page body is at least 250 words.'::text; end if;
  if d.deliverable = 'web_page' then
    if d.page_path is null then v := v || 'A page needs its proposed URL path.'::text; end if;
    if nullif(btrim(coalesce(d.page_objective, '')), '') is null then v := v || 'A page needs its objective.'::text; end if;
    if jsonb_array_length(coalesce(d.outline, '[]')) < 2 then v := v || 'A page needs at least two sections.'::text; end if;
  end if;
  select count(*) filter (where cl.status::text = 'confirmed' or (cl.status::text = 'sourced' and nullif(btrim(coalesce(cl.source, '')), '') is not null)),
         count(*) filter (where not (cl.status::text = 'confirmed' or (cl.status::text = 'sourced' and nullif(btrim(coalesce(cl.source, '')), '') is not null)))
    into v_claims, v_unusable
    from content_draft_claims dc join claims cl on cl.id = dc.claim_id where dc.draft_id = d.id;
  if v_unusable > 0 then
    v := v || format('%s linked claim(s) are not confirmed or sourced with a source.', v_unusable);
  end if;
  if coalesce(d.search_intent, 'informational') <> 'navigational' and v_claims = 0 then
    v := v || 'The draft needs at least one confirmed or sourced claim linked.'::text;
  end if;
  return v;
end $$;

-- ── 4. Request: page type, new or refresh ───────────────────────────────────
drop function content_draft_request(uuid, text, text);
create function content_draft_request(p_plan_item_id uuid, p_page_type text default null, p_note text default null,
                                      p_page_change text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  i content_plan_items;
  d content_drafts;
  v_task uuid;
  v_kw text;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate requests a draft' using errcode = '42501';
  end if;
  select * into i from content_plan_items where id = p_plan_item_id for update;
  if i.id is null then raise exception 'No such plan item' using errcode = 'P0002'; end if;
  if i.deliverable not in ('blog', 'web_page') then
    raise exception 'Social and Business Profile items are drafted as posts, not here' using errcode = '22023';
  end if;
  if i.deliverable = 'web_page' and coalesce(p_page_type, '') not in ('service', 'location', 'use_case', 'commercial_landing', 'comparison') then
    raise exception 'Choose the page type' using errcode = '22023';
  end if;
  -- A location page only from an Authority location_page opportunity: never a
  -- service × city matrix.
  if p_page_type = 'location' and not exists (
       select 1 from authority_opportunities o where o.id = i.authority_opportunity_id and o.content_type = 'location_page') then
    raise exception 'A location page needs an Authority location_page opportunity behind it' using errcode = '22023';
  end if;
  if i.deliverable = 'web_page' then
    if coalesce(p_page_change, '') not in ('page_added', 'page_rewrite') then
      raise exception 'Say whether this is a new page or a refresh of an existing one' using errcode = '22023';
    end if;
    if p_page_change = 'page_rewrite' and i.target_url is null then
      raise exception 'A refresh names the existing page: set the plan item''s target page first' using errcode = '22023';
    end if;
    if p_page_type = 'service' and i.service_id is null then
      raise exception 'A service page names its service on the plan item' using errcode = '22023';
    end if;
    -- A comparison page when justified: an Authority opportunity, or the
    -- teammate's reason in the note.
    if p_page_type = 'comparison' and i.authority_opportunity_id is null and nullif(btrim(coalesce(p_note, '')), '') is null then
      raise exception 'A comparison page needs an Authority opportunity or a note saying why it is justified' using errcode = '22023';
    end if;
  elsif p_page_change is not null then
    raise exception 'Only a web page is a new page or a refresh' using errcode = '22023';
  end if;
  select * into d from content_drafts where plan_item_id = i.id and status = 'requested';
  if d.id is not null then
    perform fire_foundation_worker(i.client_id, 'Content draft request ' || d.id);
    return jsonb_build_object('draft_id', d.id, 'reused', true);
  end if;
  if exists (select 1 from content_drafts where plan_item_id = i.id and status in ('draft', 'in_review', 'approved')) then
    raise exception 'This item already has a draft; open it, or regenerate it from there' using errcode = '22023';
  end if;
  select keyword into v_kw from keywords where id = i.keyword_id;
  perform set_config('compass.content_draft_system', 'on', true);
  insert into content_drafts (client_id, plan_item_id, deliverable, page_type, page_change, topic, primary_keyword, keyword_id, search_intent,
                              service_id, authority_opportunity_id, target_url, request_note, requested_by)
  values (i.client_id, i.id, i.deliverable, case when i.deliverable = 'web_page' then p_page_type end,
          case when i.deliverable = 'web_page' then p_page_change end, i.topic, v_kw, i.keyword_id,
          i.search_intent, i.service_id, i.authority_opportunity_id, i.target_url, nullif(btrim(coalesce(p_note, '')), ''), task_actor())
  returning * into d;
  insert into tasks (client_id, title, notes, owner, key)
  values (i.client_id, left(format('Draft %s: %s', case i.deliverable when 'blog' then 'blog' else 'web page' end, i.topic), 200),
          format('Content draft request %s. The foundation-worker skill''s "Content draft request" playbook writes it through '
                 'the content-drafter function (brief → check → submit); the draft stops in human review and nothing is '
                 'published.', d.id),
          'CLAUDE', 'content_draft:' || d.id)
  returning id into v_task;
  update content_drafts set request_task_id = v_task where id = d.id;
  perform set_config('compass.content_draft_system', '', true);
  perform fire_foundation_worker(i.client_id, 'Content draft request ' || d.id);
  return jsonb_build_object('draft_id', d.id, 'task_id', v_task, 'reused', false);
end $$;
revoke all on function content_draft_request(uuid, text, text, text) from public, anon;
grant execute on function content_draft_request(uuid, text, text, text) to authenticated;

-- ── 5. The drafter writes the page fields ───────────────────────────────────
create or replace function content_draft_write(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  d content_drafts;
  c jsonb := p->'content';
  v_claim uuid;
begin
  if not drafter_caller_is_service() then
    raise exception 'content_draft_write runs only in the content-drafter function' using errcode = '42501';
  end if;
  perform set_config('compass.content_draft_write', 'on', true);
  select * into d from content_drafts where id = (p->>'draft_id')::uuid for update;
  if d.id is null then raise exception 'No such draft' using errcode = 'P0002'; end if;
  if d.status not in ('requested', 'draft', 'rejected') then
    raise exception 'The draft is %; nothing to write', d.status using errcode = '23514';
  end if;
  delete from content_draft_claims where draft_id = d.id;
  for v_claim in select (x)::uuid from jsonb_array_elements_text(coalesce(p->'claim_ids', '[]')) x loop
    insert into content_draft_claims (draft_id, client_id, claim_id) values (d.id, d.client_id, v_claim);
  end loop;
  update content_drafts set
    brief = p->'brief', brief_hash = p->>'brief_hash', runtime = p->>'runtime', lint = p->'lint',
    title = c->>'title', slug = c->>'slug', meta_title = c->>'meta_title', meta_description = c->>'meta_description',
    h1 = c->>'h1', outline = c->'outline', body_markdown = c->>'body_markdown', internal_links = c->'internal_links',
    cta = c->'cta', structured_data = c->'structured_data',
    page_path = case when d.deliverable = 'web_page' then c->>'page_path' end,
    page_objective = case when d.deliverable = 'web_page' then c->>'page_objective' end,
    status = case when coalesce((p->>'submit')::boolean, true) then 'in_review' else 'draft' end
  where id = d.id
  returning * into d;
  if d.request_task_id is not null then
    update tasks set status = 'done' where id = d.request_task_id and status <> 'done';
  end if;
  perform set_config('compass.content_draft_write', '', true);
  return jsonb_build_object('draft_id', d.id, 'status', d.status, 'version', d.version, 'word_count', d.word_count);
end $$;

-- ── 6. Approve: a page finalizes to ONE change_log row ──────────────────────
create or replace function content_draft_approve(p_draft_id uuid, p_version int, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d content_drafts;
  v_problems text[];
  v_snapshot jsonb;
  v_post uuid;
  v_change uuid;
  v_created boolean := false;
  v_site text;
  v_reviewer text;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate approves a draft' using errcode = '42501';
  end if;
  select * into d from content_drafts where id = p_draft_id for update;
  if d.id is null then raise exception 'No such draft' using errcode = 'P0002'; end if;
  if d.status = 'approved' and d.approved_version = p_version then
    return jsonb_build_object('draft_id', d.id, 'content_post_id', d.final_content_post_id, 'change_log_id', d.final_change_log_id, 'already', true);
  end if;
  if d.status <> 'in_review' then
    raise exception 'The draft is %; only a draft in review is approved', d.status using errcode = '23514';
  end if;
  if d.version <> p_version then
    raise exception 'The draft changed since you opened it (version % now); reload and review it again', d.version
      using errcode = '40001';
  end if;
  v_problems := content_draft_problems(d);
  if cardinality(v_problems) > 0 then
    raise exception 'The draft cannot be approved: %', array_to_string(v_problems, ' ') using errcode = '23514';
  end if;
  v_snapshot := jsonb_build_object(
    'version', d.version, 'deliverable', d.deliverable, 'page_type', d.page_type,
    'page_change', d.page_change, 'page_path', d.page_path, 'page_objective', d.page_objective,
    'title', d.title, 'slug', d.slug, 'meta_title', d.meta_title, 'meta_description', d.meta_description, 'h1', d.h1,
    'outline', d.outline, 'body_hash', d.body_hash, 'word_count', d.word_count,
    'internal_links', d.internal_links, 'cta', d.cta, 'structured_data', d.structured_data,
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', cl.id, 'claim', cl.claim, 'status', cl.status, 'source', cl.source) order by cl.id)
                         from content_draft_claims dc join claims cl on cl.id = dc.claim_id where dc.draft_id = d.id), '[]'::jsonb));

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
  -- A web page finalizes to ONE change_log row (Tom, Oct 4 2026): new page →
  -- page_added, substantial refresh → page_rewrite; a re-approval updates the
  -- same row.
  if d.deliverable = 'web_page' then
    select nullif(regexp_replace(btrim(coalesce(website_url, '')), '/+$', ''), '') into v_site from clients where id = d.client_id;
    select name into v_reviewer from team_members where id = task_actor();
    if d.final_change_log_id is null then
      insert into change_log (client_id, change_type, object_type, object_id, before, after, reasoning, evidence, status, reviewed_by, reviewed_on)
      values (d.client_id, d.page_change, 'site', d.id,
              case when d.page_change = 'page_rewrite' then jsonb_build_object('url', d.target_url) end,
              '{}'::jsonb, d.page_objective, null, 'approved', v_reviewer, now())
      returning id into v_change;
      v_created := true;
    else
      v_change := d.final_change_log_id;
    end if;
    update change_log set
      after = jsonb_build_object('url', coalesce(v_site, '') || d.page_path, 'path', d.page_path, 'title', d.title,
                                 'meta_title', d.meta_title, 'meta_description', d.meta_description, 'h1', d.h1,
                                 'page_type', d.page_type, 'objective', d.page_objective, 'word_count', d.word_count,
                                 'draft_id', d.id, 'version', d.version, 'approved_hash',
                                 'sha256:' || encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex')),
      reasoning = d.page_objective,
      evidence = (select string_agg(format('%s (%s)', cl.claim, coalesce(cl.source, cl.status::text)), '; ' order by cl.claim)
                    from content_draft_claims dc join claims cl on cl.id = dc.claim_id where dc.draft_id = d.id),
      status = 'approved', reviewed_by = v_reviewer, reviewed_on = now()
    where id = v_change;
  end if;
  update content_drafts set status = 'approved', approved_version = d.version,
         approved_hash = 'sha256:' || encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex'),
         approved_snapshot = v_snapshot, reviewed_by = task_actor(), reviewed_at = now(),
         review_note = nullif(btrim(coalesce(p_note, '')), ''), final_content_post_id = v_post, final_change_log_id = v_change
   where id = d.id;
  perform set_config('compass.content_draft_system', '', true);
  return jsonb_build_object('draft_id', d.id, 'content_post_id', v_post, 'change_log_id', v_change, 'created', v_created, 'already', false);
end $$;

-- ── 7. Reopen: the page's change_log row goes back to proposed ──────────────
create or replace function content_drafts_reopen_final() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status = 'approved' and new.status <> 'approved' and new.final_content_post_id is not null then
    update content_posts set status = 'draft' where id = new.final_content_post_id and status = 'approved';
  end if;
  -- A web page's final change_log row goes back to proposed until the page
  -- is approved again.
  if old.status = 'approved' and new.status <> 'approved' and new.final_change_log_id is not null then
    update change_log set status = 'proposed' where id = new.final_change_log_id and status = 'approved';
  end if;
  return null;
end $$;

-- ── 8. Verify ───────────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.content_draft_request(uuid,text,text)') is not null then
    raise exception '0069: the old content_draft_request must be gone';
  end if;
  if has_function_privilege('anon', 'public.content_draft_request(uuid,text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.content_draft_request(uuid,text,text,text)', 'execute') then
    raise exception '0069: content_draft_request grants are wrong';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.content_drafts_guard()'::regprocedure) then
    raise exception '0069: the guard stays security definer';
  end if;
end $$;
