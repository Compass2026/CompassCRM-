-- Full-property Search Console totals are separate from query/page snapshots.
create table public.gsc_performance_imports (
 id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id),
 property text not null, period date not null, period_end date not null,
 data jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create index gsc_performance_series on public.gsc_performance_imports(client_id,property,period,created_at desc);
create table public.gsc_performance_sync_runs (
 id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id),
 created_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 status text not null check(status in ('running','completed','partial')), results jsonb not null
);
alter table public.gsc_performance_imports enable row level security;
alter table public.gsc_performance_sync_runs enable row level security;
create policy "team read gsc imports" on public.gsc_performance_imports for select to authenticated using ((select public.is_team()));
create policy "team read gsc syncs" on public.gsc_performance_sync_runs for select to authenticated using ((select public.is_team()));
revoke all on public.gsc_performance_imports,public.gsc_performance_sync_runs from public,anon,authenticated,service_role;
grant select on public.gsc_performance_imports,public.gsc_performance_sync_runs to authenticated;
grant select,insert,update on public.gsc_performance_sync_runs to service_role;

create function public.gsc_performance_record(p_client_id uuid,p_property text,p_start date,p_end date,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare previous jsonb; receipt uuid; pair record; begin
 if session_user <> 'authenticator' or coalesce(current_setting('role',true),'') <> 'service_role' then raise exception 'service only' using errcode='42501'; end if;
 if p_start is null or p_end is null or p_start<>date_trunc('month',p_start)::date or p_end<>(p_start+interval '1 month - 1 day')::date or p_end>current_date-4 then raise exception 'complete month required' using errcode='23514'; end if;
 perform 1 from public.clients where id=p_client_id and status in ('active','launching') and gsc_property=p_property for update;
 if not found then raise exception 'property binding changed' using errcode='23514'; end if;
 if jsonb_typeof(p_data->'values') is distinct from 'object'
 or (select count(*) from jsonb_object_keys(p_data->'values'))<>2
 or not(p_data->'values' ?& array['search_clicks','search_impressions'])
 or p_data->>'aggregation' is distinct from 'byProperty'
 or p_data->>'search_type' is distinct from 'web' then raise exception 'invalid metrics' using errcode='23514'; end if;
 for pair in select * from jsonb_each(p_data->'values') loop
  if jsonb_typeof(pair.value)<>'number' or pair.value::text::numeric<0 or pair.value::text::numeric<>trunc(pair.value::text::numeric) then raise exception 'invalid total' using errcode='23514'; end if;
 end loop;
 if (p_data->'values'->>'search_clicks')::numeric>(p_data->'values'->>'search_impressions')::numeric then raise exception 'invalid clicks' using errcode='23514'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_client_id::text||p_property||p_start::text,0));
 select data into previous from public.gsc_performance_imports where client_id=p_client_id and property=p_property and period=p_start order by created_at desc,id desc limit 1;
 if previous=p_data then return jsonb_build_object('status','unchanged'); end if;
 insert into public.gsc_performance_imports(client_id,property,period,period_end,data) values(p_client_id,p_property,p_start,p_end,p_data) returning id into receipt;
 for pair in select * from jsonb_each(p_data->'values') order by key loop
  insert into public.report_measurements(client_id,metric,scope,source,context,report_period,window_start,window_end,status,value,evidence,meaning,next_action)
  values(p_client_id,pair.key,'Search Console '||p_property||' | web search | complete calendar months','Google Search Console property totals','existing_client',p_start,p_start,p_end,'measured',pair.value::text::numeric,
   'Search Console property total import '||receipt||'; no query/page filters or grouping; finalized data; source timezone America/Los_Angeles.',
   'Google-reported property-level web search total, not a sum of query/page exports. This does not measure website sessions or leads.',
   'Review monthly visibility and clicks alongside rankings and completed work.');
 end loop;
 return jsonb_build_object('status','imported','receipt_id',receipt);
end $$;
revoke all on function public.gsc_performance_record(uuid,text,date,date,jsonb) from public,anon,authenticated;
grant execute on function public.gsc_performance_record(uuid,text,date,date,jsonb) to service_role;

-- Only published work is exposed. No draft copy, notes, approvals or credentials.
create view public.client_growth_work with (security_invoker=true) as
 select 'blog:'||id::text id,client_id,'blog'::text kind,title,published_at::date as published_on,url
 from public.content_posts where status::text='published' and origin='compass' and published_at is not null
 union all
 select 'social:'||id::text,client_id,case when platform::text='google_business' then 'gbp' else 'social' end,
 case when platform::text='google_business' then 'Google Business Profile post' else initcap(replace(platform::text,'_',' '))||' post' end,
 (published_at at time zone 'America/Chicago')::date,published_url
 from public.social_posts where publish_status='published' and published_at is not null;
create view public.portal_growth_work with (security_barrier=true,security_invoker=false) as
 select 'blog:'||id::text id,client_id,'blog'::text kind,title,published_at::date as published_on,url
 from public.content_posts where client_id=(select public.portal_client_id()) and status::text='published' and origin='compass' and published_at is not null
 union all
 select 'social:'||id::text,client_id,case when platform::text='google_business' then 'gbp' else 'social' end,
 case when platform::text='google_business' then 'Google Business Profile post' else initcap(replace(platform::text,'_',' '))||' post' end,
 (published_at at time zone 'America/Chicago')::date,published_url
 from public.social_posts where client_id=(select public.portal_client_id()) and publish_status='published' and published_at is not null;
revoke all on public.client_growth_work,public.portal_growth_work from public,anon,authenticated;
grant select on public.client_growth_work,public.portal_growth_work to authenticated;

select cron.schedule('gsc-performance-daily','30 9 * * *',$job$
 select net.http_post(url:='https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/gsc-performance',
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||get_secret('SUPABASE_ANON_KEY'),'x-cron-secret',get_secret('SYNC_CRON_SECRET')),
 body:=jsonb_build_object('client_id',id),timeout_milliseconds:=120000)
 from public.clients where status in ('active','launching') and gsc_property is not null;
$job$);
