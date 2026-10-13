-- Recover exactly the prior pre-write CTA classification failure. Retain all
-- human-only approval and queue checks, original immutable release history,
-- and the refusal for any external write or unrecognized blocked error.
-- The teammate must reapprove if the destination has changed and explicitly
-- click Retry; this migration queues nothing.
create or replace function public.blog_publication_queue(
  p_draft_id uuid, p_version integer, p_scheduled_at timestamptz default now()
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d content_drafts;
  v text[];
  existing blog_publications;
  result uuid;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate queues an approved blog' using errcode='42501';
  end if;
  select * into d from content_drafts where id=p_draft_id for update;
  if d.id is null then raise exception 'No such draft' using errcode='P0002'; end if;
  if d.version<>p_version then raise exception 'Reload and review the changed draft' using errcode='40001'; end if;

  select * into existing from blog_publications
    where draft_id=d.id and draft_version=d.version and status<>'cancelled' for update;
  if existing.id is not null and existing.status<>'blocked' then return existing.id; end if;
  if existing.id is not null and (
       existing.last_error not in (
         'Keyword, brand or campaign foundation changed since review. Regenerate and review before publishing.',
         '"Free" is pricing, a discount or a free offer, which this brief does not support.'
       )
       or existing.commit_sha is not null
       or existing.published_url is not null
       or existing.published_at is not null
       or coalesce(existing.evidence,'{}'::jsonb)<>'{}'::jsonb
     ) then
    raise exception 'Publication needs reconciliation or a new review before retry; no new release was queued' using errcode='23514';
  end if;

  v:=blog_publication_problems(d,d.approved_snapshot);
  if cardinality(v)>0 then raise exception '%',array_to_string(v,' ') using errcode='23514'; end if;
  if p_scheduled_at is null or p_scheduled_at<now()-interval '5 minutes' then
    raise exception 'Choose now or a future publication time' using errcode='22023';
  end if;

  perform set_config('compass.blog_publication_write','on',true);
  if existing.id is not null then
    -- The blocked pre-write attempt stays in immutable history, including
    -- its original error and timestamps. A new teammate release is audited.
    update blog_publications set status='cancelled' where id=existing.id and status='blocked';
    if not found then raise exception 'Publication changed; reload' using errcode='40001'; end if;
  end if;
  insert into blog_publications(client_id,draft_id,draft_version,release_hash,snapshot,released_by,scheduled_at)
    values(d.client_id,d.id,d.version,d.approved_hash,d.approved_snapshot,task_actor(),p_scheduled_at)
    returning id into result;
  perform set_config('compass.blog_publication_write','',true);
  return result;
end $$;
revoke all on function public.blog_publication_queue(uuid,integer,timestamptz) from public, anon;
grant execute on function public.blog_publication_queue(uuid,integer,timestamptz) to authenticated;
