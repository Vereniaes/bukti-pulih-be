// src/modules/reports/report.routes.ts
// -> perutean endpoint pelaporan lapangan kader
//      -> post /api/v1/reports
//      -> post /api/v1/reports/offline-batch

import { Router } from "express";
import { createReportHandler, batchOfflineSyncHandler } from "./report.controller.js";
import { requireAuth, requireActiveUser } from "../../middlewares/auth.js";

import { browserMutation } from "../auth/auth.http.js";

const router = Router();

router.post("/", browserMutation, requireAuth, requireActiveUser, createReportHandler);
router.post("/offline-batch", browserMutation, requireAuth, requireActiveUser, batchOfflineSyncHandler);

export const reportRoutes = router;
