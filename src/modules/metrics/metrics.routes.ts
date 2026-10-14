// src/modules/metrics/metrics.routes.ts
// -> perutean endpoint metrik nasional
//      -> get /api/v1/metrics/impact-ledger

import { Router } from "express";
import { getImpactLedgerHandler } from "./metrics.controller.js";

const router = Router();

router.get("/impact-ledger", getImpactLedgerHandler);

export const metricsRoutes = router;
