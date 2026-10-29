// Route public ISPU station data and per-station pollutant indices.
import { Router } from "express";
import { sendError, sendSuccess } from "../../utils/response.js";
import { satelliteService } from "../satellite/satellite.service.js";

export const ispuRoutes = Router();

ispuRoutes.get("/ispu", async (_req, res) => {
  try { sendSuccess(res, await satelliteService.air()); }
  catch { sendError(res, 502, "ISPU_UNAVAILABLE", "Data ISPU belum tersedia."); }
});
ispuRoutes.get("/ispu/:stationId", async (req, res) => {
  try { sendSuccess(res, await satelliteService.detail(req.params.stationId)); }
  catch { sendError(res, 502, "ISPU_UNAVAILABLE", "Data ISPU belum tersedia."); }
});
