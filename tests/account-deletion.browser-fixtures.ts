// Seed disposable accounts and discussions for the deletion browser checks.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserModel } from "../src/modules/auth/user.model.js";
import { ForumPostModel, ForumCommentModel } from "../src/modules/forum/forum.model.js";
import { hashPassword } from "../src/modules/auth/password.service.js";
import { createSession } from "../src/modules/auth/session.service.js";
export async function seedAccountDeletionFixtures(folder: string) {
  const password = "DeleteBrowser#2026";
  const hash = await hashPassword(password);
  await Promise.all([UserModel.init(), ForumPostModel.init(), ForumCommentModel.init()]);
  const other = await UserModel.create({ email: "other-deletion@example.test", username: "AkunLain", participation: "observer" });
  const fixtures = [];
  for (const width of [1440, 390, 320, 800]) {
    const user = await UserModel.create({ email: `deletion-${width}@example.test`, username: `Hutan${width}`, participation: "volunteer", city: "Pontianak", password_hash: hash, password_version: 1 });
    const session = await createSession(user._id.toString(), new Date(), 1);
    const post = await ForumPostModel.create({ author_id: user._id, location_name: `Hutan uji ${width}`, region_key: "kalbar", caption: "Pemantauan bibit hutan tetap tersimpan.", media: { type: "image", url: "http://localhost:3001/journal/pl-kalbar-001/m6.jpg", aspect_ratio: "landscape" }, is_anonymous: width === 320 });
    const comment = await ForumCommentModel.create({ post_id: post._id.toString(), author_id: user._id, content: "Komentar uji tetap tersimpan." });
    await ForumCommentModel.create({ post_id: post._id.toString(), parent_id: comment._id.toString(), author_id: user._id, content: "Balasan uji tetap tersimpan." });
    await ForumCommentModel.create({ post_id: post._id.toString(), author_id: other._id, content: "Komentar akun lain tetap tersedia." });
    fixtures.push({ width, password, ...session, id: user._id.toString(), username: user.username, postId: post._id.toString() });
  }
  writeFileSync(join(folder, "account-fixtures.json"), JSON.stringify(fixtures), { mode: 0o600 });
}
