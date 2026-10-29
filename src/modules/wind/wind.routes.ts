// Public model wind, cached once for all map visitors.
import { Router } from "express";
import { sendError, sendSuccess } from "../../utils/response.js";
import { satelliteService } from "../satellite/satellite.service.js";
export const windRoutes = Router();
windRoutes.get("/wind", async (_req, res) => {
  try { sendSuccess(res, await satelliteService.wind()); }
  catch { sendError(res, 502, "WIND_UNAVAILABLE", "Data angin belum tersedia."); }
});
