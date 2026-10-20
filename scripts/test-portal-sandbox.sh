#!/usr/bin/env bash
# Replays every migration into a throwaway local Postgres cluster shaped like
# the Supabase project, then runs the team / anon / portal access tests.
#
#   scripts/test-portal-sandbox.sh            # needs PostgreSQL 15+ server binaries
#   PG_BIN=/usr/lib/postgresql/16/bin scripts/test-portal-sandbox.sh
#
# Nothing here touches the remote project: the cluster lives in a temp dir,
# listens only on a Unix socket there, and is deleted on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PG_BIN/initdb" ] || { echo "PostgreSQL server binaries not found; set PG_BIN" >&2; exit 2; }

# Homebrew's postgres refuses to start without a valid locale on macOS.
if [ "$(uname)" = Darwin ]; then export LC_ALL="${LC_ALL:-en_US.UTF-8}"; fi

WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = 0 ]; then
  # initdb refuses to run as root.
  id -u pgsandbox >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin pgsandbox
  chown pgsandbox "$WORK"
  RUN_AS=(runuser -u pgsandbox --)
fi
cleanup() {
  ${RUN_AS[@]+"${RUN_AS[@]}"} "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

${RUN_AS[@]+"${RUN_AS[@]}"} "$PG_BIN/initdb" -D "$WORK/data" -U supabase_admin --auth=trust >/dev/null
${RUN_AS[@]+"${RUN_AS[@]}"} "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-c listen_addresses='' -k $WORK -p 54329" -l "$WORK/log" -w start >/dev/null

psql_as() { # role, then psql args
  local role="$1"; shift
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p 54329 -U "$role" "$@"
}

psql_as supabase_admin -d postgres -c "create database sandbox"
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/bootstrap.sql"

# Migrations run as postgres, one transaction each, as they do on the
# project (0025 relies on it: its temp table is ON COMMIT DROP). pg_cron and pg_net
# are stubbed by the bootstrap, so their CREATE EXTENSION lines are skipped;
# every other statement runs unchanged.
# APPLY_LAST="0041" replays the named migrations after all the others, the
# order production sees when a migration was held back for review (0041 is
# applied after 0043). Default: plain file order.
MIGRATIONS=()
LATE=()
for f in "$ROOT"/supabase/migrations/*.sql; do
  late=""
  for p in ${APPLY_LAST:-}; do case "$(basename "$f")" in "$p"_*) late=1 ;; esac; done
  if [ -n "$late" ]; then LATE+=("$f"); else MIGRATIONS+=("$f"); fi
done
[ -n "${APPLY_LAST:-}" ] && echo "replay order: file order, then ${APPLY_LAST} last"
# supabase/tests/sandbox/replay/<number>.before.sql / .after.sql run as
# postgres around that migration (0056: production-shaped clients so its
# backfill runs, then snapshotted and removed before the suites).
HOOKS="$ROOT/supabase/tests/sandbox/replay"
for f in "${MIGRATIONS[@]}" ${LATE[@]+"${LATE[@]}"}; do
  num="$(basename "$f")"; num="${num%%_*}"
  if [ -f "$HOOKS/$num.before.sql" ]; then
    psql_as postgres -d sandbox -f "$HOOKS/$num.before.sql" -o /dev/null
  fi
  sed -E 's/^create extension if not exists pg_(cron|net);/-- sandbox: pg_\1 stubbed/' "$f" \
    | psql_as postgres -d sandbox --single-transaction -v VERBOSITY=terse -o /dev/null 2>"$WORK/err" \
    || { echo "FAILED applying $(basename "$f")"; cat "$WORK/err"; exit 1; }
  # A migration must not manage its own transaction: apply_migration wraps it
  # together with its version record, and an inner COMMIT would split them.
  if grep -q "transaction in progress" "$WORK/err"; then
    echo "FAILED $(basename "$f"): it opens or commits its own transaction"; cat "$WORK/err"; exit 1
  fi
  echo "applied $(basename "$f")"
  if [ -f "$HOOKS/$num.after.sql" ]; then
    psql_as postgres -d sandbox -f "$HOOKS/$num.after.sql" -o /dev/null
  fi
done

psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/fixtures.sql" -o /dev/null
# Billing rows for the portal clients while the generic portal checks run
# (0062's views are portal views too), removed straight after.
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/portal_billing_fixtures.sql" -o /dev/null
# CRM Lite inquiries for the same generic checks (its four portal views).
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/crm_lite_portal_fixtures.sql" -o /dev/null
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/client_growth_portal_fixtures.sql" -o /dev/null
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/portal_access.test.sql"
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/client_growth_portal_teardown.sql" -o /dev/null
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/crm_lite_portal_teardown.sql" -o /dev/null
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/portal_billing_teardown.sql" -o /dev/null
# 0043: task assignment, history, comments (same replay, own harness schema).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/task_assignment.test.sql"
# 0041: scorecard ledger (same replay, own harness schema).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/report_measurements.test.sql"
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/client_growth.test.sql"
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/growth_rankings.test.sql"
# This suite explicitly switches session identity to test PostgREST and worker boundaries.
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/gbp_performance.test.sql"
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/dashboard_reporting.test.sql"
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/ga4_performance.test.sql"
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/reporting_connections.test.sql"
# 0045: post record and human review gate. Switches between the worker
# (postgres) and PostgREST's authenticator login inside the file.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/social_post_review.test.sql"
# 0046: Business Profile publisher schema (runs, outcomes, reminder cycles).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/publisher_runs.test.sql"
# 0047: AI Drafter write boundary and the Client Intelligence loader. Switches
# between the worker (postgres), the post-drafter function (authenticator +
# service_role) and a person (authenticator + authenticated).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/drafter.test.sql"
# 0048: Authority runs, opportunities, history and links. Switches between the
# worker (postgres), the authority-run function (authenticator + service_role),
# a person, a portal contact, a stranger and anon.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/authority.test.sql"
# Authority lifecycle actions (accept / release / dismiss 30-60-90 / never
# recommend / reopen) through authority_decide, on a client of its own.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/authority_lifecycle.test.sql"
# 0049: authority_apply (decisions with their canonical change, atomically).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/authority_apply.test.sql"
# 0050: Authority CRM reconciliation (set_service_page, rehome_keywords,
# record_content, map_keywords), content_posts.origin and the portal work
# log's Compass-only filter. The normPath vectors are shared with
# tests/authority-norm-path.test.mjs.
psql_as postgres -d sandbox -v vectors="$(cat "$ROOT/tests/fixtures/authority-norm-path-vectors.json")" \
  -f "$ROOT/supabase/tests/sandbox/authority_reconcile.test.sql"
# 0051: a Home re-home removes the keyword from every service / hub page
# group's supporting list in the same transaction (all or nothing).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/authority_home_cleanup.test.sql"
# 0052: every reconciliation write is bound to its preview (target / destination
# URLs, a Home re-home's page groups); map_keywords refuses location_unapproved.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/authority_bind_preview.test.sql"
# 0053: Authority → AI Drafter hand-off (request_draft, retry-safe starts,
# drafter_write's Authority refusals, the linked post's lifecycle, recurring cycles).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/authority_drafter_handoff.test.sql"
# 0054: Creative Engine (source governance, templates and client approvals,
# runs, immutable content-addressed assets and sources, creative links,
# approval binding, request new creative, manual uploads, the creative bucket).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/creative_engine.test.sql"
# 0055: source-asset hashing provenance (only the source-assets function
# records a hash; file changes clear it) and the stricter creative-use review.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/source_asset_hashing.test.sql"
# 0056: Canva folder ids on the client record (the backfill as the replay hook
# saw it, formats, no shared folders between live clients, the read model,
# nothing else reads them).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/client_canva_folders.test.sql"
# 0057: overlay roles (phone, website, service segment, template label; claims
# in previews; up to 12 lines), and the renderer's spec hash equals
# creative_spec_hash for every Lucas template (the fixture is passed in).
psql_as postgres -d sandbox -v specs="$(cat "$ROOT/tests/fixtures/creative-lucas-templates.json")" \
  -f "$ROOT/supabase/tests/sandbox/creative_overlay_roles.test.sql"
# 0058: billing foundation (Stripe mirror is team read-only and service-role
# written, client / customer / subscription / invoice belong together, the
# catalog's package ↔ price rules, entitlements and overrides, the derived
# billing status in test and live mode, portal / stranger / anon see nothing).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/billing_foundation.test.sql"
# 0059: the Stripe sync write boundary (only the sync functions, called by an
# authenticator + service_role session, write the mirror; the worker's SQL,
# teammates, portal contacts and anon cannot), the sync ops (ownership from
# the customer link, stale reads, item / line replacement, refunds, test/live)
# and the webhook ledger (claim, lease, fail, retry, finish).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/billing_sync.test.sql"
# 0060: billing operations (Checkout records, admin-only external payments with
# idempotency and void corrections, the append-only billing audit trail; only
# the stripe-billing function's session can call them).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/billing_operations.test.sql"
# 0061: billing reconciliation (run history and per-client results written
# only by the stripe-reconcile function's session, one running run per mode,
# abandoned runs closed, fingerprints that ignore bookkeeping, the health and
# last-reconciled read models, the unscheduled fire function).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/billing_reconciliation.test.sql"
# 0062: the entitlement contract (package + overrides, disabled / missing = 0,
# billing state never changes it), monthly quota accounting and planning
# within the agreement (fail safe, mid-month changes, nothing deleted, people
# may exceed it), agreement history, no Five Layer function reads billing,
# and billing in the client portal (own client only, client-safe fields,
# read-only, external arrangements, live / test mode).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/billing_entitlements_portal.test.sql"
# Security-definer hardening (production-readiness review): pinned
# search_path with pg_temp last (temp tables cannot shadow), no PUBLIC / anon
# execution, signed-in users reach only the self-scoping helpers, service-only
# functions re-check their session, the planners are not API-callable.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/billing_security_definer.test.sql"
# The agreement binds the client to its exact recurring price: the agreed
# terms, a binding only to the agreement's own package's matching, active,
# fixed, current-mode price, admin-only, the readiness read model, the
# agreement_price_* attention signals and the portal's plan price.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/billing_agreement_price.test.sql"
# The billing cutover kit (supabase/cutover): pause, the agreements template
# refuses to run, the fictional test client (paused, no automation), the
# validation refuses an active client with no agreement, resume.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/billing_cutover_kit.test.sql"
# 0063: Compass Communications (Twilio SMS): registry, inbound idempotency,
# consent and opt-out, outbound rules, forward-only delivery status,
# compliance registrations and checklist, tenancy, the worker kept out.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/communications.test.sql"
# 0065: per-subaccount Vault access (the long TWILIO_SUB_<sid>_* names through
# the Edge Functions' identity, case-variant and whitespace handling, who may
# read what) and Twilio's mixed-case SIDs through the registry and messages.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/communications_secrets.test.sql"
# CRM Lite (20261012002616): website inquiries saved once per submission under
# the source's own client, contact matching within the client only, status
# and notes by a teammate or the client's own portal contact, the portal
# views, the SMS gates (sender approval, complete consent, a confirmed
# delivery test, the admin switch), no old inquiries sent, no blind resend
# of an unknown outcome, STOP / START / HELP, the worker kept out.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/crm_lite.test.sql"
# 0064: the dedicated billing runtime login (billing_sync writes billing only
# through the billing functions, reads only billing tables and the columns it
# needs, cannot reach Vault or switch the mode; the Edge Function path closes
# when the owner flips billing_runtime, and service_role cannot reopen it).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/billing_runtime.test.sql"
# Social History SH1 (20261008015642): only the social-history function writes
# imported posts, snapshots and imports; the natural key, Compass-origin
# detection and snapshots-on-change; Compass posts never reach the learnable
# view; and history is never grounding (no evidence function reads it, an
# import changes no Client Intelligence / Authority input, claim or post).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/social_history.test.sql"
# Social History SH2 (20261008024508): style profiles are recorded only by the
# social-history function, approved or rejected only by a signed-in teammate
# against the hash they saw, one proposed and one approved at a time, never
# edited; examples come only from the client's learnable posts; nothing
# outside the family reads them and recording one changes no grounding.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/social_history_style.test.sql"
# Zernio Social Publisher v1 (20261010224407): only the publisher's service
# session binds a Facebook account to a Zernio account, against the row's own
# Page, and binding never enables; only a signed-in team admin enables,
# disables or unbinds; the worker's SQL can do none of it; the history is
# append-only; publisher_runs takes the Zernio fields; a brand image carries
# its hash onto a post.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/zernio_publisher.test.sql"
# AI Drafter Facebook drafts (20261011040705): only drafter_write writes one,
# on the client's own Facebook Page, no button, at most one stored and hashed
# photo or graphic, in review and never approved or scheduled by it; one open
# draft per concept; Business Profile drafts unchanged.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/drafter_facebook.test.sql"
# Business Profile through Zernio (20261011050000): only the publisher's
# service session records and binds a client's one Business Profile location
# (locations/<id>); binding never enables; a team admin enables; the approval
# binds the destination; publisher_runs records the pinned location.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/zernio_gbp.test.sql"
# 0065: the Content Planner (plan item shapes, Authority opportunity ↔ slot
# mapping, same-client links, one slot per post, the derived board status
# through the review gate, holds, team-only access).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/content_planner.test.sql"
# 0066 + 0067: content drafts (request / regenerate, the drafter-only write,
# grounding, version-pinned idempotent approval to ONE content_posts row,
# reopen / re-approve, reject, web pages with no final record yet, Billing
# sees one article, team-only access).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/content_drafts.test.sql"
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/blog_publication.test.sql"
# 20261019214729: one writer per website destination — the real ticks send
# one release per repository branch, claim and resume defer on a busy one.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/blog_publication_destination.test.sql"
# 20261015175146: binding claims — a fresh foreign claim blocks the drafter's
# write, an expired one does not, an unclaimed task writes as before.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/content_draft_claims.test.sql"
# 20261015175410: the same for Authority Draft with AI requests — a fresh
# foreign claim blocks drafter_write, an expired one does not, an unclaimed
# request writes as before.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/authority_draft_claims.test.sql"
# Multi-brand isolation, human approvals, shared GBP and per-brand website destinations.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/brand_workspaces.test.sql"
# New GBP drafts pin the existing client binding before human review.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/drafter_gbp_destination.test.sql"

# Agency review ledger: human actor, versions, stage gates and portal isolation.
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/agency_rollout.test.sql"
# 20261015210000: blog hero images — same-client stored assets only, a hero
# change bumps the version and clears approval, releases re-check the file.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/blog_hero.test.sql"
# 20261018230000: blog TL;DR (required under the rule, edited like content,
# pinned by approval, legacy drafts unchanged) and immutable draft history.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/blog_tldr.test.sql"

# 20261019190532: delegated approval and publication through Executive OS
# (receipts, scope binding, replay, refusals, publication states).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/content_delegation.test.sql"
# 20261019202359: every client, Facebook and Business Profile posts, the central policy.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/content_delegation_channels.test.sql"
# 20261020200000: delegated post edits (withdraw → replace media → resubmit
# under a receipt; identity bound to the executing transaction; never approves).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/content_edits.test.sql"

# Monthly delivery standard: per-brand targets, month boundaries, no double
# counting, the per-brand blog gate and its access boundary (rolled back).
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/delivery_standard.test.sql"
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/map_grid.test.sql"

# Map-tracking-only clients skip every onboarding trigger; full clients keep them.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/client_service_scope.test.sql"

# Market-centered map grids: labelled market centers only; legacy geometry still means business.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/map_grid_market_center.test.sql"

# 20261020200000: Citations Phase 1 — mapped imports that never duplicate,
# provider fulfillment kept apart from teammate verification, append-only
# dated evidence, the correction queue, admin-approved manual fulfillment
# with cash and prepaid credits apart, team-only access (rolled back).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/citations.test.sql"
