// Create a disposable incomplete account to check onboarding and username conflicts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSession } from "../src/modules/auth/session.service.js";
import { UserModel } from "../src/modules/auth/user.model.js";
import { hashPassword } from "../src/modules/auth/password.service.js";
export async function seedUsernameLimitFixture(folder: string) {
  await UserModel.create({ email: "username-legacy@example.test", username: "ReservedName", password_hash: await hashPassword("LegacyBrowser#2026"), password_version: 1, role: "PUBLIC_GUEST" });
  const unassigned = await UserModel.create({ email: "username-unassigned@example.test", role: "PUBLIC_GUEST" });
  const session = await createSession(unassigned._id.toString());
  writeFileSync(join(folder, "username-unassigned.json"), JSON.stringify(session), { mode: 0o600 });
}
