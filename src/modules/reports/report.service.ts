// src/modules/reports/report.service.ts
// -> business logic formulir pelaporan lapangan kader
//      -> penerimaan laporan foto bibit & validasi bounding box anti-spoof
//      -> sinkronisasi batch offline queue saat perangkat kembali terhubung internet
//      -> pembaruan otomatis ke koleksi monitoring_logs dan metrik petak

import { ReportInboxModel } from "./report.model.js";
import { PlotModel } from "../plots/plot.model.js";
import { MonitoringLogModel } from "../timeline/timeline.model.js";
import { sanitizeTextInput } from "../../utils/sanitize.js";
import mongoose from "mongoose";

interface CreateReportInput {
  reporter_id?: string;
  reporter_name?: string;
  plot_id: string;
  tree_condition: "subur" | "perlu_rawat" | "mati";
  height_cm: number;
  latitude: number;
  longitude: number;
  accuracy_meters?: number;
  notes?: string;
  quick_tags?: string[];
  photo_url?: string;
}

export const createReportService = async (input: CreateReportInput) => {
  // cari petak terkait ------------------------------------------------------------
  let plot = null;
  if (mongoose.Types.ObjectId.isValid(input.plot_id)) {
    plot = await PlotModel.findById(input.plot_id);
  }
  if (!plot) {
    plot = await PlotModel.findOne({ plot_code: input.plot_id });
  }

  if (!plot) {
    throw new Error("Petak restorasi tidak ditemukan.");
  }

  // validasi anti-geotag spoofing (koordinat indonesia) --------------------------
  let verificationStatus: "published" | "pending_review" | "flagged_fraud" = "published";
  if (
    input.latitude < -11 ||
    input.latitude > 6 ||
    input.longitude < 95 ||
    input.longitude > 141
  ) {
    verificationStatus = "flagged_fraud";
  }

  const cleanNotes = sanitizeTextInput(input.notes || "");
  const reporterName = input.reporter_name || "Kader Lapangan Terdaftar";

  // buat dokumen laporan inbox ----------------------------------------------------
  const report = new ReportInboxModel({
    reporter_id: input.reporter_id ? new mongoose.Types.ObjectId(input.reporter_id) : undefined,
    reporter_name: reporterName,
    plot_id: plot._id,
    plot_code: plot.plot_code,
    tree_condition: input.tree_condition,
    height_cm: input.height_cm,
    photo_url:
      input.photo_url ||
      "https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=600&auto=format&fit=crop&q=80",
    gps: {
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy_meters: input.accuracy_meters,
    },
    notes: cleanNotes,
    quick_tags: input.quick_tags || [],
    verification_status: verificationStatus,
  });

  await report.save();

  // perbarui petak jika status valid ----------------------------------------------
  if (verificationStatus === "published") {
    plot.last_monitored_at = new Date();
    plot.latest_status = input.tree_condition === "mati" ? "kritis" : input.tree_condition;
    await plot.save();

    // otomatis buat entri linimasa baru -------------------------------------------
    const log = new MonitoringLogModel({
      plot_id: plot._id,
      plot_code: plot.plot_code,
      plot_name: plot.name,
      reporter: {
        user_id: report.reporter_id || new mongoose.Types.ObjectId(),
        full_name: reporterName,
        role_label: "Kader Lapangan Terdaftar",
        is_verified: true,
      },
      monitoring_date: new Date(),
      postmark_badge: `${new Date().toLocaleDateString("id-ID")} • ${plot.plot_code}`,
      tree_metrics: {
        height_cm: input.height_cm,
        condition_status: input.tree_condition,
        condition_label:
          input.tree_condition === "subur"
            ? "Tumbuh Subur 🌿"
            : input.tree_condition === "perlu_rawat"
            ? "Perlu Dirawat 🍂"
            : "Bibit Mati 🥀",
        estimated_survival_rate: plot.survival_rate,
      },
      field_notes: cleanNotes || "Laporan berkala pemantauan bibit pohon di lapangan.",
      images: {
        initial_photo_url: plot.cover_image_url,
        initial_label: "Awal Tanam",
        current_photo_url: report.photo_url,
        current_label: "Hari Ini",
      },
      community_verifications: {
        confirmed_subur_count: 1,
        dispute_count: 0,
        verified_visitors: [],
      },
      comment_count: 0,
    });
    await log.save();
  }

  return report;
};

export const batchOfflineSyncService = async (batch: CreateReportInput[]) => {
  const results = [];
  for (const item of batch) {
    try {
      const saved = await createReportService(item);
      results.push({ status: "synced", report_id: saved._id.toString() });
    } catch {
      results.push({ status: "failed" });
    }
  }
  return {
    synced_count: results.filter((r) => r.status === "synced").length,
    failed_count: results.filter((r) => r.status === "failed").length,
    results,
  };
};
