-- Brand board (spec §6.2b)
--
-- One brand record per client plus colors, fonts, and assets (logos, photos,
-- website / social screenshots — anything we know about the brand). Stored in
-- Postgres + Storage so the board is both the visual reference for the team
-- and a structured "brain" for AI content generation: get_brand_profile()
-- returns the whole brand as one JSON document.
--
-- Process hook: every client gets a "Build brand board" task (owner
-- CLAUDE+APPROVAL) the moment the client is created. When the client is later
-- enrolled in SEO, the task attaches itself to the Onboarding stage.

-- ── Enums ────────────────────────────────────────────────────────────────
create type brand_color_role as enum
  ('primary','secondary','accent','neutral','background','text','other');
create type brand_font_role as enum ('heading','body','accent','other');
create type brand_asset_kind as enum (
  'logo_primary','logo_alt','logo_icon','wordmark',
  'photo','website_screenshot','social_post','ad','print','pattern','video','other'
);
create type brand_asset_source as enum ('upload','link','website_scan');

-- ── Tables ───────────────────────────────────────────────────────────────
create table client_brands (
  client_id uuid primary key references clients(id) on delete cascade,
  tagline text,
  positioning text,              -- one line: what we do, for whom, why us
  story text,                    -- brand story / about
  audience text,                 -- who we talk to
  differentiators text,          -- why choose us over the next guy
  voice_tone text,               -- how we sound
  content_pillars text[] not null default '{}',
  words_we_use text[] not null default '{}',
  words_we_avoid text[] not null default '{}',
  imagery_style text,            -- photo / visual direction
  typography_notes text,
  ai_guidance text,              -- explicit instructions for AI-generated content
  approved_at timestamptz,
  approved_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table brand_colors (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  hex text not null check (hex ~ '^#[0-9a-f]{6}$'),
  role brand_color_role not null default 'other',
  usage text,                    -- where it is used (buttons, headings, backgrounds…)
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index brand_colors_client_idx on brand_colors (client_id, sort_order);

create table brand_fonts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  family text not null,
  role brand_font_role not null default 'other',
  source text,                   -- google / adobe / system / custom
  url text,                      -- where to get it
  weights text,                  -- e.g. "400, 600, 700"
  notes text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index brand_fonts_client_idx on brand_fonts (client_id, sort_order);

create table brand_assets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind brand_asset_kind not null default 'other',
  label text not null,
  source brand_asset_source not null default 'upload',
  storage_path text,             -- brand-assets bucket (uploads / scans)
  url text,                      -- external reference (links)
  file_name text,
  mime_type text,
  size_bytes bigint,
  width int,
  height int,
  is_primary boolean not null default false,
  notes text,
  sort_order int not null default 0,
  uploaded_by text,
  created_at timestamptz not null default now(),
  check (storage_path is not null or url is not null)
);
create index brand_assets_client_idx on brand_assets (client_id, kind, sort_order);

-- ── updated_at + touch the brand when any child row changes ──────────────
create trigger client_brands_updated_at before update on client_brands
  for each row execute function set_updated_at();

create function touch_client_brand() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_client uuid;
begin
  v_client := coalesce(new.client_id, old.client_id);
  insert into client_brands (client_id) values (v_client)
  on conflict (client_id) do update set updated_at = now();
  return null;
end $$;
revoke execute on function touch_client_brand() from public, anon, authenticated;

create trigger brand_colors_touch after insert or update or delete on brand_colors
  for each row execute function touch_client_brand();
create trigger brand_fonts_touch after insert or update or delete on brand_fonts
  for each row execute function touch_client_brand();
create trigger brand_assets_touch after insert or update or delete on brand_assets
  for each row execute function touch_client_brand();

-- ── Process hook: brand board task per client ────────────────────────────
-- tasks.key marks system-created tasks so automations can find them again.
alter table tasks add column key text;
create index tasks_client_key_idx on tasks (client_id, key) where key is not null;

create function handle_client_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into client_brands (client_id) values (new.id)
  on conflict (client_id) do nothing;

  insert into tasks (client_id, title, owner, status, key, notes)
  values (
    new.id,
    'Build brand board',
    'CLAUDE_APPROVAL',
    'open',
    'brand_board',
    'Draft the brand board from onboarding intake (logos, colors, fonts, voice, existing website / social material) on the Brand tab. Tom approves on the tab.'
  );
  return new;
end $$;
revoke execute on function handle_client_created() from public, anon, authenticated;

create trigger clients_created after insert on clients
  for each row execute function handle_client_created();

-- Attach the client's open brand-board task to the Onboarding stage when the
-- client is enrolled in a pipeline that has one (SEO).
create or replace function handle_pipeline_enrollment() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_onboarding uuid;
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

  select cs.id into v_onboarding
  from client_stages cs
  join stages s on s.id = cs.stage_id
  where cs.client_pipeline_id = new.id and s.name = 'Onboarding'
  limit 1;

  if v_onboarding is not null then
    update tasks
    set client_stage_id = v_onboarding
    where client_id = new.client_id
      and key = 'brand_board'
      and client_stage_id is null
      and status <> 'done';
  end if;

  return new;
end $$;

-- ── Backfill existing clients ────────────────────────────────────────────
insert into client_brands (client_id)
select id from clients
on conflict (client_id) do nothing;

insert into tasks (client_id, title, owner, status, key, notes)
select c.id, 'Build brand board', 'CLAUDE_APPROVAL', 'open', 'brand_board',
  'Draft the brand board from onboarding intake (logos, colors, fonts, voice, existing website / social material) on the Brand tab. Tom approves on the tab.'
from clients c
where not exists (select 1 from tasks t where t.client_id = c.id and t.key = 'brand_board');

update tasks t
set client_stage_id = cs.id
from client_stages cs
join client_pipelines cp on cp.id = cs.client_pipeline_id
join stages s on s.id = cs.stage_id
where t.client_id = cp.client_id
  and t.key = 'brand_board'
  and t.client_stage_id is null
  and s.name = 'Onboarding';

-- ── AI brain: the whole brand as one JSON document ───────────────────────
-- Runs as the caller (RLS applies). Asset rows carry the bucket + path; sign
-- them with Storage to fetch the bytes.
create function get_brand_profile(p_client_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'client', (
      select jsonb_build_object(
        'id', c.id, 'name', c.name, 'dba', c.dba, 'industry', c.industry,
        'website_url', c.website_url, 'phone', c.phone,
        'city', c.city, 'state', c.state, 'service_area', c.service_area,
        'status', c.status
      ) from clients c where c.id = p_client_id
    ),
    'brand', (
      select to_jsonb(b) - 'client_id' from client_brands b where b.client_id = p_client_id
    ),
    'colors', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', bc.name, 'hex', bc.hex, 'role', bc.role, 'usage', bc.usage
      ) order by bc.sort_order, bc.created_at)
      from brand_colors bc where bc.client_id = p_client_id
    ), '[]'::jsonb),
    'fonts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'family', bf.family, 'role', bf.role, 'source', bf.source,
        'url', bf.url, 'weights', bf.weights, 'notes', bf.notes
      ) order by bf.sort_order, bf.created_at)
      from brand_fonts bf where bf.client_id = p_client_id
    ), '[]'::jsonb),
    'assets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ba.id, 'kind', ba.kind, 'label', ba.label, 'source', ba.source,
        'bucket', case when ba.storage_path is not null then 'brand-assets' end,
        'storage_path', ba.storage_path, 'url', ba.url,
        'mime_type', ba.mime_type, 'width', ba.width, 'height', ba.height,
        'is_primary', ba.is_primary, 'notes', ba.notes
      ) order by ba.kind, ba.is_primary desc, ba.sort_order, ba.created_at)
      from brand_assets ba where ba.client_id = p_client_id
    ), '[]'::jsonb),
    'generated_at', now()
  );
$$;

-- ── RLS: internal tool — any authenticated team member has full access ───
do $$
declare t text;
begin
  foreach t in array array['client_brands','brand_colors','brand_fonts','brand_assets']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy "team full access" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ── Storage bucket for brand assets ──────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('brand-assets', 'brand-assets', false, 52428800)
on conflict (id) do nothing;

create policy "team read brand assets" on storage.objects
  for select to authenticated using (bucket_id = 'brand-assets');
create policy "team write brand assets" on storage.objects
  for insert to authenticated with check (bucket_id = 'brand-assets');
create policy "team update brand assets" on storage.objects
  for update to authenticated using (bucket_id = 'brand-assets');
create policy "team delete brand assets" on storage.objects
  for delete to authenticated using (bucket_id = 'brand-assets');
