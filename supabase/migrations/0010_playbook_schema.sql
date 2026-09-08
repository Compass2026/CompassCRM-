-- Playbook data model — docs/reconciliation.md "Schema additions"
-- (build order step 1). Additive only: nothing existing is restructured.
--
-- Steps 2 and 3 (reseed, Foundation triggers) live in 0011 and 0012 because
-- Postgres will not let a transaction use an enum value it has just added.
-- The City Index fix is 0013. 0008 (Stripe) and 0009 (brand board) belong to
-- their own branches and are already applied to the remote project.

-- ── Enum values on existing types ────────────────────────────────────────
alter type pipeline_key add value if not exists 'foundation' before 'seo';
alter type enrollment_status add value if not exists 'pending' before 'active';

-- ── New enums ────────────────────────────────────────────────────────────
create type autonomy_level as enum ('run', 'run_flag', 'hold');
create type taxonomy_status as enum ('proposed', 'approved', 'retired');
create type service_page_type as enum ('service', 'hub');
create type page_group_type as enum ('home', 'service', 'city', 'hub', 'other');
create type city_tier as enum ('1', '2', 'fold');
create type change_status as enum ('proposed', 'approved', 'vetoed');
create type brand_board_status as enum ('draft', 'approved');
create type claim_status as enum ('sourced', 'unverified', 'confirmed');
create type placeholder_type as enum ('image', 'claim', 'fact', 'project');
create type client_request_status as enum ('draft', 'sent', 'answered', 'closed');
create type site_stack as enum ('astro', 'nextjs', 'other');
create type business_type as enum ('storefront', 'service_area');

-- ── Columns on existing tables ───────────────────────────────────────────
alter table clients
  add column vertical text,
  add column business_type business_type,
  add column drive_folders jsonb; -- {onboarding, brand, keywords, website, reports, media}

alter table stages
  add column playbook_ref text,                                  -- PB1 … PB4b
  add column requires_foundation boolean not null default false, -- cannot start before Foundation
  add column autonomy_level autonomy_level;                      -- stage-level default; not in the doc's list

alter table task_templates
  add column playbook_step text,
  add column autonomy_level autonomy_level; -- copied onto tasks at creation; not in the doc's list

alter table tasks
  add column playbook_step text,
  add column autonomy_level autonomy_level,
  add column flagged_for_review boolean not null default false,
  add column recommendation text,
  add column default_if_approved text;

-- ── services — the taxonomy, the spine ───────────────────────────────────
create table services (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  segment text,
  gbp_entry text,
  page_url text,
  page_type service_page_type not null default 'service',
  parent_service_id uuid references services(id) on delete set null, -- folded sections
  primary_keyword_id uuid references keywords(id) on delete set null,
  status taxonomy_status not null default 'proposed',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index on services (client_id, sort_order);
create index on services (parent_service_id);

-- ── keywords — demand data + service link ────────────────────────────────
alter table keywords
  add column service_id uuid references services(id) on delete set null,
  add column city text,
  add column intent text,
  add column volume int,
  add column cpc numeric(8,2),
  add column competition numeric(6,2),
  add column is_money boolean not null default false,
  add column is_tracked boolean not null default false,
  add column source text,
  add column last_checked timestamptz;
create index on keywords (service_id);
create index on keywords (client_id) where is_money;

-- Keywords that already carry BrightLocal rank data are the tracked list.
update keywords k set is_tracked = true
where exists (
  select 1 from rank_snapshots rs
  where rs.keyword_id = k.id
    and rs.source in ('brightlocal_report', 'brightlocal_live')
);

-- ── page_groups — the sitemap plan ───────────────────────────────────────
create table page_groups (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  page_type page_group_type not null default 'service',
  target_url text,
  primary_keyword_id uuid references keywords(id) on delete set null,
  supporting_keyword_ids uuid[] not null default '{}',
  city_tier city_tier,
  serp_notes text,
  status taxonomy_status not null default 'proposed',
  created_at timestamptz not null default now()
);
create index on page_groups (client_id);

-- ── money_keywords — confirmed money terms + alert thresholds ────────────
create table money_keywords (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade, -- every new table carries client_id
  keyword_id uuid not null unique references keywords(id) on delete cascade,
  confirmed_by text,
  confirmed_on timestamptz,
  alert_threshold_map int not null default 3,
  alert_threshold_organic int not null default 5,
  created_at timestamptz not null default now()
);
create index on money_keywords (client_id);

-- keywords.is_money mirrors membership here.
create function sync_keyword_is_money() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    update keywords set is_money = false where id = old.keyword_id;
    return old;
  end if;
  update keywords set is_money = true where id = new.keyword_id;
  return new;
end $$;
revoke execute on function sync_keyword_is_money() from public, anon, authenticated;
create trigger money_keywords_sync after insert or delete on money_keywords
  for each row execute function sync_keyword_is_money();

-- ── alerts — money keyword drops ─────────────────────────────────────────
create table alerts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  keyword_id uuid not null references keywords(id) on delete cascade,
  location_id uuid references locations(id) on delete set null, -- which city; not in the doc's list
  result_type rank_result_type,                                  -- which threshold tripped; not in the doc's list
  triggered_on timestamptz not null default now(),
  previous_rank int,
  current_rank int,
  source text,
  acknowledged boolean not null default false,
  acknowledged_at timestamptz
);
create index on alerts (client_id, acknowledged, triggered_on desc);

-- ── change_log — proposed / approved / vetoed changes with evidence ──────
create table change_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  change_type text not null,
  object_type text not null,
  object_id uuid,
  before jsonb,
  after jsonb,
  reasoning text,
  evidence text,
  status change_status not null default 'proposed',
  reviewed_by text,
  reviewed_on timestamptz,
  created_at timestamptz not null default now()
);
create index on change_log (client_id, created_at desc);

-- ── decisions — rules learned from approvals / vetoes ────────────────────
create table decisions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade, -- null = global rule
  task_id uuid references tasks(id) on delete set null,
  playbook_step text, -- promotion matches on this; not in the doc's list
  decision text not null,
  rule_text text,
  decided_by text,
  decided_on timestamptz not null default now(),
  match_count int not null default 1 -- promotion proposed at 3
);
create index on decisions (client_id);
create index on decisions (playbook_step, decision);

-- ── brand_boards — structured brand fields, versioned ────────────────────
create table brand_boards (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  version int not null default 1,
  status brand_board_status not null default 'draft',
  palette jsonb not null default '[]',   -- [{role, hex, usage}]
  typography jsonb not null default '{}',
  positioning_line text,
  standing_cta text,
  hard_rules text[] not null default '{}',
  drive_doc_url text,
  approved_by text,
  approved_on timestamptz,
  created_at timestamptz not null default now(),
  unique (client_id, version)
);

-- ── claims — sourced vs unverified statements ────────────────────────────
create table claims (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  claim text not null,
  status claim_status not null default 'unverified',
  source text,
  confirmed_by text,
  confirmed_on timestamptz,
  created_at timestamptz not null default now()
);
create index on claims (client_id, status);

-- ── sites — the sites Compass builds or inherits ─────────────────────────
create table sites (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  url text,
  stack site_stack not null default 'astro',
  controlled_by_compass boolean not null default false,
  repo_url text,
  vercel_project text,
  staging_url text,
  domain_constant text,
  launched_at date,
  created_at timestamptz not null default now()
);
create index on sites (client_id);

-- ── client_requests — batched asks drafted by Claude, sent by Tom ────────
create table client_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  items jsonb not null default '[]',
  drafted_by_claude_at timestamptz,
  sent_by_tom_at timestamptz,
  responses jsonb,
  status client_request_status not null default 'draft',
  created_at timestamptz not null default now()
);
create index on client_requests (client_id, status);

-- ── placeholders — what the build is still waiting on ────────────────────
create table placeholders (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  site_id uuid references sites(id) on delete cascade,
  page text,
  type placeholder_type not null,
  description text,
  client_request_id uuid references client_requests(id) on delete set null,
  resolved boolean not null default false,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index on placeholders (client_id, resolved);
create index on placeholders (site_id);

-- ── industry_pulse — one per vertical per month (Playbook 6) ─────────────
create table industry_pulse (
  id uuid primary key default gen_random_uuid(),
  vertical text not null,
  period date not null, -- first of month
  rising_queries jsonb not null default '[]',
  serp_changes jsonb not null default '[]',
  competitor_moves jsonb not null default '[]',
  news_items jsonb not null default '[]',
  affected_client_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (vertical, period)
);

-- ── RLS: same blanket team policy as 0001 ────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'services','page_groups','money_keywords','alerts','change_log','decisions',
    'brand_boards','claims','sites','client_requests','placeholders','industry_pulse'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy "team full access" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
