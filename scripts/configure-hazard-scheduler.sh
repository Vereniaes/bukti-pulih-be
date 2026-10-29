#!/usr/bin/env bash
# Configure the reviewed Cloud Scheduler target after backend deployment.
set -euo pipefail
: "${PROJECT_ID:?Set PROJECT_ID for the BuktiPulih production project}"
REGION="${REGION:-asia-southeast2}"
SERVICE="${SERVICE:-bukti-pulih-be}"
BACKEND_URL="${BACKEND_URL:-https://bukti-pulih-be-710000917298.asia-southeast2.run.app}"
BACKEND_URL="${BACKEND_URL%/}"
JOB="buktipulih-hazards-5m"
ACCOUNT="buktipulih-hazard-sync"
SA="${ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"

# Confirm the selected service before changing its scheduler configuration.
ACTUAL_URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
if [[ "$ACTUAL_URL" != "$BACKEND_URL" ]]; then
  printf '%s\n' 'Backend URL does not match the selected Cloud Run service.' >&2
  exit 1
fi
curl --fail --silent --show-error "${BACKEND_URL}/health" >/dev/null
curl --fail --silent --show-error "${BACKEND_URL}/api/v1/external/hazards" >/dev/null

gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT_ID"
if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$ACCOUNT" --display-name='BuktiPulih hazard sync' --project "$PROJECT_ID"
fi
gcloud run services add-iam-policy-binding "$SERVICE" --region "$REGION" --project "$PROJECT_ID" \
  --member="serviceAccount:${SA}" --role='roles/run.invoker'
gcloud run services update "$SERVICE" --region "$REGION" --project "$PROJECT_ID" \
  --update-env-vars="SCHEDULER_AUDIENCE=${BACKEND_URL},SCHEDULER_SERVICE_ACCOUNT=${SA}"

MODE=create
if gcloud scheduler jobs describe "$JOB" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then MODE=update; fi
gcloud scheduler jobs "$MODE" http "$JOB" --location "$REGION" --project "$PROJECT_ID" \
  --schedule='*/5 * * * *' --time-zone='Asia/Jakarta' --http-method=POST \
  --uri="${BACKEND_URL}/api/v1/internal/hazards/sync" \
  --oidc-service-account-email="$SA" --oidc-token-audience="$BACKEND_URL" \
  --attempt-deadline=240s --max-retry-attempts=0 \
  --description='Check BNPB reports and CAMS model updates every five minutes'
