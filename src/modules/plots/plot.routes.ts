// Todo:
// -> Expose public plot lists and summaries.

// --- Plot routes ---
import { Router } from "express";
import { getPlotsHandler, getPlotSummaryHandler } from "./plot.controller.js";

const router = Router();

router.get("/", getPlotsHandler);
router.get("/:id", getPlotSummaryHandler);
router.get("/:id/summary", getPlotSummaryHandler);

export const plotRoutes = router;
// --- end of Plot routes ---
