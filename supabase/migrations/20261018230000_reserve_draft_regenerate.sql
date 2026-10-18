-- Reserve for on Regenerate (Oct 18 2026). Written with its sandbox test
-- (reserve_draft_regenerate.test.sql).
-- Needs 20261018220000_reserve_draft_requests (Reserve for on Generate draft)
-- and 20261015175146_content_draft_claims (tasks.claimed_by / claimed_at).
--
-- 20261018220000 let a teammate reserve a new draft request for an operator
-- session instead of the worker Routine. Regenerate on the draft page was left
-- out and still always fired the Routine, so sending a draft or a rejected
-- draft back to an operator lost the same race the Oct 16 Logic Solar request
-- did: the Routine claims the redraft before the operator hears of it.
--
-- content_draft_regenerate gains p_reserve_for (default null), with the rules
-- of content_draft_request's:
--   * null — exactly as before (0067): the draft goes back to requested, its
--     open content_draft:<id> task is reused or a new one opened unclaimed,
--     and the worker is fired.
--   * a short label (e.g. claude-operator) — the same rows, then the request
--     task is claimed for that label in the same transaction through
--     compass.task_claim (claimed_by, claimed_at = now(), status in_progress)
--     and the worker is NOT fired. The claim binds content_draft_write for the
--     usual hour; unused, it expires and the next sweep's Routine picks it up.
--   * the task is already claimed by another label within the hour — CD409
--     claimed_by_other, and nothing changes (the draft stays as it was).
-- 'worker-routine' is refused as a reservation: leaving it empty means the Routine.
--
-- Rollback: drop the three-argument function and restore 0067's
-- content_draft_regenerate(uuid, text) with its grants. Claims recorded by
-- reservations expire on their own.

-- ── 0. Preconditions ────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.content_draft_request(uuid, text, text, text)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'claimed_by') then
    raise exception 'reserve_draft_regenerate: needs 20261018220000_reserve_draft_requests and 20261015175146_content_draft_claims';
  end if;
  if to_regprocedure('public.content_draft_regenerate(uuid, text)') is null then
    raise exception 'reserve_draft_regenerate: content_draft_regenerate(uuid, text) is not the expected 0067 function';
  end if;
end $$;

-- ── 1. content_draft_regenerate, with Reserve for ──────────────────────────
-- 0067's body verbatim apart from the reservation: same refusals, same draft
-- and task rows, same fire when nothing is reserved.
drop function content_draft_regenerate(uuid, text);

create function content_draft_regenerate(p_draft_id uuid, p_note text default null, p_reserve_for text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d content_drafts;
  t tasks;
  v_task uuid;
  v_who text := nullif(btrim(coalesce(p_reserve_for, '')), '');
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate regenerates a draft' using errcode = '42501';
  end if;
  if v_who is not null and v_who !~ '^[a-z0-9][a-z0-9-]{1,39}$' then
    raise exception 'Reserve for takes a short label: lowercase letters, digits and dashes (e.g. claude-operator)' using errcode = '22023';
  end if;
  if v_who = 'worker-routine' then
    raise exception 'Leave Reserve for empty to send the request to the worker Routine' using errcode = '22023';
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
            format('Content draft request %s (regenerate). Teammate''s note: %s', d.id, coalesce(nullif(btrim(p_note), ''), '—'))
              || case when v_who is not null
                      then format(' Reserved for %s at request time: the worker Routine was not fired, and the claim binds for an hour.', v_who)
                      else '' end,
            'CLAUDE', 'content_draft:' || d.id)
    returning id into v_task;
  end if;
  update content_drafts set status = 'requested', request_task_id = v_task,
         request_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), request_note)
   where id = d.id;
  perform set_config('compass.content_draft_system', '', true);
  if v_who is null then
    perform fire_foundation_worker(d.client_id, 'Content draft request ' || d.id);
    return jsonb_build_object('draft_id', d.id, 'task_id', v_task);
  end if;

  -- reserve_draft_regenerate_v1: the claim content_draft_claim would record,
  -- made at regenerate time, and no fire. A refusal rolls the whole call back.
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
  return jsonb_build_object('draft_id', d.id, 'task_id', t.id,
                            'reserved_for', t.claimed_by, 'claimed_at', t.claimed_at, 'expires_at', t.claimed_at + interval '1 hour');
end $$;
revoke all on function content_draft_regenerate(uuid, text, text) from public, anon;
grant execute on function content_draft_regenerate(uuid, text, text) to authenticated;
comment on function content_draft_regenerate(uuid, text, text) is
  'A teammate''s Regenerate on a draft or rejected draft (0067). p_reserve_for (a short label such as claude-operator) claims the request task for that operator and does not fire the worker; null fires the worker Routine as before.';

-- ── 2. Postconditions ───────────────────────────────────────────────────────
do $$
declare
  v_src text := (select prosrc from pg_proc where oid = 'public.content_draft_regenerate(uuid, text, text)'::regprocedure);
begin
  if to_regprocedure('public.content_draft_regenerate(uuid, text)') is not null then
    raise exception 'the two-argument content_draft_regenerate must be gone (one function, one reviewed signature)';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.content_draft_regenerate(uuid, text, text)'::regprocedure)
     or not has_function_privilege('authenticated', 'public.content_draft_regenerate(uuid, text, text)', 'execute')
     or has_function_privilege('anon', 'public.content_draft_regenerate(uuid, text, text)', 'execute') then
    raise exception 'content_draft_regenerate must stay a teammate''s security-definer call';
  end if;
  if v_src not like '%reserve_draft_regenerate_v1%' or v_src not like '%post_caller_is_human()%'
     or v_src not like '%fire_foundation_worker%' or v_src not like '%compass.task_claim%' then
    raise exception 'content_draft_regenerate lost its human check, its fire or its reservation';
  end if;
end $$;
