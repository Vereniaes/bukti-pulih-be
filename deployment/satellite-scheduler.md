# Satellite sync every fifteen minutes

Cloud Scheduler calls the backend worker. FIRMS hotspots, official ISPU stations and ECMWF model wind are saved independently in MongoDB. Existing map endpoints read these snapshots; the browser still refreshes active layers every five minutes while visible.

The confirmed target is project `hackathon-511608`, service `bukti-pulih-be`, region `asia-southeast2`, request URL `https://bukti-pulih-be-710000917298.asia-southeast2.run.app`.

## Current deployment state

Prepared and tested on 27 October 2026. The authorized account `yuangjin199@gmail.com` can read the project. HTTP 404 from the backend is caused by its existing internal-only ingress. The user selected a public gateway with the backend kept internal, followed by manual source-secret and network setup. Required APIs are enabled and both container images are built; deployment and Scheduler activation remain pending those manual prerequisites. See [the manual setup guide](manual-satellite-prerequisites.md).

Use the authorized account explicitly for every target operation. Do not use the unrelated default SDK project. No Git commit or push is part of this workflow.

## Local verification

```bash
npm run test:satellite
npm run build
npm run sync:satellite
npm run dev
```

The CLI connects to the configured database and writes only `satellite_snapshots` and `satellite_sync_leases`. A successful first sync is required before the map can read data. `npm run sync:satellite -- --force` bypasses quarter-hour deduplication for an operator check, while still respecting an active lease. Production containers can use `node dist/scripts/sync-satellite.js`; development dependencies are unnecessary for that command.

In development, the running backend schedules sync at minutes 00, 15, 30 and 45, independently of browser tabs. This local timer is disabled when `NODE_ENV=production`; Cloud Scheduler supplies production invocations. A process that is stopped cannot run its local timer.

The Mongo store tests create and drop a separate local `buktipulih_satellite_test_<pid>` database. They do not drop or modify the application database.

## Prepare production

1. Authenticate an account with access to `hackathon-511608` and verify the Cloud Run service. The operator needs permission to enable the Scheduler API, manage this job, create/use its service account, and update this Cloud Run service and its IAM binding.
2. Deploy the reviewed backend revision through the existing deployment workflow. Preserve the production `MONGODB_URI`, secrets and other service settings; do not deploy development `.env` values. Set `NODE_ENV=production`.
3. Keep `FIRMS_MAP_KEY` and `ISPU_AUTHORIZATION` in backend secrets. The new public status endpoint reports only whether both are configured.
4. Run a read-only preflight from the backend repository. Google Cloud CLI, Bash, curl and Python 3 are required.

```bash
CLOUDSDK_CORE_ACCOUNT=yuangjin199@gmail.com \
PROJECT_ID=hackathon-511608 \
PUBLIC_API_URL='https://bukti-pulih-api-710000917298.asia-southeast2.run.app' \
PREFLIGHT_ONLY=1 \
bash scripts/configure-satellite-scheduler.sh
```

The script verifies the selected project's number, the service URL, `/health`, and the `satellite-sync-v1` status contract before changing cloud settings. The service must already serve the new revision. Use `GCLOUD=/home/vereniaes/google-cloud-sdk/bin/gcloud` if the local SDK is not on PATH.

## Activate

```bash
CLOUDSDK_CORE_ACCOUNT=yuangjin199@gmail.com \
PROJECT_ID=hackathon-511608 \
PUBLIC_API_URL='https://bukti-pulih-api-710000917298.asia-southeast2.run.app' \
bash scripts/configure-satellite-scheduler.sh
```

The script creates or updates only `buktipulih-satellite-15m`, enables the Scheduler API, creates `buktipulih-satellite-sync@hackathon-511608.iam.gserviceaccount.com`, grants it `roles/run.invoker` on this service, and updates only the two new OIDC environment settings. Existing secrets, public API access, legacy jobs and legacy scheduler settings remain in place.

- Schedule: `*/15 * * * *`, Asia/Jakarta.
- Target: POST `/api/v1/internal/satellite/sync`.
- Audience: canonical service URL returned by Cloud Run; this may differ from the regional request URL. The backend guard and Scheduler use the same value.
- Identity: the dedicated service-account email; Google signature, expiration, audience and verified identity are checked.
- Deadline: 180 seconds. No immediate retries; the following quarter-hour checks failed sources again.
- First execution: requested automatically. `RUN_NOW=0` skips that initial request.

The worker uses a four-minute Mongo lease and one slot per quarter-hour to prevent concurrent or duplicate source calls. Sources fail independently and retain their last successful data. Partial runs return HTTP 502 for operational visibility. A repeated invocation in the same slot skips; an authorized operator can use the CLI with `--force` when immediate recovery is necessary.

## Verify operation

```bash
gcloud scheduler jobs describe buktipulih-satellite-15m \
  --project hackathon-511608 --location asia-southeast2

curl --fail --silent \
  'https://bukti-pulih-api-710000917298.asia-southeast2.run.app/api/v1/external/satellite/status'
```

After the first execution, all three sources should be available. Confirm `checked_at` advances after a second scheduled slot and inspect Cloud Scheduler execution results and backend `satellite_sync` logs. `fetched_at` is the successful retrieval time; source observation times remain separate. A fifteen-minute retrieval schedule does not change a satellite overpass or station measurement schedule.

Missing or invalid authorization on the sync route must fail. Open the desktop and mobile map, change the 6/12/24/72-hour window, enable air/wind, and select a station. Repeated GETs must reuse the same saved retrieval time until the next source sync. Point the frontend API origin at the verified public gateway plus `/api/v1`; the direct backend URL stays internal.

## Data handling

- FIRMS: one national 72-hour snapshot over `[94,-12,142,8]`; public reads filter the time window and coordinates without fetching NASA again. Failed satellite records can be retained from the last snapshot within that window, with partial status.
- ISPU and wind: source snapshots refresh each scheduled run. Stored station pollutant details are fetched only when selected and retained for fifteen minutes.
- Failures preserve the last good payload and retrieval time. Readers label stale data as cached. ISPU/wind older than one hour and FIRMS older than one day are unavailable.
- Payloads use built-in gzip, with a 12 MiB compressed limit and a 64 MiB decoded limit. Invalid or oversized writes do not replace good data. No restoration collections are changed.
- Original satellite image pixels still come directly from NASA GIBS for the chosen satellite/date. The existing imagery catalog checks on its fifteen-minute interval; the worker does not copy image tiles into MongoDB.

## Rollback

```bash
gcloud scheduler jobs pause buktipulih-satellite-15m \
  --project hackathon-511608 --location asia-southeast2
```

Restore the previously deployed backend revision if the new reader or worker causes failures. Retain snapshot collections. Pause only this job; do not change the legacy hazard job or restoration data.

References: [Cloud Run with Scheduler](https://docs.cloud.google.com/run/docs/triggering/using-scheduler), [HTTP target authentication](https://docs.cloud.google.com/scheduler/docs/http-target-auth), [Cloud Run token audience](https://docs.cloud.google.com/run/docs/authenticating/service-to-service), [cron schedules](https://docs.cloud.google.com/scheduler/docs/configuring/cron-job-schedules).
