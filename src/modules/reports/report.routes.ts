// src/modules/reports/report.routes.ts
// -> perutean endpoint pelaporan lapangan kader
//      -> post /api/v1/reports
//      -> post /api/v1/reports/offline-batch

import { Router } from "express";
import { createReportHandler, batchOfflineSyncHandler } from "./report.controller.js";
import { optionalAuth } from "../../middlewares/auth.js";

const router = Router();

router.post("/", optionalAuth, createReportHandler);
router.post("/offline-batch", optionalAuth, batchOfflineSyncHandler);

export const reportRoutes = router;
