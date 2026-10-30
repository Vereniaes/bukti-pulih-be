// Todo:
// -> Refresh BNPB totals on the six-hour schedule and catch up in local development.

// --- BNPB schedule ---
import cron from "node-cron";
import { ENV } from "../../config/env.js";
import { syncBnpbKarhutlaData } from "./bnpb.service.js";

// Purpose: Keep local startup and delayed ticks on one refresh.
// Input: Runtime mode and sync operation. Output: Stoppable six-hour task.
export const initBnpbCronJob = (mode = ENV.NODE_ENV, sync = syncBnpbKarhutlaData) => {
  let pending: Promise<void> | undefined;
  const refresh = () => pending ??= Promise.resolve().then(sync)
    .then(snapshot => {
      if (snapshot.sync_failed) console.warn("[Cron Worker] Pembaruan BNPB gagal.");
      else console.log("[Cron Worker] Sinkronisasi terjadwal berhasil diperbarui.");
    })
    .catch(() => { console.error("[Cron Worker] Pembaruan BNPB gagal."); })
    .finally(() => { pending = undefined; });
  const task = cron.schedule("0 */6 * * *", refresh);
  if (mode === "development") {
    task.on("execution:missed", () => { void refresh(); });
    void refresh();
  }

  console.log("[Cron Worker] Background worker BNPB Karhutla diaktifkan (jadwal: 0 */6 * * *).");
  return task;
};
// --- end of BNPB schedule ---
