-- Rollback of 20261104160000_weekly_blog_slot_presets.sql. Run as one
-- transaction. Restores content_draft_open_weekly exactly as 20261027191343
-- left it (md5 of pg_get_functiondef, as replayed and in production on Nov 4
-- 2026: 6d4e4f67c7f8d478760941ae5672f28a): a named slot's keyword, intent and
-- service are no longer compared with the payload, and the draft takes the
-- payload's topic and 'The weekly blog post.' as its request note again.
-- Drafts opened in between keep their topic and request note; nothing is
-- deleted.

-- Each edit is {original, presets}, exactly as the migration made it; undone
-- last-first.
do $restore$
declare
  target text := 'public.content_draft_open_weekly(jsonb)';
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
  def text := pg_get_functiondef(target::regprocedure);
  i int;
begin
  for i in reverse array_length(edits, 1)..1 loop
    if strpos(def, edits[i][2]) = 0 then
      raise exception '% does not carry slot presets edit % as written; restore it by hand', target, i;
    end if;
    def := replace(def, edits[i][2], edits[i][1]);
  end loop;
  execute def;
end $restore$;

do $verify$
begin
  if md5(pg_get_functiondef('public.content_draft_open_weekly(jsonb)'::regprocedure)) <> '6d4e4f67c7f8d478760941ae5672f28a' then
    raise exception 'rollback 20261104160000: content_draft_open_weekly was not restored exactly';
  end if;
  if has_function_privilege('authenticated', 'public.content_draft_open_weekly(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.content_draft_open_weekly(jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.content_draft_open_weekly(jsonb)', 'execute') then
    raise exception 'rollback 20261104160000: content_draft_open_weekly is the drafter''s only';
  end if;
end $verify$;
