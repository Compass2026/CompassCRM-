-- Add direction requests to the shared report contract.
alter table public.report_measurements drop constraint report_measurements_metric_check;
alter table public.report_measurements add constraint report_measurements_metric_check check (metric in (
    'pages_live','pages_indexed','broken_links',
    'citations_correct','citations_incorrect','citations_missing',
    'referring_domains','links_new','links_lost',
    'gbp_views','gbp_clicks','gbp_call_clicks','gbp_directions',
    'reviews_total','reviews_rating','reviews_new','reviews_unanswered',
    'organic_top3','organic_top10','maps_top3',
    'search_impressions','search_clicks','organic_sessions',
    'forms','calls','qualified_leads',
    'social_posts','social_plan','social_reach','social_engagements','social_clicks','social_followers'
));

-- Import receipts
create table public.gbp_performance_imports (
 id uuid primary key default gen_random_uuid(),
 client_id uuid not null references public.clients(id),
 account_id text not null, location_id text not null,
 period date not null, period_end date not null,
 data jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create index gbp_performance_import_series on public.gbp_performance_imports(client_id,location_id,period,created_at desc);
create table public.gbp_performance_sync_runs (
 id uuid primary key default gen_random_uuid(),
 created_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 status text not null check(status in ('running','completed','partial')), results jsonb not null
);
alter table public.gbp_performance_imports enable row level security;
alter table public.gbp_performance_sync_runs enable row level security;
create policy "team read gbp imports" on public.gbp_performance_imports for select to authenticated using ((select public.is_team()));
create policy "team read gbp syncs" on public.gbp_performance_sync_runs for select to authenticated using ((select public.is_team()));
revoke all on public.gbp_performance_imports,public.gbp_performance_sync_runs from public,anon,authenticated,service_role;
grant select on public.gbp_performance_imports,public.gbp_performance_sync_runs to authenticated;
grant select,insert,update on public.gbp_performance_sync_runs to service_role;

create function public.gbp_performance_record(p_client_id uuid,p_account_id text,p_location_id text,p_start date,p_end date,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
declare previous jsonb; receipt uuid; pair record; source_name text:='Google Business Profile via Zernio'; scope_name text; begin
 if session_user <> 'authenticator' or coalesce(current_setting('role',true),'') <> 'service_role' then raise exception 'service only' using errcode='42501'; end if;
 if p_start<>date_trunc('month',p_start)::date or p_end<>(p_start+interval '1 month - 1 day')::date or p_end>current_date-4 then raise exception 'complete month required' using errcode='23514'; end if;
 perform 1 from public.social_accounts where client_id=p_client_id and platform='google_business' and publish_provider='zernio' and publish_account_id=p_account_id and publish_page_id=p_location_id and external_account_id=p_location_id for update;
 if not found then raise exception 'binding changed' using errcode='23514'; end if;
 if not exists(select 1 from public.clients where id=p_client_id and status in ('active','launching')) then raise exception 'client inactive' using errcode='23514'; end if;
 if jsonb_typeof(p_data->'values') is distinct from 'object' or jsonb_typeof(p_data->'daily') is distinct from 'object'
 or (select count(*) from jsonb_object_keys(p_data->'values'))<>4
 or not (p_data->'values' ?& array['gbp_views','gbp_clicks','gbp_call_clicks','gbp_directions']) then raise exception 'invalid metrics' using errcode='23514'; end if;
 for pair in select * from jsonb_each(p_data->'values') loop
  if jsonb_typeof(pair.value)<>'number' or pair.value::text::numeric<0 or pair.value::text::numeric<>trunc(pair.value::text::numeric) then raise exception 'invalid total' using errcode='23514'; end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended(p_client_id::text||p_location_id||p_start::text,0));
 select data into previous from public.gbp_performance_imports where client_id=p_client_id and location_id=p_location_id and period=p_start order by created_at desc,id desc limit 1;
 if previous=p_data then return jsonb_build_object('status','unchanged'); end if;
 insert into public.gbp_performance_imports(client_id,account_id,location_id,period,period_end,data) values(p_client_id,p_account_id,p_location_id,p_start,p_end,p_data) returning id into receipt;
 scope_name:='Google Business Profile '||p_location_id||' | complete calendar months';
 for pair in select * from jsonb_each(p_data->'values') order by key loop
  insert into public.report_measurements(client_id,metric,scope,source,context,report_period,window_start,window_end,status,value,evidence,meaning,next_action)
  values(p_client_id,pair.key,scope_name,source_name,'existing_client',p_start,p_start,p_end,'measured',pair.value::text::numeric,
   'Zernio performance import '||receipt||'; account '||p_account_id||'; exact location verified before and after retrieval; complete daily coverage.',
   case pair.key when 'gbp_views' then 'Sum of Search and Maps impressions across desktop and mobile. Not deduplicated people across devices, surfaces or days.' when 'gbp_call_clicks' then 'Clicks on the call button, not answered calls.' else 'Google-reported profile interactions for a complete calendar month.' end,
   'Review monthly progress; automatic imports refresh completed months.');
 end loop;
 return jsonb_build_object('status','imported','receipt_id',receipt);
end $$;
revoke all on function public.gbp_performance_record(uuid,text,text,date,date,jsonb) from public,anon,authenticated;
grant execute on function public.gbp_performance_record(uuid,text,text,date,date,jsonb) to service_role;

-- Existing pg_cron / pg_net integration. This reads Zernio; no posting or billing.
select cron.schedule('gbp-performance-daily','0 9 * * *',$job$
 select net.http_post(
  url:='https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/gbp-performance',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||get_secret('SUPABASE_ANON_KEY'),'x-cron-secret',get_secret('SYNC_CRON_SECRET')),
  body:='{}'::jsonb,timeout_milliseconds:=120000);
$job$);
