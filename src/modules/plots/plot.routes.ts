// src/modules/plots/plot.routes.ts
// -> perutean endpoint petak restorasi (plots)
//      -> get /api/v1/plots
//      -> get /api/v1/plots/:id/summary

import { Router } from "express";
import { getPlotsHandler, getPlotSummaryHandler } from "./plot.controller.js";

const router = Router();

router.get("/", getPlotsHandler);
router.get("/:id", getPlotSummaryHandler);
router.get("/:id/summary", getPlotSummaryHandler);

export const plotRoutes = router;
