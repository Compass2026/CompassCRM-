-- Linking a supporting long-tail keyword to the core keyword it serves
-- (Nov 20 2026). Written with its sandbox test
-- (supabase/tests/sandbox/keyword_core_parent_link.test.sql). Needs
-- 20261027191343_weekly_social_slots and 20261028222909_keyword_owner_resolver.
--
-- 20261027191343 added keywords.core_parent_keyword_id and made every weekly
-- and hand-made draft trace to the site's approved core list: a keyword that
-- is a member, or whose named core parent is (core_keyword_grounding). It
-- gave no supported way to name a parent, so a long-tail keyword that plainly
-- serves a core keyword ("solar installers wichita ks" under "solar
-- installation wichita ks": same service, city, intent and page) could never
-- ground a draft. This adds that door, for people only, and an audit trail.
--
--   keyword_core_link_problem(keyword, parent)
--       null when the parent may be the keyword's core parent, else the first
--       reason as 'code: message'. The same check the link uses, the options
--       list filters by and the UI shows for an existing link. Same site
--       program and approved list as the grounding, same service and intent,
--       compatible city / market, and every place the parent's text names
--       named by the keyword too (keyword_core_link_places); one level only.
--   keyword_core_link_options(client)
--       for every active keyword outside its site's approved list: each
--       eligible parent (problem null), and its current link with that
--       link's problem today (a list version may have dropped the parent).
--   keyword_link_core_parent(keyword, parent, reason)
--   keyword_unlink_core_parent(keyword, reason)
--       a signed-in teammate only (is_team() through PostgREST). Link,
--       change or clear the parent, with a reason; every change is one
--       keyword_core_link_events row (who, what, from, to, list version, why).
--   keywords_core_parent_guard
--       core_parent_keyword_id is written only by those two functions: any
--       other insert or update that sets or changes it is refused (42501),
--       the worker's SQL and a teammate's direct PATCH included.
--
-- The gate is unchanged: core_keyword_grounding(), core_keyword_eligibility()
-- and every draft / post / slot gate read the column exactly as before. A link
-- is judged when it is made; later edits to either keyword are not re-judged
-- by the gate (the Keywords tab shows the link's problem today instead).
-- No keyword is linked here.
--
-- Rollback: supabase/rollback/20261120190000_keyword_core_parent_link.down.sql
-- (drops the guard, the functions and the event table; links already
-- made stay on keywords.core_parent_keyword_id and keep grounding drafts).

-- ── 1. The audit trail ──────────────────────────────────────────────────────
create table keyword_core_link_events (
  id bigint generated always as identity primary key,
  client_id uuid not null references clients(id) on delete cascade,
  -- No foreign key on the keywords: the history outlives a deleted keyword.
  keyword_id uuid not null,
  keyword text not null,
  action text not null check (action in ('linked', 'relinked', 'unlinked')),
  previous_parent_id uuid,
  previous_parent_keyword text,
  parent_id uuid,
  parent_keyword text,
  list_id uuid references core_keyword_lists(id),
  list_version integer,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  actor_id uuid not null references team_members(id),
  created_at timestamptz not null default now(),
  check ((action = 'unlinked') = (parent_id is null)),
  check ((action = 'linked') = (previous_parent_id is null)),
  check ((parent_id is null) = (list_id is null) and (list_id is null) = (list_version is null))
);
create index keyword_core_link_events_keyword_idx on keyword_core_link_events (client_id, keyword_id, created_at desc);

create function keyword_core_link_events_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- Append-only. A deleted client takes its history with it (the cascade runs
  -- after the client row is gone).
  if tg_op = 'DELETE' and not exists (select 1 from clients where id = old.client_id) then
    return old;
  end if;
  raise exception 'A core-link event is a record; it is never edited or deleted' using errcode = '42501';
end $$;
revoke all on function keyword_core_link_events_guard() from public, anon, authenticated, service_role;
create trigger keyword_core_link_events_guard before update or delete on keyword_core_link_events
  for each row execute function keyword_core_link_events_guard();

alter table keyword_core_link_events enable row level security;
create policy "team keyword core link events" on keyword_core_link_events to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on keyword_core_link_events from public, anon, authenticated, service_role;
grant select on keyword_core_link_events to authenticated;

-- ── 2. The rule ─────────────────────────────────────────────────────────────
-- The places a keyword names, as normalized place names: those its text names
-- (core_places_in over the place reference, read exactly as
-- site_program_readiness() reads them: the client's and site's names
-- excluded, the client's, locations' and markets' states), plus, with
-- p_recorded, its recorded city and market.
create function keyword_core_link_places(p_keyword_id uuid, p_recorded boolean) returns text[]
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare k keywords; v_client clients; v_prog uuid; v_states text[]; v_exclude text[];
begin
  select * into k from keywords where id = p_keyword_id;
  if k.id is null then return '{}'; end if;
  select * into v_client from clients where id = k.client_id;
  v_prog := core_site_of_keyword(k.client_id, k.id);
  v_exclude := array(select distinct core_place_norm(t)
                       from regexp_split_to_table(lower(v_client.name || ' ' || coalesce((select w.name from client_brand_workspaces w where w.id = v_prog), '')), '[^a-z'']+') t
                      where length(replace(t, '''', '')) >= 4);
  v_states := array(select distinct x from (
                select upper(btrim(v_client.state)) x
                union all select upper(btrim(lo.state)) from locations lo where lo.client_id = v_client.id and lo.is_active
                union all select upper(btrim(m.state)) from client_service_markets m
                 where m.client_id = v_client.id and (m.brand_workspace_id is null or m.brand_workspace_id is not distinct from v_prog)) s
                where x ~ '^[A-Z]{2}$');
  return array(select distinct x from (
           select p.norm x from core_places_in(k.keyword, v_states, v_exclude) p
           union all select core_place_norm(k.city) where p_recorded
           union all select core_place_norm(m.city) from client_service_markets m where p_recorded and m.id = k.market_id) s
         where x is not null order by x);
end $$;
revoke all on function keyword_core_link_places(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function keyword_core_link_places(uuid, boolean) to authenticated;

-- May p_parent_id be p_keyword_id's core parent? null = yes. First failing
-- check wins:
--   keyword_unknown, keyword_inactive, parent_is_self, parent_unknown,
--   parent_other_client, parent_inactive, program_unresolved, parent_wrong_site,
--   core_list_missing, parent_not_core, keyword_is_core, parent_has_parent,
--   keyword_has_children, service_missing, service_mismatch, intent_missing,
--   intent_mismatch, market_mismatch, city_mismatch, place_mismatch
-- The site program and its approved list are found exactly as
-- core_keyword_grounding() finds them (core_site_of_keyword; for a single-site
-- client the client's list). p_places = false stops before place_mismatch;
-- only keyword_core_link_options uses that, and applies the same place test
-- itself over the same helper (so each keyword's places are read once).
create function keyword_core_link_problem(p_keyword_id uuid, p_parent_id uuid, p_places boolean default true) returns text
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  k keywords; pk keywords; v_multi boolean; v_prog uuid; l core_keyword_lists;
  v_named text[]; v_mine text[];
begin
  select * into k from keywords where id = p_keyword_id;
  if k.id is null then return 'keyword_unknown: the keyword does not exist.'; end if;
  if not k.is_active then return 'keyword_inactive: the keyword is inactive.'; end if;
  if p_parent_id is not distinct from k.id then return 'parent_is_self: a keyword is not its own core parent.'; end if;
  select * into pk from keywords where id = p_parent_id;
  if pk.id is null then return 'parent_unknown: the core keyword does not exist.'; end if;
  if pk.client_id <> k.client_id then return 'parent_other_client: the core keyword belongs to another client.'; end if;
  if not pk.is_active then return 'parent_inactive: the core keyword is inactive.'; end if;

  v_multi := exists (select 1 from client_brand_workspaces w where w.client_id = k.client_id);
  v_prog := core_site_of_keyword(k.client_id, k.id);
  if v_multi and v_prog is null then
    return 'program_unresolved: the keyword belongs to no single brand site.';
  end if;
  if v_multi and core_site_of_keyword(k.client_id, pk.id) is distinct from v_prog then
    return 'parent_wrong_site: the core keyword belongs to another brand site.';
  end if;
  select * into l from core_keyword_lists x
   where x.client_id = k.client_id and x.status = 'approved' and x.brand_workspace_id is not distinct from v_prog;
  if l.id is null then
    return 'core_list_missing: the keyword''s site has no approved core keyword list.';
  end if;
  if not (pk.id = any(l.keyword_ids)) then
    return format('parent_not_core: the parent is not in the approved core keyword list (v%s).', l.version);
  end if;
  if k.id = any(l.keyword_ids) then
    return format('keyword_is_core: the keyword is itself in the approved core keyword list (v%s).', l.version);
  end if;
  if pk.core_parent_keyword_id is not null then
    return 'parent_has_parent: the core keyword names a core parent of its own; links are one level.';
  end if;
  if exists (select 1 from keywords c where c.core_parent_keyword_id = k.id) then
    return 'keyword_has_children: other keywords name this keyword as their core parent; links are one level.';
  end if;
  if k.service_id is null then return 'service_missing: the keyword names no service.'; end if;
  if pk.service_id is distinct from k.service_id then
    return 'service_mismatch: the core keyword is for another service.';
  end if;
  if k.intent is null then return 'intent_missing: the keyword has no recorded intent.'; end if;
  if pk.intent is distinct from k.intent then
    return format('intent_mismatch: the keyword is %s, the core keyword %s.', k.intent, coalesce(pk.intent, 'unlabelled'));
  end if;
  if pk.market_id is not null and k.market_id is distinct from pk.market_id then
    return 'market_mismatch: the core keyword names another market.';
  end if;
  if nullif(btrim(pk.city), '') is not null and lower(btrim(coalesce(k.city, ''))) <> lower(btrim(pk.city)) then
    return format('city_mismatch: the core keyword is for %s, the keyword for %s.', btrim(pk.city), coalesce(nullif(btrim(k.city), ''), 'no city'));
  end if;
  -- A parent with no recorded city can still name one in its text ("solar
  -- panels for homes overland park ks"): every place its text names must be
  -- one the keyword names too (its text, city or market).
  if p_places then
    v_named := keyword_core_link_places(pk.id, false);
    if cardinality(v_named) > 0 then
      v_mine := keyword_core_link_places(k.id, true);
      if not (v_named <@ v_mine) then
        return format('place_mismatch: the core keyword names %s; the keyword does not.',
                      (select string_agg(initcap(x), ', ' order by x) from unnest(v_named) x where not (x = any(v_mine))));
      end if;
    end if;
  end if;
  return null;
end $$;
revoke all on function keyword_core_link_problem(uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function keyword_core_link_problem(uuid, uuid, boolean) to authenticated;

-- What the Keywords tab offers: per active keyword outside its site's approved
-- list, each eligible parent (current = false, problem null) and its current
-- link (current = true, problem = the link's problem today, null when sound).
-- Candidates share service and intent, pass every other check, and then the
-- place test (named <@ mine), with each keyword's places read once.
create function keyword_core_link_options(p_client_id uuid)
returns table (keyword_id uuid, parent_id uuid, parent_keyword text, parent_city text,
               list_version integer, is_current boolean, problem text)
language sql stable security invoker set search_path = public, pg_temp as $$
  with approved as (
    select l.id, l.version, l.keyword_ids from core_keyword_lists l
     where l.client_id = p_client_id and l.status = 'approved'
  ),
  pairs as materialized (
    select k.id as kid, pk.id as pid, pk.keyword, pk.city, a.version
      from keywords k
      join approved a on true
      join keywords pk on pk.client_id = k.client_id and pk.id = any(a.keyword_ids)
                      and pk.service_id = k.service_id and pk.intent = k.intent
     where k.client_id = p_client_id and k.is_active
       and pk.id is distinct from k.core_parent_keyword_id
       and keyword_core_link_problem(k.id, pk.id, false) is null
  ),
  named as materialized (
    select x.id, keyword_core_link_places(x.id, false) as places from (select distinct pid as id from pairs) x
  ),
  mine as materialized (
    select x.id, keyword_core_link_places(x.id, true) as places
      from (select distinct p.kid as id from pairs p join named n on n.id = p.pid where cardinality(n.places) > 0) x
  )
  select p.kid, p.pid, p.keyword, p.city, p.version, false, null::text
    from pairs p
    join named n on n.id = p.pid
    left join mine m on m.id = p.kid
   where cardinality(n.places) = 0 or n.places <@ m.places
  union all
  select k.id, pk.id, pk.keyword, pk.city,
         (select a.version from approved a where pk.id = any(a.keyword_ids) order by a.version desc limit 1),
         true, keyword_core_link_problem(k.id, pk.id)
    from keywords k
    join keywords pk on pk.id = k.core_parent_keyword_id and pk.client_id = k.client_id
   where k.client_id = p_client_id
  order by 1, 6 desc, 3
$$;
revoke all on function keyword_core_link_options(uuid) from public, anon, authenticated, service_role;
grant execute on function keyword_core_link_options(uuid) to authenticated;

-- ── 3. The only writers ─────────────────────────────────────────────────────
create function keyword_core_link_caller() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- A person through PostgREST: authenticator + authenticated, on team_members.
  if not coalesce((select is_team()), false) or not post_caller_is_human() then
    raise exception 'not_team: only a signed-in teammate links a keyword to its core keyword' using errcode = '42501';
  end if;
  return task_actor();
end $$;
revoke all on function keyword_core_link_caller() from public, anon, authenticated, service_role;

create function keyword_link_core_parent(p_keyword_id uuid, p_parent_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := keyword_core_link_caller();
  v_reason text := btrim(coalesce(p_reason, ''));
  k keywords; pk keywords; prev keywords; l core_keyword_lists; v_problem text; v_action text;
begin
  if length(v_reason) not between 3 and 500 then
    raise exception 'reason_required: say why the keyword serves that core keyword (3 to 500 characters)' using errcode = '22023';
  end if;
  if p_keyword_id is null or p_parent_id is null then
    raise exception 'Name the keyword and its core keyword; keyword_unlink_core_parent clears a link' using errcode = '22023';
  end if;
  select * into k from keywords where id = p_keyword_id;
  if k.id is null then
    raise exception 'keyword_unknown: the keyword does not exist.' using errcode = '22023';
  end if;
  -- One link change per client at a time; both rows locked in id order.
  perform pg_advisory_xact_lock(hashtextextended('core-parent:' || k.client_id::text, 0));
  perform 1 from keywords where id in (p_keyword_id, p_parent_id) order by id for update;
  select * into k from keywords where id = p_keyword_id;
  v_problem := keyword_core_link_problem(p_keyword_id, p_parent_id);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  select * into pk from keywords where id = p_parent_id;
  select * into l from core_keyword_lists x
   where x.client_id = k.client_id and x.status = 'approved'
     and x.brand_workspace_id is not distinct from core_site_of_keyword(k.client_id, k.id);
  if k.core_parent_keyword_id is not distinct from p_parent_id then
    return jsonb_build_object('changed', false, 'keyword_id', k.id, 'parent_id', pk.id, 'list_id', l.id, 'list_version', l.version);
  end if;
  v_action := case when k.core_parent_keyword_id is null then 'linked' else 'relinked' end;
  select * into prev from keywords where id = k.core_parent_keyword_id;

  perform set_config('compass.core_parent_link', 'on', true);
  update keywords set core_parent_keyword_id = pk.id where id = k.id;
  perform set_config('compass.core_parent_link', '', true);

  insert into keyword_core_link_events (client_id, keyword_id, keyword, action, previous_parent_id, previous_parent_keyword,
                                        parent_id, parent_keyword, list_id, list_version, reason, actor_id)
  values (k.client_id, k.id, k.keyword, v_action, prev.id, prev.keyword, pk.id, pk.keyword, l.id, l.version, v_reason, v_actor);
  return jsonb_build_object('changed', true, 'action', v_action, 'keyword_id', k.id, 'parent_id', pk.id,
                            'previous_parent_id', prev.id, 'list_id', l.id, 'list_version', l.version);
end $$;
revoke all on function keyword_link_core_parent(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function keyword_link_core_parent(uuid, uuid, text) to authenticated;

create function keyword_unlink_core_parent(p_keyword_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := keyword_core_link_caller();
  v_reason text := btrim(coalesce(p_reason, ''));
  k keywords; prev keywords;
begin
  if length(v_reason) not between 3 and 500 then
    raise exception 'reason_required: say why the link is cleared (3 to 500 characters)' using errcode = '22023';
  end if;
  select * into k from keywords where id = p_keyword_id;
  if k.id is null then
    raise exception 'keyword_unknown: the keyword does not exist.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('core-parent:' || k.client_id::text, 0));
  select * into k from keywords where id = p_keyword_id for update;
  if k.core_parent_keyword_id is null then
    return jsonb_build_object('changed', false, 'keyword_id', k.id);
  end if;
  select * into prev from keywords where id = k.core_parent_keyword_id;

  perform set_config('compass.core_parent_link', 'on', true);
  update keywords set core_parent_keyword_id = null where id = k.id;
  perform set_config('compass.core_parent_link', '', true);

  insert into keyword_core_link_events (client_id, keyword_id, keyword, action, previous_parent_id, previous_parent_keyword, reason, actor_id)
  values (k.client_id, k.id, k.keyword, 'unlinked', prev.id, prev.keyword, v_reason, v_actor);
  return jsonb_build_object('changed', true, 'action', 'unlinked', 'keyword_id', k.id, 'previous_parent_id', prev.id);
end $$;
revoke all on function keyword_unlink_core_parent(uuid, text) from public, anon, authenticated, service_role;
grant execute on function keyword_unlink_core_parent(uuid, text) to authenticated;

-- ── 4. The column has no other writer ───────────────────────────────────────
create function keywords_core_parent_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if ((tg_op = 'INSERT' and new.core_parent_keyword_id is not null)
      or (tg_op = 'UPDATE' and new.core_parent_keyword_id is distinct from old.core_parent_keyword_id))
     and coalesce(current_setting('compass.core_parent_link', true), '') <> 'on' then
    raise exception 'core_parent_link_required: a keyword''s core parent is set, changed or cleared only through keyword_link_core_parent / keyword_unlink_core_parent (a signed-in teammate, audited)'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function keywords_core_parent_guard() from public, anon, authenticated, service_role;
create trigger keywords_core_parent_guard before insert or update of core_parent_keyword_id on keywords
  for each row execute function keywords_core_parent_guard();

-- ── 5. Verify ───────────────────────────────────────────────────────────────
do $verify$
declare f text;
begin
  foreach f in array array['keyword_link_core_parent(uuid, uuid, text)', 'keyword_unlink_core_parent(uuid, text)',
                           'keyword_core_link_problem(uuid, uuid, boolean)', 'keyword_core_link_places(uuid, boolean)',
                           'keyword_core_link_options(uuid)'] loop
    if has_function_privilege('anon', 'public.' || f, 'execute')
       or has_function_privilege('service_role', 'public.' || f, 'execute')
       or not has_function_privilege('authenticated', 'public.' || f, 'execute')
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = ('public.' || f)::regprocedure and a.grantee = 0) then
      raise exception 'keyword core link: % must be executable by authenticated only', f;
    end if;
  end loop;
  foreach f in array array['keyword_core_link_caller()', 'keywords_core_parent_guard()', 'keyword_core_link_events_guard()'] loop
    if has_function_privilege('anon', 'public.' || f, 'execute') or has_function_privilege('authenticated', 'public.' || f, 'execute')
       or has_function_privilege('service_role', 'public.' || f, 'execute') then
      raise exception 'keyword core link: % must not be callable through the API', f;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.keyword_core_link_events', 'select')
     or has_table_privilege('authenticated', 'public.keyword_core_link_events', 'insert')
     or has_table_privilege('authenticated', 'public.keyword_core_link_events', 'update')
     or has_table_privilege('authenticated', 'public.keyword_core_link_events', 'delete')
     or not exists (select 1 from pg_class where oid = 'public.keyword_core_link_events'::regclass and relrowsecurity) then
    raise exception 'keyword core link: the event table is team read-only behind RLS';
  end if;
end $verify$;
