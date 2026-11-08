// Todo:
// -> Connect MongoDB, start workers and HTTP, and handle shutdown.

// --- Server lifecycle ---
import { createApp } from "./app.js";
import { ENV } from "./config/env.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { initBnpbCronJob } from "./modules/bnpb/bnpb.cron.js";
import { initSatelliteDevelopmentScheduler } from "./modules/satellite/satellite.cron.js";

const startServer = async () => {
  console.log("[Server] Memulai backend service BuktiPulih...");

  await connectDatabase();

  const bnpbScheduler = initBnpbCronJob();
  const satelliteScheduler = initSatelliteDevelopmentScheduler();
  let draining = false;
  const app = createApp({ isDraining: () => draining });

  const server = app.listen(ENV.PORT, () => {
    console.log(`[Server] BuktiPulih API aktif di port ${ENV.PORT} (mode: ${ENV.NODE_ENV})`);
    console.log(`[Server] Endpoint uji: http://localhost:${ENV.PORT}/health`);
  });

  // Purpose: Drain owned work before closing MongoDB, inside Cloud Run's ten seconds.
  // Input: First termination signal. Output: Exit 0 on clean shutdown, otherwise 1.
  const handleShutdown = async (signal: string) => {
    if (draining) return;
    draining = true;
    console.log(`[Server] Menerima sinyal ${signal}, menutup koneksi...`);
    const deadline = setTimeout(() => {
      console.error("[Server] Batas waktu shutdown tercapai.");
      server.closeAllConnections();
      process.exit(1);
    }, 9000);
    let exitCode = 1;
    try {
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
        bnpbScheduler.stopAndDrain(),
        satelliteScheduler?.stopAndDrain(),
      ]);
      const databaseClosed = await disconnectDatabase();
      if (databaseClosed && results.every(result => result.status === "fulfilled")) {
        exitCode = 0;
        console.log("[Server] Server berhasil dihentikan.");
      } else {
        console.error("[Server] Shutdown gagal diselesaikan.");
      }
    } catch {
      console.error("[Server] Shutdown gagal diselesaikan.");
    } finally {
      clearTimeout(deadline);
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
};

startServer().catch((err) => {
  console.error("[Server] Gagal menjalankan server:", err);
  process.exit(1);
});
// --- end of Server lifecycle ---
