// Run one local sync using the same worker as Cloud Scheduler.
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { syncHazardLayers } from "../modules/hazards/hazard.service.js";
async function main() {
  await connectDatabase();
  try { console.log(JSON.stringify(await syncHazardLayers())); }
  finally { await disconnectDatabase(); }
}
main().catch(() => { console.error("Hazard sync failed"); process.exitCode = 1; });
