// Serve FIRMS observations through the backend so the key stays private.
import { Router } from "express";
import { ENV } from "../../config/env.js";
import { sendError, sendSuccess } from "../../utils/response.js";
import { createHotspotService, HotspotError, parseBounds } from "./hotspot.service.js";

export const hotspotRoutes = Router();
const getHotspots = createHotspotService(() => ENV.FIRMS_MAP_KEY);

hotspotRoutes.get("/hotspots", async (req, res) => {
  try {
    sendSuccess(res, await getHotspots(parseBounds(req.query.bbox)));
  } catch (error) {
    const known = error instanceof HotspotError;
    sendError(res, known ? error.status : 502, known ? error.code : "FIRMS_UNAVAILABLE",
      known && error.code === "INVALID_BOUNDS" ? "Area peta tidak valid." : "Data titik panas belum tersedia.");
  }
});
