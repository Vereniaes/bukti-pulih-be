// Todo:
// -> Convert validation and server errors into API responses.

// --- Request errors ---
import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { sendError } from "../utils/response.js";

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  if (err instanceof ZodError) {
    const formattedIssues = err.issues.map((i) => ({
      field: i.path.join("."),
      issue: i.message,
    }));
    sendError(res, 422, "VALIDATION_FAILED", "Data masukan tidak valid.", formattedIssues);
    return;
  }

  const errorObj = err as Error;
  console.error("[ServerError]", errorObj?.stack || errorObj);

  sendError(
    res,
    500,
    "INTERNAL_SERVER_ERROR",
    "Terjadi kendala pada server. Silakan coba kembali nanti."
  );
};
// --- end of Request errors ---
