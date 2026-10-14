// src/modules/timeline/timeline.controller.ts
// -> controller penerima http request linimasa relawan
//      -> penanganan get /api/v1/timeline
//      -> penanganan post /api/v1/timeline/:id/verify
//      -> penanganan post /api/v1/timeline/:id/comments

import { Request, Response, NextFunction } from "express";
import {
  getTimelineService,
  verifyTimelineItemService,
  addCommentService,
} from "./timeline.service.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { z } from "zod";

export const getTimelineHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { plot_id, page, limit } = req.query;
    const data = await getTimelineService({
      plot_id: plot_id as string,
      page: page ? parseInt(page as string, 10) : 1,
      limit: limit ? parseInt(limit as string, 10) : 10,
    });
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
};

const verifyBodySchema = z.object({
  type: z.enum(["subur", "dispute"]).default("subur"),
  client_fingerprint: z.string().optional(),
});

export const verifyTimelineItemHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = req.params.id as string;
    const body = verifyBodySchema.parse(req.body);
    const visitorId =
      body.client_fingerprint || req.ip || req.headers["x-forwarded-for"]?.toString() || "anon";

    const result = await verifyTimelineItemService(id, body.type, visitorId);
    if (!result) {
      sendError(res, 404, "NOT_FOUND", "Catatan linimasa tidak ditemukan.");
      return;
    }
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
};

const commentBodySchema = z.object({
  author_name: z.string().min(2, "Nama minimal 2 karakter"),
  author_badge: z.enum(["donatur", "warga_lokal", "pemerhati"]).optional(),
  content: z.string().min(3, "Catatan minimal 3 karakter").max(500, "Catatan maksimal 500 karakter"),
});

export const addCommentHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const id = req.params.id as string;
    const body = commentBodySchema.parse(req.body);
    const comment = await addCommentService(id, body);
    if (!comment) {
      sendError(res, 404, "NOT_FOUND", "Catatan linimasa tidak ditemukan.");
      return;
    }
    sendSuccess(res, comment, 201);
  } catch (error) {
    next(error);
  }
};
