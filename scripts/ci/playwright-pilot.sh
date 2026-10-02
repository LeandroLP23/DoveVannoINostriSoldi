#!/usr/bin/env bash
# Pilot measurement: the chart-interaction suite in Puppeteer and in Playwright
# (1, 2 and 4 workers) against the same build and server, on the same runner.
set -uo pipefail
cd "$(dirname "$0")/../.."

PORT="${NEXT_PORT:-3000}"
export DVNS_BASE_URL="http://127.0.0.1:${PORT}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
mkdir -p artifacts/production artifacts/playwright

node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port "$PORT" > artifacts/production/next.log 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null; wait "$server" 2>/dev/null' EXIT
for _ in $(seq 180); do
  curl -sf --max-time 3 "${DVNS_BASE_URL}/territori/irpef" > /dev/null && break
  sleep 0.5
done

failed=0
{
  echo "| Run | Esito | Secondi |"
  echo "| --- | --- | ---: |"
} >> "$SUMMARY"
measure() {
  local name=$1; shift
  local started=$SECONDS
  echo "::group::$name"
  "$@"
  local status=$?
  echo "::endgroup::"
  local result=PASS
  [ "$status" -eq 0 ] || { result=FAIL; failed=1; }
  echo "| $name | $result | $((SECONDS - started)) |" >> "$SUMMARY"
}

measure "Puppeteer chiaro" npm run test:browser:charts
measure "Puppeteer scuro" env DVNS_COLOR_SCHEME=dark npm run test:browser:charts
measure "Download chromium-headless-shell" npx playwright install chromium-headless-shell
# variant = PW_SHARED_CONTEXT:PW_BROWSER
for run in "0:chrome:4" "1:chrome:1" "1:chrome:2" "1:chrome:3" "1:chrome:4" "0:shell:4" "1:shell:2" "1:shell:3" "1:shell:4"; do
  IFS=: read -r shared browser workers <<< "$run"
  label="Playwright contesto $([ "$shared" = 1 ] && echo condiviso || echo isolato), ${browser}, ${workers} worker"
  measure "$label" env PW_SHARED_CONTEXT="$shared" PW_BROWSER="$browser" npx playwright test --fail-on-flaky-tests --workers="$workers"
  cp artifacts/playwright/results.json "artifacts/playwright/results-${shared}-${browser}-${workers}w.json" 2>/dev/null
done
measure "Puppeteer chiaro (server caldo)" npm run test:browser:charts
exit "$failed"
