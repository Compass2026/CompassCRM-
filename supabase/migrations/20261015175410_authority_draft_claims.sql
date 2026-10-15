-- Binding claims on Authority draft requests (Oct 15 2026).
-- Written with its sandbox test (authority_draft_claims.test.sql).
-- Needs 20261015175146_content_draft_claims (tasks.claimed_by / claimed_at and their guard).
--
-- 20261015175146_content_draft_claims made blog draft claims binding after the Logic Solar
-- incident. The Authority draft request path (Draft with AI → post-drafter v2
-- → drafter_write) still had the advisory claim: the worker skill's
-- `update tasks set status = 'in_progress' … returning id`, which
-- drafter_write never looked at. Two sessions could both brief, check and
-- submit the same opportunity; the first submit won and the other's work was
-- thrown away with an AU409.
--
-- The same rule on the same columns:
--   * authority_draft_claim(task, claimant) records tasks.claimed_by /
--     claimed_at on an open authority_draft:<opportunity> request. It
--     succeeds when the request is unclaimed, already the claimant's, or
--     claimed more than an hour ago — the skill's stale rule.
--   * drafter_write, in Authority mode, refuses (CD409, claimed_by_other)
--     when the request task it locks is claimed by a different claimant
--     (p.claimant) within the hour. Nothing is written and no run recorded.
--   * An unclaimed request writes exactly as before. Drafts without an
--     opportunity (v1 Business Profile, Facebook) have no request task and
--     are untouched.
--
-- drafter_write is patched in place, as 20261015010350 did, so the Facebook
-- and GBP destination changes it carries stay verbatim.
-- Rollback: remove the authority_draft_claims_v1 block from drafter_write,
-- drop authority_draft_claim, restore 20261015175146's tasks_claim_guard.

-- ── 1. The claim guard names both doors ─────────────────────────────────────
create or replace function tasks_claim_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if (tg_op = 'INSERT' and (new.claimed_by is not null or new.claimed_at is not null))
     or (tg_op = 'UPDATE' and (new.claimed_by is distinct from old.claimed_by or new.claimed_at is distinct from old.claimed_at)) then
    if coalesce(current_setting('compass.task_claim', true), '') <> 'on' and not drafter_caller_is_superuser() then
      raise exception 'A task is claimed only through content_draft_claim or authority_draft_claim' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function tasks_claim_guard() from public, anon, authenticated;

-- ── 2. Claim ────────────────────────────────────────────────────────────────
-- The worker (its own SQL, postgres) and the service role only. Locks the
-- request task, which drafter_write also locks, so a claim and a write
-- serialize. A refusal is an answer, not an error: {claimed: false, reason,
-- claimed_by, expires_at}; the caller stops without drafting.
create function authority_draft_claim(p_task_id uuid, p_claimant text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t tasks;
  v_who text := nullif(btrim(coalesce(p_claimant, '')), '');
begin
  if v_who is null or length(v_who) > 80 then
    raise exception 'A claim names its claimant (a short label)' using errcode = '22023';
  end if;
  select * into t from tasks where id = p_task_id for update;
  if t.id is null or t.key not like 'authority\_draft:%' then
    raise exception 'No such Draft with AI request' using errcode = 'P0002';
  end if;
  if t.status not in ('open', 'in_progress') then
    return jsonb_build_object('claimed', false, 'reason', 'request_not_open', 'task_status', t.status, 'task_id', t.id);
  end if;
  if t.claimed_by is not null and t.claimed_by <> v_who and t.claimed_at > now() - interval '1 hour' then
    return jsonb_build_object('claimed', false, 'reason', 'claimed_by_other', 'task_id', t.id,
                              'claimed_by', t.claimed_by, 'claimed_at', t.claimed_at, 'expires_at', t.claimed_at + interval '1 hour');
  end if;
  perform set_config('compass.task_claim', 'on', true);
  update tasks set claimed_by = v_who, claimed_at = now(),
         status = case when status = 'open' then 'in_progress' else status end
   where id = t.id
  returning * into t;
  perform set_config('compass.task_claim', '', true);
  return jsonb_build_object('claimed', true, 'task_id', t.id, 'claimed_by', t.claimed_by, 'claimed_at', t.claimed_at,
                            'expires_at', t.claimed_at + interval '1 hour');
end $$;
revoke all on function authority_draft_claim(uuid, text) from public, anon, authenticated;
grant execute on function authority_draft_claim(uuid, text) to service_role;

-- ── 3. drafter_write honours a live claim on the request ────────────────────
-- Right after the request task is locked (0053's not_requested check). p.claimant
-- is the writer's label; a request nobody claimed (or claimed over an hour
-- ago) writes as before.
do $migration$
declare
  definition text := pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
  anchor text := $anchor$      raise exception 'authority_conflict not_requested: No open Draft with AI request from a teammate for this opportunity' using errcode = 'AU409';
    end if;
$anchor$;
  gate text := $gate$    -- authority_draft_claims_v1: a live claim on the request binds the write.
    if v_req.claimed_by is not null and v_req.claimed_at > now() - interval '1 hour'
       and v_req.claimed_by is distinct from nullif(btrim(coalesce(p->>'claimant', '')), '') then
      raise exception 'claimed_by_other: % holds this Draft with AI request until %', v_req.claimed_by, v_req.claimed_at + interval '1 hour'
        using errcode = 'CD409';
    end if;
$gate$;
begin
  if strpos(definition, 'authority_draft_claims_v1') > 0 then return; end if;
  if strpos(definition, 'drafter_gbp_destination_v1') = 0
     or (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) then
    raise exception 'Unexpected drafter_write definition; review before applying the Authority claim gate';
  end if;
  execute replace(definition, anchor, anchor || gate);
end;
$migration$;

-- ── 4. Postconditions ───────────────────────────────────────────────────────
do $$
declare
  v_write text := (select prosrc from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure);
begin
  if has_function_privilege('authenticated', 'public.authority_draft_claim(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.authority_draft_claim(uuid, text)', 'execute') then
    raise exception 'authority_draft_claim is the worker''s and the drafter''s only';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.drafter_write(jsonb)'::regprocedure)
     or has_function_privilege('authenticated', 'public.drafter_write(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.drafter_write(jsonb)', 'execute') then
    raise exception 'drafter_write must stay the post-drafter''s, with the caller''s rights';
  end if;
  if v_write not like '%authority_draft_claims_v1%' or v_write not like '%drafter_gbp_destination_v1%'
     or v_write not like '%authority_conflict not_requested%' or v_write not like '%Only a Facebook draft names a social account%' then
    raise exception 'drafter_write lost the claim gate or an earlier change';
  end if;
end $$;
