# Brand workspaces

A client can have several customer-facing brands under its existing agreement. Each service belongs to one brand; its governed keywords determine the content brand. A profile owns writing guidance, evidence and image assignments, review status, Facebook Page and blog site. GBP stays on the existing client calendar and account. No billing records or allowances are created.

The Brand tab switches to profile tabs when `client_brand_workspaces` contains rows. The Planner identifies each item's brand from its service. Saving profile changes increments the version and clears its human approval. Blog/social briefs bind to that version. Approval and publication checks reject stale or cross-brand content and wrong destinations. Existing clients without profiles keep their original Intelligence input.

The creative engine also resolves name, phone, website, CTA, claims and source assets through the service's brand. Existing source governance and human post review still apply. Templates remain separately reviewed at the client level.

## Release sequence

1. Push branch `codex/bhg-brand-workspaces` to the existing CRM repository and open a PR. Tom explicitly approved publication to the existing repository on October 12 after its public visibility was disclosed. PR #122 passed native database, application, billing and browser checks and merged as `83c6454`.
2. Pass the existing Validate CRM workflow, including the native PostgreSQL role/migration replay and blog browser suite. Run `scripts/test-portal-sandbox.sh` with the new `brand_workspaces.test.sql` suite.
3. Apply `20261012163631_brand_workspaces.sql` before deploying code that queries the new table. No profile rows are inserted by the migration, so existing client behavior remains active during rollout.
4. Deploy the app and `post-drafter`, `content-drafter`, `blog-publisher`, `site-push`, and `creative-engine` from the tested commit. Retain existing authentication settings. Verify the versions and inspect a legacy-client brief before activation.
5. Create the three BHG profiles as drafts using the confirmed configuration recorded in the CRM guidance. All share the confirmed phone. All Facebook assignments stay empty until the separate Pages are connected. Keep the existing GBP account; do not duplicate it.
6. Assign Safety services, evidence, source assets and the existing Safety website to Safety. The existing Forklift service currently points at the Safety website: resolve its brand-specific owner page and keyword targets before using it for Forklift content. Heavy Equipment needs its own governed services, keyword mappings, evidence, assets and publishing destination. Do not invent mappings, import Safety claims to the other brands, or approve them on the user's behalf.
7. Review each brand, regenerate draft content against that version, then have the user approve the first articles/posts. Autopost remains disabled. Verify destinations in CRM before publishing.

## Local verification

- Production Next.js build, TypeScript and ESLint passed.
- Focused drafting, publisher and site routing tests pass.
- `node scripts/test-brand-workspaces-pglite.mjs` replays every migration and passes 18 brand checks, including human review, keyword/evidence isolation, destination selection and portal RLS. This supplemental runner retains PGlite's initial postgres superuser and is not a substitute for the native PostgreSQL CI gate.
- The broad unit run had a version expectation fixed for the new handler version. Its existing social review PGlite process exited after 36 passing tests without an assertion failure. The final two tests both pass when run separately. Full CI still required.

Production update on October 12: migration applied, app deployed, all five Edge Functions updated. Three BHG profiles are active as drafts. Safety has its existing services, evidence, assets and blog site; Forklift has its existing service and 12 keywords with owner-page correction still needed; Heavy Equipment has a proposed service awaiting its keyword/evidence setup. All share the confirmed phone. Facebook and shared GBP connections remain pending. No brand/post approvals or public posts were made.
