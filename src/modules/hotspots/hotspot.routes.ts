// Serve FIRMS observations through the backend so the key stays private.
import { ENV } from "../../config/env.js";
import { createHotspotHistoryService, parseHotspotRange } from "./hotspot-history.service.js";
import compression from "compression";
import { Router } from "express";
import { satelliteService, SATELLITE_BOUNDS } from "../satellite/satellite.service.js";
import { sendError, sendSuccess } from "../../utils/response.js";
import { HotspotError, parseBounds, parseHours } from "./hotspot.service.js";

export const hotspotRoutes = Router();
const history = createHotspotHistoryService(() => ENV.FIRMS_MAP_KEY);

hotspotRoutes.get("/hotspots/availability", async (_req,res) => {
  try { sendSuccess(res,await history.availability()); }
  catch { sendError(res,503,"FIRMS_UNAVAILABLE","Tanggal data NASA belum tersedia."); }
});

hotspotRoutes.get("/hotspots", compression({ level: 4 }), async (req, res) => {
  try {
    const bounds=parseBounds(req.query.bbox);
    if(bounds[0]<SATELLITE_BOUNDS[0]||bounds[1]<SATELLITE_BOUNDS[1]||bounds[2]>SATELLITE_BOUNDS[2]||bounds[3]>SATELLITE_BOUNDS[3])throw new HotspotError("INVALID_BOUNDS",400);
    if(req.query.start!==undefined||req.query.end!==undefined) {
      if(req.query.hours!==undefined)throw new HotspotError("INVALID_TIME_RANGE",400);
      const range=parseHotspotRange(req.query.start,req.query.end);
      sendSuccess(res,await history.read(bounds,range));
    } else sendSuccess(res, await satelliteService.hotspots(bounds, parseHours(req.query.hours)));
  } catch (error) {
    const known = error instanceof HotspotError;
    sendError(res, known ? error.status : 502, known ? error.code : "FIRMS_UNAVAILABLE",
      known && error.code === "INVALID_TIME_RANGE" ? "Pilih rentang tanggal dan jam yang valid, maksimal 5 hari." :
      known && error.code === "HOTSPOT_DATE_UNAVAILABLE" ? "Data NASA belum tersedia untuk tanggal tersebut." :
      known && (error.code === "INVALID_BOUNDS" || error.code === "INVALID_HOURS") ? "Area peta tidak valid." : "Data titik panas belum tersedia.");
  }
});
