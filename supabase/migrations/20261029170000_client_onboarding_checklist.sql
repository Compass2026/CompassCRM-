-- New Client Onboarding v1.0 (Oct 29 2026; docs/client-onboarding.md).
-- Written, NOT applied. Additive: no client is enrolled by this migration and
-- no existing task, stage, listing or completion is rewritten except the
-- titles of still-OPEN legacy BrightLocal / Metricool tasks (§5).
--
-- Tom's handwritten master checklist becomes ONE reusable per-client
-- checklist that points at the records that already exist instead of copying
-- them:
--   * pipeline tasks (tasks.key): gsc_verify, ga4, google_access,
--     zernio_connect, bing_webmaster, map_grid_profile …
--   * Citation Tracker listings (citation_listing_overview) per business
--     location (citation_locations) and directory (citation_directories);
--   * Search Console / GA4 import receipts, Zernio bindings (social_accounts),
--     sites, client_access.
-- Those are shown beside each item as evidence signals. A signal never moves
-- an item: status changes are a teammate's, with evidence. "Verified" can only
-- be set by a signed-in team member (never a connected account, the worker or
-- the service role), and a citation item can only be claimed / verified when
-- the Citation Tracker holds a listing (verified: a current accurate check).
--
-- Statuses keep the three things the checklist must not merge apart:
--   requested (access asked for) → connected (connection works) → verified
--   (data or listing evidence seen), plus submitted / claimed for listings and
--   needs_correction / inaccessible / blocked / not_applicable.
-- Done = verified, or not_applicable with a reason.
--
-- Rollback: supabase/rollback/20261029170000_client_onboarding_checklist.down.sql

-- ── 1. The registry (reference data, versioned with the standard) ──────────
create table public.onboarding_items (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,59}$'),
  section text not null check (section in ('identity','search','citations','social','website')),
  -- client: one row per client; site: one per sites row; location: one per
  -- active citation_locations row (the approved identity of a real business).
  scope text not null check (scope in ('client','site','location')),
  title text not null check (length(btrim(title)) between 1 and 200),
  guidance text not null default '' check (length(guidance) <= 2000),
  default_owner owner_type not null default 'TOM',
  required boolean not null default true,
  depends_on text[] not null default '{}',
  -- Which existing record backs the evidence signal (client_onboarding_overview).
  evidence_source text check (evidence_source in ('access','location_identity','site','gsc','ga4','gbp_binding','facebook_binding','citation','website_pipeline')),
  citation_directory_key text references public.citation_directories(key),
  -- The existing pipeline task this item tracks (tasks.key on the same client).
  pipeline_task_key text,
  standard_version text not null default '1.0',
  sort_order integer not null,
  is_active boolean not null default true,
  check ((evidence_source = 'citation') = (citation_directory_key is not null)),
  check (evidence_source <> 'citation' or scope = 'location')
);
comment on table public.onboarding_items is 'New Client Onboarding standard (v1.0). Reference data; per-client state lives in client_onboarding_items.';

insert into public.onboarding_items (key, section, scope, sort_order, title, default_owner, required, depends_on, evidence_source, citation_directory_key, pipeline_task_key, guidance) values
  -- A. Identity, site, brand, locations
  ('identity_business', 'identity', 'client', 10, 'Legal name, DBA, primary phone and website confirmed', 'TOM', true, '{}', null, null, null,
   'Use the agreement / intake as evidence. This is the name every listing must match.'),
  ('identity_location', 'identity', 'location', 20, 'Location identity approved: NAP, public vs hidden address, branch eligibility', 'TOM', true, '{identity_business}', 'location_identity', null, null,
   'Approve the identity on the Citations tab. A service-area business hides its street; confirm each directory accepts a hidden address before listing it.'),
  ('service_areas', 'identity', 'client', 30, 'Service areas confirmed (cities / radius)', 'TOM', true, '{identity_business}', null, null, null,
   'Feeds service-area listings, keywords and city pages.'),
  ('website_owner', 'identity', 'site', 40, 'Approved website, primary CTA and who controls the site recorded', 'TOM', true, '{identity_business}', 'site', null, null,
   'Compass-run or client-run. Record the CTA (call, form, booking) the site and listings point to.'),
  ('access_requests', 'identity', 'client', 50, 'Access requested for GSC, GA4, GBP, Facebook, DNS / hosting', 'TOM', true, '{}', 'access', null, null,
   'Track each on Overview › Access. Record who granted what and when — never a password or token.'),
  -- B. Search and analytics
  ('gsc_verified', 'search', 'site', 110, 'Search Console domain property verified for the Compass account', 'TOM', true, '{website_owner,access_requests}', 'gsc', null, 'gsc_verify',
   'Domain property (sc-domain:) preferred. Verified = the property is set on the client and an import has landed.'),
  ('ga4_stream', 'search', 'site', 120, 'GA4 property, web stream and tag on the live site; phone_click / form_submit key events', 'TOM', true, '{website_owner,access_requests}', 'ga4', null, 'ga4',
   'A property existing is not the tag installed. Check collection on the production host.'),
  ('ga4_reporting', 'search', 'site', 130, 'GA4 data proven in reporting', 'TOM', true, '{ga4_stream}', 'ga4', null, null,
   'Verified = a dated GA4 window shows on the Progress tab. New properties have no history.'),
  ('gsc_ga4_link', 'search', 'site', 140, 'Search Console linked to GA4', 'TOM', true, '{gsc_verified,ga4_stream}', null, null, null,
   'GA4 Admin › Product links › Search Console. Evidence: the link screen.'),
  ('gbp_ownership', 'search', 'location', 150, 'Business Profile claimed, verified, Compass as manager, exact location matched', 'TOM', true, '{identity_location}', 'gbp_binding', null, 'google_access',
   'Exact location = the place id of this business location. Tag the GBP website link with UTM so GA4 attributes it. Existing location holds stay in force.'),
  ('bing_webmaster', 'search', 'site', 160, 'Bing Webmaster Tools: site verified and sitemap submitted', 'TOM', true, '{gsc_verified}', null, null, 'bing_webmaster',
   'Import from Search Console or verify by DNS. This is the site in Bing search — separate from the Bing Places listing.'),
  -- C. Citations (one row per business location, backed by the Citation Tracker)
  ('citation_gbp', 'citations', 'location', 210, 'Google Business Profile listing matches the approved identity', 'TOM', true, '{identity_location}', 'citation', 'google_business_profile', null,
   'Record the listing and a check on the Citations tab.'),
  ('citation_apple', 'citations', 'location', 220, 'Apple Maps (Apple Business Connect) listing', 'TOM', true, '{identity_location}', 'citation', 'apple_business_connect', null,
   'Claim through Apple Business Connect. Not applicable needs a reason (e.g. hidden-address eligibility).'),
  ('citation_bing_places', 'citations', 'location', 230, 'Bing Places listing', 'TOM', true, '{identity_location}', 'citation', 'bing_places', null,
   'Can import from Google Business Profile once GBP is verified.'),
  ('citation_bbb', 'citations', 'location', 240, 'BBB free / basic listing (where genuinely offered)', 'TOM', true, '{identity_location}', 'citation', 'bbb', null,
   'Free listing only. Never pay for accreditation or a listing without Tom''s written approval; record not applicable if no free listing is offered.'),
  ('citation_mapquest', 'citations', 'location', 250, 'MapQuest listing', 'TOM', true, '{identity_location}', 'citation', 'mapquest', null, ''),
  ('citation_yelp', 'citations', 'location', 260, 'Yelp listing', 'TOM', true, '{identity_location}', 'citation', 'yelp', null,
   'Free business account only; no Yelp ads.'),
  ('citation_nextdoor', 'citations', 'location', 270, 'Nextdoor business page', 'TOM', true, '{identity_location}', 'citation', 'nextdoor', null, ''),
  -- D. Social (Zernio is transport; connection is not permission to publish)
  ('zernio_facebook', 'social', 'client', 310, 'Facebook Page bound through Zernio to the right client / brand, read and publish verified', 'TOM', true, '{access_requests}', 'facebook_binding', null, 'zernio_connect',
   'Verified = the exact Page is bound and verified for this client (and brand workspace). Publishing stays off until Tom enables it; a binding is not a published receipt.'),
  ('zernio_gbp', 'social', 'location', 320, 'Business Profile location bound through Zernio', 'TOM', true, '{gbp_ownership}', 'gbp_binding', null, null,
   'Bind the exact locations/N of this business location. Blocked GBP location holds are not lifted here.'),
  ('social_profile_links', 'social', 'site', 330, 'Social profile links on the website and GBP; sameAs in structured data', 'TOM', true, '{zernio_facebook}', null, null, null,
   'Only profiles the client owns and keeps.'),
  ('other_social_channels', 'social', 'client', 340, 'Other social channels (Instagram, LinkedIn, …) per agreement', 'TOM', false, '{}', null, null, null,
   'Only what the agreement covers. Nothing here is a Search Console connection — Search Console has no social integration.'),
  -- E. Website (the Website pipeline stays the source of truth)
  ('website_path', 'website', 'site', 410, 'Existing-site audit / optimisation vs new build decided', 'TOM', true, '{website_owner}', 'website_pipeline', null, null,
   'Recorded as the site''s work mode and the Website pipeline. Detailed Website Builds checklist: to be expanded from Tom''s notes.'),
  ('website_live_measured', 'website', 'site', 420, 'Website launched, indexed and measured', 'TOM', true, '{website_path,gsc_verified,ga4_reporting}', 'website_pipeline', null, null,
   'Built is not launched, launched is not indexed, indexed is not measured: evidence for all three.');

-- ── 2. Per-client state ────────────────────────────────────────────────────
create table public.client_onboarding_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  item_key text not null references public.onboarding_items(key) on delete restrict,
  site_id uuid references public.sites(id), -- no action: a whole-client delete cascades; a lone site or location delete is refused
  location_id uuid references public.citation_locations(id),
  status text not null default 'not_started' check (status in (
    'not_started','requested','in_progress','submitted','claimed','connected',
    'verified','needs_correction','inaccessible','blocked','not_applicable')),
  required boolean not null default true,
  owner owner_type not null default 'TOM',
  due_on date,
  evidence_url text check (evidence_url is null or (length(evidence_url) <= 2000 and evidence_url ~ '^https?://[^/[:space:]?#@]+')),
  evidence_note text not null default '' check (length(evidence_note) <= 2000),
  blocking_reason text not null default '' check (length(blocking_reason) <= 1000),
  next_action text not null default '' check (length(next_action) <= 1000),
  last_verified_at timestamptz,
  verified_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique nulls not distinct (client_id, item_key, site_id, location_id),
  -- Evidence rules (a connected account never signs anything off).
  check (status not in ('submitted','claimed','connected','verified') or evidence_url is not null or btrim(evidence_note) <> ''),
  check (status <> 'verified' or (last_verified_at is not null and verified_by is not null)),
  check (status <> 'not_applicable' or btrim(evidence_note) <> ''),
  check (status <> 'blocked' or btrim(blocking_reason) <> ''),
  check (status not in ('needs_correction','inaccessible') or btrim(next_action) <> ''),
  -- Access is tracked, credentials never are.
  check ((evidence_note || ' ' || coalesce(evidence_url, '')) !~* '(password|passwd|api[_ -]?key|secret|token)\s*[:=]')
);
create index client_onboarding_items_client on public.client_onboarding_items(client_id, item_key);
comment on table public.client_onboarding_items is 'New Client Onboarding checklist state per client / site / business location. Done = verified, or not_applicable with a reason.';

-- Append-only history: every status / evidence change, so completion evidence is never lost.
create table public.client_onboarding_events (
  id bigint generated always as identity primary key,
  item_id uuid not null references public.client_onboarding_items(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  status text not null,
  evidence_url text,
  evidence_note text not null,
  blocking_reason text not null,
  next_action text not null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid
);
create index client_onboarding_events_item on public.client_onboarding_events(item_id, id desc);

-- Scope and evidence guard.
create function public.guard_client_onboarding_item() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_item public.onboarding_items;
  v_dir uuid;
begin
  select * into v_item from public.onboarding_items where key = new.item_key;
  if tg_op = 'UPDATE' and (new.client_id <> old.client_id or new.item_key <> old.item_key
      or new.site_id is distinct from old.site_id or new.location_id is distinct from old.location_id) then
    raise exception using errcode = '23514', message = 'An onboarding item cannot move to another client, item or scope.';
  end if;
  if (v_item.scope = 'client') <> (new.site_id is null and new.location_id is null)
     or (v_item.scope = 'site') <> (new.site_id is not null and new.location_id is null)
     or (v_item.scope = 'location') <> (new.location_id is not null and new.site_id is null) then
    raise exception using errcode = '23514', message = format('Item %s is %s-scoped.', new.item_key, v_item.scope);
  end if;
  if new.site_id is not null and not exists (select 1 from public.sites s where s.id = new.site_id and s.client_id = new.client_id) then
    raise exception using errcode = '23514', message = 'That site belongs to another client.';
  end if;
  if new.location_id is not null and not exists (select 1 from public.citation_locations l where l.id = new.location_id and l.client_id = new.client_id) then
    raise exception using errcode = '23514', message = 'That business location belongs to another client.';
  end if;

  if new.status = 'verified' and (tg_op = 'INSERT' or old.status <> 'verified'
      or new.evidence_url is distinct from old.evidence_url or new.evidence_note <> old.evidence_note) then
    -- Only a signed-in teammate signs off, never a connection, the worker or the service role.
    if auth.uid() is null or not public.is_team() then
      raise exception using errcode = '42501', message = 'Only a signed-in team member can mark an onboarding item verified.';
    end if;
    new.verified_by := auth.uid();
    new.last_verified_at := now();
  elsif new.status = 'verified' then
    -- An unchanged sign-off keeps who made it and when.
    new.verified_by := old.verified_by;
    new.last_verified_at := old.last_verified_at;
  end if;

  -- A listing is claimed / verified only when the Citation Tracker holds it.
  if v_item.citation_directory_key is not null and new.status in ('claimed','verified')
     and (tg_op = 'INSERT' or new.status <> old.status) then
    select id into v_dir from public.citation_directories where key = v_item.citation_directory_key;
    if not exists (
      select 1 from public.citation_listing_overview o
      where o.location_id = new.location_id and o.directory_id = v_dir
        and (new.status = 'claimed' or o.verification_status = 'verified_accurate')) then
      raise exception using errcode = '23514', message = case new.status
        when 'claimed' then 'Record the listing on the Citations tab before marking it claimed.'
        else 'A listing is verified only by a current accurate check on the Citations tab.' end;
    end if;
  end if;

  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;
create trigger client_onboarding_items_guard before insert or update on public.client_onboarding_items
  for each row execute function public.guard_client_onboarding_item();

create function public.record_client_onboarding_event() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.status <> old.status or new.evidence_url is distinct from old.evidence_url
     or new.evidence_note <> old.evidence_note or new.blocking_reason <> old.blocking_reason or new.next_action <> old.next_action then
    insert into public.client_onboarding_events (item_id, client_id, status, evidence_url, evidence_note, blocking_reason, next_action, recorded_by)
    values (new.id, new.client_id, new.status, new.evidence_url, new.evidence_note, new.blocking_reason, new.next_action, auth.uid());
  end if;
  return null;
end $$;
create trigger client_onboarding_items_history after insert or update on public.client_onboarding_items
  for each row execute function public.record_client_onboarding_event();

-- ── 3. Enrollment: idempotent, never overwrites ────────────────────────────
-- Adds the rows the client is missing (new items, new sites, new business
-- locations); existing rows, their statuses and evidence are left alone.
-- Runs as the caller, so RLS applies (team only). Returns rows added.
create function public.enroll_client_onboarding(p_client_id uuid) returns integer
language plpgsql set search_path = public, pg_temp as $$
declare v_count integer;
begin
  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception using errcode = 'P0002', message = 'Client not found.';
  end if;
  insert into public.client_onboarding_items (client_id, item_key, site_id, location_id, required, owner)
  select p_client_id, i.key, t.site_id, t.location_id, i.required, i.default_owner
  from public.onboarding_items i
  cross join lateral (
    select null::uuid as site_id, null::uuid as location_id where i.scope = 'client'
    union all
    select s.id, null from public.sites s where i.scope = 'site' and s.client_id = p_client_id
    union all
    select null, l.id from public.citation_locations l where i.scope = 'location' and l.client_id = p_client_id and l.status = 'active'
  ) t
  where i.is_active
  on conflict (client_id, item_key, site_id, location_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Future full-service clients start with the checklist (client-scoped rows;
-- site and location rows are added by re-running enrollment once those exist).
-- Definer, like the other onboarding triggers, so whoever inserts the client
-- (the team's New client dialog, a load run as the service role) gets the same
-- not-started rows; it never sets a status.
create function public.enroll_new_client_onboarding() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.enroll_client_onboarding(new.id);
  return null;
end $$;
create trigger clients_zz_onboarding_checklist after insert on public.clients
  for each row when (new.service_scope = 'full') execute function public.enroll_new_client_onboarding();

-- ── 4. Read model (invoker: RLS applies) ───────────────────────────────────
-- One row per checklist item with its scope label, the linked pipeline task
-- and the evidence signal from existing records. Signals inform; they never
-- set the status.
create view public.client_onboarding_overview with (security_invoker = true) as
select ci.id, ci.client_id, ci.item_key, ci.site_id, ci.location_id, ci.status, ci.required, ci.owner, ci.due_on,
  ci.evidence_url, ci.evidence_note, ci.blocking_reason, ci.next_action, ci.last_verified_at, ci.verified_by,
  ci.updated_at, ci.created_at,
  i.section, i.scope, i.title, i.guidance, i.depends_on, i.evidence_source, i.citation_directory_key, i.pipeline_task_key,
  i.sort_order, i.standard_version, i.is_active as item_active,
  coalesce(s.url, l.label) as scope_label,
  l.hide_address as location_hide_address,
  pt.id as pipeline_task_id, pt.status::text as pipeline_task_status, pt.title as pipeline_task_title,
  case i.evidence_source
    when 'access' then (select jsonb_build_object('requested', count(*) filter (where a.status = 'requested'),
        'granted', count(*) filter (where a.status = 'granted'), 'not_needed', count(*) filter (where a.status = 'not_needed'))
      from public.client_access a where a.client_id = ci.client_id)
    when 'location_identity' then jsonb_build_object('identity_version', l.identity_version, 'hide_address', l.hide_address,
      'approved_at', l.approved_at, 'status', l.status)
    when 'site' then jsonb_build_object('url', s.url, 'controlled_by_compass', s.controlled_by_compass)
    when 'gsc' then jsonb_build_object('property', coalesce(c.gsc_property, ''),
      'data_through', (select max(g.period_end) from public.gsc_performance_imports g where g.client_id = ci.client_id))
    when 'ga4' then jsonb_build_object('property', coalesce(c.ga4_property, ''), 'measurement_id', coalesce(s.ga4_measurement_id, ''),
      'data_through', (select max(g.period_end) from public.ga4_performance_imports g where g.client_id = ci.client_id))
    when 'gbp_binding' then (select jsonb_build_object('bound', count(*), 'verified', count(*) filter (where a.publish_verified_at is not null))
      from public.social_accounts a where a.client_id = ci.client_id and a.platform = 'google_business' and a.publish_provider = 'zernio')
    when 'facebook_binding' then (select jsonb_build_object('bound', count(*), 'verified', count(*) filter (where a.publish_verified_at is not null),
        'enabled', count(*) filter (where a.publish_enabled))
      from public.social_accounts a where a.client_id = ci.client_id and a.platform = 'facebook' and a.publish_provider = 'zernio')
    when 'citation' then (select jsonb_build_object('listings', count(*),
        'verified', count(*) filter (where o.verification_status = 'verified_accurate'),
        'discrepancy', count(*) filter (where o.verification_status in ('discrepancy','needs_reverification')),
        'inaccessible', count(*) filter (where o.verification_status = 'inaccessible'),
        'open_tasks', coalesce(sum(o.open_tasks), 0), 'last_checked_on', max(o.last_checked_on),
        'listing_url', (array_agg(o.listing_url order by o.last_checked_on desc nulls last) filter (where o.listing_url is not null))[1])
      from public.citation_listing_overview o where o.location_id = ci.location_id and o.directory_key = i.citation_directory_key)
    when 'website_pipeline' then jsonb_build_object('work_mode', s.work_mode, 'launched_at', s.launched_at, 'url', s.url,
      'pipeline_status', (select cp.status::text from public.client_pipelines cp join public.pipelines p on p.id = cp.pipeline_id
        where cp.client_id = ci.client_id and p.key = 'website'))
  end as signal
from public.client_onboarding_items ci
join public.onboarding_items i on i.key = ci.item_key
join public.clients c on c.id = ci.client_id
left join public.sites s on s.id = ci.site_id
left join public.citation_locations l on l.id = ci.location_id
left join lateral (select t.id, t.status, t.title from public.tasks t
  where t.client_id = ci.client_id and i.pipeline_task_key is not null and t.key = i.pipeline_task_key
  order by (t.status = 'done'), t.created_at desc limit 1) pt on true;

-- ── 5. Pipeline templates: future enrollments only ────────────────────────
-- Templates are copied into tasks at enrollment (create_stage_tasks), so these
-- edits change what NEW enrollments get. Completed tasks are never touched;
-- still-open legacy tasks are labelled so nobody buys a retired service.

-- Social › Brand & Content Setup: Metricool is retired; Zernio is the transport.
update public.task_templates tt
set title = 'Connect and verify the exact Zernio Facebook Page / Business Profile destination and posting permission (Onboarding checklist D)',
    key = 'zernio_connect'
from public.stages s join public.pipelines p on p.id = s.pipeline_id and p.key = 'social'
where tt.stage_id = s.id and s.name = 'Brand & Content Setup' and tt.title = 'Connect Metricool';
update public.stages s
set description = 'Voice, pillars, templates (Canva), Zernio destination verified'
from public.pipelines p
where p.id = s.pipeline_id and p.key = 'social' and s.name = 'Brand & Content Setup'
  and s.description = 'Voice, pillars, templates (Canva), Metricool connected';

-- SEO › Tracking Setup: ranks come from rank-sync and Compass map grids, not
-- billable BrightLocal reports. The two BrightLocal templates become the
-- Compass map-grid profile and Bing Webmaster Tools.
update public.task_templates tt
set title = 'Compass map-grid profile prepared on Map rankings (weekly scans stay off until Tom enables them; no BrightLocal Local Search Grid)',
    key = 'map_grid_profile'
from public.stages s join public.pipelines p on p.id = s.pipeline_id and p.key = 'seo'
where tt.stage_id = s.id and tt.key = 'brightlocal_lsg';
update public.task_templates tt
set title = 'Bing Webmaster Tools: site verified and sitemap submitted (Onboarding checklist B; separate from Bing Places)',
    key = 'bing_webmaster'
from public.stages s join public.pipelines p on p.id = s.pipeline_id and p.key = 'seo'
where tt.stage_id = s.id and tt.key = 'brightlocal_lrt';

-- SEO › Local Citations: the paid path needs Tom's written approval.
update public.task_templates tt
set title = 'Create or claim the core listings and record each on the Citations tab (Onboarding checklist C); paid Citation Builder only with Tom''s written approval'
from public.stages s join public.pipelines p on p.id = s.pipeline_id and p.key = 'seo'
where tt.stage_id = s.id and tt.key = 'citation_submit';

-- Still-open legacy tasks: labelled, not closed, not deleted. Done tasks keep their record.
update public.tasks
set title = '[Legacy — do not buy] ' || title,
    notes = concat_ws(E'\n', nullif(notes, ''), 'Oct 29 2026: BrightLocal rank / grid reports are retired; ranks come from rank-sync and Compass map grids. Close as not needed unless Tom says otherwise. Existing BrightLocal subscriptions are not cancelled here.')
where key in ('brightlocal_lrt','brightlocal_lsg') and status <> 'done' and title not like '[Legacy%';
update public.tasks t
set title = '[Legacy] ' || t.title,
    notes = concat_ws(E'\n', nullif(t.notes, ''), 'Oct 29 2026: Metricool is retired; connect and verify the Zernio destination (Onboarding checklist D).')
from public.client_stages cs join public.stages s on s.id = cs.stage_id
  join public.pipelines p on p.id = s.pipeline_id and p.key = 'social'
where t.client_stage_id = cs.id and s.name = 'Brand & Content Setup' and t.title = 'Connect Metricool' and t.status <> 'done';

-- ── 6. Access: team only; history and registry read-only to the app ───────
alter table public.onboarding_items enable row level security;
alter table public.client_onboarding_items enable row level security;
alter table public.client_onboarding_events enable row level security;
create policy "team onboarding_items" on public.onboarding_items to authenticated
  using ((select public.is_team())) with check ((select public.is_team()));
create policy "team client_onboarding_items" on public.client_onboarding_items to authenticated
  using ((select public.is_team())) with check ((select public.is_team()));
create policy "team client_onboarding_events" on public.client_onboarding_events to authenticated
  using ((select public.is_team())) with check ((select public.is_team()));
revoke all on public.onboarding_items, public.client_onboarding_items, public.client_onboarding_events,
  public.client_onboarding_overview from public, anon, authenticated, service_role;
grant select on public.onboarding_items, public.client_onboarding_events, public.client_onboarding_overview to authenticated, service_role;
grant select, insert, update on public.client_onboarding_items to authenticated;
grant select on public.client_onboarding_items to service_role;

revoke all on function public.enroll_client_onboarding(uuid) from public, anon;
grant execute on function public.enroll_client_onboarding(uuid) to authenticated;
revoke all on function public.guard_client_onboarding_item(), public.record_client_onboarding_event(),
  public.enroll_new_client_onboarding() from public, anon, authenticated;

-- Refuse the migration if the new onboarding trigger escaped the service-scope gate.
do $$
begin
  if not exists (select 1 from pg_trigger g where g.tgrelid = 'public.clients'::regclass and g.tgname = 'clients_zz_onboarding_checklist'
      and pg_get_triggerdef(g.oid) like '%WHEN ((new.service_scope = ''full''::text))%') then
    raise exception 'ungated onboarding trigger: clients_zz_onboarding_checklist';
  end if;
  if exists (select 1 from public.onboarding_items i where i.citation_directory_key is not null
      and not exists (select 1 from public.citation_directories d where d.key = i.citation_directory_key and d.is_active)) then
    raise exception 'onboarding item points at a missing directory';
  end if;
end $$;
