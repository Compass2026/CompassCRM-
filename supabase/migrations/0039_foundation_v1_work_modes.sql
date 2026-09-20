-- Compass Website Foundation v1 in the CRM (Sept 20 2026).
--
-- The website line is the accepted Foundation
-- (Compass2026/showmeelectricalwebsite @ 94014af35316c94616dadb3f8d606a4b68577fb0),
-- not the retired Astro starter. Three things become explicit data:
--
-- 1. The WORK MODE of a client's website: new_build (a Foundation build),
--    upgrade_existing (a site Tom already built; changes arrive as previews
--    and pull requests), client_retains (the client runs the site; the CRM
--    only files proposed documents). The intake records it; the worker and
--    site-push read it.
-- 2. The BUILD BRIEF: a durable JSON record on the site row of the accepted
--    standard version and SHA, repository and branches, framework and
--    content adapter, brand and factual sources, page and keyword plan,
--    links, assets, contact configuration, missing inputs and evidence
--    (src/lib/build-brief.ts composes it; the worker files it to Drive).
-- 3. The FOUNDATION RELEASE the CRM is pinned to (foundation_releases): what
--    a new build is made from, and the only foreign repository site-push's
--    archive mode will fetch.
--
-- Nothing here changes existing enrollments, gates or the content contract
-- Tom authorised on Sept 14. Numbered 0039 because the remote project already
-- carries 0036_team_only_access, 0037_portal_access and 0038_portal_seen from
-- the portal branches (the foundation_releases policy uses their is_team()).
-- Applied during the Sept 20 activation; see
-- docs/compass-foundation-integration.md "Activation".

-- ── Work mode ─────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_type where typname = 'website_work_mode') then
    create type website_work_mode as enum ('new_build', 'upgrade_existing', 'client_retains');
  end if;
end $$;

alter table sites
  add column if not exists work_mode website_work_mode,
  add column if not exists preview_branch text,
  add column if not exists content_adapter text,
  add column if not exists foundation_version text,
  add column if not exists foundation_sha text,
  add column if not exists build_brief jsonb,
  add column if not exists build_brief_at timestamptz;

comment on column sites.work_mode is
  'new_build: Foundation build (branch of record = the build); upgrade_existing: Tom''s site, changes via preview branch + pull request against sites.branch; client_retains: never pushed, proposed documents only.';
comment on column sites.branch is
  'The PRODUCTION branch of record — what the production deployment serves. Never assumed to be main; a preview push never moves it.';
comment on column sites.preview_branch is
  'The most recent preview branch site-push created from the branch of record (its pull request targets sites.branch).';
comment on column sites.content_adapter is
  'foundation_brand_content | lucas_json | markdown_blog | unsupported — detected from the repository tree (src/lib/content-adapters.ts), never inferred from another site.';
comment on column sites.foundation_version is
  'Foundation version the repository actually carries (detected), or the version a new build was made from. A version is not evidence that an older site adopted it: null until detected.';
comment on column sites.build_brief is
  'The website build brief (src/lib/build-brief.ts BuildBrief JSON): standard version + SHA, repository/branches, adapter, sources, page plan, links, assets, contact, missing inputs, evidence, preview.';

-- Backfill from what the rows already say. A client-run site is
-- client_retains; a Next.js site Tom built and pushed is upgrade_existing;
-- the Astro blueprint (Shewmaker) and rows with nothing pushed stay null.
update sites set work_mode = 'client_retains' where work_mode is null and controlled_by_compass = false;
update sites set work_mode = 'upgrade_existing'
where work_mode is null and controlled_by_compass and stack = 'nextjs' and last_pushed_at is not null;
update sites set content_adapter = 'lucas_json'
where content_adapter is null and content_paths is not null and coalesce(content_paths->>'blog_format', 'json') = 'json' and content_paths ? 'locations';

-- ── The pinned Foundation release ─────────────────────────────────────────
create table if not exists foundation_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  source_repo text not null,
  source_sha text not null,
  accepted_on date,
  handoff_url text,
  documents jsonb not null default '[]',
  is_current boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);
create unique index if not exists foundation_releases_one_current on foundation_releases (is_current) where is_current;
alter table foundation_releases enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'foundation_releases' and policyname = 'team full access') then
    create policy "team full access" on foundation_releases for all to authenticated using ((select is_team())) with check ((select is_team()));
  end if;
end $$;

insert into foundation_releases (version, source_repo, source_sha, accepted_on, handoff_url, documents, is_current, notes)
values (
  'v1',
  'Compass2026/showmeelectricalwebsite',
  '94014af35316c94616dadb3f8d606a4b68577fb0',
  '2026-09-20',
  'https://github.com/Compass2026/showmeelectricalwebsite/blob/codex/foundation-v1-handoff/docs/foundation-v1-handoff.md',
  '[{"label":"Compass Website Build Standard v1.1","url":"https://docs.google.com/document/d/1aN23Jc2rvN31doduv3leMimEj8pqo4xUThO2o7AlA9w/edit"},
    {"label":"Compass Page Template Library v1.1","url":"https://docs.google.com/document/d/1CsSsey-3KO830-u3XPOY1L2AVOfX7XDrr7qFg_1st_8/edit"},
    {"label":"Compass Website Foundation v1: Review and Completion Brief","url":"https://docs.google.com/document/d/1exdtCcFvmH0kn5pEPc9cjAJDhnv7WgqfOieO7NTnxcc/edit"}]'::jsonb,
  true,
  'Accepted Sept 20 2026. Reference client Show Me Electrical; Harbor Lane is a fictional demonstration brand whose facts, copy, assets and routes are never reused. Verify with FRESH=1 npm run verify.'
)
on conflict (version) do update set source_repo = excluded.source_repo, source_sha = excluded.source_sha, accepted_on = excluded.accepted_on, handoff_url = excluded.handoff_url, documents = excluded.documents, is_current = excluded.is_current, notes = excluded.notes;

-- ── Stage and task wording: the Foundation, not Astro ─────────────────────
update stages s set description =
  'PB4b — Website build from the accepted Compass Website Foundation (foundation_releases.is_current) and the client''s build brief: new_build lands on the branch of record; upgrade_existing lands on a preview branch with a pull request against the recorded production branch; client_retains skips this pipeline. Verified with the Foundation''s own checks (typecheck, build, manifest, crawl, mocked forms, browser) before the stage completes.'
from pipelines p where s.pipeline_id = p.id and p.key = 'website' and s.name = 'Build to 70%';

update task_templates tt set title = 'Confirm the stack, work mode and branch of record; record the site row (repo, production branch, Vercel project)'
from stages s join pipelines p on p.id = s.pipeline_id
where tt.stage_id = s.id and p.key = 'website' and s.name = 'Discovery' and tt.key = 'site_row';

update task_templates tt set title = 'Build brief generated from the CRM and filed in Drive 04 Website (standard version + SHA, repo, branches, adapter, sources, page plan)'
from stages s join pipelines p on p.id = s.pipeline_id
where tt.stage_id = s.id and p.key = 'website' and s.name = 'Build to 70%' and tt.playbook_step = 'PB4b.1';

update task_templates tt set title = 'Brand layer from the approved brand board (site.config, theme.css, fonts, theme.config) on a copy of the Foundation at the pinned SHA'
from stages s join pipelines p on p.id = s.pipeline_id
where tt.stage_id = s.id and p.key = 'website' and s.name = 'Build to 70%' and tt.playbook_step = 'PB4b.2';

update task_templates tt set title = 'City pages only where the city gate passes (coverage confirmed + distinctive local material); hubs for folded services; physical locations only when real'
from stages s join pipelines p on p.id = s.pipeline_id
where tt.stage_id = s.id and p.key = 'website' and s.name = 'Build to 70%' and tt.playbook_step = 'PB4b.5';

-- Open tasks on not-yet-started stages pick up the new wording; done tasks keep theirs.
update tasks t set title = tt.title
from task_templates tt
join stages s on s.id = tt.stage_id
join pipelines p on p.id = s.pipeline_id and p.key = 'website'
join client_stages cs on cs.stage_id = s.id
where t.client_stage_id = cs.id and t.status = 'open' and cs.status = 'not_started'
  and ((t.key is not null and t.key = tt.key) or (t.playbook_step is not null and t.playbook_step = tt.playbook_step));
