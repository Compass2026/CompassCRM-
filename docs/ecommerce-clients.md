# E-commerce clients

Online-only stores use `clients.business_type = ecommerce`. The existing
`service_area` field describes their shipping market. Phone, website, brand,
claims, keyword ownership, approval and publishing gates still apply. A city
and street address are not required for an online store's drafting readiness.
A mailing address is not evidence of a storefront or local service coverage.

Facebook drafts still name the client's Page. Blog briefs reuse the common
fact checks without requiring a Google Business Profile. A Google post for an
online store requires a separately verified location binding; selecting the
business type alone never establishes GBP eligibility.

The current rank tracker measures local searches. Until national rank locations
are implemented, it skips e-commerce clients in both post and collect modes
and reports the reason. It does not submit paid city checks, create a home
location, or record local results as national evidence. Core 50 tracked flags
are retained; those flags are not measured rankings.

## Deployment

Apply `20261031145435_ecommerce_business_type.sql` before the app is deployed.
Deploy `authority-run`, `post-drafter`, `content-drafter`, `content-approvals`,
`blog-publisher` (shared brief checks) and `rank-sync` from the merged commit.
Then classify the intended online-store client and refresh its Authority run.
No schema policies, publishing permissions, entitlements or content approvals
change in this release.

Validation: `tests/ecommerce-business.test.mjs` checks market readiness,
Facebook/blog drafts, GBP location binding, retained brand gates, local rank
exclusion, and an idempotent PostgreSQL enum migration with existing values.
