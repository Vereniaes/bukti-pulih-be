import mongoose from "mongoose";
import crypto from "node:crypto";

const COST = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize("NFC"), salt, 64, COST, (err, key) => (err ? reject(err) : resolve(key)));
  });
  return "scrypt$32768$8$3$" + salt.toString("hex") + "$" + hash.toString("hex");
}

async function run() {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/buktipulih_db";
  console.log("[Seeder] Menghubungkan ke database...");
  await mongoose.connect(uri);

  const UserSchema = new mongoose.Schema(
    {
      email: String,
      password_hash: String,
      full_name: String,
      username: String,
      role: String,
      role_badge: String,
      participation: String,
      city: String,
      assigned_plots: [String],
      email_verified_at: Date,
      is_active: Boolean,
    },
    { timestamps: { createdAt: "created_at", updatedAt: false }, strict: false }
  );

  const UserModel = mongoose.models.User || mongoose.model("User", UserSchema);

  const email = "admin@gmail.com";
  const password = "admin123";
  const passwordHash = await hashPassword(password);

  const existing = await UserModel.findOne({ email });
  if (existing) {
    existing.password_hash = passwordHash;
    existing.role = "ADMIN_SUPER";
    existing.role_badge = "Administrator Satgas";
    existing.username = "AdminSatgas";
    existing.full_name = "Administrator Satgas";
    existing.is_active = true;
    existing.email_verified_at = new Date();
    await existing.save();
    console.log("[Seeder] Akun admin@gmail.com berhasil diperbarui ke peran ADMIN_SUPER.");
  } else {
    await UserModel.create({
      email,
      password_hash: passwordHash,
      full_name: "Administrator Satgas",
      username: "AdminSatgas",
      role: "ADMIN_SUPER",
      role_badge: "Administrator Satgas",
      participation: "volunteer",
      city: "Pontianak",
      assigned_plots: ["PL-KALBAR-001"],
      email_verified_at: new Date(),
      is_active: true,
    });
    console.log("[Seeder] Akun admin@gmail.com berhasil dibuat dengan peran ADMIN_SUPER.");
  }
  await mongoose.disconnect();
  console.log("[Seeder] Selesai!");
}

run().catch((err) => {
  console.error("[Seeder] Error:", err.message);
  process.exit(1);
});
