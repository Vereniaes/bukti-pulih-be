// src/modules/timeline/timeline.model.ts
// -> skema dan model koleksi linimasa relawan (monitoring_logs & log_comments)
//      -> data memo lapangan, komparasi foto bibit, metrik tumbuh kembang
//      -> sistem verifikasi suara warga anti-fraud dan komentar komunitas

import mongoose, { Schema, Document } from "mongoose";

export interface IMonitoringLog extends Document {
  plot_id: mongoose.Types.ObjectId;
  plot_code: string;
  plot_name: string;
  reporter: {
    user_id: mongoose.Types.ObjectId;
    full_name: string;
    role_label: string;
    is_verified: boolean;
  };
  monitoring_date: Date;
  postmark_badge: string;
  tree_metrics: {
    height_cm: number;
    condition_status: "subur" | "perlu_rawat" | "mati";
    condition_label: string;
    estimated_survival_rate: number;
  };
  field_notes: string;
  images: {
    initial_photo_url: string;
    initial_label: string;
    current_photo_url: string;
    current_label: string;
  };
  community_verifications: {
    confirmed_subur_count: number;
    dispute_count: number;
    verified_visitors: string[]; // fingerprint / ip visitor untuk anti-manipulasi suara
  };
  comment_count: number;
  created_at: Date;
  updated_at: Date;
}

const MonitoringLogSchema = new Schema<IMonitoringLog>(
  {
    plot_id: { type: Schema.Types.ObjectId, ref: "Plot", required: true, index: true },
    plot_code: { type: String, required: true },
    plot_name: { type: String, required: true },
    reporter: {
      user_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
      full_name: { type: String, required: true },
      role_label: { type: String, default: "Kader Lapangan Terdaftar" },
      is_verified: { type: Boolean, default: true },
    },
    monitoring_date: { type: Date, default: Date.now },
    postmark_badge: { type: String, required: true },
    tree_metrics: {
      height_cm: { type: Number, required: true },
      condition_status: {
        type: String,
        enum: ["subur", "perlu_rawat", "mati"],
        default: "subur",
      },
      condition_label: { type: String, default: "Tumbuh Subur 🌿" },
      estimated_survival_rate: { type: Number, default: 85.0 },
    },
    field_notes: { type: String, required: true },
    images: {
      initial_photo_url: { type: String, required: true },
      initial_label: { type: String, required: true },
      current_photo_url: { type: String, required: true },
      current_label: { type: String, required: true },
    },
    community_verifications: {
      confirmed_subur_count: { type: Number, default: 0 },
      dispute_count: { type: Number, default: 0 },
      verified_visitors: [{ type: String }],
    },
    comment_count: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

MonitoringLogSchema.index({ plot_id: 1, created_at: -1 });

export const MonitoringLogModel = mongoose.model<IMonitoringLog>(
  "MonitoringLog",
  MonitoringLogSchema
);

// skema komentar warga -----------------------------------------------------------
export interface ILogComment extends Document {
  log_id: mongoose.Types.ObjectId;
  author_name: string;
  author_badge: "donatur" | "warga_lokal" | "pemerhati";
  content: string;
  created_at: Date;
}

const LogCommentSchema = new Schema<ILogComment>(
  {
    log_id: { type: Schema.Types.ObjectId, ref: "MonitoringLog", required: true, index: true },
    author_name: { type: String, required: true },
    author_badge: {
      type: String,
      enum: ["donatur", "warga_lokal", "pemerhati"],
      default: "warga_lokal",
    },
    content: { type: String, required: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  }
);

export const LogCommentModel = mongoose.model<ILogComment>("LogComment", LogCommentSchema);
