// Protect scheduled sync with Google OIDC; expose only source status publicly.
import { Router } from "express";
import { ENV } from "../../config/env.js";
import { sendError, sendSuccess } from "../../utils/response.js";
import { createSchedulerGuard } from "../hazards/hazard.auth.js";
import { satelliteService } from "./satellite.service.js";

export const satelliteRoutes = Router();
satelliteRoutes.get("/external/satellite/status", async (_req, res) => {
  try { sendSuccess(res, { ...await satelliteService.status(), upstream_configured: !!ENV.FIRMS_MAP_KEY && !!ENV.ISPU_AUTHORIZATION }); }
  catch { sendError(res, 503, "SATELLITE_STORE_UNAVAILABLE", "Data belum tersedia."); }
});
satelliteRoutes.post("/internal/satellite/sync", createSchedulerGuard({
  audience: ENV.SATELLITE_SCHEDULER_AUDIENCE,
  serviceAccount: ENV.SATELLITE_SCHEDULER_SERVICE_ACCOUNT,
}), async (_req, res) => {
  try {
    const result = await satelliteService.sync();
    console.info(JSON.stringify({ event: "satellite_sync", ...result }));
    res.status(result.failed ? 502 : 200).json({ status: result.failed ? "partial" : "success", data: result });
  } catch { sendError(res, 503, "SATELLITE_STORE_UNAVAILABLE", "Sinkronisasi belum tersedia."); }
});

