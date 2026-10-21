# Monthly client report (Phase 2)

Versioned monthly reports per client: freeze a month, review it, approve the
exact version for one destination and named recipients, record what was
delivered. Nothing in this feature sends email, messages a client, invites a
portal user or runs on a schedule.

## Workflow

| Step | Where | What happens |
| --- | --- | --- |
| Preview | `/clients/[id]/reports/monthly/preview` | Same calculation as Generate, computed now, never saved. |
| Generate | Monthly reports → Generate draft | Stored records → `buildMonthlyReport` → `monthly_report_save`: a new **draft version** with a frozen snapshot. |
| Edit | Review page | Possible causes, three next actions (action, reason, owner), a note. Figures never change. An edit of a report in review sends it back to draft. |
| Review | Submit for review | `in_review`. |
| Approve | Review page | `monthly_report_approve(content_hash, destination, recipients)` — the exact hash Tom saw, `email` or `portal`, recipients that are this client's own contacts / active portal users. A partial month is never approved; a month with missing sources needs an explicit incomplete approval. |
| Deliver | Review page | Tom sends it himself (email draft text provided, print → PDF), then records `sent`, `uncertain` or `failed`. One `sent` per version and destination; `uncertain` never counts as delivered. A portal-approved version appears in the portal only after it is recorded as published. |
| Correct | Generate again with a reason | New version linked to the one it replaces. The approved version stays approved (and stays what the client sees) until the correction is approved; then it is `superseded`. |

## Data contract

- **Month:** America/Chicago calendar month, half-open `[start, end)`, DST-aware (`monthly_report_bounds`, `monthOfPeriod`). While the month runs, data is `[start, cutoff]` and the version is a partial preview.
- **Organic rank:** website pages only (`organicState`); third-party pages excluded. Month-end rank = last check before the month end, no older than 14 days. Anchors: baseline run, end of previous month, end of this month (or cutoff). Comparisons use a like-for-like cohort and disclose exclusions.
- **Maps:** map pack (tracker) and grid scans separate; scans compared only when `scanComparability` passes; dates and geometry shown.
- **Traffic:** `report_measurements` only. Search Console and Business Profile: complete calendar months for the resolved property / location. Analytics: complete month, or month to date labelled with its end date; all channels; organic split shown as not available. Query sample labelled as a rolling window.
- **Inquiries:** counts by source, form and page path; no contact field is selected; no test classification exists, so every submission is counted (stated).
- **Work completed:** published Compass blog posts, published Facebook / Business Profile posts and page refreshes with a live receipt, dated in the month, by service segment; targets from `delivery_targets()` when the client has a recorded standard, else the reference standard v1 with an exception. Drafts, posts in review, approved-but-unpublished, failed and unverified changes are listed as not counted.
- **Snapshot:** client, period, cutoff, calculation version, completeness, exceptions, the client-facing `report`, and an internal `audit` (never exposed to the portal).

## Schema (`20261021220000_monthly_reports.sql`)

`monthly_reports` (one row per version; unit = client or brand site),
`monthly_report_deliveries` (append-only), `portal_monthly_reports` (owner
view filtered by `portal_client_id()`, no `audit`). Team reads by RLS; every
write through the `monthly_report_*` security-definer functions, which require
a signed-in teammate. A guard trigger holds for every caller: snapshots never
change, approved / superseded / discarded versions never change (except
approved → superseded), nothing is deleted, one open and one approved version
per unit and month.

## Not built in this slice

- Brand-site reports (BHG): schema supports units; generation refuses
  multi-brand clients until the per-brand split of keywords, Search Console,
  Analytics and the shared Business Profile is designed.
- Stored PDF artifacts: print → Save as PDF renders the frozen version; a
  byte-stable server PDF (pdf-lib, as agreements) is the next step.
- Scheduling: proposed cadence only — draft on the 5th (Chicago), review and
  delivery by the 10th; readiness check before generating; the request key
  and one-open-version index prevent duplicates; a month with exceptions
  goes to an exception list instead of a draft. No cron is created.
