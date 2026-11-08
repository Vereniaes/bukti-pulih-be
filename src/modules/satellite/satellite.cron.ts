// Todo:
// -> Refresh local satellite data at startup and every quarter hour.
// -> Keep overlapping refreshes together and log safe outcomes.

// --- Local satellite schedule ---
import cron from "node-cron";
import { ENV } from "../../config/env.js";
import { satelliteService } from "./satellite.service.js";

// Purpose: Catch up after local downtime without duplicate provider requests.
// Input: Sync operation and runtime mode. Output: Local task with terminal drain.
export function initSatelliteDevelopmentScheduler(sync = satelliteService.sync, mode: string = ENV.NODE_ENV) {
  if (mode !== "development") return;
  let pending: Promise<void> | undefined;
  let draining = false;
  const run = () => draining ? Promise.resolve() : pending ??= sync()
    .then(result => { console.info(JSON.stringify({ event: "satellite_sync", ...result })); })
    .catch(() => { console.error(JSON.stringify({ event: "satellite_sync", failed: true, error: "SYNC_UNAVAILABLE" })); })
    .finally(() => { pending = undefined; });
  const task = cron.schedule("*/15 * * * *", run, {
    name: "satellite-sync-local", timezone: "Asia/Jakarta", noOverlap: true,
  });
  // Resume with the current slot if a sleeping or busy laptop missed a tick.
  task.on("execution:missed", () => { void run(); });
  void run();
  return Object.assign(task, {
    async stopAndDrain() {
      draining = true;
      try { await task.stop(); } finally { await pending; }
    },
  });
}
// --- end of Local satellite schedule ---
