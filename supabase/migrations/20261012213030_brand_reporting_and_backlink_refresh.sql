-- Each brand owns its analytics binding. The shared GBP remains on the client.
alter table public.client_brand_workspaces add column ga4_property text check(ga4_property ~ '^properties/[0-9]+$'), add column gsc_property text;
create function public.reporting_binding(p_client_id uuid,p_brand_id uuid,p_source text,p_property text)
returns text language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare site text; bound text; begin
 if session_user <> 'authenticator' or coalesce(current_setting('role',true),'') <> 'service_role' then raise exception 'service only' using errcode='42501'; end if;
 if p_source not in ('ga4','gsc') or p_property is null then raise exception 'invalid source' using errcode='23514'; end if;
 select website_url,case p_source when 'ga4' then ga4_property else gsc_property end into site,bound from public.clients where id=p_client_id and status in ('active','launching') for update;
 if not found then raise exception 'client unavailable' using errcode='23514'; end if;
 if p_brand_id is not null then
  select website_url,case p_source when 'ga4' then ga4_property else gsc_property end into site,bound from public.client_brand_workspaces where id=p_brand_id and client_id=p_client_id for update;
 end if;
 if site is null or bound is distinct from p_property then raise exception 'property binding changed' using errcode='23514'; end if;
 return regexp_replace(lower(substring(site from '^https?://([^/]+)')),'^www\.','');
end $$;
revoke all on function public.reporting_binding(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.reporting_binding(uuid,uuid,text,text) to service_role;

create or replace function public.ga4_performance_record(p_client_id uuid,p_property text,p_start date,p_end date,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare previous jsonb; receipt uuid; pair record; bound_host text; begin
 if session_user <> 'authenticator' or coalesce(current_setting('role',true),'') <> 'service_role' then raise exception 'service only' using errcode='42501'; end if;
 if p_start is null or p_end is null or p_start>p_end or date_trunc('month',p_start)<>date_trunc('month',p_end) or p_end>current_date-4 then raise exception 'complete month required' using errcode='23514'; end if;
 bound_host:=public.reporting_binding(p_client_id,(p_data->>'brand_workspace_id')::uuid,'ga4',p_property);
 if jsonb_typeof(p_data->'values') is distinct from 'object'
 or (select count(*) from jsonb_object_keys(p_data->'values'))<>3
 or not(p_data->'values' ?& array['website_sessions','website_users','website_pageviews'])
 or coalesce(p_data->>'coverage','') not in ('complete_month','month_to_date','partial_launch_month')
 or not exists(select 1 from pg_timezone_names where name=p_data->>'time_zone')
 or coalesce(p_data->>'host','') is distinct from bound_host
 then raise exception 'invalid metrics or host binding' using errcode='23514'; end if;
 if p_data->>'coverage'='complete_month' and (p_start<>date_trunc('month',p_start)::date or p_end<>(p_start+interval '1 month - 1 day')::date) then raise exception 'complete month required' using errcode='23514'; end if;
 for pair in select * from jsonb_each(p_data->'values') loop
  if jsonb_typeof(pair.value)<>'number' or pair.value::text::numeric<0 or pair.value::text::numeric>1000000000000 or pair.value::text::numeric<>trunc(pair.value::text::numeric) then raise exception 'invalid total' using errcode='23514'; end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended(p_client_id::text||p_property||p_start::text,0));
 select data into previous from public.ga4_performance_imports where client_id=p_client_id and property=p_property and period=p_start and period_end=p_end order by created_at desc,id desc limit 1;
 if previous=p_data then return jsonb_build_object('status','unchanged'); end if;
 insert into public.ga4_performance_imports(client_id,property,period,period_end,data) values(p_client_id,p_property,p_start,p_end,p_data) returning id into receipt;
 for pair in select * from jsonb_each(p_data->'values') order by key loop
  insert into public.report_measurements(client_id,metric,scope,source,context,report_period,window_start,window_end,status,value,evidence,meaning,next_action)
  values(p_client_id,pair.key,'GA4 '||p_property||' | '||(p_data->>'host')||' | '||(p_data->>'time_zone')||' | '||(p_data->>'coverage'),'Google Analytics 4','existing_client',date_trunc('month',p_start)::date,p_start,p_end,'measured',pair.value::text::numeric,
   'GA4 import '||receipt||'; exact website hostname filter; property timezone '||(p_data->>'time_zone')||'; coverage '||(p_data->>'coverage')||'.',
   'Website traffic recorded by GA4. Visitors are distinct within this window and cannot be added across months. Sessions and page views are not leads. Partial launch months and month-to-date values are not full-month comparisons.',
   'Review traffic alongside search visibility and verified inquiries.');
 end loop;
 return jsonb_build_object('status','imported','receipt_id',receipt);
end $$;
revoke all on function public.ga4_performance_record(uuid,text,date,date,jsonb) from public,anon,authenticated;
grant execute on function public.ga4_performance_record(uuid,text,date,date,jsonb) to service_role;

select cron.schedule('ga4-brand-performance-daily','15 10 * * *',$job$
 select net.http_post(url:='https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/ga4-performance',
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||get_secret('SUPABASE_ANON_KEY'),'x-cron-secret',get_secret('SYNC_CRON_SECRET')),
 body:=jsonb_build_object('client_id',b.client_id,'brand_workspace_id',b.id),timeout_milliseconds:=120000)
 from public.client_brand_workspaces b join public.clients c on c.id=b.client_id
 where c.status in ('active','launching') and b.ga4_property is not null
 and b.ga4_property is distinct from c.ga4_property;
$job$);

create or replace function public.gsc_performance_record(p_client_id uuid,p_property text,p_start date,p_end date,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare previous jsonb; receipt uuid; pair record; bound_host text; begin
 if session_user <> 'authenticator' or coalesce(current_setting('role',true),'') <> 'service_role' then raise exception 'service only' using errcode='42501'; end if;
 if p_start is null or p_end is null or p_start<>date_trunc('month',p_start)::date or p_end<>(p_start+interval '1 month - 1 day')::date or p_end>current_date-4 then raise exception 'complete month required' using errcode='23514'; end if;
 bound_host:=public.reporting_binding(p_client_id,(p_data->>'brand_workspace_id')::uuid,'gsc',p_property);
 if not (p_property='sc-domain:'||bound_host or regexp_replace(lower(substring(p_property from '^https?://([^/]+)')),'^www\.','')=bound_host) then raise exception 'invalid host binding' using errcode='23514'; end if;
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

select cron.schedule('gsc-brand-performance-daily','45 9 * * *',$job$
 select net.http_post(url:='https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/gsc-performance',
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||get_secret('SUPABASE_ANON_KEY'),'x-cron-secret',get_secret('SYNC_CRON_SECRET')),
 body:=jsonb_build_object('client_id',b.client_id,'brand_workspace_id',b.id),timeout_milliseconds:=120000)
 from public.client_brand_workspaces b join public.clients c on c.id=b.client_id
 where c.status in ('active','launching') and b.gsc_property is not null
 and b.gsc_property is distinct from c.gsc_property;
$job$);

create table public.backlink_profile_sync_runs (
 id uuid primary key default gen_random_uuid(),client_id uuid not null references public.clients(id),
 host text not null,week date not null,status text not null check(status in ('running','completed','partial')),
 created_at timestamptz not null default clock_timestamp(),finished_at timestamptz,results jsonb not null default '[]',
 unique(client_id,host,week)
);
alter table public.backlink_profile_sync_runs enable row level security;
create policy "team read backlink syncs" on public.backlink_profile_sync_runs for select to authenticated using ((select public.is_team()));
revoke all on public.backlink_profile_sync_runs from public,anon,authenticated,service_role;
grant select on public.backlink_profile_sync_runs to authenticated;
grant select,update on public.backlink_profile_sync_runs to service_role;

create function public.backlink_host_bound(p_client_id uuid,p_host text) returns boolean
language sql security definer set search_path=pg_catalog,public,pg_temp as $$
 select exists(select 1 from public.clients c where c.id=p_client_id and c.status in ('active','launching')
 and (regexp_replace(lower(substring(c.website_url from '^https?://([^/]+)')),'^www\.','')=p_host
 or exists(select 1 from public.client_brand_workspaces b where b.client_id=c.id
 and regexp_replace(lower(substring(b.website_url from '^https?://([^/]+)')),'^www\.','')=p_host)));
$$;
revoke all on function public.backlink_host_bound(uuid,text) from public,anon,authenticated;

create function public.backlink_sync_claim(p_client_id uuid,p_host text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.backlink_profile_sync_runs; begin
 if session_user <> 'authenticator' or coalesce(current_setting('role',true),'') <> 'service_role' then raise exception 'service only' using errcode='42501'; end if;
 perform 1 from public.clients where id=p_client_id for update;
 if not public.backlink_host_bound(p_client_id,p_host) then raise exception 'website binding changed' using errcode='23514'; end if;
 insert into public.backlink_profile_sync_runs(client_id,host,week,status)
 values(p_client_id,p_host,date_trunc('week',current_date)::date,'running') on conflict do nothing returning * into r;
 -- A week is claimed once, including failures: retries cannot create runaway API charges.
 if r.id is null then return jsonb_build_object('status','already_claimed'); end if;
 return jsonb_build_object('id',r.id);
end $$;
revoke all on function public.backlink_sync_claim(uuid,text) from public,anon,authenticated;
grant execute on function public.backlink_sync_claim(uuid,text) to service_role;

create function public.backlink_profile_record(p_run_id uuid,p_kind text,p_start date,p_end date,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare r public.backlink_profile_sync_runs; pair record; series text; prior numeric; prior_found boolean; written integer:=0; begin
 if session_user <> 'authenticator' or coalesce(current_setting('role',true),'') <> 'service_role' then raise exception 'service only' using errcode='42501'; end if;
 select * into r from public.backlink_profile_sync_runs where id=p_run_id for update;
 if r.id is null or r.status<>'running' or r.created_at<clock_timestamp()-interval '30 minutes' then raise exception 'active sync required' using errcode='23514'; end if;
 perform 1 from public.clients where id=r.client_id for update;
 if not public.backlink_host_bound(r.client_id,r.host) then raise exception 'website binding changed' using errcode='23514'; end if;
 if p_kind is null or p_kind not in ('summary','history') or p_start is null or p_end is null or p_start>p_end or p_end>current_date
 or jsonb_typeof(p_data->'values') is distinct from 'object' or (select count(*) from jsonb_object_keys(p_data->'values'))<>2
 or coalesce(p_data->>'task_id','') !~ '^[0-9a-f-]{36}$' then raise exception 'invalid metrics' using errcode='23514'; end if;
 if p_kind='summary' then
  if p_start<>p_end or p_end<>(r.created_at at time zone 'UTC')::date or not(p_data->'values' ?& array['backlinks_total','referring_domains']) then raise exception 'invalid summary' using errcode='23514'; end if;
  series:=r.host||' | Live external index; subdomains and indirect links included';
 else
  if p_start<>date_trunc('month',p_start)::date or p_end<>(p_start+interval '1 month - 1 day')::date or p_end>=date_trunc('month',current_date)::date or not(p_data->'values' ?& array['links_new','links_lost']) then raise exception 'invalid history' using errcode='23514'; end if;
  series:=r.host||' | Monthly discoveries and losses; subdomains included';
 end if;
 for pair in select * from jsonb_each(p_data->'values') order by key loop
  if jsonb_typeof(pair.value)<>'number' or pair.value::text::numeric<0 or pair.value::text::numeric>1000000000000 or pair.value::text::numeric<>trunc(pair.value::text::numeric) then raise exception 'invalid count' using errcode='23514'; end if;
 end loop;
 if p_kind='summary' and (p_data->'values'->>'referring_domains')::numeric>(p_data->'values'->>'backlinks_total')::numeric then raise exception 'invalid domains' using errcode='23514'; end if;
 for pair in select * from jsonb_each(p_data->'values') order by key loop
  select value into prior from public.report_measurements where client_id=r.client_id and metric=pair.key and source='DataForSEO (unreviewed index)' and scope=series and window_start=p_start and window_end=p_end and status='measured' order by sequence desc limit 1;
  prior_found:=found;
  if prior_found and prior=pair.value::text::numeric then continue; end if;
  insert into public.report_measurements(client_id,metric,scope,source,context,report_period,window_start,window_end,status,value,evidence,meaning,next_action)
  values(r.client_id,pair.key,series,'DataForSEO (unreviewed index)','existing_client',date_trunc('month',p_end)::date,p_start,p_end,'measured',pair.value::text::numeric,
  'DataForSEO task '||(p_data->>'task_id')||'; scheduled import '||r.id||'; exact target '||r.host||'; '||p_kind||' reporting.',
  'Unreviewed provider index counts, not verified campaign placements or a measure of link quality. New and lost counts describe provider discoveries and losses.',
  'Review link relevance and quality alongside individually verified campaign placements.');
  written:=written+1;
 end loop;
 return jsonb_build_object('status',case when written=0 then 'unchanged' else 'imported' end,'measurements',written);
end $$;
revoke all on function public.backlink_profile_record(uuid,text,date,date,jsonb) from public,anon,authenticated;
grant execute on function public.backlink_profile_record(uuid,text,date,date,jsonb) to service_role;

select cron.schedule('backlink-performance-weekly','0 11 * * 2',$job$
 select net.http_post(url:='https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/backlink-performance',
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||get_secret('SUPABASE_ANON_KEY'),'x-cron-secret',get_secret('SYNC_CRON_SECRET')),
 body:=jsonb_build_object('client_id',c.id),timeout_milliseconds:=120000)
 from public.clients c where status in ('active','launching') and (website_url is not null or exists(select 1 from public.client_brand_workspaces b where b.client_id=c.id and b.website_url is not null));
$job$);
