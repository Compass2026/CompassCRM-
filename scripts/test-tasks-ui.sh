#!/usr/bin/env bash
# Browser check for the tasks slice (0043) against a real database: the same
# throwaway Postgres replay as test-portal-sandbox.sh, PostgREST in front of
# it, a stub for Supabase Auth's /user endpoint, `next dev`, and Chrome.
# RLS, the 0043 triggers and the server actions all run for real; nothing
# touches the Supabase project.
#
#   scripts/test-tasks-ui.sh        # needs PostgreSQL 15+, postgrest, Google Chrome
#   SCREENSHOTS=docs/screenshots/agency-tasks scripts/test-tasks-ui.sh
#
# The same harness runs the posts review check (0045):
#   UI_SPEC=tests/posts-ui.mjs UI_FIXTURES=posts_ui_fixtures.sql scripts/test-tasks-ui.sh
# (npm run test:posts-ui). CHROME_PATH picks a Chromium binary instead of Chrome.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PG_BIN/initdb" ] || { echo "PostgreSQL server binaries not found; set PG_BIN" >&2; exit 2; }
command -v postgrest >/dev/null || { echo "postgrest not found on PATH" >&2; exit 2; }
if [ "$(uname)" = Darwin ]; then export LC_ALL="${LC_ALL:-en_US.UTF-8}"; fi

WORK="$(mktemp -d)"
PGRST_PID=""
RUN_AS=()
if [ "$(id -u)" = 0 ]; then
  # initdb refuses to run as root (same as test-portal-sandbox.sh).
  id -u pgsandbox >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin pgsandbox
  chown pgsandbox "$WORK"
  RUN_AS=(runuser -u pgsandbox --)
fi
cleanup() {
  [ -n "$PGRST_PID" ] && kill "$PGRST_PID" 2>/dev/null || true
  ${RUN_AS[@]+"${RUN_AS[@]}"} "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

${RUN_AS[@]+"${RUN_AS[@]}"} "$PG_BIN/initdb" -D "$WORK/data" -U supabase_admin --auth=trust >/dev/null
${RUN_AS[@]+"${RUN_AS[@]}"} "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-c listen_addresses='' -k $WORK -p 54329" -l "$WORK/log" -w start >/dev/null
psql_as() { local role="$1"; shift; "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p 54329 -U "$role" "$@"; }

psql_as supabase_admin -d postgres -c "create database sandbox"
psql_as supabase_admin -d sandbox -f "$ROOT/supabase/tests/sandbox/bootstrap.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  sed -E 's/^create extension if not exists pg_(cron|net);/-- sandbox: pg_\1 stubbed/' "$f" \
    | psql_as postgres -d sandbox --single-transaction -v VERBOSITY=terse -o /dev/null 2>"$WORK/err" \
    || { echo "FAILED applying $(basename "$f")"; cat "$WORK/err"; exit 1; }
done
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/fixtures.sql" -o /dev/null
psql_as postgres -d sandbox -f "$ROOT/supabase/tests/sandbox/${UI_FIXTURES:-tasks_ui_fixtures.sql}" -o /dev/null
# PostgREST connects as authenticator and switches to the JWT's role.
# (the bootstrap creates it, as production has it)

JWT_SECRET="$(openssl rand -hex 32)"
PGRST_PORT="${PGRST_PORT:-54330}"
cat > "$WORK/postgrest.conf" <<CONF
db-uri = "postgres://authenticator@/sandbox?host=$WORK&port=54329"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$JWT_SECRET"
server-host = "127.0.0.1"
server-port = $PGRST_PORT
CONF
postgrest "$WORK/postgrest.conf" >"$WORK/postgrest.log" 2>&1 &
PGRST_PID=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PGRST_PORT/" >/dev/null && break; sleep 0.2; done

cd "$ROOT"
JWT_SECRET="$JWT_SECRET" PGRST_URL="http://127.0.0.1:$PGRST_PORT" \
  PSQL="$PG_BIN/psql -X -q -t -A -h $WORK -p 54329 -U postgres -d sandbox" \
  PSQL_ADMIN="$PG_BIN/psql -X -q -t -A -h $WORK -p 54329 -U supabase_admin -d sandbox" \
  node --no-warnings "${UI_SPEC:-tests/tasks-ui.mjs}"
