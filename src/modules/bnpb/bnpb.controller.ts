// Todo:
// -> Return cached provincial BNPB data.

// --- BNPB request ---
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
// --- end of BNPB request ---
