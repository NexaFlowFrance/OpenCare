#!/usr/bin/env bash
# Smoke test de l'API OpenCare: parcours bout en bout contre une instance lancee
# (docker compose en CI). Cree un compte, un cercle de soin, ecrit dans les
# modules cles puis les nouveautes (canicule, foyer), et nettoie en supprimant
# les cercles (cascade). Echoue (exit 1) au premier appel non 2xx.
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3001}"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
EMAIL="${SMOKE_EMAIL:-smoke-${RUN_ID}@example.com}"
PASSWORD="${SMOKE_PASSWORD:-SmokeTest123!}"
NAME="${SMOKE_NAME:-Smoke ${RUN_ID}}"
TOKEN=""
CIRCLE_ID=""

# Appel HTTP: ajoute le Bearer et l'en-tete de cercle quand ils sont definis.
request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  local tmp
  tmp="$(mktemp)"

  if [[ -n "$body" ]]; then
    code=$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$API_BASE$path" \
      -H "Content-Type: application/json" \
      ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
      ${CIRCLE_ID:+-H "X-Circle-Id: $CIRCLE_ID"} \
      -d "$body")
  else
    code=$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" "$API_BASE$path" \
      -H "Content-Type: application/json" \
      ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
      ${CIRCLE_ID:+-H "X-Circle-Id: $CIRCLE_ID"})
  fi

  BODY="$(cat "$tmp")"
  rm -f "$tmp"

  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    echo "[FAIL] $method $path -> HTTP $code"
    echo "$BODY"
    exit 1
  fi

  echo "$BODY"
}

assert_success() {
  echo "$1" | jq -e '.success == true' >/dev/null
}

echo "[1/11] Health"
health=$(request GET "/health")
echo "$health" | jq -e '.status == "ok"' >/dev/null

echo "[2/11] Register"
reg=$(request POST "/api/auth/register" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"$NAME\"}")
assert_success "$reg"
TOKEN=$(echo "$reg" | jq -r '.data.token')
if [[ "$TOKEN" == "null" || -z "$TOKEN" ]]; then
  echo "[FAIL] Missing auth token"
  exit 1
fi

echo "[3/11] Care circle"
circle=$(request POST "/api/circles" '{"recipient_first_name":"Jeanne","recipient_last_name":"Martin"}')
assert_success "$circle"
CIRCLE_ID=$(echo "$circle" | jq -r '.data.circle.id')
if [[ "$CIRCLE_ID" == "null" || -z "$CIRCLE_ID" ]]; then
  echo "[FAIL] Missing circle id"
  exit 1
fi
request GET "/api/circles" >/dev/null

echo "[4/11] Journal"
entry=$(request POST "/api/journal" '{"type":"note","content":"Passage du matin, tout va bien."}')
assert_success "$entry"

echo "[5/11] Calendar"
event=$(request POST "/api/events" '{"title":"Visite","category":"visit","start_time":"2026-03-10T09:00:00"}')
assert_success "$event"
request GET "/api/events?from=2026-03-01T00:00:00&to=2026-03-31T23:59:59" >/dev/null

echo "[6/11] Tasks"
task=$(request POST "/api/tasks" '{"title":"Passer a la pharmacie"}')
assert_success "$task"

echo "[7/11] Shopping"
item=$(request POST "/api/shopping" '{"name":"Lait","category":"Alimentation"}')
assert_success "$item"

echo "[8/11] Dashboard"
request GET "/api/dashboard" >/dev/null

echo "[9/11] Heat-wave watch"
request PUT "/api/heatwave" '{"enabled":true,"reminder_times":["10:00","14:00"]}' >/dev/null
toggle=$(request POST "/api/heatwave/toggle" '{"active":true,"level":"orange"}')
assert_success "$toggle"
request GET "/api/heatwave" >/dev/null

echo "[10/11] Household (couple)"
circle2=$(request POST "/api/circles" '{"recipient_first_name":"Robert","recipient_last_name":"Martin"}')
assert_success "$circle2"
CIRCLE2_ID=$(echo "$circle2" | jq -r '.data.circle.id')
link=$(request POST "/api/circles/$CIRCLE_ID/link" "{\"target_circle_id\":\"$CIRCLE2_ID\"}")
assert_success "$link"
request GET "/api/dashboard/household" >/dev/null

echo "[11/11] Cleanup"
request DELETE "/api/circles/$CIRCLE_ID" >/dev/null
request DELETE "/api/circles/$CIRCLE2_ID" >/dev/null

echo "[OK] OpenCare API smoke test complete"
