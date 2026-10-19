-- One writer per website destination. On Oct 19 2026 blog-publisher-tick
-- leased three queued Logic Solar releases in one run and wrote them to the
-- same repository branch concurrently: one commit landed, the other two lost
-- GitHub's non-forced ref update (422 "Update is not a fast forward"), were
-- recorded uncertain and were recovered by reconcile ticks that again wrote
-- two at a time. A destination is the pinned repository and branch from the
-- immutable release snapshot. Every existing check (leases, uncertain and
-- reconcile rules, the publisher's expected_head) is unchanged; this only
-- defers a release while another one holds a lease on the same destination.

-- GitHub repository names are case-insensitive; a trailing slash or .git
-- names the same repository. Without a repository, the pinned site row.
create function blog_publication_destination(p_snapshot jsonb) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when coalesce(p_snapshot->'destination'->>'repo_url', '') <> ''
    then lower(regexp_replace(p_snapshot->'destination'->>'repo_url', '(\.git)?/*$', ''))
         || '#' || coalesce(p_snapshot->'destination'->>'branch', '')
    else 'site:' || coalesce(p_snapshot->'destination'->>'site_id', '') end
$$;
revoke all on function blog_publication_destination(jsonb) from public, anon, authenticated;
grant execute on function blog_publication_destination(jsonb) to service_role;

-- Another release holds a lease on this destination (live or expired: an
-- expired lease is turned uncertain by the next tick, which frees it).
-- Callers hold the destination's advisory lock, so a lease committed by a
-- concurrent claim or resume is visible here.
create function blog_publication_destination_busy(p_id uuid, p_destination text) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select exists(select 1 from blog_publications x where x.id <> p_id and x.status = 'publishing'
    and blog_publication_destination(x.snapshot) = p_destination)
$$;
revoke all on function blog_publication_destination_busy(uuid, text) from public, anon, authenticated;
grant execute on function blog_publication_destination_busy(uuid, text) to service_role;

-- Unchanged from 20261015150000 except the destination step: a release whose
-- destination is busy stays queued for a later tick, before its other checks.
create or replace function blog_publication_claim(p_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare p blog_publications; d content_drafts; v text[]; token uuid := gen_random_uuid();
begin
  if not drafter_caller_is_service() then raise exception 'Publisher service only' using errcode = '42501'; end if;
  select * into d from content_drafts where id = (select draft_id from blog_publications where id=p_id) for update;
  select * into p from blog_publications where id=p_id for update;
  if p.id is null then raise exception 'No such publication' using errcode = 'P0002'; end if;
  perform set_config('compass.blog_publication_write','on',true);
  if p.status='publishing' and p.lease_expires_at < now() then
    update blog_publications set status='uncertain',last_error='Publisher interrupted; reconcile the repository and deployment before retrying.' where id=p.id;
    return jsonb_build_object('status','uncertain');
  end if;
  if p.status<>'queued' or p.scheduled_at>now() then return jsonb_build_object('status',p.status,'acquired',false); end if;
  -- One writer per repository branch: serialize leases on the destination,
  -- then defer while another release holds one.
  perform pg_advisory_xact_lock(hashtextextended('blog-destination:'||blog_publication_destination(p.snapshot),0));
  if blog_publication_destination_busy(p.id, blog_publication_destination(p.snapshot)) then
    return jsonb_build_object('status','queued','acquired',false,'reason','destination busy');
  end if;
  v := blog_publication_problems(d,p.snapshot);
  if cardinality(v)>0 then
    update blog_publications set status='blocked',last_error=array_to_string(v,' ') where id=p.id;
    return jsonb_build_object('status','blocked','problems',v);
  end if;
  -- Serialize each client's quota check. A published record is counted only
  -- after live verification. Concurrent leases consume an available slot.
  perform pg_advisory_xact_lock(hashtextextended('blog:'||p.client_id::text,0));
  if not blog_publication_has_room(p.client_id, d.service_id) then
    update blog_publications set status='blocked',last_error='Monthly blog allowance is unavailable or fully used.' where id=p.id;
    return jsonb_build_object('status','blocked');
  end if;
  update blog_publications set status='publishing',lease_token=token,lease_expires_at=now()+interval '10 minutes',last_error=null
    where id=p.id returning * into p;
  perform set_config('compass.blog_publication_write','',true);
  return to_jsonb(p);
end $$;

-- Unchanged from 20261012213000 except the destination step: an eligible
-- release whose destination is busy stays uncertain and keeps its attempt.
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
  -- Reconciling may write a new commit: the same one-writer rule as a claim.
  perform pg_advisory_xact_lock(hashtextextended('blog-destination:'||public.blog_publication_destination(p.snapshot),0));
  if public.blog_publication_destination_busy(p.id, public.blog_publication_destination(p.snapshot)) then
    return jsonb_build_object('status','uncertain','acquired',false,'reason','destination busy');
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

-- At most one queued release per destination per tick (the earliest), none
-- for a destination another release is writing; expired leases are still
-- sent so the claim turns them uncertain. The claim re-checks under the lock.
select cron.schedule('blog-publisher-tick','*/5 * * * *',$$
  select net.http_post(
    url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/blog-publisher',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || get_secret('SUPABASE_ANON_KEY'),
      'x-cron-secret',get_secret('SYNC_CRON_SECRET')),
    body := jsonb_build_object('publication_id',p.id),timeout_milliseconds := 180000)
  from (
    select x.id, x.scheduled_at from blog_publications x where x.status='publishing' and x.lease_expires_at<now()
    union all
    select * from (
      select distinct on (blog_publication_destination(q.snapshot)) q.id, q.scheduled_at
      from blog_publications q
      where q.status='queued' and q.scheduled_at<=now()
        and not exists(select 1 from blog_publications w where w.status='publishing'
          and blog_publication_destination(w.snapshot)=blog_publication_destination(q.snapshot))
      order by blog_publication_destination(q.snapshot), q.scheduled_at, q.released_at, q.id) first_per_destination
  ) p
  order by p.scheduled_at limit 3;
$$);

-- The same for reconciliation: one eligible release per destination, none
-- while the destination is being written. The resume re-checks under the lock.
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
    from (
      select distinct on (public.blog_publication_destination(u.snapshot)) u.id, u.released_at
      from public.blog_publications u
      where u.status='uncertain'
        and u.last_error='Website commit or deployment is not confirmed. Reconcile before retrying.'
        and u.reconciliation_attempts<6
        and not exists(select 1 from public.blog_publications w where w.status='publishing'
          and public.blog_publication_destination(w.snapshot)=public.blog_publication_destination(u.snapshot))
      order by public.blog_publication_destination(u.snapshot), u.released_at, u.id
    ) p
    order by p.released_at limit 2;
  $cron$
);
