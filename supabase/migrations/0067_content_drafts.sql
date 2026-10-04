-- Blog Drafter v1, and the foundation the Web Page Drafter reuses
-- (Oct 4 2026; Production MVP sprint; Tom's architecture decision of Oct 4).
-- NOT APPLIED — written with its sandbox tests (content_drafts.test.sql) and
-- held for approval. Needs 0065 (content_plan_items) and 0066 ('approved').
--
--   Planner / Authority → content_draft_request (a teammate) → the worker
--   writes it through the content-drafter function → content_draft_write
--   (the drafter session: lint passed, claims linked, status in_review) →
--   a teammate approves (content_draft_approve) → ONE content_posts row,
--   status 'approved' → Copy / Markdown export → published by hand.
--
-- Decisions this implements:
--   * content_drafts is mutable and separate from content_posts. A draft may
--     be generated, rejected, revised, edited and regenerated any number of
--     times; none of that touches content_posts, so Billing's monthly quota
--     (0062 counts content_posts) never sees a draft attempt.
--   * Approval is the only way a blog becomes final, and it is idempotent:
--     content_draft_approve locks the draft, creates the content_posts row
--     the first time and updates that same row on a later re-approval
--     (final_content_post_id is unique). One draft can never make two rows.
--     The plan item, when there is one, links to the final row.
--   * Web pages use the same lifecycle; approval records the approval and
--     creates no final record yet (the target — a change_log page_added /
--     page_rewrite row, which Billing already counts — waits for Tom).
--   * Truth stays relational: content_draft_claims links each claim the
--     draft stands on (the client's own, usable: confirmed, or sourced with
--     a source); the approval snapshot copies their text and source. Lint
--     (the post-drafter's factual detectors) runs in the function before any
--     write; its result is recorded on the draft.
--   * Who writes what:
--       - a teammate requests, edits a draft's content while it is a draft or
--         rejected, submits, withdraws, approves, rejects, reopens, deletes
--         an unapproved draft;
--       - generated content arrives only through content_draft_write, in the
--         content-drafter function's session (authenticator + service_role,
--         as 0047's drafter session); the worker's own SQL cannot write it;
--       - only a signed-in teammate approves or rejects (post_caller_is_human).
--   * version counts content changes (generation or edit); approval pins the
--     version the teammate saw, so a draft changed meanwhile is not approved.
--   * Grounding (content_draft_problems), checked at submit and approval:
--     title, slug, meta title (≤ 70), meta description (≤ 170), H1 and body
--     present; a blog body of at least 300 words; every linked claim usable;
--     an informational, commercial or transactional draft stands on at least
--     one usable claim.
--
-- The planner's board (0065's view) is replaced to read drafts: an item's
-- latest draft in review → in_review, approved → approved, requested / draft /
-- rejected → drafting; the final content_posts row approved → approved,
-- published → delivered.
--
-- Access: team only (is_team()); the functions are revoked from public and
-- anon. Rollback (while no draft is approved): restore 0065's view, drop the
-- functions, content_draft_claims and content_drafts.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.content_plan_items') is null then
    raise exception '0067: needs 0065 (content_plan_items)';
  end if;
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                  where t.typname = 'content_status' and e.enumlabel = 'approved') then
    raise exception '0067: needs 0066 (content_status approved)';
  end if;
  if to_regclass('public.content_drafts') is not null then
    raise exception '0067: content_drafts already exists';
  end if;
end $$;

-- ── 1. Drafts ───────────────────────────────────────────────────────────────
create table content_drafts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  plan_item_id uuid,
  deliverable text not null check (deliverable in ('blog', 'web_page')),
  page_type text check (page_type in ('service', 'location', 'use_case', 'commercial_landing', 'comparison')),
  status text not null default 'requested'
    check (status in ('requested', 'draft', 'in_review', 'approved', 'rejected')),
  version int not null default 0 check (version >= 0),

  -- The brief (what was asked)
  topic text not null check (length(btrim(topic)) between 1 and 200),
  primary_keyword text check (primary_keyword is null or length(btrim(primary_keyword)) between 1 and 120),
  keyword_id uuid,
  search_intent text check (search_intent in ('navigational', 'informational', 'commercial', 'transactional')),
  service_id uuid,
  authority_opportunity_id uuid,
  target_url text check (target_url is null or target_url ~ '^https?://\S+$'),
  request_note text check (request_note is null or length(request_note) <= 2000),
  brief jsonb,
  brief_hash text check (brief_hash is null or brief_hash ~ '^sha256:[0-9a-f]{64}$'),

  -- The draft (what was written)
  title text check (title is null or length(btrim(title)) between 1 and 200),
  slug text check (slug is null or (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 100)),
  meta_title text check (meta_title is null or length(meta_title) <= 120),
  meta_description text check (meta_description is null or length(meta_description) <= 320),
  h1 text check (h1 is null or length(h1) <= 200),
  outline jsonb check (outline is null or jsonb_typeof(outline) = 'array'),
  body_markdown text check (body_markdown is null or length(body_markdown) <= 60000),
  internal_links jsonb check (internal_links is null or jsonb_typeof(internal_links) = 'array'),
  cta jsonb check (cta is null or jsonb_typeof(cta) = 'object'),
  structured_data jsonb,
  body_hash text check (body_hash is null or body_hash ~ '^[0-9a-f]{64}$'),
  word_count int check (word_count is null or word_count >= 0),
  author_kind text check (author_kind in ('drafter', 'team')),
  runtime text check (runtime is null or length(btrim(runtime)) between 1 and 80),
  lint jsonb,

  -- The request and the review
  request_task_id uuid,
  requested_by uuid references team_members(id) on delete set null,
  submitted_at timestamptz,
  reviewed_by uuid references team_members(id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or length(review_note) <= 2000),
  approved_version int,
  approved_hash text check (approved_hash is null or approved_hash ~ '^sha256:[0-9a-f]{64}$'),
  approved_snapshot jsonb,
  final_content_post_id uuid,

  created_by uuid references team_members(id) on delete set null,
  updated_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint content_drafts_id_client_key unique (id, client_id),
  constraint content_drafts_plan_item_fk foreign key (plan_item_id, client_id)
    references content_plan_items (id, client_id) on delete set null (plan_item_id),
  constraint content_drafts_keyword_fk foreign key (keyword_id, client_id) references keywords (id, client_id),
  constraint content_drafts_service_fk foreign key (service_id, client_id) references services (id, client_id),
  constraint content_drafts_opportunity_fk foreign key (authority_opportunity_id, client_id)
    references authority_opportunities (id, client_id),
  constraint content_drafts_task_fk foreign key (request_task_id, client_id)
    references tasks (id, client_id) on delete set null (request_task_id),
  constraint content_drafts_final_fk foreign key (final_content_post_id, client_id)
    references content_posts (id, client_id) on delete set null (final_content_post_id),
  constraint content_drafts_page_type_shape check ((deliverable = 'web_page') = (page_type is not null)),
  constraint content_drafts_final_blog_only check (final_content_post_id is null or deliverable = 'blog'),
  constraint content_drafts_approval_shape check (
    (status = 'approved') = (approved_version is not null and approved_hash is not null and approved_snapshot is not null
                             and reviewed_by is not null and reviewed_at is not null)),
  constraint content_drafts_rejection_note check (status <> 'rejected' or review_note is not null),
  constraint content_drafts_written check (status = 'requested' or (title is not null and body_markdown is not null))
);
comment on table content_drafts is
  'Blog / web page drafts (0067): the brief, the written draft, its lint and claims, and its review. Mutable; only an approved blog becomes a content_posts row (content_draft_approve).';
create unique index content_drafts_final_key on content_drafts (final_content_post_id) where final_content_post_id is not null;
create index content_drafts_client_idx on content_drafts (client_id, updated_at desc);
create index content_drafts_plan_item_idx on content_drafts (plan_item_id, updated_at desc) where plan_item_id is not null;
-- One live request per plan item: a second Generate reuses it.
create unique index content_drafts_one_request_per_item on content_drafts (plan_item_id)
  where plan_item_id is not null and status = 'requested';

create table content_draft_claims (
  draft_id uuid not null,
  client_id uuid not null,
  claim_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (draft_id, claim_id),
  constraint content_draft_claims_draft_fk foreign key (draft_id, client_id) references content_drafts (id, client_id) on delete cascade,
  constraint content_draft_claims_claim_fk foreign key (claim_id) references claims (id)
);
comment on table content_draft_claims is 'The governed claims a content draft stands on (0067). Same client as the draft (checked by the guard).';

-- ── 2. Who is writing ───────────────────────────────────────────────────────
create function content_drafter_session_active() returns boolean
language sql stable set search_path = public as $$
  select drafter_caller_is_service() and coalesce(current_setting('compass.content_draft_write', true), '') = 'on'
$$;
revoke all on function content_drafter_session_active() from public, anon, authenticated;

-- What a draft cannot be approved or submitted with.
-- Security invoker: a teammate and the drafter session read claims through
-- their own access; the guards (definer) call it as the table owner.
create function content_draft_problems(d content_drafts) returns text[]
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
  elsif d.deliverable = 'blog' and coalesce(d.word_count, 0) < 300 then v := v || 'A blog body is at least 300 words.'::text; end if;
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
revoke all on function content_draft_problems(content_drafts) from public, anon;
grant execute on function content_draft_problems(content_drafts) to authenticated, service_role;

-- ── 3. Guards ───────────────────────────────────────────────────────────────
create function content_drafts_guard() returns trigger
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
     and (to_jsonb(new) - array['plan_item_id', 'request_task_id', 'final_content_post_id'])
       = (to_jsonb(old) - array['plan_item_id', 'request_task_id', 'final_content_post_id']) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not (v_system or v_drafter or v_super) then
      raise exception 'Drafts are created by a Generate request or the content-drafter function' using errcode = '42501';
    end if;
    new.created_at := now();
    new.created_by := coalesce(new.created_by, task_actor());
  else
    if (new.id, new.client_id, new.deliverable, new.created_at, new.created_by)
       is distinct from (old.id, old.client_id, old.deliverable, old.created_at, old.created_by) then
      raise exception 'A draft keeps its client and kind' using errcode = '23514';
    end if;
    v_content_changed := (new.title, new.slug, new.meta_title, new.meta_description, new.h1, new.outline, new.body_markdown,
                          new.internal_links, new.cta, new.structured_data)
                         is distinct from (old.title, old.slug, old.meta_title, old.meta_description, old.h1, old.outline,
                                           old.body_markdown, old.internal_links, old.cta, old.structured_data);
    -- The brief and the drafter's own record are the drafter's.
    if not (v_drafter or v_system or v_super) and (
         (new.brief, new.brief_hash, new.lint, new.runtime) is distinct from (old.brief, old.brief_hash, old.lint, old.runtime)
         or new.request_task_id is distinct from old.request_task_id) then
      raise exception 'The brief and lint are written by the content-drafter function' using errcode = '42501';
    end if;
    -- Approval fields only through content_draft_approve (a reopen clears
    -- them below); review stamps only through a transition.
    if not (v_system or v_super) then
      if (new.approved_version, new.approved_hash, new.approved_snapshot, new.final_content_post_id)
         is distinct from (old.approved_version, old.approved_hash, old.approved_snapshot, old.final_content_post_id) then
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
revoke all on function content_drafts_guard() from public, anon, authenticated;
create trigger content_drafts_guard before insert or update or delete on content_drafts
  for each row execute function content_drafts_guard();

create function content_draft_claims_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d content_drafts;
  c claims;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from content_drafts where id = old.draft_id) then return old; end if;
    select * into d from content_drafts where id = old.draft_id;
  else
    select * into d from content_drafts where id = new.draft_id;
    select * into c from claims where id = new.claim_id;
    if c.client_id is distinct from d.client_id or new.client_id is distinct from d.client_id then
      raise exception 'A draft stands only on its own client''s claims' using errcode = '23514';
    end if;
  end if;
  if not (content_drafter_session_active() or drafter_caller_is_superuser()
          or (post_caller_is_human() and d.status in ('draft', 'rejected'))) then
    raise exception 'A draft''s claims change with its content: by the drafter, or by a teammate while it is a draft'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function content_draft_claims_guard() from public, anon, authenticated;
create trigger content_draft_claims_guard before insert or delete on content_draft_claims
  for each row execute function content_draft_claims_guard();

-- ── 4. Request (Generate) and regenerate ────────────────────────────────────
-- content_draft_request, content_draft_regenerate and content_draft_approve
-- are security definer and executable by authenticated (each opens a task,
-- fires the worker or writes content_posts atomically, past the guards);
-- each refuses anyone but a signed-in teammate first. They are on the
-- portal suite's reviewed list (portal_access.test.sql A7 / D11g).
-- A teammate's Generate on a blog / web page plan item: one request per item
-- (a second call reuses it), the brief inputs copied from the item, a CLAUDE
-- task the worker's "Content draft request" playbook works, and a fire.
create function content_draft_request(p_plan_item_id uuid, p_page_type text default null, p_note text default null)
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
  insert into content_drafts (client_id, plan_item_id, deliverable, page_type, topic, primary_keyword, keyword_id, search_intent,
                              service_id, authority_opportunity_id, target_url, request_note, requested_by)
  values (i.client_id, i.id, i.deliverable, case when i.deliverable = 'web_page' then p_page_type end, i.topic, v_kw, i.keyword_id,
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
revoke all on function content_draft_request(uuid, text, text) from public, anon;
grant execute on function content_draft_request(uuid, text, text) to authenticated;

-- Regenerate: a draft or rejected draft goes back to the drafter with the
-- teammate's note; its content stays until the new one replaces it.
create function content_draft_regenerate(p_draft_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d content_drafts;
  v_task uuid;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate regenerates a draft' using errcode = '42501';
  end if;
  select * into d from content_drafts where id = p_draft_id for update;
  if d.id is null then raise exception 'No such draft' using errcode = 'P0002'; end if;
  if d.status not in ('draft', 'rejected') then
    raise exception 'Withdraw or reopen the draft first (it is %)', d.status using errcode = '22023';
  end if;
  perform set_config('compass.content_draft_system', 'on', true);
  select id into v_task from tasks where client_id = d.client_id and key = 'content_draft:' || d.id and status <> 'done';
  if v_task is null then
    insert into tasks (client_id, title, notes, owner, key)
    values (d.client_id, left(format('Redraft: %s', d.topic), 200),
            format('Content draft request %s (regenerate). Teammate''s note: %s', d.id, coalesce(nullif(btrim(p_note), ''), '—')),
            'CLAUDE', 'content_draft:' || d.id)
    returning id into v_task;
  end if;
  update content_drafts set status = 'requested', request_task_id = v_task,
         request_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), request_note)
   where id = d.id;
  perform set_config('compass.content_draft_system', '', true);
  perform fire_foundation_worker(d.client_id, 'Content draft request ' || d.id);
  return jsonb_build_object('draft_id', d.id, 'task_id', v_task);
end $$;
revoke all on function content_draft_regenerate(uuid, text) from public, anon;
grant execute on function content_draft_regenerate(uuid, text) to authenticated;

-- ── 5. The drafter's write ──────────────────────────────────────────────────
-- p: {draft_id, brief, brief_hash, runtime, lint, claim_ids, content: {title,
--     slug, meta_title, meta_description, h1, outline, body_markdown,
--     internal_links, cta, structured_data}, submit (default true)}
-- Only the content-drafter function's session (lint has passed there).
create function content_draft_write(p jsonb) returns jsonb
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
    status = case when coalesce((p->>'submit')::boolean, true) then 'in_review' else 'draft' end
  where id = d.id
  returning * into d;
  if d.request_task_id is not null then
    update tasks set status = 'done' where id = d.request_task_id and status <> 'done';
  end if;
  perform set_config('compass.content_draft_write', '', true);
  return jsonb_build_object('draft_id', d.id, 'status', d.status, 'version', d.version, 'word_count', d.word_count);
end $$;
revoke all on function content_draft_write(jsonb) from public, anon, authenticated;
grant execute on function content_draft_write(jsonb) to service_role;

-- ── 6. Approve and finalize (idempotent) ────────────────────────────────────
create function content_draft_approve(p_draft_id uuid, p_version int, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d content_drafts;
  v_problems text[];
  v_snapshot jsonb;
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
  v_problems := content_draft_problems(d);
  if cardinality(v_problems) > 0 then
    raise exception 'The draft cannot be approved: %', array_to_string(v_problems, ' ') using errcode = '23514';
  end if;
  v_snapshot := jsonb_build_object(
    'version', d.version, 'deliverable', d.deliverable, 'page_type', d.page_type,
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

-- ── 7. The planner's board reads drafts ─────────────────────────────────────
create or replace view content_plan_board with (security_invoker = true) as
select i.*,
  case
    when i.hold = 'blocked' then 'blocked'
    when i.hold = 'delivered' or sp.publish_status = 'published' or cp.status = 'published' then 'delivered'
    when sp.review_status = 'approved' or cp.status = 'approved' or dr.status = 'approved' then 'approved'
    when sp.review_status = 'in_review' or cp.status = 'review' or dr.status = 'in_review' then 'in_review'
    when sp.id is not null or cp.id is not null or dr.id is not null
      or (i.authority_opportunity_id is not null and exists (
            select 1 from tasks t where t.client_id = i.client_id
               and t.key = 'authority_draft:' || i.authority_opportunity_id and t.status <> 'done')) then 'drafting'
    when i.search_intent is not null
      and (i.service_id is not null or i.authority_opportunity_id is not null or i.deliverable = 'blog') then 'ready_to_generate'
    else 'planned'
  end as status,
  sp.review_status as post_review_status,
  sp.publish_status as post_publish_status,
  sp.published_url as post_published_url,
  cp.status::text as content_status,
  cp.url as content_url,
  dr.id as draft_id,
  dr.status as draft_status
from content_plan_items i
left join social_posts sp on sp.id = i.social_post_id
left join content_posts cp on cp.id = i.content_post_id
left join lateral (
  select x.id, x.status from content_drafts x where x.plan_item_id = i.id order by x.updated_at desc limit 1
) dr on true;

-- ── 8. Access ───────────────────────────────────────────────────────────────
alter table content_drafts enable row level security;
create policy "team reads drafts" on content_drafts for select to authenticated using ((select is_team()));
create policy "team edits drafts" on content_drafts for update to authenticated using ((select is_team())) with check ((select is_team()));
create policy "team deletes drafts" on content_drafts for delete to authenticated using ((select is_team()));
revoke all on content_drafts from public, anon;
revoke insert, truncate, references, trigger on content_drafts from authenticated;
grant select, update, delete on content_drafts to authenticated;
grant all on content_drafts to service_role;

alter table content_draft_claims enable row level security;
create policy "team reads draft claims" on content_draft_claims for select to authenticated using ((select is_team()));
create policy "team links draft claims" on content_draft_claims for insert to authenticated with check ((select is_team()));
create policy "team unlinks draft claims" on content_draft_claims for delete to authenticated using ((select is_team()));
revoke all on content_draft_claims from public, anon;
revoke update, truncate, references, trigger on content_draft_claims from authenticated;
grant select, insert, delete on content_draft_claims to authenticated;
grant all on content_draft_claims to service_role;

-- ── 9. Verify ───────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_policies where tablename in ('content_drafts', 'content_draft_claims')
              and (coalesce(qual, with_check) not like '%is_team()%')) then
    raise exception '0067: every policy reads is_team()';
  end if;
  if has_table_privilege('anon', 'public.content_drafts', 'select') or has_table_privilege('anon', 'public.content_draft_claims', 'select') then
    raise exception '0067: anon must not read drafts';
  end if;
  if has_function_privilege('anon', 'public.content_draft_approve(uuid,integer,text)', 'execute')
     or has_function_privilege('authenticated', 'public.content_draft_write(jsonb)', 'execute') then
    raise exception '0067: function grants are wrong';
  end if;
  if (select array_agg(c) from unnest((select reloptions from pg_class where oid = 'public.content_plan_board'::regclass)) c)
     is distinct from array['security_invoker=true'] then
    raise exception '0067: content_plan_board must stay security invoker';
  end if;
end $$;
