#!/usr/bin/env bash
# The worker's verification recipe for a Compass Website Foundation build —
# one executable script so the playbook, a human and a test fixture all run
# the same commands in the same order.
#
#   bash scripts/foundation-verify.sh <site-dir> <brand> <production-host> [results.json] [port] [browser-paths]
#
# browser-paths: comma-separated representative routes for the browser
# suite — the brand's home, a service hub, a service detail, a city page and
# contact (default "/,/contact"); use the routes the brand actually
# publishes, as the foundation's own verify.sh does per brand.
#
# Runs, in order: install, the brand-specific typecheck, the build, the
# route manifest, the provider suite (its own in-process mock service), then
# ONE shared mock provider service is started FIRST and the SAME
# INQUIRY_MOCK_PROVIDER_URL is passed to the site (`next start`) and to the
# form suite; crawl; browser launcher check; the mocked form suite and the
# browser suite when a Chromium exists — otherwise both are recorded as
# `deferred`, never as passed. Nothing is ever delivered: delivery is mocked
# in every step.
#
# Writes results.json = {pass:[…], fail:[…], deferred:[{name, detail}], ok}
# and exits 1 when any check FAILS (a deferred check does not fail the run,
# and it does not count as acceptance either — the brief records it as
# deferred until someone with a browser runs it).
set -uo pipefail
SITE="${1:?site dir}"; BRAND="${2:?brand}"; HOST="${3:?production host}"; OUT="${4:-/tmp/foundation-verify.json}"; PORT="${5:-3450}"; PATHS="${6:-/,/contact}"
cd "$SITE"
PASS=(); FAIL=(); DEFER=()
LOG="${OUT%.json}.log"; : > "$LOG"
step () { # name command...
  local name="$1"; shift
  echo "== $name" | tee -a "$LOG"
  if "$@" >> "$LOG" 2>&1; then PASS+=("$name"); echo "   pass" ; else FAIL+=("$name"); echo "   FAIL (see $LOG)"; fi
}
defer () { DEFER+=("{\"name\":\"$1\",\"detail\":\"$2\"}"); echo "== $1"; echo "   deferred: $2"; }
cleanup () {
  [ -n "${SITE_PID:-}" ] && { kill -TERM -- "-$SITE_PID" 2>/dev/null || kill "$SITE_PID" 2>/dev/null; }
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
  true
}
trap cleanup EXIT

step "install"            npm ci --silent
step "typecheck:$BRAND"   node scripts/qa/typecheck-brand.mjs "$BRAND"
step "build:$BRAND"       env COMPASS_BRAND="$BRAND" npx next build
step "manifest:$BRAND"    env COMPASS_BRAND="$BRAND" node scripts/qa/manifest.mjs
step "provider-suite"     npx tsx scripts/qa/provider.test.mjs

# The shared mock provider service starts FIRST; the site and the form
# suite both receive the same URL.
MOCK_PORT=$((PORT + 100))
node scripts/qa/mock-provider.mjs --port "$MOCK_PORT" >> "$LOG" 2>&1 &
MOCK_PID=$!
export INQUIRY_MOCK_PROVIDER_URL="http://127.0.0.1:$MOCK_PORT"
for i in $(seq 1 20); do curl -sf "$INQUIRY_MOCK_PROVIDER_URL/health" >/dev/null && break; sleep 0.5; done
if curl -sf "$INQUIRY_MOCK_PROVIDER_URL/health" >/dev/null; then PASS+=("mock-provider-service"); else FAIL+=("mock-provider-service"); fi

# setsid: the site runs in its own process group so cleanup can stop
# next-server itself, not only the npx wrapper.
setsid env COMPASS_BRAND="$BRAND" INQUIRY_DELIVERY=mock INQUIRY_MOCK_PROVIDER_URL="$INQUIRY_MOCK_PROVIDER_URL" npx next start -p "$PORT" >> "$LOG" 2>&1 &
SITE_PID=$!
for i in $(seq 1 40); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 0.5; done

step "crawl:$BRAND"       node scripts/qa/crawl.mjs "http://localhost:$PORT" --host "$HOST" --assets remap

if node scripts/qa/browser-launch.mjs --check >> "$LOG" 2>&1; then
  step "forms-mocked:$BRAND"   env INQUIRY_MOCK_PROVIDER_URL="$INQUIRY_MOCK_PROVIDER_URL" COMPASS_BRAND="$BRAND" node scripts/qa/forms.test.mjs "http://localhost:$PORT" --host "$HOST"
  step "browser:$BRAND"        node scripts/qa/browser.test.mjs "http://localhost:$PORT" --host "$HOST" --paths "$PATHS"
else
  defer "forms-mocked:$BRAND" "no Chromium in this environment (scripts/qa/browser-launch.mjs --check failed); run where a browser exists"
  defer "browser:$BRAND"      "no Chromium in this environment; run where a browser exists"
fi

j () { local out=""; for x in "$@"; do out="$out,\"$x\""; done; echo "[${out#,}]"; }
OK=$([ ${#FAIL[@]} -eq 0 ] && echo true || echo false)
DEF="[$(IFS=,; echo "${DEFER[*]:-}")]"
printf '{"site":"%s","brand":"%s","host":"%s","pass":%s,"fail":%s,"deferred":%s,"ok":%s}\n' "$SITE" "$BRAND" "$HOST" "$(j "${PASS[@]}")" "$(j "${FAIL[@]:-}" | sed 's/\[""\]/[]/')" "$DEF" "$OK" > "$OUT"
echo "results: $OUT"; cat "$OUT"
[ "$OK" = true ]
