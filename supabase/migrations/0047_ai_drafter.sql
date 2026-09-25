-- AI Drafter v1, Deliverable 2 (Sept 25 2026; design approved Sept 25).
--
-- Turns Deliverable 1's governed brief + deterministic linter into a real
-- draft workflow that ends in 0045's human review:
--
--   post-drafter Edge Function ── brief → model adapter → lint ──►
--     drafter_write() (ONE transaction): drafter_runs row, social_posts draft,
--     post_claims / post_assets, draft → in_review (0045 checks grounding and
--     opens the CLAUDE_APPROVAL post_review task)
--
-- Nothing here approves, schedules or publishes. 0045's rules stand: only a
-- signed-in teammate approves; grounding is re-checked at submit, approval
-- and publishing.
--
-- 1. client_intelligence_input(client_id): the ONE read of Client
--    Intelligence. The Intelligence tab, the post-drafter function and the
--    dry-run tooling all call it, so they cannot drift apart. Invoker
--    rights: a teammate reads through the existing is_team() policies, the
--    Edge Function's service role reads everything, anyone else gets nulls.
--
-- 2. drafter_runs: one row per submit (success or failure), for audit and
--    reproducibility — the brief the model saw, its hash, the claims chosen,
--    the lint result, the runtime's own label, the copy's sha256 (never the
--    copy itself: the post holds that). Team-readable; written only by the
--    post-drafter function's service session.
--
-- 3. social_posts.drafter_run_id: provenance. Set only by drafter_write,
--    immutable once set.
--
-- 4. The write boundary. The worker's SQL runs as `postgres` (table owner,
--    BYPASSRLS, may SET ROLE service_role / authenticated). What ordinary SQL
--    cannot change is session_user: the worker's is always `postgres`, while
--    Edge Functions reach the database through PostgREST as `authenticator`.
--    (0045's human-approval gate relies on the same fact.) So:
--    - a non-human INSERT into social_posts is refused unless it runs in the
--      drafter session: session_user = authenticator, role = service_role,
--      inside drafter_write (which sets compass.drafter_write for its
--      transaction), with a drafter_runs row in status 'writing' whose
--      copy_hash is the sha256 of the copy being inserted;
--    - a drafter post's content and its claim / asset links change only in
--      that session or by a person (the app); worker SQL cannot edit them;
--    - nobody but the drafter session sets drafter_run_id, and it never
--      changes;
--    - drafter_runs rows are written only by the service session, and are
--      immutable except writing → submitted.
--    The compass.drafter_write flag is a label, not the boundary: setting it
--    by hand changes nothing without the authenticator session.
--    True superusers (Supabase's platform role; the sandbox fixtures) are
--    exempt: they bypass every trigger anyway, and the worker is not one.
--    OUT OF SCOPE by decision (Sept 25): a deliberate schema change by the
--    table owner (disabling or dropping these triggers) defeats any in-database
--    control, 0045's included. Follow-up after the pilot: run worker SQL as a
--    non-owner role with grants only and no schema-change rights.
--
-- Existing behaviour kept: human-created posts, 0045's review / lapse /
-- publishing transitions and 0046's publisher (it never inserts posts) are
-- unchanged; the new content / link guards apply only to drafter posts.
--
-- Rollback (while no drafter post exists): drop the triggers and functions
-- below, social_posts.drafter_run_id and drafter_runs.

-- ── 1. The canonical Client Intelligence loader ─────────────────────────────
create function client_intelligence_input(p_client_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'asOf', (now() at time zone 'America/Chicago')::date,
    'client', (select jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'website_url', c.website_url,
               'city', c.city, 'state', c.state, 'service_area', c.service_area, 'business_type', c.business_type,
               'address_line1', c.address_line1)
               from clients c where c.id = p_client_id),
    'brand', (select jsonb_build_object('positioning', b.positioning, 'voice_tone', b.voice_tone, 'audience', b.audience,
              'differentiators', b.differentiators, 'ai_guidance', b.ai_guidance, 'words_we_use', b.words_we_use,
              'words_we_avoid', b.words_we_avoid, 'content_pillars', b.content_pillars, 'tagline', b.tagline)
              from client_brands b where b.client_id = p_client_id),
    'board', (select jsonb_build_object('id', bb.id, 'version', bb.version, 'status', bb.status,
              'hard_rules', bb.hard_rules, 'standing_cta', bb.standing_cta)
              from brand_boards bb where bb.client_id = p_client_id order by bb.version desc limit 1),
    'services', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'status', s.status,
                 'page_url', s.page_url, 'primary_keyword_id', s.primary_keyword_id,
                 'parent_service_id', s.parent_service_id, 'segment', s.segment) order by s.sort_order, s.id)
                 from services s where s.client_id = p_client_id), '[]'::jsonb),
    'keywords', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'keyword', k.keyword, 'intent', k.intent,
                 'intent_note', k.intent_note, 'is_active', k.is_active, 'is_tracked', k.is_tracked,
                 'is_money', k.is_money, 'service_id', k.service_id, 'target_url', k.target_url,
                 'priority', k.priority) order by k.created_at, k.id)
                 from keywords k where k.client_id = p_client_id), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', cl.id, 'claim', cl.claim, 'status', cl.status,
               'source', cl.source) order by cl.created_at, cl.id)
               from claims cl where cl.client_id = p_client_id), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'city', l.city, 'state', l.state,
                  'is_active', l.is_active) order by l.sort_order, l.id)
                  from locations l where l.client_id = p_client_id), '[]'::jsonb),
    'assets', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'label', a.label,
               'storage_path', a.storage_path) order by a.sort_order, a.created_at, a.id)
               from brand_assets a where a.client_id = p_client_id), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'terms', o.terms,
               'source', o.source, 'status', o.status, 'starts_on', o.starts_on, 'ends_on', o.ends_on,
               'confirmed_by', o.confirmed_by, 'confirmed_on', o.confirmed_on, 'service_id', o.service_id)
               order by o.created_at, o.id)
               from offers o where o.client_id = p_client_id), '[]'::jsonb),
    'pageGroups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'status', g.status,
                   'target_url', g.target_url, 'primary_keyword_id', g.primary_keyword_id) order by g.created_at, g.id)
                   from page_groups g where g.client_id = p_client_id), '[]'::jsonb)
  )
$$;
comment on function client_intelligence_input(uuid) is
  'The one read of Client Intelligence (Intelligence tab, post-drafter, dry runs). Invoker rights: RLS decides what the caller sees.';
revoke all on function client_intelligence_input(uuid) from public, anon;
grant execute on function client_intelligence_input(uuid) to authenticated, service_role;

-- ── 2. Caller helpers ───────────────────────────────────────────────────────
-- The post-drafter function's connection: PostgREST's login with the
-- service role. The worker's SQL (session_user postgres) never is, whatever
-- role it switches to.
create function drafter_caller_is_service() returns boolean
language sql stable set search_path = public as $$
  select session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'service_role'
$$;
-- ...and inside drafter_write's transaction.
create function drafter_session_active() returns boolean
language sql stable set search_path = public as $$
  select drafter_caller_is_service() and coalesce(current_setting('compass.drafter_write', true), '') = 'on'
$$;
-- A true superuser session (Supabase's platform role; sandbox fixtures). It
-- bypasses every trigger regardless; the worker's postgres login is not one.
create function drafter_caller_is_superuser() returns boolean
language sql stable set search_path = public, pg_catalog as $$
  select coalesce((select rolsuper from pg_roles where rolname = session_user), false)
$$;
-- sha256 of a post's copy, as the Edge Function computes it (UTF-8, hex).
create function drafter_copy_hash(p_copy text) returns text
language sql immutable set search_path = public, extensions, pg_catalog as $$
  select encode(sha256(convert_to(coalesce(p_copy, ''), 'UTF8')), 'hex')
$$;
revoke all on function drafter_caller_is_service() from public, anon, authenticated;
revoke all on function drafter_session_active() from public, anon, authenticated;
revoke all on function drafter_caller_is_superuser() from public, anon, authenticated;
revoke all on function drafter_copy_hash(text) from public, anon, authenticated;
-- drafter_write (invoker, service role) calls these directly.
grant execute on function drafter_caller_is_service() to service_role;
grant execute on function drafter_copy_hash(text) to service_role;

-- ── 3. drafter_runs ─────────────────────────────────────────────────────────
create table drafter_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  requested_via text not null check (requested_via in ('worker', 'team')),
  requested_by uuid references team_members(id) on delete set null,
  target jsonb not null,
  brief_version text not null,
  brief_hash text not null check (brief_hash ~ '^sha256:[0-9a-f]{64}$'),
  brief jsonb,
  claim_ids uuid[] not null default '{}',
  runtime text not null check (length(btrim(runtime)) between 1 and 80),
  attempt int not null default 1 check (attempt between 1 and 10),
  lint jsonb,
  copy_hash text check (copy_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('writing', 'submitted', 'lint_failed', 'refused', 'stale_brief')),
  detail text,
  post_id uuid,
  constraint drafter_runs_id_client_key unique (id, client_id),
  constraint drafter_runs_post_fk foreign key (post_id, client_id)
    references social_posts (id, client_id) on delete set null (post_id),
  -- (A submitted run gets its post from drafter_write; post_id goes null
  -- again only if a rejected post is later deleted.)
  constraint drafter_runs_writing_has_hash check (status not in ('writing', 'submitted') or copy_hash is not null)
);
create index drafter_runs_client_idx on drafter_runs (client_id, created_at desc);
create index drafter_runs_post_idx on drafter_runs (post_id) where post_id is not null;
comment on table drafter_runs is
  'AI Drafter submit attempts (audit): brief + hash, chosen claims, lint, runtime label, copy sha256. Written only by the post-drafter function.';

alter table drafter_runs enable row level security;
create policy "team reads drafter runs" on drafter_runs
  for select to authenticated using ((select is_team()));
revoke all on drafter_runs from anon;
revoke insert, update, delete, truncate, references, trigger on drafter_runs from authenticated;

create function drafter_runs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if drafter_caller_is_superuser() then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    -- Only as part of deleting the client.
    if not exists (select 1 from clients where id = old.client_id) then return old; end if;
    raise exception 'Drafter runs are an audit record and are not deleted' using errcode = 'insufficient_privilege';
  end if;
  -- The foreign key clearing post_id when its (rejected) post is
  -- deleted is the one change outside drafter_write.
  if tg_op = 'UPDATE' and old.post_id is not null and new.post_id is null
     and not exists (select 1 from social_posts where id = old.post_id)
     and (to_jsonb(new) - 'post_id') = (to_jsonb(old) - 'post_id') then
    return new;
  end if;
  if not drafter_caller_is_service() then
    raise exception 'Drafter runs are written only by the post-drafter function' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.status = 'writing' and not drafter_session_active() then
      raise exception 'A run is opened for writing only inside drafter_write' using errcode = 'insufficient_privilege';
    end if;
    if new.status = 'submitted' then
      raise exception 'A run is submitted only by drafter_write' using errcode = 'check_violation';
    end if;
    new.created_at := now();
    return new;
  end if;
  -- UPDATE: writing → submitted with its post, inside drafter_write; nothing else moves.
  if not (old.status = 'writing' and new.status = 'submitted' and drafter_session_active()
          and old.post_id is null and new.post_id is not null
          and (to_jsonb(new) - 'status' - 'post_id') = (to_jsonb(old) - 'status' - 'post_id')) then
    raise exception 'Drafter runs are immutable once written' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function drafter_runs_guard() from public, anon, authenticated;
create trigger drafter_runs_guard before insert or update or delete on drafter_runs
  for each row execute function drafter_runs_guard();

-- ── 4. Provenance on the post ───────────────────────────────────────────────
alter table social_posts
  add column drafter_run_id uuid,
  add constraint social_posts_drafter_run_fk foreign key (drafter_run_id, client_id)
    references drafter_runs (id, client_id);
create index social_posts_drafter_run_idx on social_posts (drafter_run_id) where drafter_run_id is not null;
comment on column social_posts.drafter_run_id is
  'The AI Drafter run that wrote this post (0047). Set only by drafter_write; never changes.';

-- ── 5. The write boundary on social_posts ───────────────────────────────────
-- Runs after 0045's social_posts_aa_* triggers (name order).
create function social_posts_drafter_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_human boolean := post_caller_is_human();
  v_drafter boolean := drafter_session_active();
  v_super boolean := drafter_caller_is_superuser();
  r drafter_runs;
begin
  if tg_op = 'INSERT' then
    if new.drafter_run_id is not null and not v_drafter then
      raise exception 'Only the post-drafter function sets drafter_run_id' using errcode = 'insufficient_privilege';
    end if;
    if not v_human and not v_drafter and not v_super then
      raise exception 'Posts written by the worker or a model are created only through the post-drafter function'
        using errcode = 'insufficient_privilege';
    end if;
    if v_drafter then
      if new.drafter_run_id is null then
        raise exception 'The drafter links every post it writes to its run' using errcode = 'check_violation';
      end if;
      select * into r from drafter_runs where id = new.drafter_run_id and client_id = new.client_id;
      if r.id is null or r.status <> 'writing' then
        raise exception 'The drafter run is not open for writing' using errcode = 'check_violation';
      end if;
      if r.copy_hash is distinct from drafter_copy_hash(new.copy) then
        raise exception 'The copy is not the copy the drafter checked' using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  if new.drafter_run_id is distinct from old.drafter_run_id then
    raise exception 'drafter_run_id is fixed once the post exists' using errcode = 'check_violation';
  end if;
  if old.drafter_run_id is not null and not v_human and not v_drafter and not v_super
     and (new.platform, new.post_type, new.search_intent, new.service_id, new.keyword_id, new.offer_id,
          new.copy, new.cta_type, new.cta_url, new.crm_facts_only)
         is distinct from
         (old.platform, old.post_type, old.search_intent, old.service_id, old.keyword_id, old.offer_id,
          old.copy, old.cta_type, old.cta_url, old.crm_facts_only) then
    raise exception 'A drafted post''s content changes only through the post-drafter function or a person'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
revoke all on function social_posts_drafter_guard() from public, anon, authenticated;
create trigger social_posts_ab_drafter before insert or update on social_posts
  for each row execute function social_posts_drafter_guard();

-- Claim and asset links on a drafter post: the drafter session (only the
-- claims its run chose) or a person. 0045's post_links_guard still applies.
create function post_links_drafter_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_post_id uuid := coalesce(new.post_id, old.post_id);
  v_run uuid;
  r drafter_runs;
begin
  select drafter_run_id into v_run from social_posts where id = v_post_id;
  if v_run is null then return coalesce(new, old); end if;  -- not a drafter post (or it is being deleted)
  if tg_op = 'DELETE' then
    -- Cascades from deleting the claim or asset itself.
    -- (Separate branches: each table has only its own column.)
    if tg_table_name = 'post_claims' then
      if not exists (select 1 from claims where id = old.claim_id) then return old; end if;
    else
      if not exists (select 1 from brand_assets where id = old.brand_asset_id) then return old; end if;
    end if;
  end if;
  if drafter_caller_is_superuser() or post_caller_is_human() then return coalesce(new, old); end if;
  if not drafter_session_active() then
    raise exception 'A drafted post''s claims and assets change only through the post-drafter function or a person'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' and tg_table_name = 'post_claims' then
    select * into r from drafter_runs where id = v_run;
    if r.status <> 'writing' or not (new.claim_id = any (r.claim_ids)) then
      raise exception 'The drafter links only the claims its run chose' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end $$;
revoke all on function post_links_drafter_guard() from public, anon, authenticated;
create trigger post_claims_drafter_guard before insert or update or delete on post_claims
  for each row execute function post_links_drafter_guard();
create trigger post_assets_drafter_guard before insert or update or delete on post_assets
  for each row execute function post_links_drafter_guard();

-- ── 6. The governed write ───────────────────────────────────────────────────
-- Called once per submit by the post-drafter function (service role through
-- PostgREST: one transaction). The function has already rebuilt the brief
-- from live data, compared its hash and linted the copy; this re-checks what
-- the database can and writes everything or nothing. The target comes from
-- the brief, not from the caller.
--
-- p: { client_id, requested_via, requested_by?, runtime, attempt,
--      brief_version, brief_hash, brief, lint, copy, claim_ids, asset_ids }
create function drafter_write(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_client uuid := (p->>'client_id')::uuid;
  v_brief jsonb := p->'brief';
  v_target jsonb := v_brief->'target';
  v_copy text := p->>'copy';
  v_claims uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'claim_ids', '[]')) x), '{}');
  v_assets uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'asset_ids', '[]')) x), '{}');
  v_allowed uuid[];
  v_service uuid := nullif(v_target->'service'->>'id', '')::uuid;
  v_page text;
  v_cta_type text := nullif(v_target->'cta'->>'type', '');
  v_cta_url text := nullif(v_target->'cta'->>'url', '');
  v_run uuid;
  v_post uuid;
  v_task uuid;
  i int;
begin
  if not drafter_caller_is_service() then
    raise exception 'drafter_write runs only in the post-drafter function' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('compass.drafter_write', 'on', true);

  if v_client is null or v_brief is null or v_target is null or nullif(btrim(coalesce(v_copy, '')), '') is null then
    raise exception 'drafter_write needs client_id, brief, target and copy' using errcode = 'check_violation';
  end if;
  if (v_brief->'client'->>'id')::uuid is distinct from v_client then
    raise exception 'The brief is for another client' using errcode = 'check_violation';
  end if;
  if coalesce((p->'lint'->>'ok')::boolean, false) is not true then
    raise exception 'Only a draft that passed the linter is written' using errcode = 'check_violation';
  end if;
  if coalesce(v_target->>'channel', '') <> 'google_business' then
    raise exception 'The drafter writes Business Profile posts only in v1' using errcode = 'check_violation';
  end if;
  -- Claims: only ones the brief allowed.
  select coalesce(array_agg((c->>'id')::uuid), '{}') into v_allowed
    from jsonb_array_elements(coalesce(v_brief->'allowed_facts'->'claims', '[]')) c;
  if not (v_claims <@ v_allowed) then
    raise exception 'A linked claim is not in the brief' using errcode = 'check_violation';
  end if;
  if cardinality(v_assets) > 1 then
    raise exception 'Business Profile posts take one photo in v1' using errcode = 'check_violation';
  end if;
  -- The button goes to the service's own page.
  if v_service is not null then
    select page_url into v_page from services where id = v_service and client_id = v_client and status = 'approved';
    if v_page is null then
      raise exception 'The target service is not an approved service of this client with a page' using errcode = 'check_violation';
    end if;
    if v_cta_type is not null and v_cta_type <> 'CALL'
       and rtrim(lower(v_cta_url), '/') is distinct from rtrim(lower(v_page), '/') then
      raise exception 'The button must link to the service page' using errcode = 'check_violation';
    end if;
  end if;
  -- One open drafter post per client, channel, service and intent.
  if exists (select 1 from social_posts
             where client_id = v_client and drafter_run_id is not null
               and platform::text = v_target->>'channel' and service_id is not distinct from v_service
               and search_intent = v_target->>'search_intent' and review_status in ('draft', 'in_review')) then
    raise exception 'An open drafted post already exists for this service and intent' using errcode = 'unique_violation';
  end if;

  insert into drafter_runs (client_id, requested_via, requested_by, target, brief_version, brief_hash, brief,
                            claim_ids, runtime, attempt, lint, copy_hash, status)
  values (v_client, coalesce(p->>'requested_via', 'worker'), nullif(p->>'requested_by', '')::uuid, v_target,
          p->>'brief_version', p->>'brief_hash', v_brief, v_claims, p->>'runtime',
          coalesce((p->>'attempt')::int, 1), p->'lint', drafter_copy_hash(v_copy), 'writing')
  returning id into v_run;

  insert into social_posts (client_id, platform, post_type, search_intent, service_id, keyword_id, offer_id,
                            cta_type, cta_url, copy, crm_facts_only, drafter_run_id)
  values (v_client, (v_target->>'channel')::social_platform, v_target->>'post_type', v_target->>'search_intent',
          v_service, nullif(v_target->'keyword'->>'id', '')::uuid, nullif(v_target->'offer'->>'id', '')::uuid,
          v_cta_type, v_cta_url, v_copy, false, v_run)
  returning id into v_post;

  insert into post_claims (post_id, client_id, claim_id)
  select v_post, v_client, c from unnest(v_claims) c;
  i := 0;
  while i < cardinality(v_assets) loop
    i := i + 1;
    insert into post_assets (post_id, client_id, brand_asset_id, sort_order) values (v_post, v_client, v_assets[i], i);
  end loop;

  update social_posts set review_status = 'in_review' where id = v_post returning review_task_id into v_task;
  update drafter_runs set status = 'submitted', post_id = v_post where id = v_run;

  return jsonb_build_object('run_id', v_run, 'post_id', v_post, 'review_task_id', v_task);
end $$;
revoke all on function drafter_write(jsonb) from public, anon, authenticated;
grant execute on function drafter_write(jsonb) to service_role;

-- ── 7. Verify ───────────────────────────────────────────────────────────────
do $$
begin
  if has_table_privilege('anon', 'public.drafter_runs', 'select')
     or has_table_privilege('authenticated', 'public.drafter_runs', 'insert,update,delete') then
    raise exception '0047: grants on drafter_runs are wider than intended';
  end if;
  if has_function_privilege('anon', 'public.client_intelligence_input(uuid)', 'execute') then
    raise exception '0047: anon can call client_intelligence_input';
  end if;
  if has_function_privilege('authenticated', 'public.drafter_write(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.drafter_write(jsonb)', 'execute') then
    raise exception '0047: drafter_write is callable over the API by a non-service role';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname in ('drafter_caller_is_service', 'drafter_session_active', 'drafter_caller_is_superuser',
                        'drafter_copy_hash', 'drafter_runs_guard', 'social_posts_drafter_guard', 'post_links_drafter_guard')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
  ) then
    raise exception '0047: an internal drafter function is callable over the API';
  end if;
  if exists (select 1 from pg_views where schemaname = 'public' and viewname like 'portal\_%'
             and definition ilike '%drafter_runs%') then
    raise exception '0047: a portal view reads drafter_runs';
  end if;
end $$;
