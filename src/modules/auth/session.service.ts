// Issue opaque sessions and revoke them in MongoDB, including across server instances.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { authStore } from "./auth.store.js";

const DAY = 86_400_000;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export async function createSession(userId: string, now = new Date(), passwordVersion = 0) {
  const token = randomBytes(32).toString("hex");
  const context = randomUUID();
  const expires = new Date(now.getTime() + 7 * DAY);
  await authStore.sessions().insertOne({
    _id: hashToken(token), user_id: userId, context, created_at: now, last_seen_at: now,
    expires_at: expires, purge_at: expires, revoked_at: null, password_version: passwordVersion, method: "password_email",
  });
  return { token, context };
}
export async function readSession(token: string, now = new Date()) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return authStore.sessions().findOneAndUpdate({
    _id: hashToken(token), revoked_at: null, method: "password_email", expires_at: { $gt: now },
    last_seen_at: { $gt: new Date(now.getTime() - DAY) },
  }, { $max: { last_seen_at: now } }, { returnDocument: "after" });
}
export async function revokeSession(token: string, now = new Date()) {
  if (/^[a-f0-9]{64}$/.test(token)) await authStore.sessions().updateOne({ _id: hashToken(token) }, { $set: { revoked_at: now } });
}
