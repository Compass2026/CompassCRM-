-- 20261104160000: a weekly blog slot's presets bind the draft. Fictional
-- client only; everything is rolled back.
--   full   a slot a teammate planned: topic, intent, service, keyword, notes
--   kw     the standard's placeholder topic and notes, a preset keyword only
--   none   the standard's placeholders, no presets (the control)
--   inc    planned like full; opened only to replay the incident on the
--          previous definition
-- N1 runs the rollback inside a savepoint, opens the control with the
-- previous definition, keeps the result in a psql variable, then opens it
-- again with the new definition and compares.
begin;
create schema sp;
create function sp.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAILED %', label; end if; raise notice 'ok %', label; end $$;
create function sp.msg(statement text) returns text language plpgsql as $$
begin execute statement; return 'accepted'; exception when others then return sqlstate || ': ' || sqlerrm; end $$;
create function sp.id(k text) returns uuid language sql immutable as $$ select md5('sp:' || k)::uuid $$;
create function sp.open_weekly(task text, kw text, svc text, intent text, topic text) returns jsonb language sql as $$
  select content_draft_open_weekly(jsonb_build_object('task_id', sp.id('t.' || task), 'topic', topic, 'search_intent', intent,
                                                      'keyword_id', sp.id(kw), 'service_id', sp.id(svc))) $$;
create function sp.try(task text, kw text, svc text, intent text, topic text) returns text language sql as $$
  select sp.msg(format('select sp.open_weekly(%L, %L, %L, %L, %L)', task, kw, svc, intent, topic)) $$;
-- What a draft opened for a task looks like, without its own id and times.
create function sp.draft(task text) returns jsonb language sql stable as $$
  select jsonb_build_object('plan_item_id', d.plan_item_id, 'deliverable', d.deliverable, 'topic', d.topic,
           'primary_keyword', d.primary_keyword, 'keyword_id', d.keyword_id, 'search_intent', d.search_intent,
           'service_id', d.service_id, 'request_note', d.request_note, 'status', d.status,
           'task_status', (select t.status::text from tasks t where t.id = d.source_task_id),
           'core_link', exists (select 1 from core_keyword_links l where l.content_draft_id = d.id and l.list_id = sp.id('list')))
  from content_drafts d where d.source_task_id = sp.id('t.' || task) $$;
create table sp.saved (k text primary key, v jsonb);
grant usage on schema sp to anon, authenticated, service_role;
grant execute on all functions in schema sp to anon, authenticated, service_role;
grant select, insert, update on sp.saved to service_role;

set local session_replication_role = replica;
insert into clients (id, name, status, website_url) values (sp.id('P'), 'SP Planned', 'active', 'https://sp.example.test');
insert into services (id, client_id, name, status, page_url) values
  (sp.id('sDrain'), sp.id('P'), 'Drain Cleaning', 'approved', 'https://sp.example.test/drain-cleaning'),
  (sp.id('sHeater'), sp.id('P'), 'Water Heaters', 'approved', 'https://sp.example.test/water-heaters');
insert into keywords (id, client_id, keyword, service_id, is_active, intent) values
  (sp.id('kDrain'), sp.id('P'), 'slow drain cleaning', sp.id('sDrain'), true, 'informational'),
  (sp.id('kHeater'), sp.id('P'), 'water heater repair', sp.id('sHeater'), true, 'informational'),
  (sp.id('kSnake'), sp.id('P'), 'drain snake rental', sp.id('sDrain'), true, 'commercial');
insert into core_keyword_lists (id, client_id, version, status, keyword_ids, source_ref, approved_by, approved_at)
values (sp.id('list'), sp.id('P'), 1, 'approved', array[sp.id('kDrain'), sp.id('kHeater'), sp.id('kSnake')], 'test fixture',
        (select id from team_members limit 1), now());
insert into content_plan_items (id, client_id, week_start, deliverable, purpose, topic, search_intent, keyword_id, service_id, planned_date, notes) values
  (sp.id('full'), sp.id('P'), '2026-11-09', 'blog', 'educational', 'How often should a slow drain be cleared?', 'informational',
   sp.id('kDrain'), sp.id('sDrain'), '2026-11-11', 'Homeowner audience. Answer in the first paragraph and link the drain cleaning page.'),
  (sp.id('kw'), sp.id('P'), '2026-11-09', 'blog', 'educational', 'Blog · SP Planned · week of Nov 9, 2026', null,
   sp.id('kSnake'), null, '2026-11-12',
   'Opened by the weekly delivery standard (v2). Set the topic, intent, service and keyword before drafting.'),
  (sp.id('none'), sp.id('P'), '2026-11-09', 'blog', 'educational', 'Blog · SP Planned · November 2026', null,
   null, null, '2026-11-13',
   'Opened by the monthly delivery standard (v1). Set the topic, intent, service and keyword before drafting.'),
  (sp.id('inc'), sp.id('P'), '2026-11-09', 'blog', 'educational', 'Is a slow drain a sign of a bigger problem?', 'informational',
   sp.id('kDrain'), sp.id('sDrain'), '2026-11-14', 'Planned by a teammate for the drain cleaning page.');
insert into tasks (id, client_id, title, owner, status, key, due_date, notes)
select sp.id('t.' || s), sp.id('P'), 'Blog slot for the client: core keyword, sourced article, team review', 'CLAUDE', 'open', 'blog_post',
       '2026-11-11', 'plan_item:' || sp.id(s) || ' (weekly delivery standard). Choose a keyword of the client''s approved core list and its service.'
from unnest(array['full', 'kw', 'none', 'inc']) s;
set local session_replication_role = origin;

select sp.ok('M0 the migration replaced the 20261027191343 definition and kept its core keyword gate',
  strpos(pg_get_functiondef('content_draft_open_weekly(jsonb)'::regprocedure), 'slot_presets_v1') > 0
  and strpos(pg_get_functiondef('content_draft_open_weekly(jsonb)'::regprocedure), 'core_keyword_weekly_v1') > 0);

-- ── The drafter's session (content-drafter mode open) ──────────────────────
set local session authorization authenticator;
set local role service_role;
insert into sp.saved values
  ('P1', to_jsonb(sp.try('full', 'kHeater', 'sHeater', 'informational', 'Signs a water heater needs repair'))),
  ('P2', to_jsonb(sp.try('full', 'kDrain', 'sDrain', 'commercial', 'Slow drains'))),
  ('P3', to_jsonb(sp.try('full', 'kDrain', 'sHeater', 'informational', 'Slow drains'))),
  ('P3b', to_jsonb(sp.try('full', 'kSnake', 'sDrain', 'informational', 'Slow drains')));
insert into sp.saved values ('P0', jsonb_build_object(
  'drafts', (select count(*) from content_drafts where source_task_id = sp.id('t.full')),
  'task', (select status::text from tasks where id = sp.id('t.full'))));
insert into sp.saved values ('P4', sp.open_weekly('full', 'kDrain', 'sDrain', 'informational', 'A topic the worker chose'));
insert into sp.saved values ('P5', sp.open_weekly('full', 'kHeater', 'sHeater', 'informational', 'Retry on another keyword'));
insert into sp.saved values ('K1', to_jsonb(sp.try('kw', 'kDrain', 'sDrain', 'informational', 'Slow drains')));
insert into sp.saved values ('K2', sp.open_weekly('kw', 'kSnake', 'sDrain', 'commercial', 'Renting a drain snake or calling a plumber?'));
reset role;
reset session authorization;

do $$
declare s jsonb := (select jsonb_object_agg(k, v) from sp.saved);
begin
  perform sp.ok('P1 a preset keyword refuses another keyword (22023 slot_keyword_mismatch, naming the slot''s keyword)',
    s->>'P1' like '22023: slot_keyword_mismatch: the blog slot this task names is planned for the keyword "slow drain cleaning" (' || sp.id('kDrain') || ')%');
  perform sp.ok('P2 a preset intent refuses another intent (slot_plan_mismatch)',
    s->>'P2' = '22023: slot_plan_mismatch: the blog slot this task names is planned for informational search intent, not commercial');
  perform sp.ok('P3 a preset service refuses another service (slot_plan_mismatch, naming the slot''s service)',
    s->>'P3' = '22023: slot_plan_mismatch: the blog slot this task names is planned for the service "Drain Cleaning" (' || sp.id('sDrain') || ')');
  perform sp.ok('P3b a core keyword of the same service is still another keyword',
    s->>'P3b' like '22023: slot_keyword_mismatch:%"slow drain cleaning"%');
  perform sp.ok('P3c a refused open writes nothing: no draft, the task still open',
    s->'P0' = '{"drafts": 0, "task": "open"}'::jsonb);
  perform sp.ok('P4 the matching open takes the slot''s topic and notes, the slot''s keyword, intent and service',
    sp.draft('full') = jsonb_build_object('plan_item_id', sp.id('full'), 'deliverable', 'blog',
      'topic', 'How often should a slow drain be cleared?', 'primary_keyword', 'slow drain cleaning', 'keyword_id', sp.id('kDrain'),
      'search_intent', 'informational', 'service_id', sp.id('sDrain'),
      'request_note', 'Homeowner audience. Answer in the first paragraph and link the drain cleaning page.',
      'status', (select status from content_drafts where source_task_id = sp.id('t.full')), 'task_status', 'in_progress', 'core_link', true)
    and s->'P4'->>'reused' = 'false' and (s->'P4'->>'plan_item_id')::uuid = sp.id('full'));
  perform sp.ok('P5 a retry returns the task''s draft unchanged (reuse comes first, as before)',
    s->'P5'->>'reused' = 'true' and s->'P5'->>'draft_id' = s->'P4'->>'draft_id'
    and (select count(*) from content_drafts where source_task_id = sp.id('t.full')) = 1
    and sp.draft('full')->>'keyword_id' = sp.id('kDrain')::text);
  perform sp.ok('K1 a slot with only a preset keyword refuses another keyword',
    s->>'K1' like '22023: slot_keyword_mismatch:%"drain snake rental"%');
  perform sp.ok('K2 placeholder topic and notes: the payload''s topic and intent, the standard request note',
    sp.draft('kw')->>'topic' = 'Renting a drain snake or calling a plumber?'
    and sp.draft('kw')->>'request_note' = 'The weekly blog post.'
    and sp.draft('kw')->>'search_intent' = 'commercial' and sp.draft('kw')->>'keyword_id' = sp.id('kSnake')::text
    and sp.draft('kw')->>'service_id' = sp.id('sDrain')::text);
end $$;

-- ── N1: a slot without presets opens exactly as before ─────────────────────
savepoint before_down;
\ir ../../rollback/20261104160000_weekly_blog_slot_presets.down.sql
select sp.ok('V0 the rollback restores the 20261027191343 definition exactly',
  md5(pg_get_functiondef('content_draft_open_weekly(jsonb)'::regprocedure)) = '6d4e4f67c7f8d478760941ae5672f28a');
set local session authorization authenticator;
set local role service_role;
select sp.open_weekly('none', 'kHeater', 'sHeater', 'informational', 'Signs a water heater needs repair') - 'draft_id' as old_open \gset
insert into sp.saved values ('V1', sp.open_weekly('inc', 'kHeater', 'sHeater', 'informational', 'Signs a water heater needs repair'));
reset role;
reset session authorization;
select sp.draft('none') as old_draft \gset
select sp.ok('V1 the previous definition accepted another keyword in the planned slot and dropped its notes (the incident)',
  sp.draft('inc')->>'keyword_id' = sp.id('kHeater')::text and sp.draft('inc')->>'topic' = 'Signs a water heater needs repair'
  and sp.draft('inc')->>'request_note' = 'The weekly blog post.' and sp.draft('inc')->>'plan_item_id' = sp.id('inc')::text);
rollback to savepoint before_down;

\ir ../../migrations/20261104160000_weekly_blog_slot_presets.sql
select sp.ok('M1 a rerun of the migration is a no-op', strpos(pg_get_functiondef('content_draft_open_weekly(jsonb)'::regprocedure), 'slot_presets_v1') > 0
  and (length(pg_get_functiondef('content_draft_open_weekly(jsonb)'::regprocedure))
       - length(replace(pg_get_functiondef('content_draft_open_weekly(jsonb)'::regprocedure), 'slot_presets_v1', ''))) = 2 * length('slot_presets_v1'));
set local session authorization authenticator;
set local role service_role;
select sp.open_weekly('none', 'kHeater', 'sHeater', 'informational', 'Signs a water heater needs repair') - 'draft_id' as new_open \gset
insert into sp.saved values ('V2', to_jsonb(sp.try('inc', 'kHeater', 'sHeater', 'informational', 'Signs a water heater needs repair')));
reset role;
reset session authorization;
select sp.ok('N1 no presets: the same answer and the same draft as the previous definition (payload topic, standard request note)',
  :'old_open'::jsonb = :'new_open'::jsonb and :'old_draft'::jsonb = sp.draft('none')
  and sp.draft('none')->>'topic' = 'Signs a water heater needs repair' and sp.draft('none')->>'request_note' = 'The weekly blog post.'
  and sp.draft('none')->>'keyword_id' = sp.id('kHeater')::text);
select sp.ok('V2 the same open is refused now, and writes nothing',
  (select v #>> '{}' like '22023: slot_keyword_mismatch:%"slow drain cleaning"%' from sp.saved where k = 'V2')
  and sp.draft('inc') is null);
select sp.ok('X1 the open stays the drafter''s only',
  not has_function_privilege('authenticated', 'public.content_draft_open_weekly(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.content_draft_open_weekly(jsonb)', 'execute'));
rollback;
