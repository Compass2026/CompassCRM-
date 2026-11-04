-- Weekly blog slot presets bind the draft (Nov 4 2026). Needs
-- 20261027191343_weekly_social_slots (the core keyword gate on this function).
-- Sandbox suite: supabase/tests/sandbox/weekly_blog_slot_presets.test.sql.
-- Rollback: supabase/rollback/20261104160000_weekly_blog_slot_presets.down.sql.
--
-- A teammate set a weekly blog slot's topic, search intent, service, keyword
-- and notes on the Planner. The weekly blog_post task names that slot
-- (plan_item:<id>), but the worker opened the draft with a keyword and topic
-- of its own choosing, and content_draft_open_weekly accepted it: it bound
-- the named slot without comparing the payload to the slot's plan, and wrote
-- request_note = 'The weekly blog post.', dropping the slot's notes. Drafts
-- landed on unrelated keywords in slots planned for specific ones.
--
-- For a task that names its slot:
--   keyword  the slot's keyword_id, when set, must be the payload's, else
--            22023 'slot_keyword_mismatch: …' naming the slot's keyword.
--   intent   the slot's search_intent and service_id, when set, must be the
--   service  payload's, else 22023 'slot_plan_mismatch: …'.
--   topic    the slot's topic becomes the draft's topic unless it is the
--            standard's placeholder ('Blog · <site> · week of <Mon D, YYYY>',
--            or the monthly standard's 'Blog · <site> · <Month YYYY>').
--   notes    the slot's notes become the draft's request_note (the brief's
--            request). The standard's placeholder ('Opened by the weekly /
--            monthly delivery standard (vN). Set the topic, intent, service
--            and keyword before drafting.') is not a request: a note that is
--            only the placeholder, or empty, gives 'The weekly blog post.' as
--            before; a note that starts with it keeps what a teammate wrote
--            after it (the placeholder removed, trimmed); any other note is
--            kept verbatim.
-- The checks run after the reuse and done checks and before the keyword
-- gates, so a retry still returns the task's draft and a refusal names the
-- slot's plan. A slot without presets, and a task that names no slot, open
-- exactly as before; nothing else in the function changes.
--
-- The edit is guarded: the function must carry the md5 of its
-- 20261027191343 definition (6d4e4f67c7f8d478760941ae5672f28a, as replayed and
-- as in production on Nov 4 2026) and each anchor must appear exactly once.
-- The marker slot_presets_v1 makes a rerun a no-op.

do $migration$
declare
  target text := 'public.content_draft_open_weekly(jsonb)';
  expected text := '6d4e4f67c7f8d478760941ae5672f28a';
  edits text[][] := array[
    array[$a$  select keyword into v_kw from keywords where id = nullif(p->>'keyword_id', '')::uuid
    and client_id = t.client_id and is_active;
$a$, $b$  -- slot_presets_v1 (20261104160000): a slot a teammate planned binds the
  -- draft. Its keyword, intent and service, where set, are the ones opened.
  select * into i from content_plan_items x
   where x.id = substring(coalesce(t.notes, '') from 'plan_item:([0-9a-f-]{36})')::uuid
     and x.client_id = t.client_id for update;
  if i.keyword_id is not null and nullif(p->>'keyword_id', '')::uuid is distinct from i.keyword_id then
    raise exception 'slot_keyword_mismatch: the blog slot this task names is planned for the keyword "%" (%); open it with that keyword, the slot''s topic, intent and service',
      coalesce((select k.keyword from keywords k where k.id = i.keyword_id and k.client_id = t.client_id), 'unknown'), i.keyword_id
      using errcode = '22023';
  elsif i.search_intent is not null and p->>'search_intent' is distinct from i.search_intent then
    raise exception 'slot_plan_mismatch: the blog slot this task names is planned for % search intent, not %', i.search_intent, p->>'search_intent'
      using errcode = '22023';
  elsif i.service_id is not null and nullif(p->>'service_id', '')::uuid is distinct from i.service_id then
    raise exception 'slot_plan_mismatch: the blog slot this task names is planned for the service "%" (%)',
      coalesce((select s.name from services s where s.id = i.service_id and s.client_id = t.client_id), 'unknown'), i.service_id
      using errcode = '22023';
  end if;
  select keyword into v_kw from keywords where id = nullif(p->>'keyword_id', '')::uuid
    and client_id = t.client_id and is_active;
$b$],
    array[$a$  values (t.client_id, i.id, 'blog', left(p->>'topic', 200), coalesce(v_kw, nullif(btrim(coalesce(p->>'primary_keyword', '')), '')),
          nullif(p->>'keyword_id', '')::uuid, p->>'search_intent', nullif(p->>'service_id', '')::uuid, t.id,
          'The weekly blog post.')
$a$, $b$  -- slot_presets_v1: a named slot's own topic and notes, unless they are the standard's placeholders.
  -- Notes that begin with the standard's placeholder keep what a teammate wrote after it.
  values (t.client_id, i.id, 'blog',
          left(case when v_slot is not null and nullif(btrim(coalesce(i.topic, '')), '') is not null
                         and i.topic !~ '^Blog · .+ · (week of [A-Z][a-z]{2} [0-9]{1,2}, [0-9]{4}|[A-Z][a-z]+ [0-9]{4})$'
                    then i.topic else p->>'topic' end, 200),
          coalesce(v_kw, nullif(btrim(coalesce(p->>'primary_keyword', '')), '')),
          nullif(p->>'keyword_id', '')::uuid, p->>'search_intent', nullif(p->>'service_id', '')::uuid, t.id,
          case when v_slot is null then 'The weekly blog post.'
               when coalesce(i.notes, '') ~ '^\s*Opened by the (weekly|monthly) delivery standard \(v[0-9]+\)\.'
                 then coalesce(nullif(btrim(regexp_replace(i.notes,
                        '^\s*Opened by the (weekly|monthly) delivery standard \(v[0-9]+\)\.(\s*Set the topic, intent, service and keyword before drafting\.)?',
                        ''), E' \t\r\n'), ''), 'The weekly blog post.')
               when nullif(btrim(coalesce(i.notes, '')), '') is not null then i.notes
               else 'The weekly blog post.' end)
$b$]];
  definition text := pg_get_functiondef(target::regprocedure);
  i int;
begin
  if strpos(definition, 'slot_presets_v1') > 0 then return; end if;
  if md5(definition) <> expected then
    raise exception 'Unexpected % definition (md5 %); review before applying the slot presets', target, md5(definition);
  end if;
  for i in 1..array_length(edits, 1) loop
    if (length(definition) - length(replace(definition, edits[i][1], ''))) <> length(edits[i][1]) then
      raise exception 'Unexpected % definition (edit %); review before applying the slot presets', target, i;
    end if;
    definition := replace(definition, edits[i][1], edits[i][2]);
  end loop;
  execute definition;
end;
$migration$;

-- ── Postconditions ──────────────────────────────────────────────────────────
do $$
declare
  definition text := pg_get_functiondef('public.content_draft_open_weekly(jsonb)'::regprocedure);
begin
  if strpos(definition, 'slot_presets_v1') = 0 or strpos(definition, 'core_keyword_weekly_v1') = 0
     or strpos(definition, 'slot_keyword_mismatch:') = 0 or strpos(definition, 'slot_plan_mismatch:') = 0 then
    raise exception 'content_draft_open_weekly was not updated, or lost its core keyword gate';
  end if;
  if has_function_privilege('authenticated', 'public.content_draft_open_weekly(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.content_draft_open_weekly(jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.content_draft_open_weekly(jsonb)', 'execute') then
    raise exception 'content_draft_open_weekly is the drafter''s only';
  end if;
end $$;
