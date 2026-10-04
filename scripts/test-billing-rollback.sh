#!/usr/bin/env bash
# Tests the billing rollback (supabase/rollback/billing_0058_0062_down.sql) in a
# throwaway local Postgres cluster shaped like the Supabase project:
#
#   1. replay every migration before the billing set (the production baseline:
#      0001 – 0057), load the portal fixtures, snapshot the schema and cron
#   2. apply the billing migrations 0058 – 0062, seed billing data (a package,
#      agreements, an override, mirror rows, the billing mode, the daily
#      reconciliation schedule), take the pre-rollback backup
#   3. run the rollback, snapshot again, and require the schema and cron to be
#      identical to step 1
#   4. run the pre-billing portal access suite (from main) against the result
#   5. re-apply 0058 – 0062 (roll forward after a fix)
#
#   scripts/test-billing-rollback.sh            # needs PostgreSQL 15+ server binaries
#   KEEP=dir scripts/test-billing-rollback.sh   # keep the snapshots and backup
#
# Nothing here touches the remote project.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PG_BIN/initdb" ] || { echo "PostgreSQL server binaries not found; set PG_BIN" >&2; exit 2; }
if [ "$(uname)" = Darwin ]; then export LC_ALL="${LC_ALL:-en_US.UTF-8}"; fi

WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = 0 ]; then
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
${RUN_AS[@]+"${RUN_AS[@]}"} "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-c listen_addresses='' -k $WORK -p 54330" -l "$WORK/log" -w start >/dev/null

psql_as() { local role="$1"; shift; "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p 54330 -U "$role" "$@"; }
snapshot() { # name
  "$PG_BIN/pg_dump" -h "$WORK" -p 54330 -U supabase_admin -d sandbox --schema-only \
    -n public -n cron | sed -E '/^\\(un)?restrict /d' > "$WORK/$1.schema.sql"   # pg_dump's per-run token
  psql_as supabase_admin -d sandbox -At -c "select jobname || ' | ' || schedule || ' | ' || command from cron.job order by jobname" > "$WORK/$1.cron.txt"
  psql_as supabase_admin -d sandbox -At -c "select key from app_settings where key like 'billing%' order by key" > "$WORK/$1.settings.txt"
}

psql_as supabase_admin -d postgres -c "create database sandbox"
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/bootstrap.sql" >/dev/null

HOOKS="$ROOT/supabase/tests/sandbox/replay"
apply() { # file
  local f="$1" num; num="$(basename "$f")"; num="${num%%_*}"
  [ -f "$HOOKS/$num.before.sql" ] && psql_as postgres -d sandbox -f "$HOOKS/$num.before.sql" -o /dev/null
  sed -E 's/^create extension if not exists pg_(cron|net);/-- sandbox: pg_\1 stubbed/' "$f" \
    | psql_as postgres -d sandbox --single-transaction -v VERBOSITY=terse -o /dev/null 2>"$WORK/err" \
    || { echo "FAILED applying $(basename "$f")"; cat "$WORK/err"; exit 1; }
  [ -f "$HOOKS/$num.after.sql" ] && psql_as postgres -d sandbox -f "$HOOKS/$num.after.sql" -o /dev/null
  return 0
}

BILLING=(0058 0059 0060 0061 0062)
is_billing() { local b n; n="$(basename "$1")"; for b in "${BILLING[@]}"; do case "$n" in "$b"_*) return 0 ;; esac; done; return 1; }

# 1. Baseline: everything but billing.
for f in "$ROOT"/supabase/migrations/*.sql; do is_billing "$f" || apply "$f"; done
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/fixtures.sql" -o /dev/null
snapshot before
echo "baseline: $(grep -c '^CREATE TABLE' "$WORK/before.schema.sql") tables, $(wc -l < "$WORK/before.cron.txt") cron jobs"
if [ -n "${BASELINE_ONLY:-}" ]; then
  mkdir -p "$BASELINE_ONLY"; cp "$WORK"/before.* "$BASELINE_ONLY"/
  "$PG_BIN/pg_dump" -h "$WORK" -p 54330 -U supabase_admin -d sandbox --schema-only \
    -t public.stripe_customers -t public.subscriptions -t public.payments -t public.stripe_events -t public.plans \
    > "$BASELINE_ONLY/old_tables.sql"
  exit 0
fi

# 2. Billing, with data in it.
for f in "$ROOT"/supabase/migrations/*.sql; do is_billing "$f" && apply "$f"; done
echo "applied ${BILLING[*]}"
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/billing_rollback_seed.sql" -o /dev/null
psql_as postgres -d sandbox -f "$ROOT/supabase/rollback/billing_0058_0062_backup.sql" -o "$WORK/backup.txt"
echo "backup: $(wc -l < "$WORK/backup.txt") lines"

# 3. Roll back.
psql_as postgres -d sandbox --single-transaction -f "$ROOT/supabase/rollback/billing_0058_0062_down.sql" -o /dev/null
snapshot after
fail=0
for part in schema.sql cron.txt settings.txt; do
  if diff -u "$WORK/before.$part" "$WORK/after.$part" > "$WORK/diff.$part"; then
    echo "rollback restores the baseline $part exactly"
  else
    echo "ROLLBACK DIFFERS ($part):"; head -80 "$WORK/diff.$part"; fail=1
  fi
done
if [ -n "${KEEP:-}" ]; then mkdir -p "$KEEP"; cp "$WORK"/*.sql "$WORK"/*.txt "$KEEP"/ 2>/dev/null || true; fi
[ "$fail" = 0 ] || exit 1

# 4. The pre-billing portal access suite (main's), on the rolled-back database.
if git -C "$ROOT" cat-file -e "origin/main:supabase/tests/sandbox/portal_access.test.sql" 2>/dev/null; then
  git -C "$ROOT" show "origin/main:supabase/tests/sandbox/portal_access.test.sql" > "$WORK/portal_access.main.sql"
  psql_as postgres -d sandbox -f "$WORK/portal_access.main.sql"
else
  echo "(origin/main not available; skipped main's portal access suite)"
fi
# 5. Roll forward again: the billing migrations re-apply cleanly on the
#    rolled-back database (the retry after a fixed problem).
for f in "$ROOT"/supabase/migrations/*.sql; do is_billing "$f" && apply "$f"; done
echo "re-applied ${BILLING[*]} after the rollback"
echo "Billing rollback test passed."
