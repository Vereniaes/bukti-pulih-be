#!/usr/bin/env bash
# Configure one fifteen-minute job after the satellite backend revision is deployed.
set -euo pipefail
: "${PROJECT_ID:?Set the verified BuktiPulih Project ID}"
GCLOUD="${GCLOUD:-gcloud}"
REGION="${REGION:-asia-southeast2}"
SERVICE="${SERVICE:-bukti-pulih-be}"
BACKEND_URL="${BACKEND_URL:-https://bukti-pulih-be-710000917298.asia-southeast2.run.app}"
BACKEND_URL="${BACKEND_URL%/}"
JOB="buktipulih-satellite-15m"
ACCOUNT="buktipulih-satellite-sync"
SA="${ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"

PROJECT_NUMBER="$("$GCLOUD" projects describe "$PROJECT_ID" --format='value(projectNumber)')"
ACTUAL_URL="$("$GCLOUD" run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
ALIAS_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
if [[ "$BACKEND_URL" != "$ACTUAL_URL" && "$BACKEND_URL" != "$ALIAS_URL" ]]; then
  printf '%s\n' 'Backend URL does not belong to the selected service.'
  exit 1
fi
PUBLIC_API_URL="${PUBLIC_API_URL:-$BACKEND_URL}"
PUBLIC_API_URL="${PUBLIC_API_URL%/}"
if [[ "$PUBLIC_API_URL" != "$BACKEND_URL" ]]; then
  GATEWAY_SERVICE="${GATEWAY_SERVICE:-bukti-pulih-api}"
  GATEWAY_URL="$("$GCLOUD" run services describe "$GATEWAY_SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
  GATEWAY_ALIAS="https://${GATEWAY_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
  if [[ "$PUBLIC_API_URL" != "$GATEWAY_URL" && "$PUBLIC_API_URL" != "$GATEWAY_ALIAS" ]]; then
    printf '%s\n' 'Public API URL does not belong to the selected gateway.'
    exit 1
  fi
fi
curl --fail --silent --show-error "$PUBLIC_API_URL/health" >/dev/null
curl --fail --silent --show-error "$PUBLIC_API_URL/api/v1/external/satellite/status" | python3 -c '
import json,sys
value=json.load(sys.stdin).get("data",{})
if value.get("contract")!="satellite-sync-v1" or value.get("refresh_seconds")!=900:
    sys.exit("Deploy the reviewed satellite backend revision first.")
if value.get("upstream_configured") is not True:
    sys.exit("Configure FIRMS_MAP_KEY and ISPU_AUTHORIZATION on the backend first.")
'
printf 'Target: %s\nSchedule: */15 * * * * (Asia/Jakarta)\nIdentity: %s\n' "$BACKEND_URL" "$SA"
if [[ "${PREFLIGHT_ONLY:-0}" == 1 ]]; then
  printf '%s\n' 'Preflight passed; no cloud settings changed.'
  exit 0
fi

"$GCLOUD" services enable cloudscheduler.googleapis.com --project "$PROJECT_ID"
if ! "$GCLOUD" iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1; then
  "$GCLOUD" iam service-accounts create "$ACCOUNT" --display-name='BuktiPulih satellite sync' --project "$PROJECT_ID"
fi
"$GCLOUD" run services add-iam-policy-binding "$SERVICE" --region "$REGION" --project "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role='roles/run.invoker'
"$GCLOUD" run services update "$SERVICE" --region "$REGION" --project "$PROJECT_ID" \
  --update-env-vars="SATELLITE_SCHEDULER_AUDIENCE=${ACTUAL_URL},SATELLITE_SCHEDULER_SERVICE_ACCOUNT=${SA}"

MODE=create
if "$GCLOUD" scheduler jobs describe "$JOB" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then MODE=update; fi
"$GCLOUD" scheduler jobs "$MODE" http "$JOB" --location "$REGION" --project "$PROJECT_ID" \
  --schedule='*/15 * * * *' --time-zone='Asia/Jakarta' --http-method=POST \
  --uri="$BACKEND_URL/api/v1/internal/satellite/sync" \
  --oidc-service-account-email="$SA" --oidc-token-audience="$ACTUAL_URL" \
  --attempt-deadline=180s --max-retry-attempts=0 \
  --description='Persist FIRMS, ISPU and model wind every fifteen minutes'
"$GCLOUD" scheduler jobs describe "$JOB" --location "$REGION" --project "$PROJECT_ID" \
  --format='yaml(name,state,schedule,timeZone,httpTarget.uri,httpTarget.oidcToken.serviceAccountEmail)'
if [[ "${RUN_NOW:-1}" == 1 ]]; then
  "$GCLOUD" scheduler jobs run "$JOB" --location "$REGION" --project "$PROJECT_ID"
  printf '%s\n' 'First execution requested. Verify checked_at in /api/v1/external/satellite/status and Cloud Scheduler logs.'
fi

