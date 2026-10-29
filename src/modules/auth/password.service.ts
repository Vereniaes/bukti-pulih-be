// Hash passwords on the server with a random salt and bounded memory use.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
export const PASSWORD_FORMAT = /^\S{8,128}$/u;
const COST = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const COMMON = new Set(["password", "12345678", "123456789", "qwerty123", "buktipulih", "123456789012345", "1234567890123456", "passwordpassword", "password123456789", "qwertyuiopasdfgh", "buktipulihbuktipulih"]);
let active = 0;
export class PasswordBusyError extends Error {}
export const normalizePassword = (value: string) => value.normalize("NFC");
export function acceptablePassword(value: string) {
  const normalized = normalizePassword(value);
  return PASSWORD_FORMAT.test(normalized) && new Set(Array.from(normalized)).size > 1 && !COMMON.has(normalized.toLowerCase());
}
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (active >= 2) throw new PasswordBusyError("PASSWORD_BUSY");
  active += 1;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(normalizePassword(password), salt, 64, COST, (error, key) => error ? reject(error) : resolve(key)));
  } finally { active -= 1; }
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt$32768$8$3$${salt.toString("hex")}$${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, stored?: string) {
  const parsed = /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(stored ?? "");
  const salt = parsed ? Buffer.from(parsed[1], "hex") : Buffer.alloc(16);
  const expected = parsed ? Buffer.from(parsed[2], "hex") : Buffer.alloc(64);
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected) && parsed !== null;
}
export interface PasswordCodec {
  hash: typeof hashPassword;
  verify: typeof verifyPassword;
}
export const passwordCodec: PasswordCodec = { hash: hashPassword, verify: verifyPassword };
