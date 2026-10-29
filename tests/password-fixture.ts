// Fast injected hashing for OTP concurrency tests; real scrypt is tested separately.
import { createHash } from "node:crypto";
export const TEST_PASSWORD = "ForestRecoveryExample2026!";
const digest = (value: string) => `test$${createHash("sha256").update(value.normalize("NFC")).digest("hex")}`;
export const testPasswords = {
  hash: async (value: string) => digest(value),
  verify: async (value: string, stored?: string) => digest(value) === stored,
};
