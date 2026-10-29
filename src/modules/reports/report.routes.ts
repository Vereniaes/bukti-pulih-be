// Todo:
// -> Require an active session for plot reports and offline batches.

// --- Report routes ---
import { Router } from "express";
import { createReportHandler, batchOfflineSyncHandler } from "./report.controller.js";
import { requireAuth, requireActiveUser } from "../../middlewares/auth.js";

import { browserMutation } from "../auth/auth.http.js";

const router = Router();

router.post("/", browserMutation, requireAuth, requireActiveUser, createReportHandler);
router.post("/offline-batch", browserMutation, requireAuth, requireActiveUser, batchOfflineSyncHandler);

export const reportRoutes = router;
// --- end of Report routes ---
