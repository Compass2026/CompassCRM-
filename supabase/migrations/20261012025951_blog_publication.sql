-- Human-reviewed blog releases and durable website delivery. No existing
-- article is queued and no client is switched to automatic publication.
create table blog_publications (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  draft_id uuid not null references content_drafts(id),
  draft_version int not null,
  release_hash text not null check (release_hash ~ '^sha256:[0-9a-f]{64}$'),
  snapshot jsonb not null,
  released_by uuid not null references team_members(id),
  released_at timestamptz not null default now(),
  scheduled_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued','publishing','published','blocked','uncertain','cancelled')),
  lease_token uuid,
  lease_expires_at timestamptz,
  commit_sha text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{40}$'),
  published_url text,
  published_at timestamptz,
  last_error text,
  evidence jsonb,
  check ((status = 'published') = (published_at is not null and published_url is not null))
);
create unique index blog_publications_one_active on blog_publications(draft_id,draft_version) where status <> 'cancelled';
create index blog_publications_due on blog_publications (scheduled_at) where status = 'queued';
alter table blog_publications enable row level security;
create policy "team reads blog publication history" on blog_publications for select to authenticated using ((select is_team()));
revoke all on blog_publications from public, anon, authenticated;
grant select on blog_publications to authenticated;
grant select, insert, update on blog_publications to service_role;

create function blog_publications_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not ((post_caller_is_human() or drafter_caller_is_service())
      and current_setting('compass.blog_publication_write', true) = 'on') then
    raise exception 'Blog publication changes use the guarded publication functions' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then raise exception 'Publication history is immutable' using errcode = '42501'; end if;
  if tg_op = 'UPDATE' and (new.id,new.client_id,new.draft_id,new.draft_version,new.release_hash,new.snapshot,new.released_by,new.released_at,new.scheduled_at)
    is distinct from (old.id,old.client_id,old.draft_id,old.draft_version,old.release_hash,old.snapshot,old.released_by,old.released_at,old.scheduled_at) then
    raise exception 'The released article and destination are immutable' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function blog_publications_guard() from public, anon, authenticated;
create trigger blog_publications_guard before insert or update or delete on blog_publications
for each row execute function blog_publications_guard();

-- Invoker helper: caller holds the draft row lock. Recheck governed inputs and
-- the pinned destination every time a queue item is acquired or authorized.
create function blog_publication_problems(d content_drafts, p_snapshot jsonb) returns text[]
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare v text[] := content_draft_problems(d); dest jsonb; cl jsonb;
begin
  if d.deliverable <> 'blog' or d.status <> 'approved' or d.version <> d.approved_version
     or d.approved_snapshot is distinct from p_snapshot then
    v := v || 'The approved article changed. Review and approve the current version.'::text;
  end if;
  select jsonb_build_object('site_id',st.id,'url',st.url,'repo_url',st.repo_url,'branch',st.branch,
    'content_adapter',st.content_adapter,'content_paths',st.content_paths,'vercel_project',st.vercel_project,
    'controlled_by_compass',st.controlled_by_compass) into dest
    from sites st where st.client_id = d.client_id order by st.created_at,st.id limit 1;
  if dest is distinct from p_snapshot->'destination' or coalesce((dest->>'controlled_by_compass')::boolean,false) = false then
    v := v || 'Website destination changed or is not controlled by Compass. Review before publishing.'::text;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'claim',c.claim,'status',c.status,'source',c.source) order by c.id),'[]'::jsonb)
    into cl from content_draft_claims dc join claims c on c.id = dc.claim_id where dc.draft_id = d.id;
  if cl is distinct from p_snapshot->'claims' then v := v || 'Supporting evidence changed since approval.'::text; end if;
  return v;
end $$;
revoke all on function blog_publication_problems(content_drafts,jsonb) from public, anon, authenticated;
grant execute on function blog_publication_problems(content_drafts,jsonb) to service_role;

create function blog_publication_queue(p_draft_id uuid, p_version int, p_scheduled_at timestamptz default now()) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare d content_drafts; v text[]; existing blog_publications; result uuid;
begin
  if not post_caller_is_human() then raise exception 'Only a signed-in teammate queues an approved blog' using errcode = '42501'; end if;
  select * into d from content_drafts where id = p_draft_id for update;
  if d.id is null then raise exception 'No such draft' using errcode = 'P0002'; end if;
  if d.version <> p_version then raise exception 'Reload and review the changed draft' using errcode = '40001'; end if;
  select * into existing from blog_publications where draft_id = d.id and draft_version = d.version and status <> 'cancelled';
  if existing.id is not null then return existing.id; end if;
  v := blog_publication_problems(d,d.approved_snapshot);
  if cardinality(v)>0 then raise exception '%',array_to_string(v,' ') using errcode = '23514'; end if;
  if p_scheduled_at is null or p_scheduled_at < now()-interval '5 minutes' then
    raise exception 'Choose now or a future publication time' using errcode = '22023';
  end if;
  perform set_config('compass.blog_publication_write','on',true);
  insert into blog_publications(client_id,draft_id,draft_version,release_hash,snapshot,released_by,scheduled_at)
    values(d.client_id,d.id,d.version,d.approved_hash,d.approved_snapshot,task_actor(),p_scheduled_at) returning id into result;
  perform set_config('compass.blog_publication_write','',true);
  return result;
end $$;
revoke all on function blog_publication_queue(uuid,int,timestamptz) from public, anon;
grant execute on function blog_publication_queue(uuid,int,timestamptz) to authenticated;

create function blog_publication_cancel(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not post_caller_is_human() then raise exception 'Only a teammate cancels a queued blog' using errcode = '42501'; end if;
  perform set_config('compass.blog_publication_write','on',true);
  update blog_publications set status='cancelled',last_error='Cancelled by the team before publication.' where id=p_id and status='queued';
  if not found then raise exception 'Only queued work can be cancelled; check the publication record' using errcode = '23514'; end if;
  perform set_config('compass.blog_publication_write','',true);
end $$;
revoke all on function blog_publication_cancel(uuid) from public, anon;
grant execute on function blog_publication_cancel(uuid) to authenticated;

-- A live lease prevents concurrent transport and reopening. An expired lease
-- becomes uncertain, never automatically queued again: a commit may exist.
create function blog_publication_claim(p_id uuid) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
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
  v := blog_publication_problems(d,p.snapshot);
  if cardinality(v)>0 then
    update blog_publications set status='blocked',last_error=array_to_string(v,' ') where id=p.id;
    return jsonb_build_object('status','blocked','problems',v);
  end if;
  -- Serialize each client's quota check. A published record is counted only
  -- after live verification. Concurrent leases consume an available slot.
  perform pg_advisory_xact_lock(hashtextextended('blog:'||p.client_id::text,0));
  if not exists(select 1 from client_quota_usage(p.client_id) q where q.service_key='blog_posts' and q.allocation > q.completed +
      (select count(*) from blog_publications x where x.client_id=p.client_id and x.status in ('publishing','uncertain'))) then
    update blog_publications set status='blocked',last_error='Monthly blog allowance is unavailable or fully used.' where id=p.id;
    return jsonb_build_object('status','blocked');
  end if;
  update blog_publications set status='publishing',lease_token=token,lease_expires_at=now()+interval '10 minutes',last_error=null
    where id=p.id returning * into p;
  perform set_config('compass.blog_publication_write','',true);
  return to_jsonb(p);
end $$;
revoke all on function blog_publication_claim(uuid) from public, anon, authenticated;
grant execute on function blog_publication_claim(uuid) to service_role;

create function blog_publication_finish(p_id uuid,p_token uuid,p_status text,p_evidence jsonb,p_error text default null) returns void
language plpgsql security invoker set search_path = public, pg_temp as $$
declare p blog_publications; d content_drafts;
begin
  if not drafter_caller_is_service() then raise exception 'Publisher service only' using errcode = '42501'; end if;
  select * into d from content_drafts where id=(select draft_id from blog_publications where id=p_id) for update;
  select * into p from blog_publications where id=p_id for update;
  if p.status is distinct from 'publishing' or p.lease_token is distinct from p_token or p_token is null then
    raise exception 'Publication lease is not current' using errcode = '40001';
  end if;
  if p_status not in ('published','blocked','uncertain') then raise exception 'Invalid publication result'; end if;
  if p_status='published' and (coalesce(p_evidence->>'commit_sha','') !~ '^[0-9a-f]{40}$'
      or p_evidence->>'deployment_state' is distinct from 'READY'
      or p_evidence->>'deployment_target' is distinct from 'production'
      or p_evidence->>'live_verified' is distinct from 'true'
      or p_evidence->>'url' is distinct from
        rtrim(p.snapshot->'destination'->>'url','/') || replace(p.snapshot->'destination'->'content_paths'->>'blog_route','{slug}',p.snapshot->>'slug')) then
    raise exception 'Publication requires the exact production deployment and verified live article' using errcode='23514';
  end if;
  perform set_config('compass.blog_publication_write','on',true);
  update blog_publications set status=p_status,evidence=p_evidence,last_error=left(p_error,4000),
    commit_sha=p_evidence->>'commit_sha',
    published_url=case when p_status='published' then p_evidence->>'url' end,
    published_at=case when p_status='published' then now() end where id=p.id;
  if p_status='published' then
    update content_posts set status='published',url=p_evidence->>'url',published_at=now()
      where id=d.final_content_post_id and client_id=p.client_id;
  end if;
  perform set_config('compass.blog_publication_write','',true);
end $$;
revoke all on function blog_publication_finish(uuid,uuid,text,jsonb,text) from public, anon, authenticated;
grant execute on function blog_publication_finish(uuid,uuid,text,jsonb,text) to service_role;

create function blog_publication_freeze_draft() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists(select 1 from blog_publications where draft_id=old.id and status in ('queued','publishing','uncertain')) then
    raise exception 'Cancel queued publication or reconcile an interrupted publication before editing this draft' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function blog_publication_freeze_draft() from public, anon, authenticated;
create trigger blog_publication_freeze_draft before update on content_drafts for each row execute function blog_publication_freeze_draft();

create function blog_publication_authorize(p_id uuid,p_token uuid) returns void
language plpgsql security invoker set search_path = public, pg_temp as $$
declare p blog_publications; d content_drafts; v text[];
begin
  if not drafter_caller_is_service() then raise exception 'Publisher service only' using errcode='42501'; end if;
  select * into d from content_drafts where id=(select draft_id from blog_publications where id=p_id) for update;
  select * into p from blog_publications where id=p_id for update;
  if p.status is distinct from 'publishing' or p.lease_token is distinct from p_token or p_token is null or p.lease_expires_at<now() then
    raise exception 'Publication lease expired or changed' using errcode='40001';
  end if;
  v := blog_publication_problems(d,p.snapshot);
  if cardinality(v)>0 then raise exception '%',array_to_string(v,' ') using errcode='23514'; end if;
end $$;
revoke all on function blog_publication_authorize(uuid,uuid) from public, anon, authenticated;
grant execute on function blog_publication_authorize(uuid,uuid) to service_role;

-- A tick transports only an explicitly queued, human-approved artifact.
-- It cannot approve a draft or turn a reviewed pilot into automatic mode.
select cron.schedule('blog-publisher-tick','*/5 * * * *',$$
  select net.http_post(
    url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/blog-publisher',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || get_secret('SUPABASE_ANON_KEY'),
      'x-cron-secret',get_secret('SYNC_CRON_SECRET')),
    body := jsonb_build_object('publication_id',p.id),timeout_milliseconds := 180000)
  from blog_publications p where (p.status='queued' and p.scheduled_at<=now())
    or (p.status='publishing' and p.lease_expires_at<now())
  order by p.scheduled_at limit 3;
$$);


-- Keep every human approval even when an article is reopened before queuing.
create table content_draft_reviews (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references content_drafts(id),
  client_id uuid not null references clients(id),
  version int not null,
  approved_hash text not null,
  snapshot jsonb not null,
  reviewed_by uuid not null references team_members(id),
  reviewed_at timestamptz not null,
  unique(draft_id,approved_hash)
);
alter table content_draft_reviews enable row level security;
create policy "team reads blog approvals" on content_draft_reviews for select to authenticated using ((select is_team()));
revoke all on content_draft_reviews from public,anon,authenticated,service_role;
grant select on content_draft_reviews to authenticated,service_role;
create function content_draft_review_history_guard() returns trigger
language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if tg_op <> 'INSERT' or pg_trigger_depth()<2 or not post_caller_is_human() then
    raise exception 'Approval history is append-only and written by approval' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function content_draft_review_history_guard() from public,anon,authenticated;
create trigger content_draft_review_history_guard before insert or update or delete on content_draft_reviews
for each row execute function content_draft_review_history_guard();
create function content_draft_record_review() returns trigger
language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if new.status='approved' and new.approved_hash is distinct from old.approved_hash then
    insert into content_draft_reviews(draft_id,client_id,version,approved_hash,snapshot,reviewed_by,reviewed_at)
      values(new.id,new.client_id,new.version,new.approved_hash,new.approved_snapshot,new.reviewed_by,new.reviewed_at)
      on conflict(draft_id,approved_hash) do nothing;
  end if;
  return new;
end $$;
revoke all on function content_draft_record_review() from public,anon,authenticated;
create trigger content_draft_record_review after update on content_drafts
for each row execute function content_draft_record_review();

-- Two weekly slots within the existing monthly agreement. Count completed
-- tasks too, so completing the first article does not create another slot.
create or replace function create_weekly_blog_tasks() returns integer
language plpgsql security definer set search_path = public,pg_temp as $$
declare c record; u record; made int:=0; existing int; slots int; n int;
  week date:=date_trunc('week',now() at time zone 'America/Chicago')::date;
begin
  for c in select id,name from clients where status='active' order by id loop
    perform pg_advisory_xact_lock(hashtextextended('blog:'||c.id::text,0));
    select count(*) into existing from tasks where client_id=c.id and key='blog_post'
      and (created_at at time zone 'America/Chicago')::date>=week
      and (created_at at time zone 'America/Chicago')::date<week+7;
    if existing>=2 then continue; end if;
    begin
      select allocation,used,remaining into u from client_quota_usage(c.id) where service_key='blog_posts';
    exception when others then
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason)
        values(c.id,'weekly_blog_post','blog_posts','skipped','entitlements_unavailable');
      continue;
    end;
    if u is null then
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason)
        values(c.id,'weekly_blog_post','blog_posts','skipped','entitlements_unavailable');
      continue;
    end if;
    slots:=least(2-existing,u.remaining);
    if u.allocation=0 or slots<=0 then
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason,allocation,used)
        values(c.id,'weekly_blog_post','blog_posts','skipped',case when u.allocation=0 then 'not_in_agreement' else 'allocation_used' end,u.allocation,u.used);
      continue;
    end if;
    for n in 1..slots loop
      insert into tasks(client_id,title,owner,status,playbook_step,autonomy_level,key,due_date)
        values(c.id,'Blog slot '||(existing+n)||': governed keyword, sourced article, team review',
          'CLAUDE','open','PB7','run_flag','blog_post',week+2+2*(existing+n-1));
      insert into automation_entitlement_log(client_id,automation,service_key,decision,reason,allocation,used)
        values(c.id,'weekly_blog_post','blog_posts','created','within_allocation',u.allocation,u.used+n);
      made:=made+1;
    end loop;
    perform fire_foundation_worker(c.id,'Weekly blog drafts: select active governed keywords and stop for team review');
  end loop;
  return made;
end $$;
revoke all on function create_weekly_blog_tasks() from public,anon,authenticated,service_role;
