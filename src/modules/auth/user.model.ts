// src/modules/auth/user.model.ts
// -> skema dan model koleksi pengguna (users) & log audit keamanan
//      -> autentikasi nomor hp dan pin 6 digit berenkripsi bcrypt
//      -> hirarki peran pengguna dan lencana kriptografis

import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
  phone_number: string;
  full_name: string;
  pin_hash: string;
  role: "PUBLIC_GUEST" | "COMMUNITY_VOLUNTEER" | "GOVERNMENT_VERIFIER" | "ADMIN_SUPER";
  role_badge: string;
  organization_name?: string;
  assigned_plots: string[];
  is_active: boolean;
  failed_attempts: number;
  lock_until?: Date;
  created_at: Date;
  last_login_at: Date;
}

const UserSchema = new Schema<IUser>(
  {
    phone_number: { type: String, required: true, unique: true, index: true },
    full_name: { type: String, required: true },
    pin_hash: { type: String, required: true },
    role: {
      type: String,
      enum: ["PUBLIC_GUEST", "COMMUNITY_VOLUNTEER", "GOVERNMENT_VERIFIER", "ADMIN_SUPER"],
      default: "COMMUNITY_VOLUNTEER",
    },
    role_badge: { type: String, default: "🌿 Kader Terdaftar ✓" },
    organization_name: { type: String },
    assigned_plots: [{ type: String }],
    is_active: { type: Boolean, default: true },
    failed_attempts: { type: Number, default: 0 },
    lock_until: { type: Date },
    last_login_at: { type: Date, default: Date.now },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  }
);

export const UserModel = mongoose.model<IUser>("User", UserSchema);
