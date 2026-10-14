// src/modules/metrics/metrics.controller.ts
// -> controller penerima request metrik impact ledger
//      -> penanganan get /api/v1/metrics/impact-ledger

import { Request, Response, NextFunction } from "express";
import { getImpactLedgerService } from "./metrics.service.js";
import { sendSuccess } from "../../utils/response.js";

export const getImpactLedgerHandler = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const data = await getImpactLedgerService();
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
};
