// Remove account identity and access while keeping the author reference for existing content.
import { createHash } from "node:crypto";
import { UserModel } from "./user.model.js";
import { authStore } from "./auth.store.js";
import { takeAuthLimit } from "./auth-rate-limit.js";
import { passwordCodec, PasswordBusyError, type PasswordCodec } from "./password.service.js";
export class AccountDeletionError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); }
}
export async function deleteAccount(userId: string, password: string, passwords: PasswordCodec = passwordCodec) {
  const now = new Date();
  const key = createHash("sha256").update(`account-delete:${userId}`).digest("hex");
  const retryAfter = await takeAuthLimit(key, 5, 15 * 60_000, now);
  if (retryAfter) throw new AccountDeletionError(429, "RATE_LIMITED", "Terlalu banyak percobaan. Coba lagi nanti.", retryAfter);
  const user = await UserModel.findOne({ _id: userId, is_active: true }).select("+password_hash");
  let matches: boolean;
  try { matches = await passwords.verify(password, user?.password_hash); }
  catch (error) {
    if (error instanceof PasswordBusyError) throw new AccountDeletionError(503, "PASSWORD_BUSY", "Server sedang sibuk. Coba lagi sebentar.");
    throw error;
  }
  if (!matches || !user?.password_hash) throw new AccountDeletionError(422, "PASSWORD_INVALID", "Password tidak sesuai.");
  // One conditional write removes identity and disables every session, including sessions issued during deletion.
  const result = await UserModel.updateOne({ _id: user._id, is_active: true, password_hash: user.password_hash }, {
    $set: { is_active: false, deleted_at: now, role: "PUBLIC_GUEST", role_badge: "", assigned_plots: [], failed_attempts: 0 },
    $inc: { password_version: 1 },
    $unset: { email: "", email_verified_at: "", phone_number: "", full_name: "", pin_hash: "", password_hash: "", username: "", username_save_count: "", participation: "", avatar_url: "", city: "", organization_name: "", lock_until: "", last_login_at: "" },
  });
  if (!result.modifiedCount) throw new AccountDeletionError(409, "CREDENTIALS_CHANGED", "Akun berubah. Masuk kembali sebelum melanjutkan.");
  // Active-user checks already deny access. Cleanup failure must not undo or misreport a completed deletion.
  const cleanup = await Promise.allSettled([
    authStore.sessions().deleteMany({ user_id: userId }),
    authStore.flows().deleteMany({ $or: [{ user_id: userId }, ...(user.email ? [{ email: user.email, created_at: { $lte: now } }] : [])] }),
  ]);
  if (cleanup.some(item => item.status === "rejected")) console.error("Account cleanup pending.");
}
