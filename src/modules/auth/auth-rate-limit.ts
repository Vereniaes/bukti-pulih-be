// Reserve one attempt in the shared rolling window.
import { authStore, duplicateKey } from "./auth.store.js";
export async function takeAuthLimit(id: string, maximum: number, window: number, now: Date) {
  const cutoff = new Date(now.getTime() - window);
  const purgeAt = new Date(now.getTime() + window + 60_000);
  const recent = { $filter: { input: { $ifNull: ["$events", []] }, as: "at", cond: { $gt: ["$$at", cutoff] } } };
  try { await authStore.limits().updateOne({ _id: id }, { $setOnInsert: { events: [], purge_at: purgeAt } }, { upsert: true }); }
  catch (error) { if (!duplicateKey(error)) throw error; }
  const claimed = await authStore.limits().findOneAndUpdate({ _id: id, $expr: { $lt: [{ $size: recent }, maximum] } }, [
    { $set: { events: { $concatArrays: [recent, [now]] }, purge_at: purgeAt } },
  ], { returnDocument: "after" });
  if (claimed) return;
  const events = (await authStore.limits().findOne({ _id: id }))?.events ?? [];
  const next = events.filter(at => at > cutoff).sort((a, b) => a.getTime() - b.getTime())[0];
  return Math.max(1, Math.ceil(((next?.getTime() ?? now.getTime()) + window - now.getTime()) / 1000));
}
