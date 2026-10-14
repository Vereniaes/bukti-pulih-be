// src/utils/response.ts
// -> pembungkus standar respons api json (envelope pattern)
//      -> format respons sukses status 200/201
//      -> format respons gagal status 400/401/403/404/422/500

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
