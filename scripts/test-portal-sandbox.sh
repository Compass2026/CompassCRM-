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
for f in "${MIGRATIONS[@]}" ${LATE[@]+"${LATE[@]}"}; do
  sed -E 's/^create extension if not exists pg_(cron|net);/-- sandbox: pg_\1 stubbed/' "$f" \
    | psql_as postgres -d sandbox --single-transaction -v VERBOSITY=terse -o /dev/null 2>"$WORK/err" \
    || { echo "FAILED applying $(basename "$f")"; cat "$WORK/err"; exit 1; }
  # A migration must not manage its own transaction: apply_migration wraps it
  # together with its version record, and an inner COMMIT would split them.
  if grep -q "transaction in progress" "$WORK/err"; then
    echo "FAILED $(basename "$f"): it opens or commits its own transaction"; cat "$WORK/err"; exit 1
  fi
  echo "applied $(basename "$f")"
done

psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/fixtures.sql" -o /dev/null
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/portal_access.test.sql"
# 0043: task assignment, history, comments (same replay, own harness schema).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/task_assignment.test.sql"
# 0041: scorecard ledger (same replay, own harness schema).
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/report_measurements.test.sql"
# 0045: post record and human review gate. Switches between the worker
# (postgres) and PostgREST's authenticator login inside the file.
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/social_post_review.test.sql"
