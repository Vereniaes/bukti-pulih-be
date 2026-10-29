// Run quarter-hour sync locally; production uses Cloud Scheduler.
import cron from "node-cron";
import { ENV } from "../../config/env.js";
import { satelliteService } from "./satellite.service.js";

export function initSatelliteDevelopmentScheduler() {
  if (ENV.NODE_ENV !== "development") return;
  return cron.schedule("*/15 * * * *", async () => {
    try {
      console.info(JSON.stringify({ event: "satellite_sync", ...await satelliteService.sync() }));
    } catch { console.error("Satellite sync failed."); }
  }, { timezone: "Asia/Jakarta", noOverlap: true });
}
