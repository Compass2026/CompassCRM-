-- Add direction requests to the shared report contract.
alter table public.report_measurements drop constraint report_measurements_metric_check;
alter table public.report_measurements add constraint report_measurements_metric_check check (metric in (
    'pages_live','pages_indexed','broken_links',
    'citations_correct','citations_incorrect','citations_missing',
    'backlinks_total','referring_domains','links_new','links_lost',
    'gbp_views','gbp_clicks','gbp_call_clicks','gbp_directions',
    'reviews_total','reviews_rating','reviews_new','reviews_unanswered',
    'organic_top3','organic_top10','maps_top3',
    'search_impressions','search_clicks','organic_sessions','website_sessions','website_users','website_pageviews',
    'forms','calls','qualified_leads',
    'social_posts','social_plan','social_reach','social_engagements','social_clicks','social_followers'
));

alter table public.report_measurements add constraint backlink_total_point check (metric <> 'backlinks_total' or window_start=window_end);
-- Full-property Search Console totals are separate from query/page snapshots.
create table public.ga4_performance_imports (
 id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id),
 property text not null, period date not null, period_end date not null,
 data jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create index ga4_performance_series on public.ga4_performance_imports(client_id,property,period,period_end,created_at desc);
create table public.ga4_performance_sync_runs (
 id uuid primary key default gen_random_uuid(), client_id uuid not null references public.clients(id),
 created_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 status text not null check(status in ('running','completed','partial')), results jsonb not null
);
alter table public.ga4_performance_imports enable row level security;
alter table public.ga4_performance_sync_runs enable row level security;
create policy "team read gsc imports" on public.ga4_performance_imports for select to authenticated using ((select public.is_team()));
create policy "team read gsc syncs" on public.ga4_performance_sync_runs for select to authenticated using ((select public.is_team()));
revoke all on public.ga4_performance_imports,public.ga4_performance_sync_runs from public,anon,authenticated,service_role;
grant select on public.ga4_performance_imports,public.ga4_performance_sync_runs to authenticated;
grant select,insert,update on public.ga4_performance_sync_runs to service_role;

create function public.ga4_performance_record(p_client_id uuid,p_property text,p_start date,p_end date,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare previous jsonb; receipt uuid; pair record; begin
 if session_user <> 'authenticator' or coalesce(current_setting('role',true),'') <> 'service_role' then raise exception 'service only' using errcode='42501'; end if;
 if p_start is null or p_end is null or p_start>p_end or date_trunc('month',p_start)<>date_trunc('month',p_end) or p_end>current_date-4 then raise exception 'complete month required' using errcode='23514'; end if;
 perform 1 from public.clients where id=p_client_id and status in ('active','launching') and ga4_property=p_property for update;
 if not found then raise exception 'property binding changed' using errcode='23514'; end if;
 if jsonb_typeof(p_data->'values') is distinct from 'object'
 or (select count(*) from jsonb_object_keys(p_data->'values'))<>3
 or not(p_data->'values' ?& array['website_sessions','website_users','website_pageviews'])
 or coalesce(p_data->>'coverage','') not in ('complete_month','month_to_date','partial_launch_month')
 or not exists(select 1 from pg_timezone_names where name=p_data->>'time_zone')
 or coalesce(p_data->>'host','')<>regexp_replace(lower(substring((select website_url from public.clients where id=p_client_id) from '^https?://([^/]+)')),'^www\.','')
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


select cron.schedule('ga4-performance-daily','0 10 * * *',$job$
 select net.http_post(url:='https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/ga4-performance',
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||get_secret('SUPABASE_ANON_KEY'),'x-cron-secret',get_secret('SYNC_CRON_SECRET')),
 body:=jsonb_build_object('client_id',id),timeout_milliseconds:=120000)
 from public.clients where status in ('active','launching') and ga4_property is not null;
$job$);
