// src/server.ts
// -> berkas utama entry point backend service bukti-pulih-be
//      -> inisialisasi koneksi basis data mongodb
//      -> aktivasi background worker cron sinkronisasi bnpb
//      -> memulai http server express pada port 5000

import app from "./app.js";
import { ENV } from "./config/env.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { initBnpbCronJob } from "./modules/bnpb/bnpb.cron.js";
import { initSatelliteDevelopmentScheduler } from "./modules/satellite/satellite.cron.js";

const startServer = async () => {
  console.log("[Server] Memulai backend service BuktiPulih...");

  // hubungkan ke mongodb ----------------------------------------------------------
  await connectDatabase();

  // inisialisasi background cron job bnpb ------------------------------------------
  initBnpbCronJob();
  const satelliteScheduler = initSatelliteDevelopmentScheduler();

  // jalankan server http ----------------------------------------------------------
  const server = app.listen(ENV.PORT, () => {
    console.log(`[Server] BuktiPulih API aktif di port ${ENV.PORT} (mode: ${ENV.NODE_ENV})`);
    console.log(`[Server] Endpoint uji: http://localhost:${ENV.PORT}/health`);
  });

  // penanganan penghentian server (graceful shutdown) -----------------------------
  const handleShutdown = async (signal: string) => {
    console.log(`[Server] Menerima sinyal ${signal}, menutup koneksi...`);
    await satelliteScheduler?.stop();
    server.close(async () => {
      await disconnectDatabase();
      console.log("[Server] Server berhasil dihentikan.");
      process.exit(0);
    });
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
};

startServer().catch((err) => {
  console.error("[Server] Gagal menjalankan server:", err);
  process.exit(1);
});
