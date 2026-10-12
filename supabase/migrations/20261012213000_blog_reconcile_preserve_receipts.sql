-- Resume verified existing releases after historical transport receipt loss.
create or replace function public.blog_publication_resume(p_id uuid) returns jsonb
language plpgsql set search_path=public,pg_temp as $$
declare
  p public.blog_publications;
  d public.content_drafts;
  v text[];
  v_token uuid:=gen_random_uuid();
  v_failure text;
begin
  if not drafter_caller_is_service() then
    raise exception 'Publisher service only' using errcode='42501';
  end if;
  select * into d from public.content_drafts
     where id=(select draft_id from public.blog_publications where id=p_id) for update;
  select * into p from public.blog_publications where id=p_id for update;
  if p.id is null or d.id is null then raise exception 'No such publication' using errcode='P0002'; end if;
  if p.status<>'uncertain' or p.reconciliation_attempts>=6 then
    return jsonb_build_object('status',p.status,'acquired',false);
  end if;
  if p.last_error is distinct from 'Website commit or deployment is not confirmed. Reconcile before retrying.' then
    return jsonb_build_object('status','uncertain','acquired',false,'reason','not an eligible pre-verification failure');
  end if;
  -- An interrupted commit that actually exists may only be reconciled by
  -- reading the exact approved hash on the site. A 422 ref conflict must
  -- first be shown absent from the current repository by the publisher.
  if p.commit_sha ~ '^[0-9a-f]{40}$'
     and p.evidence->>'commit_sha' = p.commit_sha
     and p.evidence->'transport'->'vercel'->>'target'='production'
     and p.evidence->'transport'->'vercel'->>'deployment_url' is not null then
    v_failure:='post-commit deployment check';
  elsif p.commit_sha is null
      and coalesce(p.evidence->'transport'->>'error','') like 'update ref failed (422):%'
      and coalesce(p.evidence->'transport'->>'error','') like '%Update is not a fast forward%' then
    v_failure:='github fast-forward conflict';
  elsif p.commit_sha is null
      and p.evidence->>'reconciliation_error'='The original production deployment is not READY.'
      and p.evidence->'lint'->>'ok'='true' then
    -- Older worker version lost its transport receipt during a Vercel BUILDING
    -- response. The publisher may VERIFY an exact existing release, never
    -- create another commit without a source receipt.
    v_failure:='verify existing release only';
  else
    return jsonb_build_object('status','uncertain','acquired',false,'reason','manual reconciliation needed');
  end if;
  if p.published_url is not null or p.published_at is not null then
    raise exception 'Already published or publication status inconsistent' using errcode='23514';
  end if;
  v:=public.blog_publication_problems(d,p.snapshot);
  if cardinality(v)>0 then
    return jsonb_build_object('status','uncertain','acquired',false,'problems',v);
  end if;
  perform set_config('compass.blog_publication_write','on',true);
  update public.blog_publications set status='publishing',lease_token=v_token,
    lease_expires_at=now()+interval '10 minutes',
    reconciliation_attempts=reconciliation_attempts+1
    where id=p.id returning * into p;
  perform set_config('compass.blog_publication_write','',true);
  return to_jsonb(p) || jsonb_build_object('reconcile_reason',v_failure);
end $$;
revoke all on function public.blog_publication_resume(uuid) from public,anon,authenticated;
grant execute on function public.blog_publication_resume(uuid) to service_role;

-- Separate cron from initial release tick. Only uncertain, explicitly
-- eligible failures are reconsidered; all checks happen again in the worker.
select cron.schedule(
  'blog-publisher-reconcile-tick',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/blog-publisher',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'Authorization','Bearer ' || get_secret('SUPABASE_ANON_KEY'),
        'x-cron-secret',get_secret('SYNC_CRON_SECRET')),
      body := jsonb_build_object('publication_id',p.id,'reconcile',true),
      timeout_milliseconds := 180000
    )
    from public.blog_publications p
    where p.status='uncertain'
      and p.last_error='Website commit or deployment is not confirmed. Reconcile before retrying.'
      and p.reconciliation_attempts<6
    order by p.released_at limit 2;
  $cron$
);
