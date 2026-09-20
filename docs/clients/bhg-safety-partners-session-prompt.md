# Paste-in prompt for BHG's Claude project

```
Work on Compass2026/BHGSafetyPartners only (not BHG-Forklift-Training or BHG-Heavy-Equipment).
Baseline: branch main at 9c5766d5c3a0bcfc91fce9e90d5cd6a36e4b8b21. Reference standard: Compass Website
Foundation v1, Compass2026/showmeelectricalwebsite @ 94014af35316c94616dadb3f8d606a4b68577fb0, plus the
Build Standard v1.1, Page Template Library v1.1 and Foundation v1 Review Brief in Google Drive.

Read first: docs/clients/bhg-safety-partners-upgrade-brief.md in Compass2026/CompassCRM- (branch
claude/foundation-v1-crm-integration) — the version-pinned brief with the current state, what to preserve,
the applicable Foundation modules, the first batch and the missing information.

Do the first batch, in order, on ONE preview branch created from main named
compass/preview-YYYYMMDD-bhgsafetypartners (YYYYMMDD = today, digits only), and open ONE pull request against main:
1. truthful basics (llms.txt host, sitemap lastmod, keywords meta, default share image);
2. motion + accessibility safeguards (video poster/reduced motion, CTA pulse, keyboard nav/FAQ, skip link);
3. duplicate-safe inquiry (content-bound submission id, Resend idempotencyKey, explicit retry outcomes,
   same-origin, rate limit, focus after server error) with a mocked-provider test suite;
4. local pages under the city gate — prepare the decision table for the five keyword-map cities and the
   retirement plan for the templated pages, but do not delete pages until Tom confirms;
5. internal-link contract + route manifest;
6. mobile Lighthouse before/after on home, service, city, article, contact.

Rules: preserve BHG's identity, palette, fonts, hero, forms (fields, source labelling, recipients),
service URLs and integrations. Never use Show Me Electrical or Harbor Lane content. No fact that is not
sourced on bhgsafety.com or in the CRM claims table; unknowns stay unknown (see the brief's missing list —
do not state a years-of-experience number). Email delivery must be mocked in every check; send nothing.
Do not deploy to production, merge, change DNS, domains, GBP or the CRM. Report: commit SHA, preview URL,
PR link, each acceptance check as pass / fail / deferred (builder-reported), Lighthouse numbers, and what
still needs BHG or Tom.
```
