-- Compass Client Platform — initial schema (spec v0.2 §8)

-- ── Enums ────────────────────────────────────────────────────────────────
create type client_status as enum ('launching','active','paused','offboarded');
create type access_system as enum ('gsc','ga4','gbp','hosting','dns','meta_ads','google_ads','facebook','instagram','linkedin','tiktok','crm','other');
create type access_status as enum ('not_needed','requested','granted');
create type pipeline_key as enum ('seo','website','social','crm','paid_ads','reporting');
create type owner_type as enum ('TOM','CLAUDE','CLAUDE_APPROVAL','DELEGATED','WAITING');
create type stage_status as enum ('not_started','in_progress','blocked','skipped','complete');
create type task_status as enum ('open','in_progress','blocked','done');
create type enrollment_status as enum ('active','complete','paused');
create type deliverable_type as enum ('drive','site','sheet','report','other');
create type document_kind as enum ('drive_link','upload');
create type document_category as enum ('contract','proposal','brand','audit','report','other');
create type keyword_priority as enum ('p1','p2','p3');
create type department as enum ('seo','website','social','paid_ads');
create type rank_result_type as enum ('organic','map_pack');
create type rank_source as enum ('brightlocal_report','brightlocal_live','csv','manual');
create type run_trigger as enum ('cron','manual');
create type run_status as enum ('pending','running','complete','failed');
create type payment_method_type as enum ('card','us_bank_account','external_ach');
create type paid_status_type as enum ('paid','processing','open','past_due');
create type payment_source as enum ('stripe','manual');
create type payment_method as enum ('card','stripe_ach','external_ach','check');
create type content_status as enum ('idea','brief','draft','review','published');
create type social_platform as enum ('facebook','instagram','linkedin','x','tiktok');
create type social_account_status as enum ('connected','expired','manual_only');
create type social_post_status as enum ('idea','drafted','approved','scheduled','published','failed');
create type cycle_status as enum ('open','complete');
create type team_role as enum ('admin','member');

-- ── Core tables ──────────────────────────────────────────────────────────
create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  dba text,
  industry text,
  website_url text,
  phone text,
  address_line1 text,
  city text,
  state text,
  zip text,
  service_area text,
  status client_status not null default 'launching',
  signed_at date,
  kickoff_at date,
  launched_at date,
  renewal_at date,
  drive_root_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  role text,
  email text,
  phone text,
  is_primary boolean not null default false
);

create table client_access (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  system access_system not null,
  status access_status not null default 'not_needed',
  notes text,
  updated_at timestamptz not null default now(),
  unique (client_id, system)
);

create table plans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  package_name text,
  monthly_fee numeric(10,2),
  term_months int,
  start_date date,
  renewal_date date,
  gbp_posts_per_month int,
  blog_posts_per_month int,
  social_posts_per_month int,
  ad_budget_managed numeric(10,2),
  notes text,
  unique (client_id)
);

-- ── Pipeline templates ───────────────────────────────────────────────────
create table pipelines (
  id uuid primary key default gen_random_uuid(),
  key pipeline_key not null unique,
  name text not null,
  sort_order int not null default 0,
  is_recurring boolean not null default false
);

create table stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  is_optional boolean not null default false,
  description text,
  default_owner owner_type not null default 'TOM'
);

create table task_templates (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid references stages(id) on delete cascade,
  pipeline_id uuid references pipelines(id) on delete cascade, -- for recurring (reporting) tasks
  department department, -- recurring tasks only included for clients enrolled in this department; null = always
  title text not null,
  default_owner owner_type not null default 'TOM',
  sort_order int not null default 0
);

-- ── Enrollment / progress ────────────────────────────────────────────────
create table client_pipelines (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  pipeline_id uuid not null references pipelines(id) on delete restrict,
  enrolled_at timestamptz not null default now(),
  completed_at timestamptz,
  status enrollment_status not null default 'active',
  unique (client_id, pipeline_id)
);

create table client_stages (
  id uuid primary key default gen_random_uuid(),
  client_pipeline_id uuid not null references client_pipelines(id) on delete cascade,
  stage_id uuid not null references stages(id) on delete cascade,
  status stage_status not null default 'not_started',
  owner owner_type not null default 'TOM',
  due_date date,
  started_at timestamptz,
  completed_at timestamptz,
  evidence text,
  next_action text,
  notes text,
  unique (client_pipeline_id, stage_id)
);

create table monthly_cycles (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  period date not null, -- first of month
  status cycle_status not null default 'open',
  report_url text,
  rank_summary jsonb,
  notes text,
  completed_at timestamptz,
  unique (client_id, period)
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  client_stage_id uuid references client_stages(id) on delete cascade,
  monthly_cycle_id uuid references monthly_cycles(id) on delete cascade,
  title text not null,
  owner owner_type not null default 'TOM',
  status task_status not null default 'open',
  due_date date,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table deliverables (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  client_stage_id uuid references client_stages(id) on delete cascade,
  monthly_cycle_id uuid references monthly_cycles(id) on delete cascade,
  label text not null,
  url text not null,
  type deliverable_type not null default 'drive'
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind document_kind not null,
  label text not null,
  category document_category not null default 'other',
  url text,           -- drive links
  storage_path text,  -- uploads
  file_name text,
  mime_type text,
  uploaded_by text,
  created_at timestamptz not null default now(),
  notes text
);

-- ── Keywords & rank tracking ─────────────────────────────────────────────
create table keywords (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  keyword text not null,
  target_url text,
  priority keyword_priority not null default 'p2',
  department department not null default 'seo',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (client_id, keyword)
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  city text,
  state text,
  lat double precision,
  lng double precision,
  is_physical_location boolean not null default false,
  gbp_place_id text,
  brightlocal_location_id text,
  brightlocal_lrt_report_id text,
  is_active boolean not null default true,
  sort_order int not null default 0
);

create table rank_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  triggered_by run_trigger not null default 'manual',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status run_status not null default 'pending',
  checks_count int,
  error text
);

create table rank_snapshots (
  id uuid primary key default gen_random_uuid(),
  keyword_id uuid not null references keywords(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  result_type rank_result_type not null,
  position int, -- null = not in top 100
  url_ranked text,
  recorded_at timestamptz not null default now(),
  source rank_source not null default 'brightlocal_report',
  run_id uuid references rank_runs(id) on delete set null
);

create table grid_configs (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  brightlocal_lsg_report_id text,
  grid_size int not null default 7,
  spacing_miles numeric(4,1) not null default 1,
  center_lat double precision,
  center_lng double precision,
  keyword_ids uuid[] not null default '{}',
  is_active boolean not null default true
);

create table grid_snapshots (
  id uuid primary key default gen_random_uuid(),
  grid_config_id uuid not null references grid_configs(id) on delete cascade,
  keyword_id uuid not null references keywords(id) on delete cascade,
  recorded_at timestamptz not null default now(),
  avg_map_rank numeric(5,2),
  share_of_voice numeric(5,2),
  points jsonb, -- [{lat,lng,position}]
  competitors jsonb,
  report_url text,
  run_id uuid references rank_runs(id) on delete set null
);

create table location_index (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  period date not null,
  organic_index numeric(5,2),
  map_index numeric(5,2),
  keywords_counted int not null default 0,
  computed_at timestamptz not null default now(),
  unique (location_id, period)
);

create table gsc_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  keyword_id uuid references keywords(id) on delete set null, -- matched by query text
  query text not null,
  page text,
  clicks int not null default 0,
  impressions int not null default 0,
  ctr numeric(6,4),
  avg_position numeric(6,2),
  period_start date not null,
  period_end date not null,
  recorded_at timestamptz not null default now()
);

-- ── Billing (Stripe) ─────────────────────────────────────────────────────
create table stripe_customers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  stripe_customer_id text not null unique,
  payment_method_type payment_method_type,
  last4 text,
  created_at timestamptz not null default now(),
  unique (client_id)
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  stripe_subscription_id text unique, -- nullable for external-ACH clients
  stripe_price_id text,
  amount numeric(10,2),
  interval text not null default 'month',
  status text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  paid_status paid_status_type not null default 'open',
  cancel_at timestamptz,
  created_at timestamptz not null default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  subscription_id uuid references subscriptions(id) on delete set null,
  source payment_source not null default 'stripe',
  stripe_invoice_id text unique,
  stripe_payment_intent_id text,
  amount numeric(10,2) not null,
  method payment_method,
  period_start date,
  period_end date,
  reference text,
  paid_at timestamptz,
  recorded_by text,
  notes text
);

-- ── Content & social ─────────────────────────────────────────────────────
create table content_posts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  keyword_id uuid references keywords(id) on delete set null,
  title text not null,
  status content_status not null default 'idea',
  owner owner_type not null default 'TOM',
  due_date date,
  url text,
  published_at date,
  word_count int,
  notes text
);

create table social_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  platform social_platform not null,
  external_account_id text,
  display_name text,
  access_token text, -- encrypted at rest; only populated in publishing phase
  token_expires_at timestamptz,
  status social_account_status not null default 'manual_only',
  connected_at timestamptz
);

create table social_posts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  social_account_id uuid references social_accounts(id) on delete set null,
  platform social_platform not null,
  copy text,
  asset_url text,
  storage_path text,
  scheduled_at timestamptz,
  status social_post_status not null default 'idea',
  published_url text,
  external_post_id text,
  error text,
  notes text
);

-- ── Team & settings ──────────────────────────────────────────────────────
create table team_members (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  name text not null,
  email text not null unique,
  role team_role not null default 'member'
);

create table app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────
create index on client_contacts (client_id);
create index on client_access (client_id);
create index on client_pipelines (client_id);
create index on client_stages (client_pipeline_id);
create index on tasks (client_id);
create index on tasks (client_stage_id);
create index on tasks (monthly_cycle_id);
create index on tasks (owner, status);
create index on deliverables (client_id);
create index on documents (client_id);
create index on keywords (client_id);
create index on locations (client_id);
create index on rank_snapshots (keyword_id, location_id, recorded_at);
create index on rank_snapshots (run_id);
create index on grid_snapshots (grid_config_id, recorded_at);
create index on gsc_snapshots (client_id, period_start);
create index on gsc_snapshots (keyword_id);
create index on monthly_cycles (client_id, period);
create index on subscriptions (client_id);
create index on payments (client_id);
create index on content_posts (client_id, status);
create index on social_posts (client_id, status);
create index on rank_runs (client_id);
create index on location_index (location_id, period);

-- ── updated_at maintenance ───────────────────────────────────────────────
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger clients_updated_at before update on clients
  for each row execute function set_updated_at();
create trigger client_access_updated_at before update on client_access
  for each row execute function set_updated_at();
create trigger app_settings_updated_at before update on app_settings
  for each row execute function set_updated_at();

-- ── Automation: enrollment creates stages + tasks ────────────────────────
create function handle_pipeline_enrollment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into client_stages (client_pipeline_id, stage_id, status, owner)
  select new.id, s.id, 'not_started', s.default_owner
  from stages s
  where s.pipeline_id = new.pipeline_id
  order by s.sort_order;

  insert into tasks (client_id, client_stage_id, title, owner, status)
  select new.client_id, cs.id, tt.title, tt.default_owner, 'open'
  from client_stages cs
  join task_templates tt on tt.stage_id = cs.stage_id
  where cs.client_pipeline_id = new.id
  order by tt.sort_order;

  return new;
end $$;

create trigger client_pipelines_enrollment after insert on client_pipelines
  for each row execute function handle_pipeline_enrollment();

-- ── Automation: stage timestamps + pipeline completion ───────────────────
create function handle_stage_status_change() returns trigger
language plpgsql as $$
begin
  if new.status = 'in_progress' and old.status is distinct from 'in_progress' and new.started_at is null then
    new.started_at = now();
  end if;
  if new.status = 'complete' and old.status is distinct from 'complete' then
    new.completed_at = now();
  end if;
  if new.status <> 'complete' then
    new.completed_at = null;
  end if;
  return new;
end $$;

create trigger client_stages_status before update on client_stages
  for each row execute function handle_stage_status_change();

-- After a stage completes/skips, mark the pipeline complete when nothing blocks.
-- Required stages must be complete or skipped; optional stages block only while
-- in_progress or blocked.
create function check_pipeline_completion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('complete','skipped') and old.status is distinct from new.status then
    if not exists (
      select 1
      from client_stages cs
      join stages s on s.id = cs.stage_id
      where cs.client_pipeline_id = new.client_pipeline_id
        and cs.id <> new.id
        and (
          (not s.is_optional and cs.status not in ('complete','skipped'))
          or (s.is_optional and cs.status in ('in_progress','blocked'))
        )
    ) then
      update client_pipelines
      set status = 'complete', completed_at = now()
      where id = new.client_pipeline_id and status <> 'complete';
    end if;
  end if;
  return new;
end $$;

create trigger client_stages_completion after update on client_stages
  for each row execute function check_pipeline_completion();

-- ── Automation: convergence → active + Reporting enrollment ──────────────
create function handle_pipeline_completion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'complete' and old.status is distinct from 'complete' then
    if not exists (
      select 1
      from client_pipelines cp
      join pipelines p on p.id = cp.pipeline_id
      where cp.client_id = new.client_id
        and p.is_recurring = false
        and cp.status <> 'complete'
    ) then
      update clients set status = 'active'
      where id = new.client_id and status = 'launching';

      insert into client_pipelines (client_id, pipeline_id, status)
      select new.client_id, p.id, 'active'
      from pipelines p
      where p.is_recurring
        and not exists (
          select 1 from client_pipelines cp2
          where cp2.client_id = new.client_id and cp2.pipeline_id = p.id
        );
    end if;
  end if;
  return new;
end $$;

create trigger client_pipelines_convergence after update on client_pipelines
  for each row execute function handle_pipeline_completion();

-- ── Automation: monthly cycle creation (called by cron / Edge Function) ──
create function create_monthly_cycles(p_period date default date_trunc('month', now())::date)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_count int := 0;
  v_client record;
  v_cycle_id uuid;
begin
  for v_client in
    select c.id
    from clients c
    where c.status = 'active'
      and exists (
        select 1 from client_pipelines cp
        join pipelines p on p.id = cp.pipeline_id
        where cp.client_id = c.id and p.is_recurring and cp.status = 'active'
      )
      and not exists (
        select 1 from monthly_cycles mc
        where mc.client_id = c.id and mc.period = p_period
      )
  loop
    insert into monthly_cycles (client_id, period)
    values (v_client.id, p_period)
    returning id into v_cycle_id;

    insert into tasks (client_id, monthly_cycle_id, title, owner, status)
    select v_client.id, v_cycle_id, tt.title, tt.default_owner, 'open'
    from task_templates tt
    join pipelines p on p.id = tt.pipeline_id and p.is_recurring
    where tt.department is null
       or exists (
         select 1 from client_pipelines cp
         join pipelines dp on dp.id = cp.pipeline_id
         where cp.client_id = v_client.id and dp.key::text = tt.department::text
       )
    order by tt.sort_order;

    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ── RLS: internal tool — any authenticated team member has full access ───
-- Portal phase adds client-scoped policies; every table carries client_id
-- (directly or via join) so that is a policy addition only.
do $$
declare t text;
begin
  foreach t in array array[
    'clients','client_contacts','client_access','plans','pipelines','stages',
    'task_templates','client_pipelines','client_stages','tasks','deliverables',
    'documents','keywords','locations','rank_runs','rank_snapshots',
    'grid_configs','grid_snapshots','location_index','gsc_snapshots',
    'stripe_customers','subscriptions','payments','content_posts',
    'social_accounts','social_posts','monthly_cycles','team_members','app_settings'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy "team full access" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ── Storage bucket for uploaded documents ────────────────────────────────
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy "team read documents" on storage.objects
  for select to authenticated using (bucket_id = 'documents');
create policy "team write documents" on storage.objects
  for insert to authenticated with check (bucket_id = 'documents');
create policy "team update documents" on storage.objects
  for update to authenticated using (bucket_id = 'documents');
create policy "team delete documents" on storage.objects
  for delete to authenticated using (bucket_id = 'documents');
