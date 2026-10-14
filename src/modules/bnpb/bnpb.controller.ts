// src/modules/bnpb/bnpb.controller.ts
// -> controller penerima request data sinkronisasi karhutla bnpb
//      -> penanganan get /api/v1/external/bnpb-karhutla

import { Request, Response, NextFunction } from "express";
import { getBnpbKarhutlaService } from "./bnpb.service.js";
import { sendSuccess } from "../../utils/response.js";

export const getBnpbKarhutlaHandler = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const data = await getBnpbKarhutlaService();
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
};
