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

WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = 0 ]; then
  # initdb refuses to run as root.
  id -u pgsandbox >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin pgsandbox
  chown pgsandbox "$WORK"
  RUN_AS=(runuser -u pgsandbox --)
fi
cleanup() {
  "${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"${RUN_AS[@]}" "$PG_BIN/initdb" -D "$WORK/data" -U supabase_admin --auth=trust >/dev/null
"${RUN_AS[@]}" "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-c listen_addresses='' -k $WORK -p 54329" -l "$WORK/log" -w start >/dev/null

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
for f in "$ROOT"/supabase/migrations/*.sql; do
  sed -E 's/^create extension if not exists pg_(cron|net);/-- sandbox: pg_\1 stubbed/' "$f" \
    | psql_as postgres -d sandbox --single-transaction -v VERBOSITY=terse -o /dev/null 2>"$WORK/err" \
    || { echo "FAILED applying $(basename "$f")"; cat "$WORK/err"; exit 1; }
  echo "applied $(basename "$f")"
done

psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/fixtures.sql" -o /dev/null
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/portal_access.test.sql"
