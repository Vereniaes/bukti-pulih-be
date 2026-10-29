// Store shared OTP state and indexes; credentials never enter response payloads.
import mongoose from "mongoose";
import { USERNAME_INDEX } from "./username-policy.js";

export interface AuthFlow {
  _id: string; proof_hash: string; email: string; email_key: string; request_id: string;
  purpose: "register" | "login" | "reset";
  pending_password_hash?: string;
  user_id?: string; password_version?: number;
  generation: number; verifier?: string; attempts: number;
  status: "pending_send" | "active" | "reset_verified" | "used" | "cancelled" | "send_failed";
  created_at: Date; flow_expires_at: Date; expires_at: Date; resend_at: Date; purge_at: Date;
  send_request_id: string; send_requests: string[];
}
export interface AuthSession {
  _id: string; user_id: string; context: string; created_at: Date; last_seen_at: Date;
  expires_at: Date; purge_at: Date; revoked_at: Date | null;
  password_version: number; method: "password_email";
}
interface Reservation { _id: string; purge_at: Date }
interface RateLimit { _id: string; events: Date[]; purge_at: Date }
const db = () => {
  if (!mongoose.connection.db) throw new Error("AUTH_DATABASE_UNAVAILABLE");
  return mongoose.connection.db;
};
export const authStore = {
  flows: () => db().collection<AuthFlow>("auth_flows"),
  reservations: () => db().collection<Reservation>("auth_code_reservations"),
  limits: () => db().collection<RateLimit>("auth_rate_limits"),
  sessions: () => db().collection<AuthSession>("auth_sessions"),
};
const duplicateKey = (error: unknown) => (error as { code?: number }).code === 11000;
export { duplicateKey };

export async function ensureAuthIndexes() {
  const users = db().collection("users");
  const indexes = await users.listIndexes().toArray().catch(error => {
    if ((error as { code?: number }).code === 26) return [];
    throw error;
  });
  if (indexes.some(index => index.unique && index.key.phone_number === 1 && !index.partialFilterExpression)) {
    throw new Error("AUTH_MIGRATION_REQUIRED");
  }
  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } }, name: "email_unique_partial" }),
    users.createIndex({ phone_number: 1 }, { unique: true, partialFilterExpression: { phone_number: { $type: "string" } }, name: "phone_unique_partial" }),
    users.createIndex({ username: 1 }, USERNAME_INDEX),
    authStore.flows().createIndex({ proof_hash: 1, request_id: 1 }, { unique: true, name: "proof_request_unique" }),
    ...[authStore.flows(), authStore.reservations(), authStore.limits(), authStore.sessions()].map(collection => collection.createIndex({ purge_at: 1 }, { expireAfterSeconds: 0 })),
  ]);
}

// Explicit migration keeps uniqueness while allowing several email-only accounts.
export async function migrateAuthIndexes() {
  const users = db().collection("users");
  await users.createIndex({ phone_number: 1 }, { unique: true, partialFilterExpression: { phone_number: { $type: "string" } }, name: "phone_unique_partial" });
  for (const index of await users.listIndexes().toArray()) {
    if (index.name !== "phone_unique_partial" && index.unique && index.key.phone_number === 1 && Object.keys(index.key).length === 1 && !index.partialFilterExpression) {
      await users.dropIndex(index.name!);
    }
  }
  await ensureAuthIndexes();
}
