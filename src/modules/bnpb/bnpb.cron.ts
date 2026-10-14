// src/modules/bnpb/bnpb.cron.ts
// -> background worker cron sinkronisasi berkala karhutla bnpb
//      -> dijadwalkan setiap 6 jam sekali (0 */6 * * *)
//      -> memperbarui cache mongodb tanpa membebani latensi request user

import cron from "node-cron";
import { syncBnpbKarhutlaData } from "./bnpb.service.js";

export const initBnpbCronJob = (): void => {
  // jalankan setiap 6 jam: menit 0, jam genap pembagi 6
  cron.schedule("0 */6 * * *", async () => {
    console.log("[Cron Worker] Menjalankan sinkronisasi terjadwal ArcGIS BNPB...");
    try {
      await syncBnpbKarhutlaData();
      console.log("[Cron Worker] Sinkronisasi terjadwal berhasil diperbarui.");
    } catch (err) {
      console.error("[Cron Worker] Gagal memperbarui data BNPB:", err);
    }
  });

  console.log("[Cron Worker] Background worker BNPB Karhutla diaktifkan (jadwal: 0 */6 * * *).");
};
