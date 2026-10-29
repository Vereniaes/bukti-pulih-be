// Todo:
// -> Refresh BNPB totals on the six-hour schedule.

// --- BNPB schedule ---
import cron from "node-cron";
import { syncBnpbKarhutlaData } from "./bnpb.service.js";

export const initBnpbCronJob = (): void => {
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
// --- end of BNPB schedule ---
