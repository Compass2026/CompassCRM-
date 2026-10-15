-- Binding claims on blog draft work (Oct 15 2026). See PR #165.
-- Now a claim records who holds it and the write boundary honours it:
--   * tasks.claimed_by / claimed_at, set only by content_draft_claim(draft, claimant).
--   * content_draft_write refuses (CD409, claimed_by_other) when that task is
--     claimed by a different claimant (p.claimant) within the hour.
--   * An unclaimed task writes exactly as before.
-- Rollback: restore 0067's content_draft_write, drop content_draft_claim,
-- the tasks_ab_claim_guard trigger and function, and the two columns.

alter table tasks add column claimed_by text check (claimed_by is null or length(claimed_by) between 1 and 80);
alter table tasks add column claimed_at timestamptz;
comment on column tasks.claimed_by is
  'Who is working this task (a short label: worker-routine, an operator session). Set only by content_draft_claim; binding at content_draft_write for an hour.';

create function tasks_claim_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if (tg_op = 'INSERT' and (new.claimed_by is not null or new.claimed_at is not null))
     or (tg_op = 'UPDATE' and (new.claimed_by is distinct from old.claimed_by or new.claimed_at is distinct from old.claimed_at)) then
    if coalesce(current_setting('compass.task_claim', true), '') <> 'on' and not drafter_caller_is_superuser() then
      raise exception 'A task is claimed only through content_draft_claim' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function tasks_claim_guard() from public, anon, authenticated;
create trigger tasks_ab_claim_guard before insert or update on tasks
  for each row execute function tasks_claim_guard();

create function content_draft_claim(p_draft_id uuid, p_claimant text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d content_drafts;
  t tasks;
  v_who text := nullif(btrim(coalesce(p_claimant, '')), '');
begin
  if v_who is null or length(v_who) > 80 then
    raise exception 'A claim names its claimant (a short label)' using errcode = '22023';
  end if;
  select * into d from content_drafts where id = p_draft_id for update;
  if d.id is null then raise exception 'No such draft' using errcode = 'P0002'; end if;
  select * into t from tasks where id = coalesce(d.request_task_id, d.source_task_id) for update;
  if t.id is null then raise exception 'This draft has no task to claim' using errcode = 'P0002'; end if;
  if d.status not in ('requested', 'draft', 'rejected') or t.status = 'done' then
    return jsonb_build_object('claimed', false, 'reason', 'draft_not_open', 'draft_status', d.status, 'task_id', t.id);
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
revoke all on function content_draft_claim(uuid, text) from public, anon, authenticated;
grant execute on function content_draft_claim(uuid, text) to service_role;

create or replace function content_draft_write(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  d content_drafts;
  t tasks;
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
  select * into t from tasks where id = coalesce(d.request_task_id, d.source_task_id);
  if t.claimed_by is not null and t.claimed_at > now() - interval '1 hour'
     and t.claimed_by is distinct from nullif(btrim(coalesce(p->>'claimant', '')), '') then
    raise exception 'claimed_by_other: % holds this draft''s task until %', t.claimed_by, t.claimed_at + interval '1 hour'
      using errcode = 'CD409';
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

do $$
begin
  if has_function_privilege('authenticated', 'public.content_draft_claim(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.content_draft_claim(uuid, text)', 'execute') then
    raise exception 'content_draft_claim is the worker''s and the drafter''s only';
  end if;
  if has_function_privilege('authenticated', 'public.content_draft_write(jsonb)', 'execute') then
    raise exception 'content_draft_write is the drafter''s only';
  end if;
end $$;
