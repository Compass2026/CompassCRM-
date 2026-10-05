-- Blog Drafter v1, completion rules (Oct 4 2026; Tom's decision of Oct 4).
-- NOT APPLIED — written with its sandbox tests (content_drafts.test.sql,
-- section K) and held for approval with 0066 / 0067.
--
-- A blog counts as delivered for its week only once it is approved:
--   Planned → Ready → Drafting → In review → Approved.
-- Generation, rejection, regeneration and review never complete it, and an
-- approved draft that is reopened stops counting until it is approved again.
--
-- 1. The weekly blog (create_weekly_blog_tasks, 0062's blog_post task) now
--    goes through review. The worker opens a draft for the task with
--    content_draft_open_weekly (the content-drafter function's session only):
--    the draft fills that week's blog plan item (an empty one, or a new one),
--    and the task stays open — Billing counts it as planned — until the
--    draft is approved. content_draft_approve closes it in the same
--    transaction that creates the final content_posts row, so Billing's
--    count moves from the open task to the final row without a gap or a
--    double count. A second open for the same task returns the same draft.
-- 2. Reopening an approved draft returns its final content_posts row from
--    'approved' to 'draft' (a published row stays published): the planner
--    no longer counts it as done, and Billing — which counts every Compass
--    content_posts row that is not published as planned — counts it the
--    same as before. The weekly task stays closed; reopening it would count
--    the blog twice.
--
-- Billing is unchanged: no billing object is touched, and its counting rule
-- (0062, client_quota_usage) reads the same rows as before.
--
-- Rollback (while no weekly draft exists): restore 0067's
-- content_draft_approve and content_drafts_guard, drop
-- content_draft_open_weekly and content_drafts.source_task_id.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.content_drafts') is null then
    raise exception '0068: needs 0067 (content_drafts)';
  end if;
end $$;

-- ── 1. The weekly task a draft answers ──────────────────────────────────────
alter table content_drafts add column source_task_id uuid;
alter table content_drafts add constraint content_drafts_source_task_fk foreign key (source_task_id, client_id)
  references tasks (id, client_id) on delete set null (source_task_id);
create unique index content_drafts_source_task_key on content_drafts (source_task_id) where source_task_id is not null;
comment on column content_drafts.source_task_id is
  'The weekly blog_post task this draft answers (0068); closed when the draft is approved.';

-- ── 2. The worker opens a weekly blog draft ─────────────────────────────────
-- p: {task_id, topic, search_intent, keyword_id?, primary_keyword?, service_id?}
create function content_draft_open_weekly(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  t tasks;
  d content_drafts;
  i content_plan_items;
  v_week date := date_trunc('week', (now() at time zone 'America/Chicago'))::date;
  v_kw text;
begin
  if not drafter_caller_is_service() then
    raise exception 'content_draft_open_weekly runs only in the content-drafter function' using errcode = '42501';
  end if;
  perform set_config('compass.content_draft_write', 'on', true);
  select * into t from tasks where id = (p->>'task_id')::uuid for update;
  if t.id is null or t.key is distinct from 'blog_post' then
    raise exception 'No such weekly blog task' using errcode = 'P0002';
  end if;
  select * into d from content_drafts where source_task_id = t.id;
  if d.id is not null then
    perform set_config('compass.content_draft_write', '', true);
    return jsonb_build_object('draft_id', d.id, 'plan_item_id', d.plan_item_id, 'status', d.status, 'reused', true);
  end if;
  if t.status = 'done' then
    raise exception 'The weekly blog task is done' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p->>'topic', '')), '') is null
     or coalesce(p->>'search_intent', '') not in ('navigational', 'informational', 'commercial', 'transactional') then
    raise exception 'A weekly blog draft names its topic and search intent' using errcode = '22023';
  end if;

  -- This week's empty blog slot, or a new one.
  select * into i from content_plan_items x
   where x.client_id = t.client_id and x.week_start = v_week and x.deliverable = 'blog'
     and x.content_post_id is null and x.hold is null
     and not exists (select 1 from content_drafts y where y.plan_item_id = x.id)
   order by x.created_at limit 1 for update;
  if i.id is null then
    insert into content_plan_items (client_id, week_start, deliverable, purpose, topic, search_intent, keyword_id, service_id, notes)
    values (t.client_id, v_week, 'blog', 'educational', left(p->>'topic', 200), p->>'search_intent',
            nullif(p->>'keyword_id', '')::uuid, nullif(p->>'service_id', '')::uuid, 'The weekly blog (opened by the worker).')
    returning * into i;
  end if;
  select keyword into v_kw from keywords where id = nullif(p->>'keyword_id', '')::uuid and client_id = t.client_id;

  insert into content_drafts (client_id, plan_item_id, deliverable, topic, primary_keyword, keyword_id, search_intent, service_id,
                              source_task_id, request_note)
  values (t.client_id, i.id, 'blog', left(p->>'topic', 200), coalesce(v_kw, nullif(btrim(coalesce(p->>'primary_keyword', '')), '')),
          nullif(p->>'keyword_id', '')::uuid, p->>'search_intent', nullif(p->>'service_id', '')::uuid, t.id,
          'The weekly blog post.')
  returning * into d;
  update tasks set status = 'in_progress' where id = t.id and status = 'open';
  perform set_config('compass.content_draft_write', '', true);
  return jsonb_build_object('draft_id', d.id, 'plan_item_id', i.id, 'status', d.status, 'reused', false);
end $$;
revoke all on function content_draft_open_weekly(jsonb) from public, anon, authenticated;
grant execute on function content_draft_open_weekly(jsonb) to service_role;

-- ── 3. Approval closes the weekly task ──────────────────────────────────────
create or replace function content_draft_approve(p_draft_id uuid, p_version int, p_note text default null) returns jsonb
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

-- ── 4. Reopening un-completes the final article ─────────────────────────────
-- After 0067's guard (content_drafts_guard): an approved draft reopened to
-- draft returns its final row from approved to draft. A published row stays.
create function content_drafts_reopen_final() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status = 'approved' and new.status <> 'approved' and new.final_content_post_id is not null then
    update content_posts set status = 'draft' where id = new.final_content_post_id and status = 'approved';
  end if;
  return null;
end $$;
revoke all on function content_drafts_reopen_final() from public, anon, authenticated;
create trigger content_drafts_reopen_final after update of status on content_drafts
  for each row execute function content_drafts_reopen_final();

-- ── 5. Verify ───────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('authenticated', 'public.content_draft_open_weekly(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.content_draft_open_weekly(jsonb)', 'execute') then
    raise exception '0068: content_draft_open_weekly is the drafter''s only';
  end if;
end $$;
