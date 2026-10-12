-- Multiple customer-facing brands under one existing client/agreement.
-- Content is scoped by its governed service, never by a caller-supplied logo.
create table client_brand_workspaces (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  website_url text not null check (website_url ~ '^https://[^/[:space:]]+'),
  phone text not null check (length(btrim(phone)) between 7 and 40),
  positioning text not null default '', voice_tone text not null default '',
  audience text not null default '', tagline text not null default '',
  differentiators text not null default '', ai_guidance text not null default '',
  imagery_style text not null default '', typography_notes text not null default '',
  words_we_use text[] not null default '{}', words_we_avoid text[] not null default '{}',
  content_pillars text[] not null default '{}', hard_rules text[] not null default '{}',
  standing_cta text not null default '',
  palette jsonb not null default '[]' check (jsonb_typeof(palette)='array'),
  service_ids uuid[] not null default '{}', claim_ids uuid[] not null default '{}',
  asset_ids uuid[] not null default '{}',
  blog_site_id uuid references sites(id),
  facebook_account_id uuid references social_accounts(id),
  status text not null default 'draft' check (status in ('draft','approved')),
  version integer not null default 1 check (version>0),
  approved_by uuid references team_members(id), approved_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(client_id,slug),
  check ((status='approved')=(approved_by is not null and approved_at is not null))
);
create index client_brand_workspaces_client_idx on client_brand_workspaces(client_id);
create unique index client_brand_workspaces_facebook_unique on client_brand_workspaces(facebook_account_id)
  where facebook_account_id is not null;
alter table client_brand_workspaces enable row level security;
create policy "team brand workspaces" on client_brand_workspaces to authenticated
  using ((select is_team())) with check ((select is_team()));
revoke all on client_brand_workspaces from public,anon,authenticated;
grant select,insert,update,delete on client_brand_workspaces to authenticated;
grant all on client_brand_workspaces to service_role;

create function brand_workspace_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare changed boolean; actor uuid;
begin
  -- Serialise ownership checks even when two teammates edit different brands.
  perform pg_advisory_xact_lock(hashtextextended('brand-workspace:'||coalesce(new.client_id,old.client_id)::text,0));
  if tg_op='DELETE' then
    if exists(select 1 from clients where id=old.client_id) then
      raise exception 'Brand workspaces are retained with their content history' using errcode='23514';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' and (new.id,new.client_id,new.slug) is distinct from (old.id,old.client_id,old.slug) then
    raise exception 'Brand identity is immutable' using errcode='23514';
  end if;
  if exists(select 1 from unnest(new.service_ids) x where x is null or not exists(select 1 from services where id=x and client_id=new.client_id))
    or exists(select 1 from unnest(new.claim_ids) x where x is null or not exists(select 1 from claims where id=x and client_id=new.client_id))
    or exists(select 1 from unnest(new.asset_ids) x where x is null or not exists(select 1 from brand_assets where id=x and client_id=new.client_id)) then
    raise exception 'Every service, claim and asset must belong to this client' using errcode='23514';
  end if;
  if exists(select 1 from client_brand_workspaces where client_id=new.client_id and id<>new.id and service_ids && new.service_ids) then
    raise exception 'A service has one owning brand; resolve the existing assignment first' using errcode='23514';
  end if;
  if new.blog_site_id is not null and not exists(select 1 from sites where id=new.blog_site_id and client_id=new.client_id
    and lower(regexp_replace(split_part(url,'/',3),'^www\.',''))=lower(regexp_replace(split_part(new.website_url,'/',3),'^www\.',''))) then
    raise exception 'The blog site must belong to this client and match the brand website' using errcode='23514';
  end if;
  if new.facebook_account_id is not null and not exists(select 1 from social_accounts where id=new.facebook_account_id
    and client_id=new.client_id and platform='facebook') then
    raise exception 'The Facebook Page must belong to this client' using errcode='23514';
  end if;
  if tg_op='INSERT' then
    if new.status<>'draft' or new.approved_by is not null or new.approved_at is not null then
      raise exception 'New brand workspaces start as drafts' using errcode='23514';
    end if;
    new.version:=1;
  else
    changed := (to_jsonb(new)-array['version','status','approved_by','approved_at','updated_at','created_at'])
      is distinct from (to_jsonb(old)-array['version','status','approved_by','approved_at','updated_at','created_at']);
    new.version:=old.version;
    new.created_at:=old.created_at;
    if changed then
      new.version:=old.version+1; new.status:='draft'; new.approved_by:=null; new.approved_at:=null;
    elsif new.status='approved' and old.status<>'approved' then
      if not post_caller_is_human() then raise exception 'Only a signed-in teammate approves a brand' using errcode='42501'; end if;
      if btrim(new.positioning)='' or btrim(new.voice_tone)='' or btrim(new.standing_cta)='' or cardinality(new.hard_rules)=0 then
        raise exception 'Complete positioning, voice, CTA and hard rules before approving' using errcode='23514';
      end if;
      select id into actor from team_members where auth_user_id=auth.uid();
      new.approved_by:=actor; new.approved_at:=now();
    elsif new.status='draft' then new.approved_by:=null; new.approved_at:=null;
    elsif (new.approved_by,new.approved_at) is distinct from (old.approved_by,old.approved_at) then
      raise exception 'Approval attribution is not editable' using errcode='42501';
    end if;
  end if;
  new.updated_at:=now(); return new;
end $$;
revoke all on function brand_workspace_guard() from public,anon,authenticated;
create trigger brand_workspace_guard before insert or update or delete on client_brand_workspaces
  for each row execute function brand_workspace_guard();

-- Legacy clients return exactly the original input. Multi-brand clients must
-- resolve a service owner; there is no fallback to their old umbrella board.
create function client_intelligence_for_content(p_client_id uuid,p_service_id uuid) returns jsonb
language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare i jsonb; b client_brand_workspaces;
begin
  i:=client_intelligence_input(p_client_id);
  if not exists(select 1 from client_brand_workspaces where client_id=p_client_id) then return i; end if;
  select * into b from client_brand_workspaces where client_id=p_client_id and p_service_id=any(service_ids);
  if b.id is null then raise exception 'Select a service assigned to a brand before drafting' using errcode='23514'; end if;
  i:=jsonb_set(i,'{client}',i->'client'||jsonb_build_object('name',b.name,'phone',b.phone,'website_url',b.website_url));
  i:=jsonb_set(i,'{brand}',jsonb_build_object('positioning',b.positioning,'voice_tone',b.voice_tone,'audience',b.audience,
    'differentiators',b.differentiators,'ai_guidance',b.ai_guidance,'words_we_use',b.words_we_use,
    'words_we_avoid',b.words_we_avoid,'content_pillars',b.content_pillars,'tagline',b.tagline));
  i:=jsonb_set(i,'{board}',jsonb_build_object('id',b.id,'version',b.version,'status',b.status,'hard_rules',b.hard_rules,'standing_cta',b.standing_cta));
  i:=jsonb_set(i,'{services}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'services') x where (x->>'id')::uuid=any(b.service_ids)),'[]'));
  i:=jsonb_set(i,'{keywords}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'keywords') x where (x->>'service_id')::uuid=any(b.service_ids)),'[]'));
  i:=jsonb_set(i,'{claims}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'claims') x where (x->>'id')::uuid=any(b.claim_ids)),'[]'));
  i:=jsonb_set(i,'{assets}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'assets') x where (x->>'id')::uuid=any(b.asset_ids)),'[]'));
  i:=jsonb_set(i,'{offers}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'offers') x where (x->>'service_id')::uuid=any(b.service_ids)),'[]'));
  i:=jsonb_set(i,'{pageGroups}',coalesce((select jsonb_agg(x) from jsonb_array_elements(i->'pageGroups') x where exists(
    select 1 from jsonb_array_elements(i->'keywords') k where k->>'id'=x->>'primary_keyword_id')),'[]'));
  return i||jsonb_build_object('workspace',jsonb_build_object('id',b.id,'version',b.version,'facebook_account_id',b.facebook_account_id));
end $$;
revoke all on function client_intelligence_for_content(uuid,uuid) from public,anon;
grant execute on function client_intelligence_for_content(uuid,uuid) to authenticated,service_role;

create function brand_content_problems(p_client uuid,p_service uuid,p_brief jsonb) returns text[]
language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare b client_brand_workspaces; v text[]:='{}';
begin
  if not exists(select 1 from client_brand_workspaces where client_id=p_client) then return v; end if;
  select * into b from client_brand_workspaces where client_id=p_client and p_service=any(service_ids);
  if b.id is null then return array['Assign the content service to its brand.']; end if;
  if b.status<>'approved' then v:=v||'Review and approve this brand workspace.'::text; end if;
  if p_brief->'gate'->>'brand_workspace_id' is distinct from b.id::text
     or p_brief->'gate'->>'brand_workspace_version' is distinct from b.version::text then
    v:=v||'The brand or its assignments changed. Regenerate and review this content.'::text;
  end if;
  return v;
end $$;
revoke all on function brand_content_problems(uuid,uuid,jsonb) from public,anon;
grant execute on function brand_content_problems(uuid,uuid,jsonb) to authenticated,service_role;

create function content_site_destination(p_client uuid,p_service uuid) returns jsonb
language sql stable security invoker set search_path=public,pg_temp as $$
  select jsonb_build_object('site_id',st.id,'url',st.url,'repo_url',st.repo_url,'branch',st.branch,
    'content_adapter',st.content_adapter,'content_paths',st.content_paths,'vercel_project',st.vercel_project,
    'controlled_by_compass',st.controlled_by_compass)
  from sites st where st.client_id=p_client and (
    not exists(select 1 from client_brand_workspaces where client_id=p_client)
    or exists(select 1 from client_brand_workspaces b where b.client_id=p_client and p_service=any(b.service_ids)
      and b.blog_site_id=st.id and lower(regexp_replace(split_part(st.url,'/',3),'^www\.',''))=
        lower(regexp_replace(split_part(b.website_url,'/',3),'^www\.',''))))
  order by st.created_at,st.id limit 1
$$;
revoke all on function content_site_destination(uuid,uuid) from public,anon;
grant execute on function content_site_destination(uuid,uuid) to authenticated,service_role;


create or replace function content_draft_problems(d content_drafts) returns text[]
language plpgsql stable security invoker set search_path = public as $$
declare
  v text[] := '{}';
  v_claims int;
  v_unusable int;
begin
  if not exists (select 1 from keywords k where k.id = d.keyword_id and k.client_id = d.client_id and k.is_active
      and k.keyword = d.primary_keyword and k.intent = d.search_intent
      and k.service_id is not distinct from d.service_id) then
    v := v || 'The governed keyword or its mapping changed; create a new request from the current keyword list.'::text;
  end if;
  if nullif(btrim(coalesce(d.title, '')), '') is null then v := v || 'A title is required.'::text; end if;
  if d.slug is null then v := v || 'A slug is required.'::text; end if;
  if nullif(btrim(coalesce(d.meta_title, '')), '') is null then v := v || 'A meta title is required.'::text;
  elsif length(d.meta_title) > 70 then v := v || 'The meta title is over 70 characters.'::text; end if;
  if nullif(btrim(coalesce(d.meta_description, '')), '') is null then v := v || 'A meta description is required.'::text;
  elsif length(d.meta_description) > 170 then v := v || 'The meta description is over 170 characters.'::text; end if;
  if nullif(btrim(coalesce(d.h1, '')), '') is null then v := v || 'An H1 is required.'::text; end if;
  if nullif(btrim(coalesce(d.body_markdown, '')), '') is null then v := v || 'The body is empty.'::text;
  elsif d.deliverable = 'blog' and coalesce(d.word_count, 0) < 300 then v := v || 'A blog body is at least 300 words.'::text; end if;
  select count(*) filter (where cl.status::text = 'confirmed' or (cl.status::text = 'sourced' and nullif(btrim(coalesce(cl.source, '')), '') is not null)),
         count(*) filter (where not (cl.status::text = 'confirmed' or (cl.status::text = 'sourced' and nullif(btrim(coalesce(cl.source, '')), '') is not null)))
    into v_claims, v_unusable
    from content_draft_claims dc join claims cl on cl.id = dc.claim_id where dc.draft_id = d.id;
  if v_unusable > 0 then
    v := v || format('%s linked claim(s) are not confirmed or sourced with a source.', v_unusable);
  end if;
  if coalesce(d.search_intent, 'informational') <> 'navigational' and v_claims = 0 then
    v := v || 'The draft needs at least one confirmed or sourced claim linked.'::text;
  end if;
  v := v || brand_content_problems(d.client_id,d.service_id,d.brief);
  if exists(select 1 from client_brand_workspaces where client_id=d.client_id) and exists(
    select 1 from content_draft_claims dc where dc.draft_id=d.id and not exists(
      select 1 from client_brand_workspaces b where b.client_id=d.client_id and d.service_id=any(b.service_ids) and dc.claim_id=any(b.claim_ids))) then
    v:=v||'A claim is not assigned to this brand.'::text;
  end if;
  return v;
end $$;

create or replace function social_post_grounding_problems(p social_posts) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare
  v_problems text[] := '{}';
  v_usable int := 0;
  v_linked int := 0;
  c record;
  o record;
  v_service_status text;
  v_today date := (now() at time zone 'America/Chicago')::date;
  cr record;
  s record;
begin
  if nullif(btrim(coalesce(p.copy, '')), '') is null then
    v_problems := v_problems || 'The post has no copy.'::text;
  end if;

  for c in
    select cl.claim, cl.status::text as status, cl.source
    from post_claims pc join claims cl on cl.id = pc.claim_id
    where pc.post_id = p.id
  loop
    v_linked := v_linked + 1;
    if c.status = 'confirmed' or (c.status = 'sourced' and nullif(btrim(coalesce(c.source, '')), '') is not null) then
      v_usable := v_usable + 1;
    elsif c.status = 'sourced' then
      v_problems := v_problems || format('Claim "%s" is marked sourced but has no source.', left(c.claim, 80));
    else
      v_problems := v_problems || format('Claim "%s" is unverified; unlink it or verify it.', left(c.claim, 80));
    end if;
  end loop;

  if p.search_intent <> 'navigational' and v_usable = 0 then
    v_problems := v_problems || format('%s %s post needs at least one confirmed or sourced claim.', case when p.search_intent = 'informational' then 'An' else 'A' end, p.search_intent);
  end if;
  if p.search_intent = 'navigational' and v_linked = 0 and not p.crm_facts_only then
    v_problems := v_problems ||
      'A navigational post with no claims must be marked "CRM facts only" (name, phone, website, approved services, service area); otherwise link a claim.'::text;
  end if;

  -- Topic: a standard informational / commercial / transactional post is
  -- about an approved service; a navigational post may be brand-level; an
  -- offer post is about its offer (the service may be null when the offer
  -- is business-wide). keyword_id is always optional.
  if p.post_type = 'standard' and p.search_intent <> 'navigational' and p.service_id is null then
    v_problems := v_problems || format('%s %s post needs an approved service as its topic.', case when p.search_intent = 'informational' then 'An' else 'A' end, p.search_intent);
  end if;
  if p.post_type = 'offer' and p.offer_id is null then
    v_problems := v_problems || 'An offer post needs one of the client''s offers.'::text;
  end if;

  if p.offer_id is not null then
    select status, ends_on into o from offers where id = p.offer_id;
    if o.status is distinct from 'confirmed' then
      v_problems := v_problems || 'The offer is not confirmed.'::text;
    end if;
    if o.ends_on is not null and o.ends_on < v_today then
      v_problems := v_problems || format('The offer ended on %s.', o.ends_on);
    end if;
  end if;

  if p.service_id is not null then
    select status::text into v_service_status from services where id = p.service_id;
    if v_service_status is distinct from 'approved' then
      v_problems := v_problems || format('The service is %s, not approved.', coalesce(v_service_status, 'missing'));
    end if;
  end if;

  -- 0054: creative.
  if p.creative_policy = 'required'
     and not exists (select 1 from post_assets pa where pa.post_id = p.id and pa.creative_asset_id is not null) then
    v_problems := v_problems || 'The post needs its creative before review.'::text;
  end if;
  for cr in
    select ca.id, ca.withdrawn_at, pa.copy_hash
    from post_assets pa join creative_assets ca on ca.id = pa.creative_asset_id where pa.post_id = p.id
  loop
    if cr.withdrawn_at is not null then
      v_problems := v_problems || 'The linked creative was withdrawn; request new creative.'::text;
    end if;
    if cr.copy_hash is distinct from drafter_copy_hash(p.copy) then
      v_problems := v_problems || 'The creative was made for different copy; request new creative.'::text;
    end if;
  end loop;
  for s in
    select src.brand_asset_id, src.source_content_hash, ba.id as current_id, ba.creative_use, ba.content_hash,
           ba.depicts_own_work, src.role
    from post_assets pa
    join creative_asset_sources src on src.creative_asset_id = pa.creative_asset_id
    left join brand_assets ba on ba.id = src.brand_asset_id
    where pa.post_id = p.id
  loop
    if s.current_id is null then
      v_problems := v_problems || 'A source image of the creative was deleted.'::text;
    elsif s.creative_use <> 'approved' then
      v_problems := v_problems || format('A source image of the creative is %s for creative use.', s.creative_use);
    elsif s.content_hash is distinct from s.source_content_hash then
      v_problems := v_problems || 'A source image of the creative changed since the creative was made.'::text;
    elsif s.role = 'photo' and s.depicts_own_work is not true then
      v_problems := v_problems || 'A source photo of the creative is no longer marked as the client''s own work.'::text;
    end if;
  end loop;

  v_problems := v_problems || brand_content_problems(p.client_id,p.service_id,(select brief from drafter_runs where id=p.drafter_run_id));
  if exists(select 1 from client_brand_workspaces where client_id=p.client_id) then
    if p.platform='facebook' and not exists(select 1 from client_brand_workspaces b where b.client_id=p.client_id
      and p.service_id=any(b.service_ids) and b.facebook_account_id=p.social_account_id) then
      v_problems:=v_problems||'Connect and select this brand Facebook Page.'::text;
    end if;
    if exists(select 1 from post_claims pc where pc.post_id=p.id and not exists(select 1 from client_brand_workspaces b
      where b.client_id=p.client_id and p.service_id=any(b.service_ids) and pc.claim_id=any(b.claim_ids))) then
      v_problems:=v_problems||'A claim is not assigned to this brand.'::text;
    end if;
    if exists(select 1 from post_assets pa where pa.post_id=p.id and pa.brand_asset_id is not null and not exists(
      select 1 from client_brand_workspaces b where b.client_id=p.client_id and p.service_id=any(b.service_ids) and pa.brand_asset_id=any(b.asset_ids)))
      or exists(select 1 from post_assets pa join creative_asset_sources cs on cs.creative_asset_id=pa.creative_asset_id
      where pa.post_id=p.id and not exists(select 1 from client_brand_workspaces b where b.client_id=p.client_id
        and p.service_id=any(b.service_ids) and cs.brand_asset_id=any(b.asset_ids))) then
      v_problems:=v_problems||'An image source is not assigned to this brand.'::text;
    end if;
  end if;
  return v_problems;
end $$;

create or replace function content_draft_approve(p_draft_id uuid, p_version int, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d content_drafts;
  v_problems text[];
  v_snapshot jsonb;
  v_post uuid;
  v_created boolean := false;
begin
  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate approves a draft' using errcode = '42501';
  end if;
  select * into d from content_drafts where id = p_draft_id for update;
  if d.id is null then raise exception 'No such draft' using errcode = 'P0002'; end if;
  if d.status = 'approved' and d.approved_version = p_version then
    return jsonb_build_object('draft_id', d.id, 'content_post_id', d.final_content_post_id, 'already', true);
  end if;
  if d.status <> 'in_review' then
    raise exception 'The draft is %; only a draft in review is approved', d.status using errcode = '23514';
  end if;
  if d.version <> p_version then
    raise exception 'The draft changed since you opened it (version % now); reload and review it again', d.version
      using errcode = '40001';
  end if;
  v_problems := content_draft_problems(d);
  if cardinality(v_problems) > 0 then
    raise exception 'The draft cannot be approved: %', array_to_string(v_problems, ' ') using errcode = '23514';
  end if;
  v_snapshot := jsonb_build_object(
    'version', d.version, 'deliverable', d.deliverable, 'page_type', d.page_type,
    'title', d.title, 'slug', d.slug, 'meta_title', d.meta_title, 'meta_description', d.meta_description, 'h1', d.h1,
    'draft_id', d.id, 'client_id', d.client_id, 'plan_item_id', d.plan_item_id,
    'topic', d.topic, 'primary_keyword', d.primary_keyword, 'keyword_id', d.keyword_id,
    'search_intent', d.search_intent, 'service_id', d.service_id,
    'authority_opportunity_id', d.authority_opportunity_id, 'target_url', d.target_url,
    'brief', d.brief, 'brief_hash', d.brief_hash, 'lint', d.lint,
    'destination', content_site_destination(d.client_id,d.service_id),
    'outline', d.outline, 'body_markdown', d.body_markdown, 'body_hash', d.body_hash, 'word_count', d.word_count,
    'internal_links', d.internal_links, 'cta', d.cta, 'structured_data', d.structured_data,
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', cl.id, 'claim', cl.claim, 'status', cl.status, 'source', cl.source) order by cl.id)
                         from content_draft_claims dc join claims cl on cl.id = dc.claim_id where dc.draft_id = d.id), '[]'::jsonb));

  perform set_config('compass.content_draft_system', 'on', true);
  if d.deliverable = 'blog' then
    if d.final_content_post_id is null then
      insert into content_posts (client_id, keyword_id, title, status, word_count, url, due_date, notes, origin)
      values (d.client_id, d.keyword_id, d.title, 'approved', d.word_count, null,
              (select planned_date from content_plan_items where id = d.plan_item_id),
              format('Approved from content draft %s (version %s).', d.id, d.version), 'compass')
      returning id into v_post;
      v_created := true;
    else
      v_post := d.final_content_post_id;
      update content_posts set title = d.title, word_count = d.word_count,
             status = case when status = 'published' then status else 'approved' end,
             notes = format('Approved from content draft %s (version %s).', d.id, d.version)
       where id = v_post;
    end if;
    if d.plan_item_id is not null then
      update content_plan_items set content_post_id = v_post where id = d.plan_item_id and content_post_id is null;
    end if;
    -- The weekly blog task closes with the approval (0068), never earlier.
    if d.source_task_id is not null then
      update tasks set status = 'done' where id = d.source_task_id and status <> 'done';
    end if;
  end if;
  update content_drafts set status = 'approved', approved_version = d.version,
         approved_hash = 'sha256:' || encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex'),
         approved_snapshot = v_snapshot, reviewed_by = task_actor(), reviewed_at = now(),
         review_note = nullif(btrim(coalesce(p_note, '')), ''), final_content_post_id = v_post
   where id = d.id;
  perform set_config('compass.content_draft_system', '', true);
  return jsonb_build_object('draft_id', d.id, 'content_post_id', v_post, 'created', v_created, 'already', false);
end $$;

create or replace function blog_publication_problems(d content_drafts, p_snapshot jsonb) returns text[]
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare v text[] := content_draft_problems(d); dest jsonb; cl jsonb;
begin
  if d.deliverable <> 'blog' or d.status <> 'approved' or d.version <> d.approved_version
     or d.approved_snapshot is distinct from p_snapshot then
    v := v || 'The approved article changed. Review and approve the current version.'::text;
  end if;
  dest := content_site_destination(d.client_id,d.service_id);
  if dest is distinct from p_snapshot->'destination' or coalesce((dest->>'controlled_by_compass')::boolean,false) = false then
    v := v || 'Website destination changed or is not controlled by Compass. Review before publishing.'::text;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'claim',c.claim,'status',c.status,'source',c.source) order by c.id),'[]'::jsonb)
    into cl from content_draft_claims dc join claims c on c.id = dc.claim_id where dc.draft_id = d.id;
  if cl is distinct from p_snapshot->'claims' then v := v || 'Supporting evidence changed since approval.'::text; end if;
  return v;
end $$;
