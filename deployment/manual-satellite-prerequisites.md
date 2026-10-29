# Manual prerequisites for the private backend and public gateway

The user selected manual secret and network setup. No local source credentials have been transferred. Google Cloud APIs for Scheduler, Secret Manager and Compute are enabled, and both reviewed container images have built successfully. Backend and gateway deployments and the fifteen-minute job are not active yet.

Use project `hackathon-511608`, region `asia-southeast2`, with the authorized account `yuangjin199@gmail.com`.

## 1. Enter the two source secrets in Google Cloud Console

Open [Secret Manager for this project](https://console.cloud.google.com/security/secret-manager?project=hackathon-511608) and create these secrets, each with an enabled first version:

| Secret name | Value to enter privately |
| --- | --- |
| `buktipulih-firms-map-key` | Existing `FIRMS_MAP_KEY` from the local backend configuration |
| `buktipulih-ispu-authorization` | Existing `ISPU_AUTHORIZATION` from the local backend configuration |

Use automatic replication. Enter values directly in Secret Manager; do not send their contents through chat. Keep the production MongoDB, JWT and cookie settings unchanged.

## 2. Run the reviewed infrastructure commands manually

Open [Cloud Shell](https://console.cloud.google.com/?cloudshell=true&project=hackathon-511608), authenticate the account above and run the block below. This creates a dedicated VPC/subnet and two service identities, assigns only source-secret access to the existing backend identity, and assigns Scheduler invocation on this backend. It does not read secret payloads, deploy a container, change the existing backend ingress or touch application collections.

```bash
set -euo pipefail
GCP_PROJECT=hackathon-511608
GCP_REGION=asia-southeast2
GCP_USER=yuangjin199@gmail.com

# Confirm the project and service before any change.
gcloud projects describe "$GCP_PROJECT" --account "$GCP_USER" --format='value(projectNumber)'
gcloud run services describe bukti-pulih-be \
  --project "$GCP_PROJECT" --region "$GCP_REGION" --account "$GCP_USER" \
  --format='value(status.url)'

# Confirm the manually entered secrets have enabled versions.
for SECRET_NAME in buktipulih-firms-map-key buktipulih-ispu-authorization; do
  gcloud secrets versions list "$SECRET_NAME" \
    --project "$GCP_PROJECT" --account "$GCP_USER" --filter='state=ENABLED' --format='value(name)'
  gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
    --project "$GCP_PROJECT" --account "$GCP_USER" \
    --member='serviceAccount:710000917298-compute@developer.gserviceaccount.com' \
    --role=roles/secretmanager.secretAccessor
 done

# Dedicated network; unrelated existing networks are unchanged.
if ! gcloud compute networks describe buktipulih-gateway --project "$GCP_PROJECT" --account "$GCP_USER" >/dev/null 2>&1; then
  gcloud compute networks create buktipulih-gateway --subnet-mode=custom \
    --project "$GCP_PROJECT" --account "$GCP_USER"
fi
if ! gcloud compute networks subnets describe buktipulih-gateway-jkt --region "$GCP_REGION" --project "$GCP_PROJECT" --account "$GCP_USER" >/dev/null 2>&1; then
  gcloud compute networks subnets create buktipulih-gateway-jkt \
    --network=buktipulih-gateway --range=10.88.0.0/26 --enable-private-ip-google-access \
    --region "$GCP_REGION" --project "$GCP_PROJECT" --account "$GCP_USER"
fi

# Dedicated runtime and worker identities; no project-wide admin roles.
for ACCOUNT_NAME in buktipulih-api-gateway buktipulih-satellite-sync; do
  if ! gcloud iam service-accounts describe "$ACCOUNT_NAME@$GCP_PROJECT.iam.gserviceaccount.com" --project "$GCP_PROJECT" --account "$GCP_USER" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$ACCOUNT_NAME" --project "$GCP_PROJECT" --account "$GCP_USER"
  fi
done
gcloud run services add-iam-policy-binding bukti-pulih-be \
  --project "$GCP_PROJECT" --region "$GCP_REGION" --account "$GCP_USER" \
  --member="serviceAccount:buktipulih-satellite-sync@$GCP_PROJECT.iam.gserviceaccount.com" \
  --role=roles/run.invoker

gcloud compute networks subnets describe buktipulih-gateway-jkt \
  --project "$GCP_PROJECT" --region "$GCP_REGION" --account "$GCP_USER" \
  --format='yaml(name,network,ipCidrRange,privateIpGoogleAccess)'
```

Expected project number: `710000917298`. Expected backend URL: `https://bukti-pulih-be-tbg4dx4uha-et.a.run.app`. The subnet must belong to `buktipulih-gateway`, use `10.88.0.0/26`, and show `privateIpGoogleAccess: true`.

The gateway will use Direct VPC egress with `all-traffic`. Private Google Access lets it reach the internal Cloud Run backend without Cloud NAT or a Serverless VPC Access connector. It will scale to zero and proxy `/api/v1/` and `/health`, blocking the internal worker routes. Backend ingress remains `internal`.

## 3. Continue deployment after prerequisites exist

After manual setup, confirm completion in the chat. Metadata and IAM can then be checked without reading any secret value. The prepared images are:

- Backend: `asia-southeast2-docker.pkg.dev/hackathon-511608/cloud-run-source-deploy/bukti-pulih-be/bukti-pulih-be:satellite-sync-20261027`.
- Gateway: `asia-southeast2-docker.pkg.dev/hackathon-511608/cloud-run-source-deploy/bukti-pulih-api/gateway:20261027`.

The next deployment attaches the two secret references to the backend, keeps production settings, deploys `bukti-pulih-api` with the dedicated subnet, and configures Scheduler. The scheduler setup script accepts `PUBLIC_API_URL=<verified-gateway-url>` for preflight while its authenticated target stays the internal backend. The frontend then needs `NEXT_PUBLIC_API_URL=<gateway-url>/api/v1` and a production rebuild; no Vercel CLI session or linked local Vercel project is currently available.

References: [Private Cloud Run networking](https://docs.cloud.google.com/run/docs/securing/private-networking), [Direct VPC egress](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc).
