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

echo "[1/14] Health"
health=$(request GET "/health")
echo "$health" | jq -e '.status == "ok"' >/dev/null

echo "[2/14] Register"
reg=$(request POST "/api/auth/register" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"$NAME\"}")
assert_success "$reg"
TOKEN=$(echo "$reg" | jq -r '.data.token')
if [[ "$TOKEN" == "null" || -z "$TOKEN" ]]; then
  echo "[FAIL] Missing auth token"
  exit 1
fi

echo "[3/14] Care circle"
circle=$(request POST "/api/circles" '{"recipient_first_name":"Jeanne","recipient_last_name":"Martin"}')
assert_success "$circle"
CIRCLE_ID=$(echo "$circle" | jq -r '.data.circle.id')
if [[ "$CIRCLE_ID" == "null" || -z "$CIRCLE_ID" ]]; then
  echo "[FAIL] Missing circle id"
  exit 1
fi
request GET "/api/circles" >/dev/null

echo "[4/14] Journal"
entry=$(request POST "/api/journal" '{"type":"note","content":"Passage du matin, tout va bien."}')
assert_success "$entry"

echo "[5/14] Calendar"
event=$(request POST "/api/events" '{"title":"Visite","category":"visit","start_time":"2026-03-10T09:00:00"}')
assert_success "$event"
request GET "/api/events?from=2026-03-01T00:00:00&to=2026-03-31T23:59:59" >/dev/null

echo "[6/14] Tasks"
task=$(request POST "/api/tasks" '{"title":"Passer a la pharmacie"}')
assert_success "$task"

echo "[7/14] Shopping"
item=$(request POST "/api/shopping" '{"name":"Lait","category":"Alimentation"}')
assert_success "$item"

echo "[8/14] Dashboard"
request GET "/api/dashboard" >/dev/null

echo "[9/14] Heat-wave watch"
request PUT "/api/heatwave" '{"enabled":true,"reminder_times":["10:00","14:00"]}' >/dev/null
toggle=$(request POST "/api/heatwave/toggle" '{"active":true,"level":"orange"}')
assert_success "$toggle"
request GET "/api/heatwave" >/dev/null

echo "[10/14] Household (couple)"
circle2=$(request POST "/api/circles" '{"recipient_first_name":"Robert","recipient_last_name":"Martin"}')
assert_success "$circle2"
CIRCLE2_ID=$(echo "$circle2" | jq -r '.data.circle.id')
link=$(request POST "/api/circles/$CIRCLE_ID/link" "{\"target_circle_id\":\"$CIRCLE2_ID\"}")
assert_success "$link"
request GET "/api/dashboard/household" >/dev/null

echo "[11/14] Password reset (no SMTP: admin delivery)"
forgot=$(request POST "/api/auth/forgot-password" "{\"email\":\"$EMAIL\"}")
assert_success "$forgot"
echo "$forgot" | jq -e '.data.delivery == "admin"' >/dev/null
check=$(request GET "/api/auth/reset-password/0000000000000000000000000000000000000000000000000000000000000000")
echo "$check" | jq -e '.data.valid == false' >/dev/null
request GET "/api/auth/password-resets" >/dev/null

echo "[12/14] Medications (quantity per dose, patient view, kiosk confirm, as-needed dose)"
med=$(request POST "/api/medications" '{"name":"Metformine","dosage":"500 mg","form":"tablet","with_food":"with","reason":"Diabete","schedules":[{"time_of_day":"08:00","quantity":2},{"time_of_day":"20:00","quantity":1}]}')
assert_success "$med"
echo "$med" | jq -e '.data.schedules | length == 2 and (.[0].quantity | tonumber) == 2' >/dev/null
intakes=$(request GET "/api/medications/intakes")
echo "$intakes" | jq -e '.data | length == 2 and all(.[]; has("quantity") and has("photo_url") and has("confirmed_source"))' >/dev/null
kiosk=$(request GET "/api/kiosk/today")
echo "$kiosk" | jq -e '.data.medications | has("due_now") and has("upcoming_count") and .total == 2' >/dev/null
first_id=$(echo "$intakes" | jq -r '.data[0].id')
confirm=$(request POST "/api/kiosk/intakes/confirm" "{\"intake_ids\":[\"$first_id\"]}")
echo "$confirm" | jq -e '.data.confirmed == 1' >/dev/null
request GET "/api/medications/intakes" | jq -e '.data | any(.[]; .status == "taken" and .confirmed_source == "kiosk")' >/dev/null
prn=$(request POST "/api/medications" '{"name":"Doliprane","dosage":"1000 mg","prn":true}')
assert_success "$prn"
prn_id=$(echo "$prn" | jq -r '.data.id')
dose=$(request POST "/api/medications/$prn_id/intakes" '{}')
echo "$dose" | jq -e '.data.status == "taken" and .data.confirmed_source == "caregiver"' >/dev/null

echo "[13/14] Patient device (pairing, visitor check-in, care plan, escalation rules, help request, Ask me, PIN)"
pairing=$(request POST "/api/kiosk/devices/pairing" '{"kind":"kiosk","name":"Smoke tablet"}')
assert_success "$pairing"
code=$(echo "$pairing" | jq -r '.data.code')
paired=$(curl -sS -X POST "$API_BASE/api/kiosk/pair" -H "Content-Type: application/json" -d "{\"code\":\"$code\"}")
echo "$paired" | jq -e '.success == true and (.data.token | length) == 64' >/dev/null
kiosk_token=$(echo "$paired" | jq -r '.data.token')
device_today=$(curl -sS "$API_BASE/api/kiosk/today" -H "X-Kiosk-Token: $kiosk_token")
echo "$device_today" | jq -e '.success == true and .data.device.kind == "kiosk" and (.data.medications | has("due_now"))' >/dev/null
forbidden=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/api/medications" -H "X-Kiosk-Token: $kiosk_token")
[[ "$forbidden" == "401" ]] || { echo "[FAIL] device token must not reach caregiver routes (got $forbidden)"; exit 1; }
pin=$(request PUT "/api/kiosk/pin" '{"pin":"2468"}')
assert_success "$pin"
verify=$(curl -sS -X POST "$API_BASE/api/kiosk/pin/verify" -H "Content-Type: application/json" -H "X-Kiosk-Token: $kiosk_token" -d '{"pin":"2468"}')
echo "$verify" | jq -e '.data.ok == true' >/dev/null
visit=$(curl -sS -X POST "$API_BASE/api/kiosk/visits/check-in" -H "Content-Type: application/json" -H "X-Kiosk-Token: $kiosk_token" -d '{"visitor_type":"nurse","visitor_name":"Camille"}')
echo "$visit" | jq -e '.success == true and .data.visitor_type == "nurse" and .data.checked_out_at == null' >/dev/null
visit_id=$(echo "$visit" | jq -r '.data.id')
dash=$(request GET "/api/dashboard")
echo "$dash" | jq -e '.data.attention | type == "array" and (map(.kind) | index("visitor_present") != null)' >/dev/null
note=$(curl -sS -X POST "$API_BASE/api/kiosk/visits/$visit_id/note" -H "Content-Type: application/json" -H "X-Kiosk-Token: $kiosk_token" -d '{"content":"Tension prise, tout va bien."}')
echo "$note" | jq -e '.data.note == "Tension prise, tout va bien."' >/dev/null
out=$(curl -sS -X POST "$API_BASE/api/kiosk/visits/$visit_id/check-out" -H "Content-Type: application/json" -H "X-Kiosk-Token: $kiosk_token" -d '{}')
echo "$out" | jq -e '.data.checked_out_at != null' >/dev/null
visits=$(request GET "/api/visits")
echo "$visits" | jq -e '.data | length == 1 and .[0].visitor_name == "Camille"' >/dev/null
occ_event=$(request POST "/api/events" '{"title":"Passage infirmier","category":"nurse","start_time":"2026-01-05T09:00:00","rrule":"FREQ=WEEKLY;BYDAY=MO"}')
occ_id=$(echo "$occ_event" | jq -r '.data.id')
skipped=$(request PUT "/api/events/$occ_id/occurrences/2026-01-12" '{"action":"skip"}')
echo "$skipped" | jq -e '.data.exceptions | length == 1 and .[0].action == "skip"' >/dev/null
moved=$(request PUT "/api/events/$occ_id/occurrences/2026-01-19" '{"action":"move","start_time":"2026-01-20T14:00:00"}')
echo "$moved" | jq -e '.data.exceptions | length == 2 and (map(select(.action == "move")) | length == 1)' >/dev/null
bad_occ=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/events/$occ_id/occurrences/2026-01-13" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d '{"action":"skip"}')
[[ "$bad_occ" == "400" ]]
restored=$(request DELETE "/api/events/$occ_id/occurrences/2026-01-12")
echo "$restored" | jq -e '.data.exceptions | length == 1' >/dev/null
request DELETE "/api/events/$occ_id" >/dev/null

med_id=$(echo "$med" | jq -r '.data.id')
second_id=$(echo "$intakes" | jq -r '.data[1].id')
second_qty=$(echo "$intakes" | jq -r '.data[1].quantity')
stock=$(request PUT "/api/medications/$med_id/stock" '{"stock_quantity":10,"stock_alert_threshold":4}')
echo "$stock" | jq -e '(.data.stock_quantity | tonumber) == 10 and (.data.stock_alert_threshold | tonumber) == 4' >/dev/null
bad_stock=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/medications/$med_id/stock" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d '{"stock_quantity":-2}')
[[ "$bad_stock" == "400" ]]
request POST "/api/kiosk/intakes/confirm" "{\"intake_ids\":[\"$second_id\"]}" >/dev/null
after_stock=$(request GET "/api/medications" | jq -r --arg id "$med_id" '.data[] | select(.id == $id) | .stock_quantity')
awk -v a="$after_stock" -v q="$second_qty" 'BEGIN { exit !(a + 0 == 10 - q) }'

thr=$(request PUT "/api/vitals/thresholds" '{"type":"bp","min_value":90,"max_value":140,"min_value2":50,"max_value2":90}')
echo "$thr" | jq -e '.data.type == "bp"' >/dev/null
bad_thr=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/vitals/thresholds" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d '{"type":"bp","min_value":150,"max_value":100}')
[[ "$bad_thr" == "400" ]]
request POST "/api/vitals" '{"type":"bp","value":175,"value2":105}' >/dev/null
dash_vitals=$(request GET "/api/dashboard")
echo "$dash_vitals" | jq -e '.data.attention | map(.kind) | index("vitals_out_of_range") != null' >/dev/null
request GET "/api/vitals/thresholds" | jq -e '. | .data | length == 1' >/dev/null

unread=$(request GET "/api/messages/unread")
echo "$unread" | jq -e '.data.total == 0 and (.data.dms | type == "array")' >/dev/null
read_ack=$(request POST "/api/messages/read" '{"channel":"circle"}')
echo "$read_ack" | jq -e '.data.total == 0' >/dev/null

esc=$(request GET "/api/escalation/rules")
echo "$esc" | jq -e '.data.rules.enabled == false and .data.rules.med_primary_min == 30' >/dev/null
rejected=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API_BASE/api/escalation/rules" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -H "X-Circle-Id: $CIRCLE_ID" -d '{"med_primary_min":-1}')
[[ "$rejected" == "400" ]]
esc=$(request PUT "/api/escalation/rules" '{"enabled":true,"med_patient_min":15,"med_primary_min":30,"help_ack_min":5}')
echo "$esc" | jq -e '.data.rules.enabled == true and .data.rules.help_ack_min == 5' >/dev/null
help_before=$(request GET "/api/escalation/help")
echo "$help_before" | jq -e '. | .data | length == 0' >/dev/null
status=$(curl -sS -X POST "$API_BASE/api/kiosk/status" -H "Content-Type: application/json" -H "X-Kiosk-Token: $kiosk_token" -d '{"kind":"help"}')
echo "$status" | jq -e '.success == true' >/dev/null
help_after=$(request GET "/api/escalation/help")
echo "$help_after" | jq -e '.data | length == 1 and (.[0].acknowledged_at == null)' >/dev/null
help_id=$(echo "$help_after" | jq -r '.data[0].id')
ack=$(request POST "/api/escalation/help/$help_id/ack")
echo "$ack" | jq -e '.data.acknowledged_at != null' >/dev/null
request GET "/api/escalation/help" | jq -e '.data | length == 0' >/dev/null
request PUT "/api/escalation/rules" '{"enabled":false}' | jq -e '.data.rules.enabled == false' >/dev/null
plan=$(request PUT "/api/care-plan" '{"sections":{"morning":"Lever vers 7 h 30","emergency":"Appeler Alice en premier","bogus":"ignore"}}')
echo "$plan" | jq -e '.success == true and .data.sections.morning == "Lever vers 7 h 30" and (.data.sections | has("bogus") | not)' >/dev/null
plan=$(request GET "/api/care-plan")
echo "$plan" | jq -e '.data.sections.emergency == "Appeler Alice en premier" and (.data.week.days | length == 7) and (.data.medications | type == "array") and (.data.professionals | type == "array")' >/dev/null
kplan=$(curl -sS "$API_BASE/api/kiosk/care-plan" -H "X-Kiosk-Token: $kiosk_token")
echo "$kplan" | jq -e '.data.sections.morning == "Lever vers 7 h 30"' >/dev/null
ask=$(curl -sS -X POST "$API_BASE/api/companion/message" -H "Content-Type: application/json" -H "X-Kiosk-Token: $kiosk_token" -d '{"messages":[{"role":"user","content":"Qui est venu aujourd hui ?"}]}')
echo "$ask" | jq -e '.success == true and .data.source == "facts" and .data.intent == "visitors" and (.data.reply | test("Camille"))' >/dev/null
ask=$(curl -sS -X POST "$API_BASE/api/companion/message" -H "Content-Type: application/json" -H "X-Kiosk-Token: $kiosk_token" -d '{"messages":[{"role":"user","content":"Quels medicaments je dois prendre ?"}]}')
echo "$ask" | jq -e '.data.source == "facts" and .data.intent == "medications"' >/dev/null
ask=$(curl -sS -X POST "$API_BASE/api/companion/message" -H "Content-Type: application/json" -H "X-Kiosk-Token: $kiosk_token" -d '{"messages":[{"role":"user","content":"Raconte moi un souvenir"}]}')
echo "$ask" | jq -e '.data.source == "fallback" and .data.flagged == false' >/dev/null
unpair=$(curl -sS -X POST "$API_BASE/api/kiosk/device/unpair" -H "Content-Type: application/json" -H "X-Kiosk-Token: $kiosk_token" -d '{}')
echo "$unpair" | jq -e '.success == true' >/dev/null
dead=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/api/kiosk/today" -H "X-Kiosk-Token: $kiosk_token")
[[ "$dead" == "401" ]] || { echo "[FAIL] revoked device token still accepted (got $dead)"; exit 1; }

echo "[14/14] Cleanup"
request DELETE "/api/circles/$CIRCLE_ID" >/dev/null
request DELETE "/api/circles/$CIRCLE2_ID" >/dev/null

echo "[OK] OpenCare API smoke test complete"
