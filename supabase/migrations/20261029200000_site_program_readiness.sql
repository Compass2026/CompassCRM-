-- Site-program Strategy and Content Readiness (COMPASS-2027-ROADMAP P1.4a,
-- Executive OS 81bb73a8). Read-only. Needs 20261028222909_keyword_owner_resolver
-- and 20261029170000_client_onboarding_checklist. Sandbox suite:
-- supabase/tests/sandbox/site_program_readiness.test.sql. Rules and reason
-- codes: docs/site-program-readiness.md.
--
-- One report per client, one entry per site program (each brand site of a
-- multi-brand client, else the client): Gate B "Strategy Ready" and Gate C
-- "Content Ready". Gate C means the evidence for safe drafting is in place.
-- It never permits publishing: approval, destination and receipts stay with
-- the existing gates.
--
--   Gate B  ready | not_verified | blocked
--           an approved site Core 50 (exactly 50 active, intent-labelled
--           keywords), every keyword with one usable owner page per
--           keyword_owner() (holds, related service, owner page live within
--           45 days, structured market), and every place the keyword names
--           tied to a recorded market.
--   Gate C  ready | limited | not_verified | blocked
--           Gate B ready, the program's brand approved, an approved service,
--           usable claims, and real own-work proof. Missing proof is
--           "limited", not "blocked": content that needs no project proof
--           can still be drafted with accurately labelled assets, and each
--           draft's own claim / asset gates still apply.
--
-- Nothing is green by omission:
--   * A place named only in the keyword text ("interior designer troy il")
--     is found here, in SQL, against place_names. Unrecorded place →
--     blocked; recorded market but no keywords.market_id / city →
--     not_verified. The place reference must be exactly place-names-v1
--     (source sha256, row count and row digest, place_reference_status());
--     a missing, partial, extended or altered reference → every keyword is
--     not_verified (geography_unassessed).
--   * Existing content promoting a held offering is counted by
--     promotion_hold_conflict_counts(), a team-readable twin of
--     promotion_hold_conflicts(). Known conflicts → Gate C limited;
--     unreadable → Gate C not_verified (hold_conflicts_unverified).
--   * Claims and brand_assets carry no site. For a multi-brand client they
--     are reported with scope 'client' and the site-level figures are null
--     (claims_client_scope → not_verified, proof_client_scope → limited).
--   * Unknown figures are null, never 0.
--
-- place_names is reference data (public US place names from
-- src/data/us-cities.json), loaded by the data step
-- supabase/seeds/place-names-v1.sql, never by this migration. It is a data
-- table only: it changes no existing gate.
--
-- Writes nothing: site_program_readiness is STABLE (PostgreSQL refuses any
-- data change inside it) and security invoker under the caller's RLS.
-- Rollback: supabase/rollback/20261029200000_site_program_readiness.down.sql.

-- ── 1. Place reference ──────────────────────────────────────────────────────
-- normPlace() in supabase/functions/authority/urls.ts, in SQL: lower case,
-- apostrophes dropped, "st" / "st." → "saint", everything else not a letter
-- or digit → one space.
create function core_place_norm(p_text text) returns text
language sql immutable set search_path = pg_catalog as $$
  select nullif(btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(p_text, '')),
           '[''’]', '', 'g'), '\mst\M\.?', 'saint', 'g'), '[^a-z0-9]+', ' ', 'g')), '')
$$;
revoke all on function core_place_norm(text) from public, anon;
grant execute on function core_place_norm(text) to authenticated, service_role;

create function core_us_states() returns table (code text, name text)
language sql immutable set search_path = pg_catalog as $$
  values ('AL','alabama'),('AK','alaska'),('AZ','arizona'),('AR','arkansas'),('CA','california'),('CO','colorado'),
         ('CT','connecticut'),('DE','delaware'),('DC','district of columbia'),('FL','florida'),('GA','georgia'),
         ('HI','hawaii'),('ID','idaho'),('IL','illinois'),('IN','indiana'),('IA','iowa'),('KS','kansas'),
         ('KY','kentucky'),('LA','louisiana'),('ME','maine'),('MD','maryland'),('MA','massachusetts'),
         ('MI','michigan'),('MN','minnesota'),('MS','mississippi'),('MO','missouri'),('MT','montana'),
         ('NE','nebraska'),('NV','nevada'),('NH','new hampshire'),('NJ','new jersey'),('NM','new mexico'),
         ('NY','new york'),('NC','north carolina'),('ND','north dakota'),('OH','ohio'),('OK','oklahoma'),
         ('OR','oregon'),('PA','pennsylvania'),('RI','rhode island'),('SC','south carolina'),
         ('SD','south dakota'),('TN','tennessee'),('TX','texas'),('UT','utah'),('VT','vermont'),
         ('VA','virginia'),('WA','washington'),('WV','west virginia'),('WI','wisconsin'),('WY','wyoming')
$$;
revoke all on function core_us_states() from public, anon;
grant execute on function core_us_states() to authenticated, service_role;

create table place_name_sources (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_sha256 text not null unique check (source_sha256 ~ '^[0-9a-f]{64}$'),
  names integer not null check (names > 0),
  loaded_at timestamptz not null default now()
);
create table place_names (
  norm text not null check (length(norm) >= 4 and norm = core_place_norm(norm)),
  state text not null check (state ~ '^[A-Z]{2}$'),
  name text not null,
  population integer not null default 0 check (population >= 0),
  primary key (norm, state)
);
alter table place_name_sources enable row level security;
alter table place_names enable row level security;
create policy "team full access" on place_name_sources for all to authenticated
  using ((select is_team())) with check ((select is_team()));
create policy "team full access" on place_names for all to authenticated
  using ((select is_team())) with check ((select is_team()));
-- Read-only to the team; loaded by the owner through the seed.
revoke all on place_name_sources, place_names from public, anon, authenticated;
grant select on place_name_sources, place_names to authenticated, service_role;

-- The one reference site_program_readiness trusts: place-names-v1 exactly as
-- scripts/build-place-names-seed.mjs writes it (tests/site-program-readiness
-- .test.mjs holds these constants to the generator). ok only when the single
-- source row is that source and place_names holds exactly its rows: the
-- count and the md5 of "norm|state|name|population" lines in byte order.
-- problem: missing | source_mismatch | partial | extra_rows | rows_mismatch.
-- The seed requires ok before it commits anything.
create function place_reference_status() returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  with e(version, sha256, names, digest) as (
    values ('place-names-v1'::text, 'baa021dfa1320e8ea4eb6910933ff69fe494e072c4d6cb538fa1b41ed44960b4'::text,
            21316, 'f45e381b2e2dd9a7f01ab1e3159425c0'::text)),
  s as (select count(x.id)::int n, coalesce(bool_and(x.source_sha256 = e.sha256 and x.names = e.names), false) as expected
          from e left join place_name_sources x on true group by e.sha256, e.names),
  p as (select count(*)::int n,
               md5(coalesce(string_agg(norm || '|' || state || '|' || name || '|' || population, E'\n'
                                       order by norm collate "C", state collate "C"), '')) as digest
          from place_names)
  select jsonb_build_object(
           'version', e.version,
           'expected', jsonb_build_object('source_sha256', e.sha256, 'names', e.names, 'digest', e.digest),
           'sources', s.n, 'names', p.n, 'digest', p.digest,
           'ok', s.n = 1 and s.expected and p.n = e.names and p.digest = e.digest,
           'problem', case
             when s.n = 0 and p.n = 0 then 'missing'
             when s.n <> 1 or not s.expected then 'source_mismatch'
             when p.n < e.names then 'partial'
             when p.n > e.names then 'extra_rows'
             when p.digest <> e.digest then 'rows_mismatch'
           end)
    from e, s, p
$$;
revoke all on function place_reference_status() from public, anon;
grant execute on function place_reference_status() to authenticated, service_role;

-- Places a text names, longest span first; a span inside a longer one is
-- dropped ("lake saint louis", not also "saint louis"). A gazetteer word
-- counts as a place only when the text says so or it is plausible for the
-- program, so a roofer's "christmas lights" is not Christmas, FL:
--   state_named    the place's own state follows it ("troy il", "dallas texas")
--   program_state  the place is in one of p_states (the client's state, its
--                  locations' and the program's markets' states)
--   major_city     population ≥ 100,000 anywhere ("forklift training atlanta")
-- p_exclude: single words never read as a place (the client's and brand
-- names, normalized).
create function core_places_in(p_text text, p_states text[] default '{}', p_exclude text[] default '{}')
returns table (place text, state text, norm text, basis text, pos int, words int)
language sql stable set search_path = public, pg_temp as $$
  with w as (select string_to_array(core_place_norm(p_text), ' ') a),
  g as (
    select i, n, array_to_string(w.a[i:i + n - 1], ' ') gram, w.a
      from w, generate_series(1, coalesce(cardinality(w.a), 0)) i, generate_series(1, 5) n
     where i + n - 1 <= cardinality(w.a)),
  h as (
    select g.i, g.n, p.name, p.state, p.norm, p.population,
           case
             when g.a[g.i + g.n] = lower(p.state)
               or array_to_string(g.a[g.i + g.n : g.i + g.n + cardinality(string_to_array(s.name, ' ')) - 1], ' ') = s.name
               then 'state_named'
             when p.state = any(coalesce(p_states, '{}')) then 'program_state'
             when p.population >= 100000 then 'major_city'
           end as basis
      from g
      join place_names p on p.norm = g.gram
      join core_us_states() s on s.code = p.state
     where not (g.n = 1 and g.gram = any(coalesce(p_exclude, '{}')))),
  b as (
    select distinct on (h.i, h.n) h.* from h where h.basis is not null
     order by h.i, h.n, (h.basis = 'state_named') desc, (h.basis = 'program_state') desc, h.population desc, h.state)
  select b.name, b.state, b.norm, b.basis, b.i, b.n from b
   where not exists (select 1 from b o where (o.i, o.n) <> (b.i, b.n) and o.i <= b.i and o.i + o.n >= b.i + b.n)
   order by b.i
$$;
revoke all on function core_places_in(text, text[], text[]) from public, anon;
grant execute on function core_places_in(text, text[], text[]) to authenticated, service_role;

-- ── 2. Held offerings in existing content, team-readable ─────────────────────
-- promotion_hold_conflicts() (20261029013051) counted by kind. A signed-in
-- teammate cannot run the original: it calls content_draft_program() and
-- content_draft_hold_text(), which 20261029013051 deliberately keeps from
-- authenticated. Their bodies are inlined here verbatim instead of widening
-- those grants; everything else is the same expression over the same rows,
-- under the caller's RLS. The sandbox suite proves the counts equal for
-- every kind and pins the md5 of the three canonical definitions, so a later
-- change to any of them fails CI until this twin is reviewed. Counts only:
-- no copy, title or id leaves the function.
create function promotion_hold_conflict_counts(p_client_id uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  with x(kind, problem) as (
    select 'social_post'::text,
           core_copy_hold(p.client_id, coalesce(core_site_of_service(p.client_id, p.service_id),
                          case when p.keyword_id is not null then core_site_of_keyword(p.client_id, p.keyword_id) end),
                          concat_ws(E'\x1f', p.copy, (select k.keyword from keywords k where k.id = p.keyword_id)),
                          p.service_id, nullif(btrim(coalesce(p.cta_url, '')), ''))
    from social_posts p where p.client_id = p_client_id and p.review_status <> 'rejected'
    union all
    select 'content_draft',
           core_copy_hold(d.client_id,
                          -- content_draft_program(d)
                          coalesce((select i.brand_workspace_id from content_plan_items i where i.id = d.plan_item_id),
                                   core_site_of_service(d.client_id, d.service_id),
                                   case when d.keyword_id is not null then core_site_of_keyword(d.client_id, d.keyword_id) end),
                          -- content_draft_hold_text(d)
                          concat_ws(E'\x1f', d.topic, d.primary_keyword, d.title, d.meta_title, d.meta_description, d.h1, d.tldr, d.slug,
                                    d.body_markdown, core_hold_json_text(d.cta), core_hold_json_text(d.structured_data),
                                    (select k.keyword from keywords k where k.id = d.keyword_id)),
                          d.service_id, nullif(btrim(coalesce(d.target_url, '')), ''))
    from content_drafts d where d.client_id = p_client_id and d.status <> 'rejected'
    union all
    select 'content_post',
           core_copy_hold(c.client_id, null, concat_ws(E'\x1f', c.title, c.url), null, nullif(btrim(coalesce(c.url, '')), ''))
    from content_posts c where c.client_id = p_client_id
    union all
    select 'content_plan_item',
           core_copy_hold(i.client_id, i.brand_workspace_id,
                          concat_ws(E'\x1f', i.topic, (select k.keyword from keywords k where k.id = i.keyword_id)),
                          i.service_id, nullif(btrim(coalesce(i.target_url, '')), ''))
    from content_plan_items i where i.client_id = p_client_id and i.content_post_id is null and i.social_post_id is null),
  y as (select kind, count(*)::int n from x where problem is not null group by kind)
  select jsonb_build_object('total', coalesce(sum(n), 0)::int, 'by_kind', coalesce(jsonb_object_agg(kind, n), '{}'::jsonb)) from y
$$;
revoke all on function promotion_hold_conflict_counts(uuid) from public, anon;
grant execute on function promotion_hold_conflict_counts(uuid) to authenticated, service_role;

-- ── 3. The report ───────────────────────────────────────────────────────────
-- site_program_readiness(client) → {client_id, client, as_of, version,
--   multi_brand, geography, programs: [...]}. One keyword_owner() call per
--   list keyword; the post / blog / refresh verdicts are its purpose tail
--   (core_owner_allows, keyword_already_owned), proven equal to direct calls
--   in the sandbox suite.
create function site_program_readiness(p_client_id uuid) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  c clients;
  prog record;
  l core_keyword_lists;
  la core_keyword_lists;
  v_multi boolean;
  v_geo boolean;
  v_geo_status jsonb;
  v_programs jsonb := '[]'::jsonb;
  v_exclude text[];
  v_states text[];
  v_claims jsonb;
  v_usable int;
  v_proof jsonb;
  v_own_work int;
  v_run record;
  v_conflicts int;
  v_conflicts_by jsonb;
  v_kw jsonb;
  v_pages jsonb;
  v_b jsonb;
  v_c jsonb;
  v_warn jsonb;
  v_b_status text;
  v_c_status text;
  v_services int;
  v_brand_ok boolean;
begin
  if current_user in ('authenticated', 'anon') and not coalesce((select is_team()), false) then
    raise exception 'Site-program readiness is for the Compass team.' using errcode = '42501';
  end if;
  select * into c from clients where id = p_client_id;
  if c.id is null then
    raise exception 'No client %.', p_client_id using errcode = 'P0002';
  end if;
  v_multi := exists (select 1 from client_brand_workspaces w where w.client_id = c.id);
  v_geo_status := place_reference_status();
  v_geo := coalesce((v_geo_status->>'ok')::boolean, false);

  -- Client-wide evidence, read once. Claims and assets carry no site.
  select jsonb_build_object(
           'usable', count(*) filter (where status::text = 'confirmed' or (status::text = 'sourced' and nullif(btrim(source), '') is not null)),
           'confirmed', count(*) filter (where status::text = 'confirmed'),
           'sourced', count(*) filter (where status::text = 'sourced'),
           'sourced_without_source', count(*) filter (where status::text = 'sourced' and nullif(btrim(source), '') is null),
           'unverified', count(*) filter (where status::text = 'unverified'),
           'oldest_recorded', min(created_at)::date, 'newest_recorded', max(created_at)::date,
           'newest_confirmed', max(confirmed_on)::date,
           'review_dates', null),
         count(*) filter (where status::text = 'confirmed' or (status::text = 'sourced' and nullif(btrim(source), '') is not null))
    into v_claims, v_usable
    from claims where client_id = c.id;
  select jsonb_build_object(
           'photos', count(*) filter (where kind::text = 'photo'),
           'own_work_approved', count(*) filter (where kind::text = 'photo' and depicts_own_work
                                                  and creative_use = 'approved' and creative_reviewed_at is not null),
           'creative_approved', count(*) filter (where creative_use = 'approved' and creative_reviewed_at is not null),
           'unreviewed', count(*) filter (where creative_reviewed_at is null),
           'newest_review', max(creative_reviewed_at)::date),
         count(*) filter (where kind::text = 'photo' and depicts_own_work and creative_use = 'approved' and creative_reviewed_at is not null)
    into v_proof, v_own_work
    from brand_assets where client_id = c.id;
  select r.status, r.engine_version, coalesce(r.finished_at, r.created_at) as at into v_run
    from authority_runs r where r.client_id = c.id and r.status in ('completed', 'degraded')
   order by coalesce(r.finished_at, r.created_at) desc limit 1;
  -- Unreadable (a grant changed under it) → unknown, never 0, and Gate C
  -- cannot be ready.
  begin
    v_conflicts_by := promotion_hold_conflict_counts(c.id);
    v_conflicts := (v_conflicts_by->>'total')::int;
  exception when insufficient_privilege then
    v_conflicts := null;
    v_conflicts_by := null;
  end;

  for prog in
    select w.id, w.name, w.website_url as site_url, w.status::text as brand_status, w.service_ids, w.blog_site_id as site_id
      from client_brand_workspaces w where w.client_id = c.id
    union all
    select null::uuid, c.name, c.website_url, null, null,
           (select s.id from sites s where s.client_id = c.id order by s.created_at, s.id limit 1)
     where not v_multi
    order by 2, 1
  loop
    -- The list: the newest approved version, else the newest proposal (shown,
    -- never green). Approval is read from status / approved_at only.
    select * into la from core_keyword_lists x
     where x.client_id = c.id and x.brand_workspace_id is not distinct from prog.id and x.status = 'approved'
     order by x.version desc limit 1;
    select * into l from core_keyword_lists x
     where x.client_id = c.id and x.brand_workspace_id is not distinct from prog.id
       and (la.id is null or x.id = la.id)
     order by x.version desc limit 1;

    v_exclude := array(select distinct core_place_norm(t) from regexp_split_to_table(lower(c.name || ' ' || coalesce(prog.name, '')), '[^a-z'']+') t
                        where length(replace(t, '''', '')) >= 4);
    v_states := array(select distinct x from (
                  select upper(btrim(c.state)) x
                  union all select upper(btrim(lo.state)) from locations lo where lo.client_id = c.id and lo.is_active
                  union all select upper(btrim(m.state)) from client_service_markets m
                   where m.client_id = c.id and (m.brand_workspace_id is null or m.brand_workspace_id is not distinct from prog.id)) s
                  where x ~ '^[A-Z]{2}$');

    -- One row per list member, with its owner and geography.
    with members as (
      select u.ord, u.kid, k.id, k.keyword, k.intent, k.is_active, k.city, k.market_id
        from unnest(coalesce(l.keyword_ids, '{}')) with ordinality u(kid, ord)
        left join keywords k on k.id = u.kid and k.client_id = c.id),
    owned as materialized (
      select m.*, case when m.id is not null and m.is_active then keyword_owner(c.id, prog.id, m.id, null) end as o
        from members m),
    geo as (
      select o.*,
             (select jsonb_agg(jsonb_build_object('place', p.place, 'state', p.state, 'basis', p.basis,
                       'market', exists (select 1 from client_service_markets mk
                                          where mk.client_id = c.id and mk.status = 'approved'
                                            and (mk.brand_workspace_id is null or mk.brand_workspace_id is not distinct from prog.id)
                                            and core_place_norm(mk.city) = p.norm
                                            and (nullif(btrim(mk.state), '') is null or upper(btrim(mk.state)) = p.state)))
                       order by p.pos)
                from core_places_in(o.keyword, v_states, v_exclude) p) as places,
             coalesce((select mk.city from client_service_markets mk where mk.id = o.market_id and mk.client_id = c.id),
                      nullif(btrim(o.city), '')) as structured_city
        from owned o where o.id is not null and o.is_active),
    judged as (
      select g.*,
             case when g.o->>'problem_code' is not null then g.o->>'problem_code'
                  when not core_owner_allows(g.o->>'role', 'post', g.intent) then 'owner_role_not_allowed' end as post_code,
             case when g.o->>'problem_code' is not null then g.o->>'problem_code'
                  when g.o->>'role' = 'blog' then 'keyword_already_owned'
                  when not core_owner_allows(g.o->>'role', 'blog', g.intent) then 'owner_role_not_allowed' end as blog_code,
             case when g.o->>'problem_code' is not null then g.o->>'problem_code'
                  when not core_owner_allows(g.o->>'role', 'refresh', g.intent) then 'owner_role_not_allowed' end as refresh_code,
             case
               when not v_geo then 'unassessed'
               when g.structured_city is not null then
                 case when exists (select 1 from jsonb_array_elements(coalesce(g.places, '[]')) e
                                    where core_place_norm(e->>'place') is distinct from core_place_norm(g.structured_city))
                      then 'mismatch' else 'structured' end
               when g.places is null then 'none'
               when exists (select 1 from jsonb_array_elements(g.places) e where not (e->>'market')::boolean) then 'without_market'
               else 'text_only'
             end as geography
        from geo g)
    select jsonb_build_object(
             'members', (select count(*) from members),
             'distinct', (select count(distinct kid) from members),
             'missing', (select count(*) from members where id is null),
             'inactive', (select count(*) from members where id is not null and not is_active),
             'intent_missing', (select count(*) from members where id is not null and is_active and intent is null),
             'intents', jsonb_build_object(
               'informational', count(*) filter (where intent = 'informational'),
               'commercial', count(*) filter (where intent = 'commercial'),
               'transactional', count(*) filter (where intent = 'transactional'),
               'navigational', count(*) filter (where intent = 'navigational'),
               'none', count(*) filter (where intent is null)),
             'owners', jsonb_build_object(
               'post', jsonb_build_object('ok', count(*) filter (where post_code is null),
                 'problems', coalesce((select jsonb_object_agg(x.code, x.n) from (select post_code code, count(*) n from judged where post_code is not null group by 1) x), '{}')),
               'blog', jsonb_build_object('ok', count(*) filter (where blog_code is null),
                 'problems', coalesce((select jsonb_object_agg(x.code, x.n) from (select blog_code code, count(*) n from judged where blog_code is not null group by 1) x), '{}')),
               'refresh', jsonb_build_object('ok', count(*) filter (where refresh_code is null),
                 'problems', coalesce((select jsonb_object_agg(x.code, x.n) from (select refresh_code code, count(*) n from judged where refresh_code is not null group by 1) x), '{}'))),
             'roles', coalesce((select jsonb_object_agg(x.r, x.n) from (select coalesce(o->>'role', 'none') r, count(*) n from judged group by 1) x), '{}'),
             'geography', jsonb_build_object(
               'structured', count(*) filter (where geography = 'structured'),
               'none', count(*) filter (where geography = 'none'),
               'text_only', count(*) filter (where geography = 'text_only'),
               'without_market', count(*) filter (where geography = 'without_market'),
               'mismatch', count(*) filter (where geography = 'mismatch'),
               'unassessed', count(*) filter (where geography = 'unassessed')),
             'problems', coalesce((select jsonb_agg(jsonb_build_object('keyword_id', j.id, 'keyword', j.keyword,
                                     'owner', j.post_code, 'owner_detail', j.o->>'problem',
                                     'geography', case when j.geography in ('text_only', 'without_market', 'mismatch') then j.geography end,
                                     'places', j.places, 'structured_city', j.structured_city) order by j.ord)
                                     from judged j
                                    where j.post_code is not null
                                       or j.geography in ('text_only', 'without_market', 'mismatch')), '[]'),
             'urls', coalesce((select jsonb_agg(jsonb_build_object('url', x.url, 'keywords', x.n) order by x.n desc, x.url)
                                 from (select o->>'url' url, count(*) n from judged where o->>'url' is not null group by 1) x), '[]'))
      into v_kw
      from judged;

    -- Owner pages: the resolver's own reading of the latest check (a http
    -- soft_404 defers to the latest rendered check).
    with u as (select e->>'url' url, (e->>'keywords')::int n from jsonb_array_elements(v_kw->'urls') e),
    chk as (
      select u.url, u.n, ck.verdict, ck.checked_at
        from u
        left join lateral (
          select x.verdict, x.checked_at from (
            select h.id, (h.method = 'http' and h.verdict = 'soft_404') as soft
              from owner_page_checks h where h.client_id = c.id and h.url_norm = u.url
             order by h.checked_at desc, h.id desc limit 1) f
          cross join lateral (
            select r.verdict, r.checked_at from owner_page_checks r
             where r.client_id = c.id and r.url_norm = u.url
               and (r.id = f.id or (f.soft and r.method = 'rendered'))
             order by (r.method = 'rendered') desc, r.checked_at desc, r.id desc limit 1) x) ck on true)
    select jsonb_build_object(
             'urls', count(*),
             'live', count(*) filter (where verdict = 'live' and checked_at >= now() - interval '45 days'),
             'stale', count(*) filter (where verdict = 'live' and checked_at < now() - interval '45 days'),
             'unchecked', count(*) filter (where verdict is null),
             'not_live', coalesce(jsonb_agg(jsonb_build_object('url', url, 'verdict', verdict, 'checked_on', checked_at::date))
                                    filter (where verdict is not null and verdict <> 'live'), '[]'),
             'oldest_check', min(checked_at)::date,
             'top_url', (select u2.url from u u2 order by u2.n desc, u2.url limit 1),
             'top_keywords', max(n),
             'top_share', case when (v_kw->>'members')::int > 0 then round(max(n)::numeric / (v_kw->>'members')::int, 2) end)
      into v_pages
      from chk;

    -- Gate B.
    v_b := '[]'::jsonb;
    v_warn := '[]'::jsonb;
    if nullif(btrim(prog.site_url), '') is null then
      v_b := v_b || jsonb_build_object('code', 'program_site_missing', 'severity', 'blocked');
    end if;
    if l.id is null then
      v_b := v_b || jsonb_build_object('code', 'list_missing', 'severity', 'blocked');
    else
      if l.status <> 'approved' then
        v_b := v_b || jsonb_build_object('code', 'list_not_approved', 'severity', 'blocked', 'detail', 'v' || l.version || ' is ' || l.status);
      end if;
      if (v_kw->>'distinct')::int <> 50 or (v_kw->>'members')::int <> 50 then
        v_b := v_b || jsonb_build_object('code', 'list_size', 'severity', 'blocked', 'count', (v_kw->>'distinct')::int);
      end if;
      if (v_kw->>'missing')::int > 0 then
        v_b := v_b || jsonb_build_object('code', 'keyword_missing', 'severity', 'blocked', 'count', (v_kw->>'missing')::int);
      end if;
      if (v_kw->>'inactive')::int > 0 then
        v_b := v_b || jsonb_build_object('code', 'keyword_inactive', 'severity', 'blocked', 'count', (v_kw->>'inactive')::int);
      end if;
      if (v_kw->>'intent_missing')::int > 0 then
        v_b := v_b || jsonb_build_object('code', 'intent_missing', 'severity', 'blocked', 'count', (v_kw->>'intent_missing')::int);
      end if;
      v_b := v_b || coalesce((
        select jsonb_agg(jsonb_build_object('code', 'owner:' || e.key,
                 'severity', case when e.key = 'page_not_verified' then 'not_verified' else 'blocked' end,
                 'count', e.value::int) order by e.key)
          from jsonb_each(v_kw->'owners'->'post'->'problems') e), '[]');
      v_b := v_b || coalesce((
        select jsonb_agg(jsonb_build_object('code', 'place_' || x.k,
                 'severity', case x.k when 'without_market' then 'blocked' else 'not_verified' end,
                 'count', x.n) order by x.k)
          from (select e.key k, e.value::int n from jsonb_each(v_kw->'geography') e
                 where e.key in ('text_only', 'without_market', 'mismatch') and e.value::int > 0) x), '[]');
      if (v_kw->'geography'->>'unassessed')::int > 0 then
        v_b := v_b || jsonb_build_object('code', 'geography_unassessed', 'severity', 'not_verified',
                                          'count', (v_kw->'geography'->>'unassessed')::int,
                                          'detail', 'The place reference is not place-names-v1 as generated ('
                                                    || coalesce(v_geo_status->>'problem', 'unknown') || '; supabase/seeds/place-names-v1.sql).');
      end if;
      v_warn := v_warn || coalesce((
        select jsonb_agg(jsonb_build_object('code', 'intent_absent', 'detail', i) order by i)
          from unnest(array['informational', 'commercial', 'transactional', 'navigational']) i
         where (v_kw->'intents'->>i)::int = 0), '[]');
      if (v_pages->>'top_share')::numeric >= 0.5 and (v_kw->>'members')::int >= 10 then
        v_warn := v_warn || jsonb_build_object('code', 'owner_concentration',
                   'detail', (v_pages->>'top_keywords') || ' of ' || (v_kw->>'members') || ' on ' || (v_pages->>'top_url'));
      end if;
      if (v_kw->'owners'->'blog'->>'ok')::int < 8 then
        v_warn := v_warn || jsonb_build_object('code', 'blog_supply_low', 'count', (v_kw->'owners'->'blog'->>'ok')::int);
      end if;
    end if;
    v_b_status := case when exists (select 1 from jsonb_array_elements(v_b) e where e->>'severity' = 'blocked') then 'blocked'
                       when jsonb_array_length(v_b) > 0 then 'not_verified' else 'ready' end;

    -- Gate C.
    v_c := '[]'::jsonb;
    if v_b_status <> 'ready' then
      v_c := v_c || jsonb_build_object('code', 'strategy_not_ready', 'severity', v_b_status);
    end if;
    v_brand_ok := case when v_multi then prog.brand_status = 'approved'
                       else exists (select 1 from brand_boards b where b.client_id = c.id and b.status::text = 'approved') end;
    if not v_brand_ok then
      v_c := v_c || jsonb_build_object('code', 'brand_not_approved', 'severity', 'blocked');
    end if;
    select count(*) into v_services from services s
     where s.client_id = c.id and s.status::text = 'approved' and (not v_multi or s.id = any(coalesce(prog.service_ids, '{}')));
    if v_services = 0 then
      v_c := v_c || jsonb_build_object('code', 'services_missing', 'severity', 'blocked');
    end if;
    if v_usable = 0 then
      v_c := v_c || jsonb_build_object('code', 'claims_missing', 'severity', 'blocked');
    elsif v_multi then
      v_c := v_c || jsonb_build_object('code', 'claims_client_scope', 'severity', 'not_verified',
                                        'detail', 'Claims carry no brand site; none is verified for this site.');
    elsif v_usable < 3 then
      v_c := v_c || jsonb_build_object('code', 'claims_thin', 'severity', 'limited', 'count', v_usable);
    end if;
    if v_multi then
      v_c := v_c || jsonb_build_object('code', 'proof_client_scope', 'severity', 'limited',
                                        'detail', 'Assets carry no brand site; no own-work proof is verified for this site.');
    elsif v_own_work = 0 then
      v_c := v_c || jsonb_build_object('code', 'proof_own_work_missing', 'severity', 'limited');
    elsif v_own_work < 6 then
      v_c := v_c || jsonb_build_object('code', 'proof_thin', 'severity', 'limited', 'count', v_own_work);
    end if;
    if v_usable > 0 then
      v_warn := v_warn || jsonb_build_object('code', 'claims_no_review_date',
                 'detail', 'Claims record no expiry or review date yet (W1 / P0.3).');
      if (v_claims->>'confirmed')::int = 0 then
        v_warn := v_warn || jsonb_build_object('code', 'claims_unconfirmed');
      end if;
    end if;
    -- Existing content promoting a held offering (client-wide: posts and
    -- drafts carry no reliable site). Known → limited: each item is refused
    -- at its next step and new drafts are checked anyway. Unknown → not
    -- verified.
    if v_conflicts is null then
      v_c := v_c || jsonb_build_object('code', 'hold_conflicts_unverified', 'severity', 'not_verified',
               'detail', 'promotion_hold_conflict_counts() is not readable by this caller.');
    elsif v_conflicts > 0 then
      v_c := v_c || jsonb_build_object('code', 'hold_conflicts_open', 'severity', 'limited', 'count', v_conflicts,
               'detail', (select string_agg(k.key || ' ' || k.value, ', ' order by k.key) from jsonb_each_text(v_conflicts_by->'by_kind') k));
    end if;
    if v_run.at is null then
      v_warn := v_warn || jsonb_build_object('code', 'authority_never_run');
    elsif l.status = 'approved' and v_run.at < l.approved_at then
      v_warn := v_warn || jsonb_build_object('code', 'authority_predates_list');
    end if;
    v_c_status := case when exists (select 1 from jsonb_array_elements(v_c) e where e->>'severity' = 'blocked') then 'blocked'
                       when exists (select 1 from jsonb_array_elements(v_c) e where e->>'severity' = 'not_verified') then 'not_verified'
                       when jsonb_array_length(v_c) > 0 then 'limited' else 'ready' end;

    v_programs := v_programs || jsonb_build_object(
      'program_id', prog.id,
      'name', prog.name,
      'site_url', prog.site_url,
      'site_id', prog.site_id,
      'list', case when l.id is null then null else jsonb_build_object(
                'id', l.id, 'version', l.version, 'status', l.status, 'approved', l.status = 'approved',
                'approved_at', l.approved_at, 'size', (v_kw->>'distinct')::int) end,
      'newer_proposal', (select jsonb_build_object('id', x.id, 'version', x.version, 'status', x.status, 'size', cardinality(x.keyword_ids))
                           from core_keyword_lists x
                          where x.client_id = c.id and x.brand_workspace_id is not distinct from prog.id
                            and x.status <> 'approved' and x.version > coalesce(la.version, 0) and la.id is not null
                          order by x.version desc limit 1),
      'intents', case when l.id is null then null else v_kw->'intents' end,
      'owners', case when l.id is null then null else v_kw->'owners' end,
      'roles', case when l.id is null then null else v_kw->'roles' end,
      'owner_pages', case when l.id is null then null else v_pages end,
      'geography', case when l.id is null then null else (v_kw->'geography') || jsonb_build_object('assessed', v_geo) end,
      'markets', jsonb_build_object(
         'recorded', (select count(*) from client_service_markets m where m.client_id = c.id
                       and (m.brand_workspace_id is null or m.brand_workspace_id is not distinct from prog.id)),
         'approved', (select count(*) from client_service_markets m where m.client_id = c.id and m.status = 'approved'
                       and (m.brand_workspace_id is null or m.brand_workspace_id is not distinct from prog.id))),
      'holds', jsonb_build_object(
         'active', (select count(*) from client_promotion_holds h where h.client_id = c.id and h.status = 'held'
                     and (h.brand_workspace_id is null or h.brand_workspace_id is not distinct from prog.id)),
         'open_conflicts_client', v_conflicts,
         'open_conflicts_by_kind', v_conflicts_by->'by_kind'),
      'brand', jsonb_build_object('approved', v_brand_ok, 'source', case when v_multi then 'brand_site' else 'brand_board' end),
      'services_approved', v_services,
      'claims', v_claims || jsonb_build_object('scope', 'client',
                  'site_usable', case when v_multi then null else v_usable end),
      'proof', v_proof || jsonb_build_object('scope', 'client',
                  'site_own_work_approved', case when v_multi then null else v_own_work end),
      'authority', jsonb_build_object('scope', 'client', 'last_run_at', v_run.at, 'status', v_run.status,
                  'engine_version', v_run.engine_version,
                  'age_days', case when v_run.at is not null then (now()::date - v_run.at::date) end,
                  'predates_list_approval', case when v_run.at is not null and l.status = 'approved' then v_run.at < l.approved_at end),
      'onboarding', (select jsonb_build_object(
                        'client_level', coalesce(jsonb_object_agg(x.status, x.n) filter (where x.lvl = 'client'), '{}'),
                        'site_level', coalesce(jsonb_object_agg(x.status, x.n) filter (where x.lvl = 'site'), '{}'))
                       from (select case when i.site_id is null then 'client' else 'site' end lvl, i.status, count(*) n
                               from client_onboarding_items i
                              where i.client_id = c.id and i.location_id is null
                                and (i.site_id is null or i.site_id is not distinct from prog.site_id)
                              group by 1, 2) x),
      'problems', case when l.id is null then '[]'::jsonb else v_kw->'problems' end,
      'gate_b', jsonb_build_object('status', v_b_status, 'reasons', v_b),
      'gate_c', jsonb_build_object('status', v_c_status, 'reasons', v_c),
      'warnings', v_warn);
  end loop;

  return jsonb_build_object(
    'version', 'site-program-readiness/v1',
    'client_id', c.id,
    'client', c.name,
    'as_of', now(),
    'multi_brand', v_multi,
    'geography', jsonb_build_object('assessed', v_geo, 'reference', v_geo_status,
       'sources', (select coalesce(jsonb_agg(jsonb_build_object('source', s.source, 'sha256', s.source_sha256,
                                    'names', s.names, 'loaded_at', s.loaded_at) order by s.loaded_at), '[]')
                     from place_name_sources s)),
    'programs', v_programs);
end $$;
revoke all on function site_program_readiness(uuid) from public, anon;
grant execute on function site_program_readiness(uuid) to authenticated, service_role;

-- ── 4. Verify ───────────────────────────────────────────────────────────────
do $$
begin
  if (select provolatile from pg_proc where oid = 'public.site_program_readiness(uuid)'::regprocedure) <> 's'
     or (select prosecdef from pg_proc where oid = 'public.site_program_readiness(uuid)'::regprocedure) then
    raise exception 'site_program_readiness must be stable and security invoker';
  end if;
  if (select bool_or(provolatile <> 's' or prosecdef) from pg_proc
       where oid in ('public.place_reference_status()'::regprocedure, 'public.promotion_hold_conflict_counts(uuid)'::regprocedure)) then
    raise exception 'place_reference_status / promotion_hold_conflict_counts must be stable and security invoker';
  end if;
  if (place_reference_status()->>'ok')::boolean and not exists (select 1 from place_name_sources) then
    raise exception 'place_reference_status: ok with nothing loaded';
  end if;
  if has_function_privilege('authenticated', 'content_draft_program(content_drafts)', 'execute')
     or has_function_privilege('authenticated', 'content_draft_hold_text(content_drafts)', 'execute') then
    raise exception 'the content draft hold helpers must stay revoked from authenticated';
  end if;
  if has_function_privilege('anon', 'public.site_program_readiness(uuid)', 'execute')
     or has_function_privilege('anon', 'public.promotion_hold_conflict_counts(uuid)', 'execute')
     or has_function_privilege('anon', 'public.place_reference_status()', 'execute')
     or has_table_privilege('anon', 'public.place_names', 'select')
     or has_table_privilege('authenticated', 'public.place_names', 'insert, update, delete')
     or has_table_privilege('authenticated', 'public.place_name_sources', 'insert, update, delete') then
    raise exception 'site_program_readiness grants';
  end if;
end $$;
