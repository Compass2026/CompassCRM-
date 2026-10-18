-- Reserve a blog / web page draft request for an operator session (Oct 18 2026).
-- Written with its sandbox test (reserve_draft_requests.test.sql).
-- Needs 20261015175146_content_draft_claims (tasks.claimed_by / claimed_at, their guard).
--
-- On Oct 16 Tom pressed Generate on a Logic Solar blog slot meaning a Claude
-- operator session to write it. content_draft_request fired the worker
-- Routine, which claimed the request three seconds before the operator did
-- (content_draft_claim answered claimed_by_other) and submitted its own copy.
-- The claims behaved; the gap is that a teammate could not say at request
-- time who the request is for. An operator working from chat only hears of
-- the request when the teammate tells it, so it always loses that race.
--
-- content_draft_request gains p_reserve_for (default null):
--   * null — exactly as before: the request task opens unclaimed and the
--     worker is fired (a reused request fires again).
--   * a short label (e.g. claude-operator) — the request task is claimed for
--     that label in the same transaction, through the same door as
--     content_draft_claim (compass.task_claim, tasks_claim_guard): claimed_by,
--     claimed_at = now(), status in_progress. The worker is NOT fired. The
--     claim binds content_draft_write for the usual hour, so a Routine run
--     started by anything else (the daily sweep, another fire for the client)
--     gets claimed_by_other and leaves it. The operator refreshes the hour by
--     claiming with the same label (content_draft_claim) when it starts.
--     After the hour the request is anyone's again; the next sweep's Routine
--     picks it up, so a reservation nobody acts on is late, never lost.
--   * reserving a request that already exists (a second Generate) records
--     the claim on its task unless another label holds it within the hour
--     (CD409 claimed_by_other, nothing changed).
-- 'worker-routine' is refused as a reservation: leaving it empty means the
-- Routine. The one-hour window is the one every writer already honours
-- (content_draft_write, content-drafter, post-drafter), so nothing else changes.
--
-- Rollback: drop the four-argument function and restore 0067's
-- content_draft_request(uuid, text, text) with its grants. Claims recorded
-- by reservations expire on their own.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.content_draft_claim(uuid, text)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'claimed_by') then
    raise exception 'reserve_draft_requests: needs 20261015175146_content_draft_claims';
  end if;
  if to_regprocedure('public.content_draft_request(uuid, text, text)') is null then
    raise exception 'reserve_draft_requests: content_draft_request(uuid, text, text) is not the expected 0067 function';
  end if;
end $$;

-- ── 1. content_draft_request, with Reserve for ─────────────────────────────
-- 0067's body verbatim apart from the reservation: same refusals, same draft
-- and task rows, same fire when nothing is reserved.
drop function content_draft_request(uuid, text, text);

create function content_draft_request(p_plan_item_id uuid, p_page_type text default null, p_note text default null,
                                      p_reserve_for text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  i content_plan_items;
  d content_drafts;
  t tasks;
  v_task uuid;
  v_kw text;
  v_keyword keywords;
  v_reused boolean := false;
  v_who text := nullif(btrim(coalesce(p_reserve_for, '')), '');
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate requests a draft' using errcode = '42501';
  end if;
  if v_who is not null and v_who !~ '^[a-z0-9][a-z0-9-]{1,39}$' then
    raise exception 'Reserve for takes a short label: lowercase letters, digits and dashes (e.g. claude-operator)' using errcode = '22023';
  end if;
  if v_who = 'worker-routine' then
    raise exception 'Leave Reserve for empty to send the request to the worker Routine' using errcode = '22023';
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
    if v_who is null then
      perform fire_foundation_worker(i.client_id, 'Content draft request ' || d.id);
      return jsonb_build_object('draft_id', d.id, 'reused', true);
    end if;
    v_task := coalesce(d.request_task_id, d.source_task_id);
    v_reused := true;
  else
    if exists (select 1 from content_drafts where plan_item_id = i.id and status in ('draft', 'in_review', 'approved')) then
      raise exception 'This item already has a draft; open it, or regenerate it from there' using errcode = '22023';
    end if;
    select * into v_keyword from keywords where id = i.keyword_id and client_id = i.client_id and is_active;
    v_kw := v_keyword.keyword;
    if v_kw is null then
      raise exception 'Choose an active governed keyword before generating this item' using errcode = '22023';
    end if;
    if (i.search_intent is not null and i.search_intent is distinct from v_keyword.intent)
       or (i.service_id is not null and i.service_id is distinct from v_keyword.service_id) then
      raise exception 'The plan must match the governed keyword intent and service' using errcode = '22023';
    end if;
    perform set_config('compass.content_draft_system', 'on', true);
    insert into content_drafts (client_id, plan_item_id, deliverable, page_type, topic, primary_keyword, keyword_id, search_intent,
                                service_id, authority_opportunity_id, target_url, request_note, requested_by)
    values (i.client_id, i.id, i.deliverable, case when i.deliverable = 'web_page' then p_page_type end, i.topic, v_kw, i.keyword_id,
            v_keyword.intent, v_keyword.service_id, i.authority_opportunity_id, i.target_url, nullif(btrim(coalesce(p_note, '')), ''), task_actor())
    returning * into d;
    insert into tasks (client_id, title, notes, owner, key)
    values (i.client_id, left(format('Draft %s: %s', case i.deliverable when 'blog' then 'blog' else 'web page' end, i.topic), 200),
            format('Content draft request %s. The foundation-worker skill''s "Content draft request" playbook writes it through '
                   'the content-drafter function (brief → check → submit); the draft stops in human review and nothing is '
                   'published.', d.id)
              || case when v_who is not null
                      then format(' Reserved for %s at request time: the worker Routine was not fired, and the claim binds for an hour.', v_who)
                      else '' end,
            'CLAUDE', 'content_draft:' || d.id)
    returning id into v_task;
    update content_drafts set request_task_id = v_task where id = d.id;
    perform set_config('compass.content_draft_system', '', true);
    if v_who is null then
      perform fire_foundation_worker(i.client_id, 'Content draft request ' || d.id);
      return jsonb_build_object('draft_id', d.id, 'task_id', v_task, 'reused', false);
    end if;
  end if;

  -- reserve_draft_requests_v1: the claim content_draft_claim would record, made
  -- at request time, and no fire.
  select * into t from tasks where id = v_task for update;
  if t.id is null or t.status = 'done' then
    raise exception 'This request has no open task to reserve' using errcode = '22023';
  end if;
  if t.claimed_by is not null and t.claimed_by <> v_who and t.claimed_at > now() - interval '1 hour' then
    raise exception 'claimed_by_other: % holds this request until %', t.claimed_by, t.claimed_at + interval '1 hour'
      using errcode = 'CD409';
  end if;
  perform set_config('compass.task_claim', 'on', true);
  update tasks set claimed_by = v_who, claimed_at = now(),
         status = case when status = 'open' then 'in_progress' else status end
   where id = t.id
  returning * into t;
  perform set_config('compass.task_claim', '', true);
  return jsonb_build_object('draft_id', d.id, 'task_id', t.id, 'reused', v_reused,
                            'reserved_for', t.claimed_by, 'claimed_at', t.claimed_at, 'expires_at', t.claimed_at + interval '1 hour');
end $$;
revoke all on function content_draft_request(uuid, text, text, text) from public, anon;
grant execute on function content_draft_request(uuid, text, text, text) to authenticated;
comment on function content_draft_request(uuid, text, text, text) is
  'A teammate''s Generate draft on a blog / web page plan item (0067). p_reserve_for (a short label such as claude-operator) claims the request task for that operator at request time and does not fire the worker; null fires the worker Routine as before.';

-- ── 2. Postconditions ───────────────────────────────────────────────────────
do $$
declare
  v_src text := (select prosrc from pg_proc where oid = 'public.content_draft_request(uuid, text, text, text)'::regprocedure);
begin
  if to_regprocedure('public.content_draft_request(uuid, text, text)') is not null then
    raise exception 'the three-argument content_draft_request must be gone (one function, one reviewed signature)';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.content_draft_request(uuid, text, text, text)'::regprocedure)
     or not has_function_privilege('authenticated', 'public.content_draft_request(uuid, text, text, text)', 'execute')
     or has_function_privilege('anon', 'public.content_draft_request(uuid, text, text, text)', 'execute') then
    raise exception 'content_draft_request must stay a teammate''s security-definer call';
  end if;
  if v_src not like '%reserve_draft_requests_v1%' or v_src not like '%post_caller_is_human()%'
     or v_src not like '%fire_foundation_worker%' or v_src not like '%compass.task_claim%' then
    raise exception 'content_draft_request lost its human check, its fire or its reservation';
  end if;
end $$;
