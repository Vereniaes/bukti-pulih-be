// Prepare auth indexes explicitly without changing accounts or their history.
import mongoose from "mongoose";
import { ENV } from "../config/env.js";
import { migrateAuthIndexes } from "../modules/auth/auth.store.js";
async function main() {
  try {
    await mongoose.connect(ENV.MONGODB_URI, { autoIndex: false });
    await migrateAuthIndexes();
    console.log("Auth indexes ready.");
  } finally { await mongoose.disconnect(); }
}
void main().catch(() => { console.error("Auth index migration failed."); process.exitCode = 1; });
