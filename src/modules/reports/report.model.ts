// src/modules/reports/report.model.ts
// -> skema dan model koleksi laporan lapangan kader (reports_inbox)
//      -> data kondisi tanaman, pengukuran tinggi, dan foto lapangan
//      -> validasi silang koordinat gps terhadap petak (anti-geotag spoofing)

import mongoose, { Schema, Document } from "mongoose";

export interface IReportInbox extends Document {
  reporter_id?: mongoose.Types.ObjectId;
  reporter_name: string;
  plot_id: mongoose.Types.ObjectId;
  plot_code: string;
  tree_condition: "subur" | "perlu_rawat" | "mati";
  height_cm: number;
  photo_url: string;
  gps: {
    latitude: number;
    longitude: number;
    accuracy_meters?: number;
  };
  device_timestamp: Date;
  quick_tags: string[];
  notes?: string;
  verification_status: "published" | "pending_review" | "flagged_fraud";
  is_offline_sync: boolean;
  created_at: Date;
}

const ReportInboxSchema = new Schema<IReportInbox>(
  {
    reporter_id: { type: Schema.Types.ObjectId, ref: "User" },
    reporter_name: { type: String, required: true },
    plot_id: { type: Schema.Types.ObjectId, ref: "Plot", required: true, index: true },
    plot_code: { type: String, required: true },
    tree_condition: {
      type: String,
      enum: ["subur", "perlu_rawat", "mati"],
      required: true,
    },
    height_cm: { type: Number, required: true },
    photo_url: { type: String, required: true },
    gps: {
      latitude: { type: Number, required: true },
      longitude: { type: Number, required: true },
      accuracy_meters: { type: Number },
    },
    device_timestamp: { type: Date, default: Date.now },
    quick_tags: [{ type: String }],
    notes: { type: String },
    verification_status: {
      type: String,
      enum: ["published", "pending_review", "flagged_fraud"],
      default: "published",
    },
    is_offline_sync: { type: Boolean, default: false },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  }
);

export const ReportInboxModel = mongoose.model<IReportInbox>(
  "ReportInbox",
  ReportInboxSchema
);
