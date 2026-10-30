// Todo:
// -> Serve the shared current regional grid with a bounded request rate.

// --- Weather endpoint ---
import compression from "compression";
import { createHash } from "node:crypto";
import { Router } from "express";
import { sendError, sendSuccess } from "../../utils/response.js";
import { createWeatherService } from "./weather.service.js";
import { mongoSnapshotStore } from "../satellite/satellite.store.js";

export function createWeatherRoutes(read = createWeatherService(undefined, undefined, undefined, mongoSnapshotStore)) {
  const router = Router(), clients = new Map<string, { count: number; until: number }>();
  router.get("/weather", compression({ level: 4 }), async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const now = Date.now(), client = req.ip ?? "unknown";
    for (const [key, value] of clients) if (value.until <= now) clients.delete(key);
    const limit = clients.get(client) ?? { count: 0, until: now + 60_000 };
    if (limit.count >= 30 || !clients.has(client) && clients.size >= 1024) {
      res.set("Retry-After", "60");
      sendError(res, 429, "RATE_LIMITED", "Coba lagi sebentar.");
      return;
    }
    limit.count++; clients.set(client, limit);
    try {
      const data = await read();
      const tag = `W/"weather-${createHash("sha256").update([data.run_at, data.valid_at, data.fetched_at, data.status].join("|")).digest("hex").slice(0, 24)}"`;
      res.set("ETag", tag);
      if (req.get("If-None-Match") === tag) res.status(304).end();
      else sendSuccess(res, data);
    }
    catch { sendError(res, 503, "WEATHER_UNAVAILABLE", "Data cuaca belum tersedia."); }
  });
  return router;
}
export const weatherRoutes = createWeatherRoutes();
// --- end of Weather endpoint ---
