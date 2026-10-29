-- Monthly client reports: frozen versions, one review, scoped approval and a
-- recorded delivery. Nothing here sends, emails, invites or schedules.
--
--   generate  monthly_report_save        a teammate freezes the month's
--                                        figures as a new draft version
--   edit      monthly_report_edit        summary / causes / actions; a
--                                        report in review goes back to draft
--   review    monthly_report_submit      draft → in_review
--   approve   monthly_report_approve     the exact content hash, one
--                                        destination, exact recipients
--   deliver   monthly_report_record_delivery   what Tom did, as he reports it
--
-- A version is never edited after approval and never deleted. A correction
-- is a new version with a reason and a link to the version it replaces; the
-- approved one stays approved (and stays what the client saw) until the
-- correction is approved, then it is marked superseded. The snapshot of a
-- version never changes at all, whatever its status.
--
-- Month: the America/Chicago calendar month, [start, end) — DST-aware
-- because the bounds are converted from local midnight, never offset by a
-- fixed number of hours. A version whose cutoff is before the month's end is
-- a partial preview and cannot be approved.
--
-- Clients: one row per reporting unit — the client, or one brand site of a
-- multi-brand client (client_brand_workspaces). The snapshot names its
-- client, brand and period and must match the row it is stored on.

create function monthly_report_bounds(p_period date) returns tstzrange
language sql immutable set search_path = public, pg_temp as $$
  select tstzrange(date_trunc('month', p_period)::timestamp at time zone 'America/Chicago',
                   (date_trunc('month', p_period) + interval '1 month')::timestamp at time zone 'America/Chicago', '[)')
$$;
revoke all on function monthly_report_bounds(date) from public, anon;
grant execute on function monthly_report_bounds(date) to authenticated, service_role;
comment on function monthly_report_bounds(date) is
  'The America/Chicago calendar month containing p_period as a half-open timestamptz range (DST-aware).';

create table monthly_reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete restrict,
  brand_workspace_id uuid references client_brand_workspaces(id) on delete restrict,
  unit_key uuid not null generated always as (coalesce(brand_workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  period date not null check (extract(day from period) = 1),
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'superseded', 'discarded')),
  -- Data as of; the month's bounds are derived from period.
  cutoff timestamptz not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  is_partial boolean not null,
  completeness text not null check (completeness in ('complete', 'incomplete')),
  calculation_version text not null check (length(btrim(calculation_version)) between 1 and 100),
  snapshot jsonb not null,
  snapshot_hash text not null,
  editorial jsonb not null default '{}'::jsonb,
  edit_version integer not null default 1,
  content_hash text not null,
  -- The version this one replaces (any status), and why when it replaces an
  -- approved one.
  supersedes_id uuid references monthly_reports(id),
  correction_reason text check (correction_reason is null or length(btrim(correction_reason)) between 1 and 2000),
  -- Retried submissions of one Generate return the same version.
  request_key text not null check (length(btrim(request_key)) between 8 and 200),
  generated_by uuid references team_members(id),
  generated_at timestamptz not null default now(),
  submitted_by uuid references team_members(id),
  submitted_at timestamptz,
  approved_by uuid references team_members(id),
  approved_at timestamptz,
  approved_hash text,
  approved_destination text check (approved_destination in ('portal', 'email')),
  approved_recipients text[],
  superseded_by uuid references monthly_reports(id),
  superseded_at timestamptz,
  unique (client_id, unit_key, period, version),
  unique (client_id, request_key),
  check ((status in ('approved', 'superseded')) = (approved_at is not null)),
  check (approved_at is null or (approved_by is not null and approved_hash = content_hash
         and approved_destination is not null and cardinality(approved_recipients) > 0 and not is_partial)),
  check ((status = 'superseded') = (superseded_at is not null))
);
comment on table monthly_reports is
  'Monthly client report versions (20261021220000): frozen snapshot, editorial text, review, scoped approval. Never deleted; corrections are new versions.';
-- One open version and one current approved version per unit and month.
create unique index monthly_reports_one_open on monthly_reports (client_id, unit_key, period) where status in ('draft', 'in_review');
create unique index monthly_reports_one_approved on monthly_reports (client_id, unit_key, period) where status = 'approved';
create index monthly_reports_client_idx on monthly_reports (client_id, period desc, version desc);

create table monthly_report_deliveries (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references monthly_reports(id) on delete restrict,
  client_id uuid not null references clients(id) on delete restrict,
  destination text not null check (destination in ('portal', 'email')),
  recipients text[] not null check (cardinality(recipients) > 0),
  -- sent: Tom confirms it went out. failed: it did not. uncertain: a
  -- provider accepted it or the outcome is unknown; never counted as sent.
  outcome text not null check (outcome in ('sent', 'failed', 'uncertain')),
  detail text not null default '' check (length(detail) <= 2000),
  request_key text not null unique check (length(btrim(request_key)) between 8 and 200),
  recorded_by uuid not null references team_members(id),
  recorded_at timestamptz not null default now()
);
comment on table monthly_report_deliveries is
  'What happened to an approved report version, as recorded by a teammate. Append-only; one sent per version and destination.';
create unique index monthly_report_deliveries_one_sent on monthly_report_deliveries (report_id, destination) where outcome = 'sent';
create index monthly_report_deliveries_report_idx on monthly_report_deliveries (report_id, recorded_at);

create function monthly_report_hash(v text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select 'sha256:' || encode(sha256(convert_to(v, 'UTF8')), 'hex')
$$;
revoke all on function monthly_report_hash(text) from public, anon, authenticated;

-- ── Guard: applies to every caller, the worker's SQL included ───────────────
create function monthly_reports_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
declare b tstzrange;
begin
  if tg_op = 'DELETE' then
    raise exception 'A report version is never deleted; discard a draft instead' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.approved_at is not null or new.submitted_at is not null or new.superseded_at is not null then
      raise exception 'A report version starts as a draft' using errcode = '23514';
    end if;
    if new.brand_workspace_id is not null
       and not exists (select 1 from client_brand_workspaces w where w.id = new.brand_workspace_id and w.client_id = new.client_id) then
      raise exception 'The brand site belongs to another client' using errcode = '23514';
    end if;
    if new.snapshot->>'client_id' is distinct from new.client_id::text
       or new.snapshot->>'brand_workspace_id' is distinct from new.brand_workspace_id::text
       or new.snapshot->>'period' is distinct from new.period::text
       or new.snapshot->>'calculation_version' is distinct from new.calculation_version
       or delivery_try_timestamptz(new.snapshot->>'cutoff') is distinct from new.cutoff then
      raise exception 'The snapshot is not for this client, brand, period, cutoff and calculation' using errcode = '23514';
    end if;
    if new.supersedes_id is not null and not exists (
         select 1 from monthly_reports p where p.id = new.supersedes_id and p.client_id = new.client_id
           -- unit_key is generated after BEFORE triggers run; derive it here.
           and p.unit_key = coalesce(new.brand_workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
           and p.period = new.period and p.version < new.version) then
      raise exception 'A version replaces an earlier version of the same report' using errcode = '23514';
    end if;
    b := monthly_report_bounds(new.period);
    if new.cutoff <= lower(b) then
      raise exception 'The cutoff is before the month starts' using errcode = '23514';
    end if;
    new.period_start := lower(b);
    new.period_end := upper(b);
    new.is_partial := new.cutoff < upper(b);
    new.completeness := case when new.snapshot->>'completeness' = 'complete' then 'complete' else 'incomplete' end;
    new.snapshot_hash := monthly_report_hash(new.snapshot::text);
    new.edit_version := 1;
    new.content_hash := monthly_report_hash(new.snapshot_hash || '|' || new.editorial::text);
    return new;
  end if;

  -- UPDATE
  if (new.id, new.client_id, new.brand_workspace_id, new.period, new.version, new.cutoff, new.period_start, new.period_end,
      new.is_partial, new.completeness, new.calculation_version, new.snapshot, new.snapshot_hash, new.supersedes_id,
      new.correction_reason, new.request_key, new.generated_by, new.generated_at)
     is distinct from
     (old.id, old.client_id, old.brand_workspace_id, old.period, old.version, old.cutoff, old.period_start, old.period_end,
      old.is_partial, old.completeness, old.calculation_version, old.snapshot, old.snapshot_hash, old.supersedes_id,
      old.correction_reason, old.request_key, old.generated_by, old.generated_at) then
    raise exception 'A report version''s figures never change; generate a new version' using errcode = '42501';
  end if;

  if old.status in ('approved', 'superseded', 'discarded') then
    if old.status = 'approved' and new.status = 'superseded' and new.superseded_at is not null and new.superseded_by is not null
       and (new.editorial, new.edit_version, new.content_hash, new.approved_by, new.approved_at, new.approved_hash,
            new.approved_destination, new.approved_recipients, new.submitted_by, new.submitted_at)
           is not distinct from
           (old.editorial, old.edit_version, old.content_hash, old.approved_by, old.approved_at, old.approved_hash,
            old.approved_destination, old.approved_recipients, old.submitted_by, old.submitted_at) then
      return new;
    end if;
    raise exception 'An approved, superseded or discarded version cannot change; correct it with a new version' using errcode = '42501';
  end if;

  if new.superseded_at is not null or new.superseded_by is not null then
    raise exception 'Only an approved version is superseded' using errcode = '23514';
  end if;

  if new.editorial is distinct from old.editorial then
    if new.edit_version <> old.edit_version + 1 then
      raise exception 'The report changed since you opened it; reload and edit again' using errcode = '40001';
    end if;
    -- An edit always needs a fresh review.
    if new.status = 'in_review' then new.status := 'draft'; end if;
  elsif new.edit_version <> old.edit_version then
    raise exception 'edit_version moves only with an edit' using errcode = '23514';
  end if;
  new.content_hash := monthly_report_hash(new.snapshot_hash || '|' || new.editorial::text);

  if new.status = 'draft' then
    new.submitted_by := null; new.submitted_at := null;
  end if;
  if new.status in ('draft', 'in_review', 'discarded') and new.approved_at is not null then
    raise exception 'Approval is recorded only on approve' using errcode = '23514';
  end if;
  if new.status = 'in_review' and old.status = 'draft' and new.submitted_at is null then
    raise exception 'A review records who submitted it' using errcode = '23514';
  end if;
  if new.status = 'approved' and (old.status <> 'in_review' or new.editorial is distinct from old.editorial) then
    raise exception 'Only the version in review, unchanged, is approved' using errcode = '23514';
  end if;
  if new.status = 'superseded' then
    raise exception 'Only an approved version is superseded' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function monthly_reports_guard() from public, anon, authenticated;
create trigger monthly_reports_guard before insert or update or delete on monthly_reports
  for each row execute function monthly_reports_guard();

create function monthly_report_deliveries_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
declare r monthly_reports;
begin
  if tg_op <> 'INSERT' then
    raise exception 'A delivery record never changes; record what happened next as a new row' using errcode = '42501';
  end if;
  select * into r from monthly_reports where id = new.report_id;
  if r.status <> 'approved' then
    raise exception 'Only the current approved version is delivered' using errcode = '23514';
  end if;
  if new.client_id <> r.client_id then
    raise exception 'The delivery names another client' using errcode = '23514';
  end if;
  if new.destination <> r.approved_destination
     or (select array_agg(x order by x) from unnest(new.recipients) x) <> (select array_agg(x order by x) from unnest(r.approved_recipients) x) then
    raise exception 'The approval covers % to % only', r.approved_destination, array_to_string(r.approved_recipients, ', ') using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function monthly_report_deliveries_guard() from public, anon, authenticated;
create trigger monthly_report_deliveries_guard before insert or update or delete on monthly_report_deliveries
  for each row execute function monthly_report_deliveries_guard();

-- ── Access: the team reads; every write goes through the functions below ───
alter table monthly_reports enable row level security;
alter table monthly_report_deliveries enable row level security;
create policy "team reads monthly reports" on monthly_reports for select to authenticated using ((select is_team()));
create policy "team reads monthly report deliveries" on monthly_report_deliveries for select to authenticated using ((select is_team()));
revoke all on monthly_reports, monthly_report_deliveries from public, anon, authenticated;
grant select on monthly_reports, monthly_report_deliveries to authenticated;

create function monthly_report_actor() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate does this' using errcode = '42501';
  end if;
  v := task_actor();
  if v is null then raise exception 'Only a signed-in teammate does this' using errcode = '42501'; end if;
  return v;
end $$;
revoke all on function monthly_report_actor() from public, anon, authenticated;

-- Freeze a month. Same request key → the same version. Same figures as the
-- open version → that version. Otherwise a new version; an open one is
-- discarded, an approved one stays until the new one is approved, and
-- replacing an approved one needs a reason. Editorial text carries forward
-- unless new text is given.
create function monthly_report_save(
  p_client_id uuid, p_brand_workspace_id uuid, p_period date, p_cutoff timestamptz,
  p_calculation_version text, p_snapshot jsonb, p_editorial jsonb, p_request_key text,
  p_correction_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := monthly_report_actor();
  v_unit uuid := coalesce(p_brand_workspace_id, '00000000-0000-0000-0000-000000000000'::uuid);
  v_period date := date_trunc('month', p_period)::date;
  r monthly_reports;
  v_open monthly_reports;
  v_approved monthly_reports;
  v_latest monthly_reports;
  v_hash text := monthly_report_hash(p_snapshot::text);
begin
  if p_cutoff > now() then
    raise exception 'The cutoff is in the future' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('monthly_report:' || p_client_id || ':' || v_unit || ':' || v_period, 0));

  select * into r from monthly_reports where client_id = p_client_id and request_key = p_request_key;
  if r.id is not null then
    return jsonb_build_object('report_id', r.id, 'version', r.version, 'reused', true);
  end if;

  select * into v_open from monthly_reports where client_id = p_client_id and unit_key = v_unit and period = v_period and status in ('draft', 'in_review');
  if v_open.id is not null and v_open.snapshot_hash = v_hash then
    return jsonb_build_object('report_id', v_open.id, 'version', v_open.version, 'reused', true);
  end if;
  select * into v_approved from monthly_reports where client_id = p_client_id and unit_key = v_unit and period = v_period and status = 'approved';
  if v_approved.id is not null and nullif(btrim(p_correction_reason), '') is null then
    raise exception 'Version % is approved; a new version is a correction and needs a reason', v_approved.version using errcode = '22023';
  end if;
  select * into v_latest from monthly_reports where client_id = p_client_id and unit_key = v_unit and period = v_period order by version desc limit 1;

  if v_open.id is not null then
    update monthly_reports set status = 'discarded' where id = v_open.id;
  end if;
  insert into monthly_reports (client_id, brand_workspace_id, period, version, cutoff, calculation_version, snapshot,
    snapshot_hash, editorial, content_hash, period_start, period_end, is_partial, completeness,
    supersedes_id, correction_reason, request_key, generated_by)
  values (p_client_id, p_brand_workspace_id, v_period, coalesce(v_latest.version, 0) + 1, p_cutoff, p_calculation_version, p_snapshot,
    '', coalesce(p_editorial, v_latest.editorial, '{}'::jsonb), '', '-infinity', '-infinity', false, 'incomplete',
    v_latest.id, case when v_approved.id is not null then btrim(p_correction_reason) end, p_request_key, v_actor)
  returning * into r;
  return jsonb_build_object('report_id', r.id, 'version', r.version, 'reused', false);
end $$;
revoke all on function monthly_report_save(uuid, uuid, date, timestamptz, text, jsonb, jsonb, text, text) from public, anon;
grant execute on function monthly_report_save(uuid, uuid, date, timestamptz, text, jsonb, jsonb, text, text) to authenticated;

create function monthly_report_edit(p_report_id uuid, p_edit_version integer, p_editorial jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := monthly_report_actor(); r monthly_reports;
begin
  if jsonb_typeof(p_editorial) is distinct from 'object' then
    raise exception 'Editorial text is an object' using errcode = '22023';
  end if;
  select * into r from monthly_reports where id = p_report_id for update;
  if r.id is null then raise exception 'No such report' using errcode = 'P0002'; end if;
  if r.status not in ('draft', 'in_review') then
    raise exception 'Version % is %; correct it with a new version', r.version, r.status using errcode = '23514';
  end if;
  if r.edit_version <> p_edit_version then
    raise exception 'The report changed since you opened it; reload and edit again' using errcode = '40001';
  end if;
  update monthly_reports set editorial = p_editorial, edit_version = edit_version + 1 where id = r.id returning * into r;
  return jsonb_build_object('report_id', r.id, 'status', r.status, 'edit_version', r.edit_version, 'content_hash', r.content_hash);
end $$;
revoke all on function monthly_report_edit(uuid, integer, jsonb) from public, anon;
grant execute on function monthly_report_edit(uuid, integer, jsonb) to authenticated;

create function monthly_report_submit(p_report_id uuid, p_edit_version integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := monthly_report_actor(); r monthly_reports;
begin
  select * into r from monthly_reports where id = p_report_id for update;
  if r.id is null then raise exception 'No such report' using errcode = 'P0002'; end if;
  if r.status = 'in_review' and r.edit_version = p_edit_version then
    return jsonb_build_object('report_id', r.id, 'status', r.status, 'already', true);
  end if;
  if r.status <> 'draft' then raise exception 'Version % is %', r.version, r.status using errcode = '23514'; end if;
  if r.edit_version <> p_edit_version then
    raise exception 'The report changed since you opened it; reload and review it again' using errcode = '40001';
  end if;
  update monthly_reports set status = 'in_review', submitted_by = v_actor, submitted_at = now() where id = r.id returning * into r;
  return jsonb_build_object('report_id', r.id, 'status', r.status, 'content_hash', r.content_hash);
end $$;
revoke all on function monthly_report_submit(uuid, integer) from public, anon;
grant execute on function monthly_report_submit(uuid, integer) to authenticated;

-- Recipients: the client's own active portal contacts (portal) or its own
-- contacts (email), lower-cased, sorted, distinct. Never another client's.
create function monthly_report_recipients(p_client_id uuid, p_destination text, p_recipients text[]) returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text[]; v_bad text;
begin
  select array_agg(distinct lower(btrim(x)) order by lower(btrim(x))) into v from unnest(p_recipients) x where btrim(x) <> '';
  if v is null then raise exception 'Name at least one recipient' using errcode = '22023'; end if;
  if p_destination = 'portal' then
    select string_agg(x, ', ') into v_bad from unnest(v) x
    where not exists (select 1 from portal_users u where u.client_id = p_client_id and u.is_active and lower(u.email) = x);
  elsif p_destination = 'email' then
    select string_agg(x, ', ') into v_bad from unnest(v) x
    where not exists (select 1 from client_contacts c where c.client_id = p_client_id and lower(c.email) = x)
      and not exists (select 1 from portal_users u where u.client_id = p_client_id and u.is_active and lower(u.email) = x);
  else
    raise exception 'Destination is portal or email' using errcode = '22023';
  end if;
  if v_bad is not null then
    raise exception 'Not a contact of this client: %', v_bad using errcode = '23514';
  end if;
  return v;
end $$;
revoke all on function monthly_report_recipients(uuid, text, text[]) from public, anon, authenticated;

create function monthly_report_approve(
  p_report_id uuid, p_content_hash text, p_destination text, p_recipients text[], p_accept_incomplete boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := monthly_report_actor(); r monthly_reports; v_recipients text[];
begin
  select * into r from monthly_reports where id = p_report_id for update;
  if r.id is null then raise exception 'No such report' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('monthly_report:' || r.client_id || ':' || r.unit_key || ':' || r.period, 0));
  v_recipients := monthly_report_recipients(r.client_id, p_destination, p_recipients);
  if r.status = 'approved' and r.approved_hash = p_content_hash and r.approved_destination = p_destination and r.approved_recipients = v_recipients then
    return jsonb_build_object('report_id', r.id, 'status', r.status, 'already', true);
  end if;
  if r.status <> 'in_review' then
    raise exception 'Version % is %; only a version in review is approved', r.version, r.status using errcode = '23514';
  end if;
  if r.content_hash <> p_content_hash then
    raise exception 'The report changed since you reviewed it; reload and review it again' using errcode = '40001';
  end if;
  if r.is_partial then
    raise exception 'Version % is a partial preview (data to %); generate it after the month ends', r.version, r.cutoff using errcode = '23514';
  end if;
  if r.completeness = 'incomplete' and not coalesce(p_accept_incomplete, false) then
    raise exception 'Version % is missing sources; approve it as an incomplete report explicitly or wait for them', r.version using errcode = '23514';
  end if;
  update monthly_reports set status = 'superseded', superseded_at = now(), superseded_by = r.id
   where client_id = r.client_id and unit_key = r.unit_key and period = r.period and status = 'approved';
  update monthly_reports set status = 'approved', approved_by = v_actor, approved_at = now(), approved_hash = r.content_hash,
         approved_destination = p_destination, approved_recipients = v_recipients
   where id = r.id returning * into r;
  return jsonb_build_object('report_id', r.id, 'status', r.status, 'approved_hash', r.approved_hash);
end $$;
revoke all on function monthly_report_approve(uuid, text, text, text[], boolean) from public, anon;
grant execute on function monthly_report_approve(uuid, text, text, text[], boolean) to authenticated;

-- What Tom did with an approved version. This records; it never sends.
create function monthly_report_record_delivery(
  p_report_id uuid, p_destination text, p_recipients text[], p_outcome text, p_detail text, p_request_key text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := monthly_report_actor(); r monthly_reports; d monthly_report_deliveries;
begin
  select * into d from monthly_report_deliveries where request_key = p_request_key;
  if d.id is not null then
    if d.report_id <> p_report_id then raise exception 'That request key belongs to another delivery' using errcode = '23505'; end if;
    return jsonb_build_object('delivery_id', d.id, 'outcome', d.outcome, 'reused', true);
  end if;
  select * into r from monthly_reports where id = p_report_id for update;
  if r.id is null then raise exception 'No such report' using errcode = 'P0002'; end if;
  if exists (select 1 from monthly_report_deliveries x where x.report_id = r.id and x.destination = p_destination and x.outcome = 'sent') then
    raise exception 'Version % is already recorded as sent to %', r.version, p_destination using errcode = '23505';
  end if;
  insert into monthly_report_deliveries (report_id, client_id, destination, recipients, outcome, detail, request_key, recorded_by)
  values (r.id, r.client_id, p_destination, monthly_report_recipients(r.client_id, p_destination, p_recipients),
          p_outcome, coalesce(btrim(p_detail), ''), p_request_key, v_actor)
  returning * into d;
  return jsonb_build_object('delivery_id', d.id, 'outcome', d.outcome, 'reused', false);
end $$;
revoke all on function monthly_report_record_delivery(uuid, text, text[], text, text, text) from public, anon;
grant execute on function monthly_report_record_delivery(uuid, text, text[], text, text, text) to authenticated;

-- ── Client portal: the newest version published to the portal ───────────
-- Published = approved for the portal and recorded as sent there by Tom. A
-- correction replaces it for the client only once it is published itself.
-- The internal audit section of the snapshot is never exposed.
create view portal_monthly_reports as
  select distinct on (r.unit_key, r.period)
         r.id, r.client_id, r.brand_workspace_id, r.period, r.version, r.approved_at, r.cutoff,
         r.snapshot - 'audit' as report, r.editorial, r.content_hash
  from monthly_reports r
  where r.client_id = (select portal_client_id())
    and r.status in ('approved', 'superseded')
    and r.approved_destination = 'portal'
    and exists (select 1 from monthly_report_deliveries d where d.report_id = r.id and d.destination = 'portal' and d.outcome = 'sent')
  order by r.unit_key, r.period, r.version desc;
alter view portal_monthly_reports set (security_invoker = false);
revoke all on portal_monthly_reports from public, anon, authenticated;
grant select on portal_monthly_reports to authenticated;

do $$
declare v_bad text;
begin
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v' and c.relname like 'portal\_%'
    and pg_get_viewdef(c.oid) not like '%portal_client_id()%';
  if v_bad is not null then raise exception 'Portal views missing the client filter: %', v_bad; end if;
  select string_agg(distinct g.table_name || ' ' || g.privilege_type, ', ') into v_bad
  from information_schema.role_table_grants g
  where g.table_schema = 'public' and g.table_name in ('portal_monthly_reports', 'monthly_reports', 'monthly_report_deliveries')
    and (g.grantee in ('anon', 'PUBLIC') or (g.grantee = 'authenticated' and g.privilege_type <> 'SELECT'));
  if v_bad is not null then raise exception 'Unexpected monthly report grants: %', v_bad; end if;
end $$;
