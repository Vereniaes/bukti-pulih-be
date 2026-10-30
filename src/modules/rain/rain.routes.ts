// Todo:
// -> Serve viewport rain estimates with a bounded public request rate.

// --- Rain endpoint ---
import { Router } from "express";
import { parseBounds, HotspotError } from "../hotspots/hotspot.service.js";
import { sendError, sendSuccess } from "../../utils/response.js";
import { createRainService, RainError } from "./rain.service.js";

/** Purpose: Expose model rain without allowing arbitrary upstream queries.
 * Input: Optional reader for source tests. Output: Public Express router.
 */
export function createRainRoutes(read = createRainService()) {
  const router = Router(), clients = new Map<string, { count: number; until: number }>();
  router.get("/rain", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const bounds = parseBounds(req.query.bbox), now = Date.now(), client = req.ip ?? "unknown";
      for (const [key, value] of clients) if (value.until <= now) clients.delete(key);
      const limit = clients.get(client) ?? { count: 0, until: now + 60_000 };
      if (limit.count >= 60 || !clients.has(client) && clients.size >= 1024) throw new RainError("RATE_LIMITED", 429);
      limit.count++; clients.set(client, limit);
      sendSuccess(res, await read(bounds));
    } catch (error) {
      const known = error instanceof RainError || error instanceof HotspotError;
      const status = known ? error.status : 502, code = known ? error.code : "RAIN_UNAVAILABLE";
      if (status === 429) res.set("Retry-After", "60");
      sendError(res, status, code, status === 400 ? "Area peta tidak valid." : status === 429 ? "Terlalu banyak permintaan. Coba lagi sebentar." : "Data hujan belum tersedia.");
    }
  });
  return router;
}
export const rainRoutes = createRainRoutes();
// --- end of Rain endpoint ---
