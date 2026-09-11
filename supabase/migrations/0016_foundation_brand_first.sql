-- Foundation runs Brand Build first (Tom, Sept 11 2026).
--
-- 0011 put the service taxonomy at stage 1 because the reconciliation doc
-- calls it "the spine". But the brand board reads the client's website, not
-- the service list, and Tom wants it drafted before anything else. Keyword
-- research does depend on the taxonomy (keywords link to services), so the
-- order becomes strictly sequential:
--
--   1. Brand Build                       (PB2)
--   2. Onboarding & Service Taxonomy     (PB1)
--   3. Keyword Research                  (PB3)
--
-- Stage ids are untouched — only sort_order changes — so client_stages, tasks
-- and deliverables stay attached. The gate becomes "every earlier Foundation
-- stage is complete", which is what a worker walking the stages in order
-- expects.

update stages s
set sort_order = v.sort_order,
    description = v.description
from pipelines p,
(values
  ('Brand Build', 1,
   'PB2 — brand board: palette, typography, positioning line, standing CTA, hard rules, sourced vs unverified claims. Drafted from the website and public listings; nothing else waits on it except the stages below.'),
  ('Onboarding & Service Taxonomy', 2,
   'PB1 — intake, access, and the service taxonomy (services table). Runs after Brand Build; Keyword Research waits for it.'),
  ('Keyword Research', 3,
   'PB3 — demand table, money keywords, page groups, tracked list. Runs after the taxonomy because every keyword links to a service.')
) as v(name, sort_order, description)
where s.pipeline_id = p.id and p.key = 'foundation' and s.name = v.name;

-- Sequential gate within Foundation; the requires_foundation gate is unchanged.
create or replace function enforce_stage_gates() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_stage stages%rowtype;
  v_cp client_pipelines%rowtype;
  v_key pipeline_key;
  v_blocker text;
begin
  if new.status = old.status or new.status in ('not_started', 'skipped') then
    return new;
  end if;

  select * into v_stage from stages where id = new.stage_id;
  select * into v_cp from client_pipelines where id = new.client_pipeline_id;
  select key into v_key from pipelines where id = v_cp.pipeline_id;

  if v_stage.requires_foundation and not foundation_complete(v_cp.client_id) then
    raise exception '% cannot start until Foundation is complete for this client', v_stage.name
      using errcode = 'check_violation',
            hint = 'Finish Brand Build, Onboarding & Service Taxonomy and Keyword Research first.';
  end if;

  -- Foundation: each stage waits for every earlier one.
  if v_key = 'foundation' then
    select s.name into v_blocker
    from client_stages cs
    join stages s on s.id = cs.stage_id
    where cs.client_pipeline_id = new.client_pipeline_id
      and s.sort_order < v_stage.sort_order
      and cs.status not in ('complete', 'skipped')
    order by s.sort_order
    limit 1;
    if v_blocker is not null then
      raise exception '% cannot start until % is complete', v_stage.name, v_blocker
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

revoke execute on function enforce_stage_gates() from public, anon, authenticated;

-- ── Convergence needs a real pipeline ────────────────────────────────────
-- Every client is in Foundation, so "no incomplete non-recurring enrollment"
-- was true the moment Foundation finished for a client enrolled in nothing
-- else, flipping it to active and starting Reporting with no work behind it
-- (AGENTS.md, Shewmaker load notes). Converge only when at least one
-- department pipeline exists and everything non-recurring is complete.
create or replace function handle_pipeline_completion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'complete' and old.status is distinct from 'complete' then
    if exists (
      select 1
      from client_pipelines cp
      join pipelines p on p.id = cp.pipeline_id
      where cp.client_id = new.client_id
        and p.is_recurring = false
        and p.key <> 'foundation'
    )
    and not exists (
      select 1
      from client_pipelines cp
      join pipelines p on p.id = cp.pipeline_id
      where cp.client_id = new.client_id
        and p.is_recurring = false
        and cp.status <> 'complete'
    ) then
      update clients set status = 'active'
      where id = new.client_id and status = 'launching';

      insert into client_pipelines (client_id, pipeline_id, status)
      select new.client_id, p.id, 'active'
      from pipelines p
      where p.is_recurring
        and not exists (
          select 1 from client_pipelines cp2
          where cp2.client_id = new.client_id and cp2.pipeline_id = p.id
        );
    end if;
  end if;
  return new;
end $$;

revoke execute on function handle_pipeline_completion() from public, anon, authenticated;
