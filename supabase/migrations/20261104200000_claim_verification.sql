-- Controlled Claims Verification, PR2a (Nov 4 2026): COMPASS-2027-ROADMAP W1 /
-- P1.1b. Executive OS task 11454716: proposal 12222fff, ChatGPT architecture
-- review (approved with three refinements). See docs/claim-registry.md and
-- docs/proposals/pr2-controlled-claims-verification.md.
--
-- Replaces Claims Registry v1's lock (20261103220000) with owner-authorized,
-- evidence-pinned, audited writers. It changes NO gate and writes NO claim
-- status: what a post or draft may cite is still decided by
-- social_post_grounding_problems / content_draft_problems, exactly as before.
-- The verify block proves it by hashing every other reader of claims before
-- and after, and by digesting every claim row.
--
--   1. claim_verification_authorities: who may decide. Tom (the owner) only,
--      granted here by this reviewed migration; never another admin, Claude,
--      an Edge Function or an Executive OS instruction. Changed only by a
--      migration. Delegation is designed for (authority 'delegate'), not built.
--   2. Evidence files: the private claim-evidence bucket (team read, nobody
--      writes through the API, registered files are immutable) and
--      claim_evidence: content-addressed (<client>/<sha256>.<ext>), SHA-256
--      computed by the claim-evidence Edge Function from the stored bytes,
--      registered only by that function.
--   3. claim_reviews: the append-only decision ledger (classify / verify /
--      review / revoke). Reviewer, authority, time and transaction are stamped
--      by trigger; each decision is also written to creative_governance_events.
--   4. The claims projection: claims.review_id, and a guard that accepts a
--      change to the registry columns only when it matches a ledger row written
--      in this transaction by this person. A claim with review history is never
--      deleted (retirement is PR2b).
--   5. The three writers: claim_classify, claim_verify, claim_revoke.
--   6. claim_registry v2: the review in force, its evidence, integrity
--      reasons, and what the viewer may do. Still STABLE and security invoker.
--
-- Not here (PR2b / PR2c): confirm-with-evidence, supersede, retire, any
-- claims.status write, Claude proposals, delegation.
-- Rollback: supabase/rollback/20261104200000_claim_verification.down.sql

do $guard$
begin
  if to_regclass('public.claim_reviews') is not null then
    raise exception '20261104200000: claim_reviews already exists';
  end if;
  if to_regprocedure('public.claims_registry_guard()') is null
     or strpos(pg_get_functiondef('public.claims_registry_guard()'::regprocedure), 'locked until the verification workflow') = 0 then
    raise exception '20261104200000: needs the Claims Registry v1 lock (20261103220000)';
  end if;
end $guard$;

-- Every other function that reads claims (gates, approvals, the drafter, the
-- snapshot), hashed now and again at the end: they must stay byte-identical.
-- Only the three registry functions this migration replaces are left out.
create temp table claim_verification_pinned on commit drop as
  select p.oid::regprocedure::text as fn, md5(pg_get_functiondef(p.oid)) as h
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and (p.prosrc ~ '\mclaims\M' or p.prosrc ~ 'claim_ids')
     and p.oid not in ('public.claim_registry(uuid,date)'::regprocedure, 'public.claims_registry_guard()'::regprocedure,
                       'public.claims_history()'::regprocedure, 'public.claim_history_fields()'::regprocedure);
-- Every claim row as it stands: the migration must change none of them.
create temp table claim_verification_digest on commit drop as
  select count(*) as n, md5(coalesce(string_agg(to_jsonb(c)::text, '|' order by c.id), '')) as d from claims c;

-- ── 1. Verification authority ───────────────────────────────────────────────
-- ChatGPT review (refinement 1): Tom is the final verification authority. Not
-- every admin; never Claude, an Edge Function or an Executive OS instruction.
-- The simplest secure owner pattern Compass has is reviewed configuration that
-- only a migration changes (claim_review_intervals is the same): no
-- application caller can grant, change or revoke authority.
create table claim_verification_authorities (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references team_members (id),
  -- 'owner' only in this release. A future delegation adds 'delegate' rows
  -- granted by the owner, explicit and auditable, with their own scope.
  authority text not null check (authority = 'owner'),
  basis text not null check (length(btrim(basis)) between 1 and 500),
  granted_by uuid references team_members (id),  -- null = granted by a reviewed migration
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references team_members (id),
  revoke_reason text check (revoke_reason is null or length(btrim(revoke_reason)) between 1 and 500),
  check ((revoked_at is null) = (revoke_reason is null)),
  check (revoked_by is null or revoked_at is not null)
);
create unique index claim_verification_authorities_active_member on claim_verification_authorities (team_member_id)
  where revoked_at is null;
create unique index claim_verification_authorities_one_owner on claim_verification_authorities ((true))
  where authority = 'owner' and revoked_at is null;
comment on table claim_verification_authorities is
  'Who may classify and verify claims (20261104200000). Owner only: Tom. Granted and revoked only by a reviewed migration; no application caller writes it.';

-- Tom (team member d73e1bf1), only if that member exists, is an admin and is
-- linked to a sign-in. Elsewhere (the sandbox, a fresh project) nobody holds
-- authority and every writer refuses: fail closed.
insert into claim_verification_authorities (team_member_id, authority, basis)
select m.id, 'owner',
       'Tom is the final verification authority for client claims (ChatGPT PR2 architecture review, Executive OS 11454716, Nov 4 2026). Granted by migration 20261104200000.'
  from team_members m
 where m.id = 'd73e1bf1-4234-491e-8134-b5c3d1fc4977' and m.role = 'admin' and m.auth_user_id is not null;

create function claim_verification_authorities_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if drafter_caller_is_superuser() then
    return coalesce(new, old);
  end if;
  raise exception 'Verification authority is granted and revoked only by a reviewed migration'
    using errcode = 'insufficient_privilege';
end $$;
revoke all on function claim_verification_authorities_guard() from public, anon, authenticated, service_role;
create trigger claim_verification_authorities_guard before insert or update or delete on claim_verification_authorities
  for each row execute function claim_verification_authorities_guard();
create trigger claim_verification_authorities_no_truncate before truncate on claim_verification_authorities
  for each statement execute function claim_verification_authorities_guard();

alter table claim_verification_authorities enable row level security;
create policy "team reads verification authority" on claim_verification_authorities for select to authenticated
  using ((select is_team()));
revoke all on claim_verification_authorities from public, anon, authenticated, service_role;
grant select on claim_verification_authorities to authenticated;

-- The caller's live owner authority, or NULL: a signed-in person (PostgREST
-- authenticator acting as authenticated with a team JWT), holding an active
-- owner row, still an admin. The worker's SQL, an Edge Function (service
-- role), anon, a portal user and a second admin all get NULL.
create function claim_reviewer_authority() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select a.id
    from claim_verification_authorities a
    join team_members m on m.id = a.team_member_id
   where post_caller_is_human()
     and m.id = task_actor() and m.role = 'admin'
     and a.authority = 'owner' and a.revoked_at is null
$$;
revoke all on function claim_reviewer_authority() from public, anon, authenticated, service_role;

-- ── 2. Evidence files ───────────────────────────────────────────────────────
-- ChatGPT review (refinement 2): authoritative evidence is a privately
-- uploaded file pinned to an immutable, verifiable reference with a SHA-256.
-- Same shape as creative-assets (0054): team read, nobody writes through the
-- API (the claim-evidence function signs a one-time upload for exactly
-- <client>/<sha256>.<ext>, then re-hashes the stored bytes before it
-- registers anything), and a registered file is never replaced or deleted.
--
-- Trust boundary (ChatGPT's second review). Registration is two halves, each
-- written by a different party:
--   * the upload request (claim_evidence_uploads) is written only from a
--     teammate's own signed-in session (PostgREST, role authenticated, their
--     JWT): it records who asked to upload which bytes (client, SHA-256,
--     size, type). Neither the service role nor the worker can write one, so
--     an uploader cannot be named by anyone but that person's own session;
--   * the evidence row is written only through claim_evidence_register,
--     executable by the service role. The database cannot read the bytes in
--     object storage, so it trusts the service-role caller to have re-hashed
--     them. The service role is held by every deployed Edge Function, not
--     only claim-evidence: the boundary is that key, not one function. What a
--     service-role caller cannot do is register a file nobody asked for, for
--     another client, under other bytes' hash, or in someone else's name.
--     Anyone can re-hash a registered file from its bytes ("Re-check hash").
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('claim-evidence', 'claim-evidence', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;
create policy "team read claim evidence" on storage.objects
  for select to authenticated using (bucket_id = 'claim-evidence' and (select is_team()));

create function claim_evidence_ext(p_mime text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case p_mime when 'application/pdf' then 'pdf' when 'image/png' then 'png'
                     when 'image/jpeg' then 'jpg' when 'image/webp' then 'webp' end
$$;
revoke all on function claim_evidence_ext(text) from public, anon;
grant execute on function claim_evidence_ext(text) to authenticated, service_role;

-- A teammate's request to upload one file: written only from their own
-- signed-in session through claim_evidence_request_upload, valid for an hour,
-- used at most once (claim_evidence.upload_id is unique). Never changed.
create table claim_evidence_uploads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  mime_type text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  requested_by uuid not null references team_members (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (id, client_id, sha256)
);
comment on table claim_evidence_uploads is
  'Upload requests for claim evidence (20261104200000): who asked to upload which bytes, written only from that teammate''s own signed-in session. The provenance claim_evidence.uploaded_by is taken from.';

create function claim_evidence_uploads_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if post_caller_is_human() then
      new.requested_by := task_actor();
      new.created_at := now();
      new.expires_at := now() + interval '1 hour';
      return new;
    end if;
    if drafter_caller_is_superuser() then
      return new;
    end if;
    raise exception 'Only a signed-in teammate asks to upload claim evidence' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then
    return old;
  end if;
  raise exception 'Claim evidence upload requests are never changed' using errcode = 'insufficient_privilege';
end $$;
revoke all on function claim_evidence_uploads_guard() from public, anon, authenticated, service_role;
create trigger claim_evidence_uploads_guard before insert or update or delete on claim_evidence_uploads
  for each row execute function claim_evidence_uploads_guard();
create trigger claim_evidence_uploads_no_truncate before truncate on claim_evidence_uploads
  for each statement execute function claim_evidence_uploads_guard();
alter table claim_evidence_uploads enable row level security;
create policy "team reads claim evidence uploads" on claim_evidence_uploads for select to authenticated
  using ((select is_team()));
revoke all on claim_evidence_uploads from public, anon, authenticated, service_role;
grant select on claim_evidence_uploads to authenticated, service_role;

-- The teammate's half, called from their own session (the claim-evidence
-- function forwards the caller's JWT for it). The requester is always the
-- caller; nothing in the arguments names a person.
create function claim_evidence_request_upload(p_client_id uuid, p_sha256 text, p_size bigint, p_mime text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate uploads claim evidence' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from clients where id = p_client_id) then
    raise exception 'Client % not found', p_client_id using errcode = 'no_data_found';
  end if;
  if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' or claim_evidence_ext(p_mime) is null
     or p_size is null or p_size not between 1 and 10485760 then
    raise exception 'Evidence is a PDF, PNG, JPEG or WebP file of up to 10 MB, named by its SHA-256' using errcode = 'invalid_parameter_value';
  end if;
  insert into claim_evidence_uploads (client_id, sha256, size_bytes, mime_type, requested_by, expires_at)
  values (p_client_id, p_sha256, p_size, p_mime, task_actor(), now() + interval '1 hour')
  returning id into v_id;
  return v_id;
end $$;
revoke all on function claim_evidence_request_upload(uuid, text, bigint, text) from public, anon, authenticated, service_role;
grant execute on function claim_evidence_request_upload(uuid, text, bigint, text) to authenticated;

create table claim_evidence (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  -- document: a contract, manufacturer document, signed form or saved email.
  -- capture: a page or listing captured as a PDF or image, with its URL and
  -- the day it was captured (a durable record of a mutable page).
  evidence_type text not null check (evidence_type in ('document', 'capture')),
  label text not null check (length(btrim(label)) between 1 and 200),
  storage_bucket text not null default 'claim-evidence' check (storage_bucket = 'claim-evidence'),
  storage_path text not null unique,
  object_id uuid not null,
  object_version text,
  object_etag text,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  mime_type text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  original_name text check (original_name is null or length(original_name) between 1 and 200),
  source_url text check (source_url is null or (length(source_url) <= 2000 and source_url ~ '^https?://[^/[:space:]?#]+')),
  captured_on date,
  uploaded_by uuid not null references team_members (id),
  -- The teammate's upload request this file answers; uploaded_by is its requester.
  upload_id uuid not null unique,
  created_at timestamptz not null default now(),
  foreign key (upload_id, client_id, sha256) references claim_evidence_uploads (id, client_id, sha256),
  unique (id, client_id),
  unique (id, client_id, sha256),
  unique (client_id, sha256),
  -- The content address: the path is the hash.
  check (storage_path = client_id::text || '/' || sha256 || '.' || claim_evidence_ext(mime_type)),
  check (evidence_type <> 'capture' or (source_url is not null and captured_on is not null)),
  check (evidence_type <> 'document' or (source_url is null and captured_on is null))
);
create index claim_evidence_client_idx on claim_evidence (client_id, created_at);
comment on table claim_evidence is
  'Uploaded claim evidence (20261104200000): content-addressed private files, SHA-256 computed from the stored bytes by the service-role caller (the claim-evidence function), each answering one teammate''s upload request. Append-only.';

-- Registered only through claim_evidence_register (a service-role session),
-- for the upload request it answers; never changed; only a client deletion
-- removes rows.
create function claim_evidence_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if not drafter_caller_is_service() then
      raise exception 'Evidence files are registered only through the service role (the claim-evidence function)'
        using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from claim_evidence_uploads u
                    where u.id = new.upload_id and u.client_id = new.client_id and u.sha256 = new.sha256
                      and u.size_bytes = new.size_bytes and u.mime_type = new.mime_type and u.requested_by = new.uploaded_by) then
      raise exception 'Evidence must answer its uploader''s own upload request' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from storage.objects o
                    where o.id = new.object_id and o.bucket_id = 'claim-evidence' and o.name = new.storage_path) then
      raise exception 'The evidence file is not stored at its content address' using errcode = 'check_violation';
    end if;
    new.created_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then
    return old;
  end if;
  raise exception 'Claim evidence is append-only' using errcode = 'insufficient_privilege';
end $$;
revoke all on function claim_evidence_guard() from public, anon, authenticated, service_role;
create trigger claim_evidence_guard before insert or update or delete on claim_evidence
  for each row execute function claim_evidence_guard();
create trigger claim_evidence_no_truncate before truncate on claim_evidence
  for each statement execute function claim_evidence_guard();

-- A registered evidence file is never renamed, re-versioned (overwritten) or
-- deleted. An unregistered upload may be deleted (the function removes a file
-- whose bytes do not match its address).
create function claim_evidence_objects_immutable() returns trigger
language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if tg_op = 'DELETE' then
    if old.bucket_id = 'claim-evidence' and exists (select 1 from public.claim_evidence e where e.storage_path = old.name) then
      raise exception 'Registered claim evidence is never deleted' using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;
  if (old.bucket_id = 'claim-evidence' or new.bucket_id = 'claim-evidence')
     and (new.bucket_id is distinct from old.bucket_id or new.name is distinct from old.name
          or ((to_jsonb(old)->>'version') is not null
              and (to_jsonb(new)->>'version') is distinct from (to_jsonb(old)->>'version'))) then
    raise exception 'Claim evidence files are immutable; new bytes have a new content address'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
revoke all on function claim_evidence_objects_immutable() from public, anon, authenticated, service_role;
create trigger claim_evidence_objects_immutable before update or delete on storage.objects
  for each row execute function claim_evidence_objects_immutable();

alter table claim_evidence enable row level security;
create policy "team reads claim evidence" on claim_evidence for select to authenticated using ((select is_team()));
revoke all on claim_evidence from public, anon, authenticated, service_role;
grant select on claim_evidence to authenticated, service_role;

-- The service-role half (the claim-evidence function, after re-hashing the
-- stored bytes). It answers one upload request: the client, hash, size and
-- type are the request's, and so is the uploader. It checks the object is
-- where the hash says, with the size and type the storage service recorded.
-- A retry of the same request, or the same bytes already registered for the
-- client, returns the existing row.
create function claim_evidence_register(
  p_upload_id uuid, p_storage_path text, p_sha256 text, p_size bigint, p_mime text, p_evidence_type text,
  p_label text, p_original_name text default null, p_source_url text default null,
  p_captured_on date default null) returns claim_evidence
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e claim_evidence;
  u claim_evidence_uploads;
  o record;
  v_today date := (now() at time zone 'America/Chicago')::date;
begin
  if not drafter_caller_is_service() then
    raise exception 'Evidence files are registered only through the service role (the claim-evidence function)'
      using errcode = 'insufficient_privilege';
  end if;
  select * into u from claim_evidence_uploads where id = p_upload_id;
  if u.id is null then
    raise exception 'No upload request %', p_upload_id using errcode = 'no_data_found';
  end if;
  select * into e from claim_evidence where upload_id = u.id;
  if e.id is not null then
    return e;
  end if;
  if u.expires_at < now() then
    raise exception 'The upload request has expired; upload the file again' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from team_members where id = u.requested_by and auth_user_id is not null) then
    raise exception 'The uploader is no longer a signed-in teammate' using errcode = 'insufficient_privilege';
  end if;
  if (p_sha256, p_size, p_mime) is distinct from (u.sha256, u.size_bytes, u.mime_type) then
    raise exception 'The file is not the one its upload request named' using errcode = 'invalid_parameter_value';
  end if;
  if p_storage_path is distinct from u.client_id::text || '/' || u.sha256 || '.' || claim_evidence_ext(u.mime_type) then
    raise exception 'The evidence path must be <client>/<sha256>.<ext> for a PDF, PNG, JPEG or WebP file' using errcode = 'invalid_parameter_value';
  end if;
  select * into e from claim_evidence where client_id = u.client_id and sha256 = u.sha256;
  if e.id is not null then
    return e;
  end if;
  if p_evidence_type = 'capture' and (p_source_url is null or p_captured_on is null or p_captured_on > v_today) then
    raise exception 'A capture needs the page''s URL and the day it was captured (not in the future)' using errcode = 'invalid_parameter_value';
  end if;
  select ob.id, to_jsonb(ob)->>'version' as version, ob.metadata into o
    from storage.objects ob where ob.bucket_id = 'claim-evidence' and ob.name = p_storage_path;
  if o.id is null then
    raise exception 'No evidence file is stored at %', p_storage_path using errcode = 'no_data_found';
  end if;
  if (o.metadata->>'size') is distinct from p_size::text then
    raise exception 'The stored file is % bytes, not %', coalesce(o.metadata->>'size', 'of unknown size'), p_size
      using errcode = 'invalid_parameter_value';
  end if;
  if lower(coalesce(o.metadata->>'mimetype', '')) <> p_mime then
    raise exception 'The stored file is %, not %', coalesce(o.metadata->>'mimetype', 'of unknown type'), p_mime
      using errcode = 'invalid_parameter_value';
  end if;
  insert into claim_evidence (client_id, evidence_type, label, storage_path, object_id, object_version, object_etag,
                              sha256, size_bytes, mime_type, original_name, source_url, captured_on, uploaded_by, upload_id)
  values (u.client_id, p_evidence_type, btrim(p_label), p_storage_path, o.id, o.version, o.metadata->>'eTag',
          u.sha256, u.size_bytes, u.mime_type, nullif(btrim(coalesce(p_original_name, '')), ''),
          case when p_evidence_type = 'capture' then p_source_url end,
          case when p_evidence_type = 'capture' then p_captured_on end, u.requested_by, u.id)
  returning * into e;
  return e;
end $$;
revoke all on function claim_evidence_register(uuid, text, text, bigint, text, text, text, text, text, date)
  from public, anon, authenticated, service_role;
grant execute on function claim_evidence_register(uuid, text, text, bigint, text, text, text, text, text, date) to service_role;

-- Is a registered file still exactly what was registered: the same storage
-- row at its content address, the same version and size.
create function claim_evidence_intact(e claim_evidence) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from storage.objects o
                  where o.id = e.object_id and o.bucket_id = 'claim-evidence' and o.name = e.storage_path
                    and (to_jsonb(o)->>'version') is not distinct from e.object_version
                    and (o.metadata->>'size') is not distinct from e.size_bytes::text)
$$;
revoke all on function claim_evidence_intact(claim_evidence) from public, anon;
grant execute on function claim_evidence_intact(claim_evidence) to authenticated, service_role;

-- ── 3. Fingerprints ─────────────────────────────────────────────────────────
-- The canonical claim (ChatGPT review): SHA-256 of a JSON document with fixed
-- keys (jsonb's text form is canonical: keys ordered, no insignificant
-- whitespace). Any change to the text, the source or the kind changes it.
create function claim_fingerprint(p_client_id uuid, p_claim text, p_source text, p_kind text) returns text
language sql immutable set search_path = pg_catalog as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'v', 'claim-fingerprint/v1', 'client_id', p_client_id, 'claim', p_claim, 'source', p_source, 'kind', p_kind)::text, 'UTF8')), 'hex')
$$;
revoke all on function claim_fingerprint(uuid, text, text, text) from public, anon;
grant execute on function claim_fingerprint(uuid, text, text, text) to authenticated, service_role;

-- An approved location identity version (citation_location_identities is
-- append-only), as SHA-256.
create function claim_location_identity_sha256(p_identity_id uuid) returns text
language sql stable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'v', 'location-identity/v1', 'location_id', i.location_id, 'version', i.version, 'business_name', i.business_name,
    'address_line1', i.address_line1, 'address_line2', i.address_line2, 'city', i.city, 'region', i.region,
    'postal_code', i.postal_code, 'country', i.country, 'hide_address', i.hide_address, 'phone', i.phone,
    'website_url', i.website_url)::text, 'UTF8')), 'hex')
    from citation_location_identities i where i.id = p_identity_id
$$;
revoke all on function claim_location_identity_sha256(uuid) from public, anon, authenticated, service_role;

-- The brand workspaces holding a claim (v1 D4: client_brand_workspaces.claim_ids),
-- ordered by id: the BHG scope a decision is made under.
create function claim_workspace_ids(p_claim_id uuid, p_client_id uuid) returns uuid[]
language sql stable set search_path = public, pg_temp as $$
  select coalesce(array_agg(w.id order by w.id), '{}')
    from client_brand_workspaces w where w.client_id = p_client_id and p_claim_id = any (w.claim_ids)
$$;
revoke all on function claim_workspace_ids(uuid, uuid) from public, anon, authenticated, service_role;

-- Hosts that are the client's own. p_claim_id given: the claim's own sites
-- (its brand workspaces' sites when it has any, else the client's site and
-- sites rows). NULL: every site the client has.
create function claim_own_hosts(p_client_id uuid, p_claim_id uuid) returns text[]
language sql stable set search_path = public, pg_temp as $$
  with ws as (select w.id, w.website_url, p_claim_id = any (w.claim_ids) as holds
                from client_brand_workspaces w where w.client_id = p_client_id),
  scoped as (select p_claim_id is not null and exists (select 1 from ws where holds) as by_workspace)
  select coalesce(array_agg(distinct h), '{}') from (
    select claim_url_host(u) h from (
      select c.website_url u from clients c, scoped where c.id = p_client_id and not scoped.by_workspace
      union all select s.url from sites s, scoped where s.client_id = p_client_id and not scoped.by_workspace
      union all select ws.website_url from ws, scoped where p_claim_id is null or (scoped.by_workspace and ws.holds)) x) y
   where h is not null
$$;
revoke all on function claim_own_hosts(uuid, uuid) from public, anon, authenticated, service_role;

-- ── 4. The decision ledger ─────────────────────────────────────────────────
create table claim_reviews (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  claim_id uuid not null,
  action text not null check (action in ('classify', 'verify', 'review', 'revoke')),
  kind text references claim_review_intervals (kind) check (kind is null or kind <> 'unclassified'),
  method text check (method in ('client_contract', 'manufacturer_document', 'issuer_record', 'structured_record',
                                'platform_record', 'client_confirmation', 'client_published', 'third_party')),
  evidence_id uuid,
  evidence_sha256 text check (evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  location_id uuid references citation_locations (id),
  location_identity_id uuid references citation_location_identities (id),
  location_identity_version integer,
  location_identity_sha256 text check (location_identity_sha256 is null or location_identity_sha256 ~ '^[0-9a-f]{64}$'),
  excerpt text check (excerpt is null or length(btrim(excerpt)) between 1 and 2000),
  observed_on date,
  expires_on date,
  confirmed_by_contact text check (confirmed_by_contact is null or length(btrim(confirmed_by_contact)) between 1 and 200),
  note text check (note is null or length(note) <= 1000),
  reason text check (reason is null or length(btrim(reason)) between 3 and 500),
  claim_fingerprint text not null check (claim_fingerprint ~ '^[0-9a-f]{64}$'),
  workspace_ids uuid[] not null default '{}',
  prior_review_id uuid references claim_reviews (id),
  in_force_verification_id uuid references claim_reviews (id),
  -- Stamped by claim_reviews_guard from the session; never supplied.
  reviewer_id uuid not null references team_members (id),
  authority_id uuid not null references claim_verification_authorities (id),
  created_at timestamptz not null default now(),
  created_txid bigint not null default txid_current(),
  -- History outlives nothing it describes: no cascade from the claim, so a
  -- reviewed claim cannot be deleted; a client deletion takes both.
  foreign key (claim_id, client_id) references claims (id, client_id),
  -- Evidence of this client only, with its hash copied exactly.
  foreign key (evidence_id, client_id, evidence_sha256) references claim_evidence (id, client_id, sha256),
  constraint claim_reviews_shape check (case action
    when 'classify' then kind is not null and method is null and evidence_id is null and location_id is null
                         and excerpt is null and observed_on is null and expires_on is null and reason is null
                         and in_force_verification_id is null
    when 'revoke' then reason is not null and method is null and evidence_id is null and location_id is null
                       and excerpt is null and observed_on is null and expires_on is null
                       and in_force_verification_id is null
    else kind is not null and method is not null and excerpt is not null and observed_on is not null and reason is null
         and in_force_verification_id = id
         and ((evidence_id is not null and evidence_sha256 is not null and location_id is null and location_identity_id is null)
              or (location_id is not null and location_identity_id is not null and location_identity_version is not null
                  and location_identity_sha256 is not null and evidence_id is null))
  end),
  check (expires_on is null or (observed_on is not null and expires_on > observed_on)),
  check (confirmed_by_contact is null or method = 'client_confirmation')
);
create index claim_reviews_claim_idx on claim_reviews (claim_id, created_at);
create index claim_reviews_client_idx on claim_reviews (client_id, created_at);
comment on table claim_reviews is
  'Append-only claim decisions (20261104200000): classify, verify, review, revoke. Reviewer, authority, time and transaction stamped by trigger; written only by claim_classify / claim_verify / claim_revoke for the verification owner.';

-- Only the verification owner, signed in, adds a row (even the table owner's
-- SQL is refused: the worker has no human session). Nobody changes or
-- deletes one, a superuser included; only a client deletion cascades.
create function claim_reviews_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_authority uuid;
begin
  if tg_op = 'INSERT' then
    v_authority := claim_reviewer_authority();
    if v_authority is null then
      raise exception 'Only the verification owner, signed in, records a claim review' using errcode = 'insufficient_privilege';
    end if;
    new.reviewer_id := task_actor();
    new.authority_id := v_authority;
    new.created_at := now();
    new.created_txid := txid_current();
    return new;
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then
    return old;
  end if;
  raise exception 'Claim reviews are append-only' using errcode = 'insufficient_privilege';
end $$;
revoke all on function claim_reviews_guard() from public, anon, authenticated, service_role;
create trigger claim_reviews_guard before insert or update or delete on claim_reviews
  for each row execute function claim_reviews_guard();
create trigger claim_reviews_no_truncate before truncate on claim_reviews
  for each statement execute function claim_reviews_guard();

-- Each decision in the existing governance history, with what it pinned.
create function claim_reviews_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform creative_governance_log(new.client_id, 'claim', new.claim_id,
    case new.action when 'classify' then 'classified' when 'verify' then 'verified'
                    when 'review' then 'reviewed' else 'revoked' end,
    jsonb_strip_nulls(jsonb_build_object(
      'review_id', new.id, 'kind', new.kind, 'method', new.method, 'evidence_id', new.evidence_id,
      'evidence_sha256', new.evidence_sha256, 'location_id', new.location_id,
      'location_identity_version', new.location_identity_version, 'location_identity_sha256', new.location_identity_sha256,
      'observed_on', new.observed_on, 'expires_on', new.expires_on, 'claim_fingerprint', new.claim_fingerprint,
      'workspace_ids', to_jsonb(new.workspace_ids), 'prior_review_id', new.prior_review_id,
      'in_force_verification_id', new.in_force_verification_id, 'authority_id', new.authority_id,
      'txid', new.created_txid)),
    coalesce(new.reason, new.note));
  return null;
end $$;
revoke all on function claim_reviews_audit() from public, anon, authenticated, service_role;
create trigger claim_reviews_audit after insert on claim_reviews
  for each row execute function claim_reviews_audit();

alter table claim_reviews enable row level security;
create policy "team reads claim reviews" on claim_reviews for select to authenticated using ((select is_team()));
revoke all on claim_reviews from public, anon, authenticated, service_role;
grant select on claim_reviews to authenticated;

-- ── 5. The projection on claims ─────────────────────────────────────────────
alter table claims add column review_id uuid references claim_reviews (id);
comment on column claims.review_id is
  'The claim_reviews decision in force (20261104200000). kind and the verification columns are its projection; only the verification workflow changes them.';

-- Replaces v1's lock. A change to kind, verification_method, verified_at,
-- verified_by, review_by, superseded_by or review_id is accepted only when
--   (a) the session is a superuser (platform administration; the suites'
--       fixtures), or
--   (b) review_id moves to a review of this claim written in THIS transaction
--       by THIS caller under their live owner authority, chained from the
--       review it replaces, superseded_by is untouched, and the new values are
--       exactly that review's projection.
-- Every other caller (a teammate's PostgREST write, the worker's SQL, an Edge
-- Function, a second admin) is refused. Ordinary claim edits are unaffected.
create or replace function claims_registry_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r claim_reviews;
  v claim_reviews;
begin
  if tg_op = 'INSERT' then
    if (new.kind, new.verification_method, new.verified_at, new.verified_by, new.review_by, new.superseded_by, new.review_id)
       is not distinct from (null::text, null::text, null::timestamptz, null::uuid, null::date, null::uuid, null::uuid) then
      return new;
    end if;
  elsif (new.kind, new.verification_method, new.verified_at, new.verified_by, new.review_by, new.superseded_by, new.review_id)
        is not distinct from (old.kind, old.verification_method, old.verified_at, old.verified_by, old.review_by, old.superseded_by, old.review_id) then
    return new;
  end if;
  if drafter_caller_is_superuser() then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.review_id is not null and new.review_id is distinct from old.review_id
     and new.superseded_by is not distinct from old.superseded_by then
    select * into r from claim_reviews where id = new.review_id;
    if r.id is not null and r.claim_id = new.id and r.client_id = new.client_id
       and r.created_txid = txid_current() and r.reviewer_id = task_actor()
       and r.authority_id = claim_reviewer_authority()
       and r.prior_review_id is not distinct from old.review_id then
      if r.in_force_verification_id is not null then
        select * into v from claim_reviews where id = r.in_force_verification_id;
      end if;
      if (new.kind, new.verification_method, new.verified_at, new.verified_by, new.review_by)
         is not distinct from (r.kind, v.method, v.created_at, v.reviewer_id, v.expires_on) then
        return new;
      end if;
    end if;
  end if;
  raise exception 'A claim''s classification and verification change only through the verification workflow, by the verification owner'
    using errcode = 'insufficient_privilege';
end $$;

-- ChatGPT review (refinement 3): once a claim has review history, it is kept.
-- Retirement and supersession are PR2b. A client deletion still cascades.
create function claims_keep_reviewed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from claim_reviews where claim_id = old.id)
     and exists (select 1 from clients where id = old.client_id) then
    raise exception 'This claim has review history and is kept; retiring a claim comes with the next verification release'
      using errcode = 'restrict_violation';
  end if;
  return old;
end $$;
revoke all on function claims_keep_reviewed() from public, anon, authenticated, service_role;
create trigger claims_keep_reviewed before delete on claims
  for each row execute function claims_keep_reviewed();

-- The governed fields claim history diffs, now with the review in force.
create or replace function claim_history_fields() returns text[]
language sql immutable set search_path = public as $$
  select array['claim', 'status', 'source', 'confirmed_by', 'confirmed_on', 'kind', 'verification_method',
               'verified_at', 'verified_by', 'review_by', 'superseded_by', 'review_id']
$$;

-- ── 6. The writers ──────────────────────────────────────────────────────────
-- Shared opening: a signed-in person, holding owner authority, the claim
-- locked, the screen not stale (fingerprint and review in force as loaded),
-- the claim not superseded. Internal.
create function claim_review_open(p_claim_id uuid, p_expected_fingerprint text, p_expected_review_id uuid) returns claims
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c claims;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in person classifies or verifies a claim' using errcode = 'insufficient_privilege';
  end if;
  if claim_reviewer_authority() is null then
    raise exception 'Only the verification owner classifies or verifies claims' using errcode = 'insufficient_privilege';
  end if;
  select * into c from claims where id = p_claim_id for update;
  if c.id is null then
    raise exception 'Claim % not found', p_claim_id using errcode = 'no_data_found';
  end if;
  if p_expected_fingerprint is distinct from claim_fingerprint(c.client_id, c.claim, c.source, c.kind)
     or p_expected_review_id is distinct from c.review_id then
    raise exception 'This claim changed after the page was loaded. Reload and review it again.' using errcode = 'CV409';
  end if;
  if c.superseded_by is not null then
    raise exception 'A superseded claim is not reviewed' using errcode = 'invalid_parameter_value';
  end if;
  return c;
end $$;
revoke all on function claim_review_open(uuid, text, uuid) from public, anon, authenticated, service_role;

-- Classify (or re-classify). A different kind of fact needs re-verification,
-- so any verification in force is cleared. Classifying never changes what a
-- post or draft may cite, so an unverified claim may be classified.
create function claim_classify(p_claim_id uuid, p_kind text, p_expected_fingerprint text,
                               p_expected_review_id uuid default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c claims := claim_review_open(p_claim_id, p_expected_fingerprint, p_expected_review_id);
  r claim_reviews;
begin
  if p_kind is null or p_kind = 'unclassified' or not exists (select 1 from claim_review_intervals where kind = p_kind) then
    raise exception 'Pick a claim kind' using errcode = 'invalid_parameter_value';
  end if;
  if p_kind = c.kind then
    raise exception 'The claim is already classified as %', p_kind using errcode = 'invalid_parameter_value';
  end if;
  insert into claim_reviews (client_id, claim_id, action, kind, note, claim_fingerprint, workspace_ids, prior_review_id,
                             reviewer_id, authority_id)
  values (c.client_id, c.id, 'classify', p_kind, nullif(btrim(coalesce(p_note, '')), ''),
          claim_fingerprint(c.client_id, c.claim, c.source, p_kind), claim_workspace_ids(c.id, c.client_id), c.review_id,
          task_actor(), claim_reviewer_authority())
  returning * into r;
  update claims set kind = p_kind, verification_method = null, verified_at = null, verified_by = null, review_by = null,
                    review_id = r.id
   where id = c.id;
  return jsonb_build_object('review_id', r.id, 'action', r.action, 'claim_id', c.id, 'kind', p_kind,
                            'cleared_verification', c.verified_at is not null);
end $$;
revoke all on function claim_classify(uuid, text, text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function claim_classify(uuid, text, text, uuid, text) to authenticated;

-- Verify (p_action 'verify', none in force) or re-review ('review', one in
-- force). The evidence rules of docs/claim-registry.md §PR2a, enforced here.
create function claim_verify(p_claim_id uuid, p_action text, p_method text, p_excerpt text, p_observed_on date,
                             p_expected_fingerprint text, p_expected_review_id uuid default null,
                             p_evidence_id uuid default null, p_location_id uuid default null,
                             p_expires_on date default null, p_confirmed_by_contact text default null,
                             p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c claims := claim_review_open(p_claim_id, p_expected_fingerprint, p_expected_review_id);
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_in_force uuid;
  v_methods text[];
  v_ws uuid[] := claim_workspace_ids(c.id, c.client_id);
  v_id uuid := gen_random_uuid();
  v_host text;
  e claim_evidence;
  l citation_locations;
  v_identity uuid;
  v_digits text;
  r claim_reviews;
begin
  if p_action not in ('verify', 'review') then
    raise exception 'The action is verify or review' using errcode = 'invalid_parameter_value';
  end if;
  if c.kind is null then
    raise exception 'Classify the claim before verifying it' using errcode = 'invalid_parameter_value';
  end if;
  -- D4: verifying never changes what content may cite. Confirming an
  -- unverified claim does, and comes with its content-impact review (PR2b).
  if c.status::text = 'unverified' then
    raise exception 'An unverified claim cannot be verified in this release: confirming it changes what content may cite, which needs its own review'
      using errcode = 'invalid_parameter_value';
  end if;
  select in_force_verification_id into v_in_force from claim_reviews where id = c.review_id;
  if p_action = 'verify' and v_in_force is not null then
    raise exception 'The claim is already verified; re-review it instead' using errcode = 'invalid_parameter_value';
  end if;
  if p_action = 'review' and v_in_force is null then
    raise exception 'There is no verification in force to re-review; verify the claim first' using errcode = 'invalid_parameter_value';
  end if;
  select authoritative_methods into v_methods from claim_review_intervals where kind = c.kind;
  if p_method is null or not (p_method = any (v_methods)) then
    raise exception '% does not settle a % claim (authoritative: %)', coalesce(p_method, 'No method'), c.kind,
      array_to_string(v_methods, ', ') using errcode = 'invalid_parameter_value';
  end if;
  if length(btrim(coalesce(p_excerpt, ''))) not between 1 and 2000 then
    raise exception 'Quote the words in the evidence that support the claim (up to 2000 characters)' using errcode = 'invalid_parameter_value';
  end if;
  if p_observed_on is null or p_observed_on > v_today then
    raise exception 'Say when you examined the evidence (not a future day)' using errcode = 'invalid_parameter_value';
  end if;
  if p_expires_on is not null and (p_expires_on <= p_observed_on or p_expires_on <= v_today) then
    raise exception 'An expiry must be after the day examined and after today' using errcode = 'invalid_parameter_value';
  end if;
  if p_method = 'client_confirmation' and length(btrim(coalesce(p_confirmed_by_contact, ''))) = 0 then
    raise exception 'Name the client contact who confirmed it' using errcode = 'invalid_parameter_value';
  end if;
  if p_method <> 'client_confirmation' and p_confirmed_by_contact is not null then
    raise exception 'A client contact is recorded only for a client confirmation' using errcode = 'invalid_parameter_value';
  end if;

  if p_method = 'structured_record' then
    -- A verified CRM record: an approved location of this client, on this
    -- claim's brand site (or client-wide), whose phone the claim states.
    if p_location_id is null or p_evidence_id is not null then
      raise exception 'A verified record is an approved location, not a file' using errcode = 'invalid_parameter_value';
    end if;
    select * into l from citation_locations where id = p_location_id;
    if l.id is null or l.client_id <> c.client_id then
      raise exception 'That location belongs to another client' using errcode = 'insufficient_privilege';
    end if;
    if l.brand_workspace_id is not null and not (l.brand_workspace_id = any (v_ws)) then
      raise exception 'That location belongs to another brand site than this claim' using errcode = 'insufficient_privilege';
    end if;
    if l.status <> 'active' or l.approved_by is null or l.approved_at is null then
      raise exception 'That location is not an approved, active record' using errcode = 'invalid_parameter_value';
    end if;
    v_digits := claim_phone_digits(c.claim);
    if v_digits is null then
      raise exception 'Only a claim that states a phone number is verified against a location record in this release'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_digits is distinct from claim_phone_digits(l.phone) then
      raise exception 'The claim''s phone does not match the % location''s approved phone', l.label using errcode = 'invalid_parameter_value';
    end if;
    select id into v_identity from citation_location_identities where location_id = l.id and version = l.identity_version;
    if v_identity is null then
      raise exception 'The location''s approved identity is not recorded' using errcode = 'invalid_parameter_value';
    end if;
  else
    if p_evidence_id is null or p_location_id is not null then
      raise exception 'Choose the uploaded evidence file' using errcode = 'invalid_parameter_value';
    end if;
    select * into e from claim_evidence where id = p_evidence_id;
    if e.id is null or e.client_id <> c.client_id then
      raise exception 'That evidence belongs to another client' using errcode = 'insufficient_privilege';
    end if;
    if not claim_evidence_intact(e) then
      raise exception 'The evidence file is missing or was replaced; upload it again' using errcode = 'invalid_parameter_value';
    end if;
    if p_method in ('client_contract', 'manufacturer_document', 'client_confirmation') and e.evidence_type <> 'document' then
      raise exception 'A % needs an uploaded document, not a page capture', replace(p_method, '_', ' ') using errcode = 'invalid_parameter_value';
    end if;
    if p_method in ('client_published', 'platform_record', 'issuer_record') then
      if e.evidence_type <> 'capture' then
        raise exception 'A % needs a captured record of the page (its URL and capture date), not a document', replace(p_method, '_', ' ')
          using errcode = 'invalid_parameter_value';
      end if;
      if e.captured_on < v_today - 30 or e.captured_on > p_observed_on then
        raise exception 'The capture must be from the last 30 days and no later than the day examined' using errcode = 'invalid_parameter_value';
      end if;
      v_host := claim_url_host(e.source_url);
      if p_method = 'client_published' and not (v_host = any (claim_own_hosts(c.client_id, c.id))) then
        raise exception 'A client''s published page must be on this claim''s own site (% is not)', v_host using errcode = 'invalid_parameter_value';
      end if;
      if p_method in ('platform_record', 'issuer_record') and v_host = any (claim_own_hosts(c.client_id, null)) then
        raise exception 'The client''s own site is not an independent % (%)', replace(p_method, '_', ' '), v_host
          using errcode = 'invalid_parameter_value';
      end if;
    end if;
  end if;

  insert into claim_reviews (id, client_id, claim_id, action, kind, method, evidence_id, evidence_sha256, location_id,
                             location_identity_id, location_identity_version, location_identity_sha256, excerpt, observed_on,
                             expires_on, confirmed_by_contact, note, claim_fingerprint, workspace_ids, prior_review_id,
                             in_force_verification_id, reviewer_id, authority_id)
  values (v_id, c.client_id, c.id, p_action, c.kind, p_method, e.id, e.sha256, l.id, v_identity,
          case when l.id is not null then l.identity_version end,
          case when v_identity is not null then claim_location_identity_sha256(v_identity) end,
          btrim(p_excerpt), p_observed_on, p_expires_on, nullif(btrim(coalesce(p_confirmed_by_contact, '')), ''),
          nullif(btrim(coalesce(p_note, '')), ''), claim_fingerprint(c.client_id, c.claim, c.source, c.kind), v_ws,
          c.review_id, v_id, task_actor(), claim_reviewer_authority())
  returning * into r;
  update claims set verification_method = r.method, verified_at = r.created_at, verified_by = r.reviewer_id,
                    review_by = r.expires_on, review_id = r.id
   where id = c.id;
  return jsonb_build_object('review_id', r.id, 'action', r.action, 'claim_id', c.id, 'method', r.method,
                            'evidence_sha256', r.evidence_sha256, 'location_identity_version', r.location_identity_version);
end $$;
revoke all on function claim_verify(uuid, text, text, text, date, text, uuid, uuid, uuid, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function claim_verify(uuid, text, text, text, date, text, uuid, uuid, uuid, date, text, text) to authenticated;

-- Revoke the verification in force; the kind stays.
create function claim_revoke(p_claim_id uuid, p_reason text, p_expected_fingerprint text,
                             p_expected_review_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c claims := claim_review_open(p_claim_id, p_expected_fingerprint, p_expected_review_id);
  r claim_reviews;
begin
  if not exists (select 1 from claim_reviews where id = c.review_id and in_force_verification_id is not null) then
    raise exception 'There is no verification in force to revoke' using errcode = 'invalid_parameter_value';
  end if;
  if length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'Say why the verification is revoked' using errcode = 'invalid_parameter_value';
  end if;
  insert into claim_reviews (client_id, claim_id, action, kind, reason, claim_fingerprint, workspace_ids, prior_review_id,
                             reviewer_id, authority_id)
  values (c.client_id, c.id, 'revoke', c.kind, btrim(p_reason), claim_fingerprint(c.client_id, c.claim, c.source, c.kind),
          claim_workspace_ids(c.id, c.client_id), c.review_id, task_actor(), claim_reviewer_authority())
  returning * into r;
  update claims set verification_method = null, verified_at = null, verified_by = null, review_by = null, review_id = r.id
   where id = c.id;
  return jsonb_build_object('review_id', r.id, 'action', r.action, 'claim_id', c.id);
end $$;
revoke all on function claim_revoke(uuid, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function claim_revoke(uuid, text, text, uuid) to authenticated;

-- ── 7. The registry, v2 ─────────────────────────────────────────────────────
-- v1 plus: independent verification needs a ledger decision (a bare column
-- value is 'verification_unrecorded', never verified); the decision's
-- evidence and its integrity; the canonical fingerprint and review in force
-- (the writers' stale-screen check); and what the viewer may do.
create or replace function claim_registry(p_client_id uuid, p_today date default null) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  c clients;
  v_today date := coalesce(p_today, (now() at time zone 'America/Chicago')::date);
  v_has_ws boolean;
  v_claims jsonb;
  v_programs jsonb;
begin
  if not coalesce(is_team(), false) then
    raise exception 'The claims registry is for the Compass team' using errcode = 'insufficient_privilege';
  end if;
  select * into c from clients where id = p_client_id;
  if c.id is null then
    raise exception 'Client % not found', p_client_id using errcode = 'no_data_found';
  end if;
  v_has_ws := exists (select 1 from client_brand_workspaces where client_id = c.id);

  with
  ws as (
    select w.id, w.slug, w.name, w.website_url, w.status, w.claim_ids, w.phone, w.sort_key
      from (select w.*, row_number() over (order by w.created_at, w.slug) sort_key
              from client_brand_workspaces w where w.client_id = c.id) w
  ),
  hosts as (
    select claim_url_host(u) host from (
      select c.website_url u union all select s.url from sites s where s.client_id = c.id
      union all select ws.website_url from ws) x
     where claim_url_host(u) is not null
  ),
  phones as (
    select claim_phone_digits(p) digits from (select c.phone p union all select ws.phone from ws) x
     where claim_phone_digits(p) is not null
  ),
  location_phones as (
    select claim_phone_digits(l.phone) digits, l.label
      from citation_locations l
     where l.client_id = c.id and l.status = 'active'
       and l.approved_at is not null and l.approved_by is not null
       and claim_phone_digits(l.phone) is not null
  ),
  base as (
    select cl.*, iv.review_days, iv.authoritative_methods, coalesce(iv.kind, 'unclassified') eff_kind,
           (cl.status::text = 'confirmed' or (cl.status::text = 'sourced' and nullif(btrim(coalesce(cl.source, '')), '') is not null)) legacy_usable,
           claim_source_url(cl.source) src_url,
           case when cl.verified_at is not null and cl.verification_method is not null then cl.verified_at
                when cl.status::text = 'confirmed' then cl.confirmed_on end last_verified_at,
           tm.name verified_by_name,
           claim_fingerprint(cl.client_id, cl.claim, cl.source, cl.kind) fp,
           cr.action last_action, cr.created_at last_at, cr.reason last_reason, cr.note last_note, crm.name last_by_name,
           vr.id ver_id, vr.action ver_action, vr.method ver_method, vr.excerpt ver_excerpt, vr.observed_on ver_observed_on,
           vr.expires_on ver_expires_on, vr.confirmed_by_contact ver_contact, vr.note ver_note, vr.claim_fingerprint ver_fp,
           vr.workspace_ids ver_ws, vr.created_at ver_at, vr.evidence_id ver_evidence_id,
           vr.location_id ver_location_id, vr.location_identity_version ver_loc_version,
           (select count(*) from claim_reviews h where h.claim_id = cl.id) review_count
      from claims cl
      join claim_review_intervals iv on iv.kind = coalesce(cl.kind, 'unclassified')
      left join team_members tm on tm.id = cl.verified_by
      left join claim_reviews cr on cr.id = cl.review_id
      left join team_members crm on crm.id = cr.reviewer_id
      left join claim_reviews vr on vr.id = cr.in_force_verification_id
     where cl.client_id = c.id
  ),
  b2 as (
    select b.*,
           claim_url_host(b.src_url) src_host,
           case when b.last_verified_at is null then b.review_by
                else least(b.review_by, (b.last_verified_at at time zone 'America/Chicago')::date + b.review_days) end due_on,
           -- Independent verification: a ledger decision with a method that
           -- settles this kind of fact.
           (b.verified_at is not null and b.ver_id is not null and b.verification_method = any (b.authoritative_methods)) authoritative,
           (b.verified_at is not null and b.verification_method = any (b.authoritative_methods)) method_authoritative,
           ((b.ver_id is not null and b.ver_fp <> b.fp)
            or (b.last_verified_at is not null and exists (
                  select 1 from creative_governance_events e
                   where e.subject_type = 'claim' and e.subject_id = b.id and e.action = 'updated'
                     and (e.changes ? 'claim' or e.changes ? 'source')
                     and not (e.changes ? 'verified_at' or e.changes ? 'confirmed_on')
                     and e.created_at > b.last_verified_at))) changed_since_verified,
           case when b.ver_evidence_id is not null then
             (select claim_evidence_intact(e) from claim_evidence e where e.id = b.ver_evidence_id) end evidence_intact,
           case when b.ver_location_id is not null then exists (
             select 1 from citation_locations l
              where l.id = b.ver_location_id and l.status = 'active' and l.approved_by is not null
                and l.identity_version = b.ver_loc_version) end location_intact,
           (b.ver_id is not null and b.ver_ws is distinct from
              (select coalesce(array_agg(w.id order by w.id), '{}') from ws w where b.id = any (w.claim_ids))) scope_changed,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', sp.id, 'platform', sp.platform, 'review_status', sp.review_status,
                     'publish_status', sp.publish_status, 'published_at', sp.published_at,
                     'published_url', sp.published_url) order by sp.published_at desc nulls last, sp.created_at, sp.id), '[]')
              from post_claims pc join social_posts sp on sp.id = pc.post_id where pc.claim_id = b.id) posts,
           (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', d.id, 'deliverable', d.deliverable, 'status', d.status, 'title', d.title,
                     'published_url', cp.url, 'published_at', cp.published_at) order by d.created_at, d.id), '[]')
              from content_draft_claims dc join content_drafts d on d.id = dc.draft_id
              left join content_posts cp on cp.id = d.final_content_post_id
             where dc.claim_id = b.id) drafts,
           array(select ws.slug from ws where b.id = any (ws.claim_ids) order by ws.sort_key) programs,
           (select coalesce(jsonb_agg(o.id order by o.id), '[]') from claims o
             where o.client_id = b.client_id and o.id <> b.id
               and (coalesce(o.claim, '') || ' ' || coalesce(o.source, '')) ~* 'supersed'
               and ((coalesce(o.claim, '') || ' ' || coalesce(o.source, '')) ~* ('\m' || b.id::text || '\M')
                    or ((coalesce(o.claim, '') || ' ' || coalesce(o.source, '')) ~* ('\m' || left(b.id::text, 8) || '\M')
                        and (select count(*) from claims z where z.client_id = b.client_id
                                and left(z.id::text, 8) = left(b.id::text, 8)) = 1))) supersession_mentioned_by,
           (select coalesce(jsonb_agg(o.id order by o.id), '[]') from claims o where o.superseded_by = b.id) supersedes,
           claim_phone_digits(b.claim) phone
      from base b
  ),
  b3 as (
    select b.*,
           case when b.last_verified_at is null then 'never_verified'
                when b.due_on < v_today then 'overdue'
                when b.due_on - v_today <= 14 then 'due'
                else 'current' end freshness,
           case when nullif(btrim(coalesce(b.source, '')), '') is null then 'none'
                when (b.source ~* '\msummar(y|ies)\M') then 'search_summary'
                when b.src_host is not null and exists (select 1 from hosts h where h.host = b.src_host) then 'client_site'
                when b.src_host ~ '(^|\.)google\.[a-z.]+$' or b.src_host = 'g.page' then 'google'
                when b.src_host ~ '\.(gov|mil)$' then 'government'
                when b.src_host is not null then 'third_party_web'
                when b.source ~* 'confirm' then 'confirmation_note'
                else 'text_note' end source_class,
           (select count(*) from jsonb_array_elements(b.posts) p where p->>'publish_status' = 'published')
             + (select count(*) from jsonb_array_elements(b.drafts) d where d->>'published_url' is not null) published_count,
           (b.evidence_intact is false or b.location_intact is false or b.scope_changed) integrity_broken
      from b2 b
  ),
  b4 as (
    select b.*,
           array_remove(array[
             case when b.superseded_by is not null then 'superseded' end,
             case when b.status::text = 'unverified' then 'unverified' end,
             case when b.status::text = 'sourced' and b.source_class = 'none' then 'missing_source' end,
             case when b.freshness = 'overdue' then 'overdue' end,
             case when b.freshness = 'due' then 'due_soon' end,
             case when b.freshness = 'never_verified' then 'never_verified' end,
             case when b.kind is null then 'unclassified' end,
             case when b.last_verified_at is not null and b.verified_at is null then 'method_unrecorded' end,
             case when b.verified_at is not null and b.ver_id is null then 'verification_unrecorded' end,
             case when b.verified_at is not null and not b.method_authoritative then 'method_not_authoritative' end,
             case when b.changed_since_verified then 'changed_since_verified' end,
             case when b.evidence_intact is false then 'evidence_file_changed' end,
             case when b.location_intact is false then 'evidence_location_changed' end,
             case when b.scope_changed then 'scope_changed_since_verified' end,
             case when b.ver_expires_on is not null and b.ver_expires_on < v_today then 'evidence_expired' end,
             case when not b.legacy_usable and (jsonb_array_length(b.posts) + jsonb_array_length(b.drafts)) > 0 then 'cited_while_unusable' end,
             case when not b.legacy_usable and b.published_count > 0 then 'published_while_unusable' end,
             case when b.superseded_by is not null and (jsonb_array_length(b.posts) + jsonb_array_length(b.drafts)) > 0 then 'cited_while_superseded' end,
             case when jsonb_array_length(b.supersession_mentioned_by) > 0 then 'supersession_mentioned' end,
             case when (coalesce(b.claim, '') || ' ' || coalesce(b.source, '')) ~* '\m(conflict[a-z]*|contradict[a-z]*|inconsistent)\M' then 'conflict_noted' end,
             case when b.source_class = 'search_summary' then 'summary_source' end,
             case when b.phone is not null and exists (select 1 from phones p where p.digits = b.phone) then 'duplicates_structured_phone' end,
             case when b.phone is not null and not exists (select 1 from phones p where p.digits = b.phone)
                       and exists (select 1 from location_phones l where l.digits = b.phone) then 'matches_location_phone' end,
             case when b.phone is not null and (exists (select 1 from phones) or exists (select 1 from location_phones))
                       and not exists (select 1 from phones p where p.digits = b.phone)
                       and not exists (select 1 from location_phones l where l.digits = b.phone) then 'phone_potential_mismatch' end,
             case when b.phone is not null and not exists (select 1 from phones) and not exists (select 1 from location_phones) then 'phone_without_structured_record' end,
             case when v_has_ws and cardinality(b.programs) = 0 then 'unassigned_to_site' end,
             case when cardinality(b.programs) > 1 then 'shared_across_sites' end
           ], null) reasons,
           case when b.superseded_by is not null then 'superseded'
                when b.status::text = 'unverified' then 'unverified'
                when b.status::text = 'sourced' and b.source_class = 'none' then 'missing_source'
                when b.freshness = 'overdue' then 'stale'
                when b.freshness = 'never_verified' or b.kind is null or not b.authoritative or b.changed_since_verified
                     or b.integrity_broken then 'needs_review'
                when b.freshness = 'due' then 'due'
                else 'verified' end bucket
      from b3 b
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'claim', b.claim, 'status', b.status, 'legacy_usable', b.legacy_usable,
           'verification_state', case when b.authoritative and not b.changed_since_verified and not b.integrity_broken
                                      then 'independently_verified' else 'not_independently_verified' end,
           'bucket', b.bucket, 'reasons', to_jsonb(b.reasons),
           'kind', b.kind, 'kind_label', (select label from claim_review_intervals where kind = b.eff_kind),
           'recorded_at', b.created_at,
           -- The writers' stale-screen check: pass both back unchanged.
           'fingerprint', b.fp, 'review_id', b.review_id, 'review_count', b.review_count,
           'verification', jsonb_build_object(
              'method', b.verification_method, 'authoritative', case when b.verified_at is not null then b.authoritative end,
              'authoritative_methods', to_jsonb(b.authoritative_methods),
              'verified_at', b.verified_at, 'verified_by', b.verified_by, 'verified_by_name', b.verified_by_name,
              'confirmed_by', b.confirmed_by, 'confirmed_on', b.confirmed_on,
              'last_verified_at', b.last_verified_at, 'changed_since_verified', b.changed_since_verified,
              'record', case when b.ver_id is not null then jsonb_build_object(
                 'review_id', b.ver_id, 'action', b.ver_action, 'at', b.ver_at, 'excerpt', b.ver_excerpt,
                 'observed_on', b.ver_observed_on, 'expires_on', b.ver_expires_on, 'confirmed_by_contact', b.ver_contact,
                 'note', b.ver_note,
                 'evidence', (select jsonb_build_object('id', e.id, 'type', e.evidence_type, 'label', e.label, 'sha256', e.sha256,
                                                        'mime_type', e.mime_type, 'size_bytes', e.size_bytes, 'source_url', e.source_url,
                                                        'captured_on', e.captured_on, 'intact', b.evidence_intact)
                                from claim_evidence e where e.id = b.ver_evidence_id),
                 'location', (select jsonb_build_object('id', l.id, 'label', l.label, 'identity_version', b.ver_loc_version,
                                                        'intact', b.location_intact)
                                from citation_locations l where l.id = b.ver_location_id)) end,
              'last_decision', case when b.review_id is not null then jsonb_build_object(
                 'action', b.last_action, 'at', b.last_at, 'by', b.last_by_name, 'reason', b.last_reason, 'note', b.last_note) end),
           'freshness', jsonb_build_object(
              'state', b.freshness, 'interval_days', b.review_days, 'review_by', b.review_by, 'due_on', b.due_on,
              'days_left', case when b.due_on is not null then b.due_on - v_today end),
           'source', jsonb_build_object('text', b.source, 'url', b.src_url, 'host', b.src_host, 'class', b.source_class),
           'scope', jsonb_build_object(
              'programs', to_jsonb(b.programs),
              'shared', case when v_has_ws then cardinality(b.programs) > 1 end,
              'unassigned', case when v_has_ws then cardinality(b.programs) = 0 end),
           'superseded_by', b.superseded_by, 'supersedes', b.supersedes, 'supersession_mentioned_by', b.supersession_mentioned_by,
           'phone_location', (select l.label from location_phones l where l.digits = b.phone order by l.label limit 1),
           'affected', jsonb_build_object(
              'posts', b.posts, 'drafts', b.drafts, 'published', b.published_count,
              'total', jsonb_array_length(b.posts) + jsonb_array_length(b.drafts)))
         order by array_position(array['superseded', 'unverified', 'missing_source', 'stale', 'needs_review', 'due', 'verified'], b.bucket),
                  b.created_at, b.id), '[]')
    into v_claims
    from b4 b;

  select coalesce(jsonb_agg(p order by (p->>'sort_key')::int), '[]') into v_programs from (
    select jsonb_build_object(
             'sort_key', w.sort_key, 'workspace_id', w.id, 'slug', w.slug, 'name', w.name, 'website_url', w.website_url,
             'scope', 'brand_workspace', 'workspace_status', w.status, 'scope_authoritative', w.status = 'approved',
             'claim_ids', (select coalesce(jsonb_agg(x->'id' order by x->>'id'), '[]') from jsonb_array_elements(v_claims) x
                            where x->'scope'->'programs' ? w.slug),
             'counts', case when w.status = 'approved' then (
                select jsonb_build_object(
                  'total', count(*),
                  'verified', count(*) filter (where x->>'bucket' = 'verified'),
                  'due', count(*) filter (where x->>'bucket' = 'due'),
                  'stale', count(*) filter (where x->>'bucket' = 'stale'),
                  'needs_review', count(*) filter (where x->>'bucket' = 'needs_review'),
                  'unverified', count(*) filter (where x->>'bucket' = 'unverified'),
                  'missing_source', count(*) filter (where x->>'bucket' = 'missing_source'),
                  'superseded', count(*) filter (where x->>'bucket' = 'superseded'),
                  'legacy_usable', count(*) filter (where (x->>'legacy_usable')::boolean),
                  'shared', count(*) filter (where (x->'scope'->>'shared')::boolean),
                  'cited_while_unusable', count(*) filter (where x->'reasons' ? 'cited_while_unusable'))
                 from jsonb_array_elements(v_claims) x where x->'scope'->'programs' ? w.slug) end) p
      from (select w.*, row_number() over (order by w.created_at, w.slug) sort_key
              from client_brand_workspaces w where w.client_id = c.id) w
    union all
    select jsonb_build_object(
             'sort_key', 0, 'workspace_id', null, 'slug', null, 'name', c.name, 'website_url', c.website_url,
             'scope', 'client', 'workspace_status', null, 'scope_authoritative', true,
             'claim_ids', (select coalesce(jsonb_agg(x->'id' order by x->>'id'), '[]') from jsonb_array_elements(v_claims) x),
             'counts', null)
     where not v_has_ws
  ) q;

  return jsonb_build_object(
    'version', 'claim-registry/v2',
    'client_id', c.id,
    'client', c.name,
    'as_of', now(),
    'today', v_today,
    'multi_site', v_has_ws,
    -- A display hint only; the writers decide for themselves.
    'viewer', jsonb_build_object('can_review', exists (
       select 1 from claim_verification_authorities a join team_members m on m.id = a.team_member_id
        where m.auth_user_id = auth.uid() and m.role = 'admin' and a.authority = 'owner' and a.revoked_at is null)),
    'verification_owner', (select m.name from claim_verification_authorities a join team_members m on m.id = a.team_member_id
                            where a.authority = 'owner' and a.revoked_at is null),
    'evidence', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', e.id, 'type', e.evidence_type, 'label', e.label, 'sha256', e.sha256, 'size_bytes', e.size_bytes,
                    'mime_type', e.mime_type, 'original_name', e.original_name, 'source_url', e.source_url,
                    'captured_on', e.captured_on, 'uploaded_by_name', m.name, 'created_at', e.created_at,
                    'intact', claim_evidence_intact(e)) order by e.created_at desc, e.id), '[]')
                   from claim_evidence e left join team_members m on m.id = e.uploaded_by where e.client_id = c.id),
    'locations', (select coalesce(jsonb_agg(jsonb_build_object(
                     'id', l.id, 'label', l.label, 'phone', l.phone, 'identity_version', l.identity_version,
                     'workspace_slug', (select w.slug from client_brand_workspaces w where w.id = l.brand_workspace_id))
                     order by l.label), '[]')
                    from citation_locations l
                   where l.client_id = c.id and l.status = 'active' and l.approved_by is not null and l.approved_at is not null),
    'intervals', (select jsonb_agg(jsonb_build_object('kind', kind, 'label', label, 'review_days', review_days,
                                                      'authoritative_methods', authoritative_methods) order by review_days, kind)
                    from claim_review_intervals),
    'totals', (select jsonb_build_object(
                  'total', count(*),
                  'verified', count(*) filter (where x->>'bucket' = 'verified'),
                  'due', count(*) filter (where x->>'bucket' = 'due'),
                  'stale', count(*) filter (where x->>'bucket' = 'stale'),
                  'needs_review', count(*) filter (where x->>'bucket' = 'needs_review'),
                  'unverified', count(*) filter (where x->>'bucket' = 'unverified'),
                  'missing_source', count(*) filter (where x->>'bucket' = 'missing_source'),
                  'superseded', count(*) filter (where x->>'bucket' = 'superseded'),
                  'legacy_usable', count(*) filter (where (x->>'legacy_usable')::boolean),
                  'cited_while_unusable', count(*) filter (where x->'reasons' ? 'cited_while_unusable'),
                  'published_while_unusable', count(*) filter (where x->'reasons' ? 'published_while_unusable'),
                  'unassigned', case when v_has_ws then count(*) filter (where (x->'scope'->>'unassigned')::boolean) end,
                  'shared', case when v_has_ws then count(*) filter (where (x->'scope'->>'shared')::boolean) end)
                 from jsonb_array_elements(v_claims) x),
    'programs', case when v_has_ws then v_programs
                     else (select jsonb_agg(p || jsonb_build_object('counts', (
                              select jsonb_build_object(
                                'total', count(*),
                                'verified', count(*) filter (where x->>'bucket' = 'verified'),
                                'due', count(*) filter (where x->>'bucket' = 'due'),
                                'stale', count(*) filter (where x->>'bucket' = 'stale'),
                                'needs_review', count(*) filter (where x->>'bucket' = 'needs_review'),
                                'unverified', count(*) filter (where x->>'bucket' = 'unverified'),
                                'missing_source', count(*) filter (where x->>'bucket' = 'missing_source'),
                                'superseded', count(*) filter (where x->>'bucket' = 'superseded'),
                                'legacy_usable', count(*) filter (where (x->>'legacy_usable')::boolean),
                                'shared', null,
                                'cited_while_unusable', count(*) filter (where x->'reasons' ? 'cited_while_unusable'))
                               from jsonb_array_elements(v_claims) x)))
                             from jsonb_array_elements(v_programs) p) end,
    'claims', v_claims);
end $$;
revoke all on function claim_registry(uuid, date) from public, anon;
grant execute on function claim_registry(uuid, date) to authenticated, service_role;

-- ── 8. Verify ───────────────────────────────────────────────────────────────
do $verify$
declare
  v_changed text;
  f text;
begin
  if (select count(*) from claim_verification_pinned) < 5 then
    raise exception '20261104200000: the hash pin found too few readers of claims';
  end if;
  select string_agg(p.fn, ', ') into v_changed
    from claim_verification_pinned p
   where p.h is distinct from (select md5(pg_get_functiondef(p.fn::regprocedure)));
  if v_changed is not null then
    raise exception '20261104200000 changed a reader of claims: %', v_changed;
  end if;
  if (select row(n, d) from claim_verification_digest) is distinct from
     (select row(count(*), md5(coalesce(string_agg((to_jsonb(c) - 'review_id')::text, '|' order by c.id), ''))) from claims c) then
    raise exception '20261104200000 changed a claim row';
  end if;
  if exists (select 1 from claims where review_id is not null) or exists (select 1 from claim_reviews)
     or exists (select 1 from claim_evidence) or exists (select 1 from claim_evidence_uploads) then
    raise exception '20261104200000: the ledger and evidence must start empty (no backfill)';
  end if;
  if (select count(*) from claim_verification_authorities) > 1 then
    raise exception '20261104200000: at most one verification owner is granted';
  end if;
  if (select provolatile from pg_proc where oid = 'public.claim_registry(uuid,date)'::regprocedure) <> 's'
     or (select prosecdef from pg_proc where oid = 'public.claim_registry(uuid,date)'::regprocedure) then
    raise exception 'claim_registry must be stable and security invoker';
  end if;
  -- Writers: a signed-in caller only. Internals: nobody but their owner.
  foreach f in array array['public.claim_classify(uuid,text,text,uuid,text)',
                           'public.claim_verify(uuid,text,text,text,date,text,uuid,uuid,uuid,date,text,text)',
                           'public.claim_revoke(uuid,text,text,uuid)',
                           'public.claim_evidence_request_upload(uuid,text,bigint,text)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('service_role', f, 'execute')
       or not has_function_privilege('authenticated', f, 'execute') then
      raise exception 'writer grants: %', f;
    end if;
  end loop;
  foreach f in array array['public.claim_reviewer_authority()', 'public.claim_review_open(uuid,text,uuid)',
                           'public.claim_reviews_guard()', 'public.claim_reviews_audit()', 'public.claim_evidence_guard()',
                           'public.claim_evidence_uploads_guard()',
                           'public.claim_verification_authorities_guard()', 'public.claims_keep_reviewed()',
                           'public.claim_evidence_objects_immutable()', 'public.claim_workspace_ids(uuid,uuid)',
                           'public.claim_own_hosts(uuid,uuid)', 'public.claim_location_identity_sha256(uuid)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
       or has_function_privilege('service_role', f, 'execute') then
      raise exception 'internal function grants: %', f;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.claim_evidence_register(uuid,text,text,bigint,text,text,text,text,text,date)', 'execute')
     or has_function_privilege('anon', 'public.claim_evidence_register(uuid,text,text,bigint,text,text,text,text,text,date)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_evidence_register(uuid,text,text,bigint,text,text,text,text,text,date)', 'execute') then
    raise exception 'claim_evidence_register grants';
  end if;
  if has_table_privilege('authenticated', 'public.claim_reviews', 'insert, update, delete, truncate')
     or has_table_privilege('service_role', 'public.claim_reviews', 'insert, update, delete, truncate')
     or has_table_privilege('authenticated', 'public.claim_evidence', 'insert, update, delete, truncate')
     or has_table_privilege('service_role', 'public.claim_evidence', 'insert, update, delete, truncate')
     or has_table_privilege('authenticated', 'public.claim_evidence_uploads', 'insert, update, delete, truncate')
     or has_table_privilege('service_role', 'public.claim_evidence_uploads', 'insert, update, delete, truncate')
     or has_table_privilege('anon', 'public.claim_evidence_uploads', 'select')
     or has_table_privilege('authenticated', 'public.claim_verification_authorities', 'insert, update, delete, truncate')
     or has_table_privilege('service_role', 'public.claim_verification_authorities', 'insert, update, delete, truncate')
     or has_table_privilege('anon', 'public.claim_reviews', 'select')
     or has_table_privilege('anon', 'public.claim_evidence', 'select')
     or has_table_privilege('anon', 'public.claim_verification_authorities', 'select') then
    raise exception 'claim verification table grants';
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
         and (qual like '%claim-evidence%' or with_check like '%claim-evidence%')) <> 1
     or exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and (qual like '%claim-evidence%' or with_check like '%claim-evidence%') and cmd <> 'SELECT') then
    raise exception 'claim-evidence storage: team read is the only policy';
  end if;
end $verify$;
