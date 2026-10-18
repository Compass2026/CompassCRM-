-- Tests for 20261018230000 (blog TL;DR and draft history), run by
-- scripts/test-portal-sandbox.sh after blog_hero.test.sql (the cd harness
-- and fictional clients a / b from content_drafts.test.sql).
--
--   T1-T3  the drafter: a brief with the TL;DR rule refuses a write without
--          one (nothing written); with one it lands, normalized; a draft
--          briefed before the rule writes exactly as before
--   T4-T6  a teammate changes it like content: not in review, every change
--          bumps the version, and a rule draft cannot be submitted without it
--   T7-T8  approval pins it in the hashed snapshot; a legacy approval has no
--          tldr key
--   T9-T11 draft history: the superseded text is kept, team-readable only,
--          written only by the trigger

\set team '00000000-0000-4000-a000-000000000001'

\c - supabase_admin
\o /dev/null
insert into content_plan_items (id, client_id, week_start, deliverable, channel, purpose, topic, search_intent, keyword_id, service_id, planned_date) values
  (cd.id('i-tldr'), cd.id('a'), date '2026-10-19', 'blog', null, 'educational', 'Signs a roof is wearing out', 'informational', cd.id('kw'), cd.id('svc'), null),
  (cd.id('i-tldr-legacy'), cd.id('a'), date '2026-10-19', 'blog', null, 'educational', 'What shortens a roof''s life', 'informational', cd.id('kw'), cd.id('svc'), null);
create function cd.tldr_payload(p_draft uuid, p_tldr text) returns jsonb language sql immutable as $$
  select jsonb_set(jsonb_set(cd.payload(p_draft, 320, array[cd.id('c-sourced')]),
    '{brief}', '{"v": 1, "tldr": {"label": "TL;DR", "required": true}}'::jsonb),
    '{content,tldr}', coalesce(to_jsonb(p_tldr), 'null'::jsonb))
$$;
grant execute on function cd.tldr_payload(uuid, text) to anon, authenticated, service_role, authenticator, postgres;
\o

\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
select cd.save('tldr', content_draft_request(cd.id('i-tldr'))->>'draft_id');
select cd.save('tldr-legacy', content_draft_request(cd.id('i-tldr-legacy'))->>'draft_id');
\o
reset role;

-- ── The drafter ─────────────────────────────────────────────────────────────
\c - authenticator
set role service_role;
select cd.as_user('service_role', null);
\o /dev/null
do $$
declare d uuid := cd.get('tldr')::uuid; l uuid := cd.get('tldr-legacy')::uuid; e text;
begin
  e := cd.try(format('select content_draft_write(%L::jsonb)', cd.tldr_payload(d, null)));
  perform cd.ok('T1 a brief with the TL;DR rule refuses a write without one; nothing is written',
    e like '23514%tldr_missing%' and (select status = 'requested' and title is null and tldr is null from content_drafts where id = d), e);
  perform content_draft_write(cd.tldr_payload(d, '  A roof wears out gradually.   The signs show up long before a leak does.  '));
  perform cd.ok('T2 with one it lands with the content, in review, whitespace normalized',
    (select status = 'in_review' and tldr = 'A roof wears out gradually. The signs show up long before a leak does.'
            and title is not null and position('TL;DR' in body_markdown) = 0 from content_drafts where id = d));
  perform content_draft_write(cd.payload(l, 320, array[cd.id('c-sourced')]));
  perform cd.ok('T3 a draft briefed before the rule writes exactly as before (no TL;DR)',
    (select status = 'in_review' and tldr is null from content_drafts where id = l));
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

-- ── A teammate ──────────────────────────────────────────────────────────────
\c - authenticator
set role authenticated;
select cd.as_user('authenticated', :'team');
\o /dev/null
do $$
declare d content_drafts; v int; e text;
begin
  select * into d from content_drafts where id = cd.get('tldr')::uuid;
  e := cd.try(format('update content_drafts set tldr = ''Changed. Twice.'' where id = %L', d.id));
  perform cd.ok('T4 the TL;DR of a draft in review is not changed in place', e like '23514%Withdraw%', e);
  update content_drafts set status = 'draft' where id = d.id;
  select version into v from content_drafts where id = d.id;
  update content_drafts set tldr = 'A roof wears out gradually. Knowing the signs lets you plan on your own schedule.' where id = d.id;
  perform cd.ok('T5 a TL;DR change bumps the version by one',
    (select version = v + 1 and tldr like 'A roof wears out gradually. Knowing%' from content_drafts where id = d.id));
  update content_drafts set tldr = null where id = d.id;
  e := cd.try(format('update content_drafts set status = ''in_review'' where id = %L', d.id));
  perform cd.ok('T6 a draft briefed under the rule cannot be submitted without a TL;DR', e like '23514%TL;DR%', e);
  update content_drafts set tldr = 'A roof wears out gradually. Knowing the signs lets you plan on your own schedule.' where id = d.id;
  update content_drafts set status = 'in_review' where id = d.id;
  select * into d from content_drafts where id = d.id;
  perform content_draft_approve(d.id, d.version);
  select * into d from content_drafts where id = d.id;
  perform cd.ok('T7 approval pins the TL;DR in the hashed snapshot',
    d.approved_snapshot->>'tldr' = d.tldr
    and d.approved_hash = 'sha256:' || encode(sha256(convert_to(d.approved_snapshot::text, 'UTF8')), 'hex'));

  select * into d from content_drafts where id = cd.get('tldr-legacy')::uuid;
  perform content_draft_approve(d.id, d.version);
  perform cd.ok('T8 a legacy draft approves unchanged, with no tldr key in its snapshot',
    (select status = 'approved' and not (approved_snapshot ? 'tldr') from content_drafts where id = d.id));

  perform cd.ok('T9 every content change kept the text it replaced',
    (select count(*) >= 3 from content_draft_versions where draft_id = cd.get('tldr')::uuid)
    and exists (select 1 from content_draft_versions where draft_id = cd.get('tldr')::uuid
                 and content->>'tldr' = 'A roof wears out gradually. The signs show up long before a leak does.'
                 and content->>'body_markdown' like '## What wears a roof out%'));
  perform cd.ok('T10 a teammate reads the history but cannot write it',
    cd.try(format('insert into content_draft_versions (draft_id, client_id, version, status, superseded_by_version, content) values (%L, %L, 1, ''draft'', 2, ''{}'')',
      cd.get('tldr'), cd.id('a'))) like '42501%'
    and cd.try(format('update content_draft_versions set content = ''{}'' where draft_id = %L', cd.get('tldr'))) like '42501%'
    and cd.try(format('delete from content_draft_versions where draft_id = %L', cd.get('tldr'))) like '42501%');
end $$;
\o
reset role;
select set_config('request.jwt.claims', '', false);

\c - authenticator
set role anon;
select cd.ok('T11 anon reads no draft history',
  cd.try('select count(*) from content_draft_versions') like '42501%');
reset role;

\c - supabase_admin
select status, count(*) from cd.results where name ~ '^T[0-9]' group by status;
select n, status, name, detail from cd.results where name ~ '^T[0-9]' and status <> 'pass' order by n;
do $$
begin
  if exists (select 1 from cd.results where name ~ '^T[0-9]' and status = 'fail')
     or (select count(*) from cd.results where name ~ '^T[0-9]') < 11 then
    raise exception 'blog_tldr: failures above';
  end if;
end $$;
