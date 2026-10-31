-- Core 50-aware Authority input (COMPASS-2027-ROADMAP P1.3, Executive OS task
-- c1fbff44). Written with its sandbox test (authority_core_scope.test.sql)
-- and the engine's gate (supabase/functions/authority/core.ts). Needs
-- 20261028222909_keyword_owner_resolver and 20261029200000_site_program_readiness.
--
-- authority_input() is client-wide: it hands the engine every keyword the
-- client has, so an off-list, retired or other-brand keyword could become a
-- Ready Business Profile post. The draft gates refuse such a post later;
-- this makes discovery itself site-specific.
--
--   authority_core_scope(client)   one read-only answer per site program:
--       its approved Core 50 (list id, version, approval, sorted keyword
--       ids), or why there is none (proposed_only / missing), and for every
--       keyword the approved list grounds (a list member, or an active child
--       whose active core parent is one) the owner verdict per purpose and
--       the places its text names. Grounding is core_keyword_grounding()
--       itself; owners are keyword_owner() itself; places are
--       core_places_in() over place_reference_status() exactly as
--       site_program_readiness() reads them. Nothing is re-derived.
--   authority_input_scoped(client) authority_input() with authority.core
--       set to the above. authority-run reads this one. authority_input()
--       is left byte-identical for every other caller.
--   authority_fingerprint(client)  gains a 'core' section (lists, list
--       membership, keyword core fields, markets, holds, exemptions, owner
--       checks), so approving a list or recording a market marks the latest
--       run stale. Patched in place on its exact definition; any other
--       definition refuses the migration.
--
-- Reads only. No keyword, list, market, hold, draft, post, approval, slot,
-- schedule or publication is written, and no run is started.
--
-- Rollback: supabase/rollback/20261030190000_authority_core_scope.down.sql
-- (restores the 0048 fingerprint, drops the two functions).

-- ── 1. The scope ────────────────────────────────────────────────────────────
create function authority_core_scope(p_client_id uuid) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  c clients;
  v_multi boolean;
  v_geo_status jsonb;
  v_geo boolean;
  prog record;
  la core_keyword_lists;
  lp core_keyword_lists;
  v_states text[];
  v_exclude text[];
  v_programs jsonb := '[]';
  v_keywords jsonb := '[]';
  v_kw jsonb;
begin
  -- The same door as authority_input(): a signed-in teammate, or the
  -- authority-run function (authenticator + service_role).
  if not (coalesce((select is_team()), false)
          or (session_user = 'authenticator' and coalesce(current_setting('role', true), '') = 'service_role')) then
    raise exception 'Authority is team-only' using errcode = '42501';
  end if;
  select * into c from clients where id = p_client_id;
  if c.id is null then return null; end if;

  v_multi := exists (select 1 from client_brand_workspaces w where w.client_id = c.id);
  v_geo_status := place_reference_status();
  v_geo := coalesce((v_geo_status->>'ok')::boolean, false);

  for prog in
    select w.id, w.name, w.website_url as site_url, w.service_ids
      from client_brand_workspaces w where w.client_id = c.id
    union all
    select null::uuid, c.name, c.website_url, null::uuid[] where not v_multi
    order by 2, 1
  loop
    la := null; lp := null;
    select * into la from core_keyword_lists x
     where x.client_id = c.id and x.brand_workspace_id is not distinct from prog.id and x.status = 'approved'
     order by x.version desc limit 1;
    -- The newest proposal newer than the approved list (or the newest
    -- proposal when nothing is approved): shown, never used.
    select * into lp from core_keyword_lists x
     where x.client_id = c.id and x.brand_workspace_id is not distinct from prog.id and x.status = 'proposed'
       and (la.id is null or x.version > la.version)
     order by x.version desc limit 1;

    v_programs := v_programs || jsonb_build_object(
      'program_id', prog.id, 'name', prog.name, 'website_url', prog.site_url,
      'service_ids', (select to_jsonb(array_agg(s order by s)) from unnest(prog.service_ids) s),
      'status', case when la.id is not null then 'approved' when lp.id is not null then 'proposed_only' else 'missing' end,
      'list', case when la.id is not null then jsonb_build_object(
                'id', la.id, 'version', la.version, 'approved_at', la.approved_at,
                'keyword_ids', (select to_jsonb(array_agg(distinct x order by x)) from unnest(la.keyword_ids) x)) end,
      'proposal', case when lp.id is not null then jsonb_build_object(
                'id', lp.id, 'version', lp.version, 'proposed_at', lp.proposed_at,
                'count', (select count(distinct x) from unnest(lp.keyword_ids) x)) end);

    if la.id is null then continue; end if;

    v_exclude := array(select distinct core_place_norm(t) from regexp_split_to_table(lower(c.name || ' ' || coalesce(prog.name, '')), '[^a-z'']+') t
                        where length(replace(t, '''', '')) >= 4);
    v_states := array(select distinct x from (
                  select upper(btrim(c.state)) x
                  union all select upper(btrim(lo.state)) from locations lo where lo.client_id = c.id and lo.is_active
                  union all select upper(btrim(m.state)) from client_service_markets m
                   where m.client_id = c.id and (m.brand_workspace_id is null or m.brand_workspace_id is not distinct from prog.id)) s
                  where x ~ '^[A-Z]{2}$');

    -- Every active keyword this program's approved list grounds, by
    -- core_keyword_grounding() itself (its program is the keyword's own).
    with grounded as materialized (
      select k.id, k.keyword, k.intent, k.service_id, k.market_id, k.city, k.core_parent_keyword_id, g.list_id, g.list_version, g.core_keyword_id
        from keywords k
        cross join lateral core_keyword_grounding(c.id, k.id) g
       where k.client_id = c.id and k.is_active
         -- only candidates (members and their children) are grounded; the
         -- grounding function itself decides
         and (k.id = any(la.keyword_ids) or k.core_parent_keyword_id = any(la.keyword_ids))
         and g.list_id = la.id),
    owned as materialized (
      select gr.*, keyword_owner(c.id, prog.id, gr.id, null) as o from grounded gr),
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
        from owned o),
    judged as (
      -- keyword_owner(…, purpose) is keyword_owner(…, null) plus the purpose
      -- tail; the eligibility gate also refuses a keyword with no intent.
      select g.*,
             case when g.intent is null then 'intent_missing'
                  when g.o->>'problem_code' is not null then g.o->>'problem_code'
                  when not core_owner_allows(g.o->>'role', 'post', g.intent) then 'owner_role_not_allowed' end as post_code,
             case when g.intent is null then 'intent_missing'
                  when g.o->>'problem_code' is not null then g.o->>'problem_code'
                  when g.o->>'role' = 'blog' then 'keyword_already_owned'
                  when not core_owner_allows(g.o->>'role', 'blog', g.intent) then 'owner_role_not_allowed' end as blog_code,
             case when g.intent is null then 'intent_missing'
                  when g.o->>'problem_code' is not null then g.o->>'problem_code'
                  when not core_owner_allows(g.o->>'role', 'refresh', g.intent) then 'owner_role_not_allowed' end as refresh_code,
             -- The owner page's latest check, read as keyword_owner() reads it (an
             -- http soft_404 defers to the latest rendered check). A new page
             -- may be proposed only over a confirmed absence (verdict missing).
             (select jsonb_build_object('verdict', x.verdict, 'method', x.method, 'checked_at', x.checked_at)
                from (select h.id, (h.method = 'http' and h.verdict = 'soft_404') as soft
                        from owner_page_checks h where h.client_id = c.id and h.url_norm = g.o->>'url'
                       order by h.checked_at desc, h.id desc limit 1) f
                cross join lateral (
                  select r.verdict, r.method, r.checked_at from owner_page_checks r
                   where r.client_id = c.id and r.url_norm = g.o->>'url'
                     and (r.id = f.id or (f.soft and r.method = 'rendered'))
                   order by (r.method = 'rendered') desc, r.checked_at desc, r.id desc limit 1) x) as page_check,
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
    select coalesce(jsonb_agg(jsonb_build_object(
             'keyword_id', j.id, 'keyword', j.keyword, 'program_id', prog.id,
             'relation', case when j.core_keyword_id = j.id then 'core' else 'child' end,
             'list_id', j.list_id, 'list_version', j.list_version, 'core_keyword_id', j.core_keyword_id,
             'service_id', j.service_id, 'intent', j.intent,
             'owner', jsonb_build_object('url', j.o->>'url', 'role', j.o->>'role', 'market_id', j.o->>'market_id',
                                         'market', j.o->>'market', 'problem_code', j.o->>'problem_code', 'problem', j.o->>'problem',
                                         'check', j.page_check),
             'purposes', jsonb_build_object('post', j.post_code, 'blog', j.blog_code, 'refresh', j.refresh_code),
             'geography', j.geography, 'places', coalesce(j.places, '[]'), 'structured_city', j.structured_city)
             order by (j.core_keyword_id <> j.id), j.id), '[]')
      into v_kw from judged j;
    v_keywords := v_keywords || v_kw;
  end loop;

  return jsonb_build_object(
    'schema', 'authority-core-v1',
    'client_id', c.id,
    'multi', v_multi,
    'exempt', core_keyword_exempt(c.id),
    'reference', jsonb_build_object('ok', v_geo, 'problem', v_geo_status->>'problem'),
    'programs', v_programs,
    'keywords', v_keywords,
    'active_keywords', (select count(*) from keywords k where k.client_id = c.id and k.is_active),
    'off_list', (select count(*) from keywords k where k.client_id = c.id and k.is_active
                   and not exists (select 1 from jsonb_array_elements(v_keywords) e where (e->>'keyword_id')::uuid = k.id)));
end $$;
revoke all on function authority_core_scope(uuid) from public, anon;
grant execute on function authority_core_scope(uuid) to authenticated, service_role;

-- ── 2. The scoped input ─────────────────────────────────────────────────────
-- authority_input() with authority.core. Both halves carry the team door.
create function authority_input_scoped(p_client_id uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select case when i is null then null else jsonb_set(i, '{authority,core}', coalesce(authority_core_scope(p_client_id), 'null')) end
    from authority_input(p_client_id) i
$$;
revoke all on function authority_input_scoped(uuid) from public, anon;
grant execute on function authority_input_scoped(uuid) to authenticated, service_role;

-- ── 3. The fingerprint's core section ───────────────────────────────────────
-- Source rows only (cheap: authority_latest calls this per client). Owner
-- checks age on the clock; a newer check is what changes them here.
do $migration$
declare
  definition text := pg_get_functiondef('public.authority_fingerprint(uuid)'::regprocedure);
  anchor text := $a$    'site',         md5(coalesce((select j->'authority'->'site' from i), 'null')::text)
  ));$a$;
  patched text := $p$    'site',         md5(coalesce((select j->'authority'->'site' from i), 'null')::text),
    'core',         md5(jsonb_build_array(
                      (select jsonb_agg(jsonb_build_array(l.id, l.version, l.status, l.brand_workspace_id, l.keyword_ids) order by l.id)
                         from core_keyword_lists l where l.client_id = p_client_id),
                      (select jsonb_agg(jsonb_build_array(w.id, w.service_ids, w.website_url) order by w.id)
                         from client_brand_workspaces w where w.client_id = p_client_id),
                      (select jsonb_agg(jsonb_build_array(k.id, k.is_active, k.intent, k.service_id, k.target_url, k.city, k.market_id, k.core_parent_keyword_id) order by k.id)
                         from keywords k where k.client_id = p_client_id),
                      (select jsonb_agg(jsonb_build_array(m.id, m.status, m.city, m.state, m.brand_workspace_id) order by m.id)
                         from client_service_markets m where m.client_id = p_client_id),
                      (select jsonb_agg(jsonb_build_array(h.id, h.status, h.phrases, h.service_ids, h.brand_workspace_id) order by h.id)
                         from client_promotion_holds h where h.client_id = p_client_id),
                      core_keyword_exempt(p_client_id),
                      (select max(ck.checked_at) from owner_page_checks ck where ck.client_id = p_client_id))::text)
  ));$p$;
begin
  if strpos(definition, '''core''') > 0 then return; end if;
  if md5(definition) <> '308d62000db95bcab28f778c82447b9e'
     or (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) then
    raise exception 'Unexpected authority_fingerprint definition (md5 %); review before applying the core scope', md5(definition);
  end if;
  execute replace(definition, anchor, patched);
end;
$migration$;

-- ── 4. Verify ───────────────────────────────────────────────────────────────
do $verify$
declare f text;
begin
  foreach f in array array['authority_core_scope(uuid)', 'authority_input_scoped(uuid)', 'authority_fingerprint(uuid)'] loop
    if (select provolatile from pg_proc where oid = ('public.' || f)::regprocedure) <> 's'
       or (select prosecdef from pg_proc where oid = ('public.' || f)::regprocedure) then
      raise exception '% must be STABLE and security invoker', f;
    end if;
    if has_function_privilege('anon', 'public.' || f, 'execute') then
      raise exception 'anon can execute %', f;
    end if;
  end loop;
  if md5(pg_get_functiondef('public.authority_input(uuid)'::regprocedure)) <> '22629a4e4cd3dbb1b8447c67bbb18a20' then
    raise exception 'authority_input() is not the reviewed definition; it must stay byte-identical';
  end if;
  if strpos(pg_get_functiondef('public.authority_fingerprint(uuid)'::regprocedure), '''core''') = 0 then
    raise exception 'authority_fingerprint() has no core section';
  end if;
end;
$verify$;
