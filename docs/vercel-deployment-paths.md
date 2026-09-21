# Vercel deployment paths for a CRM push

Verified against the live `compassmarketin` team on Sept 21 2026, before
merging the `site-push` commit-identity change (PR #46).

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

`lucas-construction` (`prj_q0vm00Aw8zOvmPHiW2x9FC2ST8eu`), one commit,
two deployment records:

| commit | deployment | state | target | path |
| --- | --- | --- | --- | --- |
| `7ecd1c5` (`main`) | `dpl_D2J7YTpx…` | **BLOCKED** | production | Git integration |
| `7ecd1c5` (`main`) | `dpl_4ZtokR2C…` | READY | production | `site-push` |
| `117f2bd` (`compass/2026-09-roof-repair-storm-damage`) | `dpl_CL9fxLBr…` | **BLOCKED** | null | Git integration |
| `117f2bd` (same) | `dpl_37nryFSE…` | READY | null | `site-push` |

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

| commit | author email | GitHub `author.login` | Git deployment |
| --- | --- | --- | --- |
| `57d8ab8` | `crm@compassmarketing.ai` | **none** — GitHub returns no author object | BLOCKED |
| `7119da7` | `thomas@compassmarketing.ai` | `Compass2026` (id 262452829) | see below |

`compass2026-5316` is the Vercel account that creates every deployment on
this team, so `Compass2026` is the team's connected Git account. Moving the
CRM's commit email to `thomas@compassmarketing.ai` therefore makes the
author resolvable **and** a team member — which is what PR #46 intends, and
also exactly what stops Vercel blocking path 1.

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

That accident is already on record, stopped only by BLOCKED, on
`compassactivationtestfictional-zero` (`prj_YodN37ffiywps9cEAjlgVtYM9vIk`):
deployment `dpl_9BtHeaguLiy66m8VeiHiafUhnh8X`, commit `4e40310` on branch
`compass/preview-20260921-compassactivationtestfic`, **target
`production`**, state BLOCKED.

## What has to happen first

Path 1 must be switched off for the projects `site-push` manages, so
`POST /v13/deployments` stays the only path. Two candidates were tested on
Sept 21 2026 against `compassactivationtestfictional-zero`
(`prj_YodN37ffiywps9cEAjlgVtYM9vIk`), the Vercel project of the fictional,
offboarded client *Compass Activation Test (fictional)*.

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

### Repo-level `vercel.json` — works

```json
{ "git": { "deploymentEnabled": false } }
```

Commit `7119da7` on branch `compass/preview-20260921-compassactivationtestfic`,
authored **and** committed as `Compass CRM <thomas@compassmarketing.ai>` —
the post-fix identity on purpose, so Vercel had no reason to block it.

- **Baseline:** 3 deployments, every one `source: "git"`, each created
  within ~2 s of its push. That is the control: pushes to this branch do
  produce Git-integration records.
- **Result:** no deployment record for `7119da7` at 55 s, 89 s, 2.5 min or
  3.5 min. The count stayed at 3.

So the config suppresses the Git integration before it creates anything —
and it does so for a commit whose author *is* a team member, which is the
state this repository is moving to.

**Caveat, stated plainly:** the clean proof of causation is a negative
control — re-push without `vercel.json` and watch a record appear. It was
not run, because on this project that deployment would be the project's
first and Vercel would promote it to production. The inference rests on the
three prior pushes to the same branch and on the author change biasing
toward a record appearing, not away.

## What the tests here do and do not cover

`tests/site-push-handler.test.mjs` pins path 2: exactly one
`POST /v13/deployments` per push, previews never requested on the
production target, a blocked push making no request at all, and the commit
identity on all three commit paths. Nothing in this repository can observe
path 1 — it is Vercel reacting to GitHub. Those tests passing does **not**
mean one deployment happened.
