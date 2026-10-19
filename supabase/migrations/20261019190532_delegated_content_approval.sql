-- Delegated content approval and publication (Oct 19 2026). See
-- docs/delegated-content-approval.md.
--
-- Tom reviews content and decides; he can then say, in ChatGPT or Claude
-- (through Executive OS), "Approve and publish Logic Blogs A, B and C", and the
-- assistant completes the existing approval and publication workflow. This is a
-- delegated permission, not a SQL status change and not an impersonated
-- session:
--
--   content_delegation_policies
--     Per client: may approval and/or publication be delegated at all. The
--     pilot enables Logic Solar only.
--   content_approval_authorizations
--     The durable receipt, one per operation_id (the caller's idempotency
--     key). It records WHO decided (an admin team member, resolved from the
--     authenticated Executive OS account), WHICH assistant executed it and
--     through which channel, the verbatim instruction, its time and any
--     source reference the channel actually has, and the exact scope: client,
--     action, each draft's id, version and review hash (the complete
--     publishable content: title, metadata, TL;DR, body, links, CTA, claims,
--     hero file and alt text, destination), the destination URL and the
--     publication time. Written only by the functions below.
--   content_authorization_record / _execute / _refuse / _status
--     The content-approvals Edge Function's only doors (service role). Execute
--     runs in ONE transaction: it re-checks every item against the live draft
--     (status, version, review hash, destination, policy), then calls the
--     existing content_draft_approve and blog_publication_queue, which keep
--     every check they already had. Any failure rolls the whole batch back.
--   Delegation context
--     Execute marks the receipt 'executing' with its transaction id and sets
--     compass.delegation. content_delegation_allows() is true only for a draft
--     and version in that receipt's scope, in that transaction, for the
--     service role. The approve, queue, draft and history gates accept it in
--     addition to a signed-in teammate; the reviewer recorded is the
--     authorizing team member, with a note naming the assistant.
--
-- "approve" never publishes. "publish" queues drafts already approved at the
-- same version and content. "approve_and_publish" does both. Content changes
-- after approval bump the version and invalidate it, as before.
-- Rollback: drop the four functions, the helpers and both tables; restore
-- the four patched bodies from 20261018222927 / 20261013015000 / 0067 /
-- 20261012025951 (content_draft_review_history_guard).

-- ── 1. Policy ───────────────────────────────────────────────────────────────
create table content_delegation_policies (
  client_id uuid primary key references clients (id) on delete cascade,
  approve boolean not null default false,
  publish boolean not null default false,
  note text,
  updated_at timestamptz not null default now(),
  check (approve or not publish)
);
comment on table content_delegation_policies is
  'Which clients allow an admin''s explicit chat instruction (through Executive OS) to approve and/or publish blog drafts (20261019190000). Absent row = not allowed.';
alter table content_delegation_policies enable row level security;
create policy "team reads delegation policies" on content_delegation_policies
  for select to authenticated using ((select is_team()));
revoke all on content_delegation_policies from anon, authenticated;
grant select on content_delegation_policies to authenticated;

-- ── 2. Receipts ─────────────────────────────────────────────────────────────
create table content_approval_authorizations (
  id uuid primary key default gen_random_uuid(),
  operation_id text not null unique check (operation_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  request_hash text not null check (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  client_id uuid not null references clients (id),
  action text not null check (action in ('approve', 'publish', 'approve_and_publish')),
  authorized_by uuid not null references team_members (id),
  account_email text not null,
  channel text not null check (channel in ('chatgpt', 'claude')),
  executed_by text not null check (length(btrim(executed_by)) between 1 and 120),
  instruction_text text not null check (length(btrim(instruction_text)) between 1 and 2000),
  instructed_at timestamptz not null,
  source_ref jsonb,
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 20),
  destination_url text not null,
  publish_at timestamptz,
  status text not null default 'recorded' check (status in ('recorded', 'executing', 'executed', 'refused')),
  executing_txid bigint,
  refusal_code text,
  refusal text,
  results jsonb,
  created_at timestamptz not null default now(),
  executed_at timestamptz,
  check ((action = 'approve') = (publish_at is null)),
  check ((status = 'refused') = (refusal is not null)),
  check ((status = 'executed') = (executed_at is not null))
);
create index content_approval_authorizations_client_idx on content_approval_authorizations (client_id, created_at desc);
comment on table content_approval_authorizations is
  'Receipts for delegated approval/publication (20261019190000): who decided, which assistant executed, the verbatim instruction and the exact scope. Written only by content_authorization_* functions.';
alter table content_approval_authorizations enable row level security;
create policy "team reads approval authorizations" on content_approval_authorizations
  for select to authenticated using ((select is_team()));
revoke all on content_approval_authorizations from anon, authenticated;
grant select on content_approval_authorizations to authenticated;

create function content_approval_authorizations_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('compass.delegation_write', true), '') <> 'on' and not drafter_caller_is_superuser() then
    raise exception 'Authorizations are written by the content_authorization functions' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then raise exception 'Authorization receipts are immutable' using errcode = '42501'; end if;
  if tg_op = 'UPDATE' and (new.id, new.operation_id, new.request_hash, new.client_id, new.action, new.authorized_by, new.account_email,
      new.channel, new.executed_by, new.instruction_text, new.instructed_at, new.source_ref, new.items, new.destination_url,
      new.publish_at, new.created_at)
    is distinct from (old.id, old.operation_id, old.request_hash, old.client_id, old.action, old.authorized_by, old.account_email,
      old.channel, old.executed_by, old.instruction_text, old.instructed_at, old.source_ref, old.items, old.destination_url,
      old.publish_at, old.created_at) then
    raise exception 'The authorized scope is immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.status in ('executed', 'refused') and not drafter_caller_is_superuser() then
    raise exception 'A finished authorization is a record' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function content_approval_authorizations_guard() from public, anon, authenticated;
create trigger content_approval_authorizations_guard before insert or update or delete on content_approval_authorizations
  for each row execute function content_approval_authorizations_guard();

-- ── 3. Content binding ──────────────────────────────────────────────────────
-- Everything a reader or the publisher sees, plus where it goes. The same
-- inputs the approval snapshot pins; any change gives a different hash.
create function content_draft_review_hash(d content_drafts) returns text
language sql stable security invoker set search_path = public, pg_temp as $$
  select 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'draft_id', d.id, 'version', d.version, 'title', d.title, 'slug', d.slug, 'meta_title', d.meta_title,
    'meta_description', d.meta_description, 'h1', d.h1, 'tldr', d.tldr, 'outline', d.outline, 'body_hash', d.body_hash,
    'internal_links', d.internal_links, 'cta', d.cta, 'structured_data', d.structured_data,
    'hero', content_draft_hero(d),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', cl.id, 'claim', cl.claim, 'status', cl.status, 'source', cl.source) order by cl.id)
                         from content_draft_claims dc join claims cl on cl.id = dc.claim_id where dc.draft_id = d.id), '[]'::jsonb),
    'destination', content_site_destination(d.client_id, d.service_id))::text, 'UTF8')), 'hex')
$$;
revoke all on function content_draft_review_hash(content_drafts) from public, anon;
grant execute on function content_draft_review_hash(content_drafts) to authenticated, service_role;

-- ── 4. Delegation context ───────────────────────────────────────────────────
create function content_delegation_receipt() returns content_approval_authorizations
language sql stable security definer set search_path = public, pg_temp as $$
  select a.* from content_approval_authorizations a
   where drafter_caller_is_service()
     and a.id = nullif(current_setting('compass.delegation', true), '')::uuid
     and a.status = 'executing' and a.executing_txid = txid_current()
$$;
revoke all on function content_delegation_receipt() from public, anon, authenticated;

create function content_delegation_active() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select (content_delegation_receipt()).id is not null
$$;
revoke all on function content_delegation_active() from public, anon, authenticated;

create function content_delegation_reviewer() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select (content_delegation_receipt()).authorized_by
$$;
revoke all on function content_delegation_reviewer() from public, anon, authenticated;

-- p_step 'approve' or 'publish': is this draft and version in the executing
-- receipt's scope, for an action that includes the step?
create function content_delegation_allows(p_draft uuid, p_version int, p_step text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select (case p_step when 'approve' then a.action in ('approve', 'approve_and_publish')
                        when 'publish' then a.action in ('publish', 'approve_and_publish') else false end)
       and exists (select 1 from jsonb_array_elements(a.items) i
                    where (i->>'draft_id')::uuid = p_draft and (i->>'version')::int = p_version)
      from (select (content_delegation_receipt()).*) a where a.id is not null), false)
$$;
revoke all on function content_delegation_allows(uuid, int, text) from public, anon, authenticated;

-- ── 5. The existing gates accept a live delegation (patched in place) ───────
do $migration$
declare
  g text := pg_get_functiondef('public.content_drafts_guard()'::regprocedure);
  a text := pg_get_functiondef('public.content_draft_approve(uuid,integer,text)'::regprocedure);
  q text := pg_get_functiondef('public.blog_publication_queue(uuid,integer,timestamp with time zone)'::regprocedure);
  h text := pg_get_functiondef('public.content_draft_review_history_guard()'::regprocedure);
  g1 text := $x$v_system boolean := (v_human or v_super) and coalesce(current_setting('compass.content_draft_system', true), '') = 'on';$x$;
  g2 text := $x$if not (v_human or v_drafter or v_super) then$x$;
  a1 text := $x$  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate approves a draft' using errcode = '42501';$x$;
  a2 text := $x$reviewed_by = task_actor(), reviewed_at = now(),$x$;
  q1 text := $x$  if not post_caller_is_human() then
    raise exception 'Only a signed-in teammate queues an approved blog'$x$;
  q2 text := $x$d.approved_snapshot,task_actor(),p_scheduled_at)$x$;
  h1 text := $x$or pg_trigger_depth()<2 or not post_caller_is_human() then$x$;
  n int;
begin
  if strpos(a, 'content_delegation_allows') > 0 then return; end if;
  if strpos(a, 'blog_tldr_v1') = 0 or strpos(a, 'content_draft_hero(d)') = 0 then
    raise exception '20261019190000: unexpected content_draft_approve baseline (needs the hero and TL;DR releases)';
  end if;
  foreach n in array array[
      (length(g) - length(replace(g, g1, ''))) / length(g1), (length(g) - length(replace(g, g2, ''))) / length(g2),
      (length(a) - length(replace(a, a1, ''))) / length(a1), (length(a) - length(replace(a, a2, ''))) / length(a2),
      (length(q) - length(replace(q, q1, ''))) / length(q1), (length(q) - length(replace(q, q2, ''))) / length(q2),
      (length(h) - length(replace(h, h1, ''))) / length(h1)] loop
    if n <> 1 then raise exception '20261019190000: an anchor is missing or repeated; review before applying'; end if;
  end loop;
  execute replace(replace(g, g1,
    $x$v_system boolean := (v_human or v_super or content_delegation_active()) and coalesce(current_setting('compass.content_draft_system', true), '') = 'on';$x$),
    g2, $x$if not (v_human or v_drafter or v_super or v_system) then$x$);
  execute replace(replace(a, a1,
    $x$  -- delegated_approval_v1: a signed-in teammate, or an executing delegated authorization for this draft and version.
  if not (post_caller_is_human() or content_delegation_allows(p_draft_id, p_version, 'approve')) then
    raise exception 'Only a signed-in teammate approves a draft' using errcode = '42501';$x$),
    a2, $x$reviewed_by = coalesce(task_actor(), content_delegation_reviewer()), reviewed_at = now(),$x$);
  execute replace(replace(q, q1,
    $x$  -- delegated_approval_v1: a signed-in teammate, or an executing delegated authorization for this draft and version.
  if not (post_caller_is_human() or content_delegation_allows(p_draft_id, p_version, 'publish')) then
    raise exception 'Only a signed-in teammate queues an approved blog'$x$),
    q2, $x$d.approved_snapshot,coalesce(task_actor(), content_delegation_reviewer()),p_scheduled_at)$x$);
  -- The approval history row is written by content_draft_approve's update.
  execute replace(h, h1, $x$or pg_trigger_depth()<2 or not (post_caller_is_human() or content_delegation_active()) then$x$);
end;
$migration$;

-- ── 6. The Edge Function's doors ────────────────────────────────────────────
-- Read: a client's blog drafts in review or approved, with everything an
-- assistant needs to resolve "Blogs A, B and C" and to bind the scope.
create function content_review_batch(p_client uuid) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare c clients; pol content_delegation_policies;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  select * into c from clients where id = p_client;
  if c.id is null then raise exception 'No such client' using errcode = 'P0002'; end if;
  select * into pol from content_delegation_policies where client_id = c.id;
  return jsonb_build_object(
    'client', jsonb_build_object('id', c.id, 'name', c.name),
    'policy', jsonb_build_object('approve', coalesce(pol.approve, false), 'publish', coalesce(pol.publish, false)),
    'drafts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'draft_id', d.id, 'title', d.title, 'status', d.status, 'version', d.version,
        'approved_version', d.approved_version, 'topic', d.topic, 'primary_keyword', d.primary_keyword,
        'planned_date', pi.planned_date, 'slug', d.slug, 'h1', d.h1, 'meta_title', d.meta_title,
        'meta_description', d.meta_description, 'tldr', d.tldr, 'word_count', d.word_count,
        'hero', case when d.hero_asset_id is null then null else jsonb_build_object('asset_id', d.hero_asset_id, 'alt', d.hero_alt,
                  'illustrative', (content_draft_hero(d)->>'illustrative')::boolean, 'content_hash', content_draft_hero(d)->>'content_hash') end,
        'destination_url', content_site_destination(d.client_id, d.service_id)->>'url',
        'destination_controlled', coalesce((content_site_destination(d.client_id, d.service_id)->>'controlled_by_compass')::boolean, false),
        'article_url', rtrim(content_site_destination(d.client_id, d.service_id)->>'url', '/')
                       || replace(coalesce(content_site_destination(d.client_id, d.service_id)->'content_paths'->>'blog_route', '/blog/{slug}/'), '{slug}', coalesce(d.slug, '')),
        'review_hash', content_draft_review_hash(d),
        'problems', to_jsonb(content_draft_problems(d) || content_draft_hero_problems(d.client_id, d.service_id, d.hero_asset_id, d.hero_alt)),
        'publication', (select jsonb_build_object('status', p.status, 'version', p.draft_version, 'published_url', p.published_url,
                          'scheduled_at', p.scheduled_at, 'last_error', p.last_error)
                          from blog_publications p where p.draft_id = d.id and p.status <> 'cancelled'
                          order by p.released_at desc limit 1),
        'review_url', 'https://compass-crm-ten.vercel.app/clients/' || d.client_id || '/drafts/' || d.id)
        order by pi.planned_date nulls last, d.created_at)
      from content_drafts d left join content_plan_items pi on pi.id = d.plan_item_id
      where d.client_id = c.id and d.deliverable = 'blog' and d.status in ('in_review', 'approved')), '[]'::jsonb));
end $$;
revoke all on function content_review_batch(uuid) from public, anon, authenticated;
grant execute on function content_review_batch(uuid) to service_role;

-- Record: the receipt, before anything changes. The same operation_id with
-- the same request returns the existing receipt; with a different request it
-- is a conflict (CD409), never a second authorization.
create function content_authorization_record(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  r content_approval_authorizations;
  m team_members;
  pol content_delegation_policies;
  v_hash text := 'sha256:' || encode(sha256(convert_to((p - 'source_ref')::text, 'UTF8')), 'hex');
  v_action text := p->>'action';
  v_text text := btrim(coalesce(p->>'instruction_text', ''));
  v_publish_at timestamptz;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  select * into r from content_approval_authorizations where operation_id = p->>'operation_id';
  if r.id is not null then
    if r.request_hash <> v_hash then
      raise exception 'operation_reused: operation % was used for a different request', r.operation_id using errcode = 'CD409';
    end if;
    return to_jsonb(r) || jsonb_build_object('replayed', true);
  end if;
  select * into m from team_members where lower(email) = lower(btrim(coalesce(p->>'account_email', '')));
  if m.id is null or m.role <> 'admin' then
    raise exception 'not_authorized: % is not a Compass admin who can approve content', p->>'account_email' using errcode = '42501';
  end if;
  select * into pol from content_delegation_policies where client_id = (p->>'client_id')::uuid;
  if v_action not in ('approve', 'publish', 'approve_and_publish') then
    raise exception 'action_invalid: approve, publish or approve_and_publish' using errcode = '22023';
  end if;
  if not coalesce(pol.approve, false) or (v_action <> 'approve' and not coalesce(pol.publish, false)) then
    raise exception 'policy_disallows: delegated % is not enabled for this client', replace(v_action, '_', ' ') using errcode = '42501';
  end if;
  if v_text = '' then raise exception 'instruction_missing: the owner''s exact words are required' using errcode = '22023'; end if;
  -- The words must carry the action: approval words for an approval, publishing
  -- words for a publication. Anything else is ambiguous and is asked, not done.
  if v_action in ('approve', 'approve_and_publish') and v_text !~* '\m(approve[ds]?|approving|ok(ay)?|sign(ed)?[- ]off|good to go|go ahead)\M' then
    raise exception 'intent_unclear: the instruction does not say to approve' using errcode = '22023';
  end if;
  if v_action in ('publish', 'approve_and_publish') and v_text !~* '(publish|go live|live on|put (them|it|these) (live|up|on)|on the (web)?site|post (them|it|these)|push (them|it|these) live)' then
    raise exception 'intent_unclear: the instruction does not say to publish' using errcode = '22023';
  end if;
  if v_action = 'approve' and v_text ~* '(publish|go live|on the (web)?site)' then
    raise exception 'intent_mismatch: the instruction asks to publish; use approve_and_publish' using errcode = '22023';
  end if;
  if v_action <> 'approve' then
    v_publish_at := coalesce((p->>'publish_at')::timestamptz, now());
    if v_publish_at < now() - interval '5 minutes' then raise exception 'timing_invalid: now or a future time' using errcode = '22023'; end if;
  end if;
  perform set_config('compass.delegation_write', 'on', true);
  insert into content_approval_authorizations (operation_id, request_hash, client_id, action, authorized_by, account_email, channel,
      executed_by, instruction_text, instructed_at, source_ref, items, destination_url, publish_at)
    values (p->>'operation_id', v_hash, (p->>'client_id')::uuid, v_action, m.id, lower(btrim(p->>'account_email')), p->>'channel',
      btrim(p->>'executed_by'), v_text, coalesce((p->>'instructed_at')::timestamptz, now()), p->'source_ref', p->'items',
      p->>'destination_url', v_publish_at)
    returning * into r;
  perform set_config('compass.delegation_write', '', true);
  return to_jsonb(r) || jsonb_build_object('replayed', false);
end $$;
revoke all on function content_authorization_record(jsonb) from public, anon, authenticated;
grant execute on function content_authorization_record(jsonb) to service_role;

-- Execute: all items or none, in one transaction.
create function content_authorization_execute(p_id uuid) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  r content_approval_authorizations;
  d content_drafts;
  it jsonb;
  dest jsonb;
  res jsonb := '[]'::jsonb;
  m team_members;
  v_note text;
  v_pub uuid;
  v_label text;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  select * into r from content_approval_authorizations where id = p_id for update;
  if r.id is null then raise exception 'No such authorization' using errcode = 'P0002'; end if;
  if r.status in ('executed', 'refused') then return to_jsonb(r) || jsonb_build_object('replayed', true); end if;
  select * into m from team_members where id = r.authorized_by;
  v_label := case r.channel when 'chatgpt' then 'ChatGPT' else 'Claude' end;
  v_note := format('Approved by %s through %s (Executive OS); executed by %s. Authorization %s: "%s"',
                   m.name, v_label, r.executed_by, r.id, left(r.instruction_text, 300));

  perform set_config('compass.delegation_write', 'on', true);
  update content_approval_authorizations set status = 'executing', executing_txid = txid_current() where id = r.id;
  perform set_config('compass.delegation', r.id::text, true);

  -- Check every item before changing any.
  for it in select * from jsonb_array_elements(r.items) loop
    select * into d from content_drafts where id = (it->>'draft_id')::uuid and client_id = r.client_id for update;
    if d.id is null then raise exception 'draft_not_found: % is not a draft of this client', it->>'draft_id' using errcode = '23514'; end if;
    if d.deliverable <> 'blog' then raise exception 'not_a_blog: %', d.id using errcode = '23514'; end if;
    if d.version <> (it->>'version')::int then
      raise exception 'stale_version: "%" is now version %, not %; review it again', d.title, d.version, it->>'version' using errcode = '23514';
    end if;
    if content_draft_review_hash(d) <> it->>'review_hash' then
      raise exception 'content_changed: "%" changed since it was reviewed; review it again', d.title using errcode = '23514';
    end if;
    dest := content_site_destination(d.client_id, d.service_id);
    if dest->>'url' is distinct from r.destination_url then
      raise exception 'wrong_destination: "%" goes to %, not %', d.title, coalesce(dest->>'url', 'no website'), r.destination_url using errcode = '23514';
    end if;
    if r.action <> 'approve' and not coalesce((dest->>'controlled_by_compass')::boolean, false) then
      raise exception 'destination_not_publishable: % is not a Compass-managed website', r.destination_url using errcode = '23514';
    end if;
    if r.action in ('approve', 'approve_and_publish') and d.status <> 'in_review' then
      raise exception 'not_in_review: "%" is %', d.title, d.status using errcode = '23514';
    end if;
    if r.action = 'publish' and not (d.status = 'approved' and d.approved_version = d.version) then
      raise exception 'not_approved: "%" is % (approve it first)', d.title, d.status using errcode = '23514';
    end if;
  end loop;

  -- Then the existing workflow, item by item.
  for it in select * from jsonb_array_elements(r.items) loop
    if r.action in ('approve', 'approve_and_publish') then
      perform content_draft_approve((it->>'draft_id')::uuid, (it->>'version')::int, v_note);
    end if;
    v_pub := null;
    if r.action in ('publish', 'approve_and_publish') then
      v_pub := blog_publication_queue((it->>'draft_id')::uuid, (it->>'version')::int, r.publish_at);
    end if;
    select * into d from content_drafts where id = (it->>'draft_id')::uuid;
    res := res || jsonb_build_object('draft_id', d.id, 'title', d.title, 'version', d.version, 'status', d.status,
             'approved_hash', d.approved_hash, 'publication_id', v_pub);
  end loop;

  update content_approval_authorizations set status = 'executed', executed_at = now(), results = res, executing_txid = null where id = r.id
    returning * into r;
  perform set_config('compass.delegation', '', true);
  perform set_config('compass.delegation_write', '', true);
  return to_jsonb(r) || jsonb_build_object('replayed', false);
end $$;
revoke all on function content_authorization_execute(uuid) from public, anon, authenticated;
grant execute on function content_authorization_execute(uuid) to service_role;

-- Refuse: a recorded authorization whose execution failed its checks.
create function content_authorization_refuse(p_id uuid, p_code text, p_message text) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare r content_approval_authorizations;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  perform set_config('compass.delegation_write', 'on', true);
  update content_approval_authorizations set status = 'refused', refusal_code = left(coalesce(p_code, 'refused'), 60),
         refusal = left(coalesce(nullif(btrim(p_message), ''), 'Refused.'), 1000)
   where id = p_id and status = 'recorded' returning * into r;
  perform set_config('compass.delegation_write', '', true);
  if r.id is null then select * into r from content_approval_authorizations where id = p_id; end if;
  return to_jsonb(r);
end $$;
revoke all on function content_authorization_refuse(uuid, text, text) from public, anon, authenticated;
grant execute on function content_authorization_refuse(uuid, text, text) to service_role;

-- Status: the receipt and, per item, where it actually stands now.
--   queued (waiting for the publisher), deploying (publishing), live
--   (published and verified, with its URL), failed (blocked, with the reason),
--   uncertain (interrupted; the publisher reconciles before any retry).
create function content_authorization_status(p_operation_id text) returns jsonb
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare r content_approval_authorizations;
begin
  if not drafter_caller_is_service() then raise exception 'content-approvals function only' using errcode = '42501'; end if;
  select * into r from content_approval_authorizations where operation_id = p_operation_id;
  if r.id is null then return null; end if;
  return to_jsonb(r) - 'executing_txid' || jsonb_build_object('items_now', coalesce((
    select jsonb_agg(jsonb_build_object(
      'draft_id', d.id, 'title', d.title, 'draft_status', d.status, 'version', d.version, 'authorized_version', (it->>'version')::int,
      'approved_version', d.approved_version,
      'publication', case when p.id is null then null else jsonb_build_object(
        'id', p.id, 'state', case p.status when 'queued' then 'queued' when 'publishing' then 'deploying' when 'published' then 'live'
                                           when 'blocked' then 'failed' else p.status end,
        'scheduled_at', p.scheduled_at, 'published_url', p.published_url, 'published_at', p.published_at,
        'commit_sha', p.commit_sha, 'last_error', p.last_error) end))
    from jsonb_array_elements(r.items) it
    join content_drafts d on d.id = (it->>'draft_id')::uuid
    left join lateral (select * from blog_publications bp where bp.draft_id = d.id and bp.draft_version = (it->>'version')::int
                         and bp.status <> 'cancelled' order by bp.released_at desc limit 1) p on true), '[]'::jsonb));
end $$;
revoke all on function content_authorization_status(text) from public, anon, authenticated;
grant execute on function content_authorization_status(text) to service_role;

-- ── 7. Pilot: Logic Solar ───────────────────────────────────────────────────
insert into content_delegation_policies (client_id, approve, publish, note)
select id, true, true, 'Pilot (Tom, Oct 19 2026): approve and publish Logic blogs by explicit instruction in ChatGPT or Claude.'
  from clients where id = '70211d71-d9f4-46ab-abe2-ef39c41591fb';

-- ── 8. Postconditions ───────────────────────────────────────────────────────
do $$
begin
  if (select prosrc from pg_proc where oid = 'public.content_draft_approve(uuid,integer,text)'::regprocedure) not like '%content_delegation_allows%'
     or (select prosrc from pg_proc where oid = 'public.blog_publication_queue(uuid,integer,timestamp with time zone)'::regprocedure) not like '%content_delegation_allows%'
     or (select prosrc from pg_proc where oid = 'public.content_drafts_guard()'::regprocedure) not like '%content_delegation_active()%'
     or (select prosrc from pg_proc where oid = 'public.content_draft_review_history_guard()'::regprocedure) not like '%content_delegation_active()%' then
    raise exception '20261019190000: a gate was not patched';
  end if;
  if has_function_privilege('authenticated', 'public.content_authorization_execute(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.content_authorization_record(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.content_delegation_allows(uuid,integer,text)', 'execute')
     or has_function_privilege('anon', 'public.content_review_batch(uuid)', 'execute')
     or has_table_privilege('authenticated', 'public.content_approval_authorizations', 'insert')
     or has_table_privilege('authenticated', 'public.content_approval_authorizations', 'update')
     or not has_function_privilege('authenticated', 'public.content_draft_approve(uuid,integer,text)', 'execute') then
    raise exception '20261019190000: grants are wrong';
  end if;
end $$;
