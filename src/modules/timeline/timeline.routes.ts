// src/modules/timeline/timeline.routes.ts
// -> perutean endpoint linimasa relawan (notes collage)
//      -> get /api/v1/timeline
//      -> post /api/v1/timeline/:id/verify
//      -> post /api/v1/timeline/:id/comments

import { Router } from "express";
import {
  getTimelineHandler,
  verifyTimelineItemHandler,
  addCommentHandler,
} from "./timeline.controller.js";

const router = Router();

router.get("/", getTimelineHandler);
router.post("/:id/verify", verifyTimelineItemHandler);
router.post("/:id/comments", addCommentHandler);

export const timelineRoutes = router;
