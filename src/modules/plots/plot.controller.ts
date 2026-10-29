// Todo:
// -> Read plot filters and return plot lists or summaries.

// --- Plot requests ---
import { Request, Response, NextFunction } from "express";
import { getPlotsGeoJsonService, getPlotSummaryService } from "./plot.service.js";
import { sendSuccess, sendError } from "../../utils/response.js";

export const getPlotsHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { region, status, bbox } = req.query;
    const data = await getPlotsGeoJsonService({
      region: region as string,
      status: status as string,
      bbox: bbox as string,
    });
    sendSuccess(res, data, 200, { total_count: data.features.length });
  } catch (error) {
    next(error);
  }
};

export const getPlotSummaryHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = req.params.id as string;
    const data = await getPlotSummaryService(id);
    if (!data) {
      sendError(res, 404, "NOT_FOUND", "Petak restorasi tidak ditemukan.");
      return;
    }
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
};
// --- end of Plot requests ---
