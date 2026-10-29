// Todo:
// -> Expose the public restoration-metrics endpoint.

// --- Metrics route ---
import { Router } from "express";
import { getImpactLedgerHandler } from "./metrics.controller.js";

const router = Router();

router.get("/impact-ledger", getImpactLedgerHandler);

export const metricsRoutes = router;
// --- end of Metrics route ---
