# Vercel deployment paths for a CRM push

Verified against the live Vercel team on Sept 21 2026, before merging the
`site-push` commit-identity change (PR #46).

Identifiers here are illustrative. Client names, Vercel project and
deployment ids and real commit SHAs are deliberately left out — look them
up in Vercel and GitHub rather than trusting a copy in a document.

## There are two paths, not one

A `site-push` push to a client repo can produce a Vercel deployment two ways:

1. **Vercel's Git integration.** The Vercel GitHub App sees the push and
   creates a deployment on its own. The project is linked: `site-push`
   creates projects with `gitRepository: { type: "github", repo }`
   (`handler.ts`, the `/v10/projects` call).
2. **`site-push`'s own `POST /v13/deployments`**, with an explicit
   `target` — production for the branch of record, none (preview) for a
   side branch.

Both fire for every push. Path 1 has been invisible only because every
deployment it created was **BLOCKED**: Vercel blocks a Git deployment whose
commit author is not a team member, and the CRM committed as
`Compass CRM <crm@compassmarketing.ai>`, an address on no Vercel team.

## The evidence

A CRM-managed client project, two commits, two deployment records each
(identifiers below are illustrative; the live ones are in Vercel):

| commit | deployment | state | target | path |
| --- | --- | --- | --- | --- |
| `c0ffee1` (branch of record) | `dpl_A1` | **BLOCKED** | production | Git integration |
| `c0ffee1` (branch of record) | `dpl_A2` | READY | production | `site-push` |
| `c0ffee2` (`compass/<content-branch>`) | `dpl_B1` | **BLOCKED** | null | Git integration |
| `c0ffee2` (same) | `dpl_B2` | READY | null | `site-push` |

The BLOCKED record is not a curiosity — it is the duplicate, already being
created today and stopped only by the author check.

## Why BLOCKED happens — established, not inferred

The BLOCKED deployment carries
`errorLink: https://vercel.com/docs/deployments/troubleshoot-project-collaboration#account-configuration`
and `source: "git"`. That page says it plainly:

> To deploy commits under a Vercel Pro team, the commit author must be a
> member of the team containing the Vercel project connected to the Git
> repository.
>
> Your git provider associates commits with users by matching the commit
> email to an email on your git provider account.

So the chain is: commit email → GitHub user → Vercel team member. Both ends
are confirmed on the same repository:

| author email | GitHub author | Git deployment |
| --- | --- | --- |
| the CRM's old address | **none** — GitHub returns no author object for it | BLOCKED |
| the team member's address | the team's connected Git account | not blocked |

The account that creates every deployment on this team is the same Git
account the team member's address resolves to. Moving the CRM's commit email
to that address therefore makes the author resolvable **and** a team member
— which is what the identity change intends, and also exactly what stops
Vercel blocking path 1.

## Why the commit-identity fix cannot ship on its own

Moving the commit author to `thomas@compassmarketing.ai` makes the author a
team member, which is the point: it is what unblocks Vercel. It therefore
also **unblocks path 1**. Every CRM push would then build and deploy twice.

Worse, it breaks the first-deployment rule. On a project with no successful
deployment, Vercel promotes the first deployment to production **whatever
the branch**. `site-push` guards this by refusing to deploy a preview into a
zero-deployment project — but that guard only governs path 2. Path 1 fires
from the GitHub push, before and independently of anything `site-push`
checks, so a preview-branch commit would become a live production
deployment with no guard in front of it.

That accident is already on record, stopped only by BLOCKED: on a
disposable test project with no successful deployment, a commit on a
`compass/preview-…` branch produced a deployment whose target was
**`production`**.

## First attempt: switch path 1 off (rejected)

The first idea was to switch path 1 off so `POST /v13/deployments` stayed
the only path. Two candidates were tested on
Sept 21 2026 against a disposable Vercel project belonging to a fictional,
offboarded test client — no custom domain, and no successful deployment
ever.

### Project-level `deploymentPolicy` — not available

`PATCH /v9/projects/{id}` with `deploymentPolicy.deploymentSources`
(disable source `git` for production and preview) and again with
`deploymentPolicy.gitSources` scoped to the repository. Both returned:

```
404 {"error":{"code":"not_found","message":"Deployment Policy not found."}}
```

The field is in Vercel's live API schema but the feature is not provisioned
for this team. Nothing was modified — the project read back at its
unchanged baseline of 3 deployments. **Rule this out.**

### Repo-level `vercel.json` — works, but REJECTED as the solution

```json
{ "git": { "deploymentEnabled": false } }
```

One commit on that project's `compass/preview-…` branch, authored **and**
committed with the team member's address — the post-fix identity on
purpose, so Vercel had no reason to block it.

- **Baseline:** 3 deployments, every one `source: "git"`, each created
  within ~2 s of its push. That is the control: pushes to this branch do
  produce Git-integration records.
- **Result:** no deployment record for that commit at 55 s, 89 s, 2.5 min,
  3.5 min or 5 min. The count never moved off its baseline.

So the config does suppress the Git integration — and that is exactly why
it is the wrong tool. It is **repo-wide**: it would equally suppress the
deployments that Claude Code project sessions, Codex and plain `git push`
depend on. Recorded here because the measurement is sound and worth
keeping; **not** the approach taken. See v11 below.

**Caveat, stated plainly:** the clean proof of causation — re-push without
the config and watch a record appear — was not run, because on that project
the deployment would have been its first and Vercel would have promoted it
to production. Moot now that the approach is rejected.

## What site-push does about it (v11): adopt the native deployment

The first attempt (v10) put `git.deploymentEnabled: false` into every client
repository. That was **wrong for the workflow** and was never rolled out:
the flag is repo-wide, so it would also have stopped the deployments that
Claude Code project sessions, Codex and plain `git push` rely on. Deploying
from a direct commit is the normal way of working here, not a fault.

So the native Git deployment becomes the **only** path, and site-push stops
making one. Per push it now: finds Vercel's deployment by commit SHA
(polling, since it appears a second or two later), fetches its detail,
verifies it is the Git-created deployment for the expected project, branch
and SHA, checks the target matches the branch class, and reports it.

- **Exactly one** deployment per commit is required. Two is reported as
  `duplicate` with both ids, never silently picked between.
- **None within the deadline** is reported as `not_found`, naming the
  likely causes — the Vercel GitHub App cannot see the repository, the
  project is not linked, or the repository disables Git deployments.
- **Wrong target** either way is `failed`: a preview push that produced a
  production target, or a branch-of-record push that did not.
- **`deploy: false` is refused (400).** It used to mean "do not create the
  deployment". It cannot mean that now, and silently deploying something a
  caller asked not to deploy is worse than an error. Nothing in the
  repository, the app or the worker skill passed it.
- **One REST deployment survives**, for the only operation that creates no
  commit and genuinely needs a redeploy: `{client_id, deploy: true}` with no
  files, behind Tom's Redeploy button. It refuses while a deployment of the
  same head is still in flight, so it can never be the accidental second
  one. *Put it back* no longer calls it — the revert is a new commit, which
  Vercel deploys by itself.

### The new-project rule, and why ORDER is the safety property

A project with no successful production deployment promotes its first
deployment to production **whatever the branch**. Proven on a disposable
fictional project on Sept 21 2026, with a static probe folder isolated by
`rootDirectory`:

| # | push | author | deployments for the SHA | `source` | `target` | state |
| --- | --- | --- | --- | --- | --- | --- |
| A | production branch | the CRM identity | 1 | `git` | `production` | READY |
| B | first side-branch commit, after A | the CRM identity | 1 | `git` | `null` (preview) | READY |
| C | production branch | a normal Claude session identity | 1 | `git` | `production` | READY |

A establishes the project; B is then correctly a preview; C shows an
ordinary Claude commit deploying natively. Before A, a side-branch push on
that project had come back `target: "production"`.

**The check is worth nothing unless it runs first.** The Git integration
deploys from the push, so a guard that runs after the push is too late —
and worse, a guard that runs after the project has been *created* leaves a
linked project with zero deployments behind, which is armed: the next
preview push lands in it and becomes its first, production, deployment.
That was a real defect in an earlier revision of this branch, caught in
review.

So everything that could make a push unsafe is decided in a **preflight,
before one byte reaches GitHub** — including the creation of a side branch,
which is itself a push and is deferred until the preflight has cleared:

- **Preview push.** Project missing → blocked, and it is *not* created or
  linked. Project present but with no READY **production** deployment →
  blocked. State unconfirmable, including no `VERCEL_TOKEN` → blocked. In
  every case nothing is pushed.
- **Production push to a brand-new project.** The project is created and
  linked, and its production branch is set to the branch of record and
  **read back** to confirm it — the read-back is the guarantee, and a
  failure to confirm blocks before pushing. Only then does the push happen,
  so Vercel's Git integration makes exactly one production deployment. No
  second Redeploy, no "first push" special case.
- **Existing project whose production branch is not the branch of record.**
  Reported and the push is blocked. The production branch is **never**
  changed automatically. (An unreported production branch that matches the
  repository's default branch is the Vercel default and needs no change.)
- **Revert is a push too.** `{revert: true}` commits on the branch of record,
  so Vercel deploys it to production like anything else. It takes the same
  preflight before the commit exists and before the ref moves — a mismatched
  production branch blocks it with no GitHub write — and afterwards its
  deployment is located and verified by SHA exactly as a normal push is. No
  REST deployment is ever made for a revert.

## What the tests here do and do not cover

`tests/site-push-handler.test.mjs` pins the request boundary: exactly one
no REST deployment for a push, the commit identity on all
three commit paths, and the `vercel.json` enforcement — bootstrap ordering,
atomic inclusion, settings preserved, invalid and unreadable failing closed
before any commit, deletion and re-enabling refused, duplicate detection by
SHA, and the revert path: across the pre-rollout boundary, with settings to
preserve, and failing closed on an invalid or unreadable restored file.

Nothing in this repository can observe path 1 — it is Vercel reacting to
GitHub. Those tests passing does **not** by itself mean one deployment
happened; the duplicate sweep is what reports that from production.
