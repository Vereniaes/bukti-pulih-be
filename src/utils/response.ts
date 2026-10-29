// Todo:
// -> Build success and error response envelopes.

// --- API responses ---
import { Response } from "express";

export const sendSuccess = <T>(
  res: Response,
  data: T,
  statusCode: number = 200,
  extraMeta: Record<string, unknown> = {}
): void => {
  res.status(statusCode).json({
    status: "success",
    data,
    meta: {
      timestamp: new Date().toISOString(),
      version: "v1.0",
      ...extraMeta,
    },
  });
};

export const sendError = (
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details: unknown = null
): void => {
  res.status(statusCode).json({
    status: "error",
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
    meta: {
      timestamp: new Date().toISOString(),
    },
  });
};
// --- end of API responses ---
