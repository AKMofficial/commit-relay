#!/usr/bin/env bash
# Container smoke test (16.2, M12): boot the image, poll /healthz to 200, POST a bad
# signature and assert 401, then `docker stop -t 30` and assert exit 0 while draining.
set -euo pipefail

# Actions workflows and a stray .env both map a token into this exact name. Left set,
# the "no token -> N/A in the Changes row" path is never exercised (12.1, 15.2).
unset GITHUB_TOKEN

# CI builds commit-relay:ci and passes no argument; the local flow in 18.3 builds
# commit-relay:dev. With no $1, take whichever tag exists, preferring the CI one.
if [ "$#" -ge 1 ]; then
  IMAGE="$1"
elif docker image inspect commit-relay:ci >/dev/null 2>&1; then
  IMAGE=commit-relay:ci
else
  IMAGE=commit-relay:dev
fi
APP=commit-relay-smoke
MOCK=commit-relay-smoke-mock
HOST_PORT="${SMOKE_PORT:-3000}"
BASE="http://127.0.0.1:${HOST_PORT}"
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  docker rm -f "$MOCK" >/dev/null 2>&1 || true
  docker rm -f "$APP" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "smoke: FAIL: $*" >&2
  docker logs "$APP" 2>&1 | tail -40 >&2 || true
  exit 1
}

cleanup

echo "smoke: starting $IMAGE as $APP"
docker run -d --name "$APP" \
  -p "${HOST_PORT}:3000" \
  --read-only --tmpfs /tmp \
  --memory 512m \
  --stop-timeout 30 \
  -e GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  -e BASECAMP_API_BASE=http://127.0.0.1:9999 \
  -e BASECAMP_ACCOUNT_ID=1234567 \
  -e BASECAMP_CHATBOT_KEY=smoke-chatbot-key \
  -e BASECAMP_BUCKET_ID=2345678 \
  -e BASECAMP_CHAT_ID=7654321 \
  -e BRANCHES=main \
  "$IMAGE" >/dev/null

# The mock joins the application container's network namespace, so BASECAMP_API_BASE
# resolves to it over loopback without the image needing to know a host address.
# Mount only scripts/ and src/: mock-basecamp.ts imports ../src/config/lines-url.ts
# and nothing else; a whole-repo mount would expose .env and .dev.vars to the mock.
docker run -d --name "$MOCK" \
  --network "container:${APP}" \
  -v "${REPO_ROOT}/scripts:/repo/scripts:ro" \
  -v "${REPO_ROOT}/src:/repo/src:ro" \
  node:24-alpine node /repo/scripts/mock-basecamp.ts >/dev/null

# The only assertions below (healthz, 401) never reach Basecamp, so a mock that
# died on startup would go unnoticed and the run would still report PASS.
sleep 2
[ "$(docker inspect -f '{{.State.Running}}' "$MOCK" 2>/dev/null)" = "true" ] || {
  echo "smoke: FAIL: the Basecamp mock container is not running" >&2
  docker logs "$MOCK" 2>&1 | tail -20 >&2 || true
  exit 1
}

echo "smoke: polling ${BASE}/healthz"
health=""
deadline=$(( $(date +%s) + 30 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${BASE}/healthz" || true)"
  [ "$health" = "200" ] && break
  sleep 1
done
[ "$health" = "200" ] || fail "/healthz returned '${health}', expected 200 within 30 s"
echo "smoke: /healthz 200"

echo "smoke: posting a deliberately bad signature"
status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  -X POST "${BASE}/webhook" \
  -H 'content-type: application/json' \
  -H 'x-github-event: push' \
  -H 'x-github-delivery: 00000000-0000-4000-8000-000000000000' \
  -H "x-hub-signature-256: sha256=$(printf 'f%.0s' {1..64})" \
  -d '{"ref":"refs/heads/main"}' || true)"
[ "$status" = "401" ] || fail "bad signature returned '${status}', expected 401"
echo "smoke: bad signature 401"

# Steady-state RSS. 12.1 budgets 55-70 MB steady and ~90 MB peak, asserted here with
# docker stats; sampling right after boot would record the post-boot heap instead.
echo "smoke: settling before the RSS sample"
sleep 10
rss="$(docker stats --no-stream --format '{{.MemUsage}}' "$APP")"
echo "smoke: steady-state RSS: ${rss}"
rss_mb="$(printf '%s' "$rss" | awk '
  { v = $1
    if (v ~ /GiB$/)      { sub(/GiB$/, "", v); v = v * 1024 }
    else if (v ~ /MiB$/) { sub(/MiB$/, "", v) }
    else if (v ~ /KiB$/) { sub(/KiB$/, "", v); v = v / 1024 }
    else if (v ~ /B$/)   { sub(/B$/, "", v); v = v / 1048576 }
    printf "%.1f", v }')"
awk -v m="$rss_mb" 'BEGIN { exit !(m > 0 && m <= 90) }' \
  || fail "RSS ${rss_mb} MiB is outside the 12.1 budget (55-70 MB steady state, ~90 MB ceiling)"
echo "smoke: RSS ${rss_mb} MiB is within the ~90 MB ceiling"

echo "smoke: docker stop -t 30"
started="$(date +%s)"
docker stop -t 30 "$APP" >/dev/null
elapsed=$(( $(date +%s) - started ))
code="$(docker inspect -f '{{.State.ExitCode}}' "$APP")"
[ "$code" = "0" ] || fail "exit code ${code}, expected 0 (SIGKILL after the grace period exits 137)"
[ "$elapsed" -lt 30 ] || fail "stop took ${elapsed}s, which is not inside the 30 s drain window"
echo "smoke: stopped cleanly in ${elapsed}s with exit code 0"

echo "smoke: PASS (${IMAGE})"
