-- Blog TL;DR and draft history (Oct 18 2026). See docs/blog-drafter.md.
--
-- Every new client blog opens with a TL;DR: 2–3 plain sentences under the
-- title, before the hero image and the article (content-drafter/tldr.ts).
--
--   content_drafts.tldr
--     The one stored summary. Never part of body_markdown; the publisher
--     delivers it once (the site's TL;DR slot, or the first body paragraph).
--   content_drafts_tldr_guard (after content_drafts_guard / _hero_guard)
--     A TL;DR change follows the content-edit rules: the drafter in a
--     requested / draft / rejected draft, a teammate in a draft / rejected one.
--     It bumps the version, so an open review or a pinned approval no longer
--     matches.
--   content_draft_write (patched in place)
--     Writes c.tldr. A brief that carries the TL;DR rule (brief.tldr.required,
--     every brief from content-drafter v7) refuses a write without one.
--   content_draft_problems (patched in place)
--     The same requirement at submit and approval, for those drafts only.
--     Drafts written under an older brief, approved articles and published
--     releases are not retroactively invalidated.
--   content_draft_approve (patched in place)
--     The approval snapshot pins `tldr` only when the draft has one, so the
--     hashes of approvals without one are unchanged.
--   content_draft_versions
--     Immutable history: the full superseded row every time a draft's
--     reader-visible content changes. The version counter alone did not keep
--     superseded text. Team read; written only by the trigger.
--
-- Non-blog deliverables are untouched (the rule keys off the blog brief).
-- Rollback: drop the two triggers and functions, content_draft_versions and
-- the column; re-apply 20261015175146's content_draft_write,
-- 20261012163631's content_draft_problems and 20261016173307's approve.

do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'content_drafts' and column_name = 'tldr') then
    raise exception '20261018230000: content_drafts.tldr already exists';
  end if;
  if to_regprocedure('public.content_draft_hero(public.content_drafts)') is null then
    raise exception '20261018230000: needs the blog hero release (20261016173307)';
  end if;
end $$;

-- ── 1. The column ───────────────────────────────────────────────────────────
alter table content_drafts
  add column tldr text check (tldr is null or length(btrim(tldr)) between 1 and 600),
  add constraint content_drafts_tldr_blog_only check (tldr is null or deliverable = 'blog');
comment on column content_drafts.tldr is
  'The blog''s TL;DR (20261018230000): 2–3 plain sentences shown under the title, before the hero and the article. Never in body_markdown. A change bumps the version; approval pins it.';

-- ── 2. The guard ────────────────────────────────────────────────────────────
create function content_drafts_tldr_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_human boolean := post_caller_is_human();
  v_drafter boolean := content_drafter_session_active();
  v_super boolean := drafter_caller_is_superuser();
begin
  if tg_op = 'INSERT' then
    if new.tldr is not null then
      raise exception 'A TL;DR is written with the draft, not on its request' using errcode = '23514';
    end if;
    return new;
  end if;
  new.tldr := nullif(btrim(regexp_replace(coalesce(new.tldr, ''), '\s+', ' ', 'g')), '');
  if new.tldr is not distinct from old.tldr then return new; end if;
  if v_drafter then
    if old.status not in ('requested', 'draft', 'rejected') then
      raise exception 'The drafter sets a TL;DR only on a requested, draft or rejected draft (it is %)', old.status using errcode = '23514';
    end if;
  elsif v_human or v_super then
    if old.status not in ('draft', 'rejected') then
      raise exception 'Withdraw or reopen the draft to change its TL;DR (it is %)', old.status using errcode = '23514';
    end if;
  else
    raise exception 'Only a teammate or the content-drafter function sets a TL;DR' using errcode = '42501';
  end if;
  if new.deliverable <> 'blog' then raise exception 'Only a blog carries a TL;DR' using errcode = '23514'; end if;
  -- A content edit in the same statement has already moved the version.
  if new.version = old.version then new.version := old.version + 1; end if;
  return new;
end $$;
revoke all on function content_drafts_tldr_guard() from public, anon, authenticated;
create trigger content_drafts_tldr_guard before insert or update on content_drafts
  for each row execute function content_drafts_tldr_guard();

-- ── 3. Draft history ────────────────────────────────────────────────────────
create table content_draft_versions (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references content_drafts (id) on delete cascade,
  client_id uuid not null references clients (id) on delete cascade,
  version int not null,
  status text not null,
  superseded_by_version int not null,
  superseded_at timestamptz not null default now(),
  content jsonb not null
);
create index content_draft_versions_draft_idx on content_draft_versions (draft_id, superseded_at);
comment on table content_draft_versions is
  'Immutable history (20261018230000): the full content_drafts row as it stood before its reader-visible content changed. Written only by content_drafts_record_version.';
alter table content_draft_versions enable row level security;
create policy "team reads draft history" on content_draft_versions
  for select to authenticated using ((select is_team()));
revoke all on content_draft_versions from anon, authenticated;
grant select on content_draft_versions to authenticated;

create function content_drafts_record_version() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if nullif(btrim(coalesce(old.title, '')), '') is null and nullif(btrim(coalesce(old.body_markdown, '')), '') is null then
    return new;  -- an empty request has no text to keep
  end if;
  insert into content_draft_versions (draft_id, client_id, version, status, superseded_by_version, content)
  values (old.id, old.client_id, old.version, old.status::text, new.version, to_jsonb(old));
  return new;
end $$;
revoke all on function content_drafts_record_version() from public, anon, authenticated;
create trigger content_drafts_record_version after update on content_drafts
  for each row
  when ((old.title, old.slug, old.meta_title, old.meta_description, old.h1, old.tldr, old.outline, old.body_markdown,
         old.internal_links, old.cta, old.structured_data, old.hero_asset_id, old.hero_alt)
        is distinct from
        (new.title, new.slug, new.meta_title, new.meta_description, new.h1, new.tldr, new.outline, new.body_markdown,
         new.internal_links, new.cta, new.structured_data, new.hero_asset_id, new.hero_alt))
  execute function content_drafts_record_version();

-- ── 4–6. In-place patches (each anchor must occur exactly once) ────────────
do $migration$
declare
  w text := pg_get_functiondef('public.content_draft_write(jsonb)'::regprocedure);
  p text := pg_get_functiondef('public.content_draft_problems(public.content_drafts)'::regprocedure);
  a text := pg_get_functiondef('public.content_draft_approve(uuid,integer,text)'::regprocedure);
  w_set text := $x$h1 = c->>'h1', outline = c->'outline',$x$;
  w_gate text := $x$  delete from content_draft_claims where draft_id = d.id;
$x$;
  p_anchor text := $x$  v := v || brand_content_problems(d.client_id,d.service_id,d.brief);
$x$;
  a_anchor text := $x$  v_hero := content_draft_hero(d);
$x$;
  n int;
begin
  if strpos(w, 'blog_tldr_v1') > 0 then return; end if;
  if strpos(w, 'claimed_by_other') = 0 or strpos(a, 'content_draft_hero(d)') = 0 then
    raise exception '20261018230000: unexpected baseline (needs the claims and hero releases)';
  end if;
  foreach n in array array[
      (length(w) - length(replace(w, w_set, ''))) / length(w_set),
      (length(w) - length(replace(w, w_gate, ''))) / length(w_gate),
      (length(p) - length(replace(p, p_anchor, ''))) / length(p_anchor),
      (length(a) - length(replace(a, a_anchor, ''))) / length(a_anchor)] loop
    if n <> 1 then raise exception '20261018230000: an anchor is missing or repeated; review before applying'; end if;
  end loop;

  execute replace(replace(w, w_set, $x$h1 = c->>'h1', tldr = nullif(btrim(c->>'tldr'), ''), outline = c->'outline',$x$),
    w_gate,
    $x$  -- blog_tldr_v1: a brief that carries the TL;DR rule requires the summary.
  if d.deliverable = 'blog' and coalesce((p->'brief'->'tldr'->>'required')::boolean, false)
     and nullif(btrim(coalesce(c->>'tldr', '')), '') is null then
    raise exception 'tldr_missing: every new blog starts with a TL;DR (2-3 plain sentences under the title)' using errcode = '23514';
  end if;
$x$ || w_gate);

  execute replace(p, p_anchor,
    $x$  -- blog_tldr_v1: drafts briefed under the TL;DR rule need one; older drafts are unchanged.
  if d.deliverable = 'blog' and coalesce((d.brief->'tldr'->>'required')::boolean, false)
     and nullif(btrim(coalesce(d.tldr, '')), '') is null then
    v := v || 'A TL;DR is required under the title of this blog.'::text;
  end if;
$x$ || p_anchor);

  execute replace(a, a_anchor,
    $x$  -- blog_tldr_v1: only a draft with a TL;DR gains the key; other approvals hash as before.
  if nullif(btrim(coalesce(d.tldr, '')), '') is not null then
    v_snapshot := v_snapshot || jsonb_build_object('tldr', d.tldr);
  end if;
$x$ || a_anchor);
end;
$migration$;

-- ── 7. Postconditions ───────────────────────────────────────────────────────
do $$
declare
  w text := (select prosrc from pg_proc where oid = 'public.content_draft_write(jsonb)'::regprocedure);
  p text := (select prosrc from pg_proc where oid = 'public.content_draft_problems(public.content_drafts)'::regprocedure);
  a text := (select prosrc from pg_proc where oid = 'public.content_draft_approve(uuid,integer,text)'::regprocedure);
begin
  if w not like '%blog_tldr_v1%' or w not like '%tldr = nullif(btrim(c->>''tldr''), '''')%' or w not like '%claimed_by_other%'
     or p not like '%blog_tldr_v1%' or p not like '%brand_content_problems%'
     or a not like '%blog_tldr_v1%' or a not like '%content_draft_hero(d)%' then
    raise exception '20261018230000: a patched function lost the TL;DR rule or an earlier change';
  end if;
  if has_function_privilege('authenticated', 'public.content_draft_write(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.content_drafts_tldr_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.content_drafts_record_version()', 'execute')
     or not has_function_privilege('authenticated', 'public.content_draft_approve(uuid,integer,text)', 'execute')
     or has_table_privilege('authenticated', 'public.content_draft_versions', 'insert')
     or has_table_privilege('authenticated', 'public.content_draft_versions', 'update')
     or has_table_privilege('authenticated', 'public.content_draft_versions', 'delete')
     or has_table_privilege('anon', 'public.content_draft_versions', 'select') then
    raise exception '20261018230000: grants are wrong';
  end if;
end $$;
