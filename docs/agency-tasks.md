# Agency work management — slice 1 (Sept 22 2026)

Team members can be assigned client tasks, create them, update them and
comment on them. The CRM shows who changed a task and when. Pipelines,
worker-created tasks, monthly cycles, reporting and site publishing keep
working as before.

## Dependency

| | |
| --- | --- |
| Branch | `claude/agency-tasks-assignment` |
| Based on | PR #51's head `claude/gallant-lamport-ilg6id` @ `7392257` (reconciles 0036–0038, adds 0007a and 0042) |
| Migration | `0043_task_assignment.sql`: **new, not applied** |
| Needs applied first | 0036 (`is_team()`, linked `team_members`), which is live. 0043 does not touch 0041 (PR #50) or 0042 (PR #51) and applies on top of either or both. |
| Merge order | #51, then this PR. If #50 lands first, nothing conflicts except `src/lib/database.types.ts`: regenerate it. |

Live state on Sept 22, checked read-only: last recorded migration 0040; 510
tasks, 183 open (66 TOM, 117 CLAUDE), 0 overdue. One team member. No task
points at another client's stage or cycle, so 0043's checks hold for every
existing row.

## What changed

**Database (0043, additive):**

- `tasks.assignee_id`, `created_by`, `updated_by` (nullable FKs to
  `team_members`, `on delete set null`) and `updated_at`, plus a
  `unique (id, client_id)` for the composite FKs. No backfill: every existing
  task stays unassigned, with no author and no history.
- `tasks_aa_stamp` (BEFORE INSERT/UPDATE) stamps the actor from `auth.uid()`.
  A caller with no JWT (the worker, pg_cron, the service role) stamps NULL,
  and the app shows that as "Worker / system". The trigger also refuses a task
  that changes client, or that points at another client's stage or cycle.
  Those checks run only when those columns are set or changed.
- `task_events`: an append-only history (created / status / assignee / due
  date / title / owner), written only by the `tasks_history` trigger. The
  team can read it. Nothing can write it over the API.
- **The CLAUDE lane can't have an assignee** (`tasks_claude_lane_unassigned`:
  `check (owner <> 'CLAUDE' or assignee_id is null)`). `CLAUDE` means the
  worker executes the task, so a person's name on it would be misleading. To
  give such a step to a person, move the lane first; the worker already sets
  `owner = 'TOM'` when a Google op fails. The check also refuses moving an
  assigned task into the CLAUDE lane. It applies to the worker as well as the
  team. Every live task is unassigned, so it holds for all existing rows.
  **`CLAUDE_APPROVAL` is not covered.** It's the "hold" lane: the worker has
  drafted and a person decides. The Brief lists it under "needs a decision"
  and the Dashboard under "needs attention", and the worker never runs it on
  its own. Naming the person who decides is the point of assigning it. 0014
  moved every open one and every template to `CLAUDE`; live data has 0 open
  and 2 done.
- `task_comments`: the team can read and add comments; comments can't be
  edited or deleted in v1. The author is the signed-in member, and the client
  is the task's; a comment naming a different client is refused.
- `tasks_zz_fire_worker` is untouched and still fires on `client_review` /
  `dns_records`.

**App:**

- `src/app/task-actions.ts`: create, update / assign and comment. Every action
  calls `requireTeamMember` first, validates its input (`src/lib/tasks.ts`),
  checks the assignee is on the team and scopes the update to the task's
  client. `updateTaskAction` reads the task's lane and refuses an assignee
  on a CLAUDE task before writing. It also turns the constraint error into
  the same message, in case the lane changes between the read and the
  write. `addTaskAction` / `toggleTaskAction` get the same team check, and
  the toggle is now scoped to the client it names.
- `/tasks` has these views:
  - **My work**
  - **Unassigned**: open work with no assignee, leaving out only the CLAUDE
    lane. TOM, CLAUDE_APPROVAL, DELEGATED and WAITING all show.
  - **Overdue**: open work due before today in America/Chicago
  - **By client**
  - **All open**: the default, unchanged
  - The lane, autonomy and flagged filters still combine with every view.
  - There's a New task form, and each row has an inline assignee picker plus
    "Updated by X, time". CLAUDE rows show "Worker runs this" instead of a
    picker.
- `/tasks/[id]`: edit title, status, assignee, due date and notes. On a
  CLAUDE task the assignee picker is disabled, with a line explaining why.
  A disabled field isn't submitted, and the action refuses it anyway. The worker
  fields are shown read-only, alongside the activity (history plus comments)
  and a comment box.
- A client **Tasks** tab (`/clients/[id]/tasks`) holds that client's pipeline,
  monthly and hand-made tasks, with a create form.
- The app header wraps its nav onto a scrollable row below 640px. It already
  overflowed on phones before this change, and the mobile check caught it.

## Screenshots

These are local, fictional data (`docs/screenshots/agency-tasks/`):

| | |
| --- | --- |
| All open | `tasks-all-open-desktop.png` |
| My work | `tasks-my-work-desktop.png` |
| Unassigned | `tasks-unassigned-desktop.png` |
| Overdue | `tasks-overdue-desktop.png`, `tasks-overdue-mobile.png` |
| By client | `tasks-by-client-desktop.png` |
| Task detail | `task-detail-desktop.png`, `task-detail-mobile.png` |
| CLAUDE-lane task (assignee disabled) | `task-detail-claude-lane-desktop.png` |
| Client Tasks tab | `client-tasks-tab-desktop.png`, `client-tasks-tab-mobile.png` |

## Tests

| Command | What | Result |
| --- | --- | --- |
| `npm test` | Unit and contract tests: view parsing, Central-time "today", overdue, form validation (worker fields never read from a form), `completed_at` rules, history sentences, grouping, a static check that every task action calls `requireTeamMember` before writing, and the lane rule (`canAssignLane`, `assignmentError`, plus a static check that the action, list, edit form and migration all enforce it) | 101 / 101 |
| `npm run test:sandbox` | Every migration replayed into local Postgres 16, then `portal_access.test.sql` (unchanged) and the new `task_assignment.test.sql`. The new checks cover shape; team create / assign / reassign / unassign; attempts to forge `created_by` / `updated_by` / comment author; history; comment rules; attempts to move a task or point it at another client's stage or cycle; assignees that aren't team members (a portal user id, a random id); worker-created tasks (no author, worker closes them, the assignment survives, the worker still creates unassigned tasks); the `client_review` fire; portal, stranger and anon getting nothing. The CLAUDE lane (L1–L14):<br>• assigning is refused for the team and the worker, and a refused attempt writes no history<br>• a CLAUDE task can't be created with an assignee, but its other fields stay editable<br>• CLAUDE_APPROVAL, WAITING and DELEGATED stay assignable<br>• an assigned task can't move into the CLAUDE lane<br>• the worker's handover to TOM, then an assignment, both land in the history<br>Negative control: with the constraint removed, 7 of the L checks fail | 316 + 79 pass, 0 fail |
| `npm run test:tasks-ui` | The same replay behind PostgREST, a stand-in for Supabase Auth's `/user`, `next dev` and headless Chrome. Real RLS, triggers and server actions: every view, create, inline assign, edit, comment, history names, the existing done toggle firing the worker, 390px layouts with no horizontal scroll, and a portal contact redirected to `/portal` who reads and changes nothing through the API. For the CLAUDE lane: no picker in lists, the picker disabled on the task, and a forged submit (select re-enabled in the DOM) refused by the server action with the database unchanged. A CLAUDE_APPROVAL task shows in Unassigned with a picker | 11 / 11 |
| `tsc --noEmit`, `eslint`, `next build` | | clean (12 existing lint warnings in other files) |

The sandbox needs PostgreSQL 15+ and `postgrest` (`brew install
postgresql@16 postgrest`; `PG_BIN=$(brew --prefix postgresql@16)/bin`). The
UI check also needs Google Chrome. `test-portal-sandbox.sh` gained a macOS
fix: Bash 3.2's empty-array handling and a locale for Homebrew's Postgres.

**Not tested against the live project.** 0043 has not been applied anywhere
but the local replay. `database.types.ts` was edited by hand in the
generator's format for the two new tables and four new columns. Regenerate
it after applying.

## Rollout

1. Merge #51 (and #50 if it's ready). Apply 0042 per
   `docs/portal-reconciliation.md`.
2. Dry-run 0043 against the project the way earlier migrations were: one
   `execute_sql` batch ending in `raise` so it rolls back. Its verify block
   fails loudly if a policy, grant or function privilege is wider than
   intended.
3. Apply 0043 (`apply_migration`, name `0043_task_assignment`).
4. Regenerate `src/lib/database.types.ts` and confirm the diff contains only
   the 0043 additions.
5. Merge and deploy. Until 0043 is applied, the new pages error, because the
   columns don't exist yet. **Apply before deploying.**
6. Smoke test as a team member:
   - Assign a task to yourself, check that My work shows it, add a comment,
     and check that the history names you.
   - Check that a worker-closed task shows "Worker / system".
7. Add teammates as `AGENTS.md` describes (invite in Supabase Auth, then
   insert a `team_members` row). They appear in every assignee picker.

## Rollback

- **App only:** revert the merge. The extra columns and tables are ignored by
  the old code. The worker never reads them.
- **Database:** run this in one transaction. It loses assignments, comments
  and history recorded since rollout, so export `task_comments` and
  `task_events` first if you need them.

  ```sql
  drop trigger if exists tasks_history on tasks;
  drop trigger if exists tasks_aa_stamp on tasks;
  drop table if exists task_comments, task_events;
  drop function if exists tasks_record_history(), tasks_stamp_and_check(),
    task_comments_stamp(), task_actor();
  alter table tasks drop constraint if exists tasks_id_client_key,
    drop column if exists assignee_id, drop column if exists created_by,
    drop column if exists updated_by, drop column if exists updated_at;
  ```

  Then remove the recorded 0043 version from
  `supabase_migrations.schema_migrations`, or add a 0044 containing the
  rollback. Nothing else depends on these objects.

## Decisions (Tom, Sept 22)

1. `owner` stays the workflow lane and `assignee_id` the person responsible.
   Assigning someone never changes `TOM` to `DELEGATED`.
2. `WAITING` tasks stay visible in Unassigned.
3. All open stays the default view while most tasks are unassigned.
4. Any team member can edit tasks in this slice. Role restrictions come
   before sensitive actions such as publishing.
5. Comments stay immutable. Notifications and mentions are deferred.

## Open

- A CLAUDE task can only become assignable once its lane moves to a human
  one, and the UI has no lane control. Today only the worker (or SQL) moves
  lanes. If the team needs to take over worker steps by hand, a "Take over
  from the worker" control (CLAUDE → TOM) is the natural next step.
- Bulk data migrations that update tasks also write `task_events` rows as
  "Worker / system". That's harmless, but worth knowing before the next
  reseed.
