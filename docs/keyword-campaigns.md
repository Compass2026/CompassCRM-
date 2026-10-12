# Keyword campaigns

Authority v1.4 records a versioned campaign package in each `authority_runs.report.campaigns` snapshot. The Authority page renders it alongside the existing opportunity queue. No separate editable campaign table is introduced: approved services, keywords and page groups remain authoritative, and the immutable run identifies the observation date. Older reports without packages continue to render.

Each service package exposes its governed primary keyword, eligible supporting cluster, intent mix, single owner URL, objective, relevant evidence IDs, exclusions, channel plans and measurements. Missing primary keywords and conflicting owners block the foundation. Duplicated keyword rows with equivalent text cannot conceal competing owner pages. Keywords excluded by intent, location, risk or ownership rules are shown separately. Plans cover website, blog, Business Profile, Facebook, email and paid ads. Channels without applicable opportunities or recorded assets say “Not planned”. A plan never creates or publishes content, authorizes spend, or grants email consent.

The direct Drafter now derives omitted intent and service from the selected keyword. Explicit conflicts refuse. It also applies Authority's conservative intent sanity check, refuses multiple declared owner URLs for equivalent keyword text, and refuses a keyword mapped to a different service even when that service claims it as primary. Standard search content still requires a keyword; explicit `campaignMode=non_search` remains the intentional brand/community exception. No exact-keyword stuffing: the one-use maximum remains unchanged.

New owner-page opportunities require a validated primary keyword and unambiguous ownership before they can be marked create. Existing website wording fixes, research and reconciliation findings can still appear without a generation-ready keyword. They are repair/research work, not authorization to generate a competing page.

## Ranking and measurement

Campaign sorting uses P1, P2, P3, governed primary role, money status, tracking, descending volume, descending CPC, then ascending known competition. Existing opportunity ranking additionally weighs readiness, evidence, gap severity, cadence and observed Search Console demand. No seasonality is inferred without governed evidence.

Campaign demand sums only cluster-matched rows from the latest Search Console window. Overlapping historical windows are not added. Coverage is labelled complete, partial or unknown; missing observations remain unknown. Latest rank observations are retained per keyword and result type. Traffic and conversion attribution are explicitly unconnected, never fabricated as zero. Content counts include recorded drafts and published records and do not mean publication.

## Delivery boundary

The shared campaign package is available across channel planning. Automated governed drafting currently supports Business Profile and Facebook. Blog/page opportunities retain their research and website workflow gates; email and ads require their own audience, economics and channel brief decisions. This release does not claim new email/ad/blog generation adapters or connected conversion attribution.

All normal Client Intelligence, evidence, brand, creative review and human approval gates remain. Existing published history is untouched. No migration, policy change, new security-definer function or privileged UI query is required.

## Lucas Holiday Lighting pilot audit, October 12, 2026

The ten existing Facebook posts target the Holiday Lighting Installation service and `/christmas-lights`, with commercial or transactional keywords. The live brief and check endpoints accepted all ten after correction, with no blocking lint problems. Advisory warnings about paraphrased claims and first-line service wording remain visible for editorial review.

Posts 03, 07 and 10 had an unrelated general roofing claim. It was unlinked and their captions corrected to the sourced lighting service claim. Graphics 03 and 10 replaced comparative safety language; graphic 08 replaced “TRUSTED” with “HOLIDAY LIGHTING”. The three replacement files were registered through `source-assets`, with measured SHA-256 hashes and AI illustration provenance. Original asset records and bytes remain intact.

Edits used ordinary draft withdrawal, frozen-link enforcement, claim/asset relinking and resubmission with every trigger enabled. All ten remain `in_review` / `not_scheduled`. No approval, scheduling, publishing, duplicate post or posts 11–20 were created. Creative-use review remains human work; illustrative houses are not evidence of completed client projects.

Deployment drift was also found: `authority-run` carried an old copy of the shared Facebook linter. The guarded GitHub deployment workflow restored the exact main source before this final release.
