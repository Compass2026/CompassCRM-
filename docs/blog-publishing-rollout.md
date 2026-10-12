# Blog publishing rollout and BHG activation

Status: integration branch, not deployed. Reviewed October 12, 2026 UTC (October 11 Central).

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

The existing `claude/blog-drafter` branch at `13392c5` contains the weekly planner, article editor, governed drafter, approval and Markdown export. Its migrations 0065 content planner, 0066 content status, 0067 drafts and 0068 weekly completion are absent from production.

Integrated that branch with production main `8740e378f462c722f4baf067f4f185b82121133a`, preserving the current social, billing and CRM Lite code. Resolved merge conflicts in the shared brief and test harness. The blog brief now reuses the current keyword foundation, derives missing intent/service from the selected keyword, uses live keyword text, and refuses inactive/foreign keywords, intent contradictions, unapproved pages and competing keyword owners. Regression coverage includes these failure cases.

## Engineering gates before production

1. Harden and verify the draft write boundary. In the recovered 0067 guard, `compass.content_draft_system` is treated as authorization on its own. Bind it to the trusted caller, reject unauthorized metadata-only changes, and cover worker attempts with and without forged flags. Guard UPDATE of claim relations as well as INSERT/DELETE, and serialize claim changes with draft approval.
2. Freeze the complete approval artifact. The recovered snapshot has a body hash but no body, and does not bind all keyword/service/owner/destination inputs. Publishing must read an immutable released artifact and recheck claims and human approval or the explicitly enabled automatic-release policy immediately before the write. Retargeting or editing invalidates the release. Preserve human review and automatic policy-release history separately.
3. Complete the website publisher. Existing `site-push` supports recorded adapters (`lucas_json`, BHG `markdown_blog`) but has no draft-aware approval-to-publish operation. Add per-client destination readiness, exact approved-content conversion, collision handling, duplicate-safe retries, pinned repository/branch/path, deployment confirmation and live-page verification before recording published. Protect against unrelated edits when a JSON blog file is updated. Unsupported adapters retain export/manual delivery.
4. Add publication and scheduling controls to the draft review page and per-client review/automatic blog modes as specified above. Publish is separate from human approval or policy release. Record queued, publishing, published and blocked/uncertain outcomes honestly; include the verified URL in the existing production and reporting read models. Do not count draft attempts as delivered.
5. Preserve keyword-first readiness in the planner and weekly worker. A topic alone must not be shown as draftable when the drafter requires a governed keyword. Align the weekly task generator with two weekly blog slots and the existing monthly allocation, without duplicating open work or exceeding the agreement. The current legacy generator opens one task per week.
6. Run the full migration/role and UI workflows, then apply reviewed migrations, regenerate database types, deploy content-drafter and the publisher, and test a pilot draft without approving or publishing client content on the team's behalf.

No production migrations, enablement, approvals, scheduling or publication were performed during this integration. The recovered branch's old deployment instructions do not mean these gates have passed.

## BHG Safety Partners: observed readiness

Client `3eaa3389-2a33-4004-837c-8aef90404410`, website `https://bhgsafety.com/`.

| Area | Live record | Remaining action |
| --- | --- | --- |
| Agreement | 8 blogs, 8 GBP posts, 8 social posts, 4 new pages, 1 refresh per month | Reuse existing allowance; do not create another agreement |
| Website | Compass-controlled, `Compass2026/BHGSafetyPartners`, main, `markdown_blog`, `content/blog`, Vercel `bhg-safety-partners` | Validate current repository format and approved-article publisher |
| Keywords | 94 active; 37 have service, intent and target URL populated | Audit eligible clusters; fix mappings from verified pages; do not invent intent/ownership |
| Page groups | 22 | Reconcile with services and live pages |
| Brand | Version 1, status draft; Canva folder recorded | Team reviews and approves the actual board |
| Service pages | 16 approved services; 10 have no page URL | Verify and map training and industrial-hygiene destinations |
| Facebook/GBP | No social_accounts rows; no CRM GBP location | Connect/identify exact BHG accounts in Zernio, bind in CRM, verify, enable after review |
| Search Console | `sc-domain:bhgsafety.com` recorded | Check recent sync and measurement coverage |
| GA4 | No property recorded | Connect verified property for traffic/conversion reporting; does not block drafting |
| Existing blogs | Three published records and one legacy draft document | Check overlap before commissioning more articles |

Open content facts: conflicting 45+/65+ years; Outreach Trainer/DOL-card authorization on four OSHA courses; CPR/First Aid issuer and validity; course duration/class size/prerequisites. Exclude those unsupported claims until confirmed. Only Hannibal is an active location in the drafting records; broad service-area text does not authorize additional local claims. Use verified service facts for an initial pilot rather than waiting for every possible claim.

Scope is BHG Safety Partners / bhgsafety.com. The separate BHG forklift and heavy-equipment brands/sites are not automatically included or bound to this destination.

## Repeatable activation for remaining clients

Audit agreement and content allowance, brand/facts/evidence, keyword intent and unique owner pages, usable assets, website adapter, exact social destinations, reviewer, schedule/timezone, and measurement connections. Prove one article plus one Facebook and GBP draft for each client before expanding cadence. Begin blogs with human review, then move only that client's blogs to explicitly enabled automatic mode. Other channels retain their existing approval policy.
