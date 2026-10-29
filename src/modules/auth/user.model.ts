// Store user identity, account role and optional public profile details.
import mongoose, { Schema, Document } from "mongoose";
import { USERNAME_INDEX, USERNAME_PATTERN, USERNAME_SAVE_LIMIT } from "./username-policy.js";

export type Participation = "affected" | "volunteer" | "observer";
export interface IUser extends Document {
  phone_number?: string;
  full_name?: string;
  pin_hash?: string;
  password_hash?: string;
  password_version: number;
  email?: string;
  email_verified_at?: Date;
  role: "PUBLIC_GUEST" | "COMMUNITY_VOLUNTEER" | "GOVERNMENT_VERIFIER" | "ADMIN_SUPER";
  role_badge: string;
  organization_name?: string;
  assigned_plots: string[];
  username?: string;
  username_save_count?: number;
  participation?: Participation;
  avatar_url?: string | null;
  city?: string;
  is_active: boolean;
  deleted_at?: Date;
  failed_attempts: number;
  lock_until?: Date;
  created_at: Date;
  last_login_at: Date;
}

const UserSchema = new Schema<IUser>({
  phone_number: { type: String },
  email: { type: String, lowercase: true, trim: true, maxlength: 254 },
  email_verified_at: { type: Date },
  full_name: { type: String },
  pin_hash: { type: String },
  password_hash: { type: String, select: false },
  password_version: { type: Number, default: 0, min: 0 },
  role: {
    type: String,
    enum: ["PUBLIC_GUEST", "COMMUNITY_VOLUNTEER", "GOVERNMENT_VERIFIER", "ADMIN_SUPER"],
    default: "PUBLIC_GUEST",
  },
  role_badge: { type: String, default: "" },
  organization_name: { type: String },
  assigned_plots: [{ type: String }],
  username: { type: String, match: USERNAME_PATTERN },
  username_save_count: { type: Number, default: 0, min: 0, max: USERNAME_SAVE_LIMIT, validate: Number.isInteger },
  participation: { type: String, enum: ["affected", "volunteer", "observer"] },
  avatar_url: { type: String, default: null },
  city: { type: String, maxlength: 80 },
  is_active: { type: Boolean, default: true },
  deleted_at: { type: Date },
  failed_attempts: { type: Number, default: 0 },
  lock_until: { type: Date },
  last_login_at: { type: Date, default: Date.now },
}, { timestamps: { createdAt: "created_at", updatedAt: false } });

UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } }, name: "email_unique_partial" });
UserSchema.index({ phone_number: 1 }, { unique: true, partialFilterExpression: { phone_number: { $type: "string" } }, name: "phone_unique_partial" });
UserSchema.index({ username: 1 }, USERNAME_INDEX);

export const UserModel = mongoose.models.User ?? mongoose.model<IUser>("User", UserSchema);
