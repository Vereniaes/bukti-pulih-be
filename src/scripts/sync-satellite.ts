// Refresh durable satellite snapshots from the command line.
import { randomUUID } from "node:crypto";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { satelliteService } from "../modules/satellite/satellite.service.js";
async function main() {
try {
  await connectDatabase();
  const result = await satelliteService.sync(process.argv.includes("--force") ? "manual:" + randomUUID() : undefined);
  console.log(JSON.stringify(result));
  if (result.failed) process.exitCode = 1;
} catch {
  console.error("Satellite sync failed.");
  process.exitCode = 1;
} finally { await disconnectDatabase(); }
}
void main();
