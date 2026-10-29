// Serve map snapshots and accept authenticated scheduled updates.
import { Router } from "express";
import { sendSuccess } from "../../utils/response.js";
import { createSchedulerGuard } from "./hazard.auth.js";
import { getHazardLayers, syncHazardLayers } from "./hazard.service.js";
export const hazardRoutes = Router();
hazardRoutes.get("/external/hazards", async (_req, res, next) => {
  try { res.setHeader("Cache-Control", "no-store"); sendSuccess(res, await getHazardLayers()); } catch (error) { next(error); }
});
hazardRoutes.post("/internal/hazards/sync", createSchedulerGuard(), async (_req, res, next) => {
  try {
    const result = await syncHazardLayers();
    res.status(result.failed ? 502 : 200).json({ status: result.failed ? "partial" : "success", data: result });
  } catch (error) { next(error); }
});
