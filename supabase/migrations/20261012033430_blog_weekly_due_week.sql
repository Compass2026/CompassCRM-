-- Fix cross-week planning without changing any existing draft or task.
create or replace function content_draft_open_weekly(p jsonb) returns jsonb
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
  -- A Sunday request may be due next week. The planner week follows the
  -- actual due date, so planned_date always belongs to its slot.
  v_week := date_trunc('week', coalesce(t.due_date, (now() at time zone 'America/Chicago')::date))::date;
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

  select keyword into v_kw from keywords where id = nullif(p->>'keyword_id', '')::uuid
    and client_id = t.client_id and is_active;
  if v_kw is null then
    raise exception 'Choose an active governed keyword before generating this item' using errcode = '22023';
  end if;

  -- This week's empty blog slot, or a new one.
  select * into i from content_plan_items x
   where x.client_id = t.client_id and x.week_start = v_week and x.deliverable = 'blog'
     and x.content_post_id is null and x.hold is null
     and not exists (select 1 from content_drafts y where y.plan_item_id = x.id)
   order by x.created_at limit 1 for update;
  if i.id is null then
    insert into content_plan_items (client_id, week_start, deliverable, purpose, topic, search_intent, keyword_id, service_id, planned_date, notes)
    values (t.client_id, v_week, 'blog', 'educational', left(p->>'topic', 200), p->>'search_intent',
            nullif(p->>'keyword_id', '')::uuid, nullif(p->>'service_id', '')::uuid, coalesce(t.due_date, v_week+2), 'The weekly blog (opened by the worker).')
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

