// Test-only server with a captured mailer and a guarded temporary database.
import mongoose from "mongoose";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { createEmailAuthService } from "../src/modules/auth/email-auth.service.js";
import { PlotModel } from "../src/modules/plots/plot.model.js";
import { ForumPostModel } from "../src/modules/forum/forum.model.js";
import { ensureAuthIndexes } from "../src/modules/auth/auth.store.js";
import { seedAccountDeletionFixtures } from "./account-deletion.browser-fixtures.js";
import { seedUsernameLimitFixture } from "./username-limit.browser-fixture.js";

async function main() {
  const dbName = `buktipulih_auth_browser_test_${process.pid}`;
  const folder = join(tmpdir(), dbName);
  mkdirSync(folder, { mode: 0o700 }); chmodSync(folder, 0o700);
  const controlPath = join(folder, "clock.json");
  const deliveryPath = join(folder, "deliveries.json");
  writeFileSync(controlPath, JSON.stringify({ now: Date.now() }), { mode: 0o600 });
  const deliveries: { email: string; code: string }[] = [];
  writeFileSync(deliveryPath, "[]", { mode: 0o600 });
  await mongoose.connect(`mongodb://127.0.0.1:27017/${dbName}`);
  await ensureAuthIndexes();
  if (process.argv.includes("--account-deletion")) await seedAccountDeletionFixtures(folder);
  if (process.argv.includes("--username-limit")) await seedUsernameLimitFixture(folder);
  if (process.argv.includes("--recovery")) {
    await Promise.all([ForumPostModel.init(), PlotModel.init()]);
    await PlotModel.create({
      plot_code: "PL-TEST-KALBAR-001", name: "Petak uji terverifikasi", region: "Kalimantan Barat", ecosystem_type: "gambut",
      location: { type: "Point", coordinates: [109.33318, -0.02241] }, area_hectares: 1.5,
      community_name: "Kelompok uji", coordinator_name: "Koordinator uji", initial_planting_date: new Date("2026-01-01"),
      total_planted: 100, current_alive: 80, survival_rate: 80, latest_status: "subur", last_monitored_at: new Date(),
      cover_image_url: "https://evidence-fixture.public.blob.vercel-storage.com/bukti-lapangan/verified.webp",
    });
  }
  const app = createApp({ emailAuth: createEmailAuthService({
    pepper: "c".repeat(64),
    now: () => new Date(JSON.parse(readFileSync(controlPath, "utf8")).now),
    sendCode: async input => { deliveries.push({ email: input.email, code: input.code }); writeFileSync(deliveryPath, JSON.stringify(deliveries), { mode: 0o600 }); },
  }) });
  const server = app.listen(5002, "127.0.0.1", () => console.log(JSON.stringify({ port: 5002, folder, dbName })));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (mongoose.connection.name !== dbName || !/^buktipulih_auth_browser_test_\d+$/.test(dbName)) throw new Error("TEST_DATABASE_MISMATCH");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    rmSync(folder, { recursive: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
void main().catch(() => { console.error("Browser test fixture failed."); process.exitCode = 1; });
