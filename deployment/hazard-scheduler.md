# Five-minute hazard sync

The backend stores BNPB reported areas and CAMS model estimates in MongoDB. Cloud Scheduler calls the authenticated worker; browser requests read stored snapshots. No source fetch occurs on a page request.

## Local verification

Use the existing Node 24 runtime and local MongoDB:

```bash
npm run test:hazards
npm run build
npm run sync:hazards
```

The integration test creates and drops only a separate `buktipulih_hazard_test_<pid>` database. The manual sync writes only `hazard_snapshots`, `hazard_forecasts`, and `hazard_sync_leases` in the configured application database. It reads plot coordinates without changing plot records.

## Production setup

The supplied target is `https://bukti-pulih-be-710000917298.asia-southeast2.run.app`. The current local GCP account lacks access to project number `710000917298`, and this target returned 404 on 26 October 2026. No production resource has been changed.

1. Authenticate an account with access to the intended project and verify the Project ID. Do not use the unrelated active local project.
2. Deploy this backend revision to the existing Cloud Run service using the existing production MongoDB and secrets. Do not replace production settings with `.env` from local development.
3. Confirm `/health` and `/api/v1/external/hazards` return 200.
4. Run the reviewed setup script. It checks the service URL before changing IAM or scheduler configuration.

```bash
PROJECT_ID='<verified-project-id>' \
BACKEND_URL='https://bukti-pulih-be-710000917298.asia-southeast2.run.app' \
bash scripts/configure-hazard-scheduler.sh
```

The script enables Cloud Scheduler, creates a dedicated service account, grants Cloud Run Invoker on this service, sets the two OIDC configuration values, and creates or updates one job. It does not grant project-wide admin roles or change the service's public API policy.

- Schedule: `*/5 * * * *`, Asia/Jakarta.
- Method: POST `/api/v1/internal/hazards/sync`.
- Audience: exact backend origin, without a trailing slash.
- Identity: exact verified service-account email, with Google's signature and expiry validated by google-auth-library.
- Attempt deadline: 240 seconds. No immediate retries; the next five-minute execution retries failed sources. A Mongo lease prevents overlap across instances.
- Successful source refreshes replace only that layer. Failures retain previous features with a stale state and return a partial 502 result for operational visibility. With no prior data, the layer remains unavailable.
- CAMS checks metadata each run. Unchanged forecasts are reused; source sampling is not repeated every five minutes. Current-hour values are selected from the forecast cache.

## Verify after deployment

```bash
gcloud scheduler jobs run buktipulih-hazards-5m --project "$PROJECT_ID" --location asia-southeast2
gcloud scheduler jobs describe buktipulih-hazards-5m --project "$PROJECT_ID" --location asia-southeast2
curl --fail "$BACKEND_URL/api/v1/external/hazards"
```

Confirm checked_at advances, fetched_at changes only when relevant data was fetched, and forecast valid time is kept separate. Missing or invalid authorization on the sync endpoint must fail. Configure the frontend `NEXT_PUBLIC_API_URL` to the verified backend origin plus `/api/v1` before its next deployment.

## Roll back

Pause only this job with `gcloud scheduler jobs pause buktipulih-hazards-5m --project "$PROJECT_ID" --location asia-southeast2`, then restore the previously deployed backend revision. Retained snapshots need not be deleted. No Git commit or push is part of this setup.

References: [Cloud Scheduler authentication](https://docs.cloud.google.com/scheduler/docs/http-target-auth), [cron schedules](https://docs.cloud.google.com/scheduler/docs/configuring/cron-job-schedules), [CAMS forecast data](https://open-meteo.com/en/docs/air-quality-api).
