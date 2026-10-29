// Seed only the guarded browser-test database; session tokens stay in its private temp folder.
import mongoose from "mongoose";
import { basename, dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { UserModel } from "../src/modules/auth/user.model.js";
import { createSession } from "../src/modules/auth/session.service.js";
import { ForumCommentModel, ForumCommentVoteModel, ForumPostModel } from "../src/modules/forum/forum.model.js";

async function main() {
  const folder = process.argv[2];
  if (!folder || dirname(folder) !== "/tmp" || !/^buktipulih_auth_browser_test_[0-9]+$/.test(basename(folder))) throw new Error("TEST_DATABASE_MISMATCH");
  await mongoose.connect(`mongodb://127.0.0.1:27017/${basename(folder)}`);
  await Promise.all([ForumPostModel.init(), ForumCommentModel.init(), ForumCommentVoteModel.init()]);
  const user = await UserModel.create({ email: "discussion-seed@example.test", username: "rimba_rani", city: "Pontianak", participation: "volunteer", role: "PUBLIC_GUEST" });
  const second = await UserModel.create({ email: "discussion-seed-second@example.test", username: "alam_bayu", city: "Ketapang", participation: "affected", role: "PUBLIC_GUEST" });
  const session = await createSession(user._id.toString());
  const secondSession = await createSession(second._id.toString());
  const roots = await ForumCommentModel.insertMany(Array.from({ length: 12 }, (_, index) => ({
    post_id: "post-kb-011", author_id: index % 2 ? second._id : user._id,
    content: index === 0 ? "Pintu air di kanal utama sudah ditutup. Kondisi muka air akan diperiksa kembali besok pagi bersama warga." : `Catatan pemantauan ${index}: kondisi kanal diperiksa bersama kelompok relawan setempat.`,
    created_at: new Date(Date.now() - (index + 1) * 60000),
  })));
  const root = roots[0];
  await ForumCommentVoteModel.create({ comment_id: root._id.toString(), user_id: second._id, vote: "up" });
  let parent = await ForumCommentModel.create({ post_id: "post-kb-011", parent_id: root._id.toString(), author_id: second._id, content: "Terima kasih. Apakah pengukuran juga dilakukan di sisi hulu kanal?" });
  for (let depth = 0; depth < 5; depth++) parent = await ForumCommentModel.create({
    post_id: "post-kb-011", parent_id: parent._id.toString(), author_id: depth % 2 ? second._id : user._id,
    content: `Pemantauan lanjutan ${depth + 1}: titik hulu dan hilir diperiksa pada waktu yang sama agar hasilnya dapat dibandingkan.`,
  });
  await ForumCommentModel.insertMany(Array.from({ length: 11 }, (_, index) => ({ post_id: "post-kb-011", parent_id: root._id.toString(), author_id: user._id, content: `Balasan lapangan ${index + 1}: hasil pengukuran tambahan dicatat di pos pantau.`, created_at: new Date(Date.now() - (index + 1) * 3600000) })));
  const post = await ForumPostModel.create({ author_id: second._id, location_name: "Kanal pemulihan Ketapang", region_key: "kalbar", caption: "Saluran air mulai pulih setelah sekat kanal diperiksa bersama warga. Foto ini mencatat kondisi lokasi pada pemantauan hari ini.", is_anonymous: true,
    media: { type: "image", url: "https://evidence-fixture.public.blob.vercel-storage.com/bukti-lapangan/report.webp", aspect_ratio: "landscape" }, location: { type: "Point", coordinates: [110.1, -1.8] }, ecosystem_type: "gambut", condition: "perlu_rawat", verification_status: "unverified" });
  await ForumCommentModel.create({ post_id: post._id.toString(), author_id: second._id, content: "Kondisi lapangan akan diperiksa kembali setelah hujan berikutnya." });
  writeFileSync(join(folder, "discussion-actors.json"), JSON.stringify({ cookie: session.token, context: session.context, second_cookie: secondSession.token, second_context: secondSession.context, root: root._id.toString(), post: post._id.toString() }), { mode: 0o600 });
  await mongoose.disconnect();
}
void main().catch(async error => { console.error(error.name, error.message); await mongoose.disconnect(); process.exitCode = 1; });
