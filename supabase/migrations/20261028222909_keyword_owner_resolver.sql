-- Keyword owner page vs related service (Oct 28 2026). Written with its
-- sandbox test (keyword_owner_resolver.test.sql) and the shared fixture
-- tests/fixtures/keyword-owner-cases.json, which the TypeScript resolver
-- (supabase/functions/authority/keyword-owner.ts) is tested against too.
-- Needs 20261027191343_weekly_social_slots.
--
-- Until now every gate took a keyword's SERVICE and treated services.page_url
-- as the keyword's page. A city term owned by its city page, a Home or brand
-- term with no service, and a BHG brand-site term with no service were all
-- refused, and the service's primary keyword made every keyword on that
-- service claim the service page. This separates two things:
--
--   owner page       exactly one, explicit: an approved page group whose
--                    primary keyword is the keyword (or an equivalent row of
--                    the SAME site program), the keyword's target_url, or the
--                    page of an approved service whose primary keyword it is.
--                    Two different explicit claims are a conflict, never a
--                    priority order. With no claim, the related service's
--                    page; nothing else (no Home fallback).
--   related service  keywords.service_id: optional, approved, same site.
--
-- and makes the evidence each gate needs explicit:
--
--   client_service_markets  where the business serves (organic content
--                    scope), separate from Business Profile publication
--                    (gbp_location_markets, unchanged). An office is an active
--                    physical location; anything else is a recorded decision
--                    with its source and date, or a signed-in teammate's. A
--                    city page or a bare city string is never proof.
--   keywords.market_id the keyword's market, explicit; a bare keywords.city
--                    resolves only when exactly one market of the site has
--                    that city name.
--   owner_page_checks one row per check of an owner page: final URL, status,
--                    verdict (live / missing / soft_404 / redirected /
--                    wrong_host / unreadable). Unchecked is "not verified",
--                    never "live".
--   client_promotion_holds offerings the business has but does not want
--                    advertised yet (Tom's words and date): no keyword,
--                    supporting child, related service, owner page or CTA
--                    may promote them while held.
--
-- One resolver, keyword_owner(), feeds eligibility, grounding, the list
-- guard, the three review gates, drafter_write, the change (refresh) gate,
-- the slot link, the readiness board and the drafter loader; the drafters'
-- TypeScript resolver reads the same rows (owner_context) and is held to the
-- same fixture. Nothing is approved, published, unheld or rewritten here:
-- existing drafts, posts, approvals and holds are untouched; the new checks
-- run only when work enters review or changes what it is about.
--
-- Rollback (no data loss; nothing here rewrites a row it did not create):
-- restore drafter_write, social_slot_link, social_slot_readiness,
-- core_keyword_eligibility(4), core_keyword_grounding, core_keyword_lists_guard,
-- the three review gates, core_keyword_change_gate, core_keyword_link_once,
-- client_intelligence_for_content(uuid, uuid) and content_plan_board from
-- 20261027191343 / 20261012163631 / 0067, then drop the functions, tables
-- and columns added here.

-- ── 1. URL and text helpers (immutable; the TypeScript twins live in
-- authority/keyword-owner.ts and are held to the same fixture) ─────────────
-- Absolute https/http URL → scheme://host(no www, lower)/path(lower, no
-- trailing slash), query and fragment dropped. A path ("/osage-beach") is
-- resolved against p_site. Anything else → null.
create function core_norm_url(p_url text, p_site text default null) returns text
language sql immutable set search_path = pg_catalog as $$
  with u as (
    select case
      when nullif(btrim(p_url), '') is null then null
      when btrim(p_url) ~ '^/' and btrim(coalesce(p_site, '')) ~* '^https?://[^/?#\s]+'
        then substring(btrim(p_site) from '^[A-Za-z]+://[^/?#\s]+') || btrim(p_url)
      else btrim(p_url) end as v)
  select case when v ~* '^https?://[^/?#\s:]+' then
      lower(substring(v from '^([A-Za-z]+)://')) || '://'
      || regexp_replace(lower(substring(v from '^[A-Za-z]+://([^/?#\s:]+)')), '^www\.', '')
      || regexp_replace(lower(coalesce(substring(v from '^[A-Za-z]+://[^/?#\s]+(/[^?#\s]*)'), '')), '/+$', '')
    end
  from u
$$;
create function core_url_host(p_url text) returns text
language sql immutable set search_path = pg_catalog as $$
  select regexp_replace(lower(substring(btrim(p_url) from '^[A-Za-z]+://([^/?#\s:]+)')), '^www\.', '')
$$;
-- Keyword text as the drafter compares it: lower case, single spaces.
create function core_norm_kw(p_text text) returns text
language sql immutable set search_path = pg_catalog as $$
  select lower(regexp_replace(btrim(coalesce(p_text, '')), '\s+', ' ', 'g'))
$$;
-- Words only, for phrase matching (held offerings).
create function core_norm_words(p_text text) returns text
language sql immutable set search_path = pg_catalog as $$
  select btrim(regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', ' ', 'g'))
$$;
revoke all on function core_norm_url(text, text), core_url_host(text), core_norm_kw(text), core_norm_words(text) from public, anon;
grant execute on function core_norm_url(text, text), core_url_host(text), core_norm_kw(text), core_norm_words(text)
  to authenticated, service_role;

-- ── 2. Service markets (organic scope), keyword market ─────────────────────
create table client_service_markets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  -- null: every site of the client (and the only one for a single-site client)
  brand_workspace_id uuid references client_brand_workspaces(id),
  city text not null check (length(btrim(city)) between 1 and 120),
  state text not null check (state ~ '^[A-Z]{2}$'),
  country text not null default 'US' check (country ~ '^[A-Z]{2}$'),
  status text not null check (status in ('approved', 'held', 'excluded')),
  -- office: an active physical location of the client;
  -- recorded_decision: a person's decision carried forward with its source and date;
  -- teammate: recorded by a signed-in teammate now.
  basis text not null check (basis in ('office', 'recorded_decision', 'teammate')),
  source_ref text not null check (length(btrim(source_ref)) between 1 and 500),
  decided_on date not null,
  recorded_by uuid references team_members(id),
  created_at timestamptz not null default now()
);
create unique index client_service_markets_key on client_service_markets
  (client_id, coalesce(brand_workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(city)), state, country);

create function client_service_markets_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A service market is kept; change its status instead' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.client_id, new.brand_workspace_id, new.city, new.state, new.country, new.basis, new.created_at)
       is distinct from (old.client_id, old.brand_workspace_id, old.city, old.state, old.country, old.basis, old.created_at) then
    raise exception 'A service market''s place and basis do not change; record a new market' using errcode = '42501';
  end if;
  if new.brand_workspace_id is not null and not exists (
       select 1 from client_brand_workspaces w where w.id = new.brand_workspace_id and w.client_id = new.client_id) then
    raise exception 'The brand site belongs to another client' using errcode = '23514';
  end if;
  if new.basis = 'office' and not exists (
       select 1 from locations l where l.client_id = new.client_id and l.is_active and l.is_physical_location
          and lower(btrim(l.city)) = lower(btrim(new.city)) and upper(btrim(coalesce(l.state, ''))) = new.state) then
    raise exception 'An office market is one of the client''s active physical locations' using errcode = '23514';
  end if;
  if new.basis = 'teammate' then
    if not post_caller_is_human() then
      raise exception 'Only a signed-in teammate records a teammate market' using errcode = '42501';
    end if;
    new.recorded_by := task_actor();
  end if;
  return new;
end $$;
revoke all on function client_service_markets_guard() from public, anon, authenticated;
create trigger client_service_markets_guard before insert or update or delete on client_service_markets
  for each row execute function client_service_markets_guard();
alter table client_service_markets enable row level security;
create policy "team service markets" on client_service_markets to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on client_service_markets from public, anon, authenticated;
grant select, insert, update on client_service_markets to authenticated;
grant select on client_service_markets to service_role;

-- Offices: every active physical location is a market of its client.
insert into client_service_markets (client_id, city, state, status, basis, source_ref, decided_on)
select distinct on (l.client_id, lower(btrim(l.city)), upper(btrim(l.state)))
       l.client_id, btrim(l.city), upper(btrim(l.state)), 'approved', 'office',
       'locations ' || l.id || ': active physical location (20261028170000)', current_date
from locations l
where l.is_active and l.is_physical_location and nullif(btrim(l.city), '') is not null
  and upper(btrim(coalesce(l.state, ''))) ~ '^[A-Z]{2}$'
order by l.client_id, lower(btrim(l.city)), upper(btrim(l.state)), l.id;

alter table keywords add column market_id uuid references client_service_markets(id);
create function keywords_market_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.market_id is not null and not exists (
       select 1 from client_service_markets m where m.id = new.market_id and m.client_id = new.client_id) then
    raise exception 'The keyword''s market belongs to another client' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function keywords_market_guard() from public, anon, authenticated;
create trigger keywords_market_guard before insert or update of market_id, client_id on keywords
  for each row execute function keywords_market_guard();

-- ── 3. Owner page checks ────────────────────────────────────────────────────
create table owner_page_checks (
  id bigint generated always as identity primary key,
  client_id uuid not null references clients(id) on delete cascade,
  requested_url text not null check (requested_url ~* '^https?://\S+$'),
  url_norm text not null,
  final_url text,
  http_status integer,
  verdict text not null check (verdict in ('live', 'missing', 'soft_404', 'redirected', 'wrong_host', 'unreadable')),
  -- http: the owner-page-check function's fetch; rendered: a person or a
  -- browser session read the rendered page (SPAs that answer 200 for any path).
  method text not null check (method in ('http', 'rendered')),
  title text, h1 text, canonical text, content_sha256 text,
  detail text check (detail is null or length(detail) <= 1000),
  source_ref text not null check (length(btrim(source_ref)) between 1 and 300),
  checked_at timestamptz not null default now()
);
create index owner_page_checks_url_idx on owner_page_checks (client_id, url_norm, checked_at desc);
create function owner_page_checks_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'A page check is a record; add a new check instead' using errcode = '42501';
  end if;
  new.url_norm := core_norm_url(new.requested_url);
  new.checked_at := now();
  if new.url_norm is null then raise exception 'A page check names an absolute URL' using errcode = '23514'; end if;
  return new;
end $$;
revoke all on function owner_page_checks_guard() from public, anon, authenticated;
create trigger owner_page_checks_guard before insert or update or delete on owner_page_checks
  for each row execute function owner_page_checks_guard();
alter table owner_page_checks enable row level security;
create policy "team owner page checks" on owner_page_checks to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on owner_page_checks from public, anon, authenticated;
grant select, insert on owner_page_checks to authenticated;
grant select, insert on owner_page_checks to service_role;

-- ── 4. Promotion holds ──────────────────────────────────────────────────────
create table client_promotion_holds (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  brand_workspace_id uuid references client_brand_workspaces(id),
  offering text not null check (length(btrim(offering)) between 1 and 200),
  -- word phrases, matched whole-word against keyword text and drafted copy
  phrases text[] not null check (cardinality(phrases) between 1 and 40),
  service_ids uuid[] not null default '{}',
  status text not null default 'held' check (status in ('held', 'released')),
  -- the person's words and where they are recorded
  source_ref text not null check (length(btrim(source_ref)) between 1 and 1000),
  decided_on date not null,
  released_on date,
  released_by uuid references team_members(id),
  created_at timestamptz not null default now(),
  check (status = 'held' or released_on is not null)
);
create function client_promotion_holds_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A promotion hold is kept; release it instead' using errcode = '42501';
  end if;
  new.phrases := array(select distinct core_norm_words(x) from unnest(new.phrases) x where core_norm_words(x) <> '');
  if cardinality(new.phrases) = 0 then raise exception 'A hold names at least one phrase' using errcode = '23514'; end if;
  if exists (select 1 from unnest(new.service_ids) s where not exists (
               select 1 from services v where v.id = s and v.client_id = new.client_id)) then
    raise exception 'A held service belongs to this client' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'held' then raise exception 'A hold starts held' using errcode = '23514'; end if;
    return new;
  end if;
  if (new.client_id, new.brand_workspace_id, new.offering, new.source_ref, new.decided_on, new.created_at)
     is distinct from (old.client_id, old.brand_workspace_id, old.offering, old.source_ref, old.decided_on, old.created_at) then
    raise exception 'A hold''s decision does not change; record a new hold' using errcode = '42501';
  end if;
  if old.status = 'held' and new.status = 'released' then
    -- Releasing is the person's call: a signed-in teammate only.
    if not post_caller_is_human() then
      raise exception 'Only a signed-in teammate releases a promotion hold' using errcode = '42501';
    end if;
    new.released_by := task_actor(); new.released_on := coalesce(new.released_on, current_date);
  elsif new.status <> old.status then
    raise exception 'A hold moves held → released only' using errcode = '23514';
  elsif new.status = 'released' and (new.phrases, new.service_ids) is distinct from (old.phrases, old.service_ids) then
    raise exception 'A released hold is history' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function client_promotion_holds_guard() from public, anon, authenticated;
create trigger client_promotion_holds_guard before insert or update or delete on client_promotion_holds
  for each row execute function client_promotion_holds_guard();
alter table client_promotion_holds enable row level security;
create policy "team promotion holds" on client_promotion_holds to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on client_promotion_holds from public, anon, authenticated;
grant select, insert, update on client_promotion_holds to authenticated;
grant select on client_promotion_holds to service_role;

-- A light suffix stripper (the TypeScript twin is holdStem): "repairs",
-- "repaired" and "repairing" meet "repair"; "consultations", "consultant"
-- and "consulting" meet "consultation". Both sides are stemmed, so it only
-- has to be consistent.
create function core_hold_stem(p_word text) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare w text := p_word;
begin
  if length(w) <= 3 then return w; end if;
  if w like '%ies' and length(w) > 4 then w := left(w, -3) || 'y';
  elsif w like '%s' and w not like '%ss' then w := left(w, -1); end if;
  if w like '%ation' and length(w) > 7 then w := left(w, -5);
  elsif w like '%ion' and length(w) > 6 then w := left(w, -3);
  elsif w like '%ment' and length(w) > 7 then w := left(w, -4);
  elsif w like '%ing' and length(w) > 5 then w := left(w, -3);
  elsif w like '%ant' and length(w) > 6 then w := left(w, -3);
  elsif w like '%ed' and length(w) > 4 then w := left(w, -2); end if;
  if w like '%er' and length(w) > 4 then w := left(w, -2); end if;
  if w like '%e' and length(w) > 4 then w := left(w, -1); end if;
  if length(w) > 3 and right(w, 1) = substr(w, length(w) - 1, 1) and right(w, 1) ~ '[b-df-hj-km-np-rtv-y]' then
    w := left(w, -1);
  end if;
  return w;
end $$;

create function core_hold_tokens(p_text text) returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(array_agg(core_hold_stem(t) order by n), '{}')
  from unnest(string_to_array(core_norm_words(p_text), ' ')) with ordinality as x(t, n) where t <> ''
$$;

-- The first held phrase whose words all occur, in any order, within a span
-- of the phrase's length + 2 words ("we will monitor your solar system"
-- meets "solar system monitoring"); null when none does. Phrases are the
-- offering's words and its listed paraphrases. Prose they do not name is
-- the human reviewer's to catch: a miss here is not a statement it is safe.
create function core_hold_hit(p_phrases text[], p_text text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare t text[] := core_hold_tokens(p_text); ph text; ps text[]; m int;
begin
  if cardinality(t) = 0 then return null; end if;
  foreach ph in array coalesce(p_phrases, '{}') loop
    ps := core_hold_tokens(ph); m := cardinality(ps);
    continue when m = 0;
    if exists (select 1 from generate_subscripts(t, 1) i where t[i] = any(ps) and ps <@ t[i:i + m + 1]) then
      return ph;
    end if;
  end loop;
  return null;
end $$;
revoke all on function core_hold_stem(text), core_hold_tokens(text), core_hold_hit(text[], text) from public, anon;
grant execute on function core_hold_stem(text), core_hold_tokens(text), core_hold_hit(text[], text) to authenticated, service_role;

-- The held offering a text, service or page would promote, or null.
create function core_promotion_hold(p_client_id uuid, p_program uuid, p_text text, p_service_id uuid, p_url text)
returns text language sql stable security invoker set search_path = public, pg_temp as $$
  select h.offering || ' (held ' || h.decided_on || ': ' || left(h.source_ref, 160) || ')'
  from client_promotion_holds h
  where h.client_id = p_client_id and h.status = 'held'
    and (h.brand_workspace_id is null or h.brand_workspace_id is not distinct from p_program)
    and ((p_service_id is not null and p_service_id = any(h.service_ids))
      or core_hold_hit(h.phrases, p_text) is not null
      or (p_url is not null and exists (select 1 from services v where v.id = any(h.service_ids) and v.page_url is not null
                                          and core_norm_url(v.page_url) = core_norm_url(p_url))))
  order by h.created_at, h.id limit 1
$$;
revoke all on function core_promotion_hold(uuid, uuid, text, uuid, text) from public, anon;
grant execute on function core_promotion_hold(uuid, uuid, text, uuid, text) to authenticated, service_role;

-- ── 5. Site program of a keyword ────────────────────────────────────────────
-- Multi-brand clients: the brand site owning the keyword's service; with no
-- service, the one brand site whose host carries ALL of the keyword's OWN
-- explicit claims (its target_url, approved page groups and services naming
-- it primary) — never an equivalent row's, so there is no circular
-- inference, and no default to another site. Null when that is not exactly
-- one site, and always null for single-site clients.
create function core_site_of_keyword(p_client_id uuid, p_keyword_id uuid) returns uuid
language sql stable security invoker set search_path = public, pg_temp as $$
  with k as (select * from keywords where id = p_keyword_id and client_id = p_client_id),
  by_service as (
    select w.id from k join client_brand_workspaces w on w.client_id = p_client_id and k.service_id = any(w.service_ids)
  ),
  claims as (
    select k.target_url as u from k where nullif(btrim(k.target_url), '') is not null
    union all
    select g.target_url from page_groups g join k on g.primary_keyword_id = k.id
     where g.client_id = p_client_id and g.status = 'approved' and nullif(btrim(g.target_url), '') is not null
    union all
    select v.page_url from services v join k on v.primary_keyword_id = k.id
     where v.client_id = p_client_id and v.status = 'approved' and nullif(btrim(v.page_url), '') is not null
  ),
  hosts as (select distinct core_url_host(u) as h from claims),
  by_host as (
    select w.id from client_brand_workspaces w
     where w.client_id = p_client_id and (select count(*) from hosts) = 1
       and core_url_host(w.website_url) = (select h from hosts)
  )
  select case
    when not exists (select 1 from client_brand_workspaces x where x.client_id = p_client_id) then null
    when (select service_id from k) is not null then
      (select case when count(*) = 1 then (array_agg(id))[1] end from by_service)
    else (select case when count(*) = 1 then (array_agg(id))[1] end from by_host)
  end
$$;
revoke all on function core_site_of_keyword(uuid, uuid) from public, anon;
grant execute on function core_site_of_keyword(uuid, uuid) to authenticated, service_role;

-- ── 6. Roles and purposes ───────────────────────────────────────────────────
-- What an owner page of each role may anchor (Oct 28 2026). post = a
-- Business Profile or Facebook post; blog = a new article; refresh = a
-- rewrite of the owner page (the contracted monthly page refresh — a blog
-- post is not that page); add = recording a newly built owner page.
create function core_owner_allows(p_role text, p_purpose text, p_intent text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select coalesce(case p_purpose
    when 'post' then case p_role
      when 'service' then true
      when 'city' then true
      when 'home' then p_intent in ('navigational', 'commercial', 'transactional')
      when 'brand' then p_intent in ('navigational', 'commercial')
      when 'blog' then p_intent in ('informational', 'commercial')
      else false end
    when 'blog' then case p_role
      when 'service' then p_intent in ('informational', 'commercial')
      when 'city' then p_intent = 'informational'
      else false end
    when 'refresh' then p_role in ('service', 'city', 'home', 'brand')
    when 'add' then p_role in ('service', 'city', 'home', 'brand')
    else false end, false)
$$;
revoke all on function core_owner_allows(text, text, text) from public, anon;
grant execute on function core_owner_allows(text, text, text) to authenticated, service_role;

-- ── 7. The resolver ─────────────────────────────────────────────────────────
-- keyword_owner(client, requested program or null, keyword, purpose or null)
-- → {url, display_url, page_group_id, role, program_id, market_id, market,
--    related_service_id, from_service, problem_code, problem}
-- problem_code null = the keyword has exactly one usable owner page for that
-- purpose. Codes (first failing check wins; the TypeScript twin returns the
-- same code for the same rows):
--   keyword_unknown, program_unresolved, keyword_wrong_site, promotion_held,
--   service_not_approved, service_wrong_site, target_page_invalid,
--   keyword_owner_conflict, target_page_missing, keyword_wrong_page,
--   page_role_ambiguous, target_page_unapproved, service_missing,
--   page_not_verified, market_unverified, market_ambiguous, market_unmapped,
--   keyword_already_owned, owner_role_not_allowed
create function keyword_owner(p_client_id uuid, p_brand_workspace_id uuid, p_keyword_id uuid, p_purpose text default null)
returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  k keywords; v services; ws client_brand_workspaces; pk keywords;
  v_multi boolean; v_prog uuid; v_site text; v_site_host text;
  v_eq uuid[]; v_raw text[]; v_cands text[]; v_owner text; v_display text;
  v_roles text[]; v_gid uuid; v_role text; chk owner_page_checks; mk client_service_markets; v_nmk int;
  v_held text; v_out jsonb;
  v_fail jsonb;
begin
  if p_purpose is not null and p_purpose not in ('post', 'blog', 'refresh', 'add') then
    raise exception 'Purpose is post, blog, refresh or add' using errcode = '22023';
  end if;
  select * into k from keywords where id = p_keyword_id and client_id = p_client_id;
  if k.id is null or not k.is_active then
    return jsonb_build_object('problem_code', 'keyword_unknown', 'problem', 'The keyword is inactive or not this client''s.');
  end if;
  v_multi := exists (select 1 from client_brand_workspaces x where x.client_id = p_client_id);
  if v_multi then
    v_prog := core_site_of_keyword(p_client_id, k.id);
    if v_prog is null then
      return jsonb_build_object('problem_code', 'program_unresolved', 'problem',
        'The keyword belongs to no single brand site: its service is on none, or its own page claims are on no single brand site.');
    end if;
    if p_brand_workspace_id is not null and p_brand_workspace_id is distinct from v_prog then
      return jsonb_build_object('problem_code', 'keyword_wrong_site', 'problem', 'The keyword belongs to another brand site.', 'program_id', v_prog);
    end if;
    select * into ws from client_brand_workspaces where id = v_prog;
    v_site := ws.website_url;
  else
    if p_brand_workspace_id is not null then
      return jsonb_build_object('problem_code', 'keyword_wrong_site', 'problem', 'A single-site client has no brand site program.');
    end if;
    select website_url into v_site from clients where id = p_client_id;
  end if;
  v_site_host := core_url_host(v_site);
  v_out := jsonb_build_object('program_id', v_prog, 'related_service_id', k.service_id);

  -- Held offerings: the keyword, its core parent, its related service.
  select * into pk from keywords where id = k.core_parent_keyword_id and client_id = p_client_id;
  v_held := coalesce(core_promotion_hold(p_client_id, v_prog, k.keyword, k.service_id, null),
                   core_promotion_hold(p_client_id, v_prog, pk.keyword, null, null));
  if v_held is not null then
    return v_out || jsonb_build_object('problem_code', 'promotion_held', 'problem', 'Promotion is held: ' || v_held || '.');
  end if;

  -- Related service: approved, same site.
  if k.service_id is not null then
    select * into v from services where id = k.service_id and client_id = p_client_id;
    if v.id is null or v.status::text <> 'approved' then
      return v_out || jsonb_build_object('problem_code', 'service_not_approved', 'problem', 'The keyword''s service is not approved.');
    end if;
    if v_multi and not (v.id = any(ws.service_ids)) then
      return v_out || jsonb_build_object('problem_code', 'service_wrong_site', 'problem', 'The keyword''s service belongs to another brand site.');
    end if;
  end if;

  -- Equivalent rows: same text, same client, same site program.
  select array_agg(e.id) into v_eq from keywords e
   where e.client_id = p_client_id and e.is_active and core_norm_kw(e.keyword) = core_norm_kw(k.keyword)
     and (e.id = k.id or not v_multi or core_site_of_keyword(p_client_id, e.id) is not distinct from v_prog);

  select array_agg(u) into v_raw from (
    select g.target_url as u from page_groups g
     where g.client_id = p_client_id and g.status = 'approved' and g.primary_keyword_id = any(v_eq) and nullif(btrim(g.target_url), '') is not null
    union all
    select e.target_url from keywords e where e.id = any(v_eq) and nullif(btrim(e.target_url), '') is not null
    union all
    select s.page_url from services s
     where s.client_id = p_client_id and s.status = 'approved' and s.primary_keyword_id = any(v_eq) and nullif(btrim(s.page_url), '') is not null
  ) x;
  if exists (select 1 from unnest(coalesce(v_raw, '{}')) u where core_norm_url(u, v_site) is null) then
    return v_out || jsonb_build_object('problem_code', 'target_page_invalid', 'problem',
      'A page claiming the keyword is not a URL: ' || (select string_agg(u, ', ') from unnest(v_raw) u where core_norm_url(u, v_site) is null) || '.');
  end if;
  select array_agg(distinct core_norm_url(u, v_site) order by core_norm_url(u, v_site)) into v_cands from unnest(coalesce(v_raw, '{}')) u;
  if cardinality(v_cands) > 1 then
    return v_out || jsonb_build_object('problem_code', 'keyword_owner_conflict', 'problem',
      'The keyword has competing owner pages: ' || array_to_string(v_cands, ', ') || '. Resolve ownership before drafting.');
  elsif cardinality(v_cands) = 1 then
    v_owner := v_cands[1];
  elsif v.id is not null and nullif(btrim(v.page_url), '') is not null and core_norm_url(v.page_url, v_site) is not null then
    v_owner := core_norm_url(v.page_url, v_site);
    v_out := v_out || jsonb_build_object('from_service', true);
  else
    return v_out || jsonb_build_object('problem_code', 'target_page_missing', 'problem',
      'No page claims the keyword and it has no related service page.');
  end if;
  v_out := v_out || jsonb_build_object('url', v_owner);

  if v_owner !~ '^https://' then
    return v_out || jsonb_build_object('problem_code', 'target_page_invalid', 'problem', v_owner || ' is not an https page.');
  end if;
  if v_site_host is null or core_url_host(v_owner) is distinct from v_site_host then
    return v_out || jsonb_build_object('problem_code', 'keyword_wrong_page', 'problem',
      v_owner || ' is not on ' || coalesce(case when v_multi then ws.name || '''s site ' else 'the client''s website ' end || v_site, 'the site') || '.');
  end if;

  -- Role: the approved page group(s) targeting the owner; else a published post.
  -- Roles, not raw page types: service and hub are both a service page.
  select array_agg(distinct case g.page_type::text when 'home' then 'home' when 'city' then 'city' when 'other' then 'brand' else 'service' end),
         (array_agg(g.id order by g.created_at, g.id))[1],
         (array_agg(g.target_url order by g.created_at, g.id))[1]
    into v_roles, v_gid, v_display
    from page_groups g
   where g.client_id = p_client_id and g.status = 'approved' and core_norm_url(g.target_url, v_site) = v_owner;
  if cardinality(v_roles) > 1 then
    return v_out || jsonb_build_object('problem_code', 'page_role_ambiguous', 'problem',
      'Approved page groups give ' || v_owner || ' different roles: ' || array_to_string(v_roles, ', ') || '.');
  elsif cardinality(v_roles) = 1 then
    v_role := v_roles[1];
  elsif exists (select 1 from content_posts cp where cp.client_id = p_client_id and cp.status::text = 'published'
                  and core_norm_url(cp.url, v_site) = v_owner) then
    v_role := 'blog';
    select cp.url into v_display from content_posts cp where cp.client_id = p_client_id and cp.status::text = 'published'
       and core_norm_url(cp.url, v_site) = v_owner order by cp.id limit 1;
  else
    return v_out || jsonb_build_object('problem_code', 'target_page_unapproved', 'problem', 'No approved page group targets ' || v_owner || '.');
  end if;
  v_display := case when v_display ~* '^https?://' then v_display else v_owner end;
  v_out := v_out || jsonb_build_object('role', v_role, 'page_group_id', v_gid, 'display_url', v_display);

  if v_role = 'service' and k.service_id is null and coalesce(k.intent, '') <> 'navigational' then
    return v_out || jsonb_build_object('problem_code', 'service_missing', 'problem',
      'A service page owns the keyword but the keyword names no related service.');
  end if;
  v_held := core_promotion_hold(p_client_id, v_prog, null, null, v_owner);
  if v_held is not null then
    return v_out || jsonb_build_object('problem_code', 'promotion_held', 'problem', 'The owner page promotes a held offering: ' || v_held || '.');
  end if;

  -- Live page: the latest check of the owner. Unchecked is not verified. An
  -- http soft_404 means the host answers every path alike (a single-page app),
  -- so it cannot judge the route: the latest rendered check decides then. A
  -- real 404 or redirect from http still wins over an older rendered check.
  if p_purpose is distinct from 'add' then
    select * into chk from owner_page_checks c where c.client_id = p_client_id and c.url_norm = v_owner
     order by c.checked_at desc, c.id desc limit 1;
    if chk.method = 'http' and chk.verdict = 'soft_404' then
      select * into chk from owner_page_checks c where c.client_id = p_client_id and c.url_norm = v_owner
         and (c.method = 'rendered' or c.id = chk.id)
       order by (c.method = 'rendered') desc, c.checked_at desc, c.id desc limit 1;
    end if;
    if chk.id is null then
      return v_out || jsonb_build_object('problem_code', 'page_not_verified', 'problem', v_owner || ' has not been checked live.');
    elsif chk.verdict <> 'live' then
      return v_out || jsonb_build_object('problem_code', 'target_page_missing', 'problem',
        v_owner || ' was ' || chk.verdict || ' when checked ' || to_char(chk.checked_at, 'YYYY-MM-DD') || coalesce(': ' || chk.detail, '') || '.');
    elsif chk.checked_at < now() - interval '45 days' then
      return v_out || jsonb_build_object('problem_code', 'page_not_verified', 'problem',
        v_owner || ' was last checked ' || to_char(chk.checked_at, 'YYYY-MM-DD') || '; check it again.');
    end if;
  end if;

  -- Market: explicit (market_id), else the one market of this site with the
  -- keyword's city name. A city page always needs one.
  if k.market_id is not null then
    select * into mk from client_service_markets m where m.id = k.market_id and m.client_id = p_client_id
       and (m.brand_workspace_id is null or m.brand_workspace_id is not distinct from v_prog);
    if mk.id is null then
      return v_out || jsonb_build_object('problem_code', 'market_unverified', 'problem', 'The keyword''s market is not a market of this site.');
    end if;
  elsif nullif(btrim(k.city), '') is not null then
    select count(*) into v_nmk from client_service_markets m where m.client_id = p_client_id
       and (m.brand_workspace_id is null or m.brand_workspace_id is not distinct from v_prog) and lower(btrim(m.city)) = lower(btrim(k.city));
    if v_nmk = 0 then
      return v_out || jsonb_build_object('problem_code', 'market_unverified', 'problem', btrim(k.city) || ' is not a recorded service market of this site.');
    elsif v_nmk > 1 then
      return v_out || jsonb_build_object('problem_code', 'market_ambiguous', 'problem',
        btrim(k.city) || ' names more than one recorded market; record the keyword''s market explicitly.');
    end if;
    select * into mk from client_service_markets m where m.client_id = p_client_id
       and (m.brand_workspace_id is null or m.brand_workspace_id is not distinct from v_prog) and lower(btrim(m.city)) = lower(btrim(k.city));
  end if;
  if mk.id is not null then
    v_out := v_out || jsonb_build_object('market_id', mk.id, 'market', mk.city || ', ' || mk.state);
    if mk.status <> 'approved' then
      return v_out || jsonb_build_object('problem_code', 'market_unverified', 'problem',
        mk.city || ', ' || mk.state || ' is ' || mk.status || ' (' || left(mk.source_ref, 160) || ').');
    end if;
  elsif v_role = 'city' then
    return v_out || jsonb_build_object('problem_code', 'market_unmapped', 'problem',
      'A city page owns the keyword; record the keyword''s market.');
  end if;

  if p_purpose is not null then
    if v_role = 'blog' and p_purpose = 'blog' then
      return v_out || jsonb_build_object('problem_code', 'keyword_already_owned', 'problem',
        'A published article already owns the keyword; refresh it instead of writing another.');
    elsif not core_owner_allows(v_role, p_purpose, k.intent) then
      return v_out || jsonb_build_object('problem_code', 'owner_role_not_allowed', 'problem',
        'A ' || v_role || ' page does not anchor a ' || p_purpose || ' for a ' || coalesce(k.intent, 'unlabelled') || ' keyword.');
    end if;
  end if;
  return v_out || jsonb_build_object('problem_code', null, 'problem', null);
end $$;
revoke all on function keyword_owner(uuid, uuid, uuid, text) from public, anon;
grant execute on function keyword_owner(uuid, uuid, uuid, text) to authenticated, service_role;

-- Everything the TypeScript resolver reads, in one document (the drafter
-- loader adds it as owner_context). Same rows, same rule.
create function keyword_owner_context(p_client_id uuid, p_program uuid default null) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'enforce', not core_keyword_exempt(p_client_id),
    'program_id', p_program,
    'site_url', coalesce((select w.website_url from client_brand_workspaces w where w.id = p_program and w.client_id = p_client_id),
                         (select c.website_url from clients c where c.id = p_client_id)),
    'workspaces', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'website_url', w.website_url, 'service_ids', w.service_ids) order by w.id)
                             from client_brand_workspaces w where w.client_id = p_client_id), '[]'),
    'keywords', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'keyword', k.keyword, 'is_active', k.is_active, 'intent', k.intent,
                             'service_id', k.service_id, 'target_url', k.target_url, 'city', k.city, 'market_id', k.market_id,
                             'core_parent_keyword_id', k.core_parent_keyword_id) order by k.id)
                           from keywords k where k.client_id = p_client_id), '[]'),
    'services', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'status', s.status, 'page_url', s.page_url, 'primary_keyword_id', s.primary_keyword_id) order by s.id)
                           from services s where s.client_id = p_client_id), '[]'),
    'page_groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'status', g.status, 'page_type', g.page_type, 'target_url', g.target_url,
                              'primary_keyword_id', g.primary_keyword_id, 'created_at', g.created_at) order by g.created_at, g.id)
                              from page_groups g where g.client_id = p_client_id), '[]'),
    'published_posts', coalesce((select jsonb_agg(jsonb_build_object('id', cp.id, 'url', cp.url) order by cp.id)
                                  from content_posts cp where cp.client_id = p_client_id and cp.status::text = 'published' and cp.url is not null), '[]'),
    'markets', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'brand_workspace_id', m.brand_workspace_id, 'city', m.city, 'state', m.state,
                          'country', m.country, 'status', m.status, 'basis', m.basis, 'source_ref', m.source_ref) order by m.id)
                          from client_service_markets m where m.client_id = p_client_id), '[]'),
    -- The latest check per page and method (keyword_owner reads the latest
    -- rendered check when the latest http check is a soft 404).
    'page_checks', coalesce((select jsonb_agg(jsonb_build_object('url_norm', c.url_norm, 'verdict', c.verdict, 'checked_at', c.checked_at,
                              'detail', c.detail, 'method', c.method, 'id', c.id) order by c.url_norm, c.method)
                              from (select distinct on (url_norm, method) * from owner_page_checks where client_id = p_client_id
                                     order by url_norm, method, checked_at desc, id desc) c), '[]'),
    'holds', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'brand_workspace_id', h.brand_workspace_id, 'offering', h.offering,
                        'phrases', h.phrases, 'service_ids', h.service_ids, 'decided_on', h.decided_on, 'source_ref', h.source_ref) order by h.created_at, h.id)
                        from client_promotion_holds h where h.client_id = p_client_id and h.status = 'held'), '[]'),
    'as_of', now())
$$;
revoke all on function keyword_owner_context(uuid, uuid) from public, anon;
grant execute on function keyword_owner_context(uuid, uuid) to authenticated, service_role;

-- ── 8. Eligibility, grounding, list guard ───────────────────────────────────
-- core_keyword_eligibility(client, program, keyword, post's service, purpose)
-- null = usable now; else the first reason. The four-argument form is the
-- same with no purpose (readiness of the keyword itself).
create function core_keyword_eligibility(p_client_id uuid, p_brand_workspace_id uuid, p_keyword_id uuid, p_service_id uuid, p_purpose text)
returns text
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare k keywords; o jsonb;
begin
  select * into k from keywords where id = p_keyword_id and client_id = p_client_id;
  if k.id is null or not k.is_active then return 'keyword_not_eligible: the keyword is inactive or not this client''s.'; end if;
  if not exists (select 1 from core_keyword_grounding(p_client_id, p_keyword_id)) then
    return 'core_keyword_required: the keyword is not in the approved core keyword list and names no active core parent.';
  end if;
  if k.intent is null then return 'keyword_not_eligible: the keyword has no recorded intent.'; end if;
  if p_service_id is not null and p_service_id is distinct from k.service_id then
    return 'keyword_not_eligible: the post''s service is not the keyword''s service.';
  end if;
  o := keyword_owner(p_client_id, p_brand_workspace_id, p_keyword_id, p_purpose);
  if o->>'problem_code' is null then return null; end if;
  return case o->>'problem_code'
    when 'keyword_unknown' then 'keyword_not_eligible: the keyword is inactive or not this client''s.'
    when 'service_not_approved' then 'keyword_not_eligible: the keyword''s service is not approved.'
    when 'service_wrong_site' then 'keyword_not_eligible: the keyword''s service belongs to another brand site.'
    when 'keyword_wrong_site' then 'keyword_not_eligible: the keyword belongs to another brand site.'
    else (o->>'problem_code') || ': ' || (o->>'problem') end;
end $$;
revoke all on function core_keyword_eligibility(uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function core_keyword_eligibility(uuid, uuid, uuid, uuid, text) to authenticated, service_role;

create or replace function core_keyword_eligibility(p_client_id uuid, p_brand_workspace_id uuid, p_keyword_id uuid, p_service_id uuid default null)
returns text
language sql stable security invoker set search_path = public, pg_temp as $$
  select core_keyword_eligibility(p_client_id, p_brand_workspace_id, p_keyword_id, p_service_id, null::text)
$$;

-- The keyword's program is core_site_of_keyword (its service's site, or the
-- one site its own pages are on), not only its service.
create or replace function core_keyword_grounding(p_client_id uuid, p_keyword_id uuid)
returns table (list_id uuid, list_version integer, core_keyword_id uuid)
language sql stable security invoker set search_path = public, pg_temp as $$
  with k as (
    select k.id, k.core_parent_keyword_id,
           core_site_of_keyword(k.client_id, k.id) as program,
           exists (select 1 from client_brand_workspaces x where x.client_id = k.client_id) as multi
    from keywords k where k.id = p_keyword_id and k.client_id = p_client_id and k.is_active
  )
  select l.id, l.version, case when k.id = any(l.keyword_ids) then k.id else pk.id end
  from k
  join core_keyword_lists l on l.client_id = p_client_id and l.status = 'approved'
   and l.brand_workspace_id is not distinct from k.program and (not k.multi or k.program is not null)
  left join keywords pk on pk.id = k.core_parent_keyword_id and pk.client_id = p_client_id and pk.is_active
  where k.id = any(l.keyword_ids) or pk.id = any(l.keyword_ids)
$$;

do $migration$
declare
  definition text := pg_get_functiondef('public.core_keyword_lists_guard()'::regprocedure);
  a1 text := $a1$      if exists (select 1 from keywords k where k.id = any(new.keyword_ids)
                  and (k.service_id is null or not (k.service_id = any(ws.service_ids)))) then$a1$;
  r1 text := $r1$      if exists (select 1 from keywords k where k.id = any(new.keyword_ids)
                  and core_site_of_keyword(new.client_id, k.id) is distinct from ws.id) then$r1$;
  a2 text := $a2$             select 1 from client_brand_workspaces w where w.id = new.brand_workspace_id and k.service_id = any(w.service_ids)));$a2$;
  r2 text := $r2$             select 1 from client_brand_workspaces w where w.id = new.brand_workspace_id and core_site_of_keyword(new.client_id, k.id) = w.id));$r2$;
begin
  if strpos(definition, 'core_site_of_keyword') > 0 then return; end if;
  if (length(definition) - length(replace(definition, a1, ''))) <> length(a1)
     or (length(definition) - length(replace(definition, a2, ''))) <> length(a2) then
    raise exception 'Unexpected core_keyword_lists_guard definition; review before applying the owner resolver';
  end if;
  execute replace(replace(definition, a1, r1), a2, r2);
end;
$migration$;

-- ── 9. Evidence records the owner ───────────────────────────────────────────
alter table core_keyword_links add column owner_url text, add column owner_role text,
  add column market_id uuid references client_service_markets(id);

create or replace function core_keyword_link_once(p_client_id uuid, p_keyword_id uuid, p_post uuid, p_draft uuid, p_change uuid, p_plan_item uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare g record; o jsonb;
begin
  select * into g from core_keyword_grounding(p_client_id, p_keyword_id);
  if g.list_id is null then return; end if;
  if not exists (select 1 from core_keyword_links c
                  where c.list_id = g.list_id and c.list_version = g.list_version and c.keyword_id = p_keyword_id
                    and (c.social_post_id = p_post or c.content_draft_id = p_draft or c.change_log_id = p_change)) then
    o := keyword_owner(p_client_id, null, p_keyword_id, null);
    insert into core_keyword_links (client_id, list_id, list_version, keyword_id, core_keyword_id, social_post_id, content_draft_id,
                                    change_log_id, plan_item_id, owner_url, owner_role, market_id)
    values (p_client_id, g.list_id, g.list_version, p_keyword_id, g.core_keyword_id, p_post, p_draft, p_change, p_plan_item,
            o->>'url', o->>'role', nullif(o->>'market_id', '')::uuid);
  end if;
end $$;

create or replace function core_keyword_record(p_client_id uuid, p_keyword_id uuid, p_kind text, p_ref uuid, p_plan_item_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare g record; o jsonb;
begin
  if p_kind not in ('social_post', 'content_draft', 'change_log') or p_ref is null then
    raise exception 'Record a social_post, content_draft or change_log' using errcode = '22023';
  end if;
  select * into g from core_keyword_grounding(p_client_id, p_keyword_id);
  if g.list_id is null then
    raise exception 'core_keyword_required: the keyword is not in the approved core keyword list and names no core parent' using errcode = '22023';
  end if;
  o := keyword_owner(p_client_id, null, p_keyword_id, null);
  insert into core_keyword_links (client_id, list_id, list_version, keyword_id, core_keyword_id,
                                  social_post_id, content_draft_id, change_log_id, plan_item_id, owner_url, owner_role, market_id)
  values (p_client_id, g.list_id, g.list_version, p_keyword_id, g.core_keyword_id,
          case when p_kind = 'social_post' then p_ref end, case when p_kind = 'content_draft' then p_ref end,
          case when p_kind = 'change_log' then p_ref end, p_plan_item_id, o->>'url', o->>'role', nullif(o->>'market_id', '')::uuid);
  return jsonb_build_object('list_id', g.list_id, 'list_version', g.list_version, 'core_keyword_id', g.core_keyword_id,
                            'owner_url', o->>'url', 'owner_role', o->>'role', 'market_id', o->>'market_id');
end $$;

-- ── 10. Review gates ────────────────────────────────────────────────────────
-- A post in review: its own keyword and service, for a post, with the
-- organic market approved, the Business Profile location's market (as
-- before), and a button (when it has a link) to the owner page.
create or replace function core_keyword_social_gate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_problem text; o jsonb;
begin
  if core_keyword_social_governed(tg_op, new, case when tg_op = 'UPDATE' then old end) and not core_keyword_exempt(new.client_id) then
    if new.keyword_id is null then
      raise exception 'core_keyword_required: a post in review names a keyword of its site''s approved core keyword list' using errcode = '23514';
    end if;
    v_problem := coalesce(core_keyword_eligibility(new.client_id, null, new.keyword_id, new.service_id, 'post'),
                          core_market_problem(new.client_id, new.social_account_id, new.keyword_id));
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '23514';
    end if;
    if nullif(btrim(coalesce(new.cta_url, '')), '') is not null then
      o := keyword_owner(new.client_id, null, new.keyword_id, 'post');
      if core_norm_url(new.cta_url) is distinct from o->>'url' then
        raise exception 'cta_not_owner: the button links to %, not the keyword''s owner page %', new.cta_url, o->>'url' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end $$;

-- A content draft in review: a blog is purpose blog; its brief's owner page
-- (when the brief names one) is the keyword's owner.
create or replace function core_keyword_draft_gate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_problem text; v_site uuid; v_purpose text; o jsonb; v_brief_owner text;
begin
  if core_keyword_draft_governed(tg_op, new, case when tg_op = 'UPDATE' then old end) and not core_keyword_exempt(new.client_id) then
    if new.keyword_id is null then
      raise exception 'core_keyword_required: a draft in review names a keyword of its site''s approved core keyword list' using errcode = '23514';
    end if;
    v_site := (select i.brand_workspace_id from content_plan_items i where i.id = new.plan_item_id);
    v_purpose := case when new.deliverable = 'blog' then 'blog' end;
    v_problem := core_keyword_eligibility(new.client_id, v_site, new.keyword_id, new.service_id, v_purpose);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = '23514';
    end if;
    v_brief_owner := nullif(new.brief #>> '{target,owner_page,url}', '');
    o := keyword_owner(new.client_id, v_site, new.keyword_id, v_purpose);
    if new.brief is not null and core_norm_url(v_brief_owner) is distinct from o->>'url' then
      raise exception 'owner_page_mismatch: the draft''s brief links % as its owner page, not the keyword''s owner %; regenerate the draft',
        coalesce(v_brief_owner, 'nothing'), o->>'url' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- A content change: page_rewrite is a refresh OF the owner page; page_added
-- records a new owner page (no live check yet); blog_post is a blog.
create or replace function core_keyword_change_gate() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_kw uuid; v_site sites; v_program uuid; v_multi boolean; v_problem text; v_purpose text; o jsonb;
begin
  if new.change_type not in ('page_rewrite', 'page_added', 'blog_post') or core_keyword_exempt(new.client_id) then return new; end if;
  if tg_op = 'UPDATE' and (new.change_type, new.object_type, new.object_id, new.after->>'keyword_id', new.after->>'url')
     is not distinct from (old.change_type, old.object_type, old.object_id, old.after->>'keyword_id', old.after->>'url') then
    return new;
  end if;
  v_kw := case when coalesce(new.after->>'keyword_id', '') ~ '^[0-9a-f-]{36}$' then (new.after->>'keyword_id')::uuid end;
  if v_kw is null then
    raise exception 'core_keyword_required: a % change names its core keyword (after.keyword_id)', new.change_type using errcode = '23514';
  end if;
  select * into v_site from sites where id = new.object_id and client_id = new.client_id;
  v_multi := exists (select 1 from client_brand_workspaces w where w.client_id = new.client_id);
  if new.object_type is distinct from 'site' or v_site.id is null then
    raise exception 'core_keyword_required: a % change names the site it is on (object_type site, object_id)', new.change_type using errcode = '23514';
  end if;
  if v_multi then
    select w.id into v_program from client_brand_workspaces w where w.client_id = new.client_id and w.blog_site_id = v_site.id;
    if v_program is null then
      raise exception 'core_keyword_required: the site of this % change belongs to no brand site program', new.change_type using errcode = '23514';
    end if;
  end if;
  v_purpose := case new.change_type when 'page_rewrite' then 'refresh' when 'page_added' then 'add' else 'blog' end;
  v_problem := core_keyword_eligibility(new.client_id, v_program, v_kw, null, v_purpose);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '23514';
  end if;
  if coalesce(new.after->>'url', '') ~ '^https?://'
     and core_url_host(new.after->>'url') is distinct from core_url_host(v_site.url) then
    raise exception 'core_keyword_required: the changed page % is not on the site this change names', new.after->>'url' using errcode = '23514';
  end if;
  if new.change_type in ('page_rewrite', 'page_added') then
    o := keyword_owner(new.client_id, v_program, v_kw, v_purpose);
    if core_norm_url(new.after->>'url', v_site.url) is distinct from o->>'url' then
      raise exception 'refresh_not_owner: a % changes the keyword''s owner page %, not %', new.change_type, o->>'url',
        coalesce(new.after->>'url', 'an unnamed page') using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- ── 11. drafter_write: owner page, not the service page ─────────────────────
do $migration$
declare
  definition text := pg_get_functiondef('public.drafter_write(jsonb)'::regprocedure);
  g_old text := $gold$  declare v_core_problem text := core_keyword_eligibility(v_client, core_site_of_service(v_client, v_service),
                                                          nullif(v_target->'keyword'->>'id', '')::uuid, v_service);
  begin
    if core_keyword_exempt(v_client) and coalesce(p->>'claimant', '') not like 'worker-routine:%' then
      null;  -- Tom's recorded exception; unattended runs are never exempt
    elsif nullif(v_target->'keyword'->>'id', '') is null then
      raise exception 'core_keyword_required: a draft names a keyword of its site''s approved core keyword list' using errcode = 'check_violation';
    elsif v_core_problem is not null then
      raise exception '%', v_core_problem using errcode = 'check_violation';
    end if;
  end;
$gold$;
  g_new text := $gnew$  -- core_keyword_gate_v2 (20261028170000): the keyword's own site program and
  -- owner page, for a post; the brief must name that owner (a brief from an
  -- older drafter does not, and is refused: regenerate).
  declare
    v_core_kw uuid := nullif(v_target->'keyword'->>'id', '')::uuid;
    v_core_problem text := core_keyword_eligibility(v_client, null, v_core_kw, v_service, 'post');
    v_core_owner jsonb := keyword_owner(v_client, null, v_core_kw, 'post');
  begin
    if core_keyword_exempt(v_client) and coalesce(p->>'claimant', '') not like 'worker-routine:%' then
      null;  -- Tom's recorded exception; unattended runs are never exempt
    elsif v_core_kw is null then
      raise exception 'core_keyword_required: a draft names a keyword of its site''s approved core keyword list' using errcode = 'check_violation';
    elsif v_core_problem is not null then
      raise exception '%', v_core_problem using errcode = 'check_violation';
    elsif core_norm_url(v_target->'owner_page'->>'url') is distinct from v_core_owner->>'url' then
      raise exception 'owner_page_mismatch: the brief names % as the owner page, not the keyword''s owner %; regenerate the brief',
        coalesce(v_target->'owner_page'->>'url', 'nothing'), v_core_owner->>'url' using errcode = 'check_violation';
    elsif v_core_owner->>'program_id' is not null and (v_brief->'gate'->>'brand_workspace_id') is distinct from v_core_owner->>'program_id' then
      raise exception 'keyword_not_eligible: the brief is for another brand site than the keyword''s' using errcode = 'check_violation';
    end if;
  end;
$gnew$;
  b_old text := $bold$  -- The button goes to the service's own page.
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
$bold$;
  b_new text := $bnew$  -- The button goes to the keyword's owner page (20261028170000); a related
  -- service, when named, is an approved service of this client. With no
  -- resolvable owner (an exempt client's legacy keyword), the service page.
  if v_service is not null and not exists (select 1 from services where id = v_service and client_id = v_client and status = 'approved') then
    raise exception 'The target service is not an approved service of this client' using errcode = 'check_violation';
  end if;
  if v_cta_type is not null and v_cta_type <> 'CALL' then
    v_page := coalesce(keyword_owner(v_client, null, nullif(v_target->'keyword'->>'id', '')::uuid, null)->>'url',
                       (select core_norm_url(page_url) from services where id = v_service and client_id = v_client and status = 'approved'));
    if v_page is null or core_norm_url(v_cta_url) is distinct from v_page then
      raise exception 'The button must link to the keyword''s owner page' using errcode = 'check_violation';
    end if;
  end if;
$bnew$;
begin
  if strpos(definition, 'core_keyword_gate_v2') > 0 then return; end if;
  if (length(definition) - length(replace(definition, g_old, ''))) <> length(g_old)
     or (length(definition) - length(replace(definition, b_old, ''))) <> length(b_old)
     or strpos(definition, 'v_cta_url') = 0 or strpos(definition, 'v_page') = 0 then
    raise exception 'Unexpected drafter_write definition; review before applying the owner resolver';
  end if;
  execute replace(replace(definition, g_old, g_new), b_old, b_new);
end;
$migration$;

-- ── 12. Slot link and readiness ─────────────────────────────────────────────
do $migration$
declare
  definition text := pg_get_functiondef('public.social_slot_link(uuid,uuid,text)'::regprocedure);
  a1 text := $a1$select 1 from client_brand_workspaces w where w.id = i.brand_workspace_id and p.service_id = any(w.service_ids)) then$a1$;
  r1 text := $r1$select 1 from client_brand_workspaces w where w.id = i.brand_workspace_id
          and (p.service_id is null or p.service_id = any(w.service_ids))) then$r1$;
  a2 text := $a2$  v_problem := core_keyword_eligibility(t.client_id, i.brand_workspace_id, p.keyword_id, p.service_id);$a2$;
  r2 text := $r2$  v_problem := core_keyword_eligibility(t.client_id, i.brand_workspace_id, p.keyword_id, p.service_id, 'post');$r2$;
  a3 text := $a3$  select coalesce(case when p.cta_url ~ '^https?://\S+$' then p.cta_url end,
                  case when k.target_url ~ '^https?://\S+$' then k.target_url end,
                  case when v.page_url ~ '^https?://\S+$' then v.page_url end)
    into v_url
    from services v left join keywords k on k.id = p.keyword_id and k.client_id = p.client_id
   where v.id = p.service_id and v.client_id = p.client_id;$a3$;
  r3 text := $r3$  -- The slot's target is the keyword's owner page (20261028170000); a
  -- button, when the post has one, must already be that page.
  select coalesce(o->>'display_url', o->>'url') into v_url
    from keyword_owner(t.client_id, i.brand_workspace_id, p.keyword_id, 'post') o;
  if nullif(btrim(coalesce(p.cta_url, '')), '') is not null and core_norm_url(p.cta_url) is distinct from core_norm_url(v_url) then
    raise exception 'cta_not_owner: the post''s button links to %, not the keyword''s owner page %', p.cta_url, v_url using errcode = '22023';
  end if;$r3$;
begin
  if strpos(definition, 'keyword_owner(') > 0 then return; end if;
  if (length(definition) - length(replace(definition, a1, ''))) <> length(a1)
     or (length(definition) - length(replace(definition, a2, ''))) <> length(a2)
     or (length(definition) - length(replace(definition, a3, ''))) <> length(a3) then
    raise exception 'Unexpected social_slot_link definition; review before applying the owner resolver';
  end if;
  execute replace(replace(replace(definition, a1, r1), a2, r2), a3, r3);
end;
$migration$;

do $migration$
declare
  definition text := pg_get_functiondef('public.social_slot_readiness(uuid,date,date)'::regprocedure);
  a1 text := $a1$core_keyword_eligibility(s.client_id, case when s.multi then s.brand_workspace_id end, k.id) is null)
      then 'No core keyword (v' || s.list_version || ') with an intent and an approved service whose owner page is on the site with an approved page group.'$a1$;
  r1 text := $r1$core_keyword_eligibility(s.client_id, case when s.multi then s.brand_workspace_id end, k.id, null, 'post') is null)
      then 'No core keyword (v' || s.list_version || ') with an intent and one verified owner page on the site (an approved page group, checked live), an approved related service where the page needs one, and an approved market.'$r1$;
begin
  if strpos(definition, 'verified owner page') > 0 then return; end if;
  if (length(definition) - length(replace(definition, a1, ''))) <> length(a1) then
    raise exception 'Unexpected social_slot_readiness definition; review before applying the owner resolver';
  end if;
  execute replace(definition, a1, r1);
end;
$migration$;

-- ── 13. Drafter loader: the keyword's program and the owner context ─────────
-- p_keyword_id lets a multi-brand draft with no service (a Home or brand
-- term) find its site; keywords and page groups are the site's own.
drop function client_intelligence_for_content(uuid, uuid);
create function client_intelligence_for_content(p_client_id uuid, p_service_id uuid, p_keyword_id uuid default null) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare i jsonb; b client_brand_workspaces; host text;
begin
  i := client_intelligence_input(p_client_id);
  if not exists (select 1 from client_brand_workspaces where client_id = p_client_id) then
    return i || jsonb_build_object('owner_context', keyword_owner_context(p_client_id, null));
  end if;
  select * into b from client_brand_workspaces where client_id = p_client_id and p_service_id = any(service_ids);
  if b.id is null and p_service_id is null and p_keyword_id is not null then
    select * into b from client_brand_workspaces where id = core_site_of_keyword(p_client_id, p_keyword_id);
  end if;
  if b.id is null then raise exception 'Select a service assigned to a brand (or a keyword of one brand site) before drafting' using errcode = '23514'; end if;
  host := core_url_host(b.website_url);
  i := jsonb_set(i, '{client}', i->'client' || jsonb_build_object('name', b.name, 'phone', b.phone, 'website_url', b.website_url));
  i := jsonb_set(i, '{brand}', jsonb_build_object('positioning', b.positioning, 'voice_tone', b.voice_tone, 'audience', b.audience,
    'differentiators', b.differentiators, 'ai_guidance', b.ai_guidance, 'words_we_use', b.words_we_use,
    'words_we_avoid', b.words_we_avoid, 'content_pillars', b.content_pillars, 'tagline', b.tagline));
  i := jsonb_set(i, '{board}', jsonb_build_object('id', b.id, 'version', b.version, 'status', b.status, 'hard_rules', b.hard_rules, 'standing_cta', b.standing_cta));
  i := jsonb_set(i, '{services}', coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'services') x where (x->>'id')::uuid = any(b.service_ids)), '[]'));
  i := jsonb_set(i, '{keywords}', coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'keywords') x
                                             where core_site_of_keyword(p_client_id, (x->>'id')::uuid) = b.id), '[]'));
  i := jsonb_set(i, '{claims}', coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'claims') x where (x->>'id')::uuid = any(b.claim_ids)), '[]'));
  i := jsonb_set(i, '{assets}', coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'assets') x where (x->>'id')::uuid = any(b.asset_ids)), '[]'));
  i := jsonb_set(i, '{offers}', coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'offers') x where (x->>'service_id')::uuid = any(b.service_ids)), '[]'));
  -- A brand site's page groups are the ones on its host (page_groups has no site column).
  i := jsonb_set(i, '{pageGroups}', coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'pageGroups') x
                                               where core_url_host(x->>'target_url') = host), '[]'));
  return i || jsonb_build_object('workspace', jsonb_build_object('id', b.id, 'version', b.version, 'facebook_account_id', b.facebook_account_id),
                                 'owner_context', keyword_owner_context(p_client_id, b.id));
end $$;
revoke all on function client_intelligence_for_content(uuid, uuid, uuid) from public, anon;
grant execute on function client_intelligence_for_content(uuid, uuid, uuid) to authenticated, service_role;

-- ── 14. Planner board: ready means usable ───────────────────────────────────
do $migration$
declare
  definition text := pg_get_viewdef('public.content_plan_board'::regclass, false);
  anchor text := $a$THEN 'ready_to_generate'::text$a$;
  guard text := $g$AND (core_keyword_exempt(i.client_id) OR core_keyword_eligibility(i.client_id, i.brand_workspace_id, i.keyword_id, i.service_id, CASE WHEN i.deliverable = 'blog'::text THEN 'blog'::text ELSE 'post'::text END) IS NULL) THEN 'ready_to_generate'::text$g$;
begin
  if strpos(definition, 'core_keyword_eligibility') > 0 then return; end if;
  if (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) then
    raise exception 'Unexpected content_plan_board definition; review before applying the owner resolver';
  end if;
  execute 'create or replace view public.content_plan_board with (security_invoker = true) as ' || replace(definition, anchor, guard);
end;
$migration$;

-- ── 15. What owner-page-check checks ────────────────────────────────────────
-- The distinct owner pages of the keywords in a client's proposed and
-- approved core lists (and their named supporting children), whatever else
-- the resolver says about them: a page is checked so readiness can say why.
create function owner_page_check_targets(p_client_id uuid, p_brand_workspace_id uuid default null)
returns table (url text, site_url text, keyword_count integer)
language sql stable security invoker set search_path = public, pg_temp as $$
  with ks as (
    select distinct k.id, l.brand_workspace_id
    from core_keyword_lists l
    cross join lateral unnest(l.keyword_ids) kid
    join keywords k on k.client_id = l.client_id and (k.id = kid or k.core_parent_keyword_id = kid) and k.is_active
    where l.client_id = p_client_id and l.status in ('proposed', 'approved')
      and (p_brand_workspace_id is null or l.brand_workspace_id = p_brand_workspace_id)
  ),
  o as (
    select ks.id, keyword_owner(p_client_id, null, ks.id, 'add') as j, ks.brand_workspace_id from ks
  )
  select coalesce(min(o.j->>'display_url'), min(o.j->>'url')),
         coalesce((select w.website_url from client_brand_workspaces w where w.id = min(o.brand_workspace_id::text)::uuid),
                  (select c.website_url from clients c where c.id = p_client_id)),
         count(*)::int
  from o where o.j->>'url' ~ '^https://'
  group by o.j->>'url'
  order by 3 desc, 1
$$;
revoke all on function owner_page_check_targets(uuid, uuid) from public, anon, authenticated;
grant execute on function owner_page_check_targets(uuid, uuid) to service_role;

-- ── 15b. Holds on the copy itself ───────────────────────────────────────────
-- The keyword gates above see the keyword, its parent, service and owner
-- page. A hold is also checked against what the reader would see — the
-- post's copy and button, the article's title, meta, H1, body, slug, CTA and
-- schema — on every forward step: review, approval, scheduling, the
-- publisher's claim, and an edit while in any of those. So a hand-edited
-- post on an allowed installation keyword, a draft written before the hold
-- was recorded, and an older drafter's brief all stop at the next step.
-- Nothing is deleted or rewritten: posts and drafts are refused with the
-- reason, a queued article's claim is recorded as blocked, a planner slot is
-- marked blocked. promotion_hold_conflicts() lists what already matches.
-- Program null (unknown) checks every hold of the client: fail closed.
create function core_copy_hold(p_client_id uuid, p_program uuid, p_text text, p_service_id uuid, p_url text)
returns text language sql stable security invoker set search_path = public, pg_temp as $$
  select 'held_offering: ' || coalesce('"' || core_hold_hit(h.phrases, concat_ws(' ', p_text, p_url)) || '" promotes ', 'this promotes ')
         || h.offering || ', which is held from promotion (' || h.decided_on || ': ' || left(h.source_ref, 160)
         || '). Edit the copy; only a signed-in teammate releases the hold.'
  from client_promotion_holds h
  where h.client_id = p_client_id and h.status = 'held'
    and (h.brand_workspace_id is null or p_program is null or h.brand_workspace_id = p_program)
    and ((p_service_id is not null and p_service_id = any(h.service_ids))
      or core_hold_hit(h.phrases, concat_ws(' ', p_text, p_url)) is not null
      or (p_url is not null and exists (select 1 from services v where v.id = any(h.service_ids) and v.page_url is not null
                                          and core_norm_url(v.page_url) = core_norm_url(p_url))))
  order by h.created_at, h.id limit 1
$$;
revoke all on function core_copy_hold(uuid, uuid, text, uuid, text) from public, anon;
grant execute on function core_copy_hold(uuid, uuid, text, uuid, text) to authenticated, service_role;

create function social_posts_promotion_hold() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_problem text; v_program uuid;
begin
  if new.review_status not in ('in_review', 'approved') or new.publish_status not in ('not_scheduled', 'scheduled', 'publishing') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- The outcome of a send already under way is recorded, never refused.
    if old.publish_status = 'publishing' then return new; end if;
    if (new.review_status, new.publish_status, new.copy, new.cta_url, new.service_id, new.keyword_id)
       is not distinct from (old.review_status, old.publish_status, old.copy, old.cta_url, old.service_id, old.keyword_id) then
      return new;
    end if;
  end if;
  if not exists (select 1 from client_promotion_holds h where h.client_id = new.client_id and h.status = 'held') then return new; end if;
  v_program := coalesce(core_site_of_service(new.client_id, new.service_id),
                        case when new.keyword_id is not null then core_site_of_keyword(new.client_id, new.keyword_id) end);
  v_problem := core_copy_hold(new.client_id, v_program,
                              concat_ws(' ', new.copy, (select k.keyword from keywords k where k.id = new.keyword_id)),
                              new.service_id, nullif(btrim(coalesce(new.cta_url, '')), ''));
  if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
  return new;
end $$;
revoke all on function social_posts_promotion_hold() from public, anon, authenticated;
create trigger social_posts_ab_promotion_hold
  before insert or update of review_status, publish_status, copy, cta_url, service_id, keyword_id on social_posts
  for each row execute function social_posts_promotion_hold();

create function content_draft_hold_text(d content_drafts) returns text
language sql stable security invoker set search_path = public, pg_temp as $$
  select concat_ws(' ', d.topic, d.primary_keyword, d.title, d.meta_title, d.meta_description, d.h1, d.tldr, d.slug,
                   d.body_markdown, d.cta::text, d.structured_data::text,
                   (select k.keyword from keywords k where k.id = d.keyword_id))
$$;
revoke all on function content_draft_hold_text(content_drafts) from public, anon, authenticated;

create function content_draft_program(d content_drafts) returns uuid
language sql stable security invoker set search_path = public, pg_temp as $$
  select coalesce((select i.brand_workspace_id from content_plan_items i where i.id = d.plan_item_id),
                  core_site_of_service(d.client_id, d.service_id),
                  case when d.keyword_id is not null then core_site_of_keyword(d.client_id, d.keyword_id) end)
$$;
revoke all on function content_draft_program(content_drafts) from public, anon, authenticated;

create function content_drafts_promotion_hold() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_problem text;
begin
  if new.status not in ('in_review', 'approved') then return new; end if;
  if tg_op = 'UPDATE' and (new.status, new.topic, new.primary_keyword, new.title, new.meta_title, new.meta_description, new.h1,
                           new.tldr, new.slug, new.body_markdown, new.cta, new.structured_data, new.target_url, new.service_id,
                           new.keyword_id)
     is not distinct from (old.status, old.topic, old.primary_keyword, old.title, old.meta_title, old.meta_description, old.h1,
                           old.tldr, old.slug, old.body_markdown, old.cta, old.structured_data, old.target_url, old.service_id,
                           old.keyword_id) then
    return new;
  end if;
  if not exists (select 1 from client_promotion_holds h where h.client_id = new.client_id and h.status = 'held') then return new; end if;
  v_problem := core_copy_hold(new.client_id, content_draft_program(new), content_draft_hold_text(new), new.service_id,
                              nullif(btrim(coalesce(new.target_url, '')), ''));
  if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
  return new;
end $$;
revoke all on function content_drafts_promotion_hold() from public, anon, authenticated;
create trigger content_drafts_ab_promotion_hold
  before insert or update of status, topic, primary_keyword, title, meta_title, meta_description, h1, tldr, slug, body_markdown,
    cta, structured_data, target_url, service_id, keyword_id on content_drafts
  for each row execute function content_drafts_promotion_hold();

-- An article released before the hold: a human's release is refused with
-- the reason; the publisher's claim (queued → publishing) is recorded as
-- blocked with the reason, as blog_publication_claim records its own
-- problems, and nothing is sent.
create function blog_publications_promotion_hold() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare d content_drafts; v_problem text;
begin
  if not ((tg_op = 'INSERT' and new.status = 'queued') or (tg_op = 'UPDATE' and old.status = 'queued' and new.status = 'publishing')) then
    return new;
  end if;
  select * into d from content_drafts where id = new.draft_id;
  if d.id is null or not exists (select 1 from client_promotion_holds h where h.client_id = d.client_id and h.status = 'held') then
    return new;
  end if;
  v_problem := core_copy_hold(d.client_id, content_draft_program(d), content_draft_hold_text(d), d.service_id,
                              nullif(btrim(coalesce(d.target_url, '')), ''));
  if v_problem is null then return new; end if;
  if tg_op = 'INSERT' then raise exception '%', v_problem using errcode = '23514'; end if;
  new.status := 'blocked'; new.lease_token := null; new.lease_expires_at := null; new.last_error := left(v_problem, 1000);
  return new;
end $$;
revoke all on function blog_publications_promotion_hold() from public, anon, authenticated;
create trigger blog_publications_promotion_hold before insert or update of status on blog_publications
  for each row execute function blog_publications_promotion_hold();

-- A page change (rewrite, new page, article) whose recorded content would
-- promote a held offering.
create function change_log_promotion_hold() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_problem text; v_program uuid;
begin
  if new.change_type not in ('page_rewrite', 'page_added', 'blog_post') or new.status::text = 'vetoed' then return new; end if;
  if tg_op = 'UPDATE' and (new.status, new.after) is not distinct from (old.status, old.after) then return new; end if;
  if not exists (select 1 from client_promotion_holds h where h.client_id = new.client_id and h.status = 'held') then return new; end if;
  select w.id into v_program from client_brand_workspaces w where w.client_id = new.client_id and w.blog_site_id = new.object_id;
  v_problem := core_copy_hold(new.client_id, v_program, new.after::text, null, nullif(new.after->>'url', ''));
  if v_problem is not null then raise exception '%', v_problem using errcode = '23514'; end if;
  return new;
end $$;
revoke all on function change_log_promotion_hold() from public, anon, authenticated;
create trigger change_log_ab_promotion_hold before insert or update of status, after on change_log
  for each row execute function change_log_promotion_hold();

-- A planner slot (any planner, automated or not) for a held offering is
-- kept and marked blocked with the reason; drafting refuses blocked slots.
create function content_plan_items_promotion_hold() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_problem text;
begin
  if new.hold is not null then return new; end if;
  if not exists (select 1 from client_promotion_holds h where h.client_id = new.client_id and h.status = 'held') then return new; end if;
  v_problem := core_copy_hold(new.client_id, new.brand_workspace_id,
                              concat_ws(' ', new.topic, (select k.keyword from keywords k where k.id = new.keyword_id)),
                              new.service_id, nullif(btrim(coalesce(new.target_url, '')), ''));
  if v_problem is not null then
    new.hold := 'blocked'; new.hold_reason := left(v_problem, 500);
  end if;
  return new;
end $$;
revoke all on function content_plan_items_promotion_hold() from public, anon, authenticated;
create trigger content_plan_items_ab_promotion_hold
  before insert or update of topic, target_url, service_id, keyword_id, hold on content_plan_items
  for each row execute function content_plan_items_promotion_hold();

-- What already matches a client's holds, for the release runbook and the
-- team: nothing here is changed. step says what the gate does next.
create function promotion_hold_conflicts(p_client_id uuid)
returns table (kind text, id uuid, state text, step text, title text, problem text)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from (
    select 'social_post'::text, p.id, p.review_status || '/' || p.publish_status,
           case when p.publish_status = 'published' then 'published: review the live post'
                when p.review_status in ('draft', 'rejected') then 'refused if submitted'
                else 'refused at its next step (approve, schedule, publish) or edit' end,
           left(p.copy, 120),
           core_copy_hold(p.client_id, coalesce(core_site_of_service(p.client_id, p.service_id),
                          case when p.keyword_id is not null then core_site_of_keyword(p.client_id, p.keyword_id) end),
                          concat_ws(' ', p.copy, (select k.keyword from keywords k where k.id = p.keyword_id)),
                          p.service_id, nullif(btrim(coalesce(p.cta_url, '')), ''))
    from social_posts p where p.client_id = p_client_id and p.review_status <> 'rejected'
    union all
    select 'content_draft', d.id, d.status,
           case when d.status in ('draft', 'requested', 'rejected') then 'refused if submitted'
                else 'refused at its next step or edit; a queued release is blocked at claim' end,
           coalesce(d.title, d.topic),
           core_copy_hold(d.client_id, content_draft_program(d), content_draft_hold_text(d), d.service_id,
                          nullif(btrim(coalesce(d.target_url, '')), ''))
    from content_drafts d where d.client_id = p_client_id and d.status <> 'rejected'
    union all
    select 'content_post', c.id, c.status::text, 'published or planned article: review it', c.title,
           core_copy_hold(c.client_id, null, concat_ws(' ', c.title, c.url), null, nullif(btrim(coalesce(c.url, '')), ''))
    from content_posts c where c.client_id = p_client_id
    union all
    select 'content_plan_item', i.id, coalesce(i.hold, 'open'), 'planned slot: marked blocked when next edited', i.topic,
           core_copy_hold(i.client_id, i.brand_workspace_id,
                          concat_ws(' ', i.topic, (select k.keyword from keywords k where k.id = i.keyword_id)),
                          i.service_id, nullif(btrim(coalesce(i.target_url, '')), ''))
    from content_plan_items i where i.client_id = p_client_id and i.content_post_id is null and i.social_post_id is null
  ) x(kind, id, state, step, title, problem)
  where x.problem is not null
  order by 1, 2
$$;
revoke all on function promotion_hold_conflicts(uuid) from public, anon;
grant execute on function promotion_hold_conflicts(uuid) to authenticated, service_role;

-- ── 16. Verify ──────────────────────────────────────────────────────────────
do $verify$
declare missing text;
begin
  select string_agg(f, ', ') into missing from (values
    ('drafter_write(jsonb)', 'core_keyword_gate_v2'),
    ('drafter_write(jsonb)', 'keyword''s owner page'),
    ('social_slot_link(uuid,uuid,text)', 'keyword_owner('),
    ('social_slot_readiness(uuid,date,date)', 'verified owner page'),
    ('core_keyword_lists_guard()', 'core_site_of_keyword'),
    ('core_keyword_grounding(uuid,uuid)', 'core_site_of_keyword'),
    ('core_keyword_social_gate()', 'cta_not_owner'),
    ('core_keyword_draft_gate()', 'owner_page_mismatch'),
    ('core_keyword_change_gate()', 'refresh_not_owner')) v(f, needle)
  where strpos(pg_get_functiondef(('public.' || f)::regprocedure), needle) = 0;
  if missing is not null then raise exception 'owner resolver not applied to: %', missing; end if;
  if strpos(pg_get_viewdef('public.content_plan_board'::regclass), 'core_keyword_eligibility') = 0 then
    raise exception 'owner resolver not applied to content_plan_board';
  end if;
  -- Holds are checked on the copy at every forward step.
  if (select count(*) from pg_trigger where not tgisinternal and tgenabled <> 'D' and tgname in
        ('social_posts_ab_promotion_hold', 'content_drafts_ab_promotion_hold', 'blog_publications_promotion_hold',
         'change_log_ab_promotion_hold', 'content_plan_items_ab_promotion_hold')) <> 5 then
    raise exception 'promotion holds are not checked on every copy path';
  end if;
  -- Security definer helpers stay private; readers are team-only.
  if has_function_privilege('anon', 'keyword_owner(uuid,uuid,uuid,text)', 'execute')
     or has_function_privilege('anon', 'keyword_owner_context(uuid,uuid)', 'execute')
     or has_table_privilege('anon', 'client_service_markets', 'select')
     or has_table_privilege('anon', 'owner_page_checks', 'select')
     or has_table_privilege('anon', 'client_promotion_holds', 'select') then
    raise exception 'owner resolver objects are reachable by anon';
  end if;
end $verify$;
