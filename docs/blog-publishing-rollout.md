# Blog publishing rollout and BHG activation

Status: human-review-only workflow deployed October 12, 2026 UTC (October 11 Central). Lucas pilot saved in review. Automatic release and article graphics remain a later phase.

## Goal

Reuse the social workflow: governed keyword and owner page, sourced brief, article and graphic, deterministic checks, team review, approval, scheduled or immediate website publishing, verified live URL, reporting. Blog delivery uses each website repository, not Zernio. Zernio remains the Facebook/GBP transport.

## Tom's rollout requirements (October 11, 2026, 9:45 PM Central)

These decisions govern the remaining implementation. They are requirements, not a claim that automatic publishing is deployed.

### Keyword list is the foundation for every created item

Every generated blog, website page, Facebook/GBP post and future email or ad asset starts with an active keyword from that client's governed keyword list. Record the primary keyword ID, supporting cluster, search intent, service, owner page, audience/angle and campaign relationship before generation. Graphics inherit the parent campaign's keyword relationship.

An idea or a calendar slot is not permission to generate content. Missing keywords, conflicting intent, unclear ownership or missing evidence must pause the item with a specific next action. New topic opportunities enter the keyword research and mapping workflow first. Do not generate copy and attach a keyword afterward. Remove the inherited non-search generation exception for this rollout; content purpose may vary, but keyword provenance is mandatory.

The same cluster can support channel-specific angles and formats. Write naturally, avoid forced repetitions, and distinguish the main service page from supporting articles so they do not compete for the same purpose. Validate the relationship again before publication.

### Blogs move from a reviewed pilot to automatic publishing

Start each client's blog pipeline in review mode: the first few articles require team approval before publication. Show the full article, graphic, target keyword/cluster, intent, linked service page, evidence and intended destination for review. Tom has not selected a fixed pilot count, so do not invent an automatic threshold or silently switch after an arbitrary number of approvals.

Implement a separate, visible, reversible per-client blog publishing mode. After the initial reviews establish acceptable output, Tom or an authorized team admin enables automatic mode. In automatic mode, eligible articles publish on the agreed schedule without a person approving every article. Record policy-based release honestly, including the policy version and article snapshot; never fabricate a human approval or reuse a person's identity.

Keyword, evidence, originality/overlap, brand, media, links, destination, schedule and monthly allocation checks remain in automatic mode. A failed or ambiguous check returns that article to review or blocks it with a reason. Keep duplicate prevention, publication history, verified live URLs and the ability to pause automatic publishing. Editing approved or queued content invalidates its prior release and reruns the applicable checks.

Automatic blog publishing does not automatically enable automatic release for Facebook, GBP or another channel. This message sets the staged rollout direction; it does not authorize publishing the current pilot articles before review.

## Work recovered and updated

The existing `claude/blog-drafter` branch at `13392c5` contains the weekly planner, article editor, governed drafter, approval and Markdown export. Its migrations 0065 content planner, 0066 content status, 0067 drafts and 0068 weekly completion were absent from production at recovery and are now applied.

Integrated that branch with production main `8740e378f462c722f4baf067f4f185b82121133a`, preserving the current social, billing and CRM Lite code. Resolved merge conflicts in the shared brief and test harness. The blog brief now reuses the current keyword foundation, derives missing intent/service from the selected keyword, uses live keyword text, and refuses inactive/foreign keywords, intent contradictions, unapproved pages and competing keyword owners. Regression coverage includes these failure cases.

## Implementation and verification (October 11, 2026)

Deployed in CRM PR #119, with the scheduling correction and generated types in PR #120:

- Every new social/blog brief requires an active governed keyword; the old non-search exception is retired. Blog briefs record the keyword, campaign/plan relationship and approved owner page. Planner and weekly requests require keywords.
- Draft guards bind system flags to trusted sessions, reject worker metadata bypasses, freeze requested foundation, forbid claim UPDATE, and version/serialize human claim changes.
- Approval captures the full article, evidence, brief, keyword mapping and destination. Append-only approval history survives reopening.
- Human approval and queueing are separate. The review page supports immediate/future scheduling, cancellation and publication history.
- The publisher rebuilds live keyword/brand grounding, lints the article, rechecks release/claims/destination before the write, and uses a pinned repository revision. Duplicate slugs refuse; exact retries are recognized. An interrupted delivery stays uncertain and needs reconciliation, never blind re-publication.
- Only an exact production deployment and verified live article become published in the CRM. A deployment alone does not count as published.
- Lucas and BHG renderer upgrades preserve approved Markdown, H1, metadata and CTA, and carry a release marker for verification. No client article is included in those website changes.
- Two weekly tasks are planned within the existing monthly allowance. The planner counts completed slots too, preventing repeat generation after completion.

Validation: full CRM build, lint, app TypeScript, PostgreSQL migration/role suite, billing checks and real browser review workflow passed on final heads 98b387f and 9910db9. Both site renderer TypeScript/build checks passed. Edge Function type checking and targeted transport/retry tests passed locally. A live Sunday request with a Monday due date exposed a planner-week constraint failure; the transaction rolled back. Forward migration 20261012033430_blog_weekly_due_week.sql now assigns the due-date week, with a next-week regression test. The retried live request succeeded.

Production evidence:

- CRM PR #119 merged as `05935c4`; PR #120 merged as `7db1e0d`. Both production deployments reached READY.
- Lucas renderer PR #10 merged as `5851da7`, BHG renderer PR #13 as `978b7f0`; both production deployments reached READY. These changes contain no new client article.
- Planner/draft migrations, publication/approval-history migration and due-date-week forward fix applied. All five new tables have RLS and deny anonymous reads.
- `content-drafter`, `blog-publisher` and keyword-governed `post-drafter` deployed. The publication cron processes only explicitly human-queued articles.
- [Lucas pilot review](https://compass-crm-ten.vercel.app/clients/102d3b20-2795-44ae-bd64-d1e43916291c/drafts/40687f9b-5b77-4f22-ae8d-f15b8b8f963a): 945 words, version 1, status `in_review`, keyword `christmas light hanging service wentzville`, service-page owner `/christmas-lights`, three sourced claims. Blocking lint passes; two warnings flag paraphrased claims rather than exact quotations. The human reviewer can inspect both sources.
- Readback confirms zero approval records, zero publication records and no final content post for this pilot. Its task remains in progress pending review. Existing Lucas social posts remain under their existing review state.

Human review and an explicitly queued approved article are the next release gate. No real pilot has been published, so live content delivery remains to be demonstrated after approval.

## Later automatic-release phase

The initial release is human-review-only. A per-client admin-controlled automatic mode, separate policy-release history, comprehensive originality/overlap checks and integrated article graphics remain to implement before unattended release is available. There is no automatic approval-count threshold and no automatic enabling of Facebook or GBP. Do not represent the reviewed pilot as an already-operational auto-publishing mode.

## BHG Safety Partners: observed readiness

Client `3eaa3389-2a33-4004-837c-8aef90404410`, website `https://bhgsafety.com/`.

| Area | Live record | Remaining action |
| --- | --- | --- |
| Agreement | 8 blogs, 8 GBP posts, 8 social posts, 4 new pages, 1 refresh per month | Reuse existing allowance; do not create another agreement |
| Website | Compass-controlled, `Compass2026/BHGSafetyPartners`, main, `markdown_blog`, `content/blog`, Vercel `bhg-safety-partners` | Renderer contract deployed and production READY; verify first approved delivery after brand review |
| Keywords | 94 active; 37 have service, intent and target URL populated | Audit eligible clusters; fix mappings from verified pages; do not invent intent/ownership |
| Page groups | 22 | Reconcile with services and live pages |
| Brand | Version 1, status draft; Canva folder recorded | Team reviews and approves the actual board |
| Service pages | 16 approved services; 10 have no page URL | Verify and map training and industrial-hygiene destinations |
| Facebook/GBP | No social_accounts rows; no CRM GBP location | Connect/identify exact BHG accounts in Zernio, bind in CRM, verify, enable after review |
| Search Console | `sc-domain:bhgsafety.com` recorded | Check recent sync and measurement coverage |
| GA4 | No property recorded | Connect verified property for traffic/conversion reporting; does not block drafting |
| Existing blogs | Three published CRM records, seven repository blog files, and one legacy draft document | Reconcile repository coverage and check all existing articles for overlap |

Open content facts: conflicting 45+/65+ years; Outreach Trainer/DOL-card authorization on four OSHA courses; CPR/First Aid issuer and validity; course duration/class size/prerequisites. Exclude those unsupported claims until confirmed. Only Hannibal is an active location in the drafting records; broad service-area text does not authorize additional local claims. Use verified service facts for an initial pilot rather than waiting for every possible claim.

Scope is BHG Safety Partners / bhgsafety.com. The separate BHG forklift and heavy-equipment brands/sites are not automatically included or bound to this destination.

## Repeatable activation for remaining clients

Audit agreement and content allowance, brand/facts/evidence, keyword intent and unique owner pages, usable assets, website adapter, exact social destinations, reviewer, schedule/timezone, and measurement connections. Prove one article plus one Facebook and GBP draft for each client before expanding cadence. Begin blogs with human review, then move only that client's blogs to explicitly enabled automatic mode. Other channels retain their existing approval policy.
