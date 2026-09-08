-- Reseed pipelines and stages for the playbook model (build order step 2):
-- Foundation is new, SEO and Website are rewritten to Playbooks 4a / 4b, and
-- the Reporting task templates absorb Playbooks 5 and 6. Social, CRM and
-- Paid Ads keep their v0.2 stages. Source: docs/reconciliation.md.
--
-- Existing enrollments keep their progress. Stages that survive the rewrite
-- are updated in place (same ids, so client_stages, tasks and deliverables
-- stay attached). The two SEO stages that moved into Foundation hand their
-- client rows over before they are deleted.

-- ── Foundation: new pipeline, every client runs it ───────────────────────
insert into pipelines (key, name, sort_order, is_recurring)
values ('foundation', 'Foundation', 0, false);

insert into stages (pipeline_id, name, sort_order, is_optional, description,
                    default_owner, playbook_ref, autonomy_level, requires_foundation)
select p.id, s.name, s.sort_order, false, s.description,
       s.default_owner::owner_type, s.playbook_ref, s.autonomy_level::autonomy_level, false
from pipelines p,
(values
  ('Onboarding & Service Taxonomy', 1,
   'PB1 — intake, access, and the service taxonomy (services table). Gate: taxonomy approved by Tom. Brand Build and Keyword Research unlock when this completes.',
   'CLAUDE_APPROVAL', 'PB1', 'hold'),
  ('Brand Build', 2,
   'PB2 — brand board: palette, typography, positioning line, standing CTA, hard rules, sourced vs unverified claims. Gate: brand board approved. Runs in parallel with Keyword Research.',
   'CLAUDE_APPROVAL', 'PB2', 'hold'),
  ('Keyword Research', 3,
   'PB3 — demand table, money keywords, page groups, tracked list. Gate: keyword map + tracked list approved. Runs in parallel with Brand Build.',
   'CLAUDE_APPROVAL', 'PB3', 'hold')
) as s(name, sort_order, description, default_owner, playbook_ref, autonomy_level)
where p.key = 'foundation';

-- Existing clients (new ones are enrolled by the trigger in 0012). The
-- enrollment trigger creates their Foundation client_stages.
insert into client_pipelines (client_id, pipeline_id, status)
select c.id, p.id, 'active'
from clients c
cross join pipelines p
where p.key = 'foundation'
  and not exists (
    select 1 from client_pipelines cp
    where cp.client_id = c.id and cp.pipeline_id = p.id
  );

-- ── SEO: rewritten to Playbook 4a ────────────────────────────────────────
update stages s
set name = v.name, sort_order = v.sort_order, description = v.description,
    default_owner = v.default_owner::owner_type, playbook_ref = v.playbook_ref,
    autonomy_level = v.autonomy_level::autonomy_level, requires_foundation = true
from pipelines p,
(values
  ('Audit', 'Audit & Adjust', 1,
   'PB4a — audit against the approved taxonomy and keyword map, then adjust: on-page, technical, off-page. Run / Run+Flag / Hold per step.',
   'CLAUDE', 'PB4a', null),
  ('GBP Setup & Optimization', 'GBP Setup & Optimisation', 2,
   'Run+Flag.', 'CLAUDE', null, 'run_flag'),
  ('Local Citations', 'Local Citations', 3,
   'Citation build list + completion sheet. Run.', 'CLAUDE', null, 'run'),
  ('Backlink Foundation', 'Backlink Foundation', 4,
   'Run+Flag.', 'CLAUDE', null, 'run_flag'),
  ('Tracking & Reporting Setup', 'Tracking Setup (GSC, BrightLocal)', 5,
   'GSC property, BrightLocal LRT + LSG reports, tracked list pushed. Run.', 'CLAUDE', null, 'run')
) as v(old_name, name, sort_order, description, default_owner, playbook_ref, autonomy_level)
where s.pipeline_id = p.id and p.key = 'seo' and s.name = v.old_name;

-- Onboarding and Keyword Research & Targeting moved into Foundation: copy any
-- progress onto the client's Foundation rows, re-point tasks / deliverables,
-- then drop the old stages (cascading to their now-empty client_stages).
create temp table moved_stage_rows as
select ocs.id as old_cs, ncs.id as new_cs,
       ocs.status, ocs.owner, ocs.due_date, ocs.started_at, ocs.completed_at,
       ocs.evidence, ocs.next_action, ocs.notes
from stages os
join pipelines op on op.id = os.pipeline_id and op.key = 'seo'
join (values ('Onboarding', 'Onboarding & Service Taxonomy'),
             ('Keyword Research & Targeting', 'Keyword Research')) as m(old_name, new_name)
  on m.old_name = os.name
join stages ns on ns.name = m.new_name
join pipelines np on np.id = ns.pipeline_id and np.key = 'foundation'
join client_stages ocs on ocs.stage_id = os.id
join client_pipelines ocp on ocp.id = ocs.client_pipeline_id
join client_pipelines ncp on ncp.client_id = ocp.client_id and ncp.pipeline_id = np.id
join client_stages ncs on ncs.client_pipeline_id = ncp.id and ncs.stage_id = ns.id;

update client_stages cs
set status = m.status, owner = m.owner, due_date = m.due_date,
    started_at = m.started_at, completed_at = m.completed_at,
    evidence = m.evidence, next_action = m.next_action, notes = m.notes
from moved_stage_rows m
where cs.id = m.new_cs
  and (m.status <> 'not_started' or m.evidence is not null or m.notes is not null
       or m.next_action is not null or m.due_date is not null);

update tasks t set client_stage_id = m.new_cs
from moved_stage_rows m
where t.client_stage_id = m.old_cs;

update deliverables d set client_stage_id = m.new_cs
from moved_stage_rows m
where d.client_stage_id = m.old_cs;

drop table moved_stage_rows;

delete from stages s
using pipelines p
where s.pipeline_id = p.id and p.key = 'seo'
  and s.name in ('Onboarding', 'Keyword Research & Targeting');

-- ── Website: rewritten to Playbook 4b (Astro) ────────────────────────────
update stages s
set name = v.name, sort_order = v.sort_order, description = v.description,
    default_owner = v.default_owner::owner_type, playbook_ref = v.playbook_ref,
    autonomy_level = v.autonomy_level::autonomy_level, requires_foundation = true
from pipelines p,
(values
  ('Discovery', 'Discovery', 1,
   'Photos requested, existing-site inventory, stack confirmed. Hold (client-dependent).',
   'CLAUDE_APPROVAL', null, 'hold'),
  ('Build', 'Build to 70%', 2,
   'PB4b — Astro build from the Foundation brand board and keyword map. Run through step 9; steps 10–11 Hold.',
   'CLAUDE', 'PB4b', null),
  ('SEO QA', 'Polish & client review', 3,
   'Punch list, placeholders replaced, client review. Run+Flag.', 'CLAUDE', null, 'run_flag'),
  ('Launch', 'Launch', 4,
   'DNS, redirects, GSC submitted. Hold.', 'CLAUDE_APPROVAL', null, 'hold')
) as v(old_name, name, sort_order, description, default_owner, playbook_ref, autonomy_level)
where s.pipeline_id = p.id and p.key = 'website' and s.name = v.old_name;

-- ── Reporting: absorbs Playbooks 5 and 6 ─────────────────────────────────
-- Existing templates keep their order after the two new ones; the old
-- "Monthly report generated" template becomes the PB5 refresh + report.
update task_templates tt set sort_order = tt.sort_order + 2
from pipelines p
where tt.pipeline_id = p.id and p.key = 'reporting';

update task_templates tt
set title = 'Monthly Refresh & Report — per client',
    playbook_step = 'PB5', autonomy_level = 'hold', sort_order = 2
from pipelines p
where tt.pipeline_id = p.id and p.key = 'reporting'
  and tt.title like 'Monthly report generated%';

insert into task_templates (pipeline_id, department, title, default_owner, sort_order, playbook_step, autonomy_level)
select p.id, null, 'Industry Pulse — one per vertical, before client refreshes', 'CLAUDE', 1, 'PB6', 'run_flag'
from pipelines p
where p.key = 'reporting';
